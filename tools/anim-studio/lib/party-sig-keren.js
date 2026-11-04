"use strict";
// ============================================================================
// Keren's party action animations (Batch B), ported from the approved
// "Party Action Animations" mockup (v8) onto oni.timeline via party-signatures.
// Phantasm skins: Keren's own copies use 'foxfire', the Illusionist class
// (world) parents use 'mirage'.
// ============================================================================
const PS = require("./party-signatures.js");
const { build, cue, MV, RO, GG, FORGE } = PS;

const KEREN = "gdJZ1L1kv5mjTTMr";
const NPC = FORGE + "Campaign/The%20Legend%20of%20Dragonslayer/Image/NPCs/";
const IMG = {
  foxfire: PS.IMAGES.foxfire,
  crysta: NPC + "Crysta/Crysta_Battler001.webm",
  leichi: NPC + "Leichi/Leichi_Standard.png",
  leilan: NPC + "Leilan/Leilan_Standard.png",
};
const CL = {
  hit:       { url: MV("001_hit_physical"), w: 488, h: 488, dur: 333, ax: 0.5, ay: 0.5 },
  heal:      { url: MV("041_heal_one_1"), w: 546, h: 548, dur: 1400, ax: 0.5, ay: 0.885 },
  powerup:   { url: MV("052_powerup_2"), w: 508, h: 630, dur: 1200, ax: 0.5, ay: 0.6508 },
  howl:      { url: RO("new_howlingoflion"), w: 862, h: 862, dur: 833, ax: 0.5, ay: 0.62 },
  howlCast:  { url: RO("new_howlingoflion_cast_bottom"), w: 162, h: 156, dur: 1000, ax: 0.5, ay: 0.5 },
  dashsmoke: { url: GG("dashsmoke_anim01"), w: 1024, h: 256, dur: 800, ax: 0.5, ay: 0.5, mask: true },
  smoke11:   { url: GG("smoke_anim11"), w: 170, h: 204, dur: 1500, ax: 0.5, ay: 0.5, mask: true },
};
const one = (file, v) => { const c = cue(0, file, v); return { url: c.url, v: c.v }; };
const both = (item, world) => [{ actor: KEREN, item }, { world }];

// Multi Shatter: up to 3 own phantasms charge their targets and shatter.
function multiShatter(skin) {
  const t = { cast: 380, castHold: 600, flare: 980, charge: 980, stagger: 80, travel: 560, hitMs: 333, total: 2700 };
  return build({
    key: "keren-multi-shatter-" + skin, name: "Multi Shatter (" + skin + ")", shot: "keren-multi-shatter",
    clips: { mc: true, burst: true, hit: CL.hit }, images: skin === "foxfire" ? { foxfire: IMG.foxfire } : {},
    cfg: { skin, t, sfx: [cue(380, "Magic4.ogg", 0.5), cue(980, "Evasion1.ogg", 0.5)], hitSfx: skin === "foxfire" ? one("Fire2.ogg", 0.4) : one("Break.ogg", 0.45) },
    gate: t.charge + t.travel,
  });
}
// Illusory Shield: a real phantasm slides in front of the threatened creature and breaks.
function illusoryShield(skin) {
  const t = { fade: 350, move: 600, wait: 300, breakAfter: 120, tail: 1000 };
  return build({
    key: "keren-illusory-shield-" + skin, name: "Illusory Shield (" + skin + ")", shot: "keren-illusory-shield",
    clips: { slash: true, burst: true }, images: skin === "foxfire" ? { foxfire: IMG.foxfire } : {},
    cfg: { skin, t, s: { evasion: one("Evasion1.ogg", 0.5), slash: one("SE_BTL_HitSlashS.ogg", 0.6), brk: skin === "foxfire" ? one("Fire2.ogg", 0.45) : one("Break.ogg", 0.5) } },
    gate: null,
  });
}
// Brainwave Discharge: violet dim, tremble, RO howlingoflion swirl + bursts.
function brainwave() {
  const t = { tremble: 380, swirl: 980, burst: 1280, impact: 350 };
  return build({
    key: "keren-brainwave", name: "Brainwave Discharge", shot: "keren-brainwave",
    clips: { twinkle: true, howl: CL.howl, howlCast: CL.howlCast },
    cfg: { t, sfx: [cue(980, "Magic4.ogg", 0.5)], burstSfx: one("Darkness4.ogg", 0.35) },
    gate: t.burst + t.impact,
  });
}
function charm() {
  const t = { cast: 380, castHold: 700, release: 1080 };
  return build({
    key: "keren-charm", name: "Charm", shot: "keren-charm", clips: ["mc"],
    cfg: { t, sfx: [cue(380, "Magic1.ogg", 0.5), cue(t.release + 280 + 850, "Saint1.ogg", 0.45)] },
    gate: null,
  });
}
// Nocebo Weapon: neutral white default for the Light/Dark pick (see the shot).
function nocebo() {
  const t = { cast: 380, castHold: 700, release: 1080, burst: 1480, total: 2700 };
  return build({
    key: "keren-nocebo-weapon", name: "Nocebo Weapon", shot: "keren-nocebo-weapon",
    clips: { mc: true, twinkle: true, powerup: CL.powerup },
    cfg: { t, sfx: [cue(380, "Magic1.ogg", 0.5), cue(1480, "Up1.ogg", 0.5)] },
    gate: null,
  });
}
function lifeTransference() {
  const t = { travel: 900, land: 450, total: 2350 };
  return build({
    key: "keren-life-transference", name: "Life Transference", shot: "keren-life-transference",
    clips: { heal: CL.heal },
    cfg: { t, sfx: [cue(0, "Absorb1.ogg", 0.45), cue(900, "Heal3.ogg", 0.5)] },
    gate: t.travel + t.land,
  });
}
// Create Phantasm: Numen (Keren / Crysta): the moon cut-in.
function numen() {
  const t = { cast: 380, castHold: 600, cutIn: 980, moon: 1380, silIn: 1980, snap: 3280, burst: 3540, black: 3790, back: 4290, streak: 4570, stretch: 4690, settle: 4990, total: 7050 };
  return build({
    key: "keren-numen-crysta", name: "Create Phantasm: Numen (Crysta)", shot: "keren-numen",
    clips: { mc: true, twinkle: true }, images: { crysta: IMG.crysta },
    cfg: { t, sfx: [cue(380, "Magic4.ogg", 0.5), cue(1380, "Saint4.ogg", 0.6), cue(3280, "Teleport.ogg", 0.55), cue(4570, "Saint3.ogg", 0.55)] },
    gate: null,
  });
}
function dismiss() {
  const t = { cast: 380, vanish: 780, shatter: 1080, total: 2300 };
  return build({
    key: "keren-botc-dismiss", name: "Birth of the Cruel: Dismiss", shot: "keren-dismiss",
    clips: { vanish: true },
    cfg: { t, sfx: [cue(780, "Teleport.ogg", 0.45), cue(1080, "Break.ogg", 0.4)] },
    gate: null,
  });
}
// Stubborn Scion: plays when Keren is targeted, before the enemy's animation.
function stubbornScion() {
  const t = { fall: 380, land: 490, hit: 940, shove: 940, fade: 1540, hop: 1840, total: 2560 };
  return build({
    key: "keren-stubborn-scion", name: "Stubborn Scion", shot: "keren-stubborn-scion",
    clips: { twinkle: true, dashsmoke: CL.dashsmoke, smoke11: CL.smoke11 }, images: { leichi: IMG.leichi, leilan: IMG.leilan },
    cfg: { t, sfx: [cue(0, "SE_BTL_HighJump.ogg", 0.55), cue(490, "SE_JUMPLANDA.wav", 0.55), cue(490, "Shield1.wav", 0.45), cue(940, "SE_GUARDC.wav", 0.6), cue(1840, "Teleport.ogg", 0.45)] },
    gate: null,
  });
}

const jobs = [
  { name: "Multi Shatter (Keren, foxfire)", targets: [{ actor: KEREN, item: "Multi Shatter" }], gen: () => multiShatter("foxfire") },
  { name: "Multi Shatter (class, mirage)", targets: [{ world: "bbEv9kibtZscX9eJ" }], gen: () => multiShatter("mirage") },
  { name: "Illusory Shield (Keren, foxfire)", targets: [{ actor: KEREN, item: "Illusory Shield" }], gen: () => illusoryShield("foxfire") },
  { name: "Illusory Shield (class, mirage)", targets: [{ world: "MfBexg3RMmrBmeyO" }], gen: () => illusoryShield("mirage") },
  { name: "Brainwave Discharge", targets: both("Brainwave Discharge", "Kq1SPcfl8zNwegqj"), gen: brainwave },
  { name: "Charm", targets: both("Charm", "YLEEg7gkU9c9Ihd8"), gen: charm },
  { name: "Nocebo Weapon", targets: both("Nocebo Weapon", "xOIJH5IfGbZTH6Tu"), gen: nocebo },
  { name: "Life Transference", targets: both("Life Transference", "jp5JDPhrhjBsFbYf"), gen: lifeTransference },
  { name: "Create Phantasm: Numen (Keren, Crysta)", targets: [{ actor: KEREN, item: "Create Phantasm: Numen" }], gen: numen },
  { name: "Birth of the Cruel: Dismiss", targets: both("Birth of the Cruel: Dismiss", "OksWc0PJglEi3ZgZ"), gen: dismiss },
  { name: "Stubborn Scion", targets: [{ actor: KEREN, item: "Stubborn Scion" }], gen: stubbornScion },
];

module.exports = { jobs };
