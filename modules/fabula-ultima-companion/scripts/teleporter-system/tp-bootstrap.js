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

  // ── Cooldown (loop safeguard) ─────────────────────────────────────────────────
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

  // ── Cached db actor ID for sync check ────────────────────────────────────────
  let _cachedDbActorId = null;

  async function warmDbCache() {
    try {
      const res = await window.FUCompanion?.api?.getCurrentGameDb?.();
      _cachedDbActorId = res?.db?.id ?? null;
    } catch {
      _cachedDbActorId = null;
    }
  }

  Hooks.once("ready", () => {
    ensureStyle();
    warmDbCache();
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

  function teleporterTileAt(worldX, worldY, scene) {
    const sc = scene ?? canvas?.scene;
    for (const tileDoc of (sc?.tiles ?? [])) {
      if (!isTeleporterEnabled(tileDoc)) continue;
      if (worldX >= tileDoc.x && worldX <= tileDoc.x + tileDoc.width &&
          worldY >= tileDoc.y && worldY <= tileDoc.y + tileDoc.height) {
        return tileDoc;
      }
    }
    return null;
  }

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

  // ── EXPLORATION MODE — hook on updateToken ────────────────────────────────────
  // Runs on ALL clients (players + GM) so the floating button appears for whoever
  // controls/views the party token.  The actual teleport execution routes through
  // GM automatically via sameSceneTeleport's socket path.

  let _exploreTimer = null;

  Hooks.on("updateToken", (tokenDoc, changes, options) => {
    // Teleport arrival: hide button and stop (options.teleporter propagates to all clients)
    if (options?.teleporter) { hideTpHudButton(); return; }
    if (!("x" in changes || "y" in changes)) return;

    const mode = getSceneMode();
    if (mode === "none")    return;
    if (mode === "dungeon") return; // dungeon handled via turnEnd

    // Synchronous db actor check (cached) — skip non-party-token moves
    if (_cachedDbActorId !== null && tokenDoc.actorId !== _cachedDbActorId) return;

    // Quick-hide: if the HUD is showing for this token and it just moved,
    // check immediately whether it left the tile so the button doesn't linger.
    if (_hudBtnToken?.id === tokenDoc.id && _hudBtnTile) {
      const tile   = _hudBtnTile;
      const gSize  = canvas?.grid?.size ?? 100;
      const newX   = "x" in changes ? changes.x : tokenDoc.x;
      const newY   = "y" in changes ? changes.y : tokenDoc.y;
      const cx     = newX + (tokenDoc.width  ?? 1) * gSize / 2;
      const cy     = newY + (tokenDoc.height ?? 1) * gSize / 2;
      const onTile = cx >= tile.x && cx <= tile.x + tile.width &&
                     cy >= tile.y && cy <= tile.y + tile.height;
      if (!onTile) hideTpHudButton();
    }

    // Debounce: token animate/drag fires rapid updates; wait for it to settle
    if (_exploreTimer) clearTimeout(_exploreTimer);
    _exploreTimer = setTimeout(() => {
      _exploreTimer = null;
      handleExplorationUpdate(tokenDoc).catch(e => console.warn(TAG, "exploration error:", e));
    }, 250);
  });

  async function handleExplorationUpdate(tokenDoc) {
    if (isOnCooldown(tokenDoc)) { hideTpHudButton(); return; }

    // Async cache miss fallback (only runs when cache is cold)
    if (_cachedDbActorId === null) {
      await warmDbCache();
      if (_cachedDbActorId !== null && tokenDoc.actorId !== _cachedDbActorId) return;
    }

    const center  = tokenCenter(tokenDoc);
    const tileDoc = teleporterTileAt(center.x, center.y);

    if (!tileDoc) {
      hideTpHudButton();
      return;
    }

    console.debug(TAG, "[exploration] hit teleporter tile:", tileDoc.id, "center:", center);

    const flags       = getFlags(tileDoc);
    const confirmMode = flags?.confirmMode !== false && flags?.confirmMode !== "false";

    if (confirmMode) {
      // Show the 🚪 button — clicking it IS the confirmation
      showTpHudButton(tileDoc, tokenDoc);
    } else {
      // confirmMode=false: teleport immediately, no button
      hideTpHudButton();
      await triggerTeleporter(tileDoc, tokenDoc, { applyDpOffset: false, forcedNodeId: null });
    }
  }

  // Clean up button when the canvas is torn down (scene change, reload)
  Hooks.on("canvasTearDown", () => hideTpHudButton());

  Hooks.once("ready", () => {
    console.debug(TAG, "Teleporter System loaded.");
    console.debug(TAG, "API: globalThis.TeleporterSystem.api");
  });
})();
