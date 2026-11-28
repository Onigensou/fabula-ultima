/**
 * Migration: 2026-11-28-botc-minion-zombie
 * ---------------------------------------------------------------------------
 * Birth of the Cruel raises a corpse as a standing Minion that is Undead by species.
 * A species shows no token cue, so a healer could not tell the Minion turns heals into
 * damage. User call (2026-11-28): the raised Minion wears a PERMANENT Zombie status
 * (Zombie cue + the card's Zombie pill).
 *
 * 1. Every Birth of the Cruel copy (world item + actor-owned copies): the summon row
 *    (effect_label "botc_summon", a clone row) gets `summon_clone_statuses = "Zombie"`,
 *    which the clone path in skill-effects.js bakes onto each new Minion.
 * 2. Minions raised BEFORE this (persistent summon clones, kind "minion", named
 *    "… (Reanimated)") get the same baked Zombie now (summon-clone-status.js:
 *    no counter, directorPermanent + uncleansable).
 *
 * One-time, idempotent: a row already set and a Minion already wearing Zombie are skipped.
 */

import { bakedStatusesFor } from "../scripts/battle-director/summon-clone-status.js";

export const key = "2026-11-28-botc-minion-zombie";
export const description = "Birth of the Cruel: raised Minions wear a permanent Zombie status (new + existing).";

const M = "fabula-ultima-companion";
const STATUS = "Zombie";

function botcRows(item) {
  if (!/^birth of the cruel$/i.test(String(item?.name ?? "").trim())) return [];
  const table = item.system?.props?.effect_table;
  if (!table || typeof table !== "object") return [];
  return Object.entries(table).filter(([, r]) => r && typeof r === "object" && !r.$deleted
    && String(r.effect_label ?? "").trim() === "botc_summon"
    && String(r.summon_clone_target ?? "").trim().toLowerCase() === "true");
}

export async function migrate(game, log = () => {}) {
  const out = [];

  // 1. The summon row on every copy of the skill.
  const items = [...(game.items ?? [])];
  for (const a of game.actors ?? []) for (const it of a.items ?? []) items.push(it);
  for (const it of items) {
    for (const [rk, r] of botcRows(it)) {
      const where = `${it.parent ? `${it.parent.name} / ` : ""}${it.name} row ${rk}`;
      if (String(r.summon_clone_statuses ?? "").trim()) { out.push(`${where}: already "${r.summon_clone_statuses}"`); continue; }
      await it.update({ [`system.props.effect_table.${rk}.summon_clone_statuses`]: STATUS });
      out.push(`${where}: summon_clone_statuses = ${STATUS}`);
    }
  }

  // 2. Minions already raised.
  for (const a of game.actors ?? []) {
    const f = a.flags?.[M] ?? {};
    if (f.isPersistentSummon !== true || f.persistentSummonKind !== "minion") continue;
    if (!/\(Reanimated\)\s*$/.test(String(a.name ?? ""))) continue;
    const { add, missing } = bakedStatusesFor(STATUS, a.effects?.contents ?? []);
    if (missing.length) { out.push(`${a.name}: no "${STATUS}" status template found — skipped`); continue; }
    if (!add.length) { out.push(`${a.name} (${a.id}): already wears ${STATUS}`); continue; }
    await a.createEmbeddedDocuments("ActiveEffect", add);
    out.push(`${a.name} (${a.id}): permanent ${STATUS} added`);
  }

  if (!out.length) out.push("no Birth of the Cruel rows or raised Minions found");
  for (const l of out) log(l);
  return { applied: true, summary: out.join(" | ") };
}
