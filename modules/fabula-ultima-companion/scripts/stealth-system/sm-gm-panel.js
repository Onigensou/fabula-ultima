// ============================================================================
// Stealth Mode — the GM panel.
//
// The mode's whole point is a space to improvise in, so the GM's overrides are
// first-class surfaces rather than a console escape hatch. Every button here
// lands as an ordinary event on the director's queue — the same queue a player
// click uses — so improvisation is a real transition rather than a hack around
// one, and it shows up in the log next to everything else.
//
// The design rule this follows: the FSM's job is to be INTERRUPTIBLE, not to
// be complete. No ruleset will anticipate "the party hides in the water and
// holds their breath"; what it can do is never get in the way of the GM
// adjudicating it.
// ============================================================================

import {
  MODULE_ID, TAG, ALERT, ALERT_LABEL, ALERT_ORDER, AI, AI_LABEL,
} from "./sm-constants.js";
import { broadcastNarration } from "./sm-socket.js";

const PANEL_ID = "oni-stealth-gm";
const STYLE_ID = "oni-stealth-gm-style";

let _api = null;   // { director, refresh } wired by the boot module

export function wire(api) { _api = api; }

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
    #${PANEL_ID}{
      position:fixed; right:16px; top:88px; z-index:70; width:264px;
      font-family:"Signika",sans-serif; color:#e6e6e6; font-size:12.5px;
      background:rgba(14,18,24,.92); border:1px solid rgba(255,255,255,.14);
      border-radius:8px; box-shadow:0 10px 30px -14px rgba(0,0,0,.9);
      backdrop-filter:blur(3px); max-height:70vh; display:flex; flex-direction:column;
    }
    #${PANEL_ID} h4{
      margin:0; padding:9px 12px; font-size:11px; letter-spacing:.14em;
      text-transform:uppercase; opacity:.65; border-bottom:1px solid rgba(255,255,255,.1);
      display:flex; justify-content:space-between; align-items:center;
    }
    #${PANEL_ID} .sm-gm-body{ padding:10px 12px; overflow-y:auto; }
    #${PANEL_ID} .sm-gm-sec{ margin-bottom:12px; }
    #${PANEL_ID} .sm-gm-lbl{ font-size:10.5px; letter-spacing:.1em; text-transform:uppercase;
      opacity:.5; margin-bottom:5px; }
    #${PANEL_ID} button{
      cursor:pointer; background:rgba(255,255,255,.07); color:#e6e6e6;
      border:1px solid rgba(255,255,255,.18); border-radius:4px;
      padding:4px 9px; font-size:11.5px; font-family:inherit; margin:0 4px 4px 0;
    }
    #${PANEL_ID} button:hover{ background:rgba(255,255,255,.16); }
    #${PANEL_ID} .sm-gm-enemy{ display:flex; justify-content:space-between; gap:6px;
      padding:3px 0; border-bottom:1px solid rgba(255,255,255,.06); }
    #${PANEL_ID} .sm-gm-enemy b{ font-weight:600; }
    #${PANEL_ID} .sm-gm-log{ font-size:11px; opacity:.62; line-height:1.5;
      max-height:130px; overflow-y:auto; }
    #${PANEL_ID} textarea{ width:100%; background:rgba(0,0,0,.35); color:#e6e6e6;
      border:1px solid rgba(255,255,255,.16); border-radius:4px; font-family:inherit;
      font-size:11.5px; padding:5px; }
    #${PANEL_ID} .sm-gm-close{ cursor:pointer; opacity:.5; }
    #${PANEL_ID} .sm-gm-close:hover{ opacity:1; }
  `;
  document.head.appendChild(s);
}

export function render() {
  if (!game.user?.isGM) return;
  const d = _api?.director;
  if (!d?.running || !d.sm) { remove(); return; }
  ensureStyles();

  let el = document.getElementById(PANEL_ID);
  if (!el) {
    el = document.createElement("div");
    el.id = PANEL_ID;
    document.body.appendChild(el);
  }

  const sm = d.sm;
  const enemies = Object.values(sm.enemies ?? {}).filter((e) => !e.defeated);

  const enemyRows = enemies.map((e) => {
    const t = canvas?.scene?.tokens?.get?.(e.tokenId);
    return `<div class="sm-gm-enemy">
      <span><b>${t?.name ?? e.tokenId.slice(0, 6)}</b>
        <span style="opacity:.55">${AI_LABEL[e.ai] ?? e.ai}</span></span>
      <span style="opacity:.6">aw ${e.awareness} · ${e.facing}</span>
    </div>`;
  }).join("") || `<div style="opacity:.5">No enemies.</div>`;

  const logRows = (sm.log ?? []).slice(-12).reverse()
    .map((l) => `<div>R${l.round} · ${l.text}</div>`).join("");

  el.innerHTML = `
    <h4><span>Stealth · ${d.state}</span><span class="sm-gm-close" data-gm="close">✕</span></h4>
    <div class="sm-gm-body">

      <div class="sm-gm-sec">
        <div class="sm-gm-lbl">Alert — ${ALERT_LABEL[sm.alert] ?? sm.alert}</div>
        <button data-gm="alert-down">− Lower</button>
        <button data-gm="alert-up">+ Raise</button>
      </div>

      <div class="sm-gm-sec">
        <div class="sm-gm-lbl">Flow</div>
        <button data-gm="end-player">End Player Phase</button>
        <button data-gm="force-activate">Force Activation</button>
        <button data-gm="spawn">Spawn Reinforcement</button>
      </div>

      <div class="sm-gm-sec">
        <div class="sm-gm-lbl">Ad-hoc check</div>
        <button data-gm="check">Request a Check…</button>
        <div style="opacity:.5;font-size:10.5px;margin-top:3px">
          Costs no Objective — the hold-your-breath check.
        </div>
      </div>

      <div class="sm-gm-sec">
        <div class="sm-gm-lbl">Narrate</div>
        <textarea data-gm-field="narrate" rows="2" placeholder="A beat the players see…"></textarea>
        <button data-gm="narrate" style="margin-top:4px">Send</button>
      </div>

      <div class="sm-gm-sec">
        <div class="sm-gm-lbl">Enemies (${enemies.length})</div>
        ${enemyRows}
      </div>

      <div class="sm-gm-sec">
        <div class="sm-gm-lbl">Ledger: ${sm.ledger?.length ?? 0} banked</div>
        <button data-gm="settle">Settle EXP Now</button>
        <button data-gm="stop">End Stealth</button>
      </div>

      <div class="sm-gm-sec">
        <div class="sm-gm-lbl">Log</div>
        <div class="sm-gm-log">${logRows || "<div style='opacity:.5'>—</div>"}</div>
      </div>
    </div>`;

  for (const btn of el.querySelectorAll("[data-gm]")) {
    btn.addEventListener("click", () => onGm(btn.dataset.gm, el));
  }
}

export function remove() {
  document.getElementById(PANEL_ID)?.remove();
}

async function onGm(action, el) {
  const d = _api?.director;
  if (!d?.running) return;

  switch (action) {
    case "close":
      remove();
      return;

    case "alert-up":
    case "alert-down":
      await _api.shiftAlert(action === "alert-up" ? 1 : -1, "GM");
      return;

    case "end-player":
      await d.dispatch("END_TURN");
      return;

    case "force-activate":
      await _api.forceActivation();
      return;

    case "spawn":
      await _api.forceSpawn();
      return;

    case "settle":
      await _api.settleNow();
      return;

    case "stop":
      await _api.stopStealth();
      return;

    case "check":
      await openAdHocCheck();
      return;

    case "narrate": {
      const ta = el.querySelector('[data-gm-field="narrate"]');
      const text = ta?.value?.trim();
      if (!text) return;
      broadcastNarration(text, { title: "" });
      ta.value = "";
      return;
    }
  }
}

/**
 * An attribute check with a free label and no Objective cost.
 * This is the surface for everything the ruleset never anticipated.
 */
async function openAdHocCheck() {
  const ATTRS = ["DEX", "INS", "MIG", "WLP"];
  const opts = (sel) => ATTRS.map((a) => `<option value="${a}"${a === sel ? " selected" : ""}>${a}</option>`).join("");

  new Dialog({
    title: "Stealth — Request a Check",
    content: `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <label>Attribute A<select name="a">${opts("DEX")}</select></label>
        <label>Attribute B<select name="b">${opts("INS")}</select></label>
      </div>
      <label style="display:block;margin-top:8px">Difficulty Level
        <input type="number" name="dl" value="10" min="1" style="width:100%">
      </label>
      <label style="display:block;margin-top:8px">Label
        <input type="text" name="label" placeholder="Hold your breath" style="width:100%">
      </label>`,
    buttons: {
      ok: {
        label: "Ask for it",
        callback: async (html) => {
          const q = (s) => html[0].querySelector(s);
          const actorIds = (canvas?.tokens?.controlled ?? [])
            .map((t) => t.actor).filter(Boolean);
          const actors = actorIds.length ? actorIds : await _api.partyActors();
          const CR = globalThis.ONI?.CheckRequester;
          if (!CR?.request) return ui.notifications?.warn?.("Check Requester unavailable.");
          await CR.request(actors, {
            attrA: q('select[name="a"]').value,
            attrB: q('select[name="b"]').value,
            dl: Number(q('input[name="dl"]').value) || 10,
            label: q('input[name="label"]').value || "Stealth check",
            mode: "interactive", allowInvokes: true, postChat: true,
            context: { system: "stealth", kind: "adhoc" },
          });
        },
      },
      cancel: { label: "Cancel" },
    },
    default: "ok",
  }).render(true);
}
