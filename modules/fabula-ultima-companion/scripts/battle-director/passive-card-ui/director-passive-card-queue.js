// Battle Director — Passive Card UI queue.
//
// FIFO queue for pending passive card display requests. Matches the
// freeActionQueue module shape (peek / isEmpty / size / clear / snapshot)
// with an integrated self-draining loop.
//
// The drain function is injected by director-passive-card-ui.js via
// setCardDrainFn() at boot. When called per entry it must resolve after
// the card's enter animation (≈ enterMs ms) so the next card does not
// begin before the previous one is visibly on screen.
//
// PassiveCardSpec shape:
//   { title, tokenUuid, icon, holdMs, enterMs, exitMs, exitBufferMs, runId }

import { log, warn } from "../logger.js";

const _queue = [];
let _draining = false;
let _drainFn  = null;

export function setCardDrainFn(fn) {
  _drainFn = fn;
}

async function _drain() {
  if (_draining) return;
  _draining = true;
  try {
    while (_queue.length > 0) {
      const entry = _queue[0];
      try {
        if (_drainFn) await _drainFn(entry.spec);
      } catch (e) {
        warn("[BD][PassiveCardQueue] drainFn threw for", entry.spec?.title, e);
      } finally {
        try { entry.resolve?.(); } catch (_) {}
        if (_queue[0] === entry) _queue.shift();
      }
    }
  } finally {
    _draining = false;
  }
}

// Enqueue a card spec and return a Promise that resolves after the drain
// function processes this entry (i.e. after the enter animation finishes).
export function enqueueCard(spec) {
  return new Promise((resolve) => {
    _queue.push({ spec, resolve });
    log(`[BD][PassiveCardQueue] enqueued "${spec.title ?? "?"}" (queue len ${_queue.length})`);
    _drain().catch((e) => warn("[BD][PassiveCardQueue] _drain threw", e));
  });
}

// Diagnostic / teardown surface — mirrors freeActionQueue shape.
export const passiveCardQueue = {
  peek()    { return _queue[0]?.spec ?? null; },
  isEmpty() { return _queue.length === 0; },
  size()    { return _queue.length; },
  clear() {
    if (!_queue.length) return;
    log(`[BD][PassiveCardQueue] clearing ${_queue.length} pending entry(s)`);
    for (const e of _queue) { try { e.resolve?.(); } catch (_) {} }
    _queue.length = 0;
  },
  snapshot() { return _queue.map((e) => ({ ...e.spec })); },
};
