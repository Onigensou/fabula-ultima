// Legacy-listener suppressor.
//
// When the Battle Director is active, the legacy battle subsystems (turn UI,
// reaction manager, turn emitter, initiative controller, etc.) would normally
// still fire their Foundry hook handlers in response to document mutations
// that the director makes. That produces duplicate UI, phantom reaction
// menus, and conflicting turn-state writes.
//
// This module finds those legacy handlers by inspecting the registered hook
// functions' .toString() against known signature regexes, snapshots them,
// and removes them via Hooks.off. On restore(), they go back in via Hooks.on.
//
// Importantly: we do NOT touch the legacy code itself. We only manipulate the
// runtime hook registry that Foundry maintains. The legacy modules are still
// loaded, their other (non-suppressed) hooks still work, and their public
// APIs remain available — they just stop reacting to combat/actor changes
// while director is running.
//
// What we DO NOT suppress (kept active by design):
//   - auto-crisis-detection — real game mechanic, harmless to keep
//   - auto-defeat            — marks tokens defeated, fine
//   - cutin-receiver         — cinematic UI, harmless
//   - free-action-state      — director ignores it, harmless

import { log, warn } from "./logger.js";

// Each target lists:
//   hookName: the Foundry hook event name
//   match:    regex against the handler fn.toString() — identifies the
//             specific legacy handler we want to suppress
//   label:    human-readable label for logging
const TARGETS = [
  // ── turn-ui-manager.js (spawns gold Octopath UI) ────────────────────────
  // Suppress: the updateCombat that triggers handleTurnChange + button spawn,
  // and the canvasReady that re-syncs UI. Leave the combatStart SFX cache
  // and the combatEnd/deleteCombat cleanup alone — they're harmless.
  { hookName: "updateCombat", match: /handleTurnChange|TurnUI\.state\.currentTokenId/, label: "turn-ui-manager:updateCombat" },
  { hookName: "canvasReady",  match: /TurnUI\.state\.currentTokenId|clearAllUI/, label: "turn-ui-manager:canvasReady" },

  // ── reaction-manager.js (phase emit, autoPassive, button offers) ────────
  { hookName: "oni:reactionPhase", match: /collectReactionsForTrigger|AutoPassiveManager|reaction-manager|_gmReactionWindows/, label: "reaction-manager:oni:reactionPhase" },

  // ── reaction-phaseHandler.js (lifecycle phase emitter) ──────────────────
  // This module has SIX hook listeners that all call `emitReactionPhase`.
  // That function name is unique to reaction-phaseHandler, so a single
  // broad pattern catches every listener without false positives on other
  // modules' handlers.
  { hookName: "oni:reactionPhase",  match: /emitReactionPhase|stampPhasePayload|emitPhaseSequential|phaseHandler/i, label: "reaction-phaseHandler:oni:reactionPhase" },
  { hookName: "combatStart",        match: /emitReactionPhase/, label: "reaction-phaseHandler:combatStart" },
  { hookName: "preDeleteCombat",    match: /emitReactionPhase/, label: "reaction-phaseHandler:preDeleteCombat" },
  { hookName: "combatRound",        match: /emitReactionPhase/, label: "reaction-phaseHandler:combatRound" },
  { hookName: "preUpdateCombat",    match: /emitReactionPhase|previousTurnState/, label: "reaction-phaseHandler:preUpdateCombat" },
  { hookName: "updateCombat",       match: /emitReactionPhase/, label: "reaction-phaseHandler:updateCombat" },

  // ── cutin-receiver.js (preloads cut-in textures + plays cut-in cinematics)
  // The combatStart listener iterates combatants and preloads cut_in_*
  // textures for each actor. With director mode having no cut-in support,
  // this just spams 404 errors for missing files and adds latency.
  { hookName: "combatStart",  match: /cut_in_critical|SFX_URLS\[|FU Cut-In|cutin/, label: "cutin-receiver:combatStart" },

  // ── encyclopedia-core.js — adds enemies to the encyclopedia on combatStart
  { hookName: "combatStart",  match: /handleCombatStart|encyclopedia/, label: "encyclopedia:combatStart" },

  // ── animation-asset-cache.js — auto-preload on combatStart. We do our own
  // preload via prepareUrlsAcrossClients in director-init, so this auto-fire
  // is at best redundant, at worst hides the curtain timing we just fixed.
  { hookName: "combatStart",  match: /animation-asset-cache|animationCache|preloadUrls/, label: "animation-asset-cache:combatStart" },

  // ── fabula-initiative-autoUntarget.js — Foundry-V12 specific hook names
  { hookName: "combatTurnChange", match: /autoUntarget|auto-untarget/, label: "fabula-init-autoUntarget:combatTurnChange" },
  { hookName: "combatRound",      match: /autoUntarget|auto-untarget/, label: "fabula-init-autoUntarget:combatRound" },

  // ── fabula-initiative-round-announcer.js — round banner cinematic
  { hookName: "combatRound",      match: /roundAnnouncer|round-announcer/, label: "fabula-init-roundAnnouncer:combatRound" },

  // ── fabula-initiative-turn-emitter.js — combatRound write
  { hookName: "combatRound",      match: /turnState|writeTurnState|combatSerial|roundSerial/, label: "fabula-init-emitter:combatRound" },

  // ── fabula-initiative-controller.js (legacy initiative UI) ──────────────
  { hookName: "combatStart",      match: /fabulaInitiative|initiativeController|setupInitiativeUI/, label: "fabula-initiative-controller:combatStart" },
  { hookName: "updateCombat",     match: /fabulaInitiative|initiativeController/, label: "fabula-initiative-controller:updateCombat" },
  { hookName: "updateCombatant",  match: /fabulaInitiative|initiativeController/, label: "fabula-initiative-controller:updateCombatant" },
  { hookName: "canvasReady",      match: /fabulaInitiative|initiativeController/, label: "fabula-initiative-controller:canvasReady" },
  { hookName: "combatEnd",        match: /fabulaInitiative|initiativeController/, label: "fabula-initiative-controller:combatEnd" },
  { hookName: "deleteCombat",     match: /fabulaInitiative|initiativeController/, label: "fabula-initiative-controller:deleteCombat" },

  // ── fabula-initiative-turn-emitter.js (writes turnState combat flags) ───
  { hookName: "preUpdateCombat",  match: /turnState|writeTurnState|previousTurn|turnSerial/, label: "fabula-init-emitter:preUpdateCombat" },
  { hookName: "updateCombat",     match: /turnState|writeTurnState|bumpActionsUsedThisTurn|turnSerial/, label: "fabula-init-emitter:updateCombat" },
  { hookName: "deleteCombat",     match: /turnState|emit.{0,10}combatEnded|writeTurnState/, label: "fabula-init-emitter:deleteCombat" },
  { hookName: "combatRound",      match: /turnState|writeTurnState/, label: "fabula-init-emitter:combatRound" },

  // ── fabula-initiative-round-announcer.js (round banner) ────────────────
  { hookName: "preUpdateCombat",  match: /roundAnnouncer|round-announcer/, label: "fabula-init-roundAnnouncer:preUpdateCombat" },
  { hookName: "updateCombat",     match: /roundAnnouncer|round-announcer/, label: "fabula-init-roundAnnouncer:updateCombat" },

  // ── fabula-initiative-autoUntarget.js ───────────────────────────────────
  { hookName: "updateCombat",     match: /autoUntarget|auto-untarget/, label: "fabula-init-autoUntarget:updateCombat" },
  { hookName: "deleteCombat",     match: /autoUntarget|auto-untarget/, label: "fabula-init-autoUntarget:deleteCombat" },

  // ── creature-defeated-emitter.js (emits creature_defeated trigger) ──────
  { hookName: "preUpdateActor",   match: /creature[_-]?defeated|defeatedEmitter/, label: "creature-defeated-emitter:preUpdateActor" },
  { hookName: "updateActor",      match: /creature[_-]?defeated|defeatedEmitter/, label: "creature-defeated-emitter:updateActor" },
];

// Snapshot of suppressed entries. Each is { hookName, fn } captured before
// we Hooks.off'd it. restore() re-adds via Hooks.on.
let SUPPRESSED = [];
let _active = false;

// Try several known access patterns for Foundry's internal hook registry,
// since V12 + module patches sometimes change the shape. We return the first
// shape that yields a non-empty array for the asked hook name. Logs the
// shape we settle on once per session for diagnosis.
let _hookAccessProbed = false;
let _hookAccess = null;  // (name) => Array<entry>

function probeHookAccess() {
  if (_hookAccessProbed) return _hookAccess;
  _hookAccessProbed = true;

  // Pick a hook name that's basically guaranteed to have at least one
  // listener registered by Foundry/modules — "ready" or "init" usually do.
  // We probe with several candidate names so we don't get false negatives
  // from a name that nobody is listening for.
  const probeNames = ["ready", "renderChatLog", "canvasReady", "init", "updateCombat"];

  const candidates = [
    // V12 default: plain object
    { name: "Hooks._hooks[name]", get: (n) => Hooks?._hooks?.[n] },
    // V12 alt: a Map
    { name: "Hooks._hooks.get(name)", get: (n) => Hooks?._hooks?.get?.(n) },
    // Hypothetical: `events` getter
    { name: "Hooks.events[name]", get: (n) => Hooks?.events?.[n] },
    // Hypothetical: id index
    { name: "Hooks._idsByEvent[name]", get: (n) => {
      const ids = Hooks?._idsByEvent?.get?.(n) ?? Hooks?._idsByEvent?.[n];
      if (!ids) return null;
      const reg = Hooks?._ids;
      if (!reg) return null;
      const out = [];
      for (const id of ids) {
        const entry = reg.get?.(id) ?? reg[id];
        if (entry) out.push(entry);
      }
      return out;
    } },
  ];

  for (const cand of candidates) {
    let foundAny = false;
    for (const probe of probeNames) {
      const v = cand.get(probe);
      if (Array.isArray(v) && v.length > 0) { foundAny = true; break; }
    }
    if (foundAny) {
      log(`hook-access: using ${cand.name}`);
      _hookAccess = cand.get;
      return _hookAccess;
    }
  }

  // Last resort — log what we DO see so we can debug. Then fall back to the
  // V12-default plain-object path.
  warn("hook-access: no candidate yielded results. Diagnostic dump:");
  try {
    warn("  Hooks keys:", Object.getOwnPropertyNames(Hooks).filter(k => !k.startsWith("__")));
    warn("  Hooks._hooks type:", typeof Hooks?._hooks, Hooks?._hooks ? Object.prototype.toString.call(Hooks._hooks) : "");
    if (Hooks?._hooks) warn("  Hooks._hooks keys (first 20):", Object.keys(Hooks._hooks).slice(0, 20));
  } catch (e) { warn("  dump threw", e); }
  _hookAccess = (n) => Hooks?._hooks?.[n];
  return _hookAccess;
}

function getHookList(name) {
  const access = probeHookAccess();
  const list = access(name);
  return Array.isArray(list) ? list.slice() : [];
}

// Pull the actual handler function out of whatever shape Foundry's hook
// registry uses. V12 has been observed to use objects with .hook OR .fn,
// plain functions, and (rarely) numeric ids paired with a separate _ids
// lookup. Returns null if nothing usable is found.
function entryFn(entry) {
  if (entry == null) return null;
  if (typeof entry === "function") return entry;
  // Object with a function-typed field
  for (const key of ["hook", "fn", "handler", "callback", "cb", "h"]) {
    const v = entry[key];
    if (typeof v === "function") return v;
  }
  // Last-ditch: maybe entry IS the id and we need to look it up in Hooks._ids
  if (typeof entry === "number" || typeof entry === "string") {
    const reg = Hooks?._ids;
    if (reg) {
      const found = reg.get?.(entry) ?? reg[entry];
      if (typeof found === "function") return found;
      if (typeof found?.hook === "function") return found.hook;
      if (typeof found?.fn === "function") return found.fn;
    }
  }
  return null;
}

// One-time shape diagnostic. Logged the first time we successfully grab a
// non-empty hook list, so we can see what the entries actually look like
// when something's not matching.
let _entryShapeLogged = false;
function logEntryShapeOnce(hookName, list) {
  if (_entryShapeLogged) return;
  if (!list?.length) return;
  _entryShapeLogged = true;
  const first = list[0];
  const t = typeof first;
  let keys = null;
  if (first && t === "object") {
    try { keys = Object.keys(first); } catch {}
  }
  log(`entry-shape probe (hook=${hookName}):`, {
    type: t,
    isFunction: typeof first === "function",
    keys,
    sampleHookType: typeof first?.hook,
    sampleFnType: typeof first?.fn,
    sampleHandlerType: typeof first?.handler,
    extracted: typeof entryFn(first),
    // Hint at what id field might be available for Hooks.off
    sampleId: first?.id,
  });
}

export function suppress() {
  if (_active) {
    warn("legacy-suppressor.suppress called while already active — skipping");
    return 0;
  }
  SUPPRESSED = [];
  let count = 0;
  // Diagnostics — totals so we can tell where we lose entries.
  let totalEntriesSeen = 0;
  let entriesWithFn = 0;
  let regexMatches = 0;
  let entriesWithoutFn = 0;
  for (const target of TARGETS) {
    const list = getHookList(target.hookName);
    if (list.length) logEntryShapeOnce(target.hookName, list);
    for (const entry of list) {
      totalEntriesSeen++;
      const fn = entryFn(entry);
      if (!fn) { entriesWithoutFn++; continue; }
      entriesWithFn++;
      try {
        const src = String(fn);
        if (target.match.test(src)) {
          regexMatches++;
          // Try Hooks.off by id (V12 supports this); fall back to by fn.
          let removed = false;
          try {
            if (entry?.id != null) {
              Hooks.off(target.hookName, entry.id);
              removed = true;
            }
          } catch (e) { /* fall through */ }
          if (!removed) {
            try { Hooks.off(target.hookName, fn); removed = true; } catch (e) { /* */ }
          }
          if (removed) {
            SUPPRESSED.push({ hookName: target.hookName, fn, label: target.label });
            count++;
            log(`Suppressed: ${target.label}`);
          } else {
            warn(`Matched ${target.label} but Hooks.off failed (id=${entry?.id})`);
          }
        }
      } catch (e) {
        warn("suppressor matcher threw for", target.label, e);
      }
    }
  }
  _active = true;
  log(`Suppressed ${count} legacy hook handlers (entries seen: ${totalEntriesSeen}, extractable fns: ${entriesWithFn}, regex matches: ${regexMatches}, no-fn entries: ${entriesWithoutFn})`);
  return count;
}

export function restore() {
  if (!_active) {
    warn("legacy-suppressor.restore called while not active — skipping");
    return 0;
  }
  let count = 0;
  for (const { hookName, fn, label } of SUPPRESSED) {
    try {
      Hooks.on(hookName, fn);
      count++;
    } catch (e) {
      warn(`restore failed for ${label}`, e);
    }
  }
  SUPPRESSED = [];
  _active = false;
  log(`Restored ${count} legacy hook handlers`);
  return count;
}

export function isActive() { return _active; }

// Diagnostic — list currently-suppressed entries.
export function snapshot() {
  return SUPPRESSED.map(({ hookName, label }) => ({ hookName, label }));
}

// Diagnostic — list all currently-registered hook handlers for a given hook
// name, with their function source truncated so you can identify which
// legacy module they belong to. Use this to find leaks: if you see noise
// during director combat, call dumpHooks("combatStart") (or whatever hook)
// and see what's still subscribed.
//
// Usage:
//   FUCompanion.api.experimental.battleDirector.legacySuppressor.dumpHooks("combatStart")
//
// Returns Array<{ index, snippet, length }>.
export function dumpHooks(hookName, { maxChars = 240 } = {}) {
  const list = getHookList(hookName);
  if (!list.length) return [];
  return list.map((entry, i) => {
    const fn = entryFn(entry);
    const src = String(fn ?? "(no fn)");
    return {
      index: i,
      length: src.length,
      snippet: src.length > maxChars ? src.slice(0, maxChars) + "…" : src,
    };
  });
}
