/**
 * Migration: 2026-06-03-protect-ae-description
 * ---------------------------------------------------------------------------
 * Backfill the one-sentence AE description on Guardian Protect's embedded
 * "Protect" charge-carrier AE template, per [[ae-description-brevity]] +
 * the "Ready charge AEs surface frequency, not count" rule.
 *
 * Protect's chain order (`protect_redirect, protect_gate`) is canonical
 * per the engine — redirect_target is a mid-chain cancel point so the
 * cost step goes LAST ([[consume-last-in-chain]] + reaction-grant.js
 * comment lines 769-771). The chain order is NOT changed by this
 * migration.
 *
 * RAW (skills.json:1396): "When another creature is threatened by an
 * attack, spell or other danger, you may take their place… If you use
 * this Skill during a conflict, you cannot use it again until the start
 * of your next turn." → once per turn cadence.
 *
 * Scope: BD-tree master Protect (folder `Battle Director / Guardian /
 * Skill`) + actor copies matched by name + template id. Legacy
 * `Class Skill / Guardian / Protect` master NOT touched.
 *
 * IDEMPOTENT.
 */

export const key = "2026-06-03-protect-ae-description";
export const description =
  "Backfill one-sentence AE description on Guardian Protect's charge-carrier " +
  "AE template (token-tooltip surface; shipped empty).";

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

const AE_DESCRIPTIONS = {
  "Protect": "<p><em>Protect:</em> Once per turn. Take an ally's incoming attack or status instead.</p>",
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
    if (item.name !== "Protect") continue;
    if (!isInBattleDirectorTree(item)) continue;
    if (!templateMatches(item)) continue;
    if (await patchItem(item, log, "master")) masters += 1;
  }

  for (const actor of game.actors?.contents ?? []) {
    for (const item of actor.items?.contents ?? []) {
      if (item.name !== "Protect") continue;
      if (!templateMatches(item)) continue;
      if (await patchItem(item, log, `actor "${actor.name}"`)) copies += 1;
    }
  }

  return {
    applied: true,
    summary: `Protect AE description: ${masters} master patch(es), ${copies} actor copy patch(es)`,
  };
}
