// ============================================================================
// Conflict Event — Soul Tithe.
//
// The hazard of the Sealed Cavern (Valley of the Dragon). Design doc:
// docs/soul-tithe-design.md.
//
// The rules, at the end of each round, in this order:
//
//   1. CALLING. Every Soul Fragment that was already on the field steals Max HP
//      from its owner equal to its current HP, and adds what it stole to its own
//      Max HP and current HP. It cannot be blocked or evaded and it is not damage.
//   2. THE LOCK. A wounded player's Max HP drops to their current HP. What they
//      lost goes into their fragment, which is spawned if they have none.
//
// Destroying a fragment gives its owner back all the stolen Max HP plus the same
// amount of current HP. A KO'd owner gets the Max HP only and stays down.
//
// Max HP never falls below 1. A KO'd player is neither locked nor Called on. Only
// player characters are affected: no guests, no summons. Victory does not need
// the fragments gone; when the fight ends the Max HP comes back and current HP
// stays where it is.
//
// ── Where the state lives ───────────────────────────────────────────────────
//
// An event holds no state (conflict-event-design.md, rule 2).
//
//   - What a player has lost is the Soul-Torn AE on the player: a `max_hp` change
//     plus the total in its flags.
//   - A fragment's HP is the HP on its own token actor. Its rounds are the mark AE
//     on that actor. Its owner never changes, so that one is a token flag.
//
// Both AEs are `directorPermanent` so nothing ticks them, and `conflictScoped`,
// which does two things: the scene-end sweep still removes them, so a battle that
// dies before its teardown cannot leave a player with a shorter HP bar, and a
// rewind restores them whole (a surviving token keeps its flags through a rewind,
// which is why the rounds are not token flags).
//
// The fragment's Max HP is always SET to what its owner has lost, never added to.
// That is the invariant, and it is what makes a re-run after an F5 land correctly.
//
// ── Why this writes HP directly ─────────────────────────────────────────────
//
// Rule 1 of the event system routes DAMAGE through BD's executor so it picks up
// affinity, absorb and the trigger cascade. Calling is explicitly none of those:
// it is not damage, it must not provoke Guard, Cover or an on-damage reaction, and
// a fragment's growth is not a heal. An AE-only Max change notifies nothing, so
// every player write ends in touchActor: the HUD, the banner and Crisis all follow
// `updateActor`.
// ============================================================================

import { registerConflictEvent } from "../conflict-event-registry.js";

const FLAG_NS = "fabula-ultima-companion";

/** `flags.<ns>.conflictObject` on the world actor — how the event finds its template. */
export const FRAGMENT_OBJECT_ID = "soul-fragment";

/** The status on the player. Found by flag; the name is for people. */
export const TORN_AE_NAME = "Soul-Torn";

const ACTION_NAME = "Calling";
const TORN_ICON = "icons/svg/aura.svg";

/**
 * The look of a fragment: its owner's sprite, turned the Sealed Cavern's green.
 * Tint multiplies, so it can only darken: the approved brighter body (FX mockup v12,
 * FRAG_BRIGHT 0.55) is a lighter tint here plus a 1.6x lift that every client puts on
 * the mesh (soul-fx-runtime FRAGMENT_LOOK, which must match these two). Its fire is
 * the glow; there is no blur filter. One place to retune: here and FRAGMENT_LOOK.
 */
const FRAGMENT_TINT = "#a6ff9c";
const FRAGMENT_ALPHA = 0.9;
/** The defeat it plays: the Destroyed show (soul-fx), which the removal waits for. */
const FRAGMENT_DEFEAT_STYLE = "soul_release";
/** Seconds between two players' shows in one beat (the user's "simultaneous with a slight offset"). */
const SHOW_STAGGER_S = 0.18;

/**
 * Where fragments stand, as fractions of the STAGE (token-centre coordinates): on the
 * enemy side, just in front of the enemy line (the user, 2026-11-09: the middle of the
 * stage read as no one's), one slot per player in party order so a fragment keeps its
 * place across rounds and two can never land on one spot. Staggered, because in one
 * column each HP badge sat on the name of the fragment above it. For scale: the enemy
 * zone (formation.js ENEMY_ZONE) ends at x 0.39 and its front lane stands at x 0.28;
 * the party's line starts at x 0.71.
 */
const ANCHORS = [
  { x: 0.33, y: 0.27 },
  { x: 0.40, y: 0.42 },
  { x: 0.33, y: 0.57 },
  { x: 0.40, y: 0.72 },
];

// ── Pure rules (exported for the bare-Node harness) ─────────────────────────

const whole = (v) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? n : 0;
};

/** Nothing can take a player below this much Max HP. */
export const MAX_HP_FLOOR = 1;

/** How much a Calling takes: the fragment's current HP, stopped by the floor. */
export function callingSteal({ fragmentHp, ownerMax } = {}) {
  return Math.min(Math.max(0, whole(fragmentHp)), Math.max(0, whole(ownerMax) - MAX_HP_FLOOR));
}

/**
 * One Calling, start to finish. The stolen amount comes off the owner's Max, and
 * only reaches their current HP if it goes past what they were already missing.
 */
export function resolveCalling({ ownerMax, ownerHp, fragmentHp, fragmentMax } = {}) {
  const stolen = callingSteal({ fragmentHp, ownerMax });
  const nextMax = whole(ownerMax) - stolen;
  return {
    stolen,
    ownerMax: nextMax,
    ownerHp: Math.min(whole(ownerHp), nextMax),
    fragmentHp: whole(fragmentHp) + stolen,
    fragmentMax: whole(fragmentMax) + stolen,
  };
}

/** What the lock takes from a standing player. A KO'd player is not locked. */
export function lockWound({ ownerMax, ownerHp } = {}) {
  const hp = whole(ownerHp);
  if (hp <= 0) return 0;
  return Math.max(0, whole(ownerMax) - Math.max(hp, MAX_HP_FLOOR));
}

/** The owner's HP once their fragment is destroyed. A KO'd owner stays down. */
export function returnedHp({ ownerHp, ownerMax, stolen } = {}) {
  const hp = whole(ownerHp);
  if (hp <= 0) return hp;
  return Math.min(whole(ownerMax), hp + Math.max(0, whole(stolen)));
}

/** A fragment Calls from the round after it appears, once per round. */
export function fragmentMayCall({ spawnRound, calledRound, round } = {}) {
  const r = whole(round);
  return whole(spawnRound) < r && whole(calledRound) !== r;
}

export function fragmentName(ownerName) {
  return `${String(ownerName ?? "").trim() || "Someone"}'s Soul Fragment`;
}

// ── Fragment Eater (2026-11-19, approved by Oni) ────────────────────────────
//
// A few monsters EAT a fragment instead of the party destroying it. An eaten
// fragment pays no refund: what it held stays lost until the battle ends. The
// player's Soul-Torn AE keeps the whole loss (`soulStolen`, its max_hp change)
// and records the eaten part next to it (`soulEaten`), which no fragment holds.
// The invariant becomes: a fragment's Max HP = what its owner has lost − eaten.

/** The reaction trigger every destroyed fragment raises (not the battle-end sweep). */
export const FRAGMENT_DESTROYED_TRIGGER = "soul_fragment_destroyed";

/** What a player's fragment holds: everything they have lost, less what was eaten. */
export function heldLoss({ stolen, eaten } = {}) {
  return Math.max(0, whole(stolen) - Math.max(0, whole(eaten)));
}

/**
 * The round-end re-square (reconcileFragments): a standing fragment's Max is set to
 * what its owner has lost less what was eaten, and its HP moves by the same amount
 * (at least 1, at most the new Max). Null when nothing changes or nothing is held.
 */
export function squareFragment({ hp, max, stolen, eaten } = {}) {
  const held = heldLoss({ stolen, eaten });
  const m = whole(max);
  if (whole(hp) <= 0 || held === m || held <= 0) return null;
  return { hp: Math.max(1, Math.min(whole(hp) + (held - m), held)), max: held };
}

/**
 * A destroyed fragment's refund (returnToOwner + releaseHeld): what comes back, and
 * what stays on the Soul-Torn AE (the eaten part) until the battle ends.
 */
export function refundSplit({ stolen, eaten } = {}) {
  const keep = Math.min(Math.max(0, whole(eaten)), Math.max(0, whole(stolen)));
  return { returned: heldLoss({ stolen, eaten }), keep };
}

/** A fragment can be eaten once it has Called, while it stands and nobody has paid it out. */
export function fragmentMayBeEaten({ hp, calledRound, returned } = {}) {
  return whole(hp) > 0 && whole(calledRound) > 0 && returned !== true;
}

/**
 * Which fragment an eater takes. `list`: [{ id, hp, calledRound, returned, ownerUuid }].
 * `pick` "largest" (by current HP) takes from the whole field; "trigger_subject_owner"
 * only from fragments owned by `ownerUuids` (largest of those). Ties keep field order.
 * Null when nothing is eligible: the action then fails closed.
 */
export function pickFragmentToEat(list, { pick = "largest", ownerUuids = null } = {}) {
  const byOwner = pick === "trigger_subject_owner";
  const owners = new Set(ownerUuids ?? []);
  let best = null;
  for (const f of list ?? []) {
    if (!fragmentMayBeEaten(f)) continue;
    if (byOwner && !owners.has(f.ownerUuid)) continue;
    if (!best || whole(f.hp) > whole(best.hp)) best = f;
  }
  return best;
}

/**
 * One eat. Everything the owner has lost becomes eaten (the eaten fragment held all of
 * it that was not eaten before, and a player has one fragment at most), so it is
 * idempotent: a re-run after an F5 lands on the same numbers. `consumed` is the
 * fragment's current HP, the amount an eater's skill reads (Soul Sever).
 */
export function eatFragment({ stolen, eaten, fragmentHp } = {}) {
  return { eaten: Math.max(whole(eaten), whole(stolen)), consumed: Math.max(0, whole(fragmentHp)) };
}

/**
 * Soul Ripper's wound, locked at once: how much Max HP the target loses. Nothing from
 * a KO'd player, and Max HP never below the floor.
 */
export function titheWoundAmount({ ownerMax, ownerHp, amount } = {}) {
  if (whole(ownerHp) <= 0) return 0;
  return Math.max(0, Math.min(whole(amount), whole(ownerMax) - MAX_HP_FLOOR));
}

// ── Battlefield queries ─────────────────────────────────────────────────────

const propNum = (actor, key) => whole(actor?.system?.props?.[key]);

function isFragmentActor(actor) {
  try { return actor?.flags?.[FLAG_NS]?.conflictObject === FRAGMENT_OBJECT_ID; }
  catch { return false; }
}

function findFragmentTemplate() {
  return game.actors?.find?.((a) => isFragmentActor(a)) ?? null;
}

/** The player characters in this conflict: no rank, no guest, no battlefield object. */
function players(ctx) {
  return (ctx.dCombat?.combatants ?? []).filter((c) => {
    if (c?.side !== "party") return false;
    const actor = c.actorDoc ?? null;
    if (!actor) return false;
    const f = actor.flags?.[FLAG_NS] ?? {};
    if (f.bdGuest || f.bdObject || f.isPersistentSummon) return false;
    const t = c.tokenDoc?.flags?.[FLAG_NS] ?? {};
    if (t.isSummon || t.isPhantasm || t.summonedBy) return false;
    return !String(actor.system?.props?.npc_rank ?? "").trim();
  });
}

function fragmentCombatants(ctx) {
  return (ctx.dCombat?.combatants ?? []).filter((c) => isFragmentActor(c?.actorDoc));
}

function ownerUuidOf(c) {
  return c?.tokenDoc?.flags?.[FLAG_NS]?.soulFragmentOwner ?? null;
}

function markAe(actor) {
  try { return actor?.effects?.find?.((e) => e?.flags?.[FLAG_NS]?.soulFragmentMark === true) ?? null; }
  catch { return null; }
}

function fragmentState(actor) {
  const f = markAe(actor)?.flags?.[FLAG_NS] ?? {};
  return { spawnRound: whole(f.soulSpawnRound), calledRound: whole(f.soulCalledRound), returned: f.soulReturned === true };
}

function tornAe(actor) {
  try { return actor?.effects?.find?.((e) => e?.flags?.[FLAG_NS]?.soulTorn === true) ?? null; }
  catch { return null; }
}

function stolenFrom(actor) {
  return whole(tornAe(actor)?.flags?.[FLAG_NS]?.soulStolen);
}

/** The eaten part of what `actor` has lost (Fragment Eater): held by no fragment. */
function eatenFrom(actor) {
  return whole(tornAe(actor)?.flags?.[FLAG_NS]?.soulEaten);
}

/** What `actor`'s fragment should hold: the loss less the eaten part. */
function heldFrom(actor) {
  return heldLoss({ stolen: stolenFrom(actor), eaten: eatenFrom(actor) });
}

/** The standing, unpaid fragment of a player (an eaten one waiting for removal is not). */
function liveFragmentOf(ctx, ownerUuid) {
  return fragmentCombatants(ctx).find((c) => ownerUuidOf(c) === ownerUuid
    && propNum(c.actorDoc, "current_hp") > 0
    && markAe(c.actorDoc)?.flags?.[FLAG_NS]?.soulReturned !== true) ?? null;
}

// ── Writes ──────────────────────────────────────────────────────────────────

function tornChange(total) {
  return { key: "max_hp", mode: 2, value: String(-total), priority: 20 };
}

function tornAeData(total) {
  return {
    name: TORN_AE_NAME,
    img: TORN_ICON,
    transfer: false,
    disabled: false,
    description: "Part of this soul is held by a Soul Fragment. Destroy the fragment to take it back.",
    changes: [tornChange(total)],
    flags: {
      [FLAG_NS]: {
        soulTorn: true,
        soulStolen: total,
        // Never ticked, never reseeded; the event owns it. conflictScoped is what
        // keeps the scene-end sweep able to remove it anyway (isTransientAE).
        directorPermanent: true,
        conflictScoped: true,
      },
    },
  };
}

/** Add to what `actor` has lost. The AE is one per player and holds the total. */
async function addStolen(actor, amount) {
  if (amount <= 0) return;
  const ae = tornAe(actor);
  if (!ae) {
    await actor.createEmbeddedDocuments("ActiveEffect", [tornAeData(amount)]);
    return;
  }
  const total = stolenFrom(actor) + amount;
  await ae.update({ changes: [tornChange(total)], [`flags.${FLAG_NS}.soulStolen`]: total });
}

async function clearTorn(actor) {
  const ae = tornAe(actor);
  if (ae) await ae.delete();
}

/**
 * A destroyed fragment's refund: give back what it held. With nothing eaten that is
 * the whole Soul-Torn (the original behaviour); with an eaten part, the AE stays and
 * keeps exactly that part until the battle ends.
 */
async function releaseHeld(actor) {
  const ae = tornAe(actor);
  if (!ae) return;
  const { keep: eaten } = refundSplit({ stolen: stolenFrom(actor), eaten: eatenFrom(actor) });
  if (eaten <= 0) { await ae.delete(); return; }
  await ae.update({ changes: [tornChange(eaten)], [`flags.${FLAG_NS}.soulStolen`]: eaten, [`flags.${FLAG_NS}.soulEaten`]: eaten });
}

/** Book an eat on the owner's ledger. Idempotent (eatFragment), so a re-run is safe. */
async function bookEaten(actor) {
  const ae = tornAe(actor);
  if (!ae) return 0;
  const { eaten } = eatFragment({ stolen: stolenFrom(actor), eaten: eatenFrom(actor), fragmentHp: 0 });
  if (eaten !== eatenFrom(actor)) await ae.update({ [`flags.${FLAG_NS}.soulEaten`]: eaten });
  return eaten;
}

/**
 * Tell the world this actor's Max HP moved. An AE change fires no updateActor, and
 * the HUD's Max, the banner and Crisis all listen for it. `diff: false` sends it
 * even though the value is unchanged.
 */
async function touchActor(actor) {
  await actor.update({ "system.props.current_hp": propNum(actor, "current_hp") }, { diff: false });
}

async function setFragmentHp(c, hp, max) {
  await c.actorDoc.update({ "system.props.max_hp": max, "system.props.current_hp": hp });
}

function markAeData(round) {
  return {
    name: "Soul Fragment",
    img: TORN_ICON,
    transfer: false,
    disabled: false,
    changes: [],
    flags: {
      [FLAG_NS]: {
        soulFragmentMark: true,
        soulSpawnRound: round,
        soulCalledRound: 0,
        soulReturned: false,
        directorPermanent: true,
        conflictScoped: true,
      },
    },
  };
}

async function spawnFragment(ctx, owner, slot, amount, round, { hold = false } = {}) {
  const template = findFragmentTemplate();
  if (!template) {
    ctx.warn(`no world actor is flagged conflictObject "${FRAGMENT_OBJECT_ID}" — ${owner.actorDoc?.name} gets no fragment`);
    return null;
  }
  const { spawnLiveDirectorTokens } = await import("../../battle-director/director-init.js");
  const { stageOf } = await import("../../battle-director/director-camera.js");
  const stage = stageOf(ctx.scene);
  const frac = ANCHORS[slot % ANCHORS.length];
  const anchor = { x: stage.x + stage.w * frac.x, y: stage.y + stage.h * frac.y };
  const name = fragmentName(owner.actorDoc?.name);
  const ownerTexture = owner.tokenDoc?.texture ?? owner.actorDoc?.prototypeToken?.texture ?? null;
  const ownerSprite = owner.actorDoc?.system?.props?.sprite_battle || ownerTexture?.src || "";
  const look = {
    alpha: FRAGMENT_ALPHA,
    texture: {
      tint: FRAGMENT_TINT,
      ...(ownerTexture?.src ? { src: ownerTexture.src, scaleX: -Math.abs(ownerTexture.scaleX ?? 1), scaleY: ownerTexture.scaleY ?? 1 } : {}),
    },
  };
  const [tokenDoc] = await spawnLiveDirectorTokens({
    // exactCenter: the enemy formation would otherwise pick the spot and ignore the slot.
    scene: ctx.scene, actorUuids: [template.uuid], disposition: -1, exactCenter: anchor,
    // Born in its owner's look and, with an audience, hidden on every client until its
    // own arrival shows it. The hold is a server-time deadline, so an F5 or a missed
    // broadcast only delays it; nothing has to clear it.
    tokenData: {
      ...look,
      flags: { [FLAG_NS]: { soulFragment: true, ...(hold ? { soulFxHoldUntil: serverTime() + 9000 } : {}) } },
    },
  });
  if (!tokenDoc) { ctx.warn("fragment spawn produced no token"); return null; }

  await tokenDoc.update({
    name,
    alpha: FRAGMENT_ALPHA,
    "texture.tint": FRAGMENT_TINT,
    ...(ownerTexture?.src ? {
      "texture.src": ownerTexture.src,
      // Negative: it stands on the enemy side, so it faces the party.
      "texture.scaleX": -Math.abs(ownerTexture.scaleX ?? 1),
      "texture.scaleY": ownerTexture.scaleY ?? 1,
    } : {}),
    // The pin has to be a token flag as well as on the combatant:
    // _resetRoundCounters recomputes turnsPerRound every round and after a reload.
    [`flags.${FLAG_NS}.turnsPerRound`]: 0,
    [`flags.${FLAG_NS}.soulFragment`]: true,
    [`flags.${FLAG_NS}.soulFragmentOwner`]: owner.actorDoc.uuid,
    [`flags.${FLAG_NS}.conflictSpawned`]: true,
  });
  await tokenDoc.actor.update({
    name,
    ...(owner.actorDoc?.img ? { img: owner.actorDoc.img } : {}),
    "system.props.max_hp": amount,
    "system.props.current_hp": amount,
    "system.props.default_facing_direction": owner.actorDoc?.system?.props?.default_facing_direction ?? "left",
    ...(ownerSprite ? { "system.props.sprite_battle": ownerSprite, "system.props.sprite_standard": ownerSprite } : {}),
    [`flags.${FLAG_NS}.defeatStyle`]: FRAGMENT_DEFEAT_STYLE,
  });
  await tokenDoc.actor.createEmbeddedDocuments("ActiveEffect", [markAeData(round)]);
  const c = ctx.dCombat.addCombatant({ tokenDoc, actorDoc: tokenDoc.actor, side: "enemy", disposition: -1 });
  c.turnsPerRound = 0;
  c.turnsRemaining = 0;
  ctx.log(`${name} spawned at ${amount} HP`);
  return c;
}

async function refreshRoster(ctx) {
  try {
    const { refreshTurnActions } = await import("../../battle-director/director-round-banner.js");
    refreshTurnActions?.(ctx.dCombat);
  } catch (e) { ctx.warn("banner refresh threw", e); }
  try { Hooks.callAll("fu-director-roster-changed", { dCombat: ctx.dCombat, change: "add" }); } catch { /* observers only */ }
}

async function removeFragment(ctx, c) {
  const td = c?.tokenDoc ?? null;
  if (!td) return;
  try {
    const res = await globalThis.FUCompanion?.api?.experimental?.battleDirector?.removeCombatant?.({ tokenUuid: td.uuid });
    if (res?.ok) return;
  } catch (e) { ctx.warn("removeCombatant threw — deleting the token directly", e); }
  try {
    if (td.parent?.tokens?.get?.(td.id)) await td.parent.deleteEmbeddedDocuments("Token", [td.id]);
  } catch (e) { ctx.warn(`could not delete fragment token ${td.id}`, e); }
}

/**
 * Tokens left on the scene by a fight that ended without its teardown, and the
 * Soul-Torn left on the players by the same fight.
 */
async function sweepLeftovers(ctx) {
  try {
    const ids = (ctx.scene?.tokens?.contents ?? [])
      .filter((td) => isFragmentActor(td.actor))
      .map((td) => td.id);
    if (ids.length) await ctx.scene.deleteEmbeddedDocuments("Token", ids);
  } catch (e) { ctx.warn("stray fragment sweep threw", e); }
  for (const p of players(ctx)) {
    try { await clearTorn(p.actorDoc); }
    catch (e) { ctx.warn(`could not clear ${TORN_AE_NAME} from ${p.actorDoc?.name}`, e); }
  }
}

/**
 * A fragment at 0 HP whose token survived (auto-defeat off, a sim's lean mode) or
 * that reached 0 with no HP event at all. The owner still gets it back.
 */
async function sweepDestroyed(ctx) {
  for (const c of fragmentCombatants(ctx)) {
    // Refunded already and somehow standing again (healed during its defeat
    // animation): its loss was paid back, so it has nothing left to hold.
    const f = markAe(c.actorDoc)?.flags?.[FLAG_NS] ?? {};
    const refunded = f.soulReturned === true;
    if (propNum(c.actorDoc, "current_hp") > 0 && !refunded) continue;
    if (f.soulEatenAt != null) {
      // Eaten, and an F5 cut the eat short: finish it. No refund, ever.
      const owner = players(ctx).find((p) => p.actorDoc?.uuid === ownerUuidOf(c));
      if (owner) await bookEaten(owner.actorDoc);
      await announceDestroyed(ctx, c.actorDoc, c.tokenDoc, { cause: "eaten", fragmentHp: whole(f.soulEatenHp) });
    } else {
      await announceDestroyed(ctx, c.actorDoc, c.tokenDoc, { cause: "destroyed" });
      await returnToOwner(ctx, c.actorDoc, c.tokenDoc);
    }
    await removeFragment(ctx, c);
  }
}

/**
 * B1: raise `soul_fragment_destroyed` once for this fragment, to every combatant's
 * reactions (Soul Siphon). Every way a fragment leaves the field calls it, except the
 * battle-end and conflict-start sweeps. Once-only through the mark (a rewind restores
 * the mark from before the kill, so a replayed kill fires again, as it should).
 * The fragment's token must still be on the scene.
 */
async function announceDestroyed(ctx, fragActor, tokenDoc, { cause = "destroyed", fragmentHp = null, causeActor = null } = {}) {
  try {
    const mark = markAe(fragActor);
    if (mark?.flags?.[FLAG_NS]?.soulDestroyedFired === true) return;
    await mark?.update({ [`flags.${FLAG_NS}.soulDestroyedFired`]: true });
    const ownerUuid = tokenDoc?.flags?.[FLAG_NS]?.soulFragmentOwner ?? null;
    const owner = players(ctx).find((p) => p.actorDoc?.uuid === ownerUuid) ?? null;
    const hp = fragmentHp == null ? Math.max(0, propNum(fragActor, "current_hp")) : whole(fragmentHp);
    const max = Math.max(0, propNum(fragActor, "max_hp"));
    const { emitBattlefieldObjectTrigger } = await import("../../battle-director/defeat-reactor.js");
    await emitBattlefieldObjectTrigger(ctx.director, {
      trigger: FRAGMENT_DESTROYED_TRIGGER,
      actor: fragActor,
      tokenDoc,
      payload: {
        cause,
        causeActorUuid: causeActor?.uuid ?? null,
        ownerActorUuid: ownerUuid,
        ownerTokenUuid: owner?.tokenDoc?.uuid ?? null,
        fragmentHp: hp,
        fragmentMaxHp: max,
        // TRIGGER_AMOUNT reads `amount`: the size of the soul it held.
        amount: max,
        // VAR_FRAGMENT_HP / VAR_FRAGMENT_MAX_HP in the reaction's formulas.
        _chainVars: { fragment_hp: hp, fragment_max_hp: max },
      },
    });
    ctx.log(`${fragActor?.name} ${cause} — ${FRAGMENT_DESTROYED_TRIGGER} raised (HP ${hp}/${max})`);
  } catch (e) {
    ctx.warn(`${fragActor?.name}: ${FRAGMENT_DESTROYED_TRIGGER} threw — the conflict continues without it`, e);
  }
}

/**
 * Fragment tokens on the scene that this conflict's roster does not hold: an F5
 * landed after the spawn and before the save. Take them back rather than delete
 * them, because the owner's loss may already be written against them.
 */
async function adoptStrayFragments(ctx) {
  const known = new Set(fragmentCombatants(ctx).map((c) => c.tokenDoc?.id));
  for (const td of ctx.scene?.tokens?.contents ?? []) {
    if (!isFragmentActor(td.actor) || known.has(td.id)) continue;
    // Spawning takes several writes. One cut short has no owner or no mark, and the
    // loss is written only after a spawn finishes, so it owes nobody anything.
    if (!td.flags?.[FLAG_NS]?.soulFragmentOwner || !markAe(td.actor)) {
      try { await ctx.scene.deleteEmbeddedDocuments("Token", [td.id]); }
      catch (e) { ctx.warn(`could not delete half-spawned fragment ${td.id}`, e); }
      continue;
    }
    const c = ctx.dCombat.addCombatant({ tokenDoc: td, actorDoc: td.actor, side: "enemy", disposition: -1 });
    c.turnsPerRound = 0;
    c.turnsRemaining = 0;
    ctx.log(`${td.name} taken back onto the roster`);
  }
}

/**
 * Put every fragment's Max back on what its owner has actually lost, and move its HP
 * by the same amount. An F5 between a player's write and their fragment's leaves the
 * two apart; this is what closes it. On a normal round it changes nothing.
 */
async function reconcileFragments(ctx) {
  for (const c of fragmentCombatants(ctx)) {
    const hp = propNum(c.actorDoc, "current_hp");
    if (hp <= 0) continue;
    const owner = players(ctx).find((p) => p.actorDoc?.uuid === ownerUuidOf(c));
    if (!owner) continue;
    // Max is written before HP, so an F5 between them leaves the owner above their bar.
    const ownerMax = propNum(owner.actorDoc, "max_hp");
    if (propNum(owner.actorDoc, "current_hp") > ownerMax) {
      ctx.warn(`${owner.actorDoc.name} stood above their Max; corrected`);
      await owner.actorDoc.update({ "system.props.current_hp": ownerMax });
    }
    const max = propNum(c.actorDoc, "max_hp");
    // What the fragment should hold: the loss less what was eaten (Fragment Eater).
    const sq = squareFragment({ hp, max, stolen: stolenFrom(owner.actorDoc), eaten: eatenFrom(owner.actorDoc) });
    if (!sq) continue;
    ctx.warn(`${c.actorDoc.name} held ${max} but ${owner.actorDoc.name} has lost ${sq.max} (not counting eaten); corrected`);
    await setFragmentHp(c, sq.hp, sq.max);
  }
}

/** Persist the roster and HP now, so an F5 from here on resumes with them. */
async function saveNow(ctx) {
  try {
    const { saveDirectorState } = await import("../../battle-director/persistence.js");
    await saveDirectorState(ctx.director, { skipHistory: true });
  } catch (e) { ctx.warn("could not save after the round-end beat", e); }
}

// ── Presentation ────────────────────────────────────────────────────────────

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const serverTime = () => { try { return game.time.serverTime; } catch { return Date.now(); } };

/** Will anyone see the show: this window, or another client's. */
async function watched() {
  try {
    const { shouldRender, hasOtherViewers } = await import("../../battle-director/presentation-clock.js");
    return shouldRender() || hasOtherViewers();
  } catch { return false; }
}

/**
 * Start a show on every client (soul-fx-runtime) and return its clock:
 * { at(i, s), done, T } — or null when nobody watches, and the rules then run at
 * once as before. Skip the show, never the rules.
 */
async function present(ctx, kind, items) {
  try {
    if (!items.length) return null;
    const fx = await import("../soul-fx/soul-fx-runtime.js");
    const { TITHE, CALLING, DESTROY } = await import("../soul-fx/soul-fx-effects.js");
    const clock = fx.presentSoulFx({ kind, sceneId: ctx.scene?.id ?? null, items });
    return clock ? { ...clock, T: { TITHE, CALLING, DESTROY } } : null;
  } catch (e) {
    ctx.warn(`the ${kind} show threw — the rules run without it`, e);
    return null;
  }
}

async function showing() {
  try {
    const { shouldRender } = await import("../../battle-director/presentation-clock.js");
    return shouldRender();
  } catch { return false; }
}

/** The action namecard every skill uses. Skip the show, never the rules. */
async function announceCalling(ctx) {
  try {
    if (!await showing()) return;
    const render = globalThis.FUCompanion?.api?.namecardBroadcast;
    if (typeof render !== "function") return;
    const { buildActionNamecardOptions } = await import("../../battle-director/director-vfx.js");
    const { options } = await buildActionNamecardOptions({ kind: "Skill", skillName: ACTION_NAME });
    options.iconOverride = "👻";
    Promise.resolve(render({ title: ACTION_NAME, options })).catch(() => {});
    await wait((Number(options.inMs) || 350) + (Number(options.holdMs) || 1400));
  } catch (e) {
    ctx.warn("announcement threw — Calling still resolves", e);
  }
}

// ── The beats ───────────────────────────────────────────────────────────────

async function runCallings(ctx, round) {
  const callers = [];
  for (const c of fragmentCombatants(ctx)) {
    if (propNum(c.actorDoc, "current_hp") <= 0) continue;
    if (!markAe(c.actorDoc)) continue;
    const st = fragmentState(c.actorDoc);
    if (!fragmentMayCall({ spawnRound: st.spawnRound, calledRound: st.calledRound, round })) continue;
    const owner = players(ctx).find((p) => p.actorDoc?.uuid === ownerUuidOf(c));
    if (!owner || propNum(owner.actorDoc, "current_hp") <= 0) continue;
    callers.push({ c, owner });
  }
  if (!callers.length) return;

  await announceCalling(ctx);
  // One namecard, then every tether together, each steal written as its first bead lands.
  const show = await present(ctx, "calling", callers.map(({ c, owner }, i) => ({
    ownerTokenId: owner.tokenDoc?.id, fragTokenId: c.tokenDoc?.id, delay: i * SHOW_STAGGER_S,
  })));
  for (let i = 0; i < callers.length; i++) {
    const { c, owner } = callers[i];
    if (show) await show.at(i, show.T.CALLING.WRITE);
    const actor = owner.actorDoc;
    const r = resolveCalling({
      ownerMax: propNum(actor, "max_hp"),
      ownerHp: propNum(actor, "current_hp"),
      fragmentHp: propNum(c.actorDoc, "current_hp"),
      fragmentMax: propNum(c.actorDoc, "max_hp"),
    });
    // The stamp first: an F5 inside these writes cannot steal twice, and
    // reconcileFragments squares the two sides on the re-run.
    await markAe(c.actorDoc)?.update({ [`flags.${FLAG_NS}.soulCalledRound`]: round });
    if (r.stolen <= 0) continue;
    await addStolen(actor, r.stolen);
    await actor.update({ "system.props.current_hp": r.ownerHp }, { diff: false });
    await setFragmentHp(c, r.fragmentHp, heldFrom(actor));
    ctx.log(`${c.actorDoc.name} Calls — steals ${r.stolen}, ${actor.name} is ${r.ownerHp}/${r.ownerMax}, fragment ${r.fragmentHp}/${r.fragmentMax}`);
  }
  if (show) await show.done;
}

async function runLock(ctx, round) {
  const party = players(ctx);
  const audience = await watched();
  const locks = [];
  let spawned = false;
  for (let slot = 0; slot < party.length; slot++) {
    const owner = party[slot];
    const actor = owner.actorDoc;
    const wound = lockWound({ ownerMax: propNum(actor, "max_hp"), ownerHp: propNum(actor, "current_hp") });
    if (wound <= 0) continue;

    // The fragment first: a player must never lose Max HP to something that is not
    // on the field to be destroyed. Spawns stay one at a time.
    let frag = liveFragmentOf(ctx, actor.uuid);
    const isNew = !frag;
    if (isNew) {
      frag = await spawnFragment(ctx, owner, slot, heldFrom(actor) + wound, round, { hold: audience });
      if (!frag) continue;
      spawned = true;
    }
    locks.push({ owner, actor, wound, frag, isNew });
  }
  // The show: every tear a beat after the last, in party order, and each player's
  // loss written at their own tear, so the bar drops with the soul leaving.
  const show = audience ? await present(ctx, "tithe", locks.map((l, i) => ({
    ownerTokenId: l.owner.tokenDoc?.id, fragTokenId: l.frag.tokenDoc?.id, merge: !l.isNew, delay: i * SHOW_STAGGER_S,
  }))) : null;
  for (let i = 0; i < locks.length; i++) {
    const { actor, wound, frag, isNew } = locks[i];
    if (show) await show.at(i, show.T.TITHE.TEAR);
    await addStolen(actor, wound);
    await touchActor(actor);
    const max = heldFrom(actor);
    const hp = isNew ? max : Math.min(propNum(frag.actorDoc, "current_hp") + wound, max);
    await setFragmentHp(frag, hp, max);
    ctx.log(`${actor.name} locked — lost ${wound} Max HP, now ${propNum(actor, "current_hp")}/${propNum(actor, "max_hp")}`);
  }
  if (spawned) await refreshRoster(ctx);
  if (show) await show.done;
}

/**
 * Whether the player stands in Crisis once the refund lands. Max comes back in two
 * steps, so the order of those steps decides whether anything flickers on the way.
 */
function endsInCrisis(hp, nextMax) {
  return hp > 0 && hp <= Math.ceil(nextMax / 2);
}

/**
 * A fragment went to 0: its owner gets it all back. Once, however many hits landed,
 * and it can finish after an F5. The mark records the HP before and after, worked out
 * once, and says when the refund is done. A re-run pays only if the owner's HP has not
 * moved since: anything that has happened to them in between stands, so it can neither
 * heal them twice nor raise someone who has since been KO'd.
 */
async function returnToOwner(ctx, fragActor, tokenDoc, firedKeys = null) {
  const key = `soul-return:${tokenDoc?.id}`;
  if (firedKeys?.has?.(key)) return;
  firedKeys?.add?.(key);

  const ownerUuid = tokenDoc?.flags?.[FLAG_NS]?.soulFragmentOwner ?? null;
  const owner = players(ctx).find((p) => p.actorDoc?.uuid === ownerUuid);
  if (!owner) { ctx.warn(`${fragActor?.name} destroyed but its owner ${ownerUuid} is not in this conflict`); return; }

  const actor = owner.actorDoc;
  const mark = markAe(fragActor);
  const f = mark?.flags?.[FLAG_NS] ?? {};
  if (f.soulRefundDone === true) return;
  // An eaten fragment pays nothing (Fragment Eater); its eat marks it done anyway.
  if (f.soulEatenAt != null) return;
  const resuming = Number.isFinite(f.soulRefundHp);
  if (!resuming && !tornAe(actor)) return;

  // What the fragment held: an eaten part stays lost until the battle ends.
  const stolen = heldFrom(actor);
  const nextMax = propNum(actor, "max_hp") + stolen;
  const now = propNum(actor, "current_hp");
  const from = resuming ? f.soulRefundFrom : now;
  const target = resuming ? f.soulRefundHp : returnedHp({ ownerHp: now, ownerMax: nextMax, stolen });
  const hp = now === from ? target : now;
  await mark?.update({
    [`flags.${FLAG_NS}.soulReturned`]: true,
    [`flags.${FLAG_NS}.soulRefundFrom`]: from,
    [`flags.${FLAG_NS}.soulRefundHp`]: target,
  });

  // Each order is right for one ending, and wrong for the other. Max first leaves a
  // player who ends clear of Crisis at their old HP under the full bar for a moment,
  // which is Crisis: the status lands and anything listening fires, for someone being
  // healed. HP first takes a player who ends in Crisis out of it and back in again.
  if (endsInCrisis(hp, nextMax)) {
    await releaseHeld(actor);
    await actor.update({ "system.props.current_hp": hp }, { diff: false });
  } else {
    await actor.update({ "system.props.current_hp": hp }, { diff: false });
    await releaseHeld(actor);
    await touchActor(actor);
  }
  await mark?.update({ [`flags.${FLAG_NS}.soulRefundDone`]: true });
  ctx.log(`${fragActor?.name} destroyed — ${actor.name} recovers ${stolen}, now ${hp}/${propNum(actor, "max_hp")}`);
}

// ── The event ───────────────────────────────────────────────────────────────

registerConflictEvent({
  id: "soul-tithe",
  label: "Soul Tithe",
  description:
    "At the end of each round a wounded player's Max HP drops to their current HP, and the loss " +
    "forms their Soul Fragment on the enemy side. Each round it survives, a fragment steals Max HP " +
    "equal to its current HP and gains that much HP. Destroying it returns the Max HP and the same " +
    "amount of current HP.",

  ruling: {
    color: "#4fbf7a",
    line: "Wounds become Soul Fragments at round's end. Destroy them to recover.",
    pages: [
      { image: "", text: "At the end of each round, a wounded player's **Max HP drops to their current HP**. What they lost forms their **Soul Fragment** on the enemy side." },
      { image: "", text: `Each round a fragment survives, it uses **${ACTION_NAME}**: it steals Max HP equal to its current HP and gains that much HP. Damage it to slow the theft.` },
      { image: "", text: "**Destroy a fragment** to return all the stolen Max HP to its owner, along with the same amount of HP." },
    ],
  },

  // A conflict inherited from a battle-end follow-up, or one after a crash, must
  // not start with a stale fragment or a stale Soul-Torn.
  async onConflictStart(ctx) {
    for (const c of fragmentCombatants(ctx)) await removeFragment(ctx, c);
    await sweepLeftovers(ctx);
  },

  async onRoundEnd(ctx) {
    const dc = ctx.dCombat;
    if (!dc || dc.ended) return;
    const round = Number(dc.round) || 0;
    await adoptStrayFragments(ctx);
    await sweepDestroyed(ctx);
    await reconcileFragments(ctx);
    await runCallings(ctx, round);
    await runLock(ctx, round);
    await saveNow(ctx);
  },

  async onObjectDestroyed(ctx, { actor, tokenDoc, firedKeys }) {
    if (!isFragmentActor(actor)) return;
    // The claim is taken here, whichever way it pays, so a multi-hit kill plays once.
    const key = `soul-return:${tokenDoc?.id}`;
    if (firedKeys?.has?.(key)) return;
    firedKeys?.add?.(key);
    // Fragment Eater B1: every combatant hears it now, while the token still stands
    // (Soul Siphon's MP lands the moment the fragment dies).
    await announceDestroyed(ctx, actor, tokenDoc, { cause: "destroyed" });
    // Watched: the Destroyed show plays and the refund lands with its first flamelet.
    // Not awaited: the action's settle goes on, and the removal waits for the show (its
    // defeat style). An F5 before the payment leaves a 0 HP fragment on the field,
    // which the round-end sweep pays out of, so nothing is lost.
    const ownerUuid = tokenDoc?.flags?.[FLAG_NS]?.soulFragmentOwner ?? null;
    const owner = players(ctx).find((p) => p.actorDoc?.uuid === ownerUuid);
    const show = owner?.tokenDoc?.id && tokenDoc?.id && (await watched())
      ? await present(ctx, "destroy", [{ ownerTokenId: owner.tokenDoc.id, fragTokenId: tokenDoc.id }])
      : null;
    if (!show) { await returnToOwner(ctx, actor, tokenDoc, null); return; }
    // By the first flamelet the documents may have moved on: a round end can sweep (and
    // pay out of) the 0 HP fragment first, and an unlinked token's actor is rebuilt on
    // every token update. So pay from the LIVE token and actor; a token that is gone was
    // already paid by whoever removed it (the sweep, the conflict end).
    show.at(0, show.T.DESTROY.FIRST)
      .then(() => {
        const live = tokenDoc?.parent?.tokens?.get?.(tokenDoc.id) ?? null;
        if (!live?.actor) { ctx.log(`${actor?.name}: gone before its first flamelet — already paid by the sweep`); return; }
        return returnToOwner(ctx, live.actor, live, null);
      })
      .catch((e) => ctx.warn(`${actor?.name}: the refund after the show threw — the round-end sweep pays it`, e));
  },

  actions: {
    /**
     * Every fragment destroyed at once — a boss's hold on the souls breaking (Nidhogg's
     * fall: his Boss Cycle's onDown, boss-rules/boss-cycle.js; design doc §2b). The ordinary destroy:
     * each owner gets the stolen Max HP back plus the same HP, with the Destroyed show's
     * first flamelet when anyone watches, at once when nobody does. Resolves once every
     * refund is paid and every fragment is off the field (the show is ~2.4 s).
     */
    async destroyAllFragments(ctx) {
      const frags = fragmentCombatants(ctx);
      if (!frags.length) return;
      const pl = players(ctx);
      const rows = frags.map((c) => ({ c, owner: pl.find((p) => p.actorDoc?.uuid === ownerUuidOf(c)) ?? null }));
      const shown = rows.filter((r) => r.owner?.tokenDoc?.id && r.c.tokenDoc?.id);
      // B1: each one is a destroyed fragment (not the battle-end sweep).
      for (const r of rows) {
        const f = markAe(r.c.actorDoc)?.flags?.[FLAG_NS] ?? {};
        if (f.soulEatenAt != null) {
          // An eat an F5 cut short: finish it (no refund; returnToOwner skips it).
          if (r.owner) await bookEaten(r.owner.actorDoc);
          await announceDestroyed(ctx, r.c.actorDoc, r.c.tokenDoc, { cause: "eaten", fragmentHp: whole(f.soulEatenHp) });
          continue;
        }
        await announceDestroyed(ctx, r.c.actorDoc, r.c.tokenDoc, { cause: "destroyed" });
      }
      const show = shown.length && (await watched())
        ? await present(ctx, "destroy", shown.map((r, i) => ({ ownerTokenId: r.owner.tokenDoc.id, fragTokenId: r.c.tokenDoc.id, delay: i * 0.08 })))
        : null;
      // Pay from the LIVE token and actor (an unlinked token's actor is rebuilt on every update).
      const pay = (c) => {
        const td = c.tokenDoc, live = td?.parent?.tokens?.get?.(td.id) ?? null;
        return live?.actor ? returnToOwner(ctx, live.actor, live, null) : null;
      };
      const paid = rows.map((r) => {
        const i = shown.indexOf(r);
        const when = show && i >= 0 ? show.at(i, show.T.DESTROY.FIRST) : Promise.resolve();
        return when.then(() => pay(r.c)).catch((e) => ctx.warn(`${r.c.actorDoc?.name}: the refund threw`, e));
      });
      await Promise.all(paid);
      // Off the field before the fall's black (a slow local draw must not keep them standing in it).
      if (show) await Promise.race([show.done.catch(() => {}), wait((show.T.DESTROY.END + shown.length * 0.08 + 0.3) * 1000)]);
      for (const r of rows) await removeFragment(ctx, r.c);
      ctx.log(`every Soul Fragment destroyed (${rows.length})`);
      await saveNow(ctx);
    },

    /**
     * Fragment Eater (B2/B4): a monster eats one Soul Fragment. Effect row:
     *   { effect_kind: "conflict_event_action", conflict_action: "consumeFragment",
     *     conflict_pick: "largest" | "trigger_subject_owner", target_ref: ... }
     * `largest`: the eligible fragment with the most current HP on the field (Devour
     * Soul, Soul Sever). `trigger_subject_owner`: the fragment of the player(s) that
     * target_ref names (Beheading: the beheaded player; a KO'd owner is fine). With
     * conflict_pick blank it is read from target_ref: a fragment token is eaten itself,
     * a player's is theirs, anything else (self) means largest.
     * Only a fragment that has Called at least once can be eaten. No refund: the owner's
     * loss stays, booked as eaten, until the battle ends. Its current HP is left on the
     * chain as VAR_CONSUMED_FRAGMENT_HP (0 when nothing was eaten, so later rows gate on
     * `VAR_CONSUMED_FRAGMENT_HP > 0`). Raises soul_fragment_destroyed. Returns false (the
     * row applies nothing) when no fragment is eligible.
     */
    async consumeFragment(ctx, { tokens = [], row = {}, effectCtx = null } = {}) {
      const setVar = (v) => {
        if (!effectCtx) return;
        if (!effectCtx.payload) effectCtx.payload = {};
        if (!effectCtx.payload._chainVars) effectCtx.payload._chainVars = {};
        effectCtx.payload._chainVars.consumed_fragment_hp = v;
      };
      setVar(0);
      const tokenActor = (t) => t?.actor ?? t?.document?.actor ?? null;
      const tokenId = (t) => t?.id ?? t?.document?.id ?? null;
      const named = new Set((tokens ?? []).map(tokenId).filter(Boolean));
      let ownerUuids = (tokens ?? []).map((t) => tokenActor(t)?.uuid).filter(Boolean);
      const frags = fragmentCombatants(ctx);
      const pl = players(ctx);

      let pick = String(row?.conflict_pick ?? "").trim().toLowerCase();
      if (pick === "target_owner" || pick === "owner") pick = "trigger_subject_owner";
      let only = null;
      if (!pick) {
        const hit = frags.filter((c) => named.has(c.tokenDoc?.id));
        if (hit.length) { only = new Set(hit.map((c) => c.tokenDoc.id)); pick = "largest"; }
        else if (pl.some((p) => ownerUuids.includes(p.actorDoc?.uuid))) pick = "trigger_subject_owner";
        else pick = "largest";
      }
      if (pick === "trigger_subject_owner" && !ownerUuids.length) {
        // No target_ref tokens: fall back to the trigger's own subject.
        const p = effectCtx?.payload ?? {};
        ownerUuids = [p.subjectActorUuid, p.sourceActorUuid, p.targetActorUuid].filter(Boolean);
      }

      const list = frags
        .filter((c) => !only || only.has(c.tokenDoc?.id))
        .map((c) => {
          const st = fragmentState(c.actorDoc);
          return { c, id: c.tokenDoc?.id, ownerUuid: ownerUuidOf(c), hp: propNum(c.actorDoc, "current_hp"), calledRound: st.calledRound, returned: st.returned || !markAe(c.actorDoc) };
        });
      const chosen = pickFragmentToEat(list, { pick, ownerUuids });
      if (!chosen) {
        ctx.log(`consumeFragment (${pick}): no fragment that has Called is there to eat`);
        return false;
      }

      const { c, hp } = chosen;
      const round = Number(ctx.dCombat?.round) || 0;
      // The mark first: from here no path pays a refund for it, and an F5 before the
      // removal is finished by the round-end sweep (bookEaten is idempotent).
      await markAe(c.actorDoc)?.update({
        [`flags.${FLAG_NS}.soulEatenAt`]: round,
        [`flags.${FLAG_NS}.soulEatenHp`]: hp,
        [`flags.${FLAG_NS}.soulReturned`]: true,
        [`flags.${FLAG_NS}.soulRefundDone`]: true,
      });
      const owner = pl.find((p) => p.actorDoc?.uuid === chosen.ownerUuid) ?? null;
      if (owner) await bookEaten(owner.actorDoc);
      setVar(hp);
      await announceDestroyed(ctx, c.actorDoc, c.tokenDoc, {
        cause: "eaten", fragmentHp: hp, causeActor: effectCtx?.casterActor ?? effectCtx?.reactorActor ?? null,
      });
      await removeFragment(ctx, c);
      ctx.log(`${c.actorDoc?.name} eaten at ${hp} HP — no refund; ${owner?.actorDoc?.name ?? "its owner"} has ${owner ? eatenFrom(owner.actorDoc) : "?"} eaten until the battle ends`);
      await saveNow(ctx);
      return true;
    },

    /**
     * Soul Ripper (B3): the wound is locked at once. Effect row:
     *   { effect_kind: "conflict_event_action", conflict_action: "titheWound",
     *     conflict_amount: "HP_LOST", target_ref: <the player hit> }
     * Each player target loses that much Max HP now (floor 1; a KO'd player gets no
     * lock), and it goes into their fragment, spawned if they have none (a new one does
     * not Call until next round, as at the round end). Not a player: nothing.
     */
    async titheWound(ctx, { tokens = [], amount = 0 } = {}) {
      const want = whole(amount);
      if (want <= 0) return false;
      const party = players(ctx);
      const round = Number(ctx.dCombat?.round) || 0;
      const audience = await watched();
      let any = false;
      let spawned = false;
      for (const t of tokens ?? []) {
        const uuid = (t?.actor ?? t?.document?.actor)?.uuid ?? null;
        const slot = party.findIndex((p) => p.actorDoc?.uuid === uuid);
        if (slot < 0) continue;
        const owner = party[slot];
        const actor = owner.actorDoc;
        const ownerMax = propNum(actor, "max_hp");
        const ownerHp = propNum(actor, "current_hp");
        const wound = titheWoundAmount({ ownerMax, ownerHp, amount: want });
        if (wound <= 0) continue;
        // The fragment first, as in the lock: no Max HP lost to nothing on the field.
        let frag = liveFragmentOf(ctx, actor.uuid);
        const isNew = !frag;
        if (isNew) {
          frag = await spawnFragment(ctx, owner, slot, heldFrom(actor) + wound, round, { hold: audience });
          if (!frag) continue;
          spawned = true;
        }
        const show = audience ? await present(ctx, "tithe", [{
          ownerTokenId: owner.tokenDoc?.id, fragTokenId: frag.tokenDoc?.id, merge: !isNew, delay: 0,
        }]) : null;
        if (show) await show.at(0, show.T.TITHE.TEAR);
        await addStolen(actor, wound);
        // Also the touch: the HUD, the banner and Crisis follow updateActor.
        await actor.update({ "system.props.current_hp": Math.min(ownerHp, ownerMax - wound) }, { diff: false });
        const max = heldFrom(actor);
        const hp = isNew ? max : Math.min(propNum(frag.actorDoc, "current_hp") + wound, max);
        await setFragmentHp(frag, hp, max);
        any = true;
        ctx.log(`${actor.name} torn at once — lost ${wound} Max HP, fragment ${hp}/${max}`);
        if (show) await show.done;
      }
      if (spawned) await refreshRoster(ctx);
      if (any) await saveNow(ctx);
      return any;
    },
  },

  // Max HP comes back; current HP stays where the fight left it.
  async onConflictEnd(ctx) {
    for (const c of fragmentCombatants(ctx)) await removeFragment(ctx, c);
    await sweepLeftovers(ctx);
  },
});
