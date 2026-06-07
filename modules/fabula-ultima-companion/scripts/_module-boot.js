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
 * 3) Template dropdown-options sync (GM only)
 *    Ensures every CSB select column in the skill template lists every value the
 *    engine + authored skills actually use — so CSB never STRIPS a value the
 *    sheet doesn't recognize (the recurring "unknown effect_kind"/"unknown
 *    resource" class of bug: a value authored via migration is valid in data +
 *    harness, but the moment a human opens the sheet, CSB drops any select value
 *    absent from the option list → falls back to the default → error). Driven by
 *    engine registries (effect_kind, reaction_trigger) + a data scan of the
 *    skill masters. Runs EVERY boot (idempotent) so it self-heals for any future
 *    value — no per-kind template edit to remember. See [[csb-template-gating]].
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

// ---------------------------------------------------------------------------
// (3) Template dropdown-options sync — every boot, GM client only.
// ---------------------------------------------------------------------------
// CSB validates select-column VALUES against the column's option list whenever
// the item sheet is saved/opened, and SILENTLY STRIPS any value not in the list.
// So a value authored via migration (data layer) works in the harness but the
// instant a human opens the sheet it's dropped → default → "unknown ..." error
// (bit add_target/Barrage, adjust_accuracy/Crossfire, + others). The root cause
// is hand-maintained option lists drifting from the values actually in use. This
// sync makes the engine + authored data authoritative and backfills the template
// every boot, so it self-heals for ALL dropdowns + any future value.
Hooks.once("ready", async () => {
  if (!game.user?.isGM) return;
  if (globalThis.__FU_DISABLE_DROPDOWN_SYNC__) {
    console.info(`${FU_BOOT_TAG} Dropdown-options sync skipped (__FU_DISABLE_DROPDOWN_SYNC__ set).`);
    return;
  }
  const MODULE_ID = "fabula-ultima-companion";
  const SKILL_TEMPLATE_ID = "j0F5Msw5RZ8aIB3j";

  try {
    const tmpl = game.items.get(SKILL_TEMPLATE_ID);
    if (!tmpl) { console.info(`${FU_BOOT_TAG} Dropdown sync: skill template not found.`); return; }

    // Registry-sourced required options (key → friendly label). These carry
    // proper labels + include valid-but-currently-unused values; the data scan
    // below is the general safety net for every other select column.
    const registries = {};
    try {
      const se = await import(`${window.location.origin}/modules/${MODULE_ID}/scripts/battle-director/skill-effects.js?t=${Date.now()}`);
      if (Array.isArray(se.SUPPORTED_EFFECT_KINDS)) {
        registries.effect_kind = se.SUPPORTED_EFFECT_KINDS.map((k) => ({ key: k, value: se.EFFECT_KIND_LABELS?.[k] ?? k }));
      }
    } catch (e) { console.warn(`${FU_BOOT_TAG} Dropdown sync: effect_kind registry import failed:`, e?.message ?? e); }
    try {
      const RT = window["oni.ReactionTriggers"];
      if (RT?.listTriggers) registries.reaction_trigger = RT.listTriggers().map((t) => ({ key: t.key, value: t.label ?? t.key }));
    } catch { /* triggers not ready this boot — data scan still covers used ones */ }

    const sys = foundry.utils.deepClone(tmpl.toObject(false).system ?? {});

    // Find every select column node (has a string `key` + an `options` array).
    const selectNodes = [];
    (function walk(n, d) {
      if (d > 16 || !n || typeof n !== "object") return;
      if (typeof n.key === "string" && Array.isArray(n.options)) selectNodes.push(n);
      if (Array.isArray(n)) n.forEach((v) => walk(v, d + 1));
      else for (const k of Object.keys(n)) walk(n[k], d + 1);
    })(sys, 0);
    if (!selectNodes.length) { console.info(`${FU_BOOT_TAG} Dropdown sync: no select columns.`); return; }
    const selectKeys = new Set(selectNodes.map((n) => n.key));

    // Data scan — collect every value used under each select key across the
    // skill MASTERS (canonical authored data; avoids garbage from drifted actor
    // copies). Covers top-level select props + one level of table rows.
    const usedByKey = {};
    const addUsed = (k, v) => { if (typeof v === "string" && v.trim()) (usedByKey[k] ??= new Set()).add(v.trim()); };
    for (const it of game.items.contents) {
      if (it.system?.template !== SKILL_TEMPLATE_ID) continue;
      const props = it.system?.props ?? {};
      for (const [k, v] of Object.entries(props)) {
        if (selectKeys.has(k) && typeof v === "string") addUsed(k, v);
        if (v && typeof v === "object" && !Array.isArray(v)) {
          for (const row of Object.values(v)) {
            if (row && typeof row === "object" && !Array.isArray(row)) {
              for (const rk of Object.keys(row)) if (selectKeys.has(rk)) addUsed(rk, row[rk]);
            }
          }
        }
      }
    }

    // Backfill missing options per column.
    let added = 0;
    const detail = [];
    for (const node of selectNodes) {
      const have = new Set(node.options.map((o) => o?.key));
      const required = [];
      if (registries[node.key]) required.push(...registries[node.key]);
      for (const v of (usedByKey[node.key] ?? [])) required.push({ key: v, value: v });
      for (const opt of required) {
        if (!opt.key || have.has(opt.key)) continue;
        node.options.push(opt);
        have.add(opt.key);
        added += 1;
        detail.push(`${node.key}:${opt.key}`);
      }
    }

    if (added > 0) {
      await tmpl.update({ system: sys });
      console.info(`${FU_BOOT_TAG} Dropdown sync: backfilled ${added} option(s): ${detail.join(", ")}`);
      ui.notifications?.info(`Template dropdowns: backfilled ${added} option(s) — see console`);
    } else {
      console.info(`${FU_BOOT_TAG} Dropdown sync: all select columns already complete.`);
    }
  } catch (e) {
    console.error(`${FU_BOOT_TAG} Dropdown-options sync failed:`, e);
  }
});
