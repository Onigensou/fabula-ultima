// ============================================================================
// Clock System — public API + bootstrap.
//
//     FUCompanion.api.clocks.create(...)
//     game.modules.get("fabula-ultima-companion").api.clocks.create(...)
//
// This is the whole contract. Everything below the API — the model, the store,
// the check rules — is an implementation detail; everything above it (the
// bundled bar UI, the GM manager, the Battle Director automation bridge) is a
// consumer with no privileged access.
//
// ── The decoupling seam ─────────────────────────────────────────────────────
// The bundled UI is nothing but the first subscriber to `fu-clock-changed`. A
// downstream system that wants its own clock rendering disables ours and
// listens to the same hooks. This file never imports a renderer, and no
// renderer is required for the engine to work.
//
//     Hooks.on("fu-clock-created",  ({ clock }) => ...);
//     Hooks.on("fu-clock-changed",  ({ clock, previous, delta, cause, side }) => ...);
//     Hooks.on("fu-clock-resolved", ({ clock, resolution }) => ...);
//     Hooks.on("fu-clock-discarded",({ clock, destroyed }) => ...);
//
// ── Who may write ───────────────────────────────────────────────────────────
// Only the active GM writes the registry. Until the socket layer lands (phase
// 4), a mutation called on a player client warns and returns null. Reads and
// `previewCheck` work everywhere, on every client, with no gate.
//
// ── Quick start ─────────────────────────────────────────────────────────────
//     const c = await FUCompanion.api.clocks.create(
//       FUCompanion.api.clocks.preset.threat({ name: "Ambushed!" }));
//
//     // Valea rolls a 6 against DL 10 → the GM fills two sections.
//     await FUCompanion.api.clocks.applyCheck(c.id, { result: 6, difficulty: 10 });
//
//     // What would a 14 have done? (no write, any client)
//     FUCompanion.api.clocks.previewCheck(c.id, { result: 14, difficulty: 10 });
// ============================================================================

import * as store from "./clock-store.js";
import * as model from "./clock-model.js";
import * as check from "./clock-check.js";
import {
  CLOCK_MODULE_ID, CLOCK_TAG, CLOCK_HOOK, SIDE, POLE, OUTCOME,
  CLOCK_STATE, LIFECYCLE, GROUP_MODE, GROUP_ROLE, VISIBILITY,
  EVENT_SECTIONS_MINOR, EVENT_SECTIONS_MAJOR,
} from "./clock-const.js";

/** Default a `scene`-lifecycle clock to the scene it was born on. */
function _stampScene(spec) {
  if (spec.lifecycle !== LIFECYCLE.SCENE || spec.sceneId) return spec;
  return { ...spec, sceneId: canvas?.scene?.id ?? game.scenes?.current?.id ?? null };
}

const api = {
  // ── Reads (any client) ────────────────────────────────────────────────────
  get: (id) => store.get(id),
  list: (filter) => store.list(filter),
  all: () => store.all(),
  siblings: (clock) => store.siblings(clock),

  // ── Writes (active GM) ────────────────────────────────────────────────────

  /**
   * Create a clock from a spec or a `preset.*()` product.
   * @returns {Promise<object|null>} the stored clock, or null if refused.
   */
  create: (spec = {}) => store.create(_stampScene(spec)),

  /**
   * Advance by `sections`, signed toward `side`'s OWN pole. Negative pulls it
   * back (RAW "Turning Back a Clock"). Pass `direction` only when the acting
   * side owns no pole — combining it with a negative `sections` double-negates.
   */
  advance: (id, opts) => store.advance(id, opts),

  /** Sugar: pull a clock back, away from `side`'s pole. */
  turnBack: (id, { side, sections = 1, ...rest } = {}) =>
    store.advance(id, { side, sections: -Math.abs(sections), ...rest }),

  /**
   * RAW "Other Events": the GM may fill or erase one section for an event, or
   * two for a major one, with no check involved.
   */
  event: (id, { side, major = false, erase = false, ...rest } = {}) => {
    const n = major ? EVENT_SECTIONS_MAJOR : EVENT_SECTIONS_MINOR;
    return store.advance(id, { ...rest, side, sections: erase ? -n : n, cause: rest.cause ?? "event" });
  },

  set: (id, value, opts) => store.set(id, value, opts),
  resolve: (id, pole, opts) => store.resolve(id, pole, opts),
  reopen: (id) => store.reopen(id),
  discard: (id, opts) => store.discard(id, opts),
  destroy: (id) => store.destroy(id),

  // ── Checks ────────────────────────────────────────────────────────────────

  /**
   * Apply a Fabula Ultima check (core p.53). Fans out across a `paired` group.
   * The advancing side is derived from the clock's poles; a progress clock
   * ignores your failures and a threat clock ignores your successes.
   *
   * @param {object} spec
   * @param {number} spec.result                  the check Result
   * @param {number} [spec.difficulty]            DL — or pass `opposedResult`
   * @param {number} [spec.opposedResult]         opposed check; ties fail
   * @param {boolean} [spec.isCritical]
   * @param {boolean} [spec.isFumble]
   * @param {boolean} [spec.spendOpportunity]     opt-in; +2 sections
   * @param {string} [spec.cause]                 recorded in the clock's history
   * @returns {Promise<object[]|null>} one result per touched clock
   */
  applyCheck: (id, spec) => store.check(id, spec),

  /** Same math, no write, no GM gate. For pre-roll previews. */
  previewCheck: (id, spec) => store.preview(id, spec),

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  sweep: (lifecycle, opts) => store.sweep(lifecycle, opts),
  sweepScene: (sceneId, opts) => store.sweepScene(sceneId ?? canvas?.scene?.id, opts),
  purgeDiscarded: () => store.purgeDiscarded(),

  // ── Pure helpers (no world access; usable in tests + previews) ─────────────
  preset: model.preset,
  makeClock: model.makeClock,
  resolutionFor: model.resolutionFor,
  signFor: model.signFor,
  poleFor: model.poleFor,
  readCheck: check.readCheck,
  checkSections: check.checkSections,
  sideAdvancingOn: check.sideAdvancingOn,

  // ── Enums, so consumers never hardcode strings ────────────────────────────
  SIDE, POLE, OUTCOME, CLOCK_STATE, LIFECYCLE, GROUP_MODE, GROUP_ROLE, VISIBILITY,
  HOOK: CLOCK_HOOK,

  /** True on the one GM client that owns registry writes. */
  get isWriter() { return store.isActiveGM(); },
};

function ensureModuleApi() {
  const mod = game.modules?.get(CLOCK_MODULE_ID);
  if (!mod) return null;
  mod.api = mod.api || {};
  return mod.api;
}

function ensureGlobalApi() {
  globalThis.FUCompanion = globalThis.FUCompanion || {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
  return globalThis.FUCompanion.api;
}

// The setting must exist before anything reads it, so registration is on
// `init` and everything else waits for `ready`.
Hooks.once("init", () => {
  try { store.registerClockSetting(); }
  catch (e) { console.warn(CLOCK_TAG, "setting registration failed", e); }
});

Hooks.once("ready", () => {
  try {
    store.wireClockStore();

    const m = ensureModuleApi(); if (m) m.clocks = api;
    ensureGlobalApi().clocks = api;

    // ── Lifecycle sweeps ────────────────────────────────────────────────────
    // Clocks live in a world setting so they survive a reconnect; `lifecycle`
    // is what stops them accumulating across sessions. `manual` is never swept.
    //
    // Both sweeps no-op on non-GM clients (the store's writer gate), so it is
    // safe to register them everywhere.

    // Battle Director already broadcasts its own stop. No BD edit needed here.
    Hooks.on("fu-director-stopped", () => {
      store.sweep(LIFECYCLE.COMBAT, { cause: "battle ended" })
        .catch((e) => console.warn(CLOCK_TAG, "combat sweep failed", e));
    });

    Hooks.on("canvasReady", (canvasObj) => {
      store.sweepScene(canvasObj?.scene?.id ?? null)
        .catch((e) => console.warn(CLOCK_TAG, "scene sweep failed", e));
    });

    console.debug(CLOCK_TAG, "ready — FUCompanion.api.clocks");
  } catch (e) {
    console.warn(CLOCK_TAG, "bootstrap failed", e);
  }
});

export { api as ClockApi };
