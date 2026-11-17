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
  ok(antBody.system === "sys" && antBody.messages.length === 1, "anthropic body splits system out + max_tokens");
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

  console.log("");
  if (fails) { console.error(fails + " FAILED"); process.exit(1); }
  console.log("ALL OK");
})().catch((e) => { console.error(e); process.exit(1); });

function makeLLM2(m, baseURL) { return new m.LLM(() => Object.assign({}, m.DEFAULT_SETTINGS, { apiKey: "k", baseURL })); }
