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
import { classifyActionIntent } from "./skill-intent.js";
import { buildSkillResolver } from "./skill-formulas.js";
import { extractTargetCountFromText } from "./state-handlers.js";
import { freeActions } from "./free-actions.js";

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
    const command = await waitForOctopathClick({
      director, token, combatId, actorUuid, cancelSentinel,
      enabledLabels: grant?.enabledLabels ?? null,
      budgetText: grant ? `${grant.sourceLabel ?? "Free"} Free Action` : null,
    });
    if (externallyCancelled || command === null) break;

    log(`composeAction: command picked = ${command}`);

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
        // Item card has inline use/create lists rendered by the action
        // card itself — no pre-card picker needed. Pass through as a
        // command-only bundle; GM's Item branch builds the list and the
        // player interacts with the mirrored card.
        return { cancelled: false, bundle: { command, _commandOnly: true } };
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
function waitForOctopathClick({ director, token, combatId, actorUuid, cancelSentinel, enabledLabels = null, budgetText = null }) {
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
export function registerPlayerComposeActionHandler(channel) {
  // Track the current chain's cancel token + a "session id" so that a
  // MENU_OPEN arriving while a prior chain is still running can cancel
  // and replace it cleanly.
  let active = null; // { token, sessionId }

  const offOpen = channel.onMenuOpen(async (menuSpec) => {
    if (!menuSpec || menuSpec.kind !== "compose-action") return;
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
  const hasMain = !!snap.weapon;
  const hasOff = !!snap.offWeapon;
  if (!hasMain && !hasOff) {
    ui.notifications?.warn(`${snap.name} has no usable weapon.`);
    return { cancelled: true, reason: "no weapon" };
  }

  // Weapon mode
  let attackMode = "main";
  if (hasMain && hasOff) {
    const picked = await raceCancel(
      pickWeaponMode({
        director,
        mainWeapon: snap.weapon,
        offWeapon: snap.offWeapon,
        allowTwoWeapon: !!snap.canTwoWeaponFight,
        // Forward the cancel sentinel so the picker overlay tears
        // itself down if the race resolves against us.
        externalCancel: cancelSentinel,
      }),
      cancelSentinel,
    );
    if (!picked) return { cancelled: true, reason: "weapon-mode-cancelled" };
    attackMode = picked;
  } else if (hasOff && !hasMain) {
    attackMode = "off";
  }

  // Target pick. We deliberately picks only ONE target for the FIRST
  // pass — multi-pass attacks (two-weapon) will re-enter TARGET on GM
  // for pass 2 (FSM-driven; player picks via per-pick lag for the second
  // pass — that's an acceptable v1 cost since two-weapon is uncommon).
  const enemies = eligible?.enemies ?? [];
  if (!enemies.length) {
    ui.notifications?.warn("No eligible enemy targets on this scene.");
    return { cancelled: true, reason: "no targets" };
  }

  // Determine the current weapon's range for Covered filtering. RAW
  // Core p.70 — Covered creatures can't be targeted by melee.
  const currentWeapon = (attackMode === "off" || attackMode === "two-weapon-off-first")
    ? snap.offWeapon
    : snap.weapon;
  const isMelee = String(currentWeapon?.range ?? "").trim().toLowerCase() === "melee";
  const filtered = isMelee
    ? enemies.filter((e) => !(e.conditions ?? []).includes("Covered"))
    : enemies;
  if (!filtered.length) {
    ui.notifications?.warn(isMelee
      ? "All eligible enemies are Covered — pick a different action."
      : "No eligible enemy targets.");
    return { cancelled: true, reason: "no eligible targets" };
  }

  const result = await raceCancel(
    requestTargeting({
      director,
      eligible: filtered,
      mode: "exact",
      count: 1,
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

  return {
    cancelled: false,
    bundle: {
      command: "Attack",
      attackMode,
      targetUuids: [...result.tokenUuids],
    },
  };
}

// ─── Study ───────────────────────────────────────────────────────────
//
// Pick one enemy creature. Open Check is rolled later on GM (INS + INS
// default). RAW Core p.74.
async function composeStudy({ director, snap, eligible, cancelSentinel }) {
  const enemies = eligible?.enemies ?? [];
  if (!enemies.length) {
    ui.notifications?.warn("No creatures to Study.");
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
async function composeSkill({ director, snap, eligible, cancelSentinel, isSpell }) {
  // Resolve actor doc. Player has read access to their own PC's data.
  let actor = null;
  try { actor = await fromUuid(snap.actorUuid); } catch {}
  if (!actor) {
    ui.notifications?.warn(`Couldn't read your ${isSpell ? "spells" : "skills"}.`);
    return { cancelled: true, reason: "no actor" };
  }

  // Step 1: skill picker.
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

  // Step 3: classify targeting.
  const skillTargetText = String(skill.system?.props?.skill_target ?? "").trim().toLowerCase();
  const isSelf = !skillTargetText || /^self$/.test(skillTargetText);

  let targetUuids = [];
  if (isSelf) {
    targetUuids = [snap.tokenUuid];
  } else {
    // Same category rule the GM uses: ally if the skill_target text
    // says ally/allies OR the action intent classifies as "aid" (Heal,
    // Aura, Reinforce, Cleanse, etc. — skills whose text doesn't
    // mention "ally" but are obviously beneficial). Without this,
    // Heal-type spells resolve to "enemy" since their skill_target
    // is usually "One creature" not "One ally".
    const intent = classifyActionIntent(skill);
    const wantsAlly = /ally|allies/i.test(skillTargetText) || intent === "aid";
    const targetList = wantsAlly ? (eligible?.allies ?? []) : (eligible?.enemies ?? []);
    if (!targetList.length) {
      ui.notifications?.warn(`No eligible ${wantsAlly ? "allies" : "enemies"} on this scene.`);
      return { cancelled: true, reason: "no targets" };
    }

    // Mode + count from text. Same resolver the GM uses — identifiers
    // that need only `actor` + `skill` (SL, CHAR_LEVEL, HAS_SKILL_<NAME>,
    // BOND_*) evaluate correctly player-side; payload-dependent ones
    // (HR, HIT_COUNT, etc.) fold to 0 since no payload exists yet.
    // Enables cross-skill gates like Soul Steal × Pillage:
    //   skill_target: "Up to (1 + 98 * HAS_SKILL_PILLAGE) creatures".
    const targetCountResolver = buildSkillResolver({
      actor,
      payload: null,
      skill,
      round: director.dCombat?.round ?? 0,
    });
    let mode = "exact";
    let count = 1;
    if (/\ball\b/i.test(skillTargetText)) {
      mode = "all";
      count = targetList.length;
    } else if (/up\s+to/i.test(skillTargetText)) {
      mode = "up_to";
      count = extractTargetCountFromText(skillTargetText, { isUpTo: true, resolver: targetCountResolver });
    } else {
      count = extractTargetCountFromText(skillTargetText, { isUpTo: false, resolver: targetCountResolver });
    }

    if (mode === "all") {
      targetUuids = targetList.map((e) => e.tokenUuid);
    } else {
      const result = await raceCancel(
        requestTargeting({
          director,
          eligible: targetList,
          mode,
          count,
          titleText: `${snap.name}: pick target${count > 1 ? "s" : ""} for ${skill.name}`,
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
  const allies = (eligible?.allies ?? []).filter((a) => a.tokenUuid !== snap.tokenUuid);
  // If no allies on scene, requestTargeting auto-skips via secondaryAction
  // and returns { ok:true, skipped:true } — the player still gets the
  // self-only Guard.
  const result = await raceCancel(
    requestTargeting({
      director,
      eligible: allies,
      mode: "exact",
      count: 1,
      titleText: `${snap.name}: pick an ally to Cover (optional)`,
      cancelLabel: "Cancel Guard",
      secondaryAction: { label: "Skip Cover", value: "skip" },
      externalCancel: cancelSentinel,
    }),
    cancelSentinel,
  );
  if (!result || !result.ok) {
    return { cancelled: true, reason: result?.cancelled ? "target-cancelled" : "target-failed" };
  }
  const coverTokenUuid = (result.skipped || result.tokenUuids.length === 0)
    ? null
    : result.tokenUuids[0];
  return {
    cancelled: false,
    bundle: {
      command: "Guard",
      coverTokenUuid,
    },
  };
}
