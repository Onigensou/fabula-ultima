/**
 * ActiveEffect Lifecycle — Config UI Patch (Foundry VTT v12)
 * -----------------------------------------------------------------------------
 * Injects a "Lifecycle (Fabula Ultima)" fieldset into the standard
 * ActiveEffectConfig form (and CSB's CustomActiveEffectConfig) exposing
 * the lifecycle flags consumed by the director's AE-tick + scene-sweep
 * machinery so authors don't have to type the flag paths:
 *
 *   flags.fabula-ultima-companion.lifetimeMode      — "" | "round_end"
 *   flags.fabula-ultima-companion.crossScene         — bool
 *   flags.fabula-ultima-companion.directorPermanent  — bool
 *
 * The values map onto the homebrew rule documented at
 * [[ae-default-3-turn-duration]]:
 *
 *   Default (lifetimeMode = "")
 *     tickDirectorAEsForApplier decrements turnsRemaining at the
 *     applier's TurnStart (3 turns by default; override via
 *     duration.rounds on the template). Cleared at scene end UNLESS
 *     crossScene = true.
 *
 *   "round_end"
 *     tickDirectorAEsAtRoundEnd sweeps the AE at the next ROUND_END
 *     transition (Rampart playtest 2024 / 2025 mechanic). The
 *     applier-turn tick skips it. Cleared at scene end UNLESS
 *     crossScene = true.
 *
 *   directorPermanent = true
 *     Never ticked. Never swept at scene end. Use for trait-style
 *     permanent passives applied via apply_ae (rare — most class
 *     traits live on the item as transfer:true and don't need this).
 *
 * Pairs with: skill-effects.js (tickDirectorAEsForApplier /
 * tickDirectorAEsAtRoundEnd / sweepTransientAEsAtSceneEnd).
 */
(() => {
  const TAG = "[ONI][AELifecycle:UI]";
  const MODULE_ID = "fabula-ultima-companion";

  const HOOK_NAMES = [
    "renderActiveEffectConfig",
    "renderCustomActiveEffectConfig",
  ];

  const PANEL_MARKER_CLASS = "oni-ae-lifecycle-panel";

  if (globalThis.__ONI_AE_LIFECYCLE_UI_INSTALLED__) {
    console.debug(`${TAG} Already installed.`);
    return;
  }
  globalThis.__ONI_AE_LIFECYCLE_UI_INSTALLED__ = true;

  function readExistingFlags(effect) {
    const flags = effect?.flags?.[MODULE_ID] ?? {};
    const mode = String(flags.lifetimeMode ?? "").trim().toLowerCase();
    return {
      lifetimeMode:      mode === "round_end" ? "round_end" : "",
      crossScene:        flags.crossScene === true,
      directorPermanent: flags.directorPermanent === true,
    };
  }

  function buildPanelHtml({ lifetimeMode, crossScene, directorPermanent }) {
    const sel = (v) => (v === lifetimeMode ? "selected" : "");
    return `
      <fieldset class="${PANEL_MARKER_CLASS}" style="margin-top: .5rem;">
        <legend>Lifecycle (Fabula Ultima)</legend>

        <div class="form-group">
          <label>Lifetime Mode</label>
          <div class="form-fields">
            <select name="flags.${MODULE_ID}.lifetimeMode" data-dtype="String">
              <option value=""           ${sel("")}>Default — tick at applier's TurnStart</option>
              <option value="round_end"  ${sel("round_end")}>Round End — swept at ROUND_END</option>
            </select>
          </div>
          <p class="notes">
            <strong>Default</strong>: AE expires after N applier-turns (N = duration.rounds on the template, default 3).
            <strong>Round End</strong>: AE expires at the end of any round (Rampart-style; the applier-turn tick skips it).
          </p>
        </div>

        <div class="form-group">
          <label>Cross-Scene</label>
          <div class="form-fields">
            <input type="checkbox"
                   name="flags.${MODULE_ID}.crossScene"
                   data-dtype="Boolean"
                   ${crossScene ? "checked" : ""}>
          </div>
          <p class="notes">Survives scene-end sweep (director.stop with cleanupTokens). Use for AEs that should persist across scene transitions inside the same conflict.</p>
        </div>

        <div class="form-group">
          <label>Director Permanent</label>
          <div class="form-fields">
            <input type="checkbox"
                   name="flags.${MODULE_ID}.directorPermanent"
                   data-dtype="Boolean"
                   ${directorPermanent ? "checked" : ""}>
          </div>
          <p class="notes">Never ticks, never swept. Trait-style permanent passive. Rare — most class traits live on the item as transfer:true and don't need this.</p>
        </div>
      </fieldset>
    `;
  }

  // Mirror of ActiveEffectManager-charges-ui's anchor strategy so the
  // lifecycle panel lands consistently next to the Charges panel.
  function locateInsertionAnchor(formEl) {
    // Prefer anchoring AFTER the charges panel so the two FU panels
    // group visually.
    const chargesPanel = formEl.querySelector("fieldset.oni-ae-charges-panel");
    if (chargesPanel) return { node: chargesPanel, mode: "after" };

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

      // Idempotent — don't double-inject if Foundry re-renders.
      if (formEl.querySelector(`fieldset.${PANEL_MARKER_CLASS}`)) return;

      const effect = app?.object ?? app?.document ?? null;
      if (!effect) return;

      const html2 = buildPanelHtml(readExistingFlags(effect));
      const panel = insertPanel(formEl, html2);

      try { app.setPosition?.({ height: "auto" }); } catch (_) {}

      if (panel) {
        console.log(`${TAG} Injected lifecycle panel`, {
          appName: app?.constructor?.name ?? "(unknown)",
          effectName: effect?.name ?? effect?.label ?? null,
        });
      }
    } catch (e) {
      console.warn(`${TAG} render hook failed`, e);
    }
  }

  for (const hookName of HOOK_NAMES) {
    Hooks.on(hookName, onRenderConfig);
  }

  console.debug(`${TAG} Installed; will inject on:`, HOOK_NAMES.join(", "));
})();
