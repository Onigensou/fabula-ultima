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
 *   Cross-document (actor copy ↔ master, by system.uniqueId):
 *     MASTER_COPY_REF_DRIFT   actor copy's reaction_effect_ref differs
 *                             from master's for the same trigger row
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
  const EFFECT_KIND_VALUES      = new Set([
    "grant", "apply_ae", "consume_charge", "consume_resource",
    "redirect_target", "chain", "open_action_menu", "targeting"
  ]);
  // Kinds that operate on tokens and therefore require a target_ref. apply_ae
  // is conditional (target_prompt: "visible" bypasses), handled inline.
  const KINDS_REQUIRING_TARGET_REF = new Set([
    "grant", "consume_charge", "consume_resource", "redirect_target"
  ]);

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------
  function listTriggerKeys() {
    const reg = window["oni.ReactionTriggers"];
    if (!reg?.listTriggers) return null;
    try {
      const triggers = reg.listTriggers();
      const keys = new Set();
      for (const t of triggers ?? []) {
        if (t?.key) keys.add(t.key);
        for (const a of t?.aliases ?? []) keys.add(a);
      }
      return keys.size ? keys : null;
    } catch (_) { return null; }
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
  function lintItem(item, triggerKeys, ownerLabel) {
    const out = [];
    const props = item?.system?.props ?? {};
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
    }
    return out;
  }

  // ------------------------------------------------------------------
  // Cross-document drift: actor copy's effect_ref vs master's (matched
  // by system.uniqueId, the skill template link contract).
  // ------------------------------------------------------------------
  function lintMasterCopyDrift(masterIndex) {
    const out = [];
    for (const actor of (game.actors?.contents ?? [])) {
      for (const item of (actor.items?.contents ?? [])) {
        const uniqueId = String(item?.system?.uniqueId ?? "").trim();
        if (!uniqueId) continue;
        const master = masterIndex.get(uniqueId);
        if (!master) continue;
        if (master.id === item.id) continue; // master == self
        if (item?.system?.props?.isReaction !== true) continue;

        const masterRows = activeRows(master?.system?.props?.reaction_config_table);
        const copyRows   = activeRows(item?.system?.props?.reaction_config_table);

        // Match rows by reaction_trigger; flag any active master row whose
        // ref differs on the copy (most common drift mode).
        for (const mRow of masterRows) {
          const mTrig = String(mRow?.reaction_trigger ?? "").trim();
          const mRef  = String(mRow?.reaction_effect_ref ?? "").trim();
          if (!mTrig || !mRef) continue;
          const cRow = copyRows.find(r => String(r?.reaction_trigger ?? "").trim() === mTrig);
          if (!cRow) continue; // copy doesn't have this trigger — different drift
          const cRef = String(cRow?.reaction_effect_ref ?? "").trim();
          if (cRef === mRef) continue;
          out.push({
            severity: "warning",
            code: "MASTER_COPY_REF_DRIFT",
            owner: `actor "${actor.name}"`,
            itemUuid: item?.uuid ?? null,
            itemName: item?.name ?? "(unnamed)",
            location: `reaction_config_table[${cRow.$key}].reaction_effect_ref`,
            message: `Actor copy's reaction_effect_ref "${cRef || "(blank)"}" diverges from master's "${mRef}" for trigger "${mTrig}". Re-author migration likely required.`
          });
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
  });

  globalThis.FUCompanion        = globalThis.FUCompanion        || {};
  globalThis.FUCompanion.api    = globalThis.FUCompanion.api    || {};
  globalThis.FUCompanion.api.lint = globalThis.FUCompanion.api.lint || {};
  globalThis.FUCompanion.api.lint.runReactionLint = runReactionLint;

  console.debug(`${TAG} Installed. Call FUCompanion.api.lint.runReactionLint() to scan.`);
})();
