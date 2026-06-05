/**
 * Shared helper: author / update a "common" Active Effect preset.
 * ---------------------------------------------------------------------------
 * Common AEs are the GM-curated status library — embedded ActiveEffects on
 * `activeEffectContainer` Items ("Debuff" / "Buff" / "Active Effects"), looked
 * up BY NAME (e.g. "Burn", "Slow", "Weak"). `apply_ae` clones the container
 * master onto targets, so a single preset has many APPLIED COPIES living on
 * actors, actor-owned items, and (for unlinked tokens) scene-token actors.
 *
 * Editing such a preset directly in the world + committing the LevelDB is the
 * world-data-sharing hazard. This helper lets a migration ship the change as
 * CODE instead: it patches the container master(s) AND every applied copy in
 * lockstep, idempotently.
 *
 * DESIGN
 * ------
 * The caller supplies a FIELD-LEVEL `patch` (a Foundry update object, flat-
 * dotted or nested) — only the named fields are written, so per-instance
 * runtime state on applied copies (charges, `directorAppliedBy.turnsRemaining`,
 * origin, …) is preserved. Idempotent: an AE that already satisfies every patch
 * key is skipped, so re-runs are no-ops.
 *
 * Propagation mirrors `2026-05-30-tag-standard-debuffs` exactly:
 *   1. container masters (or all world items, if masterScope:"allWorldItems")
 *   2. actors' own effects + their items' embedded effects
 *   3. every scene token's (synthetic) actor effects
 *
 * NOT a migration itself (leading underscore + absent from _manifest.json).
 * Imported by migrations: `import { authorCommonAe } from "./_common-ae-author.js"`.
 * Foundry V12.
 *
 * @example  Clear Foundry-core duration from the Burn preset + all applied copies:
 *   await authorCommonAe(game, { name: "Burn", clearCoreDuration: true }, log);
 *
 * @example  Retune a preset's changes + tags everywhere:
 *   await authorCommonAe(game, {
 *     name: "Weak", container: "Debuff",
 *     patch: { changes: [{ key: "bonus_def", mode: 2, value: "-2", priority: 20 }],
 *              "system.tags": ["debuff"] },
 *   }, log);
 */

function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const keys = Object.keys(v).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}
const deepEqual = (a, b) => stableStringify(a) === stableStringify(b);

/** Merge convenience flags into the explicit patch. */
export function buildAePatch(spec) {
  const patch = { ...(spec.patch ?? {}) };
  if (spec.clearCoreDuration) {
    patch["duration.rounds"] = null;
    patch["duration.turns"] = null;
    patch["duration.seconds"] = null;
  }
  return patch;
}

/** True if `ae` already satisfies every key in `patch`. */
function patchSatisfied(ae, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (!deepEqual(foundry.utils.getProperty(ae, k), v)) return false;
  }
  return true;
}

/**
 * Patch a named common AE across its container master(s) + every applied copy.
 *
 * spec = {
 *   name: "Burn",                  // AE name to match everywhere (required)
 *   patch: { ...update fields },   // Foundry update object (flat-dotted/nested)
 *   clearCoreDuration: false,      // convenience → patch duration.rounds/turns/seconds=null
 *   container: "Debuff",           // optional — restrict masters to this container Item
 *   masterScope: "container",      // "container" (default) | "allWorldItems"
 *   syncCopies: true,              // also patch applied copies on actors/items/tokens (default true)
 *   createIfMissing: false,        // if no master found, create one (needs container + template)
 *   template: { ...AE doc },       // full AE doc for createIfMissing
 * }
 *
 * Returns { masters, actorCopies, itemCopies, tokenCopies, created, skipped }.
 */
export async function authorCommonAe(game, spec, log = () => {}) {
  const name = spec?.name;
  if (!name) throw new Error("authorCommonAe: spec.name required");
  const patch = buildAePatch(spec);
  if (!Object.keys(patch).length && !spec.createIfMissing) {
    throw new Error("authorCommonAe: empty patch (nothing to set)");
  }
  const syncCopies = spec.syncCopies !== false;
  const masterScope = spec.masterScope ?? "container";
  const matches = (ae) => ae?.name === name;

  const counts = { masters: 0, actorCopies: 0, itemCopies: 0, tokenCopies: 0, created: 0, skipped: 0 };

  async function apply(ae, label, bucket) {
    if (!matches(ae)) return;
    if (patchSatisfied(ae, patch)) { counts.skipped += 1; return; }
    try {
      await ae.update(patch);
      counts[bucket] += 1;
      log(`  ${label}: patched "${name}"`);
    } catch (e) {
      log(`  ${label}: patch failed on "${name}": ${e?.message ?? e}`);
    }
  }

  // ── Masters ───────────────────────────────────────────────────────────────
  let masterFound = false;
  for (const it of game.items?.contents ?? []) {
    const isContainer = it.type === "activeEffectContainer";
    if (masterScope === "container" && !isContainer) continue;
    if (spec.container && it.name !== spec.container) continue;
    for (const ae of it.effects?.contents ?? []) {
      if (matches(ae)) masterFound = true;
      await apply(ae, `container "${it.name}"`, "masters");
    }
  }

  // ── Create-if-missing ───────────────────────────────────────────────────────
  if (!masterFound && spec.createIfMissing) {
    if (!spec.container || !spec.template) {
      log(`  createIfMissing requested for "${name}" but spec.container + spec.template required — skipped`);
    } else {
      const container = (game.items?.contents ?? []).find(
        (it) => it.type === "activeEffectContainer" && it.name === spec.container
      );
      if (!container) {
        log(`  createIfMissing: container "${spec.container}" not found — skipped`);
      } else {
        await container.createEmbeddedDocuments("ActiveEffect", [{ ...spec.template, name }]);
        counts.created += 1;
        log(`  created "${name}" on container "${spec.container}"`);
      }
    }
  }

  // ── Applied copies ──────────────────────────────────────────────────────────
  if (syncCopies) {
    for (const actor of game.actors?.contents ?? []) {
      for (const ae of actor.effects?.contents ?? []) await apply(ae, `actor "${actor.name}"`, "actorCopies");
      for (const it of actor.items?.contents ?? []) {
        for (const ae of it.effects?.contents ?? []) await apply(ae, `actor "${actor.name}" / item "${it.name}"`, "itemCopies");
      }
    }
    for (const scene of game.scenes?.contents ?? []) {
      for (const tok of scene.tokens?.contents ?? []) {
        const actor = tok.actor;
        if (!actor) continue;
        for (const ae of actor.effects?.contents ?? []) await apply(ae, `scene "${scene.name}" / token "${tok.name}"`, "tokenCopies");
      }
    }
  }

  return counts;
}
