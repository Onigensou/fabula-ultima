/**
 * Migration: 2026-05-30-tag-standard-debuffs
 * ---------------------------------------------------------------------------
 * Stamps `system.tags: ["debuff"]` on every Active Effect (world masters
 * + every actor's effects + every actor item's embedded effects) whose
 * name matches one of the six canonical FU debuff statuses:
 *
 *   Slow, Dazed, Shaken, Weak, Enraged, Poisoned
 *
 * Background. The Battle Director reads `system.tags` to count
 * debuffs on a hit target (Cheap Shot uses `TARGET_STATUS_COUNT`,
 * `countStatusDebuffs` in skill-formulas.js). The classifier is
 * three-stage — AEM `inferCategory` (name pattern) → explicit
 * `flags.fabula-ultima-companion.category` → `system.tags` includes
 * "debuff". Stage 1 already catches token-toggle AEs created without
 * tags, but the canon (per `feedback_opt_in_ae_classification`) is
 * that AEs self-tag via `system.tags`. This migration brings the live
 * world in line with that canon.
 *
 * SAFE on any AE that already carries the tag — that's the unchanged
 * branch. Idempotent across re-runs.
 *
 * Scope: GLOBAL (not BD-tree-scoped). These are the canonical
 * statuses; tagging them is correct everywhere they appear.
 */

export const key = "2026-05-30-tag-standard-debuffs";
export const description =
  "Ensure every AE named Slow / Dazed / Shaken / Weak / Enraged / Poisoned " +
  "carries system.tags including 'debuff', so the Battle Director " +
  "TARGET_STATUS_COUNT identifier counts them uniformly.";

const STANDARD_DEBUFF_NAMES = new Set([
  "slow", "dazed", "shaken", "weak", "enraged", "poisoned",
]);

function isStandardDebuff(ae) {
  return STANDARD_DEBUFF_NAMES.has(String(ae?.name ?? "").trim().toLowerCase());
}

function needsTag(ae) {
  const tags = ae?.system?.tags;
  if (!Array.isArray(tags)) return true;
  return !tags.includes("debuff");
}

function tagsWithDebuff(ae) {
  const current = Array.isArray(ae?.system?.tags) ? [...ae.system.tags] : [];
  if (!current.includes("debuff")) current.push("debuff");
  return current;
}

export async function migrate(game, log) {
  let touched = 0;
  let skipped = 0;
  let scanned = 0;

  async function visit(ae, ownerLabel) {
    scanned += 1;
    if (!isStandardDebuff(ae)) return;
    if (!needsTag(ae)) { skipped += 1; return; }
    try {
      await ae.update({ "system.tags": tagsWithDebuff(ae) });
      touched += 1;
      log(`  ${ownerLabel}: tagged "${ae.name}" with debuff`);
    } catch (e) {
      log(`  ${ownerLabel}: failed to tag "${ae.name}": ${e?.message ?? e}`);
    }
  }

  // Pass 1 — world items' embedded AEs (canonical templates).
  for (const item of game.items?.contents ?? []) {
    for (const ae of item.effects?.contents ?? []) {
      await visit(ae, `world item "${item.name}"`);
    }
  }

  // Pass 2 — actors' own AEs + their items' embedded AEs (live applied
  // statuses + any per-actor skill/spell templates).
  for (const actor of game.actors?.contents ?? []) {
    for (const ae of actor.effects?.contents ?? []) {
      await visit(ae, `actor "${actor.name}"`);
    }
    for (const item of actor.items?.contents ?? []) {
      for (const ae of item.effects?.contents ?? []) {
        await visit(ae, `actor "${actor.name}" / item "${item.name}"`);
      }
    }
  }

  // Pass 3 — every scene token's actor (synthetic, for unlinked tokens
  // these are independent from game.actors). Linked tokens share state
  // with game.actors and would have been touched in Pass 2; the
  // duplicate visit is filtered by `needsTag`.
  for (const scene of game.scenes?.contents ?? []) {
    for (const tok of scene.tokens?.contents ?? []) {
      const actor = tok.actor;
      if (!actor) continue;
      for (const ae of actor.effects?.contents ?? []) {
        await visit(ae, `scene "${scene.name}" / token "${tok.name}"`);
      }
    }
  }

  return {
    applied: true,
    summary:
      `tagged ${touched} debuff AE(s); already-tagged: ${skipped}; ` +
      `scanned: ${scanned}`,
  };
}
