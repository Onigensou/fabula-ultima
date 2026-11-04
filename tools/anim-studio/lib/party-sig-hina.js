"use strict";
// ============================================================================
// Hina's action animations (Batch B), ported from the approved "Party Action
// Animations" mockup onto oni.timeline. Shots: party-shots/hina-*.inner.js.
// Timings are the mockup's (step out 380, cast hold 700 unless noted, step back
// 460); every number BD gates on is computed here from the same constants.
// ============================================================================
const PS = require("./party-signatures.js");
const { MV, RO, GG, cue } = PS;

const HINA = "dafTLBUscCDNgq8H";
const BLANCHE = "uJFaNQCSvwwsr2AW";
const hina = (item) => ({ actor: HINA, item });
const world = (id) => ({ world: id });

// cue that only plays when the shot has at least n targets (per-target sounds)
const cueN = (at, file, v, n) => Object.assign(cue(at, file, v), { n });

// clip defs: native px, ms, anchor (from the mockup's meta.js); ro = drawn at 1.9x
const C = (url, w, h, dur, ax, ay, ro) => ({ url, w, h, dur, ax, ay, ro: !!ro });
const HC = {
  comet:       C(RO("new_comet"), 712, 1360, 1183, 0.486, 0.8875, true),
  cometBottom: C(RO("new_comet_bottom"), 910, 910, 1533, 0.5, 0.511, true),
  cometSub:    C(RO("new_comet_sub_explosion"), 434, 458, 567, 0.5, 0.6135, true),
  ice1:        C(MV("071_ice_one_1"), 718, 718, 1000, 0.5, 0.5),
  ice2:        C(MV("072_ice_one_2"), 488, 488, 800, 0.5, 0.7951),
  heal:        C(MV("041_heal_one_1"), 546, 548, 1400, 0.5, 0.885),
  cure:        C(MV("045_cure_one_1"), 700, 754, 1133, 0.5, 0.561),
  neutral:     C(MV("107_neutral_one_2"), 714, 714, 800, 0.5, 0.5),
  absorb:      C(MV("058_absorb"), 820, 820, 1200, 0.5, 0.5),
  pu3:         C(MV("053_powerup_3"), 354, 354, 1867, 0.5, 0.6695),
  pu2:         C(MV("052_powerup_2"), 508, 630, 1200, 0.5, 0.6508),
  pd1:         C(MV("054_powerdown_1"), 508, 656, 867, 0.5, 0.628),
  fire1:       C(MV("066_fire_one_1"), 776, 784, 733, 0.5, 0.8827),
  hit:         C(MV("001_hit_physical"), 488, 488, 333, 0.5, 0.5),
  shout:       C(MV("037_shout"), 1736, 1736, 800, 0.5, 0.5),
  pillar:      C(MV("117_light_pillar_1"), 384, 384, 2467, 0.5, 0.8438),
  smoke:       C(GG("smoke_anim11"), 170, 204, 1500, 0.5, 0.5),
  dash:        C(GG("dashsmoke_anim01"), 1024, 256, 800, 0.5, 0.5),
};
// registry keys (mc, ringComet, twinkle) + our own defs
const clips = (...keys) => { const o = {}; for (const k of keys) o[k] = HC[k] || true; return o; };
const WFLAME = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Beastiary/WanderingFlame_Standard.png";

// ── Starfall Comet / Starfall: gold comet(s) under a night-blue sky ──
function comet({ n, hold, dim, scale }) {
  const rel = 380 + hold;
  const sfx = [cue(380, "Magic3.ogg", 0.5)];
  for (let i = 0; i < n; i++) { const c0 = rel + i * 420; sfx.push(cue(c0 + 150, "Flash2.ogg", 0.35), cue(c0 + 640, "Starlight.ogg", 0.5), cue(c0 + 640, "SE_BTL_HitBlowL.ogg", 0.35)); }
  const end = rel + (n - 1) * 420 + 150 + 1183;
  const t = { n, rel, dim, scale, end };
  return PS.build({ key: "hina-" + (n === 1 ? "starfall-comet" : "starfall"), name: n === 1 ? "Starfall Comet" : "Starfall", shot: "hina-comet",
    clips: clips("mc", "ringComet", "comet", "cometBottom", "cometSub"), cfg: { t, sfx }, gate: rel + 640 });
}

// ── the cast-then-clip spells (hina-cast) ──
const REL = 380 + 700; // default cast: step 380 + hold 700
function castSpell(mode, name, o) {
  const t = Object.assign({ rel: REL }, o.t);
  return PS.build({ key: "hina-" + mode, name, shot: "hina-cast", clips: clips("mc", ...o.clips), cfg: { mode, hue: o.hue, t, sfx: o.sfx }, gate: o.gate == null ? null : o.gate });
}
const glacies = () => castSpell("glacies", "Glacies", { hue: 200, clips: ["ice1"], t: { total: REL + 320 + 1000 + 100 },
  sfx: [cue(380, "Ice4.ogg", 0.5), cueN(REL, "Ice1.ogg", 0.45, 1), cueN(REL + 160, "Ice1.ogg", 0.45, 2), cueN(REL + 320, "Ice1.ogg", 0.45, 3)], gate: REL + 200 });
const iceberg = () => castSpell("iceberg", "Iceberg", { hue: 200, clips: ["ice2"], t: { total: REL + 900 },
  sfx: [cue(380, "Ice4.ogg", 0.5), cue(REL, "Ice1.ogg", 0.6)], gate: REL + 200 });
const heal = () => castSpell("heal", "Heal", { hue: 120, clips: ["heal"], t: { total: REL + 280 + 1400 + 50 },
  sfx: [cue(380, "Magic1.ogg", 0.5), cue(REL, "Heal3.ogg", 0.55)], gate: REL + 500 });
const cleanse = () => castSpell("cleanse", "Cleanse", { hue: 150, clips: ["cure"], t: { total: REL + 280 + 1133 + 50 },
  sfx: [cue(380, "Magic1.ogg", 0.5), cue(REL, "Recovery.ogg", 0.55)] });
const dispel = () => castSpell("dispel", "Dispel", { hue: 60, clips: ["neutral"], t: { total: REL + 67 + 1000 + 50 },
  sfx: [cue(380, "Magic3.ogg", 0.5), cue(REL, "Flash1.ogg", 0.5), cue(REL + 67, "Break.ogg", 0.45)] });
// Elemental Shroud / Weapon: the element is the player's pick at resolve and the shot
// cannot see it, so both play NEUTRAL: the clip untinted, the circle at that clip's
// own hue (053_powerup_3 = 190, 052_powerup_2 = 55).
const shroud = () => castSpell("shroud", "Elemental Shroud", { hue: 190, clips: ["pu3"], t: { total: REL + 280 + 1867 },
  sfx: [cue(380, "Magic1.ogg", 0.5), cue(REL, "Up4.ogg", 0.5)] });
const weapon = () => castSpell("weapon", "Elemental Weapon", { hue: 55, clips: ["twinkle", "pu2"], t: { total: REL + 400 + 1200 + 50 },
  sfx: [cue(380, "Magic1.ogg", 0.5), cue(REL + 400, "Up1.ogg", 0.5)] });
// Bind and Summon (variant), class default: circle x1.1, pillar at the summon spot
const bindDefault = () => castSpell("bind", "Bind and Summon (variant)", { hue: 45, clips: ["pillar"], t: { scale: 1.1, back: REL + 1200, total: REL + 2467 + 550 },
  sfx: [cue(380, "Saint3.ogg", 0.5)] });

// ── the step-out actives (hina-active) ──
function active(mode, name, o) {
  return PS.build({ key: "hina-" + mode, name, shot: "hina-active", clips: clips(...o.clips), cfg: { mode, t: o.t, sfx: o.sfx }, gate: o.gate == null ? null : o.gate });
}
const pulse = () => active("pulse", "Avatar of Vengeance: Pulse", { clips: ["fire1"], t: { back: 780, auraEnd: 1820, total: 1850 },
  sfx: [cue(380, "SE_BTL_HitFire.ogg", 0.5), cueN(780, "SE_BTL_HitFire.ogg", 0.4, 1), cueN(930, "SE_BTL_HitFire.ogg", 0.4, 2), cueN(1080, "SE_BTL_HitFire.ogg", 0.4, 3)] });
const roar = () => active("roar", "Draconic Roar", { clips: ["shout", "pd1"], t: { dist: 60, back: 2237, total: 2790 },
  sfx: [cue(380, "Monster1.ogg", 0.7)], gate: 630 });
const bimagus = () => active("bimagus", "Bimagus", { clips: ["pu2"], t: { back: 1680, total: 2200 },
  sfx: [cue(380, "Magic4.ogg", 0.5), cue(980, "Up4.ogg", 0.5)] });
const book = () => active("book", "Encyclopedia Strike", { clips: ["hit", "twinkle"], t: { dist: 60, back: 1000, total: 1750 },
  sfx: [cue(380, "Book1.ogg", 0.6), cue(380, "SE_SWINGA.wav", 0.5), cue(1000, "SE_BTL_HitBlowS.ogg", 0.65)], gate: 1000 });

// ── wisps (hina-wisps) ──
const drain = () => PS.build({ key: "hina-drain-spirit", name: "Drain Spirit", shot: "hina-wisps", clips: clips("mc", "absorb"),
  cfg: { mode: "drain", hue: 222, t: { rel: REL, back: REL + 2320, total: REL + 2320 + 560 },
    sfx: [cue(380, "Darkness2.ogg", 0.5), cue(REL, "Absorb1.ogg", 0.55), cue(REL + 2320, "Up4.ogg", 0.5)] }, gate: REL + 400 });
const symptom = () => PS.build({ key: "hina-symptom-shift", name: "Symptom Shift", shot: "hina-wisps", clips: clips("mc", "cure", "pd1"),
  cfg: { mode: "symptom", hue: 280, t: { rel: REL, back: REL, down: REL + 2240, total: REL + 2240 + 950 },
    sfx: [cue(380, "Magic1.ogg", 0.5), cue(REL, "Recovery.ogg", 0.5), cue(REL + 500, "Darkness2.ogg", 0.45), cue(REL + 2240, "Down2.ogg", 0.5)] }, gate: null });

// ── Lift off (hina-liftoff) ──
const liftoff = () => PS.build({ key: "hina-lift-off", name: "Lift off", shot: "hina-liftoff", clips: clips("twinkle", "smoke", "dash"),
  cfg: { sfx: [cue(0, "Item1.ogg", 0.5), cue(450, "Steam.mp3", 0.5), cue(1350, "Machine.ogg", 0.45), cue(1770, "Fire2.ogg", 0.55)] }, gate: null });

// ── Bind and Summon: The Wandering Flame (hina-wflame), Hina's copy only ──
function wflame() {
  const rel = 380 + 900, fin = rel + 3170, auraEnd = fin + 1160;
  return PS.build({ key: "hina-wandering-flame", name: "Bind and Summon (The Wandering Flame)", shot: "hina-wflame",
    clips: clips("mc", "pillar", "twinkle", "fire1", "pu2"), images: { wflame: WFLAME },
    cfg: { t: { rel, fin, auraEnd, dimOut: auraEnd, total: auraEnd + 640 },
      sfx: [cue(380, "Fire2.ogg", 0.5), cue(rel, "Fire2.ogg", 0.55), cue(rel + 1200, "Monster1.ogg", 0.6), cue(fin, "Up4.ogg", 0.55)] }, gate: null });
}

const jobs = [
  { name: "Starfall Comet", targets: [hina("Starfall Comet")], gen: () => comet({ n: 1, hold: 900, dim: 0.45, scale: 1 }) },
  { name: "Starfall", targets: [hina("Starfall")], gen: () => comet({ n: 3, hold: 1100, dim: 0.5, scale: 1.15 }) },
  { name: "Glacies", targets: [hina("Glacies"), world("5FJroVCi4rjKmXQO")], gen: glacies },
  { name: "Iceberg", targets: [hina("Iceberg"), world("VMu0aaKdIoi6qRi2")], gen: iceberg },
  { name: "Heal", targets: [hina("Heal"), { actor: BLANCHE, item: "Heal" }, world("7ApZzLcwZfDZz0nE"), world("iJXsSCRucVWJNRed"), world("TD3i1fdSE7qGwApx")], gen: heal },
  { name: "Cleanse", targets: [hina("Cleanse"), world("C3KMINBBXGYPZ5oj")], gen: cleanse },
  { name: "Dispel", targets: [hina("Dispel"), world("Ydbba6k0hFjWZvJv")], gen: dispel },
  { name: "Drain Spirit", targets: [hina("Drain Spirit"), world("szPLoqRb8JELX4X7")], gen: drain },
  { name: "Elemental Shroud", targets: [hina("Elemental Shroud"), world("UF9js71VGFE9jB93")], gen: shroud },
  { name: "Elemental Weapon", targets: [hina("Elemental Weapon"), world("HhAK0qzO2jmsk0RX")], gen: weapon },
  { name: "Symptom Shift", targets: [hina("Symptom Shift"), world("LsQkDSEbvQ7S0b3L")], gen: symptom },
  { name: "Avatar of Vengeance: Pulse", targets: [hina("Avatar of Vengeance: Pulse"), world("jhd1fKKHvVFuzKqB")], gen: pulse },
  { name: "Encyclopedia Strike", targets: [hina("Encyclopedia Strike"), world("TouMdewrn3xPmsMj")], gen: book },
  { name: "Bimagus", targets: [hina("Bimagus"), world("HjNImvzXOvZw1mGF")], gen: bimagus },
  { name: "Lift off", targets: [hina("Lift off"), world("6QTyJylY01Anv4IV")], gen: liftoff },
  { name: "Draconic Roar", targets: [hina("Draconic Roar")], gen: roar },
  { name: "Bind and Summon (variant)", targets: [world("WVC5pXW6w1WHVJSm")], gen: bindDefault },
  { name: "Bind and Summon (variant) - The Wandering Flame", targets: [hina("Bind and Summon (variant)")], gen: wflame },
];

module.exports = { jobs };
