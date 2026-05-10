// ============================================================================
// Dungeon Pathing System — Scan Mode
//
// During standby phase a circular "🔍" button is anchored to the bottom-left
// of the viewport (position:fixed HTML overlay).
//
// Viewport rules while dungeon pathing is active (player clients only):
//   Scan mode OFF : viewport is locked — right-click pan is blocked, camera
//                   snaps back to the party token on each rebuild.
//   Scan mode ON  : viewport is free — right-click drag pans normally.
//                   Token left-click drag is still blocked (see dp-bootstrap).
//
// Exit scan mode by clicking the button again or pressing ESC.
// ============================================================================
(() => {
  const DP  = globalThis.DungeonPathing ??= {};
  const TAG = "[DungeonPathing][ScanMode]";

  // ── Stylesheet (injected once) ─────────────────────────────────────────────
  const STYLE_ID = "oni-dp-scan-styles";
  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
#oni-dp-scan-btn {
  position: fixed;
  z-index: 99998;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  cursor: pointer;
  user-select: none;
  pointer-events: auto;

  border: 2px solid rgba(200,160,80,0.65);
  background: radial-gradient(circle at 40% 35%,
    rgba(90,65,30,0.92) 0%,
    rgba(45,32,14,0.96) 100%);
  box-shadow:
    0 0 14px rgba(0,0,0,0.55),
    0 2px 6px rgba(0,0,0,0.4),
    inset 0 1px 0 rgba(255,255,255,0.12);

  color: #e8c870;
  text-shadow: 0 0 8px rgba(0,0,0,0.9);

  opacity: 0;
  transform: scale(0.6) translateY(10px);
  transition:
    opacity 250ms cubic-bezier(.4,0,.2,1),
    transform 250ms cubic-bezier(.4,0,.2,1),
    background 180ms ease,
    box-shadow 180ms ease,
    border-color 180ms ease,
    color 180ms ease;
}
#oni-dp-scan-btn.dp-scan-visible {
  opacity: 1;
  transform: scale(1) translateY(0);
}
#oni-dp-scan-btn.dp-scan-active {
  background: radial-gradient(circle at 40% 35%,
    rgba(30,70,150,0.93) 0%,
    rgba(15,40,100,0.97) 100%);
  box-shadow:
    0 0 20px rgba(80,150,255,0.35),
    0 2px 8px rgba(0,0,0,0.5),
    inset 0 1px 0 rgba(255,255,255,0.18);
  border-color: rgba(100,170,255,0.75);
  color: #a8d8ff;
}
#oni-dp-scan-btn:hover {
  filter: brightness(1.15);
}
#oni-dp-scan-btn:active {
  filter: brightness(0.9);
  transform: scale(0.94);
}
    `;
    document.head.appendChild(s);
  }

  // ── State ──────────────────────────────────────────────────────────────────
  let _btn             = null;
  let _scanning        = false;
  let _escHandler      = null;
  let _rightClickBlock = null;  // pointerdown capture handler
  let _ctxMenuBlock    = null;  // contextmenu capture handler

  // ── Config ─────────────────────────────────────────────────────────────────
  function cfg() {
    return DP.UI?.SCAN_BUTTON ?? { SIZE: 64, BOTTOM: 80, LEFT: 20, FONT_SIZE: "28px" };
  }

  function isGM() {
    try { return !!game?.user?.isGM; } catch { return false; }
  }

  function isDungeonActive() {
    return !!globalThis.__ONI_DUNGEON_PATHING__?.state?.active;
  }

  // ── Camera helpers ─────────────────────────────────────────────────────────
  function getPartyToken() {
    return globalThis.__ONI_DUNGEON_PATHING__?.state?.partyToken ?? null;
  }

  function snapCameraToToken() {
    const token = getPartyToken();
    if (!token || !canvas?.ready) return;
    const gSize = Number(canvas?.grid?.size ?? 100) || 100;
    const tw = Number(token.w ?? (Number(token.document?.width  ?? 1) * gSize));
    const th = Number(token.h ?? (Number(token.document?.height ?? 1) * gSize));
    const cx = Number(token.document.x) + tw / 2;
    const cy = Number(token.document.y) + th / 2;
    canvas.animatePan({ x: cx, y: cy, duration: 600 });
  }

  // ── Viewport lock ──────────────────────────────────────────────────────────
  // Blocks right-click pan on the canvas whenever dungeon mode is active AND
  // scan mode is NOT active.  GM clients are always exempt.

  function getCanvasView() {
    return canvas?.app?.view
        ?? canvas?.app?.renderer?.view
        ?? document.querySelector("#board canvas");
  }

  function installViewportLock() {
    if (_rightClickBlock) return;

    const view = getCanvasView();
    if (!view) return;

    // Block right-click drag (viewport pan) when scan mode is off
    _rightClickBlock = (ev) => {
      if (ev.button !== 2) return;
      if (isGM()) return;
      if (!isDungeonActive()) return;
      if (_scanning) return; // scan mode ON → allow pan
      ev.preventDefault();
      ev.stopPropagation();
    };

    // Block the browser right-click context menu on the canvas too
    _ctxMenuBlock = (ev) => {
      if (isGM()) return;
      if (!isDungeonActive()) return;
      if (_scanning) return;
      ev.preventDefault();
      ev.stopPropagation();
    };

    view.addEventListener("pointerdown",  _rightClickBlock, { capture: true });
    view.addEventListener("contextmenu",  _ctxMenuBlock,    { capture: true });
  }

  function removeViewportLock() {
    const view = getCanvasView();
    if (view) {
      if (_rightClickBlock) view.removeEventListener("pointerdown",  _rightClickBlock, true);
      if (_ctxMenuBlock)    view.removeEventListener("contextmenu",  _ctxMenuBlock,    true);
    }
    _rightClickBlock = null;
    _ctxMenuBlock    = null;
  }

  // ── Scan mode on/off ───────────────────────────────────────────────────────
  function enterScan() {
    if (_scanning) return;
    _scanning = true;
    _btn?.classList.add("dp-scan-active");
    if (_btn) _btn.title = "Exit Scan Mode (ESC)";
    console.debug(TAG, "Scan mode ON — free pan enabled.");
  }

  function exitScan() {
    if (!_scanning) return;
    _scanning = false;
    _btn?.classList.remove("dp-scan-active");
    if (_btn) _btn.title = "Scan Mode — explore the map";
    snapCameraToToken();
    console.debug(TAG, "Scan mode OFF — viewport returned to token.");
  }

  function toggle() {
    if (_scanning) exitScan();
    else           enterScan();
  }

  // ── ESC key ────────────────────────────────────────────────────────────────
  function installEsc() {
    if (_escHandler) return;
    _escHandler = (ev) => {
      if (!_scanning) return;
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      exitScan();
    };
    window.addEventListener("keydown", _escHandler, true);
  }

  function removeEsc() {
    if (_escHandler) window.removeEventListener("keydown", _escHandler, true);
    _escHandler = null;
  }

  // ── Button lifecycle ───────────────────────────────────────────────────────
  function show() {
    injectStyles();
    installViewportLock();

    // Snap camera to token on every standby start (unless player is scanning)
    if (!_scanning && !isGM()) snapCameraToToken();

    if (_btn) return; // button already visible

    const c = cfg();
    const btn = document.createElement("div");
    btn.id = "oni-dp-scan-btn";
    btn.title = "Scan Mode — explore the map";
    btn.textContent = "🔍";
    btn.style.cssText = [
      `width:${c.SIZE}px`,
      `height:${c.SIZE}px`,
      `bottom:${c.BOTTOM}px`,
      `left:${c.LEFT}px`,
      `font-size:${c.FONT_SIZE}`,
    ].join(";");

    btn.addEventListener("pointerdown", (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      toggle();
    });

    document.body.appendChild(btn);
    _btn = btn;
    installEsc();

    requestAnimationFrame(() => btn.classList.add("dp-scan-visible"));
  }

  function hide() {
    // Quietly clear scan state — no camera snap (snap is user-initiated only).
    if (_scanning) {
      _scanning = false;
      _btn?.classList.remove("dp-scan-active");
    }
    removeEsc();
    removeViewportLock();

    if (!_btn) return;
    const btn = _btn;
    _btn = null;

    btn.classList.remove("dp-scan-visible");
    setTimeout(() => btn.remove(), 280);
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  DP.ScanMode = {
    get active() { return _scanning; },
    show,
    hide,
    toggle,
    exitScan,
    snapCameraToToken,
  };
})();
