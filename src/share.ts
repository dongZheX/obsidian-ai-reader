/* Share-material generator — turn the open paper into something you can present:
 * a one-page summary (Markdown) or a rich standalone HTML explainer. The HTML
 * recipe (component system + CSS) is ported from the `tech-html-explainer`
 * skill (~/.claude/skills/tech-html-explainer), run through our own LLM
 * pipeline with the paper's OWN figures embedded. Pure logic lives here so it's
 * unit-testable; view.ts wires context, streaming, figure resolver, file I/O. */

export type ShareFormatId = "onepager" | "html";

export interface ShareFormat {
  id: ShareFormatId;
  label: string;
  desc: string;
  ext: string;              // file extension for the saved artifact
  buildSystemPrompt(lang: string): string;
}

const STYLE = // keep the restrained, human-sounding voice the rest of the plugin uses
  "语言：中文为主，专有名词/模型名/指标名/英文缩写保留原文（如 LoRA、RLHF、in-context）。" +
  "审美上避免 AI 套路：不空话套话、不堆排比、不用装饰性加粗、不滥用 emoji、不要升华式结尾。";

export const SHARE_FORMATS: Record<ShareFormatId, ShareFormat> = {
  onepager: {
    id: "onepager", label: "一页总结", desc: "结构化 Markdown，适合存笔记", ext: "md",
    buildSystemPrompt: (lang) =>
      "你是论文分享助手，用" + lang + "把这篇论文浓缩成一页可分享的总结（Markdown）。按以下结构，每节具体、给数字、别空泛：\n" +
      "# 标题\n**一句话 TL;DR**（这篇到底做了什么、结论是什么）\n" +
      "## 背景与问题（它针对什么痛点）\n## 核心贡献（分条，每条一句话说清“新在哪”）\n" +
      "## 方法（关键设计与直觉，必要时给维度/公式）\n## 关键结果（引用具体数字与对比；相关图表用 [[fig:<id>]] 指出）\n" +
      "## 局限与开放问题\n## 一句话评价（值不值得读、适合谁）\n" +
      "要求：基于论文，关键论断后用 [B<id>] 标注依据；不臆造。" + STYLE,
  },
  html: {
    id: "html", label: "HTML 分享页", desc: "图文并茂单文件网页，嵌入本文图表", ext: "html",
    buildSystemPrompt: (lang) =>
      "你是论文分享助手，用" + lang + "把这篇论文做成一页**图文并茂、可直接分享**的技术讲解网页。只输出 <body> 内部的 HTML 片段（不要写 <html>/<head>/<body>/<style>，外层样式与配色已备好，请直接使用下列 class）。\n\n" +
      "【必备结构，按顺序】\n" +
      "1. `<header>`：论文标题 + 一句话副标题（TL;DR）+ 若干 `<span class=\"tag\">关键词</span>`。\n" +
      "2. `<div class=\"toc\"><ul><li><a href=\"#s1\">…</a></li>…</ul></div>`：目录，锚点对应各章节。\n" +
      "3. 每章一个 `<section id=\"s1\">`，`<h2>` 带序号标题；正文用 `<h3>`、`<p>`、`<ul>`。章节建议：背景与问题 / 核心方法 / 关键结果 / 对比与讨论 / 局限 / 速问速答。\n\n" +
      "【组件（直接用这些 class，样式已定义）】\n" +
      "- 方法/流程示意：优先输出 ```svg 手绘图（根 <svg> 带 viewBox、不要固定像素宽高，框线+箭头+文字标注），放进 `<div class=\"svg-wrap\">…<div class=\"caption\">图N·说明</div></div>`。\n" +
      "- 展示论文自己的图表：用 `[[fig:<id>]]` 占位（<id> 为正文里的图/表块号），会被自动替换成真实图片（已包好卡片），**请在确有相关图表时使用，优先放关键结果图**。\n" +
      "- 维度/数据流推演：`<div class=\"dim\">[B, N, d] → …</div>`。\n" +
      "- 优缺点：`<div class=\"pros-cons\"><div class=\"pros\"><h4>优点</h4><ul>…</ul></div><div class=\"cons\"><h4>局限</h4><ul>…</ul></div></div>`。\n" +
      "- 横向对比：`<table>`（有多个方法/设置时用，带表头）。\n" +
      "- 关键术语：`<span class=\"highlight\">…</span>`。\n" +
      "- 速问速答（放最后一章，≥5 条，覆盖 why/how/trade-off）：`<div class=\"qa\"><div class=\"q\">问题</div><div class=\"a\">回答（带具体数字/方法）</div></div>`。\n\n" +
      "【质量要求】结果要引用论文里的**具体数字**；关键论断后可用 [B<id>]；不臆造、图表不编造；" + STYLE,
  },
};

export function shareFormatList(): ShareFormat[] { return [SHARE_FORMATS.onepager, SHARE_FORMATS.html]; }

// ---- rich HTML built section-by-section (depth + per-section progress) ----
export interface ShareSection { id: string; title: string; brief: string; }
export interface ShareOutline { title: string; tldr: string; tags: string[]; sections: ShareSection[]; }

export function buildOutlinePrompt(lang: string): string {
  return "你是论文分享助手。读完论文后，规划一页图文并茂分享网页的结构。只输出一个 JSON 对象（不要 ``` 包裹、不要任何多余文字）：\n" +
    '{"title":"论文标题","tldr":"一句话说清这篇做了什么、结论是什么","tags":["关键词",3至6个],"sections":[{"id":"s1","title":"章节标题","brief":"这一章要覆盖哪些要点（一两句）"}]}\n' +
    "要求：6–8 个章节，建议顺序：背景与问题、核心方法、关键结果、对比与讨论、局限与未来、速问速答。标题用" + lang + "。只输出 JSON。";
}

// Robustly pull the outline JSON out of a model reply (tolerate ``` fences and
// surrounding prose). Returns null on anything malformed so the caller can fall
// back to single-shot generation.
export function parseOutline(text: string): ShareOutline | null {
  try {
    let t = (text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
    const a = t.indexOf("{"), b = t.lastIndexOf("}");
    if (a < 0 || b <= a) return null;
    const o = JSON.parse(t.slice(a, b + 1));
    if (!o || !Array.isArray(o.sections) || !o.sections.length) return null;
    const sections = o.sections
      .map((s: any, i: number) => ({ id: String(s.id || "s" + (i + 1)), title: String(s.title || "章节 " + (i + 1)), brief: String(s.brief || "") }))
      .filter((s: ShareSection) => s.title);
    if (!sections.length) return null;
    return { title: String(o.title || ""), tldr: String(o.tldr || ""), tags: Array.isArray(o.tags) ? o.tags.map(String).slice(0, 6) : [], sections };
  } catch (e) { return null; }
}

export function buildSectionPrompt(lang: string, section: ShareSection, figList: string): string {
  return "你是论文分享助手，用" + lang + "写分享网页中的**这一个章节**，只输出一个 <section> 元素（不要输出其它章节、不要 ``` 包裹、不要 <html>/<style>）。\n" +
    "章节 id=\"" + section.id + "\"，标题：" + section.title + "。要覆盖：" + (section.brief || section.title) + "。\n" +
    "格式：<section id=\"" + section.id + "\"><h2>" + section.title + "</h2> … </section>；正文用 <h3>/<p>/<ul>，内容要具体、充分展开，引用论文里的**具体数字**。\n" +
    "按内容需要选用组件（样式已定义，直接用 class）：维度/数据流 <div class=\"dim\">[B,N,d]→…</div>；优缺点 <div class=\"pros-cons\"><div class=\"pros\"><h4>优点</h4><ul>…</ul></div><div class=\"cons\"><h4>局限</h4><ul>…</ul></div></div>；多项对比用 <table>（带表头）；关键术语 <span class=\"highlight\">…</span>；流程/架构用 ```svg 手绘（根 <svg> 带 viewBox、不固定像素宽高）放进 <div class=\"svg-wrap\">…<div class=\"caption\">图N·说明</div></div>。\n" +
    "若本章是速问速答，用 <div class=\"qa\"><div class=\"q\">问题</div><div class=\"a\">回答（带具体数字/方法）</div></div>，≥5 条，覆盖 why/how/trade-off。\n" +
    "要展示论文自己的图表时用 [[fig:<id>]] 占位（会被替换成真实图片）。可用图表清单：\n" + (figList || "（无）") + "\n" +
    "关键论断后可用 [B<id>]；不臆造、图表不编造。" + STYLE;
}

const esc = (s: string) => (s || "").replace(/[<>&]/g, (c) => (c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;"));

export function buildHeaderHtml(o: ShareOutline): string {
  const tags = (o.tags || []).map((t) => '<span class="tag">' + esc(t) + "</span>").join("");
  return '<header><h1>' + esc(o.title || "论文分享") + "</h1>" + (o.tldr ? "<p>" + esc(o.tldr) + "</p>" : "") + tags + "</header>";
}
export function buildTocHtml(o: ShareOutline): string {
  return '<div class="toc"><ul>' + (o.sections || []).map((s) => '<li><a href="#' + esc(s.id) + '">' + esc(s.title) + "</a></li>").join("") + "</ul></div>";
}
// Strip a ```html … ``` or ``` … ``` wrapper the model may add around a section.
export function stripHtmlFence(s: string): string {
  return (s || "").trim().replace(/^```(?:html)?\s*/i, "").replace(/\s*```$/i, "").trim();
}
export function assembleShareHtml(o: ShareOutline, sectionHtmls: string[]): string {
  const footer = '<footer style="text-align:center;color:#7a8599;font-size:.85em;margin:8px 0 0;">由 AI Reader 生成</footer>';
  return buildHeaderHtml(o) + "\n" + buildTocHtml(o) + "\n" + sectionHtmls.join("\n") + "\n" + footer;
}

// Replace every [[fig:<id>]] placeholder with a real figure card using the
// resolver (returns a data URI / URL, or null/throws when unavailable → the
// placeholder is dropped, never left as a raw token). Async-safe.
export async function embedFigures(text: string, resolver: (id: number) => Promise<string | null> | string | null): Promise<string> {
  const re = /\[\[fig:B?(\d+)\]\]/g;
  const ids: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text || ""))) ids.push(parseInt(m[1], 10));
  const uriById = new Map<number, string>();
  for (const id of ids) {
    if (uriById.has(id)) continue;
    try { const u = await resolver(id); if (u) uriById.set(id, u); } catch (e) { /* skip */ }
  }
  return (text || "").replace(re, (_whole, g1) => {
    const uri = uriById.get(parseInt(g1, 10));
    return uri ? '<div class="paper-fig"><img src="' + uri + '" alt="figure ' + g1 + '"/><div class="caption">本文图表 ' + g1 + '</div></div>' : "";
  });
}

// Convert ```svg … ``` fences to inline <svg>; leave other code fences alone.
export function svgFencesToInline(html: string): string {
  return (html || "").replace(/```svg\s*([\s\S]*?)```/gi, (_w, body) => String(body).trim());
}

// Wrap a model-authored HTML fragment into a standalone, self-styled document.
export function wrapHtmlDoc(title: string, bodyHtml: string): string {
  const safeTitle = (title || "论文分享").replace(/[<>&]/g, (c) => (c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;"));
  return "<!DOCTYPE html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"UTF-8\"/>\n" +
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\"/>\n" +
    "<title>" + safeTitle + "</title>\n<style>\n" + SHARE_CSS + "\n</style>\n</head>\n<body>\n" +
    "<div class=\"container\">\n" + (bodyHtml || "") + "\n</div>\n</body>\n</html>\n";
}

// Ported from tech-html-explainer/assets/base.css (the user's own preferred
// look), plus a global svg rule and a dark-text tweak for readability.
const SHARE_CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
  line-height: 1.75; color: #2c3e50; background: linear-gradient(135deg,#f5f7fa 0%,#e8ecf3 100%); padding: 24px; min-height: 100vh; }
.container { max-width: 1180px; margin: 0 auto; }
header { background: linear-gradient(135deg,#667eea 0%,#764ba2 100%); color: #fff; padding: 50px 40px; border-radius: 18px;
  box-shadow: 0 12px 40px rgba(102,126,234,.35); margin-bottom: 28px; text-align: center; }
header h1 { font-size: 2.2em; margin-bottom: 12px; letter-spacing: .5px; }
header p { font-size: 1.06em; opacity: .95; }
.tag { display: inline-block; background: rgba(255,255,255,.22); padding: 4px 12px; border-radius: 20px; margin: 6px 5px 0; font-size: .86em; }
section { background: #fff; padding: 34px 40px; border-radius: 14px; box-shadow: 0 4px 22px rgba(0,0,0,.06); margin-bottom: 24px; }
h2 { font-size: 1.7em; color: #2c3e50; border-left: 5px solid #667eea; padding-left: 16px; margin-bottom: 20px; }
h3 { font-size: 1.28em; color: #34495e; margin: 22px 0 12px; } h3::before { content: '▸ '; color: #667eea; }
h4 { color: #667eea; margin: 16px 0 8px; font-size: 1.06em; }
p { margin-bottom: 12px; } ul,ol { padding-left: 22px; margin-bottom: 12px; } li { margin: 5px 0; }
code { background: #f4f6fa; color: #d63384; padding: 2px 7px; border-radius: 4px; font-family: 'SF Mono',Consolas,monospace; font-size: .92em; }
table { width: 100%; border-collapse: collapse; margin: 14px 0; font-size: .95em; }
th,td { padding: 10px 14px; text-align: left; border-bottom: 1px solid #e3e8f0; } th { background: #f4f6fa; font-weight: 600; } tr:hover td { background: #fafbfd; }
.pros-cons { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin: 16px 0; }
.pros,.cons { padding: 18px 22px; border-radius: 10px; } .pros { background: #e7f8ee; border-left: 4px solid #28a745; } .cons { background: #fdecea; border-left: 4px solid #e74c3c; }
.pros h4 { color: #28a745; margin-top: 0; } .cons h4 { color: #e74c3c; margin-top: 0; }
.qa { background: #fffaf0; border: 1px solid #ffe0b2; border-radius: 10px; padding: 16px 22px; margin: 14px 0; }
.qa .q { font-weight: 600; color: #d35400; margin-bottom: 8px; } .qa .q::before { content: 'Q: '; color: #e67e22; }
.qa .a { color: #34495e; padding-left: 12px; border-left: 3px solid #ffc107; } .qa .a::before { content: 'A: '; font-weight: 600; color: #27ae60; }
.highlight { background: linear-gradient(120deg,#fff9c4,#fff9c4) no-repeat; background-size: 100% 40%; background-position: 0 88%; padding: 0 3px; }
.dim { font-family: 'SF Mono',Consolas,monospace; font-size: .86em; background: #f8f9fc; border: 1px dashed #c9d2e0; padding: 12px 18px; border-radius: 8px; margin: 10px 0; white-space: pre-wrap; line-height: 1.7; color: #475569; }
.toc { background: #f4f6fa; border-radius: 10px; padding: 20px 28px; margin-bottom: 26px; } .toc ul { list-style: none; padding-left: 0; } .toc li { padding: 5px 0; border-bottom: 1px dashed #d6dce5; } .toc li:last-child { border-bottom: none; }
.toc a { color: #2c3e50; text-decoration: none; } .toc a:hover { color: #667eea; } .toc a::before { content: '◆ '; color: #667eea; font-size: .85em; }
.svg-wrap { background: #fff; border: 1px solid #e3e8f0; border-radius: 12px; padding: 18px; margin: 18px 0; overflow-x: auto; box-shadow: 0 2px 10px rgba(0,0,0,.04); }
.svg-wrap .caption { text-align: center; color: #7a8599; font-size: .88em; margin-top: 10px; font-style: italic; }
svg { display: block; margin: 0 auto; max-width: 100%; height: auto; }
.paper-fig { background: #fff; border: 1px solid #e3e8f0; border-radius: 12px; padding: 22px; margin: 18px 0; box-shadow: 0 2px 10px rgba(0,0,0,.04); }
.paper-fig img { display: block; max-width: 100%; height: auto; margin: 0 auto; border-radius: 6px; background: #fafbfd; }
.paper-fig .caption { text-align: center; color: #475569; font-size: .9em; margin-top: 12px; }
@media (max-width: 768px) { section { padding: 22px 18px; } .pros-cons { grid-template-columns: 1fr; } }
`.trim();
