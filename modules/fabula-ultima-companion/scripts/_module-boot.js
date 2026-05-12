/**
 * [ONI] Module Boot — version marker + automatic macro sync (Foundry VTT v12)
 * ---------------------------------------------------------------------------
 * Two responsibilities on world load:
 *
 * 1) Boot marker (everyone)
 *    A single console.info on script load stamped with the load time, so
 *    refreshes are visible: if Ctrl+F5 didn't actually refresh, you'll see the
 *    old timestamp and know you're still on cached scripts.
 *
 * 2) Automatic macro source sync (GM only)
 *    Walks `macros/_manifest.json` and upserts each macro from its source file
 *    into the world's macro directory. Equivalent to running the
 *    "Sync FUCompanion Macros" admin macro by hand after every `git pull`,
 *    but automatic on every world boot.
 *
 *    - Manifest-driven (modules/fabula-ultima-companion/macros/_manifest.json).
 *    - Idempotent: macros whose bodies already match are left untouched (no
 *      writes, no notification noise).
 *    - GM-only: regular players don't have permission to modify macros and
 *      shouldn't trigger this anyway.
 *    - The "Sync FUCompanion Macros" macro itself is intentionally NOT in the
 *      manifest, so this script never overwrites the manual fallback.
 *
 * Loaded first in module.json so the boot marker beats other scripts' init
 * logs to console.
 */
const FU_BOOT_TAG = "[FUCompanion][Boot]";

// ---------------------------------------------------------------------------
// (1) Boot marker — fires immediately when this script loads.
// ---------------------------------------------------------------------------
(() => {
  const stamp = new Date().toISOString().replace("T", " ").replace(/\..+$/, "");
  console.info(`${FU_BOOT_TAG} Module scripts loaded @ ${stamp}`);
})();

// ---------------------------------------------------------------------------
// (2) Automatic macro source sync — runs once on `ready`, GM client only.
// ---------------------------------------------------------------------------
Hooks.once("ready", async () => {
  if (!game.user?.isGM) return;

  // Hidden escape hatch: set this flag in console before reload to skip the
  // auto-sync for a single session (e.g. when intentionally hand-editing a
  // live macro and you don't want it overwritten on next refresh).
  if (globalThis.__FU_DISABLE_MACRO_SYNC__) {
    console.info(`${FU_BOOT_TAG} Auto-sync skipped (__FU_DISABLE_MACRO_SYNC__ set).`);
    return;
  }

  const MODULE_ID = "fabula-ultima-companion";
  const MANIFEST_URL = `modules/${MODULE_ID}/macros/_manifest.json`;
  const cacheBust = Date.now();

  let manifest;
  try {
    const res = await fetch(`${MANIFEST_URL}?t=${cacheBust}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    manifest = await res.json();
  } catch (e) {
    console.error(`${FU_BOOT_TAG} Manifest fetch failed:`, e);
    return;
  }

  const entries = Array.isArray(manifest?.macros) ? manifest.macros : [];
  if (!entries.length) {
    console.warn(`${FU_BOOT_TAG} Macro manifest has no entries; nothing to sync.`);
    return;
  }

  // Foundry's macro editor can normalize line endings (CRLF↔LF) and strip/add
  // trailing whitespace on save, which makes the live `existing.command` no
  // longer byte-equal to the raw source `fetch()`ed from disk. Without this
  // helper, every boot would rewrite every macro forever. We normalize BOTH
  // sides for the comparison only; the WRITE still uses the raw source text.
  const normalizeForCompare = (s) =>
    String(s ?? "")
      .replace(/^﻿/, "")    // strip BOM if present
      .replace(/\r\n?/g, "\n")   // normalize CRLF / lone CR to LF
      .replace(/[ \t]+$/gm, "")  // strip trailing whitespace per line
      .replace(/\n+$/g, "");     // strip trailing blank lines

  const result = { updated: 0, created: 0, unchanged: 0, failed: 0, skipped: 0 };
  const failures = [];
  const touched = [];

  for (const entry of entries) {
    const { path, name } = entry || {};
    if (!path || !name) {
      result.skipped++;
      continue;
    }

    try {
      const fileUrl = `modules/${MODULE_ID}/${path}?t=${cacheBust}`;
      const res = await fetch(fileUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${path}`);
      const text = await res.text();

      const existing = game.macros.getName(name);
      if (existing) {
        if (normalizeForCompare(existing.command) === normalizeForCompare(text)) {
          result.unchanged++;
          continue;
        }
        await existing.update({ command: text });
        result.updated++;
        touched.push(name);
      } else {
        await Macro.create({
          name,
          type: "script",
          command: text,
          scope: "global",
          img: "icons/svg/dice-target.svg"
        });
        result.created++;
        touched.push(`${name} (new)`);
      }
    } catch (e) {
      result.failed++;
      failures.push({ name, path, error: e.message });
      console.error(`${FU_BOOT_TAG} sync failed for "${name}" (${path}):`, e);
    }
  }

  const summary =
    `${result.updated} updated, ${result.created} created, ` +
    `${result.unchanged} unchanged, ${result.failed} failed, ${result.skipped} skipped`;

  if (result.failed > 0) {
    console.warn(`${FU_BOOT_TAG} Auto-sync complete — ${summary}`, { failures });
    ui.notifications?.warn(`Macro auto-sync: ${summary} — see console for failures`);
  } else if (result.updated > 0 || result.created > 0) {
    console.info(`${FU_BOOT_TAG} Auto-sync complete — ${summary}`, { touched });
    ui.notifications?.info(`Macro auto-sync: ${summary}`);
  } else {
    // Quiet path: everything was already in sync. Just a console line, no toast.
    console.info(`${FU_BOOT_TAG} Auto-sync complete — ${summary}`);
  }
});
