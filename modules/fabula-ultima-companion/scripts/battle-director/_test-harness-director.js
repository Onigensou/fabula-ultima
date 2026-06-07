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
async function loadDeps() {
  const bust = `?harness=${Date.now()}`;
  const [stateHandlers, states, intents, snapshot, skillIntent, skillEffects] = await Promise.all([
    import(`./state-handlers.js${bust}`),
    import(`./states.js${bust}`),
    import(`./intents.js${bust}`),
    import(`./snapshot.js${bust}`),
    import(`./skill-intent.js${bust}`),
    import(`./skill-effects.js${bust}`),
  ]);
  return {
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
    computeSenderDamageBonuses: skillEffects.computeSenderDamageBonuses,
    recomputePerTargetDamages: skillEffects.recomputePerTargetDamages,
  };
}

// Pre-pass simulator — runs the CONFIRM-stage `creature_will_deal_damage`
// aggregator + `computeSenderDamageBonuses` + `recomputePerTargetDamages`
// against the COMPUTE-stage ar. Used by both Attack and Skill simulators
// to validate pill-accepted reactions (Cheap Shot family) without driving
// the live action-card click flow. Returns the new frozen ar with
// `perTargetResults` updated and `acceptedPrePassives` stamped.
//
// `prePassives` filter shape:
//   - true                          → accept EVERY matching pre-passive (rare; risky if multiple match)
//   - ["Cheap Shot", "Vanish", ...] → accept only candidates whose carrierName matches one of these
async function applyPrePassivesToActionResult({ ar, attackerActor, prePassives, dCombat, deps }) {
  if (!prePassives) return ar;
  if (!Array.isArray(ar?.perTargetResults) || !ar.perTargetResults.length) return ar;
  if (!ar.hasDamage && ar.kind !== "Attack") return ar;
  const { findPassiveCandidates, computeSenderDamageBonuses, recomputePerTargetDamages, applyAffinityToDamage, freezeActionResult } = deps;
  const allTargetUuids = (ar.targets ?? []).map((t) => t.tokenUuid);
  const hitTargetUuids = ar.perTargetResults
    .filter((r) => r?.hit)
    .map((r) => r.tokenUuid ?? (ar.targets ?? []).find((t) => t?.actorUuid === r?.actorUuid)?.tokenUuid)
    .filter(Boolean);
  const byKey = new Map();
  for (const entry of ar.perTargetResults) {
    // Mirrors state-handlers CONFIRM: scan every target (hit or miss) so the
    // reaction surfaces regardless of outcome; only HIT targets are recorded
    // as recipients (appliesToTargetUuids), so the effect/cost land only on a
    // hit. A full-miss candidate surfaces with appliesToTargetUuids = [].
    const subjectActorUuid = entry?.actorUuid;
    if (!subjectActorUuid) continue;
    const matchedTarget = (ar.targets ?? []).find((t) => t?.actorUuid === subjectActorUuid);
    const subjectTokenUuid = entry.tokenUuid ?? matchedTarget?.tokenUuid ?? null;
    const payloadForTrigger = {
      subjectActorUuid,
      subjectTokenUuid,
      targets: allTargetUuids,
      hitTargets: hitTargetUuids,
      rawDamage: entry.rawDamage,
      damageType: ar.damageType ?? ar.damage?.element ?? null,
      weaponType: ar.weapon?.weaponType ?? null,
      affinity: entry.affinity,
      sourceTokenUuid: ar.attacker?.tokenUuid ?? null,
      sourceActorUuid: ar.attackerActorRef,
      actionIntent: ar.actionIntent,
      targetTokenUuids: allTargetUuids,
      hitTargetTokenUuids: hitTargetUuids,
      skillUuid: ar.skillUuid ?? null,
      weaponUuid: ar.weapon?.uuid ?? null,
    };
    let cands;
    try {
      cands = await findPassiveCandidates({
        casterActor: attackerActor,
        trigger: "creature_will_deal_damage",
        payload: payloadForTrigger,
      });
    } catch (e) {
      console.warn(`${TAG} prePassives findPassiveCandidates threw for ${entry?.name}`, e);
      continue;
    }
    for (const cand of cands ?? []) {
      // Filter to allowed names.
      if (prePassives !== true) {
        const namesArr = Array.isArray(prePassives) ? prePassives : [];
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
  const applied = [...byKey.values()];
  if (!applied.length) return ar;
  let recomputed = ar.perTargetResults;
  try {
    const bonusMap = await computeSenderDamageBonuses({
      casterActor: attackerActor,
      acceptedPrePassives: applied,
      dCombat,
    });
    if (bonusMap.size > 0) {
      recomputed = recomputePerTargetDamages(ar.perTargetResults, bonusMap, applyAffinityToDamage);
    }
  } catch (e) {
    console.warn(`${TAG} prePassives recompute threw`, e);
  }
  return freezeActionResult({
    ...ar,
    perTargetResults: recomputed,
    acceptedPrePassives: applied,
    evaluatedPrePassives: applied.map((c) => ({ carrierUuid: c.carrierUuid, rowKey: c.rowKey })),
  });
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
} = {}) {
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

  const deps = await loadDeps();
  const { STATE_HANDLERS, STATES, INTENTS } = deps;
  const attackerSnap = buildAttackerSnapshot(casterToken, deps);
  const targetSnaps  = targetTokens.map((t) => buildTargetSnapshot(t, deps));
  if (!attackerSnap) return { ok: false, reason: "caster_snapshot_failed" };

  const ar = buildInitialActionResult(skill, attackerSnap, targetSnaps, deps);

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
  try {
    await computeHandler.onEnter(synthDirector, {
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
function installWriteCaptures() {
  const captures = {
    actorUpdates: [],   // { actorUuid, actorName, patch }
    itemUpdates: [],    // { itemUuid, itemName, patch, parentUuid }
    aeUpdates: [],      // { aeId, aeName, parentUuid, patch }
    aeCreates: [],      // { parentUuid, parentName, name, statusIds, changes, flags }
    aeDeletes: [],      // { aeId, aeName, parentUuid }
  };

  // Snapshot originals from the actual runtime classes — the global
  // `Actor` / `Item` / `ActiveEffect` constructors. Foundry's documents
  // class hierarchy: ClientDocument extends BaseDocument; the runtime
  // class is what user code interacts with via `actor.update(...)`.
  const ActorCls = CONFIG.Actor.documentClass;
  const ItemCls  = CONFIG.Item.documentClass;
  const AECls    = CONFIG.ActiveEffect.documentClass;

  const originals = {
    actorUpdate:               ActorCls.prototype.update,
    actorCreateEmbedded:       ActorCls.prototype.createEmbeddedDocuments,
    actorDeleteEmbedded:       ActorCls.prototype.deleteEmbeddedDocuments,
    itemUpdate:                ItemCls.prototype.update,
    itemCreateEmbedded:        ItemCls.prototype.createEmbeddedDocuments,
    itemDeleteEmbedded:        ItemCls.prototype.deleteEmbeddedDocuments,
    aeUpdate:                  AECls.prototype.update,
    aeDelete:                  AECls.prototype.delete,
  };

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

  function restore() {
    ActorCls.prototype.update                  = originals.actorUpdate;
    ActorCls.prototype.createEmbeddedDocuments = originals.actorCreateEmbedded;
    ActorCls.prototype.deleteEmbeddedDocuments = originals.actorDeleteEmbedded;
    ItemCls.prototype.update                   = originals.itemUpdate;
    ItemCls.prototype.createEmbeddedDocuments  = originals.itemCreateEmbedded;
    ItemCls.prototype.deleteEmbeddedDocuments  = originals.itemDeleteEmbedded;
    AECls.prototype.update                     = originals.aeUpdate;
    AECls.prototype.delete                     = originals.aeDelete;
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

async function runDirectorSkillSimulate(args = {}) {
  if (!game.user?.isGM) return { ok: false, reason: "gm_only" };

  // Step 0a — install identifier overrides (SL / BOND_COUNT /
  // BOND_STRENGTH / CHAR_LEVEL) via the global formula registry.
  // Non-mutating; restored in `finally`.
  const formulaOverrides = installFormulaOverrides(args.override);

  // Step 0b — install pre-applied AEs (Mercy on caster for clamp tests, etc.).
  // These actually land on the actor — caveat: if our simulate throws BEFORE
  // the finally, they leak. The finally below covers normal paths.
  const preApplied = await installPreAppliedAEs(args.preApply);

  // Step 1 — COMPUTE (this also validates inputs + produces actionResult).
  const compute = await runDirectorSkillCompute(args);
  if (!compute.ok) {
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
  const deps = await loadDeps();
  const { STATE_HANDLERS, STATES, INTENTS, freezeActionResult } = deps;
  const arPatch = {};
  if (Array.isArray(args.picks)) arPatch._harnessPicks = [...args.picks];
  if (args.vismagusHpPaid === true) arPatch.vismagusHpPaid = true;
  let ar = Object.keys(arPatch).length
    ? freezeActionResult({ ...compute.actionResult, ...arPatch })
    : compute.actionResult;

  // Pre-pass aggregator — same as the attack simulator. Lets damage-bearing
  // Skills validate Cheap Shot-style reactions (`creature_will_deal_damage`
  // + `add_damage`) without driving the live action-card click flow.
  if (args.prePassives) {
    try {
      const round0 = Number.isFinite(args.round) ? args.round : 1;
      const attackerActor = await fromUuid(args.casterTokenUuid).then((d) => d?.actor ?? null).catch(() => null);
      if (attackerActor) {
        ar = await applyPrePassivesToActionResult({
          ar, attackerActor, prePassives: args.prePassives,
          dCombat: { round: round0, currentTurnResolved: false },
          deps,
        });
      }
    } catch (e) { console.warn(`${TAG} skill prePassives threw`, e); }
  }

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
  const { captures, restore } = installWriteCaptures();
  let resolveError = null;
  try {
    const resolveHandler = STATE_HANDLERS[STATES.RESOLVE];
    if (!resolveHandler?.onEnter) {
      restore();
      passiveAcceptor.restore();
      await preApplied.cleanup();
      formulaOverrides.restore();
      return { ok: false, reason: "resolve_handler_missing" };
    }
    await resolveHandler.onEnter(synthDirector, {
      triggerIntent: { type: INTENTS.CONFIRM_ACTION },
    });
  } catch (e) {
    resolveError = { message: String(e?.message ?? e), stack: String(e?.stack ?? "").slice(0, 500) };
  } finally {
    restore();
    passiveAcceptor.restore();
    await preApplied.cleanup();
    formulaOverrides.restore();
  }

  return {
    ok: !resolveError,
    actionResult: ar,
    summary: compute.summary,
    captures,
    perActorWrites: summarizeWrites(captures),
    preApplied: preApplied.created,
    resolveError,
  };
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

  const deps = await loadDeps();
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
  if (!game.user?.isGM) return { ok: false, reason: "gm_only" };

  const formulaOverrides = installFormulaOverrides(args.override);
  const preApplied = await installPreAppliedAEs(args.preApply);

  const deps = await loadDeps();
  const { STATE_HANDLERS, STATES, INTENTS } = deps;
  const round = Number.isFinite(args.round) ? args.round : 1;

  // Captures accumulate ACROSS passes for two-weapon. The acceptor + write
  // captures stay installed for the whole simulate, restored in finally.
  const acceptPassives = args.acceptPassives ?? false;
  const passiveAcceptor = installPassiveAutoAcceptor(acceptPassives);
  const { captures, restore } = installWriteCaptures();

  const passResults = [];
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
        return compute;
      }

      let ar = compute.actionResult;
      // Pre-pass aggregator — `prePassives` arg simulates CONFIRM-stage
      // pill-accepts for `creature_will_deal_damage` reactions (Cheap Shot
      // family). Bonus damage is baked into perTargetResults before RESOLVE.
      if (args.prePassives) {
        try {
          const attackerActor = await fromUuid(args.attackerTokenUuid).then((d) => d?.actor ?? null).catch(() => null);
          if (attackerActor) {
            ar = await applyPrePassivesToActionResult({
              ar, attackerActor, prePassives: args.prePassives,
              dCombat: { round, currentTurnResolved: false },
              deps,
            });
          }
        } catch (e) { console.warn(`${TAG} attack prePassives threw`, e); }
      }
      const synthDirector = {
        ctx: { actionResult: ar, _resumedFromPendingAction: true },
        dCombat: { round, currentTurnResolved: false },
        state: STATES.RESOLVE,
        enqueue() {}, dispatch() {},
      };
      try {
        await STATE_HANDLERS[STATES.RESOLVE].onEnter(synthDirector, {
          triggerIntent: { type: INTENTS.CONFIRM_ACTION },
        });
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
    await preApplied.cleanup();
    formulaOverrides.restore();
  }

  return {
    ok: !resolveError,
    passes: passResults,
    captures,
    perActorWrites: summarizeWrites(captures),
    preApplied: preApplied.created,
    resolveError,
  };
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
  const acceptPassives = args.acceptPassives ?? false;
  const passiveAcceptor = installPassiveAutoAcceptor(acceptPassives);
  const { captures, restore } = installWriteCaptures();

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
  console.info(`${TAG} registered: runDirectorSkillCompute/Simulate, runDirectorAttackCompute/Simulate, runDirectorScenarios, runDirectorPassiveTriggerTest, getDirectorTestFixtures`);
}
// Boot-time registration via the ready hook OR fast-path when the module
// is dynamically re-imported with cache-bust at runtime (Foundry's ready
// has already fired by then — Hooks.once("ready") would silently no-op).
if (typeof game !== "undefined" && game?.ready) registerHarness();
else Hooks.once("ready", registerHarness);

export {
  runDirectorPassiveTriggerTest,
  runDirectorSkillCompute,
  runDirectorSkillSimulate,
  runDirectorAttackCompute,
  runDirectorAttackSimulate,
  runDirectorScenarios,
  getDirectorTestFixtures,
};
