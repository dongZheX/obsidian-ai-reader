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

// Non-streaming request via requestUrl (no CORS). Retries once on a thrown
// (network) error; HTTP errors come back as a result, not a throw.
export async function httpText(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string },
  cfg?: { timeoutMs?: number; retries?: number }
): Promise<HttpResult> {
  const retries = cfg && cfg.retries != null ? cfg.retries : 1;
  let lastErr: any;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await requestUrl({
        url,
        method: opts.method || "GET",
        headers: opts.headers,
        body: opts.body,
        throw: false,
      });
      const text = resp.text != null ? resp.text : "";
      return {
        ok: resp.status >= 200 && resp.status < 300,
        status: resp.status,
        statusText: "",
        text,
        headers: (resp as any).headers || undefined,
      };
    } catch (e) {
      lastErr = e;
      if (attempt < retries) continue;
    }
  }
  throw new Error("网络请求失败（已重试）：" + (lastErr && lastErr.message ? lastErr.message : lastErr));
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
  timeoutMs = 120000
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
    const req = mod.request(opts, (res: any) => {
      const status: number = res.statusCode || 0;
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
  });
}
