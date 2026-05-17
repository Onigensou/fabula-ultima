/**
 * ActiveEffect Reaction Config — Editor UI (Foundry VTT v12)
 * -----------------------------------------------------------------------------
 * Injects a "Reactions" panel into the standard ActiveEffectConfig form (and
 * CSB's CustomActiveEffectConfig) so authors can edit
 *   flags.fabula-ultima-companion.reactionConfig
 * without bridge-patching JSON. Mirrors the schema documented in
 * `modules/fabula-ultima-companion/docs/reaction-config-schema.md`.
 *
 * Persistence: the full reactionConfig blob is serialized into a single
 * hidden form input (`flags.fabula-ultima-companion.reactionConfig`,
 * data-dtype="JSON"). Foundry's standard form submit commits it on Save.
 * Cancel rolls back naturally (no flag write). Per-cell flag paths are
 * deliberately NOT used — see `[[feedback_no_dotted_array_updates]]`.
 *
 * Registry-driven:
 *   - Trigger dropdown reads from `window["oni.ReactionTriggers"]`.
 *   - Effect-kind dropdown reads from `window["oni.ReactionEffectKinds"]`.
 *
 * Pairs with: scripts/reaction-system/reaction-grant.js (dispatcher),
 *             scripts/reaction-system/reaction-triggers.config.js (registry),
 *             scripts/reaction-system/reaction-triggerCore.js (synthesizer).
 */
(() => {
  const TAG = "[ONI][AEReactionUI]";
  const MODULE_ID = "fabula-ultima-companion";

  const HOOK_NAMES = [
    "renderActiveEffectConfig",
    "renderCustomActiveEffectConfig"
  ];

  const PANEL_MARKER_CLASS = "oni-ae-reaction-panel";
  const HIDDEN_INPUT_NAME  = `flags.${MODULE_ID}.reactionConfig`;

  if (globalThis.__ONI_AE_REACTION_UI_INSTALLED__) {
    console.debug(`${TAG} Already installed.`);
    return;
  }
  globalThis.__ONI_AE_REACTION_UI_INSTALLED__ = true;

  // ---------------------------------------------------------------------------
  // Closed-set dropdown options. Sourced from
  // `modules/fabula-ultima-companion/docs/reaction-config-schema.md`.
  // ---------------------------------------------------------------------------
  const REACTION_SOURCE_OPTIONS  = ["self", "ally", "enemy", "neutral", "all"];
  const DAMAGE_TYPE_OPTIONS      = ["physical", "air", "bolt", "dark", "earth", "fire", "ice", "light", "poison"];
  const DEBUFF_TARGET_OPTIONS    = ["self", "ally", "enemy", "all"];
  const OWNERSHIP_OPTIONS        = ["", "own_summon"];
  const ACTION_INTENT_OPTIONS    = ["", "harmful", "aid", "neutral"];
  const PASSIVE_TARGET_OPTIONS   = ["self"];
  const GRANT_RESOURCE_OPTIONS   = ["hp", "mp", "ip", "zero_power", "zenit", "enmity"];
  const GRANT_TARGET_OPTIONS     = ["self", "ally", "enemy", "all"];
  const AE_DUPLICATE_OPTIONS     = ["skip", "replace", "stack", "remove", "ask"];
  const ON_EMPTY_OPTIONS         = ["abort", "skip"];
  const TARGET_SELECT_OPTIONS    = ["first"];

  // ---------------------------------------------------------------------------
  // Component state — module-level, keyed by ActiveEffect uuid.
  // Holds the working copy of the reactionConfig blob while the sheet is open.
  // Cleared on sheet close.
  // ---------------------------------------------------------------------------
  const STATE = new Map();

  function getState(uuid) {
    return STATE.get(uuid) ?? null;
  }
  function setState(uuid, blob) {
    STATE.set(uuid, blob);
  }
  function clearState(uuid) {
    STATE.delete(uuid);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  function escapeHtml(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function deepClone(o) {
    return JSON.parse(JSON.stringify(o ?? null));
  }

  function blankBlob() {
    return { name: "", reaction_config_table: {}, reaction_effect_table: {} };
  }

  function readExistingBlob(effect) {
    const raw = effect?.flags?.[MODULE_ID]?.reactionConfig ?? null;
    if (!raw || typeof raw !== "object") return blankBlob();
    return {
      name: typeof raw.name === "string" ? raw.name : "",
      reaction_config_table: raw.reaction_config_table && typeof raw.reaction_config_table === "object"
        ? deepClone(raw.reaction_config_table) : {},
      reaction_effect_table: raw.reaction_effect_table && typeof raw.reaction_effect_table === "object"
        ? deepClone(raw.reaction_effect_table) : {}
    };
  }

  /** Stable-iterate a keyed-object row table. Ignores $deleted rows. */
  function listLiveRows(table) {
    const out = [];
    if (!table || typeof table !== "object") return out;
    const keys = Object.keys(table).sort((a, b) => {
      const na = Number(a), nb = Number(b);
      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
      return String(a).localeCompare(String(b));
    });
    for (const k of keys) {
      const row = table[k];
      if (!row || typeof row !== "object") continue;
      if (row.$deleted === true) continue;
      out.push({ key: k, row });
    }
    return out;
  }

  function nextRowKey(table) {
    const used = new Set(Object.keys(table ?? {}).map(Number).filter(Number.isFinite));
    let i = 0;
    while (used.has(i)) i++;
    return String(i);
  }

  function blankTriggerRow() {
    return {
      $deleted: false,
      reaction_trigger: "",
      reaction_source: "",
      reaction_damage_type: "",
      reaction_damage_amount: "",
      reaction_debuff_count_target: "",
      reaction_debuff_count_min: "",
      reaction_subject_kind: "",
      reaction_ownership: "",
      reaction_action_intent: "",
      reaction_effect_ref: "",
      reaction_isPassive: false,
      reaction_passive_target: ""
    };
  }

  function blankEffectRow() {
    return {
      $deleted: false,
      effect_label: "",
      effect_kind: "grant",
      grant_resource: "",
      grant_amount: "",
      grant_target: "self",
      ae_template_ref: "",
      ae_duplicate_mode: "replace",
      charge_key: "",
      on_empty: "abort",
      count: "1",
      target_select: "first",
      rebuild_card: true,
      chain_steps: "",
      allowed_types: "",
      free_mode: false,
      max_mp_cost: ""
    };
  }

  // ---------------------------------------------------------------------------
  // Registry access (safe fallbacks if scripts loaded out of order).
  // ---------------------------------------------------------------------------
  function listTriggerEntries() {
    try { return window["oni.ReactionTriggers"]?.listTriggers?.() ?? []; }
    catch (_) { return []; }
  }
  function triggerHasSubject(key) {
    try { return window["oni.ReactionTriggers"]?.subjectShapeFor?.(key) != null; }
    catch (_) { return true; }
  }
  function triggerNeeds(key, filter) {
    try { return (window["oni.ReactionTriggers"]?.filtersFor?.(key) ?? []).includes(filter); }
    catch (_) { return false; }
  }
  function listEffectKinds() {
    try { return window["oni.ReactionEffectKinds"]?.list?.() ?? ["grant"]; }
    catch (_) { return ["grant"]; }
  }

  // ---------------------------------------------------------------------------
  // Per-effect-kind: which fields are relevant. Mirrors the dispatcher switch
  // in reaction-grant.js (search for `applyEffectByLabel`).
  // ---------------------------------------------------------------------------
  const EFFECT_KIND_FIELDS = Object.freeze({
    grant:            ["grant_resource", "grant_amount", "grant_target"],
    apply_ae:         ["ae_template_ref", "grant_target", "ae_duplicate_mode"],
    consume_charge:   ["charge_key", "grant_target", "on_empty", "count"],
    redirect_target:  ["target_select", "rebuild_card"],
    chain:            ["chain_steps"],
    open_action_menu: ["allowed_types", "free_mode", "max_mp_cost"]
  });

  function effectKindFields(kind) {
    return EFFECT_KIND_FIELDS[kind] ?? [];
  }

  // ---------------------------------------------------------------------------
  // HTML builders — small composable pieces.
  // ---------------------------------------------------------------------------
  function selectHtml(name, value, options, opts = {}) {
    const placeholder = opts.placeholder ?? null;
    const labelForBlank = opts.labelForBlank ?? "—";
    const includeBlank = opts.includeBlank ?? options.includes("");
    const labels = opts.labels ?? null;

    const pieces = [];
    if (placeholder !== null) {
      pieces.push(`<option value="" disabled${value ? "" : " selected"}>${escapeHtml(placeholder)}</option>`);
    } else if (includeBlank && !options.includes("")) {
      pieces.push(`<option value=""${value === "" ? " selected" : ""}>${escapeHtml(labelForBlank)}</option>`);
    }
    for (const opt of options) {
      const lbl = labels?.[opt] ?? (opt === "" ? labelForBlank : opt);
      const sel = String(value ?? "") === String(opt) ? " selected" : "";
      pieces.push(`<option value="${escapeHtml(opt)}"${sel}>${escapeHtml(lbl)}</option>`);
    }
    return `<select data-field="${escapeHtml(name)}">${pieces.join("")}</select>`;
  }

  function inputHtml(name, value, opts = {}) {
    const type = opts.type ?? "text";
    const placeholder = opts.placeholder ? ` placeholder="${escapeHtml(opts.placeholder)}"` : "";
    const list = opts.list ? ` list="${escapeHtml(opts.list)}"` : "";
    const min = opts.min !== undefined ? ` min="${escapeHtml(opts.min)}"` : "";
    const step = opts.step !== undefined ? ` step="${escapeHtml(opts.step)}"` : "";
    const v = escapeHtml(value ?? "");
    return `<input type="${type}" data-field="${escapeHtml(name)}" value="${v}"${placeholder}${list}${min}${step}>`;
  }

  function checkboxHtml(name, value) {
    const checked = value ? " checked" : "";
    return `<input type="checkbox" data-field="${escapeHtml(name)}"${checked}>`;
  }

  function formRow(label, controlHtml, fieldName, notes = "") {
    const dataAttr = fieldName ? ` data-row-field="${escapeHtml(fieldName)}"` : "";
    const notesHtml = notes ? `<p class="notes">${escapeHtml(notes)}</p>` : "";
    return `
      <div class="form-group"${dataAttr}>
        <label>${escapeHtml(label)}</label>
        <div class="form-fields">${controlHtml}</div>
        ${notesHtml}
      </div>
    `;
  }

  // ---------------------------------------------------------------------------
  // Trigger-row card
  // ---------------------------------------------------------------------------
  function buildTriggerOptions() {
    const entries = listTriggerEntries();
    const pieces = [`<option value="">— Select Trigger —</option>`];
    for (const e of entries) {
      pieces.push(`<option value="${escapeHtml(e.key)}">${escapeHtml(e.label || e.key)}</option>`);
    }
    return pieces.join("");
  }

  function buildTriggerRowHtml(rowKey, row, effectLabelDatalistId) {
    const triggerOptions = buildTriggerOptions();
    // Inject the selected attribute by post-processing — keeps buildTriggerOptions cheap to call.
    const selectedTrigger = String(row.reaction_trigger ?? "");
    const triggerHtml = triggerOptions.replace(
      new RegExp(`<option value="${escapeRegex(escapeHtml(selectedTrigger))}"`),
      `<option value="${escapeHtml(selectedTrigger)}" selected`
    );

    return `
      <div class="oni-row oni-trigger-row" data-row-key="${escapeHtml(rowKey)}">
        <header class="oni-row-header">
          <span class="oni-row-title">Trigger #${escapeHtml(rowKey)}</span>
          <button type="button" class="oni-row-delete" data-action="delete-trigger-row" title="Delete this trigger row">
            <i class="fas fa-trash"></i>
          </button>
        </header>
        ${formRow("Trigger", `<select data-field="reaction_trigger">${triggerHtml}</select>`, "reaction_trigger")}
        ${formRow("Source", selectHtml("reaction_source", row.reaction_source ?? "", REACTION_SOURCE_OPTIONS, { includeBlank: true, labelForBlank: "(any)" }), "reaction_source")}
        ${formRow("Damage Type", selectHtml("reaction_damage_type", row.reaction_damage_type ?? "", DAMAGE_TYPE_OPTIONS, { includeBlank: true, labelForBlank: "(any)" }), "reaction_damage_type")}
        ${formRow("Min Damage Amount", inputHtml("reaction_damage_amount", row.reaction_damage_amount ?? "", { type: "number", min: 0, step: 1, placeholder: "(any)" }), "reaction_damage_amount")}
        ${formRow("Debuff Count — Target", selectHtml("reaction_debuff_count_target", row.reaction_debuff_count_target ?? "", DEBUFF_TARGET_OPTIONS, { includeBlank: true, labelForBlank: "(disabled)" }), "reaction_debuff_count_target")}
        ${formRow("Debuff Count — Min", inputHtml("reaction_debuff_count_min", row.reaction_debuff_count_min ?? "", { type: "number", min: 0, step: 1, placeholder: "(disabled)" }), "reaction_debuff_count_min")}
        ${formRow("Subject Kind Flag", inputHtml("reaction_subject_kind", row.reaction_subject_kind ?? "", { placeholder: "e.g. isPhantasm" }), "reaction_subject_kind", "actor.system.props.<this> must be truthy")}
        ${formRow("Ownership", selectHtml("reaction_ownership", row.reaction_ownership ?? "", OWNERSHIP_OPTIONS, { labels: { "": "(any)", "own_summon": "Own Summon" } }), "reaction_ownership")}
        ${formRow("Action Intent", selectHtml("reaction_action_intent", row.reaction_action_intent ?? "", ACTION_INTENT_OPTIONS, { labels: { "": "(any)", "harmful": "Harmful", "aid": "Aid", "neutral": "Neutral" } }), "reaction_action_intent")}
        ${formRow("Effect Ref", inputHtml("reaction_effect_ref", row.reaction_effect_ref ?? "", { list: effectLabelDatalistId, placeholder: "(none — picker only)" }), "reaction_effect_ref", "Matches an effect_label in the effects table below")}
        ${formRow("Passive (auto-fire)", checkboxHtml("reaction_isPassive", !!row.reaction_isPassive), "reaction_isPassive")}
        ${formRow("Passive Target", selectHtml("reaction_passive_target", row.reaction_passive_target ?? "", PASSIVE_TARGET_OPTIONS, { includeBlank: true, labelForBlank: "(none)" }), "reaction_passive_target")}
      </div>
    `;
  }

  function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // ---------------------------------------------------------------------------
  // Effect-row card
  // ---------------------------------------------------------------------------
  function buildEffectKindOptions(selectedKind) {
    const kinds = listEffectKinds();
    const pieces = [];
    for (const k of kinds) {
      const sel = String(selectedKind ?? "") === k ? " selected" : "";
      pieces.push(`<option value="${escapeHtml(k)}"${sel}>${escapeHtml(k)}</option>`);
    }
    return pieces.join("");
  }

  function buildEffectRowHtml(rowKey, row) {
    return `
      <div class="oni-row oni-effect-row" data-row-key="${escapeHtml(rowKey)}">
        <header class="oni-row-header">
          <span class="oni-row-title">Effect #${escapeHtml(rowKey)}</span>
          <button type="button" class="oni-row-delete" data-action="delete-effect-row" title="Delete this effect row">
            <i class="fas fa-trash"></i>
          </button>
        </header>
        ${formRow("Label", inputHtml("effect_label", row.effect_label ?? "", { placeholder: "Unique id (trigger rows reference this)" }), "effect_label")}
        ${formRow("Kind", `<select data-field="effect_kind">${buildEffectKindOptions(row.effect_kind ?? "grant")}</select>`, "effect_kind")}

        ${formRow("Resource", selectHtml("grant_resource", row.grant_resource ?? "", GRANT_RESOURCE_OPTIONS, { includeBlank: true, labelForBlank: "(disabled)" }), "grant_resource")}
        ${formRow("Amount", inputHtml("grant_amount", row.grant_amount ?? "", { type: "number", step: 1, placeholder: "(positive grants, negative drains)" }), "grant_amount")}
        ${formRow("Target", selectHtml("grant_target", row.grant_target ?? "self", GRANT_TARGET_OPTIONS), "grant_target")}

        ${formRow("AE Template Ref", inputHtml("ae_template_ref", row.ae_template_ref ?? "", { placeholder: "AE name or Item.x.ActiveEffect.y UUID" }), "ae_template_ref")}
        ${formRow("Duplicate Mode", selectHtml("ae_duplicate_mode", row.ae_duplicate_mode ?? "replace", AE_DUPLICATE_OPTIONS), "ae_duplicate_mode")}

        ${formRow("Charge Key", inputHtml("charge_key", row.charge_key ?? "", { placeholder: "e.g. protect" }), "charge_key")}
        ${formRow("On Empty", selectHtml("on_empty", row.on_empty ?? "abort", ON_EMPTY_OPTIONS), "on_empty")}
        ${formRow("Count", inputHtml("count", row.count ?? "1", { type: "number", min: 1, step: 1 }), "count")}

        ${formRow("Target Slot", selectHtml("target_select", row.target_select ?? "first", TARGET_SELECT_OPTIONS), "target_select")}
        ${formRow("Rebuild Card", checkboxHtml("rebuild_card", row.rebuild_card !== false), "rebuild_card")}

        ${formRow("Chain Steps", inputHtml("chain_steps", row.chain_steps ?? "", { placeholder: "label1, label2, label3" }), "chain_steps", "Comma-separated effect_labels")}

        ${formRow("Allowed Action Types", inputHtml("allowed_types", row.allowed_types ?? "", { placeholder: "Attack,Spell" }), "allowed_types", "Comma-separated TurnUI labels")}
        ${formRow("Free Mode", checkboxHtml("free_mode", !!row.free_mode), "free_mode")}
        ${formRow("Max MP Cost", inputHtml("max_mp_cost", row.max_mp_cost ?? "", { type: "number", min: 0, step: 1, placeholder: "(no cap)" }), "max_mp_cost")}
      </div>
    `;
  }

  // ---------------------------------------------------------------------------
  // Visibility
  // ---------------------------------------------------------------------------
  function applyTriggerRowVisibility(rowEl, triggerKey) {
    const hasSubject = triggerHasSubject(triggerKey);
    const hasDamageType  = triggerNeeds(triggerKey, "damage_type");
    const hasDamageAmt   = triggerNeeds(triggerKey, "damage_amount");
    const hasDebuffCount = triggerNeeds(triggerKey, "debuff_count");
    const isPassive = !!rowEl.querySelector('[data-field="reaction_isPassive"]')?.checked;

    const visibility = {
      reaction_source:               hasSubject,
      reaction_damage_type:          hasDamageType,
      reaction_damage_amount:        hasDamageAmt,
      reaction_debuff_count_target:  hasDebuffCount,
      reaction_debuff_count_min:     hasDebuffCount,
      reaction_subject_kind:         hasSubject,
      reaction_ownership:            hasSubject,
      reaction_action_intent:        hasSubject,
      reaction_passive_target:       isPassive
    };

    for (const [field, show] of Object.entries(visibility)) {
      const cell = rowEl.querySelector(`[data-row-field="${field}"]`);
      if (cell) cell.style.display = show ? "" : "none";
    }
  }

  function applyEffectRowVisibility(rowEl, effectKind) {
    const fields = new Set(effectKindFields(effectKind));
    // Label + kind are always visible.
    const allFields = new Set([
      "grant_resource", "grant_amount", "grant_target",
      "ae_template_ref", "ae_duplicate_mode",
      "charge_key", "on_empty", "count",
      "target_select", "rebuild_card",
      "chain_steps",
      "allowed_types", "free_mode", "max_mp_cost"
    ]);
    for (const f of allFields) {
      const cell = rowEl.querySelector(`[data-row-field="${f}"]`);
      if (cell) cell.style.display = fields.has(f) ? "" : "none";
    }
  }

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------
  function validate(blob) {
    const warnings = [];
    const triggerRows = listLiveRows(blob.reaction_config_table);
    const effectRows  = listLiveRows(blob.reaction_effect_table);

    const labels = effectRows.map(r => String(r.row.effect_label ?? "").trim()).filter(Boolean);
    const labelSet = new Set(labels);
    const dupLabels = labels.filter((l, i) => labels.indexOf(l) !== i);

    for (const dup of new Set(dupLabels)) {
      warnings.push(`Two or more effect rows share label "${dup}" — findEffectByLabel will silently pick one.`);
    }

    for (const { key, row } of triggerRows) {
      const ref = String(row.reaction_effect_ref ?? "").trim();
      if (ref && !labelSet.has(ref)) {
        warnings.push(`Trigger #${key} references effect_label "${ref}" which doesn't exist.`);
      }
      if (row.reaction_isPassive && !String(row.reaction_passive_target ?? "").trim()) {
        warnings.push(`Trigger #${key} is passive but has no reaction_passive_target set.`);
      }
    }

    return warnings;
  }

  // ---------------------------------------------------------------------------
  // Panel HTML
  // ---------------------------------------------------------------------------
  function buildEffectLabelDatalistHtml(datalistId, blob) {
    const labels = listLiveRows(blob.reaction_effect_table)
      .map(r => String(r.row.effect_label ?? "").trim())
      .filter(Boolean);
    const unique = Array.from(new Set(labels));
    return `<datalist id="${escapeHtml(datalistId)}">${unique.map(l => `<option value="${escapeHtml(l)}">`).join("")}</datalist>`;
  }

  function buildValidationBannerHtml(warnings) {
    if (!warnings.length) return `<div class="oni-validation-banner" data-empty="true" style="display:none;"></div>`;
    const items = warnings.map(w => `<li>${escapeHtml(w)}</li>`).join("");
    return `
      <div class="oni-validation-banner" data-empty="false" style="background:#fff3cd; border:1px solid #ffeeba; padding:.4rem .6rem; border-radius:4px; margin:.4rem 0;">
        <strong>Reaction config warnings</strong>
        <ul style="margin:.2rem 0 0; padding-left:1.2rem;">${items}</ul>
      </div>
    `;
  }

  function buildPanelHtml(effect, blob) {
    const datalistId = `oni-effect-labels-${escapeHtml(effect?.id ?? "x")}`;
    const triggerRows = listLiveRows(blob.reaction_config_table);
    const effectRows  = listLiveRows(blob.reaction_effect_table);
    const triggersHtml = triggerRows.length
      ? triggerRows.map(({ key, row }) => buildTriggerRowHtml(key, row, datalistId)).join("")
      : `<p class="notes" data-empty-trigger>No trigger rows. Click "Add Trigger Row" to start.</p>`;
    const effectsHtml = effectRows.length
      ? effectRows.map(({ key, row }) => buildEffectRowHtml(key, row)).join("")
      : `<p class="notes" data-empty-effect>No effect rows. Trigger rows need an effect to do anything besides surface in the reaction picker.</p>`;
    const warnings = validate(blob);
    const hiddenValue = escapeHtml(JSON.stringify(blob));

    return `
      <details class="${PANEL_MARKER_CLASS}" open style="margin-top:.5rem; border:1px solid var(--color-border-light-tertiary, #999); border-radius:4px; padding:.4rem .6rem;">
        <summary style="font-weight:600; cursor:pointer;">Reactions (Fabula Ultima)</summary>

        <input type="hidden" name="${HIDDEN_INPUT_NAME}" data-dtype="JSON" value="${hiddenValue}">

        ${buildEffectLabelDatalistHtml(datalistId, blob)}

        <div class="form-group" style="margin-top:.5rem;">
          <label>Reaction Name</label>
          <div class="form-fields">
            <input type="text" data-field="reaction_name" value="${escapeHtml(blob.name ?? "")}" placeholder="(defaults to AE name)">
          </div>
          <p class="notes">Shown in the reaction picker when this AE's config matches.</p>
        </div>

        <div class="oni-validation-host">${buildValidationBannerHtml(warnings)}</div>

        <fieldset style="margin-top:.5rem;">
          <legend>Trigger Rows</legend>
          <div class="oni-trigger-rows" style="max-height:280px; overflow:auto; display:flex; flex-direction:column; gap:.4rem;">
            ${triggersHtml}
          </div>
          <button type="button" data-action="add-trigger-row" style="margin-top:.4rem;">
            <i class="fas fa-plus"></i> Add Trigger Row
          </button>
        </fieldset>

        <fieldset style="margin-top:.5rem;">
          <legend>Effect Rows</legend>
          <div class="oni-effect-rows" style="max-height:280px; overflow:auto; display:flex; flex-direction:column; gap:.4rem;">
            ${effectsHtml}
          </div>
          <button type="button" data-action="add-effect-row" style="margin-top:.4rem;">
            <i class="fas fa-plus"></i> Add Effect Row
          </button>
        </fieldset>

        <p class="notes" style="margin-top:.4rem;">
          Edits commit on <strong>Save</strong>. Close without saving to discard.
          Schema reference: <code>modules/fabula-ultima-companion/docs/reaction-config-schema.md</code>.
        </p>
      </details>
    `;
  }

  // ---------------------------------------------------------------------------
  // Reconciliation: pull form values back into the blob.
  // ---------------------------------------------------------------------------
  function readTriggerRowFromDom(rowEl) {
    const out = { $deleted: false };
    rowEl.querySelectorAll("[data-field]").forEach(el => {
      const name = el.getAttribute("data-field");
      if (!name) return;
      if (el.type === "checkbox") out[name] = !!el.checked;
      else out[name] = el.value;
    });
    return out;
  }

  function readEffectRowFromDom(rowEl) {
    const out = { $deleted: false };
    rowEl.querySelectorAll("[data-field]").forEach(el => {
      const name = el.getAttribute("data-field");
      if (!name) return;
      if (el.type === "checkbox") out[name] = !!el.checked;
      else out[name] = el.value;
    });
    return out;
  }

  function rebuildBlobFromDom(panelEl, blob) {
    blob.name = panelEl.querySelector('[data-field="reaction_name"]')?.value ?? "";

    const triggerRows = panelEl.querySelectorAll(".oni-trigger-row");
    const newTriggers = {};
    triggerRows.forEach(rowEl => {
      const key = rowEl.getAttribute("data-row-key");
      if (!key) return;
      newTriggers[key] = readTriggerRowFromDom(rowEl);
    });
    blob.reaction_config_table = newTriggers;

    const effectRows = panelEl.querySelectorAll(".oni-effect-row");
    const newEffects = {};
    effectRows.forEach(rowEl => {
      const key = rowEl.getAttribute("data-row-key");
      if (!key) return;
      newEffects[key] = readEffectRowFromDom(rowEl);
    });
    blob.reaction_effect_table = newEffects;
  }

  function serializeBlobToHiddenInput(panelEl, blob) {
    const hidden = panelEl.querySelector(`input[name="${HIDDEN_INPUT_NAME}"]`);
    if (hidden) hidden.value = JSON.stringify(blob);
  }

  function refreshValidationBanner(panelEl, blob) {
    const host = panelEl.querySelector(".oni-validation-host");
    if (!host) return;
    host.innerHTML = buildValidationBannerHtml(validate(blob));
  }

  function refreshEffectLabelDatalist(panelEl, effect, blob) {
    const datalistId = `oni-effect-labels-${effect?.id ?? "x"}`;
    const old = panelEl.querySelector(`datalist#${CSS.escape(datalistId)}`);
    if (!old) return;
    const wrapper = document.createElement("div");
    wrapper.innerHTML = buildEffectLabelDatalistHtml(datalistId, blob);
    old.replaceWith(wrapper.firstElementChild);
  }

  function refreshAllVisibility(panelEl) {
    panelEl.querySelectorAll(".oni-trigger-row").forEach(rowEl => {
      const triggerKey = rowEl.querySelector('[data-field="reaction_trigger"]')?.value ?? "";
      applyTriggerRowVisibility(rowEl, triggerKey);
    });
    panelEl.querySelectorAll(".oni-effect-row").forEach(rowEl => {
      const kind = rowEl.querySelector('[data-field="effect_kind"]')?.value ?? "grant";
      applyEffectRowVisibility(rowEl, kind);
    });
  }

  // ---------------------------------------------------------------------------
  // Event wiring
  // ---------------------------------------------------------------------------
  function attachListeners(panelEl, effect, app) {
    const uuid = effect.uuid;

    const onChange = (ev) => {
      const target = ev.target;
      if (!target?.matches?.("[data-field]")) return;
      const blob = getState(uuid);
      if (!blob) return;
      rebuildBlobFromDom(panelEl, blob);
      setState(uuid, blob);
      serializeBlobToHiddenInput(panelEl, blob);

      // Field-specific UI side effects:
      const field = target.getAttribute("data-field");
      const rowEl = target.closest(".oni-trigger-row, .oni-effect-row");

      if (rowEl?.classList.contains("oni-trigger-row")) {
        if (field === "reaction_trigger" || field === "reaction_isPassive") {
          const trig = rowEl.querySelector('[data-field="reaction_trigger"]')?.value ?? "";
          applyTriggerRowVisibility(rowEl, trig);
        }
      } else if (rowEl?.classList.contains("oni-effect-row")) {
        if (field === "effect_kind") {
          applyEffectRowVisibility(rowEl, target.value);
        }
        if (field === "effect_label") {
          refreshEffectLabelDatalist(panelEl, effect, blob);
        }
      }

      refreshValidationBanner(panelEl, blob);
    };

    panelEl.addEventListener("change", onChange);
    panelEl.addEventListener("input", onChange);

    panelEl.addEventListener("click", async (ev) => {
      const btn = ev.target?.closest?.("[data-action]");
      if (!btn) return;
      const action = btn.getAttribute("data-action");

      if (action === "add-trigger-row") {
        ev.preventDefault();
        const blob = getState(uuid);
        if (!blob) return;
        const key = nextRowKey(blob.reaction_config_table);
        blob.reaction_config_table[key] = blankTriggerRow();
        setState(uuid, blob);
        rerenderPanel(panelEl, effect, app);
      } else if (action === "add-effect-row") {
        ev.preventDefault();
        const blob = getState(uuid);
        if (!blob) return;
        const key = nextRowKey(blob.reaction_effect_table);
        blob.reaction_effect_table[key] = blankEffectRow();
        setState(uuid, blob);
        rerenderPanel(panelEl, effect, app);
      } else if (action === "delete-trigger-row" || action === "delete-effect-row") {
        ev.preventDefault();
        const rowEl = btn.closest("[data-row-key]");
        if (!rowEl) return;
        const key = rowEl.getAttribute("data-row-key");
        const tableField = action === "delete-trigger-row"
          ? "reaction_config_table"
          : "reaction_effect_table";
        const confirmed = await Dialog.confirm({
          title: "Delete row",
          content: `<p>Delete this ${action === "delete-trigger-row" ? "trigger" : "effect"} row?</p>`,
          defaultYes: false
        });
        if (!confirmed) return;
        const blob = getState(uuid);
        if (!blob) return;
        delete blob[tableField][key];
        setState(uuid, blob);
        rerenderPanel(panelEl, effect, app);
      }
    });
  }

  function rerenderPanel(panelEl, effect, app) {
    const blob = getState(effect.uuid) ?? blankBlob();
    // Preserve <details> open state.
    const wasOpen = panelEl.open !== false;
    const fresh = document.createElement("template");
    fresh.innerHTML = buildPanelHtml(effect, blob).trim();
    const freshPanel = fresh.content.firstElementChild;
    if (!freshPanel) return;
    if (wasOpen) freshPanel.setAttribute("open", "");
    panelEl.replaceWith(freshPanel);
    refreshAllVisibility(freshPanel);
    attachListeners(freshPanel, effect, app);
    try { app.setPosition?.({ height: "auto" }); } catch (_) {}
  }

  // ---------------------------------------------------------------------------
  // Insertion anchor — append to existing Details tab (mirrors charges-ui).
  // ---------------------------------------------------------------------------
  function locateInsertionAnchor(formEl) {
    const detailsTab = formEl.querySelector('.tab[data-tab="details"]');
    if (detailsTab) return { node: detailsTab, mode: "append" };

    const submitRow = formEl.querySelector('button[type="submit"]')?.closest("footer, .form-footer, .sheet-footer, .form-buttons");
    if (submitRow) return { node: submitRow, mode: "before" };

    return { node: formEl, mode: "append" };
  }

  function insertPanel(formEl, panelHtml) {
    const tpl = document.createElement("template");
    tpl.innerHTML = panelHtml.trim();
    const panel = tpl.content.firstElementChild;
    if (!panel) return null;

    const { node, mode } = locateInsertionAnchor(formEl);
    if (mode === "append") node.appendChild(panel);
    else if (mode === "after") node.insertAdjacentElement("afterend", panel);
    else if (mode === "before") node.insertAdjacentElement("beforebegin", panel);
    return panel;
  }

  // ---------------------------------------------------------------------------
  // Render hook
  // ---------------------------------------------------------------------------
  function onRenderConfig(app, html /*, data */) {
    try {
      const root = (html instanceof jQuery) ? html[0] : html;
      if (!root) return;

      const formEl = root.matches?.("form") ? root : root.querySelector?.("form");
      if (!formEl) return;

      // Idempotent — don't double-inject if Foundry re-renders the same window.
      if (formEl.querySelector(`details.${PANEL_MARKER_CLASS}`)) return;

      const effect = app?.object ?? app?.document ?? null;
      if (!effect) return;
      if (effect.documentName !== "ActiveEffect") return;

      // Hydrate component state — keep existing state if the same sheet
      // re-renders (e.g. after a setPosition flush), otherwise start fresh
      // from the document's current flag.
      if (!STATE.has(effect.uuid)) {
        setState(effect.uuid, readExistingBlob(effect));
      }
      const blob = getState(effect.uuid);

      const panelHtml = buildPanelHtml(effect, blob);
      const panel = insertPanel(formEl, panelHtml);
      if (!panel) return;

      refreshAllVisibility(panel);
      attachListeners(panel, effect, app);

      // Re-trigger the form-application's height calculation so the new
      // panel isn't clipped by an over-tight default size.
      try { app.setPosition?.({ height: "auto" }); } catch (_) {}

      console.log(`${TAG} Injected reaction panel`, {
        appName: app?.constructor?.name ?? "(unknown)",
        effectName: effect?.name ?? null,
        triggerRows: Object.keys(blob.reaction_config_table ?? {}).length,
        effectRows:  Object.keys(blob.reaction_effect_table ?? {}).length
      });
    } catch (e) {
      console.warn(`${TAG} render hook failed`, e);
    }
  }

  for (const hookName of HOOK_NAMES) {
    Hooks.on(hookName, onRenderConfig);
  }

  // Clean up component state when the sheet closes (covers both Save and Cancel).
  Hooks.on("closeActiveEffectConfig", (app) => {
    try { clearState(app?.object?.uuid ?? app?.document?.uuid); } catch (_) {}
  });
  Hooks.on("closeCustomActiveEffectConfig", (app) => {
    try { clearState(app?.object?.uuid ?? app?.document?.uuid); } catch (_) {}
  });

  // Belt-and-braces JSON parsing: if Foundry's form parser doesn't honor
  // data-dtype="JSON" on hidden inputs in this version, parse the raw string
  // in a preUpdateActiveEffect hook.
  Hooks.on("preUpdateActiveEffect", (effect, change /*, options, userId */) => {
    try {
      const raw = foundry.utils.getProperty(change ?? {}, `flags.${MODULE_ID}.reactionConfig`);
      if (typeof raw !== "string") return;
      const parsed = JSON.parse(raw);
      foundry.utils.setProperty(change, `flags.${MODULE_ID}.reactionConfig`, parsed);
    } catch (e) {
      console.warn(`${TAG} preUpdate JSON parse failed (left raw)`, e);
    }
  });

  console.debug(`${TAG} Installed; will inject on:`, HOOK_NAMES.join(", "));
})();
