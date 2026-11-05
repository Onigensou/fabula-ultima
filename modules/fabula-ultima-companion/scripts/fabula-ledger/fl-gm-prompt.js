/**
 * Fabula Ledger — GM prompt ("Award Fabula Point?")
 *
 * File: scripts/fabula-ledger/fl-gm-prompt.js
 *
 * The user's layout (2026-11-05): a lean horizontal parchment panel, the
 * villain's sprite standing over its left edge, "Award Fabula Point?" with a
 * small grey name · reason, and one row of buttons. Anchored top-right (below
 * the clock stack, beside the sidebar), slides in from the top-right with a
 * fade, stacks downward, never blocks, waits until answered.
 *
 *   show({ kind, name, img, reason, buttons }) -> Promise<"confirm"|"skip"|"hidden"|"never">
 *   paidNote(entry)   a short "Paid +1 · Name  [Undo]" panel after an automatic villain award
 *
 * GM only; the ledger calls it on the primary GM.
 */
(() => {
  const TAG = "[FabulaLedger][Prompt]";
  const ROOT_ID = "fl-gm-prompts";
  const STYLE_ID = "fl-gm-prompt-style";
  const CURSOR_SFX = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/UI/BattleCursor_4.wav";
  const PANEL_WIDTH = 380;     // one width for every prompt, so stacked sprites line up
  const IN_MS = 320, OUT_MS = 220;
  const NOTE_MS = 6000;
  const SPRITE_OVERHANG = 36;  // how far the 92px sprite rises above a ~60px panel

  const LABEL = { confirm: "Confirm", skip: "Skip", hidden: "Hidden", never: "Never" };
  const TIP = {
    confirm: "Pay +1 to the party. On a first sighting this also marks them as a villain.",
    skip: "No point this time.",
    hidden: "A villain who hasn't shown their hand: no point, and no more asking until you Reveal them.",
    never: "Not a villain: never asked or paid again."
  };

  const FL = globalThis.FabulaLedger = globalThis.FabulaLedger || {};
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
#${ROOT_ID} {
  position: fixed; z-index: 9000;
  right: var(--fu-sidebar-anchor-right, 313px);
  top: 12px; width: ${PANEL_WIDTH}px;
  display: flex; flex-direction: column; align-items: stretch; gap: ${SPRITE_OVERHANG}px;
  pointer-events: none;
}
#${ROOT_ID} .flp {
  position: relative; box-sizing: border-box;
  display: grid; gap: 6px;
  padding: 8px 12px 9px 84px;
  color: #3a1e06; font-family: "Signika","Noto Sans","Segoe UI",sans-serif;
  background:
    repeating-linear-gradient(0deg, transparent 0 11px, rgba(140,90,30,0.05) 11px 12px),
    linear-gradient(168deg, #f8f0d4 0%, #ede0b0 100%);
  border: 1px solid #c9a44a; border-radius: 10px;
  box-shadow: 0 0 0 2px #7a4e20, 0 0 0 4px #b8865a, 0 8px 18px rgba(0,0,0,0.45);
  pointer-events: auto; user-select: none;
  opacity: 0; transform: translate(28px, -18px);
}
#${ROOT_ID} .flp.in  { opacity: 1; transform: none; transition: opacity ${IN_MS - 60}ms ease-out, transform ${IN_MS}ms cubic-bezier(.2,.8,.25,1); }
#${ROOT_ID} .flp.out { opacity: 0; transform: translate(28px, -18px); transition: opacity ${OUT_MS - 20}ms ease-in, transform ${OUT_MS}ms ease-in; }
#${ROOT_ID} .flp-spr {
  position: absolute; left: 6px; bottom: 3px;
  height: 92px; width: 72px; object-fit: contain; object-position: bottom center;
  image-rendering: pixelated; filter: drop-shadow(0 3px 3px rgba(0,0,0,0.45));
  pointer-events: none;
  /* Foundry core puts a border on every img. */
  border: 0 !important; outline: 0; background: transparent; box-shadow: none; border-radius: 0;
}
#${ROOT_ID} .flp-q { font-size: 16px; line-height: 1.2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#${ROOT_ID} .flp-q small { font-size: 12px; color: #7a5a2e; margin-left: 6px; }
#${ROOT_ID} .flp-b { display: flex; gap: 5px; flex-wrap: wrap; }
#${ROOT_ID} .flp-b button {
  all: unset; box-sizing: border-box; cursor: pointer;
  padding: 3px 12px; border-radius: 6px; font-size: 13px; line-height: 18px;
  color: #f6ead0; background: linear-gradient(180deg, #7a5230, #5c3818);
  box-shadow: inset 0 1px 0 rgba(255,235,190,0.18);
}
#${ROOT_ID} .flp-b button:hover, #${ROOT_ID} .flp-b button:focus-visible {
  box-shadow: 0 0 0 2px #c9a44a, 0 0 8px rgba(255,215,106,0.55);
}
#${ROOT_ID} .flp-b button.ok { box-shadow: 0 0 0 2px #c9a44a, 0 0 8px rgba(255,215,106,0.45); }
#${ROOT_ID} .flp.note { padding-top: 7px; padding-bottom: 7px; }
@media (prefers-reduced-motion: reduce) {
  #${ROOT_ID} .flp, #${ROOT_ID} .flp.in, #${ROOT_ID} .flp.out { transition: none; transform: none; }
}`;
    document.head.appendChild(s);
  }

  function root() {
    ensureStyle();
    let el = document.getElementById(ROOT_ID);
    if (!el) { el = document.createElement("div"); el.id = ROOT_ID; document.body.appendChild(el); }
    // Sit below the clock stack when it is showing.
    const clocks = document.getElementById("oni-clock-layer");
    const r = clocks?.getBoundingClientRect?.();
    // +SPRITE_OVERHANG: the sprite stands above the panel's top edge.
    el.style.top = `${(r && r.height > 0 ? Math.round(r.bottom + 6) : 6) + SPRITE_OVERHANG}px`;
    return el;
  }

  function cue() {
    try {
      const AH = foundry.audio?.AudioHelper ?? globalThis.AudioHelper;
      AH?.play({ src: CURSOR_SFX, volume: 0.35, autoplay: true, loop: false }, false);
    } catch { /* never load-bearing */ }
  }

  function mount(html) {
    const host = root();
    const panel = document.createElement("div");
    panel.className = "flp";
    panel.innerHTML = html;
    // A sprite that fails to load should not leave a broken-image box.
    panel.querySelector(".flp-spr")?.addEventListener("error", (e) => { e.currentTarget.style.visibility = "hidden"; });
    host.appendChild(panel);
    requestAnimationFrame(() => requestAnimationFrame(() => panel.classList.add("in")));
    return panel;
  }

  function dismiss(panel) {
    if (!panel || panel.classList.contains("out")) return;
    panel.classList.remove("in");
    panel.classList.add("out");
    setTimeout(() => panel.remove(), OUT_MS + 40);
  }

  function show({ kind = "first", name = "", img = "", reason = "", buttons = ["confirm", "skip"] } = {}) {
    if (!game.user?.isGM) return Promise.resolve("skip");
    return new Promise((resolve) => {
      const btns = buttons.map((b, i) =>
        `<button type="button" data-a="${b}" class="${i === 0 ? "ok" : ""}" title="${esc(TIP[b] ?? "")}">${LABEL[b] ?? b}</button>`).join("");
      const panel = mount(`
        ${img ? `<img class="flp-spr" src="${esc(img)}" alt="">` : ""}
        <div class="flp-q">Award Fabula Point? <small>${esc(name)}${reason ? ` · ${esc(reason)}` : ""}</small></div>
        <div class="flp-b">${btns}</div>`);
      panel.dataset.kind = kind;
      panel.addEventListener("click", (ev) => {
        const a = ev.target?.closest?.("button[data-a]")?.dataset?.a;
        if (!a) return;
        dismiss(panel);
        resolve(a);
      });
      cue();
    });
  }

  // After an automatic villain award: a short note with Undo, so a wrong
  // payment is one click to reverse. Plain awards (event Change Fabula Points)
  // get no note: the author wrote them on purpose.
  function paidNote(entry) {
    if (!game.user?.isGM) return;
    if (!["villain", "escalation", "boss"].includes(entry?.reason)) return;
    const actor = game.actors?.get(entry.villainIds?.[0] ?? entry.bossId) ?? game.actors?.getName?.(entry.label);
    const img = actor ? (FL._internal?.spriteOf?.(actor) ?? "") : "";
    const what = { escalation: "escalated", boss: "boss fight" }[entry.reason] ?? "paid";
    const panel = mount(`
      ${img ? `<img class="flp-spr" src="${esc(img)}" alt="">` : ""}
      <div class="flp-q">Fabula Point +1 <small>${esc(entry.label)} · ${what}</small></div>
      <div class="flp-b"><button type="button" data-a="undo" title="Take the point back from everyone">Undo</button></div>`);
    panel.classList.add("note");
    const timer = setTimeout(() => dismiss(panel), NOTE_MS);
    panel.addEventListener("click", async (ev) => {
      if (!ev.target?.closest?.("button[data-a=undo]")) return;
      clearTimeout(timer);
      dismiss(panel);
      const r = await FL.api?.undo?.(entry.id);
      if (!r?.ok) ui.notifications?.warn?.("Fabula Ledger: nothing to undo.");
    });
  }

  FL.Prompt = { show, paidNote, _dismissAll: () => document.querySelectorAll(`#${ROOT_ID} .flp`).forEach(dismiss) };
  console.debug(TAG, "installed");
})();
