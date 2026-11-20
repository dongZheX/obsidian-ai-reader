import { App, PluginSettingTab, Setting } from "obsidian";
import { httpText } from "./net";
import type AIReaderPlugin from "./main";

export class AIReaderSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: AIReaderPlugin) { super(app, plugin); }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    const save = () => this.plugin.saveSettings();

    containerEl.createEl("h2", { text: "AI Reader" });

    new Setting(containerEl)
      .setName("API format").setDesc("auto 按模型名自动判断；或手动指定")
      .addDropdown((d) => d
        .addOption("auto", "Auto (by model name)")
        .addOption("chat", "OpenAI /chat/completions")
        .addOption("responses", "OpenAI /responses")
        .addOption("anthropic", "Anthropic /messages")
        .setValue(s.apiFormat)
        .onChange(async (v) => { s.apiFormat = v as any; await save(); }));

    new Setting(containerEl)
      .setName("Base URL").setDesc("根端点；裸域名会补 /v1，http 会升级为 https")
      .addText((t) => t.setPlaceholder("https://api.openai.com/v1").setValue(s.baseURL)
        .onChange(async (v) => { s.baseURL = v.trim(); await save(); }));

    new Setting(containerEl)
      .setName("API Key")
      .addText((t) => { t.setValue(s.apiKey).onChange(async (v) => { s.apiKey = v.trim(); await save(); }); t.inputEl.type = "password"; });

    new Setting(containerEl)
      .setName("Model")
      .addText((t) => t.setPlaceholder("gpt-4o-mini").setValue(s.model)
        .onChange(async (v) => { s.model = v.trim(); await save(); }));

    new Setting(containerEl)
      .setName("Output language").setDesc("回复语言")
      .addDropdown((d) => d.addOption("中文", "中文").addOption("English", "English").addOption("日本語", "日本語")
        .setValue(s.language).onChange(async (v) => { s.language = v; await save(); }));

    new Setting(containerEl)
      .setName("Temperature")
      .addText((t) => t.setValue(String(s.temperature)).onChange(async (v) => { s.temperature = v.trim(); await save(); }));

    new Setting(containerEl)
      .setName("Max characters sent").setDesc("注入正文的字符上限")
      .addText((t) => t.setValue(String(s.maxChars)).onChange(async (v) => { const n = parseInt(v, 10); s.maxChars = isNaN(n) ? 60000 : n; await save(); }));

    new Setting(containerEl)
      .setName("Max output tokens").setDesc("0 = 不限制（避免摘要被截断）")
      .addText((t) => t.setValue(String(s.maxTokens)).onChange(async (v) => { const n = parseInt(v, 10); s.maxTokens = isNaN(n) ? 0 : n; await save(); }));

    new Setting(containerEl)
      .setName("Serper API Key").setDesc("web search 用（serper.dev）。留空则只有 web_fetch，没有 web_search。")
      .addText((t) => { t.setPlaceholder("serper.dev — web_search 必填").setValue(s.serperKey).onChange(async (v) => { s.serperKey = v.trim(); await save(); }); t.inputEl.type = "password"; });

    new Setting(containerEl)
      .setName("Max parallel tools").setDesc("只读工具（读章节/看图/联网）的并发数；设为 1 可强制串行")
      .addText((t) => t.setValue(String(s.maxParallelTools)).onChange(async (v) => { const n = parseInt(v, 10); s.maxParallelTools = isNaN(n) || n < 1 ? 3 : n; await save(); }));

    new Setting(containerEl)
      .setName("Custom prompt").setDesc("附加到系统提示的自定义要求（不会覆盖引用/工具/画图规则）")
      .addTextArea((t) => { t.setPlaceholder("例如：多用例子；术语保留英文…").setValue(s.customPrompt).onChange(async (v) => { s.customPrompt = v; await save(); }); t.inputEl.rows = 3; t.inputEl.style.width = "100%"; });

    new Setting(containerEl)
      .setName("同步对话记录").setDesc("把每篇对话额外写到库内文件夹，随库同步（Obsidian Sync / iCloud / git）在多台机器间恢复。关闭则只存本地缓存。")
      .addToggle((t) => t.setValue(s.syncChats).onChange(async (v) => { s.syncChats = v; await save(); }));
    new Setting(containerEl)
      .setName("同步文件夹").setDesc("库内存放同步副本的文件夹（相对库根目录）")
      .addText((t) => t.setValue(s.syncFolder).onChange(async (v) => { s.syncFolder = (v || "").trim() || "AI Reader/chats"; await save(); }));

    const test = new Setting(containerEl).setName("Test connection");
    const result = test.descEl.createSpan({ text: "" });
    test.addButton((b) => b.setButtonText("Test").onClick(async () => {
      result.setText("…"); result.style.color = "";
      try {
        const txt = await this.runTest();
        result.setText(txt); result.style.color = "var(--text-success)";
      } catch (e: any) { result.setText(String(e.message || e)); result.style.color = "var(--text-error)"; }
    }));
  }

  private async runTest(): Promise<string> {
    const llm = this.plugin.llm;
    const base = llm.normBase();
    if (!base) throw new Error("Base URL 为空");
    const s = this.plugin.settings;
    if (!s.apiKey) throw new Error("API Key 为空");
    const fmt = llm.fmt();
    const msgs = [{ role: "user", content: "ping" }];
    let url: string, body: any;
    if (fmt === "responses") { url = base + "/responses"; body = { model: s.model, input: msgs, max_output_tokens: 16, stream: false }; }
    else if (fmt === "anthropic") { url = base + "/messages"; body = { model: s.model, messages: msgs, max_tokens: 16, stream: false }; }
    else { url = base + "/chat/completions"; body = { model: s.model, messages: msgs, max_tokens: 16, stream: false }; }
    const resp = await httpText(url, { method: "POST", headers: llm.headersFor(fmt), body: JSON.stringify(body) }, { retries: 0 });
    if (!resp.ok) throw new Error("HTTP " + resp.status + " @ " + url + "\n" + resp.text.slice(0, 600));
    let data: any; try { data = JSON.parse(resp.text); } catch (e) { throw new Error("响应不是 JSON @ " + url + "\n" + resp.text.slice(0, 600)); }
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
    return "OK · " + (data.model || s.model || "连通") + " · " + fmt;
  }
}
