// ============================================================================
// Title Screen — Constants
// ============================================================================
(() => {
  const TS = globalThis.TitleScreen ??= {};

  TS.MODULE_ID  = "fabula-ultima-companion";
  TS.SOCKET_CH  = `module.${TS.MODULE_ID}`;
  TS.SCENE_MODE = "title";

  // Number of unique player votes required before the ready-check evaluates.
  // Raise or lower this to match your session's player count.
  TS.REQUIRED_PLAYERS = 4;

  TS.MSG = Object.freeze({
    LOAD_VOTE:         "TITLE_LOAD_VOTE",         // player  → socket (GM receives)
    LOAD_CANCEL:       "TITLE_LOAD_CANCEL",        // player  → socket (removes vote)
    LOAD_VOTES_UPDATE: "TITLE_LOAD_VOTES_UPDATE",  // GM      → all    (progress update)
    LOAD_PROCEED:      "TITLE_LOAD_PROCEED",       // GM      → all    (all agreed)
    LOAD_CONFLICT:     "TITLE_LOAD_CONFLICT",      // GM      → all    (disagreement)
  });

  console.debug("[TitleScreen] Constants loaded.");
})();
