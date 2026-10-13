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
// Layout departs from the legacy: the menu is a DOCKED command window with all
// commands on one surface (no pages), instead of anchored to the token — see
// "Command window" below.

import { log, warn } from "./logger.js";
import { INTENTS } from "./intents.js";
import { PassiveManager } from "./passive-manager.js";
import { playUiHoverSfx, playUiClickSfx } from "./director-ui-sfx.js";
import { openPlateDrawer, setHudActing, rightEdgeReserve, hudScale } from "./director-player-hud.js";
import { ensureDrawerStyles, goButtonHTML, keysBlockedFor } from "./drawer-views.js";

const STYLE_ID = "fud-turnui-style";

// Every command the menu can show. Which row (and size) each lands in is
// decided by commandColumns() below, not by this order.
// Party Swap (legacy "Switch") is still hidden. Objective SHIPPED — it opens
// a ListPicker over the creature's available options (see objectives.js).
// Unlike the boss-only Ultima blade it is always rendered: every creature has
// the world defaults, and an empty/unusable list greys the blade with a reason
// instead of hiding it, matching the action-gating stamp treatment.
const COMMANDS = ["Attack", "Guard", "Skill", "Spell", "Item", "Equipment", "Study", "Hinder", "Objective", "Passive"];

// Commands that bypass the FSM dispatch — clicking them opens an
// overlay/dialog directly instead of declaring an action. Listed here
// so the click handler can short-circuit cleanly.
const NON_ACTION_COMMANDS = new Set(["Passive"]);

// Per-director instance state — keyed by combatId so multiple directors
// don't collide on the same client.
const _instances = new Map();

// Last command each actor picked on this client (cursor memory): actorId → label.
const _lastCommand = new Map();

// Stamp a disabled blade with a red rubber-stamp label (the action-gating
// debuff's name). The stamp is appended to the WRAP (.item), not the blade,
// so the blade's per-frame dim doesn't wash it out. A long name is condensed
// horizontally via scaleX so it never spills past the blade — height is fixed
// (the stamp's own font-size/padding are untouched; only the X axis scales).
// A 0.4 floor keeps an extreme name legible rather than fitting at any cost.
function applyBladeStamp(wrap, btn, text) {
  if (!wrap || !btn) return;
  let stamp = wrap.querySelector(":scope > .blade-stamp");
  if (!stamp) {
    stamp = document.createElement("span");
    stamp.className = "blade-stamp";
    wrap.appendChild(stamp);
  }
  stamp.textContent = String(text ?? "");
  stamp.style.transform = "translate(-50%,-50%) rotate(-8deg) scaleX(1)";
  const fit = () => {
    // scrollWidth = unscaled content width (transform-independent); clientWidth
    // = blade content box. Target ~92% so the stamp breathes inside the blade.
    const bladeW = btn.clientWidth || btn.getBoundingClientRect().width;
    const stampW = stamp.scrollWidth;
    if (!bladeW || !stampW) return;
    const target = bladeW * 0.92;
    const ratio = stampW > target ? Math.max(0.4, target / stampW) : 1;
    stamp.style.transform = `translate(-50%,-50%) rotate(-8deg) scaleX(${ratio})`;
  };
  // Two frames: one for the stamp to land in layout, one for measurement.
  requestAnimationFrame(() => requestAnimationFrame(fit));
}

// ── Command window ──────────────────────────────────────────────────────────
// The menu is a JRPG command window in the bottom-right corner, instead of
// hanging off the acting token. Anchored to the token it followed every
// pan/zoom and spilled off-screen for a token near the top or right edge;
// docked it has one home the player's hand learns.
//
//   ┌─[ HINA · TURN ACTION ]────────────────────────────┐
//   │ ▶ ATTACK   1 │ GUARD    4   OBJECTIVE  8           │
//   │   SKILL    2 │ ITEM     5   EQUIPMENT  9           │
//   │   SPELL    3 │ STUDY    6   PASSIVE    0           │
//   │              │ HINDER   7                          │
//   │ Attack with one of your equipped weapons.          │
//   └────────────────────────────────────────────────────┘
//
// Genre conventions it follows: one framed window, a strict text grid (every
// cell in a column shares its width, so labels and hotkeys line up), a name
// tab on the border, a cursor that is ALWAYS on some command (mouse and keys
// move the same cursor), and a help line describing the command under it.
// Hotkeys run 1–9, 0 down each column in turn and never move when a command
// is greyed out.
//
// Two homes (2026-10-12, "own plate + command drawer"):
//   - DRAWER: when the acting actor is this client's own plate in the party
//     HUD (director-player-hud.js), the window opens out of the plate's top
//     edge inside the same parchment frame; the plate's tab carries the title
//     and the cursor lights the cost it will spend (Spell → MP, Item → IP).
//   - STANDALONE: otherwise (the GM, who has no plate; a player acting for a
//     summon) it stands alone in the bottom-right corner, or just above the
//     plate when there is one. The party diagonal always ends at the same
//     stage point, so the lowest party token sits close above that corner —
//     keep this window no taller than it is.
const PRIMARY_COMMANDS = ["Attack", "Skill", "Spell"];
const SECONDARY_ORDER = ["Guard", "Item", "Study", "Hinder", "Objective", "Equipment", "Ultima", "Passive", "Cancel"];
const HOTKEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"];
const MISSING_TICKS_LIMIT = 6;   // × 100 ms before an orphaned menu self-despawns
const EDGE_PX = 20;              // bottom gap of a standalone window (= the plate's)
const HUD_GAP_PX = 14;           // space between this client's plate and a standalone window
const MIN_SCALE = 0.75;          // smallest a standalone window shrinks to fit the width

// One line per command for the help line. Kept rules-neutral on purpose: the
// skill/spell pickers and the action card carry the exact numbers.
const COMMAND_HELP = {
  Attack: "Attack with one of your equipped weapons.",
  Skill: "Use one of your class skills.",
  Spell: "Cast a spell. Costs MP.",
  Guard: "Take a defensive stance until your next turn.",
  Item: "Use an item from your inventory. Costs IP.",
  Study: "Study a creature to learn about it.",
  Hinder: "Try to hamper a creature.",
  Objective: "Work toward a goal of this conflict.",
  Equipment: "Change your equipped gear.",
  Passive: "Review your passive effects. Doesn't use your turn.",
  Ultima: "Spend Ultima Points on Domination, Escape or Recovery.",
  Cancel: "Give up this free action.",
};

// Columns, left to right: the primary column (when any primary command is on
// offer), then the rest split over at most two columns.
function commandColumns(labels) {
  const present = new Set(labels);
  const primary = PRIMARY_COMMANDS.filter((l) => present.has(l));
  const rest = [
    ...SECONDARY_ORDER.filter((l) => present.has(l)),
    ...labels.filter((l) => !PRIMARY_COMMANDS.includes(l) && !SECONDARY_ORDER.includes(l)),
  ];
  const cols = [];
  if (primary.length) cols.push({ primary: true, labels: primary });
  if (rest.length > 4) {
    const half = Math.ceil(rest.length / 2);
    cols.push({ primary: false, labels: rest.slice(0, half) });
    cols.push({ primary: false, labels: rest.slice(half) });
  } else if (rest.length) {
    cols.push({ primary: false, labels: rest });
  }
  return cols;
}

// Where a STANDALONE window goes: { left, top, scale } in px for the root
// (transform origin is its top-left corner). Bottom-right corner on the HUD's
// shared bottom line (the card row's), clear of the
// sidebar and the floating right-edge buttons (measured by rightEdgeReserve,
// the same edge the plate keeps); above this client's plate when it has one.
// Sized like the HUD (hudScale), shrinking further to stay clear of the
// compact-card row; if even MIN_SCALE can't clear it, it sits above the row.
function dockPlacement(root) {
  const w = root.offsetWidth, h = root.offsetHeight;
  const vw = window.innerWidth, vh = window.innerHeight;
  const reserve = rightEdgeReserve();
  const right = vw - reserve;
  const plate = [...document.querySelectorAll(".dhud-unit")]
    .map((u) => u.getBoundingClientRect()).find((r) => r.height > 0);
  const cards = [...document.querySelectorAll(".dhud-card")]
    .map((c) => c.getBoundingClientRect()).filter((r) => r.height > 0);
  // Sit on the HUD's shared bottom line (the card row's), like the plate does.
  const baseline = cards.length ? Math.max(...cards.map((r) => r.bottom)) : vh - EDGE_PX;
  let bottom = plate ? plate.top - HUD_GAP_PX : baseline;
  let scale = Math.min(1, hudScale(), (right - EDGE_PX) / w);
  if (cards.length && bottom > Math.min(...cards.map((r) => r.top))) {
    const cardsRight = Math.max(...cards.map((r) => r.right));
    const fit = (right - cardsRight - HUD_GAP_PX) / w;
    if (fit >= MIN_SCALE) scale = Math.min(scale, fit);
    else bottom = Math.min(bottom, Math.min(...cards.map((r) => r.top)) - HUD_GAP_PX);
  }
  scale = Math.max(MIN_SCALE, scale);
  return { left: right - w * scale, top: bottom - h * scale, scale };
}

function ensureBaseStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const css = document.createElement("style");
  css.id = STYLE_ID;
  css.textContent = `
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

    /* Position is set inline by dockPlacement(). z 70: over the canvas + HUD,
       under the GM buttons (81), the action card (95) and windows (100+). */
    .fud-octopath{
      position:fixed; left:0; top:0; transform-origin:top left;
      z-index:70; pointer-events:none;
    }
    .fud-octopath .cmd-window{
      position:relative; pointer-events:auto;
      padding:26px 18px 12px;
      background:linear-gradient(180deg,var(--fud-parchment-top),var(--fud-parchment-bot));
      border:2px solid var(--fud-stroke); border-radius:12px;
      box-shadow:0 0 0 1px var(--fud-highlight) inset, 0 10px 26px rgba(0,0,0,.45);
      font-family:"Inter","Signika","Segoe UI",system-ui,-apple-system,sans-serif;
      color:var(--fud-ink);
      opacity:0; transform:translateY(12px);
      transition:opacity 180ms ease-out, transform 220ms cubic-bezier(.2,.8,.2,1);
    }
    .fud-octopath.is-shown .cmd-window{ opacity:1; transform:none; }
    /* Inner gold hairline: the double frame of a classic command window. */
    .fud-octopath .cmd-window::before{
      content:""; position:absolute; inset:4px; pointer-events:none;
      border:1px solid var(--fud-gold-1); border-radius:8px;
    }

    .fud-octopath .cmd-title{
      position:absolute; left:16px; top:-15px; z-index:2;
      display:flex; align-items:center; gap:8px;
      padding:4px 14px;
      background:var(--fud-ink); color:var(--fud-parchment-top);
      border:2px solid var(--fud-gold-2); border-radius:8px;
      font-size:13px; font-weight:800; letter-spacing:.12em; text-transform:uppercase;
      white-space:nowrap; box-shadow:0 3px 0 var(--fud-shadow);
    }
    .fud-octopath .cmd-title .budget, .fud-octopath .cmd-title .dot{ color:var(--fud-gold-1); }

    .fud-octopath .cmd-body{ display:flex; align-items:flex-start; gap:14px; }
    .fud-octopath .cmd-col{ display:flex; flex-direction:column; gap:4px; min-width:164px; }
    .fud-octopath .cmd-col.is-primary{ min-width:194px; }
    .fud-octopath .cmd-sep{
      align-self:stretch; width:1px;
      background:linear-gradient(180deg,transparent,var(--fud-gold-2) 15%,var(--fud-gold-2) 85%,transparent);
    }

    .fud-octopath .item{ position:relative; }
    .fud-octopath .blade{
      display:grid; grid-template-columns:16px minmax(0,1fr) auto; align-items:center; column-gap:8px;
      height:34px; padding:0 8px 0 4px; border-radius:7px;
      font-size:15px; font-weight:700; letter-spacing:.08em; text-transform:uppercase;
      white-space:nowrap; user-select:none; cursor:pointer;
    }
    .fud-octopath .blade.is-primary{ height:46px; font-size:21px; font-weight:800; letter-spacing:.1em; }
    .fud-octopath .blade .cursor{
      color:var(--fud-gold-2); font-size:13px; line-height:1; visibility:hidden;
      text-shadow:0 1px 0 var(--fud-highlight);
    }
    .fud-octopath .blade.is-primary .cursor{ font-size:17px; }
    /* Same "selected" treatment as a focused row in the list / skill pickers,
       so the cursor reads the same on every battle surface. */
    .fud-octopath .blade.is-cursor{
      background:linear-gradient(180deg,#fef5dc,#ebd9a6);
      box-shadow:0 0 0 1px rgba(90,62,28,.55) inset, inset 3px 0 0 var(--fud-gold-2);
    }
    .fud-octopath .blade.is-cursor .cursor{ visibility:visible; animation:fud-cmd-nudge 1s ease-in-out infinite; }
    @keyframes fud-cmd-nudge{ 0%,100%{ transform:translateX(0) } 50%{ transform:translateX(2px) } }
    @media (prefers-reduced-motion: reduce){
      .fud-octopath .cmd-window{ transition:opacity 120ms linear; transform:none; }
      .fud-octopath .blade.is-cursor .cursor{ animation:none; }
    }
    .fud-octopath .blade .label{ overflow:hidden; text-overflow:ellipsis; }
    .fud-octopath .blade .key{
      min-width:22px; height:22px; padding:0 5px; box-sizing:border-box;
      display:grid; place-items:center; border-radius:6px;
      font-size:12px; font-weight:800; letter-spacing:0;
      color:var(--fud-ink-soft); background:rgba(58,50,40,.08);
      border:1px solid rgba(122,106,85,.5);
    }
    .fud-octopath .blade.is-primary .key{ min-width:26px; height:26px; font-size:14px; }
    .fud-octopath .blade.is-cursor .key{ background:var(--fud-ink); color:var(--fud-parchment-top); border-color:var(--fud-ink); }

    /* Free-action filter: out of scope, so heavily muted. */
    .fud-octopath .blade.fud-disabled{ cursor:not-allowed; opacity:.35; }
    /* Nothing to spend it on (no spell you can pay for, no item, ...): dimmed,
       no stamp; the help line says why when the cursor is on it. */
    .fud-octopath .blade.is-unavailable{ cursor:not-allowed; }
    .fud-octopath .blade.is-unavailable .label, .fud-octopath .blade.is-unavailable .key{ opacity:.42; }
    /* Faint rule between rows, drawn in the gap so it adds no height; it fades
       at both ends and steps aside around the row under the cursor. */
    .fud-octopath .cmd-col > .item + .item::before{
      content:""; position:absolute; left:6px; right:6px; top:-2px; height:1px; pointer-events:none;
      background:linear-gradient(90deg,transparent,rgba(122,106,85,.42) 10%,rgba(122,106,85,.42) 90%,transparent);
    }
    .fud-octopath .cmd-col > .item:has(> .blade.is-cursor)::before,
    .fud-octopath .cmd-col > .item:has(> .blade.is-cursor) + .item::before{ display:none; }
    /* Action-gating debuff: dimmed under its red stamp, still readable. */
    .fud-octopath .blade.is-blocked{ cursor:not-allowed; }
    .fud-octopath .blade.is-blocked .label, .fud-octopath .blade.is-blocked .key{ opacity:.45; }
    /* Red rubber-stamp over a blocked command — the action-gating debuff's name
       (Frightened / Silence / …). Lives on .item (the wrap), NOT .blade, so the
       label's dim doesn't wash it out. JS measures it and scaleX-compresses a
       long word to fit inside the cell (see applyBladeStamp). */
    .fud-octopath .item > .blade-stamp{
      position:absolute; top:50%; left:50%;
      transform:translate(-50%,-50%) rotate(-6deg); transform-origin:center center;
      font-family:"Cinzel","Georgia",serif; font-weight:900; font-size:12px;
      letter-spacing:1.2px; text-transform:uppercase; white-space:nowrap;
      color:rgba(200,16,16,1);
      text-shadow:0 1px 0 rgba(255,255,255,.7), 0 0 1px rgba(120,0,0,.9);
      padding:1px 7px; border:2px solid rgba(200,16,16,.95);
      border-radius:4px; background:rgba(255,238,228,.92);
      pointer-events:none; z-index:3;
    }

    .fud-octopath .cmd-help{
      margin-top:10px; padding:8px 4px 0;
      border-top:1px solid rgba(122,106,85,.35);
      font-size:14.5px; font-style:italic; color:var(--fud-ink-soft);
      white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
    }
    .fud-octopath .cmd-help.is-warning{ color:#a3241b; font-style:normal; font-weight:700; }

    /* Docked as the drawer of this client's plate (director-player-hud.js): the
       plate supplies the frame, the name tab and the position, and the rows are
       tighter so plate + drawer stay under the lowest party token. */
    .fud-octopath.is-docked{ position:static; transform:none !important; z-index:auto; }
    .fud-octopath.is-docked .cmd-window{
      padding:14px 18px 6px; background:none; border:0; border-radius:0; box-shadow:none;
    }
    .fud-octopath.is-docked .cmd-window::before, .fud-octopath.is-docked .cmd-title{ display:none; }
    .fud-octopath.is-docked .cmd-col{ gap:3px; }
    .fud-octopath.is-docked .blade{ height:27px; font-size:14px; }
    .fud-octopath.is-docked .blade.is-primary{ height:36px; font-size:19px; }
    .fud-octopath.is-docked .blade.is-primary .cursor{ font-size:16px; }
    .fud-octopath.is-docked .blade.is-primary .key{ min-width:25px; height:25px; font-size:13.5px; }
    /* One fixed-height line: a long description never grows the drawer. */
    .fud-octopath.is-docked .cmd-help{
      box-sizing:border-box; height:23px; margin-top:4px; padding:4px 4px 0;
      font-size:13.5px; line-height:18px; font-weight:600;
    }
  `;
  document.head.appendChild(css);
}

// Spawn the command window for a given token. Returns a `record` with
// cleanup() that the caller invokes to despawn.
//
// Params:
//   - token:     the acting token (required). Names the title tab, and the
//                window self-despawns if it disappears from the canvas.
//   - combatId:  used for DOM id keying.
//   - onPick:    (command) => void. Called when a non-passive command is
//                picked. GM dispatches into director; player emits intent
//                over socket. Must be supplied if no director.
//   - onPassive: () => void. Called when Passive is picked.
//                Default opens PassiveManager for the actor.
function spawnMenu({ token, combatId, onPick, onPassive, enabledLabels = null, budgetText = null, disabledLabels = null, unavailableLabels = null, showUltima = false }) {
  ensureBaseStyles();
  ensureDrawerStyles();

  // Free-action mode (enabledLabels supplied): only the allowed commands +
  // Passive (only when explicitly allowed — omitting it keeps the menu clean
  // for single-type free actions like Voracious) + Cancel (forfeit the grant
  // per the locked cancel-pops-request rule).
  // Normal mode: every command, plus the boss-only Ultima command (opens the
  // Ultima action picker — Domination / Escape / Recovery; composeAction sets
  // showUltima from snap.isBoss; never present in a free-action window).
  const filterMode = Array.isArray(enabledLabels) && enabledLabels.length > 0;
  const labels = filterMode
    ? (() => {
        const allowed = new Set(enabledLabels.map((s) => String(s).trim()));
        return [...new Set([...COMMANDS.filter((label) => allowed.has(label)), "Cancel"])];
      })()
    : [...COMMANDS, ...(showUltima ? ["Ultima"] : [])];

  // Free-action filter: filterMode pre-filters the labels, so every rendered
  // command is by-construction enabled. The grey-out path for enabledLabels
  // without filterMode remains for backwards compatibility but is not reached
  // by composeAction.
  const enabledSet = Array.isArray(enabledLabels) && enabledLabels.length
    ? new Set(enabledLabels.map((s) => String(s).trim()))
    : null;
  // Action-gating debuff block-list — Array<{label, reason}> from the snapshot
  // (Frightened/Silence/Confused/Disarmed/Berserk). reason = the debuff name,
  // red-stamped over the command. Composes with everything else: a blocked
  // label is disabled even in a free-action window (Frightened still blocks
  // Attack).
  const blockedReasons = new Map(
    (Array.isArray(disabledLabels) ? disabledLabels : [])
      .map((d) => [String(d?.label ?? "").trim(), String(d?.reason ?? "Disabled").trim() || "Disabled"])
      .filter(([l]) => l)
  );
  // Nothing to use it on — Array<{label, reason}> from compose-action (no spell
  // you can pay for, no item or affordable recipe). Dimmed WITHOUT a stamp (a
  // stamp means a status took the action away); the reason is the help line.
  const unavailableReasons = new Map(
    (Array.isArray(unavailableLabels) ? unavailableLabels : [])
      .map((d) => [String(d?.label ?? "").trim(), String(d?.reason ?? "").trim() || "Not available."])
      .filter(([l]) => l)
  );
  function isEnabledLabel(label) {
    if (blockedReasons.has(label)) return false;   // action-gating debuff wins
    if (unavailableReasons.has(label)) return false;
    if (filterMode) return true;
    if (!enabledSet) return true;
    if (NON_ACTION_COMMANDS.has(label)) return true;
    return enabledSet.has(label);
  }

  const root = document.createElement("div");
  root.className = "fud-octopath";
  root.id = `fud-octopath-${combatId ?? "no-combat"}`;
  const win = document.createElement("div");
  win.className = "cmd-window";
  root.appendChild(win);

  const title = document.createElement("div");
  title.className = "cmd-title";
  const who = String(token?.name ?? token?.document?.name ?? "").trim();
  if (who) {
    const whoEl = document.createElement("span");
    whoEl.className = "who";
    whoEl.textContent = who;
    title.appendChild(whoEl);
  }
  if (who) {
    const sepEl = document.createElement("span");
    sepEl.className = "dot";
    sepEl.textContent = "·";
    title.appendChild(sepEl);
  }
  const budgetEl = document.createElement("span");
  budgetEl.className = "budget";
  budgetEl.textContent = budgetText ?? "Turn Action";
  title.appendChild(budgetEl);
  win.appendChild(title);

  const body = document.createElement("div");
  body.className = "cmd-body";
  win.appendChild(body);
  const help = document.createElement("div");
  help.className = "cmd-help";
  // Docked, the help line is the drawer's footer: the description and the
  // garnet Select button every later step also ends on (drawer-views.js).
  // Standalone (the GM), the footer is display:contents and the button hidden.
  const foot = document.createElement("div");
  foot.className = "cmd-foot";
  foot.appendChild(help);
  foot.insertAdjacentHTML("beforeend", goButtonHTML("Select"));
  win.appendChild(foot);
  const goBtn = foot.querySelector(".dhv-btn.go");
  goBtn?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const it = grid[curC]?.[curR];
    if (!it?.enabled) return;
    playUiClickSfx();
    activate(it);
  });

  // grid[c][r] → cell record; items = the same records in hotkey order.
  const cols = commandColumns(labels);
  const grid = [];
  const items = [];
  let hotkeyIdx = 0;
  cols.forEach((col, c) => {
    if (c > 0 && cols[c - 1].primary) {
      const sep = document.createElement("div");
      sep.className = "cmd-sep";
      body.appendChild(sep);
    }
    const colEl = document.createElement("div");
    colEl.className = "cmd-col" + (col.primary ? " is-primary" : "");
    const cells = [];
    for (const label of col.labels) {
      const wrap = document.createElement("div"); wrap.className = "item";
      const btn = document.createElement("div"); btn.className = "blade";
      if (col.primary) btn.classList.add("is-primary");
      const key = label === "Cancel" ? "Esc" : (HOTKEYS[hotkeyIdx++] ?? null);
      const cursorEl = document.createElement("span");
      cursorEl.className = "cursor";
      cursorEl.textContent = "▶";
      const labelEl = document.createElement("span");
      labelEl.className = "label";
      labelEl.textContent = label;
      btn.append(cursorEl, labelEl);
      if (key) {
        const keyEl = document.createElement("span");
        keyEl.className = "key";
        keyEl.textContent = key;
        btn.appendChild(keyEl);
      }
      wrap.appendChild(btn);
      colEl.appendChild(wrap);

      const enabled = isEnabledLabel(label);
      const blockReason = blockedReasons.get(label) ?? null;
      const unavailable = unavailableReasons.get(label) ?? null;
      const disabledText = blockReason
        ? `Blocked by ${blockReason}.`
        : unavailable
          ? unavailable
          : (enabledLabels?.length ? `Not part of this free action. Allowed: ${enabledLabels.join(", ")}.` : "Not available.");
      const it = { wrap, btn, label, key, enabled, blockReason, disabledText, c, r: cells.length };
      // Mark the WRAP (.item) disabled so the shared director-ui-sfx delegated
      // listener (which matches '[id^="fud-octopath-"] .item' and checks
      // .is-disabled) stays quiet on hover/click of a non-working command.
      wrap.classList.toggle("is-disabled", !enabled);
      if (!enabled) btn.classList.add(blockReason ? "is-blocked" : unavailable ? "is-unavailable" : "fud-disabled");
      btn.addEventListener("pointerenter", () => setCursor(it.c, it.r, { sfx: false }));
      if (enabled) {
        btn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          activate(it);
        });
      }
      cells.push(it);
      items.push(it);
    }
    grid.push(cells);
    body.appendChild(colEl);
  });

  // ── Cursor ────────────────────────────────────────────────────────────────
  // Always on some command, starting on the first one that can be used.
  let curC = 0, curR = 0;
  let dock = null;   // set once the window docks into the plate's drawer
  function setCursor(c, r, { sfx = true } = {}) {
    if (!grid.length) return;
    curC = ((c % grid.length) + grid.length) % grid.length;
    const len = grid[curC].length;
    curR = Math.max(0, Math.min(len - 1, r));
    const it = grid[curC][curR];
    for (const x of items) x.btn.classList.toggle("is-cursor", x === it);
    help.textContent = it.enabled ? (COMMAND_HELP[it.label] ?? "") : it.disabledText;
    help.classList.toggle("is-warning", !it.enabled);
    goBtn?.classList.toggle("is-off", !it.enabled);
    dock?.setHint(it.enabled ? it.label : null);
    if (sfx && it.enabled) playUiHoverSfx();
  }
  // Start on the command this character used last (JRPG cursor memory), when
  // it can be used now; else the first one that can.
  const actorId = token?.actor?.id ?? token?.document?.actorId ?? null;
  const remembered = actorId ? _lastCommand.get(actorId) : null;
  const first = items.find((it) => it.enabled && it.label === remembered)
    ?? items.find((it) => it.enabled) ?? items[0];
  if (first) setCursor(first.c, first.r, { sfx: false });

  let placementKey = "";
  function placeDock() {
    const p = dockPlacement(root);
    const left = Math.round(p.left), top = Math.round(p.top), scale = Math.round(p.scale * 1000) / 1000;
    const key = `${left}|${top}|${scale}`;
    if (key === placementKey) return;
    placementKey = key;
    root.style.left = `${left}px`;
    root.style.top = `${top}px`;
    root.style.transform = scale === 1 ? "none" : `scale(${scale})`;
  }
  // Drawer when the acting actor is this client's plate; else standalone.
  // In the GM desk's console the commands are one grid of 2 columns x 6 rows
  // (gm-desk.js); the arrow keys follow that grid instead of the drawer's.
  function regridForDesk() {
    if (!root.closest?.(".gmd") || grid._desk) return;
    const it0 = grid[curC]?.[curR];
    grid.length = 0;
    for (let i = 0; i < items.length; i += 6) grid.push(items.slice(i, i + 6));
    grid.forEach((col, c) => col.forEach((it, r) => { it.c = c; it.r = r; }));
    grid._desk = true;
    if (it0) { curC = it0.c; curR = it0.r; }
  }
  function tryDock() {
    dock = openPlateDrawer(actorId, { el: root, budgetText: budgetEl.textContent });
    root.classList.toggle("is-docked", !!dock);
    if (!dock) return false;
    regridForDesk();
    placementKey = "";
    root.style.left = root.style.top = root.style.transform = "";
    const it = grid[curC]?.[curR];
    dock.setHint(it?.enabled ? it.label : null);
    return true;
  }
  if (!tryDock()) { document.body.appendChild(root); placeDock(); }
  setHudActing(actorId);
  for (const it of items) if (it.blockReason) applyBladeStamp(it.wrap, it.btn, it.blockReason);
  // Two frames so the initial (hidden) state is painted before the reveal.
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add("is-shown")));

  async function activate(it) {
    if (!it?.enabled) return;
    // Cancel (free-action mode) — resolve the picker with null so the host's
    // cancelSentinel-equivalent path runs. composeAction treats
    // `command === null` as cancellation and DECLARE.TIMEOUT then routes to
    // FREE_ACTION_WINDOW (per the cancel-pops-request rule).
    if (it.label === "Cancel") {
      try { onPick?.(null); } catch (e) { warn("Turn UI: onPick(null) threw", e); }
      return;
    }
    // Non-action commands open an overlay instead of declaring an action —
    // they don't consume the turn. Currently: "Passive".
    if (NON_ACTION_COMMANDS.has(it.label)) {
      if (it.label === "Passive") {
        try { await onPassive?.(); } catch (e) { warn("Turn UI: onPassive threw", e); }
      }
      return;
    }
    // Fire the pick callback. Caller decides whether to dispatch locally (GM)
    // or emit over socket (player).
    if (actorId) _lastCommand.set(actorId, it.label);
    // The drawer's tab names the command for the steps that follow
    // ("Guard › Targets"); a list replaces it with its own ("Spell").
    try { dock?.setCrumb?.(it.label); } catch {}
    try { onPick?.(it.label); } catch (e) { warn("Turn UI: onPick threw", e); }
  }

  // ── Keyboard ──────────────────────────────────────────────────────────────
  // Number keys fire their command directly; arrows move the cursor (up/down
  // within a column, left/right across columns keeping the row); Enter / Z
  // pick the command under it; Esc = Cancel when the window has one.
  const keyListener = (e) => {
    if (keysBlockedFor(root)) return;
    // Don't steal keys while the user is typing in an input field, textarea,
    // <select>, or any contenteditable surface (chat box, sheet fields, etc.).
    const ae = document.activeElement;
    if (ae) {
      const tag = ae.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || ae.isContentEditable) return;
    }
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    // Swallow handled keys entirely — digits would otherwise also fire
    // Foundry's hotbar macros.
    const swallow = () => { e.preventDefault(); e.stopImmediatePropagation(); };

    const byKey = items.find((it) => it.key && it.key !== "Esc" && it.key === e.key);
    if (byKey) {
      swallow();
      setCursor(byKey.c, byKey.r, { sfx: false });
      if (byKey.enabled) { playUiClickSfx(); activate(byKey); }
      return;
    }
    if (e.key === "Escape") {
      const cancel = items.find((it) => it.label === "Cancel");
      if (cancel) { swallow(); playUiClickSfx(); activate(cancel); }
      return;
    }
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      swallow();
      const len = grid[curC].length;
      setCursor(curC, (curR + (e.key === "ArrowDown" ? 1 : -1) + len) % len);
      return;
    }
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      swallow();
      setCursor(curC + (e.key === "ArrowRight" ? 1 : -1), curR);
      return;
    }
    if (e.key === "z" || e.key === "Z" || e.key === "Enter") {
      const it = grid[curC]?.[curR];
      if (!it?.enabled) return;
      swallow();
      playUiClickSfx();
      activate(it);
    }
  };
  window.addEventListener("keydown", keyListener, true);

  // Orphan guard: when the acting token is genuinely gone (deleted, or we've
  // navigated to another scene) resolve the pending pick with null — so the
  // FSM bounces cleanly via the same path as a Cancel, never wedged — and tear
  // down. A short grace window rides out Foundry's placeable rebuild on redraw.
  // The same tick re-places a standalone window, so it follows the plate and
  // window size, and re-docks a drawer whose plate was rebuilt under it (a HUD
  // rebuild mid-turn replaces the plate and drops the window with it).
  let missingTicks = 0;
  const liveTimer = setInterval(() => {
    if (dock && !root.isConnected && !tryDock()) document.body.appendChild(root);
    if (!dock) placeDock();
    const live = token?.id ? canvas?.tokens?.get(token.id) : null;
    if (live) { missingTicks = 0; return; }
    if (++missingTicks > MISSING_TICKS_LIMIT) {
      warn("Turn UI: acting token gone — self-despawning orphaned menu", token?.name);
      try { onPick?.(null); } catch (e) { warn("Turn UI self-despawn: onPick(null) threw", e); }
      cleanup();
    }
  }, 100);

  function cleanup() {
    clearInterval(liveTimer);
    try { window.removeEventListener("keydown", keyListener, true); } catch {}
    // A docked window leaves with its drawer (dock.close slides it back in and
    // removes it after); a standalone one goes now.
    if (dock && root.isConnected) { try { dock.close(); } catch { root.remove(); } }
    else { try { root.remove(); } catch {} try { dock?.close(); } catch {} }
    try { setHudActing(null, { onlyIf: actorId }); } catch {}
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
  spawn({ director, token, combatId, actorUuid, onPick, onPassive, enabledLabels = null, budgetText = null, disabledLabels = null, unavailableLabels = null, showUltima = false }) {
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

    const rec = spawnMenu({ director, token, combatId: key, onPick: pickCb, onPassive: passiveCb, enabledLabels, budgetText, disabledLabels, unavailableLabels, showUltima });
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
