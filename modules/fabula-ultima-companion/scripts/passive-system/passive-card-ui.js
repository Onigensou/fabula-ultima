// scripts/passive-card-ui.js
// Foundry VTT v12
// Multi-client Passive Card visual feedback using ONI Pseudo Animation.
//
// PURPOSE
// - Show a subtle passive popup anchored to the performer token.
// - Broadcast to all clients via game.ONI.pseudo.play(payload).
// - Keep visuals decoupled from passive logic / action execution.
//
// Public API:
//   await window.FUCompanion.api.passiveCard.broadcast({
//     title: "Absorb MP",
//     attackerUuid: "Scene...Token..." | "Actor...",
//     icon: "📜",
//     actionContext: <optional action payload>,
//     options: { holdMs: 1600, yOffset: 8 }
//   });
//
// Notes:
// - Uses Pseudo Animation API only as a multi-client broadcast/execution transport.
// - Does NOT move the real token.
// - Each client creates its own lightweight DOM overlay anchored to the token.

(() => {
  const API_ROOT = (globalThis.FUCompanion = globalThis.FUCompanion || {});
  API_ROOT.api = API_ROOT.api || {};

  const TAG = "[ONI][PassiveCardUI]";
  const DEBUG = true; // set false when stable

  const log = (...a) => DEBUG && console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);
  const err = (...a) => console.error(TAG, ...a);

  const STYLE_ID = "oni-passive-card-style-v1";
  const ROOT_ID = "oni-passive-card-root";

  function str(v, d = "") {
    const s = (v ?? "").toString().trim();
    return s.length ? s : d;
  }

  function num(v, d = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  }

  async function resolveTokenUuid(inputUuid, actionContext = null) {
    const candidates = [
      inputUuid,
      actionContext?.meta?.attackerUuid,
      actionContext?.attackerUuid,
      actionContext?.attacker_uuid,
      actionContext?.meta?.attackerTokenUuid,
      actionContext?.meta?.sourceTokenUuid,
      actionContext?.meta?.performerTokenUuid,
      actionContext?.meta?.attackerActorUuid,
      actionContext?.attackerActorUuid
    ].filter(Boolean).map(String);

    for (const uuid of candidates) {
      try {
        const doc = await fromUuid(uuid);
        if (!doc) continue;

        // TokenDocument / Token-like
        if (doc.documentName === "Token" || doc.documentName === "TokenDocument") {
          return doc?.uuid ?? doc?.document?.uuid ?? null;
        }

        // Actor -> first active token on current scene
        if (doc.documentName === "Actor" || doc.type === "Actor" || doc.constructor?.name === "Actor") {
          const token = doc?.getActiveTokens?.()?.[0] ?? doc?.token?.object ?? null;
          const tokenUuid = token?.document?.uuid ?? token?.uuid ?? null;
          if (tokenUuid) return tokenUuid;
        }

        // Generic best-effort
        const tokenObj = doc?.object ?? doc?.token?.object ?? null;
        const tokenUuid = tokenObj?.document?.uuid ?? tokenObj?.uuid ?? null;
        if (tokenUuid) return tokenUuid;
      } catch (e) {
        warn("resolveTokenUuid candidate failed", { uuid, error: e });
      }
    }

    return null;
  }

  function buildScriptSource() {
    // Executed by the Pseudo Animation listener on each client.
    return String.raw`
const token = ctx.casterToken;
const params = ctx.params ?? {};
if (!token) throw new Error("PassiveCardUI: casterToken could not be resolved on this client.");

const STYLE_ID = ${JSON.stringify(STYLE_ID)};
const ROOT_ID = ${JSON.stringify(ROOT_ID)};
const activeKey = "__ONI_PASSIVE_CARD_ACTIVE__";
globalThis[activeKey] ??= new Map();
const activeMap = globalThis[activeKey];

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;

  const css = [
    "#" + ROOT_ID + " {",
    "  position: fixed;",
    "  left: 0;",
    "  top: 0;",
    "  pointer-events: none;",
    "  z-index: 100000;",
    "}",
    ".oni-passive-card {",
    "  position: absolute;",
    "  left: 0;",
    "  top: 0;",
    "  transform: translate(-50%, 0);",
    "  pointer-events: none;",
    "  padding: 7px 12px;",
    "  border: 2px solid rgba(255, 220, 140, 0.9);",
    "  border-radius: 12px;",
    "  background: linear-gradient(180deg, rgba(44, 35, 27, 0.95), rgba(24, 19, 15, 0.95));",
    "  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.35), 0 0 12px rgba(255, 210, 120, 0.18);",
    "  color: #fff2cf;",
    "  font-family: 'Signika', 'Palatino Linotype', serif;",
    "  opacity: 0;",
    "  will-change: transform, opacity;",
    "  white-space: nowrap;",
    "}",
    ".oni-passive-card .oni-passive-row {",
    "  display: flex;",
    "  align-items: center;",
    "  justify-content: center;",
    "  gap: 6px;",
    "  font-size: 13px;",
    "  font-weight: 400;",
    "  line-height: 1;",
    "  letter-spacing: 0.01em;",
    "  text-shadow: 0 1px 0 rgba(0, 0, 0, 0.45);",
    "}",
    ".oni-passive-card .oni-passive-icon {",
    "  font-size: 13px;",
    "  line-height: 1;",
    "}",
    ".oni-passive-card.enter {",
    "  animation: oniPassiveCardIn var(--oni-passive-in-ms, 280ms) cubic-bezier(0.22, 1, 0.36, 1) forwards;",
    "}",
    ".oni-passive-card.exit {",
    "  animation: oniPassiveCardOut var(--oni-passive-out-ms, 260ms) cubic-bezier(0.4, 0, 1, 1) forwards;",
    "}",
    "@keyframes oniPassiveCardIn {",
    "  0%   { opacity: 0; transform: translate(-62%, 0); }",
    "  100% { opacity: 1; transform: translate(-50%, 0); }",
    "}",
    "@keyframes oniPassiveCardOut {",
    "  0%   { opacity: 1; transform: translate(-50%, 0); }",
    "  100% { opacity: 0; transform: translate(-62%, 0); }",
    "}"
  ].join("\n");

  style.textContent = css;
  document.head.appendChild(style);
}

function ensureRoot() {
  let root = document.getElementById(ROOT_ID);
  if (root) return root;
  root = document.createElement("div");
  root.id = ROOT_ID;
  document.body.appendChild(root);
  return root;
}

function cleanupExistingForToken(tokenUuid) {
  const existing = activeMap.get(tokenUuid);
  if (!existing) return;
  try {
    if (existing.tickerFn && canvas?.app?.ticker) canvas.app.ticker.remove(existing.tickerFn);
  } catch (_) {}
  try { existing.card?.remove?.(); } catch (_) {}
  activeMap.delete(tokenUuid);
}

ensureStyles();
const root = ensureRoot();
const tokenUuid = token?.document?.uuid ?? token?.uuid ?? String(ctx.runId ?? foundry.utils.randomID());
cleanupExistingForToken(tokenUuid);

const card = document.createElement("div");
card.className = "oni-passive-card enter";
card.style.setProperty("--oni-passive-in-ms", String(params.enterMs ?? 280) + "ms");
card.style.setProperty("--oni-passive-out-ms", String(params.exitMs ?? 260) + "ms");

const row = document.createElement("div");
row.className = "oni-passive-row";

const iconEl = document.createElement("span");
iconEl.className = "oni-passive-icon";
iconEl.textContent = String(params.icon ?? "📜");

const nameEl = document.createElement("span");
nameEl.className = "oni-passive-name";
nameEl.textContent = String(params.title ?? "Passive");

row.appendChild(iconEl);
row.appendChild(nameEl);
card.appendChild(row);
root.appendChild(card);

const yOffset = Number(params.yOffset ?? 8) || 8;
const extraX = Number(params.xOffset ?? 0) || 0;
const holdMs = Number(params.holdMs ?? 1600) || 1600;
const totalExitBuffer = Math.max(40, Number(params.exitBufferMs ?? 40) || 40);

const updatePosition = () => {
  if (!card.isConnected) return;
  if (!token || token.destroyed) return;
  if (!canvas?.app?.view) return;

  const rect = canvas.app.view.getBoundingClientRect();
  const globalPos = token.toGlobal(new PIXI.Point(token.w / 2, token.h));
  const x = rect.left + globalPos.x + extraX;
  const y = rect.top + globalPos.y + yOffset;

  card.style.left = x + "px";
  card.style.top = y + "px";
};

canvas.app.ticker.add(updatePosition);
updatePosition();
activeMap.set(tokenUuid, { card, tickerFn: updatePosition, createdAt: Date.now(), runId: ctx.runId });

try {
  await wait(holdMs);
  card.classList.remove("enter");
  card.classList.add("exit");
  await wait(Number(params.exitMs ?? 260) + totalExitBuffer);
} finally {
  try { canvas.app.ticker.remove(updatePosition); } catch (_) {}
  try { card.remove(); } catch (_) {}
  const current = activeMap.get(tokenUuid);
  if (current?.runId === ctx.runId) activeMap.delete(tokenUuid);
}
`;
  }

  async function broadcast({
    title,
    attackerUuid = null,
    icon = "📜",
    actionContext = null,
    options = {}
  } = {}) {
    const pseudo = game.ONI?.pseudo;
    if (!pseudo?.play) {
      warn("Pseudo Animation API not available; passive card skipped.");
      return { ok: false, reason: "pseudo_api_missing" };
    }

    const resolvedTokenUuid = await resolveTokenUuid(attackerUuid, actionContext);
    if (!resolvedTokenUuid) {
      warn("Could not resolve performer token for passive card.", {
        attackerUuid,
        metaAttackerUuid: actionContext?.meta?.attackerUuid ?? null,
        attackerActorUuid: actionContext?.attackerActorUuid ?? actionContext?.meta?.attackerActorUuid ?? null
      });
      return { ok: false, reason: "performer_token_not_found" };
    }

    const finalTitle = str(title,
      str(actionContext?.core?.skillName,
        str(actionContext?.meta?.skillName, "Passive")
      )
    );

    const payload = {
      scriptId: "oni.passiveCard.show",
      scriptSource: buildScriptSource(),
      casterTokenUuid: resolvedTokenUuid,
      targetTokenUuids: [],
      params: {
        title: finalTitle,
        icon: str(icon, "📜"),
        xOffset: num(options.xOffset, 0),
        yOffset: num(options.yOffset, 8),
        holdMs: num(options.holdMs, 1600),
        enterMs: num(options.enterMs, 280),
        exitMs: num(options.exitMs, 260),
        exitBufferMs: num(options.exitBufferMs, 40)
      },
      meta: {
        source: "PassiveCardUI",
        executionMode: options.executionMode ?? actionContext?.meta?.executionMode ?? null,
        attackerUuid: attackerUuid ?? null,
        skillUuid: actionContext?.skillUuid ?? actionContext?.core?.skillUuid ?? null,
        title: finalTitle
      }
    };

    const runId = pseudo.play(payload);
    log("broadcast", {
      runId,
      title: finalTitle,
      attackerUuid,
      resolvedTokenUuid,
      options: payload.params
    });

    return {
      ok: !!runId,
      runId: runId ?? null,
      title: finalTitle,
      casterTokenUuid: resolvedTokenUuid
    };
  }

  API_ROOT.api.passiveCard = {
    broadcast
  };

  // Back-compat alias for the action execution core fallback lookup.
  API_ROOT.api.passiveCardBroadcast = broadcast;

  log("API registered", {
    path: "window.FUCompanion.api.passiveCard.broadcast"
  });
})();
