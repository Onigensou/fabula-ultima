"use strict";
// ============================================================================
// Masked Girl (Kalina), legacy boss pass: the ten moves built on oni.timeline from the approved
// "Legacy Boss Animations" mockup (part-b1 Masked Girl defs + the r3 / r4 / r5 / r6 overrides,
// 2026-11-15). Each shot = legacy-shots/masked-kit.inner.js + one masked-<shot>.inner.js, wrapped by
// dungeon-templates.shell() (Spear Rain: its own wrapper, which keeps the shipped random-target +
// AdvanceDamage logic in the outer script). Every number the review tuned is in the cfg below
// (mockup px on a 1682 px stage; the inner scales them by stage width / 1682).
// Storage rule: no backticks / dollar-brace in any inner.
//
//   const LM = require("./legacy-masked-signatures.js");
//   LM.rebelliousWing({ key, name }) -> { script, timing, preload }   (same for every move below)
// ============================================================================

const fs = require("fs");
const path = require("path");
const { shell } = require("./dungeon-templates.js");

const FORGE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/";
const MV = FORGE + "Animation/RPG%20Maker%20MV/";
const RO = FORGE + "Animation/Ragnarok%20Online/";
const JB = "modules/JB2A_DnD5e/Library/";
const SB = FORGE + "Sound/Soundboard/";
const SND = FORGE + "Sound/";
const KAL = FORGE + "Campaign/The%20Legend%20of%20Dragonslayer/Image/NPCs/Kalina/";

// clip defs: w/h = source px, ax/ay = anchor, dur ms, k = the mockup's size factor (MV/JB .55, RO 1.1), add = additive
const clip = (url, w, h, dur, ax, ay, k, add) => ({ url, w, h, dur, ax, ay, k, add: !!add });
const CLIPS = {
  strand: clip(JB + "Generic/Energy/EnergyStrandIN01_02_Regular_Green_600x600.webm", 600, 600, 1833, 0.5, 0.5, 0.55),
  impact10: clip(JB + "Generic/Impact/Impact_10_Regular_Orange_400x400.webm", 400, 400, 567, 0.5, 0.5, 0.55),
  fireball: clip(JB + "3rd_Level/Fireball/FireballExplosion_01_Orange_800x800.webm", 800, 800, 4042, 0.5, 0.5, 0.55),
  bomb: clip(RO + "new_dragonbreath_bomb.webm", 216, 352, 1667, 0.4861, 0.7955, 1.1, true),
  bombBottom: clip(RO + "new_dragonbreath_bomb_bottom.webm", 212, 182, 1667, 0.5, 0.5659, 1.1, true),
  wind: clip(MV + "091_wind_one_1.webm", 508, 510, 1000, 0.5, 0.8529, 0.55),
  pierce: clip(MV + "011_pierce_physical.webm", 660, 660, 467, 0.5, 0.503, 0.55),
  powerdown: clip(MV + "054_powerdown_1.webm", 508, 656, 867, 0.5, 0.628, 0.55),
};
// the mockup's sound table (build-assets.js S) for the keys these moves use
const SFX = {
  overdrive: SND + "Overdrive.wav", burstmax: SND + "BurstMax.ogg", charging: SND + "ChargingA.wav", execution: SND + "ExecutionGET.wav",
  hitpierceb: SND + "Hit_PiercingB.ogg", hitslashb: SND + "Hit_SlashingB.wav",
  jump2: SB + "SE_BTL_HighJump.ogg", wind1: SB + "Wind1.ogg", wind4: SB + "Wind4.ogg", wind7: SB + "Wind7.ogg",
  magic4: SB + "Magic4.ogg", flash2: SB + "Flash2.ogg", monster5: SB + "Monster5.ogg", swingA: SB + "SE_SWINGA.wav",
  explosion2: SB + "Explosion2.ogg", fire3: SB + "Fire3.ogg",
};
const POSE_FILES = { jump: "Kalina_Jump.png", reach: "Kalina_Reach.png", curl: "Kalina_Curl.png", release: "Kalina_Release.png", diveland: "Kalina_DiveLand.png" };
const WINGED = KAL + "Kalina_Battler002.webm";
const CUTIN = KAL + "Kalina_Cut-In.png";

// Guest Kalina's Skyfall Dive numbers (mockup r3 GUEST cfg), used by Jump / Skyfall Dive / Dragonfire Dive
const GUEST = { squash: 0.8, squashMs: 160, holdMs: 220, releaseMs: 120, upMs: 220, peakMs: 700, diveMs: 170, backMs: 400, apex: 260, landFrac: 0.72, slideMs: 450, lateral: 600, ghosts: 5, lagMs: 20, ghostA: 0.6 };

const KIT = fs.readFileSync(path.join(__dirname, "legacy-shots", "masked-kit.inner.js"), "utf8");
const inner = (shot) => KIT + "\n// ── shot ──\n" + fs.readFileSync(path.join(__dirname, "legacy-shots", "masked-" + shot + ".inner.js"), "utf8");

// assets for one shot: only the clips / poses / sounds it uses (the preload list follows)
function assetsFor({ clips = [], poses = [], sfx = [], winged = false, cutin = false }) {
  const a = { clips: {}, images: {}, sfx: {} };
  for (const k of clips) a.clips[k] = CLIPS[k];
  for (const p of poses) a.images["pose_" + p] = KAL + POSE_FILES[p];
  if (cutin) a.images.cutin = CUTIN;
  if (winged) a.winged = WINGED;
  for (const s of sfx) a.sfx[s] = SFX[s];
  return a;
}
const preloadOf = (a) => Array.from(new Set([
  ...Object.values(a.clips).map((c) => c.url),
  ...Object.values(a.images),
  ...(a.winged ? [a.winged] : []),
  ...Object.values(a.sfx),
].filter(Boolean)));

// gate: a number = the director starts RESOLVE that many ms after animationStart; null = the inner's fireDone
function build(opts, shot, cfgIn, a, gate) {
  const cfg = Object.assign({ casterFoot: 0.95, partyFoot: 0.97, volume: 0.9, totalTimeoutMs: 20000 }, cfgIn, opts.cfg || {});
  const script = shell({ key: opts.key, name: opts.name, cfg, assets: a, inner: inner(shot), timeout: cfg.totalTimeoutMs, startOnReady: true });
  return { script, timing: gate == null ? { mode: "default", offset: 0 } : { mode: "offset", offset: gate }, preload: preloadOf(a) };
}

// ── Zero Power: Rebellious Wing ──
function rebelliousWing(opts = {}) {
  // mockup r3 defaults (approved); lag = the camera's per-frame catch-up, zoom = the end push-in
  const tune = { leapMs: 520, follow: 1700, lag: 0.07, zoom: 1.75, unfold: 1500, beat: 300, hover: 40, settle: 400 };
  const t = {};
  t.cutEnd = 650 + 850 + 650;                           // the cut-in
  t.void = t.cutEnd + 120;                              // white peak: the void, everyone else fades
  t.squash = t.void + 380;                              // crouch
  t.leap = t.squash + 140;
  t.reach = t.leap + tune.leapMs + Math.round(tune.follow * 0.55);
  t.strands = t.leap + tune.leapMs + tune.follow + 200;
  t.unfold = t.strands + 700;
  t.flare = t.unfold + tune.unfold;
  t.beat = t.flare + 260 + 160;
  t.form = t.beat + tune.beat + 90;                     // flash: the winged battler
  t.back = t.form + 260;
  t.gate = t.back + 520;
  t.total = t.gate + 2000 + tune.settle;
  const a = assetsFor({ clips: ["strand"], poses: ["jump", "reach", "curl", "release"], winged: true, cutin: true,
    sfx: ["overdrive", "burstmax", "jump2", "charging", "wind7", "magic4", "flash2", "wind1", "execution"] });
  // full-takeover timeline (live: false): this cinematic drives the camera, which the live board cannot
  return build(opts, "wing", { move: "wing", live: false, t, ...tune, wingRgb: "120,255,140", focus: true, poses: ["jump", "reach", "curl", "release"], seed: 4401, totalTimeoutMs: t.total + 15000 }, a, t.gate);
}

// ── Jump / Skyfall Dive / Dragonfire Dive (guest dive) ──
function jump(opts = {}) {
  const gate = GUEST.squashMs + GUEST.holdMs + GUEST.releaseMs + GUEST.upMs;
  const a = assetsFor({ sfx: ["jump2"] });
  return build(opts, "dive", { move: "jump", guest: GUEST, seed: 4402 }, a, gate);
}
function diveGate(winged) {
  const d0 = winged ? GUEST.upMs + Math.round(GUEST.peakMs * 0.6) : GUEST.peakMs;
  return d0 + GUEST.diveMs + 140 + GUEST.backMs + GUEST.slideMs + GUEST.ghosts * GUEST.lagMs + 60;
}
function skyfallDive(opts = {}) {
  const a = assetsFor({ clips: ["impact10"], poses: ["diveland", "jump"], sfx: ["wind7", "hitslashb"] });
  return build(opts, "dive", { move: "skyfall", guest: GUEST, poses: ["diveland", "jump"], seed: 4403 }, a, diveGate(false));
}
function dragonfireDive(opts = {}) {
  const a = assetsFor({ clips: ["fireball", "bomb", "bombBottom"], winged: true, sfx: ["wind1", "wind7", "explosion2", "fire3"] });
  return build(opts, "dive", { move: "dragonfire", guest: GUEST, seed: 4404 }, a, diveGate(true));
}

// ── Hurl Spear / Piercing Talon / Wind Lance ──
function hurlSpear(opts = {}) {
  const tune = { n: 4, fly: 280 };
  const a = assetsFor({ sfx: ["wind4", "wind7"] });
  return build(opts, "spears", { move: "hurl", ...tune, seed: 4405 }, a, 220 + tune.n * 170 + 180);
}
function piercingTalon(opts = {}) {
  const a = assetsFor({ clips: ["pierce"], sfx: ["wind7", "hitpierceb"] });
  return build(opts, "spears", { move: "talon", seed: 4406 }, a, 220 + 240 + 200);
}
function windLance(opts = {}) {
  const a = assetsFor({ clips: ["wind"], sfx: ["wind4", "wind1", "hitpierceb"] });
  return build(opts, "spears", { move: "lance", seed: 4407 }, a, 450 + 300 + 200);
}

// ── Spear / Draconic Roar ──
function spear(opts = {}) {
  const a = assetsFor({ clips: ["pierce"], sfx: ["swingA", "hitpierceb"] });
  return build(opts, "melee", { move: "spear", seed: 4408 }, a, 360 + 90);
}
function draconicRoar(opts = {}) {
  // the gate depends on the party size (one 60 ms beat per foe), so the inner fires it
  const a = assetsFor({ clips: ["powerdown"], sfx: ["monster5"] });
  return build(opts, "melee", { move: "roar", seed: 4409 }, a, null);
}

// ── Spear Rain: keeps the shipped logic (outer script, runs once on the acting client): HITS_TOTAL hits, each on a
// random disposition-1 token of the scene, each applying 10 through the AdvanceDamage macro in the __PAYLOAD
// convention (same payload as shipped). The picks are made up front and handed to the shot (params.picks), and
// each AdvanceDamage call now lands on its spear's impact frame instead of at the old VFX start. ──
function spearRain(opts = {}) {
  const tune = { gap: 230, plunge: 120, hitsTotal: 3 };
  const hits = Array.from({ length: tune.hitsTotal }, (_, i) => i * tune.gap + 240 + tune.plunge);
  const cfg = Object.assign({ move: "rain", ...tune, hits, casterFoot: 0.95, partyFoot: 0.97, volume: 0.9, seed: 4410, totalTimeoutMs: hits[hits.length - 1] + 1200 + 15000 }, opts.cfg || {});
  const a = assetsFor({ clips: ["wind"], sfx: ["wind7", "hitpierceb"] });
  const key = opts.key, name = opts.name;
  const j = (v) => JSON.stringify(v);
  const script = [
    "// " + name + " — generated by tools/anim-studio/lib/legacy-masked-signatures.js (spearRain)",
    "// Re-run the legacy boss build to regenerate. Keeps the shipped Spear Rain logic: random targets + AdvanceDamage.",
    "(async () => {",
    "",
    "const CFG = " + j(cfg) + ";",
    "const ASSETS = " + j(a) + ";",
    "const ANIM_KEY = " + j("oni.dungeon." + key) + ";",
    "const TAG = " + j("[ONI][Anim][" + name + "]") + ";",
    "",
    "const P = globalThis.__PAYLOAD ?? payload ?? {};",
    "function tokFromUuid(u) { try { const d = fromUuidSync?.(u); return d?.object ?? null; } catch (_) { return null; } }",
    "function resolveSource() {",
    "  for (const c of [P?.casterTokenUuid, P?.sourceTokenUuid, P?.tokenUuid]) { const t = tokFromUuid(c); if (t) return t; }",
    "  return canvas?.tokens?.controlled?.[0] ?? null;",
    "}",
    "const sourceToken = resolveSource();",
    "const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));",
    "",
    "// ── shipped logic: AdvanceDamage in the global __PAYLOAD convention ──",
    "async function runAdvanceDamageHeadless(dmgPayload) {",
    "  const ADV = game.macros.getName('AdvanceDamage');",
    "  if (!ADV) throw new Error('Macro not found: AdvanceDamage');",
    "  const prevAUTO = globalThis.__AUTO;",
    "  const prevPAYLOAD = globalThis.__PAYLOAD;",
    "  try { globalThis.__AUTO = true; globalThis.__PAYLOAD = dmgPayload; return await ADV.execute(); }",
    "  finally { globalThis.__AUTO = prevAUTO; globalThis.__PAYLOAD = prevPAYLOAD; }",
    "}",
    "// legit targets = disposition 1 tokens on the current scene",
    "const legitTargets = (canvas.tokens?.placeables ?? []).filter((_token) => _token?.document?.disposition === 1);",
    "if (!legitTargets.length) { ui.notifications.warn('No legit targets found (disposition === 1) on this scene.'); return; }",
    "const attackerUuid = P?.meta?.attackerUuid ?? P?.attackerUuid ?? P?.attacker_uuid ?? '';",
    "const attackerName = P?.meta?.attackerName ?? P?.attackerName ?? P?.attacker ?? 'None';",
    "const pickRandom = (arr) => arr[Math.floor(Math.random() * arr.length)];",
    "const picks = CFG.hits.map(() => pickRandom(legitTargets));",
    "const pickUuids = picks.map((t) => t.document.uuid);",
    "const uniqueUuids = Array.from(new Set(pickUuids));",
    "",
    "const doneHook = 'oni.anim.' + ANIM_KEY + '.' + (foundry?.utils?.randomID?.(8) ?? String(Date.now()));",
    "const readyHook = doneHook + '.ready';",
    "function onceHook(hookName, timeoutMs) {",
    "  return new Promise((resolve) => {",
    "    let settled = false;",
    "    const timer = setTimeout(() => { if (settled) return; settled = true; Hooks.off(hookName, h); resolve({ ok: false, timeout: true }); }, timeoutMs);",
    "    const h = (d) => { if (settled) return; settled = true; clearTimeout(timer); Hooks.off(hookName, h); resolve(d ?? { ok: true }); };",
    "    Hooks.on(hookName, h);",
    "  });",
    "}",
    "function emitLocal(n, d) { try { Hooks.callAll(n, d); } catch (_) {} }",
    "",
    "const scriptSource = String.raw`",
    inner("spears"),
    "`;",
    "",
    "try {",
    "  const waitReady = onceHook(readyHook, 8000);",
    "  const waitDone = onceHook(doneHook, CFG.totalTimeoutMs);",
    "  await game.ONI.pseudo.play({",
    "    scriptId: ANIM_KEY,",
    "    scriptSource,",
    "    casterTokenUuid: sourceToken?.document?.uuid ?? null,",
    "    targetTokenUuids: uniqueUuids,",
    "    params: { doneHook, readyHook, cfg: CFG, assets: ASSETS, strikes: Array.isArray(P?.strikes) ? P.strikes : [], picks: pickUuids },",
    "    meta: { source: " + j(name) + " },",
    "  });",
    "  await waitReady;",
    "  emitLocal('oni:animationStart', { type: ANIM_KEY, sceneId: canvas.scene?.id ?? null, sourceTokenId: sourceToken?.id ?? null });",
    "  // each hit's damage on its spear's impact frame (offsets from the shot's first frame)",
    "  const t0 = Date.now();",
    "  for (let i = 0; i < picks.length; i++) {",
    "    await sleep(t0 + CFG.hits[i] - Date.now());",
    "    try {",
    "      await runAdvanceDamageHeadless({",
    "        targetIds: [picks[i].id], valueType: 'hp', baseValue: '10', reduction: 0, bonus: 0, multiplier: 100,",
    "        elementType: 'elementless', weaponType: 'none_ef', targetAffinity: 'neutral',",
    "        attackerUuid, attackerName, sourceType: 'CustomLogic:FlintfangSpearHit' + (i + 1),",
    "      });",
    "    } catch (e) { console.error(TAG, 'AdvanceDamage failed on hit ' + (i + 1), e); }",
    "  }",
    "  const result = await waitDone;",
    "  if (!result?.ok) console.warn(TAG, 'pseudo non-OK / timeout', result);",
    "} catch (err) {",
    "  console.error(TAG, 'orchestration crashed', err);",
    "} finally {",
    "  emitLocal('oni:animationEnd', { type: ANIM_KEY, timestamp: Date.now(), sourceTokenId: sourceToken?.id ?? null });",
    "}",
    "",
    "})();",
  ].join("\n");
  return { script, timing: { mode: "default", offset: 0 }, preload: preloadOf(a) };
}

// skill name -> actor / item / generator (world fabula-ultima-2, actor "Masked Girl" LnlydRl7Ed7agd1g)
const ACTOR = "LnlydRl7Ed7agd1g";
const MOVES = [
  { item: "pyQNCZV7jGCDNQd8", name: "Zero Power: Rebellious Wing", key: "masked.rebelliousWing", gen: rebelliousWing },
  { item: "16TYZoJ5DR52yZgn", name: "Hurl Spear", key: "masked.hurlSpear", gen: hurlSpear },
  { item: "F5izbUbO8rbN1ATn", name: "Spear Rain", key: "masked.spearRain", gen: spearRain },
  { item: "2ORjvuQCwdFP2Oyc", name: "Piercing Talon", key: "masked.piercingTalon", gen: piercingTalon },
  { item: "isbOiFKEFDLJDNYl", name: "Wind Lance", key: "masked.windLance", gen: windLance },
  { item: "cA6tvxYGAvm4Q4ja", name: "Spear", key: "masked.spear", gen: spear },
  { item: "NPfissAPpeINh1g8", name: "Draconic Roar", key: "masked.draconicRoar", gen: draconicRoar },
  { item: "yfZbxLNZwsy6lcW0", name: "Jump", key: "masked.jump", gen: jump },
  { item: "Z55Pf8GXtq3Pp4JN", name: "Skyfall Dive", key: "masked.skyfallDive", gen: skyfallDive },
  { item: "AmcXC7n0jM0WujmT", name: "Dragonfire Dive", key: "masked.dragonfireDive", gen: dragonfireDive },
];

module.exports = { rebelliousWing, hurlSpear, spearRain, piercingTalon, windLance, spear, draconicRoar, jump, skyfallDive, dragonfireDive, GUEST, ACTOR, MOVES };
