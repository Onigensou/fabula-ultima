/**
 * [CheckRoller] Core — Foundry VTT v12
 * -----------------------------------------------------------------------------
 * Purpose:
 * - Registers the "computeRoll" adapter for ONI.CheckRoller Manager.
 * - Takes a payload (validated/normalized), rolls dice, computes totals and flags.
 *
 * Output:
 * - Returns { payload, result } where:
 *   - payload.result is filled
 *   - result mirrors payload.result for convenience
 *
 * Notes:
 * - Crit/Fumble rules (Fabula Ultima):
 *   - Fumble: double 1
 *   - Critical: doubles AND number >= critMin (default 6)
 * - critMin can be modified per character later. For now:
 *   - payload.check.critMin overrides default (if present)
 *   - else defaultCritMin = 6
 *
 * - DL pass/fail is only computed if:
 *   - payload.check.dl exists AND payload.meta.dlVisibility === "shown"
 *   Otherwise we still store dl (if any), but we do not mark pass/fail for players.
 */

(() => {
  const TAG = "[ONI][CheckRoller:Core]";
  const MANAGER = globalThis.ONI?.CheckRoller;

  if (!MANAGER || !MANAGER.__isCheckRollerManager) {
    ui?.notifications?.error("Check Roller: Manager not found. Run [CheckRoller] Manager first.");
    console.error(`${TAG} Manager not found at ONI.CheckRoller`);
    return;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  const safeStr = (v, fb = "") => (typeof v === "string" ? v : (v == null ? fb : String(v)));
  const safeInt = (v, fb = 0) => {
    const n = typeof v === "number" ? v : parseInt(String(v ?? "").replace(/[^\d-]/g, ""), 10);
    return Number.isFinite(n) ? n : fb;
  };
  const clampInt = (n, a, b) => Math.max(a, Math.min(b, safeInt(n, a)));

  const sumModifierParts = (parts) => {
    if (!Array.isArray(parts)) return 0;
    return parts.reduce((acc, p) => acc + safeInt(p?.value, 0), 0);
  };

  const getActorFromPayload = async (payload) => {
    const uuid = payload?.meta?.actorUuid;
    if (!uuid) return null;
    try {
      const doc = await fromUuid(uuid);
      // fromUuid can return TokenDocument / Actor / Item, etc
      if (doc?.actor) return doc.actor; // token doc
      if (doc?.documentName === "Actor") return doc;
      return doc || null;
    } catch (e) {
      console.warn(`${TAG} Failed to resolve actorUuid: ${uuid}`, e);
      return null;
    }
  };

        const getCritMin = (payload, actor) => {
  // Normalize your house-rule:
  // - If critMin is pushed to 0 or below => "crit on any doubles except 1,1"
  //   (so we treat it as threshold 2; fumble still wins)
  // - Allow 1 as a real value if you ever use it (still safe because fumble overrides)
  const normalizeCritMin = (raw) => {
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    if (n <= 0) return 2;
    return clampInt(n, 1, 20);
  };

  // 1) payload.check.critMin overrides
  const fromPayload = normalizeCritMin(payload?.check?.critMin);
  if (fromPayload != null) return fromPayload;

  // 2) actor sheet field
  const sys = actor?.system;
  const raw =
    sys?.data?.props?.minimum_critical_dice ??
    sys?.props?.minimum_critical_dice ??
    null;

  const fromActor = normalizeCritMin(raw);
  if (fromActor != null) return fromActor;

  // 3) default
  return 6;
};

  const getCritRange = (payload, actor) => {
    // Normalize:
    // - Missing / NaN => null
    // - <= 0 => 0 (default “must match” behavior)
    // - Clamp to something sane
    const normalizeCritRange = (raw) => {
      const n = Number(raw);
      if (!Number.isFinite(n)) return null;
      if (n <= 0) return 0;
      return clampInt(n, 0, 20);
    };

    // 1) payload.check.critRange overrides (optional feature; safe to support)
    const fromPayload = normalizeCritRange(payload?.check?.critRange);
    if (fromPayload != null) return fromPayload;

    // 2) actor sheet field
    // Your system field (per your note): _token.actor.system.props.critical_dice_range
    const sys = actor?.system;
    const raw =
      sys?.data?.props?.critical_dice_range ??
      sys?.props?.critical_dice_range ??
      null;

    const fromActor = normalizeCritRange(raw);
    if (fromActor != null) return fromActor;

    // 3) default
    return 0;
  };

  const rollDie = async (faces) => {
  // Foundry roll expression, e.g. "1d8"
  const f = clampInt(faces, 4, 20);

  // ------------------------------------------------------------
  // TEST OVERRIDE (optional)
  // If you set: globalThis.ONI.__CR_TEST_ROLLS = [2, 2]
  // then the next two dice rolled by CheckRoller will be forced.
  // Values are clamped to [1..faces]. Auto-clears when empty.
  // ------------------------------------------------------------
  try {
    const q = globalThis.ONI?.__CR_TEST_ROLLS;
    if (Array.isArray(q) && q.length) {
      const forcedRaw = q.shift();
      const forced = safeInt(forcedRaw, 1);
      if (!q.length && globalThis.ONI) delete globalThis.ONI.__CR_TEST_ROLLS;
      return Math.max(1, Math.min(f, forced));
    }
  } catch (_) {}

  const roll = new Roll(`1d${f}`);

  // Foundry v12: evaluate is async-capable without the async option
  await roll.evaluate();

  return safeInt(roll.total, 0);
};

    const computeResult = (payload, actor) => {
    const dieA = clampInt(payload?.check?.dice?.A, 4, 20);
    const dieB = clampInt(payload?.check?.dice?.B, 4, 20);

    const parts = payload?.check?.modifier?.parts || [];
    const modPartsTotal = sumModifierParts(parts);
    const declaredTotal = safeInt(payload?.check?.modifier?.total, modPartsTotal);

    // Keep it consistent: total = sum(parts). If declared total differs, we still store both.
    const modifierTotal = modPartsTotal;

    const critMin = getCritMin(payload, actor);
    const critRange = getCritRange(payload, actor);

    return { dieA, dieB, modifierTotal, declaredModifierTotal: declaredTotal, critMin, critRange };
  };

  // ---------------------------------------------------------------------------
  // Adapter: computeRoll
  // ---------------------------------------------------------------------------
  MANAGER.registerAdapter("computeRoll", async (payload, ctx) => {
    const p = payload; // already cloned by manager
    const actor = await getActorFromPayload(p);

    // Ensure result object exists
    p.result = typeof p.result === "object" && p.result ? p.result : {};

       const { dieA, dieB, modifierTotal, declaredModifierTotal, critMin, critRange } = computeResult(p, actor);

    // Roll dice
    const rA = await rollDie(dieA);
    const rB = await rollDie(dieB);

    // HR (high roll)
    const hr = Math.max(rA, rB);

    // Base sum
    const base = rA + rB;

    // Final result
    const total = base + modifierTotal;

        // Crit/Fumble (Fumble always wins)
    const isFumble = (rA === 1 && rB === 1);

    // range = 0 => must match; range = 1 => adjacent allowed; etc
    const critDelta = Math.abs(rA - rB);
    const isCrit = (!isFumble && critDelta <= critRange && hr >= critMin);

    // Pass/Fail (only if DL exists AND dlVisibility === "shown")
    let pass = null;
    const hasDL = Number.isFinite(Number(p?.check?.dl));
    const dlVisibility = safeStr(p?.meta?.dlVisibility, "hidden");
    const dlShown = (dlVisibility === "shown");

    if (hasDL && dlShown) {
      const dl = safeInt(p.check.dl, 0);
      pass = total >= dl;
    }

    // Write back to payload
    p.result = {
      dieA,
      dieB,
      rollA: rA,
      rollB: rB,
      base,
      modifierTotal,
      // keep this for debugging; helps detect "parts != declared"
      modifierDeclared: declaredModifierTotal,
      total,
      hr,
      critMin,
      critRange,
      critDelta,
      isCrit,
      isFumble,
      pass // null if DL hidden or absent
    };

    // Helpful computed fields that your UI will likely want
    p.meta = p.meta || {};
    p.meta.computedAt = Date.now();

    console.log(`${TAG} Computed`, {
      actor: p?.meta?.actorName,
      attrs: p?.check?.attrs,
      dice: `d${dieA}+d${dieB}`,
      rolls: [rA, rB],
      hr,
      mod: modifierTotal,
      total,
      isCrit,
      isFumble,
      pass
    });

    return { payload: p, result: p.result };
  });
  console.log(`${TAG} Adapter installed: computeRoll`);
})();
