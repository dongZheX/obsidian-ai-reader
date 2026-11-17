/* Render an assistant message with Obsidian's MarkdownRenderer (Markdown + math
 * + callouts), then turn our tokens into interactive elements:
 *   [B<id>]            -> location badge (click => navigate, hover => preview)
 *   [[hl:id]] / [[note:id|c]] -> "apply highlight/note" button
 *   [[fig:id]]         -> "view figure" button
 * Directive/citation tokens are swapped for private-use placeholders BEFORE
 * rendering (so Obsidian's parser can't mangle them, e.g. [[hl:B3]] as a
 * wikilink), then replaced with real elements afterwards. */
import { App, Component, MarkdownRenderer } from "obsidian";
import { Block } from "./types";
import { locLabel } from "./source";

export interface RenderCtx {
  app: App;
  component: Component;
  sourcePath: string;
  blocks: Block[];
  onNavigate: (b: Block) => void;
  onApply: (b: Block, kind: "hl" | "note", comment: string, btn: HTMLElement) => void;
  onFig: (b: Block) => void;
  onPreview?: (b: Block, ev: MouseEvent) => void;
  onPreviewOut?: () => void;
}

const PH_OPEN = "\uE000", PH_CLOSE = "\uE001";
const TOKEN_RE = /\[\[(hl|note|fig):B?(\d+)(?:\|([^\]]*))?\]\]|\[B\d+(?:\s*[,，、\-–]\s*B?\d+)*\]/g;

export interface Token { kind: "dir" | "cite"; dir?: "hl" | "note" | "fig"; id?: number; comment?: string; ids?: number[]; }

// Pure: replace our tokens with private-use placeholders and return the mapping.
// Exported so it can be unit-tested without a DOM.
export function maskTokens(text: string): { masked: string; tokens: Token[] } {
  const tokens: Token[] = [];
  const masked = (text || "").replace(TOKEN_RE, (m, dir, id, comment) => {
    let tok: Token;
    if (dir) tok = { kind: "dir", dir, id: Number(id), comment: comment || "" };
    else tok = { kind: "cite", ids: (m.match(/\d+/g) || []).map(Number) };
    tokens.push(tok);
    return PH_OPEN + (tokens.length - 1) + PH_CLOSE;
  });
  return { masked, tokens };
}

export async function renderAssistant(container: HTMLElement, text: string, ctx: RenderCtx): Promise<void> {
  container.empty();
  container.addClass("air-rich");
  const { masked, tokens } = maskTokens(text);

  await MarkdownRenderer.render(ctx.app, masked, container, ctx.sourcePath, ctx.component);
  swapPlaceholders(container, tokens, ctx);
  renderArtifacts(container);
}

// ---- model-drawn diagrams (svg / html) ----
// The model is steered (system prompt rule 6) to emit a ```svg block for
// flowcharts / architecture / timelines; here we replace that fenced block with
// the inline vector image, after a sanitize pass (strip script/iframe/on*/
// javascript: but keep <style> for fidelity). Ported from zotero-ai-reader's
// _renderArtifacts. Mermaid, if emitted, is left to Obsidian's native renderer.
const ARTIFACT_KIND: Record<string, "svg" | "html"> = { "language-svg": "svg", "language-xml": "svg", "language-html": "html" };

export function renderArtifacts(root: HTMLElement): void {
  let codes: NodeListOf<Element>;
  try { codes = root.querySelectorAll("pre > code"); } catch (e) { return; }
  Array.from(codes).forEach((code) => {
    let kind: "svg" | "html" | null = null;
    for (const cls of ((code.className || "") + "").split(/\s+/)) if (ARTIFACT_KIND[cls]) { kind = ARTIFACT_KIND[cls]; break; }
    if (!kind) return;
    const src = code.textContent || "";
    if (kind === "svg" && !/<svg[\s>]/i.test(src)) return;
    if (kind === "html" && !/[<&]/.test(src)) return;
    const pre = code.parentElement;
    if (!pre || !pre.parentElement) return;
    try {
      const wrap = document.createElement("div");
      wrap.className = "air-artifact air-artifact-" + kind;
      const parsed = new DOMParser().parseFromString(src, kind === "svg" ? "image/svg+xml" : "text/html");
      const nodes: Node[] = kind === "svg"
        ? (parsed.querySelector("svg") ? [parsed.querySelector("svg") as Node] : [])
        : Array.from(parsed.body.childNodes);
      for (const n of nodes) wrap.appendChild(document.importNode(n, true));
      sanitizeArtifact(wrap);
      if (wrap.childNodes.length) pre.parentElement.replaceChild(wrap, pre);
    } catch (e) { /* leave the source block on any failure */ }
  });
}

function sanitizeArtifact(root: HTMLElement): void {
  try {
    root.querySelectorAll("script,iframe,object,embed,link,meta,base,form,input,button,foreignObject").forEach((n) => n.remove());
    root.querySelectorAll("*").forEach((el) => {
      for (const a of Array.from(el.attributes)) {
        const n = a.name.toLowerCase();
        if (n.startsWith("on")) el.removeAttribute(a.name);
        if ((n === "href" || n === "src" || n === "xlink:href") && /^\s*javascript:/i.test(a.value)) el.removeAttribute(a.name);
      }
    });
  } catch (e) {}
}

function swapPlaceholders(root: HTMLElement, tokens: Token[], ctx: RenderCtx) {
  const byId = new Map(ctx.blocks.map((b) => [b.id, b]));
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];
  const re = new RegExp(PH_OPEN + "(\\d+)" + PH_CLOSE);
  let n: Node | null;
  while ((n = walker.nextNode())) { if (re.test((n as Text).nodeValue || "")) targets.push(n as Text); }
  for (const tn of targets) {
    const frag = doc.createDocumentFragment();
    const parts = (tn.nodeValue || "").split(new RegExp(PH_OPEN + "(\\d+)" + PH_CLOSE, "g"));
    // split keeps captured ids at odd indices
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 0) { if (parts[i]) frag.appendChild(doc.createTextNode(parts[i])); continue; }
      const tok = tokens[Number(parts[i])];
      if (!tok) continue;
      appendToken(frag, tok, byId, ctx);
    }
    tn.parentNode && tn.parentNode.replaceChild(frag, tn);
  }
}

function appendToken(frag: DocumentFragment, tok: Token, byId: Map<number, Block>, ctx: RenderCtx) {
  const doc = (ctx.component as any) && document;
  if (tok.kind === "cite") {
    let any = false;
    for (const id of tok.ids || []) {
      const b = byId.get(id);
      if (!b) continue;
      if (any) frag.appendChild(document.createTextNode(" "));
      const badge = document.createElement("a");
      badge.className = "air-ref";
      badge.textContent = locLabel(b);
      badge.onclick = (e) => { e.preventDefault(); ctx.onNavigate(b); };
      if (ctx.onPreview) { badge.onmouseenter = (e) => ctx.onPreview!(b, e as MouseEvent); badge.onmouseleave = () => ctx.onPreviewOut && ctx.onPreviewOut(); }
      frag.appendChild(badge);
      any = true;
    }
    if (!any) frag.appendChild(document.createTextNode("[B" + (tok.ids || []).join(",") + "]"));
    return;
  }
  const b = byId.get(tok.id as number);
  if (!b) return;
  if (tok.dir === "fig") { frag.appendChild(makeFigButton(b, ctx)); return; }
  frag.appendChild(makeApplyButton(b, tok.dir as "hl" | "note", tok.comment || "", ctx));
}

function makeApplyButton(block: Block, kind: "hl" | "note", comment: string, ctx: RenderCtx): HTMLElement {
  const btn = document.createElement("a");
  btn.className = "air-apply";
  const base = (kind === "note" ? "✎ 应用批注 " : "✎ 应用划线 ") + locLabel(block);
  btn.textContent = base;
  btn.title = (comment ? comment + "\n\n" : "") + block.text.slice(0, 160);
  btn.onclick = (e) => { e.preventDefault(); ctx.onApply(block, kind, comment, btn); };
  return btn;
}

function makeFigButton(block: Block, ctx: RenderCtx): HTMLElement {
  const btn = document.createElement("a");
  btn.className = "air-apply air-figbtn";
  btn.textContent = "🔍 看图 " + locLabel(block);
  btn.title = "把该图交给多模态模型识图";
  btn.onclick = (e) => { e.preventDefault(); ctx.onFig(block); };
  return btn;
}
