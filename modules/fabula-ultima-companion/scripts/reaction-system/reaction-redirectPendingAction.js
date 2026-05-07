/**
 * [Reaction] Redirect Pending Action.js
 * Foundry VTT v12
 * ---------------------------------------------------------------------------
 * PURPOSE
 * -------
 * Generic helper for reaction skills that need to intercept / redirect
 * an already-created pending Action Card.
 *
 * Main use case right now:
 *   Protect / Cover / Bodyguard style reactions
 *
 * But kept generic enough for future mechanics that need to:
 *   - find a pending action card
 *   - choose which target slot to intercept
 *   - replace that target with the reacting creature
 *
 * WHAT THIS SCRIPT DOES
 * ---------------------
 * 1) Scans pending FU Action Cards in chat
 * 2) Filters to cards that are still unconfirmed (no actionApplied flag)
 * 3) Matches the source action reference if available
 * 4) Shows a dialog so the player can choose which pending action to redirect
 * 5) Rewrites the target slot in the chosen action card payload
 * 6) Optionally asks a future rebuild script to re-render the card
 *
 * API
 * ---
 * window["oni.ReactionRedirectPendingAction"] = {
 *   findPendingActionCandidates(opts),
 *   openRedirectDialog(opts),
 *   redirectFromPayload(payload, opts),
 *   applyRedirectSelection(selection, opts)
 * }
 *
 * TYPICAL CUSTOM LOGIC USAGE
 * --------------------------
 * const api = window["oni.ReactionRedirectPendingAction"];
 * const result = await api.redirectFromPayload(__PAYLOAD, {
 *   mode: "replace_one_target_with_reactor",
 *   rebuildCard: true
 * });
 *
 * if (result?.ok) {
 *   context.cancelPipeline("Protect redirect applied.", { notify: false });
 * }
 */

Hooks.once("ready", () => {
  (() => {
    const KEY = "oni.ReactionRedirectPendingAction";
    if (window[KEY]) {
      console.log("[ReactionRedirectPendingAction] Already installed.");
      return;
    }

    const MODULE_NS = "fabula-ultima-companion";
    const CARD_FLAG = "actionCard";
    const APPLIED_FLAG = "actionApplied";
    const STYLE_ID = "oni-reaction-redirect-pending-action-style";
    const TAG = "[ReactionRedirectPendingAction]";
    const DEBUG = true;

    const log = (...a) => DEBUG && console.log(TAG, ...a);
    const warn = (...a) => DEBUG && console.warn(TAG, ...a);
    const err = (...a) => DEBUG && console.error(TAG, ...a);

    function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .oni-rpa-wrap {
      padding: 4px 6px 8px 6px;
    }
    .oni-rpa-head {
      margin-bottom: 8px;
      font-size: 11px;
      line-height: 1.3;
      opacity: 0.88;
    }
    .oni-rpa-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
      max-height: 360px;
      overflow-y: auto;
    }
    .oni-rpa-row {
      border-radius: 16px;
      border: 2px solid #7a6a55;
      background: linear-gradient(180deg, #f6f1e6, #ebdfc7);
      box-shadow:
        0 3px 0 rgba(41,33,24,0.55),
        0 0 0 1px rgba(255,255,255,0.65) inset;
      cursor: pointer;
      transition: transform 120ms ease-out, filter 120ms ease-out, box-shadow 120ms ease-out;
    }
    .oni-rpa-row:hover {
      transform: translateY(-1px);
      filter: brightness(1.03);
      box-shadow:
        0 4px 0 rgba(41,33,24,0.65),
        0 0 0 1px rgba(255,255,255,0.8) inset;
    }

    .oni-rpa-target-dimmer {
      position: fixed;
      inset: 0;
      z-index: 999999;
      background: rgba(0,0,0,0.58);
      display: flex;
      align-items: center;
      justify-content: center;
      animation: oni-rpa-fadein 120ms ease-out;
    }

    .oni-rpa-target-panel {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 18px;
      padding: 18px 22px;
      background: transparent;
      border: none;
      box-shadow: none;
      pointer-events: auto;
    }

    .oni-rpa-target-btn {
      appearance: none;
      border: none;
      background: transparent;
      padding: 0;
      margin: 0;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
      transition: transform 120ms ease-out, filter 120ms ease-out;
    }

    .oni-rpa-target-btn:hover {
      transform: translateY(-2px) scale(1.03);
      filter: brightness(1.06);
    }

    .oni-rpa-target-btn:active {
      transform: scale(0.98);
    }

    .oni-rpa-target-btn img {
      width: 82px;
      height: 82px;
      object-fit: cover;
      border-radius: 14px;
      box-shadow:
        0 8px 24px rgba(0,0,0,0.35),
        0 0 0 2px rgba(255,255,255,0.18),
        0 0 0 4px rgba(122,106,85,0.45);
      background: rgba(255,255,255,0.04);
      display: block;
    }

    .oni-rpa-target-label {
      font-size: 13px;
      font-weight: 800;
      color: #fff;
      text-shadow: 0 2px 4px rgba(0,0,0,0.55);
      max-width: 96px;
      text-align: center;
      line-height: 1.15;
      word-break: break-word;
    }

    .oni-rpa-target-help {
      position: fixed;
      left: 50%;
      top: calc(50% - 92px);
      transform: translateX(-50%);
      z-index: 1000000;
      font-size: 14px;
      font-weight: 800;
      color: #fff;
      text-shadow: 0 2px 6px rgba(0,0,0,0.6);
      pointer-events: none;
      text-align: center;
      white-space: nowrap;
    }

    @keyframes oni-rpa-fadein {
      from { opacity: 0; }
      to   { opacity: 1; }
    }
  `;
  document.head.appendChild(style);
}

    function esc(v) {
      if (v == null) return "";
      return String(v)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    function clone(value, fallback = null) {
      try {
        if (foundry?.utils?.deepClone) return foundry.utils.deepClone(value);
      } catch (_e) {}
      try {
        return structuredClone(value);
      } catch (_e) {}
      try {
        return JSON.parse(JSON.stringify(value));
      } catch (_e) {}
      return fallback;
    }

    function uniq(arr) {
      return [...new Set((Array.isArray(arr) ? arr : []).filter(Boolean).map(v => String(v).trim()).filter(Boolean))];
    }

    function firstNonBlank(...values) {
      for (const value of values) {
        if (value == null) continue;
        const s = String(value).trim();
        if (s) return s;
      }
      return "";
    }

    function asArray(value) {
      return Array.isArray(value) ? value : (value == null ? [] : [value]);
    }

    async function resolveDocument(uuidOrDoc) {
      if (!uuidOrDoc) return null;
      if (typeof uuidOrDoc !== "string") return uuidOrDoc;
      try {
        return await fromUuid(uuidOrDoc);
      } catch (_e) {
        return null;
      }
    }

    async function resolveTokenDoc(uuidOrDoc) {
      const doc = await resolveDocument(uuidOrDoc);
      if (!doc) return null;

      if (doc?.documentName === "Token" || doc?.documentName === "TokenDocument") return doc;
      if (doc?.object?.document?.documentName === "Token") return doc.object.document;
      if (doc?.document?.documentName === "Token") return doc.document;

      const actor =
        doc?.documentName === "Actor" ? doc :
        doc?.actor ? doc.actor :
        doc?.token?.actor ? doc.token.actor :
        null;

      if (actor) {
        try {
          const active = actor.getActiveTokens?.(true, true) ?? actor.getActiveTokens?.() ?? [];
          if (active?.[0]?.document) return active[0].document;
          if (active?.[0]?.documentName === "Token") return active[0];
        } catch (_e) {}

        try {
          const proto = actor.prototypeToken ?? actor.token ?? null;
          if (proto?.documentName === "Token" || proto?.documentName === "TokenDocument") return proto;
          if (proto?.document?.documentName === "Token") return proto.document;
        } catch (_e) {}
      }

      return null;
    }

    async function resolveActor(uuidOrDoc) {
      const doc = await resolveDocument(uuidOrDoc);
      if (!doc) return null;
      if (doc?.documentName === "Actor") return doc;
      if (doc?.actor) return doc.actor;
      if (doc?.object?.actor) return doc.object.actor;
      if (doc?.token?.actor) return doc.token.actor;
      if (doc?.document?.actor) return doc.document.actor;
      return null;
    }

    async function resolveName(uuidOrDoc, fallback = "Unknown") {
      const tokenDoc = await resolveTokenDoc(uuidOrDoc);
      if (tokenDoc?.name) return tokenDoc.name;

      const actor = await resolveActor(uuidOrDoc);
      if (actor?.name) return actor.name;

      const doc = await resolveDocument(uuidOrDoc);
      if (doc?.name) return doc.name;

      return fallback;
    }

    function findProtectedTargetUUIDs(payload = {}) {
      const phasePayload =
        payload?.reaction_phase_payload ??
        payload?.meta?.reaction_phase_payload ??
        {};

      const phaseMap =
        payload?.reaction_phase_payload_by_trigger ??
        payload?.meta?.reaction_phase_payload_by_trigger ??
        {};

      const out = [];

      const collectFrom = (src) => {
        if (!src || typeof src !== "object") return;
        if (Array.isArray(src.targets)) out.push(...src.targets);
        if (src.targetUuid) out.push(src.targetUuid);
        if (src.targetTokenUuid) out.push(src.targetTokenUuid);
      };

      collectFrom(phasePayload);

      if (phaseMap && typeof phaseMap === "object") {
        for (const v of Object.values(phaseMap)) collectFrom(v);
      }

      return uniq(out);
    }

    function extractSourceActionRef(payload = {}) {
      const meta = payload?.meta ?? {};
      return {
        sourceActionId: firstNonBlank(
          payload?.sourceActionId,
          meta?.sourceActionId
        ) || null,
        sourceActionCardId: firstNonBlank(
          payload?.sourceActionCardId,
          meta?.sourceActionCardId
        ) || null,
        sourceActionCardMessageId: firstNonBlank(
          payload?.sourceActionCardMessageId,
          meta?.sourceActionCardMessageId
        ) || null,
        sourceActionCardVersion: Number(
          payload?.sourceActionCardVersion ??
          meta?.sourceActionCardVersion ??
          NaN
        ),
        sourceActionOwnerUserId: firstNonBlank(
          payload?.sourceActionOwnerUserId,
          meta?.sourceActionOwnerUserId
        ) || null,
        sourceActionOwnerUserName: firstNonBlank(
          payload?.sourceActionOwnerUserName,
          meta?.sourceActionOwnerUserName
        ) || null
      };
    }

    async function resolveReactorInfo(payload = {}, opts = {}) {
      const reactorRef = firstNonBlank(
        opts?.reactorUuid,
        payload?.meta?.attackerUuid,
        payload?.attackerUuid,
        payload?.attackerActorUuid
      );

      if (!reactorRef) {
        return {
          tokenDoc: null,
          actor: null,
          tokenUuid: null,
          actorUuid: null,
          name: "Unknown"
        };
      }

      const tokenDoc = await resolveTokenDoc(reactorRef);
      const actor = tokenDoc?.actor ?? await resolveActor(reactorRef);

      const tokenUuid = tokenDoc?.uuid ?? tokenDoc?.document?.uuid ?? null;
      const actorUuid = actor?.uuid ?? null;
      const name = tokenDoc?.name ?? actor?.name ?? "Unknown";

      return { tokenDoc, actor, tokenUuid, actorUuid, name };
    }

    async function getActionCardWrapper(chatMsg) {
      try {
        const wrapper = chatMsg?.getFlag?.(MODULE_NS, CARD_FLAG);
        return wrapper && typeof wrapper === "object" ? clone(wrapper, {}) : null;
      } catch (_e) {
        return null;
      }
    }

    async function getActionCardPayload(chatMsg) {
      const wrapper = await getActionCardWrapper(chatMsg);
      const payload = wrapper?.payload ?? null;
      return payload && typeof payload === "object" ? payload : null;
    }

    function getActionCardIdentity(wrapper = {}, payload = {}) {
      const meta = payload?.meta ?? {};
      return {
        actionId: firstNonBlank(wrapper?.actionId, payload?.actionId, meta?.actionId) || null,
        actionCardId: firstNonBlank(wrapper?.actionCardId, payload?.actionCardId, meta?.actionCardId) || null,
        actionCardMessageId: firstNonBlank(wrapper?.actionCardMessageId, payload?.actionCardMessageId, meta?.actionCardMessageId) || null,
        actionCardVersion: Number(
          wrapper?.actionCardVersion ??
          payload?.actionCardVersion ??
          meta?.actionCardVersion ??
          NaN
        )
      };
    }

    function readTargetUUIDsFromPayload(payload = {}) {
      return uniq(
        payload?.originalTargetUUIDs ??
        payload?.meta?.originalTargetUUIDs ??
        payload?.targets ??
        []
      );
    }

    function readTargetActorUUIDsFromPayload(payload = {}) {
      return asArray(
        payload?.originalTargetActorUUIDs ??
        payload?.meta?.originalTargetActorUUIDs ??
        []
      ).map(v => v == null ? null : String(v));
    }

    function computeMatchingTargetIndexes(targetUUIDs = [], protectedTargetUUIDs = []) {
      const wanted = new Set(uniq(protectedTargetUUIDs));
      const indexes = [];

      for (let i = 0; i < targetUUIDs.length; i++) {
        const v = String(targetUUIDs[i] ?? "").trim();
        if (v && wanted.has(v)) indexes.push(i);
      }

      return indexes;
    }

    async function buildCandidateFromMessage(chatMsg, opts = {}) {
      const wrapper = await getActionCardWrapper(chatMsg);
      if (!wrapper?.payload) return null;

      const payload = wrapper.payload;
      const meta = payload?.meta ?? {};
      const core = payload?.core ?? {};

      const applied = await chatMsg.getFlag(MODULE_NS, APPLIED_FLAG);
      if (applied) return null;

      const identity = getActionCardIdentity(wrapper, payload);
      const sourceRef = opts?.sourceRef ?? {};
      const protectedTargetUUIDs = uniq(opts?.protectedTargetUUIDs ?? []);

      const targetUUIDs = readTargetUUIDsFromPayload(payload);
      if (!targetUUIDs.length) return null;

      const exactMessageMatch =
        !!(sourceRef?.sourceActionCardMessageId && String(chatMsg.id) === String(sourceRef.sourceActionCardMessageId));

      const exactActionIdMatch =
        !!(sourceRef?.sourceActionId && identity.actionId && String(identity.actionId) === String(sourceRef.sourceActionId));

      const exactCardIdMatch =
        !!(sourceRef?.sourceActionCardId && identity.actionCardId && String(identity.actionCardId) === String(sourceRef.sourceActionCardId));

      let matchingIndexes = [];
      if (protectedTargetUUIDs.length) {
        matchingIndexes = computeMatchingTargetIndexes(targetUUIDs, protectedTargetUUIDs);
      } else {
        matchingIndexes = targetUUIDs.map((_, i) => i);
      }

      const exactRefMatch = exactMessageMatch || exactActionIdMatch || exactCardIdMatch;

      if (!exactRefMatch && !matchingIndexes.length) return null;

      const attackerName = firstNonBlank(
        meta?.attackerName,
        payload?.attackerName,
        "Unknown"
      );

      const skillName = firstNonBlank(
        core?.skillName,
        payload?.skillName,
        chatMsg?.speaker?.alias,
        "Unnamed Action"
      );

      const targetActorUUIDs = readTargetActorUUIDsFromPayload(payload);

      const targetNames = [];
      for (const u of targetUUIDs) {
        targetNames.push(await resolveName(u, "Unknown Target"));
      }

      return {
        messageId: String(chatMsg.id),
        chatMsg,
        wrapper,
        payload,
        identity,
        exactRefMatch,
        exactMessageMatch,
        exactActionIdMatch,
        exactCardIdMatch,
        matchingIndexes,
        targetUUIDs,
        targetActorUUIDs,
        targetNames,
        attackerName,
        skillName,
        skillImg: firstNonBlank(
          core?.skillImg,
          payload?.skillImg,
          chatMsg?.speaker?.img,
          ""
        ) || null,
        createdAt: chatMsg.timestamp ?? chatMsg._source?.timestamp ?? null,
        sortScore: exactRefMatch ? 100 : 0
      };
    }

    async function findPendingActionCandidates(opts = {}) {
      const sourceRef = opts?.sourceRef ?? {};
      const protectedTargetUUIDs = uniq(opts?.protectedTargetUUIDs ?? []);

      const messages = Array.from(game.messages?.contents ?? []).slice().reverse();
      const out = [];

      for (const chatMsg of messages) {
        const candidate = await buildCandidateFromMessage(chatMsg, {
          sourceRef,
          protectedTargetUUIDs
        });
        if (candidate) out.push(candidate);
      }

      out.sort((a, b) => {
        if ((b.sortScore || 0) !== (a.sortScore || 0)) return (b.sortScore || 0) - (a.sortScore || 0);
        const at = Number(a.createdAt || 0);
        const bt = Number(b.createdAt || 0);
        return bt - at;
      });

      return out;
    }

    async function buildSelectionRows(candidates = [], reactorName = "Reactor") {
  const rows = [];

  for (const candidate of candidates) {
    const targetNames = candidate.matchingIndexes
      .map(i => candidate.targetNames[i] ?? `Target #${i + 1}`)
      .filter(Boolean);

    const img = candidate.skillImg
      ? `<img src="${esc(candidate.skillImg)}"
              alt=""
              style="
                width:34px;
                height:34px;
                object-fit:cover;
                border-radius:8px;
                flex:0 0 34px;
                box-shadow:0 1px 2px rgba(0,0,0,.25), inset 0 0 0 1px rgba(0,0,0,.18);
              ">`
      : `<div style="
              width:34px;
              height:34px;
              border-radius:8px;
              flex:0 0 34px;
              display:flex;
              align-items:center;
              justify-content:center;
              font-size:16px;
              background:rgba(72,56,39,0.10);
              border:1px solid rgba(72,56,39,0.18);
            ">⚔️</div>`;

    const targetHtml = targetNames.length
      ? targetNames.map(name => `
          <div style="
            font-size:13px;
            font-weight:800;
            line-height:1.08;
            color:#2f6fd6;
            white-space:nowrap;
            overflow:hidden;
            text-overflow:ellipsis;
          ">${esc(name)}</div>
        `).join("")
      : `<div style="
            font-size:13px;
            font-weight:800;
            line-height:1.08;
            color:#2f6fd6;
          ">Unknown</div>`;

    rows.push({
      id: `${candidate.messageId}`,
      candidate,
      createdAt: Number(candidate.createdAt || 0),
      exactRefMatch: !!candidate.exactRefMatch,
      html: `
        <div class="oni-rpa-row"
             data-row-id="${esc(candidate.messageId)}"
             style="
               padding:8px 12px;
               display:flex;
               align-items:center;
               gap:10px;
             ">
          ${img}

          <div style="
            min-width:0;
            flex:1 1 auto;
            display:flex;
            flex-direction:column;
            justify-content:center;
          ">
            <div style="
              font-size:14px;
              font-weight:800;
              line-height:1.15;
              color:#3a2b1b;
              white-space:nowrap;
              overflow:hidden;
              text-overflow:ellipsis;
            ">
              ${esc(candidate.skillName)}
            </div>

            <div style="
              font-size:10px;
              opacity:.72;
              line-height:1.1;
              margin-top:2px;
              white-space:nowrap;
              overflow:hidden;
              text-overflow:ellipsis;
            ">
              ${candidate.exactRefMatch ? "Latest matching action" : "Pending action"}
            </div>
          </div>

          <div style="
            flex:0 0 auto;
            text-align:right;
            min-width:98px;
            max-width:150px;
          ">
            <div style="
              font-size:10px;
              opacity:.7;
              line-height:1.05;
              margin-bottom:2px;
            ">Targets</div>
            ${targetHtml}
          </div>
        </div>
      `
    });
  }

  rows.sort((a, b) => {
    if ((b.exactRefMatch ? 1 : 0) !== (a.exactRefMatch ? 1 : 0)) {
      return (b.exactRefMatch ? 1 : 0) - (a.exactRefMatch ? 1 : 0);
    }
    return (b.createdAt || 0) - (a.createdAt || 0);
  });

  return rows;
}

function isVideoPath(src) {
  const s = String(src ?? "").trim().toLowerCase();
  return !!s && (
    s.endsWith(".webm") ||
    s.endsWith(".mp4") ||
    s.endsWith(".m4v") ||
    s.endsWith(".mov")
  );
}

async function captureVideoStill(src, { width = 128, height = 128 } = {}) {
  return await new Promise((resolve) => {
    try {
      const video = document.createElement("video");
      video.preload = "auto";
      video.muted = true;
      video.playsInline = true;
      video.crossOrigin = "anonymous";
      video.src = src;

      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        try {
          video.pause();
          video.removeAttribute("src");
          video.load();
        } catch (_e) {}
        resolve(value);
      };

      const fail = () => done(null);

      video.addEventListener("error", fail, { once: true });

      video.addEventListener("loadeddata", () => {
        try {
          const vw = Number(video.videoWidth || 0);
          const vh = Number(video.videoHeight || 0);
          if (!vw || !vh) return fail();

          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;

          const ctx = canvas.getContext("2d");
          if (!ctx) return fail();

          // cover crop
          const scale = Math.max(width / vw, height / vh);
          const drawW = vw * scale;
          const drawH = vh * scale;
          const dx = (width - drawW) / 2;
          const dy = (height - drawH) / 2;

          ctx.clearRect(0, 0, width, height);
          ctx.drawImage(video, dx, dy, drawW, drawH);

          const dataUrl = canvas.toDataURL("image/png");
          done(dataUrl || null);
        } catch (_e) {
          fail();
        }
      }, { once: true });

      video.load();
    } catch (_e) {
      resolve(null);
    }
  });
}

async function resolveTokenPreviewImage(targetUuid, { size = 128 } = {}) {
  const tokenDoc = await resolveTokenDoc(targetUuid);
  const actor = tokenDoc?.actor ?? await resolveActor(targetUuid);

  const tokenTexture =
    tokenDoc?.texture?.src ??
    tokenDoc?.document?.texture?.src ??
    tokenDoc?.prototypeToken?.texture?.src ??
    "";

  const actorImg = String(actor?.img ?? "").trim();
  const tokenSrc = String(tokenTexture ?? "").trim();

  // 1) normal still token image
  if (tokenSrc && !isVideoPath(tokenSrc)) {
    return tokenSrc;
  }

  // 2) animated token/video -> capture still frame
  if (tokenSrc && isVideoPath(tokenSrc)) {
    const still = await captureVideoStill(tokenSrc, { width: size, height: size });
    if (still) return still;
  }

  // 3) fallback to actor image if usable
  if (actorImg && !isVideoPath(actorImg)) {
    return actorImg;
  }

  // 4) actor image video fallback
  if (actorImg && isVideoPath(actorImg)) {
    const still = await captureVideoStill(actorImg, { width: size, height: size });
    if (still) return still;
  }

  // 5) final fallback
  return "icons/svg/mystery-man.svg";
}

async function openTargetSelectorForCandidate(candidate, opts = {}) {
  ensureStyles();

  const matchingIndexes = Array.isArray(candidate?.matchingIndexes)
    ? candidate.matchingIndexes
    : [];

  if (!matchingIndexes.length) return null;

      const choices = [];
    for (const index of matchingIndexes) {
      const targetUuid = candidate?.targetUUIDs?.[index] ?? null;
      const tokenDoc = await resolveTokenDoc(targetUuid);
      const actor = tokenDoc?.actor ?? await resolveActor(targetUuid);

      const img = await resolveTokenPreviewImage(targetUuid, { size: 128 });

      const name =
        candidate?.targetNames?.[index] ??
        tokenDoc?.name ??
        actor?.name ??
        `Target #${index + 1}`;

      choices.push({
        targetIndex: index,
        originalTargetName: name,
        targetUuid,
        img
      });
    }

  return await new Promise((resolve) => {
    const dimmer = document.createElement("div");
    dimmer.className = "oni-rpa-target-dimmer";

    const help = document.createElement("div");
    help.className = "oni-rpa-target-help";
    help.textContent = "Choose which ally to protect";

    const panel = document.createElement("div");
    panel.className = "oni-rpa-target-panel";

    const cleanup = () => {
      try { dimmer.remove(); } catch (_e) {}
      try { help.remove(); } catch (_e) {}
      document.removeEventListener("keydown", onKeyDown, true);
    };

    const onKeyDown = (ev) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        cleanup();
        resolve(null);
      }
    };

    for (const choice of choices) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "oni-rpa-target-btn";
      btn.innerHTML = `
        <img src="${esc(choice.img)}" alt="${esc(choice.originalTargetName)}">
        <div class="oni-rpa-target-label">${esc(choice.originalTargetName)}</div>
      `;

      btn.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        cleanup();
        resolve({
          candidate,
          targetIndex: choice.targetIndex,
          originalTargetName: choice.originalTargetName
        });
      });

      panel.appendChild(btn);
    }

    panel.addEventListener("click", (ev) => {
      ev.stopPropagation();
    });

    dimmer.addEventListener("click", () => {
      cleanup();
      resolve(null);
    });

    document.addEventListener("keydown", onKeyDown, true);

    dimmer.appendChild(panel);
    document.body.appendChild(dimmer);
    document.body.appendChild(help);
  });
}

    async function requestProtectTargetViaJRPGTargeting(candidate, reactorInfo = {}, opts = {}) {
      const targetingApi =
        game.modules?.get(MODULE_NS)?.api?.JRPGTargeting ??
        globalThis.__ONI_JRPG_TARGETING_API__ ??
        null;

      if (!targetingApi?.requestTargeting) {
        ui.notifications.warn("[Reaction] JRPG Targeting API is not available for Protect target selection.");
        return { ok: false, cancelled: true, reason: "targeting_api_missing" };
      }

      const allowed = [];
      const indexByTokenUuid = new Map();

      for (const index of candidate?.matchingIndexes ?? []) {
        const tokenUuid = String(candidate?.targetUUIDs?.[index] ?? "").trim();
        const actorUuid = String(candidate?.targetActorUUIDs?.[index] ?? "").trim();

        if (!tokenUuid) continue;

        // You cannot protect yourself.
        if (reactorInfo?.tokenUuid && tokenUuid === String(reactorInfo.tokenUuid)) continue;
        if (reactorInfo?.actorUuid && actorUuid && actorUuid === String(reactorInfo.actorUuid)) continue;

        if (!indexByTokenUuid.has(tokenUuid)) {
          indexByTokenUuid.set(tokenUuid, index);
          allowed.push(tokenUuid);
        }
      }

      if (!allowed.length) {
        ui.notifications.warn("[Reaction] No valid protect targets remain after excluding the protector.");
        return { ok: false, cancelled: true, reason: "no_valid_protect_targets" };
      }

      if (allowed.length === 1) {
        const targetIndex = indexByTokenUuid.get(allowed[0]);
        const originalTargetName =
          candidate?.targetNames?.[targetIndex] ??
          `Target #${Number(targetIndex) + 1}`;

        return {
          ok: true,
          picked: {
            candidate,
            targetIndex,
            originalTargetName
          }
        };
      }

      const result = await targetingApi.requestTargeting({
        userId: game.user?.id ?? null,
        skillTarget: "One Creature",
        sourceActorUuid: reactorInfo?.actorUuid ?? reactorInfo?.tokenUuid ?? null,
        uiTitleText: "Choose which ally to protect",
        allowedTargetTokenUuids: allowed
      });

      if (!result?.confirmed) {
        return { ok: false, cancelled: true, reason: "targeting_cancelled" };
      }

      const chosenTokenUuid = String(result?.tokenUuids?.[0] ?? "").trim();
      const targetIndex = indexByTokenUuid.get(chosenTokenUuid);

      if (!chosenTokenUuid || !Number.isInteger(targetIndex)) {
        return { ok: false, cancelled: true, reason: "targeting_no_match" };
      }

      const originalTargetName =
        candidate?.targetNames?.[targetIndex] ??
        `Target #${Number(targetIndex) + 1}`;

      return {
        ok: true,
        picked: {
          candidate,
          targetIndex,
          originalTargetName
        }
      };
    }

    async function openRedirectDialog(opts = {}) {
  ensureStyles();

  const payload = opts?.payload ?? {};
  const sourceRef = opts?.sourceRef ?? extractSourceActionRef(payload);
  const protectedTargetUUIDs = uniq(
    opts?.protectedTargetUUIDs?.length
      ? opts.protectedTargetUUIDs
      : findProtectedTargetUUIDs(payload)
  );

  const reactorInfo = await resolveReactorInfo(payload, opts);
  const reactorName = reactorInfo?.name ?? "Reactor";

  const candidates = await findPendingActionCandidates({
    sourceRef,
    protectedTargetUUIDs
  });

  if (!candidates.length) {
    ui.notifications.warn("[Reaction] No pending action cards matched for redirect.");
    log("No redirect candidates found.", {
      sourceRef,
      protectedTargetUUIDs,
      reactorInfo
    });
    return { ok: false, cancelled: true, reason: "no_candidates" };
  }

  const rows = await buildSelectionRows(candidates, reactorName);
  if (!rows.length) {
    ui.notifications.warn("[Reaction] Matching action card found, but no valid target slot was available to redirect.");
    return { ok: false, cancelled: true, reason: "no_matching_target_slot" };
  }

  const protectedNames = [];
  for (const u of protectedTargetUUIDs) {
    protectedNames.push(await resolveName(u, "Unknown Ally"));
  }

  const protectedLine = protectedNames.length
    ? `<b>Protected target:</b> ${esc(protectedNames.join(", "))}<br>`
    : "";

  const content = `
    <div class="oni-rpa-wrap">
      <div class="oni-rpa-head">
        Choose which pending action should be redirected.<br>
        ${protectedLine}
        <b>Redirect to:</b> ${esc(reactorName)}
      </div>
      <div class="oni-rpa-list">
        ${rows.map(r => r.html).join("")}
      </div>
    </div>
  `;

    const picked = await new Promise((resolve) => {
    let dlg = null;
    let busy = false;
    let suppressCloseResolve = false;

    dlg = new Dialog({
      title: "Choose Action To Redirect",
      content,
      buttons: {},
      close: () => {
        if (suppressCloseResolve) return;
        resolve(null);
      },
      render: (html) => {
        const rowMap = new Map(rows.map(r => [r.id, r]));
        const $html = $(html);
        const $rows = $html.find(".oni-rpa-row");

        $rows.on("click", async function () {
          if (busy) return;
          busy = true;

          try {
            const id = this.dataset.rowId;
            const row = rowMap.get(id);
            const candidate = row?.candidate ?? null;

            if (!candidate) {
              busy = false;
              return;
            }

            // Single valid target slot -> no second targeting request needed
            if ((candidate.matchingIndexes?.length ?? 0) <= 1) {
              const targetIndex = candidate.matchingIndexes?.[0] ?? 0;
              const originalTargetName =
                candidate.targetNames?.[targetIndex] ??
                `Target #${targetIndex + 1}`;

              resolve({
                candidate,
                targetIndex,
                originalTargetName
              });

              suppressCloseResolve = true;
              dlg.close();
              return;
            }

            // Multi-target case:
            // Close the redirect window FIRST,
            // then enter JRPG targeting mode.
            suppressCloseResolve = true;
            dlg.close();

            const targetingPick = await requestProtectTargetViaJRPGTargeting(
              candidate,
              reactorInfo,
              { reactorName }
            );

            if (!targetingPick?.ok) {
              resolve(null);
              return;
            }

            resolve(targetingPick.picked);
          } catch (e) {
            console.error("[ReactionRedirectPendingAction] Row click handling failed:", e);
            busy = false;
            resolve(null);
          }
        });
      }
    }, { width: 470 });

    dlg.render(true);
  });

  if (!picked) {
    log("Redirect dialog closed without selection.");
    return { ok: false, cancelled: true, reason: "dialog_closed" };
  }

  return {
    ok: true,
    picked,
    sourceRef,
    protectedTargetUUIDs,
    reactorInfo
  };
}

    function buildRemoteRedirectScript() {
  return `
const selection = globals?.__REDIRECT_SELECTION ?? {};
const opts = globals?.__REDIRECT_OPTS ?? {};
const payloadIn = payload ?? {};

const MODULE_NS = "fabula-ultima-companion";
const CARD_FLAG = "actionCard";
const APPLIED_FLAG = "actionApplied";
const CREATE_ACTION_CARD_MACRO_NAME = "CreateActionCard";

function firstNonBlank(...values) {
  for (const value of values) {
    if (value == null) continue;
    const s = String(value).trim();
    if (s) return s;
  }
  return "";
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function clone(value) {
  try {
    return foundry.utils.deepClone(value);
  } catch (_e) {
    return JSON.parse(JSON.stringify(value));
  }
}

function readWrapperIdentity(wrapper = {}, payload = {}) {
  const meta = payload?.meta ?? {};
  return {
    actionId: firstNonBlank(wrapper?.actionId, payload?.actionId, meta?.actionId) || null,
    actionCardId: firstNonBlank(wrapper?.actionCardId, payload?.actionCardId, meta?.actionCardId) || null,
    actionCardMessageId: firstNonBlank(wrapper?.actionCardMessageId, payload?.actionCardMessageId, meta?.actionCardMessageId) || null,
    actionCardVersion: Number(
      wrapper?.actionCardVersion ??
      payload?.actionCardVersion ??
      meta?.actionCardVersion ??
      NaN
    )
  };
}

function readTargetList(actionPayload = {}) {
  if (Array.isArray(actionPayload?.originalTargetUUIDs) && actionPayload.originalTargetUUIDs.length) {
    return [...actionPayload.originalTargetUUIDs];
  }
  if (Array.isArray(actionPayload?.meta?.originalTargetUUIDs) && actionPayload.meta.originalTargetUUIDs.length) {
    return [...actionPayload.meta.originalTargetUUIDs];
  }
  if (Array.isArray(actionPayload?.targets) && actionPayload.targets.length) {
    return [...actionPayload.targets];
  }
  return [];
}

function readActorTargetList(actionPayload = {}) {
  if (Array.isArray(actionPayload?.originalTargetActorUUIDs) && actionPayload.originalTargetActorUUIDs.length) {
    return [...actionPayload.originalTargetActorUUIDs];
  }
  if (Array.isArray(actionPayload?.meta?.originalTargetActorUUIDs) && actionPayload.meta.originalTargetActorUUIDs.length) {
    return [...actionPayload.meta.originalTargetActorUUIDs];
  }
  return [];
}

async function findNewestMessageForActionId(actionId, excludeMessageId = null, beforeIds = null) {
  const msgs = Array.from(game.messages?.contents ?? []).slice().reverse();

  for (const msg of msgs) {
    if (!msg) continue;
    if (excludeMessageId && String(msg.id) === String(excludeMessageId)) continue;
    if (beforeIds && beforeIds.has(String(msg.id))) continue;

    let wrapper = null;
    try {
      wrapper = msg.getFlag(MODULE_NS, CARD_FLAG);
    } catch (_e) {}

    const payload = wrapper?.payload ?? {};
    const meta = payload?.meta ?? {};
    const msgActionId = firstNonBlank(wrapper?.actionId, payload?.actionId, meta?.actionId);

    if (msgActionId && String(msgActionId) === String(actionId)) {
      return {
        msg,
        wrapper: clone(wrapper),
        payload: clone(payload)
      };
    }
  }

  return null;
}

const messageId = String(selection?.messageId ?? "").trim();
if (!messageId) throw new Error("Missing selection.messageId");

const chatMsg = game.messages?.get(messageId) ?? null;
if (!chatMsg) throw new Error(\`Action card message not found: \${messageId}\`);

const alreadyApplied = await chatMsg.getFlag?.(MODULE_NS, APPLIED_FLAG);
if (alreadyApplied) {
  throw new Error("Cannot redirect an already-confirmed action card");
}

const wrapper = chatMsg.getFlag(MODULE_NS, CARD_FLAG);
if (!wrapper || typeof wrapper !== "object" || !wrapper.payload) {
  throw new Error("Action card wrapper payload is missing");
}

const actionPayload = clone(wrapper.payload);
actionPayload.meta = actionPayload.meta || {};

const identity = readWrapperIdentity(wrapper, actionPayload);
const stableActionId = identity.actionId || null;
const oldActionCardId = identity.actionCardId || null;
const oldActionCardVersion = Number(identity.actionCardVersion ?? 0) || 0;

const reactorTokenUuid = String(selection?.reactorTokenUuid ?? "").trim();
const reactorActorUuid = String(selection?.reactorActorUuid ?? "").trim();

const targetIndex = Number(selection?.targetIndex ?? NaN);
if (!Number.isInteger(targetIndex) || targetIndex < 0) {
  throw new Error(\`Invalid targetIndex: \${selection?.targetIndex}\`);
}

const targetList = readTargetList(actionPayload);
if (!targetList.length) {
  throw new Error("Target list is empty on original action payload");
}
if (targetIndex >= targetList.length) {
  throw new Error(\`Target index \${targetIndex} is out of range (len=\${targetList.length})\`);
}

const previousTargetUuid = String(targetList[targetIndex] ?? "").trim();
if (!previousTargetUuid) {
  throw new Error(\`Target slot \${targetIndex} is blank\`);
}

const replacementUuid = reactorTokenUuid || reactorActorUuid;
if (!replacementUuid) {
  throw new Error("No replacement reactor token/actor uuid was provided");
}

// --------------------------------------------------
// Apply redirect directly to the payload that will be rebuilt
// --------------------------------------------------
targetList[targetIndex] = replacementUuid;
actionPayload.originalTargetUUIDs = [...targetList];
actionPayload.targets = [...targetList];
actionPayload.meta.originalTargetUUIDs = [...targetList];

const actorTargets = readActorTargetList(actionPayload);
if (actorTargets.length && reactorActorUuid && targetIndex < actorTargets.length) {
  actorTargets[targetIndex] = reactorActorUuid;
  actionPayload.originalTargetActorUUIDs = [...actorTargets];
  actionPayload.meta.originalTargetActorUUIDs = [...actorTargets];
}

actionPayload.meta.redirectHistory = Array.isArray(actionPayload.meta.redirectHistory)
  ? actionPayload.meta.redirectHistory
  : [];

actionPayload.meta.redirectHistory.push({
  kind: String(opts?.kind ?? "reaction_target_redirect"),
  timestamp: Date.now(),
  previousTargetUuid,
  replacementTargetUuid: replacementUuid,
  replacementActorUuid: reactorActorUuid || null,
  redirectedByUserId: game.user?.id ?? null,
  redirectedByUserName: game.user?.name ?? null,
  reactorName: String(selection?.reactorName ?? "").trim() || null,
  protectedTargetName: String(selection?.originalTargetName ?? "").trim() || null,
  targetIndex
});

actionPayload.meta.lastRedirect = {
  kind: String(opts?.kind ?? "reaction_target_redirect"),
  timestamp: Date.now(),
  previousTargetUuid,
  replacementTargetUuid: replacementUuid,
  replacementActorUuid: reactorActorUuid || null,
  targetIndex
};

// Preserve action identity, but force a fresh card instance to be created.
if (stableActionId) {
  actionPayload.actionId = stableActionId;
  actionPayload.meta.actionId = stableActionId;
}

actionPayload.meta.rebuildHistory = Array.isArray(actionPayload.meta.rebuildHistory)
  ? actionPayload.meta.rebuildHistory
  : [];

actionPayload.meta.rebuildHistory.push({
  timestamp: Date.now(),
  reason: String(opts?.kind ?? "reaction_target_redirect"),
  previousMessageId: chatMsg.id,
  previousActionCardId: oldActionCardId,
  previousActionCardVersion: oldActionCardVersion,
  rebuiltByUserId: game.user?.id ?? null,
  rebuiltByUserName: game.user?.name ?? null
});

actionPayload.meta.rebuildReason = String(opts?.kind ?? "reaction_target_redirect");
actionPayload.meta.rebuildRequestedAt = Date.now();
actionPayload.meta.rebuildPreviousMessageId = chatMsg.id;

// Important: do not carry the old message id forward as current message id.
actionPayload.meta.actionCardMessageId = null;
delete actionPayload.actionCardMessageId;

// --------------------------------------------------
// Rebuild immediately from the mutated payload (atomic path)
// --------------------------------------------------
const beforeIds = new Set((game.messages?.contents ?? []).map(m => String(m.id)));

const createMacro = game.macros?.getName?.(CREATE_ACTION_CARD_MACRO_NAME) ?? null;
if (!createMacro) {
  throw new Error(\`Macro "\${CREATE_ACTION_CARD_MACRO_NAME}" not found\`);
}

await createMacro.execute({
  __AUTO: true,
  __PAYLOAD: actionPayload
});

let created = null;
for (let i = 0; i < 20; i++) {
  created = await findNewestMessageForActionId(stableActionId, chatMsg.id, beforeIds);
  if (created?.msg) break;
  await sleep(80);
}

if (!created?.msg) {
  throw new Error("Redirect rebuild finished, but new action card message could not be located");
}

// Remove the old card only after the new one exists
await chatMsg.delete();

const createdIdentity = readWrapperIdentity(created?.wrapper ?? {}, created?.payload ?? {});

return {
  ok: true,
  messageId: created.msg.id,
  oldMessageId: chatMsg.id,
  newMessageId: created.msg.id,
  previousTargetUuid,
  replacementTargetUuid: replacementUuid,
  replacementActorUuid: reactorActorUuid || null,
  targetIndex,
  actionId: createdIdentity.actionId ?? stableActionId ?? null,
  actionCardId: createdIdentity.actionCardId ?? null,
  actionCardVersion: Number(createdIdentity.actionCardVersion ?? NaN),
  deletedOld: true
};
  `.trim();
}

    async function applyRedirectSelection(selection = {}, opts = {}) {
  const gmExecutor =
    game.modules?.get(MODULE_NS)?.api?.GMExecutor ??
    globalThis.FUCompanion?.api?.GMExecutor ??
    null;

  const reactorUuidForValidation = firstNonBlank(
    selection?.reactorTokenUuid,
    selection?.reactorActorUuid,
    opts?.payload?.meta?.attackerUuid,
    opts?.payload?.attackerUuid,
    opts?.payload?.attackerActorUuid
  );

  const remoteScript = buildRemoteRedirectScript();

  let remoteResult = null;

  if (!game.user?.isGM && gmExecutor?.executeSnippet) {
    remoteResult = await gmExecutor.executeSnippet({
      mode: "generic",
      scriptText: remoteScript,
      payload: opts?.payload ?? {},
      actorUuid: reactorUuidForValidation || null,
      globals: {
        __REDIRECT_SELECTION: selection,
        __REDIRECT_OPTS: {
          kind: opts?.kind ?? "reaction_target_redirect"
        }
      }
    });
  } else if (game.user?.isGM) {
    const wrapped = `return (async () => {\n${remoteScript}\n})();`;
    const fn = new Function("payload", "args", "targets", "env", "globals", wrapped);
    remoteResult = {
      ok: true,
      resultValue: await fn(
        opts?.payload ?? {},
        null,
        [],
        null,
        {
          __REDIRECT_SELECTION: selection,
          __REDIRECT_OPTS: {
            kind: opts?.kind ?? "reaction_target_redirect"
          }
        }
      )
    };
  } else {
    ui.notifications.error("[Reaction] GMExecutor is not available on this client.");
    return { ok: false, reason: "gm_executor_missing" };
  }

  if (!remoteResult?.ok) {
    ui.notifications.error(`[Reaction] Redirect failed: ${remoteResult?.error ?? "Unknown error"}`);
    err("applyRedirectSelection failed", remoteResult);
    return {
      ok: false,
      reason: "redirect_failed",
      error: remoteResult?.error ?? null,
      stack: remoteResult?.stack ?? null
    };
  }

  const resultValue = remoteResult?.resultValue ?? {};

  ui.notifications.info("[Reaction] Pending action redirected.");
  log("Redirect applied.", {
    selection,
    resultValue
  });

  // --------------------------------------------------
  // Protect feedback
  // - show passive-style card: "💥 Protect"
  // - play protect animation
  // This is presentation only; redirect/rebuild already succeeded.
  // --------------------------------------------------
  try {
    const protectFeedbackApi = window["oni.ReactionProtectFeedback"];

    if (protectFeedbackApi?.playFromRedirect) {
      const feedbackResult = await protectFeedbackApi.playFromRedirect(
        opts?.payload ?? {},
        resultValue,
        {
          cardTitle: "💥 Protect",
          broadcastCard: true,
          playAnimation: true
        }
      );

      log("Protect feedback played.", {
        selection,
        resultValue,
        feedbackResult
      });
    } else {
      warn("Protect feedback helper not available; skipping Protect feedback.", {
        hasApi: !!protectFeedbackApi
      });
    }
  } catch (feedbackError) {
    err("Protect feedback failed, but redirect already succeeded.", {
      selection,
      resultValue,
      error: String(feedbackError?.message ?? feedbackError),
      stack: feedbackError?.stack ?? null
    });
  }

  return {
    ok: true,
    ...resultValue
  };
}

    async function redirectFromPayload(payload = {}, opts = {}) {
      const sourceRef = opts?.sourceRef ?? extractSourceActionRef(payload);
      const protectedTargetUUIDs = uniq(
        opts?.protectedTargetUUIDs?.length
          ? opts.protectedTargetUUIDs
          : findProtectedTargetUUIDs(payload)
      );

      const reactorInfo = await resolveReactorInfo(payload, opts);
      if (!reactorInfo?.tokenUuid && !reactorInfo?.actorUuid) {
        ui.notifications.warn("[Reaction] Could not resolve the redirecting creature.");
        return { ok: false, cancelled: true, reason: "reactor_not_found" };
      }

      const dialogResult = await openRedirectDialog({
        payload,
        sourceRef,
        protectedTargetUUIDs,
        reactorUuid: opts?.reactorUuid ?? reactorInfo?.tokenUuid ?? reactorInfo?.actorUuid
      });

      if (!dialogResult?.ok) return dialogResult;

      const picked = dialogResult.picked;
      const selection = {
        messageId: picked?.candidate?.messageId,
        targetIndex: picked?.targetIndex,
        originalTargetName: picked?.originalTargetName ?? null,
        reactorName: reactorInfo?.name ?? null,
        reactorTokenUuid: reactorInfo?.tokenUuid ?? null,
        reactorActorUuid: reactorInfo?.actorUuid ?? null
      };

      return await applyRedirectSelection(selection, {
        payload,
        rebuildCard: opts?.rebuildCard !== false,
        kind: opts?.kind ?? "reaction_target_redirect"
      });
    }

    window[KEY] = {
      findPendingActionCandidates,
      openRedirectDialog,
      redirectFromPayload,
      applyRedirectSelection
    };

    log("Installed.", {
      key: KEY
    });
  })();
});