/**
 * [ONI] Reaction Config Lint
 * ---------------------------------------------------------------------------
 * Structural validator for skills that use the declarative reaction system
 * (`reaction_config_table` + `effect_table` + optional AE-nested
 *  `flags.fabula-ultima-companion.reactionConfig`).
 *
 * Skips legacy skills — rules only fire when a row claims to use the
 * declarative pattern. The detection rule is: a trigger row whose
 * `reaction_effect_ref` is blank is treated as legacy (the menu picker falls
 * through to the action pipeline). Validation focuses on the case where the
 * row *claims* a declarative effect — that's where data drift produces
 * silent failures.
 *
 * SCOPE
 *   • Every world Item with `props.isReaction === true`
 *   • Every actor-embedded copy of those items
 *   • Every AE-borne `reactionConfig` flag (both on master items and on
 *     actor-borne armed effects like Heart of Darkness Ready)
 *
 * RULES (each issue is { severity, code, location, message }):
 *
 *   Trigger row (reaction_config_table[N]):
 *     EFFECT_REF_UNRESOLVED   reaction_effect_ref points at a label that
 *                             doesn't exist in this scope's effect_table
 *     OWNERSHIP_INVALID       reaction_ownership ∉ {"", "own_summon"}
 *                             (matcher silently rejects unknown values
 *                              when the trigger has a non-null subject)
 *     SOURCE_INVALID          reaction_source ∉ allowed enum
 *     DAMAGE_SOURCE_INVALID   reaction_damage_source ∉ allowed enum
 *     ACTION_INTENT_INVALID   reaction_action_intent ∉ allowed enum
 *     TRIGGER_UNKNOWN         reaction_trigger not in registry (warning)
 *
 *   Effect row (effect_table[N]):
 *     EFFECT_LABEL_DUP        effect_label collides with another row
 *     EFFECT_KIND_UNKNOWN     effect_kind not in dispatcher's switch
 *     EFFECT_KIND_MISSING     row has effect_label but no effect_kind
 *     EFFECT_NO_LABEL         row has effect_kind but no effect_label
 *     CHAIN_EMPTY             chain step has no chain_steps
 *     CHAIN_STEP_UNRESOLVED   chain_steps references a missing label
 *     TARGETING_CANDIDATE_SOURCE_INVALID
 *     TARGETING_MODE_INVALID
 *     TARGETING_CATEGORY_INVALID
 *     CONSUME_CHARGE_KEY_MISSING
 *     APPLY_AE_NO_TEMPLATE    apply_ae without ae_template_ref
 *     TARGET_REF_MISSING      kind requires target_ref but it's blank
 *     TARGET_REF_UNRESOLVED   target_ref doesn't match any effect_label
 *     TARGET_REF_NOT_TARGETING target_ref points at non-targeting row
 *     DESTINATION_REF_MISSING redirect_target without destination_ref
 *
 *   AE-bound passive (one-shot enforcement):
 *     AE_ONESHOT_MISSING      AE-bound reaction_isPassive:true row with
 *                             no consume_self field AND no charges flag
 *                             on the AE — dispatcher won't auto-remove,
 *                             passive re-fires every trigger match.
 *                             Skipped when AE flag directorPermanent or
 *                             crossScene is set (explicit opt-in).
 *
 *   AE shape (BD-tree only):
 *     AE_CLASSIFICATION_MISSING  AE has no "buff" or "debuff" tag in
 *                                system.tags — counts as "Other" and
 *                                doesn't contribute to STATUS_COUNT.
 *     AE_STATUSES_EMPTY          AE has empty statuses[] — V12 token-icon
 *                                ring won't render it (invisible AE).
 *                                Both skip when directorPermanent is set.
 *
 *   Cross-document (actor copy ↔ master, by system.uniqueId):
 *     MASTER_COPY_REF_DRIFT   actor copy's reaction_effect_ref differs
 *                             from master's for the same trigger row
 *     MASTER_COPY_FLAG_DRIFT  master has isReaction:true but copy doesn't
 *     MASTER_COPY_FIELD_DRIFT any other canonical trigger-row field
 *                             differs (passive_mode, source, condition,
 *                             ownership, isPassive, consume_self, etc.)
 *     MASTER_COPY_ROW_MISSING master has a trigger row that copy lacks
 *     MASTER_COPY_EFFECT_DRIFT/MISSING — effect_table row (matched by
 *                             effect_label) drifts or is absent on copy
 *     MASTER_COPY_AE_MISSING  master has an embedded AE with
 *                             reactionConfig that copy lacks
 *     MASTER_COPY_AE_ROW_MISSING/AE_FIELD_DRIFT — same checks inside the
 *                             AE-bound reactionConfig blob
 *
 *   Option-list coverage (runTemplateEngineEnums) — every author-facing
 *   place that picks an effect_kind / reaction_trigger must expose every
 *   engine value, or authors silently can't select it ([[csb-template-gating]]).
 *   Checked surfaces: the _Skill Template, the _Item Template (skill-shaped
 *   weapons + consumables), AND the AE reaction editor's effect_kind dropdown.
 *     ENGINE_KIND_UNEXPOSED    engine dispatches an effect_kind a TEMPLATE
 *                              doesn't list (per-template; warning)
 *     TEMPLATE_KIND_ORPHAN     template lists an effect_kind the engine
 *                              doesn't dispatch (no-op at runtime)
 *     ENGINE_TRIGGER_UNEXPOSED engine knows a reaction_trigger a template
 *                              doesn't list (info)
 *     TEMPLATE_TRIGGER_ORPHAN  template lists a trigger with no emit site
 *     AE_CONFIG_KIND_UNEXPOSED engine effect_kind missing from the AE
 *                              reaction editor's EFFECT_KIND_FIELDS dropdown
 *                              (info; action-only kinds excluded). AE-config
 *                              triggers share the engine registry → can't drift.
 *     AE_CONFIG_KIND_ORPHAN    AE editor offers a kind the engine can't dispatch
 *     TEMPLATE_NOT_FOUND / ENGINE_PARSE_FAILED / AE_CONFIG_PARSE_FAILED
 *
 *   Item-level canon rules (run on every item, regardless of isReaction):
 *     COST_DOUBLE_CHARGE      Item has both a non-empty `cost` field AND a
 *                             `consume_resource` row reachable from
 *                             `on_activate_effect_ref`. Action card debits
 *                             cost at CONFIRM + chain debits again =
 *                             player charged twice silently. Skipped for
 *                             items with isReaction:true (reactions use
 *                             cost as display-only; chain does the actual
 *                             debit). See skill-authoring-canon.md
 *                             branch 1 "Cost rule — one source of truth."
 *
 *   Informational (severity: "info") — surfaces non-failures that change
 *   how you should interpret other findings:
 *     USES_CUSTOM_SCRIPT      item has a non-empty CSB Custom Active /
 *                             Passive Logic script. Other declarative
 *                             issues on this item are softer warnings —
 *                             the script may be filling the gap.
 *
 * USAGE
 *   await FUCompanion.api.lint.runReactionLint();
 *   // → { issues: [...], summary: { total, errors, warnings, byCode } }
 *
 *   Auto-runs once at GM ready and notifies if anything fails.
 *
 * NOT IN SCOPE
 *   • Runtime validity (does the AE referenced by ae_template_ref still exist
 *     in the world right now). That's a "verify-live" check; this is a
 *     structural lint.
 *   • Skill behavior correctness — the lint can't tell you the wrong
 *     handler is being invoked, only that the row's shape would silently
 *     fail to dispatch.
 */

(() => {
  const TAG = "[ReactionConfigLint]";
  const MODULE_ID = "fabula-ultima-companion";

  // CSB props that hold custom JS (skill body scripts). Presence ⇒ the
  // item may be doing things outside the declarative reaction system.
  // Lint flags this so a reader knows other findings may be intentional.
  // Strings only — empty / whitespace-only is treated as absent.
  const CUSTOM_SCRIPT_PROPS = [
    "custom_logic_action",      // active script — fires in action phase
    "custom_logic_resolution",  // active script — fires in resolution phase
    "passive_logic_action",     // passive script — fires in action phase
    "passive_logic_resolution"  // passive script — fires in resolution phase
  ];

  function detectCustomScripts(item) {
    const props = item?.system?.props ?? {};
    const present = [];
    for (const key of CUSTOM_SCRIPT_PROPS) {
      const v = props[key];
      if (typeof v === "string" && v.trim().length > 0) present.push(key);
    }
    return present; // [] when none
  }

  // -------- Allowed enums (mirror the matcher / handlers) ----------------
  const OWNERSHIP_VALUES        = new Set(["", "own_summon"]);
  const SOURCE_VALUES           = new Set(["", "all", "self", "ally", "enemy", "neutral"]);
  const DAMAGE_SOURCE_VALUES    = SOURCE_VALUES;
  const ACTION_INTENT_VALUES    = new Set(["", "harmful", "aid", "neutral"]);
  const CANDIDATE_SOURCE_VALUES = new Set([
    "self", "combat", "trigger_subject", "trigger_actor", "action_targets"
  ]);
  const TARGETING_MODE_VALUES   = new Set(["exact", "up_to", "all"]);
  const TARGETING_CATEGORY_VALUES = new Set(["", "creature", "ally", "enemy"]);
  // Mirror of the engine's dispatch switch (skill-effects.js applyEffectRow) +
  // the sidecar/pre-resolve kinds. Keep in sync when a new effect_kind ships.
  const EFFECT_KIND_VALUES      = new Set([
    "grant", "apply_ae", "consume_charge", "consume_resource",
    "redirect_target", "chain", "open_action_menu", "targeting",
    "remove_tagged_ae", "substitute_cost",
    "set_resource", "roll_loot_table", "deal_damage", "equip_swap",
    "encyclopedia_record",
    // Unified damage adjustment (replaced add_damage + modify_damage_taken).
    "adjust_damage",
  ]);
  // Reserved target_ref words resolved by the targeting resolver
  // (skill-targeting.js RESERVED_REFS) — these are NOT effect_labels, so a
  // target_ref check must accept them without demanding a matching row.
  const RESERVED_TARGET_REFS    = new Set([
    "self", "action_targets", "hit_action_targets", "ally_action_targets",
    "enemy_action_targets", "trigger_actor", "trigger_subject", "cover_target",
  ]);
  // Kinds that operate on tokens and therefore require a target_ref. apply_ae
  // is conditional (target_prompt: "visible" bypasses), handled inline.
  const KINDS_REQUIRING_TARGET_REF = new Set([
    "grant", "consume_charge", "consume_resource", "redirect_target"
  ]);

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------
  // Director-native triggers. Canonical registry lives at
  // scripts/battle-director/director-triggers.js (Gap 4 from canon
  // hardening). The classic-script lint reads from the runtime registry
  // when available, otherwise falls back to this inline mirror.
  // Bootstrap order: if the ES module hasn't loaded yet (race at
  // canvasReady), the fallback covers it; we re-poll the registry inside
  // listTriggerKeys so the lint picks up the registry on subsequent
  // invocations.
  const DIRECTOR_TRIGGERS_FALLBACK = new Set([
    "caster_short_on_mp",
    "creature_completes_spell",
  ]);

  function getDirectorTriggers() {
    const reg = globalThis.FUCompanion?.api?.directorTriggers;
    if (reg?.all instanceof Set && reg.all.size) return reg.all;
    return DIRECTOR_TRIGGERS_FALLBACK;
  }

  function listTriggerKeys() {
    const reg = window["oni.ReactionTriggers"];
    const keys = new Set(getDirectorTriggers());
    if (!reg?.listTriggers) return keys.size ? keys : null;
    try {
      const triggers = reg.listTriggers();
      for (const t of triggers ?? []) {
        if (t?.key) keys.add(t.key);
        for (const a of t?.aliases ?? []) keys.add(a);
      }
      return keys.size ? keys : null;
    } catch (_) { return keys.size ? keys : null; }
  }

  // Canonical trigger keys only (no aliases). Used by the template/engine
  // enum lint: aliases are duplicates of canonical triggers, not separate
  // dropdown options. Without this, `start_of_conflict` (legacy alias)
  // would shadow `conflict_start` (canonical) and produce false positives.
  function listCanonicalTriggerKeys() {
    const reg = window["oni.ReactionTriggers"];
    const keys = new Set(getDirectorTriggers());
    if (!reg?.listTriggers) return keys.size ? keys : null;
    try {
      const triggers = reg.listTriggers();
      for (const t of triggers ?? []) {
        if (t?.key) keys.add(t.key);
      }
      return keys.size ? keys : null;
    } catch (_) { return keys.size ? keys : null; }
  }

  // CSB tables can show up as either arrays or objects keyed by index
  // strings. Normalize to an array of rows tagged with their original key.
  function tableToArray(tbl) {
    if (!tbl) return [];
    if (Array.isArray(tbl)) {
      return tbl.map((r, i) => ({ ...r, $key: String(i) }));
    }
    return Object.entries(tbl).map(([k, row]) => ({ ...(row ?? {}), $key: k }));
  }

  function activeRows(tbl) {
    return tableToArray(tbl).filter(r => !r?.$deleted);
  }

  function hasMeaningfulRows(tbl, fieldsToCheck) {
    return activeRows(tbl).some(r => fieldsToCheck.some(f => String(r?.[f] ?? "").trim()));
  }

  function mkIssue(fields) {
    return Object.assign({ severity: "error" }, fields);
  }

  // ------------------------------------------------------------------
  // Per-scope validation (a "scope" = one item's tables OR one AE's
  // nested reactionConfig tables; treated identically once normalized).
  // ------------------------------------------------------------------
  function lintScope({ triggerTable, effectTable, locationPrefix, triggerKeys }) {
    const issues = [];
    const trigRows = activeRows(triggerTable);
    const effRows  = activeRows(effectTable);

    // Build label index, flag duplicates.
    const labelToRow = new Map();
    for (const row of effRows) {
      const label = String(row?.effect_label ?? "").trim();
      if (!label) continue;
      if (labelToRow.has(label)) {
        issues.push(mkIssue({
          code: "EFFECT_LABEL_DUP",
          location: `${locationPrefix}effect_table[${row.$key}].effect_label`,
          message: `Duplicate effect_label "${label}" — only the first row will be reachable`
        }));
      } else {
        labelToRow.set(label, row);
      }
    }

    // -------- Trigger rows --------
    for (const row of trigRows) {
      const loc = `${locationPrefix}reaction_config_table[${row.$key}]`;
      const trigger = String(row?.reaction_trigger ?? "").trim();
      const effRef  = String(row?.reaction_effect_ref ?? "").trim();

      // Enum checks — fire regardless of whether the row is legacy.
      if (triggerKeys && trigger && !triggerKeys.has(trigger)) {
        issues.push(mkIssue({
          severity: "warning",
          code: "TRIGGER_UNKNOWN",
          location: `${loc}.reaction_trigger`,
          message: `Unknown reaction_trigger "${trigger}" (not in registry)`
        }));
      }
      const src = String(row?.reaction_source ?? "").trim().toLowerCase();
      if (src && !SOURCE_VALUES.has(src)) {
        issues.push(mkIssue({
          code: "SOURCE_INVALID",
          location: `${loc}.reaction_source`,
          message: `reaction_source "${row.reaction_source}" not in {${[...SOURCE_VALUES].filter(Boolean).join(", ")}}`
        }));
      }
      const dsrc = String(row?.reaction_damage_source ?? "").trim().toLowerCase();
      if (dsrc && !DAMAGE_SOURCE_VALUES.has(dsrc)) {
        issues.push(mkIssue({
          code: "DAMAGE_SOURCE_INVALID",
          location: `${loc}.reaction_damage_source`,
          message: `reaction_damage_source "${dsrc}" not in {${[...DAMAGE_SOURCE_VALUES].filter(Boolean).join(", ")}}`
        }));
      }
      const intent = String(row?.reaction_action_intent ?? "").trim().toLowerCase();
      if (intent && !ACTION_INTENT_VALUES.has(intent)) {
        issues.push(mkIssue({
          code: "ACTION_INTENT_INVALID",
          location: `${loc}.reaction_action_intent`,
          message: `reaction_action_intent "${intent}" not in {${[...ACTION_INTENT_VALUES].filter(Boolean).join(", ")}}`
        }));
      }
      const own = String(row?.reaction_ownership ?? "").trim().toLowerCase();
      if (own && !OWNERSHIP_VALUES.has(own)) {
        issues.push(mkIssue({
          code: "OWNERSHIP_INVALID",
          location: `${loc}.reaction_ownership`,
          message: `reaction_ownership "${row.reaction_ownership}" not in {${[...OWNERSHIP_VALUES].filter(Boolean).join(", ") || "(only \"own_summon\" or blank)"}}. Matcher silently rejects unknown values when the trigger declares a subject shape — the row will never fire.`
        }));
      }

      // Reference-resolution checks (declarative-only).
      if (!effRef) continue; // legacy row — no further checks
      if (!labelToRow.has(effRef)) {
        issues.push(mkIssue({
          code: "EFFECT_REF_UNRESOLVED",
          location: `${loc}.reaction_effect_ref`,
          message: `reaction_effect_ref "${effRef}" doesn't match any effect_label in the same scope. Known labels: [${[...labelToRow.keys()].join(", ") || "(none)"}]`
        }));
      }
    }

    // -------- Effect rows --------
    for (const row of effRows) {
      const loc = `${locationPrefix}effect_table[${row.$key}]`;
      const label = String(row?.effect_label ?? "").trim();
      const kind  = String(row?.effect_kind  ?? "").trim().toLowerCase();

      if (!label && !kind) continue; // wholly empty row, ignored
      if (!label && kind) {
        issues.push(mkIssue({
          code: "EFFECT_NO_LABEL",
          location: `${loc}.effect_label`,
          message: `effect_kind "${kind}" set but effect_label is empty — row is unreachable`
        }));
        continue;
      }
      if (label && !kind) {
        issues.push(mkIssue({
          code: "EFFECT_KIND_MISSING",
          location: `${loc}.effect_kind`,
          message: `effect_label "${label}" has no effect_kind — dispatcher will fall through to "grant" default`
        }));
        continue;
      }
      if (!EFFECT_KIND_VALUES.has(kind)) {
        issues.push(mkIssue({
          code: "EFFECT_KIND_UNKNOWN",
          location: `${loc}.effect_kind`,
          message: `Unknown effect_kind "${kind}" — dispatcher will warn + reject`
        }));
        continue;
      }

      // Kind-specific:
      if (kind === "chain") {
        const steps = String(row?.chain_steps ?? "")
          .split(/[,\n]/).map(s => s.trim()).filter(Boolean);
        if (!steps.length) {
          issues.push(mkIssue({
            severity: "warning",
            code: "CHAIN_EMPTY",
            location: `${loc}.chain_steps`,
            message: `chain has no steps — no-op effect`
          }));
        }
        for (const step of steps) {
          if (!labelToRow.has(step)) {
            issues.push(mkIssue({
              code: "CHAIN_STEP_UNRESOLVED",
              location: `${loc}.chain_steps`,
              message: `chain step "${step}" doesn't match any effect_label. Known: [${[...labelToRow.keys()].join(", ")}]`
            }));
          }
        }
        continue;
      }

      if (kind === "targeting") {
        const cs = String(row?.candidate_source ?? "").trim().toLowerCase();
        if (cs && !CANDIDATE_SOURCE_VALUES.has(cs)) {
          issues.push(mkIssue({
            code: "TARGETING_CANDIDATE_SOURCE_INVALID",
            location: `${loc}.candidate_source`,
            message: `candidate_source "${cs}" not in {${[...CANDIDATE_SOURCE_VALUES].join(", ")}}`
          }));
        }
        const mode = String(row?.mode ?? "").trim().toLowerCase();
        if (mode && !TARGETING_MODE_VALUES.has(mode)) {
          issues.push(mkIssue({
            code: "TARGETING_MODE_INVALID",
            location: `${loc}.mode`,
            message: `mode "${mode}" not in {${[...TARGETING_MODE_VALUES].join(", ")}}`
          }));
        }
        const cat = String(row?.category ?? "").trim().toLowerCase();
        if (cat && !TARGETING_CATEGORY_VALUES.has(cat)) {
          issues.push(mkIssue({
            code: "TARGETING_CATEGORY_INVALID",
            location: `${loc}.category`,
            message: `category "${cat}" not in {${[...TARGETING_CATEGORY_VALUES].filter(Boolean).join(", ")}}`
          }));
        }
        continue;
      }

      if (kind === "consume_charge") {
        if (!String(row?.charge_key ?? "").trim()) {
          issues.push(mkIssue({
            code: "CONSUME_CHARGE_KEY_MISSING",
            location: `${loc}.charge_key`,
            message: `consume_charge requires charge_key`
          }));
        }
      }

      if (kind === "apply_ae") {
        if (!String(row?.ae_template_ref ?? "").trim()) {
          issues.push(mkIssue({
            severity: "warning",
            code: "APPLY_AE_NO_TEMPLATE",
            location: `${loc}.ae_template_ref`,
            message: `apply_ae has no ae_template_ref — handler will silently skip`
          }));
        }
        // target_ref optional in the visible-prompt branch.
        const promptMode = String(row?.target_prompt ?? "").trim().toLowerCase();
        if (promptMode) continue;
      }

      if (kind === "redirect_target") {
        if (!String(row?.destination_ref ?? "").trim()) {
          issues.push(mkIssue({
            code: "DESTINATION_REF_MISSING",
            location: `${loc}.destination_ref`,
            message: `redirect_target requires destination_ref`
          }));
        }
      }

      // target_ref check for kinds that need one (after the apply_ae
      // prompt-mode opt-out above).
      const needsTarget = KINDS_REQUIRING_TARGET_REF.has(kind) || kind === "apply_ae";
      if (!needsTarget) continue;

      const tref = String(row?.target_ref ?? "").trim();
      if (!tref) {
        issues.push(mkIssue({
          code: "TARGET_REF_MISSING",
          location: `${loc}.target_ref`,
          message: `${kind} requires target_ref (legacy grant_target / target_lock fields are no longer read after Phase F)`
        }));
        continue;
      }
      // Reserved words (self / action_targets / …) are resolved by the
      // targeting resolver, not by an effect_label — they're always valid.
      if (RESERVED_TARGET_REFS.has(tref)) continue;
      const tRow = labelToRow.get(tref);
      if (!tRow) {
        issues.push(mkIssue({
          code: "TARGET_REF_UNRESOLVED",
          location: `${loc}.target_ref`,
          message: `target_ref "${tref}" doesn't match any effect_label. Known: [${[...labelToRow.keys()].join(", ")}]`
        }));
      } else if (String(tRow?.effect_kind ?? "").trim().toLowerCase() !== "targeting") {
        issues.push(mkIssue({
          code: "TARGET_REF_NOT_TARGETING",
          location: `${loc}.target_ref`,
          message: `target_ref "${tref}" points at effect_kind "${tRow?.effect_kind}", not "targeting"`
        }));
      }
    }

    return issues;
  }

  // ------------------------------------------------------------------
  // Item-level walker — flat tables + nested AE reactionConfigs.
  // ------------------------------------------------------------------
  // ─── Canon: deprecated top-level skill props ──────────────────────────
  //
  // Each entry: { key, code, message, suggest }. `key` is the
  // `system.props.*` field that's deprecated. `suggest` is the
  // reaction_config_table path or effect_kind that replaces it. The
  // `match` predicate lets us only flag NON-EMPTY occurrences (an empty
  // string from a stale template column shouldn't false-positive).
  const DEPRECATED_PROPS = [
    {
      key: "passive_mode",
      code: "DEPRECATED_PROPS_PASSIVE_MODE",
      severity: "warning",
      match: (v) => typeof v === "string" && ["on", "ask", "off", "force"].includes(v.trim().toLowerCase()),
      suggest:
        "Move mode to reaction_config_table[N].reaction_passive_mode " +
        "(the canonical home; passive-manager.js reads it via findPassiveRow()).",
    },
    {
      // Vismagus-style hardcoded boolean flag pattern. Match any prop key
      // ending in `_passive` whose value is `true`. These bypass the
      // reaction-config pipeline and require per-skill engine wiring.
      key: "<*>_passive",
      code: "DEPRECATED_HARDCODED_PASSIVE_FLAG",
      severity: "warning",
      match: null, // handled inline below — keyset scan
      suggest:
        "Replace the `<X>_passive: true` flag with a reaction_config_table " +
        "row carrying the appropriate trigger + reaction_effect_ref. The " +
        "engine should never read class-specific boolean flags off props.",
    },
    {
      key: "post_damage_effect_ref",
      code: "DEPRECATED_FIRE_POINT_POST_DAMAGE",
      severity: "info",
      match: (v) => typeof v === "string" && v.trim().length > 0,
      suggest:
        "Eventually move to a reaction_config_table row with trigger " +
        "`creature_deals_damage` + source=self. Current engine still reads " +
        "this field (see skill-fire-points memory), so emitting info-only " +
        "until the migration sweep lands.",
    },
    {
      key: "passive_check_bonus_formula",
      code: "DEPRECATED_FIRE_POINT_PASSIVE_CHECK_BONUS",
      severity: "info",
      match: (v) => typeof v === "string" && v.trim().length > 0,
      suggest:
        "Eventually move to a reaction_config_table row with trigger " +
        "`creature_performs_check` + effect_kind=grant (bonus_check). Engine " +
        "still reads this field; info-only.",
    },
    {
      key: "passive_damage_bonus",
      code: "DEPRECATED_FIRE_POINT_PASSIVE_DAMAGE_BONUS",
      severity: "info",
      match: (v) => Number.isFinite(Number(v)) && Number(v) !== 0,
      suggest:
        "Eventually move to a reaction_config_table row with trigger " +
        "`creature_deals_damage` + effect_kind=grant. Engine still reads " +
        "this field; info-only.",
    },
  ];

  // ─── Cost double-charge detector ──────────────────────────────────────
  //
  // Skill canon rule (docs/skill-authoring-canon.md, branch 1): a skill's
  // resource cost comes from EXACTLY ONE path:
  //   - Legacy:        non-empty system.props.cost; action-card pipeline
  //                    debits at CONFIRM. NO consume_resource in chain.
  //   - Effect-config: consume_resource row(s) in on_activate chain;
  //                    EMPTY props.cost.
  //
  // Mixing both double-charges the player (action card debits, then
  // chain debits again). No engine guard exists; this lint surfaces
  // violations at author time.
  //
  // Reactions (props.isReaction === true) are exempt — they never reach
  // the action-card cost-debit phase, so `cost` is informational-only.
  // High Speed canonical: cost="10 MP" + consume_resource in chain, OK.
  //
  // Walker semantics: starts at on_activate_effect_ref label, follows
  // `chain` steps + `open_action_menu` option_refs, returns true on
  // any consume_resource found. Mirrors analyzeChainCost in
  // skill-effects.js (we can't import ES modules here; classic script).
  function chainContainsConsumeResource(effectTable, startLabel) {
    if (!effectTable || typeof effectTable !== "object" || !startLabel) return null;
    const byLabel = new Map();
    for (const r of Object.values(effectTable)) {
      if (!r || r.$deleted) continue;
      const lbl = String(r.effect_label ?? "").trim();
      if (lbl) byLabel.set(lbl, r);
    }
    const seen = new Set();
    const queue = [String(startLabel).trim()];
    while (queue.length) {
      const lbl = queue.shift();
      if (!lbl || seen.has(lbl)) continue;
      seen.add(lbl);
      const row = byLabel.get(lbl);
      if (!row) continue;
      const kind = String(row.effect_kind ?? "").trim().toLowerCase();
      if (kind === "consume_resource") {
        return { label: lbl, resource: row.consume_resource ?? row.grant_resource ?? "?" };
      }
      if (kind === "chain") {
        const steps = String(row.chain_steps ?? "")
          .split(/[,\n]+/g).map((s) => s.trim()).filter(Boolean);
        for (const s of steps) queue.push(s);
      } else if (kind === "open_action_menu") {
        // Walk both refs form + inline option array. Even though options
        // are player-pick branches (only one runs at runtime), authoring
        // intent says cost should still come from one source — a
        // consume_resource in ANY branch warrants flagging since the
        // action card would have already debited before the option fires.
        const refs = String(row.menu_option_refs ?? "")
          .split(/[,\n]+/g).map((s) => s.trim()).filter(Boolean);
        for (const ref of refs) queue.push(ref);
      }
    }
    return null;
  }

  function lintCostDoubleCharge(item) {
    const out = [];
    const props = item?.system?.props ?? {};
    // Reactions: cost is informational-only; skip the check.
    if (props.isReaction === true) return out;
    const cost = String(props.cost ?? "").trim();
    const ref  = String(props.on_activate_effect_ref ?? "").trim();
    if (!cost || !ref) return out;
    const hit = chainContainsConsumeResource(props.effect_table, ref);
    if (!hit) return out;
    out.push({
      severity: "error",
      code: "COST_DOUBLE_CHARGE",
      location: `system.props.cost & effect_table[${hit.label}]`,
      message:
        `Skill has both a non-empty cost field ("${cost}") AND a ` +
        `consume_resource row ("${hit.label}" → ${hit.resource}) reachable ` +
        `from on_activate_effect_ref ("${ref}"). The action-card pipeline ` +
        `will debit the cost field at CONFIRM, then the chain will debit ` +
        `${hit.resource} again — the player gets charged twice with no ` +
        `engine guard. Pick one path: clear system.props.cost (effect-config ` +
        `path) OR remove the consume_resource row (legacy path). See ` +
        `skill-authoring-canon.md branch 1 "Cost rule — one source of truth."`,
    });
    return out;
  }

  function lintCanonDeprecations(props) {
    const out = [];
    if (!props || typeof props !== "object") return out;

    for (const rule of DEPRECATED_PROPS) {
      if (rule.key.startsWith("<*>")) continue; // wildcard scan handled below
      const v = props[rule.key];
      if (v === undefined) continue;
      if (rule.match && !rule.match(v)) continue;
      out.push({
        severity: rule.severity,
        code: rule.code,
        location: `system.props.${rule.key}`,
        message: `Deprecated top-level field "${rule.key}" = ${JSON.stringify(v)}. ${rule.suggest}`,
      });
    }

    // Wildcard scan: any `<class>_passive: true` boolean flag.
    for (const k of Object.keys(props)) {
      if (!k.endsWith("_passive")) continue;
      if (k === "isPassive") continue; // template flag, fine
      if (props[k] !== true) continue;
      out.push({
        severity: "warning",
        code: "DEPRECATED_HARDCODED_PASSIVE_FLAG",
        location: `system.props.${k}`,
        message:
          `Hardcoded passive-marker flag "${k}: true" detected. Replace ` +
          `with a reaction_config_table row whose trigger + effect_ref ` +
          `expresses the same behavior; the engine should never gate on ` +
          `class-specific boolean props.`,
      });
    }
    return out;
  }

  function lintItem(item, triggerKeys, ownerLabel) {
    const out = [];
    const props = item?.system?.props ?? {};

    // ── Canon-deprecation gate (runs on EVERY item, ignores isReaction) ──
    // Catches the historical class of mistake where conditional/triggered
    // behavior lived in top-level skill props (passive_mode, *_passive
    // flags, post_damage_effect_ref, passive_check_bonus_formula, etc.)
    // instead of reaction_config_table rows. These fields are deprecated:
    // mode lives on `reaction_config_table[N].reaction_passive_mode`, and
    // every trigger-driven behavior is a reaction row. The lint flags
    // their presence so they can be migrated; engines may still read them
    // as legacy fallbacks during the transition.
    const canonIssues = lintCanonDeprecations(props);
    for (const i of canonIssues) {
      i.owner    = ownerLabel;
      i.itemUuid = item?.uuid ?? null;
      i.itemName = item?.name ?? "(unnamed)";
      out.push(i);
    }

    // ── Cost double-charge check (runs on EVERY item, skips reactions) ──
    // Detects the canon-violation pattern: non-empty `cost` field AND a
    // `consume_resource` row reachable from on_activate_effect_ref. The
    // action card would debit the legacy field at CONFIRM and the chain
    // would debit again — silent double-charge with no engine guard.
    const costIssues = lintCostDoubleCharge(item);
    for (const i of costIssues) {
      i.owner    = ownerLabel;
      i.itemUuid = item?.uuid ?? null;
      i.itemName = item?.name ?? "(unnamed)";
      out.push(i);
    }

    // REACTION_FLAG_MISSING — item carries reaction infrastructure
    // (rows on the skill itself OR a reactionConfig blob on an embedded
    // AE) but `system.props.isReaction` isn't set true. The structural
    // checks below short-circuit on items without isReaction, so this
    // inversion silently hides every other lint rule for the item.
    // Caught Mercy mid-Vismagus-refactor on 2026-05-29.
    const hasItemRC = hasMeaningfulRows(
      props?.reaction_config_table, ["reaction_trigger", "reaction_effect_ref"]
    );
    const hasAERC = (item?.effects?.contents ?? []).some((ae) => {
      const cfg = ae?.flags?.[MODULE_ID]?.reactionConfig;
      if (!cfg) return false;
      return hasMeaningfulRows(
        cfg.reaction_config_table, ["reaction_trigger"]
      );
    });
    if ((hasItemRC || hasAERC) && props?.isReaction !== true) {
      out.push({
        severity: "warning",
        code: "REACTION_FLAG_MISSING",
        owner: ownerLabel,
        itemUuid: item?.uuid ?? null,
        itemName: item?.name ?? "(unnamed)",
        location: "system.props.isReaction",
        message:
          `Item carries reaction_config_table rows ${hasItemRC ? "(on the skill" : ""}${hasItemRC && hasAERC ? " AND on an embedded AE" : hasAERC ? "(on an embedded AE" : ""}) but ` +
          `isReaction !== true. Set props.isReaction = true so the CSB ` +
          `sheet renders the Reactions panel + the rest of this lint runs. ` +
          `Without the flag, every structural reaction rule silently skips ` +
          `this item.`,
      });
    }

    if (props?.isReaction !== true) return out;

    // Custom-script annotation — emit BEFORE declarative checks so the
    // reader knows whether subsequent findings on this item may be
    // intentional (the script could be filling the gap).
    const scripts = detectCustomScripts(item);
    if (scripts.length) {
      out.push({
        severity: "info",
        code: "USES_CUSTOM_SCRIPT",
        owner: ownerLabel,
        itemUuid: item?.uuid ?? null,
        itemName: item?.name ?? "(unnamed)",
        location: scripts.join(" + "),
        message: `Carries non-empty CSB Custom Logic in: ${scripts.join(", ")}. ` +
                 `Declarative-reaction-config issues on this skill may be intentional ` +
                 `(the script may be doing the work).`
      });
    }

    const hasTrig = hasMeaningfulRows(props?.reaction_config_table, ["reaction_trigger", "reaction_effect_ref"]);
    const hasEff  = hasMeaningfulRows(props?.effect_table, ["effect_kind", "effect_label"]);
    if (hasTrig || hasEff) {
      const issues = lintScope({
        triggerTable: props?.reaction_config_table,
        effectTable:  props?.effect_table,
        locationPrefix: "",
        triggerKeys
      });
      for (const i of issues) {
        i.owner = ownerLabel;
        i.itemUuid = item?.uuid ?? null;
        i.itemName = item?.name ?? "(unnamed)";
        out.push(i);
      }
    }

    // AE shape lint (Gaps 7+8) — scoped to BD-tree items. Runs on EVERY
    // AE embedded in the item, regardless of reactionConfig presence.
    if (isInBattleDirectorTree(item)) {
      for (const ae of (item?.effects?.contents ?? [])) {
        for (const i of lintAeShape(ae)) {
          i.owner = ownerLabel;
          i.itemUuid = item?.uuid ?? null;
          i.itemName = item?.name ?? "(unnamed)";
          i.aeName = ae?.name ?? null;
          out.push(i);
        }
      }
    }

    // Nested AE reactionConfig flags (on the item's own AEs).
    for (const ae of (item?.effects?.contents ?? [])) {
      const cfg = ae?.flags?.[MODULE_ID]?.reactionConfig;
      if (!cfg) continue;
      const issues = lintScope({
        triggerTable: cfg?.reaction_config_table,
        // Fallback to legacy reaction_effect_table (synth emits both).
        effectTable: cfg?.effect_table ?? cfg?.reaction_effect_table,
        locationPrefix: `AE["${ae.name}"].`,
        triggerKeys
      });
      for (const i of issues) {
        i.owner = ownerLabel;
        i.itemUuid = item?.uuid ?? null;
        i.itemName = item?.name ?? "(unnamed)";
        i.aeName = ae?.name ?? null;
        out.push(i);
      }
      // AE one-shot enforcement (Gap 3 from canon hardening retrospective).
      // AE-bound reactionConfig rows with reaction_isPassive:true fire on
      // EVERY trigger match for the AE's lifetime. Without consume_self or
      // a charges flag, the dispatcher has no built-in deactivation — only
      // the AE's duration / scene-end sweep ends it. Most one-shots want
      // explicit termination so the passive doesn't double-fire on a
      // single round of trigger-spam (e.g. multi-target damage event).
      for (const i of lintAeOneShot(cfg, ae)) {
        i.owner = ownerLabel;
        i.itemUuid = item?.uuid ?? null;
        i.itemName = item?.name ?? "(unnamed)";
        i.aeName = ae?.name ?? null;
        out.push(i);
      }
    }
    return out;
  }

  // BD-tree scoping helper. The safety rule from the canon-hardening
  // session: only enforce structural constraints on items inside the
  // `Battle Director` folder tree. Legacy NPC items predate the canon
  // and would generate too much noise.
  const BD_ROOT_NAME = "Battle Director";
  function isInBattleDirectorTree(item) {
    let f = item?.folder;
    while (f) {
      if (f.name === BD_ROOT_NAME && !(f.folder?.id ?? f.folder)) return true;
      f = f.folder;
    }
    return false;
  }

  // Gap 7 + Gap 8 from canon hardening:
  //   AE_CLASSIFICATION_MISSING (Gap 7): AE has no `system.tags` containing
  //     "buff" or "debuff". Untagged AEs are 'Other' per
  //     [[opt-in-ae-classification]] and don't count toward STATUS_COUNT
  //     formulas; almost always a mistake on Director-applied AEs.
  //
  //   AE_STATUSES_EMPTY (Gap 8): AE has empty `statuses[]`. The V12
  //     token-icon ring won't render the AE without a status id; the AE
  //     applies its changes invisibly. See [[ae-needs-statuses-for-token-icon]].
  //
  // Both rules skip when the AE opts in via `directorPermanent` flag
  // (signals "this is a persistent class-feature AE; classification rules
  // don't apply"). Scoped to BD-tree items only.
  function lintAeShape(ae) {
    const issues = [];
    const aeFlags = ae?.flags?.[MODULE_ID] ?? {};
    if (aeFlags.directorPermanent === true) return issues;
    const tags = Array.isArray(ae?.system?.tags) ? ae.system.tags.map((t) => String(t).toLowerCase()) : [];
    const hasBuffTag = tags.includes("buff") || tags.includes("debuff");
    if (!hasBuffTag) {
      issues.push(mkIssue({
        severity: "warning",
        code: "AE_CLASSIFICATION_MISSING",
        location: `AE["${ae.name}"].system.tags`,
        message:
          `AE has no "buff" or "debuff" tag — it counts as "Other" per ` +
          `the AE classification system, so STATUS_COUNT formulas won't ` +
          `see it. Director-applied buffs/debuffs almost always need a ` +
          `classification. Add "buff" or "debuff" to system.tags, or ` +
          `mark the AE flags["${MODULE_ID}"].directorPermanent = true ` +
          `if it's a persistent class feature.`,
      }));
    }
    const statuses = Array.from(ae?.statuses ?? []);
    if (statuses.length === 0) {
      issues.push(mkIssue({
        severity: "warning",
        code: "AE_STATUSES_EMPTY",
        location: `AE["${ae.name}"].statuses`,
        message:
          `AE has empty statuses[] — the V12 token-icon ring won't render ` +
          `it, so the AE applies invisibly. Add a status id (convention: ` +
          `"fud-<slug>") so players see it on the token. Mark ` +
          `directorPermanent if the AE is intentionally invisible.`,
      }));
    }
    return issues;
  }

  // AE-bound passive without consume_self / charges → warn.
  // Skipped when the AE explicitly opts into persistent passive behavior
  // via `directorPermanent` or `crossScene` flags (those signal "this AE
  // is meant to fire repeatedly until something else removes it").
  function lintAeOneShot(cfg, ae) {
    const issues = [];
    const rows = activeRows(cfg?.reaction_config_table);
    const eff  = cfg?.effect_table ?? cfg?.reaction_effect_table;
    const effRows = activeRows(eff);
    const labelToEff = new Map();
    for (const r of effRows) {
      const lbl = String(r?.effect_label ?? "").trim();
      if (lbl) labelToEff.set(lbl, r);
    }
    const aeFlags = ae?.flags?.[MODULE_ID] ?? {};
    const hasCharges = aeFlags.charges != null || aeFlags.chargesMax != null;
    const isPermanent =
      aeFlags.directorPermanent === true || aeFlags.crossScene === true;
    if (isPermanent) return issues;
    for (const row of rows) {
      if (row?.reaction_isPassive !== true) continue;
      if (row?.consume_self === true) continue;
      const ref = String(row?.reaction_effect_ref ?? "").trim();
      const effRow = ref ? labelToEff.get(ref) : null;
      if (effRow?.consume_self === true) continue;
      if (hasCharges) continue;
      issues.push(mkIssue({
        severity: "warning",
        code: "AE_ONESHOT_MISSING",
        location: `AE["${ae.name}"].reaction_config_table[${row.$key}]`,
        message:
          `AE-bound passive row (reaction_isPassive:true) has no ` +
          `consume_self field and the AE has no charges/chargesMax flag. ` +
          `The dispatcher won't auto-remove this AE — it will re-fire on ` +
          `every trigger match until the AE itself expires. If that's ` +
          `intentional, mark the AE with ` +
          `flags["${MODULE_ID}"].directorPermanent: true. Otherwise add ` +
          `consume_self:true on the row (or effect_row), or arm the AE ` +
          `with chargesMax (skill-charges API auto-deletes at 0).`
      }));
    }
    return issues;
  }

  // ------------------------------------------------------------------
  // Cross-document drift: actor copy vs master (matched by
  // system.uniqueId, the skill template link contract). Extended Gap 1
  // from canon hardening: compare ALL canonical reaction-row fields,
  // effect_table rows (matched by effect_label), AND AE-bound
  // reactionConfig blobs (matched by AE name).
  // ------------------------------------------------------------------

  // Fields whose drift between master and copy indicates the copy's
  // template wasn't refreshed after a master edit (or vice versa). Any
  // mismatch here changes behavior at dispatch time. Each entry is the
  // string-comparable raw value — undefined/null/"" all normalize to "".
  const TRIGGER_ROW_CANONICAL_FIELDS = [
    "reaction_source",
    "reaction_action_target",
    "reaction_condition",
    "reaction_isPassive",
    "reaction_passive_mode",
    "reaction_effect_ref",
    "reaction_damage_source",
    "reaction_action_intent",
    "reaction_ownership",
    "consume_self",
  ];
  const EFFECT_ROW_CANONICAL_FIELDS = [
    "effect_kind",
    "target_ref",
    "grant_resource",
    "grant_amount",
    "grant_target",
    "ae_template_ref",
    "ae_duplicate_mode",
    "target_prompt",
    "chain_steps",
    "charge_key",
    "consume_self",
    "destination_ref",
    "candidate_source",
    "mode",
    "category",
    "from_resource",
    "to_resource",
    "multiplier",
    "min_remaining",
  ];

  function normField(v) {
    if (v === undefined || v === null) return "";
    if (typeof v === "boolean") return v ? "true" : "false";
    return String(v).trim();
  }

  function compareRow(mRow, cRow, fields) {
    const diffs = [];
    for (const f of fields) {
      const mv = normField(mRow?.[f]);
      const cv = normField(cRow?.[f]);
      if (mv !== cv) diffs.push({ field: f, master: mv, copy: cv });
    }
    return diffs;
  }

  function pushDrift(out, ctx, code, location, message) {
    out.push({
      severity: "warning",
      code,
      owner: ctx.ownerLabel,
      itemUuid: ctx.copy?.uuid ?? null,
      itemName: ctx.copy?.name ?? "(unnamed)",
      location,
      message,
    });
  }

  function lintMasterCopyDrift(masterIndex) {
    const out = [];
    for (const actor of (game.actors?.contents ?? [])) {
      for (const item of (actor.items?.contents ?? [])) {
        const uniqueId = String(item?.system?.uniqueId ?? "").trim();
        if (!uniqueId) continue;
        const master = masterIndex.get(uniqueId);
        if (!master) continue;
        if (master.id === item.id) continue;
        // If master isn't isReaction we skip (legacy / non-reaction item).
        if (master?.system?.props?.isReaction !== true) continue;

        const ctx = { ownerLabel: `actor "${actor.name}"`, copy: item };

        // isReaction flag mismatch — the copy silently disables all
        // reaction handling if this isn't true.
        if (item?.system?.props?.isReaction !== true) {
          pushDrift(out, ctx, "MASTER_COPY_FLAG_DRIFT",
            "system.props.isReaction",
            `Master has isReaction:true but copy doesn't. Reaction rows on this copy won't fire. Re-sync from master.`);
        }

        const masterTrig = activeRows(master?.system?.props?.reaction_config_table);
        const copyTrig   = activeRows(item?.system?.props?.reaction_config_table);
        for (const mRow of masterTrig) {
          const mTrigVal = String(mRow?.reaction_trigger ?? "").trim();
          if (!mTrigVal) continue;
          const cRow = copyTrig.find(r => String(r?.reaction_trigger ?? "").trim() === mTrigVal);
          if (!cRow) {
            pushDrift(out, ctx, "MASTER_COPY_ROW_MISSING",
              `reaction_config_table[?].reaction_trigger="${mTrigVal}"`,
              `Master row trigger "${mTrigVal}" has no matching row on copy. Reaction won't fire on this actor's copy.`);
            continue;
          }
          const diffs = compareRow(mRow, cRow, TRIGGER_ROW_CANONICAL_FIELDS);
          for (const d of diffs) {
            const code = d.field === "reaction_effect_ref"
              ? "MASTER_COPY_REF_DRIFT"
              : "MASTER_COPY_FIELD_DRIFT";
            pushDrift(out, ctx, code,
              `reaction_config_table[${cRow.$key}].${d.field}`,
              `Trigger "${mTrigVal}": master.${d.field} = "${d.master}" vs copy.${d.field} = "${d.copy || "(blank)"}". Re-author migration or template refresh likely required.`);
          }
        }

        // Effect rows compared by effect_label.
        const masterEff = activeRows(master?.system?.props?.effect_table);
        const copyEff   = activeRows(item?.system?.props?.effect_table);
        const copyEffByLabel = new Map();
        for (const r of copyEff) {
          const lbl = String(r?.effect_label ?? "").trim();
          if (lbl) copyEffByLabel.set(lbl, r);
        }
        for (const mRow of masterEff) {
          const lbl = String(mRow?.effect_label ?? "").trim();
          if (!lbl) continue;
          const cRow = copyEffByLabel.get(lbl);
          if (!cRow) {
            pushDrift(out, ctx, "MASTER_COPY_EFFECT_MISSING",
              `effect_table[?].effect_label="${lbl}"`,
              `Master effect row labeled "${lbl}" has no matching row on copy. Dispatch will fail to resolve any trigger pointing at it.`);
            continue;
          }
          const diffs = compareRow(mRow, cRow, EFFECT_ROW_CANONICAL_FIELDS);
          for (const d of diffs) {
            pushDrift(out, ctx, "MASTER_COPY_EFFECT_DRIFT",
              `effect_table[${cRow.$key}].${d.field}`,
              `Effect "${lbl}": master.${d.field} = "${d.master}" vs copy.${d.field} = "${d.copy || "(blank)"}". Re-sync needed.`);
          }
        }

        // AE-bound reactionConfig blobs (matched by AE name).
        const masterAEByName = new Map();
        for (const ae of (master?.effects?.contents ?? [])) {
          if (ae?.flags?.[MODULE_ID]?.reactionConfig) masterAEByName.set(ae.name, ae);
        }
        const copyAEByName = new Map();
        for (const ae of (item?.effects?.contents ?? [])) {
          if (ae?.flags?.[MODULE_ID]?.reactionConfig) copyAEByName.set(ae.name, ae);
        }
        for (const [name, mAE] of masterAEByName) {
          const cAE = copyAEByName.get(name);
          if (!cAE) {
            pushDrift(out, ctx, "MASTER_COPY_AE_MISSING",
              `AE["${name}"]`,
              `Master carries embedded AE "${name}" with reactionConfig blob, but copy has no matching AE. Apply-AE-then-reactor pattern won't arm on this actor's copy.`);
            continue;
          }
          const mCfg = mAE.flags?.[MODULE_ID]?.reactionConfig ?? {};
          const cCfg = cAE.flags?.[MODULE_ID]?.reactionConfig ?? {};
          // Compare trigger-row fields inside the blob.
          const mAERows = activeRows(mCfg.reaction_config_table);
          const cAERows = activeRows(cCfg.reaction_config_table);
          for (const mRow of mAERows) {
            const mTrig = String(mRow?.reaction_trigger ?? "").trim();
            if (!mTrig) continue;
            const cRow = cAERows.find(r => String(r?.reaction_trigger ?? "").trim() === mTrig);
            if (!cRow) {
              pushDrift(out, ctx, "MASTER_COPY_AE_ROW_MISSING",
                `AE["${name}"].reaction_config_table[?]`,
                `Master AE "${name}" has trigger row "${mTrig}" with no match on copy's AE.`);
              continue;
            }
            for (const d of compareRow(mRow, cRow, TRIGGER_ROW_CANONICAL_FIELDS)) {
              pushDrift(out, ctx, "MASTER_COPY_AE_FIELD_DRIFT",
                `AE["${name}"].reaction_config_table[${cRow.$key}].${d.field}`,
                `AE "${name}" trigger "${mTrig}": master.${d.field} = "${d.master}" vs copy.${d.field} = "${d.copy || "(blank)"}".`);
            }
          }
        }
      }
    }
    return out;
  }

  // ------------------------------------------------------------------
  // Public entry
  // ------------------------------------------------------------------
  function runReactionLint(opts = {}) {
    const triggerKeys = listTriggerKeys();
    const allIssues = [];

    const masterIndex = new Map();
    for (const item of (game.items?.contents ?? [])) {
      const uid = String(item?.system?.uniqueId ?? "").trim();
      if (uid && !masterIndex.has(uid)) masterIndex.set(uid, item);
    }

    // 1. World master items.
    for (const item of (game.items?.contents ?? [])) {
      try { allIssues.push(...lintItem(item, triggerKeys, "master")); }
      catch (e) {
        allIssues.push({
          severity: "error", code: "LINT_THREW",
          owner: "master", itemUuid: item?.uuid, itemName: item?.name,
          message: `Lint threw: ${e?.message ?? e}`
        });
      }
    }

    // 2. Actor-embedded copies.
    for (const actor of (game.actors?.contents ?? [])) {
      for (const item of (actor.items?.contents ?? [])) {
        try { allIssues.push(...lintItem(item, triggerKeys, `actor "${actor.name}"`)); }
        catch (e) {
          allIssues.push({
            severity: "error", code: "LINT_THREW",
            owner: `actor "${actor.name}"`,
            itemUuid: item?.uuid, itemName: item?.name,
            message: `Lint threw: ${e?.message ?? e}`
          });
        }
      }
    }

    // 3. Actor-borne AEs carrying their own reactionConfig (e.g. stale
    //    armed Ready AEs that were stamped from a now-fixed master).
    for (const actor of (game.actors?.contents ?? [])) {
      for (const ae of (actor?.effects?.contents ?? [])) {
        const cfg = ae?.flags?.[MODULE_ID]?.reactionConfig;
        if (!cfg) continue;
        try {
          const issues = lintScope({
            triggerTable: cfg?.reaction_config_table,
            effectTable:  cfg?.effect_table ?? cfg?.reaction_effect_table,
            locationPrefix: `actor "${actor.name}" AE["${ae.name}"].`,
            triggerKeys
          });
          for (const i of issues) {
            i.owner = `actor "${actor.name}" AE-stamp`;
            i.itemUuid = ae?.uuid ?? null;
            i.itemName = ae?.name ?? `(AE on ${actor.name})`;
            i.aeName = ae?.name ?? null;
            allIssues.push(i);
          }
          for (const i of lintAeOneShot(cfg, ae)) {
            i.owner = `actor "${actor.name}" AE-stamp`;
            i.itemUuid = ae?.uuid ?? null;
            i.itemName = ae?.name ?? `(AE on ${actor.name})`;
            i.aeName = ae?.name ?? null;
            allIssues.push(i);
          }
        } catch (e) {
          allIssues.push({
            severity: "error", code: "LINT_THREW",
            owner: `actor "${actor.name}" AE-stamp`,
            itemUuid: ae?.uuid, itemName: ae?.name,
            message: `Lint threw: ${e?.message ?? e}`
          });
        }
      }
    }

    // 4. Cross-document drift (actor copy vs master by uniqueId).
    if (opts.skipDrift !== true) {
      try { allIssues.push(...lintMasterCopyDrift(masterIndex)); }
      catch (e) {
        allIssues.push({
          severity: "error", code: "LINT_THREW",
          owner: "cross-doc", message: `Drift check threw: ${e?.message ?? e}`
        });
      }
    }

    // Summary
    const summary = {
      total: allIssues.length,
      errors:   allIssues.filter(i => i.severity === "error").length,
      warnings: allIssues.filter(i => i.severity === "warning").length,
      info:     allIssues.filter(i => i.severity === "info").length,
      byCode: {}
    };
    for (const i of allIssues) summary.byCode[i.code] = (summary.byCode[i.code] || 0) + 1;

    if (opts.console !== false) {
      console.log(
        `${TAG} ${summary.total} issue(s): ${summary.errors} error / ${summary.warnings} warning / ${summary.info} info`,
        summary
      );
      if (summary.total > 0) {
        const grouped = new Map();
        for (const i of allIssues) {
          const key = `${i.owner} → "${i.itemName}"${i.aeName ? ` / ${i.aeName}` : ""}`;
          if (!grouped.has(key)) grouped.set(key, []);
          grouped.get(key).push(i);
        }
        for (const [key, items] of grouped) {
          console.groupCollapsed(`${TAG} ${key} (${items.length})`);
          for (const i of items) {
            const fn = i.severity === "error"   ? console.error
                    : i.severity === "warning" ? console.warn
                    :                            console.info;
            fn.call(console, `${TAG} [${i.code}] ${i.location ?? "(scope)"} — ${i.message}`);
          }
          console.groupEnd();
        }
      }
    }

    return { issues: allIssues, summary };
  }

  // ------------------------------------------------------------------
  // Gap 2 from canon hardening: template ↔ engine enum consistency.
  //
  // The CSB `_Skill Template` exposes `effect_kind` and `reaction_trigger`
  // as select columns with hardcoded option arrays. The engine has its
  // own set of dispatch cases (skill-effects.js applyEffectRow) and
  // trigger registry (oni.ReactionTriggers + DIRECTOR_TRIGGERS).
  //
  // Drift modes this catches:
  //   • Engine added a new effect_kind / trigger but template wasn't
  //     surgery'd → authors can't write it from the CSB sheet (CSB
  //     silently strips unknown values, see [[csb-template-gating]]).
  //   • Template has an option but the engine doesn't handle it →
  //     authors can write it but it no-ops or warns at dispatch.
  //
  // Async because it parses skill-effects.js via fetch.
  // ------------------------------------------------------------------
  const DEFAULT_SKILL_TEMPLATE_UUID = "Item.j0F5Msw5RZ8aIB3j";
  const DEFAULT_ITEM_TEMPLATE_UUID  = "Item.ZoiV53VaLzeRsEps"; // weapons + consumables (skill-shaped)
  const SKILL_EFFECTS_PATH = "/modules/fabula-ultima-companion/scripts/battle-director/skill-effects.js";
  const AE_REACTION_UI_PATH = "/modules/fabula-ultima-companion/scripts/active-effect-manager/ActiveEffectManager-reaction-ui.js";
  // effect_kinds that only make sense in the action pipeline, never as an
  // AE-borne reaction effect — excluded from the AE-config completeness check.
  const AE_CONFIG_ACTION_ONLY_KINDS = new Set(["equip_swap", "encyclopedia_record", "targeting"]);
  // Effect kinds dispatched outside applyEffectRow's central switch.
  // These are handled in side pipelines (e.g. modify_damage_taken fires
  // from the damage-application path, not the standard dispatcher). Add
  // to this list whenever we introduce another out-of-band kind.
  // adjust_damage is dispatched as a data-only case in applyEffectRow's central
  // switch (read out-of-band by the sender accumulator / receiver clamp), so it
  // needs no sidecar entry. No sidecar kinds remain after the unify refactor.
  const SIDECAR_EFFECT_KINDS = new Set([]);

  // Walk a CSB template tree for nodes that look like a select-column.
  // CSB select columns have shape `{ key: "<colKey>", options: [...] }`
  // where options is an array of strings (the dropdown values).
  function collectTemplateSelectOptions(node, targetKey, out = new Set()) {
    if (!node || typeof node !== "object") return out;
    if (Array.isArray(node)) {
      for (const child of node) collectTemplateSelectOptions(child, targetKey, out);
      return out;
    }
    if (node.key === targetKey && Array.isArray(node.options)) {
      for (const opt of node.options) {
        // CSB select-options are `{ key: "<stored>", value: "<label>" }`.
        // We want the stored key (matches what's written to the row), not
        // the display label.
        const v = typeof opt === "string" ? opt : (opt?.key ?? opt?.value);
        if (v != null && String(v).trim()) out.add(String(v).trim());
      }
    }
    for (const v of Object.values(node)) {
      if (v && typeof v === "object") collectTemplateSelectOptions(v, targetKey, out);
    }
    return out;
  }

  async function parseEngineEffectKinds() {
    try {
      const res = await fetch(SKILL_EFFECTS_PATH + "?cb=" + Date.now(), { cache: "no-store" });
      if (!res.ok) return null;
      const src = await res.text();
      // Match `case "<kind>":` inside the applyEffectRow switch.
      const block = src.match(/applyEffectRow[\s\S]*?\bswitch\s*\([^)]*\)\s*\{([\s\S]*?)\n\s*\}/);
      const out = new Set(SIDECAR_EFFECT_KINDS);
      const re = /case\s+["']([a-z_]+)["']/g;
      const scan = block ? block[1] : src;
      let m;
      while ((m = re.exec(scan))) out.add(m[1]);
      return out;
    } catch (e) {
      console.warn(`${TAG} parseEngineEffectKinds fetch failed`, e);
      return null;
    }
  }

  // Parse the effect_kind keys offered by the AE reaction editor's dropdown
  // (EFFECT_KIND_FIELDS in ActiveEffectManager-reaction-ui.js). This is a
  // hand-maintained subset, so it can fall behind the engine.
  async function parseAeConfigEffectKinds() {
    try {
      const res = await fetch(AE_REACTION_UI_PATH + "?cb=" + Date.now(), { cache: "no-store" });
      if (!res.ok) return null;
      const src = await res.text();
      const block = src.match(/EFFECT_KIND_FIELDS\s*=\s*Object\.freeze\(\s*\{([\s\S]*?)\}\s*\)/);
      if (!block) return null;
      const out = new Set();
      // Keys are `<kind>:` at the start of each entry; array values are quoted
      // strings (no bare colon), so this only captures the kind keys.
      const re = /(\w+)\s*:/g;
      let m;
      while ((m = re.exec(block[1]))) out.add(m[1]);
      return out;
    } catch (e) {
      console.warn(`${TAG} parseAeConfigEffectKinds fetch failed`, e);
      return null;
    }
  }

  async function lintTemplateEngineEnums({ skillTemplateUuid, itemTemplateUuid } = {}) {
    const issues = [];
    const engineKinds = await parseEngineEffectKinds();
    const engineTriggers = listCanonicalTriggerKeys();
    if (!engineKinds) {
      issues.push({
        severity: "warning",
        code: "ENGINE_PARSE_FAILED",
        owner: "template-engine",
        message: `Could not fetch/parse skill-effects.js for engine kind set — comparison skipped.`,
      });
    }

    // --- 1 & 2: author-facing TEMPLATES that carry effect_kind /
    // reaction_trigger select-columns (skill items + skill-shaped weapons /
    // consumables). Both must expose every engine kind + trigger or CSB sheet
    // authors silently can't pick it ([[csb-template-gating]]). ---
    const templates = [
      { label: "_Skill Template", uuid: skillTemplateUuid || DEFAULT_SKILL_TEMPLATE_UUID },
      { label: "_Item Template",  uuid: itemTemplateUuid  || DEFAULT_ITEM_TEMPLATE_UUID  },
    ];
    for (const { label, uuid } of templates) {
      let template = null;
      try { template = await fromUuid(uuid); } catch (_) { template = null; }
      if (!template) {
        issues.push({
          severity: "warning",
          code: "TEMPLATE_NOT_FOUND",
          owner: "template-engine",
          location: uuid,
          message: `${label} at ${uuid} not found — enum check skipped for it. Pass runTemplateEngineEnums({ skillTemplateUuid / itemTemplateUuid: "Item.<id>" }) if it moved.`,
        });
        continue;
      }
      const tmplKinds    = collectTemplateSelectOptions(template?.system, "effect_kind");
      const tmplTriggers = collectTemplateSelectOptions(template?.system, "reaction_trigger");

      if (engineKinds) {
        for (const k of engineKinds) {
          if (!tmplKinds.has(k)) {
            issues.push({
              severity: "warning",
              code: "ENGINE_KIND_UNEXPOSED",
              owner: "template-engine",
              location: `${label} effect_kind options`,
              message: `Engine dispatches effect_kind "${k}" but ${label} options do NOT include it. CSB sheet authors cannot select this kind; only programmatic Item.create can use it. Run a template-surgery migration to add the option.`,
            });
          }
        }
        for (const k of tmplKinds) {
          if (!engineKinds.has(k)) {
            issues.push({
              severity: "warning",
              code: "TEMPLATE_KIND_ORPHAN",
              owner: "template-engine",
              location: `${label} effect_kind options`,
              message: `${label} exposes effect_kind "${k}" but the engine has no dispatch case. Author can write this value but dispatch will warn + no-op. Either implement the kind or remove the template option.`,
            });
          }
        }
      }
      if (engineTriggers) {
        for (const t of engineTriggers) {
          if (!tmplTriggers.has(t)) {
            issues.push({
              severity: "info",
              code: "ENGINE_TRIGGER_UNEXPOSED",
              owner: "template-engine",
              location: `${label} reaction_trigger options`,
              message: `Engine knows reaction_trigger "${t}" but ${label} options do NOT include it. CSB sheet authors cannot select this trigger; run a template-surgery migration.`,
            });
          }
        }
        for (const t of tmplTriggers) {
          if (!engineTriggers.has(t)) {
            issues.push({
              severity: "warning",
              code: "TEMPLATE_TRIGGER_ORPHAN",
              owner: "template-engine",
              location: `${label} reaction_trigger options`,
              message: `${label} exposes reaction_trigger "${t}" but the engine has no registered trigger emit site. Rows using this trigger will never fire.`,
            });
          }
        }
      }
    }

    // --- 3: AE CONFIGURATION editor (ActiveEffectManager-reaction-ui.js). The
    // trigger dropdown is sourced from the same oni.ReactionTriggers registry
    // as the engine, so it CANNOT drift (no check needed). The effect_kind
    // dropdown is a hand-maintained subset (EFFECT_KIND_FIELDS) that can. ---
    const aeKinds = await parseAeConfigEffectKinds();
    if (!aeKinds) {
      issues.push({
        severity: "info",
        code: "AE_CONFIG_PARSE_FAILED",
        owner: "ae-config",
        message: `Could not parse EFFECT_KIND_FIELDS from ActiveEffectManager-reaction-ui.js — AE-config effect_kind check skipped.`,
      });
    } else if (engineKinds) {
      for (const k of engineKinds) {
        if (AE_CONFIG_ACTION_ONLY_KINDS.has(k)) continue; // action-pipeline only
        if (!aeKinds.has(k)) {
          issues.push({
            severity: "info",
            code: "AE_CONFIG_KIND_UNEXPOSED",
            owner: "ae-config",
            location: `EFFECT_KIND_FIELDS (AE reaction editor)`,
            message: `Engine dispatches effect_kind "${k}" but the AE reaction editor's EFFECT_KIND_FIELDS does NOT list it — authors can't pick it when adding a reaction effect to an ActiveEffect. Add it (+ its field list) if it's valid in an AE/reaction context.`,
          });
        }
      }
      for (const k of aeKinds) {
        if (!engineKinds.has(k)) {
          issues.push({
            severity: "warning",
            code: "AE_CONFIG_KIND_ORPHAN",
            owner: "ae-config",
            location: `EFFECT_KIND_FIELDS (AE reaction editor)`,
            message: `AE reaction editor offers effect_kind "${k}" but the engine has no dispatch case — selecting it no-ops.`,
          });
        }
      }
    }

    return issues;
  }

  // ------------------------------------------------------------------
  // Gap 10 from canon hardening: spec JSON vs live drift.
  //
  // Load docs/battle-director-spiritist-skills.json (the canonical spec
  // file for the Spiritist class) and compare each spec entry's canon-
  // relevant props against the live world Item with the same name. Drift
  // means either:
  //   (a) the spec was updated but no migration ran to sync live, OR
  //   (b) live was edited but the spec file is stale documentation.
  //
  // INFO severity — surfaces drift, doesn't insist on action. Scoped to
  // a narrow allowlist of canon fields to avoid GM-edit-induced noise.
  // ------------------------------------------------------------------
  const SPEC_JSON_PATHS = [
    "modules/fabula-ultima-companion/docs/battle-director-spiritist-skills.json",
    "modules/fabula-ultima-companion/docs/battle-director-rogue-skills.json",
  ];
  // Spec fields where drift is genuinely actionable. NOT included:
  // labels, costs, ranges, descriptions (intentional GM edits or
  // localisation tweaks).
  const SPEC_CANON_TOP_LEVEL = ["isReaction"];

  async function lintSpecVsLiveDrift() {
    const issues = [];
    for (const path of SPEC_JSON_PATHS) {
      let spec = null;
      try {
        const res = await fetch("/" + path.replace(/^\/+/, ""), { cache: "no-store" });
        if (!res.ok) continue;
        spec = await res.json();
      } catch (_) { continue; }
      const skills = Array.isArray(spec?.skills) ? spec.skills : [];
      for (const entry of skills) {
        const specShape = entry?.spec ?? entry;
        const name = specShape?.name;
        if (!name) continue;
        const specProps = specShape?.props ?? {};
        // Name collision handling: prefer the BD-tree item when there are
        // multiple items with the same name (e.g. legacy `Spiritist Spell`
        // folder still holds a stub `Reinforce` shadowing the canonical
        // `Battle Director / Spiritist / Spell` Reinforce).
        const candidates = game.items?.contents?.filter((it) => it.name === name) ?? [];
        const live = candidates.find(isInBattleDirectorTree) ?? candidates[0] ?? null;
        if (!live) {
          issues.push({
            severity: "info",
            code: "SPEC_LIVE_MISSING",
            owner: "spec",
            itemName: name,
            location: path,
            message: `Spec lists skill "${name}" but no live world Item with that name exists. Run CreateSkillFromSpec to materialize it, or remove the spec entry.`,
          });
          continue;
        }
        const liveProps = live?.system?.props ?? {};
        // Top-level canon fields.
        for (const key of SPEC_CANON_TOP_LEVEL) {
          if (!(key in specProps)) continue;
          if (specProps[key] === liveProps[key]) continue;
          issues.push({
            severity: "info",
            code: "SPEC_LIVE_DRIFT",
            owner: "spec",
            itemUuid: live.uuid,
            itemName: name,
            location: `system.props.${key}`,
            message: `Spec.props.${key} = ${JSON.stringify(specProps[key])} but live = ${JSON.stringify(liveProps[key])}. Migrate live or update spec.`,
          });
        }
        // Reaction-config-table row presence by trigger.
        const specRows = activeRows(specProps?.reaction_config_table);
        const liveRows = activeRows(liveProps?.reaction_config_table);
        for (const sRow of specRows) {
          const sTrig = String(sRow?.reaction_trigger ?? "").trim();
          if (!sTrig) continue;
          const lRow = liveRows.find((r) => String(r?.reaction_trigger ?? "").trim() === sTrig);
          if (!lRow) {
            issues.push({
              severity: "info",
              code: "SPEC_LIVE_RC_MISSING",
              owner: "spec",
              itemUuid: live.uuid,
              itemName: name,
              location: `reaction_config_table[trigger="${sTrig}"]`,
              message: `Spec says "${name}" should have a reaction_config_table row with trigger "${sTrig}" but no matching row on live. Likely needs migration.`,
            });
          }
        }
        // Effect-table label presence.
        const specEff = activeRows(specProps?.effect_table);
        const liveEff = activeRows(liveProps?.effect_table);
        const liveLabels = new Set(liveEff.map((r) => String(r?.effect_label ?? "").trim()).filter(Boolean));
        for (const sRow of specEff) {
          const lbl = String(sRow?.effect_label ?? "").trim();
          if (!lbl) continue;
          if (!liveLabels.has(lbl)) {
            issues.push({
              severity: "info",
              code: "SPEC_LIVE_EFFECT_MISSING",
              owner: "spec",
              itemUuid: live.uuid,
              itemName: name,
              location: `effect_table[effect_label="${lbl}"]`,
              message: `Spec says "${name}" should have an effect_table row labeled "${lbl}" but live has no row with that label.`,
            });
          }
        }
      }
    }
    return issues;
  }

  async function runSpecVsLiveDrift(opts = {}) {
    const issues = await lintSpecVsLiveDrift();
    const summary = {
      total: issues.length,
      info: issues.filter(i => i.severity === "info").length,
      byCode: {},
    };
    for (const i of issues) summary.byCode[i.code] = (summary.byCode[i.code] || 0) + 1;
    if (opts.console !== false && issues.length) {
      console.group(`${TAG} Spec/live drift: ${issues.length} info finding(s)`);
      for (const i of issues) console.info(`${TAG} [${i.code}] ${i.itemName ?? "?"} ${i.location ?? ""} — ${i.message}`);
      console.groupEnd();
    }
    return { issues, summary };
  }

  async function runTemplateEngineEnums(opts = {}) {
    const issues = await lintTemplateEngineEnums(opts);
    const summary = {
      total: issues.length,
      errors:   issues.filter(i => i.severity === "error").length,
      warnings: issues.filter(i => i.severity === "warning").length,
      info:     issues.filter(i => i.severity === "info").length,
      byCode: {},
    };
    for (const i of issues) summary.byCode[i.code] = (summary.byCode[i.code] || 0) + 1;
    if (opts.console !== false) {
      const byCode = new Map();
      for (const i of issues) {
        if (!byCode.has(i.code)) byCode.set(i.code, []);
        byCode.get(i.code).push(i);
      }
      console.group(`${TAG} Template/Engine enum lint: ${issues.length} issue(s)`);
      for (const [code, items] of byCode) {
        console.group(`[${code}] ${items.length}`);
        for (const i of items) {
          const fn = i.severity === "error"   ? console.error
                  : i.severity === "warning" ? console.warn
                  :                            console.info;
          fn.call(console, `${TAG} [${i.code}] ${i.location ?? "(scope)"} — ${i.message}`);
        }
        console.groupEnd();
      }
      console.groupEnd();
    }
    return { issues, summary };
  }

  // GM-only auto-run at ready. Surfaces a notification when issues exist
  // so we notice drift after a migration without having to remember.
  Hooks.once("ready", () => {
    if (!game.user?.isGM) return;
    try {
      const { summary } = runReactionLint({ console: true });
      if (summary.errors > 0) {
        ui.notifications?.warn(
          `[Reaction Lint] ${summary.errors} error / ${summary.warnings} warning — see console.`
        );
      } else if (summary.warnings > 0) {
        ui.notifications?.info(
          `[Reaction Lint] ${summary.warnings} warning — see console.`
        );
      }
    } catch (e) {
      console.error(`${TAG} auto-run failed:`, e);
    }
    // Async sibling — fire-and-forget; notification deferred until done.
    runTemplateEngineEnums({ console: true }).then(({ summary }) => {
      if (summary.warnings > 0 || summary.errors > 0) {
        ui.notifications?.warn(
          `[Template/Engine Lint] ${summary.errors} error / ${summary.warnings} warning / ${summary.info} info — see console.`
        );
      }
    }).catch((e) => console.error(`${TAG} template/engine auto-run failed:`, e));
    // Spec/live drift — info-only, no notification toast (just console).
    runSpecVsLiveDrift({ console: true })
      .catch((e) => console.error(`${TAG} spec/live drift auto-run failed:`, e));
  });

  globalThis.FUCompanion        = globalThis.FUCompanion        || {};
  globalThis.FUCompanion.api    = globalThis.FUCompanion.api    || {};
  globalThis.FUCompanion.api.lint = globalThis.FUCompanion.api.lint || {};
  globalThis.FUCompanion.api.lint.runReactionLint = runReactionLint;
  globalThis.FUCompanion.api.lint.runTemplateEngineEnums = runTemplateEngineEnums;
  globalThis.FUCompanion.api.lint.runSpecVsLiveDrift = runSpecVsLiveDrift;

  console.debug(`${TAG} Installed. Call FUCompanion.api.lint.runReactionLint() or runTemplateEngineEnums() to scan.`);
})();
