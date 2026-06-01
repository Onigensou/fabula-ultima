// Director Reaction Menu — token-anchored blade list for reactions.
//
// Replaces the action-card pill row (project_reaction_pills_on_action_card)
// per the [[reaction-menu-on-token]] pivot: many reactions don't have a
// host action card (High Speed at conflict_start, end-of-turn reactions,
// etc.), so unifying on a token-anchored menu keeps one UI for everything.
//
// Look: parchment + gold-stripe blade, same family as `turn-ui.js`'s
// Octopath menu — but red-stripe instead of blue-stripe so the user can
// distinguish "react to this" from "take my turn". Stagger-spin entrance
// is copied from turn-ui verbatim.
//
// API:
//   ReactionMenu.spawn({ token, candidates, onPick, onPass, combatId,
//                        trigger, label, autoCloseEmpty })
//     - token:          PIXI Token to anchor the menu on (reactor).
//     - candidates:     [{ rowKey, carrierUuid, carrierName, carrierImg,
//                         carrierDescription, mode, kind, ref }, ...].
//                       Auto-rendered as blades; "off"-mode entries are
//                       silently filtered out. Auto/On entries render as
//                       a non-clickable "Auto" chip — informational only,
//                       the caller is expected to have pre-recorded the
//                       decision already.
//     - onPick(cand):   called on blade click. Caller decides what to do
//                       (emit REACTION_CHOICE intent, dispatch into
//                       director, etc.). Required.
//     - onPass():       called on Pass blade click. Optional — when
//                       omitted the Pass blade is not rendered.
//     - combatId:       used for instance keying so multiple reactor
//                       menus coexist on the same client.
//     - trigger:        purely informational; tagged on the root for
//                       debugging. Doesn't affect render.
//     - label:          top-of-menu chip text ("Reaction"). Default
//                       "Reaction"; standalone triggers may pass e.g.
//                       "Start of Conflict" so the player knows the
//                       phase.
//
//   ReactionMenu.despawn({ combatId, tokenId })
//     - Close one specific menu by combat+token id.
//
//   ReactionMenu.despawnAll()
//     - Close every open reaction menu on this client (useful on
//       director.stop / scene change).
//
// Per-instance state lives in `_instances` keyed by `${combatId}:${tokenId}`
// so multiple reactor menus coexist on one client (mass-reaction case).
// Re-spawning on the same key replaces the prior instance cleanly.

import { log, warn } from "./logger.js";
import { ensureDescTooltipStyles, attachDescTooltip, hideDescTooltip } from "./desc-tooltip.js";

const STYLE_ID = "fud-reaction-menu-style";

const _instances = new Map();

function makeKey(combatId, tokenId) {
  return `${combatId ?? "no-combat"}:${tokenId ?? "no-token"}`;
}

function ensureBaseStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const css = document.createElement("style");
  css.id = STYLE_ID;
  css.textContent = `
    .fud-react-menu{
      position:fixed; left:0; top:0;
      z-index:var(--z-index-canvas, 0);
      pointer-events:none;
    }
    .fud-react-menu .pivot{ position:absolute; width:0; height:0; pointer-events:none }
    .fud-react-menu .item{ position:absolute; transform-origin:left center; pointer-events:auto }

    :root{
      /* Reaction menu uses a red-orange stripe so it visually differs
         from both turn-ui (blue) and the legacy reaction-buttonUI (gold). */
      --fud-react-parchment-top:#f6f1e6;
      --fud-react-parchment-bot:#ebe3d0;
      --fud-react-ink:#3a2a22;
      --fud-react-ink-soft:#4b3a30;
      --fud-react-stripe-1:#d57b5b;
      --fud-react-stripe-2:#a85738;
      --fud-react-stroke:#5a3a2c;
      --fud-react-shadow:rgba(41,24,18,.55);
      --fud-react-highlight:rgba(255,255,255,.7);
    }

    .fud-react-menu .blade{
      position:relative; display:inline-flex; align-items:center; gap:9px;
      padding:10px 22px 10px 22px;
      color:var(--fud-react-ink);
      font-family:"Inter","Segoe UI",system-ui,-apple-system,sans-serif;
      font-weight:800; letter-spacing:.32px; text-transform:uppercase; white-space:nowrap;
      user-select:none; cursor:pointer; transform-origin:left center; opacity:0;
      font-size:13px;
      background:linear-gradient(180deg,var(--fud-react-parchment-top),var(--fud-react-parchment-bot));
      border:2px solid var(--fud-react-stroke);
      border-radius:11px;
      box-shadow:0 4px 0 var(--fud-react-shadow), 0 0 0 1px var(--fud-react-highlight) inset;
      text-shadow:0 1px 0 var(--fud-react-highlight);
      transition: margin-left .12s ease-out, filter .12s ease, box-shadow .12s ease;
      will-change: margin-left, filter, box-shadow;
    }
    .fud-react-menu .blade:hover{
      margin-left:-6px; filter:brightness(1.04);
      box-shadow:0 6px 0 var(--fud-react-shadow), 0 0 0 1px var(--fud-react-highlight) inset;
    }
    .fud-react-menu .blade.is-auto{
      cursor:default; filter:grayscale(0.55) brightness(0.92); opacity:0.75;
    }
    .fud-react-menu .blade.is-auto:hover{
      margin-left:0; filter:grayscale(0.55) brightness(0.92);
      box-shadow:0 4px 0 var(--fud-react-shadow), 0 0 0 1px var(--fud-react-highlight) inset;
    }
    /* Disabled blade: muted under-blade + red rubber-stamp overlay
       (legacy "Used" stamp pattern from turn-ui-manager.js). The blade
       stays readable underneath so the player can identify which
       reaction the stamp is over. */
    .fud-react-menu .blade.is-disabled{
      cursor:default;
      filter:grayscale(0.45) brightness(0.88);
      opacity:0.78;
      overflow:visible;
    }
    .fud-react-menu .blade.is-disabled:hover{
      margin-left:0; filter:grayscale(0.45) brightness(0.88);
      box-shadow:0 4px 0 var(--fud-react-shadow), 0 0 0 1px var(--fud-react-highlight) inset;
    }
    .fud-react-menu .blade.is-disabled::after{
      content: attr(data-disabled-reason);
      position:absolute;
      top:50%; left:50%;
      transform: translate(-50%, -50%) rotate(-8deg);
      font-family:"Cinzel","Georgia",serif;
      font-weight:900;
      font-size:13px;
      letter-spacing:1.5px;
      text-transform:uppercase;
      color: rgba(200,16,16,1);
      text-shadow:
        0 1px 0 rgba(255,255,255,.7),
        0 0 1px rgba(120,0,0,.9);
      padding: 2px 10px;
      border: 2px solid rgba(200,16,16,.95);
      border-radius: 4px;
      background: rgba(255,238,228,.88);
      pointer-events: none;
      white-space: nowrap;
      z-index: 1;
    }
    .fud-react-menu .blade.is-pass{
      filter:saturate(0.55) brightness(0.96);
      font-size:11.5px;
    }
    .fud-react-menu .blade::before{
      content:""; position:absolute; left:-11px; top:50%; transform:translateY(-50%);
      width:11px; height:74%;
      background:linear-gradient(180deg,var(--fud-react-stripe-1),var(--fud-react-stripe-2));
      border:2px solid var(--fud-react-stroke); border-right:none; border-radius:9px 0 0 9px;
      box-shadow:0 0 0 1px var(--fud-react-highlight) inset;
    }
    .fud-react-menu .blade .icon{
      width:18px; height:18px; border-radius:4px;
      border:1px solid rgba(90,58,44,.55);
      object-fit:cover; flex:0 0 auto;
      background:rgba(255,255,255,.4);
    }
    /* Auto-mode chip (passive that auto-fires on match). Stays as a
       right-edge tag — semantically different from the disabled stamp
       and never co-occurs (auto-mode blades are non-disabled). */
    .fud-react-menu .blade .auto-tag{
      margin-left:auto; padding-left:8px;
      color:#7a4a3a; font-weight:900; letter-spacing:.5px; font-size:10px;
      text-transform:uppercase;
    }
    .fud-react-menu .header{
      position:absolute; display:flex; align-items:center;
      padding:5px 12px;
      border-radius:10px;
      font-family:"Inter","Segoe UI",system-ui,-apple-system,sans-serif;
      color:var(--fud-react-ink-soft);
      font-weight:800; letter-spacing:.32px; text-transform:uppercase;
      font-size:11px;
      background:linear-gradient(180deg,var(--fud-react-parchment-top),var(--fud-react-parchment-bot));
      border:2px solid var(--fud-react-stroke);
      box-shadow:0 3px 0 var(--fud-react-shadow), 0 0 0 1px var(--fud-react-highlight) inset;
      text-shadow:0 1px 0 var(--fud-react-highlight);
      white-space:nowrap; pointer-events:none;
      z-index:2;
      opacity:0;
      transition:opacity 200ms ease-out;
    }
    .fud-react-menu .header::before{
      content:""; width:8px; height:8px; border-radius:50%;
      background:linear-gradient(180deg,var(--fud-react-stripe-1),var(--fud-react-stripe-2));
      border:1.5px solid var(--fud-react-stroke);
      box-shadow:0 0 0 1px var(--fud-react-highlight) inset;
      margin-right:7px;
      flex-shrink:0;
    }
  `;
  document.head.appendChild(css);
}

function worldToClient(token, ax, ay) {
  const wt = canvas.stage.worldTransform;
  const out = new PIXI.Point();
  wt.apply({ x: ax, y: ay }, out);
  const rect = canvas.app.view.getBoundingClientRect();
  return { x: rect.left + out.x, y: rect.top + out.y };
}

// Anchor right-of-token, slightly above center — mirrors turn-ui's
// anchor so the reaction menu sits on the same side as Take Action.
// Standalone reactions resolve before Take Action surfaces (the FSM
// awaits dispatch), so the two menus don't visually compete.
function worldAnchor(token) {
  if (!token || token.destroyed) return { x: 0, y: 0 };
  try {
    const c = token.center ?? token.getCenter?.() ?? {
      x: (token.x ?? 0) + (token.w ?? 100) / 2,
      y: (token.y ?? 0) + (token.h ?? 100) / 2,
    };
    return {
      x: c.x + (token.w ?? 100) * 0.52,
      y: c.y - (token.h ?? 100) * 0.10,
    };
  } catch (_e) {
    return { x: 0, y: 0 };
  }
}

// disabledLabels: Record<string, string> — keyed by `${carrierUuid}::${rowKey}`,
// value is the label text shown on a disabled blade (e.g. "Hina Acting").
// Blades whose key matches render greyed-out with the label overlay and
// reject clicks. Used by the multi-reactor dispatcher to mark
// action-creating reactions as unavailable while a peer is mid-action.
function spawnMenuInternal({ director, token, combatId, candidates, onPick, onPass, label, trigger, passLabel, disabledLabels = null }) {
  ensureBaseStyles();

  // Filter out "off"-mode candidates — they're auto-rejected and don't
  // need a blade. Auto ("on")-mode candidates DO render (so the player
  // sees the menu's full reactor surface) but as a non-clickable "Auto"
  // chip; the caller is expected to have already recorded their decision.
  // Hide "off" (auto-rejected) and "force" (engine-mandatory, no
  // player choice — should already be auto-fired by the dispatcher
  // before this menu spawns; this filter is defensive).
  const visible = (candidates ?? []).filter((c) => c?.mode !== "off" && c?.mode !== "force");

  const root = document.createElement("div");
  root.className = "fud-react-menu";
  root.id = `fud-react-menu-${combatId ?? "x"}-${token.id ?? "y"}`;
  if (trigger) root.dataset.fudTrigger = String(trigger);

  const pivot = document.createElement("div");
  pivot.className = "pivot";
  root.appendChild(pivot);

  const header = document.createElement("div");
  header.className = "header";
  header.textContent = String(label ?? "Reaction");
  root.appendChild(header);

  document.body.appendChild(root);

  const DURATION_MS = 360, STAGGER_MS = 28, SPIN_DEG = 360, SCALE_MIN = 0.93;
  const GAP_PX = 5, HEADER_GAP_PX = 8, BLADE_PAD_X = 12;
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const easeOutQuint = (t) => 1 - Math.pow(1 - t, 5);
  const easeOutBack = (t, s = 0.90) => 1 + ((t = t - 1) * ((s + 1) * t + s) * t);

  // Build the blade DOM. Each entry: { wrap, btn, candidate, kind, slotX, slotY,
  // tStart, bound }.
  const items = [];

  // Live disable lookup — keyed by `${carrierUuid}::${rowKey}`. Mutable
  // so updateDisabledLabels() can swap entries in-place without tearing
  // down + respawning the menu (jarring re-render is the load-bearing
  // UX bug we're avoiding here).
  let _disabledMap = (disabledLabels && typeof disabledLabels === "object")
    ? new Map(Object.entries(disabledLabels))
    : new Map();
  function disabledLabelFor(candidate) {
    if (!candidate) return null;
    const key = `${candidate.carrierUuid}::${candidate.rowKey}`;
    return _disabledMap.get(key) ?? null;
  }

  function makeBlade({ candidate, isPass }) {
    const wrap = document.createElement("div");
    wrap.className = "item";
    const btn = document.createElement("div");
    btn.className = "blade";
    if (isPass) {
      btn.classList.add("is-pass");
      btn.innerHTML = `<span class="label">${escapeHtml(passLabel ?? "Pass")}</span>`;
    } else {
      const safeName = String(candidate?.carrierName ?? "Reaction");
      const iconHtml = candidate?.carrierImg
        ? `<img class="icon" src="${candidate.carrierImg}" alt="" />`
        : "";
      const isAuto = candidate?.mode === "on";
      if (isAuto) btn.classList.add("is-auto");
      const disabledLbl = disabledLabelFor(candidate);
      if (disabledLbl) {
        btn.classList.add("is-disabled");
        // Rubber-stamp overlay — text comes from data-disabled-reason
        // via the ::after pseudo-element. NOT rendered as a child span
        // so the stamp can overlay-rotate over the blade body
        // (legacy turn-ui-manager.js "is-used" pattern).
        btn.setAttribute("data-disabled-reason", disabledLbl);
      }
      // Auto-mode chip stays as a right-edge tag — never co-occurs with
      // disabled (auto blades fire silently; the disabled stamp would
      // never apply to one).
      const tag = isAuto ? `<span class="auto-tag">Auto</span>` : "";
      btn.innerHTML = `${iconHtml}<span class="label">${escapeHtml(safeName)}</span>${tag}`;
      // Dwell-tooltip — same surface as the action card's pill row.
      // The shared desc-tooltip module reads data-fud-equip-desc /
      // data-fud-equip-desc-name on hover. Includes a "Mode" footer
      // chip so the player sees auto/ask dispatch behavior.
      const modeLabel =
        candidate?.mode === "on"     ? "Auto-apply (On)" :
        candidate?.mode === "force"  ? "Engine-forced"   :
        candidate?.kind === "manual" ? "Manual reaction" :
                                       "Asks (You choose)";
      const descBody =
        (candidate?.carrierDescription ?? "") +
        `<div class="fud-bf-reaction-tip-foot">Mode: ${escapeHtml(modeLabel)}</div>`;
      btn.dataset.fudEquipDesc     = descBody;
      btn.dataset.fudEquipDescName = safeName;
    }
    btn.style.pointerEvents = "none";
    wrap.appendChild(btn);
    root.appendChild(wrap);
    return { wrap, btn };
  }

  for (const candidate of visible) {
    const { wrap, btn } = makeBlade({ candidate, isPass: false });
    items.push({
      wrap, btn, candidate,
      isPass: false,
      tStart: 0, slotX: 0, slotY: 0, bound: false,
    });
  }
  if (typeof onPass === "function") {
    const { wrap, btn } = makeBlade({ candidate: null, isPass: true });
    items.push({
      wrap, btn, candidate: null,
      isPass: true,
      tStart: 0, slotX: 0, slotY: 0, bound: false,
    });
  }

  const startClock = performance.now();

  function computeSlots() {
    if (!items.length) return;
    const a = worldAnchor(token);
    const ctr = worldToClient(token, a.x, a.y);
    const hProbe = items[0]?.btn?.getBoundingClientRect()?.height || 18;
    const rowH = hProbe + GAP_PX;
    const totalRise = rowH * (items.length - 1);
    // Left-align every blade at a common slotX (anchor + pad) so the
    // stripe + icon + name form a consistent left edge across the menu,
    // mirroring turn-ui's Octopath stack.
    const slotX = ctr.x + BLADE_PAD_X;
    for (let i = 0; i < items.length; i++) {
      items[i].slotX = slotX;
      items[i].slotY = (ctr.y - totalRise) + i * rowH;
    }
    pivot.style.left = `${ctr.x}px`;
    pivot.style.top = `${ctr.y}px`;
    // Header sits above the first blade, aligned to the same left edge.
    const first = items[0];
    if (first) {
      const itemH = hProbe;
      const headerH = header.offsetHeight || 22;
      const firstTopY = first.slotY - itemH / 2;
      const headerTopY = firstTopY - HEADER_GAP_PX - headerH;
      header.style.left = `${slotX}px`;
      header.style.top  = `${headerTopY}px`;
    }
  }

  function render() {
    if (!document.body.contains(root)) return;
    computeSlots();
    const now = performance.now();
    const ax = parseFloat(pivot.style.left);
    const ay = parseFloat(pivot.style.top);
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it.tStart) it.tStart = startClock + i * STAGGER_MS;
      const p = clamp01((now - it.tStart) / DURATION_MS);
      const t = easeOutBack(p, 0.90);
      const x = ax + (it.slotX - ax) * t;
      const y = ay + (it.slotY - ay) * t;
      const angleDeg = 0 - (1 - easeOutQuint(p)) * SPIN_DEG;
      const opacity = Math.pow(p, 0.8);
      const scale = SCALE_MIN + (1 - SCALE_MIN) * easeOutQuint(p);
      it.wrap.style.left = `${x}px`;
      it.wrap.style.top = `${y}px`;
      it.wrap.style.transform = `translate(0,-50%) rotate(${angleDeg}deg) scale(${scale})`;
      it.btn.style.transform = `rotate(${-angleDeg}deg)`;
      it.btn.style.opacity = opacity.toFixed(3);
    }
  }

  // Bind click handlers eagerly — the menu must be interactable even
  // when PIXI.Ticker.shared isn't firing. Paused-game (Foundry's
  // pause UI) freezes the shared ticker, so the prior gate of
  // `p >= 1` would have left blades click-dead until unpause.
  //
  // The disabled check is re-evaluated AT CLICK TIME (not at bind time)
  // so updateDisabledLabels() can change a blade's availability without
  // re-binding. Cursor styling follows the live state.
  function bindClicks() {
    for (const it of items) {
      if (it.bound) continue;
      it.btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (it.isPass) {
          try { onPass?.(); }
          catch (e) { warn("ReactionMenu: onPass threw", e); }
          return;
        }
        // Auto-mode candidates are informational only — clicking does
        // nothing (the decision is already recorded upstream).
        if (it.candidate?.mode === "on") return;
        // Live disabled check — reads _disabledMap at click time so
        // peer-acting / used / unaffordable blades reject clicks even
        // after the disable map mutates.
        if (disabledLabelFor(it.candidate)) return;
        try { onPick?.(it.candidate); }
        catch (e) { warn("ReactionMenu: onPick threw", e); }
      });
      it.btn.style.pointerEvents = "auto";
      it.bound = true;
    }
  }

  // In-place blade DOM mutation. Toggles `.is-disabled` class and the
  // `data-disabled-reason` attribute — the rubber-stamp ::after
  // pseudo-element re-reads the attr on every style recalc, so the
  // stamp text updates without touching any child nodes. NEVER
  // re-spawns the menu — the entrance-animation replay would be jarring
  // to the user (the load-bearing requirement here).
  //
  // Called from updateDisabledLabels(map) on the returned record.
  // Caller mutates _disabledMap first, then calls this to sync DOM.
  function refreshBladesInPlace() {
    for (const it of items) {
      if (it.isPass || !it.candidate) continue;
      if (it.candidate.mode === "on") continue;  // auto chip stays put
      const lbl = disabledLabelFor(it.candidate);
      const hadDisabled = it.btn.classList.contains("is-disabled");
      if (lbl) {
        if (!hadDisabled) it.btn.classList.add("is-disabled");
        const cur = it.btn.getAttribute("data-disabled-reason");
        if (cur !== lbl) it.btn.setAttribute("data-disabled-reason", lbl);
        it.btn.style.cursor = "default";
      } else {
        if (hadDisabled) it.btn.classList.remove("is-disabled");
        if (it.btn.hasAttribute("data-disabled-reason")) it.btn.removeAttribute("data-disabled-reason");
        it.btn.style.cursor = "";
      }
    }
  }

  // Initial sync render — positions every wrap to its target slot and
  // sets opacity to 1 / scale to 1 (skipping the entrance animation
  // when the ticker is dormant). When the ticker IS running, its first
  // tick will re-render with animated `t` values; the eye picks up the
  // animation from there. This guarantees the menu is visible AND
  // clickable on spawn even under pause.
  computeSlots();
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    it.wrap.style.left = `${it.slotX}px`;
    it.wrap.style.top = `${it.slotY}px`;
    it.wrap.style.transform = `translate(0,-50%) scale(1)`;
    it.btn.style.opacity = "1";
  }
  bindClicks();

  const ticker = PIXI.Ticker.shared;
  let tickErrCount = 0;
  const tickFn = () => {
    try { render(); }
    catch (e) {
      tickErrCount++;
      if (tickErrCount <= 3) warn("ReactionMenu render threw", e);
      if (tickErrCount > 60) {
        warn("ReactionMenu render: too many errors, aborting tick");
        try { ticker.remove(tickFn); } catch {}
      }
    }
  };
  ticker.add(tickFn);

  // Position-tracking hooks. GM uses director.hooks (managed cleanup via
  // director.disposeAll); player has no director, so we register on the
  // global Hooks bus and tear down manually in cleanup().
  const manualHookCleanups = [];
  if (director?.hooks?.on) {
    director.hooks.on("updateToken", (doc) => {
      if (doc?.id === token.document?.id) render();
    }, { label: "reaction-menu:updateToken" });
    director.hooks.on("canvasPan", render, { label: "reaction-menu:canvasPan" });
  } else {
    const onUpdateToken = (doc) => {
      if (doc?.id === token.document?.id) render();
    };
    const onCanvasPan = () => render();
    const hookIdUpdate = Hooks.on("updateToken", onUpdateToken);
    const hookIdPan = Hooks.on("canvasPan", onCanvasPan);
    manualHookCleanups.push(() => { try { Hooks.off("updateToken", hookIdUpdate); } catch {} });
    manualHookCleanups.push(() => { try { Hooks.off("canvasPan", hookIdPan); } catch {} });
  }

  requestAnimationFrame(() => { header.style.opacity = "1"; });

  // Dwell-tooltip (shared with the action card's reaction pills, equipment
  // options, item rows, etc.). Bind to the menu root; the shared module's
  // singleton tooltip surfaces on hover of any blade carrying
  // data-fud-equip-desc. `isAlive` guards against a tooltip popping up
  // after the menu closes mid-dwell (user clicked away).
  let menuAlive = true;
  const detachTooltip = attachDescTooltip(root, { isAlive: () => menuAlive });

  function cleanup() {
    menuAlive = false;
    try { detachTooltip?.(); } catch {}
    try { hideDescTooltip(); } catch {}
    try { ticker.remove(tickFn); } catch {}
    try { root.remove(); } catch {}
    for (const fn of manualHookCleanups) {
      try { fn(); } catch {}
    }
  }

  // Live-update the disabled overlay map. Callers pass the new full map
  // (Record<carrierUuid::rowKey, label> | null/empty for "no blocks").
  // DOM is mutated in place; entrance animation is NOT replayed.
  function updateDisabledLabels(next) {
    _disabledMap = (next && typeof next === "object")
      ? new Map(Object.entries(next))
      : new Map();
    try { refreshBladesInPlace(); }
    catch (e) { warn("ReactionMenu.updateDisabledLabels: refresh threw", e); }
  }

  return { cleanup, updateDisabledLabels, root };
}

// Tiny HTML helpers. Local copies so this module has no cross-module
// dep beyond the logger.
function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
function stripHtml(s) {
  return String(s ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const ReactionMenu = {
  // Spawn a token-anchored reaction menu. Replaces any prior menu for
  // the same (combatId, tokenId) pair. Returns the record or null when
  // there's nothing to show (no candidates and no onPass).
  spawn(opts) {
    const { token, candidates, onPick, onPass, combatId, director, label, trigger, passLabel, disabledLabels } = opts ?? {};
    if (!token) {
      warn("ReactionMenu.spawn: missing token");
      return null;
    }
    // Hide "off" (auto-rejected) and "force" (engine-mandatory, no
  // player choice — should already be auto-fired by the dispatcher
  // before this menu spawns; this filter is defensive).
  const visible = (candidates ?? []).filter((c) => c?.mode !== "off" && c?.mode !== "force");
    if (!visible.length && typeof onPass !== "function") {
      // Nothing to show: every candidate is off-mode and no passthrough.
      return null;
    }

    const key = makeKey(combatId, token.id);
    const prior = _instances.get(key);
    if (prior) { try { prior.cleanup(); } catch {} }

    const rec = spawnMenuInternal({
      director, token, combatId,
      candidates: visible, onPick, onPass, label, trigger, passLabel,
      disabledLabels,
    });
    _instances.set(key, rec);
    log(`ReactionMenu: spawned ${visible.length} candidate(s) on ${token?.name ?? token.id} for ${trigger ?? "?"}`);
    return rec;
  },

  despawn({ combatId, tokenId } = {}) {
    const key = makeKey(combatId, tokenId);
    const rec = _instances.get(key);
    if (!rec) return;
    try { rec.cleanup(); } catch {}
    _instances.delete(key);
  },

  despawnAll() {
    for (const rec of _instances.values()) {
      try { rec.cleanup(); } catch {}
    }
    _instances.clear();
  },

  // In-place update of the disabled-blade overlay for an already-spawned
  // menu. Returns true if a menu was found + updated, false if no such
  // instance is open (caller can ignore or fallback). Doesn't re-spawn,
  // doesn't replay the entrance animation. Used by the multi-reactor
  // dispatcher to mark blades unavailable WITHOUT the jarring redraw of
  // a full despawn+spawn cycle.
  updateDisabledLabels({ combatId, tokenId, disabledLabels } = {}) {
    const key = makeKey(combatId, tokenId);
    const rec = _instances.get(key);
    if (!rec || typeof rec.updateDisabledLabels !== "function") return false;
    try { rec.updateDisabledLabels(disabledLabels); }
    catch (e) { warn("ReactionMenu.updateDisabledLabels: instance threw", e); return false; }
    return true;
  },
};
