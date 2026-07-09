// ============================================================================
// Clock System — panel clicks.
//
// The panel IS the button. Click it and the clock moves.
//
//   GM      left  → +1 section, right → −1 section. Immediately, no roll.
//           The GM manipulates the AXIS; fiat should be fast. Bigger edits live
//           in the manager window.
//
//   Player  left  → roll toward what the players WANT, right → roll the other way.
//           A player declares a GOAL, not a direction, which is why the mapping
//           reverses per clock type: on a teardown clock the players win by
//           emptying it, so their left-click erases. See `directionForClick`.
//
// ── Why Check Requester and not Check Roller ────────────────────────────────
// A clock only cares about one thing: did the check pass? Check Roller cannot
// answer that reliably.
//
//   • It never recomputes `pass` after an invoke. Its own source carries the
//     admission — `// (Optional) clear pass/fail if DL exists; you can
//     recompute later` (checkRoller-invokeButtons.js). A player who rolls 8 vs
//     DL 10 and then invokes a Bond for +3 has total 11 and pass === false.
//   • `run()` resolves when the CARD RENDERS. Invokes happen afterwards, as
//     chat-card buttons. There is no "the check is over" moment to await.
//   • It only computes `pass` at all when the DL is shown, so clocks would have
//     to reveal every Difficulty Level to the table.
//
// Check Requester recomputes the result after every trait reroll, bond,
// divination and Lucky Seven; gates invokes behind an explicit Confirm; and
// resolves `request()` only once confirmed. It computes `pass` whenever a DL
// exists, so `hiddenDl` keeps the number secret and the outcome correct.
// ============================================================================

import { CLOCK_TAG, CLICK, POLE, CLOCK_STATE } from "./clock-const.js";
import { directionForClick } from "./clock-model.js";
import * as store from "./clock-store.js";

/** Auto-confirm a lone roller who has nothing to invoke. */
const CONFIRM_TIMEOUT_MS = 20_000;

const _busy = new Set();   // clockIds with a roll in flight on THIS client

function api() { return globalThis.FUCompanion?.api?.clocks ?? null; }
function requester() { return globalThis.ONI?.CheckRequester ?? null; }

/**
 * The actor doing the rolling. A player rolls as their own character; the GM
 * never reaches this path (their clicks don't roll).
 */
function rollerActor() {
  const own = game.user?.character;
  if (own) return own;
  const controlled = canvas?.tokens?.controlled?.[0]?.actor;
  if (controlled) return controlled;
  return null;
}

function label(clock, direction) {
  const verb = direction === POLE.HIGH ? "Fill" : "Erase";
  return `${verb}: ${clock.name}`;
}

// ── The GM path: direct, no roll ────────────────────────────────────────────

async function gmAdjust(clock, click) {
  const direction = directionForClick(clock, click, true);
  await api().advance(clock.id, {
    direction,
    sections: 1,
    cause: `GM ${direction === POLE.HIGH ? "filled" : "erased"} a section`,
  });
}

// ── The player path: roll a check ───────────────────────────────────────────

async function playerRoll(clock, click) {
  const req = requester();
  if (!req?.requestOne) {
    ui.notifications?.warn("Clocks: the Check Requester is not available.");
    return;
  }

  const actor = rollerActor();
  if (!actor) {
    ui.notifications?.warn("Clocks: you have no character to roll with.");
    return;
  }

  const direction = directionForClick(clock, click, false);
  const cfg = clock.check;

  const opts = {
    dl: cfg.dl,
    hiddenDl: cfg.hiddenDl,
    label: label(clock, direction),
    allowInvokes: true,
    // We post our own clock card; the Requester's would duplicate it.
    postChat: false,
    timeout: CONFIRM_TIMEOUT_MS,
    context: { clockId: clock.id, direction },
  };
  // `null` attributes mean "any" — let the Requester use its own defaults so the
  // player picks. Passing null through would override them with nothing.
  if (cfg.attrA) opts.attrA = cfg.attrA;
  if (cfg.attrB) opts.attrB = cfg.attrB;

  const result = await req.requestOne(actor, opts);
  if (!result) return;                       // cancelled

  // `pass` is null only when no DL exists; ours always does.
  if (result.pass == null) {
    console.warn(CLOCK_TAG, "check returned no pass/fail — clock unchanged", result);
    return;
  }

  await api().applyRoll(clock.id, {
    direction,
    result: result.total,
    difficulty: result.dl ?? cfg.dl,
    isCritical: Boolean(result.isCrit),
    isFumble: Boolean(result.isFumble),
    actorUuid: actor.uuid,
    cause: `${actor.name}: ${label(clock, direction)}`,
  });
}

// ── Dispatch ────────────────────────────────────────────────────────────────

/**
 * Handle a click on a clock panel. Exported so the bar can bind it and a test
 * can drive it without synthesising mouse events.
 */
export async function onPanelClick(clockId, click) {
  const a = api();
  const clock = store.get(clockId);
  if (!a || !clock || clock.state !== CLOCK_STATE.ACTIVE) return;

  // One roll per clock per client. Without this a double-click opens two
  // Requester panels, and the Requester's own per-user lock rejects the second
  // with a notification the player didn't ask for.
  if (_busy.has(clockId)) return;
  _busy.add(clockId);

  try {
    if (game.user.isGM) await gmAdjust(clock, click);
    else await playerRoll(clock, click);
  } catch (e) {
    console.warn(CLOCK_TAG, "panel click failed", e);
  } finally {
    _busy.delete(clockId);
  }
}

/** Bind left/right click on a clock's panel element. */
export function bindPanelClicks(panelEl, clockId) {
  panelEl.addEventListener("click", (ev) => {
    ev.preventDefault();
    onPanelClick(clockId, CLICK.LEFT);
  });
  panelEl.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();          // no browser menu over the panel
    onPanelClick(clockId, CLICK.RIGHT);
  });
}

/** Tooltip text explaining what this panel's clicks do, for this user. */
export function clickHint(clock) {
  const isGM = game.user.isGM;
  const l = directionForClick(clock, CLICK.LEFT, isGM);
  const r = directionForClick(clock, CLICK.RIGHT, isGM);
  const word = (d) => (d === POLE.HIGH ? "fill" : "erase");
  return isGM
    ? `Left-click: ${word(l)} a section · Right-click: ${word(r)} a section`
    : `Left-click: roll to ${word(l)} · Right-click: roll to ${word(r)}`;
}
