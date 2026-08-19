/**
 * Battle Director test harness — runs Skill / Spell COMPUTE in
 * isolation against a synthetic director context. No mutations, no
 * dependency on an active combat. Returns the actionResult so callers
 * can verify per-target previews, recipe-grant amounts, hit/miss
 * routing, and so on without driving the FSM.
 *
 * Surfaces at `FUCompanion.api.test.runDirectorSkillCompute(...)`:
 *
 *   const r = await FUCompanion.api.test.runDirectorSkillCompute({
 *     skillUuid:        "Actor.X.Item.Y",          // required
 *     casterTokenUuid:  "Scene.S.Token.T",         // required
 *     targetTokenUuids: ["Scene.S.Token.U", ...],  // required
 *     force: { rA: 6, rB: 6, isCrit: true },       // optional
 *   });
 *   r.ok                   // boolean
 *   r.actionResult         // frozen ar (perTargetResults, damage, ...)
 *   r.summary              // healed/damaged/missed/hit roll-up
 *
 * Scope (v1): COMPUTE phase only. No RESOLVE — no HP write, no AE
 * apply, no passive fire. Use for:
 *   - Validating formulas (recipe_amount, damage_bonus, SL, BOND_*)
 *   - Confirming per-target hit/miss routing (DEF / MDEF / affinity)
 *   - Heal/grant preview values for recipe-based skills
 *
 * Not modelled (yet):
 *   - RESOLVE writes (HP/MP deltas, AE applies, items consumed)
 *   - Passive trigger fires (firePassiveTriggers)
 *   - Reaction matching
 *
 * `runDirectorSkillSimulate(...)` extends compute with RESOLVE under
 * monkey-patched Foundry document prototypes that capture (not commit)
 * every write. Phase 2 args:
 *   - acceptPassives: true | false | { "Healing Power": true, ... }
 *       Auto-Apply/Skip the `promptPassiveOptin` Dialog for ask-mode
 *       passives. Without this, Healing Power / Support Magic silently
 *       no-op because the Dialog never resolves.
 *   - override: { SL, CHAR_LEVEL, BOND_COUNT, BOND_STRENGTH } — installs
 *       a global formula-resolver registry consulted BEFORE actor reads.
 *       Side-steps CSB's class_list → level and bond_N → BOND_COUNT
 *       derivation (which clobbered the previous actor-mutation approach).
 *   - vismagusHpPaid: true — stamps the AR flag that RESOLVE checks to
 *       suppress self-heal (lets Vismagus's RESOLVE-side behavior be
 *       tested without driving TARGET's alt-cost Dialog).
 *
 * GM only (mirrors the legacy test harness gate).
 */

// NOTE: deps are dynamically re-imported per-call with a cache-bust so the
// harness ALWAYS exercises the latest disk state — the whole point of a test
// tool is to validate edits without forcing the user to hard-refresh. Foundry's
// soft reload doesn't bust the browser ESM cache, so static imports here would
// read whatever was loaded at boot.
// Opt-in reuse cache for BATCH callers (the regression sweep). The per-call
// cache-bust below re-fetches, re-parses and re-evaluates ~1.5 MB of module
// source EVERY call — measured 925 ms, which is 39% of a sweep's per-skill cost
// and pure waste when 30 skills run back-to-back against a disk that cannot
// change mid-batch. A caller that owns such a batch passes its own `depsToken`;
// the FIRST call under a token loads fresh, the rest reuse. Omit it and nothing
// changes — interactive/iterative use keeps picking up single-file edits with no
// reload, which is the whole point of the per-call bust.
let _depsCache = null;   // { token, deps }

async function loadDeps(reuseToken = null) {
  if (reuseToken != null && _depsCache && _depsCache.token === reuseToken) {
    // The freshly-imported state-handlers resolves SE() through this global, and
    // an interleaved un-tokened call may have moved it — repoint it at the
    // instance our cached deps actually came from.
    globalThis.__FU_CB = reuseToken;
    return _depsCache.deps;
  }
  // Single token per call drives BOTH the harness's own re-imports AND the
  // hot-reload registry (state-handlers' internal skill-effects edge). We set
  // globalThis.__FU_CB to this token so the freshly-imported state-handlers,
  // when it calls SE().<fn>, resolves to the SAME fresh skill-effects instance
  // we import here (matching `?cb=<token>` URL → one cached module, no double
  // instance / no module-state split). refreshHotModules() (awaited below)
  // performs that re-import after state-handlers has registered its edge.
  const token = reuseToken != null ? reuseToken : Date.now();
  globalThis.__FU_CB = token;
  const bust = `?harness=${token}`;
  const cb = `?cb=${token}`;  // MUST match hot-reload.js's loader query
  const [stateHandlers, states, intents, snapshot, skillIntent, skillEffects, actionProfile, actionCard, cardMutations, gmOverrideMod, hot] = await Promise.all([
    import(`./state-handlers.js${bust}`),
    import(`./states.js${bust}`),
    import(`./intents.js${bust}`),
    import(`./snapshot.js${bust}`),
    import(`./skill-intent.js${bust}`),
    import(`./skill-effects.js${cb}`),
    import(`./action-profile.js${bust}`),
    import(`./action-card.js${bust}`),
    import(`./card-mutations.js${bust}`),
    import(`./gm-card-override.js${bust}`),
    import(`./hot-reload.js`),  // singleton (registry on globalThis); no cache-bust
  ]);
  // state-handlers registered its skill-effects hot edge during the import
  // above; refresh it now so its internal SE() calls use the fresh instance.
  await hot.refreshHotModules();
  const deps = {
    STATE_HANDLERS: stateHandlers.STATE_HANDLERS,
    STATES: states.STATES,
    INTENTS: intents.INTENTS,
    readPropNum: snapshot.readPropNum,
    attrDieSize: snapshot.attrDieSize,
    readAffinities: snapshot.readAffinities,
    freezeActionResult: snapshot.freezeActionResult,
    resolveAttackerWeapon: snapshot.resolveAttackerWeapon,
    applyAffinityToDamage: snapshot.applyAffinityToDamage,
    classifyActionIntent: skillIntent.classifyActionIntent,
    findPassiveCandidates: skillEffects.findPassiveCandidates,
    // Needed by probeTargetedReactions to fire a defender-side candidate through
    // the same entrypoint the live accept path uses.
    firePreAcceptedCandidate: skillEffects.firePreAcceptedCandidate,
    resolvesVsMagicDefense: snapshot.resolvesVsMagicDefense,
    // The single post-decision recompute (matches production CONFIRM); replaces
    // the retired computeSenderDamageBonuses + recomputePerTargetDamages overlay.
    recomputeActionProfile: actionProfile.recomputeActionProfile,
    // Render-capture: the SAME kind→builder dispatch production uses to spawn the
    // action card. Lets simulate harnesses assert on what the player actually sees
    // (headline, per-target rows, pills, buttons) — not just the data writes.
    composeActionCardObject: actionCard.composeActionCardObject,
    composeActionCardRenderPayload: actionCard.composeActionCardRenderPayload,
    stripHtmlForDesc: actionCard.stripHtmlForDesc,
    // The SINGLE pre-resolve mutation entrypoint the card preview and CONFIRM
    // both go through — what a reaction probe has to drive if its verdict is to
    // mean anything about play.
    applyTargetSetMutation: cardMutations.applyTargetSetMutation,
    gmReactionKey: gmOverrideMod.gmReactionKey,
    gmReactionDecisionChanges: gmOverrideMod.gmReactionDecisionChanges,
    isGmEditableReaction: gmOverrideMod.isGmEditableReaction,
  };
  if (reuseToken != null) _depsCache = { token: reuseToken, deps };
  return deps;
}

// Pre-pass simulator — runs the CONFIRM-stage `creature_will_deal_damage`
// aggregator + `computeSenderDamageBonuses` + `recomputePerTargetDamages`
// against the COMPUTE-stage ar. Used by both Attack and Skill simulators
// to validate pill-accepted reactions (Cheap Shot family) without driving
// the live action-card click flow. Returns the new frozen ar with
// `perTargetResults` updated and `acceptedCardReactions` stamped.
//
// `accept` is a FILTER, not a candidate list (the engine's own list is
// `cardReactions` — do not confuse the two). Shape:
//   - undefined / falsy              → accept nothing; the ar comes back untouched
//   - true                           → accept EVERY matching card-reaction (rare; risky if multiple match)
//   - ["Cheap Shot", "Vanish", ...]  → accept only candidates whose carrierName matches one of these
// Every per-target scan payload this action would present to a reaction trigger.
//
// Extracted so the accept path and the reaction PROBE build their payloads from
// the same code. A probe that re-rolled its own payload literal would be free to
// omit a field, and an omitted field does not fail loudly — it resolves to
// 0/blank, which for a `== 0` gate is the PERMISSIVE answer. That is exactly how
// an instantaneous-only gate passed a Scene spell under test and refused it in
// play; two probes drifting apart would reintroduce it one field at a time.
// The ACTION-LEVEL half of a scan payload, hoisted so the defender-side probe
// can spread the SAME base live spreads into creature_targeted_by_action
// (state-handlers ~5155) WITHOUT also inheriting the attacker per-target keys
// (rawDamage / hitMargin / affinity / hitTargets) that live never sends there.
// Those extras read as REAL values under test and 0 in play - the permissive
// failure inverted. Found by review 2026-08-19.
async function buildHarnessActionBase(ar) {
  const allTargetUuids = (ar.targets ?? []).map((t) => t.tokenUuid);
  const hitTargetUuids = (ar.perTargetResults ?? [])
    .filter((r) => r?.hit)
    .map((r) => r.tokenUuid ?? (ar.targets ?? []).find((t) => t?.actorUuid === r?.actorUuid)?.tokenUuid)
    .filter(Boolean);
  // ── Shared ACTION-LEVEL base — mirrors state-handlers' `actionBase` ───────
  // The live CONFIRM scan spreads `actionBase` into every payload it builds;
  // this harness used to hand-roll its literal instead, so every action-level
  // identifier the live path supplies was simply ABSENT here. Those gates then
  // fail SILENTLY and in the permissive direction: `ACTION_DURATION` read
  // `undefined` → rank 0 → "instantaneous", so Cataclysm's
  // `ACTION_DURATION == 0` gate passed for a *Scene* spell under the harness
  // while correctly refusing it in play. A test that cannot fail is worse than
  // no test, and the same hole covered SKILL_HAS_TAG_*, ACTION_COST_*,
  // ACTION_IS_SPELL and the crit/fumble gates.
  //
  // Spread FIRST so every explicit key below still wins — this can only fill
  // gaps, never change a value the scan already states (same contract as the
  // live block).
  let harnessSkillTags = "";
  let harnessSkillDuration = "";
  try {
    const actingSkill = ar.skillUuid ? await fromUuid(ar.skillUuid).catch(() => null) : null;
    harnessSkillTags = String(actingSkill?.system?.props?.skill_tags ?? "");
    harnessSkillDuration = String(actingSkill?.system?.props?.duration ?? "");
  } catch (_) { /* noop — both are optional gates */ }
  const harnessActionBase = {
    actionKind: ar.kind ?? null,
    actionSkillType: String(ar.skillType ?? "").toLowerCase(),
    actionIsCheck: !!ar.isCheck,
    actionCanMiss: !!ar.canMiss,
    // No free-action registry in a harness run: the harness never grants one,
    // so a cast here is never free. Matches the live read for that state.
    actionIsFreeCast: false,
    actionName: ar.skillName ?? ar.weapon?.name ?? ar.kind,
    sourceSkillName: ar.skillName ?? ar.weapon?.name ?? null,
    skillTags: harnessSkillTags,
    skillDuration: harnessSkillDuration,
    isCrit: !!ar.roll?.isCrit,
    isFumble: !!ar.roll?.isFumble,
    checkTotal: Number(ar.roll?.total ?? 0) || 0,
    // The High Roll. Found MISSING by `skill-regression parity` — same class of
    // hole as skillDuration, so an HR-gated damage rider read 0 under test.
    hr: Number(ar.roll?.hr ?? 0) || 0,
    costHp: Number(ar.costSerialized?.hp ?? 0) || 0,
    costMp: Number(ar.costSerialized?.mp ?? 0) || 0,
    costIp: Number(ar.costSerialized?.ip ?? 0) || 0,
  };


  return harnessActionBase;
}

async function buildReactionScanPayloads(ar) {
  const allTargetUuids = (ar.targets ?? []).map((t) => t.tokenUuid);
  const hitTargetUuids = (ar.perTargetResults ?? [])
    .filter((r) => r?.hit)
    .map((r) => r.tokenUuid ?? (ar.targets ?? []).find((t) => t?.actorUuid === r?.actorUuid)?.tokenUuid)
    .filter(Boolean);
  const harnessActionBase = await buildHarnessActionBase(ar);

  const out = [];
  for (const entry of (ar.perTargetResults ?? [])) {
    // Mirrors state-handlers CONFIRM: scan every target (hit or miss) so the
    // reaction surfaces regardless of outcome; only HIT targets are recorded
    // as recipients (appliesToTargetUuids), so the effect/cost land only on a
    // hit. A full-miss candidate surfaces with appliesToTargetUuids = [].
    const subjectActorUuid = entry?.actorUuid;
    if (!subjectActorUuid) continue;
    const matchedTarget = (ar.targets ?? []).find((t) => t?.actorUuid === subjectActorUuid);
    const subjectTokenUuid = entry.tokenUuid ?? matchedTarget?.tokenUuid ?? null;
    const payloadForTrigger = {
      ...harnessActionBase,   // action-level defaults; every explicit key below wins
      subjectActorUuid,
      subjectTokenUuid,
      targets: allTargetUuids,
      hitTargets: hitTargetUuids,
      rawDamage: entry.rawDamage,
      damageType: ar.damageType ?? ar.damage?.element ?? null,
      // Mirror CONFIRM: carry the pending-damage resource so DAMAGE_IS_HP gates
      // (Adversity's HP-only damage rider) resolve in the harness too.
      valueType: String(entry.resource ?? ar.valueType ?? ar.damage?.resource ?? "hp").toLowerCase(),
      weaponType: ar.weapon?.weaponType ?? null,
      weaponRange: ar.weapon?.range ?? ar.weapon?.weapon_range ?? null,
      affinity: entry.affinity,
      // Per-TARGET, so it belongs here rather than in the action-level base.
      // Powers "Conquer N" damage riders (Minotaurus Axe); absent, they read 0.
      hitMargin: (Number(ar.roll?.total ?? 0) || 0) - (Number(entry.defense ?? 0) || 0),
      sourceTokenUuid: ar.attacker?.tokenUuid ?? null,
      sourceActorUuid: ar.attackerActorRef,
      actionIntent: ar.actionIntent,
      targetTokenUuids: allTargetUuids,
      hitTargetTokenUuids: hitTargetUuids,
      skillUuid: ar.skillUuid ?? null,
      weaponUuid: ar.weapon?.uuid ?? null,
    };
    // ⚠ No `<key>:` may appear between the literal above and the end of this
    // function's consumers. `skill-regression parity` scrapes the
    // `payloadForTrigger` literal straight out of this source and its brace
    // matcher over-runs the closing brace, so any later `foo: bar` — including a
    // DESTRUCTURING rename — is scraped as though it were a payload field, and
    // parity then reports a harness-only key that does not exist. Property
    // assignment and shorthand carry no colon and stay invisible to it.
    const rec = { entry, subjectActorUuid, subjectTokenUuid };
    rec.scanPayload = payloadForTrigger;
    out.push(rec);
  }
  return out;
}

// The PERFORMER-side scan payload — `creature_performs_action`.
//
// A separate builder because the live scan is a different shape: it fires ONCE
// per action carrying action-level state, not once per target row. Reusing the
// per-target damage payload here would have silently dropped every field only
// this scan supplies (rollDieA/B, rollCheckBonus, actionKind, the die attribute
// names), and a gate reading a dropped field gets 0 — the permissive answer.
// Mirrors state-handlers' `performPayload` field for field; `skill-regression
// parity` compares the two so a future edit to one cannot silently outrun the
// other.
async function buildPerformsActionPayload(ar) {
  const allTargetUuids = (ar.targets ?? []).map((t) => t.tokenUuid);
  let performSkillTags = "";
  let performSkillDuration = "";
  try {
    const actingSkill = ar.skillUuid ? await fromUuid(ar.skillUuid).catch(() => null) : null;
    performSkillTags = String(actingSkill?.system?.props?.skill_tags ?? "");
    performSkillDuration = String(actingSkill?.system?.props?.duration ?? "");
  } catch (_) { /* noop — both are optional gates */ }
  const payloadForTrigger = {
    sourceActorUuid: ar.attackerActorRef,
    subjectActorUuid: ar.attackerActorRef,
    sourceTokenUuid: ar.attacker?.tokenUuid ?? null,
    targets: allTargetUuids,
    targetTokenUuids: allTargetUuids,
    actionIntent: ar.actionIntent ?? "harmful",
    actionKind: ar.kind ?? "Attack",
    actionSkillType: String(ar.skillType ?? "").toLowerCase(),
    // No free-action registry in a harness run — a cast here is never free.
    actionIsFreeCast: false,
    costHp: Number(ar.costSerialized?.hp ?? 0) || 0,
    costMp: Number(ar.costSerialized?.mp ?? 0) || 0,
    costIp: Number(ar.costSerialized?.ip ?? 0) || 0,
    skillTags: performSkillTags,
    skillDuration: performSkillDuration,
    actionIsCheck: !!ar.isCheck,
    actionCanMiss: !!ar.canMiss,
    isCrit: !!ar.roll?.isCrit,
    isFumble: !!ar.roll?.isFumble,
    checkTotal: Number(ar.roll?.total ?? 0) || 0,
    // From the live `actionBase` spread. Both were MISSING from the first draft
    // of this builder and `parity` caught them the moment it was taught about
    // this scan — which is the argument for teaching it, not for trusting a
    // careful transcription.
    weaponType: ar.weapon?.weaponType ?? null,
    damageType: ar.damageType ?? ar.damage?.element ?? null,
    // NB: no `hr` here. The live performer scan does not send one (only the
    // per-target damage scan does), and inventing a field the live path omits
    // fails in the same permissive direction as dropping one.
    rollDieA: Number(ar.roll?.rA ?? 0) || 0,
    rollDieB: Number(ar.roll?.rB ?? 0) || 0,
    rollDieAAttr: String(ar.roll?.A1 ?? ""),
    rollDieBAttr: String(ar.roll?.A2 ?? ""),
    rollCheckBonus: Number(ar.roll?.checkBonus ?? 0) || 0,
    actionName: ar.weapon?.name ?? ar.skillName ?? ar.kind ?? "Action",
    sourceSkillName: ar.skillName ?? ar.weapon?.name ?? null,
    weaponUuid: ar.weapon?.uuid ?? null,
    skillUuid: ar.skillUuid ?? null,
    weaponRange: ar.weapon?.range ?? ar.weapon?.weapon_range ?? null,
  };
  return payloadForTrigger;   // trigger: "creature_performs_action"
}

async function applyAcceptedReactionsToActionResult({ ar, attackerActor, accept, dCombat, deps, picks = null }) {
  if (!accept) return ar;
  if (!Array.isArray(ar?.perTargetResults) || !ar.perTargetResults.length) return ar;
  if (!ar.hasDamage && ar.kind !== "Attack") return ar;
  const { findPassiveCandidates, recomputeActionProfile, freezeActionResult } = deps;

  // Every candidate the CONFIRM-stage scan saw, available or not, with the
  // reason it was refused — stamped on the returned ar as `reactionScanLog`.
  const scanLog = [];
  const byKey = new Map();
  for (const rec of await buildReactionScanPayloads(ar)) {
    const { entry, subjectActorUuid, subjectTokenUuid } = rec;
    const payloadForTrigger = rec.scanPayload;
    let scanned;
    try {
      // includeUnavailable so the harness can report WHY a reaction did not
      // surface. "Not in the list" is ambiguous on its own — it conflates "the
      // gate refused it" with "the trigger never considered it", and those are
      // opposite verdicts when the thing under test IS a gate. The accept path
      // below still consumes available candidates ONLY, so behaviour is
      // unchanged; this only adds the reason to the record.
      scanned = await findPassiveCandidates({
        casterActor: attackerActor,
        trigger: "creature_will_deal_damage",
        payload: payloadForTrigger,
        includeUnavailable: true,
      });
    } catch (e) {
      console.warn(`${TAG} acceptReactions findPassiveCandidates threw for ${entry?.name}`, e);
      continue;
    }
    for (const c of scanned ?? []) {
      scanLog.push({
        carrierName: c?.carrierName ?? null,
        rowKey: c?.rowKey ?? null,
        mode: c?.mode ?? null,
        available: c?.available !== false,
        unavailableKind: c?.unavailableKind ?? null,
        unavailableReason: c?.unavailableReason ?? null,
        skillDuration: payloadForTrigger.skillDuration ?? null,
      });
    }
    const cands = (scanned ?? []).filter((c) => c?.available !== false);
    for (const cand of cands) {
      // Filter to allowed names.
      if (accept !== true) {
        const namesArr = Array.isArray(accept) ? accept : [];
        const accepted = namesArr.some((n) => cand.carrierName?.includes(n) || n.includes(cand.carrierName ?? ""));
        if (!accepted) continue;
      }
      const key = `${cand.rowKey}::${cand.carrierUuid}`;
      let agg = byKey.get(key);
      if (!agg) {
        agg = { ...cand, appliesToTargetUuids: [], appliesToTokenUuids: [], payloadAtFire: payloadForTrigger, _payloadFromHit: !!entry.hit };
        byKey.set(key, agg);
      } else if (entry.hit && !agg._payloadFromHit) {
        agg.payloadAtFire = payloadForTrigger;
        agg._payloadFromHit = true;
      }
      if (entry.hit) {
        agg.appliesToTargetUuids.push(subjectActorUuid);
        if (subjectTokenUuid) agg.appliesToTokenUuids.push(subjectTokenUuid);
      }
    }
  }
  for (const c of byKey.values()) delete c._payloadFromHit;
  // Live play caches the player's option-menu choices onto the candidate at
  // Apply-click (previewReactionMenu -> chosenMenuPicks) and RESOLVE replays
  // them via ctx.menuPicks. The harness never runs that click, so a reaction
  // whose chain opens an `open_action_menu` would prompt for real and hang the
  // pass. Stamping the caller's `picks` into the SAME field is what makes the
  // Warning Shot / Bone Crusher family testable at all.
  if (Array.isArray(picks) && picks.length) {
    for (const c of byKey.values()) c.chosenMenuPicks = [...picks];
  }
  // One row per (carrier, rowKey) — the per-target loop above sees the same
  // candidate once per target, and that repetition is noise, not signal.
  const scanSeen = new Set();
  const reactionScanLog = scanLog.filter((s) => {
    const k = `${s.carrierName}::${s.rowKey}`;
    if (scanSeen.has(k)) return false;
    scanSeen.add(k);
    return true;
  });

  const applied = [...byKey.values()];
  // Even with nothing accepted the scan record is the useful output for a
  // NEGATIVE test ("was it offered, and if not, why") — so it rides along.
  if (!applied.length) return freezeActionResult({ ...ar, reactionScanLog });
  let recomputed = ar.perTargetResults;
  try {
    // Single post-decision recompute — matches production CONFIRM. The `applied`
    // candidates already carry appliesToTargetUuids (built above), so no separate
    // refreshReactionSubjects pass is needed here.
    const delta = await recomputeActionProfile({
      ar, targets: ar.targets, acceptedReactions: applied, round: dCombat?.round ?? 0,
    });
    if (Array.isArray(delta?.perTargetResults) && delta.perTargetResults.length) {
      recomputed = delta.perTargetResults;
    }
  } catch (e) {
    console.warn(`${TAG} acceptReactions recompute threw`, e);
  }
  return freezeActionResult({
    ...ar,
    perTargetResults: recomputed,
    acceptedCardReactions: applied,
    evaluatedCardReactions: applied.map((c) => ({ carrierUuid: c.carrierUuid, rowKey: c.rowKey })),
    reactionScanLog,
  });
}

// ── Reaction probe ──────────────────────────────────────────────────────────
//
// THE way to test a reaction. Read this before hand-building a candidate.
//
// A hand-written candidate that is subtly wrong does not error: it returns
// `mutationsApplied: 0`, so a with-vs-without test compares 0 against 0 and
// PASSES having proved nothing. Two fields cause almost all of it — `rowKey`
// indexes the carrier's `reaction_config_table` (NOT its effect_table), and
// `ref` is the effect row's `effect_label` — and adding `subjectActorUuid`,
// `appliesToTargetUuids` or `decision` gates the candidate straight back out.
//
// So this does not accept a candidate at all. It DISCOVERS them from the real
// scan, fires each one through the real mutation entrypoint, and reports which
// ones actually did something. Nothing is hard-coded, so it cannot drift when
// content changes, and `ok:false / no_reaction_fired` makes "nothing happened"
// impossible to read as a pass.
//
// Returns { ok, candidates[], fired[], scanLog[] } where each candidate carries
// its own before/after: mutationsApplied, accuracyOverride, per-target damage,
// negated, costOverride.
const PROBE_TRIGGERS = Object.freeze(["creature_will_deal_damage", "creature_performs_action"]);

// Fire ONE accepted set through the real pre-resolve mutation entrypoint and
// describe what moved. `ar` is never mutated — applyTargetSetMutation returns
// fresh arrays — so every probe run starts from the same baseline.
async function probeOneAcceptedSet({ ar, accepted, attackerActor, round, deps, gmOverride = null }) {
  const probeAr = gmOverride ? { ...ar, gmOverride } : ar;
  let r;
  try {
    r = await deps.applyTargetSetMutation({
      ar: probeAr, accepted, attackerActor, round, _cb: Date.now(),
    });
  } catch (e) {
    return { ok: false, threw: String(e?.message ?? e) };
  }
  const rows = Array.isArray(r?.perTargetResults) ? r.perTargetResults : [];
  return {
    ok: true,
    mutationsApplied: Number(r?.mutationsApplied ?? 0) || 0,
    negated: !!r?.negated,
    cancelled: !!r?.cancelled,
    accuracyOverride: r?.accuracyOverride ?? null,
    costOverride: r?.costOverride ?? null,
    rollTotal: r?.roll?.total ?? probeAr?.roll?.total ?? null,
    perTarget: rows.map((x) => ({
      name: x?.name ?? null, tokenUuid: x?.tokenUuid ?? null,
      hit: !!x?.hit, crit: !!x?.crit, damage: x?.damage ?? null,
      defense: x?.defense ?? null, affinity: x?.affinity ?? null,
    })),
  };
}

// Did anything actually move between two probe results? This is the assertion a
// reaction test must make FIRST — before comparing any specific number — because
// every other comparison is meaningless if the reaction never ran.
function probeDiff(before, after) {
  if (!before?.ok || !after?.ok) return { changed: false, why: "probe_failed" };
  const bits = [];
  if ((after.mutationsApplied ?? 0) > (before.mutationsApplied ?? 0)) bits.push("mutationsApplied");
  if (JSON.stringify(after.accuracyOverride) !== JSON.stringify(before.accuracyOverride)) bits.push("accuracy");
  if (JSON.stringify(after.costOverride) !== JSON.stringify(before.costOverride)) bits.push("cost");
  if (after.negated !== before.negated) bits.push("negated");
  if (after.rollTotal !== before.rollTotal) bits.push("roll");
  const n = Math.max(before.perTarget.length, after.perTarget.length);
  for (let i = 0; i < n; i++) {
    const b = before.perTarget[i] ?? {}, a = after.perTarget[i] ?? {};
    if (b.damage !== a.damage) bits.push(`damage[${a.name ?? i}]`);
    if (b.hit !== a.hit) bits.push(`hit[${a.name ?? i}]`);
    if (b.defense !== a.defense) bits.push(`defense[${a.name ?? i}]`);
  }
  return { changed: bits.length > 0, fields: bits };
}

async function probeCardReactions({
  skillUuid = null, casterTokenUuid = null, targetTokenUuids = null,
  // A plain weapon ATTACK instead of a skill. Worth its own entry: the
  // `creature_will_deal_damage` family (Cheap Shot, Adversity, …) is the largest
  // reaction class in the game and a no-damage skill never even reaches its
  // scan, so a skill-only probe cannot see most of what exists.
  attack = false, attackMode = "main",
  force = null, round = 1, triggers = null, picks = null,
  // Optional: probe with a GM override bag in force, so a GM edit can be shown
  // to reach the same mutation the reaction does.
  gmOverride = null,
  // Hand back the RAW scanned candidate on each row, for an IN-PAGE caller that
  // wants to mount a real card from them (the screenshot rig). Off by default:
  // raw candidates are not guaranteed structured-cloneable, and every ordinary
  // call crosses the Playwright boundary where that would throw.
  includeRaw = false,
  // Optional: skip the COMPUTE step and probe an actionResult you already have.
  actionResult = null,
  depsToken = null,
} = {}) {
  const _wg = _guardWrites("probeCardReactions");
  if (!game.user?.isGM) return { ok: false, reason: "gm_only" };
  const deps = await loadDeps(depsToken);

  let ar = actionResult;
  if (!ar) {
    if (!casterTokenUuid || !targetTokenUuids?.length || (!attack && !skillUuid)) {
      return { ok: false, reason: "missing_args",
        hint: "casterTokenUuid + targetTokenUuids[], plus either skillUuid or attack:true — or an actionResult" };
    }
    const computed = attack
      ? await runDirectorAttackCompute({
          attackerTokenUuid: casterTokenUuid, targetTokenUuids, mode: attackMode, force, depsToken })
      : await runDirectorSkillCompute({
          skillUuid, casterTokenUuid, targetTokenUuids, force, picks, depsToken });
    if (!computed.ok) return { ok: false, reason: "compute_failed", computed };
    ar = computed.actionResult;
  }
  const attackerActor = ar?.attackerActorRef ? await fromUuid(ar.attackerActorRef).catch(() => null) : null;
  if (!attackerActor) return { ok: false, reason: "attacker_actor_not_found", ref: ar?.attackerActorRef ?? null };

  // ── Discover ───────────────────────────────────────────────────────────────
  // Same payloads the accept path builds, so a gate that reads a field sees the
  // same value it would in play.
  const perTargetPayloads = (await buildReactionScanPayloads(ar)).map((r) => r.scanPayload);
  // Performer-side fires ONCE per action, so its "list" is a single payload.
  const performsPayloads = [await buildPerformsActionPayload(ar)];
  const scanLog = [];
  const byKey = new Map();
  for (const trigger of (Array.isArray(triggers) && triggers.length ? triggers : PROBE_TRIGGERS)) {
    const payloads = trigger === "creature_performs_action" ? performsPayloads : perTargetPayloads;
    for (const payload of payloads) {
      let scanned = null;
      try {
        scanned = await deps.findPassiveCandidates({
          casterActor: attackerActor, trigger, payload, includeUnavailable: true,
        });
      } catch (e) {
        scanLog.push({ trigger, threw: String(e?.message ?? e) });
        continue;
      }
      for (const c of scanned ?? []) {
        const key = `${c?.rowKey}::${c?.carrierUuid}`;
        if (byKey.has(key)) continue;
        byKey.set(key, { ...c, _trigger: trigger });
        scanLog.push({
          trigger, key,
          carrierName: c?.carrierName ?? null, carrierKind: c?.carrierKind ?? null,
          rowKey: c?.rowKey ?? null, ref: c?.ref ?? null, mode: c?.mode ?? null,
          available: c?.available !== false,
          unavailableKind: c?.unavailableKind ?? null,
          unavailableReason: c?.unavailableReason ?? null,
        });
      }
    }
  }
  const candidates = [...byKey.values()];
  if (!candidates.length) {
    return { ok: false, reason: "no_candidates_scanned", scanLog,
      hint: "The trigger never offered a reaction here — check the attacker OWNS the carrier (a performer-side reaction only fires for its own actor) and that the scene/canvas matches the fixtures." };
  }

  // ── Fire each one, alone, through the real entrypoint ──────────────────────
  const baseline = await probeOneAcceptedSet({ ar, accepted: [], attackerActor, round, deps, gmOverride });
  const results = [];
  for (const cand of candidates) {
    // Menu picks are cached on the candidate at Apply-click in play; without them
    // an open_action_menu chain prompts for real and hangs a headless run.
    const c = (Array.isArray(picks) && picks.length) ? { ...cand, chosenMenuPicks: [...picks] } : cand;
    const after = await probeOneAcceptedSet({ ar, accepted: [c], attackerActor, round, deps, gmOverride });
    const diff = probeDiff(baseline, after);
    results.push({
      key: `${cand.rowKey}::${cand.carrierUuid}`,
      carrierName: cand.carrierName ?? null, carrierKind: cand.carrierKind ?? null,
      carrierUuid: cand.carrierUuid ?? null, rowKey: cand.rowKey ?? null, ref: cand.ref ?? null,
      mode: cand.mode ?? null, trigger: cand._trigger,
      available: cand.available !== false,
      unavailableReason: cand.available === false ? (cand.unavailableReason ?? null) : null,
      // Whether the shipped editor would offer this row. The product rule now
      // excludes `usesAddTarget` itself, so no harness-side guard is needed:
      // `_addTarget` is only stamped by state-handlers' CONFIRM dispatch and is
      // therefore always absent on a directly-scanned candidate, but
      // `usesAddTarget` comes from the scan and is present in both paths.
      editableByGm: !!deps.isGmEditableReaction?.(cand),
      usesAddTarget: !!cand.usesAddTarget,
      // A real observed change against the no-reaction baseline, not "the call
      // returned ok". Note this is measured for UNAVAILABLE candidates too — see
      // the split below.
      changed: !!diff.changed,
      // The gate. An UNAVAILABLE candidate is never accepted in play (the card
      // filters condition-unavailable rows out entirely and auto-accepts only
      // `available !== false`), so counting one as "fired" would report a
      // reaction that cannot happen — the same false-green this probe exists to
      // prevent, arrived at from the other side. What it CAN prove is what a GM
      // force would produce, which is `firesIfForced`.
      fired: !!diff.changed && cand.available !== false,
      firesIfForced: !!diff.changed && cand.available === false,
      changedFields: diff.fields ?? [],
      probe: after,
      ...(includeRaw ? { candidate: cand } : {}),
    });
  }
  const fired = results.filter((r) => r.fired);
  const forcedOnly = results.filter((r) => r.firesIfForced);
  return {
    // ok:false when nothing the live card would ACCEPT fired — the whole point.
    // A caller that reads `ok` can never mistake an inert probe for a pass.
    ok: fired.length > 0,
    reason: fired.length ? null : (forcedOnly.length ? "only_fires_if_forced" : "no_reaction_fired"),
    hint: fired.length ? null
      : forcedOnly.length
        ? `${forcedOnly.length} candidate(s) would fire but are unavailable here (${forcedOnly.map((r) => `${r.carrierName}: ${r.unavailableReason}`).join("; ")}). In play the card never accepts those — only a GM force can.`
        : "Every scanned candidate left the action unchanged. Usually the carrier's owner is not the attacker (performer-side reactions only fire for their own actor), or the row's effect chain does nothing at this stage.",
    baseline, candidates: results, fired, forcedOnly, scanLog,
  };
}

// ─── Target-SIDE reaction probe ─────────────────────────────────────────────
//
// `probeCardReactions` scans `findPassiveCandidates({ casterActor: attackerActor })`
// for EVERY trigger, so it can only surface the ATTACKER's carriers. The
// defender-side family — `creature_targeted_by_action` — was structurally
// invisible to it: probing "Zarg attacks Hina" returned Zarg's Barrage and ZERO
// Hina reactions for every pairing, while a weaponless defender reported
// `no_main_weapon`, which reads like a rig fault and hides the real limit.
//
// Mirrors CONFIRM's third-party loop (state-handlers ~5098-5245) as closely as a
// harness can. Every deviation found by review is called out at its line.
//
// Two observation channels, because a defender reaction lands in either:
//   * card mutation  - adjust_defense / accuracy / redirect (probeOneAcceptedSet)
//   * document write - apply_ae / grant / charge (installWriteCaptures around
//                      the real firePreAcceptedCandidate)
// `fired` = EITHER moved AND the candidate was available. A candidate that moves
// nothing is not a pass; the baseline runs with an empty accepted-set so the
// comparison can fail.
//
// ⚠ NOT covered: `findTargetOwnedCandidates` — the acting SKILL can grant the
// TARGET a reaction (Condemn / Torment style redirects), which live scans in the
// same loop (~5245). Those rows will report `no_candidates_scanned` here. Out of
// scope deliberately; do not read a null result as "that skill is dormant".
async function probeTargetedReactions({
  attackerTokenUuid = null, targetTokenUuids = null,
  skillUuid = null, attack = true, attackMode = "main",
  force = null, round = 1,
  reactorNames = null,
  trigger = "creature_targeted_by_action",
  // Menu picks for an open_action_menu inside a defender chain. Without these a
  // chain containing one PROMPTS FOR REAL and hangs the run — installHeadlessGates
  // deliberately does not cover open_action_menu.
  picks = null,
  preApply = null, seed = null, override = null,
  depsToken = null,
} = {}) {
  const _wg = _guardWrites("probeTargetedReactions");
  if (!game.user?.isGM) return { ok: false, reason: "gm_only" };
  if (!attackerTokenUuid || !targetTokenUuids?.length) {
    return { ok: false, reason: "missing_args",
      hint: "attackerTokenUuid + targetTokenUuids[], plus skillUuid when attack:false" };
  }
  const deps = await loadDeps(depsToken);
  const RD = await import(`./reaction-derive.js?harness=${Date.now()}`);

  // World-state fixtures are installed ONCE, around EVERYTHING — the scan, both
  // mutation probes and every fire. Installing them only around the fire (the
  // first version of this function) meant `available` / `unavailableReason` and
  // the whole card channel were computed against the UN-seeded world while the
  // fire saw the seeded one: two channels, two world states, one verdict.
  const formulaOverrides = installFormulaOverrides(override);
  const preApplied = await installPreAppliedAEs(preApply);
  const seeded = await installSeededProps(seed);
  const headlessGates = installHeadlessGates();
  const passiveAcceptor = installPassiveAutoAcceptor(true);
  try {
    const computed = attack
      ? await runDirectorAttackCompute({ attackerTokenUuid, targetTokenUuids, mode: attackMode, force, depsToken })
      : await runDirectorSkillCompute({ skillUuid, casterTokenUuid: attackerTokenUuid, targetTokenUuids, force, depsToken });
    if (!computed?.ok) return { ok: false, reason: "compute_failed", computed };
    const ar = computed.actionResult;
    const attackerActor = ar?.attackerActorRef ? await fromUuid(ar.attackerActorRef).catch(() => null) : null;
    if (!attackerActor) return { ok: false, reason: "attacker_actor_not_found" };

    // ── Scope gate — mirrors state-handlers ~5098 ────────────────────────────
    // CONFIRM only runs this scan for an Attack, an Item, or a Skill that deals
    // damage / heals / is harmful. Without this the probe scans a path the game
    // never enters and reports a green result for it.
    const inScope = Array.isArray(ar.targets) && ar.targets.length > 0
      && (ar.kind === "Attack" || ar.kind === "Item"
        || (ar.kind === "Skill" && (ar.hasDamage || ar.hasHealing || ar.actionIntent === "harmful")));
    if (trigger === "creature_targeted_by_action" && !inScope) {
      return { ok: false, reason: "out_of_scope_for_trigger", actionKind: ar.kind,
        hint: "CONFIRM fires creature_targeted_by_action only for Attack / Item / (Skill with damage, healing or harmful intent). This action does not qualify, so the scan never runs in play either." };
    }

    const effectiveIntent = ar.actionIntent ?? (ar.kind === "Attack" ? "harmful" : null);
    const cardCtx = {
      targetTokenUuids: (ar.targets ?? []).map((t) => t.tokenUuid),
      attackerActorUuid: ar.attackerActorRef ?? null,
      attackerTokenUuid: ar.attacker?.tokenUuid ?? null,
      actionIntent: effectiveIntent,
      actionKind: ar.kind ?? null,
      actionName: ar.skillName ?? ar.weapon?.name ?? ar.kind ?? null,
      sourceSkillName: ar.skillName ?? ar.weapon?.name ?? null,
      checkTotal: Number(ar.roll?.total ?? 0) || 0,
      isCrit: !!ar.roll?.isCrit,
      isFumble: !!ar.roll?.isFumble,
      weaponRange: ar.weapon?.range ?? ar.weapon?.weapon_range ?? null,
      weaponType: ar.weapon?.weaponType ?? null,
      damageType: ar.damageType ?? ar.damage?.element ?? null,
      // Gate on ar.canMiss, NOT ar.defenseTargetType. defenseTargetType is the
      // EMPTY STRING for any weapon with no authored value, so keying off it
      // sent null for the ordinary weapon-Attack case and Verónica's
      // `ATTACK_VS_DEF == 1` read 0 — dormant under test, firing in play.
      defenseResolved: ar.canMiss
        ? (deps.resolvesVsMagicDefense?.({ defenseTargetType: ar.defenseTargetType,
            isSpell: String(ar.skillType ?? "").toLowerCase() === "spell" }) ? "mdef" : "def")
        : null,
    };

    // ── Reactor set — mirrors state-handlers ~5115-5126 ──────────────────────
    // Live walks dCombat combatants, skipping the DEFEATED and the ATTACKER.
    // Taking every canvas placeable instead let the attacker react to its own
    // action, which makes a `reaction_source: enemy` row match on a carrier
    // CONFIRM structurally cannot produce — a fired:true for something
    // unreachable in play.
    const attackerActorUuid = attackerActor.uuid;
    const reactorActors = new Map();
    // A harness run has no live DirectorCombat, so the canvas walk below IS the
    // path here. Both live exclusions are kept so the candidate set stays
    // reachable-in-play.
    const combatants = [];
    const addReactor = (a, defeated) => {
      if (!a || defeated) return;
      if (a.uuid === attackerActorUuid) return;                    // live: skip the attacker
      if (reactorNames && !reactorNames.includes(a.name)) return;
      reactorActors.set(a.uuid, a);
    };
    if (combatants.length) {
      for (const c of combatants) addReactor(c?.actorDoc ?? null, !!c?.defeated);
    } else {
      // No live combat in a harness run — fall back to canvas tokens, but keep
      // BOTH live exclusions so the candidate set stays reachable-in-play.
      for (const t of (canvas?.tokens?.placeables ?? [])) {
        const a = t?.actor;
        const defeated = !!(t?.document?.overlayEffect) || !!a?.statuses?.has?.("dead");
        addReactor(a, defeated);
      }
    }
    if (!reactorActors.size) return { ok: false, reason: "no_reactors_available" };

    // ── One payload per SUBJECT ──────────────────────────────────────────────
    // Base = the ACTION-LEVEL half only. Spreading the full per-target
    // scanPayload also injected rawDamage / hitMargin / affinity / valueType /
    // hitTargets — attacker-side keys live NEVER sends to this trigger. Those
    // read as real values under test and 0 in play (RAW_DAMAGE, HIT_MARGIN), and
    // hitTargetTokenUuids changed which creatures `hit_action_targets` resolved
    // to inside a defender chain.
    const actionBase = await buildHarnessActionBase(ar);
    const subjects = [];
    for (const target of (ar.targets ?? [])) {
      const actorUuid = target?.actorUuid; if (!actorUuid) continue;
      const pt = (ar.perTargetResults ?? []).find((r) => r?.actorUuid === actorUuid
        || (r?.tokenUuid && r.tokenUuid === target?.tokenUuid));
      subjects.push({
        actorUuid, tokenUuid: target?.tokenUuid ?? pt?.tokenUuid ?? null,
        name: target?.name ?? pt?.name ?? null,
        incomingDamage: pt?.hit ? Math.max(0, Number(pt.damage ?? 0) || 0) : 0,
        hit: !!pt?.hit,
      });
    }
    // Contract check that can actually FAIL: compare the ASSEMBLED payload
    // against the union live sends (TARGETED_PAYLOAD_KEYS + the action base),
    // in BOTH directions. Checking buildTargetedPayload against the list it is
    // written to satisfy was a tautology — it reported ok:true unconditionally
    // and was exactly the reassurance that hid the four real payload defects.
    const expected = new Set([...(RD.TARGETED_PAYLOAD_KEYS ?? []), ...Object.keys(actionBase ?? {})]);
    const payloads = subjects.map((s) => ({
      subject: s, payload: { ...actionBase, ...RD.buildTargetedPayload(s, cardCtx) },
    }));
    const sample = payloads[0]?.payload ?? {};
    const missingKeys = [...expected].filter((k) => !(k in sample));
    const extraKeys = Object.keys(sample).filter((k) => !expected.has(k));

    // ── Discover, per reactor ────────────────────────────────────────────────
    const scanLog = [];
    const byKey = new Map();
    for (const { subject, payload } of payloads) {
      for (const reactor of reactorActors.values()) {
        let scanned = null;
        try {
          scanned = await deps.findPassiveCandidates({
            casterActor: reactor, trigger, payload, includeUnavailable: true,
          });
        } catch (e) { scanLog.push({ reactor: reactor.name, threw: String(e?.message ?? e) }); continue; }
        for (const c of scanned ?? []) {
          const key = `${c?.rowKey}::${c?.carrierUuid}::${reactor.uuid}::${subject.actorUuid}`;
          if (byKey.has(key)) continue;
          byKey.set(key, { cand: c, reactor, subject, payload });
          scanLog.push({ reactor: reactor.name, subject: subject.name, carrierName: c?.carrierName ?? null,
            rowKey: c?.rowKey ?? null, ref: c?.ref ?? null, available: c?.available !== false,
            unavailableReason: c?.unavailableReason ?? null });
        }
      }
    }
    const payloadContract = { missingKeys, extraKeys, ok: missingKeys.length === 0 && extraKeys.length === 0 };
    if (!byKey.size) {
      return { ok: false, reason: "no_candidates_scanned", scanLog, payloadContract,
        reactorsScanned: [...reactorActors.values()].map((a) => a.name),
        hint: "No reactor owns a carrier for this trigger under this payload. Note this probe does NOT cover skill-granted target-owned rows (findTargetOwnedCandidates)." };
    }

    const baseline = await probeOneAcceptedSet({ ar, accepted: [], attackerActor, round, deps });
    const results = [];
    for (const { cand, reactor, subject, payload } of byKey.values()) {
      const stamped = { ...cand, reactorActorUuid: reactor.uuid, reactorActorName: reactor.name,
        subjectActorUuid: subject.actorUuid, payloadAtFire: payload,
        ...(Array.isArray(picks) && picks.length ? { chosenMenuPicks: [...picks] } : {}) };

      const after = await probeOneAcceptedSet({ ar, accepted: [stamped], attackerActor, round, deps });
      const mutDiff = probeDiff(baseline, after);

      const { captures, restore } = await installWriteCaptures();
      let fireErr = null, fireRes = null;
      try {
        // TIMEOUT is not optional here: an unanswered prompt inside this await
        // means restore() never runs, and from then on every update() in the
        // page is captured instead of committed while still reporting success.
        // Every later measurement in the session would be void.
        fireRes = await withHarnessTimeout(
          deps.firePreAcceptedCandidate({ director: null, casterActor: reactor, candidate: stamped, payload }),
          `targeted reaction ${reactor.name}/${cand.carrierName}`,
        );
      } catch (e) { fireErr = String(e?.message ?? e); }
      finally { restore(); }

      const writes = summarizeWrites(captures);
      // summarizeWrites drops aeUpdates + itemUpdates, so a reaction whose whole
      // effect is a charge/intensity write (skill-charges) or an equip flip read
      // as "changed nothing" and got reported as broken data.
      const wrote = writes.some((w) =>
        Object.keys(w.propPatches ?? {}).length || (w.aeApplied ?? []).length || (w.aeRemoved ?? []).length)
        || (captures.aeUpdates ?? []).length > 0
        || (captures.itemUpdates ?? []).length > 0;
      const moved = !!mutDiff.changed || wrote;

      results.push({
        key: `${cand.rowKey}::${cand.carrierUuid}::${reactor.uuid}`,
        reactor: reactor.name, reactorUuid: reactor.uuid,
        subject: subject.name, subjectUuid: subject.actorUuid,
        carrierName: cand.carrierName ?? null, carrierKind: cand.carrierKind ?? null,
        rowKey: cand.rowKey ?? null, ref: cand.ref ?? null, mode: cand.mode ?? null, trigger,
        available: cand.available !== false,
        unavailableReason: cand.available === false ? (cand.unavailableReason ?? null) : null,
        fired: moved && cand.available !== false,
        firesIfForced: moved && cand.available === false,
        changed: moved,
        changedFields: mutDiff.fields ?? [],
        wroteDocuments: wrote,
        writes,
        aeUpdates: (captures.aeUpdates ?? []).length,
        itemUpdates: (captures.itemUpdates ?? []).length,
        fireOk: fireRes?.ok ?? null, fireReason: fireRes?.reason ?? null, fireError: fireErr,
        probe: after,
      });
    }
    const fired = results.filter((r) => r.fired);
    const forcedOnly = results.filter((r) => r.firesIfForced);
    return {
      ok: fired.length > 0,
      reason: fired.length ? null : (forcedOnly.length ? "only_fires_if_forced" : "no_reaction_fired"),
      hint: fired.length ? null
        : forcedOnly.length
          ? `${forcedOnly.length} candidate(s) would fire but are unavailable here.`
          : "Every scanned candidate left both the card AND the documents unchanged.",
      payloadContract,
      reactorsScanned: [...reactorActors.values()].map((a) => a.name),
      baseline, candidates: results, fired, forcedOnly, scanLog,
    };
  } finally {
    passiveAcceptor.restore();
    headlessGates.restore();
    await seeded.cleanup();
    await preApplied.cleanup();
    formulaOverrides.restore();
  }
}

// ─── Per-reactor, any-trigger reaction probe ───────────────────────────────
//
// Covers the LIFECYCLE + subject-side families (conflict_start, turn_start,
// round_start, turn_end, creature_lose_resource, creature_deals_damage, …)
// that neither `probeCardReactions` (attacker-only) nor
// `probeTargetedReactions` (targeted payload) reaches.
//
// ⚠ Why this does NOT go through `firePassiveTriggers`:
// `runDirectorPassiveTriggerTest` calls it with `director: null`, and
// `standalone-reactions.dispatchReactionMenu` opens with
//     if (!director || !reactor || !token || !trigger) return { fired: [] };
// so that entry point returns an EMPTY `fired` list for every input — it can
// never observe a reaction firing, and a sweep through it reports "nothing
// fires" for a party whose scan shows five available force-mode rows. Measured
// 2026-08-19 across 4 actors x 4 triggers: 16/16 empty, while
// findPassiveCandidates returned candidates for the same actor+trigger+payload.
//
// So this scans with the real `findPassiveCandidates` and then fires each
// candidate ALONE through the real `firePreAcceptedCandidate`, with write
// captures installed — the same two-step `probeTargetedReactions` uses. No menu,
// no director required, and every candidate is isolated so one cannot mask
// another.
async function probeReactorTrigger({
  reactorName = null, reactorActorUuid = null,
  trigger = null, payload = null,
  // Extra payload keys merged OVER the self-default (e.g. a resource-loss
  // amount, or a cause actor). Explicit keys always win.
  payloadExtra = null,
  preApply = null, seed = null, override = null,
  depsToken = null,
} = {}) {
  const _wg = _guardWrites("probeReactorTrigger");
  if (!game.user?.isGM) return { ok: false, reason: "gm_only" };
  if (!trigger) return { ok: false, reason: "missing_trigger" };
  const deps = await loadDeps(depsToken);

  let reactor = null;
  if (reactorActorUuid) reactor = await fromUuid(reactorActorUuid).catch(() => null);
  if (!reactor && reactorName) {
    const t = (canvas?.tokens?.placeables ?? []).find((x) => x.actor?.name === reactorName);
    reactor = t?.actor ?? game.actors?.find((a) => a.name === reactorName) ?? null;
  }
  if (!reactor) return { ok: false, reason: "reactor_not_found", reactorName, reactorActorUuid };

  const token = (canvas?.tokens?.placeables ?? []).find((x) => x.actor?.uuid === reactor.uuid)?.document ?? null;

  // Default payload: the reactor is BOTH source and subject, which is what every
  // lifecycle trigger means ("my conflict started", "my turn began").
  const basePayload = {
    sourceActorUuid: reactor.uuid, subjectActorUuid: reactor.uuid,
    sourceTokenUuid: token?.uuid ?? null, subjectTokenUuid: token?.uuid ?? null,
  };
  const finalPayload = { ...basePayload, ...(payload ?? {}), ...(payloadExtra ?? {}) };

  // Fixtures wrap EVERYTHING (scan + every fire), so availability and the fire
  // see the SAME world. Installing them per-candidate meant the scan verdict was
  // computed against an un-seeded world.
  const formulaOverrides = installFormulaOverrides(override);
  const preApplied = await installPreAppliedAEs(preApply);
  const seeded = await installSeededProps(seed);
  const headlessGates = installHeadlessGates();
  const passiveAcceptor = installPassiveAutoAcceptor(true);
  const teardown = async () => {
    passiveAcceptor.restore(); headlessGates.restore();
    await seeded.cleanup(); await preApplied.cleanup(); formulaOverrides.restore();
  };

  let scanned = null;
  try {
    scanned = await deps.findPassiveCandidates({
      casterActor: reactor, trigger, payload: finalPayload, includeUnavailable: true,
    });
  } catch (e) {
    await teardown();
    return { ok: false, reason: "scan_threw", error: String(e?.message ?? e), payload: finalPayload };
  }
  const cands = scanned ?? [];
  if (!cands.length) {
    await teardown();
    return { ok: false, reason: "no_candidates_scanned", reactor: reactor.name, trigger,
      payload: finalPayload, candidates: [],
      hint: "No row on this actor declares this reaction_trigger, or a filter rejected the payload. Check reaction_trigger spelling and that the reactor has a token on the CANVAS scene." };
  }

  const results = [];
  for (const cand of cands) {
    const { captures, restore } = await installWriteCaptures();
    let fireErr = null, fireRes = null;
    try {
      // A bare await here is a poisoned-client hazard: an unanswered prompt means
      // restore() never runs and every later update() in the page is captured
      // instead of committed, while still reporting success.
      fireRes = await withHarnessTimeout(
        deps.firePreAcceptedCandidate({ director: null, casterActor: reactor, candidate: cand, payload: finalPayload }),
        `reactor trigger ${reactor.name}/${cand.carrierName}`,
      );
    } catch (e) { fireErr = String(e?.message ?? e); }
    finally { restore(); }
    const writes = summarizeWrites(captures);
    // summarizeWrites drops aeUpdates + itemUpdates; a charge/equip-only reaction
    // would otherwise report as having done nothing.
    const wrote = writes.some((w) =>
      Object.keys(w.propPatches ?? {}).length || (w.aeApplied ?? []).length || (w.aeRemoved ?? []).length)
      || (captures.aeUpdates ?? []).length > 0
      || (captures.itemUpdates ?? []).length > 0;
    results.push({
      carrierName: cand.carrierName ?? null, carrierKind: cand.carrierKind ?? null,
      rowKey: cand.rowKey ?? null, ref: cand.ref ?? null, mode: cand.mode ?? null, trigger,
      available: cand.available !== false,
      unavailableReason: cand.available === false ? (cand.unavailableReason ?? null) : null,
      // An UNAVAILABLE row is never accepted in play, so it can only be forced.
      fired: wrote && cand.available !== false,
      firesIfForced: wrote && cand.available === false,
      wroteDocuments: wrote, writes,
      aeUpdates: (captures.aeUpdates ?? []).length,
      itemUpdates: (captures.itemUpdates ?? []).length,
      fireOk: fireRes?.ok ?? null, fireReason: fireRes?.reason ?? null, fireError: fireErr,
    });
  }
  await teardown();
  const fired = results.filter((r) => r.fired);
  return {
    ok: fired.length > 0,
    reason: fired.length ? null
      : (results.some((r) => r.firesIfForced) ? "only_fires_if_forced" : "no_reaction_fired"),
    reactor: reactor.name, trigger, payload: finalPayload,
    candidates: results, fired,
  };
}

// Prove a GM force / suppress verdict reaches the engine, for ONE candidate that
// the probe has already shown to fire.
//
// The three runs are the whole argument: the reaction ON, the reaction OFF, and
// the GM's verdict — which must land on the OPPOSITE of what the card decided by
// itself. The accepted list is derived through the SAME decision-map rewrite the
// card performs (gmReactionDecisionChanges), so this exercises the shipped path
// rather than a restatement of it.
async function probeGmReactionOverride({
  skillUuid = null, casterTokenUuid = null, targetTokenUuids = null,
  attack = false, attackMode = "main",
  force = null, round = 1, picks = null, carrierName = null, depsToken = null,
} = {}) {
  const probe = await probeCardReactions({ skillUuid, casterTokenUuid, targetTokenUuids, attack, attackMode, force, round, picks, depsToken });
  // A COST-unavailable candidate that would fire is a legitimate subject here —
  // overruling a price is exactly what force is for, and the editor offers those
  // rows. So `only_fires_if_forced` is not a dead end for THIS test, unlike for
  // probeCardReactions, whose job is to report what the card does on its own.
  const pool = [...(probe.fired ?? []), ...(probe.forcedOnly ?? [])].filter((f) => f.editableByGm);
  if (!probe.ok && !pool.length) return { ok: false, reason: probe.reason ?? "probe_failed", probe };
  const target = carrierName
    ? pool.find((f) => String(f.carrierName ?? "").includes(carrierName))
    : pool.find((f) => f.fired) ?? pool[0];
  if (!target) {
    return { ok: false, reason: "no_firing_candidate_matched", carrierName,
      fired: probe.fired, forcedOnly: probe.forcedOnly,
      hint: "Nothing that fires here is GM-editable — `_addTarget` and condition-unavailable rows are deliberately outside the editor." };
  }
  const deps = await loadDeps(depsToken);
  const row = { rowKey: target.rowKey, carrierUuid: target.carrierUuid, carrierName: target.carrierName };
  const key = deps.gmReactionKey(target.rowKey, target.carrierUuid);
  // What the card's reconcile does to its decision map, through the SHIPPED
  // helper. Both directions, each against the state that makes it meaningful:
  // suppress a candidate the card accepted, force one the card skipped.
  const suppress = deps.gmReactionDecisionChanges([row], { reactions: { [key]: false } },
    () => "apply", () => "apply");
  const forceOn = deps.gmReactionDecisionChanges([row], { reactions: { [key]: true } },
    () => null, () => null);
  const flipsOk = suppress.length === 1 && suppress[0].decision === "skip"
    && forceOn.length === 1 && forceOn[0].decision === "apply";
  // The decision map's two states ARE these two engine runs: an accepted
  // candidate produced `withReaction`, an empty accepted list produced
  // `withoutReaction`. `changedFields` is the measured difference between them,
  // so "the GM's verdict changes the outcome" is observed, not argued.
  //
  // `changed` (not `fired`) is the gate: a cost-unavailable candidate is a valid
  // subject — force is precisely how it gets to happen — and it reports
  // fired:false because the card alone would never accept it.
  return {
    ok: flipsOk && target.changed,
    reason: !target.changed ? "candidate_did_not_fire"
      : flipsOk ? null : "decision_flip_failed",
    // Whether the card could have accepted this on its own, or only a GM force
    // can reach it. Both are real cases; conflating them is not.
    onlyReachableByForce: !target.fired && target.changed,
    target,
    withReaction: target.probe,
    withoutReaction: probe.baseline,
    changedFields: target.changedFields,
    decisionChanges: { suppress, force: forceOn },
  };
}

const TAG = "[FUCompanion][DirectorTest]";

// Build an attacker snapshot from a token document, matching the shape
// snapshotCombatant returns. Used as the synthetic turnSnapshot for
// COMPUTE — no active combat required.
function buildAttackerSnapshot(tokenDoc, deps) {
  const { readPropNum, attrDieSize, resolveAttackerWeapon } = deps;
  const actor = tokenDoc?.actor;
  if (!actor) return null;
  return Object.freeze({
    combatantId: `harness:${tokenDoc.id}`,
    tokenId: tokenDoc.id,
    tokenUuid: tokenDoc.uuid,
    actorId: actor.id,
    actorUuid: actor.uuid,
    name: actor.name ?? "Unknown",
    tokenImg: tokenDoc.texture?.src ?? tokenDoc.img ?? actor.img ?? null,
    disposition: tokenDoc.disposition ?? 0,
    hp: readPropNum(actor, ["current_hp", "hp"]),
    maxHp: readPropNum(actor, ["max_hp"]),
    mp: readPropNum(actor, ["current_mp", "mp"]),
    maxMp: readPropNum(actor, ["max_mp"]),
    defense: readPropNum(actor, ["defense", "current_def", "def"]),
    magicDefense: readPropNum(actor, ["magic_defense", "current_mdef", "mdef"]),
    attributes: Object.freeze({
      DEX: attrDieSize(actor, "DEX"),
      INS: attrDieSize(actor, "INS"),
      MIG: attrDieSize(actor, "MIG"),
      WLP: attrDieSize(actor, "WLP"),
    }),
    fumbleThreshold: readPropNum(actor, ["fumble_threshold"], 1),
    // `resolveAttackerWeapon` returns the weapon-shaped object DIRECTLY
    // (not wrapped in `{ weapon }`). Mirror snapshot.js buildWeaponBundle.
    weapon: resolveAttackerWeapon(actor, { which: "main" }) ?? null,
    offWeapon: resolveAttackerWeapon(actor, { which: "off" }) ?? null,
  });
}

// Build an eligible-target snapshot from a token document, matching
// the shape snapshotEligibleTargets returns.
function buildTargetSnapshot(tokenDoc, deps) {
  const { readPropNum, readAffinities } = deps;
  const actor = tokenDoc?.actor;
  if (!actor) return null;
  return Object.freeze({
    combatantId: `harness:${tokenDoc.id}`,
    tokenId: tokenDoc.id,
    tokenUuid: tokenDoc.uuid,
    actorId: actor.id,
    actorUuid: actor.uuid,
    worldActorUuid: (game.actors?.get?.(tokenDoc.actorId)?.uuid) ?? actor.uuid,
    name: actor.name,
    tokenImg: tokenDoc.texture?.src ?? tokenDoc.img ?? actor.img ?? null,
    disposition: tokenDoc.disposition ?? 0,
    hp: readPropNum(actor, ["current_hp", "hp"]),
    maxHp: readPropNum(actor, ["max_hp"]),
    defense: readPropNum(actor, ["defense", "current_def", "def"]),
    magicDefense: readPropNum(actor, ["magic_defense", "current_mdef", "mdef"]),
    affinities: readAffinities(actor),
    conditions: Object.freeze([]),  // harness skips status readout
  });
}

// Build the initial actionResult skeleton that TARGET stamps for
// Skill / Spell commands. COMPUTE reads from this + adds the
// computed fields (damage, perTargetResults, hitTokenUuids, roll).
function buildInitialActionResult(skill, attackerSnap, targetSnaps, deps) {
  const { freezeActionResult, classifyActionIntent } = deps;
  const p = skill.system?.props ?? {};
  return freezeActionResult({
    kind: "Skill",
    attacker: attackerSnap,
    attackerActorRef: attackerSnap.actorUuid,
    skillUuid: skill.uuid,
    skillName: skill.name,
    skillImg: skill.img,
    skillType: String(p.skill_type ?? ""),
    // Mirror real COMPUTE (state-handlers.js): the DEF/MDEF the accuracy check
    // resolves against. Without this the harness would fall back to isSpell →
    // MDEF and mis-model DEF-targeting spells (e.g. Ignis Finis: a Spell that
    // checks vs DEF), both for the hit test and the strike/magic damage class.
    defenseTargetType: String(p.defense_target_type ?? "").toLowerCase(),
    isCheck: !!p.isCheck,
    rolledA1: String(p.rolled_atr1 ?? "").toUpperCase(),
    rolledA2: String(p.rolled_atr2 ?? "").toUpperCase(),
    checkBonus: Number(p.check_bonus ?? 0) || 0,
    damageBonus: p.damage_bonus ?? 0,
    damageType: String(p.type_damage ?? ""),
    skillRange: String(p.skill_range ?? ""),
    skillTarget: String(p.skill_target ?? "").toLowerCase(),
    sourceItemUuid: null,
    descriptionHtml: String(p.description ?? ""),
    targets: targetSnaps,
    costSerialized: {},
    rawCost: String(p.cost ?? ""),
    actionIntent: classifyActionIntent(skill),
  });
}

// Optional roll override — pre-stocks the dice RNG with deterministic
// values so the `new Roll(...)` inside COMPUTE produces the requested
// face results.
//
// Foundry V12 uses `CONFIG.Dice.randomUniform` (a Mersenne Twister
// wrapper), NOT `Math.random`. Die roll computes face as
// `Math.ceil((1 - CONFIG.Dice.randomUniform()) * N)` — note the
// (1 - v) inversion. To force face R out of dN, randomUniform must
// return v where `ceil((1 - v) * N) === R`, i.e.
// v ∈ [1 - R/N, 1 - (R - 1)/N). Center: v = 1 - (R - 0.5)/N.
// Expand semantic force shorthands (`hit`, `miss`, `crit`, `fumble`) into
// concrete dice values that produce the requested outcome. Raw `{rA, rB}`
// values in `force` are preserved and override semantic flags.
//
// Decision rules (in order):
//   crit:   rA = rB = max die (8 / 10 / 12 etc.) — paired top dice. Author
//           intent: "show me what happens on crit". Caller may want a
//           specific paired non-max via raw rA/rB.
//   fumble: rA = rB = 1 (always satisfies fumbleThreshold ≥ 1)
//   hit:    pick the SMALLEST (rA, rB) where rA + rB + checkBonus
//           >= min(target.defense | magic_defense). If even max dice can't
//           hit, falls back to max + max (caller gets to see the miss).
//   miss:   pick the LARGEST (rA, rB) where rA + rB + checkBonus < target's
//           defense. Avoids fumble (both ≤ threshold) and crit (rA === rB
//           ≥ 6). Falls back to (1, 2) if no valid combo (target is too
//           weak — caller's request is impossible without fumbling).
function expandForceSemantics(force, { dA, dB, fumbleThreshold, checkBonus, isSpell, targetSnaps }) {
  if (!force) return null;
  const out = { ...force };
  if (Number.isFinite(out.rA) && Number.isFinite(out.rB)) return out;

  const defs = (targetSnaps ?? []).map((t) => isSpell ? (t.magicDefense ?? 0) : (t.defense ?? 0));
  const minDef = defs.length ? Math.min(...defs) : 0;

  if (force.crit) { out.rA = dA; out.rB = dA === dB ? dB : dA; return out; }
  if (force.fumble) { out.rA = 1; out.rB = 1; return out; }
  if (force.hit) {
    // Greedy: cheapest hit. Iterate (a, b) where a+b+checkBonus >= minDef.
    for (let a = 1; a <= dA; a++) {
      for (let b = 1; b <= dB; b++) {
        if (a === b && a >= 6) continue;  // skip crit
        if (a <= fumbleThreshold && b <= fumbleThreshold) continue;  // skip fumble
        if (a + b + checkBonus >= minDef) { out.rA = a; out.rB = b; return out; }
      }
    }
    out.rA = dA; out.rB = dB;  // even max can't hit — caller sees the miss
    return out;
  }
  if (force.miss) {
    for (let a = dA; a >= 1; a--) {
      for (let b = dB; b >= 1; b--) {
        if (a === b && a >= 6) continue;
        if (a <= fumbleThreshold && b <= fumbleThreshold) continue;
        if (a + b + checkBonus < minDef) { out.rA = a; out.rB = b; return out; }
      }
    }
    out.rA = 1; out.rB = 2;  // no valid combo — caller sees a fumble-ish result
    return out;
  }
  return out;
}

function installRollOverride(force, dA, dB) {
  if (!force) return { restore() {} };
  const rA = Number(force.rA ?? force.forceA);
  const rB = Number(force.rB ?? force.forceB);
  if (!Number.isFinite(rA) && !Number.isFinite(rB)) return { restore() {} };

  const pending = [];
  if (Number.isFinite(rA)) pending.push({ R: rA, N: dA || 20 });
  if (Number.isFinite(rB)) pending.push({ R: rB, N: dB || 20 });

  const original = CONFIG.Dice.randomUniform;
  CONFIG.Dice.randomUniform = function harnessRandomUniform() {
    const next = pending.shift();
    if (!next) return original();
    return 1 - (next.R - 0.5) / next.N;
  };
  return { restore() { CONFIG.Dice.randomUniform = original; } };
}

// Build the summary roll-up from the computed actionResult.
function summarize(ar) {
  const summary = {
    hasDamage: !!ar.hasDamage,
    hasHealing: !!ar.hasHealing,
    healed: [],
    damaged: [],
    missed: [],
    cast: ar.skillName,
    casterName: ar.attacker?.name,
    targets: (ar.targets ?? []).map((t) => t.name),
    roll: ar.roll ? {
      total: ar.roll.total, hr: ar.roll.hr,
      isCrit: ar.roll.isCrit, isFumble: ar.roll.isFumble,
    } : null,
  };
  for (const r of (ar.perTargetResults ?? [])) {
    if (!r.hit) {
      summary.missed.push({ name: r.name, defense: r.defense });
      continue;
    }
    if (typeof r.grantAmount === "number" && r.grantAmount > 0) {
      summary.healed.push({
        name: r.name,
        amount: r.grantAmount,
        resource: r.grantResource,
        before: r.resourceCur,
        max: r.resourceMax,
      });
    } else if (r.damage > 0) {
      summary.damaged.push({
        name: r.name,
        amount: r.damage,
        element: ar.damage?.element ?? null,
        affinity: r.affinity,
        resource: r.resource ?? "hp",
        crit: !!r.crit,
      });
    } else if (ar.hasDamage) {
      summary.damaged.push({
        name: r.name, amount: 0,
        affinity: r.affinity, reason: "no-effect",
      });
    }
  }
  return summary;
}

async function runDirectorSkillCompute({
  skillUuid, casterTokenUuid, targetTokenUuids, force = null,
  picks = null, harnessNumbers = null, override = null,
  // Batch callers pass a stable token to reuse the loaded module graph across a
  // run of calls (see loadDeps). Omitted = per-call cache-bust, as before.
  depsToken = null,
} = {}) {
  const _wg = _guardWrites("runDirectorSkillCompute");
  if (!game.user?.isGM) {
    return { ok: false, reason: "gm_only" };
  }
  if (!skillUuid || !casterTokenUuid || !Array.isArray(targetTokenUuids) || !targetTokenUuids.length) {
    return { ok: false, reason: "missing_args",
      hint: "skillUuid + casterTokenUuid + targetTokenUuids[] all required" };
  }

  const skill = await fromUuid(skillUuid).catch(() => null);
  if (!skill) return { ok: false, reason: "skill_not_found", skillUuid };
  const casterToken = await fromUuid(casterTokenUuid).catch(() => null);
  if (!casterToken?.actor) return { ok: false, reason: "caster_token_not_found", casterTokenUuid };
  const targetTokens = [];
  for (const u of targetTokenUuids) {
    const t = await fromUuid(u).catch(() => null);
    if (!t?.actor) return { ok: false, reason: "target_token_not_found", missing: u };
    targetTokens.push(t);
  }

  const deps = await loadDeps(depsToken);
  const { STATE_HANDLERS, STATES, INTENTS } = deps;
  const attackerSnap = buildAttackerSnapshot(casterToken, deps);
  const targetSnaps  = targetTokens.map((t) => buildTargetSnapshot(t, deps));
  if (!attackerSnap) return { ok: false, reason: "caster_snapshot_failed" };

  let ar = buildInitialActionResult(skill, attackerSnap, targetSnaps, deps);
  // Feed open_action_menu / prompt auto-picks to COMPUTE's pre_activate capture
  // pass too (line ~3314 reads ar._harnessPicks). Without this a skill with a
  // pre_activate_effect_ref menu (Nocebo / Elemental Weapon / Elemental Shroud)
  // would PROMPT for real at COMPUTE and hang the headless harness. RESOLVE gets
  // its own copy stamped in the simulate wrapper.
  // `buildInitialActionResult` returns a frozen (non-extensible) ar, so re-wrap
  // via freezeActionResult instead of mutating it in place.
  const harnessPatch = {};
  if (Array.isArray(picks)) harnessPatch._harnessPicks = [...picks];
  if (harnessNumbers && typeof harnessNumbers === "object") harnessPatch._harnessNumbers = { ...harnessNumbers };
  if (Object.keys(harnessPatch).length) {
    ar = deps.freezeActionResult
      ? deps.freezeActionResult({ ...ar, ...harnessPatch })
      : Object.assign({ ...ar }, harnessPatch);
  }

  // Synthetic director — COMPUTE reads ctx + dCombat, writes
  // ctx.actionResult, enqueues INTERNAL_DONE. We capture intents and
  // never dispatch — the goal is the resulting actionResult.
  const enqueued = [];
  const dispatched = [];
  const synthDirector = {
    ctx: {
      declaredCommand: ar.skillType?.toLowerCase() === "spell" ? "Spell" : "Skill",
      turnSnapshot: attackerSnap,
      pickedTargetUuids: targetSnaps.map((t) => t.tokenUuid),
      eligibleTargets: targetSnaps,
      actionResult: ar,
    },
    dCombat: { round: 1 },
    state: STATES.COMPUTE,
    enqueue(intent) { enqueued.push(intent); },
    dispatch(intent) { dispatched.push(intent); },
  };

  const computeHandler = STATE_HANDLERS[STATES.COMPUTE];
  if (!computeHandler?.onEnter) {
    return { ok: false, reason: "compute_handler_missing" };
  }

  const dA = attackerSnap.attributes?.[ar.rolledA1] ?? 8;
  const dB = attackerSnap.attributes?.[ar.rolledA2] ?? 8;
  // Semantic force shorthands — convert `force: { hit, miss, crit, fumble }`
  // into concrete `{ rA, rB }` based on attacker dice + target DEF/MDEF.
  // Raw `{ rA, rB }` (if both present) wins over semantic flags.
  const resolvedForce = expandForceSemantics(force, {
    dA, dB,
    fumbleThreshold: attackerSnap.fumbleThreshold ?? 1,
    checkBonus: ar.checkBonus ?? 0,
    isSpell: String(ar.skillType ?? "").toLowerCase() === "spell",
    targetSnaps,
  });
  const rollOverride = installRollOverride(resolvedForce, dA, dB);
  // Identifier overrides (SL / CHAR_LEVEL / BOND_COUNT / BOND_STRENGTH) — pin the
  // formula identifiers CSB would otherwise derive from live actor state, so a
  // compute-mode test is deterministic regardless of the caster's current level /
  // bonds. Previously ONLY the simulate wrappers installed these, so compute-mode
  // callers (the skill-regression harness) silently ran with real actor state and
  // their goldens drifted whenever a caster leveled. Mirrors runDirectorSkillSimulate.
  const formulaOverrides = installFormulaOverrides(override);
  // Same headless gating the simulate/passive entry points install. COMPUTE runs
  // the `pre_activate` capture pass, and a `prompt_number` there has no auto
  // answer without either an explicit `harnessNumbers` entry or this flag — so it
  // opened a real Dialog nobody could click and the call hung to timeout. Found
  // when Bimagus's spend prompt moved to pre_activate: 5 goldens flipped to
  // `ok:false / reason:"timeout"` in one run.
  // Narrow by construction: __FU_HARNESS_HEADLESS__ is read by noHumanToAsk
  // (prompt_number / prompt_element) and promptDefenderOptIn only. list-picker
  // gates on SimMode, NOT this flag, so `open_action_menu` skills still fall to
  // the collector's 12s guard and stay baselined as `skipped` — the 31 golden
  // fingerprints that note warns about are untouched.
  const headlessGates = installHeadlessGates();
  try {
    await computeHandler.onEnter(synthDirector, {
      triggerIntent: { type: INTENTS.TARGET_PICKED,
        body: { targetTokenUuids: synthDirector.ctx.pickedTargetUuids } },
    });
  } finally {
    rollOverride.restore();
    formulaOverrides.restore();
    headlessGates.restore();
  }

  const finalAr = synthDirector.ctx.actionResult;

  // Did COMPUTE actually build a card, or did it REFUSE?
  //
  // This used to be a hardcoded `ok: true`, which made the guard in
  // `runDirectorSkillSimulate` (`if (!compute.ok) return compute`) dead code:
  // simulate walked straight into RESOLVE on an action COMPUTE had bounced,
  // then reported the writes as if the action had been allowed. That is a false
  // green in the PERMISSIVE direction — the exact class this project's standing
  // rule warns about, and it lands precisely on the tests most worth trusting
  // (a refusal gate is asserted by proving the action does NOT happen).
  //
  // The signal is positive, not a refusal blacklist: `Compute` (state-handlers
  // .js:4063-4413) emits exactly three intents and no others —
  //   INTERNAL_DONE  (4079 / 4297 / 4397) — card built, advance to CONFIRM
  //   TARGET_BACK    (4163)               — pre_activate refused or cancelled
  //   ABORT          (4314 / 4409)        — hard failure
  // so "success" is INTERNAL_DONE being present, and everything else — a bounce,
  // an abort, or an empty queue because a throw was swallowed upstream — is a
  // refusal. Asserting the success token rather than enumerating refusals means
  // a NEW refusal path added to Compute later fails closed here by default,
  // instead of silently rejoining the permissive set.
  const intents = [...enqueued, ...dispatched].map((i) => String(i?.type ?? ""));
  const advanced = intents.includes(String(INTENTS.INTERNAL_DONE));
  if (!advanced) {
    const bounce = intents.find((t) => t && t !== String(INTENTS.INTERNAL_DONE)) ?? "";
    return {
      ok: false,
      // `refused` (not `error`) — this is the engine working correctly. A test
      // asserting a gate SHOULD land here; read `reason` to tell which.
      refused: true,
      reason: bounce
        ? `compute_refused:${bounce}`
        : "compute_refused:no_intent",
      // The card COMPUTE declined to finish. Callers asserting a refusal can
      // still inspect what got as far as being computed before the bounce.
      actionResult: finalAr,
      summary: summarize(finalAr),
      enqueued, dispatched,
    };
  }

  return {
    ok: true,
    actionResult: finalAr,
    summary: summarize(finalAr),
    enqueued, dispatched,
  };
}

// ─── Simulate harness — RESOLVE with write capture ──────────────────────
//
// Monkey-patches Foundry document prototypes for the duration of the
// RESOLVE call. Every actor.update / item.update / AE create / AE delete
// is recorded into a capture log instead of mutating the world.
//
// Returns mock objects from createEmbeddedDocuments so calling code that
// reads created.id (Guard / Cover / apply_ae) doesn't blow up.
//
// Limitations:
//   - Cascading reads see PRE-update state (interceptor doesn't commit).
//     A skill that writes target HP then reads it back would see the old
//     value. Most skills don't do this.
//   - Hooks (callAll) still fire — UI bindings observe captured writes.
//     The captures themselves are the source of truth for assertions.
//   - Chat messages are not suppressed; ui.notifications fires.
// ── Write-capture poisoning guard ────────────────────────────────────────
//
// installWriteCaptures() used to snapshot `originals` from the CURRENT
// prototypes on every call. That is only correct while the patch is NOT already
// installed: a re-entrant install (a nested harness call, or a
// withHarnessTimeout that abandons an inner chain still holding the patch)
// snapshots the STUBS as "originals", and the outer restore() then reinstalls
// them PERMANENTLY. From that moment every update() in the page returns `this`
// and commits nothing, while still reporting success — so the world silently
// stops accepting writes and every later measurement is void.
//
// Measured 2026-08-20: after a probeReactorTrigger batch, every actor/item/AE
// write in the session was swallowed. `doc.update()` resolved with no error and
// even `setFlag` was inert. Reads were unaffected, so it looked like the data
// was fine and the WRITES were wrong.
//
// Fix: snapshot the pristine natives ONCE, only while provably unpatched, and
// always restore from that. A depth counter means only the outermost restore
// un-patches. `harnessWriteCaptureState()` / `healHarnessWrites()` expose the
// invariant so a caller can assert it instead of trusting it.
let _pristineDocMethods = null;
let _captureDepth = 0;

function _docClasses() {
  return { ActorCls: CONFIG.Actor.documentClass, ItemCls: CONFIG.Item.documentClass, AECls: CONFIG.ActiveEffect.documentClass };
}
// A stub is recognisable: it closes over `captures.` and never calls through.
function _looksCaptured(fn) {
  try { return /captures\s*\./.test(Function.prototype.toString.call(fn)); } catch { return false; }
}
function harnessWriteCaptureState() {
  const { ActorCls, ItemCls, AECls } = _docClasses();
  return {
    depth: _captureDepth,
    havePristine: !!_pristineDocMethods,
    actorPatched: _looksCaptured(ActorCls.prototype.update),
    itemPatched:  _looksCaptured(ItemCls.prototype.update),
    aePatched:    _looksCaptured(AECls.prototype.update),
    get poisoned() { return this.depth === 0 && (this.actorPatched || this.itemPatched || this.aePatched); },
  };
}
// Force the page back to committing writes. Safe to call at any time; a no-op
// when nothing is patched. Returns what it did.
function healHarnessWrites() {
  const st = harnessWriteCaptureState();
  if (!st.actorPatched && !st.itemPatched && !st.aePatched) return { healed: false, reason: "not patched", state: st };
  if (!_pristineDocMethods) return { healed: false, reason: "no pristine snapshot — reload the client", state: st };
  _restorePristine();
  _captureDepth = 0;
  return { healed: true, state: harnessWriteCaptureState() };
}
// Every public entry point calls this FIRST. If a previous run leaked its
// capture patch, the page is silently swallowing writes and any measurement
// taken now is void — so repair it and say so, rather than returning confident
// wrong numbers.
function _guardWrites(label) {
  const st = harnessWriteCaptureState();
  if (!st.poisoned) return null;
  const r = healHarnessWrites();
  const msg = `harness: page was POISONED (a previous run leaked its write-capture patch; every write since was swallowed). ${r.healed ? "Healed" : "COULD NOT HEAL — reload the client"} before ${label}.`;
  warn(msg);
  ui?.notifications?.warn?.(msg);
  return { poisonedOnEntry: true, healed: !!r.healed };
}

function _snapshotPristine() {
  const { ActorCls, ItemCls, AECls } = _docClasses();
  if (_looksCaptured(ActorCls.prototype.update) || _looksCaptured(ItemCls.prototype.update) || _looksCaptured(AECls.prototype.update)) {
    // Refuse to snapshot a patched prototype — that is exactly the bug.
    warn("harness: refusing to snapshot pristine document methods while a capture patch is installed");
    return false;
  }
  _pristineDocMethods = {
    actorUpdate: ActorCls.prototype.update,
    actorCreateEmbedded: ActorCls.prototype.createEmbeddedDocuments,
    actorDeleteEmbedded: ActorCls.prototype.deleteEmbeddedDocuments,
    itemUpdate: ItemCls.prototype.update,
    itemCreateEmbedded: ItemCls.prototype.createEmbeddedDocuments,
    itemDeleteEmbedded: ItemCls.prototype.deleteEmbeddedDocuments,
    aeUpdate: AECls.prototype.update,
    aeDelete: AECls.prototype.delete,
  };
  return true;
}
function _restorePristine() {
  if (!_pristineDocMethods) return;
  const { ActorCls, ItemCls, AECls } = _docClasses();
  const o = _pristineDocMethods;
  ActorCls.prototype.update                  = o.actorUpdate;
  ActorCls.prototype.createEmbeddedDocuments = o.actorCreateEmbedded;
  ActorCls.prototype.deleteEmbeddedDocuments = o.actorDeleteEmbedded;
  ItemCls.prototype.update                   = o.itemUpdate;
  ItemCls.prototype.createEmbeddedDocuments  = o.itemCreateEmbedded;
  ItemCls.prototype.deleteEmbeddedDocuments  = o.itemDeleteEmbedded;
  AECls.prototype.update                     = o.aeUpdate;
  AECls.prototype.delete                     = o.aeDelete;
}

async function installWriteCaptures() {
  const captures = {
    actorUpdates: [],   // { actorUuid, actorName, patch }
    itemUpdates: [],    // { itemUuid, itemName, patch, parentUuid }
    aeUpdates: [],      // { aeId, aeName, parentUuid, patch }
    aeCreates: [],      // { parentUuid, parentName, name, statusIds, changes, flags }
    aeDeletes: [],      // { aeId, aeName, parentUuid }
    freeActions: [],    // { sourceLabel, reactorActorId, actionType, presetName, request }
  };

  // ── free-action grants ───────────────────────────────────────────────────
  // A `free_action` effect row touches no document — it calls
  // freeActionQueue.enqueue(), so it was invisible to every capture below and
  // ANY skill granting a free action was unprovable under simulate.
  //
  // 🚨 THIS MUST STAY ABOVE THE PROTOTYPE PATCHES. The `await` yields, and once
  // Actor/Item/ActiveEffect.prototype are swapped, ANY page write that lands in
  // that window (sheet render, CSB label persist, a hook continuation) is
  // captured instead of committed — it reports success and changes nothing.
  // Awaiting first keeps the patched window inside one synchronous frame + the
  // run itself, which is the invariant the rest of this file relies on.
  //
  // 🪤 Canonical specifier (NO ?cb=) — a cache-busted copy is a DIFFERENT module
  // instance with its own queue, so skill-effects.js (which does its own bare
  // `import("./free-action-queue.js")`) would reach the original and this would
  // silently record nothing.
  // ⚠ Awaited, not .then() — a deferred patch could land after the chain ran,
  // leaving `freeActions` empty and reading as "no free action granted". That is
  // a fail-PERMISSIVE gap, the worst kind.
  let restoreFreeActions = () => {};
  try {
    const mod = await import("./free-action-queue.js");
    const q = mod?.freeActionQueue;
    if (!q || typeof q.enqueue !== "function") {
      warn("harness: freeActionQueue unavailable — free-action grants will NOT be captured");
    } else {
      const originalEnqueue = q.enqueue.bind(q);
      q.enqueue = function captureEnqueue(request) {
        captures.freeActions.push({
          sourceLabel:    request?.sourceLabel ?? null,
          reactorActorId: request?.reactorActorId ?? null,
          actionType:     request?.actionType ?? request?.kind ?? null,
          presetName:     request?.preset?.name ?? request?.presetName ?? null,
          request,
        });
        // ⚠ SWALLOWED — simulate must not leave a real pending free action on the
        // actor. Note this makes simulate diverge from play for anything that
        // depends on the queue being non-empty downstream (FREE_ACTION_WINDOW).
        return undefined;
      };
      restoreFreeActions = () => { q.enqueue = originalEnqueue; };
    }
  } catch (e) {
    warn("harness: could not patch freeActionQueue", e);
  }

  // Snapshot originals from the actual runtime classes — the global
  // `Actor` / `Item` / `ActiveEffect` constructors. Foundry's documents
  // class hierarchy: ClientDocument extends BaseDocument; the runtime
  // class is what user code interacts with via `actor.update(...)`.
  const ActorCls = CONFIG.Actor.documentClass;
  const ItemCls  = CONFIG.Item.documentClass;
  const AECls    = CONFIG.ActiveEffect.documentClass;

  // Pristine natives are snapshotted ONCE, and only while provably unpatched —
  // see the poisoning guard above. Never snapshot from the live prototypes here:
  // a re-entrant install would record the stubs and restore() would make them
  // permanent.
  if (_captureDepth === 0 && !_pristineDocMethods) _snapshotPristine();
  if (_captureDepth > 0) {
    // Nested install. The outer stub stays installed, so THIS sink records
    // nothing. Non-destructive (restore is depth-counted) but the inner run's
    // captures would read as "wrote nothing" — a fail-permissive answer — so say
    // so loudly rather than returning a silently empty capture set.
    warn(`harness: NESTED installWriteCaptures (depth ${_captureDepth}) — this sink will record nothing; the enclosing capture owns the patch`);
  }
  _captureDepth += 1;

  // Build a fake AE doc with .id, .name, .delete, .update. Used as the
  // return value of createEmbeddedDocuments("ActiveEffect", ...).
  function makeFakeAE({ parentUuid, parentName, data }) {
    const fakeId = `harness-ae-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    return {
      id: fakeId,
      _id: fakeId,
      name: data?.name ?? "",
      parent: { uuid: parentUuid, name: parentName },
      changes: data?.changes ?? [],
      flags: data?.flags ?? {},
      statuses: data?.statuses ?? [],
      async delete() {
        captures.aeDeletes.push({ aeId: fakeId, aeName: data?.name ?? "", parentUuid });
        return this;
      },
      async update(patch) {
        captures.aeUpdates.push({ aeId: fakeId, aeName: data?.name ?? "", parentUuid, patch });
        return this;
      },
    };
  }
  function makeFakeItem({ parentUuid, parentName, data }) {
    const fakeId = `harness-item-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    return {
      id: fakeId, _id: fakeId, name: data?.name ?? "", parent: { uuid: parentUuid, name: parentName },
      system: data?.system ?? { props: {} },
      async delete() { return this; },
      async update(patch) { captures.itemUpdates.push({ itemUuid: `${parentUuid}.Item.${fakeId}`, itemName: data?.name ?? "", patch, parentUuid }); return this; },
    };
  }

  ActorCls.prototype.update = async function (patch) {
    captures.actorUpdates.push({
      actorUuid: this.uuid, actorName: this.name,
      patch: typeof patch === "object" ? { ...patch } : patch,
    });
    return this;
  };
  ActorCls.prototype.createEmbeddedDocuments = async function (type, dataList = []) {
    const parentUuid = this.uuid;
    const parentName = this.name;
    if (type === "ActiveEffect") {
      const fakes = dataList.map((data) => {
        captures.aeCreates.push({
          parentUuid, parentName,
          name: data?.name ?? "",
          statusIds: data?.statuses ?? [],
          changes: data?.changes ?? [],
          flags: data?.flags ?? {},
          duration: data?.duration ?? null,
        });
        return makeFakeAE({ parentUuid, parentName, data });
      });
      return fakes;
    }
    if (type === "Item") {
      return dataList.map((data) => makeFakeItem({ parentUuid, parentName, data }));
    }
    return [];
  };
  ActorCls.prototype.deleteEmbeddedDocuments = async function (type, idList = []) {
    if (type === "ActiveEffect") {
      for (const id of idList) {
        const existing = this.effects?.get?.(id);
        captures.aeDeletes.push({
          aeId: id, aeName: existing?.name ?? "(unknown)",
          parentUuid: this.uuid,
        });
      }
    }
    return idList.map((id) => ({ id, _id: id }));
  };
  ItemCls.prototype.update = async function (patch) {
    captures.itemUpdates.push({
      itemUuid: this.uuid, itemName: this.name,
      patch: typeof patch === "object" ? { ...patch } : patch,
      parentUuid: this.parent?.uuid ?? null,
    });
    return this;
  };
  ItemCls.prototype.createEmbeddedDocuments = async function (type, dataList = []) {
    if (type === "ActiveEffect") {
      const parentUuid = this.uuid;
      const parentName = this.name;
      return dataList.map((data) => {
        captures.aeCreates.push({
          parentUuid, parentName,
          name: data?.name ?? "",
          statusIds: data?.statuses ?? [],
          changes: data?.changes ?? [],
          flags: data?.flags ?? {},
          duration: data?.duration ?? null,
        });
        return makeFakeAE({ parentUuid, parentName, data });
      });
    }
    return [];
  };
  ItemCls.prototype.deleteEmbeddedDocuments = async function (type, idList = []) {
    return idList.map((id) => ({ id, _id: id }));
  };
  AECls.prototype.update = async function (patch) {
    captures.aeUpdates.push({
      aeId: this.id, aeName: this.name,
      parentUuid: this.parent?.uuid ?? null,
      patch: typeof patch === "object" ? { ...patch } : patch,
    });
    return this;
  };
  AECls.prototype.delete = async function () {
    captures.aeDeletes.push({
      aeId: this.id, aeName: this.name,
      parentUuid: this.parent?.uuid ?? null,
    });
    return this;
  };

  let _restored = false;
  function restore() {
    // Idempotent: a double restore() (e.g. an explicit call plus the `finally`)
    // must not drive the depth negative and un-patch an enclosing capture.
    if (_restored) return;
    _restored = true;
    restoreFreeActions();
    _captureDepth = Math.max(0, _captureDepth - 1);
    // Only the OUTERMOST restore un-patches, and it always restores the pristine
    // natives rather than whatever happened to be on the prototype at install.
    if (_captureDepth === 0) _restorePristine();
  }

  return { captures, restore };
}

// Roll up captures into a per-actor write summary.
function summarizeWrites(captures) {
  const byActor = new Map();
  function ensure(uuid, name) {
    if (!byActor.has(uuid)) byActor.set(uuid, { actorUuid: uuid, actorName: name, propPatches: {}, aeApplied: [], aeRemoved: [] });
    return byActor.get(uuid);
  }
  for (const w of captures.actorUpdates) {
    const slot = ensure(w.actorUuid, w.actorName);
    for (const [k, v] of Object.entries(w.patch ?? {})) {
      slot.propPatches[k] = v;
    }
  }
  for (const c of captures.aeCreates) {
    ensure(c.parentUuid, c.parentName).aeApplied.push({
      name: c.name, statusIds: c.statusIds,
      changes: c.changes?.map((ch) => `${ch.key} ${ch.mode}= ${ch.value}`) ?? [],
    });
  }
  for (const d of captures.aeDeletes) {
    ensure(d.parentUuid, "?").aeRemoved.push({ name: d.aeName });
  }
  return [...byActor.values()];
}

// ─── Render-capture (Phase 2.4) ─────────────────────────────────────────
//
// Builds the action card the SAME way production's CONFIRM stage does
// (state-handlers.js postActionCard payload, action-card.js composer) and
// flattens it to an assertable record. The point: catch bugs that live in
// the RENDER layer — wrong headline, a per-target row that says "— No
// damage"/"Blocked"/"Negated" when it shouldn't, a missing affinity pill,
// a reaction pill that shouldn't be offered — which the data-write captures
// are completely blind to.
//
// v1 scope: the post-roll action card body/headline/buttons + the
// card-reaction pill rows. NOT captured: the card-reaction header BONUS preview
// (needs CONFIRM's payload builder extracted) and the player-client mirror
// HTML. A green run does not claim those are covered.
//
// `ar` is the COMPUTE-stage frozen actionResult. `deps` carries the
// composer + text-stripper pulled from action-card.js in loadDeps().
function captureActionCard(ar, deps) {
  const { composeActionCardObject, composeActionCardRenderPayload, stripHtmlForDesc } = deps;
  if (typeof composeActionCardObject !== "function") return null;
  // Build the payload from the SHARED builder production CONFIRM uses, so the
  // captured card can't drift from what the player sees. The harness needs no
  // overrides (no target-splicing, no invoke buttons) — the defaults are the
  // faithful render. (Drift here once mislabeled a spell card's MDEF as "DEF".)
  const payload = typeof composeActionCardRenderPayload === "function"
    ? composeActionCardRenderPayload(ar)
    : { ...ar };  // fallback: pre-extraction harness against newer disk
  const cardReactions = Array.isArray(payload.cardReactions) ? payload.cardReactions : [];
  let card = null;
  try {
    card = composeActionCardObject({ kind: ar.kind, payload });
  } catch (e) {
    return { kind: ar.kind, error: String(e?.message ?? e), html: "", text: "" };
  }
  if (!card) return null;
  const html = [card.titleText ?? "", card.subtitle ?? "", card.portraits ?? "", card.body ?? "", card.buttons ?? ""]
    .filter(Boolean).join("\n");
  const strip = typeof stripHtmlForDesc === "function"
    ? stripHtmlForDesc
    : (h) => String(h ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return {
    kind: ar.kind,
    title: card.titleText ?? "",
    targets: (ar.targets ?? []).map((t) => t?.name).filter(Boolean),
    html,
    // Stable form for golden-snapshot diffing — volatile ids/timestamps removed,
    // whitespace collapsed (see normalizeCardHtml). This is the field you store
    // as the golden and compare on later runs.
    htmlNormalized: normalizeCardHtml(html),
    // Plain text, tags stripped — the field tests grep. stripHtmlForDesc caps
    // at 320 chars, so strip the title/body separately and join for full text.
    text: [card.titleText, card.subtitle, card.body, card.buttons].map((h) => strip(h)).filter(Boolean).join(" | "),
    pills: cardReactions.map((p) => ({ name: p.carrierName ?? p.name ?? "?", mode: p.mode ?? null, available: p.available !== false })),
  };
}

// Normalize captured card HTML into a stable string for golden-snapshot
// regression. Strips the only volatile bits a render produces — the harness's
// `harness-ae-<ts>-<rand>` / `harness-item-…` fake ids and epoch-ms timestamps —
// and collapses the template-literal whitespace so cosmetic reformatting of a
// builder doesn't churn the golden. Deterministic: same card in → same string.
function normalizeCardHtml(html) {
  return String(html ?? "")
    .replace(/harness-(?:ae|item)-\d+-\d+/g, "harness-ID")  // volatile fake ids
    .replace(/\b\d{13,}\b/g, "TS")                          // Date.now() epoch-ms
    .replace(/\s+/g, " ")                                   // collapse whitespace
    .trim();
}

// Diff a captured normalized-HTML array against a stored golden array (both from
// `result.cardHtmlNormalized`). Returns { match, diffs } — `match` true only when
// every card matches AND the counts are equal. Serializable result, so it works
// both in-process and over the bridge. Usage: capture once, save
// `result.cardHtmlNormalized` as the golden, then on later runs
// `diffCardGolden(result.cardHtmlNormalized, golden)`.
function diffCardGolden(actual, golden) {
  const a = Array.isArray(actual) ? actual : [];
  const g = Array.isArray(golden) ? golden : [];
  const diffs = [];
  const n = Math.max(a.length, g.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== g[i]) diffs.push({ index: i, expected: g[i] ?? null, actual: a[i] ?? null });
  }
  return { match: diffs.length === 0 && a.length === g.length, diffs };
}

// Attach the result-side card helpers. `cardText` is a flat string (survives
// JSON serialization over the test-bridge). `expectCard` is a convenience for
// IN-PROCESS callers (FUCompanion.api.test.*) — it is NOT serializable, so it
// won't appear in a bridge res-*.json; over the bridge, grep `cardText` /
// `cards[].text` instead.
function attachCardHelpers(result, cards) {
  result.cards = cards;
  result.cardText = cards.map((c) => c?.text ?? "").filter(Boolean).join("\n");
  // Serializable golden payload — store this array as the golden, then compare a
  // later run with diffCardGolden / result.matchGolden.
  result.cardHtmlNormalized = cards.map((c) => c?.htmlNormalized ?? "");
  result.expectCard = (matcher) => cards.find((c) => {
    const t = c?.text ?? "";
    return matcher instanceof RegExp ? matcher.test(t) : t.includes(String(matcher));
  }) ?? null;
  // In-process convenience (not serializable): diff this run's cards vs a golden.
  result.matchGolden = (golden) => diffCardGolden(result.cardHtmlNormalized, golden);
  return result;
}

// Install identifier overrides via the global formula registry —
// `globalThis.__FU_HARNESS_FORMULA_OVERRIDES__`. `buildSkillResolver`
// consults this map BEFORE its normal cases (see skill-formulas.js).
// No actor mutation: previous implementation wrote class_list / bond_N
// directly, which CSB's prepareData re-derives on every read, clobbering
// the values mid-cast. Registry approach side-steps the whole problem.
//
// Shape: { SL, BOND_COUNT, BOND_STRENGTH, CHAR_LEVEL } — all optional
// integers. Unknown keys ignored.
function installFormulaOverrides(override) {
  if (!override || typeof override !== "object") return { restore() {} };
  const KEYS = ["SL", "CHAR_LEVEL", "BOND_COUNT", "BOND_STRENGTH"];
  const map = {};
  for (const k of KEYS) {
    const v = Number(override[k]);
    if (Number.isFinite(v)) map[k] = v;
  }
  if (!Object.keys(map).length) return { restore() {} };
  const prev = globalThis.__FU_HARNESS_FORMULA_OVERRIDES__;
  globalThis.__FU_HARNESS_FORMULA_OVERRIDES__ = { ...(prev ?? {}), ...map };
  return {
    restore() {
      if (prev) globalThis.__FU_HARNESS_FORMULA_OVERRIDES__ = prev;
      else delete globalThis.__FU_HARNESS_FORMULA_OVERRIDES__;
    },
  };
}

// ─── Passive auto-accept (Phase 2.1) ────────────────────────────────────
//
// Sets `globalThis.__FU_HARNESS_ACCEPT_PASSIVES__` so `firePassiveTriggers`
// can short-circuit the `ask`-mode Dialog (see skill-effects.js). We do
// NOT monkey-patch `Dialog`: V8 inlines the bare-identifier reference
// across cache-busted module instances, so the patch races itself and
// sometimes opens a real UI Dialog (which then hangs the harness).
// Reading a global at the actual prompt call-site is order-of-magnitude
// more reliable.
//
// `acceptPassives` shape:
//   - true                                → accept every ask-mode passive
//   - false                               → decline every ask-mode passive
//   - { "Healing Power": true, ... }      → per-skill map (substring match
//                                            on item.name; unmatched
//                                            passives fall through to the
//                                            real Dialog — should never
//                                            happen in a clean test)
//   - null / undefined                    → no override (real Dialog opens,
//                                            harness will hang on it)
function installPassiveAutoAcceptor(acceptPassives) {
  if (acceptPassives === null || acceptPassives === undefined) {
    return { restore() {} };
  }
  const prev = globalThis.__FU_HARNESS_ACCEPT_PASSIVES__;
  globalThis.__FU_HARNESS_ACCEPT_PASSIVES__ = acceptPassives;
  return {
    restore() {
      if (prev === undefined) delete globalThis.__FU_HARNESS_ACCEPT_PASSIVES__;
      else globalThis.__FU_HARNESS_ACCEPT_PASSIVES__ = prev;
    },
  };
}

// Declare that NOBODY IS AT THE KEYBOARD for the duration of a harness run.
//
// `skill-effects.noHumanToAsk()` reads this global and answers blocking gates
// with their non-answer default instead of rendering a modal: a `confirm` row
// auto-confirms, a defender opt-in declines, `prompt_number` takes its default.
//
// Why this had to exist: a chain containing an interactive row rendered a real
// dialog into a headless client and awaited a click that could never come. The
// run then never reached its `finally`, so the write-capture prototype patches
// installed by `installWriteCaptures()` stayed installed — and from that moment
// every `item.update()` / `deleteEmbeddedDocuments()` in the page was captured
// instead of committed, reporting success while changing nothing. A single
// unanswerable dialog silently poisoned the entire client.
//
// Deliberately does NOT cover `open_action_menu`: those skills already resolve
// via the collector's 12s guard and are baselined as `skipped` in skip.json.
// Auto-answering them would change 31 golden fingerprints — a separate, opt-in
// decision, not a side effect of fixing a hang.
function installHeadlessGates() {
  const prev = globalThis.__FU_HARNESS_HEADLESS__;
  globalThis.__FU_HARNESS_HEADLESS__ = true;
  return {
    restore() {
      if (prev === undefined) delete globalThis.__FU_HARNESS_HEADLESS__;
      else globalThis.__FU_HARNESS_HEADLESS__ = prev;
    },
  };
}

// Last-resort watchdog: never let a harness run hang forever.
//
// `installHeadlessGates` removes the KNOWN blocking gates, but any future
// unanswerable await would reintroduce the poisoned-client failure above. This
// races the run against a deadline so the `finally` ALWAYS executes and the
// prototype patches always come back off. A timed-out run returns a normal
// error result; it does not leave the page in a state where writes vanish.
const HARNESS_RUN_TIMEOUT_MS = 60000;
function withHarnessTimeout(promise, label, ms = HARNESS_RUN_TIMEOUT_MS) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ __harnessTimeout: true, label, ms }), ms);
  });
  return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}

// Install pre-applied AEs on the target actors. These DO mutate the
// world briefly — necessary because Foundry doesn't expose a clean
// shadow-effects layer and the resolveDamageReactions / firePassive
// paths walk `actor.effects` directly. Cleaned up in finally.
//
// Shape: [{ targetActorUuid: "Actor.X", data: {name, changes, flags, ...} }]
async function installPreAppliedAEs(preApply) {
  const created = [];
  if (!Array.isArray(preApply) || !preApply.length) return { created, cleanup: async () => {} };
  for (const entry of preApply) {
    try {
      const actor = await fromUuid(entry.targetActorUuid).catch(() => null);
      if (!actor) continue;
      const [ae] = await actor.createEmbeddedDocuments("ActiveEffect", [entry.data]);
      if (ae?.id) created.push({ actorUuid: actor.uuid, aeId: ae.id, aeName: ae.name });
    } catch (e) {
      console.warn(`${TAG} preApply failed:`, e);
    }
  }
  const cleanup = async () => {
    for (const c of created) {
      try {
        const actor = await fromUuid(c.actorUuid).catch(() => null);
        const ae = actor?.effects?.get?.(c.aeId);
        if (ae) await ae.delete();
      } catch {}
    }
  };
  return { created, cleanup };
}

// Seed live resource props on actors before a run, and revert them in finally.
// Unlike `override` (which installs a non-mutating formula-resolver map for
// SL / level / bonds), this mutates ACTUAL sheet props — needed for state that
// a live-read identifier pulls off the actor at fire-time and that no override
// map covers. The canonical case is a `round_end` skill whose detonate reads a
// resource the round is meant to chip (Shadow Wall reads CUR_SHIELD =
// `system.props.shield_value`): seed the shield to the "already chipped" value
// and the whole detonate math becomes a focused, round-free unit test.
//
// The prior value of each seeded key is recorded and restored on cleanup, so a
// seed of a resource the actor already has (e.g. current_hp) leaves the sheet
// exactly as it was. Keys that didn't exist before are removed via `-=`.
//
// Shape: [{ actorUuid: "Actor.X", props: { shield_value: 8, current_hp: 40 } }]
async function installSeededProps(seed) {
  const applied = [];
  if (!Array.isArray(seed) || !seed.length) return { applied, cleanup: async () => {} };
  for (const entry of seed) {
    const props = entry?.props;
    if (!props || typeof props !== "object") continue;
    try {
      const actor = await fromUuid(entry.actorUuid).catch(() => null);
      if (!actor) continue;
      const patch = {};
      const prev = {};
      for (const [key, val] of Object.entries(props)) {
        const path = `system.props.${key}`;
        const had = foundry.utils.hasProperty(actor, path);
        prev[key] = had ? foundry.utils.getProperty(actor, path) : undefined;
        patch[path] = val;
      }
      await actor.update(patch);
      applied.push({ actorUuid: actor.uuid, actorName: actor.name, prev });
    } catch (e) {
      console.warn(`${TAG} seed failed:`, e);
    }
  }
  const cleanup = async () => {
    for (const s of applied) {
      try {
        const actor = await fromUuid(s.actorUuid).catch(() => null);
        if (!actor) continue;
        const patch = {};
        for (const [key, prevVal] of Object.entries(s.prev)) {
          if (prevVal === undefined) patch[`system.props.-=${key}`] = null;
          else patch[`system.props.${key}`] = prevVal;
        }
        if (Object.keys(patch).length) await actor.update(patch);
      } catch {}
    }
  };
  return { applied, cleanup };
}

async function runDirectorSkillSimulate(args = {}) {
  const _wg = _guardWrites("runDirectorSkillSimulate");
  if (!game.user?.isGM) return { ok: false, reason: "gm_only" };

  // Step 0a — install identifier overrides (SL / BOND_COUNT /
  // BOND_STRENGTH / CHAR_LEVEL) via the global formula registry.
  // Non-mutating; restored in `finally`.
  const formulaOverrides = installFormulaOverrides(args.override);

  // Step 0b — install pre-applied AEs (Mercy on caster for clamp tests, etc.).
  // These actually land on the actor — caveat: if our simulate throws BEFORE
  // the finally, they leak. The finally below covers normal paths.
  const preApplied = await installPreAppliedAEs(args.preApply);

  // Step 0c — seed live resource props (e.g. shield_value / current_hp) so a
  // formula that live-reads the sheet resolves deterministically. Mutating;
  // reverted in every cleanup path below alongside preApply.
  const seeded = await installSeededProps(args.seed);

  // Step 1 — COMPUTE (this also validates inputs + produces actionResult).
  const compute = await runDirectorSkillCompute(args);
  if (!compute.ok) {
    await seeded.cleanup();
    await preApplied.cleanup();
    formulaOverrides.restore();
    return compute;
  }

  // Stamp harness-only fields onto the ar for RESOLVE / makeChainContext
  // to consume. `_harnessPicks` feeds the open_action_menu auto-pick
  // queue; `vismagusHpPaid` triggers RESOLVE's self-heal suppression
  // (state-handlers.js line ~325) without needing to drive TARGET's
  // alt-cost Dialog. Have to re-freeze — freezeActionResult emits a
  // sealed object.
  // Same token as the COMPUTE above (args flows straight through), so a batched
  // simulate reuses one module graph for both halves of the call.
  const deps = await loadDeps(args.depsToken ?? null);
  const { STATE_HANDLERS, STATES, INTENTS, freezeActionResult } = deps;
  const arPatch = {};
  if (Array.isArray(args.picks)) arPatch._harnessPicks = [...args.picks];
  if (args.harnessNumbers && typeof args.harnessNumbers === "object") arPatch._harnessNumbers = { ...args.harnessNumbers };
  if (args.vismagusHpPaid === true) arPatch.vismagusHpPaid = true;
  let ar = Object.keys(arPatch).length
    ? freezeActionResult({ ...compute.actionResult, ...arPatch })
    : compute.actionResult;

  // Pre-pass aggregator — same as the attack simulator. Lets damage-bearing
  // Skills validate Cheap Shot-style reactions (`creature_will_deal_damage`
  // + `add_damage`) without driving the live action-card click flow.
  if (args.acceptReactions) {
    try {
      const round0 = Number.isFinite(args.round) ? args.round : 1;
      const attackerActor = await fromUuid(args.casterTokenUuid).then((d) => d?.actor ?? null).catch(() => null);
      if (attackerActor) {
        ar = await applyAcceptedReactionsToActionResult({
          ar, attackerActor, accept: args.acceptReactions, picks: Array.isArray(args.picks) ? args.picks : null,
          dCombat: { round: round0, currentTurnResolved: false },
          deps,
        });
      }
    } catch (e) { console.warn(`${TAG} skill acceptReactions threw`, e); }
  }

  // Render-capture — build the action card the way CONFIRM does (post-roll,
  // pre-RESOLVE) so callers can assert on what the player sees. Non-fatal.
  const renderedCards = [];
  try {
    const card = captureActionCard(ar, deps);
    if (card) renderedCards.push(card);
  } catch (e) { console.warn(`${TAG} card capture threw`, e); }

  // Step 2 — set up a synthetic director that resolveSkillAction can
  // walk. RESOLVE's Skill path reads director.ctx.actionResult and
  // director.dCombat.round + .currentTurnResolved.
  const round = Number.isFinite(args.round) ? args.round : 1;
  const synthDirector = {
    ctx: { actionResult: ar, _resumedFromPendingAction: true /* skip persistence save */ },
    dCombat: { round, currentTurnResolved: false },
    state: STATES.RESOLVE,
    enqueue() {},
    dispatch() {},
  };

  // Step 3 — install passive auto-acceptor + write captures, then run
  // RESOLVE. Default is `false` (decline all ask-mode passives) so the
  // harness never hangs on an unsolicited Dialog. Callers who want a
  // passive to fire pass `acceptPassives: true` (or a per-skill map).
  // Note this only affects `ask` mode; `on`-mode passives fire
  // unconditionally and `off`-mode never fire.
  const acceptPassives = args.acceptPassives ?? false;
  const passiveAcceptor = installPassiveAutoAcceptor(acceptPassives);
  const headlessGates = installHeadlessGates();
  const { captures, restore } = await installWriteCaptures();
  let resolveError = null;
  try {
    const resolveHandler = STATE_HANDLERS[STATES.RESOLVE];
    if (!resolveHandler?.onEnter) {
      restore();
      passiveAcceptor.restore();
      headlessGates.restore();
      await seeded.cleanup();
      await preApplied.cleanup();
      formulaOverrides.restore();
      return { ok: false, reason: "resolve_handler_missing" };
    }
    const outcome = await withHarnessTimeout(
      resolveHandler.onEnter(synthDirector, { triggerIntent: { type: INTENTS.CONFIRM_ACTION } }),
      "skill RESOLVE",
    );
    if (outcome?.__harnessTimeout) {
      resolveError = { message: `RESOLVE did not settle within ${outcome.ms}ms — treated as a harness timeout so the prototype patches are restored`, timeout: true };
    }
  } catch (e) {
    resolveError = { message: String(e?.message ?? e), stack: String(e?.stack ?? "").slice(0, 500) };
  } finally {
    restore();
    passiveAcceptor.restore();
    headlessGates.restore();
    await seeded.cleanup();
    await preApplied.cleanup();
    formulaOverrides.restore();
  }

  return attachCardHelpers({
    ok: !resolveError,
    actionResult: ar,
    summary: compute.summary,
    captures,
    perActorWrites: summarizeWrites(captures),
    preApplied: preApplied.created,
    resolveError,
  }, renderedCards);
}

// ─── Attack pipeline simulate (Phase 2.3) ───────────────────────────────
//
// Runs the Attack COMPUTE + RESOLVE branches in state-handlers.js against
// a synthetic director context, capturing damage writes via the same
// monkey-patched document prototypes used by `runDirectorSkillSimulate`.
//
// Bypasses TARGET — caller supplies attacker token + target tokens + mode.
// For two-weapon attacks (mode: "two-weapon"), the harness loops COMPUTE +
// RESOLVE twice — once for the main hand, once for the off hand — matching
// the FSM's CLEANUP→COMPUTE cycle. Each pass produces its own actionResult
// and its writes accumulate in the same captures bag.
//
// Args:
//   attackerTokenUuid: required string
//   targetTokenUuids:  required string[]
//   mode:              "main" | "off" | "two-weapon" (default "main")
//   force:             same shape as Skill harness; first target's DEF
//                      is the gate for `force.hit`/`force.miss`
//   preApply:          AEs to install on target/attacker before run
//                      (e.g. Guard AE, status conditions for forced-VU)
//   override:          formula identifiers (mostly irrelevant for attacks;
//                      kept for parity)
//   acceptPassives:    default false; reactive passives that fire on
//                      `creature_deals_damage` etc. (currently no such
//                      Spiritist trigger uses it via Attack — wired anyway
//                      so future class deliveries don't need re-plumbing)
//   round:             dCombat.round override; default 1
async function runDirectorAttackCompute({
  attackerTokenUuid, targetTokenUuids, mode = "main", force = null,
  pendingPasses = null, passIndex = 0, totalPasses = null,
  depsToken = null,   // batch reuse — see loadDeps
} = {}) {
  if (!game.user?.isGM) return { ok: false, reason: "gm_only" };
  if (!attackerTokenUuid || !Array.isArray(targetTokenUuids) || !targetTokenUuids.length) {
    return { ok: false, reason: "missing_args",
      hint: "attackerTokenUuid + targetTokenUuids[] required" };
  }
  const attackerToken = await fromUuid(attackerTokenUuid).catch(() => null);
  if (!attackerToken?.actor) return { ok: false, reason: "attacker_token_not_found", attackerTokenUuid };
  const targetTokens = [];
  for (const u of targetTokenUuids) {
    const t = await fromUuid(u).catch(() => null);
    if (!t?.actor) return { ok: false, reason: "target_token_not_found", missing: u };
    targetTokens.push(t);
  }

  const deps = await loadDeps(depsToken);
  const { STATE_HANDLERS, STATES, INTENTS, resolveAttackerWeapon } = deps;
  const attackerSnap = buildAttackerSnapshot(attackerToken, deps);
  const targetSnaps  = targetTokens.map((t) => buildTargetSnapshot(t, deps));
  if (!attackerSnap) return { ok: false, reason: "attacker_snapshot_failed" };

  // Resolve the weapon queue. Single-pass: [main] or [off]. Two-weapon:
  // [main, off]. The caller can also pass a pre-built pendingPasses for
  // pass 2 of two-weapon (the simulate wrapper does this).
  let queue;
  if (Array.isArray(pendingPasses) && pendingPasses.length) {
    queue = [...pendingPasses];
  } else if (mode === "two-weapon" || mode === "two-weapon-main-first") {
    const off = attackerSnap.offWeapon;
    if (!attackerSnap.weapon || !off) {
      return { ok: false, reason: "two_weapon_needs_both_hands",
        hint: "Need a weapon in each hand for two-weapon mode" };
    }
    queue = [attackerSnap.weapon, off];
  } else if (mode === "off") {
    if (!attackerSnap.offWeapon) return { ok: false, reason: "no_off_weapon" };
    queue = [attackerSnap.offWeapon];
  } else {
    if (!attackerSnap.weapon) return { ok: false, reason: "no_main_weapon" };
    queue = [attackerSnap.weapon];
  }

  const synthDirector = {
    ctx: {
      declaredCommand: "Attack",
      turnSnapshot: attackerSnap,
      pickedTargetUuids: targetSnaps.map((t) => t.tokenUuid),
      eligibleTargets: targetSnaps,
      pendingPasses: [...queue],
      attackMode: mode,
      passIndex,
      totalPasses: Number.isFinite(totalPasses) ? totalPasses : queue.length,
    },
    dCombat: { round: 1 },
    state: STATES.COMPUTE,
    enqueue() {},
    dispatch() {},
  };

  const weapon = queue[0];
  const dA = attackerSnap.attributes?.[weapon.A1] ?? 8;
  const dB = attackerSnap.attributes?.[weapon.A2] ?? 8;
  // Attack force semantics: gate is target.defense (DEF, not MDEF).
  const resolvedForce = expandForceSemantics(force, {
    dA, dB,
    fumbleThreshold: attackerSnap.fumbleThreshold ?? 1,
    checkBonus: weapon.checkBonus ?? 0,
    isSpell: false,
    targetSnaps,
  });
  const rollOverride = installRollOverride(resolvedForce, dA, dB);
  try {
    await STATE_HANDLERS[STATES.COMPUTE].onEnter(synthDirector, {
      triggerIntent: { type: INTENTS.TARGET_PICKED,
        body: { targetTokenUuids: synthDirector.ctx.pickedTargetUuids } },
    });
  } finally {
    rollOverride.restore();
  }

  const finalAr = synthDirector.ctx.actionResult;
  return {
    ok: true,
    actionResult: finalAr,
    summary: summarize(finalAr),
    // Surface the remaining queue so the simulate wrapper can iterate
    // for two-weapon passes. After COMPUTE shifts, queue.length-1 remain.
    pendingPasses: synthDirector.ctx.pendingPasses,
    nextPassIndex: synthDirector.ctx.passIndex,
    totalPasses: synthDirector.ctx.totalPasses,
  };
}

async function runDirectorAttackSimulate(args = {}) {
  const _wg = _guardWrites("runDirectorAttackSimulate");
  if (!game.user?.isGM) return { ok: false, reason: "gm_only" };

  const formulaOverrides = installFormulaOverrides(args.override);
  const preApplied = await installPreAppliedAEs(args.preApply);

  const deps = await loadDeps(args.depsToken ?? null);
  const { STATE_HANDLERS, STATES, INTENTS, freezeActionResult } = deps;
  const round = Number.isFinite(args.round) ? args.round : 1;

  // Captures accumulate ACROSS passes for two-weapon. The acceptor + write
  // captures stay installed for the whole simulate, restored in finally.
  const acceptPassives = args.acceptPassives ?? false;
  const passiveAcceptor = installPassiveAutoAcceptor(acceptPassives);
  const headlessGates = installHeadlessGates();
  const { captures, restore } = await installWriteCaptures();

  const passResults = [];
  const renderedCards = [];   // one card per pass (two-weapon → 2)
  let resolveError = null;

  try {
    // First pass (or only pass).
    let computeArgs = {
      attackerTokenUuid: args.attackerTokenUuid,
      targetTokenUuids: args.targetTokenUuids,
      mode: args.mode ?? "main",
      force: args.force,
    };
    let totalPasses = null;
    let passIndex = 0;
    while (true) {
      const compute = await runDirectorAttackCompute(computeArgs);
      if (!compute.ok) {
        // Bail with the compute error and clean up.
        await preApplied.cleanup();
        formulaOverrides.restore();
        restore();
        passiveAcceptor.restore();
        headlessGates.restore();
        return compute;
      }

      // Stamp the harness-only fields RESOLVE / makeChainContext consume — the
      // same patch `runDirectorSkillSimulate` applies. Without `_harnessPicks`
      // an accepted reaction whose chain opens an `open_action_menu` (the
      // Warning Shot / Bone Crusher "the attack deals no damage — choose an
      // effect" family) blocks on a real prompt and the pass dies on the
      // 60s harness timeout, which reads exactly like "the row never fired".
      const arPatch = {};
      if (Array.isArray(args.picks)) arPatch._harnessPicks = [...args.picks];
      if (args.harnessNumbers && typeof args.harnessNumbers === "object") {
        arPatch._harnessNumbers = { ...args.harnessNumbers };
      }
      let ar = Object.keys(arPatch).length
        ? freezeActionResult({ ...compute.actionResult, ...arPatch })
        : compute.actionResult;
      // Pre-pass aggregator — the `acceptReactions` arg simulates CONFIRM-stage
      // pill-accepts for `creature_will_deal_damage` reactions (Cheap Shot
      // family). Bonus damage is baked into perTargetResults before RESOLVE.
      if (args.acceptReactions) {
        try {
          const attackerActor = await fromUuid(args.attackerTokenUuid).then((d) => d?.actor ?? null).catch(() => null);
          if (attackerActor) {
            ar = await applyAcceptedReactionsToActionResult({
              ar, attackerActor, accept: args.acceptReactions, picks: Array.isArray(args.picks) ? args.picks : null,
              dCombat: { round, currentTurnResolved: false },
              deps,
            });
          }
        } catch (e) { console.warn(`${TAG} attack acceptReactions threw`, e); }
      }
      // Render-capture for this pass (post-roll, pre-RESOLVE). Non-fatal.
      try {
        const card = captureActionCard(ar, deps);
        if (card) renderedCards.push(card);
      } catch (e) { console.warn(`${TAG} attack card capture threw`, e); }
      const synthDirector = {
        ctx: { actionResult: ar, _resumedFromPendingAction: true },
        dCombat: { round, currentTurnResolved: false },
        state: STATES.RESOLVE,
        enqueue() {}, dispatch() {},
      };
      try {
        const outcome = await withHarnessTimeout(
          STATE_HANDLERS[STATES.RESOLVE].onEnter(synthDirector, {
            triggerIntent: { type: INTENTS.CONFIRM_ACTION },
          }),
          "attack RESOLVE",
        );
        if (outcome?.__harnessTimeout) {
          resolveError = { pass: passIndex + 1, message: `RESOLVE did not settle within ${outcome.ms}ms — treated as a harness timeout so the prototype patches are restored`, timeout: true };
          break;
        }
      } catch (e) {
        resolveError = { pass: passIndex + 1, message: String(e?.message ?? e), stack: String(e?.stack ?? "").slice(0, 500) };
        break;
      }

      passResults.push({
        passIndex: compute.nextPassIndex,
        weapon: ar.weapon?.name ?? null,
        summary: compute.summary,
        actionResult: ar,
      });

      // Continue with remaining pendingPasses (two-weapon's second hand).
      const remaining = compute.pendingPasses ?? [];
      if (!remaining.length) break;
      totalPasses = compute.totalPasses;
      passIndex = compute.nextPassIndex;
      computeArgs = {
        attackerTokenUuid: args.attackerTokenUuid,
        targetTokenUuids: args.targetTokenUuids,
        mode: args.mode ?? "main",
        force: args.force,
        pendingPasses: remaining,
        passIndex,
        totalPasses,
      };
    }
  } finally {
    restore();
    passiveAcceptor.restore();
    headlessGates.restore();
    await preApplied.cleanup();
    formulaOverrides.restore();
  }

  return attachCardHelpers({
    ok: !resolveError,
    passes: passResults,
    captures,
    perActorWrites: summarizeWrites(captures),
    preApplied: preApplied.created,
    resolveError,
  }, renderedCards);
}

// ─── Passive trigger dispatch test (Gap 11) ─────────────────────────────
//
// Tightened TARGET-state coverage: a Skill / Spell never goes through
// TARGET in the regression bundle (we shortcut through COMPUTE → RESOLVE),
// so passives that fire from a TARGET-emitted trigger like
// `caster_short_on_mp` can't be tested end-to-end via runDirectorSkillSimulate.
// This wrapper invokes `firePassiveTriggers` directly with the same
// scaffolding (formula overrides, passive auto-acceptor, write captures)
// so authors can assert "trigger T fires passive P with payload X". The
// full TARGET simulator (cost gate UI + Dialog auto-accept) is deferred.
//
// Usage:
//   const fx = await FUCompanion.api.test.getDirectorTestFixtures();
//   const caster = await fromUuid(fx.caster.actorUuid);
//   await FUCompanion.api.test.runDirectorPassiveTriggerTest({
//     casterActor: caster,
//     trigger: "caster_short_on_mp",
//     payload: { actorUuid: caster.uuid, costMap: new Map([["mp", 10]]), mpNeeded: 10, curHp: 50 },
//     acceptPassives: { "Vismagus": true },
//     override: { CHAR_LEVEL: 10, SL: 1 },
//   });
//   // → { ok, fired, captures, perActorWrites }
//
async function runDirectorPassiveTriggerTest(args = {}) {
  if (!game.user?.isGM) return { ok: false, reason: "gm_only" };
  if (!args.casterActor) return { ok: false, reason: "missing_caster_actor" };
  if (!args.trigger) return { ok: false, reason: "missing_trigger" };

  const formulaOverrides = installFormulaOverrides(args.override);
  const preApplied = await installPreAppliedAEs(args.preApply);
  // Seed AFTER preApply so a seeded resource wins over anything an AE's
  // apply might have written, and is reverted in the SAME finally (before
  // the AE is torn down — order is symmetric with install).
  const seeded = await installSeededProps(args.seed);
  const acceptPassives = args.acceptPassives ?? false;
  const passiveAcceptor = installPassiveAutoAcceptor(acceptPassives);
  const headlessGates = installHeadlessGates();
  const { captures, restore } = await installWriteCaptures();

  let result = null;
  let err = null;
  try {
    const se = await import(
      `/modules/fabula-ultima-companion/scripts/battle-director/skill-effects.js?harness=${Date.now()}`,
    );
    result = await se.firePassiveTriggers({
      director: null,
      casterActor: args.casterActor,
      trigger: args.trigger,
      payload: args.payload ?? {},
    });
  } catch (e) {
    err = { message: String(e?.message ?? e), stack: String(e?.stack ?? "").slice(0, 500) };
  } finally {
    restore();
    passiveAcceptor.restore();
    headlessGates.restore();
    await seeded.cleanup();
    await preApplied.cleanup();
    formulaOverrides.restore();
  }

  return {
    ok: !err,
    fired: result?.fired ?? [],
    captures,
    perActorWrites: summarizeWrites(captures),
    error: err,
  };
}

// ─── Scenario runner (Phase 2.8) ────────────────────────────────────────
//
// Drives `runDirectorSkillSimulate` / `runDirectorAttackSimulate` from a
// declarative JSON scenario list. Lets a future test suite live as
// version-controlled .test.json files instead of ad-hoc bridge invocations.
//
// Scenario shape:
//   {
//     name: "Heal at SL 1 with full bonds",
//     kind: "skill" | "attack",                       // default "skill"
//     setup: {
//       caster:  "Test Caster",                        // actor name lookup
//       targets: ["Test Target Ally"]                  // actor names
//     },
//     action: { skill: "Heal" }                        // for kind: "skill"
//     // OR    { weapon: "main" | "off" | "two-weapon" } for kind: "attack"
//     args: { force, picks, override, acceptPassives, ... },
//     expect: {
//       writes: [{ actor: "Test Target Ally",
//                  "system.props.current_hp": 60 }],
//       aeApplied: [{ actor: "Test Target Ally", name: "Support Magic" }],
//       aeRemoved: [{ actor: "Test Target Ally", name: "Slow" }],
//     }
//   }
//
// Returns `{ total, pass, fail, results: [{name, pass, failures, writes,
// aeApplied, aeRemoved}] }`. Use `failures` to see WHICH assertions
// failed; the rest of the result mirrors the simulate output so callers
// can drill in.

function tokenForActor(scene, actor) {
  return Array.from(scene.tokens).find((t) => t.actor?.id === actor.id);
}

function lookupActorByName(name) {
  return game.actors.find((a) => a.name === name);
}

async function runOneScenario(scenario, scene) {
  const result = { name: scenario.name ?? "(unnamed)", pass: false, failures: [] };
  try {
    const setup = scenario.setup ?? {};
    const caster = lookupActorByName(setup.caster);
    if (!caster) { result.failures.push(`caster "${setup.caster}" not found`); return result; }
    const casterTok = tokenForActor(scene, caster);
    if (!casterTok) { result.failures.push(`no token for caster "${setup.caster}" on scene`); return result; }
    const targetActors = (setup.targets ?? []).map(lookupActorByName);
    for (let i = 0; i < targetActors.length; i++) {
      if (!targetActors[i]) {
        result.failures.push(`target "${setup.targets[i]}" not found`);
        return result;
      }
    }
    const targetToks = targetActors.map((a) => tokenForActor(scene, a));
    for (let i = 0; i < targetToks.length; i++) {
      if (!targetToks[i]) {
        result.failures.push(`no token for target "${setup.targets[i]}" on scene`);
        return result;
      }
    }

    const kind = String(scenario.kind ?? "skill").toLowerCase();
    let simResult;
    if (kind === "skill" || kind === "spell") {
      const skillName = scenario.action?.skill;
      const skillItem = caster.items.getName(skillName);
      if (!skillItem) {
        result.failures.push(`caster "${caster.name}" has no skill named "${skillName}"`);
        return result;
      }
      simResult = await runDirectorSkillSimulate({
        skillUuid: skillItem.uuid,
        casterTokenUuid: casterTok.uuid,
        targetTokenUuids: targetToks.map((t) => t.uuid),
        ...(scenario.args ?? {}),
      });
    } else if (kind === "attack") {
      simResult = await runDirectorAttackSimulate({
        attackerTokenUuid: casterTok.uuid,
        targetTokenUuids: targetToks.map((t) => t.uuid),
        mode: scenario.action?.weapon ?? "main",
        ...(scenario.args ?? {}),
      });
    } else if (kind === "passive-trigger" || kind === "passive_trigger") {
      // Direct firePassiveTriggers dispatch — Gap 11.
      const trigger = scenario.trigger ?? scenario.action?.trigger;
      if (!trigger) {
        result.failures.push(`passive-trigger scenario missing "trigger"`);
        return result;
      }
      // Allow payload.costMap to be authored as a plain object; convert
      // to Map (the engine expects a Map and mutates it for substitute_cost).
      let payload = scenario.payload ? { ...scenario.payload } : {};
      if (payload.costMap && !(payload.costMap instanceof Map)) {
        payload.costMap = new Map(Object.entries(payload.costMap));
      }
      if (!payload.actorUuid && !payload.sourceActorUuid) {
        payload.actorUuid = caster.uuid;
        payload.sourceActorUuid = caster.uuid;
      }
      simResult = await runDirectorPassiveTriggerTest({
        casterActor: caster,
        trigger,
        payload,
        ...(scenario.args ?? {}),
      });
      // Stash mutated costMap so the expect block can assert on it.
      if (payload.costMap instanceof Map) {
        simResult._costMapAfter = Object.fromEntries(payload.costMap);
      }
    } else {
      result.failures.push(`unsupported kind "${kind}"`);
      return result;
    }

    if (!simResult.ok) {
      result.failures.push(`simulate returned !ok: ${simResult.reason ?? simResult.resolveError?.message ?? "unknown"}`);
      result.simulate = simResult;
      return result;
    }

    const caps = simResult.captures ?? { actorUpdates: [], aeCreates: [], aeDeletes: [] };
    result.writes = caps.actorUpdates;
    result.aeApplied = caps.aeCreates;
    result.aeRemoved = caps.aeDeletes;

    // Assert expected writes (LAST write per actor+key wins). Compares with
    // == (== loose because patches may carry string-typed numbers in CSB).
    const expect = scenario.expect ?? {};
    if (Array.isArray(expect.writes)) {
      for (const w of expect.writes) {
        const actorName = w.actor;
        const lastByKey = {};
        for (const u of caps.actorUpdates) {
          if (u.actorName !== actorName) continue;
          for (const [k, v] of Object.entries(u.patch ?? {})) lastByKey[k] = v;
        }
        for (const [k, v] of Object.entries(w)) {
          if (k === "actor") continue;
          if (lastByKey[k] === undefined) {
            result.failures.push(`expected write ${actorName}.${k} = ${JSON.stringify(v)}; no write captured`);
          } else if (String(lastByKey[k]) !== String(v)) {
            result.failures.push(`expected write ${actorName}.${k} = ${JSON.stringify(v)}; got ${JSON.stringify(lastByKey[k])}`);
          }
        }
      }
    }
    if (Array.isArray(expect.aeApplied)) {
      for (const a of expect.aeApplied) {
        const match = caps.aeCreates.find((c) => c.parentName === a.actor && c.name === a.name);
        if (!match) {
          result.failures.push(`expected AE "${a.name}" applied to ${a.actor}; not captured`);
        }
      }
    }
    if (Array.isArray(expect.aeRemoved)) {
      for (const a of expect.aeRemoved) {
        const match = caps.aeDeletes.find((d) => d.aeName === a.name);
        if (!match) {
          result.failures.push(`expected AE "${a.name}" removed; not captured`);
        }
      }
    }
    // Passive-trigger scenario assertions: fired carriers + cost-map.
    if (Array.isArray(expect.fired)) {
      const fired = simResult.fired ?? [];
      for (const e of expect.fired) {
        const match = fired.find((f) =>
          f.carrier === e.carrier && (!e.kind || f.kind === e.kind) && f.ok !== false,
        );
        if (!match) {
          result.failures.push(`expected fired { carrier: "${e.carrier}"${e.kind ? `, kind: "${e.kind}"` : ""} } not captured; got ${JSON.stringify(fired)}`);
        }
      }
    }
    if (expect.costMapAfter && simResult._costMapAfter) {
      for (const [k, v] of Object.entries(expect.costMapAfter)) {
        const got = simResult._costMapAfter[k];
        if (String(got) !== String(v)) {
          result.failures.push(`expected costMapAfter.${k} = ${JSON.stringify(v)}; got ${JSON.stringify(got)}`);
        }
      }
    }

    result.pass = result.failures.length === 0;
    return result;
  } catch (e) {
    result.failures.push(`threw: ${String(e?.message ?? e)}`);
    result.error = String(e?.stack ?? e).slice(0, 500);
    return result;
  }
}

async function runDirectorScenarios(scenarios = []) {
  if (!game.user?.isGM) return { ok: false, reason: "gm_only" };
  if (!Array.isArray(scenarios) || !scenarios.length) {
    return { ok: false, reason: "no_scenarios" };
  }
  const scene = game.scenes.find((s) => s.name === "Training Ground");
  if (!scene) return { ok: false, reason: "training_ground_not_found" };

  const results = [];
  for (const sc of scenarios) {
    results.push(await runOneScenario(sc, scene));
  }
  const pass = results.filter((r) => r.pass).length;
  return {
    ok: true,
    total: results.length,
    pass,
    fail: results.length - pass,
    results,
  };
}

// Convenience: enumerate the test fixtures. Returns Test Caster + targets
// with their items mapped by name so callers don't have to look up uuids.
// Returns null if the test actors aren't set up yet.
async function getDirectorTestFixtures() {
  const caster = game.actors.find((a) => a.name === "Test Caster");
  const ally   = game.actors.find((a) => a.name === "Test Target Ally");
  const enemy  = game.actors.find((a) => a.name === "Test Target Enemy");
  const scene  = game.scenes.find((s) => s.name === "Training Ground");
  if (!caster || !ally || !enemy || !scene) return null;
  const tok = (actor) => Array.from(scene.tokens).find((t) => t.actor?.id === actor.id);
  const items = Object.fromEntries(
    caster.items.contents.map((i) => [i.name, { uuid: i.uuid, id: i.id, skill_type: i.system?.props?.skill_type }])
  );
  return {
    scene: { id: scene.id, name: scene.name },
    caster: { actorUuid: caster.uuid, tokenUuid: tok(caster)?.uuid, items },
    ally:   { actorUuid: ally.uuid,   tokenUuid: tok(ally)?.uuid   },
    enemy:  { actorUuid: enemy.uuid,  tokenUuid: tok(enemy)?.uuid  },
  };
}

// Live hot-reload entry point. Bumps the shared cache-bust token and re-imports
// every registered hot edge so edits to a hot-routed module (skill-effects.js
// today) take effect mid-session without a Ctrl+Shift+R. Imports hot-reload.js
// as a singleton (its registry lives on globalThis), so no cache-bust here.
async function reloadHot() {
  if (!game.user?.isGM) return { ok: false, reason: "gm_only" };
  try {
    const hot = await import("./hot-reload.js");
    const res = await hot.bumpAndRefresh();
    console.info(`${TAG} reloadHot → token=${res.token}, refreshed ${res.refreshed}/${res.edges.length} edge(s):`, res.edges);
    return { ok: true, ...res };
  } catch (e) {
    console.error(`${TAG} reloadHot failed`, e);
    return { ok: false, reason: "threw", error: String(e?.message ?? e) };
  }
}

// Register on the FUCompanion.api.test namespace alongside the legacy
// harness. We don't replace the legacy methods — they coexist.
function registerHarness() {
  const root = (globalThis.FUCompanion = globalThis.FUCompanion || {});
  root.api = root.api || {};
  root.api.test = root.api.test || {};
  root.api.test.runDirectorSkillCompute   = runDirectorSkillCompute;
  root.api.test.runDirectorSkillSimulate  = runDirectorSkillSimulate;
  root.api.test.runDirectorAttackCompute  = runDirectorAttackCompute;
  root.api.test.runDirectorAttackSimulate = runDirectorAttackSimulate;
  root.api.test.runDirectorScenarios      = runDirectorScenarios;
  root.api.test.runDirectorPassiveTriggerTest = runDirectorPassiveTriggerTest;
  root.api.test.getDirectorTestFixtures   = getDirectorTestFixtures;
  // Reaction testing. Use these instead of hand-building a candidate — a wrong
  // one fires nothing and every with-vs-without assertion then passes on 0===0.
  root.api.test.probeCardReactions        = probeCardReactions;
  root.api.test.probeGmReactionOverride   = probeGmReactionOverride;
  // Defender-side family. probeCardReactions scans the ATTACKER only, so
  // creature_targeted_by_action carriers are invisible to it.
  root.api.test.probeTargetedReactions    = probeTargetedReactions;
  // Lifecycle + subject-side families. NOTE runDirectorPassiveTriggerTest
  // cannot fire anything (it passes director:null and dispatchReactionMenu
  // early-returns on that) - use this instead.
  root.api.test.probeReactorTrigger       = probeReactorTrigger;
  // Write-capture invariant. `harnessWriteCaptureState().poisoned` is true when a
  // previous run leaked its patch and the page is swallowing every write while
  // reporting success — assert it before trusting ANY run, and before making a
  // world edit through the bridge. `healHarnessWrites()` repairs it in place.
  root.api.test.harnessWriteCaptureState  = harnessWriteCaptureState;
  root.api.test.healHarnessWrites         = healHarnessWrites;
  // Golden-snapshot helpers (render-capture regression).
  root.api.test.diffCardGolden            = diffCardGolden;
  root.api.test.normalizeCardHtml         = normalizeCardHtml;
  // Live hot-reload: bump the cache-bust token and re-import every registered
  // hot edge (currently state-handlers → skill-effects). Call this after editing
  // skill-effects.js DURING a real session to pick up the change without a
  // Ctrl+Shift+R. Returns { token, refreshed, edges }.
  root.api.test.reloadHot                 = reloadHot;
  console.info(`${TAG} registered: runDirectorSkillCompute/Simulate, runDirectorAttackCompute/Simulate, runDirectorScenarios, runDirectorPassiveTriggerTest, getDirectorTestFixtures, diffCardGolden, normalizeCardHtml, reloadHot`);
}
// Boot-time registration via the ready hook OR fast-path when the module
// is dynamically re-imported with cache-bust at runtime (Foundry's ready
// has already fired by then — Hooks.once("ready") would silently no-op).
if (typeof game !== "undefined" && game?.ready) registerHarness();
else Hooks.once("ready", registerHarness);

export {
  installSeededProps,
  runDirectorPassiveTriggerTest,
  runDirectorSkillCompute,
  runDirectorSkillSimulate,
  runDirectorAttackCompute,
  runDirectorAttackSimulate,
  runDirectorScenarios,
  getDirectorTestFixtures,
  diffCardGolden,
  normalizeCardHtml,
  reloadHot,
};
