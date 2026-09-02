// ============================================================================
// Stealth Mode — player-facing UI.
//
// Runs on EVERY client. Renders the state the GM broadcasts and turns clicks
// into intents; it never mutates anything itself.
//
// ── The turn flow ──────────────────────────────────────────────────────────
//
//   ACTION            blades: Move · Switch · Objective · End
//     ├ Move       →  MOVEMENT MODE: reachable tiles light up, hovering draws
//     │                the path arrow, clicking commits. A single Back blade
//     │                stays beside the token to leave without spending.
//     ├ Objective  →  the blade stack swaps IN PLACE for the objective list,
//     │                with Back. No dialog — leaving the board to read a
//     │                popup and coming back broke the flow the blades exist
//     │                to create.
//     ├ Switch     →  the one thing that still opens a dialog, because it is
//     │                a roster pick rather than a board action, and it is
//     │                free — it does not consume the turn.
//     └ End        →  ends the Player Phase.
//
// Reachable tiles are only lit inside movement mode. Lit permanently they
// competed with the vision cones, which are the information the player is
// actually reading.
// ============================================================================

import {
  ALERT, ALERT_LABEL, ALERT_COLOR, OBJECTIVE,
} from "./sm-constants.js";
import { cellAt, cellKey, cellDistance } from "./sm-grid.js";
import { reachable, pathFromReachable } from "./sm-lattice.js";
import * as overlay from "./sm-overlay.js";
import * as blades from "./sm-blades.js";
import { requestIntent } from "./sm-socket.js";

const HUD_ID = "oni-stealth-hud";
const STYLE_ID = "oni-stealth-hud-style";

let _view = null;
let _tune = null;
let _enabled = false;

// Interaction mode: null | "move" | "objective" | "pick-cell"
let _mode = null;
let _reach = null;
let _hoverPath = null;
let _pickCb = null;
let _pickLabel = "";
let _canvasHooked = false;

// ── Alert panel ─────────────────────────────────────────────────────────────

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
    #${HUD_ID}{
      position:fixed; left:14px; top:14px; z-index:68;
      font-family:"Inter","Segoe UI",system-ui,sans-serif;
      pointer-events:none; user-select:none;
      --sm-parchment-top:#f6f1e6; --sm-parchment-bot:#ebe3d0;
      --sm-ink:#3a3228; --sm-ink-soft:#4b4338;
      --sm-gold-1:#d5b67a; --sm-gold-2:#b7935a;
      --sm-stroke:#7a6a55; --sm-shadow:rgba(41,33,24,.55);
      --sm-highlight:rgba(255,255,255,.7);
    }
    #${HUD_ID} .sm-panel{
      position:relative; min-width:196px;
      padding:9px 14px 10px 16px;
      color:var(--sm-ink);
      background:linear-gradient(180deg,var(--sm-parchment-top),var(--sm-parchment-bot));
      border:2px solid var(--sm-stroke); border-radius:12px;
      box-shadow:0 4px 0 var(--sm-shadow), 0 0 0 1px var(--sm-highlight) inset;
      text-shadow:0 1px 0 var(--sm-highlight);
    }
    /* Gold spine, same device as a command blade's leading edge. */
    #${HUD_ID} .sm-panel::before{
      content:""; position:absolute; left:-12px; top:50%; transform:translateY(-50%);
      width:12px; height:74%;
      background:linear-gradient(180deg,var(--sm-gold-1),var(--sm-gold-2));
      border:2px solid var(--sm-stroke); border-right:none; border-radius:10px 0 0 10px;
      box-shadow:0 0 0 1px var(--sm-highlight) inset;
    }
    #${HUD_ID} .sm-tier{ display:flex; align-items:center; gap:9px; }
    #${HUD_ID} .sm-pip{
      width:12px; height:12px; border-radius:50%; flex:none;
      border:2px solid rgba(58,50,40,.55);
      box-shadow:0 0 8px 1px currentColor;
    }
    #${HUD_ID} .sm-tier-name{
      font-size:15px; font-weight:900; letter-spacing:.5px; text-transform:uppercase;
    }
    #${HUD_ID} .sm-meta{
      font-size:10.5px; font-weight:800; letter-spacing:.9px; text-transform:uppercase;
      color:var(--sm-ink-soft); opacity:.72; margin-top:2px;
    }
    #${HUD_ID} .sm-rule{
      height:2px; margin:8px 0 7px;
      background:linear-gradient(90deg,var(--sm-stroke),rgba(122,106,85,0));
      opacity:.5;
    }
    #${HUD_ID} .sm-stats{ display:flex; gap:14px; align-items:baseline; }
    #${HUD_ID} .sm-stat{
      font-size:11px; font-weight:800; letter-spacing:.7px; text-transform:uppercase;
      color:var(--sm-ink-soft);
    }
    #${HUD_ID} .sm-stat b{
      font-size:17px; font-weight:900; color:var(--sm-ink);
      font-variant-numeric:tabular-nums; margin-right:3px;
    }
    #${HUD_ID} .sm-stat.is-spent{ opacity:.42; }
    #${HUD_ID} .sm-hint{
      margin-top:7px; font-size:10.5px; font-weight:700; letter-spacing:.3px;
      color:var(--sm-ink-soft); opacity:.7; font-style:italic; text-transform:none;
    }
  `;
  document.head.appendChild(s);
}

function hudRoot() {
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

  const tier = _view.alert ?? ALERT.STEALTH;
  const color = ALERT_COLOR[tier] ?? "#fff";
  const p = _view.party ?? {};

  // No Leader line: the central token already wears the leader's portrait, so
  // naming them again is the same fact twice.
  const hint =
    _mode === "move"      ? "Click a lit tile to move"
    : _mode === "pick-cell" ? `Click a target tile — ${_pickLabel}`
    : (_view.phase === "ACTIVATE" || _view.phase === "ENEMY_START") ? "Enemy phase…"
    : canAct() ? "" : "Spectating";

  hudRoot().innerHTML = `
    <div class="sm-panel">
      <div class="sm-tier">
        <span class="sm-pip" style="background:${color}; color:${color}"></span>
        <span class="sm-tier-name" style="color:${color}">${ALERT_LABEL[tier] ?? tier}</span>
      </div>
      <div class="sm-meta">Round ${_view.round ?? 0} · ${_view.enemies?.length ?? 0} enemies</div>
      <div class="sm-rule"></div>
      <div class="sm-stats">
        <span class="sm-stat ${(p.moveLeft ?? 0) <= 0 ? "is-spent" : ""}"><b>${p.moveLeft ?? 0}</b>Move</span>
        <span class="sm-stat ${p.objectiveUsed ? "is-spent" : ""}"><b>${p.objectiveUsed ? "0" : "1"}</b>Objective</span>
      </div>
      ${hint ? `<div class="sm-hint">${hint}</div>` : ""}
    </div>`;
}

export function removeHud() {
  document.getElementById(HUD_ID)?.remove();
}

// ── Permissions ─────────────────────────────────────────────────────────────

function canAct() {
  if (game.user?.isGM) return true;
  const actorId = _view?.party?.controllerActorId;
  if (!actorId) return false;
  return !!game.actors?.get?.(actorId)?.isOwner;
}

const myTurn = () => _view?.phase === "ACTION";

function partyToken() {
  return canvas?.scene?.tokens?.get?.(_view?.party?.tokenId)?.object ?? null;
}

// ── Command stacks ──────────────────────────────────────────────────────────

function rootCommands() {
  const p = _view.party ?? {};
  const noMove = (p.moveLeft ?? 0) <= 0;
  return [
    { id: "move",      label: "Move",      note: `${p.moveLeft ?? 0}`,
      disabled: noMove, reason: "No movement left this turn" },
    { id: "switch",    label: "Switch" },
    { id: "objective", label: "Objective", disabled: !!p.objectiveUsed,
      reason: "Objective already spent this turn" },
    { id: "end",       label: "End" },
  ];
}

function objectiveCommands() {
  const near = nearestEnemy();
  const tier = _view.alert;
  return [
    { id: `obj:${OBJECTIVE.DASH}`,        label: "Dash",        note: `+${_tune?.dashBonus ?? 5}` },
    { id: `obj:${OBJECTIVE.TAKEDOWN}`,    label: "Takedown",    note: near ? near.name : "",
      disabled: !near || tier === ALERT.ALERT,
      reason: !near ? "No adjacent enemy" : "The room is on alert" },
    { id: `obj:${OBJECTIVE.HIDE}`,        label: "Hide",
      disabled: tier === ALERT.STEALTH, reason: "Already unseen" },
    { id: `obj:${OBJECTIVE.SCAN}`,        label: "Scan" },
    { id: `obj:${OBJECTIVE.DIVERSION}`,   label: "Diversion" },
    { id: `obj:${OBJECTIVE.MOVE_OBJECT}`, label: "Move Object" },
    { id: `obj:${OBJECTIVE.BREAK_COVER}`, label: "Break Cover" },
    { id: `obj:${OBJECTIVE.CUSTOM}`,      label: "Something Else" },
    { id: "back", label: "Back", back: true },
  ];
}

function nearestEnemy() {
  const pc = _view?.party?.cell;
  if (!pc) return null;
  for (const e of (_view.enemies ?? [])) {
    if (cellDistance(pc, e.cell) <= 1) {
      return { ...e, name: canvas?.scene?.tokens?.get?.(e.tokenId)?.name ?? "guard" };
    }
  }
  return null;
}

/** Rebuild the blade stack for whatever mode we are in. */
export function refreshBlades() {
  if (!_enabled || !_view?.active || !canAct() || !myTurn()) {
    blades.hideBlades();
    return;
  }
  const token = partyToken();
  if (!token) { blades.hideBlades(); return; }

  if (_mode === "move" || _mode === "pick-cell") {
    blades.showBlades(token, [{ id: "back", label: "Back", back: true }], onPick);
    return;
  }
  if (_mode === "objective") {
    blades.showBlades(token, objectiveCommands(), onPick);
    return;
  }
  blades.showBlades(token, rootCommands(), onPick);
}

// ── Command handling ────────────────────────────────────────────────────────

function onPick(id) {
  if (!canAct()) return;

  if (id === "back") { setMode(null); return; }
  if (id === "end")  { setMode(null); requestIntent({ kind: "endTurn" }); return; }
  if (id === "move") { setMode("move"); return; }
  if (id === "switch") { openSwitchDialog(); return; }
  if (id === "objective") { setMode("objective"); return; }

  if (id.startsWith("obj:")) {
    const objId = id.slice(4);
    submitObjective(objId);
    return;
  }
}

function setMode(mode) {
  _mode = mode;
  _hoverPath = null;
  _pickCb = null;
  _reach = null;
  overlay.clearMarks();
  overlay.drawReachable(null);
  if (mode === "move") computeReach();
  refreshBlades();
  renderHud();
}

/**
 * Reachability for movement mode.
 *
 * Uses the CURRENT movement pool only — Dash is not previewed. Showing the
 * dashed range before the player has spent the Objective would advertise a
 * reach they may not be able to pay for, and Dash re-enters this mode with a
 * larger pool anyway once it lands.
 */
function computeReach() {
  const p = _view?.party ?? {};
  if (!p.cell || (p.moveLeft ?? 0) <= 0) { _reach = null; overlay.drawReachable(null); return; }
  _reach = reachable(p.cell, p.moveLeft, { ignoreOccupants: false });
  overlay.drawReachable(_reach);
}

// ── Objectives ──────────────────────────────────────────────────────────────

function submitObjective(objId) {
  if (objId === OBJECTIVE.CUSTOM) {
    setMode(null);
    new Dialog({
      title: "Describe your action",
      content: `<p>What do you want to do?</p>
                <textarea name="desc" rows="3" style="width:100%"></textarea>`,
      buttons: {
        ok: {
          label: "Ask the GM",
          callback: (html) => {
            const desc = html[0].querySelector('textarea[name="desc"]')?.value ?? "";
            if (desc.trim()) requestIntent({ kind: "objective", id: objId, description: desc.trim() });
          },
        },
        cancel: { label: "Cancel" },
      },
      default: "ok",
    }).render(true);
    return;
  }

  if (objId === OBJECTIVE.TAKEDOWN) {
    const near = nearestEnemy();
    if (!near) return;
    setMode(null);
    requestIntent({ kind: "objective", id: objId, enemyId: near.tokenId });
    return;
  }

  if (objId === OBJECTIVE.DIVERSION || objId === OBJECTIVE.MOVE_OBJECT || objId === OBJECTIVE.BREAK_COVER) {
    _pickLabel = objId === OBJECTIVE.DIVERSION ? "where to draw their attention"
               : objId === OBJECTIVE.MOVE_OBJECT ? "which prop to shove"
               : "which prop to break";
    // Order matters: setMode() clears the pending callback, so it is armed
    // after the mode switch, not before.
    setMode("pick-cell");
    _pickCb = (cell) => requestIntent({ kind: "objective", id: objId, cell });
    renderHud();
    return;
  }

  setMode(null);
  requestIntent({ kind: "objective", id: objId });
}

async function openSwitchDialog() {
  const mc = globalThis.FUCompanion?.api?.MovementControl;
  let choices = [];
  try { choices = (await mc?.getEligibleControllers?.({ onlineOnly: false, includeGM: false })) ?? []; }
  catch (_) { choices = []; }

  if (!choices.length) {
    ui.notifications?.warn?.("Stealth: no eligible party members found.");
    return;
  }

  const opts = choices.map((c) => {
    const id = c.actorId ?? c.actor?.id ?? c.id;
    const name = c.actorName ?? c.actor?.name ?? c.name ?? id;
    return `<option value="${id}">${name}</option>`;
  }).join("");

  new Dialog({
    title: "Who leads?",
    content: `<p>Their stats carry every check until the round ends.</p>
              <select name="actorId" style="width:100%">${opts}</select>`,
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

// ── Canvas interaction ──────────────────────────────────────────────────────

function pointOf(event) {
  return event?.data?.getLocalPosition?.(canvas.stage)
      ?? event?.interactionData?.origin
      ?? null;
}

function onCanvasClick(event) {
  if (!_enabled || !_view?.active) return;

  // LEFT button only. Bound to canvas.stage so a click anywhere on the board
  // is heard — which also catches right-click pan and anything bubbling from
  // a UI layer, each of which would otherwise silently spend a move.
  const btn = event?.data?.originalEvent?.button ?? event?.nativeEvent?.button ?? event?.button;
  if (btn !== undefined && btn !== 0) return;
  if (!canAct() || !myTurn()) return;

  const pos = pointOf(event);
  if (!pos) return;
  const cell = cellAt(pos);

  if (_mode === "pick-cell") {
    const cb = _pickCb;
    setMode(null);
    cb?.(cell);
    return;
  }

  if (_mode !== "move" || !_reach) return;

  const node = _reach.get(cellKey(cell));
  if (!node || node.cost === 0) return;

  const path = pathFromReachable(_reach, cell);
  if (!path.length) return;

  setMode(null);
  requestIntent({ kind: "move", path });
}

function onCanvasHover(event) {
  if (!_enabled || _mode !== "move" || !_reach || !canAct() || !myTurn()) return;
  const pos = pointOf(event);
  if (!pos) return;
  const cell = cellAt(pos);
  const node = _reach.get(cellKey(cell));

  overlay.clearMarks();
  if (!node || node.cost === 0) { _hoverPath = null; return; }
  _hoverPath = pathFromReachable(_reach, cell);
  overlay.drawPathArrow(_hoverPath, _view.party.cell);
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

export function enable(tune) {
  _tune = tune ?? _tune;
  _enabled = true;
  ensureStyles();

  if (!_canvasHooked) {
    _canvasHooked = true;
    canvas?.stage?.on?.("pointerdown", onCanvasClick);
    canvas?.stage?.on?.("pointermove", onCanvasHover);
  }
  renderHud();
  redrawCones();
  refreshBlades();
}

export function disable() {
  _enabled = false;
  _mode = null;
  _reach = null;
  _pickCb = null;
  removeHud();
  blades.hideBlades();
  overlay.clearAll();

  if (_canvasHooked) {
    _canvasHooked = false;
    try {
      canvas?.stage?.off?.("pointerdown", onCanvasClick);
      canvas?.stage?.off?.("pointermove", onCanvasHover);
    } catch (_) {}
  }
}

function redrawCones() {
  if (!_view?.active) return;
  overlay.drawCones(_view.enemies ?? [], _tune ?? {});
}

/** Called on every authoritative broadcast. */
export function applyState(view, tune) {
  const prevPhase = _view?.phase;
  _view = view;
  if (tune) _tune = tune;

  if (!view?.active) { disable(); return; }
  if (!_enabled) enable(_tune);

  // Leaving ACTION cancels any half-finished interaction — a Back blade left
  // hanging over the enemy phase is a button that lies about being usable.
  if (prevPhase === "ACTION" && view.phase !== "ACTION") _mode = null;

  renderHud();
  redrawCones();
  if (_mode === "move") computeReach(); else overlay.drawReachable(null);
  refreshBlades();
}

export function currentView() { return _view; }
