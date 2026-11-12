/**
 * Character Level-Up System — per-level choices ("each time you take this Skill, choose …")
 * ---------------------------------------------------------------------------
 * Some skills ask the player for a choice every time they gain a level, and the
 * answer is not a separate item (that is what Facets are for) but a switch on
 * the skill itself. Bane Oils is the first: "Each time you take this Skill,
 * choose a creature Species." The skill already carries one ActiveEffect per
 * species ("Bane Oils: Beast", "Bane Oils: Monster", …), all disabled; enabling
 * one is what makes that species' oil appear in the battle menu (its
 * availability formula and menu rows read the flag the effect sets).
 *
 * So a choice here is: one of the skill's OWN ActiveEffects whose name starts
 * with a declared prefix. Picked = enabled. Count of enabled = picks held.
 * Nothing is stored anywhere else, so the sheet, the stash and a save slot all
 * carry the answer for free.
 *
 * The declaration is code-side, keyed by the skill's idKey, so no world data has
 * to change. Adding the next "choose X each level" skill = one entry below,
 * provided the skill carries the prefixed effects.
 */

import { idKey } from "./levelup-const.js";

export const LEVEL_CHOICES = Object.freeze({
  baneoils: Object.freeze({ effectPrefix: "Bane Oils: ", label: "Species", noun: "species", perLevel: 1 }),
});

/** The choice declaration for a skill name, or null. */
export const choiceSpecFor = (name) => LEVEL_CHOICES[idKey(name)] ?? null;

/** A choice's stable key: the effect name past the prefix, as an idKey ("beast"). */
export const choiceKeyOf = (spec, effectName) =>
  idKey(String(effectName ?? "").slice(spec.effectPrefix.length));

/** An item's effects as plain-ish records, for a live document OR item.toObject() data. */
function effectsOf(item) {
  const raw = item?.effects;
  const list = Array.isArray(raw) ? raw : (raw?.contents ?? (raw ? [...raw] : []));
  return list.map((e) => ({ id: e._id ?? e.id ?? null, name: String(e.name ?? ""), img: e.img ?? e.icon ?? "", disabled: e.disabled === true }));
}

/**
 * Read a skill's choices.
 * @param {object} item  a live Item or item data (toObject())
 * @param {number} [level] the skill level to measure against (default: the item's own)
 * @returns {null | { spec, options: [{key,label,img,effectId,held}], held, level, owed }}
 *   owed = picks still to make at this level (never negative); picks beyond the
 *   level (a GM hand-enabled extra) are tolerated, not reported as owed.
 */
export function readChoices(item, level) {
  const spec = choiceSpecFor(item?.name);
  if (!spec) return null;
  const options = effectsOf(item)
    .filter((e) => e.name.startsWith(spec.effectPrefix))
    .map((e) => ({
      key: choiceKeyOf(spec, e.name),
      label: e.name.slice(spec.effectPrefix.length).trim(),
      img: e.img,
      effectId: e.id,
      held: !e.disabled,
    }));
  if (!options.length) return null;
  const lvl = Number.isFinite(level) ? level : Number(item?.system?.props?.level ?? 0) || 0;
  const held = options.filter((o) => o.held).length;
  return { spec, options, held, level: lvl, owed: Math.max(0, lvl * spec.perLevel - held) };
}

/**
 * The window's view of a skill's per-level choice (getState's `skill.choice`), or null.
 * `heldKeys` overrides what counts as held — Character Creation has no actor
 * copy yet, so its picks live on the draft rows and the item read is the
 * class copy (everything disabled).
 * @param {object} item  a live Item or item data
 * @param {number} level the skill level to measure against
 * @param {Iterable<string>|null} [heldKeys]
 */
export function choiceViewOf(item, level, heldKeys = null) {
  const c = item ? readChoices(item, level) : null;
  if (!c) return null;
  const override = heldKeys ? new Set(heldKeys) : null;
  const options = c.options.map((o) => ({ key: o.key, label: o.label, img: o.img, held: override ? override.has(o.key) : o.held }));
  const held = options.filter((o) => o.held).length;
  return {
    label: c.spec.label, noun: c.spec.noun, perLevel: c.spec.perLevel,
    held, owed: Math.max(0, c.level * c.spec.perLevel - held),
    options,
  };
}

/**
 * Validate a set of keys to switch ON for a skill reaching `newLevel`.
 * Fewer than owed is allowed (the catch-up button settles the rest); more is not.
 * @returns {{ok:true, picks:object[]} | {ok:false, reason:string, need?:number}}
 */
export function checkPicks(choices, keys, newLevel) {
  const want = [...new Set((Array.isArray(keys) ? keys : []).map(String))];
  if (!choices) return want.length ? { ok: false, reason: "choice_not_offered" } : { ok: true, picks: [] };
  const need = Math.max(0, newLevel * choices.spec.perLevel - choices.held);
  if (want.length > need) return { ok: false, reason: "choice_count", need };
  const picks = [];
  for (const k of want) {
    const o = choices.options.find((x) => x.key === k);
    if (!o) return { ok: false, reason: "choice_unknown", key: k };
    if (o.held) return { ok: false, reason: "choice_already_held", key: k };
    picks.push(o);
  }
  return { ok: true, picks };
}

/**
 * Validate the keys to switch OFF when a skill drops to `newLevel`.
 * Must be exactly what the lower level can no longer hold, so a refund cannot
 * keep a pick the level paid for (the same rule as Facets).
 */
export function checkGiveBack(choices, keys, newLevel) {
  const want = [...new Set((Array.isArray(keys) ? keys : []).map(String))];
  if (!choices) return want.length ? { ok: false, reason: "choice_not_offered" } : { ok: true, picks: [] };
  const need = Math.max(0, choices.held - Math.max(0, newLevel) * choices.spec.perLevel);
  if (want.length !== need) return { ok: false, reason: "choice_count", need };
  const picks = [];
  for (const k of want) {
    const o = choices.options.find((x) => x.key === k);
    if (!o) return { ok: false, reason: "choice_unknown", key: k };
    if (!o.held) return { ok: false, reason: "choice_not_held", key: k };
    picks.push(o);
  }
  return { ok: true, picks };
}

/** Switch the given options' effects on (or off) on a live embedded Item. */
export async function setPicks(item, picks, enabled) {
  if (!item || !picks.length) return;
  // Re-read by name: on a first take the item was just created from data, so
  // the ids the picks were validated against belong to the SOURCE copy.
  const spec = choiceSpecFor(item.name);
  const live = effectsOf(item);
  const updates = [];
  for (const p of picks) {
    const e = live.find((x) => x.name.startsWith(spec.effectPrefix) && choiceKeyOf(spec, x.name) === p.key);
    if (e?.id) updates.push({ _id: e.id, disabled: !enabled });
  }
  if (updates.length) await item.updateEmbeddedDocuments("ActiveEffect", updates);
}
