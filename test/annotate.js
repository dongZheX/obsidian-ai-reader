/* Exercises the riskiest string-surgery code (annotate.ts) against an in-memory
 * vault, plus the Markdown parser against real vault notes. Node only. */
const esbuild = require("esbuild");
const path = require("path");
const fs = require("fs");
const os = require("os");

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.error("  ✗ " + m); } else console.log("  ✓ " + m); };

(async () => {
  await esbuild.build({ entryPoints: [path.join(__dirname, "entry2.ts")], bundle: true, format: "cjs", platform: "node", outfile: path.join(__dirname, "_bundle2.cjs"), logLevel: "silent", alias: { obsidian: path.join(__dirname, "stub-obsidian.js") } });
  const m = require("./_bundle2.cjs");

  // fake app with an in-memory vault.process / read
  const makeApp = (initial) => { const file = { __data: initial, path: "x.md", basename: "x" }; const app = { vault: { process: async (f, fn) => { f.__data = fn(f.__data); return f.__data; }, read: async (f) => f.__data, modify: async (f, d) => { f.__data = d; } } }; return { app, file }; };

  const note = "# Paper\n\nThe model achieves state of the art on the benchmark. It also runs faster than the baseline by a wide margin.\n\nWe trained for two days on eight GPUs.\n";
  {
    const { app, file } = makeApp(note);
    const ann = new m.Annotator(app);
    const blocks = m.parseMarkdownBlocks(note);
    const paras = blocks.filter((b) => b.type === "paragraph");
    ok(paras.length >= 3, "parser found >=3 sentence blocks");

    // apply a highlight to the first sentence
    const r1 = await ann.applyOne(file, paras[0], { comment: "核心结果", category: "result" });
    ok(r1 && r1.uid, "applyOne returned a uid");
    ok(/<mark class="air-hl air-result" data-air="[^"]+"[^>]*>/.test(file.__data), "mark wrapper written with category class");
    ok(file.__data.includes("%%air:" + r1.uid + " 核心结果%%"), "hidden comment written");
    ok(file.__data.includes(paras[0].text.split(" ")[0]), "original text preserved inside mark");

    // idempotency: applying the SAME block again must not double-wrap
    const before = file.__data;
    const r2 = await ann.applyOne(file, paras[0], { comment: "again", category: "result" });
    ok(r2 === null, "re-applying same block is skipped (idempotent)");
    ok(file.__data === before, "document unchanged on idempotent re-apply");

    // remove by uid: unwrap + strip comment
    const removed = await ann.removeByUids(file, [r1.uid]);
    ok(removed === 1, "removeByUids removed one mark");
    ok(!file.__data.includes("data-air"), "mark wrapper gone after remove");
    ok(!file.__data.includes("%%air:"), "comment gone after remove");
    ok(file.__data === note, "document restored byte-for-byte after apply+remove");
  }

  // batch apply (end-first splice keeps offsets valid), then undo all
  {
    const { app, file } = makeApp(note);
    const ann = new m.Annotator(app);
    const blocks = m.parseMarkdownBlocks(note);
    const paras = blocks.filter((b) => b.type === "paragraph");
    const items = paras.map((b, i) => ({ block: b, comment: "note" + i, category: ["result", "method", "contribution"][i % 3] }));
    const applied = await ann.applyMany(file, items);
    ok(applied.length === paras.length, "applyMany wrapped every sentence (" + applied.length + ")");
    const markCount = (file.__data.match(/data-air=/g) || []).length;
    ok(markCount === paras.length, "one mark per sentence, no overlap corruption");
    // every sentence's visible text still present exactly once
    let textOk = true;
    for (const b of paras) if (!file.__data.includes(b.text.split(" ").slice(0, 3).join(" "))) textOk = false;
    ok(textOk, "all sentence texts survive the batch wrap");
    const removed = await ann.removeByUids(file, applied.map((a) => a.uid));
    ok(removed === paras.length, "undo removed all marks (" + removed + ")");
    ok(file.__data === note, "batch apply+undo restores the document exactly");
  }

  // offset drift: user edits (inserts text at top) before apply → locate() recovers
  {
    const edited = "PREFIX INSERTED BY USER\n\n" + note;
    const { app, file } = makeApp(edited);
    const ann = new m.Annotator(app);
    const blocks = m.parseMarkdownBlocks(note); // blocks parsed from the OLD text (stale offsets)
    const para = blocks.filter((b) => b.type === "paragraph")[0];
    const r = await ann.applyOne(file, para, { comment: "x", category: null });
    ok(r && r.uid, "applyOne still succeeds with stale offsets (locate fallback)");
    ok((file.__data.match(/data-air=/g) || []).length === 1, "exactly one wrap despite drift");
  }

  // getUserAnnotations reads ==hl==, <mark>, %%comment%% (not ours)
  {
    const n = "Some ==important phrase== here.\n\nA <mark>raw mark</mark> and %%my note%% and %%air:zz ours%%.\n";
    const { app, file } = makeApp(n);
    const ann = new m.Annotator(app);
    const ua = await ann.getUserAnnotations(file);
    ok(ua.some((x) => x.includes("important phrase")), "reads ==highlight==");
    ok(ua.some((x) => x.includes("raw mark")), "reads <mark>");
    ok(ua.some((x) => x.includes("my note")), "reads %%comment%%");
    ok(!ua.some((x) => x.includes("ours")), "ignores our own %%air:%% comments");
  }

  // ---- parse REAL vault notes: must not crash, produces blocks ----
  const vault = path.join(os.homedir(), "dongzhe-md");
  const pick = [];
  const walk = (d, depth) => { if (depth > 2 || pick.length >= 6) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (pick.length >= 6) break; if (e.name.startsWith(".")) continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p, depth + 1); else if (e.name.endsWith(".md") && fs.statSync(p).size > 800) pick.push(p); } };
  try { walk(path.join(vault, "Paper-Reading"), 0); } catch (e) {}
  try { if (pick.length < 3) walk(vault, 0); } catch (e) {}
  console.log("  real notes sampled:", pick.length);
  for (const p of pick) {
    const text = fs.readFileSync(p, "utf8");
    let blocks;
    try { blocks = m.parseMarkdownBlocks(text); } catch (e) { ok(false, "parse crashed on " + path.basename(p) + ": " + e.message); continue; }
    const paras = blocks.filter((b) => b.type === "paragraph");
    // verify offsets round-trip: slice(startOffset,endOffset) ~ contains first word
    let offsetsOk = paras.length === 0;
    for (const b of paras.slice(0, 20)) { const slice = text.slice(b.startOffset, b.endOffset); if (slice.replace(/\s+/g, " ").includes(b.text.split(" ")[0])) { offsetsOk = true; } else { offsetsOk = false; break; } }
    ok(blocks.length > 0 && offsetsOk, path.basename(p).slice(0, 40) + " → " + blocks.length + " blocks, offsets map");
  }

  console.log("");
  if (fails) { console.error(fails + " FAILED"); process.exit(1); }
  console.log("ANNOTATE OK");
})().catch((e) => { console.error(e); process.exit(1); });
