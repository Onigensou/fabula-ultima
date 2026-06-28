// Battle Director — reload survival + GM rewind tool.
//
// Two distinct persistence layers live in this file, both keyed off
// scene flags under `fabula-ultima-companion`:
//
//   1. `directorState` (single object) — reload survival. Holds JUST the
//      dCombat snapshot. Read on world `ready` by director-boot to re-
//      mount the FSM at TURN_START (or TURN_END if RESOLVE had committed).
//      Actor docs persist in Foundry on their own; no per-actor data here.
//
//   2. `directorHistory` (rolling array, max 20) — rewind tool. Each
//      entry is `directorState` PLUS per-combatant actor snapshots
//      (props, effects, itemStates, deletedItemsLog). Lets the GM jump
//      back to any of the last 50 committed states. Design locked in
//      [[director-rewind-tool-plan]] — Tier 2 full snapshot, EXACT-match
//      restore policy, deleted consumables RECREATABLE via the per-save
//      deletedItemsLog (populated by a preDeleteItem hook).
//
// Save / write checkpoints (same sites feed both flags):
//   - PrepState.onEnter end (after `_setDirectorCombat`)
//   - TurnStart.onEnter end (after picker + Guard releases)
//   - Confirm.onEnter end   (per-action checkpoint; persists `pendingAction`
//                            so an F5 mid-card re-spawns the same card on
//                            resume instead of dumping the GM back to the
//                            action picker)
//   - Resolve.onEnter end   (after damage/AE/equipment writes; flips
//                            `dCombat.currentTurnResolved = true`)
//   - TurnEnd.onEnter       (after `dCombat.nextTurn`)
//
// Mid-action states (DECLARE / TARGET / COMPUTE) deliberately don't save —
// they're all cancellable back to DECLARE without committing. CONFIRM is
// the exception: dice are already rolled and we want F5 mid-card to land
// the GM right back on the card via the `pendingAction` field. The first
// thing CONFIRM does after its `postActionCard` promise resolves is write
// a no-history save with `pendingAction: null` so the survival flag stops
// pointing at a stale card the moment the GM clicks Confirm or Cancel.
//
// Clear policy (both flags):
//   - `director-boot.stop()` calls `clearAllDirectorStateFlags`
//   - `[Macro] [BattleEnd_ Cleanup].js` unsets both flags defensively
//   - `clearAllDirectorStateFlags` clears BOTH state + history together.

import { log, warn } from "./logger.js";
import { RESOURCE_REGISTRY } from "./resources.js";
import { DirectorCombat, DirectorCombatant } from "./director-combat.js";
import { freeActions } from "./free-actions.js";
import { freeActionQueue } from "./free-action-queue.js";
import {
  serializeStack,
  rehydrateStack,
  peekTop,
  topIsFreeAction,
  topIsSrwDetour,
  migrateFreeActionContextToStack,
  stackDepth,
} from "./continuation-stack.js";

const FLAG_NS = "fabula-ultima-companion";
const FLAG_KEY = "directorState";       // single-object reload-survival flag
const HISTORY_KEY = "directorHistory";  // rolling-20 rewind history flag
// SCHEMA_VERSION 2: replaces v1's `freeActionContext.flags` with a
// top-level `continuationStack` array. Migration auto-synthesizes
// equivalent frames from v1's flag bag (see hydrateContinuationState).
const SCHEMA_VERSION = 2;
const MAX_HISTORY = 50;

// ── Item deletion tracker (rewind tool) ──────────────────────────────
//
// The rewind tool needs to recreate items that were deleted between two
// snapshots (e.g. a Phoenix Down used up at HP 0). We can't read an
// item's `toObject()` after it's deleted, so we capture the full data
// just before Foundry deletes the doc, via a `preDeleteItem` hook owned
// by the director's hook registry (auto-disposed on `director.stop()`).
//
// The captured toObjects sit in this module-level buffer keyed by actor
// uuid until the next `saveDirectorState` call drains them into the new
// snapshot's `deletedItemsLog`. Multiple deletions between two saves all
// land in the same history entry.

const pendingDeletedItems = new Map();  // actorUuid → ItemData[]

// Install the preDeleteItem hook. Called from PrepState.onEnter (fresh
// start) and from resumeFromSavedState (reload + rewind paths) alongside
// installGuardHpWatcher. GM-only — player clients don't author item
// deletes anyway, and the rewind tool itself is GM-only.
export function installItemDeletionTracker(director) {
  if (!game.user?.isGM) return;
  director.hooks.on("preDeleteItem", (item /*, options, userId */) => {
    try {
      const actor = item?.parent;
      // Only track Item documents owned by Actor documents — there are
      // other "Item" types (folder children, compendia) we don't care
      // about, and the parent guard rejects unowned items.
      if (!actor || actor.documentName !== "Actor" || !actor.uuid) return;
      let arr = pendingDeletedItems.get(actor.uuid);
      if (!arr) { arr = []; pendingDeletedItems.set(actor.uuid, arr); }
      arr.push(item.toObject());
    } catch (e) {
      warn("item-deletion-tracker hook threw", e);
    }
  }, { label: "rewind-item-deletion-tracker" });
  log("Item deletion tracker installed (rewind tool)");
}

function consumePendingDeletions(actorUuid) {
  const arr = pendingDeletedItems.get(actorUuid) ?? [];
  pendingDeletedItems.delete(actorUuid);
  return arr;
}

// ── Free-action + continuation persistence (F5 mid-window survival) ───
//
// Three sources of in-memory state must round-trip to the scene flag
// so a reload mid-window (player picked High Speed, then F5'd before /
// during / after their free Attack) restores the FSM cleanly:
//
//   1. `freeActions` singleton — Map<actorId, grant>. COMPUTE handlers
//      read this for checkBonus / damageBonus / enabledLabels.
//   2. `freeActionQueue` — FIFO of pending FreeActionRequests. FAW
//      drains.
//   3. `continuationStack` — ordered list of suspended sub-flows
//      (free actions, SRW detours, future mid-action interrupts).
//      Replaces the v1 "flag bag" (`_srwFinalTarget`,
//      `_postFreeActionTarget`, `_freeActionPopped`, `_savedTurnSnapshot`,
//      `_savedActionResult`, `freeActionMode`, plus the destructive
//      `standaloneAfter` mutation). Each frame captures (a) the FSM
//      state to resume at on pop and (b) a snapshot of ctx fields the
//      sub-flow mutates. See [[continuation-stack]].
//
// Capture is conditional: only emit a block when something is in flight
// so regular saves stay small.

// Capture all three sources into a saved-state-shaped object. Returns
// null when nothing is in flight.
function captureRuntimeContinuation(director) {
  const ctx = director?.ctx ?? {};
  const reg   = freeActions.snapshot();
  const queue = freeActionQueue.snapshot();
  const stack = serializeStack(ctx);
  // standalone* are SRW-loop ctx fields. They're orthogonal to the
  // stack itself (SRW reads them on entry; frame snapshots restore
  // them on pop). Persisted at the top level rather than inside the
  // stack so SRW's first-entry read works cleanly.
  const standalone = {};
  if (ctx.standaloneTrigger != null) standalone.standaloneTrigger = ctx.standaloneTrigger;
  if (ctx.standaloneAfter != null)   standalone.standaloneAfter   = ctx.standaloneAfter;
  if (ctx.standalonePayload != null) standalone.standalonePayload = ctx.standalonePayload;
  const hasRegistry  = Object.keys(reg).length > 0;
  const hasQueue     = queue.length > 0;
  const hasStack     = stack.length > 0;
  const hasStandalone = Object.keys(standalone).length > 0;
  if (!hasRegistry && !hasQueue && !hasStack && !hasStandalone) return null;
  return {
    registry: reg,
    queue,
    continuationStack: stack,
    standalone,
  };
}

// Rehydrate all three sources. v2 saves carry `runtimeContinuation`
// directly; v1 saves still carry the old `freeActionContext` shape
// and we synthesize equivalent stack frames via the migration helper.
// Returns a summary used by the director-boot resume router.
export function hydrateContinuationState(director, state) {
  const ctx = director?.ctx ?? {};
  try {
    // Clear-then-restore pattern so leftover registry / queue / stack
    // from a previous battle don't leak through. Each section is
    // restored only if the saved blob has it; absent ones leave the
    // in-memory state empty.
    freeActions.clearAll();
    freeActionQueue.clear();

    // v2 shape — runtimeContinuation block at the top level.
    const rc = state?.runtimeContinuation;
    if (rc) {
      for (const [actorId, grant] of Object.entries(rc.registry ?? {})) {
        freeActions.set(actorId, grant);
      }
      for (const req of (rc.queue ?? [])) {
        freeActionQueue.enqueue(req);
      }
      rehydrateStack(director, rc.continuationStack ?? []);
      const sa = rc.standalone ?? {};
      if (sa.standaloneTrigger != null) ctx.standaloneTrigger = sa.standaloneTrigger;
      if (sa.standaloneAfter != null)   ctx.standaloneAfter   = sa.standaloneAfter;
      if (sa.standalonePayload != null) ctx.standalonePayload = sa.standalonePayload;
      const summary = {
        restored: true,
        schemaVersion: 2,
        queueSize: (rc.queue ?? []).length,
        registrySize: Object.keys(rc.registry ?? {}).length,
        stackDepth: stackDepth(ctx),
        topReason: peekTop(ctx)?.reason ?? null,
        topResumeAt: peekTop(ctx)?.resumeAt ?? null,
      };
      log(`hydrateContinuationState (v2): registry=${summary.registrySize}, queue=${summary.queueSize}, stack=${summary.stackDepth}${summary.topReason ? ` (top "${summary.topReason}" → ${summary.topResumeAt})` : ""}`);
      return summary;
    }

    // v1 shape — freeActionContext with a flag bag. Migrate to stack.
    const fac = state?.freeActionContext;
    if (fac) {
      for (const [actorId, grant] of Object.entries(fac.registry ?? {})) {
        freeActions.set(actorId, grant);
      }
      for (const req of (fac.queue ?? [])) {
        freeActionQueue.enqueue(req);
      }
      // Restore standalone* fields BEFORE migration so the synthesized
      // frame's snapshot can correctly capture them.
      const f = fac.flags ?? {};
      if (f.standaloneTrigger != null) ctx.standaloneTrigger = f.standaloneTrigger;
      if (f.standaloneAfter != null)   ctx.standaloneAfter   = f.standaloneAfter;
      if (f.standalonePayload != null) ctx.standalonePayload = f.standalonePayload;
      // Migration: build the stack from legacy flags.
      const migrated = migrateFreeActionContextToStack(director, fac);
      const summary = {
        restored: true,
        schemaVersion: 1,
        migrated,
        queueSize: (fac.queue ?? []).length,
        registrySize: Object.keys(fac.registry ?? {}).length,
        stackDepth: stackDepth(ctx),
        topReason: peekTop(ctx)?.reason ?? null,
        topResumeAt: peekTop(ctx)?.resumeAt ?? null,
      };
      log(`hydrateContinuationState (v1 → migrated): registry=${summary.registrySize}, queue=${summary.queueSize}, stack=${summary.stackDepth}${summary.topReason ? ` (top "${summary.topReason}" → ${summary.topResumeAt})` : ""}`);
      return summary;
    }

    // Neither v1 nor v2 carry continuation state — clean resume.
    rehydrateStack(director, []);
    return { restored: false, schemaVersion: state?.schemaVersion ?? null };
  } catch (e) {
    warn("hydrateContinuationState threw", e);
    return { restored: false, error: String(e?.message ?? e) };
  }
}

// Back-compat alias — director-boot.js imports under both names during
// the rename. Once all callers update, drop the old one.
export const hydrateFreeActionContext = hydrateContinuationState;

// ── Save ────────────────────────────────────────────────────────────────

// Persist the director's current dCombat snapshot to the battle scene's
// flag. Idempotent on repeat calls — Foundry's setFlag overwrites cleanly.
// Async but non-blocking: state handlers fire-and-forget this call (any
// throw is logged but doesn't abort the FSM transition).
//
// Options:
//   - `label`:        short display string for the rewind history list
//                     (e.g. "Round 3 · Hina · Turn Start"). Empty by default.
//   - `description`:  optional detail line (e.g. "Hina attacked Boss for 12 dmg").
//   - `skipHistory`:  if true, only writes directorState (not history).
//                     Useful for diagnostic / out-of-band saves we don't want
//                     to clutter the rewind list.
export async function saveDirectorState(director, opts = {}) {
  const dc = director?.dCombat;
  if (!dc?.scene) {
    log("persistence.save: no dCombat.scene, skipping");
    return;
  }
  // Only persist while combat is live. After dCombat.end() the flag is
  // about to be cleared by stop() anyway.
  if (dc.ended) {
    log("persistence.save: dCombat ended, skipping");
    return;
  }
  // History-push deduplication lives in pushToHistory (fingerprint
  // match against latest entry). The older `_suppressNextHistoryPush`
  // one-shot flag was removed — it suppressed the FIRST save after
  // any rewind regardless of whether the snapshot it would generate
  // matched the rewind target, losing entries like a fresh
  // "Round 1 · Hina · Turn Start" after rewinding to "Battle Start".
  // Fingerprint dedup handles same-state collisions cleanly.
  // pendingAction lives at the top level of the saved state so the
  // resume path can read it without diving into dCombat. Set by
  // Confirm.onEnter (with `{actionResult, ctx}`) and cleared by every
  // other save site (which omits opts.pendingAction → defaults to null).
  // null means "no in-progress action card to resume into" — survival
  // falls back to the standard TURN_START / TURN_END branch.
  const pendingAction = (opts.pendingAction === undefined)
    ? null
    : (opts.pendingAction ?? null);

  // Runtime continuation — registry + queue + continuation stack +
  // standalone* fields. Captured only when something is in flight so
  // regular saves stay clean (no empty blob on every TURN_START).
  // Restored on resume by hydrateContinuationState before any
  // state-transition routing. See [[free-actions]] /
  // [[free-action-queue]] / [[continuation-stack]] for the shapes.
  const runtimeContinuation = captureRuntimeContinuation(director);

  const state = {
    schemaVersion: SCHEMA_VERSION,
    savedAt: Date.now(),
    sourceSceneId: dc.sourceSceneId ?? null,
    pendingAction,
    ...(runtimeContinuation ? { runtimeContinuation } : {}),
    // Stash the original PREP payload for diagnostic purposes — RAW
    // resume doesn't re-run PREP (tokens are already on the scene) but
    // keeping the payload makes it possible to inspect what battle this
    // was, and gives a recovery path if reconstruction later finds a
    // bad gap (re-run PREP with the same payload).
    payload: director.ctx?.payload ?? null,
    dCombat: {
      id: dc.id,
      sceneId: dc.sceneId,
      round: dc.round,
      started: dc.started,
      ended: dc.ended,
      firstSide: dc.firstSide,
      currentSide: dc.currentSide,
      // currentCombatantId is preserved so resume re-picks the same
      // actor whose turn it was. Resume rewinds to TURN_START which
      // re-enters DECLARE — the player re-makes their pick.
      currentCombatantId: dc.currentCombatantId,
      // True iff RESOLVE has applied this turn's action to actor docs.
      // Resume reads this to decide between TURN_START (player re-picks)
      // and TURN_END (player's action already committed, just advance).
      currentTurnResolved: !!dc.currentTurnResolved,
      combatants: dc.combatants.map((c) => ({
        id: c.id,
        side: c.side,
        tokenUuid: c.tokenUuid,
        actorUuid: c.actorUuid,
        name: c.name,
        disposition: c.disposition,
        isVillain: c.isVillain,
        isBoss: c.isBoss,
        rank: c.rank,
        turnsPerRound: c.turnsPerRound,
        turnsRemaining: c.turnsRemaining,
        defeated: c.defeated,
        // Full token document data so the rewind tool can RECREATE a token
        // that was deleted since this save (an Illusionist Phantasm shattered,
        // a `destroy_summon`'d drake, a GM-reaped corpse). For unlinked summon
        // tokens the toObject carries `delta` (the synthetic actor overrides),
        // so the recreated token rebuilds its own actor at the saved state.
        // Null when the live token isn't resolvable at save time (recreation
        // then isn't possible — same as the pre-tokenData behaviour).
        tokenData: (() => { try { return c.tokenDoc?.toObject?.() ?? null; } catch { return null; } })(),
      })),
      // Active Guards table is already plain data; round-trip as-is.
      activeGuards: (dc.activeGuards ?? []).map((g) => ({
        guarderActorUuid: g.guarderActorUuid,
        guarderActorId: g.guarderActorId,
        guarderEffectId: g.guarderEffectId,
        coveredActorUuid: g.coveredActorUuid,
        coveredEffectId: g.coveredEffectId,
        appliedAtRound: g.appliedAtRound,
      })),
    },
  };
  // Capture the rewind history snapshot FIRST. `snapshotCombatantActors` READS
  // actor state (HP/MP/AEs) in-memory — no network — and is the ONLY part of this
  // function whose ordering matters to a caller: it must read actor state BEFORE
  // the caller mutates actors (RESOLVE saves a "pre-reaction" checkpoint, then
  // settleInstance drains post-action triggers that change those actors). Once
  // `entry.actors` is built the snapshot is frozen, so the two DB WRITES below
  // (setFlag + pushToHistory — the only network round-trips here) no longer gate
  // that contract and can be deferred. `skipHistory` opts out of the snapshot +
  // history write entirely (diagnostic / out-of-band resaves).
  let historyEntry = null;
  if (!opts.skipHistory) {
    try {
      const actors = await snapshotCombatantActors(dc);
      // Snapshot standaloneFired entries at save time so a rewind can
      // restore EXACTLY the reaction decisions that existed when the
      // save was taken. Previously the rewind path cleared the flag
      // wholesale — that wiped decisions made BEFORE the save (e.g.
      // Hina clicked HS, save fires, then rewind → Hina's "fired"
      // entry vanishes → HS re-spawns on SRW re-entry, even though
      // she'd already committed to it in the rewound timeline).
      let standaloneFired = null;
      try {
        standaloneFired = dc.scene.getFlag(FLAG_NS, "standaloneFired") ?? null;
      } catch (e) {
        warn("persistence.save: standaloneFired snapshot failed", e);
      }
      historyEntry = {
        ...state,
        id: foundry.utils?.randomID?.() ?? `hist-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        label: String(opts.label ?? ""),
        description: String(opts.description ?? ""),
        actors,
        ...(standaloneFired ? { standaloneFired } : {}),
      };
    } catch (e) {
      warn("persistence.save: history snapshot failed", e);
    }
  }

  // The reload-survival flag + the rewind-history push. Two separate flags /
  // writes — keeps reload-survival reads cheap (small JSON) and isolates any
  // history-side failure from the reload-survival write.
  const writeFlags = async () => {
    try {
      await dc.scene.setFlag(FLAG_NS, FLAG_KEY, state);
      log(`persistence.save: dCombat ${dc.id} → scene ${dc.scene.name} (round ${dc.round}, ${dc.combatants.length} combatants)`);
    } catch (e) {
      warn("persistence.save: setFlag failed", e);
    }
    if (historyEntry) {
      try { await pushToHistory(dc.scene, historyEntry); }
      catch (e) { warn("persistence.save: history push failed", e); }
    }
  };

  // `deferWrites` — the snapshot (the only ordering-critical step) is already
  // captured above, so fire the DB writes in the BACKGROUND and return now,
  // keeping the caller's critical path off two network round-trips. Used by
  // RESOLVE so the FSM advances toward the next turn's menu without waiting on
  // the checkpoint to land (a reload during the brief write window just resumes
  // at the prior checkpoint — same tolerance every fire-and-forget save site
  // already has).
  if (opts.deferWrites) {
    writeFlags().catch((e) => warn("persistence.save: deferred writes failed", e));
    return;
  }
  await writeFlags();
}

// ── Per-actor snapshot (rewind tool) ────────────────────────────────────

// Capture the per-combatant actor state that the rewind tool needs to
// restore (HP/MP/IP/Fabula points + equipment-display props + Active
// Effects + per-item isEquipped/quantity). Also drains the deletion
// buffer into `deletedItemsLog` so items deleted between this save and
// the previous one can be recreated on rewind.
//
// Returns one entry per combatant on dCombat. Combatants whose actor
// can't be resolved are skipped (logged, not thrown — a single missing
// actor shouldn't break the entire snapshot).
//
// NB: only the props listed below are captured. Any future declarative
// prop that should be reversible needs to be added here AND to the
// restore loop in `restoreActorsFromSnapshot`. Capturing all of
// `system.props` would balloon size for properties we never want to
// rewind (e.g. cosmetic profile fields). See [[director-rewind-tool-plan]]
// for the exact set.
async function snapshotCombatantActors(dCombat) {
  if (!dCombat?.combatants?.length) return [];
  const out = [];
  for (const c of dCombat.combatants) {
    let actor = c.actorDoc;
    if (!actor && c.actorUuid) {
      try { actor = await fromUuid(c.actorUuid); } catch {}
    }
    // Last resort: resolve through the token. Unlinked tokens carry their
    // live state on a token-scoped synthetic actor (token delta); reaching
    // it via the token is the only reliable handle when the combatant lost
    // its actorDoc reference. We also persist the token uuid so the rewind
    // restore has a stable fallback key (the synthetic actor uuid is
    // token-scoped and can be brittle; the token uuid is not).
    if (!actor && c.tokenUuid) {
      try { actor = (await fromUuid(c.tokenUuid))?.actor ?? null; } catch {}
    }
    if (!actor) {
      warn(`snapshotCombatantActors: actor not resolvable for ${c.name} (${c.actorUuid})`);
      continue;
    }
    const p = actor.system?.props ?? {};
    out.push({
      actorUuid: actor.uuid,
      actorId: actor.id,
      tokenUuid: c.tokenUuid ?? actor.token?.uuid ?? null,
      name: actor.name ?? c.name ?? "?",
      props: {
        // Resources — every prop in RESOURCE_REGISTRY (single source of truth)
        // so each restorable resource (HP/MP/IP/Fabula/Zero Power/Zenit/Enmity/
        // Shield/…) is reversible. Hand-listing missed zero_power_value et al.,
        // so a rewind left those resources at their post-action value.
        ...Object.fromEntries(
          Object.values(RESOURCE_REGISTRY).map((def) => [def.prop, p[def.prop]]),
        ),
        // Equipment-display fields (mirrors what applyEquipmentSwap writes
        // — kept in sync with equipment-swap.js + the CSB template).
        main_hand:           p.main_hand,
        off_hand:            p.off_hand,
        accessory_name:      p.accessory_name,
        accessory2_name:     p.accessory2_name,
        main_attrib_1:       p.main_attrib_1,
        main_attrib_2:       p.main_attrib_2,
        off_attrib_1:        p.off_attrib_1,
        off_attrib_2:        p.off_attrib_2,
        weapon1_base_mod:    p.weapon1_base_mod,
        weapon1_base_damage: p.weapon1_base_damage,
        off_base_mod_1:      p.off_base_mod_1,
        off_base_mod_2:      p.off_base_mod_2,
        weapon1_damagetype:  p.weapon1_damagetype,
        weapon2_damagetype:  p.weapon2_damagetype,
        main_details:        p.main_details,
        off_details:         p.off_details,
        accessory_details:   p.accessory_details,
        accessory2_details:  p.accessory2_details,
      },
      // AE.toObject() returns a plain serializable clone with `_id` —
      // safe to round-trip through JSON. We snapshot ALL effects (not
      // just director-applied ones) so a rewind correctly removes
      // anything added AFTER the target save.
      effects: Array.from(actor.effects ?? []).map((eff) => {
        try { return eff.toObject(); } catch { return null; }
      }).filter(Boolean),
      // Item snapshot is intentionally slim — full toObject for every
      // item would 10x the per-save size. Only fields the rewind cares
      // about live here; items deleted BETWEEN snapshots have their
      // full toObject in `deletedItemsLog` (captured by the deletion
      // tracker hook), and items still alive at restore time are read
      // from the live actor.
      itemStates: Array.from(actor.items ?? []).map((it) => ({
        id: it.id,
        isEquipped: !!it.system?.isEquipped,
        item_quantity: it.system?.props?.item_quantity ?? null,
      })),
      deletedItemsLog: consumePendingDeletions(actor.uuid),
    });
  }
  return out;
}

// ── Load ────────────────────────────────────────────────────────────────

// Scan all scenes for a director-state flag. Returns the first match (or
// null). In the unlikely event two scenes have flags, we take the
// most-recently-saved one and clear the other defensively.
export function findSavedDirectorState() {
  const matches = [];
  for (const scene of game.scenes ?? []) {
    const f = scene.getFlag(FLAG_NS, FLAG_KEY);
    if (f && f.schemaVersion === SCHEMA_VERSION) {
      matches.push({ scene, state: f });
    }
  }
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];
  // Multiple flags: take newest. Clear the others.
  matches.sort((a, b) => (b.state.savedAt ?? 0) - (a.state.savedAt ?? 0));
  const winner = matches[0];
  for (let i = 1; i < matches.length; i++) {
    warn(`Multiple director-state flags found (scene "${matches[i].scene.name}"). Clearing defensively.`);
    clearDirectorStateFlag(matches[i].scene).catch(() => {});
  }
  return winner;
}

// ── Clear ───────────────────────────────────────────────────────────────

export async function clearDirectorStateFlag(scene) {
  if (!scene) return;
  try {
    if (scene.getFlag(FLAG_NS, FLAG_KEY)) {
      await scene.unsetFlag(FLAG_NS, FLAG_KEY);
      log(`persistence.clearFlag: removed from scene ${scene.name}`);
    }
  } catch (e) {
    warn("persistence.clearFlag failed", e);
  }
}

// Clear the rewind history flag on a scene. Kept as its own function so
// stop() can decide to clear ONLY the history (rare) or both flags via
// `clearAllDirectorStateFlags`. The BattleEnd Cleanup macro also calls
// this defensively in case stop() was bypassed.
export async function clearDirectorHistoryFlag(scene) {
  if (!scene) return;
  try {
    if (scene.getFlag(FLAG_NS, HISTORY_KEY)) {
      await scene.unsetFlag(FLAG_NS, HISTORY_KEY);
      log(`persistence.clearHistoryFlag: removed from scene ${scene.name}`);
    }
  } catch (e) {
    warn("persistence.clearHistoryFlag failed", e);
  }
}

// Convenience — find + clear in one call. Used by director-boot.stop()
// without a scene reference. Clears BOTH the reload-survival state flag
// AND the rewind history flag (a finished battle has nothing to resume
// or rewind to). Also clears the standalone-reaction idempotency flag
// so the next battle's conflict_start surfaces all reactions afresh.
export async function clearAllDirectorStateFlags() {
  // Lazy import — standalone-reactions imports persistence indirectly
  // via state-handlers, so a static import here would risk a cycle.
  let clearStandaloneFiredFlag = null;
  try {
    const mod = await import("./standalone-reactions.js");
    clearStandaloneFiredFlag = mod.clearStandaloneFiredFlag;
  } catch (e) {
    warn("clearAllDirectorStateFlags: standalone-reactions import failed", e);
  }
  for (const scene of game.scenes ?? []) {
    if (scene.getFlag(FLAG_NS, FLAG_KEY)) {
      await clearDirectorStateFlag(scene);
    }
    if (scene.getFlag(FLAG_NS, HISTORY_KEY)) {
      await clearDirectorHistoryFlag(scene);
    }
    if (clearStandaloneFiredFlag) {
      try { await clearStandaloneFiredFlag(scene); } catch (e) { warn("clearStandaloneFiredFlag threw", e); }
    }
  }
}

// ── History (rewind tool) ───────────────────────────────────────────────

// Append an entry to the scene's rolling history flag. Drops oldest
// entries past MAX_HISTORY (50). Idempotent on failure — the rest of
// the save still succeeded (history is a nice-to-have for the rewind
// tool, not load-bearing for combat).
//
// Deduplication: if the new entry's fingerprint matches the latest
// existing entry's fingerprint, skip the push. This replaces the
// older one-shot `_suppressNextHistoryPush` flag — that approach
// suppressed the FIRST save after any rewind regardless of whether
// the rewound-to snapshot actually matched. Fingerprint covers the
// observable rewind axes (round, side, combatant, resolution state,
// pendingAction shape, label) so two saves that would land on the
// same logical timeline-point collapse to one.
//
// Concrete cases handled:
//   - F5 right after a save → resume re-saves the same checkpoint → dedup
//   - Rewind to "Round 2 · Hina · Turn Start" → TURN_START re-saves same →
//     dedup
//   - Rewind to "Battle Start" → TURN_START saves NEW "Round 1 · Hina ·
//     Turn Start" entry → fingerprint differs → push (the old bug:
//     suppressed unconditionally and lost the entry)
function historyFingerprint(entry) {
  const dc = entry?.dCombat ?? {};
  const pa = entry?.pendingAction ?? null;
  return JSON.stringify([
    String(entry?.label ?? ""),
    Number(dc.round ?? 0),
    String(dc.currentSide ?? ""),
    String(dc.currentCombatantId ?? ""),
    !!dc.currentTurnResolved,
    String(pa?.actionResult?.attackerActorRef ?? pa?.actionResult?.attacker?.actorUuid ?? ""),
    String(pa?.actionResult?.kind ?? ""),
    Number(pa?.actionResult?.passIndex ?? 0),
  ]);
}

export async function pushToHistory(scene, entry) {
  if (!scene || !entry) return;
  let current = scene.getFlag(FLAG_NS, HISTORY_KEY);
  if (!Array.isArray(current)) current = [];
  if (current.length) {
    const latest = current[current.length - 1];
    if (historyFingerprint(latest) === historyFingerprint(entry)) {
      log(`persistence.pushToHistory: dedup skip — "${entry.label}" matches latest entry`);
      return;
    }
  }
  const next = [...current, entry];
  // Rolling window — oldest entries fall off the front.
  while (next.length > MAX_HISTORY) next.shift();
  try {
    await scene.setFlag(FLAG_NS, HISTORY_KEY, next);
    log(`persistence.pushToHistory: ${next.length}/${MAX_HISTORY} entries on ${scene.name} (latest: "${entry.label}")`);
  } catch (e) {
    warn("persistence.pushToHistory: setFlag failed", e);
  }
}

// Read the history list for a scene. Returns [] if none. Caller can sort
// (entries are appended in order, so newest is .at(-1)).
export function getHistory(scene) {
  if (!scene) return [];
  const arr = scene.getFlag(FLAG_NS, HISTORY_KEY);
  return Array.isArray(arr) ? arr : [];
}

// Find a snapshot by id across all scenes that hold a history flag.
// Returns `{scene, history, index, snapshot}` or null. The rewind tool's
// `rewindTo(id)` uses this to locate the target without requiring the
// caller to know which scene the history lives on.
export function findHistorySnapshot(snapshotId) {
  if (!snapshotId) return null;
  for (const scene of game.scenes ?? []) {
    const history = getHistory(scene);
    if (!history.length) continue;
    const index = history.findIndex((e) => e?.id === snapshotId);
    if (index >= 0) return { scene, history, index, snapshot: history[index] };
  }
  return null;
}

// ── Reconstruct dCombat ─────────────────────────────────────────────────

// Rebuild a live DirectorCombat from a saved snapshot.
//
// Live refs (tokenDoc, actorDoc) are re-resolved via `fromUuid`. If a
// token has been deleted between save and resume, that combatant is
// dropped from the reconstructed dCombat and a warning is surfaced.
// Returns the dCombat (possibly with fewer combatants than saved) or
// null if reconstruction failed entirely (e.g. scene gone).
export async function reconstructDirectorCombat(state, scene) {
  if (!state?.dCombat || !scene) return null;

  const dc = new DirectorCombat({ scene, sourceSceneId: state.sourceSceneId ?? null });
  // Preserve the saved id so currentCombatantId references survive.
  dc.id = state.dCombat.id;
  dc.round = state.dCombat.round;
  dc.started = !!state.dCombat.started;
  dc.ended = !!state.dCombat.ended;
  dc.firstSide = state.dCombat.firstSide;
  dc.currentSide = state.dCombat.currentSide;
  // Preserve `currentCombatantId` from the saved snapshot so the resume
  // lands on the SAME combatant whose turn it was. We validate it after
  // combatants are loaded below (and fall back to null — forcing a re-
  // pick — if the saved id points at a combatant that didn't survive
  // reconstruction).
  dc.currentCombatantId = state.dCombat.currentCombatantId ?? null;
  dc.currentTurnResolved = !!state.dCombat.currentTurnResolved;

  const droppedNames = [];
  const recreatedNames = [];
  for (const sc of state.dCombat.combatants ?? []) {
    let tokenDoc = null;
    let actorDoc = null;
    try { tokenDoc = await fromUuid(sc.tokenUuid); } catch {}
    // Token gone (unsummoned / destroy_summon'd / GM-reaped since the save).
    // RECREATE it from the snapshot's `tokenData` rather than dropping the
    // combatant — a faithful rewind must restore the token population, not
    // just survivor stats. `keepId: true` preserves the token _id so its
    // uuid (and any activeGuards / currentCombatantId refs) stay valid, and
    // the recreated unlinked token rebuilds its delta actor from the data.
    if (!tokenDoc && sc.tokenData) {
      try {
        const created = await scene.createEmbeddedDocuments(
          "Token", [sc.tokenData], { keepId: true },
        );
        tokenDoc = created?.[0] ?? null;
        if (tokenDoc) recreatedNames.push(sc.name ?? sc.tokenUuid);
      } catch (e) {
        warn(`reconstruct: token recreate threw for ${sc.name} (${sc.tokenUuid})`, e);
      }
    }
    if (!tokenDoc) {
      droppedNames.push(sc.name ?? sc.tokenUuid);
      warn(`reconstruct: token ${sc.tokenUuid} (${sc.name}) stale and not recreatable, dropping`);
      continue;
    }
    try { actorDoc = await fromUuid(sc.actorUuid); } catch {}
    const combatant = new DirectorCombatant({
      tokenDoc,
      actorDoc: actorDoc ?? tokenDoc.actor ?? null,
      side: sc.side,
      disposition: sc.disposition,
    });
    // Preserve the saved id (currentCombatantId may reference it) and
    // mutable mid-round state (turnsRemaining decremented from
    // turnsPerRound by prior TURN_END calls).
    combatant.id = sc.id;
    combatant.turnsRemaining = sc.turnsRemaining ?? combatant.turnsPerRound;
    combatant.defeated = !!sc.defeated;
    dc.combatants.push(combatant);
  }

  if (!dc.combatants.length) {
    warn("reconstruct: no combatants survived");
    return null;
  }

  // Validate currentCombatantId — if the saved id points at a combatant
  // we couldn't reconstruct (stale token UUID), clear it so TURN_START
  // re-prompts the picker.
  if (dc.currentCombatantId && !dc.findById(dc.currentCombatantId)) {
    warn(`reconstruct: saved currentCombatantId ${dc.currentCombatantId} not found in reconstructed combatants — falling back to picker`);
    dc.currentCombatantId = null;
  }

  // Restore active-guards ledger. AEs themselves persist on the actor
  // docs (Foundry-side), so the ledger entries pointing at their ids
  // remain valid across reloads. If an AE has been hand-deleted before
  // the reload, the ledger entry is dead but harmless (TURN_START's
  // batch delete filters to existing AEs before calling).
  dc.activeGuards = (state.dCombat.activeGuards ?? []).map((g) => ({
    guarderActorUuid: g.guarderActorUuid,
    guarderActorId: g.guarderActorId,
    guarderEffectId: g.guarderEffectId,
    coveredActorUuid: g.coveredActorUuid,
    coveredEffectId: g.coveredEffectId,
    appliedAtRound: g.appliedAtRound,
  }));

  if (recreatedNames.length) {
    log(`reconstruct: recreated ${recreatedNames.length} deleted token(s): ${recreatedNames.join(", ")}`);
  }
  if (droppedNames.length) {
    ui.notifications?.warn(`Director resume: ${droppedNames.length} combatant${droppedNames.length === 1 ? "" : "s"} missing (token deleted): ${droppedNames.join(", ")}`);
  }
  return dc;
}

// ── Restore actors (rewind tool) ────────────────────────────────────────

// Find the toObject for a deleted item by walking forward through saves
// newer than the rewind target. The save that captured the deletion
// holds the item's full data in its `deletedItemsLog`; the FIRST match
// wins (we want the toObject closest to the deletion event).
function findDeletedItemData(itemId, actorUuid, futureSaves) {
  for (const save of futureSaves) {
    const actorEntry = (save.actors ?? []).find((a) => a.actorUuid === actorUuid);
    if (!actorEntry) continue;
    const found = (actorEntry.deletedItemsLog ?? []).find((it) => it?._id === itemId);
    if (found) return found;
  }
  return null;
}

// Per-actor restore: applies the EXACT-match policy. Resource + display
// props are overwritten. AEs and items are reconciled (delete extras +
// recreate missing + update changed flags). Out-of-band edits made by
// the GM/player BETWEEN the target save and now are lost — by design;
// see [[director-rewind-tool-plan]] for the rationale.
//
// `futureSaves`: history entries NEWER than the target snapshot,
// ordered oldest→newest. Used to look up `deletedItemsLog` data when
// recreating items that have been deleted since the target save.
//
// Failures on individual actors are warned but don't abort the whole
// restore — better to land a partial state than to bail entirely.
export async function restoreActorsFromSnapshot(snapshot, futureSaves = []) {
  if (!snapshot?.actors?.length) {
    log("restore: snapshot has no actor data, skipping");
    return { actorsRestored: 0 };
  }

  let restored = 0;
  for (const actorSnap of snapshot.actors) {
    let actor = null;
    try { actor = await fromUuid(actorSnap.actorUuid); } catch {}
    // Fallback for tokens without their own concrete (linked) actor: the
    // synthetic actor uuid is token-scoped and can fail to resolve after a
    // stop→reconstruct cycle, but the token uuid is stable. Resolve the
    // token's own (delta) actor so the restore writes to the SAME isolated
    // actor the snapshot was taken from — never the shared base world actor.
    if (!actor && actorSnap.tokenUuid) {
      try { actor = (await fromUuid(actorSnap.tokenUuid))?.actor ?? null; } catch {}
    }
    if (!actor) {
      warn(`restore: actor ${actorSnap.actorUuid} (${actorSnap.name}) not found, skipping`);
      continue;
    }

    // ─── 1. Resource + equipment-display props ──────────────────────
    // Build the update at dotted-path form so Foundry merges into
    // existing system.props rather than replacing the whole sub-tree.
    const propsUpdate = {};
    for (const [k, v] of Object.entries(actorSnap.props ?? {})) {
      // Skip undefined values — the snapshot serializer may strip
      // missing fields, and writing `undefined` is a no-op anyway.
      if (v === undefined) continue;
      propsUpdate[`system.props.${k}`] = v;
    }
    if (Object.keys(propsUpdate).length) {
      try { await actor.update(propsUpdate); }
      catch (e) { warn(`restore: actor.update threw on ${actor.name}`, e); }
    }

    // ─── 2. Active Effect reconcile ─────────────────────────────────
    const snapEffectsById = new Map();
    for (const eff of (actorSnap.effects ?? [])) {
      if (eff?._id) snapEffectsById.set(eff._id, eff);
    }
    const currentEffectIds = new Set(Array.from(actor.effects ?? []).map((e) => e.id));

    // 2a. Delete AEs that exist on the actor but NOT in the snapshot.
    const toDeleteAEs = [...currentEffectIds].filter((id) => !snapEffectsById.has(id));
    if (toDeleteAEs.length) {
      try { await actor.deleteEmbeddedDocuments("ActiveEffect", toDeleteAEs); }
      catch (e) { warn(`restore: AE delete threw on ${actor.name}`, e); }
    }

    // 2b. Create AEs that are in the snapshot but NOT on the actor.
    //     `keepId: true` preserves the original _id so cross-doc
    //     references (e.g. dCombat.activeGuards entries pointing at
    //     guarderEffectId) stay valid post-restore.
    const toCreateAEs = [];
    for (const [id, eff] of snapEffectsById) {
      if (!currentEffectIds.has(id)) toCreateAEs.push(eff);
    }
    if (toCreateAEs.length) {
      try { await actor.createEmbeddedDocuments("ActiveEffect", toCreateAEs, { keepId: true }); }
      catch (e) { warn(`restore: AE create threw on ${actor.name}`, e); }
    }

    // 2c. Update AEs that exist on both: reconcile `disabled` AND the
    //     charge count. We still don't merge `changes` / `duration` —
    //     those mutate via Foundry's own update paths and a stale write
    //     would clobber legitimate in-flight changes. But the charge count
    //     (`flags["fabula-ultima-companion"].charges`, the AE-backed
    //     counter behind once-per-X gates, Protect/Counter reaction pools,
    //     and persistent clocks like Adoration — see [[skill-charges]]) is
    //     exactly the kind of consumable state a rewind must revert. An AE
    //     that survived from the target save until now keeps its LIVE count
    //     (spent down or refilled since); the disabled-only reconcile missed
    //     it, so a rewound "ready" gate stayed spent. Charge AEs that drained
    //     to 0 and self-deleted are handled by 2b (recreated from the
    //     snapshot, flags and all).
    const aeUpdates = [];
    const chargeKeyOf = (eff) => Number(eff?.flags?.[FLAG_NS]?.charges);
    const chargesMaxOf = (eff) => eff?.flags?.[FLAG_NS]?.chargesMax;
    for (const [id, snapEff] of snapEffectsById) {
      const live = actor.effects?.get?.(id);
      if (!live) continue;
      const update = { _id: id };
      let changed = false;
      if (!!live.disabled !== !!snapEff.disabled) {
        update.disabled = !!snapEff.disabled;
        changed = true;
      }
      // Charge count — only when the snapshot AE actually carries a charges
      // flag (skips the vast majority of AEs that have none) and the live
      // value drifted. Restore both `charges` and `chargesMax` so a rewind
      // past a max-bump (rare, but clocks can grow) is faithful too.
      const snapCharges = chargeKeyOf(snapEff);
      if (Number.isFinite(snapCharges)) {
        if (chargeKeyOf(live) !== snapCharges) {
          update[`flags.${FLAG_NS}.charges`] = snapCharges;
          changed = true;
        }
        const snapMax = chargesMaxOf(snapEff);
        if (snapMax != null && chargesMaxOf(live) !== snapMax) {
          update[`flags.${FLAG_NS}.chargesMax`] = snapMax;
          changed = true;
        }
      }
      if (changed) aeUpdates.push(update);
    }
    if (aeUpdates.length) {
      try { await actor.updateEmbeddedDocuments("ActiveEffect", aeUpdates); }
      catch (e) { warn(`restore: AE update threw on ${actor.name}`, e); }
    }

    // ─── 3. Item reconcile ──────────────────────────────────────────
    const snapItemsById = new Map();
    for (const it of (actorSnap.itemStates ?? [])) {
      if (it?.id) snapItemsById.set(it.id, it);
    }
    const currentItemIds = new Set(Array.from(actor.items ?? []).map((i) => i.id));

    // 3a. Delete items that exist on the actor but NOT in the snapshot
    //     (i.e. were created AFTER the target save — e.g. loot pickup).
    const toDeleteItems = [...currentItemIds].filter((id) => !snapItemsById.has(id));
    if (toDeleteItems.length) {
      try { await actor.deleteEmbeddedDocuments("Item", toDeleteItems); }
      catch (e) { warn(`restore: Item delete threw on ${actor.name}`, e); }
    }

    // 3b. Recreate items that ARE in the snapshot but missing now.
    //     Their full toObject lives in some newer save's
    //     deletedItemsLog (captured by the preDeleteItem hook).
    const toRecreateItems = [];
    const unrecoverable = [];
    for (const [id, snapItem] of snapItemsById) {
      if (currentItemIds.has(id)) continue;
      const itemData = findDeletedItemData(id, actorSnap.actorUuid, futureSaves);
      if (itemData) {
        // Apply the snapshot's slim fields onto the captured toObject
        // so isEquipped + quantity match the target snapshot (not the
        // pre-delete state, which may have differed).
        const data = foundry.utils.deepClone(itemData);
        if (!data.system) data.system = {};
        if (!data.system.props) data.system.props = {};
        data.system.isEquipped = !!snapItem.isEquipped;
        if (snapItem.item_quantity != null) {
          data.system.props.item_quantity = snapItem.item_quantity;
        }
        toRecreateItems.push(data);
      } else {
        unrecoverable.push(id);
      }
    }
    if (unrecoverable.length) {
      warn(`restore: ${unrecoverable.length} item(s) on ${actor.name} not recoverable (no deletedItemsLog entry): ${unrecoverable.join(", ")}`);
    }
    if (toRecreateItems.length) {
      try { await actor.createEmbeddedDocuments("Item", toRecreateItems, { keepId: true }); }
      catch (e) { warn(`restore: Item create threw on ${actor.name}`, e); }
    }

    // 3c. Update isEquipped + item_quantity on items that exist on both.
    const itemUpdates = [];
    for (const [id, snapItem] of snapItemsById) {
      const live = actor.items?.get?.(id);
      if (!live) continue;
      const update = { _id: id };
      let changed = false;
      if (!!live.system?.isEquipped !== !!snapItem.isEquipped) {
        update["system.isEquipped"] = !!snapItem.isEquipped;
        changed = true;
      }
      if (snapItem.item_quantity != null) {
        const liveQty = live.system?.props?.item_quantity;
        if (liveQty !== snapItem.item_quantity) {
          update["system.props.item_quantity"] = snapItem.item_quantity;
          changed = true;
        }
      }
      if (changed) itemUpdates.push(update);
    }
    if (itemUpdates.length) {
      try { await actor.updateEmbeddedDocuments("Item", itemUpdates); }
      catch (e) { warn(`restore: Item update threw on ${actor.name}`, e); }
    }

    restored++;
  }

  log(`restore: applied actor snapshots to ${restored}/${snapshot.actors.length} combatants`);
  return { actorsRestored: restored };
}

// ── Orchestrator: rewind ────────────────────────────────────────────────

// High-level rewind entry. Looks up the snapshot by id, reconstructs
// dCombat, restores actor state, and hands off the rebuilt state to the
// caller's `mountResumedDirector` callback (typically
// `director-boot.resumeFromSavedState`).
//
// The orchestration is split this way so persistence.js doesn't import
// from director-boot.js (which imports from here). The caller wraps
// stop() + mountResumedDirector in whatever order makes sense for the
// running state — see [[director-rewind-tool-plan]] Chunk 3.
//
// Returns `{ ok, scene, dCombat, snapshot }` on success, `{ ok:false,
// error }` on failure. Does NOT call mountResumedDirector; that's the
// caller's job after stopping any live director.
export async function rewindToHistorySnapshot(snapshotId) {
  if (!game.user?.isGM) {
    return { ok: false, error: "GM only" };
  }
  if (!snapshotId) {
    return { ok: false, error: "missing snapshotId" };
  }

  const found = findHistorySnapshot(snapshotId);
  if (!found) {
    warn(`rewindToHistorySnapshot: snapshot ${snapshotId} not found in any scene's history`);
    return { ok: false, error: "snapshot not found" };
  }
  const { scene, history, index, snapshot } = found;
  log(`rewindToHistorySnapshot: target index ${index}/${history.length - 1} on scene "${scene.name}" (label: "${snapshot.label}")`);

  // 1. Reconstruct dCombat from the saved snapshot. Stale token UUIDs
  //    drop with a warning toast.
  const dCombat = await reconstructDirectorCombat(snapshot, scene);
  if (!dCombat) {
    warn("rewindToHistorySnapshot: reconstruction failed (no combatants survived)");
    return { ok: false, error: "reconstruction failed" };
  }

  // 1b. Un-summon: delete director-summon tokens that were spawned AFTER the
  //     target snapshot (a Phantasm / drake created later in the timeline the
  //     GM just rolled back past). Scope is deliberately narrow — ONLY tokens
  //     the director tagged as summons (`isSummon` / `isPhantasm` /
  //     `summonedBy`) and NOT present in the rewound-to combatant set get
  //     deleted, so a token the GM hand-placed mid-battle is never reaped.
  //     This is the inverse of reconstruct's token RECREATE step, and is
  //     rewind-only (a forward reload-resume has no post-save summons to drop).
  try {
    const savedTokenUuids = new Set(
      (snapshot.dCombat?.combatants ?? []).map((c) => c.tokenUuid).filter(Boolean),
    );
    const strayIds = [];
    const strayNames = [];
    for (const td of (scene.tokens ?? [])) {
      const f = td?.flags?.[FLAG_NS] ?? {};
      const isDirectorSummon = !!(f.isSummon || f.isPhantasm || f.summonedBy);
      if (!isDirectorSummon) continue;
      if (savedTokenUuids.has(td.uuid)) continue;
      strayIds.push(td.id);
      strayNames.push(td.name ?? td.id);
    }
    if (strayIds.length) {
      await scene.deleteEmbeddedDocuments("Token", strayIds);
      log(`rewindToHistorySnapshot: un-summoned ${strayIds.length} post-save summon(s): ${strayNames.join(", ")}`);
    }
  } catch (e) {
    warn("rewindToHistorySnapshot: post-save summon cleanup failed", e);
  }

  // 2. Restore actor state using the target snapshot. Future saves
  //    (entries newer than the target) provide deletedItemsLog data
  //    for recreating consumables that were used up since the target.
  const futureSaves = history.slice(index + 1);
  await restoreActorsFromSnapshot(snapshot, futureSaves);

  // 3. Truncate the history at the rewind point. Anything newer than
  //    the target represents actions that have just been undone — they
  //    shouldn't remain in the rewind list (or the GM could "redo"
  //    something they just rolled back, which silently re-applies
  //    actor edits that no longer match the live state).
  //    Keep the target entry itself; the user just rewound TO it and
  //    may want to rewind again.
  const truncated = history.slice(0, index + 1);
  try {
    await scene.setFlag(FLAG_NS, HISTORY_KEY, truncated);
    log(`rewindToHistorySnapshot: history truncated to ${truncated.length} entries`);
  } catch (e) {
    warn("rewindToHistorySnapshot: history truncate failed", e);
  }

  // 4. Update the reload-survival state flag so a subsequent F5
  //    auto-resumes to the rewound state (not the pre-rewind state).
  //    The snapshot is a superset of the directorState shape — strip
  //    the rewind-only fields (actors, label, description, id) before
  //    writing. KEEP pendingAction + runtimeContinuation (v2) +
  //    freeActionContext (v1 back-compat): those are part of the
  //    directorState contract and the rewound state's in-flight context
  //    (action card on screen, free-action queue populated, suspended
  //    sub-flows on the stack) should survive a follow-up F5 the same
  //    way a fresh save would.
  try {
    const stateOnly = {
      schemaVersion: snapshot.schemaVersion,
      savedAt: snapshot.savedAt,
      sourceSceneId: snapshot.sourceSceneId,
      payload: snapshot.payload,
      dCombat: snapshot.dCombat,
      ...(snapshot.pendingAction ? { pendingAction: snapshot.pendingAction } : {}),
      ...(snapshot.runtimeContinuation ? { runtimeContinuation: snapshot.runtimeContinuation } : {}),
      // v1 back-compat — old history entries still carry freeActionContext.
      // Resume path handles either shape via hydrateContinuationState.
      ...(snapshot.freeActionContext ? { freeActionContext: snapshot.freeActionContext } : {}),
    };
    await scene.setFlag(FLAG_NS, FLAG_KEY, stateOnly);
  } catch (e) {
    warn("rewindToHistorySnapshot: directorState rewrite failed", e);
  }

  // 5. Restore the standalone-reaction idempotency flag from the
  //    snapshot. The original implementation cleared this flag
  //    wholesale on rewind — the rationale was "every entry refers to
  //    a decision that landed on the post-rewind timeline." That's
  //    wrong: decisions made BEFORE the save (Hina clicking HS, save
  //    fires) are part of the rewind target's state, not the
  //    post-rewind timeline. Wiping them caused HS to re-spawn on
  //    SRW re-entry after the rewound free action ran through.
  //
  //    Snapshots written post-this-commit carry `snapshot.standaloneFired`
  //    (saveDirectorState captures the live flag value). Restore it
  //    verbatim. Older snapshots lack the field — fall back to the
  //    legacy clear-all behavior so they still resume coherently
  //    (with the same misfire the user just reported, but at least
  //    not broken).
  try {
    if (snapshot.standaloneFired) {
      await scene.setFlag(FLAG_NS, "standaloneFired", snapshot.standaloneFired);
      const n = Array.isArray(snapshot.standaloneFired.entries) ? snapshot.standaloneFired.entries.length : 0;
      log(`rewindToHistorySnapshot: restored standalone-fired flag on "${scene.name}" (${n} entries)`);
    } else {
      const mod = await import("./standalone-reactions.js");
      if (mod.clearStandaloneFiredFlag) {
        await mod.clearStandaloneFiredFlag(scene);
        log(`rewindToHistorySnapshot: legacy snapshot — cleared standalone-fired flag on "${scene.name}"`);
      }
    }
  } catch (e) {
    warn("rewindToHistorySnapshot: standalone-fired restore failed", e);
  }

  return { ok: true, scene, dCombat, snapshot };
}
