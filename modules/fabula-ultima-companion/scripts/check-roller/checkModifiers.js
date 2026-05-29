/**
 * ONI — Check Modifier Resolver
 *
 * Single source of truth for reading check-modifier actor props and returning
 * [{label, value}] modifier parts ready to inject into any check system.
 *
 * Convention on actor (actor.system.props):
 *   check_mod_all        → flat bonus applied to every check
 *   check_mod_<context>  → flat bonus applied only when context key matches
 *                          e.g. check_mod_stealth, check_mod_arcana
 *
 * Zero-value entries are omitted so the modifier list stays clean.
 *
 * Exposed as:
 *   ONI.CheckModifiers.resolve(actor, context?)   — always available
 *   FUCompanion.api.checkModifiers.resolve(...)   — available after "ready" (for macros)
 */

(() => {
  const ROOT = globalThis;
  ROOT.ONI = ROOT.ONI || {};

  const TAG = "[ONI][CheckModifiers]";

  const safeNum = (v) => {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  /**
   * Resolve actor check modifier parts for the given context.
   *
   * @param {Actor|null} actor   - Foundry Actor document
   * @param {string|null} context - Context key, e.g. "stealth". null → "all" only.
   * @returns {{label: string, value: number}[]}
   */
  function resolve(actor, context = null) {
    const props = actor?.system?.props ?? {};
    const parts = [];

    const all = safeNum(props.check_mod_all);
    if (all !== 0) parts.push({ label: "Check Bonus", value: all });

    if (context) {
      const key = `check_mod_${String(context).toLowerCase()}`;
      if (key !== "check_mod_all") {
        const ctxVal = safeNum(props[key]);
        if (ctxVal !== 0) {
          const label = `Check Bonus (${String(context).charAt(0).toUpperCase()}${String(context).slice(1)})`;
          parts.push({ label, value: ctxVal });
        }
      }
    }

    return parts;
  }

  ROOT.ONI.CheckModifiers = { resolve };

  Hooks.once("ready", () => {
    try {
      const api = game.modules.get("fabula-ultima-companion")?.api;
      if (api) api.checkModifiers = { resolve };
    } catch (e) {
      console.warn(TAG, "Could not register on FUCompanion.api:", e);
    }
    console.debug(TAG, "Ready.");
  });
})();
