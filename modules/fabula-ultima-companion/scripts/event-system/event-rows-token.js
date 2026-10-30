/**
 * [ONI] Event System — Set Token
 * Foundry VTT v12
 *
 * File:
 * scripts/event-system/event-rows-token.js
 *
 * What this does:
 * - Registers the "Set Token" event action: show or hide a named token on this
 *   scene and change its tint, so a cutscene can bring characters on and take
 *   them off with nobody clicking anything.
 *
 * How it fits together:
 * - A GM writes the token document; every client sees it through Foundry. So
 *   the change stays after the event, unlike a camera pan or a screen effect.
 *   Author an event to leave its tokens how the next visitor should find them.
 * - Every token with that name changes, as Camera Pan finds names: the token's
 *   own name or its actor's.
 *
 * Requires:
 * - event-logic.js, event-eventRegistry.js
 */

(() => {
  const INSTALL_TAG = "[ONI][EventSystem][RowsToken]";

  window.oni = window.oni || {};
  window.oni.EventSystem = window.oni.EventSystem || {};

  if (window.oni.EventSystem.RowsToken?.installed) {
    console.debug(INSTALL_TAG, "Already installed; skipping.");
    return;
  }

  const Logic = window.oni.EventSystem.Logic;
  const EventRegistry = window.oni.EventSystem.EventRegistry;
  if (!Logic || !EventRegistry) {
    console.error(INSTALL_TAG, "Missing Logic or EventRegistry. Check load order.");
    return;
  }

  const VISIBILITY = [
    ["keep", "Leave as it is"],
    ["show", "Show"],
    ["hide", "Hide"]
  ];

  const TINT = [
    ["keep", "Leave as it is"],
    ["clear", "Clear (no tint)"],
    ["set", "Set to a colour"]
  ];

  const DEFAULT_COLOR = "#16102a";
  const NO_TINT = "#ffffff";

  const pick = (list, value) => (list.some(([key]) => key === value) ? value : "keep");

  function validColor(raw) {
    const s = String(raw ?? "").trim();
    return /^#[0-9a-f]{6}$/i.test(s) ? s : DEFAULT_COLOR;
  }

  function tokensNamed(scene, name) {
    const wanted = String(name ?? "").trim().toLowerCase();
    if (!wanted) return [];
    return (scene?.tokens?.contents ?? []).filter(t =>
      String(t.name ?? "").trim().toLowerCase() === wanted
      || String(t.actor?.name ?? "").trim().toLowerCase() === wanted
    );
  }

  EventRegistry.register({
    type: "setToken",
    label: "Set Token",
    category: "Token",
    defaultData: { type: "setToken", name: "", visibility: "show", tint: "keep", color: DEFAULT_COLOR },
    summary: (row) => {
      const parts = [String(row?.name ?? "").trim() || "(no token)"];
      if (pick(VISIBILITY, row?.visibility) !== "keep") parts.push(row.visibility);
      if (pick(TINT, row?.tint) !== "keep") parts.push(row.tint === "set" ? `tint ${validColor(row.color)}` : "no tint");
      return parts.join(", ");
    },
    execute: async (row, context) => {
      const scene = game.scenes?.get(context?.sceneId) ?? canvas?.scene ?? null;
      const found = tokensNamed(scene, row?.name);
      if (!found.length) {
        console.warn(INSTALL_TAG, "Set Token: no token by that name on this scene.", row?.name);
        return { ok: false, type: "setToken", reason: "notFound" };
      }

      const change = {};
      const visibility = pick(VISIBILITY, row?.visibility);
      if (visibility !== "keep") change.hidden = visibility === "hide";
      const tint = pick(TINT, row?.tint);
      if (tint !== "keep") change["texture.tint"] = tint === "set" ? validColor(row?.color) : NO_TINT;
      if (!Object.keys(change).length) return { ok: true, type: "setToken", changed: 0 };

      await scene.updateEmbeddedDocuments("Token", found.map(t => ({ _id: t.id, ...change })));
      return { ok: true, type: "setToken", changed: found.length };
    },
    buildFields: (row, kit) => {
      const tint = pick(TINT, row.tint);
      const body = kit.fields(
        kit.field(
          "Token name",
          `<input type="text" class="oni-event-row-token-name" value="${kit.escapeHTML(row.name ?? "")}" placeholder="Name of a token on this scene" />`,
          "Changes every token with this name, or whose actor has this name. A hidden token can be named here."
        ),
        kit.field(
          "Visibility",
          `<select class="oni-event-row-token-visibility">${kit.options(VISIBILITY, pick(VISIBILITY, row.visibility))}</select>`,
          "Stays after the event ends. Leave tokens how the next visitor should find them."
        ),
        kit.field(
          "Tint",
          `<select class="oni-event-row-token-tint">${kit.options(TINT, tint)}</select>`,
          "A near-black tint makes a silhouette against a bright background."
        ),
        `<div class="oni-event-row-token-color-wrap">${kit.field(
          "Colour",
          `<input type="color" class="oni-event-row-token-color" value="${validColor(row.color)}" />`
        )}</div>`
      );

      const tintEl = body.querySelector(".oni-event-row-token-tint");
      const sync = () => {
        body.querySelector(".oni-event-row-token-color-wrap").hidden = tintEl.value !== "set";
      };
      tintEl.addEventListener("change", sync);
      sync();

      return body;
    },
    collectFields: (rowEl, kit) => ({
      name: kit.readText(rowEl, ".oni-event-row-token-name", "").trim(),
      visibility: pick(VISIBILITY, kit.readText(rowEl, ".oni-event-row-token-visibility", "keep")),
      tint: pick(TINT, kit.readText(rowEl, ".oni-event-row-token-tint", "keep")),
      color: validColor(kit.readText(rowEl, ".oni-event-row-token-color", DEFAULT_COLOR))
    })
  });

  window.oni.EventSystem.RowsToken = { installed: true };
  console.debug(INSTALL_TAG, "Installed.");
})();
