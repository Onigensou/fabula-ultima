/**
 * Migration: 2026-11-21-spirit-hawk-art  (placeholder art for the Spirit Hawk)
 * ---------------------------------------------------------------------------
 * User 2026-11-21: "find something from Ragnarok Online asset to use as spirit
 * hawk for now". The Hunter's falcon (RO data.grf sprite\이팩트\매) rendered by
 * the RO monster converter, uploaded to Forge Character/Ragnarok Online/hunter_falcon/.
 * The falcon has only 2 motions (fly, dive), so walk = idle, hurt = attack,
 * die = idle. Art is drawn facing left (RO direction 1).
 *
 * Runs after warden-hawk-author (which rebuilds the hawk's sheet from King
 * Gorger and copies the old placeholder image into every art field).
 * SEED-ONLY: gated by flags.fabula-ultima-companion.spiritHawkArt on the actor.
 */

export const key = "2026-11-21-spirit-hawk-art";
export const description = "Spirit Hawk: placeholder Ragnarok Online falcon art (portrait, battle poses, token).";

const M = "fabula-ultima-companion";
const FLAG = "spiritHawkArt";
const HAWK = "GnEmdc02BDDTmeaU";
const BASE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Character/Ragnarok%20Online/hunter_falcon/hunter_falcon_";
const PNG = `${BASE}standard.png`;
const ART = {
  img: PNG, sprite_standard: PNG,
  sprite_battle: `${BASE}idle.webm`, sprite_walk: `${BASE}walk.webm`,
  sprite_attack: `${BASE}attack.webm`, sprite_hurt: `${BASE}hurt.webm`, sprite_ko: `${BASE}die.webm`,
  cut_in_critical: PNG, cut_in_fumble: PNG, cut_in_zero_power: PNG,
  battle_facing_direction: "left",
};

export async function migrate(game, log = () => {}) {
  const hawk = game.actors.get(HAWK);
  if (!hawk) { log("Spirit Hawk missing, skipped"); return { applied: false, summary: "no hawk" }; }
  if (hawk.getFlag(M, FLAG)) { log("Spirit Hawk art already set"); return { applied: true, summary: "already" }; }
  const props = hawk.system?.props ?? {};
  const upd = { img: PNG, [`flags.${M}.${FLAG}`]: true, "prototypeToken.texture.src": PNG };
  const set = [];
  for (const [k, v] of Object.entries(ART)) if (k in props) { upd[`system.props.${k}`] = v; set.push(k); }
  await hawk.update(upd);
  log(`Spirit Hawk art set (${set.join(", ")})`);
  return { applied: true, summary: `art fields: ${set.length}` };
}
