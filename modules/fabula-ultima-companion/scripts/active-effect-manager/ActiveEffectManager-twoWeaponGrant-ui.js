/**
 * ActiveEffect Two-Weapon Grant — Config UI Patch (Foundry VTT v12)
 * -----------------------------------------------------------------------------
 * Injects a "Two-Weapon Fighting (Fabula Ultima)" panel into the standard
 * ActiveEffectConfig form (and CSB's CustomActiveEffectConfig) so a GM can
 * author the data grant consumed by the Battle Director's two-weapon model
 * WITHOUT writing a migration. This is the Tier-2 exposure of Double Arrow's
 * `twoWeaponGrant` mechanism (Tier 1 = migration-authored only).
 *
 * The flag it writes:
 *   flags.fabula-ultima-companion.twoWeaponGrant = {
 *     soloWeapon?:  bool,   // attack twice with ONE weapon, off-hand empty
 *     mixed?:       bool,   // lift the same-Category rule for two real weapons
 *     category?:    string, // optional: main weapon's Category must match (e.g. "bow")
 *     condition_formula?: string, // optional: only grant when this evaluates truthy
 *   }
 * Consumed by snapshot.js → actorTwoWeaponGrants() / evaluateTwoWeaponRules().
 *
 * SAFETY — unlike charges-ui, an *empty* grant here is dangerous (a non-solo
 * grant lifts same-Category), so we MUST NOT write a default-valued flag onto
 * every AE a GM opens. Persistence uses a single hidden input whose NAME flips:
 *   • enabled  → name = flags.fabula-ultima-companion.twoWeaponGrant   (JSON value)
 *   • disabled → name = flags.fabula-ultima-companion.-=twoWeaponGrant (deletion)
 * so unrelated AEs stay clean and toggling off removes the flag. The engine
 * also ignores no-relaxation grants as defense-in-depth.
 *
 * Pairs with: snapshot.js (the runtime consumer).
 */
(() => {
  const TAG = "[ONI][AETwoWeapon:UI]";
  const MODULE_ID = "fabula-ultima-companion";

  const HOOK_NAMES = [
    "renderActiveEffectConfig",
    "renderCustomActiveEffectConfig"
  ];

  const PANEL_MARKER_CLASS = "oni-ae-twoweapon-panel";
  const HIDDEN_CLASS = "oni-tw-hidden";

  if (globalThis.__ONI_AE_TWOWEAPON_UI_INSTALLED__) {
    console.debug(`${TAG} Already installed.`);
    return;
  }
  globalThis.__ONI_AE_TWOWEAPON_UI_INSTALLED__ = true;

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  function escapeHtml(v) {
    return String(v ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  // Read the existing flag into a single editable grant. The engine accepts an
  // array of grants (migration-authored); the GM UI edits ONE. If an array of
  // >1 is present we treat the panel as read-only to avoid silently dropping
  // the extra grants.
  function readState(effect) {
    const spec = effect?.flags?.[MODULE_ID]?.twoWeaponGrant;
    const arr = Array.isArray(spec) ? spec.filter((g) => g && typeof g === "object") : (spec && typeof spec === "object" ? [spec] : []);
    const multi = arr.length > 1;
    const g = arr[0] ?? null;
    const enabled = !!(g && (g.soloWeapon || g.mixed));
    return {
      multi,
      enabled,
      mode: g?.soloWeapon ? "solo" : "mixed",
      category: String(g?.category ?? ""),
      condition_formula: String(g?.condition_formula ?? ""),
    };
  }

  function buildGrant(st) {
    const grant = st.mode === "solo" ? { soloWeapon: true } : { mixed: true };
    const cat = String(st.category ?? "").trim();
    if (cat) grant.category = cat;
    const cond = String(st.condition_formula ?? "").trim();
    if (cond) grant.condition_formula = cond;
    return grant;
  }

  // ---------------------------------------------------------------------------
  // Panel HTML
  // ---------------------------------------------------------------------------
  function buildPanelHtml(st) {
    if (st.multi) {
      return `
        <details class="${PANEL_MARKER_CLASS}" style="margin-top:.5rem; border:1px solid var(--color-border-light-tertiary, #999); border-radius:4px; padding:.4rem .6rem;">
          <summary style="font-weight:600; cursor:pointer;">Two-Weapon Fighting (Fabula Ultima)</summary>
          <p class="notes" style="margin-top:.4rem;">
            This effect carries <strong>multiple</strong> two-weapon grants (authored in code).
            Edit them in the migration that created this effect — the simple editor is hidden to
            avoid dropping the extra grants.
          </p>
        </details>
      `;
    }

    const disabled = st.enabled ? "" : "disabled";
    return `
      <details class="${PANEL_MARKER_CLASS}" ${st.enabled ? "open" : ""} style="margin-top:.5rem; border:1px solid var(--color-border-light-tertiary, #999); border-radius:4px; padding:.4rem .6rem;">
        <summary style="font-weight:600; cursor:pointer;">Two-Weapon Fighting (Fabula Ultima)</summary>

        <input type="hidden" class="${HIDDEN_CLASS}">

        <div class="form-group" style="margin-top:.5rem;">
          <label style="font-weight:600;">
            <input type="checkbox" data-field="enabled" ${st.enabled ? "checked" : ""}>
            Grant two-weapon fighting
          </label>
          <p class="notes">When on, this effect lets its owner make two separate attacks under the two-weapon-fighting rules (separate rolls, each HR treated as 0 for damage).</p>
        </div>

        <div class="form-group">
          <label>Mode</label>
          <div class="form-fields">
            <select data-field="mode" ${disabled}>
              <option value="solo" ${st.mode === "solo" ? "selected" : ""}>Lone weapon — attack twice with one weapon (off-hand empty)</option>
              <option value="mixed" ${st.mode === "mixed" ? "selected" : ""}>Mixed categories — two real weapons of different Categories</option>
            </select>
          </div>
          <p class="notes"><strong>Lone weapon</strong> = Double Arrow style (a single bow, nothing in the off-hand). <strong>Mixed categories</strong> = Ambidextrous style (lift the "same Category in both hands" requirement).</p>
        </div>

        <div class="form-group">
          <label>Weapon Category</label>
          <div class="form-fields">
            <input type="text" data-field="category" value="${escapeHtml(st.category)}" placeholder="(blank = any)" ${disabled}>
          </div>
          <p class="notes">Optional. Restricts the grant to a main-weapon Category (e.g. <code>bow</code>, <code>sword</code>). Blank = any weapon.</p>
        </div>

        <div class="form-group">
          <label>Condition Formula</label>
          <div class="form-fields">
            <input type="text" data-field="condition_formula" value="${escapeHtml(st.condition_formula)}" placeholder="(blank = always while owned)" ${disabled}>
          </div>
          <p class="notes">Optional. A skill-formula evaluated at snapshot time; the grant only applies when it is truthy. Blank = always (while this effect is active).</p>
        </div>

        <p class="notes" style="margin-top:.4rem;">Edits commit on <strong>Save</strong>. Turning the grant off removes the flag entirely.</p>
      </details>
    `;
  }

  // ---------------------------------------------------------------------------
  // Persistence — sync the hidden input from the visible controls.
  // ---------------------------------------------------------------------------
  function readPanelState(panelEl) {
    const get = (f) => panelEl.querySelector(`[data-field="${f}"]`);
    return {
      enabled: !!get("enabled")?.checked,
      mode: get("mode")?.value === "mixed" ? "mixed" : "solo",
      category: get("category")?.value ?? "",
      condition_formula: get("condition_formula")?.value ?? "",
    };
  }

  function syncHidden(panelEl) {
    const hidden = panelEl.querySelector(`.${HIDDEN_CLASS}`);
    if (!hidden) return;
    const st = readPanelState(panelEl);

    // Enable/disable the dependent controls for clarity.
    panelEl.querySelectorAll('[data-field="mode"], [data-field="category"], [data-field="condition_formula"]')
      .forEach((el) => { el.disabled = !st.enabled; });

    if (!st.enabled) {
      // Remove the flag on save (no-op if it never existed).
      hidden.setAttribute("name", `flags.${MODULE_ID}.-=twoWeaponGrant`);
      hidden.removeAttribute("data-dtype");
      hidden.value = "null";
      return;
    }
    hidden.setAttribute("name", `flags.${MODULE_ID}.twoWeaponGrant`);
    hidden.setAttribute("data-dtype", "JSON");
    hidden.value = JSON.stringify(buildGrant(st));
  }

  function attachListeners(panelEl) {
    const onChange = (ev) => {
      if (!ev.target?.matches?.("[data-field]")) return;
      syncHidden(panelEl);
    };
    panelEl.addEventListener("change", onChange);
    panelEl.addEventListener("input", onChange);
  }

  // ---------------------------------------------------------------------------
  // Insertion (mirrors charges-ui / reaction-ui)
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

      const st = readState(effect);
      const panel = insertPanel(formEl, buildPanelHtml(st));
      if (!panel) return;

      if (!st.multi) {
        attachListeners(panel);
        syncHidden(panel);   // establish the correct hidden name/value at render
      }

      try { app.setPosition?.({ height: "auto" }); } catch (_) {}

      console.log(`${TAG} Injected two-weapon panel`, {
        appName: app?.constructor?.name ?? "(unknown)",
        effectName: effect?.name ?? null,
        enabled: st.enabled,
        multi: st.multi
      });
    } catch (e) {
      console.warn(`${TAG} render hook failed`, e);
    }
  }

  for (const hookName of HOOK_NAMES) {
    Hooks.on(hookName, onRenderConfig);
  }

  console.debug(`${TAG} Installed; will inject on:`, HOOK_NAMES.join(", "));
})();
