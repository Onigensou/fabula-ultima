"use strict";
// ============================================================================
// Bolt spells anyone can cast (2026-11-06): Fulgur (tier 1, class parent +
// Thunder Bow's copy + every PC/NPC copy) and Thunderstorm (Rumbling Staves).
// Shot: party-shots/gear-bolt.inner.js. Same cast shape as the tier-1 Glacies
// (party-sig-hina.js castSpell): step out 380, circle hold 700, release.
// Electro Gorger's "Fulgur" is a monster variant (a renamed NPC melee attack) and
// is left alone (feedback_item_text_convention: monster variants are separate).
// ============================================================================
const PS = require("./party-signatures.js");
const { MV, cue } = PS;

const world = (id) => ({ world: id });
const actor = (id) => ({ actor: id, item: "Fulgur" });
const cueN = (at, file, v, n) => Object.assign(cue(at, file, v), { n });
const C = (url, w, h, dur, ax, ay) => ({ url, w, h, dur, ax, ay, ro: false });
const GC = {
  // native px / ms / anchor from battle-director/action-anim-rules.js
  spark: C(MV("005_hit_thunder"), 580, 580, 667, 0.5, 0.5207),
  bolt:  C(MV("076_thunder_one_1"), 624, 704, 467, 0.5, 0.858),
};
const clips = (...keys) => { const o = { mc: true }; for (const k of keys) o[k] = GC[k]; return o; };
const REL = 380 + 700;
const HUE = 52; // bolt yellow

// ── Fulgur: tier 1, a small crackle on each target ──
function fulgur() {
  const t = { rel: REL, sparkScale: 0.55, total: REL + 280 + 667 + 100 };
  const sfx = [cue(380, "Magic3.ogg", 0.5),
    cueN(REL, "SE_BTL_HitElectric.ogg", 0.45, 1), cueN(REL + 140, "SE_BTL_HitElectric.ogg", 0.45, 2), cueN(REL + 280, "SE_BTL_HitElectric.ogg", 0.45, 3)];
  return PS.build({ key: "gear-fulgur", name: "Fulgur", shot: "gear-bolt", clips: clips("spark"),
    cfg: { mode: "fulgur", hue: HUE, t, sfx }, gate: REL + 120 });
}

// ── Thunderstorm: three bolts, one per planned strike (Chain 3 seek) ──
// Medium tier (user, 2026-11-06): a real storm builds first. The cast rolls in a
// storm rumble under a dim; far-off sheet lightning flickers and sparks gather over
// the targets (anticipation, R..S0); THEN the bolts break, one per strike.
const STORM_RUMBLE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BGS/Storm1.ogg"; // 2.35 s
function thunderstorm() {
  const gap = 420, contact = 133, bolts = 3;
  const S0 = REL + 900;                       // first bolt, after the build-up
  const t = {
    rel: REL, strike0: S0, gap, contact, bolts, boltScale: 1.8,
    dim1: 0.45, dim2: 0.6,                    // cast dim, then the storm deepens it
    flickers: [[REL - 280, 110, 0.10], [REL + 260, 140, 0.14], [REL + 640, 90, 0.12]], // [at, fade ms, alpha]
    charges: [REL + 150, REL + 520], sparks: 6,
    undimAfter: 500, undimMs: 600,
    total: S0 + (bolts - 1) * gap + 467 + 650,
  };
  const sfx = [cue(380, "Magic3.ogg", 0.45), { at: 380, url: STORM_RUMBLE, v: 0.45 }, cue(REL + 200, "Thunder9.ogg", 0.28)];
  for (let i = 0; i < bolts; i++) sfx.push(cue(S0 + i * gap, "Thunder1.ogg", 0.4), cue(S0 + i * gap + contact, "SE_BTL_HitElectric.ogg", 0.4));
  // gate null: a Chain's numbers land on the shot's oni.hit() cues, not on a damage offset
  return PS.build({ key: "gear-thunderstorm", name: "Thunderstorm", shot: "gear-bolt", clips: Object.assign(clips("bolt"), { twinkle: true }),
    cfg: { mode: "thunderstorm", hue: HUE, t, sfx }, gate: null });
}

const jobs = [
  { name: "Fulgur", gen: fulgur, targets: [
    world("9NedNyPRoLHZEmMX"),   // Elementalist class parent
    world("3SG96LfUyQaA0qAp"),   // Thunder Bow's Fulgur
    actor("i8ozKcyWbB4geOKh"),   // Elementalist (class actor)
    actor("HSLzklG64h0nVZGE"),   // Nullis
    actor("NIzI8uoyqahenb39"),   // RaiRai
    actor("XLS7jIqK8iAToGYM"),   // Cherry
    actor("aTLyASPTv1omAcIn"),   // Roselie
    actor("wb2SUtgxcA4iLX38"),   // Sophie
  ] },
  { name: "Thunderstorm", gen: thunderstorm, targets: [world("SpcEksmH6AECN7qa")] },
];

module.exports = { jobs };
