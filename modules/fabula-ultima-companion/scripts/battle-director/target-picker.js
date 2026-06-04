// Minimal click-to-pick target picker.
//
// Replaces the legacy jrpg-targeting-system for v1 (per "make a new copy of
// the code instead of using legacy script"). This is the bare minimum:
//   - Highlight every eligible target on the canvas
//   - Click a token to select / deselect
//   - Hit Enter to confirm, Esc to cancel
//   - Resolves with { ok, cancelled, tokenUuids }
//
// No socket plumbing — picker runs on the GM client only in v1, matching
// the Turn UI ownership model.

import { log, warn } from "./logger.js";

const STYLE_ID = "fud-targetpicker-style";

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const css = document.createElement("style");
  css.id = STYLE_ID;
  css.textContent = `
    .fud-target-ring{
      position:absolute;
      border:3px dashed #7a9bb6;
      border-radius:50%;
      box-shadow:0 0 10px rgba(122,155,182,.6), inset 0 0 10px rgba(122,155,182,.3);
      pointer-events:none;
      z-index:30;
      transition:filter 100ms ease, border-color 100ms ease;
    }
    .fud-target-ring.is-hover{ filter:brightness(1.3); border-color:#a8c4d8; }
    .fud-target-ring.is-selected{ border-style:solid; border-color:#ffcc44; box-shadow:0 0 14px rgba(255,204,68,.8), inset 0 0 14px rgba(255,204,68,.3); }
    /* Roulette mode — all eligible rings strobe rapidly while the random
       draw is in progress. CSS steps(1) makes it a hard digital blink
       rather than a smooth fade, reinforcing the "slot machine" feel. */
    .fud-target-ring.is-roulette{
      border-style:solid; border-color:#e8a040; transition:none;
      box-shadow:0 0 12px rgba(232,160,64,.7), inset 0 0 12px rgba(232,160,64,.25);
      animation:fud-roulette-blink 0.14s steps(1) infinite;
    }
    @keyframes fud-roulette-blink{
      50%{ opacity:0.15; border-color:#7a9bb6; box-shadow:0 0 10px rgba(122,155,182,.6), inset 0 0 10px rgba(122,155,182,.3); }
    }
    /* Excluded-target overlay — drawn over tokens removed from the eligible
       pool by an AE-driven block (e.g. Vanish's cannot_target_uuids). The
       ring is grey + thinner, sits below regular target rings, and the
       label above the token states the reason so the player knows what
       to do next. Pointer-events stay none so clicks pass through
       (excluded tokens still can't be picked). */
    .fud-target-ring-excluded{
      position:absolute;
      border:3px dashed rgba(120,110,100,.65);
      border-radius:50%;
      box-shadow:inset 0 0 12px rgba(0,0,0,.25);
      pointer-events:none;
      z-index:29;
      filter:grayscale(.6);
    }
    .fud-target-excluded-label{
      position:fixed;
      transform:translate(-50%, -100%);
      padding:3px 8px 4px;
      background:rgba(60,50,40,.92);
      color:#f6f1e6;
      font-size:11px;
      font-weight:700;
      letter-spacing:.2px;
      border-radius:6px;
      border:1px solid #9c8c75;
      box-shadow:0 2px 6px rgba(0,0,0,.5);
      white-space:nowrap;
      pointer-events:none;
      z-index:31;
      text-shadow:0 1px 2px rgba(0,0,0,.5);
      font-family:"Inter","Segoe UI",system-ui,sans-serif;
      max-width:240px;
      overflow:hidden;
      text-overflow:ellipsis;
    }
    .fud-target-excluded-label::before{
      content:"🚫";
      margin-right:4px;
      font-size:10px;
    }
    .fud-target-banner{
      position:fixed; left:50%; top:18%; transform:translate(-50%, 0);
      padding:10px 14px 10px; border-radius:14px;
      background:linear-gradient(180deg,#f6f1e6,#ebe3d0);
      border:2px solid #5a6a85;
      box-shadow:0 4px 0 rgba(24,28,41,.55), 0 0 0 1px rgba(255,255,255,.7) inset;
      font-family:"Inter","Segoe UI",system-ui,sans-serif;
      font-weight:800; letter-spacing:.32px; text-transform:uppercase;
      color:#3a3228; z-index:9999; pointer-events:auto;
      text-align:center;
      display:flex; flex-direction:column; align-items:center; gap:8px;
      min-width:260px;
    }
    .fud-target-banner .director-pip{ color:#5a6a85; opacity:.85; font-size:10px; letter-spacing:.5px; display:block; margin-top:2px;}
    .fud-target-banner .label-line{ font-size:13px; line-height:1.2; }
    .fud-target-banner .selected-count{
      display:inline-block;
      margin-left:6px;
      padding:1px 8px;
      border-radius:999px;
      border:1px solid #5a6a85;
      background:rgba(255,255,255,.45);
      color:#5a6a85;
      font-size:11px;
    }
    .fud-target-banner .fud-target-btn-row{
      display:flex; gap:8px; width:100%;
    }
    .fud-target-banner .fud-target-btn{
      flex:1;
      padding:7px 12px;
      border-radius:8px;
      border:2px solid #5a6a85;
      font-weight:800; letter-spacing:.32px; text-transform:uppercase;
      font-size:11.5px;
      cursor:pointer; user-select:none;
      text-align:center;
      box-shadow:0 3px 0 rgba(24,28,41,.55), 0 0 0 1px rgba(255,255,255,.7) inset;
      transition:transform 100ms ease, filter 100ms ease;
    }
    .fud-target-banner .fud-target-btn.confirm{
      background:linear-gradient(180deg, #a8c4d8, #7a9bb6);
      color:#221b14;
    }
    .fud-target-banner .fud-target-btn.cancel{
      background:linear-gradient(180deg, #e5d6c5, #c9b294);
      color:#3a3228;
    }
    .fud-target-banner .fud-target-btn.secondary{
      background:linear-gradient(180deg, #d0d6c5, #aab394);
      color:#3a3228;
    }
    .fud-target-banner .fud-target-btn.is-disabled{
      filter:grayscale(0.6) brightness(0.85);
      opacity:0.55;
      cursor:not-allowed;
    }
    .fud-target-banner .fud-target-btn:not(.is-disabled):hover { filter:brightness(1.05); transform:translateY(-1px); }
    .fud-target-banner .fud-target-btn:not(.is-disabled):active { transform:translateY(0); }
  `;
  document.head.appendChild(css);
}

function worldToClient(x, y) {
  const wt = canvas.stage.worldTransform;
  const out = new PIXI.Point();
  wt.apply({ x, y }, out);
  const rect = canvas.app.view.getBoundingClientRect();
  return { x: rect.left + out.x, y: rect.top + out.y };
}

// ─── Dim / highlight helpers ──────────────────────────────────────────────────
// Ported from the JRPG targeting highlight system. While the ring picker is
// open, non-eligible tokens are darkened + desaturated so the player's eye is
// drawn to the valid targets. The background is also dimmed for clarity.
// Filters are stored and fully restored in finish() / on token deletion.

const _DIM_BRIGHTNESS = 0.30;
const _DIM_DESATURATE  = true;
const _BG_DIM_BRIGHTNESS = 0.50;

function _buildDimFilter() {
  const f = new PIXI.filters.ColorMatrixFilter();
  if (_DIM_DESATURATE) f.desaturate();
  f.brightness(_DIM_BRIGHTNESS, false);
  return f;
}

function _buildBgDimFilter() {
  const f = new PIXI.filters.ColorMatrixFilter();
  f.brightness(_BG_DIM_BRIGHTNESS, false);
  return f;
}

// Apply dim to all visible scene tokens that are NOT in the eligible list
// and NOT the acting token (source). Returns a state bag for cleanup.
function applyTargetingDim(eligible, director) {
  const visibleUuids = new Set(eligible.map((e) => e.tokenUuid).filter(Boolean));
  // Keep the caster fully visible (matches JRPG `alwaysKeepSourceVisible`).
  const sourceUuid = director?.ctx?.turnSnapshot?.tokenUuid ?? null;
  if (sourceUuid) visibleUuids.add(sourceUuid);

  const savedTokenFilters = new Map(); // tokenUuid → { mesh, original }
  let savedBgFilters = null;
  let bg = null;

  const sceneTokens = (canvas?.tokens?.placeables ?? [])
    .filter((t) => t?.visible && !t?.document?.hidden);

  for (const token of sceneTokens) {
    const uuid = token?.document?.uuid;
    if (!uuid || visibleUuids.has(uuid)) continue;
    const mesh = token?.mesh;
    if (!mesh) continue;
    try {
      const original = Array.isArray(mesh.filters) ? [...mesh.filters] : [];
      savedTokenFilters.set(uuid, { mesh, original });
      mesh.filters = [...original, _buildDimFilter()];
    } catch (e) {
      warn("targetPicker dim apply failed", e);
    }
  }

  bg = canvas?.primary?.background ?? null;
  if (bg) {
    try {
      savedBgFilters = Array.isArray(bg.filters) ? [...bg.filters] : [];
      bg.filters = [...savedBgFilters, _buildBgDimFilter()];
    } catch (e) {
      warn("targetPicker bg dim apply failed", e);
    }
  }

  return { savedTokenFilters, savedBgFilters, bg };
}

// Restore a single token's filters when it is deleted mid-pick.
function clearTokenDim(dimState, tokenUuid) {
  if (!dimState?.savedTokenFilters?.has(tokenUuid)) return;
  const rec = dimState.savedTokenFilters.get(tokenUuid);
  try { rec.mesh.filters = rec.original; } catch {}
  dimState.savedTokenFilters.delete(tokenUuid);
}

// Restore all filters and the background — called from finish().
function clearTargetingDim(dimState) {
  if (!dimState) return;
  const { savedTokenFilters, savedBgFilters, bg } = dimState;
  for (const rec of savedTokenFilters.values()) {
    try { rec.mesh.filters = rec.original; } catch {}
  }
  savedTokenFilters.clear();
  if (bg && savedBgFilters !== null) {
    try { bg.filters = savedBgFilters; } catch {}
  }
}

// `eligible` is the snapshotEligibleTargets() output.
// Returns Promise<{ ok, cancelled, skipped?, tokenUuids }>.
// `opts.mode`: "exact" | "up_to" | "self" | "all" | "random" (default "exact")
//   "self"   — immediately resolves with eligible[0]; no UI shown.
//   "all"    — immediately resolves with all eligible; no UI shown.
//   "random" — shows roulette animation then resolves with a random draw.
// `opts.count`: target count (exact N for exact/random; max N for up_to/random+randomizeCount)
// `opts.randomizeCount`: when true with mode "random", the draw count itself is
//   randomised in [1, count] — handles "up to N random X" syntax.
// `opts.randomPool`: optional explicit draw pool for random mode. Targets are
//   drawn from this list instead of `eligible`. Rings still display around all
//   `eligible` tokens. Pass when a future script needs to constrain the random
//   draw to a specific subset while still visualising all candidates.
// `opts.titleText`: banner text override
// `opts.cancelLabel`: text on the Cancel button (default "Cancel"; use
//   "Skip" or similar for mid-action picks where the action has already
//   partially committed and cancelling means "skip rest")
// `opts.secondaryAction`: optional third button between Cancel + Confirm:
//   { label: string, value?: string } — when clicked, resolves with
//   { ok: true, skipped: true, secondaryValue: value, tokenUuids: [] }.
//   Used for Guard's "Skip Cover" — confirms an "I'm proceeding without
//   making a target selection" path distinct from cancel.
export function requestTargeting({ director, eligible, mode = "exact", count = 1, titleText = null, cancelLabel = "Cancel", secondaryAction = null, externalCancel = null, randomizeCount = false, randomPool = null } = {}) {
  // No GM gate: target picking is client-local. The GM client uses this
  // as fallback when an NPC acts; player clients use it inside their
  // own composeAction() chain. See [[director-player-driven-input]].
  if (!Array.isArray(eligible) || eligible.length === 0) {
    // If the caller offered a secondary "skip" path, treat empty-eligible
    // as an auto-skip rather than an error. Guard with no allies on scene,
    // for example, should still let the player proceed with self-guard.
    if (secondaryAction) {
      return Promise.resolve({ ok: true, cancelled: false, skipped: true, secondaryValue: secondaryAction.value ?? null, tokenUuids: [] });
    }
    return Promise.resolve({ ok: false, cancelled: false, tokenUuids: [], reason: "no eligible targets" });
  }

  // "self" — exactly one pre-determined target (the caster). Resolve
  // immediately; no picker overlay or user interaction needed.
  if (mode === "self") {
    const uuid = eligible[0]?.tokenUuid;
    if (!uuid) return Promise.resolve({ ok: false, cancelled: false, tokenUuids: [], reason: "no eligible self target" });
    return Promise.resolve({ ok: true, cancelled: false, tokenUuids: [uuid] });
  }

  // "all" — every eligible token is selected. Resolve immediately; the
  // action card in COMPUTE/CONFIRM provides the visual target summary.
  if (mode === "all") {
    return Promise.resolve({ ok: true, cancelled: false, tokenUuids: eligible.map((e) => e.tokenUuid) });
  }

  ensureStyles();

  return new Promise((resolve) => {
    // Build canvas-positioned rings around each eligible token.
    const rings = new Map(); // tokenUuid -> { el, token }
    const selected = new Set(); // tokenUuid

    // Random-mode state — both closed over by the roulette timer, tryConfirm,
    // and finish, so they're declared here at the top of the Promise scope.
    let rouletteTimer = null;
    let randomPicked  = [];

    // Pre-compute the random draw immediately — the result is sealed before
    // the animation plays, so the roulette is purely theatrical.
    if (mode === "random") {
      const pool = Array.isArray(randomPool) && randomPool.length ? randomPool : eligible;
      const actualCount = randomizeCount
        ? Math.floor(Math.random() * count) + 1
        : Math.min(count, pool.length);
      const shuffled = [...pool].sort(() => Math.random() - 0.5);
      randomPicked = shuffled.slice(0, actualCount);
    }

    const banner = document.createElement("div");
    banner.className = "fud-target-banner";
    // Defensive escape on the cancel + secondary labels — caller-supplied
    // text could contain HTML if a future codepath builds it dynamically.
    const escapeBtnLabel = (s) => String(s ?? "")
      .replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
    const safeCancelLabel = escapeBtnLabel(cancelLabel || "Cancel");
    const secondaryBtnHTML = secondaryAction
      ? `<div class="fud-target-btn secondary" data-fud-target="secondary" role="button" tabindex="0">${escapeBtnLabel(secondaryAction.label ?? "Skip")}</div>`
      : "";
    banner.innerHTML = `
      <div class="label-line"></div>
      <div class="fud-target-btn-row">
        <div class="fud-target-btn cancel" data-fud-target="cancel" role="button" tabindex="0">${safeCancelLabel}</div>
        ${secondaryBtnHTML}
        <div class="fud-target-btn confirm" data-fud-target="confirm" role="button" tabindex="0">Confirm</div>
      </div>
    `;
    document.body.appendChild(banner);

    const labelEl = banner.querySelector(".label-line");
    const confirmBtn = banner.querySelector(".fud-target-btn.confirm");

    function isValidSelection() {
      if (mode === "random") return true; // draw is pre-computed; confirm is always valid
      if (mode === "exact") return selected.size === count;
      if (mode === "up_to") return selected.size >= 1 && selected.size <= count;
      return selected.size > 0;
    }

    function updateBanner() {
      if (mode === "random") {
        const label = titleText ?? "Random target";
        // Always show "Randomizing…" — the draw is sealed but never revealed
        // in the picker itself. Confirm resolves it; Cancel aborts.
        labelEl.innerHTML = `${label}<span class="selected-count">Randomizing…</span>`;
        confirmBtn.classList.remove("is-disabled");
        return;
      }
      const verb = mode === "up_to" ? "up to" : "";
      const label = titleText ?? `Pick ${verb ? verb + " " : ""}${count} target${count === 1 ? "" : "s"}`;
      const countText = `${selected.size}/${count} selected`;
      labelEl.innerHTML = `${label}<span class="selected-count">${countText}</span>`;
      // Confirm is greyed out until the selection is valid — no hidden state.
      if (isValidSelection()) {
        confirmBtn.classList.remove("is-disabled");
      } else {
        confirmBtn.classList.add("is-disabled");
      }
    }
    updateBanner();

    function tryConfirm() {
      if (mode === "random") {
        // Resolve with the pre-computed draw regardless of animation state.
        finish({ ok: true, cancelled: false, tokenUuids: randomPicked.map((e) => e.tokenUuid) });
        return;
      }
      if (!isValidSelection()) {
        if (mode === "exact") {
          ui.notifications?.warn(`Pick exactly ${count} target${count === 1 ? "" : "s"}.`);
        } else {
          ui.notifications?.warn("Pick at least 1 target.");
        }
        return;
      }
      finish({ ok: true, cancelled: false, tokenUuids: Array.from(selected) });
    }

    function bannerClick(ev) {
      const btn = ev.target?.closest?.("[data-fud-target]");
      if (!btn) return;
      ev.stopPropagation();
      ev.preventDefault();
      if (btn.dataset.fudTarget === "cancel") {
        finish({ ok: false, cancelled: true, tokenUuids: [] });
      } else if (btn.dataset.fudTarget === "secondary") {
        // Proceeds without a target selection (e.g. "Skip Cover"). The
        // caller distinguishes this from cancel via `result.skipped`.
        finish({ ok: true, cancelled: false, skipped: true, secondaryValue: secondaryAction?.value ?? null, tokenUuids: [] });
      } else if (btn.dataset.fudTarget === "confirm") {
        tryConfirm();
      }
    }
    banner.addEventListener("click", bannerClick);

    function positionRing(rec) {
      const t = rec.token;
      if (!t || t.destroyed) return;
      const c = t.center ?? t.getCenter?.() ?? { x: t.x + t.w / 2, y: t.y + t.h / 2 };
      const p = worldToClient(c.x, c.y);
      const sc = canvas.stage.scale?.x ?? 1;
      const w = (t.w ?? 100) * sc;
      const h = (t.h ?? 100) * sc;
      const size = Math.max(w, h) * 1.05;
      rec.el.style.left = `${p.x - size / 2}px`;
      rec.el.style.top = `${p.y - size / 2}px`;
      rec.el.style.width = `${size}px`;
      rec.el.style.height = `${size}px`;
      // Place the reason label centered above the token (when present).
      if (rec.labelEl) {
        rec.labelEl.style.left = `${p.x}px`;
        rec.labelEl.style.top  = `${p.y - size / 2 - 4}px`;
      }
    }

    // Excluded-overlay records live in a parallel map so reposition
    // hooks can update them on canvasPan/updateToken without confusing
    // them with the clickable eligible-ring records.
    const excludedOverlays = new Map();   // tokenUuid → { el, labelEl, token }

    function repositionAll() {
      for (const rec of rings.values()) positionRing(rec);
      for (const rec of excludedOverlays.values()) positionRing(rec);
    }

    function buildRings() {
      for (const e of eligible) {
        const token = canvas?.tokens?.get(e.tokenId);
        if (!token) continue;
        const ring = document.createElement("div");
        ring.className = "fud-target-ring";
        document.body.appendChild(ring);
        const rec = { el: ring, token, tokenUuid: e.tokenUuid };
        rings.set(e.tokenUuid, rec);
        positionRing(rec);
        // pointer-events on the ring itself stay none, so click goes through to
        // the token. We track clicks via a global canvas listener instead.
      }
      buildExcludedOverlays();
    }

    // Draw a greyed-out ring + reason label over every target dropped
    // by an AE-driven cannot_target_uuids filter. eligible.excluded is
    // attached by snapshotEligibleTargets[FromDCombat] — empty/missing
    // for hand-built eligible arrays or non-AE filters.
    function buildExcludedOverlays() {
      const list = Array.isArray(eligible?.excluded) ? eligible.excluded : [];
      for (const e of list) {
        const token = canvas?.tokens?.get(e.tokenId);
        if (!token) continue;
        const ring = document.createElement("div");
        ring.className = "fud-target-ring-excluded";
        document.body.appendChild(ring);
        const labelEl = document.createElement("div");
        labelEl.className = "fud-target-excluded-label";
        const reasonText = Array.isArray(e.reasons) && e.reasons.length
          ? e.reasons.join(" · ")
          : "Cannot target";
        labelEl.textContent = reasonText;
        document.body.appendChild(labelEl);
        const rec = { el: ring, labelEl, token, tokenUuid: e.tokenUuid };
        excludedOverlays.set(e.tokenUuid, rec);
        positionRing(rec);
      }
    }

    function setHover(tokenUuid, on) {
      const rec = rings.get(tokenUuid);
      if (!rec) return;
      rec.el.classList.toggle("is-hover", on);
    }

    function setSelected(tokenUuid, on) {
      const rec = rings.get(tokenUuid);
      if (!rec) return;
      rec.el.classList.toggle("is-selected", on);
    }

    function onTokenHover(token, hovered) {
      const uuid = token?.document?.uuid;
      if (!uuid || !rings.has(uuid)) return;
      setHover(uuid, !!hovered);
    }

    function onTokenClick(_event, token) {
      const uuid = token?.document?.uuid;
      if (!uuid || !rings.has(uuid)) return;
      if (selected.has(uuid)) {
        selected.delete(uuid);
        setSelected(uuid, false);
      } else {
        if (selected.size >= count && mode === "exact") {
          // Replace the oldest selection
          const firstUuid = selected.values().next().value;
          selected.delete(firstUuid);
          setSelected(firstUuid, false);
        } else if (selected.size >= count) {
          return; // up_to: don't add beyond max
        }
        selected.add(uuid);
        setSelected(uuid, true);
      }
      updateBanner();
    }

    // Keyboard parity for mouse-first players who prefer hotkeys —
    // Enter / Esc both feed the same code paths the buttons do.
    function onKey(e) {
      if (e.key === "Escape") {
        e.preventDefault(); e.stopPropagation();
        finish({ ok: false, cancelled: true, tokenUuids: [] });
      } else if (e.key === "Enter") {
        e.preventDefault(); e.stopPropagation();
        tryConfirm();
      }
    }

    // Wire hooks via the director's HookRegistry (GM) for managed cleanup,
    // or fall back to global Hooks.on + manual cleanup (player clients
    // running composeAction with no director).
    const manualHooks = [];
    // dimState is assigned after buildRings(); closed over by onPreDel + finish.
    let dimState = null;
    const onPreDel = (_scene, doc) => {
      const uuid = doc?.uuid;
      if (uuid && rings.has(uuid)) {
        const rec = rings.get(uuid);
        try { rec.el.remove(); } catch {}
        rings.delete(uuid);
        if (selected.has(uuid)) selected.delete(uuid);
        updateBanner();
      }
      // Restore dim filter for deleted tokens so their mesh isn't left dirty.
      if (uuid) clearTokenDim(dimState, uuid);
    };
    let hH, hP, hU, hD;
    if (director?.hooks?.on) {
      hH = director.hooks.on("hoverToken", onTokenHover, { label: "tp:hoverToken" });
      hP = director.hooks.on("canvasPan", repositionAll, { label: "tp:canvasPan" });
      hU = director.hooks.on("updateToken", repositionAll, { label: "tp:updateToken" });
      hD = director.hooks.on("preDeleteToken", onPreDel, { label: "tp:preDeleteToken" });
    } else {
      const id1 = Hooks.on("hoverToken", onTokenHover);
      const id2 = Hooks.on("canvasPan", repositionAll);
      const id3 = Hooks.on("updateToken", repositionAll);
      const id4 = Hooks.on("preDeleteToken", onPreDel);
      manualHooks.push(() => { try { Hooks.off("hoverToken", id1); } catch {} });
      manualHooks.push(() => { try { Hooks.off("canvasPan", id2); } catch {} });
      manualHooks.push(() => { try { Hooks.off("updateToken", id3); } catch {} });
      manualHooks.push(() => { try { Hooks.off("preDeleteToken", id4); } catch {} });
    }

    // Token click via libWrapper-style — fall back to canvas pointer event.
    // For v1 we use the Foundry hook "clickToken" if available; otherwise
    // we intercept the canvas pointerdown and resolve tokens via canvas API.
    const handlerClick = (event) => {
      // Random mode: the player cannot manually pick — swallow all canvas clicks.
      if (mode === "random") { event.preventDefault?.(); event.stopPropagation?.(); return; }
      try {
        const rect = canvas?.app?.view?.getBoundingClientRect?.();
        const transform = canvas?.stage?.worldTransform;
        if (!rect || !transform) return;
        const local = transform.applyInverse({
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
        });
        const hit = canvas?.tokens?.placeables?.find?.((tok) => {
          const b = tok?.bounds;
          if (!b) return false;
          return local.x >= b.x && local.x <= b.x + b.width && local.y >= b.y && local.y <= b.y + b.height;
        });
        if (hit) {
          event.preventDefault?.();
          event.stopPropagation?.();
          onTokenClick(event, hit);
        }
      } catch (e) {
        warn("target picker pointerdown threw", e);
      }
    };
    canvas.app.view.addEventListener("pointerdown", handlerClick, true);
    window.addEventListener("keydown", onKey, true);

    buildRings();
    repositionAll();
    dimState = applyTargetingDim(eligible, director);

    // Random mode: strobe all eligible rings indefinitely via CSS animation.
    // The draw is pre-computed but never shown in the picker — the player
    // clicks Confirm (or Cancel) to resolve. No auto-landing timer.
    if (mode === "random") {
      for (const rec of rings.values()) rec.el.classList.add("is-roulette");
    }

    // External cancellation: when composeAction is racing GM-local vs
    // remote and the remote wins, the local picker overlay must tear
    // down even though no Cancel button was clicked. The caller resolves
    // `externalCancel` to trigger the same finish() path as a Cancel.
    let extCancelled = false;
    if (externalCancel && typeof externalCancel.then === "function") {
      externalCancel.then(() => {
        if (extCancelled) return;
        extCancelled = true;
        try { finish({ ok: false, cancelled: true, tokenUuids: [], reason: "external-cancel" }); }
        catch (e) { warn("target picker externalCancel finish threw", e); }
      });
    }

    function finish(result) {
      // Strip roulette animation from all rings before tearing down.
      if (mode === "random") {
        for (const rec of rings.values()) rec.el.classList.remove("is-roulette");
      }
      clearTargetingDim(dimState);
      try { window.removeEventListener("keydown", onKey, true); } catch {}
      try { canvas.app.view.removeEventListener("pointerdown", handlerClick, true); } catch {}
      try { banner.remove(); } catch {}
      for (const rec of rings.values()) { try { rec.el.remove(); } catch {} }
      rings.clear();
      // Tear down the excluded overlays + their reason labels alongside.
      for (const rec of excludedOverlays.values()) {
        try { rec.el.remove(); } catch {}
        try { rec.labelEl?.remove(); } catch {}
      }
      excludedOverlays.clear();
      // Hooks: director.hooks.off when registered there; manual Hooks.off
      // when the player-side fallback path registered them.
      if (director?.hooks?.off) {
        try { director.hooks.off(hH); } catch {}
        try { director.hooks.off(hP); } catch {}
        try { director.hooks.off(hU); } catch {}
        try { director.hooks.off(hD); } catch {}
      }
      for (const fn of manualHooks) { try { fn(); } catch {} }
      log("Target picker resolved:", result);
      resolve(result);
    }
  });
}
