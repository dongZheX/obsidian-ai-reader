/* Writing AI highlights/notes INTO the Markdown note.
 *
 * Zotero created native PDF annotations. Here we wrap the target text in a
 * colour-coded <mark data-air="UID"> and append a hidden %%air:UID …%% comment.
 * Edits go through vault.process() so they're atomic and reflected in any open
 * editor (and undoable with Obsidian's own Ctrl+Z). Removal/undo is by UID. */
import { App, TFile } from "obsidian";
import { Block } from "./types";

export const HILITE_COLOR = "#ffd400";
export const CATEGORY_COLORS: Record<string, string> = {
  contribution: "#ffd400", // yellow
  method: "#5fb236",       // green
  result: "#2ea8e5",       // blue
  limitation: "#ff6666",   // red
  keyterm: "#a28ae5",      // purple
};
export const CATEGORY_LABELS: Record<string, string> = {
  contribution: "贡献", method: "方法", result: "结果", limitation: "局限", keyterm: "关键概念",
};
export function colorForCategory(cat?: string | null): string { return (cat && CATEGORY_COLORS[cat]) || HILITE_COLOR; }

function uid(): string { return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3); }
function esc(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

export interface ApplyItem { block: Block; comment?: string; color?: string; category?: string | null; }

export class Annotator {
  constructor(private app: App) {}

  private async edit(file: TFile, fn: (data: string) => string): Promise<void> {
    const vault: any = this.app.vault;
    if (typeof vault.process === "function") { await vault.process(file, fn); return; }
    const data = await this.app.vault.read(file);
    await this.app.vault.modify(file, fn(data));
  }

  // Locate the block's current text region in `data`, tolerant of whitespace
  // drift. Returns [start,end] or null. Prefers the recorded offset; if the
  // slice there doesn't look right, searches by a normalized needle.
  private locate(data: string, block: Block): [number, number] | null {
    const so = block.startOffset, eo = block.endOffset;
    if (so != null && eo != null && so < eo && eo <= data.length) {
      const slice = data.slice(so, eo);
      if (norm(slice) === norm(block.text) || slice.includes(block.text)) return [so, eo];
    }
    // fallback: search for the normalized sentence near the recorded offset
    const needle = block.text.trim();
    if (!needle) return null;
    const from = Math.max(0, (so || 0) - 200);
    let idx = data.indexOf(needle, from);
    if (idx < 0) idx = data.indexOf(needle);
    if (idx >= 0) return [idx, idx + needle.length];
    // last resort: whitespace-insensitive regex
    const re = new RegExp(needle.split(/\s+/).map(esc).join("\\s+"));
    const m = re.exec(data.slice(from)) || re.exec(data);
    if (m) { const base = (m.input === data ? 0 : from); return [base + m.index, base + m.index + m[0].length]; }
    return null;
  }

  private alreadyWrapped(data: string, start: number): boolean {
    // is this offset already inside an air <mark>? check the 220 chars before it
    const pre = data.slice(Math.max(0, start - 220), start);
    const lastOpen = pre.lastIndexOf("<mark");
    const lastClose = pre.lastIndexOf("</mark>");
    return lastOpen > lastClose && /data-air=/.test(pre.slice(lastOpen));
  }

  private wrap(inner: string, id: string, color: string, cat: string | null, comment: string): string {
    const cls = "air-hl" + (cat ? " air-" + cat : "");
    let out = '<mark class="' + cls + '" data-air="' + id + '" style="background:' + color + ';color:inherit">' + inner + "</mark>";
    if (comment) out += "%%air:" + id + " " + comment.replace(/%%/g, "%") + "%%";
    return out;
  }

  // Apply many annotations to a file in ONE write, splicing from the end so
  // earlier offsets stay valid. Returns the applied {uid, blockId,…} records.
  async applyMany(file: TFile, items: ApplyItem[]): Promise<{ uid: string; blockId: number; category: string | null; comment: string; color: string; pageLabel: string }[]> {
    const applied: { uid: string; blockId: number; category: string | null; comment: string; color: string; pageLabel: string }[] = [];
    await this.edit(file, (data) => {
      const edits: { start: number; end: number; text: string; rec: any }[] = [];
      for (const it of items) {
        const loc = this.locate(data, it.block);
        if (!loc) continue;
        const [s, e] = loc;
        if (this.alreadyWrapped(data, s)) continue; // idempotent
        const id = uid();
        const color = it.color || colorForCategory(it.category);
        const comment = (it.comment || "").trim();
        edits.push({ start: s, end: e, text: this.wrap(data.slice(s, e), id, color, it.category || null, comment), rec: { uid: id, blockId: it.block.id, category: it.category || null, comment, color, pageLabel: it.block.pageLabel } });
      }
      // dedupe overlapping ranges, apply end-first
      edits.sort((a, b) => b.start - a.start);
      let lastStart = Infinity;
      for (const ed of edits) {
        if (ed.end > lastStart) continue; // overlaps a later (already applied) edit
        data = data.slice(0, ed.start) + ed.text + data.slice(ed.end);
        applied.push(ed.rec);
        lastStart = ed.start;
      }
      return data;
    });
    applied.reverse();
    return applied;
  }

  async applyOne(file: TFile, block: Block, opts: { comment?: string; color?: string; category?: string | null }): Promise<{ uid: string } | null> {
    const recs = await this.applyMany(file, [{ block, comment: opts.comment, color: opts.color, category: opts.category }]);
    return recs.length ? { uid: recs[0].uid } : null;
  }

  // Remove the <mark data-air="UID"> wrapper(s) and their %%air:UID …%% note.
  async removeByUids(file: TFile, uids: string[]): Promise<number> {
    if (!uids.length) return 0;
    let removed = 0;
    await this.edit(file, (data) => {
      for (const id of uids) {
        const markRe = new RegExp('<mark[^>]*data-air="' + esc(id) + '"[^>]*>([\\s\\S]*?)<\\/mark>', "g");
        data = data.replace(markRe, (_m, inner) => { removed++; return inner; });
        const noteRe = new RegExp("\\s*%%air:" + esc(id) + "[\\s\\S]*?%%", "g");
        data = data.replace(noteRe, "");
      }
      return data;
    });
    return removed;
  }

  // Read the user's existing highlights/comments/callouts so the model can
  // answer "based on my highlights / summarize my notes".
  async getUserAnnotations(file: TFile): Promise<string[]> {
    const out: string[] = [];
    let data = "";
    try { data = await this.app.vault.read(file); } catch (e) { return out; }
    const lines = data.split("\n");
    lines.forEach((line, i) => {
      const loc = "[L" + (i + 1) + "] ";
      // ==highlight==
      let m: RegExpExecArray | null; const hl = /==([^=]+)==/g;
      while ((m = hl.exec(line)) !== null) out.push(loc + "“" + m[1].trim() + "”");
      // <mark>…</mark> that is NOT ours
      const mk = /<mark(?![^>]*data-air)[^>]*>([\s\S]*?)<\/mark>/g;
      while ((m = mk.exec(line)) !== null) out.push(loc + "“" + m[1].replace(/<[^>]+>/g, "").trim() + "”");
      // %%comment%% that is NOT ours
      const cm = /%%(?!air:)([^%]+)%%/g;
      while ((m = cm.exec(line)) !== null) out.push(loc + "批注：" + m[1].trim());
    });
    return out.filter((x) => x.length > 6).slice(0, 200);
  }
}

const norm = (t: string) => (t || "").replace(/\s+/g, " ").trim();
