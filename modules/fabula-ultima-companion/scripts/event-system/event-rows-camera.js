/**
 * [ONI] Event System — Camera Pan
 * Foundry VTT v12
 *
 * File:
 * scripts/event-system/event-rows-camera.js
 *
 * What this does:
 * - Registers the "Camera Pan" event action: glide every player's camera to
 *   a point (and zoom), hold it there, and bring it back to the party when
 *   the event ends or a later Camera Pan says "Back to the party".
 *
 * How it fits together:
 * - On an exploration map the follow camera re-centres on the party every
 *   frame, so a pan would be undone the frame after. This takes the camera
 *   from the follow (holdCamera), glides it, and hands it back.
 * - Each client works out its own target: the chat sidebar covers part of
 *   the window, by a different amount on each screen, and the same shift the
 *   follow uses keeps the target in the part the player can see.
 * - The player camera clamp still applies, so a pan past the edge of the map
 *   stops at the edge.
 * - The GM's camera is not moved (see event-client.js). The GM status chip
 *   shows "camera away" instead.
 *
 * Requires:
 * - event-logic.js, event-eventRegistry.js, event-client.js, event-flow.js
 * - scripts/map-system/movementControl-cameraRuntime.js
 * - scripts/battle-director/director-camera.js (FUCompanion.api.camera)
 */

(() => {
  const INSTALL_TAG = "[ONI][EventSystem][RowsCamera]";

  window.oni = window.oni || {};
  window.oni.EventSystem = window.oni.EventSystem || {};

  if (window.oni.EventSystem.RowsCamera?.installed) {
    console.debug(INSTALL_TAG, "Already installed; skipping.");
    return;
  }

  const Logic = window.oni.EventSystem.Logic;
  const EventRegistry = window.oni.EventSystem.EventRegistry;
  const Client = window.oni.EventSystem.Client;
  if (!Logic || !EventRegistry || !Client) {
    console.error(INSTALL_TAG, "Missing Logic, EventRegistry or Client. Check load order.");
    return;
  }

  const KIND_PAN = "camera.pan";
  const HOLD_ID = "event-camera";

  const DEFAULT_SECONDS = 1.2;
  const MAX_SECONDS = 20;
  // The glide back to the party when an event ends with the camera away.
  const RETURN_MS = 900;

  const TARGETS = [
    ["offset", "Offset from the current view"],
    ["source", "This event's tile / token"],
    ["token", "A named token"],
    ["party", "Back to the party"]
  ];

  const MOTIONS = [
    ["smooth", "Smooth (eases in and out)"],
    ["pullBack", "Pull-back (like a camera moving back)"]
  ];

  const flow = () => window.oni.EventSystem.Flow;
  const followRuntime = () => globalThis.__ONI_MOVEMENT_CONTROL_CAMERA_RUNTIME__ ?? null;

  // This client's camera while an event has it. One camera, so one of these.
  //   { home, target, ticker }
  let view = null;

  // ------------------------------------------------------------
  // Where things are
  // ------------------------------------------------------------
  function currentView() {
    return {
      x: canvas.stage.pivot.x,
      y: canvas.stage.pivot.y,
      scale: canvas.stage.scale.x
    };
  }

  // Half the chat sidebar, in world units: added to a point so that it lands
  // in the middle of what the player can see, not of the whole window.
  function visibleShift(scale) {
    try {
      const cam = globalThis.FUCompanion?.api?.camera;
      if (!cam?.viewportOf || !cam?.pivotShift) return { x: 0, y: 0 };
      return cam.pivotShift(cam.viewportOf().insets ?? null, scale || 1);
    } catch (_) {
      return { x: 0, y: 0 };
    }
  }

  function centerOfDocument(doc) {
    if (!doc) return null;
    // A token's width/height are in grid units, a tile's are in pixels.
    const unit = doc.documentName === "Token" ? (Number(doc.parent?.grid?.size ?? canvas?.grid?.size) || 100) : 1;
    return {
      x: Number(doc.x ?? 0) + ((Number(doc.width ?? 0) * unit) / 2),
      y: Number(doc.y ?? 0) + ((Number(doc.height ?? 0) * unit) / 2)
    };
  }

  function findTokenByName(name) {
    const wanted = String(name ?? "").trim().toLowerCase();
    if (!wanted) return null;
    return (canvas.tokens?.placeables ?? []).find(t =>
      String(t.name ?? "").trim().toLowerCase() === wanted
      || String(t.actor?.name ?? "").trim().toLowerCase() === wanted
    ) ?? null;
  }

  // The party view to go back to: live from the follow where there is one.
  function homeView() {
    return followRuntime()?.getFollowTarget?.() ?? view?.home ?? currentView();
  }

  function resolveTarget(data, sourceId) {
    // An offset is measured from where the camera is MEANT to be, not from
    // where it happens to be this frame: the party view for a first pan, the
    // last pan's target after that. A client whose camera is still catching
    // up (it just joined, its window was covered) would otherwise end up
    // somewhere else than everyone else (seen live, 2026-10-13).
    const from = view?.target ?? homeView();
    const scale = Logic.toNumber(data.zoom, 0) > 0 ? Logic.toNumber(data.zoom, from.scale) : from.scale;

    if (data.mode === "party") return homeView();

    if (data.mode === "offset") {
      return {
        x: from.x + Logic.toNumber(data.dx, 0),
        y: from.y + Logic.toNumber(data.dy, 0),
        scale
      };
    }

    let point = null;
    if (data.mode === "source") {
      point = centerOfDocument(canvas.scene?.tiles?.get(sourceId) ?? canvas.scene?.tokens?.get(sourceId));
    } else if (data.mode === "token") {
      const token = findTokenByName(data.name);
      point = token ? { x: token.center.x, y: token.center.y } : null;
    }

    if (!point) {
      console.warn(INSTALL_TAG, "Camera Pan: target not found on this scene; the camera stays.", data);
      return { ...from, scale };
    }

    const shift = visibleShift(scale);
    return { x: point.x + shift.x, y: point.y + shift.y, scale };
  }

  // ------------------------------------------------------------
  // The glide
  // ------------------------------------------------------------
  function stopGlide() {
    if (view?.ticker) {
      try { canvas.app.ticker.remove(view.ticker); } catch (_) {}
      view.ticker = null;
    }
  }

  function applyView(v) {
    try { canvas.pan({ x: v.x, y: v.y, scale: v.scale }); } catch (_) {}
  }

  function glideTo(target, durationMs, onDone = null, motion = "smooth") {
    if (!view || !canvas?.ready) return;
    stopGlide();

    view.target = target;
    const from = currentView();
    const startedAt = performance.now();

    // A hidden tab draws no frames: land on the target at once, so the camera
    // is where it should be when the player comes back.
    if (durationMs <= 0 || document.visibilityState === "hidden") {
      applyView(target);
      onDone?.();
      return;
    }

    view.ticker = () => {
      if (!canvas?.ready || !view) return;
      const at = Logic.glideAt(from, target, startedAt, durationMs, performance.now(), motion);
      applyView(at);

      if (at.done) {
        stopGlide();
        onDone?.();
      }
    };

    canvas.app.ticker.add(view.ticker);
  }

  function takeCamera(sourceId) {
    if (!view) {
      view = { home: currentView(), target: null, ticker: null };
      followRuntime()?.holdCamera?.(HOLD_ID);
    }

    // One undo however many pans the event makes.
    Client.addCleanup(sourceId, "camera", ({ sceneGone } = {}) => giveCameraBack({ sceneGone }));
  }

  function giveCameraBack({ sceneGone = false, durationMs = RETURN_MS } = {}) {
    if (!view) return;

    const finish = () => {
      stopGlide();
      view = null;
      followRuntime()?.releaseCamera?.(HOLD_ID);
    };

    if (sceneGone || !canvas?.ready) {
      finish();
      return;
    }

    glideTo(homeView(), durationMs, finish);
  }

  // ------------------------------------------------------------
  // On every client
  // ------------------------------------------------------------
  Client.register(KIND_PAN, (data, info) => {
    const away = data.mode !== "party";

    if (!info.presents) {
      // The GM keeps their own camera; the chip says where the players' is.
      Client.setMarker(info.sourceId, "camera", away ? "camera away" : null);
      return;
    }

    if (!canvas?.ready) return;
    const durationMs = Math.max(0, Logic.toNumber(data.durationMs, DEFAULT_SECONDS * 1000));

    if (!away) {
      // The undo stays registered: if the event ends mid-glide it finishes
      // the return, and with the camera already home it does nothing.
      if (view) giveCameraBack({ durationMs });
      return;
    }

    takeCamera(info.sourceId);
    glideTo(resolveTarget(data, info.sourceId), durationMs, null, data.motion);
  });

  // ------------------------------------------------------------
  // The action
  // ------------------------------------------------------------
  function seconds(row) {
    return Math.min(MAX_SECONDS, Math.max(0, Logic.toNumber(row?.seconds, DEFAULT_SECONDS)));
  }

  const pickMotion = (value) => (MOTIONS.some(([key]) => key === value) ? value : "smooth");

  EventRegistry.register({
    type: "cameraPan",
    label: "Camera Pan",
    category: "Camera",
    defaultData: {
      type: "cameraPan",
      mode: "offset",
      dx: 0,
      dy: -200,
      name: "",
      zoom: 0,
      seconds: DEFAULT_SECONDS,
      motion: "smooth",
      wait: true
    },
    summary: (row) => (TARGETS.find(([value]) => value === row?.mode)?.[1] ?? ""),
    execute: async (row, context) => {
      const durationMs = seconds(row) * 1000;

      Client.run(context?.tileId, KIND_PAN, {
        mode: TARGETS.some(([value]) => value === row?.mode) ? row.mode : "offset",
        dx: Logic.toNumber(row?.dx, 0),
        dy: Logic.toNumber(row?.dy, 0),
        name: String(row?.name ?? ""),
        zoom: Logic.toNumber(row?.zoom, 0),
        durationMs,
        motion: pickMotion(row?.motion)
      });

      // Timed here, not by any one screen: a hidden or slow client cannot
      // hold the event up.
      if (row?.wait !== false) await flow()?.wait?.(context?.tileId, durationMs);

      return { ok: true, type: "cameraPan" };
    },
    buildFields: (row, kit) => {
      const mode = TARGETS.some(([value]) => value === row.mode) ? row.mode : "offset";

      const body = kit.fields(
        kit.field(
          "Pan to",
          `<select class="oni-event-row-cam-mode">${kit.options(TARGETS, mode)}</select>`,
          "The camera always returns to the party when the event ends. The GM's camera is not moved."
        ),
        `<div class="oni-event-row-cam-offset">${kit.field(
          "Offset (px)",
          `<div class="oni-event-inline-row">
             <span>X</span>${kit.numberInput("oni-event-row-cam-dx", Logic.toNumber(row.dx, 0), { step: 10 })}
             <span>Y</span>${kit.numberInput("oni-event-row-cam-dy", Logic.toNumber(row.dy, 0), { step: 10 })}
           </div>`,
          "In map pixels. Negative Y is up, negative X is left."
        )}</div>`,
        `<div class="oni-event-row-cam-token">${kit.field(
          "Token name",
          `<input type="text" class="oni-event-row-cam-name" value="${kit.escapeHTML(row.name ?? "")}" placeholder="Name of a token on this scene" />`
        )}</div>`,
        kit.field(
          "Zoom",
          kit.numberInput("oni-event-row-cam-zoom", Logic.toNumber(row.zoom, 0) > 0 ? row.zoom : "", { min: 0.1, max: 3, step: 0.05, placeholder: "keep" }),
          "Leave empty to keep the current zoom. 1 = actual size."
        ),
        kit.field(
          "Duration (s)",
          kit.numberInput("oni-event-row-cam-seconds", seconds(row), { min: 0, max: MAX_SECONDS, step: 0.1 })
        ),
        kit.field(
          "Motion",
          `<select class="oni-event-row-cam-motion">${kit.options(MOTIONS, pickMotion(row.motion))}</select>`,
          "Pull-back suits a fast zoom out: it starts gently, holds a steady rate and settles softly."
        ),
        kit.waitField(row, true)
      );

      const modeEl = body.querySelector(".oni-event-row-cam-mode");
      const sync = () => {
        body.querySelector(".oni-event-row-cam-offset").hidden = modeEl.value !== "offset";
        body.querySelector(".oni-event-row-cam-token").hidden = modeEl.value !== "token";
      };
      modeEl.addEventListener("change", sync);
      sync();

      return body;
    },
    collectFields: (rowEl, kit) => ({
      mode: kit.readText(rowEl, ".oni-event-row-cam-mode", "offset"),
      dx: kit.readNumber(rowEl, ".oni-event-row-cam-dx", 0),
      dy: kit.readNumber(rowEl, ".oni-event-row-cam-dy", 0),
      name: kit.readText(rowEl, ".oni-event-row-cam-name", "").trim(),
      zoom: kit.readNumber(rowEl, ".oni-event-row-cam-zoom", 0),
      seconds: Math.min(MAX_SECONDS, Math.max(0, kit.readNumber(rowEl, ".oni-event-row-cam-seconds", DEFAULT_SECONDS))),
      motion: pickMotion(kit.readText(rowEl, ".oni-event-row-cam-motion", "smooth")),
      wait: kit.readWait(rowEl, true)
    })
  });

  // The scene is going away: drop the camera at once. A hold left behind
  // would freeze the follow camera on the next map.
  Hooks.on("canvasTearDown", () => giveCameraBack({ sceneGone: true }));

  window.oni.EventSystem.RowsCamera = {
    installed: true,
    // For checks from the console: is an event holding this client's camera?
    isHolding: () => !!view
  };

  console.debug(INSTALL_TAG, "Installed.");
})();
