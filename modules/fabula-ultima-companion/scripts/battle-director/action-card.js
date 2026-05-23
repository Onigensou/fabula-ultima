// Action chat card — Director version.
//
// Posts a chat message describing the pending action and exposes Confirm /
// Cancel buttons that dispatch into the owning director.
//
// Design intent: the director picks up confirm/cancel via the IntentChannel
// (or local dispatch on the GM client). v1 wires this directly to dispatch
// because the GM owns the UI.

import { log, warn } from "./logger.js";
import { INTENTS } from "./intents.js";

const FLAG_NS = "fabula-ultima-companion";
const FLAG_KEY = "directorActionCard";
const CSS_ID = "fud-action-card-style";

function ensureStyles() {
  if (document.getElementById(CSS_ID)) return;
  const css = document.createElement("style");
  css.id = CSS_ID;
  css.textContent = `
    .fud-action-card{
      border:2px solid #5a6a85;
      background:linear-gradient(180deg,#f6f1e6,#ebe3d0);
      border-radius:10px;
      padding:10px 12px;
      box-shadow:0 3px 0 rgba(24,28,41,.25), 0 0 0 1px rgba(255,255,255,.5) inset;
      font-family:"Inter","Segoe UI",system-ui,sans-serif;
      color:#3a3228;
    }
    .fud-action-card .fud-action-header{
      display:flex; align-items:center; gap:8px; padding-bottom:6px; margin-bottom:8px;
      border-bottom:1px solid rgba(90,106,133,.4);
    }
    .fud-action-card .fud-action-tag{
      font-size:10px; font-weight:900; letter-spacing:.5px;
      color:#5a6a85; padding:2px 8px; border:1px solid #5a6a85; border-radius:6px;
    }
    .fud-action-card .fud-action-title{ font-weight:900; letter-spacing:.32px; text-transform:uppercase; font-size:13px;}
    .fud-action-card .fud-action-body{ font-size:12px; line-height:1.5; }
    .fud-action-card .fud-action-body table{ width:100%; border-collapse:collapse; margin-top:6px;}
    .fud-action-card .fud-action-body th,.fud-action-card .fud-action-body td{ text-align:left; padding:3px 6px; border-bottom:1px dashed rgba(90,106,133,.25); }
    .fud-action-card .fud-action-body .miss{ color:#a55; }
    .fud-action-card .fud-action-body .hit{ color:#365; font-weight:700;}
    .fud-action-card .fud-action-body .crit{ color:#b87; font-weight:900; }
    .fud-action-card .fud-action-buttons{ display:flex; gap:8px; margin-top:10px; }
    .fud-action-card .fud-btn{
      flex:1;
      padding:8px 12px; border-radius:8px; cursor:pointer;
      font-weight:800; letter-spacing:.32px; text-transform:uppercase; font-size:12px;
      border:2px solid #5a6a85;
      background:linear-gradient(180deg,#a8c4d8,#7a9bb6);
      color:#221b14;
      box-shadow:0 2px 0 rgba(24,28,41,.4), 0 0 0 1px rgba(255,255,255,.5) inset;
      text-align:center;
      user-select:none;
    }
    .fud-action-card .fud-btn:hover{ filter:brightness(1.05); }
    .fud-action-card .fud-btn.fud-cancel{ background:linear-gradient(180deg,#e5d6c5,#c9b294);}
    .fud-action-card .fud-btn.fud-resolved{ opacity:0.5; cursor:not-allowed; }
  `;
  document.head.appendChild(css);
}

// Build the HTML body for an Attack action card.
function buildAttackBody({ attacker, targets, roll, perTargetResults }) {
  const a1 = roll?.A1 ?? "MIG";
  const a2 = roll?.A2 ?? "DEX";
  const dA = roll?.dA ?? 8;
  const dB = roll?.dB ?? 8;
  const rA = roll?.rA ?? "?";
  const rB = roll?.rB ?? "?";
  const total = roll?.total ?? 0;
  const hr = roll?.hr ?? 0;
  const crit = !!roll?.isCrit;
  const fumble = !!roll?.isFumble;

  const accLine = fumble
    ? `<strong>FUMBLE</strong> — auto-miss on all targets`
    : crit
      ? `<strong class="crit">CRITICAL HIT</strong> (${a1} d${dA}=${rA}, ${a2} d${dB}=${rB}) — total ${total}, HR ${hr}`
      : `${a1} d${dA}=${rA} + ${a2} d${dB}=${rB} = <strong>${total}</strong> (HR ${hr})`;

  let rows = "";
  for (const r of perTargetResults) {
    const cls = r.hit ? (r.crit ? "crit" : "hit") : "miss";
    rows += `<tr><td>${r.name}</td><td>DEF ${r.defense}</td><td class="${cls}">${r.hit ? `HIT — ${r.damage} dmg` : "MISS"}</td></tr>`;
  }

  return `
    <div class="fud-action-body">
      <div>Attack by <strong>${attacker.name}</strong></div>
      <div>${accLine}</div>
      <table>
        <thead><tr><th>Target</th><th>Defense</th><th>Result</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

// Build the HTML body for a Guard action.
function buildGuardBody({ attacker }) {
  return `
    <div class="fud-action-body">
      <div><strong>${attacker.name}</strong> uses <strong>Guard</strong>.</div>
      <div>Gains Resistance to all damage types until the start of their next turn.</div>
    </div>
  `;
}

// Post a card and resolve when the user clicks Confirm or Cancel.
// `kind` is "Attack" or "Guard" (or other in the future).
// Resolves with { confirmed: bool, messageId, cardData }.
export async function postActionCard({ director, kind, payload }) {
  ensureStyles();

  let bodyHtml = "";
  let title = kind;
  if (kind === "Attack") {
    bodyHtml = buildAttackBody(payload);
    title = `Attack — ${payload.attacker.name}`;
  } else if (kind === "Guard") {
    bodyHtml = buildGuardBody(payload);
    title = `Guard — ${payload.attacker.name}`;
  } else {
    bodyHtml = `<div class="fud-action-body">${kind} — body not implemented.</div>`;
  }

  const html = `
    <div class="fud-action-card" data-fud-card="1" data-fud-combat-id="${director.combatId}">
      <div class="fud-action-header">
        <div class="fud-action-tag">DIRECTOR</div>
        <div class="fud-action-title">${title}</div>
      </div>
      ${bodyHtml}
      <div class="fud-action-buttons">
        <div class="fud-btn fud-confirm" data-fud-action="confirm">Confirm</div>
        <div class="fud-btn fud-cancel" data-fud-action="cancel">Cancel</div>
      </div>
    </div>
  `;

  // Speaker — fall back to a generic one if no actor.
  const speaker = ChatMessage.getSpeaker({ actor: payload?.attackerActor ?? null });

  const message = await ChatMessage.create({
    user: game.user.id,
    speaker,
    content: html,
    flags: {
      [FLAG_NS]: {
        [FLAG_KEY]: {
          combatId: director.combatId,
          kind,
          resolved: false,
        },
      },
    },
  });

  log("Posted action card", message.id);

  return new Promise((resolve) => {
    let disposeHook = null;

    function tearDown() {
      if (disposeHook) { try { disposeHook(); } catch {} disposeHook = null; }
    }

    function bindButtons(msg, html$) {
      if (msg.id !== message.id) return;
      const rootEl = html$[0]?.querySelector?.(".fud-action-card");
      if (!rootEl) return;
      if (rootEl.dataset.fudBound === "1") return;
      rootEl.dataset.fudBound = "1";

      const confirm = rootEl.querySelector(".fud-confirm");
      const cancel = rootEl.querySelector(".fud-cancel");

      const finish = async (kindClicked) => {
        // Disable both buttons visually
        for (const b of rootEl.querySelectorAll(".fud-btn")) {
          b.classList.add("fud-resolved");
          b.style.pointerEvents = "none";
        }
        // Mark resolved in flags so reloads don't re-prompt
        try {
          await message.update({
            [`flags.${FLAG_NS}.${FLAG_KEY}.resolved`]: true,
            [`flags.${FLAG_NS}.${FLAG_KEY}.outcome`]: kindClicked,
          });
        } catch (e) { warn("Failed to update card flag", e); }
        tearDown();
        resolve({ confirmed: kindClicked === "confirm", messageId: message.id });
      };

      confirm?.addEventListener("click", () => finish("confirm"));
      cancel?.addEventListener("click", () => finish("cancel"));
    }

    // Bind via renderChatMessage. The message may already be rendered (we
    // just posted it), so check the open ChatLog if available.
    // Route the hook through the director's registry so director.stop()
    // cleans it up if the user never clicks Confirm/Cancel.
    disposeHook = director.hooks.on("renderChatMessage", bindButtons, { label: "card:renderChatMessage" });

    // Try to grab the already-rendered card if it exists
    setTimeout(() => {
      const el = document.querySelector(`[data-message-id="${message.id}"] .fud-action-card`);
      if (el && el.dataset.fudBound !== "1") {
        bindButtons(message, [el.parentElement]);
      }
    }, 50);
  });
}
