/**
 * Fabula Ledger — Cameo key (step 3)
 *
 * File: scripts/fabula-ledger/fl-cameo.js
 *
 * The GM voices a villain with no token and no Theatre portrait (chat-speaker
 * detection is off by design). Shift+V opens a small picker under the prompt
 * stack: the villains seen most recently first, a name filter, click (or Enter)
 * to pay the Cameo. The usual rules hold: once per visit, ≤3 per visit.
 * GM only.
 */
(() => {
  const TAG = "[FabulaLedger][Cameo]";
  const MODULE_ID = "fabula-ultima-companion";
  const ROOT_ID = "fl-cameo";
  const STYLE_ID = "fl-cameo-style";
  const MAX_ROWS = 8;
  const FL = globalThis.FabulaLedger = globalThis.FabulaLedger || {};
  const I = () => FL._internal;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
#${ROOT_ID} {
  position: fixed; z-index: 9001; right: var(--fu-sidebar-anchor-right, 313px); top: 60px; width: 260px;
  box-sizing: border-box; padding: 8px; color: #3a1e06;
  font: 13px/1.3 "Signika","Noto Sans","Segoe UI",sans-serif;
  background: linear-gradient(168deg, #f8f0d4 0%, #ede0b0 100%);
  border: 1px solid #c9a44a; border-radius: 10px;
  box-shadow: 0 0 0 2px #7a4e20, 0 0 0 4px #b8865a, 0 8px 18px rgba(0,0,0,0.45);
  opacity: 0; transform: translate(20px, -10px); transition: opacity 180ms ease-out, transform 240ms cubic-bezier(.2,.8,.25,1);
}
#${ROOT_ID}.in { opacity: 1; transform: none; }
#${ROOT_ID} .flc-h { font-size: 12px; color: #7a5a2e; margin: 0 2px 5px; }
#${ROOT_ID} input { width: 100%; box-sizing: border-box; height: 24px; font-size: 13px; color: #3a1e06; background: rgba(255,250,235,0.85); border: 1px solid #c9a44a; border-radius: 5px; padding: 0 6px; margin-bottom: 4px; }
#${ROOT_ID} .flc-r { display: flex; align-items: center; gap: 8px; padding: 2px 4px; border-radius: 6px; cursor: pointer; }
#${ROOT_ID} .flc-r.sel, #${ROOT_ID} .flc-r:hover { background: rgba(122,78,32,0.16); }
#${ROOT_ID} .flc-r img { width: 26px; height: 26px; object-fit: contain; object-position: bottom; image-rendering: pixelated; border: 0 !important; }
#${ROOT_ID} .flc-r small { color: #8a6a3a; margin-left: auto; }
#${ROOT_ID} .flc-none { color: #8a6a3a; font-style: italic; padding: 2px 4px; }`;
    document.head.appendChild(s);
  }

  // Recently seen first (the ledger log), then every other actor marked Villain.
  function candidates() {
    const st = I()?.readState?.() ?? { log: [] };
    const out = [], seen = new Set();
    const push = (a, hint) => {
      if (!a || seen.has(a.id) || FL.api.getStatus(a) === "never") return;
      seen.add(a.id); out.push({ a, hint });
    };
    for (const e of st.log ?? []) if (e.actorId) push(game.actors.get(e.actorId), "seen");
    for (const a of game.actors ?? []) if (FL.api.getStatus(a) === "villain") push(a, "villain");
    return out;
  }

  let _sel = 0;
  function rows(el, filter) {
    const q = filter.trim().toLowerCase();
    let list = candidates();
    if (q) {
      list = list.filter(c => c.a.name.toLowerCase().includes(q));
      // Any actor by name, so a villain never seen before can still cameo.
      if (!list.length) list = [...game.actors].filter(a => I()?.isNpc?.(a) && a.name.toLowerCase().includes(q)).map(a => ({ a, hint: "" }));
    }
    list = list.slice(0, MAX_ROWS);
    _sel = Math.min(_sel, Math.max(0, list.length - 1));
    el.querySelector(".flc-list").innerHTML = list.length ? list.map((c, i) => {
      const img = I()?.spriteOf?.(c.a) ?? "";
      return `<div class="flc-r ${i === _sel ? "sel" : ""}" data-id="${c.a.id}">${img ? `<img src="${esc(img)}" alt="">` : ""}<span>${esc(c.a.name)}</span><small>${c.hint}</small></div>`;
    }).join("") : `<div class="flc-none">No match.</div>`;
  }

  function close() {
    const el = document.getElementById(ROOT_ID);
    if (!el) return;
    el.classList.remove("in");
    setTimeout(() => el.remove(), 240);
  }

  async function pick(id) {
    close();
    const a = game.actors.get(id);
    if (!a) return;
    const res = await FL.api.cameo(a);
    const d = res?.decision;
    if (d && d.action !== "pay" && !res.forwarded) {
      const why = { "paid-this-visit": "already paid on this map", "visit-cap": "3 villains already paid on this map", "status-never": "marked Never" }[d.reason] ?? d.reason;
      ui.notifications.info(`Fabula Ledger: ${a.name}: ${why}.`);
    }
  }

  function open() {
    if (!game.user?.isGM) return;
    if (document.getElementById(ROOT_ID)) return close();
    ensureStyle();
    _sel = 0;
    const el = document.createElement("div");
    el.id = ROOT_ID;
    el.innerHTML = `<div class="flc-h">Cameo: who is speaking? (+1, once per map)</div><input type="text" placeholder="Name…"><div class="flc-list"></div>`;
    // Under the prompt stack, if one is showing.
    const prompts = document.getElementById("fl-gm-prompts")?.getBoundingClientRect?.();
    if (prompts && prompts.height > 0) el.style.top = `${Math.round(prompts.bottom + 10)}px`;
    document.body.appendChild(el);
    const input = el.querySelector("input");
    rows(el, "");
    input.addEventListener("input", () => { _sel = 0; rows(el, input.value); });
    input.addEventListener("keydown", (ev) => {
      const n = el.querySelectorAll(".flc-r").length;
      if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); close(); }
      else if (ev.key === "ArrowDown") { ev.preventDefault(); _sel = Math.min(n - 1, _sel + 1); rows(el, input.value); }
      else if (ev.key === "ArrowUp") { ev.preventDefault(); _sel = Math.max(0, _sel - 1); rows(el, input.value); }
      else if (ev.key === "Enter") { ev.preventDefault(); const r = el.querySelectorAll(".flc-r")[_sel]; if (r) pick(r.dataset.id); }
      ev.stopPropagation();   // typing a name must not fire Foundry keybindings
    });
    el.addEventListener("click", (ev) => { const r = ev.target.closest(".flc-r"); if (r) pick(r.dataset.id); });
    input.addEventListener("blur", () => setTimeout(() => { if (!el.matches(":hover")) close(); }, 150));
    requestAnimationFrame(() => { el.classList.add("in"); input.focus(); });
  }

  Hooks.once("init", () => {
    game.keybindings.register(MODULE_ID, "fabulaCameo", {
      name: "Fabula Ledger: villain cameo (+1)",
      hint: "A villain speaks or acts with no token on the map. Opens a picker.",
      editable: [{ key: "KeyV", modifiers: ["Shift"] }],
      restricted: true,
      onDown: () => { open(); return true; }
    });
  });

  FL.Cameo = { open, close };
  console.debug(TAG, "installed");
})();
