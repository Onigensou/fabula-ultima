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
 *           "path": "data-migrations/2026-05-17-reaction-action-intent.js" },
 *         { "key": "2026-06-05-sharpshooter-hawkeye-author",
 *           "path": "...",
 *           "idempotent": true }   // re-runs on source change (see TIERS)
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
 *       = [ "<one-time-key>", { "k": "<idempotent-key>", "h": "<srcHash>" }, ... ]
 *
 * TIERS
 * -----
 * - One-time (DEFAULT): runs once; the key is recorded; never runs again. Use
 *   for structural / template / dedup / superseded / historical-delta migrations.
 * - Idempotent (`"idempotent": true`): re-runs whenever the migration's SOURCE
 *   changes (hash-gated). Use ONLY for current, self-replacing CONTENT authors
 *   that fully (re)assert their target state and have NO later migration
 *   superseding them. This is what lets a freshly-pulled co-dev world self-heal
 *   skills on boot ([[feedback_pulled_world_stale_author_migration]]).
 *   ⚠ NEVER tag a base author that a later "-fix"/"-v2"/"-polish" migration
 *   patches — re-running it would revert that later work.
 *   ⚠ DEPRECATED for new content authors — see SEED-ONLY below.
 *
 * AUTHORING CONVENTION (current — world data is authoritative)
 * -----------------------------------------------------------
 * We now SHIP world data (items + folders) to co-devs, so a content author's
 * job is to SEED a world that LACKS the content, never to re-assert it. Write
 * new content-author migrations SEED-ONLY: detect the master document up front
 * and, if it already exists, return `{ applied: true }` WITHOUT touching it (or
 * any actor copy). That way a co-dev's hand-edits to a pulled skill/AE are NEVER
 * overridden by the migration tool. Pair seed-only with the One-time tier (NOT
 * idempotent) — re-running has nothing to do once the world is seeded.
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

  // ── Two-tier ledger ───────────────────────────────────────────────────────
  // Ledger entries are EITHER a bare "key" (one-time migration: runs once, then
  // never again) OR { k:"key", h:"hash" } (idempotent migration: stores the
  // source hash it last ran against). One-time is the DEFAULT; a migration opts
  // into idempotent re-run with `"idempotent": true` on its manifest entry.
  //
  // Idempotent migrations RE-RUN whenever their source hash changes — so a
  // freshly-PULLED world (whose ledger lists the key from an OLDER version of
  // the migration) self-heals on the next boot, then stays quiet until the
  // migration source actually changes again. One-time migrations NEVER re-run,
  // so historical/superseded migrations can't revert later work.
  // See [[feedback_pulled_world_stale_author_migration]].
  let ledgerRaw;
  try {
    ledgerRaw = game.settings.get(MODULE_ID, LEDGER_SETTING);
  } catch (e) {
    console.warn(`${FU_MIG_TAG} ledger setting unavailable; treating as empty:`, e?.message ?? e);
    ledgerRaw = [];
  }
  const ledger = new Map();   // key -> last-run source hash (null for one-time / legacy string entries)
  for (const ent of (Array.isArray(ledgerRaw) ? ledgerRaw : [])) {
    if (typeof ent === "string") ledger.set(ent, null);
    else if (ent && ent.k) ledger.set(ent.k, ent.h ?? null);
  }

  // Cheap, dependency-free source-change detector (djb2). We hash the migration
  // file's text so ANY output change forces idempotent migrations to re-run —
  // no version-bump discipline required.
  const djb2 = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0; return h.toString(16); };
  const srcUrl = (path) => `${window.location.origin}/modules/${MODULE_ID}/${path}`;

  // Build the run plan. One-time: run iff key absent. Idempotent: run iff key
  // absent, hash unknown (fetch failed → run to be safe), or source changed.
  const plan = [];
  for (const entry of entries) {
    if (!entry?.key) continue;
    const idempotent = entry.idempotent === true;
    if (!idempotent) {
      if (!ledger.has(entry.key)) plan.push({ entry, idempotent: false, hash: null, reason: "new" });
      continue;
    }
    let hash = null;
    try { hash = djb2(await (await fetch(`${srcUrl(entry.path)}?t=${cacheBust}`)).text()); }
    catch (e) { console.warn(`${FU_MIG_TAG} [${entry.key}] source hash fetch failed; will run:`, e?.message ?? e); }
    const known = ledger.has(entry.key);
    const prev = known ? ledger.get(entry.key) : undefined;
    if (!known) plan.push({ entry, idempotent: true, hash, reason: "new" });
    else if (hash === null) plan.push({ entry, idempotent: true, hash, reason: "hash-unavailable" });
    else if (prev !== hash) plan.push({ entry, idempotent: true, hash, reason: prev === null ? "stale-heal" : "source-changed" });
    // else: up to date → skip
  }

  if (!plan.length) {
    console.info(`${FU_MIG_TAG} all ${entries.length} migration(s) up to date.`);
    return;
  }
  console.info(`${FU_MIG_TAG} ${plan.length} migration(s) to run:`,
    plan.map(p => `${p.entry.key}${p.idempotent ? ` (idempotent:${p.reason})` : ""}`));

  const failed = [];
  let ranCount = 0;

  for (const { entry, idempotent, hash } of plan) {
    const { key, path } = entry;
    // Browser `import()` needs a root-relative or fully-qualified URL —
    // a bare "modules/..." string throws "failed to resolve specifier."
    const url = `${srcUrl(path)}?t=${cacheBust}`;
    const log = (msg, data) => console.info(`${FU_MIG_TAG} [${key}] ${msg}`, data ?? "");
    try {
      const mod = await import(url);
      if (mod.key && mod.key !== key) {
        throw new Error(`migration key mismatch: manifest "${key}" vs module "${mod.key}"`);
      }
      if (typeof mod.migrate !== "function") {
        throw new Error(`module exports no migrate() function`);
      }
      log(`running${idempotent ? " (idempotent)" : ""}: ${mod.description ?? "(no description)"}`);
      const result = await mod.migrate(game, log);
      if (result?.applied === false) {
        log("migration deferred (returned applied:false) — will retry next boot");
        continue;
      }
      log(`done: ${result?.summary ?? "(no summary)"}`);
      // Record: idempotent → store the source hash; one-time → null marker.
      ledger.set(key, idempotent ? (hash ?? null) : null);
      ranCount += 1;
    } catch (e) {
      console.error(`${FU_MIG_TAG} [${key}] failed:`, e);
      failed.push({ key, error: e?.message ?? String(e) });
    }
  }

  if (ranCount) {
    // Serialize: null hash → bare "key" string (one-time / legacy); else {k,h}.
    const serial = Array.from(ledger.entries()).map(([k, h]) => (h === null ? k : { k, h }));
    try {
      await game.settings.set(MODULE_ID, LEDGER_SETTING, serial);
    } catch (e) {
      console.error(`${FU_MIG_TAG} failed to update ledger setting; migrations may re-run next boot:`, e);
    }
  }

  const summary = `${ranCount} ran, ${failed.length} failed, ${entries.length} total`;
  if (failed.length) {
    console.warn(`${FU_MIG_TAG} complete — ${summary}`, { failed });
    ui.notifications?.warn(`Data migrations: ${summary} — see console for failures`);
  } else if (ranCount) {
    console.info(`${FU_MIG_TAG} complete — ${summary}`);
    ui.notifications?.info(`Data migrations: ${summary}`);
  } else {
    console.info(`${FU_MIG_TAG} complete — ${summary}`);
  }
});
