/**
 * Migration: 2026-11-23-spell-fencer-anims  (Spell Fencer animations from the approved mockup, move-engine)
 * ---------------------------------------------------------------------------
 * The approved Spell Fencer mockup (page 94H4XUhvbu42SzSYknv5e7 v2, round rmwsrvdn3) runs in the game through
 * tools/move-engine: the SAME move files the mockup page runs (moves/spell-fencer/{head,rhapsody}.js).
 *   - Spellblade Rhapsody (4qw6XEVHQmERzZ8y): the activation (mana charge, duality sigil + light column, ribbon braid,
 *     the unleash burst, the game's buff beat).
 *   - Spellweave (dDT8OrIPHFQuyfQp): the +1 Resonance pulse; its gain rows play it through a play_animation row
 *     (action_ref "Spellweave").
 * Only a copy whose field is still empty, or holds an older Spell Fencer move-engine script, is written: a hand-made
 * script is left alone. Every copy: the world items and any actor / unlinked-token copy (the class actor, Keren).
 * Idempotent. Generated scripts: _spell-fencer-anims.js (tools/move-engine/build/spell-fencer-anims.js).
 */
import { RHAPSODY_SCRIPT, RESONANCE_GAIN_SCRIPT, SCRIPT_TIMING, ENGINE_VERSION } from "./_spell-fencer-anims.js";

export const key = "2026-11-23-spell-fencer-anims";
export const description = "Spellblade Rhapsody activation + Spellweave's +1 Resonance pulse from the approved mockup, through move-engine.";

const M = "fabula-ultima-companion";
const RHAPSODY = "4qw6XEVHQmERzZ8y";
const SPELLWEAVE = "dDT8OrIPHFQuyfQp";

function allItems() {
  const items = [...game.items];
  for (const a of game.actors) items.push(...a.items);
  for (const s of game.scenes) for (const t of s.tokens) if (!t.actorLink && t.actor) items.push(...t.actor.items);
  return items;
}
// a copy: the world doc by id; an embedded copy by name
export function scriptFor(it) {
  if (it.id === RHAPSODY || it.name === "Spellblade Rhapsody") return RHAPSODY_SCRIPT;
  if (it.id === SPELLWEAVE || it.name === "Spellweave") return RESONANCE_GAIN_SCRIPT;
  return null;
}
// empty, or written by an earlier Spell Fencer move-engine build (marked by the generator's header line)
export const replaceable = (s) => { const t = String(s ?? "").replace(/<[^>]*>/g, "").trim(); return !t || /move-engine "(rhapsody|resonance_gain)"/.test(t); };

export async function migrate(game, log = () => {}) {
  const out = [];
  let n = 0;
  for (const it of allItems()) {
    const script = scriptFor(it);
    if (!script) continue;
    const cur = it.system?.props?.animation_script;
    const where = `${it.parent ? `${it.parent.name} / ` : ""}${it.name} (${it.id})`;
    if (cur === script && it.getFlag?.(M, "moveEngine") === ENGINE_VERSION) continue;
    if (!replaceable(cur)) { out.push(`= ${where} has its own script — left`); continue; }
    await it.update({
      "system.props.animation_script": script,
      "system.props.animation_damage_timing_options": SCRIPT_TIMING.mode,
      "system.props.animation_damage_timing_offset": SCRIPT_TIMING.offset,
      [`flags.${M}.moveEngine`]: ENGINE_VERSION,
    });
    n++;
    out.push(`~ ${where}`);
  }
  if (!n && !out.length) out.push("= Spell Fencer animations already set (or no Spell Fencer skills in the world)");
  for (const l of out) log(l);
  return { applied: true, summary: out.join(" | ") };
}
