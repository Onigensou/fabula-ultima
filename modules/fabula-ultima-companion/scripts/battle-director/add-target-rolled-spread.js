// add-target-rolled-spread.js — the ROLLED-SKILL branch of the CONFIRM
// add_target window (onAddTargetApply, state-handlers.js).
//
// The three older branches cover: a no-roll heal/damage spread (Potion Rain,
// Linked Invocation), a no-roll buff spread (Follow my lead) and a weapon
// ATTACK (Barrage / Bladestorm — rebuilt with `view:{kind:"Attack"}` + the
// current weapon vs DEF). An offensive SPELL has a roll but no weapon, so it
// fell through to the attack branch and returned {ok:false} silently: pill
// pending, no target, no error. This is that missing branch (Rondo of
// Nightmare: "perform a single Magic Check and confront it with the Magic
// Defense of each target").
//
// Flow:
//   1. Snapshot the caster's charge AEs (the cost is paid INSIDE the reaction
//      chain at Apply-click — consume_charge — so a later failure must refund).
//   2. Fire the reaction chain with a `_preRoll` sink: add_target pushes picks,
//      change_damage_element writes sink.elementOverride.
//   3. Resolve the picks straight from their tokens (the spell's own eligible
//      pool is NOT a ceiling: "all creatures you can see" is wider than the
//      spell's own targeting), and rebuild EVERY row — original + added —
//      through recomputeActionProfile (the single post-decision recompute), with
//      the SAME dice so one Magic Check is confronted with each target's own
//      defense (the skill's defense_target_type → MDEF for a spell).
//   4. Persist targets / rows / hit set / element on the actionResult so the
//      card's later recompute and RESOLVE commit the same thing.
//   Any failure after the chain ran → restore the charge snapshot (refund).
import { log, warn } from "./logger.js";
import { freezeActionResult, snapshotTargetForToken } from "./snapshot.js";

const NS = "fabula-ultima-companion";

function chargeSnapshot(actor) {
  const snap = new Map();
  for (const e of actor?.effects ?? []) {
    const c = e.flags?.[NS]?.charges;
    if (c != null) snap.set(e.id, { charges: Number(c), data: e.toObject() });
  }
  return snap;
}

async function refundCharges(actor, snap) {
  if (!actor || !snap?.size) return 0;
  let n = 0;
  for (const [id, s] of snap) {
    const live = actor.effects.get(id);
    try {
      if (!live) {
        // consume deleted it at zero — recreate it as it was.
        const d = foundry.utils.deepClone(s.data);
        await actor.createEmbeddedDocuments("ActiveEffect", [d], { keepId: true });
        n += 1;
      } else if (Number(live.flags?.[NS]?.charges) !== s.charges) {
        await live.update({ [`flags.${NS}.charges`]: s.charges });
        n += 1;
      }
    } catch (e) { warn(`add-target(rolled): charge refund failed on ${actor.name}/${s.data?.name}`, e); }
  }
  return n;
}

// Returns the same contract as the other onAddTargetApply branches:
// { ok:true, replaceRows, damage, targets } | { ok:false, cancelled? }.
export async function applyRolledSkillSpread({
  director, cand, attackerActor, remotePrompt = null, gateAddTargetCost = null,
  firePreAcceptedCandidate, recomputeActionProfile,
}) {
  const baseAr = director.ctx.actionResult;
  const attacker = director.ctx.turnSnapshot ?? baseAr?.attacker ?? null;
  if (!baseAr?.roll || !attacker) {
    warn(`add-target(rolled): missing ${!baseAr?.roll ? "roll" : "attacker"} — pill stays pending`);
    return { ok: false };
  }
  const existing = new Set((baseAr.targets ?? []).map((t) => t.tokenUuid));
  const sink = { addedTokenUuids: [] };
  let skillTags = "";
  try {
    const sk = baseAr.skillUuid ? await fromUuid(baseAr.skillUuid).catch(() => null) : null;
    skillTags = String(sk?.system?.props?.skill_tags ?? "");
  } catch { /* optional */ }
  const probe = {
    sourceActorUuid: baseAr.attackerActorRef ?? attacker.actorUuid,
    subjectActorUuid: baseAr.attackerActorRef ?? attacker.actorUuid,
    sourceTokenUuid: baseAr.attacker?.tokenUuid ?? attacker.tokenUuid ?? null,
    targets: [...existing], targetTokenUuids: [...existing],
    actionIntent: "harmful", actionKind: baseAr.kind ?? "Skill",
    actionSkillType: String(baseAr.skillType ?? "").toLowerCase(),
    actionIsCheck: !!baseAr.isCheck,
    actionName: baseAr.skillName ?? "Skill",
    skillTags, skillTarget: String(baseAr.skillTarget ?? ""),
    _preRoll: sink,
  };
  const charges0 = chargeSnapshot(attackerActor);
  let res = null;
  try { res = await firePreAcceptedCandidate({ director, casterActor: attackerActor, candidate: cand, payload: probe, remotePrompt }); }
  catch (e) { warn("add-target(rolled): chain threw", e); await refundCharges(attackerActor, charges0); return { ok: false }; }
  const fail = async (why, extra = {}) => {
    const n = await refundCharges(attackerActor, charges0);
    log(`add-target(rolled): ${why} — pill stays pending${n ? ` (refunded ${n} charge AE(s))` : ""}`);
    return { ok: false, ...extra };
  };
  if (!res?.ok || res.abort) return fail(`chain ${res?.cancelled ? "cancelled" : (res?.abort ? "aborted" : "returned not-ok")}`, { cancelled: !!res?.cancelled });

  const newSnaps = [];
  for (const u of sink.addedTokenUuids) {
    if (existing.has(u) || newSnaps.some((s) => s.tokenUuid === u)) continue;
    const tok = await fromUuid(u).catch(() => null);
    const snap = tok?.actor ? snapshotTargetForToken(tok) : null;
    if (snap) newSnaps.push(snap);
  }
  if (!newSnaps.length) return fail(`no new targets resolved from picks [${sink.addedTokenUuids.join(", ")}]`, { cancelled: true });
  if (gateAddTargetCost && !await gateAddTargetCost(newSnaps.length)) return fail("unaffordable");

  const element = String(sink.elementOverride ?? "").trim().toLowerCase() || null;
  const allSnaps = [...(baseAr.targets ?? []), ...newSnaps];
  const arForRecompute = { ...baseAr, targets: allSnaps, ...(element ? { damageType: element } : {}) };
  const delta = await recomputeActionProfile({ ar: arForRecompute, targets: allSnaps, round: director.dCombat?.round ?? 0 });
  const rows = delta?.perTargetResults ?? [];
  if (rows.length !== allSnaps.length) return fail(`recompute returned ${rows.length} row(s) for ${allSnaps.length} target(s)`);
  // One shared Magic Check: the rebuilt total must reproduce the rolled one.
  const t0 = Number(baseAr.roll.total), t1 = Number(delta?.roll?.total ?? t0);
  if (Number.isFinite(t1) && t1 !== t0) warn(`add-target(rolled): recomputed check total ${t1} != rolled ${t0} — keeping the rolled roll`);
  const hitTokenUuids = rows.filter((r) => r?.hit).map((r) => r.tokenUuid).filter(Boolean);
  director.ctx.actionResult = freezeActionResult({
    ...baseAr,
    ...(element ? { damageType: element } : {}),
    targets: allSnaps, perTargetResults: rows, hitTokenUuids,
    ...(delta?.damage ? { damage: delta.damage } : {}),
  });
  // The cost was paid at Apply-click (inside the chain). If the player then
  // CANCELS the action card, CONFIRM refunds it from this record
  // (refundAddTargetChargesOnCancel); a confirmed action clears it.
  if (!Array.isArray(director.ctx._addTargetChargeRefunds)) director.ctx._addTargetChargeRefunds = [];
  director.ctx._addTargetChargeRefunds.push({ actorUuid: attackerActor.uuid, entries: [...charges0.entries()] });
  log(`add-target(rolled): ${baseAr.skillName ?? "skill"} spread +${newSnaps.length} target(s) sharing check total ${t0}${element ? `, element → ${element}` : ""}`);
  return {
    ok: true, replaceRows: rows, damage: delta?.damage,
    targets: allSnaps.map((s) => ({ name: s.name, actorUuid: s.actorUuid, tokenUuid: s.tokenUuid, tokenImg: s.tokenImg, disposition: s.disposition })),
    element, added: newSnaps.map((s) => s.tokenUuid),
  };
}

// CONFIRM hook: the action card was cancelled after a rolled-skill spread was
// applied → restore the charges its chain spent (Rondo's Grave Points). Always
// clears the record (a confirmed action simply drops it).
export async function settleAddTargetChargeRefunds(director, { cancelled }) {
  const list = director?.ctx?._addTargetChargeRefunds;
  if (director?.ctx) director.ctx._addTargetChargeRefunds = [];
  if (!cancelled || !Array.isArray(list) || !list.length) return 0;
  let n = 0;
  for (const rec of list) {
    const actor = await fromUuid(rec.actorUuid).catch(() => null);
    if (actor) n += await refundCharges(actor, new Map(rec.entries));
  }
  if (n) log(`add-target(rolled): action cancelled — refunded ${n} charge AE(s)`);
  return n;
}
