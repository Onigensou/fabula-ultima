// Party Menu — "what would this gear change?" for the Equip view (data layer).
//
// FF's equip screen shows DEF 12 → 14 before you commit. Here the numbers come
// from the game itself rather than from the item's own fields: the swap is
// PLANNED by the same function that commits it (equipment-swap.js
// planEquipmentSwap, plus set-bonus.js planSetBonuses), the plan is applied to
// an UNSAVED copy of the character built from its source data, and CSB prepares
// that copy exactly as it prepares the real one — formulas, gear Active Effects
// (most gear works through a transfer AE, not a field), set bonuses. The real
// character is never touched: the copy is a new document from `toObject()`,
// never `deepClone(actor.system)`, which in CSB returns the live object.
//
// Stats compared: DEF, M.DEF, INIT always; then anything else the swap changes
// among max HP/MP/IP, attribute dice, affinities, status immunities and the
// check / damage modifiers. Weapons also compare their own accuracy and damage.

import { planEquipmentSwap } from "../battle-director/equipment-swap.js";
import { planSetBonuses, getEquipmentSets } from "../battle-director/set-bonus.js";
import { equipSelection, equipSlotsOf, itemSummary, itemType } from "./party-menu-inventory.js";
import { keyLabel } from "./party-menu-effects.js";

const NS = "fabula-ultima-companion";
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const str = (v) => String(v ?? "").trim();

// Better = higher, unless listed. Affinities and status grades rank on their own scale.
const GRADE_RANK = { VU: -1, NA: 0, "": 0, RS: 1, IM: 2, AB: 3 };
const GRADE_WORD = { VU: "VU", NA: "—", "": "—", RS: "RS", IM: "IM", AB: "AB" };
const LOWER_IS_BETTER = /^damage_taken_increased_/;
const ATTRS = ["dex", "ins", "mig", "wlp"];
// Keys the swap itself writes as display text (slot names, details) are not stats.
const EXTRA = /^(max_hp|max_mp|max_ip|(dex|ins|mig|wlp)_current|affinity_\d|condition_\w+|check_mod_(?!init$)\w+|extra_damage_mod_\w+|damage_receiving_mod_\w+|damage_taken_increased_\w+|ip_reduction_value|item_restore_mod|enmity)$/;

/** CSB-prepared props of an unsaved copy of `actor` with `sel` worn. */
function simulate(actor, sel) {
  const plan = planEquipmentSwap(actor, sel, { allowArmor: true });
  const src = actor.toObject();
  for (const [path, val] of Object.entries(plan.actorUpdates)) foundry.utils.setProperty(src, path, val);
  const byId = new Map((src.items ?? []).map((i) => [i._id, i]));
  for (const u of plan.itemUpdates) {
    const it = byId.get(u._id);
    if (it) for (const [k, v] of Object.entries(u)) if (k !== "_id") foundry.utils.setProperty(it, k, v);
  }
  for (const [itemId, fx] of plan.effectUpdates) {
    const it = byId.get(itemId);
    for (const f of fx) { const e = it?.effects?.find((x) => x._id === f._id); if (e) e.disabled = f.disabled; }
  }
  let copy = new Actor.implementation(src);
  // Set bonuses follow the pieces now worn: the grants (an AE, or a skill that may
  // carry its own AE) that lapse are dropped and the new ones added, then the copy
  // is prepared again.
  const sb = planSetBonuses(copy);
  if (sb.aeDelete.length || sb.aeCreate.length || sb.skillDelete.length || sb.skillCreate.length) {
    const dropAe = new Set(sb.aeDelete), dropSkill = new Set(sb.skillDelete);
    const withId = (o) => ({ ...foundry.utils.deepClone(o), _id: foundry.utils.randomID() });
    src.effects = (src.effects ?? []).filter((e) => !dropAe.has(e._id)).concat(sb.aeCreate.map(withId));
    src.items = (src.items ?? []).filter((i) => !dropSkill.has(i._id)).concat(sb.skillCreate.map(withId));
    copy = new Actor.implementation(src);
  }
  const labels = setBonusLabels();
  const name = (o, tagKey) => labels.get(o?.flags?.[NS]?.[tagKey]) || o?.name;
  const gained = [...sb.aeCreate.map((o) => name(o, "setBonus")), ...sb.skillCreate.map((o) => name(o, "setBonusSkill"))];
  const lost = [
    ...sb.aeDelete.map((id) => name(actor.effects.get(id), "setBonus")),
    ...sb.skillDelete.map((id) => name(actor.items.get(id), "setBonusSkill")),
  ];
  // A grant whose payload changed is planned as delete + recreate: that is a refresh, not a change.
  const g = gained.filter(Boolean), l = lost.filter(Boolean);
  return { props: copy.system.props, plan, setBonus: { gained: g.filter((x) => !l.includes(x)), lost: l.filter((x) => !g.includes(x)) } };
}

// "<set>:<pieces>:ae|skill" → the row's authored label ("Always Wet"), for the grant notes.
function setBonusLabels() {
  const out = new Map();
  for (const { setName, rows } of getEquipmentSets().values()) {
    for (const r of rows) {
      const label = r.label ? `${setName} ${r.pieces}pc: ${r.label}` : "";
      out.set(`${setName}:${r.pieces}:ae`, label);
      out.set(`${setName}:${r.pieces}:skill`, label);
    }
  }
  return out;
}

function initOf(p) { return num(p.check_mod_init) + num(p.init_penalty); }

function row(key, label, before, after, kind = "num") {
  if (kind === "grade") {
    const a = str(before).toUpperCase() || "NA", b = str(after).toUpperCase() || "NA";
    const d = (GRADE_RANK[b] ?? 0) - (GRADE_RANK[a] ?? 0);
    return { key, label, before: GRADE_WORD[a] ?? a, after: GRADE_WORD[b] ?? b, changed: a !== b, better: d > 0, worse: d < 0, grade: true };
  }
  if (kind === "die") {
    const a = num(before), b = num(after);
    return { key, label, before: `d${a}`, after: `d${b}`, changed: a !== b, better: b > a, worse: b < a };
  }
  const a = num(before), b = num(after);
  const up = LOWER_IS_BETTER.test(key) ? b < a : b > a;
  const signed = key === "init" || /^(check_mod|extra_damage_mod|damage_receiving_mod|damage_taken_increased)_/.test(key);
  const f = (x) => (signed && x > 0 ? `+${x}` : String(x));
  return { key, label, before: f(a), after: f(b), changed: a !== b, better: a !== b && up, worse: a !== b && !up };
}

function statRows(p0, p1) {
  const rows = [
    row("defense", "DEF", p0.defense, p1.defense),
    row("magic_defense", "M.DEF", p0.magic_defense, p1.magic_defense),
    row("init", "INIT", initOf(p0), initOf(p1)),
  ];
  const keys = new Set([...Object.keys(p0), ...Object.keys(p1)].filter((k) => EXTRA.test(k)));
  const extra = [];
  for (const k of keys) {
    if (str(p0[k]) === str(p1[k])) continue;
    const at = /^(dex|ins|mig|wlp)_current$/.exec(k);
    if (at) extra.push(row(k, at[1].toUpperCase(), p0[k], p1[k], "die"));
    else if (/^(affinity_\d|condition_\w+)$/.test(k)) extra.push(row(k, keyLabel(k).replace(/ affinity$/, ""), p0[k], p1[k], "grade"));
    else extra.push(row(k, keyLabel(k), p0[k], p1[k]));
  }
  const order = (r) => (/^max_/.test(r.key) ? 0 : ATTRS.includes(r.key.slice(0, 3)) ? 1 : r.grade ? 3 : 2);
  extra.sort((a, b) => order(a) - order(b) || a.label.localeCompare(b.label));
  return [...rows, ...extra];
}

/** Accuracy / damage text of the weapon in a hand slot (null when not a weapon). */
function weaponLine(item) {
  if (!item || itemType(item) !== "weapon") return null;
  const f = Object.fromEntries(itemSummary(item).facts);
  return { accuracy: f.Accuracy ?? "", damage: f.Damage ?? "" };
}

/** The skills a piece of gear carries (CSB container model: `_skill` items inside it). */
function carriedSkills(actor, item) {
  if (!item) return [];
  return actor.items.filter((i) => str(i.system?.container) === item.id).map((i) => i.name);
}

// Cache per (actor, slot, item). Building the copy costs a few hundred ms on a
// character with ~100 items, so results are kept until THAT character (or
// something it carries) changes.
const _cache = new Map();
const dropFor = (actor) => { if (!actor?.id) return; for (const k of _cache.keys()) if (k.startsWith(`${actor.id}|`)) _cache.delete(k); };
const ownerOf = (doc) => (doc?.parent?.documentName === "Item" ? doc.parent.parent : doc?.parent);
Hooks.on("updateActor", (a) => dropFor(a));
for (const h of ["updateItem", "createItem", "deleteItem", "createActiveEffect", "updateActiveEffect", "deleteActiveEffect"]) {
  Hooks.on(h, (doc) => { const o = doc?.documentName === "ActiveEffect" ? ownerOf(doc) : doc?.parent; if (o?.documentName === "Actor") dropFor(o); else _cache.clear(); });
}
// Equipment Sets are world items: editing one can change any preview.
Hooks.on("updateItem", (it) => { if (!it?.parent) _cache.clear(); });

/** The cached preview, or null when it has not been computed yet (never computes). */
export function peekPreview(actor, slotKey, itemId) {
  return actor ? _cache.get(`${actor.id}|${slotKey}|${itemId ?? ""}`) ?? null : null;
}

/**
 * What putting `itemId` (null = empty the slot) in `slotKey` would change.
 * → { ok, rows:[{label,before,after,changed,better,worse}], weapon:{before,after}|null,
 *     also:[text], gains:[skill], loses:[skill], setGained, setLost, net:"up"|"down"|"mixed"|"same" }
 */
export function previewEquip(actor, slotKey, itemId) {
  if (!actor) return { ok: false, reason: "no-actor" };
  const key = `${actor.id}|${slotKey}|${itemId ?? ""}`;
  const hit = _cache.get(key);
  if (hit) return hit;
  const r = equipSelection(actor, slotKey, itemId);
  if (!r.ok) { const out = { ok: false, reason: r.reason, detail: r.detail }; _cache.set(key, out); return out; }
  let sim;
  try { sim = simulate(actor, r.sel); }
  catch (e) {
    console.warn("[PartyMenu] equip preview failed", e);
    const out = { ok: false, reason: "preview-failed" };
    _cache.set(key, out);
    return out;
  }
  const rows = statRows(actor.system.props, sim.props);
  const slot = equipSlotsOf(actor).find((s) => s.key === slotKey);
  const next = itemId ? actor.items.get(itemId) : null;
  const hand = slotKey === "main" || slotKey === "off";
  const weapon = hand && (weaponLine(slot?.item) || weaponLine(next))
    ? { before: weaponLine(slot?.item), after: weaponLine(next) } : null;
  // Other slots the swap empties or fills (a two-handed weapon frees the off hand,
  // a piece worn elsewhere moves).
  const also = sim.plan.changes.filter((c) => c.slot !== slot?.label).map((c) => `${c.slot}: ${c.fromName} → ${c.toName}`);
  const before = new Set(carriedSkills(actor, slot?.item));
  const after = new Set(carriedSkills(actor, next));
  const changed = rows.filter((x) => x.changed);
  const up = changed.some((x) => x.better), down = changed.some((x) => x.worse);
  const out = {
    ok: true, rows, weapon, also,
    gains: [...after].filter((n) => !before.has(n)), loses: [...before].filter((n) => !after.has(n)),
    setGained: sim.setBonus.gained, setLost: sim.setBonus.lost,
    net: up && down ? "mixed" : up ? "up" : down ? "down" : "same",
  };
  _cache.set(key, out);
  return out;
}

// For tests: the before/after stat rows of any two prop sets (no document involved).
export const __test = { statRows };
