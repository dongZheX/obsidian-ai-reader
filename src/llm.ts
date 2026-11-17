/* LLM provider layer — ported from zotero-ai-reader/content/aireader.js.
 * Supports OpenAI chat/completions, OpenAI responses, and Anthropic messages.
 * Transport goes through net.ts (requestUrl for JSON, Node https for streaming). */
import { AIReaderSettings, ApiFormat, ChatMessage, ToolCall } from "./types";
import { httpText, httpStreamLines } from "./net";

export interface UsageMeta { inTok?: number; outTok?: number; ctxChars?: number; }
export interface StreamResult { text: string; calls: ToolCall[]; }

export class LLM {
  constructor(private getSettings: () => AIReaderSettings) {}

  private s() { return this.getSettings(); }

  fmt(): ApiFormat {
    const f = (this.s().apiFormat || "auto").trim();
    if ((["chat", "responses", "anthropic"] as string[]).includes(f)) return f as ApiFormat; // explicit choice wins
    return this.autoFmt(this.s().model); // "auto" → pick by model name
  }

  // Pick an API format from the model name (ported from _autoFmt).
  autoFmt(model: string): ApiFormat {
    const m = (model || "").toLowerCase();
    if (/claude/.test(m)) return "anthropic";
    if (/\bgpt\b|gpt-|^o[1-9]|\bo[1-9]-|openai|davinci|text-(davinci|embedding)/.test(m)) return "responses";
    return "chat";
  }

  // bare host -> append /v1; upgrade remote http -> https (keep localhost http).
  normBase(): string {
    let b = (this.s().baseURL || "").trim().replace(/\/+$/, "");
    if (!b) return b;
    const m = b.match(/^http:\/\/([^/]+)/);
    if (m && !/^(localhost|127\.|0\.0\.0\.0|\[::1\]|\[?::1)/i.test(m[1])) b = b.replace(/^http:\/\//i, "https://");
    if (/^https?:\/\/[^/]+$/.test(b)) b += "/v1";
    return b;
  }

  endpointFor(fmt: ApiFormat): string {
    const base = this.normBase();
    if (!base) throw new Error("Base URL is not set.");
    if (fmt === "responses") return base + "/responses";
    if (fmt === "anthropic") return base + "/messages";
    return base + "/chat/completions";
  }

  headersFor(fmt: ApiFormat): Record<string, string> {
    const key = this.s().apiKey;
    if (fmt === "anthropic") return { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" };
    return { "Content-Type": "application/json", Authorization: "Bearer " + key };
  }

  private temp(): number { const t = parseFloat(this.s().temperature); return isNaN(t) ? 0.3 : t; }
  private maxTok(): number { const m = parseInt(String(this.s().maxTokens), 10); return isNaN(m) || m <= 0 ? 0 : m; }

  bodyFor(fmt: ApiFormat, messages: ChatMessage[], stream: boolean): string {
    const model = this.s().model, temp = this.temp(), maxTok = this.maxTok();
    if (fmt === "responses") {
      const body: any = { model, input: messages, temperature: temp, stream: !!stream };
      if (maxTok) body.max_output_tokens = maxTok;
      return JSON.stringify(body);
    }
    if (fmt === "anthropic") {
      const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
      const msgs = messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: m.content }));
      const body: any = { model, messages: msgs, max_tokens: maxTok || 32000, temperature: temp, stream: !!stream };
      if (system) body.system = system;
      return JSON.stringify(body);
    }
    const body: any = { model, messages, temperature: temp, stream: !!stream };
    if (maxTok) body.max_tokens = maxTok;
    if (stream) body.stream_options = { include_usage: true };
    return JSON.stringify(body);
  }

  // Tool-calling body (shaped per format).
  toolBody(fmt: ApiFormat, messages: ChatMessage[], tools: any[], stream: boolean): string {
    const model = this.s().model, temp = this.temp(), maxTok = this.maxTok();
    if (fmt === "anthropic") {
      const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
      const msgs = messages.filter((m) => m.role !== "system");
      const body: any = { model, messages: msgs, max_tokens: maxTok || 8000, temperature: temp, tools, stream: !!stream };
      if (system) body.system = system;
      return JSON.stringify(body);
    }
    if (fmt === "responses") {
      const body: any = { model, input: messages, temperature: temp, tools, tool_choice: "auto", stream: !!stream };
      if (maxTok) body.max_output_tokens = maxTok;
      return JSON.stringify(body);
    }
    const body: any = { model, messages, temperature: temp, tools, tool_choice: "auto", stream: !!stream };
    if (maxTok) body.max_tokens = maxTok;
    if (stream) body.stream_options = { include_usage: true };
    return JSON.stringify(body);
  }

  captureUsage(meta: UsageMeta, j: any) {
    const u = j.usage || (j.message && j.message.usage) || (j.response && j.response.usage);
    if (u) {
      if (u.prompt_tokens != null) meta.inTok = u.prompt_tokens;
      if (u.input_tokens != null) meta.inTok = u.input_tokens;
      if (u.completion_tokens != null) meta.outTok = u.completion_tokens;
      if (u.output_tokens != null) meta.outTok = u.output_tokens;
    }
  }

  extractContent(fmt: ApiFormat, data: any): string | undefined {
    if (fmt === "responses") {
      if (typeof data.output_text === "string") return data.output_text;
      if (Array.isArray(data.output)) return data.output.map((o: any) => Array.isArray(o.content) ? o.content.map((c: any) => c.text || "").join("") : "").join("");
      return undefined;
    }
    if (fmt === "anthropic") { if (Array.isArray(data.content)) return data.content.map((c: any) => c.text || "").join(""); return undefined; }
    const msg = data.choices && data.choices[0] && data.choices[0].message;
    return msg && msg.content;
  }

  streamDelta(fmt: ApiFormat, j: any): string {
    if (fmt === "responses") return (j.type && /output_text\.delta$/.test(j.type)) ? (j.delta || "") : "";
    if (fmt === "anthropic") return (j.type === "content_block_delta" && j.delta) ? (j.delta.text || "") : "";
    return (j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content) || "";
  }

  private parseOrThrow(raw: string): any {
    try { return JSON.parse(raw); }
    catch (e) { throw new Error("响应不是 JSON（Base URL 或 API 格式可能不对）。实际返回：\n" + (raw || "").slice(0, 1200)); }
  }
  private fail(status: number, raw: string): Error { return new Error("HTTP " + status + "\n" + (raw || "").slice(0, 1200)); }

  // -------- tool-call stream accumulation / parsing (ported) --------
  streamToolDelta(fmt: ApiFormat, j: any, tc: Record<number, any>) {
    if (fmt === "anthropic") {
      if (j.type === "content_block_start" && j.content_block && j.content_block.type === "tool_use") tc[j.index] = { id: j.content_block.id, name: j.content_block.name, args: "" };
      else if (j.type === "content_block_delta" && j.delta && j.delta.type === "input_json_delta" && tc[j.index]) tc[j.index].args += j.delta.partial_json || "";
      return;
    }
    if (fmt === "responses") {
      if (j.type === "response.output_item.added" && j.item && j.item.type === "function_call") tc[j.output_index] = { id: j.item.call_id || j.item.id, name: j.item.name, args: "" };
      else if (j.type === "response.function_call_arguments.delta" && tc[j.output_index]) tc[j.output_index].args += j.delta || "";
      return;
    }
    const arr = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.tool_calls;
    if (Array.isArray(arr)) for (const t of arr) { const i = t.index || 0; tc[i] = tc[i] || { id: "", name: "", args: "" }; if (t.id) tc[i].id = t.id; if (t.function) { if (t.function.name) tc[i].name = t.function.name; if (t.function.arguments) tc[i].args += t.function.arguments; } }
  }
  private safeJSON(s: any): any { if (s && typeof s === "object") return s; try { return JSON.parse(s || "{}"); } catch (e) { return {}; } }
  finalizeToolCalls(tc: Record<number, any>): ToolCall[] {
    return Object.keys(tc).sort((a, b) => +a - +b).map((k) => ({ id: tc[+k].id, name: tc[+k].name, args: this.safeJSON(tc[+k].args) })).filter((c) => c.name);
  }
  parseToolCalls(fmt: ApiFormat, data: any): { text: string; calls: ToolCall[]; raw: any } {
    if (fmt === "anthropic") {
      const content = Array.isArray(data.content) ? data.content : [];
      let text = ""; const calls: ToolCall[] = [];
      for (const c of content) { if (c.type === "text") text += c.text || ""; else if (c.type === "tool_use") calls.push({ id: c.id, name: c.name, args: c.input || {} }); }
      return { text, calls, raw: content };
    }
    if (fmt === "responses") {
      const out = Array.isArray(data.output) ? data.output : [];
      let text = ""; const calls: ToolCall[] = [];
      for (const o of out) { if (o.type === "function_call") calls.push({ id: o.call_id || o.id, name: o.name, args: this.safeJSON(o.arguments) }); else if (o.type === "message" && Array.isArray(o.content)) text += o.content.map((x: any) => x.text || "").join(""); }
      if (typeof data.output_text === "string" && data.output_text) text = data.output_text;
      return { text, calls, raw: out };
    }
    const msg = (data.choices && data.choices[0] && data.choices[0].message) || {};
    const calls = (msg.tool_calls || []).map((tc: any) => ({ id: tc.id, name: tc.function && tc.function.name, args: this.safeJSON(tc.function && tc.function.arguments) }));
    return { text: msg.content || "", calls, raw: msg };
  }
  pushAssistantToolTurn(fmt: ApiFormat, messages: ChatMessage[], parsed: { text?: string; calls?: ToolCall[] }) {
    const calls = parsed.calls || [], text = parsed.text || "";
    if (fmt === "anthropic") {
      const content: any[] = [];
      if (text) content.push({ type: "text", text });
      for (const c of calls) content.push({ type: "tool_use", id: c.id, name: c.name, input: c.args || {} });
      messages.push({ role: "assistant", content });
      return;
    }
    if (fmt === "responses") {
      if (text) messages.push({ role: "assistant", content: text });
      for (const c of calls) messages.push({ type: "function_call", call_id: c.id, name: c.name, arguments: JSON.stringify(c.args || {}) } as any);
      return;
    }
    const tool_calls = calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args || {}) } }));
    messages.push({ role: "assistant", content: text || null, tool_calls } as any);
  }
  pushToolResults(fmt: ApiFormat, messages: ChatMessage[], results: { id: string; name: string; output: string }[]) {
    if (fmt === "anthropic") { messages.push({ role: "user", content: results.map((r) => ({ type: "tool_result", tool_use_id: r.id, content: r.output })) }); return; }
    if (fmt === "responses") { for (const r of results) messages.push({ type: "function_call_output", call_id: r.id, output: r.output } as any); return; }
    for (const r of results) messages.push({ role: "tool", tool_call_id: r.id, content: r.output } as any);
  }

  // -------- requests --------
  async callLLM(messages: ChatMessage[]): Promise<string> {
    const fmt = this.fmt();
    const resp = await httpText(this.endpointFor(fmt), { method: "POST", headers: this.headersFor(fmt), body: this.bodyFor(fmt, messages, false) });
    if (!resp.ok) throw this.fail(resp.status, resp.text);
    const data = this.parseOrThrow(resp.text);
    if (data.error) throw new Error(typeof data.error === "string" ? data.error : (data.error.message || JSON.stringify(data.error)));
    const content = this.extractContent(fmt, data);
    if (typeof content !== "string") throw new Error("无法从响应中取出内容（" + fmt + "）。实际返回：\n" + resp.text.slice(0, 1200));
    return content;
  }

  async callLLMStream(messages: ChatMessage[], onDelta: (d: string) => void, shouldStop?: () => boolean, meta?: UsageMeta): Promise<string> {
    meta = meta || {};
    const fmt = this.fmt();
    let full = "";
    const stop = shouldStop || (() => false);
    await httpStreamLines(this.endpointFor(fmt), this.headersFor(fmt), this.bodyFor(fmt, messages, true), (line) => {
      const l = line.trim();
      if (!l || !l.startsWith("data:")) return;
      const payload = l.slice(5).trim();
      if (payload === "[DONE]") return;
      let j: any; try { j = JSON.parse(payload); } catch (e) { return; }
      if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
      this.captureUsage(meta!, j);
      const d = this.streamDelta(fmt, j);
      if (d) { full += d; onDelta(d); }
    }, stop);
    return full;
  }

  // Streamed turn that returns both the streamed text and any tool calls.
  async streamAnswer(messages: ChatMessage[], tools: any[], onDelta: (d: string) => void, shouldStop: () => boolean, meta?: UsageMeta): Promise<StreamResult> {
    meta = meta || {};
    const fmt = this.fmt();
    let text = ""; const tc: Record<number, any> = {};
    await httpStreamLines(this.endpointFor(fmt), this.headersFor(fmt), this.toolBody(fmt, messages, tools, true), (line) => {
      const l = line.trim();
      if (!l || !l.startsWith("data:")) return;
      const payload = l.slice(5).trim();
      if (payload === "[DONE]") return;
      let j: any; try { j = JSON.parse(payload); } catch (e) { return; }
      if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
      this.captureUsage(meta!, j);
      const d = this.streamDelta(fmt, j); if (d) { text += d; onDelta(d); }
      this.streamToolDelta(fmt, j, tc);
    }, shouldStop);
    return { text, calls: this.finalizeToolCalls(tc) };
  }

  // Non-streaming tool turn (used by the agent loop).
  async toolTurn(messages: ChatMessage[], tools: any[]): Promise<{ text: string; calls: ToolCall[]; raw: any }> {
    const fmt = this.fmt();
    const resp = await httpText(this.endpointFor(fmt), { method: "POST", headers: this.headersFor(fmt), body: this.toolBody(fmt, messages, tools, false) });
    if (!resp.ok) throw this.fail(resp.status, resp.text);
    const data = this.parseOrThrow(resp.text);
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
    return this.parseToolCalls(fmt, data);
  }

  async fetchModels(): Promise<string[]> {
    const base = this.normBase();
    if (!base) throw new Error("Base URL 未设置");
    const key = this.s().apiKey;
    if (!key) throw new Error("API Key 未设置");
    const resp = await httpText(base + "/models", { headers: { Authorization: "Bearer " + key, "x-api-key": key, "anthropic-version": "2023-06-01" } });
    if (!resp.ok) throw new Error("HTTP " + resp.status + " " + resp.text.slice(0, 160));
    const data = this.parseOrThrow(resp.text);
    const arr = Array.isArray(data.data) ? data.data : (Array.isArray(data) ? data : []);
    return arr.map((x: any) => (x && (x.id || x.name)) || x).filter((x: any) => typeof x === "string");
  }

  buildVisionMessages(fmt: ApiFormat, lang: string, prompt: string, dataURI: string): ChatMessage[] {
    const sys: ChatMessage = { role: "system", content: "你是学术论文阅读助手，看图并用" + lang + "解读，简明准确。" };
    if (fmt === "anthropic") {
      const b64 = dataURI.replace(/^data:image\/[a-z]+;base64,/, "");
      return [sys, { role: "user", content: [{ type: "text", text: prompt }, { type: "image", source: { type: "base64", media_type: "image/png", data: b64 } }] }];
    }
    return [sys, { role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: dataURI } }] }];
  }

  systemPrompt(ctx: string, lang: string): string {
    return "你是针对某一篇学术论文/笔记的阅读助手，用" + lang + "回答。正文按块给出，每块形如 [B<id> p<位置>] 文本。要求：\n" +
      "1) 回答必须基于给定正文；没涉及的就说没涉及。\n" +
      "2) 在每个关键论断后用 [B<id>] 标出依据的块（可多个），方便用户点回原文。\n" +
      "3) 当用户要求划线/标注，或你认为某处值得高亮时，可输出指令：划线用 [[hl:<id>]]，加批注用 [[note:<id>|批注内容]]。这些会渲染成按钮由用户一键应用到笔记。\n" +
      "4) 当用户想看某个图/表的视觉内容、或你需要看图才能准确解释时，输出 [[fig:<id>]]（id 为图/表块），会把该图交给多模态模型识图。\n" +
      "5) 若正文前附有【用户在笔记中的高亮与批注】，当用户问到『我的高亮/批注』时请优先结合这些内容回答。\n" +
      "6) 需要用图示说明（流程、架构、时间线、关系等）时，请输出一个 ```svg 代码块，会被内联渲染成矢量图。要点：用 <rect>/<text>/<line>/<path>/<polygon> 等手绘，给根 <svg> 设置 width/height 和 viewBox；框与文字不要重叠、箭头对齐、整体宽度不超过约 560；颜色柔和、克制，别套用 AI 默认审美（米色+衬线、紫蓝渐变、处处居中/圆角、无谓编号）；不要用 emoji。也可用 ```mermaid（Obsidian 原生渲染）。仅在确实有助于理解时才画。\n\n" +
      this.styleGuide() +
      this.customPromptBlock() +
      "正文内容：\n\n" + ctx;
  }

  // User-defined extra instructions from settings (appended, never replacing the
  // citation/tool/drawing rules). Ported from _customPrompt.
  customPromptBlock(): string {
    const c = (this.s().customPrompt || "").trim();
    return c ? "【用户自定义要求】（在不破坏上述引用/工具/画图规则的前提下遵循）\n" + c + "\n\n" : "";
  }

  // Style constraints so answers read human-written, not model-generic.
  // Distilled from the `sepia` humanizer skill's "signs of AI writing" rules,
  // plus Chinese sci-writing term handling. A plugin has no skills at runtime,
  // so the guidance lives in the system prompt.
  styleGuide(): string {
    return "【表达风格】像懂行的人跟同行说话：直接、具体、克制，别带 AI 腔。\n" +
      "- 先说结论，别铺垫；不要“让我们深入探讨 / 首先需要明确 / 综上所述”这类套路开场与升华式收尾，也别用“这不仅是 X，更是 Y”的句式或金句式独句结尾。\n" +
      "- 不堆排比和“三件套”，该列几点就列几点；少用破折号串句，多用短句和句号。\n" +
      "- 不用空话套话与夸大词（如“值得注意的是 / 不言而喻 / 彰显 / 赋能 / 生态 / 闭环 / 助力 / 至关重要 / 深刻洞察”），换成平实说法。\n" +
      "- 不写“专家认为 / 研究表明”这类空泛背书；有依据就用 [B<id>] 指向原文，没有就别编。\n" +
      "- 不用装饰性加粗和 emoji，小标题用普通短语；不复述问题，不说“希望对你有帮助”之类客套。\n" +
      "- 术语按中文科技写作习惯：模型名、指标名、英文缩写（如 SFT、RLHF、VQA、gold label/gold data）保留原文，不生硬直译——例如 gold 在“gold 数据 / 黄金标准”语境里别译成“黄金”；没有通行译名就保留英文并括注解释。\n" +
      "- 无论用哪种语言回答，都遵循以上风格，读起来像人写的，而不是模板。\n\n";
  }
}
