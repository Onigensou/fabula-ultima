/**
 * Migration: 2026-05-27-spiritist-batch2-3-author
 * ---------------------------------------------------------------------------
 * Authors the 7 Spiritist Batch 2 + 3 master items in `game.items`:
 *   Cleanse, Torpor, Hallucination, Enrage, Awaken, Aura, Barrier.
 *
 * Reads canonical spec from
 *   docs/battle-director-spiritist-skills.json
 * (served by Foundry at /modules/fabula-ultima-companion/docs/...). Each
 * entry's `spec` field carries the same shape CreateSkillFromSpec accepts:
 *   { name, img, class, folder, props, activeEffects? }
 *
 * For each spec:
 *   1. Resolve target folder = `Battle Director / Spiritist / <folder>`
 *      (`folder` defaults to `Skill`). Skip the item if the folder tree
 *      isn't scaffolded — author the folders first by running the world's
 *      Battle Director folder-scaffold macro.
 *   2. Find existing master by name + `system.props.class === "Spiritist"`.
 *   3. If absent → create via `Item.implementation.create` with template
 *      link to `_Skill Template` (j0F5Msw5RZ8aIB3j), `system.unique = true`,
 *      and the spec's `activeEffects` as embedded AEs.
 *   4. If present → diff-update `system.props` (excluding `uuid`/`id` —
 *      those are doc-side fingerprints that must not be cross-pollinated)
 *      and reconcile embedded AEs by NAME (create-if-missing, update-if-
 *      different, leave alone if matching).
 *
 * IDEMPOTENT: re-runs no-op when content already matches the spec.
 *
 * SCOPE: master items only. Per the request that triggered this migration,
 * actor copies are NOT touched here — actor-side propagation is handled
 * either manually by the GM (re-add the skill) or by a separate later
 * migration if/when shape changes warrant a sweep.
 *
 * Dependency: 2026-05-27-skill-template-batch3-columns (adds the
 * `remove_tagged_ae` dropdown entry + `filter_tag`/`count` columns to
 * the _Skill Template so Cleanse's effect_table row stores cleanly).
 */

import { ensureFolderPath } from "./_folder-tree.js";

export const key = "2026-05-27-spiritist-batch2-3-author";
export const description =
  "Author the 7 Spiritist Batch 2+3 master items (Cleanse / Torpor / " +
  "Hallucination / Enrage / Awaken / Aura / Barrier) from docs spec. " +
  "Master items only — no actor-copy sweep.";

const SPEC_URL_PATH = "modules/fabula-ultima-companion/docs/battle-director-spiritist-skills.json";
const SKILL_TEMPLATE_ID = "j0F5Msw5RZ8aIB3j";
const WANTED_NAMES = ["Cleanse", "Torpor", "Hallucination", "Enrage", "Awaken", "Aura", "Barrier"];
const ROOT_FOLDER_NAME = "Battle Director";

// ─── helpers ─────────────────────────────────────────────────────────────

function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const keys = Object.keys(v).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}
const deepEqual = (a, b) => stableStringify(a) === stableStringify(b);

async function fetchSpec(log) {
  try {
    const url = "/" + SPEC_URL_PATH;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    return await res.json();
  } catch (e) {
    log(`fetch failed: ${e?.message ?? e}`);
    return null;
  }
}

// Self-healing: ensure `Battle Director / <classKey> / <subFolderName>` exists
// (creating any missing level), so a fresh world resolves the folder instead of
// skipping the author. See [[battle-director-folder-tree]] + `_folder-tree.js`.
async function resolveClassFolder(game, classKey, subFolderName, log) {
  const { folder } = await ensureFolderPath(
    game, [ROOT_FOLDER_NAME, classKey, subFolderName], { log });
  return folder ?? null;
}

function findExistingMaster(game, spec) {
  const wantClass = String(spec?.props?.class ?? "").trim();
  for (const item of game.items?.contents ?? []) {
    if (item.name !== spec.name) continue;
    const itClass = String(item.system?.props?.class ?? "").trim();
    if (wantClass && itClass !== wantClass) continue;
    if (String(item.system?.template ?? "") !== SKILL_TEMPLATE_ID) continue;
    return item;
  }
  return null;
}

// Build the props object to write. We exclude `uuid`/`id` so they're left
// for the doc layer to assign, and exclude `name`/`img` which live at the
// document level (not in props).
function cleanProps(specProps) {
  const out = foundry.utils.deepClone(specProps ?? {});
  delete out.uuid;
  delete out.id;
  return out;
}

// Convert spec's activeEffects[] to AE create payloads (drop `_id` so
// Foundry assigns fresh ids). Also coerce flag bag under the module
// namespace to a plain object.
function aeCreatePayload(aeSpec) {
  const c = foundry.utils.deepClone(aeSpec ?? {});
  delete c._id;
  return c;
}

async function ensureEmbeddedAEs(item, specAEs, label, log) {
  const desired = Array.isArray(specAEs) ? specAEs : [];
  const existing = Array.from(item.effects?.contents ?? []);
  let touched = 0;

  for (const aeSpec of desired) {
    const name = aeSpec.name;
    if (!name) continue;
    const match = existing.find((e) => e.name === name);
    if (!match) {
      await item.createEmbeddedDocuments("ActiveEffect", [aeCreatePayload(aeSpec)]);
      touched += 1;
      log(`${label}: created embedded AE "${name}"`);
      continue;
    }
    // Diff-update the key fields. Foundry's AE.update merges, so we
    // only push fields that diverge to avoid spurious change events.
    const update = { _id: match.id };
    const cmpKeys = ["icon", "changes", "duration", "transfer", "statuses", "description", "system", "flags"];
    let needsUpdate = false;
    for (const k of cmpKeys) {
      const desiredVal = aeSpec[k];
      if (desiredVal === undefined) continue;
      if (!deepEqual(match[k], desiredVal)) {
        update[k] = desiredVal;
        needsUpdate = true;
      }
    }
    if (needsUpdate) {
      await item.updateEmbeddedDocuments("ActiveEffect", [update]);
      touched += 1;
      log(`${label}: updated embedded AE "${name}"`);
    }
  }
  return touched;
}

async function ensureMaster(game, spec, log) {
  const name = spec.name;
  const label = `master "${name}"`;
  const subFolderName = String(spec.folder ?? "Skill");
  const classKey = String(spec.props?.class ?? "Spiritist");

  const folder = await resolveClassFolder(game, classKey, subFolderName, log);
  if (!folder) {
    log(`${label}: folder unresolved — skipping`);
    return { skipped: true, reason: "no-folder" };
  }

  let item = findExistingMaster(game, spec);
  let createdNow = false;

  if (!item) {
    const data = {
      name,
      img: spec.img ?? "icons/svg/sun.svg",
      type: "equippableItem",
      folder: folder.id,
      system: {
        template: SKILL_TEMPLATE_ID,
        unique: true,
        props: cleanProps(spec.props),
      },
      effects: (spec.activeEffects ?? []).map(aeCreatePayload),
      ownership: { default: 0 },
    };
    try {
      item = await Item.implementation.create(data);
      createdNow = true;
      log(`${label}: created [${item?.id ?? "?"}]`);
    } catch (e) {
      log(`${label}: create threw: ${e?.message ?? e}`);
      return { skipped: true, reason: "create-threw" };
    }
    if (!item) {
      log(`${label}: create returned nothing`);
      return { skipped: true, reason: "create-returned-nothing" };
    }
  } else {
    log(`${label}: found existing [${item.id}]`);
  }

  // Diff-update props.
  const desiredProps = cleanProps(spec.props);
  const currentProps = item.system?.props ?? {};
  const propsPatch = {};
  for (const k of Object.keys(desiredProps)) {
    if (!deepEqual(currentProps[k], desiredProps[k])) propsPatch[k] = desiredProps[k];
  }
  const folderMismatch = item.folder?.id !== folder.id;
  const imgMismatch = !!spec.img && item.img !== spec.img;

  if (Object.keys(propsPatch).length || folderMismatch || imgMismatch) {
    const update = {};
    if (folderMismatch) update.folder = folder.id;
    if (imgMismatch) update.img = spec.img;
    for (const k of Object.keys(propsPatch)) update[`system.props.${k}`] = propsPatch[k];
    await item.update(update);
    log(
      `${label}: updated (` +
      [
        folderMismatch && "folder",
        imgMismatch && "img",
        Object.keys(propsPatch).length && `${Object.keys(propsPatch).length} prop(s)`,
      ].filter(Boolean).join(", ") +
      ")"
    );
  } else if (!createdNow) {
    log(`${label}: props up-to-date`);
  }

  // Reconcile embedded AEs (Aura/Barrier carry one each).
  if (Array.isArray(spec.activeEffects) && spec.activeEffects.length && !createdNow) {
    await ensureEmbeddedAEs(item, spec.activeEffects, label, log);
  }

  return { skipped: false, item, createdNow };
}

// ─── entry ───────────────────────────────────────────────────────────────

export async function migrate(game, log) {
  const specJson = await fetchSpec(log);
  if (!specJson) {
    return { applied: true, summary: "spec fetch failed — nothing authored" };
  }
  const allSpecs = (specJson.skills ?? [])
    .map((s) => s?.spec)
    .filter((s) => s && WANTED_NAMES.includes(s.name));
  log(`fetched ${allSpecs.length} of ${WANTED_NAMES.length} target specs`);

  let created = 0;
  let touched = 0;
  let skipped = 0;
  for (const spec of allSpecs) {
    const r = await ensureMaster(game, spec, log);
    if (r.skipped) skipped += 1;
    else if (r.createdNow) created += 1;
    else touched += 1;
  }

  return {
    applied: true,
    summary: `${created} created, ${touched} reconciled, ${skipped} skipped`,
  };
}
