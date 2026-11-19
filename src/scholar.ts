/* Scholarly discovery — ported from zotero-ai-reader's scholar helpers.
 * Semantic Scholar (keyless) for the citation graph; Google Scholar via the
 * user's Serper key for keyword search. Transport is net.ts httpText (Obsidian
 * requestUrl, no CORS). Results are kept small and errors are soft (S2's
 * anonymous pool throttles under load) so the model can fall back. */
import { httpText } from "./net";

export interface ScholarPaper {
  title: string; authors: string[]; year: number | null; venue: string;
  citations: number | null; doi: string; arxiv: string; url: string;
  pdf?: string; info?: string; abstract: string;
}

const S2 = "https://api.semanticscholar.org";
const S2_FIELDS = "title,authors,year,venue,citationCount,externalIds,url";
const idCache = new Map<string, string>(); // seed → S2-usable id

async function s2Get(path: string): Promise<any> {
  const resp = await httpText(S2 + path, { method: "GET", headers: { Accept: "application/json" } }, { timeoutMs: 20000, retries: 1 });
  if (resp.status === 429 || resp.status === 503) throw new Error("Semantic Scholar 暂时限流，稍后再试");
  if (!resp.ok) throw new Error("Semantic Scholar HTTP " + resp.status);
  try { return JSON.parse(resp.text); } catch (e) { throw new Error("Semantic Scholar 响应不是 JSON"); }
}

export function normS2(p: any): ScholarPaper | null {
  if (!p) return null;
  const ids = p.externalIds || {};
  return {
    title: p.title || "(无标题)",
    authors: (p.authors || []).map((a: any) => a && a.name).filter(Boolean),
    year: p.year || null, venue: p.venue || "",
    citations: p.citationCount != null ? p.citationCount : null,
    doi: ids.DOI || "", arxiv: ids.ArXiv || "",
    url: ids.ArXiv ? "https://arxiv.org/abs/" + ids.ArXiv : (p.url || (ids.DOI ? "https://doi.org/" + ids.DOI : "")),
    abstract: p.abstract || "",
  };
}

// Turn a query/DOI/arXiv/title into an id the S2 graph endpoints accept.
export async function resolveId(q: string): Promise<string> {
  q = (q || "").trim();
  if (!q) throw new Error("无法确定论文（缺少标题/DOI）");
  if (idCache.has(q)) return idCache.get(q)!;
  let id: string;
  if (/^10\.\d{4,9}\//.test(q) || /doi\.org\//i.test(q)) id = "DOI:" + q.replace(/^.*doi\.org\//i, "").trim();
  else {
    const am = /(\d{4}\.\d{4,5})(v\d+)?$/.exec(q);
    if (/arxiv/i.test(q) && am) id = "ARXIV:" + am[1];
    else {
      const j = await s2Get("/graph/v1/paper/search/match?query=" + encodeURIComponent(q) + "&fields=title");
      const hit = j && j.data && j.data[0];
      if (!hit || !hit.paperId) throw new Error("没有找到匹配的论文：" + q);
      id = hit.paperId;
    }
  }
  idCache.set(q, id);
  return id;
}

export async function scholarSearchSerper(serperKey: string, query: string, num = 8): Promise<ScholarPaper[]> {
  const key = (serperKey || "").trim();
  if (!key) throw new Error("未配置 Serper Key");
  const n = Math.max(1, Math.min(20, num || 10));
  const resp = await httpText("https://google.serper.dev/scholar",
    { method: "POST", headers: { "X-API-KEY": key, "Content-Type": "application/json" }, body: JSON.stringify({ q: query, num: n }) },
    { timeoutMs: 20000, retries: 1 });
  if (!resp.ok) throw new Error("Serper HTTP " + resp.status);
  let data: any; try { data = JSON.parse(resp.text); } catch (e) { throw new Error("Serper 响应不是 JSON"); }
  return (data.organic || []).map((r: any) => ({
    title: r.title || "", url: r.link || "", year: r.year || null,
    citations: r.citedBy != null ? r.citedBy : null, pdf: r.pdfUrl || "",
    info: r.publicationInfo || "", abstract: r.snippet || "", authors: [], venue: "", doi: "", arxiv: "",
  } as ScholarPaper));
}

export async function lookupPaper(serperKey: string, query: string): Promise<{ source: string; results: ScholarPaper[] }> {
  const q = (query || "").trim();
  if (!q) throw new Error("没有可查的论文（请给标题/DOI/arXiv，或先打开一篇论文）");
  const hasKey = !!(serperKey || "").trim();
  const isId = /^10\.\d{4,9}\//.test(q) || /arxiv/i.test(q);
  if (hasKey && !isId) return { source: "scholar", results: await scholarSearchSerper(serperKey, q, 8) };
  const j = await s2Get("/graph/v1/paper/search?query=" + encodeURIComponent(q) + "&limit=8&fields=" + S2_FIELDS + ",abstract");
  return { source: "s2", results: (j.data || []).map(normS2).filter(Boolean) as ScholarPaper[] };
}

export async function findReferences(query: string): Promise<ScholarPaper[]> {
  const id = await resolveId(query);
  const j = await s2Get("/graph/v1/paper/" + encodeURIComponent(id) + "/references?limit=25&fields=" + S2_FIELDS);
  return (j.data || []).map((d: any) => normS2(d.citedPaper)).filter(Boolean) as ScholarPaper[];
}

export async function relatedPapers(query: string): Promise<{ related: ScholarPaper[]; citedBy: ScholarPaper[] }> {
  const id = await resolveId(query);
  let related: ScholarPaper[] = [], citedBy: ScholarPaper[] = [];
  try { const r = await s2Get("/recommendations/v1/papers/forpaper/" + encodeURIComponent(id) + "?limit=12&fields=" + S2_FIELDS); related = (r.recommendedPapers || []).map(normS2).filter(Boolean) as ScholarPaper[]; } catch (e) { /* soft */ }
  try { const c = await s2Get("/graph/v1/paper/" + encodeURIComponent(id) + "/citations?limit=15&fields=" + S2_FIELDS); citedBy = (c.data || []).map((d: any) => normS2(d.citingPaper)).filter(Boolean) as ScholarPaper[]; } catch (e) { /* soft */ }
  if (!related.length && !citedBy.length) throw new Error("没有找到相关/后续论文");
  return { related, citedBy };
}

export function fmtPaperList(list: ScholarPaper[]): string {
  if (!list || !list.length) return "（无结果）";
  return list.slice(0, 15).map((p, i) => {
    const au = (p.authors || []).slice(0, 3).join(", ") + ((p.authors || []).length > 3 ? " 等" : "");
    const meta = [au, p.year, p.venue, p.info].filter(Boolean).join(" · ");
    const cite = p.citations != null ? "  被引 " + p.citations : "";
    const link = p.url || p.pdf || (p.doi ? "https://doi.org/" + p.doi : "");
    return (i + 1) + ". " + (p.title || "") + (meta ? "\n   " + meta : "") + cite + (link ? "\n   " + link : "");
  }).join("\n");
}
