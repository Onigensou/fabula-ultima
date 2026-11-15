"use strict";
// ============================================================================
// Rauben (legacy boss pass): Battle Director animation_script generators, built on
// oni.timeline from the approved legacy-boss mockup (part-b3.js Rauben defs, plus the
// Night of Hundred Bandits re-tunes in part-r3 / r4 / r5 / r7). LIVE board for every
// move. The inner scripts live in legacy-shots/ as plain text (rauben-kit is prepended
// to each); every number the review tuned is in the cfg below (mockup px on a 1682 px
// stage; the inners scale them by stage width / 1682), so a tuning pass edits numbers here.
// Exception: Night of Hundred Bandits is a FULL-TAKEOVER timeline (camera driven: the approved 2.1x slam zoom).
//
// Mug (Thievery 4) and Cleaving Strike are the shared Jill/Rauben scripts in
// legacy-twins-signatures.js: mug({ key, name, coins: 4 }) and cleave({ key, name }).
// Storage rule: no backticks and no dollar-brace in any inner.
// ============================================================================

const fs = require("fs");
const path = require("path");
const { shell } = require("./dungeon-templates.js");

const FORGE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/";
const MV = FORGE + "Animation/RPG%20Maker%20MV/";
const D4 = FORGE + "Animation/Disgaea%204/webm/";
const SB = FORGE + "Sound/Soundboard/";
const SND = FORGE + "Sound/";
const BEAST = FORGE + "Beastiary/";
const CUTIN = FORGE + "Campaign/The%20Legend%20of%20Dragonslayer/Image/Cut-in/Rauben_Cut-In.png";

const clip = (url, w, h, dur, ax, ay) => ({ url, w, h, dur, ax, ay });
// the mockup's sounds (build-assets.js S table)
const SFX = {
  overdrive: SND + "Overdrive.wav", crowd: SND + "BGS/Crowd01.ogg", steal: SND + "Steal.ogg",
  damage3: SB + "Damage3.ogg", damage4: SB + "Damage4.ogg", downc: SB + "SE_DOWNC.wav", jump2: SB + "SE_BTL_HighJump.ogg",
  explosion2: SB + "Explosion2.ogg", blowL: SB + "SE_BTL_HitBlowL.ogg", swingF: SB + "SE_SWINGF.wav", swingA: SB + "SE_SWINGA.wav",
  swingC: SB + "SE_SWINGC.wav", coin: SB + "Coin.ogg", item: SB + "Item3.ogg", monster1: SB + "Monster1.ogg", move1: SB + "Move1.ogg",
};
const pickSfx = (keys) => Object.fromEntries(keys.map((k) => [k, SFX[k]]));
// the four bandit arts (in-game battle art) and their prototype-token texture scales (mockup ACT table)
const BANDITS = { bandit: BEAST + "Bandit_Standard.png", archer: BEAST + "BanditArcher_Standard.png", mage: BEAST + "BanditMage_Standard.png", berserker: BEAST + "BanditBerserker_Standard.png" };
const BSC = { bandit: 1.34, archer: 1.35, mage: 1.31, berserker: 1.89 };

const SHOTS = path.join(__dirname, "legacy-shots");
const KIT = fs.readFileSync(path.join(SHOTS, "rauben-kit.inner.js"), "utf8");
const ZPKIT = fs.readFileSync(path.join(__dirname, "zp-shots", "_zpkit.inner.js"), "utf8");
function inner(name, withZp) { return KIT + "\n" + (withZp ? ZPKIT + "\n" : "") + "// ── shot ──\n" + fs.readFileSync(path.join(SHOTS, name + ".inner.js"), "utf8"); }

const BASE = { casterFoot: null, partyFoot: 0.97, volume: 1 };
const DEFAULT_TIMING = { mode: "default", offset: 0 };   // the inner fires the gate (oni.fireDone) where the mockup marks it
function preloadOf(assets) {
  const out = [];
  for (const c of Object.values(assets.clips || {})) out.push(c.url);
  for (const u of Object.values(assets.images || {})) out.push(u);
  for (const u of Object.values(assets.sfx || {})) out.push(u);
  if (assets.smoke) out.push(assets.smoke.url);
  return Array.from(new Set(out.filter((u) => typeof u === "string" && u.startsWith("http"))));
}
function build({ key, name, shot, withZp, cfg, assets }) {
  const script = shell({ key, name, cfg, assets, inner: inner(shot, withZp), timeout: cfg.totalTimeoutMs, startOnReady: true });
  return { script, timing: DEFAULT_TIMING, preload: preloadOf(assets) };
}

// ── Zero Power: Night of Hundred Bandits ──
function nightOfHundredBandits(opts = {}) {
  // NOHB as shipped, with the review's re-tunes (r3: stampede 9 s / spawn 42 ms / runs 480-820 / bed 110+160,
  // no fist hit VFX, the final bandit stops in front of the party and body-slams it, white hold 900 ms;
  // r4: runners over the whole floor, depth-scaled, camera pushes 2.1x into the impact over 520 ms, whiteout before
  // the slam lands; r5: hurt hold; r7: the camera is back at rest while the screen is still white). Full takeover,
  // not the live board: the shot drives the camera (cfg.flat = 2D positions, the 3D stage flattens for it).
  const tune = {
    stampedeMs: 9000, spawnEvery: 42, density: 1, runMin: 480, runMax: 820, rowMin: 150 / 788, rowMax: 798 / 788,
    bedEvery: 110, bedJitter: 160, rumble: 3, dim: 0.55,
    flipMs: 150, tantrumMs: 420, ampX: 14, ampY: 4, cycles: 5.5, waitFlipBack: 500,
    finalScale: 2.0, finalYOff: 68, stopGap: 210, steps: 4, stepMs: 260, stepPause: 300, stepBob: 10,
    jumpMs: 420, jumpH: 254, fallRot: 82, whiteHold: 900, whiteOut: 520, crowdFadeMs: 350,
    zoom: 2.1, zoomMs: 520, zoomLift: 90, flat: true,
  };
  const t = {};
  t.turn = 650 + 850 + 650;                                   // after the shipped cut-in
  t.stampede = t.turn + tune.flipMs + tune.tantrumMs;
  t.final = t.stampede + tune.stampedeMs - 1800;              // the stampede beat hands over 1.8 s before it ends
  t.crowdFade = t.final + tune.steps * tune.stepMs + (tune.steps - 1) * tune.stepPause;
  t.slam = t.crowdFade + 600;
  t.gate = t.slam + tune.jumpMs + 60 + tune.whiteHold;
  t.total = t.gate + tune.whiteOut + 900;
  const cfg = Object.assign({ ...BASE, t, ...tune, bsc: BSC, seed: 1001, totalTimeoutMs: t.total + 15000 }, opts.cfg || {});
  const assets = {
    images: { cut: CUTIN, ...BANDITS },
    smoke: { url: D4 + "smoke_cloud_white.webm", w: 228, h: 162, dur: 800 },
    sfx: pickSfx(["overdrive", "crowd", "damage3", "damage4", "downc", "jump2", "explosion2", "blowL"]),
  };
  return build({ key: opts.key || "legacy.rauben.hundred", name: opts.name || "Zero Power: Night of Hundred Bandits", shot: "rauben-hundred", withZp: true, cfg, assets });
}

// ── the on-board moves (one inner, cfg.move) ──
function move(moveKey, opts, tune, assets, defName) {
  const cfg = Object.assign({ ...BASE, move: moveKey, ...tune, seed: 3301, totalTimeoutMs: 25000 }, opts.cfg || {});
  return build({ key: opts.key || "legacy.rauben." + moveKey, name: opts.name || defName, shot: "rauben-moves", withZp: false, cfg, assets });
}
// Great Axe (also Great Axe - Counterattack): dash, overhead swing, hit, two coins to him (Thievery 2), back
function greatAxe(opts = {}) {
  return move("greataxe", opts, { gap: 100, dash: 400, wind: 240, swing: 90, hitstop: 80, coinMs: 520, settle: 160, home: 440, hop: 20 },
    { clips: { slash3: clip(MV + "025_slash_special_3.webm", 1186, 1206, 2267, 0.5, 0.5473) }, sfx: pickSfx(["swingF", "blowL", "steal", "coin"]) }, "Great Axe");
}
// Axe Throw: a spinning axe flies out, hits, and arcs back into his hand
function axeThrow(opts = {}) {
  return move("axethrow", opts, { wind: 220, out: 380, back: 420 },
    { clips: { slash: clip(MV + "006_slash_physical.webm", 378, 378, 333, 0.4683, 0.5794) }, sfx: pickSfx(["swingC", "swingA", "blowL"]) }, "Axe Throw");
}
// Bandit Raid: he whistles; three bandits dash through the target from off-screen, one hit at the end
function banditRaid(opts = {}) {
  return move("raid", opts, { stagger: 150, runMs: 900, bandits: Object.keys(BANDITS), bsc: BSC },
    { clips: { hit: clip(MV + "001_hit_physical.webm", 488, 488, 333, 0.5, 0.5) }, images: { ...BANDITS }, sfx: pickSfx(["item", "blowL"]) }, "Bandit Raid");
}
// All you can take: dim, he steps up, coins shower onto every creature, the game's own IP gain number (+6, or what
// actually fits under the creature's max IP) pops on each
function allYouCanTake(opts = {}) {
  return move("allyoucan", opts, { step: 320, home: 360, gain: 6 }, { clips: {}, sfx: pickSfx(["coin"]) }, "All you can take");
}

// ── Oi! Come help me now!: the shipped summon logic in the OUTER script + the run-in shot ──
// The summon logic is the shipped script's, unchanged: pools, cap 2 (one normal + one elite), formation 1.8 grid in
// front of him and 1.2 grid apart, hidden token create with his disposition facing left, combat add, a plain
// "<name> Arrive!" chat line per summon. Only the visual changed (the black-to-colour fade became the mockup's
// run-in): each token is revealed when the shot lands it (cfg.t.reveal), not on the old 420/160 ms fade clock.
function oiComeHelpMeNow(opts = {}) {
  const tune = { stagger: 260, runMs: 650, runHop: 10, hop: 22, tail: 600, maxSummons: 2 };
  const t = { shoutEnd: 320, run0: 320 };
  t.reveal = Array.from({ length: tune.maxSummons }, (_, i) => t.run0 + i * tune.stagger + tune.runMs + 170 + 150);
  const cfg = Object.assign({ ...BASE, t, ...tune, seed: 4404, totalTimeoutMs: 20000 }, opts.cfg || {});
  const assets = { clips: {}, images: {}, sfx: pickSfx(["monster1", "move1"]) };
  const key = opts.key || "legacy.rauben.oi", name = opts.name || "Oi! Come help me now!";
  const script = oiShell({ key, name, cfg, assets, inner: inner("rauben-oi", false) });
  return { script, timing: DEFAULT_TIMING, preload: preloadOf(assets) };
}
function oiShell({ key, name, cfg, assets, inner: innerSrc }) {
  const j = (v) => JSON.stringify(v);
  return [
    "// " + name + " — generated by tools/anim-studio/lib/legacy-rauben-signatures.js",
    "// The summon logic below is the shipped script's (Rauben: Oi! Come help me now!), kept as is.",
    "(async () => {",
    "",
    "const CFG = " + j(cfg) + ";",
    "const ASSETS = " + j(assets) + ";",
    "const ANIM_KEY = " + j("oni.dungeon." + key) + ";",
    "const TAG = " + j("[ONI][Anim][" + name + "]") + ";",
    "const P = globalThis.__PAYLOAD ?? payload ?? {};",
    "const GRID = canvas.grid?.size ?? 100;",
    "const SUMMON = { formationXOffsetPx: GRID * 1.8, verticalGapPx: GRID * 1.2, finalBufferMs: 120 };",
    "const NORMAL_POOL = [",
    "  { name: 'Bandit', uuid: 'Actor.o1jFZwDZxSAFSSWA' }, { name: 'Bandit Archer', uuid: 'Actor.XFBIZY3EKMHgBQCx' }, { name: 'Bandit Mage', uuid: 'Actor.ndwgiiXLxsr6lqE0' },",
    "  { name: 'Bandit Golem', uuid: 'Actor.bvc69GcUFSRhy6W4' }, { name: 'Bandit Roo', uuid: 'Actor.kIvWhnszRhsHafWu' }, { name: 'Bandit Scorpion', uuid: 'Actor.vFM6BS58y9mPb7oU' },",
    "  { name: 'Bandit Shroom', uuid: 'Actor.LdevXmJ3bnv0M10v' }, { name: 'Bandit Wolf', uuid: 'Actor.Hu6dRUuxvBLrrdmV' }, { name: 'Bandit Zombie', uuid: 'Actor.st3oQSM4TadXLqoZ' },",
    "  { name: 'Goblin Bandit', uuid: 'Actor.hwfRiQQSsYK4CdhJ' }",
    "];",
    "const ELITE_POOL = [{ name: 'Elite Bandit', uuid: 'Actor.qkogIO0dEtQ466Wo' }, { name: 'Bandit Berserker', uuid: 'Actor.Ax1nVCBhZOG0ZzHx' }];",
    "const MAX_SUMMONS_FOR_THIS_SKILL = " + j(cfg.maxSummons) + ";",
    "const actorIdFromUuid = (uuid) => String(uuid ?? '').split('.').pop() ?? '';",
    "const NORMAL_IDS = new Set(NORMAL_POOL.map((p) => actorIdFromUuid(p.uuid)));",
    "const ELITE_IDS = new Set(ELITE_POOL.map((p) => actorIdFromUuid(p.uuid)));",
    "const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));",
    "const escapeHTML = (v) => { const s = String(v ?? ''); return foundry?.utils?.escapeHTML ? foundry.utils.escapeHTML(s) : s; };",
    "const clamp = (v, a, b) => Math.min(Math.max(v, a), b);",
    "const pickRandom = (arr) => arr[Math.floor(Math.random() * arr.length)];",
    "const getBaseActorIdFromToken = (token) => String(token?.document?.actorId ?? token?.actorId ?? token?.actor?.id ?? token?.actor?._id ?? '').trim();",
    "function getSummonRoleFromBaseActorId(actorId) { const id = String(actorId ?? '').trim(); if (!id) return null; if (NORMAL_IDS.has(id)) return 'normal'; if (ELITE_IDS.has(id)) return 'elite'; return null; }",
    "const getPickedRole = (picked) => getSummonRoleFromBaseActorId(actorIdFromUuid(picked?.uuid));",
    "function getExistingBanditSummonState(sourceToken) {",
    "  const casterDisposition = Number(sourceToken?.document?.disposition ?? 0);",
    "  const state = { normal: 0, elite: 0, total: 0, tokens: [] };",
    "  for (const token of (canvas.tokens?.placeables ?? [])) {",
    "    if (!token || token.id === sourceToken?.id) continue;",
    "    if (Number(token.document?.disposition ?? 0) !== casterDisposition) continue;",
    "    const role = getSummonRoleFromBaseActorId(getBaseActorIdFromToken(token)); if (!role) continue;",
    "    state[role] += 1; state.total += 1; state.tokens.push(token);",
    "  }",
    "  return state;",
    "}",
    "function buildWaveFromExistingState(existingState) {",
    "  const remainingSlots = Math.max(0, MAX_SUMMONS_FOR_THIS_SKILL - Number(existingState?.total ?? 0));",
    "  if (remainingSlots <= 0) return [];",
    "  const wave = [];",
    "  // Final intended composition = 1 normal + 1 elite",
    "  if ((existingState?.normal ?? 0) < 1) wave.push(pickRandom(NORMAL_POOL));",
    "  if ((existingState?.elite ?? 0) < 1) wave.push(pickRandom(ELITE_POOL));",
    "  return wave.slice(0, remainingSlots);",
    "}",
    "async function resolvePlaceableFromUuid(uuid) { if (!uuid) return null; const doc = await fromUuid(uuid); return doc?.object ?? doc?._object ?? null; }",
    "async function resolveSourceToken() {",
    "  const candidates = [P?.attackerTokenUuid, P?.sourceTokenUuid, P?.casterTokenUuid, P?.tokenUuid, P?.attackerUuid, P?.sourceUuid, P?.casterUuid, P?.originUuid].filter(Boolean);",
    "  for (const uuid of candidates) { const token = await resolvePlaceableFromUuid(uuid); if (token) return token; }",
    "  return canvas.tokens?.controlled?.[0] ?? null;",
    "}",
    "async function getActorByUuid(uuid) { const actor = await fromUuid(uuid); if (!actor) throw new Error('Actor not found for uuid: ' + uuid); return actor; }",
    "async function buildHiddenSummonTokenData(actor, desiredCenter, sourceToken) {",
    "  const sceneRect = canvas.dimensions?.sceneRect ?? { x: 0, y: 0, width: canvas.scene?.width ?? 10000, height: canvas.scene?.height ?? 10000 };",
    "  const tokenDoc = await actor.getTokenDocument({ hidden: true, disposition: sourceToken.document?.disposition ?? -1 });",
    "  const data = tokenDoc.toObject();",
    "  const tokenWidthPx = Number(data.width ?? 1) * GRID, tokenHeightPx = Number(data.height ?? 1) * GRID;",
    "  data.x = clamp(Math.round(desiredCenter.x - (tokenWidthPx / 2)), sceneRect.x, Math.round(sceneRect.x + sceneRect.width - tokenWidthPx));",
    "  data.y = clamp(Math.round(desiredCenter.y - (tokenHeightPx / 2)), sceneRect.y, Math.round(sceneRect.y + sceneRect.height - tokenHeightPx));",
    "  data.hidden = true;",
    "  data.disposition = sourceToken.document?.disposition ?? data.disposition;",
    "  // Force summoned enemies to face left toward the party",
    "  data.texture = data.texture ?? {};",
    "  data.texture.scaleX = -Math.abs(Number(data.texture.scaleX ?? 1));",
    "  return data;",
    "}",
    "async function addSummonsToCombat(createdDocs) {",
    "  const combat = game.combat; if (!combat) return;",
    "  const combatSceneId = combat.scene?.id ?? combat.sceneId ?? null; if (combatSceneId !== canvas.scene?.id) return;",
    "  const existingTokenIds = new Set(combat.combatants.map((c) => c.tokenId));",
    "  const toCreate = createdDocs.filter((doc) => !existingTokenIds.has(doc.id)).map((doc) => ({ tokenId: doc.id, actorId: doc.actorId, sceneId: canvas.scene.id }));",
    "  if (toCreate.length) await combat.createEmbeddedDocuments('Combatant', toCreate);",
    "}",
    "async function postArrivalMessage(name) {",
    "  const data = { content: escapeHTML(name) + ' Arrive!', speaker: { scene: null, actor: null, token: null, alias: '' }, author: game.user.id };",
    "  if (CONST.CHAT_MESSAGE_STYLES?.OTHER != null) data.style = CONST.CHAT_MESSAGE_STYLES.OTHER;",
    "  await ChatMessage.create(data);",
    "}",
    "function buildFormationCenters(sourceToken, selectedWave) {",
    "  const home = { x: sourceToken.center.x, y: sourceToken.center.y };",
    "  const baseX = home.x + Number(SUMMON.formationXOffsetPx), halfGap = Number(SUMMON.verticalGapPx) / 2;",
    "  return selectedWave.map((picked) => { const role = getPickedRole(picked); let y = home.y; if (role === 'normal') y = home.y - halfGap; else if (role === 'elite') y = home.y + halfGap; return { x: baseX, y }; });",
    "}",
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
    innerSrc,
    "`;",
    "",
    "let sourceToken = null;",
    "let createdDocs = [];",
    "try {",
    "  sourceToken = await resolveSourceToken();",
    "  if (!sourceToken) { ui.notifications.warn('No caster token found for Oi! Come help me now!'); return; }",
    "  const selectedWave = buildWaveFromExistingState(getExistingBanditSummonState(sourceToken));",
    "  if (!selectedWave.length) { ui.notifications.info('Oi! Come help me now!: summon cap already reached.'); return; }",
    "  const formationCenters = buildFormationCenters(sourceToken, selectedWave);",
    "  const prepared = [];",
    "  for (let i = 0; i < selectedWave.length; i++) {",
    "    const picked = selectedWave[i];",
    "    const actor = await getActorByUuid(picked.uuid);",
    "    prepared.push({ picked, actor, tokenData: await buildHiddenSummonTokenData(actor, formationCenters[i], sourceToken) });",
    "  }",
    "  createdDocs = await canvas.scene.createEmbeddedDocuments('Token', prepared.map((p) => p.tokenData));",
    "  await addSummonsToCombat(createdDocs);",
    "  const summons = createdDocs.map((doc, i) => ({ uuid: doc.uuid, name: doc.name, art: doc.texture?.src ?? prepared[i]?.actor?.img ?? null }));",
    "  const reveal = async () => {",
    "    // each summon is revealed when the shot lands it (CFG.t.reveal, ms from the shot's first frame)",
    "    const t0 = performance.now();",
    "    for (let i = 0; i < createdDocs.length; i++) {",
    "      const at = (CFG.t.reveal[i] ?? CFG.t.reveal[CFG.t.reveal.length - 1] + 400 * (i - CFG.t.reveal.length + 1));",
    "      await sleep(at - (performance.now() - t0));",
    "      await createdDocs[i].update({ hidden: false });",
    "      await postArrivalMessage(createdDocs[i].name);",
    "    }",
    "  };",
    "  if (game.ONI?.pseudo?.play) {",
    "    const waitReady = onceHook(readyHook, 8000);",
    "    const waitDone = onceHook(doneHook, CFG.totalTimeoutMs || 20000);",
    "    await game.ONI.pseudo.play({",
    "      scriptId: ANIM_KEY,",
    "      scriptSource,",
    "      casterTokenUuid: sourceToken.document.uuid,",
    "      targetTokenUuids: [],",
    "      params: { doneHook, readyHook, cfg: CFG, assets: ASSETS, summons, strikes: [] },",
    "      meta: { source: " + j(name) + " },",
    "    });",
    "    await waitReady;",
    "    emitLocal('oni:animationStart', { type: ANIM_KEY, sceneId: canvas.scene?.id ?? null, sourceTokenId: sourceToken.id });",
    "    await reveal();",
    "    const result = await waitDone;",
    "    if (!result?.ok) console.warn(TAG, 'pseudo non-OK / timeout', result);",
    "  } else {",
    "    console.warn(TAG, 'game.ONI.pseudo.play is unavailable. Summons will reveal without the run-in.');",
    "    emitLocal('oni:animationStart', { type: ANIM_KEY, sceneId: canvas.scene?.id ?? null, sourceTokenId: sourceToken.id });",
    "    await reveal();",
    "  }",
    "  await sleep(SUMMON.finalBufferMs);",
    "} catch (err) {",
    "  console.error(TAG, 'Animation crashed:', err);",
    "  ui.notifications.error('Oi! Come help me now! summon animation failed. Check console.');",
    "} finally {",
    "  emitLocal('oni:animationEnd', { type: ANIM_KEY, timestamp: Date.now(), sourceTokenId: sourceToken?.id ?? null, targetTokenIds: createdDocs.map((d) => d.id) });",
    "}",
    "",
    "})();",
  ].join("\n");
}

// skill name (exact item name) -> generator, for the world write. Item ids: world fabula-ultima-2, Rauben XsSf4Z1eAcOanCfv.
const RAUBEN_ACTOR = "XsSf4Z1eAcOanCfv";
const MOVES = [
  { item: "IxJRQVu2yhXU2mt5", name: "Zero Power: Night of Hundred Bandits", gen: () => nightOfHundredBandits({ key: "legacy.rauben.hundred", name: "Zero Power: Night of Hundred Bandits" }) },
  { item: "8P9UkR63o0Cj7PHq", name: "Great Axe", gen: () => greatAxe({ key: "legacy.rauben.greataxe", name: "Great Axe" }) },
  { item: "xJdqXw3LHQ0mGpKc", name: "Great Axe - Counterattack", gen: () => greatAxe({ key: "legacy.rauben.greataxe-counter", name: "Great Axe - Counterattack" }) },
  { item: "cTAzHqsLkgJXcx6J", name: "Oi! Come help me now!", gen: () => oiComeHelpMeNow({ key: "legacy.rauben.oi", name: "Oi! Come help me now!" }) },
  { item: "fKgQH2dQKnkuJvGG", name: "All you can take", gen: () => allYouCanTake({ key: "legacy.rauben.allyoucan", name: "All you can take" }) },
  { item: "viyo0vZrYqa9zagc", name: "Axe Throw", gen: () => axeThrow({ key: "legacy.rauben.axethrow", name: "Axe Throw" }) },
  { item: "89Jm94RRs9iUmBLJ", name: "Bandit Raid", gen: () => banditRaid({ key: "legacy.rauben.raid", name: "Bandit Raid" }) },
  // shared with Jill (legacy-twins-signatures.js): mug({ key, name, coins: 4 }) / cleave({ key, name })
  { item: "wi49pXLEDIaUjMrq", name: "Mug", shared: "mug({ key: 'legacy.rauben.mug', name: 'Mug', coins: 4 })" },
  { item: "OjMjKZoO4rb69GCc", name: "Cleaving Strike", shared: "cleave({ key: 'legacy.rauben.cleave', name: 'Cleaving Strike' })" },
];

module.exports = { nightOfHundredBandits, greatAxe, axeThrow, banditRaid, allYouCanTake, oiComeHelpMeNow, MOVES, RAUBEN_ACTOR };
