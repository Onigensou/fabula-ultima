// ============================================================================
// Dungeon Pathing System — Fast Travel Mode
//
// Lets the Main Controller teleport the party token to any previously-visited
// landmark tile (Camp, Event, Story, Final Story).
//
// Flow:
//   1. Controller clicks 🦅  → enter() checks controller status + visited nodes
//   2. Hand-cursor sprites appear on eligible tiles; left/right nav arrows appear
//   3. All client viewports follow the controller's navigation via game.socket
//   4. Controller clicks a tile → "Travel here?" Dialog.confirm
//   5. On confirm → token teleports (via GM socket), FT mode exits, graph rebuilds
//
// Exiting (ESC / button click / deactivate) snaps all viewports back to token.
// Reset Dungeon also clears visited state, removing FT eligibility.
// ============================================================================
(() => {
  const DP        = globalThis.DungeonPathing ??= {};
  const MODULE_ID = "fabula-ultima-companion";
  const TAG       = "[DungeonPathing][FastTravel]";

  // Tile types eligible for fast travel
  const FT_TYPES = new Set([
    "camp", "event", "story", "final",
  ]);

  // ── Socket broadcast ─────────────────────────────────────────────────────────
  const SOCKET_CH    = `module.${MODULE_ID}`;
  const MSG_ENTER    = "DP_FT_ENTER";
  const MSG_PAN      = "DP_FT_PAN";
  const MSG_EXIT     = "DP_FT_EXIT";
  const SOCKET_GUARD = "__ONI_DP_FT_SOCKET__";

  function setupSocketListener() {
    if (window[SOCKET_GUARD]) return;
    window[SOCKET_GUARD] = true;

    game.socket.on(SOCKET_CH, (msg) => {
      if (msg?.type !== MSG_ENTER && msg?.type !== MSG_PAN && msg?.type !== MSG_EXIT) return;
      // Ignore our own broadcasts (we are the controller driving these)
      if (_active && _isController) return;

      if (msg.type === MSG_ENTER) {
        // Non-controller: free the camera so animatePan works without ticker fighting
        DP.ScanMode?.detachTicker?.();
        return;
      }
      if (msg.type === MSG_PAN) {
        const { x, y } = msg.payload ?? {};
        if (canvas?.ready && x != null && y != null) canvas.animatePan({ x, y, duration: 500 });
        return;
      }
      if (msg.type === MSG_EXIT) {
        // Non-controller: re-engage camera lock and snap back to party token
        DP.ScanMode?.attachTicker?.();
        DP.ScanMode?.snapCameraToToken?.();
        return;
      }
    });

    console.debug(TAG, "Socket listener installed.");
  }

  function broadcastEnter() {
    game.socket.emit(SOCKET_CH, { type: MSG_ENTER, payload: {} });
  }
  function broadcastPan(x, y) {
    game.socket.emit(SOCKET_CH, { type: MSG_PAN, payload: { x, y } });
  }
  function broadcastExit() {
    game.socket.emit(SOCKET_CH, { type: MSG_EXIT, payload: {} });
  }

  // ── State ────────────────────────────────────────────────────────────────────
  let _active       = false;
  let _isController = false;
  let _eligible     = [];   // node-like objects { nodeId, name, tileType, center, bounds }
  let _focusedIdx   = 0;
  let _container    = null; // PIXI container with cursor sprites
  let _leftBtn      = null; // DOM ◀ button
  let _rightBtn     = null; // DOM ▶ button
  let _escHandler   = null;
  let _clickHandler = null;

  // ── Build eligible node list ─────────────────────────────────────────────────
  // Scans all tiles in the current scene for FT-eligible initial type + visited.
  function resolveEligibleNodes() {
    const scene = canvas?.scene;
    if (!scene) return [];

    const result = [];
    for (const tileDoc of (scene.tiles?.contents ?? [])) {
      const tileId      = tileDoc.id;
      const initialType = DP.TileState?.getInitialType(scene, tileId) ?? "";
      if (!FT_TYPES.has(initialType)) continue;
      if (!DP.TileState?.isVisited(scene, tileId)) continue;

      const x = Number(tileDoc.x ?? 0);
      const y = Number(tileDoc.y ?? 0);
      const w = Number(tileDoc.width  ?? canvas?.grid?.size ?? 100);
      const h = Number(tileDoc.height ?? canvas?.grid?.size ?? 100);

      result.push({
        nodeId:   tileId,
        name:     tileDoc.name || initialType,
        tileType: initialType,
        center:   { x: x + w / 2, y: y + h / 2 },
        bounds:   { left: x, right: x + w, top: y, bottom: y + h },
      });
    }
    return result;
  }

  // ── PIXI sprites on eligible tiles ───────────────────────────────────────────
  let _texture = null;

  async function ensureTexture() {
    if (_texture) return _texture;
    try { _texture = await loadTexture(DP.HAND_CURSOR_URL); } catch { _texture = null; }
    return _texture;
  }

  async function showSprites(nodes) {
    hideSprites();
    if (!nodes?.length || !canvas?.stage) return;

    const tex  = await ensureTexture();
    const cfg  = DP.UI?.CURSOR ?? { SIZE: 36, EDGE_INSET: 0.35 };
    const root = new PIXI.Container();
    root.name   = "ONI DungeonPathing FastTravel";
    root.zIndex = 999997;

    for (const node of nodes) {
      const sprite = tex ? new PIXI.Sprite(tex) : buildFallback();
      if (tex) {
        sprite.width  = cfg.SIZE * 1.2;
        sprite.height = cfg.SIZE * 1.2;
        sprite.anchor.set(0.5, 0.5);
        sprite.tint   = 0xffd966; // golden tint distinguishes from helper mode
      }
      sprite.x = node.center.x;
      sprite.y = node.center.y;
      root.addChild(sprite);
    }

    try {
      canvas.stage.sortableChildren = true;
      canvas.stage.addChild(root);
    } catch {}
    _container = root;
  }

  function buildFallback() {
    const g = new PIXI.Graphics();
    g.beginFill(0xffd966, 0.85);
    g.drawCircle(0, 0, 14);
    g.endFill();
    return g;
  }

  function hideSprites() {
    try { _container?.destroy({ children: true }); } catch {}
    _container = null;
  }

  // ── Navigation arrow buttons ─────────────────────────────────────────────────
  const STYLE_ID = "oni-dp-ft-styles";

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
.oni-dp-ft-nav {
  position: fixed;
  z-index: 99999;
  top: 50%;
  transform: translateY(-50%);
  width: 48px;
  height: 80px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  cursor: pointer;
  user-select: none;
  pointer-events: auto;
  font-size: 28px;
  color: #e8c870;
  background: radial-gradient(circle at 40% 35%,
    rgba(90,65,30,0.92) 0%,
    rgba(45,32,14,0.96) 100%);
  border: 2px solid rgba(200,160,80,0.65);
  box-shadow: 0 0 14px rgba(0,0,0,0.55);
  text-shadow: 0 0 8px rgba(0,0,0,0.9);
  opacity: 0;
  transition: opacity 250ms ease, filter 180ms ease;
}
.oni-dp-ft-nav.ft-visible { opacity: 1; }
.oni-dp-ft-nav:hover  { filter: brightness(1.2); }
.oni-dp-ft-nav:active { filter: brightness(0.9); }
.oni-dp-ft-nav-left  { left: 10px; }
.oni-dp-ft-nav-right { right: 10px; }
    `;
    document.head.appendChild(s);
  }

  function showNavButtons() {
    ensureStyles();
    if (_leftBtn || _rightBtn) return;

    _leftBtn = document.createElement("div");
    _leftBtn.className = "oni-dp-ft-nav oni-dp-ft-nav-left";
    _leftBtn.title = "Previous landmark";
    _leftBtn.innerHTML = "&#9664;"; // ◀
    _leftBtn.addEventListener("pointerdown", (ev) => {
      ev.stopPropagation(); ev.preventDefault();
      navigate(-1);
    });

    _rightBtn = document.createElement("div");
    _rightBtn.className = "oni-dp-ft-nav oni-dp-ft-nav-right";
    _rightBtn.title = "Next landmark";
    _rightBtn.innerHTML = "&#9654;"; // ▶
    _rightBtn.addEventListener("pointerdown", (ev) => {
      ev.stopPropagation(); ev.preventDefault();
      navigate(1);
    });

    document.body.appendChild(_leftBtn);
    document.body.appendChild(_rightBtn);
    requestAnimationFrame(() => {
      _leftBtn?.classList.add("ft-visible");
      _rightBtn?.classList.add("ft-visible");
    });
  }

  function hideNavButtons() {
    for (const btn of [_leftBtn, _rightBtn]) {
      if (!btn) continue;
      btn.classList.remove("ft-visible");
      setTimeout(() => btn.remove(), 280);
    }
    _leftBtn = _rightBtn = null;
  }

  // ── Navigation logic ─────────────────────────────────────────────────────────
  function navigate(delta) {
    if (!_eligible.length) return;
    _focusedIdx = ((_focusedIdx + delta) % _eligible.length + _eligible.length) % _eligible.length;
    panToFocused();
  }

  function panToFocused() {
    const node = _eligible[_focusedIdx];
    if (!node) return;
    const { x, y } = node.center;
    canvas?.animatePan?.({ x, y, duration: 500 });
    broadcastPan(x, y);
  }

  // ── Canvas click handler ─────────────────────────────────────────────────────
  function getCanvasView() {
    return canvas?.app?.view ?? canvas?.app?.renderer?.view
      ?? document.querySelector("#board canvas") ?? document.querySelector("canvas");
  }

  function installClickListener() {
    if (_clickHandler) return;
    const view = getCanvasView();
    if (!view) return;

    _clickHandler = (ev) => {
      if (!_active || ev.button !== 0) return;
      ev.preventDefault();
      ev.stopPropagation();

      const worldPt = DP.Graph?.clientToWorld?.(ev.clientX, ev.clientY);
      if (!worldPt) return;

      let clicked = null;
      for (const node of _eligible) {
        const b = node.bounds;
        if (worldPt.x >= b.left && worldPt.x <= b.right &&
            worldPt.y >= b.top  && worldPt.y <= b.bottom) {
          clicked = node;
          break;
        }
      }
      if (!clicked) return;

      promptTravel(clicked).catch(e => console.error(TAG, "promptTravel failed:", e));
    };

    view.addEventListener("pointerdown", _clickHandler, true);
  }

  function removeClickListener() {
    try {
      const view = getCanvasView();
      if (view && _clickHandler) view.removeEventListener("pointerdown", _clickHandler, true);
    } catch {}
    _clickHandler = null;
  }

  // ── Travel confirmation + teleport ────────────────────────────────────────────
  async function promptTravel(node) {
    const label = node.name || node.tileType || "this location";
    const confirmed = await Dialog.confirm({
      title: "Fast Travel",
      content: `<p style="text-align:center;padding:8px;">Travel to <b>${label}</b>?</p>`,
    });
    if (!confirmed) return;
    await teleportTo(node);
  }

  async function teleportTo(node) {
    const dpState = globalThis.__ONI_DUNGEON_PATHING__?.state ?? null;
    const token   = dpState?.partyToken ?? null;
    if (!token) { console.warn(TAG, "No party token for teleport."); return; }

    const gSize = Number(canvas?.grid?.size ?? 100) || 100;
    const offX  = Number(DP.UI?.TOKEN_OFFSET?.x ?? 0);
    const offY  = Number(DP.UI?.TOKEN_OFFSET?.y ?? 0);
    const tw    = Number(token.document?.width  ?? 1) * gSize;
    const th    = Number(token.document?.height ?? 1) * gSize;

    const targetX = node.center.x - tw / 2 + offX;
    const targetY = node.center.y - th / 2 + offY;

    await DP.Socket.fastTravelTeleport(canvas.scene, token.document.id, targetX, targetY);

    exit();

    // Rebuild graph after teleport so neighbors are updated for the new position
    setTimeout(() => {
      globalThis.__ONI_DUNGEON_PATHING__?.rebuild?.().catch(() => {});
    }, 250);
  }

  // ── ESC key ───────────────────────────────────────────────────────────────────
  function installEsc() {
    if (_escHandler) return;
    _escHandler = (ev) => {
      if (!_active || ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      exit();
    };
    window.addEventListener("keydown", _escHandler, true);
  }

  function removeEsc() {
    if (_escHandler) window.removeEventListener("keydown", _escHandler, true);
    _escHandler = null;
  }

  // ── Enter / Exit ──────────────────────────────────────────────────────────────
  async function enter() {
    if (_active) return;

    // Only the Main Controller can use Fast Travel
    const api = globalThis.__ONI_MOVEMENT_CONTROL_API__;
    if (!api?.isCurrentUserMainController) {
      ui.notifications?.warn?.("Movement Control system not ready.");
      return;
    }
    const isController = await api.isCurrentUserMainController();
    if (!isController) {
      ui.notifications?.warn?.("Fast Travel is only available to the Main Controller.");
      return;
    }

    _eligible = resolveEligibleNodes();
    if (!_eligible.length) {
      ui.notifications?.info?.("No visited landmarks to travel to. Explore the dungeon first!");
      return;
    }

    _active       = true;
    _isController = true;
    _focusedIdx   = 0;

    DP.Sound?.playFastTravelOpen?.();
    broadcastEnter();

    // Free our own camera from the scan ticker so we can pan freely
    DP.ScanMode?.detachTicker?.();
    // Also exit scan mode if it was on (clamp would fight FT panning)
    if (DP.ScanMode?.active) DP.ScanMode?.exitScan?.();

    await showSprites(_eligible);
    showNavButtons();
    installClickListener();
    installEsc();

    // Pan immediately to first eligible tile and sync all viewports
    panToFocused();

    DP.ScanMode?.syncFtBtn?.();
    console.debug(TAG, `Fast Travel active — ${_eligible.length} eligible landmark(s).`);
  }

  function exit() {
    if (!_active) return;
    _active       = false;
    _isController = false;

    DP.Sound?.playFastTravelClose?.();

    hideSprites();
    hideNavButtons();
    removeClickListener();
    removeEsc();

    broadcastExit();

    // Re-engage camera lock and snap back to party token
    DP.ScanMode?.attachTicker?.();
    DP.ScanMode?.snapCameraToToken?.();

    DP.ScanMode?.syncFtBtn?.();
    console.debug(TAG, "Fast Travel exited.");
  }

  function toggle() {
    if (_active) exit();
    else         enter().catch(e => console.error(TAG, "enter failed:", e));
  }

  // ── Public API ────────────────────────────────────────────────────────────────
  DP.FastTravel = {
    get active() { return _active; },
    enter,
    exit,
    toggle,
  };

  Hooks.once("ready", () => {
    setupSocketListener();
    console.debug(TAG, "Fast Travel System loaded.");
  });
})();
