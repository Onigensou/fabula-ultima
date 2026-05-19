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

  SS.registerExtractor = ({ key, label, extract, apply }) => {
    SS._extractors.push({ key, label, extract, apply });
  };

  SS.getExtractors = () => SS._extractors;

  console.debug("[SaveSystem] Constants loaded.");
})();
