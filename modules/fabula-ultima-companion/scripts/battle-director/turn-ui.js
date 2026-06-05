// Director Turn UI — Octopath command-button menu, ported from
// scripts/turn-ui-manager.js into a director-namespaced version.
//
// Visual parity with the legacy turn UI is intentional ("replicate the UI of
// legacy system" per the prototype brief). To keep both systems coexistent
// without CSS or DOM collisions, this version:
//
//   - Uses the CSS prefix `fud-octopath` instead of `oni-octopath`.
//   - Spawn works on BOTH GM and player clients — director is optional.
//     GM-acting-on-NPC uses local dispatch; player-owned acting actor
//     spawns on the owner's client via MENU_OPEN and emits an INTENT
//     back over the socket. See [[director-player-driven-input]].
//
// Click → `onPick(command)` callback (caller decides what to do):
//   - GM: dispatch DECLARE_COMMAND into the director directly.
//   - Player: emit DECLARE_COMMAND over IntentChannel → GM dispatches.
//
// All other behavior (animation, pager, SFX, hooks for camera pan) is copied
// from the legacy verbatim — modified only to namespace state and not to
// listen for the legacy `oni:*` socket messages.

import { log, warn } from "./logger.js";
import { INTENTS } from "./intents.js";
import { PassiveManager } from "./passive-manager.js";
import { playUiHoverSfx, playUiTabSwitchSfx } from "./director-ui-sfx.js";

const STYLE_ID = "fud-turnui-style";

const LEGACY_PAGES = [
  { name: "Actions", items: ["Attack", "Guard", "Skill", "Spell", "Item"] },
  // Party Swap (legacy "Switch") and Objective hidden until D.6/D.7 ship.
  // "Passive" is the bottom entry on the System tab — intercepted in the
  // click handler (it does NOT dispatch DECLARE_COMMAND; it just opens
  // the parchment Passive Manager overlay for the current combatant).
  { name: "System",  items: ["Equipment", "Study", "Hinder", "Passive"] }
];

// Commands that bypass the FSM dispatch — clicking them opens an
// overlay/dialog directly instead of declaring an action. Listed here
// so the click handler can short-circuit cleanly.
const NON_ACTION_COMMANDS = new Set(["Passive"]);

// Per-director instance state — keyed by combatId so multiple directors
// don't collide on the same client.
const _instances = new Map();

function ensureBaseStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const css = document.createElement("style");
  css.id = STYLE_ID;
  css.textContent = `
    .fud-octopath{
      position:fixed; left:0; top:0;
      z-index:var(--z-index-canvas, 0);
      pointer-events:none;
    }
    .fud-octopath .pivot{ position:absolute; width:0; height:0; pointer-events:none }
    .fud-octopath .item{ position:absolute; transform-origin:left center; pointer-events:auto }

    :root {
      --fud-parchment-top:#f6f1e6;
      --fud-parchment-bot:#ebe3d0;
      --fud-ink:#3a3228;
      --fud-ink-soft:#4b4338;
      --fud-gold-1:#d5b67a;
      --fud-gold-2:#b7935a;
      --fud-stroke:#7a6a55;
      --fud-shadow:rgba(41,33,24,.55);
      --fud-highlight:rgba(255,255,255,.7);
    }

    .fud-octopath .blade{
      position:relative; display:inline-flex; align-items:center; gap:9px;
      padding:10px 16px 10px 22px;
      color:var(--fud-ink);
      font-family:"Inter","Segoe UI",system-ui,-apple-system,sans-serif;
      font-weight:800; letter-spacing:.32px; text-transform:uppercase; white-space:nowrap;
      user-select:none; cursor:pointer; transform-origin:left center; opacity:0;
      font-size:13.5px;
      background:linear-gradient(180deg,var(--fud-parchment-top),var(--fud-parchment-bot));
      border:2px solid var(--fud-stroke);
      border-radius:12px;
      box-shadow:0 4px 0 var(--fud-shadow), 0 0 0 1px var(--fud-highlight) inset;
      text-shadow:0 1px 0 var(--fud-highlight);
      transition: margin-left .12s ease-out, filter .12s ease, box-shadow .12s ease;
      will-change: margin-left, filter, box-shadow;
    }
    .fud-octopath .blade:hover{
      margin-left:-6px; filter:brightness(1.04);
      box-shadow:0 6px 0 var(--fud-shadow), 0 0 0 1px var(--fud-highlight) inset;
    }
    .fud-octopath .blade.is-kb-focused{
      margin-left:-6px; filter:brightness(1.06);
      box-shadow:0 6px 0 var(--fud-shadow), 0 0 0 1px var(--fud-highlight) inset;
    }
    .fud-octopath .blade.is-kb-focused::before{
      filter:brightness(1.18);
    }
    .fud-octopath .blade.fud-disabled{
      cursor:not-allowed; filter:grayscale(0.6) brightness(0.85); opacity:0.55;
    }
    .fud-octopath .blade.fud-disabled:hover{
      margin-left:0; filter:grayscale(0.6) brightness(0.85);
      box-shadow:0 4px 0 var(--fud-shadow), 0 0 0 1px var(--fud-highlight) inset;
    }
    .fud-octopath .blade::before{
      content:""; position:absolute; left:-12px; top:50%; transform:translateY(-50%);
      width:12px; height:76%;
      background:linear-gradient(180deg,var(--fud-gold-1),var(--fud-gold-2));
      border:2px solid var(--fud-stroke); border-right:none; border-radius:10px 0 0 10px;
      box-shadow:0 0 0 1px var(--fud-highlight) inset;
    }
    .fud-octopath .pager{
      position:absolute; display:flex; align-items:center; justify-content:space-between;
      gap:8px; pointer-events:auto;
      font-family:"Inter","Segoe UI",system-ui,-apple-system,sans-serif;
      color:var(--fud-ink-soft); font-weight:800; letter-spacing:.32px; text-transform:uppercase;
      z-index:2;
    }
    .fud-octopath .pager .title{
      padding:6px 10px; border-radius:10px;
      background:linear-gradient(180deg,var(--fud-parchment-top),var(--fud-parchment-bot));
      border:2px solid var(--fud-stroke);
      box-shadow:0 3px 0 var(--fud-shadow), 0 0 0 1px var(--fud-highlight) inset;
      font-size:12.5px;
    }
    .fud-octopath .pager .arrow{
      width:24px; height:24px; border-radius:7px; display:grid; place-items:center;
      background:linear-gradient(180deg,var(--fud-gold-1),var(--fud-gold-2));
      border:2px solid var(--fud-stroke); cursor:pointer; user-select:none;
      box-shadow:0 2px 0 var(--fud-shadow), 0 0 0 1px var(--fud-highlight) inset;
      color:#221b14; font-weight:900; font-size:13px;
      transition:transform .1s ease, filter .1s ease;
    }
    .fud-octopath .pager .arrow:hover{ transform:translateY(-1px); filter:brightness(1.05) }
    .fud-octopath .pager .arrow:active{ transform:translateY(0) scale(.98) }
    .fud-octopath .budget-label{
      position:absolute; display:flex; align-items:center; gap:8px;
      padding:5px 12px 5px 12px;
      border-radius:10px;
      box-sizing:border-box;
      font-family:"Inter","Segoe UI",system-ui,-apple-system,sans-serif;
      color:var(--fud-ink-soft);
      font-weight:800; letter-spacing:.32px; text-transform:uppercase;
      font-size:11px;
      background:linear-gradient(180deg,var(--fud-parchment-top),var(--fud-parchment-bot));
      border:2px solid var(--fud-stroke);
      box-shadow:0 3px 0 var(--fud-shadow), 0 0 0 1px var(--fud-highlight) inset;
      text-shadow:0 1px 0 var(--fud-highlight);
      white-space:nowrap;
      pointer-events:none;
      z-index:2;
      opacity:0;
      transition:opacity 200ms ease-out;
    }
    .fud-octopath .budget-label::before{
      content:""; width:8px; height:8px; border-radius:50%;
      background:linear-gradient(180deg,var(--fud-gold-1),var(--fud-gold-2));
      border:1.5px solid var(--fud-stroke);
      box-shadow:0 0 0 1px var(--fud-highlight) inset;
      flex-shrink:0;
    }
    .fud-octopath .budget-label .director-tag{
      margin-left:auto; padding-left:8px;
      color:#7a6a55;
      opacity:.85; font-weight:900; letter-spacing:.5px; font-size:10px;
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

function worldAnchor(token) {
  if (!token || token.destroyed) return { x: 0, y: 0 };
  try {
    const c = token.center ?? token.getCenter?.() ?? { x: (token.x ?? 0) + (token.w ?? 100) / 2, y: (token.y ?? 0) + (token.h ?? 100) / 2 };
    return { x: c.x + (token.w ?? 100) * 0.52, y: c.y - (token.h ?? 100) * 0.10 };
  } catch (e) {
    return { x: 0, y: 0 };
  }
}

// Spawn the menu over a given token. Returns a `record` with cleanup()
// that the caller invokes to despawn.
//
// Params:
//   - director:  optional. GM client passes the running director; player
//                client passes null. When present, position-tracking hooks
//                register via director.hooks (managed cleanup). Without
//                it, hooks register on `Hooks.on` and we tear them down
//                manually in cleanup().
//   - token:     the token to anchor over (required, on both clients).
//   - combatId:  used for DOM id keying. If not passed, falls back to
//                director?.combatId.
//   - onPick:    (command) => void. Called when a non-passive button is
//                clicked. GM dispatches into director; player emits
//                intent over socket. Must be supplied if no director.
//   - onPassive: () => void. Called when the Passive button is clicked.
//                Default opens PassiveManager for the actor.
function spawnMenu({ director, token, combatId, onPick, onPassive, enabledLabels = null, budgetText = null }) {
  ensureBaseStyles();

  // Free-action mode (enabledLabels supplied): collapse the multi-page
  // Octopath into ONE curated page containing only the allowed commands
  // + Passive (always-allowed; opens the manager overlay without
  // consuming the action) + Cancel (forfeit the grant per the locked
  // cancel-pops-request rule). The pager UI is hidden since there's
  // only one page.
  const filterMode = Array.isArray(enabledLabels) && enabledLabels.length > 0;
  const PAGES = filterMode
    ? (() => {
        const allowed = new Set(enabledLabels.map((s) => String(s).trim()));
        const flat = LEGACY_PAGES.flatMap((p) => p.items);
        const filtered = flat.filter((label) => allowed.has(label));
        // Passive only shown when explicitly included in enabledLabels — omitting
        // it keeps the menu clean for single-type free actions like Voracious.
        const items = [
          ...filtered.map((label) => ({ label })),
          ...(allowed.has("Passive") ? [{ label: "Passive" }] : []),
          { label: "Cancel" },
        ];
        return [{ name: "Free Action", items }];
      })()
    : LEGACY_PAGES.map((p) => ({
        name: p.name,
        items: p.items.map((s) => ({ label: s })),
      }));
  let pageIndex = 0;

  const root = document.createElement("div");
  root.className = "fud-octopath";
  root.id = `fud-octopath-${combatId ?? "no-combat"}`;

  const pivot = document.createElement("div");
  pivot.className = "pivot";
  root.appendChild(pivot);

  const pager = document.createElement("div");
  pager.className = "pager";
  const leftA = document.createElement("div"); leftA.className = "arrow"; leftA.textContent = "◀";
  const title = document.createElement("div"); title.className = "title"; title.textContent = PAGES[pageIndex].name;
  const rightA = document.createElement("div"); rightA.className = "arrow"; rightA.textContent = "▶";
  pager.append(leftA, title, rightA);
  root.appendChild(pager);
  // Hide pager arrows when there's only one page (filterMode). Title
  // stays as the "Free Action" label.
  if (PAGES.length <= 1) {
    leftA.style.visibility = "hidden";
    rightA.style.visibility = "hidden";
    leftA.style.pointerEvents = "none";
    rightA.style.pointerEvents = "none";
  }

  const budgetLabel = document.createElement("div");
  budgetLabel.className = "budget-label";
  const budgetMain = document.createElement("span");
  budgetMain.textContent = budgetText ?? "Turn Action";
  budgetLabel.append(budgetMain);
  root.appendChild(budgetLabel);

  // Free-action filter: filterMode pre-filters PAGES to only include
  // allowed commands + Passive + Cancel, so every rendered button is
  // by-construction enabled. isEnabledLabel returns true uniformly in
  // filterMode; the legacy grey-out path (when enabledLabels was
  // supplied without filterMode) remains for backwards compatibility
  // but is no longer reached by composeAction.
  const enabledSet = Array.isArray(enabledLabels) && enabledLabels.length
    ? new Set(enabledLabels.map((s) => String(s).trim()))
    : null;
  function isEnabledLabel(label) {
    if (filterMode) return true;
    if (!enabledSet) return true;
    if (NON_ACTION_COMMANDS.has(label)) return true;
    return enabledSet.has(label);
  }

  // Hide the pager arrows when there's only one page (filterMode).
  // The page title "Free Action" remains as a label.

  document.body.appendChild(root);

  const DURATION_MS = 360, STAGGER_MS = 30, SPIN_DEG = 360, SCALE_MIN = 0.93;
  const EDGE_PAD_X = 12, EDGE_PAD_Y = 50, GAP_PX = 6;
  const LABEL_TO_ATTACK_GAP = 10, PAGER_TO_LABEL_GAP = 8;
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const easeOutQuint = (t) => 1 - Math.pow(1 - t, 5);
  const easeOutBack = (t, s = 0.90) => 1 + ((t = t - 1) * ((s + 1) * t + s) * t);

  const items = [];
  let startClock = performance.now();
  let kbIndex = 0;

  function setKbFocus(idx) {
    if (!items.length) return;
    kbIndex = ((idx % items.length) + items.length) % items.length;
    for (let i = 0; i < items.length; i++) {
      items[i].btn.classList.toggle("is-kb-focused", i === kbIndex);
    }
    if (isEnabledLabel(items[kbIndex]?.label)) playUiHoverSfx();
  }

  function buildPage() {
    for (const it of items.splice(0)) it.wrap.remove();
    const ITEMS = PAGES[pageIndex].items;
    for (let i = 0; i < ITEMS.length; i++) {
      const spec = ITEMS[i];
      const label = String(spec.label ?? "");
      const wrap = document.createElement("div"); wrap.className = "item";
      const btn = document.createElement("div"); btn.className = "blade";
      btn.innerHTML = `<span class="label">${label}</span>`;
      btn.style.pointerEvents = "none";
      wrap.appendChild(btn); root.appendChild(wrap);
      items.push({ wrap, btn, tStart: 0, slotX: 0, slotY: 0, bound: false, label });
    }
    title.textContent = PAGES[pageIndex].name;
    startClock = performance.now();
    kbIndex = 0; // reset focus to top of new page (no SFX — tab SFX plays separately)
  }

  function computeSlots() {
    if (!items.length) return;
    const a = worldAnchor(token);
    const ctr = worldToClient(token, a.x, a.y);
    const hProbe = items[0]?.btn?.getBoundingClientRect()?.height || 18;
    const rowH = hProbe + GAP_PX;
    const totalRise = rowH * (items.length - 1);
    for (let i = 0; i < items.length; i++) {
      items[i].slotX = ctr.x + EDGE_PAD_X;
      items[i].slotY = (ctr.y - totalRise) + EDGE_PAD_Y + i * rowH;
    }
    pivot.style.left = `${ctr.x}px`; pivot.style.top = `${ctr.y}px`;
    const first = items[0];
    if (first) {
      pager.style.width = "";
      budgetLabel.style.width = "";
      const itemH = hProbe;
      const pagerH = pager.offsetHeight || 28;
      const labelH = budgetLabel.offsetHeight || 24;
      const attackTopY = first.slotY - itemH / 2;
      const labelBotY = attackTopY - LABEL_TO_ATTACK_GAP;
      const labelTopY = labelBotY - labelH;
      const pagerBotY = labelTopY - PAGER_TO_LABEL_GAP;
      const pagerTopY = pagerBotY - pagerH;
      pager.style.left = `${first.slotX}px`; pager.style.top = `${pagerTopY}px`;
      budgetLabel.style.left = `${first.slotX}px`; budgetLabel.style.top = `${labelTopY}px`;
      const pw = pager.offsetWidth;
      const lw = budgetLabel.offsetWidth;
      const maxW = Math.max(pw, lw);
      if (maxW > 0) { pager.style.width = `${maxW}px`; budgetLabel.style.width = `${maxW}px`; }
    }
  }

  function render() {
    if (!document.body.contains(root)) return;
    if (items.length === 0) buildPage();
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
      const animOpacity = Math.pow(p, 0.8);
      const scale = SCALE_MIN + (1 - SCALE_MIN) * easeOutQuint(p);
      // Disabled gate — re-evaluated every tick because the per-frame
      // opacity write below would otherwise clobber the dim style we
      // set once at bind time. Multiplying by 0.2 keeps the blade
      // visible during the spin-in then settles at a strongly muted
      // value (~ 0.18 final).
      const isEnabled = isEnabledLabel(it.label);
      it.wrap.style.left = `${x}px`;
      it.wrap.style.top = `${y}px`;
      it.wrap.style.transform = `translate(0,-50%) rotate(${angleDeg}deg) scale(${scale})`;
      it.btn.style.transform = `rotate(${-angleDeg}deg)`;
      it.btn.style.opacity = (isEnabled ? animOpacity : animOpacity * 0.22).toFixed(3);
      it.btn.classList.toggle("is-kb-focused", i === kbIndex && isEnabled);
      if (!isEnabled) {
        // Greyscale + no-pointer apply once (idempotent assignments
        // are cheap; setting an unchanged style is a no-op in the
        // browser's style engine).
        it.btn.style.filter = "grayscale(0.95) brightness(0.55)";
        it.btn.style.pointerEvents = "none";
        it.btn.style.cursor = "not-allowed";
      }
      if (!it.bound && p >= 1) {
        if (!isEnabled) {
          it.btn.title = enabledLabels?.length
            ? `Disabled — free action allows: ${enabledLabels.join(", ")}`
            : "Disabled";
          it.bound = true;
          continue;
        }
        it.btn.addEventListener("click", async (ev) => {
          ev.stopPropagation();
          // Cancel button (free-action mode) — resolve the picker with
          // null so the host's cancelSentinel-equivalent path runs.
          // composeAction treats `command === null` as cancellation and
          // DECLARE.TIMEOUT then routes to FREE_ACTION_WINDOW (per the
          // cancel-pops-request rule).
          if (it.label === "Cancel") {
            try { onPick?.(null); }
            catch (e) { warn("Turn UI: onPick(null) threw", e); }
            return;
          }
          // Non-action commands open an overlay instead of declaring an
          // action — they don't consume the turn. Currently: "Passive".
          if (NON_ACTION_COMMANDS.has(it.label)) {
            if (it.label === "Passive") {
              try { await onPassive?.(); }
              catch (e) { warn("Turn UI: onPassive threw", e); }
            }
            return;
          }
          // Fire the pick callback. Caller decides whether to dispatch
          // locally (GM) or emit over socket (player).
          try { onPick?.(it.label); }
          catch (e) { warn("Turn UI: onPick threw", e); }
        });
        it.btn.style.pointerEvents = "auto";
        it.bound = true;
      }
    }
  }

  const ticker = PIXI.Ticker.shared;
  let tickErrCount = 0;
  const tickFn = () => {
    try { render(); }
    catch (e) {
      tickErrCount++;
      if (tickErrCount <= 3) warn("Turn UI render threw", e);
      if (tickErrCount === 4) warn("Turn UI render: suppressing further errors");
      // After 60 errors (~1s of consistent failures), self-destruct so we
      // don't keep pumping errors to console every frame.
      if (tickErrCount > 60) {
        warn("Turn UI render: too many errors, aborting tick");
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
    }, { label: "turn-ui:updateToken" });
    director.hooks.on("canvasPan", render, { label: "turn-ui:canvasPan" });
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

  function flipPage(dir) {
    if (PAGES.length <= 1) return;
    pageIndex = (pageIndex + dir + PAGES.length) % PAGES.length;
    buildPage();
    render();
    playUiTabSwitchSfx();
  }
  leftA.addEventListener("click", (e) => { e.stopPropagation(); flipPage(-1); });
  rightA.addEventListener("click", (e) => { e.stopPropagation(); flipPage(+1); });

  const keyListener = (e) => {
    // Left/Right: switch tab (Actions ↔ System) with dedicated tab SFX
    if (e.key === "ArrowLeft")  { e.preventDefault(); flipPage(-1); return; }
    if (e.key === "ArrowRight") { e.preventDefault(); flipPage(+1); return; }
    // Up/Down: cycle through the current tab's commands
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (items.length) setKbFocus(kbIndex - 1);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (items.length) setKbFocus(kbIndex + 1);
      return;
    }
    // Z / Enter: activate the focused command
    if (e.key === "z" || e.key === "Z" || e.key === "Enter") {
      const it = items[kbIndex];
      if (!it || !isEnabledLabel(it.label)) return;
      e.preventDefault();
      if (it.label === "Cancel") {
        try { onPick?.(null); } catch (err) { warn("Turn UI kb: onPick(null) threw", err); }
        return;
      }
      if (NON_ACTION_COMMANDS.has(it.label)) {
        if (it.label === "Passive") {
          try { onPassive?.(); } catch (err) { warn("Turn UI kb: onPassive threw", err); }
        }
        return;
      }
      try { onPick?.(it.label); } catch (err) { warn("Turn UI kb: onPick threw", err); }
      return;
    }
  };
  window.addEventListener("keydown", keyListener, true);

  requestAnimationFrame(() => { budgetLabel.style.opacity = "1"; });

  function cleanup() {
    try { ticker.remove(tickFn); } catch {}
    try { window.removeEventListener("keydown", keyListener, true); } catch {}
    try { root.remove(); } catch {}
    // Director-owned hooks: HookRegistry's disposeAll cleans them up.
    // Player-side hooks: manual unbind via the cleanup list.
    for (const fn of manualHookCleanups) {
      try { fn(); } catch {}
    }
    log("Turn UI cleaned up for", token?.name);
  }

  return { cleanup, root };
}

// Public surface used by state handlers AND by the player-side
// MENU_OPEN handler. The shape of args determines who's driving:
//   - GM-acting-on-NPC: pass { director, token } → uses defaults
//     (onPick → director.dispatch; onPassive → PassiveManager.show).
//   - Player-on-PC:     pass { token, combatId, actorUuid, onPick }
//     where onPick emits DECLARE_COMMAND over IntentChannel.
export const TurnUI = {
  spawn({ director, token, combatId, actorUuid, onPick, onPassive, enabledLabels = null, budgetText = null }) {
    if (!token) {
      warn("Turn UI spawn: no token");
      return null;
    }
    const key = combatId ?? director?.combatId ?? "no-combat";

    // Despawn any prior instance keyed by this combatId.
    const prior = _instances.get(key);
    if (prior) { try { prior.cleanup(); } catch {} }

    // Default onPick: dispatch into the director. Requires `director`.
    const pickCb = onPick ?? ((command) => {
      if (!director) {
        warn("Turn UI: onPick called without director or callback override");
        return;
      }
      director.dispatch({
        type: INTENTS.DECLARE_COMMAND,
        body: { command },
      });
    });

    // Default onPassive: open the PassiveManager for the acting actor.
    // Reads actorUuid from (in order) explicit arg, director snapshot,
    // or director.dCombat.current.
    const passiveCb = onPassive ?? (async () => {
      try {
        const aUuid = actorUuid
          ?? director?.ctx?.turnSnapshot?.actorUuid
          ?? director?.dCombat?.current?.actorUuid
          ?? null;
        const actor = aUuid ? await fromUuid(aUuid) : null;
        if (!actor) { warn("Turn UI: Passive button — no active actor"); return; }
        PassiveManager.show({ actor });
      } catch (e) { warn("Turn UI: Passive button failed", e); }
    });

    const rec = spawnMenu({ director, token, combatId: key, onPick: pickCb, onPassive: passiveCb, enabledLabels, budgetText });
    _instances.set(key, rec);
    return rec;
  },

  despawn({ director, combatId } = {}) {
    const key = combatId ?? director?.combatId;
    if (!key) return;
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
};

// DEPRECATED — per-pick MENU_OPEN("turn-ui") handler from an earlier
// architecture iteration. Superseded by composeAction.js's
// registerPlayerComposeActionHandler — which runs the entire Octopath +
// per-command picker chain client-locally and only emits one
// ACTION_COMPOSED intent at the end. Kept as a reference; not imported.
// See [[director-player-driven-input]] §"Implementation log".
export function registerPlayerTurnUiHandler(channel) {
  const offOpen = channel.onMenuOpen(async (menuSpec) => {
    if (!menuSpec || menuSpec.kind !== "turn-ui") return;
    if (!menuSpec.tokenUuid) {
      warn("turn-ui MENU_OPEN: missing tokenUuid");
      return;
    }
    try {
      const tokenDoc = await fromUuid(menuSpec.tokenUuid);
      if (!tokenDoc) {
        warn(`turn-ui MENU_OPEN: tokenDoc not found ${menuSpec.tokenUuid}`);
        return;
      }
      // Make sure the player is viewing the battle scene so the canvas
      // anchor resolves. scene.view() switches the player's own viewport
      // without affecting other clients (unlike scene.activate(), which
      // is GM-only).
      const tokenScene = tokenDoc.parent;
      if (tokenScene && tokenScene.id !== canvas?.scene?.id) {
        log(`turn-ui MENU_OPEN: switching player view to ${tokenScene.name}`);
        try { await tokenScene.view(); } catch (e) { warn("scene.view threw", e); }
      }
      const token = tokenDoc.object ?? canvas?.tokens?.get(tokenDoc.id);
      if (!token) {
        warn(`turn-ui MENU_OPEN: token not on canvas ${menuSpec.tokenUuid}`);
        return;
      }
      TurnUI.spawn({
        director: null,
        token,
        combatId: menuSpec.combatId,
        actorUuid: menuSpec.actorUuid,
        onPick: (command) => {
          channel.emit({
            type: INTENTS.DECLARE_COMMAND,
            body: { command },
            combatId: menuSpec.combatId,
          });
        },
        // onPassive falls through to default (opens PassiveManager).
      });
    } catch (e) { warn("turn-ui MENU_OPEN handler threw", e); }
  });

  const offClose = channel.onMenuClose((payload) => {
    if (payload?.kind && payload.kind !== "turn-ui") return;
    // No reliable combatId in the payload at the moment — close all.
    // At most one Turn UI is open per client, so this is safe.
    try { TurnUI.despawnAll(); } catch {}
  });

  return () => { try { offOpen?.(); } catch {} try { offClose?.(); } catch {} };
}
