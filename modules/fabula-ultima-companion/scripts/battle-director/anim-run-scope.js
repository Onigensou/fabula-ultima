// ============================================================================
// Animation run scope — which `oni:animationEnd` belongs to which run.
//
// `oni:animationEnd` is a GLOBAL hook. A show that ends late (it held for a
// group save and outlived its turn) emits it during a LATER action; a gate or
// end-watch that listens to any end resolves that later action early.
//
// Every run the director starts is given an id (beginAnimRun). The id is
// published to the script as `payload.animRunId`; a script / outer emitter
// that copies it onto the end (`{ animRunId }`) is matched exactly.
//
// A start / end with NO id (older scripts, scripts that call the hook directly —
// 100+ shipped world scripts) is CLAIMED by exactly one run of the event's
// caster (`sourceTokenId`):
//   - an id-less START goes to the newest run that has not started yet;
//   - an id-less END goes to the newest OPEN run that has STARTED (falling back
//     to the newest open run when none has: a script that emits no start).
// A run is open from beginAnimRun until its end-watch settles (closeAnimRun).
// "Started" matters for same-caster nesting: an outer show can end while the
// nested show is still loading (armed, not started) — that end is the outer's.
//
// Why per caster and per OPEN run, not "the globally newest run": runs NEST.
// A timing_offset outer show resolves its damage at the offset and keeps
// playing; RESOLVE then plays nested shows (a crisis heal, a card reaction, a
// passive) by OTHER casters while the outer's end is still pending. A single
// global "current run" made the outer's id-less end lose to the nested run
// and the outer tail waited the 45 s failsafe. Now:
//   - another caster's newer run never steals the outer's end;
//   - a newer run by the SAME caster still claims the id-less end first (the
//     legacy "superseded" rule); once it settles, the older open run is the
//     newest again, so the next id-less end settles it — every id-less end
//     settles one run, so nothing waits on the failsafe;
//   - an end carrying a non-matching id is always rejected.
// An end with no `sourceTokenId` is claimed by the newest open run of any caster whose
// start was ALSO source-less (or that has not started): a run whose claimed start named a
// caster is only ever ended by an end naming that caster, so another caster's sourced
// nested run cannot eat an outer source-less show's end. A run armed without a caster
// (bench) is a candidate for any end. A run is marked closed synchronously by closeAnimRun,
// so two id-less ends of one synchronous turn each settle their own run.
// ============================================================================

let _seq = 0;
let _current = null;
/** runId -> { caster, seq, started, startSrc, closed } (present = known; closed = settled, awaiting delete) */
const _runs = new Map();
/** id-less event payload -> runId that claimed it (all listeners of one dispatch agree) */
let _claims = new WeakMap();

/**
 * Start a run: mints an id (seeded by the action instance id when known), records its
 * caster (token id, or a token uuid — the id after ".Token." is kept), makes it current.
 */
export function beginAnimRun(actionId = null, caster = null) {
  _seq += 1;
  _current = `${actionId ?? "run"}#${_seq}`;
  const key = caster == null ? null : (String(caster).split(".Token.").pop() || null);
  _runs.set(_current, { caster: key, seq: _seq, started: false, startSrc: null, closed: false });
  return _current;
}

/**
 * The run's end has been seen (or it gave up). Deferred to a microtask so every listener of
 * the SAME synchronous hook dispatch decides against the same set of open runs.
 */
export function closeAnimRun(runId) {
  if (runId == null) return;
  const r = _runs.get(runId);
  if (r) r.closed = true; // synchronously: newest() skips it from now on
  queueMicrotask(() => { _runs.delete(runId); });
}

/** The newest run still open (never a closed one); null when none. */
export function currentAnimRunId() {
  const r = _current != null ? _runs.get(_current) : null;
  return r && !r.closed ? _current : null;
}

/** Test hook: forget all state. */
export function _resetAnimRuns() { _seq = 0; _current = null; _runs.clear(); _claims = new WeakMap(); }

/** Newest open run of `src` that passes `want` (null = none). */
function newest(src, want) {
  let best = null, bestSeq = -1;
  for (const [id, r] of _runs) {
    if (r.closed) continue;
    if (src != null && r.caster != null && r.caster !== src) continue;
    if (!want(r)) continue;
    if (r.seq > bestSeq) { best = id; bestSeq = r.seq; }
  }
  return best;
}

function claim(evtPayload, pick) {
  const isObj = evtPayload != null && typeof evtPayload === "object";
  if (isObj && _claims.has(evtPayload)) return _claims.get(evtPayload);
  const owner = pick(evtPayload?.sourceTokenId ?? null);
  if (isObj && owner != null) _claims.set(evtPayload, owner);
  return owner;
}

/**
 * Does this oni:animationStart payload belong to the run `runId`? Records the start on the
 * owning run (so later id-less ends can tell a started run from one still loading).
 *  - carries an id -> must equal runId
 *  - carries none  -> only if runId is the newest not-yet-started run of the event's caster
 */
export function startBelongsToRun(evtPayload, runId) {
  const id = evtPayload?.animRunId ?? null;
  const owner = id != null ? id : claim(evtPayload, (src) => newest(src, (r) => !r.started));
  const r = owner != null ? _runs.get(owner) : null;
  if (r) { r.started = true; if (r.startSrc == null) r.startSrc = evtPayload?.sourceTokenId != null; }
  if (runId == null) return true; // nothing armed with an id: unscoped (legacy)
  return owner === runId;
}

/**
 * Does this oni:animationEnd payload belong to the run `runId`?
 *  - carries an id -> must equal runId
 *  - carries none  -> only if runId is the newest open STARTED run of the event's caster
 *                     (or, when none has started, the newest open one)
 */
export function endBelongsToRun(evtPayload, runId) {
  if (runId == null) return true; // nothing armed with an id: unscoped (legacy)
  const id = evtPayload?.animRunId ?? null;
  if (id != null) return id === runId;
  // A source-less end skips runs whose claimed start carried a caster (startSrc === true).
  const ok = (src) => (r) => src != null || r.startSrc !== true;
  return claim(evtPayload, (src) => newest(src, (r) => r.started && ok(src)(r)) ?? newest(src, ok(src))) === runId;
}
