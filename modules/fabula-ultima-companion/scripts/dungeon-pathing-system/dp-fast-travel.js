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

  // Default eligible tile types — used only when the per-tile
  // eligibleForFastTravel flag has not been explicitly set.
  const FT_TYPES = new Set(["camp", "event", "story", "final"]);

  // ── Socket broadcast ─────────────────────────────────────────────────────────
  const SOCKET_CH    = `module.${MODULE_ID}`;
  const MSG_ENTER    = "DP_FT_ENTER";
  const MSG_PAN      = "DP_FT_PAN";
  const MSG_EXIT     = "DP_FT_EXIT";
  const MSG_FT_ANIM  = "DP_FT_ANIM";

  const GRYPHON_URL    = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Beastiary/Gryphon/Gryphon_Standard.webm";
  const ANIM_SWOOP_MS  = 800;
  const ANIM_FLYOUT_MS = 700;

  const SOCKET_GUARD = "__ONI_DP_FT_SOCKET__";

  function setupSocketListener() {
    if (window[SOCKET_GUARD]) return;
    window[SOCKET_GUARD] = true;

    game.socket.on(SOCKET_CH, (msg) => {
      if (msg?.type !== MSG_ENTER && msg?.type !== MSG_PAN && msg?.type !== MSG_EXIT && msg?.type !== MSG_FT_ANIM) return;
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
      if (msg.type === MSG_FT_ANIM) {
        const dpState = globalThis.__ONI_DUNGEON_PATHING__?.state ?? null;
        const tkn = dpState?.partyToken ?? null;
        if (tkn) {
          (DP.Sound?.playFastTravelEagle?.() ?? Promise.resolve())
            .catch(() => {})
            .then(() => runGryphonAnimation(tkn, { waitForUpdate: true }))
            .catch(() => { showMesh(tkn); });
        }
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
  let _traveling    = false;   // true while a teleport sequence is in progress
  let _eligible     = [];   // node-like objects { nodeId, name, tileType, center, bounds }
  let _focusedIdx   = 0;
  let _container    = null; // PIXI container with cursor sprites
  let _leftBtn      = null; // DOM ◀ button
  let _rightBtn     = null; // DOM ▶ button
  let _escHandler    = null;
  let _clickHandler  = null;
  let _wheelHandler  = null;

  // Gryphon texture cache — loaded once, shared across FT triggers
  let _gryphonTex  = null;
  let _gryphonNatW = 0;
  let _gryphonNatH = 0;

  // ── Animation helpers ────────────────────────────────────────────────────────
  function easeInOut(t) {
    return t < 0.5 ? 2*t*t : -1 + (4 - 2*t)*t;
  }

  function tween(fromX, toX, fromY, toY, durationMs, onFrame) {
    return new Promise(resolve => {
      const start = performance.now();
      let done = false;

      // Safety net: if rAF is throttled (minimised window, background tab),
      // snap to the final frame and resolve so the animation chain never stalls.
      const safetyTimer = setTimeout(() => {
        if (done) return;
        done = true;
        onFrame(toX, toY);
        resolve();
      }, durationMs + 300);

      function tick() {
        if (done) return;
        const elapsed = Math.min(performance.now() - start, durationMs);
        const t = easeInOut(elapsed / durationMs);
        onFrame(fromX + (toX - fromX) * t, fromY + (toY - fromY) * t);
        if (elapsed < durationMs) {
          requestAnimationFrame(tick);
        } else {
          done = true;
          clearTimeout(safetyTimer);
          resolve();
        }
      }
      requestAnimationFrame(tick);
    });
  }

  async function ensureGryphonTexture() {
    if (_gryphonTex) return _gryphonTex;

    return new Promise((resolve) => {
      const video = document.createElement("video");
      video.src = GRYPHON_URL;
      video.loop = true;
      video.muted = true;
      video.crossOrigin = "anonymous";
      video.style.cssText = "position:absolute;width:0;height:0;opacity:0;pointer-events:none;";
      document.body.appendChild(video);

      let resolved = false;
      function onReady() {
        if (resolved) return; resolved = true;
        video.play().catch(() => {});
        _gryphonNatW = video.videoWidth  || 0;
        _gryphonNatH = video.videoHeight || 0;
        _gryphonTex  = PIXI.Texture.from(video);
        resolve(_gryphonTex);
      }

      if (video.readyState >= 2) { onReady(); return; }
      video.addEventListener("loadeddata", onReady, { once: true });
      video.load();
      setTimeout(onReady, 2000);
    });
  }

  // Hide/show token visually via mesh.alpha (PrimaryCanvasGroup) + container.alpha (nameplates etc.)
  function hideMesh(token) {
    if (!token) return;
    if (token.mesh) token.mesh.alpha = 0;
    token.alpha = 0;
  }

  function showMesh(token) {
    if (!token) return;
    if (token.mesh) token.mesh.alpha = 1;
    token.alpha = 1;
  }

  async function runDropOffAnimation(token, { refreshGuardId = null } = {}) {
    if (!canvas?.stage || !token) return;

    // Token must be invisible before the gryphon arrives
    hideMesh(token);

    const gSize   = Number(canvas?.grid?.size ?? 100) || 100;
    const docX    = Number(token.document?.x ?? 0);
    const docY    = Number(token.document?.y ?? 0);
    const docW    = Number(token.document?.width  ?? 1) * gSize;
    const docH    = Number(token.document?.height ?? 1) * gSize;
    const tokenCX = docX + docW / 2;
    const tokenCY = docY + docH / 2;

    const pivot  = canvas.stage.pivot;
    const scaleX = canvas.stage.scale.x || 1;
    const halfW  = canvas.app.renderer.width / scaleX / 2;

    const tex = await ensureGryphonTexture().catch(() => null);
    if (!tex) {
      if (refreshGuardId != null) Hooks.off("refreshToken", refreshGuardId);
      showMesh(token); return;
    }

    const natW    = _gryphonNatW || 480;
    const natH    = _gryphonNatH || 270;
    const spriteH = gSize * 2;
    const spriteW = spriteH * (natW / natH);

    const arrivedX = tokenCX - spriteW / 2;
    const arrivedY = tokenCY - spriteH / 2;
    const startX   = pivot.x - halfW - spriteW;
    const exitX    = pivot.x + halfW + spriteW;

    const sprite = new PIXI.Sprite(tex);
    sprite.width   = spriteW;
    sprite.height  = spriteH;
    sprite.scale.x *= -1; // flip horizontally (preserves scale magnitude from width setter)
    sprite.x       = startX + spriteW;
    sprite.y       = arrivedY;
    sprite.zIndex  = 999998;
    canvas.stage.sortableChildren = true;
    canvas.stage.addChild(sprite);

    DP.Sound?.playFastTravelWind?.();

    await tween(startX + spriteW, arrivedX + spriteW, arrivedY, arrivedY, ANIM_SWOOP_MS,
      (x, y) => { sprite.x = x; sprite.y = y; });

    await new Promise(r => setTimeout(r, 200));

    // Release the refreshToken guard, then reveal the token
    if (refreshGuardId != null) Hooks.off("refreshToken", refreshGuardId);
    showMesh(token);
    DP.Sound?.playFastTravelLand?.();
    await new Promise(r => setTimeout(r, 150));

    await tween(arrivedX + spriteW, exitX + spriteW, arrivedY, arrivedY, ANIM_FLYOUT_MS,
      (x, y) => { sprite.x = x; sprite.y = y; });

    try { canvas.stage.removeChild(sprite); } catch {}
    try { sprite.destroy({ texture: false }); } catch {}
  }

  async function runGryphonAnimation(token, { waitForUpdate = false } = {}) {
    if (!canvas?.stage || !token) return null;

    const gSize   = Number(canvas?.grid?.size ?? 100) || 100;
    const docX    = Number(token.document?.x ?? 0);
    const docY    = Number(token.document?.y ?? 0);
    const docW    = Number(token.document?.width  ?? 1) * gSize;
    const docH    = Number(token.document?.height ?? 1) * gSize;
    const tokenCX = docX + docW / 2;
    const tokenCY = docY + docH / 2;

    const pivot  = canvas.stage.pivot;
    const scaleX = canvas.stage.scale.x || 1;
    const halfW  = canvas.app.renderer.width / scaleX / 2;

    const tex = await ensureGryphonTexture().catch(() => null);
    if (!tex) return null;

    // Derive sprite size from natural video dimensions — no squash/stretch
    const natW    = _gryphonNatW || 480;
    const natH    = _gryphonNatH || 270;
    const spriteH = gSize * 2;
    const spriteW = spriteH * (natW / natH);

    const arrivedX = tokenCX - spriteW / 2;
    const arrivedY = tokenCY - spriteH / 2;
    const startX   = pivot.x - halfW - spriteW;
    const exitX    = pivot.x + halfW + spriteW;

    const sprite = new PIXI.Sprite(tex);
    sprite.width   = spriteW;
    sprite.height  = spriteH;
    sprite.scale.x *= -1; // flip horizontally (preserves scale magnitude from width setter)
    sprite.x       = startX + spriteW;
    sprite.y       = arrivedY;
    sprite.zIndex  = 999998;
    canvas.stage.sortableChildren = true;
    canvas.stage.addChild(sprite);

    DP.Sound?.playFastTravelWind?.();

    await tween(startX + spriteW, arrivedX + spriteW, arrivedY, arrivedY, ANIM_SWOOP_MS,
      (x, y) => { sprite.x = x; sprite.y = y; });

    await new Promise(r => setTimeout(r, 150));

    // Install refreshToken guard THEN hide — guard fires after _refreshAlpha() on every render
    // cycle and re-applies mesh.alpha=0, so Foundry's refresh pipeline can never undo our hide.
    const pickupGuardId = Hooks.on("refreshToken", (tp) => {
      if (tp !== token && tp.document?.actorId !== token.document?.actorId) return;
      if (tp.mesh) tp.mesh.alpha = 0;
    });
    hideMesh(token);

    await tween(arrivedX + spriteW, exitX + spriteW, arrivedY, arrivedY, ANIM_FLYOUT_MS,
      (x, y) => { sprite.x = x; sprite.y = y; });

    try { canvas.stage.removeChild(sprite); } catch {}
    try { sprite.destroy({ texture: false }); } catch {} // preserve shared texture

    if (waitForUpdate) {
      // Non-controller: hold token invisible until the position broadcast arrives,
      // so it appears at the new location rather than flashing at the old one.
      await new Promise(resolve => {
        let resolved = false;
        const timeout = setTimeout(() => {
          if (!resolved) { resolved = true; Hooks.off("updateToken", hId); resolve(); }
        }, 3000);
        const hId = Hooks.on("updateToken", (doc) => {
          if (doc.id !== token.document?.id) return;
          if (resolved) return;
          resolved = true;
          clearTimeout(timeout);
          Hooks.off("updateToken", hId);
          resolve();
        });
      });
      Hooks.off("refreshToken", pickupGuardId);
      showMesh(token);
      return null;
    }

    // Controller path: return token + guard so caller releases the guard after teleport
    return { token, pickupGuardId };
  }

  // ── Build eligible node list ─────────────────────────────────────────────────
  // Scans all tiles in the current scene for FT-eligible + visited tiles.
  // Eligibility is determined by the per-tile flag first, falling back to the
  // hardcoded FT_TYPES set for tiles that haven't been configured yet.
  function resolveEligibleNodes() {
    const scene = canvas?.scene;
    if (!scene) return [];

    const pathingKey = DP.PATHING_ROOT_KEY ?? "dungeonPathing";
    const tileDocs   = scene.tiles?.contents ?? [];
    const result     = [];

    for (const tileDoc of tileDocs) {
      const tileId = tileDoc.id;

      // Must have been visited first
      const isVisited = DP.TileState?.isVisited(scene, tileId) ?? false;
      if (!isVisited) continue;

      // Read explicit eligibleForFastTravel flag; fall back to type-based default
      const rawEligible = tileDoc.getFlag?.(MODULE_ID, `${pathingKey}.eligibleForFastTravel`);
      let isEligible;
      if (rawEligible === null || rawEligible === undefined) {
        // Flag not yet set — infer from tile type (backward compatibility)
        let initialType = DP.TileState?.getInitialType(scene, tileId) ?? "";
        if (!initialType && tileDoc.name) {
          const low = String(tileDoc.name).toLowerCase();
          if      (low.includes("camp"))  initialType = "camp";
          else if (low.includes("event")) initialType = "event";
          else if (low.includes("final")) initialType = "final";
          else if (low.includes("story")) initialType = "story";
        }
        isEligible = FT_TYPES.has(initialType);
      } else {
        isEligible = !!rawEligible;
      }
      if (!isEligible) continue;

      // Read type for display label
      let initialType = DP.TileState?.getInitialType(scene, tileId) ?? "";
      if (!initialType && tileDoc.name) {
        const low = String(tileDoc.name).toLowerCase();
        if      (low.includes("camp"))  initialType = "camp";
        else if (low.includes("event")) initialType = "event";
        else if (low.includes("final")) initialType = "final";
        else if (low.includes("story")) initialType = "story";
      }

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
        sprite.anchor.set(0, 0.5);  // left-centre, same as helper mode
        sprite.tint   = 0xffd966;  // golden tint distinguishes from helper mode
      }
      // Same edge-inset positioning formula as helper mode
      sprite.x = node.bounds.right - cfg.SIZE * cfg.EDGE_INSET;
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
    DP.Sound?.playFastTravelCycle?.();
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
      if (!_active || _traveling || ev.button !== 0) return;
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

  // ── Scroll-wheel navigation ───────────────────────────────────────────────────
  function installWheelListener() {
    if (_wheelHandler) return;
    const view = getCanvasView();
    if (!view) return;

    _wheelHandler = (ev) => {
      if (!_active) return;
      ev.preventDefault();
      ev.stopPropagation();
      navigate(ev.deltaY > 0 ? 1 : -1);
    };

    view.addEventListener("wheel", _wheelHandler, { passive: false, capture: true });
  }

  function removeWheelListener() {
    try {
      const view = getCanvasView();
      if (view && _wheelHandler) view.removeEventListener("wheel", _wheelHandler, true);
    } catch {}
    _wheelHandler = null;
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
    if (_traveling) return;

    _traveling = true;
    try {
      const gSize = Number(canvas?.grid?.size ?? 100) || 100;
      const offX  = Number(DP.UI?.TOKEN_OFFSET?.x ?? 0);
      const offY  = Number(DP.UI?.TOKEN_OFFSET?.y ?? 0);
      const tw    = Number(token.document?.width  ?? 1) * gSize;
      const th    = Number(token.document?.height ?? 1) * gSize;

      const targetX = Math.round(node.center.x - tw / 2 + offX);
      const targetY = Math.round(node.center.y - th / 2 + offY);

      // Pan all viewports back to the party token before the animation plays
      const tokenCX = Number(token.document.x) + tw / 2;
      const tokenCY = Number(token.document.y) + th / 2;
      broadcastPan(tokenCX, tokenCY);
      canvas?.animatePan?.({ x: tokenCX, y: tokenCY, duration: 400 });
      await new Promise(r => setTimeout(r, 450));

      // Broadcast to non-controller clients; everyone plays eagle sound then gryphon together
      game.socket.emit(SOCKET_CH, { type: MSG_FT_ANIM, payload: {} });
      await DP.Sound?.playFastTravelEagle?.().catch(() => {});
      const meshInfo = await runGryphonAnimation(token).catch(e => {
        console.warn(TAG, "gryphon anim:", e);
        return null;
      });

      // Token is still hidden — update position, play land sound, then reveal at destination
      await token.document.update(
        { x: targetX, y: targetY },
        { animate: false, dungeonPathing: true }
      );
      DP.Sound?.playFastTravelLand?.();
      if (meshInfo?.token) {
        if (meshInfo.pickupGuardId != null) Hooks.off("refreshToken", meshInfo.pickupGuardId);
        showMesh(meshInfo.token);
      }

    } catch (e) {
      console.error(TAG, "teleportTo error:", e);
    } finally {
      // Safety net: never leave the token invisible if something threw
      try { if (!token.destroyed) showMesh(token); } catch {}
      _traveling = false;
      exit({ silent: true }); // land sound already played; suppress the close sfx
      setTimeout(() => {
        globalThis.__ONI_DUNGEON_PATHING__?.rebuild?.().catch(() => {});
      }, 250);
    }
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
    console.debug(TAG, "enter(): checking controller status. api=", !!api);
    if (!api?.isCurrentUserMainController) {
      ui.notifications?.warn?.("Movement Control system not ready.");
      return;
    }
    const isController = await api.isCurrentUserMainController();
    console.debug(TAG, "enter(): isController=", isController);
    if (!isController) {
      ui.notifications?.warn?.("Fast Travel is only available to the Main Controller.");
      return;
    }

    // Check if Fast Travel is enabled for this scene (default: true)
    const ftEnabledRaw = canvas.scene?.getFlag?.(MODULE_ID,
      `${DP.FABULA_ROOT_KEY ?? "oniFabula"}.${DP.GENERAL_KEY ?? "general"}.fastTravelEnabled`);
    if (ftEnabledRaw === false || ftEnabledRaw === "false" || ftEnabledRaw === 0) {
      ui.notifications?.warn?.("Fast Travel is disabled for this scene.");
      return;
    }

    _eligible = resolveEligibleNodes();
    console.debug(TAG, "enter(): eligible nodes=", _eligible.length, _eligible.map(n => n.name));
    if (!_eligible.length) {
      ui.notifications?.info?.("No visited landmarks to travel to. Explore the dungeon first!");
      return;
    }

    _active       = true;
    _isController = true;
    _focusedIdx   = 0;

    DP.Sound?.playConfirm?.();
    broadcastEnter();

    // Free our own camera from the scan ticker so we can pan freely
    DP.ScanMode?.detachTicker?.();
    // Also exit scan mode if it was on (clamp would fight FT panning)
    if (DP.ScanMode?.active) DP.ScanMode?.exitScan?.();

    await showSprites(_eligible);
    showNavButtons();
    installClickListener();
    installWheelListener();
    installEsc();

    // Pan immediately to first eligible tile and sync all viewports
    panToFocused();

    DP.ScanMode?.syncFtBtn?.();
    console.debug(TAG, `Fast Travel active — ${_eligible.length} eligible landmark(s).`);
  }

  function exit({ silent = false } = {}) {
    if (!_active) return;
    _active       = false;
    _isController = false;
    _traveling    = false;

    if (!silent) DP.Sound?.playFastTravelClose?.();

    hideSprites();
    hideNavButtons();
    removeClickListener();
    removeWheelListener();
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
    /** Exposed for reuse by SceneTravel — plays the gryphon pick-up animation. */
    runGryphonAnimation,
    /** Exposed for reuse by SceneTravel — plays the gryphon drop-off animation. */
    runDropOffAnimation,
    hideMesh,
    showMesh,
  };

  Hooks.once("ready", () => {
    setupSocketListener();
    // Pre-warm gryphon texture so the first animation starts without a load stall
    setTimeout(() => ensureGryphonTexture().catch(() => {}), 2500);
    console.debug(TAG, "Fast Travel System loaded.");
  });
})();
