// ============================================================================
// Nox Servant — a creature Nidhogg's Zero Trigger turned into a servant
// (docs/nidhogg-boss-design.md §4c item 7). It stays on the field and in the
// conflict for the rest of the battle, but:
//   - OPPONENTS cannot target it (allies still can, with support):
//       cannot_be_targeted_by: "opponent"   (read by snapshot.js isTargetBlockedFor)
//   - it cannot fall below 1 HP:
//       hp_floor: 1                         (shared/hp-floor.js, slice A)
// ONE Active Effect, JS-built (like out-of-play.js): flags directorPermanent +
// conflictScoped, no buff/debuff tag, no directorAppliedBy => never ticked, not
// cleansed, swept only at conflict end.
// ============================================================================
import { isTargetBlockedFor } from "./snapshot.js";

export { isTargetBlockedFor };

const NS = "fabula-ultima-companion";
export const NOX_FLAG = "noxServant";
export const NOX_SERVANT_NAME = "Nox Servant";
// Placeholder art; the lead picks the real icon.
export const NOX_SERVANT_ICON = "icons/svg/skull.svg";

/** The AE's data. `extra` merges into flags[ns]. */
export function noxServantAeData(extra = {}) {
  return {
    name: NOX_SERVANT_NAME,
    img: NOX_SERVANT_ICON,
    disabled: false,
    transfer: false,
    description: "Opponents cannot target this creature, and it cannot fall below 1 HP.",
    changes: [
      { key: "cannot_be_targeted_by", mode: 5, value: "opponent", priority: 50 },
      { key: "hp_floor", mode: 5, value: "1", priority: 50 },
    ],
    flags: { [NS]: { [NOX_FLAG]: true, directorPermanent: true, conflictScoped: true, ...extra } },
  };
}

const effectsOf = (actor) => {
  const e = actor?.effects;
  if (!e) return [];
  return Array.isArray(e) ? e : (e.contents ?? [...e]);
};
const isNoxEffect = (ef) => ef?.flags?.[NS]?.[NOX_FLAG] === true;

/** True while the actor carries an enabled Nox Servant effect. Accepts an actor, a token or a token document. */
export function isNoxServant(subject) {
  const actor = subject?.actor ?? subject;
  for (const ef of effectsOf(actor)) if (isNoxEffect(ef) && !ef.disabled) return true;
  return false;
}

/** The actor's Nox Servant effects (any, enabled or not). */
export function noxServantEffects(actor) {
  return effectsOf(actor).filter(isNoxEffect);
}

/**
 * Make the actor a Nox Servant: apply the AE (idempotent), set current_hp to a fresh max_hp
 * (a revive to full), then settle the KO status. GM only. Returns { ok, already, reason? }.
 */
export async function makeNoxServant(actor, ctx = {}) {
  if (!actor) return { ok: false, already: false, reason: "no actor" };
  if (!globalThis.game?.user?.isGM) return { ok: false, already: false, reason: "not GM" };
  const already = isNoxServant(actor);
  if (!already) await actor.createEmbeddedDocuments("ActiveEffect", [noxServantAeData(ctx?.extra ?? {})]);
  // An existing Servant keeps its HP: only a fresh conversion heals (a revive to full).
  if (!already) {
    // Fresh max_hp: read AFTER the AE exists so any derived max is current.
    const max = Number(actor.system?.props?.max_hp);
    if (!(Number.isFinite(max) && max > 0)) return { ok: false, already, reason: "no finite max_hp, HP not written" };
    try { await actor.update({ "system.props.current_hp": max }); }
    catch (e) { return { ok: false, already, reason: `HP write failed: ${e?.message ?? e}` }; }
  }
  try {
    const { settleRevive } = await import("./defeat-reactor.js");
    await settleRevive(actor);
  } catch (e) {
    console.warn("[nox-servant] settleRevive failed", e);
  }
  return { ok: true, already };
}
