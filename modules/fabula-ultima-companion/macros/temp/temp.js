/**
 * One-shot migration: add the `creature_check_outcome_flipped` option to
 * _Skill Template's reaction_trigger dropdown so authors can select it for
 * Zero Power #4 ("when the creature changes the outcome of a check").
 *
 * Inserts the option right after `creature_fumbles_check`, matching the
 * registry's display order in scripts/reaction-system/reaction-triggers.config.js.
 *
 * After this runs, click CSB's "reload from template" on _Skill Template
 * to propagate the schema change to existing skill items.
 *
 * Idempotent and safe to re-run.
 *
 * To use: paste into a Foundry macro (script type) and execute.
 */
(async () => {
  const TAG = "[skill-trigger-add-outcome-flipped]";
  const TEMPLATE_NAME = "_Skill Template";
  const TEMPLATE_TYPE = "_equippableItemTemplate";

  const NEW_OPTION = {
    key: "creature_check_outcome_flipped",
    value: "When a creature changes the outcome of a check"
  };
  const ANCHOR_KEY = "creature_fumbles_check";

  const candidates = game.items.filter(i => i.name === TEMPLATE_NAME && i.type === TEMPLATE_TYPE);
  if (candidates.length === 0) {
    ui.notifications.error(`${TAG} No item named "${TEMPLATE_NAME}" (type ${TEMPLATE_TYPE}) found in world`);
    return;
  }
  if (candidates.length > 1) {
    const ids = candidates.map(c => c.id).join(", ");
    ui.notifications.error(`${TAG} Multiple "${TEMPLATE_NAME}" items found (${candidates.length}: ${ids}). Cannot proceed.`);
    return;
  }
  const item = candidates[0];

  const sys = foundry.utils.deepClone(item.system);
  let dropdownsPatched = 0;
  let optionsAdded = 0;

  function patchTriggerColumn(col) {
    const opts = col.options;
    if (!Array.isArray(opts)) return;

    const already = opts.some(o => o?.key === NEW_OPTION.key);
    if (already) return;

    const anchorIdx = opts.findIndex(o => o?.key === ANCHOR_KEY);
    const insertAt = anchorIdx >= 0 ? anchorIdx + 1 : opts.length;
    opts.splice(insertAt, 0, foundry.utils.deepClone(NEW_OPTION));
    optionsAdded++;
  }

  (function walk(node) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (node.key === "reaction_config_table" && Array.isArray(node.rowLayout)) {
      const triggerCol = node.rowLayout.find(c => c?.key === "reaction_trigger");
      if (triggerCol) {
        patchTriggerColumn(triggerCol);
        dropdownsPatched++;
      }
    }
    for (const k of Object.keys(node)) walk(node[k]);
  })(sys);

  if (dropdownsPatched === 0) {
    ui.notifications.error(`${TAG} No reaction_trigger dropdown found on _Skill Template`);
    return;
  }

  if (optionsAdded === 0) {
    ui.notifications.info(`${TAG} Already up to date — option present`);
    console.log(`${TAG} no-op`, { dropdownsPatched, optionsAdded });
    return;
  }

  await item.update({ system: sys });
  ui.notifications.info(
    `${TAG} Added trigger option(s): ${optionsAdded}. ` +
    `Now click CSB's reload-from-template on _Skill Template to propagate.`
  );
  console.log(`${TAG} done`, { dropdownsPatched, optionsAdded });
})();
