/**
 * Shared by the "refresh move-engine scripts" migrations (one tiny migration per engine version that changes what plays).
 * Rewrites the Gunblade's move-engine scripts on every copy whose field holds a move-engine script of ANOTHER engine
 * version, or is still empty. A hand-made script is never touched. Scripts: _gunblade-move-engine-anims.js
 * (tools/move-engine/build/pilot-gunblade.js).
 */
import { GUNBLADE_ATTACK_SCRIPT, GUNBLADE_TRANSFORM_SCRIPT, SCRIPT_TIMING, ENGINE_VERSION } from "./_gunblade-move-engine-anims.js";

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

export { ENGINE_VERSION };
export async function refreshGunbladeScripts(game, log = () => {}) {
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
