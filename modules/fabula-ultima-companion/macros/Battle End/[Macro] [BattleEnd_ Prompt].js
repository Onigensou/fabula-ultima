// ============================================================================
// [BattleEnd: Prompt] • Foundry VTT v12
// ----------------------------------------------------------------------------
// FIXED: canonical payload is stored on the SOURCE scene (BattleInit design).
// This macro now LOCATES the correct source scene by scanning Scene flags,
// preferring a payload whose step4.battleScene.id matches the ACTIVE battle scene.
// ----------------------------------------------------------------------------
// Storage (Scene Flags):
// - Canonical payload key: world.battleInit.latestPayload   (source scene)
// - Convenience key      : world.battleEnd.latestPayload    (written on same source scene)
//
// UPDATE:
// - Rewards UI is now ONE table with 2 columns: EXP + Zenit
// - Defaults pulled from payload.record.step8.expSnapshot + zenitSnapshot
// - Writes both expByActorId and zenitByActorId into payload.battleEnd.prompt
// ============================================================================

(async () => {
  const DEBUG = false;

  // --------------------------------------------------------------------------
  // CONFIG (match your BattleInit scripts)
  // --------------------------------------------------------------------------
  const STORE_SCOPE   = "world";
  const CANONICAL_KEY = "battleInit.latestPayload";
  const BATTLEEND_KEY = "battleEnd.latestPayload";

  // --------------------------------------------------------------------------
  // Guards
  // --------------------------------------------------------------------------
  if (!game.user?.isGM) {
    ui.notifications?.warn?.("BattleEnd: Prompt is GM-only.");
    return;
  }
  if (!canvas?.scene) {
    ui.notifications?.error?.("BattleEnd: No active scene (canvas.scene is null).");
    return;
  }

  const tag = "[BattleEnd:Prompt]";
  const log = (...args) => DEBUG && console.log(tag, ...args);

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------
  const nowIso = () => new Date().toISOString();

  function safeNumber(v, fallback = 0) {
    const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
    return Number.isFinite(n) ? n : fallback;
  }

  function safeInt(v, fallback = 0) {
    const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
    return Number.isFinite(n) ? Math.floor(n) : fallback;
  }


  function getCombatRoundSnapshot() {
    try {
      const c = game.combats?.active ?? game.combat ?? null;
      if (!c) return { round: null, started: false, combatId: null };
      const round = ("round" in c) ? safeInt(c.round, 0) : null;
      const started = !!c.started;
      return { round, started, combatId: String(c.id ?? "") || null };
    } catch (e) {
      return { round: null, started: false, combatId: null };
    }
  }

  function buildRunId() {
    const t = Date.now();
    const r = Math.random().toString(36).slice(2, 8);
    return `end_${t}_${r}`;
  }

  function parseIsoToMs(iso) {
    const t = Date.parse(String(iso ?? ""));
    return Number.isFinite(t) ? t : 0;
  }

  function sceneUuidFromId(sceneId) {
    return `Scene.${sceneId}`;
  }

  function resolveSceneNameByUuid(uuid) {
    if (!uuid) return "";
    const id = String(uuid).startsWith("Scene.") ? String(uuid).slice("Scene.".length) : uuid;
    const sc = game.scenes?.get?.(id);
    return sc?.name ?? "";
  }

  // Try to get a nice preview image for a scene
  function getScenePreviewSrc(scene) {
    if (!scene) return "";

    // v12 common places (use whatever exists)
    const bg = scene?.background?.src;
    const thumb = scene?.thumb;
    const img = scene?.img; // older fallback
    return bg || thumb || img || "";
  }

  function getSceneByUuid(uuid) {
    if (!uuid) return null;
    const id = String(uuid).startsWith("Scene.") ? String(uuid).slice("Scene.".length) : uuid;
    return game.scenes?.get?.(id) ?? null;
  }

  function extractPartyActorIds(payload) {
    const ids = [];

    const m1 = payload?.party?.members;
    if (Array.isArray(m1)) {
      for (const row of m1) {
        const id = row?.actorId ?? row?.id ?? row?.actor_id;
        if (id && !ids.includes(id)) ids.push(id);
      }
    }

    const m2 = payload?.partyActorIds;
    if (Array.isArray(m2)) {
      for (const id of m2) {
        if (id && !ids.includes(id)) ids.push(id);
      }
    }

    const m3 = payload?.context?.partyActorIds;
    if (Array.isArray(m3)) {
      for (const id of m3) {
        if (id && !ids.includes(id)) ids.push(id);
      }
    }

    return ids;
  }

  function extractExpMap(payload) {
    // Primary source:
    // payload.record.step8.expSnapshot.pcs = [{ actorId, EXPdisplay, EXPfinal, ... }, ...]
    const step8pcs = payload?.record?.step8?.expSnapshot?.pcs;
    if (Array.isArray(step8pcs) && step8pcs.length) {
      const out = {};
      for (const row of step8pcs) {
        const actorId = row?.actorId;
        if (!actorId) continue;

        const v =
          (row?.EXPdisplay ?? row?.expDisplay ?? row?.exp_display) ??
          (row?.EXPfinal ?? row?.expFinal ?? row?.exp_final);

        out[actorId] = safeNumber(v, 0);
      }
      return out;
    }

    // Fallbacks
    const candidates = [
      payload?.record?.expSnapshot?.expByActorId,
      payload?.record?.expSnapshot?.byActorId,
      payload?.record?.exp?.expByActorId,
      payload?.record?.exp?.byActorId,
      payload?.record?.expByActorId,
      payload?.rewards?.expByActorId,
      payload?.expByActorId
    ];

    for (const c of candidates) {
      if (c && typeof c === "object" && !Array.isArray(c)) {
        const out = {};
        for (const [k, v] of Object.entries(c)) out[k] = safeNumber(v, 0);
        return out;
      }
    }

    return {};
  }

  function extractZenitMap(payload) {
    // Primary source:
    // payload.record.step8.zenitSnapshot.pcs = [{ actorId, zenitFinal, ... }, ...]
    const step8pcs = payload?.record?.step8?.zenitSnapshot?.pcs;
    if (Array.isArray(step8pcs) && step8pcs.length) {
      const out = {};
      for (const row of step8pcs) {
        const actorId = row?.actorId;
        if (!actorId) continue;

        const v =
          (row?.zenitFinal ?? row?.ZenitFinal ?? row?.zenit_final) ??
          (row?.zenitRaw ?? row?.ZenitRaw ?? row?.zenit_raw);

        out[actorId] = safeInt(v, 0);
      }
      return out;
    }

    // Fallbacks (if prompt already saved earlier)
    const candidates = [
      payload?.battleEnd?.prompt?.zenitByActorId,
      payload?.record?.zenitSnapshot?.byActorId,
      payload?.record?.zenit?.byActorId,
      payload?.record?.zenitByActorId,
      payload?.rewards?.zenitByActorId,
      payload?.zenitByActorId
    ];

    for (const c of candidates) {
      if (c && typeof c === "object" && !Array.isArray(c)) {
        const out = {};
        for (const [k, v] of Object.entries(c)) out[k] = safeInt(v, 0);
        return out;
      }
    }

    return {};
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
    return best; // can be null
  }

  function locateSourceSceneAndPayloadForThisBattle() {
    const activeBattleSceneId = canvas.scene?.id;

    // 1) Best match: payload whose step4.battleScene.id matches ACTIVE scene id
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

    // 2) Fallback: if you happen to run this on the source scene, read local
    const local = canvas.scene.getFlag(STORE_SCOPE, CANONICAL_KEY);
    if (local) {
      return { scene: canvas.scene, payload: local, from: "current-scene-flag" };
    }

    // 3) Final fallback: newest across all scenes
    const best = pickLatestPayloadAcrossScenes();
    if (best) return { scene: best.scene, payload: best.payload, from: "scene-scan-latest" };

    return null;
  }

  const located = locateSourceSceneAndPayloadForThisBattle();
  if (!located?.payload || !located?.scene) {
    ui.notifications?.error?.(
      `BattleEnd: No canonical payload found anywhere at SceneFlag ${STORE_SCOPE}.${CANONICAL_KEY}.`
    );
    log("Missing canonical payload across all scenes.", {
      activeScene: { id: canvas.scene?.id, name: canvas.scene?.name }
    });
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

  // Ensure base structures exist (append-only)
  payload.phases = payload.phases ?? {};
  payload.phases.battleEnd = payload.phases.battleEnd ?? {};
  payload.battleEnd = payload.battleEnd ?? {};
  payload.battleEnd.meta = payload.battleEnd.meta ?? {};

  // --------------------------------------------------------------------------
  // Prompt lifecycle marker (so Manager can stop polling on cancel/close)
  // We set status="running" as soon as the dialog opens.
  // --------------------------------------------------------------------------
  let promptResult = "none"; // "none" | "confirming" | "ok" | "cancelled" | "blocked"

  payload.phases = payload.phases ?? {};
  payload.phases.battleEnd = payload.phases.battleEnd ?? {};

  // Mark prompt as running NOW (overwrites stale 'ok' from a previous run)
  payload.phases.battleEnd.prompt = { status: "running", at: nowIso() };

  // Persist immediately so Manager sees a fresh marker with at >= stepStartMs
  await sourceScene.setFlag(STORE_SCOPE, CANONICAL_KEY, payload);
  await sourceScene.setFlag(STORE_SCOPE, BATTLEEND_KEY, payload.battleEnd);


  // --------------------------------------------------------------------------
  // Defaults
  // --------------------------------------------------------------------------
  const defaultMode = payload?.battleEnd?.meta?.mode ?? "victory";

  const defaultReturnSceneUuid =
    payload?.battleEnd?.prompt?.returnSceneUuid ??
    payload?.context?.sourceSceneUuid ??
    payload?.context?.homeSceneUuid ??
    (payload?.context?.sourceSceneId ? sceneUuidFromId(payload.context.sourceSceneId) : "");

  const defaultExpMap = extractExpMap(payload);
  const defaultZenitMap = extractZenitMap(payload);
  const partyActorIds = extractPartyActorIds(payload);

  const expActorIds = Object.keys(defaultExpMap);
  const zenitActorIds = Object.keys(defaultZenitMap);

  const actorIdsForRewardsUI = partyActorIds.length
    ? partyActorIds
    : Array.from(new Set([...expActorIds, ...zenitActorIds]));

  // ------------------------------------------------------------------------
  // Victory BGM default pulled from your Database sheet
  // ------------------------------------------------------------------------
  // Source key:
  //   <DB>.system.props.victory_bgm
  // Uses: window.FUCompanion.api.getCurrentGameDb()
  const dbVictoryBgmName = await (async () => {
    try {
      const api = window?.FUCompanion?.api;
      if (!api?.getCurrentGameDb) {
        log("DB Resolver not found: window.FUCompanion.api.getCurrentGameDb is missing");
        return "";
      }

      const { db, gameName, source } = await api.getCurrentGameDb();

      const dbActor = db ?? source;
      const raw = dbActor?.system?.props?.victory_bgm;
      const name = (typeof raw === "string") ? raw.trim() : "";

      if (DEBUG) log("DB Victory BGM resolved", { gameName, victory_bgm: name || "(empty)" });
      return name;
    } catch (err) {
      log("DB Victory BGM resolve failed", err);
      return "";
    }
  })();

  const defaultBgmName =
    payload?.battleEnd?.prompt?.bgm?.name ??
    (defaultMode === "victory" ? (dbVictoryBgmName || "Victory Fanfare") : "Defeat Theme");

  const defaultPlayMusic =
    payload?.battleEnd?.prompt?.bgm?.playMusic ??
    true;

  const defaultPlayAnimation =
    payload?.battleEnd?.prompt?.fx?.playAnimation ??
    true;

  // --------------------------------------------------------------------------
  // Build Return Scene dropdown
  // --------------------------------------------------------------------------
  const scenes = (game.scenes?.contents ?? []).slice().sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
  const sceneOptionsHtml = scenes.map(sc => {
    const uuid = sceneUuidFromId(sc.id);
    const selected = uuid === defaultReturnSceneUuid ? "selected" : "";
    return `<option value="${uuid}" ${selected}>${sc.name}</option>`;
  }).join("");

  // --------------------------------------------------------------------------
  // Build Rewards table rows (EXP + Zenit in same table)
  // --------------------------------------------------------------------------
  function renderRewardRows(actorIds) {
  if (!actorIds.length) {
    return `
      <tr>
        <td colspan="3" style="opacity:0.8;">
          No party snapshot detected. (This is OK for Defeat mode.)
        </td>
      </tr>
    `;
  }

  return actorIds.map(actorId => {
    const a = game.actors?.get?.(actorId) ?? null;
    const name = a?.name ?? `(Missing Actor: ${actorId})`;
    const exp = safeNumber(defaultExpMap[actorId], 0);
    const zenit = safeInt(defaultZenitMap[actorId], 0);

    return `
      <tr>
        <td style="padding:6px 8px; vertical-align:middle; overflow:hidden;">
          <div style="font-weight:700; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
            ${name}
          </div>
          <div style="opacity:0.75; font-size:11px; word-break:break-all; line-height:1.2;">
            ${actorId}
          </div>
        </td>

        <td style="padding:6px 8px; vertical-align:middle;">
          <input
            type="number"
            step="0.01"
            min="0"
            name="exp_${actorId}"
            value="${exp}"
            style="width:100%; min-width:0; box-sizing:border-box;"
          />
        </td>

        <td style="padding:6px 8px; vertical-align:middle;">
          <input
            type="number"
            step="1"
            min="0"
            name="zenit_${actorId}"
            value="${zenit}"
            style="width:100%; min-width:0; box-sizing:border-box;"
          />
        </td>
      </tr>
    `;
  }).join("");
}

  const rewardRowsHtml = renderRewardRows(actorIdsForRewardsUI);

  // --------------------------------------------------------------------------
  // Dialog UI
  // --------------------------------------------------------------------------
  const existingReturnName = resolveSceneNameByUuid(defaultReturnSceneUuid);
  const dialogContent = `
    <form id="battleEndPromptForm" autocomplete="off">
      <div style="display:flex; gap:12px; flex-direction:column;">

        <div style="padding:10px; border:1px solid rgba(255,255,255,0.15); border-radius:10px;">
          <div style="font-weight:800; margin-bottom:6px;">Battle End Mode</div>
          <div style="display:flex; gap:14px; align-items:center;">
            <label style="display:flex; gap:6px; align-items:center;">
              <input type="radio" name="mode" value="victory" ${defaultMode === "victory" ? "checked" : ""}/>
              <span>Victory</span>
            </label>
            <label style="display:flex; gap:6px; align-items:center;">
              <input type="radio" name="mode" value="defeat" ${defaultMode === "defeat" ? "checked" : ""}/>
              <span>Defeat</span>
            </label>
          </div>
          <div style="opacity:0.8; font-size:12px; margin-top:6px;">
            Victory enables EXP + Zenit rewards. Defeat will skip rewards + Summary UI later.
          </div>
        </div>

        <div style="padding:10px; border:1px solid rgba(255,255,255,0.15); border-radius:10px;">
          <div style="font-weight:800; margin-bottom:6px;">Return Scene</div>

          <div style="display:grid; grid-template-columns: 1fr 220px; gap:12px; align-items:start;">
            <div>
              <select id="be_returnSceneSelect" name="returnSceneUuid" style="width:100%;">
                <option value="" ${defaultReturnSceneUuid ? "" : "selected"}>(None)</option>
                ${sceneOptionsHtml}
              </select>

              <div id="be_returnSceneLabel" style="opacity:0.8; font-size:12px; margin-top:6px;">
                Default: ${existingReturnName ? existingReturnName : "(not detected)"} — from payload.context.sourceSceneUuid.
              </div>
            </div>

            <div style="border:1px solid rgba(255,255,255,0.15); border-radius:10px; overflow:hidden;">
              <div style="padding:6px 8px; font-weight:800; font-size:12px; opacity:0.85;">
                Preview
              </div>
              <div style="height:120px; background:rgba(0,0,0,0.25); display:flex; align-items:center; justify-content:center;">
                <img
                  id="be_returnSceneThumb"
                  src=""
                  alt="Scene Preview"
                  style="max-width:100%; max-height:120px; display:none;"
                />
                <div id="be_returnSceneThumbEmpty" style="opacity:0.75; font-size:12px; padding:8px; text-align:center;">
                  No preview
                </div>
              </div>
            </div>
          </div>
        </div>

        <div style="padding:10px; border:1px solid rgba(255,255,255,0.15); border-radius:10px;">
          <div style="font-weight:800; margin-bottom:6px;">Victory BGM & FX</div>
          <div style="display:flex; gap:12px; flex-wrap:wrap; align-items:center;">
            <label style="display:flex; gap:6px; align-items:center;">
              <input type="checkbox" name="playMusic" ${defaultPlayMusic ? "checked" : ""}/>
              <span>Play Music</span>
            </label>
            <label style="display:flex; gap:6px; align-items:center;">
              <input type="checkbox" name="playAnimation" ${defaultPlayAnimation ? "checked" : ""}/>
              <span>Play Animation</span>
            </label>
          </div>
          <div style="margin-top:8px;">
            <div style="opacity:0.8; font-size:12px; margin-bottom:4px;">BGM Name (used by FX step later)</div>
            <input type="text" name="bgmName" value="${defaultBgmName}" style="width:100%;" />
          </div>
        </div>

        <div style="padding:10px; border:1px solid rgba(255,255,255,0.15); border-radius:10px;">
  <div style="font-weight:800; margin-bottom:6px;">Rewards per Party Member (Victory only)</div>

  <div style="overflow:hidden;">
    <table style="width:100%; table-layout:fixed; border-collapse:collapse;">
      <colgroup>
        <col style="width:52%;">
        <col style="width:24%;">
        <col style="width:24%;">
      </colgroup>

      <thead>
        <tr>
          <th style="text-align:left; padding:6px 8px; opacity:0.8;">Actor</th>
          <th style="text-align:left; padding:6px 8px; opacity:0.8;">EXP</th>
          <th style="text-align:left; padding:6px 8px; opacity:0.8;">Zenit</th>
        </tr>
      </thead>

      <tbody>
        ${rewardRowsHtml}
      </tbody>
    </table>
  </div>

  <div style="opacity:0.8; font-size:12px; margin-top:8px;">
    Defaults are auto-filled from your BattleInit snapshots if found.
  </div>
</div>

      </div>
    </form>
  `;

  // --------------------------------------------------------------------------
  // Dialog + Save (WRITE TO SOURCE SCENE, not current battle scene)
  // --------------------------------------------------------------------------
  const dlg = new Dialog({
    title: "[BattleEnd] Prompt",
    content: dialogContent,
    buttons: {
      cancel: {
        icon: '<i class="fas fa-times"></i>',
        label: "Cancel",
        callback: async () => {
          promptResult = "cancelled";

          const cancelledAt = nowIso();

          payload.phases = payload.phases ?? {};
          payload.phases.battleEnd = payload.phases.battleEnd ?? {};
          payload.phases.battleEnd.prompt = { status: "cancelled", at: cancelledAt };

          payload.battleEnd = payload.battleEnd ?? {};
          payload.battleEnd.meta = payload.battleEnd.meta ?? {};
          payload.battleEnd.meta.cancelledAt = cancelledAt;

          await sourceScene.setFlag(STORE_SCOPE, CANONICAL_KEY, payload);
          await sourceScene.setFlag(STORE_SCOPE, BATTLEEND_KEY, payload.battleEnd);

          log("Prompt cancelled; wrote marker ✅", { cancelledAt });
        }
      },
      confirm: {
        icon: '<i class="fas fa-check"></i>',
        label: "Confirm",
        callback: async (html) => {
          promptResult = "confirming";

          const form = html?.[0]?.querySelector?.("#battleEndPromptForm");
          if (!form) {
            promptResult = "blocked";

            const blockedAt = nowIso();
            payload.phases = payload.phases ?? {};
            payload.phases.battleEnd = payload.phases.battleEnd ?? {};
            payload.phases.battleEnd.prompt = { status: "blocked", at: blockedAt, reason: "Form not found" };

            await sourceScene.setFlag(STORE_SCOPE, CANONICAL_KEY, payload);
            await sourceScene.setFlag(STORE_SCOPE, BATTLEEND_KEY, payload.battleEnd);

            ui.notifications?.error?.("BattleEnd: Prompt form not found (unexpected).");
            return;
          }

          const fd = new FormData(form);

          const mode = String(fd.get("mode") ?? "victory");
          const returnSceneUuid = String(fd.get("returnSceneUuid") ?? "");
          const bgmName = String(fd.get("bgmName") ?? "");
          const playMusic = fd.get("playMusic") === "on";
          const playAnimation = fd.get("playAnimation") === "on";

          const expByActorId = {};
          const zenitByActorId = {};

          for (const actorId of actorIdsForRewardsUI) {
            const expKey = `exp_${actorId}`;
            const zenitKey = `zenit_${actorId}`;

            expByActorId[actorId] = safeNumber(fd.get(expKey), 0);
            zenitByActorId[actorId] = safeInt(fd.get(zenitKey), 0);
          }

          const createdAt = nowIso();
          const runId = buildRunId();

          payload.battleEnd = payload.battleEnd ?? {};
          payload.battleEnd.meta = {
            runId,
            createdAt,
            mode: (mode === "defeat") ? "defeat" : "victory"
          };

          const combatSnapshot = getCombatRoundSnapshot();

          payload.battleEnd.prompt = {
            returnSceneUuid,
            combat: { ...combatSnapshot, capturedAt: createdAt },
            expByActorId,
            zenitByActorId,
            bgm: { name: bgmName, playMusic: !!playMusic },
            fx: { playAnimation: !!playAnimation }
          };

          payload.battleEnd.results = payload.battleEnd.results ?? {};

          payload.phases = payload.phases ?? {};
          payload.phases.battleEnd = payload.phases.battleEnd ?? {};
          payload.phases.battleEnd.prompt = { status: "ok", at: createdAt };

          await sourceScene.setFlag(STORE_SCOPE, CANONICAL_KEY, payload);
          await sourceScene.setFlag(STORE_SCOPE, BATTLEEND_KEY, payload.battleEnd);

          promptResult = "ok";

          log("Saved battleEnd.prompt ✅", {
            sourceScene: { id: sourceScene.id, name: sourceScene.name },
            battleEnd: payload.battleEnd
          });
        }
      }
    },
    default: "confirm",
    close: async () => {
      // Covers the "X" close button.
      if (promptResult === "none") {
        promptResult = "cancelled";

        const cancelledAt = nowIso();

        payload.phases = payload.phases ?? {};
        payload.phases.battleEnd = payload.phases.battleEnd ?? {};
        payload.phases.battleEnd.prompt = { status: "cancelled", at: cancelledAt, via: "close-x" };

        payload.battleEnd = payload.battleEnd ?? {};
        payload.battleEnd.meta = payload.battleEnd.meta ?? {};
        payload.battleEnd.meta.cancelledAt = cancelledAt;

        try {
          await sourceScene.setFlag(STORE_SCOPE, CANONICAL_KEY, payload);
          await sourceScene.setFlag(STORE_SCOPE, BATTLEEND_KEY, payload.battleEnd);
        } catch (_) {}

        log("Prompt cancelled (closed); wrote marker ✅", { cancelledAt });
      }
    }
  });
;

  dlg.render(true);

  // After render: wire up preview updates
  setTimeout(() => {
    const root = dlg.element?.[0];
    if (!root) return;

    const sel = root.querySelector("#be_returnSceneSelect");
    const img = root.querySelector("#be_returnSceneThumb");
    const empty = root.querySelector("#be_returnSceneThumbEmpty");
    const label = root.querySelector("#be_returnSceneLabel");

    function applyPreview(uuid) {
      const sc = getSceneByUuid(uuid);
      const src = getScenePreviewSrc(sc);

      if (label) {
        const name = sc?.name ?? (uuid ? uuid : "(None)");
        label.textContent = uuid ? `Selected: ${name}` : "Selected: (None)";
      }

      if (img && empty) {
        if (src) {
          img.src = src;
          img.style.display = "";
          empty.style.display = "none";
        } else {
          img.removeAttribute("src");
          img.style.display = "none";
          empty.style.display = "";
        }
      }
    }

    // initial
    applyPreview(String(sel?.value ?? ""));

    // live update
    sel?.addEventListener("change", (ev) => {
      const v = String(ev?.target?.value ?? "");
      applyPreview(v);
    });
  }, 0);

})();
