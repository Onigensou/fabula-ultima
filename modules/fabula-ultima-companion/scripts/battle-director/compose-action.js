// composeAction — client-local pick-chain runner.
//
// Runs the entire "compose" phase of a turn (Octopath → per-command
// pickers) on whichever client invokes it. Returns a Promise that
// resolves with either { cancelled: true } or { cancelled: false, bundle }
// where `bundle` is the action's commit payload.
//
// Used by:
//   - GM client: state-handlers' DECLARE.onEnter spawns this as the local
//     fallback compose chain.
//   - Player client: the MENU_OPEN("compose-action") handler in
//     director-boot.js spawns this when the GM broadcasts that it's
//     this player's PC's turn.
//
// The first side to complete its compose chain "wins". GM's FSM applies
// the winning bundle and proceeds to COMPUTE → CONFIRM. The losing side
// gets a cancellation signal via `externalCancel` and tears down its UI.
//
// Bundle shape (minimum viable — Attack only for v1):
//   {
//     command:    "Attack" | "Guard" | "Skill" | ... ,
//     // Attack-specific:
//     attackMode: "main" | "off" | "two-weapon" | "two-weapon-off-first",
//     targetUuids: string[],
//   }
//
// Commands without compose support (everything except Attack for v1)
// return a "passthrough" bundle that just carries the command name. The
// GM's FSM then runs the per-command pickers locally on GM's side as
// today. Player clicking these unsupported commands gets the same
// fallback behavior as if they hadn't acted at all.
//
// See [[director-player-driven-input]] for the design.

import { log, warn } from "./logger.js";
import { INTENTS } from "./intents.js";
import { TurnUI } from "./turn-ui.js";
import { requestTargeting } from "./target-picker.js";
import { pickWeaponMode } from "./weapon-mode-picker.js";
import { pickSkill } from "./skill-picker.js";
import { pickItem } from "./item-picker.js";
import { getLinkedSkillUuid } from "./item-resource.js";
import { classifyActionIntent } from "./skill-intent.js";
import { buildSkillResolver, evaluateFormula } from "./skill-formulas.js";
import { resolveTargetPlan } from "./state-handlers.js";
import { freeActions } from "./free-actions.js";
import { getNpcAttackItems } from "./actor-shape.js";
import { buildUltimaMenuSpec } from "./domination.js";
import { pickFromList } from "./list-picker.js";
import { applyAttackRangeGate, applyStudyGuardExclusion, snapshotEligibleTargetsFromDCombat } from "./snapshot.js";

// Race-cancellation token. Returns { promise, cancel }. The promise
// resolves with the cancellation reason when cancel() is called.
// composeAction reads the promise to abort mid-chain.
export function makeCancelToken() {
  let resolveFn;
  const promise = new Promise((res) => { resolveFn = res; });
  return {
    promise,
    cancel: (reason = "cancelled") => { try { resolveFn?.(reason); } catch {} },
    isCancelled: false,
  };
}

// Cancel-aware wait. If cancelSentinel fires first, returns null;
// otherwise returns the awaited Promise's value.
async function raceCancel(promise, cancelSentinel) {
  const wrapped = Promise.resolve(promise).then((v) => ({ kind: "value", v }));
  const cancel = cancelSentinel.then((reason) => ({ kind: "cancel", reason }));
  const r = await Promise.race([wrapped, cancel]);
  return r.kind === "value" ? r.v : null;
}

// Entry point.
//
// Required args:
//   - snap:          the acting actor's snapshot (turnSnapshot shape).
//                    Fields used: name, tokenId, tokenUuid, actorUuid,
//                    weapon, offWeapon, canTwoWeaponFight.
//   - token:         the canvas Token object for the acting combatant.
//   - cancelSentinel: a Promise that, when resolved, signals "stop now".
//                    Use makeCancelToken() to construct.
//   - combatId:      string used to key TurnUI / picker instances.
//
// Optional args:
//   - director:      passed through to pickers for director.hooks. null
//                    on player client (pickers fall back to global Hooks).
//   - actorUuid:     used by TurnUI's default Passive button handler.
//   - eligible:      pre-baked eligible-target lists. Required on PLAYER
//                    client (no dCombat). Optional on GM (we compute from
//                    dCombat directly). Shape: { enemies: TargetSnap[],
//                    allies: TargetSnap[] } where TargetSnap has at least
//                    { tokenUuid, tokenId, name, img, conditions }.
export async function composeAction({
  director = null,
  snap,
  token,
  cancelSentinel,
  combatId,
  actorUuid = null,
  eligible = null,
  // Explicit grant override — used by the player-side MENU_OPEN
  // handler which receives the grant in the menuSpec (GM's freeActions
  // singleton is not visible on the player's client). GM-side falls
  // through to the local registry.
  freeActionGrant = null,
}) {
  if (!snap) return { cancelled: true, reason: "no snap" };
  if (!token) return { cancelled: true, reason: "no token" };
  if (!cancelSentinel) {
    // Defensive: callers should always pass one, but supply a stub.
    cancelSentinel = new Promise(() => {});
  }

  // Track external cancel via a flag so we can distinguish it from
  // user-initiated picker cancellation (Esc / Cancel button). User
  // cancel loops back to the Octopath; external cancel breaks out.
  let externallyCancelled = false;
  cancelSentinel.then(() => { externallyCancelled = true; });

  // Outer loop: each iteration is one full Octopath → per-command chain.
  // Sub-picker cancellation (target / weapon mode / Esc) returns to the
  // Octopath so the player can pick a different command. External cancel
  // (race lost, MENU_CLOSE from GM) exits the loop entirely.
  while (!externallyCancelled) {
    // Free-action grant filter — when this actor has a pending grant
    // (e.g. from High Speed's conflict_start chain), the Octopath shows
    // only `enabledLabels` and the budget reads "<Skill> Free Action".
    // Explicit grant (from MENU_OPEN spec, player-side) wins over the
    // local registry. GM-side reads the registry directly since the
    // singleton lives on this client. State-handlers' COMPUTE reads
    // the singleton on the GM to apply checkBonus/damageBonus.
    const actorIdForGrant = snap?.actorId ?? (actorUuid ? String(actorUuid).split(".").pop() : null);
    const grant = freeActionGrant
      ?? (actorIdForGrant ? freeActions.get(actorIdForGrant) : null);
    // Boss-only "Ultima" blade on the System tab — opens the Ultima action
    // picker (Domination / Escape / Recovery). Hidden inside a free-action
    // window (the filtered one-page menu) — Ultima actions are declared on the
    // boss's own turn proper. With no Ultima Point at all the blade itself is
    // greyed + red-stamped like an action-gating debuff; per-action shortfalls
    // (e.g. no Dominance Point) dim individual picker rows instead.
    const ultimaSpec = grant ? null : buildUltimaMenuSpec(snap);
    const ultimaDisabled = ultimaSpec?.buttonDisabledReason
      ? [{ label: "Ultima", reason: ultimaSpec.buttonDisabledReason }]
      : [];
    const command = await waitForOctopathClick({
      director, token, combatId, actorUuid, cancelSentinel,
      enabledLabels: grant?.enabledLabels ?? null,
      budgetText: grant ? `${grant.sourceLabel ?? "Free"} Free Action` : null,
      // Action-gating debuffs (Frightened/Silence/…) — frozen Array<{label,
      // reason}> captured at snapshot time; the menu greys + red-stamps these.
      disabledLabels: [...(snap?.blockedActions ?? []), ...ultimaDisabled],
      showUltima: !!ultimaSpec,
    });
    if (externallyCancelled || command === null) break;

    log(`composeAction: command picked = ${command}`);

    // GM-side live recompute of the eligible pool. The `eligible` arg is
    // baked ONCE at DECLARE (turn start); a creature spawned mid-turn (dev
    // tools addCombatant, summons, etc.) is absent from that frozen list, so
    // the target picker can't see it until an F5 re-bakes DECLARE. The GM
    // client has full dCombat access, so we recompute here — AFTER the
    // interactive Octopath click, i.e. the latest point before any picker
    // opens — to pick up roster changes made while the menu was up. Players
    // (director === null) keep the broadcast bake; they don't add combatants.
    // Honors the documented contract: `eligible` is "Optional on GM (we
    // compute from dCombat directly)".
    if (director?.dCombat?.combatants?.length) {
      try {
        eligible = {
          enemies: snapshotEligibleTargetsFromDCombat(director.dCombat, snap, { category: "enemy" }),
          allies:  snapshotEligibleTargetsFromDCombat(director.dCombat, snap, { category: "ally"  }),
          // Study guard (RAW p.74) — recompute live from dCombat too, else the
          // rebuild would drop the baked value and the GM-side Study picker
          // wouldn't grey out tokens this actor already studied this fight.
          studiedTokenUuids: director.dCombat?.studiedTokensFor?.(snap.actorId) ?? [],
        };
      } catch (e) {
        warn("composeAction: GM live-eligible recompute threw — using baked list", e);
      }
    }

    let result;
    switch (command) {
      case "Attack":
        result = await composeAttack({ director, snap, token, eligible, cancelSentinel, combatId });
        break;
      case "Guard":
        result = await composeGuard({ director, snap, eligible, cancelSentinel });
        break;
      case "Study":
        result = await composeStudy({ director, snap, eligible, cancelSentinel });
        break;
      case "Hinder":
        result = await composeHinder({ director, snap, eligible, cancelSentinel });
        break;
      case "Equipment":
        // No picks — Equipment is a free-form sheet swap; the card
        // prompts the player to drag items between slots on confirm.
        result = { cancelled: false, bundle: { command: "Equipment" } };
        break;
      case "Skill":
      case "Spell":
        result = await composeSkill({
          director, snap, eligible, cancelSentinel,
          isSpell: command === "Spell",
        });
        break;
      case "Item":
        // Item = source selection (pickItem) then the SHARED targeting, exactly
        // like Skill. After this the consumable flows through the one pipeline
        // (TARGET→COMPUTE→CONFIRM→resolveAction) with no Item-specific path.
        result = await composeItem({ director, snap, eligible, cancelSentinel });
        break;
      case "Ultima":
        // Boss Ultima menu — ListPicker over the three Ultima actions. The
        // picked command travels as the bundle's concrete command name
        // (Domination/Escape/Recovery), so TARGET/RESOLVE/cards are shared.
        // Cancel loops back to the Octopath like any sub-picker. The GM-side
        // DECLARE backstop re-validates boss status + point affordability.
        result = await composeUltima({ director, snap, ultimaSpec, cancelSentinel });
        break;
      default:
        return { cancelled: true, reason: `unknown command: ${command}` };
    }

    if (externallyCancelled) break;

    if (result.cancelled) {
      // User cancelled a sub-picker (target / weapon mode). Loop back
      // to the Octopath so they can pick a different command. Mirrors
      // GM-side TARGET_BACK → DECLARE behavior.
      log(`composeAction: ${command} sub-picker cancelled (${result.reason ?? "?"}) — returning to Octopath`);
      continue;
    }

    return result;
  }

  return { cancelled: true, reason: "external-cancel" };
}

// Spawn TurnUI, return a Promise that resolves with the command label
// or null if cancelled. Cleans up the Octopath in either path.
function waitForOctopathClick({ director, token, combatId, actorUuid, cancelSentinel, enabledLabels = null, budgetText = null, disabledLabels = null, showUltima = false }) {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (value) => {
      if (resolved) return;
      resolved = true;
      try { TurnUI.despawn({ director, combatId }); } catch {}
      resolve(value);
    };
    cancelSentinel.then(() => finish(null));
    TurnUI.spawn({
      director, token, combatId, actorUuid,
      onPick: (command) => finish(command),
      enabledLabels,
      budgetText,
      disabledLabels,
      showUltima,
      // Passive button intentionally uses TurnUI's default — opens
      // PassiveManager locally without entering the compose chain. The
      // Octopath stays open (TurnUI.spawn doesn't auto-close on Passive
      // click) so the player can pick a real command after toggling.
    });
  });
}

// Player-side handler: wire IntentChannel events so that when the GM
// broadcasts MENU_OPEN { kind: "compose-action" } at this user, we run
// composeAction locally and emit ACTION_COMPOSED back when done. Also
// listens for MENU_CLOSE to cancel the in-flight chain (e.g. GM won
// the race or End-Battled).
//
// Returns an unregister function (clean up on session end if desired).
export function registerPlayerComposeActionHandler(channel, isActiveDirector = () => false) {
  // Track the current chain's cancel token + a "session id" so that a
  // MENU_OPEN arriving while a prior chain is still running can cancel
  // and replace it cleanly.
  let active = null; // { token, sessionId }

  const offOpen = channel.onMenuOpen(async (menuSpec) => {
    if (!menuSpec || menuSpec.kind !== "compose-action") return;
    // Primary GM runs the compose chain locally in state-handlers; skip here
    // to avoid spawning a duplicate Octopath on top of the local one.
    if (isActiveDirector()) return;
    if (!menuSpec.tokenUuid || !menuSpec.snap) {
      warn("compose-action MENU_OPEN: missing tokenUuid or snap");
      return;
    }

    // Cancel any in-flight chain from a previous (likely stale) MENU_OPEN.
    if (active) {
      try { active.token.cancel("superseded"); } catch {}
      active = null;
    }

    try {
      const tokenDoc = await fromUuid(menuSpec.tokenUuid);
      if (!tokenDoc) {
        warn(`compose-action MENU_OPEN: tokenDoc not found ${menuSpec.tokenUuid}`);
        return;
      }
      // Switch to the battle scene if we're not there (scene.view() is
      // player-safe — it only changes this user's viewport, not others').
      const tokenScene = tokenDoc.parent;
      if (tokenScene && tokenScene.id !== canvas?.scene?.id) {
        log(`compose-action MENU_OPEN: switching player view to ${tokenScene.name}`);
        try { await tokenScene.view(); } catch (e) { warn("scene.view threw", e); }
      }
      const token = tokenDoc.object ?? canvas?.tokens?.get(tokenDoc.id);
      if (!token) {
        warn(`compose-action MENU_OPEN: token not on canvas ${menuSpec.tokenUuid}`);
        return;
      }

      const cancelToken = makeCancelToken();
      const sessionId = foundry.utils?.randomID?.() ?? `compose-${Date.now()}`;
      active = { token: cancelToken, sessionId };

      log(`compose-action MENU_OPEN: starting local chain for ${menuSpec.snap?.name}`);
      const result = await composeAction({
        director: null,
        snap: menuSpec.snap,
        token,
        eligible: menuSpec.eligible ?? { enemies: [], allies: [] },
        cancelSentinel: cancelToken.promise,
        combatId: menuSpec.combatId,
        actorUuid: menuSpec.actorUuid,
        // GM stamps the active free-action grant on the menuSpec —
        // the player's local freeActions singleton is empty (lives on
        // GM client), so we pass it through explicitly. Drives the
        // Octopath filter + budget label.
        freeActionGrant: menuSpec.freeActionGrant ?? null,
      });

      // If the active session changed while we were composing, drop this
      // result silently — a newer MENU_OPEN superseded us.
      if (active?.sessionId !== sessionId) {
        log(`compose-action: result discarded (session ${sessionId} superseded)`);
        return;
      }
      active = null;

      if (result.cancelled) {
        log(`compose-action: cancelled (${result.reason ?? "unknown"})`);
        return;
      }

      // Emit the bundle to the GM. Falls through GM's _onIntent →
      // awaitIntent in DECLARE.onEnter (where the race resolves).
      channel.emit({
        type: INTENTS.ACTION_COMPOSED,
        body: { bundle: result.bundle },
        combatId: menuSpec.combatId,
      });
      log(`compose-action: emitted ACTION_COMPOSED (${result.bundle?.command})`);
    } catch (e) {
      warn("compose-action MENU_OPEN handler threw", e);
      if (active?.sessionId) active = null;
    }
  });

  const offClose = channel.onMenuClose((payload) => {
    if (payload?.kind && payload.kind !== "compose-action") return;
    if (active) {
      log(`compose-action MENU_CLOSE: cancelling local chain (${payload?.reason ?? "?"})`);
      try { active.token.cancel(payload?.reason ?? "menu-close"); } catch {}
      active = null;
    }
  });

  return () => { try { offOpen?.(); } catch {} try { offClose?.(); } catch {} };
}

// ─── Attack ──────────────────────────────────────────────────────────
//
// Pick weapon mode (when dual-equipped) → pick a single target (first
// pass; subsequent passes for two-weapon are handled by the GM FSM
// re-entering TARGET, since multi-pass logic is intertwined with
// COMPUTE/CLEANUP).
async function composeAttack({ director, snap, token, eligible, cancelSentinel, combatId }) {
  // NPC branch — actor has no equipped-weapon concept; the basic attack
  // is chosen from `snap.npcAttackItems` (items with skill_type "Attack").
  // The "weapon-mode" picker doesn't apply: NPCs don't dual-wield in BD.
  if (snap.actorKind === "npc") {
    return composeAttackNpc({ director, snap, eligible, cancelSentinel });
  }

  const hasMain = !!snap.weapon;
  const hasOff = !!snap.offWeapon;
  const virtualAttacks = Array.isArray(snap.virtualAttacks) ? snap.virtualAttacks : [];
  const hasVirtual = virtualAttacks.length > 0;
  if (!hasMain && !hasOff && !hasVirtual) {
    ui.notifications?.warn(`${snap.name} has no usable weapon.`);
    return { cancelled: true, reason: "no weapon" };
  }

  // Weapon mode. ALWAYS show the picker — even with a single option — so the
  // player can see/track which weapon they're attacking with (and gets a free
  // cancel). pickWeaponMode renders a one-row list fine; no auto-pick.
  const picked = await raceCancel(
    pickWeaponMode({
      director,
      mainWeapon: snap.weapon,
      offWeapon: snap.offWeapon,
      allowTwoWeapon: !!snap.canTwoWeaponFight,
      twoWeaponSolo: !!snap.twoWeaponSolo,
      virtualAttacks,
      // Forward the cancel sentinel so the picker overlay tears
      // itself down if the race resolves against us.
      externalCancel: cancelSentinel,
    }),
    cancelSentinel,
  );
  if (!picked) return { cancelled: true, reason: "weapon-mode-cancelled" };
  const attackMode = picked;

  // Target pick.
  const enemies = eligible?.enemies ?? [];
  if (!enemies.length) {
    ui.notifications?.warn("No eligible enemy targets on this scene.");
    return { cancelled: true, reason: "no targets" };
  }

  // Apply Covered range gate via the unified helper — preserves the
  // `.excluded` side-channel (Vanish overlay etc.). RAW Core p.70.
  const currentWeapon = attackMode.startsWith("virtual:")
    ? virtualAttacks[Number(attackMode.slice("virtual:".length)) | 0]
    : (attackMode === "off" || attackMode === "two-weapon-off-first")
      ? snap.offWeapon
      : snap.weapon;
  const filtered = applyAttackRangeGate(enemies, currentWeapon);
  if (!filtered.length) {
    const isMelee = String(currentWeapon?.range ?? "").trim().toLowerCase() === "melee";
    ui.notifications?.warn(isMelee
      ? "All eligible enemies are Covered — pick a different action."
      : "No eligible enemy targets.");
    return { cancelled: true, reason: "no eligible targets" };
  }

  // Multi-pass (two-weapon) deliberately picks only ONE target for the FIRST
  // pass — pass 2 re-enters TARGET on the GM (FSM-driven; per-pick lag for the
  // second pass — an acceptable cost since two-weapon is uncommon). A
  // single-pass attack instead honors the equipped weapon's own `skill_target`
  // (e.g. Zarg's Bow "Up to two creatures" → Multi(2)), resolved through the
  // same plan resolver the NPC-attack composer and GM-side resolveActionTargets
  // use, so the player pre-picks up to N here and the GM trusts that pre-compose.
  const isMultiPass = attackMode === "two-weapon" || attackMode === "two-weapon-off-first";

  let targetUuids;
  if (isMultiPass) {
    const result = await raceCancel(
      requestTargeting({
        director, eligible: filtered, mode: "exact", count: 1,
        titleText: `Pick a target for ${snap.name}'s Attack`,
        // Tear down the canvas rings + banner if our race resolves
        // against us (e.g. GM committed locally while we were picking).
        externalCancel: cancelSentinel,
      }),
      cancelSentinel,
    );
    if (!result || !result.ok) {
      return { cancelled: true, reason: result?.cancelled ? "target-cancelled" : "target-failed" };
    }
    targetUuids = [...result.tokenUuids];
  } else {
    // Resolve the actor so the plan can evaluate any formula count (CHAR_LEVEL,
    // SL=1 without a skill, …). The weapon drives targeting — no backing skill.
    let actorDoc = null;
    try { actorDoc = await fromUuid(snap.actorUuid); } catch {}
    const skillTargetText = String(currentWeapon?.skillTarget ?? "").trim();
    const plan = resolveTargetPlan({
      actor: actorDoc, skill: null, skillTargetText,
      eligibleCount: filtered.length, round: director?.dCombat?.round ?? 0,
    });
    if (plan.mode === "random") {
      // GM-side roulette resolves the actual target; pre-compose none.
      targetUuids = [];
    } else if (plan.mode === "all") {
      targetUuids = filtered.map((e) => e.tokenUuid);
    } else {
      if (plan.capNote) ui.notifications?.info(plan.capNote);
      const result = await raceCancel(
        requestTargeting({
          director, eligible: filtered, mode: plan.mode, count: plan.count,
          titleText: plan.count > 1
            ? `Pick up to ${plan.count} targets for ${snap.name}'s Attack`
            : `Pick a target for ${snap.name}'s Attack`,
          externalCancel: cancelSentinel,
        }),
        cancelSentinel,
      );
      if (!result || !result.ok) {
        return { cancelled: true, reason: result?.cancelled ? "target-cancelled" : "target-failed" };
      }
      targetUuids = [...result.tokenUuids];
    }
  }

  return {
    cancelled: false,
    bundle: {
      command: "Attack",
      attackMode,
      targetUuids,
    },
  };
}

// NPC Attack — NPCs have no equipped weapon. They pick from Items with
// skill_type === "Attack" (the actor's `attack_list` itemContainer).
// Bundle shape: { command: "Attack", attackMode: "npc",
//                 npcAttackItemUuid, targetUuids }
// TARGET phase builds a pseudo-weapon from the picked Item so the rest
// of the Attack pipeline (COMPUTE / CONFIRM / RESOLVE) is unchanged.
async function composeAttackNpc({ director, snap, eligible, cancelSentinel }) {
  const attackItems = snap.npcAttackItems ?? [];
  if (!attackItems.length) {
    ui.notifications?.warn(`${snap.name} has no basic Attack available.`);
    return { cancelled: true, reason: "no npc attack" };
  }

  // Resolve actor doc — pickSkill needs it for cost / item-grant lookup.
  // For NPCs the cost is typically "-" but the picker still wants the
  // actor to derive resource pools.
  let actor = null;
  try { actor = await fromUuid(snap.actorUuid); } catch {}
  if (!actor) {
    ui.notifications?.warn(`Couldn't read ${snap.name}'s attacks.`);
    return { cancelled: true, reason: "no actor" };
  }

  // One attack → skip the picker, auto-select.
  // Multiple attacks (Bandit Wolf Fang+Claw, Berserker Heavy Axe+Grappled)
  // → spawn the skill-picker filtered to "attack" type.
  let pickedItemUuid = null;
  if (attackItems.length === 1) {
    pickedItemUuid = attackItems[0].uuid;
  } else {
    const pick = await raceCancel(
      pickSkill({
        director,
        actor,
        allowedSkillTypes: ["attack"],
        titleText: `Choose ${snap.name}'s Attack`,
        emptyMessage: `${snap.name} has no attack items.`,
        externalCancel: cancelSentinel,
      }),
      cancelSentinel,
    );
    if (!pick) return { cancelled: true, reason: "npc-attack-cancelled" };
    pickedItemUuid = pick.skillUuid;
  }

  // Resolve the attack item to read its targeting + range.
  let attackItem = null;
  try { attackItem = await fromUuid(pickedItemUuid); } catch {}
  if (!attackItem) {
    ui.notifications?.error("Picked attack could not be resolved.");
    return { cancelled: true, reason: "attack-uuid-fail" };
  }

  // Range gate (Melee can't hit Covered targets, RAW Core p.70). The
  // unified helper preserves `.excluded` so AE-driven exclusions
  // (Vanish etc.) keep rendering their overlay.
  const range = String(attackItem.system?.props?.skill_range ?? "Melee");
  const enemies = eligible?.enemies ?? [];
  const filtered = applyAttackRangeGate(enemies, { range });
  if (!filtered.length) {
    const isMelee = range.trim().toLowerCase() === "melee";
    ui.notifications?.warn(isMelee
      ? "All eligible enemies are Covered — pick a different action."
      : "No eligible enemy targets.");
    return { cancelled: true, reason: "no eligible targets" };
  }

  // Target count. NPC attacks read the same `skill_target` text as skills
  // ("One Creature", "Up to two creatures", "All Enemy", "One Random Creature", etc.).
  const skillTargetText = String(attackItem.system?.props?.skill_target ?? "").trim();
  // Single-source target plan (mode + count + ×T affordability cap). Random is
  // resolved GM-side via the roulette picker, so we pre-compose no target.
  const plan = resolveTargetPlan({
    actor, skill: attackItem, skillTargetText,
    eligibleCount: filtered.length, round: director?.dCombat?.round ?? 0,
  });
  let targetUuids;
  if (plan.mode === "random") {
    targetUuids = [];
  } else if (plan.mode === "all") {
    targetUuids = filtered.map((e) => e.tokenUuid);
  } else {
    if (plan.capNote) ui.notifications?.info(plan.capNote);
    const result = await raceCancel(
      requestTargeting({
        director,
        eligible: filtered,
        mode: plan.mode,
        count: plan.count,
        titleText: `Pick ${plan.count > 1 ? `up to ${plan.count} targets` : "a target"} for ${snap.name}'s ${attackItem.name}`,
        externalCancel: cancelSentinel,
      }),
      cancelSentinel,
    );
    if (!result || !result.ok) {
      return { cancelled: true, reason: result?.cancelled ? "target-cancelled" : "target-failed" };
    }
    targetUuids = [...result.tokenUuids];
  }

  return {
    cancelled: false,
    bundle: {
      command: "Attack",
      attackMode: "npc",
      npcAttackItemUuid: pickedItemUuid,
      targetUuids,
    },
  };
}

// ─── Study ───────────────────────────────────────────────────────────
//
// Pick one enemy creature. Open Check is rolled later on GM (INS + INS
// default). RAW Core p.74.
async function composeStudy({ director, snap, eligible, cancelSentinel }) {
  // Study guard (RAW Core p.74): tokens this actor already Studied this fight
  // (plumbed in via eligible.studiedTokenUuids — GM-side memory) are MOVED into
  // the picker's `.excluded` side-channel, so they render greyed-out + labeled
  // "Already studied" rather than being selectable. Same overlay path as the
  // Provoked / Vanish exclusions; applyStudyGuardExclusion preserves `.excluded`.
  const enemies = applyStudyGuardExclusion(eligible?.enemies ?? [], eligible?.studiedTokenUuids ?? []);
  const selectableCount = enemies.length;
  const excludedCount = Array.isArray(enemies.excluded) ? enemies.excluded.length : 0;
  if (!selectableCount) {
    ui.notifications?.warn(excludedCount
      ? "No new creatures to Study — you've already studied everyone here this fight."
      : "No creatures to Study.");
    return { cancelled: true, reason: "no targets" };
  }
  const result = await raceCancel(
    requestTargeting({
      director,
      eligible: enemies,
      mode: "exact",
      count: 1,
      titleText: `${snap.name}: pick a creature to Study`,
      externalCancel: cancelSentinel,
    }),
    cancelSentinel,
  );
  if (!result || !result.ok) {
    return { cancelled: true, reason: result?.cancelled ? "target-cancelled" : "target-failed" };
  }
  return {
    cancelled: false,
    bundle: {
      command: "Study",
      targetUuids: [...result.tokenUuids],
    },
  };
}

// ─── Hinder ──────────────────────────────────────────────────────────
//
// Pick one opponent. GM still picks the attribute pair + DL via
// pickAttributePair (RAW: "the Game Master will determine the relevant
// Attributes based on your description"). So composeHinder only commits
// the target — TARGET state's Hinder branch will skip the target picker
// when pre-populated and still spawn the attr-pair picker GM-side.
async function composeHinder({ director, snap, eligible, cancelSentinel }) {
  const enemies = eligible?.enemies ?? [];
  if (!enemies.length) {
    ui.notifications?.warn("No opponents to Hinder.");
    return { cancelled: true, reason: "no targets" };
  }
  const result = await raceCancel(
    requestTargeting({
      director,
      eligible: enemies,
      mode: "exact",
      count: 1,
      titleText: `${snap.name}: pick an opponent to Hinder`,
      externalCancel: cancelSentinel,
    }),
    cancelSentinel,
  );
  if (!result || !result.ok) {
    return { cancelled: true, reason: result?.cancelled ? "target-cancelled" : "target-failed" };
  }
  return {
    cancelled: false,
    bundle: {
      command: "Hinder",
      targetUuids: [...result.tokenUuids],
    },
  };
}

// ─── Skill / Spell ───────────────────────────────────────────────────
//
// 1) Pick a skill from the actor's roster (active or spell).
// 2) Read skill_target prop to decide self vs ally vs enemy + count.
// 3) Pick targets (or auto-fill for self / "all X").
//
// Bundle: { command: "Skill"|"Spell", skillUuid, sourceItemUuid, targetUuids }
//
// Authority steps that STAY on the GM side and run after the bundle
// arrives in TARGET:
//   - cost / affordability check (parseSkillCost + checkAffordable)
//   - Vismagus alt-cost prompt
//   - actionResult freeze
//
// If the player picks a skill they can't afford, the GM rejects with a
// toast and bounces to DECLARE — same behavior as a GM-only pick.
// Shared targeting resolver for skill-shaped action SOURCES (a skill Item OR a
// skill-shaped consumable). Reads `source.system.props.skill_target`, classifies
// the eligible pool, and runs the picker — the exact logic the Skill flow uses,
// so the Item action targets identically. Returns { cancelled, targetUuids,
// reason }. `actor` is the caster doc (for SL/HAS_SKILL formula identifiers in
// the target-count resolver). `eligible` = { allies, enemies }.
export async function resolveTargetsForSource({ director, snap, actor, eligible, source, cancelSentinel }) {
  // target_sequence skills do their multi-step picking at the TARGET phase
  // (state-handlers resolveActionTargets), NOT here in the compose pre-target.
  // Defer with empty targets so TARGET doesn't see pre-composed uuids and runs
  // the real sequence (giver → receiver) with cancel-to-menu.
  if (String(source?.system?.props?.target_sequence ?? "").trim()) {
    return { cancelled: false, targetUuids: [] };
  }
  // Preserve original case — skill_target may contain formula identifiers like
  // `HAS_SKILL_PILLAGE` matched case-sensitively. Category regex below is /i.
  const skillTargetText = String(source?.system?.props?.skill_target ?? "").trim();
  const isSelf = !skillTargetText || /^self$/i.test(skillTargetText);
  if (isSelf) {
    // Obvious target (self) — still enter the picker with the caster locked so
    // the player gets a confirm/cancel pass (no-consequence back-out).
    const selfEligible = [{ tokenUuid: snap.tokenUuid, tokenId: snap.tokenId, name: snap.name }];
    const r = await raceCancel(
      requestTargeting({
        director, eligible: selfEligible, mode: "exact", count: 1, lockSelection: true,
        titleText: `${snap.name}: ${source.name} (self)`, externalCancel: cancelSentinel,
      }),
      cancelSentinel,
    );
    if (!r || !r.ok) return { cancelled: true, reason: r?.cancelled ? "target-cancelled" : "target-failed" };
    return { cancelled: false, targetUuids: [...r.tokenUuids] };
  }

  // Target side: an EXPLICIT side in skill_target wins (creature = either side;
  // enemy; ally). The action-intent heuristic is only a TIEBREAKER for
  // side-agnostic text — it must NOT override an explicit "Enemy"/"Ally". Mirrors
  // resolveActionTargets (state-handlers) exactly.
  const intent = classifyActionIntent(source);
  const wantsCreature = /creature|creatures/i.test(skillTargetText);
  const wantsEnemy    = /enem/i.test(skillTargetText);
  const wantsAllyText = /\ball(?:y|ies)\b/i.test(skillTargetText);
  const side = wantsCreature ? "any"
    : wantsEnemy    ? "enemy"
    : wantsAllyText ? "ally"
    : (intent === "aid" ? "ally" : "enemy");
  let targetList = side === "any"
    ? [...(eligible?.allies ?? []), ...(eligible?.enemies ?? [])]
    : (side === "ally" ? (eligible?.allies ?? []) : (eligible?.enemies ?? []));
  const categoryLabel = side === "any" ? "creatures" : (side === "ally" ? "allies" : "enemies");

  // Optional per-candidate eligibility filter (skill prop `target_eligibility`):
  // a formula evaluated against EACH candidate's own actor; keep only the truthy
  // ones. Restricts WHO the picker offers, so an ineligible creature can't be
  // selected at all (vs an effect-level guard that fizzles after the fact).
  // Same predicate language as the effect-level targeting `target_filter`
  // (skill-targeting.js) — named differently because that one is an effect_table
  // ROW column; this is a top-level _Skill Template column ("Eligibility Filter").
  // First user: Love Potion → Humanoid non-Champions only
  // ("SPECIES_IS_HUMANOID == 1 && RANK_IS_CHAMPION == 0").
  const targetFilter = String(source?.system?.props?.target_eligibility ?? "").trim();
  if (targetFilter && targetList.length) {
    const kept = [];
    for (const cand of targetList) {
      let candActor = null;
      try { candActor = (await fromUuid(cand.tokenUuid))?.actor ?? null; } catch { /* unresolved → drop */ }
      // Inject the CASTER as the payload source so caster-relative per-candidate
      // predicates resolve (e.g. BONDED_TO_SOURCE — "this ally is Bonded to you").
      // Caster-agnostic checks (SPECIES_IS_*, RANK_IS_*) ignore payload, so this
      // is backward-compatible with the existing Love Potion filter.
      const r = buildSkillResolver({ actor: candActor, payload: { sourceActorUuid: actor?.uuid ?? snap?.actorUuid ?? null }, skill: source, round: director?.dCombat?.round ?? 0 });
      if (Number(evaluateFormula(targetFilter, r, 0)) > 0) kept.push(cand);
    }
    targetList = kept;
  }

  if (!targetList.length) {
    ui.notifications?.warn(`No eligible ${categoryLabel} for ${source.name}.`);
    return { cancelled: true, reason: "no targets" };
  }

  // Single-source target plan (mode + count + ×T affordability cap), shared with
  // the GM-side resolveActionTargets. Random → GM-side roulette (player sends
  // empty). "All" → enter the picker with every eligible target locked, so the
  // player gets a confirm/cancel pass before committing.
  const plan = resolveTargetPlan({
    actor, skill: source, skillTargetText,
    eligibleCount: targetList.length, round: director?.dCombat?.round ?? 0,
  });
  if (plan.mode === "random") return { cancelled: false, targetUuids: [] };
  if (plan.mode === "all") {
    const r = await raceCancel(
      requestTargeting({
        director, eligible: targetList, mode: "exact", count: targetList.length, lockSelection: true,
        titleText: `${snap.name}: ${source.name} (all ${categoryLabel})`, externalCancel: cancelSentinel,
      }),
      cancelSentinel,
    );
    if (!r || !r.ok) return { cancelled: true, reason: r?.cancelled ? "target-cancelled" : "target-failed" };
    return { cancelled: false, targetUuids: [...r.tokenUuids] };
  }

  if (plan.capNote) ui.notifications?.info(plan.capNote);
  const result = await raceCancel(
    requestTargeting({
      director,
      eligible: targetList,
      mode: plan.mode,
      count: plan.count,
      titleText: `${snap.name}: pick target${plan.count > 1 ? "s" : ""} for ${source.name}`,
      externalCancel: cancelSentinel,
    }),
    cancelSentinel,
  );
  if (!result || !result.ok) {
    return { cancelled: true, reason: result?.cancelled ? "target-cancelled" : "target-failed" };
  }
  return { cancelled: false, targetUuids: [...result.tokenUuids] };
}

// ─── Item ────────────────────────────────────────────────────────────
//
// Item is a skill-shaped action: pick the source (a consumable to Use or a
// recipe to Create) via pickItem — Item's "pickSkill" — then run the SHARED
// targeting (resolveTargetsForSource) off the consumable's skill_target. The
// returned bundle carries the source + use/create cost + targets; the GM's
// TARGET branch shapes the standard actionResult and everything downstream is
// the one pipeline. No Item-specific path after selection.
async function composeItem({ director, snap, eligible, cancelSentinel }) {
  let actor = null;
  try { actor = await fromUuid(snap.actorUuid); } catch {}
  if (!actor) {
    ui.notifications?.warn("Couldn't read your inventory.");
    return { cancelled: true, reason: "no actor" };
  }

  // Step 1: source picker (the item menu). A `disable_action_intent` filter on
  // the actor (Charm/Domination) DIMS + labels consumables with no allowed use
  // (shown, not hidden). Map intent→reason for the dimmed-row stamp.
  const excludeIntents = new Map((snap?.disabledActionIntents ?? []).map((d) => [d.intent, d.reason]));
  const pick = await raceCancel(
    pickItem({ director, actor, externalCancel: cancelSentinel, excludeIntents }),
    cancelSentinel,
  );
  if (!pick) return { cancelled: true, reason: "item-cancelled" };

  // Step 2: resolve the source item to read its skill_target for targeting.
  let source = null;
  try { source = await fromUuid(pick.uuid); } catch {}
  if (!source) {
    ui.notifications?.error("Chosen item could not be resolved.");
    return { cancelled: true, reason: "item-uuid-fail" };
  }

  // Step 2b: resolve the consumable's LINKED activation skill (item_skill_active).
  // That skill carries the real skill_target / intent — the consumable is just
  // the carrier. Target off it. Fall back to the item itself for already-skill-
  // shaped consumables that authored their effect onto the item (no link).
  let targetingSource = source;
  let linkedSkillUuid = null;
  try {
    linkedSkillUuid = getLinkedSkillUuid(source);
    if (linkedSkillUuid) {
      const linked = await fromUuid(linkedSkillUuid).catch(() => null);
      if (linked) targetingSource = linked;
      else warn(`composeItem: linked skill ${linkedSkillUuid} not resolvable; targeting off item`);
    }
  } catch (e) { warn("composeItem: linked-skill resolve threw", e); }

  // Step 3: shared targeting — same code Skill uses, off the activation skill.
  const tr = await resolveTargetsForSource({ director, snap, actor, eligible, source: targetingSource, cancelSentinel });
  if (tr.cancelled) return { cancelled: true, reason: tr.reason ?? "target-cancelled" };

  return {
    cancelled: false,
    bundle: {
      command: "Item",
      skillUuid: pick.uuid,          // the consumable IS the picked source
      sourceItemUuid: pick.uuid,
      linkedSkillUuid,               // the activation skill (null = item-shaped)
      itemMode: pick.mode,           // "use" | "create"
      itemKey: pick.key,
      itemCost: pick.cost,
      targetUuids: tr.targetUuids,
    },
  };
}

async function composeSkill({ director, snap, eligible, cancelSentinel, isSpell }) {
  // Resolve actor doc. Player has read access to their own PC's data.
  let actor = null;
  try { actor = await fromUuid(snap.actorUuid); } catch {}
  if (!actor) {
    ui.notifications?.warn(`Couldn't read your ${isSpell ? "spells" : "skills"}.`);
    return { cancelled: true, reason: "no actor" };
  }

  // Step 1: skill picker. A `disable_action_intent` filter on the actor (e.g.
  // Charm/Domination) DIMS + labels aid/neutral entries (shown, not hidden).
  // Map intent→reason so the picker can stamp the source-AE name on dimmed rows.
  const excludeIntents = new Map((snap?.disabledActionIntents ?? []).map((d) => [d.intent, d.reason]));
  // Free-action skill allow-list (Counter Pass → only Passes): when this Skill
  // compose is running inside a free action whose grant carries allowedSkillRefs,
  // restrict the menu to those skills (matched by name OR uuid). Null on a normal
  // turn or an unrestricted free action.
  const grant = freeActions.get(snap.actorId);
  const allowedRefs = grant?.allowedSkillRefs ?? null;
  // Free-action MP cap (Acceleration → spells ≤ 10 MP). Spell-only: a Skill/Active
  // free action carries no spell-cost cap. Null on a normal turn or uncapped grant.
  const maxMpCost = isSpell ? (grant?.maxMpCost ?? null) : null;
  const pick = await raceCancel(
    pickSkill({
      director,
      actor,
      allowedSkillTypes: isSpell ? ["spell"] : ["active"],
      titleText: isSpell ? "Choose a Spell" : "Choose a Skill",
      emptyMessage: isSpell
        ? `${actor.name ?? "Combatant"} knows no spells.`
        : `${actor.name ?? "Combatant"} has no Active skills available.`,
      externalCancel: cancelSentinel,
      excludeIntents,
      allowedRefs,
      maxMpCost,
    }),
    cancelSentinel,
  );
  if (!pick) {
    return { cancelled: true, reason: "skill-cancelled" };
  }

  // Step 2: resolve the skill doc — needed to read skill_target.
  let skill = null;
  try { skill = await fromUuid(pick.skillUuid); } catch {}
  if (!skill) {
    ui.notifications?.error("Picked skill could not be resolved.");
    return { cancelled: true, reason: "skill-uuid-fail" };
  }

  // Step 3: targeting — shared with the Item action via resolveTargetsForSource
  // (classify skill_target → eligible pool → picker). Identical behavior to the
  // prior inline block, now reused so Item targets exactly like Skill.
  const tr = await resolveTargetsForSource({ director, snap, actor, eligible, source: skill, cancelSentinel });
  if (tr.cancelled) {
    return { cancelled: true, reason: tr.reason ?? "target-cancelled" };
  }
  const targetUuids = tr.targetUuids;

  return {
    cancelled: false,
    bundle: {
      command: isSpell ? "Spell" : "Skill",
      skillUuid: pick.skillUuid,
      sourceItemUuid: pick.sourceItemUuid ?? null,
      targetUuids,
    },
  };
}

// ─── Guard ───────────────────────────────────────────────────────────
//
// Optional Cover ally pick — the guarder always gets Resistance +
// Opposed Check +2 to themselves (handled in COMPUTE); if they also
// pick an ally, that ally gets the Cover effect. RAW Core p.70.
//
// "Skip Cover" → bundle.coverTokenUuid = null (guard self only).
// Picked ally → bundle.coverTokenUuid = ally's tokenUuid.
async function composeGuard({ director, snap, eligible, cancelSentinel }) {
  const allAllies = eligible?.allies ?? [];
  const allies = allAllies.filter((a) => a.tokenUuid !== snap.tokenUuid);
  // When the guarder is the ONLY creature on their side, there's no ally to
  // Cover — but rather than silently auto-skipping the targeting step (the old
  // requestTargeting empty-eligible shortcut), still SHOW a targeting overlay
  // with the guarder ringed + locked, so the player gets a visible confirm pass
  // for the self-only Guard. A self pick can never be a Cover target → null.
  const selfOnly = allies.length === 0;
  const selfEntry = allAllies.find((a) => a.tokenUuid === snap.tokenUuid)
    ?? { tokenUuid: snap.tokenUuid, tokenId: snap.tokenId, name: snap.name };
  const result = await raceCancel(
    requestTargeting({
      director,
      eligible: selfOnly ? [selfEntry] : allies,
      mode: "exact",
      count: 1,
      lockSelection: selfOnly,
      titleText: selfOnly
        ? `${snap.name}: Guard (no ally to Cover)`
        : `${snap.name}: pick an ally to Cover (optional)`,
      cancelLabel: "Cancel Guard",
      secondaryAction: { label: "Skip Cover", value: "skip" },
      externalCancel: cancelSentinel,
    }),
    cancelSentinel,
  );
  if (!result || !result.ok) {
    return { cancelled: true, reason: result?.cancelled ? "target-cancelled" : "target-failed" };
  }
  const picked = (result.skipped || result.tokenUuids.length === 0)
    ? null
    : result.tokenUuids[0];
  // Self is never a Cover target — a self/locked confirm means self-only Guard.
  const coverTokenUuid = (picked && picked !== snap.tokenUuid) ? picked : null;
  return {
    cancelled: false,
    bundle: {
      command: "Guard",
      coverTokenUuid,
    },
  };
}

// ─── Ultima (Boss/Villain) ───────────────────────────────────────────
//
// One picker over the three Ultima actions (Domination / Escape /
// Recovery) — the boss-side twin of the Skill picker. Rows come pre-baked
// from buildUltimaMenuSpec (costs + per-row shortfall reasons); a disabled
// row stays visible with its reason appended so the GM can see WHY (mirrors
// the dimmed-entry style of the intent-filtered skill picker).
async function composeUltima({ director, snap, ultimaSpec, cancelSentinel }) {
  const rows = ultimaSpec?.rows ?? [];
  if (!rows.length) return { cancelled: true, reason: "no ultima spec" };
  const picked = await raceCancel(
    pickFromList({
      director,
      title: "Ultima Actions",
      subtitle: `${snap.name} • Ultima Points: ${ultimaSpec.ultimaPoints} • Dominance: ${ultimaSpec.dominancePoints}`,
      width: 420,
      options: rows.map((r) => ({
        value: r.command,
        primary: r.command,
        secondary: r.disabledReason
          ? `${r.desc} <span style="color:#c81010; font-weight:800;">— ${r.disabledReason}</span>`
          : r.desc,
        imageUrl: r.icon,
        badge: r.cost,
        badgeTone: r.command === "Domination" ? "danger" : undefined,
        disabled: !!r.disabledReason,
      })),
      externalCancel: cancelSentinel,
    }),
    cancelSentinel,
  );
  if (!picked) return { cancelled: true, reason: "ultima-cancelled" };
  return { cancelled: false, bundle: { command: picked } };
}
