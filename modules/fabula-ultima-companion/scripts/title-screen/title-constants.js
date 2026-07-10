// ============================================================================
// Title Screen — Constants
// ============================================================================
(() => {
  const TS = globalThis.TitleScreen ??= {};

  TS.MODULE_ID  = "fabula-ultima-companion";
  TS.SOCKET_CH  = `module.${TS.MODULE_ID}`;
  TS.SCENE_MODE = "title";

  // FALLBACK ONLY. The real quorum is derived at runtime by title-socket.js —
  // the primary GM plus every active user who owns a party-member actor. This
  // number is used only when that roster cannot be resolved (no party actor),
  // where a wrong count beats a lobby that can never reach quorum.
  TS.REQUIRED_PLAYERS = 5;

  TS.MSG = Object.freeze({
    LOAD_VOTE:         "TITLE_LOAD_VOTE",         // any user → socket (GM receives)
    LOAD_CANCEL:       "TITLE_LOAD_CANCEL",        // any user → socket (removes vote)
    LOAD_VOTES_UPDATE: "TITLE_LOAD_VOTES_UPDATE",  // GM       → all    (progress update)
    LOAD_LOADING:      "TITLE_LOAD_LOADING",       // GM       → all    (load started, show bar)
    LOAD_PROCEED:      "TITLE_LOAD_PROCEED",       // GM       → all    (load complete)
    LOAD_CONFLICT:     "TITLE_LOAD_CONFLICT",      // GM       → all    (disagreement)
  });

  console.debug("[TitleScreen] Constants loaded.");
})();
