/* Document model. The Zotero plugin extracts blocks from a PDF's structured
 * text (page + coordinates). Here the primary source is a Markdown note parsed
 * into blocks carrying line numbers + character offsets (for scroll-to and for
 * wrapping when we annotate). PDF text extraction lives in pdf.ts. */
import { Block, Section } from "./types";

// Split text into sentence-ish chunks with char offsets (ported verbatim).
export function splitSentences(text: string): { text: string; start: number; end: number }[] {
  const out: { text: string; start: number; end: number }[] = [];
  const re = /[^.!?。！？]*[.!?。！？]+|[^.!?。！？]+$/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[0] === "") { re.lastIndex++; continue; }
    out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  }
  const merged: { text: string; start: number; end: number }[] = [];
  for (const s of out) {
    const t = s.text.trim();
    if (merged.length && (t.length < 20 || /^[a-z0-9)\]]/.test(t))) {
      const p = merged[merged.length - 1]; p.text += s.text; p.end = s.end;
    } else merged.push({ text: s.text, start: s.start, end: s.end });
  }
  return merged.length ? merged : [{ text, start: 0, end: text.length }];
}

const norm = (t: string) => t.replace(/\s+/g, " ").trim();
const clip = (t: string) => (t.length > 2000 ? t.slice(0, 2000) + "…" : t);

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}
function lineAt(starts: number[], offset: number): number {
  // binary search: last start <= offset
  let lo = 0, hi = starts.length - 1, ans = 0;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (starts[mid] <= offset) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return ans;
}

const IMG_EMBED = /^!\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]\s*$/;
const IMG_MD = /^!\[[^\]]*\]\(([^)]+)\)\s*$/;
const HEADING = /^(#{1,6})\s+\S/;

// Parse a Markdown document into blocks. Paragraphs are split into sentence-
// level blocks (each with its own char range) so citations / highlights can
// target a single sentence, mirroring the Zotero sentence-level blocks.
export function parseMarkdownBlocks(text: string): Block[] {
  const starts = lineStarts(text);
  const blocks: Block[] = [];
  const ref = { id: 0 };
  const push = (type: Block["type"], raw: string, startOffset: number, endOffset: number, src?: string) => {
    const t = clip(norm(raw));
    if (!t && type !== "image") return;
    const line = lineAt(starts, startOffset);
    blocks.push({ id: ref.id++, type, text: t, startOffset, endOffset, line, endLine: lineAt(starts, Math.max(startOffset, endOffset - 1)), src, pageLabel: String(line + 1) });
  };

  const lines = text.split("\n");
  let i = 0;
  let offset = 0;
  const lineLen = (s: string) => s.length + 1; // +1 for the stripped "\n"

  while (i < lines.length) {
    const line = lines[i];
    const lineStart = offset;

    // fenced code
    const fence = line.match(/^(\s*)(`{3,}|~{3,})/);
    if (fence) {
      const marker = fence[2][0];
      let j = i + 1; let end = offset + lineLen(line);
      while (j < lines.length) { end += lineLen(lines[j]); if (new RegExp("^\\s*" + marker + "{3,}\\s*$").test(lines[j])) { j++; break; } j++; }
      push("code", text.slice(lineStart, Math.min(end, text.length)), lineStart, Math.min(end, text.length));
      for (let k = i; k < j; k++) offset += lineLen(lines[k]);
      i = j; continue;
    }

    // math block $$ ... $$
    if (/^\s*\$\$/.test(line)) {
      let j = i; let end = offset;
      // single-line $$...$$
      if (/\$\$.*\$\$\s*$/.test(line) && line.trim() !== "$$") { end = offset + lineLen(line); j = i + 1; }
      else { end += lineLen(line); j = i + 1; while (j < lines.length) { end += lineLen(lines[j]); if (/\$\$\s*$/.test(lines[j])) { j++; break; } j++; } }
      push("math", text.slice(lineStart, Math.min(end, text.length)), lineStart, Math.min(end, text.length));
      for (let k = i; k < j; k++) offset += lineLen(lines[k]);
      i = j; continue;
    }

    // heading
    if (HEADING.test(line)) {
      push("heading", line.replace(/^#{1,6}\s+/, ""), lineStart + (line.length - line.replace(/^#{1,6}\s+/, "").length), offset + line.length);
      offset += lineLen(line); i++; continue;
    }

    // standalone image
    const me = line.match(IMG_EMBED) || line.match(IMG_MD);
    if (me) {
      push("image", line.trim(), lineStart, offset + line.length, me[1].trim());
      offset += lineLen(line); i++; continue;
    }

    // table: row + delimiter
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /\|/.test(lines[i + 1]) && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && /-/.test(lines[i + 1])) {
      let j = i; let end = offset;
      while (j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j])) { end += lineLen(lines[j]); j++; }
      push("table", text.slice(lineStart, Math.min(end, text.length)), lineStart, Math.min(end, text.length));
      for (let k = i; k < j; k++) offset += lineLen(lines[k]);
      i = j; continue;
    }

    // blank line
    if (!line.trim()) { offset += lineLen(line); i++; continue; }

    // paragraph: accumulate consecutive non-blank, non-special lines
    let j = i; let pEnd = offset;
    while (j < lines.length) {
      const lj = lines[j];
      if (!lj.trim()) break;
      if (HEADING.test(lj) || /^\s*(`{3,}|~{3,})/.test(lj) || /^\s*\$\$/.test(lj) || IMG_EMBED.test(lj) || IMG_MD.test(lj)) break;
      pEnd += lineLen(lj); j++;
    }
    const pStart = lineStart;
    const rawEnd = Math.min(pEnd, text.length);
    const raw = text.slice(pStart, rawEnd).replace(/\n+$/, "");
    const rawTrimmedEnd = pStart + raw.length;
    // sentence-level split within the paragraph's raw substring
    for (const sent of splitSentences(raw)) {
      const s = pStart + sent.start, e = pStart + sent.end;
      if (!norm(sent.text)) continue;
      push("paragraph", sent.text, s, Math.min(e, rawTrimmedEnd));
    }
    for (let k = i; k < j; k++) offset += lineLen(lines[k]);
    i = j;
  }
  return blocks;
}

export function figKind(type: string): string { return type === "image" ? "图" : type === "table" ? "表" : "公式"; }

export function figIndex(blocks: Block[]): string {
  const figs: string[] = [];
  for (const b of blocks) {
    if ((b.type === "image" || b.type === "table" || b.type === "math") && hasLoc(b)) {
      figs.push("[B" + b.id + " " + locLabel(b) + "] " + figKind(b.type) + (b.text ? ": " + b.text.slice(0, 60) : ""));
    }
  }
  return figs.length ? "\n\nFigures/tables/formulas index:\n" + figs.slice(0, 80).join("\n") : "";
}

// Group blocks into sections by preceding heading (ported from _buildSections).
export function buildSections(blocks: Block[]): Section[] {
  const sections: Section[] = []; let cur: Section | null = null;
  const start = (title: string, page: string) => { cur = { index: 0, title, page, blockIds: [] }; sections.push(cur); };
  for (const b of blocks || []) {
    if (b.type === "heading") { start((b.text || "（无标题）").slice(0, 80), b.pageLabel); continue; }
    if (b.type === "image" || b.type === "math") continue;
    if (!hasLoc(b) || !b.text) continue;
    if (!cur) start("前言 / 摘要", b.pageLabel);
    cur.blockIds.push(b.id);
  }
  const kept = sections.filter((s) => s.blockIds.length);
  kept.forEach((s, i) => { s.index = i; });
  return kept;
}

// A block is "locatable" (can be cited/jumped/annotated) if it has a position.
export function hasLoc(b: Block): boolean {
  return (b.startOffset != null && b.endOffset != null) || b.page != null;
}

// Badge label: "L12" for a markdown line, "p7" for a PDF page.
export function locLabel(b: Block): string {
  if (b.page != null) return "p" + (b.pageLabel || b.page);
  return "L" + (b.pageLabel || (b.line != null ? b.line + 1 : "?"));
}
