/**
 * [ONI] Event System — Start Minigame
 * Foundry VTT v12
 *
 * File:
 * scripts/event-system/event-rows-minigame.js
 *
 * What this does:
 * - Registers the "Start Minigame" event action: every connected client opens
 *   the minigame (Multiplayer scene mode) and the event waits, with no time
 *   limit, until the GM leaves the results screen. The rows after it run then.
 * - Each player runs their own party character; absent members are CPUs.
 * - "Rewards switch" makes the first clear pay and every later run a replay:
 *   while the switch is OFF the run pays its rewards (Plasma Field: Hako
 *   Coupons 10/8/5/2 and Fabula Points 4/3/2/1 by place) and turns the switch
 *   ON when the results are shown. While it is ON the run is a replay: a time
 *   limit, no rewards, "Just for fun" on the results.
 *
 * Requires:
 * - event-logic.js, event-eventRegistry.js, event-flow.js
 * - scripts/minigame-system/mg-boot.js (FUCompanion.api.minigame, looked up when used)
 */

(() => {
  const INSTALL_TAG = "[ONI][EventSystem][RowsMinigame]";

  window.oni = window.oni || {};
  window.oni.EventSystem = window.oni.EventSystem || {};

  if (window.oni.EventSystem.RowsMinigame?.installed) return;

  const Logic = window.oni.EventSystem.Logic;
  const EventRegistry = window.oni.EventSystem.EventRegistry;
  if (!Logic || !EventRegistry) {
    console.error(INSTALL_TAG, "Missing Logic or EventRegistry. Check load order.");
    return;
  }

  const flow = () => window.oni.EventSystem.Flow;
  const api = () => globalThis.FUCompanion?.api?.minigame;
  const GAMES = [["plasma-field", "Plasma Field Dash"]];

  function prepare(row) {
    row.game = GAMES.some(([k]) => k === row.game) ? row.game : GAMES[0][0];
    row.intro = row.intro === "none" ? "none" : "full";
    row.rewardSwitch = String(row.rewardSwitch ?? "").trim();
  }

  EventRegistry.register({
    type: "startMinigame",
    label: "Start Minigame",
    category: "Flow",
    defaultData: { type: "startMinigame", game: "plasma-field", intro: "full", rewardSwitch: "PlasmaFieldCleared" },
    prepare,
    summary: (row) => {
      const name = GAMES.find(([k]) => k === row?.game)?.[1] ?? row?.game ?? "";
      return `${name}${row?.intro === "none" ? " (no opening)" : ""}${row?.rewardSwitch ? ` · rewards until ${row.rewardSwitch}` : ""}`;
    },
    execute: async (row, context) => {
      const f = flow();
      const id = String(context?.tileId || "");
      const mg = api();
      if (!mg?.run) return { ok: false, type: "startMinigame", reason: "noMinigameSystem" };

      const GS = window.oni?.GameState;
      const sw = String(row?.rewardSwitch ?? "").trim();
      const cleared = sw ? !!GS?.getSwitch?.(sw) : false;

      if (id) f?.hold?.(id);
      let offAbort = null;
      let result = null;
      try {
        // ending the event from the GM chip closes the field for everyone
        offAbort = id ? f?.onAbort?.(id, () => mg.leave()) : null;
        result = await mg.run({ game: row?.game || "plasma-field", intro: row?.intro === "none" ? "none" : "full", firstClear: !!sw && !cleared, replay: cleared });
      } catch (e) {
        console.error(INSTALL_TAG, e);
        ui.notifications?.error?.(`Start Minigame: ${e.message}`);
        return { ok: false, type: "startMinigame", reason: "threw", stop: true };
      } finally {
        offAbort?.();
        if (id) f?.release?.(id);
      }

      if (id && f?.isAborted?.(id)) return { ok: true, type: "startMinigame", aborted: true };
      const finished = Array.isArray(result?.ranking);
      if (finished && sw && !cleared) { try { await GS?.setSwitch?.(sw, true); } catch (e) { console.warn(INSTALL_TAG, e); } }
      return { ok: true, type: "startMinigame", finished, replay: cleared };
    },
    buildFields: (row, kit) => kit.fields(
      kit.field(
        "Minigame",
        `<select class="oni-event-row-mg-game">${GAMES.map(([k, n]) => `<option value="${k}" ${row.game === k ? "selected" : ""}>${kit.escapeHTML(n)}</option>`).join("")}</select>`,
        "Opens on every connected client. Each player runs their own party character; absent members are CPUs."
      ),
      kit.field(
        "Opening",
        `<select class="oni-event-row-mg-intro">
           <option value="full" ${row.intro !== "none" ? "selected" : ""}>Full opening (camera pan over the field)</option>
           <option value="none" ${row.intro === "none" ? "selected" : ""}>None (straight to practice)</option>
         </select>`,
        "Use None for replays, after a short Camera Pan of your own."
      ),
      kit.field(
        "Rewards switch",
        `<input type="text" class="oni-event-row-mg-switch" value="${kit.escapeHTML(row.rewardSwitch ?? "")}" placeholder="PlasmaFieldCleared" />`,
        "While this switch is OFF, the run pays its first-clear rewards and turns it ON. While it is ON, the run is a replay: time limit, no rewards. Leave empty for never-paying runs."
      )
    ),
    collectFields: (rowEl, kit) => ({
      game: kit.readText(rowEl, ".oni-event-row-mg-game", "plasma-field"),
      intro: kit.readText(rowEl, ".oni-event-row-mg-intro", "full"),
      rewardSwitch: kit.readText(rowEl, ".oni-event-row-mg-switch", "").trim()
    })
  });

  window.oni.EventSystem.RowsMinigame = { installed: true };
})();
