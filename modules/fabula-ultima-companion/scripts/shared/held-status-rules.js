// ============================================================================
// Shared — Held status rules (pure, no Foundry globals; node-testable)
//
// "You'll be Slowed until your next battle" in story terms means: the actor IS
// inflicted now, the status does not count down while exploring, and at the
// start of the actor's next battle it becomes an ordinary battle condition that
// counts down on their turns and is cleansed when that battle ends.
//
// A held status is a real ActiveEffect carrying two flags:
//   heldUntilBattle: true  — the marker every lifetime rule keys off
//   crossScene:      true  — keeps the Battle Director's end-of-battle sweep
//                            (isTransientAE) off it while it is still held, e.g.
//                            for a member benched during a battle
// Both are removed when the battle converts it, so from then on the battle's
// own tickers and sweep own it like any other condition.
//
// Who expires a held status:
//   dungeon steps   never (AELifetime.isDungeonTickable says no)
//   a Rest          yes — rest-api _clearTemporaryEffects deletes it (user call
//                   2026-11-14: "Rest cures it")
//   battle start    converted by held-status.js on the battle host
//   release()       the GM cures it by hand
// ============================================================================

export const FLAG_NS = "fabula-ultima-companion";
export const HELD_FLAG = "heldUntilBattle";

const flagsOf = (eff) => eff?.flags?.[FLAG_NS] ?? {};

/** True while the effect is still waiting for its battle. */
export function isHeld(eff) {
  return flagsOf(eff)[HELD_FLAG] === true;
}

/** Status ids on an effect (Set on a live document, array in raw data). */
export function statusIdsOf(eff) {
  const s = eff?.statuses;
  if (!s) return [];
  if (typeof s.has === "function") return Array.from(s).map(String);
  return Array.isArray(s) ? s.map(String) : [];
}

/**
 * Find a status entry by id or display name, case-insensitively.
 * `entries` = [{ id, name }] with names already localized.
 */
export function matchStatus(entries, query) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return null;
  const list = Array.isArray(entries) ? entries : [];
  return list.find(e => String(e?.id ?? "").toLowerCase() === q)
      ?? list.find(e => String(e?.name ?? "").toLowerCase() === q)
      ?? null;
}

/**
 * Creation data for a held status, built from a condition template (the same
 * canonical template the battle's apply_ae uses, or a bare status entry).
 * The status is the actor's own: origin = the actor, never an Item (an Item
 * origin would read as equipment-granted and dodge the Rest cure).
 */
export function buildHeldEffectData(template, { actorUuid, statusId, source = "", turns = null } = {}) {
  const data = JSON.parse(JSON.stringify(template ?? {}));
  delete data._id;
  data.origin = actorUuid ?? null;
  data.transfer = false;
  data.disabled = false;
  if (statusId) {
    const ids = new Set(statusIdsOf(data));
    ids.add(statusId);
    data.statuses = Array.from(ids);
  }
  // No core duration: nothing but the battle conversion should start a clock.
  data.duration = { ...(data.duration ?? {}), rounds: null, turns: null, seconds: null, startRound: null, startTurn: null };
  data.flags = data.flags ?? {};
  const ns = data.flags[FLAG_NS] = { ...(data.flags[FLAG_NS] ?? {}) };
  // A copied template must not arrive looking battle-applied or already ticking.
  delete ns.directorAppliedBy;
  delete ns.bdAdopted;
  delete ns.dungeonTurnsRemaining;
  delete ns.dungeonTickGrace;
  delete ns.sceneExpiry;
  delete ns.campRestCharges;
  ns[HELD_FLAG] = true;
  ns.crossScene = true;
  ns.heldSource = String(source ?? "");
  ns.heldTurns = turns != null && Number.isFinite(Number(turns)) && Number(turns) > 0 ? Math.floor(Number(turns)) : null;
  // The held turn count, when given, becomes the battle charge count. Otherwise
  // the template's own authored charges (if any) stay, and the conversion seeds
  // the battle default.
  if (ns.heldTurns != null) ns.charges = ns.heldTurns;
  return data;
}

/**
 * Flag update that turns an already-present status into a held one (the actor
 * was already Slowed for a few steps; the story now says "until your next
 * battle"). Stops the dungeon counter and any stamp.
 */
export function holdExistingUpdate(eff, { source = "", turns = null } = {}) {
  const t = turns != null && Number.isFinite(Number(turns)) && Number(turns) > 0 ? Math.floor(Number(turns)) : null;
  const upd = {
    _id: eff?._id ?? eff?.id,
    [`flags.${FLAG_NS}.${HELD_FLAG}`]: true,
    [`flags.${FLAG_NS}.crossScene`]: true,
    [`flags.${FLAG_NS}.heldSource`]: String(source ?? ""),
    [`flags.${FLAG_NS}.heldTurns`]: t,
    [`flags.${FLAG_NS}.-=directorAppliedBy`]: null,
    [`flags.${FLAG_NS}.-=dungeonTurnsRemaining`]: null,
    [`flags.${FLAG_NS}.-=dungeonTickGrace`]: null,
    "duration.rounds": null, "duration.turns": null, "duration.seconds": null,
  };
  if (t != null) upd[`flags.${FLAG_NS}.charges`] = t;
  else upd[`flags.${FLAG_NS}.-=charges`] = null;
  return upd;
}

/**
 * Flag update for the battle conversion, from the battle-shaped data that
 * skill-effects' buildAdoptedConditionData produced. Only the namespace flags
 * and the statuscounter badge change; the effect keeps its id, so the token's
 * status icon never flickers.
 */
export function conversionUpdate(eff, adopted) {
  const ns = adopted?.flags?.[FLAG_NS] ?? {};
  const upd = {
    _id: eff?._id ?? eff?.id,
    [`flags.${FLAG_NS}.-=${HELD_FLAG}`]: null,
    [`flags.${FLAG_NS}.-=crossScene`]: null,
    [`flags.${FLAG_NS}.-=heldTurns`]: null,
    [`flags.${FLAG_NS}.directorAppliedBy`]: ns.directorAppliedBy ?? null,
    [`flags.${FLAG_NS}.bdAdopted`]: true,
    [`flags.${FLAG_NS}.heldConverted`]: true,
    "duration.rounds": null, "duration.turns": null, "duration.seconds": null,
  };
  if (ns.charges != null) upd[`flags.${FLAG_NS}.charges`] = ns.charges;
  const sc = adopted?.flags?.statuscounter;
  if (sc?.visible === true && ns.charges != null) upd["flags.statuscounter.value"] = ns.charges;
  return upd;
}

/** One entry for list(): what the GM needs to read back. */
export function describeHeld(eff) {
  const f = flagsOf(eff);
  return {
    effectId: eff?._id ?? eff?.id ?? null,
    name: eff?.name ?? "",
    statuses: statusIdsOf(eff),
    source: f.heldSource ?? "",
    turns: f.heldTurns ?? null,
  };
}
