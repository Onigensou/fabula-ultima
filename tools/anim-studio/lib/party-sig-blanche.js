"use strict";
// ============================================================================
// Blanche (Matador) party animations, ported from the approved "Party Action
// Animations" mockup (final state). All six share one shot file,
// party-shots/blanche-matador.inner.js, switched by cfg.kind.
// Timings are the mockup's (its awaits flattened to absolute ms).
// Heal is another agent's; Muleta / Descabello / Protect / Zero Power are ports.
// ============================================================================
const PS = require("./party-signatures.js");
const { MV, GG, cue, build } = PS;

const BLANCHE = "uJFaNQCSvwwsr2AW";
const SHOT = "blanche-matador";

const C = {
  slash:  { url: GG("slashanim01"), w: 512, h: 682, dur: 600, ax: 0.5, ay: 0.5, mask: true },
  smoke:  { url: GG("smoke_anim11"), w: 170, h: 204, dur: 1500, ax: 0.5, ay: 0.5, mask: true },
  sweep:  { url: MV("038_sweep"), w: 440, h: 446, dur: 467, ax: 0.5, ay: 0.7085 },
  pdown1: { url: MV("054_powerdown_1"), w: 508, h: 656, dur: 867, ax: 0.5, ay: 0.628 },
  pdown2: { url: MV("055_powerdown_2"), w: 384, h: 384, dur: 1933, ax: 0.5, ay: 0.9375 },
  pup2:   { url: MV("052_powerup_2"), w: 508, h: 630, dur: 1200, ax: 0.5, ay: 0.6508 },
  pup3:   { url: MV("053_powerup_3"), w: 354, h: 354, dur: 1867, ax: 0.5, ay: 0.6695 },
  pillar: { url: MV("117_light_pillar_1"), w: 384, h: 384, dur: 2467, ax: 0.5, ay: 0.8438 },
  fire:   { url: MV("066_fire_one_1"), w: 776, h: 784, dur: 733, ax: 0.5, ay: 0.8827 },
};
const pick = (...keys) => Object.fromEntries(keys.map((k) => [k, C[k]]));

// Tafallera: run 0-750, spin 750-1650 (4 slashes 170 apart), ring 1250-1870
// (each enemy hit as the ring reaches it), run back 2220-2920, end 3720.
// Gate: the mockup's first hit (nearest enemy) lands ~1500; the real one depends on
// where the enemies stand relative to stage centre.
function tafallera() {
  const t = { run: 750, spinMs: 900, slashGap: 170, ring: 1250, ringMs: 620, back: 2220, backMs: 700, total: 3720 };
  const sfx = [0, 1, 2, 3].map((i) => cue(t.run + i * t.slashGap, "SE_SWINGA.wav", 0.45));
  return build({ key: "blanche-tafallera", name: "Tafallera", shot: SHOT, clips: pick("slash", "sweep"),
    cfg: { kind: "tafallera", t, sfx, hitCue: cue(0, "SE_BTL_HitSlashS.ogg", 0.45) }, gate: 1500 });
}
// Capote: step out 0-380, cape 380-1080, snorts 1080/1340, power-down 1600, back 2000, end 3070.
function capote() {
  const t = { cape: 380, capeMs: 700, snort: 1080, down: 1600, back: 2000, total: 3070 };
  const sfx = [cue(380, "SE_SWINGA.wav", 0.55), cue(1080, "Steam.mp3", 0.35), cue(1340, "Steam.mp3", 0.35), cue(1600, "Down2.ogg", 0.5)];
  return build({ key: "blanche-capote", name: "Capote", shot: SHOT, clips: pick("smoke", "pdown1"), cfg: { kind: "capote", t, sfx }, gate: null });
}
// Castigo: step out 0-380, rose 380-1080, petals + power-down 1080, back 1480, end 3013.
function castigo() {
  const t = { toss: 380, land: 1080, back: 1480, total: 3013 };
  const sfx = [cue(380, "Item1.ogg", 0.45), cue(380, "SE_SWINGA.wav", 0.4), cue(1080, "Down2.ogg", 0.55)];
  return build({ key: "blanche-castigo", name: "Castigo", shot: SHOT, clips: pick("pdown2"), cfg: { kind: "castigo", t, sfx }, gate: null });
}
// Provoke: step out 0-380, fury 380, bounces 380-780, lean 780-1000, anger mark 1150,
// tantrum hops 1400/1800/2200 (land +320), settle 3150, back 3150-3610.
function provoke() {
  const t = { fury: 380, mark: 1150, tantrum: 1400, back: 3150, total: 3610 };
  const sfx = [cue(380, "Up1.ogg", 0.45)];
  for (let i = 0; i < 3; i++) { sfx.push(cue(t.tantrum + i * 400, "Steam.mp3", 0.3)); sfx.push(cue(t.tantrum + i * 400 + 320, "SE_JUMPLANDA.wav", 0.2)); }
  return build({ key: "blanche-provoke", name: "Provoke", shot: SHOT, clips: pick("pup2", "smoke"), cfg: { kind: "provoke", t, sfx }, gate: null });
}
// Verónica (reaction, when she is targeted): petals + cape pass 0-900, crest 900, end 3267.
function veronica() {
  const t = { cape: 0, capeMs: 900, crest: 900, total: 3267 };
  const sfx = [cue(0, "SE_SWINGA.wav", 0.5), cue(900, "Up4.ogg", 0.5)];
  return build({ key: "blanche-veronica", name: "Verónica", shot: SHOT, clips: pick("pup3"), cfg: { kind: "veronica", t, sfx }, gate: null });
}
// Invocation: step out 0-380, pillar 380, orb 1280-1930, element clip 1930 (impact +67), back 1997.
// The wellspring element is the player's pick at resolve; the shot uses ONE default: Fire
// (mockup ELEMENTS.Fire: hue 12, 066_fire_one_1, HitFire.ogg).
function invocation() {
  const t = { pillar: 380, orb: 1280, orbMs: 650, hit: 1930, back: 1997, total: 2663 };
  const sfx = [cue(380, "Saint1.ogg", 0.45), cue(1930, "HitFire.ogg", 0.5)];
  return build({ key: "blanche-invocation", name: "Invocation", shot: SHOT, clips: { pillar: C.pillar, el: C.fire },
    cfg: { kind: "invocation", t, sfx, el: { name: "Fire", hue: 12, w: 776, impact: 67 } }, gate: t.hit + 67 });
}

const jobs = [
  { name: "Tafallera", targets: [{ actor: BLANCHE, item: "Tafallera" }, { world: "nqfB7DhbpF9HHRwm" }], gen: tafallera },
  { name: "Capote", targets: [{ actor: BLANCHE, item: "Capote" }, { world: "Ro1ZgoiWtBFyMQS7" }], gen: capote },
  { name: "Castigo", targets: [{ actor: BLANCHE, item: "Castigo" }, { world: "FU58EwtboDoQ0wS1" }], gen: castigo },
  { name: "Provoke", targets: [{ actor: BLANCHE, item: "Provoke" }, { world: "2B9RJckS8vLJqPXC" }, { world: "Zw14b4NHt6geS7nE" }], gen: provoke },
  { name: "Verónica", targets: [{ actor: BLANCHE, item: "Verónica" }, { world: "hfk1ejq51YWoQ2jb" }], gen: veronica },
  { name: "Invocation", targets: [{ actor: BLANCHE, item: "Invocation" }, { world: "FXRrLrmoHtcMN5s6" }], gen: invocation },
];

module.exports = { jobs };
