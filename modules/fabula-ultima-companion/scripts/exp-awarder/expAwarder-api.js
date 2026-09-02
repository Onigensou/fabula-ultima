// ============================================================================
// expAwarder-api.js (Foundry V12 Module Script)
//
// The standalone "grant some EXP" entry point — the GM sidebar button, and any
// out-of-band source that wants the sliding award panel.
//
// - Public API: window.FUCompanion.api.expAwarder.awardExp(payload)
// - Payload:    { targets, amount, source, playUi, user }
// - Emits UI signal (decoupled snapshot): Hooks.callAll("oni:expAwarded", {...})
//
// It no longer owns any EXP maths. The gauge, the level-up overflow and the
// Skill Point mint moved to shared/exp-core.js so that the Battle Director's
// victory path shares them — before that split, this file was the only place a
// point was ever minted, and every Director level-up quietly left drift for a
// GM to heal by hand.
//
// Two behaviours changed with the move, both deliberate:
//   • The gauge is now 1..10 (a level spans NINE points), matching the Battle
//     Director. It used to be 0..10 here. A stored value below 1 is normalised
//     up on the next award, so no migration was needed.
//   • Percentages therefore divide by 9, not 10 — the bar now agrees with the
//     victory screen.
//
// See shared/exp-core.js and docs/exp-award-pipeline.md.
// ============================================================================

(() => {
  const TAG = "[ONI][EXPAwarder][API]";
  const DBG = true;

  function log(...args) { if (DBG) console.log(TAG, ...args); }
  function warn(...args) { console.warn(TAG, ...args); }
  function err(...args) { console.error(TAG, ...args); }

  function ensureNamespace() {
    globalThis.FUCompanion = globalThis.FUCompanion ?? {};
    globalThis.FUCompanion.api = globalThis.FUCompanion.api ?? {};
    globalThis.FUCompanion.api.expAwarder = globalThis.FUCompanion.api.expAwarder ?? {};
    return globalThis.FUCompanion.api.expAwarder;
  }

  function asNumber(v, fallback = 0) {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  function normString(v) {
    const s = (v ?? "").toString();
    const t = s.trim();
    return t.length ? t : "";
  }

  function normalizeTargets(targets) {
    // Accept:
    // - ["Actor.xxx", "Actor.yyy"]
    // - [{ actorUuid: "Actor.xxx", label, group }, ...]
    const out = [];
    const arr = Array.isArray(targets) ? targets : [];
    for (const t of arr) {
      if (!t) continue;

      if (typeof t === "string") {
        const uuid = normString(t);
        if (uuid) out.push({ actorUuid: uuid });
        continue;
      }

      if (typeof t === "object") {
        const uuid = normString(t.actorUuid ?? t.uuid);
        if (!uuid) continue;
        out.push({
          actorUuid: uuid,
          label: normString(t.label),
          group: normString(t.group),
        });
      }
    }
    return out;
  }

  /** The shared EXP core, published for classic scripts by shared/exp-core.js. */
  function core() {
    return globalThis["oni.ExpCore"] ?? null;
  }

  /**
   * Award EXP to actors.
   *
   * The gauge maths, the level-up overflow and the Skill Point mint used to
   * live in this file, which made it the only path in the game that minted a
   * point — Battle Director victories levelled without one. All of it now
   * belongs to shared/exp-core.js and every path shares it. This function is
   * the standalone entry point: it validates the payload, delegates the write,
   * and keeps the sliding award panel (oni:expAwarded → expAwarder-ui.js) as
   * its own presentation.
   *
   * Payload is unchanged, so the GM sidebar needed no edit:
   *   { targets, amount, source, playUi, user }
   */
  async function awardExp(userPayload = {}) {
    try {
      const C = core();
      if (!C?.applyExpAward) {
        err("shared/exp-core.js not loaded — cannot award EXP.");
        ui.notifications?.error?.("EXP Awarder: EXP core not loaded. Check console.");
        return { ok: false, error: "NO_EXP_CORE" };
      }

      const targets = normalizeTargets(userPayload.targets);
      const amount  = asNumber(userPayload.amount, NaN);

      if (!Number.isFinite(amount)) {
        ui.notifications?.warn?.("EXP Awarder: Invalid EXP amount.");
        warn("Invalid amount", userPayload.amount);
        return { ok: false, error: "INVALID_AMOUNT" };
      }

      if (!targets.length) {
        ui.notifications?.warn?.("EXP Awarder: No targets selected.");
        warn("No targets");
        return { ok: false, error: "NO_TARGETS" };
      }

      const res = await C.applyExpAward({
        targets,
        amount,
        source:  normString(userPayload.source),
        playUi:  (userPayload.playUi ?? true) === true,
        user:    userPayload.user ?? null,
      });

      if (!res.ok) {
        warn("core returned not ok", res);
        return res;
      }

      for (const e of res.entries) {
        const minted = e.skillPointsMinted > 0 ? ` +${e.skillPointsMinted} SP` : "";
        log(`runId=${res.runId} ${e.actorName}: ${e.expBefore}+${e.amount}→${e.expAfter} Lv${e.levelBefore}→${e.levelAfter}${minted}`);
      }

      return res;
    } catch (e) {
      err("CRASH", e);
      ui.notifications?.error?.("EXP Awarder: API crashed. Check console.");
      return { ok: false, error: "CRASH", detail: String(e?.message ?? e) };
    }
  }

  function registerApi() {
    const api = ensureNamespace();
    api.awardExp = awardExp;

    api._debug = api._debug ?? {};
    api._debug.TAG = TAG;
    api._debug.version = "v4-expCore";
    log("API registered: window.FUCompanion.api.expAwarder.awardExp");
  }

  Hooks.once("init", () => {
    registerApi();
  });
})();
