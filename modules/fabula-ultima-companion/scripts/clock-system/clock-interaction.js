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
//     admission — "// (Optional) clear pass/fail if DL exists; you can
//     recompute later" (checkRoller-invokeButtons.js). A player who rolls 8 vs
//     DL 10 and then invokes a Bond for +3 has total 11 and pass === false.
//   • run() resolves when the CARD RENDERS. Invokes happen afterwards, as
//     chat-card buttons. There is no "the check is over" moment to await.
//   • It only computes `pass` at all when the DL is shown, so clocks would have
//     to reveal every Difficulty Level to the table.
//
// ── Why the player's click goes through the GM ──────────────────────────────
// The Check Requester is GM-ORCHESTRATED. `interactiveRequest` opens with:
//
//     if (!game.user?.isGM) throw new Error("interactive mode must run on the
//                                            GM client.");
//
// The GM starts the session; the panel is then broadcast to the actor's owner,
// who rolls, invokes and confirms on their own client. So a player's panel
// click cannot call `requestOne` locally — it asks the active GM to run it.
//
// That is fire-and-forget, not a request/response: a check with invokes and a
// confirm step can take a minute, far longer than the mutate envelope's 10s
// timeout. Nothing needs to come back, either — the GM applies the result to
// the registry, and every client's bar updates from the setting diff.
//
// It also tightens the trust boundary. The dice are now rolled and read on the
// GM's client, so `applyRoll` no longer needs to accept a die result from a
// player, and is GM-only.
// ============================================================================

import { CLOCK_TAG, CLOCK_CHANNEL, CLOCK_SOCKET, CLICK, POLE, CLOCK_STATE } from "./clock-const.js";
import { directionForClick } from "./clock-model.js";
import * as store from "./clock-store.js";

/** Auto-confirm a roller who has nothing to invoke. */
const CONFIRM_TIMEOUT_MS = 20_000;

const _busy = new Set();        // clockIds with a click in flight on THIS client
const _gmBusy = new Set();      // clockIds with a Requester session open on the GM
let _wired = false;

function api() { return globalThis.FUCompanion?.api?.clocks ?? null; }
function requester() { return globalThis.ONI?.CheckRequester ?? null; }

/** The actor a given user rolls as. */
function actorForUser(user) {
  if (user?.character) return user.character;
  return null;
}

function label(clock, direction) {
  const verb = direction === POLE.HIGH ? "Fill" : "Erase";
  return `${verb}: ${clock.name}`;
}

/**
 * Requester options for a clock's check.
 *
 * NOTE: `attrA: null` does NOT mean "the player picks" — the Requester coerces
 * null to DEX/MIG and its panel has no attribute picker. Null means "use the
 * default pair". Leaving them off the options object says the same thing more
 * honestly than passing null.
 */
function checkOptions(clock, direction) {
  const cfg = clock.check;
  const opts = {
    dl: cfg.dl,
    hiddenDl: cfg.hiddenDl,
    label: label(clock, direction),
    allowInvokes: true,
    // We post our own clock card on resolution; the Requester's would duplicate.
    postChat: false,
    timeout: CONFIRM_TIMEOUT_MS,
    context: { clockId: clock.id, direction },
  };
  if (cfg.attrA) opts.attrA = cfg.attrA;
  if (cfg.attrB) opts.attrB = cfg.attrB;
  return opts;
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

// ── The player path: ask the GM to run the check ────────────────────────────

function requestRollFromGM(clock, click) {
  const actor = actorForUser(game.user);
  if (!actor) {
    ui.notifications?.warn("Clocks: you have no character to roll with.");
    return;
  }
  if (!game.users.some((u) => u.isGM && u.active)) {
    ui.notifications?.warn("Clocks: no GM is connected to run the check.");
    return;
  }

  const direction = directionForClick(clock, click, false);
  game.socket.emit(CLOCK_CHANNEL, {
    type: CLOCK_SOCKET.ROLL_REQ,
    clockId: clock.id,
    direction,
    actorUuid: actor.uuid,
    userId: game.user.id,
  });
}

/**
 * GM side. Runs the Requester session for the player's actor and commits the
 * result. Authorisation happens HERE, not on the requesting client: the user
 * must actually own the actor they asked us to roll with.
 */
async function runRollForPlayer({ clockId, direction, actorUuid, userId }) {
  if (!store.isActiveGM()) return;          // exactly one GM answers

  const clock = store.get(clockId);
  if (!clock || clock.state !== CLOCK_STATE.ACTIVE) return;

  // One Requester session per clock. Two players clicking the same clock at once
  // would otherwise open two sessions racing to move it.
  if (_gmBusy.has(clockId)) return;

  const user = game.users.get(userId);
  const actor = await fromUuid(actorUuid);
  if (!user || !actor) return;
  if (!actor.testUserPermission(user, "OWNER")) {
    console.warn(CLOCK_TAG, `${user.name} asked to roll with an actor they do not own`);
    return;
  }

  const req = requester();
  if (!req?.requestOne) {
    console.warn(CLOCK_TAG, "Check Requester is not available on the GM client");
    return;
  }

  _gmBusy.add(clockId);
  try {
    const result = await req.requestOne(actor, checkOptions(clock, direction));
    if (!result) return;                    // cancelled

    // `pass` is null only when no DL exists; a clock always has one.
    if (result.pass == null) {
      console.warn(CLOCK_TAG, "check returned no pass/fail — clock unchanged", result);
      return;
    }

    await store.roll(clockId, {
      direction,
      result: result.total,
      difficulty: result.dl ?? clock.check.dl,
      isCritical: Boolean(result.isCrit),
      isFumble: Boolean(result.isFumble),
      actorUuid: actor.uuid,
      cause: `${actor.name}: ${label(clock, direction)}`,
    });
  } catch (e) {
    console.warn(CLOCK_TAG, "GM-side clock roll failed", e);
  } finally {
    _gmBusy.delete(clockId);
  }
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

  // One click per clock per client, so a double-click cannot open two sessions.
  if (_busy.has(clockId)) return;
  _busy.add(clockId);

  try {
    if (game.user.isGM) await gmAdjust(clock, click);
    else requestRollFromGM(clock, click);
  } catch (e) {
    console.warn(CLOCK_TAG, "panel click failed", e);
  } finally {
    // The player's part is over the moment the request is emitted; the roll
    // itself happens on the GM. Releasing immediately would let a second click
    // queue a second session, so hold the lock briefly.
    setTimeout(() => _busy.delete(clockId), game.user.isGM ? 0 : 1500);
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

/** Listen for players' roll requests. Registered on every client; only the active GM acts. */
export function wireClockRolls() {
  if (_wired) return;
  _wired = true;

  game.socket.on(CLOCK_CHANNEL, (data) => {
    if (data?.type !== CLOCK_SOCKET.ROLL_REQ) return;
    runRollForPlayer(data).catch((e) => console.warn(CLOCK_TAG, "roll request handler threw", e));
  });

  console.debug(CLOCK_TAG, "roll requests wired");
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
