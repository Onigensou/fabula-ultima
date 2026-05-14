// ============================================================================
// Teleporter System — Bootstrap & Movement Detection
//
// DUNGEON MODE ("dungeon"):
//   Hooks "dungeonPathing.turnEnd" which fires { tokenDoc, node }.
//   confirmMode=true → styled parchment/JRPG dialog with smart text:
//     same-scene  → "Go to next Area?"
//     cross-scene → "Enter <navName>?" or "Enter Area?"
//   confirmMode=false → teleport immediately after turn end.
//
// EXPLORATION MODE ("exploration"):
//   Hooks "updateToken".  Runs on ALL clients (players + GM).
//   confirmMode=true  → floating 🚪 button above the token while on the tile;
//                        clicking the button triggers teleport.
//   confirmMode=false → teleport fires automatically when token enters tile
//                        (original instant behavior, no button shown).
//
//   Uses a cached db actor ID (refreshed on ready/updateActor) for a fast
//   synchronous pre-check so most token moves are rejected without a debounce.
//   250 ms debounce settles rapid drag/animation updates before evaluating.
//
// FLOATING BUTTON:
//   • HTML element, fixed-position, tracked every RAF to follow the canvas
//     transform (camera smoothly follows token via camera-follow-actor.js).
//   • Shown when party token lands on an enabled teleporter tile AND
//     confirmMode is true.
//   • Hidden on any token move that leaves the tile, on teleport arrival
//     (options.teleporter), on canvasTearDown, and on cooldown.
//
// LOOP SAFEGUARD:
//   Per-token cooldown map (tokenId → timestamp).  2-second window blocks
//   A→B→A infinite loops when both tiles are teleporters.
//
// SCENE MODE "none": fully disabled.
// ============================================================================
(() => {
  const GUARD = "__ONI_TP_BOOTSTRAP__";
  if (window[GUARD]?.installed) return;
  window[GUARD] = { installed: true };

  const TP        = globalThis.TeleporterSystem ??= {};
  const MODULE_ID = TP.MODULE_ID ?? "fabula-ultima-companion";
  const FLAG_ROOT = TP.FLAG_ROOT ?? "teleporter";
  const TAG       = "[TeleporterSystem][Bootstrap]";
  const STYLE_ID  = "oni-tp-bootstrap-style";

  // ── CSS injection ─────────────────────────────────────────────────────────────

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
/* ── Teleporter floating HUD button ── */
#oni-tp-hud-btn {
  position: fixed;
  z-index: 9990;
  transform: translate(-50%, -100%);
  display: flex;
  align-items: center;
  justify-content: center;
  width: 42px;
  height: 42px;
  font-size: 22px;
  line-height: 1;
  border-radius: 50%;
  border: 2px solid rgba(160,100,255,.75);
  background: rgba(22,8,52,.88);
  cursor: pointer;
  pointer-events: auto;
  user-select: none;
  box-shadow: 0 0 14px rgba(160,100,255,.55), 0 4px 14px rgba(0,0,0,.55);
  animation: oni-tp-btn-pulse 1.8s ease-in-out infinite;
  text-shadow: 0 0 8px rgba(200,160,255,.8);
  transition: filter .12s ease;
}
#oni-tp-hud-btn:hover  { filter: brightness(1.25); border-color: rgba(200,140,255,.9); }
#oni-tp-hud-btn:active { transform: translate(-50%,-100%) scale(.91); }
@keyframes oni-tp-btn-pulse {
  0%,100% { box-shadow: 0 0 10px rgba(160,100,255,.4), 0 4px 14px rgba(0,0,0,.5); }
  50%     { box-shadow: 0 0 24px rgba(190,130,255,.75), 0 4px 18px rgba(0,0,0,.55); }
}

/* ── Teleporter dungeon dialog — parchment/JRPG theme ── */
.oni-tp-dialog {
  --parchment-1:#f6ebd3; --parchment-2:#efdfc3; --parchment-3:#e7d3b1;
  --wood-1:#a87649; --wood-2:#8d5f38; --wood-3:#6f4526;
  --gold-1:#f4d488; --gold-2:#caa44d; --gold-3:#9a7a2b;
  --ink:#3b2a19; --shadow:rgba(0,0,0,.35); --glow:rgba(250,230,160,.55);
}
.oni-tp-dialog.window-app {
  position: relative !important;
  border: 2px solid rgba(80,52,30,.8) !important;
  border-radius: 14px !important;
  background:
    radial-gradient(120% 80% at 50% 0%,rgba(255,255,255,.45) 0%,rgba(255,255,255,.15) 22%,transparent 40%),
    linear-gradient(180deg,var(--parchment-1) 0%,var(--parchment-2) 55%,var(--parchment-3) 100%) !important;
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,.6),
    inset 0 0 0 2px rgba(255,255,255,.08),
    0 0 0 8px rgba(90,60,34,.5),
    0 16px 32px var(--shadow) !important;
  overflow: visible !important;
  color: var(--ink) !important;
  font-family: "Signika","Noto Sans","Inter",system-ui,sans-serif;
}
/* Wooden frame extends beyond dialog border */
.oni-tp-dialog.window-app::before {
  content: "";
  position: absolute;
  inset: -11px;
  border-radius: 22px;
  background:
    linear-gradient(180deg,rgba(255,255,255,.06),rgba(0,0,0,.12)),
    repeating-linear-gradient(22deg,
      var(--wood-1) 0 10px, var(--wood-2) 10px 20px,
      var(--wood-3) 20px 30px, var(--wood-2) 30px 40px);
  box-shadow: 0 0 0 1px rgba(52,32,18,.85), 0 10px 32px rgba(0,0,0,.5);
  z-index: -1;
  filter: saturate(.94) contrast(1.06) sepia(.12);
  pointer-events: none;
}
/* Brass studs — top-left anchor; rest faked via box-shadow */
.oni-tp-dialog.window-app::after {
  --r:10px;
  content: "";
  position: absolute;
  width: var(--r); height: var(--r);
  border-radius: 50%;
  top: 8px; left: 8px;
  background:
    radial-gradient(circle at 35% 35%,#fff8,#fff0 55%),
    radial-gradient(circle at 62% 65%,#0003,#0000 60%),
    linear-gradient(180deg,var(--gold-1),var(--gold-2) 60%,var(--gold-3));
  box-shadow:
    calc(100% - 16px + 2px) 0  0 0 var(--gold-2),
    0 calc(100% - 16px + 2px) 0 0 var(--gold-2),
    calc(100% - 16px + 2px) calc(100% - 16px + 2px) 0 0 var(--gold-2),
    0 0 10px var(--glow);
  z-index: 1;
  pointer-events: none;
}
/* Header — gold plaque */
.oni-tp-dialog .window-header {
  background: linear-gradient(180deg,var(--gold-1) 0%,var(--gold-2) 55%,var(--gold-3) 100%) !important;
  border-bottom: 2px solid rgba(90,60,34,.55);
  border-radius: 12px 12px 0 0;
  color: #4b3517 !important;
  text-shadow: 0 1px 0 rgba(255,255,255,.55);
  padding: 8px 14px;
}
.oni-tp-dialog .window-header .window-title {
  color: #4b3517 !important;
  font-weight: 700;
  letter-spacing: .3px;
}
.oni-tp-dialog .window-header .header-button {
  color: #5c421e !important;
}
/* Content */
.oni-tp-dialog .window-content {
  background: transparent !important;
  color: var(--ink) !important;
  font-family: "Signika","Noto Sans","Inter",system-ui,sans-serif;
  padding: 14px 18px 6px;
}
.oni-tp-dialog .window-content p,
.oni-tp-dialog .window-content .oni-tp-msg {
  text-align: center;
  padding: 6px 4px;
  margin: 0;
  font-size: 1.08em;
  font-weight: 600;
  color: var(--ink) !important;
  line-height: 1.55;
}
/* Divider above buttons */
.oni-tp-dialog .dialog-buttons,
.oni-tp-dialog footer.dialog-buttons {
  border-top: 1px solid rgba(92,66,30,.35);
  padding: 8px 12px 10px;
  background: transparent !important;
  display: flex;
  gap: 8px;
}
/* JRPG gold buttons */
.oni-tp-dialog .dialog-buttons button,
.oni-tp-dialog footer.dialog-buttons button {
  flex: 1;
  border: 1px solid rgba(90,60,34,.68) !important;
  border-radius: 10px !important;
  padding: 7px 14px !important;
  font-weight: 700;
  cursor: pointer;
  background: linear-gradient(180deg,var(--gold-1) 0%,var(--gold-2) 58%,var(--gold-3) 100%) !important;
  color: #4b3517 !important;
  text-shadow: 0 1px 0 rgba(255,255,255,.6);
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,.6),
    0 0 0 2px rgba(90,60,34,.26),
    0 6px 16px rgba(0,0,0,.2) !important;
  transition: transform .06s ease, filter .12s ease, box-shadow .12s ease;
}
.oni-tp-dialog .dialog-buttons button:hover,
.oni-tp-dialog footer.dialog-buttons button:hover {
  filter: brightness(1.07) saturate(1.06);
}
.oni-tp-dialog .dialog-buttons button:active,
.oni-tp-dialog footer.dialog-buttons button:active {
  transform: translateY(1px) !important;
  box-shadow:
    inset 0 1px 0 rgba(0,0,0,.1),
    0 0 0 2px rgba(90,60,34,.26),
    0 3px 8px rgba(0,0,0,.28) !important;
}
    `;
    document.head.appendChild(s);
  }

  // ── Cooldown — short time-based guard (rule 2 + network edge-case) ──────────
  // Primary protection against rapid re-fire and against remote clients that
  // may not receive options.teleporter from the server.  Exit-based locking
  // (see _destLock below) is the main guard for rules 3 & 4.
  const COOLDOWN_MS = 2000;
  const _cooldowns  = new Map(); // tokenId → timestamp

  function isOnCooldown(tokenDoc) {
    const last = _cooldowns.get(tokenDoc.id);
    return !!last && (Date.now() - last) < COOLDOWN_MS;
  }

  function markCooldown(tokenDoc) {
    _cooldowns.set(tokenDoc.id, Date.now());
    setTimeout(() => _cooldowns.delete(tokenDoc.id), COOLDOWN_MS * 2);
  }

  // ── Destination lock — exit-based guard (rules 3 & 4) ────────────────────────
  // After a token teleports onto tile B, B is locked for that token until it
  // physically exits B's area.  Time doesn't matter — only position does.
  // This prevents B from re-triggering and sending the token back to A,
  // even if the token idles on B long enough for the cooldown to expire.
  const _destLock = new Map(); // tokenId → Set<tileId>

  function _lockDestTile(tokenId, tileId) {
    let s = _destLock.get(tokenId);
    if (!s) { s = new Set(); _destLock.set(tokenId, s); }
    s.add(tileId);
    console.debug(TAG, `[destLock] locked tile ${tileId} for token ${tokenId}`);
  }

  function _isDestLocked(tokenId, tileId) {
    return _destLock.get(tokenId)?.has(tileId) ?? false;
  }

  // _sweepDestLocks is now integrated into _detectEnter (exit detection).

  // ── Cached db actor ID + PIXI token watch ────────────────────────────────────
  // _cachedDbActorId: fast sync pre-check (avoids flag reads for non-party moves).
  // _tpWatchToken: the live PIXI Token object for the db actor.  Its .center
  //   property returns the CURRENT VISUAL position, which updates every animation
  //   frame — not the document x/y, which only reflects the final destination.
  //   This is what lets us detect tile entry mid-slide.

  let _cachedDbActorId = null;
  let _tpWatchToken    = null; // PIXI Token object
  let _tpTickerFn      = null; // current ticker callback (null when not installed)

  async function warmDbCache() {
    try {
      const res = await window.FUCompanion?.api?.getCurrentGameDb?.();
      _cachedDbActorId = res?.db?.id ?? null;
    } catch {
      _cachedDbActorId = null;
    }
    _refreshWatchToken();
  }

  function _refreshWatchToken() {
    if (!_cachedDbActorId || !canvas?.tokens) { _tpWatchToken = null; return; }
    _tpWatchToken = canvas.tokens.placeables.find(
      t => t.document.actorId === _cachedDbActorId
    ) ?? null;
  }

  // Start the per-frame ticker that reads the visual (PIXI) position of the db
  // actor token and drives teleporter enter detection.
  function _startExploreWatch() {
    if (_tpTickerFn || !canvas?.app?.ticker) return;
    _tpTickerFn = () => {
      if (_getSceneMode() !== "exploration") return;
      if (!_tpWatchToken) return;
      const vis = _tpWatchToken.center; // PIXI visual position — live during animation
      _runExploreDetect(_tpWatchToken.document, vis.x, vis.y);
    };
    canvas.app.ticker.add(_tpTickerFn);
  }

  function _stopExploreWatch() {
    if (_tpTickerFn) { canvas?.app?.ticker?.remove(_tpTickerFn); _tpTickerFn = null; }
    _tpWatchToken = null;
  }

  Hooks.once("ready", () => {
    ensureStyle();
    warmDbCache(); // also calls _refreshWatchToken
    Hooks.on("updateActor", () => { _cachedDbActorId = null; warmDbCache(); });
  });

  // ── Helpers ──────────────────────────────────────────────────────────────────

  function getFlags(tileDoc) {
    return tileDoc?.flags?.[MODULE_ID]?.[FLAG_ROOT] ?? null;
  }

  function isTeleporterEnabled(tileDoc) {
    const f = getFlags(tileDoc);
    return f?.enabled === true || f?.enabled === "true";
  }

  function getSceneMode(scene) {
    const sc  = scene ?? canvas?.scene;
    const DP  = globalThis.DungeonPathing;
    if (!DP) return "none";
    const fab  = sc?.flags?.[MODULE_ID]?.[DP.FABULA_ROOT_KEY]?.[DP.GENERAL_KEY];
    const mode = fab?.[DP.SCENE_MODE_KEY];
    if (mode === "dungeon" || mode === "exploration" || mode === "none") return mode;
    const legacy = fab?.cameraFollowToken;
    if (legacy === true || legacy === "true" || legacy === 1) return "exploration";
    return "none";
  }

  function tokenCenter(tokenDoc) {
    const gSize = canvas?.grid?.size ?? 100;
    return {
      x: (tokenDoc.x ?? 0) + (tokenDoc.width  ?? 1) * gSize / 2,
      y: (tokenDoc.y ?? 0) + (tokenDoc.height ?? 1) * gSize / 2,
    };
  }

  // ── Cached scene mode ────────────────────────────────────────────────────────
  // getSceneMode() traverses several nested scene-flag levels on every call.
  // Cache the result; invalidate only when scene flags change or canvas changes.

  let _cachedSceneMode = null;

  function _getSceneMode() {
    if (_cachedSceneMode !== null) return _cachedSceneMode;
    return (_cachedSceneMode = getSceneMode());
  }

  function _invalidateSceneMode() { _cachedSceneMode = null; }

  Hooks.on("updateScene", (sceneDoc, changes) => {
    if ("flags" in changes) _invalidateSceneMode();
  });

  // ── World → viewport coordinate conversion ───────────────────────────────────
  // Used to position the floating HUD button over the token as the camera moves.

  function worldToViewport(worldX, worldY) {
    const t    = canvas?.stage?.worldTransform;
    const el   = canvas?.app?.view ?? canvas?.app?.renderer?.view;
    const rect = el?.getBoundingClientRect?.() ?? { left: 0, top: 0, width: 1, height: 1 };
    const cx   = worldX * (t?.a || 1) + (t?.tx || 0);
    const cy   = worldY * (t?.d || 1) + (t?.ty || 0);
    return {
      x: (cx / (el?.width  || rect.width  || 1)) * rect.width  + rect.left,
      y: (cy / (el?.height || rect.height || 1)) * rect.height + rect.top,
    };
  }

  // ── Floating HUD button ───────────────────────────────────────────────────────

  let _hudBtn      = null;
  let _hudBtnTile  = null;
  let _hudBtnToken = null;
  let _hudBtnRaf   = null;

  function _positionHudBtn(btn, tokenDoc) {
    if (!btn || !tokenDoc) return;
    const gSize = canvas?.grid?.size ?? 100;
    const cx = (tokenDoc.x ?? 0) + (tokenDoc.width  ?? 1) * gSize / 2;
    const cy = (tokenDoc.y ?? 0) - gSize * 0.25; // anchor point above the token top
    const sc = worldToViewport(cx, cy);
    btn.style.left = `${Math.round(sc.x)}px`;
    btn.style.top  = `${Math.round(sc.y)}px`;
  }

  function showTpHudButton(tileDoc, tokenDoc) {
    hideTpHudButton();

    const btn = document.createElement("button");
    btn.id = "oni-tp-hud-btn";
    btn.title = "Use Teleporter";
    btn.textContent = "🚪";
    document.body.appendChild(btn);

    _hudBtn      = btn;
    _hudBtnTile  = tileDoc;
    _hudBtnToken = tokenDoc;

    // Immediately position before the first RAF so there's no single-frame misplace
    _positionHudBtn(btn, tokenDoc);

    // Click → teleport immediately (the button IS the confirmation)
    btn.addEventListener("pointerdown", async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const tile  = _hudBtnTile;
      const token = _hudBtnToken;
      hideTpHudButton();
      if (tile && token) {
        await triggerTeleporter(tile, token, { applyDpOffset: false, forcedNodeId: null });
      }
    });

    // RAF loop: re-position every frame while camera is moving to follow the token
    function track() {
      if (_hudBtn !== btn) return;
      _positionHudBtn(btn, tokenDoc);
      _hudBtnRaf = requestAnimationFrame(track);
    }
    _hudBtnRaf = requestAnimationFrame(track);
  }

  function hideTpHudButton() {
    if (_hudBtnRaf) { cancelAnimationFrame(_hudBtnRaf); _hudBtnRaf = null; }
    _hudBtn?.remove();
    _hudBtn      = null;
    _hudBtnTile  = null;
    _hudBtnToken = null;
  }

  // ── Dungeon confirmation dialog — parchment/JRPG themed with smart text ──────

  async function askTeleportConfirmDungeon(destination) {
    const currentSceneId = canvas?.scene?.id;
    const isCrossScene   = destination?.sceneId && destination.sceneId !== currentSceneId;

    let promptText;
    if (isCrossScene) {
      const destScene = game.scenes.get(destination.sceneId);
      const navName   = destScene?.navName?.trim() || null;
      promptText = navName ? `Enter ${navName}?` : "Enter Area?";
    } else {
      promptText = "Go to next Area?";
    }

    return Dialog.confirm(
      {
        title:   "Teleporter",
        content: `<p class="oni-tp-msg">${promptText}</p>`,
      },
      {
        classes: ["dialog", "oni-tp-dialog"],
        width:   280,
      }
    );
  }

  // ── Core trigger ──────────────────────────────────────────────────────────────

  async function triggerTeleporter(tileDoc, tokenDoc, { applyDpOffset = false, forcedNodeId = null } = {}) {
    if (isOnCooldown(tokenDoc)) {
      console.debug(TAG, "Trigger skipped (cooldown active) for token:", tokenDoc.id);
      return;
    }

    const flags = getFlags(tileDoc);
    if (!flags?.enabled) return;

    if (!flags.destination) {
      ui.notifications?.warn?.("Teleporter tile has no destination configured.");
      return;
    }

    console.debug(TAG, "Trigger | tile:", tileDoc.id, "→", flags.destination,
      "| offset:", applyDpOffset, "| forcedNodeId:", forcedNodeId);

    // Dungeon mode: show styled dialog if confirmMode is on.
    // Exploration mode: button click was the confirmation — no dialog shown here.
    const confirmMode = flags.confirmMode !== false && flags.confirmMode !== "false";
    if (confirmMode && getSceneMode() === "dungeon") {
      const confirmed = await askTeleportConfirmDungeon(flags.destination);
      if (!confirmed) return;
    }

    // Mark cooldown BEFORE async work so concurrent triggers are blocked
    markCooldown(tokenDoc);

    try {
      const sfxUrl = (typeof flags.sfxUrl === "string" && flags.sfxUrl.trim()) ? flags.sfxUrl.trim() : undefined;
      await TP.api.teleportToken(tokenDoc, flags.destination, { sfxUrl, applyDpOffset, forcedNodeId });
    } catch (e) {
      console.error(TAG, "Teleportation failed:", e);
      ui.notifications?.error?.("Teleporter error — see console.");
    }
  }

  // ── DUNGEON MODE — hook on turnEnd ────────────────────────────────────────────

  Hooks.on("dungeonPathing.turnEnd", async ({ tokenDoc, node } = {}) => {
    try {
      if (getSceneMode() !== "dungeon") return;
      if (!node?.nodeId) return;
      if (isOnCooldown(tokenDoc)) return;

      const scene   = canvas?.scene;
      const tileDoc = scene?.tiles?.get?.(node.nodeId);

      console.debug(TAG, "[dungeon] turnEnd | nodeId:", node.nodeId, "| teleporter enabled:", isTeleporterEnabled(tileDoc));

      if (!tileDoc || !isTeleporterEnabled(tileDoc)) return;

      const flags        = getFlags(tileDoc);
      const applyDpOffset = flags?.destination?.type === "tile";
      const forcedNodeId  = flags?.destination?.type === "tile" ? (flags?.destination?.tileId ?? null) : null;

      await triggerTeleporter(tileDoc, tokenDoc, { applyDpOffset, forcedNodeId });
    } catch (e) {
      console.error(TAG, "dungeonPathing.turnEnd handler error:", e);
    }
  });

  // ── Per-token tile-presence tracking (enter detection) ───────────────────────
  // tokenId → Set<tileId>: which teleporter tiles the token center is currently
  // inside.  Populated silently on canvasReady so tokens already sitting on a
  // tile at scene load don't fire a spurious enter on their first move.

  const _tokenOnTile = new Map();

  function _initOnTileCache() {
    _tokenOnTile.clear();
    const tileCache = _getTileCache();
    if (!tileCache.length) return;
    for (const tokenDoc of (canvas?.scene?.tokens ?? [])) {
      const c = tokenCenter(tokenDoc);
      for (const entry of tileCache) {
        const { rx, ry, rw, rh, tileDoc } = entry;
        if (c.x >= rx && c.x <= rx + rw && c.y >= ry && c.y <= ry + rh) {
          let s = _tokenOnTile.get(tokenDoc.id);
          if (!s) { s = new Set(); _tokenOnTile.set(tokenDoc.id, s); }
          s.add(tileDoc.id);
        }
      }
    }
  }

  Hooks.on("canvasReady", () => {
    _invalidateTileCache();
    _invalidateSceneMode();
    _destLock.clear();
    _tokenOnTile.clear();
    _initOnTileCache();
    _refreshWatchToken();
    _startExploreWatch();
  });

  Hooks.on("createToken", (tokenDoc) => {
    // If the db token appears after canvasReady (e.g. spawned mid-session), latch it.
    if (!_tpWatchToken && tokenDoc.actorId === _cachedDbActorId) _refreshWatchToken();
  });

  Hooks.on("deleteToken", (tokenDoc) => {
    _tokenOnTile.delete(tokenDoc.id);
    _destLock.delete(tokenDoc.id);
    _cooldowns.delete(tokenDoc.id);
    if (_tpWatchToken?.document?.id === tokenDoc.id) _tpWatchToken = null;
  });

  // ── Teleporter tile cache ─────────────────────────────────────────────────────
  // Pre-filters enabled teleporter tiles into a plain array of POJOs so
  // _tileOnPath never touches the Foundry Collection or reads per-tile flags
  // during the hot path.  Rebuilt lazily after any tile mutation or scene load.

  let _tpTileCache = null;

  function _invalidateTileCache() { _tpTileCache = null; }

  function _buildTileCache() {
    _tpTileCache = [];
    for (const tileDoc of (canvas?.scene?.tiles ?? [])) {
      const flags = tileDoc?.flags?.[MODULE_ID]?.[FLAG_ROOT];
      if (flags?.enabled !== true && flags?.enabled !== "true") continue;
      _tpTileCache.push({
        tileDoc,
        rx: tileDoc.x,         ry: tileDoc.y,
        rw: tileDoc.width,     rh: tileDoc.height,
        confirmMode: flags.confirmMode !== false && flags.confirmMode !== "false",
      });
    }
  }

  function _getTileCache() {
    if (_tpTileCache === null) _buildTileCache();
    return _tpTileCache;
  }

  Hooks.on("createTile", _invalidateTileCache);
  Hooks.on("deleteTile", _invalidateTileCache);
  Hooks.on("updateTile", (tileDoc, changes) => {
    if ("flags" in changes || "x" in changes || "y" in changes ||
        "width" in changes || "height" in changes) _invalidateTileCache();
  });

  // ── Enter detection ──────────────────────────────────────────────────────────
  // Compares the token's new center position against every cached teleporter tile.
  // Returns tile-cache entries the token JUST ENTERED (center moved outside→inside).
  // Also handles exits: tiles the token left are removed from _tokenOnTile and
  // their dest locks are disarmed (rules 3 & 4).
  //
  // Dest-locked tiles (token arrived there via teleport and hasn't left yet) are
  // tracked in _tokenOnTile so exits are still detected, but they are NOT added
  // to the returned array — they don't trigger.

  function _detectEnter(tokenId, cx, cy) {
    let onTile = _tokenOnTile.get(tokenId);
    if (!onTile) { onTile = new Set(); _tokenOnTile.set(tokenId, onTile); }

    const entered  = [];
    const nowOnIds = new Set();

    for (const entry of _getTileCache()) {
      const { rx, ry, rw, rh, tileDoc } = entry;
      if (cx >= rx && cx <= rx + rw && cy >= ry && cy <= ry + rh) {
        nowOnIds.add(tileDoc.id);
        // Was outside → now inside, and not dest-locked → genuine enter
        if (!onTile.has(tileDoc.id) && !_isDestLocked(tokenId, tileDoc.id)) {
          entered.push(entry);
        }
      }
    }

    // Exits: tiles token was on but is no longer on
    for (const tileId of onTile) {
      if (!nowOnIds.has(tileId)) {
        onTile.delete(tileId);
        // Disarm dest lock when token physically leaves the locked tile (rule 4)
        const locked = _destLock.get(tokenId);
        if (locked?.has(tileId)) {
          locked.delete(tileId);
          if (locked.size === 0) _destLock.delete(tokenId);
          console.debug(TAG, `[destLock] rearmed tile ${tileId} for token ${tokenId}`);
        }
      }
    }

    // Commit presence: all tiles token is now on (including locked ones for exit tracking)
    for (const tileId of nowOnIds) onTile.add(tileId);

    return entered;
  }

  // ── updateToken — teleport-arrival handler only ──────────────────────────────
  // Exploration enter-detection is now driven by the PIXI ticker (_startExploreWatch),
  // which reads token.center (visual position) every animation frame.
  // This hook only handles teleporter-caused jumps (options.teleporter = true):
  //   • Clears stale presence so the ticker re-evaluates from a clean state.
  //   • Locks the arrival tile so the destination pad can't immediately re-fire.

  Hooks.on("updateToken", (tokenDoc, changes, options) => {
    if (!options?.teleporter) return;
    if (!("x" in changes || "y" in changes)) return;

    // Rule 5: clear visual tracking — token just jumped to a new position.
    _tokenOnTile.delete(tokenDoc.id);

    // Rules 3 & 4: lock any teleporter tile the token just landed on.
    const arrC = tokenCenter(tokenDoc); // document position = teleport destination
    for (const entry of _getTileCache()) {
      const { rx, ry, rw, rh, tileDoc: td } = entry;
      if (arrC.x >= rx && arrC.x <= rx + rw && arrC.y >= ry && arrC.y <= ry + rh) {
        _lockDestTile(tokenDoc.id, td.id);
      }
    }
    hideTpHudButton();
  });

  // ── _runExploreDetect — called by the PIXI ticker every animation frame ──────
  // visCx/visCy: the token's current VISUAL center (from token.center, not tokenDoc.x/y).
  // This fires mid-animation, so the token's document position may differ from its
  // visual position (the slide hasn't arrived at the destination yet).

  function _runExploreDetect(tokenDoc, visCx, visCy) {
    const entered = _detectEnter(tokenDoc.id, visCx, visCy);

    // Hide button if token visually left the tile the button was shown for
    if (_hudBtnTile) {
      const onTile = _tokenOnTile.get(tokenDoc.id);
      if (!onTile?.has(_hudBtnTile.id)) hideTpHudButton();
    }

    if (entered.length === 0) return;

    const { tileDoc, rx, ry, rw, rh, confirmMode } = entered[0];
    console.debug(TAG, "[exploration] visual entered tile:", tileDoc.id);

    if (confirmMode) {
      // Button mode: only arm when the document position is also inside the tile.
      // This distinguishes "player stopped here" from "player walked through."
      // (With animate:true, tokenDoc.x/y = final destination — already known.)
      const docC = tokenCenter(tokenDoc);
      if (docC.x >= rx && docC.x <= rx + rw && docC.y >= ry && docC.y <= ry + rh) {
        showTpHudButton(tileDoc, tokenDoc);
      }
    } else {
      // Auto mode: fire the moment the visual center crosses the tile boundary,
      // regardless of where the final click destination is.
      hideTpHudButton();
      triggerTeleporter(tileDoc, tokenDoc, { applyDpOffset: false, forcedNodeId: null })
        .catch(e => console.error(TAG, "teleport error:", e));
    }
  }

  // Stop ticker and clean up button when scene unloads
  Hooks.on("canvasTearDown", () => {
    hideTpHudButton();
    _stopExploreWatch();
  });

  Hooks.once("ready", () => {
    console.debug(TAG, "Teleporter System loaded.");
    console.debug(TAG, "API: globalThis.TeleporterSystem.api");
  });
})();
