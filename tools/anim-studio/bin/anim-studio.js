#!/usr/bin/env node
// anim-studio CLI — permanent home for the animation authoring harness that
// used to be rebuilt in scratchpad every session.
//
//   node bin/anim-studio.js <command> [args]
//
// Commands:
//   list-templates                 List starter templates.
//   new <template> [--out FILE]     Scaffold a script from a template.
//   verify <file>                   Offline validate (compile + storage
//                                     round-trip + backtick/String.raw rules).
//   encode <file> [--out FILE]      Print/write the HTML-escaped stored form.
//   decode <file> [--out FILE]      Reverse encode (stored HTML → plain JS).
//   push <file> --uuid ITEM_UUID    Validate → encode → write to the item's
//                                     system.props.animation_script (LIVE) →
//                                     browser round-trip verify.
//   pull --uuid ITEM_UUID [--out F] Read an item's animation_script (LIVE) →
//                                     decode → save to a file.
//   sfx-sync                        Trigger the in-game Forge SFX scan (LIVE)
//                                     and report the manifest count. The
//                                     manifest is mirrored into the repo at
//                                     modules/.../data/anim-studio/sfx-manifest.json
//   health                          Show test-bridge liveness.
//
// LIVE commands need the game running with the bridge active
// (FUCompanion.api.testBridge.activate()).
"use strict";

const fs = require("fs");
const path = require("path");
const { encode, decode, validate } = require("../lib/encode.js");
const { Bridge } = require("../lib/bridge.js");

const TEMPLATES_DIR = path.resolve(__dirname, "..", "templates");
const ANIM_FIELD = "system.props.animation_script";

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) { flags[key] = next; i++; }
      else flags[key] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}

function die(msg) { console.error(`✗ ${msg}`); process.exit(1); }
function ok(msg) { console.log(`✓ ${msg}`); }

// Live-ping gate. The bridge idles its heartbeat when no requests arrive (so
// state.json goes stale) but still answers — a real ping is the reliable check
// and wakes it. Dies with guidance if it doesn't respond.
async function ensureLive(bridge) {
  try { await bridge.pingLive(); }
  catch {
    die("test-bridge not responding. Open the game (GM), then run in the console: FUCompanion.api.testBridge.activate()");
  }
}

// ── Commands ────────────────────────────────────────────────────────────────

function cmdListTemplates() {
  if (!fs.existsSync(TEMPLATES_DIR)) return console.log("(no templates dir)");
  const files = fs.readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith(".js"));
  if (!files.length) return console.log("(no templates)");
  console.log("Templates:");
  for (const f of files) {
    const src = fs.readFileSync(path.join(TEMPLATES_DIR, f), "utf8");
    const desc = (src.match(/^\/\/\s*@desc\s+(.*)$/m) || [])[1] ?? "";
    console.log(`  ${f.replace(/\.js$/, "").padEnd(22)} ${desc}`);
  }
}

function cmdNew(positional, flags) {
  const name = positional[0];
  if (!name) die("usage: new <template> [--out FILE]");
  const src = path.join(TEMPLATES_DIR, name.endsWith(".js") ? name : `${name}.js`);
  if (!fs.existsSync(src)) die(`template not found: ${name} (see: list-templates)`);
  const out = flags.out || `${name.replace(/\.js$/, "")}-anim.js`;
  fs.copyFileSync(src, out);
  ok(`scaffolded ${out} from template "${name}". Edit the CFG block, then: verify ${out}`);
}

function cmdVerify(positional) {
  const file = positional[0];
  if (!file) die("usage: verify <file>");
  const src = fs.readFileSync(file, "utf8");
  const r = validate(src);
  for (const w of r.warnings) console.log(`  ⚠ ${w}`);
  if (r.ok) { ok(`${file} valid (${src.split("\n").length} lines).`); }
  else { for (const e of r.errors) console.error(`  ✗ ${e}`); process.exit(1); }
}

function cmdEncode(positional, flags) {
  const src = fs.readFileSync(positional[0], "utf8");
  const out = encode(src);
  if (flags.out) { fs.writeFileSync(flags.out, out, "utf8"); ok(`wrote ${flags.out}`); }
  else process.stdout.write(out + "\n");
}

function cmdDecode(positional, flags) {
  const src = fs.readFileSync(positional[0], "utf8");
  const out = decode(src);
  if (flags.out) { fs.writeFileSync(flags.out, out, "utf8"); ok(`wrote ${flags.out}`); }
  else process.stdout.write(out + "\n");
}

async function cmdPush(positional, flags) {
  const file = positional[0];
  const uuid = flags.uuid;
  if (!file || !uuid) die("usage: push <file> --uuid ITEM_UUID");
  const src = fs.readFileSync(file, "utf8");

  // 1. Validate offline first — never push a broken script.
  const r = validate(src);
  for (const w of r.warnings) console.log(`  ⚠ ${w}`);
  if (!r.ok) { for (const e of r.errors) console.error(`  ✗ ${e}`); die("validation failed — not pushing."); }

  // 2. Encode + write live.
  const stored = encode(src);
  const bridge = new Bridge({ world: flags.world });
  await ensureLive(bridge);
  await bridge.updateDocument(uuid, { [ANIM_FIELD]: stored });
  ok(`pushed ${src.length} chars → ${uuid}`);

  // 3. Browser round-trip verify: read back, run BD-style _stripHtml + compile.
  const expectLen = src.trim().length;
  const code = `
    const it = await fromUuid(${JSON.stringify(uuid)});
    const raw = it?.system?.props?.animation_script ?? "";
    const div = document.createElement("div");
    div.innerHTML = String(raw).replace(/<\\/p>/gi, "\\n").replace(/<br\\s*\\/?>/gi, "\\n");
    const stripped = (div.textContent ?? "").trim();
    let compiles = true, err = null;
    try { new Function("payload","targets", '"use strict";\\n' + stripped); }
    catch (e) { compiles = false; err = String(e.message); }
    return { len: stripped.length, compiles, err };
  `;
  const res = await bridge.evalGM(code);
  if (!res.compiles) die(`round-trip verify FAILED — stored script does not compile in browser: ${res.err}`);
  const delta = Math.abs(res.len - expectLen);
  if (delta > 2) console.log(`  ⚠ round-trip length delta ${delta} (stored ${res.len} vs source ${expectLen}) — inspect if unexpected.`);
  ok(`round-trip verified in browser (stripped ${res.len} chars, compiles).`);
}

async function cmdPull(flags) {
  const uuid = flags.uuid;
  if (!uuid) die("usage: pull --uuid ITEM_UUID [--out FILE]");
  const bridge = new Bridge({ world: flags.world });
  await ensureLive(bridge);
  const raw = await bridge.evalGM(`return (await fromUuid(${JSON.stringify(uuid)}))?.system?.props?.animation_script ?? "";`);
  if (!raw) die("item has no animation_script.");
  const plain = decode(raw);
  const out = flags.out || `pulled-${uuid.split(".").pop()}.js`;
  fs.writeFileSync(out, plain, "utf8");
  ok(`pulled + decoded → ${out} (${plain.length} chars).`);
}

async function cmdSfxSync(flags) {
  const bridge = new Bridge({ world: flags.world });
  await ensureLive(bridge);
  console.log("Triggering in-game Forge SFX scan (this walks the Sound/ tree)…");
  const res = await bridge.evalGM(
    `const m = await FUCompanion.api.animStudio.sfx.scan(); return { count: m?.count ?? 0 };`,
    { timeoutMs: 120000 },
  );
  ok(`scan complete — ${res.count} sounds indexed. Manifest mirrored to modules/fabula-ultima-companion/data/anim-studio/sfx-manifest.json`);
}

async function cmdHealth(flags) {
  const bridge = new Bridge({ world: flags.world });
  const h = bridge.health();
  console.log(`world: ${bridge.world}`);
  console.log(`heartbeat: ${Math.round(h.ageMs)}ms old (bootId ${h.bootId ?? "?"})`);
  // Live ping — the reliable signal (heartbeat idles even while the bridge works).
  try { const boot = await bridge.pingLive(); console.log(`bridge: ALIVE (ping ok, bootId ${boot ?? "?"})`); }
  catch { console.log("bridge: NOT RESPONDING → open the game (GM), then: FUCompanion.api.testBridge.activate()"); }
}

// ── Dispatch ─────────────────────────────────────────────────────────────

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const { positional, flags } = parseArgs(rest);
  switch (cmd) {
    case "list-templates": return cmdListTemplates();
    case "new":            return cmdNew(positional, flags);
    case "verify":         return cmdVerify(positional);
    case "encode":         return cmdEncode(positional, flags);
    case "decode":         return cmdDecode(positional, flags);
    case "push":           return cmdPush(positional, flags);
    case "pull":           return cmdPull(flags);
    case "sfx-sync":       return cmdSfxSync(flags);
    case "health":         return cmdHealth(flags);
    default:
      console.log("anim-studio — animation authoring CLI\n");
      console.log("commands: list-templates | new | verify | encode | decode | push | pull | sfx-sync | health");
      console.log("see the header of bin/anim-studio.js for usage.");
      if (cmd && cmd !== "help") process.exit(1);
  }
}

main().catch((e) => { console.error(`✗ ${e.message}`); process.exit(1); });
