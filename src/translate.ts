/* Full-text bilingual translation — turn the whole document into a paragraph-by
 * -paragraph bilingual doc (original + translation interleaved). Competitors:
 * selection-translate (zotero-pdf-translate), layout-preserving dual PDF
 * (pdf2zh/BabelDOC), and inline bilingual (Immersive Translate). We do the last,
 * lightweight: reuse our block split + streaming, output a bilingual Markdown
 * note/file. Pure logic here (prompt + numbered-segment parse + interleave) so
 * it's unit-testable; view.ts wires blocks, batching, streaming, file/note I/O. */
import { Block } from "./types";

export function buildTranslatePrompt(targetLang: string): string {
  return "你是专业学术翻译。只翻译「待翻译」区里带编号的段落，翻译成" + targetLang + "。严格要求：\n" +
    "- 逐段翻译，输出每段一行，格式为 [[n]] 译文（n 为原段编号）；不要输出原文、不要加任何说明或标题。\n" +
    "- 「上文」「下文」区仅供理解上下文与保持术语一致，绝对不要翻译它们、也不要为它们编号输出。\n" +
    "- 段落编号必须与「待翻译」区一一对应，不得漏段、合并或拆分。\n" +
    "- 保留数学公式、变量符号、文献引用标记（如 [12]、(Smith et al., 2024)）、以及英文专有名词/模型名/缩写原样（如 Transformer、RLHF、LoRA）。\n" +
    "- 忠实、通顺，符合" + targetLang + "科技写作习惯，前后术语保持一致。";
}

// Context window around a batch: tail of the previous units + head of the next,
// as read-only "上文/下文" so cross-boundary references & terminology stay
// consistent even though batches translate concurrently. `ctxUnits` is how many
// neighbor paragraphs to include on each side.
export function batchPayload(batch: TransUnit[], prevUnits: TransUnit[], nextUnits: TransUnit[]): string {
  const parts: string[] = [];
  const prev = prevUnits.map((u) => u.text).join("\n\n").trim();
  const next = nextUnits.map((u) => u.text).join("\n\n").trim();
  if (prev) parts.push("【上文（仅供理解，不要翻译）】\n" + prev);
  parts.push("【待翻译（只翻译下列带编号段落）】\n" + numberSegments(batch));
  if (next) parts.push("【下文（仅供理解，不要翻译）】\n" + next);
  return parts.join("\n\n");
}

// Given all units split into contiguous batches, return the neighbor context for
// batch i: up to `ctx` units before its first and after its last.
export function neighborContext(units: TransUnit[], batches: TransUnit[][], i: number, ctx: number): { prev: TransUnit[]; next: TransUnit[] } {
  const first = batches[i][0], last = batches[i][batches[i].length - 1];
  const a = units.findIndex((u) => u.n === first.n);
  const b = units.findIndex((u) => u.n === last.n);
  return { prev: units.slice(Math.max(0, a - ctx), a), next: units.slice(b + 1, b + 1 + ctx) };
}

export interface TransUnit { n: number; text: string; heading: boolean; }

// Pick the translatable units (paragraphs + headings) from blocks, in order,
// each tagged with a stable 1-based segment number.
export function translatableUnits(blocks: Block[]): TransUnit[] {
  const out: TransUnit[] = [];
  let n = 0;
  for (const b of blocks || []) {
    if ((b.type === "paragraph" || b.type === "heading") && b.text && b.text.trim()) {
      out.push({ n: ++n, text: b.text.trim(), heading: b.type === "heading" });
    }
  }
  return out;
}

// Split units into batches under a char budget so each LLM call stays fast and
// progress is granular.
export function batchUnits(units: TransUnit[], maxChars: number): TransUnit[][] {
  const batches: TransUnit[][] = [];
  let cur: TransUnit[] = [], total = 0;
  for (const u of units) {
    const len = u.text.length + 8;
    if (cur.length && total + len > maxChars) { batches.push(cur); cur = []; total = 0; }
    cur.push(u); total += len;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

// The numbered-segment payload sent to the model for one batch.
export function numberSegments(units: TransUnit[]): string {
  return units.map((u) => "[[" + u.n + "]] " + u.text).join("\n\n");
}

// Parse the model's "[[n]] translation" reply into n → translation. Tolerant of
// extra prose and multi-line translations (a segment runs until the next [[m]]).
export function parseTranslations(text: string): Map<number, string> {
  const map = new Map<number, string>();
  const re = /\[\[(\d+)\]\]/g;
  const hits: { n: number; start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text || ""))) hits.push({ n: parseInt(m[1], 10), start: m.index, end: m.index + m[0].length });
  for (let i = 0; i < hits.length; i++) {
    const seg = (text || "").slice(hits[i].end, i + 1 < hits.length ? hits[i + 1].start : undefined).trim();
    if (seg) map.set(hits[i].n, seg);
  }
  return map;
}

// Interleave originals with translations into a bilingual Markdown doc. Headings
// stay as headings; each paragraph is followed by its translation in a
// blockquote. Missing translations fall back to original-only.
export function interleaveBilingual(title: string, units: TransUnit[], trans: Map<number, string>): string {
  const lines: string[] = [];
  if (title) lines.push("# " + title + "（双语对照）", "");
  for (const u of units) {
    const t = trans.get(u.n);
    if (u.heading) {
      lines.push("## " + u.text);
      if (t) lines.push("## " + t);
      lines.push("");
    } else {
      lines.push(u.text);
      if (t) lines.push("", "> " + t.replace(/\n+/g, "\n> "));
      lines.push("");
    }
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}
