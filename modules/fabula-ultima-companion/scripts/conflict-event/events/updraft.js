// ============================================================================
// Conflict Event — Updraft.
//
// The hazard of the Vastwind Field. The rule:
//
//   Whenever a creature takes Air damage, it gains Flying until the end of its
//   next turn.
//
// Rulings (user, 2026-11-15):
//
//   - "Takes Air damage" = an HP LOSS whose element is air, from an attack or a
//     hazard. An absorber writes a recovery instead, and an Immune hit writes
//     nothing, so neither one flies.
//   - "Until the end of its next turn" = the canonical Flying, applied as a
//     bearer-turn countdown (`target_turn_end`, the Liftoff model). Hit off its
//     own turn: 1 charge, gone at the end of its next turn. Hit DURING its own
//     turn: 2 charges, because that turn's end ticks one.
//   - A second Air hit refreshes the countdown; it never stacks.
//   - A creature that already flies on its own (a natural flyer, Liftoff,
//     Valkyrie) is left alone: a 1-turn Updraft must never replace a longer or
//     permanent Flying.
//   - The KO'd do not fly.
//
// ── State ───────────────────────────────────────────────────────────────────
//
// None here (conflict-event-design.md, rule 2). Which Flying is ours is a flag on
// the Flying AE itself, so a refresh after an F5 or a rewind still knows it.
// Every Updraft Flying is swept at conflict end, so none follows a creature out.
// ============================================================================

import { registerConflictEvent } from "../conflict-event-registry.js";

const FLAG_NS = "fabula-ultima-companion";
const FLYING_AE_NAME = "Flying";
const UPDRAFT_FLAG = "updraft";
const SOURCE_LABEL = "Updraft";
const TARGET_REF = "updraft_targets";

// ── Pure rules (exported for the bare-Node harness) ─────────────────────────

/**
 * Given a ledger event, the actor UUID that should gain Flying, or null.
 * Air HP loss only, from an attack or a hazard (not a cost, not a drain).
 */
export function updraftSubjectFor(cfg) {
  if (cfg?.trigger !== "creature_lose_resource") return null;
  const p = cfg.payload ?? {};
  if (String(p.resource ?? "").toLowerCase() !== "hp") return null;
  if (String(p.element ?? "").toLowerCase() !== "air") return null;
  const cause = String(p.cause ?? "").toLowerCase();
  if (cause !== "damage" && cause !== "hazard") return null;
  if (!(Number(p.amount) > 0)) return null;
  return p.subjectActorUuid ?? null;
}

/**
 * How many of the bearer's turn ends the Flying lasts. Its next turn's end is
 * the one that matters; if it is acting right now, this turn's end comes first.
 */
export function updraftCharges({ isOwnTurn = false } = {}) {
  return isOwnTurn ? 2 : 1;
}

// ── Battlefield queries ─────────────────────────────────────────────────────

function isUpdraftAe(ae) {
  return ae?.name === FLYING_AE_NAME && ae.flags?.[FLAG_NS]?.[UPDRAFT_FLAG] === true;
}

function updraftAeOn(actor) {
  try { return actor?.effects?.find?.((e) => isUpdraftAe(e)) ?? null; } catch { return null; }
}

/** Flying from anything that is not Updraft: a Flying AE, or the status itself. */
function fliesOnItsOwn(actor) {
  try {
    const flyId = (CONFIG.statusEffects ?? []).find(
      (s) => String(s.name ?? s.label ?? "").trim().toLowerCase() === "flying",
    )?.id ?? null;
    for (const e of actor?.effects ?? []) {
      if (e?.disabled || isUpdraftAe(e)) continue;
      if (String(e.name ?? "").trim().toLowerCase() === "flying") return true;
      if (flyId && e.statuses?.has?.(flyId)) return true;
    }
    // A status set straight on the actor (no AE) — only when no Updraft AE explains it.
    if (flyId && actor?.statuses?.has?.(flyId) && !updraftAeOn(actor)) return true;
  } catch { /* unreadable — treat as not flying */ }
  return false;
}

// ── Effect execution ────────────────────────────────────────────────────────

/** Run one BD effect row against one combatant (see lightning-storm.js runRow). */
async function runRow(ctx, row, entry) {
  const { makeChainContext } = await import("../../battle-director/skill-targeting.js");
  const chainCtx = makeChainContext({
    reactorActor: entry.actor,
    reactorToken: entry.token,
    director: ctx.director,
    dCombat: ctx.dCombat,
    sourceLabel: SOURCE_LABEL,
  });
  chainCtx.resolvedTargets = new Map([[TARGET_REF, { ok: true, tokens: [entry.token] }]]);
  return ctx.applyEffectRow({ ...row, target_ref: TARGET_REF }, chainCtx);
}

async function setCharges(ae, charges) {
  const upd = { [`flags.${FLAG_NS}.charges`]: charges };
  if (ae.flags?.statuscounter?.visible === true) upd["flags.statuscounter.value"] = charges;
  await ae.update(upd);
}

/** Give `entry` Updraft's Flying, or refresh the one it has. */
async function liftUp(ctx, entry) {
  const actor = entry.actor;
  const cur = ctx.dCombat?.current ?? null;
  const charges = updraftCharges({ isOwnTurn: !!cur && cur.id === entry.combatantId });

  const mine = updraftAeOn(actor);
  if (mine) {
    await setCharges(mine, charges);
    ctx.log(`${actor.name} — Flying refreshed (${charges})`);
    return;
  }
  if (fliesOnItsOwn(actor)) { ctx.log(`${actor.name} already flies — left alone`); return; }

  await runRow(ctx, {
    effect_label: "updraft_fly",
    effect_kind: "apply_ae",
    ae_template_ref: FLYING_AE_NAME,
    ae_duplicate_mode: "skip",
    ae_lifetime_mode: "target_turn_end",
    ae_initial_charges: String(charges),
  }, entry);

  // Mark it ours. The executor created it; the newest Flying with no mark is it.
  const fresh = (actor.effects ?? []).filter((e) => e?.name === FLYING_AE_NAME && !isUpdraftAe(e)).pop();
  if (!fresh) { ctx.warn(`${actor.name}: Flying did not land`); return; }
  await fresh.update({ [`flags.${FLAG_NS}.${UPDRAFT_FLAG}`]: true });
  // The executor seeds charges from the row, but a template default could still
  // win on some path; set the count we mean.
  if (Number(fresh.flags?.[FLAG_NS]?.charges) !== charges) await setCharges(fresh, charges);
  ctx.log(`${actor.name} — Flying (${charges})`);
  // The emblem pulse is client-side: conflict-field-pulse.js watches the flag.
}

// ── The event ───────────────────────────────────────────────────────────────

registerConflictEvent({
  id: "updraft",
  label: "Updraft",
  description:
    "Whenever a creature takes Air damage, it gains Flying until the end of its next turn.",

  ruling: {
    color: "#3a9e8f",
    line: "Air damage lifts its target into the air.",
    pages: [
      { image: "modules/fabula-ultima-companion/assets/conflict-event/updraft-1.jpg",
        text: "A creature that takes **Air** damage gains **Flying** until the end of its next turn." },
    ],
  },

  async onLedgerEvent(ctx, cfg) {
    const subjectUuid = updraftSubjectFor(cfg);
    if (!subjectUuid) return;
    // Live only: a hit that KOs leaves the creature out of this list.
    const entry = (await ctx.combatants()).find((e) => e.actor?.uuid === subjectUuid);
    if (!entry) return;
    await liftUp(ctx, entry);
  },

  // No Updraft Flying leaves the fight, standing or KO'd.
  async onConflictEnd(ctx) {
    const all = typeof ctx.allCombatants === "function" ? await ctx.allCombatants() : await ctx.combatants();
    for (const e of all) {
      const ids = (e.actor?.effects ?? []).filter(isUpdraftAe).map((ae) => ae.id);
      if (!ids.length) continue;
      try { await e.actor.deleteEmbeddedDocuments("ActiveEffect", ids); } catch (err) { ctx.warn("sweep failed", err); }
    }
  },
});
