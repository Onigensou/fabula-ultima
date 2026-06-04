/**
 * Migration: 2026-06-03-rogue-ae-descriptions
 * ---------------------------------------------------------------------------
 * Backfill one-sentence AE descriptions on the two Rogue (Core) BD-tree
 * skills that ship embedded AE templates: Dodge + Vanish.
 *
 * Both shipped with empty descriptions — token-tooltip / effect-sheet
 * surfaces rendered "(No description field found on this Active Effect.)"
 * Per [[ae-description-brevity]], AE descriptions live in the small
 * token-hover tooltip; keep them ONE sentence in the
 * `<p><em>SkillName:</em> effect.</p>` format.
 *
 *   Dodge   — bearer-resident always-on (transfer:true, no statuses per
 *             [[always-active-passive-no-token-icon]]). Grants DEF +Level
 *             while no shield or martial armor is equipped.
 *   Vanish  — applied AE (transfer:false, statuses:["fud-vanished"]).
 *             Writes the bearer's UUID into cannot_target_uuids so enemies
 *             can't target you until start of your next turn.
 *
 * Scope: BD-tree masters (folder `Battle Director / Rogue / *`) + actor
 * copies matched by name + template id (legacy `Class Skill / Rogue / *`
 * masters NOT touched). Mirrors the Guardian B.1 raw-fix scope discipline.
 *
 * IDEMPOTENT — description-only update with deep-equal idempotency check.
 */

export const key = "2026-06-03-rogue-ae-descriptions";
export const description =
  "Backfill one-sentence AE descriptions on Rogue Dodge + Vanish " +
  "embedded AE templates (token-tooltip surface; both shipped empty).";

const BD_ROOT_NAME = "Battle Director";
const SKILL_TEMPLATE_ID = "j0F5Msw5RZ8aIB3j";

function isInBattleDirectorTree(item) {
  let f = item?.folder;
  while (f) {
    if (f.name === BD_ROOT_NAME && !(f.folder?.id ?? f.folder)) return true;
    f = f.folder;
  }
  return false;
}

function templateMatches(item) {
  return String(item?.system?.template ?? "") === SKILL_TEMPLATE_ID;
}

// AE-name → desired one-sentence description.
// Keyed by AE name (which equals the skill name per
// [[ae-naming-uses-skill-name]] for both these skills).
const AE_DESCRIPTIONS = {
  "Dodge":  "<p><em>Dodge:</em> DEF +Level while no shield or martial armor is equipped.</p>",
  "Vanish": "<p><em>Vanish:</em> Cannot be targeted by enemies until start of your next turn.</p>",
};

async function patchItem(item, log, ownerLabel) {
  let touched = false;
  for (const ae of item.effects?.contents ?? []) {
    const want = AE_DESCRIPTIONS[ae.name];
    if (!want) continue;
    if (ae.description === want) continue;
    await ae.update({ description: want });
    log(`  ${ownerLabel} ${item.name} → AE "${ae.name}" description set`);
    touched = true;
  }
  return touched;
}

export async function migrate(game, log) {
  let masters = 0;
  let copies = 0;

  for (const item of game.items?.contents ?? []) {
    if (!AE_DESCRIPTIONS[item.name]) continue;
    if (!isInBattleDirectorTree(item)) continue;
    if (!templateMatches(item)) continue;
    if (await patchItem(item, log, "master")) masters += 1;
  }

  for (const actor of game.actors?.contents ?? []) {
    for (const item of actor.items?.contents ?? []) {
      if (!AE_DESCRIPTIONS[item.name]) continue;
      if (!templateMatches(item)) continue;
      if (await patchItem(item, log, `actor "${actor.name}"`)) copies += 1;
    }
  }

  return {
    applied: true,
    summary: `Rogue AE descriptions: ${masters} master patch(es), ${copies} actor copy patch(es)`,
  };
}
