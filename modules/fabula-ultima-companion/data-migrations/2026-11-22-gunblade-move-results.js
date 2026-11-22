/**
 * Migration: 2026-11-22-gunblade-move-results  (refresh the Gunblade move-engine scripts to engine 1.1.0)
 * ---------------------------------------------------------------------------
 * move-engine 1.1.0 (Phase 2, shared results): the Gunblade moves read the action's result through one shared
 * shape (hit / crit / total / fumble + the planned amount, element, affinity). Same look and the same choices as
 * 1.0.0 (odd total or crit fires the blade). 2026-11-22-gunblade-move-engine wrote 1.0.0 scripts on worlds that
 * booted v1.0.653; this rewrites a copy ONLY when its field holds a move-engine script of another engine version
 * (or is still empty). A hand-made script is left alone. Every copy. Idempotent.
 */
import { GUNBLADE_ATTACK_SCRIPT, GUNBLADE_TRANSFORM_SCRIPT, SCRIPT_TIMING, ENGINE_VERSION } from "./_gunblade-move-engine-anims.js";

export const key = "2026-11-22-gunblade-move-results";
export const description = "Gunblade animations: refresh the move-engine scripts to engine " + ENGINE_VERSION + " (shared results).";

const M = "fabula-ultima-companion";
const GUNBLADE = "mODVDmjIfozcfERi";
const TRANSFORM = "SnGbGunbladeTfm1";

function allItems() {
  const items = [...game.items];
  for (const a of game.actors) items.push(...a.items);
  for (const s of game.scenes) for (const t of s.tokens) if (!t.actorLink && t.actor) items.push(...t.actor.items);
  return items;
}
const isGunblade = (it) => it.id === GUNBLADE || (it.name === "Gunblade" && Array.isArray(it.flags?.[M]?.weaponForms));
function isTransform(it) {
  if (it.id === TRANSFORM) return true;
  if (it.name !== "Gunblade: Transform") return false;
  const c = it.system?.container; const coll = it.parent ? it.parent.items : game.items;
  return !c || coll?.get?.(c)?.name === "Gunblade" || c === GUNBLADE;
}
const replaceable = (s) => { const t = String(s ?? "").replace(/<[^>]*>/g, "").trim(); return !t || /move-engine "gb_/.test(t); };

export async function migrate(game, log = () => {}) {
  const out = [];
  let n = 0;
  for (const it of allItems()) {
    const script = isGunblade(it) ? GUNBLADE_ATTACK_SCRIPT : isTransform(it) ? GUNBLADE_TRANSFORM_SCRIPT : null;
    if (!script) continue;
    const cur = it.system?.props?.animation_script;
    if (cur === script && it.getFlag?.(M, "moveEngine") === ENGINE_VERSION) continue;
    if (!replaceable(cur)) { out.push(`= ${it.parent ? `${it.parent.name} / ` : ""}${it.name} (${it.id}) has its own script — left`); continue; }
    await it.update({
      "system.props.animation_script": script,
      "system.props.animation_damage_timing_options": SCRIPT_TIMING.mode,
      "system.props.animation_damage_timing_offset": SCRIPT_TIMING.offset,
      [`flags.${M}.moveEngine`]: ENGINE_VERSION,
    });
    n++;
    out.push(`~ ${it.parent ? `${it.parent.name} / ` : ""}${it.name} (${it.id}) → engine ${ENGINE_VERSION}`);
  }
  if (!n && !out.length) out.push("= Gunblade scripts already on engine " + ENGINE_VERSION + " (or no Gunblade)");
  for (const l of out) log(l);
  return { applied: true, summary: out.join(" | ") };
}
