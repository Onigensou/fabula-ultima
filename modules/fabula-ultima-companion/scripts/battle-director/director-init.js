// Director-owned BattleInit pipeline.
//
// Replaces the legacy BattleInit Manager pipeline (gate, resolver, transition,
// layout, spawner, preload, entrance, initiator, unleash, record). The legacy
// Battle Prompt UI still creates the payload — everything past that confirm
// click is director-native code that uses only Foundry native APIs and the
// documented public `FUCompanion.api.animationCache` for the curtain.
//
// Pipeline order:
//   1. Suppress legacy listeners (early — before any combat hooks fire)
//   2. Raise curtain (black screen)
//   3. Resolve encounter from payload (manual / fixed / random)
//   4. Resolve party members from payload.party.members
//   5. Activate battle scene
//   6. Compute layout (party right / enemies left, matches legacy positions)
//   7. Spawn tokens hidden (alpha=0) at layout positions
//   8. Build preload URL list + preload assets across clients
//   9. Drop curtain (now everything's preloaded — clean reveal)
//   10. Entrance animation (staggered fade-in)
//   11. Create Combat doc, add combatants, roll initiative, startCombat
//
// Every token we spawn is flagged with
// flags.fabula-ultima-companion.directorSpawned = true so cleanup on battle
// end can find and remove them.

import { log, warn, err } from "./logger.js";
import { buildDirectorCombat } from "./director-combat.js";

const MODULE_ID = "fabula-ultima-companion";
const FLAG_NS = MODULE_ID;
const FLAG_DIRECTOR_SPAWNED = "directorSpawned";

// ─── Helpers ───────────────────────────────────────────────────────────

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function safeFromUuid(uuid) {
  if (!uuid) return null;
  try { return await fromUuid(uuid); }
  catch (e) { warn("fromUuid failed", uuid, e); return null; }
}

async function resolveScene(uuid) {
  const doc = await safeFromUuid(uuid);
  return doc?.documentName === "Scene" ? doc : null;
}

async function resolveActor(uuidOrName) {
  if (!uuidOrName) return null;
  // Try UUID first
  if (String(uuidOrName).includes(".")) {
    const doc = await safeFromUuid(uuidOrName);
    if (doc?.documentName === "Actor") return doc;
  }
  // Fall back to name lookup
  const a = game.actors?.getName?.(uuidOrName);
  return a ?? null;
}

function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
function lerp(a, b, t) { return a + (b - a) * t; }
function lerpPoint(p1, p2, t) { return { x: lerp(p1.x, p2.x, t), y: lerp(p1.y, p2.y, t) }; }

// Distribute `count` points evenly between top and bottom on a line.
function distributeOnLine(top, bottom, count) {
  if (count <= 0) return [];
  if (count === 1) return [lerpPoint(top, bottom, 0.5)];
  const out = [];
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    out.push(lerpPoint(top, bottom, t));
  }
  return out;
}

// Wait for `canvasReady` (with timeout) so subsequent token operations have
// a canvas. Returns true if fired, false on timeout.
function waitForCanvasReady(timeoutMs = 8000) {
  if (canvas?.ready) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const id = Hooks.once("canvasReady", () => {
      if (done) return;
      done = true;
      resolve(true);
    });
    setTimeout(() => {
      if (done) return;
      done = true;
      try { Hooks.off("canvasReady", id); } catch {}
      resolve(false);
    }, timeoutMs);
  });
}

// ─── Curtain (public API) ──────────────────────────────────────────────

async function raiseCurtain() {
  const api = globalThis.FUCompanion?.api?.animationCache;
  if (!api?.raiseCurtain) { log("raiseCurtain: animationCache unavailable, skipping"); return; }
  try { await api.raiseCurtain({ broadcast: true }); log("Curtain raised"); }
  catch (e) { warn("raiseCurtain threw", e); }
}

async function dropCurtain() {
  const api = globalThis.FUCompanion?.api?.animationCache;
  if (!api?.dropCurtain) { log("dropCurtain: animationCache unavailable, skipping"); return; }
  try { await api.dropCurtain({ fadeOutMs: 600, broadcast: true }); log("Curtain dropped"); }
  catch (e) { warn("dropCurtain threw", e); }
}

// ─── Preload ───────────────────────────────────────────────────────────

async function preloadUrls(urls, { label = "director-preload" } = {}) {
  const api = globalThis.FUCompanion?.api?.animationCache;
  const list = Array.from(new Set((urls ?? []).filter(Boolean)));
  if (!list.length) { log("preload: no URLs"); return { ok: true, urls: 0, timedOut: false }; }
  if (!api?.prepareUrlsAcrossClients) {
    // Fallback to a local Foundry preload — at least the GM gets it cached.
    log(`preload: animationCache unavailable, falling back to local preload for ${list.length} URLs`);
    try {
      const TexLoader = globalThis.foundry?.canvas?.TextureLoader ?? globalThis.TextureLoader;
      if (TexLoader?.loader?.load) await TexLoader.loader.load(list);
    } catch (e) { warn("local preload failed", e); }
    return { ok: true, urls: list.length, timedOut: false, fallback: true };
  }
  try {
    log(`preload: ${list.length} URLs across clients`);
    // Pass the legacy's options shape so the API actually waits for client
    // ACKs before resolving (label / reason are used internally for logging
    // and timeout attribution). Returns { timedOut, ... }.
    const result = await api.prepareUrlsAcrossClients(list, {
      label,
      reason: "director-init-preload",
    });
    if (result?.timedOut) {
      warn(`preload: timed out waiting for client ACKs (proceeding anyway)`);
    } else {
      log("preload: done");
    }
    return { ok: true, urls: list.length, timedOut: !!result?.timedOut, result };
  } catch (e) {
    warn("prepareUrlsAcrossClients threw — continuing without preload", e);
    return { ok: false, urls: list.length, error: String(e?.message ?? e) };
  }
}

// Build the full set of URLs to preload for a batch of TokenDocument records.
// Uses the public animationCache helpers when available — STATIC_BATTLE_URLS
// for the always-needed assets, extractAssetUrlsFromToken for per-token
// textures + sounds. Falls back to a basic texture.src scan otherwise.
function buildPreloadUrls({ tokens, payload }) {
  const api = globalThis.FUCompanion?.api?.animationCache;
  const urls = new Set();

  // Static battle assets (curtain, dash SFX, etc.)
  if (api?.STATIC_BATTLE_URLS) {
    for (const u of api.STATIC_BATTLE_URLS) urls.add(u);
  }

  // Per-token textures + linked sounds
  for (const td of tokens) {
    if (api?.extractAssetUrlsFromToken) {
      try {
        for (const u of api.extractAssetUrlsFromToken(td)) urls.add(u);
      } catch (e) { warn("extractAssetUrlsFromToken threw", e); }
    } else {
      const src = td.texture?.src ?? td.img;
      if (src) urls.add(src);
    }
  }

  // BGM (best-effort — the user's BGM is typically a sound name, not a URL,
  // so don't insist).
  const bgm = String(payload?.battleConfig?.bgm ?? "").trim();
  if (bgm && /^https?:\/\//.test(bgm)) urls.add(bgm);

  return Array.from(urls);
}

// ─── Battle stance: ensure WEBM/MP4 token textures auto-play and loop ──
//
// In this codebase the "battle stance animation" of an actor IS the actor's
// prototype token texture, when that texture is a WEBM/MP4. Foundry's PIXI
// pipeline normally plays + loops these automatically, but freshly-spawned
// tokens sometimes need a kick — especially when the texture was preloaded
// behind a curtain. This function walks the given tokens, finds any whose
// underlying resource is a video element, and forces play+loop on it.

async function ensureBattleStancePlaying(tokenDocs) {
  if (!Array.isArray(tokenDocs) || !tokenDocs.length) return;
  let started = 0, skipped = 0;
  for (const td of tokenDocs) {
    try {
      const placeable = canvas?.tokens?.get?.(td.id);
      if (!placeable) { skipped++; continue; }

      // Foundry can store the video on multiple objects depending on the
      // rendering pipeline; check the common ones.
      const candidates = [
        placeable.mesh?.texture,
        placeable.texture,
        placeable.icon?.texture,
      ].filter(Boolean);

      let videoEl = null;
      for (const tex of candidates) {
        const res = tex?.baseTexture?.resource ?? tex?.resource ?? null;
        const src = res?.source ?? res?.element ?? null;
        if (src && typeof HTMLVideoElement !== "undefined" && src instanceof HTMLVideoElement) {
          videoEl = src;
          break;
        }
      }

      // Also check by extension on the document src as a hint
      if (!videoEl) {
        const srcStr = String(td.texture?.src ?? "").toLowerCase();
        const isVideo = /\.(webm|mp4|m4v|ogv)(\?|$)/.test(srcStr);
        if (!isVideo) { skipped++; continue; }
        // Texture not exposed as a video element yet (e.g. still loading).
        // Foundry will play it on next render — nothing to do here.
        skipped++;
        continue;
      }

      try {
        videoEl.muted = true;
        videoEl.loop = true;
        videoEl.playsInline = true;
        if (videoEl.paused) await videoEl.play().catch(() => {});
        started++;
      } catch (e) { warn("stance: video play failed for", td.id, e); }
    } catch (e) {
      warn("ensureBattleStancePlaying: per-token error", td?.id, e);
    }
  }
  if (started || skipped) log(`battle stance: ${started} video textures playing, ${skipped} skipped/static`);
}

// ─── Encounter resolution ──────────────────────────────────────────────
// Returns array of { actorUuid, name, source } — one entry per enemy slot.

async function drawTextFromTable(tableDoc) {
  if (!tableDoc) return "";
  try {
    const draw = await tableDoc.draw({ displayChat: false });
    const result = draw?.results?.[0];
    return String(result?.text ?? "").trim();
  } catch (e) {
    warn("table draw failed", tableDoc?.name, e);
    return "";
  }
}

function isRandomKeyword(s) { return String(s ?? "").trim().toLowerCase() === "random"; }

async function resolveEncounter(payload) {
  const plan = payload?.encounterPlan ?? {};
  const battleType = String(payload?.battlePlan?.type ?? "default").toLowerCase();
  const mode = String(plan.mode ?? "manual").trim();
  const out = [];

  // A) Manual mode
  if (mode === "manual") {
    const picks = Array.isArray(plan.manualPicks) ? plan.manualPicks : [];
    for (const p of picks) {
      const name = String(p?.name ?? "").trim();
      const actor = p?.actorUuid
        ? await safeFromUuid(p.actorUuid)
        : (name ? game.actors?.getName?.(name) : null);
      if (!actor) { warn(`manual pick: actor not found for "${name}"`); continue; }
      const qty = Math.max(1, Number(p?.quantity ?? 1) | 0);
      for (let i = 0; i < qty; i++) {
        out.push({ actorUuid: actor.uuid, name: actor.name, source: "manual" });
      }
    }
    return out;
  }

  // B) Randomize (battleType === "random")
  if (battleType === "random") {
    const enemiesTable = await safeFromUuid(payload?.battleConfig?.enemiesTableUuid);
    if (!enemiesTable) { warn("randomize: enemiesTable not found"); return out; }
    const count = 3 + Math.floor(Math.random() * 3); // 3–5
    for (let i = 0; i < count; i++) {
      const text = await drawTextFromTable(enemiesTable);
      if (!text) continue;
      const actor = game.actors?.getName?.(text);
      if (!actor) { warn(`random draw: actor "${text}" not found`); continue; }
      out.push({ actorUuid: actor.uuid, name: actor.name, source: "enemiesTable" });
    }
    return out;
  }

  // C) Fixed encounter (default/boss): roll encounter table, parse comma list
  if (mode === "rollEncounterTable" || mode === "rollRevealTable" || battleType === "default" || battleType === "boss") {
    const encounterTable = await safeFromUuid(payload?.battleConfig?.encounterTableUuid);
    if (!encounterTable) { warn("fixed encounter: encounterTable not found"); return out; }
    const text = await drawTextFromTable(encounterTable);
    if (!text) { warn("fixed encounter: empty draw"); return out; }
    const slots = text.split(",").map((s) => s.trim()).filter(Boolean);
    const enemiesTable = await safeFromUuid(payload?.battleConfig?.enemiesTableUuid);
    for (const slot of slots) {
      let actor;
      if (isRandomKeyword(slot)) {
        if (!enemiesTable) { warn("encounter slot 'Random' but no enemiesTable"); continue; }
        const sub = await drawTextFromTable(enemiesTable);
        actor = sub ? game.actors?.getName?.(sub) : null;
        if (actor) out.push({ actorUuid: actor.uuid, name: actor.name, source: "enemiesTable:random" });
        else warn(`encounter Random draw: actor "${sub}" not found`);
      } else {
        actor = game.actors?.getName?.(slot);
        if (actor) out.push({ actorUuid: actor.uuid, name: actor.name, source: "encounterTable" });
        else warn(`encounter slot actor not found: "${slot}"`);
      }
    }
    return out;
  }

  warn(`encounter resolve: unknown mode "${mode}" + battleType "${battleType}"`);
  return out;
}

// ─── Party resolution ──────────────────────────────────────────────────
// Returns array of { actorUuid, actorId, name, slot, img }.

function resolveParty(payload) {
  const members = Array.isArray(payload?.party?.members) ? payload.party.members : [];
  const out = [];
  for (const m of members) {
    if (!m?.actorUuid) { warn("party member has no actorUuid", m); continue; }
    out.push({
      actorUuid: m.actorUuid,
      actorId: m.actorId,
      name: m.name,
      slot: m.slot ?? 99,
      img: m.img ?? null,
    });
  }
  // Stable order by slot
  out.sort((a, b) => Number(a.slot) - Number(b.slot));
  return out;
}

// ─── Layout ────────────────────────────────────────────────────────────
// Mirrors legacy Layout Engine conventions: scene 1682x788 reference, grid
// ref 110. Party on right (base x 790-1082, y 181-356), enemies on left
// (base x 274-336, y 197-329). Both columns get a +22 Y offset (the legacy
// PARTY_OFFSET_Y / ENEMY_OFFSET_Y values) and enemy spacing is scaled by
// ENEMY_SPREAD = 1.80 around the midpoint, matching legacy.

const PARTY_OFFSET_X = 0;
const PARTY_OFFSET_Y = 82;   // was 22; pushed down so top of column sits clearly on the ground
const ENEMY_OFFSET_X = 0;
const ENEMY_OFFSET_Y = 82;   // matched to party for symmetry
const ENEMY_SPREAD = 1.80;

function scaleSegmentAroundMidpoint(a, b, scale) {
  const mid = lerpPoint(a, b, 0.5);
  return {
    top: lerpPoint(mid, a, scale),
    bottom: lerpPoint(mid, b, scale),
  };
}

function computeLayout({ party, enemies, scene }) {
  const sceneWidth = scene?.width ?? 1682;
  const sceneHeight = scene?.height ?? 788;
  const grid = scene?.grid?.size ?? 110;

  // Scale all reference points relative to the assumed 1682x788 base so we
  // work on differently-sized scenes too.
  const sx = sceneWidth / 1682;
  const sy = sceneHeight / 788;
  const scaledPoint = (x, y) => ({ x: x * sx, y: y * sy });

  // Base reference points, then apply the +Y offset that the legacy applies
  // to shift the whole formation down a notch.
  const partyTopBase    = scaledPoint(790,  181);
  const partyBottomBase = scaledPoint(1082, 356);
  const enemyTopBase    = scaledPoint(336,  197);
  const enemyBottomBase = scaledPoint(274,  329);

  const partyTop    = { x: partyTopBase.x + PARTY_OFFSET_X * sx,    y: partyTopBase.y + PARTY_OFFSET_Y * sy };
  const partyBottom = { x: partyBottomBase.x + PARTY_OFFSET_X * sx, y: partyBottomBase.y + PARTY_OFFSET_Y * sy };
  const enemyTopRaw    = { x: enemyTopBase.x + ENEMY_OFFSET_X * sx,    y: enemyTopBase.y + ENEMY_OFFSET_Y * sy };
  const enemyBottomRaw = { x: enemyBottomBase.x + ENEMY_OFFSET_X * sx, y: enemyBottomBase.y + ENEMY_OFFSET_Y * sy };

  // Apply ENEMY_SPREAD so the enemy column visually spreads further apart,
  // matching the look the legacy ships with.
  const enemySeg = scaleSegmentAroundMidpoint(enemyTopRaw, enemyBottomRaw, ENEMY_SPREAD);

  const partyPoints = distributeOnLine(partyTop, partyBottom, party.length);
  const enemyPoints = distributeOnLine(enemySeg.top, enemySeg.bottom, enemies.length);

  const partyLayout = party.map((p, i) => ({
    ...p,
    pos: partyPoints[i] ?? partyTop,
  }));
  const enemyLayout = enemies.map((e, i) => ({
    ...e,
    pos: enemyPoints[i] ?? enemySeg.top,
  }));

  return { partyLayout, enemyLayout, grid };
}

// ─── Token spawn (hidden) ──────────────────────────────────────────────
// Returns the created TokenDocument array. Tokens are placed at the layout
// positions, with alpha = 0 so the entrance animation can fade them in.

async function spawnTokensHidden({ scene, layout, disposition }) {
  if (!layout?.length) return [];
  const tokensData = [];
  for (const item of layout) {
    const actor = await resolveActor(item.actorUuid);
    if (!actor) { warn(`spawn: actor ${item.actorUuid} not found`); continue; }
    const proto = actor.prototypeToken;
    const td = proto?.toObject?.() ?? {};
    const width = (td.width ?? 1);
    const height = (td.height ?? 1);
    const gridSize = scene.grid?.size ?? 100;
    // Layout positions are token CENTERS — convert to top-left for Foundry
    td.x = Math.round(item.pos.x - (width * gridSize) / 2);
    td.y = Math.round(item.pos.y - (height * gridSize) / 2);
    td.actorId = actor.id;
    td.actorLink = disposition === 1 ? !!proto?.actorLink : false; // PCs linked, NPCs unlinked
    td.disposition = disposition;
    td.hidden = false;
    td.alpha = 0; // start invisible — entrance animation fades in
    td.flags = { ...(td.flags ?? {}), [FLAG_NS]: { ...(td.flags?.[FLAG_NS] ?? {}), [FLAG_DIRECTOR_SPAWNED]: true } };
    tokensData.push(td);
  }
  if (!tokensData.length) return [];
  log(`Spawning ${tokensData.length} ${disposition === 1 ? "party" : "enemy"} tokens (hidden)`);
  const created = await scene.createEmbeddedDocuments("Token", tokensData);
  return created;
}

// ─── Entrance animation ────────────────────────────────────────────────
// Staggered fade-in: each token's alpha goes 0 → 1 over FADE_MS, with a
// PER_TOKEN_STAGGER_MS delay between tokens (party first, then enemies).

async function playEntranceAnimation({ partyTokens, enemyTokens }) {
  const FADE_MS = 600;
  const PER_TOKEN_STAGGER_MS = 90;
  const PARTY_TO_ENEMY_GAP_MS = 250;

  function fadeIn(tokenDoc, delay) {
    return new Promise(async (resolve) => {
      await wait(delay);
      // Foundry V12 supports doc.update({alpha}, {animate: ...}) or token.fadeIn
      // via the token placeable. The most reliable is to update the doc and
      // tween the placeable's alpha manually for smooth interpolation.
      const placeable = canvas?.tokens?.get?.(tokenDoc.id);
      const start = performance.now();
      function tick(now) {
        const t = Math.min(1, (now - start) / FADE_MS);
        const a = t;
        if (placeable && !placeable.destroyed) {
          // Set both PIXI alpha (visual) and document alpha (persisted).
          try { placeable.alpha = a; } catch {}
          try { if (placeable.mesh) placeable.mesh.alpha = a; } catch {}
        }
        if (t < 1) requestAnimationFrame(tick);
        else {
          // Persist the final alpha = 1 so on reload tokens stay visible.
          tokenDoc.update({ alpha: 1 }).catch(() => {});
          resolve();
        }
      }
      requestAnimationFrame(tick);
    });
  }

  const promises = [];
  partyTokens.forEach((t, i) => promises.push(fadeIn(t, i * PER_TOKEN_STAGGER_MS)));
  const enemyBase = partyTokens.length * PER_TOKEN_STAGGER_MS + PARTY_TO_ENEMY_GAP_MS;
  enemyTokens.forEach((t, i) => promises.push(fadeIn(t, enemyBase + i * PER_TOKEN_STAGGER_MS)));
  await Promise.all(promises);
  log("Entrance animation complete");
}

// ─── Combat creation ───────────────────────────────────────────────────

// Build combatant-data for a list of TokenDocuments. Falls back to the token's
// actor reference when actorId is missing so unlinked tokens (NPCs) still get
// a valid combatant entry.
// Build the director-owned DirectorCombat from the freshly-spawned tokens.
// No Foundry Combat doc is created — dCombat is the sole authority. The
// sourceSceneId is stamped on dCombat itself so the end pipeline can return
// to it (replacing the old `combat.flags.directorMode.sourceSceneId`).
function buildDCombatFromSpawn({ battleScene, partyTokens, enemyTokens, payload }) {
  const dCombat = buildDirectorCombat({
    scene: battleScene,
    partyTokens,
    enemyTokens,
    sourceSceneId: payload?.context?.sourceSceneId ?? null,
  });
  dCombat.start();
  log(`DirectorCombat ready: ${dCombat.size} combatants, sourceSceneId=${dCombat.sourceSceneId ?? "(none)"}`);
  return dCombat;
}

// ─── Top-level orchestration ───────────────────────────────────────────

export async function runDirectorInit(payload) {
  if (!game.user?.isGM) throw new Error("runDirectorInit: GM only");
  if (!payload || typeof payload !== "object") throw new Error("runDirectorInit: invalid payload");

  const battleSceneUuid = payload?.context?.battleSceneUuid ?? payload?.battleConfig?.battleSceneUuid;
  const battleScene = await resolveScene(battleSceneUuid);
  if (!battleScene) throw new Error(`Battle scene not found: ${battleSceneUuid}`);

  // Legacy-listener suppression is handled by director-boot.start() before
  // this function runs (in the FSM path, PrepState.onEnter awaits us — boot
  // already ran). We don't re-suppress here so the console stays quiet.
  // If you call runDirectorInit directly outside the FSM (rare), call
  // LegacySuppressor.suppress() yourself first.

  // ── 2. Raise curtain — black screen for the entire prep phase.
  await raiseCurtain();

  // ── 3. Resolve encounter (manual / random / fixed). All of this runs
  // BEHIND the curtain so the user sees nothing until step 9.
  const enemies = await resolveEncounter(payload);
  log(`Resolved ${enemies.length} enemy slots`);
  if (!enemies.length) {
    warn("No enemies resolved — combat will be party-only. Check encounter settings.");
    ui.notifications?.warn?.("Battle Director: no enemies resolved (check encounter settings in the prompt).");
  }

  // ── 4. Resolve party members from payload.party.members. These come from
  // the DB resolver in the Battle Prompt (member_id_1..4 in the game DB).
  const party = resolveParty(payload);
  log(`Resolved ${party.length} party members`);
  if (!party.length) {
    warn("No party members resolved — combat will be enemy-only. Check that the game DB has member_id_1..4 set.");
    ui.notifications?.warn?.("Battle Director: no party members resolved. Set party slots in the game DB and try again.");
  }
  if (!party.length && !enemies.length) {
    await dropCurtain();
    throw new Error("Neither party nor enemies resolved — nothing to spawn");
  }

  // ── 5. Activate battle scene.
  if (canvas?.scene?.id !== battleScene.id) {
    log(`Activating battle scene: ${battleScene.name}`);
    await battleScene.activate();
    await waitForCanvasReady(8000);
  } else {
    log(`Battle scene ${battleScene.name} already active`);
  }

  // ── 6. Compute layout (party right, enemies left).
  const { partyLayout, enemyLayout } = computeLayout({
    party, enemies, scene: battleScene,
  });

  // ── 7. Spawn tokens hidden (alpha=0) at layout positions.
  const partyTokens = await spawnTokensHidden({ scene: battleScene, layout: partyLayout, disposition: 1 });
  const enemyTokens = await spawnTokensHidden({ scene: battleScene, layout: enemyLayout, disposition: -1 });

  // ── 8. Build preload URL list (STATIC_BATTLE_URLS + per-token textures
  // and sounds + BGM URL) and preload across all clients. We AWAIT this —
  // the curtain stays up until the preload has either ACKed from clients or
  // timed out. This is the user's requested behavior: "only fade out the
  // darken when preload is completed".
  const urls = buildPreloadUrls({ tokens: [...partyTokens, ...enemyTokens], payload });
  const preloadResult = await preloadUrls(urls, { label: `director-${Date.now()}` });
  if (preloadResult?.timedOut) {
    ui.notifications?.warn?.("Battle Director: asset preload timed out; some clients may see fallbacks.");
  }

  // ── 8b. Kick battle-stance video playback (WEBM/MP4 token textures loop
  // their own animation). Done BEFORE the curtain drops so the animations
  // are visibly running the moment the user sees the tokens.
  await ensureBattleStancePlaying([...partyTokens, ...enemyTokens]);

  // ── 9. Drop curtain — only now, after preload ACKs are in and stance
  // animations are kicking. Tokens are positioned but still alpha=0 so
  // they're invisible underneath the curtain; the entrance animation will
  // fade them in next.
  await dropCurtain();

  // Short settle delay so the curtain fade completes visually before
  // entrance starts.
  await wait(150);

  // ── 10. Entrance animation (staggered fade-in).
  await playEntranceAnimation({ partyTokens, enemyTokens });

  // ── 11. Build the director-owned DirectorCombat (no Foundry Combat doc).
  // dCombat is the sole authority for round/turn/current. The Foundry Combat
  // Tracker UI is intentionally NOT used in director mode — the End-Battle
  // button + dCombat status take its place.
  const dCombat = buildDCombatFromSpawn({
    battleScene,
    partyTokens,
    enemyTokens,
    payload,
  });

  return {
    dCombat,
    battleScene,
    enemyTokens: enemyTokens.length,
    partyTokens: partyTokens.length,
  };
}

// ─── Cleanup helper (used on battle end) ───────────────────────────────
// Removes all director-spawned tokens from a scene. Idempotent.

export async function cleanupDirectorSpawnedTokens(scene) {
  if (!scene) return 0;
  const flagged = (scene.tokens?.contents ?? []).filter((t) =>
    !!t.getFlag?.(FLAG_NS, FLAG_DIRECTOR_SPAWNED)
  );
  if (!flagged.length) return 0;
  const ids = flagged.map((t) => t.id);
  try {
    await scene.deleteEmbeddedDocuments("Token", ids);
    log(`Cleaned up ${ids.length} director-spawned tokens from ${scene.name}`);
  } catch (e) {
    warn("cleanupDirectorSpawnedTokens threw", e);
  }
  return ids.length;
}
