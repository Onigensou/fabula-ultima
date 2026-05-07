// ============================================================================
// [BattleEnd: SummaryUI] • Foundry VTT v12 (GM-only broadcaster)
// ----------------------------------------------------------------------------
// Reads SummaryLogic results from canonical payload and broadcasts to all clients.
// UI is rendered client-side by [BattleEnd: SummaryUI Listener].
//
// Requires:
// - payload.battleEnd.meta.mode === "victory"
// - payload.phases.battleEnd.gate.status === "ok"
// - payload.battleEnd.results.expApplied exists (from SummaryLogic)
//
// UPDATE:
// - Also sends Zenit gain per actor (prefer SummaryLogic zenitApplied, fallback to Prompt zenitByActorId)
// - Listener will animate: EXP first -> Zenit count-up -> Hold Duration
// ============================================================================

(async () => {
  const DEBUG = false;

  const STORE_SCOPE = "world";
  const CANONICAL_KEY = "battleInit.latestPayload";

  const MODULE_ID = "fabula-ultima-companion";
  const SOCKET_CHANNEL = `module.${MODULE_ID}`;
  const MSG_TYPE = "ONI_BATTLEEND_SUMMARY_UI";

  const tag = "[BattleEnd:SummaryUI]";
  const log = (...a) => DEBUG && console.log(tag, ...a);

  function nowIso() { return new Date().toISOString(); }
  function parseIsoToMs(iso) {
    const t = Date.parse(String(iso ?? ""));
    return Number.isFinite(t) ? t : 0;
  }


  function safeInt(v, fallback = 0) {
    const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
    return Number.isFinite(n) ? Math.floor(n) : fallback;
  }

  // --------------------------------------------------------------------------
  // Locate canonical payload scene (source scene) while we're on battle scene
  // --------------------------------------------------------------------------
  function pickLatestPayloadAcrossScenes() {
    let best = null;

    for (const s of (game.scenes?.contents ?? [])) {
      const p = s.getFlag(STORE_SCOPE, CANONICAL_KEY);
      if (!p) continue;

      const createdAtMs =
        parseIsoToMs(p?.meta?.createdAt) ||
        Number(p?.step4?.transitionedAt ?? 0) ||
        0;

      if (!best || createdAtMs > best.createdAtMs) {
        best = { scene: s, payload: p, createdAtMs };
      }
    }
    return best;
  }

  function locateSourceSceneAndPayloadForThisBattle() {
    const activeBattleSceneId = canvas.scene?.id;

    let bestMatch = null;
    let bestMatchMs = 0;

    for (const s of (game.scenes?.contents ?? [])) {
      const p = s.getFlag(STORE_SCOPE, CANONICAL_KEY);
      if (!p) continue;

      const battleSceneIdInPayload = p?.step4?.battleScene?.id ?? null;
      if (battleSceneIdInPayload && activeBattleSceneId && battleSceneIdInPayload === activeBattleSceneId) {
        const ms =
          parseIsoToMs(p?.meta?.createdAt) ||
          Number(p?.step4?.transitionedAt ?? 0) ||
          0;

        if (!bestMatch || ms > bestMatchMs) {
          bestMatch = { scene: s, payload: p, from: "scene-scan-match-step4.battleScene.id" };
          bestMatchMs = ms;
        }
      }
    }

    if (bestMatch) return bestMatch;

    const local = canvas.scene?.getFlag?.(STORE_SCOPE, CANONICAL_KEY);
    if (local) return { scene: canvas.scene, payload: local, from: "current-scene" };

    const best = pickLatestPayloadAcrossScenes();
    if (best) return { scene: best.scene, payload: best.payload, from: "scene-scan-latest" };

    return null;
  }

  // --------------------------------------------------------------------------
  // Guards
  // --------------------------------------------------------------------------
  if (!game.user?.isGM) {
    ui.notifications?.warn?.("BattleEnd: SummaryUI is GM-only.");
    return;
  }
  if (!canvas?.scene) {
    ui.notifications?.error?.("BattleEnd: No active scene.");
    return;
  }

  const located = locateSourceSceneAndPayloadForThisBattle();
  if (!located?.payload || !located?.scene) {
    ui.notifications?.error?.(`BattleEnd SummaryUI: No canonical payload found at ${STORE_SCOPE}.${CANONICAL_KEY}.`);
    return;
  }

  const sourceScene = located.scene;
  const payload = located.payload;

  log("Located canonical payload ✅", {
    from: located.from,
    sourceScene: { id: sourceScene.id, name: sourceScene.name },
    activeScene: { id: canvas.scene.id, name: canvas.scene.name },
    battleId: payload?.meta?.battleId ?? "(missing)"
  });

  // Must be victory
  const mode = String(payload?.battleEnd?.meta?.mode ?? "").toLowerCase();
  if (mode !== "victory") {
    return;
  }

  // Gate must pass
  const gateStatus = String(payload?.phases?.battleEnd?.gate?.status ?? "").toLowerCase();
  if (gateStatus !== "ok") {
    ui.notifications?.error?.(`BattleEnd SummaryUI blocked: Gate status is "${gateStatus || "(missing)"}".`);
    return;
  }

  // Need SummaryLogic results (EXP)
  const expApplied = payload?.battleEnd?.results?.expApplied;
  if (!Array.isArray(expApplied) || !expApplied.length) {
    ui.notifications?.error?.("BattleEnd SummaryUI missing results: payload.battleEnd.results.expApplied");
    return;
  }

  const rule = payload?.battleEnd?.results?.expRule ?? { expStart: 1, levelUpAt: 10 };

  // --------------------------------------------------------------------------
  // Zenit: prefer SummaryLogic result array, fallback to Prompt map
  // --------------------------------------------------------------------------
  // Preferred (if your SummaryLogic stamps it):
  // payload.battleEnd.results.zenitApplied = [{ actorId, zenitGain, ... }, ...]
      const zenitApplied = payload?.battleEnd?.results?.zenitApplied;

  // We want BEFORE -> AFTER for UI
  // SummaryLogic stores:
  //   row.zenit = { before, gained, after }
  const zenitStateByActorId = (() => {
    // 1) Prefer SummaryLogic results (best + authoritative)
    if (Array.isArray(zenitApplied) && zenitApplied.length) {
      const m = {};
      for (const row of zenitApplied) {
        const actorId = row?.actorId;
        if (!actorId) continue;

        const before = Number(row?.zenit?.before ?? 0);
        const gained = Number(row?.zenit?.gained ?? 0);
        const after  = Number(row?.zenit?.after  ?? (before + gained));

        m[actorId] = {
          before: Number.isFinite(before) ? Math.floor(before) : 0,
          gained: Number.isFinite(gained) ? Math.floor(gained) : 0,
          after:  Number.isFinite(after)  ? Math.floor(after)  : 0
        };
      }
      return m;
    }

    // 2) Fallback: Prompt map (gain only). Use current actor zenit as "before".
    // (This only matters if SummaryLogic didn't stamp zenitApplied for some reason.)
    const pm = payload?.battleEnd?.prompt?.zenitByActorId;
    if (pm && typeof pm === "object" && !Array.isArray(pm)) {
      const m = {};
      for (const [actorId, v] of Object.entries(pm)) {
        const actor = game.actors?.get?.(actorId) ?? null;
        const beforeRaw = actor?.system?.props?.zenit ?? 0;

        const before = Number(beforeRaw);
        const gained = Number(v);
        const b = Number.isFinite(before) ? Math.floor(before) : 0;
        const g = Number.isFinite(gained) ? Math.floor(gained) : 0;

        m[actorId] = {
          before: b,
          gained: Math.max(0, g),
          after: b + Math.max(0, g)
        };
      }
      return m;
    }

    return {};
  })();

  // Build payload for UI (only the data UI needs)
    
  // NEW: Total Round snapshot (captured during Prompt, before FX ends combat)
  const totalRounds = safeInt(payload?.battleEnd?.prompt?.combat?.round, null);

// NEW: Combat totals (computed in SummaryLogic from DB battle_log_table)
const combatTotals = payload?.battleEnd?.results?.combatTotals ?? {};
const totalDamage = safeInt(combatTotals?.totalDamage, null);
const totalHealing = safeInt(combatTotals?.totalHealing, null);

const rank = payload?.battleEnd?.results?.rank ?? null;
const rankLetter = String(rank?.letter ?? "S");
const rankScore = (Number.isFinite(Number(rank?.score)) ? Number(rank.score) : null);


const uiPayload = {
    runId: String(payload?.battleEnd?.meta?.runId ?? `sum_${Date.now()}`),
    lockInteractions: true,
    holdMs: 5000,
    totalRounds,
    totalDamage,
    totalHealing,
    rank: { letter: rankLetter, score: rankScore },
    rankLetter,
    rule: {
      expStart: Number(rule.expStart ?? 1),
      levelUpAt: Number(rule.levelUpAt ?? 10)
    },
    zenitIconSrc: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/GP.png",
        entries: expApplied.map(e => {
      const z = zenitStateByActorId?.[e.actorId] ?? { before: 0, gained: 0, after: 0 };

      return {
        actorId: e.actorId,
        actorName: e.actorName,
        exp: e.exp,
        level: e.level,
        segments: e.segments,

        // NEW: show current zenit first, then tick to new value
        zenitBefore: Math.floor(Number(z.before ?? 0)),
        zenitAfter: Math.floor(Number(z.after ?? 0)),
        zenitGain: Math.floor(Number(z.gained ?? 0)) // keep for debugging/backup logic
      };
    })
  };

  // Broadcast
  const msg = {
    type: MSG_TYPE,
    sceneId: canvas.scene.id,
    payload: uiPayload
  };

  try {
    game.socket.emit(SOCKET_CHANNEL, msg);
    log("Socket emit sent ✅", { channel: SOCKET_CHANNEL, type: MSG_TYPE });
  } catch (err) {
    ui.notifications?.warn?.("BattleEnd SummaryUI: socket emit failed (players may not see UI).");
    console.warn(`${tag} socket emit failed:`, err);
  }

  // ALSO render locally on the GM (socket may not echo back to sender)
  try {
    const localRunner = window.ONI_BattleEnd_SummaryUI?.run;
    if (typeof localRunner === "function") {
      await localRunner(uiPayload);
      log("Rendered locally on GM ✅");
    } else {
      console.warn(`${tag} Local runner missing. Make sure [BattleEnd: SummaryUI Listener] ran on THIS client.`);
      ui.notifications?.warn?.("BattleEnd SummaryUI: Listener not detected on this client (GM).");
    }
  } catch (err) {
    console.warn(`${tag} Local render failed:`, err);
  }

  // Stamp phase (optional but nice)
  payload.phases ??= {};
  payload.phases.battleEnd ??= {};
  payload.phases.battleEnd.summaryUI = {
    status: "ok",
    at: nowIso(),
    details: {
      sentTo: "game.socket",
      entries: uiPayload.entries.length,
      zenitIncluded: true
    }
  };

  await sourceScene.setFlag(STORE_SCOPE, CANONICAL_KEY, payload);

})();
