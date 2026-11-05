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
 *   show({ kind, name, img, reason, buttons, seconds }) -> Promise<"confirm"|"skip"|"hidden"|"never"|"timeout">
 *     "timeout" = nobody answered in time (setting fabulaPromptSeconds, default 15 s); callers treat it as Skip.
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
  // Unanswered prompts must not pile up on the GM's screen (user, 2026-11-05):
  // each one counts down and answers itself with "timeout" (= Skip). The
  // countdown pauses while the mouse is over the prompt.
  const SETTING_SECONDS = "fabulaPromptSeconds";
  const DEFAULT_SECONDS = 15;
  const promptSeconds = () => {
    try { return Math.max(5, Math.min(60, Number(game.settings.get("fabula-ultima-companion", SETTING_SECONDS)) || DEFAULT_SECONDS)); }
    catch { return DEFAULT_SECONDS; }
  };
  Hooks.once("init", () => {
    game.settings.register("fabula-ultima-companion", SETTING_SECONDS, {
      name: "Fabula Points: GM prompt time limit (seconds)",
      hint: "An unanswered \"Award Fabula Point?\" prompt closes itself after this long and counts as Skip. Paused while the mouse is over it.",
      scope: "world", config: true, type: Number, range: { min: 5, max: 60, step: 1 }, default: DEFAULT_SECONDS
    });
  });

  const LABEL = { confirm: "Confirm", skip: "Skip", hidden: "Hidden", never: "Never", "new": "New session", same: "Same session" };
  const TIP = {
    confirm: "Pay +1 to the party. On a first sighting this also marks them as a villain.",
    skip: "No point this time.",
    hidden: "A villain who hasn't shown their hand: no point, and no more asking until you Reveal them.",
    never: "Not a villain: never asked or paid again.",
    "new": "Start a new session: start-of-session effects run, anyone on 0 Fabula Points gets 1.",
    same: "Carry on the last session (it was only interrupted)."
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
  padding: 8px 12px 13px 84px;   /* bottom room for the countdown bar */
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
#${ROOT_ID} .flp.noimg { padding-left: 14px; }
#${ROOT_ID} .flp-b .flp-s {
  margin-left: auto; align-self: center; font-size: 11.5px; color: #8a6a3a;
  font-variant-numeric: tabular-nums; min-width: 2.6em; text-align: right;
}
#${ROOT_ID} .flp-t {
  position: absolute; left: 84px; right: 12px; bottom: 4px; height: 3px;
  border-radius: 2px; background: rgba(122,78,32,0.18); overflow: hidden; pointer-events: none;
}
#${ROOT_ID} .flp.noimg .flp-t { left: 14px; }
#${ROOT_ID} .flp-t i {
  display: block; height: 100%; width: 100%; transform-origin: left center;
  background: linear-gradient(90deg, #b8865a, #c9a44a);
}
#${ROOT_ID} .flp-t.low i { background: linear-gradient(90deg, #a24a2a, #c9663a); }
#${ROOT_ID} .flp.paused .flp-t i { opacity: 0.55; }
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
    if (!panel.querySelector(".flp-spr")) panel.classList.add("noimg");
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

  function show({ kind = "first", title = "Award Fabula Point?", name = "", img = "", reason = "", buttons = ["confirm", "skip"], seconds = 0 } = {}) {
    if (!game.user?.isGM) return Promise.resolve("skip");
    return new Promise((resolve) => {
      const btns = buttons.map((b, i) =>
        `<button type="button" data-a="${b}" class="${i === 0 ? "ok" : ""}" title="${esc(TIP[b] ?? "")}">${LABEL[b] ?? b}</button>`).join("");
      const total = (Number(seconds) > 0 ? Number(seconds) : promptSeconds()) * 1000;
      const panel = mount(`
        ${img ? `<img class="flp-spr" src="${esc(img)}" alt="">` : ""}
        <div class="flp-q">${esc(title)} <small>${esc(name)}${reason ? ` · ${esc(reason)}` : ""}</small></div>
        <div class="flp-b">${btns}<span class="flp-s" title="Closes as Skip when it runs out. Paused while your mouse is here."></span></div>
        <div class="flp-t"><i></i></div>`);
      panel.dataset.kind = kind;

      // Countdown: a draining bar + seconds left; paused on hover.
      const bar = panel.querySelector(".flp-t"), fill = bar.firstElementChild, secs = panel.querySelector(".flp-s");
      let left = total, last = performance.now(), hover = false, done = false, raf = 0;
      const finish = (answer) => {
        if (done) return;
        done = true;
        cancelAnimationFrame(raf);
        dismiss(panel);
        resolve(answer);
      };
      const tick = (now) => {
        if (done) return;
        if (!hover) left -= now - last;
        last = now;
        if (left <= 0) return finish("timeout");
        fill.style.transform = `scaleX(${(left / total).toFixed(4)})`;
        secs.textContent = `${Math.ceil(left / 1000)}s`;
        bar.classList.toggle("low", left <= 4000);
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      panel.addEventListener("mouseenter", () => { hover = true; panel.classList.add("paused"); });
      panel.addEventListener("mouseleave", () => { hover = false; panel.classList.remove("paused"); });

      panel.addEventListener("click", (ev) => {
        const a = ev.target?.closest?.("button[data-a]")?.dataset?.a;
        if (a) finish(a);
      });
      cue();
    });
  }

  // After an automatic villain award: a short note with Undo, so a wrong
  // payment is one click to reverse. Plain awards (event Change Fabula Points)
  // get no note: the author wrote them on purpose.
  function paidNote(entry) {
    if (!game.user?.isGM) return;
    if (!["villain", "escalation", "boss", "session", "fumble", "surrender"].includes(entry?.reason)) return;
    // Session start pays party members, so their sprite stands on the note.
    const actor = game.actors?.get(entry.villainIds?.[0] ?? entry.bossId ?? entry.changes?.[0]?.actorId) ?? game.actors?.getName?.(entry.label);
    const img = actor ? (FL._internal?.spriteOf?.(actor) ?? "") : "";
    const what = { escalation: "escalated", boss: "boss fight", session: "session start", fumble: "fumble", surrender: "surrender" }[entry.reason] ?? "paid";
    // What actually landed (the cap can eat some or all of it), not what was asked.
    const gained = Math.max(0, ...(entry.changes ?? []).map(c => (c.after ?? 0) - (c.before ?? 0)));
    const panel = mount(`
      ${img ? `<img class="flp-spr" src="${esc(img)}" alt="">` : ""}
      <div class="flp-q">Fabula Point +${gained}${gained < (Number(entry.delta) || 1) ? " (cap)" : ""} <small>${esc(entry.label)} · ${what}</small></div>
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
