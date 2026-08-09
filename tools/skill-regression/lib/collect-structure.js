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
const take = (doc, owner) => {
  const p = doc.system?.props ?? {};
  // Skip pure inventory/material shells: no tables, no refs, no AE changes.
  const hasTable = Object.keys(p.effect_table ?? {}).length || Object.keys(p.reaction_config_table ?? {}).length;
  const hasRef = String(p.on_activate_effect_ref ?? "").trim() || String(p.pre_activate_effect_ref ?? "").trim();
  const hasAe = (doc.effects ?? []).some(e => (e.changes ?? []).length || e.flags?.[NS]?.reactionConfig);
  if (!hasTable && !hasRef && !hasAe) return;
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
