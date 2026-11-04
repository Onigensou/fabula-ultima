// ============================================================================
// Default action animations — the pure rules.
//
// An action with no `animation_script` of its own still gets a short JRPG beat:
// the actor steps in, one RPG Maker MV effect plays on the target, the actor
// steps back. This file decides WHAT plays; action-anim-script.js turns the
// decision into an animation script; director-animation.js picks it up when an
// action has nothing authored. Approved from the mockup on 2026-11-04
// (claude.ai/artifact/HzuaMMcURoiedtmBPqikji) — the tables below are the ones
// that mockup ran, so a change here is a change to what the user signed off.
//
//   Attacks — by weapon category x element x outcome (hit / crit / miss).
//   Skills  — the "fallback composer": one beat per effect the skill carries,
//             in the order the engine applies them (pre-damage hook, damage,
//             post-damage effects). A beat that needs the hit drops on a miss.
//
// Pure on purpose (no Foundry globals): action-anim-rules.test.mjs covers it.
// ============================================================================

export const MV_BASE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Animation/RPG%20Maker%20MV/";
export const SFX_BASE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/";

// RPG Maker MV clips used by the defaults, from the library's manifest.json:
// native px size, anchor (fraction), length, MV position (center = body,
// feet = ground point), and the target-flash frames (ms) = the contact frames.
export const MV_CLIPS = {
  "001_hit_physical": { w: 488, h: 488, ax: 0.5, ay: 0.5, dur: 333, pos: "center", flashes: [0] },
  "002_hit_effect": { w: 488, h: 488, ax: 0.5, ay: 0.5, dur: 400, pos: "center", flashes: [67] },
  "003_hit_fire": { w: 440, h: 440, ax: 0.5, ay: 0.5273, dur: 667, pos: "center", flashes: [0] },
  "004_hit_ice": { w: 528, h: 528, ax: 0.5, ay: 0.5227, dur: 733, pos: "center", flashes: [0] },
  "005_hit_thunder": { w: 580, h: 580, ax: 0.5, ay: 0.5207, dur: 667, pos: "center", flashes: [0] },
  "006_slash_physical": { w: 378, h: 378, ax: 0.4683, ay: 0.5794, dur: 333, pos: "center", flashes: [0] },
  "007_slash_effect": { w: 440, h: 394, ax: 0.4023, ay: 0.5558, dur: 333, pos: "center", flashes: [67] },
  "008_slash_fire": { w: 408, h: 408, ax: 0.4706, ay: 0.6471, dur: 600, pos: "center", flashes: [0] },
  "009_slash_ice": { w: 408, h: 408, ax: 0.4706, ay: 0.6471, dur: 533, pos: "center", flashes: [0] },
  "010_slash_thunder": { w: 408, h: 408, ax: 0.4706, ay: 0.6471, dur: 600, pos: "center", flashes: [0] },
  "011_pierce_physical": { w: 660, h: 660, ax: 0.5, ay: 0.503, dur: 467, pos: "center", flashes: [133] },
  "012_pierce_effect": { w: 660, h: 660, ax: 0.5, ay: 0.5, dur: 600, pos: "center", flashes: [67] },
  "013_pierce_fire": { w: 594, h: 594, ax: 0.5, ay: 0.5202, dur: 733, pos: "center", flashes: [133] },
  "014_pierce_ice": { w: 594, h: 594, ax: 0.5, ay: 0.5202, dur: 800, pos: "center", flashes: [133] },
  "015_pierce_thunder": { w: 594, h: 594, ax: 0.5, ay: 0.5202, dur: 733, pos: "center", flashes: [133] },
  "016_claw_physical": { w: 336, h: 336, ax: 0.5, ay: 0.5774, dur: 400, pos: "center", flashes: [67] },
  "017_claw_effect": { w: 374, h: 374, ax: 0.5, ay: 0.5267, dur: 533, pos: "center", flashes: [67] },
  "018_claw_fire": { w: 376, h: 382, ax: 0.5532, ay: 0.5079, dur: 600, pos: "center", flashes: [67] },
  "019_claw_ice": { w: 352, h: 342, ax: 0.5199, ay: 0.5673, dur: 533, pos: "center", flashes: [67] },
  "020_claw_thunder": { w: 352, h: 346, ax: 0.5227, ay: 0.5607, dur: 600, pos: "center", flashes: [67] },
  "021_hit_special_1": { w: 994, h: 986, ax: 0.492, ay: 0.4848, dur: 1333, pos: "center", flashes: [133, 400, 600, 1000] },
  "022_hit_special_2": { w: 730, h: 802, ax: 0.5137, ay: 0.4564, dur: 1533, pos: "center", flashes: [0, 200, 800, 933] },
  "023_slash_special_1": { w: 860, h: 762, ax: 0.4814, ay: 0.5236, dur: 1267, pos: "center", flashes: [67, 200, 333, 467, 600, 733, 1000] },
  "024_slash_special_2": { w: 556, h: 556, ax: 0.5, ay: 0.5216, dur: 1267, pos: "center", flashes: [67, 467, 600, 1067] },
  "025_slash_special_3": { w: 1186, h: 1206, ax: 0.5, ay: 0.5473, dur: 2267, pos: "screen", flashes: [67, 533, 1000, 1467] },
  "026_pierce_special_1": { w: 816, h: 816, ax: 0.5, ay: 0.5, dur: 1400, pos: "center", flashes: [133, 267, 400, 533, 800] },
  "027_pierce_special_2": { w: 740, h: 728, ax: 0.4919, ay: 0.5, dur: 1467, pos: "center", flashes: [133, 267, 467, 667, 867, 1067, 1133] },
  "028_claw_special": { w: 600, h: 600, ax: 0.5, ay: 0.53, dur: 2200, pos: "center", flashes: [67, 267, 467, 667, 1133] },
  "029_arrow_special": { w: 1194, h: 1254, ax: 0.4975, ay: 0.5104, dur: 1467, pos: "center", flashes: [133, 333, 533, 867] },
  "030_general_special_1": { w: 480, h: 572, ax: 0.5, ay: 0.5944, dur: 1333, pos: "center", flashes: [67, 333, 533, 800, 1000, 1133] },
  "031_general_special_2": { w: 436, h: 504, ax: 0.5459, ay: 0.4841, dur: 1933, pos: "center", flashes: [67, 333, 733, 1000] },
  "041_heal_one_1": { w: 546, h: 548, ax: 0.5, ay: 0.885, dur: 1400, pos: "feet", flashes: [0, 400] },
  "051_powerup_1": { w: 508, h: 790, ax: 0.5, ay: 0.543, dur: 867, pos: "feet", flashes: [333] },
  "054_powerdown_1": { w: 508, h: 656, ax: 0.5, ay: 0.628, dur: 867, pos: "feet", flashes: [333] },
  "111_shoot_normal": { w: 584, h: 584, ax: 0.5, ay: 0.5, dur: 933, pos: "center", flashes: [133] },
  // gains + item effects (approved on the mockup's Item tab, 2026-11-04)
  "045_cure_one_1": { w: 700, h: 754, ax: 0.5, ay: 0.561, dur: 1133, pos: "feet", flashes: [67, 133, 200, 400, 667] },
  "052_powerup_2": { w: 508, h: 630, ax: 0.5, ay: 0.6508, dur: 1200, pos: "feet", flashes: [267, 1000] },
  "053_powerup_3": { w: 354, h: 354, ax: 0.5, ay: 0.6695, dur: 1867, pos: "center", flashes: [0] },
  // an item that deals damage: the element's "one target" spell clip
  "066_fire_one_1": { w: 776, h: 784, ax: 0.5, ay: 0.8827, dur: 733, pos: "feet", flashes: [67, 267, 467] },
  "072_ice_one_2": { w: 488, h: 488, ax: 0.5, ay: 0.7951, dur: 800, pos: "feet", flashes: [200] },
  "076_thunder_one_1": { w: 624, h: 704, ax: 0.5, ay: 0.858, dur: 467, pos: "feet", flashes: [133, 267] },
  "086_earth_one_1": { w: 680, h: 680, ax: 0.5, ay: 0.5, dur: 1333, pos: "center", flashes: [333, 467, 600, 800] },
  "091_wind_one_1": { w: 508, h: 510, ax: 0.5, ay: 0.8529, dur: 1000, pos: "feet", flashes: [333, 533] },
  "096_light_one_1": { w: 662, h: 682, ax: 0.5, ay: 0.8666, dur: 1533, pos: "feet", flashes: [400, 533] },
  "101_darkness_one_1": { w: 546, h: 546, ax: 0.5, ay: 0.5, dur: 1467, pos: "center", flashes: [667, 800] },
  "059_poison": { w: 392, h: 394, ax: 0.5, ay: 0.8198, dur: 1000, pos: "feet", flashes: [67, 200, 333] },
  // Ragnarok Online (native RO resolution — scaleMul brings it level with the MV clips)
  "ro_food_int": { w: 456, h: 456, ax: 0.5, ay: 0.6316, dur: 1500, pos: "feet", flashes: [250], ro: "food_int", scaleMul: 2.2 },
};
export const RO_BASE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Animation/Ragnarok%20Online/";
export const clipUrl = (key) => (MV_CLIPS[key]?.ro ? RO_BASE + MV_CLIPS[key].ro + ".webm" : MV_BASE + key + ".webm");

// Battle sounds (Forge Sound/). The mockup's volumes x0.7 — the user found
// them loud overall in the 2026-11-04 Foundry demo (BD's own hit sound also
// plays at the damage moment, on top of these).
export const SFX = {
  swing:  { path: "Soundboard/SE_SWINGA.wav",          vol: 0.35 },
  slash:  { path: "Soundboard/SE_BTL_HitSlashS.ogg",   vol: 0.38 },
  blow:   { path: "Soundboard/SE_BTL_HitBlowS.ogg",    vol: 0.38 },
  blowM:  { path: "Soundboard/SE_BTL_HitBlowM.ogg",    vol: 0.38 },
  pierce: { path: "Hit_Piercing.wav",                  vol: 0.38 },
  crit:   { path: "Soundboard/SE_BTL_HitCritical.ogg", vol: 0.42 },
  fire:   { path: "Soundboard/SE_BTL_HitFire.ogg",     vol: 0.32 },
  ice:    { path: "Soundboard/SE_BTL_HitIce_1.mp3",    vol: 0.32 },
  bolt:   { path: "Soundboard/SE_BTL_HitElectric.ogg", vol: 0.32 },
  gun:    { path: "GunshotA.ogg",                      vol: 0.15 },   // user: 0.5 was too loud
  bow:    { path: "Soundboard/Crossbow.ogg",           vol: 0.38 },
  heal:   { path: "Soundboard/Heal3.ogg",              vol: 0.35 },
  up:     { path: "Soundboard/Powerup.ogg",            vol: 0.35 },
  down:   { path: "Soundboard/Down2.ogg",              vol: 0.35 },
  item:   { path: "Soundboard/Item1.ogg",              vol: 0.4 },   // the item-use chime
};
export const sfxUrl = (key) => (SFX[key] ? SFX_BASE + SFX[key].path : null);

// ── Attacks ─────────────────────────────────────────────────────────────

// motion: melee = step in / swing / step back; arrow / throw / gun = fire from
// where the actor stands. `scale` multiplies the clip size; `quick` = shorter,
// faster step; `magic` = Physical uses the _effect clip.
export const CATEGORY = {
  Sword:    { motion: "melee", family: "slash",  scale: 1.0,  sfx: "slash" },
  Dagger:   { motion: "melee", family: "slash",  scale: 0.8,  sfx: "slash", quick: true },
  Spear:    { motion: "melee", family: "pierce", scale: 1.0,  sfx: "pierce" },
  Heavy:    { motion: "melee", family: "hit",    scale: 1.25, sfx: "blowM", shake: true },
  Brawling: { motion: "melee", family: "hit",    scale: 0.9,  sfx: "blow", quick: true },
  Flail:    { motion: "melee", family: "claw",   scale: 1.05, sfx: "slash" },
  Arcane:   { motion: "melee", family: "hit",    scale: 1.0,  sfx: "blow", magic: true },
  Bow:      { motion: "arrow", family: "pierce", scale: 0.9,  sfx: "pierce", crit: "029_arrow_special" },
  Thrown:   { motion: "throw", family: "hit",    scale: 0.9,  sfx: "blow" },
  Firearm:  { motion: "gun",   family: "pierce", scale: 0.9,  sfx: "pierce", physical: "111_shoot_normal", crit: "111_shoot_normal" },
};
export const FAMILY = {
  hit:    { physical: "001_hit_physical",    effect: "002_hit_effect",    fire: "003_hit_fire",    ice: "004_hit_ice",    thunder: "005_hit_thunder",    crit: "021_hit_special_1" },
  slash:  { physical: "006_slash_physical",  effect: "007_slash_effect",  fire: "008_slash_fire",  ice: "009_slash_ice",  thunder: "010_slash_thunder",  crit: "023_slash_special_1" },
  pierce: { physical: "011_pierce_physical", effect: "012_pierce_effect", fire: "013_pierce_fire", ice: "014_pierce_ice", thunder: "015_pierce_thunder", crit: "026_pierce_special_1" },
  claw:   { physical: "016_claw_physical",   effect: "017_claw_effect",   fire: "018_claw_fire",   ice: "019_claw_ice",   thunder: "020_claw_thunder",   crit: "028_claw_special" },
};
// FU's nine damage types. Elements without their own MV clip tint the yellow
// _effect clip: hue = degrees, sat / bright = 1 means unchanged (applied with a
// PIXI ColorMatrixFilter in the script).
export const ELEMENT = {
  Physical: { suffix: "physical" },
  Fire:     { suffix: "fire",    sfx: "fire" },
  Ice:      { suffix: "ice",     sfx: "ice" },
  Bolt:     { suffix: "thunder", sfx: "bolt" },
  Air:      { suffix: "effect",  tint: { hue: 80,  sat: 1.2, bright: 1 } },
  Earth:    { suffix: "effect",  tint: { hue: -25, sat: 0.8, bright: 0.85 } },
  Dark:     { suffix: "effect",  tint: { hue: 210, sat: 1.3, bright: 0.7 } },
  Light:    { suffix: "effect",  tint: { hue: 0,   sat: 0.5, bright: 1.3 } },
  Poison:   { suffix: "effect",  tint: { hue: 245, sat: 1.4, bright: 1 } },
};

const lc = (v) => String(v ?? "").trim().toLowerCase();

// Weapon category text → a CATEGORY key. Blank or unknown (every NPC attack
// item, an unarmed PC) → Brawling, the plain "hit".
export function normalizeCategory(raw) {
  const s = lc(raw);
  if (!s) return "Brawling";
  for (const k of Object.keys(CATEGORY)) if (lc(k) === s) return k;
  if (/sword|blade|katana/.test(s)) return "Sword";
  if (/dagger|knife/.test(s)) return "Dagger";
  if (/spear|lance|polearm/.test(s)) return "Spear";
  if (/heavy|axe|hammer/.test(s)) return "Heavy";
  if (/flail|whip|chain/.test(s)) return "Flail";
  if (/arcane|staff|wand|rod/.test(s)) return "Arcane";
  if (/bow/.test(s)) return "Bow";
  if (/thrown|throw/.test(s)) return "Thrown";
  if (/fire ?arm|gun|rifle|pistol/.test(s)) return "Firearm";
  return "Brawling";
}

// Damage-type text → an ELEMENT key. Healing / none / unknown → Physical (the
// caller decides separately whether there is damage at all).
export function normalizeElement(raw) {
  const s = lc(raw);
  for (const k of Object.keys(ELEMENT)) if (lc(k) === s) return k;
  if (/thunder|lightning|electric/.test(s)) return "Bolt";
  if (/wind/.test(s)) return "Air";
  if (/shadow/.test(s)) return "Dark";
  if (/holy/.test(s)) return "Light";
  return "Physical";
}

// Per-target results → one outcome for the whole action. Any crit = crit; every
// target missed = miss; unknown (no results) = hit, as every script assumed.
export function summarizeOutcome(perTargetResults) {
  const rows = Array.isArray(perTargetResults) ? perTargetResults.filter(Boolean) : [];
  if (!rows.length) return "hit";
  if (rows.some((r) => r.crit)) return "crit";
  if (rows.every((r) => r.hit === false && !r.pierceMiss)) return "miss";
  return "hit";
}

// The attack default. preset (an MV clip key from a weapon's
// attack_anim_preset) replaces the clip but keeps the motion.
export function pickAttack({ category, element, outcome = "hit", preset = null } = {}) {
  const catKey = CATEGORY[category] ? category : "Brawling";
  const elKey = ELEMENT[element] ? element : "Physical";
  const cat = CATEGORY[catKey], el = ELEMENT[elKey];
  const crit = outcome === "crit", miss = outcome === "miss";
  const suffix = (cat.magic && elKey === "Physical") ? "effect" : el.suffix;
  let clip;
  if (crit) clip = cat.crit ?? FAMILY[cat.family].crit;
  else if (catKey === "Firearm" && elKey === "Physical") clip = cat.physical;
  else clip = FAMILY[cat.family][suffix];
  const tint = (!crit && suffix === "effect") ? (el.tint ?? null) : null;
  const usePreset = !!(preset && MV_CLIPS[preset]);
  return {
    category: catKey, element: elKey, outcome,
    motion: cat.motion, quick: !!cat.quick, shake: !!cat.shake || crit,
    clip: miss ? null : (usePreset ? preset : clip),
    tint: usePreset ? null : tint,
    // crit clips are already big; the mockup shrank them a touch
    scale: cat.scale * (crit && !usePreset ? 0.9 : 1),
    sfx: { swing: cat.motion === "melee" || cat.motion === "throw" ? "swing" : cat.motion === "arrow" ? "bow" : cat.motion === "gun" ? "gun" : null,
      hit: miss ? null : cat.sfx, element: miss ? null : (el.sfx ?? null), crit: crit ? "crit" : null },
    source: usePreset ? "preset" : "category",
  };
}

// ── Skills: the fallback composer ───────────────────────────────────────

// Gains (heal / mp / shield / zp) carry no sound of their own: BD's gain number
// already plays one (playResourceGainVfx) — one sound per moment.
export const BEAT = {
  heal:    { clip: "041_heal_one_1",  sfx: null },
  mp:      { clip: "ro_food_int",     sfx: null },
  shield:  { clip: "053_powerup_3",   sfx: null },
  zp:      { clip: "052_powerup_2",   sfx: null },
  buff:    { clip: "051_powerup_1",   sfx: "up" },
  debuff:  { clip: "054_powerdown_1", sfx: "down" },
  cleanse: { clip: "045_cure_one_1",  sfx: "up" },
};
// An item that deals damage plays its element's "one target" clip.
export const ITEM_ELEMENT_CLIP = {
  Physical: "001_hit_physical", Fire: "066_fire_one_1", Ice: "072_ice_one_2", Bolt: "076_thunder_one_1",
  Earth: "086_earth_one_1", Air: "091_wind_one_1", Light: "096_light_one_1", Dark: "101_darkness_one_1", Poison: "059_poison",
};
const HEALING_TYPES = new Set(["healing", "heal", "hp_heal", "mp_heal", "hp", "mp", "recovery"]);
const NONDAMAGING = new Set(["", "none", "n/a", "-", "any", "no", "support"]);
const SELF_REFS = new Set(["self", "own_summons", "own_phantasms", "own_persistent_summons", "own_minions", "own_numen", "last_summoned", "field"]);
const MAX_BEATS = 3;

function rowsOf(props) {
  const t = props?.effect_table ?? props?.reaction_effect_table ?? null;
  return t ? Object.values(t).filter((r) => r && !r.$deleted) : [];
}
const recipientOf = (row) => (SELF_REFS.has(lc(row.target_ref)) ? "self" : "target");
const needsHit = (row) => /^hit_/.test(lc(row.target_ref));

// One effect row → a beat, or null when it has no visible meaning (a menu, a
// cost, a damage adjustment). `aeTagOf(name)` answers "buff" | "debuff" | null
// for an AE template name; without a tag, what lands on the caster's side is a
// buff and what lands on the target is a debuff.
function beatOfRow(row, { aeTagOf, harmful }) {
  const k = lc(row.effect_kind);
  const to = recipientOf(row);
  if (k === "apply_ae") {
    const tag = aeTagOf ? aeTagOf(String(row.ae_template_ref ?? "").trim()) : null;
    const kind = tag === "buff" || tag === "debuff" ? tag : (to === "self" || !harmful ? "buff" : "debuff");
    return { k: kind, to, needsHit: needsHit(row) };
  }
  if (k === "grant") {
    const kind = { hp: "heal", mp: "mp", shield: "shield", zero_power: "zp" }[lc(row.grant_resource)];
    return kind ? { k: kind, to, needsHit: needsHit(row) } : null;
  }
  if (k === "deal_damage") return { k: "damage", to: "target", needsHit: needsHit(row) };
  if (k === "remove_tagged_ae") {
    const f = lc(row.filter_tag);
    if (f === "debuff") return { k: "cleanse", to, needsHit: false };       // cleanse
    if (f === "buff") return { k: "debuff", to, needsHit: needsHit(row) };  // dispel
  }
  if (k === "remove_ae") return { k: "cleanse", to, needsHit: false };       // Vaccine: one status off
  return null;
}

// Walk an entry ref the way the engine does: a row, and through `chain` steps.
// A menu (open_action_menu) is a player choice — the walk cannot know the pick,
// so it stops there (`opaque`). Labels already seen are skipped (cycles).
function walk(label, byLabel, seen, out) {
  const row = byLabel.get(label);
  if (!row || seen.has(label)) return;
  seen.add(label);
  const k = lc(row.effect_kind);
  if (k === "chain") {
    for (const step of String(row.chain_steps ?? "").split(/[,\n]/).map((s) => s.trim()).filter(Boolean)) walk(step, byLabel, seen, out);
    return;
  }
  if (k === "open_action_menu") { out.opaque = true; return; }
  out.rows.push(row);
}

// skill props → ordered beats. Each beat: { k: damage|heal|buff|debuff,
// to: target|self, post: bool (after the damage), needsHit: bool }.
// `intent` (harmful | aid | neutral) is the fallback when nothing is readable.
export function composeBeats(props = {}, { aeTagOf = null, intent = "neutral" } = {}) {
  const rows = rowsOf(props);
  const byLabel = new Map(rows.map((r) => [String(r.effect_label ?? "").trim(), r]));
  const damageType = lc(props.type_damage);
  const healing = HEALING_TYPES.has(damageType);
  const hasDamage = !healing && !NONDAMAGING.has(damageType);
  const harmful = intent === "harmful" || hasDamage;

  const seen = new Set();
  const referenced = new Set();
  for (const r of rows) {
    if (lc(r.effect_kind) === "chain") for (const s of String(r.chain_steps ?? "").split(/[,\n]/)) referenced.add(s.trim());
    for (const ref of String(r.menu_option_refs ?? "").split(/[,\n]/)) if (ref.trim()) referenced.add(ref.trim());
  }
  // Rows the item's OWN reactions fire (Basalt Crush: creature_deals_damage →
  // a 35% Petrify) run through the reaction path, whose passive fallback shows
  // them when — and only if — they land. Not guessed here as post beats.
  for (const rc of Object.values(props.reaction_config_table ?? {})) {
    if (!rc || rc.$deleted) continue;
    const ref = String(rc.reaction_effect_ref ?? "").trim();
    if (!ref) continue;
    referenced.add(ref);
    const sub = { rows: [], opaque: false };
    walk(ref, byLabel, new Set(), sub);
    for (const r of sub.rows) referenced.add(String(r.effect_label ?? "").trim());
    const root = byLabel.get(ref);
    if (root && lc(root.effect_kind) === "chain") for (const s of String(root.chain_steps ?? "").split(/[,\n]/)) referenced.add(s.trim());
  }
  const pre = { rows: [], opaque: false }, post = { rows: [], opaque: false };
  for (const key of ["pre_activate_effect_ref", "on_activate_effect_ref"]) {
    const ref = String(props[key] ?? "").trim(); if (ref) walk(ref, byLabel, seen, pre);
  }
  for (const key of ["post_damage_effect_ref", "on_hit_effect_ref"]) {
    const ref = String(props[key] ?? "").trim(); if (ref) walk(ref, byLabel, seen, post);
  }
  // A row nothing points at (a status-on-hit like Scorched Claw's Burn) is read
  // as a post-damage effect. Purely visual, so a wrong guess costs one flash.
  for (const r of rows) {
    const l = String(r.effect_label ?? "").trim();
    if (!seen.has(l) && !referenced.has(l)) walk(l, byLabel, seen, post);
  }

  const beats = [];
  const push = (b, isPost) => {
    if (!b) return;
    const dupe = beats.find((x) => x.k === b.k && x.to === b.to);
    if (dupe) return;
    // post_damage effects fire per DAMAGED target, so with damage in the action
    // every post beat (a drain's self-heal included) needs the hit.
    beats.push({ ...b, post: isPost, needsHit: !!b.needsHit || (isPost && hasDamage) });
  };
  // A pre-damage row aimed at the creatures HIT (hit_action_targets — Fulgur's
  // status) only lands on a hit, so it plays after the damage beat, the way a
  // status-on-hit reads in any JRPG. Pre-damage self buffs stay first.
  const deferred = [];
  for (const r of pre.rows) {
    const b = beatOfRow(r, { aeTagOf, harmful });
    if (b && b.needsHit && hasDamage) deferred.push(b); else push(b, false);
  }
  if (hasDamage) push({ k: "damage", to: "target", needsHit: false }, false);
  else if (healing) push({ k: "heal", to: "target", needsHit: false }, false);
  for (const b of deferred) push(b, true);
  for (const r of post.rows) push(beatOfRow(r, { aeTagOf, harmful }), true);
  const kw = lc(props.action_keywords);
  if (hasDamage && /\bdrain\b/.test(kw)) push({ k: "heal", to: "self", needsHit: true }, true);

  if (!beats.length) {
    // nothing readable: the action's single purpose
    if (intent === "harmful") beats.push({ k: "debuff", to: "target", post: false, needsHit: false });
    else if (intent === "aid") beats.push({ k: "buff", to: "target", post: false, needsHit: false });
  }
  return { beats: beats.slice(0, MAX_BEATS), hasDamage, healing, opaque: pre.opaque || post.opaque };
}

// A move whose effect rows play an animation of their own (Phoenix Feather's
// chain plays "FX: Revive") gets no default on top of it.
export function hasOwnAnimationRow(props = {}) {
  return rowsOf(props).some((r) => lc(r.effect_kind) === "play_animation");
}

// Beats → what plays, given the outcome. A miss swings the damage beat (no
// clip) and drops every beat that needed the hit. itemLike: an item that
// deals damage plays its element's "one target" clip (ITEM_ELEMENT_CLIP).
export function resolveBeats(beats, { outcome = "hit", element = "Physical", attackLike = false, itemLike = false } = {}) {
  const el = ELEMENT[element] ? element : "Physical";
  const crit = outcome === "crit", miss = outcome === "miss";
  const s = ELEMENT[el].suffix;
  const out = [];
  for (const b of beats) {
    if (b.k === "damage") {
      const clip = miss ? null : crit ? FAMILY.hit.crit
        : itemLike ? ITEM_ELEMENT_CLIP[el]
        : (attackLike ? FAMILY.hit[s] : (s === "physical" ? "002_hit_effect" : FAMILY.hit[s]));
      const tint = !itemLike && !miss && !crit && (s === "effect" || (!attackLike && s === "physical")) ? (ELEMENT[el].tint ?? null) : null;
      out.push({ ...b, clip, tint, sfx: miss ? null : "blow", elementSfx: miss ? null : (ELEMENT[el].sfx ?? null), crit, miss });
      continue;
    }
    if (miss && b.needsHit) continue;
    out.push({ ...b, clip: BEAT[b.k].clip, tint: null, sfx: BEAT[b.k].sfx });
  }
  return out;
}

// ── Timing ──────────────────────────────────────────────────────────────
// All in ms. The script follows this schedule; the director's damage gate is
// set to `impactAt` (timing "offset", counted from the script's start signal),
// so the HP change lands on the contact frame while the step back plays after.

export const TIMING = {
  stepMs: 300, quickStepMs: 220, returnMs: 360,
  readyMs: 160,            // ranged: lean back before firing
  arrowMs: 260, throwMs: 340, gunLeadMs: 70,
  staggerMs: 110,          // between targets of a multi-target action
  beatGapMs: 250,          // next beat starts this long after the previous lands
  castMs: 160,             // skill: caster glow before the first beat
  slideMs: 320,            // skill: slide forward
  chainBeatMs: 380,        // Chain N: gap between strikes
  tailMs: 120,
  // items (FF style): a short step, a use-glint at the hand; a damaging item
  // pops at the hand and is thrown, spinning
  itemStepMs: 260, glintMs: 340, itemPopMs: 120, itemThrowMs: 380, itemNoThrowMs: 80,
};

const firstFlash = (key) => (MV_CLIPS[key]?.flashes?.[0] ?? 0);
const lastFlash = (key) => { const f = MV_CLIPS[key]?.flashes ?? [0]; return f[f.length - 1]; };

// When does the attack's damage land, from the script's start? A one-flash
// clip lands on its flash (40 ms floor so the clip is on screen first); a
// multi-hit crit clip lands on its LAST flash, like the mockup.
export function attackImpactAt(pick, { strikes = 1 } = {}) {
  const T = TIMING;
  let t = pick.motion === "melee" ? (pick.quick ? T.quickStepMs : T.stepMs) : T.readyMs;
  if (pick.motion === "arrow") t += T.arrowMs;
  if (pick.motion === "throw") t += T.throwMs;
  if (pick.motion === "gun") t += T.gunLeadMs;
  if (!pick.clip) return t + 60;                                   // miss: on the swing
  if (strikes > 1) return t + (strikes - 1) * T.chainBeatMs + Math.max(40, firstFlash(pick.clip));
  return t + Math.max(40, lastFlash(pick.clip));
}

// Skill composer: damage (or, with no damage, the first beat) lands at its
// clip's first flash; beats before it each take `flash + beatGapMs`.
// attackLike (an attack item with extra effects): a step in, no cast glow.
// item: the item preamble (step, glint, and a throw when it deals damage).
export function beatsImpactAt(resolved, { attackLike = false, item = null } = {}) {
  const T = TIMING;
  let t = item
    ? T.itemStepMs + T.glintMs + (item.thrown ? T.itemPopMs + T.itemThrowMs : T.itemNoThrowMs)
    : (attackLike ? T.stepMs : T.slideMs + T.castMs);
  for (const b of resolved) {
    const land = b.clip ? Math.max(b.k === "damage" ? 40 : 200, firstFlash(b.clip)) : 60;
    if (b.k === "damage" || b.k === "heal" || b.k === "mp" || b.k === "shield" || b.k === "zp" || b === resolved[resolved.length - 1]) return t + land;
    t += land + T.beatGapMs;
  }
  return t;
}
