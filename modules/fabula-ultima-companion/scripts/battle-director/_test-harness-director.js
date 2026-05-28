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
 * GM only (mirrors the legacy test harness gate).
 */

// NOTE: deps are dynamically re-imported per-call with a cache-bust so the
// harness ALWAYS exercises the latest disk state — the whole point of a test
// tool is to validate edits without forcing the user to hard-refresh. Foundry's
// soft reload doesn't bust the browser ESM cache, so static imports here would
// read whatever was loaded at boot.
async function loadDeps() {
  const bust = `?harness=${Date.now()}`;
  const [stateHandlers, states, intents, snapshot, skillIntent] = await Promise.all([
    import(`./state-handlers.js${bust}`),
    import(`./states.js${bust}`),
    import(`./intents.js${bust}`),
    import(`./snapshot.js${bust}`),
    import(`./skill-intent.js${bust}`),
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
    classifyActionIntent: skillIntent.classifyActionIntent,
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
    weapon: resolveAttackerWeapon(actor, { which: "main" })?.weapon ?? null,
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

// Install identifier overrides. These DO mutate the world briefly —
// skill.system.props.level for SL, actor bond/class for BOND_COUNT /
// CHAR_LEVEL. `round` is non-mutating (caller threads it via dCombat).
//
// Shape: { SL, BOND_COUNT, CHAR_LEVEL } — all optional integers.
async function installOverrides(override, skillUuid, casterTokenUuid) {
  const restores = [];
  if (!override) return { cleanup: async () => {} };

  if (Number.isFinite(override.SL)) {
    const skill = await fromUuid(skillUuid).catch(() => null);
    if (skill) {
      const prev = skill.system?.props?.level;
      await skill.update({ "system.props.level": String(override.SL) });
      restores.push(async () => skill.update({ "system.props.level": prev }));
    }
  }
  if (Number.isFinite(override.BOND_COUNT) || Number.isFinite(override.CHAR_LEVEL)) {
    const tok = await fromUuid(casterTokenUuid).catch(() => null);
    const actor = tok?.actor;
    if (actor) {
      const prevBonds = {};
      const prevClassList = actor.system?.props?.class_list;
      const update = {};
      if (Number.isFinite(override.BOND_COUNT)) {
        for (let i = 1; i <= 6; i++) prevBonds[`bond_${i}`] = actor.system?.props?.[`bond_${i}`];
        prevBonds.bond_temp = actor.system?.props?.bond_temp;
        for (let i = 1; i <= 6; i++) update[`system.props.bond_${i}`] = i <= override.BOND_COUNT ? `Test Bond ${i}` : "";
        update["system.props.bond_temp"] = "";
      }
      if (Number.isFinite(override.CHAR_LEVEL)) {
        // CHAR_LEVEL formula reads `system.props.level`, which CSB
        // DERIVES from `class_list` on every actor prep — writes to
        // `level` directly are clobbered. So we override class_list
        // instead: a single TestClass entry sized to the requested
        // total level. Restored from `prevClassList`.
        update["system.props.class_list"] = {
          "0": { "$deleted": false, level: String(override.CHAR_LEVEL), class_name: "TestClass", benefit: "hp" },
        };
      }
      await actor.update(update);
      restores.push(async () => {
        const r = {};
        for (const k of Object.keys(prevBonds)) r[`system.props.${k}`] = prevBonds[k];
        if (Number.isFinite(override.CHAR_LEVEL)) r["system.props.class_list"] = prevClassList;
        await actor.update(r);
      });
    }
  }
  return { cleanup: async () => { for (const fn of restores.reverse()) await fn(); } };
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

  // Step 0a — install identifier overrides (SL / BOND_COUNT / CHAR_LEVEL).
  // Briefly mutates the skill / actor; restored in `finally`.
  const overrides = await installOverrides(args.override, args.skillUuid, args.casterTokenUuid);

  // Step 0b — install pre-applied AEs (Mercy on caster for clamp tests, etc.).
  // These actually land on the actor — caveat: if our simulate throws BEFORE
  // the finally, they leak. The finally below covers normal paths.
  const preApplied = await installPreAppliedAEs(args.preApply);

  // Step 1 — COMPUTE (this also validates inputs + produces actionResult).
  const compute = await runDirectorSkillCompute(args);
  if (!compute.ok) {
    await preApplied.cleanup();
    await overrides.cleanup();
    return compute;
  }

  // If the caller passed `picks: [...]`, stamp them onto the ar as
  // `_harnessPicks` so makeChainContext picks them up during RESOLVE.
  // Have to re-freeze since freezeActionResult emits a sealed object.
  const deps = await loadDeps();
  const { STATE_HANDLERS, STATES, INTENTS, freezeActionResult } = deps;
  const ar = Array.isArray(args.picks)
    ? freezeActionResult({ ...compute.actionResult, _harnessPicks: [...args.picks] })
    : compute.actionResult;

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

  // Step 3 — install write captures + run RESOLVE.
  const { captures, restore } = installWriteCaptures();
  let resolveError = null;
  try {
    const resolveHandler = STATE_HANDLERS[STATES.RESOLVE];
    if (!resolveHandler?.onEnter) {
      restore();
      await preApplied.cleanup();
      return { ok: false, reason: "resolve_handler_missing" };
    }
    await resolveHandler.onEnter(synthDirector, {
      triggerIntent: { type: INTENTS.CONFIRM_ACTION },
    });
  } catch (e) {
    resolveError = { message: String(e?.message ?? e), stack: String(e?.stack ?? "").slice(0, 500) };
  } finally {
    restore();
    await preApplied.cleanup();
    await overrides.cleanup();
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
Hooks.once("ready", () => {
  const root = (globalThis.FUCompanion = globalThis.FUCompanion || {});
  root.api = root.api || {};
  root.api.test = root.api.test || {};
  root.api.test.runDirectorSkillCompute  = runDirectorSkillCompute;
  root.api.test.runDirectorSkillSimulate = runDirectorSkillSimulate;
  root.api.test.getDirectorTestFixtures  = getDirectorTestFixtures;
  console.info(`${TAG} registered: runDirectorSkillCompute, runDirectorSkillSimulate, getDirectorTestFixtures`);
});

export { runDirectorSkillCompute, runDirectorSkillSimulate, getDirectorTestFixtures };
