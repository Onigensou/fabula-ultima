/**
 * [ONI] Event System — Floating Text
 * Foundry VTT v12
 *
 * File:
 * scripts/event-system/event-rows-float.js
 *
 * What this does:
 * - Registers the "Floating Text" event action: a line with no box and no
 *   speaker, drawn straight on the screen. For a narrator, a voice in the
 *   head, a voice from a thing on the map.
 *
 * How it fits together:
 * - It is a line of dialogue like Show Text: the same typewriter, the same
 *   blip, the same presses (the first completes the line, the next moves on),
 *   the same rule for who may press. Only the look and the place differ
 *   (scripts/dialog-system/dialog-float.js).
 * - Rows of Floating Text that follow one another are one PASSAGE. A line
 *   stays on screen when the player moves on, and the next joins it; lines in
 *   one place stack, and a stack that is full starts again by itself. The
 *   whole passage fades when a row that is not Floating Text comes next, or
 *   the event ends. "Start fresh" clears the screen before a line.
 * - Dimming the screen is not part of this action. Put Screen Effect: Dim
 *   before the passage; the event's end lifts it.
 * - The GM is shown the text (like a speech bubble), not the dim.
 *
 * Requires:
 * - event-logic.js, event-eventRegistry.js, event-flow.js, event-gameState.js
 * - scripts/dialog-system/dialog-core.js, dialog-ui.js, dialog-float.js
 */

(() => {
  const INSTALL_TAG = "[ONI][EventSystem][RowsFloat]";

  window.oni = window.oni || {};
  window.oni.EventSystem = window.oni.EventSystem || {};

  if (window.oni.EventSystem.RowsFloat?.installed) {
    console.debug(INSTALL_TAG, "Already installed; skipping.");
    return;
  }

  const Logic = window.oni.EventSystem.Logic;
  const EventRegistry = window.oni.EventSystem.EventRegistry;
  if (!Logic || !EventRegistry) {
    console.error(INSTALL_TAG, "Missing Logic or EventRegistry. Check load order.");
    return;
  }

  const TYPE = "floatingText";
  const DEFAULT_CPS = 28;
  const AUTO_MAX_SECONDS = 60;

  // "auto" is the upper centre of the screen: lines flow down a centred column.
  const PLACES = [
    ["auto", "Auto (centred, flowing down)"],
    ["tl", "Screen: top left"], ["tc", "Screen: top centre"], ["tr", "Screen: top right"],
    ["ml", "Screen: middle left"], ["mc", "Screen: middle centre"], ["mr", "Screen: middle right"],
    ["bl", "Screen: bottom left"], ["bc", "Screen: bottom centre"], ["br", "Screen: bottom right"],
    ["source", "Map: beside this event's tile / token"],
    ["token", "Map: beside a named token"]
  ];
  const isPlace = (value) => PLACES.some(([key]) => key === value);
  const isScreenPlace = (value) => value !== "source" && value !== "token";

  const flow = () => window.oni.EventSystem.Flow;
  const gameState = () => window.oni.EventSystem.GameState;

  function withVariables(text) {
    const state = gameState();
    if (!state?.getVariable) return String(text ?? "");
    return Logic.substituteVars(text, (name) => state.getVariable(name));
  }

  function prepare(row) {
    row.text = String(row.text ?? "");
    row.place = isPlace(row.place) ? row.place : "auto";
    row.name = String(row.name ?? "").trim();
    row.nudgeX = Math.round(Logic.toNumber(row.nudgeX, 0));
    row.nudgeY = Math.round(Logic.toNumber(row.nudgeY, 0));
    row.startFresh = row.startFresh === true;
    row.autoSeconds = Math.min(AUTO_MAX_SECONDS, Math.max(0, Logic.toNumber(row.autoSeconds, 0)));
  }

  // Where the line goes, as the dialogue system takes it.
  function placement(row, context) {
    if (row.place === "source") {
      const doc = context?.sourceDoc;
      if (doc) return { target: { kind: doc.documentName === "Token" ? "token" : "tile", id: doc.id } };
    }

    if (row.place === "token") {
      const wanted = row.name.toLowerCase();
      const token = wanted ? (canvas.tokens?.placeables ?? []).find(t =>
        String(t.document?.name ?? "").trim().toLowerCase() === wanted
        || String(t.actor?.name ?? "").trim().toLowerCase() === wanted) : null;
      if (token) return { target: { kind: "token", id: token.id } };
      console.warn(INSTALL_TAG, `Floating Text: no token named "${row.name}" on this scene; the line is shown at the centre.`);
    }

    const anchor = isScreenPlace(row.place) && row.place !== "auto" ? row.place : "tc";
    const nudge = (row.nudgeX || row.nudgeY) ? { x: row.nudgeX, y: row.nudgeY } : null;
    return { anchor, nudge };
  }

  async function execute(row, context) {
    const sourceId = String(context?.tileId || "");
    const f = flow();
    const dialog = globalThis.FU?.Dialog;
    const ui = globalThis.FU?.DialogUI;
    if (typeof dialog?.showFloating !== "function" || !ui?.renderFloat) return { ok: false, reason: "noFloatingText" };

    const text = withVariables(row.text);
    // The passage ends after this line unless more floating text follows.
    const endsPassage = context?.nextRowType !== TYPE;

    if (text.trim()) {
      const autoMs = row.autoSeconds * 1000;
      // A line that moves on by itself does not wait; otherwise as Show Text:
      // a locked event waits for a press, a free one runs on its own timer.
      const waitForInput = autoMs <= 0 && !!f?.shouldWaitForInput?.(sourceId);
      const maxWaitMs = Number(f?.LINE_MAX_WAIT_MS) || 30000;

      const shown = await dialog.showFloating({
        text,
        speed: DEFAULT_CPS,
        broadcast: true,
        sceneId: context?.sceneId || canvas?.scene?.id || null,
        waitForInput,
        maxWaitMs,
        holdMs: autoMs > 0 ? autoMs : null,
        controlled: !!f,
        startFresh: row.startFresh,
        ...placement(row, context)
      });

      if (shown) {
        f?.setActiveBubble?.(sourceId, shown.bubbleId);

        // The line reports when it has closed; the clock is only a backstop.
        const typeMs = Math.ceil((text.replace(/<\/?b>/gi, "").length / DEFAULT_CPS) * 1000);
        const backstopMs = typeMs + (waitForInput ? maxWaitMs : (autoMs || (typeMs + 1600))) + 5000;
        await Promise.race([shown.finished, new Promise(r => setTimeout(r, backstopMs))]);

        f?.setActiveBubble?.(sourceId, null);
      }
    }

    if (endsPassage && ui.isFloating?.()) {
      ui.clearFloating({ broadcast: true, sceneId: context?.sceneId || canvas?.scene?.id || null });
      // Let the passage fade before whatever comes next.
      await f?.wait?.(sourceId, Number(ui.FLOAT_FADE_OUT_MS) || 380);
    }

    return { ok: true, type: TYPE };
  }

  EventRegistry.register({
    type: TYPE,
    label: "Floating Text",
    category: "Dialogue",
    defaultData: {
      type: TYPE,
      text: "",
      place: "auto",
      name: "",
      nudgeX: 0,
      nudgeY: 0,
      startFresh: false,
      autoSeconds: 0
    },
    prepare,
    summary: (row) => String(row?.text ?? "").replace(/<\/?b>/gi, "").slice(0, 40),
    execute,
    buildFields: (row, kit) => {
      const body = kit.fields(
        kit.field(
          "Text",
          `<textarea class="oni-float-text oni-event-textarea" style="min-height:70px"
             placeholder="A line with no speaker: a narrator, a voice in the head...">${kit.escapeHTML(String(row.text ?? ""))}</textarea>`,
          `Typed out and advanced like Show Text. <code>&lt;b&gt;…&lt;/b&gt;</code> highlights; <code>{var:name}</code> prints a variable.
           Floating Text rows that follow one another stay on screen together and fade as one.
           To dim the screen behind, put <b>Screen Effect: Dim</b> before them.`
        ),
        kit.field(
          "Where",
          `<select class="oni-float-place">${kit.options(PLACES, row.place)}</select>`,
          `<b>Screen</b> places hold still whatever the camera does; lines in one place stack (down from the top,
           up from the bottom). <b>Map</b> places ride the map beside their target. Lines in different places
           can be on screen together.`
        ),
        `<div class="oni-float-name-wrap">${kit.field(
          "Token name",
          `<input type="text" class="oni-float-name" value="${kit.escapeHTML(row.name ?? "")}" placeholder="Name of a token on this scene" />`
        )}</div>`,
        `<div class="oni-float-nudge-wrap">${kit.field(
          "Nudge (px)",
          `<div class="oni-event-inline-row">
             <span>X</span>${kit.numberInput("oni-float-nudge-x", row.nudgeX || "", { step: 10, placeholder: "0" })}
             <span>Y</span>${kit.numberInput("oni-float-nudge-y", row.nudgeY || "", { step: 10, placeholder: "0" })}
           </div>`,
          "Optional. Screen pixels from the chosen place. Negative Y is up."
        )}</div>`,
        kit.field(
          "Start fresh",
          `<label><input type="checkbox" class="oni-float-fresh" ${row.startFresh ? "checked" : ""} /> clear the floating text on screen before this line</label>`
        ),
        kit.field(
          "Advance by itself",
          kit.numberInput("oni-float-auto", row.autoSeconds > 0 ? row.autoSeconds : "", { min: 0, max: AUTO_MAX_SECONDS, step: 0.5, placeholder: "wait for a press" }),
          "Seconds after the line is complete. Empty: wait for a press. A press still moves on sooner."
        )
      );

      const placeEl = body.querySelector(".oni-float-place");
      const sync = () => {
        body.querySelector(".oni-float-name-wrap").hidden = placeEl.value !== "token";
        body.querySelector(".oni-float-nudge-wrap").hidden = !isScreenPlace(placeEl.value);
      };
      placeEl.addEventListener("change", sync);
      sync();

      return body;
    },
    collectFields: (rowEl, kit) => ({
      text: kit.readText(rowEl, ".oni-float-text", ""),
      place: kit.readText(rowEl, ".oni-float-place", "auto"),
      name: kit.readText(rowEl, ".oni-float-name", "").trim(),
      nudgeX: Math.round(kit.readNumber(rowEl, ".oni-float-nudge-x", 0)),
      nudgeY: Math.round(kit.readNumber(rowEl, ".oni-float-nudge-y", 0)),
      startFresh: !!kit.own(rowEl, ".oni-float-fresh")?.checked,
      autoSeconds: Math.min(AUTO_MAX_SECONDS, Math.max(0, kit.readNumber(rowEl, ".oni-float-auto", 0)))
    })
  });

  window.oni.EventSystem.RowsFloat = { installed: true, TYPE };

  console.debug(INSTALL_TAG, "Installed.");
})();
