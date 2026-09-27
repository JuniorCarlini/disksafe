<div align="center">

# 🛡️ DiskSafe

**Verificador de disco/pendrive "fantasma" para macOS — direto no terminal, com menu de setas e barra de blocos colorida.**

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![macOS](https://img.shields.io/badge/macOS-diskutil-000000?style=for-the-badge&logo=apple&logoColor=white)](https://support.apple.com/guide/disk-utility/welcome/mac)
[![Zero deps](https://img.shields.io/badge/depend%C3%AAncias-zero-brightgreen?style=for-the-badge)]()

</div>

---

## 📌 Sobre o Projeto

Muito pendrive e cartão SD vendido por aí mente sobre a própria capacidade: a controladora informa 1 TB pro macOS, mas só existem 16 GB de memória de verdade lá dentro. Ao encher o disco, os dados mais antigos vão sendo sobrescritos silenciosamente — parece que salvou tudo, mas na volta metade dos arquivos está corrompida.

O **DiskSafe** é a mesma técnica usada por ferramentas como o [F3](https://github.com/AltraMayor/f3) e o H2testw: escreve dados únicos e verificáveis preenchendo o espaço livre do disco, força a queda do cache do sistema (desmontando e remontando), lê tudo de volta e compara byte a byte. Enquanto isso, o terminal mostra uma grade de blocos que vai pintando — cinza (pendente), azul (escrito), amarelo (processando), **verde** (confirmado real) ou **vermelho** (fantasma — não bate com o que foi escrito).

Um único arquivo, sem nenhuma dependência de `npm install` — só Node.js e o `diskutil` que já vem no macOS.

## 🚀 Requisitos

| Ferramenta | Como instalar | Descrição |
| :--- | :--- | :--- |
| **macOS** | — | Usa o `diskutil`/`plutil` do sistema para listar os discos com segurança. |
| **Node.js 18+** | `brew install node` | Único requisito de fato. Não há dependências externas (`npm install` não é necessário). |

## 🛠️ Como Usar

**1.** Abra o terminal na pasta do projeto.

**2.** Teste primeiro em modo demonstração — roda tudo numa pasta temporária, sem tocar em disco nenhum:

```bash
node disksafe.js --demo
```

Para ver a detecção de um disco fantasma simulado (aqui, 40% da capacidade declarada é "real", o resto é inventado):

```bash
node disksafe.js --demo --size=128 --fake=40
```

**3.** Para testar um pendrive, cartão SD ou HD externo de verdade, conecte o dispositivo e rode:

```bash
node disksafe.js
```

O programa lista os discos externos/removíveis encontrados, mostra um card com todos os dados relevantes do disco escolhido (capacidade, sistema de arquivos, barramento, status SMART, etc.) e pede confirmação antes de começar.

**4.** Navegue com as **setas ↑/↓** e aperte **Enter** — nada de digitar número ou "CONFIRMAR". `Esc` cancela a etapa atual, `Ctrl+C` encerra o programa a qualquer momento.

**5.** No final, o resultado mostra quanto do disco é real, quanto é fantasma (e a partir de qual ponto), além da velocidade média de gravação e leitura. O programa pergunta se quer apagar os arquivos de teste e ejetar o disco com segurança.

## 🔒 Segurança

- Só aparecem na lista discos **externos ou removíveis** (pendrive, SD, HD USB). O disco onde o macOS está instalado nunca é listado, mesmo em leitores internos de cartão SD.
- O teste **não apaga seus arquivos**: só ocupa o espaço livre temporariamente com dados de teste, removidos ao final (ou quando você mandar apagar).
- Antes de escrever qualquer coisa, o programa mostra um card com os detalhes do disco e exige uma confirmação explícita pelo menu.

---
<div align="center">
<i>Antes de confiar a capacidade de um disco, verifique.</i>
</div>
