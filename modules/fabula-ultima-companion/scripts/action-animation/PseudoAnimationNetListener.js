(() => {
  const TAG = "[ONI][PseudoAnimNet]";
  const MODULE_ID = "fabula-ultima-companion";
  const CHANNEL = `module.${MODULE_ID}`;
  const DBG = true;

  const dlog  = (...a) => DBG && console.log(TAG, ...a);
  const dwarn = (...a) => DBG && console.warn(TAG, ...a);
  const derr  = (...a) => console.error(TAG, ...a);

  if (globalThis.ONI_PSEUDO_ANIM_NET_INSTALLED) {
    dlog("Already installed.");
    return;
  }
  globalThis.ONI_PSEUDO_ANIM_NET_INSTALLED = true;

  const SEEN = (globalThis.ONI_PSEUDO_ANIM_SEEN ||= new Set());

  async function resolveTokenPlaceable(uuid) {
    try {
      if (!uuid) return null;
      const doc = typeof uuid === "string" ? await fromUuid(uuid) : uuid;
      if (!doc) return null;
      if (doc?.object) return doc.object;                 // TokenDocument -> Token
      if (doc?.document?.object) return doc.document.object;
      return null;
    } catch (e) {
      dwarn("resolveTokenPlaceable failed", { uuid, e });
      return null;
    }
  }

  async function resolveTargets(uuids) {
    const arr = Array.isArray(uuids) ? uuids : [];
    const out = [];
    for (const u of arr) {
      const tok = await resolveTokenPlaceable(u);
      if (tok) out.push(tok);
    }
    return out;
  }

  async function waitUntil(ts) {
    const delay = Math.max(0, Number(ts ?? 0) - Date.now());
    if (delay > 0) await new Promise(r => setTimeout(r, delay));
  }

  async function runPseudoFromPacket(p) {
    const runId = p?.runId;
    if (!runId) return;

    if (SEEN.has(runId)) {
      dlog("Dedupe: already seen runId", runId);
      return;
    }
    SEEN.add(runId);

    dlog("RECEIVED packet payload", {
      runId,
      senderUserId: p?.senderUserId,
      sceneId: p?.sceneId,
      localSceneId: canvas?.scene?.id,
      attackerUuid: p?.attackerUuid,
      targetUuids: p?.targetUuids
    });

    // IMPORTANT: Do NOT ignore based on isGM. Players must run too.
    // If you want the sending client to skip, compare senderUserId
    if (p?.senderUserId && p.senderUserId === game.user?.id) {
      dlog("Skip: sender is this client");
      return;
    }

    if (p?.sceneId && canvas?.scene?.id && canvas.scene.id !== p.sceneId) {
      dlog("Skip: scene mismatch", { packet: p.sceneId, local: canvas.scene.id });
      return;
    }

    await waitUntil(p?.scheduledAt);

    const actionPayload = p?.actionPayload ?? {};
    const script = String(p?.script ?? "").trim();
    if (!script) {
      dwarn("No script in packet");
      return;
    }

    let targets = [];
    try {
      targets = await resolveTargets(p?.targetUuids);
      dlog("Resolved targets placeables", targets.map(t => t?.name ?? t?.id));
    } catch (e) {
      derr("Failed resolving targets", e);
    }

    let fn;
    try {
      fn = new Function("payload", "targets", `"use strict";\n${script}`);
      dlog("Compiled embedded script OK (client)");
    } catch (e) {
      derr("Failed compiling embedded script (client)", e);
      return;
    }

    try { Hooks?.callAll?.("oni:animationStart", { payload: actionPayload, targets, runId }); } catch (_) {}

    try {
      dlog("Running embedded script NOW (client)");
      await Promise.resolve(fn(actionPayload, targets));
      dlog("Embedded script finished (client)");
    } catch (e) {
      derr("Embedded script runtime error (client)", e);
    } finally {
      try { Hooks?.callAll?.("oni:animationEnd", { payload: actionPayload, targets, runId }); } catch (_) {}
    }
  }

  function installSocket() {
    if (!game?.socket) {
      dwarn("game.socket not available; cannot install listener");
      return;
    }

    dlog("Installing socket listener on", CHANNEL);

    game.socket.on(CHANNEL, (data) => {
      try {
        if (!data) return;
        if (DBG) dlog("Socket IN raw", data);

        if (data.type === "ONI_PSEUDO_ANIM_PLAY") {
          runPseudoFromPacket(data.payload);
        }
      } catch (e) {
        derr("Socket handler error", e);
      }
    });
  }

  // Install even if this file loads after ready
  if (game?.ready) installSocket();
  else Hooks.once("ready", installSocket);
})();
