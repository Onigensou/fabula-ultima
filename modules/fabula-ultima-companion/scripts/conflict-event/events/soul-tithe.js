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
 * Where fragments stand, as fractions of the STAGE (token-centre coordinates):
 * the middle of the stage, one slot per player in party order so a fragment keeps
 * its place across rounds and two can never land on one spot. Staggered, because in
 * one column each HP badge sat on the name of the fragment above it.
 */
const ANCHORS = [
  { x: 0.37, y: 0.27 },
  { x: 0.5, y: 0.42 },
  { x: 0.37, y: 0.57 },
  { x: 0.5, y: 0.72 },
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
    const refunded = markAe(c.actorDoc)?.flags?.[FLAG_NS]?.soulReturned === true;
    if (propNum(c.actorDoc, "current_hp") > 0 && !refunded) continue;
    await returnToOwner(ctx, c.actorDoc, c.tokenDoc);
    await removeFragment(ctx, c);
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
    const lost = stolenFrom(owner.actorDoc);
    if (lost === max || lost <= 0) continue;
    ctx.warn(`${c.actorDoc.name} held ${max} but ${owner.actorDoc.name} has lost ${lost}; corrected`);
    await setFragmentHp(c, Math.max(1, Math.min(hp + (lost - max), lost)), lost);
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
    await setFragmentHp(c, r.fragmentHp, stolenFrom(actor));
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
    let frag = fragmentCombatants(ctx).find((c) => ownerUuidOf(c) === actor.uuid && propNum(c.actorDoc, "current_hp") > 0) ?? null;
    const isNew = !frag;
    if (isNew) {
      frag = await spawnFragment(ctx, owner, slot, stolenFrom(actor) + wound, round, { hold: audience });
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
    const max = stolenFrom(actor);
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
  const resuming = Number.isFinite(f.soulRefundHp);
  if (!resuming && !tornAe(actor)) return;

  const stolen = stolenFrom(actor);
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
    await clearTorn(actor);
    await actor.update({ "system.props.current_hp": hp }, { diff: false });
  } else {
    await actor.update({ "system.props.current_hp": hp }, { diff: false });
    await clearTorn(actor);
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

  // Max HP comes back; current HP stays where the fight left it.
  async onConflictEnd(ctx) {
    for (const c of fragmentCombatants(ctx)) await removeFragment(ctx, c);
    await sweepLeftovers(ctx);
  },
});
