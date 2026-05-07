// ────────────────────────────────────────────────────────────────────────────
//  Sync FUCompanion Macros (Admin)
//  Pulls the latest macro source from the module's filesystem and overwrites
//  (or creates) the matching macros in the current Foundry world.
//
//  Use after `git pull` to refresh the world's stored macro bodies without
//  copy-pasting each file by hand.
//
//  Bootstrap: this macro is intentionally NOT in _manifest.json (self-update
//  mid-execution is a footgun). Paste this file's contents into a new world
//  macro called "Sync FUCompanion Macros" once. After that, run the macro
//  whenever you pull. If this script itself changes, repaste it manually.
//
//  Requires: GM permission. Cache-busted fetches.
// ────────────────────────────────────────────────────────────────────────────
(async () => {
  if (!game.user?.isGM) {
    return ui.notifications.error("Sync FUCompanion Macros: GM permission required.");
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
    console.error("[FUSync] Manifest fetch failed:", e);
    return ui.notifications.error(`Sync: failed to load ${MANIFEST_URL} (${e.message})`);
  }

  const entries = Array.isArray(manifest?.macros) ? manifest.macros : [];
  if (!entries.length) {
    return ui.notifications.warn("Sync: manifest contains no macro entries.");
  }

  const result = { updated: 0, created: 0, unchanged: 0, failed: 0, skipped: 0 };
  const failures = [];

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
        if (existing.command === text) {
          result.unchanged++;
          continue;
        }
        await existing.update({ command: text });
        result.updated++;
        console.log(`[FUSync] Updated "${name}" (${text.length} chars)`);
      } else {
        await Macro.create({
          name,
          type: "script",
          command: text,
          scope: "global",
          img: "icons/svg/dice-target.svg"
        });
        result.created++;
        console.log(`[FUSync] Created "${name}" (${text.length} chars)`);
      }
    } catch (e) {
      result.failed++;
      failures.push({ name, path, error: e.message });
      console.error(`[FUSync] FAILED for "${name}" (${path}):`, e);
    }
  }

  const summary = `Sync: ${result.updated} updated, ${result.created} created, ${result.unchanged} unchanged, ${result.failed} failed, ${result.skipped} skipped`;
  if (result.failed > 0) {
    console.warn("[FUSync] Failures:", failures);
    ui.notifications.warn(summary + " — see console for failures");
  } else {
    ui.notifications.info(summary);
  }
})();
