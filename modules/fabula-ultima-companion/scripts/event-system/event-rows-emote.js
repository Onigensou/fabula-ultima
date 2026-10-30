/**
 * [ONI] Event System — Show Emote
 * Foundry VTT v12
 *
 * File:
 * scripts/event-system/event-rows-emote.js
 *
 * What this does:
 * - Registers the "Show Emote" event action, RPG Maker's Show Balloon Icon: an
 *   emote from the emote system pops above someone's head.
 *
 * How it fits together:
 * - It plays through the emote system's API with an explicit token, which every
 *   client sees and which skips the hotkey permission check.
 * - The row picks the bubble's side once and sends the result, so every player
 *   sees the same thing: a client's own camera must not change the answer.
 * - The art's tail leans right, drawn to sit left of a head. Above a head the
 *   bubble moves over so the tail tip lands on the head, and mirrors when it
 *   goes on the right. Emotes with no tail stay centred; emotes with writing
 *   are never mirrored (emote-data.js).
 *
 * Requires:
 * - event-logic.js, event-eventRegistry.js, event-flow.js
 * - scripts/emotes-system/ (looked up when used)
 */

(() => {
  const INSTALL_TAG = "[ONI][EventSystem][RowsEmote]";

  window.oni = window.oni || {};
  window.oni.EventSystem = window.oni.EventSystem || {};

  if (window.oni.EventSystem.RowsEmote?.installed) {
    console.debug(INSTALL_TAG, "Already installed; skipping.");
    return;
  }

  const Logic = window.oni.EventSystem.Logic;
  const EventRegistry = window.oni.EventSystem.EventRegistry;
  if (!Logic || !EventRegistry) {
    console.error(INSTALL_TAG, "Missing Logic or EventRegistry. Check load order.");
    return;
  }

  const TARGETS = [
    ["party", "The party"],
    ["source", "This event's token"],
    ["token", "A named token"]
  ];
  const SIDES = [
    ["auto", "Auto"],
    ["left", "Left of the head"],
    ["right", "Right of the head"]
  ];

  const MODULE_ID = "fabula-ultima-companion";
  const DEFAULT_EMOTE = "Exc";
  const DEFAULT_HOLD_SECONDS = 0.9;
  const MAX_HOLD_SECONDS = 20;
  // Beyond this share of half the view from its centre, a token counts as off to one side.
  const OFF_CENTRE = 0.25;

  const pick = (list, value, fallback) => (list.some(([key]) => key === value) ? value : fallback);
  const emoteApi = () => globalThis.__ONI_EMOTE_API__ ?? globalThis.FUCompanion?.api?.EmoteSystem ?? null;
  const emoteData = () => globalThis.__ONI_EMOTE_DATA__ ?? globalThis.FUCompanion?.api?.EmoteData ?? null;
  const emoteRuntime = () => globalThis.__ONI_EMOTE_RUNTIME__ ?? globalThis.FUCompanion?.api?.EmoteRuntime ?? null;

  function holdSeconds(row) {
    return Math.min(MAX_HOLD_SECONDS, Math.max(0, Logic.toNumber(row?.seconds, DEFAULT_HOLD_SECONDS)));
  }

  function findToken(row, context) {
    const target = pick(TARGETS, row?.target, "party");

    if (target === "party") return canvas.tokens?.get(context?.tokenId) ?? null;

    if (target === "source") {
      const doc = context?.sourceDoc;
      return doc?.documentName === "Token" ? (canvas.tokens?.get(doc.id) ?? null) : null;
    }

    const wanted = String(row?.name ?? "").trim().toLowerCase();
    return wanted ? ((canvas.tokens?.placeables ?? []).find(t =>
      String(t.document?.name ?? "").trim().toLowerCase() === wanted
      || String(t.actor?.name ?? "").trim().toLowerCase() === wanted
    ) ?? null) : null;
  }

  // -1 left of the head, 1 right. The players' view is worked out from the scene,
  // not read from this GM's camera, which an event never moves.
  function autoSide(token) {
    const rect = canvas.dimensions?.sceneRect;
    const zoom = Number(canvas.scene?.initial?.scale) || canvas.stage.scale.x || 1;
    if (rect) {
      const half = (window.innerWidth / 2) / zoom;
      const low = rect.x + half;
      const high = rect.x + rect.width - half;
      const viewX = low < high ? Math.min(high, Math.max(low, token.center.x)) : rect.x + (rect.width / 2);
      const off = (token.center.x - viewX) / half;
      if (Math.abs(off) > OFF_CENTRE) return off > 0 ? -1 : 1;
    }

    // In front of a sprite looking sideways.
    const flags = token.document?.flags?.[MODULE_ID] ?? {};
    const dir = String(flags.facingDir ?? "").toLowerCase();
    const sideways = dir && dir !== "up" && dir !== "down";
    if (sideways) return flags.facing === "right" ? 1 : -1;

    // Facing away or towards the camera.
    return 1;
  }

  function placement(row, token, tail) {
    if (!tail) return { headShiftX: 0, flipX: false };

    const chosen = pick(SIDES, row?.side, "auto");
    let side = chosen === "auto" ? autoSide(token) : (chosen === "left" ? -1 : 1);
    // Writing would turn backwards, so it stays on the side it was drawn for.
    if (tail.noMirror) side = -1;

    return { headShiftX: side * Math.abs(tail.lean), flipX: side > 0 };
  }

  EventRegistry.register({
    type: "showEmote",
    label: "Show Emote",
    category: "Token",
    defaultData: { type: "showEmote", target: "party", name: "", emote: DEFAULT_EMOTE, side: "auto", seconds: DEFAULT_HOLD_SECONDS, wait: true },
    summary: (row) => `${String(row?.emote ?? DEFAULT_EMOTE)} on ${row?.target === "token" ? (row?.name || "(no token)") : (row?.target === "source" ? "this token" : "the party")}`,
    execute: async (row, context) => {
      const api = emoteApi();
      if (!api?.playEmote) return { ok: false, type: "showEmote", reason: "noEmoteSystem" };

      const token = findToken(row, context);
      if (!token) {
        console.warn(INSTALL_TAG, "Show Emote: no token to show it on; passed over.", row);
        return { ok: false, type: "showEmote", reason: "notFound" };
      }

      const emoteId = String(row?.emote ?? DEFAULT_EMOTE);
      const holdMs = holdSeconds(row) * 1000;
      const { headShiftX, flipX } = placement(row, token, emoteData()?.getTail?.(emoteId));

      const played = await api.playEmote({
        emoteId,
        tokenUuid: token.document.uuid,
        requestSource: "eventSystem",
        holdMs,
        headAnchor: true,
        headShiftX,
        flipX
      });
      if (!played?.ok) return { ok: false, type: "showEmote", reason: played?.reason ?? "playFailed" };

      // The emote system returns when it has sent the emote, not when it is over.
      if (row?.wait !== false) {
        const cfg = emoteRuntime()?.CFG ?? {};
        const totalMs = (Number(cfg.DEFAULT_FADE_IN_MS) || 0) + holdMs + (Number(cfg.DEFAULT_FADE_OUT_MS) || 0);
        await window.oni.EventSystem.Flow?.wait?.(context?.tileId, totalMs);
      }

      return { ok: true, type: "showEmote" };
    },
    buildFields: (row, kit) => {
      const catalog = emoteData()?.getConfigOptions?.() ?? [{ id: DEFAULT_EMOTE, label: DEFAULT_EMOTE }];
      const options = catalog.map((entry) => [entry.id, entry.label]);

      const body = kit.fields(
        kit.field(
          "On",
          `<select class="oni-event-row-emote-target">${kit.options(TARGETS, pick(TARGETS, row.target, "party"))}</select>`
        ),
        `<div class="oni-event-row-emote-name-wrap">${kit.field(
          "Token name",
          `<input type="text" class="oni-event-row-emote-name" value="${kit.escapeHTML(row.name ?? "")}" placeholder="Name of a token on this scene" />`
        )}</div>`,
        kit.field(
          "Emote",
          `<select class="oni-event-row-emote-id">${kit.options(options, String(row.emote ?? DEFAULT_EMOTE))}</select>`,
          "Exc is the \"!\" bubble."
        ),
        kit.field(
          "Side",
          `<select class="oni-event-row-emote-side">${kit.options(SIDES, pick(SIDES, row.side, "auto"))}</select>`,
          "Auto: towards the middle of the screen if the token is off to one side, else in front of a sprite looking sideways, else right of the head. Emotes with no tail stay centred; \"?\" and \"$\" stay on the left."
        ),
        kit.field(
          "Hold (s)",
          kit.numberInput("oni-event-row-emote-seconds", holdSeconds(row), { min: 0, max: MAX_HOLD_SECONDS, step: 0.1 }),
          "How long it stays after popping in. It takes about a third of a second more to appear and fade."
        ),
        kit.waitField(row, true)
      );

      const targetEl = body.querySelector(".oni-event-row-emote-target");
      const sync = () => {
        body.querySelector(".oni-event-row-emote-name-wrap").hidden = targetEl.value !== "token";
      };
      targetEl.addEventListener("change", sync);
      sync();

      return body;
    },
    collectFields: (rowEl, kit) => ({
      target: pick(TARGETS, kit.readText(rowEl, ".oni-event-row-emote-target", "party"), "party"),
      name: kit.readText(rowEl, ".oni-event-row-emote-name", "").trim(),
      emote: kit.readText(rowEl, ".oni-event-row-emote-id", DEFAULT_EMOTE),
      side: pick(SIDES, kit.readText(rowEl, ".oni-event-row-emote-side", "auto"), "auto"),
      seconds: Math.min(MAX_HOLD_SECONDS, Math.max(0, kit.readNumber(rowEl, ".oni-event-row-emote-seconds", DEFAULT_HOLD_SECONDS))),
      wait: kit.readWait(rowEl, true)
    })
  });

  window.oni.EventSystem.RowsEmote = { installed: true };
  console.debug(INSTALL_TAG, "Installed.");
})();
