// ============================================================================
// Save System — Constants & Extractor Registry
//
// Extractor pattern: each data domain registers itself with registerExtractor.
// Core iterates them in registration order for both save and load.
// New domains can be appended to save-extractors.js without touching core.
// ============================================================================
(() => {
  const SS = globalThis.SaveSystem ??= {};

  SS.MODULE_ID    = "fabula-ultima-companion";
  SS.SLOT_COUNT   = 3;
  SS.SAVE_VERSION = 1;

  SS.SETTING = Object.freeze({
    SLOT:         i => `saveSystem.slot.${i}`,
    NPC_TEMPLATE: "saveSystem.npcTemplateId",
  });

  SS._extractors = [];

  // `critical` (default false): if a critical extractor's apply() throws, the
  // whole load is reported failed (error UI, retry). A non-critical failure is
  // cosmetic/recoverable — the load still succeeds and the miss is a warning.
  // Only the actor/database domains are critical; scene/journal/shop polish is not.
  //
  // `phase` (default 0): apply ordering bucket, ascending. All scene-document
  // mutations (tiles, tokens, drawings, flags) run in phase 0; scene ACTIVATION
  // is pushed to a later phase so the canvas draws once, after everything on the
  // scene is already in place — avoids churning heavy module tiles on the live
  // canvas (the sceneTileVisibility throw + choppiness).
  SS.registerExtractor = ({ key, label, extract, apply, critical = false, phase = 0 }) => {
    SS._extractors.push({ key, label, extract, apply, critical, phase });
  };

  // Stable sort by phase — Array.prototype.sort is stable in V8, so registration
  // order is preserved within a phase.
  SS.getExtractors = () => SS._extractors
    .map((e, i) => [e, i])
    .sort((a, b) => (a[0].phase - b[0].phase) || (a[1] - b[1]))
    .map(([e]) => e);

  console.debug("[SaveSystem] Constants loaded.");
})();
