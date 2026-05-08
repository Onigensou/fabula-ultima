/**
 * ActiveEffect Charges — Config UI Patch (Foundry VTT v12)
 * -----------------------------------------------------------------------------
 * Injects a "Charges (Fabula Ultima)" fieldset into the standard
 * ActiveEffectConfig form (and CSB's CustomActiveEffectConfig) so authors
 * never have to type the flag paths consumed by FUCompanion.api.charges.
 *
 * The injected inputs are named with their flag paths
 *   flags.fabula-ultima-companion.charges
 *   flags.fabula-ultima-companion.chargesMax
 *   flags.fabula-ultima-companion.chargeKey
 * so Foundry's standard form-data parser writes the flags on Save with no
 * extra submit hook required. Existing flag values are prefilled.
 *
 * Pairs with: ActiveEffectManager-charges.js (the runtime API).
 */
(() => {
  const TAG = "[ONI][AECharges:UI]";
  const MODULE_ID = "fabula-ultima-companion";

  const HOOK_NAMES = [
    "renderActiveEffectConfig",
    "renderCustomActiveEffectConfig"
  ];

  const PANEL_MARKER_CLASS = "oni-ae-charges-panel";

  if (globalThis.__ONI_AE_CHARGES_UI_INSTALLED__) {
    console.log(`${TAG} Already installed.`);
    return;
  }
  globalThis.__ONI_AE_CHARGES_UI_INSTALLED__ = true;

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  function safeInt(v, fb = "") {
    if (v === null || v === undefined || v === "") return fb;
    const n = Number(v);
    return Number.isFinite(n) ? n : fb;
  }

  function readExistingFlags(effect) {
    const flags = effect?.flags?.[MODULE_ID] ?? {};
    return {
      charges:    safeInt(flags.charges, ""),
      chargesMax: safeInt(flags.chargesMax, ""),
      chargeKey:  (typeof flags.chargeKey === "string" ? flags.chargeKey : "")
    };
  }

  function buildPanelHtml({ charges, chargesMax, chargeKey }) {
    const c = charges === "" ? "" : String(charges);
    const m = chargesMax === "" ? "" : String(chargesMax);
    const k = String(chargeKey ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");

    return `
      <fieldset class="${PANEL_MARKER_CLASS}" style="margin-top: .5rem;">
        <legend>Charges (Fabula Ultima)</legend>

        <div class="form-group">
          <label>Charges</label>
          <div class="form-fields">
            <input type="number"
                   name="flags.${MODULE_ID}.charges"
                   data-dtype="Number"
                   step="1"
                   min="0"
                   value="${c}"
                   placeholder="(blank = not charged)">
          </div>
          <p class="notes">Current uses left. Blank or 0 = not a charged effect; the AE auto-deletes when this hits 0.</p>
        </div>

        <div class="form-group">
          <label>Charges Max</label>
          <div class="form-fields">
            <input type="number"
                   name="flags.${MODULE_ID}.chargesMax"
                   data-dtype="Number"
                   step="1"
                   min="0"
                   value="${m}"
                   placeholder="(optional)">
          </div>
          <p class="notes">Optional. Display-only; not enforced. Use to show "2 / 2" in custom UI.</p>
        </div>

        <div class="form-group">
          <label>Charge Key</label>
          <div class="form-fields">
            <input type="text"
                   name="flags.${MODULE_ID}.chargeKey"
                   value="${k}"
                   placeholder="e.g. divination">
          </div>
          <p class="notes">Feature identifier so consumers (Divination button, future skills) only consume their own charges. Leave blank for "any charged AE".</p>
        </div>
      </fieldset>
    `;
  }

  // ---------------------------------------------------------------------------
  // Inject into the rendered config form
  // ---------------------------------------------------------------------------
  // Strategy: pick the most appropriate insertion point in the form.
  //
  //   1. If the form has a "details" tab (.tab[data-tab="details"]) — append there.
  //   2. Otherwise, if the form has a fieldset.form-section near the top — append after.
  //   3. Otherwise, append before the form's submit button row.
  //
  // We only inject once per render; if the panel already exists, skip.
  function locateInsertionAnchor(formEl) {
    const detailsTab = formEl.querySelector('.tab[data-tab="details"]');
    if (detailsTab) return { node: detailsTab, mode: "append" };

    const firstFieldset = formEl.querySelector("fieldset");
    if (firstFieldset && firstFieldset.parentElement === formEl) {
      return { node: firstFieldset, mode: "after" };
    }

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

  function onRenderConfig(app, html /*, data */) {
    try {
      const root = (html instanceof jQuery) ? html[0] : html;
      if (!root) return;

      const formEl = root.matches?.("form") ? root : root.querySelector?.("form");
      if (!formEl) return;

      // Idempotent — don't double-inject if Foundry re-renders the same window.
      if (formEl.querySelector(`fieldset.${PANEL_MARKER_CLASS}`)) return;

      const effect = app?.object ?? app?.document ?? null;
      if (!effect) return;

      const html2 = buildPanelHtml(readExistingFlags(effect));
      const panel = insertPanel(formEl, html2);

      // Re-trigger the form-application's height calculation so the new
      // fieldset isn't clipped by an over-tight default size.
      try { app.setPosition?.({ height: "auto" }); } catch (_) {}

      if (panel) {
        console.log(`${TAG} Injected charges panel`, {
          appName: app?.constructor?.name ?? "(unknown)",
          effectName: effect?.name ?? effect?.label ?? null
        });
      }
    } catch (e) {
      console.warn(`${TAG} render hook failed`, e);
    }
  }

  for (const hookName of HOOK_NAMES) {
    Hooks.on(hookName, onRenderConfig);
  }

  console.log(`${TAG} Installed; will inject on:`, HOOK_NAMES.join(", "));
})();
