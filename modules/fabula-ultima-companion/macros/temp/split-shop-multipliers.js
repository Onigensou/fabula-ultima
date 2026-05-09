/**
 * Migration: split shop_price_multiplier into shop_buy_multiplier + shop_sell_multiplier.
 *
 * Handles all states cleanly — safe to re-run at any point:
 *   • Renames shop_price_multiplier → shop_buy_multiplier (if old key still present)
 *   • Adds shop_sell_multiplier as a label field (default 50) if missing
 *   • Patches shop_sell_multiplier type to "label" if it was previously added as numberField
 *   • Updates defaultValues to percentage-based (100 = full price, 50 = half price)
 *
 * After running: close and reopen _FabU Char Template v3.fire to see both
 * fields, then click CSB "Reload from Template" to propagate to all characters.
 * Update any Active Effects using key "shop_price_multiplier" to "shop_buy_multiplier".
 */
(async () => {
  const TAG           = "[split-shop-multipliers]";
  const TEMPLATE_NAME = "_FabU Char Template v3.fire";
  const OLD_KEY       = "shop_price_multiplier";
  const BUY_KEY       = "shop_buy_multiplier";
  const SELL_KEY      = "shop_sell_multiplier";

  // ── 1. Locate template actor ──────────────────────────────────────────────
  const template = game.actors.find(a => a.name === TEMPLATE_NAME);
  if (!template) {
    ui.notifications.error(`${TAG} Actor "${TEMPLATE_NAME}" not found.`);
    console.error(`${TAG} Available actors:`, game.actors.map(a => `${a.name} [${a.type}]`));
    return;
  }

  const sys = foundry.utils.deepClone(template.system);

  // ── 2. Scan current state ─────────────────────────────────────────────────
  let oldBuyNode  = null;  // the shop_price_multiplier node, if still present
  let buyNode     = null;  // the shop_buy_multiplier node, if already renamed
  let sellNode    = null;  // the shop_sell_multiplier node, if present

  (function scan(node) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(scan); return; }
    if (node.key === OLD_KEY)  oldBuyNode = node;
    if (node.key === BUY_KEY)  buyNode    = node;
    if (node.key === SELL_KEY) sellNode   = node;
    for (const v of Object.values(node)) scan(v);
  })(sys);

  const sellIsWrongType = sellNode && sellNode.type !== "label";
  const alreadyDone = buyNode && sellNode && !oldBuyNode && !sellIsWrongType;

  if (alreadyDone) {
    ui.notifications.info(`${TAG} Already up to date — nothing to do.`);
    console.log(`${TAG} No-op.`);
    return;
  }

  // ── 3. Label field definitions ────────────────────────────────────────────
  const NUMBER_FIELD_EXTRAS = ["allowDecimal","minVal","maxVal","allowRelative","showControls","controlsStyle","inputStyle"];

  function toLabelField(node, key, label, tooltip, defaultValue) {
    node.key               = key;
    node.type              = "label";
    node.label             = label;
    node.tooltip           = tooltip;
    node.defaultValue      = defaultValue;
    node.size              ??= "small";
    node.colSpan           ??= 1;
    node.rowSpan           ??= 1;
    node.cssClass          ??= "";
    node.role              ??= "0";
    node.editRole          ??= 0;
    node.permission        ??= "0";
    node.visibilityFormula ??= "";
    for (const k of NUMBER_FIELD_EXTRAS) delete node[k];
  }

  const SELL_FIELD_TEMPLATE = () => ({
    key:               SELL_KEY,
    type:              "label",
    label:             "Shop Sell %",
    tooltip:           "Sell price multiplier as percentage. 50 = half price (default). Active Effects only.",
    defaultValue:      "50",
    size:              "small",
    colSpan:           1,
    rowSpan:           1,
    cssClass:          "",
    role:              "0",
    editRole:          0,
    permission:        "0",
    visibilityFormula: "",
  });

  // ── 4. Phase A — rename old buy key in-place, set percentage default ──────
  if (oldBuyNode) {
    toLabelField(
      oldBuyNode,
      BUY_KEY,
      "Shop Buy %",
      "Buy price multiplier as percentage. 100 = full price (default). Active Effects only.",
      "100"
    );
    console.log(`${TAG} Renamed "${OLD_KEY}" → "${BUY_KEY}", default → 100.`);
  }

  // Also update defaultValue if buy field already exists with old decimal default
  if (buyNode && (buyNode.defaultValue === "1" || buyNode.defaultValue === "1.0")) {
    buyNode.defaultValue = "100";
    buyNode.label        = "Shop Buy %";
    buyNode.tooltip      = "Buy price multiplier as percentage. 100 = full price (default). Active Effects only.";
    console.log(`${TAG} Updated "${BUY_KEY}" default from decimal to 100.`);
  }

  // ── 5. Phase B — patch sell field (type fix + percentage default) ─────────
  if (sellIsWrongType || (sellNode && (sellNode.defaultValue === "0.5" || sellNode.defaultValue === "0.50"))) {
    toLabelField(
      sellNode,
      SELL_KEY,
      "Shop Sell %",
      "Sell price multiplier as percentage. 50 = half price (default). Active Effects only.",
      "50"
    );
    console.log(`${TAG} Patched "${SELL_KEY}" to label type, default → 50.`);
  }

  // ── 6. Phase C — inject sell field if still missing ───────────────────────
  let injected = false;

  if (!sellNode) {
    // Walk: find the row array that now contains shop_buy_multiplier and insert sell
    (function walk(node) {
      if (!node || typeof node !== "object" || injected) return;

      if (Array.isArray(node)) {
        // Check if this array IS the row containing the buy field
        const buyIdx = node.findIndex(c => c?.key === BUY_KEY);
        if (buyIdx >= 0 && !node.some(c => c?.key === SELL_KEY)) {
          const nullIdx = node.findIndex((c, i) => i > buyIdx && c === null);
          if (nullIdx >= 0) {
            node[nullIdx] = SELL_FIELD_TEMPLATE();
            console.log(`${TAG} Inserted "${SELL_KEY}" at row slot ${nullIdx}.`);
          } else {
            node.push(SELL_FIELD_TEMPLATE());
            console.log(`${TAG} Appended "${SELL_KEY}" to row.`);
          }
          injected = true;
          return;
        }
        node.forEach(walk);
        return;
      }

      for (const v of Object.values(node)) walk(v);
    })(sys);

    if (!injected) {
      ui.notifications.error(
        `${TAG} Could not locate the row containing "${BUY_KEY}" to insert the sell field. ` +
        `Check browser console for a full system dump.`
      );
      console.warn(`${TAG} Full system dump:`, JSON.stringify(sys, null, 2));
      return;
    }
  }

  // ── 7. Persist ───────────────────────────────────────────────────────────
  await template.update({ system: sys });

  const msgs = [];
  if (oldBuyNode)     msgs.push(`renamed "${OLD_KEY}" → "${BUY_KEY}"`);
  if (sellIsWrongType) msgs.push(`patched "${SELL_KEY}" to label type`);
  if (injected)        msgs.push(`added "${SELL_KEY}" (default 0.5)`);

  ui.notifications.info(
    `${TAG} ✓ Done: ${msgs.join("; ")}. ` +
    `Close and reopen the template sheet to see both fields, ` +
    `then click CSB "Reload from Template". ` +
    `Update any Active Effects using "${OLD_KEY}" to "${BUY_KEY}".`
  );
  console.log(`${TAG} Done.`, { oldBuyNode: !!oldBuyNode, sellIsWrongType, injected });
})();
