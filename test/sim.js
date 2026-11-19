/* Headless Node simulation — the automated safety net (mirrors
 * zotero-ai-reader/test/sim.js). Bundles the pure logic (obsidian stubbed) and
 * asserts extraction, retrieval, API body/parse shapes, tool schemas, token
 * masking, and base-URL normalization. Prints "ALL OK" on success. */
const esbuild = require("esbuild");
const path = require("path");

let fails = 0;
function ok(cond, msg) { if (!cond) { fails++; console.error("  ✗ " + msg); } else { console.log("  ✓ " + msg); } }
function eq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), msg + "  (got " + JSON.stringify(a) + ")"); }

(async () => {
  await esbuild.build({
    entryPoints: [path.join(__dirname, "entry.ts")],
    bundle: true, format: "cjs", platform: "node",
    outfile: path.join(__dirname, "_bundle.cjs"), logLevel: "silent",
    alias: { obsidian: path.join(__dirname, "stub-obsidian.js") },
  });
  const m = require("./_bundle.cjs");

  // ---- block extraction ----
  const md = [
    "# Title",
    "",
    "The model works well. It beats the baseline by 5 points on the test set.",
    "",
    "## Method",
    "",
    "We use a transformer. Training took two days.",
    "",
    "![[figure1.png]]",
    "",
    "| a | b |",
    "| - | - |",
    "| 1 | 2 |",
    "",
    "$$ E = mc^2 $$",
  ].join("\n");
  const blocks = m.parseMarkdownBlocks(md);
  console.log("blocks:", blocks.map((b) => b.type + ":" + b.id).join(" "));
  ok(blocks.some((b) => b.type === "heading" && /Title/.test(b.text)), "heading extracted");
  ok(blocks.filter((b) => b.type === "paragraph").length >= 3, "paragraphs split into sentences");
  const img = blocks.find((b) => b.type === "image");
  ok(img && img.src === "figure1.png", "image block carries src");
  ok(blocks.some((b) => b.type === "table"), "table block extracted");
  ok(blocks.some((b) => b.type === "math"), "math block extracted");
  const para = blocks.find((b) => b.type === "paragraph");
  ok(para.startOffset != null && para.endOffset > para.startOffset, "paragraph has char range");
  ok(md.slice(para.startOffset, para.endOffset).includes(para.text.split(" ")[0]), "offsets map into document");
  ok(m.locLabel(para).startsWith("L"), "locLabel is line-based for markdown");

  // ---- sentence split ----
  const sents = m.splitSentences("The transformer model achieves strong results on the benchmark. However the training cost remains quite high for most practitioners.");
  ok(sents.length >= 2, "sentences split");
  ok(sents.every((s) => s.text.length > 0), "no empty sentences");
  // short fragments / abbreviations merge back into one sentence (ported behavior)
  ok(m.splitSentences("Dr. Smith et al. showed X.").length === 1, "abbreviations merged, not over-split");

  // ---- sections ----
  const secs = m.buildSections(blocks);
  ok(secs.length >= 1, "sections built");
  ok(secs.some((s) => /Method/.test(s.title)), "Method section present");

  // ---- retrieval ----
  const ctx = m.buildRetrievedContext(blocks, "transformer training", 60000);
  ok(/\[B\d+ L\d+\]/.test(ctx), "retrieved context tags blocks with [B# L#]");
  { const sp = new m.LLM(() => m.DEFAULT_SETTINGS).systemPrompt("CTX", "中文");
    ok(/```svg/.test(sp), "system prompt tells the model it can draw ```svg diagrams");
    ok(/表达风格/.test(sp) && /别带 AI 腔/.test(sp), "system prompt carries the de-AI-flavor style guide"); }
  const bounded = m.buildContextBounded(blocks, 60000);
  ok(bounded.includes("[B"), "bounded context produced");

  // ---- figIndex ----
  ok(m.figIndex(blocks).includes("图") || m.figIndex(blocks).includes("表"), "figure index lists figures/tables");

  // ---- LLM body shapes ----
  const settings = Object.assign({}, m.DEFAULT_SETTINGS, { apiKey: "k", model: "gpt", baseURL: "https://api.x.com/v1" });
  const makeLLM = (fmt) => new m.LLM(() => Object.assign({}, settings, { apiFormat: fmt }));
  const msgs = [{ role: "system", content: "sys" }, { role: "user", content: "hi" }];
  const chatBody = JSON.parse(makeLLM("chat").bodyFor("chat", msgs, false));
  eq(chatBody.model, "gpt", "chat body has model");
  ok(Array.isArray(chatBody.messages) && chatBody.messages.length === 2, "chat body keeps messages");
  const respBody = JSON.parse(makeLLM("responses").bodyFor("responses", msgs, false));
  ok(Array.isArray(respBody.input), "responses body uses input[]");
  const antBody = JSON.parse(makeLLM("anthropic").bodyFor("anthropic", msgs, false));
  ok(Array.isArray(antBody.system) && antBody.system[0].text === "sys" && antBody.messages.length === 1, "anthropic body splits system out (cached) ");
  ok(antBody.max_tokens > 0, "anthropic always sets max_tokens");

  // ---- tool body + schemas ----
  const tools = m.toolSchemas("chat");
  ok(tools[0].type === "function" && tools[0].function.name === "list_sections", "chat tool schema shape");
  ok(m.toolSchemas("anthropic")[0].input_schema != null, "anthropic tool schema uses input_schema");
  ok(m.toolSchemas("responses")[0].name === "list_sections", "responses tool schema flat");

  // ---- parse tool calls ----
  const L = makeLLM("chat");
  const chatCalls = L.parseToolCalls("chat", { choices: [{ message: { content: "", tool_calls: [{ id: "c1", function: { name: "highlight", arguments: '{"id":3,"category":"method"}' } }] } }] });
  eq(chatCalls.calls[0].args, { id: 3, category: "method" }, "chat tool-call args parsed");
  const antCalls = L.parseToolCalls("anthropic", { content: [{ type: "text", text: "hello" }, { type: "tool_use", id: "t1", name: "read_section", input: { index: 0 } }] });
  ok(antCalls.text === "hello" && antCalls.calls[0].name === "read_section", "anthropic tool-call parsed");
  const respCalls = L.parseToolCalls("responses", { output: [{ type: "function_call", call_id: "r1", name: "finish", arguments: "{}" }] });
  ok(respCalls.calls[0].name === "finish", "responses tool-call parsed");

  // ---- anthropic cache breakpoints + no-tools body ----
  const La = makeLLM("anthropic");
  const cached = La.anthropicCacheMsgs([{ role: "user", content: "hi" }]);
  ok(Array.isArray(cached[0].content) && cached[0].content[0].cache_control, "anthropicCacheMsgs adds cache_control to last msg");
  const antTool = JSON.parse(La.toolBody("anthropic", [{ role: "system", content: "S" }, { role: "user", content: "q" }], [{ name: "x" }], false));
  ok(Array.isArray(antTool.system) && antTool.system[0].cache_control, "anthropic system prompt is cached");
  const antNoTool = JSON.parse(La.toolBody("anthropic", [{ role: "user", content: "q" }], null, false));
  ok(!("tools" in antNoTool), "toolBody with null tools omits tools (wrap-up path)");
  const chatNoTool = JSON.parse(makeLLM("chat").toolBody("chat", [{ role: "user", content: "q" }], [], false));
  ok(!("tools" in chatNoTool), "chat toolBody with empty tools omits tools");

  // ---- cache usage capture (surfaced in the meta line) ----
  { const mw = {}; La.captureUsage(mw, { usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 2000 } });
    ok(mw.cacheWrite === 2000, "cache_creation surfaced as cacheWrite (first turn)");
    const mr = {}; La.captureUsage(mr, { usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 1800 } });
    ok(mr.cacheRead === 1800, "cache_read surfaced as cacheRead (later turns)");
    const mo = {}; L.captureUsage(mo, { usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 900 } } });
    ok(mo.cacheRead === 900, "OpenAI cached_tokens surfaced as cacheRead"); }

  // ---- friendlyError: actionable hint + raw text kept ----
  { const f = (s) => L.friendlyError(new Error(s));
    ok(/超时/.test(f("The operation was aborted")), "abort/timeout → 超时 hint");
    ok(/Key/.test(f("HTTP 401 Unauthorized")), "401 → key hint");
    ok(/限流|额度/.test(f("HTTP 429 rate limit")), "429 → rate-limit hint");
    ok(/接口格式|格式/.test(f("Unexpected token < in JSON")), "non-JSON → format hint");
    ok(/连不上|网络/.test(f("网络请求失败（已重试）：Failed to fetch")), "network → connectivity hint");
    ok(f("Base URL 未设置") === "Base URL 未设置", "already-clear message passes through");
    ok(/原始信息/.test(f("HTTP 401 Unauthorized")), "raw text appended for diagnosis"); }

  // ---- reasoning: parse + echo back verbatim ----
  const rp = La.parseToolCalls("anthropic", { content: [{ type: "thinking", thinking: "hmm", signature: "sig" }, { type: "text", text: "ans" }, { type: "tool_use", id: "t", name: "read_section", input: {} }] });
  ok(rp.reasoning.length === 1 && rp.reasoning[0].type === "thinking", "parseToolCalls extracts thinking");
  const amsgs = [];
  La.pushAssistantToolTurn("anthropic", amsgs, rp);
  ok(amsgs[0].content[0].type === "thinking" && amsgs[0].content[0].signature === "sig", "thinking echoed FIRST with signature");
  const rmsgs = [];
  La.pushAssistantToolTurn("responses", rmsgs, { text: "a", calls: [{ id: "c", name: "f", args: {} }], reasoning: [{ type: "reasoning", id: "r1" }] });
  ok(rmsgs[0].type === "reasoning" && rmsgs.some((m) => m.type === "function_call"), "responses reasoning item pushed before function_call");

  // ---- stream deltas ----
  eq(L.streamDelta("chat", { choices: [{ delta: { content: "x" } }] }), "x", "chat stream delta");
  eq(L.streamDelta("anthropic", { type: "content_block_delta", delta: { text: "y" } }), "y", "anthropic stream delta");
  eq(L.streamDelta("responses", { type: "response.output_text.delta", delta: "z" }), "z", "responses stream delta");

  // ---- normBase ----
  ok(makeLLM2(m, "http://api.remote.com").normBase() === "https://api.remote.com/v1", "remote http upgraded + /v1 appended");
  ok(makeLLM2(m, "http://localhost:1234").normBase() === "http://localhost:1234/v1", "localhost kept on http");

  // ---- vision messages ----
  const vm = L.buildVisionMessages("chat", "中文", "describe", "data:image/png;base64,AAA");
  ok(vm[1].content[1].image_url.url.startsWith("data:image"), "openai vision uses image_url");
  const vma = L.buildVisionMessages("anthropic", "中文", "describe", "data:image/png;base64,AAA");
  ok(vma[1].content[1].source.data === "AAA", "anthropic vision uses base64 source");

  // ---- token masking ----
  const { masked, tokens } = m.maskTokens("Key point [B1, B2] and highlight [[hl:B3]] see [[fig:B5]] and [[note:B7|why]].");
  ok(tokens.length === 4, "4 tokens captured");
  ok(tokens[0].kind === "cite" && JSON.stringify(tokens[0].ids) === "[1,2]", "grouped citation parsed");
  ok(tokens[1].kind === "dir" && tokens[1].dir === "hl" && tokens[1].id === 3, "hl directive parsed");
  ok(tokens[2].dir === "fig" && tokens[2].id === 5, "fig directive parsed");
  ok(tokens[3].dir === "note" && tokens[3].comment === "why", "note directive carries comment");
  ok(!/\[\[|\[B/.test(masked), "masked text has no raw tokens left");

  // ---- web tools: gating, schema, html→text ----
  ok(m.agentTools().map((t) => t.name).includes("web_fetch"), "web_fetch always available");
  ok(!m.agentTools().map((t) => t.name).includes("web_search"), "no web_search without Serper key");
  ok(m.agentTools({ serper: true }).map((t) => t.name).includes("web_search"), "web_search appears when serper on");
  const wsChat = m.toolSchemas("chat", { serper: true }).find((t) => t.function && t.function.name === "web_search");
  ok(wsChat && wsChat.function.parameters.required.includes("query"), "web_search chat schema requires query");
  ok(m.toolSchemas("anthropic", { serper: true }).find((t) => t.name === "web_search").input_schema != null, "web_search anthropic schema uses input_schema");
  const ht = m.htmlToText("<html><head><title>Hi &amp; Bye</title><style>x{}</style></head><body><nav>menu</nav><p>Hello <b>world</b></p><script>bad()</script><li>one</li></body></html>");
  ok(ht.title === "Hi & Bye", "html title extracted + entity decoded");
  ok(/Hello world/.test(ht.text), "html body text kept");
  ok(!/bad\(\)/.test(ht.text) && !/menu/.test(ht.text), "script/nav stripped");
  ok(/• one/.test(ht.text), "list item bulletized");
  ok(m.urlHost("https://arxiv.org/abs/1234") === "arxiv.org", "urlHost extracts host");

  // ---- execTool routes web_search / web_fetch ----
  const tc2 = { webSearch: async () => [{ title: "R", link: "http://r", snippet: "snip" }], webFetch: async () => ({ title: "Page", text: "body text here" }) };
  const r1 = await m.execTool(tc2, { name: "web_search", args: { query: "q" } });
  ok(/联网搜索/.test(r1.render.label) && /1 条/.test(r1.render.outcome), "web_search tool block");
  ok(JSON.parse(r1.output)[0].link === "http://r", "web_search output is JSON results");
  const r2 = await m.execTool(tc2, { name: "web_fetch", args: { url: "https://example.com/p" } });
  ok(/抓取网页/.test(r2.render.label) && JSON.parse(r2.output).title === "Page", "web_fetch tool block + output");
  const r3 = await m.execTool(tc2, { name: "web_fetch", args: { url: "ftp://nope" } });
  ok(/✕/.test(r3.render.outcome), "web_fetch rejects non-http url");

  // ---- scholarly discovery: lookup_paper / find_references / related_papers ----
  // present unconditionally (free APIs), in all 3 formats
  { const names = m.agentTools().map((t) => t.name);
    ok(names.includes("lookup_paper") && names.includes("find_references") && names.includes("related_papers"), "scholar tools always present"); }
  for (const fmt of ["chat", "anthropic", "responses"]) {
    const got = m.toolSchemas(fmt).map((t) => t.name || (t.function && t.function.name));
    ok(got.includes("find_references"), "find_references in " + fmt + " schema");
  }
  // normS2 + fmtPaperList (pure)
  { const n = m.normS2({ title: "T", authors: [{ name: "A" }, { name: "B" }], year: 2021, venue: "NeurIPS", citationCount: 42, externalIds: { DOI: "10.1/x", ArXiv: "2101.00001" }, url: "http://u" });
    ok(n.title === "T" && n.authors.length === 2 && n.year === 2021 && n.citations === 42 && n.doi === "10.1/x" && n.arxiv === "2101.00001", "normS2 maps fields");
    const body = m.fmtPaperList([n]);
    ok(/1\. T/.test(body) && /A, B/.test(body) && /被引 42/.test(body), "fmtPaperList renders title+authors+citations");
    ok(m.fmtPaperList([]) === "（无结果）", "fmtPaperList empty"); }
  // execTool routes the 3 scholar tools via injected ctx fns
  { const tcS = {
      lookupPaper: async () => ({ source: "s2", results: [{ title: "P1", authors: ["X"], year: 2020, citations: 5 }] }),
      findReferences: async () => [{ title: "Ref1", authors: ["Y"], year: 2018 }],
      relatedPapers: async () => ({ related: [{ title: "Rel1" }], citedBy: [{ title: "Cite1" }, { title: "Cite2" }] }),
    };
    const rl = await m.execTool(tcS, { name: "lookup_paper", args: { query: "foo" } });
    ok(/查论文/.test(rl.render.label) && JSON.parse(rl.output)[0].title === "P1", "lookup_paper routes + JSON output");
    const rf = await m.execTool(tcS, { name: "find_references", args: {} });
    ok(/找参考文献/.test(rf.render.label) && /1 条/.test(rf.render.outcome) && JSON.parse(rf.output)[0].title === "Ref1", "find_references routes");
    const rr = await m.execTool(tcS, { name: "related_papers", args: {} });
    ok(/相关论文/.test(rr.render.label) && /3 条/.test(rr.render.outcome) && JSON.parse(rr.output).citedBy.length === 2, "related_papers merges related+citedBy");
    // soft error surfaces ✕ without throwing
    const tcErr = { findReferences: async () => { throw new Error("Semantic Scholar 暂时限流"); } };
    const re = await m.execTool(tcErr, { name: "find_references", args: {} });
    ok(/✕ 失败/.test(re.render.outcome) && /error/.test(re.output), "find_references soft-fails on throttle");
    // unavailable (no ctx fn) → ✕ 未配置
    const rn = await m.execTool({}, { name: "lookup_paper", args: {} });
    ok(/✕ 未配置/.test(rn.render.outcome), "lookup_paper unavailable when ctx fn missing"); }
  // resolveId: DOI / arXiv pass through; title matched via S2 (not exercised — needs network)
  { const doi = await m.resolveId("10.1145/3292500.3330701");
    ok(doi === "DOI:10.1145/3292500.3330701", "resolveId DOI → DOI: id");
    const arx = await m.resolveId("arXiv:2101.00001");
    ok(arx === "ARXIV:2101.00001", "resolveId arXiv → ARXIV: id"); }

  // ---- reading skills ----
  ok(m.SKILLS.length === 8, "8 reading skills defined");
  ok(m.skillById("peer-review").label === "同行评审", "skillById resolves");
  ok(m.skillById("nonexistent").id === "deep-read", "unknown skill falls back to default");
  ok(/阅读技能：同行评审/.test(m.skillDirective("peer-review")), "skillDirective wraps the skill's inject");
  ok(m.chipsFor("quick").length === m.skillById("quick").presets.length + m.COMMON_PRESETS.length, "chips = skill presets + common presets");
  ok(m.skillById("peer-review").agentInject && !m.skillById("quick").agentInject, "agentInject only where defined");

  // ---- auto API format by model name ----
  const auto = (model) => new m.LLM(() => Object.assign({}, m.DEFAULT_SETTINGS, { apiFormat: "auto", model })).fmt();
  eq(auto("claude-opus-4-8"), "anthropic", "auto: claude -> anthropic");
  eq(auto("gpt-4o-mini"), "responses", "auto: gpt -> responses");
  eq(auto("deepseek-chat"), "chat", "auto: other -> chat");
  eq(new m.LLM(() => Object.assign({}, m.DEFAULT_SETTINGS, { apiFormat: "anthropic", model: "gpt-4o" })).fmt(), "anthropic", "explicit format overrides auto");

  // ---- custom prompt injected ----
  ok(/自定义要求/.test(new m.LLM(() => Object.assign({}, m.DEFAULT_SETTINGS, { customPrompt: "多用例子" })).systemPrompt("X", "中文")), "custom prompt injected into system prompt");
  ok(!/自定义要求/.test(new m.LLM(() => m.DEFAULT_SETTINGS).systemPrompt("X", "中文")), "no custom-prompt block when empty");

  console.log("");
  if (fails) { console.error(fails + " FAILED"); process.exit(1); }
  console.log("ALL OK");
})().catch((e) => { console.error(e); process.exit(1); });

function makeLLM2(m, baseURL) { return new m.LLM(() => Object.assign({}, m.DEFAULT_SETTINGS, { apiKey: "k", baseURL })); }
