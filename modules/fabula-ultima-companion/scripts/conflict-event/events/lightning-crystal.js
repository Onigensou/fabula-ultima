// ============================================================================
// Conflict Event — Lightning Crystal.
//
// The underground counterpart of Lightning Storm, for the Valley of the
// Dragon's cave maps (Underground Area, The Great Seal). No bolt can reach the
// party from the sky down here, so the Rod does not exist; the charge sits in
// the rock instead. Design doc: docs/lightning-crystal-design.md.
//
// The rules:
//
//   1. At the start of a conflict, 0–2 Lightning Crystals appear (25/50/25%).
//   2. Each carries its own countdown, rolled 6–9.
//   3. At the start of EVERY turn, each countdown drops by 1.
//   4. A crystal that takes damage gains time, by how hard it was hit:
//        24 or less → +1 · 25–49 → +2 · 50 or more → +3
//      The crystal is Immune to Bolt and Vulnerable to Earth, so Bolt never
//      delays it and Earth nearly always buys the top tier.
//   5. At zero it deals 20–30 Bolt to every creature, then shatters.
//
// ── What a crystal IS ───────────────────────────────────────────────────────
//
// A real token and a real combatant on the ENEMY side, marked as a battlefield
// object (battle-director/battlefield-object.js). Enemy side rather than a
// neutral third side on purpose: monsters then never pick it as a target, and
// a player's "all enemies" skill includes it, both with no new targeting code.
// Being an object is what keeps it from holding its side alive, taking turns,
// paying out EXP or being chosen by the AI.
//
// It is indestructible by construction rather than by rule: 9999 HP against a
// lifetime of a round or two. Nothing here restores HP or intercepts defeat.
//
// ── Where the state lives ───────────────────────────────────────────────────
//
// An event holds no state (conflict-event-design.md, rule 2), so the countdown
// is an Active Effect on the crystal itself. Foundry persists it, an F5
// restores it, the rewind restores it with the rest of the actor snapshot, and
// every client can draw the number from it with no socket
// (lightning-crystal-countdown.js). It is a marker with no rules payload —
// no charges, no reaction rows — so this file writes it directly, for the same
// reason lightning-storm.js deletes a corpse's Rod directly.
//
// The BLAST is the opposite: it is damage, so it goes through BD's own effect
// executor and picks up affinity, absorb, the ledger and the trigger cascade.
// It is authored `damage_cause: "damage"` because the whole point of the
// explosion is that it sets off the roster's Bolt passives (Overcharge, Chain
// Reaction carry `reaction_cause_filter: damage`; the default `hazard` cause
// would silently skip both).
// ============================================================================

import { registerConflictEvent } from "../conflict-event-registry.js";

const FLAG_NS = "fabula-ultima-companion";

/** `flags.<ns>.conflictObject` on the world actor — how the event finds its crystal. */
export const CRYSTAL_OBJECT_ID = "lightning-crystal";

/** The countdown AE. Mirrored in lightning-crystal-countdown.js. */
export const COUNTDOWN_AE_NAME = "Crystal Countdown";

/** Attribution shown in the resource-ledger breakdown and the battle log. */
const SOURCE_LABEL = "Lightning Crystal";

/** Internal target-ref label — see lightning-storm.js's TARGET_REF. */
const TARGET_REF = "lightning_crystal_targets";

// ── Tuning ──────────────────────────────────────────────────────────────────

/** Chance of 0 / 1 / 2 crystals. Must sum to 1. */
const SPAWN_WEIGHTS = [0.25, 0.5, 0.25];
const COUNTDOWN_MIN = 6;
const COUNTDOWN_MAX = 9;
const BLAST_MIN = 20;
const BLAST_MAX = 30;
/** Damage taken (after affinity) → turns gained. Highest matching floor wins. */
const BUMP_TIERS = [
  { atLeast: 50, turns: 3 },
  { atLeast: 25, turns: 2 },
  { atLeast: 1, turns: 1 },
];

/**
 * Where crystals stand, as fractions of the STAGE (token-centre coordinates).
 * The middle column, between the enemy line on the left and the party on the
 * right, so a crystal reads as belonging to neither.
 */
const ANCHORS = {
  1: [{ x: 0.5, y: 0.46 }],
  2: [{ x: 0.5, y: 0.3 }, { x: 0.5, y: 0.64 }],
};

// ── Pure rules (exported for the bare-Node harness) ─────────────────────────

/**
 * A pinned crystal count from the battle payload, or null to roll.
 *
 * `payload.context.conflictEventOptions.crystalCount` — for a scripted
 * encounter that wants a known number, and for balance sims, which are
 * meaningless if each run silently fights a different hazard.
 */
export function pinnedCrystalCount(payload) {
  const raw = payload?.context?.conflictEventOptions?.crystalCount;
  if (raw == null || raw === "") return null;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return null;
  return Math.min(Math.max(n, 0), SPAWN_WEIGHTS.length - 1);
}

/** How many crystals this conflict gets. `rand` is a 0..1 roll. */
export function rollCrystalCount(rand = Math.random()) {
  let acc = 0;
  for (let n = 0; n < SPAWN_WEIGHTS.length; n++) {
    acc += SPAWN_WEIGHTS[n];
    if (rand < acc) return n;
  }
  return SPAWN_WEIGHTS.length - 1;
}

function rollInt(min, max, rand) {
  const r = Math.min(Math.max(Number(rand) || 0, 0), 0.999999);
  return min + Math.floor(r * (max - min + 1));
}

export function rollCountdown(rand = Math.random()) {
  return rollInt(COUNTDOWN_MIN, COUNTDOWN_MAX, rand);
}

export function rollBlastDamage(rand = Math.random()) {
  return rollInt(BLAST_MIN, BLAST_MAX, rand);
}

/** Turns gained for a hit of `damage` (already through affinity). */
export function bumpForDamage(damage) {
  const n = Number(damage);
  if (!Number.isFinite(n)) return 0;
  for (const tier of BUMP_TIERS) if (n >= tier.atLeast) return tier.turns;
  return 0;
}

/**
 * Given a ledger event, return `{ subjectUuid, turns }` when it should delay a
 * crystal, or null.
 *
 * Any cause counts, not only `damage`: plenty of player skills deal their
 * damage through effect rows, which default to the `hazard` cause, and the
 * ruling is simply "when the crystal takes damage".
 *
 * Bolt is refused explicitly even though the crystal's immunity already turns
 * it into a zero — the immunity is authored on an actor, and this rule should
 * not quietly disappear if somebody edits that sheet.
 */
export function crystalBumpFor(cfg) {
  if (cfg?.trigger !== "creature_lose_resource") return null;
  const p = cfg.payload ?? {};
  if (String(p.resource ?? "").toLowerCase() !== "hp") return null;
  if (String(p.element ?? "").toLowerCase() === "bolt") return null;
  const subjectUuid = p.subjectActorUuid ?? null;
  if (!subjectUuid) return null;
  // The ledger carries the HP that actually came off as `amount` (already
  // through affinity, so an Earth hit arrives doubled and a Bolt hit never
  // arrives at all — fireResourceChangeTrigger drops a zero).
  const damage = Number(p.amount);
  const turns = bumpForDamage(damage);
  if (turns <= 0) return null;
  return { subjectUuid, turns, damage };
}

/**
 * Identity of one turn start, so a countdown can never be ticked twice for the
 * same turn (a re-dispatched standalone window after an F5 mid-turn). A
 * multi-activation creature gets a distinct key per activation because its
 * remaining-turn count differs each time.
 */
export function tickKeyFor({ round, actingTokenUuid, turnsRemaining } = {}) {
  if (!actingTokenUuid) return "";
  return `${Number(round) || 0}:${actingTokenUuid}:${Number(turnsRemaining) || 0}`;
}

// ── Battlefield queries ─────────────────────────────────────────────────────

function isCrystalActor(actor) {
  try { return actor?.flags?.[FLAG_NS]?.conflictObject === CRYSTAL_OBJECT_ID; }
  catch { return false; }
}

function isObjectActor(actor) {
  try { return actor?.flags?.[FLAG_NS]?.bdObject === true; }
  catch { return false; }
}

function countdownAe(actor) {
  try { return actor?.effects?.find?.((e) => e?.name === COUNTDOWN_AE_NAME) ?? null; }
  catch { return null; }
}

function readState(actor) {
  const ae = countdownAe(actor);
  const f = ae?.flags?.[FLAG_NS] ?? {};
  const n = Number(f.crystalCountdown);
  return {
    ae,
    countdown: Number.isFinite(n) ? n : null,
    spent: f.crystalSpent === true,
    tickKey: String(f.crystalTickKey ?? ""),
  };
}

function tokenDocOf(entry) {
  return entry?.token?.document ?? entry?.token ?? null;
}

function findCrystalActor() {
  return game.actors?.find?.((a) => isCrystalActor(a)) ?? null;
}

function bdApi() {
  return globalThis.FUCompanion?.api?.experimental?.battleDirector ?? null;
}

/** Every crystal still on the battlefield, spent or not. */
async function crystalsOnField(ctx) {
  const all = typeof ctx.allCombatants === "function" ? await ctx.allCombatants() : await ctx.combatants();
  return all.filter((e) => isCrystalActor(e.actor));
}

// ── Writes ──────────────────────────────────────────────────────────────────

function countdownAeData(countdown) {
  return {
    name: COUNTDOWN_AE_NAME,
    transfer: false,
    disabled: false,
    changes: [],
    flags: {
      [FLAG_NS]: {
        crystalCountdown: countdown,
        crystalTickKey: "",
        // Never turn-ticked, never reseeded with charges — see the gotcha in
        // conflict-event-design.md. This AE is a counter the event owns.
        directorPermanent: true,
      },
    },
  };
}

/**
 * Write countdown fields. Returns false when the crystal is already gone —
 * the hit that ends a battle can still be settling while the battle-end sweep
 * deletes the tokens, and a countdown on a deleted crystal is nobody's loss.
 */
async function writeState(ae, patch) {
  if (!ae?.parent?.effects?.has?.(ae.id)) return false;
  const upd = {};
  for (const [k, v] of Object.entries(patch)) upd[`flags.${FLAG_NS}.${k}`] = v;
  try { await ae.update(upd); return true; }
  catch { return false; }
}

/**
 * Take a crystal off the battlefield.
 *
 * Through BD's own removeCombatant while the battle is live, so the turn
 * order, the banner, the side-wipe re-check and the reload flag all stay in
 * step. Once the battle has ended that API refuses, and the token is simply
 * deleted — there is no roster left to keep consistent.
 */
async function removeCrystal(ctx, entry) {
  const td = tokenDocOf(entry);
  if (!td) return;
  try {
    const res = await bdApi()?.removeCombatant?.({ tokenUuid: td.uuid });
    if (res?.ok) return;
  } catch (e) { ctx.warn("removeCombatant threw — deleting the token directly", e); }
  try {
    if (td.parent?.tokens?.get?.(td.id)) await td.parent.deleteEmbeddedDocuments("Token", [td.id]);
  } catch (e) { ctx.warn(`could not delete crystal token ${td.id}`, e); }
}

async function spawnCrystal(ctx, actor, anchor, countdown) {
  const dc = ctx.dCombat;
  const scene = ctx.scene;
  const { spawnLiveDirectorTokens } = await import("../../battle-director/director-init.js");
  const [tokenDoc] = await spawnLiveDirectorTokens({
    scene, actorUuids: [actor.uuid], disposition: -1, anchor,
  });
  if (!tokenDoc) { ctx.warn("crystal spawn produced no token"); return null; }

  // The TOKEN's own (synthetic) actor, never the world actor — the countdown
  // and any damage belong to this crystal, not to every crystal ever spawned.
  const c = dc.addCombatant({ tokenDoc, actorDoc: tokenDoc.actor ?? actor, side: "enemy", disposition: -1 });
  c.turnsPerRound = 0;
  c.turnsRemaining = 0;
  // The pin has to be a token flag as well: _resetRoundCounters recomputes
  // turnsPerRound every round and after a reload (see summon_turns_per_round).
  await tokenDoc.update({
    [`flags.${FLAG_NS}.turnsPerRound`]: 0,
    [`flags.${FLAG_NS}.lightningCrystal`]: true,
  });
  await tokenDoc.actor.createEmbeddedDocuments("ActiveEffect", [countdownAeData(countdown)]);
  ctx.log(`crystal spawned — countdown ${countdown}`);
  return tokenDoc;
}

async function refreshRoster(ctx) {
  try {
    const { refreshTurnActions } = await import("../../battle-director/director-round-banner.js");
    refreshTurnActions?.(ctx.dCombat);
  } catch (e) { ctx.warn("banner refresh threw", e); }
  try { Hooks.callAll("fu-director-roster-changed", { dCombat: ctx.dCombat, change: "add" }); } catch { /* observers only */ }
}

// ── The blast ───────────────────────────────────────────────────────────────

/** Text on the announcement card that precedes a blast. */
const ANNOUNCE_TITLE = "Lightning Explosion";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Is anybody watching? A sim at "fast" pace and a hidden GM window both skip
 * the show — and must then skip the WAITS too, or a fight nobody can see sits
 * through seconds of dwell per blast. Skip the show, never the rules.
 */
async function showing() {
  try {
    const { shouldRender } = await import("../../battle-director/presentation-clock.js");
    return shouldRender();
  } catch { return false; }
}

/**
 * The announcement card — the same action namecard every skill uses, so a
 * blast is introduced exactly the way an enemy's big move is. Awaited through
 * its slide-in and hold, so the explosion starts as the card leaves.
 */
async function announceBlast(ctx) {
  try {
    if (!await showing()) return;
    const render = globalThis.FUCompanion?.api?.namecardBroadcast;
    if (typeof render !== "function") return;
    const { buildActionNamecardOptions } = await import("../../battle-director/director-vfx.js");
    const { options } = await buildActionNamecardOptions({ kind: "Skill", skillName: ANNOUNCE_TITLE });
    options.iconOverride = "⚡";
    // Not awaited: the renderer resolves when the card is GONE, and the
    // explosion should begin as it slides away, not after.
    Promise.resolve(render({ title: ANNOUNCE_TITLE, options })).catch(() => {});
    await wait((Number(options.inMs) || 350) + (Number(options.holdMs) || 1400));
  } catch (e) {
    ctx.warn("announcement threw — the blast still resolves", e);
  }
}

/**
 * The explosion on the crystal, its shatter, and the beat before the damage.
 *
 * The crystal visibly goes WITH the explosion, not after the damage has
 * finished walking across every target a couple of seconds later. Writing
 * `crystalShattering` is what plays the flash + fade on every client
 * (lightning-crystal-fx.js); the token's own alpha is then zeroed with
 * `animate: false`, because Foundry would otherwise tween the document change
 * itself — snapping the already-faded crystal back to full and fading it a
 * second time.
 *
 * Borrows BD's impact-FX player (a webm pinned to a token, broadcast to every
 * client) and its SFX channel rather than building a second pair. The targets
 * need nothing from here: the damage that follows goes through the director's
 * normal loss path, which already gives every creature it hits a flinch, an
 * impact burst and a damage number.
 */
async function playExplosion(ctx, entry, ae) {
  const tokenDoc = tokenDocOf(entry);
  const hide = async () => {
    try { await tokenDoc?.update?.({ alpha: 0 }, { animate: false }); }
    catch (e) { ctx.warn("could not hide the shattered crystal", e); }
  };
  try {
    const tokenUuid = tokenDoc?.uuid ?? null;
    if (!tokenUuid || !await showing()) { await hide(); return; }
    const [{ emitImpactFx }, { broadcastSfx }, { CRYSTAL_FX }] = await Promise.all([
      import("../../battle-director/damage-numbers/director-impact-fx.js"),
      import("../../battle-director/director-sfx.js"),
      import("../lightning-crystal-fx.js"),
    ]);
    emitImpactFx({ tokenUuid, file: CRYSTAL_FX.explosionWebm, scale: CRYSTAL_FX.explosionScale, durationMs: CRYSTAL_FX.explosionMs });
    broadcastSfx(CRYSTAL_FX.explosionSfx, CRYSTAL_FX.explosionVolume);
    await writeState(ae, { crystalShattering: true });
    await wait(CRYSTAL_FX.explosionImpactMs);
  } catch (e) {
    ctx.warn("explosion FX threw — the blast still resolves", e);
  }
  await hide();
}

async function detonate(ctx, entry) {
  const state = readState(entry.actor);
  if (!state.ae || state.spent) return;

  await announceBlast(ctx);
  await playExplosion(ctx, entry, state.ae);

  // Everything standing, except other objects — one crystal's blast is not
  // what moves another's clock (and they are Bolt-immune regardless).
  const targets = (await ctx.combatants()).filter((e) => !isObjectActor(e.actor));
  const amount = rollBlastDamage();
  ctx.log(`${entry.actor.name} detonates — ${amount} Bolt to ${targets.length} creature(s)`);

  if (targets.length) {
    const { makeChainContext } = await import("../../battle-director/skill-targeting.js");
    const chainCtx = makeChainContext({
      reactorActor: entry.actor,
      reactorToken: entry.token,
      director: ctx.director,
      dCombat: ctx.dCombat,
      sourceLabel: SOURCE_LABEL,
    });
    chainCtx.resolvedTargets = new Map([
      [TARGET_REF, { ok: true, tokens: targets.map((e) => e.token) }],
    ]);
    await ctx.applyEffectRow({
      effect_label: "lightning_crystal_blast",
      effect_kind: "deal_damage",
      damage_element: "bolt",
      damage_amount: String(amount),
      damage_cause: "damage",
      damage_verbosity: "full",
      attacker_name: SOURCE_LABEL,
      target_ref: TARGET_REF,
    }, chainCtx);
  }

  // Shattered — but not removed YET. The damage above has only been written;
  // the reactions it provokes settle after this handler returns, and they name
  // this crystal as their cause. So it is marked spent (inert, untargetable,
  // invisible) and swept at the next turn start. See sweepSpent.
  await state.ae.update({
    [`flags.${FLAG_NS}.crystalSpent`]: true,
    [`flags.${FLAG_NS}.crystalCountdown`]: 0,
    changes: [{ key: "cannot_be_targeted_by", mode: 5, value: "any", priority: 0 }],
  });
}

/**
 * Delete crystal tokens that are on the scene but NOT in this conflict's
 * roster — left by a fight that ended without its teardown (a crash, a sim's
 * lean mode, a follow-up conflict on the same scene). crystalsOnField cannot
 * see them, because it reads the roster.
 */
async function deleteStrayCrystalTokens(ctx) {
  try {
    const scene = ctx.scene;
    const ids = (scene?.tokens?.contents ?? [])
      .filter((td) => isCrystalActor(td.actor))
      .map((td) => td.id);
    if (ids.length) await scene.deleteEmbeddedDocuments("Token", ids);
  } catch (e) { ctx.warn("stray crystal sweep threw", e); }
}

async function sweepSpent(ctx) {
  for (const entry of await crystalsOnField(ctx)) {
    if (!readState(entry.actor).spent) continue;
    await removeCrystal(ctx, entry);
    ctx.log("shattered crystal removed");
  }
}

// ── The event ───────────────────────────────────────────────────────────────

registerConflictEvent({
  id: "lightning-crystal",
  label: "Lightning Crystal",
  description:
    "0–2 Lightning Crystals appear with a countdown that drops every turn. Damaging a crystal " +
    "adds time (never with Bolt). At zero it deals 20–30 Bolt to every creature and shatters.",

  // Rules 1 + 2. Clears first, so a conflict inherited from a battle-end
  // follow-up (same scene, new conflict) cannot start with a stale crystal
  // from the fight before it.
  async onConflictStart(ctx) {
    for (const entry of await crystalsOnField(ctx)) await removeCrystal(ctx, entry);
    await deleteStrayCrystalTokens(ctx);

    const pinned = pinnedCrystalCount(ctx.director?.ctx?.payload);
    const count = pinned ?? rollCrystalCount();
    ctx.log(`conflict start — ${count} crystal(s)${pinned != null ? " (pinned)" : ""}`);
    if (!count) return;

    const actor = findCrystalActor();
    if (!actor) {
      ctx.warn(`no world actor is flagged conflictObject "${CRYSTAL_OBJECT_ID}" — no crystals this conflict`);
      return;
    }
    const { stageOf } = await import("../../battle-director/director-camera.js");
    const stage = stageOf(ctx.scene);
    for (const frac of ANCHORS[count] ?? []) {
      const anchor = { x: stage.x + stage.w * frac.x, y: stage.y + stage.h * frac.y };
      try { await spawnCrystal(ctx, actor, anchor, rollCountdown()); }
      catch (e) { ctx.warn("crystal spawn threw", e); }
    }
    await refreshRoster(ctx);
  },

  // Rules 3 + 5. Unlike the Storm, the per-turn beat cannot live on an AE's own
  // turn_start row: a crystal has no turn of its own, and "every creature's
  // turn" is a battlefield beat, not an actor one. The dispatch is awaited and
  // runs before the forced reaction pass, so a blast lands ahead of whatever
  // the acting creature does with its turn.
  async onTurnStart(ctx) {
    await sweepSpent(ctx);

    const actingTokenUuid = ctx.payload?.actingTokenUuid ?? null;
    const acting = (ctx.dCombat?.combatants ?? []).find((c) => c.tokenUuid === actingTokenUuid) ?? null;
    const key = tickKeyFor({
      round: ctx.dCombat?.round,
      actingTokenUuid,
      turnsRemaining: acting?.turnsRemaining,
    });

    for (const entry of await crystalsOnField(ctx)) {
      const state = readState(entry.actor);
      if (!state.ae || state.spent || state.countdown == null) continue;
      if (key && state.tickKey === key) continue;

      const next = Math.max(0, state.countdown - 1);
      if (!await writeState(state.ae, { crystalCountdown: next, crystalTickKey: key })) continue;
      if (next <= 0) await detonate(ctx, entry);
    }
  },

  // Rule 4.
  async onLedgerEvent(ctx, cfg) {
    const bump = crystalBumpFor(cfg);
    if (!bump) return;
    // The fight is over — the crystals are being swept, not managed.
    if (ctx.dCombat?.ended) return;

    const entry = (await crystalsOnField(ctx)).find((e) => e.actor?.uuid === bump.subjectUuid);
    if (!entry) return;
    const state = readState(entry.actor);
    if (!state.ae || state.spent || state.countdown == null || state.countdown <= 0) return;

    if (!await writeState(state.ae, { crystalCountdown: state.countdown + bump.turns })) return;
    ctx.log(`${entry.actor.name} took ${bump.damage} — countdown ${state.countdown} → ${state.countdown + bump.turns}`);
  },

  // A crystal must never outlive its fight.
  async onConflictEnd(ctx) {
    for (const entry of await crystalsOnField(ctx)) await removeCrystal(ctx, entry);
    await deleteStrayCrystalTokens(ctx);
  },
});
