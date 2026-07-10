// ============================================================================
// Ritual System — player → active-GM relay, and operator → everyone feedback.
//
// Raw game.socket on module.fabula-ultima-companion, matching healing-socket.js
// (socketlib's registerModule is single-use per module and gm-executor.js
// already claimed it).
//
// Only the ACTIVE GM acts on CAST_REQ. With two GMs logged in, an ungated
// handler would deduct the Mind Points twice, consume the material twice, and
// run two Check Requester sessions over the top of each other — the standard
// dual-GM dedupe trap.
// ============================================================================

import { RITUAL_TAG, RITUAL_CHANNEL, RITUAL_SOCKET } from "./ritual-const.js";
import { performCast } from "./ritual-cast.js";
import { RitualFeedback, broadcastFeedback } from "./ritual-feedback.js";

let _wired = false;

function _isActiveGM() {
  if (!game.user?.isGM) return false;
  const active = game.users?.activeGM ?? null;
  if (active) return active.id === game.user.id;
  // Fall back to "lowest-id active GM" if activeGM is unavailable.
  const firstGM = game.users?.filter?.((u) => u.isGM && u.active)
    ?.sort?.((a, b) => String(a.id).localeCompare(String(b.id)))?.[0];
  return firstGM ? firstGM.id === game.user.id : true;
}

// broadcastFeedback lives in ritual-feedback.js (ritual-cast.js needs it, and
// importing this module from there would close an import cycle). Re-exported so
// callers have one obvious place to look.
export { broadcastFeedback };

/**
 * Cast a ritual from ANY client.
 *
 * The GM performs directly — a broadcast does not echo to its own sender, so
 * relaying to ourselves would drop the cast on the floor. A player emits and
 * returns immediately; the outcome arrives as a chat card.
 *
 * `override` is GM fiat: cast despite insufficient MP. It does NOT make the
 * ritual free — debitCost clamps at zero, so the performer is simply drained.
 * Players never get it; the window disables their Perform button instead.
 */
export async function requestCast({ performerUuid, spec, override = false }) {
  if (_isActiveGM()) {
    const res = await performCast({ performerUuid, spec, override });
    if (!res.ok) ui.notifications?.warn(`Ritual: ${res.reason}`);
    return res;
  }

  game.socket.emit(RITUAL_CHANNEL, {
    type: RITUAL_SOCKET.CAST_REQ,
    payload: { performerUuid, spec, userId: game.user.id },
  });
  return { ok: true, relayed: true };
}

export function wireRitualSocket() {
  if (_wired) return;
  _wired = true;

  game.socket.on(RITUAL_CHANNEL, async (msg) => {
    if (!msg || typeof msg !== "object") return;

    if (msg.type === RITUAL_SOCKET.FEEDBACK) {
      RitualFeedback.enqueue(msg.payload ?? {});
      return;
    }

    if (msg.type === RITUAL_SOCKET.CAST_REQ) {
      if (!_isActiveGM()) return;
      const { performerUuid, spec, userId } = msg.payload ?? {};
      let res;
      try {
        // No override: a player never casts past their MP.
        res = await performCast({ performerUuid, spec, override: false });
      } catch (e) {
        console.error(RITUAL_TAG, "performCast threw", e);
        res = { ok: false, reason: "The Ritual could not be performed." };
      }
      if (!res.ok) {
        game.socket.emit(RITUAL_CHANNEL, {
          type: RITUAL_SOCKET.REFUSED,
          payload: { userId, reason: res.reason },
        });
      }
      return;
    }

    if (msg.type === RITUAL_SOCKET.REFUSED) {
      if (msg.payload?.userId !== game.user.id) return;
      ui.notifications?.warn(`Ritual: ${msg.payload.reason}`);
    }
  });

  console.debug(RITUAL_TAG, "socket wired.");
}
