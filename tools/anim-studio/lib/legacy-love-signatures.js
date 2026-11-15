"use strict";
// ============================================================================
// Love (legacy boss, The Legend of Dragonslayer): his eight moves, built on
// oni.timeline from the approved "Legacy boss" animation mockup (2026-11-15/16):
// part-b3.js Love defs + part-common.js kit; Love Serenade = the FINAL approved
// version (part-r9 disco rig, dim over the board AND every battler, dancers above
// the dim, + part-r10 coloured circles).
//
// Each shot = party _kit + _zpkit (boot, ZP.once / ZP.cutin maths) + legacy-shots/
// love-kit.inner.js + the move's inner, wrapped by dungeon-templates.shell().
// Storage rules (encode.js validate): no backticks / dollar-brace in any inner.
//
// Game logic kept from the shipped scripts (they ran it inside animation_script):
//   - Come! My Amigo!: the whole summon (random 2 normal + 1 elite bandit, hidden
//     token create at the old formation spots, combatants, reveal + arrival card);
//   - Gangster Paradise: the IP drain / random share among his allies (sheet writes);
//   - Love Serenade: the BGM swap (stop all, play "Love_Serenade" 104 s, back to "DRG_Boss").
// That code runs ONCE, in the OUTER script on the acting client (as before), never in
// the inner (which plays on every client). It is written below as plain functions and
// injected into the shell's outer by source text (Function#toString), so node checks it.
// ============================================================================

const fs = require("fs");
const path = require("path");
const { shell } = require("./dungeon-templates.js");

const FORGE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/";
const MV = FORGE + "Animation/RPG%20Maker%20MV/";
const PXF = FORGE + "Animation/pixelfx/";
const SB = FORGE + "Sound/Soundboard/";
const SND = FORGE + "Sound/";
const JB = "modules/JB2A_DnD5e/Library/";

const LOVE = "MhEHMx4BGuLoETa8";

const read = (p) => fs.readFileSync(p, "utf8");
const KIT = read(path.join(__dirname, "party-shots", "_kit.inner.js"));
const ZPKIT = read(path.join(__dirname, "zp-shots", "_zpkit.inner.js"));
const LKIT = read(path.join(__dirname, "legacy-shots", "love-kit.inner.js"));
const inner = (name) => KIT + "\n" + ZPKIT + "\n" + LKIT + "\n// ── shot ──\n" + read(path.join(__dirname, "legacy-shots", name + ".inner.js"));

const clip = (url, w, h, dur, ax, ay) => ({ url, w, h, dur, ax, ay });
const ASSETS = () => ({
  clips: {
    powerup: clip(MV + "051_powerup_1.webm", 508, 790, 867, 0.5, 0.543),
    powerdown: clip(MV + "054_powerdown_1.webm", 508, 656, 867, 0.5, 0.628),
    hit_thunder: clip(MV + "005_hit_thunder.webm", 580, 580, 667, 0.5, 0.5207),
    outpulse: clip(JB + "Generic/Template/Circle/OutPulse/OutPulse_01_Regular_BlueWhite_Burst_600x600.webm", 600, 600, 2367, 0.5, 0.5),
  },
  images: { cut: FORGE + "Campaign/The%20Legend%20of%20Dragonslayer/Image/NPCs/Love/Love_Standard.png" },
  // Serenade floor circles: our pixelfx fu/concert-spotlight pool, light layer only (240 x 480, anchor .5/.95, 2 s loop)
  pools: Object.fromEntries(["pink", "cyan", "amber", "green", "violet"].map((c) => [c, PXF + "pxfx_pool_" + c + "_light.webm"])),
  sfx: {
    overdrive: SND + "Overdrive.wav", item: SB + "Item3.ogg", powerup: SB + "Powerup.ogg", powerup2: SND + "PowerUp2.ogg",
    magic4: SB + "Magic4.ogg", heal: SB + "Heal3.ogg", monster1: SB + "Monster1.ogg", wind1: SB + "Wind1.ogg",
    thunder1: SB + "Thunder1.ogg", thunder3: SB + "Thunder3.ogg", move1: SB + "Move1.ogg", coin: SB + "Coin.ogg",
    steal: SND + "Steal.ogg", success2: SND + "success2.ogg",
  },
});

// ── outer-script logic (shipped behaviour, kept) ────────────────────────────

// Come! My Amigo!: the shipped summon, verbatim except (a) the chat card is built by
// concatenation (storage rule) with its <div> restored (the stored copy had lost the
// opening tag to the rich-text strip, so it posted raw CSS text), (b) each real token
// is revealed the frame its runner arrives (cfg.t.call + i * 180 + 650 after the
// inner's first frame) instead of after the old silhouette fade.
async function amigoLogic(CFG, shellSource, onceHook, readyHook, P) {
  const TAG = "[ONI][Anim][ComeMyAmigo]";
  const SC = CFG.summon;
  const payload = P ?? {};
  const NORMAL_POOL = SC.normalPool;
  const ELITE_POOL = SC.elitePool;
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
  function escapeHTML(value) { const s = String(value ?? ""); return foundry?.utils?.escapeHTML ? foundry.utils.escapeHTML(s) : s; }
  function clamp(value, min, max) { return Math.min(Math.max(value, min), max); }
  function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
  async function resolvePlaceableFromUuid(uuid) { if (!uuid) return null; const doc = await fromUuid(uuid); return doc?.object ?? doc?._object ?? null; }
  async function resolveSourceToken() {
    const candidates = [payload?.attackerTokenUuid, payload?.sourceTokenUuid, payload?.casterTokenUuid, payload?.tokenUuid, payload?.attackerUuid, payload?.sourceUuid, payload?.casterUuid, payload?.originUuid].filter(Boolean);
    for (const uuid of candidates) { const token = await resolvePlaceableFromUuid(uuid); if (token) return token; }
    return shellSource ?? canvas.tokens?.controlled?.[0] ?? null;
  }
  async function getActorByUuid(uuid) { const actor = await fromUuid(uuid); if (!actor) throw new Error("Actor not found for uuid: " + uuid); return actor; }
  async function buildHiddenSummonTokenData(actor, desiredCenter, sourceToken) {
    const gridSize = canvas.grid?.size ?? 100;
    const sceneRect = canvas.dimensions?.sceneRect ?? { x: 0, y: 0, width: canvas.scene?.width ?? 10000, height: canvas.scene?.height ?? 10000 };
    const tokenDoc = await actor.getTokenDocument({ hidden: true, disposition: sourceToken.document?.disposition ?? -1 });
    const data = tokenDoc.toObject();
    const tokenWidthPx = Number(data.width ?? 1) * gridSize;
    const tokenHeightPx = Number(data.height ?? 1) * gridSize;
    const x = clamp(Math.round(desiredCenter.x - (tokenWidthPx / 2)), sceneRect.x, Math.round(sceneRect.x + sceneRect.width - tokenWidthPx));
    const y = clamp(Math.round(desiredCenter.y - (tokenHeightPx / 2)), sceneRect.y, Math.round(sceneRect.y + sceneRect.height - tokenHeightPx));
    data.x = x;
    data.y = y;
    data.hidden = true;
    data.disposition = sourceToken.document?.disposition ?? data.disposition;
    // Force summoned enemies to face left toward the party
    data.texture = data.texture ?? {};
    data.texture.scaleX = -Math.abs(Number(data.texture.scaleX ?? 1));
    return data;
  }
  async function addSummonsToCombat(createdDocs) {
    const combat = game.combat;
    if (!combat) return;
    const combatSceneId = combat.scene?.id ?? combat.sceneId ?? null;
    if (combatSceneId !== canvas.scene?.id) return;
    const existingTokenIds = new Set(combat.combatants.map((c) => c.tokenId));
    const toCreate = createdDocs.filter((doc) => !existingTokenIds.has(doc.id)).map((doc) => ({ tokenId: doc.id, actorId: doc.actorId, sceneId: canvas.scene.id }));
    if (toCreate.length) await combat.createEmbeddedDocuments("Combatant", toCreate);
  }
  async function postArrivalMessage(name) {
    const safeName = escapeHTML(name);
    const content = "<div class=\"oni-summon-arrival\" style=\"text-align:center; padding:8px 12px; border:1px solid " + SC.chatAccentColor
      + "; border-radius:10px; background:rgba(22,16,10,0.92); color:" + SC.chatTextColor + "; font-weight:700; letter-spacing:0.4px;\">"
      + safeName + " Arrive!</div>";
    const data = { content, speaker: { scene: null, actor: null, token: null, alias: "" }, author: game.user.id };
    // In your setup, style is fine. The broken field was "type".
    if (CONST.CHAT_MESSAGE_STYLES?.OTHER != null) data.style = CONST.CHAT_MESSAGE_STYLES.OTHER;
    await ChatMessage.create(data);
  }
  function buildFormationCenters(sourceToken) {
    const home = { x: sourceToken.center.x, y: sourceToken.center.y };
    const baseX = home.x + Number((canvas.grid?.size ?? 100) * SC.formationXOffsetCells);   // right of summoner
    const gap = Number((canvas.grid?.size ?? 100) * SC.verticalGapCells);                    // spread vertically
    // Top normal, center elite, bottom normal
    return [{ x: baseX, y: home.y - gap }, { x: baseX, y: home.y }, { x: baseX, y: home.y + gap }];
  }

  CFG.spawn = [];
  let createdDocs = [];
  try {
    const sourceToken = await resolveSourceToken();
    if (!sourceToken) { ui.notifications.warn("No caster token found for Come! My Amigo!"); return { after: null }; }
    const selectedNormalA = pickRandom(NORMAL_POOL);
    const selectedNormalB = pickRandom(NORMAL_POOL);
    const selectedElite = pickRandom(ELITE_POOL);
    // Formation order: normal / elite / normal
    const selectedWave = [selectedNormalA, selectedElite, selectedNormalB];
    const formationCenters = buildFormationCenters(sourceToken);
    const prepared = [];
    for (let i = 0; i < selectedWave.length; i++) {
      const picked = selectedWave[i];
      const actor = await getActorByUuid(picked.uuid);
      const tokenData = await buildHiddenSummonTokenData(actor, formationCenters[i], sourceToken);
      prepared.push({ picked, actor, tokenData });
    }
    createdDocs = await canvas.scene.createEmbeddedDocuments("Token", prepared.map((p) => p.tokenData));
    await addSummonsToCombat(createdDocs);
    const gridSize = canvas.grid?.size ?? 100;
    CFG.spawn = createdDocs.map((doc, i) => {
      const data = doc.toObject();
      const boxW = Number(data.width ?? 1) * gridSize, boxH = Number(data.height ?? 1) * gridSize;
      return {
        id: doc.id, name: doc.name,
        src: data.texture?.src ?? doc.texture?.src ?? prepared[i]?.actor?.img,
        cx: Number(data.x ?? 0) + boxW / 2, cy: Number(data.y ?? 0) + boxH / 2,
        boxH, artH: boxH * Math.abs(Number(data.texture?.scaleY ?? 1)),
        flipX: Number(data.texture?.scaleX ?? 1) < 0,
      };
    });
  } catch (err) {
    console.error(TAG, "Summon failed:", err);
    ui.notifications.error("Come! My Amigo! summon failed. Check console.");
  }
  if (!createdDocs.length) return { after: null };
  // Reveal the real tokens in sync with the runners (the inner's first frame = readyHook)
  const ready = onceHook(readyHook, 8000);
  const after = (async () => {
    await ready;
    const t0 = Date.now();
    for (let i = 0; i < createdDocs.length; i++) {
      const at = Number(CFG.t.call) + i * 180 + 650;
      const left = at - (Date.now() - t0); if (left > 0) await wait(left);
      try { await createdDocs[i].update({ hidden: false }); await postArrivalMessage(createdDocs[i].name); }
      catch (err) { console.error(TAG, "Reveal failed:", err); }
    }
    await wait(SC.finalBufferMs);
  })();
  return { after };
}

// Gangster Paradise: the shipped IP drain + random share, verbatim (sheet writes happen
// BEFORE the visuals start, as before). Its PIXI clone march and floating +/- text are
// replaced by the mockup visuals; the plan is handed to the inner as CFG.gp. The old
// early return on "no enemies" now still plays the tune (no coins).
async function gangsterLogic(CFG, shellSource, P) {
  const TAG = "[ONI][Anim][GangsterParadise]";
  const payload = P ?? {};
  const STEAL_PER_ENEMY = CFG.stealPerEnemy; // change to 1 if you want to match the sheet text
  async function resolveToken(ref) {
    if (!ref) return null;
    if (ref?.object) return ref.object;
    if (ref?.documentName === "Token") return ref.object ?? ref;
    if (typeof ref !== "string") return null;
    try { const doc = await fromUuid(ref); return doc?.object ?? doc?._object ?? null; } catch { return null; }
  }
  function getCasterUuid() {
    return (payload.attackerUuid || payload.sourceTokenUuid || payload.casterTokenUuid || payload?.meta?.attackerUuid || payload?.meta?.sourceTokenUuid || payload?.meta?.casterTokenUuid || canvas.tokens.controlled[0]?.document?.uuid || null);
  }
  function getAllSceneTokens() { return (canvas.tokens?.placeables ?? []).filter(t => !t.document.hidden && t.actor); }
  function getDisp(token) { return Number(token?.document?.disposition ?? 0); }
  function num(value, fallback = 0) { const n = Number(value); return Number.isFinite(n) ? n : fallback; }
  function clamp(value, min, max) { return Math.min(Math.max(value, min), max); }
  function randomPick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
  CFG.gp = { loss: [], gain: [] };
  try {
    const sourceToken = (await resolveToken(getCasterUuid())) ?? shellSource;
    if (!sourceToken) { ui.notifications.warn("No caster token found."); return; }
    const allTokens = getAllSceneTokens();
    const casterDisp = getDisp(sourceToken);
    const allies = allTokens.filter(t => t.id !== sourceToken.id && getDisp(t) === casterDisp);
    const enemies = allTokens.filter(t => getDisp(t) !== casterDisp);
    if (enemies.length === 0) { ui.notifications.warn("No enemy tokens found on the scene."); return; }
    // 1) Compute IP loss from enemies
    const enemyLossPlan = [];
    let pooledIp = 0;
    for (const enemy of enemies) {
      const currentIp = num(enemy.actor?.system?.props?.current_ip, 0);
      const loss = clamp(STEAL_PER_ENEMY, 0, currentIp);
      const newIp = Math.max(0, currentIp - loss);
      enemyLossPlan.push({ tokenId: enemy.id, amount: loss });
      pooledIp += loss;
      if (loss > 0) await enemy.actor.update({ "system.props.current_ip": newIp });
    }
    // 2) Randomly distribute pooled IP to allies (excluding caster)
    const allyState = allies.map(t => ({ token: t, current: num(t.actor?.system?.props?.current_ip, 0), max: num(t.actor?.system?.props?.max_ip, 0), gain: 0 }));
    let remainingPool = pooledIp;
    while (remainingPool > 0) {
      const eligible = allyState.filter(a => a.current < a.max);
      if (eligible.length === 0) break;
      const picked = randomPick(eligible);
      picked.current += 1;
      picked.gain += 1;
      remainingPool -= 1;
    }
    for (const ally of allyState) { if (ally.gain > 0) await ally.token.actor.update({ "system.props.current_ip": ally.current }); }
    CFG.gp = { loss: enemyLossPlan.map(e => ({ id: e.tokenId, amount: e.amount })), gain: allyState.map(a => ({ id: a.token.id, amount: a.gain })), pooledIp, wastedIp: remainingPool };
    console.log(TAG, { caster: sourceToken.name, enemies: enemies.map(t => t.name), allies: allies.map(t => t.name), pooledIp, wastedIp: remainingPool });
  } catch (err) { console.error(TAG, "IP logic crashed:", err); }
}

// Love Serenade: the shipped BGM swap, verbatim, started when the cut-in ends
// (the shipped script started it right after its cut-in too): the rig beat, cfg.t.rig.
function serenadeMusic(CFG, onceHook, readyHook) {
  const TAG = "[ONI][Anim][LoveSerenade]";
  const waitMs = (ms) => new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
  async function stopAllPlayingTracks() {
    for (const playlist of game.playlists.contents) {
      const playingSounds = playlist.sounds.filter(s => s.playing);
      if (!playingSounds.length) continue;
      const updates = playingSounds.map(s => ({ _id: s.id, playing: false, pausedTime: null }));
      await playlist.updateEmbeddedDocuments("PlaylistSound", updates);
    }
  }
  async function playTrackByName(trackName) {
    const wanted = String(trackName ?? "").trim().toLowerCase();
    if (!wanted) return null;
    for (const playlist of game.playlists.contents) {
      const sound = playlist.sounds.find(s => String(s.name ?? "").trim().toLowerCase() === wanted);
      if (!sound) continue;
      await playlist.updateEmbeddedDocuments("PlaylistSound", [{ _id: sound.id, playing: true, pausedTime: null }]);
      return { playlist, sound };
    }
    console.warn(TAG, "Track not found: " + trackName);
    return null;
  }
  async function runLoveSerenadeMusicCue() {
    try {
      await stopAllPlayingTracks();
      const started = await playTrackByName(CFG.music.track);
      if (!started) return;
      await waitMs(CFG.music.durationMs);
      await stopAllPlayingTracks();
      await playTrackByName(CFG.music.restore);
    } catch (err) {
      console.error(TAG, "Music cue failed:", err);
    }
  }
  onceHook(readyHook, 8000).then(() => setTimeout(() => { void runLoveSerenadeMusicCue(); }, Number(CFG.t.rig) || 0));
}

// Insert outer code into the shell: `pre` right after the shell's helpers (sourceToken,
// P, onceHook, readyHook all defined, nothing played yet); `post` right after the inner's
// gate resolves (before the shell emits oni:animationEnd).
function withLogic(script, pre, post) {
  const A1 = "function emitLocal(n, d) { try { Hooks.callAll(n, d); } catch (_) {} }";
  const A2 = "  const result = await waitDone;";
  if (script.indexOf(A1) < 0 || script.indexOf(A2) < 0) throw new Error("legacy-love: shell anchors not found");
  let out = script.replace(A1, () => A1 + "\n// ── shipped game logic (legacy-love-signatures.js) ──\n" + pre);
  if (post) out = out.replace(A2, () => A2 + "\n" + post);
  return out;
}

// ── generators ──────────────────────────────────────────────────────────────

function build({ key, name, shot, cfg, timing, timeout }) {
  const assets = ASSETS();
  const full = Object.assign({ totalTimeoutMs: timeout || 20000 }, cfg);
  const script = shell({ key, name, cfg: full, assets, inner: inner(shot), timeout: full.totalTimeoutMs, startOnReady: true });
  return { script, assets, timing };
}
const preloadOf = (assets, keys, extra) => {
  const out = []; for (const k of keys) { const c = assets.clips[k]; if (c) out.push(c.url); }
  return Array.from(new Set(out.concat(extra || [])));
};
const sfxOf = (assets, keys) => keys.map((k) => assets.sfx[k]).filter(Boolean);

// Zero Power: Love Serenade. Gate = the last dancer's happy jump lands (count-dependent: default timing).
function serenade(opts = {}) {
  const tune = { bpm: 128, song: 4200, circles: 14, levelMs: 550, seed: 1414 };
  const c = Object.assign({}, tune, opts.cfg || {});
  const t = {}; t.rig = 2150; t.song = t.rig + 700; t.chord = t.song + c.song; t.flash = t.chord + 270; t.jump = t.flash + 500;
  const cfg = Object.assign(c, { move: "serenade", t, music: { track: "Love_Serenade", restore: "DRG_Boss", durationMs: 104000 } });
  const r = build({ key: opts.key || "legacy-love-serenade", name: opts.name || "Zero Power: Love Serenade", shot: "love-serenade", cfg, timeout: t.jump + 12 * 60 + 640 + 650 + 15000 });
  const script = withLogic(r.script, "(" + serenadeMusic.toString() + ")(CFG, onceHook, readyHook);", null);
  const preload = preloadOf(r.assets, [], [r.assets.images.cut, ...Object.values(r.assets.pools), ...sfxOf(r.assets, ["overdrive", "item", "powerup", "powerup2"])]);
  return { script, timing: { mode: "default", offset: 0 }, preload };
}
// Heartache: gate at the status beat after the wobble.
function heartache(opts = {}) {
  const t = { land: 720, gate: 1160 };
  const r = build({ key: opts.key || "legacy-love-heartache", name: opts.name || "Heartache", shot: "love-moves", cfg: Object.assign({ move: "heartache", t }, opts.cfg || {}) });
  return { script: r.script, timing: { mode: "offset", offset: t.gate }, preload: preloadOf(r.assets, ["powerup"], sfxOf(r.assets, ["magic4", "heal"])) };
}
// Shout my Soul: one oni.hit per target as the rings pass, gate at the status beat (target-count dependent: default).
function shout(opts = {}) {
  const t = { scream: 260 };
  const r = build({ key: opts.key || "legacy-love-shout", name: opts.name || "Shout my Soul", shot: "love-moves", cfg: Object.assign({ move: "shout", t }, opts.cfg || {}) });
  return { script: r.script, timing: { mode: "default", offset: 0 }, preload: preloadOf(r.assets, ["powerdown"], sfxOf(r.assets, ["monster1", "wind1"])) };
}
// One more for you: gate when the note reaches the ally.
function oneMore(opts = {}) {
  const t = { gate: 680 + 320 };
  const r = build({ key: opts.key || "legacy-love-one-more", name: opts.name || "One more for you", shot: "love-moves", cfg: Object.assign({ move: "onemore", t }, opts.cfg || {}) });
  return { script: r.script, timing: { mode: "offset", offset: t.gate }, preload: preloadOf(r.assets, [], sfxOf(r.assets, ["item", "magic4"])) };
}
// Jamming Way: the floor shockwave reaches the target, bolt burst + oni.hit + gate.
function jamming(opts = {}) {
  const t = { gate: 120 + 420 };
  const r = build({ key: opts.key || "legacy-love-jamming", name: opts.name || "Jamming Way", shot: "love-moves", cfg: Object.assign({ move: "jamming", t }, opts.cfg || {}) });
  return { script: r.script, timing: { mode: "offset", offset: t.gate }, preload: preloadOf(r.assets, ["hit_thunder"], sfxOf(r.assets, ["thunder1", "thunder3"])) };
}
// Rock your World: gate on the buff beat (the buff itself = the item's custom logic, untouched).
function rockWorld(opts = {}) {
  const t = { gate: 600, back: 1300 };
  const r = build({ key: opts.key || "legacy-love-rock-your-world", name: opts.name || "Rock your World", shot: "love-moves", cfg: Object.assign({ move: "rockworld", t }, opts.cfg || {}) });
  return { script: r.script, timing: { mode: "offset", offset: t.gate }, preload: preloadOf(r.assets, ["outpulse", "powerup"], sfxOf(r.assets, ["success2", "powerup"])) };
}
// Come! My Amigo!: shipped summon logic in the outer; gate when the last runner has hopped (default timing).
function amigo(opts = {}) {
  const t = { call: 410 };
  const summon = {
    normalPool: [{ name: "Bandit", uuid: "Actor.o1jFZwDZxSAFSSWA" }, { name: "Bandit Archer", uuid: "Actor.XFBIZY3EKMHgBQCx" }, { name: "Bandit Mage", uuid: "Actor.ndwgiiXLxsr6lqE0" }],
    elitePool: [{ name: "Elite Bandit", uuid: "Actor.qkogIO0dEtQ466Wo" }, { name: "Bandit Berserker", uuid: "Actor.Ax1nVCBhZOG0ZzHx" }],
    formationXOffsetCells: 1.8, verticalGapCells: 1.2, finalBufferMs: 120, chatTextColor: "#e8dcc0", chatAccentColor: "#9f7a3d",
  };
  const r = build({ key: opts.key || "legacy-love-come-my-amigo", name: opts.name || "Come! My Amigo!", shot: "love-amigo", cfg: Object.assign({ move: "amigo", t, summon, spawn: [] }, opts.cfg || {}) });
  const script = withLogic(r.script,
    "const __LOVE_SUMMON = await (" + amigoLogic.toString() + ")(CFG, sourceToken, onceHook, readyHook, P);",
    "  try { if (__LOVE_SUMMON && __LOVE_SUMMON.after) await __LOVE_SUMMON.after; } catch (_) {}");
  return { script, timing: { mode: "default", offset: 0 }, preload: preloadOf(r.assets, [], sfxOf(r.assets, ["monster1", "move1"])) };
}
// Gangster Paradise: shipped IP logic in the outer (before the visuals); gate when the coins reach his allies.
function gangster(opts = {}) {
  const t = { drain: 400, share: 1000, gate: 1520 };
  const r = build({ key: opts.key || "legacy-love-gangster-paradise", name: opts.name || "Gangster Paradise", shot: "love-gangster", cfg: Object.assign({ move: "gangster", t, stealPerEnemy: 2, gp: null }, opts.cfg || {}) });
  const script = withLogic(r.script, "await (" + gangsterLogic.toString() + ")(CFG, sourceToken, P);", null);
  return { script, timing: { mode: "offset", offset: t.gate }, preload: preloadOf(r.assets, [], sfxOf(r.assets, ["steal", "coin"])) };
}

// Love's own items (world fabula-ultima-2, actor ⭐️ Love). Exact item names.
const TARGETS = [
  { name: "Zero Power: Love Serenade", actor: LOVE, item: "Yy7YHRo1qOFhziYH", gen: serenade },
  { name: "Heartache", actor: LOVE, item: "Aeiy7bDInVFYUCTD", gen: heartache },
  { name: "Shout my Soul", actor: LOVE, item: "EvGcS4Bw6TgoV0Fw", gen: shout },
  { name: "One more for you", actor: LOVE, item: "hIOqaqQa6qtP1cho", gen: oneMore },
  { name: "Jamming Way", actor: LOVE, item: "IdjchURJzyFGcJZG", gen: jamming },
  { name: "Come! My Amigo!", actor: LOVE, item: "BX3rNnCMKI2ucFgQ", gen: amigo },
  { name: "Gangster Paradise", actor: LOVE, item: "GLAIUBccTQPexrkr", gen: gangster },
  { name: "Rock your World", actor: LOVE, item: "kjhowuStWvMQ1f7f", gen: rockWorld },
];

// Build registry hook (legacy-boss-registry.js): g(fn, key, name, extra) => () => fn({ key: "legacy-" + key, name, ...extra }).
const SLUG = {
  "Zero Power: Love Serenade": "love-serenade", "Heartache": "love-heartache", "Shout my Soul": "love-shout-my-soul",
  "One more for you": "love-one-more-for-you", "Jamming Way": "love-jamming-way", "Come! My Amigo!": "love-come-my-amigo",
  "Gangster Paradise": "love-gangster-paradise", "Rock your World": "love-rock-your-world",
};
function REGISTRY_ITEMS(g) {
  const out = {};
  for (const T of TARGETS) out[T.name] = g(T.gen, SLUG[T.name], T.name);
  return out;
}

module.exports = { serenade, heartache, shout, oneMore, jamming, amigo, gangster, rockWorld, TARGETS, LOVE, REGISTRY_ITEMS };
