# AI Reader for Obsidian — developer notes

An Obsidian desktop plugin (TypeScript + esbuild). Port of `~/zotero-ai-reader`.
The panel is an `ItemView` in `src/view.ts`; the provider layer is `src/llm.ts`;
document parsing is `src/source.ts`; highlights-into-note are `src/annotate.ts`;
the tool-calling agent is `src/agent.ts`. Tests: `node test/sim.js` → `ALL OK`.

## Workflow (read before committing)

- **Release only after the user says OK.** Between confirmations: run tests and
  rebuild (`npm run build`) with the version in `manifest.json` **unchanged**;
  do not bump the version and do not push. Only when the user confirms do you
  bump `manifest.json` + `versions.json`, commit, and push.
- **Tests must pass.** `node test/sim.js` must print `ALL OK`. Add assertions
  there for any new pure logic — it's the only automated safety net.
- **Typecheck + build:** `npm run build` (runs `tsc -noEmit` then esbuild).
- **Deploy for live testing:** `npm run deploy` COPIES `manifest.json` +
  `main.js` + `styles.css` into `~/dongzhe-md/.obsidian/plugins/ai-reader`
  (folder name must equal the manifest `id`, which is `ai-reader` — NOT the repo
  name `obsidian-ai-reader`; community-plugin ids may not contain "obsidian").
  Do NOT symlink the repo as the plugin folder — Obsidian does not discover
  symlinked plugin dirs (`app.plugins.manifests` stays empty). After `npm run
  build && npm run deploy`, reload with the CLI:
  ```bash
  /usr/local/bin/obsidian eval code="app.plugins.disablePlugin('ai-reader').then(()=>app.plugins.enablePlugin('ai-reader'))"
  /usr/local/bin/obsidian dev:errors
  ```
  (The `obsidian` CLI drives the running app: `eval`, `dev:errors`,
  `dev:screenshot`. Avoid `dev:debug on` / `dev:console` — they hung the CLI.)
- **Scan for secrets before every commit.** Never commit an API key.
  ```bash
  grep -rnEi "sk-[A-Za-z0-9]{20,}" . --exclude-dir=.git --exclude-dir=node_modules
  ```

## Platform pitfalls (don't relearn these)

- **CORS.** The renderer `fetch` is CORS-blocked for LLM hosts. Non-streaming
  calls go through Obsidian's `requestUrl` (bypasses CORS); streaming goes
  through Node `https`/`http` (`src/net.ts`). This is why the plugin is
  `isDesktopOnly`.
- **Directive tokens vs Obsidian syntax.** `[[hl:B3]]` looks like a wikilink and
  `==x==` is highlight syntax, so assistant tokens are masked to private-use
  placeholders BEFORE `MarkdownRenderer.render`, then swapped for real elements
  (`src/render.ts` `maskTokens`). Don't feed raw tokens to the renderer.
- **Writing into the note.** Highlights are `<mark data-air="UID" …>text</mark>`
  + a hidden `%%air:UID …%%` comment, written via `vault.process` so they're
  atomic and Ctrl+Z-able. Removal/undo is by UID. `applyMany` splices from the
  END of the document so earlier offsets stay valid in a batch; it skips text
  already wrapped (idempotent).
- **Block offsets drift** if the user edits after parsing. `Annotator.locate`
  tolerates this: trust the recorded offset, else search for the sentence, else
  a whitespace-insensitive regex.
- **PDF is best-effort.** Text is read from the open viewer's pdf.js document
  (`view.viewer.child.pdfViewer…`), which is internal and version-fragile — all
  access is feature-detected. PDF blocks carry a page only: cite + page-jump,
  no highlight write-back.
- **MarkdownRenderer** is `MarkdownRenderer.render(app, md, el, sourcePath, component)`.
  Pass a real `Component` (the view or the plugin) so child renders are cleaned up.

## Mapping to the Zotero original

| Zotero (`content/aireader.js`) | Obsidian |
|---|---|
| PDF structured text + pageRects | `parseMarkdownBlocks` → line + char offsets (`src/source.ts`) |
| `Zotero.Reader.open({position})` | scroll editor + flash (`view.navigateTo`) |
| `Zotero.Annotations.saveFromJSON` | `<mark>`/`%%` via `vault.process` (`src/annotate.ts`) |
| marked + KaTeX (vendored) | Obsidian `MarkdownRenderer` (`src/render.ts`) |
| `_fetchLLM` (fetch) | `requestUrl` + Node https (`src/net.ts`) |
| everything else (providers, agent, retrieval) | ported ~verbatim (`src/llm.ts`, `src/agent.ts`, `src/retrieval.ts`) |
