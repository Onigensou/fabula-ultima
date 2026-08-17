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
import { isGmOverrideEmpty, summarizeGmOverride } from "./gm-card-override.js";
import { runBattleEndSequence } from "./battle-end/battle-end-orchestrator.js";
import { STATES } from "./states.js";
import { INTENTS } from "./intents.js";
import { snapshotCombatant, snapshotDirectorCombatant, snapshotEligibleTargets, snapshotEligibleTargetsFromDCombat, readPropNum, attrDieSize, freezeActionResult, applyAffinityToDamage, applyAttackRangeGate, applyStudyGuardExclusion, collectForcedIncludeTargets, resolvePrimaryAttackWeapon, captureSubjectSnapshot, resolvesVsMagicDefense, attackRangeBlockedBy } from "./snapshot.js";
import { TurnUI } from "./turn-ui.js";
import { TurnPicker } from "./turn-picker.js";
import { requestTargeting } from "./target-picker.js";
// The shared pre-picker target resolution — the same question the autopilot asks
// before it chooses an action. See target-survey.js's header for why the count
// and the pick must come from one place.
import { surveyActionTargets } from "./target-survey.js";
import { postActionCard, BattlefieldActionCard, composeActionCardRenderPayload } from "./action-card.js";
import { pickWeaponMode, WeaponModePicker } from "./weapon-mode-picker.js";
import { pickAttributePair, AttributePairPicker } from "./attribute-pair-picker.js";
import { runDirectorInit } from "./director-init.js";
import { destroyDirectorHud } from "./director-player-hud.js";
import { playStudyVfx, playActionNamecard, playMissVfx, playBlockVfx, playResourceSpendVfx } from "./director-vfx.js";
import { playCritCutin } from "./director-cutin.js";
import { playRoundBanner, hideRoundBanner } from "./director-round-banner.js";
import { resolveInitiativeGroupCheck } from "./director-initiative.js";
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
import { parseSkillCost, resolveCost, checkAffordable, debitCost, affordableTargetCount, mpCapTargetCount, computeEffectiveCost, mergeCostOverrides, formatCostMap } from "./skill-cost.js";
// COMPUTE-side damage/accuracy helpers (resolveAccuracyParts, resolveOutgoingDamageParts,
// isCriticalHit, applyCritDamage, resolveIncomingReduction, buildDamageBonusParts,
// resolveDamageElementOverride) moved to action-profile.js (single-source COMPUTE).
import { evaluateFormula, buildSkillResolver } from "./skill-formulas.js";
import { freeActions } from "./free-actions.js";
import { makeChainContext, resolveTargetRef } from "./skill-targeting.js";
// skill-effects is routed through the hot-reload registry so edits to it take
// effect without Ctrl+Shift+R: the harness (per-call) and a live reloadHot()
// bump the global token, and SE() then resolves the freshly-imported module.
// `_seStatic` is the boot namespace, used until the first refresh. Call THROUGH
// the SE() accessor at every use site (see call sites below) — a destructured
// `const { fn } = SE()` would re-freeze the binding and defeat the point.
import * as _seStatic from "./skill-effects.js";
import { registerHotModule } from "./hot-reload.js";
const SE = registerHotModule(
  "battle-director/skill-effects.js",
  (t) => import(`./skill-effects.js?cb=${t}`),
  _seStatic,
);
import { appendBattleLog, buildMissRow } from "./director-battle-log.js";
import { rollCheck, checkVsThreshold } from "./check.js";
// Standalone-reaction dispatcher — runs at FSM transitions for triggers
// that aren't tied to an action card (conflict_start, turn_start, etc.).
// Spawns the token-anchored reaction menu via [[reaction-menu-on-token]].
import { dispatchStandaloneTrigger, clearAllStandaloneMenus } from "./standalone-reactions.js";
import { STANDALONE_TRIGGERS, phaseOf } from "./director-triggers.js";
import { pushFrame, popFrame, peekTop, topIsFreeAction, topIsSrwDetour, topIsResolveDetour, stackDepth, rewindPhaseLabel } from "./continuation-stack.js";
// Grappled (Advanced Debuff) — turn-start break-free helpers.
import { isGrappled, breakFree } from "./grappled.js";
// Boss "Super Armor" — Domination State / Ultima actions (Domination /
// Escape / Recovery). See [[domination.js]].
import {
  hasIgnoreActionGating,
  grantDominancePointsAtRoundStart,
  consumeDominancePoint,
  readDominancePoints,
  emitDominationBurst,
  emitEscapeFade,
  ULTIMA_COMMANDS,
  DOMINATION_STATE_AE_NAME,
} from "./domination.js";
import { canPay as canPayUltima, payPoint as payUltimaPoint } from "./invoke/invoke-core.js";
import { emitCrestsHidden } from "./domination-crest.js";

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
import { computeActionProfile, projectProfileToActionResult, resolveChosenChainRows } from "./action-profile.js";
import { classifyActionIntent } from "./skill-intent.js";
import { isAutopilotEnabled, isAiControlledTurn, isAiControlledCombatant, autopilotPickCombatant, autopilotDecideAction } from "./enemy-autopilot.js";
import { isSummonAutopilotEnabled, isAutomatedSummon, isAutomatedSummonTurn, summonVetoMs, isGuestActor } from "./summon-autopilot.js";
import { resolveAnimationSpec, playDirectorAnimation } from "./director-animation.js";
import { witnessNpcAbility, witnessFiredCandidate } from "./encyclopedia-witness.js";

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
      await SE().reapApplierTiedAEs(actor.uuid);
    } catch (e) { warn("Applier reaper (defeat) threw", e); }
  }, { label: "applier-reaper:defeat" });

  // Removal — the applier's combatant is deleted from the tracker.
  director.hooks.on("deleteCombatant", async (combatant /*, options, userId */) => {
    try {
      if (!game.user?.isGM) return;
      const auid = combatant?.actor?.uuid ?? null;
      if (!auid) return;
      await SE().reapApplierTiedAEs(auid);
    } catch (e) { warn("Applier reaper (remove) threw", e); }
  }, { label: "applier-reaper:remove" });

  log("Applier reaper watcher installed");
}

// A side is "wiped" when it has no LIVING member — either every member is
// defeated (isDefeatedLive: HP<=0 / defeated flag) OR the side has been emptied
// entirely (all members fled / removed / destroyed). Empty = wiped so a side
// cleared by NON-HP removal (leave_combat, destroy_summon, banish) is caught too.
// A combatant only counts toward its side's WIPE tally if losing it could ever
// happen. A Guest is undefeatable by design (defeat-reactor skips it in BOTH
// passesActorGates and evaluateDefeatStatus), so `isDefeatedLive()` returns
// false for it forever — and `every()` over a list containing one could never be
// true. Net effect before this filter: with a guest on the party side, TOTAL
// PARTY KILL was UNDETECTABLE. Every PC could be at 0 HP and the fight would run
// on, because the one body that cannot die kept the side "alive".
//
// Deliberately keyed on UNDEFEATABLE (the guest marker), not on the
// `cannot_be_targeted_by` targeting contract: a creature that is merely hard to
// target can still be killed, so it must keep counting here. These are two
// different questions and conflating them would silently drop real combatants
// from the tally.
function countsForSideWipe(c) {
  return !isGuestActor(c?.actorDoc ?? null);
}

function sideIsWiped(dc, side) {
  const all = dc.combatants.filter((c) => c.side === side);
  if (!all.length) return true;
  const members = all.filter(countsForSideWipe);
  // A side made up ENTIRELY of undefeatable helpers has no one left who could
  // lose, so it counts as wiped — otherwise a fight where every PC is down but a
  // guest remains would never end.
  if (!members.length) return true;
  return members.every((c) => c.isDefeatedLive());
}

// End dCombat when EITHER side is wiped, so the FSM routes to BATTLE_ENDING on
// the next TURN_END rather than continuing into the "outnumbered" path where
// nextTurn() never signals `ended`. Covers enemy wipe (→ victory), TOTAL PARTY
// KILL (→ defeat — previously undetected, so a wiped party's enemies kept acting
// forever), and a side emptied by non-damage removal. Idempotent — dc.end()
// no-ops once ended. detectOutcome() classifies victory vs defeat downstream.
export function checkSideWipe(director) {
  const dc = director?.dCombat;
  if (!dc?.started || dc.ended) return false;
  const partyWiped = sideIsWiped(dc, "party");
  const enemyWiped = sideIsWiped(dc, "enemy");
  if (!partyWiped && !enemyWiped) return false;
  const which = [partyWiped ? "party" : null, enemyWiped ? "enemy" : null].filter(Boolean).join("+");
  log(`checkSideWipe: ${which} side wiped — ending dCombat`);
  dc.end();
  return true;
}

// Event-driven half of side-wipe detection: every HP change that lands a creature
// at <=0 re-checks BOTH sides. The removal half (a side emptied by leave_combat /
// destroy_summon / banish with no HP change) is covered by the removeCombatant
// path, which also calls checkSideWipe.
export function installSideWipeWatcher(director) {
  director.hooks.on("updateActor", (actor, change) => {
    try {
      if (!game.user?.isGM) return;
      const newHp = foundry.utils.getProperty(change, "system.props.current_hp");
      if (newHp === undefined || newHp === null) return;
      if (Number(newHp) > 0) return;                 // only a drop to <=0 can wipe a side
      checkSideWipe(director);
    } catch (e) { warn("SideWipeWatcher threw", e); }
  }, { label: "side-wipe" });

  log("Side wipe watcher installed");
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

// Effective action cost (base folded with adjust_cost overrides) now lives in
// skill-cost.js — the leaf module both this file and action-card.js can import,
// so the RESOLVE debit and the card's cost bullet share ONE calc point.

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
  // `coreAction` is meant to uniquely tag the one authored Common action Item,
  // but a gear `_skill` cloned from an action can leak the flag (e.g. the
  // encyclopedia gear cloned from Study). Collect every match and prefer the
  // one whose `action_command` agrees (the Common action authors set it; gear
  // leaves it ""), falling back to the first only if none qualifies — so a
  // stray cloned flag can never shadow the real action.
  const matches = (game.items ?? []).filter((it) =>
    it.type === "equippableItem" &&
    (it.flags?.["fabula-ultima-companion"]?.coreAction ?? null) === cmd
  );
  if (!matches.length) return null;
  return matches.find((it) =>
    String(it.system?.props?.action_command ?? "").trim().toLowerCase() === cmd
  ) ?? matches[0];
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

  // What step 1 actually took out of the pool. The settlement pass after the
  // on_activate chain (§3b) reconciles against this, so an `adjust_cost` row
  // authored inside the chain bills exactly like one authored on a reaction.
  let _debitedCost = null;
  // 1. Debit cost (unless an outer flow paid out-of-band).
  if (!skipCost) {
    // Effective cost = base (costSerialized) folded with adjust_cost overrides
    // (Hypercognition discount, Cataclysm overcharge, Fugitive waive) via the
    // single canonical calc — additive-then-multiplicative, clamped once. Covers
    // NATIVE-cost spells (top-level `cost` prop → costSerialized); in-chain
    // consume_resource costs are discounted separately in skill-effects.
    const costMap = new Map(Object.entries(computeEffectiveCost(ar.costSerialized, ar.costOverride)));
    // Item CREATION always costs at least 1 IP — no discount (adjust_cost / Maid Cap /
    // Deep Pockets) may drop a real IP cost below 1. Parity with buildReducedIpCost's
    // own floor, applied here so the RESOLVE debit honors it too.
    if (ar.itemSelection?.mode === "create" && costMap.has("ip") && (Number(ar.costSerialized?.ip) || 0) > 0) {
      costMap.set("ip", Math.max(1, Number(costMap.get("ip")) || 0));
    }
    // Snapshot AFTER the IP floor — this is the real figure §3b reconciles to.
    _debitedCost = Object.fromEntries(costMap);
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
          // Bimagus — count the native MP cost of a SPELL action toward the
          // caster's per-turn spell-MP tally (MP_SPENT_THIS_TURN). Gated on
          // skill_type=spell (Skill/Attack costs don't count). Bimagus's own
          // free casts pay no MP (skipCost) so they never reach here, and thus
          // never inflate the budget. In-chain consume_resource MP (Cataclysm's
          // cost-raise) is tallied separately at its debit site.
          const isSpellCast = String(skill?.system?.props?.skill_type ?? "").toLowerCase() === "spell";
          const mpDebited = Number(debitRes.debited?.mp ?? 0) || 0;
          if (isSpellCast && mpDebited > 0 && director.dCombat && casterActor?.id) {
            director.dCombat.addSpellMpSpent(casterActor.id, mpDebited);
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
    const accepted = Array.isArray(ar.acceptedCardReactions) ? ar.acceptedCardReactions : [];
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
        } catch (e) { warn(`resolveAction(negated): card reaction "${cand?.carrierName}" threw`, e); }
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
  // `shieldedOutOfChain` — a creature interposed for by Illusory Shield
  // (shield_redirect) vs a DAMAGING danger keeps its perTargetResults slot to
  // receive the phantasm's overflow damage, but RAW nullifies every OTHER
  // consequence for it: statuses, saves, and any `action_targets`-driven chain
  // effect. Drop it from the consequence chain here (the on-hit rider path
  // already excludes it via ar.hitTokenUuids). A non-damage danger removes the
  // defended from ar.targets outright, so this filter is the damage counterpart.
  // See card-mutations.applyShieldRedirectMutation.
  const allActionTargetUuids = (ar.targets ?? [])
    .filter((t) => !t?.shieldedOutOfChain)
    .map((t) => t.tokenUuid);
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
    // Cost discount from an accepted adjust_cost reaction (Hypercognition). A
    // MUTABLE copy — in-chain consume_resource rows subtract + decrement it so a
    // spell's total cost drops once regardless of how many consume rows it has.
    // `_parts` is copied too, not shared: the chain appends to it (adjust_cost)
    // and decrements the running totals (consume_resource spending a discount),
    // and neither may leak back onto the actionResult the card renders from.
    costOverride: ar?.costOverride
      ? { ...ar.costOverride, _parts: [...(ar.costOverride._parts ?? [])] }
      : null,
    // Route any interactive prompt this chain still opens (open_action_menu /
    // prompt_element / prompt_number / remove_tagged_ae / transfer_ae / targeting)
    // to the CASTING actor's owner, with the GM racing a local copy. COMPUTE
    // already did this for the pre_activate capture window (preRemotePrompt);
    // without the same wiring here, any row that prompts at RESOLVE instead —
    // one outside the pre_activate chain, or a re-prompt after a replay miss —
    // rendered GM-local only and the player never saw their own choice.
    remotePrompt: buildActingRemotePrompt(director, casterActor),
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
  // Pre-card targeting picks (Detonate's Phantasm) → resolveTargetRef replays
  // them off ctx.payload._capturedTargets instead of re-prompting at RESOLVE.
  if (ar?.preActivateTargets && typeof ar.preActivateTargets === "object") {
    ctx.payload._capturedTargets = { ...(ctx.payload._capturedTargets ?? {}), ...ar.preActivateTargets };
  }

  // Battle-log sink for THIS action: every commit (hits, via applyDamageToTarget's
  // logContext) + every miss (below) + any deal_damage riders fired through this
  // ctx push their {entry,row} here; we flush ONCE at the end → a Multi-N action
  // is one write, not N. Threaded onto ctx so rider effects coalesce too.
  const battleLogSink = [];
  ctx.battleLogSink = battleLogSink;

  // 3. Fire on_activate effect (pre-damage, no damage payload).
  //    Menu-picked invocations whose flat damage was LIFTED into the primary at
  //    COMPUTE (ar._damageViaProfile) apply that damage via the perTargetResults loop
  //    below — so suppress the chain's own deal_damage here to avoid double-applying.
  //    Status/heal/MP-drain rows in the same chain still run normally.
  ctx.suppressDealDamage = !!ar._damageViaProfile;
  // Where the override's provenance log stood before the chain ran. Anything
  // appended past this mark is an adjust_cost row the CHAIN contributed, and is
  // what §3b settles. (Length, not a deep diff: consume_resource mutates the
  // running totals as it spends a discount, so the totals are not a safe
  // before/after comparison — the appended parts are.)
  const _costPartsMark = (ctx.costOverride?._parts ?? []).length;
  let _chainAborted = false;
  try {
    const r = await SE().fireActivationEffect(skill, ctx);
    if (r?.abort) {
      log(`Skill resolve: on_activate aborted chain — skipping damage + post_damage`);
      _chainAborted = true;
    }
  } catch (e) { warn("Skill resolve: fireActivationEffect threw", e); }

  // 3b. Cost settlement — the seam that lets `adjust_cost` mean the same thing
  //     in a resolve-time chain as it does on a reaction.
  //
  //     The debit happens at §1, before the chain has run, so a chain-authored
  //     adjust_cost is necessarily late. Rather than forbid it there (which is
  //     what the engine used to do, silently), reconcile: bill the difference
  //     between what the chain added and what §1 already took. A surcharge
  //     debits the remainder; a discount refunds it.
  //
  //     Skipped entirely for a free cast (`skipCost`) — nothing was debited, so
  //     there is nothing to reconcile, and a surcharge on a free action must not
  //     suddenly start charging for it. Cataclysm on a Bimagus free cast still
  //     raises LAST_SPELL_MP (that reads the override, not the pool), which is
  //     how the overcharge spends the BUDGET instead of the caster's MP.
  if (!skipCost && !_chainAborted && casterActor) {
    try {
      const { sumCostParts, settleCostDelta } = await import("./skill-cost.js");
      const added = sumCostParts(ctx.costOverride, _costPartsMark);
      // Merge the chain's deltas into the CONFIRM-time override and re-run the
      // one canonical calc, rather than doing arithmetic here. That is not
      // tidiness — computeEffectiveCost accumulates every delta raw and clamps
      // ONCE at the end, and a per-step clamp reintroduces order-dependence.
      // Concretely: Fugitive's waive (−MAX) plus a +30 in-chain surcharge must
      // total 0, not 30. Clamping the pre-chain figure first would have charged
      // the 30.
      const merged = { ...(ar.costOverride ?? {}) };
      for (const [res, amt] of Object.entries(added)) {
        merged[res] = (Number(merged[res]) || 0) + (Number(amt) || 0);
      }
      const finalCost = computeEffectiveCost(ar.costSerialized, merged);
      const delta = {};
      for (const res of new Set([...Object.keys(finalCost), ...Object.keys(_debitedCost ?? {})])) {
        const owed = (Number(finalCost[res]) || 0) - (Number(_debitedCost?.[res]) || 0);
        if (owed !== 0) delta[res] = owed;
      }
      if (Object.keys(delta).length) {
        const res = await settleCostDelta(casterActor, delta);
        for (const [resource, amount] of Object.entries(res?.settled ?? {})) {
          if (Number(amount) > 0) playResourceSpendVfx({ tokenUuid: ar.attacker?.tokenUuid, resource, amount: Number(amount) });
        }
        log(`Skill resolve: in-chain adjust_cost settled ${JSON.stringify(res?.settled ?? {})}`);
      }
    } catch (e) { warn("Skill resolve: cost settlement threw", e); }
  }
  if (_chainAborted) return;

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
  // Accumulate the creatures that actually LOSE HP this action — fed to the
  // once-per-action `creature_completes_action` trigger below (Consume / Fear
  // Is the Key). Per-target creature_lose_resource still fires inside the loop;
  // this is the action-level roll-up so a multi-target hit fires the passive
  // once, not N times.
  const hpLossTargetTokenUuids = [];
  const hpLossTargetActorUuids = [];
  // Total HP damage this action dealt across all hit targets — surfaced on the
  // action-level creature_deals_damage payload so an on-hit rider's DAMAGE_DEALT
  // / DAMAGE_DEALT_TOTAL formula resolves (e.g. Diving Blaze Kick's Overflow
  // spillover deals the dealt amount to other enemies). For a single-target
  // skill this is exactly the one hit's value. Loss only (heals don't count).
  let totalDamageDealt = 0;
  // Pre-damage per-target status snapshots (keyed by tokenUuid), captured in the
  // damage loop BEFORE the HP write so the queued post-resolve
  // creature_deals_damage reaction can read a slain target's statuses. `hits`/`r`
  // are deep-frozen (freezeActionResult), so this MUST be a side Map — never a
  // property assigned onto `r`.
  const _subjectSnapshots = new Map();
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
      // Nullified hit (Ninja Log adjust_damage → 0): a HIT a defender reaction
      // soaked to 0. No loss VFX fires (applyDamageToTarget early-returns on 0),
      // so float a "BLOCK" cue — the visual twin of MISS. The attack still HIT,
      // so on-hit riders (queued from `struck` below) still apply; we just skip
      // the no-op damage write + loss-trigger path. Gated on the damageOverride
      // the adjust_damage card-mutation stamped reducing >0 to 0.
      if (r.hit && r.damageOverride
          && Number(r.damageOverride.to) <= 0 && Number(r.damageOverride.from) > 0) {
        playBlockVfx({ tokenUuid: r.tokenUuid });
        continue;
      }
      try {
        const targetActor = await fromUuid(r.actorUuid).catch(() => null);
        if (!targetActor) { warn("Skill resolve: target actor not found", r.actorUuid); continue; }

        // Snapshot the target's status/AE state NOW — before applyDamageToTarget
        // writes HP and a lethal hit removes the token — so the queued
        // post-resolve `creature_deals_damage` reaction can still read it after
        // the enemy is gone (e.g. Chomp stealing a slain target's Burn). Keyed by
        // tokenUuid in the side Map above because `r` is deep-frozen. Read into
        // the trigger payload below. See captureSubjectSnapshot in snapshot.js.
        _subjectSnapshots.set(r.tokenUuid, captureSubjectSnapshot(targetActor));

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
        const dmgRes = await SE().applyDamageToTarget({
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
            pierce: !!r.pierceMiss,
            sourceType: isAttackAction ? "Attack" : (view.kind ?? "Skill"),
            sink: battleLogSink,
          },
        });
        const finalValue = dmgRes.finalValue;
        const valueType = dmgRes.resource;
        const valueDirection = dmgRes.valueDirection;
        const damageTypeForPayload = valueDirection === "recover" ? "healing" : ar.damageType;

        // Roll-up for the per-action creature_completes_action trigger: record
        // any target whose HP actually dropped (positive HP loss).
        if (valueType === "hp" && valueDirection === "loss" && finalValue > 0) {
          hpLossTargetTokenUuids.push(r.tokenUuid);
          hpLossTargetActorUuids.push(r.actorUuid);
          totalDamageDealt += finalValue;
        }

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
        try { await SE().firePostDamageEffect(skill, ctx, damagePayload); }
        catch (e) { warn("Skill resolve: firePostDamageEffect threw", e); }

        // Part 1 — unified resource-ledger trigger. Fire creature_lose_resource /
        // creature_gain_resource on the creature whose HP/MP just changed (cause:
        // "damage"). Queued (post-save) + supervised. Part 2's crisis reactor
        // listens here (resource=hp); any "when my <resource> changes" skill too.
        SE().fireResourceChangeTrigger({
          director, actor: targetActor, tokenUuid: r.tokenUuid,
          resource: valueType, direction: valueDirection, amount: finalValue,
          cause: "damage",
          source: { actorUuid: ar.attackerActorRef, tokenUuid: ar.attacker?.tokenUuid ?? null },
          // Itemized identity + "how it changed" context (the attack site has the
          // full action result; the tick site can't supply weapon/roll fields).
          // The TRUE element, never the "healing" display label. An ABSORB is
          // still a bolt event — the affinity only decided which direction the
          // HP moved. Collapsing it to "healing" here threw away the one field
          // an absorb listener needs, so every `creature_gain_resource` row
          // gated on TRIGGER_DAMAGE_IS_<ELEMENT> read 0 and could never fire
          // (Lightning Prism's Overcharge, Skizzik's Chain Reaction,
          // Stitched-Up Jacket's "whether it lands or you absorb it").
          // The effect/tick path (skill-effects.fireResourceChangeTrigger at the
          // deal_damage site) has always passed the raw element through — this
          // is the attack path catching up, not a new convention. On a LOSS the
          // two expressions are identical, so the loss path is unchanged.
          element: ar.damageType,

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
          // Tag-provenance of any AE damage-increase actually applied to THIS
          // hit's element (element-gated) — backs AFFECTED_BY_<TAG>. The
          // effective element is the per-hit reaction override if any, else the
          // action element. Only on an HP loss; heals never carry a hex bump.
          appliedEffectTags: valueDirection === "loss"
            ? SE().collectAppliedIncreaseTags(targetActor, r.element ?? ar.damageType)
            : [],
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
              const drainRes = await SE().applyDamageToTarget({
                target: casterActor, damage: healAmt, affinity: "AB", resource: "hp",
                targetName: casterActor.name, tokenUuid: ar.attacker?.tokenUuid ?? null,
                logPrefix: `${view.kind} ${ar.skillName ?? skill?.name ?? ""}:`, logSuffix: " [Drain]",
                logContext: {
                  attackerName: casterActor.name, element: "healing",
                  sourceType: isAttackAction ? "Attack" : (view.kind ?? "Skill"),
                  sink: battleLogSink,
                },
              });
              SE().fireResourceChangeTrigger({
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

  // 5b. Miss VFX for can-miss actions with no damage (e.g. Zarg's Soul Steal
  //     Check). These skip the damage loop above (gated on isDamagingAction),
  //     so a failed Check would otherwise show no whiff. Fire the Miss flourish
  //     for each non-hit target. Gated on `ar.canMiss` (single-source capability
  //     flag) because auto-hit actions can't miss — nothing to whiff.
  //     MUST gate on `!isDamagingAction` (NOT `!ar.hasDamage`): a basic Attack
  //     is isDamagingAction via isAttackAction yet often has hasDamage=false, so
  //     gating on hasDamage would let this block fire a SECOND miss on top of the
  //     damage loop's (line ~529) — the double-MISS bug.
  if (!isDamagingAction && ar.canMiss && hits.length) {
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
    // Capability flag (single-source `ar.canMiss`): 1 when this action rolled a
    // Check that can miss — attacks, OFFENSIVE spells, opposed/Hinder checks —
    // and 0 for Heal/buff/utility. Read by ACTION_ROLLS_ACCURACY so a
    // creature_completes_spell reaction can gate to "spell with a check" (e.g.
    // Opportunity Advantage's self-consume only spends on an offensive spell).
    actionCanMiss: !!ar.canMiss,
    // Whether this was a FREE cast — read by ACTION_IS_FREE_CAST. Previously
    // stamped ONLY on the damage-window payload, so no post-resolve reaction
    // could tell a free cast from a paid one: Bimagus's follow-up gates on
    // `ACTION_IS_FREE_CAST == 1` off creature_completes_spell and would have
    // read 0 forever, never granting the second spell. It also has to live here
    // rather than at the damage window alone, because a NON-damaging first
    // spell (a buff or a heal) never reaches that window at all.
    //
    // Sourced from `skipCost` — the decision this very call was made with —
    // NOT from a fresh freeActions.get(). The registry lookup is the wrong
    // question twice over: the caller already applied the
    // `topIsFreeAction(ctx)` frame guard (a stale grant outside a free-action
    // frame must NOT count), and on the Attack path the grant is consumed at
    // COMPUTE, so by here it is gone.
    actionIsFreeCast: skipCost,
    // TOTAL MP cost of the spell/skill that just resolved — read by the
    // LAST_SPELL_MP formula identifier so a `creature_completes_spell` reaction
    // can size a follow-up off the cast's cost (Bimagus's "2nd spell ≤ ½ the
    // first", and its combined-budget decrement).
    //
    // "Total" is the databook's own word, and it is what both Bimagus and
    // Cataclysm are written against — Cataclysm says it "increases the spell's
    // TOTAL MP cost". So this folds `adjust_cost` overrides in: a 10 MP spell
    // overcharged by +10 reports 20, and spends 20 of Bimagus's budget. Printed
    // cost alone silently let an overcharged spell cost the budget nothing
    // (user ruling 2026-08-09: "10 spell + 10 Cataclysm is the same as casting
    // 20"). Widened from printed-only; no content read it at the time.
    //
    // Still correct for a FREE cast: `free_of_cost` skips the debit via
    // skipCost, it is NOT a cost override, so costSerialized + overrides survive
    // and the budget sees the real number. A Fugitive-style waive can no longer
    // drag it to 0 either — composeCostDelta drops DISCOUNTS on a free cast
    // (nothing is being debited, so there is nothing to discount) while still
    // composing SURCHARGES, which is how Cataclysm's overcharge spends the
    // granting budget rather than the pool.
    lastSpellMp: Number(computeEffectiveCost(ar.costSerialized, ar.costOverride)?.mp ?? 0) || 0,
    // Acting skill/weapon name for `reaction_source_skill` self-scoping
    // (replaces the removed skill_type item-gate).
    sourceSkillName: skill?.name ?? ar.skillName ?? ar.weapon?.name ?? null,
    // Total HP damage this action dealt — lets an on-hit rider's DAMAGE_DEALT /
    // DAMAGE_DEALT_TOTAL resolve (Diving Blaze's Overflow spillover). Single-
    // target skills: the one hit's value. 0 for non-damaging/whiffed casts.
    finalValue: totalDamageDealt,
    // SUBJECT of the action-level creature_deals_damage — the creature the
    // damage happened TO. Unlike the Attack path (which fires per hit target and
    // stamps each subject), a Skill fires ONE action-level event, so a SUBJECT-
    // relative gate (TARGET_AE_CHARGES_BURN, TARGET_AE_COUNT_*, …) has nothing to
    // read and silently evaluates 0 — which is exactly why Diving Blaze Kick's
    // "Blaze" rider (condition `TARGET_AE_CHARGES_BURN >= 1`) never fired. We
    // surface the single damaged target as the subject. Multi-target skills stay
    // ambiguous by design (per-target firing is the keyword-layer follow-up that
    // avoids hit_action_targets over-apply), so we only bind a subject for the
    // unambiguous single-hit case; multi-hit leaves it null (prior behavior).
    subjectActorUuid: hpLossTargetActorUuids.length === 1 ? hpLossTargetActorUuids[0] : null,
    subjectTokenUuid: hpLossTargetTokenUuids.length === 1 ? hpLossTargetTokenUuids[0] : null,
  };
  const accepted = Array.isArray(ar.acceptedCardReactions) ? ar.acceptedCardReactions : [];
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
          log(`resolveAction: card reaction "${cand?.carrierName}" not fired — 0 hit targets (no cost/effect)`);
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
        // Round-trip apply-click captures (roll_dice / prompt_number) for
        // performer/self reactions too (no reactorActorUuid, so firePayload stayed
        // payloadForPassives) — merge the captured chain-vars so a value the player
        // rolled at apply-click (Fugitive's 1d8) isn't re-rolled at RESOLVE.
        if (cand?.payloadAtFire?._chainVars && firePayload !== cand.payloadAtFire) {
          firePayload = {
            ...firePayload,
            _chainVars: { ...(firePayload?._chainVars ?? {}), ...cand.payloadAtFire._chainVars },
          };
        }
        await firePreAcceptedCandidate({
          director, casterActor: fireActor, candidate: cand, payload: firePayload,
        });
      } catch (e) { warn(`Skill resolve: card reaction "${cand?.carrierName}" threw`, e); }
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
    const allTargetUuids = (ar.targets ?? []).map((t) => t.tokenUuid);
    const struckTokenUuids = struck.map((r) => r.tokenUuid);
    // Champion Gloves / Hot Pants — record each GENUINELY hit target against the
    // attacker's per-turn tally. `struck` includes pierce-misses (Pierce = miss
    // for half), which are misses, so filter to real hits. Bumped here, AFTER
    // this action's bonuses were computed, so the tally a bonus reads is "hits
    // that landed before this attack" — see hitsOnTargetThisTurn.
    if (director.dCombat && ar.attacker?.actorId) {
      for (const r of hits) {
        if (r.hit && r.tokenUuid) director.dCombat.addHitOnTarget(ar.attacker.actorId, r.tokenUuid);
      }
    }
    if (struck.length) {

      // Free-action grant ON-HIT riders — the granting skill's effect_table rows
      // named in `onHitEffectRefs` run against the GENUINELY HIT targets
      // (hit_action_targets), so a spawned free attack can carry a declarative
      // on-hit effect from its source skill without baking logic into the weapon.
      // Ripples ends all "hex" AEs on the struck enemy here (RAW: hexes end "after
      // the attack has been resolved" and only "if it is successful"). Gated on a
      // real hit (not a pierce-miss). The element retype was already baked at
      // COMPUTE via grant.elementOverride.
      const _onHitRefs = ar.freeActionGrant?.onHitEffectRefs;
      if (Array.isArray(_onHitRefs) && _onHitRefs.length) {
        const _hitTokenUuids = struck.filter((r) => r.hit).map((r) => r.tokenUuid);
        const _srcSkill = (_hitTokenUuids.length && ar.freeActionGrant?.sourceItemUuid)
          ? await fromUuid(ar.freeActionGrant.sourceItemUuid).catch(() => null) : null;
        if (_srcSkill) {
          const riderCtx = {
            director, skill: _srcSkill, reactorActor: casterActor,
            reactorToken: ar.attacker?.tokenUuid ? { uuid: ar.attacker.tokenUuid } : null,
            hitActionTargetUuids: _hitTokenUuids,
            payload: { hitTargets: _hitTokenUuids, targetTokenUuids: _hitTokenUuids },
          };
          for (const ref of _onHitRefs) {
            try { await SE().applyEffectByLabel(String(ref).trim(), riderCtx); }
            catch (e) { warn(`RESOLVE: free-action on-hit ref "${ref}" threw`, e); }
          }
        }
      }

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
            // Pre-damage status/AE snapshot of THIS target, captured before the
            // HP write. Lets TARGET_AE_* reads in this post-resolve reaction
            // resolve even when a lethal hit already removed the target's token.
            subjectSnapshot: _subjectSnapshots.get(r.tokenUuid) ?? null,
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
            // Canonical spelling of the Accuracy Check total. `total` above is
            // the legacy key; ATTACK_CHECK_RESULT reads `checkTotal`, which was
            // only ever stamped on the DEFENDER-side creature_targeted_by_action
            // payload — so an attacker-side "my check result was N or more" gate
            // silently read 0 here. Drives "Snipe N" (Persuader, Man Catcher),
            // the check-total twin of HIT_MARGIN's "Conquer N".
            checkTotal: Number(ar.roll?.total ?? 0) || 0,
          },
        });
      }
    }
    // One-shot post-attack trigger — fires after all per-target
    // creature_deals_damage fires, and fires HIT OR MISS: a fully-evaded
    // attack still COMPLETES. The payload's allTargetsHit / allTargetsDamaged /
    // hitTargets (HIT_COUNT) are what hit-gated consumers filter on — Blazing
    // Sweep's repeat gates ALL_TARGETS_HIT == 1; Morrigan / Scythe gate
    // HIT_COUNT > 0. (This used to sit inside the struck-length gate above, so
    // a whiff emitted NOTHING and completes_attack repeat chains — Geist's
    // Shadowbringers — silently died on the first evade. Hit-or-miss is also
    // what the Opportunity Advantage-spend row documents and expects.)
    queuePostResolveTrigger(director, {
        casterActor,
        trigger: "creature_completes_attack",
        payload: {
          targets: allTargetUuids,
          targetTokenUuids: allTargetUuids,
          hitTargets: struckTokenUuids,
          hitTargetTokenUuids: struckTokenUuids,
          allTargetsHit: struckTokenUuids.length >= allTargetUuids.length && allTargetUuids.length > 0,
          // Stronger than allTargetsHit: every target took > 0 damage (excludes
          // immune / absorb / reduced-to-0 hits). Gates ALL_TARGETS_DAMAGED.
          allTargetsDamaged: hits.filter((r) => Number(r.damage) > 0).length >= allTargetUuids.length && allTargetUuids.length > 0,
          sourceActorUuid: ar.attackerActorRef,
          sourceTokenUuid: ar.attacker?.tokenUuid ?? null,
          actionIntent: ar.actionIntent,
          weaponUuid: ar.weapon?.uuid ?? null,
          // Acting skill/weapon name for `reaction_source_skill` self-scoping.
          sourceSkillName: ar.skillName ?? ar.weapon?.name ?? null,
        },
      });
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
    const evaluated = Array.isArray(ar.evaluatedCardReactions) ? ar.evaluatedCardReactions : [];
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

  // 7b-zp. Zero Power unleash. When the resolving skill carries the
  //     `isZeroPower` flag (the "this is a Zero Power" checkbox), broadcast
  //     `creature_unleashes_zero_power` so an ALLY's Zero Trigger reaction
  //     (Matador's "gain 6 Zero Power when an ally unleashes their Zero Power")
  //     can fire. Dispatched observer-aware (the trigger is in instance-settle's
  //     LEDGER_FAMILY) so it reaches allied combatants, not just the caster.
  //     Subject = the unleasher (payloadForPassives.sourceActorUuid); the matcher
  //     reads reaction_source "ally" against it (and excludes the caster's own).
  //     Mirrors the legacy emit (action-execution-core.js:1972) on the BD substrate.
  const _zpFlag = skill?.system?.props?.isZeroPower;
  if (_zpFlag === true || String(_zpFlag).toLowerCase() === "true" || String(_zpFlag) === "1") {
    queuePostResolveTrigger(director, {
      casterActor,
      trigger: "creature_unleashes_zero_power",
      payload: payloadForPassives,
    });
  }

  // 7c. Unified per-action HP-loss completion trigger. Fires ONCE per action
  //     (any kind) that caused ≥1 creature to lose HP. The payload's target list
  //     is narrowed to the HP-losing creatures (not all targeted) so
  //     ANY_TARGET_HAS_<STATUS> scans exactly "the creatures that lost HP", per
  //     RAW "after you cause one or more enemies to lose Hit Points…". Queued for
  //     post-save firing like the other completion triggers.
  if (hpLossTargetTokenUuids.length) {
    queuePostResolveTrigger(director, {
      casterActor,
      trigger: "creature_completes_action",
      payload: {
        ...payloadForPassives,
        targetTokenUuids: hpLossTargetTokenUuids,
        targetActorUuids: hpLossTargetActorUuids,
        hitTargets: hpLossTargetTokenUuids,
        targets: hpLossTargetTokenUuids,
      },
    });
  }

  // 7d. Per-missed-target `creature_miss_action` (resolution_phase). Fires for
  //     ANY action that can miss — `ar.canMiss` (single-source capability flag
  //     stamped in freezeActionResult: weapon Attack OR Check-skill/offensive
  //     spell). Once per MISSED target ACTOR per action; the per-actor dedup
  //     means a creature that absorbs multiple missed instances in one action
  //     (e.g. Protect covering an ally vs an AoE) still reacts ONCE → exactly
  //     one Adoration Clock fill.
  //
  //     DISPATCH MODEL: the reaction is DEFENDER-side — the MISSED creature
  //     reacts ("an enemy attacks YOU and misses"). We queue with
  //     `casterActor` = the missed creature so the post-resolve drain dispatches
  //     to IT (firePassiveTriggers reactor = casterActor). This is subject-
  //     scoped to that one creature — NOT observer-aware — so an enemy whiffing
  //     on someone else doesn't fill every ally's clock. The matcher
  //     (passesMatchFilters) reads `payload.sourceActorUuid` as the event
  //     subject, so the row uses reaction_source:"enemy" (the ATTACKER is the
  //     reactor's enemy) — matching the working Fancy Footwork. Drives Matador's
  //     Adoration fill + Fancy Footwork / Thread the Horns / Counter Pass.
  if (ar.canMiss && Array.isArray(hits) && hits.length) {
    const accuracyTotal = Number(ar.roll?.total ?? 0) || 0;
    const weaponRange   = ar.weapon?.range ?? ar.weapon?.weapon_range ?? null;
    const isRanged      = weaponRange ? /ranged|distance/i.test(String(weaponRange)) : false;
    const isMelee       = weaponRange ? /melee/i.test(String(weaponRange)) : false;
    const seenMissActors = new Set();
    for (const r of hits) {
      if (!r || r.hit || r.pierceMiss) continue;            // only genuine misses
      const dedupKey = r.actorUuid ?? r.tokenUuid;
      if (dedupKey && seenMissActors.has(dedupKey)) continue; // one event per target actor per action
      if (dedupKey) seenMissActors.add(dedupKey);
      // Reactor = the missed creature. Resolve its Actor so the drain dispatches
      // the reaction to IT (not the attacker).
      const missedActor = (await fromUuid(r.tokenUuid))?.actor ?? null;
      if (!missedActor) continue;
      const defense = Number(r.defense ?? 0) || 0;
      queuePostResolveTrigger(director, {
        casterActor: missedActor,
        trigger: "creature_miss_action",
        payload: {
          // subject = the ATTACKER (matcher's reaction_source reads sourceActorUuid)
          subjectTokenUuid:  ar.attacker?.tokenUuid ?? null,
          subjectActorUuid:  ar.attackerActorRef,
          sourceTokenUuid:   ar.attacker?.tokenUuid ?? null,
          sourceActorUuid:   ar.attackerActorRef,
          attackerUuid:      ar.attacker?.tokenUuid ?? null,
          attackerActorUuid: ar.attackerActorRef,
          // the missed creature (the reactor) — target_ref:"self" effects resolve
          // to it; carried for margin/melee reads too.
          targetUuid:        r.tokenUuid,
          targetTokenUuids:  [r.tokenUuid],
          targetActorUuid:   r.actorUuid,
          // Attack-kind actions don't stamp `actionIntent` on the actionResult
          // (it's set TARGET-side via classifyActionIntent for skills/spells) —
          // they're harmful by definition. Default it so a fill/counter row with
          // `reaction_action_intent: "harmful"` passes on a weapon attack too;
          // mirrors the creature_targeted_by_action dispatch (Protect). Without
          // this the Adoration Clock fill (+ Fancy Footwork / Thread the Horns /
          // Counter Pass) silently never fired on a missed basic Attack.
          actionIntent:      ar.actionIntent ?? (isAttackAction ? "harmful" : null),
          actionKind:        ar.kind ?? null,
          sourceSkillName:   skill?.name ?? ar.skillName ?? ar.weapon?.name ?? null,
          weaponUuid:        ar.weapon?.uuid ?? null,
          weaponType:        ar.weapon?.weaponType ?? null,
          weaponRange,
          isMelee,
          isRanged,
          // accuracy + margin for Fancy Footwork's `missMargin >= 6 - SL` gate.
          // missMargin = defender DEF − attacker accuracy total (how far short).
          total:        accuracyTotal,
          accuracyTotal,
          defense,
          missMargin:   defense - accuracyTotal,
          isCrit:       !!ar.roll?.isCrit,
          isFumble:     !!ar.roll?.isFumble,
        },
      });
    }
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

// `extractTargetCountFromText` and `resolveTargetPlan` now live in
// target-survey.js — they are the parsing half of the same question the autopilot
// asks, and splitting the parse from the pool is what let the two disagree.
// Import them from there; they are deliberately NOT re-exported here, because
// re-exporting would preserve the state-handlers -> compose-action -> state-handlers
// import cycle that moving them removed.

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
    // In-place reinforce (Battle-End follow-up, e.g. ⭐ Wandering Flame): we
    // re-enter PREP on the SAME live director to start a new conflict without
    // tearing down. Skip the overworld-viewport capture (preserve the value
    // from the first battle so the eventual boss-victory transition returns to
    // the right overworld view) and skip the lifecycle-watcher installs (the
    // ones from the first battle are still live and read director.dCombat at
    // fire time, so they auto-track the swapped combat). See [[battle-followup]].
    const inPlace = !!(payload?.context?.inPlaceReinforce);

    // Capture A: pre-battle viewport — synchronous, before runDirectorInit switches scenes.
    // Uses live PIXI stage values which are always accurate unlike _viewPosition.
    if (!inPlace) try {
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
    // director.hooks → auto-disposed on director.stop(). Skipped on an
    // in-place reinforce: the first battle's watchers are still installed and
    // read director.dCombat live, so they already track the swapped combat —
    // re-installing would double-fire them.
    if (!inPlace) {
      installGuardHpWatcher(director);
      // Reap orphaned applier-tied AEs when an applier is defeated/removed.
      installApplierReaperWatcher(director);
      // End dCombat when EITHER side is wiped so TURN_END routes to BATTLE_ENDING.
      installSideWipeWatcher(director);
      // Rewind tool: buffer item deletions between snapshots so the
      // rewind UI can recreate consumed items. See [[director-rewind-tool-plan]].
      installItemDeletionTracker(director);
    }
    // Pre-compute EXP/Zenit rewards while all enemy tokens are guaranteed live.
    // Stored in a world setting so it survives F5; read at BATTLE_ENDING to
    // pre-fill the GM prompt.
    try {
      const _isBoss = !!(director.ctx.payload?.battlePlan?.isBoss) ||
        String(director.ctx.payload?.battlePlan?.type ?? "").toLowerCase() === "boss";
      // Snapshot is always THIS battle's own rewards. Any carried rewards from
      // a preceding follow-up battle are merged in later at award time
      // (battle-end-orchestrator), so the snapshot never double-counts a chain.
      const _snap = await computeBattleEndRewards(director.dCombat, _isBoss);
      // Fresh (non-follow-up) battle — drop any stale carry from an
      // aborted/abandoned chain so it can't leak into an unrelated fight.
      if (!inPlace) game.settings.set("fabula-ultima-companion", "bdCarriedRewards", null);
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

    // Restore any items hidden by `hide_item` in a PRIOR battle (the
    // Encyclopedia's "vanish until end of scene"). The battle-END cleanup also
    // does this, but a battle that didn't shut down cleanly (crash, legacy-flow
    // end, manual re-start) would leave the item stranded — so re-running it at
    // battle START guarantees the item is back (UNEQUIPPED) for the new fight.
    try {
      const partyActors = (director.dCombat?.combatants ?? [])
        .filter((c) => c.side === "party")
        .map((c) => c.actorDoc)
        .filter(Boolean);
      for (const a of partyActors) await SE().restoreHiddenItems(a);
    } catch (e) { warn("PREP: restoreHiddenItems sweep threw", e); }

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

// Resolve which side seizes initiative for `roundNo` and COMMIT it to dCombat
// BEFORE the turn picker runs, returning the follow-up banner descriptor
// ({ kind, side? }) for ROUND_START to fan out after the round banner (or null
// for no flash). Director-orchestrated so the manager fully tracks the outcome
// (persisted via dCombat.initiativeThisRound + firstSide/currentSide).
//
// Modes:
//   • Ambush / Advantage — ROUND 1 only: the favoured side is forced first (the
//     consecutive surprise round is enforced by dCombat.nextTurn); flash
//     "AMBUSH!" / "ADVANTAGE!".
//   • rolled       — every round: backend Initiative Group Check
//     (director-initiative.js); the winner acts first; flash
//     "Player/Enemy Initiative".
//   • sidePriority — legacy fixed rule (firstSide set at build); no roll, no flash.
async function resolveRoundInitiative(director, roundNo) {
  const dc = director?.dCombat;
  if (!dc) return null;

  // Idempotent re-entry (same round already resolved): reuse the committed side,
  // don't re-roll or replay the flash. (Reload resumes at TURN_START/TURN_END, so
  // ROUND_START isn't re-entered there — this only guards in-session re-entry.)
  if (dc.initiativeThisRound?.round === roundNo) {
    const side = dc.initiativeThisRound.side === "enemy" ? "enemy" : "party";
    dc.firstSide = side;
    dc.currentSide = side;
    return null;
  }

  // Round 1 Ambush / Advantage — forced surprise side, no check.
  if (roundNo === 1 && (dc.engagement === "ambush" || dc.engagement === "advantage")) {
    const side = dc.engagement === "ambush" ? "enemy" : "party";
    dc.firstSide = side;
    dc.currentSide = side;
    dc.initiativeThisRound = { round: roundNo, side, forced: true, engagement: dc.engagement };
    return { kind: dc.engagement };
  }

  // Rolled mode — backend Initiative Group Check every round.
  if (dc.initiativeMode === "rolled") {
    const res = await resolveInitiativeGroupCheck(dc);
    const side = res.side === "party" ? "party" : "enemy";
    dc.firstSide = side;
    dc.currentSide = side;
    dc.initiativeThisRound = {
      round: roundNo, side, forced: false,
      dl: res.dl, bonus: res.bonus,
      leaderName: res.leaderName ?? null, leaderTotal: res.leaderTotal ?? null,
      degraded: !!res.degraded,
    };
    return { kind: "initiative", side };
  }

  // sidePriority — fixed firstSide from build; reaffirm currentSide, no flash.
  dc.currentSide = dc.firstSide;
  dc.initiativeThisRound = { round: roundNo, side: dc.firstSide, forced: false, mode: "sidePriority" };
  return null;
}

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

    // Determine which side seizes initiative THIS round (director-orchestrated,
    // committed to dCombat before TURN_START picks) and the follow-up flash to
    // announce it. Awaited so currentSide is authoritative before the picker.
    let followup = null;
    if (roundNo > 0) {
      try { followup = await resolveRoundInitiative(director, roundNo); }
      catch (e) { warn("resolveRoundInitiative threw", e); }
    }

    // Start-of-round cinematic banner ("ROUND N" + Critical_1 SFX), then the
    // initiative / ambush / advantage flash (if any). Non-blocking — the banner
    // plays asynchronously. We hand the director its COMPLETION promise on ctx so
    // the enemy autopilot (TURN_START) can hold until the cinematic clears,
    // keeping the sequencing owned + tracked by the director rather than a loose
    // global. Reset to null when there's no banner (no round yet).
    director.ctx.initiativeBannerDone = (roundNo > 0)
      ? playRoundBanner({ round: roundNo, followup })
      : null;

    // Boss Dominance accrual — every enemy boss banks 1 Dominance Point on
    // rounds 3, 6, 9, ... (capped). Awaited so the AE exists before any
    // round_start reactions / the next turn snapshot read the pool.
    await grantDominancePointsAtRoundStart(director);

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
    // Domination State ("Super Armor") — Grappled stays applied but is inert,
    // so a dominating boss neither needs nor is offered the break-free check.
    if (hasIgnoreActionGating(actor)) {
      log(`Break Free: ${snap.name} is Dominating — Grappled inert, skipping break-free`);
      return;
    }

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

// Identity of "this creature's action, this round" — stable across the several
// CARDS one action can post (a multi-pass attack posts one per pass) and derived
// identically from a turn snapshot (DECLARE) and from an actionResult's attacker
// (CONFIRM). Used to carry two summon-autopilot decisions across cards: whether
// DECLARE auto-chose the action, and whether a human has already held it.
function summonTurnKey(director, snapLike) {
  const round = director?.dCombat?.round ?? 0;
  const who = snapLike?.tokenUuid ?? snapLike?.actorUuid ?? snapLike?.tokenId ?? "?";
  return `${round}:${who}`;
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
        // AI Autopilot — auto-pick WHO acts (initiative-ranked, with a "thinking"
        // pause) ONLY when the ENTIRE eligible side is AI-controlled (no
        // player-owned PCs among them). A mixed party side (PCs + guest ally)
        // keeps the manual picker so players still choose who acts; whoever is
        // picked, DECLARE decides per-combatant whether to auto-run it. Null
        // return → fall through to the normal single/multi picker paths.
        // The SUMMON autopilot widens this the same way for summons only: with
        // the enemy toggle off, an eligible pool made entirely of automatable
        // summons (the party's PCs have all acted, only the Numen is left) still
        // auto-picks instead of parking on the turn picker. A pool that still
        // holds an un-acted PC keeps the manual picker either way — turn ORDER
        // stays the player's call, which is the whole reason the party side
        // never auto-picks wholesale.
        // NOTE the two clauses are independent, not nested: a summon qualifies
        // because it is a SUMMON, never because of who owns its actor sheet.
        // The Numen's base actor (Crysta) is owned by the summoner's player, so
        // `isAiControlledCombatant` is FALSE for it — gating summons behind that
        // would exclude exactly the creatures this feature exists for.
        if (isAutopilotEnabled() || isSummonAutopilotEnabled()) {
          const autoDrivable = (c) => (isAutopilotEnabled() && isAiControlledCombatant(c))
            || isAutomatedSummon(c);   // party-side summons only — see summon-autopilot
          const aiPool = eligible.filter(autoDrivable);
          const wholeSideAi = aiPool.length > 0 && aiPool.length === eligible.length;
          if (wholeSideAi) {
            // Polish: hold the enemy automation until this round's opening
            // cinematic (round banner + initiative/ambush/advantage flash) has
            // finished, so the enemy doesn't "think" or declare on top of it.
            // The banner's completion is a director-tracked signal on ctx (set in
            // ROUND_START); consume it one-shot here so only the FIRST turn of the
            // round waits. A race-timeout guarantees a missed/never-resolving
            // banner promise can never wedge the turn.
            const bannerDone = director.ctx.initiativeBannerDone;
            if (bannerDone) {
              director.ctx.initiativeBannerDone = null;
              try { await Promise.race([bannerDone, new Promise((r) => setTimeout(r, 8000))]); }
              catch (_e) {}
            }
            try {
              const autoId = await autopilotPickCombatant(director, aiPool);
              if (autoId) {
                dc.currentCombatantId = autoId;
                log(`TURN_START: autopilot picked ${eligible.find((e) => e.id === autoId)?.name ?? autoId}`);
              }
            } catch (e) { warn("TURN_START: autopilot pick threw", e); }
          }
        }

        if (dc.currentCombatantId) {
          // Autopilot already resolved who acts — skip the pickers below.
        } else if (eligible.length === 1) {
          dc.currentCombatantId = eligible[0].id;
          log(`TURN_START: auto-picked ${eligible[0].name} (only eligible on ${dc.currentSide})`);
        } else {
          log(`TURN_START: ${eligible.length} eligible on ${dc.currentSide} — prompting picker`);

          // GM-local picker (always spawned — fallback for unowned
          // combatants AND so the GM can pick on behalf of an offline
          // player). Pills appear over ALL eligible.
          const localPromise = TurnPicker.show({ director, eligible });

          // Per-user broadcast: each non-primary recipient gets MENU_OPEN.
          // Players see pills only over their own PCs (owner-filter). Secondary
          // GMs see ALL eligible combatants — same as the local GM picker, so
          // they can pick on behalf of any combatant just like the primary GM.
          //
          // Recipients = active secondary GMs + ALL non-GM players (even
          // OFFLINE ones). We deliberately include offline players so the
          // turn-picker spec is cached + the remote await armed before they
          // connect: a player who logs in after their side's turn began gets
          // the picker replayed via PLAYER_HELLO and their pick lands on the
          // waiting await. Broadcasting to an offline socket is a harmless
          // no-op beyond the cache write. Offline GMs are excluded — they
          // need nothing replayed. The GM-local picker above stays as the
          // fallback so an absent player never stalls the turn.
          const channel = director.intentChannel;
          const nonPrimaryRecipients = (game.users?.contents ?? [])
            .filter((u) => u.id !== game.user?.id && (u.active || !u.isGM));
          const sceneUuid = director.dCombat?.scene?.uuid ?? null;
          const broadcastedUserIds = [];
          log(`TURN_START: ${nonPrimaryRecipients.length} non-primary recipient(s) (incl. offline players); channel=${channel ? "attached" : "MISSING"}`);
          if (channel) {
            // Pre-build the serialized form once for secondary GMs (full list).
            const allEligibleSerialized = eligible.map((dc2) => ({
              combatantId: dc2.id,
              name: dc2.name,
              side: dc2.side,
              tokenUuid: dc2.tokenUuid ?? null,
              tokenId: dc2.tokenId ?? null,
            }));
            for (const u of nonPrimaryRecipients) {
              let eligibleForUser;
              if (u.isGM) {
                // Secondary GM sees every eligible combatant.
                eligibleForUser = allEligibleSerialized;
              } else {
                // Player sees only the combatants they own.
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
                eligibleForUser = myEligible;
              }
              if (!eligibleForUser.length) {
                log(`TURN_START: no eligible for ${u.name} — skipping broadcast`);
                continue;
              }
              try {
                channel.broadcastMenuOpen({
                  targetUserId: u.id,
                  menuSpec: {
                    kind: "turn-picker",
                    combatId: director.combatId,
                    eligible: eligibleForUser,
                    sceneUuid,
                  },
                });
                broadcastedUserIds.push(u.id);
                log(`TURN_START: broadcast turn-picker to ${u.name} (${eligibleForUser.length} pills)`);
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
              try {
                channel?.broadcastMenuClose({
                  targetUserIds: broadcastedUserIds,
                  kind: "turn-picker",
                  reason: "local-won",
                });
              } catch {}
            } else {
              // Remote won — close GM's local picker.
              try { TurnPicker.despawn({ director }); } catch {}
              // Also close any OTHER player's mirror (only one combatant
              // is picked; everyone else's picker should go).
              try {
                channel?.broadcastMenuClose({
                  targetUserIds: broadcastedUserIds,
                  kind: "turn-picker",
                  reason: "remote-won",
                });
              } catch {}
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
        await SE().tickDirectorAEsForApplier(applierUuid);
      }
    } catch (e) { warn("TURN_START: AE tick threw", e); }

    // Bearer-turn-START tick: AEs the CURRENT combatant BEARS whose lifetimeMode
    // is "target_turn_start" decrement now — BEFORE the turn_start reaction
    // window (handed off to STANDALONE_REACTION_WINDOW below) — so a mark that
    // runs out this turn is gone before its own "transfer" prompt would show
    // (Searing Brand). Distinct from the applier tick above (keyed to who CAST it).
    try {
      const bearerUuid = snap?.actorUuid;
      if (bearerUuid) {
        await SE().tickDirectorAEsForBearerTurnStart(bearerUuid);
      }
    } catch (e) { warn("TURN_START: bearer-turn-start AE tick threw", e); }

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
    // Bimagus — a fresh turn starts the spell-MP tally at zero, so
    // MP_SPENT_THIS_TURN only ever reflects spells cast during THIS turn.
    if (director.dCombat && snap?.actorId) director.dCombat.resetSpellMpSpent(snap.actorId);
    // Champion Gloves / Hot Pants — the per-target landed-hit tally is also
    // turn-scoped, so HITS_ON_TARGET_THIS_TURN never carries across turns.
    if (director.dCombat && snap?.actorId) director.dCombat.resetHitsOnTargets(snap.actorId);
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
// for `actor`. Returns the userId of the first non-GM owner, or null if
// the actor has no non-GM owner. Deterministic on multi-owner actors
// (sort by userId).
//
// `requireActive` (default true) restricts to owners currently online —
// the right default for a pick that must be answered NOW (e.g. routing a
// secondary picker only makes sense to a connected client). Pass false
// when arming a menu/await that should survive the owner being offline at
// state-entry: the broadcast is cached (IntentChannel._recentBroadcasts)
// and the await is armed up-front, so a player who logs in mid-state gets
// the menu replayed via PLAYER_HELLO and their reply lands on the waiting
// await. Without this, a turn that begins while its owner is disconnected
// never broadcasts/arms anything for them, so they re-enter to no menu.
//
// "Owner" means OWNER-level Foundry permission (level 3) — same threshold
// Foundry uses for sheet-edit access. NPCs typically have no non-GM
// owner; PCs have exactly one.
function resolveActingOwnerForActor(actor, { requireActive = true } = {}) {
  if (!actor) return null;
  const candidates = (game.users?.contents ?? []).filter((u) => {
    if (u.isGM) return false;
    if (requireActive && !u.active) return false;
    try { return actor.testUserPermission?.(u, "OWNER"); }
    catch { return false; }
  });
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.id.localeCompare(b.id));
  return candidates[0].id;
}

// The `remotePrompt` handed to a chain ctx so its interactive rows open on the
// acting player's client (GM races a local copy — see remote-pick.js). Null
// when the actor has no online non-GM owner, or when WE are that owner, which
// is the "render locally" signal every routed picker falls back to.
function buildActingRemotePrompt(director, actor) {
  const ownerUserId = resolveActingOwnerForActor(actor);
  if (!ownerUserId) return null;
  if (ownerUserId === game.user?.id) return null;
  if (game.users?.get(ownerUserId)?.isGM) return null;
  if (!director?.intentChannel) return null;
  return { channel: director.intentChannel, targetUserId: ownerUserId, combatId: director.combatId };
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
  // Forced/engine autocast (free_action preset) flag: the staged action's obvious
  // (self/all) target set auto-resolves at TARGET without the locked Confirm. Set
  // every DECLARE so a normal composed action (no flag) resets it to false. See
  // resolveActionTargets' obvious-set branch + applyFreeActionEffect.
  director.ctx._skipActionTargetConfirm = !!winnerBundle?.skipTargetConfirm;

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
    // Consume the free-transform return-to-menu flag — we've arrived back at the
    // menu, so it must not leak into a later action's CLEANUP transition.
    director.ctx.returnToMenuAfterCleanup = false;

    const token = canvas?.tokens?.get(snap.tokenId);
    if (!token) {
      warn("DECLARE: token not on canvas", snap.tokenId);
      director.enqueue({ type: INTENTS.TIMEOUT });
      return;
    }

    // Resolve owner. fromUuid is async but cheap; on error, only GM runs.
    let actor = null;
    try { actor = await fromUuid(snap.actorUuid); } catch {}

    // Free-action grant integrity guard. A grant in the freeActions registry
    // carries an action's preset + bonuses, but a grant is only LEGITIMATE
    // while its owning FREE_ACTION_WINDOW frame is in flight — `topIsFreeAction`
    // is the authoritative "we are inside a free action" signal, and FAW
    // pushes that frame BEFORE routing here, so every real free-action DECLARE
    // sees it on top. The registry is persisted across reloads (see
    // persistence.js) and is only torn down by FAW's pop; any path that
    // bypasses that pop (reload routing, rewind, abort mid-free-action) can
    // leave a grant ORPHANED in the registry with no backing frame. Read on a
    // NORMAL turn's DECLARE, an orphaned grant would be staged as the actor's
    // real turn action — and with no free-action frame on the stack, RESOLVE's
    // gate (`!topIsFreeAction`) marks the turn consumed, eating the main action
    // (and, since the preset path never clears the grant, repeating every
    // turn). Grant-without-frame is therefore never valid: drop it so neither
    // the preset shortcut nor the compose-filter path below can consume it.
    // (Regression surfaced by Dreadwyrm Descent's conflict_start free_action;
    // the grant outlived its conflict_start window and hijacked Fafnir's turn.)
    if (!topIsFreeAction(director.ctx)) {
      const orphan = freeActions.get(snap.actorId);
      if (orphan) {
        warn(`DECLARE: orphaned free-action grant "${orphan.sourceLabel ?? "?"}" for ${snap.name} — no active free-action frame; clearing so it cannot consume the turn`);
        freeActions.clear(snap.actorId);
      }
    }

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

    // AI Autopilot — for an AI-controlled turn (any non-player combatant: enemy
    // OR GM-owned guest ally), decide the action + targets from the actor's
    // Action Pattern (ActionReader) and apply the resulting bundle exactly like a
    // player's composed action. The FSM then auto-runs TARGET → COMPUTE, posts
    // the action card, and BLOCKS at CONFIRM for a human: the autopilot never
    // confirms. A null return (no Action Pattern, nothing feasible, unsupported
    // command, or an action-gating debuff) falls through to the normal manual
    // composeAction below — the failsafe. See [[project_action_pattern_ai]].
    // The same decision path serves an automated SUMMON on its own switch — a
    // summon IS a non-player combatant, so `autopilotDecideAction` needs no
    // summon-specific branch; only the gate differs. A summon with a blank
    // Action Pattern still returns null here and falls through to the manual
    // menu, exactly like an unpatterned monster.
    // `snap` — not the director's current combatant — decides whether the SUMMON
    // gate applies: a free action is declared by the REACTOR on someone else's
    // turn, so asking "is the current combatant a summon?" would answer for the
    // wrong creature and hand a PLAYER's free action to the AI.
    if ((isAutopilotEnabled() && isAiControlledTurn(director)) || isAutomatedSummonTurn(director, snap)) {
      try {
        const autoBundle = await autopilotDecideAction(director, snap);
        if (autoBundle) {
          log(`DECLARE: autopilot → ${autoBundle.command} for ${snap.name}`);
          // Remember that the ACTION was machine-chosen. CONFIRM only auto-confirms
          // what DECLARE auto-declared: if the pattern was blank and a human had to
          // compose from the Octopath menu, that human is already at the keyboard
          // and their card must not confirm itself while they read the roll.
          director.ctx.autoDeclaredTurnKey = summonTurnKey(director, snap);
          applyComposedBundleAndAdvance(director, autoBundle);
          return;
        }
        log(`DECLARE: autopilot declined for ${snap.name} — manual compose fallback`);
      } catch (e) { warn("DECLARE: autopilot decide threw — manual compose fallback", e); }
    }

    // Resolve the owner IGNORING online status: we broadcast + arm the
    // ACTION_COMPOSED await for them up-front even if they're disconnected
    // right now. The compose-action spec is cached on the IntentChannel, so
    // a player who logs in AFTER their turn began (the classic "turn started
    // while I was away → I re-enter to no Action Menu" case) gets it replayed
    // via PLAYER_HELLO, and their composed bundle lands on the already-armed
    // await. The GM-local compose still runs in parallel as the fallback, so
    // an absent player never stalls the turn — whoever finishes first wins the
    // race below, and the loser is aborted. Prefer an ONLINE owner when one
    // exists (multi-owner actors), falling back to an offline owner so the
    // single-owner-currently-away case is still armed + cached.
    const ownerUserId = resolveActingOwnerForActor(actor)
      ?? resolveActingOwnerForActor(actor, { requireActive: false });

    // Pre-bake eligible target snapshots. We do this here (with full
    // dCombat access) so the player's client doesn't have to recompute —
    // they get the list via menuSpec. Used by both sides' composeAction.
    const eligibleEnemies = director.dCombat
      ? snapshotEligibleTargetsFromDCombat(director.dCombat, snap, { category: "enemy" })
      : snapshotEligibleTargets(director.combat, snap, { category: "enemy" });
    const eligibleAllies = director.dCombat
      ? snapshotEligibleTargetsFromDCombat(director.dCombat, snap, { category: "ally" })
      : snapshotEligibleTargets(director.combat, snap, { category: "ally" });
    // Study guard — the tokens THIS actor already Studied this fight. Plumbed
    // into the compose payload so composeStudy (player or GM) can grey them out
    // + label them in the Study target picker. GM-side memory, so it travels
    // with the broadcast (the player client has no DirectorCombat). RAW p.74.
    const studiedTokenUuids = director.dCombat?.studiedTokensFor?.(snap.actorId) ?? [];

    // GM-local compose chain. The cancel token lets us tear it down when
    // the player wins the race.
    const cancelToken = makeCancelToken();
    director.ctx._composeCancelToken = cancelToken;
    const localCompose = composeAction({
      director,
      snap,
      token,
      eligible: { enemies: eligibleEnemies, allies: eligibleAllies, studiedTokenUuids },
      cancelSentinel: cancelToken.promise,
      combatId: director.combatId,
      actorUuid: snap.actorUuid,
    }).catch((e) => {
      warn("DECLARE: local composeAction threw", e);
      return { cancelled: true, reason: "exception" };
    });

    // Remote compose participants: the acting actor's owner (if an active
    // non-GM user) + any secondary GMs (active GMs other than this client).
    // Each participant gets a MENU_OPEN broadcast and an awaitIntent entry
    // in the race pool. Whoever completes their compose chain first wins.
    //
    // Secondary GMs receive the full eligible list (same view as local GM);
    // players receive their personally owned subset per the existing logic.
    const freeActionGrant = freeActions.get(snap.actorId) ?? null;
    const secondaryGmIds = (game.users?.contents ?? [])
      .filter((u) => u.isGM && u.active && u.id !== game.user?.id)
      .map((u) => u.id);

    // remoteParticipants: [{ userId, awaitP }]
    const remoteParticipants = [];

    // The owner and every secondary GM receive the IDENTICAL spec (secondary
    // GMs are meant to see the full eligible list, same as the local GM), so
    // the compose payload — a combatant snapshot plus one target snapshot per
    // eligible token — ships ONCE for all of them instead of once per user.
    // Free-action grant — the registry is GM-side memory. Plumb the grant
    // fields into the menuSpec so the player's composeAction applies the
    // Octopath filter + budget label without needing the local freeActions
    // singleton populated.
    const composeMenuSpec = {
      kind: "compose-action",
      combatId: director.combatId,
      tokenUuid: token.document.uuid,
      actorUuid: snap.actorUuid,
      snap,
      eligible: { enemies: eligibleEnemies, allies: eligibleAllies, studiedTokenUuids },
      freeActionGrant,
    };
    const composeRecipients = [...(ownerUserId ? [ownerUserId] : []), ...secondaryGmIds];

    if (composeRecipients.length) {
      log(`DECLARE: broadcasting compose-action to ${composeRecipients.join(", ")} (${snap.name})`);
      try {
        director.intentChannel?.broadcastMenuOpen({
          targetUserIds: composeRecipients,
          menuSpec: composeMenuSpec,
        });
      } catch (e) {
        warn("DECLARE: compose-action broadcast threw, GM-local only", e);
      }
    }

    // Each participant still needs its OWN awaitIntent entry in the race pool —
    // whoever completes their compose chain first wins.
    for (const uid of composeRecipients) {
      try {
        const awaitP = director.intentChannel.awaitIntent(INTENTS.ACTION_COMPOSED, {
          fromUserId: uid,
          timeoutMs: 30 * 60 * 1000,
        });
        remoteParticipants.push({ userId: uid, awaitP });
        if (uid === ownerUserId) {
          director.ctx._activeRemoteMenu = { kind: "compose-action", targetUserId: ownerUserId };
        }
      } catch (e) {
        warn(`DECLARE: compose-action await setup threw for ${uid}`, e);
      }
    }

    // Mirror of [[reaction-architecture]] Rule 1 stage 2 for turn-action
    // composition: non-GM players who are NOT the action owner see a dimmed
    // "Hina taking action…" indicator. Secondary GMs are excluded — they
    // receive compose-action and run the TurnUI themselves (participants,
    // not spectators), so they must not also receive the spectator indicator.
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
      try {
        director.intentChannel.broadcastMenuOpen({
          targetUserIds: turnActionIndicatorRecipients,
          menuSpec: turnActionIndicatorSpec,
        });
      } catch (e) { warn("DECLARE: broadcastMenuOpen(turn-action-indicator) threw", e); }
    }
    function broadcastTurnActionIndicatorClose() {
      if (!director.intentChannel) return;
      try {
        director.intentChannel.broadcastMenuClose({
          targetUserIds: turnActionIndicatorRecipients,
          kind: "turn-action-indicator",
          reason: "compose-resolved",
          data: { tokenUuid: token.document.uuid, combatId: director.combatId },
        });
      } catch (e) { warn("DECLARE: broadcastMenuClose(turn-action-indicator) threw", e); }
    }
    broadcastTurnActionIndicatorOpen();
    director.ctx._closeTurnActionIndicator = broadcastTurnActionIndicatorClose;

    // N-way race: local GM compose vs all remote participants (player + secondary
    // GMs). Whoever resolves first wins; all others are aborted and get
    // MENU_CLOSE. If there are no remotes, the race array contains only the
    // local side and it dominates immediately on completion.
    let winnerSource = null;
    let winnerBundle = null;
    try {
      const result = await Promise.race([
        localCompose.then((r) => ({ source: "local", userId: game.user?.id, result: r })),
        ...remoteParticipants.map(({ userId, awaitP }) =>
          awaitP.then((intent) => ({
            source: "remote",
            userId,
            result: { cancelled: !intent?.body?.bundle, bundle: intent?.body?.bundle ?? null },
          }))
        ),
        // If no remotes exist this extra sentinel is never needed, but
        // Promise.race([single]) is fine — keeping for clarity.
      ]);
      winnerSource = result.source;
      const winnerUserId = result.userId;

      // Abort all losing remotes and close their UI.
      if (winnerSource === "local") {
        for (const { userId, awaitP } of remoteParticipants) {
          try { awaitP?.abort?.("local-won"); } catch {}
          try {
            director.intentChannel?.broadcastMenuClose({
              targetUserId: userId,
              kind: "compose-action",
              reason: "local-won",
            });
          } catch (e) { warn(`DECLARE: broadcastMenuClose (local-won) to ${userId} threw`, e); }
        }
        director.ctx._activeRemoteMenu = null;
      } else {
        // Remote won — cancel GM's local compose so its overlays close.
        cancelToken.cancel("remote-won");
        // Wait for local to actually unwind so its UI is gone before we
        // move to TARGET (avoids dangling Octopath).
        try { await localCompose; } catch {}
        // Close every OTHER remote participant that lost the race.
        for (const { userId, awaitP } of remoteParticipants) {
          if (userId === winnerUserId) continue;
          try { awaitP?.abort?.("lost-race"); } catch {}
          try {
            director.intentChannel?.broadcastMenuClose({
              targetUserId: userId,
              kind: "compose-action",
              reason: "lost-race",
            });
          } catch (e) { warn(`DECLARE: broadcastMenuClose (lost-race) to ${userId} threw`, e); }
        }
        director.ctx._activeRemoteMenu = null;
      }

      if (result.result.cancelled) {
        log(`DECLARE: compose cancelled (winner=${winnerSource} user=${winnerUserId})`);
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

    // Ultima-command backstop (Domination / Escape / Recovery) — boss-only and
    // point-gated. The menu already greys unaffordable blades, but the GM is
    // the source of truth: re-check against the LIVE actor (not the frozen
    // snap) so a stale/tampered pick can't spend what isn't there.
    if (ULTIMA_COMMANDS.includes(winnerBundle.command)) {
      const uActor = await fromUuid(snap.tokenUuid).then((t) => t?.actor ?? null).catch(() => null)
        ?? await fromUuid(snap.actorUuid).catch(() => null);
      const pay = canPayUltima(uActor);
      const refuse = (msg) => {
        warn(`DECLARE: Ultima command "${winnerBundle.command}" refused — ${msg}`);
        ui.notifications?.warn(`${winnerBundle.command}: ${msg}`);
        director.enqueue({ type: INTENTS.TIMEOUT });
      };
      if (!snap.isBoss) { refuse("only Bosses may use Ultima actions."); return; }
      if (!pay.ok) { refuse("no Ultima Point available."); return; }
      if (winnerBundle.command === "Domination") {
        if (hasIgnoreActionGating(uActor)) { refuse("already in Domination State."); return; }
        if (readDominancePoints(uActor) < 1) { refuse("no Dominance Point available."); return; }
      }
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
// opts.eligiblePostFilter — optional fn(pool) → pool for narrowing that is NOT a
//   property of the action — i.e. derived from THIS TURN's state, like Study's
//   already-studied exclusion. Narrowing the action DECLARES (target_eligibility,
//   weapon range, action_pool_focus) must NOT come through here: the survey reads
//   those itself so the AI's count sees them too. A closure passed in here is
//   invisible to every other consumer, which is how the count and the pick drifted.
// opts.attackWeapon      — the weapon snapshot, for the RAW range gate
//   (Covered can't be melee-targeted, Vanish likewise). Declarative replacement
//   for the range-gate closure Attack used to pass as eligiblePostFilter.
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
    attackRange                       = null,
    attackWeapon                      = null,
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

  // ── Survey: side, pool, mode + count ────────────────────────────────────
  // Everything between the target text and the picker now lives in
  // `target-survey.js`, and the autopilot asks it the SAME question before it
  // chooses an action. Computing it once is the whole point: the number the AI
  // decides on and the pool this picker offers can no longer be different
  // populations. (They were: an AI counting canvas tokens picked an all-enemy
  // skill against a scene of bystanders while the picker knew of one enemy.)
  //
  // Narrowing the ACTION declares — `target_eligibility`, the weapon range gate,
  // `action_pool_focus` — is read by the survey itself, so the AI sees it too.
  // Only narrowing derived from THIS TURN's state (Study's already-studied
  // exclusion) still arrives as a postFilter.
  //
  // NOTE: the text is passed AS AUTHORED. It used to be lower-cased here, which
  // zeroed every case-sensitive identifier in a count formula ("Up to (1 + 98 *
  // HAS_SKILL_PILLAGE) creatures" resolved to 1) while the player-side composer
  // passed it raw — the same skill offered different counts depending on who
  // resolved it. Every mode test is case-insensitive, so nothing wanted this.
  const text   = String(rawText ?? "").trim();
  const survey = surveyActionTargets({
    dCombat:         director.dCombat,
    combat:          director.combat,
    performer:       attackerSnap,
    performerActor:  attackerActor,
    action:          skill,
    weapon:          attackWeapon,
    skillTargetText: text,
    excludeSelf,
    postFilter:      eligiblePostFilter,
    round:           director.dCombat?.round ?? 0,
  });

  // A refusal is NOT an empty pool — it means the survey could not build one
  // (performer absent from the roster, no combat, a narrowing rule that threw).
  // The picker must not open over a pool that was never built, so bail the same
  // way an empty pool does, but say which it was.
  if (!survey.ok) {
    warn(`resolveActionTargets: survey could not answer (${survey.reason}) for ${attackerSnap?.name ?? "?"}`);
    ui.notifications?.warn(`Could not resolve targets for this action (${survey.reason}).`);
    return { ok: false, cancelled: false, reason: "no_eligible", targets: [], targetUuids: [] };
  }

  const isSelf            = survey.isSelf;
  const category          = survey.category;
  const eligibleForPicker = survey.eligible;
  const pickerMode        = survey.mode;
  const count             = survey.count;
  const randomizeCount    = survey.randomize;
  if (survey.capNote) ui.notifications?.info(survey.capNote);

  // ── Guard against empty pool ────────────────────────────────────────────
  if (!isSelf && !eligibleForPicker.length) {
    const categoryLabel = category === "any" ? "creatures" : `${category}s`;
    ui.notifications?.warn(`No eligible ${categoryLabel} on this scene.`);
    return { ok: false, cancelled: false, reason: "no_eligible", targets: [], targetUuids: [] };
  }

  director.ctx.eligibleTargets = eligibleForPicker;

  // ── Route to picker ────────────────────────────────────────────────────
  // Obvious target sets (self / all) no longer auto-resolve silently — they
  // surface a LOCKED Confirm (every eligible token pre-selected, selection can't
  // change; the actor only Confirms or Cancels) so nothing commits without an
  // acknowledgement. Matches the effect-table auto_target="confirm" default.
  // Random keeps its own roulette+Confirm pass; only genuine multi-target picks
  // keep the usingPreComposed shortcut.
  const isObviousTargetSet = pickerMode === "self" || pickerMode === "all";
  let result;
  // Pre-composed by the player — they ALREADY picked + acknowledged the target
  // on their own client during compose (e.g. the self-confirm a Self spell shows
  // in compose-action's resolveTargetsForSource). Trust that pick and DON'T
  // re-prompt, even for an "obvious" self/all set — otherwise a player casting a
  // Self spell sees the confirm twice. `random` is excluded: it pre-composes no
  // target (composedTargetUuids is empty) and is rolled GM-side by the roulette
  // path below. A GM-driven action with no pre-compose still falls through to the
  // locked Confirm, so a directly-run obvious target keeps its acknowledgement.
  if (pickerMode !== "random" && usingPreComposed
      && Array.isArray(composedTargetUuids) && composedTargetUuids.length) {
    result = { ok: true, cancelled: false, tokenUuids: [...composedTargetUuids] };
  } else if (isObviousTargetSet && director.ctx?._skipActionTargetConfirm) {
    // Forced/engine autocast (free_action preset, e.g. Explosive Entrance's
    // Unleash): auto-resolve the obvious (self/all) set silently — there is no
    // player to acknowledge a locked Confirm. The action-level twin of the
    // effect-level ctx._skipTargetConfirm (2ff6e919). The locked-confirm pre-
    // selects ALL eligibleForPicker anyway, so this yields the identical targets.
    result = { ok: true, cancelled: false, tokenUuids: eligibleForPicker.map((e) => e.tokenUuid).filter(Boolean) };
  } else if (isObviousTargetSet) {
    const lockedTitle = forcedTitle
      ?? `${attackerSnap.name}: confirm target${eligibleForPicker.length === 1 ? "" : "s"}`;
    result = await requestTargeting({
      director, eligible: eligibleForPicker,
      mode: "exact", count: eligibleForPicker.length,
      lockSelection: true,
      titleText: lockedTitle, cancelLabel, secondaryAction,
    });
  } else {
    const titleText = forcedTitle
      ?? (pickerMode === "random"
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
  // ── "Must include X" taunt (must_be_targeted_by) — authoritative + count-aware ──
  // Single GM-side choke point for EVERY performer path that reaches here:
  //   • player / GM manual pre-compose → the picker already pinned the taunter, so
  //     this is a no-op;
  //   • autopilot / any pre-composed bundle that bypassed the picker → the taunter
  //     is re-added here.
  // This is the INCLUSION case (distinct from "can only target"/Provoked, which
  // restricts the whole pool): we PIN the taunter WITHOUT dropping the other picks,
  // evicting one non-mandatory slot only when the target count is already full.
  if (!isSelf && pickerMode !== "random" && pickerMode !== "all") {
    const range = String(attackRange ?? skill?.system?.props?.skill_range ?? "any")
      .trim().toLowerCase() || "any";
    const mandatory = collectForcedIncludeTargets(eligibleForPicker, range, attackerActor)
      .map((e) => e.tokenUuid);
    for (const m of mandatory) {
      if (targetUuids.includes(m)) continue;
      if (targetUuids.length < count) { targetUuids.push(m); continue; }
      // Full — evict the first NON-mandatory pick to make room; if every slot is
      // already held by a mandatory target, allow a slight overflow rather than drop one.
      const evictIdx = targetUuids.findIndex((u) => !mandatory.includes(u));
      if (evictIdx >= 0) targetUuids[evictIdx] = m; else targetUuids.push(m);
    }
  }
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

    // ─── Ultima actions (Boss/Villain — Domination / Escape / Recovery) ──
    // Self-targeted, no roll, no pickers — the action card at CONFIRM is the
    // player-facing confirm pass. Costs (1 Ultima Point; +1 Dominance Point
    // for Domination) are stamped on the actionResult for the card's cost
    // chips and debited at RESOLVE. Rulebook p.101 (+ homebrew Domination).
    if (ULTIMA_COMMANDS.includes(command)) {
      const snapU = director.ctx.turnSnapshot;
      director.ctx.actionResult = freezeActionResult({
        kind: command,
        attacker: snapU,
        attackerActorRef: snapU.actorUuid,
        targets: [snapU],
        ultimaCost: 1,
        dominanceCost: command === "Domination" ? 1 : 0,
      });
      director.enqueue({
        type: INTENTS.TARGET_PICKED,
        body: { targetTokenUuids: [snapU.tokenUuid] },
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
      // Study guard: tokens this actor already Studied this fight are shown in
      // the picker but greyed-out + labeled "Already studied" (not hidden) —
      // same overlay path as Vanish / Provoked. RAW Core p.74.
      const studiedTokenUuids = director.dCombat?.studiedTokensFor?.(attackerSnap.actorId) ?? [];
      const studyTargeting = await resolveActionTargets(director, attackerSnap, {
        skillTargetText:    "One Enemy",
        usingPreComposed:   !!director.ctx.pickedTargetUuids?.length,
        composedTargetUuids: director.ctx.pickedTargetUuids,
        eligiblePostFilter: (pool) => applyStudyGuardExclusion(pool, studiedTokenUuids),
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
      // `target_eligibility` (e.g. Unicorn Dance: "BONDED_TO_SOURCE >= 1" → only
      // allies Bonded to you) used to be built here as a closure and handed in as
      // a post-filter. It is DECLARED ON THE SKILL, so the survey now reads it
      // itself — which is what makes it visible to the autopilot as well. Before,
      // the AI counted four allies, committed to the skill, and the picker then
      // filtered the pool to zero and aborted the turn.
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

      // 3a) Free-action MP cap — RAW-correct ("total MP cost ≤ N") enforcement.
      // The picker dims a spell by its MINIMUM (targetCount=1) cost, but a
      // per-target ("N×T MP") or variable ("up to N MP") spell can slip under the
      // cap at pick and then exceed it once the real targets are chosen. Re-check
      // here against the ACTUAL resolved MP — the same generic resolveCost output,
      // no per-skill logic. Gated on a live free-action grant carrying maxMpCost
      // (Acceleration); null on a normal turn, so this is a no-op there. Keyed by
      // snap.actorId exactly as compose-action reads the grant; spell-scoped to
      // mirror the pick-time cap (compose-action only sets maxMpCost for isSpell).
      if (isSpellAction) {
        const { freeActions } = await import("./free-actions.js");
        const grantCap = freeActions.get(attackerSnap.actorId)?.maxMpCost;
        if (grantCap != null && Number.isFinite(Number(grantCap))) {
          const mpSpend = Number(costMap.get("mp") ?? 0) || 0;
          if (mpSpend > Number(grantCap)) {
            ui.notifications?.warn(`${skill.name}: total MP cost ${mpSpend} exceeds this free action's ${grantCap} MP limit — choose fewer targets or a cheaper spell.`);
            director.dispatch({ type: INTENTS.TARGET_BACK });
            return;
          }
        }
      }

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
      // If the skill's own cost is blank because a `creature_performs_action`
      // self-reaction bills it (base Dance charges its "managed" dances via
      // bd_cost), estimate that reaction's cost from config so the card shows a
      // real number (10 / 5) instead of "Free", and so there IS a cost bullet for
      // the mutation pass to repaint. DISPLAY-ONLY — the reaction's adjust_cost
      // composes into costOverride and RESOLVE debits it there, so this must NOT
      // touch costMap / costSerialized (else the surcharge is counted twice).
      if (!displayCost) {
        try {
          const est = SE().estimatePerformReactionCost(attackerActor, skill);
          const parts = Object.entries(est)
            .filter(([, amt]) => Number(amt) > 0)
            .map(([res, amt]) => `${amt} ${res.toUpperCase()}`);
          if (parts.length) displayCost = parts.join(" · ");
        } catch (e) { warn("perform-reaction cost estimate threw", e); }
      }

      // Weapon-based skills ("perform a jab with your weapon"): any skill prop
      // set to the sentinel "WEAPON" inherits the value from whatever weapon the
      // Attack action reaches for FIRST — main hand → off hand → first exposed
      // virtual attack (e.g. Dual Shieldbearer's Twin Shields). So a Matador Pass
      // tracks whatever the wielder currently holds. Resolved once here; reused
      // for the accuracy pair, damage element, and range.
      const _skillProps = skill.system?.props ?? {};
      const _usesWeapon = (v) => String(v ?? "").toUpperCase() === "WEAPON";
      const _wantsWeapon = _usesWeapon(_skillProps.rolled_atr1)
        || _usesWeapon(_skillProps.type_damage)
        || _usesWeapon(_skillProps.skill_range);
      const primaryW = _wantsWeapon ? resolvePrimaryAttackWeapon(attackerActor) : null;
      if (_wantsWeapon && !primaryW) {
        warn(`Skill "${skill.name}": a "WEAPON" sentinel is set but ${attackerActor?.name ?? "caster"} has no attack weapon — using fallbacks.`);
      }

      // Accuracy pair — fall back to MIG/MIG (a weapon skill must never silently
      // roll the INS/INS default).
      let skillRolledA1 = String(_skillProps.rolled_atr1 ?? "").toUpperCase();
      let skillRolledA2 = String(_skillProps.rolled_atr2 ?? "").toUpperCase();
      if (skillRolledA1 === "WEAPON") {
        if (primaryW?.A1) {
          skillRolledA1 = primaryW.A1; skillRolledA2 = primaryW.A2;
          log(`Skill "${skill.name}": weapon-accuracy → ${primaryW.name} (${primaryW.A1}/${primaryW.A2})`);
        } else { skillRolledA1 = "MIG"; skillRolledA2 = "MIG"; }
      }
      // Damage element — fall back to Physical.
      let skillDamageType = String(_skillProps.type_damage ?? "");
      if (_usesWeapon(skillDamageType)) skillDamageType = primaryW?.damageType ?? "Physical";
      // Range (melee/ranged → feeds the Cover/Flying targeting gates) — fall back to Melee.
      let skillRangeVal = String(_skillProps.skill_range ?? "");
      if (_usesWeapon(skillRangeVal)) skillRangeVal = primaryW?.range ?? "Melee";

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
        rolledA1: skillRolledA1,
        rolledA2: skillRolledA2,
        checkBonus: Number(skill.system?.props?.check_bonus ?? 0) || 0,
        damageBonus: skill.system?.props?.damage_bonus ?? 0,
        damageType: skillDamageType,
        skillRange: skillRangeVal,
        // Equipped-weapon family/range/element of the wielder's primary attack
        // weapon (null on non-weapon skills) — exposed for downstream weapon-aware
        // gates/effects + the card. weaponType holds the Category (sword, dagger,
        // brawling, arcane, …); weaponRange/weaponElement mirror the resolved range/element.
        weaponType: primaryW?.weaponType ?? null,
        weaponRange: primaryW?.range ?? null,
        weaponElement: primaryW?.damageType ?? null,
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
          // Live actor for the range-lockout read (the snapshot carries no AEs).
          let liveActorForBlock = null;
          try { liveActorForBlock = attacker.actorUuid ? await fromUuid(attacker.actorUuid) : null; } catch (_) {}
          const picked = await pickWeaponMode({
            director,
            mainWeapon: attacker.weapon,
            offWeapon: attacker.offWeapon,
            allowTwoWeapon: !!attacker.canTwoWeaponFight,
            twoWeaponSolo: !!attacker.twoWeaponSolo,
            virtualAttacks,
            // Snared / Obscure — shown as disabled, red-tagged rows rather than
            // refusing the attack after the pick (mirrors composeAttack).
            rangeBlock: {
              melee: attackRangeBlockedBy(liveActorForBlock, "Melee"),
              ranged: attackRangeBlockedBy(liveActorForBlock, "Ranged"),
            },
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

    // For an NPC attack, thread the backing attack ITEM + the attacker ACTOR so
    // the unified resolver can (a) evaluate the skill_target count formula
    // (without them "Up to N" silently collapses to 1) and (b) read a
    // `target_sequence` declared on the item — e.g. Chomp's highest-Burn focus
    // pick. PC attacks have no single backing skill item (the weapon drives
    // targeting), so leave skill null there. Resolved once, before the call.
    let attackSkillItem = null;
    let attackActorDoc  = null;
    if (director.ctx.attackMode === "npc" && director.ctx.npcAttackItemUuid) {
      try { attackSkillItem = await fromUuid(director.ctx.npcAttackItemUuid); } catch {}
    }
    try { attackActorDoc = attacker?.actorUuid ? await fromUuid(attacker.actorUuid) : null; } catch {}

    // RAW Core p.70 — Covered creatures can't be melee-targeted (Vanish
    // likewise). The gate is declared by the WEAPON, so it is passed as the
    // weapon rather than as a closure: the survey applies it after building the
    // full category pool (still needed for random/creature modes), and the
    // autopilot's count sees the same exclusions the picker will.
    const attackTargeting = await resolveActionTargets(director, attacker, {
      skillTargetText:    weaponSkillTarget,
      attackerActor:      attackActorDoc,
      skill:              attackSkillItem,
      excludeSelf:        true,
      attackWeapon:       currentWeapon,
      usingPreComposed:   !isMultiPassReEntry,
      composedTargetUuids: director.ctx.pickedTargetUuids,
      attackRange:        currentWeapon?.range ?? null,
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
  const studierActorId = attacker?.actorId ?? null;
  const targetSnap = (director.ctx.eligibleTargets ?? []).find((e) => e.tokenUuid === targetUuid);

  // Study guard (RAW Core p.74 — "you can study the same aspect of a creature
  // only once"): a studier can't re-Study a token they already Studied this
  // fight. The interactive pickers grey these out + label them (see
  // applyStudyGuardExclusion); THIS is the backstop for the only path with no
  // picker — a target-LOCKED free Study (e.g. Painful Lesson, locked to the
  // creature that damaged you). The studied target is excluded from the picker
  // pool, so targetSnap may be null here; resolve a display name defensively.
  // Checked BEFORE the not-found guard so the player sees the real reason
  // (forfeited free Study) rather than a generic abort.
  if (director.dCombat?.hasStudied?.(studierActorId, targetUuid)) {
    let tName = targetSnap?.name;
    if (!tName) { try { tName = (await fromUuid(targetUuid))?.name; } catch { /* best-effort */ } }
    ui.notifications?.info(`${attacker?.name ?? "You"} already studied ${tName ?? "that creature"} this fight.`);
    if (studierActorId) freeActions.clear(studierActorId);
    director.enqueue({ type: INTENTS.ABORT });
    return;
  }

  if (!targetSnap) {
    warn("COMPUTE Study: target not found in eligibleTargets", targetUuid);
    director.enqueue({ type: INTENTS.ABORT });
    return;
  }

  // Free-action grant — Painful Lesson grants a free Study with a +SL bonus to
  // the Check (check_bonus_formula:"SL"). Consume the pending grant here, the
  // same way Hinder/Attack COMPUTE do. Without this, the +SL was evaluated,
  // queued onto the grant, and then silently dropped (computeStudy used to
  // hardcode checkBonus:0), so the bonus never reached the roll.
  const studyGrant = studierActorId ? freeActions.get(studierActorId) : null;
  let studyCheckBonus = studyGrant ? Number(studyGrant.checkBonus) || 0 : 0;
  const studyCheckBonusParts = [];
  if (studyGrant && studyCheckBonus !== 0) {
    studyCheckBonusParts.push({
      source: studyGrant.sourceLabel || "Free Action",
      amount: studyCheckBonus,
    });
  }
  if (studyGrant) {
    log(`Study COMPUTE: applied ${studyGrant.sourceLabel} grant (+${studyGrant.checkBonus ?? 0} check)`);
    freeActions.clear(studierActorId);
  }

  // Check config — read attrs FROM the Study Common item (authored data, like
  // Hinder). Open Check (default INS+INS); prop-aware crit/fumble.
  const studyProps = getCoreActionSkill("study")?.system?.props ?? {};
  const A1 = String(studyProps.rolled_atr1 ?? "INS").toUpperCase();
  const A2 = String(studyProps.rolled_atr2 ?? "INS").toUpperCase();
  const liveActor = await fromUuid(attacker.actorUuid).catch(() => null);

  // Equipped-gear passive Check buffs (generic action-scoped +N knob) — e.g. the
  // Encyclopedia grants "+2 to Study Checks" while equipped. Folded into the roll
  // AND surfaced on the card via checkBonusParts. Read-only; stacks per source.
  try {
    const studyBuffs = SE().sumEquippedCheckBuffs?.(liveActor, "study") ?? { total: 0, parts: [] };
    if (studyBuffs.total) {
      studyCheckBonus += studyBuffs.total;
      for (const p of studyBuffs.parts) studyCheckBonusParts.push(p);
      log(`Study COMPUTE: applied +${studyBuffs.total} from equipped check_buff (${studyBuffs.parts.map((p) => p.source).join(", ")})`);
    }
  } catch (e) { warn("Study COMPUTE: sumEquippedCheckBuffs threw", e); }

  const check = await rollCheck({ actor: liveActor, A1, A2, checkBonus: studyCheckBonus });
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
    // Study rolls a Check → mark it so `freezeActionResult` derives canMiss/
    // rollsAccuracy=true (its single-source capability axis). That lights up
    // ACTION_ROLLS_ACCURACY==1 for the CONFIRM reaction scans, so the same
    // check-adjusting reactions that fire on an attack roll (Lucky Seven self /
    // Divination observer, and future check_reroll/set_check_die skills) are
    // offered on the Study's open check too. Study carries no perTargetResults,
    // so the canMiss-gated per-target miss/VFX blocks stay dormant.
    isCheck: true,
    attacker,
    attackerActorRef: attacker.actorUuid,
    target: targetSnap,
    targets: [targetSnap],
    roll: {
      A1, A2,
      dA, dB, rA, rB, checkBonus: studyCheckBonus, checkBonusParts: studyCheckBonusParts, total, hr,
      isCrit, isFumble,
      opportunities: isCrit && !isFumble,
    },
    ...(studyGrant ? { freeActionGrant: { sourceLabel: studyGrant.sourceLabel, checkBonus: studyGrant.checkBonus ?? 0, damageBonus: 0 } } : {}),
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

    if (command === "Guard" || command === "Equipment" || ULTIMA_COMMANDS.includes(command)) {
      // Guard/Equipment/Ultima actionResult was already shaped in TARGET — all
      // are no-roll menu declarations. Pass through to CONFIRM where the card
      // collects the player's pick (cover target / equipment slots / the
      // Ultima confirm pass).
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
      let preActivateTargets = ar.preActivateTargets ?? null;
      const preRef = String(view?.fire_points?.pre_activate_effect_ref
        ?? skill?.system?.props?.pre_activate_effect_ref ?? "").trim();
      if (preRef && !ar.preActivateDone) {
        try {
          const casterActor = await fromUuid(attacker.actorUuid).catch(() => null);
          const capToken = canvas?.tokens?.get(attacker?.tokenId)?.document ?? null;
          const allUuids = (allTargets ?? []).map((t) => t.tokenUuid);
          // Route the pre_activate pickers (prompt_element / open_action_menu /
          // targeting) to the casting actor's owner so the PLAYER picks their
          // element/status/target — not the GM on their behalf. Without this the
          // capture menus render GM-local only (the player never sees them). When
          // the GM owns/casts the actor (no active non-GM owner) → null = local.
          // Mirrors the reaction/action-card remote-pick pattern (see remote-pick.js).
          const preRemotePrompt = buildActingRemotePrompt(director, casterActor);
          const capCtx = makeChainContext({
            reactorActor: casterActor, reactorToken: capToken, skill, dCombat: director.dCombat,
            payload: { targets: allUuids, hitTargets: allUuids, actionIntent: ar.actionIntent },
            actionTargetUuids: allUuids, hitActionTargetUuids: allUuids,
            isPassive: false, runtimeEffectTable: view.effect_table, firePoints: view.fire_points,
            harnessPicks: ar?._harnessPicks ?? null, harnessNumbers: ar?._harnessNumbers ?? null,
            remotePrompt: preRemotePrompt,
          });
          const pre = await SE().fireActivationEffectPre(skill, capCtx);
          if (pre?.abort) {
            // Two ways to land here, and they are NOT the same event:
            //  • "requirement-unmet" — a row declared `on_condition_fail: "abort"`
            //    and its condition_formula was false. The actor is not ALLOWED to
            //    take this action (Quaking Titan without martial armour). Nobody
            //    chose anything, so reporting a cancellation blamed the player for
            //    a refusal the rules made, and the caller — which may be the GM,
            //    the AI chooser or a free-action grant, none of which see the
            //    picker's availability greying — got the Action Menu back with no
            //    explanation at all.
            //  • anything else — the player cancelled a choice (element / status
            //    pick) and wants to re-pick.
            // Either way the card was never built, so nothing is spent.
            // (COMPUTE → DECLARE via TARGET_BACK.)
            if (pre?.reason === "requirement-unmet") {
              // availability_reason is authored for exactly this sentence; the
              // picker already uses it for the greyed-row tooltip.
              const why = String(skill?.system?.props?.availability_reason ?? "").trim()
                || `${skill?.name ?? "That action"} cannot be used right now`;
              log(`Skill COMPUTE: pre_activate REFUSED — requirement unmet (${why}); nothing spent`);
              try { ui.notifications?.warn(why); } catch (e) { /* headless / no UI */ }
            } else {
              log("Skill COMPUTE: pre_activate cancelled by player — back to Action Menu (nothing spent)");
            }
            director.enqueue({ type: INTENTS.TARGET_BACK });
            return;
          }
          preActivateVars = capCtx.payload?._chainVars ?? null;
          preActivateMenuPicks = capCtx.payload?._capturedMenuPicks ?? null;
          preActivateTargets = capCtx.payload?._capturedTargets ?? null;
        } catch (e) { warn("Skill COMPUTE: pre_activate capture threw", e); }
      }

      // The capture may have resolved the very values this skill's own
      // `adjust_cost` rows are written against (Bimagus: the spend picked at
      // pre_activate drives `VAR_BIMAGUS - 20`). Fold them in NOW so the card
      // prints the real price instead of the printed floor, and so RESOLVE §1
      // debits the whole thing in one go. The chain re-composes the same rows at
      // RESOLVE and dedups against these by (skill name, effect_label), so
      // nothing is billed twice; see precomposeChainCostAdjustments for why only
      // unconditional chain steps qualify.
      let preCostOverride = null;
      if (preActivateVars && Object.keys(preActivateVars).length) {
        try {
          const onActivateRef = String(view?.fire_points?.on_activate_effect_ref
            ?? skill?.system?.props?.on_activate_effect_ref ?? "").trim();
          if (onActivateRef) {
            const casterActorForCost = await fromUuid(attacker.actorUuid).catch(() => null);
            preCostOverride = await SE().precomposeChainCostAdjustments({
              skill, effectTable: view.effect_table, startLabel: onActivateRef,
              actor: casterActorForCost, chainVars: preActivateVars,
              round: director.dCombat?.round ?? 0,
              isFreeCast: !!freeActions.get(ar.attacker?.actorId)?.freeOfCost,
            });
          }
        } catch (e) { warn("Skill COMPUTE: pre-compose of chain adjust_cost threw", e); }
      }

      // Roll the Check dice here (the RNG); computeActionProfile derives total /
      // hr / crit / fumble + per-target outcomes from them. No roll = no Check.
      let dice = null;
      let arForProfile = ar;
      if (ar.isCheck) {
        // Roll via the shared check primitive (computeActionProfile re-derives
        // crit/fumble from these dice). Last of the BD's raw roll sites unified.
        // allowDieSwap lets a Psychokinesis-style check_die_swap replace one die
        // (e.g. → WLP) pre-roll; the swapped attrs flow into the profile + card.
        const liveActor = await fromUuid(attacker.actorUuid).catch(() => null);
        const c = await rollCheck({ actor: liveActor, A1: ar.rolledA1 || "INS", A2: ar.rolledA2 || "INS", allowDieSwap: true, director });
        dice = { rA: c.rA, rB: c.rB };
        if (c.dieSwap) arForProfile = { ...ar, rolledA1: c.A1, rolledA2: c.A2, dieSwap: c.dieSwap };
      }
      // Damage LIFT for menu-picked invocations: when the chosen option deals flat
      // damage (a deal_damage row), lift its element + scaled amount onto the primary
      // (damageType/damageBonus) so damage flows through the STANDARD perTargetResults
      // path — applied ONCE, with the full pre-resolve + caster + target reaction set.
      // The chain's deal_damage is then suppressed at RESOLVE (ctx.suppressDealDamage)
      // so it doesn't double-apply. Non-damage picks (heal/hex/MP-drain) are untouched
      // (chain-driven, hasDamage false).
      if (preActivateMenuPicks && Object.keys(preActivateMenuPicks).length) {
        const onAct = String(view?.fire_points?.on_activate_effect_ref ?? skill?.system?.props?.on_activate_effect_ref ?? "").trim();
        const picks = onAct ? preActivateMenuPicks[onAct] : null;
        if (onAct && Array.isArray(picks) && picks.length) {
          const chosen = resolveChosenChainRows(view.effect_table, onAct, picks);
          const dmgRow = chosen.find((r) => String(r.effect_kind ?? "").toLowerCase() === "deal_damage");
          if (dmgRow) {
            const casterActor = await fromUuid(attacker.actorUuid).catch(() => null);
            const casterLvl = Number(casterActor?.system?.props?.level ?? 0) || 0;
            const dmgResolver = buildSkillResolver({ actor: casterActor, payload: {}, skill, round: director.dCombat?.round ?? 0, vars: { CASTER_LEVEL: casterLvl } });
            const amt = Math.max(0, Math.floor(Number(evaluateFormula(String(dmgRow.damage_amount ?? "0"), dmgResolver, 0)) || 0));
            arForProfile = { ...arForProfile, damageType: String(dmgRow.damage_element ?? "elementless"), damageBonus: String(amt), _damageViaProfile: true };
          }
        }
      }
      const profile = await computeActionProfile({
        view, ar: arForProfile, attacker, targets: allTargets, dice,
        // chainVars lets the card preview resolve a VAR_<NAME> element (the
        // pre_activate element pick) to its real type instead of "varies".
        // menuPicks scopes the preview to the CHOSEN open_action_menu option (the
        // picks aren't on `ar` yet — written to the actionResult below), so the card
        // reflects the pick. DISPLAY-ONLY (never sets hasDamage / applies damage).
        ctx: { round: director.dCombat?.round ?? 0, chainVars: preActivateVars, menuPicks: preActivateMenuPicks },
      });
      const skillProj = projectProfileToActionResult(profile, arForProfile, allTargets);
      // Surface the check_die_swap note on the roll so the accuracy card shows it.
      if (arForProfile.dieSwap && skillProj.roll) skillProj.roll = { ...skillProj.roll, dieSwap: arForProfile.dieSwap };
      // Menu-picked skills: show the CHOSEN option's description on the card's Effect
      // section (which swaps status names → chips) so the card reflects the pick, not
      // the skill's generic blurb. Falls back to the skill description when no pick.
      let descriptionHtml = arForProfile.descriptionHtml;
      if (preActivateMenuPicks && Object.keys(preActivateMenuPicks).length) {
        const tbl = view?.effect_table ?? {};
        const byLabel = new Map(Object.values(tbl).filter((r) => r?.effect_label).map((r) => [r.effect_label, r]));
        // Interpolate ${…} scaling tokens (e.g. CHAR_LEVEL-based invocation damage/heal)
        // against the CASTER so the card's description shows the ACTUAL value (25, not 20).
        const casterActorForDesc = await fromUuid(attacker.actorUuid).catch(() => null);
        const interpCtx = { reactorActor: casterActorForDesc, payload: {}, skill, dCombat: director.dCombat };
        const interp = (s) => SE().interpolateMenuText(String(s ?? ""), interpCtx);
        const parts = [];
        for (const [menuLabel, picks] of Object.entries(preActivateMenuPicks)) {
          const menuRow = byLabel.get(menuLabel);
          if (!menuRow) continue;
          const optRefs = String(menuRow.menu_option_refs ?? "").split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
          const labelToOpt = new Map();
          for (const oref of optRefs) {
            const orow = byLabel.get(oref);
            if (orow) labelToOpt.set(String(orow.menu_label ?? orow.effect_label).trim().toLowerCase(), { label: orow.menu_label ?? oref, desc: orow.menu_description ?? "" });
          }
          for (const pk of (Array.isArray(picks) ? picks : [])) {
            const opt = labelToOpt.get(String(pk).trim().toLowerCase());
            if (opt) parts.push(`<p><strong>${interp(opt.label)}.</strong> ${interp(opt.desc)}</p>`);
          }
        }
        if (parts.length) descriptionHtml = parts.join("");
      }
      director.ctx.actionResult = freezeActionResult({
        ...arForProfile,
        ...skillProj,
        targets: allTargets,
        descriptionHtml,
        // Persist the captured pre_activate picks so RESOLVE replays them.
        preActivateVars, preActivateMenuPicks, preActivateTargets, preActivateDone: true,
        // Pre-composed own-chain cost (above). Merged, not assigned: an override
        // could already be present, and CONFIRM will merge its reaction channel
        // on top of this one.
        ...(preCostOverride
          ? { costOverride: mergeCostOverrides(arForProfile.costOverride ?? null, preCostOverride) }
          : {}),
        // Repaint the printed cost so the card shows what will actually be
        // debited. Skipped when Vismagus already rewrote the subtitle to name the
        // resource that got substituted ("20 HP · Vismagus") — that label is more
        // informative than a bare figure.
        ...(preCostOverride && !arForProfile.vismagusHpPaid
          ? { rawCost: formatCostMap(computeEffectiveCost(
              arForProfile.costSerialized,
              mergeCostOverrides(arForProfile.costOverride ?? null, preCostOverride))) }
          : {}),
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
        const c = await rollCheck({ actor: liveActor, A1: weapon.A1, A2: weapon.A2, allowDieSwap: true, director });
        // Psychokinesis check_die_swap: a swapped attribute rolls (and displays)
        // off the new die — override the weapon's accuracy attrs for the profile.
        const weaponEff = c.dieSwap ? { ...weapon, A1: c.A1, A2: c.A2 } : weapon;
        const profile = await computeActionProfile({
          view: { kind: "Attack", check_mode: "opposed", effect_table: {}, fire_points: {}, source: null },
          attacker, weapon: weaponEff, targets: targetSnapshots, dice: { rA: c.rA, rB: c.rB },
          ctx: { round: director.dCombat?.round ?? 0, attackMode: director.ctx.attackMode, grant: attackGrant },
        });
        const delta = projectProfileToActionResult(profile, null, targetSnapshots);
        director.ctx.actionResult = freezeActionResult({
          kind: "Attack",
          attacker,
          attackerActorRef: attacker.actorUuid,
          weapon,
          // Weapon-declared defense target ("mdef" for a magic-damage weapon like
          // Arc Wand; blank → DEF by default). Read by the card labels + redirect
          // recompute via resolvesVsMagicDefense; the per-target engine also reads
          // it straight off the weapon snapshot.
          defenseTargetType: weapon?.defenseTargetType ?? "",
          attackMode: director.ctx.attackMode ?? "main",
          passIndex: director.ctx.passIndex,
          totalPasses: director.ctx.totalPasses,
          targets: targetSnapshots,
          roll: c.dieSwap ? { ...delta.roll, dieSwap: c.dieSwap } : delta.roll,
          damage: delta.damage,
          perTargetResults: delta.perTargetResults,
          // The HIT-target token list — drives `hit_action_targets` reactions
          // (Warning Shot's Shaken/Slow, Vanish, …) at RESOLVE. The Skill COMPUTE
          // path keeps this by spreading the projection; the Attack path enumerates
          // fields, so set it explicitly. Without it, ar.hitTokenUuids is undefined
          // and a Barrage add_target splice (`[...(baseAr.hitTokenUuids ?? []),
          // ...added]`) collapses the hit list to ONLY the added target — the AE
          // then skips the primary. (Also stops a MISSED target getting hit-gated
          // AEs via the resolve-time all-targets fallback.)
          hitTokenUuids: delta.hitTokenUuids,
          ...(attackGrant ? { freeActionGrant: { sourceLabel: attackGrant.sourceLabel, checkBonus: attackGrant.checkBonus ?? 0, damageBonus: attackGrant.damageBonus ?? 0,
            // Rider metadata for on-hit effect refs (Ripples ends hexes) — needs to
            // survive to RESOLVE. elementOverride already baked into the profile at
            // COMPUTE; carried here only for card/debug parity.
            elementOverride: attackGrant.elementOverride ?? null,
            onHitEffectRefs: attackGrant.onHitEffectRefs ?? null,
            sourceItemUuid: attackGrant.sourceItemUuid ?? null } } : {}),
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

    // CARD REACTIONS — the pre-resolve surface. "During action card"
    // reactions that manipulate the ACTIVE action's values (Healing Power,
    // Support Magic, Cheap Shot, Protect, …). Each candidate gets a pill on
    // the action card so the player can opt in/out BEFORE Confirm. The
    // decisions are stashed in actionResult.acceptedCardReactions, and
    // RESOLVE applies them via firePreAcceptedCandidate. The post-resolve
    // dispatcher then skips anything already in evaluatedCardReactions
    // (no double-fire).
    //
    // The scans below are the CONFIRM-stage producers of this list (the live
    // array is also appended to mid-card by action-card's reactive re-derive —
    // see reaction-derive.js). Each scan owns its payload builder and its
    // iteration shape (action-level / per-target aggregate / per-target ×
    // per-combatant) — the payload IS that trigger's identifier vocabulary, so
    // it can't be parameterized into a generic dispatcher. See
    // [[project-card-reaction-scan-registry]].
    //
    // What IS shared is the funnel: every scan pushes through
    // `addCardReactions(trigger, cands)`, which
    //   1. asserts the trigger is declared "pre-resolve" in TRIGGER_PHASE —
    //      so director-triggers.js is enforced rather than decorative, and a
    //      new scan on an undeclared/mis-declared trigger warns loudly
    //      instead of diverging silently; and
    //   2. stamps `phaseTrigger` on each candidate, so a pill can be traced
    //      back to the scan that produced it.
    const cardReactions = [];
    const addCardReactions = (trigger, cands) => {
      if (phaseOf(trigger) !== "pre-resolve") {
        warn(`CONFIRM: card scan uses "${trigger}", which is not declared "pre-resolve" in TRIGGER_PHASE `
          + `(director-triggers.js). Its pills may be surfacing on the wrong UI — fix the phase map or the scan.`);
      }
      for (const cand of cands ?? []) {
        if (!cand) continue;
        cand.phaseTrigger = trigger;
        cardReactions.push(cand);
      }
    };

    // ── Shared ACTION-LEVEL payload base ────────────────────────────────
    // Every scan below spreads this FIRST, then states its own keys — so an
    // explicit key always wins and this can only FILL GAPS, never change a
    // value a scan already sets. That is what makes it safe to add here.
    //
    // Why it exists: the payload is the per-trigger identifier vocabulary, and
    // growing each scan's literal by hand meant a field added for one trigger
    // was simply absent under the others, where the gate then FAILS CLOSED
    // (reads 0 / never matches) with no error. Measured 2026-08-02:
    // `skillTags`/`skillDuration` existed only on Item+Performer, `isCrit`/
    // `isFumble` were missing from the damage window, `defenseResolved` existed
    // only on the third-party scan. Verified 0 authored rows relied on those
    // gaps, so filling them is behaviour-neutral for existing content and only
    // unblocks future authoring.
    //
    // ONLY genuinely action-level facts belong here. Anything whose meaning
    // shifts per scan — `sourceActorUuid` (attacker for performer-side scans,
    // the SUBJECT for target-side ones), subject/target ids, per-target damage,
    // costs, roll dice — must stay in the individual scans.
    let actingSkillTags = "";
    let actingSkillDuration = "";
    try {
      const actingSkill = ar.skillUuid ? await fromUuid(ar.skillUuid).catch(() => null) : null;
      actingSkillTags = String(actingSkill?.system?.props?.skill_tags ?? "");
      actingSkillDuration = String(actingSkill?.system?.props?.duration ?? "");
    } catch (_) { /* noop — tags/duration are optional gates */ }
    const actionBase = Object.freeze({
      actionKind: ar.kind ?? null,
      actionSkillType: String(ar.skillType ?? "").toLowerCase(),
      actionIsCheck: !!ar.isCheck,
      actionCanMiss: !!ar.canMiss,
      // Whether this action is a FREE cast — read by ACTION_IS_FREE_CAST.
      // Genuinely action-level (the whole action is free or it isn't), so it
      // belongs here rather than in one scan's literal. It USED to live only in
      // the damage-window scan, which is precisely the fails-closed gap this
      // block exists to close: Bimagus's follow-up gates on ACTION_IS_FREE_CAST
      // off `creature_completes_spell`, whose CONFIRM-time pre-evaluation ran
      // without the field, read 0, recorded the row as "conditions not met" —
      // and `skipEvaluated` then suppressed it at RESOLVE, so the post-resolve
      // payload that DOES carry the flag never got to re-evaluate it. Measured
      // in a live sim 2026-08-09: no second cast was ever granted.
      // NB: RESOLVE derives the same fact from `skipCost`, which additionally
      // requires `topIsFreeAction(director.ctx)` (a stale grant outside a
      // free-action frame must not count). CONFIRM keeps the unguarded read the
      // damage window has always used, so no existing gate shifts.
      actionIsFreeCast: !!freeActions.get(ar.attacker?.actorId)?.freeOfCost,
      actionName: ar.skillName ?? ar.weapon?.name ?? ar.kind,
      // No `?? kind` fallback: blank means "ambient" to the source-skill filter.
      sourceSkillName: ar.skillName ?? ar.weapon?.name ?? null,
      skillTags: actingSkillTags,
      skillDuration: actingSkillDuration,
      isCrit: !!ar.roll?.isCrit,
      isFumble: !!ar.roll?.isFumble,
      checkTotal: Number(ar.roll?.total ?? 0) || 0,
      weaponType: ar.weapon?.weaponType ?? null,
      weaponRange: ar.weapon?.range ?? ar.weapon?.weapon_range ?? null,
      damageType: ar.damageType ?? ar.damage?.element ?? null,
      skillUuid: ar.skillUuid ?? null,
      weaponUuid: ar.weapon?.uuid ?? null,
      actionIntent: ar.actionIntent,
      // Native resource cost of the in-flight action. ONE canonical spelling for
      // the whole family (`costHp`/`costMp`/`costIp`), read by ACTION_COST_HP /
      // _MP / _IP / _TOTAL. The damage scan used to stamp a rival `actionMpCost`
      // for the same number, which is how the identifier split into two names —
      // living here means neither can drift again.
      costHp: Number(ar.costSerialized?.hp ?? 0) || 0,
      costMp: Number(ar.costSerialized?.mp ?? 0) || 0,
      costIp: Number(ar.costSerialized?.ip ?? 0) || 0,
      // Which Defense the action's Check resolves against — null when it rolls
      // no Check. Same derivation the hit test and card labels use.
      defenseResolved: ar.canMiss
        ? (resolvesVsMagicDefense({
            defenseTargetType: ar.defenseTargetType,
            isSpell: String(ar.skillType ?? "").toLowerCase() === "spell",
          }) ? "mdef" : "def")
        : null,
    });

    // Spell-side dispatch — creature_completes_spell. Action-level (not
    // per-target). Healing Power + Support Magic chain off this.
    if (ar.kind === "Skill" && ar.skillType?.toLowerCase() === "spell" && attackerActor) {
      try {
        const { findPassiveCandidates } = await getSkillEffectsExtras();
        const spellCands = await findPassiveCandidates({
          casterActor: attackerActor,
          trigger: "creature_completes_spell",
          includeUnavailable: true,   // surface unaffordable reactions dimmed (cost only)
          payload: {
            ...actionBase,   // action-level defaults; every explicit key below overrides
            spellUuid: ar.skillUuid ?? null,
            spellName: ar.skillName ?? null,
            targetTokenUuids: (ar.targets ?? []).map((t) => t.tokenUuid),
            hitTargetTokenUuids: Array.isArray(ar.hitTokenUuids) ? ar.hitTokenUuids : (ar.targets ?? []).map((t) => t.tokenUuid),
            sourceTokenUuid: ar.attacker?.tokenUuid ?? null,
            sourceActorUuid: ar.attackerActorRef,
            actionIntent: ar.actionIntent,
            // Mirror the post-resolve payload so a gate like ACTION_ROLLS_ACCURACY
            // (Advantage's "offensive spell only" self-consume) evaluates the
            // same way whether the row fires pre- or post-resolve.
            actionCanMiss: !!ar.canMiss,
            // Acting skill name — `reaction_source_skill` FAILS CLOSED without it
            // (passesMatchFilters rejects the row when the filter is set and this
            // is blank), so a self-scoping row authored on this trigger could
            // never fire. Was stamped only on the damage/performer/observer
            // payloads until 2026-08-02.
            sourceSkillName: ar.skillName ?? ar.weapon?.name ?? null,
          },
        });
        addCardReactions("creature_completes_spell", spellCands);
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
        // The crafted/used item-skill's tags (e.g. "potion") so a reaction can gate
        // on SKILL_HAS_TAG_<X> — Maid Cap's craft discount. ar.skillUuid is the
        // activation skill for both create and use.
        let usedSkillTags = "";
        let usedSkillDuration = "";
        try {
          const usedSkill = ar.skillUuid ? await fromUuid(ar.skillUuid).catch(() => null) : null;
          usedSkillTags = String(usedSkill?.system?.props?.skill_tags ?? "");
          usedSkillDuration = String(usedSkill?.system?.props?.duration ?? "");
        } catch (_) { /* noop */ }
        const itemCands = await findPassiveCandidates({
          casterActor: attackerActor,
          trigger: "creature_uses_item",
          includeUnavailable: true,   // surface unaffordable reactions dimmed (cost only)
          payload: {
            ...actionBase,   // action-level defaults; every explicit key below overrides
            targetTokenUuids: (ar.targets ?? []).map((t) => t.tokenUuid),
            targets: (ar.targets ?? []).map((t) => t.tokenUuid),
            sourceTokenUuid: ar.attacker?.tokenUuid ?? null,
            sourceActorUuid: ar.attackerActorRef,
            actionIntent: ar.actionIntent,
            actionKind: ar.kind,
            actionName: ar.skillName ?? ar.kind,
            itemMode: ar.itemSelection?.mode ?? null,
            skillUuid: ar.skillUuid ?? null,
            skillTags: usedSkillTags,
            skillDuration: usedSkillDuration,
            // See the spell scan: without this, `reaction_source_skill` can
            // never match on this trigger.
            sourceSkillName: ar.skillName ?? ar.weapon?.name ?? null,
          },
        });
        addCardReactions("creature_uses_item", itemCands);
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
    // Damage-dealing Spells fire this too (kind "Spell"): an offensive spell with
    // an on-hit damage rider (Adversity, future Infusion-likes) was previously
    // excluded, so NO spell could carry one. Resource-scoping (HP vs MP) is left to
    // the row's condition_formula via DAMAGE_IS_HP, not this gate.
    const fireWillDealDamage =
      attackerActor &&
      Array.isArray(ar.perTargetResults) &&
      (ar.kind === "Attack" || ((ar.kind === "Skill" || ar.kind === "Spell") && ar.hasDamage));
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
          // (see acceptedCardReactions gate in resolveAction).
          const matchedTarget = (ar.targets ?? []).find((t) => t?.actorUuid === subjectActorUuid);
          const subjectTokenUuid = entry.tokenUuid ?? matchedTarget?.tokenUuid ?? null;

          const payloadForTrigger = {
            ...actionBase,   // action-level defaults; every explicit key below overrides
            subjectActorUuid,
            subjectTokenUuid,
            // The performing action's kind ("Attack" | "Skill"), so a
            // will_deal_damage reaction can scope itself via reaction_action_kind
            // (Tinkerer Infusions: "Attack" only — RAW "hit with an attack").
            actionKind: ar.kind ?? null,
            // Spell-type identity (mirrors the creature_performs_action payload) so
            // ACTION_IS_SPELL / ACTION_IS_OFFENSIVE_SPELL gates resolve at the damage
            // window too — Cataclysm's "when you cast a damaging spell" overcharge,
            // and any future spell-scoped damage rider. Absent before → those gates
            // read 0 here, so a spell-gated damage reaction could never surface.
            actionSkillType: String(ar.skillType ?? "").toLowerCase(),
            actionIsCheck: !!ar.isCheck,
            // `actionIsFreeCast` (Cataclysm's overcharge excludes free casts)
            // now comes from `actionBase` — same expression, one place, so every
            // CONFIRM-time scan sees it. The MP cost itself comes from
            // `actionBase.costMp` (ACTION_COST_MP); the old rival `actionMpCost`
            // field was retired 2026-08-02 — see skill-formulas' note.
            targets: allTargetUuids,
            hitTargets: hitTargetUuids,
            rawDamage: entry.rawDamage,
            hr: ar.roll?.hr ?? 0,
            damageType: ar.damageType ?? ar.damage?.element ?? null,
            // Resource of the pending damage (hp | mp | shield) so a rider can
            // scope via DAMAGE_IS_HP / DAMAGE_IS_MP. Per-target resource wins;
            // falls back to the action-level value, then "hp".
            valueType: String(entry.resource ?? ar.valueType ?? ar.damage?.resource ?? "hp").toLowerCase(),
            weaponType: ar.weapon?.weaponType ?? null,
            weaponRange: ar.weapon?.range ?? ar.weapon?.weapon_range ?? null,
            affinity: entry.affinity,
            // HIT_MARGIN at the PRE-damage window, same computation as the
            // post-damage `creature_deals_damage` payload. Without it, "Conquer
            // N" could only ever apply a STATUS: the margin arrived after the
            // damage was already dealt, so a Conquer-gated DAMAGE rider had
            // nothing to gate on and every such item was filed as blocked
            // (Minotaurus Axe: "Conquer 5 — deals 10% of your Max HP as bonus
            // damage"). The accuracy total and this target's defense are both
            // known here; only the plumbing was missing.
            hitMargin: (Number(ar.roll?.total ?? 0) || 0) - (Number(entry.defense ?? 0) || 0),
            // Same rationale for the check total — ATTACK_CHECK_RESULT ("Snipe N")
            // reads `checkTotal`, which was stamped on the post-damage payload
            // only, so a Snipe-gated damage rider read 0 here.
            checkTotal: Number(ar.roll?.total ?? 0) || 0,
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
              includeUnavailable: true,   // surface unaffordable reactions dimmed (cost only)
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
        for (const cand of byKey.values()) delete cand._payloadFromHit;
        addCardReactions("creature_will_deal_damage", byKey.values());
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
        // The acting skill's free-form `skill_tags` so a performer-side reaction
        // can gate on SKILL_HAS_TAG_<X> (Quick-change: "after you perform a dance"
        // → SKILL_HAS_TAG_DANCE). Mirrors the creature_uses_item skillTags forward.
        // Also forward the acting skill's `duration` so ACTION_DURATION can rank how
        // long the action's effect lasts (Follow my lead shares a dance's benefit
        // only when ACTION_DURATION >= 1, i.e. non-instant dances).
        let performSkillTags = "";
        let performSkillDuration = "";
        try {
          const actingSkill = ar.skillUuid ? await fromUuid(ar.skillUuid).catch(() => null) : null;
          performSkillTags = String(actingSkill?.system?.props?.skill_tags ?? "");
          performSkillDuration = String(actingSkill?.system?.props?.duration ?? "");
        } catch (_) { /* noop */ }
        const performPayload = {
          ...actionBase,   // action-level defaults; every explicit key below overrides
            sourceActorUuid: ar.attackerActorRef,
            subjectActorUuid: ar.attackerActorRef,
            sourceTokenUuid: ar.attacker?.tokenUuid ?? null,
            targets: allTargetUuids,
            targetTokenUuids: allTargetUuids,
            actionIntent: ar.actionIntent ?? "harmful",
            actionKind: ar.kind ?? "Attack",
            // The casting item's real skill_type ("Spell"/"Skill"/…). actionKind
            // can't distinguish spell-vs-skill (both stamp ar.kind "Skill"), so
            // ACTION_IS_SPELL reads this for the precise gate (Hypercognition).
            actionSkillType: String(ar.skillType ?? "").toLowerCase(),
            // Native resource cost of this action (ar.costSerialized, set at CONFIRM).
            // A performer-side cost reaction gates on ACTION_COST_TOTAL / _HP/_MP/_IP
            // (Fugitive Experiment: "suffer 1d8 Instability to ignore a ≤100 cost").
            // Zero for free actions — so the gate stays dormant.
            costHp: Number(ar.costSerialized?.hp ?? 0) || 0,
            costMp: Number(ar.costSerialized?.mp ?? 0) || 0,
            costIp: Number(ar.costSerialized?.ip ?? 0) || 0,
            // Acting skill's tags (SKILL_HAS_TAG_<X> reads payload.skillTags).
            skillTags: performSkillTags,
            // Acting skill's duration string (ACTION_DURATION ranks it: 0 instant,
            // 1 until-next-turn, 2 scene+). Follow my lead gates share on >= 1.
            skillDuration: performSkillDuration,
            // Did this action roll a Check (accuracy/magic check)? An "offensive
            // spell" in FU is precisely a Spell with a Check (⚡ icon); buff/heal
            // spells are isCheck:false. ACTION_IS_OFFENSIVE_SPELL gates on this
            // (Magical Artillery: bonus only on offensive spells).
            actionIsCheck: !!ar.isCheck,
            // Does this action ROLL ACCURACY (an attack OR a check)? The canonical
            // single-source capability flag (see [[reference-action-canmiss-capability-flag]]
            // — never re-derive kind==="Attack"||isCheck). ACTION_ROLLS_ACCURACY gates on
            // this (Adversity: accuracy bonus only on actions that roll a check — attacks
            // + offensive spells + opposed/Hinder checks, NOT Heal/buff/utility).
            actionCanMiss: !!ar.canMiss,
            // Roll result — crit/fumble gate for performer-side reactions (e.g.
            // Divination on the actor's OWN Check: RAW can't reroll a crit/fumble,
            // so its condition reads ATTACK_IS_CRIT/FUMBLE). Post-roll at CONFIRM.
            isCrit: !!ar.roll?.isCrit,
            isFumble: !!ar.roll?.isFumble,
            // Live roll faces + attribute names — so a self-reaction's
            // open_action_menu can label each die with its current value
            // (Lucky Seven die picker: "First die (DEX): 3 → 7"). Faces read by
            // CHECK_DIE_A/CHECK_DIE_B; attribute names travel as the menu string
            // vars ${CHECK_DIE_A_ATTR}/${CHECK_DIE_B_ATTR} (formulas are numeric).
            rollDieA: Number(ar.roll?.rA ?? 0) || 0,
            rollDieB: Number(ar.roll?.rB ?? 0) || 0,
            rollDieAAttr: String(ar.roll?.A1 ?? ""),
            rollDieBAttr: String(ar.roll?.A2 ?? ""),
            // Flat check modifier (CHECK_BONUS) so a menu can show the resulting
            // total after a die swap: kept die + new die + bonus (Lucky Seven).
            rollCheckBonus: Number(ar.roll?.checkBonus ?? 0) || 0,
            actionName: ar.weapon?.name ?? ar.skillName ?? ar.kind ?? "Action",
            // Acting skill/weapon name for `reaction_source_skill` self-scoping.
            sourceSkillName: ar.skillName ?? ar.weapon?.name ?? null,
            weaponUuid: ar.weapon?.uuid ?? null,
            skillUuid: ar.skillUuid ?? null,
            // ATTACK_IS_RANGED gate reads this.
            weaponRange: ar.weapon?.range ?? ar.weapon?.weapon_range ?? null,
        };
        const cands = await findPassiveCandidates({
          casterActor: attackerActor,
          trigger: "creature_performs_action",
          includeUnavailable: true,   // surface unaffordable reactions dimmed (cost only)
          payload: performPayload,
        }) ?? [];
        for (const cand of cands) {
          if (cand.kind === "passive" && cand.mode === "off") continue;
          // Capture-time payload → used at RESOLVE (round-trips apply-click rolls via
          // _chainVars) AND at the card-mutation phase (adjust_cost reads ACTION_COST_*
          // off it). Mirrors the creature_targeted_by_action scan's payloadAtFire.
          cand.payloadAtFire = performPayload;
          if (cand.usesAddTarget) {
            // add_target makes sense on an Attack (Barrage) OR a single-target
            // HEALING item (Potion Rain — spread a created potion to allies).
            // Skip every other kind so the tag doesn't leak onto spells/etc.
            const isAttack = ar.kind === "Attack";
            const isHealSpread = ar.kind === "Item" && !!ar.hasHealing
              && (ar.targets?.length ?? 0) === 1;
            // Buff-spread (Follow my lead): a beneficial, non-damaging,
            // non-healing action with no accuracy roll (a self-buff "dance")
            // may share its benefit with an added ally. Pairs with the
            // buff-spread branch in onAddTargetApply.
            const isBuffSpread = !ar.roll && !ar.hasDamage && !ar.hasHealing;
            if (!isAttack && !isHealSpread && !isBuffSpread) continue;
            // Two-weapon attacks (Double Arrow's double shot, classic TWF) lose
            // the multi property and CANNOT gain it (RAW Two-Weapon Fighting).
            // Block EVERY add_target reaction on a two-weapon pass — generic, so
            // Barrage and any future multi-granting skill are covered as data.
            const twMode = String(ar.attackMode ?? director.ctx?.attackMode ?? "").toLowerCase();
            if (twMode.startsWith("two-weapon")) continue;
            cand._addTarget = true;
          }
          addCardReactions("creature_performs_action", [cand]);
        }
      } catch (e) {
        warn("CONFIRM: creature_performs_action dispatch threw", e);
      }
    }

    // Observer scan — creature_performs_action by ANY creature. A reaction whose
    // REACTOR is a BYSTANDER: neither the performer (the performer-side scan above
    // handles the actor's OWN action) nor a target (creature_targeted_by_action
    // below). RAW Divination is the canonical user — "after a creature you can see
    // performs a Check, you may force that creature to reroll". `reaction_source`
    // does the filtering exactly as it does target-side: `all` (Divination) fires
    // for every performer; `ally`/`enemy` scope by the performer's disposition vs
    // the reactor; `self` can NEVER match here (subject = performer ≠ reactor) so
    // self-riders (Magical Artillery / Adversity / Cognitive Focus) are not
    // re-surfaced and never double-fire. The performer is excluded from the walk,
    // so the actor's own `all` reaction fires once (performer-side) — not twice.
    // Gated to accuracy-rolling actions (ar.canMiss) so it only offers on Checks /
    // attacks. The matched candidate carries reactorActorUuid = the bystander; the
    // card-mutation phase reads it (check_reroll rerolls the action-taker's dice,
    // charge consumed from the reactor). Rows with no effect ref are skipped — a
    // reaction that can't do anything must never surface a pill (e.g. Prophetic
    // Defender's vestigial creature_performs_action/enemy row).
    const fireObserverPerforms = attackerActor && (ar.passIndex ?? 1) <= 1 && !!ar.canMiss;
    if (fireObserverPerforms) {
      try {
        const { findPassiveCandidates } = await getSkillEffectsExtras();
        const combatants = Array.isArray(director?.dCombat?.combatants)
          ? director.dCombat.combatants : [];
        const attackerActorUuid = attackerActor.uuid;
        const allTargetUuids = (ar.targets ?? []).map((t) => t.tokenUuid);
        const observerPayload = {
          ...actionBase,   // action-level defaults; every explicit key below overrides
          // Subject = the performer. reaction_source (all/ally/enemy) keys off this;
          // check_reroll rerolls the action-taker, who IS the subject here.
          sourceActorUuid: attackerActorUuid,
          subjectActorUuid: attackerActorUuid,
          sourceTokenUuid: ar.attacker?.tokenUuid ?? null,
          targets: allTargetUuids,
          targetTokenUuids: allTargetUuids,
          actionIntent: ar.actionIntent ?? "harmful",
          actionKind: ar.kind ?? "Attack",
          actionSkillType: String(ar.skillType ?? "").toLowerCase(),
          actionIsCheck: !!ar.isCheck,
          actionCanMiss: !!ar.canMiss,
          actionName: ar.weapon?.name ?? ar.skillName ?? ar.kind ?? "Action",
          sourceSkillName: ar.skillName ?? ar.weapon?.name ?? null,
          // Roll result so the reaction can gate on crit/fumble (RAW Divination
          // cannot reroll a Critical or a Fumble — the condition_formula reads these).
          checkTotal: Number(ar.roll?.total ?? 0) || 0,
          isCrit: !!ar.roll?.isCrit,
          isFumble: !!ar.roll?.isFumble,
          weaponRange: ar.weapon?.range ?? ar.weapon?.weapon_range ?? null,
          skillUuid: ar.skillUuid ?? null,
          weaponUuid: ar.weapon?.uuid ?? null,
        };
        const seenObs = new Set();
        for (const c of combatants) {
          if (c?.defeated) continue;
          const reactor = c?.actorDoc ?? null;
          if (!reactor) continue;
          if (reactor.uuid === attackerActorUuid) continue;   // performer handled by the performer-side scan
          let cands;
          try {
            cands = await findPassiveCandidates({
              casterActor: reactor,
              trigger: "creature_performs_action",
              payload: observerPayload,
              includeUnavailable: true,   // surface unaffordable reactions dimmed (cost only)
            });
          } catch (e) {
            warn(`CONFIRM: observer creature_performs_action findPassiveCandidates threw for ${reactor.name}`, e);
            continue;
          }
          for (const cand of cands ?? []) {
            if (cand.kind === "passive" && cand.mode === "off") continue;
            // DEFAULT = self: a row with no explicit source is a self-rider, NOT a
            // bystander reaction, so it must not surface here. Only an explicit
            // all/ally/enemy opts into observing others. (Explicit `self` never
            // reaches this loop — the matcher drops it since subject ≠ reactor.)
            if (!cand.reactionSource) continue;
            if (!cand.ref) continue;            // no effect ref → can't do anything; never surface
            if (cand.usesAddTarget) continue;   // add_target belongs to the performer-side path
            const dedup = `${cand.rowKey}::${cand.carrierUuid}::${reactor.uuid}`;
            if (seenObs.has(dedup)) continue;
            seenObs.add(dedup);
            log(`CONFIRM: observer reaction matched — reactor=${reactor.name} skill=${cand.carrierName} (performer=${ar.attacker?.name ?? attackerActorUuid})`);
            addCardReactions("creature_performs_action", [{
              ...cand,
              reactorActorUuid: reactor.uuid,
              reactorActorName: reactor.name,
              reactorActorImg:  reactor.img ?? cand.carrierImg,
              reactorIsPlayer:  !!reactor.hasPlayerOwner,
              subjectActorUuid: attackerActorUuid,
              subjectTokenUuid: ar.attacker?.tokenUuid ?? null,
              payloadAtFire:    observerPayload,
            }]);
          }
        }
      } catch (e) {
        warn("CONFIRM: observer creature_performs_action dispatch threw", e);
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
    // One contract check per card, not per (target × reactor).
    let _targetedPayloadContractChecked = false;
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
          // Predicted damage THIS subject is about to take from the action —
          // the subject's own perTargetResults slot (matched by token, then
          // actor). Threaded so a DEFENDER incoming-damage reaction can gate on
          // INCOMING_DAMAGE > 0: a beneficial/non-damaging action that merely
          // targets the reactor (Cleanse, Heal, buffs) or a miss predicts 0, so
          // e.g. Ninja Log ("when you take damage") stays dormant instead of
          // firing on every targeting and burning its once-per-conflict charge.
          const subjectPt = (ar.perTargetResults ?? []).find(
            (p) => (subjectTokenUuid && p?.tokenUuid === subjectTokenUuid)
              || p?.actorUuid === subjectActorUuid,
          );
          const incomingDamage = subjectPt?.hit
            ? Math.max(0, Number(subjectPt.damage ?? 0) || 0)
            : 0;
          const payloadForTrigger = {
            ...actionBase,   // action-level defaults; every explicit key below overrides
            sourceActorUuid: subjectActorUuid,
            subjectActorUuid,
            subjectTokenUuid,
            incomingDamage,
            targetTokenUuids: (ar.targets ?? []).map((t) => t.tokenUuid),
            attackerActorUuid,
            attackerTokenUuid: ar.attacker?.tokenUuid ?? null,
            actionIntent: effectiveIntent,
            actionKind: ar.kind,
            actionName: ar.skillName ?? ar.weapon?.name ?? ar.kind,
            // The INCOMING action's skill/weapon name, so a defender-side row can
            // scope itself with `reaction_source_skill` ("when targeted by <X>").
            // That filter FAILS CLOSED without this field, so such a row could
            // never fire on this trigger before 2026-08-02. Note `actionName`
            // above falls back to ar.kind — this one must NOT, since a blank
            // means "ambient, fire on any action" to the matcher.
            sourceSkillName: ar.skillName ?? ar.weapon?.name ?? null,
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
            // Which Defense this action's accuracy Check resolves against —
            // "def" (strike) | "mdef" (magic) | null (no Check / auto-hit).
            // SAME resolution the hit test + card labels use
            // (resolvesVsMagicDefense: explicit per-item defense_target_type
            // wins, else Spell → MDEF), gated on `ar.canMiss` so a no-Check
            // action reads null. Read by ATTACK_VS_DEF / ATTACK_VS_MDEF so a
            // Defense-specific reaction fires only on attacks it can mitigate
            // — Verónica's +2 DEF gates on ATTACK_VS_DEF == 1 (skips offensive
            // spells + mdef-tagged weapon Attacks its DEF wouldn't touch).
            defenseResolved: ar.canMiss
              ? (resolvesVsMagicDefense({
                  defenseTargetType: ar.defenseTargetType,
                  isSpell: String(ar.skillType ?? "").toLowerCase() === "spell",
                }) ? "mdef" : "def")
              : null,
          };

          // Contract check against the OTHER builder of this same payload
          // (reaction-derive.buildTargetedPayload, used for mid-card new
          // targets). The two drifted silently once — the derive side lacked
          // `incomingDamage` + `defenseResolved`, so INCOMING_DAMAGE and
          // ATTACK_VS_DEF/_MDEF read 0 for any creature dragged in by a redirect
          // and their reactions stayed dormant. Missing payload keys FAIL CLOSED,
          // so nothing errors — hence this explicit warn. Runs once per card.
          if (!_targetedPayloadContractChecked) {
            _targetedPayloadContractChecked = true;
            try {
              const { TARGETED_PAYLOAD_KEYS } = await import("./reaction-derive.js");
              const missing = (TARGETED_PAYLOAD_KEYS ?? []).filter((k) => !(k in payloadForTrigger));
              if (missing.length) {
                warn(`CONFIRM: creature_targeted_by_action payload is missing contract key(s) [${missing.join(", ")}] `
                  + `— reaction-derive.TARGETED_PAYLOAD_KEYS and this scan have drifted; gates on those keys fail closed.`);
              }
            } catch (e) { /* contract check is advisory — never break the card */ }
          }

          for (const reactor of reactorActors.values()) {
            let cands;
            try {
              cands = await findPassiveCandidates({
                casterActor: reactor,
                trigger: "creature_targeted_by_action",
                payload: payloadForTrigger,
                includeUnavailable: true,   // surface unaffordable reactions dimmed (cost only)
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
              addCardReactions("creature_targeted_by_action", [{
                ...cand,
                reactorActorUuid: reactor.uuid,
                reactorActorName: reactor.name,
                reactorActorImg:  reactor.img ?? cand.carrierImg,
                reactorIsPlayer:  !!reactor.hasPlayerOwner,
                subjectActorUuid,
                subjectTokenUuid,
                payloadAtFire: payloadForTrigger,
              }]);
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
                  includeUnavailable: true,   // surface unaffordable reactions dimmed (cost only)
                });
                for (const cand of ownedCands ?? []) {
                  const dedup = `${cand.rowKey}::${cand.carrierUuid}::${subjectActorUuid}`;
                  if (seenKeys.has(dedup)) continue;
                  seenKeys.add(dedup);
                  log(`CONFIRM: target-owned reaction matched — target=${target?.name ?? subjectActorUuid} skill=${cand.carrierName}`);
                  addCardReactions("creature_targeted_by_action", [{
                    ...cand,
                    reactorActorUuid: subjectActorUuid,
                    reactorActorName: target?.name ?? targetActorDoc.name,
                    reactorActorImg:  targetActorDoc.img ?? cand.carrierImg,
                    reactorIsPlayer:  !!targetActorDoc.hasPlayerOwner,
                    subjectActorUuid,
                    subjectTokenUuid,
                    payloadAtFire: payloadForTrigger,
                  }]);
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
          includeUnavailable: true,   // surface unaffordable reactions dimmed (cost only)
          payload: {
            ...actionBase,   // action-level defaults; every explicit key below overrides
            sourceActorUuid:      guarderUuid,
            sourceTokenUuid:      ar.attacker?.tokenUuid ?? null,
            guarderActorUuid:     guarderUuid,
            guarderTokenUuid:     ar.attacker?.tokenUuid ?? null,
            didCoverAlly:         !!cov,
            coveredAllyUuid:      cov?.actorUuid ?? null,
            coveredAllyTokenUuid: cov?.tokenUuid ?? null,
            targets:              coveredTokenUuids,
            targetTokenUuids:     coveredTokenUuids,
            // Guard has no skill of its own, so this is normally null — but the
            // key must EXIST for consistency with the other scans, and a weapon
            // -sourced Guard variant would populate it. `reaction_source_skill`
            // fails closed when the field is absent.
            sourceSkillName:      ar.skillName ?? ar.weapon?.name ?? null,
          },
        });
        addCardReactions("creature_guards", guardCands);
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
      const forceAdds = (cardReactions ?? []).filter(
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

    // Summon auto-confirm — the one place the summon autopilot goes FURTHER than
    // the enemy one, which stops dead at this card. When the acting creature is
    // an automated summon, hand the card a veto window: it renders normally,
    // shows a countdown, and confirms itself when the countdown expires. Any
    // interaction (click, key, reaction decision) cancels it permanently and the
    // card reverts to a plain manual card. Resolved from the DirectorCombatant
    // when we have one (it carries the live tokenDoc), else from the attacker
    // token itself — a mid-chain spawn may not be in the roster yet.
    let autoConfirm = null;
    try {
      if (isSummonAutopilotEnabled()) {
        const actingDc = director.dCombat?.combatants
          ?.find?.((c) => c.tokenUuid === ar.attacker?.tokenUuid) ?? null;
        const turnKey = summonTurnKey(director, ar.attacker);
        // Three conditions, all required:
        //   • the actor is a party-side summon,
        //   • DECLARE chose the action (a hand-composed card is a human's card),
        //   • nobody has already held THIS turn. A hold has to outlive the card
        //     it was made on: a multi-pass action posts one card per pass, and a
        //     reload re-enters CONFIRM with a fresh one. Without the turn key,
        //     "held" silently expired between passes.
        const held = director.ctx.summonVetoHeldTurn && director.ctx.summonVetoHeldTurn === turnKey;
        const autoDeclared = director.ctx.autoDeclaredTurnKey === turnKey;
        if (actingDc && isAutomatedSummon(actingDc) && autoDeclared && !held) {
          autoConfirm = { ms: summonVetoMs(), reason: "summon-autopilot", turnKey };
          log(`CONFIRM: summon autopilot armed for ${ar.attacker?.name ?? "?"} — auto-confirm in ${Math.round(autoConfirm.ms / 1000)}s unless vetoed`);
        } else if (actingDc && isAutomatedSummon(actingDc)) {
          log(`CONFIRM: summon ${ar.attacker?.name ?? "?"} card stays manual (${held ? "held earlier this turn" : "action was composed by hand"})`);
        }
      }
    } catch (e) { warn("CONFIRM: summon auto-confirm arm threw — card stays manual", e); }

    const result = await postActionCard({
      director,
      kind: ar.kind,
      payload: {
        // Shared render-field set — single source with the test harness (see
        // composeActionCardRenderPayload). CONFIRM overrides the fields it
        // owns/derives below (invoke-stamped attacker, post-splice targets +
        // perTargetResults, live cardReactions, the onAddTargetApply callback).
        ...composeActionCardRenderPayload(ar),
        // Non-null only for an automated summon's own card (see above). After
        // the spread so a stale render-payload key can never win.
        autoConfirm,
        attacker: { ...ar.attacker, invokeCapability, invokePointCount },
        attackerActor,
        targets: cardTargets,
        perTargetResults: cardPerTargets,
        cardReactions,
        // GM-side callback the Barrage (creature_performs_action) pill's "Apply"
        // runs on the POST-ROLL card. Fires the reaction's add_target chain
        // (JRPG picker + MP cost), then projects the picked target(s) against
        // THIS action's already-rolled accuracy dice so they share the same
        // total ("shared roll, post-roll pick"). Splices the new target rows
        // into the live actionResult (RESOLVE applies damage from
        // perTargetResults) and returns them so the card appends rows.
        // Cancel / empty pick / unaffordable → { ok:false } leaves the pill
        // actionable (nothing is spent at Apply — the purchase is billed with
        // the action's own cost at RESOLVE).
        onAddTargetApply: async (cand, remotePrompt = null) => {
          try {
            // Affordability gate for the extra-target purchase. The surcharge is an
            // `adjust_cost` row folded into THIS action's cost (debited once at
            // RESOLVE), so there's no in-chain consume_resource left to abort on an
            // empty pool — check base + surcharge against the caster's pools here,
            // before the picker opens. Same composer the commit uses.
            //
            // Run TWICE for a per-target surcharge (Linked Invocation: 10 MP each,
            // up to SL): once before the picker (`addedCount` null → the row's
            // ADDED_TARGET_COUNT reads 1, i.e. "can you afford one increment?"),
            // and again once the picks are in with the real count stamped on the
            // candidate. Without the second pass a player could buy 3 extra
            // targets holding MP for one and only discover it at RESOLVE. A flat
            // surcharge (Barrage) prices identically both times, so this is a
            // no-op there.
            const gateAddTargetCost = async (addedCount) => {
              const arNow = director.ctx.actionResult ?? ar;
              if (addedCount != null) {
                cand.payloadAtFire = { ...(cand.payloadAtFire ?? {}), _addedTargetCount: addedCount };
              }
              const { composeCostOverride } = await import("./card-mutations.js?cb=" + Date.now());
              const surcharge = await composeCostOverride(arNow, [cand]).catch((e) => {
                warn("CONFIRM onAddTargetApply: surcharge compose threw", e); return null;
              });
              if (!surcharge) return true;
              const effective = computeEffectiveCost(arNow.costSerialized, surcharge);
              const gate = checkAffordable(attackerActor, new Map(Object.entries(effective)));
              if (gate.ok) return true;
              const missing = gate.missing.map((m) => `${m.need} ${m.label} (have ${m.has})`).join(", ");
              ui.notifications?.warn(`${cand?.carrierName ?? "Reaction"}: not enough ${missing}.`);
              log(`CONFIRM onAddTargetApply: unaffordable (${missing}) at ${addedCount ?? 1} extra target(s) — pill stays pending`);
              return false;
            };
            if (!await gateAddTargetCost(null)) return { ok: false };
            // ── No-roll spread (Potion Rain, Linked Invocation) ─────────────
            // An action with NO accuracy roll whose amounts come from the skill's
            // own effect rows: fire the reaction chain (add_target picks ≤ the
            // row's count; adjust_grant/adjust_cost declare any scaling), then
            // REBUILD every row for the full set via the SAME computeActionProfile
            // the card used (single source) — so every target (original + extras)
            // shows the right amount. Returns replaceRows so the card re-renders
            // all rows rather than appending. Cancel / no pick → nothing applied.
            //
            // There is no roll to project here, which is exactly why this can't
            // fall through to the attack branch below (it hard-requires ar.roll +
            // a weapon and would silently return not-ok). Covers a damaging
            // no-check Skill too — Invocation's Aero Blast has hasDamage with no
            // roll, so Linked Invocation's extra target lands through this path.
            // The item+healing clause is kept verbatim so an item that somehow
            // carries a roll keeps its old branch.
            const baseArH = director.ctx.actionResult ?? ar;
            const isHealSpread =
              (String(baseArH.kind ?? "").toLowerCase() === "item" && !!baseArH.hasHealing)
              || (!baseArH.roll && (!!baseArH.hasHealing || !!baseArH.hasDamage));
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
                // Derived, not hard-coded: this branch now also serves damaging
                // no-check Skills, whose reaction rows gate on action kind/intent
                // (Linked Invocation asks for SKILL_HAS_TAG_INVOCATION on a Skill).
                actionIntent: baseArH.hasDamage ? "harmful" : "beneficial",
                actionKind: baseArH.kind ?? "Item",
                actionName: baseArH.skillName ?? "Item", _preRoll: sinkH,
                // Forward the acting skill's tags so a chain row's own
                // condition_formula can still read SKILL_HAS_TAG_<X> here — the
                // reaction gate saw them at derive time, this probe payload is
                // rebuilt from scratch and would otherwise lose them.
                skillTags: hSkill.system?.props?.skill_tags ?? "",
              };
              const { firePreAcceptedCandidate } = await getSkillEffectsExtras();
              let resH = null;
              try { resH = await firePreAcceptedCandidate({ director, casterActor: attackerActor, candidate: cand, payload: probeH, remotePrompt }); }
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
              // Re-price now that the pick count is known (per-target surcharge).
              // Nothing has been debited yet, so bailing here costs the player
              // nothing but the re-pick.
              if (!await gateAddTargetCost(newSnapsH.length)) return { ok: false };
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

            // ── Buff-spread variant (Follow my lead) ────────────────────────
            // A beneficial, non-damaging / non-healing action (a self-buff
            // "dance") whose add_target reaction shares the buff with a picked
            // ally. Unlike the attack/heal branches there is no accuracy roll
            // and no amount to project — just splice the picked target(s) into
            // the roster so the performed skill's RESOLVE-time apply_ae
            // (target_ref action_targets) applies its AE to them too. Cost is
            // charged inside the chain (cost-last), so cancel / unaffordable →
            // nothing spent, pill stays live.
            const baseArB = director.ctx.actionResult ?? ar;
            const isBuffSpread = !baseArB.roll && !baseArB.hasDamage && !baseArB.hasHealing;
            if (isBuffSpread) {
              const bAttacker = director.ctx.turnSnapshot;
              if (!bAttacker) {
                warn("CONFIRM onAddTargetApply(buff): missing attacker — pill stays pending");
                return { ok: false };
              }
              const existingB = new Set((baseArB.targets ?? []).map((t) => t.tokenUuid));
              const sinkB = { addedTokenUuids: [] };
              const probeB = {
                sourceActorUuid: bAttacker.actorUuid, subjectActorUuid: bAttacker.actorUuid,
                sourceTokenUuid: bAttacker.tokenUuid ?? null,
                targets: [...existingB], targetTokenUuids: [...existingB],
                actionIntent: "beneficial", actionKind: "Skill",
                actionName: baseArB.skillName ?? "Skill", _preRoll: sinkB,
              };
              const { firePreAcceptedCandidate } = await getSkillEffectsExtras();
              let resB = null;
              try { resB = await firePreAcceptedCandidate({ director, casterActor: attackerActor, candidate: cand, payload: probeB, remotePrompt }); }
              catch (e) { warn("CONFIRM onAddTargetApply(buff): chain threw", e); return { ok: false }; }
              if (!resB?.ok) {
                log(`CONFIRM onAddTargetApply(buff): chain ${resB?.cancelled ? "cancelled" : "returned not-ok"} — pill stays pending`);
                return { ok: false, cancelled: !!resB?.cancelled };
              }
              // Resolve the picked target(s) into snapshots from an any-side pool
              // (the reaction's own targeting row scopes who's eligible).
              const eligibleB = director.dCombat
                ? snapshotEligibleTargetsFromDCombat(director.dCombat, bAttacker, { category: "any" })
                : snapshotEligibleTargets(director.combat, bAttacker, { category: "any" });
              const newSnapsB = [];
              for (const u of sinkB.addedTokenUuids) {
                if (existingB.has(u)) continue;
                const snap = eligibleB.find((e) => e.tokenUuid === u);
                if (snap && !newSnapsB.includes(snap)) newSnapsB.push(snap);
              }
              if (!newSnapsB.length) {
                log(`CONFIRM onAddTargetApply(buff): no new targets resolved from picks [${sinkB.addedTokenUuids.join(", ")}] — pill stays pending`);
                return { ok: false, cancelled: true };
              }
              if (!await gateAddTargetCost(newSnapsB.length)) return { ok: false };
              // Minimal auto-hit rows (no accuracy / no amount) so the card
              // appends target rows; RESOLVE applies the AE off ar.targets.
              const addedRowsB = newSnapsB.map((s) => ({
                name: s.name, tokenUuid: s.tokenUuid, actorUuid: s.actorUuid,
                tokenImg: s.tokenImg, disposition: s.disposition,
                defense: 0, hit: true, crit: false, affinity: "NE", studied: true,
              }));
              director.ctx.actionResult = freezeActionResult({
                ...baseArB,
                targets: [...(baseArB.targets ?? []), ...newSnapsB],
                perTargetResults: [...(baseArB.perTargetResults ?? []), ...addedRowsB],
                hitTokenUuids: [...(baseArB.hitTokenUuids ?? []), ...newSnapsB.map((s) => s.tokenUuid)],
              });
              log(`CONFIRM onAddTargetApply(buff): spread +${newSnapsB.length} target(s) for ${baseArB.skillName ?? "buff"}`);
              return { ok: true, addedRows: addedRowsB };
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
            try { res = await firePreAcceptedCandidate({ director, casterActor: attackerActor, candidate: cand, payload: probePayload, remotePrompt }); }
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
            if (!await gateAddTargetCost(newSnaps.length)) return { ok: false };

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
        // (kind-specific render fields — Guard/Study/Hinder/Item/Skill — now
        // come from composeActionCardRenderPayload spread at the top.)
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
    // Equipment card also collects per-hand weapon FORM picks (Transform) as
    // { main, off } → formIndex. Merge so RESOLVE's equip_swap effect can apply
    // them via applyWeaponFormSelections (rides the same Equipment action).
    if (result.weaponFormSelections) {
      director.ctx.actionResult = freezeActionResult({
        ...director.ctx.actionResult,
        weaponFormSelections: result.weaponFormSelections,
      });
    }
    // Compute the Equipment action's turn-economy NOW (at confirmation), per the
    // Transform design: a transform-only action whose changed weapons each still
    // have their per-round free transform is FREE — it returns to the action menu
    // without spending the turn (see the CLEANUP → DECLARE branch keyed on
    // ctx.returnToMenuAfterCleanup, set in RESOLVE from ar.equipmentFree). A gear
    // swap or an already-used free transform makes it cost the turn. Stamps
    // `equipmentFree` + the weapon ids that consume their free allowance.
    if (result.equipmentSelections || result.weaponFormSelections) {
      try {
        const ar2 = director.ctx.actionResult;
        const econActor = ar2?.attacker?.actorUuid
          ? await fromUuid(ar2.attacker.actorUuid).catch(() => null)
          : null;
        if (econActor) {
          const { planEquipmentActionCost } = await import("./equipment-swap.js");
          const plan = planEquipmentActionCost(econActor, {
            equipmentSelections: ar2.equipmentSelections ?? null,
            weaponFormSelections: ar2.weaponFormSelections ?? null,
          }, director.dCombat?.round ?? 0);
          director.ctx.actionResult = freezeActionResult({
            ...ar2,
            equipmentFree: plan.free,
            transformFreeUsedItemIds: plan.freeUsedItemIds,
          });
          log(`CONFIRM equipment economy: ${plan.free ? "FREE (return to menu)" : "costs action"}` +
              `${plan.freeUsedItemIds.length ? ` — free transform on ${plan.freeUsedItemIds.length} weapon(s)` : ""}`);
        }
      } catch (e) { warn("CONFIRM: equipment economy plan failed", e); }
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
      const acceptedDecisions = result.reactionDecisions.filter((d) => d?.decision === "apply");
      const candFor = (d) => (cardReactions ?? []).find(
        (p) => p.rowKey === d.rowKey && p.carrierUuid === d.carrierUuid);
      // Carry the scan's `phaseTrigger` from the CANDIDATE onto the DECISION.
      // `acceptedCardReactions` stores decision objects (rowKey/carrierUuid +
      // verdict), which are NOT the candidate objects addCardReactions stamped —
      // so without this hop the stamp never reaches the actionResult and a pill
      // can't be traced back to the scan that produced it. Caught by a live sim
      // 2026-08-02: every accepted reaction read `phaseTrigger: undefined`.
      // Mutates in place (rather than cloning) so downstream identity
      // comparisons on the decision objects are unaffected.
      for (const d of result.reactionDecisions) {
        try {
          const c = d ? candFor(d) : null;
          if (c?.phaseTrigger && !d.phaseTrigger) d.phaseTrigger = c.phaseTrigger;
        } catch (_) { /* tracing metadata is never worth breaking a decision */ }
      }
      // Barrage (_addTarget) splices its extra target at Apply-click, not at
      // RESOLVE. Exclude it from the full mutation pass so RESOLVE's re-fire
      // (firePreAcceptedCandidate) doesn't re-prompt the picker or re-splice —
      // its damage is already in perTargetResults.
      const applied = acceptedDecisions.filter((d) => !candFor(d)?._addTarget);

      // ── Encyclopedia witness: card-mutation passives ────────────────────
      // These never reach firePreAcceptedCandidate — an adjust_damage /
      // adjust_accuracy / redirect row is applied by applyAcceptedCardMutations
      // and computeSenderDamageBonuses straight off `acceptedCardReactions`. The
      // player still SEES them (the card prints the bonus), so they must reveal
      // like any other ability.
      //
      // The reactor is whoever OWNS the carrier: `reactorActorUuid` for a
      // third-party reaction (a PC's Protect redirecting a monster's attack —
      // which must NOT write to the monster's page), falling back to the
      // action-taker for a performer-side passive (a monster's own damage
      // rider), which is the case this closes. witnessNpcAbility drops
      // everything non-hostile / uncatalogued, so the fallback is safe.
      for (const d of applied) {
        const cand = candFor(d);
        if (!cand) continue;
        const reactorRef = cand.reactorTokenUuid
          ?? cand.reactorActorUuid
          ?? ar.attacker?.tokenUuid
          ?? null;
        if (!reactorRef) continue;
        witnessFiredCandidate({ candidate: cand, reactorTokenUuid: reactorRef })
          .catch((e) => warn("CONFIRM: card-reaction witness threw", e));
      }
      // …but its extra-target SURCHARGE still has to compose into this action's
      // cost. The purchase is part of what the action costs (an `adjust_cost` row
      // in the reaction's chain), debited once with everything else at RESOLVE —
      // not a side debit at Apply-click. Pass those candidates through a cost-only
      // channel: their adjust_cost rows fold into costOverride, nothing else in
      // their chain runs again.
      const costOnly = acceptedDecisions.filter((d) => candFor(d)?._addTarget);
      const evaluated = result.reactionDecisions.map((d) => ({
        carrierUuid: d.carrierUuid,
        rowKey: d.rowKey,
      }));

      // SINGLE target-set mutation entrypoint: redirect/accuracy/add_target
      // rewrite the slots, will_deal_damage subjects re-resolve vs the mutated
      // set, then ALL per-target rows re-derive through buildPerTarget with the
      // accepted reactions folded in (accuracy override re-applied). Shared with
      // the action-card preview recompute so the two CANNOT drift.
      let mutatedTargets = liveAr.targets ?? null;
      let recomputedPerTargets = liveAr.perTargetResults ?? null;
      // The hit list must track a target-set mutation too: a redirect (Protect)
      // swaps which creature is in a slot, and on-hit rider AEs resolve their
      // victims via `hit_action_targets` → ar.hitTokenUuids. Without persisting
      // the recomputed list, HP damage follows the redirect (driven by
      // perTargetResults) but the rider AE (e.g. Flame Breath's Burn) still
      // lands on the ORIGINAL target. Default to the live list; override below
      // only when the recompute produced a fresh one.
      let recomputedHitTokenUuids = liveAr.hitTokenUuids ?? null;
      // A roll-changing mutation (check_reroll) must commit its NEW roll + headline
      // damage too — otherwise RESOLVE / crit / opportunities and the post-commit
      // card read the stale dice while the per-target rows carry the rerolled value.
      let recomputedRoll = liveAr.roll ?? null;
      let recomputedHeadlineDamage = null;
      let accuracyOverride = null;
      let costOverride = null;
      let negated = false;
      try {
        const { applyTargetSetMutation, buildCheckAdjustedEvents } = await import("./card-mutations.js?cb=" + Date.now());
        const r = await applyTargetSetMutation({
          ar: liveAr, accepted: applied, costOnlyAccepted: costOnly,
          attackerActor, round: director.dCombat?.round ?? 0,
        });
        negated = !!r.negated;
        if (!r.cancelled) {
          mutatedTargets = r.targets ?? mutatedTargets;
          recomputedPerTargets = r.perTargetResults ?? recomputedPerTargets;
          // Only adopt a non-null recomputed hit list — a negated action returns
          // hitTokenUuids: null (hits zeroed separately) and must keep the original.
          if (Array.isArray(r.hitTokenUuids)) recomputedHitTokenUuids = r.hitTokenUuids;
          recomputedRoll = r.roll ?? recomputedRoll;
          // Only override the headline damage when the ROLL actually changed (reroll);
          // other mutations keep their existing payload-derived headline path.
          const rollChanged = !!(r.roll && liveAr.roll
            && (r.roll.rA !== liveAr.roll.rA || r.roll.rB !== liveAr.roll.rB || r.roll.total !== liveAr.roll.total));
          // `gmDamageApplied` too: a hand-set damage composition changes no dice,
          // so a roll-changed test alone would commit the per-target figures
          // while the headline kept the pre-edit number.
          if ((rollChanged || r.gmDamageApplied) && r.recomputedDamage) recomputedHeadlineDamage = r.recomputedDamage;
          accuracyOverride = r.accuracyOverride ?? null;
          costOverride = r.costOverride ?? null;
          if (r.mutationsApplied > 0 || negated) {
            log(`CONFIRM: target-set mutation — ${r.mutationsApplied} applied${negated ? "; NEGATED" : ""}`);
          }
          // creature_check_adjusted — a reactive intervention (reroll / +accuracy /
          // −DEF·MDEF) changed this check's numbers. Emit ONCE per (card, causer) at
          // the commit, deduped by _instanceId so a re-CONFIRM / F5 can't double-fire.
          // Dispatched to the UNION of {subject, causer} so both CHECK_ADJUSTED_ON_MINE
          // (subject-side) and CHECK_ADJUSTED_BY_ME (causer-side, incl. observer flips
          // where Hina rerolls an ally's check) resolve — the legacy oni:reactionPhase
          // bridge only ever reaches the subject, so we queue directly here.
          try {
            const events = buildCheckAdjustedEvents({
              ar: liveAr, finalPerTargets: recomputedPerTargets, finalRoll: recomputedRoll,
              accuracyOverride, adjusters: r.checkAdjusters,
            });
            if (events.length) {
              const inst = liveAr?._instanceId ?? director.ctx.actionResult?._instanceId ?? "";
              if (!(director.ctx._checkAdjustedEmitted instanceof Set)) director.ctx._checkAdjustedEmitted = new Set();
              if (!Array.isArray(director.ctx._postResolveTriggers)) director.ctx._postResolveTriggers = [];
              for (const ev of events) {
                const dedupKey = `${inst}::${ev.causerActorUuid}`;
                if (director.ctx._checkAdjustedEmitted.has(dedupKey)) continue;
                director.ctx._checkAdjustedEmitted.add(dedupKey);
                // Union of reactor actors: subject + causer (deduped by uuid).
                const reactorUuids = [...new Set([ev.subjectActorUuid, ev.causerActorUuid].filter(Boolean))];
                for (const ruid of reactorUuids) {
                  const reactor = await fromUuid(ruid).catch(() => null);
                  const actorDoc = reactor?.actor ?? (reactor?.documentName === "Actor" ? reactor : null);
                  if (!actorDoc) continue;
                  director.ctx._postResolveTriggers.push({
                    casterActor: actorDoc,
                    trigger: "creature_check_adjusted",
                    payload: ev,
                  });
                }
              }
            }
          } catch (e) { warn("CONFIRM: creature_check_adjusted emit threw", e); }
          // Deferred durable AE-charge writes (generic) — a card mutation can request
          // a value-dependent charge update that must persist EXACTLY once. The
          // card-mutation runs many times during preview; THIS confirm path runs once,
          // so it is the single safe write site. The actual write goes through the
          // shared charges API (badge-aware, persistent-counter-safe), NOT a raw flags
          // poke. First producer: set_check_die's old-face writeback (Lucky Seven's
          // mutating lucky number) — the value is only known mid-mutation, so it can't
          // be a static adjust_charges row.
          try {
            const writes = Array.isArray(r.chargeWrites) ? r.chargeWrites : [];
            if (writes.length) {
              const { set: setCharge } = await import("./skill-charges.js");
              for (const cw of writes) {
                if (!cw?.aeUuid || !Number.isFinite(Number(cw.charges))) continue;
                const ae = await fromUuid(cw.aeUuid).catch(() => null);
                if (!ae) continue;
                // deleteWhenEmpty:false — a store AE (the lucky number) must survive a 0.
                await setCharge(ae, Number(cw.charges), { deleteWhenEmpty: false });
                log(`CONFIRM: deferred charge write — ${ae.name} charges → ${Number(cw.charges)}`);
              }
            }
          } catch (e) { warn("CONFIRM: deferred charge write threw", e); }
          // Deferred ONE-SHOT carrier consumption — the Apply→Spent half of a
          // card-previewed reaction (`consume_carrier_charge`). Same contract as
          // the charge writes above: the mutation only RECORDED the intent, and
          // THIS path runs once, so a cancelled action never spends the buff.
          // `consume` deletes the AE at zero, so a spent one-shot buff removes
          // itself and stops offering (no 0-charge carrier lingers to re-fire).
          try {
            const consumes = Array.isArray(r.carrierConsumes) ? r.carrierConsumes : [];
            if (consumes.length) {
              const charges = await import("./skill-charges.js");
              for (const cc of consumes) {
                if (!cc?.aeUuid) continue;
                const ae = await fromUuid(cc.aeUuid).catch(() => null);
                if (!ae) continue;
                const res = await charges.consume(ae, {
                  count: Number(cc.count) || 1,
                  deleteWhenEmpty: cc.deleteWhenEmpty !== false,
                });
                // An author may forget `ae_initial_charges`; a one-shot buff with
                // no charge flag would otherwise persist forever. Honour the
                // declared intent and remove it.
                if (!res?.ok && res?.reason === "no-charges-flag") {
                  await ae.delete();
                  log(`CONFIRM: carrier consume — ${ae.name} had no charges; deleted (one-shot intent)`);
                } else {
                  log(`CONFIRM: carrier consume — ${ae.name} remaining ${res?.remaining ?? "?"}${res?.deleted ? " (deleted)" : ""}`);
                }
              }
            }
          } catch (e) { warn("CONFIRM: carrier consume threw", e); }
        }
      } catch (e) { warn("CONFIRM: target-set mutation threw", e); }
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
      // Study: a check-adjusting reaction (Divination reroll / Lucky Seven die-set)
      // changed the total → re-derive the encyclopedia tier + improved flag so a
      // full re-render (F5 resume / rewind) shows the mutated tier. RESOLVE reads
      // roll.total directly, so the recorded result already follows the new roll.
      let studyTierPatch = null;
      if (String(ar.kind ?? "") === "Study" && recomputedRoll) {
        try {
          const encApi = globalThis.FUCompanion?.api?.encyclopedia;
          const tier = encApi?.classifyStudyTotal
            ? encApi.classifyStudyTotal(recomputedRoll.total, { isCrit: !!recomputedRoll.isCrit, isFumble: !!recomputedRoll.isFumble })
            : null;
          if (tier) {
            const previousBest = Number(ar.previousBest) || 0;
            studyTierPatch = { tier, improved: !recomputedRoll.isFumble && (tier.effective ?? recomputedRoll.total) > previousBest };
          }
        } catch (e) { warn("CONFIRM: Study tier recompute threw", e); }
      }
      director.ctx.actionResult = freezeActionResult({
        ...director.ctx.actionResult,
        targets: mutatedTargets,
        perTargetResults: recomputedPerTargets,
        hitTokenUuids: recomputedHitTokenUuids,
        roll: recomputedRoll,
        ...(studyTierPatch ? studyTierPatch : {}),
        ...(recomputedHeadlineDamage ? { damage: recomputedHeadlineDamage } : {}),
        ...(newDamageType ? { damageType: newDamageType } : {}),
        acceptedCardReactions: applied,
        evaluatedCardReactions: evaluated,
        accuracyOverride,
        // MERGE, not assign: COMPUTE may have pre-composed this skill's own
        // chain adjustments (a pre_activate-captured spend). Overwriting here
        // silently dropped them, so §1 would debit the printed floor again.
        costOverride: mergeCostOverrides(liveAr?.costOverride ?? ar?.costOverride ?? null, costOverride),
        // negate_action (Shadow Possession) — RESOLVE skips outcome + effect/
        // reaction firing; the per-target hits are already zeroed + Blocked above.
        negated,
      });
    } else if (!isGmOverrideEmpty(director.ctx.actionResult?.gmOverride)) {
      // Manual GM edits with NO reaction decisions — the block above never runs,
      // so the hand-set values would be shown on the card and then silently
      // dropped at Confirm. Re-run the SAME shared entrypoint with an empty
      // accepted list: every reaction phase no-ops, and the recompute re-derives
      // the rows with the GM layer threaded in, exactly as the card preview did.
      //
      // Deliberately a separate branch rather than widening the gate above: that
      // block also stamps `acceptedCardReactions` / `evaluatedCardReactions`, and
      // running it with an empty decision list would overwrite any candidates
      // COMPUTE pre-stamped. Here we write ONLY the fields the GM layer owns.
      const liveAr = director.ctx.actionResult ?? ar;
      try {
        const { applyTargetSetMutation } = await import("./card-mutations.js?cb=" + Date.now());
        const r = await applyTargetSetMutation({
          ar: liveAr, accepted: [],
          attackerActor, round: director.dCombat?.round ?? 0,
        });
        if (!r?.cancelled) {
          log(`CONFIRM: GM card override committed — ${summarizeGmOverride(liveAr.gmOverride) ?? "none"}`);
          director.ctx.actionResult = freezeActionResult({
            ...director.ctx.actionResult,
            perTargetResults: r.perTargetResults ?? liveAr.perTargetResults ?? null,
            hitTokenUuids: Array.isArray(r.hitTokenUuids) ? r.hitTokenUuids : (liveAr.hitTokenUuids ?? null),
            // The TARGET LIST too — a GM add/remove rewrites it, and RESOLVE
            // reads `ar.targets` for `action_targets` (every status / save_check
            // / apply_ae row the skill applies). Committing only the damage rows
            // left a removed creature taking no damage while still receiving
            // every status the skill hands out, and an added one taking damage
            // but receiving none: half-applied, and the leaking half invisible.
            // The reaction branch above already commits this; this branch runs
            // for any card WITHOUT reaction pills, which is the common case.
            targets: r.targets ?? liveAr.targets ?? null,
            // Hand-set dice replace the action's roll wholesale — RESOLVE, crit
            // handling and the battle log all read ar.roll, so a GM accuracy
            // edit that stopped at the card would be cosmetic only.
            ...(r.roll ? { roll: r.roll } : {}),
            ...((r.gmDamageApplied || r.roll) && r.recomputedDamage ? { damage: r.recomputedDamage } : {}),
            // Only when the GM actually set one — an unconditional write would
            // null out an accuracyOverride COMPUTE had already composed.
            ...(r.accuracyOverride ? { accuracyOverride: r.accuracyOverride } : {}),
          });
        }
      } catch (e) {
        warn("CONFIRM: GM card override commit threw", e);
      }
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
// The gates live in encyclopedia-witness.witnessNpcAbility, shared with the
// passive/reaction fire path (firePreAcceptedCandidate) so the two can't
// drift. recordWitnessedAction is GM-only and RESOLVE.onEnter is GM-side, so
// the call is safe. It only writes the Monster Encyclopedia journal
// (never actor state), so ordering vs damage/AE application is irrelevant
// and it stays out of the actor-based rewind snapshot — witness knowledge
// is monotonic and shouldn't un-reveal on a turn rewind. The journal
// re-render reaches players via Foundry doc sync; no chat message is posted
// (consistent with the director's no-chat-log rule).
async function recordNpcActionWitness(director, ar) {
  try {
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

    // Hostile gate, prototype resolution and the catalogue check all live in
    // witnessNpcAbility — shared with the passive/reaction fire path so the
    // two can't drift.
    await witnessNpcAbility({
      tokenUuid,
      itemUuid:   actionUuid,
      actionName: ar.skillName ?? ar.weapon?.name ?? ar.kind,
    });
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
      // applyEquipmentSwap(actor, ar.equipmentSelections) + applyWeaponForm-
      // Selections(actor, ar.weaponFormSelections).
      await resolveAction(director, ar, { actionSkill: getCoreActionSkill("equipment") });
      // Per-weapon free-transform allowance: stamp each weapon that just spent
      // its once-per-round free transform (computed at CONFIRM → transformFree-
      // UsedItemIds), so a 2nd free transform of the SAME weapon this round is
      // paid. Round-stamped, so it auto-refreshes next round.
      const freeIds = Array.isArray(ar.transformFreeUsedItemIds) ? ar.transformFreeUsedItemIds : [];
      if (freeIds.length && director.dCombat) {
        const round = director.dCombat.round;
        const econActor = ar.attacker?.actorUuid ? await fromUuid(ar.attacker.actorUuid).catch(() => null) : null;
        for (const id of freeIds) {
          const it = econActor?.items?.get?.(id);
          if (!it) continue;
          try { await it.setFlag("fabula-ultima-companion", "transformFreeUsedRound", round); }
          catch (e) { warn(`RESOLVE Equipment: stamp free-transform flag failed on ${it.name}`, e); }
        }
      }
    } else if (ar.kind === "Skill" || ar.kind === "Item") {
      // Resolve a Skill cast OR Item use through the ONE pipeline — both are
      // skill-shaped sources. resolveAction debits cost (incl. the item cost:
      // consume the consumable for "use", IP for "create"), fires on_activate /
      // per-target damage / post_damage / effect_table. No Item-specific branch.
      // free_of_cost grant (Bimagus's free spells) → skip the cost debit so the
      // cast truly costs no MP. Gated on actually being inside a free action so
      // a stale grant can't zero a normal turn's cost. The printed cost still
      // lives on ar.costSerialized (read for LAST_SPELL_MP in resolveAction §7).
      const skillGrant = freeActions.get(ar.attacker?.actorId ?? null);
      const freeCast = !!(skillGrant?.freeOfCost && topIsFreeAction(director.ctx));
      await resolveAction(director, ar, freeCast ? { skipCost: true } : {});
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
        // Study guard (RAW p.74): mark this (studier actor → target token) pair
        // as Studied for the rest of the fight, so a second Study on the same
        // token by the same person is shown not-targetable. Only NON-fumbled
        // Studies lock — a fumble reveals nothing, so the target stays re-studyable.
        try {
          director.dCombat?.markStudied?.(ar.attacker?.actorId, ar.target?.tokenUuid);
        } catch (e) { warn("RESOLVE Study: markStudied threw", e); }
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
    } else if (ULTIMA_COMMANDS.includes(ar.kind)) {
      // ── Ultima actions (Boss/Villain — rulebook p.101 + homebrew Domination) ──
      // Cost first: 1 Ultima Point always; Domination also consumes the banked
      // Dominance Point. Token-actor-first resolution — unlinked NPC tokens
      // carry their props/AEs on the token-synthetic actor.
      const uToken = ar.attacker?.tokenUuid ? await fromUuid(ar.attacker.tokenUuid).catch(() => null) : null;
      const uActor = uToken?.actor
        ?? (ar.attackerActorRef ? await fromUuid(ar.attackerActorRef).catch(() => null) : null);
      if (!uActor) {
        warn(`RESOLVE ${ar.kind}: acting actor unresolvable — nothing applied`);
      } else {
        const paid = await payUltimaPoint(uActor);
        if (!paid.ok) {
          // DECLARE's backstop makes this near-impossible; refuse loudly rather
          // than granting a free Ultima action.
          warn(`RESOLVE ${ar.kind}: Ultima Point debit failed — effects skipped`);
          ui.notifications?.warn(`${ar.kind}: no Ultima Point — nothing happens.`);
        } else if (ar.kind === "Domination") {
          const dpSpent = await consumeDominancePoint(uActor);
          if (!dpSpent) warn("RESOLVE Domination: Dominance Point consume failed (proceeding — UP already paid)");
          // Common/Domination's on_activate applies the "Domination State" AE
          // (ignore_action_gating, lifetimeMode round_end) to self.
          await resolveAction(director, ar, { actionSkill: getCoreActionSkill("domination") });
          // Energy burst + super-armor SFX on every client.
          emitDominationBurst({ tokenUuid: ar.attacker?.tokenUuid });
          // Re-snapshot the acting combatant so the reopened Octopath (this is
          // a free action — see the turn-economy gate below) sees the gating
          // bypass: blockedActions/disabledActionIntents recompute to empty.
          try {
            const freshSnap = director.dCombat
              ? snapshotDirectorCombatant(director.dCombat.current)
              : snapshotCombatant(director.combat);
            if (freshSnap) director.ctx.turnSnapshot = freshSnap;
          } catch (e) { warn("RESOLVE Domination: turnSnapshot refresh threw", e); }
        } else if (ar.kind === "Recovery") {
          // Common/Recovery: remove every debuff-tagged AE + restore 50 MP.
          await resolveAction(director, ar, { actionSkill: getCoreActionSkill("recovery") });
        } else if (ar.kind === "Escape") {
          // Slow fade-out on every client FIRST (awaited), then the Common
          // item's leave_combat row despawns the combatant + token.
          await emitEscapeFade({ tokenUuid: ar.attacker?.tokenUuid });
          await resolveAction(director, ar, { actionSkill: getCoreActionSkill("escape") });
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
    // A FREE transform-only Equipment action (ar.equipmentFree, set at CONFIRM)
    // does NOT spend the turn: leave currentTurnResolved false and flag the
    // CLEANUP → DECLARE return-to-menu branch. Everything else resolves the turn
    // as normal. (Carried on ctx, not actionResult — Cleanup.onEnter nulls
    // actionResult before the CLEANUP transition reads this.)
    const equipFreeReturn = !!ar?.equipmentFree && !topIsFreeAction(director.ctx);
    // Domination is a FREE action by design: after entering Domination State
    // the boss returns to the action menu with its turn action intact (same
    // return path as the free Equipment transform).
    const dominationFreeReturn = ar?.kind === "Domination" && !topIsFreeAction(director.ctx);
    const freeReturn = equipFreeReturn || dominationFreeReturn;
    if (director.dCombat && !topIsFreeAction(director.ctx) && !freeReturn) {
      director.dCombat.currentTurnResolved = true;
    }
    director.ctx.returnToMenuAfterCleanup = freeReturn;
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
    // deferWrites: the rewind snapshot (the only step that must read actor state
    // BEFORE settleInstance mutates it, just below) is captured synchronously
    // inside saveDirectorState before it returns; the two DB writes then run in
    // the background. This keeps the two flag-write round-trips off the RESOLVE
    // critical path so the FSM advances toward the next turn's menu sooner — the
    // perceived "menu doesn't open as the phase ends" gap on slower connections.
    await saveDirectorState(director, {
      label: `${rvPhase} · After ${rvName}'s Action${rvPassTag}`,
      description: describeActionForRewind(ar),
      deferWrites: true,
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
      // recordForReoffer: capture this action's reaction group (+ used-set) so
      // REACTION_WINDOW can drain any queued free actions and re-offer the
      // remaining reactions (deferred-action → return-to-reaction-phase loop).
      // Skip for free actions — a free action's OWN reaction group is offered
      // here but its re-offer loop is owned by the parent's REACTION_WINDOW
      // (whose resolveDetour frame snapshots these fields across the drain).
      await settleInstance(director, { reason: "resolve", recordForReoffer: !topIsFreeAction(director.ctx) });
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
// Post-action-card reaction window. The action's FORCED + first ASK offer
// already ran inside RESOLVE (settleInstance); this state owns the part that
// was missing: when a post-resolve reaction queued a free action (Counterattack
// etc.), drain it through FREE_ACTION_WINDOW and then RE-OFFER the remaining
// reactions, looping until the queue stops refilling. This mirrors the
// STANDALONE_REACTION_WINDOW ⇄ FREE_ACTION_WINDOW loop that lifecycle triggers
// already have, extending it to every reaction group outside the action card.
//
// Three entry modes (distinguished by the continuation-stack top):
//   - `freeAction:*` on top → we're mid free-action sub-flow (a free action's
//     own RESOLVE landed here). Route straight back to FAW so it pops its frame
//     and drains/exits — do NOT run the re-offer loop (the parent owns it).
//   - `resolveDetour:*` on top → re-entry after a queued free action drained.
//     Pop (restores _reactionWindowTriggers + _postResolveUsed), re-offer the
//     remaining reactions, then fall through to the queue check.
//   - neither (first entry from RESOLVE) → fall through to the queue check.
const ReactionWindow = {
  async onEnter(director) {
    const ctx = director.ctx;

    // Mid free-action sub-flow — the table routes REACTION_WINDOW → FAW on
    // topIsFreeAction. Let it: FAW pops the frame and drains the next request
    // (or exits to the resolveDetour frame underneath).
    if (topIsFreeAction(ctx)) {
      director.enqueue({ type: INTENTS.INTERNAL_DONE });
      return;
    }

    // Re-entry after a free action drained — pop our detour frame (restores the
    // captured trigger group + used-set) and re-offer the remaining reactions.
    if (topIsResolveDetour(ctx)) {
      popFrame(director);
      try {
        const { reofferPostResolveReactions } = await import("./instance-settle.js");
        await reofferPostResolveReactions(director, {
          triggers: ctx._reactionWindowTriggers ?? [],
          used: ctx._postResolveUsed ?? [],
        });
      } catch (e) { warn("REACTION_WINDOW: re-offer threw", e); }
    }

    // If a reaction (first offer in RESOLVE, or the re-offer above) queued a
    // free action, detour through FAW and resume HERE when it drains. The frame
    // snapshots the trigger group + used-set so the free action's own RESOLVE
    // can't clobber them (it populates its own copies, restored on our pop).
    try {
      const { freeActionQueue } = await import("./free-action-queue.js");
      if (!freeActionQueue.isEmpty()) {
        log(`REACTION_WINDOW: ${freeActionQueue.size()} free-action request(s) pending → detour through FREE_ACTION_WINDOW → re-offer on completion`);
        pushFrame(director, {
          reason: "resolveDetour:postResolve",
          resumeAt: STATES.REACTION_WINDOW,
          fieldsToSnapshot: ["_reactionWindowTriggers", "_postResolveUsed"],
        });
        // Survival-only (`skipHistory`): F5-resume through the FAW detour, not a
        // rewind-list entry. It captured a transient "awaiting free-action drain"
        // moment between RESOLVE and the next FSM anchor — a rewind target the GM
        // never wants (they'd rewind to RESOLVE or TURN_START instead).
        try {
          await saveDirectorState(director, { skipHistory: true });
        } catch (e) { warn("REACTION_WINDOW: pre-FAW save failed", e); }
        await director.transitionTo(STATES.FREE_ACTION_WINDOW);
        return;
      }
    } catch (e) {
      warn("REACTION_WINDOW: free-action queue check threw", e);
    }

    // Queue empty and nothing more to offer — the reaction window is done.
    director.enqueue({ type: INTENTS.INTERNAL_DONE });
  },
};

// ─── CLEANUP ───────────────────────────────────────────────────────────
// Per-turn cleanup. Releases any transient state that shouldn't survive.
const Cleanup = {
  async onEnter(director) {
    director.ctx.actionResult = null;
    director.ctx.currentWeapon = null;
    director.ctx.reactionDepth = 0;
    // Post-resolve reaction-window state is per action resolution — clear it so
    // the next action (incl. the next two-weapon pass) starts with a fresh
    // reaction group + used-set. The REACTION_WINDOW loop has fully drained by
    // the time we reach CLEANUP.
    director.ctx._reactionWindowTriggers = null;
    director.ctx._postResolveUsed = null;

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
      // Per-activation discriminator for the turn_end fired-set scope. Captured
      // BEFORE nextTurn — buildStandalonePayload reads dCombat.current, which is
      // already null/the NEXT combatant when the turn_end window dispatches, so
      // without this the scope key collapses to "a?" for every turn_end and a
      // multi-activation boss's 2nd/3rd turn ends of the round dedup against
      // its 1st (turn_start never had the bug: current is set there).
      const endingActivationsRemaining = director.dCombat?.current?.turnsRemaining ?? null;

      // Bearer-turn-end AE tick — decrement "target_turn_end" lifetime AEs on the
      // actor whose turn just ended (action-gating Advanced Debuffs last N of the
      // AFFECTED creature's own turns). Distinct from the applier-turn-start tick
      // that runs in TURN_START; awaited so expiry commits before the next turn.
      if (endingActorUuid) {
        try { await SE().tickDirectorAEsForBearerTurnEnd(endingActorUuid); }
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
        // Pre-nextTurn snapshot — overrides buildStandalonePayload's
        // dCombat.current read (null between turns). See capture above.
        actingActivationsRemaining: endingActivationsRemaining,
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
      // Pass the combatants' TOKEN actors — unlinked NPC bearers (e.g. a boss's
      // Domination State) carry their AEs on the token-synthetic actor, which
      // the sweep's world-actor walk can't see.
      const swept = await SE().tickDirectorAEsAtRoundEnd({
        extraActors: (director.dCombat?.combatants ?? [])
          .map((c) => c.actorDoc ?? c.tokenDoc?.actor ?? null)
          .filter(Boolean),
      });
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
              const { sweepDerivedStatuses } = await import("./derived-status-reactor.js");
              await sweepDerivedStatuses(director);
            } catch (e) { warn(`STANDALONE_REACTION_WINDOW: ${trigger} crisis/derived sweep threw`, e); }
            // Remove eligible enemies that begin combat already at 0 HP — the
            // event-driven defeat reactor only fires on HP changes.
            try {
              const { sweepDefeat } = await import("./defeat-reactor.js");
              await sweepDefeat(director);
            } catch (e) { warn(`STANDALONE_REACTION_WINDOW: ${trigger} defeat sweep threw`, e); }
            // Re-instate persistent summons (Birth of the Cruel's reanimated minion,
            // etc.): a party member's standing clone-ally re-joins the battle on their
            // side. conflict_start only — not turn_start.
            if (trigger === "conflict_start") {
              try {
                const { reAddPersistentSummons } = await import("./skill-effects.js");
                await reAddPersistentSummons(director);
              } catch (e) { warn(`STANDALONE_REACTION_WINDOW: reAddPersistentSummons threw`, e); }
            }
          }
          // Conflict event (scene-selected additional rule) — seeds at
          // conflict_start, re-seeds / upkeeps at round_start. Runs AFTER the
          // sweeps above so the battlefield it reads is reconciled, and BEFORE
          // the forced dispatch so a status it seeds is visible to the
          // force-mode reactions in this same window. No-ops unless the
          // conflict scene selects an event. See [[conflict-event]].
          try {
            const { dispatchConflictEventLifecycle } = await import("../conflict-event/conflict-event-runtime.js");
            await dispatchConflictEventLifecycle(director, trigger);
          } catch (e) { warn(`STANDALONE_REACTION_WINDOW: ${trigger} conflict-event dispatch threw`, e); }
          // FORCED pass — auto-fire force/on (Burn commits + populates the
          // ledger; action-creating grants like High Speed enqueue freeActionQueue).
          await dispatchStandaloneTrigger({ director, trigger, payload, phase: "forced" });
          // SETTLE (T1) — drain the resource ledger, re-firing to quiescence.
          try {
            const { settleInstance } = await import("./instance-settle.js");
            await settleInstance(director, { reason: trigger });
          } catch (e) { warn(`STANDALONE_REACTION_WINDOW: ${trigger} settleInstance threw`, e); }
          // CHECKPOINT — transaction commit point (forced reactions settled).
          // Survival-only (`skipHistory`): NOT a rewind-list entry. This fired
          // for EVERY standalone-reaction window (conflict_start / turn_start /
          // turn_end) even when no forced reaction changed state, so a
          // state-identical `· settled` entry shadowed the real TURN_START /
          // TURN_END / RESOLVE anchors right next to it. The label differed, so
          // the fingerprint dedup didn't collapse it. Keeping the survival write
          // preserves F5-resume at this commit point without the duplicate.
          try {
            await saveDirectorState(director, { skipHistory: true });
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
        // Survival-only (`skipHistory`): this save exists purely so F5 mid-detour
        // sees the srwDetour frame + queued free action and resumes correctly (per
        // the block above). It is NOT a rewind target — the "awaiting player free
        // action" moment is transient plumbing, and its `· pending` label differed
        // from neighbours so the fingerprint dedup left a duplicate in the list.
        try {
          await saveDirectorState(director, { skipHistory: true });
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
      // Spell-only MP cap from the free_action row (Acceleration → "a spell with
      // total MP cost ≤ 10"). Threaded so composeSkill can pass it to the picker;
      // omitting it here is what silently disabled the cap on the free turn.
      maxMpCost:        req.maxMpCost ?? null,
      // free_of_cost — the granted action pays no resource cost (Bimagus's free
      // spells). The Skill/Spell RESOLVE branch reads this off the grant and
      // passes skipCost to resolveAction. The maxMpCost cap above still gates
      // eligibility by printed cost.
      freeOfCost:       req.freeOfCost === true,
      // Compose-style restrictions threaded from the free_action row: a Skill/Spell
      // menu allow-list (Counter Pass → only Passes) and a forced target the composed
      // action must hit (the triggering enemy). Both null when unset. composeSkill
      // reads allowedSkillRefs; the targeting step reads lockedTargetTokenUuid.
      allowedSkillRefs:      req.allowedSkillRefs ?? null,
      lockedTargetTokenUuid: req.lockedTargetTokenUuid ?? null,
      // Rider knobs (Ripples): force the spawned attack's element (adopt the
      // ally's) + run on-hit effect refs from the granting skill after it lands.
      elementOverride:       req.elementOverride ?? null,
      onHitEffectRefs:       req.onHitEffectRefs ?? null,
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

    // JRPG cinematic etiquette — fade the Dominance Crests out on every client
    // while the animation plays (restored in onExit/onAbort, which fire on
    // every way out of this state incl. Skip Animation and battle-end aborts).
    try { emitCrestsHidden(true); } catch (e) { warn("ANIMATION: emitCrestsHidden(true) threw", e); }

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
    // Restore the Dominance Crests on every client (no-op if never hidden —
    // the !spec.hasScript fast path skips the hide entirely).
    try { emitCrestsHidden(false); } catch {}
    // Abort the gate if the FSM leaves ANIMATION for any reason before the
    // animation finishes (e.g. STOP_COMBAT during a cinematic).
    if (director.ctx.animationController?.playing) {
      try { director.ctx.animationController.abort?.(); } catch {}
      director.ctx.animationController = null;
    }
  },

  onAbort(director) {
    try { emitCrestsHidden(false); } catch {}
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
    // A pending undying claim (boss revive — see [[undying]]) means this
    // battle must NOT end, lean or not: the sequence runs so evaluateUndying
    // can intercept and resume. Normal lean/sim flow never registers a claim
    // (the reactor revives inline), so sims are unaffected — this only
    // activates under the undying.forceCinematic dev toggle.
    let _undyingPending = false;
    try {
      _undyingPending = !!(game.settings.get("fabula-ultima-companion", "bdUndyingState")?.pending);
    } catch (_) {}
    if (!isDevMode || _undyingPending) {
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
