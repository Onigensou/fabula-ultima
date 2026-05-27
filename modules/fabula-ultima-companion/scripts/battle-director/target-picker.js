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

// `eligible` is the snapshotEligibleTargets() output.
// Returns Promise<{ ok, cancelled, skipped?, tokenUuids }>.
// `opts.mode`: "exact" or "up_to" (default "exact")
// `opts.count`: number of targets required/maximum (default 1)
// `opts.titleText`: banner text override
// `opts.cancelLabel`: text on the Cancel button (default "Cancel"; use
//   "Skip" or similar for mid-action picks where the action has already
//   partially committed and cancelling means "skip rest")
// `opts.secondaryAction`: optional third button between Cancel + Confirm:
//   { label: string, value?: string } — when clicked, resolves with
//   { ok: true, skipped: true, secondaryValue: value, tokenUuids: [] }.
//   Used for Guard's "Skip Cover" — confirms an "I'm proceeding without
//   making a target selection" path distinct from cancel.
export function requestTargeting({ director, eligible, mode = "exact", count = 1, titleText = null, cancelLabel = "Cancel", secondaryAction = null, externalCancel = null } = {}) {
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
  ensureStyles();

  return new Promise((resolve) => {
    // Build canvas-positioned rings around each eligible token.
    const rings = new Map(); // tokenUuid -> { el, token }
    const selected = new Set(); // tokenUuid

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
      if (mode === "exact") return selected.size === count;
      if (mode === "up_to") return selected.size >= 1 && selected.size <= count;
      return selected.size > 0;
    }

    function updateBanner() {
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
    }

    function repositionAll() {
      for (const rec of rings.values()) positionRing(rec);
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
    const onPreDel = (_scene, doc) => {
      const uuid = doc?.uuid;
      if (uuid && rings.has(uuid)) {
        const rec = rings.get(uuid);
        try { rec.el.remove(); } catch {}
        rings.delete(uuid);
        if (selected.has(uuid)) selected.delete(uuid);
        updateBanner();
      }
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
      try { window.removeEventListener("keydown", onKey, true); } catch {}
      try { canvas.app.view.removeEventListener("pointerdown", handlerClick, true); } catch {}
      try { banner.remove(); } catch {}
      for (const rec of rings.values()) { try { rec.el.remove(); } catch {} }
      rings.clear();
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
