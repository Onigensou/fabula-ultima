/**
 * Migration: 2026-11-26-status-vu-grants  (fold status vulnerability into the affinity ladder)
 * ---------------------------------------------------------------------------
 * User 2026-11-26: status vulnerability follows the same rule as every other affinity
 * (core p.92) instead of being forced over everything at damage time. The engine no
 * longer forces VU for Wet / Oil / Petrify / Hypothermia / Turbulence / Zombie
 * (snapshot.js resolveAffinity, action-profile.js, apply-damage-core.js); each status
 * AE grants VU on its own affinity_N instead, and the ladder folds it with gear,
 * passives and debuffs (Immune / Absorb win, a Resistance cancels it to normal).
 *
 * Wet (affinity_3), Oil (6), Petrify (5) and Turbulence (2) already carry that grant.
 * Hypothermia (Ice, affinity_7) and Zombie (Light, affinity_8) did not — they relied on
 * the forced path — so this adds `affinity_N CUSTOM "VU"` (the same form Wet uses) to
 * every copy: the Debuff library templates, Ice Fang's own Hypothermia, permanent
 * Zombie effects held by actors' items (Inferex, Bandit Zombie), and any status
 * currently sitting on an actor or an unlinked token.
 *
 * Matched by effect name or by the status id. Idempotent: a copy that already has
 * the change is left alone.
 */

export const key = "2026-11-26-status-vu-grants";
export const description = "Status vulnerability joins the affinity ladder: Hypothermia → Ice VU, Zombie → Light VU on every status copy.";

const GRANTS = [
  { name: "Hypothermia", statusId: "t2C3LKukW6LPUImk", key: "affinity_7" },
  { name: "Zombie", statusId: "bspDC7hFRTYuwdhf", key: "affinity_8" },
];

function grantFor(effect) {
  const statuses = new Set(Array.from(effect?.statuses ?? []));
  return GRANTS.find((g) => effect?.name === g.name || statuses.has(g.statusId)) ?? null;
}

async function patchEffects(parent, label, out) {
  const updates = [];
  for (const e of parent?.effects ?? []) {
    const g = grantFor(e);
    if (!g) continue;
    const changes = foundry.utils.deepClone(e.changes ?? []);
    if (changes.some((c) => String(c.key).replace(/^system\.props\./, "") === g.key)) continue;
    changes.push({ key: g.key, mode: 0, value: "VU", priority: null });
    updates.push({ _id: e.id, changes });
  }
  if (!updates.length) return 0;
  await parent.updateEmbeddedDocuments("ActiveEffect", updates);
  out.push(`~ ${label}: ${updates.length} effect(s)`);
  return updates.length;
}

export async function migrate(game, log = () => {}) {
  const out = [];
  let n = 0;
  for (const item of game.items ?? []) n += await patchEffects(item, `Item ${item.name}`, out);
  for (const actor of game.actors ?? []) {
    n += await patchEffects(actor, `Actor ${actor.name}`, out);
    for (const item of actor.items ?? []) n += await patchEffects(item, `${actor.name} / ${item.name}`, out);
  }
  for (const scene of game.scenes ?? []) {
    for (const t of scene.tokens ?? []) {
      if (t.actorLink || !t.actor) continue;
      n += await patchEffects(t.actor, `${scene.name} / ${t.name}`, out);
    }
  }
  for (const l of out) log(l);
  return { applied: true, summary: `${n} status effect(s) given their VU grant` + (out.length ? ` | ${out.join(" | ")}` : "") };
}
