/**
 * [ONI] Event System — Creature Motion
 * Foundry VTT v12
 *
 * File:
 * scripts/event-system/event-rows-creature.js
 *
 * What this does:
 * - Registers the "Creature Motion" event action: a creature with a 3D rig
 *   (Nidhogg) roars, flinches or snarls on cue, or holds still at his painted
 *   pose for a show and moves again later.
 *
 * How it fits together:
 * - The GM picks the token; every client on the scene plays the motion on its
 *   own rig (Client.run). Nothing is written to the world.
 * - The rig code is an ES module, so this classic script reaches it at run time
 *   through FUCompanion.api.creatureRig (scripts/creature-rig/rig-api.js).
 * - A token without a rig on some client is passed over there, silently.
 * - "Hold still" is undone when the event ends, unless a later row lets go first.
 *
 * Requires:
 * - event-logic.js, event-eventRegistry.js, event-client.js, event-flow.js
 */

(() => {
  const INSTALL_TAG = "[ONI][EventSystem][RowsCreature]";

  window.oni = window.oni || {};
  window.oni.EventSystem = window.oni.EventSystem || {};

  if (window.oni.EventSystem.RowsCreature?.installed) {
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

  const TYPE = "creatureMotion";
  const KIND = "creatureRig.motion";
  const REST = "rest";
  const RELEASE = "release";
  const REST_MS = 250;
  const RELEASE_MS = 400;
  const FALLBACK_MOTIONS = ["roar", "flinch", "snarl"];
  const MAX_HOLD_SECONDS = 20;

  const TARGETS = [
    ["source", "This event's token"],
    ["token", "A named token"]
  ];

  const rigApi = () => globalThis.FUCompanion?.api?.creatureRig ?? null;
  const pick = (list, value, fallback) => (list.some(([key]) => key === value) ? value : fallback);

  function motionChoices() {
    let names = [];
    try { names = rigApi()?.motions?.() ?? []; } catch (_) { names = []; }
    if (!names.length) names = FALLBACK_MOTIONS;
    return [
      ...names.map((n) => [n, n.charAt(0).toUpperCase() + n.slice(1)]),
      [REST, "Hold still (painted pose)"],
      [RELEASE, "Move again"]
    ];
  }

  // Blank = the motion's own default.
  function holdOf(row) {
    const raw = row?.hold;
    if (raw === "" || raw === null || raw === undefined) return null;
    const n = Logic.toNumber(raw, NaN);
    return Number.isFinite(n) ? Math.min(MAX_HOLD_SECONDS, Math.max(0, n)) : null;
  }

  function findToken(row, context) {
    if (pick(TARGETS, row?.target, "token") === "source") {
      const doc = context?.sourceDoc;
      return doc?.documentName === "Token" ? (canvas.tokens?.get(doc.id) ?? null) : null;
    }
    const wanted = String(row?.name ?? "").trim().toLowerCase();
    return wanted ? ((canvas.tokens?.placeables ?? []).find(t =>
      String(t.document?.name ?? "").trim().toLowerCase() === wanted
      || String(t.actor?.name ?? "").trim().toLowerCase() === wanted
    ) ?? null) : null;
  }

  // Every client on the scene, the GM included.
  Client.register(KIND, (data, info) => {
    const api = rigApi();
    const tokenId = String(data?.tokenId ?? "");
    if (!api || !tokenId || !canvas?.ready) return;
    const undoKey = `${KIND}:rest:${tokenId}`;

    if (data.motion === REST) {
      api.restLocal?.(tokenId, REST_MS);
      Client.addCleanup(info.sourceId, undoKey, () => { api.releaseLocal?.(tokenId, RELEASE_MS); });
      return;
    }
    if (data.motion === RELEASE) {
      Client.removeCleanup(info.sourceId, undoKey);
      api.releaseLocal?.(tokenId, RELEASE_MS);
      return;
    }
    // Not undone at the event's end: a roar that started is let finish.
    api.playLocal?.(tokenId, String(data.motion ?? ""), data.opts ?? {});
  });

  EventRegistry.register({
    type: TYPE,
    label: "Creature Motion",
    category: "Token",
    defaultData: { type: TYPE, target: "token", name: "", motion: "roar", hold: "", wait: true },
    summary: (row) => {
      const label = motionChoices().find(([k]) => k === row?.motion)?.[1] ?? String(row?.motion || "roar");
      const who = pick(TARGETS, row?.target, "token") === "source" ? "this token" : (row?.name || "(no token)");
      return `${label} on ${who}`;
    },
    execute: async (row, context) => {
      const token = findToken(row, context);
      if (!token) {
        console.warn(INSTALL_TAG, "Creature Motion: no token to move; passed over.", row);
        return { ok: false, type: TYPE, reason: "notFound" };
      }

      const motion = String(row?.motion || "roar");
      const hold = holdOf(row);
      const opts = hold === null ? {} : { hold };
      Client.run(context?.tileId, KIND, { tokenId: token.id, motion, opts });

      if (row?.wait !== false) {
        // From the motion itself, so it is right even on a GM whose own rig is off.
        const ms = motion === REST ? REST_MS
          : motion === RELEASE ? RELEASE_MS
          : (rigApi()?.timing?.(motion, opts)?.durationMs ?? 0);
        if (ms > 0) await window.oni.EventSystem.Flow?.wait?.(context?.tileId, ms);
      }
      return { ok: true, type: TYPE };
    },
    buildFields: (row, kit) => {
      const body = kit.fields(
        kit.field(
          "On",
          `<select class="oni-event-row-creature-target">${kit.options(TARGETS, pick(TARGETS, row.target, "token"))}</select>`
        ),
        `<div class="oni-event-row-creature-name-wrap">${kit.field(
          "Token name",
          `<input type="text" class="oni-event-row-creature-name" value="${kit.escapeHTML(row.name ?? "")}" placeholder="Name of a token on this scene" />`
        )}</div>`,
        kit.field(
          "Motion",
          `<select class="oni-event-row-creature-motion">${kit.options(motionChoices(), String(row.motion || "roar"))}</select>`,
          "Only tokens with a 3D creature rig move (Nidhogg). Hold still: his painted pose, until Move again or the event ends."
        ),
        `<div class="oni-event-row-creature-hold-wrap">${kit.field(
          "Hold (s)",
          kit.numberInput("oni-event-row-creature-hold", row.hold ?? "", { min: 0, max: MAX_HOLD_SECONDS, step: 0.1, placeholder: "default" }),
          "How long a roar or snarl stays at its height. Blank: its usual length."
        )}</div>`,
        kit.waitField(row, true, "On: the next event waits until the motion has finished. Off: it starts straight away.")
      );

      const targetEl = body.querySelector(".oni-event-row-creature-target");
      const motionEl = body.querySelector(".oni-event-row-creature-motion");
      const sync = () => {
        body.querySelector(".oni-event-row-creature-name-wrap").hidden = targetEl.value !== "token";
        body.querySelector(".oni-event-row-creature-hold-wrap").hidden = motionEl.value === REST || motionEl.value === RELEASE;
      };
      targetEl.addEventListener("change", sync);
      motionEl.addEventListener("change", sync);
      sync();

      return body;
    },
    collectFields: (rowEl, kit) => {
      const rawHold = kit.readText(rowEl, ".oni-event-row-creature-hold", "").trim();
      return {
        target: pick(TARGETS, kit.readText(rowEl, ".oni-event-row-creature-target", "token"), "token"),
        name: kit.readText(rowEl, ".oni-event-row-creature-name", "").trim(),
        motion: kit.readText(rowEl, ".oni-event-row-creature-motion", "roar") || "roar",
        hold: rawHold === "" ? "" : holdOf({ hold: rawHold }) ?? "",
        wait: kit.readWait(rowEl, true)
      };
    }
  });

  window.oni.EventSystem.RowsCreature = { installed: true };
  console.debug(INSTALL_TAG, "Installed.");
})();
