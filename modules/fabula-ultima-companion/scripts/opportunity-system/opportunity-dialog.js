/**
 * [ONI] Opportunity System — Dialog (Wheel UI v4)
 *
 * Perspective wheel: scale and opacity are driven by Y position in the ring
 * (not circular distance). Bottom slot = closest/largest; top slot = farthest/
 * smallest. A t³ power curve creates a steep falloff so the bottom button reads
 * as clearly "in front". Z-index is updated with every scroll step so lower
 * buttons always render over upper ones, completing the 3D illusion.
 *
 * Jitter fix: description panel has a fixed height so it never causes layout
 * shifts that would move the wheel. Only `transform` and `opacity` animate on
 * the slots (no left/top transitions) — fully compositor-layer.
 *
 * CSS prefix: oni-opp-   z-index: 100020
 * Public: window["oni.OpportunityDialog"].showPicker(opts) → Promise
 */
(() => {
  const TAG      = "[ONI][OpportunitySystem:Dialog]";
  const STYLE_ID = "oni-opp-styles";

  const RING_RADIUS   = 185;   // px — wheel centre to slot centre
  const WHEEL_SIZE    = 520;   // px — container side length
  const PORTRAIT_SIZE = 92;    // px — centre portrait diameter
  const TRANSITION_MS = 260;   // ms — slot transition duration
  const SPAWN_STAGGER = 45;    // ms — per-slot spawn delay
  const SLOT_WIDTH    = 128;   // px — fixed width (prevents text-width jitter)

  // Perspective curve constants
  const MIN_SCALE   = 0.50;   // top of wheel (far)
  const MAX_SCALE   = 1.25;   // bottom of wheel (selected, close)
  const MIN_OPACITY = 0.22;   // top of wheel

  const SFX_HOVER   = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BattleCursor_4.wav";
  const SFX_SCROLL  = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BattleCursor_1.wav";
  const SFX_CONFIRM = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/check_ready.wav";
  const SFX_CANCEL  = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/bond_cleared.wav";

  const esc = s => String(s ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");

  let _lastHoverIdx   = -1;
  let _scrollThrottle = 0;

  // ── Sound ──────────────────────────────────────────────────────────────────
  function playSound(url, vol = 0.65) {
    try { (foundry.audio.AudioHelper ?? AudioHelper).play({ src: url, volume: vol, autoplay: true }, false); }
    catch (_) {}
  }

  // ── Geometry ───────────────────────────────────────────────────────────────
  // Selected slot at 6 o'clock = angle π/2 in screen coords (y-axis points down).
  function slotPos(idx, sel, N) {
    const a = (Math.PI / 2) + (idx - sel) * (2 * Math.PI / N);
    return { x: Math.cos(a) * RING_RADIUS, y: Math.sin(a) * RING_RADIUS };
  }

  function circDist(idx, sel, N) {
    const raw = ((idx - sel) % N + N) % N;
    return raw <= N / 2 ? raw : N - raw;
  }

  /**
   * Perspective visual properties — driven entirely by Y position.
   * t = 0: slot is at the top of the ring (farthest).
   * t = 1: slot is at the bottom of the ring (closest, selected).
   * t³ power curve: sharp falloff so the bottom button is noticeably larger
   * than even its immediate neighbours.
   */
  function slotVis(idx, sel, N) {
    const pos    = slotPos(idx, sel, N);
    const t      = (pos.y / RING_RADIUS + 1) * 0.5;   // 0 (top) → 1 (bottom)
    const tCube  = t * t * t;
    const scale   = MIN_SCALE   + tCube * (MAX_SCALE - MIN_SCALE);
    const opacity = MIN_OPACITY + t     * (1.0       - MIN_OPACITY);
    // z-index: higher Y = renders in front (0→1 → z 1→11)
    const zIndex  = Math.round(t * 10) + 1;
    return { scale, opacity, zIndex, isSelected: circDist(idx, sel, N) === 0 };
  }

  // ── CSS ────────────────────────────────────────────────────────────────────
  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
      /* Backdrop */
      .oni-opp-backdrop {
        position: fixed; inset: 0;
        background: rgba(0,0,0,.82);
        z-index: 100020;
        display: flex; flex-direction: column;
        align-items: center; justify-content: center;
        gap: 12px; pointer-events: auto;
        overflow-y: auto; padding: 20px 0;
      }

      /* Title */
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

      /* Wheel */
      .oni-opp-wheel {
        position: relative;
        width: ${WHEEL_SIZE}px; height: ${WHEEL_SIZE}px;
        flex-shrink: 0;
      }

      /* Actor portrait */
      .oni-opp-center {
        position: absolute; left: 50%; top: 50%;
        transform: translate(-50%, -50%);
        width: ${PORTRAIT_SIZE}px; height: ${PORTRAIT_SIZE}px;
        border-radius: 50%;
        border: 3px solid #fcd470;
        box-shadow: 0 0 22px rgba(252,212,112,.6), 0 0 44px rgba(0,0,0,.75);
        overflow: hidden; background: #1c1408;
        z-index: 6; pointer-events: none;
      }
      .oni-opp-center img, .oni-opp-center video {
        width: 100%; height: 100%; object-fit: cover;
        border: none !important; background: transparent !important;
        box-shadow: none !important; filter: none !important;
      }

      /* Slots — parchment pills, fixed width, transform-only animation */
      .oni-opp-slot {
        position: absolute;
        left: 50%; top: 50%;
        /* left / top are STATIC — all position lives inside transform */
        will-change: transform, opacity;
        width: ${SLOT_WIDTH}px; box-sizing: border-box;
        display: flex; align-items: center; justify-content: center; gap: 5px;
        padding: 6px 10px;
        border-radius: 20px; border: 2px solid rgba(91,63,38,.7);
        font-weight: 800; font-size: .76rem;
        white-space: nowrap; overflow: hidden;
        cursor: pointer; user-select: none;
        font-family: 'Signika', sans-serif;
        background: linear-gradient(180deg, #f6ebd3 0%, #eddecb 55%, #e4d0b5 100%);
        color: #3b2a19;
        box-shadow: 0 2px 8px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,248,232,.6);
      }
      .oni-opp-slot i   { flex-shrink: 0; font-size: .72rem; }
      .oni-opp-slot span { overflow: hidden; text-overflow: ellipsis; flex: 1; text-align: center; }

      /* Description panel — FIXED height prevents layout shifts that jitter the wheel */
      .oni-opp-desc {
        max-width: 440px; width: 100%;
        height: 100px; overflow: hidden;
        background: rgba(18,12,4,.92);
        border: 2px solid rgba(252,212,112,.30);
        border-radius: 12px; padding: 12px 18px;
        color: #f6ebd3; font-family: 'Signika', sans-serif;
        display: flex; flex-direction: column; gap: 5px;
        box-sizing: border-box; flex-shrink: 0;
      }
      .oni-opp-desc-header { display: flex; align-items: center; gap: 10px; }
      .oni-opp-desc-icon   { font-size: 1.35rem; flex-shrink: 0; line-height: 1; }
      .oni-opp-desc-label  { font-size: .92rem; font-weight: 900; line-height: 1.2; }
      .oni-opp-desc-text   { font-size: .78rem; opacity: .72; line-height: 1.45; }

      @keyframes oni-opp-desc-in {
        from { opacity: 0; transform: translateY(4px); }
        to   { opacity: 1; transform: translateY(0); }
      }
      .oni-opp-desc.is-updating {
        animation: oni-opp-desc-in 150ms ease-out both;
      }

      /* Footer — slim horizontal pill buttons */
      .oni-opp-footer { display: flex; gap: 12px; align-items: center; }

      .oni-opp-btn {
        padding: 7px 0; width: 150px; text-align: center;
        font-size: .82rem; font-weight: 800; letter-spacing: .04em;
        border-radius: 30px; cursor: pointer;
        font-family: 'Signika', sans-serif;
        transition: filter .1s, transform .1s;
        flex-shrink: 0;
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
        width: 120px;
      }
    `;
    document.head.appendChild(s);
  }

  // ── Slot layout — transform + z-index only ─────────────────────────────────
  function applyLayout(slots, sel, N) {
    slots.forEach((slot, i) => {
      const pos = slotPos(i, sel, N);
      const vis = slotVis(i, sel, N);
      const opt = slot._option;

      slot.style.transform = `translate(calc(-50% + ${pos.x}px), calc(-50% + ${pos.y}px)) scale(${vis.scale.toFixed(3)})`;
      slot.style.opacity   = vis.opacity.toFixed(3);
      slot.style.zIndex    = String(vis.zIndex);

      if (vis.isSelected) {
        slot.style.borderColor = opt?.color ?? "#fcd470";
        slot.style.color       = opt?.color ?? "#fcd470";
        slot.style.boxShadow   = `0 2px 8px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,248,232,.6), 0 0 16px ${opt?.color ?? "#fcd470"}55`;
        slot.classList.add("is-selected");
      } else {
        slot.style.borderColor = "rgba(91,63,38,.7)";
        slot.style.color       = "#3b2a19";
        slot.style.boxShadow   = "0 2px 8px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,248,232,.6)";
        slot.classList.remove("is-selected");
      }
    });
  }

  // ── Description refresh ────────────────────────────────────────────────────
  function refreshDesc(descEl, opt) {
    if (!descEl || !opt) return;
    descEl.classList.remove("is-updating");
    void descEl.offsetWidth;
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
  function showPicker({ actorName, actorPortrait, options, canDecline = true }) {
    ensureStyles();

    return new Promise(resolve => {
      document.getElementById("oni-opp-backdrop")?.remove();

      const N = options.length;
      let sel = 0;

      // Backdrop
      const backdrop = document.createElement("div");
      backdrop.className = "oni-opp-backdrop";
      backdrop.id = "oni-opp-backdrop";

      const titleEl = document.createElement("div");
      titleEl.className = "oni-opp-title";
      titleEl.textContent = "✦ Critical! — Spend an Opportunity";
      backdrop.appendChild(titleEl);

      if (actorName) {
        const sub = document.createElement("div");
        sub.className = "oni-opp-subtitle";
        sub.textContent = actorName;
        backdrop.appendChild(sub);
      }

      // Wheel
      const wheel = document.createElement("div");
      wheel.className = "oni-opp-wheel";

      // Centre portrait
      const center = document.createElement("div");
      center.className = "oni-opp-center";
      if (actorPortrait) {
        const isVid = /\.(webm|mp4|ogg)(\?|$)/i.test(actorPortrait);
        const media = isVid
          ? Object.assign(document.createElement("video"), { src: actorPortrait, autoplay: true, loop: true, muted: true, playsInline: true })
          : Object.assign(document.createElement("img"), { src: actorPortrait, alt: "" });
        media.onerror = () => { try { media.src = "icons/svg/mystery-man.svg"; } catch(_){} };
        center.appendChild(media);
      }
      wheel.appendChild(center);

      // Slots — start at centre (scale 0.35, opacity 0), fan out on spawn
      const SPAWN_TR = "translate(-50%, -50%) scale(0.35)";
      const UNIFORM  = `transform ${TRANSITION_MS}ms ease-out, opacity 200ms ease-out`;

      const slots = options.map((opt, i) => {
        const slot = document.createElement("div");
        slot.className = "oni-opp-slot";
        slot.innerHTML = `<i class="fas ${esc(opt.icon ?? "fa-star")}"></i><span>${esc(opt.label)}</span>`;
        slot._option = opt;
        slot._idx    = i;
        slot.style.left      = "50%";
        slot.style.top       = "50%";
        slot.style.transform = SPAWN_TR;
        slot.style.opacity   = "0";
        slot.style.transition = "none";
        wheel.appendChild(slot);
        return slot;
      });

      backdrop.appendChild(wheel);

      // Description — fixed height so it never shifts the wheel
      const descEl = document.createElement("div");
      descEl.className = "oni-opp-desc";
      descEl.innerHTML = `
        <div class="oni-opp-desc-header">
          <div class="oni-opp-desc-icon"></div>
          <div class="oni-opp-desc-label"></div>
        </div>
        <div class="oni-opp-desc-text"></div>`;
      backdrop.appendChild(descEl);

      // Footer
      const footer    = document.createElement("div");
      footer.className = "oni-opp-footer";
      const spendBtn  = document.createElement("button");
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

      refreshDesc(descEl, options[sel]);

      // ── Spawn fan-out ──────────────────────────────────────────────────────
      requestAnimationFrame(() => requestAnimationFrame(() => {
        // Stagger-in with per-slot delays
        slots.forEach((slot, i) => {
          const d = i * SPAWN_STAGGER;
          slot.style.transition = `transform ${TRANSITION_MS}ms ease-out ${d}ms, opacity 200ms ease-out ${d}ms`;
        });
        applyLayout(slots, sel, N);

        // After all slots land, replace stagger with uniform transition
        const spawnDone = SPAWN_STAGGER * (N - 1) + TRANSITION_MS + 80;
        setTimeout(() => slots.forEach(sl => { sl.style.transition = UNIFORM; }), spawnDone);
      }));

      // ── Selection ─────────────────────────────────────────────────────────
      function changeSel(newIdx, sfx = true) {
        const ns = ((newIdx % N) + N) % N;
        if (ns === sel) return;
        sel = ns;
        if (sfx) playSound(SFX_SCROLL, 0.6);
        applyLayout(slots, sel, N);
        refreshDesc(descEl, options[sel]);
      }

      // Mouse wheel
      backdrop.addEventListener("wheel", e => {
        e.preventDefault();
        const now = Date.now();
        if (now - _scrollThrottle < 180) return;
        _scrollThrottle = now;
        changeSel(sel + (e.deltaY > 0 ? 1 : -1));
      }, { passive: false });

      // Slot hover + click
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

      // Keyboard
      const onKey = e => {
        if      (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); changeSel(sel + 1); }
        else if (e.key === "ArrowLeft"  || e.key === "ArrowUp")   { e.preventDefault(); changeSel(sel - 1); }
        else if (e.key === "Enter")                                { e.preventDefault(); spendBtn.click(); }
        else if (e.key === "Escape")                               { e.preventDefault(); (declineBtn ?? spendBtn).click(); }
      };
      document.addEventListener("keydown", onKey);

      // Spend
      spendBtn.addEventListener("click", async () => {
        if (spendBtn.disabled) return;
        spendBtn.disabled = true;
        if (declineBtn) declineBtn.disabled = true;
        playSound(SFX_CONFIRM, 0.8);
        await showFlash();
        cleanup();
        resolve({ optionId: options[sel].id });
      });

      // Decline
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
  console.debug(`${TAG} Ready (Wheel UI v4 — perspective + fixed-height desc).`);
})();
