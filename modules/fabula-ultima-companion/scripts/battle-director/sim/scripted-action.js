// Scripted Action — the skill-under-test hook for the automated playtest.
//
// The autopilot normally lets a brain (profiles.js / player-brain.js for PCs,
// ActionReader pattern tables for NPCs) choose every turn. That is exactly what
// you want for a BALANCE run and exactly what you DON'T want when the question is
// "does THIS skill behave correctly?" — you can't observe a skill the AI never
// decides to cast.
//
// A scripted directive pins that down: a named combatant (PC or monster) is FORCED
// to cast a named skill on chosen targets, with an optional forced dice outcome —
// and it runs through the REAL live FSM, so you see the actual action card, the
// real reaction auto-resolution, the real AE application and the real HP writes.
// That is the fidelity the isolated `runDirectorSkillCompute/Simulate` harness
// cannot give you (it fakes the director); this is the same skill under the whole
// pipeline instead.
//
// Consumed from ONE place — the top of `autopilotDecideAction` (enemy-autopilot.js),
// which is the single hands-free DECLARE chokepoint for BOTH sides. So a directive
// can name a party PC (Iceberg) or a boss (Geist's death skill) with no other change.
//
// Directives are registered on SimMode by the runner (sim-run.js `scripts` option /
// `testSkill`) and cleared with the run. See [[reference_director_test_harness]].

import { log, warn } from "../logger.js";
import { SimMode } from "./sim-mode.js";
import { canAffordItem } from "./cost.js";
import { attrDieSize, readPropNum } from "../snapshot.js";

// Strip the sim clone's " [SIM]" suffix so a directive keyed by the real actor name
// matches the clone on the field. Mirrors profiles.js `profileFor`.
const baseName = (n) => String(n ?? "").replace(/\s*\[SIM\]\s*$/i, "").trim().toLowerCase();

// ── The combatant the acting `snap` belongs to ──────────────────────────────
function selfCombatant(director, snap) {
  return director?.dCombat?.combatants?.find?.((c) => c.tokenId === snap?.tokenId) ?? null;
}

const tokenUuidOf = (dc) => dc?.tokenUuid ?? dc?.tokenDoc?.uuid ?? null;

// Living combatants split relative to the acting side, so "enemies"/"allies" in a
// directive are read from the CASTER's point of view (a monster's "enemies" are the
// party; a PC's "enemies" are the monsters). Mirrors player-brain `sides`.
function sides(director, self) {
  const mine = self?.side ?? "party";
  const all = (director?.dCombat?.combatants ?? []).filter((c) => !c.isDefeatedLive?.());
  return {
    allies: all.filter((c) => c.side === mine),
    foes: all.filter((c) => c.side !== mine),
  };
}

// ── Skill lookup ────────────────────────────────────────────────────────────
// A directive names the skill by UUID (exact) or by name (case-insensitive, matched
// against the caster's own items — the same item the player would click).
async function resolveSkillItem(actorDoc, skillRef) {
  const ref = String(skillRef ?? "").trim();
  if (!ref) return null;
  if (ref.includes(".")) {
    const byUuid = await fromUuid(ref).catch(() => null);
    // Accept a UUID that resolves to an item the caster actually owns, or a bare
    // world skill we can still fire (the caster is the performer regardless).
    if (byUuid) return byUuid;
  }
  const want = ref.toLowerCase();
  return actorDoc?.items?.find?.((i) => String(i.name).trim().toLowerCase() === want) ?? null;
}

// ── Target resolution ───────────────────────────────────────────────────────
// `targets` is one of:
//   - "enemy" / "foe" / "focus"   → the party's called target if set, else the
//                                    lowest-HP living foe (single)
//   - "enemies" / "foes" / "all-enemies" → every living foe
//   - "self"                      → the caster
//   - "ally" / "allies"           → every living ally (self included)
//   - "other-allies"              → living allies except the caster
//   - string[] of token UUIDs / actor names → matched against living combatants
// Returns an array of token UUIDs (may be empty → caller falls through).
function resolveTargets(director, self, targets) {
  const { allies, foes } = sides(director, self);
  const selfUuid = tokenUuidOf(self);

  const lowestHp = (list) =>
    list.slice().sort((a, b) =>
      readPropNum(a.actorDoc, ["current_hp", "hp"]) - readPropNum(b.actorDoc, ["current_hp", "hp"]))[0] ?? null;

  // Semantic selectors.
  if (typeof targets === "string" || targets == null) {
    const sel = String(targets ?? "enemy").trim().toLowerCase();
    switch (sel) {
      case "self":
        return [selfUuid].filter(Boolean);
      case "ally":
      case "allies":
        return allies.map(tokenUuidOf).filter(Boolean);
      case "other-allies":
        return allies.filter((c) => tokenUuidOf(c) !== selfUuid).map(tokenUuidOf).filter(Boolean);
      case "enemies":
      case "foes":
      case "all-enemies":
        return foes.map(tokenUuidOf).filter(Boolean);
      case "enemy":
      case "foe":
      case "focus":
      default: {
        // The party's called target, if it is still a living foe; else lowest-HP foe.
        const focusUuid = SimMode.focus();
        const called = foes.find((c) => tokenUuidOf(c) === focusUuid);
        const pick = called ?? lowestHp(foes);
        return pick ? [tokenUuidOf(pick)].filter(Boolean) : [];
      }
    }
  }

  // Explicit list — UUIDs pass through; names are matched against living combatants.
  if (Array.isArray(targets)) {
    const everyone = [...allies, ...foes];
    const out = [];
    for (const t of targets) {
      const s = String(t ?? "").trim();
      if (!s) continue;
      if (s.includes(".")) { out.push(s); continue; }   // a token/actor UUID
      const want = s.toLowerCase();
      const hit = everyone.find((c) => baseName(c.name) === want || String(c.name).trim().toLowerCase() === want);
      const uuid = hit ? tokenUuidOf(hit) : null;
      if (uuid) out.push(uuid);
    }
    return out.filter(Boolean);
  }

  return [];
}

// ── Forced dice ─────────────────────────────────────────────────────────────
// Convert a `force` shorthand into the two accuracy-die faces the live COMPUTE
// should roll, then arm them on SimMode so the very next check roll uses them.
//
// This mirrors the isolated harness's `expandForceSemantics` (see
// _test-harness-director.js) — the SAME crit/fumble/hit/miss rules — but resolves
// the caster's dice + the target's DEF/MDEF live off the board. Fabula Ultima's
// accuracy check draws exactly two dice and damage carries no separate roll (HR is
// the higher die), so two armed faces is the whole check.
//
// Best-effort by construction: it feeds the NEXT two randomUniform draws. In the
// sim's controlled flow the next draw after a declaration is this action's accuracy
// check, so it lands — but a reaction that rolls in between would consume them
// first. Logged either way.
function armForcedDice({ force, skill, casterActor, targetActors }) {
  if (!force) return;
  const p = skill?.system?.props ?? {};

  // No check → no dice to force. Say so rather than silently arming a no-op.
  const a1 = String(p.rolled_atr1 ?? "").toUpperCase();
  const a2 = String(p.rolled_atr2 ?? "").toUpperCase();
  const hasCheck = !!p.isCheck || (a1 && a2);
  if (!hasCheck) {
    log(`[SIM] scripted: "${skill?.name}" has no accuracy check — force ignored`);
    return;
  }

  const dA = attrDieSize(casterActor, a1) || 8;
  const dB = attrDieSize(casterActor, a2) || 8;
  const checkBonus = Number(p.check_bonus ?? 0) || 0;
  const fumbleThreshold = readPropNum(casterActor, ["fumble_threshold"], 1);

  // DEF vs MDEF: the skill's explicit defense_target_type wins; else a Spell checks
  // vs MDEF and everything else vs DEF (mirrors buildInitialActionResult).
  const dtt = String(p.defense_target_type ?? "").toLowerCase();
  const isSpell = String(p.skill_type ?? "").toLowerCase() === "spell";
  const vsMdef = dtt === "mdef" || dtt === "magic" || (!dtt && isSpell);
  const defs = (targetActors ?? []).map((t) =>
    vsMdef ? readPropNum(t, ["magic_defense", "current_mdef", "mdef"]) : readPropNum(t, ["defense", "current_def", "def"]));
  const minDef = defs.length ? Math.min(...defs) : 0;

  const faces = expandForce(force, { dA, dB, fumbleThreshold, checkBonus, minDef });
  if (!faces) return;

  SimMode.armDice(faces.rA, dA, faces.rB, dB);
  log(`[SIM] scripted: forced ${describeForce(force)} → ${a1}=${faces.rA}(d${dA}) ${a2}=${faces.rB}(d${dB}) vs ${vsMdef ? "MDEF" : "DEF"} ${minDef}`);
}

function describeForce(force) {
  if (Number.isFinite(force.rA) && Number.isFinite(force.rB)) return `dice ${force.rA}/${force.rB}`;
  return ["crit", "fumble", "hit", "miss"].find((k) => force[k]) ?? "custom";
}

// Same decision rules as the isolated harness. Raw {rA,rB} wins; then crit, fumble,
// hit (cheapest passing pair), miss (largest failing pair, avoiding crit/fumble).
function expandForce(force, { dA, dB, fumbleThreshold, checkBonus, minDef }) {
  if (Number.isFinite(force.rA) && Number.isFinite(force.rB)) {
    return { rA: force.rA, rB: force.rB };
  }
  if (force.crit) return { rA: dA, rB: dA === dB ? dB : dA };
  if (force.fumble) return { rA: 1, rB: 1 };
  if (force.hit) {
    for (let a = 1; a <= dA; a++) {
      for (let b = 1; b <= dB; b++) {
        if (a === b && a >= 6) continue;                        // skip crit
        if (a <= fumbleThreshold && b <= fumbleThreshold) continue;  // skip fumble
        if (a + b + checkBonus >= minDef) return { rA: a, rB: b };
      }
    }
    return { rA: dA, rB: dB };   // even max can't hit — caller sees the miss
  }
  if (force.miss) {
    for (let a = dA; a >= 1; a--) {
      for (let b = dB; b >= 1; b--) {
        if (a === b && a >= 6) continue;
        if (a <= fumbleThreshold && b <= fumbleThreshold) continue;
        if (a + b + checkBonus < minDef) return { rA: a, rB: b };
      }
    }
    return { rA: 1, rB: 2 };   // target too weak to miss without fumbling
  }
  return null;
}

// ── Bundle ──────────────────────────────────────────────────────────────────
// The compose bundle the FSM's DECLARE consumes. Skill vs Spell is read off the
// item exactly as player-brain's castBundle does; `_name` rides along for the
// transcript + the re-declare guard.
function scriptedBundle(item, targetUuids) {
  const st = String(item?.system?.props?.skill_type ?? "").trim().toLowerCase();
  const command = st === "spell" ? "Spell" : "Skill";
  return { command, skillUuid: item.uuid, sourceItemUuid: item.uuid, targetUuids, _name: item.name, _scripted: true };
}

// ── The hook ────────────────────────────────────────────────────────────────
// Returns a compose bundle when a scripted directive applies to THIS combatant's
// turn, or null to let the normal brain decide. Called at the top of
// autopilotDecideAction (before the free-action and ActionReader paths).
export async function scriptedBundleFor(director, snap) {
  if (!SimMode.active || !SimMode.hasScripts()) return null;

  const self = selfCombatant(director, snap);
  const actorDoc = self?.actorDoc ?? null;
  if (!actorDoc) return null;

  const directive = SimMode.scriptFor({ name: actorDoc.name, uuid: actorDoc.uuid });
  if (!directive) return null;

  // Re-declare guard. If we already scripted this action THIS turn and we're back
  // here, the declaration bounced (an invisible precondition — see SimMode's guard).
  // Retire the directive for this turn and let the brain choose, rather than pinning
  // a skill the FSM keeps rejecting into an infinite loop.
  const turnKey = `${director?.dCombat?.round ?? 0}:${snap?.combatantId ?? snap?.tokenId ?? "?"}:scripted`;
  const sig = `scripted:${directive.skill}`;
  if (SimMode.declaredThisTurn(turnKey, sig)) {
    SimMode.note("scripted", `"${directive.skill}" bounced for ${baseName(actorDoc.name)} — handing this turn to the brain`);
    return null;
  }

  const item = await resolveSkillItem(actorDoc, directive.skill);
  if (!item?.uuid) {
    SimMode.note("scripted", `${baseName(actorDoc.name)} has no skill "${directive.skill}" — brain decides`);
    return null;
  }

  if (!canAffordItem(actorDoc, item).ok) {
    SimMode.note("scripted", `${baseName(actorDoc.name)} can't afford "${item.name}" — brain decides`);
    return null;
  }

  const targetUuids = resolveTargets(director, self, directive.targets);
  if (!targetUuids.length) {
    SimMode.note("scripted", `no valid target for "${item.name}" — brain decides`);
    return null;
  }

  // Arm forced dice for the accuracy roll COMPUTE is about to make.
  if (directive.force) {
    try {
      const targetActors = targetUuids
        .map((u) => (director?.dCombat?.combatants ?? []).find((c) => tokenUuidOf(c) === u)?.actorDoc)
        .filter(Boolean);
      armForcedDice({ force: directive.force, skill: item, casterActor: actorDoc, targetActors });
    } catch (e) { warn("[SIM] scripted: arming forced dice threw", e); }
  }

  SimMode.recordDeclaration(turnKey, sig);
  SimMode.note("scripted", `${baseName(actorDoc.name)} → ${item.name} on ${targetUuids.length} target(s)${directive.force ? ` [${describeForce(directive.force)}]` : ""}`);

  // A one-shot directive fires this turn then steps aside for the rest of the run.
  if (directive.once) SimMode.exhaustScript(directive);

  return scriptedBundle(item, targetUuids);
}
