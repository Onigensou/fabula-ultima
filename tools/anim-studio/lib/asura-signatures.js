"use strict";
// ============================================================================
// Asura — Asura Strike, built on oni.timeline from the approved animation mockup
// ("Asura Action Animations" artifact Ebj65AytDRWSo1MydXYpFe, v3.12, 2026-11-11).
// The inner script lives in asura-shots/ as plain text; every number the review
// tuned is in the cfg below (mockup px on a 1682 px stage; the inner scales them
// by stage width / 1682), so a tuning pass only edits numbers here.
// Same storage rule as the other generators: no backticks in the inner.
// ============================================================================

const fs = require("fs");
const path = require("path");
const { shell } = require("./dungeon-templates.js");

const FORGE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/";
const MV = FORGE + "Animation/RPG%20Maker%20MV/";
const RO = FORGE + "Animation/Ragnarok%20Online/";
const GGW = FORGE + "Animation/Guilty%20Gear%20Strive/webm/";
const SB = FORGE + "Sound/Soundboard/";
// Our own exports (pixelfx recolours + the 60 fps lit-blade clips), uploaded 2026-11-11.
// Graphic update = overwrite the same Forge path + bump ?v=N on the refs.
const LOCAL = FORGE + "Animation/pixelfx/asura/";

// clip defs: w/h = source px, ax/ay = anchor, dur ms, add = draw additive (GG masks / glows), k = the
// mockup's size factor (MV/pixelfx .55, RO 1.1) so a mockup "scale" multiplies straight through
const clip = (url, w, h, dur, ax, ay, k, add) => ({ url, w, h, dur, ax, ay, k, add: !!add });
const ASSETS = () => ({
  clips: {
    powerup: clip(MV + "051_powerup_1.webm", 508, 790, 867, 0.5, 0.543, 0.55),
    burst02: clip(GGW + "burst_anim02.webm", 682, 1024, 300, 0.5, 0.5, 0.55, true),
    twinkle: clip(GGW + "twinkle_anim02.webm", 64, 64, 250, 0.5, 0.5, 0.55, true),
    dashsmoke: clip(GGW + "dashsmoke_anim01.webm", 1024, 256, 800, 0.5, 0.5, 0.55, true),
    smoke11: clip(GGW + "smoke_anim11.webm", 170, 204, 1500, 0.5, 0.5, 0.55, true),
    ggslash: clip(GGW + "slashanim01.webm", 512, 682, 600, 0.5, 0.5, 0.55, true),
    mv_fire: clip(MV + "008_slash_fire.webm", 408, 408, 600, 0.4706, 0.6471, 0.55),
    mv_ice: clip(MV + "009_slash_ice.webm", 408, 408, 600, 0.4706, 0.6471, 0.55),
    mv_bolt: clip(MV + "010_slash_thunder.webm", 408, 408, 600, 0.4706, 0.6471, 0.55),
    mv_air: clip(MV + "091_wind_one_1.webm", 508, 510, 1000, 0.5, 0.8529, 0.55),
    hit_fire: clip(MV + "003_hit_fire.webm", 488, 488, 667, 0.5, 0.5, 0.55, true),
    hit_ice: clip(MV + "004_hit_ice.webm", 488, 488, 667, 0.5, 0.5, 0.55, true),
    hit_bolt: clip(MV + "005_hit_thunder.webm", 488, 488, 667, 0.5, 0.5, 0.55, true),
    hit_air: clip(MV + "002_hit_effect.webm", 488, 488, 400, 0.5, 0.5, 0.55, true),
    ro_fire: clip(RO + "mineffect__new_tetravortex_fire.webm", 288, 1034, 750, 0.5, 0.9, 1.1, true),
    ro_bolt: clip(RO + "new_chainlightning_target.webm", 520, 520, 1333, 0.5, 0.5, 1.1, true),
    ro_ice: clip(RO + "new_jackfrost_frost.webm", 246, 234, 1200, 0.5, 0.5, 1.1, true),
    ro_air: clip(RO + "new_windcutter_target.webm", 336, 324, 1667, 0.5, 0.5, 1.1, true),
    px_fire: clip(LOCAL + "px_double-slash_fire.webm", 492, 324, 833, 0.2683, 0.8519, 0.55),
    px_bolt: clip(LOCAL + "px_double-slash_bolt.webm", 492, 324, 833, 0.2683, 0.8519, 0.55),
    px_ice: clip(LOCAL + "px_double-slash_ice.webm", 492, 324, 833, 0.2683, 0.8519, 0.55),
    px_air: clip(LOCAL + "px_double-slash_air.webm", 492, 324, 833, 0.2683, 0.8519, 0.55),
  },
  // the in-game lit-blade cue (status-cues.js, cueClip on the four Mark AEs), 60 fps motion-smoothed copies;
  // decoded to frames once so the shot controls tempo, size and glow
  cue: {
    fire: { url: LOCAL + "008_slash_fire_mi60.webm", fallback: MV + "008_slash_fire.webm", x: 0.283, y: 0.05, size: 0.253, angle: 5.5, ax: 0.5, ay: 0.5, period: 1000, op: 0.95 },
    bolt: { url: LOCAL + "010_slash_thunder_mi60.webm", fallback: MV + "010_slash_thunder.webm", x: 0.665, y: 0.065, size: 0.258, angle: 79.1, ax: 0.5, ay: 0.5, period: 1090, op: 0.95 },
    ice: { url: LOCAL + "009_slash_ice_mi60.webm", fallback: MV + "009_slash_ice.webm", x: 0.222, y: 0.365, size: 0.35, angle: -10.7, ax: 0.5, ay: 0.5, period: 1180, op: 0.95 },
    air: { url: LOCAL + "091_wind_one_1_mi60.webm", fallback: MV + "091_wind_one_1.webm", x: 0.722, y: 0.474, size: 0.285, angle: 0, ax: 0.5, ay: 0.85, period: 1300, op: 0.85 },
  },
  cutin: FORGE + "Beastiary/Asura_Standard.png",
  darkIdle: FORGE + "Beastiary/Asura_Battle_Idle.webm",
  sfx: {
    overdrive: FORGE + "Sound/Overdrive.wav",
    thunder10: SB + "Thunder10.ogg", thunder8: SB + "Thunder8.ogg", thunder3: SB + "Thunder3.ogg",
    fire3: SB + "Fire3.ogg", ice4: SB + "Ice4.ogg", wind4: SB + "Wind4.ogg", wind1: SB + "Wind1.ogg",
    hitfire: SB + "SE_BTL_HitFire.ogg", hitice: SB + "SE_BTL_HitIce_2.ogg",
    sword1: SB + "Sword1.ogg", sword4: SB + "Sword4.ogg", explode2: SB + "SE_EXPLODE2.wav", magic4: SB + "Magic4.ogg",
    powerup: SB + "Powerup.ogg", monster5: SB + "Monster5.ogg", swingF: SB + "SE_SWINGF.wav", swingA: SB + "SE_SWINGA.wav",
    swingC: SB + "SE_SWINGC.wav", slash1: SB + "Slash1.ogg", slash2: SB + "Slash2.ogg", slash3: SB + "Slash3.ogg",
    slashM: SB + "SE_BTL_HitSlashM.wav", slashL: SB + "SE_BTL_HitSlashL.ogg", crit: SB + "SE_BTL_HitCritical.ogg",
    explosion2: SB + "Explosion2.ogg", flash2: SB + "Flash2.ogg", earth5: SB + "Earth5.ogg", darkness5: SB + "Darkness5.ogg",
  },
});

// The four blades. rgb = element colour; blade = where the blade sits on the 245x300 sprite (u, v);
// ang = the cut's angle (deg); s1 / s2 = the element's sounds.
const EL = {
  fire: { rgb: "255,128,48", hue: 18, blade: [0.22, 0.1], ang: -32, s1: "fire3", s2: "hitfire" },
  bolt: { rgb: "196,140,255", hue: 270, blade: [0.74, 0.08], ang: 28, s1: "thunder8", s2: "thunder3" },
  ice: { rgb: "150,222,255", hue: 195, blade: [0.14, 0.42], ang: -58, s1: "ice4", s2: "hitice" },
  air: { rgb: "120,236,160", hue: 135, blade: [0.84, 0.4], ang: 8, s1: "wind4", s2: "wind1" },
};

function asuraStrike(opts = {}) {
  // the user's tuned values (mockup v3.12)
  const tune = {
    auraZoom: 1.4, zoom: 1.45, zoomOut: 160, boost: 4, ignite: 700, crouch: 420, cut: 230, hush: 650,
    white: 110, shake: 26, strokes: 22, seq: 2100, wbuild: 650, wsil: 950, jump: 390,
    behind: 190,      // mockup px past the far edge of the party where he lands
  };
  // the beat clock, derived exactly as the mockup's beats run back to back
  const t = {};
  t.ign0 = 700;                                   // darken, then the first blade
  t.full = t.ign0 + 4 * tune.ignite;              // all four overcharge, the aura bursts out
  t.roar = t.full + 900;                          // roar + the Zero Power cut-in (650 in / 850 hold / 650 out)
  t.crouch = t.roar + 2150;
  t.cuts = t.crouch + tune.crouch;                // the four blink cuts
  t.land = t.cuts + 4 * tune.cut;                 // behind the party
  t.release = t.land + tune.hush + 240;           // impact frame
  t.bursts = t.release + 300;                     // the four element bursts + the damage
  t.wout = t.bursts + Math.round(tune.seq * 0.8); // the screen burns white
  t.leap = t.wout + tune.wbuild + tune.wsil + 520;
  t.landHome = t.leap + 180 + tune.jump;
  t.total = t.landHome + 1400;
  const cfg = Object.assign({
    t, ...tune, el: EL, order: ["fire", "bolt", "ice", "air"],
    redF: "sepia(1) saturate(9) hue-rotate(-52deg) brightness(.95)",
    casterFoot: 0.95, partyFoot: 0.97, seed: 7717, volume: 0.9,
    totalTimeoutMs: t.total + 15000,
  }, opts.cfg || {});
  const inner = fs.readFileSync(path.join(__dirname, "asura-shots", "asura-strike.inner.js"), "utf8");
  const assets = ASSETS();
  const script = shell({ key: opts.key, name: opts.name, cfg, assets, inner, timeout: cfg.totalTimeoutMs, startOnReady: true });
  const preload = [assets.cutin, assets.darkIdle, ...Object.values(assets.clips).map((c) => c.url).filter((u) => u.startsWith("http"))];
  // damage gate just after the fourth burst (each burst reveals its Chain strike via oni.hit)
  return { script, timing: { mode: "offset", offset: t.bursts + 3 * 110 + 60 }, preload };
}

// ── the filler moves (approved mockup v1 moves): Elemental Slash (+ Enchanted), Overflow, Sword Enchant ──
const MOVE_ASSETS = () => ({
  clips: {
    slash_phys: clip(MV + "006_slash_physical.webm", 378, 378, 333, 0.4683, 0.5794, 0.55),
    ggslash3: clip(GGW + "slashanim03.webm", 128, 256, 400, 0.5, 0.5, 0.55, true),
    mv_fire: clip(MV + "008_slash_fire.webm", 408, 408, 600, 0.4706, 0.6471, 0.55),
    mv_ice: clip(MV + "009_slash_ice.webm", 408, 408, 600, 0.4706, 0.6471, 0.55),
    mv_bolt: clip(MV + "010_slash_thunder.webm", 408, 408, 600, 0.4706, 0.6471, 0.55),
    mv_air: clip(MV + "091_wind_one_1.webm", 508, 510, 1000, 0.5, 0.8529, 0.55),
    px_fire: clip(LOCAL + "px_double-slash_fire.webm", 492, 324, 833, 0.2683, 0.8519, 0.55),
    px_bolt: clip(LOCAL + "px_double-slash_bolt.webm", 492, 324, 833, 0.2683, 0.8519, 0.55),
    px_ice: clip(LOCAL + "px_double-slash_ice.webm", 492, 324, 833, 0.2683, 0.8519, 0.55),
    px_air: clip(LOCAL + "px_double-slash_air.webm", 492, 324, 833, 0.2683, 0.8519, 0.55),
    enc_fire: clip(RO + "enc_fire.webm", 354, 354, 667, 0.5, 0.613, 1.1, true),
    enc_ice: clip(RO + "enc_ice.webm", 204, 204, 833, 0.5, 0.7451, 1.1, true),
    enc_air: clip(RO + "enc_wind.webm", 304, 278, 717, 0.5, 0.6439, 1.1, true),
    enc_bolt: clip(RO + "lightning.webm", 184, 346, 2150, 0.5, 0.9191, 1.1, true),
    smoke11: clip(GGW + "smoke_anim11.webm", 170, 204, 1500, 0.5, 0.5, 0.55, true),
    fire_expn: clip(RO + "tetravortex__tetra_01_fire_expn.webm", 334, 1034, 750, 0.5, 0.9255, 1.1, true),
    fire_all: clip(MV + "068_fire_all_1.webm", 1234, 704, 1000, 0.487, 0.5355, 0.55),
    firewall: clip(RO + "firewall.webm", 128, 346, 667, 0.4531, 0.8584, 1.1, true),
    hit_fire: clip(MV + "003_hit_fire.webm", 488, 488, 667, 0.5, 0.5, 0.55, true),
    powerup: clip(MV + "051_powerup_1.webm", 508, 790, 867, 0.5, 0.543, 0.55),
  },
  sfx: Object.assign(ASSETS().sfx, { fire1: SB + "Fire1.ogg", sword2: SB + "Sword2.ogg" }),
});
// move: "slash" | "overflow" | "enchant"; element: the enchant's element. Each owns its damage gate.
function asuraMove(opts = {}) {
  const tune = { walk: 650, windup: 380, stop: 110, rise: 520, wave: 140, drag: 420 };   // mockup defaults (approved)
  const cfg = Object.assign({ move: opts.move, element: opts.element ?? null, ...tune, el: EL, casterFoot: 0.95, partyFoot: 0.97, seed: 991, volume: 0.9, totalTimeoutMs: 20000 }, opts.cfg || {});
  let gate = 0;
  if (cfg.move === "slash") gate = cfg.walk + cfg.windup + 80 + cfg.stop;
  else if (cfg.move === "overflow") gate = 400 + cfg.rise + 160 + 150;
  else gate = cfg.drag;
  const inner = fs.readFileSync(path.join(__dirname, "asura-shots", "asura-moves.inner.js"), "utf8");
  const assets = MOVE_ASSETS();
  const script = shell({ key: opts.key, name: opts.name, cfg, assets, inner, timeout: cfg.totalTimeoutMs, startOnReady: true });
  const preload = Object.values(assets.clips).map((c) => c.url).filter((u) => u.startsWith("http"));
  return { script, timing: { mode: "offset", offset: gate }, preload };
}

module.exports = { asuraStrike, asuraMove, EL };
