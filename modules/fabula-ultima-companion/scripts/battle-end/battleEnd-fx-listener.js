// ============================================================================
// [BattleEnd: FX Listener] • Foundry VTT v12
// ----------------------------------------------------------------------------
// Run this ONCE per client per session (include in your Dev Bootstrap).
// It listens for a socket broadcast from [BattleEnd: FX] and runs the cinematic
// camera FX locally (pan/zoom + temporary camera lock).
// ============================================================================

Hooks.once("ready", () => {
  const DEBUG = false;
  const tag = "[BattleEnd:FX:Listener]";
  const log = (...args) => DEBUG && console.log(tag, ...args);

  // Socket channel name (must match the sender macro)
  const MODULE_ID = "fabula-ultima-companion";
  const SOCKET_CHANNEL = `module.${MODULE_ID}`;

  // Idempotent install guard
  if (window.__ONI_BATTLEEND_FX_LISTENER_INSTALLED__ === true) {
    ui.notifications?.info?.("BattleEnd FX Listener: already installed on this client.");
    log("Already installed.");
    return;
  }
  window.__ONI_BATTLEEND_FX_LISTENER_INSTALLED__ = true;

  // --------------------------------------------------------------------------
  // Camera Lock overlay (blocks mouse / wheel / key zoom)
  // --------------------------------------------------------------------------
  function installCameraLockOverlay(lockId) {
    const id = `oni-battleend-camlock-${lockId}`;
    if (document.getElementById(id)) return id;

    const el = document.createElement("div");
    el.id = id;
    el.style.position = "fixed";
    el.style.left = "0";
    el.style.top = "0";
    el.style.width = "100vw";
    el.style.height = "100vh";
    el.style.zIndex = "100000";
    el.style.background = "transparent";
    el.style.pointerEvents = "auto"; // IMPORTANT: capture events

    // Eat pointer + wheel events
    const stop = (ev) => {
      try { ev.preventDefault(); } catch (e) {}
      try { ev.stopPropagation(); } catch (e) {}
      try { ev.stopImmediatePropagation(); } catch (e) {}
      return false;
    };

    el.addEventListener("mousedown", stop, true);
    el.addEventListener("mouseup", stop, true);
    el.addEventListener("mousemove", stop, true);
    el.addEventListener("click", stop, true);
    el.addEventListener("dblclick", stop, true);
    el.addEventListener("contextmenu", stop, true);
    el.addEventListener("wheel", stop, { capture: true, passive: false });
    el.addEventListener("touchstart", stop, { capture: true, passive: false });
    el.addEventListener("touchmove", stop, { capture: true, passive: false });
    el.addEventListener("touchend", stop, { capture: true, passive: false });

    // Also block keyboard zoom keys while locked
    const keyStop = (ev) => {
      const k = String(ev.key ?? "").toLowerCase();
      // block + / - / = / _ and arrow keys (commonly used for navigation by some setups)
      if (k === "+" || k === "-" || k === "=" || k === "_" || k === "arrowup" || k === "arrowdown" || k === "arrowleft" || k === "arrowright") {
        return stop(ev);
      }
      return undefined;
    };

    window.addEventListener("keydown", keyStop, true);
    el.dataset.keyStopInstalled = "true";

    // store remover
    el.__oniRemove = () => {
      try { window.removeEventListener("keydown", keyStop, true); } catch (e) {}
      try { el.remove(); } catch (e) {}
    };

    document.body.appendChild(el);
    return id;
  }

  function removeCameraLockOverlay(lockId) {
    const id = `oni-battleend-camlock-${lockId}`;
    const el = document.getElementById(id);
    if (!el) return;
    try {
      if (typeof el.__oniRemove === "function") el.__oniRemove();
      else el.remove();
    } catch (e) {}
  }

    async function waitForPanOrTimeout({ x, y, scale, duration }, label = "cameraFx") {
    const timeoutMs = Math.max(1000, Number(duration || 0) + 1500);

    return await Promise.race([
      canvas.animatePan({ x, y, scale, duration })
        .then(() => ({ ok: true, timedOut: false })),
      new Promise(resolve => setTimeout(() => resolve({ ok: false, timedOut: true }), timeoutMs))
    ]);
  }

  // --------------------------------------------------------------------------
  // Run the cinematic camera FX
  // --------------------------------------------------------------------------
    async function runCameraFx(payload) {
    const lockId = String(payload?.lockId ?? "default");
    const durationMs = Number(payload?.durationMs ?? 3000);
    const target = payload?.target ?? null;

    if (!canvas?.scene) {
      log("No canvas.scene, cannot run camera FX.");
      return;
    }

    installCameraLockOverlay(lockId);

    try {
      await new Promise(r => setTimeout(r, 0));

      if (!target || typeof target.x !== "number" || typeof target.y !== "number" || typeof target.scale !== "number") {
        log("Invalid target for camera FX:", target);
        return;
      }

      const panRes = await waitForPanOrTimeout({
        x: target.x,
        y: target.y,
        scale: target.scale,
        duration: durationMs
      }, "BattleEnd FX listener");

      if (panRes?.timedOut) {
        console.warn(`${tag} camera pan timed out; removing lock overlay and continuing.`);
      }

      const holdMs = Number(payload?.holdMs ?? 500);
      await new Promise(r => setTimeout(r, Math.max(0, holdMs)));
    } catch (err) {
      console.error(`${tag} Camera FX error:`, err);
    } finally {
      removeCameraLockOverlay(lockId);
    }
  }

  // --------------------------------------------------------------------------
  // Socket listener
  // --------------------------------------------------------------------------
  game.socket.on(SOCKET_CHANNEL, async (msg) => {
    try {
      if (!msg || msg.type !== "ONI_BATTLEEND_FX_CAMERA") return;

      log("Received FX message ✅", msg);

      // Optional: Only run if this message is for our current scene id (safety)
      const intendedSceneId = String(msg?.sceneId ?? "");
      if (intendedSceneId && canvas?.scene?.id && intendedSceneId !== canvas.scene.id) {
        log("FX message is for different scene. Ignored.", { intendedSceneId, current: canvas.scene.id });
        return;
      }

      await runCameraFx(msg.payload);
    } catch (err) {
      console.error(`${tag} Socket handler error:`, err);
    }
  });

  ui.notifications?.info?.("BattleEnd FX Listener installed on this client ✅");
  log("Installed. Listening on:", SOCKET_CHANNEL);
});

