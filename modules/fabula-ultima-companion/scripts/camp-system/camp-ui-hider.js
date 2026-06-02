// ============================================================================
// Camp UI Hider
//
// Hides native Foundry token UI (HP bars, status effect icons) while in a
// camp scene so the canvas feels intimate and roleplay-focused. Data is
// untouched — visibility is toggled on the PIXI display objects only.
// ============================================================================
(() => {
  const CAMP   = globalThis.CampSystem ??= {};
  const TAG    = "[CampSystem][UIHider]";
  const GLOBAL = "__ONI_CAMP_UI_HIDER__";

  if (globalThis[GLOBAL]?.installed) return;
  globalThis[GLOBAL] = { installed: true };

  let _active       = false;
  let _hookDraw     = null;
  let _hookRefresh  = null;

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  function _hideToken(token) {
    if (!token) return;
    if (token.bars)    token.bars.visible    = false;
    if (token.effects) token.effects.visible = false;
  }

  function _showToken(token) {
    if (!token) return;
    if (token.bars)    token.bars.visible    = true;
    if (token.effects) token.effects.visible = true;
  }

  function _applyAll(fn) {
    canvas?.tokens?.placeables?.forEach(fn);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------
  function activate() {
    if (_active) return;
    _active = true;
    console.debug(TAG, "Activating — hiding token bars & effects.");

    _applyAll(_hideToken);
    document.body.classList.add("oni-camp-active");

    // Re-apply after Foundry redraws a token (e.g. token created, image swapped)
    _hookDraw = Hooks.on("drawToken", (token) => {
      if (_active) _hideToken(token);
    });

    // Re-apply after Foundry refreshes a token (movement, data update, hover)
    // _refreshBars / _refreshEffects run before this hook fires, so setting
    // visible=false here wins every time without fighting Foundry's pipeline.
    _hookRefresh = Hooks.on("refreshToken", (token) => {
      if (_active) _hideToken(token);
    });
  }

  function deactivate() {
    if (!_active) return;
    _active = false;
    console.debug(TAG, "Deactivating — restoring token bars & effects.");

    if (_hookDraw    !== null) { Hooks.off("drawToken",    _hookDraw);    _hookDraw    = null; }
    if (_hookRefresh !== null) { Hooks.off("refreshToken", _hookRefresh); _hookRefresh = null; }

    _applyAll(_showToken);
    document.body.classList.remove("oni-camp-active");
  }

  // ---------------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------------
  CAMP.UIHider = { activate, deactivate };

  console.debug(TAG, "Installed.");
})();
