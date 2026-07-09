// ============================================================================
// Dungeon Pathing System — Scan Mode + Camera Lock
//
// Camera behaviour while dungeon pathing is active (player clients only):
//
//   Scan mode OFF (standby / movement):
//     A PIXI ticker lerps the viewport toward the party token each frame,
//     giving a smooth follow.  As the token moves during a turn the camera
//     chases it in real-time — no additional wiring needed.
//
//   Scan mode ON (user toggled via 🔍 button or ESC):
//     The ticker switches to clamp mode.  Right-click drag pans normally but
//     the pivot is clamped within a configurable world-unit radius around the
//     token center.  Exiting scan mode snaps the camera back and re-engages
//     the smooth lock.
//
// Scan radius is saved per scene (Fabula Configuration → General → Scan Mode
// Radius).  Default: DP.UI.SCAN_BUTTON.DEFAULT_RADIUS world units.
//
// Two fixed buttons appear in the bottom-left while dungeon mode is active:
//   🔍  Scan Mode  — explore within radius; ESC or click again to exit.
//   🗺️  Helper Mode — toggle tile walkability indicators (same as H key).
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
.oni-dp-mode-btn {
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
.oni-dp-mode-btn.dp-scan-visible {
  opacity: 1;
  transform: scale(1) translateY(0);
}
.oni-dp-mode-btn.dp-btn-disabled {
  opacity: 0.42;
  cursor: not-allowed;
  filter: grayscale(0.85);
}
.oni-dp-mode-btn.dp-btn-disabled.dp-scan-visible { opacity: 0.42; }
.oni-dp-mode-btn.dp-scan-active {
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
.oni-dp-mode-btn:hover  { filter: brightness(1.15); }
.oni-dp-mode-btn:active { filter: brightness(0.9); transform: scale(0.94); }
    `;
    document.head.appendChild(s);
  }

  // ── State ──────────────────────────────────────────────────────────────────
  let _scanBtn          = null;   // 🔍 DOM element
  let _helperBtn        = null;   // 🗺️ DOM element
  let _ftBtn            = null;   // 🦅 DOM element
  let _travelBtn        = null;   // scene travel DOM element
  let _travelBtnMode    = null;   // "dungeon" | "exploration"
  let _healBtn          = null;   // ❤️ out-of-combat healing DOM element
  let _ritualBtn        = null;   // 🕯️ ritual setup DOM element
  let _ritualCtrlHook   = null;   // controlToken hook id — regreys the ritual button
  let _scanning         = false;
  let _cameraSettled    = false;  // true once pivot is within 1wu of token and no pan needed
  let _tickerFn         = null;
  let _escHandler       = null;
  let _cachedScanRadius = null;   // cached per scan-mode activation; cleared on enterScan()

  // ── Config helpers ─────────────────────────────────────────────────────────
  function cfgScan() {
    return DP.UI?.SCAN_BUTTON   ?? { SIZE: 64, BOTTOM: 80, LEFT: 20,  FONT_SIZE: "28px", DEFAULT_RADIUS: 600 };
  }
  function cfgHelper() {
    return DP.UI?.HELPER_BUTTON ?? { SIZE: 64, BOTTOM: 80, LEFT: 94,  FONT_SIZE: "28px" };
  }
  function cfgFT() {
    return DP.UI?.FAST_TRAVEL_BUTTON ?? { SIZE: 64, BOTTOM: 80, LEFT: 168, FONT_SIZE: "28px" };
  }
  function cfgHeal() {
    // Docked as the second button (right of Scan), same row.
    return DP.UI?.HEAL_BUTTON ?? { SIZE: 64, BOTTOM: 80, LEFT: 94, FONT_SIZE: "28px" };
  }
  function cfgTravel() {
    return DP.UI?.SCENE_TRAVEL_BUTTON ?? { SIZE: 64, BOTTOM: 80, LEFT: 242, LEFT_NO_FT: 168, LEFT_SOLO: 20, FONT_SIZE: "28px" };
  }
  function cfgRitual() {
    return DP.UI?.RITUAL_BUTTON
      ?? { SIZE: 64, BOTTOM: 80, LEFT: 390, LEFT_NO_FT: 316, LEFT_EXPLORATION: 168, LEFT_SOLO: 20, FONT_SIZE: "28px" };
  }

  // The ritual button is the rightmost of the row, so its slot depends on how
  // many buttons the current mode docked to its left.
  function getRitualLeft(mode) {
    const c = cfgRitual();
    if (mode === "theatre") return c.LEFT_SOLO;            // only button on screen
    if (mode === "exploration") return c.LEFT_EXPLORATION; // travel(20) + heal(94)
    return isFtEnabled() ? c.LEFT : c.LEFT_NO_FT;          // dungeon: FT may be hidden
  }

  function isFtEnabled() {
    const raw = canvas?.scene?.flags?.[DP.MODULE_ID]?.[DP.FABULA_ROOT_KEY]?.[DP.GENERAL_KEY]?.fastTravelEnabled;
    return raw !== false && raw !== "false" && raw !== 0;
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
    if (_cachedScanRadius !== null) return _cachedScanRadius;
    const raw = canvas?.scene?.flags?.[DP.MODULE_ID]?.[DP.FABULA_ROOT_KEY]
                  ?.[DP.GENERAL_KEY]?.[DP.PATHING_SCAN_RADIUS_KEY];
    const n = Number(raw);
    _cachedScanRadius = Number.isFinite(n) && n > 0 ? n : (cfgScan().DEFAULT_RADIUS ?? 600);
    return _cachedScanRadius;
  }

  function snapCameraToToken() {
    const center = getTokenCenter();
    if (!center || !canvas?.ready) return;
    canvas.animatePan({ x: center.x, y: center.y, duration: 600 });
  }

  // ── PIXI Ticker — core camera lock ─────────────────────────────────────────
  // Calling canvas.pan() every frame overrides any user input — the only
  // reliable way to lock the viewport in Foundry.

  function attachTicker() {
    if (_tickerFn) return;
    if (!canvas?.app?.ticker) return;
    if (isGM()) return; // GM is always free to pan
    _cameraSettled = false; // force one snap on attach (new scene / first load)

    _tickerFn = () => {
      if (!canvas?.ready) return;
      if (isGM()) return;
      if (!isDungeonActive()) return;
      if (game.paused) return;

      const center = getTokenCenter();
      if (!center) return;

      const scale = canvas.stage.scale.x;

      if (!_scanning) {
        // Smooth follow: lerp pivot toward token center each frame.
        // Once settled (within 1wu), skip canvas.pan() entirely — avoids firing
        // the canvasPan hook 60×/s when nothing has changed.
        const px = canvas.stage.pivot.x;
        const py = canvas.stage.pivot.y;
        const dx = center.x - px;
        const dy = center.y - py;
        // Use squared distance to avoid sqrt in the common settled case.
        const dSq = dx * dx + dy * dy;
        if (dSq <= 1) {
          if (!_cameraSettled) {
            canvas.pan({ x: center.x, y: center.y, scale });
            _cameraSettled = true;
          }
          // else: already snapped — nothing to do this frame
        } else {
          _cameraSettled = false;
          const lerp = DP.UI?.CAMERA?.LERP ?? 0.25;
          canvas.pan({ x: px + dx * lerp, y: py + dy * lerp, scale });
        }
      } else {
        // Clamp mode: allow free pan but not beyond the scan radius.
        // Compare squared distances to skip sqrt when inside the radius.
        const maxR  = getScanRadius();
        const px    = canvas.stage.pivot.x;
        const py    = canvas.stage.pivot.y;
        const dx    = px - center.x;
        const dy    = py - center.y;
        const dSq   = dx * dx + dy * dy;
        if (dSq > maxR * maxR) {
          const dist  = Math.sqrt(dSq);
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
    _cachedScanRadius = null; // re-read from flags in case scene config changed
    _cameraSettled = false; // pivot will drift; re-evaluate every frame until re-locked
    _scanBtn?.classList.add("dp-scan-active");
    if (_scanBtn) _scanBtn.title = "Exit Scan Mode (ESC)";
    DP.Sound?.playScanOn?.();
    console.debug(TAG, "Scan mode ON — clamp pan active.");
  }

  function exitScan() {
    if (!_scanning) return;
    _scanning = false;
    _cameraSettled = false; // pivot is away from token; must lerp back
    _scanBtn?.classList.remove("dp-scan-active");
    if (_scanBtn) _scanBtn.title = "Scan Mode — explore the map";
    DP.Sound?.playScanOff?.();
    snapCameraToToken(); // animate back; ticker will then smooth-lock
    console.debug(TAG, "Scan mode OFF — viewport returned to token.");
  }

  function toggleScan() {
    if (_scanning) exitScan();
    else           enterScan();
  }

  // ── Helper button visual sync ──────────────────────────────────────────────
  function syncHelperBtn() {
    if (!_helperBtn) return;
    const on = DP.HelperMode?.enabled ?? false;
    _helperBtn.classList.toggle("dp-scan-active", on);
    _helperBtn.title = on
      ? "Helper Mode ON — press H or click to toggle"
      : "Helper Mode — show walkable tiles";
  }

  // ── Fast Travel button visual sync ─────────────────────────────────────────
  function syncFtBtn() {
    if (!_ftBtn) return;
    const on = DP.FastTravel?.active ?? false;
    _ftBtn.classList.toggle("dp-scan-active", on);
    _ftBtn.title = on
      ? "Fast Travel ON — click a landmark to travel there (ESC to cancel)"
      : "Fast Travel — teleport to a visited landmark";
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

  // ── Button factory ─────────────────────────────────────────────────────────
  function makeBtn(id, emoji, title, c, onClick) {
    const btn = document.createElement("div");
    btn.id = id;
    btn.className = "oni-dp-mode-btn";
    btn.title = title;
    btn.textContent = emoji;
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
      onClick();
    });
    return btn;
  }

  // ── Travel button helpers ──────────────────────────────────────────────────
  function getTravelLeft(mode) {
    if (mode !== "dungeon") return cfgTravel().LEFT_SOLO; // 20 — only button in exploration
    return isFtEnabled() ? cfgTravel().LEFT : cfgTravel().LEFT_NO_FT;
  }

  function getTravelEmoji() {
    // Delegates to SceneTravel which reads scene type flags + sceneMode fallback
    return DP.SceneTravel?.getTravelEmoji?.(canvas?.scene) ?? "⛰️";
  }

  // ── Button lifecycle ───────────────────────────────────────────────────────
  function show() {
    injectStyles();
    if (_scanBtn) return; // already visible

    // Scan button
    _scanBtn = makeBtn(
      "oni-dp-scan-btn",
      "🔍",
      "Scan Mode — explore the map",
      cfgScan(),
      () => toggleScan(),
    );
    document.body.appendChild(_scanBtn);

    // Helper button
    _helperBtn = makeBtn(
      "oni-dp-helper-btn",
      "🗺️",
      "Helper Mode — show walkable tiles",
      cfgHelper(),
      () => {
        DP.HelperMode?.toggle?.();
        syncHelperBtn();
      },
    );
    document.body.appendChild(_helperBtn);

    // Fast Travel button — only if enabled for this scene
    if (isFtEnabled()) {
      _ftBtn = makeBtn(
        "oni-dp-ft-btn",
        "🦅",
        "Fast Travel — teleport to a visited landmark",
        cfgFT(),
        () => { DP.FastTravel?.toggle?.(); },
      );
      document.body.appendChild(_ftBtn);
    }

    syncHelperBtn();
    syncFtBtn();
    installEsc();

    requestAnimationFrame(() => {
      _scanBtn?.classList.add("dp-scan-visible");
      _helperBtn?.classList.add("dp-scan-visible");
      _ftBtn?.classList.add("dp-scan-visible");
    });
  }

  // ── Healing button (independent — shown in dungeon AND exploration) ─────────
  function showHealBtn() {
    injectStyles();
    if (_healBtn) return;
    _healBtn = makeBtn(
      "oni-dp-heal-btn",
      "❤️",
      "Healing — heal party members",
      cfgHeal(),
      () => {
        const api = globalThis.FUCompanion?.api?.healing
          ?? game.modules?.get("fabula-ultima-companion")?.api?.healing;
        if (!api?.open) { ui.notifications?.warn("Healing system not available."); return; }
        // Toggle: open if closed, close if already open.
        if (api.isOpen) api.close();
        else api.open();
      },
    );
    document.body.appendChild(_healBtn);
    requestAnimationFrame(() => _healBtn?.classList.add("dp-scan-visible"));
  }

  function hideHealBtn() {
    if (!_healBtn) return;
    _healBtn.classList.remove("dp-scan-visible");
    const btn = _healBtn;
    setTimeout(() => btn.remove(), 280);
    _healBtn = null;
  }

  // ── Ritual button (dungeon + exploration + theatre) ─────────────────────────
  //
  // Greys out when this client has no performer. For a player that means no
  // character is assigned to their user; for a GM it means no token is
  // selected, so the button re-greys on every controlToken.
  function ritualApi() {
    return globalThis.FUCompanion?.api?.ritual
      ?? game.modules?.get("fabula-ultima-companion")?.api?.ritual;
  }

  function syncRitualBtn() {
    if (!_ritualBtn) return;
    const api = ritualApi();
    const enabled = Boolean(api?.canOpen?.());
    _ritualBtn.classList.toggle("dp-btn-disabled", !enabled);
    _ritualBtn.title = enabled
      ? "Ritual — perform a Ritual"
      : (api?.blockedReason?.() ?? "Ritual — unavailable");
  }

  /** Show the ritual button. mode: "dungeon" | "exploration" | "theatre" */
  function showRitualBtn(mode = "dungeon") {
    injectStyles();
    const c = cfgRitual();
    const left = getRitualLeft(mode);

    if (_ritualBtn) {
      _ritualBtn.style.left = `${left}px`;
      syncRitualBtn();
      return;
    }

    _ritualBtn = makeBtn(
      "oni-dp-ritual-btn",
      "🕯️",
      "Ritual — perform a Ritual",
      { ...c, LEFT: left },
      () => {
        const api = ritualApi();
        if (!api?.open) { ui.notifications?.warn("Ritual system not available."); return; }
        if (!api.canOpen()) {
          ui.notifications?.warn((api.blockedReason?.() ?? "Ritual unavailable.").replace(/^Ritual — /, "Ritual: "));
          return;
        }
        if (api.isOpen) api.close();
        else api.open();
      },
    );
    document.body.appendChild(_ritualBtn);
    syncRitualBtn();

    // A GM's eligibility changes with their token selection, not with the scene.
    if (!_ritualCtrlHook) _ritualCtrlHook = Hooks.on("controlToken", () => syncRitualBtn());

    requestAnimationFrame(() => _ritualBtn?.classList.add("dp-scan-visible"));
  }

  function hideRitualBtn() {
    if (_ritualCtrlHook) { Hooks.off("controlToken", _ritualCtrlHook); _ritualCtrlHook = null; }
    if (!_ritualBtn) return;
    _ritualBtn.classList.remove("dp-scan-visible");
    const btn = _ritualBtn;
    setTimeout(() => btn.remove(), 280);
    _ritualBtn = null;
  }

  function hide() {
    if (_scanning) {
      _scanning = false;
      _scanBtn?.classList.remove("dp-scan-active");
    }
    removeEsc();

    for (const btn of [_scanBtn, _helperBtn, _ftBtn]) {
      if (!btn) continue;
      btn.classList.remove("dp-scan-visible");
      setTimeout(() => btn.remove(), 280);
    }
    _scanBtn   = null;
    _helperBtn = null;
    _ftBtn     = null;
  }

  // Show/hide the FT + travel buttons when the scene config fastTravelEnabled flag changes.
  function updateFtBtnVisibility() {
    const enabled = isFtEnabled();

    if (enabled && !_ftBtn && _scanBtn) {
      _ftBtn = makeBtn(
        "oni-dp-ft-btn",
        "🦅",
        "Fast Travel — teleport to a visited landmark",
        cfgFT(),
        () => { DP.FastTravel?.toggle?.(); },
      );
      document.body.appendChild(_ftBtn);
      syncFtBtn();
      requestAnimationFrame(() => _ftBtn?.classList.add("dp-scan-visible"));
    } else if (!enabled && _ftBtn) {
      DP.FastTravel?.exit?.();
      _ftBtn.classList.remove("dp-scan-visible");
      const btn = _ftBtn;
      setTimeout(() => btn.remove(), 280);
      _ftBtn = null;
    }

    // Travel button obeys the same FT gate.
    // Exploration mode is handled by applyForScene in bootstrap;
    // here we only manage the dungeon-mode case.
    if (!enabled) {
      hideTravelBtn();
    } else if (_scanBtn) {
      // FT enabled while dungeon mode is active — ensure travel button is shown/repositioned
      showTravelBtn("dungeon");
    }

    // The ritual button docks to the right of them all, so toggling FT slides it.
    if (_ritualBtn) _ritualBtn.style.left = `${getRitualLeft("dungeon")}px`;
  }

  // Show the scene travel button (called from bootstrap for dungeon + exploration modes).
  function showTravelBtn(mode) {
    injectStyles();
    if (!isFtEnabled()) { hideTravelBtn(); return; }

    const emoji   = getTravelEmoji();
    const leftPx  = getTravelLeft(mode);
    const c       = { SIZE: cfgScan().SIZE, BOTTOM: cfgScan().BOTTOM, LEFT: leftPx, FONT_SIZE: cfgScan().FONT_SIZE };

    if (_travelBtn && _travelBtnMode === mode) {
      // Already shown — just refresh emoji and position
      _travelBtn.textContent = emoji;
      _travelBtn.style.left  = leftPx + "px";
      return;
    }

    hideTravelBtn(); // remove if changing mode

    _travelBtn = makeBtn(
      "oni-dp-travel-btn",
      emoji,
      "Travel to Town/Dungeon",
      c,
      () => { DP.SceneTravel?.showDialog?.(); },
    );
    document.body.appendChild(_travelBtn);
    _travelBtnMode = mode;
    requestAnimationFrame(() => _travelBtn?.classList.add("dp-scan-visible"));
  }

  function hideTravelBtn() {
    if (!_travelBtn) return;
    _travelBtn.classList.remove("dp-scan-visible");
    const btn = _travelBtn;
    setTimeout(() => btn.remove(), 280);
    _travelBtn     = null;
    _travelBtnMode = null;
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  DP.ScanMode = {
    get active() { return _scanning; },
    attachTicker,
    detachTicker,
    show,
    hide,
    toggle: toggleScan,
    exitScan,
    snapCameraToToken,
    /** Call after any external helper-mode state change to keep the button in sync. */
    syncHelperBtn,
    /** Call after any fast travel state change to keep the button in sync. */
    syncFtBtn,
    /** Call when fastTravelEnabled flag changes to show/hide the FT button. */
    updateFtBtnVisibility,
    /** Show the scene travel button. mode: "dungeon" | "exploration" */
    showTravelBtn,
    /** Hide the scene travel button. */
    hideTravelBtn,
    /** Show the healing HUD button (dungeon + exploration). */
    showHealBtn,
    /** Hide the healing HUD button. */
    hideHealBtn,
    /** Show the ritual button. mode: "dungeon" | "exploration" | "theatre" */
    showRitualBtn,
    /** Hide the ritual button. */
    hideRitualBtn,
    /** Re-grey the ritual button after an external performer-eligibility change. */
    syncRitualBtn,
  };
})();
