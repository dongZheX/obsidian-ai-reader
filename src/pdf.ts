/* Best-effort PDF support (secondary). Obsidian has no public PDF structured-
 * text / annotation API, so we read text from the open viewer's pdf.js document.
 * PDF blocks carry a page number only (no char range) — so they can be cited and
 * jumped to by page, but NOT highlighted/written back (that's Markdown-only). */
import { Block } from "./types";
import { splitSentences } from "./source";

export function isPdfView(view: any): boolean {
  return !!(view && view.getViewType && view.getViewType() === "pdf");
}

function pdfDocumentOf(view: any): any {
  try { return view.viewer && view.viewer.child && view.viewer.child.pdfViewer && view.viewer.child.pdfViewer.pdfViewer && view.viewer.child.pdfViewer.pdfViewer.pdfDocument; } catch (e) {}
  try { return view.viewer.child.pdfViewer.pdfDocument; } catch (e) {}
  return null;
}
function pdfViewerOf(view: any): any {
  try { return view.viewer.child.pdfViewer.pdfViewer; } catch (e) {}
  try { return view.viewer.child.pdfViewer; } catch (e) {}
  return null;
}

export async function extractPdfBlocks(view: any): Promise<Block[]> {
  const doc = pdfDocumentOf(view);
  if (!doc || typeof doc.getPage !== "function") throw new Error("无法读取该 PDF 的文本（请用内置 PDF 阅读器打开）。");
  const blocks: Block[] = [];
  let id = 0;
  const n = doc.numPages || 0;
  for (let p = 1; p <= n; p++) {
    let pageText = "";
    try {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      pageText = (tc.items || []).map((it: any) => it.str + (it.hasEOL ? "\n" : " ")).join("");
    } catch (e) { continue; }
    const norm = pageText.replace(/[ \t]+/g, " ").trim();
    if (!norm) continue;
    for (const sent of splitSentences(norm)) {
      const t = sent.text.replace(/\s+/g, " ").trim();
      if (!t) continue;
      blocks.push({ id: id++, type: "paragraph", text: t.length > 2000 ? t.slice(0, 2000) + "…" : t, page: p, pageLabel: String(p) });
    }
  }
  if (!blocks.length) throw new Error("该 PDF 没有可提取的文本（可能是扫描件）。");
  return blocks;
}

export function pdfGoToPage(view: any, page: number) {
  const pv = pdfViewerOf(view);
  try { if (pv) pv.currentPageNumber = page; } catch (e) {}
}
