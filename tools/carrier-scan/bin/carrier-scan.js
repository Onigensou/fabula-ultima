#!/usr/bin/env node
// ───────────────────────────────────────────────────────────────────────────
// carrier-scan — "is this actually implemented?", answered by a command instead
// of by recollection.
//
// Built 2026-08-09 after a party content audit reported SIX implemented things
// as unbuilt (Quick Summoning, Perfect Aim, Resourceful, Ritual Entropism,
// Ritual Spiritism, Turbo Tonic). The audit applied the remembered rule — "a
// wired doc carries config rows / an activate ref / own damage / an AE / a
// linked _skill", plus stat props for gear. Every one of those carriers is
// LOCAL to the document, and the six missed cases were implemented in ways that
// put NOTHING on the document.
//
// The rule was not misremembered. It was incomplete, and prose can't tell you
// that. So it lives here as code, and the answer is a command:
//
//   check <name…>    full carrier report for named docs
//   sweep            every doc with NO carrier at all (the real backlog)
//   stats            carrier totals across the world
//
// Game CLOSED — reads worlds/<world>/_authored-export (the reviewable JSON that
// world-export writes), never the LevelDB, so it can't collide with a session.
//
// ── THE NINE CARRIERS ──────────────────────────────────────────────────────
//   LOCAL, read off the doc (and its linked _skill children):
//     1 reaction_config_table rows      2 effect_table rows
//     3 on/pre_activate_effect_ref      4 own damage (type_damage)
//     5 AE changes / reactionConfig / any flags[NS] key
//     6 a linked `_skill` child that itself carries something
//     7 gear stat props — *_bonus, *_ef, condition_*  (a value that DIFFERS
//       from the default; every item has *_ef = 100, which is NOT a carrier)
//   NON-LOCAL, invisible on the doc:
//     8 inbound reference — another doc names it: HAS_SKILL_<NAME> /
//       AE_COUNT_<NAME>. Owning the skill IS the mechanism.
//     9 code-backed — the engine looks it up BY NAME. Declared in
//       scripts/shared/code-backed-content.js.
//   AUTHORED CLAIM:
//    10 implementation_note — a human-written pointer on the doc itself, for
//       the residue that has no other carrier. Shows on the sheet in play.
// ───────────────────────────────────────────────────────────────────────────
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const NS = "fabula-ultima-companion";
const ROOT = path.resolve(__dirname, "..", "..", "..");
const WORLD = process.env.FU_WORLD || "fabula-ultima-2";
const EXPORT = path.join(ROOT, "worlds", WORLD, "_authored-export");
const REGISTRY = path.join(ROOT, "modules", NS, "scripts", "shared", "code-backed-content.js");

// ── helpers ────────────────────────────────────────────────────────────────
const rowsOf = (t) => Object.values(t || {}).filter((r) => r && typeof r === "object" && !r.$deleted);
const txt = (v) => String(v ?? "").trim();
const strip = (s) => String(s ?? "")
  .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ")
  .replace(/@UUID\[[^\]]*\]\{([^}]*)\}/g, "$1")
  .replace(/\s+/g, " ").trim();

// Gear stat props. A prop only counts when it differs from its default — every
// item carries all ~27 `<species>_ef` at 100, and `*_bonus` at "0".
const GEAR_PROP = /^(?:item_(?:def|mdef)_bonus|check_bonus|damage_bonus|[a-zA-Z]+_ef|condition_[a-z0-9_]+)$/;
function gearStatProps(props) {
  const out = [];
  for (const [k, v] of Object.entries(props || {})) {
    if (!GEAR_PROP.test(k)) continue;
    const s = txt(v);
    if (!s) continue;
    if (/_ef$/.test(k) && (s === "100" || s === "0")) continue;   // affinity default
    if (/_bonus$/.test(k) && (s === "0" || s === "-")) continue;  // numeric default
    if (/^condition_/.test(k) && (s === "0" || s === "false")) continue;
    out.push(`${k}=${s}`);
  }
  return out;
}

// ── load the export ────────────────────────────────────────────────────────
function loadWorld() {
  if (!fs.existsSync(EXPORT)) {
    console.error(`carrier-scan: no export at ${EXPORT}`);
    console.error(`  run: node tools/safe-edit/bin/world-export.js export   (game closed)`);
    process.exit(2);
  }
  const docs = [];        // every doc, with its owner
  const byId = new Map();
  for (const dir of ["items", "actors"]) {
    const d = path.join(EXPORT, dir);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) {
      const j = JSON.parse(fs.readFileSync(path.join(d, f), "utf8"));
      if (dir === "items") add(j, "(world)", j);
      for (const it of j.items || []) add(it, j.name, j);
    }
  }
  function add(doc, owner) {
    const rec = { doc, owner, id: doc._id, name: txt(doc.name), props: doc.system?.props || {} };
    docs.push(rec);
    if (!byId.has(rec.id)) byId.set(rec.id, rec);
  }
  // children by container
  const kids = new Map();
  for (const r of docs) {
    const c = txt(r.doc.system?.container);
    if (!c || c === "-") continue;
    if (!kids.has(c)) kids.set(c, []);
    kids.get(c).push(r);
  }
  return { docs, byId, kids };
}

// ── carrier 8: index every inbound HAS_SKILL_<NAME> / AE_COUNT_<NAME> ───────
// The token grammar bakes the name into the identifier (the tokenizer has no
// string literals): spaces -> underscores, uppercased.
function indexInbound(docs) {
  const RX = /\b(HAS_SKILL|AE_COUNT)_([A-Z][A-Z0-9_]{2,})\b/g;
  const map = new Map();   // lower name -> [{token, referrer, where}]
  for (const r of docs) {
    const blob = JSON.stringify(r.props);
    let m;
    RX.lastIndex = 0;
    while ((m = RX.exec(blob)) !== null) {
      const name = m[2].replace(/_/g, " ").toLowerCase();
      if (!map.has(name)) map.set(name, []);
      const list = map.get(name);
      const key = `${r.name}|${m[1]}`;
      if (!list.some((x) => x.key === key)) {
        list.push({ key, token: `${m[1]}_${m[2]}`, referrer: r.name, owner: r.owner });
      }
    }
  }
  return map;
}

// ── carrier 9: the declared code-backed registry ───────────────────────────
async function loadCodeBacked() {
  const map = new Map();
  let mod;
  try {
    mod = await import(`file://${REGISTRY.replace(/\\/g, "/")}`);
  } catch (e) {
    console.error(`carrier-scan: WARNING could not read the code-backed registry (${e.message})`);
    console.error(`  carrier 9 will report as unknown — do NOT trust a "no carrier" verdict.`);
    return null;
  }
  for (const e of mod.CODE_BACKED) map.set(e.name.toLowerCase(), e);

  // Families that own their own registry. Resolve them through the DELEGATED
  // entry's `namesFrom` so the names live in exactly one place. Turbo Tonic and
  // the Ritual disciplines are here — both were reported as unbuilt in the
  // 2026-08-09 audit precisely because nothing enumerated these.
  for (const d of mod.CODE_BACKED_DELEGATED) {
    const p = path.join(ROOT, "modules", NS, d.module);
    // Owning modules log on load — healing-cleanse.js uses console.DEBUG, which
    // also goes to stdout and would land in the middle of --json. Mute the whole
    // stdout-writing console surface across the import, not just .log.
    const MUTE = ["log", "info", "debug", "dir", "trace"];
    const realLog = MUTE.map((k) => [k, console[k]]);
    const restore = () => { for (const [k, fn] of realLog) console[k] = fn; };
    for (const k of MUTE) console[k] = () => {};
    try {
      const owner = await import(`file://${p.replace(/\\/g, "/")}`);
      restore();
      for (const n of d.namesFrom?.(owner[d.symbol]) ?? []) {
        const k = String(n).trim().toLowerCase();
        if (k && !map.has(k)) {
          map.set(k, { name: n, module: d.module, symbol: d.symbol, note: d.note, delegated: true });
        }
      }
    } catch (e) {
      restore();
      console.error(`carrier-scan: WARNING could not resolve ${d.symbol} from ${d.module} (${e.message})`);
      console.error(`  its family will read as "no carrier" — verify by hand before filing anything.`);
    } finally {
      restore();
    }
  }
  return map;
}

// ── the test ───────────────────────────────────────────────────────────────
function carriersFor(rec, world, inbound, codeBacked) {
  const kids = world.kids.get(rec.id) || [];
  const family = [rec, ...kids];
  const hits = [];

  for (const f of family) {
    const p = f.props;
    const tag = f === rec ? "" : ` (via _skill "${f.name}")`;
    const n1 = rowsOf(p.reaction_config_table).length;
    if (n1) hits.push({ n: 1, what: `reaction_config_table x${n1}${tag}` });
    const n2 = rowsOf(p.effect_table).length;
    if (n2) hits.push({ n: 2, what: `effect_table x${n2}${tag}` });
    if (txt(p.on_activate_effect_ref) || txt(p.pre_activate_effect_ref))
      hits.push({ n: 3, what: `activate ref${tag}` });
    // 🪤 `type_damage: "Physical"` with `damage_bonus: "0"` is the SHELL default
    // the consumable template ships — 99 of 118 consumables carry it and deal no
    // damage. Only a non-zero bonus makes this a real carrier. (Elemental Shard's
    // firing child is the true shape: VAR_ELEMENT + damage_bonus 10.)
    const dmgBonus = txt(p.damage_bonus);
    if (txt(p.type_damage) && dmgBonus && dmgBonus !== "0" && dmgBonus !== "-")
      hits.push({ n: 4, what: `own damage "${txt(p.type_damage)}" +${dmgBonus}${tag}` });
    for (const e of f.doc.effects || []) {
      const ch = (e.changes || []).length;
      const fl = Object.keys(e.flags?.[NS] || {});
      if (ch) hits.push({ n: 5, what: `AE "${e.name}" changes x${ch}${tag}` });
      else if (fl.length) hits.push({ n: 5, what: `AE "${e.name}" flags [${fl.join(",")}]${tag}` });
    }
    const gp = gearStatProps(p);
    if (gp.length) hits.push({ n: 7, what: `stat props ${gp.slice(0, 4).join(" ")}${gp.length > 4 ? " …" : ""}${tag}` });
  }
  if (kids.length && hits.some((h) => / \(via _skill /.test(h.what)))
    hits.push({ n: 6, what: `linked _skill: ${kids.map((k) => `"${k.name}"`).join(", ")}` });

  const lower = rec.name.toLowerCase();
  // The engine's own matcher strips a trailing parenthetical (ritual-actor.js
  // `normaliseName`), so "Ritual Arcanism (variant)" resolves to the registered
  // "Ritual Arcanism". Mirror it here — a scan that normalises differently from
  // the engine reports gaps that do not exist, which is the whole failure this
  // tool was built to stop.
  const base = lower.replace(/\s*\([^)]*\)\s*$/, "").trim();
  const keys = base && base !== lower ? [lower, base] : [lower];

  for (const k of keys)
    for (const ref of inbound.get(k) || [])
      hits.push({ n: 8, what: `inbound ${ref.token} <- "${ref.referrer}" (${ref.owner})` });

  for (const k of keys) {
    if (!codeBacked?.has(k)) continue;
    const e = codeBacked.get(k);
    const via = k === lower ? "" : ` [matched as "${e.name}" — trailing parenthetical stripped]`;
    hits.push({ n: 9, what: `code-backed: ${e.module} ${e.symbol} — ${e.note}${via}` });
    break;
  }

  const note = txt(rec.props.implementation_note);
  if (note) hits.push({ n: 10, what: `implementation_note: ${note}` });

  return hits;
}

// A doc worth asking the question about: it has authored prose describing
// behaviour. A bare material/key with no description isn't "unimplemented".
function isContentful(rec) {
  if (txt(rec.doc.system?.container)) return false;         // children via parent
  const p = rec.props;
  const kind = txt(p.item_type) || txt(p.skill_type);
  if (!kind) return false;
  if (/^(material|key|treasure)$/i.test(kind)) return false;
  return strip(p.description || p.skill_description).length > 25;
}

// ── PARTIALS ───────────────────────────────────────────────────────────────
// A clean `sweep` must not read as "everything else is finished". Gear almost
// always carries numbers — a weapon has damage — so carriers 4 and 7 fire for
// every weapon whether or not its PROSE mechanic exists. Venom Claw is the
// exemplar: it deals its 6 poison damage (carriers 4+7) while "each target hit
// suffers Poisoned, or Envenomed if already Poisoned" is not implemented
// anywhere. `sweep` cannot see that, so it would silently pass.
//
// A partial = the ONLY carriers are the numeric ones, but the description
// promises a conditional/status mechanic that numbers cannot express.
const MECHANIC_RX = new RegExp([
  "inflicts?", "suffers?", "becomes?", "you may", "once per", "when you (?:hit|attack|are)",
  "on hit", "instead", "ignores?", "rerolls?", "immune", "recovers?", "gains? \\w+ (?:status|point)",
  "at the (?:start|end) of", "cannot", "additional", "extra (?:turn|action|damage die)",
].join("|"), "i");
const NUMERIC_ONLY = new Set([4, 7]);

function partialFor(rec, hits) {
  if (!txt(rec.props.item_type)) return null;                 // gear only
  if (!hits.length) return null;                              // that's a sweep hit
  if (!hits.every((h) => NUMERIC_ONLY.has(h.n))) return null; // has real wiring
  const desc = strip(rec.props.description || rec.props.skill_description);
  const m = desc.match(MECHANIC_RX);
  if (!m) return null;
  return { claim: m[0], desc };
}

// ── commands ───────────────────────────────────────────────────────────────
const CARRIER_LABEL = {
  1: "config rows", 2: "effect rows", 3: "activate ref", 4: "own damage",
  5: "AE", 6: "linked _skill", 7: "gear stat props",
  8: "INBOUND reference", 9: "CODE-BACKED", 10: "implementation_note",
};

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] || "help";
  const json = argv.includes("--json");
  const args = argv.slice(1).filter((a) => !a.startsWith("--"));
  const flag = (k) => { const i = argv.indexOf(k); return i === -1 ? null : argv[i + 1]; };

  if (cmd === "help" || cmd === "--help") {
    console.log(`carrier-scan — is this actually implemented? (game CLOSED)

  node tools/carrier-scan/bin/carrier-scan.js check <name…>
  node tools/carrier-scan/bin/carrier-scan.js sweep [--owner <actor>] [--kind skill|gear]
  node tools/carrier-scan/bin/carrier-scan.js stats
      --json    machine-readable

Nine carriers; 8 (inbound HAS_SKILL_<NAME>) and 9 (code-backed) carry NOTHING
on the document, which is what makes a doc-only scan report false gaps.`);
    return 0;
  }

  const world = loadWorld();
  const inbound = indexInbound(world.docs);
  const codeBacked = await loadCodeBacked();

  if (cmd === "check") {
    if (!args.length) { console.error("check: give at least one name"); return 2; }
    const out = [];
    for (const q of args) {
      const want = q.toLowerCase();
      const found = world.docs.filter((r) => r.name.toLowerCase() === want && !txt(r.doc.system?.container));
      if (!found.length) { console.log(`\n"${q}" — NOT FOUND in the export`); continue; }
      for (const rec of found) {
        const hits = carriersFor(rec, world, inbound, codeBacked);
        out.push({ name: rec.name, owner: rec.owner, id: rec.id, carriers: hits });
        if (json) continue;
        console.log(`\n${rec.name}   [${rec.owner}]  ${rec.id}`);
        if (!hits.length) {
          console.log(`   NO CARRIER — genuinely unimplemented, or implemented somewhere this tool`);
          console.log(`   cannot see. Before filing it: check the registry, then grep from BASH`);
          console.log(`   (the Grep tool silently skips any file containing a NUL byte).`);
        }
        for (const h of hits) console.log(`   [${String(h.n).padStart(2)}] ${CARRIER_LABEL[h.n]}: ${h.what}`);
      }
    }
    if (json) console.log(JSON.stringify(out, null, 1));
    return 0;
  }

  if (cmd === "sweep" || cmd === "partials") {
    const wantOwner = flag("--owner");
    const wantKind = flag("--kind");
    const bare = [], partial = [];
    for (const rec of world.docs) {
      if (!isContentful(rec)) continue;
      if (wantOwner && rec.owner.toLowerCase() !== wantOwner.toLowerCase()) continue;
      const kind = txt(rec.props.item_type) ? "gear" : "skill";
      if (wantKind && kind !== wantKind) continue;
      const hits = carriersFor(rec, world, inbound, codeBacked);
      const desc = strip(rec.props.description || rec.props.skill_description);
      if (!hits.length) { bare.push({ owner: rec.owner, name: rec.name, kind, id: rec.id, desc: desc.slice(0, 110) }); continue; }
      const pt = partialFor(rec, hits);
      if (pt) partial.push({ owner: rec.owner, name: rec.name, kind, id: rec.id,
                             claim: pt.claim, carriers: hits.map((h) => h.n), desc: desc.slice(0, 110) });
    }
    const bySort = (a, b) => a.owner.localeCompare(b.owner) || a.name.localeCompare(b.name);
    bare.sort(bySort); partial.sort(bySort);

    if (cmd === "partials") {
      if (json) { console.log(JSON.stringify(partial, null, 1)); return 0; }
      console.log(`\ncarrier-scan partials — ${partial.length} gear doc(s) whose ONLY carriers are`);
      console.log(`numeric (damage / stat props) while the description promises a mechanic.\n`);
      let owner = null;
      for (const b of partial) {
        if (b.owner !== owner) { owner = b.owner; console.log(`  ── ${owner} ──`); }
        console.log(`   ▣ ${b.name}   (claims "${b.claim}")`);
        console.log(`       ${b.desc}`);
      }
      console.log(`\n  Heuristic, not proof — a keyword match is a prompt to READ the doc.`);
      return 0;
    }

    if (json) { console.log(JSON.stringify({ bare, partialCount: partial.length }, null, 1)); return 0; }
    console.log(`\ncarrier-scan sweep — ${bare.length} doc(s) with NO carrier of any kind\n`);
    let owner = null;
    for (const b of bare) {
      if (b.owner !== owner) { owner = b.owner; console.log(`  ── ${owner} ──`); }
      console.log(`   ${b.kind === "gear" ? "▣" : "◆"} ${b.name}`);
      console.log(`       ${b.desc}`);
    }
    console.log(`\n  ◆ skill  ▣ gear.  A listing here means "no carrier found", NOT "not`);
    console.log(`  implemented" — read the description and confirm it claims a mechanic.`);
    console.log(`\n  ⚠ This list is NOT the whole backlog. ${partial.length} more doc(s) carry only`);
    console.log(`  NUMBERS (damage / stat props) while promising a prose mechanic — a weapon`);
    console.log(`  always has damage, so those can never surface here. See:  partials`);
    return 0;
  }

  if (cmd === "stats") {
    const tally = {}; let contentful = 0, bare = 0;
    for (const rec of world.docs) {
      if (!isContentful(rec)) continue;
      contentful++;
      const hits = carriersFor(rec, world, inbound, codeBacked);
      if (!hits.length) { bare++; continue; }
      for (const n of new Set(hits.map((h) => h.n))) tally[n] = (tally[n] || 0) + 1;
    }
    if (json) { console.log(JSON.stringify({ contentful, bare, byCarrier: tally }, null, 1)); return 0; }
    console.log(`\ncarrier-scan stats — ${contentful} contentful docs\n`);
    for (const n of Object.keys(CARRIER_LABEL)) {
      const c = tally[n] || 0;
      console.log(`   [${String(n).padStart(2)}] ${CARRIER_LABEL[n].padEnd(20)} ${String(c).padStart(5)}`);
    }
    console.log(`\n   no carrier at all      ${String(bare).padStart(5)}`);
    return 0;
  }

  console.error(`carrier-scan: unknown command "${cmd}" — try help`);
  return 2;
}

main().then((c) => process.exit(c || 0)).catch((e) => { console.error(e); process.exit(1); });
