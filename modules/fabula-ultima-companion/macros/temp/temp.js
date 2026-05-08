/**
 * One-shot migration: sync _Skill Template's reaction_trigger options with
 * scripts/reaction-system/reaction-triggers.config.js (the canonical registry).
 *
 * Applies three changes to the dropdown options on the reaction_trigger
 * column of the reaction_config_table:
 *   1. "When a creature get target by an action" -> "When a creature gets targeted by an action"
 *   2. "When a creature get hit by an action"    -> "When a creature gets hit by an action"
 *   3. Move creature_fumbles_check directly after creature_targeted_by_action
 *      (matches registry display order).
 *
 * After this runs, use CSB's "reload from template" button on _Skill Template
 * to propagate the schema change to existing skill items.
 *
 * Idempotent and safe to re-run.
 *
 * To use: paste into a Foundry macro (script type) and execute.
 */
(async () => {
  const TEMPLATE_ID = "SDnMHKSw2YOzeM4f";
  const TAG = "[skill-trigger-fix]";

  const item = game.items.get(TEMPLATE_ID);
  if (!item) {
    ui.notifications.error(`${TAG} Item ${TEMPLATE_ID} not found in world`);
    return;
  }
  if (item.name !== "_Skill Template") {
    ui.notifications.error(`${TAG} Item ${TEMPLATE_ID} is "${item.name}", expected "_Skill Template"`);
    return;
  }

  const sys = foundry.utils.deepClone(item.system);
  let tablesPatched = 0;
  let labelFixes = 0;
  let reorders = 0;

  function patchTriggerColumn(col) {
    const opts = col.options;
    if (!Array.isArray(opts)) return;

    for (const opt of opts) {
      if (!opt) continue;
      if (opt.key === "creature_targeted_by_action" &&
          opt.value !== "When a creature gets targeted by an action") {
        opt.value = "When a creature gets targeted by an action";
        labelFixes++;
      } else if (opt.key === "creature_hit_by_action" &&
                 opt.value !== "When a creature gets hit by an action") {
        opt.value = "When a creature gets hit by an action";
        labelFixes++;
      }
    }

    const targetedIdx = opts.findIndex(o => o?.key === "creature_targeted_by_action");
    const fumblesIdx  = opts.findIndex(o => o?.key === "creature_fumbles_check");
    if (targetedIdx >= 0 && fumblesIdx >= 0 && fumblesIdx !== targetedIdx + 1) {
      const [fumbles] = opts.splice(fumblesIdx, 1);
      const newTargetedIdx = opts.findIndex(o => o?.key === "creature_targeted_by_action");
      opts.splice(newTargetedIdx + 1, 0, fumbles);
      reorders++;
    }
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
        tablesPatched++;
      }
    }
    for (const k of Object.keys(node)) walk(node[k]);
  })(sys);

  if (tablesPatched === 0) {
    ui.notifications.error(`${TAG} No reaction_config_table found on _Skill Template`);
    return;
  }

  if (labelFixes === 0 && reorders === 0) {
    ui.notifications.info(`${TAG} Already up to date — nothing to change`);
    console.log(`${TAG} no-op`, { tablesPatched, labelFixes, reorders });
    return;
  }

  await item.update({ system: sys });
  ui.notifications.info(
    `${TAG} Patched _Skill Template: ${labelFixes} label(s), ${reorders} reorder(s). ` +
    `Now click CSB's reload-from-template on _Skill Template to propagate.`
  );
  console.log(`${TAG} done`, { tablesPatched, labelFixes, reorders });
})();
