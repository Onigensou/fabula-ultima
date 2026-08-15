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
  isOffensiveSpell: "isOffensiveSpell",

  // Action-economy / targeting intelligence (added for AI upgrade)
  typeDamage: "type_damage",
  defenseTargetType: "defense_target_type",
  cost: "cost",
  defenseValue: "defense",
  magicDefenseValue: "magic_defense",

  // New optional pattern-row columns (blank => legacy behavior)
  actionPatternWeightKey: "action_pattern_weight",
  actionPatternCooldownKey: "action_pattern_cooldown",
  actionPatternTargetFocusKey: "action_pattern_target_focus",
  // Min current-HP required to pick this row — a self-cost safety reserve so a
  // move that pays HP (Geist's Shadow Strike / Shadowbringers) is never picked
  // when it could KO the performer. Blank / 0 => no HP guard (legacy).
  actionPatternHpReserveKey: "action_pattern_hp_reserve",

  // Optional per-row max HP % (inclusive) a performer may have to pick the row —
  // the mirror of hpReserve: a "only when hurt" ceiling. Row is dropped when the
  // performer's HP% is ABOVE it. Blank / 0 => no ceiling (legacy, never blocks).
  actionPatternHpCeilingKey: "action_pattern_hp_ceiling"
});

/* Foundry module id (used for effect-charge stack flags + combatant memory). */
export const FU_MODULE_ID = "fabula-ultima-companion";

/* Stack count for a status lives at flags.<module>.charges on the ActiveEffect. */
export const EFFECT_CHARGES_FLAG = "charges";

/*
 * Damage-type affinity order. The NPC sheet stores affinities as
 * affinity_1 .. affinity_9; this is the fixed element order they map to.
 * Values: "NA" (normal), "RS" (resist), "VU" (vulnerable), "IM" (immune),
 * "AB" (absorb). Verified live against Fire Slime (fire=AB, ice=VU, poison=IM).
 */
export const AFFINITY_ELEMENTS = Object.freeze([
  "physical", "air", "bolt", "dark", "earth", "fire", "ice", "light", "poison"
]);

/* Common spellings/synonyms normalized onto the canonical element keys above. */
export const DAMAGE_TYPE_ALIASES = Object.freeze({
  physical: "physical",
  phys: "physical",
  air: "air",
  wind: "air",
  bolt: "bolt",
  lightning: "bolt",
  thunder: "bolt",
  dark: "dark",
  shadow: "dark",
  earth: "earth",
  fire: "fire",
  ice: "ice",
  cold: "ice",
  light: "light",
  holy: "light",
  poison: "poison"
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
  /* Damage type / affinity / defense helpers (AI targeting)                */
  /* ---------------------------------------------------------------------- */

  normalizeDamageType(value) {
    const normalized = this.normalizeText(value);
    if (!normalized) return "";
    return DAMAGE_TYPE_ALIASES[normalized] ?? normalized;
  },

  /* Returns { physical:"NA", air:"NA", ... } for an actor. */
  getActorAffinityMap(actor) {
    const props = this.getActorProps(actor);
    const map = {};

    for (let i = 0; i < AFFINITY_ELEMENTS.length; i++) {
      const element = AFFINITY_ELEMENTS[i];
      const raw = this.toString(props?.[`affinity_${i + 1}`], "NA").trim().toUpperCase();
      map[element] = raw || "NA";
    }

    return map;
  },

  /* Affinity code ("NA"/"RS"/"VU"/"IM"/"AB") of an actor toward a damage type. */
  getAffinityForType(actor, damageType) {
    const element = this.normalizeDamageType(damageType);
    if (!element) return "NA";

    const map = this.getActorAffinityMap(actor);
    return map[element] ?? "NA";
  },

  /* Reads the damage type ("fire", "ice", ...) declared on an action item. */
  getItemDamageType(itemOrProps) {
    const props = itemOrProps?.system?.props
      ? this.getItemProps(itemOrProps)
      : (itemOrProps ?? {});
    return this.normalizeDamageType(props?.[this.keys.typeDamage]);
  },

  /* Which defense an action targets: "def" (physical) or "mdef" (magic). */
  getItemDefenseTarget(itemOrProps) {
    const props = itemOrProps?.system?.props
      ? this.getItemProps(itemOrProps)
      : (itemOrProps ?? {});
    const raw = this.normalizeText(props?.[this.keys.defenseTargetType]);
    return raw === "mdef" ? "mdef" : (raw === "def" ? "def" : "");
  },

  getActorDefenses(actor) {
    const props = this.getActorProps(actor);
    return {
      def: this.toNumber(props?.[this.keys.defenseValue], 0),
      mdef: this.toNumber(props?.[this.keys.magicDefenseValue], 0)
    };
  },

  /*
   * Stack count of a named status on an actor.
   *   0   => not present
   *   1   => present, no explicit charge count
   *   N   => flags.<module>.charges value
   */
  getEffectStackCount(actor, statusName) {
    const target = this.normalizeText(statusName);
    if (!target) return 0;

    for (const effect of this.getActorEffects(actor)) {
      if (!this.equalsNormalized(effect?.name, target)) continue;

      let charges;
      try {
        charges = effect.getFlag?.(FU_MODULE_ID, EFFECT_CHARGES_FLAG);
      } catch (_e) {
        charges = undefined;
      }
      if (charges === undefined || charges === null) {
        charges = effect?.flags?.[FU_MODULE_ID]?.[EFFECT_CHARGES_FLAG];
      }

      const count = this.toInteger(charges, NaN);
      return Number.isFinite(count) && count > 0 ? count : 1;
    }

    return 0;
  },

  /* ---------------------------------------------------------------------- */
  /* Action cost parsing (feasibility)                                      */
  /* ---------------------------------------------------------------------- */

  /*
   * Parse an action's cost string into a structured form.
   * Examples: "20 MP", "10 MP", "30 x T MP", "-", "" , "5 IP".
   * Returns { free, amount, resource, perTarget, raw }.
   *   - free=true for "-" / blank / 0 (no resource cost).
   *   - resource is "mp" | "ip" | "zenit" | "" (unknown).
   *   - perTarget=true when the cost scales with target count ("x T").
   */
  parseActionCost(costText) {
    const raw = this.toString(costText, "").trim();
    const normalized = this.normalizeText(raw);

    if (!normalized || normalized === "-" || normalized === "0") {
      return { free: true, amount: 0, resource: "", perTarget: false, raw };
    }

    const perTarget = /x\s*t\b/.test(normalized) || /per target/.test(normalized);

    let resource = "";
    if (/\bmp\b/.test(normalized)) resource = "mp";
    else if (/\bip\b/.test(normalized)) resource = "ip";
    else if (/zenit|\bz\b/.test(normalized)) resource = "zenit";

    const numberMatch = normalized.match(/\d+/);
    const amount = numberMatch ? Number(numberMatch[0]) : 0;

    if (amount <= 0) {
      return { free: true, amount: 0, resource, perTarget, raw };
    }

    return { free: false, amount, resource, perTarget, raw };
  },

  /* ---------------------------------------------------------------------- */
  /* Lightweight target-existence pre-check (feasibility)                   */
  /* ---------------------------------------------------------------------- */

  /* Coarse relation keyword from a skill_target string (for pre-filtering). */
  quickTargetRelation(text) {
    const t = this.normalizeText(text);
    if (!t) return "";
    if (t === "self" || /\bself\b/.test(t)) return "self";
    if (/\ball(y|ies)\b/.test(t)) return "ally";
    if (/\benem(y|ies)\b/.test(t)) return "enemy";
    if (/\bneutral/.test(t)) return "neutral";
    if (/\bsecret/.test(t)) return "secret";
    if (/\bcreatures?\b/.test(t)) return "creature";
    return "";
  },

  /* Relation of a candidate disposition toward the performer disposition. */
  relationToPerformer(candidateDisposition, performerDisposition) {
    if (this.isSameSide(candidateDisposition, performerDisposition)) return "ally";
    if (this.isOpposingSide(candidateDisposition, performerDisposition)) return "enemy";

    const side = this.getDispositionSide(candidateDisposition);
    if (side === this.sideKeys.NEUTRAL) return "neutral";
    if (side === this.sideKeys.SECRET) return "secret";
    return "other";
  },

  /* A creature declaring `cannot_be_targeted_by: "any"` can never be targeted,
     hit or counted — the same exclusion snapshot.js and skill-targeting.js apply
     on their own pools. ActionReader keeps its OWN pool off
     canvas.tokens.placeables, so it has to honour the rule itself: otherwise an
     autopiloted monster picks such a creature as its target, and its presence
     inflates every pattern's ENEMY_COUNT. It still ACTS (its own targeting
     resolves normally) — only its presence as somebody ELSE's candidate is gone.

     This reads the AE contract directly rather than importing snapshot.js:
     ActionReader is a standalone subsystem with zero imports by design, and
     coupling it to the Battle Director for six lines would be the wrong trade.
     The CONTRACT is shared (an AE change key), not the code. Canonical reader +
     the range grammar: `getTargetSideBlocks` / `hasUnconditionalTargetBlock` in
     battle-director/snapshot.js — keep the two in step. */
  isUntargetableActor(actor) {
    const effects = actor?.effects?.contents ?? actor?.effects ?? [];
    for (const ae of effects) {
      if (ae?.disabled) continue;
      for (const ch of (ae?.changes ?? [])) {
        if (ch?.key !== "cannot_be_targeted_by") continue;
        const raw = String(ch.value ?? "").trim().toLowerCase();
        if (raw.split(/[\s,]+/).includes("any")) return true;
      }
    }
    return false;
  },

  isUntargetableToken(tokenLike) {
    return this.isUntargetableActor(this.getTokenActor(tokenLike));
  },

  /* The token ids that can actually PARTICIPATE, or null when there is no roster
     to scope by (out of combat).

     `scope` is deliberately permissive — it accepts any of:
       • an ActionReader context   (the normal case; reads `context.participants`)
       • an injected roster        `{ tokenIds: [...] }`
       • a combat-like            `{ combatants: [...] }` (Foundry Combat)
       • null / undefined         (look for a Foundry Combat, else no roster)

     WHO IS IN THE BATTLE IS NOT ACTIONREADER'S TO DECIDE. The Battle Director
     runs its own `dCombat` and creates no Foundry Combat document at all, so
     `game.combats.active` is null for an entire BD battle. An earlier fix that
     scoped to "the active combat" was therefore inert, and every count silently
     fell back to `canvas.tokens.placeables` — every token standing on the map,
     including scenery, a previous encounter's leftovers and test fixtures.

     Measured 2026-08-15: a guest on the Training Ground chose an ALL-ENEMY skill
     because `enemy_count` saw the standing rig (4) instead of the one Hellhound
     she was fighting, then hit 4 bystanders with it. The count and the targeting
     agreed with each other and both disagreed with the battle.

     So the owner of the battle INJECTS its roster (`context.participants`) and
     ActionReader honours it. That keeps the zero-import rule intact — the
     contract is a plain list of token ids, not a BD type — while making the one
     thing ActionReader cannot know come from the thing that does know it. */
  participantScopeTokenIds(scope = null) {
    const injected = scope?.participants ?? (Array.isArray(scope?.tokenIds) ? scope : null);
    if (Array.isArray(injected?.tokenIds)) {
      const ids = new Set(injected.tokenIds.filter(Boolean));
      return ids.size ? ids : null;
    }

    /* Nobody threaded a roster — ask the ambient battle provider. This is what
       makes the rule un-forgettable: an entry point that does not know about any
       of this still gets the battle's roster instead of the whole scene. */
    const ambient = this.battleProvider()?.participantTokenIds?.();
    if (Array.isArray(ambient) && ambient.length) {
      return new Set(ambient.filter(Boolean));
    }

    /* A Foundry Combat, when one genuinely exists (manual-attach play, or
       ActionReader driven outside the director). Defeat is filtered here for the
       same reason it is filtered by the injector: a corpse is not a participant,
       and ActionReader had no notion of defeat at all — so a dead combatant
       counted toward enemy_count and stayed a legal target. */
    const combat = Array.isArray(scope?.combatants) || scope?.combatants?.size
      ? scope
      : (scope?.combat?.combat ?? scope?.actorData?.combat?.combat ?? this.getActiveCombat());
    if (!combat) return null;

    const ids = new Set();
    for (const c of (combat.combatants ?? [])) {
      const tid = c?.tokenId ?? c?.token?.id ?? null;
      if (!tid) continue;
      if (this.isDefeatedParticipant(c, c?.actor ?? c?.token?.actor ?? null)) continue;
      ids.add(tid);
    }
    return ids.size ? ids : null;
  },

  /* The tokens that can actually PARTICIPATE — the pool every count and every
     target pick must share. See participantScopeTokenIds for the scope contract.

     Out of combat there is no roster, so the whole scene is the pool — that is
     the pre-combat/exploration case and is unchanged. If scoping would somehow
     empty the pool, fall back rather than blank it: a wrong count degrades a
     decision, an empty pool makes every skill read as infeasible and the
     creature stands there doing nothing. */
  participantTokens(scope = null) {
    const all = Array.from(canvas?.tokens?.placeables ?? []);
    const ids = this.participantScopeTokenIds(scope);
    if (!ids) return all;

    const scoped = all.filter((tok) => {
      const id = this.getTokenDocument(tok)?.id ?? null;
      return Boolean(id) && ids.has(id);
    });
    if (scoped.length) return scoped;
    /* The roster named creatures that are not on this canvas — almost always the
       wrong scene being active, a known hazard here. Widening back to the scene
       keeps the actor acting, but SILENTLY doing so restores the exact bug this
       function exists to prevent, so it is announced. */
    console.warn("[ActionReader] participant roster matched no token on this canvas "
      + `(roster ${ids.size}, canvas ${all.length}) — falling back to the whole scene. `
      + "Counts and targeting will include non-combatants. Wrong active scene?");
    return all;
  },

  /* Defeat, read without importing the director: the Foundry combatant flag
     first (what the defeat reactor stamps), then an HP<=0 fallback so the answer
     is right even before the reactor has run. */
  isDefeatedParticipant(combatant, actor) {
    if (combatant?.isDefeated === true) return true;
    if (combatant?.defeated === true) return true;
    const props = this.getActorProps(actor);
    const cur = Number(props?.[this.keys.hpCurrent]);
    const max = Number(props?.[this.keys.hpMax]);
    // Only treat 0 as defeat when the actor actually HAS an HP track; a doc with
    // no max_hp reads cur=NaN and must not be silently dropped from the pool.
    if (Number.isFinite(cur) && Number.isFinite(max) && max > 0 && cur <= 0) return true;
    return false;
  },

  /* Count participants matching a target relation relative to a performer.

     This is the SIDE head-count — "how many enemies are in this battle". It is
     NOT the same question as "how many can THIS action target": an action's
     `skill_target` picks a side, a count and a mode, and its own declared
     filters narrow further. For that, ask the target survey (the BD injects it
     as `context.targetSurvey`); this stays the cheap disposition count that the
     `enemy_count` / `ally_count` pattern conditions are defined in terms of.

     `scope` is the participantTokens contract — pass the ActionReader context. */
  countSceneTargetsForRelation(performerActor, performerTokenDoc, relation, scope = null) {
    const tokens = this.participantTokens(scope);
    const performerDisposition = this.getTokenDisposition(performerTokenDoc);
    const performerId = performerTokenDoc?.id ?? null;

    let count = 0;

    for (const tok of tokens) {
      const actor = this.getTokenActor(tok);
      if (!actor) continue;

      const tokenDoc = this.getTokenDocument(tok);
      const isSelf = Boolean(performerId && tokenDoc?.id === performerId);
      // Uncounted on every side — but NEVER hide a guest from ITSELF. "Nobody may
      // target the guest" is about other creatures; applied to the performer it
      // would make relation "self" count 0, and feasibility would silently drop
      // any Self-targeted skill a guest ever gets.
      if (!isSelf && this.isUntargetableActor(actor)) continue;
      const rel = this.relationToPerformer(this.getTokenDisposition(tokenDoc), performerDisposition);

      switch (relation) {
        case "self": if (isSelf) count++; break;
        case "ally": if (rel === "ally") count++; break;
        case "enemy":
        case "creature": if (rel === "enemy") count++; break;
        case "neutral": if (rel === "neutral") count++; break;
        case "secret": if (rel === "secret") count++; break;
        default: count++; break; // unknown relation => assume targetable
      }
    }

    return count;
  },

  /* ---------------------------------------------------------------------- */
  /* Combat / token / disposition helpers                                   */
  /* ---------------------------------------------------------------------- */

  /* The owner of the current battle, published on the module API rather than
     imported — ActionReader stays free of every dependency on the Battle
     Director, and what crosses the boundary is a token-id list and a function.
     Null outside a battle, or if the director never published one; every
     consumer degrades to its own standalone behaviour. */
  battleProvider() {
    try { return globalThis.FUCompanion?.api?.battleContext ?? null; }
    catch (_e) { return null; }
  },

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

  console.debug(`[ActionReader] Core registered to module API for "${moduleId}".`);
}
