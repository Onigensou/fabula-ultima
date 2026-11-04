// ============================================================================
// Hit sounds — who plays the impact sound of one hit (pure).
//
// Rule approved on mockup v4 (2026-11-04): ONE impact sound per hit, never none.
//
//   BD's damage number owns the sound by default and plays an ELEMENT sound
//   (poison ticks, passive / reaction damage, any animation that is silent or
//   has not claimed the hit). WEAK / RESIST replace the element sound.
//
//   An animation takes the sound over only when it CLAIMS the hit: every
//   default animation does (action-anim-script.js), an authored script does
//   when its item carries flags.fabula-ultima-companion.animOwnsImpact. Then
//   the number keeps its pop and flinch, drops its own impact burst and hit
//   sound, and only a WEAK / RESIST accent plays on top.
//
// Used by director-vfx.js playResourceLossVfx. Tested by hit-sound-rules.test.mjs.
// ============================================================================

const F = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/";

// What the number played before this rule, for every hit.
export const BASE_HIT_SFX = F + "HitSlashM.wav";
export const SUPER_SFX = F + "Hit_SlashingB.wav";
export const RESIST_SFX = F + "Soundboard/Parry.ogg";
export const MP_SPEND_SFX = F + "Dispel%20Magic.ogg";

// FU's nine damage types. Physical/Fire/Ice/Bolt reuse the default animations'
// hit sounds; the rest are short RPG Maker sounds picked on the mockup.
export const ELEMENT_HIT_SFX = {
  physical: F + "Soundboard/SE_BTL_HitBlowS.ogg",
  fire:     F + "Soundboard/SE_BTL_HitFire.ogg",
  ice:      F + "Soundboard/SE_BTL_HitIce_1.mp3",
  bolt:     F + "Soundboard/SE_BTL_HitElectric.ogg",
  air:      F + "Wind1.ogg",
  earth:    F + "Soundboard/Earth1.ogg",
  dark:     F + "Soundboard/Darkness2.ogg",
  light:    F + "Soundboard/Saint1.ogg",
  poison:   F + "Soundboard/Poison.ogg",
};

const ALIAS = { lightning: "bolt", thunder: "bolt", electric: "bolt", wind: "air", shadow: "dark", holy: "light" };
export function normalizeHitElement(raw) {
  const s = String(raw ?? "").trim().toLowerCase();
  if (ELEMENT_HIT_SFX[s]) return s;
  return ALIAS[s] ?? null;   // elementless / unknown → null (the old generic hit)
}

// → { impact: bool (play BD's impact burst), sfx: url | null, vol }
export function lossSound({ resource = "hp", affinity = "NE", element = null, impactOwned = false } = {}) {
  if (resource === "mp") return { impact: true, sfx: MP_SPEND_SFX, vol: 0.6 };
  const aff = String(affinity ?? "NE").toUpperCase();
  if (impactOwned) {
    // the animation played the hit: only a short affinity accent on top
    if (aff === "VU") return { impact: false, sfx: SUPER_SFX, vol: 0.4 };
    if (aff === "RS") return { impact: false, sfx: RESIST_SFX, vol: 0.4 };
    return { impact: false, sfx: null, vol: 0 };
  }
  if (aff === "VU") return { impact: true, sfx: SUPER_SFX, vol: 0.6 };
  if (aff === "RS") return { impact: true, sfx: RESIST_SFX, vol: 0.6 };
  const el = normalizeHitElement(element);
  return el ? { impact: true, sfx: ELEMENT_HIT_SFX[el], vol: 0.5 } : { impact: true, sfx: BASE_HIT_SFX, vol: 0.6 };
}
