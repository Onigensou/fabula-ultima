/**
 * Migration: 2026-06-03-condition-fields-label-type
 * ---------------------------------------------------------------------------
 * Convert all named `condition_<status>` template fields from CSB `select`
 * (dropdown) type to `label` type so Active Effect changes can write to
 * them. The dropdown type silently rejects writes that aren't in its
 * `options` list — making it impossible for an AE to set `condition_dazed
 * = "IM"` even though the underlying prop accepts any string.
 *
 * Rampart's playtest mechanic (Jan 23, 2025) needs an AE that grants
 * "cannot suffer status effects" to self + scene allies. The cleanest
 * encoding is `condition_<status> = "IM"` per-status; this migration
 * makes that prop writable from an AE without breaking the legacy
 * read path (Encyclopedia + Study macros still compare the string
 * value against "RS"/"VU"/"IM"/"AB").
 *
 * Templates touched:
 *   - `_FabU Char Template v3.fire` (`OmwL5UqoVwjshkJo`)            — PC
 *   - `_FabU Char Template v3.fire (Copy)` (`N6ahjuHb0FjN5Y0Q`)      — PC copy
 *   - `_Fabula NPC template v.2` (`yegF6R8aaymhrvCg`)                — NPC
 *   - `_Fabula NPC template v.2 (Copy)` (`PV7MpTp8eVrAlW3O`)         — NPC copy
 *
 * Older numbered-slot templates (`_FabU Villain Template`,
 * `_Fabula NPC template`) use `condition_1..condition_33` with a
 * different "pick a status name" scheme — left untouched.
 *
 * Field-shape changes per matched field:
 *   - `type: "select"` → `type: "label"`
 *   - `options` and `selectedOptionType` removed (no longer relevant)
 *   - `key`, `label`, `defaultValue`, layout fields preserved
 *
 * Existing stored values (`"NA"`, `"RS"`, `"IM"`, `"AB"`) on every
 * world actor remain valid strings — label fields accept any value and
 * the legacy reads keep comparing against the same canonical set.
 *
 * IDEMPOTENT.
 */

export const key = "2026-06-03-condition-fields-label-type";
export const description =
  "Convert named condition_<status> fields on active PC/NPC templates from " +
  "select to label so AE writes (Rampart status immunity) land.";

const TEMPLATE_IDS = [
  "OmwL5UqoVwjshkJo",  // _FabU Char Template v3.fire (PC, active)
  "N6ahjuHb0FjN5Y0Q",  // _FabU Char Template v3.fire (Copy)
  "yegF6R8aaymhrvCg",  // _Fabula NPC template v.2
  "PV7MpTp8eVrAlW3O",  // _Fabula NPC template v.2 (Copy)
];

// Only the NAMED condition fields. Excludes `condition_affinity_panel`,
// `condition_status_panel`, `condition_immunities` (layout containers,
// not props) — those are tab/panel types and don't store values.
const NAMED_CONDITION_RE = /^condition_[a-z]+$/i;

function isTargetField(node) {
  if (!node || typeof node !== "object") return false;
  if (node.type !== "select") return false;
  const k = String(node.key ?? "");
  if (!NAMED_CONDITION_RE.test(k)) return false;
  return true;
}

function patchField(node) {
  node.type = "label";
  delete node.options;
  delete node.selectedOptionType;
  return node;
}

function walk(node, hits, depth = 0) {
  if (!node || typeof node !== "object" || depth > 16) return;
  if (isTargetField(node)) {
    patchField(node);
    hits.push(node.key);
  }
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (Array.isArray(v)) {
      for (const child of v) walk(child, hits, depth + 1);
    } else if (v && typeof v === "object") {
      walk(v, hits, depth + 1);
    }
  }
}

async function patchTemplate(template, log) {
  if (!template?.system?.body) {
    log(`  ${template.name}: no system.body — skipping`);
    return 0;
  }
  // Quick check — does any field match BEFORE we deepClone? Saves a
  // pointless write when the migration re-runs on an already-patched
  // template.
  let needs = false;
  function probe(node, depth = 0) {
    if (needs) return;
    if (!node || typeof node !== "object" || depth > 16) return;
    if (isTargetField(node)) { needs = true; return; }
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (Array.isArray(v)) for (const c of v) probe(c, depth + 1);
      else if (v && typeof v === "object") probe(v, depth + 1);
    }
  }
  probe(template.system.body);
  if (!needs) {
    log(`  ${template.name}: already patched (no select-typed condition_<name> fields found)`);
    return 0;
  }

  const sysClone = foundry.utils.duplicate(template.system);
  const hits = [];
  walk(sysClone.body, hits);
  if (!hits.length) {
    log(`  ${template.name}: walk found 0 matches after probe said yes — bailing`);
    return 0;
  }
  await template.update({ system: sysClone });
  log(`  ${template.name}: converted ${hits.length} field(s) → label (${hits.slice(0, 6).join(", ")}${hits.length > 6 ? `, +${hits.length - 6}` : ""})`);
  return hits.length;
}

export async function migrate(game, log) {
  let totalFields = 0;
  let templatesTouched = 0;
  for (const id of TEMPLATE_IDS) {
    const t = game.actors?.get?.(id);
    if (!t) {
      log(`no template at id ${id} — skipping`);
      continue;
    }
    const n = await patchTemplate(t, log);
    if (n > 0) {
      totalFields += n;
      templatesTouched += 1;
    }
  }
  return {
    applied: true,
    summary: `${totalFields} condition_<name> field(s) converted across ${templatesTouched}/${TEMPLATE_IDS.length} template(s)`,
  };
}
