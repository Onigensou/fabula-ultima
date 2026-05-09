/**
 * One-shot migration: split `shop_price_multiplier` into two separate fields:
 *   • shop_buy_multiplier  — multiplier when buying from a shop (default 1.0)
 *   • shop_sell_multiplier — multiplier when selling to a shop  (default 0.5)
 *
 * Steps performed:
 *   1. Renames the existing `shop_price_multiplier` field to `shop_buy_multiplier`
 *      and updates its label to "Shop Buy ×".
 *   2. Inserts `shop_sell_multiplier` into the same row (next null slot).
 *
 * After running: open _FabU Char Template v3.fire and click CSB
 * "Reload from Template" to propagate to all characters.
 * Also update any Active Effects that used key `shop_price_multiplier` to
 * use `shop_buy_multiplier` instead.
 *
 * Idempotent — safe to re-run.
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

  // ── 2. Idempotency check ──────────────────────────────────────────────────
  let buyExists  = false;
  let sellExists = false;
  (function scan(node) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(scan); return; }
    if (node.key === BUY_KEY)  buyExists  = true;
    if (node.key === SELL_KEY) sellExists = true;
    for (const v of Object.values(node)) scan(v);
  })(sys);

  if (buyExists && sellExists) {
    ui.notifications.info(`${TAG} Already up to date — both fields exist.`);
    console.log(`${TAG} No-op.`);
    return;
  }

  // ── 3. Sell field definition ──────────────────────────────────────────────
  const SELL_FIELD = {
    key:               SELL_KEY,
    colSpan:           1,
    rowSpan:           1,
    cssClass:          "",
    role:              "0",
    editRole:          0,
    permission:        "0",
    tooltip:           "Base sell price multiplier. Default 0.5 (half the item price). Active Effects can modify this.",
    visibilityFormula: "",
    type:              "numberField",
    size:              "small",
    label:             "Shop Sell ×",
    defaultValue:      "0.5",
    allowDecimal:      true,
    minVal:            "0",
    maxVal:            "",
    allowRelative:     false,
    showControls:      false,
    controlsStyle:     "hover",
    inputStyle:        "text",
  };

  // ── 4. Walk tree: rename buy field and inject sell field ──────────────────
  let renamed  = false;
  let injected = false;

  (function walk(node) {
    if (!node || typeof node !== "object") return;

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const cell = node[i];
        if (!cell || typeof cell !== "object" || Array.isArray(cell)) {
          // node[i] is a row array — recurse into it
          walk(cell);
          continue;
        }

        // Rename shop_price_multiplier → shop_buy_multiplier in-place
        if (cell.key === OLD_KEY && !buyExists) {
          cell.key     = BUY_KEY;
          cell.label   = "Shop Buy ×";
          cell.tooltip = "Shop purchase price multiplier. Default 1. Active Effects only.";
          renamed = true;
          console.log(`${TAG} Renamed "${OLD_KEY}" → "${BUY_KEY}" at array index ${i}.`);
        }

        walk(cell);
      }

      // After processing all cells, if this row contains the buy field and
      // sell field is missing, insert sell in the next null slot.
      if (!injected && !sellExists) {
        const hasBuy  = node.some(c => c?.key === BUY_KEY);
        const hasSell = node.some(c => c?.key === SELL_KEY);
        if (hasBuy && !hasSell) {
          const buyIdx  = node.findIndex(c => c?.key === BUY_KEY);
          const nullIdx = node.findIndex((c, idx) => idx > buyIdx && c === null);
          if (nullIdx >= 0) {
            node[nullIdx] = foundry.utils.deepClone(SELL_FIELD);
            injected = true;
            console.log(`${TAG} Inserted "${SELL_KEY}" at row index ${nullIdx}.`);
          } else {
            // No null slot — push at end of row
            node.push(foundry.utils.deepClone(SELL_FIELD));
            injected = true;
            console.log(`${TAG} Appended "${SELL_KEY}" to row.`);
          }
        }
      }
      return;
    }

    for (const v of Object.values(node)) walk(v);
  })(sys);

  if (!renamed && !buyExists) {
    ui.notifications.error(
      `${TAG} Could not find "${OLD_KEY}" field to rename. ` +
      `Check console for the full system dump.`
    );
    console.warn(`${TAG} Full system dump:`, JSON.stringify(sys, null, 2));
    return;
  }

  if (!injected && !sellExists) {
    ui.notifications.error(
      `${TAG} Renamed buy field but could not find a slot for "${SELL_KEY}". ` +
      `Check console for the full system dump.`
    );
    console.warn(`${TAG} Full system dump:`, JSON.stringify(sys, null, 2));
    return;
  }

  // ── 5. Persist ───────────────────────────────────────────────────────────
  await template.update({ system: sys });
  ui.notifications.info(
    `${TAG} ✓ Done. "${BUY_KEY}" and "${SELL_KEY}" are now separate fields. ` +
    `Click CSB "Reload from Template" to propagate, then update any Active Effects ` +
    `that used "${OLD_KEY}" to use "${BUY_KEY}" instead.`
  );
  console.log(`${TAG} Done.`, { renamed, injected });
})();
