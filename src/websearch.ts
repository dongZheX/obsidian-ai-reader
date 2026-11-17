/* Web tools — ported from zotero-ai-reader (web_search via Serper + web_fetch).
 * Transport is Obsidian's requestUrl (no CORS), so web_fetch can read arbitrary
 * pages. HTML→text reduction is pure. */
import { httpText } from "./net";

export interface SearchResult { title: string; link: string; snippet: string; }

export function urlHost(u: string): string { try { return new URL(u).host; } catch (e) { return (u || "").slice(0, 40); } }

// Google search via Serper (serper.dev). Needs a Serper key.
export async function webSearch(serperKey: string, query: string, num?: number): Promise<SearchResult[]> {
  const key = (serperKey || "").trim();
  if (!key) throw new Error("未配置 Serper API Key（设置 → AI Reader）。");
  const n = Math.max(1, Math.min(10, parseInt(String(num), 10) || 6));
  const resp = await httpText("https://google.serper.dev/search",
    { method: "POST", headers: { "X-API-KEY": key, "Content-Type": "application/json" }, body: JSON.stringify({ q: query, num: n }) },
    { timeoutMs: 20000, retries: 1 });
  if (!resp.ok) throw new Error("Serper " + resp.status + "：" + resp.text.slice(0, 200));
  let data: any; try { data = JSON.parse(resp.text); } catch (e) { throw new Error("Serper 响应不是 JSON"); }
  const out: SearchResult[] = [];
  if (data.answerBox && (data.answerBox.answer || data.answerBox.snippet)) out.push({ title: data.answerBox.title || "Answer", link: data.answerBox.link || "", snippet: data.answerBox.answer || data.answerBox.snippet });
  for (const r of (data.organic || [])) { out.push({ title: r.title || "", link: r.link || "", snippet: r.snippet || "" }); if (out.length >= n) break; }
  return out;
}

// Fetch a web page and reduce it to readable plain text.
export async function webFetch(url: string): Promise<{ title: string; text: string }> {
  const resp = await httpText(url, { method: "GET", headers: { "User-Agent": "Mozilla/5.0 (ObsidianAIReader)", "Accept": "text/html,application/xhtml+xml,text/plain,*/*" } }, { timeoutMs: 25000, retries: 1 });
  if (!resp.ok) throw new Error("HTTP " + resp.status);
  const ctype = (resp.headers && (resp.headers["content-type"] || resp.headers["Content-Type"])) || "";
  const body = resp.text;
  if (/application\/json/i.test(ctype)) return { title: "", text: body.slice(0, 16000) };
  return htmlToText(body);
}

export function decodeEntities(s: string): string {
  return (s || "")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (m, d) => { try { return String.fromCharCode(+d); } catch (e) { return ""; } });
}

// Strip scripts/styles/markup and collapse whitespace into readable text.
export function htmlToText(html: string): { title: string; text: string } {
  let s = html || "";
  const tm = s.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = tm ? decodeEntities(tm[1].replace(/\s+/g, " ").trim()) : "";
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<(script|style|noscript|svg|head|nav|footer|header|form|aside)[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<\/(p|div|li|tr|h[1-6]|br|section|article)>/gi, "\n");
  s = s.replace(/<li[^>]*>/gi, "• ");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  s = s.replace(/[ \t ]+/g, " ").replace(/\n{3,}/g, "\n\n").replace(/^\s+|\s+$/gm, "").trim();
  return { title, text: s.slice(0, 16000) };
}
