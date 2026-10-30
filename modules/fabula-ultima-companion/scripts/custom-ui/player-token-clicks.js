// ============================================================================
// ONI — Player token double-clicks (Foundry VTT v12) — Module Script
// ----------------------------------------------------------------------------
// The game is played like a console JRPG, not a VTT, so a player's
// double-click on a token does nothing:
//   - double left-click no longer opens the actor sheet (the chat Character /
//     Party buttons open the Party Menu instead, and C toggles it);
//   - double right-click no longer opens Token Config (players own the party
//     token) or toggles a Foundry target (battles pick targets in our own UI).
// Walk maps already swallow the right-click on their own
// (map-system/movementControl-cameraRuntime.js); this covers every scene.
//
// The GM keeps Foundry's behaviour, just in case.
// ============================================================================

(() => {
  const GLOBAL_KEY = "__ONI_PLAYER_TOKEN_CLICKS__";
  if (globalThis[GLOBAL_KEY]?.installed) return;
  globalThis[GLOBAL_KEY] = { installed: true };

  // Foundry's own first line of both handlers, kept so a click still reaches
  // whatever sits under the token when it should.
  function swallowLeft2(event) {
    if (!this._propagateLeftClick(event)) event.stopPropagation();
  }
  function swallowRight2(event) {
    if (!this._propagateRightClick(event)) event.stopPropagation();
  }

  // An Item Piles pile keeps its own double-click (open the pile).
  function isItemPile(token) {
    try { return !!game.itempiles?.API?.isValidItemPile?.(token?.document); } catch (_) { return false; }
  }

  const MODULE_ID = "fabula-ultima-companion";

  Hooks.once("ready", () => {
    if (game.user?.isGM) return;
    const methods = [["_onClickLeft2", swallowLeft2], ["_onClickRight2", swallowRight2]];

    // Item Piles wraps _onClickLeft2 through libWrapper, and a plain prototype
    // assignment underneath it was bypassed (the sheet still opened, measured
    // on a player client). A wrapper of our own that never calls through works
    // whatever else is wrapped there.
    if (globalThis.libWrapper?.register) {
      for (const [name, swallow] of methods) {
        libWrapper.register(MODULE_ID, `CONFIG.Token.objectClass.prototype.${name}`, function (wrapped, ...args) {
          if (isItemPile(this)) return wrapped(...args);
          return swallow.apply(this, args);
        }, "MIXED");
      }
      return;
    }

    const proto = (CONFIG.Token?.objectClass ?? Token)?.prototype;
    if (!proto) return;
    for (const [name, swallow] of methods) proto[name] = swallow;
  });
})();
