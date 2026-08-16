// Pull every skill-shaped document's raw config out of the live world and turn
// it into the structural fingerprint map. Game must be OPEN (bridge), but there
// is no bench, no COMPUTE and no target — so a full sweep is seconds, not
// minutes, and it covers docs the behavioral collector can never reach:
// Passive skills, skip.json entries, and gear `_skill` children.
"use strict";
const { evalGM } = require("./bridge");
const { structureOf } = require("./structure-fingerprint");

// Pulled in-page. Kept deliberately narrow: only the fields structureOf reads,
// so the bridge payload stays small across ~1500 documents.
const PULL = `
const NS = "fabula-ultima-companion";
const out = [];
// The SEVENTH carrier — gear that implements itself as NUMBERS.
//
// The three tests below (table / ref / AE) are the six-carrier rule, and they
// call a finished weapon a shell: Hina's Dark Orbit puts its whole "+1 Defense
// and Magic Defense" in item_def_bonus/item_mdef_bonus with no AE at all. Every
// such doc was dropped here, so NOTHING watched it — not this golden (dropped)
// and not the behavioral one (unowned masters are never on the bench). Measured
// 2026-08-17: 862 docs (439 world masters + 423 actor-embedded) implemented
// purely in stat props / condition_* / *_logic_*. That was the gear gap.
//
// 🪤 *_ef = 100 is the DEFAULT affinity on every item, so presence proves
// nothing — only a value that DIFFERS is a carrier.
const STAT_KEYS = ["item_def_bonus", "item_mdef_bonus", "check_bonus", "damage_bonus",
  "item_baseDef", "item_baseMdef"];
const hasStatCarrier = (p) => {
  // 🪤 Test the STRING, not Number(). These props hold FORMULAS as often as
  // numbers ("300 / ACTION_TARGET_COUNT" on Fafnir's Ruinous Breath), and
  // Number() turns a formula into NaN, which !Number.isFinite() then rejects —
  // so the richest carriers were the ones being dropped. Anything non-blank and
  // not a literal zero counts.
  for (const k of STAT_KEYS) {
    const s = String(p[k] ?? "").trim();
    if (s && s !== "0") return true;
  }
  for (const k of Object.keys(p)) {
    if (/^condition_/.test(k) && String(p[k] ?? "").trim()) return true;
    if (/_logic_/.test(k) && String(p[k] ?? "").trim()) return true;
    if (/_ef$/.test(k)) { const v = Number(p[k]); if (Number.isFinite(v) && v !== 100) return true; }
  }
  return false;
};
const take = (doc, owner) => {
  const p = doc.system?.props ?? {};
  // Skip pure inventory/material shells: no tables, no refs, no AE changes,
  // and no stat/condition/logic carrier either.
  // set_bonus_table is the THIRD authored table (set-bonus.js:110, :382,
  // set-bonus-hooks.js:61,68). An Equipment Set master carries nothing else —
  // no AE, no ref, no stat prop — so omitting it here left 11 shipped set
  // mechanics watched by nothing at all.
  const hasTable = Object.keys(p.effect_table ?? {}).length
    || Object.keys(p.reaction_config_table ?? {}).length
    || Object.keys(p.set_bonus_table ?? {}).length;
  const hasRef = String(p.on_activate_effect_ref ?? "").trim() || String(p.pre_activate_effect_ref ?? "").trim();
  const hasAe = (doc.effects ?? []).some(e => (e.changes ?? []).length || e.flags?.[NS]?.reactionConfig);
  if (!hasTable && !hasRef && !hasAe && !hasStatCarrier(p)) return;
  out.push({
    name: doc.name,
    owner,
    id: doc.id,
    system: { props: p },
    effects: doc.effects.map(e => ({
      name: e.name, transfer: e.transfer, disabled: e.disabled,
      statuses: [...(e.statuses ?? [])],
      changes: (e.changes ?? []).map(c => ({ key: c.key, mode: c.mode, value: c.value })),
      system: { tags: e.system?.tags ?? [] },
      flags: { [NS]: e.flags?.[NS] ?? null },
    })),
  });
};
for (const it of game.items) take(it, "(world)");
for (const a of game.actors) for (const it of a.items) take(it, a.name);
return out;
`;

async function collectStructure({ timeoutSecs = 300 } = {}) {
  const docs = await evalGM(PULL, { timeoutSecs });
  const map = {};
  const counts = new Map();
  for (const d of docs) counts.set(`${d.owner} / ${d.name}`, (counts.get(`${d.owner} / ${d.name}`) ?? 0) + 1);
  for (const d of docs) {
    const fp = structureOf(d);
    if (!fp) continue;
    // Same disambiguation rule the behavioral collector uses: suffix the id only
    // when the name is non-unique for this owner, so keys stay stable.
    const base = `${d.owner} / ${d.name}`;
    const key = counts.get(base) > 1 ? `${base} #${String(d.id).slice(0, 6)}` : base;
    map[key] = fp;
  }
  const sorted = {};
  for (const k of Object.keys(map).sort()) sorted[k] = map[k];
  return { docs: docs.length, count: Object.keys(sorted).length, structure: sorted };
}

module.exports = { collectStructure };
