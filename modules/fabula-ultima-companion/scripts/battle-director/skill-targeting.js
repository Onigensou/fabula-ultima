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

// Reserved strings that expand to inline targeting rows. Authoring sugar
// — saves a row from the effect_table for the most common case.
const RESERVED_REFS = {
  self:                  { candidate_source: "self" },
  action_targets:        { candidate_source: "action_targets", mode: "all" },
  hit_action_targets:    { candidate_source: "hit_action_targets", mode: "all" },
  ally_action_targets:   { candidate_source: "action_targets", category: "ally", mode: "all" },
  enemy_action_targets:  { candidate_source: "action_targets", category: "enemy", mode: "all" },
  trigger_actor:         { candidate_source: "trigger_actor", mode: "exact", count: 1 },
  trigger_subject:       { candidate_source: "trigger_subject", mode: "exact", count: 1 },
  // Guard's optional covered ally (resolveAction-unification). mode "all" takes
  // the (0 or 1) token collectCoverTarget yields without prompting.
  cover_target:          { candidate_source: "cover_target", mode: "all" },
};

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

  // Reserved word sugar.
  if (Object.prototype.hasOwnProperty.call(RESERVED_REFS, key)) {
    const result = await resolveTargetingRow(RESERVED_REFS[key], ctx);
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

async function resolveTargetingRow(row, ctx) {
  const candidateSource = String(row.candidate_source ?? "combat").trim();
  const category = String(row.category ?? "").trim().toLowerCase();
  const mode = String(row.mode ?? "exact").trim().toLowerCase();
  const count = Math.max(0, Math.floor(Number(row.count ?? 1) || 1));
  const excludeSelf = !!row.exclude_self;
  const autoConfirm = row.auto_confirm_when_obvious !== false;       // default true
  const skipWhenPassive = row.skip_when_passive !== false;            // default true

  // 1. Build candidate pool.
  let pool = await buildCandidatePool(candidateSource, ctx);
  if (!pool.length) return { ok: false, reason: "no-candidates", tokens: [] };

  // 2. Category filter (disposition vs reactor).
  if (category) {
    pool = pool.filter((t) => matchesCategory(t, category, ctx));
  }

  // 3. exclude_self.
  if (excludeSelf && ctx.reactorToken?.uuid) {
    pool = pool.filter((t) => t.uuid !== ctx.reactorToken.uuid);
  }

  // 3b. exclude_action_targets — drop tokens already in the action's target
  // list. Used by pre-roll augments (Barrage's add_target) that must pick an
  // ADDITIONAL target, never one already being attacked.
  if (row.exclude_action_targets) {
    const already = new Set(
      ctx.actionTargetUuids
      ?? ctx.payload?.targetTokenUuids
      ?? ctx.payload?.targets
      ?? []
    );
    if (already.size) pool = pool.filter((t) => !already.has(t.uuid));
  }

  if (!pool.length) return { ok: false, reason: "no-candidates", tokens: [] };

  // 4. Apply mode.
  // mode=all OR skip_when_passive in passive context OR auto_confirm
  // when pool has exactly one element → take the whole pool / single
  // element without prompting.
  if (mode === "all") {
    return { ok: true, tokens: [...pool] };
  }
  if (skipWhenPassive && ctx.isPassive) {
    return { ok: true, tokens: [...pool] };
  }
  if (autoConfirm && pool.length === 1) {
    return { ok: true, tokens: [...pool] };
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
    return { ok: true, tokens: pool.slice(0, n) };
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
// TODO (owner-side routing): the BD picker is rendered on the calling
// client (typically GM). For player-owned reactors the prompt should
// appear on the reactor's owner's screen instead. Tracked as a
// separate enhancement; depends on adding a server-roundtrip to
// `target-picker.js` or an IntentChannel message to ferry the pick
// across clients.
async function promptBdPick({ row, pool, n, mode, ctx }) {
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

  const titleText = ctx?.skill?.name
    ? `Pick a target for ${ctx.skill.name}`
    : `Pick ${n} target${n === 1 ? "" : "s"}`;

  try {
    const result = await requestBdTargetPicker({
      director: ctx?.director ?? null,
      eligible,
      mode: mode === "up_to" ? "up_to" : "exact",
      count: n,
      titleText,
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
  switch (source) {
    case "self":                return collectSelfTokens(ctx);
    case "action_targets":      return collectActionTargets(ctx);
    case "hit_action_targets":  return collectHitActionTargets(ctx);
    case "trigger_actor":       return collectTriggerActor(ctx);
    case "trigger_subject":     return collectTriggerSubject(ctx);
    case "cover_target":        return collectCoverTarget(ctx);
    case "combat":
    default:                    return collectCombatTokens(ctx);
  }
}

function collectSelfTokens(ctx) {
  return ctx.reactorToken ? [ctx.reactorToken] : [];
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

async function collectTriggerSubject(ctx) {
  const uuid = ctx.payload?.subjectTokenUuid ?? ctx.payload?.targetTokenUuid ?? null;
  return await uuidsToTokens(uuid ? [uuid] : []);
}

// Guard's optional covered ally. The Guard action stamps the picked ally on
// the action result (ar.coverTarget) — threaded onto ctx by resolveAction.
// Empty (no ally covered) → no tokens, so the Covered-AE row simply no-ops.
async function collectCoverTarget(ctx) {
  const uuid = ctx.actionResult?.coverTarget?.tokenUuid ?? null;
  return await uuidsToTokens(uuid ? [uuid] : []);
}

function collectCombatTokens(ctx) {
  // Use dCombat as the authoritative combat list (director-native);
  // each combatant carries .tokenDoc.
  const dc = ctx.dCombat;
  if (dc?.combatants?.length) {
    return dc.combatants.map((c) => c.tokenDoc).filter(Boolean);
  }
  // Fallback to game.combat (manual-attach path, rare in director mode).
  const fc = game.combat;
  if (!fc?.combatants?.size) return [];
  const out = [];
  for (const c of fc.combatants) {
    const t = c.token;
    if (t) out.push(t);
  }
  return out;
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
} = {}) {
  return {
    reactorActor,
    reactorToken,
    skill,
    dCombat,
    payload,
    actionTargetUuids,
    hitActionTargetUuids,
    isPassive,
    runtimeEffectTable,
    firePoints,
    harnessPicks,
    resolvedTargets: new Map(),
  };
}
