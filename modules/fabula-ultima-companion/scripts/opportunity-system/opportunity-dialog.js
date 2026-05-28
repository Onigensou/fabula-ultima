/**
 * [ONI] Opportunity System — Dialog (Wheel UI v3)
 *
 * Stability fix: slot positions are encoded entirely in `transform` — `left` and `top`
 * are set once to 50%/50% and never change. Only `transform` and `opacity` animate,
 * which are GPU-composited and cause zero layout reflow. This eliminates the jitter
 * that occurred when text-width differences interacted with left/top transitions.
 *
 * Slot width is fixed (128px) so scale changes never shift neighbouring items.
 *
 * Visual: parchment-style pills (warm gradient, dark brown text) on dark backdrop —
 * matches the existing CheckRequester / reaction-window aesthetic, but the light
 * buttons contrast well against the dark opportunity backdrop.
 *
 * CSS prefix: oni-opp-   z-index: 100020
 * Public: window["oni.OpportunityDialog"].showPicker(opts) → Promise
 */
(() => {
  const TAG      = "[ONI][OpportunitySystem:Dialog]";
  const STYLE_ID = "oni-opp-styles";

  const RING_RADIUS   = 185;  // px — wheel center to slot center
  const WHEEL_SIZE    = 520;  // px — container (RING_RADIUS × 2 + slot-half-width × 2 + padding)
  const PORTRAIT_SIZE = 92;   // px — center portrait diameter
  const TRANSITION_MS = 260;  // ms — slot transform/opacity transition
  const SPAWN_STAGGER = 45;   // ms — per-slot delay during fan-out spawn
  const SLOT_WIDTH    = 128;  // px — fixed slot width (prevents text-width jitter)

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
  // Selected slot at 6 o'clock = angle π/2 (y increases downward in screen coords).
  function slotPos(idx, sel, N) {
    const a = (Math.PI / 2) + (idx - sel) * (2 * Math.PI / N);
    return { x: Math.cos(a) * RING_RADIUS, y: Math.sin(a) * RING_RADIUS };
  }

  function circDist(idx, sel, N) {
    const raw = ((idx - sel) % N + N) % N;
    return raw <= N / 2 ? raw : N - raw;
  }

  function slotVis(idx, sel, N) {
    const d = circDist(idx, sel, N);
    return {
      opacity:    d === 0 ? 1.0 : d === 1 ? 0.65 : d <= 3 ? 0.42 : 0.25,
      scale:      d === 0 ? 1.16 : d === 1 ? 1.0 : 0.88,
      isSelected: d === 0,
    };
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
        background: rgba(0,0,0,.8);
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

      /* Wheel container */
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
        z-index: 2; pointer-events: none;
      }
      .oni-opp-center img, .oni-opp-center video {
        width: 100%; height: 100%; object-fit: cover;
        border: none !important; background: transparent !important;
        box-shadow: none !important; filter: none !important;
      }

      /* Option slots — parchment pills, FIXED width to prevent text-width jitter */
      .oni-opp-slot {
        position: absolute;
        left: 50%; top: 50%;   /* STATIC — never changed after mount */
        /* transform is the ONLY animated property for position; no left/top animation */
        will-change: transform, opacity;
        width: ${SLOT_WIDTH}px;
        display: flex; align-items: center; justify-content: center; gap: 5px;
        padding: 6px 10px; box-sizing: border-box;
        border-radius: 20px; border: 2px solid rgba(91,63,38,.7);
        font-weight: 800; font-size: .76rem;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        cursor: pointer; user-select: none;
        font-family: 'Signika', sans-serif;
        /* Warm parchment — contrasts strongly against dark backdrop */
        background: linear-gradient(180deg, #f6ebd3 0%, #eddecb 55%, #e4d0b5 100%);
        color: #3b2a19;
        box-shadow:
          0 2px 8px rgba(0,0,0,.45),
          inset 0 1px 0 rgba(255,248,232,.6);
        z-index: 1;
        /* transition injected via JS during spawn, then replaced with uniform */
      }
      .oni-opp-slot i {
        flex-shrink: 0;
        font-size: .74rem;
      }
      .oni-opp-slot span {
        overflow: hidden; text-overflow: ellipsis; flex: 1; text-align: center;
      }

      /* Description panel */
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

      /* Footer */
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

  // ── Slot layout — transform only, no left/top ──────────────────────────────
  // Slots have left:50% top:50% permanently. All X/Y positioning lives inside transform.
  function applyLayout(slots, sel, N) {
    slots.forEach((slot, i) => {
      const pos = slotPos(i, sel, N);
      const vis = slotVis(i, sel, N);
      const opt = slot._option;

      slot.style.transform = `translate(calc(-50% + ${pos.x}px), calc(-50% + ${pos.y}px)) scale(${vis.scale})`;
      slot.style.opacity   = String(vis.opacity);

      if (vis.isSelected) {
        slot.style.borderColor = opt?.color ?? "#fcd470";
        slot.style.color       = opt?.color ?? "#fcd470";
        slot.style.boxShadow   = `0 2px 8px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,248,232,.6), 0 0 14px ${opt?.color ?? "#fcd470"}55`;
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

      // Center portrait
      const center = document.createElement("div");
      center.className = "oni-opp-center";
      if (actorPortrait) {
        const isVid = /\.(webm|mp4|ogg)(\?|$)/i.test(actorPortrait);
        const media = isVid
          ? Object.assign(document.createElement("video"), { src: actorPortrait, autoplay: true, loop: true, muted: true, playsInline: true })
          : Object.assign(document.createElement("img"),  { src: actorPortrait, alt: "" });
        media.onerror = () => { try { media.src = "icons/svg/mystery-man.svg"; } catch(_){} };
        center.appendChild(media);
      }
      wheel.appendChild(center);

      // Slots — left:50% top:50% are set once and never changed
      // spawn starts at transform: translate(-50%,-50%) scale(0.35), opacity 0
      const SPAWN_TRANSFORM = "translate(-50%, -50%) scale(0.35)";
      const slots = options.map((opt, i) => {
        const slot = document.createElement("div");
        slot.className = "oni-opp-slot";
        // Icon + label — both inside, flex handles layout
        slot.innerHTML = `<i class="fas ${esc(opt.icon ?? "fa-star")}"></i><span>${esc(opt.label)}</span>`;
        slot._option = opt;
        slot._idx    = i;
        slot.style.left      = "50%";
        slot.style.top       = "50%";
        slot.style.transform = SPAWN_TRANSFORM;
        slot.style.opacity   = "0";
        slot.style.transition = "none";
        wheel.appendChild(slot);
        return slot;
      });

      backdrop.appendChild(wheel);

      // Description
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
      const footer = document.createElement("div");
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

      refreshDesc(descEl, options[sel]);

      // ── Spawn fan-out ──────────────────────────────────────────────────────
      // Double rAF ensures browser commits left:50% top:50% + spawn transform
      // before the transitions fire, so all slots animate from center outward.
      const UNIFORM_TR = `transform ${TRANSITION_MS}ms ease-out, opacity 200ms ease-out`;

      requestAnimationFrame(() => requestAnimationFrame(() => {
        // Staggered per-slot transitions for the spawn fan
        slots.forEach((slot, i) => {
          const d = i * SPAWN_STAGGER;
          slot.style.transition = `transform ${TRANSITION_MS}ms ease-out ${d}ms, opacity 200ms ease-out ${d}ms`;
        });
        // Apply final ring positions (sets transform only)
        applyLayout(slots, sel, N);

        // After all slots land, replace stagger delays with the uniform transition
        const spawnDone = SPAWN_STAGGER * (N - 1) + TRANSITION_MS + 80;
        setTimeout(() => slots.forEach(sl => { sl.style.transition = UNIFORM_TR; }), spawnDone);
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
  console.debug(`${TAG} Ready (Wheel UI v3 — transform-only, parchment slots).`);
})();
