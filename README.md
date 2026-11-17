# AI Reader for Obsidian

Read papers with an AI assistant inside Obsidian. A chat panel sits in the
sidebar, grounded in the note (or PDF) you're reading — answers cite the source,
and a click on any citation badge jumps back to that line.

> **Zotero user?** This is the Obsidian port of **[AI Reader for Zotero →
> github.com/dongZheX/zotero-ai-reader](https://github.com/dongZheX/zotero-ai-reader)**.
> Same reading assistant, grounded in Zotero's PDFs instead of Markdown notes.

Zotero's document is a PDF with page coordinates; Obsidian's is a Markdown note,
so the same interaction concepts are re-grounded on Markdown.

## What it is

Open a Markdown note (a paper note, a Clipping, your own writing) and ask
questions about it — the note's text is injected as context, so answers stay
grounded in the actual document. Two things make it more than a chat box:

- **Answers point back to the line.** Each claim can carry a badge (`L42`).
  Click it and the editor scrolls to that sentence and flashes it.
- **The model can write highlights.** It proposes "highlight this / note that",
  shown as buttons. Nothing changes until you click — then it wraps the
  sentence in a colour-coded `==`/`<mark>` highlight with a hidden `%%` note,
  which you can remove again from the panel.

## Features

| | |
|---|---|
| **Grounded chat** | The whole note is injected as context. Streaming output rendered with Obsidian's own Markdown + math. Token / context usage per message. |
| **Click-to-source** | `[B<id>]` citations render as line badges. Click to scroll + flash the matching sentence. |
| **AI highlights/notes** | The model proposes highlights/notes; apply with one click as colour-coded `<mark>` + `%%` comment written into the note. `✕` removes it. |
| **Agentic read & annotate** | One click (**✨ 通读并标注**) sends a tool-calling agent through the whole note, applying category-coloured highlights — contribution (yellow), method (green), result (blue), limitation (red), key term (purple) — de-duplicated, with a live log and one-click **undo**. |
| **Figure vision** | Embedded images (`![[fig.png]]`) are sent to a multimodal model instead of reading only the caption. |
| **Web search & fetch** | Tools the model can call mid-answer: `web_search` (Google via Serper — set a Serper key) and `web_fetch` (read any page, always available) for background, latest work, or term definitions beyond the document. |
| **Selection popup** | Select text in the editor to quote it to the sidebar, explain it (streaming, grounded), or translate it — plus right-click menu entries. |
| **Your notes as context** | Reads your existing `==highlights==` / `<mark>` / `%%comments%%` so you can ask "summarize my highlights". |
| **Persistence** | Conversation history is saved per note and restored next time. Save a conversation as a sibling note. |
| **PDF (secondary)** | Open a PDF in Obsidian's reader for text-only Q&A with page-jump citations. No write-back (Obsidian has no PDF annotation API). |
| **Provider-agnostic** | OpenAI `chat/completions`, OpenAI `responses`, Anthropic `messages`. Works with compatible gateways (DeepSeek, Moonshot, local Ollama / vLLM, …). |

## Install (manual)

```bash
git clone https://github.com/dongZheX/obsidian-ai-reader
cd obsidian-ai-reader && npm install && npm run build
npm run deploy   # COPIES manifest.json/main.js/styles.css into the vault plugin dir
# (copy, not symlink — Obsidian doesn't discover symlinked plugin folders)
```

Enable **AI Reader** under Settings → Community plugins, then reload. Desktop
only (streaming uses Node).

## Configure

Settings → AI Reader:

| Field | Notes | Example |
|---|---|---|
| API format | `chat-completions`, `responses`, or `anthropic` | OpenAI `/chat/completions` |
| Base URL | Root endpoint; a bare host gets `/v1`, `http` is upgraded to `https` | `https://api.openai.com/v1` |
| API Key | Your key | `sk-…` |
| Model | Model name | `gpt-5` · `deepseek-chat` · `claude-opus-5-5` |
| Output language | Reply language | 中文 / English / 日本語 |
| Temperature | Sampling temperature | `0.3` |
| Max characters | Upper bound on injected body text | `60000` |
| Max output tokens | `0` = no limit | `0` |
| Serper API Key | Enables `web_search` (serper.dev); empty = only `web_fetch` | `…` |

Use **Test connection** to check the setup.

## Usage

1. Open a note (or PDF). Click the ribbon **bot** icon or run "打开 AI Reader 面板".
2. Click **总结全文**, or type a question. Citations `L<n>` scroll + flash.
3. Click **应用划线 / 应用批注** to write a highlight into the note.
4. Select text → popup / right-click for **问 AI / 解释 / 翻译**.
5. **✨ 通读并标注** to auto-annotate the whole note (one-click undo).
6. **存为笔记** to save the conversation to a sibling note.

## How it works

```
active note → parseMarkdownBlocks → blocks with line + char offsets → [B<id> L<line>]
      │  injected into the system prompt (cite with [B<id>], propose
      │  annotations with [[hl:id]] / [[note:id|text]], view images with [[fig:id]])
      ▼
  streaming reply → Obsidian MarkdownRenderer
      ├─ [B<id>]     → line badge → scroll + flash the sentence
      └─ [[hl|note]] → button     → <mark data-air> + %% note %% written into the note
```

## Build & test

```bash
npm run build     # tsc --noEmit + esbuild → main.js
node test/sim.js  # headless logic tests → ALL OK
```

## License

[Apache License 2.0](LICENSE)
