/*
 * Transport layer.
 *
 * Obsidian's renderer `fetch` is subject to CORS, and LLM API hosts don't send
 * CORS headers, so a naive fetch() port fails ("Failed to fetch"). We therefore:
 *   - do non-streaming calls through Obsidian's `requestUrl` (bypasses CORS), and
 *   - do streaming through Node's `https`/`http` (desktop only) to read SSE.
 *
 * Both preserve the Zotero plugin's behaviour: an idle timeout and ONE automatic
 * retry on a *network* failure (not on an HTTP error with a body).
 */
import { requestUrl } from "obsidian";

export interface HttpResult {
  ok: boolean;
  status: number;
  statusText: string;
  text: string;
  headers?: Record<string, string>;
}

// HTTP statuses that mean "retry later": 429 rate-limit, 503/529 overloaded.
export const RATE_STATUS = new Set([429, 503, 529]);

// Parse a Retry-After header → ms to wait, or null. Accepts delta-seconds or an
// HTTP-date; clamped so a hostile/huge value can't hang us for minutes.
export function retryAfterMs(headers?: Record<string, any>): number | null {
  try {
    if (!headers) return null;
    const h = headers["retry-after"] != null ? headers["retry-after"] : headers["Retry-After"];
    if (!h) return null;
    const s = String(h).trim();
    if (/^\d+$/.test(s)) return Math.min(parseInt(s, 10) * 1000, 30000);
    const t = Date.parse(s);
    if (!isNaN(t)) return Math.max(0, Math.min(t - Date.now(), 30000));
  } catch (e) {}
  return null;
}
// Backoff for rate-limit retry #attempt (0-based): honor Retry-After, else
// exponential (1.5s·2^n, capped at 20s) + jitter.
export function rateBackoffMs(attempt: number, headers?: Record<string, any>): number {
  const ra = retryAfterMs(headers);
  return ra != null ? ra : Math.min(1500 * Math.pow(2, attempt), 20000) + Math.floor(Math.random() * 500);
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Non-streaming request via requestUrl (no CORS). Retries once on a thrown
// (network) error; additionally a 429/503/529 RESPONSE is retried with backoff
// (honoring Retry-After), independent of the network-retry budget. Other HTTP
// errors come back as a result, not a throw.
export async function httpText(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string },
  cfg?: { timeoutMs?: number; retries?: number; rateRetries?: number }
): Promise<HttpResult> {
  const retries = cfg && cfg.retries != null ? cfg.retries : 1;
  const rateRetries = cfg && cfg.rateRetries != null ? cfg.rateRetries : 4;
  let lastErr: any, netAttempt = 0, rateAttempt = 0;
  while (true) {
    try {
      const resp = await requestUrl({
        url,
        method: opts.method || "GET",
        headers: opts.headers,
        body: opts.body,
        throw: false,
      });
      const headers = (resp as any).headers || undefined;
      if (RATE_STATUS.has(resp.status) && rateAttempt < rateRetries) {
        const wait = rateBackoffMs(rateAttempt, headers);
        rateAttempt++;
        await sleep(wait);
        continue; // does not consume the network-retry budget
      }
      const text = resp.text != null ? resp.text : "";
      return {
        ok: resp.status >= 200 && resp.status < 300,
        status: resp.status,
        statusText: "",
        text,
        headers,
      };
    } catch (e) {
      lastErr = e;
      if (netAttempt < retries) { netAttempt++; continue; }
      throw new Error("网络请求失败（已重试）：" + (lastErr && lastErr.message ? lastErr.message : lastErr));
    }
  }
}

// Streaming request via Node. Calls onLine() for every complete line of the
// response body (the caller parses SSE `data:` frames). Resolves when the
// stream ends; destroys the socket if shouldStop() turns true.
export function httpStreamLines(
  url: string,
  headers: Record<string, string>,
  body: string,
  onLine: (line: string) => void,
  shouldStop: () => boolean,
  timeoutMs = 120000,
  rateRetries = 4
): Promise<void> {
  return new Promise((resolve, reject) => {
    let mod: any, u: any;
    try {
      u = new URL(url);
      mod = u.protocol === "http:" ? require("http") : require("https");
    } catch (e) {
      reject(new Error("无法解析地址：" + (e && (e as any).message)));
      return;
    }
    const opts = {
      method: "POST",
      hostname: u.hostname,
      port: u.port || (u.protocol === "http:" ? 80 : 443),
      path: u.pathname + u.search,
      headers: Object.assign({}, headers, { "Content-Length": Buffer.byteLength(body) }),
    };
    let rateAttempt = 0;
    const attempt = () => {
      const req = mod.request(opts, (res: any) => {
        const status: number = res.statusCode || 0;
        // A 429/503/529 arrives before any stream bytes, so retrying can't dupe
        // an answer: back off (honoring Retry-After) and re-issue the request.
        if (RATE_STATUS.has(status) && rateAttempt < rateRetries && !shouldStop()) {
          const wait = rateBackoffMs(rateAttempt, res.headers);
          rateAttempt++;
          try { res.resume(); } catch (e) {}   // drain so the socket is released
          try { req.destroy(); } catch (e) {}
          setTimeout(() => { if (shouldStop()) { resolve(); return; } attempt(); }, wait);
          return;
        }
        let buf = "";
        let raw = "";
        const ok = status >= 200 && status < 300;
        res.setEncoding("utf8");
        let handlerErr: any = null;
        res.on("data", (chunk: string) => {
          if (handlerErr) return;
          if (shouldStop()) { try { req.destroy(); } catch (e) {} return; }
          raw += chunk;
          if (!ok) return; // collect the full error body, surface it on end
          buf += chunk;
          try {
            let nl: number;
            while ((nl = buf.indexOf("\n")) >= 0) {
              const line = buf.slice(0, nl);
              buf = buf.slice(nl + 1);
              onLine(line);
            }
          } catch (e) { handlerErr = e; try { req.destroy(); } catch (_) {} reject(e); }
        });
        res.on("end", () => {
          if (handlerErr) return;
          if (!ok) { reject(new Error("HTTP " + status + "\n" + raw.slice(0, 1200))); return; }
          try { if (buf.trim()) onLine(buf); } catch (e) { reject(e); return; }
          resolve();
        });
        res.on("error", (e: any) => reject(e));
      });
      req.on("error", (e: any) => reject(new Error("网络请求失败：" + (e && e.message ? e.message : e))));
      req.setTimeout(timeoutMs, () => { try { req.destroy(new Error("请求超时")); } catch (e) {} });
      req.write(body);
      req.end();
    };
    attempt();
  });
}
