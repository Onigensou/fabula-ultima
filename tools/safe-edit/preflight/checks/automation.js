"use strict";

/**
 * suite: automation — actor action automation vs its source item.
 *
 * When your co-dev authors an action's automation, the edit must land on the
 * copy EMBEDDED in the actor. During world-import it sometimes lands only on
 * the standalone source item in the Battle Director folder instead, so at the
 * table the actor's action fires with stale/empty wiring.
 *
 * Pairing key: an embedded item records where it was dragged from in
 * `_stats.compendiumSource` = "Item.<worldItemId>". We resolve that back to the
 * source world item and compare the automation payload.
 *
 * Automation drift is NOT always a bug (an actor's copy can be intentionally
 * customised), so this suite is WARN-level: it surfaces divergence for a human
 * to judge, and calls out the specific smell of "source populated, actor copy
 * empty" — which is exactly the import mishap above.
 */

const { SEVERITY, finding, deepEqual, isEmptyAutomation } = require("../util");

const ID = "automation";
const TITLE = "Action automation drift (actor copy vs source item)";

// The fields that carry Battle Director wiring on a CSB item (system.props.*).
const AUTOMATION_FIELDS = ["reaction_config_table", "effect_table", "animation_script"];

function autoOf(item) {
  const props = item?.system?.props || {};
  const out = {};
  for (const f of AUTOMATION_FIELDS) out[f] = props[f];
  return out;
}

function allEmpty(auto) {
  return AUTOMATION_FIELDS.every((f) => isEmptyAutomation(auto[f]));
}

// Extract the source world-item id from `_stats.compendiumSource` ("Item.<id>").
function sourceItemId(item) {
  const cs = item?._stats?.compendiumSource;
  if (typeof cs !== "string") return null;
  const m = /^Item\.([A-Za-z0-9]+)$/.exec(cs);
  return m ? m[1] : null;
}

function run(world, opts = {}) {
  const out = [];
  const drifts = [];       // both copies populated but differ — expected noise, opt-in
  let dormantSkips = 0;    // empty-copy cases on un-automated template actors

  for (const actor of world.actors) {
    // Is this actor actively automated at all? An actor whose every action copy
    // is empty is a dormant/un-automated template (a stock FU class NPC), where
    // "source automated but copy empty" is expected and not a regression. We
    // only trust the empty-copy signal on actors that ARE wired up elsewhere —
    // there, one empty action is an asymmetry that smells like a reverted edit.
    const actorIsAutomated = (actor.items || []).some((it) => !allEmpty(autoOf(it)));

    for (const item of actor.items || []) {
      const srcId = sourceItemId(item);
      if (!srcId) continue;                          // no traceable source — skip
      const src = world.byId.items.get(srcId);
      if (!src) continue;                            // source not in world — refs suite territory

      const emb = autoOf(item);
      const from = autoOf(src);
      const embEmpty = allEmpty(emb);
      const srcEmpty = allEmpty(from);

      if (embEmpty && srcEmpty) continue;            // neither automated — nothing to say
      if (deepEqual(emb, from)) continue;            // in sync — good

      const where = `actor "${actor.name}" · action "${item.name}"`;
      if (embEmpty && !srcEmpty && !actorIsAutomated) {
        dormantSkips++;                              // dormant template — expected, don't warn
      } else if (embEmpty && !srcEmpty) {
        // The exact import mishap, and the ONE high-signal case: wiring exists on
        // the folder source but the actor's copy is blank, so the action fires
        // with no automation at the table.
        out.push(finding(ID, SEVERITY.WARN,
          `${where}: source item is automated but the actor's copy is EMPTY — an edit likely landed on the folder copy, not the actor`,
          { doc: "actors", id: actor._id, extra: `src Item.${srcId}` }));
      } else {
        // Both carry wiring but they differ. This is EXPECTED for an actively-
        // authored actor copy vs an older base template, so it is not, by itself,
        // a bug — collect it for an opt-in listing instead of spamming WARNs.
        const fields = AUTOMATION_FIELDS.filter((f) => !deepEqual(emb[f], from[f]));
        drifts.push(finding(ID, SEVERITY.INFO,
          `${where}: differs from source item in ${fields.join(", ")}`,
          { doc: "actors", id: actor._id, extra: `src Item.${srcId}` }));
      }
    }
  }

  if (drifts.length) {
    if (opts.showDrift) {
      // Non-variadic: a spread passes each element as an argument and overflows
      // the stack on a large array (see checks/scenes.js). Bounded today, but
      // this list grows with content and the failure mode is a hard crash.
      for (const d of drifts) out.push(d);
    } else {
      out.push(finding(ID, SEVERITY.INFO,
        `${drifts.length} action(s) differ from their source item — expected for customised copies; pass --show-drift to list (useful when hunting one stale actor)`,
        {}));
    }
  }
  if (dormantSkips) {
    out.push(finding(ID, SEVERITY.INFO,
      `${dormantSkips} empty-copy action(s) on un-automated template actors were not flagged (expected — they were never wired up)`,
      {}));
  }

  return out;
}

module.exports = {
  id: ID, title: TITLE, run,
  // Shared with fix/automation so the fixer targets exactly what detection flags.
  AUTOMATION_FIELDS, autoOf, allEmpty, sourceItemId,
};
