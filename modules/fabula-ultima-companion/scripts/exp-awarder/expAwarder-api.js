// ============================================================================
// expAwarder-api.js (Foundry V12 Module Script)
// - Public API: window.FUCompanion.api.expAwarder.awardExp(payload)
// - Updates Actor EXP at: actor.system.props.experience (decimal supported)
// - Emits UI signal (decoupled snapshot): Hooks.callAll("oni:expAwarded", {...})
// - UI percent conversion matches BattleEnd Summary behavior (0..10 => 0..100%)
// ============================================================================

(() => {
  const TAG = "[ONI][EXPAwarder][API]";
  const DBG = true;

  function log(...args) { if (DBG) console.log(TAG, ...args); }
  function warn(...args) { console.warn(TAG, ...args); }
  function err(...args) { console.error(TAG, ...args); }

  function makeRunId() {
    return `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  }

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

  function clamp(n, a, b) {
    return Math.max(a, Math.min(b, n));
  }

  // Same idea as BattleEnd SummaryUI expToPct(): (exp - start) / (cap - start) * 100
  function expToPct(exp, expStart, levelUpAt) {
    const start = Number(expStart);
    const cap = Number(levelUpAt);
    const denom = Math.max(1e-6, (cap - start));
    const t = (Number(exp) - start) / denom;
    return clamp(t * 100, 0, 100);
  }

  // EXP meter rules:
  // - experience is a 0..LEVELUP_AT gauge
  // - if exp reaches LEVELUP_AT, level increases and exp rolls over (overflow supported)
  // - negative awards will not reduce level; exp clamps to 0
  function applyLevelUpOverflow(expBefore, levelBefore, delta, levelUpAt) {
    const cap = Math.max(1e-6, Number(levelUpAt));
    let level = Math.max(1, Math.floor(asNumber(levelBefore, 1)));
    let exp0 = asNumber(expBefore, 0);

    // If old data already exceeded cap, normalize it first
    if (exp0 >= cap) {
      const gained0 = Math.floor(exp0 / cap);
      level += gained0;
      exp0 = exp0 - gained0 * cap;
    } else if (exp0 < 0) {
      exp0 = 0;
    }

    let exp = exp0 + asNumber(delta, 0);

    // Clamp negative (no level-down logic)
    if (exp < 0) exp = 0;

    // Apply overflow level-ups
    let gained = 0;
    // Use a tiny epsilon to avoid floating precision issues (e.g. 9.9999999997)
    const EPS = 1e-9;
    while (exp + EPS >= cap) {
      exp -= cap;
      level += 1;
      gained += 1;
      // safety against infinite loops on weird cap
      if (gained > 9999) break;
    }

    return {
      expStart: exp0,
      expFinal: exp,
      levelFinal: level,
      levelsGained: gained,
    };
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

  function emitExpAwardedSignal(payload) {
    try {
      Hooks.callAll("oni:expAwarded", payload);
    } catch (e) {
      err("Failed to emit oni:expAwarded", e);
    }
  }

  async function awardExp(userPayload = {}) {
    const runId = makeRunId();
    log(`START runId=${runId}`, { keys: Object.keys(userPayload ?? {}) });

    try {
      const targets = normalizeTargets(userPayload.targets);
      const amount = asNumber(userPayload.amount, NaN);
      const playUi = (userPayload.playUi ?? true) === true;
      const source = normString(userPayload.source);

      const awardingUser = {
        id: userPayload.user?.id ?? game.user?.id ?? null,
        name: userPayload.user?.name ?? game.user?.name ?? "Unknown",
      };

      if (!Number.isFinite(amount)) {
        ui.notifications?.warn?.("EXP Awarder: Invalid EXP amount.");
        warn(`runId=${runId} Invalid amount`, userPayload.amount);
        return { ok: false, runId, error: "INVALID_AMOUNT" };
      }

      if (!targets.length) {
        ui.notifications?.warn?.("EXP Awarder: No targets selected.");
        warn(`runId=${runId} No targets`);
        return { ok: false, runId, error: "NO_TARGETS" };
      }

      // Your sheet behavior: exp is a 0..10 meter, displayed as % (x10)
      const EXP_START = 0;
      const LEVELUP_AT = 10;

      const entries = [];
      for (const t of targets) {
        const actorUuid = t.actorUuid;

        let actor;
        try {
          actor = await fromUuid(actorUuid);
        } catch (e) {
          warn(`runId=${runId} fromUuid failed`, actorUuid, e);
          continue;
        }

        if (!actor) {
          warn(`runId=${runId} Actor not found`, actorUuid);
          continue;
        }

        // --- Read EXP from Custom System Builder fields ---
        const expBefore = asNumber(actor.system?.props?.experience, 0);

        // Optional level snapshot (your actors store level under system.props.level)
        const levelBefore =
          actor.system?.props?.level ??
          actor.system?.level ??
          1;

        // --- Apply level-up + overflow (0..10 gauge) ---
        const calc = applyLevelUpOverflow(expBefore, levelBefore, amount, LEVELUP_AT);
        const expAfter = calc.expFinal;
        const levelAfter = calc.levelFinal;

        // --- Update EXP + Level (Custom System Builder paths) ---
        try {
          await actor.update({
            "system.props.experience": expAfter,
            "system.props.level": levelAfter,
          });
        } catch (e) {
          err(`runId=${runId} Failed to update actor EXP`, actorUuid, e);
          ui.notifications?.error?.(`EXP Awarder: Failed to update ${actor.name}.`);
          continue;
        }

        // --- UI percent conversion (matches BattleEnd SummaryUI logic style) ---
        const expPctFrom = expToPct(calc.expStart, EXP_START, LEVELUP_AT);
        const expPctTo = expToPct(expAfter, EXP_START, LEVELUP_AT);

        const entry = {
          actorUuid,
          actorName: actor.name,
          group: t.group ?? "",
          label: t.label ?? "",
          amount,
          source,
          awardedBy: awardingUser,

          // Decoupled snapshot
          expBeforeRaw: expBefore,
          expBefore: calc.expStart,
          expAfter,
          levelBefore,
          levelAfter,
          levelsGained: calc.levelsGained,

          // UI snapshot values
          expPctFrom,
          expPctTo,
        };

        entries.push(entry);

        log(`runId=${runId} Updated`, {
          actor: actor.name,
          expBefore,
          expAfter,
          amount,
          expPctFrom,
          expPctTo,
        });
      }

      if (!entries.length) {
        warn(`runId=${runId} No entries updated (all targets failed?)`);
        return { ok: false, runId, error: "NO_UPDATES" };
      }

      if (playUi) {
        emitExpAwardedSignal({
          runId,
          ts: Date.now(),
          source,
          awardedBy: awardingUser,
          entries,
        });
        log(`runId=${runId} Emitted oni:expAwarded`, { count: entries.length });
      } else {
        log(`runId=${runId} playUi=false (no UI signal emitted)`);
      }

      log(`END runId=${runId} ok`);
      return { ok: true, runId, entries };
    } catch (e) {
      err(`runId=${runId} CRASH`, e);
      ui.notifications?.error?.("EXP Awarder: API crashed. Check console.");
      return { ok: false, runId, error: "CRASH", detail: String(e?.message ?? e) };
    }
  }

  function registerApi() {
    const api = ensureNamespace();
    api.awardExp = awardExp;

    api._debug = api._debug ?? {};
    api._debug.TAG = TAG;
    api._debug.version = "v3-levelupOverflow";
    log("API registered: window.FUCompanion.api.expAwarder.awardExp");
  }

  Hooks.once("init", () => {
    registerApi();
  });
})();
