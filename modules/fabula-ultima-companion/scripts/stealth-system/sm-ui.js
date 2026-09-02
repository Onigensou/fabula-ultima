// ============================================================================
// Stealth Mode — player-facing UI: the Alert HUD and the command blade.
//
// Runs on EVERY client. It renders the state the GM broadcasts and turns
// clicks into intents; it never mutates anything itself. The controller's
// player is the only one whose clicks are accepted, but everyone sees the same
// board — a stealth turn is a spectator sport for the rest of the table.
//
// ── Why a click-to-move board rather than dragging the token ───────────────
// Native dragging cannot express a movement pool, cannot show reachability,
// and cannot stop a walk halfway when a guard spots you. All three are the
// mode. So the token is not draggable here; the highlighted cells are the
// interface.
// ============================================================================

import {
  MODULE_ID, TAG, ALERT, ALERT_LABEL, ALERT_COLOR, AI_LABEL, OBJECTIVE,
} from "./sm-constants.js";
import { cellAt, cellKey, sameCell, cellDistance } from "./sm-grid.js";
import { reachable, pathFromReachable, getLattice } from "./sm-lattice.js";
import * as overlay from "./sm-overlay.js";
import { requestIntent } from "./sm-socket.js";

const HUD_ID = "oni-stealth-hud";
const STYLE_ID = "oni-stealth-style";

let _view = null;        // last broadcast state
let _tune = null;
let _reach = null;       // current reachable map
let _hoverPath = null;
let _canvasHooked = false;
let _enabled = false;

// ── Styles ──────────────────────────────────────────────────────────────────

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
    #${HUD_ID}{
      position:fixed; left:16px; bottom:96px; z-index:70;
      font-family:"Signika","Palatino Linotype",serif; color:#e8e8e8;
      user-select:none; pointer-events:none;
      display:flex; flex-direction:column; gap:10px; align-items:flex-start;
    }
    #${HUD_ID} .sm-card{
      pointer-events:auto;
      background:rgba(14,18,24,.88); border:1px solid rgba(255,255,255,.14);
      border-radius:8px; padding:10px 14px; min-width:210px;
      box-shadow:0 8px 28px -12px rgba(0,0,0,.9);
      backdrop-filter:blur(3px);
    }
    #${HUD_ID} .sm-alert{ display:flex; align-items:center; gap:10px; }
    #${HUD_ID} .sm-pip{ width:11px; height:11px; border-radius:50%; flex:none;
      box-shadow:0 0 9px 1px currentColor; }
    #${HUD_ID} .sm-alert-name{ font-size:15px; font-weight:700; letter-spacing:.04em; }
    #${HUD_ID} .sm-sub{ font-size:11.5px; opacity:.62; letter-spacing:.05em;
      text-transform:uppercase; margin-top:2px; }
    #${HUD_ID} .sm-row{ display:flex; gap:8px; align-items:center; margin-top:8px; }
    #${HUD_ID} .sm-move{ font-size:13px; font-variant-numeric:tabular-nums; }
    #${HUD_ID} .sm-move b{ font-size:17px; }
    #${HUD_ID} .sm-cmds{ display:flex; flex-wrap:wrap; gap:6px; }
    #${HUD_ID} button{
      pointer-events:auto; cursor:pointer;
      background:rgba(255,255,255,.07); color:#e8e8e8;
      border:1px solid rgba(255,255,255,.18); border-radius:5px;
      padding:5px 11px; font-size:12.5px; font-family:inherit;
      transition:background .12s ease, border-color .12s ease;
    }
    #${HUD_ID} button:hover:not(:disabled){ background:rgba(255,255,255,.16); border-color:rgba(255,255,255,.36); }
    #${HUD_ID} button:disabled{ opacity:.35; cursor:default; }
    #${HUD_ID} button.sm-primary{ background:rgba(79,209,165,.18); border-color:rgba(79,209,165,.5); }
    #${HUD_ID} .sm-spectate{ font-size:11.5px; opacity:.6; font-style:italic; }
  `;
  document.head.appendChild(s);
}

// ── Permissions ─────────────────────────────────────────────────────────────

/** May THIS client act? The controller's player, or any GM. */
function canAct() {
  if (game.user?.isGM) return true;
  const actorId = _view?.party?.controllerActorId;
  if (!actorId) return false;
  const actor = game.actors?.get?.(actorId);
  return !!actor?.isOwner;
}

const myTurn = () => _view?.phase === "ACTION" || _view?.phase === "CONTROLLER_PICK";

// ── HUD ─────────────────────────────────────────────────────────────────────

function root() {
  let el = document.getElementById(HUD_ID);
  if (!el) {
    el = document.createElement("div");
    el.id = HUD_ID;
    document.body.appendChild(el);
  }
  return el;
}

export function renderHud() {
  if (!_enabled || !_view?.active) { removeHud(); return; }
  ensureStyles();

  const el = root();
  const tier = _view.alert ?? ALERT.STEALTH;
  const color = ALERT_COLOR[tier] ?? "#fff";
  const acting = canAct() && myTurn();
  const p = _view.party ?? {};

  const controller = p.controllerActorId ? game.actors?.get?.(p.controllerActorId) : null;

  el.innerHTML = `
    <div class="sm-card">
      <div class="sm-alert">
        <span class="sm-pip" style="background:${color}; color:${color}"></span>
        <div>
          <div class="sm-alert-name" style="color:${color}">${ALERT_LABEL[tier] ?? tier}</div>
          <div class="sm-sub">Round ${_view.round ?? 0} · ${_view.enemies?.length ?? 0} enemies</div>
        </div>
      </div>
      <div class="sm-row">
        <div class="sm-move">Move <b>${p.moveLeft ?? 0}</b></div>
        <div class="sm-move" style="opacity:${p.objectiveUsed ? .4 : 1}">
          Objective ${p.objectiveUsed ? "spent" : "ready"}
        </div>
      </div>
      <div class="sm-sub" style="margin-top:6px">
        Leader: ${controller?.name ?? "—"}
      </div>
    </div>

    <div class="sm-card">
      ${acting ? `
        <div class="sm-cmds">
          <button data-sm="objective" ${p.objectiveUsed ? "disabled" : ""}>Objective</button>
          <button data-sm="switch">Switch</button>
          <button data-sm="end" class="sm-primary">End Turn</button>
        </div>
        <div class="sm-sub" style="margin-top:7px">Click a highlighted cell to move</div>
      ` : `
        <div class="sm-spectate">${
          _view.phase === "ACTIVATE" || _view.phase === "ENEMY_START"
            ? "Enemy phase…"
            : canAct() ? "Waiting…" : "Spectating — you are not the leader"
        }</div>
      `}
    </div>
  `;

  for (const btn of el.querySelectorAll("button[data-sm]")) {
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      onCommand(btn.dataset.sm);
    });
  }
}

export function removeHud() {
  document.getElementById(HUD_ID)?.remove();
}

// ── Commands ────────────────────────────────────────────────────────────────

async function onCommand(cmd) {
  if (!canAct()) return;

  switch (cmd) {
    case "end":
      requestIntent({ kind: "endTurn" });
      break;

    case "switch":
      await openSwitchDialog();
      break;

    case "objective":
      await openObjectiveDialog();
      break;
  }
}

/**
 * Choose the Main Controller. Free — it does not consume the turn, because
 * deciding who leads is a party conversation, not an action.
 */
async function openSwitchDialog() {
  const mc = globalThis.FUCompanion?.api?.MovementControl;
  let choices = [];
  try {
    choices = (await mc?.getEligibleControllers?.({ onlineOnly: false, includeGM: false })) ?? [];
  } catch (_) { choices = []; }

  if (!choices.length) {
    ui.notifications?.warn?.("Stealth: no eligible party members found.");
    return;
  }

  const opts = choices.map((c) => {
    const id = c.actorId ?? c.actor?.id ?? c.id;
    const name = c.actorName ?? c.actor?.name ?? c.name ?? id;
    return `<option value="${id}">${foundry.utils.escapeHTML?.(name) ?? name}</option>`;
  }).join("");

  const content = `
    <p>Who leads the party this round? Their stats carry every check until the round ends.</p>
    <select name="actorId" style="width:100%">${opts}</select>`;

  new Dialog({
    title: "Stealth — Main Controller",
    content,
    buttons: {
      ok: {
        label: "Take the lead",
        callback: (html) => {
          const actorId = html[0].querySelector('select[name="actorId"]')?.value;
          if (actorId) requestIntent({ kind: "switch", actorId });
        },
      },
      cancel: { label: "Cancel" },
    },
    default: "ok",
  }).render(true);
}

/**
 * The Objective menu.
 *
 * Dash, Takedown, Hide, Scan, Diversion and the rest are listed, but the row
 * that matters most is Custom: the brief asked for a space where a player says
 * what they want to do and the GM adjudicates, and `objective:custom` already
 * exists for exactly that — no fixed attributes, GM picks the pair and DL.
 */
async function openObjectiveDialog() {
  const p = _view?.party ?? {};
  const nearby = nearestEnemy();

  const rows = [
    { id: OBJECTIVE.DASH,        label: "Dash",         hint: `+${_tune?.dashBonus ?? 5} movement. Loud.` },
    { id: OBJECTIVE.TAKEDOWN,    label: "Takedown",     hint: nearby ? `Adjacent: ${nearby.name}` : "No adjacent enemy", disabled: !nearby },
    { id: OBJECTIVE.HIDE,        label: "Hide",         hint: "Lower the Alert Level", disabled: _view?.alert === ALERT.STEALTH },
    { id: OBJECTIVE.SCAN,        label: "Scan",         hint: "Reveal enemies and facings" },
    { id: OBJECTIVE.DIVERSION,   label: "Diversion",    hint: "Pull attention elsewhere" },
    { id: OBJECTIVE.MOVE_OBJECT, label: "Move Object",  hint: "Shove a crate or barricade" },
    { id: OBJECTIVE.BREAK_COVER, label: "Break Cover",  hint: "Destroy a prop. Very loud." },
    { id: OBJECTIVE.CUSTOM,      label: "Something else…", hint: "Describe it — the GM sets the check" },
  ];

  const list = rows.map((r) => `
    <button type="button" class="sm-obj" data-id="${r.id}" ${r.disabled ? "disabled" : ""}
            style="display:block;width:100%;text-align:left;margin:4px 0;padding:7px 10px;">
      <b>${r.label}</b><br><span style="opacity:.65;font-size:11.5px">${r.hint}</span>
    </button>`).join("");

  const dlg = new Dialog({
    title: "Objective Action",
    content: `<div>${list}</div>`,
    buttons: { cancel: { label: "Cancel" } },
    render: (html) => {
      for (const btn of html[0].querySelectorAll(".sm-obj")) {
        btn.addEventListener("click", async () => {
          const id = btn.dataset.id;
          dlg.close();
          await submitObjective(id, nearby);
        });
      }
    },
  });
  dlg.render(true);
}

async function submitObjective(id, nearby) {
  if (id === OBJECTIVE.CUSTOM) {
    // The roleplaying space. The player describes; the GM decides the check.
    new Dialog({
      title: "Describe your action",
      content: `<p>What do you want to do?</p>
                <textarea name="desc" rows="3" style="width:100%"></textarea>`,
      buttons: {
        ok: {
          label: "Ask the GM",
          callback: (html) => {
            const desc = html[0].querySelector('textarea[name="desc"]')?.value ?? "";
            if (desc.trim()) requestIntent({ kind: "objective", id, description: desc.trim() });
          },
        },
        cancel: { label: "Cancel" },
      },
      default: "ok",
    }).render(true);
    return;
  }

  if (id === OBJECTIVE.TAKEDOWN) {
    if (!nearby) return;
    requestIntent({ kind: "objective", id, enemyId: nearby.tokenId });
    return;
  }

  if (id === OBJECTIVE.DIVERSION || id === OBJECTIVE.MOVE_OBJECT || id === OBJECTIVE.BREAK_COVER) {
    ui.notifications?.info?.("Click a target cell on the map.");
    awaitCellPick((cell) => requestIntent({ kind: "objective", id, cell }));
    return;
  }

  requestIntent({ kind: "objective", id });
}

function nearestEnemy() {
  const partyCell = _view?.party?.cell;
  if (!partyCell) return null;
  for (const e of (_view.enemies ?? [])) {
    if (cellDistance(partyCell, e.cell) <= 1) {
      const t = canvas?.scene?.tokens?.get?.(e.tokenId);
      return { ...e, name: t?.name ?? "guard" };
    }
  }
  return null;
}

// ── Canvas interaction ──────────────────────────────────────────────────────

let _pendingCellPick = null;

function awaitCellPick(cb) {
  _pendingCellPick = cb;
}

/** Recompute and draw what the player can reach right now. */
export function refreshReachable() {
  if (!_enabled || !_view?.active) { overlay.clearAll(); return; }

  const p = _view.party ?? {};
  const acting = canAct() && myTurn() && (p.moveLeft ?? 0) > 0;

  if (!acting || !p.cell) {
    _reach = null;
    overlay.drawReachable(null);
  } else {
    _reach = reachable(p.cell, p.moveLeft, { ignoreOccupants: false });
    overlay.drawReachable(_reach);
  }

  overlay.drawCones(_view.enemies ?? [], _tune ?? {}, { alertTier: _view.alert });
}

function onCanvasClick(event) {
  if (!_enabled || !_view?.active) return;

  // LEFT button only, and only a real pointer.
  //
  // The handler is bound to canvas.stage so a click anywhere on the board is
  // heard, which also means right-clicks (pan), middle-clicks and anything
  // bubbling up from a UI layer arrive here too. Without this guard a stray
  // event spends the party's movement, and the player never sees why their
  // turn moved. Cheap check, and the failure it prevents is invisible.
  const nativeBtn = event?.data?.originalEvent?.button
    ?? event?.nativeEvent?.button
    ?? event?.button;
  if (nativeBtn !== undefined && nativeBtn !== 0) return;

  const pos = event?.data?.getLocalPosition?.(canvas.stage)
    ?? event?.interactionData?.origin
    ?? null;
  if (!pos) return;
  const cell = cellAt(pos);

  if (_pendingCellPick) {
    const cb = _pendingCellPick;
    _pendingCellPick = null;
    cb(cell);
    return;
  }

  if (!canAct() || !myTurn()) return;
  if (!_reach) return;

  const node = _reach.get(cellKey(cell));
  if (!node || node.cost === 0) return;

  const path = pathFromReachable(_reach, cell);
  if (!path.length) return;

  requestIntent({ kind: "move", path });
}

function onCanvasHover(event) {
  if (!_enabled || !_reach || !canAct() || !myTurn()) return;
  const pos = event?.data?.getLocalPosition?.(canvas.stage);
  if (!pos) return;
  const cell = cellAt(pos);
  const node = _reach.get(cellKey(cell));
  if (!node || node.cost === 0) { _hoverPath = null; return; }
  _hoverPath = pathFromReachable(_reach, cell);
  refreshReachable();
  overlay.drawPath(_hoverPath);
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

export function enable(tune) {
  _tune = tune;
  _enabled = true;
  ensureStyles();

  if (!_canvasHooked) {
    _canvasHooked = true;
    // Bound to the stage rather than a layer so a click anywhere on the board
    // is heard, including over a tile.
    canvas?.stage?.on?.("pointerdown", onCanvasClick);
    canvas?.stage?.on?.("pointermove", onCanvasHover);
  }
  renderHud();
  refreshReachable();
}

export function disable() {
  _enabled = false;
  _reach = null;
  _pendingCellPick = null;
  removeHud();
  overlay.clearAll();

  if (_canvasHooked) {
    _canvasHooked = false;
    try {
      canvas?.stage?.off?.("pointerdown", onCanvasClick);
      canvas?.stage?.off?.("pointermove", onCanvasHover);
    } catch (_) {}
  }
}

/** Called on every authoritative broadcast. */
export function applyState(view, tune) {
  _view = view;
  if (tune) _tune = tune;
  if (!view?.active) { disable(); return; }
  if (!_enabled) enable(_tune);
  renderHud();
  refreshReachable();
}

export function currentView() { return _view; }
