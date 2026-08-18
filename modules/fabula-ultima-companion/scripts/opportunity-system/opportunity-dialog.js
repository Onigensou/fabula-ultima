/**
 * [ONI] Opportunity System — Dialog (Wheel UI v5)
 *
 * Flat circular wheel — no pseudo-perspective.
 *
 * Focus mechanics:
 *   - The selected slot lives on a LARGER radius (RING_SELECTED) than the other
 *     11 slots (RING_NORMAL). It "pops out" of the ring, creating clear vertical
 *     separation from its neighbours (no overlap even at the bottom).
 *   - Distance-based scale + opacity: selected is notably larger/brighter; the
 *     falloff is steep enough to read as a clear hierarchy without perspective.
 *   - Z-index follows circular distance so the selected always renders in front.
 *
 * Stability:
 *   - Only `transform` and `opacity` animate (no left/top transitions).
 *   - Description panel has a fixed height — never shifts the wheel.
 *
 * Two wheels share one builder:
 *   showPicker()    — the owner's interactive wheel, resolves a Promise.
 *   showSpectator() — the read-only mirror everyone else watches.
 *
 * CSS prefix: oni-opp-   z-index: 100020
 * Public: window["oni.OpportunityDialog"]
 */
(() => {
  const TAG      = "[ONI][OpportunitySystem:Dialog]";
  const STYLE_ID = "oni-opp-styles";

  // `let` so the tuner can override them live at showPicker() time
  let RING_NORMAL   = 245;  // px — radius for all non-selected slots
  let RING_SELECTED = 280;  // px — radius for the selected slot (pushed further out)
  let WHEEL_SIZE    = 645;  // px — container (must fit RING_SELECTED + half-slot-width + buffer)
  let PORTRAIT_IMG  = 170;  // px — full-sprite image area (unclipped, transparent bg)
  let TRANSITION_MS = 260;  // ms — slot transition
  let SPAWN_STAGGER = 50;   // ms — per-slot spawn delay
  let SLOT_WIDTH    = 140;  // px — fixed slot width

  // Distance-based visual table (index = circular distance from selected)
  let VIS = [
    { scale: 1.73, opacity: 1.00, zIndex: 11 },  // dist 0 — selected
    { scale: 1.11, opacity: 0.97, zIndex:  8 },  // dist 1
    { scale: 0.92, opacity: 0.86, zIndex:  6 },  // dist 2
    { scale: 0.82, opacity: 0.67, zIndex:  4 },  // dist 3
    { scale: 0.80, opacity: 0.48, zIndex:  3 },  // dist 4
    { scale: 0.78, opacity: 0.20, zIndex:  2 },  // dist 5+
  ];

  // ── Tuner override ─────────────────────────────────────────────────────────
  // Reads window["oni.OpportunityTuner"] and replaces module-level vars.
  // Called at the top of showPicker() so every open reflects latest tuner values.
  function applyTunerOverrides() {
    const T = window["oni.OpportunityTuner"];
    if (!T) return;
    if (T.RING_NORMAL   != null) RING_NORMAL   = Number(T.RING_NORMAL);
    if (T.RING_SELECTED != null) RING_SELECTED = Number(T.RING_SELECTED);
    if (T.WHEEL_SIZE    != null) WHEEL_SIZE    = Number(T.WHEEL_SIZE);
    if (T.PORTRAIT_IMG  != null) PORTRAIT_IMG  = Number(T.PORTRAIT_IMG);
    if (T.TRANSITION_MS != null) TRANSITION_MS = Number(T.TRANSITION_MS);
    if (T.SPAWN_STAGGER != null) SPAWN_STAGGER = Number(T.SPAWN_STAGGER);
    if (T.SLOT_WIDTH    != null) SLOT_WIDTH    = Number(T.SLOT_WIDTH);
    if (Array.isArray(T.VIS))    VIS           = T.VIS;
  }

  const SFX_HOVER          = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BattleCursor_4.wav";
  const SFX_SCROLL         = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BattleCursor_1.wav";
  const SFX_CONFIRM        = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/opportunity_confirmed.wav";
  const SFX_LESSER_CONFIRM = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BattleCursor_2.wav";
  const SFX_CANCEL         = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/bond_cleared.wav";
  const SFX_OPEN           = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/opportunity_menu.wav";

  const esc = s => String(s ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");

  let _lastHoverIdx   = -1;
  let _scrollThrottle = 0;

  // ── Sound ──────────────────────────────────────────────────────────────────
  function playSound(url, vol = 0.65) {
    try { (foundry.audio.AudioHelper ?? AudioHelper).play({ src: url, volume: vol, autoplay: true }, false); }
    catch (_) {}
  }

  // ── Geometry ───────────────────────────────────────────────────────────────
  function circDist(idx, sel, N) {
    const raw = ((idx - sel) % N + N) % N;
    return raw <= N / 2 ? raw : N - raw;
  }

  // Selected slot uses RING_SELECTED; all others use RING_NORMAL.
  // This pushes the selected button further from centre, guaranteeing a clear
  // vertical gap between it and its neighbours at the bottom of the ring.
  function slotPos(idx, sel, N) {
    const d = circDist(idx, sel, N);
    const R = d === 0 ? RING_SELECTED : RING_NORMAL;
    const a = (Math.PI / 2) + (idx - sel) * (2 * Math.PI / N);
    return { x: Math.cos(a) * R, y: Math.sin(a) * R };
  }

  function slotVis(idx, sel, N) {
    const d   = Math.min(circDist(idx, sel, N), VIS.length - 1);
    return { ...VIS[d], isSelected: d === 0 };
  }

  // ── CSS ────────────────────────────────────────────────────────────────────
  function ensureStyles() {
    document.getElementById(STYLE_ID)?.remove(); // always regenerate — tuner may have changed dimensions
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
      .oni-opp-backdrop {
        position: fixed; inset: 0;
        background: rgba(0,0,0,.82);
        z-index: 100020;
        display: flex; flex-direction: column;
        align-items: center; justify-content: center;
        gap: 10px; pointer-events: auto;
        overflow-y: auto; padding: 10px 0;
      }
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

      /* Actor portrait — full sprite, no crop, no ring overlay */
      .oni-opp-center {
        position: absolute; left: 50%; top: 50%;
        transform: translate(-50%, -50%);
        width: ${PORTRAIT_IMG}px; height: ${PORTRAIT_IMG}px;
        background: transparent; border: none; overflow: visible;
        z-index: 6; pointer-events: none;
      }
      /* Full sprite: contain (no crop), fully transparent, no borders of any kind */
      .oni-opp-center img, .oni-opp-center video {
        position: absolute; left: 50%; top: 50%;
        transform: translate(-50%, -50%);
        width: ${PORTRAIT_IMG}px; height: ${PORTRAIT_IMG}px;
        object-fit: contain;
        background: transparent !important;
        border: none !important; outline: none !important;
        box-shadow: none !important; filter: none !important;
        border-radius: 0 !important;
        z-index: 1;
      }

      /* Slots — parchment pills, fixed width, transform-only animation */
      .oni-opp-slot {
        position: absolute;
        left: 50%; top: 50%;
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
      .oni-opp-slot i    { flex-shrink: 0; font-size: .72rem; }
      .oni-opp-slot span { overflow: hidden; text-overflow: ellipsis; flex: 1; text-align: center; }

      /* Description — fixed height prevents layout shifts */
      .oni-opp-desc {
        max-width: 440px; width: 100%;
        height: 100px; overflow: hidden; box-sizing: border-box;
        flex-shrink: 0;
        background: rgba(18,12,4,.92);
        border: 2px solid rgba(252,212,112,.30);
        border-radius: 12px; padding: 12px 18px;
        color: #f6ebd3; font-family: 'Signika', sans-serif;
        display: flex; flex-direction: column; gap: 5px;
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
        padding: 7px 0; text-align: center;
        font-size: .82rem; font-weight: 800; letter-spacing: .04em;
        border-radius: 30px; cursor: pointer;
        font-family: 'Signika', sans-serif;
        transition: filter .1s, transform .1s;
        flex-shrink: 0;
      }
      .oni-opp-btn:hover:not(:disabled) { filter: brightness(1.1); transform: translateY(-1px); }
      .oni-opp-btn:disabled { opacity: .38; cursor: not-allowed; transform: none; filter: none; }
      .oni-opp-btn-spend {
        width: 150px;
        background: linear-gradient(180deg, #d4a017, #a87800);
        border: 2px solid #a87800; color: #fff;
        box-shadow: 0 3px 10px rgba(0,0,0,.3);
      }
      .oni-opp-btn-decline {
        width: 120px;
        background: linear-gradient(180deg, #f6ebd3, #d9c4a4);
        border: 2px solid rgba(91,63,38,.75); color: #3b2a19;
      }

      /* ── Spectator mirror ────────────────────────────────────────────────
         Deliberately identical to the live picker — same backdrop opacity,
         same wheel geometry, same spawn fan-out. The ONLY difference is that
         every "you are in control" affordance is stripped: no pointer cursor,
         no hover cue (showSpectator never wires the hover SFX) and no
         Spend/Decline. The scroll cue still fires on selection changes, so
         spectators hear the cursor move exactly as the owner does. */
      .oni-opp-backdrop.is-spectating .oni-opp-wheel { pointer-events: none; }
      .oni-opp-backdrop.is-spectating .oni-opp-slot  { cursor: default; }
      .oni-opp-spectate-tag {
        display: flex; align-items: center; gap: 9px;
        padding: 7px 20px; border-radius: 30px;
        font-family: 'Signika', sans-serif;
        font-size: .82rem; font-weight: 800; letter-spacing: .04em;
        color: #f6ebd3;
        background: rgba(18,12,4,.92);
        border: 2px solid rgba(252,212,112,.30);
        user-select: none;
      }
      .oni-opp-spectate-tag .dot {
        width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
        background: #fcd470; box-shadow: 0 0 8px #fcd470;
        animation: oni-opp-spec-pulse 1.6s ease-in-out infinite;
      }
      @keyframes oni-opp-spec-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .25; } }
      .oni-opp-btn-takeover {
        width: 150px;
        background: linear-gradient(180deg, #6a4a8a, #4a2a6a);
        border: 2px solid #4a2a6a; color: #fff;
        box-shadow: 0 3px 10px rgba(0,0,0,.3);
      }
    `;
    document.head.appendChild(s);
  }

  // ── Apply layout ───────────────────────────────────────────────────────────
  // Only sets transform + opacity + z-index — no left/top changes.
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
        slot.style.boxShadow   = `0 2px 8px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,248,232,.6), 0 0 18px ${opt?.color ?? "#fcd470"}55`;
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

  // ── Live state ─────────────────────────────────────────────────────────────
  // Exactly one wheel exists per client at a time: either the owner's real
  // picker OR a read-only spectator mirror of somebody else's. They never
  // coexist — the actor is not a spectator of their own crit.
  let _picker    = null;  // { abort }
  let _spectator = null;  // { backdrop, slots, descEl, options, sel, timer, onKey }

  // Hard ceiling on a mirror's lifetime, longer than offer()'s own 120 s safety
  // timeout — a dropped close broadcast must never strand a spectator behind a
  // full-screen backdrop.
  const SPECTATOR_MAX_MS = 130_000;

  function clearSpectator() {
    const spec = _spectator;
    if (!spec) return;
    _spectator = null;
    clearTimeout(spec.timer);
    document.removeEventListener("keydown", spec.onKey);
    spec.backdrop.remove();
  }

  // ── Shared wheel builder ───────────────────────────────────────────────────
  // Builds the backdrop / title / wheel / slots / description shell used by BOTH
  // the live picker and the spectator mirror, so the two can never drift apart
  // visually. The caller fills the returned (empty) footer.
  function buildWheel({ actorName, actorPortrait, options, title = null, spectating = false }) {
    clearSpectator();                                    // never leave a stale mirror behind
    document.getElementById("oni-opp-backdrop")?.remove();

    const backdrop = document.createElement("div");
    backdrop.className = `oni-opp-backdrop${spectating ? " is-spectating" : ""}`;
    backdrop.id = "oni-opp-backdrop";

    const titleEl = document.createElement("div");
    titleEl.className = "oni-opp-title";
    titleEl.textContent = title ?? "✦ Critical! — Spend an Opportunity";
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

    // Slots — start at centre for the spawn animation
    const slots = options.map((opt, i) => {
      const slot = document.createElement("div");
      slot.className = "oni-opp-slot";
      slot.innerHTML = `<i class="fas ${esc(opt.icon ?? "fa-star")}"></i><span>${esc(opt.label)}</span>`;
      slot._option = opt;
      slot._idx    = i;
      slot.style.left       = "50%";
      slot.style.top        = "50%";
      slot.style.transform  = "translate(-50%, -50%) scale(0.35)";
      slot.style.opacity    = "0";
      slot.style.transition = "none";
      wheel.appendChild(slot);
      return slot;
    });

    backdrop.appendChild(wheel);

    // Description — fixed height
    const descEl = document.createElement("div");
    descEl.className = "oni-opp-desc";
    descEl.innerHTML = `
      <div class="oni-opp-desc-header">
        <div class="oni-opp-desc-icon"></div>
        <div class="oni-opp-desc-label"></div>
      </div>
      <div class="oni-opp-desc-text"></div>`;
    backdrop.appendChild(descEl);

    const footer = document.createElement("div");
    footer.className = "oni-opp-footer";
    backdrop.appendChild(footer);

    return { backdrop, wheel, slots, descEl, footer };
  }

  // ── Spawn fan-out ──────────────────────────────────────────────────────────
  // Slots fly from the centre out to the ring, staggered, then settle onto a
  // uniform transition so later selection changes animate evenly.
  function runSpawnAnimation(slots, sel, N) {
    const UNIFORM = `transform ${TRANSITION_MS}ms ease-out, opacity 200ms ease-out`;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      slots.forEach((slot, i) => {
        const d = i * SPAWN_STAGGER;
        slot.style.transition = `transform ${TRANSITION_MS}ms ease-out ${d}ms, opacity 200ms ease-out ${d}ms`;
      });
      applyLayout(slots, sel, N);

      const spawnDone = SPAWN_STAGGER * (N - 1) + TRANSITION_MS + 80;
      setTimeout(() => slots.forEach(sl => { sl.style.transition = UNIFORM; }), spawnDone);
    }));
  }

  // ── Main showPicker ────────────────────────────────────────────────────────
  // `onSelectionChange(idx)` fires on every cursor move so the manager can echo
  // the live selection out to spectators.
  function showPicker({ actorName, actorPortrait, options, canDecline = true, title = null, onSelectionChange = null } = {}) {
    applyTunerOverrides(); // pick up any live tuner changes before rebuilding
    ensureStyles();        // always regenerates CSS with current dimension vars

    return new Promise(resolve => {
      const N = options.length;
      let sel  = 0;
      let done = false;

      const { backdrop, slots, descEl, footer } = buildWheel({ actorName, actorPortrait, options, title });

      // Footer
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

      document.body.appendChild(backdrop);
      playSound(SFX_OPEN, 0.75);

      refreshDesc(descEl, options[sel]);
      runSpawnAnimation(slots, sel, N);

      // Single exit point, so a GM take-control abort can never race a click.
      function finish(result) {
        if (done) return;
        done   = true;
        _picker = null;
        cleanup();
        resolve(result);
      }

      // Exposed so the manager can hand this wheel over to a GM mid-decision.
      _picker = {
        abort: () => {
          if (done) return false;
          playSound(SFX_CANCEL, 0.5);
          finish({ takenOver: true });
          return true;
        },
      };

      // ── Selection ─────────────────────────────────────────────────────────
      function changeSel(newIdx, sfx = true) {
        const ns = ((newIdx % N) + N) % N;
        if (ns === sel) return;
        sel = ns;
        if (sfx) playSound(SFX_SCROLL, 0.6);
        applyLayout(slots, sel, N);
        refreshDesc(descEl, options[sel]);
        try { onSelectionChange?.(sel); } catch (e) { console.error(TAG, "onSelectionChange threw:", e); }
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
        if (spendBtn.disabled || done) return;
        spendBtn.disabled = true;
        if (declineBtn) declineBtn.disabled = true;
        // If this option has a targeting/pre phase, play lesser confirm here;
        // the full confirm plays after the pre phase completes (just before banner).
        playSound(options[sel].hasPrePhase ? SFX_LESSER_CONFIRM : SFX_CONFIRM, 0.8);
        await showFlash();
        finish({ optionId: options[sel].id });
      });

      // Decline
      if (declineBtn) {
        declineBtn.addEventListener("click", () => {
          if (done) return;
          playSound(SFX_CANCEL, 0.65);
          finish({ cancelled: true });
        });
      }

      function cleanup() {
        document.removeEventListener("keydown", onKey);
        backdrop.remove();
      }
    });
  }

  // ── Spectator mirror ───────────────────────────────────────────────────────
  // Shown on every OTHER client while the owner decides. Same wheel, same
  // backdrop, same spawn fan-out, same open cue — but no interaction: the slots
  // carry no click/hover handlers (so no hover SFX, no pointer cursor) and the
  // footer holds a "Spectating" tag instead of Spend/Decline. Torn down by
  // dismissSpectator() when the owner commits or declines.
  //
  // `onTakeControl` (GM only) adds the one deliberate control on this panel: a
  // Take Control button for when the owner cannot operate their own menu.
  function showSpectator({ actorName, actorPortrait, options, title = null, sel = 0, onTakeControl = null } = {}) {
    if (!Array.isArray(options) || !options.length) return null;
    // Never mirror ourselves — if a real picker is up on this client then we ARE
    // the actor and the broadcast is stray.
    if (_picker) { console.debug(TAG, "showSpectator ignored — a live picker is open here."); return null; }

    applyTunerOverrides();
    ensureStyles();

    const N  = options.length;
    const s0 = ((Number(sel) || 0) % N + N) % N;

    const { backdrop, slots, descEl, footer } = buildWheel({ actorName, actorPortrait, options, title, spectating: true });

    const tag = document.createElement("div");
    tag.className = "oni-opp-spectate-tag";
    tag.innerHTML = `<span class="dot"></span><span class="oni-opp-spectate-text"></span>`;
    tag.querySelector(".oni-opp-spectate-text").textContent =
      actorName ? `Spectating — ${actorName} is choosing…` : "Spectating…";
    footer.appendChild(tag);

    if (typeof onTakeControl === "function") {
      const btn = document.createElement("button");
      btn.className = "oni-opp-btn oni-opp-btn-takeover";
      btn.textContent = "⚙ Take Control";
      btn.addEventListener("click", () => {
        btn.disabled    = true;
        btn.textContent = "Requesting…";
        try { onTakeControl(); } catch (e) { console.error(TAG, "onTakeControl threw:", e); }
      });
      footer.appendChild(btn);
    }

    document.body.appendChild(backdrop);
    playSound(SFX_OPEN, 0.75);

    refreshDesc(descEl, options[s0]);
    runSpawnAnimation(slots, s0, N);

    // Local escape hatch — a spectator is never trapped behind the backdrop,
    // even if the close broadcast is lost.
    const onKey = e => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      dismissSpectator({ silent: true });
    };
    document.addEventListener("keydown", onKey);

    const timer = setTimeout(() => dismissSpectator({ silent: true }), SPECTATOR_MAX_MS);

    _spectator = { backdrop, slots, descEl, options, sel: s0, timer, onKey };
    return backdrop;
  }

  // Reflect the owner's in-progress cursor onto this client's mirror. The scroll
  // cue plays here too — hearing the cursor move is part of watching.
  function applySpectatorSelection({ sel = 0 } = {}) {
    if (!_spectator) return;
    const N  = _spectator.options.length;
    const ns = ((Number(sel) || 0) % N + N) % N;
    if (ns === _spectator.sel) return;
    _spectator.sel = ns;
    playSound(SFX_SCROLL, 0.6);
    applyLayout(_spectator.slots, ns, N);
    refreshDesc(_spectator.descEl, _spectator.options[ns]);
  }

  /**
   * Tear down the spectator mirror.
   *   { optionId }        → owner spent it: land on that slot, confirm cue, flash.
   *   { cancelled: true } → owner declined: cancel cue.
   *   { silent: true }    → superseded / timed out / local Escape: no cue at all.
   */
  async function dismissSpectator({ optionId = null, cancelled = false, silent = false } = {}) {
    const spec = _spectator;
    if (!spec) return;
    _spectator = null;
    clearTimeout(spec.timer);
    document.removeEventListener("keydown", spec.onKey);

    if (silent) { spec.backdrop.remove(); return; }

    if (cancelled) {
      playSound(SFX_CANCEL, 0.65);
      spec.backdrop.remove();
      return;
    }

    // Mirror the owner's confirm beat. The live-selection echo has almost always
    // parked the cursor on the right slot already; correct it (and let the ring
    // settle) only if a select broadcast went missing.
    const idx = spec.options.findIndex(o => o.id === optionId);
    if (idx >= 0 && idx !== spec.sel) {
      applyLayout(spec.slots, idx, spec.options.length);
      refreshDesc(spec.descEl, spec.options[idx]);
      await new Promise(r => setTimeout(r, TRANSITION_MS));
    }
    const opt = idx >= 0 ? spec.options[idx] : null;
    playSound(opt?.hasPrePhase ? SFX_LESSER_CONFIRM : SFX_CONFIRM, 0.8);
    await showFlash();
    spec.backdrop.remove();
  }

  /** Abort the live picker on this client (GM take-control). True if one was open. */
  function abortPicker() { return _picker?.abort() ?? false; }

  const isPickerOpen = () => !!_picker;
  const isSpectating = () => !!_spectator;

  window["oni.OpportunityDialog"] = Object.freeze({
    showPicker,
    showSpectator,
    applySpectatorSelection,
    dismissSpectator,
    abortPicker,
    isPickerOpen,
    isSpectating,
  });
  console.debug(`${TAG} Ready (Wheel UI v8 — shared builder + spectator mirror).`);
})();
