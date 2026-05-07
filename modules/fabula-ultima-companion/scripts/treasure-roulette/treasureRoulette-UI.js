// ============================================================================
// [TreasureRoulette] UI • Foundry VTT v12
// ----------------------------------------------------------------------------
// UI ONLY (no sockets here).
// Call: window["oni.TreasureRoulette.UI"].play(packet)
// Packet shape: TreasureRouletteResultPacket from Core
//
// This UI matches Oni's DEMO_TreasureRoulette_UI design:
// - Dim overlay + center loot-type icon
// - Scattered panels around a ring (with overlap solver)
// - Selected highlight ticks like JRPG roulette
// - Anticipation slowdown near the end
// - Tick + Final SFX
// - Ease in/out + auto close
//
// Net integration:
// - If TreasureRoulette Net exists, UI will register the packet locally.
//   (No socket usage; purely local bookkeeping.)
// ============================================================================

(() => {
  const KEY = "oni.TreasureRoulette.UI";
  if (window[KEY]) {
    console.warn(`[TreasureRoulette][UI] Already installed as window["${KEY}"].`);
    return;
  }

  // --------------------------------------------------------------------------
  // DEMO BASELINE CONSTANTS (8 items = baseline)
  // --------------------------------------------------------------------------
  const FALLBACK_IMG = "icons/svg/chest.svg";

  // --------------------------------------------------------------------------
  // Sound defaults (match DEMO_Treasure Roulette_UI.js)
  // --------------------------------------------------------------------------
  const DEFAULT_TICK_SFX = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/CursorMove.mp3";
  const DEFAULT_FINAL_SFX = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/TreasureGet.ogg";
  const DEFAULT_TICK_VOL = 0.45;
  const DEFAULT_FINAL_VOL = 0.9;

  // Center loot-type icon (can be overridden by packet.ui.lootTypeIcon)
  const DEFAULT_LOOT_TYPE_ICON =
    "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/Silver_Chest.png";

  const PANEL_W_BASE = 273;
  const PANEL_H_BASE = 70;

  const RING_RADIUS_RATIO_BASE = 0.35;
  const RING_Y_SQUASH = 0.80;

  const ANGLE_JITTER_DEG_BASE = 5;
  const RADIUS_JITTER_BASE = 0.05;
  const PIXEL_JITTER_BASE = 5;

  const CENTER_ICON_RATIO = 0.16;

  const DIM_OPACITY = 0.68;
  const PANEL_BG = "#e7d7b7";
  const PANEL_TEXT = "#3b2314";
  const PANEL_DIM_OPACITY = 0.55;
  const PANEL_SELECTED_BRIGHTNESS = 1.06;

  const EASE_IN_MS = 520;
  const EASE_OUT_MS = 420;

  // Demo roulette “feel”
  const SPIN_FULL_ROTATIONS_MIN = 4;
  const SPIN_FULL_ROTATIONS_MAX = 6;
  const TICK_MIN_MS_BASE = 55;
  const TICK_MAX_MS_BASE = 240;
  const FINAL_HOLD_MS = 700;

  const LOOT_NAME_MIN_PX = 12;

  const OVERLAP_PADDING_PX = 10;
  const SOLVER_PASSES_BASE = 22;
  const SOLVER_PUSH_STRENGTH = 1.0;

  const SCREEN_MARGIN_PX = 18;
  const CLOSE_DELAY_MS = 250;

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clamp01 = (n) => Math.max(0, Math.min(1, n));
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeOutCubic = (t) => 1 - Math.pow(1 - clamp01(t), 3);

  function warmAudio(urls = []) {
    urls.forEach((u) => {
      try {
        const a = new Audio(u);
        a.preload = "auto";
        a.load();
      } catch {}
    });
  }

  // Preload default SFX (DEMO behavior)
  warmAudio([DEFAULT_TICK_SFX, DEFAULT_FINAL_SFX]);

 async function playSFX(url, volume = 0.8) {
  if (!url) return;
  try {
    const AH = foundry?.audio?.AudioHelper ?? globalThis.AudioHelper;
    if (!AH) return;

    await AH.play(
      { src: url, volume: clamp(Number(volume) || 0.8, 0, 1), autoplay: true, loop: false },
      true
    );
  } catch {}
}

  // deterministic jitter 0..1 (stable per index)
  function pseudoJitter(i, salt = 1) {
    const x = Math.sin((i + 1) * 999.1 * salt) * 10000;
    return x - Math.floor(x);
  }

  // --------------------------------------------------------------------------
  // Adaptive scaling rules (same as DEMO fix)
  // --------------------------------------------------------------------------
  function computeAdaptive(n) {
    const panelScale = clamp(Math.pow(8 / Math.max(8, n), 0.45), 0.58, 1.0);
    const scatterMul = clamp(1 + Math.max(0, n - 8) * 0.07, 1.0, 2.3);
    const radiusMul = clamp(1 + Math.max(0, n - 8) * 0.02, 1.0, 1.35);
    const solverPasses = Math.round(
      clamp(SOLVER_PASSES_BASE + Math.max(0, n - 8) * 1.2, SOLVER_PASSES_BASE, 60)
    );
    return { panelScale, scatterMul, radiusMul, solverPasses };
  }

  // --------------------------------------------------------------------------
  // Style injection (matches DEMO)
  // --------------------------------------------------------------------------
  function ensureStyleTag(styleId, colors) {
    if (document.getElementById(styleId)) return;

    const style = document.createElement("style");
    style.id = styleId;

    // Stable class selector so styles apply to ALL runs.
    style.textContent = `
      .oni-treasure-roulette-overlay {
        position: fixed;
        inset: 0;
        z-index: 9999999;
        pointer-events: auto;
        opacity: 0;
        transition: opacity ${EASE_IN_MS}ms cubic-bezier(.2,.9,.2,1);
      }

      .oni-treasure-roulette-overlay .oni-roulette-dim {
        position: absolute;
        inset: 0;
        background: rgba(0,0,0,${DIM_OPACITY});
      }

      .oni-treasure-roulette-overlay .oni-roulette-stage {
        position: absolute;
        inset: 0;
        transform: scale(0.75);
        transform-origin: center center;
        transition: transform ${EASE_IN_MS}ms cubic-bezier(.2,.9,.2,1);
      }

      .oni-treasure-roulette-overlay.oni-in { opacity: 1; }
      .oni-treasure-roulette-overlay.oni-in .oni-roulette-stage { transform: scale(1); }

      .oni-treasure-roulette-overlay.oni-out {
        opacity: 0;
        transition: opacity ${EASE_OUT_MS}ms cubic-bezier(.4,0,.2,1);
      }
      .oni-treasure-roulette-overlay.oni-out .oni-roulette-stage {
        transform: scale(0.72);
        transition: transform ${EASE_OUT_MS}ms cubic-bezier(.4,0,.2,1);
      }

      .oni-treasure-roulette-overlay .oni-roulette-center-wrap {
        position: absolute;
        left: 50%;
        top: 50%;
        transform: translate(-50%, -50%);
        pointer-events: none;
        filter: drop-shadow(0 10px 18px rgba(0,0,0,0.45));
      }

      .oni-treasure-roulette-overlay .oni-roulette-center {
        display: block;
        width: var(--oni-center-size, 160px);
        height: var(--oni-center-size, 160px);
        object-fit: contain;

        background: transparent !important;
        border: 0 !important;
        outline: 0 !important;
        box-shadow: none !important;

        transform: scale(0.92);
        transition: transform 240ms cubic-bezier(.2,.9,.2,1);
      }

      .oni-treasure-roulette-overlay .oni-roulette-ring {
        position: absolute;
        inset: 0;
        pointer-events: none;
      }

      .oni-treasure-roulette-overlay .oni-roulette-panel {
        position: absolute;
        width: var(--oni-panel-w, 250px);
        height: var(--oni-panel-h, 66px);

        background: ${colors.panelBg};
        border-radius: 10px;
        box-shadow:
          0 10px 20px rgba(0,0,0,0.25),
          inset 0 0 0 2px rgba(60,35,20,0.25);

        display: flex;
        align-items: center;
        gap: 12px;
        padding: 9px 13px;
        box-sizing: border-box;

        transform: translate(-50%, -50%);
        opacity: ${PANEL_DIM_OPACITY};
        filter: brightness(1);
        transition:
          opacity 140ms ease,
          filter 140ms ease,
          transform 140ms ease;
      }

      .oni-treasure-roulette-overlay .oni-roulette-panel .oni-roulette-looticon {
        width: calc(var(--oni-panel-h, 66px) * 0.70);
        height: calc(var(--oni-panel-h, 66px) * 0.70);
        object-fit: contain;

        background: transparent !important;
        border: 0 !important;
        outline: 0 !important;
        box-shadow: none !important;

        filter: drop-shadow(0 2px 2px rgba(0,0,0,0.25));
      }

      .oni-treasure-roulette-overlay .oni-roulette-panel .oni-roulette-lootname {
        flex: 1;
        font-family: "Signika", "Modesto Condensed", "Palatino Linotype", serif;
        font-size: calc(var(--oni-panel-h, 66px) * 0.36);
        color: ${colors.panelText};
        letter-spacing: 0.3px;
        text-shadow: 0 2px 0 rgba(0,0,0,0.15);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .oni-treasure-roulette-overlay .oni-roulette-panel.oni-selected {
        opacity: 1;
        filter: brightness(${PANEL_SELECTED_BRIGHTNESS});
        box-shadow:
          0 14px 26px rgba(0,0,0,0.35),
          0 0 0 3px rgba(255, 235, 185, 0.55),
          inset 0 0 0 2px rgba(60,35,20,0.25);
        transform: translate(-50%, -50%) scale(1.03);
      }

      .oni-treasure-roulette-overlay, .oni-treasure-roulette-overlay * {
        user-select: none;
      }
    `;
    document.head.appendChild(style);
  }

  function buildOverlay(overlayId, lootTypeIcon) {
    const overlay = document.createElement("div");
    overlay.id = overlayId;
    overlay.className = "oni-treasure-roulette-overlay";

    const dim = document.createElement("div");
    dim.className = "oni-roulette-dim";

    const stage = document.createElement("div");
    stage.className = "oni-roulette-stage";

    const ring = document.createElement("div");
    ring.className = "oni-roulette-ring";

    const centerWrap = document.createElement("div");
    centerWrap.className = "oni-roulette-center-wrap";

    const centerImg = document.createElement("img");
    centerImg.className = "oni-roulette-center";
    centerImg.src = lootTypeIcon || DEFAULT_LOOT_TYPE_ICON;

    centerWrap.appendChild(centerImg);
    stage.appendChild(ring);
    stage.appendChild(centerWrap);

    overlay.appendChild(dim);
    overlay.appendChild(stage);

    document.body.appendChild(overlay);

    return { overlay, ring };
  }

  function createPanels(ringEl, entries) {
    const panels = entries.map((e, i) => {
      const panel = document.createElement("div");
      panel.className = "oni-roulette-panel";
      panel.dataset.index = String(i);

      const icon = document.createElement("img");
      icon.className = "oni-roulette-looticon";
      icon.src = e.icon || FALLBACK_IMG;

      const name = document.createElement("div");
      name.className = "oni-roulette-lootname";
      name.textContent = e.name || "Unknown";

      panel.appendChild(icon);
      panel.appendChild(name);
      ringEl.appendChild(panel);
      return panel;
    });
    return panels;
  }

  function applyResponsiveSizing(overlayEl, n) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const vmin = Math.min(vw, vh);

    const uiScale = clamp01((vmin - 520) / 900) * 0.45 + 0.85;
    const { panelScale, scatterMul, radiusMul, solverPasses } = computeAdaptive(n);

    const radius = vmin * RING_RADIUS_RATIO_BASE * radiusMul;
    const centerSize = vmin * CENTER_ICON_RATIO;

    const panelW = PANEL_W_BASE * uiScale * panelScale;
    const panelH = PANEL_H_BASE * uiScale * panelScale;

    overlayEl.style.setProperty("--oni-center-size", `${centerSize}px`);
    overlayEl.style.setProperty("--oni-panel-w", `${panelW}px`);
    overlayEl.style.setProperty("--oni-panel-h", `${panelH}px`);

    return { vmin, radius, panelW, panelH, scatterMul, solverPasses };
  }

  function clampToBounds(pos, panelW, panelH) {
    const w = window.innerWidth;
    const h = window.innerHeight;

    const halfW = panelW / 2;
    const halfH = panelH / 2;

    pos.x = Math.max(SCREEN_MARGIN_PX + halfW, Math.min(w - SCREEN_MARGIN_PX - halfW, pos.x));
    pos.y = Math.max(SCREEN_MARGIN_PX + halfH, Math.min(h - SCREEN_MARGIN_PX - halfH, pos.y));
  }

  function createStaggeredPositions(count, baseRadius, scatterMul) {
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;

    const ANGLE_JITTER_DEG = ANGLE_JITTER_DEG_BASE * scatterMul;
    const RADIUS_JITTER = RADIUS_JITTER_BASE * scatterMul;
    const PIXEL_JITTER = PIXEL_JITTER_BASE * scatterMul;

    const pos = [];
    for (let i = 0; i < count; i++) {
      const baseAngle = -90 + (360 / count) * i;

      const aJ = (pseudoJitter(i, 1.7) * 2 - 1) * ANGLE_JITTER_DEG;
      const rJ = (pseudoJitter(i, 3.3) * 2 - 1) * (baseRadius * RADIUS_JITTER);
      const pxJx = (pseudoJitter(i, 9.1) * 2 - 1) * PIXEL_JITTER;
      const pxJy = (pseudoJitter(i, 11.7) * 2 - 1) * PIXEL_JITTER;

      const angleDeg = baseAngle + aJ;
      const angleRad = (angleDeg * Math.PI) / 180;

      const radius = baseRadius + rJ;

      const x = cx + Math.cos(angleRad) * radius + pxJx;
      const y = cy + Math.sin(angleRad) * radius * RING_Y_SQUASH + pxJy;

      pos.push({ x, y });
    }
    return pos;
  }

  function solveOverlaps(positions, panelW, panelH, solverPasses) {
    const halfW = panelW / 2;
    const halfH = panelH / 2;

    for (let pass = 0; pass < solverPasses; pass++) {
      let moved = false;

      for (let i = 0; i < positions.length; i++) {
        for (let j = i + 1; j < positions.length; j++) {
          const a = positions[i];
          const b = positions[j];

          const dx = b.x - a.x;
          const dy = b.y - a.y;

          const overlapX = (halfW + halfW + OVERLAP_PADDING_PX) - Math.abs(dx);
          const overlapY = (halfH + halfH + OVERLAP_PADDING_PX) - Math.abs(dy);

          if (overlapX > 0 && overlapY > 0) {
            moved = true;

            if (overlapX < overlapY) {
              const push = (overlapX / 2) * SOLVER_PUSH_STRENGTH;
              const dir = dx >= 0 ? 1 : -1;
              a.x -= push * dir;
              b.x += push * dir;
            } else {
              const push = (overlapY / 2) * SOLVER_PUSH_STRENGTH;
              const dir = dy >= 0 ? 1 : -1;
              a.y -= push * dir;
              b.y += push * dir;
            }
          }
        }
      }

      for (const p of positions) clampToBounds(p, panelW, panelH);
      if (!moved) break;
    }
  }

  function applyPositionsToPanels(panels, positions) {
    for (let i = 0; i < panels.length; i++) {
      panels[i].style.left = `${positions[i].x}px`;
      panels[i].style.top = `${positions[i].y}px`;
    }
  }

  function fitLootNamesToPanels(panels) {
    for (const panel of panels) {
      const nameEl = panel.querySelector(".oni-roulette-lootname");
      if (!nameEl) continue;

      nameEl.style.fontSize = "";
      const cs = getComputedStyle(nameEl);
      let fontPx = parseFloat(cs.fontSize) || 16;

      let guard = 60;
      while (guard-- > 0 && nameEl.scrollWidth > nameEl.clientWidth && fontPx > LOOT_NAME_MIN_PX) {
        fontPx = Math.max(LOOT_NAME_MIN_PX, fontPx - 1);
        nameEl.style.fontSize = `${fontPx}px`;
      }
    }
  }

  function setSelected(panels, idx) {
    for (let i = 0; i < panels.length; i++) {
      panels[i].classList.toggle("oni-selected", i === idx);
    }
  }

  function buildNormalizedIntervals(totalSteps, spinTargetMs, anticipationStartPct, anticipationMaxMult) {
    const weights = [];
    for (let step = 1; step <= totalSteps; step++) {
      const t = step / totalSteps;

      let w = lerp(TICK_MIN_MS_BASE, TICK_MAX_MS_BASE, easeOutCubic(t));

      // Anticipation slowdown (DEMO behavior)
      if (t >= anticipationStartPct) {
        const u = (t - anticipationStartPct) / Math.max(1e-6, (1 - anticipationStartPct));
        const easedU = easeOutCubic(u);
        const mult = lerp(1.0, anticipationMaxMult, easedU);
        w *= mult;
      }

      weights.push(w);
    }

    const sum = weights.reduce((a, b) => a + b, 0);

    const targetSpinOnly = Math.max(1200, spinTargetMs - FINAL_HOLD_MS);
    const scale = targetSpinOnly / Math.max(1, sum);

    return weights.map((w) => clamp(w * scale, 18, 520));
  }

  async function spinRouletteToWinner(
    panels,
    lockedFinalIndex,
    spinTargetMs,
    tickSfx,
    tickVol,
    finalSfx,
    finalVol,
    anticipationStartPct,
    anticipationMaxMult
  ) {
    const n = panels.length;

    const startIndex = Math.floor(Math.random() * n);
    const finalIndex = clamp(lockedFinalIndex, 0, n - 1);

    const fullRotations =
      Math.floor(Math.random() * (SPIN_FULL_ROTATIONS_MAX - SPIN_FULL_ROTATIONS_MIN + 1)) +
      SPIN_FULL_ROTATIONS_MIN;

    const delta = (finalIndex - startIndex + n) % n;
    const totalSteps = fullRotations * n + delta;

    const intervals = buildNormalizedIntervals(totalSteps, spinTargetMs, anticipationStartPct, anticipationMaxMult);

    let current = startIndex;
    setSelected(panels, current);

    let lastTickAt = 0;

    for (let step = 1; step <= totalSteps; step++) {
      await sleep(intervals[step - 1]);

      current = (current + 1) % n;
      setSelected(panels, current);

      const now = performance.now();
      if (tickSfx && (now - lastTickAt) >= 28) {
        lastTickAt = now;
        playSFX(tickSfx, tickVol);
      }
    }

    setSelected(panels, finalIndex);
    playSFX(finalSfx, finalVol);

    await sleep(FINAL_HOLD_MS);
    return finalIndex;
  }

  async function easeIn(overlayEl) {
    overlayEl.classList.add("oni-in");
    await sleep(EASE_IN_MS + 40);
  }

  async function easeOutAndRemove(overlayEl) {
    overlayEl.classList.remove("oni-in");
    overlayEl.classList.add("oni-out");

    // If removal is delayed, do NOT block Foundry UI.
    try {
      overlayEl.style.pointerEvents = "none";
    } catch {}

    await sleep(EASE_OUT_MS + 60);

    try {
      overlayEl.remove();
    } catch {}
  }

  // --------------------------------------------------------------------------
  // Public: play(packet)
  // --------------------------------------------------------------------------
  async function play(packet) {
    if (!packet || !packet.requestId) return { ok: false, reason: "no-packet" };

    // Optional: let Net learn about this packet on this client (no sockets)
    try {
      window["oni.TreasureRoulette.Net"]?.registerPacket?.(packet);
    } catch {}

    const overlayId = `oni-treasure-roulette-${String(packet.requestId)}`;
    const styleId = `oni-treasure-roulette-style`; // shared style across requests

    // Prevent duplicate play on same client
    const playedKey = `oni.trui.played.${packet.requestId}`;
    if (window[playedKey]) return { ok: true, replay: true };
    window[playedKey] = true;

    // HARD CLEANUP: if a previous run failed to remove overlay, kill it now
    try {
      const stale = document.querySelectorAll(".oni-treasure-roulette-overlay");
      stale.forEach((el) => {
        try {
          el.remove();
        } catch {}
      });
    } catch {}

    const rows = Array.isArray(packet.displayPool) ? packet.displayPool : [];
    if (!rows.length) return { ok: false, reason: "empty-displayPool" };

    const winnerIndex = clamp(Number(packet?.winner?.indexInPool ?? 0), 0, rows.length - 1);

    // Packet-configurable UI/SFX
    const lootTypeIcon = String(packet?.ui?.lootTypeIcon ?? DEFAULT_LOOT_TYPE_ICON);
    const spinTargetMs = clamp(Number(packet?.spinMs ?? packet?.ui?.spinMs ?? 8000), 500, 600000);

    const anticipationStartPct = clamp(Number(packet?.ui?.anticipation?.startPct ?? 0.86), 0.80, 0.95);
    const anticipationMaxMult = clamp(Number(packet?.ui?.anticipation?.maxMult ?? 2.10), 1.10, 3.00);

    // SFX (packet override -> fallback to DEMO defaults)
    const tickSfx = String(packet?.audio?.tickSfx ?? DEFAULT_TICK_SFX);
    const finalSfx = String(packet?.audio?.finalSfx ?? DEFAULT_FINAL_SFX);

    const tickVol = clamp(Number(packet?.audio?.tickVol ?? DEFAULT_TICK_VOL), 0, 1);
    const finalVol = clamp(Number(packet?.audio?.finalVol ?? DEFAULT_FINAL_VOL), 0, 1);

    warmAudio([tickSfx, finalSfx].filter(Boolean));

    // Panel entries
    const entries = rows.map((r) => ({
      icon: r.img || FALLBACK_IMG,
      name: r.name || "Unknown"
    }));

    // Ensure style
    ensureStyleTag(styleId, { panelBg: PANEL_BG, panelText: PANEL_TEXT });

    // Build overlay
    const { overlay, ring } = buildOverlay(overlayId, lootTypeIcon);
    const panels = createPanels(ring, entries);

    const doLayout = () => {
      const { radius, panelW, panelH, scatterMul, solverPasses } = applyResponsiveSizing(overlay, panels.length);
      const positions = createStaggeredPositions(panels.length, radius, scatterMul);
      solveOverlaps(positions, panelW, panelH, solverPasses);
      applyPositionsToPanels(panels, positions);
      requestAnimationFrame(() => fitLootNamesToPanels(panels));
    };

    doLayout();
    const onResize = () => doLayout();
    window.addEventListener("resize", onResize);

    // Click dim does nothing (prevents accidental closing)
    overlay.addEventListener("mousedown", (ev) => {
      if (ev.target && ev.target.classList && ev.target.classList.contains("oni-roulette-dim")) {
        ev.stopPropagation();
      }
    });

    try {
      await easeIn(overlay);

      await spinRouletteToWinner(
        panels,
        winnerIndex,
        spinTargetMs,
        tickSfx,
        tickVol,
        finalSfx,
        finalVol,
        anticipationStartPct,
        anticipationMaxMult
      );

      await sleep(CLOSE_DELAY_MS);
    } finally {
      try {
        window.removeEventListener("resize", onResize);
      } catch {}
      try {
        await easeOutAndRemove(overlay);
      } catch {
        try {
          overlay?.remove?.();
        } catch {}
      }
    }

    return { ok: true, requestId: String(packet.requestId), winnerIndex };
  }

  window[KEY] = { play };
  console.log(`[TreasureRoulette][UI] Installed as window["${KEY}"].`);
})();
