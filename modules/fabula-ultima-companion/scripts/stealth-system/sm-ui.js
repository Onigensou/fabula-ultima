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
  ALERT, ALERT_LABEL, ALERT_COLOR, OBJECTIVE, ARC,
} from "./sm-constants.js";
import { cellAt, cellKey, cellDistance, cellsWithin, relativeArc } from "./sm-grid.js";
import { reachable, pathFromReachable, hasLineOfSight, cellRecord } from "./sm-lattice.js";
import { surveyObservers } from "./sm-vision.js";
import * as overlay from "./sm-overlay.js";
import * as blades from "./sm-blades.js";
import { requestIntent } from "./sm-socket.js";
import * as camera from "./sm-camera.js";

const HUD_ID = "oni-stealth-hud";
const STYLE_ID = "oni-stealth-hud-style";

let _view = null;
let _tune = null;
let _enabled = false;

// Interaction mode: null | "move" | "objective" | "target"
let _mode = null;
let _reach = null;
let _hoverPath = null;
let _pickCb = null;
let _pickLabel = "";
let _targetSpec = null;      // active targeting spec — see beginTargeting()
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
    #${HUD_ID} .sm-conceal{
      display:inline-block; margin-top:5px; padding:2px 8px;
      font-size:10px; font-weight:900; letter-spacing:.1em; text-transform:uppercase;
      color:#1d3b33; background:linear-gradient(180deg,#8fd8c4,#5cb8a0);
      border:1.5px solid #3f7a6a; border-radius:5px;
      text-shadow:0 1px 0 rgba(255,255,255,.55);
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
    : _mode === "target" ? `Choose a target — ${_pickLabel}`
    : (_view.phase === "ACTIVATE" || _view.phase === "ENEMY_START") ? "Enemy phase…"
    : canAct() ? "" : "Spectating";

  hudRoot().innerHTML = `
    <div class="sm-panel">
      <div class="sm-tier">
        <span class="sm-pip" style="background:${color}; color:${color}"></span>
        <span class="sm-tier-name" style="color:${color}">${ALERT_LABEL[tier] ?? tier}</span>
      </div>
      <div class="sm-meta">Round ${_view.round ?? 0} · ${_view.enemies?.length ?? 0} enemies</div>
      ${concealBadge()}
      <div class="sm-rule"></div>
      <div class="sm-stats">
        <span class="sm-stat ${(p.moveLeft ?? 0) <= 0 ? "is-spent" : ""}"><b>${p.moveLeft ?? 0}</b>Move</span>
        <span class="sm-stat ${p.objectiveUsed ? "is-spent" : ""}"><b>${p.objectiveUsed ? "0" : "1"}</b>Objective</span>
      </div>
      ${hint ? `<div class="sm-hint">${hint}</div>` : ""}
    </div>`;
}

/**
 * Concealment is temporary and invisible on the board, so the panel has to
 * carry it. Showing the rounds left is the point: a player needs to know how
 * long the held breath lasts to decide whether to move now or wait.
 */
function concealBadge() {
  const c = _view?.party?.conceal;
  if (!c?.tier) return "";
  const label = c.tier >= 3 ? "Vanished" : c.tier === 2 ? "Well Hidden" : "Concealed";
  return `<div class="sm-conceal">${label} · ${c.roundsLeft}${c.roundsLeft === 1 ? " round" : " rounds"}</div>`;
}

export function removeHud() {
  document.getElementById(HUD_ID)?.remove();
}

// ── Docked mode-exit button ─────────────────────────────────────────────────

const EXIT_ID = "oni-stealth-exit";

/**
 * The way out of movement / target-picking.
 *
 * Bottom-right, the same corner the other scene-mode controls (Fast Travel,
 * Healing, Ritual) live in, so it is somewhere the player already looks and —
 * crucially — nowhere near the tiles they are trying to click.
 */
function renderExitButton() {
  const wanted = _enabled && _view?.active && canAct() && myTurn()
    && (_mode === "move" || _mode === "target");

  let el = document.getElementById(EXIT_ID);
  if (!wanted) { el?.remove(); return; }

  if (!el) {
    el = document.createElement("button");
    el.id = EXIT_ID;
    el.style.cssText = `
      position:fixed; right:22px; bottom:118px; z-index:69;
      width:auto; min-width:0; max-width:none; flex:none; line-height:1;
      font-family:"Inter","Segoe UI",system-ui,sans-serif;
      font-size:12.5px; font-weight:800; letter-spacing:.4px; text-transform:uppercase;
      color:#3a3228; padding:9px 18px; cursor:pointer;
      background:linear-gradient(180deg,#f6f1e6,#ebe3d0);
      border:2px solid #7a6a55; border-radius:11px;
      box-shadow:0 4px 0 rgba(41,33,24,.55), 0 0 0 1px rgba(255,255,255,.7) inset;
      text-shadow:0 1px 0 rgba(255,255,255,.7);
    `;
    el.addEventListener("click", (ev) => { ev.preventDefault(); setMode(null); });
    el.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    document.body.appendChild(el);
  }
  el.textContent = _mode === "move" ? "✕ Cancel Move" : "✕ Cancel";
}

export function removeExitButton() {
  document.getElementById(EXIT_ID)?.remove();
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
    { id: "objective", label: "Objective", disabled: !!p.objectiveUsed,
      reason: "Objective already spent this turn" },
    { id: "switch",    label: "Switch" },
    { id: "end",       label: "End" },
  ];
}

/**
 * The objective list, filtered to what is actually possible right now.
 *
 * Unavailable options are OMITTED, not greyed. A greyed row still costs the
 * player a read to rule out, and a list where half the rows are permanently
 * dead teaches them to stop reading it. What is on screen is what can be done;
 * anything the board does not currently support simply is not offered.
 *
 * The exception is Takedown, which is shown greyed when an adjacent enemy
 * exists but the room is on alert — that is a rule worth learning rather than
 * an option that never applied.
 */
function objectiveCommands() {
  const takedowns = takedownCandidates();
  const adjacent  = adjacentGuards();
  const tier = _view.alert;
  const rows = [];

  rows.push({ id: `obj:${OBJECTIVE.DASH}`, label: "Dash", note: "MIG+DEX" });

  // Only when there is something that can actually BE taken down.
  //
  // A guard who is facing you is shown greyed with the reason rather than
  // omitted: standing next to someone and being told why you cannot throttle
  // them teaches the rule, whereas an empty menu just looks broken. A guard
  // behind a wall is not listed at all — there is nothing to learn there.
  if (takedowns.length) {
    rows.push({
      id: `obj:${OBJECTIVE.TAKEDOWN}`, label: "Takedown",
      note: takedowns.length > 1 ? `${takedowns.length} targets` : takedowns[0].name,
      disabled: tier === ALERT.ALERT,
      reason: "The room is on alert — nobody is off their guard",
    });
  } else if (adjacent.length) {
    rows.push({
      id: `obj:${OBJECTIVE.TAKEDOWN}`, label: "Takedown", note: "facing you",
      disabled: true,
      reason: "They are looking straight at you — get behind them first",
    });
  }

  // Hiding only means anything once something is looking for you.
  if (tier !== ALERT.STEALTH && !inActiveCone()) {
    rows.push({ id: `obj:${OBJECTIVE.HIDE}`, label: "Hide", note: hideDlNote() });
  }

  rows.push({ id: `obj:${OBJECTIVE.SCAN}`, label: "Scan", note: "INS+INS" });
  rows.push({ id: `obj:${OBJECTIVE.DIVERSION}`, label: "Diversion" });

  // Prop actions need a prop in reach.
  const props = nearbyProps();
  if (props.movable) rows.push({ id: `obj:${OBJECTIVE.MOVE_OBJECT}`, label: "Move Object" });
  if (props.breakable) rows.push({ id: `obj:${OBJECTIVE.BREAK_COVER}`, label: "Break Cover" });

  rows.push({ id: `obj:${OBJECTIVE.CUSTOM}`, label: "Something Else" });
  rows.push({ id: "back", label: "Back", back: true });
  return rows;
}

function hideDlNote() {
  const dl = _tune?.hideDlByAlert?.[_view?.alert];
  return dl ? `DL ${dl}` : "";
}

/**
 * Is any guard SEEING the party right now? Only that bars hiding.
 *
 * The old version asked "is any hunting guard within visionRange?" with no
 * facing, wall or line-of-sight test at all — so one searching guard made Hide
 * vanish from every tile within 8 cells of it, including behind a wall with
 * its back turned, and walking away never cleared it. That single condition
 * was most of the "no matter how you walk, you get spotted" spiral.
 *
 * This is the same test the GM applies, so the button and the permission agree.
 */
function inActiveCone() {
  const pc = _view?.party?.cell;
  if (!pc || !_tune) return false;
  const conceal = _view?.party?.conceal?.tier ?? 0;

  const survey = surveyObservers(
    (_view.enemies ?? []).map((e) => ({ tokenId: e.tokenId, cell: e.cell, facing: e.facing })),
    pc, _tune, { concealTier: conceal },
  );
  return survey.anySpotted;
}

/** Movable / breakable props adjacent to the party. */
function nearbyProps() {
  const out = { movable: false, breakable: false };
  const pc = _view?.party?.cell;
  if (!pc || !canvas?.scene) return out;
  const gs = canvas.grid?.size ?? 100;

  for (const t of canvas.scene.tiles) {
    if (t.hidden) continue;
    const cfg = t.flags?.["fabula-ultima-companion"]?.stealthProp;
    if (!cfg || cfg.enabled === false) continue;
    const c = cellAt({ x: t.x + (t.width || gs) / 2, y: t.y + (t.height || gs) / 2 });
    if (cellDistance(pc, c) > 1) continue;
    if (cfg.movable) out.movable = true;
    if (cfg.destructible) out.breakable = true;
  }
  return out;
}

/**
 * Every guard the party could actually take down this instant.
 *
 * ONE function decides this, and both the menu and the targeting step call it.
 * They used to disagree: the blade appeared for any adjacent guard on raw cell
 * distance, while the targeting step additionally demanded line of sight and
 * the GM additionally refused a guard that was facing you. So Takedown could
 * be offered for someone behind a wall — the option was there, the targeting
 * then found nothing and said "Nobody within reach", and a guard facing you
 * got as far as a confirmed click before being refused.
 *
 * The arc test is the substantive rule here: you cannot throttle someone who
 * is looking straight at you. Enforcing it at the menu means the option is
 * absent rather than offered-then-denied, which is the difference between a
 * rule the player learns and a button that lies.
 */
function takedownCandidates() {
  const pc = _view?.party?.cell;
  if (!pc || !_view) return [];
  const range = _tune?.takedownRange ?? 1;
  const half  = _tune?.coneHalfAngle ?? 22;
  const out = [];

  for (const e of (_view.enemies ?? [])) {
    if ((e.stupor ?? 0) > 0) continue;                 // reeling — not a target
    if (cellDistance(pc, e.cell) > range) continue;
    if (!hasLineOfSight(pc, e.cell)) continue;         // a wall between is not reach
    // Arc is measured from the GUARD's facing toward the party — the same way
    // the authority measures it.
    if (relativeArc(e.cell, e.facing, pc, half) === ARC.FRONT) continue;
    out.push({ ...e, name: canvas?.scene?.tokens?.get?.(e.tokenId)?.name ?? "guard" });
  }
  return out;
}

/** Any adjacent guard at all, facing notwithstanding — for the menu note. */
function adjacentGuards() {
  const pc = _view?.party?.cell;
  if (!pc) return [];
  return (_view?.enemies ?? []).filter((e) =>
    (e.stupor ?? 0) <= 0 &&
    cellDistance(pc, e.cell) <= (_tune?.takedownRange ?? 1) &&
    hasLineOfSight(pc, e.cell));
}

/** Rebuild the blade stack for whatever mode we are in. */
export function refreshBlades() {
  if (!_enabled || !_view?.active || !canAct() || !myTurn()) {
    blades.hideBlades();
    return;
  }
  const token = partyToken();
  if (!token) { blades.hideBlades(); return; }

  // Movement and target-picking put NO blade beside the token.
  //
  // A Back blade there sat exactly where the player needs to click — the tiles
  // adjacent to their own — so leaving the mode and moving one step competed
  // for the same pixels. The exit is a docked button at the bottom-right
  // instead, beside the other scene-mode controls.
  if (_mode === "move" || _mode === "target") {
    blades.hideBlades();
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
  _targetSpec = null;
  overlay.clearMarks();
  overlay.drawReachable(null);
  overlay.clearTargets();
  overlay.hideCrosshair();
  if (mode === "move") computeReach();
  refreshBlades();
  renderHud();
  renderExitButton();
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

// ── Targeting ───────────────────────────────────────────────────────────────

/**
 * Enter target mode for a command that needs a point on the board.
 *
 * Everything a player needs to judge the shot is on the map before they
 * commit: the legal tiles are lit, and a crosshair snaps to whichever one the
 * cursor is over. The old flow simply said "click a target tile" in the HUD
 * and left them to discover the range, and the walls, by being refused.
 *
 * Legality is decided HERE, once, and the resulting set is what the click is
 * checked against — so the highlight and the rule can never disagree.
 *
 * @param {object} spec
 * @param {number} spec.range     max cell distance from the party
 * @param {Function} spec.filter  extra per-cell test (occupancy, props, …)
 * @param {boolean} spec.los      require clear line of sight (default true)
 * @param {boolean} spec.hostile  colour the set as a creature target
 */
function beginTargeting(spec) {
  const pc = _view?.party?.cell;
  if (!pc) return;

  const cells = [];
  for (const cell of cellsWithin(pc, spec.range)) {
    if (cellDistance(pc, cell) === 0) continue;      // never yourself
    if (spec.los !== false && !hasLineOfSight(pc, cell)) continue;
    if (spec.filter && !spec.filter(cell)) continue;
    cells.push(cell);
  }

  if (!cells.length) {
    ui.notifications?.warn?.(spec.empty ?? "Nothing in range.");
    setMode(null);
    return;
  }

  _pickLabel = spec.label ?? "";
  setMode("target");                 // clears state, so arm the spec AFTER
  _targetSpec = {
    ...spec,
    keys: new Set(cells.map(cellKey)),
  };
  _pickCb = spec.cb;
  overlay.drawTargets(cells, { hostile: !!spec.hostile });
  renderHud();
}

/** A configured prop on this cell, optionally of one kind. */
function propAtCell(cell, kind) {
  const gs = canvas?.grid?.size ?? 100;
  for (const t of (canvas?.scene?.tiles ?? [])) {
    if (t.hidden) continue;
    const cfg = t.flags?.["fabula-ultima-companion"]?.stealthProp;
    if (!cfg || cfg.enabled === false) continue;
    const c = cellAt({ x: t.x + (t.width || gs) / 2, y: t.y + (t.height || gs) / 2 });
    if (c.i !== cell.i || c.j !== cell.j) continue;
    if (kind === "movable" && !cfg.movable) continue;
    if (kind === "breakable" && !cfg.destructible) continue;
    return t;
  }
  return null;
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

  // Takedown goes through the same target step as everything else.
  //
  // It used to fire straight at the nearest enemy, silently choosing FOR the
  // player whenever two guards stood adjacent — and gave no confirmation step
  // on the one action in the game that cannot be taken back. Range 1 makes the
  // pick trivial in the common case and correct in the uncommon one.
  if (objId === OBJECTIVE.TAKEDOWN) {
    const targets = takedownCandidates();
    beginTargeting({
      range: _tune?.takedownRange ?? 1,
      hostile: true,
      label: "who to take down",
      empty: "Nobody you can reach from behind.",
      filter: (cell) => targets.some((e) => e.cell.i === cell.i && e.cell.j === cell.j),
      cb: (cell) => {
        const e = targets.find((t) => t.cell.i === cell.i && t.cell.j === cell.j);
        // Never end in silence. If the board moved under the pick, say so —
        // a callback that quietly does nothing is indistinguishable from a
        // dead button, which is exactly how this read when it went wrong.
        if (!e) { ui.notifications?.warn?.("That target is gone."); return; }
        requestIntent({ kind: "objective", id: objId, enemyId: e.tokenId });
      },
    });
    return;
  }

  if (objId === OBJECTIVE.DIVERSION) {
    beginTargeting({
      range: _tune?.diversionRange ?? 5,
      label: "where to throw",
      empty: "No clear spot to throw at.",
      // A rock has to LAND somewhere, so the tile must be real floor. Line of
      // sight is enforced by beginTargeting: you cannot throw through a wall,
      // which is what makes a corner worth walking to before you throw.
      filter: (cell) => !!cellRecord(cell)?.passable,
      cb: (cell) => requestIntent({ kind: "objective", id: objId, cell }),
    });
    return;
  }

  if (objId === OBJECTIVE.MOVE_OBJECT || objId === OBJECTIVE.BREAK_COVER) {
    const kind = objId === OBJECTIVE.MOVE_OBJECT ? "movable" : "breakable";
    beginTargeting({
      range: 1,
      label: kind === "movable" ? "which prop to shove" : "which prop to break",
      empty: "Nothing within reach to work on.",
      filter: (cell) => !!propAtCell(cell, kind),
      cb: (cell) => requestIntent({ kind: "objective", id: objId, cell }),
    });
    return;
  }

  setMode(null);
  requestIntent({ kind: "objective", id: objId });
}

/**
 * The party roster.
 *
 * MovementControl's rows are the source of truth. The trap they carry is their
 * FIELD NAMES: a row's actor lives on `partyMemberActorId` / `partyMemberActorName`,
 * not `actorId` / `actorName`. Reading the obvious names yields undefined for
 * every slot, which is exactly what the Switch dialog used to show.
 *
 * Its resolver is also better than reading the DB directly — on this world
 * `member_id_2..4` do not resolve to actors at all, while MovementControl's
 * extraction finds all four members. `onlineOnly: false` because the stealth
 * leader is an ACTOR choice (whose stats carry the round's checks), so an
 * offline player's character is still a legitimate pick and a solo GM must be
 * able to choose at all.
 */
export async function partyRoster() {
  const out = [];
  const seen = new Set();

  try {
    const rows = (await globalThis.FUCompanion?.api?.MovementControl
      ?.getEligibleControllers?.({ onlineOnly: false, includeGM: false })) ?? [];
    for (const r of rows) {
      const id = r.partyMemberActorId;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, name: r.partyMemberActorName ?? game.actors?.get?.(id)?.name ?? id });
    }
  } catch (_) { /* fall through */ }

  if (!out.length) {
    try {
      const { source: db } = (await globalThis.FUCompanion?.api?.getCurrentGameDb?.()) ?? {};
      const props = db?.system?.props ?? {};
      for (const k of Object.keys(props).filter((x) => x.startsWith("member_id_"))
        .sort((a, b) => Number(a.split("_").pop()) - Number(b.split("_").pop()))) {
        const a = game.actors?.get?.(String(props[k]));
        if (a && !seen.has(a.id)) { seen.add(a.id); out.push({ id: a.id, name: a.name }); }
      }
    } catch (_) { /* fall through */ }
  }

  return out;
}

async function openSwitchDialog() {
  const choices = await partyRoster();

  if (!choices.length) {
    ui.notifications?.warn?.("Stealth: no party members found.");
    return;
  }

  const current = _view?.party?.controllerActorId ?? null;
  const opts = choices.map((c) =>
    `<option value="${c.id}"${c.id === current ? " selected" : ""}>${c.name}</option>`).join("");

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

  if (_mode === "target") {
    // Clicking outside the lit set does NOTHING — it does not cancel.
    // Cancelling is the docked button, deliberately: a misclick on a dark tile
    // used to spend the whole command on an illegal point, and the player only
    // learned that from a warning after the fact.
    if (!_targetSpec?.keys?.has(cellKey(cell))) return;
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
  if (!_enabled || !canAct() || !myTurn()) return;

  if (_mode === "target") {
    const pos = pointOf(event);
    if (!pos) return;
    const cell = cellAt(pos);
    if (_targetSpec?.keys?.has(cellKey(cell))) {
      overlay.drawCrosshair(cell, { hostile: !!_targetSpec.hostile });
    } else {
      overlay.hideCrosshair();
    }
    return;
  }

  if (_mode !== "move" || !_reach) return;
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
  renderExitButton();
}

export function disable() {
  _enabled = false;
  _mode = null;
  _reach = null;
  _pickCb = null;
  _targetSpec = null;
  removeHud();
  removeExitButton();
  blades.hideBlades();
  overlay.clearAll();
  overlay.clearTargets();
  overlay.destroyCrosshair();
  overlay.destroyStuporLayer();
  camera.unlock();

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
  overlay.drawStuporMarks(_view.enemies ?? []);
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
  // Cleared through setMode, not by assigning _mode: half-finished targeting
  // owns overlay layers, and nulling the variable alone left the lit tiles and
  // the crosshair sitting on the board all through the enemy phase.
  if (prevPhase === "ACTION" && view.phase !== "ACTION" && _mode) setMode(null);

  renderHud();
  redrawCones();
  if (_mode === "move") computeReach(); else overlay.drawReachable(null);
  refreshBlades();
  renderExitButton();

  // Free pan on your own turn (the fog already hides what you should not see);
  // locked to the party token otherwise, so you watch the guard walking toward
  // you rather than roaming the map while the GM moves.
  if (view.phase !== prevPhase) {
    camera.applyPhasePolicy(view.phase, view.party?.cell).catch(() => {});
  }
}

export function currentView() { return _view; }
