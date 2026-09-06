// Skill targeting — director-native equivalent of legacy
// `FUCompanion.api.effectTargeting.resolveTargetRef`.
//
// Every effect_kind that touches tokens (grant, apply_ae, consume_charge,
// consume_resource, redirect_target, open_action_menu) reads its target
// list via `target_ref`, which points at a `targeting`-kind row in the
// same `effect_table`. This file resolves that ref into a concrete
// `TokenDocument[]`.
//
// **Inline-ref sugar (B.1 win)** — `target_ref` accepts more than just a
// row label:
//   "self"                                  → reserved word
//   { candidate_source: "self", ... }       → inline targeting row (object)
//   "label"                                 → look up `label` in effect_table
//
// The schema's full `targeting` row shape is supported when the ref is
// an object or resolves to a row; sugar forms expand to the minimum
// valid object.
//
// Resolution is **lazy** (only fires when a consumer asks) and
// **memoized** in a per-chain `resolvedTargets` Map — multiple effects
// referencing the same target_ref see the same tokens.
//
// candidate_source values (from schema doc):
//   combat            — every combatant in the current encounter
//   trigger_subject   — the creature the trigger is about
//   trigger_actor     — the acting creature on the source side
//   action_targets    — the originating action card's targets
//   self              — reactor only

import { log, warn } from "./logger.js";
import { requestTargeting as requestBdTargetPicker } from "./target-picker.js";
import { isGrappled, tokensGrappledBy } from "./grappled.js";
import { getAllegianceOverrides, applyAllegianceOverride, hasUnconditionalTargetBlock } from "./snapshot.js";

// Reserved strings that expand to inline targeting rows. Authoring sugar
// — saves a row from the effect_table for the most common case.
const RESERVED_REFS = {
  self:                  { candidate_source: "self" },
  self_or_my_focus:      { candidate_source: "self_or_my_focus", mode: "exact", count: 1 },
  // The action-target family references tokens the player ALREADY picked + confirmed
  // at the card's TARGET state. Re-surfacing a locked-confirm when an effect row
  // (apply_ae / status rider) later resolves them is a redundant second targeting
  // prompt post-card — so these resolve silently (auto_target: "skip"). Without it
  // the default ("confirm") double-prompts a pure status-on-action_targets skill
  // like Elemental Shroud (no deal_damage to prime the resolveTargetRef cache).
  action_targets:        { candidate_source: "action_targets", mode: "all", auto_target: "skip" },
  hit_action_targets:    { candidate_source: "hit_action_targets", mode: "all", auto_target: "skip" },
  ally_action_targets:   { candidate_source: "action_targets", category: "ally", mode: "all", auto_target: "skip" },
  enemy_action_targets:  { candidate_source: "action_targets", category: "enemy", mode: "all", auto_target: "skip" },
  trigger_actor:         { candidate_source: "trigger_actor", mode: "exact", count: 1 },
  trigger_attacker:      { candidate_source: "trigger_attacker", mode: "exact", count: 1 },
  trigger_subject:       { candidate_source: "trigger_subject", mode: "exact", count: 1 },
  // The creature that CAUSED the reactor's resource change — DISTINCT from
  // trigger_actor, which for a creature_lose_resource event reads the SUBJECT
  // (= the reactor itself, the creature whose resource changed). Reads
  // payload.causeTokenUuid (the attacker/source stamped by fireResourceChangeTrigger).
  // Painful Lesson reacts to "you lost HP" (subject = self) but Studies the CAUSE.
  cause_actor:           { candidate_source: "cause_actor", mode: "exact", count: 1 },
  // Guard's optional covered ally (resolveAction-unification). mode "all" takes
  // the (0 or 1) token collectCoverTarget yields without prompting.
  cover_target:          { candidate_source: "cover_target", mode: "all" },
  // Creatures that FAILED the most recent `save_check` this chain (populated on
  // ctx.saveFailedTokenUuids). Used by follow-up apply_ae rows (Dreadwyrm: the
  // failures suffer Frightened/Paralyzed/Silence). mode "all" → every failure.
  save_failed_targets:   { candidate_source: "save_failed_targets", mode: "all" },
  // Creatures that LOST / WON the most recent `contest_check` this chain
  // (ctx.contestLostTokenUuids / ctx.contestWonTokenUuids). The contest twin of
  // save_failed_targets, and the reason there are two of them: unlike a save,
  // a contest has a meaningful winner, so "you kept your grip on it" is an
  // authorable consequence and not just the absence of one.
  contest_lost_targets:  { candidate_source: "contest_lost_targets", mode: "all" },
  contest_won_targets:   { candidate_source: "contest_won_targets",  mode: "all" },
  // Magnitude buckets from the most recent `save_check` that declared
  // `save_tiers` (populated on ctx.saveTierTokenUuids). Thresholds are CUMULATIVE
  // and descending, so save_tier_1 is the widest pool and each later tier is a
  // subset of it: N rows aimed at successive tiers land N consequences on the
  // worst roller and one on the luckiest (Carlbero's Stinky Breath). Empty
  // whenever the save_check carried no save_tiers. mode "all" → every target in
  // the bucket. Keep this count in step with SAVE_TIER_MAX in skill-effects.js.
  save_tier_1:           { candidate_source: "save_tier_1", mode: "all" },
  save_tier_2:           { candidate_source: "save_tier_2", mode: "all" },
  save_tier_3:           { candidate_source: "save_tier_3", mode: "all" },
  save_tier_4:           { candidate_source: "save_tier_4", mode: "all" },
  save_tier_5:           { candidate_source: "save_tier_5", mode: "all" },
  save_tier_6:           { candidate_source: "save_tier_6", mode: "all" },
  save_tier_7:           { candidate_source: "save_tier_7", mode: "all" },
  save_tier_8:           { candidate_source: "save_tier_8", mode: "all" },
  // The reactor's own summoned Numen (summonedBy == me + actor isNumen). A Numen
  // subset of own_summons that EXCLUDES phantasms — used by Create Phantasm: Numen's
  // turn_start reaction so take_turn_next force-moves only the Numen. mode "all"
  // takes the (0 or 1) Numen without prompting.
  own_numen:             { candidate_source: "own_numen", mode: "all" },
  // ALL the reactor's own summons (phantasms + Numen). target_ref sugar for the
  // candidate_source of the same name, so a row can `target_ref: "own_summons"`
  // (Zero Power shatters every summon). mode "all" → every own summon, no prompt.
  own_summons:           { candidate_source: "own_summons", mode: "all" },
  // The reactor's own PERSISTENT summons (Birth of the Cruel's reanimated Minion,
  // a captured monster). Unlike own_summons — which reads the combat/canvas token
  // list and is therefore EMPTY outside a conflict — this walks `game.actors` for
  // the persisted world Actor, so an out-of-conflict trigger (party_rested) can
  // still act on a standing minion that has no token anywhere. mode "all" -> every
  // persistent summon, no prompt.
  own_persistent_summons: { candidate_source: "own_persistent_summons", mode: "all" },
  // The reactor's own reanimated MINIONS, by live token (Birth of the Cruel).
  // The token-identity twin of own_persistent_summons, and the clone-specific
  // twin of own_numen: combat-roster tokens carrying `cloneActorUuid`.
  //
  // 🩸 Neither neighbour can stand in for it on a free_action grant. A
  // performer_ref reads `pr.tokens[0]` and needs a real TokenDocument:
  // own_persistent_summons yields an ACTOR CARRIER by design (it would enqueue an
  // Actor uuid into `reactorTokenUuid`), and own_summons returns the Numen and the
  // phantasms too — with both a Numen and a Minion out, [0] is a coin flip and the
  // Minion's grant lands on the Numen. mode "all" -> every own minion, no prompt.
  own_minions:           { candidate_source: "own_minions", mode: "all" },
};

// The reserved target_ref vocabulary, published for the reaction-config lint.
// It used to keep its OWN hand-written copy of this list, which had already gone
// stale for own_summons / own_numen / last_summoned / self_or_my_focus /
// trigger_attacker — every one of them reported a false TARGET_REF_UNRESOLVED.
// Derive, don't mirror.
export const RESERVED_TARGET_REF_NAMES = Object.freeze(Object.keys(RESERVED_REFS));

// Reserved target_ref PREFIXES — families resolved by prefix in
// buildCandidatePool rather than by a registry key, so a new persistent-summon
// kind needs no entry here. Published for the same reason the names are: the
// reaction lint would otherwise report TARGET_REF_UNRESOLVED on
// `own_persistent_summons_minion` — a perfectly good ref — and the last time that
// list was a hand-written mirror it had already drifted on five entries.
export const RESERVED_TARGET_REF_PREFIXES = Object.freeze([
  "own_persistent_summons_",
  "own_summon_tokens_",
]);

// THE single source of truth for "is this authored target_ref a reserved word".
//
// Returns the targeting CONFIG to resolve, or null. `resolveTargetRef` consumes it
// and `isReservedTargetRef` (published for the reaction lint) is defined AS it, on
// purpose: the first cut had the lint answering from the prefix list while
// resolveTargetRef answered from `RESERVED_REFS` alone, so every
// `own_persistent_summons_<kind>` ref fell through to the effect_table lookup,
// returned `no-row`, and resolved NOTHING — while the lint reported it valid. The
// two must not be able to disagree again.
//
// A prefixed ref passes its full name through as the candidate_source; the prefix
// families are dispatched by `buildCandidatePool`. mode "all" mirrors the
// un-suffixed entries — take every match, never prompt.
function reservedRefConfigFor(key) {
  const k = String(key ?? "").trim();
  if (!k) return null;
  if (Object.prototype.hasOwnProperty.call(RESERVED_REFS, k)) return RESERVED_REFS[k];
  for (const p of RESERVED_TARGET_REF_PREFIXES) {
    if (k.startsWith(p) && k.length > p.length) return { candidate_source: k, mode: "all" };
  }
  return null;
}

/** Does this authored target_ref resolve to a reserved word or reserved family? */
export function isReservedTargetRef(ref) {
  return reservedRefConfigFor(ref) !== null;
}

try {
  globalThis.FUCompanion = globalThis.FUCompanion || {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
  globalThis.FUCompanion.api.targetRefs = {
    reserved: new Set(RESERVED_TARGET_REF_NAMES),
    prefixes: [...RESERVED_TARGET_REF_PREFIXES],
    isReserved: isReservedTargetRef,
  };
} catch (_e) { /* non-Foundry context (node --check, tooling) */ }

// Public — resolve a target_ref to a token list within a chain context.
// Returns `{ ok, tokens: TokenDocument[], reason? }`. `ok: false` aborts
// the consuming effect with the given reason.
export async function resolveTargetRef(targetRef, ctx) {
  if (targetRef == null || targetRef === "") {
    return { ok: false, reason: "no-target-ref", tokens: [] };
  }
  ctx = ctx ?? {};
  if (!ctx.resolvedTargets) ctx.resolvedTargets = new Map();

  // Inline object — treat as the targeting row directly. Don't memoize
  // by reference (object identity isn't stable across rebuilds).
  if (typeof targetRef === "object") {
    return resolveTargetingRow(targetRef, ctx);
  }

  const key = String(targetRef);

  // Memoize per chain — multiple consumers should see the same tokens.
  if (ctx.resolvedTargets.has(key)) return ctx.resolvedTargets.get(key);

  // Pre-card CAPTURE replay: if this ref's pick was captured in pre_activate
  // (applyTargetingEffect → ctx.payload._capturedTargets[label], rehydrated onto
  // the ctx at RESOLVE), return those tokens instead of re-prompting. Lets
  // Detonate pick the Phantasm once, before the card, then reuse it.
  const captured = ctx?.payload?._capturedTargets?.[key];
  if (Array.isArray(captured) && captured.length) {
    const toks = await uuidsToTokens(captured);
    const result = { ok: toks.length > 0, tokens: toks, reason: toks.length ? undefined : "captured-gone" };
    ctx.resolvedTargets.set(key, result);
    return result;
  }

  // Multi-ref union — "a,b,c" resolves each ref and unions their tokens
  // (dedup by uuid). Lets one effect row target several named picks at once
  // (Blazing Tether detonates giver + receiver via target_ref "giver,receiver").
  // Each sub-ref resolves + memoizes on its own, so already-resolved picks are
  // cache hits (no re-prompt); a cancel in any part cancels the whole union.
  if (key.includes(",")) {
    const parts = key.split(",").map((s) => s.trim()).filter(Boolean);
    const seen = new Set();
    const tokens = [];
    let anyOk = false;
    let firstReason = null;
    for (const part of parts) {
      const r = await resolveTargetRef(part, ctx);
      if (r?.cancelled) {
        const cancelled = { ok: false, cancelled: true, reason: "cancelled", tokens: [] };
        ctx.resolvedTargets.set(key, cancelled);
        return cancelled;
      }
      if (r?.ok) {
        anyOk = true;
        for (const t of (r.tokens ?? [])) {
          const u = t?.uuid ?? t?.document?.uuid ?? null;
          if (u == null) { tokens.push(t); continue; }
          if (!seen.has(u)) { seen.add(u); tokens.push(t); }
        }
      } else if (firstReason == null) {
        firstReason = r?.reason ?? "no-targets";
      }
    }
    const result = anyOk
      ? { ok: true, tokens }
      : { ok: false, reason: firstReason ?? "no-targets", tokens: [] };
    ctx.resolvedTargets.set(key, result);
    return result;
  }

  // Reserved word sugar — exact names AND the prefix families
  // (own_persistent_summons_<kind> / own_summon_tokens_<kind>).
  const reservedCfg = reservedRefConfigFor(key);
  if (reservedCfg) {
    const result = await resolveTargetingRow(reservedCfg, ctx);
    ctx.resolvedTargets.set(key, result);
    return result;
  }

  // Look up the labelled targeting row in the skill's effect_table
  // (or ctx.runtimeEffectTable if a recipe overlay is in play).
  const row = findTargetingRow(ctx, key);
  if (!row) {
    warn(`skill-targeting: target_ref "${key}" not found in effect_table`);
    const fail = { ok: false, reason: "no-row", tokens: [] };
    ctx.resolvedTargets.set(key, fail);
    return fail;
  }
  const result = await resolveTargetingRow(row, ctx);
  ctx.resolvedTargets.set(key, result);
  return result;
}

function findTargetingRow(ctxOrSkill, label) {
  if (!ctxOrSkill || !label) return null;
  const isCtx = ctxOrSkill.skill !== undefined || ctxOrSkill.runtimeEffectTable !== undefined;
  const skill = isCtx ? ctxOrSkill.skill : ctxOrSkill;
  const tables = [
    isCtx ? ctxOrSkill.runtimeEffectTable : null,
    skill?.system?.props?.effect_table,
    skill?.system?.props?.reaction_effect_table,  // legacy alias
  ];
  for (const table of tables) {
    if (!table) continue;
    for (const key of Object.keys(table)) {
      const row = table[key];
      if (!row || row.$deleted) continue;
      if (row.effect_kind !== "targeting") continue;
      if (row.effect_label === label) return row;
    }
  }
  return null;
}

// ── Targeting row resolver ───────────────────────────────────────────────

// How many targets this row wants. Numeric strings short-circuit (the common
// case — no resolver build, no import); anything else goes through the skill
// formula evaluator against the REACTOR (so SL is the carrier skill's level).
async function resolveRowCount(row, ctx) {
  const raw = row.count ?? 1;
  const asNum = Number(raw);
  if (Number.isFinite(asNum)) return Math.max(0, Math.floor(asNum) || 1);
  const formula = String(raw).trim();
  if (!formula) return 1;
  try {
    const { buildSkillResolver, evaluateFormula } = await import("./skill-formulas.js");
    const resolver = buildSkillResolver({
      actor: ctx.reactorActor, payload: ctx.payload, skill: ctx.skill,
      round: ctx.dCombat?.round ?? 0,
    });
    const n = Math.floor(Number(evaluateFormula(formula, resolver, 1)) || 0);
    return Math.max(0, n) || 1;
  } catch (e) {
    warn(`skill-targeting: row "${row.effect_label}" count formula "${formula}" threw — using 1`, e);
    return 1;
  }
}

async function resolveTargetingRow(row, ctx) {
  const candidateSource = String(row.candidate_source ?? "combat").trim();
  const category = String(row.category ?? "").trim().toLowerCase();
  const mode = String(row.mode ?? "exact").trim().toLowerCase();
  // `count` is FORMULA-AWARE — a plain number still works ("2"), but an
  // SL-scaled row can write `count: "SL"` instead of baking the author's
  // current skill level into the data. That matters for a skill shared across
  // copies at different levels (Linked Invocation: Blanche SL 1, Chiyo SL 2) —
  // a literal would be wrong for one of them the moment either levels up.
  // Falls back to 1 on an unparseable/zero formula, matching the old default.
  const count = await resolveRowCount(row, ctx);
  const excludeSelf = !!row.exclude_self;
  const autoConfirm = row.auto_confirm_when_obvious !== false;       // default true
  const skipWhenPassive = row.skip_when_passive !== false;            // default true
  // allow_empty — this targeting row may legitimately resolve to ZERO targets
  // (e.g. "the REST of the enemies" when there is only one, so exclude empties
  // the pool). Without it, an empty pool returns ok:false, which HALTS the
  // enclosing chain (skill-effects.applyChainEffect stops on any !ok step) —
  // dropping later steps like the apply that should still run. With it, an empty
  // pool resolves to an empty set so dependent target_ref applies just no-op and
  // the chain continues. Opt-in → no behavior change for existing rows.
  const allowEmpty = !!row.allow_empty;
  const emptyResult = () => allowEmpty
    ? { ok: true, tokens: [] }
    : { ok: false, reason: "no-candidates", tokens: [] };
  // Auto-target mode — what happens on an ASSURED target (self / all / single):
  //   "skip"    → resolve silently, never prompt
  //   "confirm" → always show a locked Confirm (pre-selected, can't change)
  //   "auto"    → ROLE-BASED: the GM resolves silently (better pace when running
  //               NPCs), but a PLAYER gets the locked Confirm so they see what
  //               their action is committing to.
  //   absent    → DEFAULT is "confirm": even an obvious target gets a locked
  //               Confirm pass so nothing commits silently. A row opts back into
  //               silent resolution with auto_target:"skip" (or the old role-based
  //               behavior with auto_target:"auto").
  // Legacy boolean tolerated (true = skip, false = confirm).
  const _at = row.auto_target;
  // Did the AUTHOR explicitly set auto_target on this row (vs. the absent
  // default)? An explicit value is a deliberate UX choice that OVERRIDES a
  // caller's _skipTargetConfirm suppression below.
  const explicitAuto = _at !== undefined && _at !== null
    && !(typeof _at === "string" && _at.trim() === "");
  const autoMode = _at === true ? "skip" : _at === false ? "confirm"
    : String(_at ?? "confirm").trim().toLowerCase();
  const isGM = !!game.user?.isGM;
  // A caller may suppress the locked-confirm for ASSURED sets via
  // ctx._skipTargetConfirm. applyEffectRow sets it for every consequence effect
  // kind (everything except `targeting` / `add_target`), so an effect lands on its
  // already-decided target (self / cover ally / action targets) without a
  // redundant second acknowledgement post-card. But that suppression governs only
  // the DEFAULT (absent auto_target) confirm — an EXPLICIT author auto_target wins.
  // Otherwise a reaction that delegates its PRIMARY pick into a consequence's
  // target_ref (Cognitive Focus: cf_apply → cf_pick, auto_target:"confirm") loses
  // its one confirm, because apply_ae sets _skipTargetConfirm before resolving the
  // ref. This only affects the assured path; a genuine multi-candidate PICK
  // (pool > count) still prompts below.
  const suppress = !!ctx?._skipTargetConfirm && !explicitAuto;
  const autoTarget = suppress ? true
    : autoMode === "skip" ? true
    : autoMode === "auto" ? isGM
    : false;   // "confirm" (and the absent default) → always locked-confirm

  // 1. Build candidate pool.
  let pool = await buildCandidatePool(candidateSource, ctx);
  if (!pool.length) return emptyResult();

  // 1b. Action eligibility ceiling. When the driving action supplies the list of
  // targets it can actually reach, the pool may not exceed it — what the picker
  // OFFERS must equal what the apply can ACCEPT.
  //
  // Why this exists: an attack's own target list is range-gated by
  // applyAttackRangeGate (Cover blocks melee, Flying blocks melee), but
  // candidate_source "combat" is filtered only by hasUnconditionalTargetBlock,
  // which fires solely on `ranges.has("any")`. So a melee add_target (Bladestorm)
  // would list a Covered or Flying enemy, and onAddTargetApply — which resolves
  // picks against director.ctx.eligibleTargets — would silently drop the pick
  // ("cancelled", pill stays pending, no notification). Barrage never exposed
  // this because it is ranged and both blocks are melee-only.
  //
  // Deliberately a general ceiling rather than a range check here: the targeting
  // row stays ignorant of range, and any caller that knows its own reach can
  // impose it. Absent or empty ⇒ no ceiling, so every existing caller is
  // unaffected.
  //
  // SCOPE — the ceiling applies ONLY to the broad combat pool. Every other
  // candidate_source is an already-DERIVED set (self, the trigger actor, my own
  // summons, the action targets already picked); ceilinging those is wrong, and
  // it was actively BREAKING Barrage. Its chain is "barrage_add, barrage_cost",
  // and barrage_cost is an adjust_cost row with target_ref "self". The reserved
  // ref "self" resolves through THIS function, and an attacker is never in its
  // own attack's eligible-target list — so the pool emptied, the row returned
  // ok:false, and the chain aborted AFTER the pick: pill left pending, no cost
  // charged. A probe cannot see this (it discovers candidates, it never runs
  // the chain), which is why the change read as green.
  const eligibleCeiling = candidateSource === "combat"
    ? ctx.payload?._eligibleTokenUuids
    : null;
  if (Array.isArray(eligibleCeiling) && eligibleCeiling.length) {
    const allowed = new Set(eligibleCeiling);
    const before = pool.length;
    pool = pool.filter((t) => allowed.has(t.uuid));
    if (pool.length !== before) {
      log(`targeting: eligibility ceiling dropped ${before - pool.length} unreachable candidate(s)`);
    }
    if (!pool.length) return emptyResult();
  }

  // 2. Category filter (disposition vs reactor).
  if (category) {
    pool = pool.filter((t) => matchesCategory(t, category, ctx));
  }

  // 3. exclude_self.
  if (excludeSelf && ctx.reactorToken?.uuid) {
    pool = pool.filter((t) => t.uuid !== ctx.reactorToken.uuid);
  }

  // 3b. exclude_action_targets — drop tokens already in the action's target
  // list. Used by add_target augments (Barrage) that must pick an ADDITIONAL
  // target, never one already being attacked.
  if (row.exclude_action_targets) {
    const already = new Set(
      ctx.actionTargetUuids
      ?? ctx.payload?.targetTokenUuids
      ?? ctx.payload?.targets
      ?? []
    );
    if (already.size) pool = pool.filter((t) => !already.has(t.uuid));
  }

  // 3c. exclude — generic membership exclusion. Drop any candidate appearing in
  // the resolved token set of the listed ref(s). One field covers every case:
  // reserved refs ("self", "action_targets") AND named targeting rows, comma-
  // listed for combinations ("self,tether_giver"). Resolves through
  // resolveTargetRef (which already unions a comma list), so a prior chain
  // step's pick is a cache hit — no re-prompt. Subsumes the legacy
  // exclude_self / exclude_action_targets booleans (still honored above for
  // existing data); new authoring uses `exclude`.
  if (row.exclude) {
    const r = await resolveTargetRef(String(row.exclude), ctx);
    const excluded = new Set();
    for (const t of (r?.tokens ?? [])) {
      const u = t?.uuid ?? t?.document?.uuid ?? null;
      if (u) excluded.add(u);
    }
    if (excluded.size) pool = pool.filter((t) => !excluded.has(t.uuid ?? t.document?.uuid));
  }

  // 3d. target_filter — per-candidate predicate formula. Keep a token when the
  // formula is truthy (> 0), evaluated against THAT candidate's own actor (a
  // resolver per token, like deal_damage does per victim). Generic gate: e.g.
  // "AE_CHARGES_BURN >= 1" (Blazing Tether's giver must carry Burn). Exclusion
  // is just the inverse — "AE_CHARGES_BURN == 0" / "!(...)" (the formula
  // language has full <,>,==,!=,&&,||,! support), so one keep-if-truthy field
  // covers both directions.
  const filterFormula = String(row.target_filter ?? "").trim();
  if (filterFormula) {
    const { buildSkillResolver, evaluateFormula } = await import("./skill-formulas.js");
    pool = pool.filter((t) => {
      const actor = t?.actor;
      if (!actor) return false;
      // Inject disposition of THIS candidate relative to the reactor so the
      // formula can mix side + per-candidate state in one pass (e.g. Cognitive
      // Focus: "IS_ALLY + IS_ENEMY * (HAS_STATUS_DAZED + HAS_STATUS_ENRAGED +
      // HAS_STATUS_SHAKEN)" → allies always, enemies only when debuffed). Reuses
      // matchesCategory so allegiance overrides + the neutral rules stay the
      // single source of truth. Note: neutral counts as BOTH ally and enemy
      // there (matches the category filter's own behavior).
      const vars = {
        IS_ALLY:  matchesCategory(t, "ally",  ctx) ? 1 : 0,
        IS_ENEMY: matchesCategory(t, "enemy", ctx) ? 1 : 0,
      };
      const resolver = buildSkillResolver({
        actor, payload: ctx.payload, skill: ctx.skill, round: ctx.dCombat?.round ?? 0, vars,
      });
      return Number(evaluateFormula(filterFormula, resolver, 0)) > 0;
    });
  }

  // 3e. focus_max_formula — narrow the pool to the candidate(s) with the MAXIMUM
  // score of a per-candidate formula (e.g. "AE_CHARGES_BURN" → the highest-Burn
  // creature on the field). Ties keep ALL max-scorers, so a downstream
  // mode:"random" picks one at random (Inferex Chomp: "Roulette — creature with
  // the highest Burn stack"). Generic "target the most-X creature" primitive,
  // evaluated with the same per-candidate resolver as target_filter. Runs AFTER
  // target_filter (so a filter can pre-restrict the field), and only when the
  // pool still has a real choice. Blank = no focusing.
  const focusFormula = String(row.focus_max_formula ?? "").trim();
  if (focusFormula && pool.length > 1) {
    const { buildSkillResolver, evaluateFormula } = await import("./skill-formulas.js");
    let best = -Infinity;
    const scored = pool.map((t) => {
      const actor = t?.actor;
      const score = actor
        ? (Number(evaluateFormula(focusFormula, buildSkillResolver({
            actor, payload: ctx.payload, skill: ctx.skill, round: ctx.dCombat?.round ?? 0,
          }), 0)) || 0)
        : -Infinity;
      if (score > best) best = score;
      return { t, score };
    });
    pool = scored.filter((s) => s.score === best).map((s) => s.t);
  }

  if (!pool.length) return emptyResult();

  // mode "random" — pick `count` tokens at random from the pool, no prompt.
  // Chain-level random targeting (Shadow Possession's "one random enemy gets the
  // block variant"); the action-level equivalent lives in resolveActionTargets
  // via skill_target "One Random ..." (Chomp). Resolved before the prompt logic.
  if (mode === "random") {
    const shuffled = [...pool];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return { ok: true, tokens: shuffled.slice(0, Math.min(count, shuffled.length)) };
  }

  // 4. Apply mode.
  // Passive auto-fires resolve silently — they're automatic, no decision to make;
  // never pester a player to confirm a reaction the engine fired for them.
  if (skipWhenPassive && ctx.isPassive) {
    return { ok: true, tokens: [...pool] };
  }
  // mode=all OR auto_confirm when pool has exactly one element → the target set is
  // ASSURED (no real choice). `autoTarget` decides: skip silently (GM, or "skip")
  // or surface a locked-confirm the actor just acknowledges (player on "auto", or
  // "confirm").
  const assured = async (tokens) => {
    if (autoTarget) return { ok: true, tokens };
    const picked = await promptBdPick({ row, pool: tokens, n: tokens.length, mode, ctx, locked: true });
    if (picked?.cancelled) return { ok: false, cancelled: true, reason: "cancelled", tokens: [] };
    if (!picked?.ok || !picked.tokens?.length) {
      // Picker unavailable (no DOM / harness) — fall back to the assured set so
      // the chain still completes. Locked confirm can't change the selection
      // anyway, so this is behaviorally equivalent to a confirm.
      warn(`skill-targeting: row "${row.effect_label}" needs a locked confirm but picker returned no tokens (${picked?.reason ?? "?"}); using the assured set.`);
      return { ok: true, tokens };
    }
    return { ok: true, tokens: picked.tokens };
  };
  if (mode === "all") {
    return assured([...pool]);
  }
  if (autoConfirm && pool.length === 1) {
    return assured([...pool]);
  }

  // Ambiguous pick — pool has more candidates than we need. Prompt via
  // the BD-native target picker (`target-picker.js`), the same canvas
  // token-ring + floating-banner UI that Attack/Skill TARGET state
  // uses. Improvements there cascade here. For passive contexts
  // skip_when_passive already returned above; for `mode: all` likewise.
  // We only land here when the player is actively deciding and
  // `auto_confirm_when_obvious` didn't resolve to one.
  const n = mode === "up_to" ? Math.min(count, pool.length) : Math.min(count, pool.length);
  if (pool.length <= n) {
    // No genuine choice (candidates ≤ needed) — assured. Auto-target governs
    // whether to take it silently (GM / "skip") or lock-confirm it (player /
    // "confirm").
    return assured(pool.slice(0, n));
  }
  const picked = await promptBdPick({ row, pool, n, mode, ctx });
  if (picked?.cancelled) {
    return { ok: false, cancelled: true, reason: "cancelled", tokens: [] };
  }
  if (!picked?.ok || !picked.tokens?.length) {
    // Pool > n but no pick — picker unavailable or failed. Fall back to
    // first N with a warn so the chain still completes; safety net for
    // the (very rare) "no DOM available" case in test harness runs.
    warn(`skill-targeting: row "${row.effect_label}" needs user pick (${pool.length} candidates, want ${n}); picker returned no tokens (${picked?.reason ?? "?"}); auto-picking first ${n}.`);
    return { ok: true, tokens: pool.slice(0, n) };
  }
  return { ok: true, tokens: picked.tokens };
}

// Ask the player to pick from `pool` via the BD-native target picker
// (`target-picker.js`). This is the SAME picker the Attack action's
// TARGET state uses — top-floating banner + canvas token-rings +
// inline Cancel/Confirm buttons. Effect-level picks (Protect's
// `protect_incoming`, Mercy's redirect, etc.) all flow through here
// so the UX matches across the whole game.
//
// Owner-side routing: when ctx.remotePrompt is set (reaction applied by a
// player), the BD picker renders on that player's client via the `remote`
// param instead of locally on the GM. requestTargeting handles the round-trip;
// the value comes back in the same { ok, cancelled, tokenUuids } shape.
async function promptBdPick({ row, pool, n, mode, ctx, locked = false }) {
  // Convert the token-doc pool into target-picker.js's "eligible
  // snapshot" shape — minimum required fields are `tokenId` + `tokenUuid`
  // (used to look up canvas tokens for ring placement) plus a few
  // identity fields for the banner labels.
  const eligible = pool.map((td) => ({
    combatantId: null,
    tokenId: td?.id ?? null,
    tokenUuid: td?.uuid ?? null,
    actorId: td?.actor?.id ?? null,
    actorUuid: td?.actor?.uuid ?? null,
    name: td?.name ?? td?.actor?.name ?? "?",
    tokenImg: td?.texture?.src ?? td?.img ?? td?.actor?.img ?? null,
    disposition: Number(td?.disposition ?? 0),
  })).filter((e) => e.tokenId && e.tokenUuid);

  if (!eligible.length) {
    return { ok: false, reason: "no-eligible-tokens", tokens: [] };
  }

  // `locked` (auto_target=off) — every eligible token is pre-selected and the
  // selection can't be changed; the player only confirms. Force an interactive
  // mode (`mode: "all"` would auto-resolve with no prompt) + lockSelection.
  const titleText = locked
    ? (ctx?.skill?.name ? `Confirm targets for ${ctx.skill.name}` : `Confirm ${eligible.length} target${eligible.length === 1 ? "" : "s"}`)
    : (ctx?.skill?.name ? `Pick a target for ${ctx.skill.name}` : `Pick ${n} target${n === 1 ? "" : "s"}`);

  try {
    const result = await requestBdTargetPicker({
      director: ctx?.director ?? null,
      eligible,
      mode: locked ? "exact" : (mode === "up_to" ? "up_to" : "exact"),
      count: locked ? eligible.length : n,
      lockSelection: locked,
      titleText,
      // Route to the reaction owner's client when applying a player's reaction.
      remote: ctx?.remotePrompt ?? null,
    });
    if (!result?.ok) {
      return {
        ok: false,
        cancelled: !!result?.cancelled,
        reason: result?.reason ?? "pick-failed",
        tokens: [],
      };
    }
    // target-picker.js returns `tokenUuids: string[]`; resolve back to
    // token documents from our original pool to preserve identity.
    const pickedUuids = new Set(result.tokenUuids ?? []);
    const tokens = pool.filter((td) => pickedUuids.has(td?.uuid));
    return { ok: true, tokens };
  } catch (err) {
    return { ok: false, reason: "picker-threw", error: String(err?.message ?? err), tokens: [] };
  }
}

// ── Candidate pool builders ──────────────────────────────────────────────

async function buildCandidatePool(source, ctx) {
  // Kind-scoped persistent-summon refs, resolved by PREFIX so a new summon type
  // needs no registry entry per kind:
  //   own_persistent_summons_<kind>  -> the persisted world Actor (works out of
  //                                     conflict; yields an actor carrier)
  //   own_summon_tokens_<kind>       -> the live token (needs a conflict; what a
  //                                     free_action performer_ref requires)
  // See RESERVED_REFS for why the two are not interchangeable.
  if (typeof source === "string") {
    if (source.startsWith("own_persistent_summons_")) {
      return collectOwnPersistentSummons(ctx, source.slice("own_persistent_summons_".length));
    }
    if (source.startsWith("own_summon_tokens_")) {
      return collectOwnPersistentSummonTokens(ctx, source.slice("own_summon_tokens_".length));
    }
  }
  switch (source) {
    case "self":                return collectSelfTokens(ctx);
    case "self_or_my_focus":    return collectSelfOrMyFocusTokens(ctx);
    case "own_summons":         return collectOwnSummons(ctx);
    case "own_persistent_summons": return collectOwnPersistentSummons(ctx);
    case "own_minions":         return collectOwnMinions(ctx);
    case "own_numen":           return collectOwnNumen(ctx);
    case "last_summoned":       return collectLastSummoned(ctx);
    case "action_targets":      return collectActionTargets(ctx);
    case "hit_action_targets":  return collectHitActionTargets(ctx);
    case "trigger_actor":       return collectTriggerActor(ctx);
    case "trigger_attacker":    return collectTriggerAttacker(ctx);
    case "trigger_subject":     return collectTriggerSubject(ctx);
    case "cause_actor":         return collectCauseActor(ctx);
    case "cover_target":        return collectCoverTarget(ctx);
    case "grappled_by_self":    return collectGrappledBySelf(ctx);
    case "save_failed_targets": return collectSaveFailedTargets(ctx);
    case "contest_lost_targets": return collectContestTargets(ctx, "lost");
    case "contest_won_targets":  return collectContestTargets(ctx, "won");
    case "save_tier_1": case "save_tier_2": case "save_tier_3": case "save_tier_4":
    case "save_tier_5": case "save_tier_6": case "save_tier_7": case "save_tier_8":
      return collectSaveTierTargets(ctx, Number(String(source).slice("save_tier_".length)));
    case "combat":
    default:                    return collectCombatTokens(ctx);
  }
}

function collectSelfTokens(ctx) {
  return ctx.reactorToken ? [ctx.reactorToken] : [];
}

// "own_summons" — combatant tokens THIS actor summoned (token flag
// summonedBy == me) that are still summons/phantasms (isSummon / isPhantasm).
// Powers "Command an existing Phantasm" (Create Phantasm: Strike) and is reused
// by Detonate / Illusory Shield / Zero Power. Empty pool → the targeting row
// aborts the chain cleanly (no phantasm to command).
// "last_summoned" — the token(s) the `summon` effect spawned earlier in THIS
// chain (ctx.lastSummonedTokenUuids). Lets a follow-up row act on the just-
// created summon (take_turn_next → Numen acts immediately).
async function collectLastSummoned(ctx) {
  return await uuidsToTokens(ctx.lastSummonedTokenUuids ?? []);
}

function collectOwnSummons(ctx) {
  const meUuid = String(ctx.reactorActor?.uuid ?? ctx.reactorToken?.actor?.uuid ?? "").trim();
  if (!meUuid) return [];
  const NS = "fabula-ultima-companion";
  const out = [];
  for (const t of collectCombatTokens(ctx)) {
    if (!t?.actor) continue;
    const f = t.flags?.[NS] ?? {};
    if (String(f.summonedBy ?? "") !== meUuid) continue;
    if (!(f.isSummon || f.isPhantasm)) continue;
    out.push(t);
  }
  return out;
}

// "own_persistent_summons" — the reactor's own PERSISTENT summons, resolved from
// the persisted world Actor rather than from the combat roster.
//
// Every other candidate_source reads `collectCombatTokens`, which walks dCombat ->
// game.combat -> the ACTIVE scene's canvas. All three are empty out of conflict,
// and a persistent summon has no token between battles at all
// (reAddPersistentSummons spawns a fresh one at conflict_start — "the prior
// battle's token is gone"). So a party_rested / session_started row could never
// reach a standing minion through own_summons; it resolved to `[]` and the chain
// died on `no-targets`.
//
// It ALWAYS yields the world Actor, wrapped in an ACTOR CARRIER
// `{ actor, uuid, name, actorOnly: true }` — it never resolves a TokenDocument.
// Effect kinds read `token.actor` and treat `token.uuid` as optional (VFX only),
// so the resource / AE handlers work unchanged. The carrier is reachable ONLY
// through this ref, so no existing targeting row can be handed one.
//
// 🩸 Preferring a token here is WRONG, and the first draft did it. A summoned
// minion's token spawns UNLINKED (director-init.js stamps `actorLink = false` for
// a clone whose prototypeToken says so, which is the overwhelming majority of NPCs),
// and on an unlinked token `token.actor` is the SYNTHETIC DELTA actor. A restore
// written through it lands on the token delta and evaporates when that token is
// deleted — while reAddPersistentSummons re-spawns next battle from the WORLD actor.
// The whole point of this ref is to reach the PERSISTED actor; a token branch
// inverts that. (`Actor#getActiveTokens` would not have helped anyway: it reads
// `canvas.tokens.placeables`, i.e. the ACTIVE SCENE ONLY — see the all-scenes note
// in skill-effects.js firePreAcceptedCandidate. It is not a cross-scene walk.)
//
// Callers that DO want live token identity inside a conflict already have
// `own_summons`, which reads the combat roster.
function collectOwnPersistentSummons(ctx, kind = null) {
  const meUuid = String(ctx.reactorActor?.uuid ?? ctx.reactorToken?.actor?.uuid ?? "").trim();
  if (!meUuid) return [];
  const NS = "fabula-ultima-companion";
  const want = kind ? String(kind).toLowerCase() : null;
  const out = [];
  for (const a of (globalThis.game?.actors?.contents ?? [])) {
    const f = a?.flags?.[NS] ?? {};
    if (!f.isPersistentSummon) continue;
    if (String(f.summonOwnerActorUuid ?? "") !== meUuid) continue;
    const k = String(f.persistentSummonKind ?? "").toLowerCase();
    if (want && k && k !== want) continue;   // unstamped = legacy, still matches
    out.push({ actor: a, uuid: a.uuid, name: a.name, actorOnly: true });
  }
  return out;
}

// "own_minions" — the reactor's own reanimated minions, as LIVE TOKENS.
//
// Same population as own_persistent_summons, resolved the other way round: that
// ref walks `game.actors` and yields an actor carrier so an OUT-of-conflict
// trigger (party_rested) can reach a minion that has no token. This one walks the
// combat roster, so an IN-conflict grant gets real token identity.
//
// A minion is discriminated by the `cloneActorUuid` token flag — the same marker
// `destroy_summon only_clones` uses — which is what separates it from the Numen
// and from the Illusionist's phantasms. Without that split, Birth of the Cruel's
// turn_end grant and Create Phantasm: Numen's would fight over `pr.tokens[0]`.
function collectOwnMinions(ctx) { return collectOwnPersistentSummonTokens(ctx, "minion"); }

// The kind-scoped live-token collector behind `own_minions` and the
// `own_persistent_summons_<kind>` family.
//
// `kind` null = every persistent clone this actor owns, whatever its kind.
// A named kind matches `persistentSummonKind`, and ALSO matches a clone carrying
// NO kind at all — those predate `summon_kind` and would otherwise become
// invisible to the very ref that used to resolve them, which is a silent
// "the summon stopped acting" rather than an error. Remove the fallback once no
// unstamped persistent clone can exist.
function collectOwnPersistentSummonTokens(ctx, kind = null) {
  const meUuid = String(ctx.reactorActor?.uuid ?? ctx.reactorToken?.actor?.uuid ?? "").trim();
  if (!meUuid) return [];
  const NS = "fabula-ultima-companion";
  const want = kind ? String(kind).toLowerCase() : null;
  const out = [];
  for (const t of collectCombatTokens(ctx)) {
    if (!t?.actor) continue;
    const f = t.flags?.[NS] ?? {};
    if (String(f.summonedBy ?? "") !== meUuid) continue;
    if (!f.cloneActorUuid) continue;
    const k = String(f.persistentSummonKind ?? "").toLowerCase();
    if (want && k && k !== want) continue;
    out.push(t);
  }
  return out;
}

// "own_numen" — the reactor's own summoned Numen (summonedBy == me AND actor
// isNumen). A Numen subset of own_summons that EXCLUDES phantasms, so a
// take_turn_next reaction force-moves only the Numen (phantasms have 0
// activation and act narratively on the owner's turn — never force them).
function collectOwnNumen(ctx) {
  const meUuid = String(ctx.reactorActor?.uuid ?? ctx.reactorToken?.actor?.uuid ?? "").trim();
  if (!meUuid) return [];
  const NS = "fabula-ultima-companion";
  const out = [];
  for (const t of collectCombatTokens(ctx)) {
    if (!t?.actor) continue;
    const f = t.flags?.[NS] ?? {};
    if (String(f.summonedBy ?? "") !== meUuid) continue;
    // Numen identity: the isNumen TOKEN flag stamped by the summon effect
    // (summon_type:"numen"), with a fallback to the legacy actor prop for Numen
    // actors that carry it as a CSB template column. Mirrors ownSummonCount.
    if (!(f.isNumen || t.actor?.system?.props?.isNumen)) continue;
    out.push(t);
  }
  return out;
}

// "self OR my (ally) focus" — the reactor's own token plus any ALLY carrying a
// Focus AE (status `fud-focus`) that THIS reactor applied (per-applier match,
// the same discriminator ANY_TARGET_HAS_MY_FOCUS uses). The Esper focus is the
// single creature Cognitive Focus marked; this pool lets Life Transference
// offer "yourself or an ally who is your focus" as one pick. The focus is
// ally-restricted because Cognitive Focus may mark an ENEMY (Dazed/Enraged/
// Shaken) and Life Transference only heals an ally focus. Self is always first;
// the focus is appended only when present (so a Keren with no live ally-focus
// just heals self). A per-recipient gate (e.g. Crisis) layers on via
// `target_filter`.
async function collectSelfOrMyFocusTokens(ctx) {
  const out = [];
  const self = ctx.reactorToken;
  if (self) out.push(self);
  const selfTokenUuid = String(self?.uuid ?? "").trim();
  const selfActorUuid = String(ctx.reactorActor?.uuid ?? self?.actor?.uuid ?? "").trim();
  const { actorHasNamedStatusFromApplier } = await import("./skill-formulas.js");
  for (const t of collectCombatTokens(ctx)) {
    if (!t?.actor) continue;
    if (selfTokenUuid && t.uuid === selfTokenUuid) continue;   // self already added
    if (!matchesCategory(t, "ally", ctx)) continue;            // ally focuses only
    if (actorHasNamedStatusFromApplier(t.actor, "focus", selfTokenUuid, selfActorUuid)) out.push(t);
  }
  return out;
}

// Tokens that FAILED the most recent save_check this chain. save_check stamps
// ctx.saveFailedTokenUuids (token uuids, resolved from each failing actor); we
// map them back to TokenDocuments here.
async function collectSaveFailedTargets(ctx) {
  return await uuidsToTokens(ctx.saveFailedTokenUuids ?? []);
}

// Tokens on the losing / winning side of the most recent `contest_check`.
// Returns empty — not an error — when no contest ran in this chain: a row aimed
// at a pool nobody landed in should do nothing, not abort the chain.
async function collectContestTargets(ctx, side) {
  const uuids = side === "won" ? ctx.contestWonTokenUuids : ctx.contestLostTokenUuids;
  return await uuidsToTokens(uuids ?? []);
}

// Tokens in magnitude bucket N of the most recent save_check that declared
// `save_tiers` (1-indexed to match the source name). Returns empty — not an
// error — when the chain's save_check carried no tiers, or when nobody rolled
// low enough to reach this one: a tier row that lands on no-one is the normal
// outcome for a good roll, not a misconfiguration.
async function collectSaveTierTargets(ctx, tierNumber) {
  const pools = ctx.saveTierTokenUuids;
  if (!Array.isArray(pools)) return [];
  const idx = Number(tierNumber) - 1;
  if (!Number.isInteger(idx) || idx < 0 || idx >= pools.length) return [];
  return await uuidsToTokens(pools[idx] ?? []);
}

async function collectActionTargets(ctx) {
  // Resolve token UUIDs supplied by the action's TARGET state.
  const uuids = ctx.actionTargetUuids ?? ctx.payload?.targetTokenUuids ?? ctx.payload?.targets ?? [];
  return await uuidsToTokens(uuids);
}

async function collectHitActionTargets(ctx) {
  // Strict subset of action_targets that passed the Check. For no-Check
  // skills `hitActionTargetUuids` should mirror the full action-target
  // set (resolveSkillAction handles that fallback before building ctx).
  // Falls back to action_targets when the field is absent so legacy
  // callers building ctx without this field still get a sensible pool.
  const uuids = ctx.hitActionTargetUuids
    ?? ctx.payload?.hitTargets
    ?? ctx.actionTargetUuids
    ?? ctx.payload?.targetTokenUuids
    ?? ctx.payload?.targets
    ?? [];
  return await uuidsToTokens(uuids);
}

async function collectTriggerActor(ctx) {
  const uuid = ctx.payload?.sourceTokenUuid ?? ctx.payload?.attackerTokenUuid ?? null;
  return await uuidsToTokens(uuid ? [uuid] : []);
}

// The creature that CAUSED a resource-change event (creature_lose_resource /
// creature_gain_resource): the attacker/source carried as payload.causeTokenUuid
// by fireResourceChangeTrigger. DISTINCT from trigger_actor — for a resource-loss
// event sourceTokenUuid is the SUBJECT (the creature whose resource changed = the
// reactor itself), so trigger_actor would resolve the reactor, not the attacker.
// Painful Lesson reacts to "you lost HP" (subject = self) but Studies the CAUSE.
// Empty (impersonal loss — a tick with no source) → no token, so the consuming
// effect (free_action Study) no-ops cleanly.
async function collectCauseActor(ctx) {
  const uuid = ctx.payload?.causeTokenUuid ?? null;
  return await uuidsToTokens(uuid ? [uuid] : []);
}

async function collectTriggerSubject(ctx) {
  const uuid = ctx.payload?.subjectTokenUuid ?? ctx.payload?.targetTokenUuid ?? null;
  return await uuidsToTokens(uuid ? [uuid] : []);
}

// The ORIGINAL ATTACKER carried in a forwarded event context — distinct from
// trigger_actor (the event's own subject/performer). Used by follow-up reactions
// that act against the attacker of an action a prior skill responded to (Bullet
// Break: free attack vs the attacker whose ranged attack Crossfire negated).
// Reads payload.attackerTokenUuid (set by the creature_completes_skill emit).
async function collectTriggerAttacker(ctx) {
  const uuid = ctx.payload?.attackerTokenUuid ?? null;
  return await uuidsToTokens(uuid ? [uuid] : []);
}

// Guard's optional covered ally. The Guard action stamps the picked ally on
// the action result (ar.coverTarget) — threaded onto ctx by resolveAction.
// Empty (no ally covered) → no tokens, so the Covered-AE row simply no-ops.
//
// Grappled rule (RAW in-world Journal "Grappled", mechanic #2): if the
// guarder is Grappled, the cover "ends immediately" — they still gain the
// self-Guard benefit (the separate `guard_self` row), but the Covered AE is
// never applied to the ally. We enforce that here by returning no tokens, so
// the `guard_cover` apply_ae row no-ops. Gating at the cover-target collector
// (apply time) keeps it in one place, rewind-safe, and leaves guard_self
// untouched. See [[project_grappled_advanced_debuff]].
async function collectCoverTarget(ctx) {
  const uuid = ctx.actionResult?.coverTarget?.tokenUuid ?? null;
  if (!uuid) return [];
  const guarder = ctx.reactorActor;
  if (guarder && isGrappled(guarder)) {
    const name = guarder.name ?? "The Grappled unit";
    log(`Guard cover suppressed — ${name} is Grappled (cover ends immediately; self-Guard still applies)`);
    try { ui.notifications?.info(`${name} is Grappled — Guard cover ends immediately (still guards self).`); } catch {}
    return [];
  }
  return await uuidsToTokens([uuid]);
}

// Grappled "shared space" splash (rule #1). The reactor here is a GRAPPLER —
// its "Grappling" AE hosts a creature_targeted_by_action reaction. When the
// grappler is attacked, its grappled victim(s) get added to the attacker's
// target list. Victims are resolved live from the P0 grappler stamp via
// tokensGrappledBy (single source of truth — no stored pointer). We EXCLUDE
// the attacker so a grappled unit attacking its own grappler doesn't splash
// onto itself — the spec's "originating from someone OTHER than the grappled
// unit" clause. See [[project_grappled_advanced_debuff]].
function collectGrappledBySelf(ctx) {
  const grapplerTokenUuid = ctx.reactorToken?.uuid ?? null;
  const grapplerActorUuid = ctx.reactorToken?.actor?.uuid ?? ctx.reactorActor?.uuid ?? null;
  if (!grapplerTokenUuid && !grapplerActorUuid) return [];
  const victims = tokensGrappledBy({ tokenUuid: grapplerTokenUuid, actorUuid: grapplerActorUuid });
  // The action performer (attacker). creature_targeted_by_action carries it as
  // attackerActorUuid/attackerTokenUuid — NOT sourceActorUuid (which is the
  // target here). Drop any victim that IS the attacker.
  const attackerActorUuid = ctx.payload?.attackerActorUuid ?? null;
  const attackerTokenUuid = ctx.payload?.attackerTokenUuid ?? null;
  if (!attackerActorUuid && !attackerTokenUuid) return victims;
  return victims.filter((tok) => {
    if (attackerTokenUuid && tok.uuid === attackerTokenUuid) return false;
    if (attackerActorUuid && tok.actor?.uuid === attackerActorUuid) return false;
    return true;
  });
}

// A creature declaring `cannot_be_targeted_by: "any"` can never be a target
// candidate (single, AoE, random, all_allies/all_enemies), so it is filtered out
// of every pool built here. This is how a Guest becomes untargetable — via the
// shared targeting primitive rather than a bespoke flag check. Such a creature
// still ACTS; its own action resolves ITS targets, which stay in the pool.
function isUntargetableTokenDoc(td) {
  return hasUnconditionalTargetBlock(td?.actor ?? null);
}

function collectCombatTokens(ctx) {
  // Use dCombat as the authoritative combat list (director-native);
  // each combatant carries .tokenDoc.
  const dc = ctx.dCombat;
  if (dc?.combatants?.length) {
    return dc.combatants.map((c) => c.tokenDoc).filter(Boolean).filter((td) => !isUntargetableTokenDoc(td));
  }
  // Fallback to game.combat (manual-attach path, rare in director mode).
  const fc = game.combat;
  if (fc?.combatants?.size) {
    const out = [];
    for (const c of fc.combatants) {
      const t = c.token;
      if (t && !isUntargetableTokenDoc(t)) out.push(t);
    }
    return out;
  }
  // Last resort: canvas tokens. A chain ctx built WITHOUT dCombat (e.g. the
  // card-mutation redirect picker) would otherwise see zero combatants when
  // game.combat is also null — which is the normal BD case (director runs on
  // its own dCombat). Mirrors the enemyActorsOf canvas fallback in skill-formulas.
  return (globalThis.canvas?.tokens?.placeables ?? []).map((t) => t.document).filter(Boolean).filter((td) => !isUntargetableTokenDoc(td));
}

async function uuidsToTokens(uuids) {
  if (!Array.isArray(uuids) || !uuids.length) return [];
  const out = [];
  for (const u of uuids) {
    try {
      const t = await fromUuid(u);
      if (t) out.push(t);
    } catch (e) {
      warn(`skill-targeting.uuidsToTokens: fromUuid failed for ${u}`, e);
    }
  }
  return out;
}

// ── Category (disposition) filter ────────────────────────────────────────
//
// Matches the schema's category semantics:
//   "ally"     — same disposition as reactor (incl. reactor) OR neutral
//   "enemy"    — opposite disposition + neutral
//   "creature" — any (incl. neutral)
//   ""         — no filter (same as "creature" — already done above)

function matchesCategory(token, category, ctx) {
  const reactor = ctx.reactorToken;
  if (!reactor) return true;
  const reactorDisp = Number(reactor.disposition ?? 0);
  const targetDisp = Number(token.disposition ?? 0);

  const cat = category.toLowerCase();
  if (cat === "creature" || cat === "") return true;

  // Allegiance overrides on the acting creature reclassify a candidate's side
  // (e.g. Charm/Domination: allies count as enemies). Applied to the NATURAL
  // side before the disposition rules below; only short-circuits ally/enemy when
  // an override is actually present (no behavior change otherwise).
  if (cat === "ally" || cat === "enemy") {
    const tokUuid = token.uuid ?? token.document?.uuid;
    const isSelf = !!tokUuid && tokUuid === reactor.uuid;   // never reclassify self
    const overrides = isSelf ? [] : getAllegianceOverrides(ctx.reactorActor);
    if (overrides.length) {
      const natSide = ((targetDisp === reactorDisp) && (targetDisp !== 0)) ? "ally" : "enemy";
      const effSide = applyAllegianceOverride(natSide, tokUuid, token.actor?.uuid, overrides);
      return effSide === cat;
    }
  }
  if (cat === "ally") {
    if (targetDisp === reactorDisp) return true;
    if (targetDisp === 0) return true;             // neutral counts as ally
    return false;
  }
  if (cat === "enemy") {
    if (targetDisp === -reactorDisp && reactorDisp !== 0) return true;
    if (targetDisp === 0 && reactorDisp !== 0) return true;  // neutral counts
    // Reactor itself is neutral → "enemy" matches anything non-neutral.
    if (reactorDisp === 0 && targetDisp !== 0) return true;
    return false;
  }
  return true;  // unknown category — fail-open
}

// ── Chain context helper ────────────────────────────────────────────────

// Build a fresh chain context that the effect dispatcher will mutate as
// resolution proceeds. Pass everything the targeting + effect kinds
// need; missing fields fall through to "no candidates".
export function makeChainContext({
  reactorActor = null,
  reactorToken = null,
  skill = null,
  dCombat = null,
  // The running director, when the ctx is built inside the FSM. Lets effect
  // handlers reach `director.ctx._postResolveTriggers` (the resource ledger)
  // without a global lookup — and makes the deal_damage→ledger wiring work in
  // the simulate harness, which threads a director but never sets the module
  // singleton (`director-boot._instance`). Null for out-of-FSM/preview ctx.
  director = null,
  // Itemized SOURCE identity of the effect chain — the carrier (skill/AE) that
  // is running these effects. Feeds the resource-ledger event's originLabel/
  // originUuid so the turn breakdown reads "−5 Burn" not "−5 Effect" for
  // AE-carried ticks (where `skill` is null and the damage row has no
  // attacker_name). Set by firePreAcceptedCandidate from the carrier.
  sourceLabel = null,
  sourceUuid = null,
  payload = null,
  actionTargetUuids = null,
  // Subset of actionTargetUuids that passed the Check (DEF/MDEF). Drives
  // `target_ref: "hit_action_targets"` for status-on-hit spells (Torpor,
  // Hallucination, Enrage). For no-Check skills, callers should pass the
  // full action-target list so "hit" still means "targeted".
  hitActionTargetUuids = null,
  isPassive = false,
  // Recipe-merged effect_table; falls back to skill.system.props.effect_table
  // when null. Set by callers that pre-expand recipes via
  // skill-recipes.getRuntimeSkillView.
  runtimeEffectTable = null,
  // Recipe-merged fire-point dict ({on_activate_effect_ref, post_damage_effect_ref});
  // falls back to skill props.
  firePoints = null,
  // Test-harness only — when set, applyOpenActionMenuEffect consumes a
  // pick from this queue instead of awaiting the interactive picker.
  // Shape: [{ menuLabel?: string, index?: number }, ...]. Per-pick:
  // `menuLabel` (case-insensitive) selects by display label; `index`
  // selects by ordinal; raw string is shorthand for `menuLabel`. Live
  // play never sets this. See FUCompanion.api.test.runDirectorSkillSimulate.
  harnessPicks = null,
  // Live equivalent of harnessPicks: menu picks the player already made at
  // Apply-click (previewReactionMenu), cached on the candidate and replayed
  // here at RESOLVE so open_action_menu dispatches the same options without
  // re-prompting. Same per-pick shape (label strings). harnessPicks wins if
  // both are set. See action-card.recordPillDecision + firePreAcceptedCandidate.
  menuPicks = null,
  // Test-harness only — when set, applyPromptNumberEffect reads the entered
  // amount from this map (keyed by prompt_var) instead of opening the Dialog,
  // so a headless sim never hangs. Shape: { move_amount: 3, ... }. Live play
  // never sets this. See FUCompanion.api.test.runDirectorSkillSimulate.
  harnessNumbers = null,
  // When set, interactive picks (target picker, option-menu) route to a
  // remote player's client instead of rendering on the calling (GM) client.
  // Shape: { channel, targetUserId, combatId }. Set by the reaction apply
  // path so a player resolves their OWN reaction's secondary UI. Null for
  // GM/NPC-local resolution. See remote-pick.js + [[director-player-driven-input]].
  remotePrompt = null,
  // Applier attribution for AE-carried reactions: the actor/token that ORIGINALLY
  // applied the carrier AE (e.g. Searing Brand's caster = Fafnir). A deal_damage
  // fired from such a reaction credits this applier as the damage CAUSE so the
  // hit reads as caster-inflicted (reflect/leech reactions point back at the
  // caster; the battle log names them) even though the REACTOR is the bearer.
  // Set by firePreAcceptedCandidate from the carrier AE's directorAppliedBy.
  // Null for item-carried reactions / unattributed effects.
  appliedByActorUuid = null,
  appliedByTokenUuid = null,
  // Signed per-resource cost-discount deltas ({ mp: -4, … }) produced by an
  // accepted adjust_cost reaction (Hypercognition), threaded from ar.costOverride
  // at RESOLVE. consume_resource rows debiting a listed resource subtract the
  // delta (clamped >= 0) and decrement it, so a spell's total cost drops once
  // across however many consume rows it has. MUTABLE (each consume mutates it).
  costOverride = null,
} = {}) {
  return {
    reactorActor,
    reactorToken,
    skill,
    dCombat,
    director,
    sourceLabel,
    sourceUuid,
    payload,
    actionTargetUuids,
    hitActionTargetUuids,
    isPassive,
    runtimeEffectTable,
    firePoints,
    harnessPicks,
    menuPicks,
    harnessNumbers,
    remotePrompt,
    appliedByActorUuid,
    appliedByTokenUuid,
    costOverride,
    resolvedTargets: new Map(),
  };
}
