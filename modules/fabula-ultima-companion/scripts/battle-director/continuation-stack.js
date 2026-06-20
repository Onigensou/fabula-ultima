// Battle Director — continuation stack.
//
// A `ContinuationFrame` is a "where do I return to when the current
// sub-flow finishes" marker. Each frame captures (a) which FSM state
// owns the resume, (b) a snapshot of ctx fields that the sub-flow is
// going to overwrite, and (c) optional reason-specific extras
// (free-action request, reactor id, ...).
//
// The stack lives on `ctx.continuationStack`. Empty stack ==
// "we're at top-level: regular turn flow". Top of stack == "the most
// recent suspended layer." Popping a frame restores the snapshotted
// fields and is expected to be followed by a transition to the frame's
// `resumeAt` state.
//
// This module replaces seven ad-hoc ctx fields that previously encoded
// the SRW↔FAW loop:
//   `_freeActionPopped`, `freeActionMode`, `_savedTurnSnapshot`,
//   `_savedActionResult`, `_srwFinalTarget`, `_postFreeActionTarget`,
//   and the destructive `standaloneAfter` mutation in SRW's detour
//   branch.
//
// With the stack:
//   - Nested free actions become a stack of multiple `freeAction:*`
//     frames; the engine doesn't need a per-depth slot.
//   - Mid-action interrupts (on-crit counter, on-damage reposition)
//     can push a frame from any state and pop back into the original
//     state's pipeline.
//   - Save / resume becomes declarative: persist the stack as data;
//     resume reads `top.resumeAt` and transitions there.
//
// Reasons are namespaced strings: "freeAction:<sourceLabel>",
// "srwDetour:<trigger>", future "interrupt:<kind>". The prefix lets
// transition predicates ask "is top a free-action frame?" without
// matching exact source labels.
//
// Frames are plain data — no functions, no live doc references — so
// they round-trip through `setFlag` unchanged.

import { log, warn } from "./logger.js";

const STACK_KEY = "continuationStack";

// ── Inspect-only helpers (ctx-taking) ─────────────────────────────────
//
// These take ctx directly so state-machine transition predicates can
// call them without a director reference. Mutate-helpers below take
// director because they also log.

function _stackOf(ctx) {
  if (!ctx) return [];
  if (!Array.isArray(ctx[STACK_KEY])) ctx[STACK_KEY] = [];
  return ctx[STACK_KEY];
}

export function getStack(ctx) {
  return _stackOf(ctx);
}

export function peekTop(ctx) {
  const stack = _stackOf(ctx);
  return stack.length ? stack[stack.length - 1] : null;
}

export function stackDepth(ctx) {
  return _stackOf(ctx).length;
}

// Returns true if top of stack is a frame whose reason starts with
// the given prefix. Used by state transition predicates to ask
// "are we in a free-action sub-flow?" without spelling out the
// source label.
export function topReasonStartsWith(ctx, prefix) {
  const top = peekTop(ctx);
  if (!top || typeof top.reason !== "string") return false;
  return top.reason.startsWith(prefix);
}

export function topIsFreeAction(ctx) {
  return topReasonStartsWith(ctx, "freeAction:");
}

export function topIsSrwDetour(ctx) {
  return topReasonStartsWith(ctx, "srwDetour:");
}

// Top frame is a `resolveDetour:` marker — pushed by REACTION_WINDOW when a
// post-resolve (post-action-card) reaction queued a free action and we detour
// through FREE_ACTION_WINDOW to drain it. Mirrors srwDetour for the lifecycle
// (SRW) loop: the post-resolve reaction window re-enters itself after the
// queued action(s) resolve so it can re-offer the remaining reactions.
export function topIsResolveDetour(ctx) {
  return topReasonStartsWith(ctx, "resolveDetour:");
}

// Walk the stack bottom-up and return the trigger label of the
// outermost `srwDetour:` frame (e.g. "conflict_start", "turn_start").
// Returns null if no SRW frame is present.
//
// Used by rewind-label generation: any save that fires while a
// conflict_start detour is on the stack happens BEFORE the first
// Round 1 turn picker, so the rewind list should label it
// "Conflict Start" rather than the misleading "Round 1 · ...". Same
// applies to mid-turn-start free actions, though we currently only
// special-case conflict_start in the callers.
export function findOutermostSrwTrigger(ctx) {
  const stack = _stackOf(ctx);
  for (const frame of stack) {
    if (typeof frame?.reason === "string" && frame.reason.startsWith("srwDetour:")) {
      return frame.reason.slice("srwDetour:".length);
    }
  }
  return null;
}

// Phase-label helper for the rewind history. Returns:
//   "Conflict Start" — any save fired while a conflict_start detour
//                      frame sits on the stack (e.g. HS free Attack
//                      that fires before the first TURN_START)
//   `Round <N>`      — otherwise; the normal in-combat label
// Callers concatenate further detail (combatant name, action verb).
export function rewindPhaseLabel(ctx, round) {
  const trigger = findOutermostSrwTrigger(ctx);
  if (trigger === "conflict_start") return "Conflict Start";
  return `Round ${round ?? 0}`;
}

// ── Push / pop (director-taking, log-emitting) ─────────────────────────

// Snapshot the listed ctx fields into a frame, then push.
//
// Caller is responsible for setting up the new ctx state for the
// sub-flow AFTER push (e.g. FAW overwrites turnSnapshot+actionResult
// with the reactor's view).
//
// `fieldsToSnapshot` is an array of ctx keys whose values the
// sub-flow may mutate; popping restores them. The snapshot stores
// `undefined` for keys that were unset; popping deletes them rather
// than assigning `undefined` so the field stays unset.
//
// `extra` is reason-specific opaque data — frame.extra survives
// round-trips so the popping handler can read it (e.g. the request
// + reactorActorId for free-action frames).
export function pushFrame(director, { reason, resumeAt, fieldsToSnapshot = [], extra = null }) {
  const ctx = director?.ctx;
  if (!ctx) throw new Error("pushFrame: director.ctx missing");
  const stack = _stackOf(ctx);
  const snapshot = {};
  for (const key of fieldsToSnapshot) {
    snapshot[key] = ctx[key];   // may be undefined → restored as delete
  }
  const frame = {
    reason: String(reason ?? "unknown"),
    resumeAt: resumeAt ?? null,
    snapshot,
    extra: extra ?? null,
    depth: stack.length,
  };
  stack.push(frame);
  log(`continuationStack: push "${frame.reason}" → resume at ${frame.resumeAt} (depth ${stack.length})`);
  return frame;
}

// Pop the top frame and restore its snapshot to ctx. Returns the
// popped frame so the caller can read `extra` and `resumeAt`. The
// caller is responsible for transitioning the FSM to `resumeAt`.
//
// Snapshot fields with `undefined` value are deleted from ctx, so
// "pushed when X was unset, popped now" leaves X unset (no orphan
// undefined value).
export function popFrame(director) {
  const ctx = director?.ctx;
  if (!ctx) return null;
  const stack = _stackOf(ctx);
  if (!stack.length) return null;
  const frame = stack.pop();
  for (const [key, value] of Object.entries(frame.snapshot ?? {})) {
    if (value === undefined) delete ctx[key];
    else ctx[key] = value;
  }
  log(`continuationStack: pop "${frame.reason}" — restored ${Object.keys(frame.snapshot ?? {}).length} field(s) (depth now ${stack.length})`);
  return frame;
}

// ── Serialisation ──────────────────────────────────────────────────────
//
// Frames are plain objects of plain values. The save layer (persistence.js)
// just JSON-clones the array; rehydration is a no-op assignment.

export function serializeStack(ctx) {
  const stack = _stackOf(ctx);
  // Defensive deep-clone via JSON round-trip so the saved blob can't
  // accidentally carry references to live ctx fields if a snapshot
  // accidentally captured one. Frames are small (<1KB each typically).
  try {
    return JSON.parse(JSON.stringify(stack));
  } catch (e) {
    warn("continuationStack: serialize failed", e);
    return [];
  }
}

// Replace the stack with a previously-serialised array. Does NOT
// restore snapshots — the resume path reads `top.resumeAt`, transitions
// the FSM there, and the handler at that state pops as needed.
export function rehydrateStack(director, serialized) {
  const ctx = director?.ctx;
  if (!ctx) return;
  if (!Array.isArray(serialized)) {
    ctx[STACK_KEY] = [];
    return;
  }
  ctx[STACK_KEY] = serialized.map((f) => ({
    reason: String(f?.reason ?? "unknown"),
    resumeAt: f?.resumeAt ?? null,
    snapshot: (f && typeof f.snapshot === "object" && f.snapshot) ? { ...f.snapshot } : {},
    extra: f?.extra ?? null,
    depth: Number.isFinite(f?.depth) ? f.depth : 0,
  }));
  log(`continuationStack: rehydrated ${ctx[STACK_KEY].length} frame(s)`);
}

// Clear the stack — used by `director.stop()` and combat-end cleanup.
export function clearStack(ctx) {
  if (!ctx) return;
  ctx[STACK_KEY] = [];
}

// ── Migration: legacy freeActionContext → stack ────────────────────────
//
// Old saves (schemaVersion 1) carry a `freeActionContext.flags` blob
// with `_freeActionPopped`, `_savedTurnSnapshot`, `_savedActionResult`,
// `_srwFinalTarget`, `_postFreeActionTarget`, `freeActionMode`,
// `standaloneTrigger`, `standaloneAfter`, `standalonePayload`. Synthesize
// equivalent stack frame(s) so existing in-flight battles resume
// correctly after the upgrade.
//
// The old shape encodes (at most) two suspended layers:
//   - An outer SRW dispatching a standalone trigger (e.g. enemy_starts_turn)
//     that detoured through FAW. Marker: `_srwFinalTarget` non-null.
//   - An inner free-action setup currently in flight or completed-pending-
//     teardown. Marker: `_freeActionPopped` non-null.
//
// Both markers can co-exist (the SRW detour pushes BEFORE FAW pops).
// We synthesize frames bottom-up so the resulting stack matches what
// the new push order would have produced.
export function migrateFreeActionContextToStack(director, freeActionContext) {
  if (!freeActionContext?.flags) return false;
  const f = freeActionContext.flags;
  const stack = [];

  // Outer SRW detour frame — present when `_srwFinalTarget` was set.
  if (f._srwFinalTarget != null) {
    stack.push({
      reason: `srwDetour:${f.standaloneTrigger ?? "?"}`,
      resumeAt: "STANDALONE_REACTION_WINDOW",
      snapshot: {
        // The SRW re-entry restores these to continue its dispatch loop.
        standaloneTrigger: f.standaloneTrigger ?? null,
        standaloneAfter: f._srwFinalTarget,   // the ORIGINAL "after" target
        standalonePayload: f.standalonePayload ?? null,
      },
      extra: {
        // _postFreeActionTarget == STANDALONE_REACTION_WINDOW in the
        // legacy detour pattern; we preserve in extra for diagnostic
        // visibility only — the new path doesn't read it.
        legacyPostFreeActionTarget: f._postFreeActionTarget ?? null,
      },
      depth: 0,
    });
  }

  // Inner free-action frame — present when `_freeActionPopped` was set.
  if (f._freeActionPopped != null) {
    stack.push({
      reason: `freeAction:${f._freeActionPopped?.sourceLabel ?? "?"}`,
      resumeAt: "FREE_ACTION_WINDOW",
      snapshot: {
        // FAW's teardown restores these to the original turn-owner's view.
        turnSnapshot: f._savedTurnSnapshot,
        actionResult: f._savedActionResult,
      },
      extra: {
        request: f._freeActionPopped,
        reactorActorId: f._freeActionPopped?.reactorActorId ?? null,
      },
      depth: stack.length,
    });
  }

  if (!stack.length) return false;
  const ctx = director?.ctx;
  if (!ctx) return false;
  ctx[STACK_KEY] = stack;
  log(`continuationStack: migrated legacy freeActionContext → ${stack.length} frame(s)`);
  return true;
}
