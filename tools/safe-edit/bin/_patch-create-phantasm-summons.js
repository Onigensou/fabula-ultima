#!/usr/bin/env node
"use strict";

// One-shot patch: insert a FUCompanion.api.phantasm.markSummon(...) call
// into each Create Phantasm: ... skill's custom_logic_resolution so the
// spawned token carries a summonedBy flag identifying the reactor's actor.
// Pairs with the Phantasmal Echo gate change (which requires that flag).
//
// Strategy:
//   - HTML→JS strip the field
//   - Find the line `const summonTokenUuid = createdTokenDoc.uuid;`
//   - If "markSummon" already appears in the script, skip (idempotent)
//   - Insert the markSummon block immediately after that line
//   - JS→HTML re-encode (each line as <p>...</p>, & < > escaped)
//   - safeEdit the field
//
// Targets (CLI-overridable with --skill):
//   Item.n72OGOx8TLGF1i9u — Create Phantasm: Dread
//   Item.CJRJAE0NG7Kyk48Y — Create Phantasm: Strike
//
// Usage:
//   node tools/safe-edit/bin/_patch-create-phantasm-summons.js [--dry-run] [--skill <UUID>]...

const { safeEdit, getDoc } = require("../lib");

const DEFAULT_TARGETS = [
  "Item.n72OGOx8TLGF1i9u", // Create Phantasm: Dread
  "Item.CJRJAE0NG7Kyk48Y", // Create Phantasm: Strike
];

const INSERT_SNIPPET = `// Stamp ownership so reactions like Phantasmal Echo can recognize "my own Phantasm shattered".
try {
  const _summonerDoc = attackerUuid ? await fromUuid(attackerUuid) : null;
  const _summonerActorUuid = _summonerDoc?.actor?.uuid
    ?? (_summonerDoc?.documentName === "Actor" ? _summonerDoc.uuid : attackerUuid);
  await globalThis?.FUCompanion?.api?.phantasm?.markSummon?.(createdTokenDoc, _summonerActorUuid);
} catch (_e) { /* markSummon is non-critical to spawn */ }`;

// ---------------- CLI parse ----------------
const args = process.argv.slice(2);
const targets = [];
let dryRun = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--skill") { targets.push(args[++i]); continue; }
  if (args[i] === "--dry-run") { dryRun = true; continue; }
  if (args[i] === "--help" || args[i] === "-h") {
    console.log("Usage: --dry-run; --skill <UUID> (repeatable; defaults to the 2 known summoners)");
    process.exit(0);
  }
}
const skillUuids = targets.length ? targets : DEFAULT_TARGETS;

// ---------------- HTML <-> JS conversion ----------------
function htmlToJs(html) {
  return String(html ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function jsToHtml(src) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return src
    .split("\n")
    .map((line) => `<p>${line === "" ? "" : esc(line)}</p>`)
    .join("");
}

// ---------------- Transformation ----------------
const ANCHOR_RE = /^(\s*)const\s+summonTokenUuid\s*=\s*createdTokenDoc\.uuid\s*;/m;

function transformJs(srcJs) {
  if (srcJs.includes("markSummon")) {
    return { changed: false, reason: "already_patched", out: srcJs };
  }
  const match = ANCHOR_RE.exec(srcJs);
  if (!match) {
    return { changed: false, reason: "anchor_not_found", out: srcJs };
  }
  const insertAt = match.index + match[0].length;
  const indent = match[1] ?? "";
  const indented = INSERT_SNIPPET.split("\n").map((line) => indent + line).join("\n");
  const out = srcJs.slice(0, insertAt) + "\n" + indented + srcJs.slice(insertAt);
  return { changed: true, reason: "patched", out };
}

// ---------------- Run ----------------
(async () => {
  console.log(`[patch] dryRun=${dryRun}, targets=${skillUuids.length}`);
  for (const uuid of skillUuids) {
    console.log(`\n[patch] ${uuid}`);
    const it = await getDoc(uuid);
    if (!it) { console.warn("  skip — not found"); continue; }
    const fieldHtml = it?.system?.props?.custom_logic_resolution ?? "";
    const js = htmlToJs(fieldHtml);
    const t = transformJs(js);
    console.log(`  ${it.name}: anchor=${ANCHOR_RE.test(js) ? "yes" : "no"}, status=${t.reason}`);
    if (!t.changed) continue;

    if (dryRun) {
      const idx = ANCHOR_RE.exec(t.out).index;
      const slice = t.out.slice(Math.max(0, idx - 80), idx + 600);
      console.log(`  --- inserted (preview, ~100 chars before anchor, ~600 after) ---`);
      console.log(slice.split("\n").map((l) => "    " + l).join("\n"));
      console.log(`  ----`);
      console.log(`  DRY RUN — would write ${jsToHtml(t.out).length} chars (was ${fieldHtml.length})`);
      continue;
    }

    const newHtml = jsToHtml(t.out);
    try {
      const result = await safeEdit({
        uuid,
        patch: { "system.props.custom_logic_resolution": newHtml },
        note: `Insert FUCompanion.api.phantasm.markSummon stamp after spawn (Phantasm ownership wiring)`,
      });
      console.log(`  OK entryId=${result.entryId} backup=${result.backupPath}`);
    } catch (e) {
      console.error(`  FAILED:`, e.message);
    }
  }
  console.log(`\n[patch] Done.`);
})();
