/**
 * Migration: 2026-06-03-npc-hostile-skill-intent
 * ---------------------------------------------------------------------------
 * Stamps `system.props.action_intent: "harmful"` on NPC Active skills that
 * are clearly hostile against PCs but lack a damage type or
 * `isOffensive` / `isOffensiveSpell` flag.
 *
 * Background. `classifyActionIntent` falls through to step 8 ("Active
 * without damage → aid") for these skills, and `composeSkill` then
 * routes them to the actor's allies — which means an NPC's Steal Item
 * ends up trying to steal from a fellow bandit instead of the party.
 *
 * Scope. By exact skill name on any NPC (actors carrying
 * `system.props.attack_list`). Skips actors that don't match — PCs and
 * actors without the NPC template are unaffected. Idempotent: skips
 * items whose `action_intent` is already set to a valid value.
 *
 * The named skills are all opposed-Check theft / hindrance / forced-
 * action effects per the 2026-06-03 enemy audit. New hostile NPC skills
 * should declare `action_intent: "harmful"` at author time; this
 * migration is a one-shot cleanup for the existing world.
 */

export const key = "2026-06-03-npc-hostile-skill-intent";
export const description =
  "Set action_intent='harmful' on canonical NPC hostile Active skills " +
  "(Steal *, Hinder, Provoke, Cold Gaze, Constrict, Everybody Freeze!) " +
  "so they route to enemies in the Battle Director instead of allies.";

// Skill names treated as hostile when found on an NPC. Match-by-name
// covers all instances regardless of which monster owns the skill — a
// world Hinder works the same whether it's on Bandit, Bandit (Overworld),
// or a homebrew goblin variant.
const HOSTILE_NPC_SKILL_NAMES = new Set([
  "Steal Item",
  "Steal Accuracy",
  "Steal Strength",
  "Steal Defense",
  "Steal Speed",
  "Steal Intelligence",
  "Steal Will",
  "Hinder",
  "Provoke",
  "Cold Gaze",
  "Constrict",
  "Everybody Freeze!",
]);

const VALID_INTENTS = new Set(["harmful", "aid", "neutral"]);

function isNpcActor(actor) {
  return !!actor?.system?.props?.attack_list;
}

function needsHarmfulIntent(item) {
  if (!HOSTILE_NPC_SKILL_NAMES.has(item?.name)) return false;
  const p = item?.system?.props ?? {};
  // Skip if already correctly tagged.
  const current = String(p.action_intent ?? "").trim().toLowerCase();
  if (current === "harmful") return false;
  // Don't override an existing "aid" or "neutral" override — that means
  // the author explicitly chose a different classification (unusual for
  // these names but respect it).
  if (VALID_INTENTS.has(current)) return false;
  return true;
}

export async function migrate(game, log) {
  let touched = 0;
  let scanned = 0;
  let skippedExisting = 0;

  for (const actor of game.actors?.contents ?? []) {
    if (!isNpcActor(actor)) continue;
    for (const item of actor.items?.contents ?? []) {
      scanned += 1;
      if (!needsHarmfulIntent(item)) {
        if (HOSTILE_NPC_SKILL_NAMES.has(item.name)) skippedExisting += 1;
        continue;
      }
      try {
        await item.update({ "system.props.action_intent": "harmful" });
        touched += 1;
        log(`  ${actor.name}/${item.name}: action_intent → "harmful"`);
      } catch (e) {
        log(`  ${actor.name}/${item.name}: update failed — ${e?.message ?? e}`);
      }
    }
  }

  return {
    applied: true,
    summary:
      `tagged ${touched} hostile NPC skill(s) as harmful; ` +
      `already-tagged: ${skippedExisting}; ` +
      `scanned ${scanned} item(s) on NPC actors`,
  };
}
