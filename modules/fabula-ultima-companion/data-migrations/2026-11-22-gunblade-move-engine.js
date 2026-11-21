/**
 * Migration: 2026-11-22-gunblade-move-engine  (Gunblade animations from the approved mockup, move-engine pilot)
 * ---------------------------------------------------------------------------
 * The three approved Gunblade moves (Sonic Katar mockup v2, round rmwqcke9s) run in the game through
 * tools/move-engine: the SAME move file the mockup page runs, on the game runtime (no hand port).
 *   - Gunblade (mODVDmjIfozcfERi): one attack script; it plays "Attack · Sword" or "Attack · Firearm" by the
 *     weapon's active form, and fires the blade (flame + Fire hit) on the action's real roll: hit with an odd
 *     Accuracy total or a Critical Success (the Gunblade passive's own rule).
 *   - Gunblade: Transform (SnGbGunbladeTfm1): the transform beat; its play_animation rows pass #gun / #sword,
 *     which pick Sword → Firearm or Firearm → Sword.
 * 2026-11-21-sonic-gunblade shipped both fields empty (the default attack played). Only a copy whose field is
 * still empty, or holds an older move-engine script, is written: a hand-made script is left alone.
 * Every copy: the world items and any actor / unlinked-token copy. Idempotent.
 * Generated scripts: _gunblade-move-engine-anims.js (tools/move-engine/build/pilot-gunblade.js).
 */
import { GUNBLADE_ATTACK_SCRIPT, GUNBLADE_TRANSFORM_SCRIPT, SCRIPT_TIMING, ENGINE_VERSION } from "./_gunblade-move-engine-anims.js";

export const key = "2026-11-22-gunblade-move-engine";
export const description = "Gunblade attack (Sword / Firearm) + transform animations from the approved mockup, through move-engine.";

const M = "fabula-ultima-companion";
const GUNBLADE = "mODVDmjIfozcfERi";
const TRANSFORM = "SnGbGunbladeTfm1";

function allItems() {
  const items = [...game.items];
  for (const a of game.actors) items.push(...a.items);
  for (const s of game.scenes) for (const t of s.tokens) if (!t.actorLink && t.actor) items.push(...t.actor.items);
  return items;
}
// a copy: the world doc by id; an embedded copy by name (+ the form flag for the weapon, the container's name for the passive)
const isGunblade = (it) => it.id === GUNBLADE || (it.name === "Gunblade" && Array.isArray(it.flags?.[M]?.weaponForms));
function isTransform(it) {
  if (it.id === TRANSFORM) return true;
  if (it.name !== "Gunblade: Transform") return false;
  const c = it.system?.container; const coll = it.parent ? it.parent.items : game.items;
  return !c || coll?.get?.(c)?.name === "Gunblade" || c === GUNBLADE;
}
// empty, or written by an earlier move-engine build (marked by the generator's header line)
const replaceable = (s) => { const t = String(s ?? "").replace(/<[^>]*>/g, "").trim(); return !t || /move-engine "gb_/.test(t); };

export async function migrate(game, log = () => {}) {
  const out = [];
  let n = 0;
  for (const it of allItems()) {
    const script = isGunblade(it) ? GUNBLADE_ATTACK_SCRIPT : isTransform(it) ? GUNBLADE_TRANSFORM_SCRIPT : null;
    if (!script) continue;
    const cur = it.system?.props?.animation_script;
    if (cur === script) continue;
    if (!replaceable(cur)) { out.push(`= ${it.parent ? `${it.parent.name} / ` : ""}${it.name} (${it.id}) has its own script — left`); continue; }
    await it.update({
      "system.props.animation_script": script,
      "system.props.animation_damage_timing_options": SCRIPT_TIMING.mode,
      "system.props.animation_damage_timing_offset": SCRIPT_TIMING.offset,
      [`flags.${M}.moveEngine`]: ENGINE_VERSION,
    });
    n++;
    out.push(`~ ${it.parent ? `${it.parent.name} / ` : ""}${it.name} (${it.id})`);
  }
  if (!n && !out.length) out.push("= Gunblade animations already set (or no Gunblade in the world)");
  for (const l of out) log(l);
  return { applied: true, summary: out.join(" | ") };
}
