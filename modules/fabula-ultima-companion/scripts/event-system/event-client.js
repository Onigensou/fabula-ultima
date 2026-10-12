/**
 * [ONI] Event System — Client channel
 * Foundry VTT v12
 *
 * File:
 * scripts/event-system/event-client.js
 *
 * What this does:
 * - An event's rows run on one GM client, but a camera pan, a sound or a
 *   screen fade has to happen on every screen. This is the one channel for
 *   that: Client.run(sourceId, kind, data) plays `kind` on every client on
 *   the same scene, the sender included.
 * - Whatever an effect leaves behind (a faded screen, a camera held away
 *   from the party) registers an undo here. Every undo runs on every client
 *   when the event ends, however it ends, and when the scene changes.
 * - Decides who an effect is SHOWN to. An event never takes the GM's screen
 *   away: the GM keeps the camera and sees no fades, so they can go on
 *   setting things up while the players watch. A GM who wants to see what
 *   the players see turns on "Events: view as a player" (per client).
 * - Keeps the short notes the GM status chip shows in place of the effects
 *   ("screen faded", "camera away").
 *
 * Exposes API to:
 *   window.oni.EventSystem.Client
 *
 * Requires:
 * - event-constants.js
 */

(() => {
  const INSTALL_TAG = "[ONI][EventSystem][Client]";

  window.oni = window.oni || {};
  window.oni.EventSystem = window.oni.EventSystem || {};

  if (window.oni.EventSystem.Client?.installed) {
    console.debug(INSTALL_TAG, "Already installed; skipping.");
    return;
  }

  const C = window.oni.EventSystem.Constants;
  if (!C) {
    console.error(INSTALL_TAG, "Missing Constants. Load event-constants.js first.");
    return;
  }

  const MODULE_ID = C.MODULE_ID || "fabula-ultima-companion";
  const SOCKET_CHANNEL = `module.${MODULE_ID}`;
  const MSG_CLIENT = "ONI_EVENT_CLIENT_V1";
  const SETTING_VIEW_AS_PLAYER = "eventViewAsPlayer";

  const handlers = new Map();   // kind -> fn(data, info)
  const cleanups = new Map();   // sourceId -> Map(key -> fn)
  const markers = new Map();    // sourceId -> Map(key -> text)

  // ------------------------------------------------------------
  // Who an effect is shown to
  // ------------------------------------------------------------
  function viewAsPlayer() {
    try {
      return game.settings.get(MODULE_ID, SETTING_VIEW_AS_PLAYER) === true;
    } catch (_) {
      return false;
    }
  }

  // True where camera moves and screen effects should actually be shown.
  function presents() {
    if (!game.user?.isGM) return true;
    return viewAsPlayer();
  }

  // ------------------------------------------------------------
  // Running an effect everywhere
  // ------------------------------------------------------------
  function register(kind, handler) {
    if (typeof handler === "function") handlers.set(String(kind), handler);
  }

  function handle(payload) {
    const kind = String(payload?.kind || "");
    const sourceId = String(payload?.sourceId || "");
    const handler = handlers.get(kind);
    if (!handler) return;

    if (!canvas?.scene || payload.sceneId !== canvas.scene.id) return;

    try {
      handler(payload.data ?? {}, { sourceId, sceneId: payload.sceneId, presents: presents() });
    } catch (e) {
      console.warn(INSTALL_TAG, `Client effect "${kind}" threw.`, e);
    }
  }

  // Sockets do not echo to their sender, so the sender plays it directly.
  function run(sourceId, kind, data = {}) {
    const payload = {
      sceneId: canvas?.scene?.id ?? null,
      sourceId: String(sourceId || ""),
      kind: String(kind || ""),
      data
    };

    try {
      game.socket.emit(SOCKET_CHANNEL, { type: MSG_CLIENT, payload });
    } catch (e) {
      console.warn(INSTALL_TAG, "Failed to broadcast a client effect.", e);
    }

    handle(payload);
  }

  // ------------------------------------------------------------
  // Undo on event end
  // ------------------------------------------------------------
  // One undo per key: registering the same key again replaces it.
  function addCleanup(sourceId, key, fn) {
    const id = String(sourceId || "");
    if (!id || typeof fn !== "function") return;
    if (!cleanups.has(id)) cleanups.set(id, new Map());
    cleanups.get(id).set(String(key), fn);
  }

  function removeCleanup(sourceId, key) {
    cleanups.get(String(sourceId || ""))?.delete(String(key));
  }

  // sceneGone: the canvas is being torn down, so an undo should drop its
  // state at once and not start a glide or a fade.
  function runCleanups(sourceId, { sceneGone = false } = {}) {
    const id = String(sourceId || "");
    const mine = cleanups.get(id);
    cleanups.delete(id);

    for (const fn of mine?.values?.() ?? []) {
      try { fn({ sceneGone }); } catch (e) { console.warn(INSTALL_TAG, "An event cleanup threw.", e); }
    }

    if (markers.delete(id)) announceMarkers(id);
  }

  function runAllCleanups(options) {
    for (const id of [...new Set([...cleanups.keys(), ...markers.keys()])]) runCleanups(id, options);
  }

  // ------------------------------------------------------------
  // Notes for the GM status chip
  // ------------------------------------------------------------
  function setMarker(sourceId, key, text) {
    const id = String(sourceId || "");
    if (!id) return;

    if (text) {
      if (!markers.has(id)) markers.set(id, new Map());
      markers.get(id).set(String(key), String(text));
    } else {
      markers.get(id)?.delete(String(key));
    }

    announceMarkers(id);
  }

  function getMarkers(sourceId) {
    return [...(markers.get(String(sourceId || ""))?.values?.() ?? [])];
  }

  function announceMarkers(sourceId) {
    try { Hooks.callAll("oniEventMarkers", { sourceId, markers: getMarkers(sourceId) }); } catch (_) {}
  }

  window.oni.EventSystem.Client = {
    installed: true,
    MSG_CLIENT,
    SETTING_VIEW_AS_PLAYER,

    presents,
    viewAsPlayer,

    register,
    run,

    addCleanup,
    removeCleanup,
    runCleanups,

    setMarker,
    getMarkers
  };

  Hooks.once("init", () => {
    try {
      game.settings.register(MODULE_ID, SETTING_VIEW_AS_PLAYER, {
        name: "Events: view as a player (GM)",
        hint: "Off: an event never moves the GM's camera or covers the GM's screen, so you can keep working while the players watch. On: this GM client is shown camera pans and screen effects like a player, for authoring and testing. No effect on player clients.",
        scope: "client",
        config: true,
        type: Boolean,
        default: false
      });
    } catch (e) {
      console.error(INSTALL_TAG, "Failed to register the view-as-player setting.", e);
    }
  });

  Hooks.on("oniEventExecuteDone", ({ sourceId } = {}) => runCleanups(sourceId));
  Hooks.on("canvasTearDown", () => runAllCleanups({ sceneGone: true }));

  Hooks.once("ready", () => {
    try {
      game.socket.on(SOCKET_CHANNEL, (msg) => {
        if (msg?.type === MSG_CLIENT) handle(msg.payload);
      });
    } catch (e) {
      console.error(INSTALL_TAG, "Failed to install the socket listener.", e);
    }
  });

  console.debug(INSTALL_TAG, "Installed. API: window.oni.EventSystem.Client");
})();
