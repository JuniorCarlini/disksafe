#!/usr/bin/env node
'use strict';

/*
 * DiskSafe — verificador de disco/pendrive "fantasma"
 *
 * Detecta pendrives e HDs externos com controladora falsificada (relatam
 * capacidade maior do que a real). Escreve dados únicos e verificáveis
 * preenchendo o espaço livre do disco, força a queda do cache do sistema
 * (desmontando/remontando) e lê tudo de volta comparando com o esperado.
 * Blocos que não batem = memória "fantasma" (não existe fisicamente).
 *
 * Uso:
 *   node disksafe.js            (fluxo real, interativo)
 *   node disksafe.js --demo     (simulação segura em pasta temporária)
 *   node disksafe.js --demo --size=128 --fake=40   (simula disco fantasma)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const readline = require('readline');
const { execFileSync, spawnSync } = require('child_process');

const CHUNK_SIZE = 4 * 1024 * 1024;       // unidade de leitura/escrita: 4 MiB
const FILE_CAP = 2 * 1024 * 1024 * 1024;  // tamanho máx. por arquivo: 2 GiB (seguro p/ FAT32)
const RESERVE_BYTES = 8 * 1024 * 1024;    // margem de segurança contra ENOSPC
const TEST_DIR_NAME = '.disksafe_test';

// ---------------- visual ----------------

const ANSI = {
  reset: '\x1b[0m', bold: '\x1b[1m',
  gray: '\x1b[90m', green: '\x1b[92m', cyan: '\x1b[36m',
  yellow: '\x1b[33m', red: '\x1b[91m',
};
function paint(color, s) { return ANSI[color] + s + ANSI.reset; }

function formatBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let u = 0, v = Math.max(0, n);
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return `${v.toFixed(u === 0 ? 0 : 2)} ${units[u]}`;
}

function formatDuration(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (h) return `${h}h${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

// Quantas linhas de terminal um texto realmente ocupa, contando quebra por
// largura -- essencial para o redesenho por cursor nao "empilhar" a tela
// quando uma linha e mais larga que o terminal.
function terminalRowCount(lines) {
  const width = process.stdout.columns || 80;
  let total = 0;
  for (const l of lines) {
    const len = stripAnsi(l).length;
    total += len === 0 ? 1 : Math.max(1, Math.ceil(len / width));
  }
  return total;
}

class BlockGrid {
  constructor(numBlocks, cols) {
    this.numBlocks = numBlocks;
    this.cols = cols;
    this.rows = Math.ceil(numBlocks / cols);
    this.state = new Array(numBlocks).fill('pending');
    this.printed = false;
    this.lastLines = 0;
  }
  setState(i, state) {
    if (i >= 0 && i < this.numBlocks) this.state[i] = state;
  }
  glyphFor(s) {
    switch (s) {
      case 'pending': return ANSI.gray + '██' + ANSI.reset;
      case 'active': return ANSI.yellow + '██' + ANSI.reset;
      case 'written': return ANSI.cyan + '██' + ANSI.reset;
      case 'ok': return ANSI.green + '██' + ANSI.reset;
      case 'ghost': return ANSI.red + '██' + ANSI.reset;
      default: return '  ';
    }
  }
  render(statusLines) {
    const lines = [];
    for (let r = 0; r < this.rows; r++) {
      let line = '';
      for (let c = 0; c < this.cols; c++) {
        const i = r * this.cols + c;
        line += i < this.numBlocks ? this.glyphFor(this.state[i]) : '';
      }
      lines.push(line);
    }
    lines.push('');
    lines.push(...statusLines);
    if (this.printed) process.stdout.write(`\x1b[${this.lastLines}A`);
    for (const l of lines) process.stdout.write('\r' + l + '\x1b[K\r\n');
    this.printed = true;
    this.lastLines = terminalRowCount(lines);
  }
}

function legendLine() {
  return `${paint('gray', '██')} pendente  ${paint('cyan', '██')} escrito  ` +
    `${paint('yellow', '██')} processando  ${paint('green', '██')} ok  ${paint('red', '██')} FANTASMA`;
}

function renderStatus(grid, phase, doneBytes, totalBytes, t0) {
  const elapsed = (Date.now() - t0) / 1000;
  const speed = elapsed > 0 ? doneBytes / elapsed : 0;
  const pct = totalBytes ? (doneBytes / totalBytes * 100) : 100;
  const remain = Math.max(0, totalBytes - doneBytes);
  const eta = speed > 0 ? remain / speed : 0;
  grid.render([
    `${paint('bold', phase)}  ${pct.toFixed(1)}%  ${formatBytes(doneBytes)} / ${formatBytes(totalBytes)}`,
    `Velocidade: ${formatBytes(speed)}/s   ETA: ${formatDuration(eta)}`,
    legendLine(),
  ]);
}

function computeCols() {
  const w = process.stdout.columns || 80;
  return Math.max(10, Math.min(70, Math.floor((w - 2) / 2)));
}

function computeNumBlocks(targetBytes, cols) {
  const desiredRows = 20;
  let n = cols * desiredRows;
  const maxByChunk = Math.max(1, Math.floor(targetBytes / CHUNK_SIZE));
  n = Math.min(n, maxByChunk);
  n = Math.max(n, Math.min(cols, maxByChunk));
  return Math.max(1, n);
}

function updateGridWrite(grid, writtenBytes, blockBytes) {
  const doneBlocks = Math.floor(writtenBytes / blockBytes);
  for (let i = 0; i < doneBlocks && i < grid.numBlocks; i++) grid.setState(i, 'written');
  if (doneBlocks < grid.numBlocks) grid.setState(doneBlocks, 'active');
}

function printSummary({ targetBytes, verifiedBytes, ghostBytes, firstGhost, writeBytes, writeSeconds, readSeconds }) {
  console.log('\n' + paint('bold', '=== Resultado ==='));
  console.log(`Testado: ${formatBytes(verifiedBytes)} de ${formatBytes(targetBytes)} declarados`);
  if (writeSeconds > 0) {
    console.log(`Velocidade de gravacao : ${formatBytes(writeBytes / writeSeconds)}/s  (${formatDuration(writeSeconds)})`);
  }
  if (readSeconds > 0) {
    console.log(`Velocidade de leitura  : ${formatBytes(verifiedBytes / readSeconds)}/s  (${formatDuration(readSeconds)})`);
  }
  if (ghostBytes === 0) {
    console.log(paint('green', 'Nenhuma memoria fantasma detectada -- a capacidade parece real.'));
  } else {
    const pct = (ghostBytes / targetBytes * 100).toFixed(1);
    console.log(paint('red', `ALERTA: ${formatBytes(ghostBytes)} (${pct}%) de dados fantasma detectados!`));
    console.log(paint('red', `Primeiro erro em: ${formatBytes(firstGhost)} -- a capacidade REAL provavelmente esta perto disso.`));
    console.log('Esse disco/pendrive provavelmente tem controladora falsificada informando capacidade maior que a real.');
  }
}

function printDiskCard(vol, free) {
  const used = Math.max(0, free.total - free.free);
  const usedPct = free.total ? (used / free.total * 100).toFixed(1) : '0.0';
  console.log('\n' + paint('bold', '--- Disco selecionado ---'));
  console.log(`Nome               : ${vol.name}`);
  console.log(`Identificador      : ${vol.id}  (disco fisico: ${vol.wholeDiskId} -- ${vol.mediaName})`);
  console.log(`Ponto de montagem  : ${vol.mountPoint}`);
  console.log(`Sistema de arquivos: ${vol.fsType}`);
  console.log(`Barramento         : ${vol.busProtocol}` +
    `${vol.removable ? ', removivel' : ''}${vol.ejectable ? ', ejetavel' : ''}`);
  console.log(`Capacidade total   : ${formatBytes(free.total)}`);
  console.log(`Usado              : ${formatBytes(used)} (${usedPct}%)`);
  console.log(`Livre              : ${formatBytes(free.free)}`);
  if (vol.wholeSize && Math.abs(vol.wholeSize - free.total) > 1024 * 1024) {
    console.log(`Disco fisico total : ${formatBytes(vol.wholeSize)}`);
  }
  if (vol.blockSize) console.log(`Tamanho de bloco   : ${vol.blockSize} bytes`);
  if (vol.smartStatus) console.log(`Status SMART       : ${vol.smartStatus}`);
  if (vol.volumeUUID) console.log(`UUID do volume     : ${vol.volumeUUID}`);
}

// ---------------- dados deterministicos verificaveis ----------------

function makeGenerator(seedHex) {
  const key = crypto.createHash('sha256').update(seedHex).digest();
  return function genChunk(chunkIndex, length) {
    const iv = Buffer.alloc(16);
    iv.writeUInt32BE(chunkIndex >>> 0, 12);
    const cipher = crypto.createCipheriv('aes-256-ctr', key, iv);
    return cipher.update(Buffer.alloc(length));
  };
}

// ---------------- diskutil ----------------

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8' });
}

function plistToJson(plistXml) {
  const res = spawnSync('plutil', ['-convert', 'json', '-o', '-', '-'], { input: plistXml, encoding: 'utf8' });
  if (res.status !== 0) throw new Error('Falha ao interpretar saida do diskutil: ' + res.stderr);
  return JSON.parse(res.stdout);
}

function collectDeviceIdentifiers(node, out) {
  if (Array.isArray(node)) { node.forEach(n => collectDeviceIdentifiers(n, out)); return; }
  if (node && typeof node === 'object') {
    if (typeof node.DeviceIdentifier === 'string') out.add(node.DeviceIdentifier);
    for (const k of Object.keys(node)) collectDeviceIdentifiers(node[k], out);
  }
}

function getDiskInfo(id) {
  return plistToJson(sh('diskutil', ['info', '-plist', id]));
}

// Resolve o(s) disco(s) fisico(s) onde o macOS esta instalado, para nunca
// oferece-lo como opcao de teste (mesmo que ele apareca como "physical").
function resolveBootWholeDiskIds() {
  const ids = new Set();
  let info;
  try { info = getDiskInfo('/'); } catch { return ids; }
  if (Array.isArray(info.APFSPhysicalStores)) {
    for (const store of info.APFSPhysicalStores) {
      const storeId = store.APFSPhysicalStore || store.DeviceIdentifier;
      if (!storeId) continue;
      try {
        const storeInfo = getDiskInfo(storeId);
        if (storeInfo.ParentWholeDisk) ids.add(storeInfo.ParentWholeDisk);
      } catch {}
    }
  }
  if (ids.size === 0 && info.ParentWholeDisk) ids.add(info.ParentWholeDisk);
  return ids;
}

// Um disco e considerado testavel quando NAO e o disco de boot e e removivel/
// ejetavel/externo -- isso cobre pendrives e HDs USB, mas tambem cartoes SD
// em leitores internos (o macOS marca o barramento deles como "internal"
// mesmo sendo midia removivel).
function getExternalVolumes() {
  const bootIds = resolveBootWholeDiskIds();
  const physList = plistToJson(sh('diskutil', ['list', '-plist', 'physical']));
  const wholeIds = (physList.WholeDisks || []).filter(id => !bootIds.has(id));

  const volumes = [];
  for (const wholeId of wholeIds) {
    let wholeInfo;
    try { wholeInfo = getDiskInfo(wholeId); } catch { continue; }
    const removable = wholeInfo.RemovableMedia === true || wholeInfo.Ejectable === true || wholeInfo.Internal === false;
    if (!removable) continue;

    const ids = new Set();
    try {
      collectDeviceIdentifiers(plistToJson(sh('diskutil', ['list', '-plist', wholeId])), ids);
    } catch { continue; }
    for (const id of ids) {
      let info;
      try { info = getDiskInfo(id); } catch { continue; }
      if (!info.MountPoint) continue;
      if (info.WritableVolume === false) continue;
      if (info.MountPoint === '/' || info.MountPoint.startsWith('/System')) continue;
      if (info.ParentWholeDisk && bootIds.has(info.ParentWholeDisk)) continue;
      volumes.push({
        wholeDiskId: wholeId,
        id,
        name: info.VolumeName || wholeInfo.MediaName || id,
        mountPoint: info.MountPoint,
        size: info.Size || 0,
        fsType: info.FilesystemUserVisibleName || info.FilesystemName || info.FilesystemType || '?',
        busProtocol: info.BusProtocol || wholeInfo.BusProtocol || '?',
        mediaName: wholeInfo.MediaName || info.MediaName || '?',
        blockSize: info.DeviceBlockSize || wholeInfo.DeviceBlockSize || null,
        smartStatus: info.SMARTStatus || wholeInfo.SMARTStatus || null,
        volumeUUID: info.VolumeUUID || null,
        removable: wholeInfo.RemovableMedia === true,
        ejectable: wholeInfo.Ejectable === true,
        wholeSize: wholeInfo.Size || 0,
      });
    }
  }
  return volumes;
}

function getFreeSpace(mountPoint) {
  const st = fs.statfsSync(mountPoint);
  return { total: st.blocks * st.bsize, free: st.bavail * st.bsize };
}

// ---------------- readline / menu interativo ----------------

function ask(rl, question) {
  return new Promise(resolve => rl.question(question, a => resolve(a)));
}

function isInteractiveTTY() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

// Menu de setas: retorna o `value` da opcao escolhida, ou null se o usuario
// cancelou (Esc). Ctrl+C encerra o programa na hora, em qualquer menu.
// options: [{ label, hint, value }]
function rawMenuSelect(title, options, defaultIndex = 0) {
  return new Promise(resolve => {
    let idx = defaultIndex;
    let printed = false;
    let lastLines = 0;

    function render() {
      const lines = [];
      if (title) lines.push(paint('bold', title));
      options.forEach((opt, i) => {
        const on = i === idx;
        const pointer = on ? paint('green', '>') : ' ';
        const label = on ? paint('bold', paint('green', opt.label)) : opt.label;
        lines.push(`  ${pointer} ${label}`);
        if (opt.hint) lines.push(`      ${paint('gray', opt.hint)}`);
      });
      lines.push(paint('gray', 'setas ^v para mover, Enter para escolher, Esc para cancelar'));
      if (printed) process.stdout.write(`\x1b[${lastLines}A`);
      for (const l of lines) process.stdout.write('\r' + l + '\x1b[K\r\n');
      printed = true;
      lastLines = terminalRowCount(lines);
    }

    function cleanup() {
      process.stdin.removeListener('keypress', onKeypress);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
    }

    function onKeypress(str, key) {
      if (!key) return;
      if (key.ctrl && key.name === 'c') {
        cleanup();
        process.stdout.write('\n');
        console.log('Cancelado.');
        process.exit(130);
      }
      if (key.name === 'up' || key.name === 'k') { idx = (idx - 1 + options.length) % options.length; render(); }
      else if (key.name === 'down' || key.name === 'j') { idx = (idx + 1) % options.length; render(); }
      else if (key.name === 'return') { cleanup(); resolve(options[idx].value); }
      else if (key.name === 'escape') { cleanup(); resolve(null); }
    }

    render();
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('keypress', onKeypress);
  });
}

// Menu de setas quando o terminal e interativo; volta para prompt de texto
// numerado (com Enter = opcao padrao) quando a entrada nao e um TTY.
async function menuSelect(rl, title, options, defaultIndex = 0) {
  if (isInteractiveTTY()) return rawMenuSelect(title, options, defaultIndex);
  console.log('\n' + title);
  options.forEach((o, i) => console.log(`  ${i + 1}) ${o.label}${o.hint ? '  ' + o.hint : ''}`));
  const ans = await ask(rl, `Escolha (1-${options.length}) [Enter = ${defaultIndex + 1}]: `);
  const idx = ans.trim() === '' ? defaultIndex : parseInt(ans.trim(), 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= options.length) return null;
  return options[idx].value;
}

function confirmMenu(rl, title, defaultToYes = false) {
  return menuSelect(rl, title, [
    { label: 'Sim', value: true },
    { label: 'Nao', value: false },
  ], defaultToYes ? 0 : 1);
}

// ---------------- fluxo real ----------------

async function runReal() {
  if (process.platform !== 'darwin') {
    console.error('Este verificador usa "diskutil" e por enquanto so funciona no macOS.');
    process.exit(1);
  }

  console.log(paint('bold', '\nDiskSafe -- verificador de disco/pendrive fantasma\n'));

  let volumes;
  try { volumes = getExternalVolumes(); }
  catch (e) { console.error('Erro ao listar discos:', e.message); process.exit(1); }

  if (volumes.length === 0) {
    console.log('Nenhum disco externo ou pendrive removivel encontrado.');
    console.log('Conecte o dispositivo e rode "node disksafe.js" novamente.');
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const diskOptions = volumes.map((v, i) => {
    const free = getFreeSpace(v.mountPoint);
    v._free = free;
    return {
      label: `${v.name}  --  ${formatBytes(free.total)} (${formatBytes(free.free)} livres)  [${v.fsType}]`,
      hint: `${v.busProtocol}  ${v.mountPoint}`,
      value: i,
    };
  });
  diskOptions.push({ label: 'Cancelar / sair', value: -1 });

  const idx = await menuSelect(rl, 'Escolha o disco para testar:', diskOptions, 0);
  if (idx === null || idx === -1) { console.log('Cancelado.'); rl.close(); return; }
  const vol = volumes[idx];

  if (vol.mountPoint === '/' || vol.mountPoint.startsWith('/System')) {
    console.error('Por seguranca, este disco nao pode ser testado.');
    rl.close(); return;
  }

  const free = vol._free;
  printDiskCard(vol, free);

  console.log(`\n${paint('yellow', 'Atencao:')} o teste vai ocupar TODO o espaco livre (${formatBytes(free.free)}) de "${vol.name}" com arquivos de teste.`);
  console.log('Seus arquivos atuais nao sao apagados -- so o espaco livre e usado temporariamente, e os arquivos de teste sao removidos no final.');
  console.log('Para garantir uma leitura real (sem cache), o disco sera desmontado e remontado entre a escrita e a verificacao.');
  console.log('Isso desmonta TODOS os volumes desse disco fisico, nao so o escolhido. O processo pode demorar bastante.');

  const confirmed = await confirmMenu(rl, `Iniciar o teste em "${vol.name}" agora?`, false);
  if (!confirmed) { console.log('Cancelado.'); rl.close(); return; }

  const targetBytes = free.free - RESERVE_BYTES;
  if (targetBytes <= CHUNK_SIZE) { console.log('Espaco livre insuficiente para testar.'); return; }

  const testDir = path.join(vol.mountPoint, TEST_DIR_NAME);
  const seed = crypto.randomBytes(16).toString('hex');
  const genChunk = makeGenerator(seed);
  const cols = computeCols();
  const numBlocks = computeNumBlocks(targetBytes, cols);
  const grid = new BlockGrid(numBlocks, cols);
  const blockBytes = Math.ceil(targetBytes / numBlocks);

  console.log(`\nBloco = ${formatBytes(blockBytes)}  |  grade ${grid.cols}x${grid.rows}\n`);

  // ---- escrita ----
  fs.mkdirSync(testDir, { recursive: true });
  let written = 0, fileIndex = 0, chunkIndex = 0, fd = null, fileWritten = 0;
  function openNextFile() {
    if (fd !== null) fs.closeSync(fd);
    const p = path.join(testDir, `chunk_${String(fileIndex).padStart(6, '0')}.bin`);
    fd = fs.openSync(p, 'w');
    fileWritten = 0; fileIndex++;
  }
  openNextFile();
  const t0 = Date.now();
  let lastRender = 0;
  let writeError = null;
  while (written < targetBytes) {
    let len = Math.min(CHUNK_SIZE, targetBytes - written);
    if (fileWritten + len > FILE_CAP) len = FILE_CAP - fileWritten;
    if (len <= 0) { openNextFile(); continue; }
    const buf = genChunk(chunkIndex, len);
    try {
      fs.writeSync(fd, buf, 0, len);
    } catch (e) { writeError = e; break; }
    written += len; fileWritten += len; chunkIndex++;
    if (fileWritten >= FILE_CAP) openNextFile();
    updateGridWrite(grid, written, blockBytes);
    if (Date.now() - lastRender > 100 || written >= targetBytes) {
      renderStatus(grid, 'Escrevendo dados de teste', written, targetBytes, t0);
      lastRender = Date.now();
    }
  }
  if (fd !== null) fs.closeSync(fd);
  const writeSeconds = (Date.now() - t0) / 1000;
  if (writeError && writeError.code !== 'ENOSPC') {
    console.log(paint('red', `\nErro de escrita: ${writeError.message}`));
  }

  console.log('\n' + paint('cyan', 'Escrita concluida.') + ' Sincronizando e recarregando o disco para evitar cache...\n');

  try { execFileSync('sync'); } catch {}

  let remounted = false;
  try {
    execFileSync('diskutil', ['unmountDisk', vol.wholeDiskId]);
    execFileSync('diskutil', ['mountDisk', vol.wholeDiskId]);
    remounted = true;
  } catch { remounted = false; }

  let verifyTestDir = testDir;
  if (!remounted || !fs.existsSync(verifyTestDir)) {
    console.log(paint('yellow', '\nNao foi possivel remontar automaticamente.'));
    console.log('Desconecte e reconecte o disco/pendrive fisicamente para garantir uma leitura real (sem cache),');
    console.log('depois pressione Enter aqui para continuar.');
    await ask(rl, '');
    try {
      const vols2 = getExternalVolumes();
      const found = vols2.find(v => v.name === vol.name && fs.existsSync(path.join(v.mountPoint, TEST_DIR_NAME)));
      if (found) verifyTestDir = path.join(found.mountPoint, TEST_DIR_NAME);
    } catch {}
  }

  if (!fs.existsSync(verifyTestDir)) {
    console.log(paint('red', 'Nao foi possivel localizar os arquivos de teste apos reconectar. Abortando verificacao.'));
    return;
  }

  // ---- verificacao ----
  const files = fs.readdirSync(verifyTestDir).filter(f => f.startsWith('chunk_')).sort();
  let read = 0, vChunkIndex = 0, ghostBytes = 0, firstGhost = null;
  const t1 = Date.now();
  lastRender = 0;
  for (const f of files) {
    const fp = path.join(verifyTestDir, f);
    let rfd;
    try { rfd = fs.openSync(fp, 'r'); } catch { continue; }
    const size = fs.fstatSync(rfd).size;
    let pos = 0;
    while (pos < size) {
      const len = Math.min(CHUNK_SIZE, size - pos);
      const expected = genChunk(vChunkIndex, len);
      const buf = Buffer.alloc(len);
      let bytesRead = 0;
      try { bytesRead = fs.readSync(rfd, buf, 0, len, pos); } catch { bytesRead = -1; }
      const ok = bytesRead === len && buf.equals(expected);
      const blockIdx = Math.min(grid.numBlocks - 1, Math.floor(read / blockBytes));
      if (!ok) {
        if (firstGhost === null) firstGhost = read;
        ghostBytes += len;
        grid.setState(blockIdx, 'ghost');
      } else if (grid.state[blockIdx] !== 'ghost') {
        grid.setState(blockIdx, 'ok');
      }
      read += len; pos += len; vChunkIndex++;
      if (Date.now() - lastRender > 100 || read >= targetBytes) {
        renderStatus(grid, 'Verificando (lendo de volta)', read, targetBytes, t1);
        lastRender = Date.now();
      }
    }
    fs.closeSync(rfd);
  }
  const readSeconds = (Date.now() - t1) / 1000;

  printSummary({ targetBytes, verifiedBytes: read, ghostBytes, firstGhost, writeBytes: written, writeSeconds, readSeconds });

  console.log();
  const del = await confirmMenu(rl, 'Apagar os arquivos de teste agora?', true);
  if (del) {
    fs.rmSync(verifyTestDir, { recursive: true, force: true });
    console.log('Arquivos de teste removidos.');
  }
  const eject = await confirmMenu(rl, 'Ejetar o disco com seguranca agora?', false);
  if (eject) {
    try { execFileSync('diskutil', ['eject', vol.wholeDiskId]); console.log('Disco ejetado. Ja pode desconectar.'); }
    catch (e) { console.log('Nao foi possivel ejetar automaticamente:', e.message); }
  }
  rl.close();
}

// ---------------- modo demo (simulacao local, sem tocar em disco real) ----------------

async function runDemo(args) {
  const sizeArg = args.find(a => a.startsWith('--size='));
  const sizeMB = sizeArg ? parseInt(sizeArg.split('=')[1], 10) : 64;
  const fakeArg = args.find(a => a.startsWith('--fake='));
  const fakePct = fakeArg ? parseFloat(fakeArg.split('=')[1]) : null;

  const targetBytes = sizeMB * 1024 * 1024;
  const fakeCapacity = fakePct ? Math.floor(targetBytes * fakePct / 100) : null;

  console.log(paint('bold', '\nDiskSafe -- modo demonstracao (simulacao em pasta temporaria, nada real e testado)\n'));
  console.log(`Tamanho simulado: ${formatBytes(targetBytes)}` +
    (fakeCapacity ? paint('yellow', `  (capacidade real simulada: ${formatBytes(fakeCapacity)} -- o resto e "fantasma")`) : ''));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disksafe-demo-'));
  const filePath = path.join(dir, 'demo.bin');
  const seed = crypto.randomBytes(16).toString('hex');
  const genChunk = makeGenerator(seed);
  const cols = computeCols();
  const numBlocks = computeNumBlocks(targetBytes, cols);
  const grid = new BlockGrid(numBlocks, cols);
  const blockBytes = Math.ceil(targetBytes / numBlocks);

  console.log(`Bloco = ${formatBytes(blockBytes)} | grade = ${grid.cols}x${grid.rows}\n`);

  // escrita (simulada; se fakeCapacity definido, dados alem da capacidade real
  // simplesmente nao sao gravados de verdade -- como um chip fake que aceita
  // o comando de escrita mas nao tem memoria fisica ali)
  let written = 0, chunkIndex = 0;
  const fd = fs.openSync(filePath, 'w+');
  const t0 = Date.now();
  let lastRender = 0;
  while (written < targetBytes) {
    const len = Math.min(CHUNK_SIZE, targetBytes - written);
    if (!fakeCapacity || written < fakeCapacity) {
      const writeLen = fakeCapacity ? Math.min(len, fakeCapacity - written) : len;
      const buf = genChunk(chunkIndex, writeLen);
      fs.writeSync(fd, buf, 0, writeLen, written);
    }
    written += len; chunkIndex++;
    updateGridWrite(grid, written, blockBytes);
    if (Date.now() - lastRender > 80 || written >= targetBytes) {
      renderStatus(grid, 'Escrevendo (simulado)', written, targetBytes, t0);
      lastRender = Date.now();
    }
  }
  fs.closeSync(fd);
  const writeSeconds = (Date.now() - t0) / 1000;
  for (let i = 0; i < grid.numBlocks; i++) grid.setState(i, 'written');
  renderStatus(grid, 'Escrevendo (simulado)', written, targetBytes, t0);

  console.log('\n' + paint('cyan', 'Escrita concluida. Verificando (lendo de volta)...') + '\n');

  const fd2 = fs.openSync(filePath, 'r');
  let read = 0, vChunkIndex = 0, ghostBytes = 0, firstGhost = null;
  const t1 = Date.now();
  lastRender = 0;
  while (read < targetBytes) {
    const len = Math.min(CHUNK_SIZE, targetBytes - read);
    const expected = genChunk(vChunkIndex, len);
    const buf = Buffer.alloc(len);
    fs.readSync(fd2, buf, 0, len, read);
    const ok = buf.equals(expected);
    const blockIdx = Math.min(grid.numBlocks - 1, Math.floor(read / blockBytes));
    if (!ok) {
      if (firstGhost === null) firstGhost = read;
      ghostBytes += len;
      grid.setState(blockIdx, 'ghost');
    } else if (grid.state[blockIdx] !== 'ghost') {
      grid.setState(blockIdx, 'ok');
    }
    read += len; vChunkIndex++;
    if (Date.now() - lastRender > 80 || read >= targetBytes) {
      renderStatus(grid, 'Verificando (simulado)', read, targetBytes, t1);
      lastRender = Date.now();
    }
  }
  fs.closeSync(fd2);
  const readSeconds = (Date.now() - t1) / 1000;

  printSummary({ targetBytes, verifiedBytes: read, ghostBytes, firstGhost, writeBytes: written, writeSeconds, readSeconds });
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------- entrada ----------------

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Uso:\n  node disksafe.js            fluxo real, interativo\n  node disksafe.js --demo     simulacao segura em pasta temporaria\n  node disksafe.js --demo --size=128 --fake=40   simula disco fantasma (40% da capacidade e real)');
    return;
  }
  if (args.includes('--demo')) return runDemo(args);
  return runReal();
}

process.on('SIGINT', () => { process.stdout.write('\n' + ANSI.reset); process.exit(130); });

main().catch(e => { console.error(paint('red', 'Erro: ' + e.message)); process.exit(1); });
