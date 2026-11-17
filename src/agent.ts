/* Tool-calling agent engine — ported from zotero-ai-reader. The schemas and the
 * tool-dispatch (list_sections / read_section / list_figures / view_figure /
 * highlight / finish) are platform-agnostic; the two side-effecting tools
 * (highlight, view_figure) are injected via ToolCtx so this module stays pure. */
import { ApiFormat, Block, Section } from "./types";
import { figKind } from "./source";
import { CATEGORY_LABELS, colorForCategory } from "./annotate";
import { urlHost } from "./websearch";

export interface ToolBlockSpec {
  label: string;
  cat?: string;
  brief?: string;
  outcome?: string;
  bodyText?: string;
  jumpId?: number;
}
export interface ToolResult { output: string; render: ToolBlockSpec; finish?: boolean; }

export interface ToolCtx {
  sections: Section[];
  byId: Map<number, Block>;
  blocks: Block[];
  run: { keys: string[]; applied: any[] };
  tally: Record<string, number>;
  reads: number;
  // platform ops:
  highlight: (block: Block, cat: string, reason: string) => Promise<{ uid: string } | null>;
  viewFigure: (block: Block) => Promise<string>;
  serper?: boolean;
  webSearch?: (query: string, num?: number) => Promise<{ title: string; link: string; snippet: string }[]>;
  webFetch?: (url: string) => Promise<{ title: string; text: string }>;
}

// `opts.serper` gates web_search (only offered when a Serper key is set, so the
// model doesn't waste turns on a tool it can't use). web_fetch is always on.
export function agentTools(opts?: { serper?: boolean }) {
  const T: any[] = [
    { name: "list_sections", description: "列出文档的章节大纲（标题、位置、句子数）。先调用它了解结构。", parameters: { type: "object", properties: {}, required: [] } },
    { name: "read_section", description: "读取某一章节的全部句子，返回每句的 id、位置、文本。index 来自 list_sections。", parameters: { type: "object", properties: { index: { type: "integer", description: "章节序号" } }, required: ["index"] } },
    { name: "highlight", description: "在笔记里高亮某一句并加一句话批注。id 必须来自 read_section 返回的 id。", parameters: { type: "object", properties: { id: { type: "integer" }, category: { type: "string", enum: ["contribution", "method", "result", "limitation", "keyterm"] }, reason: { type: "string", description: "一句话理由（作为批注）" } }, required: ["id", "category"] } },
    { name: "list_figures", description: "列出文档中的图/表（id、位置、标题）。想看某张图就先用它找到 id。", parameters: { type: "object", properties: {}, required: [] } },
    { name: "view_figure", description: "查看某张图/表的视觉内容：用多模态模型识读，返回图的文字描述。id 来自 list_figures。", parameters: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] } },
  ];
  if (opts && opts.serper) {
    T.push({ name: "web_search", description: "联网搜索（Google via Serper）。当文档之外的背景、最新进展、术语定义、相关工作需要外部信息时使用。返回标题、链接、摘要。", parameters: { type: "object", properties: { query: { type: "string", description: "搜索关键词" }, num: { type: "integer", description: "返回条数，默认 6，最多 10" } }, required: ["query"] } });
  }
  T.push({ name: "web_fetch", description: "抓取某个网页 URL 并返回其正文文本（已去除导航/脚本）。常配合 web_search 使用：先搜索拿到链接，再抓取需要细读的页面。", parameters: { type: "object", properties: { url: { type: "string", description: "http(s) 网址" } }, required: ["url"] } });
  T.push({ name: "finish", description: "读完并标注完后调用，结束。", parameters: { type: "object", properties: { note: { type: "string" } }, required: [] } });
  return T;
}

export function toolSchemas(fmt: ApiFormat, opts?: { serper?: boolean }) {
  const T = agentTools(opts);
  if (fmt === "anthropic") return T.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  if (fmt === "responses") return T.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters }));
  return T.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

import { locLabel } from "./source";

export async function execTool(c: ToolCtx, call: { name: string; args: any }): Promise<ToolResult> {
  const name = call.name, args = call.args || {};
  if (name === "list_sections") {
    return { output: JSON.stringify(c.sections.map((s) => ({ index: s.index, title: s.title, page: s.page, sentences: s.blockIds.length }))),
      render: { label: "列出章节", outcome: "→ " + c.sections.length + " 节", bodyText: c.sections.map((s) => "[" + s.index + "] " + s.title + "  (" + s.blockIds.length + " 句)").join("\n") } };
  }
  if (name === "read_section") {
    c.reads = (c.reads || 0) + 1;
    const s = c.sections[args.index];
    if (!s) return { output: JSON.stringify({ error: "no such section " + args.index }), render: { label: "读取章节", brief: "index " + args.index, outcome: "✕ 无此节" } };
    const lines: any[] = []; let total = 0;
    for (const id of s.blockIds) { const b = c.byId.get(id); if (!b) continue; lines.push({ id: b.id, loc: locLabel(b), text: b.text }); total += (b.text || "").length; if (total > 9000) break; }
    return { output: JSON.stringify(lines), render: { label: "读取章节", brief: s.title, outcome: "→ " + lines.length + " 句", bodyText: lines.map((l) => "[B" + l.id + " " + l.loc + "] " + l.text).join("\n") } };
  }
  if (name === "highlight") {
    const b = c.byId.get(args.id);
    if (!b) return { output: JSON.stringify({ error: "no such sentence id " + args.id }), render: { label: "高亮", brief: "id " + args.id, outcome: "✕ 无此句" } };
    const cat = args.category || "keyterm";
    const r = await c.highlight(b, cat, args.reason || "");
    if (!r) return { output: JSON.stringify({ ok: true, note: "already highlighted" }), render: { label: "高亮", cat, brief: (CATEGORY_LABELS[cat] || cat), outcome: "· 已存在", jumpId: b.id } };
    c.run.keys.push(r.uid);
    c.run.applied.push({ uid: r.uid, category: cat, blockId: b.id, pageLabel: b.pageLabel, comment: args.reason || "", color: colorForCategory(cat) });
    c.tally[cat] = (c.tally[cat] || 0) + 1;
    return { output: JSON.stringify({ ok: true, uid: r.uid }), render: { label: "高亮", cat, brief: (CATEGORY_LABELS[cat] || cat) + (args.reason ? " · " + args.reason : ""), outcome: locLabel(b), jumpId: b.id } };
  }
  if (name === "list_figures") {
    const figs = c.blocks.filter((b) => (b.type === "image" || b.type === "table"));
    return { output: JSON.stringify(figs.map((f) => ({ id: f.id, loc: locLabel(f), kind: figKind(f.type), caption: (f.text || "").slice(0, 80) }))),
      render: { label: "列出图表", outcome: "→ " + figs.length + " 个", bodyText: figs.map((f) => "[B" + f.id + " " + locLabel(f) + "] " + figKind(f.type) + (f.text ? ": " + f.text.slice(0, 60) : "")).join("\n") || "（无图表）" } };
  }
  if (name === "view_figure") {
    const b = c.byId.get(args.id);
    if (!b) return { output: JSON.stringify({ error: "no such figure id " + args.id }), render: { label: "看图", brief: "id " + args.id, outcome: "✕ 无此图" } };
    try {
      const desc = (await c.viewFigure(b)).trim();
      return { output: JSON.stringify({ description: desc }), render: { label: "看图", brief: figKind(b.type) + " " + locLabel(b), outcome: "→ 已识读", bodyText: desc, jumpId: b.id } };
    } catch (e: any) { return { output: JSON.stringify({ error: String(e.message || e) }), render: { label: "看图", brief: locLabel(b), outcome: "✕ 失败" } }; }
  }
  if (name === "web_search") {
    const q = (args.query || "").trim();
    if (!q) return { output: JSON.stringify({ error: "empty query" }), render: { label: "联网搜索", outcome: "✕ 空查询" } };
    if (!c.webSearch) return { output: JSON.stringify({ error: "web_search unavailable" }), render: { label: "联网搜索", outcome: "✕ 未配置" } };
    try {
      const results = await c.webSearch(q, args.num);
      return { output: JSON.stringify(results), render: { label: "联网搜索", brief: q, outcome: "→ " + results.length + " 条", bodyText: results.map((r, i) => (i + 1) + ". " + r.title + "\n   " + r.link + "\n   " + (r.snippet || "")).join("\n") || "（无结果）" } };
    } catch (e: any) { return { output: JSON.stringify({ error: String(e.message || e) }), render: { label: "联网搜索", brief: q, outcome: "✕ 失败" } }; }
  }
  if (name === "web_fetch") {
    const url = (args.url || "").trim();
    if (!/^https?:\/\//i.test(url)) return { output: JSON.stringify({ error: "url must start with http(s)://" }), render: { label: "抓取网页", brief: url || "(空)", outcome: "✕ 非法 URL" } };
    if (!c.webFetch) return { output: JSON.stringify({ error: "web_fetch unavailable" }), render: { label: "抓取网页", outcome: "✕ 未配置" } };
    try {
      const { title, text } = await c.webFetch(url);
      return { output: JSON.stringify({ url, title, text }), render: { label: "抓取网页", brief: urlHost(url), outcome: "→ " + text.length + " 字", bodyText: (title ? title + "\n\n" : "") + text.slice(0, 2000) } };
    } catch (e: any) { return { output: JSON.stringify({ error: String(e.message || e) }), render: { label: "抓取网页", brief: urlHost(url), outcome: "✕ 失败" } }; }
  }
  if (name === "finish") return { output: JSON.stringify({ ok: true }), render: { label: "完成", outcome: "✓" }, finish: true };
  return { output: JSON.stringify({ error: "unknown tool " + name }), render: { label: name, outcome: "✕ 未知工具" } };
}
