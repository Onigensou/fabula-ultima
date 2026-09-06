/**
 * Character Level-Up System — backend
 * ---------------------------------------------------------------------------
 * One Skill Point buys ONE class level and ONE skill level in that class.
 * Refunds reverse it. Heroic Skills are free picks earned by mastering a class.
 *
 * AUTHORITY
 * ---------
 * Every mutation runs GM-side. A player's window emits a request and awaits a
 * result; the GM re-validates everything — including the spend gate — because
 * the client's copy of the rules is a convenience, not a guarantee. In a
 * dual-GM world only the primary GM acts, or both would apply the same spend.
 *
 * ORDERING AND ROLLBACK
 * ---------------------
 * A spend touches three things (class row, skill item, point counter). A
 * half-applied spend is worse than a failed one — a player who paid a point and
 * got no skill has no way to recover it — so the point is debited LAST, after
 * the two writes that can fail have succeeded. A refund credits the point last
 * for the same reason.
 */

import { LEVELUP, idKey, num, log, warn, err } from "./levelup-const.js";
import {
  getRegistry, resolveClass, readActorClasses, sumClassLevels,
  unspentPoints, expectedPoints, invalidate as invalidateRegistry,
} from "./class-registry.js";
import { evaluate, availableHeroics, indexActorSkills, heroicsBrokenBy } from "./requirement-eval.js";
import { gateState } from "./levelup-gate.js";
import { isActingGM, registerHandler, request, installNet } from "../advancement/advancement-net.js";
import { isAdvancementSubject, subjectFailure } from "../advancement/advancement-subject.js";

const PROP = LEVELUP.PROP;
const RULE = LEVELUP.RULE;

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * Grant the companion skills a just-taken skill brings with it.
 *
 * A COMPANION comes WITH its parent instead of being bought — Birth of the
 * Cruel's "Dismiss" is the release for the Minion the parent raises, and RAW
 * hands it over as part of the same Heroic Skill. `class-registry` withholds
 * companions from `skills` / `heroics` / `facets` so they can never be
 * purchased; this is the only path that hands one out.
 *
 * WHEN THIS RUNS, precisely — it is NOT a general backfill, and an earlier
 * version of this comment wrongly claimed it was:
 *   - every purchase of a base-skill parent, including a level-up of one the
 *     actor already holds (applySpend step 2b), EXCEPT once that skill is at
 *     max SL, where validateSpend answers `skill_maxed` before step 2b;
 *   - the moment a heroic parent is taken, and never again — `availableHeroics`
 *     skips a heroic the actor already holds (`if (held.has(h.key)) continue`),
 *     so applyHeroic cannot re-run for it.
 * So a character who ALREADY holds a parent when a companion is first declared
 * on it may never receive that companion. Declaring a companion on an existing
 * skill therefore needs an explicit backfill for current holders — check them,
 * do not assume the next level-up will heal it. (For Birth of the Cruel it was
 * a no-op: Keren is the only holder and already carried the Dismiss.)
 *
 * Companions are PERMANENT once granted. Nothing mirrors this on refund: a
 * companion was never bought, so there is no point to give back, and deleting it
 * would destroy a document the player may have since customised. A refund of the
 * parent therefore leaves the companion in place — harmless, since a companion's
 * own availability gate simply stops passing (the Dismiss greys out with "You
 * have no Minion to destroy"). Refunding the COMPANION is refused with
 * `skill_not_found`, which is correct: it is not in `cls.skills` to refund.
 *
 * Anything already held is skipped, which also makes a re-run inert.
 *
 * Non-fatal by design, resolve AND write alike: the parent skill is already
 * written by the time this runs and the Skill Point has not yet been debited, so
 * letting anything throw out of here would surface as a failed spend that had in
 * fact half-applied — the exact case the ORDERING note at the top of this file
 * exists to prevent. A miss is logged instead.
 *
 * `classes` is a LIST because a Heroic Skill can be offered by more than one
 * class (`availableHeroics` collects them into `offer.from`), and the companion
 * document lives on whichever class actor declares it — not necessarily the
 * first one that happened to offer the parent.
 *
 * @returns {Promise<string[]>} names actually granted
 */
async function grantCompanions(actor, classes, skill) {
  try {
    return await grantCompanionsInner(actor, classes, skill);
  } catch (e) {
    // Everything here is best-effort — see the "Non-fatal by design" note above.
    err("grantCompanions threw", e);
    return [];
  }
}

async function grantCompanionsInner(actor, classes, skill) {
  const wanted = skill?.companions ?? [];
  if (!wanted.length) return [];
  const from = (Array.isArray(classes) ? classes : [classes]).filter(Boolean);

  const held = indexActorSkills(actor);
  const seen = new Set();
  const create = [];
  const granted = [];

  for (const key of wanted) {
    if (!key || seen.has(key) || held.has(key)) continue;
    seen.add(key);
    let src = null;
    for (const cls of from) {
      src = cls.companions?.find((c) => c.key === key);
      if (src) break;
    }
    if (!src) {
      warn(`companion "${key}" named by ${skill.name} is on no offering class `
        + `(${from.map((c) => c.name).join(", ") || "none"}) — skipped`);
      continue;
    }
    const doc = await fromUuid(src.uuid);
    if (!doc) { warn(`companion ${src.name} (${src.uuid}) did not resolve — skipped`); continue; }
    const data = doc.toObject();
    delete data._id;
    foundry.utils.setProperty(data, "system.props.level", 1);
    create.push(data);
    granted.push(src.name);
  }

  if (create.length) {
    await actor.createEmbeddedDocuments("Item", create);
    log(`companions: ${actor.name} ← ${granted.join(", ")} (with ${skill.name})`);
  }
  return granted;
}

const resolveActor = (uuid) => {
  const doc = (typeof fromUuidSync === "function" ? fromUuidSync(uuid) : null) ?? null;
  if (doc?.documentName === "Actor") return doc;
  return game.actors?.get(String(uuid ?? "").replace(/^Actor\./, "")) ?? null;
};

const fail = (reason, extra = {}) => ({ ok: false, reason, ...extra });

// `isActingGM` now lives in the shared transport — see the socket section below
// for why this system must not keep its own copy.

/** Next free numeric row key for a CSB dynamicTable. */
function nextRowKey(table) {
  let max = -1;
  for (const k of Object.keys(table ?? {})) {
    const n = Number(k);
    if (Number.isFinite(n)) max = Math.max(max, n);
  }
  return String(max + 1);
}

/**
 * Heroic Skill slots. One is earned per mastered class; only heroics the
 * character actually PICKED consume one.
 *
 * The discriminator is CSB's own grant mechanism, not the skill's name. A skill
 * granted by a piece of equipment is stored as a contained sub-item — its
 * `container` prop points at the holder — which is exactly how Zarg's
 * "Maid cap (Passive)" hangs off the "Maid cap" accessory. It is flagged
 * isHeroic because it is a heroic-grade passive, but it was never a pick, and
 * counting it silently ate the slot he earned for mastering Dancer.
 *
 * Matching against the class catalogues instead would be wrong: they are
 * incomplete. Illusionist has no heroics authored at all, Tinkerer and Esper
 * have one each, yet Keren legitimately holds "Create Phantasm: Numen" and Zarg
 * holds "Deep Pockets", both authored straight onto the character. That
 * approach handed Keren two phantom slots she had already spent.
 *
 * `granted` is reported so a GM can see which heroics were excluded and why.
 */
export function heroicSlots(actor) {
  const contained = (item) =>
    !!(item?.system?.props?.container ?? item?.system?.container ?? null);

  const held = [...indexActorSkills(actor).values()].filter((h) => h.isHeroic);
  const picked = held.filter((h) => !contained(h.item));
  const earned = readActorClasses(actor).filter((c) => c.mastered).length;

  return {
    earned,
    used: picked.length,
    open: Math.max(0, earned - picked.length),
    granted: held.filter((h) => contained(h.item)).map((h) => h.item.name),
  };
}

// ── Forget me Nut ──────────────────────────────────────────────────────────
//
// Giving a Skill level back costs one nut, taken from the character doing it —
// never from a party pool, since it is their level being unwound.

const isNut = (item) => idKey(item?.name) === idKey(LEVELUP.NUT.NAME);

/** Every nut stack the actor holds, and the total across them. */
export function readNuts(actor) {
  const stacks = (actor?.items?.contents ?? []).filter(isNut);
  const count = stacks.reduce((n, i) => n + Math.max(0, num(i.system?.props?.[LEVELUP.NUT.QTY_PROP], 0)), 0);
  return { count, stacks };
}

/**
 * Consume one nut. Follows the convention in action-execution-core's
 * consumeItemIfNeeded: decrement the stack, delete it when it empties.
 */
async function consumeNut(actor) {
  const { stacks } = readNuts(actor);
  const stack = stacks.find((i) => num(i.system?.props?.[LEVELUP.NUT.QTY_PROP], 0) > 0);
  if (!stack) return false;
  const left = num(stack.system?.props?.[LEVELUP.NUT.QTY_PROP], 0) - 1;
  if (left > 0) await stack.update({ [`system.props.${LEVELUP.NUT.QTY_PROP}`]: left });
  else await actor.deleteEmbeddedDocuments("Item", [stack.id]);
  return true;
}

/** Non-mastered classes, for the p.227 "at most three" rule. */
const unmasteredCount = (actor) => readActorClasses(actor).filter((c) => !c.mastered).length;

// ── read model ─────────────────────────────────────────────────────────────

/**
 * Everything the window needs for one actor. Pure read — safe on any client.
 */
export function getState(actorUuid) {
  const actor = resolveActor(actorUuid);
  if (!actor) return fail("actor_not_found");

  const reg = getRegistry();
  const held = indexActorSkills(actor);
  const taken = readActorClasses(actor);
  const takenByKey = new Map(taken.map((c) => [c.class ? c.class.key : c.key, c]));

  const classes = reg.list.map((cls) => {
    const mine = takenByKey.get(cls.key) ?? null;
    return {
      key: cls.key,
      id: cls.id,
      name: cls.name,
      img: cls.img,
      folder: cls.folder,
      // The registry benefit is what the CLASS fixes; a class that lets the
      // player choose reports null there, and the answer lives on the actor
      // row instead. Falling through to it means a written choice is visible
      // rather than silently absent.
      benefit: cls.benefit ?? (mine?.benefit || null),
      free: cls.free,
      // Authored prose for the class browser: the quote, the body, the alt
      // names, and the Unique Mechanic (present on 21 of 42 classes).
      flavor: cls.flavor,
      lore: cls.lore,
      also: cls.also,
      mechanic: cls.mechanic,
      level: mine?.level ?? 0,
      mastered: !!mine?.mastered,
      taken: !!mine,
      skills: cls.skills.map((s) => {
        const h = held.get(s.key);
        return {
          uuid: s.uuid, key: s.key, name: s.name, img: s.img, type: s.type,
          cost: s.cost, description: s.description,
          maxLevel: s.maxLevel,
          level: h ? h.level : 0,
          atMax: (h ? h.level : 0) >= s.maxLevel,
          // >0 → taking a level also awards this many Facets. Zero when the
          // class has none authored, so Pilot's Personal Vehicle never prompts.
          facetGrant: cls.facets.length ? s.facetGrant : 0,
        };
      }),
      facets: cls.facets.map((f) => ({
        uuid: f.uuid, key: f.key, name: f.name, img: f.img,
        description: f.description, cost: f.cost,
        held: held.has(f.key),
      })),
    };
  });

  const stored = unspentPoints(actor);
  const expected = expectedPoints(actor);

  return {
    ok: true,
    // Whether this actor is a subject of advancement at all. NPCs carry levels
    // and classes, so every number below computes for them too — the flag is
    // what stops the window offering to spend on one.
    eligible: isAdvancementSubject(actor),
    actor: { uuid: actor.uuid, id: actor.id, name: actor.name, img: actor.img },
    level: num(actor.system?.props?.[PROP.LEVEL], 0),
    classLevelTotal: sumClassLevels(actor),
    points: { stored, expected, drift: stored !== expected },
    gate: gateState(),
    nuts: { count: readNuts(actor).count, name: LEVELUP.NUT.NAME, img: LEVELUP.NUT.IMG },
    rules: { maxClassLevel: RULE.MAX_CLASS_LEVEL, maxCharLevel: RULE.MAX_CHAR_LEVEL, maxUnmastered: RULE.MAX_UNMASTERED_CLASSES },
    unmastered: unmasteredCount(actor),
    heroic: {
      ...heroicSlots(actor),
      available: availableHeroics(actor),
      // Heroics already on the sheet, for the collection view.
      //
      // Equipment-granted ones are excluded outright, not merely flagged. A
      // Heroic Skill in this system is something earned by mastering a class;
      // a heroic-grade passive hanging off an accessory (Zarg's "Maid cap
      // (Passive)") is a property of the item, arrives and leaves with it, and
      // is neither a pick nor a thing this window can act on. It is already
      // excluded from slot accounting — listing it anyway just invited the
      // question of why four entries showed against three taken.
      owned: [...held.values()]
        .filter((h) => h.isHeroic && !(h.item.system?.props?.container ?? h.item.system?.container ?? null))
        .map((h) => ({
          uuid: h.item.uuid,
          name: h.item.name,
          img: h.item.img,
          description: h.item.system?.props?.description ?? "",
          cost: h.item.system?.props?.cost ?? "",
          from: h.item.system?.props?.class ?? "",
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    },
    classes,
    duplicates: reg.duplicates,
  };
}

// ── validation ─────────────────────────────────────────────────────────────

function validateSpend(actor, cls, skill) {
  if (unspentPoints(actor) < 1) return fail("no_points");

  const taken = readActorClasses(actor);
  const mine = taken.find((c) => (c.class ? c.class.key : c.key) === cls.key) ?? null;
  const classLevel = mine?.level ?? 0;

  if (classLevel >= RULE.MAX_CLASS_LEVEL) return fail("class_maxed", { classLevel });
  if (num(actor.system?.props?.[PROP.LEVEL], 0) > RULE.MAX_CHAR_LEVEL) return fail("char_level_cap");

  // p.227 — never more than three non-mastered classes. Taking a level in a
  // class already held cannot break it; only opening a NEW one can.
  if (!mine && unmasteredCount(actor) >= RULE.MAX_UNMASTERED_CLASSES) {
    return fail("too_many_unmastered", { limit: RULE.MAX_UNMASTERED_CLASSES });
  }

  const owned = cls.skills.find((s) => s.uuid === skill.uuid || s.key === skill.key);
  if (!owned) return fail("skill_not_in_class");

  const held = indexActorSkills(actor).get(owned.key);
  const level = held ? held.level : 0;
  if (level >= owned.maxLevel) return fail("skill_maxed", { level, maxLevel: owned.maxLevel });

  return { ok: true, mine, classLevel, owned, skillLevel: level };
}

// ── mutations (GM-side) ────────────────────────────────────────────────────

async function applySpend({ actorUuid, classKey, skillUuid, benefit, facetUuids, requesterUserId }) {
  const gate = gateState();
  if (!gate.open) return fail("gate_closed", { gate });

  const actor = resolveActor(actorUuid);
  if (!actor) return fail("actor_not_found");

  // Advancement is a player-character system. The window filters its target,
  // but this handler is the authority — see advancement-subject.js.
  const wrongSubject = subjectFailure(actor);
  if (wrongSubject) return fail(wrongSubject);

  const cls = resolveClass(classKey);
  if (!cls) return fail("class_not_found");

  const skill = cls.skills.find((s) => s.uuid === skillUuid) ?? null;
  if (!skill) return fail("skill_not_found");

  const v = validateSpend(actor, cls, skill);
  if (!v.ok) return v;

  // `class_list` carries ONE benefit column per class row, not one per level,
  // so the HP/MP/IP choice is only made when the class is first opened. A class
  // whose `benefit_dropdown` names a fixed benefit never asks at all.
  const isNewClass = !v.mine;
  const chosenBenefit = cls.benefit ?? (["hp", "mp", "ip"].includes(benefit) ? benefit : null);
  if (isNewClass && !chosenBenefit) return fail("benefit_required", { classBenefit: cls.benefit });

  try {
    // 1. Class row — create or increment. CSB dynamicTables are keyed objects,
    //    so a new row is a new numeric key rather than an array push.
    const table = foundry.utils.duplicate(actor.system?.props?.[PROP.CLASS_LIST] ?? {});
    if (isNewClass) {
      // Refunding a class to zero leaves a $deleted tombstone (CSB's own
      // convention for dynamicTable rows). Re-take the same class and we must
      // revive that row rather than append a fresh key, or a player cycling a
      // class in and out grows class_list without bound.
      const tomb = Object.entries(table).find(
        ([, r]) => r?.$deleted && idKey(r.class_name) === cls.key
      );
      const key = tomb ? tomb[0] : nextRowKey(table);
      table[key] = {
        $deleted: false,
        class_name: cls.name, // canonical spelling, not whatever was typed before
        level: 1,
        benefit: chosenBenefit,
      };
    } else {
      const row = table[v.mine.rowKey];
      if (!row) return fail("class_row_vanished");
      row.level = v.classLevel + 1;
      if (!row.benefit) row.benefit = chosenBenefit;
    }
    await actor.update({ [`system.props.${PROP.CLASS_LIST}`]: table });

    // 2. Skill — grant a copy from the class actor, or raise the held one.
    const held = indexActorSkills(actor).get(skill.key);
    if (held) {
      await held.item.update({ "system.props.level": v.skillLevel + 1 });
    } else {
      const source = await fromUuid(skill.uuid);
      if (!source) return fail("skill_source_missing");
      const data = source.toObject();
      delete data._id;
      foundry.utils.setProperty(data, "system.props.level", 1);
      await actor.createEmbeddedDocuments("Item", [data]);
    }

    // 2b. Companion skills that come WITH this one (see grantCompanions). Runs
    //     on a raise as well as a first take, so a character who took the parent
    //     before its companion existed picks it up without a migration.
    await grantCompanions(actor, [cls], skill);

    // 3. Facets. Skills like Dance or Elemental Magic award a spell/dance/
    //    symbol per level ("see Facet"); the window asks which and passes the
    //    chosen uuids. Anything already held is skipped rather than duplicated.
    if (Array.isArray(facetUuids) && facetUuids.length) {
      const heldNow = indexActorSkills(actor);
      const create = [];
      for (const uuid of facetUuids) {
        const src = cls.facets.find((f) => f.uuid === uuid);
        if (!src || heldNow.has(src.key)) continue;
        const doc = await fromUuid(uuid);
        if (!doc) continue;
        const data = doc.toObject();
        delete data._id;
        foundry.utils.setProperty(data, "system.props.level", 1);
        create.push(data);
      }
      if (create.length) await actor.createEmbeddedDocuments("Item", create);
    }

    // 4. Free benefits on a brand-new class. Only the martial-armor flag is
    //    modelled on the character sheet; the ritual/discipline flags do not
    //    follow from class ownership in this world and stay hand-managed.
    if (isNewClass && cls.free.martialArmor) {
      await actor.update({ "system.props.is_martialarmor": true });
    }

    // 4. Debit LAST — everything above has now succeeded.
    await actor.update({
      [`system.props.${PROP.SKILL_POINT}`]: Math.max(0, unspentPoints(actor) - 1),
    });

    log(`spend: ${actor.name} → ${cls.name} ${v.classLevel + 1}, ${skill.name} ${v.skillLevel + 1}`);
    return {
      ok: true,
      classLevel: v.classLevel + 1,
      skillLevel: v.skillLevel + 1,
      mastered: v.classLevel + 1 >= RULE.MAX_CLASS_LEVEL,
      pointsLeft: unspentPoints(actor),
    };
  } catch (e) {
    err("applySpend threw", e);
    return fail("error", { message: String(e?.message ?? e) });
  }
}

async function applyRefund({ actorUuid, classKey, skillUuid, facetUuids }) {
  const gate = gateState();
  if (!gate.open) return fail("gate_closed", { gate });

  const actor = resolveActor(actorUuid);
  if (!actor) return fail("actor_not_found");

  const wrongSubject = subjectFailure(actor);
  if (wrongSubject) return fail(wrongSubject);

  const cls = resolveClass(classKey);
  if (!cls) return fail("class_not_found");

  const taken = readActorClasses(actor);
  const mine = taken.find((c) => (c.class ? c.class.key : c.key) === cls.key) ?? null;
  if (!mine || mine.level < 1) return fail("class_not_held");

  const skill = cls.skills.find((s) => s.uuid === skillUuid) ?? null;
  if (!skill) return fail("skill_not_found");

  const held = indexActorSkills(actor).get(skill.key);
  if (!held || held.level < 1) return fail("skill_not_held");

  // Refuse rather than cascade. A player who unlearns one skill should never
  // watch three others disappear with it.
  const broken = heroicsBrokenBy(actor, cls.key, mine.level - 1);
  if (broken.length) return fail("would_orphan_heroic", { broken });

  // The price, checked before anything moves. Charged after the level is
  // actually given back, so a failure part-way cannot bill for nothing.
  const nutsBefore = readNuts(actor).count;
  if (nutsBefore < 1) return fail("no_nuts", { have: nutsBefore, need: 1 });

  try {
    // 0. Facets handed back with the level. The window offers the choice from
    //    what the character actually holds; skipping is allowed, which is what
    //    keeps a pre-existing mismatch (Hina's Elemental Magic 3 against 4
    //    spells) from being forcibly reconciled by an unrelated refund.
    if (Array.isArray(facetUuids) && facetUuids.length) {
      const heldNow = indexActorSkills(actor);
      const remove = [];
      for (const uuid of facetUuids) {
        const src = cls.facets.find((f) => f.uuid === uuid);
        const hit = src ? heldNow.get(src.key) : null;
        if (hit) remove.push(hit.item.id);
      }
      if (remove.length) await actor.deleteEmbeddedDocuments("Item", remove);
    }

    // 1. Skill down, removed entirely at zero.
    if (held.level <= 1) await held.item.delete();
    else await held.item.update({ "system.props.level": held.level - 1 });

    // 2. Class row down; CSB deletes a dynamicTable row via $deleted, not by
    //    dropping the key.
    const table = foundry.utils.duplicate(actor.system?.props?.[PROP.CLASS_LIST] ?? {});
    const row = table[mine.rowKey];
    if (row) {
      if (mine.level <= 1) row.$deleted = true;
      else row.level = mine.level - 1;
      await actor.update({ [`system.props.${PROP.CLASS_LIST}`]: table });
    }

    // 3. Revoke the martial flag only when no OTHER held class still grants it.
    if (mine.level <= 1 && cls.free.martialArmor) {
      const stillGranted = readActorClasses(actor).some(
        (c) => c.class && c.class.key !== cls.key && c.class.free.martialArmor
      );
      if (!stillGranted) await actor.update({ "system.props.is_martialarmor": false });
    }

    // 4. Pay the nut, then credit the point. Both last, after the writes that
    //    could fail — the same ordering the spend path uses.
    const paid = await consumeNut(actor);
    await actor.update({
      [`system.props.${PROP.SKILL_POINT}`]: unspentPoints(actor) + 1,
    });

    log(`refund: ${actor.name} → ${cls.name} ${mine.level - 1}, ${skill.name} ${held.level - 1} (nut paid: ${paid})`);
    return {
      ok: true,
      classLevel: mine.level - 1,
      skillLevel: held.level - 1,
      pointsLeft: unspentPoints(actor),
      nutsLeft: readNuts(actor).count,
    };
  } catch (e) {
    err("applyRefund threw", e);
    return fail("error", { message: String(e?.message ?? e) });
  }
}

async function applyHeroic({ actorUuid, skillUuid }) {
  const gate = gateState();
  if (!gate.open) return fail("gate_closed", { gate });

  const actor = resolveActor(actorUuid);
  if (!actor) return fail("actor_not_found");

  const wrongSubject = subjectFailure(actor);
  if (wrongSubject) return fail(wrongSubject);

  const slots = heroicSlots(actor);
  if (slots.open < 1) return fail("no_heroic_slot", { slots });

  const offer = availableHeroics(actor).find((o) => o.skill.uuid === skillUuid);
  if (!offer) return fail("heroic_not_available");
  if (!offer.evaluable) return fail("requirement_unevaluable", { prose: offer.prose });
  if (!offer.met) {
    return fail("requirement_not_met", { missing: offer.clauses.filter((c) => !c.met).map((c) => c.label) });
  }

  try {
    const source = await fromUuid(skillUuid);
    if (!source) return fail("skill_source_missing");
    const data = source.toObject();
    delete data._id;
    foundry.utils.setProperty(data, "system.props.level", 1);
    await actor.createEmbeddedDocuments("Item", [data]);

    // Companions ride along with the heroic that names them — Birth of the Cruel
    // brings its Dismiss. Searched across every class that offered this heroic,
    // since the companion lives on whichever one declares it.
    await grantCompanions(actor, offer.from, offer.skill);

    log(`heroic: ${actor.name} → ${offer.skill.name}`);
    // Heroic picks are free — no Skill Point moves.
    return { ok: true, name: offer.skill.name, slots: heroicSlots(actor) };
  } catch (e) {
    err("applyHeroic threw", e);
    return fail("error", { message: String(e?.message ?? e) });
  }
}

// ── socket plumbing ────────────────────────────────────────────────────────
//
// The transport is SHARED with the attribute system (advancement-net.js) and is
// deliberately not duplicated here. This system once shipped with two live
// channels and listeners on both, so every player request applied twice —
// invisible from the GM seat, because the GM path short-circuits and never
// touches the socket. A second system copy-pasting this would recreate it.
//
// Message types stay namespaced ("levelup.*") so domains cannot collide on the
// single channel.

registerHandler(LEVELUP.MSG.SPEND_REQ,  LEVELUP.MSG.SPEND_RES,  applySpend);
registerHandler(LEVELUP.MSG.REFUND_REQ, LEVELUP.MSG.REFUND_RES, applyRefund);
registerHandler(LEVELUP.MSG.HEROIC_REQ, LEVELUP.MSG.HEROIC_RES, applyHeroic);

const REQ_OPTS = { timeoutMs: LEVELUP.REQUEST_TIMEOUT_MS };

// ── public API ─────────────────────────────────────────────────────────────

/**
 * Grant every companion this actor's HELD skills declare but that they lack.
 *
 * This is the BACKFILL lever, and it exists because `grantCompanions` only fires
 * on a purchase: a heroic is never re-offered once held (`availableHeroics` skips
 * it) and a base skill at max SL fails `validateSpend` before the grant runs. So
 * declaring a companion on a skill characters ALREADY hold reaches none of them.
 * Run this once after declaring one:
 *
 *   FUCompanion.api.levelUp.reconcileCompanions(actor)
 *
 * Idempotent — anything already held is skipped, so a second run grants nothing.
 * Returns the names granted, so an empty array is a real "nothing was missing".
 */
export async function reconcileCompanions(actor) {
  if (!actor) return [];
  const granted = [];
  for (const cls of getRegistry().list) {
    for (const skill of [...cls.skills, ...cls.heroics, ...cls.facets]) {
      if (!skill.companions?.length) continue;
      // Only parents this actor actually holds. `held` is re-read inside
      // grantCompanions on every call, so grants made earlier in this loop are
      // seen by later ones and nothing is created twice.
      if (!indexActorSkills(actor).has(skill.key)) continue;
      granted.push(...(await grantCompanions(actor, [cls], skill)));
    }
  }
  if (granted.length) log(`reconcileCompanions: ${actor.name} ← ${granted.join(", ")}`);
  return granted;
}

export const spendPoint  = (p) => request(LEVELUP.MSG.SPEND_REQ,  p, REQ_OPTS);
export const refundPoint = (p) => request(LEVELUP.MSG.REFUND_REQ, p, REQ_OPTS);
export const pickHeroic  = (p) => request(LEVELUP.MSG.HEROIC_REQ, p, REQ_OPTS);

/** GM-only: reconcile a drifted counter to the derived value. */
export async function healPoints(actorUuid) {
  if (!game.user?.isGM) return fail("gm_only");
  const actor = resolveActor(actorUuid);
  if (!actor) return fail("actor_not_found");
  const expected = expectedPoints(actor);
  await actor.update({ [`system.props.${PROP.SKILL_POINT}`]: expected });
  return { ok: true, skill_point: expected };
}

function registerApi() {
  globalThis.FUCompanion = globalThis.FUCompanion ?? {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api ?? {};
  globalThis.FUCompanion.api.levelUp = {
    getState, spendPoint, refundPoint, pickHeroic, healPoints,
    heroicSlots, gateState, invalidateRegistry,
    // The companion backfill lever — see reconcileCompanions. Exposed because
    // declaring a companion on an already-held skill reaches nobody otherwise,
    // and a GM needs a way to run it without a level-up.
    reconcileCompanions,
  };
}

Hooks.once("init", registerApi);
Hooks.once("ready", () => {
  installNet();
  // Class actors are authored rarely, but when they are the cache must go.
  for (const hook of ["createItem", "updateItem", "deleteItem", "updateActor"]) {
    Hooks.on(hook, (doc) => {
      const actor = doc?.documentName === "Actor" ? doc : doc?.parent;
      if (actor?.type === "character" && actor?.folder) invalidateRegistry();
    });
  }
  log("ready");
});
