// scripts/inn-system/innRest-panel.js
// The innkeeper's offer: Rest / Short Rest / Leave, with the price.
// Same skin and behaviour as the teleporter's "Enter X?" box (tp-bootstrap.js
// showTpPrompt): ruled parchment, wood-ring border, dark-wood choices with a
// bright ring on the picked one, Signika lettering, slides left → right.
import { INN } from "./innOpen-const.js";

const STYLE_ID = "oni-inn-prompt-style";
const OUT_MS   = 280; // keep in step with #oni-inn-prompt.inn-leaving
let _open = null;     // { finish }

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
#oni-inn-prompt {
  position: fixed; left: 50%; top: 42%; z-index: 9995;
  box-sizing: border-box; min-width: 460px; max-width: min(820px, 90vw);
  padding: 30px 46px 44px;
  border: 2px solid #c9a44a; border-radius: 14px;
  background: linear-gradient(168deg, #f8f0d4 0%, #ede0b0 100%);
  box-shadow: 0 0 0 2px #7a4e20, 0 0 0 4px #b8865a, 0 0 28px rgba(0,0,0,0.40), inset 0 1px 0 rgba(255,245,200,0.70);
  font-family: "Signika","Noto Sans","Segoe UI",sans-serif; color: #3a1e06;
  user-select: none; pointer-events: auto; opacity: 0;
  transform: translate(calc(-50% - 32px), -50%);
  transition: opacity 360ms cubic-bezier(.25,.46,.45,.94), transform 360ms cubic-bezier(.25,.46,.45,.94);
}
#oni-inn-prompt::before {
  content: ''; position: absolute; inset: 0; pointer-events: none; border-radius: 12px;
  background: repeating-linear-gradient(0deg, transparent, transparent 23px, rgba(140,90,30,0.04) 23px, rgba(140,90,30,0.04) 24px);
}
#oni-inn-prompt.inn-visible { opacity: 1; transform: translate(-50%, -50%); }
#oni-inn-prompt.inn-leaving {
  opacity: 0; transform: translate(calc(-50% + 32px), -50%); pointer-events: none;
  transition: opacity 280ms cubic-bezier(.55,.085,.68,.53), transform 280ms cubic-bezier(.55,.085,.68,.53);
}
#oni-inn-prompt .oni-inn-msg {
  position: relative; margin: 0; text-align: center;
  font-size: 20px; font-weight: 400; line-height: 1.5; letter-spacing: .3px;
}
#oni-inn-prompt .oni-inn-msg strong { font-weight: 700; }
#oni-inn-prompt .oni-inn-note {
  position: relative; margin: 8px 0 0; text-align: center;
  font-size: 14px; line-height: 1.4; color: #6a4418;
}
#oni-inn-prompt .oni-inn-note.is-blocked { color: #8a2a10; }
#oni-inn-prompt .oni-inn-actions {
  position: absolute; right: 18px; bottom: -22px; display: flex; gap: 12px;
}
#oni-inn-prompt .oni-inn-choice {
  position: relative; box-sizing: border-box; min-width: 112px; height: 40px;
  margin: 0; padding: 0 22px;
  border: 1px solid #9b7040; border-radius: 8px;
  background: linear-gradient(180deg, #7a5230 0%, #5c3818 100%);
  color: #f4e8c0; font-family: inherit; font-size: 16px; font-weight: 400;
  line-height: 1; letter-spacing: .8px; white-space: nowrap; cursor: pointer;
  box-shadow: 0 2px 6px rgba(40,18,4,0.38), inset 0 1px 0 rgba(255,225,140,0.14);
  transition: border-color .12s, color .12s, background .12s, box-shadow .12s;
}
#oni-inn-prompt .oni-inn-choice:focus { outline: none; }
#oni-inn-prompt .oni-inn-choice:disabled { opacity: .45; cursor: not-allowed; }
#oni-inn-prompt .oni-inn-choice.is-picked {
  border-color: #f4d488; color: #fff8e0;
  background: linear-gradient(180deg, #9b6840 0%, #7a4a22 100%);
  box-shadow: 0 0 0 2px #f4d488, 0 0 18px rgba(244,212,136,0.55), 0 2px 6px rgba(40,18,4,0.38), inset 0 1px 0 rgba(255,225,140,0.22);
}
#oni-inn-prompt .oni-inn-choice.leave.is-picked {
  border-color: #f0a488; color: #ffd0c0;
  background: linear-gradient(180deg, #7a2e18 0%, #5a1c08 100%);
  box-shadow: 0 0 0 2px #f0a488, 0 0 18px rgba(230,110,80,0.50), 0 2px 6px rgba(40,18,4,0.38);
}`;
  document.head.appendChild(s);
}

export function closeInnPrompt() { _open?.finish(null); }

/**
 * @param {object} o
 * @param {string} o.innName   innkeeper's name
 * @param {object} o.plan      planCharge() result
 * @param {boolean} o.hasRoom  the lobby links a camp scene (else Rest is off)
 * @returns {Promise<"rest"|"short"|null>}
 */
export function showInnPrompt({ innName, plan, hasRoom }) {
  closeInnPrompt();
  ensureStyle();

  return new Promise((resolve) => {
    const el = document.createElement("div");
    el.id = "oni-inn-prompt";
    el.setAttribute("role", "dialog");
    el.innerHTML = `
      <p class="oni-inn-msg"></p>
      <p class="oni-inn-note"></p>
      <div class="oni-inn-actions">
        <button type="button" class="oni-inn-choice rest">Rest</button>
        <button type="button" class="oni-inn-choice short">Short Rest</button>
        <button type="button" class="oni-inn-choice leave">Leave</button>
      </div>`;

    const msg = el.querySelector(".oni-inn-msg");
    const strong = document.createElement("strong");
    strong.textContent = `${plan.total}z`;
    msg.append(`${innName}: "A night's stay for the party is `, strong, `."`);

    const note = el.querySelector(".oni-inn-note");
    if (!plan.ok) {
      note.textContent = plan.reason;
      note.classList.add("is-blocked");
    } else if (plan.covered.length) {
      note.textContent = `The party coffer covers ${plan.covered.map(a => a.name).join(", ")} (${plan.cofferNeed}z).`;
    } else {
      note.textContent = `${plan.price}z each.`;
    }
    if (plan.ok && !hasRoom) note.textContent += " (No rooms are set up here — Short Rest only.)";

    const btns = {
      rest:  el.querySelector(".rest"),
      short: el.querySelector(".short"),
      leave: el.querySelector(".leave"),
    };
    btns.rest.disabled  = !plan.ok || !hasRoom;
    btns.short.disabled = !plan.ok;
    btns.rest.title  = "Take a room: the full camp — activities, bonding, sleep.";
    btns.short.title = "Restore HP and MP and cure ailments here.";
    const order = [btns.rest, btns.short, btns.leave].filter(b => !b.disabled);

    let picked = null;
    const pick = (btn) => {
      if (!btn || btn.disabled || picked === btn) return;
      picked?.classList.remove("is-picked");
      picked = btn;
      btn.classList.add("is-picked");
    };
    const step = (d) => pick(order[(order.indexOf(picked) + d + order.length) % order.length]);
    const answerOf = (btn) => btn === btns.rest ? "rest" : btn === btns.short ? "short" : null;

    const entry = { finish: null };
    const onKey = (ev) => {
      if (ev.target?.closest?.("input, textarea, select, [contenteditable='true']")) return;
      let handled = true;
      if (ev.key === "Escape")                                       entry.finish(null);
      else if (ev.key === "Enter" || ev.key === " ")                 entry.finish(answerOf(picked));
      else if (ev.key === "ArrowLeft"  || ev.key === "a" || ev.key === "A") step(-1);
      else if (ev.key === "ArrowRight" || ev.key === "d" || ev.key === "D") step(1);
      else handled = false;
      if (handled) { ev.preventDefault(); ev.stopPropagation(); }
    };
    const runtime = globalThis.FUCompanion?.api?.MovementControlCameraRuntime ?? null;
    runtime?.lockMovement?.("inn-prompt");
    const A = window.oni?.Input?.ACTIONS ?? {};
    const stopInput = window.oni?.Input?.listen?.(({ action }) => {
      if (action === A.CONFIRM) entry.finish(answerOf(picked));
      else if (action === A.CANCEL) entry.finish(null);
      else if (action !== A.UP && action !== A.DOWN) return false;
      return true;
    }) ?? null;

    entry.finish = (result) => {
      if (_open !== entry) return;
      _open = null;
      stopInput?.();
      runtime?.unlockMovement?.("inn-prompt");
      window.removeEventListener("keydown", onKey, true);
      el.classList.remove("inn-visible");
      el.classList.add("inn-leaving");
      setTimeout(() => el.remove(), OUT_MS + 40);
      resolve(result ?? null);
    };

    el.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    for (const b of Object.values(btns)) {
      b.addEventListener("pointerenter", () => pick(b));
      b.addEventListener("click", () => { if (!b.disabled) entry.finish(answerOf(b)); });
    }
    window.addEventListener("keydown", onKey, true);

    pick(order[0]);
    document.body.appendChild(el);
    _open = entry;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (_open === entry) el.classList.add("inn-visible");
    }));
    console.debug(INN.TAG, "Inn prompt open.", { total: plan.total, ok: plan.ok, hasRoom });
  });
}
