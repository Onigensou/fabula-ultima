// Battle End Defeat Screen — the party-wipe (Game Over / defeat) cinematic.
//
// ⚠ STUB — NOT YET IMPLEMENTED (handed off for co-dev implementation).
//
// The victory path has a full cinematic (battle-end-summary-ui.js →
// runBattleEndSummaryUI). The DEFEAT path has had nothing: prompt → FX →
// transition only. This module is the placeholder for the party-wipe screen; the
// orchestrator already awaits it on the defeat branch, so filling this in is all
// that's left — no orchestrator change needed.
//
// ── What to build ──────────────────────────────────────────────────────────
//   A "Game Over" / party-wipe presentation (and optionally the Fabula Ultima
//   "Surrender" consequence flow). Mirror runBattleEndSummaryUI's shape:
//     1. Broadcast the screen to ALL clients over the module socket channel so
//        every player sees it, AND run it GM-locally (the socket does not echo
//        back to the sender). Register the receiver in the module's socket
//        bootstrap, keyed on MSG_TYPE below.
//     2. AWAIT the GM-local runner so the orchestrator holds the scene
//        transition until the animation finishes (players run it independently
//        via socket and are already watching when it hits).
//     3. Keep it graceful — never throw into the FSM. The orchestrator wraps
//        this call in try/catch, but fail soft so teardown always completes.
//
// ── Context available (endCtx, populated by battle-end-orchestrator.js) ──────
//   director        live DirectorInstance — director.dCombat.combatants has the
//                   full roster (each combatant: side, name, actorDoc, tokenUuid,
//                   isDefeatedLive()); the wiped party are the side "party" ones.
//   outcome         "defeat" on this path
//   partyActorIds   string[] of the party actors' ids (the wiped party)
//   totalRounds     rounds survived before the wipe
//   isBoss          boolean          battleType   "boss" | "default" | ...
//   battleSceneId   the battle scene id     sourceSceneId  the pre-battle scene id
//   promptResult    the GM Battle-End prompt result ({ outcome, debug, ... })
//   debug           boolean — the orchestrator already skips this screen in debug
//
// The return value is ignored. Until implemented this is a safe no-op so
// BATTLE_ENDING → transition still works end-to-end.

import { log, warn } from "../logger.js";

const MODULE_ID      = "fabula-ultima-companion";
const SOCKET_CHANNEL = `module.${MODULE_ID}`;
// Reserved socket message type for the player-side broadcast. Mirrors
// ONI_BATTLEEND_SUMMARY_UI on the victory side. Register a receiver for this in
// the module's socket bootstrap when implementing.
const MSG_TYPE       = "ONI_BATTLEEND_DEFEAT_UI";

export async function runBattleEndDefeatScreen(endCtx) {
  // TODO(co-dev): implement the party-wipe / Game Over screen.
  //   - Build a defeat UI payload (party names via endCtx.partyActorIds,
  //     endCtx.totalRounds, endCtx.isBoss, flavor text).
  //   - game.socket.emit(SOCKET_CHANNEL, { type: MSG_TYPE, payload }) to fan out
  //     to players; run + AWAIT the GM-local animation here.
  //   - Optionally surface the FU "Surrender" consequence choice.
  //
  // No-op stub — keep this return until the screen is built so the pipeline
  // stays intact.
  try {
    log("[BattleEnd:DefeatScreen] STUB — party-wipe screen not yet implemented; skipping");
    // void the reserved constants so they're not flagged as unused before impl.
    void SOCKET_CHANNEL; void MSG_TYPE; void endCtx;
  } catch (e) {
    warn("[BattleEnd:DefeatScreen] stub threw", e);
  }
  return;
}
