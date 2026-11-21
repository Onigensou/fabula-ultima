// scripts/battle-director/massive-keyword.js
//
// The Massive keyword (Keyword Repository, journal VCBaZfA3PZzN4sx3):
//   "Ally of the target can help bolster the defense against this attack before
//    the attack lands; if they choose to do so, the original target gains +1 to
//    DEF and MDEF, but if the attack still hits, all the participants divide the
//    total damage equally. Massive attacks cannot be Negated."
//
// The rule lives in the KEYWORD (`massive` in the action's `action_keywords`),
// like Execute / Cripple — no per-skill reaction row and no name coupling:
//   1. Damage division — action-profile.buildPerTarget divides the action's own
//      damage by the number of targets on the action (rounded down), BEFORE each
//      target's own reduction / efficiency / affinity, so every target takes its
//      share and then applies its own defences to it.
//   2. The JOIN card — every player character on the targets' side who is NOT
//      targeted gets a built-in ask-mode reaction (state-handlers' CONFIRM
//      creature_targeted_by_action scan). Playing it is an add_target on the
//      reactor (`target_ref: "self"`), through the same card-mutation add_target
//      path the Grappled splash uses. The mutation re-derives EVERY target row,
//      so the division in (1) picks up the new target count on its own.
//      A Nox Servant never gets the card and is never a target of any Massive action
//      (selectMassiveJoiners / applyNoxMassiveGate / stripNoxServantsFromMassive; the
//      predicate is INJECTED, and a throw fails CLOSED = excluded).
//   3. +1 DEF / MDEF on each ORIGINAL target once anyone has joined (flat +1,
//      not per joiner — the rules text says "gain +1"). Inert on a no-Check action.
//   4. "Cannot be Negated" — a `negate_action` effect row never applies to a Massive
//      action, enforced at two points: (a) OFFER — CONFIRM drops a reaction whose
//      unconditional chain (menus not descended) holds a negate_action row
//      (card-mutations.dropNegatesForMassive); a negate behind an open_action_menu
//      option keeps the card (its other options stay playable); (b) APPLY — card-mutations
//      Phase 0 ignores a negate_action when the action is Massive, logging
//      "massive: cannot be negated"; the refused candidate is moved OUT of the accepted set
//      (like gmReactionCut) so RESOLVE neither fires its chain nor consumes its AE.
//      Pure decision: `phase0NegateVerdict` / `negateBlockedByMassive`. EXEMPT: a negate row
//      marked `negate_is_cost_failure: true` (Pressure's "Lose the effect" — the caster's own
//      cost failure) still negates. Scope: ONLY negate_action rows count. Crossfire's
//      accuracy-block path (adjust_accuracy -> accuracyOverride.blocked) stays UNGATED by
//      user ruling 2026-11-20 (Magic Guard: same unless ruled otherwise).
//
// The join reaction has no authored rows: it is identified by a reserved rowKey
// (`massive_join__<actorId>`, one per reactor — card decisions are keyed
// `${rowKey}:${carrierUuid}` and every joiner shares the acting skill as its
// carrier, so a shared rowKey would let one player's choice overwrite another's).
// Every reader that would look the row up on the carrier asks `massiveJoinTables`
// first. The decision snapshot that rides from the card to CONFIRM is an explicit
// field list (action-card snapshotReactionDecisions), so the rowKey is the one
// identifier guaranteed to survive the trip.
//
// Pure: no Foundry globals at import time, so node unit tests can load it.

export const MASSIVE_KEYWORD = "massive";
export const MASSIVE_JOIN_REF = "massive_join";
export const MASSIVE_JOIN_BUILTIN = "massive_join";
const ROWKEY_PREFIX = "massive_join__";

export function parseKeywordList(raw) {
  if (Array.isArray(raw)) return raw.map((s) => String(s ?? "").trim().toLowerCase()).filter(Boolean);
  return String(raw ?? "").split(/[,\n]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export function hasMassive(keywords) {
  return parseKeywordList(keywords).includes(MASSIVE_KEYWORD);
}

export function itemIsMassive(item) {
  return hasMassive(item?.system?.props?.action_keywords ?? "");
}

const isNegateRow = (r) => String(r?.effect_kind ?? "").trim().toLowerCase() === "negate_action";

// Does any effect row negate the action?
export function rowsHaveNegate(rows) {
  return (Array.isArray(rows) ? rows : []).some(isNegateRow);
}

// Opt-out marker (no CSB template column: rows inside an AE's free-form
// `flags["fabula-ultima-companion"].reactionConfig` carry any key). A negate_action
// row with `negate_is_cost_failure: true` is the CASTER'S OWN cost failure (Pressure's
// "Lose the effect"), not an enemy negating the attack, so Massive does not block it.
export const NEGATE_COST_FAILURE_KEY = "negate_is_cost_failure";
export function negateRowIsCostFailure(row) {
  const v = row?.[NEGATE_COST_FAILURE_KEY];
  return v === true || v === 1 || /^(true|1|yes)$/i.test(String(v ?? "").trim());
}

// A negate row Massive blocks: a negate_action that is NOT marked a cost failure.
export function rowsHaveBlockableNegate(rows) {
  return (Array.isArray(rows) ? rows : []).some((r) => isNegateRow(r) && !negateRowIsCostFailure(r));
}

// The single rule: a Massive action cannot be Negated. True = this negate must
// NOT apply / the negating reaction must not be offered.
export function negateBlockedByMassive(massive, rows) {
  return !!massive && rowsHaveBlockableNegate(rows);
}

// Phase 0 verdict for one accepted candidate's chosen rows:
//   "none"    no negate row;  "negate"  negates (non-Massive, or exempt cost failure);
//   "refused" Massive blocked it — caller must move the candidate OUT of the accepted
//             set so RESOLVE neither fires its chain nor consumes its AE.
export function phase0NegateVerdict(massive, rows) {
  if (!rowsHaveNegate(rows)) return "none";
  return negateBlockedByMassive(massive, rows) ? "refused" : "negate";
}

// One target's share of a Massive action's damage: floor(amount / targets).
export function massiveShare(amount, targetCount) {
  const n = Math.max(1, Math.floor(Number(targetCount) || 1));
  return Math.floor((Number(amount) || 0) / n);
}

// +1 DEF / MDEF on an original target once someone has joined.
export function massiveDefenseBonus(target, targets) {
  if (target?.addedVia?.massive) return 0;
  return (Array.isArray(targets) && targets.some((t) => t?.addedVia?.massive)) ? 1 : 0;
}

export function massiveJoinRowKey(actorId) {
  return `${ROWKEY_PREFIX}${String(actorId ?? "")}`;
}

export function isMassiveJoinRowKey(rowKey) {
  return String(rowKey ?? "").startsWith(ROWKEY_PREFIX);
}

// The built-in rows. reaction_source "ally" so the reaction hand words it as
// "When a creature is targeted" (not "When you are targeted").
export const MASSIVE_JOIN_REACTION_ROW = Object.freeze({
  reaction_trigger: "creature_targeted_by_action",
  reaction_source: "ally",
  reaction_passive_mode: "ask",
  reaction_responder: "bystander",
  reaction_effect_ref: MASSIVE_JOIN_REF,
});
export const MASSIVE_JOIN_EFFECT_TABLE = Object.freeze({
  "0": Object.freeze({ effect_label: MASSIVE_JOIN_REF, effect_kind: "add_target", target_ref: "self" }),
});

// { reaction_config_table, effect_table } for a join rowKey, else null.
export function massiveJoinTables(rowKey) {
  if (!isMassiveJoinRowKey(rowKey)) return null;
  return {
    reaction_config_table: { [String(rowKey)]: { ...MASSIVE_JOIN_REACTION_ROW } },
    effect_table: { "0": { ...MASSIVE_JOIN_EFFECT_TABLE["0"] } },
  };
}

// Player character = no npc_rank (the codebase's canonical PC test — see
// defeat-reactor.isPlayerCharacter / invoke-core).
export function isPlayerCharacterActor(actor) {
  return !String(actor?.system?.props?.npc_rank ?? "").trim();
}

// Who is offered the join card: each combatant that is
//   - not defeated (KO'd = 0 HP), not the action-taker, not already a target,
//   - a player character (no npc_rank), and not a summon / phantasm / guest,
//   - on the side of at least one target (an ally of the threatened creatures).
// `isSummonCombatant(c)` is injected (summon-autopilot.js in play) so this stays pure.
export function selectMassiveJoiners({ combatants, targets, attackerActorUuid = null, isSummonCombatant = null, isNoxServant = null } = {}) {
  const list = Array.isArray(combatants) ? combatants : [];
  const tgts = Array.isArray(targets) ? targets : [];
  const tgtTok = new Set(tgts.map((t) => t?.tokenUuid).filter(Boolean));
  const tgtAct = new Set(tgts.map((t) => t?.actorUuid).filter(Boolean));
  const tokOf = (c) => c?.tokenUuid ?? c?.tokenDoc?.uuid ?? null;
  const actOf = (c) => c?.actorDoc?.uuid ?? c?.actorUuid ?? null;
  const sides = new Set();
  for (const c of list) {
    if (tgtTok.has(tokOf(c)) || tgtAct.has(actOf(c))) sides.add(String(c?.side ?? ""));
  }
  const out = [];
  const seen = new Set();
  for (const c of list) {
    const actor = c?.actorDoc ?? null;
    const au = actOf(c);
    if (!actor || !au || seen.has(au)) continue;
    if (isDownCombatant(c)) continue;
    if (attackerActorUuid && au === attackerActorUuid) continue;
    if (tgtAct.has(au) || tgtTok.has(tokOf(c))) continue;
    if (!isPlayerCharacterActor(actor)) continue;
    if (typeof isSummonCombatant === "function" && isSummonCombatant(c)) continue;
    if (typeof isNoxServant === "function") {
      let nox = true; // fail CLOSED: a throwing predicate means no card
      try { nox = !!isNoxServant(actor); } catch (_) { nox = true; }
      if (nox) continue;
    }
    if (!sides.has(String(c?.side ?? ""))) continue;
    seen.add(au);
    out.push(c);
  }
  return out;
}

// Fail-closed Servant test: a throwing / missing predicate result counts as "is a Servant".
function noxSafe(isNoxServant, subject) {
  try { return !!isNoxServant(subject); } catch (_) { return true; }
}

// Pick-time gate: a Massive skill / weapon never offers a Nox Servant.
// `actorOf(entry)` maps a pool entry to its actor (injected); `isNoxServant(actor)` likewise.
export function applyNoxMassiveGate(eligible, { action = null, weapon = null, isNoxServant = null, actorOf = null } = {}) {
  const list = Array.isArray(eligible) ? eligible : [];
  if (typeof isNoxServant !== "function") return list;
  if (!(itemIsMassive(action) || hasMassive(weapon?.system?.props?.action_keywords ?? weapon?.action_keywords ?? ""))) return list;
  return list.filter((e) => {
    let actor = null;
    try { actor = typeof actorOf === "function" ? actorOf(e) : e; } catch (_) { return false; }
    return !noxSafe(isNoxServant, actor);
  });
}

// CONFIRM backstop: drop Servants from a Massive action's targets (mutates `ar`).
// `isNoxServant(entry)` takes a target entry. Returns { removed:[names], remaining:n }.
export function stripNoxServantsFromMassive(ar, isNoxServant) {
  const removed = [];
  if (!ar || typeof isNoxServant !== "function") return { removed, remaining: Array.isArray(ar?.targets) ? ar.targets.length : 0 };
  const gone = new Set();
  const targets = Array.isArray(ar.targets) ? ar.targets : [];
  const keep = [];
  for (const t of targets) {
    if (noxSafe(isNoxServant, t)) { removed.push(String(t?.name ?? t?.actorName ?? t?.tokenUuid ?? "?")); if (t?.tokenUuid) gone.add(t.tokenUuid); }
    else keep.push(t);
  }
  if (!removed.length) return { removed, remaining: targets.length };
  ar.targets = keep;
  if (Array.isArray(ar.perTargetResults)) ar.perTargetResults = ar.perTargetResults.filter((p) => !gone.has(p?.tokenUuid));
  if (Array.isArray(ar.targetTokenUuids)) ar.targetTokenUuids = ar.targetTokenUuids.filter((u) => !gone.has(u));
  return { removed, remaining: keep.length };
}

// Non-mutating twin for a FROZEN actionResult (freezeActionResult deep-freezes ctx.actionResult, so
// the in-place strip above throws in strict mode). Returns { ar: <copy, or the input when nothing
// was removed>, removed, remaining }. The caller re-freezes the copy into director.ctx.actionResult.
export function stripNoxServantsFromMassiveCopy(ar, isNoxServant) {
  if (!ar || typeof isNoxServant !== "function") return { ar, removed: [], remaining: Array.isArray(ar?.targets) ? ar.targets.length : 0 };
  const copy = { ...ar };
  if (Array.isArray(ar.targets)) copy.targets = [...ar.targets];
  if (Array.isArray(ar.perTargetResults)) copy.perTargetResults = [...ar.perTargetResults];
  if (Array.isArray(ar.targetTokenUuids)) copy.targetTokenUuids = [...ar.targetTokenUuids];
  const r = stripNoxServantsFromMassive(copy, isNoxServant);
  return { ar: r.removed.length ? copy : ar, removed: r.removed, remaining: r.remaining };
}

// KO'd: DirectorCombatant.defeated is a field nothing sets today, so read the live
// HP the way DirectorCombatant#isDefeatedLive does (and use it when present).
export function isDownCombatant(c) {
  if (!c) return true;
  if (c.defeated) return true;
  if (typeof c.isDefeatedLive === "function") { try { return !!c.isDefeatedLive(); } catch (_) { /* fall through */ } }
  const hp = c.actorDoc?.system?.props?.current_hp;
  if (hp == null || hp === "") return false;
  const n = typeof hp === "number" ? hp : Number(String(hp).replace(/[^0-9-]/g, ""));
  return Number.isFinite(n) && n <= 0;
}

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));

// The card candidate for one joiner (the scan stamps reactor identity + payload).
export function buildMassiveJoinCandidate({ skill, reactorActor }) {
  const name = String(skill?.name ?? "the attack");
  return {
    carrierKind: "item",
    carrierUuid: skill?.uuid ?? null,
    carrierName: `Join: ${name}`,
    carrierImg: skill?.img ?? null,
    carrierDescription: `<p>Step into <strong>${esc(name)}</strong> as an additional target. Its damage is divided `
      + `<strong>equally</strong> among all of its targets <em>(rounded down)</em>, and every original target gains `
      + `<strong>【+1 DEF and M.DEF】</strong> against it.</p>`,
    rowKey: massiveJoinRowKey(reactorActor?.id ?? reactorActor?.uuid ?? ""),
    kind: "manual",
    mode: "ask",
    ref: MASSIVE_JOIN_REF,
    usesAddTarget: true,
    available: true,
    unavailableKind: null,
    unavailableReason: null,
    builtin: MASSIVE_JOIN_BUILTIN,
  };
}
