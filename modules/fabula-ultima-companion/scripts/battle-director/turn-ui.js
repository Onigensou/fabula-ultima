// Director Turn UI — Octopath command-button menu, ported from
// scripts/turn-ui-manager.js into a director-namespaced version.
//
// Visual parity with the legacy turn UI is intentional ("replicate the UI of
// legacy system" per the prototype brief). To keep both systems coexistent
// without CSS or DOM collisions, this version:
//
//   - Uses the CSS prefix `fud-octopath` instead of `oni-octopath`.
//   - Spawns only on the GM client in v1 (player-side spawn is future work
//     via the IntentChannel).
//
// On a button click, this fires:
//   director.dispatch({ type: INTENTS.DECLARE_COMMAND, body: { command } })
//
// All other behavior (animation, pager, SFX, hooks for camera pan) is copied
// from the legacy verbatim — modified only to namespace state and not to
// listen for the legacy `oni:*` socket messages.

import { log, warn } from "./logger.js";
import { INTENTS } from "./intents.js";

const STYLE_ID = "fud-turnui-style";

const LEGACY_PAGES = [
  { name: "Actions", items: ["Attack", "Guard", "Skill", "Spell", "Item"] },
  // Party Swap (legacy "Switch") and Objective hidden until D.6/D.7 ship.
  { name: "System",  items: ["Equipment", "Study", "Hinder"] }
];

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
      /* Director uses a blue-tinted gold so it visually differs from the
         legacy oni-octopath gold. Same family, different hue. */
      --fud-gold-1:#a8c4d8;
      --fud-gold-2:#7a9bb6;
      --fud-stroke:#5a6a85;
      --fud-shadow:rgba(24,28,41,.55);
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
      color:#5a6a85;
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

// Spawn the menu for a director instance over a given token. Returns a
// `record` with cleanup() that the caller invokes to despawn.
function spawnMenu({ director, token }) {
  ensureBaseStyles();

  const PAGES = LEGACY_PAGES.map((p) => ({
    name: p.name,
    items: p.items.map((s) => ({ label: s })),
  }));
  let pageIndex = 0;

  const root = document.createElement("div");
  root.className = "fud-octopath";
  root.id = `fud-octopath-${director.combatId}`;

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

  const budgetLabel = document.createElement("div");
  budgetLabel.className = "budget-label";
  const budgetMain = document.createElement("span");
  budgetMain.textContent = "Turn Action";
  budgetLabel.append(budgetMain);
  root.appendChild(budgetLabel);

  document.body.appendChild(root);

  const DURATION_MS = 360, STAGGER_MS = 30, SPIN_DEG = 360, SCALE_MIN = 0.93;
  const EDGE_PAD_X = 12, EDGE_PAD_Y = 50, GAP_PX = 6;
  const LABEL_TO_ATTACK_GAP = 10, PAGER_TO_LABEL_GAP = 8;
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const easeOutQuint = (t) => 1 - Math.pow(1 - t, 5);
  const easeOutBack = (t, s = 0.90) => 1 + ((t = t - 1) * ((s + 1) * t + s) * t);

  const items = [];
  let startClock = performance.now();

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
      const opacity = Math.pow(p, 0.8);
      const scale = SCALE_MIN + (1 - SCALE_MIN) * easeOutQuint(p);
      it.wrap.style.left = `${x}px`;
      it.wrap.style.top = `${y}px`;
      it.wrap.style.transform = `translate(0,-50%) rotate(${angleDeg}deg) scale(${scale})`;
      it.btn.style.transform = `rotate(${-angleDeg}deg)`;
      it.btn.style.opacity = opacity.toFixed(3);
      if (!it.bound && p >= 1) {
        it.btn.addEventListener("click", async (ev) => {
          ev.stopPropagation();
          // Dispatch the declared command into the director.
          director.dispatch({
            type: INTENTS.DECLARE_COMMAND,
            body: { command: it.label },
          });
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

  const h1 = director.hooks.on("updateToken", (doc) => {
    if (doc?.id === token.document?.id) render();
  }, { label: "turn-ui:updateToken" });
  const h2 = director.hooks.on("canvasPan", render, { label: "turn-ui:canvasPan" });

  function flipPage(dir) {
    pageIndex = (pageIndex + dir + PAGES.length) % PAGES.length;
    buildPage();
    render();
  }
  leftA.addEventListener("click", (e) => { e.stopPropagation(); flipPage(-1); });
  rightA.addEventListener("click", (e) => { e.stopPropagation(); flipPage(+1); });

  const keyListener = (e) => {
    if (e.key === "ArrowLeft") flipPage(-1);
    if (e.key === "ArrowRight") flipPage(+1);
  };
  window.addEventListener("keydown", keyListener, true);

  requestAnimationFrame(() => { budgetLabel.style.opacity = "1"; });

  function cleanup() {
    try { ticker.remove(tickFn); } catch {}
    try { window.removeEventListener("keydown", keyListener, true); } catch {}
    try { root.remove(); } catch {}
    // Hooks are owned by HookRegistry; the director's disposeAll handles them.
    log("Turn UI cleaned up for", token?.name);
  }

  return { cleanup, root };
}

// Public surface used by state handlers.
export const TurnUI = {
  spawn({ director, token }) {
    if (!game.user?.isGM) {
      log("Turn UI spawn skipped — non-GM client (v1 is GM-only)");
      return null;
    }
    if (!token) {
      warn("Turn UI spawn: no token");
      return null;
    }
    // Despawn any prior instance for this director
    const prior = _instances.get(director.combatId);
    if (prior) { try { prior.cleanup(); } catch {} }
    const rec = spawnMenu({ director, token });
    _instances.set(director.combatId, rec);
    return rec;
  },

  despawn({ director }) {
    const rec = _instances.get(director.combatId);
    if (!rec) return;
    try { rec.cleanup(); } catch {}
    _instances.delete(director.combatId);
  },

  despawnAll() {
    for (const rec of _instances.values()) {
      try { rec.cleanup(); } catch {}
    }
    _instances.clear();
  },
};
