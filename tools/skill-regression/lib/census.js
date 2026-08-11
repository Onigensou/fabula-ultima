// ───────────────────────────────────────────────────────────────────────────
// census — "what does the whole corpus actually look like, and what is the
// config golden BLIND to?"
//
// Why this exists as a standing command instead of a one-off script:
//
// On 2026-08-10 the config golden was an allowlist of 28 hand-picked props. Two
// of those had been added only because a real live edit produced NO drift — the
// blind spot announced itself twice before anyone went looking. A throwaway
// census then found **113 of 141 prop keys unwatched**, including
// `custom_logic_action` / `custom_logic_resolution` / `passive_logic_action`
// (255 docs of EXECUTABLE behaviour) and `weapon_range`, the exact prop whose
// blank value silently killed 10 melee gates.
//
// The flip to a denylist fixed that instance. This command exists so the NEXT
// instance is found by running a command rather than by a defect: it answers
// "which props does the engine READ that the golden does not WATCH", which is
// the precise shape of the blind spot, and it is cheap enough to run on a whim.
//
// Reads the game-CLOSED authored export by default (fast, no bridge, works
// while Foundry is shut for a commit); `--live` drives the bridge instead.
// ───────────────────────────────────────────────────────────────────────────
"use strict";

const fs = require("fs");
const path = require("path");
const { isChurn } = require("./structure-fingerprint");

const NS = "fabula-ultima-companion";

// ── Reviewed and deliberately churn ────────────────────────────────────────
// These ARE read by engine code, so the raw "unwatched + read" test flags them
// forever. Each was looked at and judged presentational or per-copy; the reason
// is recorded so the next reader does not have to re-derive it, and so anything
// NOT on this list stands out alone instead of being lost in 13 lines of noise.
//
// A gate that cries wolf gets ignored, which is worse than no gate. Removing an
// entry here is how you re-open the question.
const ACKNOWLEDGED = {
  name: "the golden's KEY is `<owner> / <name>` — watching it too would double-report every rename",
  id: "document identity, not authored content; ids are per-copy and collide across duplicated actors",
  uuid: "same as id",
  img: "artwork; read only by sheet/chat/character-creator rendering",
  description: "prose. Read by actor-shape/equipment-swap for DISPLAY and by the action reader for its own parse, never as a behaviour gate",
  skill_description: "prose; healing-actions reads it to render the chat line",
  flavor_text: "prose; class-registry surfaces it in the class picker",
  level: "legitimately per-copy — the same master sits at different ranks on different actors",
  max_level: "same as level",
  animation_script: "presentation; 632 docs of HTML would swamp the diff surface this tool exists to keep readable",
  animation_preload_urls: "presentation (JB2A asset URLs)",
  animation_damage_timing_offset: "presentation timing",
  animation_damage_timing_options: "presentation timing",
};

// Engine source: where a prop READ would live. Anything outside this is a
// consumer we do not gate behaviour on (tools, docs, the export layer).
const ENGINE_DIRS = [
  path.resolve(__dirname, "../../../modules/fabula-ultima-companion/scripts"),
];

const EXPORT_DIR = path.resolve(
  __dirname,
  "../../../worlds/fabula-ultima-2/_authored-export"
);

/** Every .js under the engine tree, read once. */
function engineSources() {
  const out = [];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".js")) {
        try { out.push({ file: p, text: fs.readFileSync(p, "utf8") }); } catch { /* unreadable */ }
      }
    }
  };
  for (const root of ENGINE_DIRS) walk(root);
  return out;
}

/**
 * Does engine code READ this prop?
 *
 * Comment lines are stripped first — this whole exercise exists because a prop
 * was *described* in comments while nothing read it, and the reverse (a real
 * read that only appears in a comment) would be a false positive that hides a
 * blind spot. Only counts hits that look like a property access or a string
 * key, not a bare substring, so `class` does not match `className`.
 */
function buildReaderIndex(sources) {
  const stripped = sources.map((s) => ({
    file: s.file,
    text: s.text
      .split("\n")
      .filter((l) => {
        const t = l.trim();
        return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
      })
      .join("\n"),
  }));
  return (key) => {
    // Must be a PROPS-qualified read. A bare `.${key}` match is useless here:
    // `.name`, `.level`, `.img` and `.id` exist on every Foundry document, so
    // the first draft reported 13 "blind spots" that were all reads of a
    // document field with the same name as a prop — noise that would have
    // trained the reader to ignore the gate.
    //
    // Covered forms (the ones this codebase actually uses):
    //   system.props.<key>   props.<key>   props?.<key>
    //   props["<key>"]       props?.["<key>"]
    //   p.<key>  /  p?.<key>     — `const p = doc.system.props` is the house idiom
    //   "<key>" passed to a prop reader (readPropNum(actor, "current_mp"))
    const k = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(
      `props\\??\\.${k}\\b` +
      `|props\\??\\.?\\[["'\`]${k}["'\`]\\]` +
      `|\\bp\\??\\.${k}\\b` +
      `|readProp\\w*\\([^)]*["'\`]${k}["'\`]`
    );
    const hits = [];
    for (const s of stripped) {
      if (re.test(s.text)) hits.push(path.basename(s.file));
      if (hits.length >= 4) break;
    }
    return hits;
  };
}

/** The same doc population `collect-structure.js` fingerprints. */
function isShaped(doc) {
  const p = doc?.system?.props ?? {};
  const hasTable =
    Object.keys(p.effect_table ?? {}).length ||
    Object.keys(p.reaction_config_table ?? {}).length;
  const hasRef =
    String(p.on_activate_effect_ref ?? "").trim() ||
    String(p.pre_activate_effect_ref ?? "").trim();
  const hasAe = (doc.effects ?? []).some(
    (e) => (e.changes ?? []).length || e.flags?.[NS]?.reactionConfig
  );
  return !!(hasTable || hasRef || hasAe);
}

/** Walk the authored export and tally every prop key on every shaped doc. */
function censusFromExport() {
  const keys = new Map(); // key -> { docs, values:Set, sample }
  let docCount = 0;

  const take = (doc, owner) => {
    const p = doc?.system?.props;
    if (!p || typeof p !== "object") return;
    if (!isShaped(doc)) return;
    docCount++;
    for (const [k, v] of Object.entries(p)) {
      if (!keys.has(k)) keys.set(k, { docs: 0, values: new Set(), sample: null });
      const e = keys.get(k);
      e.docs++;
      const s = typeof v === "object" ? JSON.stringify(v) : String(v);
      if (e.values.size < 200) e.values.add(s.slice(0, 80));
      if (!e.sample && s.trim() && s.trim() !== "0" && s.trim() !== "false") {
        e.sample = `${owner} / ${doc.name}: ${s.slice(0, 60)}`;
      }
    }
  };

  for (const dir of ["items", "actors"]) {
    const full = path.join(EXPORT_DIR, dir);
    let files;
    try { files = fs.readdirSync(full); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      let d;
      try { d = JSON.parse(fs.readFileSync(path.join(full, f), "utf8")); } catch { continue; }
      if (dir === "items") take(d, "(world)");
      for (const it of d.items ?? []) take(it, dir === "actors" ? d.name : "(world)");
    }
  }
  return { keys, docCount };
}

/**
 * @returns {{docCount:number, rows:Array, blind:Array, exportMissing:boolean}}
 *   rows  — every prop key with docs / distinct / watched / readers
 *   blind — the actionable subset: engine READS it, the golden does NOT watch it
 */
function runCensus() {
  if (!fs.existsSync(EXPORT_DIR)) {
    return { docCount: 0, rows: [], blind: [], exportMissing: true };
  }
  const { keys, docCount } = censusFromExport();
  const readersOf = buildReaderIndex(engineSources());

  const rows = [...keys.entries()].map(([k, e]) => {
    const watched = !isChurn(k);
    const readers = readersOf(k);
    return {
      key: k,
      docs: e.docs,
      distinct: e.values.size,
      watched,
      readers,
      sample: e.sample,
    };
  });
  rows.sort((a, b) => b.docs - a.docs);

  // The blind spot: engine-read, classified as churn, and NOT already reviewed.
  // Under a denylist this should be EMPTY — a hit means the churn list ate real
  // content, or a new prop needs a verdict.
  const readChurn = rows.filter((r) => !r.watched && r.readers.length > 0);
  const blind = readChurn.filter((r) => !(r.key in ACKNOWLEDGED));
  const acknowledged = readChurn.filter((r) => r.key in ACKNOWLEDGED);
  // A stale acknowledgement is its own rot: the key is gone, or it is watched
  // now, and the entry silently protects nothing.
  const staleAck = Object.keys(ACKNOWLEDGED).filter(
    (k) => !readChurn.some((r) => r.key === k)
  );
  return { docCount, rows, blind, acknowledged, staleAck, exportMissing: false };
}

module.exports = { runCensus, ACKNOWLEDGED };
