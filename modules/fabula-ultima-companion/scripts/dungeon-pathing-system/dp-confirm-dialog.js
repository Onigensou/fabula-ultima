// ============================================================================
// Dungeon Pathing System — In-Canvas Confirmation Buttons (HTML DOM overlay)
//
// Two parchment-styled JRPG buttons rendered as a position:fixed element
// anchored to the party token's top-right corner.  Coordinates are converted
// from world-space via canvas.stage.worldTransform so the panel stays pinned
// at all zoom / pan levels.
//
//   ┌──────────────────┐
//   │  ✔  Confirm      │  ← green-parchment
//   ├──────────────────┤
//   │  ⟲  Go Back      │  ← dark-parchment
//   └──────────────────┘
//
// Ease-in  : slide left→right + fade in
// Ease-out : slide right→left + fade out
// ============================================================================
(() => {
  const DP  = globalThis.DungeonPathing ??= {};
  const TAG = "[DungeonPathing][ConfirmUI]";

  // ── Inject stylesheet once ─────────────────────────────────────────────────
  const STYLE_ID = "oni-dp-confirm-styles";
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
/* ── Dungeon Pathing: confirm panel ─────────────────────────────────────── */
#oni-dp-confirm-panel {
  position: fixed;
  z-index: 99999;
  display: flex;
  flex-direction: column;
  pointer-events: auto;
  user-select: none;
  /* transition is on the panel itself for slide+fade */
  opacity: 0;
  transform: translateX(-28px);
  transition: opacity 220ms cubic-bezier(.4,0,.2,1),
              transform 220ms cubic-bezier(.4,0,.2,1);
}
#oni-dp-confirm-panel.dp-visible {
  opacity: 1;
  transform: translateX(0);
}
#oni-dp-confirm-panel.dp-leaving {
  opacity: 0;
  transform: translateX(28px);
  transition: opacity 180ms cubic-bezier(.4,0,.6,1),
              transform 180ms cubic-bezier(.4,0,.6,1);
  pointer-events: none;
}

/* ── Shared button base ─────────────────────────────────────────────────── */
.oni-dp-btn {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  border-radius: 6px;
  border: 2px solid #8B6914;
  box-shadow:
    0 0 0 1px #c9973a,
    2px 4px 8px rgba(0,0,0,0.55),
    inset 0 1px 0 rgba(255,255,255,0.18);
  overflow: hidden;
  font-family: "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-shadow: 1px 1px 2px rgba(0,0,0,0.7), 0 0 6px rgba(0,0,0,0.4);
  transition: filter 120ms ease, box-shadow 120ms ease;
}
.oni-dp-btn:hover {
  filter: brightness(1.12);
  box-shadow:
    0 0 0 1px #e8b84b,
    3px 5px 12px rgba(0,0,0,0.65),
    inset 0 1px 0 rgba(255,255,255,0.22);
}
.oni-dp-btn:active {
  filter: brightness(0.92);
  box-shadow:
    0 0 0 1px #c9973a,
    1px 2px 4px rgba(0,0,0,0.55),
    inset 0 1px 0 rgba(255,255,255,0.12);
  transform: translateY(1px);
}

/* Wood-grain strip across top */
.oni-dp-btn::before {
  content: "";
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 6px;
  border-radius: 4px 4px 0 0;
  background: repeating-linear-gradient(
    90deg,
    rgba(90,50,10,0.55) 0px,
    rgba(90,50,10,0.55) 2px,
    rgba(130,80,20,0.35) 2px,
    rgba(130,80,20,0.35) 5px,
    rgba(90,50,10,0.55) 5px,
    rgba(90,50,10,0.55) 7px,
    rgba(110,65,15,0.4) 7px,
    rgba(110,65,15,0.4) 10px
  );
}

/* Brass stud pair */
.oni-dp-btn::after {
  content: "";
  position: absolute;
  top: 50%; left: 6px;
  transform: translateY(-50%);
  width: 7px; height: 7px;
  border-radius: 50%;
  background: radial-gradient(circle at 35% 35%, #f0d060 0%, #c8960c 55%, #7a5800 100%);
  box-shadow: 0 0 2px rgba(0,0,0,0.6), inset 0 1px 1px rgba(255,255,255,0.4);
}

/* ── Confirm button (green parchment) ───────────────────────────────────── */
.oni-dp-btn-confirm {
  background:
    radial-gradient(ellipse at 50% 0%, rgba(180,220,160,0.18) 0%, transparent 70%),
    linear-gradient(
      175deg,
      #2e5c28 0%,
      #3a7832 25%,
      #2d6026 50%,
      #255022 75%,
      #1e4018 100%
    );
  color: #d8f0c0;
}

/* ── Use button (teal parchment) ────────────────────────────────────────── */
.oni-dp-btn-use {
  background:
    radial-gradient(ellipse at 50% 0%, rgba(140,220,200,0.18) 0%, transparent 70%),
    linear-gradient(
      175deg,
      #1a5050 0%,
      #206858 25%,
      #185448 50%,
      #12403a 75%,
      #0c2c28 100%
    );
  color: #a8f0e0;
}

/* ── Go Back button (dark parchment) ────────────────────────────────────── */
.oni-dp-btn-revert {
  background:
    radial-gradient(ellipse at 50% 0%, rgba(200,160,120,0.14) 0%, transparent 70%),
    linear-gradient(
      175deg,
      #4a2c18 0%,
      #5c3820 25%,
      #4a2c18 50%,
      #3c2210 75%,
      #2c1808 100%
    );
  color: #e8c890;
}
/* ─────────────────────────────────────────────────────────────────────────── */
    `;
    document.head.appendChild(style);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  let _panel     = null;
  let _rafId     = null;
  let _resolveFn = null;

  /**
   * Convert a world-space point to client (viewport) px using the PIXI stage
   * worldTransform.  Matches actual rendered position at any zoom/pan.
   * Accepts a pre-computed canvas rect to avoid getBoundingClientRect() each frame.
   */
  function worldToClient(worldX, worldY, cachedRect) {
    const t = canvas?.stage?.worldTransform;
    if (!t) return { x: 0, y: 0 };
    const rx   = t.a * worldX + t.c * worldY + t.tx;
    const ry   = t.b * worldX + t.d * worldY + t.ty;
    const el   = canvas?.app?.view ?? canvas?.app?.renderer?.view;
    const rect = cachedRect ?? el?.getBoundingClientRect?.() ?? { left: 0, top: 0, width: 1, height: 1 };
    const elW  = el?.width  || rect.width  || 1;
    const elH  = el?.height || rect.height || 1;
    return {
      x: rect.left + (rx / elW) * rect.width,
      y: rect.top  + (ry / elH) * rect.height,
    };
  }

  /** Position the panel each RAF frame so it tracks token through pan/zoom. */
  function trackPosition(panel, token, cachedRect) {
    const cfg = DP.UI?.BUTTON ?? { WIDTH: 130, HEIGHT: 42, GAP: 5, OFFSET_X: 14 };

    const docX = Number(token.document?.x ?? 0);
    const docY = Number(token.document?.y ?? 0);
    const tokW = Number(token.w ?? token.document?.width  * (canvas?.grid?.size ?? 100) ?? 100);
    const tokH = Number(token.h ?? token.document?.height * (canvas?.grid?.size ?? 100) ?? 100);

    // Anchor point: right edge of token, vertically centred
    const anchorClient = worldToClient(docX + tokW, docY + tokH / 2, cachedRect);
    const panelH = panel.offsetHeight || (cfg.HEIGHT * 2 + cfg.GAP);

    panel.style.left = `${Math.round(anchorClient.x + cfg.OFFSET_X)}px`;
    panel.style.top  = `${Math.round(anchorClient.y - panelH / 2)}px`;
  }

  function startTracking(panel, token) {
    if (_rafId) cancelAnimationFrame(_rafId);

    // Cache the canvas element's bounding rect — it only changes on window resize,
    // not on pan/zoom.  Avoids a potential reflow on every RAF frame.
    const el = canvas?.app?.view ?? canvas?.app?.renderer?.view;
    let _rect = el?.getBoundingClientRect?.() ?? { left: 0, top: 0, width: 1, height: 1 };
    const onResize = () => { _rect = el?.getBoundingClientRect?.() ?? _rect; };
    window.addEventListener("resize", onResize, { passive: true });

    function tick() {
      if (!_panel) {
        window.removeEventListener("resize", onResize);
        return;
      }
      trackPosition(panel, token, _rect);
      _rafId = requestAnimationFrame(tick);
    }
    _rafId = requestAnimationFrame(tick);
  }

  function stopTracking() {
    if (_rafId) cancelAnimationFrame(_rafId);
    _rafId = null;
  }

  function removePanel(leaveAnimation) {
    if (!_panel) return;
    const panel = _panel;
    _panel = null;
    stopTracking();
    if (leaveAnimation) {
      panel.classList.remove("dp-visible");
      panel.classList.add("dp-leaving");
      setTimeout(() => { panel.remove(); }, 220);
    } else {
      panel.remove();
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  DP.ConfirmDialog = {
    isOpen: false,

    /**
     * Display the in-canvas confirm buttons anchored to the given token.
     *
     * @param {Token} token
     * @param {object} [options]
     * @param {boolean} [options.showUseButton=false]
     *   When true, a teal "Use" button is inserted between Confirm and Go Back.
     *
     * Returns Promise<true|"use"|false>:
     *   true  = Confirm pressed  (land without triggering tile event)
     *   "use" = Use pressed      (land AND trigger tile event)
     *   false = Go Back pressed  (revert movement)
     */
    ask(token, { showUseButton = false } = {}) {
      this.forceClose();
      this.isOpen = true;

      return new Promise((resolve) => {
        _resolveFn = resolve;

        const cfg = DP.UI?.BUTTON ?? { WIDTH: 130, HEIGHT: 42, GAP: 5, OFFSET_X: 14, FONT_SIZE: "13px" };

        const panel = document.createElement("div");
        panel.id = "oni-dp-confirm-panel";

        const makeBtn = (label, cssClass, result) => {
          const btn = document.createElement("div");
          btn.className = `oni-dp-btn ${cssClass}`;
          btn.style.cssText = [
            `width:${cfg.WIDTH}px`,
            `height:${cfg.HEIGHT}px`,
            `font-size:${cfg.FONT_SIZE}`,
          ].join(";");
          btn.textContent = label;
          btn.addEventListener("pointerdown", (ev) => {
            ev.stopPropagation();
            ev.preventDefault();
            this._resolve(result);
          });
          return btn;
        };

        const addGap = () => {
          const gap = document.createElement("div");
          gap.style.height = `${cfg.GAP}px`;
          panel.appendChild(gap);
        };

        panel.appendChild(makeBtn("✔  Confirm", "oni-dp-btn-confirm", true));

        if (showUseButton) {
          addGap();
          panel.appendChild(makeBtn("⛺  Use", "oni-dp-btn-use", "use"));
        }

        addGap();
        panel.appendChild(makeBtn("⟲  Go Back", "oni-dp-btn-revert", false));

        document.body.appendChild(panel);
        _panel = panel;

        // Initial position + start tracking
        trackPosition(panel, token);
        startTracking(panel, token);

        // Trigger enter animation on next frame (allows paint before class add)
        requestAnimationFrame(() => { panel.classList.add("dp-visible"); });
      });
    },

    _resolve(result) {
      this.isOpen = false;
      const fn = _resolveFn;
      _resolveFn = null;
      if (result) DP.Sound?.playConfirm?.();
      else        DP.Sound?.playCancel?.();
      removePanel(true);
      fn?.(result);
    },

    forceClose() {
      this.isOpen = false;
      _resolveFn = null;
      removePanel(false);
    },
  };
})();
