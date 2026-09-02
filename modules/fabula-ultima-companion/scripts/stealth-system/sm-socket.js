// ============================================================================
// Stealth Mode — socket layer.
//
// The controller's player clicks; the GM decides. This is the wire between.
//
// ── The dedupe rule ────────────────────────────────────────────────────────
// Raw game.socket delivers to EVERY GM, and this game normally runs two (main
// GM + Co-DM). Any handler that mutates state must therefore run on exactly
// ONE of them, or every player intent resolves twice — a move walked twice, an
// alert raised twice, a takedown banked twice. `isPrimaryGM()` is that gate and
// it is not optional. See the GM Host / Anti-Dedupe pattern.
// ============================================================================

import { MODULE_ID, TAG, MSG } from "./sm-constants.js";

const CHANNEL = `module.${MODULE_ID}`;

/** The lowest-id active GM. The only client allowed to resolve an intent. */
export function isPrimaryGM() {
  if (!game.user?.isGM) return false;
  const active = game.users?.activeGM ?? null;
  if (active) return active.id === game.user.id;
  const first = game.users
    ?.filter?.((u) => u.isGM && u.active)
    ?.sort?.((a, b) => String(a.id).localeCompare(String(b.id)))?.[0];
  return first ? first.id === game.user.id : true;
}

let _installed = false;
let _onRequest = null;    // GM-side intent handler, set by the boot module
let _onState = null;      // client-side state receiver
let _onOverlay = null;
let _onNarrate = null;

export function install({ onRequest, onState, onOverlay, onNarrate } = {}) {
  _onRequest = onRequest ?? _onRequest;
  _onState   = onState   ?? _onState;
  _onOverlay = onOverlay ?? _onOverlay;
  _onNarrate = onNarrate ?? _onNarrate;

  if (_installed) return;
  _installed = true;

  game.socket.on(CHANNEL, (msg) => {
    if (!msg || typeof msg !== "object") return;

    try {
      switch (msg.type) {
        case MSG.REQUEST:
          // Exactly one GM resolves. Everyone else — including the other GM —
          // ignores it entirely.
          if (!isPrimaryGM()) return;
          _onRequest?.(msg.payload, msg.userId);
          return;

        case MSG.STATE:
          // Authoritative broadcast. The GM already has it locally.
          if (game.user?.isGM) return;
          _onState?.(msg.payload);
          return;

        case MSG.OVERLAY:
          _onOverlay?.(msg.payload);
          return;

        case MSG.NARRATE:
          _onNarrate?.(msg.payload);
          return;

        default:
          return;
      }
    } catch (e) {
      console.error(TAG, `socket handler for ${msg.type} threw`, e);
    }
  });

  console.debug(TAG, "socket installed");
}

// ── Player → GM ─────────────────────────────────────────────────────────────

/**
 * Send an intent to the GM.
 *
 * A GM clicking their own UI short-circuits: emit() does not echo to the
 * sender, so a GM-sent message would otherwise vanish. That asymmetry is the
 * classic Foundry socket trap and it is handled here once rather than at every
 * call site.
 */
export function requestIntent(payload) {
  if (game.user?.isGM) {
    if (isPrimaryGM()) _onRequest?.(payload, game.user.id);
    return { local: true };
  }
  game.socket.emit(CHANNEL, { type: MSG.REQUEST, payload, userId: game.user?.id });
  return { local: false };
}

// ── GM → everyone ───────────────────────────────────────────────────────────

/** Push authoritative state to every client. */
export function broadcastState(sm) {
  if (!game.user?.isGM) return;
  const payload = serialiseForClients(sm);
  game.socket.emit(CHANNEL, { type: MSG.STATE, payload });
  // Local listeners (the GM's own HUD) get it through the hook path.
  try { Hooks.callAll("stealth.stateBroadcast", payload); } catch (_) {}
}

export function broadcastOverlay(payload) {
  if (!game.user?.isGM) return;
  game.socket.emit(CHANNEL, { type: MSG.OVERLAY, payload });
  try { _onOverlay?.(payload); } catch (_) {}
}

export function broadcastNarration(text, { title = "" } = {}) {
  if (!game.user?.isGM) return;
  const payload = { text: String(text ?? ""), title: String(title ?? "") };
  game.socket.emit(CHANNEL, { type: MSG.NARRATE, payload });
  try { _onNarrate?.(payload); } catch (_) {}
}

/**
 * What the players are allowed to know.
 *
 * Per-enemy awareness IS included: a hidden meter is more tense in theory and
 * far more frustrating in practice, because a player cannot tell a near-miss
 * from a bug. Last-known-position is NOT included — that is the guard's
 * mistaken belief, and showing it hands the player the answer to the puzzle
 * the AI is posing.
 */
export function serialiseForClients(sm) {
  if (!sm) return null;
  return {
    active: sm.active,
    round: sm.round,
    phase: sm.phase,
    alert: sm.alert,
    party: {
      tokenId: sm.party?.tokenId ?? null,
      cell: sm.party?.cell ?? null,
      moveLeft: sm.party?.moveLeft ?? 0,
      objectiveUsed: !!sm.party?.objectiveUsed,
      controllerActorId: sm.party?.controllerActorId ?? null,
    },
    enemies: Object.values(sm.enemies ?? {})
      .filter((e) => !e.defeated)
      .map((e) => ({
        tokenId: e.tokenId,
        cell: e.cell,
        facing: e.facing,
        ai: e.ai,
        awareness: e.awareness,
      })),
    ledgerCount: sm.ledger?.length ?? 0,
  };
}
