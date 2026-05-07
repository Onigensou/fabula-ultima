// ============================================================================
// ActiveEffectManager-ui-styles.js
// Foundry VTT V12 — Fabula Ultima Companion
//
// Purpose:
// - Style helper module for the modular Active Effect Manager UI.
// - Owns only CSS injection/removal.
// - Does NOT render HTML.
// - Does NOT bind events.
// - Does NOT load data.
//
// Public API:
//   FUCompanion.api.activeEffectManager.uiParts.styles.injectStyle()
//   FUCompanion.api.activeEffectManager.uiParts.styles.removeStyle()
//   FUCompanion.api.activeEffectManager.uiParts.styles.reinstallStyle()
//
// Load order:
// - Load before ActiveEffectManager-ui-core.js.
// ============================================================================

(() => {
  const MODULE_ID = "fabula-ultima-companion";
  const TAG = "[ONI][ActiveEffectManager:UI:Styles]";
  const DEBUG = true;

  const STYLE_ID = "oni-active-effect-manager-ui-style";

  const log = (...a) => DEBUG && console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);

  // --------------------------------------------------------------------------
  // Namespace helpers
  // --------------------------------------------------------------------------

  function ensureApiRoot() {
    globalThis.FUCompanion = globalThis.FUCompanion || {};
    globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
    globalThis.FUCompanion.api.activeEffectManager =
      globalThis.FUCompanion.api.activeEffectManager || {};

    return globalThis.FUCompanion.api.activeEffectManager;
  }

  function ensureUiPartsRoot() {
    const root = ensureApiRoot();
    root.uiParts = root.uiParts || {};
    return root.uiParts;
  }

  function exposeApi(api) {
    const root = ensureApiRoot();
    const parts = ensureUiPartsRoot();

    parts.styles = api;

    // Friendly alias for console testing.
    root.uiStyles = api;

    try {
      const mod = game.modules?.get?.(MODULE_ID);

      if (mod) {
        mod.api = mod.api || {};
        mod.api.activeEffectManager = mod.api.activeEffectManager || {};
        mod.api.activeEffectManager.uiParts =
          mod.api.activeEffectManager.uiParts || {};

        mod.api.activeEffectManager.uiParts.styles = api;
        mod.api.activeEffectManager.uiStyles = api;
      }
    } catch (e) {
      warn("Could not expose Styles API on module object.", e);
    }
  }

  // --------------------------------------------------------------------------
  // CSS
  // --------------------------------------------------------------------------

  function getCssText() {
    return `
      .oni-aem {
        color: #16130e;
        font-family: var(--font-primary);
      }

      .oni-aem * {
        box-sizing: border-box;
      }

      .oni-aem .aem-grid-main {
        display: grid;
        grid-template-columns: 0.9fr 1.45fr;
        gap: 10px;
      }

      .oni-aem .aem-card {
        background: rgba(255,255,255,.66);
        border: 1px solid rgba(60,45,25,.25);
        border-radius: 9px;
        padding: 8px;
        margin-bottom: 8px;
        box-shadow: 0 1px 2px rgba(0,0,0,.08);
      }

      .oni-aem h3 {
        margin: 0 0 7px 0;
        padding-bottom: 4px;
        font-size: 14px;
        border-bottom: 1px solid rgba(60,45,25,.25);
      }

      .oni-aem h4 {
        margin: 8px 0 5px 0;
        font-size: 12px;
      }

      .oni-aem label {
        display: block;
        font-weight: 700;
        font-size: 12px;
        margin: 5px 0 2px;
      }

      .oni-aem input,
      .oni-aem select,
      .oni-aem textarea {
        width: 100%;
      }

      .oni-aem button {
        cursor: pointer;
      }

      .oni-aem button:disabled {
        cursor: wait;
        opacity: .65;
      }

      .oni-aem button.busy {
        opacity: .65;
        pointer-events: none;
      }

      .oni-aem .aem-row {
        display: flex;
        gap: 6px;
        align-items: center;
      }

      .oni-aem .aem-row > * {
        flex: 1;
      }

      .oni-aem .aem-actions {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 6px;
      }

      .oni-aem .aem-actions-3 {
        display: grid;
        grid-template-columns: 1fr 1fr 1fr;
        gap: 6px;
      }

      .oni-aem .aem-mini {
        font-size: 11px;
        opacity: .75;
        line-height: 1.25;
      }

      .oni-aem .aem-target-summary {
        margin: 6px 0;
        padding: 6px 8px;
        border-radius: 8px;
        background: rgba(0,0,0,.06);
        font-size: 11px;
        line-height: 1.25;
      }

      .oni-aem .aem-target-grid {
        --aem-target-slot-size: 86px;

        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(var(--aem-target-slot-size), 1fr));
        gap: 10px;
        max-height: 235px;
        overflow: auto;
        padding: 8px 4px;
        border: 0;
        border-radius: 8px;
        background: transparent;
      }

      .oni-aem .aem-target-card {
        position: relative;
        width: var(--aem-target-slot-size);
        height: var(--aem-target-slot-size);
        min-height: var(--aem-target-slot-size);
        padding: 0;
        margin: 0 auto;
        border: 0;
        border-radius: 0;
        background: transparent;
        cursor: pointer;
        display: grid;
        place-items: center;
        overflow: visible;
        isolation: isolate;

        transition:
          transform 140ms ease,
          opacity 140ms ease,
          filter 140ms ease;
      }

      .oni-aem .aem-target-card:hover {
        transform: translateY(-2px) scale(1.035);
      }

      .oni-aem .aem-target-card.selected {
        transform: translateY(-2px) scale(1.07);
      }

      .oni-aem .aem-target-card input {
        position: absolute;
        opacity: 0;
        pointer-events: none;
      }

      /* Target token name tooltip */
      .oni-aem .aem-target-tooltip {
        position: absolute;
        left: 50%;
        bottom: 2px;
        transform: translate(-50%, 5px);
        z-index: 8;

        max-width: 104px;
        padding: 4px 7px;
        border-radius: 999px;

        background: rgba(18, 14, 10, 0.88);
        border: 1px solid rgba(255, 218, 128, 0.42);
        box-shadow:
          0 4px 10px rgba(0, 0, 0, 0.32),
          0 0 10px rgba(255, 180, 48, 0.18);

        color: rgba(255, 244, 218, 0.96);
        font-size: 10px;
        font-weight: 850;
        line-height: 1.1;
        text-align: center;
        white-space: nowrap;
        text-overflow: ellipsis;
        overflow: hidden;

        opacity: 0;
        pointer-events: none;

        transition:
          opacity 120ms ease,
          transform 120ms ease;
      }

      .oni-aem .aem-target-tooltip small {
        display: block;
        margin-top: 1px;
        font-size: 9px;
        font-weight: 650;
        opacity: 0.72;
        text-overflow: ellipsis;
        overflow: hidden;
        white-space: nowrap;
      }

      .oni-aem .aem-target-card:hover .aem-target-tooltip {
        opacity: 1;
        transform: translate(-50%, 0);
      }

      .oni-aem .aem-target-card.selected .aem-target-tooltip {
        background: rgba(35, 24, 8, 0.92);
        border-color: rgba(255, 206, 72, 0.72);
      }

      .oni-aem .aem-target-img-wrap {
        position: relative;
        width: var(--aem-target-slot-size);
        height: var(--aem-target-slot-size);
        overflow: visible;
        background: transparent;
        display: grid;
        place-items: center;
        pointer-events: none;
        border-radius: 999px;
      }

      /* Selected target soft glow only, no ring */
      .oni-aem .aem-target-img-wrap::before {
        content: "";
        position: absolute;
        inset: 4px;
        border-radius: 999px;
        background: radial-gradient(
          circle,
          rgba(255, 205, 72, 0.42) 0%,
          rgba(255, 177, 35, 0.26) 42%,
          rgba(255, 145, 20, 0.08) 68%,
          rgba(255, 145, 20, 0) 82%
        );
        opacity: 0;
        transform: scale(0.86);
        transition:
          opacity 140ms ease,
          transform 140ms ease;
        pointer-events: none;
        z-index: 0;
        filter: blur(8px);
      }

      .oni-aem .aem-target-card.selected .aem-target-img-wrap::before {
        opacity: 1;
        transform: scale(1.08);
      }

      .oni-aem .aem-target-img {
        position: relative;
        z-index: 1;

        display: block;
        width: 100%;
        height: 100%;
        max-width: var(--aem-target-slot-size);
        max-height: var(--aem-target-slot-size);

        object-fit: contain;
        object-position: center bottom;

        border: 0;
        background: transparent;
        pointer-events: none;

        opacity: .72;
        filter: grayscale(.35) brightness(.48) contrast(.95);
        transform: translateZ(0);
        transform-origin: center bottom;

        transition:
          opacity 140ms ease,
          filter 140ms ease,
          transform 140ms ease;
      }

      .oni-aem video.aem-target-img {
        display: block;
      }

      .oni-aem .aem-target-card:hover .aem-target-img {
        opacity: .86;
        filter: grayscale(.18) brightness(.62) contrast(1);
      }

      .oni-aem .aem-target-card.selected .aem-target-img {
        opacity: 1;
        filter: drop-shadow(0 8px 12px rgba(0,0,0,.26));
        transform: scale(1.04);
      }

      .oni-aem .aem-effect-list {
        max-height: 445px;
        overflow: auto;
        border: 1px solid rgba(60,45,25,.18);
        border-radius: 7px;
        background: rgba(255,255,255,.45);
      }

      .oni-aem .aem-effect-row {
        display: grid;
        grid-template-columns: 30px 1fr;
        gap: 7px;
        align-items: center;
        padding: 7px 8px;
        border-bottom: 1px solid rgba(60,45,25,.12);
        cursor: pointer;
        user-select: none;
        transition:
          background 100ms ease,
          transform 100ms ease,
          border-color 100ms ease;
      }

      .oni-aem .aem-effect-row:last-child {
        border-bottom: none;
      }

      .oni-aem .aem-effect-row:hover {
        background: rgba(239, 225, 181, .45);
      }

      .oni-aem .aem-effect-row:active {
        transform: translateY(1px);
        background: rgba(239, 225, 181, .72);
      }

      .oni-aem .aem-icon {
        width: 26px;
        height: 26px;
        object-fit: cover;
        border: none;
        border-radius: 5px;
        background: rgba(0,0,0,.08);
      }

      .oni-aem .aem-effect-name {
        font-weight: 700;
        line-height: 1.1;
      }

      .oni-aem .aem-effect-meta {
        font-size: 10px;
        opacity: .65;
        line-height: 1.15;
      }

      .oni-aem .aem-category-tabs {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 5px;
        margin-top: 9px;
        margin-bottom: 6px;
      }

      .oni-aem .aem-category-tabs button.active {
        background: rgba(40,34,26,.88);
        color: white;
      }

      .oni-aem .aem-selected-list {
        min-height: 54px;
        max-height: 140px;
        overflow: auto;
        padding: 4px;
        border: 1px solid rgba(60,45,25,.18);
        border-radius: 7px;
        background: rgba(255,255,255,.45);
      }

      .oni-aem .aem-pill {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        margin: 2px;
        padding: 3px 6px;
        border-radius: 999px;
        background: rgba(0,0,0,.12);
        border: 1px solid rgba(0,0,0,.12);
        font-size: 11px;
      }

      .oni-aem .aem-pill img {
        width: 16px;
        height: 16px;
        border: none;
        border-radius: 3px;
      }

      .oni-aem .aem-pill button {
        width: 18px;
        height: 18px;
        min-height: 18px;
        line-height: 14px;
        padding: 0;
        border-radius: 50%;
      }

      .oni-aem .aem-empty {
        padding: 10px;
        opacity: .65;
        text-align: center;
      }

      .oni-aem .aem-builder-launch {
        margin-top: 8px;
      }

      .oni-aem .aem-apply-compact {
        padding: 0;
        overflow: hidden;
      }

      .oni-aem .aem-apply-details > summary {
        cursor: pointer;
        list-style: none;
        padding: 8px;
        font-weight: 850;
        border-radius: 8px;
        user-select: none;
      }

      .oni-aem .aem-apply-details > summary::-webkit-details-marker {
        display: none;
      }

      .oni-aem .aem-apply-details > summary::before {
        content: "▶";
        display: inline-block;
        margin-right: 6px;
        font-size: 10px;
        transform: translateY(-1px);
      }

      .oni-aem .aem-apply-details[open] > summary::before {
        content: "▼";
      }

      .oni-aem .aem-apply-details > summary:hover {
        background: rgba(0,0,0,.055);
      }

      .oni-aem .aem-apply-details-body {
        padding: 0 8px 8px 8px;
      }

      .oni-aem .aem-apply-grid {
        display: grid;
        grid-template-columns: 1.4fr 0.9fr;
        gap: 8px;
        align-items: end;
      }

      .oni-aem .aem-duration-mini {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 5px;
      }

      .oni-aem .aem-toggle-row {
        display: flex;
        gap: 6px;
        margin-top: 7px;
      }

      .oni-aem .aem-toggle-pill {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 5px;
        padding: 5px 6px;
        border-radius: 8px;
        border: 1px solid rgba(60,45,25,.20);
        background: rgba(255,255,255,.45);
        font-size: 11px;
        font-weight: 700;
        cursor: pointer;
      }

      .oni-aem .aem-toggle-pill input {
        width: auto;
        margin: 0;
      }

      .oni-aem .aem-inline-label {
        font-size: 11px;
        opacity: .82;
        margin-bottom: 2px;
      }

      .oni-aem .aem-apply-details-note {
        margin-top: 5px;
        font-size: 11px;
        opacity: .68;
        line-height: 1.25;
      }

      .oni-aem details.aem-debug {
        margin-top: 8px;
      }

      .oni-aem details.aem-debug > summary {
        cursor: pointer;
        font-weight: 700;
        padding: 4px 2px;
        user-select: none;
      }

      .oni-aem .aem-debug-inner {
        margin-top: 8px;
      }

      .oni-aem .aem-output {
        width: 100%;
        min-height: 105px;
        font-family: monospace;
        font-size: 11px;
        color: #111;
        background: rgba(255,255,255,.82);
      }

      .oni-aem .aem-warning {
        background: rgba(120, 55, 0, .12);
        border: 1px solid rgba(120, 55, 0, .25);
        padding: 6px;
        border-radius: 7px;
        font-size: 11px;
      }

      /* Custom builder shared styling.
         This is kept here so the upcoming native/custom-builder extraction
         can still reuse the same visual language. */
      .oni-aem .aem-builder-shell {
        display: grid;
        gap: 8px;
      }

      .oni-aem .aem-builder-hero {
        position: relative;
        overflow: hidden;
        border-radius: 12px;
        border: 1px solid rgba(80, 58, 30, .34);
        background:
          linear-gradient(135deg, rgba(48, 38, 28, .92), rgba(18, 16, 15, .94)),
          radial-gradient(circle at top left, rgba(255, 226, 142, .25), transparent 40%);
        color: #f7efe2;
        padding: 12px;
        box-shadow: 0 3px 10px rgba(0,0,0,.22);
      }

      .oni-aem .aem-builder-hero::after {
        content: "";
        position: absolute;
        inset: auto -30px -50px auto;
        width: 170px;
        height: 170px;
        border-radius: 999px;
        background: rgba(255,255,255,.055);
        pointer-events: none;
      }

      .oni-aem .aem-builder-hero-main {
        position: relative;
        display: grid;
        grid-template-columns: 58px 1fr;
        gap: 10px;
        align-items: center;
        z-index: 1;
      }

      .oni-aem .aem-builder-icon-preview {
        width: 58px;
        height: 58px;
        border-radius: 12px;
        border: 1px solid rgba(255,255,255,.22);
        background: rgba(255,255,255,.10);
        object-fit: cover;
        box-shadow: 0 2px 6px rgba(0,0,0,.28);
      }

      .oni-aem .aem-builder-title {
        font-size: 18px;
        font-weight: 900;
        letter-spacing: .02em;
        line-height: 1.05;
      }

      .oni-aem .aem-builder-subtitle {
        margin-top: 3px;
        color: rgba(247,239,226,.74);
        font-size: 11px;
        line-height: 1.25;
      }

      .oni-aem .aem-builder-type-row {
        position: relative;
        z-index: 1;
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 6px;
        margin-top: 10px;
      }

      .oni-aem .aem-builder-chip {
        border-radius: 999px;
        border: 1px solid rgba(255,255,255,.16);
        background: rgba(255,255,255,.09);
        color: rgba(247,239,226,.86);
        padding: 5px 7px;
        text-align: center;
        font-size: 11px;
        font-weight: 800;
      }

      .oni-aem .aem-builder-chip.buff {
        border-color: rgba(108, 232, 135, .35);
        background: rgba(108, 232, 135, .13);
      }

      .oni-aem .aem-builder-chip.debuff {
        border-color: rgba(255, 116, 136, .35);
        background: rgba(255, 116, 136, .13);
      }

      .oni-aem .aem-builder-chip.other {
        border-color: rgba(255, 211, 106, .35);
        background: rgba(255, 211, 106, .13);
      }

      .oni-aem .aem-builder-section {
        border-radius: 11px;
        border: 1px solid rgba(60,45,25,.20);
        background: rgba(255,255,255,.62);
        padding: 9px;
      }

      .oni-aem .aem-builder-section-title {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-bottom: 7px;
        padding-bottom: 5px;
        border-bottom: 1px solid rgba(60,45,25,.18);
        font-weight: 900;
        font-size: 13px;
      }

      .oni-aem .aem-builder-section-title .mark {
        width: 22px;
        height: 22px;
        display: inline-grid;
        place-items: center;
        border-radius: 7px;
        background: rgba(40,34,26,.86);
        color: white;
        font-size: 12px;
      }

      .oni-aem .aem-builder-form-grid {
        display: grid;
        grid-template-columns: 1.1fr .75fr;
        gap: 8px;
      }

      .oni-aem .aem-builder-dialog label {
        font-size: 11px;
        opacity: .88;
      }

      .oni-aem .aem-builder-dialog input,
      .oni-aem .aem-builder-dialog select,
      .oni-aem .aem-builder-dialog textarea {
        border-radius: 6px;
      }

      .oni-aem .aem-builder-dialog .aem-mod-row,
      .oni-aem .aem-mod-row {
        display: grid;
        grid-template-columns: 1.25fr .75fr .65fr .5fr 28px;
        gap: 5px;
        align-items: end;
        margin-bottom: 5px;
        padding: 6px;
        border-radius: 8px;
        border: 1px solid rgba(60,45,25,.16);
        background: rgba(255,255,255,.46);
      }

      .oni-aem .aem-builder-command-row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 7px;
        margin-top: 8px;
      }

      .oni-aem .aem-builder-command-row button {
        min-height: 32px;
        font-weight: 850;
      }

      .oni-aem .aem-builder-primary {
        background: rgba(48, 42, 34, .90);
        color: white;
        border-color: rgba(255,255,255,.22);
      }

      .oni-aem .aem-builder-primary:hover {
        background: rgba(68, 58, 44, .96);
      }

      .oni-aem .aem-builder-secondary {
        background: rgba(255,255,255,.55);
      }

      .oni-aem .aem-builder-preview-wrap {
        border-radius: 10px;
        border: 1px solid rgba(60,45,25,.18);
        background: rgba(0,0,0,.06);
        padding: 7px;
      }

      .oni-aem .aem-builder-preview {
        min-height: 92px;
        max-height: 180px;
        font-family: monospace;
        font-size: 11px;
        color: #111;
        background: rgba(255,255,255,.86);
      }

      .oni-aem .aem-builder-hint {
        margin-top: 5px;
        font-size: 11px;
        opacity: .72;
        line-height: 1.25;
      }
    `;
  }

  // --------------------------------------------------------------------------
  // Style injection
  // --------------------------------------------------------------------------

  function removeStyle() {
    const old = document.getElementById(STYLE_ID);

    if (old) {
      old.remove();
      return true;
    }

    return false;
  }

  function injectStyle() {
    // Match old behavior: remove and reinstall, so style patches apply after reload.
    removeStyle();

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = getCssText();

    document.head.appendChild(style);

    return style;
  }

  function reinstallStyle() {
    removeStyle();
    return injectStyle();
  }

  function isInstalled() {
    return !!document.getElementById(STYLE_ID);
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  const api = {
    version: "0.1.0",

    STYLE_ID,

    injectStyle,
    removeStyle,
    reinstallStyle,
    isInstalled,
    getCssText
  };

  exposeApi(api);

  Hooks.once("ready", () => {
    exposeApi(api);

    log("Ready. Active Effect Manager UI Styles module installed.", {
      api: "FUCompanion.api.activeEffectManager.uiParts.styles",
      styleId: STYLE_ID
    });
  });
})();