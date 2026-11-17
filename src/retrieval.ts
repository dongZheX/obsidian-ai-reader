/* Context building & retrieval — ported from zotero-ai-reader. Uses locLabel()
 * instead of page numbers for the [B<id> …] line tags. */
import { Block } from "./types";
import { figIndex, locLabel } from "./source";

export function tokenize(s: string): string[] {
  const out: string[] = [];
  const low = (s || "").toLowerCase();
  const latin = low.match(/[a-z0-9]{2,}/g) || [];
  for (const w of latin) out.push(w);
  const cjk = (s || "").match(/[一-鿿]/g) || [];
  for (const c of cjk) out.push(c);
  return out;
}

const lineOf = (b: Block) => "[B" + b.id + " " + locLabel(b) + "] " + b.text;

// Full/broad context: sequential blocks until the char budget.
export function buildContext(blocks: Block[], maxChars: number): string {
  const lines: string[] = []; let total = 0;
  for (const b of blocks) {
    if (b.type === "image" || b.type === "math") continue;
    const line = lineOf(b);
    if (total + line.length > maxChars) break;
    lines.push(line); total += line.length + 1;
  }
  return lines.join("\n") + figIndex(blocks);
}

// Broad context that survives long papers: whole body if it fits, else head+tail.
export function buildContextBounded(blocks: Block[], maxChars: number): string {
  const text = (blocks || []).filter((b) => b.type !== "image" && b.type !== "math" && b.text);
  const all = text.map(lineOf);
  const sum = all.reduce((s, l) => s + l.length + 1, 0);
  if (sum <= maxChars) return all.join("\n") + figIndex(blocks);
  const headBudget = Math.floor(maxChars * 0.6), tailBudget = maxChars - headBudget;
  const head: string[] = []; let ht = 0;
  for (const b of text) { const l = lineOf(b); if (ht + l.length > headBudget) break; head.push(l); ht += l.length + 1; }
  const tail: string[] = []; let tt = 0;
  for (let i = text.length - 1; i >= 0; i--) { const l = lineOf(text[i]); if (tt + l.length > tailBudget) break; tail.unshift(l); tt += l.length + 1; }
  return head.join("\n") + "\n\n…（中间内容略，可在对话中追问细节）…\n\n" + tail.join("\n") + figIndex(blocks);
}

// Query-relevant context via TF-IDF retrieval.
export function buildRetrievedContext(blocks: Block[], query: string, maxChars: number): string {
  const qtok = tokenize(query);
  if (!qtok.length) return buildContext(blocks, maxChars);
  const textBlocks = blocks.filter((b) => b.type !== "image" && b.type !== "math" && b.text);
  const toks = textBlocks.map((b) => tokenize(b.text));
  const df = new Map<string, number>();
  for (const t of toks) for (const w of new Set(t)) df.set(w, (df.get(w) || 0) + 1);
  const N = textBlocks.length || 1;
  const qset = new Set(qtok);
  const scored = textBlocks.map((b, i) => {
    const tf = new Map<string, number>();
    for (const w of toks[i]) if (qset.has(w)) tf.set(w, (tf.get(w) || 0) + 1);
    let s = 0;
    for (const w of qset) if (tf.has(w)) s += (tf.get(w) as number) * Math.log(1 + N / ((df.get(w) || 0) + 1));
    return { id: b.id, s };
  });
  const chosen = new Set<number>();
  for (const b of blocks) if (b.type === "heading") chosen.add(b.id);
  scored.sort((a, b) => b.s - a.s);
  for (const { id, s } of scored) { if (s <= 0) break; chosen.add(id); }
  let bodyHits = 0;
  for (const b of blocks) if (chosen.has(b.id) && b.type !== "heading" && b.type !== "image" && b.type !== "math" && b.text) bodyHits++;
  if (bodyHits < 5) return buildContextBounded(blocks, maxChars);
  const lines: string[] = []; let total = 0;
  for (const b of blocks) {
    if (!chosen.has(b.id) || b.type === "image" || b.type === "math") continue;
    const line = lineOf(b);
    if (total + line.length > maxChars) break;
    lines.push(line); total += line.length + 1;
  }
  if (lines.length < 3) return buildContextBounded(blocks, maxChars);
  return lines.join("\n") + figIndex(blocks);
}
