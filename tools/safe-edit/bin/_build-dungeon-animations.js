#!/usr/bin/env node
"use strict";
// ============================================================================
// Build + write every action animation for the Valley of the Dragon and
// Fafnir Castle rosters.
//
//   node bin/_build-dungeon-animations.js            # dry run, validates only
//   node bin/_build-dungeon-animations.js --write    # write to LevelDB
//   node bin/_build-dungeon-animations.js --write --only "Thrash"
//
// GAME MUST BE CLOSED for --write (safe-edit opens LevelDB directly).
//
// This file is the source of truth for what every skill's animation IS. The
// Valley build scripts previously drifted from the live world because live
// fixes were only ever applied through the bridge; if you tune a CFG in-game,
// fold it back HERE or the next re-run silently reverts it.
//
// DEFERRED, deliberately, per the direction plan: Fafnir, Hilde-Fafnir, Flame
// Drake, Lightning Drake (boss tier), Iron Colossus, Dire Orc, Dragon Guard
// (design not settled). Passives are skipped except the two that are real board
// events — Volt Counter and Electro Explosion.
// ============================================================================

const fs = require("fs");
const path = require("path");
const { openCollection } = require("../lib/db");

const ANIM_LIB = path.resolve(__dirname, "..", "..", "anim-studio");
const T = require(path.join(ANIM_LIB, "lib", "dungeon-templates.js"));
const G = require(path.join(ANIM_LIB, "lib", "dungeon-signatures.js"));
const { encode, validate } = require(path.join(ANIM_LIB, "lib", "encode.js"));

/* ── Palette ─────────────────────────────────────────────────────────────── */

const C = {
  physical: 0xffe9c4,
  fire:     0xff8a3d,
  // Bolt is PURPLE in this setting, not yellow (user, review round 1). Applied
  // to particle work; where a specific BLUE asset was named for a move, that
  // asset wins — an explicit choice beats a palette default.
  bolt:     0xb46bff,
  ice:      0x8fe2ff,
  air:      0xc6ffe4,
  earth:    0xc2a878,
  dark:     0x9d4dff,
  poison:   0x9fd45f,
  mana:     0x5fa8ff,
};

/* ── Shared VFX assets ───────────────────────────────────────────────────── */

const JB = "modules/JB2A_DnD5e/Library/";
const FX = {
  impactOrange: JB + "Generic/Impact/Impact_10_Regular_Orange_400x400.webm",
  impactYellow: JB + "Generic/Impact/Impact_06_Regular_Yellow_400x400.webm",
  impactBlue:   JB + "Generic/Impact/Impact_12_Regular_Blue_400x400.webm",
  trailBlueYellow: JB + "Generic/Weapon_Attacks/Melee/Group02/TrailAttack02_01_02_Regular_BlueYellow_800x600.webm",
  chainLightning:  JB + "6th_Level/Chain_Lightning/ChainLightning_01_Regular_Blue_30ft_Primary_1600x400.webm",
  clawRed1: JB + "Generic/Creature/Claw/CreatureAttackClaw_002_001_Red_800x600.webm",
  clawRed2: JB + "Generic/Creature/Claw/CreatureAttackClaw_002_002_Red_800x600.webm",
  rangedBlueGreen: JB + "Generic/RangedSpell/03/RangedProjectile03_01_Regular_BlueGreen_30ft_1600x400.webm",
  lightningBolt:   JB + "3rd_Level/Lightning_Bolt/LightningBolt_01_Regular_Blue_4000x200.webm",
  breathPoison:    JB + "Generic/Template/Cone/Breath_Weapon/BreathWeapon_Poison01_Regular_Green_30ft_Cone_Burst_600x600.webm",
  heartPink:       JB + "Generic/Marker/MarkerHeart_02_Regular_Pink_400x400.webm",
  smokePuff:       JB + "Generic/Smoke/SmokePuffRing01_03_Regular_White_400x400.webm",
  handPush: "modules/boss-loot-assets-free/artwork/05-spell/homebrew/arcane/arm/Hand_1_Push_1_BLUE_1200x1200.webm",
};

const SND = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/";
const SFX = {
  windWalk: SND + "WindWalk.wav",
  earth4:   SND + "Soundboard/Earth4.ogg",
  paralyze3: SND + "Soundboard/Paralyze3.ogg",
  dashA:    SND + "DashA.wav",
  monster2: SND + "Monster2.ogg",
  spook:    SND + "Spook.mp3",
};

/* ── Blazing Sweep reuse ─────────────────────────────────────────────────── */
//
// The shipped Centuaros sweep is already fully parametric, so reuse is a CFG
// swap rather than a rewrite. `aspectTinted` additionally injects an OUTER-side
// lookup of the caster's current Aspect AE, which is how the Asura's slash
// takes the colour of whichever element it is currently holding: the outer runs
// on the GM and has the actor, so it resolves the colour and ships it in the
// broadcast CFG.

const SWEEP_SRC = fs.readFileSync(path.join(ANIM_LIB, "templates", "blazing-sweep.js"), "utf8");

const ASPECT_INJECT = [
  "",
  "// Asura: the sweep takes the colour of the Aspect it is currently holding.",
  "// Resolved OUTER-side (this runs on the GM, which has the actor) and shipped",
  "// in the broadcast CFG, so every client draws the same colour.",
  "try {",
  "  const ASPECT_COLORS = { fire: 0xff8a3d, bolt: 0xb46bff, ice: 0x8fe2ff, air: 0xc6ffe4 };",
  "  for (const e of (sourceToken?.actor?.effects ?? [])) {",
  "    if (e?.disabled) continue;",
  "    const m = /^\\s*(fire|bolt|ice|air)\\s+aspect\\s*$/i.exec(String(e?.name ?? ''));",
  "    if (m) { CFG.color = ASPECT_COLORS[m[1].toLowerCase()]; CFG.emberColor = CFG.color; break; }",
  "  }",
  "} catch (_) {}",
  "",
].join("\n");

function sweep({ key, name, cfg = {}, aspectTinted = false }) {
  const m = SWEEP_SRC.match(/^const CFG = (\{.*\});$/m);
  if (!m) throw new Error("blazing-sweep.js: could not find the CFG line");
  const base = JSON.parse(m[1]);
  const merged = Object.assign({}, base, cfg, { key, name });
  let out = SWEEP_SRC.replace(m[0], "const CFG = " + JSON.stringify(merged) + ";");
  out = out.replace('"oni.centuaros." + CFG.key', '"oni.dungeon." + CFG.key');
  if (aspectTinted) {
    // Insert after the ANIM_KEY/asset consts, before the payload resolution —
    // sourceToken is defined further down, so the block must land after it.
    const anchor = "const partyTargets = resolveTargets();";
    if (!out.includes(anchor)) throw new Error("blazing-sweep.js: anchor for aspect injection not found");
    out = out.replace(anchor, anchor + "\n" + ASPECT_INJECT);
  }
  return out;
}

/* ── Phantom Shift art ───────────────────────────────────────────────────── */

const ART = {
  skizzik:  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Beastiary/Skizzik_Standard.png",
  obsidrax: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Beastiary/Obsidrax_Standard.png",
  manaRay:  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Beastiary/Mana%20Ray_Standard.png",
};

/* ── Verbatim reuse ──────────────────────────────────────────────────────── */
//
// Lightning Prism's Fulgur Finis takes the world Fulgur Finis animation exactly
// as it ships. Copied as STORED HTML, not re-encoded, so it is byte-identical
// to the one the players already know.

const COPY_FROM = {
  "Fulgur Finis": { collection: "items", id: "MWH6Za46Bjii884i" },
};

/* ── Registry ────────────────────────────────────────────────────────────── */
//
// actorId -> { actorName, items: { "<item name>": () => source } }

const REGISTRY = {
  // ── Asura ──────────────────────────────────────────────────────────────
  "0AwQ7wEDz4ISA9mA": {
    actorName: "Asura",
    items: {
      "Elemental Slash": () => sweep({
        key: "asura-elemental-slash", name: "Elemental Slash",
        aspectTinted: true,
        cfg: { sweeps: 1, sweepMs: 620, dashMs: 460, dashBackMs: 520, explosion: false,
               sfxSweep: "Attack2", sfxSweepVol: 0.55 },
      }),
      "Elemental Slash (Enchanted)": () => sweep({
        key: "asura-elemental-slash-ench", name: "Elemental Slash (Enchanted)",
        aspectTinted: true,
        cfg: { sweeps: 2, sweepMs: 600, betweenMs: 140, dashMs: 460, dashBackMs: 520,
               explosion: false, sfxSweep: "Attack3", sfxSweepVol: 0.6 },
      }),
      "Elemental Slash: Overflow": () => sweep({
        key: "asura-elemental-slash-overflow", name: "Elemental Slash: Overflow",
        aspectTinted: true,
        cfg: { sweeps: 3, sweepMs: 640, betweenMs: 160, dashMs: 500, dashBackMs: 560,
               explosion: true, shakeMs: 620, sfxSweep: "Attack3", sfxSweepVol: 0.6,
               sfxExplosion: "Explosion1", sfxExplosionVol: 0.6 },
      }),
      "Quad-Elemental Slash": () => G.quadElementalSlash({
        key: "asura-quad-elemental-slash", name: "Quad-Elemental Slash",
        cfg: { sfxCharge: "ChargeAttack", sfxChargeVol: 0.6,
               sfxSlash: "Attack3", sfxSlashVol: 0.55,
               sfxImpact: "Explosion2", sfxImpactVol: 0.85 },
      }),
      "Sword Enchant - Fire": () => T.burst({
        key: "asura-enchant-fire", name: "Sword Enchant - Fire",
        cfg: { color: C.fire, gatherMs: 620, count: 44, radius: 200, life: 1000,
               sfx: "Fire1", sfxVol: 0.5 },
      }),
      "Sword Enchant - Bolt": () => T.burst({
        key: "asura-enchant-bolt", name: "Sword Enchant - Bolt",
        cfg: { color: C.bolt, gatherMs: 620, count: 44, radius: 200, life: 1000,
               sfx: "Thunder1", sfxVol: 0.5 },
      }),
      "Sword Enchant - Ice": () => T.burst({
        key: "asura-enchant-ice", name: "Sword Enchant - Ice",
        cfg: { color: C.ice, gatherMs: 620, count: 44, radius: 200, life: 1000,
               sfx: "Ice1", sfxVol: 0.5 },
      }),
      "Sword Enchant - Air": () => T.burst({
        key: "asura-enchant-air", name: "Sword Enchant - Air",
        cfg: { color: C.air, gatherMs: 620, count: 44, radius: 200, life: 1000,
               sfx: "Wind1", sfxVol: 0.5 },
      }),
    },
  },

  // ── Mist Dragon ────────────────────────────────────────────────────────
  "8kluKkqkcGFkmXNO": {
    actorName: "Mist Dragon",
    items: {
      "Mist Claw": () => T.melee({
        key: "mist-claw", name: "Mist Claw",
        cfg: { color: C.air, slashCount: 0, impactWebm: FX.impactOrange, impactWebmSize: 340,
               sfx: "Wind2", sfxVol: 0.45, sfxImpact: "HitSlashS", sfxImpactVol: 0.6 },
      }),
      "Mist Breath": () => T.breath({
        key: "mist-breath", name: "Mist Breath",
        cfg: { color: C.air, particleSize: 30, sprayCount: 150, coneSpread: 0.6,
               sfx: "ChargeAttack", sfxVol: 0.45,
               sfxSpray: SFX.windWalk, sfxSprayVol: 0.6 },
      }),
      "Phantom Shift: Thunder Strike": () => G.phantomShift({
        key: "mist-phantom-thunder", name: "Phantom Shift: Thunder Strike",
        assets: { phantomArt: ART.skizzik },
        cfg: { attack: "ranged", color: C.air, travelMs: 560, orbSize: 36,
               sfxShift: "Wind3", sfxShiftVol: 0.45,
               sfx: "Thunder7", sfxVol: 0.5, sfxImpact: "Hit_Lightning", sfxImpactVol: 0.6 },
      }),
      "Phantom Shift: Venomstone Spines": () => G.phantomShift({
        key: "mist-phantom-spines", name: "Phantom Shift: Venomstone Spines",
        assets: { phantomArt: ART.obsidrax },
        cfg: { attack: "ranged", color: C.air, travelMs: 620, orbSize: 26, staggerMs: 170,
               sfxShift: "Wind3", sfxShiftVol: 0.45,
               sfx: "Wind4", sfxVol: 0.5, sfxImpact: "Hit_Piercing", sfxImpactVol: 0.55 },
      }),
      "Phantom Shift: Mana Stinger": () => G.phantomShift({
        key: "mist-phantom-stinger", name: "Phantom Shift: Mana Stinger",
        assets: { phantomArt: ART.manaRay },
        cfg: { attack: "ranged", color: C.air, travelMs: 640, orbSize: 30,
               sfxShift: "Wind3", sfxShiftVol: 0.45,
               sfx: "Magic2", sfxVol: 0.5, sfxImpact: "Absorb1", sfxImpactVol: 0.6 },
      }),
    },
  },

  // ── Kirin ──────────────────────────────────────────────────────────────
  "TvLv878yZLNUAWNN": {
    actorName: "Kirin",
    items: {
      "Hooves": () => T.melee({
        key: "kirin-hooves", name: "Hooves",
        cfg: { color: C.physical, slashCount: 0, impactWebm: FX.impactOrange, impactWebmSize: 340,
               sfx: SFX.dashA, sfxVol: 0.55, sfxImpact: "HitBlowS", sfxImpactVol: 0.65 },
      }),
      "Horn Rush": () => T.rush({
        key: "kirin-horn-rush", name: "Horn Rush",
        cfg: { dashMs: 340, holdMs: 180, returnMs: 620, overlap: 0.78,
               impactColor: C.bolt, impactCount: 26, impactRadius: 160,
               impactWebm: FX.trailBlueYellow, impactWebmSize: 460,
               shakeMs: 480, shakeAmp: 10,
               // Bolt SFX removed on request; a generic hit still marks contact.
               sfx: null, sfxArrive: "HitBlowS", sfxArriveVol: 0.7 },
      }),
      "Rail Stream": () => G.railStream({
        key: "kirin-rail-stream", name: "Rail Stream",
        // scale 1 = the natural top-to-target fall. At 3 the bolts were three
        // screen-heights long and merged into a single sheet.
        cfg: { rainWebm: FX.chainLightning, rainWebmScale: 1, rainWebmAngle: 90,
               sfxCharge: "ChargeAttack", sfxChargeVol: 0.6,
               sfxFire: "Thunder10", sfxFireVol: 0.75,
               sfxImpact: "Hit_Lightning2", sfxImpactVol: 0.5 },
      }),
    },
  },

  // ── Gigas ──────────────────────────────────────────────────────────────
  "1Lw78Js1f7MogV2B": {
    actorName: "Gigas",
    items: {
      "Heavy Swing": () => T.melee({
        key: "gigas-heavy-swing", name: "Heavy Swing",
        cfg: { color: C.physical, slashCount: 0, impactWebm: FX.impactOrange, impactWebmSize: 420,
               lungeMs: 520, returnMs: 640, particles: 28, particleRadius: 180,
               shakeMs: 620, shakeAmp: 14,
               sfx: "ChargeAttack", sfxVol: 0.5, sfxImpact: "SE_BTL_HitBlowL", sfxImpactVol: 0.85 },
      }),
      "Heavy Bodyslam": () => G.bodyslam({
        key: "gigas-heavy-bodyslam", name: "Heavy Bodyslam",
        cfg: { impactWebm: FX.impactYellow, impactWebmSize: 460,
               // WindWalk removed on request; the slam carries it.
               sfxRush: null, sfxSlam: "SE_BTL_HitBlowL", sfxSlamVol: 0.95 },
      }),
    },
  },

  // ── Obsidrax ───────────────────────────────────────────────────────────
  "x8TBsDZaRgoSo5no": {
    actorName: "Obsidrax",
    items: {
      "Basalt Crush": () => T.rush({
        key: "obsidrax-basalt-crush", name: "Basalt Crush",
        cfg: { dashMs: 380, holdMs: 200, returnMs: 640, overlap: 0.76,
               impactColor: C.earth, impactCount: 24, impactRadius: 150,
               impactWebm: FX.impactOrange, impactWebmSize: 380,
               shakeMs: 480, shakeAmp: 10,
               sfx: SFX.earth4, sfxVol: 0.6, sfxArrive: "Earth2", sfxArriveVol: 0.75 },
      }),
      "Venomstone Spines": () => T.burst({
        key: "obsidrax-venomstone-spines", name: "Venomstone Spines",
        cfg: { color: C.poison, at: "targets", count: 26, radius: 170, size: 12,
               // Quills come off the Obsidrax itself, porcupine-style, before the
               // hits land on the targets.
               needles: 26, needleColor: 0x86c93f, needleLen: 120, needleWidth: 5,
               needleReach: 360, needleMs: 760,
               shake: true, shakeMs: 420, shakeAmp: 8,
               sfx: "Poison", sfxVol: 0.55 },
      }),
      "Tectonic Collapse": () => G.boulders({
        key: "obsidrax-tectonic-collapse", name: "Tectonic Collapse",
        cfg: { sfxRumble: "Quake", sfxRumbleVol: 0.65, sfxHit: "Earth3", sfxHitVol: 0.5 },
      }),
      "Miasma Nova": () => T.breath({
        key: "obsidrax-miasma-nova", name: "Miasma Nova",
        cfg: { color: C.poison, particleSize: 30, sprayCount: 140, coneSpread: 0.75,
               reach: 1.35, puffRadius: 160,
               sfx: "ChargeAttack", sfxVol: 0.4, sfxSpray: "Poison", sfxSprayVol: 0.65 },
      }),
    },
  },

  // ── Skizzik ────────────────────────────────────────────────────────────
  "I2sSkVIQ4FCunZBE": {
    actorName: "Skizzik",
    items: {
      "Thunder Strike": () => G.thunderStrikeDash({
        key: "skizzik-thunder-strike", name: "Thunder Strike",
        cfg: { color: C.bolt, impactWebm: FX.impactBlue, impactWebmSize: 400,
               sfxDash: "ThunderStep", sfxDashVol: 0.6,
               sfxImpact: "Hit_Lightning2", sfxImpactVol: 0.75,
               sfxImpactFade: 900, sfxImpactFadeMs: 500 },
      }),
      // Same shot, as directed. This one is fired by Overload Riposte on every
      // even-parity accuracy roll, so it is the one most likely to want a
      // shorter dashMs if the repeat starts to drag.
      "Thunder Strike (Riposte)": () => G.thunderStrikeDash({
        key: "skizzik-thunder-strike-riposte", name: "Thunder Strike (Riposte)",
        cfg: { color: C.bolt, impactWebm: FX.impactBlue, impactWebmSize: 360,
               sfxDash: "ThunderStep", sfxDashVol: 0.5,
               sfxImpact: "Hit_Lightning", sfxImpactVol: 0.65,
               sfxImpactFade: 800, sfxImpactFadeMs: 500 },
      }),
    },
  },

  // ── Lightning Prism ────────────────────────────────────────────────────
  "sTGMdYipYCG36aBO": {
    actorName: "Lightning Prism",
    items: {
      "Arc Spark": () => T.ranged({
        key: "prism-arc-spark", name: "Arc Spark",
        // Jingle (Shock1) dropped on request — only the lightning hit remains.
        cfg: { color: C.bolt, travelMs: 520, orbSize: 26,
               sfx: null, sfxImpact: "HitElectric", sfxImpactVol: 0.6 },
      }),
      "Fulgur Finis": "COPY",
    },
  },

  // ── Drakoza ────────────────────────────────────────────────────────────
  "H6Ubup6kmkgNQzLU": {
    actorName: "Drakoza",
    items: {
      "Dragon Claw": () => T.melee({
        key: "drakoza-dragon-claw", name: "Dragon Claw",
        cfg: { color: C.physical, slashCount: 0,
               impactWebm: FX.clawRed1, impactWebmSize: 460,
               sfx: SFX.dashA, sfxVol: 0.55, sfxImpact: "HitSlashM", sfxImpactVol: 0.7 },
      }),
      "Tail Swipe": () => sweep({
        key: "drakoza-tail-swipe", name: "Tail Swipe",
        // Wind bed dropped (it rang on long after the swipe finished) and replaced
        // with a generic impact, which lands on the sweep itself.
        cfg: { sweeps: 1, sweepMs: 640, dashMs: 420, dashBackMs: 500,
               color: 0xffd9a0, emberColor: 0xffc98a, explosion: false,
               sfxSweep: "HitBlowS", sfxSweepVol: 0.7 },
      }),
      "Thrash": () => G.thrash({
        key: "drakoza-thrash", name: "Thrash",
        cfg: { sfxThrash: "SE_Hardwind_long", sfxThrashVol: 0.55,
               sfxThrashFade: 1600, sfxThrashFadeMs: 600,
               sfxImpact: "SE_BTL_HitBlowL", sfxImpactVol: 0.9 },
      }),
    },
  },

  // ── Ampere ─────────────────────────────────────────────────────────────
  "kAYN54Id3iTAOw1A": {
    actorName: "Ampere",
    items: {
      "Bubble Beam": () => G.bubbles({
        key: "ampere-bubble-beam", name: "Bubble Beam",
        cfg: { spread: false, count: 9, travelMs: 1200,
               sfx: "Water1", sfxVol: 0.45, sfxPop: "Water_Drop", sfxPopVol: 0.4 },
      }),
      "Bubble Splash": () => G.bubbles({
        key: "ampere-bubble-splash", name: "Bubble Splash",
        cfg: { spread: true, count: 26, travelMs: 1400, radiateRadius: 460,
               sfx: "SE_WATER", sfxVol: 0.55, sfxPop: "Water_Drop", sfxPopVol: 0.35 },
      }),
      "Volt Counter": () => T.burst({
        key: "ampere-volt-counter", name: "Volt Counter",
        cfg: { color: C.bolt, count: 26, radius: 190, size: 11, life: 700,
               ring: true, ringMs: 700, ringRadius: 230, ringWidth: 5,
               sfx: SFX.paralyze3, sfxVol: 0.6 },
      }),
    },
  },

  // ── Mana Ray ───────────────────────────────────────────────────────────
  "iGc0EUHE9LKWT0Ye": {
    actorName: "Mana Ray",
    items: {
      "Mana Stinger": () => T.drain({
        key: "manaray-mana-stinger", name: "Mana Stinger",
        cfg: { color: C.mana, approach: true, arrow: false,
               beamWebm: FX.rangedBlueGreen, beamThickness: 0.22, beamHoldMs: 560,
               sfx: "WindWalk", sfxVol: 0.4, sfxDrain: "Absorb1", sfxDrainVol: 0.6 },
      }),
      "Volt Stinger": () => T.drain({
        key: "manaray-volt-stinger", name: "Volt Stinger",
        cfg: { color: C.bolt, approach: true, arrow: false,
               beamWebm: FX.lightningBolt, beamThickness: 0.09, beamHoldMs: 520,
               sfx: "ThunderStep", sfxVol: 0.45, sfxDrain: "HitElectric", sfxDrainVol: 0.6 },
      }),
    },
  },

  // ── Electro Slime ──────────────────────────────────────────────────────
  "A1VzokzJPoyxobCd": {
    actorName: "Electro Slime",
    items: {
      "Tackle": () => T.melee({
        key: "eslime-tackle", name: "Tackle",
        cfg: { color: C.physical, slashCount: 0, impactWebm: FX.impactOrange, impactWebmSize: 320,
               lungeMs: 300, returnMs: 460, standoff: 0.8,
               sfx: SFX.dashA, sfxVol: 0.55, sfxImpact: "HitBlowS", sfxImpactVol: 0.6 },
      }),
      "Static Shot": () => T.ranged({
        key: "eslime-static-shot", name: "Static Shot",
        // Same template and treatment as Arc Spark, on request.
        cfg: { color: C.bolt, travelMs: 520, orbSize: 26,
               sfx: null, sfxImpact: "HitElectric", sfxImpactVol: 0.6 },
      }),
      "Electro Explosion": () => T.burst({
        key: "eslime-electro-explosion", name: "Electro Explosion",
        cfg: { color: C.bolt, count: 52, radius: 380, size: 15, life: 1000,
               ring: true, ringMs: 950, ringRadius: 440, ringWidth: 9,
               flash: true, flashColor: "#e3c4ff", flashAlpha: 0.4,
               screenshakeMs: 620, screenshakeAmp: 9,
               shake: true, shakeMs: 460, shakeAmp: 8,
               sfx: "Explosion1", sfxVol: 0.7 },
      }),
    },
  },

  // ── Carlbero ───────────────────────────────────────────────────────────
  "B4qRdBIxFN6dZ6MT": {
    actorName: "Carlbero",
    items: {
      "Tentacle Slap": () => T.melee({
        key: "carlbero-tentacle-slap", name: "Tentacle Slap",
        cfg: { color: 0xb6d98a, slashCount: 0, impactWebm: FX.impactOrange, impactWebmSize: 380,
               lungeMs: 440, returnMs: 560,
               sfx: "Attack2", sfxVol: 0.5, sfxImpact: "HitBlowS", sfxImpactVol: 0.7 },
      }),
      "Tentacle Grab": () => T.rush({
        key: "carlbero-tentacle-grab", name: "Tentacle Grab",
        cfg: { dashMs: 460, holdMs: 620, returnMs: 660, overlap: 0.74,
               impactColor: 0xb6d98a, impactCount: 20, impactRadius: 130,
               impactWebm: FX.impactOrange, impactWebmSize: 360,
               sfx: null, sfxArrive: "Hit_Piercing", sfxArriveVol: 0.65 },
      }),
      "Stinky Breath": () => G.stinkyBreath({
        key: "carlbero-stinky-breath", name: "Stinky Breath",
        cfg: { coneWebm: FX.breathPoison, coneWebmScale: 2, coneWebmThickness: 1,
               sfxBuild: SFX.monster2, sfxBuildVol: 0.7,
               sfxSpray: "Poison", sfxSprayVol: 0.7 },
      }),
      // "Blue particles flying from the target to the caster" — no approach,
      // the Carlbero saps at range from whatever it already has Grappled.
      "Mind Sap": () => T.drain({
        key: "carlbero-mind-sap", name: "Mind Sap",
        cfg: { color: C.mana, approach: false, arrow: false,
               drainCount: 42, drainMs: 1400, drainStagger: 600, drainSize: 12,
               impactCount: 20, impactRadius: 130,
               sfx: "Darkness2", sfxVol: 0.5, sfxDrain: "Absorb2", sfxDrainVol: 0.6 },
      }),
    },
  },

  // ── Succubus ───────────────────────────────────────────────────────────
  "bnem1vdA6Bv3mBVx": {
    actorName: "Succubus",
    items: {
      "Rake": () => T.melee({
        key: "succubus-rake", name: "Rake",
        cfg: { color: C.dark, slashCount: 0,
               impactWebm: FX.clawRed2, impactWebmSize: 440,
               sfx: "Attack1", sfxVol: 0.45, sfxImpact: "HitSlashS", sfxImpactVol: 0.6 },
      }),
      "Charm": () => G.charm({
        key: "succubus-charm", name: "Charm",
        cfg: { sfxCast: "Charm", sfxCastVol: 0.6, sfxImpact: "Heal3", sfxImpactVol: 0.65 },
      }),
      // The slow overlap and the three-second hold ARE the move.
      "Draining Kiss": () => T.rush({
        key: "succubus-draining-kiss", name: "Draining Kiss",
        cfg: { dashMs: 900, holdMs: 3000, returnMs: 1100, overlap: 1,
               impact: false,
               holdWebm: FX.heartPink, holdWebmSize: 400, holdWebmFadeMs: 700,
               sfx: "Magic1", sfxVol: 0.45, sfxArrive: "Charm", sfxArriveVol: 0.55 },
      }),
    },
  },

  // ── Death Gazer ────────────────────────────────────────────────────────
  "fCxslZazJKtQWsKP": {
    actorName: "Death Gazer",
    items: {
      "Eye Beam": () => T.ranged({
        key: "gazer-eye-beam", name: "Eye Beam",
        cfg: { color: C.dark, coreColor: 0xe8d0ff, travelMs: 560, orbSize: 26,
               sfx: "Darkness1", sfxVol: 0.45, sfxImpact: "Hit_Piercing", sfxImpactVol: 0.55 },
      }),
      "Mind Sear": () => T.ranged({
        key: "gazer-mind-sear", name: "Mind Sear",
        cfg: { color: C.dark, coreColor: 0xe8d0ff, travelMs: 640, orbSize: 34,
               windupMs: 460, impactCount: 26,
               sfx: "Magic3", sfxVol: 0.5, sfxImpact: "Darkness3", sfxImpactVol: 0.6 },
      }),
      "Death Gaze": () => G.deathGaze({
        key: "gazer-death-gaze", name: "Death Gaze",
        cfg: { sfxTick: "Cursor1", sfxTickVol: 0.35,
               sfxLand: "Darkness5", sfxLandVol: 0.85 },
      }),
    },
  },

  // ── Imp ────────────────────────────────────────────────────────────────
  "wjGqTFMH0Z7yZkZt": {
    actorName: "Imp",
    items: {
      "Pitchfork": () => T.melee({
        key: "imp-pitchfork", name: "Pitchfork",
        cfg: { color: C.physical, slashCount: 0, impactWebm: FX.impactOrange, impactWebmSize: 320,
               lungeMs: 340, returnMs: 460,
               sfx: "Attack1", sfxVol: 0.45, sfxImpact: "Hit_Piercing", sfxImpactVol: 0.6 },
      }),
      "Strip Armor": () => G.stripEquip({
        key: "imp-strip-armor", name: "Strip Armor",
        cfg: { grabWebm: FX.handPush, grabWebmSize: 420, lootEmoji: "🛡️", lootEmojiSize: 58,
               sfxDash: SFX.dashA, sfxDashVol: 0.55, sfxSnatch: "Steal", sfxSnatchVol: 0.85 },
      }),
      "Strip Weapon": () => G.stripEquip({
        key: "imp-strip-weapon", name: "Strip Weapon",
        cfg: { grabWebm: FX.handPush, grabWebmSize: 420, lootEmoji: "⚔️", lootEmojiSize: 58,
               sfxDash: SFX.dashA, sfxDashVol: 0.55, sfxSnatch: "Steal", sfxSnatchVol: 0.85 },
      }),
      // Cartoon jitter around the victim — annoying is the whole point.
      "Prank": () => T.rush({
        key: "imp-prank", name: "Prank",
        // overlap 1 puts the Imp exactly on the target — it is in their face, which
        // is the joke; stopping short reads as an ordinary melee approach.
        cfg: { dashMs: 320, holdMs: 1600, returnMs: 520, overlap: 1,
               jitter: true, jitterAmp: 46, jitterHz: 4.2,
               impact: false,
               holdWebm: FX.smokePuff, holdWebmSize: 300, holdWebmRepeatMs: 460,
               sfx: "Cursor2", sfxVol: 0.4, sfxArrive: SFX.spook, sfxArriveVol: 0.6 },
      }),
    },
  },
};

/* ── Runner ──────────────────────────────────────────────────────────────── */

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const k = a.slice(2);
    const nx = argv[i + 1];
    if (nx && !nx.startsWith("--")) { flags[k] = nx; i++; } else flags[k] = true;
  }
  return flags;
}

async function loadCopySources() {
  const out = {};
  const byColl = {};
  for (const [name, spec] of Object.entries(COPY_FROM)) {
    (byColl[spec.collection] ||= []).push([name, spec.id]);
  }
  for (const [coll, wants] of Object.entries(byColl)) {
    const db = await openCollection(coll);
    try {
      for (const [name, id] of wants) {
        const doc = await db.get("!" + coll + "!" + id).catch(() => null);
        const raw = doc?.system?.props?.animation_script;
        if (!raw) throw new Error(`copy source ${coll}.${id} (${name}) has no animation_script`);
        out[name] = raw;
      }
    } finally { await db.close(); }
  }
  return out;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const write = !!flags.write;
  const only = typeof flags.only === "string" ? flags.only.toLowerCase() : null;

  const copies = await loadCopySources();
  console.log(`copy sources loaded: ${Object.keys(copies).join(", ")}`);

  // Build + validate everything BEFORE opening the actors DB for writing, so a
  // generator bug can never leave the store half-written.
  const jobs = [];
  let failures = 0;
  for (const [actorId, entry] of Object.entries(REGISTRY)) {
    for (const [itemName, gen] of Object.entries(entry.items)) {
      if (only && !itemName.toLowerCase().includes(only) && !entry.actorName.toLowerCase().includes(only)) continue;
      let src, stored;
      if (gen === "COPY") {
        stored = copies[itemName];
        if (!stored) { console.error(`✗ ${entry.actorName} / ${itemName}: no copy source`); failures++; continue; }
        jobs.push({ actorId, actorName: entry.actorName, itemName, stored, mode: "copy" });
        continue;
      }
      try { src = gen(); }
      catch (e) { console.error(`✗ ${entry.actorName} / ${itemName}: generator threw — ${e.message}`); failures++; continue; }
      const r = validate(src);
      if (!r.ok) {
        console.error(`✗ ${entry.actorName} / ${itemName}: INVALID`);
        r.errors.forEach((e) => console.error(`    ${e}`));
        failures++;
        continue;
      }
      r.warnings.forEach((w) => console.warn(`  ! ${entry.actorName} / ${itemName}: ${w}`));
      jobs.push({ actorId, actorName: entry.actorName, itemName, stored: encode(src), mode: "gen", len: src.length });
    }
  }

  if (failures) {
    console.error(`\n${failures} script(s) failed validation — nothing written.`);
    process.exit(1);
  }
  console.log(`\n${jobs.length} script(s) built and validated.`);

  if (!write) {
    for (const j of jobs) console.log(`  [dry] ${j.actorName.padEnd(16)} ${j.itemName.padEnd(32)} ${j.mode}${j.len ? " " + j.len + "b" : ""}`);
    console.log("\nDry run — pass --write to apply. GAME MUST BE CLOSED.");
    return;
  }

  // Item docs live at !actors.items!<actorId>.<itemId>; find each by name.
  const db = await openCollection("actors");
  let wrote = 0, missing = 0;
  try {
    const index = new Map(); // actorId -> Map(itemName -> [key, doc])
    for await (const [key, val] of db.iterator()) {
      if (!key.startsWith("!actors.items!")) continue;
      const aid = key.split("!")[2].split(".")[0];
      if (!REGISTRY[aid]) continue;
      if (!index.has(aid)) index.set(aid, new Map());
      index.get(aid).set(String(val.name ?? ""), [key, val]);
    }
    for (const j of jobs) {
      const hit = index.get(j.actorId)?.get(j.itemName);
      if (!hit) { console.error(`✗ ${j.actorName} / ${j.itemName}: item not found on actor`); missing++; continue; }
      const [key, doc] = hit;
      doc.system = doc.system || {};
      doc.system.props = doc.system.props || {};
      doc.system.props.animation_script = j.stored;
      // BD ignores the legacy skill_animation_* fields, but leaving "default"
      // there while a real script exists is a lie to anyone reading the sheet.
      doc.system.props.skill_animation_mode = "custom";
      await db.put(key, doc);
      wrote++;
      console.log(`  ✓ ${j.actorName.padEnd(16)} ${j.itemName}`);
    }
  } finally { await db.close(); }

  console.log(`\nwrote ${wrote} / ${jobs.length}${missing ? `, ${missing} MISSING` : ""}`);
  if (missing) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
