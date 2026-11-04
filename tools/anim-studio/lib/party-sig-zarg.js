"use strict";
// Zarg's party action animations (Batch B), ported from the approved
// "Party Action Animations" mockup (v8, 2026-11-05) onto oni.timeline.
// Shots: party-shots/zarg-*.inner.js. Timings and sounds live here.
const PS = require("./party-signatures.js");
const { MV, GG, cue, build } = PS;

const ZARG = "Z4CFy505cD3nzl1W";
const KEREN = "gdJZ1L1kv5mjTTMr";

// Clip defs from the mockup's assets/meta.js (native px, ms, anchor).
const CL = {
  powerup:   { url: MV("052_powerup_2"), w: 508, h: 630, dur: 1200, ax: 0.5, ay: 0.6508 },
  cure:      { url: MV("045_cure_one_1"), w: 700, h: 754, dur: 1133, ax: 0.5, ay: 0.561 },
  heal:      { url: MV("041_heal_one_1"), w: 546, h: 548, dur: 1400, ax: 0.5, ay: 0.885 },
  powerdown: { url: MV("054_powerdown_1"), w: 508, h: 656, dur: 867, ax: 0.5, ay: 0.628 },
  sonic:     { url: MV("034_sonic_wave"), w: 956, h: 548, dur: 1267, ax: 0.4812, ay: 0.6861 },
  hit:       { url: MV("001_hit_physical"), w: 488, h: 488, dur: 333, ax: 0.5, ay: 0.5 },
  dashsmoke: { url: GG("dashsmoke_anim01"), w: 1024, h: 256, dur: 800, ax: 0.5, ay: 0.5, mask: true },
};
const clips = (...keys) => { const o = { twinkle: true }; for (const k of keys) o[k] = PS.CLIPS[k] ? true : CL[k]; return o; };
const T = (name, id, world) => [{ actor: ZARG, item: name }, { world: id }];

// ── Dances: Fall at the start, Up1 at the burst (900 ms), no step sound ──
const DANCE_START = [cue(0, "Fall.ogg", 0.55), cue(900, "Up1.ogg", 0.5)];
function dance({ key, name, kind, hue, extra, clip, gate }) {
  return build({ key: "zarg-" + key, name, shot: "zarg-dance", clips: clips(...(clip ? [clip] : [])),
    cfg: { kind, hue, sfx: DANCE_START.concat(extra || []) }, gate: gate == null ? null : gate });
}
const ELEMENT_DANCES = [
  ["Angel Dance", "U3Lw5E3E2OvH0X0D", 48],    // Light
  ["Griffin Dance", "euVcGY076CFXmq9R", 140], // Air
  ["Myrmidon Dance", "kuqfrsAnzpRaR3ac", 28], // Earth
  ["Bat Dance", "PgdBTVEzsdaiRNiE", 280],     // Dark
  ["Golem Dance", "ggpg4xjPbAMOISIB", 55],    // Bolt
];

const jobs = [];
for (const [name, world, hue] of ELEMENT_DANCES) {
  jobs.push({ name, targets: T(name, world), gen: () => dance({ key: name.toLowerCase().replace(/\s+/g, "-"), name, kind: "element", hue, clip: "powerup" }) });
}
jobs.push({ name: "Lion Dance", targets: T("Lion Dance", "MEdEKpPNgKTtkE7Z"),
  gen: () => dance({ key: "lion-dance", name: "Lion Dance", kind: "lion", hue: 35, clip: "cure", extra: [cue(900, "Recovery.ogg", 0.5)] }) });
jobs.push({ name: "Unicorn Dance", targets: T("Unicorn Dance", "53E5FE5FlljuSoeo"),
  gen: () => dance({ key: "unicorn-dance", name: "Unicorn Dance", kind: "unicorn", hue: 330, clip: "heal", extra: [cue(900, "Heal3.ogg", 0.5)], gate: 900 + 500 }) });
jobs.push({ name: "Ouroboros Dance", targets: T("Ouroboros Dance", "eAUaGhDdy3uogln7"),
  gen: () => dance({ key: "ouroboros-dance", name: "Ouroboros Dance", kind: "ouroboros", hue: 170, extra: [cue(900, "Bell1.ogg", 0.5)] }) });

// ── Warning Shot (reaction, after the ranged attack hits; its targets) ──
jobs.push({ name: "Warning Shot", targets: T("Warning Shot", "7opUr817pDyJZsJt"), gen: () => {
  const t = { shot: 380, fly: 380, back: 1110 };
  const each = (c) => Object.assign(c, { each: true });
  return build({ key: "zarg-warning-shot", name: "Warning Shot", shot: "zarg-warning-shot", clips: { powerdown: CL.powerdown },
    cfg: { t, stagger: 110, sfx: [each(cue(380, "Shot1.ogg", 0.55)), each(cue(760, "Down2.ogg", 0.5))] }, gate: null });
} });

// ── Gadgets ──
jobs.push({ name: "Gadgets", targets: T("Gadgets", "1w2LjUOVhlbLR8nn"), gen: () => {
  const t = { glint: 380, toss: 680, land: 1330, back: 1330, total: 1930 };
  return build({ key: "zarg-gadgets", name: "Gadgets", shot: "zarg-gadgets", clips: clips("burst"),
    cfg: { t, sfx: [cue(380, "Item1.ogg", 0.5), cue(680, "SE_SWINGA.wav", 0.4), cue(1330, "Break.ogg", 0.4)] }, gate: null });
} });

// ── See you later (shared with Keren) ──
jobs.push({ name: "See you later", targets: [{ actor: ZARG, item: "See you later" }, { actor: KEREN, item: "See you later" }, { world: "x7RoCErd12Udc8RZ" }], gen: () => {
  const t = { crouch: 650, dash: 810, gone: 1230, gust: 1480 };
  return build({ key: "see-you-later", name: "See you later", shot: "zarg-see-you-later", clips: { dashsmoke: CL.dashsmoke },
    cfg: { t, leaves: 14, leafCapMs: 8000, sfx: [cue(650, "Wind4.ogg", 0.6), cue(1480, "Wind1.ogg", 0.35)] }, gate: null });
} });

// ── Traps ──
jobs.push({ name: "Siren Trap", targets: T("Siren Trap", "fT3T2irBXiSWPcvB"), gen: () => {
  const t = { toss: 380, land: 1080, total: 2400 };
  return build({ key: "zarg-siren-trap", name: "Siren Trap", shot: "zarg-siren-trap", clips: { sonic: CL.sonic },
    cfg: { t, sfx: [cue(1080, "Bell3.ogg", 0.6)] }, gate: null });
} });
jobs.push({ name: "Tripwire Trap", targets: T("Tripwire Trap", "gHEqgUQKQMDAJT5B"), gen: () => {
  const t = { draw: 400, blow: 700, snap: 920, right: 1170 };
  return build({ key: "zarg-tripwire-trap", name: "Tripwire Trap", shot: "zarg-tripwire-trap", clips: clips("hit"),
    cfg: { t, sfx: [cue(0, "SE_SWINGA.wav", 0.35), cue(700, "SE_BTL_HitBlowS.ogg", 0.6)] }, gate: t.snap });
} });

module.exports = { jobs };
