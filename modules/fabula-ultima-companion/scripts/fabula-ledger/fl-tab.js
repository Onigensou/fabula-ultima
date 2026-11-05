/**
 * Fabula Ledger — the player's bookmark tab
 *
 * File: scripts/fabula-ledger/fl-tab.js
 *
 * The user's design (2026-11-05): a small parchment/wood bookmark that slides
 * in from the LEFT edge near the bottom, shows the invoke counter's teal
 * fa-star and the current count, rolls the number up like an odometer (no
 * scaling), plays Fabula_Point.ogg ONCE per pass however many points land,
 * then eases out. No text. At the cap the number holds and the tab gets a gold
 * rim. Each player sees their own character's count; the GM sees no tab.
 *
 * Docking: it sits above whatever already occupies the bottom-left in the
 * current mode (Theatre bar, camp buttons, party HUD cards, player list).
 * Held: on the title and gacha screens the pass waits for the next scene.
 *
 *   onAward({ changes: [{ actorId, from, to, overflow }] })   from the ledger socket
 *   preview(from, to)                                         console test on any client
 */
(() => {
  const TAG = "[FabulaLedger][Tab]";
  const MODULE_ID = "fabula-ultima-companion";
  const ROOT_ID = "fl-fp-tab";
  const STYLE_ID = "fl-fp-tab-style";
  const SFX = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Fabula_Point.ogg";
  const SFX_VOLUME = 0.5;
  const SETTING_SHOW = "fabulaTab";
  const FP_COLOUR = "#14b8a6";      // the action card's invoke counter star

  const T = { slideIn: 320, firstStep: 700, step: 420, settle: 1000, hold: 1200, slideOut: 280, capHold: 1500 };
  // Exploration's round mode buttons (.oni-dp-mode-btn: travel / heal / ritual)
  // and the "Controller" badge above them sat over the tab: found in the demo
  // recording 2026-11-05.
  const DOCK_SELECTORS = ["#theatre-bar", "#oni-camp-phase-btn", "#oni-camp-start-btn", ".dhud-root .dhud-card", "#players", "#hotbar",
    ".oni-dp-mode-btn", "#oni-movement-control-badge-root"];
  const DOCK_ZONE_PX = 320;          // only things in the left part of the screen push the tab up
  const HELD_MODES = new Set(["title", "gacha"]);

  const FL = globalThis.FabulaLedger = globalThis.FabulaLedger || {};

  Hooks.once("init", () => {
    game.settings.register(MODULE_ID, SETTING_SHOW, {
      name: "Show the Fabula Point tab",
      hint: "A small tab at the bottom-left that counts up when your character gains Fabula Points.",
      scope: "client", config: true, type: Boolean, default: true
    });
  });
  const enabled = () => { try { return game.settings.get(MODULE_ID, SETTING_SHOW) !== false; } catch { return true; } };

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
#${ROOT_ID} {
  position: fixed; left: 0; bottom: 24px; z-index: 9000;
  display: flex; align-items: center; gap: 9px;
  padding: 7px 15px 7px 16px;
  font-family: "Signika","Noto Sans","Segoe UI",sans-serif;
  background:
    repeating-linear-gradient(0deg, transparent 0 11px, rgba(140,90,30,0.05) 11px 12px),
    linear-gradient(168deg, #f8f0d4 0%, #ede0b0 100%);
  border: 1px solid #c9a44a; border-left: 0; border-radius: 0 16px 16px 0;
  box-shadow: 0 0 0 2px #7a4e20, 0 0 0 4px #b8865a, 4px 5px 14px rgba(0,0,0,0.45);
  pointer-events: none; user-select: none;
  transform: translateX(-120%);
  transition: transform ${T.slideIn}ms cubic-bezier(.2,.8,.25,1);
}
#${ROOT_ID}.in { transform: translateX(0); }
#${ROOT_ID}.out { transition: transform ${T.slideOut}ms cubic-bezier(.5,0,.8,.4); }
#${ROOT_ID} .fl-ico { color: ${FP_COLOUR}; font-size: 20px; line-height: 1; display: flex; transition: filter 250ms; }
#${ROOT_ID}.lit .fl-ico { filter: drop-shadow(0 0 5px #2ee6cf); }
#${ROOT_ID} .fl-win { position: relative; height: 28px; min-width: 24px; overflow: hidden; }
#${ROOT_ID} .fl-d {
  position: absolute; left: 0; top: 0;
  font-size: 22px; line-height: 28px; font-weight: 600; color: #3a1e06; font-variant-numeric: tabular-nums;
  transition: transform 340ms cubic-bezier(.3,.7,.3,1), opacity 340ms, color 600ms;
}
#${ROOT_ID} .fl-d.new { transform: translateY(100%); opacity: 0; color: #0f7f73; }
#${ROOT_ID} .fl-d.new.down { transform: translateY(-100%); }
#${ROOT_ID} .fl-d.new.go { transform: translateY(0); opacity: 1; }
#${ROOT_ID} .fl-d.old.go { transform: translateY(-100%); opacity: 0; }
#${ROOT_ID} .fl-d.old.go.down { transform: translateY(100%); }
#${ROOT_ID} .fl-d.settle { color: #3a1e06; }
#${ROOT_ID}.full { box-shadow: 0 0 0 2px #7a4e20, 0 0 0 4px #c9a44a, 0 0 16px #ffd76a, 4px 5px 14px rgba(0,0,0,0.45); }
@media (prefers-reduced-motion: reduce) {
  #${ROOT_ID}, #${ROOT_ID} .fl-d { transition: none; }
}`;
    document.head.appendChild(s);
  }

  function el() {
    ensureStyle();
    let root = document.getElementById(ROOT_ID);
    if (!root) {
      root = document.createElement("div");
      root.id = ROOT_ID;
      root.setAttribute("aria-hidden", "true");
      root.innerHTML = `<span class="fl-ico"><i class="fa-solid fa-star"></i></span><span class="fl-win"></span>`;
      document.body.appendChild(root);
    }
    return root;
  }

  // Lift the tab above whatever sits bottom-left right now.
  function dock(root) {
    let bottom = 24;
    for (const sel of DOCK_SELECTORS) {
      for (const node of document.querySelectorAll(sel)) {
        const r = node.getBoundingClientRect?.();
        if (!r || r.width === 0 || r.height === 0 || r.left > DOCK_ZONE_PX) continue;
        const cs = getComputedStyle(node);
        if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) continue;
        bottom = Math.max(bottom, Math.round(window.innerHeight - r.top + 12));
      }
    }
    root.style.bottom = `${bottom}px`;
  }

  function sceneMode() {
    return String(canvas?.scene?.flags?.[MODULE_ID]?.oniFabula?.general?.sceneMode ?? "").trim().toLowerCase();
  }

  function sfx() {
    try {
      const AH = foundry.audio?.AudioHelper ?? globalThis.AudioHelper;
      AH?.play({ src: SFX, volume: SFX_VOLUME, autoplay: true, loop: false }, false);
    } catch { /* never load-bearing */ }
  }

  // ── one pass ───────────────────────────────────────────────────────────────
  const pass = { running: false, shown: 0, target: 0, timers: [], soundPlayed: false, holdTimer: null };
  let held = null;   // { from, to } waiting for a normal scene

  const later = (ms, fn) => { const t = setTimeout(fn, ms); pass.timers.push(t); return t; };
  function clearTimers() { pass.timers.forEach(clearTimeout); pass.timers = []; }

  function roll(root, value, down) {
    const win = root.querySelector(".fl-win");
    const old = win.querySelector(".fl-d:not(.old)");
    const nw = document.createElement("span");
    nw.className = `fl-d new${down ? " down" : ""}`;
    nw.textContent = String(value);
    win.appendChild(nw);
    if (old) { old.classList.add("old"); if (down) old.classList.add("down"); }
    void nw.offsetWidth;
    nw.classList.add("go");
    old?.classList.add("go");
    setTimeout(() => old?.remove(), 380);
    setTimeout(() => nw.classList.add("settle"), T.settle);
  }

  function step(root) {
    if (pass.shown === pass.target) return finish(root);
    if (!pass.soundPlayed) { sfx(); pass.soundPlayed = true; root.classList.add("lit"); }
    const down = pass.target < pass.shown;
    pass.shown += down ? -1 : 1;
    roll(root, pass.shown, down);
    later(T.step, () => step(root));
  }

  function finish(root) {
    pass.holdTimer = later(T.hold, () => {
      pass.holdTimer = null;
      root.classList.remove("lit");
      root.classList.add("out");
      root.classList.remove("in");
      later(T.slideOut + 40, () => {
        root.classList.remove("out", "full");
        pass.running = false;
        pass.soundPlayed = false;
      });
    });
  }

  function start(from, to, capped) {
    const root = el();
    clearTimers();
    pass.holdTimer = null;   // a stale one from the last pass would make a merge step at once
    pass.running = true;
    pass.soundPlayed = false;
    pass.shown = from;
    pass.target = to;
    root.querySelector(".fl-win").innerHTML = `<span class="fl-d">${from}</span>`;
    root.classList.remove("in", "out", "full", "lit");
    dock(root);
    void root.offsetWidth;
    root.classList.add("in");
    if (from === to && capped) {
      later(T.firstStep, () => { sfx(); pass.soundPlayed = true; root.classList.add("lit", "full"); });
      later(T.firstStep + T.capHold, () => finish(root));
      return;
    }
    later(T.firstStep, () => step(root));
  }

  /** Points arriving while a pass runs join it (one sound, one slide). */
  function push(from, to, capped) {
    if (!enabled()) return;
    if (HELD_MODES.has(sceneMode())) {
      held = held ? { from: held.from, to, capped } : { from, to, capped };
      return;
    }
    const root = document.getElementById(ROOT_ID);
    if (pass.running && root?.classList.contains("in")) {
      pass.target = to;
      if (capped) root.classList.add("full");
      if (pass.holdTimer) { clearTimeout(pass.holdTimer); pass.holdTimer = null; step(root); }
      return;
    }
    start(from, to, capped);
  }

  Hooks.on("canvasReady", () => {
    if (!held || HELD_MODES.has(sceneMode())) return;
    const h = held; held = null;
    setTimeout(() => push(h.from, h.to, h.capped), 600);
  });

  // ── which character is mine ────────────────────────────────────────────────
  function myChange(changes) {
    if (game.user?.isGM) return null;
    const list = (changes ?? []).filter(c => game.actors?.get(c.actorId)?.isOwner);
    if (!list.length) return null;
    const mine = game.user?.character?.id;
    return list.find(c => c.actorId === mine) ?? list[0];
  }

  function onAward(msg) {
    const c = myChange(msg?.changes);
    if (!c) return;
    const capped = (c.overflow ?? 0) > 0;
    if (c.from === c.to && !capped) return;
    push(c.from, c.to, capped);
  }

  FL.Tab = { onAward, preview: (from, to, capped = false) => push(Number(from) || 0, Number(to) || 0, capped) };
  console.debug(TAG, "installed");
})();
