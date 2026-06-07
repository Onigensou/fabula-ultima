/**
 * [ONI] Visibility Preset Picker — CSB
 * ---------------------------------------------------------------------------
 * Adds a "Visibility preset" dropdown ABOVE CSB's existing
 * `visibilityFormula` input in the per-component config dialog. Picking a
 * preset fills the formula field; users can still edit afterward or write
 * their own.
 *
 * Why: per-cell visibility formulas are tedious to author by hand
 * (especially for reaction-table cells that all share the same
 * `triggerNeeds(...)` shape). The preset list is mostly auto-derived from
 * `oni.ReactionTriggers.filtersFor()` so adding a new filter-tagged trigger
 * to the registry surfaces a new preset automatically.
 *
 * Pure additive UI: no persistence overrides, no rowLayout changes, no
 * component subclasses. The dropdown sets the existing input's value and
 * dispatches `input`/`change` so CSB's form-data flow saves it normally.
 *
 * Works for every CSB component config dialog, not just our reaction tables.
 * Sits dormant on "(custom)" if the user wants to type a formula.
 */
Hooks.once("ready", () => {
  const TAG = "[VisibilityPresets]";

  if (globalThis.__ONI_VISIBILITY_PRESET_PICKER_INSTALLED__) {
    console.log(`${TAG} Already installed.`);
    return;
  }
  globalThis.__ONI_VISIBILITY_PRESET_PICKER_INSTALLED__ = true;

  // --------------------------------------------------------------------------
  // Preset registry — built lazily so the trigger registry is loaded.
  // --------------------------------------------------------------------------
  function buildPresetGroups() {
    const groups = [
      {
        label: "General",
        items: [
          { label: "Always show", formula: "" }
        ]
      }
    ];

    const reg = window["oni.ReactionTriggers"];
    if (reg?.listTriggers) {
      const filterSet = new Set();
      for (const t of reg.listTriggers()) {
        for (const f of (t.filters ?? [])) filterSet.add(f);
      }
      const triggerItems = [
        {
          label: "Show when trigger has a subject (source filter applies)",
          formula: 'triggerHasSubject(sameRow("reaction_trigger",\'\'))'
        }
      ];
      for (const filter of [...filterSet].sort()) {
        triggerItems.push({
          label: `Show for triggers needing "${filter}"`,
          formula: `triggerNeeds(sameRow("reaction_trigger",''), "${filter}")`
        });
      }
      groups.push({ label: "Reaction triggers", items: triggerItems });
    }

    groups.push({
      label: "Effect kinds (reaction_effect_table)",
      items: [
        { label: 'Show when effect_kind = "grant"',          formula: 'equalText(sameRow("effect_kind",\'\'), "grant")' },
        { label: 'Show when effect_kind = "apply_ae"',       formula: 'equalText(sameRow("effect_kind",\'\'), "apply_ae")' },
        { label: 'Show when effect_kind = "consume_charge"', formula: 'equalText(sameRow("effect_kind",\'\'), "consume_charge")' }
      ]
    });

    groups.push({
      label: "Same-row value checks",
      items: [
        { label: 'Show when firing mode auto-fires (on/force)', formula: 'equalText(sameRow("reaction_passive_mode",\'\'), "on") || equalText(sameRow("reaction_passive_mode",\'\'), "force")' }
      ]
    });

    return groups;
  }

  // --------------------------------------------------------------------------
  // Injection
  // --------------------------------------------------------------------------
  function injectPicker(root, appId) {
    if (!root) return;
    if (root.querySelector(".oni-vpr-picker")) return; // idempotent

    const input = root.querySelector('.compVisible')
               ?? root.querySelector('input[name="visibilityFormula"]');
    if (!input) return;

    const formField = input.closest(".custom-system-form-field") ?? input.parentElement;
    if (!formField || !formField.parentNode) return;

    const wrapper = document.createElement("div");
    wrapper.className = "oni-vpr-picker custom-system-form-field";

    const label = document.createElement("label");
    label.setAttribute("for", `oni-vpr-${appId}`);
    label.textContent = "Visibility preset";
    wrapper.appendChild(label);

    const select = document.createElement("select");
    select.id = `oni-vpr-${appId}`;

    const customOpt = document.createElement("option");
    customOpt.value = "__custom__";
    customOpt.textContent = "— (custom; leave formula as is)";
    customOpt.selected = true;
    select.appendChild(customOpt);

    for (const group of buildPresetGroups()) {
      const optGroup = document.createElement("optgroup");
      optGroup.label = group.label;
      for (const item of group.items) {
        const opt = document.createElement("option");
        opt.value = item.formula;
        opt.textContent = item.label;
        optGroup.appendChild(opt);
      }
      select.appendChild(optGroup);
    }

    select.addEventListener("change", (ev) => {
      ev.stopPropagation();
      if (select.value === "__custom__") return;
      input.value = select.value;
      input.dispatchEvent(new Event("input",  { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      // Reset to "(custom)" so re-picking the same option works.
      select.value = "__custom__";
    });

    wrapper.appendChild(select);

    const hint = document.createElement("p");
    hint.className = "oni-vpr-hint";
    hint.textContent = "Pick a preset to fill the formula below; you can still edit it afterwards.";
    wrapper.appendChild(hint);

    // Place the picker IMMEDIATELY ABOVE the visibility-formula form field
    // so the relationship is visually obvious.
    formField.parentNode.insertBefore(wrapper, formField);
  }

  // --------------------------------------------------------------------------
  // Styles (light, scoped)
  // --------------------------------------------------------------------------
  const STYLE_ID = "oni-vpr-style";
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .oni-vpr-picker select {
        width: 100%;
        font-size: .9em;
      }
      .oni-vpr-picker .oni-vpr-hint {
        font-size: .8em;
        opacity: .75;
        margin: .25em 0 0 0;
      }
    `;
    document.head.appendChild(style);
  }

  // --------------------------------------------------------------------------
  // Hook
  // --------------------------------------------------------------------------
  Hooks.on("renderComponentSettingsApplication", (app, htmlEl) => {
    try {
      const root = htmlEl instanceof jQuery ? htmlEl[0] : htmlEl;
      injectPicker(root, app.id);
    } catch (e) {
      console.warn(`${TAG} injection failed`, e);
    }
  });

  console.debug(`${TAG} Installed.`);
});
