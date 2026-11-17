import { ItemView, MarkdownView, Notice, TFile, WorkspaceLeaf } from "obsidian";
import type AIReaderPlugin from "./main";
import { Block, ChatMessage, Section } from "./types";
import { parseMarkdownBlocks, buildSections, figKind, locLabel, hasLoc } from "./source";
import { buildContextBounded, buildRetrievedContext } from "./retrieval";
import { renderAssistant, RenderCtx } from "./render";
import { agentTools, toolSchemas, execTool, ToolCtx, ToolBlockSpec } from "./agent";
import { CATEGORY_LABELS, colorForCategory } from "./annotate";
import { isPdfView, extractPdfBlocks, pdfGoToPage } from "./pdf";
import { saveConversationToNote } from "./notes";
import { webSearch, webFetch } from "./websearch";
import { SKILLS, COMMON_PRESETS, skillById, skillDirective, chipsFor, Preset } from "./skills";

export const VIEW_TYPE = "ai-reader-view";

interface SourceDoc { kind: "md" | "pdf"; file: TFile; path: string; blocks: Block[] | null; viewRef?: any; }

const FOLLOWUPS: [string, string][] = [
  ["更详细", "请在上一条回答基础上展开讲得更详细，补充细节与例子。"],
  ["举个例子", "针对上一条回答，给一个具体例子帮助理解。"],
  ["继续", "继续补充上一条回答里没展开的要点。"],
  ["通俗点", "把上一条回答用更通俗、面向非专业读者的方式再讲一遍。"],
];

export class AIReaderView extends ItemView {
  private statusEl!: HTMLElement;
  private msgsEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendEl!: HTMLButtonElement;
  private modelPillEl!: HTMLButtonElement;
  private previewEl!: HTMLElement;
  private chipsEl!: HTMLElement;
  private skillBtn!: HTMLElement;
  private modelMenu: HTMLElement | null = null;
  private modelList: string[] | null = null;
  private skillMenu: HTMLElement | null = null;

  private source: SourceDoc | null = null;
  streaming = false;
  cancel = false;
  private lastRun: { keys: string[]; applied: any[] } | null = null;
  private redo: { applied: any[] } | null = null;

  constructor(leaf: WorkspaceLeaf, private plugin: AIReaderPlugin) { super(leaf); }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return "AI Reader"; }
  getIcon() { return "bot"; }

  async onOpen() {
    this.buildSkeleton();
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.refresh()));
    this.registerEvent(this.app.workspace.on("file-open", () => this.refresh()));
    await this.refresh();
  }
  async onClose() { this.closeModelMenu(); this.closeSkillMenu(); }

  // --------------------------------------------------------------- skeleton
  private buildSkeleton() {
    const root = this.contentEl;
    root.empty();
    root.addClass("air-root");

    const top = root.createDiv("air-top");
    const agentBtn = top.createDiv({ cls: "air-top-btn air-top-agent", text: "✨ 通读并标注" });
    agentBtn.title = "让 AI 通读全文，自动按类别高亮+批注（可一键撤销）";
    agentBtn.onclick = () => this.agentAnnotate();
    const deepBtn = top.createDiv({ cls: "air-top-btn air-deep", text: "深读 " + (this.plugin.deepRead ? "开" : "关") });
    deepBtn.title = "深读模式：遍历所有章节、主动读图（更慢更贵）";
    if (this.plugin.deepRead) deepBtn.addClass("air-deep-on");
    deepBtn.onclick = () => { this.plugin.deepRead = !this.plugin.deepRead; deepBtn.setText("深读 " + (this.plugin.deepRead ? "开" : "关")); deepBtn.toggleClass("air-deep-on", this.plugin.deepRead); };
    this.skillBtn = top.createDiv({ cls: "air-top-btn air-skillbtn", text: "技能 ▾" });
    this.skillBtn.title = "选择阅读技能：切换方法与下方快捷按钮";
    this.skillBtn.onclick = (e) => { e.stopPropagation(); this.toggleSkillMenu(); };
    const noteBtn = top.createDiv({ cls: "air-top-btn", text: "存为笔记" });
    noteBtn.onclick = () => this.saveNote();
    top.createDiv("air-spacer");
    const gear = top.createDiv({ cls: "air-gear", text: "⚙" });
    gear.onclick = () => (this.app as any).setting && (this.app as any).setting.open && ((this.app as any).setting.open(), (this.app as any).setting.openTabById(this.plugin.manifest.id));

    this.statusEl = root.createDiv("air-status");
    this.msgsEl = root.createDiv("air-chat-msgs");

    this.chipsEl = root.createDiv("air-chips");
    this.renderChips();

    const footer = root.createDiv("air-footer");
    this.modelPillEl = footer.createEl("button", { cls: "air-modelpill" });
    this.modelPillEl.onclick = (e) => { e.stopPropagation(); this.toggleModelMenu(); };
    footer.createDiv("air-spacer");
    const clear = footer.createEl("button", { cls: "air-foot-btn", text: "清空" });
    clear.onclick = () => this.clear();

    const composer = root.createDiv("air-composer");
    this.inputEl = composer.createEl("textarea", { cls: "air-chat-input" });
    this.inputEl.rows = 1;
    this.inputEl.placeholder = "有什么尽管问我…";
    this.inputEl.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); this.onSend(); }
      else if (ev.key === "Escape" && this.streaming) { ev.preventDefault(); this.cancel = true; }
    });
    this.inputEl.addEventListener("input", () => { this.inputEl.style.height = "auto"; this.inputEl.style.height = Math.min(140, this.inputEl.scrollHeight) + "px"; });
    this.sendEl = composer.createEl("button", { cls: "air-send", text: "↑" });
    this.sendEl.onclick = () => { if (this.streaming) this.cancel = true; else this.onSend(); };

    this.previewEl = root.createDiv("air-preview");
    this.previewEl.style.display = "none";

    this.updateModelPill();
    this.updateSkillBtn();
  }

  // ---- reading skills: picker + per-skill chips ----
  private updateSkillBtn() { if (this.skillBtn) this.skillBtn.setText("技能 · " + skillById(this.plugin.settings.skill).label + " ▾"); }
  private renderChips() {
    if (!this.chipsEl) return;
    this.chipsEl.empty();
    for (const p of chipsFor(this.plugin.settings.skill)) {
      const c = this.chipsEl.createEl("button", { cls: "air-chip", text: p.label });
      c.onclick = () => this.send(p.q, { broad: p.broad, autoApply: p.autoApply, annos: p.annos, withFigures: p.withFigures });
    }
  }
  private toggleSkillMenu() {
    if (this.skillMenu) { this.closeSkillMenu(); return; }
    this.closeModelMenu();
    const menu = this.contentEl.createDiv("air-skillmenu");
    const cur = skillById(this.plugin.settings.skill).id;
    for (const s of SKILLS) {
      const it = menu.createDiv({ cls: "air-skillitem" + (s.id === cur ? " air-skillitem-on" : "") });
      it.createDiv({ cls: "air-skillitem-t", text: s.label });
      it.createDiv({ cls: "air-skillitem-d", text: s.desc });
      it.onclick = async (e) => { e.stopPropagation(); this.plugin.settings.skill = s.id; await this.plugin.saveSettings(); this.updateSkillBtn(); this.renderChips(); this.closeSkillMenu(); };
    }
    this.skillMenu = menu;
    const onDoc = (ev: MouseEvent) => { if (this.skillMenu && !this.skillMenu.contains(ev.target as Node) && ev.target !== this.skillBtn) this.closeSkillMenu(); };
    (this.skillMenu as any)._onDoc = onDoc;
    setTimeout(() => document.addEventListener("click", onDoc), 0);
  }
  private closeSkillMenu() { if (this.skillMenu) { const od = (this.skillMenu as any)._onDoc; if (od) document.removeEventListener("click", od); this.skillMenu.remove(); this.skillMenu = null; } }

  private setStatus(msg: string, kind?: string) { this.statusEl.setText(msg || ""); this.statusEl.className = "air-status" + (kind ? " air-status-" + kind : ""); }
  private updateSendButton() { this.sendEl.setText(this.streaming ? "■" : "↑"); this.sendEl.toggleClass("air-send-stop", this.streaming); }
  private updateModelPill() { this.modelPillEl.setText((this.plugin.settings.model || "选择模型") + "  ·  " + this.plugin.llm.fmt() + "  ▾"); }

  // ----------------------------------------------------------- active source
  private resolveActiveLeaf(): { kind: "md" | "pdf"; file: TFile; viewRef?: any } | null {
    // Prefer the most recent markdown/pdf leaf in the main area.
    const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (mdView && mdView.file) return { kind: "md", file: mdView.file };
    const active = this.app.workspace.getMostRecentLeaf();
    const v: any = active && active.view;
    if (v && isPdfView(v) && v.file) return { kind: "pdf", file: v.file, viewRef: v };
    // fall back: scan leaves
    let found: any = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      const lv: any = leaf.view;
      if (found) return;
      if (lv instanceof MarkdownView && lv.file) found = { kind: "md", file: lv.file };
      else if (lv && isPdfView(lv) && lv.file) found = { kind: "pdf", file: lv.file, viewRef: lv };
    });
    return found;
  }

  async refresh() {
    const res = this.resolveActiveLeaf();
    if (!res) { this.source = null; this.setStatus("打开一篇 Markdown 笔记或 PDF 开始。", "muted"); this.msgsEl.empty(); return; }
    if (this.source && this.source.path === res.file.path && this.source.kind === res.kind) { if (res.viewRef) this.source.viewRef = res.viewRef; return; }
    this.source = { kind: res.kind, file: res.file, path: res.file.path, blocks: null, viewRef: res.viewRef };
    this.plugin.panels.set(res.file.path, this);
    this.setStatus("", "muted");
    await this.restoreChat();
  }

  private async restoreChat() {
    if (!this.source) return;
    const path = this.source.path;
    let hist = this.plugin.chatStore.get(path);
    if (!hist) { hist = (await this.plugin.persist.loadChat(path)) || []; this.plugin.chatStore.set(path, hist); }
    this.renderHistory(hist);
  }

  private async ensureBlocks(): Promise<Block[]> {
    if (!this.source) throw new Error("没有活动文档");
    if (this.source.blocks && this.source.blocks.length) return this.source.blocks;
    let blocks = this.plugin.blockStore.get(this.source.path) || null;
    if (!blocks) {
      this.setStatus("正在提取正文…", "busy");
      if (this.source.kind === "pdf") {
        const v = this.source.viewRef || (this.resolveActiveLeaf() || ({} as any)).viewRef;
        blocks = await extractPdfBlocks(v);
      } else {
        const text = await this.app.vault.read(this.source.file);
        blocks = parseMarkdownBlocks(text);
        const stat = this.source.file.stat;
        this.plugin.persist.saveBlocks(this.source.path, stat ? stat.mtime : 0, blocks).catch(() => {});
      }
      if (!blocks || !blocks.length) throw new Error("无法提取结构化文本。");
      this.plugin.blockStore.set(this.source.path, blocks);
    }
    this.source.blocks = blocks;
    return blocks;
  }

  private lang() { return this.plugin.settings.language || "中文"; }
  private maxChars() { return Number(this.plugin.settings.maxChars) || 60000; }
  private requireKey(): boolean {
    if (!this.plugin.settings.apiKey) { this.setStatus("先在设置里填 API Key。", "error"); (this.app as any).setting?.open?.(); return false; }
    return true;
  }

  // ------------------------------------------------------------- chat render
  private renderHistory(hist: ChatMessage[]) {
    this.msgsEl.empty();
    let lastUser = "";
    for (const m of hist) {
      if (m.role === "user") { this.appendUser(String(m.content)); lastUser = String(m.content); }
      else if (m.role === "assistant") { const { msg, bubble } = this.appendAssistant(); this.renderInto(bubble, String(m.content)); this.addActions(msg, String(m.content), lastUser); }
    }
  }
  private appendUser(text: string) {
    const msg = this.msgsEl.createDiv("air-msg air-msg-user");
    msg.createDiv({ cls: "air-bubble", text });
    this.msgsEl.scrollTop = this.msgsEl.scrollHeight;
  }
  private appendAssistant(): { msg: HTMLElement; bubble: HTMLElement } {
    const msg = this.msgsEl.createDiv("air-msg air-msg-assistant");
    const bubble = msg.createDiv("air-bubble");
    this.msgsEl.scrollTop = this.msgsEl.scrollHeight;
    return { msg, bubble };
  }

  private renderCtx(): Omit<RenderCtx, "sourcePath" | "blocks"> {
    return {
      app: this.app, component: this,
      onNavigate: (b) => this.navigateTo(b),
      onApply: (b, kind, comment, btn) => this.applyFromButton(b, kind, comment, btn),
      onFig: (b) => this.explainFigure(b),
      onPreview: (b, ev) => this.showPreview(b, ev),
      onPreviewOut: () => (this.previewEl.style.display = "none"),
    };
  }
  private async renderInto(bubble: HTMLElement, text: string) {
    const blocks = (this.source && this.source.blocks) || [];
    await renderAssistant(bubble, text, Object.assign({ sourcePath: this.source ? this.source.path : "", blocks }, this.renderCtx()) as RenderCtx);
  }

  private addActions(msg: HTMLElement, fullText: string, question: string | null) {
    const row = msg.createDiv("air-actions");
    const mk = (label: string) => row.createSpan({ cls: "air-action", text: label });
    const copy = mk("复制");
    copy.onclick = () => { navigator.clipboard.writeText(fullText); copy.setText("已复制"); setTimeout(() => copy.setText("复制"), 1200); };
    if (question) mk("重新生成").onclick = () => this.regen(msg, question);
    const note = mk("存为笔记");
    note.onclick = async () => { note.setText("存中…"); try { await this.saveNote(); note.setText("✓ 已存"); } catch (e) { note.setText("存失败"); } setTimeout(() => note.setText("存为笔记"), 1500); };
    const dCount = (fullText.match(/\[\[(?:hl|note):B?\d+/g) || []).length;
    if (dCount > 0 && this.source && this.source.kind === "md") {
      const applyAll = mk("应用全部划线 (" + dCount + ")");
      applyAll.onclick = async () => {
        if ((applyAll as any)._busy) return; (applyAll as any)._busy = true; applyAll.setText("应用中…");
        const n = await this.autoApplyDirectives(fullText);
        applyAll.setText(n ? "✓ 已应用 " + n + " 处" : "未识别到"); (applyAll as any)._busy = false;
      };
    }
    if (question !== null) {
      const fups = msg.createDiv("air-followups");
      fups.createSpan({ cls: "air-followups-label", text: "追问" });
      for (const [label, q] of FOLLOWUPS) fups.createEl("button", { cls: "air-followup", text: label }).onclick = () => this.send(q, { broad: false });
    }
  }
  private regen(msg: HTMLElement, question: string) {
    msg.remove();
    const hist = this.plugin.chatStore.get(this.source!.path) || [];
    if (hist.length && hist[hist.length - 1].role === "assistant") hist.pop();
    this.send(question, { skipUser: true, broad: false });
  }

  // ------------------------------------------------------------------- send
  private onSend() { const q = (this.inputEl.value || "").trim(); if (!q) return; this.inputEl.value = ""; this.inputEl.style.height = "auto"; this.send(q, { broad: false }); }

  async send(text: string, opts: { broad?: boolean; skipUser?: boolean; autoApply?: boolean; annos?: boolean; withFigures?: boolean } = {}) {
    if (!this.source) { new Notice("打开一篇笔记或 PDF 再提问。"); return; }
    if (!this.requireKey()) return;
    if (this.streaming) return;
    const path = this.source.path;
    let hist = this.plugin.chatStore.get(path); if (!hist) { hist = []; this.plugin.chatStore.set(path, hist); }

    if (!opts.skipUser) this.appendUser(text);
    const { msg, bubble } = this.appendAssistant();
    bubble.addClass("air-streaming");
    this.streaming = true; this.cancel = false; this.updateSendButton();

    const meta: any = {};
    try {
      const blocks = await this.ensureBlocks();
      let ctx = opts.broad ? buildContextBounded(blocks, this.maxChars()) : buildRetrievedContext(blocks, text, this.maxChars());
      if (opts.annos && this.source.kind === "md") {
        const ua = await this.plugin.annotator.getUserAnnotations(this.source.file);
        if (ua.length) ctx = "【用户在笔记中的高亮与批注】（优先结合这些回答）：\n" + ua.join("\n") + "\n\n——\n\n正文：\n" + ctx;
        else this.setStatus("这篇笔记还没有你的高亮/批注。", "muted");
      }
      if (opts.withFigures) { this.setStatus("正在识读图表…", "busy"); try { const fd = await this.figureDigest(2); if (fd) ctx = fd + "——\n\n正文：\n" + ctx; } catch (e) {} }
      meta.ctxChars = ctx.length;
      this.setStatus("生成中…", "busy");
      await this.compactHistory(path, hist);
      const sumNote = this.plugin.histSummary.get(path);
      const deep = this.plugin.deepRead;
      const canWrite = this.source.kind === "md";
      const webNote = this.serperOn()
        ? "需要文档之外的背景、最新进展、术语或相关工作时，可用 web_search 联网搜索、web_fetch 抓取网页正文。"
        : "需要抓取某个网页正文时可用 web_fetch。";
      const toolNote = "\n\n上面的正文可能是节选。你可以调用工具查阅更多内容：list_sections 看章节结构；read_section 读取某一章拿到每句 id；list_figures 列出图表；view_figure 识读某张图/表；" +
        (canWrite ? "highlight 高亮某个句子 id（给 category 和一句话 reason）。" : "（当前文档为 PDF，不支持写入标注。）") + webNote +
        (deep ? "【深读模式】回答前请主动用 list_sections + read_section 读取所有相关章节，并对相关图/表 view_figure。" : "当注入正文不足以准确回答、或涉及具体数据/图表时，请主动调用 read_section / view_figure 查阅后再答；普通问题可直接作答。");
      const sys = this.plugin.llm.systemPrompt(ctx, this.lang()) + toolNote + skillDirective(this.plugin.settings.skill) + (sumNote ? "\n\n【早期对话要点】\n" + sumNote : "");
      const fmt = this.plugin.llm.fmt();
      // Continuous agentic context: one live message history (incl. tool turns)
      // persists across questions; compact it when it grows too large. Tool
      // results live in `convo`, so chat no longer injects priorContext here.
      let convo = this.ensureLive(path, fmt);
      if (opts.skipUser) this.rollbackLiveToLastUser(convo);
      convo = await this.compactLive(path, convo);
      if (!opts.skipUser) convo.push({ role: "user", content: text });
      const withSys = (): ChatMessage[] => [{ role: "system", content: sys }, ...convo];

      const tools = toolSchemas(fmt, { serper: this.serperOn() });
      const tc = this.buildToolCtx(blocks);
      const toolLog = createDiv("air-toollog"); let toolLogAdded = false; const grp: any = {};
      const ensureToolLog = () => { if (!toolLogAdded) { bubble.appendChild(toolLog); toolLogAdded = true; } };
      let answerEl = bubble.createDiv("air-answer");
      let full = "";
      const MAX_ROUNDS = deep ? 16 : 8;
      for (let round = 0; round < MAX_ROUNDS && !this.cancel; round++) {
        let acc = "", lastR = 0;
        const turnEl = answerEl;
        const res = await this.plugin.llm.streamAnswer(withSys(), tools, (d) => {
          acc += d; const el = this.msgsEl;
          const stick = (el.scrollHeight - el.scrollTop - el.clientHeight) < 60;
          const now = Date.now();
          if (now - lastR > 90) { lastR = now; turnEl.setText(acc); }
          this.setStatus("生成中… " + acc.length + " 字", "busy");
          if (stick) el.scrollTop = el.scrollHeight;
        }, () => this.cancel, meta);
        turnEl.setText(res.text || "");
        if (res.calls && res.calls.length && !this.cancel) {
          this.plugin.llm.pushAssistantToolTurn(fmt, convo, { text: res.text, calls: res.calls, reasoning: res.reasoning });
          ensureToolLog(); this.setStatus("调用工具中…", "busy");
          const results = await this.runToolCalls(tc, res.calls, toolLog, grp);
          this.plugin.llm.pushToolResults(fmt, convo, results);
          answerEl = bubble.createDiv("air-answer");
          this.msgsEl.scrollTop = this.msgsEl.scrollHeight;
          continue;
        }
        full = res.text || ""; break;
      }

      // Ran out of rounds without a final answer (model kept calling tools) —
      // ask once more WITHOUT tools so it must write the answer.
      if (!full && !this.cancel) {
        convo.push({ role: "user", content: "请基于以上读取到的内容，给出完整、充分的回答。" });
        try {
          const res2 = await this.plugin.llm.streamAnswer(withSys(), null, (d) => { answerEl.setText(answerEl.getText() + d); this.setStatus("整理回答…", "busy"); this.msgsEl.scrollTop = this.msgsEl.scrollHeight; }, () => this.cancel, meta);
          full = res2.text || answerEl.getText() || "";
        } catch (e) {}
      }

      bubble.removeClass("air-streaming");
      await this.renderInto(answerEl, full);
      this.addActions(msg, full, text);
      this.addMetaLine(msg, meta, full);
      if (tc.run.keys.length) { this.lastRun = tc.run; this.renderAgentSummary(bubble, tc.tally, tc.run.keys.length, false); }
      this.setStatus("", "");
      convo.push({ role: "assistant", content: full }); // final text turn into the live history
      if (!opts.skipUser) hist.push({ role: "user", content: text });
      hist.push({ role: "assistant", content: full });
      this.plugin.persist.saveChat(path, hist).catch(() => {});
      if (opts.autoApply && this.source.kind === "md") { const n = await this.autoApplyDirectives(full); this.setStatus(n ? "已自动高亮 " + n + " 处。" : "未识别到可高亮的句子。", n ? "ok" : "muted"); }
    } catch (e: any) {
      bubble.removeClass("air-streaming");
      bubble.setText(this.cancel ? "（已停止）" : "Error: " + (e.message || e));
    } finally { this.streaming = false; this.updateSendButton(); }
  }

  private addMetaLine(msg: HTMLElement, meta: any, full: string) {
    const outTok = meta.outTok != null ? meta.outTok : Math.round([...(full || "")].length / 3);
    const inTok = meta.inTok != null ? "⬆ " + meta.inTok + " " : "";
    const approx = meta.outTok != null ? "" : "~";
    const ctxk = meta.ctxChars != null ? " · 上下文 " + (meta.ctxChars >= 1000 ? (meta.ctxChars / 1000).toFixed(1) + "k" : meta.ctxChars) + " 字" : "";
    msg.createDiv({ cls: "air-meta", text: inTok + "⬇ " + approx + outTok + " tok" + ctxk });
  }

  // --------------------------------------------------------------- tool ctx
  private buildToolCtx(blocks: Block[]): ToolCtx {
    const byId = new Map(blocks.map((b) => [b.id, b]));
    return {
      sections: buildSections(blocks), byId, blocks,
      run: { keys: [], applied: [] }, tally: {}, reads: 0,
      highlight: async (block, cat, reason) => {
        if (!this.source || this.source.kind !== "md") return null;
        return await this.plugin.annotator.applyOne(this.source.file, block, { comment: reason, category: cat });
      },
      viewFigure: async (block) => {
        const uri = await this.figureDataURI(block);
        const vm = this.plugin.llm.buildVisionMessages(this.plugin.llm.fmt(), this.lang(), "请详细描述这张" + figKind(block.type) + "展示的内容、坐标轴/变量、关键趋势与结论。", uri);
        return await this.plugin.llm.callLLM(vm);
      },
      onRead: (index, title, text) => { if (this.source) this.plugin.readFor(this.source.path).set(index, { title, text }); },
      onFigure: (id, loc, desc) => { if (this.source) this.plugin.figFor(this.source.path).set(id, { loc, desc }); },
      serper: !!(this.plugin.settings.serperKey || "").trim(),
      webSearch: (q, num) => webSearch(this.plugin.settings.serperKey, q, num),
      webFetch: (url) => webFetch(url),
    };
  }
  private serperOn(): boolean { return !!(this.plugin.settings.serperKey || "").trim(); }

  // Run one round's tool calls. Read-only calls (sections/figures/web) run
  // concurrently up to maxParallelTools; side-effecting calls (highlight/finish)
  // stay serial and in order. Per-call failures become an error result. Tool
  // blocks render in the original call order. Ported from _runToolCalls.
  private async runToolCalls(tc: ToolCtx, calls: { id: string; name: string; args: any }[], logWrap: HTMLElement, grp: any): Promise<{ id: string; name: string; output: string; finish?: boolean }[]> {
    const RO = new Set(["list_sections", "read_section", "list_figures", "view_figure", "web_search", "web_fetch"]);
    const limit = Math.max(1, Number(this.plugin.settings.maxParallelTools) || 3);
    const slots: any[] = new Array(calls.length);
    const run1 = async (i: number) => {
      try { slots[i] = await execTool(tc, calls[i]); }
      catch (e: any) { slots[i] = { output: JSON.stringify({ error: String((e && e.message) || e) }), render: { label: calls[i].name, outcome: "✕ 失败" } }; }
    };
    const ro: number[] = [], wr: number[] = [];
    calls.forEach((call, i) => (RO.has(call.name) ? ro : wr).push(i));
    let p = 0;
    const worker = async () => { while (p < ro.length) await run1(ro[p++]); };
    await Promise.all(Array.from({ length: Math.min(limit, ro.length) }, () => worker()));
    for (const i of wr) await run1(i); // side effects serial + in order
    const results: { id: string; name: string; output: string; finish?: boolean }[] = [];
    for (let i = 0; i < calls.length; i++) {
      const r = slots[i];
      this.appendToolGrouped(logWrap, grp, r.render);
      results.push({ id: calls[i].id, name: calls[i].name, output: r.output, finish: r.finish });
    }
    return results;
  }

  // tool-block rendering (collapsible, grouped) -----------------------------
  private buildToolBlock(r: ToolBlockSpec): HTMLElement {
    const block = createDiv("air-tool");
    const header = block.createDiv("air-tool-header");
    if (r.cat) { const dot = header.createSpan("air-tool-dot"); dot.style.background = colorForCategory(r.cat); }
    else header.createSpan({ cls: "air-tool-arrow", text: "›" });
    header.createSpan({ cls: "air-tool-name", text: r.label });
    if (r.brief) header.createSpan({ cls: "air-tool-brief", text: r.brief });
    if (r.outcome) header.createSpan({ cls: "air-tool-outcome", text: r.outcome });
    if (r.bodyText) { block.createDiv({ cls: "air-tool-body", text: r.bodyText }); header.style.cursor = "pointer"; header.onclick = () => block.toggleClass("air-tool-open", !block.hasClass("air-tool-open")); }
    else if (r.jumpId != null) { header.style.cursor = "pointer"; header.onclick = () => { const b = (this.source?.blocks || []).find((x) => x.id === r.jumpId); if (b) this.navigateTo(b); }; }
    return block;
  }
  private appendToolGrouped(wrap: HTMLElement, grp: any, r: ToolBlockSpec) {
    const block = this.buildToolBlock(r);
    if (grp.label !== r.label || !grp.group) {
      const group = wrap.createDiv("air-toolgroup");
      const header = group.createDiv("air-toolgroup-header"); header.style.display = "none";
      header.createSpan({ cls: "air-tool-arrow", text: "›" });
      header.createSpan({ cls: "air-tool-name", text: r.label });
      const countEl = header.createSpan("air-toolgroup-count");
      const body = group.createDiv("air-toolgroup-body");
      header.onclick = () => group.toggleClass("air-toolgroup-open", !group.hasClass("air-toolgroup-open"));
      grp.label = r.label; grp.group = group; grp.header = header; grp.body = body; grp.countEl = countEl; grp.count = 0;
    }
    grp.body.appendChild(block); grp.count++;
    if (grp.count >= 2) { grp.header.style.display = "flex"; grp.countEl.setText("× " + grp.count); }
  }

  // ----------------------------------------------- agentic read & annotate
  async agentAnnotate() {
    if (!this.source) { new Notice("打开一篇笔记或 PDF 再运行。"); return; }
    if (this.source.kind !== "md") { new Notice("通读并标注目前仅支持 Markdown 笔记（PDF 无法写入标注）。"); return; }
    if (!this.requireKey() || this.streaming) return;
    const deep = this.plugin.deepRead;
    const MAX_TURNS = deep ? 80 : 30, MAX_ANN = deep ? 120 : 60, MAX_READS = deep ? 200 : 40;
    const blocks = await this.ensureBlocks();
    const sections = buildSections(blocks);
    if (!sections.length) { this.setStatus("无法提取正文结构，无法通读。", "error"); return; }
    const lang = this.lang(); const fmt = this.plugin.llm.fmt();

    this.appendUser("AI 通读并标注全文");
    const { bubble } = this.appendAssistant();
    this.streaming = true; this.cancel = false; this.updateSendButton();
    const headline = bubble.createDiv({ cls: "air-agent-sum", text: "🔧 正在阅读并标注…" });
    const logWrap = bubble.createDiv("air-toollog");

    const tc = this.buildToolCtx(blocks);
    tc.maxReads = MAX_READS; tc.maxAnn = MAX_ANN;
    const grp: any = {};
    let steps = 0;
    const setHead = () => headline.setText("🔧 阅读并标注中… 第 " + steps + " 步 · 已标注 " + tc.run.keys.length + " 处");

    const sys = "你是论文精读助手，用" + lang + "工作。任务：通读这篇文档，并在笔记里高亮关键句、加简短批注。\n" +
      "工具：list_sections 看章节结构；read_section 读你选的章节拿到每句 id；highlight 高亮某个句子 id 并给类别和一句话理由；list_figures 列出图表；view_figure 识读图/表。" +
      (this.serperOn() ? "需要核对背景、术语或相关工作时，可用 web_search 联网搜索、web_fetch 抓取网页。\n" : "需要抓取网页正文时可用 web_fetch。\n") +
      "流程：先 list_sections；再对值得读的章节逐个 read_section；对真正关键的句子调用 highlight（每节通常 2-6 句，精选，避免过度标注）；覆盖重要章节后调用 finish 结束。\n" +
      (deep ? "【深读模式】务必遍历所有章节（对每个 section 都 read_section），并对每张图/表 view_figure。\n" : "") +
      "类别只能是 contribution / method / result / limitation / keyterm。highlight 的 id 必须来自 read_section 返回的 id。" +
      (skillById(this.plugin.settings.skill).agentInject ? "\n" + skillById(this.plugin.settings.skill).agentInject : "") +
      this.plugin.priorContext(this.source!.path);
    const messages: ChatMessage[] = [{ role: "system", content: sys }, { role: "user", content: deep ? "请深读本文档（遍历所有章节 + 看所有图表）并标注关键句。先 list_sections。" : "请通读本文档并标注关键句。先 list_sections。" }];
    const tools = toolSchemas(fmt, { serper: this.serperOn() });

    try {
      let finished = false, nudged = false;
      for (let turn = 0; turn < MAX_TURNS && !finished; turn++) {
        if (this.cancel) break;
        if (tc.run.keys.length >= MAX_ANN) { this.appendToolGrouped(logWrap, {}, { label: "提示", outcome: "已达标注上限" }); break; }
        this.setStatus("阅读中… 第 " + (turn + 1) + " 步", "busy");
        let parsed;
        try { parsed = await this.plugin.llm.toolTurn(messages, tools); }
        catch (e: any) { this.appendToolGrouped(logWrap, grp, { label: "请求失败", outcome: String(e.message || e).slice(0, 80) }); break; }
        if (!parsed.calls.length) {
          if (!nudged && tc.run.keys.length === 0) { nudged = true; this.plugin.llm.pushAssistantToolTurn(fmt, messages, parsed); messages.push({ role: "user", content: "请使用工具：先 list_sections，再 read_section，然后 highlight 关键句，最后 finish。" }); continue; }
          if (parsed.text) logWrap.createDiv({ cls: "air-tool-thought", text: parsed.text });
          break;
        }
        this.plugin.llm.pushAssistantToolTurn(fmt, messages, parsed);
        const results = await this.runToolCalls(tc, parsed.calls, logWrap, grp);
        steps += parsed.calls.length; setHead();
        if (results.some((r) => r.finish)) finished = true;
        this.plugin.llm.pushToolResults(fmt, messages, results);
        setHead(); this.msgsEl.scrollTop = this.msgsEl.scrollHeight;
      }
      this.lastRun = tc.run;
      headline.setText((this.cancel ? "已停止 · " : "✓ ") + "本次共标注 " + tc.run.keys.length + " 处");
      this.renderAgentSummary(bubble, tc.tally, tc.run.keys.length, this.cancel);
      this.setStatus(this.cancel ? "已停止。" : "完成，已标注 " + tc.run.keys.length + " 处。", this.cancel ? "muted" : "ok");
    } catch (e: any) { headline.setText("出错：" + (e.message || e)); }
    finally { this.streaming = false; this.updateSendButton(); }
  }

  private renderAgentSummary(bubble: HTMLElement, tally: Record<string, number>, total: number, stopped: boolean) {
    const legend = bubble.createDiv("air-agent-legend");
    for (const cat of ["contribution", "method", "result", "limitation", "keyterm"]) {
      if (!tally[cat]) continue;
      const item = legend.createSpan({ cls: "air-agent-legenditem", text: (CATEGORY_LABELS[cat] || cat) + " " + tally[cat] });
      item.style.borderBottom = "2px solid " + colorForCategory(cat);
    }
    if (total > 0) {
      const btn = bubble.createEl("button", { cls: "air-followup", text: "↩ 撤销本次标注" });
      btn.onclick = async () => {
        if ((btn as any)._busy) return; (btn as any)._busy = true;
        try {
          if ((btn as any)._mode === "redo") { btn.setText("重做中…"); const n = await this.redoRun(); (btn as any)._mode = "undo"; btn.setText("↩ 撤销本次标注（已重做 " + n + " 处）"); }
          else { btn.setText("撤销中…"); const n = await this.undoRun(); (btn as any)._mode = "redo"; btn.setText("↪ 重做本次标注（已撤销 " + n + " 处）"); }
        } finally { (btn as any)._busy = false; }
      };
    }
  }
  private async undoRun(): Promise<number> {
    const run = this.lastRun;
    if (!run || !run.keys.length || !this.source || this.source.kind !== "md") return 0;
    const n = await this.plugin.annotator.removeByUids(this.source.file, run.keys);
    this.redo = { applied: (run.applied || []).slice() };
    this.lastRun = { keys: [], applied: [] };
    return n;
  }
  private async redoRun(): Promise<number> {
    const redo = this.redo;
    if (!redo || !redo.applied.length || !this.source || this.source.kind !== "md") return 0;
    const byId = new Map((this.source.blocks || []).map((b) => [b.id, b]));
    const items = redo.applied.map((a) => ({ block: byId.get(a.blockId)!, comment: a.comment, color: a.color, category: a.category })).filter((x) => x.block);
    const applied = await this.plugin.annotator.applyMany(this.source.file, items);
    this.lastRun = { keys: applied.map((a) => a.uid), applied };
    this.redo = { applied: [] };
    return applied.length;
  }

  // apply [[hl]]/[[note]] directives from an answer
  private async autoApplyDirectives(text: string): Promise<number> {
    if (!this.source || this.source.kind !== "md") return 0;
    const byId = new Map((this.source.blocks || []).map((b) => [b.id, b]));
    const re = /(?:\b(contribution|method|result|limitation|keyterm)\b[^\[]{0,40})?\[\[(hl|note):B?(\d+)(?:\|([^\]]*))?\]\]/gi;
    const perBlock = new Map<number, { comment: string; category: string | null }>();
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const cat = m[1] ? m[1].toLowerCase() : null;
      const id = Number(m[3]);
      const note = m[2].toLowerCase() === "note" ? (m[4] || "") : "";
      const cur = perBlock.get(id) || { comment: "", category: null };
      if (note && !cur.comment) cur.comment = note;
      if (cat && !cur.category) cur.category = cat;
      perBlock.set(id, cur);
    }
    const items: any[] = [];
    for (const [id, info] of perBlock) { const b = byId.get(id); if (b) items.push({ block: b, comment: info.comment, category: info.category }); }
    const applied = await this.plugin.annotator.applyMany(this.source.file, items);
    if (applied.length) { this.lastRun = { keys: applied.map((a) => a.uid), applied }; }
    return applied.length;
  }

  // ------------------------------------------------- navigation & previews
  async navigateTo(block: Block) {
    if (!this.source) return;
    if (this.source.kind === "pdf") { const v = this.source.viewRef; if (v && block.page) pdfGoToPage(v, block.page); return; }
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(this.source.file);
    const view = leaf.view as MarkdownView;
    const editor = view && view.editor;
    if (editor && block.startOffset != null) {
      try {
        const from = editor.offsetToPos(block.startOffset);
        const to = editor.offsetToPos(Math.min(block.endOffset!, (await this.app.vault.read(this.source.file)).length));
        editor.setSelection(from, to);
        editor.scrollIntoView({ from, to }, true);
        setTimeout(() => { try { editor.setCursor(from); } catch (e) {} }, 1600);
      } catch (e) {}
    }
  }
  private showPreview(block: Block, ev: MouseEvent) {
    const p = this.previewEl; p.setText(block.text || ""); p.style.display = "block";
    try { const r = (ev.target as HTMLElement).getBoundingClientRect(); const rr = this.contentEl.getBoundingClientRect(); p.style.left = Math.max(4, r.left - rr.left) + "px"; p.style.top = (r.bottom - rr.top + 4) + "px"; } catch (e) {}
  }

  private async applyFromButton(block: Block, kind: "hl" | "note", comment: string, btn: HTMLElement) {
    if (!this.source || this.source.kind !== "md") { new Notice("PDF 不支持写入标注。"); return; }
    if ((btn as any)._busy) return;
    if ((btn as any)._uid) { this.navigateTo(block); return; }
    (btn as any)._busy = true; const orig = btn.getText(); btn.setText("…");
    try {
      const r = await this.plugin.annotator.applyOne(this.source.file, block, { comment: kind === "note" ? comment : comment, category: null });
      if (r) {
        (btn as any)._uid = r.uid;
        btn.empty(); btn.addClass("air-apply-done");
        btn.createSpan({ cls: "air-apply-label", text: "✓ 已标注 " + locLabel(block) + " · 点击跳转" });
        const del = btn.createSpan({ cls: "air-apply-del", text: "✕" }); del.title = "取消该标注";
        del.onclick = async (e) => { e.preventDefault(); e.stopPropagation(); await this.plugin.annotator.removeByUids(this.source!.file, [(btn as any)._uid]); (btn as any)._uid = null; btn.removeClass("air-apply-done"); btn.setText(orig); };
        btn.onclick = (e) => { e.preventDefault(); this.navigateTo(block); };
      } else btn.setText("· 已存在");
    } catch (e: any) { btn.setText("✗ " + (e.message || "失败")); }
    finally { (btn as any)._busy = false; }
  }

  // --------------------------------------------------------- figure vision
  private async figureDataURI(block: Block): Promise<string> {
    if (!this.source) throw new Error("无文档");
    if (this.source.kind !== "md" || !block.src) throw new Error("该块不是可识读的图片。");
    let src = block.src;
    if (/^https?:\/\//i.test(src)) return src; // external URL → pass through
    const dest = this.app.metadataCache.getFirstLinkpathDest(src, this.source.path);
    if (!dest) throw new Error("找不到图片：" + src);
    const buf = await this.app.vault.readBinary(dest);
    const b64 = arrayBufferToBase64(buf);
    const ext = (dest.extension || "png").toLowerCase();
    const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "gif" ? "image/gif" : ext === "webp" ? "image/webp" : "image/png";
    return "data:" + mime + ";base64," + b64;
  }
  private async figureDigest(maxFigs: number): Promise<string> {
    const blocks = (this.source && this.source.blocks) || [];
    const figs = blocks.filter((b) => (b.type === "image") && b.src).slice(0, maxFigs);
    if (!figs.length) return "";
    const out: string[] = [];
    for (const b of figs) {
      try {
        const uri = await this.figureDataURI(b);
        const vm = this.plugin.llm.buildVisionMessages(this.plugin.llm.fmt(), this.lang(), "一句话说明这张图展示了什么、关键结论。", uri);
        const ans = await this.plugin.llm.callLLM(vm);
        out.push("[B" + b.id + " " + locLabel(b) + "] 图：" + (ans || "").trim().replace(/\s+/g, " "));
      } catch (e) {}
    }
    return out.length ? "【图表视觉摘要】\n" + out.join("\n") + "\n\n" : "";
  }
  private async explainFigure(block: Block) {
    if (!this.requireKey()) return;
    this.appendUser("看图解释 " + locLabel(block));
    const { msg, bubble } = this.appendAssistant();
    bubble.setText("正在识图…");
    try {
      const uri = await this.figureDataURI(block);
      const idx = (this.source!.blocks || []).findIndex((b) => b.id === block.id);
      const around = (this.source!.blocks || []).slice(Math.max(0, idx - 2), idx + 3).map((b) => b.text).join("\n");
      const vm = this.plugin.llm.buildVisionMessages(this.plugin.llm.fmt(), this.lang(), "请结合语境解读这张" + figKind(block.type) + "：展示了什么、关键结论。附近文字：\n" + around, uri);
      const ans = await this.plugin.llm.callLLM(vm);
      bubble.empty(); await this.renderInto(bubble, ans); this.addActions(msg, ans, null);
      const hist = this.plugin.chatStore.get(this.source!.path)!; hist.push({ role: "user", content: "看图解释 " + locLabel(block) }); hist.push({ role: "assistant", content: ans });
      this.plugin.persist.saveChat(this.source!.path, hist).catch(() => {});
    } catch (e: any) { bubble.setText("看图失败: " + (e.message || e)); }
  }

  // --------------------------------------------------------------- model menu
  private toggleModelMenu() {
    if (this.modelMenu) { this.closeModelMenu(); return; }
    const menu = this.contentEl.createDiv("air-modelmenu");
    const fmtRow = menu.createDiv("air-fmtrow");
    const cur = this.plugin.settings.apiFormat;
    for (const [val, lbl] of [["auto", "auto"], ["chat", "chat"], ["responses", "responses"], ["anthropic", "claude"]] as [any, string][]) {
      const b = fmtRow.createEl("button", { cls: "air-fmt" + (cur === val ? " air-fmt-on" : ""), text: lbl });
      b.onclick = async (e) => { e.stopPropagation(); this.plugin.settings.apiFormat = val; await this.plugin.saveSettings(); this.updateModelPill(); this.closeModelMenu(); this.toggleModelMenu(); };
    }
    const listWrap = menu.createDiv("air-modellist");
    this.modelMenu = menu;
    this.populateModels(listWrap);
    const onDoc = (ev: MouseEvent) => { if (this.modelMenu && !this.modelMenu.contains(ev.target as Node) && ev.target !== this.modelPillEl) this.closeModelMenu(); };
    (this.modelMenu as any)._onDoc = onDoc;
    setTimeout(() => document.addEventListener("click", onDoc), 0);
  }
  private closeModelMenu() { if (this.modelMenu) { const od = (this.modelMenu as any)._onDoc; if (od) document.removeEventListener("click", od); this.modelMenu.remove(); this.modelMenu = null; } }
  private async populateModels(wrap: HTMLElement) {
    const render = (ids: string[]) => {
      wrap.empty(); const cur = this.plugin.settings.model;
      for (const id of ids) {
        const it = wrap.createDiv({ cls: "air-modelitem" + (id === cur ? " air-modelitem-on" : ""), text: id });
        it.onclick = async (e) => { e.stopPropagation(); this.plugin.settings.model = id; await this.plugin.saveSettings(); this.updateModelPill(); this.closeModelMenu(); };
      }
    };
    if (this.modelList) { render(this.modelList); return; }
    wrap.setText("加载模型中…");
    try { const ids = await this.plugin.llm.fetchModels(); this.modelList = ids; if (ids.length) render(ids); else wrap.setText("未获取到模型列表"); }
    catch (e: any) { wrap.setText("加载失败: " + (e.message || e)); }
  }

  // --------------------------------------------------------------- misc ops
  private clear() {
    if (!this.source) return;
    const path = this.source.path;
    this.plugin.chatStore.set(path, []);
    this.plugin.liveStore.delete(path);          // reset continuous context
    this.plugin.readStore.delete(path);
    this.plugin.figStore.delete(path);
    this.plugin.histSummary.delete(path);
    this.plugin.persist.saveChat(path, []).catch(() => {});
    this.msgsEl.empty(); this.setStatus("已清空对话。", "muted");
  }

  // ---- continuous agentic context (live model-facing history + compaction) ----
  private isUserTurn(m: any): boolean { return m && m.role === "user" && typeof m.content === "string"; }
  private liveChars(messages: ChatMessage[]): number {
    let n = 0;
    for (const m of messages) { try { n += (typeof m.content === "string" ? m.content : JSON.stringify(m.content || m)).length; } catch (e) {} }
    return n;
  }
  private ensureLive(path: string, fmt: string): ChatMessage[] {
    let e = this.plugin.liveStore.get(path);
    if (!e || e.fmt !== fmt) {
      const hist = this.plugin.chatStore.get(path) || [];
      const messages = hist.filter((m) => m && m.role && typeof m.content === "string").map((m) => ({ role: m.role, content: m.content } as ChatMessage));
      e = { fmt, messages };
      this.plugin.liveStore.set(path, e);
    }
    return e.messages;
  }
  private rollbackLiveToLastUser(convo: ChatMessage[]) {
    let lastU = -1;
    for (let i = convo.length - 1; i >= 0; i--) if (this.isUserTurn(convo[i])) { lastU = i; break; }
    if (lastU >= 0) convo.splice(lastU + 1);
  }
  private async compactLive(path: string, convo: ChatMessage[]): Promise<ChatMessage[]> {
    const TRIGGER = 120000, KEEPCHARS = 60000;
    if (this.liveChars(convo) < TRIGGER) return convo;
    const bounds: number[] = [];
    for (let i = 0; i < convo.length; i++) if (this.isUserTurn(convo[i])) bounds.push(i);
    if (bounds.length < 2) return convo;
    let cut = bounds[bounds.length - 1];
    for (let bi = bounds.length - 1; bi >= 1; bi--) {
      if (this.liveChars(convo.slice(bounds[bi])) > KEEPCHARS) { cut = bounds[bi + 1] != null ? bounds[bi + 1] : cut; break; }
      cut = bounds[bi];
    }
    const older = convo.slice(0, cut);
    if (!older.length) return convo;
    this.setStatus("整理上下文…", "busy");
    try {
      const sum = await this.plugin.llm.callLLM([
        { role: "system", content: "把下面这段『阅读对话 + 工具读取』压缩成要点笔记，务必保留：已读过哪些章节及其关键内容与数据、已识读的图表结论、用户问过/关注的问题、已得出的结论。简洁中文、分条，便于后续继续引用，避免重复读取。" },
        { role: "user", content: this.turnsToText(older) },
      ]);
      const note: ChatMessage = { role: "user", content: "【早期阅读与对话摘要（供连续参考，无需重复读取已覆盖的章节/图表）】\n" + (sum || "").trim() };
      const next = [note].concat(convo.slice(cut));
      const e = this.plugin.liveStore.get(path); if (e) e.messages = next;
      return next;
    } catch (e) { return convo; }
  }
  private turnsToText(messages: ChatMessage[]): string {
    const out: string[] = [];
    for (const m of messages) {
      if (this.isUserTurn(m)) { out.push("用户：" + m.content); continue; }
      if (m.role === "assistant" && typeof m.content === "string") { if (m.content.trim()) out.push("助手：" + m.content); continue; }
      if (m.role === "tool") { out.push("（工具结果：" + String(m.content || "").slice(0, 1200) + "）"); continue; }
      if ((m as any).type === "function_call") { out.push("（调用 " + (m as any).name + "）"); continue; }
      if ((m as any).type === "function_call_output") { out.push("（工具结果：" + String((m as any).output || "").slice(0, 1200) + "）"); continue; }
      if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b.type === "text") out.push((m.role === "user" ? "" : "助手：") + b.text);
          else if (b.type === "tool_use") out.push("（调用 " + b.name + "）");
          else if (b.type === "tool_result") out.push("（工具结果：" + String(b.content || "").slice(0, 1200) + "）");
        }
      }
    }
    return out.join("\n");
  }
  private async saveNote() {
    if (!this.source) return;
    const hist = this.plugin.chatStore.get(this.source.path) || [];
    if (!hist.length) { this.setStatus("没有可保存的对话。", "muted"); return; }
    try {
      const f = await saveConversationToNote(this.app, this.source.file, hist, this.plugin.settings.model);
      this.setStatus("已存为笔记：" + f.basename, "ok");
    } catch (e: any) { this.setStatus("存笔记失败: " + (e.message || e), "error"); }
  }

  // Compact long histories into a rolling summary (ported _compactHistory).
  private async compactHistory(path: string, hist: ChatMessage[]) {
    const KEEP = 12, TRIGGER = 20;
    if (!hist || hist.length < TRIGGER) return;
    const older = hist.splice(0, hist.length - KEEP);
    const prev = this.plugin.histSummary.get(path) || "";
    const convo = older.map((m) => (m.role === "user" ? "用户：" : "助手：") + m.content).join("\n");
    try {
      const sum = await this.plugin.llm.callLLM([
        { role: "system", content: "把以下对话压缩成要点笔记：保留已得出的结论、用户已问过的问题、表达过的偏好。简洁中文，分条。" },
        { role: "user", content: (prev ? "已有要点：\n" + prev + "\n\n新增对话：\n" : "") + convo },
      ]);
      this.plugin.histSummary.set(path, (sum || "").trim());
    } catch (e) { hist.unshift(...older); }
  }

  // called by the selection popup / commands to quote into the composer
  quoteIntoComposer(text: string) {
    const q = "关于这段原文：\n“" + text + "”\n\n我的问题是：";
    this.inputEl.value = q;
    this.inputEl.style.height = "auto"; this.inputEl.style.height = Math.min(140, this.inputEl.scrollHeight) + "px";
    this.inputEl.focus();
    try { this.inputEl.setSelectionRange(q.length, q.length); } catch (e) {}
  }
  activeBlocks(): Block[] { return (this.source && this.source.blocks) || []; }
  activePath(): string | null { return this.source ? this.source.path : null; }
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  let binary = ""; const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)) as any);
  return btoa(binary);
}
