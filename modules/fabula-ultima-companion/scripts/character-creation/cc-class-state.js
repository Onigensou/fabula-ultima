/**
 * Character Creation — a level-up state built from the draft.
 *
 * The level-up window renders entirely from the object `getState(actorUuid)`
 * returns. Nothing in its rail, skill rows or facet grid reaches for an Actor
 * directly. That means the same renderers can draw a character who does not
 * exist yet, provided something hands them the same shape.
 *
 * This is that something. `draftState(draft)` returns a getState-shaped object
 * where every actor-derived number is counted out of the draft instead:
 *
 *     getState                          draftState
 *     ────────────────────────────────  ──────────────────────────────────
 *     class row level from class_list   count of draft.classes with that key
 *     skill level from actor items      count of draft.classes with that uuid
 *     facet held from actor items       uuid present in any pick's facetUuids
 *     skill_point prop                  pool minus picks
 *
 * Everything else — names, images, descriptions, maxLevel, facetGrant, the
 * class's free benefits — comes from the same `getRegistry()` the real window
 * reads, so the two cannot describe a class differently.
 *
 * WHY NOT JUST CREATE THE ACTOR FIRST
 * -----------------------------------
 * Because then a half-finished character exists in the world the moment the
 * wizard opens, and a crash or a closed tab leaves it there. Keeping the draft
 * as the only state until Create is what makes rollback a matter of deleting
 * one document that nobody has touched.
 */

import { CC, num } from "./cc-const.js";
import { getRegistry } from "../levelup-system/class-registry.js";
import { LEVELUP } from "../levelup-system/levelup-const.js";
import {
  draftPointPool, draftPointsSpent, draftPointsLeft, draftLevel,
} from "./cc-draft.js";

/** Levels taken in each class, keyed by class key. */
function classLevels(draft) {
  const out = new Map();
  for (const c of draft?.classes ?? []) out.set(c.classKey, (out.get(c.classKey) ?? 0) + 1);
  return out;
}

/** Levels taken in each skill, keyed by skill uuid. */
function skillLevels(draft) {
  const out = new Map();
  for (const c of draft?.classes ?? []) out.set(c.skillUuid, (out.get(c.skillUuid) ?? 0) + 1);
  return out;
}

/** Every facet uuid the draft has claimed. */
function heldFacets(draft) {
  return new Set((draft?.classes ?? []).flatMap((c) => c.facetUuids ?? []));
}

/** The benefit chosen for a class, if its first level has been taken. */
export function benefitFor(draft, classKey) {
  return (draft?.classes ?? []).find((c) => c.classKey === classKey)?.benefit ?? null;
}

/**
 * A getState-shaped view of the draft.
 *
 * @param {object} draft
 * @returns {object} the same shape levelup-api's getState returns
 */
export function draftState(draft) {
  const reg = getRegistry();
  const levels = classLevels(draft);
  const skills = skillLevels(draft);
  const facets = heldFacets(draft);
  const RULE = LEVELUP.RULE;

  const classes = reg.list.map((cls) => {
    const level = levels.get(cls.key) ?? 0;
    return {
      key: cls.key,
      id: cls.id,
      name: cls.name,
      img: cls.img,
      folder: cls.folder,
      // A class whose benefit is fixed reports it from the registry; one the
      // player chose reports their choice, so the header reads the same either
      // way and the choice survives a re-render.
      benefit: cls.benefit ?? benefitFor(draft, cls.key),
      free: cls.free,
      flavor: cls.flavor,
      lore: cls.lore,
      also: cls.also,
      mechanic: cls.mechanic,
      level,
      mastered: level >= RULE.MAX_CLASS_LEVEL,
      taken: level > 0,
      skills: cls.skills.map((s) => {
        const lvl = skills.get(s.uuid) ?? 0;
        return {
          uuid: s.uuid, key: s.key, name: s.name, img: s.img, type: s.type,
          cost: s.cost, description: s.description,
          maxLevel: s.maxLevel,
          level: lvl,
          atMax: lvl >= s.maxLevel,
          facetGrant: cls.facets.length ? s.facetGrant : 0,
        };
      }),
      facets: cls.facets.map((f) => ({
        uuid: f.uuid, key: f.key, name: f.name, img: f.img,
        description: f.description, cost: f.cost,
        held: facets.has(f.uuid),
      })),
    };
  });

  let unmastered = 0;
  for (const [, lvl] of levels) if (lvl > 0 && lvl < RULE.MAX_CLASS_LEVEL) unmastered += 1;

  return {
    ok: true,
    // No Actor exists yet. The renderers only read `actor` for the header,
    // which creation draws itself, so the profile stands in for it.
    actor: {
      uuid: null,
      id: null,
      name: String(draft?.profile?.name ?? "").trim() || "New character",
      img: String(draft?.profile?.img ?? "").trim() || CC.DEFAULT_IMG,
    },
    level: draftLevel(draft),
    classLevelTotal: draftPointsSpent(draft),
    points: {
      stored: draftPointsLeft(draft),
      expected: draftPointsLeft(draft),
      drift: false,                       // the draft is its own ledger
    },
    // The real spend gate guards writes, and creation writes nothing until
    // Create — which re-checks it GM-side. Reporting it open here keeps the
    // rows live; a closed gate is reported by finalize, where it matters.
    gate: { open: true, where: "creation", reason: "", phase: "", mode: "" },
    // Giving a level back costs a Forget me Nut only because the real thing
    // has already been written. Nothing here has, so it is free.
    nuts: { count: Infinity, name: LEVELUP.NUT?.NAME ?? "Forget me Nut", img: LEVELUP.NUT?.IMG ?? "" },
    rules: {
      maxClassLevel: RULE.MAX_CLASS_LEVEL,
      maxCharLevel: RULE.MAX_CHAR_LEVEL,
      maxUnmastered: RULE.MAX_UNMASTERED_CLASSES,
      // Creation-only: below level 10 no class can be mastered, so the
      // 2-3 starting class rule applies. Read by the step, not by levelup.
      maxStartingClasses: CC.RULE.MAX_STARTING_CLASSES,
      minStartingClasses: CC.RULE.MIN_STARTING_CLASSES,
    },
    unmastered,
    // Heroic Skills need level 10 in a class and are not part of creation.
    heroic: { slots: 0, used: 0, available: [], picked: [] },
    classes,
    pool: draftPointPool(draft),
  };
}

/** Classes the draft has taken, in first-picked order, as state records. */
export function takenClasses(state, draft) {
  const order = [];
  for (const c of draft?.classes ?? []) if (!order.includes(c.classKey)) order.push(c.classKey);
  return order.map((k) => state.classes.find((c) => c.key === k)).filter(Boolean);
}

export { num };
