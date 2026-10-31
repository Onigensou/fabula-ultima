/**
 * Heroic Skill requirement evaluation
 * ---------------------------------------------------------------------------
 * Takes the clauses from requirement-parser and answers, for one actor:
 * is this Heroic Skill legal to take, and if not, which clause failed and why.
 *
 * Every clause carries its own human sentence so the UI can show *what is
 * missing* rather than a bare "requirements not met" — the player should be
 * able to read "Master 1 of: Ace of Cards, Arcanist" and know what to do.
 *
 * FAIL-CLOSED ON UNPARSEABLE
 * --------------------------
 * If the parser left prose unclaimed, `evaluate` returns `evaluable: false`.
 * Callers must NOT treat that as a pass: a requirement that half-parses would
 * otherwise become a *weaker* gate than the author wrote. The window shows the
 * original prose and asks the GM to adjudicate instead.
 */

import { LEVELUP, idKey, num } from "./levelup-const.js";
import { readActorClasses, resolveClass, getRegistry, readSkill } from "./class-registry.js";
import { resolveRequirement } from "./requirement-parser.js";

/** A skill equipment grants: a contained sub-item, never a pick. See heroicSlots. */
export const isContained = (item) =>
  !!(item?.system?.props?.container ?? item?.system?.container ?? null);

/** Copies of skills this actor gave back, keyed by idKey(name). */
export const readStash = (actor) =>
  actor?.flags?.[LEVELUP.MODULE_ID]?.[LEVELUP.STASH_FLAG] ?? {};

/** The `uuid` of a Heroic only the actor's stash can offer. */
export const stashUuid = (key) => `stash:${key}`;

/**
 * Every skill-shaped item the actor holds, keyed by idKey(name).
 * Spells and Skills are the same item template, so one index serves both
 * `hasSkill` (which covers "…the Drain Spirit and Drain Vigor spells") and
 * `skillLevel`.
 */
export function indexActorSkills(actor) {
  const byKey = new Map();
  for (const item of actor?.items?.contents ?? []) {
    const p = item.system?.props ?? {};
    // Anything with a skill level is a candidate; equipment has none.
    const key = idKey(item.name);
    if (!key) continue;
    const level = Math.max(1, num(p.level, 1));
    const prev = byKey.get(key);
    // Duplicates happen (a granted copy plus the original) — keep the highest.
    if (!prev || level > prev.level) {
      byKey.set(key, { item, level, isHeroic: p.isHeroic === true, isFacet: p.isFacet === true });
    }
  }
  return byKey;
}

const masteredKeys = (actor) =>
  new Set(
    readActorClasses(actor)
      .filter((c) => c.mastered)
      .map((c) => (c.class ? c.class.key : c.key))
  );

function describe(clause) {
  switch (clause.kind) {
    case "masteredAny": {
      const names = clause.classes.join(", ");
      return clause.min > 1
        ? `Master ${clause.min} of: ${names}`
        : `Master ${clause.classes.length > 1 ? "one of: " : ""}${names}`;
    }
    case "charLevel":
      return `Character level ${clause.min}+`;
    case "skillLevel":
      return `${clause.skill} at level ${clause.min}+`;
    case "hasSkill":
      return `Acquire ${clause.skill}`;
    case "allSkillsOf":
      return `Learn every ${clause.className} skill`;
    default:
      return "Unknown requirement";
  }
}

function checkClause(clause, ctx) {
  switch (clause.kind) {
    case "masteredAny": {
      const have = clause.classes.filter((n) => ctx.mastered.has(idKey(n)));
      return { met: have.length >= clause.min, have: have.length, need: clause.min };
    }
    case "charLevel":
      return { met: ctx.level >= clause.min, have: ctx.level, need: clause.min };
    case "skillLevel": {
      const hit = ctx.skills.get(idKey(clause.skill));
      return { met: !!hit && hit.level >= clause.min, have: hit?.level ?? 0, need: clause.min };
    }
    case "hasSkill":
      return { met: ctx.skills.has(idKey(clause.skill)), have: 0, need: 1 };
    case "allSkillsOf": {
      const cls = resolveClass(clause.className);
      if (!cls) return { met: false, have: 0, need: 0, note: "class not found" };
      const missing = cls.skills.filter((s) => !ctx.skills.has(s.key));
      return {
        met: missing.length === 0,
        have: cls.skills.length - missing.length,
        need: cls.skills.length,
        missing: missing.map((s) => s.name),
      };
    }
    default:
      return { met: false, have: 0, need: 0, note: "unknown clause" };
  }
}

/**
 * @param {Actor} actor
 * @param {object} skill  a registry skill entry (needs `.requirement`)
 * @returns {{ evaluable:boolean, met:boolean, prose:string, clauses:object[] }}
 */
export function evaluate(actor, skill) {
  const parsed = resolveRequirement(skill?.requirement ?? "");

  if (parsed.empty) {
    return { evaluable: true, met: true, prose: "", clauses: [] };
  }
  if (parsed.unparsed.length || !parsed.all.length) {
    return { evaluable: false, met: false, prose: parsed.source, clauses: [] };
  }

  const ctx = {
    mastered: masteredKeys(actor),
    skills: indexActorSkills(actor),
    level: num(actor?.system?.props?.[LEVELUP.PROP.LEVEL], 0),
  };

  const clauses = parsed.all.map((c) => {
    const r = checkClause(c, ctx);
    return { ...c, ...r, label: describe(c) };
  });

  return {
    evaluable: true,
    met: clauses.every((c) => c.met),
    prose: parsed.source,
    clauses,
  };
}

/**
 * Heroic Skills the actor could take right now.
 *
 * Mastering a class earns a pick, but it does NOT restrict what may be picked:
 * the rules grant "one Heroic Skill of your choice" (core rulebook p. 228), and
 * the skill's own requirements are the only gate. A character who masters
 * Illusionist — which has no heroics authored in this world — can still take an
 * Arcanist heroic, provided they meet its requirements. So the candidate pool
 * is EVERY heroic on every playable class, not the mastered classes' own.
 *
 * Skills already held are excluded, and the pool is deduplicated by skill key:
 * the same heroic is authored as a separate item copy on each class offering it
 * ("Duel Master" lives on both Rogue and Sharpshooter). The surviving entry
 * records every class it came from, which is what the UI shows.
 *
 * UNAUTHORED REQUIREMENTS FAIL SAFE. Fifteen heroics carry no requirement text
 * at all. Reading that as "no requirement" would make them freely takeable by
 * anyone with a slot, which is certainly not intended — every Heroic Skill in
 * the book states a requirement, so a blank one is missing data, not permission.
 * Those fall back to the old rule: the class offering it must be mastered.
 *
 * Each entry carries `relevance` so the UI can rank a 140-entry pool:
 *   "met"     — takeable now
 *   "close"   — blocked, but from a class the character already has levels in
 *   "distant" — blocked, from a class they have never taken
 */
export function availableHeroics(actor) {
  const held = indexActorSkills(actor);
  const mine = readActorClasses(actor);
  const masteredKeySet = new Set(mine.filter((c) => c.mastered).map((c) => (c.class ? c.class.key : c.key)));
  const ownedKeySet = new Set(mine.map((c) => (c.class ? c.class.key : c.key)));

  const byKey = new Map();
  for (const cls of getRegistry().list) {
    for (const h of cls.heroics) {
      if (held.has(h.key)) continue;
      const existing = byKey.get(h.key);
      if (existing) {
        if (!existing.from.some((f) => f.id === cls.id)) existing.from.push(cls);
        existing._offeredByMastered ||= masteredKeySet.has(cls.key);
        existing._offeredByOwned ||= ownedKeySet.has(cls.key);
        continue;
      }
      const ev = evaluate(actor, h);
      byKey.set(h.key, {
        skill: h,
        from: [cls],
        ...ev,
        _blank: ev.evaluable && !ev.clauses.length,
        _offeredByMastered: masteredKeySet.has(cls.key),
        _offeredByOwned: ownedKeySet.has(cls.key),
      });
    }
  }

  // A Heroic the character gave back stays on offer even when no class lists it
  // (Prophetic Defender, on Hina), or unlearning it would destroy it for good.
  // Its own requirement text still applies. A blank one passes: the fallback
  // below needs an offering class, and this was already earned once.
  for (const [key, data] of Object.entries(readStash(actor))) {
    if (data?.system?.props?.isHeroic !== true || held.has(key) || byKey.has(key)) continue;
    const skill = { ...readSkill(data), uuid: stashUuid(key), key };
    byKey.set(key, {
      skill,
      from: [],
      ...evaluate(actor, skill),
      _blank: false,
      _offeredByMastered: false,
      _offeredByOwned: true,
    });
  }

  const out = [];
  for (const e of byKey.values()) {
    // Blank requirement → fall back to "must have mastered the offering class".
    if (e._blank && !e._offeredByMastered) {
      e.met = false;
      e.clauses = [{ kind: "masteredAny", met: false, label: `Master ${e.from.map((f) => f.name).join(" or ")}` }];
    }
    e.relevance = e.met ? "met" : e._offeredByOwned ? "close" : "distant";
    delete e._blank; delete e._offeredByMastered; delete e._offeredByOwned;
    out.push(e);
  }

  const rank = { met: 0, close: 1, distant: 2 };
  return out.sort((a, b) =>
    (rank[a.relevance] - rank[b.relevance]) || a.skill.name.localeCompare(b.skill.name)
  );
}

/**
 * Would a change to this character strand a Heroic Skill they hold? Used to
 * refuse a refund or an unlearn rather than cascade one.
 *
 * A change is `{ classLevels, skillLevels, removed }`: class levels after it by
 * class key, skill levels after it by skill key (0 = gone), and any other skill
 * keys leaving the sheet. Taking the skills as well as the classes is what
 * catches a requirement met from elsewhere: Harvester of Sorrow taken through
 * Necromancer still needs Drain Spirit, which an Entropist refund can remove.
 *
 * Only a clause the change itself would break counts. A Heroic that already
 * fails its requirement must not block every refund and blame an unrelated
 * class. Equipment-granted Heroics are skipped: they cannot be unlearned, so
 * naming one as the thing to unlearn first would be a dead end.
 *
 * @returns {object[]} held heroics that would become illegal
 */
export function heroicsBrokenBy(actor, { classLevels = {}, skillLevels = {}, removed = [] } = {}) {
  const held = indexActorSkills(actor);
  const gone = new Set(removed);
  const heldHeroics = [...held.entries()]
    .filter(([key, h]) => h.isHeroic && !isContained(h.item) && !gone.has(key));
  if (!heldHeroics.length) return [];

  const skillsAfter = new Map(held);
  for (const key of gone) skillsAfter.delete(key);
  for (const [key, level] of Object.entries(skillLevels)) {
    const hit = skillsAfter.get(key);
    if (!hit) continue;
    if (level > 0) skillsAfter.set(key, { ...hit, level });
    else skillsAfter.delete(key);
  }

  const masteredAfter = new Set();
  for (const c of readActorClasses(actor)) {
    const key = c.class ? c.class.key : c.key;
    if ((classLevels[key] ?? c.level) >= LEVELUP.RULE.MAX_CLASS_LEVEL) masteredAfter.add(key);
  }

  const level = num(actor?.system?.props?.[LEVELUP.PROP.LEVEL], 0);
  const before = { mastered: masteredKeys(actor), skills: held, level };
  const after = { mastered: masteredAfter, skills: skillsAfter, level };
  const broken = [];

  for (const [, h] of heldHeroics) {
    const parsed = resolveRequirement(h.item.system?.props?.heroic_requirement ?? "");
    if (parsed.empty || parsed.unparsed.length || !parsed.all.length) continue;
    const failing = parsed.all.filter((c) => checkClause(c, before).met && !checkClause(c, after).met);
    if (failing.length) {
      broken.push({
        name: h.item.name,
        uuid: h.item.uuid,
        reasons: failing.map(describe),
      });
    }
  }
  return broken;
}

/**
 * Everything that would refuse a change, for the GM's check and the window's
 * − buttons alike, so the button can say no before Confirm does.
 *
 * `slotsOver` is the rule requirements alone cannot catch. One slot is earned
 * per mastered class, so giving up a mastery must leave room for every Heroic
 * still held, even when none of them depends on that class. Without it, Zarg
 * could drop Dancer to 9 and keep four Heroics on three slots. Only a change
 * that lowers the mastery count can trip it.
 */
export function changeBlockers(actor, change = {}) {
  const broken = heroicsBrokenBy(actor, change);
  const { classLevels = {}, removed = [] } = change;
  const rows = readActorClasses(actor);
  const earnedNow = rows.filter((c) => c.mastered).length;
  const earned = rows.filter((c) => {
    const key = c.class ? c.class.key : c.key;
    return (classLevels[key] ?? c.level) >= LEVELUP.RULE.MAX_CLASS_LEVEL;
  }).length;
  const gone = new Set(removed);
  const used = [...indexActorSkills(actor).entries()]
    .filter(([key, h]) => h.isHeroic && !isContained(h.item) && !gone.has(key)).length;
  return { broken, slotsOver: earned < earnedNow && used > earned, earned, used };
}
