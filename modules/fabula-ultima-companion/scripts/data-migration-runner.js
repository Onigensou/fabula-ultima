/**
 * [ONI] Data Migration Runner (Foundry VTT v12)
 * ---------------------------------------------------------------------------
 * Companion to `_module-boot.js`'s macro auto-sync. Where that script keeps
 * world macros in lockstep with the module's source files, this one applies
 * one-shot data migrations against world documents (items, actors, AEs).
 *
 * The problem this solves: when a feature changes the *shape* of world data
 * (e.g. "every Protect-shape reaction needs a `reaction_action_intent` field
 * on row 0"), shipping the change as raw LevelDB shards in git is fragile —
 * shards can't be merged across forks, Foundry must be closed during pull,
 * and embedded actor copies aren't covered. Migrations let us ship the
 * change as reviewable JS that runs the same `doc.update()` calls a human
 * would, on any world, GM-side, idempotently.
 *
 * MODEL
 * -----
 *   modules/fabula-ultima-companion/data-migrations/_manifest.json
 *     { "migrations": [
 *         { "key": "2026-05-17-reaction-action-intent",
 *           "path": "data-migrations/2026-05-17-reaction-action-intent.js" }
 *     ] }
 *
 *   modules/fabula-ultima-companion/data-migrations/<key>.js
 *     export const key = "<key>";
 *     export const description = "...";
 *     export async function migrate(game, log) {
 *       // do work via doc.update(); MUST be idempotent.
 *       return { applied: true, summary: "..." };
 *     }
 *
 *   Per-world ledger (Foundry world setting):
 *     game.settings.get("fabula-ultima-companion", "appliedMigrations")
 *       = ["<key>", ...]
 *
 * RUNTIME
 * -------
 * - GM-only. Players can't write the ledger anyway.
 * - Fires on `ready` after a short delay to let other module init complete.
 * - Each migration is wrapped in try/catch; one failure doesn't block the
 *   rest. Failures are NOT recorded in the ledger, so they retry next boot.
 * - Hidden escape hatch: `__FU_DISABLE_DATA_MIGRATIONS__ = true` in console
 *   before reload to skip for a single session.
 * - Migrations should self-check before writing. If they detect their work
 *   is already done, they should still return `{ applied: true }` so the
 *   ledger records them and they stop running next boot.
 */
const FU_MIG_TAG = "[FUCompanion][DataMigration]";
const MODULE_ID = "fabula-ultima-companion";
const LEDGER_SETTING = "appliedMigrations";

// Register the ledger setting on `init` so it's available by `ready`.
// Hidden from the Settings UI — this is internal bookkeeping only.
Hooks.once("init", () => {
  try {
    game.settings.register(MODULE_ID, LEDGER_SETTING, {
      name: "Applied Data Migrations",
      hint: "Internal: keys of data migrations that have already run in this world.",
      scope: "world",
      config: false,
      type: Array,
      default: [],
    });
  } catch (e) {
    // Re-register attempts after the first throw; harmless. Log but don't
    // crash — the get/set call below will still work if the original
    // registration succeeded.
    console.warn(`${FU_MIG_TAG} setting register raised (likely re-register):`, e?.message ?? e);
  }
});

Hooks.once("ready", async () => {
  if (!game.user?.isGM) return;

  if (globalThis.__FU_DISABLE_DATA_MIGRATIONS__) {
    console.info(`${FU_MIG_TAG} skipped (__FU_DISABLE_DATA_MIGRATIONS__ set).`);
    return;
  }

  const MANIFEST_URL = `modules/${MODULE_ID}/data-migrations/_manifest.json`;
  const cacheBust = Date.now();

  let manifest;
  try {
    const res = await fetch(`${MANIFEST_URL}?t=${cacheBust}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    manifest = await res.json();
  } catch (e) {
    // Missing manifest is fine — means no migrations have been authored yet.
    if (e?.message?.includes("404")) {
      console.info(`${FU_MIG_TAG} no manifest found (nothing to do).`);
      return;
    }
    console.error(`${FU_MIG_TAG} manifest fetch failed:`, e);
    return;
  }

  const entries = Array.isArray(manifest?.migrations) ? manifest.migrations : [];
  if (!entries.length) {
    console.info(`${FU_MIG_TAG} manifest is empty (nothing to do).`);
    return;
  }

  // Read the per-world ledger of already-applied migration keys.
  let ledger;
  try {
    ledger = game.settings.get(MODULE_ID, LEDGER_SETTING);
  } catch (e) {
    console.warn(`${FU_MIG_TAG} ledger setting unavailable; treating as empty:`, e?.message ?? e);
    ledger = [];
  }
  const applied = new Set(Array.isArray(ledger) ? ledger : []);

  const pending = entries.filter(e => e?.key && !applied.has(e.key));
  if (!pending.length) {
    console.info(`${FU_MIG_TAG} all ${entries.length} migration(s) already applied.`);
    return;
  }

  console.info(`${FU_MIG_TAG} ${pending.length} pending migration(s):`,
    pending.map(p => p.key));

  const newlyApplied = [];
  const failed = [];

  for (const entry of pending) {
    const { key, path } = entry;
    // Browser `import()` needs a root-relative or fully-qualified URL —
    // a bare "modules/..." string throws "failed to resolve specifier."
    // Use origin + leading slash so it resolves against the world root.
    const url = `${window.location.origin}/modules/${MODULE_ID}/${path}?t=${cacheBust}`;
    const log = (msg, data) => console.info(`${FU_MIG_TAG} [${key}] ${msg}`, data ?? "");
    try {
      const mod = await import(url);
      if (mod.key && mod.key !== key) {
        throw new Error(`migration key mismatch: manifest "${key}" vs module "${mod.key}"`);
      }
      if (typeof mod.migrate !== "function") {
        throw new Error(`module exports no migrate() function`);
      }
      log(`running: ${mod.description ?? "(no description)"}`);
      const result = await mod.migrate(game, log);
      if (result?.applied === false) {
        log("migration deferred (returned applied:false) — will retry next boot");
        continue;
      }
      log(`done: ${result?.summary ?? "(no summary)"}`);
      newlyApplied.push(key);
    } catch (e) {
      console.error(`${FU_MIG_TAG} [${key}] failed:`, e);
      failed.push({ key, error: e?.message ?? String(e) });
    }
  }

  if (newlyApplied.length) {
    const next = Array.from(new Set([...applied, ...newlyApplied]));
    try {
      await game.settings.set(MODULE_ID, LEDGER_SETTING, next);
    } catch (e) {
      console.error(`${FU_MIG_TAG} failed to update ledger setting; migrations may re-run next boot:`, e);
    }
  }

  const summary =
    `${newlyApplied.length} applied, ${failed.length} failed, ` +
    `${applied.size + newlyApplied.length}/${entries.length} total recorded`;
  if (failed.length) {
    console.warn(`${FU_MIG_TAG} complete — ${summary}`, { failed });
    ui.notifications?.warn(`Data migrations: ${summary} — see console for failures`);
  } else if (newlyApplied.length) {
    console.info(`${FU_MIG_TAG} complete — ${summary}`, { applied: newlyApplied });
    ui.notifications?.info(`Data migrations: ${summary}`);
  } else {
    console.info(`${FU_MIG_TAG} complete — ${summary}`);
  }
});
