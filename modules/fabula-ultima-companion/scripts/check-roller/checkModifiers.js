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
 * And on actor FLAGS (`flags["fabula-ultima-companion"]`):
 *   check_mod_<attr>     → flat bonus applied whenever the check ROLLS that
 *                          attribute's die — mig / dex / ins / wlp. Scoped by
 *                          the dice being rolled rather than by what the check
 *                          is FOR, which is how the books word it ("+1 to all
 *                          checks that require the 【MIG】 die"). Callers pass
 *                          the rolled pair as `attributes`.
 *
 * ⚠ The attribute family lives on FLAGS, not props, and that split is
 * deliberate — it is NOT an inconsistency to "fix". Every prop-homed modifier
 * above is a field DECLARED on the CSB actor template; `check_mod_mig` is not,
 * and CSB never materialises an AE that targets an undeclared prop, so the
 * prop form applies cleanly and does nothing (measured 2026-08-08: Cow
 * Headband's +1 read as undefined on a real templated PC). Same reasoning that
 * puts `skill_level_bonus_*` on flags. Declaring four more template fields was
 * the alternative and costs template surgery on every actor template; a flag
 * costs nothing and works on all of them.
 *
 * Zero-value entries are omitted so the modifier list stays clean.
 *
 * Exposed as:
 *   ONI.CheckModifiers.resolve(actor, context?, opts?)  — always available
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

  // The four attribute dice. Only these are read as `attributes`, so a caller
  // that forwards a junk/blank attr can't conjure a `check_mod_<anything>` key.
  const ATTRS = new Set(["mig", "dex", "ins", "wlp"]);
  const MODULE_ID = "fabula-ultima-companion";

  // Attribute-scoped bonuses are flag-homed (see the header note).
  function attrBonus(actor, attr) {
    return safeNum(actor?.flags?.[MODULE_ID]?.[`check_mod_${attr}`]);
  }

  /**
   * Resolve actor check modifier parts for the given context.
   *
   * @param {Actor|null} actor    - Foundry Actor document
   * @param {string|null} context - Context key, e.g. "stealth". null → "all" only.
   * @param {object} [opts]
   * @param {string[]} [opts.attributes] - The attribute dice this check rolls
   *        (e.g. ["DEX","INS"]). Case-insensitive; non-attributes are ignored.
   *        Duplicates collapse, so a single-attribute check (MIG+MIG) or one
   *        that re-states the context still adds its bonus exactly once.
   * @returns {{label: string, value: number}[]}
   */
  function resolve(actor, context = null, { attributes = null } = {}) {
    const props = actor?.system?.props ?? {};
    const parts = [];

    const all = safeNum(props.check_mod_all);
    if (all !== 0) parts.push({ label: "Check Bonus", value: all });

    // One key is read at most once. `check_mod_all` is seeded as spent above,
    // and the context is seeded before the attributes so a check whose context
    // IS an attribute name doesn't count that prop twice.
    const spent = new Set(["check_mod_all"]);

    if (context) {
      const key = `check_mod_${String(context).toLowerCase()}`;
      if (!spent.has(key)) {
        spent.add(key);
        const ctxVal = safeNum(props[key]);
        if (ctxVal !== 0) {
          const label = `Check Bonus (${String(context).charAt(0).toUpperCase()}${String(context).slice(1)})`;
          parts.push({ label, value: ctxVal });
        }
      }
    }

    for (const raw of attributes ?? []) {
      const attr = String(raw ?? "").trim().toLowerCase();
      if (!ATTRS.has(attr)) continue;
      const key = `check_mod_${attr}`;
      if (spent.has(key)) continue;
      spent.add(key);
      const val = attrBonus(actor, attr);
      if (val !== 0) parts.push({ label: `Check Bonus (${attr.toUpperCase()})`, value: val });
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
