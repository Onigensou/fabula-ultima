/**
 * Spend gate
 * ---------------------------------------------------------------------------
 * Choosing a skill mid-session stalls the table, so Skill Points may only be
 * spent where the game is already paused:
 *
 *   Camp        — scene mode "camp", during one of the three ready-up lobbies
 *                 (free_roam, sleep_lobby, set_out_lobby)
 *   Title screen — scene mode "title", any time
 *
 * The camp phase machine is linear and reaches `free_roam` only once per cycle
 * (free_roam → activity_select → activity_resolve → bond_update → bond_summary
 * → sleep_lobby → sleeping → set_out_lobby), resetting when camp ends. The
 * three permitted phases are its idle moments — the ones that already expect
 * players to be clicking around.
 *
 * WHY THE SCENE MODE IS PART OF THE TEST
 * --------------------------------------
 * `campPhase` is a world setting whose DEFAULT is "free_roam", so outside camp
 * entirely it still reads free_roam. Gating on the phase alone would leave
 * spending open in the middle of a boss fight. The scene mode is what actually
 * says "we are at camp".
 *
 * This module is advisory on the client (it greys the window out) and
 * AUTHORITATIVE on the GM, which re-checks it when a request arrives — a window
 * left open when the party sets out must not be able to slip a write through.
 */

import { LEVELUP } from "./levelup-const.js";

const FABULA_FLAG = "oniFabula";

/** Scene mode for a scene, or "" when unset. */
export function sceneModeOf(scene) {
  const general = scene?.flags?.[LEVELUP.MODULE_ID]?.[FABULA_FLAG]?.general;
  return String(general?.sceneMode ?? "");
}

export const activeSceneMode = () => sceneModeOf(game.scenes?.active ?? null);

/** Camp phases during which spending is allowed. */
export const SPENDABLE_CAMP_PHASES = Object.freeze([
  "free_roam",
  "sleep_lobby",
  "set_out_lobby",
]);

function campPhase() {
  try {
    const CAMP = globalThis.CampSystem;
    if (CAMP?.State?.getPhase) return String(CAMP.State.getPhase() ?? "");
    return String(game.settings.get(LEVELUP.MODULE_ID, "campPhase") ?? "");
  } catch {
    return "";
  }
}

/**
 * May Skill Points be spent right now?
 * @returns {{ open:boolean, where:"camp"|"title"|null, reason:string, phase:string, mode:string }}
 */
export function gateState() {
  const mode = activeSceneMode();

  if (mode === "title") {
    return { open: true, where: "title", reason: "", phase: "", mode };
  }

  if (mode === "camp") {
    const phase = campPhase();
    if (SPENDABLE_CAMP_PHASES.includes(phase)) {
      return { open: true, where: "camp", reason: "", phase, mode };
    }
    return {
      open: false,
      where: null,
      phase,
      mode,
      reason: "Skill Points can be spent while resting at camp — not during an activity.",
    };
  }

  return {
    open: false,
    where: null,
    phase: "",
    mode,
    reason: "Skill Points can be spent while resting at camp, or from the title screen.",
  };
}

export const isOpen = () => gateState().open;
