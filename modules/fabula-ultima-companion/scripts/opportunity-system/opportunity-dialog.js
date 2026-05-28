/**
 * [ONI] Opportunity System — Dialog (Wheel UI v2)
 *
 * Radial wheel layout: actor portrait at center, 12 option pills arranged in a ring.
 * - Fan-out spawn: slots fly outward from center with a staggered ease-out.
 * - Mouse wheel / arrow keys cycle selection; selected slot is always at 6 o'clock.
 * - Clicking any slot jumps it to the bottom.
 * - Hovering plays cursor sound; scrolling plays shuffle sound.
 * - "Spend" triggers a screen flash, confirm sound, then resolves.
 * - "Decline" / ESC resolves cancelled.
 *
 * CSS prefix: oni-opp-   z-index: 100020
 * Public: window["oni.OpportunityDialog"].showPicker(opts) → Promise
 */
(() => {
  const TAG      = "[ONI][OpportunitySystem:Dialog]";
  const STYLE_ID = "oni-opp-styles";

  const RING_RADIUS   = 170;  // px — center of wheel to center of each slot
  const WHEEL_SIZE    = 500;  // px — wheel container (must fit RING_RADIUS + largest slot half-width)
  const PORTRAIT_SIZE = 90;   // px — actor portrait diameter
  const TRANSITION_MS = 260;  // ms — slot position/opacity transition
  const SPAWN_STAGGER = 45;   // ms — per-slot delay during fan-out

  const SFX_HOVER   = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BattleCursor_4.wav";
  const SFX_SCROLL  = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BattleCursor_1.wav";
  const SFX_CONFIRM = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/check_ready.wav";
  const SFX_CANCEL  = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/bond_cleared.wav";

  const esc = s => String(s ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");

  let _lastHoverIdx    = -1;  // tracks last hovered slot index to debounce hover SFX
  let _scrollThrottle  = 0;   // timestamp of last scroll step

  // ── Sound ──────────────────────────────────────────────────────────────────
  function playSound(url, vol = 0.65) {
    try { (foundry.audio.AudioHelper ?? AudioHelper).play({ src: url, volume: vol, autoplay: true }, false); }
    catch (_) {}
  }

  // ── Geometry ───────────────────────────────────────────────────────────────
  // Selected slot lives at 6 o'clock → angle = π/2 in screen coords (y increases down).
  // Other slots fan around it: slot i has angle = π/2 + (i − sel) × 2π/N.
  function slotPos(idx, sel, N) {
    const a = (Math.PI / 2) + (idx - sel) * (2 * Math.PI / N);
    return { x: Math.cos(a) * RING_RADIUS, y: Math.sin(a) * RING_RADIUS };
  }

  // Circular (shortest-path) distance from idx to sel.
  function circDist(idx, sel, N) {
    const raw = ((idx - sel) % N + N) % N;
    return raw <= N / 2 ? raw : N - raw;
  }

  // Visual weight based on distance from selected.
  function slotVis(idx, sel, N) {
    const d = circDist(idx, sel, N);
    return {
      opacity:    d === 0 ? 1.0 : d === 1 ? 0.55 : d <= 3 ? 0.35 : 0.22,
      scale:      d === 0 ? 1.18 : d === 1 ? 1.0 : 0.87,
      isSelected: d === 0,
    };
  }

  // ── CSS ────────────────────────────────────────────────────────────────────
  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
      /* ── Backdrop ─────────────────────────────────────────────────── */
      .oni-opp-backdrop {
        position: fixed; inset: 0;
        background: rgba(0,0,0,.8);
        z-index: 100020;
        display: flex; flex-direction: column;
        align-items: center; justify-content: center;
        gap: 12px; pointer-events: auto;
        overflow-y: auto; padding: 20px 0;
      }

      /* ── Title ────────────────────────────────────────────────────── */
      .oni-opp-title {
        font-family: 'Palatino Linotype', Palatino, serif;
        font-size: 1.05rem; font-weight: 900; color: #fcd470;
        text-shadow: 0 0 18px rgba(252,212,112,.55), 0 1px 4px rgba(0,0,0,.85);
        letter-spacing: .08em; text-align: center;
      }
      .oni-opp-subtitle {
        font-family: 'Signika', sans-serif;
        font-size: .82rem; color: #f6ebd3; opacity: .58;
        margin-top: -8px; text-align: center;
      }

      /* ── Wheel container ──────────────────────────────────────────── */
      .oni-opp-wheel {
        position: relative;
        width: ${WHEEL_SIZE}px; height: ${WHEEL_SIZE}px;
        flex-shrink: 0;
      }

      /* ── Center actor portrait ────────────────────────────────────── */
      .oni-opp-center {
        position: absolute; left: 50%; top: 50%;
        transform: translate(-50%, -50%);
        width: ${PORTRAIT_SIZE}px; height: ${PORTRAIT_SIZE}px;
        border-radius: 50%;
        border: 3px solid #fcd470;
        box-shadow: 0 0 22px rgba(252,212,112,.6), 0 0 44px rgba(0,0,0,.75);
        overflow: hidden; background: #1c1408;
        z-index: 2; pointer-events: none;
      }
      .oni-opp-center img, .oni-opp-center video {
        width: 100%; height: 100%; object-fit: cover;
        border: none !important; background: transparent !important;
        box-shadow: none !important; filter: none !important;
      }

      /* ── Option slots (pills) ─────────────────────────────────────── */
      .oni-opp-slot {
        position: absolute;
        padding: 5px 15px;
        border-radius: 20px;
        border: 2px solid;
        font-weight: 800; font-size: .76rem; white-space: nowrap;
        cursor: pointer; user-select: none;
        font-family: 'Signika', sans-serif;
        background: rgba(18, 12, 4, 0.90);
        backdrop-filter: blur(6px);
        z-index: 1;
        /* transition is set via JS per-slot during spawn, then switched to uniform */
      }

      /* ── Description panel ────────────────────────────────────────── */
      .oni-opp-desc {
        max-width: 440px; width: 100%;
        background: rgba(18,12,4,.92);
        border: 2px solid rgba(252,212,112,.30);
        border-radius: 12px; padding: 12px 18px;
        color: #f6ebd3; font-family: 'Signika', sans-serif;
        min-height: 74px;
        display: flex; flex-direction: column; gap: 5px;
      }
      .oni-opp-desc-header { display: flex; align-items: center; gap: 10px; }
      .oni-opp-desc-icon   { font-size: 1.35rem; flex-shrink: 0; line-height: 1; }
      .oni-opp-desc-label  { font-size: .92rem; font-weight: 900; line-height: 1.2; }
      .oni-opp-desc-text   { font-size: .78rem; opacity: .72; line-height: 1.45; }

      @keyframes oni-opp-desc-in {
        from { opacity: 0; transform: translateY(5px); }
        to   { opacity: 1; transform: translateY(0); }
      }
      .oni-opp-desc.is-updating {
        animation: oni-opp-desc-in 160ms ease-out both;
      }

      /* ── Footer ───────────────────────────────────────────────────── */
      .oni-opp-footer { display: flex; gap: 14px; }
      .oni-opp-btn {
        padding: 8px 26px; font-size: .86rem; font-weight: 800;
        border-radius: 10px; cursor: pointer;
        font-family: 'Signika', sans-serif; letter-spacing: .03em;
        transition: filter .1s, transform .1s;
      }
      .oni-opp-btn:hover:not(:disabled) { filter: brightness(1.1); transform: translateY(-1px); }
      .oni-opp-btn:disabled { opacity: .38; cursor: not-allowed; transform: none; filter: none; }
      .oni-opp-btn-spend {
        background: linear-gradient(180deg, #d4a017, #a87800);
        border: 2px solid #a87800; color: #fff;
        box-shadow: 0 3px 10px rgba(0,0,0,.3);
      }
      .oni-opp-btn-decline {
        background: linear-gradient(180deg, #f6ebd3, #d9c4a4);
        border: 2px solid rgba(91,63,38,.75); color: #3b2a19;
      }
    `;
    document.head.appendChild(s);
  }

  // ── Apply slot layout (positions + visual weights) ─────────────────────────
  // Does NOT set transition — caller manages that.
  function applyLayout(slots, sel, N) {
    slots.forEach((slot, i) => {
      const pos = slotPos(i, sel, N);
      const vis = slotVis(i, sel, N);
      const opt = slot._option;

      slot.style.left      = `calc(50% + ${pos.x}px)`;
      slot.style.top       = `calc(50% + ${pos.y}px)`;
      slot.style.transform = `translate(-50%,-50%) scale(${vis.scale})`;
      slot.style.opacity   = String(vis.opacity);

      if (vis.isSelected) {
        slot.style.borderColor = opt?.color ?? "#fcd470";
        slot.style.color       = opt?.color ?? "#fcd470";
        slot.style.boxShadow   = `0 0 14px ${opt?.color ?? "#fcd470"}55`;
        slot.classList.add("is-selected");
      } else {
        slot.style.borderColor = "rgba(252,212,112,.26)";
        slot.style.color       = "rgba(246,235,211,.68)";
        slot.style.boxShadow   = "none";
        slot.classList.remove("is-selected");
      }
    });
  }

  // ── Description refresh ────────────────────────────────────────────────────
  function refreshDesc(descEl, opt) {
    if (!descEl || !opt) return;
    descEl.classList.remove("is-updating");
    void descEl.offsetWidth; // restart animation
    descEl.classList.add("is-updating");
    const iconEl  = descEl.querySelector(".oni-opp-desc-icon");
    const labelEl = descEl.querySelector(".oni-opp-desc-label");
    const textEl  = descEl.querySelector(".oni-opp-desc-text");
    if (iconEl)  iconEl.innerHTML  = `<i class="fas ${esc(opt.icon ?? "fa-star")}" style="color:${esc(opt.color ?? "#fcd470")}"></i>`;
    if (labelEl) { labelEl.textContent = opt.label; labelEl.style.color = opt.color ?? "#fcd470"; }
    if (textEl)  textEl.textContent = opt.description;
  }

  // ── Screen flash ───────────────────────────────────────────────────────────
  function showFlash(color = "rgba(255,248,200,0.55)") {
    return new Promise(res => {
      const el = document.createElement("div");
      Object.assign(el.style, {
        position:"fixed", inset:"0", zIndex:"100025",
        pointerEvents:"none", background:color, opacity:"0",
      });
      document.body.appendChild(el);
      requestAnimationFrame(() => {
        el.style.transition = "opacity 55ms ease-in";
        requestAnimationFrame(() => {
          el.style.opacity = "1";
          setTimeout(() => {
            el.style.transition = "opacity 340ms ease-out";
            el.style.opacity = "0";
            setTimeout(() => { el.remove(); res(); }, 400);
          }, 78);
        });
      });
    });
  }

  // ── Main showPicker ────────────────────────────────────────────────────────
  /**
   * @param {object}  opts
   * @param {string}  opts.actorName      Display name shown as subtitle
   * @param {string}  [opts.actorPortrait] URL of actor portrait
   * @param {Array}   opts.options         OpportunityConfig.OPTIONS
   * @param {boolean} [opts.canDecline]    Show Decline button (default true)
   * @returns {Promise<{optionId:string}|{cancelled:true}>}
   */
  function showPicker({ actorName, actorPortrait, options, canDecline = true }) {
    ensureStyles();

    return new Promise(resolve => {
      // Remove any stale picker
      document.getElementById("oni-opp-backdrop")?.remove();

      const N = options.length;
      let sel = 0; // currently selected index (slot at 6 o'clock)

      // ── Backdrop ─────────────────────────────────────────────────────────
      const backdrop = document.createElement("div");
      backdrop.className = "oni-opp-backdrop";
      backdrop.id = "oni-opp-backdrop";

      const titleEl = document.createElement("div");
      titleEl.className = "oni-opp-title";
      titleEl.textContent = "✦ Critical! — Spend an Opportunity";
      backdrop.appendChild(titleEl);

      if (actorName) {
        const subEl = document.createElement("div");
        subEl.className = "oni-opp-subtitle";
        subEl.textContent = actorName;
        backdrop.appendChild(subEl);
      }

      // ── Wheel ─────────────────────────────────────────────────────────────
      const wheel = document.createElement("div");
      wheel.className = "oni-opp-wheel";

      // Center portrait
      const centerEl = document.createElement("div");
      centerEl.className = "oni-opp-center";
      if (actorPortrait) {
        const isVid = /\.(webm|mp4|ogg)(\?|$)/i.test(actorPortrait);
        const media = isVid
          ? Object.assign(document.createElement("video"), { src: actorPortrait, autoplay: true, loop: true, muted: true, playsInline: true })
          : Object.assign(document.createElement("img"), { src: actorPortrait, alt: "" });
        media.onerror = () => { try { media.src = "icons/svg/mystery-man.svg"; } catch(_){} };
        centerEl.appendChild(media);
      }
      wheel.appendChild(centerEl);

      // Slots — all start at center (opacity 0, scale 0.5) for spawn animation
      const slots = options.map((opt, i) => {
        const slot = document.createElement("div");
        slot.className = "oni-opp-slot";
        slot.textContent = opt.label;
        slot._option = opt;
        slot._idx    = i;
        slot.style.transition  = "none";
        slot.style.left        = "50%";
        slot.style.top         = "50%";
        slot.style.transform   = "translate(-50%,-50%) scale(0.4)";
        slot.style.opacity     = "0";
        slot.style.borderColor = "rgba(252,212,112,.26)";
        slot.style.color       = "rgba(246,235,211,.68)";
        wheel.appendChild(slot);
        return slot;
      });

      backdrop.appendChild(wheel);

      // ── Description panel ─────────────────────────────────────────────────
      const descEl = document.createElement("div");
      descEl.className = "oni-opp-desc";
      descEl.innerHTML = `
        <div class="oni-opp-desc-header">
          <div class="oni-opp-desc-icon"></div>
          <div class="oni-opp-desc-label"></div>
        </div>
        <div class="oni-opp-desc-text"></div>`;
      backdrop.appendChild(descEl);

      // ── Footer ────────────────────────────────────────────────────────────
      const footer    = document.createElement("div");
      footer.className = "oni-opp-footer";

      const spendBtn = document.createElement("button");
      spendBtn.className = "oni-opp-btn oni-opp-btn-spend";
      spendBtn.textContent = "✦ Spend";
      footer.appendChild(spendBtn);

      let declineBtn = null;
      if (canDecline) {
        declineBtn = document.createElement("button");
        declineBtn.className = "oni-opp-btn oni-opp-btn-decline";
        declineBtn.textContent = "Decline";
        footer.appendChild(declineBtn);
      }
      backdrop.appendChild(footer);
      document.body.appendChild(backdrop);

      // Initial description (selected = index 0)
      refreshDesc(descEl, options[sel]);

      // ── Spawn fan-out animation ───────────────────────────────────────────
      // Double rAF so the browser commits `left:50%; top:50%` before transitioning.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        // Apply per-slot staggered transitions, then final positions + opacities
        slots.forEach((slot, i) => {
          const delay = i * SPAWN_STAGGER;
          slot.style.transition = [
            `left ${TRANSITION_MS}ms ease-out ${delay}ms`,
            `top ${TRANSITION_MS}ms ease-out ${delay}ms`,
            `transform ${TRANSITION_MS}ms ease-out ${delay}ms`,
            `opacity 200ms ease-out ${delay}ms`,
          ].join(",");
        });
        applyLayout(slots, sel, N);

        // After all slots have arrived, replace per-slot delays with a uniform transition
        const spawnTotal = SPAWN_STAGGER * (N - 1) + TRANSITION_MS + 80;
        const uniformTr  = [
          `left ${TRANSITION_MS}ms ease-out`,
          `top ${TRANSITION_MS}ms ease-out`,
          `transform ${TRANSITION_MS}ms ease-out`,
          `opacity 200ms ease-out`,
        ].join(",");
        setTimeout(() => slots.forEach(sl => { sl.style.transition = uniformTr; }), spawnTotal);
      }));

      // ── Selection helper ──────────────────────────────────────────────────
      function changeSel(newIdx, sfx = true) {
        const ns = ((newIdx % N) + N) % N;
        if (ns === sel) return;
        sel = ns;
        if (sfx) playSound(SFX_SCROLL, 0.6);
        applyLayout(slots, sel, N);
        refreshDesc(descEl, options[sel]);
      }

      // ── Mouse wheel scroll ────────────────────────────────────────────────
      backdrop.addEventListener("wheel", e => {
        e.preventDefault();
        const now = Date.now();
        if (now - _scrollThrottle < 180) return;
        _scrollThrottle = now;
        changeSel(sel + (e.deltaY > 0 ? 1 : -1));
      }, { passive: false });

      // ── Slot hover + click ────────────────────────────────────────────────
      slots.forEach((slot, i) => {
        slot.addEventListener("mouseenter", () => {
          if (_lastHoverIdx === i) return;
          _lastHoverIdx = i;
          playSound(SFX_HOVER, 0.45);
        });
        slot.addEventListener("mouseleave", () => {
          if (_lastHoverIdx === i) _lastHoverIdx = -1;
        });
        slot.addEventListener("click", () => changeSel(i));
      });

      // ── Keyboard navigation ───────────────────────────────────────────────
      const onKey = e => {
        if      (e.key === "ArrowRight" || e.key === "ArrowDown")  { e.preventDefault(); changeSel(sel + 1); }
        else if (e.key === "ArrowLeft"  || e.key === "ArrowUp")    { e.preventDefault(); changeSel(sel - 1); }
        else if (e.key === "Enter")                                 { e.preventDefault(); spendBtn.click(); }
        else if (e.key === "Escape")                                { e.preventDefault(); (declineBtn ?? spendBtn).click(); }
      };
      document.addEventListener("keydown", onKey);

      // ── Spend ─────────────────────────────────────────────────────────────
      spendBtn.addEventListener("click", async () => {
        if (spendBtn.disabled) return;
        spendBtn.disabled = true;
        if (declineBtn) declineBtn.disabled = true;
        playSound(SFX_CONFIRM, 0.8);
        await showFlash();
        cleanup();
        resolve({ optionId: options[sel].id });
      });

      // ── Decline ───────────────────────────────────────────────────────────
      if (declineBtn) {
        declineBtn.addEventListener("click", () => {
          playSound(SFX_CANCEL, 0.65);
          cleanup();
          resolve({ cancelled: true });
        });
      }

      function cleanup() {
        document.removeEventListener("keydown", onKey);
        backdrop.remove();
      }
    });
  }

  window["oni.OpportunityDialog"] = Object.freeze({ showPicker });
  console.debug(`${TAG} Ready (Wheel UI v2).`);
})();
