/**
 * Migration: 2026-05-27-spiritist-batch4-author
 * ---------------------------------------------------------------------------
 * Authors the 6 Spiritist Batch 4 master items in `game.items`:
 *   Ritual Spiritism (Passive meta), Healing Power (Passive — post-spell
 *   SL×BOND_COUNT heal), Support Magic (Passive — post-spell bond-bonus AE),
 *   Vismagus (Passive meta — alt-cost handled engine-side), Mercy (Spell —
 *   reactive HP-floor-at-1 AE), Soul Weapon (Spell — weapon damage-type
 *   override AE).
 *
 * Same fetch + reconcile pattern as 2026-05-27-spiritist-batch2-3-author
 * — reads canonical specs from docs/battle-director-spiritist-skills.json
 * and creates or diff-updates each master in
 * `Battle Director / Spiritist / Skill`. Master items only; actor copies
 * are not swept (per the standing rule, GMs re-add skills to actors
 * manually).
 *
 * Dependency: 2026-05-27-spiritist-batch2-3-author (template surgery
 * + folder scaffold + Batch 2-3 specs land first). Engine extensions
 * shipped in code alongside this migration:
 *   - firePassiveTriggers + passive_trigger schema (skill-effects.js)
 *   - ally_action_targets / enemy_action_targets target_ref
 *     (skill-targeting.js)
 *   - HAS_ARCANE_WEAPON / HAS_MELEE_WEAPON / HAS_RANGED_WEAPON formula
 *     identifiers (skill-formulas.js)
 *   - applyMercyClamp helper wired into the Skill + Attack damage paths
 *     (state-handlers.js)
 *   - applySoulWeaponElementOverride wired into Attack damage compute
 *   - Vismagus alt-cost dialog at the TARGET-state affordability gate
 *     (state-handlers.js)
 *
 * IDEMPOTENT: re-runs no-op when content already matches the spec.
 */

import { ensureFolderPath } from "./_folder-tree.js";

export const key = "2026-05-27-spiritist-batch4-author";
export const description =
  "Author the 6 Spiritist Batch 4 master items (Ritual Spiritism, Healing " +
  "Power, Support Magic, Vismagus, Mercy, Soul Weapon) from docs spec. " +
  "Master items only.";

const SPEC_URL_PATH = "modules/fabula-ultima-companion/docs/battle-director-spiritist-skills.json";
const SKILL_TEMPLATE_ID = "j0F5Msw5RZ8aIB3j";
const WANTED_NAMES = ["Ritual Spiritism", "Healing Power", "Support Magic", "Vismagus", "Mercy", "Soul Weapon"];
const ROOT_FOLDER_NAME = "Battle Director";

// ─── helpers (mirror Batch 2-3 migration) ────────────────────────────────

function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const keys = Object.keys(v).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}
const deepEqual = (a, b) => stableStringify(a) === stableStringify(b);

async function fetchSpec(log) {
  try {
    const res = await fetch("/" + SPEC_URL_PATH);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${SPEC_URL_PATH}`);
    return await res.json();
  } catch (e) { log(`fetch failed: ${e?.message ?? e}`); return null; }
}

// Self-healing: ensure the folder path exists on demand (creates missing
// levels) rather than skipping. See `_folder-tree.js`.
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

function cleanProps(specProps) {
  const out = foundry.utils.deepClone(specProps ?? {});
  delete out.uuid;
  delete out.id;
  return out;
}

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
    if (!aeSpec?.name) continue;
    const match = existing.find((e) => e.name === aeSpec.name);
    if (!match) {
      await item.createEmbeddedDocuments("ActiveEffect", [aeCreatePayload(aeSpec)]);
      touched += 1;
      log(`${label}: created embedded AE "${aeSpec.name}"`);
      continue;
    }
    const update = { _id: match.id };
    const cmpKeys = ["icon", "changes", "duration", "transfer", "statuses", "description", "system", "flags"];
    let needsUpdate = false;
    for (const k of cmpKeys) {
      const v = aeSpec[k];
      if (v === undefined) continue;
      if (!deepEqual(match[k], v)) { update[k] = v; needsUpdate = true; }
    }
    if (needsUpdate) {
      await item.updateEmbeddedDocuments("ActiveEffect", [update]);
      touched += 1;
      log(`${label}: updated embedded AE "${aeSpec.name}"`);
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
  if (!folder) { log(`${label}: folder unresolved — skipping`); return { skipped: true, reason: "no-folder" }; }

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
    } catch (e) { log(`${label}: create threw: ${e?.message ?? e}`); return { skipped: true, reason: "create-threw" }; }
    if (!item) { log(`${label}: create returned nothing`); return { skipped: true, reason: "create-returned-nothing" }; }
  } else {
    log(`${label}: found existing [${item.id}]`);
  }

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
    log(`${label}: updated (` + [folderMismatch && "folder", imgMismatch && "img", Object.keys(propsPatch).length && `${Object.keys(propsPatch).length} prop(s)`].filter(Boolean).join(", ") + ")");
  } else if (!createdNow) {
    log(`${label}: props up-to-date`);
  }

  if (Array.isArray(spec.activeEffects) && spec.activeEffects.length && !createdNow) {
    await ensureEmbeddedAEs(item, spec.activeEffects, label, log);
  }
  return { skipped: false, item, createdNow };
}

// ─── entry ───────────────────────────────────────────────────────────────

export async function migrate(game, log) {
  const specJson = await fetchSpec(log);
  if (!specJson) return { applied: true, summary: "spec fetch failed — nothing authored" };
  const specs = (specJson.skills ?? [])
    .map((s) => s?.spec)
    .filter((s) => s && WANTED_NAMES.includes(s.name));
  log(`fetched ${specs.length} of ${WANTED_NAMES.length} target specs`);
  let created = 0, touched = 0, skipped = 0;
  for (const spec of specs) {
    const r = await ensureMaster(game, spec, log);
    if (r.skipped) skipped += 1;
    else if (r.createdNow) created += 1;
    else touched += 1;
  }
  return { applied: true, summary: `${created} created, ${touched} reconciled, ${skipped} skipped` };
}
