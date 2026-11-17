import { Plugin, WorkspaceLeaf } from "obsidian";
import { AIReaderSettings, DEFAULT_SETTINGS, Block, ChatMessage } from "./types";
import { LLM } from "./llm";
import { Annotator } from "./annotate";
import { Persist } from "./persist";
import { AIReaderView, VIEW_TYPE } from "./view";
import { AIReaderSettingTab } from "./settings";
import { registerSelectionUI } from "./popup";

export default class AIReaderPlugin extends Plugin {
  settings!: AIReaderSettings;
  llm!: LLM;
  annotator!: Annotator;
  persist!: Persist;

  // in-memory stores keyed by file path (ported from the AIReader object fields)
  chatStore: Map<string, ChatMessage[]> = new Map();
  blockStore: Map<string, Block[]> = new Map();
  histSummary: Map<string, string> = new Map();
  panels: Map<string, AIReaderView> = new Map();
  deepRead = false;

  async onload() {
    await this.loadSettings();
    this.llm = new LLM(() => this.settings);
    this.annotator = new Annotator(this.app);
    this.persist = new Persist(this.app, this.manifest.id);

    this.registerView(VIEW_TYPE, (leaf: WorkspaceLeaf) => new AIReaderView(leaf, this));
    this.addRibbonIcon("bot", "AI Reader", () => this.activateView());
    this.addSettingTab(new AIReaderSettingTab(this.app, this));

    this.addCommand({ id: "open-panel", name: "打开 AI Reader 面板", callback: () => this.activateView() });
    this.addCommand({ id: "summarize", name: "总结当前文档", callback: async () => { const v = await this.activateView(); v?.send("请分【研究问题 / 方法 / 主要发现 / 结论与意义 / 局限】五部分，结构化总结这篇文档。", { broad: true }); } });
    this.addCommand({ id: "agent-annotate", name: "通读并标注全文", callback: async () => { const v = await this.activateView(); v?.agentAnnotate(); } });

    registerSelectionUI(this);
  }

  onunload() { this.panels.clear(); }

  async activateView(): Promise<AIReaderView | null> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = null;
    const existing = workspace.getLeavesOfType(VIEW_TYPE);
    if (existing.length) leaf = existing[0];
    else { leaf = workspace.getRightLeaf(false); await leaf?.setViewState({ type: VIEW_TYPE, active: true }); }
    if (leaf) workspace.revealLeaf(leaf);
    const view = leaf && (leaf.view as AIReaderView);
    if (view) await (view as any).refresh?.();
    return view || null;
  }

  async loadSettings() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); }
  async saveSettings() { await this.saveData(this.settings); }
}
