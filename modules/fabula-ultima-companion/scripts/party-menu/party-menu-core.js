// Party Menu — data layer.
//
// A NEW, separate party surface (FF9-style menu) that sits beside the CSB
// party sheet rather than replacing it. Everything here READS the same data the
// old sheet shows — the database actor's member_id_* / bench_id_* slots and the
// members' own actors — and WRITES only to places the CSB sheet never declared:
// module flags. So the GM's existing sheet keeps working untouched, and nothing
// here can be pruned by a CSB reloadTemplate.
//
// First feature: per-character summon bindings (see shared/summon-bindings.js).
//   fixed      → flags on the character's OWN skill item; the owner writes it.
//   persistent → flags on the CREATURE's actor, which a player does not own, so
//                it goes to the acting GM over the shared advancement socket.

import { registerHandler, request, installNet, isActingGM } from "../advancement/advancement-net.js";
import {
  SUMMON_BINDINGS_FLAG, boundSummonRef, clonedKindsOf, summonSlotsOf, persistentHoldersOf,
} from "../shared/summon-bindings.js";
import { skillDeclaresVersatile } from "../battle-director/snapshot.js";
import { isArcanumContainer, isArcanumMerged } from "../battle-director/skill-effects.js";

const TAG = "[PartyMenu]";
const log = (...a) => console.log(TAG, ...a);
const warn = (...a) => console.warn(TAG, ...a);

export const MODULE_ID = "fabula-ultima-companion";
const NS = MODULE_ID;

// CSB template ids (see the reference_skill_identity_fields memory): skills and
// monster skills share `type: "equippableItem"` with gear; `system.template`
// is the only discriminator.
const SKILL_TEMPLATES = new Set(["j0F5Msw5RZ8aIB3j", "FZmpKcQRP7hZQqbV"]);

const ACTIVE_SLOTS = 4;
const BENCH_SLOTS = 6;
const AWAY_SLOTS = 4;

const MSG = {
  BIND_REQ: "partyMenu.bindPersistent.req",
  BIND_RES: "partyMenu.bindPersistent.res",
};

// What a persistent summon of a given kind is stamped with when it is bound.
// A previous holder's own values win over these, so re-pointing a companion
// keeps whatever the GM had tuned. `persistentSummonRetainOnDefeat` is NOT a
// default — it is forced true on every bind (see applyPersistentBind).
const KIND_PROFILE_DEFAULTS = {
  // FU Wayfarer, Faithful Companion: "Your companion doesn't get a turn during
  // conflicts" — it acts through its owner's free action instead.
  companion: { summonTurnsPerRound: 0 },
};

// ── small helpers ─────────────────────────────────────────────────────────────

const str = (v) => String(v ?? "").trim();
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

function actorFromRef(ref) {
  const raw = str(ref);
  if (!raw) return null;
  const id = raw.startsWith("Actor.") ? raw.slice(6) : raw;
  if (/^[A-Za-z0-9]{16}$/.test(id)) {
    const byId = game.actors?.get(id);
    if (byId) return byId;
  }
  return game.actors?.getName?.(raw) ?? null;
}

export function folderPath(doc) {
  const out = [];
  let f = doc?.folder ?? null;
  let guard = 0;
  while (f && guard++ < 12) { out.unshift(f.name); f = f.folder ?? null; }
  return out.join(" / ");
}

export function canEditActor(actor) {
  return !!(game.user?.isGM || actor?.isOwner);
}

// ── roster ────────────────────────────────────────────────────────────────────

export async function partyDbActor() {
  const res = await globalThis.FUCompanion?.api?.getCurrentGameDb?.();
  return res?.db ?? null;
}

function slotActors(db, prefix, n) {
  const props = db?.system?.props ?? {};
  const out = [];
  for (let i = 1; i <= n; i++) {
    const a = actorFromRef(props[`${prefix}_id_${i}`]);
    if (a && !out.includes(a)) out.push(a);
  }
  return out;
}

/** The party as the database actor records it. */
export async function getPartyRoster() {
  const db = await partyDbActor();
  const active = slotActors(db, "member", ACTIVE_SLOTS);
  const reserve = slotActors(db, "bench", BENCH_SLOTS).filter((a) => !active.includes(a));
  const away = slotActors(db, "away", AWAY_SLOTS).filter((a) => !active.includes(a) && !reserve.includes(a));
  const props = db?.system?.props ?? {};
  // `total_zenit` is party-sync's roll-up (members + bench + party coffer);
  // fall back to summing the live actors when it has never been synced.
  let zenit = num(props.total_zenit, NaN);
  if (!Number.isFinite(zenit)) {
    zenit = [...active, ...reserve].reduce((s, a) => s + num(a.system?.props?.zenit), 0) + num(props.zenit);
  }
  return {
    db,
    active,
    reserve,
    away,
    zenit,
    gameName: str(props.game_name) || db?.name || "",
    location: canvas?.scene?.navName || canvas?.scene?.name || "",
  };
}

/** HP/MP/IP/level read straight off the member's actor (not the synced copy). */
export function vitalsOf(actor) {
  const p = actor?.system?.props ?? {};
  return {
    level: num(p.level),
    hp: num(p.current_hp), maxHp: num(p.max_hp),
    mp: num(p.current_mp), maxMp: num(p.max_mp),
    ip: num(p.current_ip), maxIp: num(p.max_ip),
    identity: str(p.char_identity),
    classes: classesOf(actor),
  };
}

/** The actor's classes, most skills first (gear-granted and Zero skills excluded). */
export function classesOf(actor) {
  const counts = new Map();
  for (const it of skillsOf(actor)) {
    const s = skillSource(actor, it);
    if (s.kind === "class") counts.set(s.label, (counts.get(s.label) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
}

// ── skills ────────────────────────────────────────────────────────────────────

export function isSkillItem(item) {
  return SKILL_TEMPLATES.has(str(item?.system?.template));
}

export function skillsOf(actor) {
  return (actor?.items?.contents ?? []).filter(isSkillItem);
}

// ── where a skill comes from (Ability list sections) ──────────────────────────
//
// Read from the data, not the name: a gear-granted skill is a CSB container
// `_skill` whose `system.container` points at the gear item on the same actor
// (see the reference_csb_container_skill_pair memory), so its source is that
// gear even when the skill also names a class (Matador Cape grants Fury's
// Provoke). Zero Triggers carry no isZeroPower flag, only their name.

const GEAR_TYPES = new Set(["weapon", "armor", "shield", "accessory"]);
const CARRY_TYPES = new Set(["consumable", "recipe", "material", "key"]);
const NOT_A_CLASS = new Set(["", "none", "npc"]);

export const SOURCE_KINDS = {
  class: { order: 0, icon: "fa-book-open" },
  personal: { order: 1, icon: "fa-user", label: "Personal" },
  zero: { order: 2, icon: "fa-bolt", label: "Zero Power" },
  gear: { order: 3, icon: "fa-shield-halved", label: "Equipment" },
  item: { order: 4, icon: "fa-flask", label: "Items" },
};

/** { kind, key, label, from?, fromType? } — `key` identifies the section. */
export function skillSource(actor, item) {
  const p = item?.system?.props ?? {};
  const holderId = str(item?.system?.container);
  const holder = holderId ? actor?.items?.get(holderId) : null;
  const holderType = str(holder?.system?.props?.item_type).toLowerCase();
  if (holder && GEAR_TYPES.has(holderType)) return { kind: "gear", key: "gear", label: SOURCE_KINDS.gear.label, from: holder.name, fromType: holderType };
  if (holder && CARRY_TYPES.has(holderType)) return { kind: "item", key: "item", label: SOURCE_KINDS.item.label, from: holder.name, fromType: holderType };
  const zp = p.isZeroPower === true || str(p.isZeroPower) === "true";
  if (zp || /^zero (power|trigger)\b/i.test(item?.name ?? "")) return { kind: "zero", key: "zero", label: SOURCE_KINDS.zero.label };
  // "Arcanist Variant" is the playtest rewrite of Arcanist — same class section.
  const cls = str(p.class).replace(/\s+variant$/i, "");
  if (!NOT_A_CLASS.has(cls.toLowerCase()) && cls !== actor?.name) return { kind: "class", key: `class:${cls}`, label: cls };
  return { kind: "personal", key: "personal", label: SOURCE_KINDS.personal.label };
}

/**
 * Can the character use this skill right now? `{ ok: true }` or
 * `{ ok: false, reason }`.
 *
 * Mirrors the engine's own gates rather than re-deciding them, so the menu greys
 * out exactly what the action menu would hide:
 *  - gear `_skill` → its gear must be equipped, unless the skill is Versatile
 *    (skill-picker's per-grant gate + containerReactionInPlay, via the same
 *    skillDeclaresVersatile reader);
 *  - Arcanum child → only while that Arcanum is merged (isArcanumMerged);
 *  - consumable/recipe skill → greyed when the stack is empty.
 * Anything else is always available here; MP and availability formulas are a
 * battle-time question and stay out of a menu.
 */
export function skillAccess(actor, item) {
  const holderId = str(item?.system?.container);
  if (!holderId || holderId === "-") return { ok: true };
  const holder = actor?.items?.get(holderId);
  if (!holder) return { ok: true };
  if (isArcanumContainer(holder)) {
    return isArcanumMerged(actor, holder) ? { ok: true } : { ok: false, reason: `${holder.name} is not summoned` };
  }
  const type = str(holder.system?.props?.item_type).toLowerCase();
  if (GEAR_TYPES.has(type)) {
    if (holder.system?.props?.isEquipped === true || skillDeclaresVersatile(item)) return { ok: true };
    return { ok: false, reason: `${holder.name} is not equipped` };
  }
  if (CARRY_TYPES.has(type)) {
    const qty = holder.system?.props?.item_quantity;
    if (qty !== undefined && qty !== null && qty !== "" && Number(qty) <= 0) return { ok: false, reason: `No ${holder.name} left` };
  }
  return { ok: true };
}

/**
 * Section order for one actor: classes first (most skills first, the same order
 * as the party window's class line), then Personal, Zero Power, Equipment, Items.
 */
export function sourceRanker(actor) {
  const counts = new Map();
  for (const it of skillsOf(actor)) {
    const s = skillSource(actor, it);
    if (s.kind === "class") counts.set(s.key, (counts.get(s.key) ?? 0) + 1);
  }
  const classRank = new Map([...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k], i) => [k, i]));
  return (src) => SOURCE_KINDS[src.kind].order * 1000 + (src.kind === "class" ? (classRank.get(src.key) ?? 999) : 0);
}

/** The filter bucket a skill falls under in the Ability list. */
export function skillBucket(item) {
  const t = str(item?.system?.props?.skill_type).toLowerCase();
  if (t === "active") return "active";
  if (t === "spell") return "spell";
  if (t === "passive") return "passive";
  return "other";
}

export function skillSummary(item) {
  const p = item?.system?.props ?? {};
  const cost = str(p.cost);
  return {
    id: item.id,
    uuid: item.uuid,
    name: item.name,
    img: item.img || str(p.img) || "icons/svg/book.svg",
    type: str(p.skill_type) || "—",
    bucket: skillBucket(item),
    cost: cost === "-" ? "" : cost,
    cls: str(p.class),
    level: num(p.level, 0),
    maxLevel: num(p.max_level, 0),
    target: str(p.skill_target),
    range: str(p.skill_range),
    duration: str(p.duration),
    description: str(p.description),
    isHeroic: p.isHeroic === true || str(p.isHeroic) === "true",
    isZeroPower: p.isZeroPower === true || str(p.isZeroPower) === "true",
  };
}

/**
 * Kinds that ANY skill in the world creates by cloning (never bindable).
 *
 * World-wide, not per-owner: Birth of the Cruel: Dismiss references
 * `own_persistent_summons_minion` without creating one, so an owner holding
 * Dismiss but not Birth of the Cruel would otherwise see "minion" as bindable —
 * and Dismiss on a bound actor is a destroy_summon. Kinds change only when a
 * skill's effect table does, so the scan is cached until an item changes.
 */
let _clonedKinds = null;
function ownerClonedKinds() {
  if (_clonedKinds) return _clonedKinds;
  const out = new Set();
  const scan = (it) => { if (isSkillItem(it)) for (const k of clonedKindsOf(it)) out.add(k); };
  for (const it of game.items?.contents ?? []) scan(it);
  for (const a of game.actors?.contents ?? []) for (const it of a.items?.contents ?? []) scan(it);
  _clonedKinds = out;
  return out;
}
for (const hook of ["createItem", "updateItem", "deleteItem"]) Hooks.on(hook, () => { _clonedKinds = null; });

/**
 * The summon slots on one of the owner's skills, with their current state.
 * `fixed`: { type, label, summonType, defaultRef, defaultActor, boundRef, boundActor, dangling }
 * `persistent`: { type, kind, holders: Actor[] }
 */
export function resolvedSlotsOf(owner, item) {
  const slots = summonSlotsOf(item, ownerClonedKinds(owner));
  return slots.map((s) => {
    if (s.type === "fixed") {
      const boundRef = boundSummonRef(item, s.label);
      const boundActor = boundRef ? actorFromRef(boundRef) : null;
      const firstDefault = s.defaultRef.split(",").map(str).filter(Boolean);
      return {
        ...s,
        defaultActors: firstDefault.map(actorFromRef).filter(Boolean),
        boundRef,
        boundActor,
        dangling: !!boundRef && !boundActor,
      };
    }
    return { ...s, holders: persistentHoldersOf(game.actors?.contents ?? [], owner.uuid, s.kind) };
  });
}

/** Ids of the owner's skills that carry at least one bindable summon slot. */
export function summonSkillIds(owner) {
  const cloned = ownerClonedKinds(owner);
  const out = new Set();
  for (const it of skillsOf(owner)) if (summonSlotsOf(it, cloned).length) out.add(it.id);
  return out;
}

// ── candidates for the picker ─────────────────────────────────────────────────

/**
 * Actors offered when binding a slot.
 *
 * Players get a SUGGESTED pool only — actors they own, plus the folders the
 * slot's default / current actor already live in — so the picker cannot be
 * used to browse the GM's unrevealed bestiary. The GM can widen to every actor.
 */
export async function candidateActors(owner, slot, { showAll = false, user = game.user } = {}) {
  const roster = await getPartyRoster();
  const all = (game.actors?.contents ?? []).filter((a) => !bindRefusal(a, owner, slot, roster));

  if (showAll && user?.isGM) return all;

  const anchors = slot.type === "fixed"
    ? [...(slot.defaultActors ?? []), slot.boundActor].filter(Boolean)
    : [...(slot.holders ?? [])];
  const folderIds = new Set(anchors.map((a) => a.folder?.id).filter(Boolean));
  return all.filter((a) => {
    if (anchors.includes(a)) return true;
    if (a.folder?.id && folderIds.has(a.folder.id)) return true;
    return !user?.isGM && a.testUserPermission?.(user, "OWNER");
  });
}

/**
 * Why `actor` can never fill `owner`'s slot, or "" if it can. Shared by the
 * picker, the writers and the GM handler so the three cannot disagree.
 */
export function bindRefusal(actor, owner, slot, roster) {
  if (!actor || actor.documentName !== "Actor") return "no-target";
  if (actor.pack || actor.isToken) return "bad-target";
  if (actor.type === "_template" || actor.id === owner?.id) return "bad-target";
  const inParty = [roster?.db, ...(roster?.active ?? []), ...(roster?.reserve ?? []), ...(roster?.away ?? [])]
    .some((a) => a?.id === actor.id);
  if (inParty) return "target-in-party";
  const f = actor.flags?.[NS] ?? {};
  if (f.isField || f.bdGuest) return "bad-target";
  if (f.isPersistentSummon) {
    // A standing summon may only be re-picked into the very slot it holds.
    const same = slot?.type === "persistent"
      && str(f.summonOwnerActorUuid) === owner?.uuid
      && str(f.persistentSummonKind).toLowerCase() === slot.kind;
    if (!same) return "target-held-elsewhere";
  }
  return "";
}

// ── writes ────────────────────────────────────────────────────────────────────

/** Bind (or with `actor = null`, reset) a fixed summon row on the owner's skill. */
export async function setFixedBinding(owner, item, label, actor) {
  if (!canEditActor(owner)) return { ok: false, reason: "not-owner" };
  if (!item || item.parent?.id !== owner.id) return { ok: false, reason: "not-owners-skill" };
  // The label becomes a flag-path segment; a dot in it would nest the write.
  if (!/^[\w-]+$/.test(String(label ?? ""))) return { ok: false, reason: "bad-label" };
  const slot = resolvedSlotsOf(owner, item).find((s) => s.type === "fixed" && s.label === label);
  if (!slot) return { ok: false, reason: "no-such-slot" };
  if (actor) {
    const refusal = bindRefusal(actor, owner, slot, await getPartyRoster());
    if (refusal) return { ok: false, reason: refusal };
    if (!game.user?.isGM && !(await candidateActors(owner, slot)).includes(actor)) {
      return { ok: false, reason: "not-a-candidate" };
    }
  }
  const key = `flags.${NS}.${SUMMON_BINDINGS_FLAG}`;
  const others = Object.keys(item.flags?.[NS]?.[SUMMON_BINDINGS_FLAG] ?? {}).filter((k) => k !== label);
  // Resetting the last binding drops the whole map, so a reset skill is
  // byte-identical to one that was never bound (no `{}` left in the export).
  const otherNsKeys = Object.keys(item.flags?.[NS] ?? {}).filter((k) => k !== SUMMON_BINDINGS_FLAG);
  const update = actor
    ? { [`${key}.${label}`]: actor.uuid }
    : others.length ? { [`${key}.-=${label}`]: null }
    : otherNsKeys.length ? { [`flags.${NS}.-=${SUMMON_BINDINGS_FLAG}`]: null }
    : { [`flags.-=${NS}`]: null };
  await item.update(update);
  log(`${owner.name} · ${item.name} · ${label} → ${actor ? actor.name : "(authored default)"}`);
  return { ok: true };
}

/** Bind (or reset) the owner's persistent summon of `kind`. Any client. */
export function setPersistentBinding(owner, kind, actor) {
  return request(MSG.BIND_REQ, {
    ownerUuid: owner?.uuid ?? "",
    kind: str(kind).toLowerCase(),
    actorUuid: actor?.uuid ?? "",
    requesterUserId: game.user?.id,
  });
}

/**
 * Acting-GM side of a persistent bind.
 *
 * Every check is re-done here, because the request may come from any client:
 * the requester must own the owner, the kind must be one the owner's skills
 * actually reference (so this cannot stamp arbitrary summons), and the target
 * must not be a party member or another owner's standing summon.
 */
async function applyPersistentBind(payload) {
  const owner = await fromUuid(str(payload?.ownerUuid)).catch(() => null);
  if (!owner || owner.documentName !== "Actor") return { ok: false, reason: "no-owner" };
  const user = game.users?.get(payload?.requesterUserId);
  const allowed = user?.isGM || owner.testUserPermission?.(user, "OWNER");
  if (!allowed) return { ok: false, reason: "not-owner" };

  const kind = str(payload?.kind).toLowerCase();
  if (!/^[a-z0-9_]+$/.test(kind)) return { ok: false, reason: "bad-kind" };
  const cloned = ownerClonedKinds(owner);
  const referenced = skillsOf(owner).some((it) =>
    summonSlotsOf(it, cloned).some((s) => s.type === "persistent" && s.kind === kind));
  if (!referenced) return { ok: false, reason: "kind-not-on-owner" };

  const holders = persistentHoldersOf(game.actors?.contents ?? [], owner.uuid, kind);
  let target = null;
  if (str(payload?.actorUuid)) {
    target = await fromUuid(str(payload.actorUuid)).catch(() => null);
    const slot = { type: "persistent", kind, holders };
    const refusal = bindRefusal(target, owner, slot, await getPartyRoster());
    if (refusal) return { ok: false, reason: refusal };
    // The picker's "suggested pool" is only a UI until it is enforced HERE —
    // otherwise a crafted request could bind any hidden boss to a player.
    if (!user.isGM && !(await candidateActors(owner, slot, { user })).includes(target)) {
      return { ok: false, reason: "not-a-candidate" };
    }
  }

  const prev = holders.filter((a) => a.id !== target?.id);
  const profile = { ...(KIND_PROFILE_DEFAULTS[kind] ?? {}) };
  const tpr = prev[0]?.flags?.[NS]?.summonTurnsPerRound;
  if (tpr !== undefined && tpr !== null && tpr !== "") profile.summonTurnsPerRound = tpr;

  for (const a of prev) {
    await a.update({
      [`flags.${NS}.-=isPersistentSummon`]: null,
      [`flags.${NS}.-=summonOwnerActorUuid`]: null,
      [`flags.${NS}.-=persistentSummonKind`]: null,
      [`flags.${NS}.-=persistentSummonBound`]: null,
    });
  }
  if (target) {
    await target.update({
      [`flags.${NS}.isPersistentSummon`]: true,
      // Marks an actor somebody PICKED rather than one the engine cloned:
      // destroy_summon releases a bound actor instead of deleting it.
      [`flags.${NS}.persistentSummonBound`]: true,
      [`flags.${NS}.summonOwnerActorUuid`]: owner.uuid,
      [`flags.${NS}.persistentSummonKind`]: kind,
      // Forced, not defaulted: a non-retained persistent summon is DELETED on
      // death (reAddPersistentSummons stamps deleteCloneOnDeath = !retain). That
      // is right for an engine-made clone and catastrophic for an actor somebody
      // picked from a list — it would destroy the bestiary entry itself.
      [`flags.${NS}.persistentSummonRetainOnDefeat`]: true,
      ...("summonTurnsPerRound" in profile ? { [`flags.${NS}.summonTurnsPerRound`]: profile.summonTurnsPerRound } : {}),
    });
  }
  log(`${owner.name} · ${kind} → ${target ? target.name : "(none)"}${prev.length ? ` (released ${prev.map((a) => a.name).join(", ")})` : ""}`);
  return { ok: true, holder: target?.name ?? null, released: prev.map((a) => a.name) };
}

registerHandler(MSG.BIND_REQ, MSG.BIND_RES, applyPersistentBind);

Hooks.once("ready", () => {
  installNet();
  globalThis.FUCompanion = globalThis.FUCompanion || {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
  globalThis.FUCompanion.api.partyMenuData = {
    getPartyRoster, skillsOf, skillSummary, resolvedSlotsOf, candidateActors,
    setFixedBinding, setPersistentBinding, isActingGM,
  };
});

export { warn };
