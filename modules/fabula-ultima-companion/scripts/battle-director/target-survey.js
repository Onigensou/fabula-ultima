// Target survey — "how many creatures can this action legally target right now,
// and how many would it take?" — answered WITHOUT entering targeting mode.
//
// ── Why this exists ───────────────────────────────────────────────────────────
//
// Two different subsystems needed the same answer and each had its own:
//
//   • TARGET state (`resolveActionTargets`) built the real eligible pool from
//     the director's own dCombat, then prompted.
//   • The autopilot's ActionReader counted `canvas.tokens.placeables` by
//     disposition to decide WHICH action to take.
//
// So the decision and the execution were computed from different populations.
// Measured 2026-08-15: a guest on the Training Ground picked an all-enemy skill
// because the canvas count saw four standing rig tokens instead of the one
// Hellhound in the battle — then the real targeting hit four bystanders. The AI
// was not wrong about its own numbers; its numbers were about a different scene.
//
// The fix is not a better count. It is ONE count: this module owns the
// pre-picker half of target resolution, and `resolveActionTargets` now calls it
// rather than reimplementing it. A future change to who is targetable (a new
// AE, a new exclusion, a new category rule) lands in the pool builders and both
// the decision and the pick move together, because there is nothing to keep in
// step.
//
// ── What "targetable" means here ──────────────────────────────────────────────
//
// Everything `snapshotEligibleTargetsFromDCombat` already enforces — defeat,
// `cannot_be_targeted_by: "any"` (how a Guest is untargetable), per-attacker
// `cannot_target_uuids`, Provoked must-target, allegiance overrides — plus every
// narrowing the ACTION ITSELF declares:
//
//   `skill_target`        side + count + mode
//   `target_eligibility`  per-candidate formula gate
//   `action_pool_focus`   "only the max scorer(s)" narrowing
//   weapon range          Covered / Vanish exclusions (pass the weapon)
//
// Those four are action-declared, so the survey reads them itself. That is the
// difference between this and a `postFilter` hook: a caller-supplied closure
// puts the narrowing back OUTSIDE the survey, which is precisely how the count
// and the pick drifted apart in the first place. `postFilter` survives for the
// one case that genuinely is not a property of the action — a filter derived
// from THIS TURN's state, e.g. Study excluding already-studied creatures — and
// a survey taken without it is documented as an over-count.
//
// Nothing about targetability is DECIDED here; this module composes the existing
// primitives and stops immediately before the picker.
//
// SCOPE, precisely: this unifies the GM's TARGET state with the AI's decision.
// It does NOT cover the reaction/AoE chain, which builds its own pool in
// `skill-targeting.js` (collectCombatTokens). That path is not the old bug — it
// prefers dCombat and honours the same untargetability contract — but it is a
// third roster builder, so do not read the guarantee here as covering it.
//
// ── Deliberately synchronous ──────────────────────────────────────────────────
//
// A survey has to be answerable from inside a filter/predicate — that is the
// whole point of asking before committing to an action. Every input is already
// in memory (dCombat carries `actorDoc`), so nothing here awaits. The one place
// the old code went async (`fromUuid` per candidate, for pool focus) resolves
// synchronously through the combatant instead, which is also more correct for
// unlinked tokens.
//
// ── Combat model ──────────────────────────────────────────────────────────────
//
// The Battle Director runs its OWN `dCombat` and does not create a Foundry
// Combat document. `combat` is accepted only as a legacy fallback for the
// manual-attach path. When neither is available — or the performer is not in the
// roster — the survey reports `ok:false` rather than guessing from the canvas.
//
// ⚠ `ok:false` does NOT mean "no targets". It means "no answer", and `available`
// is null there. They must never be read as the same thing: an action whose
// survey could not run is UNKNOWN, and treating unknown as zero makes every
// action infeasible and the creature stands there doing nothing, with a
// plausible-looking reason string. The test for "nowhere to land" is
// `ok && available === 0` — never `available < 1`.

import { log, warn } from "./logger.js";
import { buildSkillResolver, evaluateFormula } from "./skill-formulas.js";
import { classifyActionIntent } from "./skill-intent.js";
import { affordableTargetCount, mpCapTargetCount } from "./skill-cost.js";
import {
  applyAttackRangeGate,
  getMaxActionTargets,
  snapshotEligibleTargets,
  snapshotEligibleTargetsFromDCombat,
} from "./snapshot.js";

// ── skill_target text parsing ────────────────────────────────────────────────

// Extract a formula-evaluable target count from a free-text `skill_target`
// field.
//
// Examples (after caller has already classified mode by the presence of
// "up to" / "all" / etc):
//   "Up to SL creatures"   isUpTo=true  → resolver(SL)
//   "up to 3 creatures"    isUpTo=true  → 3
//   "SL enemies"           isUpTo=false → resolver(SL)
//   "One creature"         isUpTo=false → 1   (via the "one"/"an" alias)
//   "3 allies"             isUpTo=false → 3
//
// On any parse failure → 1 (the safe default). Final value is clamped
// to ≥1 and floored to an integer; non-integer formulas (rare) round
// down so author intent of "SL/2" reads as "half SL targets".
//
// The noun list is generous — it strips trailing keywords like
// `creature(s) / enemy(ies) / ally/allies / target(s) / foe(s) /
// opponent(s)` so the formula lifted out is just the math expression.
//
// ⚠ CASE MATTERS. Formula identifiers are case-sensitive (`skill-formulas.js`
// resolves them through a `switch (name)` and an unknown name folds to 0), so
// the text handed in must be the AUTHORED text. Lower-casing it upstream turns
// `HAS_SKILL_PILLAGE` into an unknown identifier worth 0 — silently. See the
// note on `resolveTargetPlan`.
export function extractTargetCountFromText(text, { isUpTo, resolver }) {
  if (!text) return 1;
  let expr = isUpTo
    ? String(text).replace(/^.*?up\s+to\s+/i, "")
    : String(text);
  // Strip a trailing noun phrase so "SL creatures" → "SL" and "3
  // enemies" → "3". If nothing matches, the whole string is kept and
  // evaluated as-is (handles bare "SL" or "3").
  expr = expr.replace(/\s+(creatures?|enemies|enemy|allies|ally|targets?|foes?|opponents?)\b.*$/i, "").trim();
  // Common English number-word aliases used in skill text. RAW often
  // writes "Up to three creatures" or "One creature" — treat the word
  // forms as their numeric values. Anything beyond ten (rare in FU) the
  // author can spell as a literal digit.
  const wordNum = {
    one: 1, single: 1, a: 1, an: 1,
    two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  };
  const lookup = wordNum[expr.toLowerCase()];
  if (lookup != null) return lookup;
  if (!expr) return 1;
  const n = evaluateFormula(expr, resolver, 1);
  return Math.max(1, Math.floor(Number.isFinite(n) ? n : 1));
}

// Is this `skill_target` text the SELF case? Blank counts: an action with no
// declared target acts on its performer. Shared so the survey, the TARGET
// state and any future consumer agree on what "no target" means.
function isSelfTargetText(text) {
  const t = String(text ?? "").trim();
  return !t || /^self$/i.test(t);
}

// Which SIDE does this action target? An EXPLICIT side in `skill_target` wins
// (creature = either side; enemy; ally). The action-intent heuristic is only a
// TIEBREAKER for side-agnostic text ("One Target", "Up to 3") — it must NOT
// override an explicit "Enemy"/"Ally" (the bug that flipped Shadow Possession's
// "All Enemy" to allies because a damageless Active classifies as "aid").
// `creatureMeans` exists because this game has TWO live readings of a "Creature"
// target and the survey has to answer for whichever picker will actually run:
//   • the GM-side TARGET state reads it as EITHER side ("any") — the default here
//   • ActionReader's own targeting reads it as the OPPOSING side, and its old
//     head-count did too, so the autopilot passes "enemy"
// Hard-coding either one would make the count disagree with the pick for half the
// callers, which is the exact failure this module exists to remove. (That the two
// readings differ at all is a real inconsistency worth settling — but settling it
// changes live monster targeting, so it is a decision, not a refactor.)
function classifyTargetCategory(skillTargetText, action = null, creatureMeans = "any") {
  const text = String(skillTargetText ?? "");
  if (/creature|creatures/i.test(text)) return creatureMeans;
  if (/enem/i.test(text)) return "enemy";
  if (/\ball(?:y|ies)\b/i.test(text)) return "ally";
  const intent = action ? classifyActionIntent(action) : "harmful";
  return intent === "aid" ? "ally" : "enemy";
}

// SINGLE-SOURCE target-plan resolution. Parses a `skill_target` string into the
// picker mode + count, clamps to the eligible pool, and applies the per-target
// (×T) affordability cap — in ONE place, so every targeting site agrees. This
// exists because the parse+cap logic was duplicated across THREE call sites
// (compose-action's `composeAttack` + `resolveTargetsForSource` on the PLAYER's
// client, and `resolveActionTargets` GM-side); a cross-cutting concern like the
// affordability cap then has to be added everywhere or it silently misses the
// path a live cast actually takes. Callers keep their OWN routing (return a
// bundle / route a picker / send empty for GM-side random) but read the mode +
// count from here.
//
// Returns `{ mode, count, randomize, capped, capNote }`:
//   mode      — "random" | "all" | "up_to" | "exact". (Self is a disposition
//               fact the caller handles before calling — not a count parse.)
//   count     — targets to offer, clamped to the eligible pool (and to the
//               affordable max for up_to / random-up-to). For "all" = pool size.
//   randomize — random AND up-to (a variable random count).
//   capped    — true iff the affordability cap reduced the count.
//   capNote   — ready-to-toast string when capped (else null).
//
// `eligibleCount` = size of the already-filtered eligible pool (Infinity if the
// caller hasn't built it yet). The affordability cap fires only for the
// player-choice variable modes; "can't afford even one" is left to the
// confirm-time gate (which surfaces the precise shortfall).
//
// ⚠ Pass `skillTargetText` as AUTHORED. The GM-side caller used to lower-case it
// first, which quietly zeroed every case-sensitive identifier in a count formula
// while the player-side caller (compose-action) passed raw — so the same skill
// offered a different number of targets depending on who resolved it. Every mode
// test here is `/i`, so nothing needed the lower-casing.
export function resolveTargetPlan({ actor, skill, skillTargetText, eligibleCount = Infinity, round = 0, maxMpCost = null }) {
  const text = String(skillTargetText ?? "").trim();
  // Build the count resolver from the ACTOR alone — a backing skill Item is NOT
  // required. Literal/word counts ("Up to two creatures") and actor-derived
  // formulas (CHAR_LEVEL, CUR_HP, …) resolve without one; SL just defaults to 1.
  // This is what lets a PC weapon attack (skill === null — the equipped weapon
  // drives targeting, not a skill Item) honor a multi-target `skill_target`
  // instead of silently collapsing to a single target. extractTargetCountFromText
  // tolerates a null resolver (literal/word numbers don't need it; an actor-less
  // formula falls back to 1), so the no-actor case keeps its old "1" behavior.
  const resolver = actor
    ? buildSkillResolver({ actor, payload: null, skill, round })
    : null;
  const countFrom = (t, isUpTo) => extractTargetCountFromText(t, { isUpTo, resolver });
  const poolClamp = (n) => Math.max(1, Number.isFinite(eligibleCount) ? Math.min(n, eligibleCount) : n);

  const isRandom = /\brandom\b/i.test(text);
  const isAll    = /\ball\b/i.test(text);
  const isUpTo   = /up\s+to/i.test(text);

  let mode = "exact";
  let count = 1;
  let randomize = false;
  if (isRandom) {
    mode = "random";
    const textForCount = text.replace(/\brandom\b/gi, "").replace(/\s+/g, " ").trim();
    randomize = isUpTo;
    count = countFrom(textForCount, isUpTo);
  } else if (isAll) {
    mode = "all";
    count = Number.isFinite(eligibleCount) ? Math.max(1, eligibleCount) : 1;
  } else if (isUpTo) {
    mode = "up_to";
    count = countFrom(text, true);
  } else {
    count = countFrom(text, false);
  }
  if (mode !== "all") count = poolClamp(count);

  // Affordability cap — player-choice variable counts only (up_to / random-up-to).
  let capped = false;
  let capNote = null;

  // Fatigue single-target cap. A `max_action_targets` AE (Fatigue Advanced
  // Debuff → cap 1) no longer BLOCKS a variable "Up to X" action (the picker
  // keeps it available) — instead it clamps the target count down to the cap, so
  // the fatigued caster still acts, against a single creature. Only the variable
  // families are clamped (up_to / random-up-to), mirroring the picker gate:
  // fixed-multi (All / N creatures / Multi) stay blocked upstream. Runs before
  // the affordability/MP caps so those still narrow further if needed.
  if ((mode === "up_to" || (mode === "random" && randomize)) && count > 1) {
    const { cap, reason } = getMaxActionTargets(actor);
    if (Number.isFinite(cap) && cap < count) {
      count = Math.max(1, cap);
      capped = true;
      capNote = `${skill?.name ?? "Action"}: ${reason || "restricted"} — limited to ${count} target${count === 1 ? "" : "s"}.`;
    }
  }
  if ((mode === "up_to" || (mode === "random" && randomize)) && count > 1) {
    const cap = affordableTargetCount(actor, skill?.system?.props?.cost, count);
    if (cap.capped) {
      count = cap.count;
      capped = true;
      const resTxt = (cap.missing ?? []).map((m) => m.label).join("/") || "resources";
      capNote = `${skill?.name ?? "Action"}: only enough ${resTxt} for ${count} target${count === 1 ? "" : "s"} — capped.`;
    }
    // Free-action MP-cap clamp (Bimagus / Acceleration) — a freeOfCost ×T spell
    // pays nothing, so the affordability cap above never clamps it. Clamp the
    // up-to-N count so the spell's printed MP stays within the grant cap, so a
    // free ×T spell auto-fits the cap during targeting instead of over-picking
    // and getting bounced by COMPUTE's re-check. Same variable-count gate.
    if (maxMpCost != null && count > 1) {
      const mpCap = mpCapTargetCount(actor, skill?.system?.props?.cost, maxMpCost, count);
      if (mpCap.capped) {
        count = mpCap.count;
        capped = true;
        capNote = `${skill?.name ?? "Action"}: capped to ${count} target${count === 1 ? "" : "s"} to fit the ${Math.floor(Number(maxMpCost))} MP free-action limit.`;
      }
    }
  }
  return { mode, count, randomize, capped, capNote };
}

// ── Performer + eligible-entry resolution ────────────────────────────────────

// Accept anything that identifies the acting creature and return the shape the
// pool builders want (`combatantId` / `actorId` / `disposition`). A BD attacker
// snapshot passes through untouched; an ActionReader performer (actor doc +
// token document) is matched into the roster by token, then actor.
//
// Returns null when the performer is NOT in the roster. That has to be a
// refusal, not a default: `snapshotEligibleTargetsFromDCombat` keys self off
// `combatantId` and side off the attacker's disposition, so a fabricated
// snapshot (combatantId null, disposition 0) makes EVERY candidate classify as
// "enemy" — a not-yet-enrolled summon would report zero allies for its heal and
// the whole roster, own side included, for its all-enemy skill.
function resolvePerformerSnapshot(performer, dCombat, combat = null) {
  if (!performer) return null;
  // A ready-made BD snapshot passes through — but only if it is STILL in the
  // roster. A snapshot captured at turn start outlives the creature it describes
  // (banished, fled, killed mid-turn), and a stale combatantId would sail past
  // the check below and be treated as a live performer.
  if (performer.combatantId) {
    if (!dCombat) return performer;
    return (dCombat.combatants ?? []).some((c) => c.id === performer.combatantId)
      ? performer
      : null;
  }

  const tokenId   = performer.tokenId   ?? performer.tokenDocument?.id   ?? performer.token?.id   ?? null;
  const tokenUuid = performer.tokenUuid ?? performer.tokenDocument?.uuid ?? performer.token?.uuid ?? null;
  const actorId   = performer.actorId   ?? performer.actor?.id ?? null;

  const matches = (tokDoc, actDoc) => {
    if (tokenUuid && tokDoc?.uuid === tokenUuid) return true;
    if (tokenId && tokDoc?.id === tokenId) return true;
    if (actorId && actDoc?.id === actorId) return true;
    return false;
  };
  let combatant = (dCombat?.combatants ?? []).find((c) => matches(c.tokenDoc, c.actorDoc)) ?? null;
  // Legacy Foundry-combat roster (manual-attach). Searched too, or the refusal
  // below would reject every performer on that path.
  if (!combatant && combat?.combatants) {
    for (const c of combat.combatants) {
      if (matches(c?.token, c?.actor)) { combatant = c; break; }
    }
  }

  // Refuse on EITHER roster. The fabricated fallback below is only reachable when
  // there is no roster at all to check against; with a roster present, a
  // performer that is not in it must be a refusal, because the pool builders key
  // self off combatantId and side off the attacker's disposition — a fabricated
  // {combatantId: null, disposition: 0} makes every candidate classify as
  // "enemy", so a heal reports zero allies and an all-enemy skill sweeps in the
  // performer's own side.
  const hasRoster = Boolean(dCombat?.combatants?.length)
    || Boolean(combat?.combatants?.size || combat?.combatants?.length);
  if (hasRoster && !combatant) return null;

  return {
    combatantId: combatant?.id ?? null,
    tokenId:     combatant?.tokenDoc?.id   ?? tokenId,
    tokenUuid:   combatant?.tokenDoc?.uuid ?? tokenUuid,
    actorId:     combatant?.actorDoc?.id   ?? actorId,
    disposition: combatant?.disposition
      ?? combatant?.tokenDoc?.disposition
      ?? performer.disposition
      ?? performer.tokenDocument?.disposition
      ?? 0,
  };
}

// The live actor behind an eligible-target snapshot (the snapshots are frozen
// data by contract, so they carry ids, not docs). Roster first — that is the
// only source that is right for an UNLINKED token, whose synthetic actor is NOT
// `game.actors.get(actorId)` — then the canvas. No world-actor fallback: if the
// token is in neither, it is gone, and a per-candidate formula scored against
// the prototype would be a confidently wrong answer. Returning null drops the
// candidate, which is what the old `await fromUuid(...)` did on a stale uuid.
function eligibleActor(entry, dCombat) {
  const c = (dCombat?.combatants ?? []).find((x) => x.id === entry?.combatantId
    || (entry?.tokenUuid && x.tokenDoc?.uuid === entry.tokenUuid));
  if (c?.actorDoc) return c.actorDoc;
  const tok = entry?.tokenId ? globalThis.canvas?.tokens?.get?.(entry.tokenId) : null;
  return tok?.actor ?? null;
}

// `target_eligibility` — a per-candidate formula the ACTION declares, evaluated
// against each candidate's own actor with the performer as `sourceActorUuid`
// (e.g. Unicorn Dance's "BONDED_TO_SOURCE >= 1" → only allies Bonded to you).
// Blank = no filter, so this is a no-op for every action that doesn't use it.
//
// This lived at the TARGET call site as a closure, which meant the AI's count
// never saw it: the survey said "4 allies", the picker filtered to 0, and the
// turn aborted after the action was already committed. It is declared on the
// action, so it belongs in the survey.
function applyTargetEligibility(pool, { action, performerActor, dCombat, round }) {
  const formula = String(action?.system?.props?.target_eligibility ?? "").trim();
  if (!formula || !pool.length) return pool;
  return pool.filter((e) => {
    const cand = eligibleActor(e, dCombat);
    if (!cand) return false;
    const resolver = buildSkillResolver({
      actor: cand,
      payload: { sourceActorUuid: performerActor?.uuid ?? null },
      skill: action,
      round,
    });
    return Number(evaluateFormula(formula, resolver, 0)) > 0;
  });
}

// Action-level pool focus (e.g. "Roulette — highest Burn stack"). A skill may
// declare an effect_table row with `action_pool_focus: true` and a
// `focus_max_formula`; the eligible pool narrows to the candidate(s) with the
// MAX score of that formula (ties kept, so a downstream random pick chooses
// among them). Part of the SURVEY, not of the picker: a skill that can only
// legally reach the highest-Burn creature has that many targets available, and
// an AI asking "can I use this" must get the same answer the picker will.
function applyActionPoolFocus(pool, { action, dCombat, round }) {
  if (!action || pool.length <= 1) return pool;
  const et = action.system?.props?.effect_table ?? {};
  const focusRow = Object.values(et).find(
    (r) => r?.action_pool_focus === true && String(r?.focus_max_formula ?? "").trim()
  );
  if (!focusRow) return pool;

  let best = -Infinity;
  const scored = pool.map((e) => {
    const a = eligibleActor(e, dCombat);
    const score = a
      ? (Number(evaluateFormula(
          focusRow.focus_max_formula,
          buildSkillResolver({ actor: a, payload: null, skill: action, round }),
          0
        )) || 0)
      : -Infinity;
    if (score > best) best = score;
    return { e, score };
  });
  const narrowed = scored.filter((s) => s.score === best).map((s) => s.e);
  log(`target-survey: pool focus "${focusRow.focus_max_formula}" → ${narrowed.length} max-scorer(s) (score ${best})`);
  return narrowed;
}

// ── The survey ───────────────────────────────────────────────────────────────

/**
 * How many creatures can this action legally target, and how many would it take?
 *
 * @param {object}   opts
 * @param {object}   opts.dCombat          director-native combat (authoritative)
 * @param {object}   [opts.combat]         legacy Foundry Combat (manual-attach only)
 * @param {object}   opts.performer        BD attacker snapshot, or {actor, tokenDocument}
 * @param {Document} [opts.action]         the skill / weapon / consumable Item
 * @param {object}   [opts.weapon]         weapon snapshot, for the attack range gate
 * @param {string}   [opts.skillTargetText] overrides the action's own `skill_target`
 * @param {boolean}  [opts.excludeSelf]    drop the performer from the pool (attacks)
 * @param {Function} [opts.postFilter]     TURN-STATE narrowing only (see header)
 * @param {number}   [opts.round]          for count formulas (defaults to dCombat.round)
 * @param {number}   [opts.maxMpCost]      free-action MP ceiling, if any
 * @param {Actor}    [opts.performerActor] resolved actor doc (saves a lookup)
 * @param {string}   [opts.creatureMeans] what a "Creature" target means to the
 *                   picker that will run: "any" (GM TARGET state, default) or
 *                   "enemy" (ActionReader). See classifyTargetCategory.
 *
 * @returns {{
 *   ok: boolean, reason: string|null,
 *   available: number|null, count: number|null,
 *   category: string, mode: string, randomize: boolean,
 *   capped: boolean, capNote: string|null,
 *   eligible: object[], targetText: string, isSelf: boolean
 * }}
 *   `available` — the eligible pool size. THIS is the number to decide on.
 *   `count`     — how many of them the action would actually take.
 *   `eligible`  — the pool itself, so a caller can target FROM the survey rather
 *                 than rebuilding a pool that might not match it.
 *
 * `ok:false` (with `available:null`) means the survey could not answer, NOT that
 * there are no targets — "no targets" is `ok:true, available:0`. Use
 * `surveyFindsNoTargets()` instead of comparing `available` yourself.
 */
export function surveyActionTargets({
  dCombat = null,
  combat = null,
  performer = null,
  action = null,
  weapon = null,
  skillTargetText = null,
  excludeSelf = false,
  postFilter = null,
  round = null,
  maxMpCost = null,
  performerActor = null,
  creatureMeans = "any",
} = {}) {
  const targetText = String(
    skillTargetText ?? action?.system?.props?.skill_target ?? ""
  ).trim();
  const isSelf = isSelfTargetText(targetText);
  const unanswered = (reason, extra = {}) => ({
    ok: false, reason,
    available: null, count: null,
    category: "", mode: "", randomize: false, capped: false, capNote: null,
    eligible: [], targetText, isSelf, ...extra,
  });

  // `target_sequence` replaces skill_target resolution entirely with an ordered
  // multi-pick over named targeting rows (Blazing Tether: a Burn-holder "giver",
  // then a "receiver" excluding it). A skill_target-derived number would be
  // about a rule this action does not use, so refuse rather than mislead.
  if (String(action?.system?.props?.target_sequence ?? "").trim()) {
    return unanswered("target-sequence");
  }

  const snap = resolvePerformerSnapshot(performer, dCombat, combat);
  if (!snap) return unanswered((dCombat || combat) ? "performer-not-in-combat" : "no-performer");

  const actor = performerActor
    ?? performer?.actor
    ?? (snap.actorId ? (game.actors?.get?.(snap.actorId) ?? null) : null);
  const theRound = Number.isFinite(round) ? round : (dCombat?.round ?? 0);

  // Self needs no pool: the performer is always its own legal target, and the
  // untargetable rule is about OTHER creatures (a Guest must keep its own
  // self-targeted skills). Mirrors the isSelf carve-outs in the pool builders.
  if (isSelf) {
    return {
      ok: true, reason: null,
      available: 1, count: 1,
      category: "self", mode: "self", randomize: false,
      capped: false, capNote: null,
      eligible: [snap], targetText, isSelf: true,
    };
  }

  const category = classifyTargetCategory(targetText, action, creatureMeans);

  let eligible;
  if (dCombat?.combatants?.length) {
    eligible = snapshotEligibleTargetsFromDCombat(dCombat, snap, { category });
  } else if (combat?.combatants?.size || combat?.combatants?.length) {
    eligible = snapshotEligibleTargets(combat, snap, { category });
  } else {
    // No roster to survey. Report that we cannot answer rather than falling
    // back to the canvas — a scene-wide guess presented as a battle answer is
    // exactly the failure this module exists to remove.
    return unanswered("no-combat", { category });
  }

  // Order matches the TARGET state's: side → self → action-declared narrowing →
  // turn-state narrowing → pool focus.
  if (excludeSelf && snap.tokenUuid) {
    eligible = eligible.filter((e) => e.tokenUuid !== snap.tokenUuid);
  }
  eligible = applyTargetEligibility(eligible, { action, performerActor: actor, dCombat, round: theRound });
  if (weapon) {
    // RAW Core p.70 — Covered creatures can't be melee-targeted; Vanish likewise.
    eligible = applyAttackRangeGate(eligible, weapon);
  }
  if (postFilter) {
    // Fail CLOSED. A narrowing rule that throws must not resolve to "everyone is
    // targetable" — that is the permissive answer for an exclusion, and it would
    // make a Covered/Vanished creature targetable on an unrelated error.
    try {
      eligible = postFilter(eligible) ?? [];
    } catch (e) {
      warn("target-survey: postFilter threw — refusing to answer rather than widening the pool", e);
      return unanswered("post-filter-threw", { category });
    }
  }
  eligible = applyActionPoolFocus(eligible, { action, dCombat, round: theRound });

  const plan = resolveTargetPlan({
    actor, skill: action, skillTargetText: targetText,
    eligibleCount: eligible.length,
    round: theRound,
    maxMpCost,
  });

  // ⚠ `available` is the LENGTH of the real picker payload, built in full —
  // affinities, conditions, defenses and all — only to be counted. That looks
  // wasteful and it is deliberate: a cheap parallel "just count the dispositions"
  // fast path is precisely the two-populations design that caused the bug this
  // module exists to remove. At this game's scale (<20 combatants, on a decision
  // path that already pauses 900–2100 ms for pacing) the cost is not measurable.
  // Do not optimise this into a separate counter.
  return {
    ok: true,
    reason: eligible.length ? null : "no-eligible",
    available: eligible.length,
    count: eligible.length ? plan.count : 0,
    category,
    mode: plan.mode,
    randomize: plan.randomize,
    capped: plan.capped,
    capNote: plan.capNote,
    eligible,
    targetText,
    isSelf: false,
  };
}

// ── Who is in this battle ─────────────────────────────────────────────────────
// ActionReader has no way to know. It is a standalone subsystem by design, and
// the Battle Director creates no Foundry Combat document — the roster exists
// only as `director.dCombat`. Left to itself ActionReader falls back to
// `canvas.tokens.placeables`, i.e. every token standing on the map, so a monster
// counts scenery and leftover fixtures as enemies and then targets them.
//
// So the director hands over the one fact it owns, as a plain list of token ids.
// No BD type crosses the boundary; ActionReader's zero-import rule is intact.
// Both the pattern COUNTS and the target PICK read this same list, which is what
// stops a rule choosing an action against a roster the targeting won't honour.
//
// Defeated combatants are dropped here rather than in ActionReader: `dCombat`
// already knows what defeat means for this game (isDefeatedLive), and a corpse
// is not a participant for either purpose.
function bdParticipantRoster(director) {
  const combatants = director?.dCombat?.combatants ?? [];
  if (!combatants.length) return null;
  const tokenIds = [];
  for (const c of combatants) {
    try { if (c?.isDefeatedLive?.()) continue; } catch { /* treat as alive */ }
    const id = c?.tokenDoc?.id ?? null;
    if (id) tokenIds.push(id);
  }
  return tokenIds.length ? { source: "battle-director", tokenIds } : null;
}

// ── The ActionReader battle provider ─────────────────────────────────────────
//
// ActionReader is standalone by design and imports nothing from the director,
// but two things it cannot know are owned entirely by the director: WHO is in
// the battle (there is no Foundry Combat — the roster is `dCombat`), and how many
// creatures a given action can actually reach. Left to itself it falls back to
// `canvas.tokens.placeables`, i.e. every token on the map, so a monster counts
// scenery and leftover fixtures as enemies and then targets them.
//
// This was first solved by INJECTING those two facts onto the context at each
// pipeline entry point. That worked but had a failure mode with teeth: a missed
// entry point is silent — nothing errors, the AI just quietly goes back to
// counting the whole scene. There are three entry points (a turn, a free-action
// frame, the sim's PC brain), they were added at different times, and one of them
// WAS missed and only caught in review.
//
// So the provider is AMBIENT and resolved lazily instead. There is nothing left
// to remember at a call site, which means a new entry point cannot forget it: a
// pipeline run inside a battle gets the roster whether or not anyone threaded it.
// If the provider is absent entirely, every path degrades the same way at once —
// one loud, uniform failure rather than N silent partial ones.
//
// The boundary is unchanged and still one-directional: what crosses is a plain
// token-id list and a plain function. No director type reaches ActionReader.
const PROVIDER_KEY = "battleContext";

// Published on the module API, which is where ActionReader already looks for
// everything else, so it stays a lookup rather than an import.
export function registerBattleTargetingProvider() {
  const api = (globalThis.FUCompanion ??= {}).api ??= {};
  api[PROVIDER_KEY] = {
    /* Live token ids of everyone still standing in the current battle, or null
       out of combat (ActionReader then uses the whole scene, which is correct
       for exploration). Defeat is filtered HERE because dCombat already knows
       what defeat means for this game; ActionReader has no notion of it. */
    participantTokenIds() {
      return bdParticipantRoster(activeDirector())?.tokenIds ?? null;
    },

    /* "How many creatures can THIS action reach, right now?" A side head-count
       ("4 enemies exist") is a poor proxy: the action's own `skill_target` side
       and count, its `target_eligibility` formula and its pool focus all narrow
       it, and the picker WILL apply them — so an AI deciding on the head-count
       commits to actions that then find nothing.

       `creatureMeans: "enemy"` — ActionReader's own targeting reads a `Creature`
       target as the OPPOSING side (buildAndPickTargets' filterCandidatesByRule,
       and the old head-count did the same), while the GM-side TARGET state reads
       it as either side. Two live rules, and the survey has to answer for
       whichever picker will actually run; this provider serves the AI, so it
       passes the AI's rule. (That the two rules differ at all is a real
       inconsistency worth settling, but settling it changes live monster
       targeting — a content decision, not something to slip in here.) */
    surveyTargets(action, opts = {}) {
      const d = activeDirector();
      return surveyActionTargets({
        dCombat: d?.dCombat ?? null,
        combat:  d?.combat ?? null,
        performer: {
          actor:         opts.performerActor ?? null,
          tokenDocument: opts.performerTokenDocument ?? null,
          actorId:       opts.performerActor?.id ?? null,
        },
        performerActor:  opts.performerActor ?? null,
        action,
        weapon:          opts.weapon ?? null,
        skillTargetText: opts.skillTargetText ?? null,
        excludeSelf:     Boolean(opts.excludeSelf),
        creatureMeans:   "enemy",
      });
    },
  };
  return api[PROVIDER_KEY];
}

// Registered twice on purpose, and the call is idempotent. At import time so a
// consumer that runs before "ready" still finds it, and again on "ready" in case
// the module API object was replaced wholesale in between. Getting this wrong
// fails the same silent way the per-entry-point injection did, so it is belt and
// braces by design.
try { registerBattleTargetingProvider(); } catch (_e) { /* pre-boot; the hook covers it */ }
Hooks.once("ready", () => {
  try { registerBattleTargetingProvider(); }
  catch (e) { warn("target-survey: could not publish the battle targeting provider", e); }
});

// Explicit per-run OVERRIDE. No longer required — the provider above covers every
// entry point — but still honoured, and it is what lets a harness hand the
// pipeline a synthetic roster instead of the live battle.
export function injectActionReaderBattleContext(ctx, { director = null } = {}) {
  if (!ctx) return ctx;
  const d = director ?? activeDirector();
  ctx.participants = bdParticipantRoster(d);
  return ctx;
}

// The running director, without importing director-boot (which imports half the
// FSM and would make this module unusable from anywhere early). Same accessor
// the sim brains use.
function activeDirector() {
  try {
    return globalThis.FUCompanion?.api?.experimental?.battleDirector?.getActiveDirector?.() ?? null;
  } catch {
    return null;
  }
}
