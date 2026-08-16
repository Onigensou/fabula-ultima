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
 * 2) Macro source SEEDING (GM only)
 *    Walks `macros/_manifest.json` and CREATES any macro that is missing from
 *    the world's macro directory, from its source file. A macro that already
 *    exists is left ALONE — this script seeds a new world (or a newly-added
 *    macro) but never overwrites a macro already present. In-game edits to a
 *    synced macro therefore PERSIST across refreshes; the world copy is the
 *    authority once it exists (matches our "world data is authoritative"
 *    delivery model — see [[feedback_seed_only_migrations_world_authoritative]]).
 *
 *    ⚠ Trade-off: a `git pull` that changes a macro's source will NOT auto-apply
 *    to a world that already has that macro. To push a source change into an
 *    existing macro, delete the live macro (then it re-seeds from disk on the
 *    next boot) or paste the new source in by hand.
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
 *    - Create-only: an existing macro (by name) is never written — only missing
 *      ones are created. Zero writes in steady state.
 *    - GM-only: regular players don't have permission to modify macros and
 *      shouldn't trigger this anyway.
 *    - The "Sync FUCompanion Macros" macro itself is intentionally NOT in the
 *      manifest, so this script never touches the manual fallback.
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
  // macro seed for a single session (e.g. when intentionally testing a world
  // that is missing a macro and you don't want it re-created).
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

  const result = { created: 0, preserved: 0, failed: 0, skipped: 0 };
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
        // SEED-ONLY: a macro already present in the world is OWNED by the world,
        // not by this script. Never overwrite it, so in-game edits survive a
        // refresh. To push a source change into an existing macro, delete the
        // live macro (it re-seeds from disk next boot) or paste in the new source.
        result.preserved++;
        continue;
      }
      await Macro.create({
        name,
        type: "script",
        command: text,
        scope: "global",
        img: "icons/svg/dice-target.svg"
      });
      result.created++;
      touched.push(`${name} (new)`);
    } catch (e) {
      result.failed++;
      failures.push({ name, path, error: e.message });
      console.error(`${FU_BOOT_TAG} sync failed for "${name}" (${path}):`, e);
    }
  }

  const summary =
    `${result.created} created, ${result.preserved} preserved, ` +
    `${result.failed} failed, ${result.skipped} skipped`;

  if (result.failed > 0) {
    console.warn(`${FU_BOOT_TAG} Macro seed complete — ${summary}`, { failures });
    ui.notifications?.warn(`Macro seed: ${summary} — see console for failures`);
  } else if (result.created > 0) {
    console.info(`${FU_BOOT_TAG} Macro seed complete — ${summary}`, { touched });
    ui.notifications?.info(`Macro seed: ${summary}`);
  } else {
    // Quiet path: every manifest macro already exists. Just a console line, no toast.
    console.info(`${FU_BOOT_TAG} Macro seed complete — ${summary}`);
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
// Boot (3) and (3b) write the SAME template documents, and Foundry does NOT
// await hook listeners — it just calls them in registration order. Both take a
// snapshot (`toObject(false)` / deepClone) and later `update()` from it, so run
// concurrently the second write reverts whatever the first one added: (3)'s
// backfilled dropdown options vanish, or (3b)'s column/gate work does. Steady
// state hides it (both no-op), which is why it has never been seen — but a boot
// where both have work, like a migration boot, is exactly when it fires.
//
// (3b) awaits this latch. It MUST settle on every exit path of (3), including
// the early returns, or (3b) would hang forever instead.
// ⚠ This file is a CLASSIC script (module.json `scripts`), NOT an esmodule, and
// is not IIFE-wrapped — every top-level binding here joins the shared global
// lexical scope. A collision with any other classic script throws at PARSE time
// and silently skips this ENTIRE file (macro seeding AND both syncs). Hence the
// FU_ prefix, matching FU_BOOT_TAG above.
let FU_MARK_DROPDOWN_SYNC_DONE;
const FU_DROPDOWN_SYNC_DONE = new Promise((resolve) => { FU_MARK_DROPDOWN_SYNC_DONE = resolve; });

Hooks.once("ready", async () => {
  try {
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
  } finally { FU_MARK_DROPDOWN_SYNC_DONE(); }
});

// ---------------------------------------------------------------------------
// (3b) Template COLUMN sync — ensure every declarative row-field the engine
// reads has a rowLayout COLUMN. Companion to (3): (3) backfills missing option
// VALUES into existing select columns; (3b) backfills missing COLUMNS entirely.
// Driven by template-field-registry.js, so adding a declarative field = ONE
// registry line + an engine read — the column self-heals onto every template on
// boot. Closes the "data-only field stripped/uneditable" gap that (3) couldn't
// (a missing column has no options to sync). See [[feedback_csb_template_gating]].
//
// Edits only TRUE template items (system.template empty); instances re-derive
// from their template, so we version-sync them instead. Steady state (all
// columns present) does ZERO writes — safe to run every boot.
Hooks.once("ready", async () => {
  if (!game.user?.isGM) return;
  if (globalThis.__FU_DISABLE_DROPDOWN_SYNC__) return;
  const MODULE_ID = "fabula-ultima-companion";
  try {
    // Serialize against (3) — see the latch above. Inside the try so a future
    // rejection is handled here rather than escaping as an unhandled rejection.
    await FU_DROPDOWN_SYNC_DONE;
    const reg = await import(`${window.location.origin}/modules/${MODULE_ID}/scripts/battle-director/template-field-registry.js?t=${Date.now()}`);
    const byTable = reg.REQUIRED_COLUMNS_BY_TABLE ?? {};
    if (!Object.keys(byTable).length) return;

    const findTable = (node, key, d = 0) => {
      if (d > 18 || !node || typeof node !== "object") return null;
      if (node.key === key && Array.isArray(node.rowLayout)) return node;
      if (Array.isArray(node)) { for (const c of node) { const r = findTable(c, key, d + 1); if (r) return r; } return null; }
      for (const k of Object.keys(node)) { const r = findTable(node[k], key, d + 1); if (r) return r; }
      return null;
    };

    // PRESENTATION fields the registry OWNS on a column it already exists on —
    // otherwise a registry entry only ever takes effect for a column it happened
    // to author, and every later fix is inert. That gap is why 320 authored cells
    // sat invisible: the fix lived in the registry and never reached the template.
    //
    // ONE flag governs the whole entry. A tooltip is not "safe because it is only
    // prose": on an over-narrow entry the prose DESCRIBES the wrong gate, and it
    // lands on the same rows. `grant_resource` is the case that decided this —
    // registry says "Blank or All = any", the live field says blank DISABLES the
    // effect, and it is authored on 176 `grant` rows. Pushing that text while
    // correctly withholding its gate would be worse than pushing nothing.
    //
    //   A visibilityFormula HIDES the data it excludes. Several long-standing
    //   registry gates are narrower than real usage (grant_amount is gated to
    //   adjust_grant but authored on 177 `grant` rows; `count` is gated to
    //   trigger_opportunity but authored on 127 `targeting` rows). They have been
    //   harmless only because this sync never touched an existing column —
    //   pushing them wholesale would hide ~750 authored cells at once. So a gate
    //   is reconciled ONLY when its registry entry opts in with
    //   `reconcileVis: true`, which means "this gate has been checked against
    //   live data" — verify with tools/csb-template/bin/visibility-audit.js.
    //
    // `type` and `options` are excluded entirely: a type change can strand data,
    // and options belong to the (3) dropdown sync above.
    const RECONCILED_FIELDS = ["tooltip", "colName", "visibilityFormula"];

    const touched = new Set();
    const detail = [];
    const retuned = [];
    const mismatched = [];
    for (const item of game.items.contents) {
      if (item.system?.template) continue; // instance — re-derives from its template
      const sys = foundry.utils.deepClone(item.toObject(false).system ?? {});
      let changed = false;
      for (const [tableKey, cols] of Object.entries(byTable)) {
        const node = findTable(sys, tableKey);
        if (!node) continue;
        const have = new Map(node.rowLayout.map((c) => [c?.key, c]));
        for (const col of cols) {
          if (!col?.key) continue;
          const existing = have.get(col.key);
          if (!existing) {
            // `reconcileVis` is registry bookkeeping, not a CSB column property —
            // never let it reach the template.
            const { reconcileVis, ...colDef } = col;
            node.rowLayout.push(colDef);
            have.set(col.key, colDef);
            changed = true;
            detail.push(`${item.name}/${tableKey}:${col.key}`);
            continue;
          }
          if (col.reconcileVis !== true) continue;
          // Same type only — a type change is a migration, not a sync. Say so:
          // silently skipping made `reconcileVis: true` a no-op with no signal,
          // so a gate fix could "ship" and change nothing.
          if (existing.type !== col.type) {
            mismatched.push(`${item.name}/${tableKey}:${col.key} (template=${existing.type}, registry=${col.type})`);
            continue;
          }
          for (const f of RECONCILED_FIELDS) {
            const want = col[f] ?? "";
            if ((existing[f] ?? "") === want) continue;
            existing[f] = want;
            changed = true;
            retuned.push(`${item.name}/${tableKey}:${col.key}.${f}`);
          }
        }
      }
      if (changed) { await item.update({ system: sys }); touched.add(item.id); }
    }

    if (mismatched.length) {
      console.warn(`${FU_BOOT_TAG} Column sync: ${mismatched.length} column(s) opted into reconcile but differ in TYPE — left untouched (a type change is a migration): ${mismatched.join(", ")}`);
    }

    if (touched.size) {
      // Version-sync instances of touched templates so sheets re-derive.
      const wantById = new Map();
      for (const id of touched) {
        const tpl = game.items.get(id);
        const v = tpl?.system?.templateSystemUniqueVersion;
        if (v !== undefined && v !== null) wantById.set(id, v);
      }
      const cls = CONFIG.Item.documentClass;
      const worldUpdates = [];
      for (const item of game.items.contents) {
        const tid = String(item.system?.template ?? "");
        if (wantById.has(tid) && item.system?.templateSystemUniqueVersion !== wantById.get(tid)) {
          worldUpdates.push({ _id: item.id, "system.templateSystemUniqueVersion": wantById.get(tid) });
        }
      }
      if (worldUpdates.length) await cls.updateDocuments(worldUpdates);
      for (const actor of game.actors.contents) {
        const ups = [];
        for (const item of actor.items.contents) {
          const tid = String(item.system?.template ?? "");
          if (wantById.has(tid) && item.system?.templateSystemUniqueVersion !== wantById.get(tid)) {
            ups.push({ _id: item.id, "system.templateSystemUniqueVersion": wantById.get(tid) });
          }
        }
        if (ups.length) await actor.updateEmbeddedDocuments("Item", ups);
      }
      console.info(`${FU_BOOT_TAG} Column sync: added ${detail.length} column(s), retuned ${retuned.length} presentation field(s) across ${touched.size} template(s).`);
      if (detail.length) console.info(`${FU_BOOT_TAG}   added: ${detail.join(", ")}`);
      if (retuned.length) console.info(`${FU_BOOT_TAG}   retuned: ${retuned.join(", ")}`);
      ui.notifications?.info(`Template columns: +${detail.length} column(s), ${retuned.length} retuned — see console`);
    } else {
      console.info(`${FU_BOOT_TAG} Column sync: all registry columns present and in sync.`);
    }
  } catch (e) {
    console.error(`${FU_BOOT_TAG} Template column sync failed:`, e);
  }
});
