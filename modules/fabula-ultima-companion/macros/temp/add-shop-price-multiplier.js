/**
 * One-shot migration: add `shop_price_multiplier` numberField to
 * _FabU Char Template v3.fire's Miscellaneous section.
 *
 * shop_price_multiplier — floating-point multiplier applied to shop purchase
 * prices for this character. Default 1.0 (full price). A value of 0.5 means
 * the character pays half price; 1.25 means 25% surcharge.
 *
 * Placed in the Miscellaneous table as a new row at the bottom, near Zenit.
 *
 * After running: open the template actor, then click CSB's
 * "Reload from Template" to propagate the new field to all existing
 * characters that use this template.
 *
 * Idempotent — safe to re-run.
 *
 * To use: paste into a Foundry macro (Script type) and execute as GM.
 */
(async () => {
  const TAG           = "[add-shop-price-multiplier]";
  const TEMPLATE_NAME = "_FabU Char Template v3.fire";
  const FIELD_KEY     = "shop_price_multiplier";

  // ── 1. Locate template actor ──────────────────────────────────────────────
  const template = game.actors.find(a => a.name === TEMPLATE_NAME);
  if (!template) {
    ui.notifications.error(`${TAG} Actor "${TEMPLATE_NAME}" not found in world.`);
    console.error(`${TAG} Available actors:`, game.actors.map(a => `${a.name} [${a.type}]`));
    return;
  }
  console.log(`${TAG} Found template → id: ${template.id}, type: ${template.type}`);

  const sys = foundry.utils.deepClone(template.system);

  // ── 2. Idempotency check ──────────────────────────────────────────────────
  let alreadyExists = false;
  (function scan(node) {
    if (!node || typeof node !== "object" || alreadyExists) return;
    if (Array.isArray(node)) { node.forEach(scan); return; }
    if (node.key === FIELD_KEY) { alreadyExists = true; return; }
    for (const v of Object.values(node)) scan(v);
  })(sys);

  if (alreadyExists) {
    ui.notifications.info(`${TAG} Already up to date — "${FIELD_KEY}" field exists.`);
    console.log(`${TAG} No-op.`);
    return;
  }

  // ── 3. Field definition ───────────────────────────────────────────────────
  // A decimal numberField: 1.0 = full price, 0.5 = half price, 1.25 = +25%.
  const PRICE_FIELD = {
    key:                FIELD_KEY,
    colSpan:            1,
    rowSpan:            1,
    cssClass:           "",
    role:               "0",
    editRole:           0,
    permission:         "0",
    tooltip:            "Shop purchase price multiplier. Default 1.0 (full price). 0.5 = half price, 1.5 = +50% surcharge.",
    visibilityFormula:  "",
    type:               "numberField",
    size:               "small",
    label:              "Shop Price ×",
    defaultValue:       "1",
    allowDecimal:       true,
    minVal:             "0",
    maxVal:             "",
    allowRelative:      false,
    showControls:       false,
    controlsStyle:      "hover",
    inputStyle:         "text",
  };

  // New table row: field + two null placeholders to fill the 3-column grid.
  const NEW_ROW = [ PRICE_FIELD, null, null ];

  // ── 4. Walk tree and inject into Miscellaneous table ─────────────────────
  let injected = false;

  function tryInjectTable(node) {
    // Find the first `table` node in this subtree and append a row.
    if (!node || typeof node !== "object" || injected) return;
    if (Array.isArray(node)) { node.forEach(tryInjectTable); return; }

    if (node.type === "table" && Array.isArray(node.contents)) {
      node.contents.push(NEW_ROW);
      injected = true;
      return;
    }
    for (const v of Object.values(node)) tryInjectTable(v);
  }

  function walk(node) {
    if (!node || typeof node !== "object" || injected) return;
    if (Array.isArray(node)) { node.forEach(walk); return; }

    // Match a collapsible panel whose title contains "Miscellaneous"
    const isPanel = node.type === "panel";
    const title   = String(node.title ?? "");
    if (isPanel && node.collapsible === true && title.toLowerCase().includes("miscellaneous")) {
      console.log(`${TAG} Found Miscellaneous panel — injecting into its table.`);
      tryInjectTable(node.contents);
      return;
    }

    // Fallback: label-style section header whose value contains "Miscellaneous"
    // (some CSB layouts use a label row to mark a section, followed by a table sibling).
    // In that case we handle it at the parent-array level below.

    for (const v of Object.values(node)) walk(v);
  }

  // Primary pass: collapsible panel match
  walk(sys);

  // Fallback pass: if not found above, look for a label "Miscellaneous" in an
  // array and inject into the next table sibling in that same array.
  if (!injected) {
    console.log(`${TAG} Panel match failed — trying label+sibling approach.`);
    (function fallback(node) {
      if (!node || typeof node !== "object" || injected) return;
      if (!Array.isArray(node)) { for (const v of Object.values(node)) fallback(v); return; }

      for (let i = 0; i < node.length && !injected; i++) {
        const child = node[i];
        if (!child || typeof child !== "object") continue;

        // Check if this element is a label/panel marking "Miscellaneous"
        const isLabel =
          child.type === "label" && String(child.value ?? "").toLowerCase().includes("miscellaneous");
        const isTitlePanel =
          child.type === "panel" && String(child.title ?? "").toLowerCase().includes("miscellaneous");

        if (isLabel || isTitlePanel) {
          // Scan forward siblings for a table
          for (let j = i + 1; j < node.length && !injected; j++) {
            const sib = node[j];
            if (sib?.type === "table" && Array.isArray(sib.contents)) {
              sib.contents.push(NEW_ROW);
              injected = true;
              console.log(`${TAG} Injected via label+sibling at indices [${i}, ${j}].`);
            }
          }
        }
        fallback(child);
      }
    })(sys);
  }

  if (!injected) {
    ui.notifications.error(
      `${TAG} Could not locate Miscellaneous table in "${TEMPLATE_NAME}". ` +
      `Check the browser console for the full system structure and adjust the macro.`
    );
    console.warn(`${TAG} Full system dump for manual inspection:`, JSON.stringify(sys, null, 2));
    return;
  }

  // ── 5. Persist ───────────────────────────────────────────────────────────
  await template.update({ system: sys });
  ui.notifications.info(
    `${TAG} ✓ Added "Shop Price ×" (key: "${FIELD_KEY}") to ${TEMPLATE_NAME}. ` +
    `Open the template and click CSB "Reload from Template" to propagate to all characters.`
  );
  console.log(`${TAG} Done.`, { fieldKey: FIELD_KEY, templateId: template.id });
})();
