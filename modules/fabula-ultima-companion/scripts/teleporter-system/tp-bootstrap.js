// ============================================================================
// Teleporter System — Bootstrap & Movement Detection
//
// DUNGEON MODE ("dungeon"):
//   Hooks "dungeonPathing.turnEnd" which fires { tokenDoc, node }.
//   confirmMode=true → custom prompt box in the Save/Load skin (showTpPrompt,
//   plain DOM — not a Foundry Dialog) with smart text:
//     same-scene  → "Go to next Area?"
//     cross-scene → "Enter <navName>?" or "Enter Area?"
//   confirmMode=false → teleport immediately after turn end.
//
// EXPLORATION MODE ("exploration"):
//   Hooks "updateToken".  Runs on ALL clients (players + GM).
//   confirmMode=true  → floating 🚪 button above the token while on the tile.
//                        confirmDialog on (default) → clicking the button opens
//                        the same "Enter <navName>?" dialog as dungeon mode.
//                        confirmDialog off → the button click teleports at once.
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
  text-shadow: 0 0 8px rgba(200,160,255,.8);
  transition: filter .12s ease;
  /* animation is applied dynamically — see showTpHudButton / hideTpHudButton */
}
#oni-tp-hud-btn:hover  { filter: brightness(1.25); border-color: rgba(200,140,255,.9); }
#oni-tp-hud-btn:active { transform: translate(-50%,-100%) scale(.91); }
@keyframes oni-tp-btn-in {
  from { opacity: 0; transform: translate(-50%, -100%) scale(0.45); }
  to   { opacity: 1; transform: translate(-50%, -100%) scale(1); }
}
@keyframes oni-tp-btn-out {
  from { opacity: 1; transform: translate(-50%, -100%) scale(1); }
  to   { opacity: 0; transform: translate(-50%, -100%) scale(0.45); }
}
@keyframes oni-tp-btn-pulse {
  0%,100% { box-shadow: 0 0 10px rgba(160,100,255,.4), 0 4px 14px rgba(0,0,0,.5); }
  50%     { box-shadow: 0 0 24px rgba(190,130,255,.75), 0 4px 18px rgba(0,0,0,.55); }
}

/* ── Teleporter prompt box ──
   Same skin as the Save/Load confirm panel (save-ui.js .ss-conf-inner /
   .ss-choice-btn): ruled parchment, thin gold border with a wood ring,
   dark-wood choice buttons, feather cursor. Lettering is Signika, as in the
   Healing and Shop windows (the save screens' monospace read as awkward here).
   Layout: message panel with Yes / No hanging off the bottom-right corner. */
#oni-tp-prompt {
  position: fixed;
  left: 50%;
  top: 42%;
  z-index: 9995;
  box-sizing: border-box;
  min-width: 420px;
  max-width: min(820px, 90vw);
  padding: 30px 46px 40px;
  border: 2px solid #c9a44a;
  border-radius: 14px;
  background: linear-gradient(168deg, #f8f0d4 0%, #ede0b0 100%);
  box-shadow: 0 0 0 2px #7a4e20, 0 0 0 4px #b8865a, 0 0 28px rgba(0,0,0,0.40), inset 0 1px 0 rgba(255,245,200,0.70);
  font-family: "Signika","Noto Sans","Segoe UI",sans-serif;
  color: #3a1e06;
  user-select: none;
  pointer-events: auto;
  opacity: 0;
  transform: translate(-50%, calc(-50% + 26px));
  transition: opacity 360ms cubic-bezier(.25,.46,.45,.94),
              transform 360ms cubic-bezier(.25,.46,.45,.94);
}
/* faint ruled lines, as on the save screens */
#oni-tp-prompt::before {
  content: ''; position: absolute; inset: 0; pointer-events: none; border-radius: 12px;
  background: repeating-linear-gradient(0deg, transparent, transparent 23px, rgba(140,90,30,0.04) 23px, rgba(140,90,30,0.04) 24px);
}
#oni-tp-prompt.tp-visible {
  opacity: 1;
  transform: translate(-50%, -50%);
}
#oni-tp-prompt.tp-leaving {
  opacity: 0;
  transform: translate(-50%, calc(-50% - 20px));
  transition: opacity 280ms cubic-bezier(.55,.085,.68,.53),
              transform 280ms cubic-bezier(.55,.085,.68,.53);
  pointer-events: none;
}
#oni-tp-prompt .oni-tp-msg {
  position: relative;
  margin: 0;
  padding: 0;
  text-align: center;
  font-size: 20px;
  font-weight: 700;
  line-height: 1.5;
  letter-spacing: .4px;
  color: #3a1e06;
}
/* Yes / No hang off the bottom-right corner */
#oni-tp-prompt .oni-tp-actions {
  position: absolute;
  right: 18px;
  bottom: -22px;
  display: flex;
  gap: 12px;
}
#oni-tp-prompt .oni-tp-choice {
  position: relative;
  box-sizing: border-box;
  min-width: 112px;
  height: 40px;
  margin: 0;
  padding: 0 26px;
  border: 1px solid #9b7040;
  border-radius: 8px;
  background: linear-gradient(180deg, #7a5230 0%, #5c3818 100%);
  color: #f4e8c0;
  font-family: inherit;
  font-size: 16px;
  font-weight: 700;
  line-height: 1;
  letter-spacing: 1px;
  cursor: pointer;
  box-shadow: 0 2px 6px rgba(40,18,4,0.38), inset 0 1px 0 rgba(255,225,140,0.14);
  transition: border-color .12s, color .12s, background .12s, box-shadow .12s;
}
#oni-tp-prompt .oni-tp-choice:focus { outline: none; }
#oni-tp-prompt .oni-tp-choice.is-picked {
  border-color: #c9a22a; color: #fff8e0;
  background: linear-gradient(180deg, #9b6840 0%, #7a4a22 100%);
  box-shadow: 0 0 18px rgba(201,162,42,0.28), 0 2px 6px rgba(40,18,4,0.38), inset 0 1px 0 rgba(255,225,140,0.22);
}
#oni-tp-prompt .oni-tp-choice.no.is-picked {
  border-color: #8b3820; color: #ffd0c0;
  background: linear-gradient(180deg, #7a2e18 0%, #5a1c08 100%);
  box-shadow: 0 0 18px rgba(180,52,28,0.28), 0 2px 6px rgba(40,18,4,0.38);
}
/* Feather cursor — the same icon the other system UIs use — rides the picked button */
#oni-tp-prompt .oni-tp-feather {
  position: absolute;
  right: -16px;
  top: -34px;
  width: 46px;
  height: 46px;
  pointer-events: none;
  border: none !important; outline: none !important;
  box-shadow: none !important; background: transparent !important;
  filter: drop-shadow(0 2px 2px rgba(0,0,0,.35));
  animation: oni-tp-feather-float 2.2s ease-in-out infinite;
}
@keyframes oni-tp-feather-float {
  0%,100% { transform: translateY(0); }
  50%     { transform: translateY(-5px); }
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
  let _promptTileId = null; // exploration: tile whose "Enter X?" prompt is open

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

    // Ease-in: fade + scale up, then chain to idle pulse
    btn.style.animation = 'oni-tp-btn-in 0.18s ease-out forwards';
    btn.addEventListener('animationend', () => {
      if (_hudBtn === btn) btn.style.animation = 'oni-tp-btn-pulse 1.8s ease-in-out infinite';
    }, { once: true });

    _hudBtn      = btn;
    _hudBtnTile  = tileDoc;
    _hudBtnToken = tokenDoc;

    // Immediately position before the first RAF so there's no single-frame misplace
    _positionHudBtn(btn, tokenDoc);

    // Click → "Enter X?" dialog when the tile's confirmDialog is on (default),
    // otherwise teleport immediately (the button IS the confirmation).
    btn.addEventListener("pointerdown", async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const tile  = _hudBtnTile;
      const token = _hudBtnToken;
      hideTpHudButton();
      if (!tile || !token) return;

      const flags = getFlags(tile);
      const wantsDialog = flags?.confirmDialog !== false && flags?.confirmDialog !== "false";
      if (wantsDialog && flags?.destination) {
        _promptTileId = tile.id;
        const confirmed = await askTeleportConfirm(flags.destination);
        _promptTileId = null;
        if (!confirmed) {
          // Declined: bring the button back if the token is still standing on the tile.
          if (!_hudBtn && _tokenOnTile.get(token.id)?.has(tile.id)) showTpHudButton(tile, token);
          return;
        }
      }
      await triggerTeleporter(tile, token, { applyDpOffset: false, forcedNodeId: null });
    });

    // RAF loop: re-position every frame while camera is moving to follow the token
    function track() {
      if (_hudBtn !== btn) return;
      _positionHudBtn(btn, tokenDoc);
      _hudBtnRaf = requestAnimationFrame(track);
    }
    _hudBtnRaf = requestAnimationFrame(track);
  }

  function hideTpHudButton(animate = false) {
    if (_hudBtnRaf) { cancelAnimationFrame(_hudBtnRaf); _hudBtnRaf = null; }
    const btn = _hudBtn;
    _hudBtn      = null;
    _hudBtnTile  = null;
    _hudBtnToken = null;
    if (!btn) return;
    if (animate) {
      // Ease-out: fade + scale down, then remove from DOM
      btn.style.animation    = 'oni-tp-btn-out 0.15s ease-in forwards';
      btn.style.pointerEvents = 'none';
      btn.addEventListener('animationend', () => btn.remove(), { once: true });
    } else {
      btn.remove();
    }
  }

  // ── Confirmation dialog — parchment/JRPG themed with smart text ──────────────
  // Shared by dungeon mode (on turn end) and exploration mode (after the button).

  async function askTeleportConfirm(destination) {
    const currentSceneId = canvas?.scene?.id;
    const isCrossScene   = destination?.sceneId && destination.sceneId !== currentSceneId;

    let promptText;
    if (isCrossScene) {
      const destScene = game.scenes.get(destination.sceneId);
      const navName   = destScene?.navName?.trim()
        || destScene?.flags?.[MODULE_ID]?.oniFabula?.general?.navigationName?.trim?.()
        || null;
      promptText = navName ? `Enter ${navName}?` : "Enter Area?";
    } else {
      promptText = "Go to next Area?";
    }

    return showTpPrompt(promptText);
  }

  // ── Custom prompt box ─────────────────────────────────────────────────────────
  // One prompt at a time. Resolves true (Yes / Enter) or false (No / Esc /
  // closed from outside, e.g. the token walked off the tile or the scene changed).

  const TP_FEATHER_URL = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/feather.png";
  const TP_PROMPT_OUT_MS = 280; // keep in step with #oni-tp-prompt.tp-leaving
  let _tpPrompt = null;         // { el, finish }

  function closeTpPrompt(result = false) {
    _tpPrompt?.finish(result);
  }

  function showTpPrompt(text) {
    closeTpPrompt(false);
    ensureStyle();

    return new Promise((resolve) => {
      const el = document.createElement("div");
      el.id = "oni-tp-prompt";
      el.setAttribute("role", "dialog");
      el.innerHTML = `
        <p class="oni-tp-msg"></p>
        <div class="oni-tp-actions">
          <button type="button" class="oni-tp-choice yes">Yes</button>
          <button type="button" class="oni-tp-choice no">No</button>
        </div>`;
      el.querySelector(".oni-tp-msg").textContent = text;

      const yesBtn = el.querySelector(".yes");
      const noBtn  = el.querySelector(".no");
      const feather = document.createElement("img");
      feather.className = "oni-tp-feather";
      feather.src = TP_FEATHER_URL;
      feather.alt = "";

      // The feather marks the picked answer: hover or ←/→ moves it, Enter takes it.
      let picked = null;
      const pick = (btn) => {
        if (picked === btn) return;
        picked?.classList.remove("is-picked");
        picked = btn;
        btn.classList.add("is-picked");
        btn.appendChild(feather);
      };

      const entry = { el, finish: null };
      const onKey = (ev) => {
        // Leave typing alone (chat box, sheet fields) — Enter there must not teleport.
        if (ev.target?.closest?.("input, textarea, select, [contenteditable='true']")) return;
        let handled = true;
        if (ev.key === "Escape")                                entry.finish(false);
        else if (ev.key === "Enter" || ev.key === " ")          entry.finish(picked === yesBtn);
        else if (ev.key === "ArrowLeft"  || ev.key === "a" || ev.key === "A") pick(yesBtn);
        else if (ev.key === "ArrowRight" || ev.key === "d" || ev.key === "D") pick(noBtn);
        else handled = false;
        if (handled) { ev.preventDefault(); ev.stopPropagation(); }
      };
      entry.finish = (result) => {
        if (_tpPrompt !== entry) return;   // already finished
        _tpPrompt = null;
        window.removeEventListener("keydown", onKey, true);
        el.classList.remove("tp-visible");
        el.classList.add("tp-leaving");
        setTimeout(() => el.remove(), TP_PROMPT_OUT_MS + 40);
        resolve(result === true);
      };

      // pointerdown is swallowed so the click never reaches the canvas underneath
      el.addEventListener("pointerdown", (ev) => ev.stopPropagation());
      yesBtn.addEventListener("pointerenter", () => pick(yesBtn));
      noBtn.addEventListener("pointerenter",  () => pick(noBtn));
      yesBtn.addEventListener("click", () => entry.finish(true));
      noBtn.addEventListener("click",  () => entry.finish(false));
      window.addEventListener("keydown", onKey, true);

      pick(yesBtn);
      document.body.appendChild(el);
      _tpPrompt = entry;
      // Two frames so the starting (hidden, offset) state is painted before the transition.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (_tpPrompt === entry) el.classList.add("tp-visible");
      }));
    });
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
      const confirmed = await askTeleportConfirm(flags.destination);
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
      if (!onTile?.has(_hudBtnTile.id)) hideTpHudButton(true); // animated exit
    }
    // Walked off the tile with the prompt still open → treat as "No"
    if (_promptTileId && !_tokenOnTile.get(tokenDoc.id)?.has(_promptTileId)) closeTpPrompt(false);

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
    closeTpPrompt(false);
    hideTpHudButton();
    _stopExploreWatch();
  });

  Hooks.once("ready", () => {
    console.debug(TAG, "Teleporter System loaded.");
    console.debug(TAG, "API: globalThis.TeleporterSystem.api");
  });
})();
