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
import { DIRECTOR_STATIC_URLS, playBattleStartTransition, playBattleBgm } from "./director-vfx.js";
import { preloadDirectorCutins } from "./director-cutin.js";

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

  // Director's own runtime assets — Guard / Covered AE icons (Forge-vtt,
  // remote = slow first-fetch), Study VFX file, study sound. Preloading
  // these here means the first time the player uses Guard or Study mid-
  // battle there's no icon-fetch lag.
  for (const u of DIRECTOR_STATIC_URLS) urls.add(u);

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
// Scene 1682x788 reference, grid ref 110. Other scenes scale proportionally
// via sx/sy in computeLayout.
//
// Party on right: base anchors (1202, 162) → (1367, 492). The diagonal
// goes ~71%→81% across the scene width, mirroring the monster wedge on
// the left and leaving the center column clear of the action-card overlay
// (~320px wide, anchored to viewport center). The bottom of the column
// also leaves room on the left of each token for the upcoming reaction
// menu blades. User-tuned 2026-05-29 — see [[reaction-menu-on-token]].
//
// Enemies on left: base anchors (336, 197) → (274, 329), unchanged.
// Spacing scaled by ENEMY_SPREAD = 1.80 around the midpoint.

const PARTY_OFFSET_X = 0;
const PARTY_OFFSET_Y = 0;    // bases ARE the final positions; no offset
const ENEMY_OFFSET_X = 0;
const ENEMY_OFFSET_Y = 82;   // legacy enemy column drop (kept as-is)
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

  // Base reference points. Party diagonal sits on the right side of the
  // scene (action-card-clear, menu-room-clear); enemy column on the left.
  const partyTopBase    = scaledPoint(1202, 162);
  const partyBottomBase = scaledPoint(1367, 492);
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
    // Battle-ready sprite swap: if the actor declares a `sprite_battle`
    // (an animated _Battler loop, e.g. the PCs Hina/Keren/Blanche/Zarg),
    // spawn the battle token with that texture instead of the normal
    // prototype sprite. These tokens are director-spawned and despawned at
    // battle end (cleanupDirectorSpawnedTokens), so the "revert to normal"
    // is automatic — the overworld token keeps its standard sprite. The WEBM
    // is kicked to loop by ensureBattleStancePlaying below.
    const battleSprite = String(actor.system?.props?.sprite_battle ?? "").trim();
    if (battleSprite) {
      td.texture = { ...(td.texture ?? {}), src: battleSprite };
    }
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
// Party "run in from the right": each player token is staged off-screen to
// the right of its final spot, then slides into place via Foundry's token
// animation — staggered top→bottom (Hina first … Zarg last). Ports the legacy
// party dash (DashA SFX, ~650px offset, ~650ms run). Enemies keep the simple
// staggered fade-in.

const PARTY_DASH_SFX_URL =
  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/DashA.wav";

async function playEntranceAnimation({ partyTokens, enemyTokens }) {
  const FADE_MS = 600;
  const PER_TOKEN_STAGGER_MS = 90;

  // Party run-in tuning.
  const DASH_MS = 520;          // slide duration (matches the approved preview)
  const DASH_STAGGER_MS = 120;  // per-actor offset, top→bottom ("a bit")
  // easeOutExpo — fast in, hard deceleration into the spot (chosen via the
  // run-in test button). Applied via an rAF tween on PIXI sprite copies, NOT
  // Foundry's native token movement (which ignores custom easing → renders
  // linear). This is the legacy party-dash approach.
  const easeOutExpo = (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));

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

  // ── Party: run in from the right, staggered top→bottom ──
  // Animate cheap PIXI sprite copies (not the real tokens) so we get a proper
  // eased dash — Foundry's native token movement renders linear. The real
  // tokens stay hidden (alpha 0) at their final spots and are revealed once the
  // copies arrive, then the copies are destroyed. (Legacy party-dash approach.)
  async function dashInParty() {
    if (!partyTokens.length) return;
    const placeables = partyTokens.map((td) => canvas?.tokens?.get?.(td.id)).filter(Boolean);
    const revealAll = () => canvas.scene.updateEmbeddedDocuments(
      "Token", partyTokens.map((t) => ({ _id: t.id, alpha: 1 })), { animate: false }
    ).catch(() => {});

    if (!placeables.length) { await revealAll(); return; }

    // World offset ≈ 60% of the viewport width (matches the approved preview),
    // in world units so the run-in starts off-screen at any zoom.
    const scale = canvas.stage?.scale?.x || 1;
    const screenW = canvas.app?.renderer?.screen?.width ?? 1920;
    const worldOffset = (0.6 * screenW) / scale;

    // Build a sprite copy of each party token at center + offset.
    canvas.stage.sortableChildren = true;
    const sprites = [];
    for (const tok of placeables) {
      let tex = tok.mesh?.texture;
      if (!tex || tex === PIXI.Texture.EMPTY) {
        try { tex = await loadTexture(tok.document?.texture?.src); } catch {}
      }
      if (!tex) continue;
      const spr = new PIXI.Sprite(tex);
      spr.anchor.set(0.5);
      spr.zIndex = 5000; // above tokens (legacy value)
      const w = tok.mesh?.width ?? tok.w;
      const h = tok.mesh?.height ?? tok.h;
      if (w) spr.width = w;
      if (h) spr.height = h;
      // Match the token's horizontal facing (texture scaleX sign).
      const sx = Number(tok.document?.texture?.scaleX) || 1;
      spr.scale.x = (sx < 0 ? -1 : 1) * Math.abs(spr.scale.x);
      spr.position.set(tok.center.x + worldOffset, tok.center.y);
      canvas.stage.addChild(spr);
      sprites.push({ spr, restX: tok.center.x, y: tok.center.y });
    }
    canvas.stage.sortChildren?.();
    if (!sprites.length) { await revealAll(); return; }

    // Play the (shared) battle WEBM on each copy so the characters animate
    // WHILE running in. Cheap — only the ~4 party sprites. Each copy shares the
    // real token's mesh texture, so the instant the token is revealed it shows
    // the identical animating frame → seamless handoff (see reveal below).
    const playTexVideo = (tex) => {
      try {
        const vid = tex?.baseTexture?.resource?.source;
        if (vid instanceof HTMLVideoElement) { vid.loop = true; vid.muted = true; vid.play?.()?.catch?.(() => {}); }
      } catch {}
    };
    for (const { spr } of sprites) playTexVideo(spr.texture);

    // Top → bottom (Hina first … Zarg last).
    sprites.sort((a, b) => a.y - b.y);

    // Dash SFX once, broadcast to all clients.
    try {
      const AH = foundry?.audio?.AudioHelper ?? globalThis.AudioHelper;
      AH?.play?.({ src: PARTY_DASH_SFX_URL, volume: 0.85, autoplay: true, loop: false }, true);
    } catch (e) { warn("party dash SFX failed", e); }

    // rAF tween each copy from off-right to rest with easeOutExpo, staggered.
    const tweenX = (spr, toX, ms) => new Promise((res) => {
      const fromX = spr.x;
      const start = performance.now();
      const step = (now) => {
        const t = Math.min(1, (now - start) / ms);
        spr.x = fromX + (toX - fromX) * easeOutExpo(t);
        if (t < 1) requestAnimationFrame(step);
        else res();
      };
      requestAnimationFrame(step);
    });
    await Promise.all(sprites.map((s, i) => (async () => {
      await wait(i * DASH_STAGGER_MS);
      await tweenX(s.spr, s.restX, DASH_MS);
    })()));

    // Reveal the real tokens at rest BEFORE removing the copies. The token
    // shares the same (already-playing) texture, so it shows the identical
    // animating frame; wait one painted frame, then destroy the copies — no
    // flicker, no freeze. (texture:false so the shared texture survives for the
    // real token's mesh.)
    await revealAll();
    await new Promise((r) => requestAnimationFrame(r));
    for (const { spr } of sprites) {
      try { canvas.stage.removeChild(spr); spr.destroy({ children: true, texture: false, baseTexture: false }); }
      catch {}
    }
  }

  // Party dashes in first, then enemies fade in (kept light + sequential so
  // we're not moving + fading + looping every WEBM token on the same frames).
  await dashInParty();
  await Promise.all(enemyTokens.map((t, i) => fadeIn(t, i * PER_TOKEN_STAGGER_MS)));
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

  // ── 1b. Battle-start "broken screen" transition — orange ground-crack FX +
  // SFX on the CURRENT (source) scene, before the curtain raises and we swap
  // to the battle scene. Ports the legacy "BattleInit — Battle Transition"
  // cinematic; broadcasts to all clients. Awaited so the crack is visible
  // before the curtain goes black.
  await playBattleStartTransition({ waitMs: 900 });

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

  // ── 5. Activate battle scene + view it locally.
  //
  // `Scene.activate()` flips the world's active scene but does NOT
  // necessarily switch the calling GM's local canvas — `viewedScene` is a
  // per-client state and `activate()` only does an implicit view() if the
  // GM hasn't explicitly viewed a different scene since. After launching
  // from the title (source) scene with the GM viewing it, activate() leaves
  // the GM stuck on the title scene; subsequent token spawns + entrance
  // animation happen on the battle scene the GM can't see, and TURN_START's
  // picker can't find canvas tokens → infinite loop until the rate-limiter
  // kicks in.
  //
  // Calling `scene.view()` explicitly is the per-client switch that the
  // calling GM (and any GM running PREP) needs. Always run both: activate()
  // sets the world flag for player clients, view() pulls the GM's local
  // canvas along.
  if (canvas?.scene?.id !== battleScene.id) {
    log(`Activating battle scene: ${battleScene.name}`);
    try { await battleScene.activate(); } catch (e) { warn("battleScene.activate threw", e); }
    try { await battleScene.view();     } catch (e) { warn("battleScene.view threw", e); }
    await waitForCanvasReady(8000);
  } else {
    log(`Battle scene ${battleScene.name} already active locally`);
    // Defensive: still call activate() so the world's active flag is set
    // (covers the case where the GM viewed the battle scene manually before
    // pressing the combat button).
    if (!battleScene.active) {
      try { await battleScene.activate(); } catch (e) { warn("battleScene.activate threw", e); }
    }
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

  // ── 8b. Start battle BGM in parallel with the curtain drop so the music
  // begins exactly as the scene reveals (cinematic). Fire-and-forget — the
  // playlist write broadcasts to all clients on its own; we don't block the
  // reveal on it. Ports the legacy BattleInit BGM start (plays the chosen
  // track name from whichever playlist holds it).
  playBattleBgm(payload).catch((e) => warn("PREP: playBattleBgm threw", e));

  // ── 9. Drop curtain — only now, after preload ACKs are in. Tokens are
  // positioned but still alpha=0 (invisible) underneath the curtain; the
  // entrance animation reveals them next. The party run-in animates its own
  // (cheap, ~4) WEBM sprite copies; enemy stance loops start at step 10b.
  await dropCurtain();

  // Short settle delay so the curtain fade completes visually before
  // entrance starts.
  await wait(150);

  // ── 10. Entrance animation (party run-in from the right, staggered
  // top→bottom; enemies fade in).
  await playEntranceAnimation({ partyTokens, enemyTokens });

  // ── 10b. Ensure battle-stance WEBM/MP4 loops are running on every token.
  // Idempotent: the party tokens are already animating (their shared texture
  // was played by the run-in copies, so the reveal handed off seamlessly);
  // this mainly kicks the enemies, which faded in on their static first frame.
  await ensureBattleStancePlaying([...partyTokens, ...enemyTokens]);

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

  // ── 12. Preload critical-hit cut-in art across clients. The director has
  // no Foundry Combat doc, so the legacy cutin-receiver `combatStart`
  // preloader never fires — we rebuild the trigger director-side here.
  // Fire-and-forget: the first crit is at least a turn away, so clients have
  // ample time to cache before playback. See director-vfx.js for rationale.
  preloadDirectorCutins({ tokens: [...partyTokens, ...enemyTokens] })
    .catch((e) => warn("PREP: preloadDirectorCutins threw", e));

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
