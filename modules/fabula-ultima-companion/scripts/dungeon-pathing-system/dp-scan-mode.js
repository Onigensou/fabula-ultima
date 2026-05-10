// ============================================================================
// Dungeon Pathing System — Scan Mode + Camera Lock
//
// Camera behaviour while dungeon pathing is active (player clients only):
//
//   Scan mode OFF (standby / movement):
//     A PIXI ticker calls canvas.pan() every frame to hard-lock the viewport
//     on the party token.  As the token moves during a turn the camera follows
//     it in real-time — no additional wiring needed.
//
//   Scan mode ON (user toggled via 🔍 button or keyboard):
//     The ticker switches to clamp mode.  Right-click drag pans normally but
//     the pivot is clamped within a configurable world-unit radius around the
//     token center.  Exiting scan mode snaps the camera back and re-engages
//     the hard lock.
//
// Scan radius is saved per scene (Fabula Configuration → General → Scan Mode
// Radius).  Default: DP.UI.SCAN_BUTTON.DEFAULT_RADIUS world units.
//
// Exit scan mode: click the 🔍 button again or press ESC.
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
#oni-dp-scan-btn:hover { filter: brightness(1.15); }
#oni-dp-scan-btn:active { filter: brightness(0.9); transform: scale(0.94); }
    `;
    document.head.appendChild(s);
  }

  // ── State ──────────────────────────────────────────────────────────────────
  let _btn        = null;
  let _scanning   = false;
  let _tickerFn   = null;
  let _escHandler = null;

  // ── Helpers ────────────────────────────────────────────────────────────────
  function cfg() {
    return DP.UI?.SCAN_BUTTON ?? { SIZE: 64, BOTTOM: 80, LEFT: 20, FONT_SIZE: "28px", DEFAULT_RADIUS: 600 };
  }

  function isGM() {
    try { return !!game?.user?.isGM; } catch { return false; }
  }

  function isDungeonActive() {
    return !!globalThis.__ONI_DUNGEON_PATHING__?.state?.active;
  }

  function getPartyToken() {
    return globalThis.__ONI_DUNGEON_PATHING__?.state?.partyToken ?? null;
  }

  function getTokenCenter() {
    const token = getPartyToken();
    if (!token) return null;
    const gSize = Number(canvas?.grid?.size ?? 100) || 100;
    const tw = Number(token.w ?? (Number(token.document?.width  ?? 1) * gSize));
    const th = Number(token.h ?? (Number(token.document?.height ?? 1) * gSize));
    return {
      x: Number(token.document.x) + tw / 2,
      y: Number(token.document.y) + th / 2,
    };
  }

  function getScanRadius() {
    const raw = canvas?.scene?.flags?.[DP.MODULE_ID]?.[DP.FABULA_ROOT_KEY]
                  ?.[DP.GENERAL_KEY]?.[DP.PATHING_SCAN_RADIUS_KEY];
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : (cfg().DEFAULT_RADIUS ?? 600);
  }

  function snapCameraToToken() {
    const center = getTokenCenter();
    if (!center || !canvas?.ready) return;
    canvas.animatePan({ x: center.x, y: center.y, duration: 600 });
  }

  // ── PIXI Ticker — core camera lock ─────────────────────────────────────────
  // The ticker is the only reliable way to lock the viewport in Foundry:
  // calling canvas.pan() every frame from a ticker overrides any user input.

  function attachTicker() {
    if (_tickerFn) return;
    if (!canvas?.app?.ticker) return;
    if (isGM()) return; // GM is always free to pan

    _tickerFn = () => {
      if (!canvas?.ready) return;
      if (isGM()) return;
      if (!isDungeonActive()) return;

      const center = getTokenCenter();
      if (!center) return;

      const scale = canvas.stage.scale.x;

      if (!_scanning) {
        // Smooth follow: lerp pivot toward token center each frame.
        // Snaps when already within 1 world unit to avoid infinite micro-drift.
        const lerp = DP.UI?.CAMERA?.LERP ?? 0.25;
        const px   = canvas.stage.pivot.x;
        const py   = canvas.stage.pivot.y;
        const dx   = center.x - px;
        const dy   = center.y - py;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist <= 1) {
          canvas.pan({ x: center.x, y: center.y, scale });
        } else {
          canvas.pan({ x: px + dx * lerp, y: py + dy * lerp, scale });
        }
      } else {
        // Clamp mode: allow free pan but not beyond the scan radius
        const maxR = getScanRadius();
        const px   = canvas.stage.pivot.x;
        const py   = canvas.stage.pivot.y;
        const dx   = px - center.x;
        const dy   = py - center.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > maxR) {
          const ratio = maxR / dist;
          canvas.pan({ x: center.x + dx * ratio, y: center.y + dy * ratio, scale });
        }
      }
    };

    canvas.app.ticker.add(_tickerFn);
    console.debug(TAG, "Camera lock ticker attached.");
  }

  function detachTicker() {
    try {
      if (_tickerFn && canvas?.app?.ticker) {
        canvas.app.ticker.remove(_tickerFn);
      }
    } catch {}
    _tickerFn = null;
    console.debug(TAG, "Camera lock ticker detached.");
  }

  // ── Scan mode on/off ───────────────────────────────────────────────────────
  function enterScan() {
    if (_scanning) return;
    _scanning = true;
    _btn?.classList.add("dp-scan-active");
    if (_btn) _btn.title = "Exit Scan Mode (ESC)";
    console.debug(TAG, "Scan mode ON — clamp pan active.");
  }

  function exitScan() {
    if (!_scanning) return;
    _scanning = false;
    _btn?.classList.remove("dp-scan-active");
    if (_btn) _btn.title = "Scan Mode — explore the map";
    snapCameraToToken(); // animate back; ticker will then hard-lock
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
    if (_btn) return; // already visible

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
    // Cancel scan state without snapping (ticker stays attached; camera
    // transitions back to locked mode naturally on the next frame).
    if (_scanning) {
      _scanning = false;
      _btn?.classList.remove("dp-scan-active");
    }
    removeEsc();

    if (!_btn) return;
    const btn = _btn;
    _btn = null;
    btn.classList.remove("dp-scan-visible");
    setTimeout(() => btn.remove(), 280);
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  DP.ScanMode = {
    get active() { return _scanning; },
    attachTicker,
    detachTicker,
    show,
    hide,
    toggle,
    exitScan,
    snapCameraToToken,
  };
})();
