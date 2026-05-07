// auto-untarget.js
// Foundry V12
// Drop into your module and load it from module.json.
//
// Default module id below is set for Fabula Ultima Companion.
// Change MODULE_ID only if you are putting this into a different module.

(() => {
  const MODULE_ID = "fabula-ultima-companion";
  const FEATURE_ID = "auto-untarget";

  const SETTINGS = {
    TURN: "autoUntargetOnTurnChange",
    ROUND: "autoUntargetOnRoundChange",
    START: "autoUntargetOnCombatStart",
    END: "autoUntargetOnCombatEnd",
    AFFECT_GM: "autoUntargetAffectsGM",
    DEBUG: "autoUntargetDebug"
  };

  let lastClearKey = "";
  let lastClearAt = 0;

  function debug(...args) {
    try {
      if (!game.settings.get(MODULE_ID, SETTINGS.DEBUG)) return;
      console.log(`[${MODULE_ID}] [${FEATURE_ID}]`, ...args);
    } catch (_err) {
      // Ignore debug failures during early init.
    }
  }

  function registerSettings() {
    game.settings.register(MODULE_ID, SETTINGS.TURN, {
      name: "Auto Untarget: Clear on Turn Change",
      hint: "Clear this user's current token targets whenever the combat turn changes.",
      scope: "world",
      config: true,
      type: Boolean,
      default: true
    });

    game.settings.register(MODULE_ID, SETTINGS.ROUND, {
      name: "Auto Untarget: Clear on Round Change",
      hint: "Clear this user's current token targets whenever the combat round changes.",
      scope: "world",
      config: true,
      type: Boolean,
      default: true
    });

    game.settings.register(MODULE_ID, SETTINGS.START, {
      name: "Auto Untarget: Clear on Combat Start",
      hint: "Clear this user's current token targets when combat starts.",
      scope: "world",
      config: true,
      type: Boolean,
      default: true
    });

    game.settings.register(MODULE_ID, SETTINGS.END, {
      name: "Auto Untarget: Clear on Combat End",
      hint: "Clear this user's current token targets when combat ends or is deleted.",
      scope: "world",
      config: true,
      type: Boolean,
      default: true
    });

    game.settings.register(MODULE_ID, SETTINGS.AFFECT_GM, {
      name: "Auto Untarget: Affect GM Too",
      hint: "When enabled, the GM's own targets are also auto-cleared.",
      scope: "world",
      config: true,
      type: Boolean,
      default: true
    });

    game.settings.register(MODULE_ID, SETTINGS.DEBUG, {
      name: "Auto Untarget: Debug Logging",
      hint: "Log auto-untarget activity to the browser console.",
      scope: "client",
      config: true,
      type: Boolean,
      default: false
    });
  }

  function getViewedSceneId() {
    return canvas?.scene?.id ?? game.user?.viewedScene ?? null;
  }

  function getCombatSceneId(combat) {
    if (!combat) return null;
    return combat.scene?.id ?? combat.sceneId ?? combat.scene ?? null;
  }

  function isRelevantCombat(combat) {
    if (!combat) return false;
    if (!canvas?.ready) return false;

    const combatSceneId = getCombatSceneId(combat);
    const viewedSceneId = getViewedSceneId();

    // If either side is missing, do not block the clear.
    if (!combatSceneId || !viewedSceneId) return true;

    // Only clear for combats on the scene this client is currently viewing.
    return combatSceneId === viewedSceneId;
  }

  function isEnabledForThisUser() {
    if (!game.user) return false;
    if (game.user.isGM && !game.settings.get(MODULE_ID, SETTINGS.AFFECT_GM)) return false;
    return true;
  }

  function hasTargets() {
    return (game.user?.targets?.size ?? 0) > 0;
  }

  function buildDedupeKey(reason, combat) {
    return [
      reason,
      combat?.id ?? "no-combat",
      combat?.round ?? "no-round",
      combat?.turn ?? "no-turn"
    ].join("|");
  }

  function isDuplicate(reason, combat) {
    const key = buildDedupeKey(reason, combat);
    const now = Date.now();

    // Prevent double-clears when multiple hooks fire for the same transition.
    if (key === lastClearKey && (now - lastClearAt) < 200) return true;

    lastClearKey = key;
    lastClearAt = now;
    return false;
  }

  function clearLocalTargets(reason, combat = game.combat) {
    try {
      if (!isEnabledForThisUser()) return;
      if (!isRelevantCombat(combat)) return;
      if (!hasTargets()) return;
      if (isDuplicate(reason, combat)) return;

      const before = Array.from(game.user.targets?.ids ?? []);

      // Clear this user's targets locally.
      game.user.updateTokenTargets([]);

      // Also broadcast the empty target list so other clients immediately
      // stop seeing this user's target rings/arrows.
      game.user.broadcastActivity({ targets: [] });

      debug(`Cleared ${before.length} target(s).`, {
        reason,
        combatId: combat?.id,
        round: combat?.round,
        turn: combat?.turn,
        before
      });
    } catch (err) {
      console.error(`[${MODULE_ID}] [${FEATURE_ID}] Failed to clear targets on "${reason}"`, err);
    }
  }

  function onCombatTurnChange(combat, prior, current) {
    if (!game.settings.get(MODULE_ID, SETTINGS.TURN)) return;
    clearLocalTargets("combatTurnChange", combat);
  }

  function onCombatRound(combat, updateData, updateOptions) {
    if (!game.settings.get(MODULE_ID, SETTINGS.ROUND)) return;
    clearLocalTargets("combatRound", combat);
  }

  function onUpdateCombat(combat, changed, options, userId) {
    if (!combat) return;
    if (!isRelevantCombat(combat)) return;

    // Start combat
    if (changed.started === true) {
      if (game.settings.get(MODULE_ID, SETTINGS.START)) {
        clearLocalTargets("combatStart", combat);
      }
      return;
    }

    // Stop combat (fallback path)
    if (changed.started === false || changed.active === false) {
      if (game.settings.get(MODULE_ID, SETTINGS.END)) {
        clearLocalTargets("combatStop", combat);
      }
      return;
    }

    // Fallback for modules that only drive turn/round through updateCombat.
    if ("turn" in changed) {
      if (game.settings.get(MODULE_ID, SETTINGS.TURN)) {
        clearLocalTargets("updateCombatTurnFallback", combat);
      }
      return;
    }

    if ("round" in changed) {
      if (game.settings.get(MODULE_ID, SETTINGS.ROUND)) {
        clearLocalTargets("updateCombatRoundFallback", combat);
      }
    }
  }

  function onDeleteCombat(combat) {
    if (!game.settings.get(MODULE_ID, SETTINGS.END)) return;
    clearLocalTargets("deleteCombat", combat);
  }

  function exposeApi() {
    const mod = game.modules.get(MODULE_ID);
    if (!mod) return;

    mod.api ??= {};
    mod.api.autoUntarget = {
      clearNow: () => clearLocalTargets("manual", game.combat)
    };
  }

  Hooks.once("init", () => {
    registerSettings();
  });

  Hooks.once("ready", () => {
    Hooks.on("combatTurnChange", onCombatTurnChange);
    Hooks.on("combatRound", onCombatRound);
    Hooks.on("updateCombat", onUpdateCombat);
    Hooks.on("deleteCombat", onDeleteCombat);

    exposeApi();
    debug("Ready.");
  });
})();