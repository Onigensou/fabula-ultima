/* ========================================================================== *
 * ActionReader Core
 * -------------------------------------------------------------------------- *
 * Module-compatible shared helper library for the ActionReader pipeline.
 *
 * Suggested file path:
 *   scripts/action-reader/action-reader-core.js
 *
 * Usage in other module scripts:
 *   import { ActionReaderCore as AR } from "./action-reader-core.js";
 *
 * Optional registration:
 *   import { registerActionReaderCore } from "./action-reader-core.js";
 *   Hooks.once("ready", () => registerActionReaderCore("your-module-id"));
 * ========================================================================== */

export const ACTION_READER_SYSTEM_NAME = "ActionReader";
export const ACTION_READER_VERSION = "1.0.0";

export const DISPOSITIONS = Object.freeze({
  SECRET: -2,
  HOSTILE: -1,
  NEUTRAL: 0,
  FRIENDLY: 1,
  PLAYER_FRIENDLY: 2
});

export const SIDE_KEYS = Object.freeze({
  FRIENDLY: "friendly",
  HOSTILE: "hostile",
  NEUTRAL: "neutral",
  SECRET: "secret"
});

export const NUMBER_WORDS = Object.freeze({
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12
});

export const ACTION_READER_KEYS = Object.freeze({
  actorPropsPath: "system.props",
  itemPropsPath: "system.props",

  actionPatternTableKey: "action_pattern_table",
  actionPatternNameKey: "action_pattern_name",
  actionPatternConditionKey: "action_pattern_condition",
  actionPatternValue1Key: "action_pattern_value_1",
  actionPatternValue2Key: "action_pattern_value_2",
  actionPatternPriorityKey: "action_pattern_priority",
  actionPatternStringKey: "action_pattern_string",
  actionPatternDeletedKey: "$deleted",

  hpCurrent: "current_hp",
  hpMax: "max_hp",
  mpCurrent: "current_mp",
  mpMax: "max_mp",
  ipCurrent: "current_ip",
  ipMax: "max_ip",
  zeroCurrent: "zero_power_value",
  zeroMax: "max_zero",
  enmity: "enmity",

  skillType: "skill_type",
  skillTarget: "skill_target",
  isOffensiveSpell: "isOffensiveSpell"
});

export const ActionReaderCore = {
  systemName: ACTION_READER_SYSTEM_NAME,
  version: ACTION_READER_VERSION,
  dispositions: DISPOSITIONS,
  sideKeys: SIDE_KEYS,
  numberWords: NUMBER_WORDS,
  keys: ACTION_READER_KEYS,

  /* ---------------------------------------------------------------------- */
  /* Basic value helpers                                                    */
  /* ---------------------------------------------------------------------- */

  isNullish(value) {
    return value === null || value === undefined;
  },

  isBlank(value) {
    return this.isNullish(value) || String(value).trim() === "";
  },

  toString(value, fallback = "") {
    if (this.isNullish(value)) return fallback;
    return String(value);
  },

  toNumber(value, fallback = 0) {
    if (typeof value === "number" && Number.isFinite(value)) return value;

    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) return fallback;

      const parsed = Number(trimmed);
      return Number.isFinite(parsed) ? parsed : fallback;
    }

    return fallback;
  },

  toInteger(value, fallback = 0) {
    const parsed = this.toNumber(value, fallback);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
  },

  clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  },

  normalizeText(value) {
    return this.toString(value)
      .trim()
      .replace(/\s+/g, " ")
      .toLowerCase();
  },

  equalsNormalized(a, b) {
    return this.normalizeText(a) === this.normalizeText(b);
  },

  titleCase(value) {
    return this.toString(value)
      .toLowerCase()
      .replace(/\b\w/g, s => s.toUpperCase());
  },

  /* ---------------------------------------------------------------------- */
  /* Object / path helpers                                                  */
  /* ---------------------------------------------------------------------- */

  getPropertySafe(object, path, fallback = undefined) {
    if (!object || !path) return fallback;
    const value = foundry.utils.getProperty(object, path);
    return value === undefined ? fallback : value;
  },

  duplicateSafe(data) {
    try {
      return foundry.utils.deepClone(data);
    } catch (_err) {
      return data;
    }
  },

  objectValues(object) {
    if (!object || typeof object !== "object") return [];
    return Object.values(object);
  },

  sortNumericObjectEntries(object) {
    if (!object || typeof object !== "object") return [];

    return Object.entries(object).sort((a, b) => {
      const aNum = this.toInteger(a[0], 0);
      const bNum = this.toInteger(b[0], 0);
      return aNum - bNum;
    });
  },

  /* ---------------------------------------------------------------------- */
  /* Actor / item data helpers                                              */
  /* ---------------------------------------------------------------------- */

  getActorProps(actor) {
    return this.getPropertySafe(actor, this.keys.actorPropsPath, {}) ?? {};
  },

  getItemProps(item) {
    return this.getPropertySafe(item, this.keys.itemPropsPath, {}) ?? {};
  },

  getActorName(actor) {
    return actor?.name ?? "Unknown Actor";
  },

  getTokenName(token) {
    return token?.name ?? token?.document?.name ?? token?.actor?.name ?? "Unknown Token";
  },

  getItemDisplayName(item) {
    const props = this.getItemProps(item);
    return props?.name ?? item?.name ?? "Unnamed Action";
  },

  getActionPatternTable(actor) {
    const props = this.getActorProps(actor);
    return props?.[this.keys.actionPatternTableKey] ?? {};
  },

  getActionPatternRows(actor) {
    const table = this.getActionPatternTable(actor);

    return this.sortNumericObjectEntries(table).map(([rowKey, rowData]) => ({
      rowKey,
      rowIndex: this.toInteger(rowKey, 0),
      data: rowData ?? {}
    }));
  },

  getActorItems(actor) {
    return Array.from(actor?.items ?? []);
  },

  findActorItemByName(actor, targetName) {
    const normalizedTarget = this.normalizeText(targetName);
    if (!normalizedTarget) return null;

    for (const item of this.getActorItems(actor)) {
      const displayName = this.getItemDisplayName(item);

      if (
        this.equalsNormalized(displayName, normalizedTarget) ||
        this.equalsNormalized(item?.name, normalizedTarget)
      ) {
        return item;
      }
    }

    return null;
  },

  /* ---------------------------------------------------------------------- */
  /* Resource helpers                                                       */
  /* ---------------------------------------------------------------------- */

  getResourcePair(actor, currentKey, maxKey) {
    const props = this.getActorProps(actor);
    const current = this.toNumber(props?.[currentKey], 0);
    const max = this.toNumber(props?.[maxKey], 0);
    const percent = this.percentCeil(current, max);

    return { current, max, percent };
  },

  percentCeil(current, max) {
    const cur = this.toNumber(current, 0);
    const maximum = this.toNumber(max, 0);

    if (maximum <= 0) return 0;
    return Math.ceil((cur / maximum) * 100);
  },

  getStandardResources(actor) {
    return {
      hp: this.getResourcePair(actor, this.keys.hpCurrent, this.keys.hpMax),
      mp: this.getResourcePair(actor, this.keys.mpCurrent, this.keys.mpMax),
      ip: this.getResourcePair(actor, this.keys.ipCurrent, this.keys.ipMax),
      zero: this.getResourcePair(actor, this.keys.zeroCurrent, this.keys.zeroMax),
      resource1: this.getResourcePair(actor, "resource_value_1", "resource_maxValue_1"),
      resource2: this.getResourcePair(actor, "resource_value_2", "resource_maxValue_2"),
      resource3: this.getResourcePair(actor, "resource_value_3", "resource_maxValue_3")
    };
  },

  getActorEnmity(actor, fallback = 100) {
    const props = this.getActorProps(actor);
    const enmity = this.toNumber(props?.[this.keys.enmity], fallback);
    return Math.max(0, enmity);
  },

  /* ---------------------------------------------------------------------- */
  /* Effect helpers                                                         */
  /* ---------------------------------------------------------------------- */

  getActorEffects(actor) {
    return Array.from(actor?.effects ?? []);
  },

  getEffectNames(actor) {
    return this.getActorEffects(actor).map(effect => effect?.name ?? "");
  },

  actorHasEffectByName(actor, effectName) {
    const target = this.normalizeText(effectName);
    if (!target) return false;

    return this.getActorEffects(actor).some(effect =>
      this.equalsNormalized(effect?.name, target)
    );
  },

  /* ---------------------------------------------------------------------- */
  /* Combat / token / disposition helpers                                   */
  /* ---------------------------------------------------------------------- */

  getActiveCombat() {
    return game.combats?.active ?? game.combat ?? null;
  },

  getActiveCombatant(combat = this.getActiveCombat()) {
    return combat?.combatant ?? null;
  },

  getCombatRound(combat = this.getActiveCombat()) {
    return this.toInteger(combat?.round, 0);
  },

  getCombatTurnIndex(combat = this.getActiveCombat()) {
    return this.toInteger(combat?.turn, -1);
  },

  getTokenDocument(tokenLike) {
    if (!tokenLike) return null;
    return tokenLike?.document ?? tokenLike;
  },

  getTokenActor(tokenLike) {
    return tokenLike?.actor ?? tokenLike?.document?.actor ?? null;
  },

  getTokenDisposition(tokenLike) {
    const tokenDoc = this.getTokenDocument(tokenLike);
    const actor = this.getTokenActor(tokenLike);

    let disposition =
      tokenDoc?.disposition ??
      actor?.prototypeToken?.disposition ??
      DISPOSITIONS.SECRET;

    if (disposition === DISPOSITIONS.FRIENDLY && actor?.hasPlayerOwner) {
      disposition = DISPOSITIONS.PLAYER_FRIENDLY;
    }

    return disposition;
  },

  getCombatantDisposition(combatant) {
    if (!combatant) return DISPOSITIONS.SECRET;

    let disposition =
      combatant.getFlag?.("lancer-initiative", "disposition") ??
      combatant.token?.disposition ??
      combatant.actor?.prototypeToken?.disposition ??
      DISPOSITIONS.SECRET;

    if (disposition === DISPOSITIONS.FRIENDLY && combatant.hasPlayerOwner) {
      disposition = DISPOSITIONS.PLAYER_FRIENDLY;
    }

    return disposition;
  },

  getDispositionSide(disposition) {
    switch (disposition) {
      case DISPOSITIONS.FRIENDLY:
      case DISPOSITIONS.PLAYER_FRIENDLY:
        return SIDE_KEYS.FRIENDLY;

      case DISPOSITIONS.HOSTILE:
        return SIDE_KEYS.HOSTILE;

      case DISPOSITIONS.NEUTRAL:
        return SIDE_KEYS.NEUTRAL;

      default:
        return SIDE_KEYS.SECRET;
    }
  },

  isSameSide(dispositionA, dispositionB) {
    return this.getDispositionSide(dispositionA) === this.getDispositionSide(dispositionB);
  },

  isOpposingSide(dispositionA, dispositionB) {
    const sideA = this.getDispositionSide(dispositionA);
    const sideB = this.getDispositionSide(dispositionB);

    if (sideA === SIDE_KEYS.SECRET || sideB === SIDE_KEYS.SECRET) return false;
    if (sideA === SIDE_KEYS.NEUTRAL || sideB === SIDE_KEYS.NEUTRAL) return false;

    return sideA !== sideB;
  },

  /* ---------------------------------------------------------------------- */
  /* Count / text parsing helpers                                            */
  /* ---------------------------------------------------------------------- */

  parseNumberWordOrDigit(value) {
    if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);

    const normalized = this.normalizeText(value);
    if (!normalized) return null;

    if (/^\d+$/.test(normalized)) return Number(normalized);
    if (normalized in this.numberWords) return this.numberWords[normalized];

    return null;
  },

  parseLeadingCount(text) {
    const raw = this.normalizeText(text);
    if (!raw) return null;

    const stripped = raw.replace(/^up to\s+/, "");
    const firstWord = stripped.split(" ")[0];
    return this.parseNumberWordOrDigit(firstWord);
  },

  /* ---------------------------------------------------------------------- */
  /* Weighted random helpers                                                */
  /* ---------------------------------------------------------------------- */

  getWeight(value, fallback = 0) {
    return Math.max(0, this.toNumber(value, fallback));
  },

  weightedPick(entries, weightGetter) {
    const list = Array.isArray(entries) ? entries : [];
    if (!list.length) return null;

    const prepared = list
      .map(entry => {
        const weight = Math.max(0, this.toNumber(weightGetter(entry), 0));
        return { entry, weight };
      })
      .filter(x => x.weight > 0);

    if (!prepared.length) return null;

    const total = prepared.reduce((sum, x) => sum + x.weight, 0);
    let roll = Math.random() * total;

    for (const part of prepared) {
      roll -= part.weight;
      if (roll < 0) return part.entry;
    }

    return prepared.at(-1)?.entry ?? null;
  },

  weightedPickMany(entries, count, weightGetter) {
    const remaining = Array.isArray(entries) ? [...entries] : [];
    const wanted = Math.max(0, this.toInteger(count, 0));
    const results = [];

    while (remaining.length && results.length < wanted) {
      const chosen = this.weightedPick(remaining, weightGetter);
      if (!chosen) break;

      results.push(chosen);

      const index = remaining.indexOf(chosen);
      if (index >= 0) remaining.splice(index, 1);
    }

    return results;
  },

  randomFromArray(array) {
    const list = Array.isArray(array) ? array : [];
    if (!list.length) return null;

    const index = Math.floor(Math.random() * list.length);
    return list[index] ?? null;
  },

  /* ---------------------------------------------------------------------- */
  /* Action display helpers                                                 */
  /* ---------------------------------------------------------------------- */

  getActionTypeIcon(item) {
    const props = this.getItemProps(item);
    const skillType = this.normalizeText(props?.[this.keys.skillType]);
    const isOffensiveSpell = Boolean(props?.[this.keys.isOffensiveSpell]);

    if (skillType === "attack") return "⚔️";
    if (skillType === "active") return "💥";
    if (skillType === "spell" && isOffensiveSpell) return "⚡";
    if (skillType === "spell" && !isOffensiveSpell) return "📕";

    return "💥";
  },

  getActionTargetText(item) {
    const props = this.getItemProps(item);
    return this.toString(props?.[this.keys.skillTarget], "");
  },

  /* ---------------------------------------------------------------------- */
  /* ActionReader context helpers                                           */
  /* ---------------------------------------------------------------------- */

  createBaseContext() {
    return {
      ok: true,
      errors: [],
      warnings: [],
      debug: {
        stageReports: []
      },

      performer: null,
      combat: null,
      actorData: {},
      patternRows: [],
      evaluatedRows: [],
      actionCandidates: [],
      chosenAction: null,
      targetRule: null,
      targetCandidates: [],
      chosenTargets: [],
      finalText: ""
    };
  },

  addError(context, message, extra = {}) {
    if (!context) return;

    context.ok = false;
    context.errors ??= [];
    context.errors.push({
      message: this.toString(message, "Unknown error"),
      ...extra
    });
  },

  addWarning(context, message, extra = {}) {
    if (!context) return;

    context.warnings ??= [];
    context.warnings.push({
      message: this.toString(message, "Unknown warning"),
      ...extra
    });
  },

  addStageReport(context, stage, data = {}) {
    if (!context) return;

    context.debug ??= {};
    context.debug.stageReports ??= [];
    context.debug.stageReports.push({
      stage: this.toString(stage, "Unknown Stage"),
      data: this.duplicateSafe(data)
    });
  }
};

/* ------------------------------------------------------------------------ */
/* Optional module API registration                                         */
/* ------------------------------------------------------------------------ */

export function registerActionReaderCore(moduleId) {
  if (!moduleId || typeof moduleId !== "string") {
    console.warn("[ActionReader] registerActionReaderCore called without a valid moduleId.");
    return;
  }

  const module = game.modules.get(moduleId);
  if (!module) {
    console.warn(`[ActionReader] Could not find module "${moduleId}" while registering Core.`);
    return;
  }

  module.api ??= {};
  module.api.ActionReader ??= {};
  module.api.ActionReader.Core = ActionReaderCore;

  console.log(`[ActionReader] Core registered to module API for "${moduleId}".`);
}
