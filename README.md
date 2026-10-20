<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/JuniorCarlini/disksafe/main/assets/logo-dark.svg">
  <img src="https://raw.githubusercontent.com/JuniorCarlini/disksafe/main/assets/logo-light.svg" alt="" width="70" height="114">
</picture>

<h1>DiskSafe</h1>

**Verificador de disco/pendrive "fantasma" para macOS — descobre quando a capacidade real de um disco é menor do que a anunciada.**

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![macOS](https://img.shields.io/badge/macOS-diskutil-000000?style=for-the-badge&logo=apple&logoColor=white)](https://support.apple.com/guide/disk-utility/welcome/mac)
[![Zero deps](https://img.shields.io/badge/depend%C3%AAncias-zero-0E9F6E?style=for-the-badge)]()

</div>

---

## 📌 Sobre o Projeto

Muito pendrive e cartão SD vendido por aí mente sobre a própria capacidade: a controladora informa 1 TB pro macOS, mas só existem 16 GB de memória de verdade lá dentro. Ao encher o disco, os dados mais antigos vão sendo sobrescritos silenciosamente — parece que salvou tudo, mas na volta metade dos arquivos está corrompida.

O **DiskSafe** usa a mesma técnica de ferramentas como o [F3](https://github.com/AltraMayor/f3) e o H2testw para expor isso: preenche o disco com dados verificáveis, força uma leitura real (sem cache) e compara o que voltou com o que foi escrito. Um único arquivo, sem nenhuma dependência de `npm install` — só Node.js e o `diskutil` que já vem no macOS.

## ⚙️ Como funciona

1. **Geração determinística** — a partir de uma semente aleatória (`seed`), cada bloco de dados é gerado com AES-256-CTR a partir do seu índice sequencial. Isso significa que o programa nunca precisa guardar o que escreveu: na hora de verificar, ele recalcula exatamente o mesmo bloco a partir do índice e compara.
2. **Preenchimento do espaço livre** — esses blocos são gravados em arquivos sequenciais (limitados a 2 GB cada, para não esbarrar no limite de arquivo do FAT32) até ocupar todo o espaço livre do volume escolhido.
3. **Queda forçada do cache** — depois de escrever, o programa roda `sync` e desmonta/remonta o disco físico inteiro (`diskutil unmountDisk` + `mountDisk`). Sem isso, uma leitura logo em seguida poderia vir da memória RAM do macOS em vez do disco de verdade, mascarando o problema.
4. **Leitura e comparação** — os arquivos são lidos de volta, o gerador recalcula o valor esperado para cada posição e compara byte a byte com o que foi realmente lido.
5. **Resultado** — todo trecho que não bate é memória "fantasma": o disco disse que tinha aquele espaço, mas não tem. O ponto onde a primeira divergência aparece indica, na prática, a capacidade real aproximada do disco.
6. **Escolha do disco** — a listagem nunca inclui o disco onde o macOS está instalado. Em vez de confiar apenas na flag "externo" do `diskutil` (que classifica errado leitores de cartão SD internos, por exemplo), o programa resolve qual é o disco de boot e exclui só ele, aceitando qualquer outro disco removível/ejetável.

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

- O teste **não apaga seus arquivos**: só ocupa o espaço livre temporariamente com dados de teste, removidos ao final (ou quando você mandar apagar).
- Antes de escrever qualquer coisa, o programa mostra um card com os detalhes do disco e exige uma confirmação explícita pelo menu.

---
<div align="center">
<i>Antes de confiar a capacidade de um disco, verifique.</i>
</div>
