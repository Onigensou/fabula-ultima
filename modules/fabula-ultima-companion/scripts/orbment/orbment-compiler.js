// scripts/orbment/orbment-compiler.js
//
// The COMPILER — turns an item's installed-augment state (flags) into the
// concrete artifacts the rest of the module reads. Reconcile-style & idempotent,
// modelled on reconcileSetBonuses: on every run it STRIPS the prior orbment
// projection, then RE-APPLIES from scratch, then MIRRORS the whole result across
// the item's transform link group. So install / remove / rarity-change all route
// through the one function and can never leak a stale artifact.
//
// Projection targets (see augment-registry.js for the per-augment data):
//   props  → item.system.props overrides, with intrinsic values snapshotted in
//            flags…orbment.baseProps for exact restore on removal.
//   rider  → orbment-prefixed rows in reaction_config_table + effect_table.
//   ae     → embedded ActiveEffect(s) tagged ORBMENT_TAG (transfer:true).
//   +  a human-readable summary fenced into item.system.props.description.

import {
  FLAG_NS, ORBMENT_FLAG, ORBMENT_TAG, ORBMENT_ROW_PREFIX,
  DESC_SENTINEL, slotCountOf, itemKindOf, readOrbment, nameStem,
} from "./orbment-const.js";
import { resolveAugment } from "./augment-registry.js";

const TAG = "[Orbment]";
const log  = (...a) => console.debug(TAG, ...a);
const warn = (...a) => console.warn(TAG, ...a);

// ── Link group ────────────────────────────────────────────────────────────────
// A transform weapon may be represented as TWO Item docs on the same actor (e.g.
// "+3 Zarg's Bow" + "+3 Zarg's Bow - Light"); the user wants an augment installed
// on one to apply to both. Resolve the sibling ids that share this item's name
// stem + item_type. (The modern single-item weapon_forms transform needs nothing
// here — its forms are the SAME Item, so any projection already covers them.)
function resolveLinkGroup(item) {
  const actor = item?.parent;
  if (!actor) return [item.id];
  // Explicit stored group wins (once resolved it's persisted, stable).
  const stored = readOrbment(item).linkGroup;
  if (stored && stored.length) {
    const ids = stored.filter((id) => actor.items.get(id));
    if (!ids.includes(item.id)) ids.push(item.id);
    return ids;
  }
  const stem = nameStem(item.name);
  const kind = itemKindOf(item);
  const group = actor.items.contents
    .filter((it) => itemKindOf(it) === kind && nameStem(it.name) === stem)
    .map((it) => it.id);
  return group.length ? group : [item.id];
}

// ── Small table helpers ────────────────────────────────────────────────────────
function tableToArray(tbl) {
  if (!tbl || typeof tbl !== "object") return [];
  return Object.keys(tbl)
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => tbl[k])
    .filter(Boolean);
}
function arrayToTable(rows) {
  const out = {};
  rows.forEach((r, i) => { out[String(i)] = r; });
  return out;
}
const isOrbmentEffectRow   = (r) => String(r?.effect_label ?? "").startsWith(ORBMENT_ROW_PREFIX);
const isOrbmentReactionRow = (r) => String(r?.reaction_effect_ref ?? "").startsWith(ORBMENT_ROW_PREFIX);

// ── Build the projection for the augments installed on ONE item ───────────────
// Returns { propOverrides:Map, reactionRows:[], effectRows:[], aeDocs:[], summary:[] }.
function buildProjection(installedAugments, itemType) {
  const propOverrides = new Map();   // propKey → value
  const reactionRows = [];
  const effectRows = [];
  const aeDocs = [];
  const summary = [];                // [{label, detail}]

  for (const { slotIndex, augment } of installedAugments) {
    // An augment only projects onto an item whose type it applies to (a shared
    // transform group is same-type, but this keeps mixed groups honest).
    if (!augment.appliesTo.includes(itemType)) {
      summary.push({ slotIndex, label: augment.label, detail: "(n/a for this item)" });
      continue;
    }
    summary.push({ slotIndex, label: augment.label, detail: augment.summary });

    // props
    if (augment.props) {
      for (const [k, v] of Object.entries(augment.props)) propOverrides.set(k, v);
    }
    // rider → reaction row + effect row(s)
    if (augment.rider) {
      const effects = Array.isArray(augment.rider.effects) ? augment.rider.effects : [];
      const labels = effects.map((_, i) => `${ORBMENT_ROW_PREFIX}${augment.id}_${i}`);
      let entryLabel;
      if (effects.length === 1) {
        entryLabel = labels[0];
        effectRows.push({ ...effects[0], effect_label: labels[0] });
      } else if (effects.length > 1) {
        entryLabel = `${ORBMENT_ROW_PREFIX}${augment.id}_chain`;
        effectRows.push({ effect_label: entryLabel, effect_kind: "chain", chain_steps: labels.join(",") });
        effects.forEach((e, i) => effectRows.push({ ...e, effect_label: labels[i] }));
      } else {
        continue;
      }
      reactionRows.push({
        reaction_trigger: augment.rider.trigger,
        reaction_source: "self",
        reaction_requires_weapon_used: true,
        reaction_passive_mode: "on",
        reaction_effect_ref: entryLabel,
        condition_formula: augment.rider.condition_formula ?? "",
        reaction_damage_outcome: augment.rider.reaction_damage_outcome ?? "",
      });
    }
    // ae → embedded managed ActiveEffect
    if (augment.ae) {
      aeDocs.push({
        name: augment.ae.name ?? `${augment.label} (Orbment)`,
        img: augment.ae.icon ?? "icons/svg/upgrade.svg",
        transfer: true,
        disabled: false,
        changes: (augment.ae.changes ?? []).map((c) => ({ key: c.key, mode: c.mode, value: String(c.value) })),
        system: { tags: [ORBMENT_TAG] },
        flags: { [FLAG_NS]: { orbment: true } },
      });
    }
  }
  return { propOverrides, reactionRows, effectRows, aeDocs, summary };
}

// ── Description summary block (fenced, author-safe) ────────────────────────────
function stripDescBlock(html) {
  // Strip the orbment block by its VISIBLE sentinel ("🔮 Orbment"), NOT by HTML
  // comment markers — CSB/ProseMirror strips comments on re-serialization, which
  // orphaned the old block and caused duplicates. The block is always appended
  // LAST, so cut from the FIRST sentinel to end (removes any accumulated dupes),
  // backing up over immediately-preceding wrapper tags (<hr>/<p>/<strong>).
  const s = String(html ?? "");
  const idx = s.indexOf(DESC_SENTINEL);
  if (idx === -1) return s.replace(/\n{3,}/g, "\n\n").trimEnd();
  const before = s.slice(0, idx);
  // Back up over the block's OPENING wrapper run (whitespace, <hr>, and opening
  // p/strong/b/em/span tags — covers both the old <b> and new <strong> block
  // formats). Only opening tags, so we stop at any author close-tag.
  const lead = before.match(/(?:\s|<hr\s*\/?>|<(?:p|strong|b|em|span)\b[^>]*>)*$/i);
  const cut = lead ? idx - lead[0].length : idx;
  return s.slice(0, cut).replace(/\n{3,}/g, "\n\n").trimEnd();
}
function buildDescBlock(item, summary) {
  const count = slotCountOf(item);
  const rows = [];
  for (let i = 0; i < count; i++) {
    const hit = summary.find((s) => s.slotIndex === i);
    rows.push(hit
      ? `<li><b>Slot ${i + 1}:</b> ${hit.label} — <i>${hit.detail}</i></li>`
      : `<li><b>Slot ${i + 1}:</b> <span style="opacity:.6">(empty)</span></li>`);
  }
  // Heading carries the sentinel; no HTML-comment fence (ProseMirror eats those).
  return `<hr><p><strong>${DESC_SENTINEL}</strong></p><ul style="margin:.2em 0">${rows.join("")}</ul>`;
}

// ── Apply the projection to ONE item ──────────────────────────────────────────
async function applyToItem(item, slots, linkGroup) {
  const itemType = itemKindOf(item);

  const installed = slots
    .map((slot, slotIndex) => (slot ? { slotIndex, augment: resolveAugment(slot.id, slot.param) } : null))
    .filter((x) => x && x.augment);

  const proj = buildProjection(installed, itemType);

  // ---- props: restore prior baseProps, then snapshot+override anew ----
  const prevBase = readOrbment(item).baseProps ?? []; // [{key,value}]
  const prevBaseMap = new Map(prevBase.map((e) => [e.key, e.value]));
  const curProps = item.system?.props ?? {};

  // effective = current, with all previously-managed keys restored to intrinsic.
  const effective = new Map();
  const touchedKeys = new Set([...prevBaseMap.keys(), ...proj.propOverrides.keys()]);
  for (const k of touchedKeys) {
    effective.set(k, prevBaseMap.has(k) ? prevBaseMap.get(k) : curProps[k]);
  }
  // snapshot intrinsic then override for each installed prop.
  const newBase = [];
  for (const [k, v] of proj.propOverrides) {
    newBase.push({ key: k, value: effective.get(k) });
    effective.set(k, v);
  }

  // ---- rider tables: keep author rows, replace orbment rows ----
  const curReact = tableToArray(curProps.reaction_config_table).filter((r) => !isOrbmentReactionRow(r));
  const curEff   = tableToArray(curProps.effect_table).filter((r) => !isOrbmentEffectRow(r));
  const newReact = arrayToTable([...curReact, ...proj.reactionRows]);
  const newEff   = arrayToTable([...curEff, ...proj.effectRows]);

  // ---- description summary ----
  const baseDesc = stripDescBlock(curProps.description);
  const newDesc = installed.length ? `${baseDesc}\n${buildDescBlock(item, proj.summary)}` : baseDesc;

  // ---- flags record (arrays only → clean wholesale replace on setFlag) ----
  const record = {
    version: 1,
    slots: slots.slice(0, slotCountOf(item)),
    baseProps: newBase,
    linkGroup,
  };

  // Phase 1: drop the tables so the fresh objects replace (not deep-merge) them.
  const hadReact = curProps.reaction_config_table && typeof curProps.reaction_config_table === "object";
  const hadEff   = curProps.effect_table && typeof curProps.effect_table === "object";
  const phase1 = {};
  if (hadReact) phase1["system.props.-=reaction_config_table"] = null;
  if (hadEff)   phase1["system.props.-=effect_table"] = null;
  // Drop the whole flag record too, so baseProps/slots arrays replace cleanly.
  phase1[`flags.${FLAG_NS}.-=${ORBMENT_FLAG}`] = null;
  if (Object.keys(phase1).length) await item.update(phase1);

  // Phase 2: write props overrides + fresh tables + desc + flag record.
  const phase2 = {
    "system.props.reaction_config_table": newReact,
    "system.props.effect_table": newEff,
    "system.props.description": newDesc,
    [`flags.${FLAG_NS}.${ORBMENT_FLAG}`]: record,
  };
  for (const k of touchedKeys) phase2[`system.props.${k}`] = effective.get(k);
  await item.update(phase2);

  // ---- embedded stat AEs: delete prior orbment-tagged, create fresh ----
  const staleAe = (item.effects?.contents ?? [])
    .filter((fx) => (fx.system?.tags ?? []).includes(ORBMENT_TAG) || fx.flags?.[FLAG_NS]?.orbment)
    .map((fx) => fx.id);
  if (staleAe.length) {
    try { await item.deleteEmbeddedDocuments("ActiveEffect", staleAe); }
    catch (e) { warn(`AE delete failed on ${item.name}`, e); }
  }
  if (proj.aeDocs.length) {
    // Equip-gate: start disabled when the item isn't currently worn, so affinity
    // / condition-immunity AEs (which can't self-gate via an isEquipped formula)
    // don't apply off-body. equipment-swap's AE sync maintains this on swaps.
    const worn = !!item.system?.props?.isEquipped;
    const docs = proj.aeDocs.map((d) => ({ ...d, disabled: !worn }));
    try { await item.createEmbeddedDocuments("ActiveEffect", docs); }
    catch (e) { warn(`AE create failed on ${item.name}`, e); }
  }

  return { itemId: item.id, itemName: item.name, applied: proj.summary.length };
}

// ── Public: recompile an item (and its whole transform link group) ────────────
// `sourceItem` is the item whose slots are authoritative (the one just edited);
// its install state is mirrored to every group member before each is projected.
export async function recompileOrbment(sourceItem) {
  if (!sourceItem?.parent) { warn("recompileOrbment: item has no parent actor"); return { ok: false, members: [] }; }
  const actor = sourceItem.parent;
  const groupIds = resolveLinkGroup(sourceItem);
  const authoritativeSlots = readOrbment(sourceItem).slots;

  const members = [];
  for (const id of groupIds) {
    const it = actor.items.get(id);
    if (!it) continue;
    // Mirror the authoritative install state onto each member (clamped to its
    // own slot count), then project. Members share slots + linkGroup; each keeps
    // its OWN baseProps snapshot (handled inside applyToItem).
    const memberSlots = authoritativeSlots.slice(0, slotCountOf(it));
    try {
      const r = await applyToItem(it, memberSlots, groupIds);
      members.push(r);
    } catch (e) {
      warn(`recompile failed on ${it.name}`, e);
      members.push({ itemId: it.id, itemName: it.name, error: String(e?.message ?? e) });
    }
  }
  log(`recompiled "${sourceItem.name}" → ${members.length} member(s) in link group`, members);
  return { ok: true, members };
}
