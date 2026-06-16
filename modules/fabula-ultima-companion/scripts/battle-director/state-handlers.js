// State handlers — the per-state onEnter / onExit / onAbort logic.
//
// For v1 prototype, only Attack and Guard are fully wired. Other commands
// log a "not implemented in director v1" notice and return the FSM to
// DECLARE so the user can pick again.
//
// Damage / accuracy computation lives here too (kept simple — full Fabula
// rules require equipped-weapon lookup, status effects, affinities, etc.,
// which are deliberately out of scope for the prototype).

import { log, warn, err } from "./logger.js";
import { runBattleEndSequence } from "./battle-end/battle-end-orchestrator.js";
import { STATES } from "./states.js";
import { INTENTS } from "./intents.js";
import { snapshotCombatant, snapshotDirectorCombatant, snapshotEligibleTargets, snapshotEligibleTargetsFromDCombat, readPropNum, attrDieSize, freezeActionResult, applyAffinityToDamage, applyAttackRangeGate } from "./snapshot.js";
import { TurnUI } from "./turn-ui.js";
import { TurnPicker } from "./turn-picker.js";
import { requestTargeting } from "./target-picker.js";
import { postActionCard, BattlefieldActionCard } from "./action-card.js";
import { pickWeaponMode, WeaponModePicker } from "./weapon-mode-picker.js";
import { pickAttributePair, AttributePairPicker } from "./attribute-pair-picker.js";
import { runDirectorInit } from "./director-init.js";
import { destroyDirectorHud } from "./director-player-hud.js";
import { playStudyVfx, playActionNamecard, playMissVfx, playResourceSpendVfx } from "./director-vfx.js";
import { playCritCutin } from "./director-cutin.js";
import { playRoundBanner, hideRoundBanner } from "./director-round-banner.js";
import { applyEquipmentSwap } from "./equipment-swap.js";
import { gatherConsumables, gatherCreatables, readActorIp, consumeOne, spendIp, getLinkedSkillUuid } from "./item-resource.js";
import { saveDirectorState, installItemDeletionTracker, clearAllDirectorStateFlags } from "./persistence.js";
import { computeBattleEndRewards } from "./battle-end/battle-end-rewards.js";
// Phase B.1 Skill engine
import { pickSkill, SkillPicker } from "./skill-picker.js";
import { ListPicker } from "./list-picker.js";
// Player-driven input: client-local compose chain runner.
import { composeAction, makeCancelToken } from "./compose-action.js";
import { getInvokeCapability } from "./invoke/invoke-core.js";
import { buildPseudoWeaponFromNpcAttack } from "./actor-shape.js";
import { parseSkillCost, resolveCost, checkAffordable, debitCost } from "./skill-cost.js";
// COMPUTE-side damage/accuracy helpers (resolveAccuracyParts, resolveOutgoingDamageParts,
// isCriticalHit, applyCritDamage, resolveIncomingReduction, buildDamageBonusParts,
// resolveDamageElementOverride) moved to action-profile.js (single-source COMPUTE).
import { evaluateFormula, buildSkillResolver } from "./skill-formulas.js";
import { freeActions } from "./free-actions.js";
import { makeChainContext, resolveTargetRef } from "./skill-targeting.js";
import { fireActivationEffect, fireActivationEffectPre, firePostDamageEffect, tickDirectorAEsForApplier, tickDirectorAEsForBearerTurnEnd, tickDirectorAEsAtRoundEnd, reapApplierTiedAEs, firePassiveTriggers, applyDamageToTarget, fireResourceChangeTrigger } from "./skill-effects.js";
import { appendBattleLog, buildMissRow } from "./director-battle-log.js";
import { rollCheck, checkVsThreshold } from "./check.js";
// Standalone-reaction dispatcher — runs at FSM transitions for triggers
// that aren't tied to an action card (conflict_start, turn_start, etc.).
// Spawns the token-anchored reaction menu via [[reaction-menu-on-token]].
import { dispatchStandaloneTrigger, clearAllStandaloneMenus } from "./standalone-reactions.js";
import { STANDALONE_TRIGGERS } from "./director-triggers.js";
import { pushFrame, popFrame, peekTop, topIsFreeAction, topIsSrwDetour, stackDepth, rewindPhaseLabel } from "./continuation-stack.js";
// Grappled (Advanced Debuff) — turn-start break-free helpers.
import { isGrappled, breakFree } from "./grappled.js";

// findPassiveCandidates + firePreAcceptedCandidate are dynamically
// imported (with one-shot cache-bust on first call) so this module
// loads cleanly against module caches that pre-date these exports.
// Without this, a fresh state-handlers (e.g. harness cache-bust) would
// fail to load whenever skill-effects.js was already in the boot-time
// cache without the new symbols.
let _seExtraModule = null;
async function getSkillEffectsExtras() {
  if (_seExtraModule) return _seExtraModule;
  _seExtraModule = await import("./skill-effects.js?cb=" + Date.now());
  return _seExtraModule;
}
import { getRuntimeSkillView, getRuntimeActionView } from "./skill-recipes.js";
import { computeActionProfile, projectProfileToActionResult } from "./action-profile.js";
import { classifyActionIntent } from "./skill-intent.js";
import { resolveAnimationSpec, playDirectorAnimation } from "./director-animation.js";

// Install a director-scoped watcher that releases Guard / Covered AEs
// when their associated actor drops to 0 HP. RAW Core p.70:
//   - Guarder dies / leaves / falls unconscious → Guard ends AND Cover
//     also ends (the guarder can't protect anyone while down).
//   - Covered ally dies → Cover ends (Guard on the guarder is unaffected).
//
// Hook is owned by `director.hooks` so it auto-disposes on director.stop().
// GM-only — the AE deletes need GM authority, and the director is GM-only
// in v1 anyway.
export function installGuardHpWatcher(director) {
  director.hooks.on("updateActor", async (actor, change /*, options, userId */) => {
    try {
      if (!game.user?.isGM) return;
      const newHp = foundry.utils.getProperty(change, "system.props.current_hp");
      if (newHp === undefined || newHp === null) return;
      if (Number(newHp) > 0) return;

      const dc = director.dCombat;
      if (!dc?.activeGuards?.length) return;

      // Find all entries this dying actor participates in.
      const matches = [];
      for (const g of dc.activeGuards) {
        if (g.guarderActorUuid === actor.uuid) matches.push({ entry: g, role: "guarder" });
        else if (g.coveredActorUuid === actor.uuid) matches.push({ entry: g, role: "covered" });
      }
      if (!matches.length) return;

      const toRemove = new Set();
      for (const m of matches) {
        try {
          if (m.role === "guarder") {
            // Guarder fell → release Guard on them + Covered on ally.
            if (m.entry.guarderEffectId) {
              const eff = actor.effects?.get?.(m.entry.guarderEffectId);
              if (eff) await eff.delete();
            }
            if (m.entry.coveredActorUuid && m.entry.coveredEffectId) {
              const covered = await fromUuid(m.entry.coveredActorUuid);
              if (covered) {
                const ceff = covered.effects?.get?.(m.entry.coveredEffectId);
                if (ceff) await ceff.delete();
              }
            }
            toRemove.add(m.entry);
            log(`Guard cleared: ${actor.name} fell to 0 HP`);
          } else {
            // Covered ally fell → release only Covered; Guard on guarder persists.
            if (m.entry.coveredEffectId) {
              const ceff = actor.effects?.get?.(m.entry.coveredEffectId);
              if (ceff) await ceff.delete();
            }
            m.entry.coveredActorUuid = null;
            m.entry.coveredEffectId = null;
            log(`Cover cleared: covered ally ${actor.name} fell to 0 HP (guarder's Guard persists)`);
          }
        } catch (e) { warn("Guard HP watcher: AE release failed", e); }
      }
      if (toRemove.size > 0) {
        dc.activeGuards = dc.activeGuards.filter((g) => !toRemove.has(g));
      }
    } catch (e) {
      warn("Guard HP watcher threw", e);
    }
  }, { label: "guard-hp-watcher" });
  log("Guard HP watcher installed");
}

// Install a director-scoped reaper for orphaned APPLIER-TIED AEs: when an AE's
// applier leaves the battle — DEFEATED (HP→0) or REMOVED from the combat tracker
// (deleteCombatant) — drop the default-lifetime AEs they left on others. Those
// tick down only at the START of the applier's turn (tickDirectorAEsForApplier),
// so a departed applier strands them on the bearer until the conflict-end sweep.
// reapApplierTiedAEs is narrow (skips bearer-tied / round-end / charge / permanent
// AEs), so target-resident DoTs like Burn are never dropped. Owned by
// director.hooks → auto-disposes on director.stop(). GM-only (AE deletes need
// GM authority + the director is GM-only in v1). Mirrors installGuardHpWatcher.
export function installApplierReaperWatcher(director) {
  // Defeat — HP crosses to 0 (same trigger the guard-HP watcher uses).
  director.hooks.on("updateActor", async (actor, change /*, options, userId */) => {
    try {
      if (!game.user?.isGM) return;
      const newHp = foundry.utils.getProperty(change, "system.props.current_hp");
      if (newHp === undefined || newHp === null) return;
      if (Number(newHp) > 0) return;
      await reapApplierTiedAEs(actor.uuid);
    } catch (e) { warn("Applier reaper (defeat) threw", e); }
  }, { label: "applier-reaper:defeat" });

  // Removal — the applier's combatant is deleted from the tracker.
  director.hooks.on("deleteCombatant", async (combatant /*, options, userId */) => {
    try {
      if (!game.user?.isGM) return;
      const auid = combatant?.actor?.uuid ?? null;
      if (!auid) return;
      await reapApplierTiedAEs(auid);
    } catch (e) { warn("Applier reaper (remove) threw", e); }
  }, { label: "applier-reaper:remove" });

  log("Applier reaper watcher installed");
}

// Detects when all enemy combatants are defeated and ends dCombat so the
// FSM routes to BATTLE_ENDING on the next TURN_END rather than continuing
// into the "outnumbered" path where nextTurn() never signals `ended`.
export function installEnemyWipeWatcher(director) {
  director.hooks.on("updateActor", (actor, change) => {
    try {
      if (!game.user?.isGM) return;
      const newHp = foundry.utils.getProperty(change, "system.props.current_hp");
      if (newHp === undefined || newHp === null) return;
      if (Number(newHp) > 0) return;

      const dc = director.dCombat;
      if (!dc?.started || dc.ended) return;

      const enemies = dc.combatants.filter((c) => c.side === "enemy");
      if (!enemies.length) return;
      if (!enemies.every((c) => c.isDefeatedLive())) return;

      log("EnemyWipeWatcher: all enemies defeated — ending dCombat");
      dc.end();
    } catch (e) { warn("EnemyWipeWatcher threw", e); }
  }, { label: "enemy-wipe" });

  log("Enemy wipe watcher installed");
}

// Build a short, human-readable description of an actionResult for the
// rewind history list. Lives here (not in persistence.js) because the
// actionResult shape is owned by this file — keeping the formatter
// next to the source guarantees they stay in sync when new kinds land.
//
// Returns an empty string when the kind isn't recognized; the rewind UI
// shows just the label in that case (no detail line).
// Convert a Map<resource, amount> into a plain object for freezing onto
// actionResult. (freezeActionResult deep-walks and Map iteration would
// not survive — turn it into a {resource: amount} dict.)
function serializeCostMap(costMap) {
  const out = {};
  if (!costMap?.entries) return out;
  for (const [k, v] of costMap.entries()) out[k] = v;
  return out;
}

// Resolve a Skill action. Pulled out as a top-level helper so the
// Item action can fire a linked skill via the same path (D.5 closure).
//
// Side effects (in order):
//   1. Debit cost.
//   2. Fire `on_activate_effect_ref` (skill's pre-damage hook).
//   3. For each hit target: apply HP delta (damage or AB-heal).
//   4. For each damaged target: fire `post_damage_effect_ref` with
//      per-target payload so `HP_DEALT`/`MP_DEALT` formulas resolve.
//   5. Toast.
//
// If `opts.skipCost` is true, debit is bypassed — used when the cost
// has already been paid out-of-band (e.g. Item.use consumed an item
// instead of paying MP).
// NOTE: the Item action no longer has a separate "fire linked skill" helper.
// The Item TARGET branch resolves the consumable's linked activation skill
// (item_skill_active) inline and shapes a standard actionResult from it, so it
// runs through the same COMPUTE/RESOLVE path as any Skill — with full targeting
// from the skill's skill_target and item consumption keyed off sourceItemUuid.

// Resolve the canonical "action-skill" Item that backs a built-in turn action
// (Guard / Hinder / Study / Equipment / Item). These universal Items live under
// `Battle Director / Common` and are tagged with a stable
// `flags["fabula-ultima-companion"].coreAction` value, so they're found
// regardless of world/actor inventory — no hard-coded UUID. Returns null when
// the authoring migration hasn't run on this world yet — in which case the
// Guard/Hinder/Study/Equipment RESOLVE branches pass null to resolveAction,
// which bails with a warn (the Common Item carries the action's effects, so
// there's nothing to apply without it). The Common-item delivery migration is
// the guarantee that keeps these actions working on every world.
function getCoreActionSkill(command) {
  const cmd = String(command ?? "").trim().toLowerCase();
  if (!cmd) return null;
  return game.items?.find((it) =>
    it.type === "equippableItem" &&
    (it.flags?.["fabula-ultima-companion"]?.coreAction ?? null) === cmd
  ) ?? null;
}

// The single action resolver. Every turn action (Attack/Skill/Spell/Guard/
// Hinder/Study/Item/Equipment) routes its RESOLVE through this one pipeline:
// debit cost → on_activate effect → per-target damage → post_damage effect →
// walk effect_table → queue post-resolve triggers. (Phase 7: the per-kind
// bespoke RESOLVE branches and the `resolveSkillAction` alias are retired —
// this is the only resolver.)
async function resolveAction(director, ar, opts = {}) {
  const skipCost = !!opts.skipCost;
  // Caster: prefer the explicit attackerActorRef (Skill/Spell/Attack/Item/
  // Equipment paths set it); fall back to the attacker snapshot's actorUuid
  // (the singleton TARGET branches — Guard — stamp only ar.attacker).
  const casterRef = ar.attackerActorRef ?? ar.attacker?.actorUuid ?? null;
  const casterActor = casterRef ? await fromUuid(casterRef).catch(() => null) : null;
  if (!casterActor) { warn("resolveAction: caster actor not found", casterRef); return; }
  // Backing Item: an action-skill Item passed by the caller (the singleton
  // RESOLVE branches resolve their Battle Director/Common item and hand it in
  // via opts.actionSkill), else the cast's own skill via ar.skillUuid.
  const skill = opts.actionSkill ?? (ar.skillUuid ? await fromUuid(ar.skillUuid).catch(() => null) : null);
  // ── Card-driven kinds resolve WITHOUT a backing Item ─────────────────────
  // An Attack (weaponless NPC basic attack, Twin-Shield virtual pass, unarmed
  // strike) and a Skill/Spell whose backing Item went missing (deleted,
  // unlinked, orphaned by a folder reset) both already hold their computed
  // perTargetResults on the Action Card. The card is the source of truth post-
  // creation, so we still apply that damage below — with a synthetic view and
  // the item-effect steps (on_activate / post_damage / effect_table walk)
  // skipped, since those genuinely need the Item. The singleton command actions
  // (Guard/Hinder/Study/Equipment/Item) carry ALL their behavior in the Common
  // Item — nothing to do without it — so they still bail.
  // NB: Skill AND Spell both stamp `ar.kind: "Skill"` (the Spell/Skill
  // distinction lives in the Item's skill_type, which we no longer have here);
  // the spell-only creature_completes_spell trigger (§7) is correctly skipped
  // when the Item is gone, but damage still lands.
  const CARD_DRIVEN_KINDS = new Set(["Attack", "Skill"]);
  if (!skill && !CARD_DRIVEN_KINDS.has(ar.kind)) { warn("resolveAction: backing item not found", ar.skillUuid); return; }

  // 1. Debit cost (unless an outer flow paid out-of-band).
  if (!skipCost) {
    const costMap = new Map(Object.entries(ar.costSerialized ?? {}));
    if (costMap.size > 0) {
      try {
        const debitRes = await debitCost(casterActor, costMap);
        // Spend float over the caster's token, one per resource actually
        // debited — so skill/spell casting costs animate like reaction costs.
        if (debitRes?.ok) {
          const payerTokenUuid = ar.attacker?.tokenUuid;
          for (const [resource, amount] of Object.entries(debitRes.debited ?? {})) {
            if (Number(amount) > 0) playResourceSpendVfx({ tokenUuid: payerTokenUuid, resource, amount: Number(amount) });
          }
        }
      }
      catch (e) { warn("Skill resolve: debitCost threw", e); }
    }
    // Item-action cost: a consumable "use" pays with the item itself (consume 1
    // of the source). This is the action's cost, paid uniformly here — NOT a
    // per-kind RESOLVE branch. "create" pays IP, already handled via costMap
    // above (ip is a standard cost resource). Source-driven: keyed off the
    // consumable source + the card's use/create selection, not ar.kind.
    if (ar.itemSelection?.mode === "use") {
      // Consume the SOURCE consumable (the carrier). ar.skillUuid now points at
      // the linked activation skill (skill_type "Item"), not the consumable, so
      // we re-fetch the item via sourceItemUuid. Fall back to the backing item
      // for already-skill-shaped consumables (skillUuid == the consumable).
      const sourceItem = ar.sourceItemUuid
        ? await fromUuid(ar.sourceItemUuid).catch(() => null)
        : skill;
      if (String(sourceItem?.system?.props?.item_type ?? "").toLowerCase() === "consumable") {
        try {
          const r = await consumeOne(casterActor, sourceItem);
          if (!r?.ok) warn("Item resolve: consumeOne failed", r);
        } catch (e) { warn("Item resolve: consumeOne threw", e); }
      }
    }
  }

  // 1b. negate_action (Shadow Possession's Creeped block) — the action was
  //     PERFORMED (cost paid above) but is fully NULLIFIED. We still FIRE the
  //     accepted pre-resolve reactions (so the negate reaction's OWN Frightened +
  //     consume_self land — same firing step 6 would do), then bail: skip the
  //     entire outcome (on_activate, per-target damage, post_damage, effect_table)
  //     AND every post-resolve trigger the action would fire (creature_deals_damage /
  //     completes_attack / _spell / action-kind). The card already shows "Blocked"
  //     with all per-target hits zeroed.
  if (ar.negated) {
    const accepted = Array.isArray(ar.acceptedPrePassives) ? ar.acceptedPrePassives : [];
    if (accepted.length) {
      const { firePreAcceptedCandidate } = await getSkillEffectsExtras();
      const negPayload = {
        sourceActorUuid: ar.attackerActorRef,
        sourceTokenUuid: ar.attacker?.tokenUuid ?? null,
        targetTokenUuids: (ar.targets ?? []).map((t) => t.tokenUuid),
        targets: (ar.targets ?? []).map((t) => t.tokenUuid),
        actionIntent: ar.actionIntent,
        actionKind: ar.kind ?? null,
        spellUuid: skill?.uuid ?? null,
      };
      for (const cand of accepted) {
        try {
          let fireActor = casterActor;
          let firePayload = negPayload;
          if (cand?.reactorActorUuid) {
            const resolved = await fromUuid(cand.reactorActorUuid);
            if (resolved) fireActor = resolved;
            if (cand.payloadAtFire) firePayload = cand.payloadAtFire;
          }
          await firePreAcceptedCandidate({ director, casterActor: fireActor, candidate: cand, payload: firePayload });
        } catch (e) { warn(`resolveAction(negated): prePassive "${cand?.carrierName}" threw`, e); }
      }
    }
    log(`resolveAction: ${ar.kind} by ${casterActor.name} NEGATED — fired accepted reactions, skipped outcome + post-resolve triggers`);
    return;
  }

  // 2. Build the chain ctx (recipe-merged effect_table + fire-points).
  //    `payload` carries the cast's roll-derived state so HR / CRIT /
  //    FUMBLE / TOTAL identifiers resolve correctly in on_activate
  //    formulas (e.g. Heal's recipe_amount: "HR + 5"). For no-Check
  //    skills `ar.roll` is null → identifiers fold to 0 and author
  //    formulas like "HR + 5" cleanly evaluate to the additive part.
  // Unified action view (resolveAction-unification). For skill/spell Items
  // this returns the exact same { effect_table, fire_points } the legacy
  // getRuntimeSkillView produced (it's a superset), so the Skill/Spell path
  // is unchanged. Singleton actions (Guard/Hinder/Study/Equipment) carry their
  // behavior in the same effect_table, read through this one seam.
  // Card-driven actions (weaponless Attack, Skill/Spell with a missing Item)
  // have no Item to classify — synthesize a minimal view keyed off the card's
  // own ar.kind so isAttackAction stays correct (Attack → per-target attack
  // firing; Skill → action-level firing gated on ar.hasDamage). Empty
  // effect_table / fire_points → the item-effect steps no-op; the damage loop
  // still applies ar.perTargetResults.
  const view = skill
    ? getRuntimeActionView(skill)
    : { kind: ar.kind ?? "Attack", effect_table: {}, fire_points: {}, check_mode: "opposed", roll_atrs: {}, defense_target_type: null, skill_target: "", picker: null, source: null };
  const reactorToken = canvas?.tokens?.get(ar.attacker?.tokenId)?.document ?? null;
  // Hit list. For no-Check skills `hitTokenUuids` mirrors all action
  // targets (COMPUTE stamps it that way). For Checks it's the strict
  // subset that passed vs DEF/MDEF (or all on a Crit). Drives the
  // `hit_action_targets` target_ref resolver.
  const allActionTargetUuids = (ar.targets ?? []).map((t) => t.tokenUuid);
  const hitTokenUuids = Array.isArray(ar.hitTokenUuids) ? ar.hitTokenUuids : allActionTargetUuids;
  const chainPayload = {
    targets: allActionTargetUuids,
    hitTargets: hitTokenUuids,
    hr: ar.roll?.hr ?? 0,
    isCrit: !!ar.roll?.isCrit,
    isFumble: !!ar.roll?.isFumble,
    total: ar.roll?.total ?? 0,
    actionIntent: ar.actionIntent,
    // Surfaces Vismagus's HP-alt-payment flag to chain consumers so the
    // grant effect can suppress caster self-heal.
    vismagusHpPaid: !!ar.vismagusHpPaid,
  };
  const ctx = makeChainContext({
    reactorActor: casterActor,
    reactorToken,
    skill,
    dCombat: director.dCombat,
    payload: chainPayload,
    actionTargetUuids: allActionTargetUuids,
    hitActionTargetUuids: hitTokenUuids,
    isPassive: false,
    runtimeEffectTable: view.effect_table,
    firePoints: view.fire_points,
    // Test-harness opt-in — `_harnessPicks` lives on the synthetic ar
    // built by FUCompanion.api.test.runDirectorSkillSimulate and lets
    // it auto-resolve open_action_menu prompts. Always null in live play.
    harnessPicks: ar?._harnessPicks ?? null,
    harnessNumbers: ar?._harnessNumbers ?? null,
  });
  // Thread the live action result + view onto ctx so action-level effect_kinds
  // (equip_swap, encyclopedia_record, cover-ally targeting) can read the
  // card-collected selections (ar.equipmentSelections / ar.statusValue /
  // ar.coverTarget / ar.itemSelection) without re-plumbing makeChainContext.
  // Skill/Spell effect_kinds never read these, so this is inert for them.
  ctx.actionResult = ar;
  ctx.actionView = view;
  // target_sequence — re-seed ctx.resolvedTargets with the per-ref picks made at
  // the TARGET phase so the chain's effect rows (Blazing Tether's give/take/
  // detonate) resolve their giver/receiver refs to the already-picked tokens with
  // NO re-prompt. Memoizing under each ref label = a resolveTargetRef cache hit.
  if (ar?.targetSequencePicks && typeof ar.targetSequencePicks === "object") {
    for (const [ref, uuids] of Object.entries(ar.targetSequencePicks)) {
      const tokens = [];
      for (const u of (Array.isArray(uuids) ? uuids : [])) {
        try { const td = await fromUuid(u); if (td) tokens.push(td); } catch { /* gone */ }
      }
      ctx.resolvedTargets.set(ref, { ok: tokens.length > 0, tokens });
    }
  }
  // pre_activate replay — rehydrate the choices the player made BEFORE the card
  // (COMPUTE's capture pass) so the on_activate chain replays them with NO re-
  // prompt: element vars onto _chainVars (read by deal_damage VAR_<NAME>), menu
  // picks onto capturedMenuPicksByLabel (replayed by selectMenuPicks → applied).
  if (ar?.preActivateVars && typeof ar.preActivateVars === "object") {
    ctx.payload._chainVars = { ...(ctx.payload._chainVars ?? {}), ...ar.preActivateVars };
  }
  if (ar?.preActivateMenuPicks && typeof ar.preActivateMenuPicks === "object") {
    ctx.capturedMenuPicksByLabel = { ...ar.preActivateMenuPicks };
  }

  // Battle-log sink for THIS action: every commit (hits, via applyDamageToTarget's
  // logContext) + every miss (below) + any deal_damage riders fired through this
  // ctx push their {entry,row} here; we flush ONCE at the end → a Multi-N action
  // is one write, not N. Threaded onto ctx so rider effects coalesce too.
  const battleLogSink = [];
  ctx.battleLogSink = battleLogSink;

  // 3. Fire on_activate effect (pre-damage, no damage payload).
  try {
    const r = await fireActivationEffect(skill, ctx);
    if (r?.abort) {
      log(`Skill resolve: on_activate aborted chain — skipping damage + post_damage`);
      return;
    }
  } catch (e) { warn("Skill resolve: fireActivationEffect threw", e); }

  // 4. Apply damage per target (mirrors Attack RESOLVE) + fire
  //    post_damage_effect_ref with per-target payload so HP_DEALT etc.
  //    formula identifiers resolve correctly.
  //
  //    Resource branch: HP damage takes the regular affinity-aware
  //    path (with AB → heal flip). MP damage burns current_mp on hit
  //    with NE affinity (set in COMPUTE — no elemental mutation).
  //    The post_damage payload's `valueType` is set per-branch so
  //    HP_DEALT vs MP_DEALT resolve correctly in formulas.
  const dmgResource = ar.damageResource ?? "hp";
  const hits = (ar.perTargetResults ?? []);
  // ── Card-normalized "is this a damaging attack?" — decided ONCE, never
  // re-derived from a weapon item at apply time. The Action Card is the
  // source of truth post-creation: an action is an Attack if its action
  // kind (ar.kind) OR its source classification (view.kind) says so —
  // covering weaponless monster basic attacks, Twin-Shield virtual passes,
  // and `skill_type: "attack"` skills, all of which carry computed
  // perTargetResults that must be applied even though no weapon item backs
  // them. A Skill/Spell deals damage when COMPUTE set ar.hasDamage.
  const isAttackAction = ar.kind === "Attack" || view.kind === "Attack";
  const isDamagingAction = isAttackAction || !!ar.hasDamage;
  if (isDamagingAction && hits.length) {
    // Multi-pass label (Attack two-weapon / virtual): "(pass 2/2)".
    const passLabel = (ar.totalPasses ?? 1) > 1 ? ` (pass ${ar.passIndex}/${ar.totalPasses})` : "";
    for (const r of hits) {
      // Pierce keyword (action-agnostic): a pierce-miss still deals its
      // (COMPUTE-reduced) damage; only a plain miss whiffs. r.pierceMiss is set
      // in COMPUTE for ANY action carrying Pierce — not just Attack.
      if (!r.hit && !r.pierceMiss) {
        playMissVfx({ tokenUuid: r.tokenUuid });
        // Whiff → a Miss row (no commit, so logged here, not at the seam).
        battleLogSink.push(buildMissRow({
          attackerName: casterActor.name,
          targetName: r.name,
          element: ar.damageType ?? "elementless",
          accuracy: ar.roll?.total ?? null,
          weaponType: ar.weapon?.weaponType ?? null,
          range: ar.weapon?.range ?? ar.weapon?.weapon_range ?? null,
          sourceType: isAttackAction ? "Attack" : (view.kind ?? "Skill"),
        }));
        continue;
      }
      try {
        const targetActor = await fromUuid(r.actorUuid).catch(() => null);
        if (!targetActor) { warn("Skill resolve: target actor not found", r.actorUuid); continue; }

        // Vismagus self-heal suppression — if the caster paid HP for the
        // spell via Vismagus, they do NOT recover HP from this spell
        // (other targets unaffected). Per RAW Spiritist p.182.
        if (ar.vismagusHpPaid && r.actorUuid === ar.attackerActorRef) {
          log(`Skill ${ar.skillName}: Vismagus suppresses caster self-heal for ${r.name}`);
          continue;
        }

        // Shared damage-write path. Handles MP-resource, AB → heal flip,
        // resolveDamageReactions (Mercy + future clamp/cap AEs), and the
        // log line. See applyDamageToTarget in skill-effects.js.
        const dmgRes = await applyDamageToTarget({
          target: targetActor,
          damage: r.damage,
          affinity: r.affinity,
          resource: dmgResource,
          targetName: r.name,
          tokenUuid: r.tokenUuid,
          logPrefix: `${view.kind} ${ar.skillName ?? skill?.name ?? ""}:`,
          logSuffix: passLabel + (r.pierceMiss ? " [Pierce]" : ""),
          // Battle Log: hit row, pushed to this action's shared sink (flushed
          // once at the end). Rich attacker context from the action result.
          // (`efficiency` is omitted → the row shows 100%. The BD does NOT apply
          // weapon efficiency at all today — neither action-profile nor the
          // incoming ruleset — so 100% honestly reflects current behavior. If
          // weapon efficiency lands (target-side, gated on weaponType), surface
          // the real % here too. See the damage-unification Phase-6 note.)
          logContext: {
            attackerName: casterActor.name,
            element: ar.damageType ?? "elementless",
            weaponType: ar.weapon?.weaponType ?? null,
            range: ar.weapon?.range ?? ar.weapon?.weapon_range ?? null,
            accuracy: ar.roll?.total ?? null,
            isCrit: !!ar.roll?.isCrit,
            sourceType: isAttackAction ? "Attack" : (view.kind ?? "Skill"),
            sink: battleLogSink,
          },
        });
        const finalValue = dmgRes.finalValue;
        const valueType = dmgRes.resource;
        const valueDirection = dmgRes.valueDirection;
        const damageTypeForPayload = valueDirection === "recover" ? "healing" : ar.damageType;

        // Per-target post_damage payload — HP_DEALT / MP_DEALT resolve
        // here. Roll-derived identifiers (HR / CRIT / FUMBLE / TOTAL)
        // carry through too so post_damage formulas can reference both
        // the damage just dealt AND the cast roll that produced it.
        const damagePayload = {
          targets: [r.actorUuid],
          targetUuid: r.actorUuid,
          targetTokenUuid: r.tokenUuid,
          sourceTokenUuid: ar.attacker?.tokenUuid,
          sourceActorUuid: ar.attackerActorRef,
          finalValue,
          valueType,
          valueDirection,
          damageType: damageTypeForPayload,
          actionIntent: ar.actionIntent,
          hr: ar.roll?.hr ?? 0,
          isCrit: !!ar.roll?.isCrit,
          isFumble: !!ar.roll?.isFumble,
          total: ar.roll?.total ?? 0,
        };
        try { await firePostDamageEffect(skill, ctx, damagePayload); }
        catch (e) { warn("Skill resolve: firePostDamageEffect threw", e); }

        // Part 1 — unified resource-ledger trigger. Fire creature_lose_resource /
        // creature_gain_resource on the creature whose HP/MP just changed (cause:
        // "damage"). Queued (post-save) + supervised. Part 2's crisis reactor
        // listens here (resource=hp); any "when my <resource> changes" skill too.
        fireResourceChangeTrigger({
          director, actor: targetActor, tokenUuid: r.tokenUuid,
          resource: valueType, direction: valueDirection, amount: finalValue,
          cause: "damage",
          source: { actorUuid: ar.attackerActorRef, tokenUuid: ar.attacker?.tokenUuid ?? null },
          // Itemized identity + "how it changed" context (the attack site has the
          // full action result; the tick site can't supply weapon/roll fields).
          element: damageTypeForPayload,                     // fire/ice/… (recover → "healing")
          originLabel: ar.skillName ?? skill?.name ?? null,  // the attack/skill that dealt it
          originUuid: skill?.uuid ?? null,
          weaponType: ar.weapon?.weaponType ?? null,
          weaponRange: ar.weapon?.range ?? ar.weapon?.weapon_range ?? null,
          actionKind: view?.kind ?? null,
          actionIntent: ar.actionIntent ?? null,
          isCrit: !!ar.roll?.isCrit,
          isFumble: !!ar.roll?.isFumble,
          accuracyTotal: ar.roll?.total ?? null,
          highRoll: ar.roll?.hr ?? null,
          pierce: !!r.pierceMiss,
        });

        // Drain keyword (Tinkerer Vampire infusion / Keyword Repository): the
        // ATTACKER recovers HP equal to HALF the HP damage this hit dealt. Only
        // on real outgoing HP damage (not a heal/MP/absorb), and never self-drain.
        // Heals via the AB path (caps at max HP) and queues a heal resource event
        // so Crisis-recovery / On-the-Hunt see it. The keyword rides the per-target
        // entry from recomputePerTargetDamages (apply_action_keyword "drain").
        if (
          Array.isArray(r.keywords) && r.keywords.includes("drain") &&
          valueType === "hp" && valueDirection === "loss" && finalValue > 0 &&
          casterActor && r.actorUuid !== ar.attackerActorRef
        ) {
          const healAmt = Math.floor(finalValue / 2);
          if (healAmt > 0) {
            try {
              const drainRes = await applyDamageToTarget({
                target: casterActor, damage: healAmt, affinity: "AB", resource: "hp",
                targetName: casterActor.name, tokenUuid: ar.attacker?.tokenUuid ?? null,
                logPrefix: `${view.kind} ${ar.skillName ?? skill?.name ?? ""}:`, logSuffix: " [Drain]",
                logContext: {
                  attackerName: casterActor.name, element: "healing",
                  sourceType: isAttackAction ? "Attack" : (view.kind ?? "Skill"),
                  sink: battleLogSink,
                },
              });
              fireResourceChangeTrigger({
                director, actor: casterActor, tokenUuid: ar.attacker?.tokenUuid ?? null,
                resource: "hp", direction: "recover", amount: drainRes.finalValue, cause: "heal",
                source: { actorUuid: ar.attackerActorRef, tokenUuid: ar.attacker?.tokenUuid ?? null },
                originLabel: "Drain", originUuid: skill?.uuid ?? null,
              });
              log(`Drain: ${casterActor.name} recovered ${drainRes.finalValue} HP (50% of ${finalValue} dealt to ${r.name})`);
            } catch (e) { warn("Skill resolve: drain self-heal threw", e); }
          }
        }
      } catch (e) {
        err("Skill resolve: damage application failed", r, e);
      }
    }
  }

  // 5b. Miss VFX for Check-only skills (no damage — e.g. Zarg's Soul Steal).
  //     These skip the damage loop above (it's gated on ar.hasDamage), so a
  //     failed Check would otherwise show no whiff. Fire the Miss flourish for
  //     each non-hit target. Gated on ar.isCheck because non-check skills
  //     auto-hit (every perTargetResults entry is hit:true) — nothing to miss.
  if (!ar.hasDamage && ar.isCheck && hits.length) {
    for (const r of hits) {
      if (!r.hit) playMissVfx({ tokenUuid: r.tokenUuid });
    }
  }

  // 6. Pre-resolve accepted passives — fire any pill-accepted passives
  //    the CONFIRM step stamped on the actionResult (Healing Power /
  //    Support Magic / future "during action card" reactions). These
  //    were evaluated BEFORE the player clicked Confirm so they
  //    manipulate the action's effective result. The post-resolve
  //    `creature_completes_spell` dispatch below skips any candidate
  //    already evaluated here to avoid double-fire.
  const _hitList = Array.isArray(ar.hitTokenUuids) ? ar.hitTokenUuids : (ar.targets ?? []).map((t) => t.tokenUuid);
  const payloadForPassives = {
    spellUuid: skill?.uuid ?? null,
    spellName: skill?.name ?? ar.skillName ?? "Attack",
    targetTokenUuids: (ar.targets ?? []).map((t) => t.tokenUuid),
    hitTargetTokenUuids: _hitList,
    // `hitTargets` is the canonical key that skill-targeting.js's
    // `hit_action_targets` resolver reads — needed for reactions like
    // Vanish that target each hit creature via target_ref.
    hitTargets: _hitList,
    targets: (ar.targets ?? []).map((t) => t.tokenUuid),
    sourceTokenUuid: ar.attacker?.tokenUuid ?? null,
    sourceActorUuid: ar.attackerActorRef,
    actionIntent: ar.actionIntent,
    // Action type on every post-resolve reaction payload so reactions can
    // filter by kind (e.g. "react when a creature uses an Item"). Mirrors the
    // actionKind already carried on the pre-resolve creature_targeted_by_action
    // payload. Item-use reactions read this off creature_completes_item (§8b).
    actionKind: ar.kind ?? null,
    // Acting skill/weapon name for `reaction_source_skill` self-scoping
    // (replaces the removed skill_type item-gate).
    sourceSkillName: skill?.name ?? ar.skillName ?? ar.weapon?.name ?? null,
  };
  const accepted = Array.isArray(ar.acceptedPrePassives) ? ar.acceptedPrePassives : [];
  if (accepted.length) {
    const { firePreAcceptedCandidate } = await getSkillEffectsExtras();
    for (const cand of accepted) {
      try {
        // Hit-gated reactions (creature_will_deal_damage: Warning Shot, Cheap
        // Shot, …) carry `appliesToTargetUuids` = the targets actually hit.
        // When that's empty, the attack connected with nobody this reaction
        // applies to, so skip firing entirely — no chain, no cost, no effect.
        // RAW: Warning Shot only "counts" on a hit; ≥1 hit fires once for all
        // hit targets via the chain's hit_action_targets refs. (Other reaction
        // families — Protect, completes_spell — never set this field, so they
        // are unaffected.)
        if (Array.isArray(cand?.appliesToTargetUuids) && cand.appliesToTargetUuids.length === 0) {
          log(`resolveAction: prePassive "${cand?.carrierName}" not fired — 0 hit targets (no cost/effect)`);
          continue;
        }
        // Third-party reactions (Protect on an Attack(ally) card) carry
        // `reactorActorUuid` identifying whose chain this is. Route the
        // firing to the reactor's actor and use the per-candidate
        // payload snapshot taken at CONFIRM (so the matcher's subject /
        // disposition / intent context survives across the user's Apply
        // click). Default: action-taker (existing behavior).
        let fireActor = casterActor;
        let firePayload = payloadForPassives;
        if (cand?.reactorActorUuid) {
          const resolved = await fromUuid(cand.reactorActorUuid);
          if (resolved) fireActor = resolved;
          if (cand.payloadAtFire) firePayload = cand.payloadAtFire;
        }
        await firePreAcceptedCandidate({
          director, casterActor: fireActor, candidate: cand, payload: firePayload,
        });
      } catch (e) { warn(`Skill resolve: prePassive "${cand?.carrierName}" threw`, e); }
    }
  }

  // 6b. Post-damage passive trigger — `creature_deals_damage` fires once
  //     per Skill cast with the hit-target list. Reactor is the caster;
  //     reactions filter by `reaction_source: "self"`. Used by Vanish-
  //     style "after dealing damage" reactions that apply AEs to each
  //     hit creature via target_ref: "hit_action_targets". Gated on
  //     ar.hasDamage so non-damage skills (Heal, Reinforce) don't fire it.
  //
  // QUEUED, not fired, so the trigger runs AFTER RESOLVE's actor-snapshot
  // save site. Otherwise reaction-applied AEs (e.g. Vanish) land BEFORE
  // the "After X's Action" rewind anchor, requiring two rewinds to
  // undo them. See [[reaction-architecture]].
  if (isAttackAction) {
    // Attack fires `creature_deals_damage` PER hit/pierce target so per-target
    // gates resolve against the right creature: weapon on-hit keywords
    // (Conquer `HIT_MARGIN >= N`, poison `chance()`) are gated by THIS target's
    // hitMargin, and `weaponReactionInPlay` matches the acting weapon via
    // `weaponUuid`. This is the exact payload the legacy Attack RESOLVE branch
    // queued — routing Attack through resolveAction reproduces it. Skills keep
    // the single action-level fire below (per-target firing for skills would
    // make `hit_action_targets` reactions like Vanish over-apply — that's a
    // later keyword-layer follow-up, not this foundation).
    const struck = hits.filter((r) => r.hit || r.pierceMiss);
    if (struck.length) {
      const allTargetUuids = (ar.targets ?? []).map((t) => t.tokenUuid);
      const struckTokenUuids = struck.map((r) => r.tokenUuid);
      for (const r of struck) {
        queuePostResolveTrigger(director, {
          casterActor,
          trigger: "creature_deals_damage",
          payload: {
            targets: allTargetUuids,
            targetTokenUuids: allTargetUuids,
            hitTargets: struckTokenUuids,
            hitTargetTokenUuids: struckTokenUuids,
            subjectTokenUuid: r.tokenUuid,
            subjectActorUuid: r.actorUuid,
            actionIntent: ar.actionIntent,
            // Acting skill/weapon name for `reaction_source_skill` self-scoping.
            sourceSkillName: ar.skillName ?? ar.weapon?.name ?? null,
            weaponUuid: ar.weapon?.uuid ?? null,
            // Melee/ranged/arcane class of the acting weapon — drives the
            // ATTACK_IS_RANGED / ATTACK_IS_MELEE formula gates (Warning Shot,
            // ranged-only on-hit reactions). Mirrors the field on the
            // pre-resolve creature_will_deal_damage payload.
            weaponType: ar.weapon?.weaponType ?? null,
            weaponRange: ar.weapon?.range ?? ar.weapon?.weapon_range ?? null,
            sourceActorUuid: ar.attackerActorRef,
            sourceTokenUuid: ar.attacker?.tokenUuid ?? null,
            total: ar.roll?.total ?? 0,
            hr: ar.roll?.hr ?? 0,
            isCrit: !!ar.roll?.isCrit,
            isFumble: !!ar.roll?.isFumble,
            // HIT_MARGIN = accuracy total − THIS target's defense (r.defense
            // already encodes DEF vs MDEF). Drives "Conquer N".
            hitMargin: (Number(ar.roll?.total ?? 0) || 0) - (Number(r.defense ?? 0) || 0),
          },
        });
      }
      // One-shot post-attack trigger — fires after all per-target
      // creature_deals_damage fires. Carries allTargetsHit so passives
      // like Blazing Sweep's "repeat if all hit" can gate on a single
      // clean event without per-target multi-fire.
      queuePostResolveTrigger(director, {
        casterActor,
        trigger: "creature_completes_attack",
        payload: {
          targets: allTargetUuids,
          targetTokenUuids: allTargetUuids,
          hitTargets: struckTokenUuids,
          hitTargetTokenUuids: struckTokenUuids,
          allTargetsHit: struckTokenUuids.length >= allTargetUuids.length && allTargetUuids.length > 0,
          sourceActorUuid: ar.attackerActorRef,
          sourceTokenUuid: ar.attacker?.tokenUuid ?? null,
          actionIntent: ar.actionIntent,
          weaponUuid: ar.weapon?.uuid ?? null,
          // Acting skill/weapon name for `reaction_source_skill` self-scoping.
          sourceSkillName: ar.skillName ?? ar.weapon?.name ?? null,
        },
      });
    }
  } else if (ar.hasDamage && hits.some((r) => r.hit)) {
    queuePostResolveTrigger(director, {
      casterActor,
      trigger: "creature_deals_damage",
      payload: payloadForPassives,
    });
  }

  // 7. Post-resolve creature_completes_spell dispatch (legacy fallback
  //    + any candidates that weren't evaluated pre-resolve — e.g. an
  //    "off"-mode passive that the pre-eval correctly auto-rejected but
  //    that a player wants to keep available if they flip the mode mid-
  //    session). We pass `skipEvaluated` so firePassiveTriggers can
  //    suppress candidates already handled. Spell-only: non-Spell
  //    actions don't fire this trigger. Queued for post-save firing
  //    same as creature_deals_damage.
  if (String(skill?.system?.props?.skill_type ?? "").toLowerCase() === "spell") {
    const evaluated = Array.isArray(ar.evaluatedPrePassives) ? ar.evaluatedPrePassives : [];
    queuePostResolveTrigger(director, {
      casterActor,
      trigger: "creature_completes_spell",
      payload: payloadForPassives,
      skipEvaluated: evaluated,
    });
  }

  // 7b. Post-resolve creature_completes_item dispatch — fires once after a
  //     creature USES an item (the Item action), so reactions can hook
  //     "when a creature uses an item" (e.g. an ally's counter to a thrown
  //     item, a self-buff on quaffing). Item-only; payload carries actionKind.
  //     Queued for post-save firing, same as the other completion triggers.
  if (ar.kind === "Item") {
    queuePostResolveTrigger(director, {
      casterActor,
      trigger: "creature_completes_item",
      payload: payloadForPassives,
    });
  }

  // 8. Action-kind post-resolve triggers (resolveAction-unification). These
  //    mirror the bespoke RESOLVE branches' trailing trigger dispatches so the
  //    per-kind branch can collapse to a single resolveAction call. Keyed off
  //    the unified view's kind; inert for Skill/Spell/Attack.
  if (view.kind === "Guard") {
    // Bodyguard (Guardian Core RAW p.197) listens on `creature_guards` with
    // `didCoverAlly === true`. Canonical payload field names: sourceActorUuid
    // identifies the guarder (matcher's reaction_source="self" reads it).
    const cov = ar.coverTarget;
    const coveredTokenUuids = cov ? [cov.tokenUuid] : [];
    queuePostResolveTrigger(director, {
      casterActor,
      trigger: "creature_guards",
      payload: {
        sourceActorUuid:      casterActor.uuid,
        sourceTokenUuid:      ar.attacker?.tokenUuid ?? null,
        guarderActorUuid:     casterActor.uuid,
        guarderTokenUuid:     ar.attacker?.tokenUuid ?? null,
        didCoverAlly:         !!cov,
        coveredAllyUuid:      cov?.actorUuid ?? null,
        coveredAllyTokenUuid: cov?.tokenUuid ?? null,
        targets:              coveredTokenUuids,
        targetTokenUuids:     coveredTokenUuids,
      },
    });
  }

  // 9. Flush this action's Battle Log in ONE write — Multi-N action = one
  //    row-batch, not N. Hits were pushed by applyDamageToTarget's logContext,
  //    misses in the damage loop, and any deal_damage riders via the shared
  //    ctx.battleLogSink. Last step so it captures the whole action.
  if (battleLogSink.length) await appendBattleLog(battleLogSink);
}

// Stash a passive-trigger config in ctx so RESOLVE.onEnter's tail can
// fire it AFTER the actor-snapshot save site. Per-action queue —
// cleared at the end of RESOLVE. Each entry is the same shape that
// `firePassiveTriggers` accepts (minus the director arg).
function queuePostResolveTrigger(director, config) {
  if (!director?.ctx) return;
  if (!Array.isArray(director.ctx._postResolveTriggers)) {
    director.ctx._postResolveTriggers = [];
  }
  director.ctx._postResolveTriggers.push(config);
}

// Extract a formula-evaluable target count from a free-text
// `skill_target` field.
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

function describeActionForRewind(ar) {
  if (!ar) return "";
  const attName = ar.attacker?.name ?? "?";
  switch (ar.kind) {
    case "Attack": {
      const wep = ar.weapon?.name ?? "weapon";
      const passTag = (ar.totalPasses ?? 1) > 1
        ? `pass ${ar.passIndex}/${ar.totalPasses} `
        : "";
      const hits = (ar.perTargetResults ?? []).filter((r) => r.hit);
      if (!hits.length) {
        const names = (ar.targets ?? []).map((t) => t.name).join(", ") || "target";
        if (ar.roll?.isFumble) return `${attName} fumbled ${wep} on ${names}`;
        return `${attName} ${passTag}missed ${names} with ${wep}`;
      }
      const dmgParts = hits.map((r) => {
        const tag = r.affinity === "AB" ? `+${r.damage} HP` : `${r.damage} dmg`;
        return `${r.name} ${tag}${r.crit ? "!" : ""}`;
      });
      return `${attName} ${passTag}attacked with ${wep} — ${dmgParts.join(", ")}`;
    }
    case "Guard":
      return ar.coverTarget
        ? `${attName} guarded (covering ${ar.coverTarget.name})`
        : `${attName} guarded`;
    case "Equipment":
      return `${attName} swapped equipment`;
    case "Item": {
      const sel = ar.itemSelection;
      if (!sel) return `${attName} (Item, no selection)`;
      if (sel.mode === "use") {
        const cand = (ar.itemCandidates?.use ?? []).find((c) => c.id === sel.key);
        return `${attName} used ${cand?.name ?? "an item"}`;
      }
      if (sel.mode === "create") {
        const cand = (ar.itemCandidates?.create ?? []).find((c) => c.key === sel.key);
        return `${attName} crafted ${cand?.name ?? "an item"}`;
      }
      return `${attName} (Item)`;
    }
    case "Hinder":
      if (!ar.success) return `${attName} failed to Hinder ${ar.target?.name ?? "target"}`;
      // The specific status is chosen in the post-confirm menu (RESOLVE) and
      // shows as an AE chip on the target — keep the summary status-agnostic.
      return `${attName} hindered ${ar.target?.name ?? "target"}`;
    case "Study":
      if (ar.roll?.isFumble) return `${attName} fumbled Study on ${ar.target?.name ?? "target"}`;
      return `${attName} studied ${ar.target?.name ?? "target"} (${ar.tier?.name ?? "?"})`;
    case "Skill": {
      const skillName = ar.skillName ?? "Skill";
      const targetNames = (ar.targets ?? []).map((t) => t.name).join(", ") || "target";
      if (ar.hasDamage && Array.isArray(ar.perTargetResults) && ar.perTargetResults.length) {
        const hits = ar.perTargetResults.filter((r) => r.hit);
        if (!hits.length) {
          if (ar.roll?.isFumble) return `${attName} fumbled ${skillName} on ${targetNames}`;
          return `${attName} missed ${targetNames} with ${skillName}`;
        }
        const dmgParts = hits.map((r) => {
          const tag = r.affinity === "AB" ? `+${r.damage} HP` : `${r.damage} dmg`;
          return `${r.name} ${tag}${r.crit ? "!" : ""}`;
        });
        return `${attName} cast ${skillName} — ${dmgParts.join(", ")}`;
      }
      return `${attName} cast ${skillName} on ${targetNames}`;
    }
    default:
      return `${attName} (${ar.kind ?? "?"})`;
  }
}

// ─── PREP ──────────────────────────────────────────────────────────────
// Runs the full pre-combat pipeline: curtain raise, encounter / party
// resolution, scene activate, layout, hidden token spawn, asset preload,
// curtain drop, entrance animation, Combat doc create + combatant add +
// initiative roll + startCombat.
//
// On success, sets director.dCombat (via _setDirectorCombat) and
// INTERNAL_DONE transitions to ROUND_START. No Foundry Combat doc is created
// in director mode — dCombat is the sole authority.
//
// On failure (resolveScene fails, both party + enemies empty, network
// timeout during preload, etc.), sets ctx.abortReason and dispatches
// ABORT. The transition table routes ABORTED → STOPPED when combat
// hasn't started, so the boot's cleanup runs without trying to advance
// any turns.
const Prep = {
  async onEnter(director) {
    const payload = director.ctx.payload;
    if (!payload) {
      warn("PREP entered without a payload — aborting");
      director.ctx.abortReason = "no payload";
      director.enqueue({ type: INTENTS.ABORT });
      return;
    }
    // Capture A: pre-battle viewport — synchronous, before runDirectorInit switches scenes.
    // Uses live PIXI stage values which are always accurate unlike _viewPosition.
    try {
      const _px = canvas?.stage?.pivot?.x;
      const _py = canvas?.stage?.pivot?.y;
      const _ps = canvas?.stage?.scale?.x;
      if (typeof _px === "number" && typeof _ps === "number") {
        game.settings.set("fabula-ultima-companion", "bdPreBattleViewport", {
          x: _px, y: _py, scale: _ps, sceneId: canvas.scene?.id ?? null,
        });
      }
    } catch (_) {}

    log("PREP: running director-owned battle init");
    let result = null;
    try {
      result = await runDirectorInit(payload);
    } catch (e) {
      err("PREP: runDirectorInit threw", e);
      director.ctx.abortReason = `prep threw: ${e?.message ?? e}`;
      ui.notifications?.error?.(`Battle Director prep failed: ${e?.message ?? e}`);
      director.enqueue({ type: INTENTS.ABORT });
      return;
    }
    if (!result?.dCombat) {
      warn("PREP: runDirectorInit returned no dCombat");
      director.ctx.abortReason = "no dCombat produced";
      director.enqueue({ type: INTENTS.ABORT });
      return;
    }
    // Hand the director-owned DirectorCombat to the FSM. From this point
    // forward all turn/round/current decisions read `director.dCombat`.
    director._setDirectorCombat(result.dCombat);

    // Capture B: battle scene initial viewport — canvas is now on the battle scene,
    // nothing has panned yet. Stored so transition can reset it after FX camera pan.
    try {
      const _bx = canvas?.stage?.pivot?.x;
      const _by = canvas?.stage?.pivot?.y;
      const _bs = canvas?.stage?.scale?.x;
      if (typeof _bx === "number" && typeof _bs === "number") {
        game.settings.set("fabula-ultima-companion", "bdBattleSceneViewport", {
          x: _bx, y: _by, scale: _bs, sceneId: canvas.scene?.id ?? null,
        });
      }
    } catch (_) {}

    // Install lifecycle watchers that need dCombat in place. Owned by
    // director.hooks → auto-disposed on director.stop().
    installGuardHpWatcher(director);
    // Reap orphaned applier-tied AEs when an applier is defeated/removed.
    installApplierReaperWatcher(director);
    // End dCombat when all enemies are wiped so TURN_END routes to BATTLE_ENDING.
    installEnemyWipeWatcher(director);
    // Rewind tool: buffer item deletions between snapshots so the
    // rewind UI can recreate consumed items. See [[director-rewind-tool-plan]].
    installItemDeletionTracker(director);
    // Pre-compute EXP/Zenit rewards while all enemy tokens are guaranteed live.
    // Stored in a world setting so it survives F5; read at BATTLE_ENDING to
    // pre-fill the GM prompt.
    try {
      const _isBoss = !!(director.ctx.payload?.battlePlan?.isBoss) ||
        String(director.ctx.payload?.battlePlan?.type ?? "").toLowerCase() === "boss";
      const _snap = await computeBattleEndRewards(director.dCombat, _isBoss);
      game.settings.set("fabula-ultima-companion", "bdRewardSnapshot", _snap);
    } catch (e) { warn("PREP: reward pre-compute failed (prompt will default to 0)", e); }
    log(`PREP done: dCombat ${result.dCombat.id} with ${result.partyTokens} party + ${result.enemyTokens} enemies, sourceScene=${result.dCombat?.sourceSceneId ?? "(none)"}`);
    // Clear any leftover state/history from a prior battle that didn't
    // shut down cleanly. The director's stop() + the BattleEnd Cleanup
    // macro both clear these flags, but if BOTH were bypassed (crash,
    // legacy-flow BattleEnd while director was running, etc.) the new
    // battle would prepend its first save onto stale rewind history
    // from a dead battle. Sweep here before checkpoint #1 to guarantee
    // a clean slate. Await so the save below races nothing.
    try { await clearAllDirectorStateFlags(); }
    catch (e) { warn("PREP: clearAllDirectorStateFlags threw", e); }

    // Persistence checkpoint #1 — first save once dCombat is built.
    // Fire-and-forget; a failed write logs but doesn't abort the FSM.
    // Label describes the state the GM will land IN on rewind: the
    // very first turn-picker (or auto-pick → DECLARE) for round 1.
    saveDirectorState(director, {
      label: `Battle Start`,
      description: `${result.partyTokens} party vs ${result.enemyTokens} enem${result.enemyTokens === 1 ? "y" : "ies"} — choose first turn`,
    }).catch((e) => warn("PREP: saveDirectorState failed", e));

    // Hand off to STANDALONE_REACTION_WINDOW for conflict_start dispatch.
    // The new state owns the dispatch + idempotency persistence so PREP
    // doesn't directly block on menus — clean state separation per the
    // A+B retrospective. After standalone resolves, FSM proceeds to
    // ROUND_START.
    director.ctx.standaloneTrigger = "conflict_start";
    director.ctx.standaloneAfter   = STATES.ROUND_START;
    director.ctx.standalonePayload = null;
    director.enqueue({ type: INTENTS.INTERNAL_DONE });
  },
};

// ─── ROUND_START ───────────────────────────────────────────────────────
// In v1 nothing happens here; we just advance. Real implementation would
// drain round-start reaction triggers.
const RoundStart = {
  async onEnter(director) {
    director.ctx.endOfRound = false;
    director.ctx.endOfCombat = false;
    // First-round bump. dCombat.start() leaves round=0 (the pre-combat
    // / conflict_start phase). The first ROUND_START transitions us
    // into Round 1; subsequent ROUND_STARTs (after a wrap) see round
    // already incremented by nextTurn() and leave it alone.
    if (director.dCombat && (director.dCombat.round ?? 0) === 0) {
      director.dCombat.round = 1;
    }
    const roundNo = director.dCombat?.round ?? director.combat?.round ?? 0;
    log(`ROUND_START — round ${roundNo}`);

    // Start-of-round cinematic banner ("ROUND N" + Critical_1 SFX). Fire-and-
    // forget so the ~2.5s flourish overlays the next state rather than
    // blocking the FSM. Broadcasts to all clients.
    if (roundNo > 0) playRoundBanner({ round: roundNo });

    // Hand off to STANDALONE_REACTION_WINDOW for round_start. The
    // transition rule branches on endOfCombat: if combat is over,
    // skip reactions and go straight to STOPPED. Otherwise, route
    // through STANDALONE_REACTION_WINDOW which lands at TURN_START.
    director.ctx.standaloneTrigger = "round_start";
    director.ctx.standaloneAfter   = STATES.TURN_START;
    director.ctx.standalonePayload = null;
    director.enqueue({ type: INTENTS.INTERNAL_DONE });
  },
};

// Grappled break-free — free action at the start of a Grappled unit's turn
// (RAW in-world Journal "Grappled", mechanic #3). The unit may make a DL 10
// Check using any attribute pair that contains at least one MIG or DEX die;
// success removes Grappled. Mirrors the Hinder check flow: the GM picks the
// pair + DL via pickAttributePair, we roll 1dA+1dB with the same crit/fumble
// semantics, and the dice land in chat (a free check has no action card).
//
// Optional: Cancel on the picker = the unit declines the attempt. The DL 10
// check stays free — it does NOT consume a turn action. The Objective-action
// reattempt (mechanic #4) is deferred until the Objective action ships.
// Grappler stamp + helpers live in grappled.js; see [[project_grappled_advanced_debuff]].
async function maybeRunBreakFree(director, snap) {
  try {
    if (!snap?.actorUuid && !snap?.tokenUuid) return;
    // Token-first resolution: unlinked NPC tokens carry their Grappled AE on
    // the token-delta (synthetic) actor; the token uuid is the stable handle
    // (the synthetic actor uuid can be brittle). Falls back to actorUuid for
    // linked PCs. Mirrors the persistence/rewind actor-resolution order.
    let actor = null;
    if (snap.tokenUuid) actor = (await fromUuid(snap.tokenUuid).catch(() => null))?.actor ?? null;
    if (!actor && snap.actorUuid) actor = await fromUuid(snap.actorUuid).catch(() => null);
    if (!actor || !isGrappled(actor)) return;
    if (director?.ctx?.endOfCombat) return; // battle ending, skip break-free picker

    const _bfPromise = pickAttributePair({
      director,
      titleText: `${snap.name}: Break Free?`,
      subtitle: `Free action. DL 10 Check — the pair must include at least one MIG or DEX die (RAW). Cancel to skip.`,
      defaults: { A1: "MIG", A2: "DEX" },
      includeDL: true,
      defaultDL: 10,
    });
    const _bfInterrupt = director?._battleEndInterruptPromise ?? null;
    const cfg = _bfInterrupt
      ? await Promise.race([_bfPromise, _bfInterrupt.then(() => ({ ok: false }))])
      : await _bfPromise;
    if (!cfg.ok) { log(`Break Free: ${snap.name} declined the attempt`); return; }

    const A1 = cfg.A1;
    const A2 = cfg.A2;
    const DL = Math.max(1, Number(cfg.dl) || 10);
    // BD-canonical check (roll + prop-aware crit/fumble) + vs-DL comparison.
    const check = await rollCheck({ actor, A1, A2 });
    const { rA, rB, dA, dB, total, isFumble, isCrit } = check;
    const { success } = checkVsThreshold(check, DL);

    let removed = 0;
    if (success) {
      removed = await breakFree(actor, { reason: "turn-start check" });
    }
    log(`Break Free: ${snap.name} ${success ? "SUCCEEDED" : "FAILED"} ` +
        `(${A1} d${dA}=${rA} + ${A2} d${dB}=${rB} = ${total} vs DL ${DL}` +
        `${isCrit ? ", CRIT" : isFumble ? ", FUMBLE" : ""}) — removed ${removed} Grappled AE(s)`);

    // Surface the check to chat. The director resolves actions through its own
    // cards and normally stays out of chat, but a free turn-start check has no
    // card — chat gives the table the dice (Dice So Nice) + a clear outcome.
    const outcome = isCrit ? "Critical success — breaks free!"
      : isFumble ? "Fumble — still Grappled."
      : success ? "Breaks free!"
      : "Fails — still Grappled.";
    const flavor =
      `<strong>Break Free</strong> — ${escapeHtmlMin(snap.name)}<br>` +
      `${A1} (d${dA}) + ${A2} (d${dB}) = <strong>${total}</strong> vs DL ${DL}<br>` +
      `<em>${outcome}</em>`;
    try {
      await rollObj.toMessage(
        { speaker: ChatMessage.getSpeaker?.({ actor }) ?? undefined, flavor },
        { rollMode: game.settings?.get?.("core", "rollMode") },
      );
    } catch (e) { warn("Break Free: toMessage failed", e); }
  } catch (e) {
    warn("Break Free: maybeRunBreakFree threw", e);
  }
}

// Minimal HTML escape for chat flavor (actor names are trusted-ish but
// keep them inert in markup).
function escapeHtmlMin(s) {
  return String(s ?? "").replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[m]));
}

// ─── TURN_START ────────────────────────────────────────────────────────
// In Phase 2 this state is responsible for *resolving who acts* on the
// current side via the turn picker. nextTurn() (in TURN_END) only flips the
// side and clears currentCombatantId; here we either auto-pick (single
// eligible) or prompt (multiple eligible) via TurnPicker.
const TurnStart = {
  async onEnter(director) {
    // Authoritative path — DirectorCombat owns turn order.
    let snap = null;
    if (director.dCombat) {
      const dc = director.dCombat;
      // Resolve current via picker if not already set (the normal path: a
      // prior TURN_END cleared it).
      if (!dc.currentCombatantId) {
        let eligible = dc.eligibleOnSide(dc.currentSide);
        // Defensive: if the active side has no eligible, try the other side
        // (handles unusual mid-combat defeats not yet seen by nextTurn).
        if (eligible.length === 0) {
          const other = dc._otherSide(dc.currentSide);
          const otherE = dc.eligibleOnSide(other);
          if (otherE.length > 0) {
            warn(`TURN_START: ${dc.currentSide} side has no eligible, swapping to ${other}`);
            dc.currentSide = other;
            eligible = otherE;
          }
        }
        if (eligible.length === 0) {
          warn("TURN_START: no eligible combatants on either side — ending combat");
          director.ctx.endOfCombat = true;
          director.enqueue({ type: INTENTS.INTERNAL_DONE });
          return;
        }
        if (eligible.length === 1) {
          dc.currentCombatantId = eligible[0].id;
          log(`TURN_START: auto-picked ${eligible[0].name} (only eligible on ${dc.currentSide})`);
        } else {
          log(`TURN_START: ${eligible.length} eligible on ${dc.currentSide} — prompting picker`);

          // GM-local picker (always spawned — fallback for unowned
          // combatants AND so the GM can pick on behalf of an offline
          // player). Pills appear over ALL eligible.
          const localPromise = TurnPicker.show({ director, eligible });

          // Per-user broadcast: each online non-GM user gets a MENU_OPEN
          // with ONLY the eligible combatants they own. Players see pills
          // only over their own PCs. Owner-less combatants (NPC allies on
          // the party side, etc.) are GM-only.
          const channel = director.intentChannel;
          const onlinePlayers = (game.users?.contents ?? []).filter((u) => u.active && !u.isGM);
          const sceneUuid = director.dCombat?.scene?.uuid ?? null;
          const broadcastedUserIds = [];
          log(`TURN_START: ${onlinePlayers.length} online non-GM user(s); channel=${channel ? "attached" : "MISSING"}`);
          if (channel) {
            for (const u of onlinePlayers) {
              // Filter eligible to ones this user has OWNER permission on.
              // Use the live actorDoc on the combatant — it was resolved
              // either at PREP/RECONSTRUCT time. Falling back to fromUuid
              // is a defensive fallback in case actorDoc went stale.
              const myEligible = [];
              for (const dc2 of eligible) {
                try {
                  let actor = dc2.actorDoc ?? null;
                  if (!actor && dc2.actorUuid) {
                    actor = await fromUuid(dc2.actorUuid).catch(() => null);
                  }
                  if (!actor) {
                    log(`TURN_START owner-filter[${u.name}]: ${dc2.name} — no actor doc`);
                    continue;
                  }
                  const owns = actor.testUserPermission?.(u, "OWNER");
                  log(`TURN_START owner-filter[${u.name}]: ${dc2.name} (${actor.uuid}) → owns=${owns}`);
                  if (owns) {
                    myEligible.push({
                      combatantId: dc2.id,
                      name: dc2.name,
                      side: dc2.side,
                      tokenUuid: dc2.tokenUuid ?? null,
                      tokenId: dc2.tokenId ?? null,
                    });
                  }
                } catch (e) { warn("TURN_START: owner check threw", e); }
              }
              if (!myEligible.length) {
                log(`TURN_START: no owned eligible for ${u.name} — skipping broadcast`);
                continue;
              }
              try {
                channel.broadcastMenuOpen({
                  targetUserId: u.id,
                  menuSpec: {
                    kind: "turn-picker",
                    combatId: director.combatId,
                    eligible: myEligible,
                    sceneUuid,
                  },
                });
                broadcastedUserIds.push(u.id);
                log(`TURN_START: broadcast turn-picker to ${u.name} (${myEligible.length} pills)`);
              } catch (e) { warn(`TURN_START: broadcast to ${u.name} threw`, e); }
            }
          }

          // Remote await — single channel for ANY user's TURN_COMBATANT_PICKED.
          let remoteAwait = null;
          if (channel && broadcastedUserIds.length > 0) {
            remoteAwait = channel.awaitIntent(INTENTS.TURN_COMBATANT_PICKED, {
              timeoutMs: 30 * 60 * 1000,
            });
          }

          // Race
          let pickedId = null;
          try {
            const result = await Promise.race([
              localPromise.then((id) => ({ source: "local", id })),
              remoteAwait
                ? remoteAwait.then((intent) => ({ source: "remote", id: intent?.body?.combatantId ?? null }))
                : new Promise(() => {}),
            ]);
            pickedId = result.id;

            // Cancel the loser side's UI.
            if (result.source === "local") {
              try { remoteAwait?.abort?.("local-won"); } catch {}
              // Close player mirrors.
              for (const uid of broadcastedUserIds) {
                try {
                  channel?.broadcastMenuClose({
                    targetUserId: uid,
                    kind: "turn-picker",
                    reason: "local-won",
                  });
                } catch {}
              }
            } else {
              // Remote won — close GM's local picker.
              try { TurnPicker.despawn({ director }); } catch {}
              // Also close any OTHER player's mirror (only one combatant
              // is picked; everyone else's picker should go).
              for (const uid of broadcastedUserIds) {
                try {
                  channel?.broadcastMenuClose({
                    targetUserId: uid,
                    kind: "turn-picker",
                    reason: "remote-won",
                  });
                } catch {}
              }
            }
          } catch (e) {
            warn("TURN_START: turn-picker race threw", e);
            try { remoteAwait?.abort?.("error"); } catch {}
          }

          if (!pickedId) {
            if (director.ctx.endOfCombat) return; // ABORT already queued by battleEndManager
            warn("TURN_START: picker cancelled — aborting turn");
            director.ctx.abortReason = "no combatant picked";
            director.enqueue({ type: INTENTS.ABORT });
            return;
          }
          dc.currentCombatantId = pickedId;
        }
      }
      const current = dc.current;
      if (!current) {
        warn("TURN_START: dCombat has no current combatant after pick — ending combat");
        director.ctx.endOfCombat = true;
        director.enqueue({ type: INTENTS.INTERNAL_DONE });
        return;
      }
      snap = snapshotDirectorCombatant(current);
    } else {
      // Manual-fallback path (no PREP, no dCombat — direct attach to an
      // existing Foundry combat). Read from Foundry combat.combatant.
      const combat = director.combat;
      if (!combat || combat.combatant == null) {
        warn("TURN_START with no current combatant (Foundry path) — ending combat");
        director.ctx.endOfCombat = true;
        director.enqueue({ type: INTENTS.INTERNAL_DONE });
        return;
      }
      snap = snapshotCombatant(combat);
    }
    if (!snap) {
      warn("TURN_START: failed to snapshot combatant");
      director.ctx.endOfCombat = true;
      director.enqueue({ type: INTENTS.INTERNAL_DONE });
      return;
    }
    director.ctx.turnSnapshot = snap;
    director.ctx.declaredCommand = null;
    director.ctx.actionResult = null;
    log(`TURN_START — ${snap.name}`);

    // Homebrew rule: AEs the current combatant applied decrement their
    // `turnsRemaining` at the start of THIS combatant's turn (the
    // "applier"); expired AEs are deleted. See [[ae-default-3-turn-duration]].
    // Runs before the Guard release below so a Guard AE the combatant
    // applied to themselves (rare) still resolves on the normal Guard path.
    try {
      const applierUuid = snap?.actorUuid;
      if (applierUuid) {
        await tickDirectorAEsForApplier(applierUuid);
      }
    } catch (e) { warn("TURN_START: AE tick threw", e); }

    // Release any Guard / Covered AEs whose guarder is this combatant.
    // RAW Core p.70: Guard ends at the start of the guarder's next turn.
    // dCombat.activeGuards is the authoritative ledger (see director-combat.js).
    //
    // Batched the same way director-boot.stop() does it: group effect ids by
    // owning actor, run actors in parallel. Avoids the per-AE stutter that
    // sequential awaits produce when both Guard and Covered need to clear.
    if (director.dCombat && snap?.actorId) {
      try {
        const expiring = director.dCombat.popActiveGuardsFor(snap.actorId);
        if (expiring.length) {
          const deletesByActor = new Map();
          for (const g of expiring) {
            if (g.guarderActorUuid && g.guarderEffectId) {
              let set = deletesByActor.get(g.guarderActorUuid);
              if (!set) { set = new Set(); deletesByActor.set(g.guarderActorUuid, set); }
              set.add(g.guarderEffectId);
            }
            if (g.coveredActorUuid && g.coveredEffectId) {
              let set = deletesByActor.get(g.coveredActorUuid);
              if (!set) { set = new Set(); deletesByActor.set(g.coveredActorUuid, set); }
              set.add(g.coveredEffectId);
            }
          }
          await Promise.all(Array.from(deletesByActor.entries()).map(async ([actorUuid, ids]) => {
            try {
              const actor = await fromUuid(actorUuid);
              if (!actor) return;
              const existing = Array.from(ids).filter((id) => !!actor.effects?.get?.(id));
              if (!existing.length) return;
              await actor.deleteEmbeddedDocuments("ActiveEffect", existing);
            } catch (e) { warn(`TURN_START: AE release failed for ${actorUuid}`, e); }
          }));
          const coveredCount = expiring.filter((g) => g.coveredActorUuid).length;
          log(`Released Guard from ${snap.name}${coveredCount ? ` (+${coveredCount} Cover)` : ""}`);
        }
      } catch (e) { warn("TURN_START: guard release loop threw", e); }
    }

    // Persistence checkpoint #2 — turn picker has resolved + Guards have
    // expired; this is the resume-safe state for reload survival.
    // Mid-action states (DECLARE/TARGET/COMPUTE/CONFIRM) are NOT
    // persisted; if the GM F5s during one of those, we rewind to this
    // saved TURN_START and they re-click their command. A fresh turn
    // starts un-resolved; the RESOLVE checkpoint flips this true after
    // the action commits to actor docs.
    if (director.dCombat) director.dCombat.currentTurnResolved = false;
    // Label describes what the GM lands at on rewind: this combatant's
    // DECLARE menu (TURN_START re-auto-picks the saved id and routes
    // through to DECLARE). Subtitle records the situational context.
    const tsDc = director.dCombat;
    const tsName = tsDc?.current?.name ?? snap?.name ?? "?";
    const tsSide = tsDc?.currentSide === "enemy" ? "Enemies" : "Party";
    saveDirectorState(director, {
      label: `Round ${tsDc?.round ?? 0} · ${tsName}'s Turn`,
      description: `${tsSide} acting — pick action`,
    }).catch((e) => warn("TURN_START: saveDirectorState failed", e));

    // Grappled break-free (free action) — RAW Journal "Grappled" mechanic #3.
    // If the acting combatant is Grappled, offer the DL 10 break-free Check
    // before they declare their action. Runs after the Guard release + save
    // checkpoint so a mid-prompt F5 rewinds to this TURN_START and re-offers
    // it (idempotent: a successful break already removed the AE → no re-prompt).
    await maybeRunBreakFree(director, snap);

    // Hand off to STANDALONE_REACTION_WINDOW for turn_start. Dispatched
    // across every combatant — reactions like "when ANY turn starts"
    // (Sentinel-style) surface too; the row-side filter controls whose
    // turn matches. Payload carries the acting actor's uuid for those
    // filters. After standalone resolves → DECLARE.
    director.ctx.standaloneTrigger = "turn_start";
    director.ctx.standaloneAfter   = STATES.DECLARE;
    director.ctx.standalonePayload = {
      actingActorUuid: snap?.actorUuid,
      actingTokenUuid: snap?.tokenUuid,
    };
    director.enqueue({ type: INTENTS.INTERNAL_DONE });
  },
};

// Resolve the actor-owner user that should drive an interactive surface
// for `actor`. Returns the userId of the first ACTIVE non-GM owner, or
// null if no eligible owner is online. Deterministic on multi-owner
// actors (sort by userId).
//
// "Owner" means OWNER-level Foundry permission (level 3) — same threshold
// Foundry uses for sheet-edit access. NPCs typically have no non-GM
// owner; PCs have exactly one.
function resolveActingOwnerForActor(actor) {
  if (!actor) return null;
  const candidates = (game.users?.contents ?? []).filter((u) => {
    if (u.isGM) return false;
    if (!u.active) return false;
    try { return actor.testUserPermission?.(u, "OWNER"); }
    catch { return false; }
  });
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.id.localeCompare(b.id));
  return candidates[0].id;
}

// ─── DECLARE ───────────────────────────────────────────────────────────
// Run the compose chain (Octopath → per-command pickers) on whichever
// client is fastest. Two chains run in parallel:
//
//   1. GM-local: composeAction() runs on the GM client (fallback path —
//      ensures the GM always has the UI even when no PC owns the actor,
//      AND lets the GM take over if the owner is unresponsive).
//
//   2. Remote:   if the acting actor has an active non-GM owner, the GM
//      also broadcasts MENU_OPEN to that client. The player runs an
//      identical composeAction locally and emits ACTION_COMPOSED when
//      they finish.
//
// Whoever finishes first wins. We cancel the loser, populate ctx from
// the winning bundle, and dispatch DECLARE_COMMAND to move into TARGET.
// Downstream states (TARGET, WEAPON_MODE skip-checks below) read the
// pre-populated ctx fields and skip their pickers when bundle data is
// available.
//
// See [[director-player-driven-input]] for the design.

// Apply a composed (or preset) action bundle to ctx + advance to TARGET. Shared
// by the normal compose-race winner path AND the free_action preset shortcut, so
// both stage the action identically. TARGET's per-command branches read these
// ctx fields and skip their own pickers when pre-populated.
function applyComposedBundleAndAdvance(director, winnerBundle) {
  if (!winnerBundle._commandOnly) {
    // Generic marker any branch can read for "did the player pre-compose this?"
    director.ctx._composedBundle = winnerBundle;

    if (winnerBundle.command === "Attack") {
      if (winnerBundle.attackMode) director.ctx.attackMode = winnerBundle.attackMode;
      if (Array.isArray(winnerBundle.targetUuids)) {
        director.ctx.pickedTargetUuids = [...winnerBundle.targetUuids];
      }
    } else if (winnerBundle.command === "Study" || winnerBundle.command === "Hinder") {
      if (Array.isArray(winnerBundle.targetUuids)) {
        director.ctx.pickedTargetUuids = [...winnerBundle.targetUuids];
      }
    } else if (winnerBundle.command === "Skill" || winnerBundle.command === "Spell" || winnerBundle.command === "Item") {
      if (Array.isArray(winnerBundle.targetUuids)) {
        director.ctx.pickedTargetUuids = [...winnerBundle.targetUuids];
      }
    }
    // Guard: bundle.coverTokenUuid (null = skip, string = ally) is
    //   consumed by TARGET's Guard branch via ctx._composedBundle.
    // Equipment: no extra ctx — TARGET branch already needs nothing
    //   beyond declaredCommand.
  } else {
    director.ctx._composedBundle = null;
  }
  director.ctx.declaredCommand = winnerBundle.command;

  // Advance the FSM. TARGET's per-command branches read ctx and skip
  // their pickers when pre-populated.
  director.dispatch({
    type: INTENTS.DECLARE_COMMAND,
    body: { command: winnerBundle.command },
  });
}

const Declare = {
  async onEnter(director) {
    const snap = director.ctx.turnSnapshot;
    if (!snap) {
      warn("DECLARE entered without turnSnapshot");
      director.enqueue({ type: INTENTS.ABORT });
      return;
    }
    // Clear any multi-pass state from a prior cancelled attack. Without
    // this, cancelling card 1 of a two-weapon attack would leave
    // pendingPasses populated; the next CLEANUP would loop into the
    // second pass automatically — not the user's intent.
    director.ctx.attackMode = null;
    director.ctx.weaponsUsed = null;
    director.ctx.pendingPasses = null;
    director.ctx.currentWeapon = null;
    director.ctx.totalPasses = 0;
    director.ctx.passIndex = 0;
    director.ctx.pickedTargetUuids = null;
    director.ctx.hinderCheckConfig = null;
    director.ctx._composedBundle = null;

    const token = canvas?.tokens?.get(snap.tokenId);
    if (!token) {
      warn("DECLARE: token not on canvas", snap.tokenId);
      director.enqueue({ type: INTENTS.TIMEOUT });
      return;
    }

    // Resolve owner. fromUuid is async but cheap; on error, only GM runs.
    let actor = null;
    try { actor = await fromUuid(snap.actorUuid); } catch {}

    // free_action PRESET shortcut — a fully-determined free action (action_ref =
    // skill name / "self") skips composeAction entirely: stage the exact action
    // and advance straight to TARGET. The free-action grant (bonuses) was already
    // installed on the freeActions singleton by FREE_ACTION_WINDOW; the action
    // still flows through TARGET → COMPUTE → RESOLVE, so targeting + Confirm
    // happen by role (GM picks/auto, owner gets the picker). Compose-style free
    // actions (action_ref = a type) carry no preset and fall through to compose.
    const presetGrant = freeActions.get(snap.actorId);
    if (presetGrant?.preset?.command) {
      // Action-gating debuff backstop: a free-action preset of a blocked type
      // (e.g. a granted free Attack while Frightened) bypasses the Octopath
      // menu. Refuse it here and fall through to compose, whose menu greys the
      // blocked action so the owner picks a legal free action or cancels.
      const presetBlock = (snap.blockedActions ?? []).find((b) => b?.label === presetGrant.preset.command);
      if (presetBlock) {
        ui.notifications?.warn(`${presetBlock.reason}: cannot use the ${presetGrant.preset.command} action.`);
        log(`DECLARE: free_action preset "${presetGrant.sourceLabel}" → ${presetGrant.preset.command} BLOCKED by ${presetBlock.reason}; falling through to compose`);
      } else {
        log(`DECLARE: free_action preset "${presetGrant.sourceLabel}" → ${presetGrant.preset.command} (skip compose)`);
        applyComposedBundleAndAdvance(director, presetGrant.preset);
        return;
      }
    }

    const ownerUserId = resolveActingOwnerForActor(actor);

    // Pre-bake eligible target snapshots. We do this here (with full
    // dCombat access) so the player's client doesn't have to recompute —
    // they get the list via menuSpec. Used by both sides' composeAction.
    const eligibleEnemies = director.dCombat
      ? snapshotEligibleTargetsFromDCombat(director.dCombat, snap, { category: "enemy" })
      : snapshotEligibleTargets(director.combat, snap, { category: "enemy" });
    const eligibleAllies = director.dCombat
      ? snapshotEligibleTargetsFromDCombat(director.dCombat, snap, { category: "ally" })
      : snapshotEligibleTargets(director.combat, snap, { category: "ally" });

    // GM-local compose chain. The cancel token lets us tear it down when
    // the player wins the race.
    const cancelToken = makeCancelToken();
    director.ctx._composeCancelToken = cancelToken;
    const localCompose = composeAction({
      director,
      snap,
      token,
      eligible: { enemies: eligibleEnemies, allies: eligibleAllies },
      cancelSentinel: cancelToken.promise,
      combatId: director.combatId,
      actorUuid: snap.actorUuid,
    }).catch((e) => {
      warn("DECLARE: local composeAction threw", e);
      return { cancelled: true, reason: "exception" };
    });

    // Remote chain (if owner is online): broadcast MENU_OPEN + await
    // ACTION_COMPOSED. The player's composeAction emits this when they
    // finish.
    let remoteAwait = null;
    if (ownerUserId) {
      log(`DECLARE: broadcasting compose-action to player ${ownerUserId} (${snap.name})`);
      // Free-action grant — the registry is GM-side memory. Plumb the
      // grant fields into the menuSpec so the player's composeAction
      // applies the Octopath filter + budget label without needing the
      // local freeActions singleton populated.
      const freeActionGrant = freeActions.get(snap.actorId) ?? null;
      try {
        director.intentChannel?.broadcastMenuOpen({
          targetUserId: ownerUserId,
          menuSpec: {
            kind: "compose-action",
            combatId: director.combatId,
            tokenUuid: token.document.uuid,
            actorUuid: snap.actorUuid,
            snap,
            eligible: { enemies: eligibleEnemies, allies: eligibleAllies },
            freeActionGrant,
          },
        });
        // 30-minute timeout — practically forever. The race will resolve
        // sooner via GM-local OR the player will eventually act.
        remoteAwait = director.intentChannel.awaitIntent(INTENTS.ACTION_COMPOSED, {
          fromUserId: ownerUserId,
          timeoutMs: 30 * 60 * 1000,
        });
        director.ctx._activeRemoteMenu = { kind: "compose-action", targetUserId: ownerUserId };
      } catch (e) {
        warn("DECLARE: broadcast/await setup threw, GM-local only", e);
        remoteAwait = null;
      }
    }

    // Mirror of [[reaction-architecture]] Rule 1 stage 2 for turn-action
    // composition: every active player who is NOT the action owner sees a
    // dimmed "Hina taking action…" indicator over the acting token while
    // composeAction is open. Reuses the reaction-indicator MENU_OPEN
    // surface ("turn-action-indicator" kind) which the player-side handler
    // in reaction-menu-player.js renders via ReactionIndicator.spawn.
    // Owner-tracked turn (no human owner — NPC) sends to every active
    // player so the table still sees what the GM is composing.
    const turnActionIndicatorRecipients = (game.users?.contents ?? [])
      .filter((u) => !u.isGM && u.active && u.id !== ownerUserId)
      .map((u) => u.id);
    const turnActorName = ownerUserId
      ? `${game.users.get(ownerUserId)?.name ?? "Player"} taking action…`
      : `${snap?.name ?? "Combatant"} taking action…`;
    const turnActionIndicatorSpec = {
      kind: "turn-action-indicator",
      combatId: director.combatId,
      tokenUuid: token.document.uuid,
      actorUuid: snap.actorUuid,
      label: turnActorName,
      trigger: "turn-action",
    };
    function broadcastTurnActionIndicatorOpen() {
      if (!director.intentChannel) return;
      for (const uid of turnActionIndicatorRecipients) {
        try {
          director.intentChannel.broadcastMenuOpen({
            targetUserId: uid,
            menuSpec: turnActionIndicatorSpec,
          });
        } catch (e) { warn("DECLARE: broadcastMenuOpen(turn-action-indicator) threw", e); }
      }
    }
    function broadcastTurnActionIndicatorClose() {
      if (!director.intentChannel) return;
      for (const uid of turnActionIndicatorRecipients) {
        try {
          director.intentChannel.broadcastMenuClose({
            targetUserId: uid,
            kind: "turn-action-indicator",
            reason: "compose-resolved",
            data: { tokenUuid: token.document.uuid, combatId: director.combatId },
          });
        } catch (e) { warn("DECLARE: broadcastMenuClose(turn-action-indicator) threw", e); }
      }
    }
    broadcastTurnActionIndicatorOpen();
    director.ctx._closeTurnActionIndicator = broadcastTurnActionIndicatorClose;

    // Race. If only GM is running (no remote), the remote side is a
    // never-resolving Promise so localCompose alone determines the
    // winner.
    let winnerSource = null;
    let winnerBundle = null;
    // Wrap the remote await so we can abort it on local-wins. Without
    // this, an unresolved awaitIntent for ACTION_COMPOSED would linger
    // in _pendingAwaits and the NEXT turn's emit would resolve the
    // stale entry first (Map insertion order). See [[director-player-driven-input]].
    try {
      const result = await Promise.race([
        localCompose.then((r) => ({ source: "local", result: r })),
        remoteAwait
          ? remoteAwait.then((intent) => ({ source: "remote", result: { cancelled: !intent?.body?.bundle, bundle: intent?.body?.bundle ?? null } }))
          : new Promise(() => {}),
      ]);
      winnerSource = result.source;

      // Cancel the loser.
      if (winnerSource === "local") {
        // Abort the dangling remote awaitIntent so it doesn't leak.
        try { remoteAwait?.abort?.("local-won"); } catch {}
        if (ownerUserId) {
          try {
            director.intentChannel?.broadcastMenuClose({
              targetUserId: ownerUserId,
              kind: "compose-action",
              reason: "local-won",
            });
          } catch (e) { warn("DECLARE: broadcastMenuClose (local-won) threw", e); }
          director.ctx._activeRemoteMenu = null;
        }
      } else {
        // Remote won — cancel GM's local compose so its overlays close.
        cancelToken.cancel("remote-won");
        // Wait for local to actually unwind so its UI is gone before we
        // move to TARGET (avoids dangling Octopath).
        try { await localCompose; } catch {}
      }

      if (result.result.cancelled) {
        log(`DECLARE: compose cancelled (winner=${winnerSource})`);
        // Skip TIMEOUT when battle is ending — ABORT is already queued.
        if (!director.ctx.endOfCombat) {
          director.enqueue({ type: INTENTS.TIMEOUT });
        }
        return;
      }

      winnerBundle = result.result.bundle;
    } catch (e) {
      warn("DECLARE: compose race threw", e);
      director.enqueue({ type: INTENTS.ABORT });
      return;
    } finally {
      director.ctx._composeCancelToken = null;
    }

    if (!winnerBundle || !winnerBundle.command) {
      warn("DECLARE: race winner produced no bundle", winnerBundle);
      director.enqueue({ type: INTENTS.TIMEOUT });
      return;
    }

    // Authoritative action-gating backstop. The menu greys blocked actions on
    // both clients, but a stale/forced/tampered DECLARE_COMMAND could still
    // arrive — refuse it here (the GM is the source of truth) and bounce so the
    // turn isn't spent on an illegal action.
    const blockedHit = (snap.blockedActions ?? []).find((b) => b?.label === winnerBundle.command);
    if (blockedHit) {
      warn(`DECLARE: winner command "${winnerBundle.command}" blocked by ${blockedHit.reason} — refusing`);
      ui.notifications?.warn(`${blockedHit.reason}: cannot use the ${winnerBundle.command} action.`);
      director.enqueue({ type: INTENTS.TIMEOUT });
      return;
    }

    log(`DECLARE: winner=${winnerSource}, command=${winnerBundle.command}`);

    // Apply bundle to ctx — sets up pre-populated picks so TARGET state
    // can skip its pickers when data is already provided. For
    // "_commandOnly" bundles (Skill/Spell/Item — not yet supported by
    // composeAction beyond the Octopath click), the GM still runs its
    // normal pickers in TARGET state.
    applyComposedBundleAndAdvance(director, winnerBundle);
  },

  async onExit(director) {
    TurnUI.despawn({ director });
    // Cancel any in-flight local compose (defensive — race usually
    // resolves before onExit fires).
    try { director.ctx._composeCancelToken?.cancel("state-exit"); } catch {}
    // Tell the player's client to close its compose UI if it's still up.
    const remote = director.ctx._activeRemoteMenu;
    if (remote) {
      try {
        director.intentChannel?.broadcastMenuClose({
          targetUserId: remote.targetUserId,
          kind: remote.kind,
          reason: "state-exit",
        });
      } catch (e) { warn("DECLARE.onExit: broadcastMenuClose threw", e); }
      director.ctx._activeRemoteMenu = null;
    }
    // Tear down the turn-action ally indicator (set up at onEnter).
    try { director.ctx._closeTurnActionIndicator?.(); } catch {}
    director.ctx._closeTurnActionIndicator = null;
  },

  async onAbort(director, { reason } = {}) {
    TurnUI.despawn({ director });
    try { director.ctx._composeCancelToken?.cancel(`abort:${reason ?? "unknown"}`); } catch {}
    const remote = director.ctx._activeRemoteMenu;
    if (remote) {
      try {
        director.intentChannel?.broadcastMenuClose({
          targetUserId: remote.targetUserId,
          kind: remote.kind,
          reason: `abort:${reason ?? "unknown"}`,
        });
      } catch (e) { warn("DECLARE.onAbort: broadcastMenuClose threw", e); }
      director.ctx._activeRemoteMenu = null;
    }
    try { director.ctx._closeTurnActionIndicator?.(); } catch {}
    director.ctx._closeTurnActionIndicator = null;
  },
};

// ─── Unified action targeting resolver ───────────────────────────────────────
// All TARGET branches that need to pick token(s) from the scene call this
// function instead of building their own mode/category/count logic and
// requestTargeting call. Attack, Skill, Spell, Study, Hinder, and Guard's
// Cover picker all share this single path.
//
// opts.skillTargetText   — free-text field ("One Random Enemy", "All Ally", …).
//   Drives mode, category, and count. Defaults to "One Enemy".
// opts.attackerActor     — resolved actor doc; needed for formula counts (SL…).
// opts.skill             — item doc; used for intent classification + formulas.
// opts.eligiblePostFilter — optional fn(pool) → pool applied AFTER category
//   pool building. Attack uses this for applyAttackRangeGate (Covered/Vanish).
// opts.excludeSelf       — strips the attacker's own token from the pool.
//   Pass true for all attack-type actions (can't target yourself in combat).
// opts.usingPreComposed  — when true + composedTargetUuids has entries, skip
//   the interactive picker for Exact/Up-to modes (composeAction race winner).
// opts.composedTargetUuids — pre-resolved token UUIDs from composeAction.
// opts.titleText         — banner label override (null = auto-generated).
// opts.cancelLabel       — Cancel button text override.
// opts.secondaryAction   — forwarded to requestTargeting (Guard "Skip Cover").
//
// Returns { ok, cancelled, skipped?, secondaryValue?, targets, targetUuids }.
// When ok is false, cancelled/reason indicates why (user cancel vs no targets).
async function resolveActionTargets(director, attackerSnap, opts = {}) {
  const {
    skillTargetText:    rawText       = "One Enemy",
    attackerActor                     = null,
    skill                             = null,
    eligiblePostFilter                = null,
    excludeSelf                       = false,
    usingPreComposed                  = false,
    composedTargetUuids               = null,
    titleText:          forcedTitle   = null,
    cancelLabel                       = "Cancel",
    secondaryAction                   = null,
  } = opts;

  // ── target_sequence — multi-step declarative targeting ──────────────────
  // A skill can declare `target_sequence` (comma-list of targeting-row labels)
  // to pick several targets IN ORDER at the TARGET phase, each with its own
  // filter/exclude (e.g. Blazing Tether: pick a Burn-holder "giver", then a
  // "receiver" excluding the giver). Each ref resolves through the shared
  // resolveTargetRef (combat pool → target_filter → exclude → picker). A cancel
  // on ANY pick bounces to the Action Menu (the standard TARGET_BACK the caller
  // does on cancelled). The picks are recorded per-ref in `namedPicks` so RESOLVE
  // can re-seed them onto the chain (no re-prompt); the union becomes the
  // action's targets. Generic — any "pick an X, then a Y" skill can use it.
  const sequenceRaw = String(skill?.system?.props?.target_sequence ?? "").trim();
  if (sequenceRaw) {
    const refs = sequenceRaw.split(",").map((s) => s.trim()).filter(Boolean);
    let reactorToken = null;
    try { reactorToken = await fromUuid(attackerSnap.tokenUuid); } catch { /* optional */ }
    const seqCtx = {
      skill,
      runtimeEffectTable: skill?.system?.props?.effect_table ?? null,
      payload: {},
      dCombat: director.dCombat,
      reactorToken,
      reactorActor: attackerActor,
      resolvedTargets: new Map(),
      isPassive: false,
    };
    const namedPicks = {};
    const pickedUuids = [];
    for (const ref of refs) {
      const r = await resolveTargetRef(ref, seqCtx);
      if (r?.cancelled) {
        return { ok: false, cancelled: true, reason: "target-cancelled", targets: [], targetUuids: [] };
      }
      if (!r?.ok || !r.tokens?.length) {
        ui.notifications?.warn(`No eligible target for "${ref}".`);
        return { ok: false, cancelled: false, reason: r?.reason ?? "no_eligible", targets: [], targetUuids: [] };
      }
      const uuids = r.tokens.map((tk) => tk?.document?.uuid ?? tk?.uuid).filter(Boolean);
      namedPicks[ref] = uuids;
      for (const u of uuids) if (!pickedUuids.includes(u)) pickedUuids.push(u);
    }
    const eligibleAll = director.dCombat
      ? snapshotEligibleTargetsFromDCombat(director.dCombat, attackerSnap, { category: "any" })
      : snapshotEligibleTargets(director.combat, attackerSnap, { category: "any" });
    const targets = eligibleAll.filter((e) => pickedUuids.includes(e.tokenUuid));
    return { ok: true, cancelled: false, targets, targetUuids: pickedUuids, namedPicks };
  }

  const text   = String(rawText ?? "").trim().toLowerCase();
  const isSelf = !text || /^self$/i.test(text);

  // ── Build eligible pool ────────────────────────────────────────────────
  let category = "enemy";
  let eligibleForPicker;

  if (isSelf) {
    eligibleForPicker = [attackerSnap];
  } else {
    // Target side: an EXPLICIT side in skill_target wins (creature = either side;
    // enemy; ally). The action-intent heuristic is only a TIEBREAKER for
    // side-agnostic text ("One Target", "Up to 3") — it must NOT override an
    // explicit "Enemy"/"Ally" (the bug that flipped Shadow Possession's "All
    // Enemy" to allies because a damageless Active classifies as "aid").
    const wantsCreature = /creature|creatures/i.test(text);
    const wantsEnemy    = /enem/i.test(text);
    const wantsAllyText = /\ball(?:y|ies)\b/i.test(text);
    const intent        = skill ? classifyActionIntent(skill) : "harmful";
    category = wantsCreature ? "any"
      : wantsEnemy    ? "enemy"
      : wantsAllyText ? "ally"
      : (intent === "aid" ? "ally" : "enemy");
    eligibleForPicker   = director.dCombat
      ? snapshotEligibleTargetsFromDCombat(director.dCombat, attackerSnap, { category })
      : snapshotEligibleTargets(director.combat, attackerSnap, { category });
    if (excludeSelf) {
      eligibleForPicker = eligibleForPicker.filter((e) => e.tokenUuid !== attackerSnap.tokenUuid);
    }
    if (eligiblePostFilter) {
      eligibleForPicker = eligiblePostFilter(eligibleForPicker);
    }
  }

  // ── Determine picker mode ──────────────────────────────────────────────
  let pickerMode    = "exact";
  let count         = 1;
  let randomizeCount = false;

  if (isSelf) {
    pickerMode = "self";
  } else {
    const resolver = (attackerActor && skill)
      ? buildSkillResolver({ actor: attackerActor, payload: null, skill, round: director.dCombat?.round ?? 0 })
      : null;
    const isRandom    = /\brandom\b/i.test(text);
    const textForCount = isRandom
      ? text.replace(/\brandom\b/gi, "").replace(/\s+/g, " ").trim()
      : text;
    if (isRandom) {
      pickerMode = "random";
      if (/up\s+to/i.test(text)) {
        randomizeCount = true;
        count = resolver ? extractTargetCountFromText(textForCount, { isUpTo: true,  resolver }) : 1;
      } else {
        count = resolver ? extractTargetCountFromText(textForCount, { isUpTo: false, resolver }) : 1;
      }
    } else if (/\ball\b/i.test(text)) {
      pickerMode = "all";
    } else if (/up\s+to/i.test(text)) {
      pickerMode = "up_to";
      count = resolver ? extractTargetCountFromText(text, { isUpTo: true,  resolver }) : 1;
    } else {
      count = resolver ? extractTargetCountFromText(text, { isUpTo: false, resolver }) : 1;
    }
  }

  // ── Guard against empty pool ────────────────────────────────────────────
  if (!isSelf && !eligibleForPicker.length) {
    const categoryLabel = category === "any" ? "creatures" : `${category}s`;
    ui.notifications?.warn(`No eligible ${categoryLabel} on this scene.`);
    return { ok: false, cancelled: false, reason: "no_eligible", targets: [], targetUuids: [] };
  }

  director.ctx.eligibleTargets = eligibleForPicker;

  // ── Route to picker ────────────────────────────────────────────────────
  const isAutoPick = pickerMode === "self" || pickerMode === "all" || pickerMode === "random";
  let result;
  if (!isAutoPick && usingPreComposed
      && Array.isArray(composedTargetUuids) && composedTargetUuids.length) {
    result = { ok: true, cancelled: false, tokenUuids: [...composedTargetUuids] };
  } else {
    const titleText = forcedTitle
      ?? (pickerMode === "self" || pickerMode === "all" ? null
        : pickerMode === "random"
          ? `${attackerSnap.name}: randomizing target`
          : `${attackerSnap.name}: pick target${count > 1 ? "s" : ""}`);
    result = await requestTargeting({
      director, eligible: eligibleForPicker,
      mode: pickerMode, count, titleText, cancelLabel, secondaryAction, randomizeCount,
    });
  }

  if (!result.ok) {
    return {
      ok: false, cancelled: result.cancelled ?? false,
      skipped: result.skipped ?? false, secondaryValue: result.secondaryValue ?? null,
      targets: [], targetUuids: [],
    };
  }
  const targetUuids = [...result.tokenUuids];
  const targets     = eligibleForPicker.filter((e) => targetUuids.includes(e.tokenUuid));
  return {
    ok: true, cancelled: false,
    skipped: result.skipped ?? false, secondaryValue: result.secondaryValue ?? null,
    targets, targetUuids,
  };
}

// ─── TARGET ────────────────────────────────────────────────────────────
const Target = {
  async onEnter(director, { triggerIntent }) {
    const command = triggerIntent?.body?.command ?? director.ctx.declaredCommand;
    director.ctx.declaredCommand = command;
    log(`TARGET — command: ${command}`);

    // ─── Guard (RAW Core p.70) ────────────────────────────────────────
    // Always grants Resistance + Opposed Check +2 to the guarder until the
    // start of their next turn. Optionally, the guarder may also Cover
    // another creature — that creature cannot be targeted by melee
    // attacks until the same release point.
    //
    // Target step: ally-picker with a "Skip Cover" secondary action so
    // the player can mouse-only Guard alone OR Guard + Cover an ally.
    if (command === "Guard") {
      const attackerSnap = director.ctx.turnSnapshot;
      // Pre-composed by player? composeGuard's bundle carries
      // coverTokenUuid (null = skip cover, uuid = picked ally).
      const composedGuard = director.ctx._composedBundle;
      let coverTarget;
      if (composedGuard && composedGuard.command === "Guard" && "coverTokenUuid" in composedGuard) {
        log(`TARGET (Guard): using pre-composed coverTokenUuid=${composedGuard.coverTokenUuid ?? "none"}`);
        if (composedGuard.coverTokenUuid) {
          // Resolve the snapshot reference from the live ally pool.
          const allies = director.dCombat
            ? snapshotEligibleTargetsFromDCombat(director.dCombat, attackerSnap, { category: "ally" })
            : snapshotEligibleTargets(director.combat, attackerSnap, { category: "ally" });
          coverTarget = allies.find((t) => t.tokenUuid === composedGuard.coverTokenUuid) ?? null;
        } else {
          coverTarget = null;
        }
      } else {
        // Interactive path — shared targeting resolver handles pool + picker.
        const targeting = await resolveActionTargets(director, attackerSnap, {
          skillTargetText: "One Ally",
          excludeSelf:     true,
          titleText:       `${attackerSnap.name}: pick an ally to Cover (optional)`,
          cancelLabel:     "Cancel Guard",
          secondaryAction: { label: "Skip Cover", value: "skip" },
        });
        if (!targeting.ok) {
          director.dispatch({ type: targeting.cancelled ? INTENTS.TARGET_BACK : INTENTS.ABORT });
          return;
        }
        coverTarget = targeting.skipped ? null : (targeting.targets[0] ?? null);
      }

      director.ctx.actionResult = freezeActionResult({
        kind: "Guard",
        attacker: attackerSnap,
        coverTarget,
        // `targets` keeps a compat shape for the card portrait picker etc.
        targets: coverTarget ? [coverTarget] : [attackerSnap],
      });
      director.dispatch({
        type: INTENTS.TARGET_PICKED,
        body: { targetTokenUuids: coverTarget ? [coverTarget.tokenUuid] : [attackerSnap.tokenUuid] },
      });
      return;
    }

    // ─── Equipment (RAW Core p.70) ────────────────────────────────────
    // "You may store any number of your equipped items in your backpack,
    // and you may take any number of items from your backpack and equip
    // them. The only thing you can't equip or put away is armor."
    //
    // Director-side this is a no-targeting, no-roll action — the player
    // makes the actual swaps on the actor sheet. The card just records the
    // declared action, surfaces an "Open Sheet" button for convenience,
    // and ends the turn when the player confirms.
    if (command === "Equipment") {
      director.ctx.actionResult = freezeActionResult({
        kind: "Equipment",
        attacker: director.ctx.turnSnapshot,
        attackerActorRef: director.ctx.turnSnapshot.actorUuid,
        targets: [director.ctx.turnSnapshot],
      });
      director.enqueue({
        type: INTENTS.TARGET_PICKED,
        body: { targetTokenUuids: [director.ctx.turnSnapshot.tokenUuid] },
      });
      return;
    }

    // ─── Study (RAW Core p.74) ────────────────────────────────────────
    // Open Check (default INS + INS) against a chosen creature. The
    // total determines what tier of info gets revealed on the Monster
    // Encyclopedia journal page (Identity ≥ 7, Stats ≥ 8, Details ≥ 13
    // per `scripts/encyclopedia/encyclopedia-core.js`).
    //
    // For v1 we restrict targets to enemies. Per RAW the action targets
    // "an item, a person, a creature or even a location," but in combat
    // the typical case is studying an enemy. Allies / objects are a
    // future scope decision.
    if (command === "Study") {
      const attackerSnap = director.ctx.turnSnapshot;
      const studyTargeting = await resolveActionTargets(director, attackerSnap, {
        skillTargetText:    "One Enemy",
        usingPreComposed:   !!director.ctx.pickedTargetUuids?.length,
        composedTargetUuids: director.ctx.pickedTargetUuids,
        titleText:          `${attackerSnap.name}: pick a creature to Study`,
      });
      if (!studyTargeting.ok) {
        director.dispatch({ type: (studyTargeting.cancelled || studyTargeting.reason === "no_eligible") ? INTENTS.TARGET_BACK : INTENTS.ABORT });
        return;
      }
      director.ctx.pickedTargetUuids = studyTargeting.targetUuids;
      director.dispatch({ type: INTENTS.TARGET_PICKED, body: { targetTokenUuids: studyTargeting.targetUuids } });
      return;
    }

    // ─── Hinder (RAW Core p.71) ───────────────────────────────────────
    // Force an opponent into a disadvantageous position. Check vs DL 10
    // (NOT against the target's DEF). RAW: "the Game Master will determine
    // the relevant Attributes based on your description" — for v1 we
    // hardcode DEX+INS (the most common feint-style pair); an attribute
    // picker is a future polish.
    //
    // On success, the player picks ONE status from {dazed, shaken, slow,
    // weak} via the card buttons — that pick IS the commit.
    if (command === "Hinder") {
      const attackerSnap = director.ctx.turnSnapshot;
      // Target spec + check defaults are authored on the Hinder Common item
      // (skill_target, rolled_atr1/2, check_difficulty_level) — read them here so
      // TARGET no longer hardcodes the RAW literals. The GM picker below still
      // lets the GM override the authored attribute pair / DL per situation.
      const hinderProps = getCoreActionSkill("hinder")?.system?.props ?? {};
      const hinderTargeting = await resolveActionTargets(director, attackerSnap, {
        skillTargetText:    hinderProps.skill_target || "One Enemy",
        usingPreComposed:   !!director.ctx.pickedTargetUuids?.length,
        composedTargetUuids: director.ctx.pickedTargetUuids,
        titleText:          `${attackerSnap.name}: pick an opponent to Hinder`,
      });
      if (!hinderTargeting.ok) {
        director.dispatch({ type: (hinderTargeting.cancelled || hinderTargeting.reason === "no_eligible") ? INTENTS.TARGET_BACK : INTENTS.ABORT });
        return;
      }

      // Per RAW Core p.71, the GM picks the attribute pair AFTER the
      // player describes their approach. Surface that on the GM client
      // now — the player is committed to the target but waits for the GM
      // to call the check. Default DL is the item's check_difficulty_level
      // (RAW 10); the GM can adjust for situational difficulty.
      const targetName = hinderTargeting.targets[0]?.name ?? "target";
      const defA1 = String(hinderProps.rolled_atr1 || "DEX").toUpperCase();
      const defA2 = String(hinderProps.rolled_atr2 || "INS").toUpperCase();
      const defDL = Math.max(1, Number(hinderProps.check_difficulty_level) || 10);
      const checkConfig = await pickAttributePair({
        director,
        titleText: `Hinder ${targetName}: configure the Check`,
        subtitle: `Pick the attribute pair the GM thinks matches the player's described approach. DL default ${defDL} per RAW Core p.71.`,
        defaults: { A1: defA1, A2: defA2 },
        includeDL: true,
        defaultDL: defDL,
      });
      if (!checkConfig.ok) {
        director.dispatch({ type: INTENTS.TARGET_BACK });
        return;
      }
      director.ctx.pickedTargetUuids = hinderTargeting.targetUuids;
      director.ctx.hinderCheckConfig = { A1: checkConfig.A1, A2: checkConfig.A2, dl: checkConfig.dl ?? 10 };
      director.dispatch({ type: INTENTS.TARGET_PICKED, body: { targetTokenUuids: hinderTargeting.targetUuids } });
      return;
    }

    // ─── Skill / Spell (Phase B.1) ────────────────────────────────────
    // Skill picker → targeting → optional check roll → damage/effects.
    // The skill data lives on Item docs with `system.props.*` (CSB-defined
    // schema, see docs/reaction-config-schema.md). We READ that data here
    // and execute via director-native effect engine — no legacy macros.
    //
    // Both Skill and Spell commands route through this branch. They
    // differ only in the picker's skill_type filter:
    //   Skill → skill_type === "Active"
    //   Spell → skill_type === "Spell"
    if (command === "Skill" || command === "Spell") {
      const isSpellAction = command === "Spell";
      const attackerSnap = director.ctx.turnSnapshot;
      let attackerActor = null;
      try { attackerActor = await fromUuid(attackerSnap.actorUuid); } catch {}
      if (!attackerActor) {
        ui.notifications?.warn(`Couldn't read your ${command.toLowerCase()}s — actor not found.`);
        director.enqueue({ type: INTENTS.TARGET_BACK });
        return;
      }

      // Pre-composed by player? Bundle carries skillUuid + sourceItemUuid
      // + targetUuids. Skip pickSkill on this client.
      const composedSpell = director.ctx._composedBundle;
      const usingPreComposed = !!(composedSpell
        && (composedSpell.command === "Skill" || composedSpell.command === "Spell")
        && composedSpell.skillUuid);

      // 1) Pick from the actor's roster (+ equipped-item grants).
      //    Spell action filters to skill_type=Spell; Skill action to Active.
      let pick;
      if (usingPreComposed) {
        log(`TARGET (${command}): using pre-composed skillUuid=${composedSpell.skillUuid}`);
        pick = {
          skillUuid: composedSpell.skillUuid,
          sourceItemUuid: composedSpell.sourceItemUuid ?? null,
        };
      } else {
        pick = await pickSkill({
          director,
          actor: attackerActor,
          allowedSkillTypes: isSpellAction ? ["spell"] : ["active"],
          titleText: isSpellAction ? "Choose a Spell" : "Choose a Skill",
          emptyMessage: isSpellAction
            ? `${attackerActor.name ?? "Combatant"} knows no spells.`
            : `${attackerActor.name ?? "Combatant"} has no Active skills available.`,
        });
        if (!pick) {
          director.dispatch({ type: INTENTS.TARGET_BACK });
          return;
        }
      }
      let skill = null;
      try { skill = await fromUuid(pick.skillUuid); } catch {}
      if (!skill) {
        ui.notifications?.error("Picked skill could not be resolved.");
        director.enqueue({ type: INTENTS.TARGET_BACK });
        return;
      }
      // Action intent (aid / harmful / neutral) — read once from the resolved
      // skill and stamped onto the actionResult below (`actionIntent: intent`).
      // Without this definition the ar build threw "intent is not defined" for
      // any Skill reaching the full pick+target COMPUTE (e.g. Soul Steal vs an
      // enemy, Infectious Ray "All Enemy"); the harness reimplements COMPUTE so
      // it never exercised this branch.
      const intent = classifyActionIntent(skill);

      // 2) Resolve targets via the unified resolver. All mode/category/count
      //    parsing lives in resolveActionTargets; this branch just passes
      //    the skill's raw text + actor/skill refs for formula resolution.
      const skillTargetText = String(skill.system?.props?.skill_target ?? "").trim();
      const _isAutoSkillPick = !skillTargetText || /^self$/i.test(skillTargetText) || /\ball\b/i.test(skillTargetText);
      const _skillTitle = /\brandom\b/i.test(skillTargetText)
        ? `${attackerSnap.name}: randomizing target for ${skill.name}`
        : _isAutoSkillPick ? null
        : `${attackerSnap.name}: pick target for ${skill.name}`;
      const skillTargeting = await resolveActionTargets(director, attackerSnap, {
        skillTargetText,
        attackerActor,
        skill,
        usingPreComposed:    usingPreComposed,
        composedTargetUuids: composedSpell?.targetUuids,
        titleText:           _skillTitle,
      });
      if (!skillTargeting.ok) {
        director.dispatch({ type: (skillTargeting.cancelled || skillTargeting.reason === "no_eligible") ? INTENTS.TARGET_BACK : INTENTS.ABORT });
        return;
      }
      const targets    = skillTargeting.targets;
      const targetUuids = skillTargeting.targetUuids;

      // 3) Re-check affordability with the actual target count (×T tokens).
      const parsedCost = parseSkillCost(String(skill.system?.props?.cost ?? ""));
      let costMap = resolveCost(parsedCost, { actor: attackerActor, targetCount: targets.length });
      let gate = checkAffordable(attackerActor, costMap);

      // ── Short-on-MP reactions (Vismagus + future cost-swap traits) ──
      //
      // When the cost gate fails ONLY on MP, fire the
      // `caster_short_on_mp` reaction trigger. Carriers (Vismagus item,
      // any future "spend X instead of MP" class trait) author a
      // `substitute_cost` effect_table row that rewrites `costMap` in
      // place. After dispatch, re-check affordability against the new
      // map. The dispatcher is generic: no skill name / class flag
      // hardcoding lives here.
      //
      // The substitute_cost effect stamps `payload.vismagusHpPaid` (and
      // `payload.suppressSelfGrantOf`) when it mutates the map, so
      // RESOLVE's self-heal suppression continues to work for Vismagus.
      let vismagusHpPaid = false;
      const onlyMpMissing = !gate.ok && gate.missing.every(
        (m) => String(m.resource ?? m.label ?? "").toLowerCase() === "mp"
      );
      const skillIsSpell = String(skill.system?.props?.skill_type ?? "").toLowerCase() === "spell";
      if (!gate.ok && onlyMpMissing && skillIsSpell) {
        const reactionPayload = {
          sourceActorUuid: attackerActor.uuid,
          actorUuid:       attackerActor.uuid,
          skillUuid:       skill.uuid,
          skillName:       skill.name,
          skillType:       "Spell",
          costMap,
          mpNeeded:        Number(costMap.get?.("mp") ?? costMap.mp ?? 0) || 0,
          curHp:           Number(attackerActor.system?.props?.current_hp ?? 0) || 0,
        };
        // Use the shared multi-client reaction-menu dispatcher (same
        // surface as standalone triggers — player-broadcast + ally
        // indicator come for free). Cancel button instead of Pass since
        // declining means the spell isn't affordable; we return the
        // player to the action picker.
        const casterToken = canvas?.tokens?.placeables?.find((t) => t.actor?.uuid === attackerActor.uuid)
          ?? null;
        if (casterToken) {
          const stMod = await import("./standalone-reactions.js?cb=" + Date.now());
          let decision;
          try {
            decision = await stMod.dispatchReactionMenu({
              director,
              reactor: attackerActor,
              token: casterToken,
              trigger: "caster_short_on_mp",
              payload: reactionPayload,
              label: `Can't afford ${skill.name}`,
              passLabel: "Cancel",
            });
          } catch (e) {
            warn("caster_short_on_mp dispatchReactionMenu threw", e);
            decision = { cancelled: false, fired: [] };
          }
          if (decision.cancelled) {
            director.enqueue({ type: INTENTS.TARGET_BACK });
            return;
          }
          gate = checkAffordable(attackerActor, costMap);
          vismagusHpPaid = !!reactionPayload.vismagusHpPaid;
        } else {
          warn("caster_short_on_mp: caster token not on canvas — gate fails through");
        }
      }
      if (!gate.ok) {
        const missing = gate.missing.map((m) => `${m.label}: ${m.has}/${m.need}`).join(", ");
        ui.notifications?.warn(`Can't cast ${skill.name} — missing ${missing}.`);
        director.enqueue({ type: INTENTS.TARGET_BACK });
        return;
      }

      // Display cost — defaults to the CSB raw cost string ("10 MP").
      // When Vismagus (or any future substitute_cost reaction) fired,
      // rewrite it to surface the resource that ACTUALLY got paid so
      // the action card subtitle reflects reality ("20 HP · Vismagus").
      let displayCost = String(skill.system?.props?.cost ?? "");
      if (vismagusHpPaid) {
        const hpPaid = Number(costMap.get?.("hp") ?? costMap.hp ?? 0) || 0;
        if (hpPaid > 0) displayCost = `${hpPaid} HP · Vismagus`;
      }

      // 4) Build actionResult. We deliberately do NOT freeze the live
      //    skill doc (circular item.parent refs blow the freeze walk);
      //    only uuids + scalar fields. RESOLVE re-fetches via fromUuid.
      director.ctx.actionResult = freezeActionResult({
        kind: "Skill",
        attacker: attackerSnap,
        attackerActorRef: attackerSnap.actorUuid,
        skillUuid: skill.uuid,
        skillName: skill.name,
        skillImg: skill.img,
        skillType: String(skill.system?.props?.skill_type ?? ""),
        defenseTargetType: String(skill.system?.props?.defense_target_type ?? "").toLowerCase(),
        isCheck: !!skill.system?.props?.isCheck,
        rolledA1: String(skill.system?.props?.rolled_atr1 ?? "").toUpperCase(),
        rolledA2: String(skill.system?.props?.rolled_atr2 ?? "").toUpperCase(),
        checkBonus: Number(skill.system?.props?.check_bonus ?? 0) || 0,
        damageBonus: skill.system?.props?.damage_bonus ?? 0,
        damageType: String(skill.system?.props?.type_damage ?? ""),
        skillRange: String(skill.system?.props?.skill_range ?? ""),
        skillTarget: skillTargetText,
        sourceItemUuid: pick.sourceItemUuid ?? null,
        descriptionHtml: String(skill.system?.props?.description ?? ""),
        targets,
        costSerialized: serializeCostMap(costMap),
        rawCost: displayCost,
        actionIntent: intent,
        // Vismagus alt-cost flag — resolveAction reads this and
        // suppresses self-heal when the spell would heal the caster
        // (RAW: "you instead recover no HP, the spell still works on
        // other targets").
        vismagusHpPaid,
        // target_sequence per-ref picks ({ ref: [tokenUuid] }) — carried so
        // RESOLVE re-seeds ctx.resolvedTargets and the chain's effect rows
        // resolve their giver/receiver refs without re-prompting.
        targetSequencePicks: skillTargeting.namedPicks ?? null,
      });
      director.ctx.pickedTargetUuids = targetUuids;
      director.dispatch({
        type: INTENTS.TARGET_PICKED,
        body: { targetTokenUuids: targetUuids },
      });
      return;
    }

    // ─── Item (RAW Core p.71) ────────────────────────────────────────
    // Use a consumable or craft one from a known recipe. Director-side
    // this is a self-target menu action: TARGET pre-fetches the actor's
    // consumable list + creatable recipes (via legacy itemCreate API for
    // recipes) and stages them on actionResult so the card body can
    // render them synchronously. COMPUTE is a pass-through (no roll for
    // the resource step). RESOLVE debits the right resource and toasts.
    //
    // v1 scope: resource accounting only. Actually invoking the item's
    // active skill is deferred to Phase B (Skills). The card surfaces
    // the linked skill names so the player knows what's *coming*, and
    // the commit toast notes the deferred status.
    if (command === "Item") {
      // Item action: the consumable was chosen + targeted in the compose chain
      // (composeItem → pickItem → shared resolveTargetsForSource), exactly like
      // Skill. This branch only SHAPES the standard actionResult from the chosen
      // consumable source; COMPUTE/CONFIRM/RESOLVE are the SHARED skill path (no
      // Item-specific divergence). Cost: "create" pays IP (a normal cost
      // resource); "use" pays the item itself (consumed in resolveAction).
      const attackerSnap = director.ctx.turnSnapshot;
      let attackerActor = null;
      try { attackerActor = await fromUuid(attackerSnap.actorUuid); } catch {}
      if (!attackerActor) {
        ui.notifications?.warn("Couldn't read your inventory — actor not found.");
        director.enqueue({ type: INTENTS.TARGET_BACK });
        return;
      }
      const bundle = director.ctx._composedBundle;
      if (!bundle || bundle.command !== "Item" || !bundle.skillUuid) {
        ui.notifications?.warn("Pick an item to use first.");
        director.enqueue({ type: INTENTS.TARGET_BACK });
        return;
      }
      const consumable = await fromUuid(bundle.skillUuid).catch(() => null);
      if (!consumable) {
        ui.notifications?.warn("Chosen item could not be resolved.");
        director.enqueue({ type: INTENTS.TARGET_BACK });
        return;
      }
      // Resolve the consumable's LINKED activation skill (item_skill_active).
      // It carries the real targeting + effect; the consumable is the carrier +
      // cost. Fall back to the consumable itself for already-skill-shaped items
      // that have no linked skill. Everything downstream (view, targeting,
      // actionResult, COMPUTE/RESOLVE) reads the activation skill, except item
      // consumption which keys off the source consumable (sourceItemUuid).
      let activation = consumable;
      const linkedUuid = bundle.linkedSkillUuid ?? getLinkedSkillUuid(consumable);
      if (linkedUuid) {
        const linked = await fromUuid(linkedUuid).catch(() => null);
        if (linked) activation = linked;
        else warn(`Item TARGET: linked skill ${linkedUuid} not resolvable; using item as activation`);
      }
      const view = getRuntimeActionView(activation);
      const skillTargetText = String(activation.system?.props?.skill_target ?? "").trim();
      const itemTargeting = await resolveActionTargets(director, attackerSnap, {
        skillTargetText,
        attackerActor,
        skill: activation,
        usingPreComposed:    true,
        composedTargetUuids: bundle.targetUuids,
        titleText:           null,
      });
      if (!itemTargeting.ok) {
        director.dispatch({ type: (itemTargeting.cancelled || itemTargeting.reason === "no_eligible") ? INTENTS.TARGET_BACK : INTENTS.ABORT });
        return;
      }
      const targets = itemTargeting.targets;
      const targetUuids = itemTargeting.targetUuids;

      // Cost — "create" debits IP (standard cost resource); "use" consumes the
      // item itself (paid in resolveAction). Affordability gate for the IP case.
      const itemMode = String(bundle.itemMode ?? "use");
      const itemCost = Number(bundle.itemCost ?? 0) || 0;
      const costMap = new Map();
      if (itemMode === "create" && itemCost > 0) costMap.set("ip", itemCost);
      const gate = checkAffordable(attackerActor, costMap);
      if (!gate.ok) {
        const missing = gate.missing.map((m) => `${m.label}: ${m.has}/${m.need}`).join(", ");
        ui.notifications?.warn(`Can't create ${consumable.name} — missing ${missing}.`);
        director.enqueue({ type: INTENTS.TARGET_BACK });
        return;
      }

      const ap = activation.system?.props ?? {};
      director.ctx.actionResult = freezeActionResult({
        // Action kind stays "Item" so the creature_uses_item / completes_item
        // triggers + Item-card UI fire; resolveAction still finds the backing
        // skill via skillUuid, so the shared Skill COMPUTE/RESOLVE path runs.
        kind: "Item",
        attacker: attackerSnap,
        attackerActorRef: attackerSnap.actorUuid,
        // Effects/Check resolve from the linked activation skill…
        skillUuid: activation.uuid,
        // …but the card displays the item the player actually used.
        skillName: consumable.name,
        skillImg: consumable.img,
        skillType: String(ap.skill_type ?? ""),
        defenseTargetType: String(ap.defense_target_type ?? "").toLowerCase(),
        isCheck: !!ap.isCheck,
        rolledA1: String(ap.rolled_atr1 ?? "").toUpperCase(),
        rolledA2: String(ap.rolled_atr2 ?? "").toUpperCase(),
        checkBonus: Number(ap.check_bonus ?? 0) || 0,
        damageBonus: ap.damage_bonus ?? 0,
        damageType: String(ap.type_damage ?? ""),
        skillRange: String(ap.skill_range ?? ""),
        skillTarget: skillTargetText,
        // Consume THIS item on resolve (the carrier), regardless of which skill
        // drove the effect. [[edit-master-not-copy]] — sourceItemUuid is the
        // owned consumable, not the shared skill master.
        sourceItemUuid: bundle.sourceItemUuid ?? consumable.uuid,
        descriptionHtml: String(ap.description ?? consumable.system?.props?.description ?? ""),
        targets,
        costSerialized: serializeCostMap(costMap),
        rawCost: itemMode === "create" ? `${itemCost} IP` : "",
        actionIntent: classifyActionIntent(activation),
        itemSelection: { mode: itemMode, key: bundle.itemKey ?? null, cost: itemCost },
      });
      director.ctx.pickedTargetUuids = targetUuids;
      director.dispatch({
        type: INTENTS.TARGET_PICKED,
        body: { targetTokenUuids: targetUuids },
      });
      return;
    }

    if (command !== "Attack") {
      // Stub: any other command shows a notification and returns to DECLARE
      ui.notifications?.info(`"${command}" is not implemented in Director v1. Pick Attack, Guard, Study, Hinder, Equipment, Item, Skill, or Spell.`);
      director.enqueue({ type: INTENTS.TARGET_BACK });
      return;
    }

    // Multi-pass re-entry detection. When CLEANUP loops back here for the
    // second pass of a two-weapon attack, attackMode is already set and
    // pendingPasses still has weapons to roll. Skip the weapon-mode picker
    // and the queue setup — just re-pick targets for the next weapon.
    // Both two-weapon variants ("two-weapon" main-first, "two-weapon-off-first")
    // count.
    const attacker = director.ctx.turnSnapshot;
    const isTwoWeaponAny = String(director.ctx.attackMode ?? "").startsWith("two-weapon");
    const isMultiPassReEntry = isTwoWeaponAny
      && Array.isArray(director.ctx.pendingPasses)
      && director.ctx.pendingPasses.length > 0
      && (director.ctx.passIndex ?? 0) >= 1;

    if (!isMultiPassReEntry) {
      // NPC branch — single pass, pseudo-weapon built from the chosen
      // Attack Item (`composeAttackNpc` passed its UUID in the bundle).
      // No weapon-mode picker (NPCs don't dual-wield in BD).
      if (director.ctx.attackMode === "npc") {
        const itemUuid = director.ctx._composedBundle?.npcAttackItemUuid
          ?? director.ctx.npcAttackItemUuid
          ?? null;
        let item = null;
        try { item = itemUuid ? await fromUuid(itemUuid) : null; } catch {}
        if (!item) {
          ui.notifications?.warn(`${attacker.name} has no usable Attack.`);
          warn("TARGET Attack (NPC): could not resolve attack item", itemUuid);
          director.enqueue({ type: INTENTS.TARGET_BACK });
          return;
        }
        const pseudo = buildPseudoWeaponFromNpcAttack(item);
        if (!pseudo) {
          ui.notifications?.warn(`${attacker.name}'s Attack is missing attribute or damage data.`);
          warn("TARGET Attack (NPC): buildPseudoWeapon returned null", item.name);
          director.enqueue({ type: INTENTS.TARGET_BACK });
          return;
        }
        director.ctx.weaponsUsed = [pseudo];
        director.ctx.pendingPasses = [pseudo];
        director.ctx.totalPasses = 1;
        director.ctx.passIndex = 0;
        director.ctx.npcAttackItemUuid = itemUuid;
        log(`TARGET (Attack/NPC): pseudo-weapon "${pseudo.name}" (${pseudo.A1}/${pseudo.A2}, +${pseudo.checkBonus}/+${pseudo.damageBonus} ${pseudo.damageType})`);
      } else {
      // First entry — weapon-mode picker + pendingPasses setup.
      // RAW Core p.69 + house policy:
      //   - Both hands equipped → picker appears (Main + Off; Two-Weapon
      //     option only when same Category per RAW). Off-Hand always
      //     available when off-hand is equipped.
      //   - Only main equipped → no picker; main is used.
      //   - Only off equipped → no picker; off is used.
      const hasMain = !!attacker.weapon;
      const hasOff = !!attacker.offWeapon;
      const virtualAttacks = Array.isArray(attacker.virtualAttacks) ? attacker.virtualAttacks : [];
      const hasVirtual = virtualAttacks.length > 0;
      if (!hasMain && !hasOff && !hasVirtual) {
        ui.notifications?.warn(`${attacker.name} has no usable weapon.`);
        warn("TARGET Attack: no weapon equipped", attacker.name);
        director.enqueue({ type: INTENTS.TARGET_BACK });
        return;
      }
      let attackMode = "main";
      // Pre-populated by composeAction's bundle (player- or GM-driven
      // race winner). When set, skip the weapon-mode picker — the
      // decision was already made client-side.
      if (director.ctx.attackMode) {
        attackMode = director.ctx.attackMode;
        log(`TARGET (Attack): using pre-composed attackMode=${attackMode}`);
      } else {
        const totalRealOptions = (hasMain ? 1 : 0) + (hasOff ? 1 : 0);
        const needsPicker = totalRealOptions + virtualAttacks.length > 1;
        if (needsPicker) {
          const picked = await pickWeaponMode({
            director,
            mainWeapon: attacker.weapon,
            offWeapon: attacker.offWeapon,
            allowTwoWeapon: !!attacker.canTwoWeaponFight,
            twoWeaponSolo: !!attacker.twoWeaponSolo,
            virtualAttacks,
          });
          if (!picked) {
            director.enqueue({ type: INTENTS.TARGET_BACK });
            return;
          }
          attackMode = picked;
        } else if (hasVirtual && !hasMain && !hasOff) {
          attackMode = "virtual:0";
        } else if (hasOff && !hasMain) {
          attackMode = "off";
        }
      }
      // Two-weapon: each pass is its OWN action card (separate confirm +
      // resolve + reaction window + target pick) so reactions can fire
      // between passes and the player can pick different targets per RAW.
      // The picker offers two variants of Two-Weapon — main-first
      // ("two-weapon") and off-first ("two-weapon-off-first") — because
      // RAW lets the player choose order (Core p.69: "you perform the two
      // attacks in any order you prefer").
      // virtual:N modes single-pass; the synthesised profile is the
      // sole weapon for that attack (Twin Shields is RAW two-handed).
      const weaponsUsed = attackMode.startsWith("virtual:")
        ? [virtualAttacks[Number(attackMode.slice("virtual:".length)) | 0]].filter(Boolean)
        : (attackMode === "two-weapon")
          ? [attacker.weapon, attacker.offWeapon]
          : (attackMode === "two-weapon-off-first")
            ? [attacker.offWeapon, attacker.weapon]
            : (attackMode === "off" ? [attacker.offWeapon] : [attacker.weapon]);
      director.ctx.attackMode = attackMode;
      director.ctx.weaponsUsed = weaponsUsed;
      director.ctx.pendingPasses = [...weaponsUsed];   // shifted by COMPUTE
      director.ctx.totalPasses = weaponsUsed.length;
      director.ctx.passIndex = 0;
      } // end PC weapon-mode branch
    }

    // Both first-entry and multi-pass re-entry: resolve targets via the
    // unified targeting resolver. The weapon's skill_target text drives
    // mode/category/count — "One Enemy" for basic weapons, "One Random
    // Creature" for roulette-style, "All Enemy" for AoE, etc.
    // hasRoulette on older weapons is bridged to "One Random Creature"
    // during the transition; authors should migrate to skill_target.
    const currentWeapon = director.ctx.pendingPasses?.[0];
    const weaponSkillTarget = currentWeapon?.hasRoulette
      ? "One Random Creature"
      : (currentWeapon?.skillTarget || "One Enemy");

    // Build multi-pass title + cancel label.
    const totalPasses    = director.ctx.totalPasses ?? 1;
    const currentPassNum = (director.ctx.passIndex ?? 0) + 1;
    let attackTitle, attackCancelLabel;
    if (totalPasses > 1) {
      const hand = currentWeapon?.hand === "off" ? "Off-Hand" : "Main Hand";
      attackTitle = `${attacker.name}'s ${currentWeapon?.name ?? "weapon"} — ${hand} (${currentPassNum}/${totalPasses})`;
      attackCancelLabel = isMultiPassReEntry ? "Skip Second Attack" : "Cancel";
    } else {
      attackTitle = /\brandom\b/i.test(weaponSkillTarget)
        ? `${attacker.name}: randomizing target for Attack`
        : `Pick a target for ${attacker.name}'s Attack`;
      attackCancelLabel = "Cancel";
    }

    // RAW Core p.70 — Covered creatures can't be melee-targeted. The
    // range gate is passed as a post-filter so the unified resolver still
    // builds the full category pool (needed for random/creature modes)
    // and then applies coverage + Vanish exclusions on top.
    const attackTargeting = await resolveActionTargets(director, attacker, {
      skillTargetText:    weaponSkillTarget,
      excludeSelf:        true,
      eligiblePostFilter: (pool) => applyAttackRangeGate(pool, currentWeapon),
      usingPreComposed:   !isMultiPassReEntry,
      composedTargetUuids: director.ctx.pickedTargetUuids,
      titleText:          attackTitle,
      cancelLabel:        attackCancelLabel,
    });

    // Pass 1 pre-composed UUIDs are consumed; pass 2 always re-prompts.
    if (!isMultiPassReEntry) director.ctx.pickedTargetUuids = null;

    if (!attackTargeting.ok) {
      if (isMultiPassReEntry && attackTargeting.cancelled) {
        // Skip remaining passes — first pass already committed.
        director.ctx.pendingPasses = [];
        director.ctx.abortReason = "two-weapon: second pass skipped by player";
        director.dispatch({ type: INTENTS.ABORT });
        return;
      }
      // Empty-pool with Covered enemies deserves a specific message.
      if (attackTargeting.reason === "no_eligible" && !isMultiPassReEntry) {
        const eligibleRaw = director.dCombat
          ? snapshotEligibleTargetsFromDCombat(director.dCombat, attacker, { category: "enemy" })
          : snapshotEligibleTargets(director.combat, attacker, { category: "enemy" });
        const gate = applyAttackRangeGate(eligibleRaw, currentWeapon);
        if (isMeleeAttack && eligibleRaw.length > 0 && gate.length === 0) {
          ui.notifications?.warn("All eligible enemies are Covered — switch to a ranged weapon or pick a different action.");
          director.ctx.pendingPasses = [];
          director.dispatch({ type: INTENTS.TARGET_BACK, body: { reason: "all-covered" } });
          return;
        }
      }
      if (isMultiPassReEntry && attackTargeting.reason === "no_eligible") {
        ui.notifications?.warn("No targets remaining for the second attack.");
        director.ctx.pendingPasses = [];
        director.dispatch({ type: INTENTS.ABORT, body: { reason: "second pass: no targets left" } });
        return;
      }
      director.dispatch({ type: (attackTargeting.cancelled || attackTargeting.reason === "no_eligible") ? INTENTS.TARGET_BACK : INTENTS.ABORT });
      return;
    }
    director.ctx.pickedTargetUuids = [...attackTargeting.targetUuids];
    director.dispatch({ type: INTENTS.TARGET_PICKED, body: { targetTokenUuids: attackTargeting.targetUuids } });
  },
};

// ── COMPUTE plugins ────────────────────────────────────────────────────
// Per-command COMPUTE handlers, extracted from Compute.onEnter so the state is
// a thin dispatcher (one registry entry per action kind). Each builds
// director.ctx.actionResult and enqueues INTERNAL_DONE (or ABORT). They share
// the pipeline shape: resolve params → check (rollCheck/computeActionProfile) →
// build result.

// Hinder — check vs a GM-set DL (RAW Core p.71); on success the player picks a
// status (dazed/shaken/slow/weak) at the card before RESOLVE.
async function computeHinder(director, { attacker, tokenUuids }) {
  const targetUuid = tokenUuids[0];
  const targetSnap = (director.ctx.eligibleTargets ?? []).find((e) => e.tokenUuid === targetUuid);
  if (!targetSnap) {
    warn("COMPUTE Hinder: target not found in eligibleTargets", targetUuid);
    director.enqueue({ type: INTENTS.ABORT });
    return;
  }

  // Check config — read attrs / DL FROM the Hinder Common item (authored data);
  // the live GM attribute-picker result (hinderCheckConfig, set in TARGET)
  // overrides the authored defaults. Falls back to RAW values if the Common-item
  // migration hasn't run on this world yet.
  const hinderProps = getCoreActionSkill("hinder")?.system?.props ?? {};
  const cfg = director.ctx.hinderCheckConfig ?? {};
  const A1 = String(cfg.A1 ?? hinderProps.rolled_atr1 ?? "DEX").toUpperCase();
  const A2 = String(cfg.A2 ?? hinderProps.rolled_atr2 ?? "INS").toUpperCase();
  const DL = Math.max(1, Number(cfg.dl) || Number(hinderProps.check_difficulty_level) || 10);

  // Free-action grant — add checkBonus to Hinder's roll if a grant is pending
  // and the player elected Hinder. damageBonus n/a (no damage stage for Hinder).
  const hinderActorIdForGrant = attacker?.actorId ?? null;
  const hinderGrant = hinderActorIdForGrant ? freeActions.get(hinderActorIdForGrant) : null;
  const hinderCheckBonus = hinderGrant ? Number(hinderGrant.checkBonus) || 0 : 0;
  const hinderCheckBonusParts = [];
  if (hinderGrant && hinderCheckBonus !== 0) {
    hinderCheckBonusParts.push({
      source: hinderGrant.sourceLabel || "Free Action",
      amount: hinderCheckBonus,
    });
  }
  if (hinderGrant) {
    log(`Hinder COMPUTE: applied ${hinderGrant.sourceLabel} grant (+${hinderGrant.checkBonus ?? 0} check)`);
    freeActions.clear(hinderActorIdForGrant);
  }

  // BD-canonical check (roll + prop-aware crit/fumble) + vs-DL comparison.
  const liveActor = await fromUuid(attacker.actorUuid).catch(() => null);
  const check = await rollCheck({ actor: liveActor, A1, A2, checkBonus: hinderCheckBonus });
  const { rA, rB, dA, dB, total, hr, isFumble, isCrit } = check;
  const { success } = checkVsThreshold(check, DL);

  director.ctx.actionResult = freezeActionResult({
    kind: "Hinder",
    attacker,
    attackerActorRef: attacker.actorUuid,
    target: targetSnap,
    targets: [targetSnap],
    roll: {
      A1, A2,
      dA, dB, rA, rB, checkBonus: hinderCheckBonus, checkBonusParts: hinderCheckBonusParts, total, hr,
      isCrit, isFumble,
      opportunities: isCrit && !isFumble,
    },
    dl: DL,
    success,
    // The inflicted status is chosen at RESOLVE via Common/Hinder's
    // open_action_menu (not stored on the frozen actionResult).
    ...(hinderGrant ? { freeActionGrant: { sourceLabel: hinderGrant.sourceLabel, checkBonus: hinderGrant.checkBonus ?? 0, damageBonus: 0 } } : {}),
  });
  director.enqueue({ type: INTENTS.INTERNAL_DONE });
}

// Study — open check (RAW Core p.46-47), no defense; total maps to encyclopedia
// tiers (Identity >=7 / Stats >=8 / Details >=13).
async function computeStudy(director, { attacker, tokenUuids }) {
  const targetUuid = tokenUuids[0];
  const targetSnap = (director.ctx.eligibleTargets ?? []).find((e) => e.tokenUuid === targetUuid);
  if (!targetSnap) {
    warn("COMPUTE Study: target not found in eligibleTargets", targetUuid);
    director.enqueue({ type: INTENTS.ABORT });
    return;
  }

  // Check config — read attrs FROM the Study Common item (authored data, like
  // Hinder). Open Check (default INS+INS); prop-aware crit/fumble.
  const studyProps = getCoreActionSkill("study")?.system?.props ?? {};
  const A1 = String(studyProps.rolled_atr1 ?? "INS").toUpperCase();
  const A2 = String(studyProps.rolled_atr2 ?? "INS").toUpperCase();
  const liveActor = await fromUuid(attacker.actorUuid).catch(() => null);
  const check = await rollCheck({ actor: liveActor, A1, A2 });
  const { rA, rB, dA, dB, total, hr, isFumble, isCrit } = check;

  // Encyclopedia tier classification — the SINGLE source of truth lives in the
  // encyclopedia (crit-aware: a critical Study reveals Details regardless of raw
  // total, matching recordResult, so the card can never disagree with what gets
  // stored). Falls back to the raw-total ladder only if the API isn't mounted.
  const encApi = globalThis.FUCompanion?.api?.encyclopedia;
  const tier = encApi?.classifyStudyTotal
    ? encApi.classifyStudyTotal(total, { isCrit, isFumble })
    : (isFumble        ? { name: "None",     threshold: 0,  fumbled: true,  effective: 0 }
       : total >= 13   ? { name: "Details",  threshold: 13, fumbled: false, effective: total }
       : total >= 8    ? { name: "Stats",    threshold: 8,  fumbled: false, effective: total }
       : total >= 7    ? { name: "Identity", threshold: 7,  fumbled: false, effective: total }
       :                 { name: "None",     threshold: 0,  fumbled: false, effective: total });

  // Current best result for the target — so the card can show whether this Study improved on it.
  let previousBest = 0;
  if (encApi?.getPageForActor) {
    const candidates = [targetSnap.worldActorUuid, targetSnap.actorUuid].filter(Boolean);
    for (const uuid of candidates) {
      try {
        const page = encApi.getPageForActor(uuid);
        if (!page) continue;
        const flag = page.getFlag?.("fabula-ultima-companion", "encyclopedia");
        const best = Number(flag?.bestResult ?? 0) || 0;
        if (best > previousBest) previousBest = best;
      } catch (_) { /* try next candidate */ }
    }
  }

  director.ctx.actionResult = freezeActionResult({
    kind: "Study",
    attacker,
    attackerActorRef: attacker.actorUuid,
    target: targetSnap,
    targets: [targetSnap],
    roll: {
      A1, A2,
      dA, dB, rA, rB, checkBonus: 0, total, hr,
      isCrit, isFumble,
      opportunities: isCrit && !isFumble,
    },
    tier,
    previousBest,
    // Compare the crit-promoted effective total (what recordResult stores), so a
    // low-roll crit that floors up to Details still reads as an improvement.
    improved: !isFumble && (tier.effective ?? total) > previousBest,
  });
  director.enqueue({ type: INTENTS.INTERNAL_DONE });
}

// ─── COMPUTE ───────────────────────────────────────────────────────────
// Roll accuracy + damage. Build an immutable actionResult.
const Compute = {
  async onEnter(director, { triggerIntent }) {
    const command = director.ctx.declaredCommand;
    const attacker = director.ctx.turnSnapshot;
    // Multi-pass attacks (Two-Weapon Fighting): the SECOND COMPUTE is
    // triggered by CLEANUP→INTERNAL_DONE which has no body. Fall back to
    // the ctx-persisted target UUIDs that TARGET stamped.
    const tokenUuids = (triggerIntent?.body?.targetTokenUuids?.length
      ? triggerIntent.body.targetTokenUuids
      : director.ctx.pickedTargetUuids ?? []);

    if (command === "Guard" || command === "Equipment") {
      // Guard/Equipment actionResult was already shaped in TARGET — both are
      // no-roll menu declarations. Pass through to CONFIRM where the card
      // collects the player's pick (cover target / equipment slots).
      director.enqueue({ type: INTENTS.INTERNAL_DONE });
      return;
    }

    if (command === "Skill" || command === "Spell" || command === "Item") {
      // Skill / Spell COMPUTE: roll the Check (if isCheck), compute
      // per-target damage (if type_damage set), per-target affinity
      // routing. Skill effects (on_activate / post_damage) fire in
      // RESOLVE. Both commands share this branch — the actionResult
      // built in TARGET carries `kind: "Skill"` for both, so RESOLVE
      // doesn't need a separate Spell branch either.
      const ar = director.ctx.actionResult;
      const targetSnaps = (director.ctx.eligibleTargets ?? ar.targets ?? [])
        .filter((e) => tokenUuids.includes(e.tokenUuid));
      const allTargets = targetSnaps.length ? targetSnaps : (ar.targets ?? []);

      // ── Single-source COMPUTE ────────────────────────────────────────────
      // Derive the ENTIRE actionResult from computeActionProfile (the
      // Target→Check→Effects builder) + project it back to the legacy ar shape.
      // Replaces the former hand-built per-target / damage / heal / roll
      // derivation (the COMPUTE-side half of the pre-roll/post-roll/recompute
      // divergence). Proven zero-diff vs the old derivation across dmgSpell
      // (hit/crit/miss/multi), heal, legacy item, status-only spell, pure-buff —
      // see verify-profile-projection.mjs.
      const skill = await fromUuid(ar.skillUuid).catch(() => null);
      const view = getRuntimeActionView(skill);

      // ── pre_activate: capture player choices BEFORE the card is built ──
      // Choice rows (prompt_element / open_action_menu) prompt now, in capture
      // mode (record-only, nothing applied). Their picks are persisted onto the
      // actionResult and replayed at RESOLVE so the cast animation flows straight
      // into damage with no mid-resolve prompt. Cancelling a pick ABORTS the
      // whole action (nothing spent — the card is never built). Only runs when
      // the skill declares a pre_activate_effect_ref.
      let preActivateVars = ar.preActivateVars ?? null;
      let preActivateMenuPicks = ar.preActivateMenuPicks ?? null;
      const preRef = String(view?.fire_points?.pre_activate_effect_ref
        ?? skill?.system?.props?.pre_activate_effect_ref ?? "").trim();
      if (preRef && !ar.preActivateDone) {
        try {
          const casterActor = await fromUuid(attacker.actorUuid).catch(() => null);
          const capToken = canvas?.tokens?.get(attacker?.tokenId)?.document ?? null;
          const allUuids = (allTargets ?? []).map((t) => t.tokenUuid);
          const capCtx = makeChainContext({
            reactorActor: casterActor, reactorToken: capToken, skill, dCombat: director.dCombat,
            payload: { targets: allUuids, hitTargets: allUuids, actionIntent: ar.actionIntent },
            actionTargetUuids: allUuids, hitActionTargetUuids: allUuids,
            isPassive: false, runtimeEffectTable: view.effect_table, firePoints: view.fire_points,
            harnessPicks: ar?._harnessPicks ?? null, harnessNumbers: ar?._harnessNumbers ?? null,
          });
          const pre = await fireActivationEffectPre(skill, capCtx);
          if (pre?.abort) {
            // Player cancelled a choice (element / status pick) → return to the
            // Action Menu to re-pick, NOT a full abort. The card was never built,
            // so nothing is spent. (COMPUTE → DECLARE via TARGET_BACK.)
            log("Skill COMPUTE: pre_activate cancelled by player — back to Action Menu (nothing spent)");
            director.enqueue({ type: INTENTS.TARGET_BACK });
            return;
          }
          preActivateVars = capCtx.payload?._chainVars ?? null;
          preActivateMenuPicks = capCtx.payload?._capturedMenuPicks ?? null;
        } catch (e) { warn("Skill COMPUTE: pre_activate capture threw", e); }
      }

      // Roll the Check dice here (the RNG); computeActionProfile derives total /
      // hr / crit / fumble + per-target outcomes from them. No roll = no Check.
      let dice = null;
      if (ar.isCheck) {
        // Roll via the shared check primitive (computeActionProfile re-derives
        // crit/fumble from these dice). Last of the BD's raw roll sites unified.
        const liveActor = await fromUuid(attacker.actorUuid).catch(() => null);
        const c = await rollCheck({ actor: liveActor, A1: ar.rolledA1 || "INS", A2: ar.rolledA2 || "INS" });
        dice = { rA: c.rA, rB: c.rB };
      }
      const profile = await computeActionProfile({
        view, ar, attacker, targets: allTargets, dice,
        // chainVars lets the card preview resolve a VAR_<NAME> element (the
        // pre_activate element pick) to its real type instead of "varies".
        ctx: { round: director.dCombat?.round ?? 0, chainVars: preActivateVars },
      });
      director.ctx.actionResult = freezeActionResult({
        ...ar,
        ...projectProfileToActionResult(profile, ar, allTargets),
        targets: allTargets,
        // Persist the captured pre_activate picks so RESOLVE replays them.
        preActivateVars, preActivateMenuPicks, preActivateDone: true,
      });
      director.enqueue({ type: INTENTS.INTERNAL_DONE });
      return;
    }


    if (command === "Attack") {
      // Pop the next weapon to roll for from the ctx queue. The queue was
      // set up in TARGET. For single-weapon attacks there's one entry; for
      // two-weapon there are two and CLEANUP loops back here for the
      // second pass.
      //
      // RAW Core p.69 — two-weapon HR=0 for BOTH passes.
      const queue = director.ctx.pendingPasses ?? [attacker.weapon];
      const weapon = queue.shift();
      if (!weapon) {
        ui.notifications?.warn(`${attacker.name} has no usable weapon.`);
        warn("COMPUTE Attack: no weapon in queue", attacker.name);
        director.enqueue({ type: INTENTS.ABORT });
        return;
      }
      director.ctx.pendingPasses = queue;          // keep mutated remainder for CLEANUP branch
      director.ctx.currentWeapon = weapon;
      director.ctx.passIndex = (director.ctx.passIndex ?? 0) + 1;
      // (Studied-mask gate, fumble threshold, forced-VU, two-weapon HR=0 and the
      // whole per-target hit/damage/affinity derivation now live in
      // computeActionProfile — see the Single-source COMPUTE block below.)

      // Defend against eligibleTargets being null (shouldn't happen on the
      // first pass since TARGET sets it; the multi-pass loop preserves it
      // in CLEANUP, but defend anyway).
      const targetSnapshots = (director.ctx.eligibleTargets ?? [])
        .filter((e) => tokenUuids.includes(e.tokenUuid));
      if (targetSnapshots.length === 0 && tokenUuids.length > 0) {
        warn("COMPUTE Attack: tokenUuids provided but no matches in eligibleTargets",
             { tokenUuids, eligibleCount: (director.ctx.eligibleTargets ?? []).length });
      }

      // ── Single-source COMPUTE (Attack) ───────────────────────────────────
      // Roll the accuracy dice here (RNG); computeActionProfile derives total /
      // hr / crit / fumble + per-target hit/damage/affinity/pierce and folds the
      // free-action grant (check + damage + HR-as-0) + actor-status accuracy /
      // outgoing-damage mods + damageBonusParts breakdown. projectProfileToActionResult
      // maps it to the legacy Attack ar fields. Proven zero-diff vs the old
      // derivation across 4 attackers × hit/crit/miss/multi (verify-attack-projection.mjs).
      // Free-action grant — read + CONSUME (commitment-on-pick: a CONFIRM cancel
      // still spends it). The grant folds into the profile via ctx.grant.
      const attackerActorIdForGrant = attacker?.actorId ?? null;
      const attackGrant = attackerActorIdForGrant ? freeActions.get(attackerActorIdForGrant) : null;
      if (attackGrant) {
        log(`Attack COMPUTE: applied ${attackGrant.sourceLabel} grant (+${attackGrant.checkBonus ?? 0} check / +${attackGrant.damageBonus ?? 0} dmg)`);
        freeActions.clear(attackerActorIdForGrant);
      }
      {
        // Roll via the shared check primitive (computeActionProfile re-derives
        // crit/fumble from these dice). Last of the BD's raw roll sites unified.
        const liveActor = await fromUuid(attacker.actorUuid).catch(() => null);
        const c = await rollCheck({ actor: liveActor, A1: weapon.A1, A2: weapon.A2 });
        const profile = await computeActionProfile({
          view: { kind: "Attack", check_mode: "opposed", effect_table: {}, fire_points: {}, source: null },
          attacker, weapon, targets: targetSnapshots, dice: { rA: c.rA, rB: c.rB },
          ctx: { round: director.dCombat?.round ?? 0, attackMode: director.ctx.attackMode, grant: attackGrant },
        });
        const delta = projectProfileToActionResult(profile, null, targetSnapshots);
        director.ctx.actionResult = freezeActionResult({
          kind: "Attack",
          attacker,
          attackerActorRef: attacker.actorUuid,
          weapon,
          attackMode: director.ctx.attackMode ?? "main",
          passIndex: director.ctx.passIndex,
          totalPasses: director.ctx.totalPasses,
          targets: targetSnapshots,
          roll: delta.roll,
          damage: delta.damage,
          perTargetResults: delta.perTargetResults,
          ...(attackGrant ? { freeActionGrant: { sourceLabel: attackGrant.sourceLabel, checkBonus: attackGrant.checkBonus ?? 0, damageBonus: attackGrant.damageBonus ?? 0 } } : {}),
        });
        director.enqueue({ type: INTENTS.INTERNAL_DONE });
        return;
      }
    }


    if (command === "Hinder") return computeHinder(director, { attacker, tokenUuids });

    if (command === "Study") return computeStudy(director, { attacker, tokenUuids });

    // Unknown command — shouldn't happen if TARGET filtered correctly.
    warn("COMPUTE: unknown command", command);
    director.enqueue({ type: INTENTS.ABORT });
  },
};

// ─── CONFIRM ───────────────────────────────────────────────────────────
const Confirm = {
  async onEnter(director) {
    const ar = director.ctx.actionResult;
    if (!ar) {
      warn("CONFIRM with no actionResult");
      director.enqueue({ type: INTENTS.ABORT });
      return;
    }
    // Resolve the attacker actor for the chat speaker
    let attackerActor = null;
    try { attackerActor = await fromUuid(ar.attackerActorRef ?? ar.attacker.actorUuid); } catch {}

    // Resolve token actor (synthetic overlay for unlinked NPC tokens) to gate invoke capability.
    // Must use the token doc's .actor, not the world actor, since unlinked tokens may differ.
    let _tokenActor = attackerActor;
    try {
      if (ar.attacker?.tokenUuid) {
        const _tokenDoc = await fromUuid(ar.attacker.tokenUuid);
        if (_tokenDoc?.actor) _tokenActor = _tokenDoc.actor;
      }
    } catch {}
    const invokeCapability = getInvokeCapability(_tokenActor);
    const _iProps = _tokenActor?.system?.props ?? {};
    const _up = Number(_iProps.ultima_point ?? 0) || 0;
    const _fp = Number(_iProps.fabula_point ?? 0) || 0;
    const invokePointCount = invokeCapability === "trait-only" ? _up : invokeCapability === "full" ? _fp : null;

    // Persistence checkpoint — "Action Posted / Card Live".
    //
    // Two reasons we save here for ALL kinds (not just Skill):
    //   1. Rewind: this is the no-go-back point for reactable cards
    //      (Attack/Skill/Spell) — once visible, passive reactions can
    //      fire (Phase F+). The label "{Name} · {kind} posted" lets the
    //      GM jump back here before the card was committed.
    //   2. Reload survival: stamps `pendingAction` (actionResult + a
    //      slim ctx subset) on the survival flag so an F5 mid-card
    //      lands the GM back on the SAME card via resumeFromSavedState
    //      → transitionTo(CONFIRM), instead of dumping them back at the
    //      action picker. Cleared the moment the card resolves below.
    //
    // When we re-entered CONFIRM via resumeFromSavedState, the survival
    // flag already holds the exact same payload from the pre-reload
    // save. Re-saving would duplicate the rewind history entry, so the
    // resume path sets a one-shot flag and we skip the save.
    if (director.ctx._resumedFromPendingAction) {
      delete director.ctx._resumedFromPendingAction;
    } else {
      const dc = director.dCombat;
      const passTag = (ar.totalPasses ?? 1) > 1
        ? ` (pass ${ar.passIndex}/${ar.totalPasses})`
        : "";
      const verbForKind = ar.kind === "Skill" ? "cast" : "posted";
      const kindLabel = ar.kind === "Skill"
        ? (ar.skillName ?? "Skill")
        : ar.kind;
      const cnfPhase = rewindPhaseLabel(director.ctx, dc?.round);
      saveDirectorState(director, {
        label: `${cnfPhase} · ${ar.attacker?.name ?? "?"} · ${kindLabel} ${verbForKind}${passTag}`,
        description: describeActionForRewind(ar),
        pendingAction: {
          actionResult: ar,
          // Slim ctx subset — only the fields downstream handlers
          // (RESOLVE / CLEANUP / next-pass COMPUTE) need to behave
          // identically to the un-reloaded path. We exclude
          // eligibleTargets (re-derived) and turnSnapshot (resume
          // re-derives via dCombat.current).
          ctx: {
            passIndex: director.ctx.passIndex ?? 0,
            totalPasses: director.ctx.totalPasses ?? 0,
            attackMode: director.ctx.attackMode ?? null,
            pendingPasses: director.ctx.pendingPasses ?? null,
            pickedTargetUuids: director.ctx.pickedTargetUuids ?? null,
            currentWeapon: director.ctx.currentWeapon ?? null,
            hinderCheckConfig: director.ctx.hinderCheckConfig ?? null,
            declaredCommand: director.ctx.declaredCommand ?? null,
          },
        },
      }).catch((e) => warn("CONFIRM: saveDirectorState failed", e));

    }

    // Pre-resolve passive evaluation — "during action card" reactions
    // that manipulate the active action's values (Healing Power,
    // Support Magic, etc.). Each candidate gets a pill on the action
    // card so the player can opt in/out BEFORE Confirm. The decisions
    // are stashed in actionResult.acceptedPrePassives, and RESOLVE
    // applies them via firePreAcceptedCandidate. The post-resolve
    // `creature_completes_spell` dispatcher at line ~387 then skips
    // any candidate already evaluated here (no double-fire).
    //
    // Currently scoped to Spell-type actions whose trigger matches
    // `creature_completes_spell` (the only canonically pre-resolve
    // trigger in the system today). The classification should grow to
    // a trigger-phase registry as more pre-resolve triggers land
    // (caster_short_on_mp is already pre-resolve via the cost gate;
    // start_of_turn etc. are standalone, no card).
    let prePassives = [];

    // Spell-side dispatch — creature_completes_spell. Action-level (not
    // per-target). Healing Power + Support Magic chain off this.
    if (ar.kind === "Skill" && ar.skillType?.toLowerCase() === "spell" && attackerActor) {
      try {
        const { findPassiveCandidates } = await getSkillEffectsExtras();
        prePassives = await findPassiveCandidates({
          casterActor: attackerActor,
          trigger: "creature_completes_spell",
          payload: {
            spellUuid: ar.skillUuid ?? null,
            spellName: ar.skillName ?? null,
            targetTokenUuids: (ar.targets ?? []).map((t) => t.tokenUuid),
            hitTargetTokenUuids: Array.isArray(ar.hitTokenUuids) ? ar.hitTokenUuids : (ar.targets ?? []).map((t) => t.tokenUuid),
            sourceTokenUuid: ar.attacker?.tokenUuid ?? null,
            sourceActorUuid: ar.attackerActorRef,
            actionIntent: ar.actionIntent,
          },
        });
      } catch (e) {
        warn("CONFIRM: findPassiveCandidates threw", e);
      }
    }

    // Item-side dispatch — creature_uses_item. Fires DURING the Item action
    // card so a player can react BEFORE the item resolves (pills on the card).
    // Action-level (once per action). The post-resolve counterpart is
    // creature_completes_item (queued in resolveAction). Payload carries
    // actionKind so reactions can discriminate by action type.
    if (ar.kind === "Item" && attackerActor) {
      try {
        const { findPassiveCandidates } = await getSkillEffectsExtras();
        const itemCands = await findPassiveCandidates({
          casterActor: attackerActor,
          trigger: "creature_uses_item",
          payload: {
            targetTokenUuids: (ar.targets ?? []).map((t) => t.tokenUuid),
            targets: (ar.targets ?? []).map((t) => t.tokenUuid),
            sourceTokenUuid: ar.attacker?.tokenUuid ?? null,
            sourceActorUuid: ar.attackerActorRef,
            actionIntent: ar.actionIntent,
            actionKind: ar.kind,
            actionName: ar.skillName ?? ar.kind,
          },
        });
        for (const cand of itemCands ?? []) prePassives.push(cand);
      } catch (e) {
        warn("CONFIRM: creature_uses_item findPassiveCandidates threw", e);
      }
    }

    // Phase 3: creature_will_deal_damage — single-fire-per-action,
    // pre-resolve base-damage modification hook. Fires for Attack-kind
    // and damage-dealing Skill-kind (isOffensive + hasDamage).
    //
    // RAW rule (per playtest 2026-05-31): a single action triggers a
    // reaction at most ONCE, even if it hits N targets. The reaction's
    // EFFECT can vary per-target (e.g. Cheap Shot's +5 damage only on
    // targets with ≥2 statuses), but the OFFER is once. We evaluate the
    // row's gates per-target during matching (filters can be per-target
    // — damage_type, condition_formula referencing TARGET_STATUS_COUNT,
    // etc.) and AGGREGATE the candidates by (rowKey, carrierUuid). Each
    // aggregated candidate carries `appliesToTargetUuids` listing every
    // target for which the row matched; the sender-side accumulator
    // iterates that list on apply.
    const fireWillDealDamage =
      attackerActor &&
      Array.isArray(ar.perTargetResults) &&
      (ar.kind === "Attack" || (ar.kind === "Skill" && ar.hasDamage));
    if (fireWillDealDamage) {
      try {
        const { findPassiveCandidates } = await getSkillEffectsExtras();
        const allTargetUuids = (ar.targets ?? []).map((t) => t.tokenUuid);
        const hitTargetUuids = ar.perTargetResults
          .filter((r) => r?.hit)
          .map((r) => {
            if (r?.tokenUuid) return r.tokenUuid;
            const matchedTarget = (ar.targets ?? []).find((t) => t?.actorUuid === r?.actorUuid);
            return matchedTarget?.tokenUuid ?? null;
          })
          .filter(Boolean);

        // Aggregate per (rowKey, carrierUuid). Per-target matchers may
        // accept the row for some targets and reject for others — the
        // pill surfaces if ANY target matched.
        const byKey = new Map();
        for (let i = 0; i < ar.perTargetResults.length; i++) {
          const entry = ar.perTargetResults[i];
          const subjectActorUuid = entry?.actorUuid;
          if (!subjectActorUuid) continue;
          // Scan EVERY target — hit or miss — for SURFACING. The pill's mere
          // presence must never reveal the (studied-gate-masked) hit/miss
          // verdict to the attacker, so it appears regardless of outcome.
          // Only HIT targets are added to appliesToTargetUuids below, so the
          // effect + any cost land solely on a hit (RAW: Warning Shot only
          // "counts" when it connects). ≥1 hit → fires ONCE for all hit
          // targets; full miss → pill shows but the chain is skipped at apply
          // (see acceptedPrePassives gate in resolveAction).
          const matchedTarget = (ar.targets ?? []).find((t) => t?.actorUuid === subjectActorUuid);
          const subjectTokenUuid = entry.tokenUuid ?? matchedTarget?.tokenUuid ?? null;

          const payloadForTrigger = {
            subjectActorUuid,
            subjectTokenUuid,
            // The performing action's kind ("Attack" | "Skill"), so a
            // will_deal_damage reaction can scope itself via reaction_action_kind
            // (Tinkerer Infusions: "Attack" only — RAW "hit with an attack").
            actionKind: ar.kind ?? null,
            targets: allTargetUuids,
            hitTargets: hitTargetUuids,
            rawDamage: entry.rawDamage,
            hr: ar.roll?.hr ?? 0,
            damageType: ar.damageType ?? ar.damage?.element ?? null,
            weaponType: ar.weapon?.weaponType ?? null,
            weaponRange: ar.weapon?.range ?? ar.weapon?.weapon_range ?? null,
            affinity: entry.affinity,
            sourceTokenUuid: ar.attacker?.tokenUuid ?? null,
            sourceActorUuid: ar.attackerActorRef,
            actionIntent: ar.actionIntent,
            targetTokenUuids: allTargetUuids,
            hitTargetTokenUuids: hitTargetUuids,
            skillUuid: ar.skillUuid ?? null,
            weaponUuid: ar.weapon?.uuid ?? null,
            // Acting skill/weapon name — lets a self-rider reaction row scope
            // itself to its own action via `reaction_source_skill` (replaces
            // the removed skill_type item-gate). Ambient reactions leave that
            // field blank and fire on any qualifying action.
            sourceSkillName: ar.skillName ?? ar.weapon?.name ?? null,
          };

          let cands;
          try {
            cands = await findPassiveCandidates({
              casterActor: attackerActor,
              trigger: "creature_will_deal_damage",
              payload: payloadForTrigger,
            });
          } catch (e) {
            warn(`CONFIRM: will_deal_damage findPassiveCandidates threw for ${entry?.name}`, e);
            continue;
          }
          for (const cand of cands ?? []) {
            const key = `${cand.rowKey}::${cand.carrierUuid}`;
            let agg = byKey.get(key);
            if (!agg) {
              // First match — keep this candidate as the aggregate.
              // payloadAtFire prefers a HIT target's payload (set/upgraded
              // below) so per-target damage_amount formulas resolve against a
              // real recipient; action-level fields (damageType, hitTargets)
              // are identical across targets anyway.
              agg = {
                ...cand,
                appliesToTargetUuids: [],
                appliesToTokenUuids: [],
                payloadAtFire: payloadForTrigger,
                _payloadFromHit: !!entry.hit,
              };
              byKey.set(key, agg);
            } else if (entry.hit && !agg._payloadFromHit) {
              agg.payloadAtFire = payloadForTrigger;
              agg._payloadFromHit = true;
            }
            // Only HIT targets receive the effect / count toward the cost.
            if (entry.hit) {
              agg.appliesToTargetUuids.push(subjectActorUuid);
              if (subjectTokenUuid) agg.appliesToTokenUuids.push(subjectTokenUuid);
            }
          }
        }
        for (const cand of byKey.values()) {
          delete cand._payloadFromHit;
          prePassives.push(cand);
        }
      } catch (e) {
        warn("CONFIRM: will_deal_damage dispatch threw", e);
      }
    }

    // Performer-side scan — creature_performs_action. Fires once (first pass) for
    // ANY card action (Attack/Skill/Spell/Item/…), carrying the real actionKind;
    // reactions scope themselves via `reaction_action_kind` (Barrage: "Attack";
    // Shadow Possession's Creeped: "Attack,Skill,Spell"). Only genuine add_target
    // reactions (Barrage) ride the onAddTargetApply path — tagged `_addTarget`
    // when the reaction's effect contains add_target; everything else (Creeped's
    // negate / Energized) resolves as an ordinary pre-resolve pill.
    const firePerformsAction = attackerActor && (ar.passIndex ?? 1) <= 1;
    if (firePerformsAction) {
      try {
        const { findPassiveCandidates } = await getSkillEffectsExtras();
        const allTargetUuids = (ar.targets ?? []).map((t) => t.tokenUuid);
        const cands = await findPassiveCandidates({
          casterActor: attackerActor,
          trigger: "creature_performs_action",
          payload: {
            sourceActorUuid: ar.attackerActorRef,
            subjectActorUuid: ar.attackerActorRef,
            sourceTokenUuid: ar.attacker?.tokenUuid ?? null,
            targets: allTargetUuids,
            targetTokenUuids: allTargetUuids,
            actionIntent: ar.actionIntent ?? "harmful",
            actionKind: ar.kind ?? "Attack",
            actionName: ar.weapon?.name ?? ar.skillName ?? ar.kind ?? "Action",
            // Acting skill/weapon name for `reaction_source_skill` self-scoping.
            sourceSkillName: ar.skillName ?? ar.weapon?.name ?? null,
            weaponUuid: ar.weapon?.uuid ?? null,
            skillUuid: ar.skillUuid ?? null,
            // ATTACK_IS_RANGED gate reads this.
            weaponRange: ar.weapon?.range ?? ar.weapon?.weapon_range ?? null,
          },
          includeUnavailable: true,
        }) ?? [];
        for (const cand of cands) {
          if (cand.kind === "passive" && cand.mode === "off") continue;
          if (cand.usesAddTarget) {
            // add_target makes sense on an Attack (Barrage) OR a single-target
            // HEALING item (Potion Rain — spread a created potion to allies).
            // Skip every other kind so the tag doesn't leak onto spells/etc.
            const isAttack = ar.kind === "Attack";
            const isHealSpread = ar.kind === "Item" && !!ar.hasHealing
              && (ar.targets?.length ?? 0) === 1;
            if (!isAttack && !isHealSpread) continue;
            // Two-weapon attacks (Double Arrow's double shot, classic TWF) lose
            // the multi property and CANNOT gain it (RAW Two-Weapon Fighting).
            // Block EVERY add_target reaction on a two-weapon pass — generic, so
            // Barrage and any future multi-granting skill are covered as data.
            const twMode = String(ar.attackMode ?? director.ctx?.attackMode ?? "").toLowerCase();
            if (twMode.startsWith("two-weapon")) continue;
            cand._addTarget = true;
          }
          prePassives.push(cand);
        }
      } catch (e) {
        warn("CONFIRM: creature_performs_action dispatch threw", e);
      }
    }

    // Third-party scan — creature_targeted_by_action. Card-modifying
    // reactions whose REACTOR is NOT the action-taker surface here
    // (Protect, Cover, future Mercy-style intercepts). Each candidate
    // carries `reactorActorUuid` + identity fields so the pill row can
    // render with a "Blanche: Protect" prefix + side-color class, and
    // RESOLVE-side firing routes the chain to the reactor's actor
    // instead of the action-taker.
    //
    // Scope: Attack + damaging Skill kinds (the actions that have a
    // target list someone might intercept). Guard/Study/Hinder/Item/
    // Equipment don't fire this trigger.
    //
    // Iteration: for each action target T, scan every combat
    // participant P (except the action-taker) and call findPassiveCandidates
    // with payload.sourceActorUuid = T.actorUuid. The matcher's
    // `reaction_source: ally/enemy/self` filter checks T's disposition
    // vs the reactor — Protect (`source: ally`) matches when T is
    // Blanche's ally. Dedup by (rowKey, carrierUuid, reactorUuid): a
    // bearer who could protect any of 3 allies still surfaces once.
    const fireCreatureTargetedByAction =
      attackerActor &&
      Array.isArray(ar.targets) &&
      ar.targets.length > 0 &&
      (ar.kind === "Attack"
        || ar.kind === "Item"   // item-use is reactable ("targeted by an item"); payload carries actionKind
        || (ar.kind === "Skill" && (ar.hasDamage || ar.hasHealing || ar.actionIntent === "harmful")));
    if (fireCreatureTargetedByAction) {
      try {
        const { findPassiveCandidates, findTargetOwnedCandidates } = await getSkillEffectsExtras();
        // The ACTING skill — source of any TARGET-owned reactions (responder
        // "target", e.g. Condemn/Torment's "you may redirect to an ally").
        let actionItem = null;
        try { if (ar.skillUuid) actionItem = await fromUuid(ar.skillUuid); } catch (_) { actionItem = null; }
        // DirectorCombatant exposes .actorDoc (live ref). Not Foundry's
        // Combat.combatants — that lives at .combat?.combatants for the
        // FSM's diagnostic mirror, not the authoritative participant list.
        const combatants = Array.isArray(director?.dCombat?.combatants)
          ? director.dCombat.combatants
          : [];
        const attackerActorUuid = attackerActor.uuid;
        const reactorActors = new Map();
        for (const c of combatants) {
          if (c?.defeated) continue;
          const actor = c?.actorDoc ?? null;
          if (!actor) continue;
          if (actor.uuid === attackerActorUuid) continue;
          reactorActors.set(actor.uuid, actor);
        }

        const seenKeys = new Set();
        // Attack-kind actions don't stamp `actionIntent` on the
        // actionResult — they're harmful by definition. Default it so
        // Protect's `reaction_action_intent: "harmful"` filter passes.
        // Skills carry their own classified intent (set at TARGET via
        // classifyActionIntent) and we preserve it verbatim.
        const effectiveIntent = ar.actionIntent
          ?? (ar.kind === "Attack" ? "harmful" : null);

        for (const target of ar.targets) {
          const subjectActorUuid = target?.actorUuid;
          if (!subjectActorUuid) continue;
          const subjectTokenUuid = target?.tokenUuid ?? null;
          const payloadForTrigger = {
            sourceActorUuid: subjectActorUuid,
            subjectActorUuid,
            subjectTokenUuid,
            targetTokenUuids: (ar.targets ?? []).map((t) => t.tokenUuid),
            attackerActorUuid,
            attackerTokenUuid: ar.attacker?.tokenUuid ?? null,
            actionIntent: effectiveIntent,
            actionKind: ar.kind,
            actionName: ar.skillName ?? ar.weapon?.name ?? ar.kind,
            // Roll result + weapon range threaded so post-roll bystander
            // reactions can gate/scale on the attacker's Accuracy Check —
            // Crossfire fires only on a ranged, non-crit attack
            // (ATTACK_IS_RANGED / ATTACK_IS_CRIT) and spends MP equal to the
            // Result (ATTACK_CHECK_RESULT). Present only post-roll (CONFIRM).
            checkTotal: Number(ar.roll?.total ?? 0) || 0,
            isCrit: !!ar.roll?.isCrit,
            isFumble: !!ar.roll?.isFumble,
            weaponRange: ar.weapon?.range ?? ar.weapon?.weapon_range ?? null,
            weaponType: ar.weapon?.weaponType ?? null,
            damageType: ar.damageType ?? ar.damage?.element ?? null,
          };

          for (const reactor of reactorActors.values()) {
            let cands;
            try {
              cands = await findPassiveCandidates({
                casterActor: reactor,
                trigger: "creature_targeted_by_action",
                payload: payloadForTrigger,
                includeUnavailable: false,
              });
            } catch (e) {
              warn(`CONFIRM: creature_targeted_by_action findPassiveCandidates threw for ${reactor.name}`, e);
              continue;
            }
            for (const cand of cands ?? []) {
              const dedup = `${cand.rowKey}::${cand.carrierUuid}::${reactor.uuid}`;
              if (seenKeys.has(dedup)) continue;
              seenKeys.add(dedup);
              log(`CONFIRM: third-party reaction matched — reactor=${reactor.name} skill=${cand.carrierName} (subject=${target?.name ?? subjectActorUuid})`);
              prePassives.push({
                ...cand,
                reactorActorUuid: reactor.uuid,
                reactorActorName: reactor.name,
                reactorActorImg:  reactor.img ?? cand.carrierImg,
                reactorIsPlayer:  !!reactor.hasPlayerOwner,
                subjectActorUuid,
                subjectTokenUuid,
                payloadAtFire: payloadForTrigger,
              });
            }
          }

          // Skill-granted, TARGET-owned reactions: the reaction lives on the
          // ACTING skill but is answered by THIS target. Inject one candidate
          // stamped reactorActorUuid = the target, so the existing pill flow
          // routes ownership to the target and the accepted-mutation pipeline
          // runs (redirect_target with destination_ref → chosen ally). The
          // attacker is excluded from reactorActors, so these never double up
          // via the reactor-walk above.
          if (actionItem) {
            try {
              const targetActorDoc = await fromUuid(subjectActorUuid).catch(() => null);
              if (targetActorDoc) {
                const ownedCands = await findTargetOwnedCandidates({
                  skill: actionItem,
                  trigger: "creature_targeted_by_action",
                  targetActor: targetActorDoc,
                  payload: payloadForTrigger,
                });
                for (const cand of ownedCands ?? []) {
                  const dedup = `${cand.rowKey}::${cand.carrierUuid}::${subjectActorUuid}`;
                  if (seenKeys.has(dedup)) continue;
                  seenKeys.add(dedup);
                  log(`CONFIRM: target-owned reaction matched — target=${target?.name ?? subjectActorUuid} skill=${cand.carrierName}`);
                  prePassives.push({
                    ...cand,
                    reactorActorUuid: subjectActorUuid,
                    reactorActorName: target?.name ?? targetActorDoc.name,
                    reactorActorImg:  targetActorDoc.img ?? cand.carrierImg,
                    reactorIsPlayer:  !!targetActorDoc.hasPlayerOwner,
                    subjectActorUuid,
                    subjectTokenUuid,
                    payloadAtFire: payloadForTrigger,
                  });
                }
              }
            } catch (e) {
              warn("CONFIRM: target-owned reaction injection threw", e);
            }
          }
        }
      } catch (e) {
        warn("CONFIRM: creature_targeted_by_action dispatch threw", e);
      }
    }

    // Guard-side dispatch — creature_guards. Action-level (not per-target);
    // the guarder IS the reactor. Bodyguard's "covered ally gains RS to
    // all damage types" rides on this. Force-mode rows surface on the
    // card as informational "Active" pills via buildReactionPillRow.
    //
    // Note Guard's actionResult (DECLARE branch ~line 1402) doesn't set
    // `attackerActorRef`, so use the resolved `attackerActor.uuid`
    // directly — `passesMatchFilters` reads `payload.sourceActorUuid` to
    // gate `reaction_source: "self"` rows and silently rejects on
    // undefined. The attacker doc was already looked up upstream via the
    // `ar.attackerActorRef ?? ar.attacker.actorUuid` fallback.
    if (ar.kind === "Guard" && attackerActor) {
      try {
        const { findPassiveCandidates } = await getSkillEffectsExtras();
        const cov = ar.coverTarget;
        const coveredTokenUuids = cov ? [cov.tokenUuid] : [];
        const guarderUuid = attackerActor.uuid;
        const guardCands = await findPassiveCandidates({
          casterActor: attackerActor,
          trigger: "creature_guards",
          payload: {
            sourceActorUuid:      guarderUuid,
            sourceTokenUuid:      ar.attacker?.tokenUuid ?? null,
            guarderActorUuid:     guarderUuid,
            guarderTokenUuid:     ar.attacker?.tokenUuid ?? null,
            didCoverAlly:         !!cov,
            coveredAllyUuid:      cov?.actorUuid ?? null,
            coveredAllyTokenUuid: cov?.tokenUuid ?? null,
            targets:              coveredTokenUuids,
            targetTokenUuids:     coveredTokenUuids,
          },
        });
        for (const cand of guardCands ?? []) {
          prePassives.push(cand);
        }
      } catch (e) {
        warn("CONFIRM: creature_guards findPassiveCandidates threw", e);
      }
    }

    // Pre-card splice for FORCE add_target reactions (the Grappled shared-space
    // splash — a grappler's "Grappling" AE adds its grappled victim(s) when the
    // grappler is attacked). These are deterministic (no player choice), so we
    // splice them into the target list BEFORE posting the card — the card then
    // renders the added victim as a normal target row. The post-confirm
    // card-mutations pass dedups against ctx.targets, so nothing double-applies.
    // Scoped to force/on, non-`_addTarget` (Barrage's interactive add_target
    // rides onAddTargetApply instead). See [[project_grappled_advanced_debuff]].
    let cardTargets = ar.targets;
    let cardPerTargets = ar.perTargetResults;
    try {
      const forceAdds = (prePassives ?? []).filter(
        (p) => (p.mode === "force" || p.mode === "on") && !p._addTarget);
      if (forceAdds.length) {
        const { applyAddTargetSplices } = await import("./card-mutations.js?cb=" + Date.now());
        const r = await applyAddTargetSplices(ar, forceAdds);
        if (r.mutationsApplied > 0) {
          cardTargets = r.targets;
          cardPerTargets = r.perTargetResults;
          director.ctx.actionResult = freezeActionResult({
            ...ar, targets: cardTargets, perTargetResults: cardPerTargets,
          });
          log(`CONFIRM: pre-spliced ${r.mutationsApplied} force add_target (e.g. Grappling) onto the card`);
        }
      }
    } catch (e) { warn("CONFIRM: force add_target pre-splice threw", e); }

    // Critical-hit cut-in — fire it AS the action card (with the roll result)
    // appears, NOT at RESOLVE. Fire-and-forget so the ~2s cinematic plays
    // alongside the card while the player reads the crit roll and confirms.
    // No-ops unless ar.roll.isCrit; the renderer skips silently if the
    // attacker has no cut_in_critical art. Per pass: each pass shows its own
    // card + roll, so a crit on any pass still gets its cinematic.
    playCritCutin(ar);

    const result = await postActionCard({
      director,
      kind: ar.kind,
      payload: {
        attacker: { ...ar.attacker, invokeCapability, invokePointCount },
        attackerActor,
        weapon: ar.weapon,
        targets: cardTargets,
        roll: ar.roll,
        damage: ar.damage,
        perTargetResults: cardPerTargets,
        attackMode: ar.attackMode,
        passIndex: ar.passIndex,
        totalPasses: ar.totalPasses,
        prePassives,
        // GM-side callback the Barrage (creature_performs_action) pill's "Apply"
        // runs on the POST-ROLL card. Fires the reaction's add_target chain
        // (JRPG picker + MP cost), then projects the picked target(s) against
        // THIS action's already-rolled accuracy dice so they share the same
        // total ("shared roll, post-roll pick"). Splices the new target rows
        // into the live actionResult (RESOLVE applies damage from
        // perTargetResults) and returns them so the card appends rows.
        // Cancel / empty pick / unaffordable → { ok:false } leaves the pill
        // actionable (cost-last-in-chain means nothing was spent).
        onAddTargetApply: async (cand) => {
          try {
            // ── Heal-spread variant (Potion Rain) ───────────────────────────
            // Item-use restore: fire the reaction chain (add_target picks ≤SL
            // allies; adjust_grant declares the ×0.5 round-up), then REBUILD the
            // heal rows for the full set via the SAME computeActionProfile/
            // buildHealPerTarget the card used (single source) — so every target
            // (original + extras) shows the scaled amount. Returns replaceRows so
            // the card re-renders all rows (not just appends). Cancel / no pick →
            // nothing applied (cost-last → nothing spent).
            const baseArH = director.ctx.actionResult ?? ar;
            const isHealSpread = String(baseArH.kind ?? "").toLowerCase() === "item" && !!baseArH.hasHealing;
            if (isHealSpread) {
              const hSkill = baseArH.skillUuid ? await fromUuid(baseArH.skillUuid).catch(() => null) : null;
              const hAttacker = director.ctx.turnSnapshot;
              if (!hSkill || !hAttacker) {
                warn(`CONFIRM onAddTargetApply(heal): missing ${!hSkill ? "skill" : "attacker"} (skillUuid=${baseArH.skillUuid}) — pill stays pending`);
                return { ok: false };
              }
              const existingH = new Set((baseArH.targets ?? []).map((t) => t.tokenUuid));
              const sinkH = { addedTokenUuids: [] };
              const probeH = {
                sourceActorUuid: baseArH.attackerActorRef, subjectActorUuid: baseArH.attackerActorRef,
                sourceTokenUuid: baseArH.attacker?.tokenUuid ?? null,
                targets: [...existingH], targetTokenUuids: [...existingH],
                actionIntent: "beneficial", actionKind: "Item",
                actionName: baseArH.skillName ?? "Item", _preRoll: sinkH,
              };
              const { firePreAcceptedCandidate } = await getSkillEffectsExtras();
              let resH = null;
              try { resH = await firePreAcceptedCandidate({ director, casterActor: attackerActor, candidate: cand, payload: probeH }); }
              catch (e) { warn("CONFIRM onAddTargetApply(heal): chain threw", e); return { ok: false }; }
              if (!resH?.ok) {
                log(`CONFIRM onAddTargetApply(heal): chain ${resH?.cancelled ? "cancelled" : "returned not-ok"} — pill stays pending`);
                return { ok: false, cancelled: !!resH?.cancelled };
              }
              // Resolve the picked allies into target snapshots. Build the pool
              // fresh from the combat (any side) — director.ctx.eligibleTargets is
              // populated by the attack/skill targeting paths but NOT for a plain
              // Item action, so relying on it dropped every pick (Apply no-op).
              const eligibleH = director.dCombat
                ? snapshotEligibleTargetsFromDCombat(director.dCombat, hAttacker, { category: "any" })
                : snapshotEligibleTargets(director.combat, hAttacker, { category: "any" });
              const newSnapsH = [];
              for (const u of sinkH.addedTokenUuids) {
                if (existingH.has(u)) continue;
                const snap = eligibleH.find((e) => e.tokenUuid === u);
                if (snap && !newSnapsH.includes(snap)) newSnapsH.push(snap);
              }
              if (!newSnapsH.length) {
                log(`CONFIRM onAddTargetApply(heal): no new targets resolved from picks [${sinkH.addedTokenUuids.join(", ")}] — pill stays pending`);
                return { ok: false, cancelled: true };
              }
              const allSnapsH = [...(baseArH.targets ?? []), ...newSnapsH];
              const grantAdjust = sinkH.grantAdjust ?? null;
              const scaledAr = { ...baseArH, grantAdjust };
              const viewH = getRuntimeActionView(hSkill);
              const profileH = await computeActionProfile({
                view: viewH, ar: scaledAr, attacker: hAttacker, targets: allSnapsH, dice: null,
                ctx: { round: director.dCombat?.round ?? 0, chainVars: baseArH.preActivateVars },
              });
              const deltaH = projectProfileToActionResult(profileH, scaledAr, allSnapsH);
              const newRowsH = deltaH.perTargetResults ?? [];
              // Re-freeze the WHOLE action result from the rebuilt profile (single
              // source): headline restore (damage=healingObj) + per-target rows +
              // hit set all come from the SAME projection, so the card body
              // re-renders consistently — no separate headline patch.
              director.ctx.actionResult = freezeActionResult({
                ...baseArH, grantAdjust,
                targets: allSnapsH, perTargetResults: newRowsH,
                damage: deltaH.damage, hasHealing: deltaH.hasHealing,
                hasDamage: deltaH.hasDamage, damageResource: deltaH.damageResource,
                hitTokenUuids: allSnapsH.map((s) => s.tokenUuid),
              });
              log(`CONFIRM onAddTargetApply(heal): Potion Rain spread +${newSnapsH.length} target(s), adjust ${grantAdjust?.op ?? "none"} ${grantAdjust?.value ?? ""}`);
              return {
                ok: true,
                replaceRows: newRowsH,
                // Headline restore for the card body re-render (single source).
                damage: deltaH.damage, hasHealing: deltaH.hasHealing,
                targets: allSnapsH.map((s) => ({
                  name: s.name, actorUuid: s.actorUuid, tokenUuid: s.tokenUuid,
                  tokenImg: s.tokenImg, disposition: s.disposition,
                })),
              };
            }

            const fullAttacker = director.ctx.turnSnapshot;
            const fullWeapon = director.ctx.currentWeapon;
            if (!fullAttacker || !fullWeapon || !ar.roll) return { ok: false };
            const baseAr = director.ctx.actionResult ?? ar;
            const existingUuids = new Set((baseAr.targets ?? []).map((t) => t.tokenUuid));

            const sink = { addedTokenUuids: [] };
            const probePayload = {
              sourceActorUuid: fullAttacker.actorUuid, subjectActorUuid: fullAttacker.actorUuid,
              sourceTokenUuid: ar.attacker?.tokenUuid ?? null,
              targets: [...existingUuids], targetTokenUuids: [...existingUuids],
              actionIntent: "harmful", actionKind: "Attack",
              actionName: fullWeapon?.name ?? "Attack", weaponUuid: fullWeapon?.uuid ?? null,
              weaponRange: fullWeapon?.range ?? fullWeapon?.weapon_range ?? null,
              _preRoll: sink,
            };
            const { firePreAcceptedCandidate } = await getSkillEffectsExtras();
            let res = null;
            try { res = await firePreAcceptedCandidate({ director, casterActor: attackerActor, candidate: cand, payload: probePayload }); }
            catch (e) { warn("CONFIRM onAddTargetApply: firePreAcceptedCandidate threw", e); return { ok: false }; }
            if (!res?.ok) return { ok: false, cancelled: !!res?.cancelled };

            // New, not-already-targeted snapshots.
            const eligible = director.ctx.eligibleTargets ?? [];
            const newSnaps = [];
            for (const u of sink.addedTokenUuids) {
              if (existingUuids.has(u)) continue;
              const snap = eligible.find((e) => e.tokenUuid === u);
              if (snap && !newSnaps.includes(snap)) newSnaps.push(snap);
            }
            if (!newSnaps.length) return { ok: false, cancelled: true };

            // Reconstruct the consumed grant (if any) so the recomputed check
            // total reproduces ar.roll.total exactly — the new target shares the
            // SAME roll, compared against its own DEF.
            const grant = ar.freeActionGrant
              ? { sourceLabel: ar.freeActionGrant.sourceLabel, checkBonus: ar.freeActionGrant.checkBonus ?? 0, damageBonus: ar.freeActionGrant.damageBonus ?? 0 }
              : null;
            const profile = await computeActionProfile({
              view: { kind: "Attack", check_mode: "opposed", effect_table: {}, fire_points: {}, source: null },
              attacker: fullAttacker, weapon: fullWeapon, targets: newSnaps,
              dice: { rA: ar.roll.rA, rB: ar.roll.rB },
              ctx: { round: director.dCombat?.round ?? 0, attackMode: director.ctx.attackMode, grant },
            });
            const delta = projectProfileToActionResult(profile, null, newSnaps);
            const addedRows = delta.perTargetResults ?? [];

            director.ctx.actionResult = freezeActionResult({
              ...baseAr,
              targets: [...(baseAr.targets ?? []), ...newSnaps],
              perTargetResults: [...(baseAr.perTargetResults ?? []), ...addedRows],
              hitTokenUuids: [...(baseAr.hitTokenUuids ?? []), ...(delta.hitTokenUuids ?? [])],
            });
            log(`CONFIRM onAddTargetApply: spliced ${newSnaps.length} Barrage target(s) sharing roll total ${ar.roll.total}`);
            return { ok: true, addedRows };
          } catch (e) {
            warn("CONFIRM onAddTargetApply threw", e);
            return { ok: false };
          }
        },
        // Guard-specific:
        coverTarget: ar.coverTarget,
        // Study-specific:
        target: ar.target,
        tier: ar.tier,
        previousBest: ar.previousBest,
        improved: ar.improved,
        // Hinder-specific:
        dl: ar.dl,
        success: ar.success,
        // Item-specific:
        itemCandidates: ar.itemCandidates,
        ip: ar.ip,
        // Skill-specific:
        skillName: ar.skillName,
        skillImg: ar.skillImg,
        skillType: ar.skillType,
        defenseTargetType: ar.defenseTargetType,
        skillRange: ar.skillRange,
        skillTarget: ar.skillTarget,
        damageType: ar.damageType,
        hasDamage: ar.hasDamage,
        hasHealing: ar.hasHealing,
        rawCost: ar.rawCost,
        costSerialized: ar.costSerialized,
        descriptionHtml: ar.descriptionHtml,
      },
    });

    // Hinder's status pick (dazed/shaken/slow/weak) arrives via the card's
    // button click. Merge it back into actionResult so RESOLVE can apply
    // the right AE. actionResult is frozen — re-freeze through a shallow
    // spread that keeps everything else identical.
    if (result.statusValue) {
      director.ctx.actionResult = freezeActionResult({
        ...ar,
        statusValue: result.statusValue,
      });
    }
    // Equipment card collects per-slot dropdowns and ships them as
    // { main, off, accessory1, accessory2 } → null|itemId. Merge so RESOLVE
    // can apply the swap via applyEquipmentSwap.
    if (result.equipmentSelections) {
      director.ctx.actionResult = freezeActionResult({
        ...director.ctx.actionResult,
        equipmentSelections: result.equipmentSelections,
      });
    }
    // Item card forwards the picked {mode, key, cost} for RESOLVE to
    // turn into a consume / spendIp commit.
    if (result.itemSelection) {
      director.ctx.actionResult = freezeActionResult({
        ...director.ctx.actionResult,
        itemSelection: result.itemSelection,
      });
    }
    // Pre-resolve passive decisions — only "apply" entries are stamped
    // so RESOLVE can fire them via firePreAcceptedCandidate. The
    // post-resolve creature_completes_spell dispatcher reads the same
    // list to skip already-evaluated candidates (avoid double-fire).
    //
    // Phase 2 (Cheap Shot): after stamping accepted decisions, recompute
    // perTargetResults from any accepted `add_damage` candidates so the
    // damage values RESOLVE applies match what the player chose. The
    // sender-side accumulator sums base-damage bonuses per subject; the
    // recompute reapplies affinity over (rawDamage + bonus). This makes
    // affinity multiply once over the combined total — the user's
    // "base damage, affinity applied once" rule.
    if (Array.isArray(result.reactionDecisions) && result.reactionDecisions.length) {
      // Read the LATEST actionResult — a Barrage (_addTarget) pill applied
      // earlier this window may have already spliced extra targets into it.
      // Basing the recompute on the stale captured `ar` would drop them.
      const liveAr = director.ctx.actionResult ?? ar;
      const applied = result.reactionDecisions
        .filter((d) => d?.decision === "apply")
        // Barrage (_addTarget) commits its MP cost + spliced targets at
        // Apply-click, not at RESOLVE. Exclude it so RESOLVE's re-fire
        // (firePreAcceptedCandidate) doesn't re-prompt the picker or
        // double-charge MP — its damage is already in perTargetResults.
        .filter((d) => {
          const c = (prePassives ?? []).find((p) => p.rowKey === d.rowKey && p.carrierUuid === d.carrierUuid);
          return !c?._addTarget;
        });
      const evaluated = result.reactionDecisions.map((d) => ({
        carrierUuid: d.carrierUuid,
        rowKey: d.rowKey,
      }));

      // Phase 1: card-mutations (redirect_target today; change_element /
      // replace_damage etc. as future work). These rewrite WHICH actor
      // is in each target slot, so they run BEFORE add_damage recompute
      // so the damage-bonus accumulator sees the redirected target.
      let mutatedTargets = liveAr.targets ?? null;
      let mutatedPerTargets = liveAr.perTargetResults ?? null;
      let accuracyOverride = null;
      let negated = false;
      try {
        const { applyAcceptedCardMutations } = await import("./card-mutations.js?cb=" + Date.now());
        const r = await applyAcceptedCardMutations(liveAr, applied);
        negated = !!r.negated;
        if (r.mutationsApplied > 0) {
          mutatedTargets = r.targets;
          mutatedPerTargets = r.perTargetResults;
          accuracyOverride = r.accuracyOverride ?? null;
          log(`CONFIRM: card mutations applied — ${r.mutationsApplied} (redirects + accuracy/element/damage hooks${negated ? "; NEGATED" : ""})`);
        }
      } catch (e) { warn("CONFIRM: card mutations threw", e); }

      // Phase 2: add_damage recompute. Reads (possibly mutated)
      // perTargetResults so a Cheap Shot-style add_damage on the
      // redirected target works correctly.
      let recomputedPerTargets = mutatedPerTargets;
      try {
        const { computeSenderDamageBonuses, recomputePerTargetDamages } = await getSkillEffectsExtras();
        const bonusMap = await computeSenderDamageBonuses({
          casterActor: attackerActor,
          acceptedPrePassives: applied,
          dCombat: director.dCombat,
        });
        if (bonusMap.size > 0 && Array.isArray(mutatedPerTargets)) {
          const { applyAffinityToDamage } = await import("./snapshot.js");
          recomputedPerTargets = recomputePerTargetDamages(
            mutatedPerTargets, bonusMap, applyAffinityToDamage,
          );
          log(`CONFIRM: add_damage recompute applied — ${bonusMap.size} subject(s) modified`);
        }
      } catch (e) { warn("CONFIRM: add_damage recompute threw", e); }
      // Infusion element override (change_damage_element): if every hit now
      // shares a new element, reflect it on the action-level damageType so the
      // committed card + battle log read the new element (e.g. Physical → Fire).
      let newDamageType = null;
      try {
        const hitEls = (recomputedPerTargets ?? [])
          .filter((e) => e?.hit && e?.element)
          .map((e) => String(e.element).toLowerCase());
        if (hitEls.length && hitEls.every((e) => e === hitEls[0])) newDamageType = hitEls[0];
      } catch { /* non-fatal */ }
      director.ctx.actionResult = freezeActionResult({
        ...director.ctx.actionResult,
        targets: mutatedTargets,
        perTargetResults: recomputedPerTargets,
        ...(newDamageType ? { damageType: newDamageType } : {}),
        acceptedPrePassives: applied,
        evaluatedPrePassives: evaluated,
        accuracyOverride,
        // negate_action (Shadow Possession) — RESOLVE skips outcome + effect/
        // reaction firing; the per-target hits are already zeroed + Blocked above.
        negated,
      });
    }
    // Drop the survival-flag pendingAction the moment the card resolves
    // (confirm or cancel). Without this, an F5 between here and the
    // next FSM save site (RESOLVE for confirm, or TURN_END/TURN_START
    // for cancel) would still see the stale pendingAction and re-spawn
    // the card the GM just decided on. `skipHistory: true` avoids
    // adding a second rewind entry for the same action — the original
    // "card posted" entry stays in history.
    //
    // We AWAIT this clear (rather than fire-and-forget) on purpose:
    // RESOLVE.onEnter saves at its tail with `currentTurnResolved=true`,
    // and we need the clear-save to land first. If both were in flight,
    // the clear (currentTurnResolved=false, pendingAction=null) could
    // overtake RESOLVE's save and overwrite currentTurnResolved=true →
    // an F5 right after would resume into CONFIRM and double-apply
    // already-committed damage when the user re-clicks.
    try {
      await saveDirectorState(director, {
        pendingAction: null,
        skipHistory: true,
      });
    } catch (e) {
      warn("CONFIRM: pendingAction-clear save failed", e);
    }

    // Action namecard — fire AFTER the player presses Confirm so the banner
    // appears as a consequence of the decision, not before they've seen the
    // action card. Fire-and-forget: the ~2s banner runs while RESOLVE executes.
    // Only on the first pass (no duplicate banner per multi-hit pass).
    if (result.confirmed && (ar.passIndex ?? 1) <= 1) {
      playActionNamecard(ar).catch((e) => warn("CONFIRM: playActionNamecard threw", e));
    }

    director.dispatch({ type: result.confirmed ? INTENTS.CONFIRM_ACTION : INTENTS.CANCEL_ACTION });
  },
};

// ─── Encyclopedia: NPC action witnessing ──────────────────────────────
// Port of the legacy `oni:action:resolved` Path B (encyclopedia-core.js).
// When a hostile NPC (disposition -1) USES an action, record it on the
// Monster Encyclopedia page so the "???" placeholder materializes into the
// real attack / skill / spell entry. The director took over NPC turns, so
// those actions no longer flow through the legacy ADF hook — without this,
// witness reveals silently stopped firing for director-run monsters.
//
// Fires on USE — hit OR miss — because the party witnessed the action
// regardless of outcome. Only attacks / skills / spells are catalogued;
// Guard / Hinder / Study / Equipment / Item aren't monster "abilities".
//
// recordWitnessedAction is GM-only and RESOLVE.onEnter is GM-side, so the
// direct API call is safe. It only writes the Monster Encyclopedia journal
// (never actor state), so ordering vs damage/AE application is irrelevant
// and it stays out of the actor-based rewind snapshot — witness knowledge
// is monotonic and shouldn't un-reveal on a turn rewind. The journal
// re-render reaches players via Foundry doc sync; no chat message is posted
// (consistent with the director's no-chat-log rule).
async function recordNpcActionWitness(director, ar) {
  try {
    const encApi = globalThis.FUCompanion?.api?.encyclopedia;
    if (!encApi?.recordWitnessedAction || !encApi?.resolveActorPrototypeUuid) return;

    // The embedded item that backs this action. Both split-pop to the
    // monster's embedded item _id — the witnessed key the encyclopedia
    // matches against `attack_list` / `skill_active_list` / `normal_spell_list`.
    //
    // NPC attacks use a frozen pseudo-weapon (buildPseudoWeaponFromNpcAttack)
    // that exposes the source Item UUID as `npcAttackItemUuid`, NOT `uuid` —
    // the canonical value also lives on `director.ctx.npcAttackItemUuid`
    // (set in TARGET). Prefer those; `ar.weapon?.uuid` only exists for PC
    // weapons, which never reach here (PCs aren't disposition -1).
    let actionUuid = null;
    if (ar.kind === "Attack") {
      actionUuid = ar.weapon?.npcAttackItemUuid
        ?? director?.ctx?.npcAttackItemUuid
        ?? ar.weapon?.uuid
        ?? null;
    } else if (ar.kind === "Skill") {
      actionUuid = ar.skillUuid ?? null; // covers spells (skillType: "spell")
    }
    if (!actionUuid) return;

    const tokenUuid = ar.attacker?.tokenUuid ?? null;
    if (!tokenUuid) return;

    // Hostile-only — read disposition off the live token document.
    let disposition = 0;
    try {
      const tokenDoc = await fromUuid(tokenUuid);
      disposition = Number(tokenDoc?.disposition ?? tokenDoc?.document?.disposition ?? 0);
    } catch { /* tolerate — non-hostile fall-through below */ }
    if (disposition !== -1) return;

    // Prototype UUID keys the page (stable across token instances). The
    // embedded item _id is identical on linked + unlinked tokens because
    // embedded ids are copied from the prototype on token creation.
    const protoUuid = await encApi.resolveActorPrototypeUuid(tokenUuid);
    if (!protoUuid) return;
    const itemId = String(actionUuid).split(".").pop();
    if (!itemId) return;

    const actionName = ar.skillName ?? ar.weapon?.name ?? ar.kind;
    const result = await encApi.recordWitnessedAction({
      actorUuid:   protoUuid,
      itemId,
      actionName,
      monsterName: ar.attacker?.name ?? "Monster",
    });
    if (result?.wasNew) {
      log(`Encyclopedia: witnessed ${ar.attacker?.name ?? "?"} → ${actionName} (${itemId})`);
    }
  } catch (e) {
    warn("RESOLVE: NPC action witness record failed", e);
  }
}

// ─── RESOLVE ───────────────────────────────────────────────────────────
// Apply damage / AE / etc. directly to live docs. GM-side, serialized by
// dispatch lock.
const Resolve = {
  async onEnter(director) {
    const ar = director.ctx.actionResult;
    if (!ar) {
      warn("RESOLVE with no actionResult");
      director.enqueue({ type: INTENTS.INTERNAL_DONE });
      return;
    }

    // Encyclopedia witness — catalogue this action if a hostile NPC used it.
    // Runs before the kind branches so a missed attack still counts as
    // "seen". Idempotent + journal-only, so it's safe to await here and a
    // no-op on later passes of a multi-pass attack.
    await recordNpcActionWitness(director, ar);

    // (Critical-hit cut-in now fires in CONFIRM, as the action card with the
    // roll result appears — see Confirm.onEnter. Not replayed here.)

    if (ar.kind === "Attack") {
      // ── Unified path (Phase 7 — bespoke Attack branch retired) ──
      // ALL attacks resolve through resolveAction. A backing weapon Item (PC
      // equipped weapon, NPC pseudo-weapon) is passed when resolvable; a
      // weaponless attack (Twin-Shield virtual pass, unarmed) resolves with a
      // synthetic Attack view. resolveAction applies ar.perTargetResults +
      // queues per-target creature_deals_damage (weapon on-hit keywords) +
      // creature_completes_attack — reproducing the retired bespoke branch.
      const weaponItem = ar.weapon?.uuid ? await fromUuid(ar.weapon.uuid).catch(() => null) : null;
      await resolveAction(director, ar, { actionSkill: weaponItem });
    } else if (ar.kind === "Guard") {
      // The Battle Director/Common/Guard action-skill Item carries the Guard +
      // Covered AE templates and the self/cover apply_ae chain. resolveAction
      // fires its on_activate chain (applying both AEs) and queues the
      // creature_guards trigger (kind === "Guard"). Null Common item (migration
      // not yet run) → resolveAction bails with a warn.
      await resolveAction(director, ar, { actionSkill: getCoreActionSkill("guard") });
    } else if (ar.kind === "Equipment") {
      // Common/Equipment carries a single equip_swap effect row that wraps
      // applyEquipmentSwap(actor, ar.equipmentSelections).
      await resolveAction(director, ar, { actionSkill: getCoreActionSkill("equipment") });
    } else if (ar.kind === "Skill" || ar.kind === "Item") {
      // Resolve a Skill cast OR Item use through the ONE pipeline — both are
      // skill-shaped sources. resolveAction debits cost (incl. the item cost:
      // consume the consumable for "use", IP for "create"), fires on_activate /
      // per-target damage / post_damage / effect_table. No Item-specific branch.
      await resolveAction(director, ar);
    } else if (ar.kind === "Hinder") {
      // Success-gating + fail/fumble Miss VFX stay here (presentation); on a
      // success, resolveAction fires Common/Hinder's open_action_menu, which
      // prompts for one of Dazed/Shaken/Slow/Weak (shared option picker with
      // per-status icons + colors) and applies it to action_targets with
      // replace_same_status dedup. The menu only fires on success (this gate).
      if (!ar.success) {
        log(`Hinder failed against ${ar.target?.name ?? "?"} (roll ${ar.roll?.total ?? "?"} vs DL ${ar.dl})`);
        playMissVfx({ tokenUuid: ar.target?.tokenUuid });
      } else {
        await resolveAction(director, ar, { actionSkill: getCoreActionSkill("hinder") });
      }
    } else if (ar.kind === "Study") {
      // resolveAction fires Common/Study's encyclopedia_record row (the data
      // write, incl. the RAW fumble-skip). Presentation (token VFX + opening
      // the encyclopedia sheet) is not a data effect, so it stays here.
      await resolveAction(director, ar, { actionSkill: getCoreActionSkill("study") });
      const encApi = globalThis.FUCompanion?.api?.encyclopedia;
      if (ar.roll?.isFumble) {
        playMissVfx({ tokenUuid: ar.target?.tokenUuid });
      } else {
        const STUDY_LOWEST_BAR = 7; // TIER_IDENTITY in encyclopedia-core.js
        const studyTotal = Number(ar.roll?.total ?? 0) || 0;
        const studyBelowBar = !ar.roll?.isCrit && studyTotal < STUDY_LOWEST_BAR;
        try {
          if (studyBelowBar) playMissVfx({ tokenUuid: ar.target?.tokenUuid });
          else await playStudyVfx({ targetTokenUuid: ar.target?.tokenUuid, durationMs: 2500 });
        } catch (e) { warn("RESOLVE Study (unified): VFX threw", e); }
        const recordedUuid = ar.target?.worldActorUuid ?? ar.target?.actorUuid ?? null;
        if (recordedUuid && encApi?.openEncyclopediaForActor) {
          try { await encApi.openEncyclopediaForActor(recordedUuid); }
          catch (e) { warn("RESOLVE Study (unified): openEncyclopediaForActor failed", e); }
          try { game.socket?.emit?.("module.fabula-ultima-companion", { type: "encyclopedia:open", actorUuid: recordedUuid }); }
          catch (e) { warn("RESOLVE Study (unified): socket emit failed", e); }
        }
      }
    }

    // Persistence checkpoint #4 — RESOLVE has applied the action's
    // damage / AE / equipment / item-consume to actor docs. From this
    // point on a reload must NOT rewind to TURN_START (the action
    // already committed; re-doing it would double-apply). Mark the
    // turn resolved + write the flag. The resume path reads this and
    // routes to TURN_END instead of TURN_START.
    //
    // Multi-pass attacks (Two-Weapon): set true on every RESOLVE so a
    // reload mid-second-pass skips the rest of the turn. Trade-off: the
    // second weapon's attack is lost on resume. The opposite trade
    // (double-applying the first pass) is strictly worse.
    //
    // Free-action gate: a free action's RESOLVE must NOT mark the turn
    // resolved. The pipeline detours REACTION_WINDOW → FAW (skipping
    // TURN_END), so without this gate `currentTurnResolved=true` would
    // persist after the free action completes. On the next F5/reload,
    // the resume sees it and routes to TURN_END — which advances the
    // turn, flipping currentSide. The previously-observed "monster
    // side starts after my free action" and "no turn picker after
    // rewind" symptoms both trace back here. The marker for "we're
    // mid-free-action" is the continuation stack: top frame is a
    // `freeAction:*` while the sub-flow is in flight.
    if (director.dCombat && !topIsFreeAction(director.ctx)) {
      director.dCombat.currentTurnResolved = true;
    }
    // Label describes what the GM lands at on rewind: a checkpoint
    // AFTER this action's commit — resume routes via TURN_END → next
    // turn picker. For multi-pass attacks, distinguish the pass so
    // pass-1 vs pass-2 checkpoints are unambiguous in the list.
    const rvDc = director.dCombat;
    // For a free action, name the actor who actually just acted (the
    // reactor whose snapshot was swapped in). dCombat.current still
    // points at the original turn-owner — fall through to ar.attacker
    // so the rewind label reads "After Hina's Action" during her HS
    // free Attack instead of "After Wolf's Action".
    const rvName = topIsFreeAction(director.ctx)
      ? (ar?.attacker?.name ?? director.ctx.turnSnapshot?.name ?? "?")
      : (rvDc?.current?.name ?? ar?.attacker?.name ?? "?");
    const rvPassTag = (ar?.totalPasses ?? 1) > 1
      ? ` (Pass ${ar.passIndex}/${ar.totalPasses})`
      : "";
    const rvPhase = rewindPhaseLabel(director.ctx, rvDc?.round);
    await saveDirectorState(director, {
      label: `${rvPhase} · After ${rvName}'s Action${rvPassTag}`,
      description: describeActionForRewind(ar),
    }).catch((e) => warn("RESOLVE: saveDirectorState failed", e));

    // Drain any post-action passive triggers queued during the body of
    // this RESOLVE (e.g. `creature_deals_damage` → Vanish). Firing them
    // AFTER the save above means their AEs aren't captured in this
    // checkpoint's actor snapshot — rewinding to "After X's Action"
    // restores pre-reaction state, so one rewind undoes the latest
    // Vanish (and the AE it added). Without this re-ordering the
    // reaction-applied AE landed in the snapshot and required two
    // rewinds to remove.
    // Generalized to the same transaction settle used at Start-of-Turn: drains
    // the resource ledger to quiescence AND runs the built-in engine reactors
    // (crisis), so attack/effect-damage HP changes fold into the crisis cascade
    // — not just Start-of-Turn ticks. Authored-reaction behavior is unchanged
    // (settleInstance drains each event via the same firePassiveTriggers call).
    try {
      const { settleInstance } = await import("./instance-settle.js");
      await settleInstance(director, { reason: "resolve" });
    } catch (e) {
      warn("RESOLVE: settleInstance threw", e);
    }

    // Crit → stamp opportunity payload so the RESOLVE transition branches to
    // OPPORTUNITY_WINDOW. Stamped after the persistence checkpoint so an F5
    // during the picker gracefully skips the opportunity (action already committed).
    if (ar.roll?.opportunities) {
      director.ctx.hasPendingOpportunity = {
        actorUuid:    ar.attackerActorRef ?? ar.attacker?.actorUuid ?? null,
        actorName:    ar.attacker?.name ?? "?",
        actionCardId: ar.cardId ?? null,
      };
    }

    director.enqueue({ type: INTENTS.INTERNAL_DONE });
  },
};

// ─── OPPORTUNITY_WINDOW ────────────────────────────────────────────────
// Entered when ar.roll.opportunities was true in the preceding RESOLVE
// (crit that is not a fumble). Awaits the full ONI opportunity flow —
// stagger pause, "Opportunity!" animation, picker, resolution — before
// releasing to REACTION_WINDOW. offer() has a built-in 120 s safety
// timeout so the FSM is never permanently wedged if the player walks away.
const OpportunityWindow = {
  async onEnter(director) {
    const opp = director.ctx.hasPendingOpportunity;
    director.ctx.hasPendingOpportunity = null;

    const oppSys = globalThis.ONI?.OpportunitySystem;
    if (!opp || !oppSys?.offer) {
      warn("OPPORTUNITY_WINDOW: OpportunitySystem not available — skipping");
      director.enqueue({ type: INTENTS.INTERNAL_DONE });
      return;
    }

    log(`OPPORTUNITY_WINDOW — offering to ${opp.actorName}`);
    await oppSys.offer({
      actorUuid:    opp.actorUuid,
      actorName:    opp.actorName,
      source:       "action",
      actionCardId: opp.actionCardId,
      context:      { source: "battle_director" },
    }).catch(e => warn("OPPORTUNITY_WINDOW: offer() threw", e));

    director.enqueue({ type: INTENTS.INTERNAL_DONE });
  },
};

// ─── REACTION_WINDOW ───────────────────────────────────────────────────
// v1 stub: no reactions fire. Just pass through.
// A real implementation runs MATCH → PASSIVE → MANUAL → DRAIN here.
const ReactionWindow = {
  async onEnter(director) {
    log("REACTION_WINDOW — v1 stub, no reactions in prototype");
    // Tiny delay to demonstrate the FSM is genuinely waiting in this state.
    // Routes through director.timers so stop() guarantees cleanup.
    director.timers.setTimeout(
      () => director.dispatch({ type: INTENTS.INTERNAL_DONE }),
      100,
      { label: "reactionWindow:stubDelay" }
    );
  },
};

// ─── CLEANUP ───────────────────────────────────────────────────────────
// Per-turn cleanup. Releases any transient state that shouldn't survive.
const Cleanup = {
  async onEnter(director) {
    director.ctx.actionResult = null;
    director.ctx.currentWeapon = null;
    director.ctx.reactionDepth = 0;

    // Multi-pass attacks (Two-Weapon Fighting): if more passes remain in
    // the queue, we keep declaredCommand / eligibleTargets / attackMode
    // alive so COMPUTE can roll the next weapon as a fresh card.
    // The transition table (states.js) branches CLEANUP → COMPUTE on
    // INTERNAL_DONE when ctx.pendingPasses still has entries.
    const moreToRoll = Array.isArray(director.ctx.pendingPasses) && director.ctx.pendingPasses.length > 0;
    if (!moreToRoll) {
      director.ctx.declaredCommand = null;
      director.ctx.eligibleTargets = null;
      director.ctx.attackMode = null;
      director.ctx.weaponsUsed = null;
      director.ctx.pendingPasses = null;
      director.ctx.totalPasses = 0;
      director.ctx.passIndex = 0;
      director.ctx.pickedTargetUuids = null;
      director.ctx.hinderCheckConfig = null;
      log("CLEANUP done");
    } else {
      log(`CLEANUP done (multi-pass — ${director.ctx.pendingPasses.length} remaining, looping back to COMPUTE)`);
    }
    director.enqueue({ type: INTENTS.INTERNAL_DONE });
  },
};

// ─── TURN_END ──────────────────────────────────────────────────────────
// Bumps the turn counter + flips side if needed (per Fabula side-based
// alternation). Does NOT pick the next combatant — that's TURN_START's job
// (via the picker). Does NOT mirror to Foundry — mirroring happens in
// TURN_START once `currentCombatantId` is resolved.
const TurnEnd = {
  async onEnter(director) {
    // Defense-in-depth guard — TURN_END must never run mid-free-action.
    // REACTION_WINDOW + CLEANUP transitions both gate on `topIsFreeAction`
    // (states.js) so this branch should be unreachable. If it fires,
    // route through FAW directly so the stack can pop its frame and the
    // sub-flow completes cleanly.
    if (topIsFreeAction(director.ctx)) {
      warn(
        `TURN_END misroute guard fired — free action on stack (depth ${stackDepth(director.ctx)}, top "${peekTop(director.ctx)?.reason}"). Skipping nextTurn() and routing to FREE_ACTION_WINDOW.`,
        { ctx_keys: Object.keys(director.ctx ?? {}).sort() }
      );
      // Force-transition to FAW (skipping the SRW dance). FAW.onEnter
      // sees the free-action frame on top, pops it, and continues the
      // drain/exit logic.
      await director.transitionTo(STATES.FREE_ACTION_WINDOW);
      return;
    }
    if (director.dCombat) {
      // Capture the "just acted" name + round + actor BEFORE nextTurn
      // (nextTurn clears currentCombatantId and may advance the round
      // on a wrap). The captured actor uuid threads into the standalone
      // reaction payload so turn_end reactions can read currentActorUuid.
      const teJustActedName = director.dCombat.current?.name
        ?? director.ctx.turnSnapshot?.name ?? "?";
      const teRoundEnded = director.dCombat.round ?? 0;
      const endingActorUuid  = director.dCombat?.current?.actorUuid ?? null;
      const endingTokenUuid  = director.dCombat?.current?.tokenUuid ?? null;

      // Bearer-turn-end AE tick — decrement "target_turn_end" lifetime AEs on the
      // actor whose turn just ended (action-gating Advanced Debuffs last N of the
      // AFFECTED creature's own turns). Distinct from the applier-turn-start tick
      // that runs in TURN_START; awaited so expiry commits before the next turn.
      if (endingActorUuid) {
        try { await tickDirectorAEsForBearerTurnEnd(endingActorUuid); }
        catch (e) { warn("TURN_END: tickDirectorAEsForBearerTurnEnd threw", e); }
      }

      try {
        const r = director.dCombat.nextTurn();
        director.ctx.endOfRound = !!r.wrappedRound;
        director.ctx.endOfCombat = !!r.ended;
        log(`TURN_END (dCombat) → round ${r.round}, currentSide=${r.currentSide}, eligible=${r.eligibleIds.length}${r.wrappedRound ? " [wrapped round]" : ""}${r.ended ? " [ended]" : ""}`);
      } catch (e) {
        warn("TURN_END: dCombat.nextTurn threw", e);
        director.ctx.endOfCombat = true;
      }
      // The turn we just wrapped up is now in the past — clear the
      // resolved-flag so a reload/rewind to THIS save site routes
      // through TURN_START (next turn's picker), not back into TURN_END
      // (which would re-run nextTurn and incorrectly flip currentSide
      // a second time, e.g. "Enemies Pick Next Turn" snapshot rewinds
      // into a party-side picker).
      director.dCombat.currentTurnResolved = false;
      // Persistence checkpoint #3 — round / currentSide / turnsRemaining
      // have been advanced. Saving here means a reload between TURN_END
      // and the NEXT TURN_START still resumes at the right turn.
      // Label describes the state the GM lands at on rewind: the
      // next-turn picker (or auto-pick → DECLARE if only one eligible).
      // Use the POST-nextTurn round/side so the label reflects what the
      // GM will actually see, not the round that just ended.
      const teNewRound = director.dCombat.round ?? 0;
      const teNewSide = director.dCombat.currentSide === "enemy" ? "Enemies" : "Party";
      const teDescParts = [`${teJustActedName}'s turn ended`];
      if (director.ctx.endOfRound) teDescParts.push(`Round ${teRoundEnded} wrapped`);
      if (director.ctx.endOfCombat) teDescParts.push(`Combat ended`);
      saveDirectorState(director, {
        label: director.ctx.endOfCombat
          ? `Combat Ended`
          : `Round ${teNewRound} · ${teNewSide} Pick Next Turn`,
        description: teDescParts.join(" · "),
      }).catch((e) => warn("TURN_END: saveDirectorState failed", e));

      // Hand off to STANDALONE_REACTION_WINDOW for turn_end. The
      // payload uses the BEFORE-nextTurn actor (the actor whose turn
      // is ending) so end-of-turn reactions can read which turn ended.
      // standaloneAfter branches on endOfRound (ROUND_END vs TURN_START)
      // — the same routing the prior transition function did inline.
      director.ctx.standaloneTrigger = "turn_end";
      director.ctx.standaloneAfter   = director.ctx.endOfRound ? STATES.ROUND_END : STATES.TURN_START;
      director.ctx.standalonePayload = {
        actingActorUuid: endingActorUuid,
        actingTokenUuid: endingTokenUuid,
      };
      director.enqueue({ type: INTENTS.INTERNAL_DONE });
      return;
    }

    // Manual-fallback path: no dCombat, drive the Foundry combat directly.
    // No standalone reactions in this path — manual fallback predates the
    // declarative reaction system and isn't worth threading the new state
    // through. The transition still routes via STANDALONE_REACTION_WINDOW
    // (which no-ops on zero reactors) → next state.
    const combat = director.combat;
    if (!combat) {
      director.ctx.endOfCombat = true;
      director.ctx.standaloneTrigger = "turn_end";
      director.ctx.standaloneAfter   = STATES.STOPPED;
      director.ctx.standalonePayload = null;
      director.enqueue({ type: INTENTS.INTERNAL_DONE });
      return;
    }
    const wasRound = combat.round;
    try {
      await combat.nextTurn();
    } catch (e) {
      warn("TURN_END: combat.nextTurn() threw", e);
      director.ctx.endOfCombat = true;
      director.ctx.standaloneTrigger = "turn_end";
      director.ctx.standaloneAfter   = STATES.STOPPED;
      director.ctx.standalonePayload = null;
      director.enqueue({ type: INTENTS.INTERNAL_DONE });
      return;
    }
    director.ctx.endOfRound = (combat.round !== wasRound);
    director.ctx.standaloneTrigger = "turn_end";
    director.ctx.standaloneAfter   = director.ctx.endOfRound ? STATES.ROUND_END : STATES.TURN_START;
    director.ctx.standalonePayload = null;
    director.enqueue({ type: INTENTS.INTERNAL_DONE });
  },
};

// ─── ROUND_END ─────────────────────────────────────────────────────────
const RoundEnd = {
  async onEnter(director) {
    log(`ROUND_END`);

    // Sweep AEs whose lifetime is "round_end" (Rampart's playtest
    // mechanic et al.) — they expire at the end of any round, ahead of
    // the standalone reaction window so round_end-triggered reactions
    // see a clean slate.
    try {
      const swept = await tickDirectorAEsAtRoundEnd();
      if (swept?.swept) {
        log(`ROUND_END: swept ${swept.swept} round-end AE(s): ${swept.names.join(", ")}`);
      }
    } catch (e) { warn("ROUND_END: tickDirectorAEsAtRoundEnd threw", e); }

    // Hand off to STANDALONE_REACTION_WINDOW for round_end. The transition
    // rule branches on endOfCombat (combat over → STOPPED, otherwise →
    // STANDALONE_REACTION_WINDOW → ROUND_START).
    director.ctx.standaloneTrigger = "round_end";
    director.ctx.standaloneAfter   = STATES.ROUND_START;
    director.ctx.standalonePayload = null;
    director.enqueue({ type: INTENTS.INTERNAL_DONE });
  },
};

// ─── STANDALONE_REACTION_WINDOW ────────────────────────────────────────
// Inserted between FSM transitions to host standalone-trigger reactions
// (conflict_start, round_start, turn_start, turn_end, round_end). The
// predecessor state sets ctx.standaloneTrigger + standaloneAfter +
// standalonePayload; this handler dispatches the trigger (blocking until
// every reactor menu closes) and then enqueues INTERNAL_DONE so the
// transition reader picks up standaloneAfter. ABORT/TIMEOUT during the
// reaction phase route to ABORTED cleanly (the FSM sees them as a real
// state, not a parked handler), and idempotency persistence inside
// dispatch survives F5 mid-reaction.
const StandaloneReactionWindow = {
  async onEnter(director) {
    const ctx = director.ctx;

    // Re-entry detection: top of stack is an `srwDetour:` frame we
    // pushed on a prior entry when we detoured through FAW. Pop it
    // now; the snapshot restores standaloneTrigger / standaloneAfter /
    // standalonePayload to the values they had pre-detour, so the
    // dispatch + queue-check loop below runs on the same trigger.
    // The pop fires regardless of save/resume — the routing target
    // (top.resumeAt = SRW) is what brought us back here.
    // Re-entry after a FAW detour (free-action drain) is marked by the
    // srwDetour frame on top. Capture it BEFORE popping: for phased
    // (transactional) triggers it tells us the forced pass + settle +
    // checkpoint already ran on the first entry, so we skip straight to the
    // ask pass and don't re-tick Burn / re-settle.
    const wasReentry = topIsSrwDetour(ctx);
    if (wasReentry) {
      popFrame(director);
    }

    const trigger = ctx.standaloneTrigger ?? null;
    const finalTarget = ctx.standaloneAfter ?? null;
    const payload = ctx.standalonePayload ?? null;
    if (!trigger || !finalTarget) {
      warn(`STANDALONE_REACTION_WINDOW: missing trigger/finalTarget (trigger=${trigger}, final=${finalTarget}); passing through`);
      director.enqueue({ type: INTENTS.INTERNAL_DONE });
      return;
    }
    log(`STANDALONE_REACTION_WINDOW: ${trigger} (final target ${finalTarget}, depth ${stackDepth(ctx)})`);
    // Transactional instance frame — EVERY standalone lifecycle trigger now runs
    // as a transaction: a deterministic FORCED pass (ticks like Burn commit +
    // forced grants enqueue) → settleInstance drains the resource ledger to
    // quiescence (T1; crisis cascade plugs in here) → CHECKPOINT (the commit
    // point, after the forced result is settled) → ASK pass (player reactions).
    // Mandatory free-action cards enqueued above drain through the existing FAW
    // detour below (T2), after the checkpoint.
    //
    // The forced→settle→ask ordering is what lets an ask-mode reaction SEE the
    // AEs that a force-mode reaction committed in the same window: the ask pass
    // re-collects candidates fresh (findPassiveCandidates), so e.g. a skill gated
    // on a force-applied AE at round_start is offerable on the first round. The
    // legacy single combined pass evaluated ask availability from a snapshot
    // taken BEFORE force fired, which dropped such skills. Conflict-start crisis
    // seeding stays gated to conflict_start (below). Every trigger that reaches
    // this handler is a standalone trigger, so this set covers all of them.
    const PHASED = STANDALONE_TRIGGERS.has(trigger);
    try {
      if (PHASED) {
        if (!wasReentry) {
          // Crisis reconcile BEFORE the forced dispatch. The event-driven crisis
          // reactor only fires on HP CHANGES, so it misses (a) a creature already
          // below threshold at combat start, and (b) one whose HP settled below
          // threshold via a path that didn't re-fire the reactor — e.g. an
          // Unbreakable "reduce to 1" clamp after a would-be-lethal hit. Sweeping
          // at conflict_start AND every turn_start makes Crisis self-correct, and
          // — crucially — running it BEFORE the forced dispatch means force-mode
          // turn_start reactions that gate on Crisis (Zero Trigger: Suffering's
          // ENEMY_IN_CRISIS) evaluate against up-to-date Crisis AEs.
          if (trigger === "conflict_start" || trigger === "turn_start") {
            try {
              const { sweepCrisis } = await import("./crisis-reactor.js");
              await sweepCrisis(director);
            } catch (e) { warn(`STANDALONE_REACTION_WINDOW: ${trigger} crisis sweep threw`, e); }
          }
          // FORCED pass — auto-fire force/on (Burn commits + populates the
          // ledger; action-creating grants like High Speed enqueue freeActionQueue).
          await dispatchStandaloneTrigger({ director, trigger, payload, phase: "forced" });
          // SETTLE (T1) — drain the resource ledger, re-firing to quiescence.
          try {
            const { settleInstance } = await import("./instance-settle.js");
            await settleInstance(director, { reason: trigger });
          } catch (e) { warn(`STANDALONE_REACTION_WINDOW: ${trigger} settleInstance threw`, e); }
          // CHECKPOINT — transaction commit point (forced reactions settled).
          try {
            const lbl = rewindPhaseLabel(ctx, director.dCombat?.round);
            await saveDirectorState(director, {
              label: `${lbl} · settled`,
              description: "Forced reactions settled — awaiting player decision",
            });
          } catch (e) { warn(`STANDALONE_REACTION_WINDOW: ${trigger} settle checkpoint failed`, e); }
        }
        // ASK pass — surface player-facing reactions only (auto-fires suppressed;
        // already-decided asks deduped by scope idempotency). Runs every entry.
        const spawned = await dispatchStandaloneTrigger({ director, trigger, payload, phase: "ask" });
        if (spawned) log(`STANDALONE_REACTION_WINDOW: ${trigger} ask pass dispatched ${spawned} menu(s)`);
      } else {
        const spawned = await dispatchStandaloneTrigger({ director, trigger, payload });
        if (spawned) log(`STANDALONE_REACTION_WINDOW: ${trigger} dispatched ${spawned} reactor menu(s)`);
      }
    } catch (e) {
      warn(`STANDALONE_REACTION_WINDOW: ${trigger} dispatch threw`, e);
    }
    // If any reaction enqueued a free-action grant (open_action_menu
    // free_mode), push a continuation frame capturing where we'll
    // resume after the queue drains, then route to FAW. FAW's exit
    // (queue empty + free-action frame popped) reads `top.resumeAt`
    // and transitions back here, where the pop above restores our
    // captured trigger/after/payload. Loop terminates when dispatch
    // produces no new menus AND the queue is empty → SRW exits via
    // INTERNAL_DONE → ctx.standaloneAfter (the original final target).
    try {
      const { freeActionQueue } = await import("./free-action-queue.js");
      if (!freeActionQueue.isEmpty()) {
        log(`STANDALONE_REACTION_WINDOW: ${freeActionQueue.size()} free-action request(s) pending → detour through FREE_ACTION_WINDOW → resume here on completion`);
        // PUSH the detour frame BEFORE mutating standaloneAfter. The
        // snapshot captures the CURRENT (pre-mutation) standaloneAfter
        // so the pop restores it to the original final target. Without
        // the snapshot, the FSM would have no record of where SRW was
        // supposed to exit to.
        pushFrame(director, {
          reason: `srwDetour:${trigger}`,
          resumeAt: STATES.STANDALONE_REACTION_WINDOW,
          fieldsToSnapshot: ["standaloneTrigger", "standaloneAfter", "standalonePayload"],
        });
        // Re-point standaloneAfter at FAW so the state machine's
        // INTERNAL_DONE → standaloneAfter rule routes us through the
        // free-action drain. The push above already captured the
        // original; pop will restore on re-entry.
        ctx.standaloneAfter = STATES.FREE_ACTION_WINDOW;
        // F5-survival checkpoint. The save sites at PREP / TURN_START /
        // CONFIRM / RESOLVE / TURN_END never fire between SRW's dispatch
        // and the player picking their free action — without this explicit
        // save, F5 mid-pipeline restores to a pre-SRW state where
        // standaloneFired already records the click (filtering HS) AND
        // the queue is empty (no FAW branch fires). The player's free
        // action is then lost on resume.
        //
        // Now we save WITH the detour frame on the stack, so resume
        // sees the frame and routes to top.resumeAt = SRW (after FAW
        // handles its own re-entry detection). Same end state as the
        // live flow.
        try {
          const peek = freeActionQueue.peek();
          const reactorName = peek?.sourceLabel
            ? `${peek.sourceLabel}`
            : "free action";
          // This save fires AFTER the srwDetour frame is pushed (line
          // above), so rewindPhaseLabel walks the stack and sees the
          // conflict_start frame — labels "Conflict Start · …" when
          // the originating trigger was conflict_start, "Round N · …"
          // otherwise (turn_start etc.).
          const sawPhase = rewindPhaseLabel(director.ctx, director.dCombat?.round);
          await saveDirectorState(director, {
            label: `${sawPhase} · ${reactorName} pending`,
            description: `${freeActionQueue.size()} free action(s) queued; awaiting player choice`,
          });
        } catch (e) {
          warn("STANDALONE_REACTION_WINDOW: pre-FAW save failed", e);
        }
        director.enqueue({ type: INTENTS.INTERNAL_DONE });
        return;
      }
    } catch (e) {
      warn("STANDALONE_REACTION_WINDOW: free-action queue check threw", e);
    }
    // No pending actions — all reactors decided (or none matched). Exit
    // to the original final target. standaloneAfter is already correct
    // (the pop above restored it if we re-entered after a FAW drain).
    log(`STANDALONE_REACTION_WINDOW: ${trigger} loop complete → ${finalTarget}`);
    director.enqueue({ type: INTENTS.INTERNAL_DONE });
  },
};

// ─── FREE_ACTION_WINDOW ─────────────────────────────────────────────────
// Drains the FreeActionQueue produced by reaction chains' free_mode
// effect. Each request runs through the full DECLARE → ... → RESOLVE
// pipeline with the reactor's turn snapshot temporarily swapped in.
//
// onEnter has two modes, distinguished by what's on top of the
// continuation stack:
//   - Top is a `freeAction:*` frame → re-entering after RESOLVE /
//     REACTION_WINDOW. Pop the frame (which restores the original
//     turnSnapshot + actionResult) and clear the freeActions singleton
//     for that reactor, then fall through to the dequeue path so the
//     next request (or exit) is handled.
//   - Top is anything else (srwDetour, empty) → first entry. Dequeue
//     if available; if the queue is empty, exit to top.resumeAt (or
//     TURN_START fallback). If non-empty, push a `freeAction:*` frame
//     snapshotting turnSnapshot+actionResult, install the freeActions
//     singleton, swap in the reactor's view, and route to DECLARE.
//
// See [[free-actions]] for the queue contract + [[continuation-stack]]
// for the frame shape.
const FreeActionWindow = {
  async onEnter(director) {
    const ctx = director.ctx;
    const { freeActionQueue } = await import("./free-action-queue.js");
    const { freeActions } = await import("./free-actions.js");

    // Re-entry after a completed free action — pop the frame to restore
    // the original turnSnapshot + actionResult, and clear the freeActions
    // singleton entry for this reactor. The frame's `extra` carries the
    // request + reactorActorId so we can identify whom to clear.
    if (topIsFreeAction(ctx)) {
      const popped = popFrame(director);
      const reactorId = popped?.extra?.reactorActorId
        ?? popped?.extra?.request?.reactorActorId
        ?? null;
      log(`FREE_ACTION_WINDOW: free action complete (${popped?.reason ?? "?"}) — popped + snapshot restored`);
      if (reactorId) freeActions.clear(reactorId);
    }

    // Drain the next request, or exit.
    if (freeActionQueue.isEmpty()) {
      // Exit target = whatever's now on top of the stack, or TURN_START
      // when the stack is empty (e.g. queue drained at top level with
      // no SRW detour frame underneath). The state-machine rule for
      // FAW's INTERNAL_DONE reads this same predicate.
      const nextTarget = peekTop(ctx)?.resumeAt ?? STATES.TURN_START;
      log(`FREE_ACTION_WINDOW: queue empty — routing to ${nextTarget}`);
      director.enqueue({ type: INTENTS.INTERNAL_DONE });
      return;
    }

    const req = freeActionQueue.dequeue();
    if (!req) {
      director.enqueue({ type: INTENTS.INTERNAL_DONE });
      return;
    }

    // Resolve the reactor's token + actor.
    const reactorActor = await fromUuid(req.reactorActorUuid).catch(() => null);
    const reactorTokenDoc = req.reactorTokenUuid
      ? await fromUuid(req.reactorTokenUuid).catch(() => null)
      : null;
    if (!reactorActor || !reactorTokenDoc) {
      warn(`FREE_ACTION_WINDOW: reactor lookup failed (actor=${!!reactorActor}, token=${!!reactorTokenDoc}); skipping request "${req.sourceLabel}"`);
      // Re-enter to drain next or exit. No push happened, so re-entry
      // sees no `freeAction:*` frame on top and falls through to the
      // dequeue path again.
      director.enqueue({ type: INTENTS.INTERNAL_DONE });
      return;
    }

    // Install the freeActions singleton from the request — COMPUTE reads
    // this to bake checkBonus / damageBonus into the action's roll and
    // composeAction reads `enabledLabels` to filter the Octopath.
    freeActions.set(req.reactorActorId, {
      enabledLabels:    req.enabledLabels,
      checkBonus:       req.checkBonus,
      damageBonus:      req.damageBonus,
      hrAsZero:         req.hrAsZero === true,
      sourceLabel:      req.sourceLabel,
      sourceItemUuid:   req.sourceItemUuid,
      // free_action preset (null for compose-style free_mode grants): a fully
      // determined action bundle. DECLARE reads this to skip composeAction and
      // stage the exact action directly. See applyFreeActionEffect.
      preset:           req.preset ?? null,
      // chain strike → bypasses preventFreeAttack (freeActions.get/set honor it).
      chain:            req.chain === true,
    });

    // PUSH the free-action frame BEFORE mutating turnSnapshot+actionResult.
    // The snapshot captures the OLD values (original turn-owner's view)
    // so the pop on re-entry restores them. `extra` carries the request
    // so we can read reactorActorId + sourceLabel after pop, and so
    // diagnostic surfaces (rewind list, logs) can name the frame.
    pushFrame(director, {
      reason: `freeAction:${req.sourceLabel ?? "?"}`,
      resumeAt: STATES.FREE_ACTION_WINDOW,
      fieldsToSnapshot: ["turnSnapshot", "actionResult"],
      extra: { request: req, reactorActorId: req.reactorActorId },
    });

    // Swap in the reactor's view. Pop will restore the originals.
    try {
      const combatant = director.dCombat?.combatants?.find?.((c) => c.actorUuid === req.reactorActorUuid);
      if (combatant) {
        ctx.turnSnapshot = snapshotDirectorCombatant(combatant);
      } else {
        // Reactor isn't in dCombat (e.g. summon mid-battle). Fall back
        // to snapshotCombatant from the token.
        ctx.turnSnapshot = snapshotCombatant({ actor: reactorActor, tokenDoc: reactorTokenDoc });
      }
    } catch (e) {
      warn("FREE_ACTION_WINDOW: snapshot threw", e);
      // Pop's snapshot still holds the pre-push value; leave turnSnapshot
      // as-is for now (will be restored on pop).
    }
    ctx.actionResult = null;

    log(`FREE_ACTION_WINDOW: starting free action "${req.sourceLabel}" for ${reactorActor.name} (${req.enabledLabels.join(", ") || "any"})`);
    director.enqueue({ type: INTENTS.INTERNAL_DONE });
  },
};

// ─── ABORTED ───────────────────────────────────────────────────────────
const Aborted = {
  async onEnter(director, { triggerIntent }) {
    const reason = director.ctx.abortReason ?? triggerIntent?.body?.reason ?? "aborted";
    log(`ABORTED — ${reason}`);
    if (!director.ctx.endOfCombat) {
      ui.notifications?.warn(`Director: action aborted (${reason})`);
    }
    director.ctx.abortReason = null;
    director.enqueue({ type: INTENTS.INTERNAL_DONE });
  },
};

// ─── STOPPED ───────────────────────────────────────────────────────────
const Stopped = {
  async onEnter(director) {
    log("STOPPED");
    TurnUI.despawn({ director });
    TurnPicker.despawn({ director });
    WeaponModePicker.despawn({ director });
    AttributePairPicker.despawn({ director });
    SkillPicker.despawn({ director });
    ListPicker.despawnAll();  // tears down weapon-mode / skill / item / menu overlays
    BattlefieldActionCard.despawn({ director });
    // Drop any reaction menus left over from earlier in the battle.
    // conflict_end has no dispatch site yet — it needs a pre-STOPPED
    // hook (last turn's RESOLVE? a CLEANUP_AFTER state?) so the player
    // can react before tokens get wiped. Tracked in
    // [[reaction-menu-on-token]] as next-iteration work.
    try { await clearAllStandaloneMenus(); } catch (e) { warn("STOPPED: clearAllStandaloneMenus threw", e); }
    // Tear down BD player HUD and clear reload-gate scene flags.
    try {
      const scene = director.dCombat?.scene ?? canvas?.scene ?? null;
      await destroyDirectorHud(scene);
    } catch (e) { warn("STOPPED: destroyDirectorHud threw", e); }
  },
};

// ─── ANIMATION ─────────────────────────────────────────────────────────
const Animation = {
  async onEnter(director) {
    const ar = director.ctx.actionResult;
    const spec = await resolveAnimationSpec(ar);

    if (!spec.hasScript) {
      // No animation defined for this action — skip straight through.
      director.enqueue({ type: INTENTS.INTERNAL_DONE });
      return;
    }

    const casterTokenUuid    = ar?.attacker?.tokenUuid ?? null;
    const targetTokenUuids   = (ar?.targets ?? []).map((t) => t.tokenUuid).filter(Boolean);

    // playDirectorAnimation is intentionally not awaited here — it drives
    // itself asynchronously and enqueues INTERNAL_DONE when the gate resolves.
    // Errors are caught inside; the catch block below handles unexpected throws
    // that slip through (defensive).
    playDirectorAnimation({ spec, director, casterTokenUuid, targetTokenUuids }).catch((e) => {
      warn("Animation.onEnter: playDirectorAnimation threw unexpectedly", e);
      director.enqueue({ type: INTENTS.INTERNAL_DONE });
    });
  },

  onExit(director) {
    // Abort the gate if the FSM leaves ANIMATION for any reason before the
    // animation finishes (e.g. STOP_COMBAT during a cinematic).
    if (director.ctx.animationController?.playing) {
      try { director.ctx.animationController.abort?.(); } catch {}
      director.ctx.animationController = null;
    }
  },

  onAbort(director) {
    if (director.ctx.animationController?.playing) {
      try { director.ctx.animationController.abort?.(); } catch {}
      director.ctx.animationController = null;
    }
  },
};

// ─── BATTLE_ENDING ─────────────────────────────────────────────────────
// Dev mode (payload.options.devMode or context.lean) skips the cinematic
// pipeline entirely; the bare boot.stop() cleanup that follows is enough.
// On cancel or any throw the sequence returns early and INTERNAL_DONE
// still fires, routing to STOPPED where boot.stop() runs cleanup.
const BattleEnding = {
  async onEnter(director) {
    log("BATTLE_ENDING");

    // Clear all battle UI before the cinematic starts. These are all
    // no-ops if the respective components aren't open.
    try { TurnUI.despawnAll(); } catch (e) { warn("BATTLE_ENDING: TurnUI.despawnAll threw", e); }
    try { TurnPicker.despawnAll(); } catch (e) { warn("BATTLE_ENDING: TurnPicker.despawnAll threw", e); }
    try { await clearAllStandaloneMenus(); } catch (e) { warn("BATTLE_ENDING: clearAllStandaloneMenus threw", e); }
    try { hideRoundBanner(); } catch (e) { warn("BATTLE_ENDING: hideRoundBanner threw", e); }
    try {
      const scene = director.dCombat?.scene ?? canvas?.scene ?? null;
      await destroyDirectorHud(scene);
    } catch (e) { warn("BATTLE_ENDING: destroyDirectorHud threw", e); }

    const isDevMode = !!(
      director.ctx.payload?.options?.devMode ||
      director.ctx.payload?.context?.lean
    );
    if (!isDevMode) {
      try {
        await runBattleEndSequence(director);
      } catch (e) {
        warn("BATTLE_ENDING: sequence threw (continuing to STOPPED)", e);
      }
    }
    director.enqueue({ type: INTENTS.INTERNAL_DONE });
  },
};

export const STATE_HANDLERS = Object.freeze({
  [STATES.PREP]:            Prep,
  [STATES.ROUND_START]:     RoundStart,
  [STATES.TURN_START]:      TurnStart,
  [STATES.DECLARE]:         Declare,
  [STATES.TARGET]:          Target,
  [STATES.COMPUTE]:         Compute,
  [STATES.CONFIRM]:         Confirm,
  [STATES.ANIMATION]:       Animation,
  [STATES.RESOLVE]:           Resolve,
  [STATES.OPPORTUNITY_WINDOW]: OpportunityWindow,
  [STATES.REACTION_WINDOW]:   ReactionWindow,
  [STATES.CLEANUP]:         Cleanup,
  [STATES.TURN_END]:        TurnEnd,
  [STATES.ROUND_END]:       RoundEnd,
  [STATES.STANDALONE_REACTION_WINDOW]: StandaloneReactionWindow,
  [STATES.FREE_ACTION_WINDOW]: FreeActionWindow,
  [STATES.ABORTED]:         Aborted,
  [STATES.BATTLE_ENDING]:   BattleEnding,
  [STATES.STOPPED]:         Stopped,
});
