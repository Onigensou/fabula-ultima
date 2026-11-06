"use strict";
// ============================================================================
// Keren — Zero Power: Last Den of Cinders, from the approved Zero Power overhaul
// mockup (artifact 5FPS7VFAX7oqnTGy9KZAVC v17, round 16). The shot is
// zp-shots/zp-keren.inner.js; every tuned number lives in cfg.t here.
// Ticks = one per parade strike (each own Phantasm 1, each own Minion 1, Leichi/
// Leilan 1, each own Numen 2) + the blast + the last hit back on the field: the
// item's chain formula (KEYWORDS) counts the same field, so cues == strikes.
// ============================================================================
const Z = require("./zp-signatures.js");
const { build, snd, F, D5, D4, MV, RO, GG } = Z;

const CI = "Campaign/The Legend of Dragonslayer/Image/";
const NPC = CI + "NPCs/";
// clip registry: native px (w, h), ms, anchor (from the RO / MV / GG / D4 manifests the mockup used)
const CLIPS = {
  hellCast: { url: RO("new_hellinferno_cast_bottom"), w: 200, h: 180, dur: 983, ax: 0.5, ay: 0.5 },
  hell:     { url: RO("new_hellinferno"), w: 128, h: 568, dur: 1000, ax: 0.5, ay: 0.8644 },
  mc:       { url: RO("efst_magiccircle__mc"), w: 112, h: 64, dur: 2417, ax: 0.5, ay: 0.5 },
  smoke:    { url: GG("smoke_anim11"), w: 170, h: 204, dur: 1500, ax: 0.5, ay: 0.5, mask: true },
  slash3:   { url: GG("slashanim03"), w: 128, h: 256, dur: 400, ax: 0.5, ay: 0.5, mask: true },
  slash1:   { url: GG("slashanim01"), w: 512, h: 682, dur: 600, ax: 0.5, ay: 0.5, mask: true },
  twinkle:  { url: GG("twinkle_anim02"), w: 64, h: 64, dur: 250, ax: 0.5, ay: 0.5, mask: true },
  magBurst: { url: D4("magenta_flame_burst"), w: 314, h: 366, dur: 867, ax: 0.5, ay: 0.5 },
  fireExp:  { url: D4("fire_explosion"), w: 132, h: 164, dur: 633, ax: 0.5, ay: 0.5 },
  dark:     { url: MV("101_darkness_one_1"), w: 546, h: 546, dur: 1467, ax: 0.5, ay: 0.5 },
  pillar:   { url: MV("117_light_pillar_1"), w: 384, h: 384, dur: 2467, ax: 0.5, ay: 0.8438 },
  fireAll:  { url: MV("070_fire_all_3"), w: 1082, h: 1150, dur: 3400, ax: 0.5055, ay: 0.4957 },
  jbFire:   { url: "modules/JB2A_DnD5e/Library/3rd_Level/Fireball/FireballExplosion_01_Orange_800x800.webm", w: 800, h: 800, dur: 4042, ax: 0.5, ay: 0.5 },
};
// images. kerenWalk / kerenBack are replaced at run time by her sheet's sprite_walk /
// sprite_stand_up_left when set; foxfire/crysta/leichi/leilan only draw the bench fallback
// (in battle every summon is drawn from its own token art).
const IMAGES = {
  cut: F(CI + "Cut-in/Keren_Cut-in002.png"),
  uwBg: F(CI + "Map/Game Map/Keren_Map001.png"),
  kerenWalk: F("Character/Keren/Keren_Walking_PLACEHOLDER.webm"),
  kerenBack: F("Character/Keren/Keren_Standing_UpLeft_PLACEHOLDER.png"),
  foxfire: "https://assets.forge-vtt.com/5faea46cf17c50c47382d836/Fire.png",
  crysta: F(NPC + "Crysta/Crysta_Battler001.webm"),
  leichi: F(NPC + "Leichi/Leichi_Standard.png"),
  leilan: F(NPC + "Leilan/Leilan_Standard.png"),
  knifeBlade: D5("Weapons/Sword", "03104_00.png"),
  knifeGrip: D5("Weapons/Sword", "03104_01.png"),
};
// sounds by key (the mockup's names); v = mockup volume x 0.7 (party VOLMUL); the shot scales per use
const SND = {
  overdrive: "Overdrive.wav", dark4: "Darkness4.ogg", darkness4: "Darkness4.ogg", dark2: "Darkness2.ogg", teleport: "Teleport.ogg",
  fire1: "Fire1.ogg", fire3: "Fire3.ogg", fall: "Fall.ogg", explode: "SE_EXPLODE.wav", explode2: "SE_EXPLODE2.wav", hitfire: "SE_HITFIRE.wav",
  swing: "SE_SWINGA.wav", swingB: "SE_SWINGC.wav", dashA: "DashA.wav", saint5: "Saint5.ogg", shing: "Metal_Shing.mp3", crystal: "SE_SYS_Gacha_Crystal.ogg",
  move1: "Move1.ogg", magic3: "Magic3.ogg", wind7: "Wind7.ogg", wind4: "Wind4.ogg", amalthea: "Amalthea_Explosion.ogg", damage2: "Damage2.ogg",
};
const S = {}; for (const [k, file] of Object.entries(SND)) S[k] = { url: snd(file), v: 0.7 };

// the user-locked tuning (mockup round 16 defaults)
const T = { drag: 1000, fall: 1000, perSummon: 1600, walkMs: 1500, spinMs: 2200, spinDeg: 150, ringFoxes: 9, ringMs: 1500, whiteHold: 1300, dropMs: 420 };

function keren() {
  const b = build({ key: "keren-last-den", name: "Zero Power: Last Den of Cinders", shot: "zp-keren", clips: CLIPS, images: IMAGES, cfg: { t: T, s: S }, gate: null, timeout: 70000 });
  // the inner script's sounds live in cfg.s (not cfg.sfx), so add them to the preload list
  b.preload = Array.from(new Set(b.preload.concat(Object.values(S).map((s) => s.url))));
  return b;
}
// Keren's actor copy + the world parent
const TARGETS = [{ actor: "gdJZ1L1kv5mjTTMr", item: "OoQjrz63C5m8OOoc" }, { world: "dKbnZH1Vw1a9WPUf" }];
// one-roll Chain: parade strikes + the blast + the last hit (no commas: the keyword list splits on them)
const KEYWORDS = 'chain {OWN_PHANTASM_COUNT + OWN_NUMEN_COUNT * 2 + OWN_MINION_COUNT + 3}';

module.exports = { keren, TARGETS, KEYWORDS, CLIPS, IMAGES };
