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
import { DirectorCombat, DirectorCombatant } from "./director-combat.js";

const FLAG_NS = "fabula-ultima-companion";
const FLAG_KEY = "directorState";       // single-object reload-survival flag
const HISTORY_KEY = "directorHistory";  // rolling-20 rewind history flag
const SCHEMA_VERSION = 1;
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
  // One-shot history-push suppression. The rewind path sets this on
  // ctx via resumeFromSavedState({ suppressNextHistoryPush: true }) so
  // the first save fired by the rewound TURN_START / TURN_END /
  // CONFIRM handler doesn't add a duplicate entry at the snapshot we
  // just landed on. Read-and-clear so it only affects the very next
  // save; subsequent saves push to history normally. directorState is
  // still written (reload survival shouldn't break).
  if (director?.ctx?._suppressNextHistoryPush) {
    delete director.ctx._suppressNextHistoryPush;
    opts = { ...opts, skipHistory: true };
    log("persistence.save: skipHistory forced by one-shot suppressNextHistoryPush flag");
  }
  // pendingAction lives at the top level of the saved state so the
  // resume path can read it without diving into dCombat. Set by
  // Confirm.onEnter (with `{actionResult, ctx}`) and cleared by every
  // other save site (which omits opts.pendingAction → defaults to null).
  // null means "no in-progress action card to resume into" — survival
  // falls back to the standard TURN_START / TURN_END branch.
  const pendingAction = (opts.pendingAction === undefined)
    ? null
    : (opts.pendingAction ?? null);

  const state = {
    schemaVersion: SCHEMA_VERSION,
    savedAt: Date.now(),
    sourceSceneId: dc.sourceSceneId ?? null,
    pendingAction,
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
  try {
    await dc.scene.setFlag(FLAG_NS, FLAG_KEY, state);
    log(`persistence.save: dCombat ${dc.id} → scene ${dc.scene.name} (round ${dc.round}, ${dc.combatants.length} combatants)`);
  } catch (e) {
    warn("persistence.save: setFlag failed", e);
  }

  // Push a history entry for the rewind tool. Separate flag, separate
  // write — keeps reload-survival reads cheap (small JSON) and isolates
  // any history-side failure from the reload-survival write that just
  // succeeded above. `skipHistory` lets diagnostic / out-of-band saves
  // opt out (e.g. an internal-only resave that shouldn't clutter the
  // rewind list).
  if (opts.skipHistory) return;
  try {
    const actors = await snapshotCombatantActors(dc);
    const entry = {
      ...state,
      id: foundry.utils?.randomID?.() ?? `hist-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      label: String(opts.label ?? ""),
      description: String(opts.description ?? ""),
      actors,
    };
    await pushToHistory(dc.scene, entry);
  } catch (e) {
    warn("persistence.save: history push failed", e);
  }
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
    if (!actor) {
      warn(`snapshotCombatantActors: actor not resolvable for ${c.name} (${c.actorUuid})`);
      continue;
    }
    const p = actor.system?.props ?? {};
    out.push({
      actorUuid: actor.uuid,
      actorId: actor.id,
      name: actor.name ?? c.name ?? "?",
      props: {
        // Resources
        current_hp:     p.current_hp,
        current_mp:     p.current_mp,
        current_ip:     p.current_ip,
        fabula_points:  p.fabula_points,
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
export async function pushToHistory(scene, entry) {
  if (!scene || !entry) return;
  let current = scene.getFlag(FLAG_NS, HISTORY_KEY);
  if (!Array.isArray(current)) current = [];
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
  for (const sc of state.dCombat.combatants ?? []) {
    let tokenDoc = null;
    let actorDoc = null;
    try { tokenDoc = await fromUuid(sc.tokenUuid); } catch {}
    if (!tokenDoc) {
      droppedNames.push(sc.name ?? sc.tokenUuid);
      warn(`reconstruct: token ${sc.tokenUuid} (${sc.name}) stale, dropping`);
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

    // 2c. Update AEs that exist on both: only push if `disabled`
    //     differs. We intentionally don't try to merge `changes`,
    //     `duration`, etc. — those mutate via Foundry's own update
    //     paths and a Foundry update with stale data would clobber
    //     legitimate in-flight changes. The most common rewind case
    //     is a toggled status (Guard expired, Wet was applied) which
    //     `disabled` covers; deeper rewinds re-create via 2a/2b.
    const aeUpdates = [];
    for (const [id, snapEff] of snapEffectsById) {
      const live = actor.effects?.get?.(id);
      if (!live) continue;
      if (!!live.disabled !== !!snapEff.disabled) {
        aeUpdates.push({ _id: id, disabled: !!snapEff.disabled });
      }
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
  //    the rewind-only fields before writing.
  try {
    const stateOnly = {
      schemaVersion: snapshot.schemaVersion,
      savedAt: snapshot.savedAt,
      sourceSceneId: snapshot.sourceSceneId,
      payload: snapshot.payload,
      dCombat: snapshot.dCombat,
    };
    await scene.setFlag(FLAG_NS, FLAG_KEY, stateOnly);
  } catch (e) {
    warn("rewindToHistorySnapshot: directorState rewrite failed", e);
  }

  return { ok: true, scene, dCombat, snapshot };
}
