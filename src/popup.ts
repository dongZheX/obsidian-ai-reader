/* Reader-selection popup + editor context-menu entries.
 * Ported from zotero-ai-reader's onSelectionPopup / onReaderContextMenu /
 * _explainMessages. In Obsidian the "reader" is the Markdown editor; explain is
 * grounded with retrieval over the note + recent chat, streamed into a floating
 * glass popover, with copy and write-to-note actions. */
import { Editor, MarkdownRenderer, MarkdownView, Menu, Notice, TFile } from "obsidian";
import type AIReaderPlugin from "./main";
import { ChatMessage } from "./types";
import { parseMarkdownBlocks } from "./source";
import { buildRetrievedContext } from "./retrieval";

export function registerSelectionUI(plugin: AIReaderPlugin) {
  // context-menu entries (reliable fallback, always available)
  plugin.registerEvent(plugin.app.workspace.on("editor-menu", (menu: Menu, editor: Editor, view: MarkdownView) => {
    const text = (editor.getSelection() || "").trim();
    if (!text || !plugin.settings.apiKey) return;
    const lang = plugin.settings.language || "中文";
    menu.addItem((i) => i.setTitle("AI Reader：在侧栏问").setIcon("bot").onClick(() => quoteToSidebar(plugin, view.file, text)));
    menu.addItem((i) => i.setTitle("AI Reader：解释").setIcon("message-square").onClick(() => explainToSidebar(plugin, view.file, text)));
    menu.addItem((i) => i.setTitle("AI Reader：翻译").setIcon("languages").onClick(async () => {
      const ans = await plugin.llm.callLLM([{ role: "system", content: "You are a professional translator. Translate into " + lang + ". Output only the translation." }, { role: "user", content: text }]).catch((e) => "翻译失败：" + e.message);
      new Notice(ans.slice(0, 500));
    }));
  }));

  // floating popup on selection
  const popup = new SelectionPopup(plugin);
  plugin.registerDomEvent(document, "mouseup", (ev) => popup.onMouseUp(ev));
  plugin.registerDomEvent(document, "keydown", (ev) => { if (ev.key === "Escape") popup.hide(); });
  plugin.register(() => popup.hide());
}

function activeMarkdown(plugin: AIReaderPlugin): { view: MarkdownView; editor: Editor } | null {
  const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
  if (view && view.editor) return { view, editor: view.editor };
  return null;
}

function quoteToSidebar(plugin: AIReaderPlugin, file: TFile | null, text: string) {
  if (!file) return;
  const panel = plugin.panels.get(file.path);
  if (panel) { plugin.activateView().then(() => panel.quoteIntoComposer(text)); return; }
  plugin.activateView().then(() => { const p = plugin.panels.get(file.path); if (p) p.quoteIntoComposer(text); });
}
function explainToSidebar(plugin: AIReaderPlugin, file: TFile | null, text: string) {
  if (!file) return;
  plugin.activateView().then(() => {
    const p = plugin.panels.get(file.path);
    if (p) p.send("请结合上下文解释这段原文，并指出它在文档中的作用：\n“" + text + "”", { broad: false });
  });
}

// Grounded explain messages (ported _explainMessages).
export async function explainMessages(plugin: AIReaderPlugin, file: TFile | null, text: string): Promise<ChatMessage[]> {
  const lang = plugin.settings.language || "中文";
  let ctx = "";
  if (file) {
    let blocks = plugin.blockStore.get(file.path);
    if (!blocks) { try { blocks = parseMarkdownBlocks(await plugin.app.vault.read(file)); plugin.blockStore.set(file.path, blocks); } catch (e) {} }
    if (blocks) ctx = buildRetrievedContext(blocks, text, Number(plugin.settings.maxChars) || 60000);
  }
  const hist = (file && plugin.chatStore.get(file.path)) || [];
  const sys = "You explain excerpts from academic papers/notes clearly and concisely in " + lang +
    ". 2-4 sentences. The context and prior conversation are BACKGROUND only — use them to stay consistent, but answer by explaining the selected passage directly. Do NOT comment on, apologise for, or correct earlier messages." +
    (ctx ? "\n\n## 相关段落\n" + ctx : "");
  const messages: ChatMessage[] = [{ role: "system", content: sys }];
  for (const m of hist.slice(-8)) if (m && m.role && m.content) messages.push({ role: m.role, content: m.content });
  messages.push({ role: "user", content: "只解释下面这段原文（可参考上下文，但不要评论之前的对话）：\n“" + text + "”" });
  return messages;
}

class SelectionPopup {
  private el: HTMLElement | null = null;
  private cancel = { v: false };
  private lastText = "";
  constructor(private plugin: AIReaderPlugin) {}

  hide() { if (this.el) { this.el.remove(); this.el = null; } this.cancel.v = true; }

  onMouseUp(ev: MouseEvent) {
    if (this.el && this.el.contains(ev.target as Node)) return; // clicking inside
    const md = activeMarkdown(this.plugin);
    const text = md ? (md.editor.getSelection() || "").trim() : "";
    if (!text || !this.plugin.settings.apiKey) { this.hide(); return; }
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) { this.hide(); return; }
    let rect: DOMRect;
    try { rect = sel.getRangeAt(0).getBoundingClientRect(); } catch (e) { this.hide(); return; }
    if (!rect || (rect.width === 0 && rect.height === 0)) { this.hide(); return; }
    this.show(text, rect, md!);
  }

  private show(text: string, rect: DOMRect, md: { view: MarkdownView; editor: Editor }) {
    this.hide();
    this.lastText = text;
    const lang = this.plugin.settings.language || "中文";
    const wrap = document.body.createDiv("air-sel-popup");
    this.el = wrap;
    wrap.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 480)) + "px";
    wrap.style.top = (rect.bottom + 6) + "px";

    const result = wrap.createDiv("air-sel-result"); result.style.display = "none";
    const actions = wrap.createDiv("air-sel-actions"); actions.style.display = "none";
    let lastResult = "";

    const renderMD = (t: string) => { result.empty(); MarkdownRenderer.render(this.plugin.app, t, result, md.view.file?.path || "", this.plugin as any); };

    const mkItem = (label: string, primary: boolean, run: () => void) => {
      const b = wrap.createDiv({ cls: "air-sel-item" + (primary ? " air-sel-primary" : ""), text: label });
      b.onclick = run; return b;
    };
    const runStream = (base: string, wait: string, showActions: boolean, producer: (onDelta: (d: string) => void, stop: () => boolean) => Promise<any>) => async () => {
      this.cancel.v = false;
      result.style.display = "block"; result.setText("⏳ " + wait + "…"); actions.style.display = "none"; lastResult = "";
      let acc = "", lastR = 0;
      try {
        await producer((d) => { acc += d; const now = Date.now(); if (now - lastR > 90) { lastR = now; result.setText(acc); try { result.scrollTop = result.scrollHeight; } catch (e) {} } }, () => this.cancel.v);
        lastResult = acc.trim();
        if (lastResult) renderMD(lastResult); else result.setText(this.cancel.v ? "（已停止）" : "(空响应)");
        if (showActions && lastResult) actions.style.display = "flex";
      } catch (e: any) { result.setText("出错：" + (e.message || e)); }
    };

    mkItem("问 AI（引用到侧栏）", true, () => { quoteToSidebar(this.plugin, md.view.file, text); result.style.display = "block"; result.setText("已引用到侧栏输入框 →"); });
    wrap.createDiv("air-sel-sep");
    mkItem("AI 解释", false, () => runStream("AI 解释", "解释中", true, async (onDelta, stop) => this.plugin.llm.callLLMStream(await explainMessages(this.plugin, md.view.file, text), onDelta, stop))());
    mkItem("翻译", false, () => runStream("翻译", "翻译中", false, (onDelta, stop) => this.plugin.llm.callLLMStream([{ role: "system", content: "You are a professional translator. Translate into " + lang + ". Output only the translation." }, { role: "user", content: text }], onDelta, stop))());

    const copy = actions.createDiv({ cls: "air-sel-mini", text: "复制" });
    copy.onclick = () => { if (!lastResult) return; navigator.clipboard.writeText(lastResult); copy.setText("已复制 ✓"); setTimeout(() => copy.setText("复制"), 1400); };
    const write = actions.createDiv({ cls: "air-sel-mini", text: "写入批注" });
    write.onclick = () => {
      if (!lastResult) return;
      try {
        const esc = lastResult.replace(/\n+/g, " ").replace(/%%/g, "%");
        const id = Math.random().toString(36).slice(2, 8);
        md.editor.replaceSelection('<mark class="air-hl" data-air="' + id + '" style="background:#ffd400;color:inherit">' + text + "</mark>%%air:" + id + " AI 解释：" + esc + "%%");
        write.setText("已写入 ✓"); setTimeout(() => this.hide(), 900);
      } catch (e) { write.setText("写入失败"); }
    };
  }
}
