/**
 * TR — Tile Trigger Macro (Monk's Active Tile Triggers)
 * ----------------------------------------------------
 * This macro is meant to be called by MATT.
 * It extracts tile/token context from:
 * - args[0] (if present)
 * - MATT free variables like `tile`, `token`, `trigger`
 * - manual fallback: controlled token + controlled tile (for testing)
 */

(async () => {
  console.log("[TR TileTrigger] Macro running");

  const FE = window["oni.TreasureRoulette.TileFrontEnd"];
  if (!FE?.onDbEnterTile) {
    ui.notifications.error(
      "[TreasureRoulette] TileFrontEnd not installed. Load TreasureRoulette_TileFrontEnd first."
    );
    return;
  }

  // 1) Start with args[0] if present
  let ctx =
    (typeof args !== "undefined" && Array.isArray(args) && args.length && args[0]) ? args[0] : {};

  // 2) Helper: normalize "tile-ish" and "token-ish" objects into Documents
  const normTileDoc = (t) => {
    if (!t) return null;
    // Placeable -> document
    if (t.document?.documentName === "Tile") return t.document;
    // Document already
    if (t.documentName === "Tile") return t;
    return null;
  };

  const normTokenDoc = (t) => {
    if (!t) return null;
    if (t.document?.documentName === "Token") return t.document;
    if (t.documentName === "Token") return t;
    return null;
  };

  // 3) Try to pull from args[0] common shapes
  const argTile =
    ctx?.tileDocument ||
    ctx?.tile?.document ||
    ctx?.tile ||
    ctx?.trigger?.tile?.document ||
    ctx?.trigger?.tile ||
    null;

  const argToken =
    ctx?.tokenDocument ||
    ctx?.token?.document ||
    ctx?.token ||
    ctx?.trigger?.token?.document ||
    ctx?.trigger?.token ||
    null;

  // 4) Try to pull from MATT free variables (IMPORTANT!)
  // These may exist in the macro execution scope, even if not on globalThis.
  let scopeTile = null;
  let scopeToken = null;
  let scopeTrigger = null;

  try { if (typeof tile !== "undefined") scopeTile = tile; } catch (_) {}
  try { if (typeof token !== "undefined") scopeToken = token; } catch (_) {}
  try { if (typeof trigger !== "undefined") scopeTrigger = trigger; } catch (_) {}

  const mattTile =
    scopeTile ||
    scopeTrigger?.tile ||
    null;

  const mattToken =
    scopeToken ||
    scopeTrigger?.token ||
    null;

  // 5) Resolve final docs
  const tileDoc =
    normTileDoc(argTile) ||
    normTileDoc(mattTile) ||
    null;

  const tokenDoc =
    normTokenDoc(argToken) ||
    normTokenDoc(mattToken) ||
    null;

  // 6) If still missing (manual testing), use controlled selections
  const looksEmpty =
    (!tileDoc || !tokenDoc);

  if (looksEmpty) {
    const controlledToken = canvas.tokens?.controlled?.[0]?.document || null;
    const controlledTile = canvas.tiles?.controlled?.[0]?.document || null;

    console.log("[TR TileTrigger] Manual fallback context:", {
      controlledToken: controlledToken?.uuid || null,
      controlledTile: controlledTile?.uuid || null,
    });

    ctx = {
      ...ctx,
      tokenDocument: tokenDoc || controlledToken,
      tileDocument: tileDoc || controlledTile,
    };
  } else {
    ctx = {
      ...ctx,
      tokenDocument: tokenDoc,
      tileDocument: tileDoc,
    };
  }

  console.log("[TR TileTrigger] Final ctx docs:", {
    token: ctx?.tokenDocument?.uuid || null,
    tile: ctx?.tileDocument?.uuid || null,
    ctxKeys: (ctx && typeof ctx === "object") ? Object.keys(ctx) : [],
  });

  await FE.onDbEnterTile(ctx);
})();
