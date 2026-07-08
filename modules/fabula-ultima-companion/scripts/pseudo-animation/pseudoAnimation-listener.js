/**
 * [ONI][PseudoAnim] Listener (Foundry VTT v12)
 * - Boots on every client
 * - Listens for socket events on "module.fabula-ultima-companion"
 * - Plays pseudo animations locally on each client
 *
 * DESIGN:
 * - Dynamic mode: payload provides `scriptSource` (JS string) executed on each client.
 * - Optional mode: payload provides `scriptId` (looked up in REGISTRY).
 *
 * SECURITY NOTE (intentional design choice):
 * - `scriptSource` executes code. Only do this if you trust the sender/scripts in your module.
 * - We do NOT pass `game` into the dynamic function by default.
 */

import { buildOni } from "../anim-studio/oni-helpers.js";

(() => {
  const TAG = "[ONI][PseudoAnim][Listener]";
  const SOCKET_NS = "module.fabula-ultima-companion";
  const DEBUG = window.__ONI_PSEUDO_DEBUG__ ?? false;

  function log(...args) { if (DEBUG) console.log(TAG, ...args); }
  function warn(...args) { console.warn(TAG, ...args); }
  function err(...args) { console.error(TAG, ...args); }

  const wait = (ms) => new Promise(r => setTimeout(r, ms));

  // Optional registry (empty by default). You can add presets later if you want.
  const REGISTRY = {};

  // Dedupe guard: prevents double-play on same client (local + socket, or accidental echo)
  globalThis.__ONI_PSEUDO_SEEN_RUNIDS__ ??= new Set();

  // ---------------------------------------------------------------------------
  // Dynamic Script Runner (scriptSource)
  // ---------------------------------------------------------------------------
  async function runDynamicScript(scriptSource, ctx) {
    if (typeof scriptSource !== "string" || !scriptSource.trim()) {
      throw new Error("scriptSource is empty or not a string.");
    }

    // We compile a function that runs an async IIFE containing the scriptSource.
    // The script can use: ctx, canvas, PIXI, AudioHelper, loadTexture, fromUuid,
    // wait, foundry, and `oni` (the Anim Studio helper library — screen-lock,
    // token clone/hide, whiteout, screenshake, sfx, fireDone, …).
    //
    // NOTE: We intentionally do NOT pass `game` here by default.
    // If you need it later, you can add it explicitly as a parameter.
    //
    // `oni` is ADDITIVE: pre-existing scripts don't reference it and are
    // unaffected. New scripts opt in. oni resources auto-dispose after the
    // inner async IIFE resolves (so a script that forgets to clean up still
    // leaves the stage at baseline) — scripts wanting a lingering cosmetic tail
    // must `await` it before returning.
globalThis.__ONI_PSEUDO_FN_CACHE__ ??= new Map();

const cacheKey = scriptSource;
let fn = globalThis.__ONI_PSEUDO_FN_CACHE__.get(cacheKey);

if (!fn) {
  fn = new Function(
    "ctx",
    "canvas",
    "PIXI",
    "FAudioHelper",
    "loadTexture",
    "fromUuid",
    "wait",
    "foundry",
    "oni",
    `
    "use strict";
    return (async () => {
      ${scriptSource}
    })();
    `
  );

  globalThis.__ONI_PSEUDO_FN_CACHE__.set(cacheKey, fn);
}

const audio = foundry?.audio?.AudioHelper ?? globalThis.AudioHelper;

// Build the per-run `oni` helper (snapshots the current stage; binds this
// run's caster/targets). Guarded so a helper-build failure can never break a
// legacy script that doesn't use it.
let oni = null;
try {
  oni = buildOni(ctx, { canvas, PIXI, FAudioHelper: audio, loadTexture, fromUuid, wait, foundry });
} catch (e) {
  warn("buildOni failed (continuing without helpers):", e);
}

try {
  return await fn(ctx, canvas, PIXI, audio, loadTexture, fromUuid, wait, foundry, oni);
} finally {
  try { oni?.dispose?.(); } catch (e) { warn("oni.dispose threw", e); }
}
  }

  // ---------------------------------------------------------------------------
  // Helpers: resolve tokens from UUIDs
  // ---------------------------------------------------------------------------
  async function resolveTokenFromUuid(uuid) {
    if (!uuid) return null;

    const doc = await fromUuid(uuid);
    // doc might be TokenDocument (preferred), or something else
    const tok = doc?.object ?? canvas.tokens?.get(doc?.id) ?? null;
    return tok ?? null;
  }

  async function resolveTokensFromUuids(uuids) {
    const out = [];
    for (const u of (uuids ?? [])) {
      const tok = await resolveTokenFromUuid(u);
      if (tok) out.push(tok);
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Socket Receiver (and local receiver entry point)
  // ---------------------------------------------------------------------------
  async function onSocketMessage(msg) {
    try {
      // Only handle our message type
      if (!msg || msg.type !== "oni.pseudo.play") return;

      const runId = msg.runId ?? "NO_RUNID";

      // Dedupe guard
      if (globalThis.__ONI_PSEUDO_SEEN_RUNIDS__.has(runId)) {
        warn(`SKIP (dedupe) runId=${runId} scriptId=${msg.scriptId}`);
        return;
      }
      globalThis.__ONI_PSEUDO_SEEN_RUNIDS__.add(runId);

      log(`RECV runId=${runId} scriptId=${msg.scriptId ?? "(none)"}`, msg);

      if (!canvas?.ready) {
        throw new Error("Canvas not ready on this client.");
      }

      // Resolve caster + targets
      const casterToken = await resolveTokenFromUuid(msg.casterTokenUuid);
      const targetTokens = await resolveTokensFromUuids(msg.targetTokenUuids);

      // Build context passed to the animation script
      const ctx = {
        runId,
        msg, // raw message for advanced needs
        casterToken,
        targetTokens,
        params: msg.params ?? {},
        meta: msg.meta ?? {},
      };

      // Dynamic script mode
      if (msg.scriptSource) {
        log(`RUN (dynamic) runId=${runId}`, { scriptBytes: msg.scriptSource.length });
        await runDynamicScript(msg.scriptSource, ctx);
        log(`DONE (dynamic) runId=${runId}`);
        return;
      }

      // Optional registry fallback mode
      const scriptId = msg.scriptId;
      const scriptFn = scriptId ? REGISTRY[scriptId] : null;
      if (!scriptFn) {
        throw new Error(
          `No scriptSource provided and unknown scriptId="${scriptId}". ` +
          `Either include msg.scriptSource or register msg.scriptId in REGISTRY.`
        );
      }

      await scriptFn(ctx);
      log(`DONE runId=${runId} scriptId=${scriptId}`);

    } catch (e) {
      err("Socket playback error:", e);
    }
  }

  Hooks.once("ready", () => {
    // Listen for broadcasts from other clients
    game.socket.on(SOCKET_NS, onSocketMessage);

    // Expose local entry point so broadcaster can run it locally (no socket echo)
    game.ONI ??= {};
    game.ONI.pseudo ??= {};
    game.ONI.pseudo._receive = onSocketMessage;

    log("Listener ready. Dynamic scriptSource enabled. Registry keys:", Object.keys(REGISTRY));
  });

})();
