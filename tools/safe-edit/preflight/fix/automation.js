"use strict";

/**
 * fix/automation — copy a source item's automation onto an actor action whose
 * embedded copy is EMPTY (the "edit landed on the folder copy, not the actor"
 * regression). Targets EXACTLY the WARN cases the detection suite flags: the
 * actor is automated elsewhere, the action's copy is empty, the source is wired.
 *
 * GAME-OPEN fix (via the test-bridge): the copy lives as an embedded Item on the
 * actor, so we drive `item.update({ "system.props.…": … })` through the bridge
 * rather than writing LevelDB directly.
 *
 * This is the judgement-call fixer — divergence CAN be intentional — so it only
 * ever touches empty copies (never overwrites existing wiring), and you'll
 * normally run it with `--only <actorId>` to do one actor at a time.
 */

const { bridgeEval } = require("../../../csb-template/lib/bridge");
const { isEmptyAutomation } = require("../util");
const { AUTOMATION_FIELDS, autoOf, allEmpty, sourceItemId } = require("../checks/automation");

const ID = "automation";

function plan(world) {
  const actions = [];
  for (const actor of world.actors) {
    const actorIsAutomated = (actor.items || []).some((it) => !allEmpty(autoOf(it)));
    if (!actorIsAutomated) continue;                 // dormant template — never touch
    for (const item of actor.items || []) {
      const srcId = sourceItemId(item);
      if (!srcId) continue;
      const src = world.byId.items.get(srcId);
      if (!src) continue;
      const emb = autoOf(item);
      const from = autoOf(src);
      if (!allEmpty(emb)) continue;                  // copy already has wiring — leave it
      if (allEmpty(from)) continue;                  // nothing to pull
      const fields = AUTOMATION_FIELDS.filter((f) => !isEmptyAutomation(from[f]));
      actions.push({
        actorId: actor._id, actorName: actor.name,
        itemId: item._id, itemName: item.name,
        srcId, props: from, fields,
        targetIds: [actor._id, item._id, actor.name],
      });
    }
  }
  return actions;
}

function describe(a) {
  return `actor "${a.actorName}" · action "${a.itemName}": PULL automation from source (${a.fields.join(", ")})`;
}

const PULL_PROG = `
const { actorId, itemId, props } = ARGS;
const actor = game.actors.get(actorId);
if (!actor) return { ok: false, error: "actor not found: " + actorId };
const item = actor.items.get(itemId);
if (!item) return { ok: false, error: "item not found: " + itemId + " on " + actor.name };
const patch = {};
for (const [k, v] of Object.entries(props)) patch["system.props." + k] = v;
await item.update(patch);
return { ok: true, updated: item.name };
`;

async function apply(actions, { world }) {
  const results = [];
  for (const a of actions) {
    const res = await bridgeEval(world, PULL_PROG, {
      actorId: a.actorId, itemId: a.itemId, props: a.props,
    });
    if (!res.ok) throw new Error(`automation pull failed for ${a.actorName}/${a.itemName}: ${res.error}`);
    results.push({ actor: a.actorName, action: a.itemName });
  }
  return { results };
}

module.exports = { id: ID, plan, describe, apply, mode: "bridge" };
