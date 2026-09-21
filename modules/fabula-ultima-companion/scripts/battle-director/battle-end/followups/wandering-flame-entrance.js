// ⭐ Wandering Flame — entrance wiring.
//
// The boss plummets from the top of the screen and slams its spawn point with
// a fiery explosion + screenshake.
//
// The renderer that used to live here (faller, burst, screenshake, impact SFX,
// media-ready gate, sprite sizing) has been folded into
// `battle-director/boss-entrance-fx.js` as the `flame` style — the
// "future data-driven entrance-animation system (no per-boss hardcoding)"
// this file's original header asked for. Its visuals are unchanged, constant
// for constant; what remains here is this boss's socket registration and its
// GM-side entry point, both with the same signatures they always had.
//
// Fafnir's Dreadwyrm Descent uses the same renderer under the `shadowstorm`
// style, reached through the director's entrance phase rather than through
// this followup path.

import { log, warn } from "../../logger.js";
import { playDescentLocal, buildDescentPayload } from "../../boss-entrance-fx.js";

const MODULE_ID   = "fabula-ultima-companion";
const ACTION_PLAY = "FU_WF_ENTRANCE_PLAY";

const WF_STYLE = "flame";

let _socket = null;

// Idempotent socket registration. Call once per client on boot `ready`.
export function initWanderingFlameEntrance() {
  try {
    if (typeof socketlib === "undefined" || !game.modules.get("socketlib")?.active) {
      warn("[WF-entrance] socketlib unavailable — entrance stays local-only");
      return;
    }
    _socket = socketlib.registerModule(MODULE_ID);
    _socket.register(ACTION_PLAY, playEntranceLocal);
    log("[WF-entrance] socket registered");
  } catch (e) { warn("[WF-entrance] init failed", e); }
}

// Returns a Promise that resolves at IMPACT (the fall finishing). The
// explosion + screenshake + faller fade-out run after the resolve.
//
// Still exported under its original name because it is the registered socket
// handler, and a broadcast from a client running the pre-refactor code carries
// no `style` — which the renderer defaults to `flame`, i.e. this boss.
export function playEntranceLocal(opts = {}) {
  return playDescentLocal({ ...opts, style: opts.style ?? WF_STYLE });
}

// GM-side entry, invoked by the in-place reinforce init (payload.followup.entrance).
// Renders locally + broadcasts to all other clients. Resolves when the LOCAL
// impact lands so the init can continue (reveal token, build dCombat).
export async function playWanderingFlameEntrance({ tokens = [], scene = null } = {}) {
  const token = Array.isArray(tokens) ? tokens[0] : tokens;
  const payload = buildDescentPayload(token, WF_STYLE, scene);

  try { _socket?.executeForOthers?.(ACTION_PLAY, payload); }
  catch (e) { warn("[WF-entrance] broadcast failed", e); }

  try { await playEntranceLocal(payload); }
  catch (e) { warn("[WF-entrance] local play threw", e); }
}
