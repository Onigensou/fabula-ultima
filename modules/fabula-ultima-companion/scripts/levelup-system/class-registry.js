/**
 * Playable class registry
 * ---------------------------------------------------------------------------
 * Classes are Actors on the `_FabU Classes Template`, filed under
 * `Classes/Classic Classes` and `Classes/Custom Classes`. `Prototype Classes`
 * is homebrew under test and is never playable.
 *
 * A class actor holds its skills as embedded Items, split by prop rather than
 * by container membership — the three itemContainers on the class sheet all
 * filter the same item template:
 *
 *   skill   → not isHeroic, not isFacet, skill_type in {Active, Passive, Other}
 *   heroic  → isHeroic
 *   facet   → isFacet   (spells learned via a "learn one <Class> spell" skill)
 *
 * IDENTITY
 * --------
 * Everything is keyed by `idKey(name)` — lowercase alphanumerics — not by the
 * raw name and not by actor id. `class_list.class_name` on a PC is free text
 * typed by a human and has already drifted ("Dark Blade" vs the actor
 * "Darkblade"); actor ids would be stable but are absent from `class_list`
 * entirely, which is the table the whole system reads.
 */

import { LEVELUP, idKey, num, warn } from "./levelup-const.js";

let _cache = null;
let _cacheBootId = null;

/** Actor ids of the folders holding playable classes. */
function playableFolderIds() {
  const root = game.folders?.find(
    (f) => f.type === "Actor" && f.name === LEVELUP.CLASS_ROOT_FOLDER && !f.folder
  );
  const ids = new Set();
  for (const f of game.folders ?? []) {
    if (f.type !== "Actor") continue;
    if (!LEVELUP.PLAYABLE_FOLDERS.includes(f.name)) continue;
    // Only count a folder that actually sits under Classes/, so an unrelated
    // folder that happens to share the name cannot smuggle classes in.
    if (root && f.folder?.id !== root.id) continue;
    ids.add(f.id);
  }
  return ids;
}

const isHeroic = (i) => i.system?.props?.isHeroic === true;
const isFacet = (i) => i.system?.props?.isFacet === true;

const stripHtml = (h) => String(h ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

const WORD_COUNT = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5 };

/**
 * How many Facets a level in this skill awards, or 0 if none.
 *
 * The marker is the authored "(see Facet)" pointer, and the count comes from
 * the sentence around it — "learn a dance" and "learn one Elementalist spell"
 * are 1, "you learn two symbols" is 2. Anything vaguer ("you progressively
 * learn…" on Set Trap) falls back to 1, which is both the common case and the
 * safe direction: awarding too few is visible and correctable, awarding too
 * many silently inflates a character.
 *
 * Read live from the description, so fixing the wording on a skill changes the
 * behaviour with no migration — the same property that made the Powerful Shot
 * typo a one-line fix.
 */
export function facetGrantCount(description) {
  const text = stripHtml(description);
  if (!/see\s+facet/i.test(text)) return 0;
  const m = text.match(/\blearns?\s+(?:up\s+to\s+)?(a|an|one|two|three|four|five|\d+)\b/i);
  if (!m) return 1;
  const raw = m[1].toLowerCase();
  const n = WORD_COUNT[raw] ?? Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function readSkill(item) {
  const p = item.system?.props ?? {};
  return {
    facetGrant: facetGrantCount(p.description),
    uuid: item.uuid,
    id: item.id,
    key: idKey(item.name),
    name: item.name,
    img: item.img,
    type: p.skill_type ?? "",
    maxLevel: Math.max(1, num(p.max_level, 1)),
    cost: p.cost ?? "",
    description: p.description ?? "",
    requirement: p.heroic_requirement ?? "",
    isHeroic: p.isHeroic === true,
    isFacet: p.isFacet === true,
  };
}

function readClass(actor, folderName) {
  const p = actor.system?.props ?? {};
  const items = actor.items?.contents ?? [];
  return {
    id: actor.id,
    uuid: actor.uuid,
    key: idKey(actor.name),
    name: actor.name,
    img: actor.img,
    folder: folderName,
    lore: p.class_lore ?? "",
    flavor: p.flavor_text ?? "",
    also: p.also_text ?? "",
    // Only 21 of 42 classes have one; the browser hides the tab when empty.
    mechanic: p.classMechanic_text ?? "",
    // null = the player chooses at each level.
    benefit: LEVELUP.BENEFIT[String(p.benefit_dropdown ?? "")] ?? null,
    benefitRaw: p.benefit_dropdown ?? "",
    free: {
      ritual: p.ritual_performable === true,
      project: p.project_performable === true,
      martialMelee: p.martialMelee_equippable === true,
      martialRanged: p.martialRanged_equippable === true,
      martialArmor: p.martialArmor_equippable === true,
      martialShield: p.martialShield_equippable === true,
    },
    skills: items.filter((i) => !isHeroic(i) && !isFacet(i)).map(readSkill),
    heroics: items.filter(isHeroic).map(readSkill),
    facets: items.filter(isFacet).map(readSkill),
  };
}

/**
 * Every playable class, keyed by `idKey(name)`.
 *
 * Duplicate names are real in this world — there are two actors called
 * "Weaponmaster". Rather than silently picking one, the richer actor (more
 * skills + heroics) wins and the loser is recorded on `duplicates` so a GM can
 * be told which one is being ignored.
 *
 * @returns {{ byKey: Map<string, object>, list: object[], duplicates: object[] }}
 */
export function buildRegistry() {
  const folderIds = playableFolderIds();
  const byKey = new Map();
  const duplicates = [];

  const folderNameOf = (a) => game.folders?.get(a.folder?.id)?.name ?? "";

  for (const actor of game.actors?.contents ?? []) {
    if (!actor.folder || !folderIds.has(actor.folder.id)) continue;
    const entry = readClass(actor, folderNameOf(actor));
    const prev = byKey.get(entry.key);
    if (!prev) {
      byKey.set(entry.key, entry);
      continue;
    }
    const weight = (c) => c.skills.length + c.heroics.length + c.facets.length;
    const [winner, loser] = weight(entry) > weight(prev) ? [entry, prev] : [prev, entry];
    byKey.set(entry.key, winner);
    duplicates.push({ key: entry.key, name: entry.name, kept: winner.id, ignored: loser.id });
  }

  const list = [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
  if (duplicates.length) {
    warn(
      `duplicate class actors — keeping the richer of each: ` +
        duplicates.map((d) => `${d.name} (kept ${d.kept}, ignored ${d.ignored})`).join("; ")
    );
  }
  return { byKey, list, duplicates };
}

/**
 * Cached registry. Invalidated per boot and by `invalidate()`; class actors are
 * authored rarely, and rebuilding walks every actor in the world.
 */
export function getRegistry() {
  const boot = game.data?.userId ? game.world?.id : null;
  if (_cache && _cacheBootId === boot) return _cache;
  _cache = buildRegistry();
  _cacheBootId = boot;
  return _cache;
}

export function invalidate() {
  _cache = null;
}

/** Resolve a class by free-text name, key, or actor id. */
export function resolveClass(nameOrId) {
  const reg = getRegistry();
  const raw = String(nameOrId ?? "").trim();
  if (!raw) return null;
  return (
    reg.byKey.get(idKey(raw)) ??
    reg.list.find((c) => c.id === raw) ??
    reg.list.find((c) => c.uuid === raw) ??
    null
  );
}

/**
 * The actor's classes as `{ class, row, rowKey, level, benefit, mastered }`,
 * newest-first order preserved from `class_list`. Rows whose name matches no
 * playable class are returned with `class: null` rather than dropped — a PC
 * carrying a retired or Prototype class must still count toward their level
 * total, or the Skill Point arithmetic silently disagrees with the sheet.
 */
export function readActorClasses(actor) {
  const table = actor?.system?.props?.[LEVELUP.PROP.CLASS_LIST] ?? {};
  const out = [];
  for (const [rowKey, row] of Object.entries(table)) {
    if (!row || row.$deleted) continue;
    const level = num(row.level, 0);
    out.push({
      rowKey,
      row,
      name: row.class_name ?? "",
      key: idKey(row.class_name),
      class: resolveClass(row.class_name),
      level,
      benefit: row.benefit ?? "",
      mastered: level >= LEVELUP.RULE.MAX_CLASS_LEVEL,
    });
  }
  return out;
}

/** Σ of every class level on the actor, including unresolvable rows. */
export const sumClassLevels = (actor) =>
  readActorClasses(actor).reduce((s, c) => s + c.level, 0);

/** Skill Points not yet spent. */
export function unspentPoints(actor) {
  return num(actor?.system?.props?.[LEVELUP.PROP.SKILL_POINT], 0);
}

/**
 * What `skill_point` should be if nothing has drifted. Compared against the
 * stored value when the level-up window opens — see docs.
 */
export function expectedPoints(actor) {
  const p = actor?.system?.props ?? {};
  return Math.max(
    0,
    num(p[LEVELUP.PROP.LEVEL], 0) +
      num(p[LEVELUP.PROP.SKILL_POINT_BONUS], 0) -
      sumClassLevels(actor)
  );
}
