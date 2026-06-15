// Battle End Prompt — GM dialog for the BATTLE_ENDING state.
//
// Auto-fills outcome (victory/defeat) from DirectorCombat state; return scene
// from sourceSceneId; victory BGM name from the game DB. GM can override any
// field. EXP and Zenit default to 0 (no Record Writer equivalent in BD).
//
// Returns a Promise<{ ok, outcome, returnSceneId, expByActorId, zenitByActorId, bgm, fx }>
// resolving when the GM confirms or cancels.

import { log } from "../logger.js";

async function fetchVictoryBgmFromDb() {
  try {
    const api = window?.FUCompanion?.api;
    if (!api?.getCurrentGameDb) return "";
    const { db } = await api.getCurrentGameDb();
    const raw = db?.system?.props?.victory_bgm;
    return typeof raw === "string" ? raw.trim() : "";
  } catch {
    return "";
  }
}

function getScenePreviewSrc(scene) {
  return scene?.background?.src || scene?.thumb || scene?.img || "";
}

function safeNumber(v, fallback = 0) {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : fallback;
}

function safeInt(v, fallback = 0) {
  return Math.floor(safeNumber(v, fallback));
}

export async function showBattleEndPrompt(endCtx) {
  const { outcome: detectedOutcome, sourceSceneId, partyActorIds } = endCtx;

  const dbVictoryBgm = await fetchVictoryBgmFromDb();

  const defaultMode = detectedOutcome;
  const defaultBgmName = defaultMode === "victory"
    ? (dbVictoryBgm || "Victory Fanfare")
    : "Defeat Theme";

  const returnScene = sourceSceneId ? game.scenes?.get?.(sourceSceneId) : null;
  const defaultReturnSceneId = returnScene?.id ?? "";

  const scenes = (game.scenes?.contents ?? [])
    .slice()
    .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));

  const sceneOptionsHtml = scenes.map(sc => {
    const sel = sc.id === defaultReturnSceneId ? "selected" : "";
    return `<option value="${sc.id}" ${sel}>${sc.name}</option>`;
  }).join("");

  const rewardRowsHtml = partyActorIds.length
    ? partyActorIds.map(actorId => {
        const actor = game.actors?.get?.(actorId);
        const name = actor?.name ?? `(Missing: ${actorId})`;
        return `
          <tr>
            <td style="padding:6px 8px;vertical-align:middle;overflow:hidden;">
              <div style="font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${name}</div>
              <div style="opacity:0.6;font-size:11px;word-break:break-all;">${actorId}</div>
            </td>
            <td style="padding:6px 8px;vertical-align:middle;">
              <input type="number" step="0.01" min="0" name="exp_${actorId}" value="0"
                style="width:100%;min-width:0;box-sizing:border-box;" />
            </td>
            <td style="padding:6px 8px;vertical-align:middle;">
              <input type="number" step="1" min="0" name="zenit_${actorId}" value="0"
                style="width:100%;min-width:0;box-sizing:border-box;" />
            </td>
          </tr>`;
      }).join("")
    : `<tr><td colspan="3" style="opacity:0.8;padding:8px;">No party actors detected in this battle.</td></tr>`;

  const existingReturnName = returnScene?.name ?? "(not detected)";

  const content = `
    <form id="bdBattleEndForm" autocomplete="off">
      <div style="display:flex;gap:12px;flex-direction:column;">

        <div style="padding:10px;border:1px solid rgba(255,255,255,0.15);border-radius:10px;">
          <div style="font-weight:800;margin-bottom:6px;">Battle End Mode</div>
          <div style="display:flex;gap:14px;align-items:center;">
            <label style="display:flex;gap:6px;align-items:center;">
              <input type="radio" name="mode" value="victory" ${defaultMode === "victory" ? "checked" : ""}/>
              <span>Victory</span>
            </label>
            <label style="display:flex;gap:6px;align-items:center;">
              <input type="radio" name="mode" value="defeat" ${defaultMode === "defeat" ? "checked" : ""}/>
              <span>Defeat</span>
            </label>
          </div>
          <div style="opacity:0.75;font-size:12px;margin-top:4px;">
            Auto-detected from battle state. Victory enables EXP + Zenit + Summary UI.
          </div>
        </div>

        <div style="padding:10px;border:1px solid rgba(255,255,255,0.15);border-radius:10px;">
          <div style="font-weight:800;margin-bottom:6px;">Return Scene</div>
          <div style="display:grid;grid-template-columns:1fr 220px;gap:12px;align-items:start;">
            <div>
              <select id="bd_returnSceneSel" name="returnSceneId" style="width:100%;">
                <option value="" ${defaultReturnSceneId ? "" : "selected"}>(None)</option>
                ${sceneOptionsHtml}
              </select>
              <div id="bd_returnSceneLabel" style="opacity:0.75;font-size:12px;margin-top:4px;">
                Default: ${existingReturnName} — from battle source scene.
              </div>
            </div>
            <div style="border:1px solid rgba(255,255,255,0.15);border-radius:10px;overflow:hidden;">
              <div style="padding:6px 8px;font-weight:800;font-size:12px;opacity:0.85;">Preview</div>
              <div style="height:120px;background:rgba(0,0,0,0.25);display:flex;align-items:center;justify-content:center;">
                <img id="bd_returnSceneThumb" src="" alt="" style="max-width:100%;max-height:120px;display:none;" />
                <div id="bd_returnSceneThumbEmpty" style="opacity:0.75;font-size:12px;padding:8px;text-align:center;">No preview</div>
              </div>
            </div>
          </div>
        </div>

        <div style="padding:10px;border:1px solid rgba(255,255,255,0.15);border-radius:10px;">
          <div style="font-weight:800;margin-bottom:6px;">Victory BGM &amp; FX</div>
          <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;">
            <label style="display:flex;gap:6px;align-items:center;">
              <input type="checkbox" name="playMusic" checked />
              <span>Play Music</span>
            </label>
            <label style="display:flex;gap:6px;align-items:center;">
              <input type="checkbox" name="playAnimation" checked />
              <span>Play Animation</span>
            </label>
          </div>
          <div style="margin-top:8px;">
            <div style="opacity:0.75;font-size:12px;margin-bottom:4px;">BGM Name (searched across all playlists)</div>
            <input type="text" name="bgmName" value="${defaultBgmName}" style="width:100%;" />
          </div>
        </div>

        <div style="padding:10px;border:1px solid rgba(255,255,255,0.15);border-radius:10px;">
          <div style="font-weight:800;margin-bottom:6px;">Rewards per Party Member (Victory only)</div>
          <table style="width:100%;table-layout:fixed;border-collapse:collapse;">
            <colgroup>
              <col style="width:52%"><col style="width:24%"><col style="width:24%">
            </colgroup>
            <thead>
              <tr>
                <th style="text-align:left;padding:6px 8px;opacity:0.8;">Actor</th>
                <th style="text-align:left;padding:6px 8px;opacity:0.8;">EXP</th>
                <th style="text-align:left;padding:6px 8px;opacity:0.8;">Zenit</th>
              </tr>
            </thead>
            <tbody>${rewardRowsHtml}</tbody>
          </table>
          <div style="opacity:0.75;font-size:12px;margin-top:6px;">Fill in rewards manually. Ignored on Defeat.</div>
        </div>

      </div>
    </form>`;

  return new Promise((resolve) => {
    let settled = false;
    function settleWith(result) {
      if (settled) return;
      settled = true;
      resolve(result);
    }

    const dlg = new Dialog({
      title: "[BD] Battle End",
      content,
      buttons: {
        cancel: {
          icon: '<i class="fas fa-times"></i>',
          label: "Cancel",
          callback: () => settleWith({ ok: false }),
        },
        confirm: {
          icon: '<i class="fas fa-check"></i>',
          label: "Confirm",
          callback: (html) => {
            const form = html?.[0]?.querySelector?.("#bdBattleEndForm");
            if (!form) { settleWith({ ok: false }); return; }

            const fd = new FormData(form);
            const outcome = String(fd.get("mode") ?? "victory");
            const returnSceneId = String(fd.get("returnSceneId") ?? "");
            const bgmName = String(fd.get("bgmName") ?? "");
            const playMusic = fd.get("playMusic") === "on";
            const playAnimation = fd.get("playAnimation") === "on";

            const expByActorId = {};
            const zenitByActorId = {};
            for (const id of partyActorIds) {
              expByActorId[id]   = safeNumber(fd.get(`exp_${id}`), 0);
              zenitByActorId[id] = safeInt(fd.get(`zenit_${id}`), 0);
            }

            log("[BattleEnd:Prompt] Confirmed", { outcome, returnSceneId, bgmName });
            settleWith({
              ok: true,
              outcome: outcome === "defeat" ? "defeat" : "victory",
              returnSceneId,
              expByActorId,
              zenitByActorId,
              bgm: { name: bgmName, playMusic },
              fx:  { playAnimation },
            });
          },
        },
      },
      default: "confirm",
      close: () => settleWith({ ok: false }),
    });

    dlg.render(true);

    // Wire scene preview after render
    setTimeout(() => {
      const root = dlg.element?.[0];
      if (!root) return;
      const sel   = root.querySelector("#bd_returnSceneSel");
      const img   = root.querySelector("#bd_returnSceneThumb");
      const empty = root.querySelector("#bd_returnSceneThumbEmpty");
      const label = root.querySelector("#bd_returnSceneLabel");

      function applyPreview(sceneId) {
        const sc = game.scenes?.get?.(sceneId);
        const src = getScenePreviewSrc(sc);
        if (label) label.textContent = sceneId
          ? `Selected: ${sc?.name ?? sceneId}`
          : "Selected: (None)";
        if (img && empty) {
          if (src) {
            img.src = src; img.style.display = "";
            empty.style.display = "none";
          } else {
            img.removeAttribute("src"); img.style.display = "none";
            empty.style.display = "";
          }
        }
      }

      applyPreview(defaultReturnSceneId);
      sel?.addEventListener("change", ev => applyPreview(String(ev?.target?.value ?? "")));
    }, 0);
  });
}
