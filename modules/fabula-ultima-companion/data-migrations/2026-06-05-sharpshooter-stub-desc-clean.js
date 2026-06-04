/**
 * Migration: 2026-06-05-sharpshooter-stub-desc-clean
 * ---------------------------------------------------------------------------
 * The Sharpshooter B.1 author migration left `TODO (engine): …` developer
 * notes embedded in the player-facing `description` of the three skills that
 * still await engine primitives (Barrage, Crossfire, Warning Shot). That
 * violates the canon "no developer notes in skill content" rule — skill
 * descriptions are PRODUCTION text shown to players in-game.
 *
 * This migration replaces those descriptions with clean canonical RAW text
 * (no TODO, no engine status). The mechanics remain pending — tracked in the
 * resolveaction-unification plan doc + memory, NOT in the item.
 *
 *   • Warning Shot — needs a pre-resolve "deal no damage" damage-override
 *     mutation (set rawDamage to 0 on hit targets) + open_action_menu
 *     (Shaken / Slow / −SL×10 MP) targeting the hit targets. ATTACK_IS_RANGED
 *     gate now exists; the damage-zero mutation does not.
 *   • Crossfire — needs a new `creature_performs_ranged_attack` trigger,
 *     a `force_miss` effect_kind, and a variable MP cost (= the attacker's
 *     Accuracy total) with a crit-success exemption.
 *   • Barrage — needs the multi(x) keyword (extra attack passes), part of
 *     the keyword-layer / multi-wield pass-collector follow-up.
 *
 * IDEMPOTENT — patches master(s) + actor copies by name + skill template.
 */

export const key = "2026-06-05-sharpshooter-stub-desc-clean";
export const description =
  "Strip TODO dev-notes from Barrage / Crossfire / Warning Shot descriptions; " +
  "set clean canonical RAW text (mechanics still pending, tracked off-item).";

const SKILL_TEMPLATE_ID = "j0F5Msw5RZ8aIB3j";

const CLEAN = {
  "Barrage":
    "<p>When you perform a <strong>ranged attack</strong>, you may spend " +
    "<strong>10 Mind Points</strong> to choose one option: the attack gains " +
    "<em>multi (2)</em>; or you increase the attack's <em>multi</em> property " +
    "by one, up to a maximum of <em>multi (3)</em>.</p>",
  "Crossfire":
    "<p>After a creature you can see performs a <strong>ranged attack</strong>, " +
    "you may spend an amount of <strong>Mind Points</strong> equal to the total " +
    "Result of their Accuracy Check in order to have the attack <strong>fail " +
    "automatically</strong> against all targets. You can only use this Skill if " +
    "you have a <strong>ranged weapon</strong> equipped, and it has no effect if " +
    "the Accuracy Check was a critical success.</p>",
  "Warning Shot":
    "<p>When you hit one or more targets with a <strong>ranged attack</strong> " +
    "that would deal damage, you may have the attack deal <strong>no damage</strong>. " +
    "If you do, choose one option: inflict <em>shaken</em> on each target hit by " +
    "the attack; or inflict <em>slow</em> on each target hit by the attack; or " +
    "each target hit by the attack loses <strong>【SL】× 10 Mind Points</strong>. " +
    "Describe your maneuver!</p>",
};

function templateMatches(item) {
  return String(item?.system?.template ?? "") === SKILL_TEMPLATE_ID;
}

async function patch(item, log, ownerLabel) {
  const want = CLEAN[item.name];
  if (!want) return false;
  if (String(item.system?.props?.description ?? "") === want) return false;
  await item.update({ "system.props.description": want });
  log(`  ${ownerLabel}: "${item.name}" description cleaned`);
  return true;
}

export async function migrate(game, log) {
  let count = 0;
  for (const item of game.items?.contents ?? []) {
    if (!CLEAN[item.name] || !templateMatches(item)) continue;
    if (await patch(item, log, `world "${item.folder?.name ?? "?"}"`)) count += 1;
  }
  for (const actor of game.actors?.contents ?? []) {
    for (const item of actor.items?.contents ?? []) {
      if (!CLEAN[item.name] || !templateMatches(item)) continue;
      if (await patch(item, log, `actor "${actor.name}"`)) count += 1;
    }
  }
  return { applied: true, summary: `Sharpshooter stub descriptions cleaned: ${count} item(s)` };
}
