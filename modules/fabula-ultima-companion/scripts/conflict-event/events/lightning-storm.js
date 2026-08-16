// ============================================================================
// Conflict Event — Lightning Storm.
//
// The environmental hazard of Valley of the Dragon (and its sub-area, Fafnir
// Castle). Design doc: docs/lightning-storm-design.md.
//
// The rules:
//
//   1. At the start of a conflict, a random creature gains `Lightning Rod`.
//   2. At the start of a creature's turn, if it holds the Rod, it takes
//      30 Bolt damage and recovers 30 MP.
//   3. Whenever a creature takes damage dealt by ANOTHER creature, it gains
//      the Rod.
//   4. The Rod is a singleton — a new holder replaces the previous one.
//   5. If nobody holds the Rod at the start of a round, a random creature
//      gains it.
//
// ── What lives here and what does not ───────────────────────────────────────
//
// Rule 2 is NOT in this file. The per-turn strike lives on the `Lightning Rod`
// Active Effect itself, as a reactionConfig row (turn_start / force). Hosting
// it there means it works identically on PCs and NPCs with no per-actor
// authoring, and it fires once per ACTIVATION for free — which is exactly the
// multi-activation ruling, at no cost.
//
// This file owns only the ownerless half: the rules about WHO holds the Rod,
// which no actor can own because the Rod belongs to the battlefield.
//
// ── Why there is no state here ──────────────────────────────────────────────
//
// "Who holds the Rod" is the AE. Not a variable, not a Map, not a scene flag.
// Foundry persists it, F5 restores it, the rewind button restores it, and the
// players see it as a status chip — none of which a module-level variable
// would survive. Every query below re-reads the battlefield.
// ============================================================================

import { registerConflictEvent } from "../conflict-event-registry.js";

/** The AE's name, as authored on the shared Debuff item. */
const ROD_AE_NAME = "Lightning Rod";

/** Attribution shown in the resource-ledger breakdown. */
const SOURCE_LABEL = "Lightning Storm";

/**
 * Internal target-ref label. The event picks its targets in JS and pre-seeds
 * them into the chain context's resolver memo, so BD's effect executor does
 * the AE work while this file decides who it lands on.
 */
const TARGET_REF = "lightning_storm_targets";

// ── Battlefield queries ─────────────────────────────────────────────────────

function rodOn(actor) {
  try {
    return actor?.effects?.find?.((e) => e?.name === ROD_AE_NAME && !e.disabled) ?? null;
  } catch { return null; }
}

/** Every live combatant currently holding the Rod. Normally 0 or 1. */
function holdersAmong(entries) {
  return entries.filter((e) => rodOn(e.actor));
}

function pickRandom(entries) {
  if (!entries.length) return null;
  return entries[Math.floor(Math.random() * entries.length)];
}

// ── Effect execution ────────────────────────────────────────────────────────

/**
 * Run one BD effect row against an explicit token list.
 *
 * Targets are pre-seeded into `resolvedTargets` — the same memo
 * resolveTargetRef consults before doing any work — which is how an event
 * chooses targets in code without inventing a second targeting system.
 *
 * `reactorActor` is the affected creature rather than null: every downstream
 * path is then guaranteed a real actor, and the only visible consequence is
 * that the AE records the holder as its own applier. Nothing here uses a
 * per-caster duplicate mode, so that stamp is inert.
 */
async function runRow(ctx, row, entries) {
  if (!entries.length) return null;
  const { makeChainContext } = await import("../../battle-director/skill-targeting.js");

  const chainCtx = makeChainContext({
    reactorActor: entries[0].actor,
    reactorToken: entries[0].token,
    director: ctx.director,
    dCombat: ctx.dCombat,
    sourceLabel: SOURCE_LABEL,
  });
  chainCtx.resolvedTargets = new Map([
    [TARGET_REF, { ok: true, tokens: entries.map((e) => e.token) }],
  ]);

  return ctx.applyEffectRow({ ...row, target_ref: TARGET_REF }, chainCtx);
}

/**
 * Strip the Rod from the given holders.
 *
 * Uses `remove_ae`, NOT `apply_ae` with ae_duplicate_mode "remove". That
 * duplicate mode only deletes when the AE is ALREADY PRESENT — on a creature
 * without it, the row falls through to the create branch and GRANTS one
 * (skill-effects.js, the `if (existing)` guard around the remove case). A
 * broadcast "remove" over every combatant would therefore strip the holder and
 * hand a Rod to everybody else — the exact inverse of a singleton.
 */
async function stripRod(ctx, holders) {
  if (!holders.length) return;
  await runRow(ctx, {
    effect_label: "lightning_storm_strip",
    effect_kind: "remove_ae",
    ae_template_ref: ROD_AE_NAME,
  }, holders);
}

async function grantRod(ctx, entry) {
  await runRow(ctx, {
    effect_label: "lightning_storm_grant",
    effect_kind: "apply_ae",
    ae_template_ref: ROD_AE_NAME,
    ae_duplicate_mode: "skip",
  }, [entry]);
}

/**
 * Move the Rod onto `entry`, enforcing the singleton.
 *
 * Strip-then-grant, and a no-op when the creature already holds it — which is
 * the common case during a multi-hit sequence and saves two document writes
 * per redundant hit.
 */
async function moveRodTo(ctx, entry, entries) {
  if (!entry?.actor) return;
  const holders = holdersAmong(entries);
  if (holders.length === 1 && holders[0].actor.uuid === entry.actor.uuid) return;

  await stripRod(ctx, holders);
  await grantRod(ctx, entry);
  ctx.log(`Rod → ${entry.actor.name}`);
}

async function seedRandomly(ctx, reason) {
  const entries = await ctx.combatants();
  const pick = pickRandom(entries);
  if (!pick) { ctx.log(`${reason}: no live combatants to seed`); return; }
  await moveRodTo(ctx, pick, entries);
}

// ── The rule that decides whether damage moves the Rod ──────────────────────

/**
 * Given a ledger event, return the actor UUID the Rod should move to, or null.
 *
 * Pure and exported so it can be tested without a live Foundry — this is where
 * every subtle ruling in the design lives, and a mistake in any one of these
 * filters is invisible until it has already misfired at a table.
 */
export function rodRecipientFor(cfg) {
  if (cfg?.trigger !== "creature_lose_resource") return null;

  const p = cfg.payload ?? {};
  if (String(p.resource ?? "").toLowerCase() !== "hp") return null;

  // `damage` is creature-inflicted; `hazard` covers the Rod's own strike AND
  // every DoT tick (Burn, Poison, environmental). One filter, both of the
  // design's exclusions — the Rod must not self-refresh on its own strike, and
  // uncontrollable DoT motion would dilute the strategy layer.
  if (String(p.cause ?? "").toLowerCase() !== "damage") return null;

  // Rule 3 says damage dealt by ANOTHER creature. Self-inflicted damage leaves
  // the Rod where it is.
  const subjectUuid = p.subjectActorUuid ?? null;
  if (!subjectUuid) return null;
  if (p.causeActorUuid && p.causeActorUuid === subjectUuid) return null;

  return subjectUuid;
}

// ── The event ───────────────────────────────────────────────────────────────

registerConflictEvent({
  id: "lightning-storm",
  label: "Lightning Storm",
  description:
    "A singleton Lightning Rod marks one creature. At the start of its turn the holder takes " +
    "30 Bolt damage and recovers 30 MP. Dealing damage to a creature moves the Rod onto it.",

  // Rule 1. Strips first, so a conflict inherited from a battle-end follow-up
  // (same scene, new conflict) cannot start with a stale Rod alongside the
  // fresh one.
  async onConflictStart(ctx) {
    const entries = await ctx.combatants();
    await stripRod(ctx, holdersAmong(entries));
    await seedRandomly(ctx, "conflict start");
  },

  // Rule 5. The round boundary is the pressure point: the party can suppress
  // the hazard mid-round by only ever damaging already-acted creatures, but
  // that suppression collapses when the pool empties.
  async onRoundStart(ctx) {
    const entries = await ctx.combatants();
    if (holdersAmong(entries).length) return;
    await seedRandomly(ctx, "round start");
  },

  // Rules 3 + 4.
  async onLedgerEvent(ctx, cfg) {
    const subjectUuid = rodRecipientFor(cfg);
    if (!subjectUuid) return;

    // A creature that ABSORBS the damage never appears here — an absorb writes
    // a recovery, which fires creature_gain_resource instead. So an absorbing
    // creature cannot GAIN the Rod, though it can still hold one and be healed
    // by the strike. That asymmetry is the design's intent (Electro Slime
    // becomes a Rod sponge), and listening only to the loss family is what
    // preserves it. Deliberate — do not "fix" by adding the gain family.
    const entries = await ctx.combatants();
    const subject = entries.find((e) => e.actor?.uuid === subjectUuid);

    // Not found = the damage defeated them (collectReactors drops the downed).
    // The Rod stays with its current holder and rule 5 re-seeds if that was
    // the creature who just died.
    if (!subject) return;

    await moveRodTo(ctx, subject, entries);
  },

  // The Rod must never follow a creature out of the fight.
  async onConflictEnd(ctx) {
    const entries = await ctx.combatants();
    await stripRod(ctx, holdersAmong(entries));
  },
});
