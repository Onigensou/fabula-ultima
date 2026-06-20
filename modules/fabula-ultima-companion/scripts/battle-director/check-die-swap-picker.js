// Check-Die-Swap Picker — director-native pre-roll overlay.
//
// The `ask`-mode surface for `check_die_swap` skills (Psychokinesis et al.): when
// a swap-granting skill is set to reaction_passive_mode "ask", the player chooses
// — pre-roll — whether to replace one Accuracy-Check Attribute die with another,
// and which. GENERAL by design: it renders whatever swap targets the actor's kit
// offers (one or several skills, one or several target attributes), not a
// hard-coded WLP. BOTH dice are always shown, each with a dropdown listing
// "Default" plus every available swap (up OR down, with the die-size change and
// the granting skill named).
//
// Lifecycle mirrors AttributePairPicker: Map<combatId, record>, despawned by
// boot.stop() / Stopped. Always GM-side in v1.
//
// Returns Promise<{ cancelled, swaps }> where swaps = [{ slot:"A1"|"A2", from, to }]
// (each die may be swapped independently — multiple swap skills can each swap a
// die; an empty array = the player kept the original roll).

import { log, warn } from "./logger.js";

const CSS_ID  = "fud-die-swap-picker-style";
const ROOT_ID = "fud-die-swap-picker-root";

const _overlays = new Map();

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

// Compact "(d10 ▲ +4)" / "(d6 ▼ −2)" / "(d10 =)" change tag for a swap option.
function changeText(dTo, gain) {
  if (gain > 0) return `d${dTo} ▲ +${gain}`;
  if (gain < 0) return `d${dTo} ▼ −${Math.abs(gain)}`;
  return `d${dTo} =`;
}

function ensureStyles() {
  if (document.getElementById(CSS_ID)) return;
  const css = document.createElement("style");
  css.id = CSS_ID;
  // Card + button styling mirror the Attribute-Pair Picker (fud-app-card /
  // fud-app-btn) so the menus look uniform; the die-rows are bespoke.
  css.textContent = `
    #${ROOT_ID} {
      position: fixed; top: 50%; left: 50%;
      transform: translate(-50%, -50%) scale(0.92); opacity: 0;
      z-index: 96; pointer-events: none;
      transition: transform 200ms cubic-bezier(.2,.7,.2,1), opacity 200ms ease-out;
    }
    #${ROOT_ID}.is-visible { transform: translate(-50%, -50%) scale(1); opacity: 1; }
    #${ROOT_ID}.is-resolving { transform: translate(-50%, -50%) scale(0.96); opacity: 0; transition: transform 180ms ease-out, opacity 180ms ease-out; }
    #${ROOT_ID} .fud-app-card {
      pointer-events: auto; width: 480px; max-width: 94vw; padding: 12px 16px 12px;
      border: 2px solid var(--fud-stroke, #7a6a55); border-radius: 14px;
      background: linear-gradient(180deg, var(--fud-parchment-top, #f6f1e6), var(--fud-parchment-bot, #ebe3d0));
      box-shadow: 0 16px 48px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.5) inset;
      color: var(--fud-ink, #3a3228); font-family: "Inter","Signika","Segoe UI",system-ui,sans-serif; letter-spacing: 0.2px;
    }
    #${ROOT_ID} .fud-ds-tag { display:inline-block; font-size:9.5px; font-weight:900; letter-spacing:0.5px; color:var(--fud-stroke,#7a6a55); padding:2px 8px; border:1px solid var(--fud-stroke,#7a6a55); border-radius:6px; background:rgba(255,255,255,0.45); margin-bottom:4px; }
    #${ROOT_ID} .fud-app-title { font-size:14px; font-weight:900; letter-spacing:0.32px; text-transform:uppercase; text-align:center; padding-bottom:7px; border-bottom:2px solid var(--fud-stroke,#7a6a55); margin-bottom:8px; }
    #${ROOT_ID} .fud-ds-hint { font-size:11px; text-align:center; opacity:0.85; margin-bottom:10px; }
    #${ROOT_ID} .fud-ds-rows { display:flex; flex-direction:column; gap:8px; margin-bottom:10px; }
    #${ROOT_ID} .fud-ds-row { display:grid; grid-template-columns:120px 1fr; align-items:center; gap:10px; }
    #${ROOT_ID} .fud-ds-die-label { font-size:13px; font-weight:900; }
    #${ROOT_ID} .fud-ds-die-label span { opacity:0.65; font-weight:700; margin-left:4px; }
    #${ROOT_ID} .fud-ds-select { width:100%; padding:6px 8px; font-size:12px; font-weight:700; color:var(--fud-ink,#3a3228); border:1px solid var(--fud-stroke,#7a6a55); border-radius:8px; background:rgba(255,255,255,0.7); cursor:pointer; }
    #${ROOT_ID} .fud-app-btn-row { display:flex; gap:8px; margin-top:4px; }
    #${ROOT_ID} .fud-app-btn {
      flex:1; padding:8px 10px; border-radius:8px; border:2px solid var(--fud-stroke,#7a6a55);
      font-weight:800; letter-spacing:0.32px; text-transform:uppercase; font-size:11.5px;
      cursor:pointer; user-select:none; text-align:center;
      box-shadow:0 3px 0 var(--fud-shadow, rgba(24,28,41,0.55)), 0 0 0 1px rgba(255,255,255,0.5) inset;
      transition:transform 100ms ease, filter 100ms ease;
    }
    #${ROOT_ID} .fud-app-btn.confirm { background:linear-gradient(180deg, var(--fud-gold-1,#d5b67a), var(--fud-gold-2,#b7935a)); color:#221b14; }
    #${ROOT_ID} .fud-app-btn.cancel { background:linear-gradient(180deg,#e5d6c5,#c9b294); color:var(--fud-ink,#3a3228); }
    #${ROOT_ID} .fud-app-btn:hover { filter:brightness(1.05); transform:translateY(-1px); }
  `;
  document.head.appendChild(css);
}

// slots: [{ slot:"A1"|"A2", attr, die, options:[{to, dTo, gain, source}] }]
// (BOTH dice are passed; a die with no options still renders, dropdown = Default only.)
// budget: { [target]: maxUses } — one charge per swap skill; a target can be picked
// on at most `budget[target]` dice, so a single skill never swaps both dice.
export async function pickDieSwap({ director, label = "Die Swap", A1, A2, dA, dB, slots = [], budget = {} } = {}) {
  ensureStyles();
  const combatId = director?.combatId ?? "default";
  const prior = _overlays.get(combatId);
  if (prior) { try { prior.cleanup(); } catch {} _overlays.delete(combatId); }

  const slotRow = (s) => {
    const opts = [`<option value="">Default (${escapeHtml(s.attr)} d${s.die})</option>`]
      .concat((s.options ?? []).map((o) =>
        `<option value="${escapeHtml(o.to)}">${escapeHtml(o.source || "Swap")}: ${escapeHtml(o.to)} ${changeText(o.dTo, o.gain)}</option>`
      ));
    return `
      <div class="fud-ds-row">
        <div class="fud-ds-die-label">${escapeHtml(s.attr)}<span>d${s.die}</span></div>
        <select class="fud-ds-select" data-fud-ds-slot="${s.slot}" ${(s.options ?? []).length ? "" : "disabled"}>
          ${opts.join("")}
        </select>
      </div>`;
  };

  const root = document.createElement("div");
  root.id = ROOT_ID;
  root.innerHTML = `
    <div class="fud-app-card" role="dialog" aria-label="Die Swap">
      <div class="fud-ds-tag">${escapeHtml(label)}</div>
      <div class="fud-app-title">Replace a die?</div>
      <div class="fud-ds-hint">${escapeHtml(A1)} d${dA} + ${escapeHtml(A2)} d${dB} — swap either die, both, or keep your roll.</div>
      <div class="fud-ds-rows">${slots.map(slotRow).join("")}</div>
      <div class="fud-app-btn-row">
        <div class="fud-app-btn cancel" data-fud-ds-action="cancel" role="button" tabindex="0">Cancel</div>
        <div class="fud-app-btn confirm" data-fud-ds-action="confirm" role="button" tabindex="0">Confirm</div>
      </div>
    </div>
  `;
  document.body.appendChild(root);
  requestAnimationFrame(() => root.classList.add("is-visible"));
  log("DieSwapPicker spawned", label);

  return new Promise((resolve) => {
    let resolved = false;
    let despawnTid = null;
    let keyListener = null;
    const selects = [...root.querySelectorAll(".fud-ds-select")];

    const finish = (swaps) => {
      if (resolved) return;
      resolved = true;
      root.classList.remove("is-visible");
      root.classList.add("is-resolving");
      despawnTid = setTimeout(() => { try { root.remove(); } catch {} _overlays.delete(combatId); }, 200);
      if (keyListener) { try { window.removeEventListener("keydown", keyListener, true); } catch {} keyListener = null; }
      resolve({ cancelled: false, swaps: swaps ?? [] });
    };

    // Read EVERY non-default selection — each die can be swapped independently
    // (multiple swap skills each grant a die swap).
    const readSelection = () => {
      const picks = [];
      for (const sel of selects) {
        const to = sel.value;
        if (!to) continue;
        const slot = sel.dataset.fudDsSlot;
        const s = slots.find((x) => x.slot === slot);
        picks.push({ slot, from: s?.attr ?? slot, to });
      }
      return picks;
    };

    // Budget enforcement: a target may be selected on at most budget[target] dice
    // (one charge per swap skill). Disable over-budget options; when the player
    // reassigns a target's last charge to a new die, free it from the other die.
    const recomputeAvailability = () => {
      const used = {};
      for (const sel of selects) if (sel.value) used[sel.value] = (used[sel.value] ?? 0) + 1;
      for (const sel of selects) {
        for (const opt of sel.options) {
          if (!opt.value) continue; // Default always available
          const otherUses = (used[opt.value] ?? 0) - (sel.value === opt.value ? 1 : 0);
          opt.disabled = otherUses >= (budget[opt.value] ?? 0);
        }
      }
    };
    for (const sel of selects) {
      sel.addEventListener("change", (ev) => {
        ev.stopPropagation();
        const t = sel.value;
        if (t) {
          // Free this target's charge from other dice if we've exceeded its budget.
          let otherUses = selects.filter((o) => o !== sel && o.value === t).length;
          for (const other of selects) {
            if (otherUses < (budget[t] ?? 0)) break;
            if (other !== sel && other.value === t) { other.value = ""; otherUses -= 1; }
          }
        }
        recomputeAvailability();
      });
    }
    recomputeAvailability();

    const onClick = (ev) => {
      const btn = ev.target?.closest?.("[data-fud-ds-action]");
      if (!btn) return;
      ev.stopPropagation();
      const action = btn.dataset.fudDsAction;
      if (action === "cancel") finish([]);
      else if (action === "confirm") finish(readSelection());
    };
    root.addEventListener("click", onClick);

    keyListener = (ev) => {
      if (resolved) return;
      if (ev.key === "Escape") { ev.preventDefault(); finish([]); }
      else if (ev.key === "Enter") { ev.preventDefault(); finish(readSelection()); }
    };
    window.addEventListener("keydown", keyListener, true);

    const cleanup = () => {
      try { clearTimeout(despawnTid); } catch {}
      try { window.removeEventListener("keydown", keyListener, true); } catch {}
      try { root.remove(); } catch {}
      _overlays.delete(combatId);
      if (!resolved) { resolved = true; resolve({ cancelled: true, swaps: [] }); }
    };
    _overlays.set(combatId, { cleanup, root });
  });
}

export const DieSwapPicker = {
  despawn({ director } = {}) {
    const rec = _overlays.get(director?.combatId ?? "default");
    if (!rec) return;
    try { rec.cleanup(); } catch {}
    _overlays.delete(director?.combatId ?? "default");
  },
  despawnAll() {
    for (const rec of _overlays.values()) { try { rec.cleanup(); } catch {} }
    _overlays.clear();
  },
};
