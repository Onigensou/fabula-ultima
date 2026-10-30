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
 * - Every token with a listed name changes at once, as Camera Pan finds names:
 *   the token's own name or its actor's. A name with no token is reported to
 *   the GM and the rest of the row and the event carry on, so a token a GM
 *   deleted by hand does not stop a cutscene.
 * - Jump away is two parts. Every client plays a squash-and-stretch copy of the
 *   sprite, drawn on its own: nothing fights the idle bounce or the depth system
 *   for the real mesh. The token itself never moves; it is just hidden, so a
 *   later Show finds it where it stood.
 *
 * Requires:
 * - event-logic.js, event-eventRegistry.js, event-client.js, event-flow.js
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
  const Client = window.oni.EventSystem.Client;
  if (!Logic || !EventRegistry || !Client) {
    console.error(INSTALL_TAG, "Missing Logic, EventRegistry or Client. Check load order.");
    return;
  }

  const KIND_JUMP = "token.jump";

  const VISIBILITY = [
    ["keep", "Leave as it is"],
    ["show", "Show"],
    ["hide", "Hide"],
    ["jump", "Jump away, then hide"]
  ];

  // Jump away: crouch into a squash, then launch stretched and accelerating.
  const JUMP = {
    crouchMs: 190,
    launchMs: 520,
    risePx: 1200,
    squash: { x: 1.26, y: 0.68 },
    stretch: { x: 0.72, y: 1.46 },
    // Share of the launch spent going from squash to stretch.
    snap: 0.28,
    // Share of the launch left when the sprite starts to fade.
    fadeFrom: 0.72
  };
  const JUMP_TOTAL_MS = JUMP.crouchMs + JUMP.launchMs;

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

  const namesIn = (raw) => String(raw ?? "").split(",").map(s => s.trim()).filter(Boolean);

  function tokensNamed(scene, name) {
    const wanted = String(name ?? "").trim().toLowerCase();
    if (!wanted) return [];
    return (scene?.tokens?.contents ?? []).filter(t =>
      String(t.name ?? "").trim().toLowerCase() === wanted
      || String(t.actor?.name ?? "").trim().toLowerCase() === wanted
    );
  }

  const mix = (a, b, t) => a + (b - a) * t;

  // One token's jump on this client. Each frame is guarded: a throw inside a
  // ticker callback would stop PIXI's whole frame loop.
  function playJump(tokenId) {
    if (document.visibilityState === "hidden") return;
    const mesh = canvas?.tokens?.get(tokenId)?.mesh;
    const host = canvas?.interface;
    if (!mesh?.texture?.valid || !host) return;

    const sprite = new PIXI.Sprite(mesh.texture);
    sprite.anchor.set(0.5, 1);
    sprite.tint = mesh.tint;
    const baseX = mesh.scale.x;
    const baseY = mesh.scale.y;
    const footX = mesh.x;
    const footY = mesh.y + mesh.height * (1 - mesh.anchor.y);
    sprite.position.set(footX, footY);
    sprite.scale.set(baseX, baseY);
    host.addChild(sprite);
    mesh.renderable = false;

    const ticker = canvas.app.ticker;
    const startedAt = performance.now();
    const finish = () => {
      ticker.remove(tick);
      if (!mesh.destroyed) mesh.renderable = true;
      if (!sprite.destroyed) sprite.destroy();
    };
    const tick = () => {
      try {
        if (sprite.destroyed || !sprite.parent) return finish();
        const elapsed = performance.now() - startedAt;
        if (elapsed >= JUMP_TOTAL_MS) return finish();

        let sx, sy, rise = 0, alpha = 1;
        if (elapsed < JUMP.crouchMs) {
          const t = elapsed / JUMP.crouchMs;
          const e = 1 - (1 - t) * (1 - t);
          sx = mix(1, JUMP.squash.x, e);
          sy = mix(1, JUMP.squash.y, e);
        } else {
          const u = (elapsed - JUMP.crouchMs) / JUMP.launchMs;
          const k = Math.min(1, u / JUMP.snap);
          sx = mix(JUMP.squash.x, JUMP.stretch.x, k);
          sy = mix(JUMP.squash.y, JUMP.stretch.y, k);
          rise = JUMP.risePx * u * u;
          if (u > JUMP.fadeFrom) alpha = 1 - (u - JUMP.fadeFrom) / (1 - JUMP.fadeFrom);
        }

        sprite.scale.set(baseX * sx, baseY * sy);
        sprite.y = footY - rise;
        sprite.alpha = alpha;
      } catch (e) {
        console.warn(INSTALL_TAG, "Jump frame failed; dropping the effect.", e);
        finish();
      }
    };
    ticker.add(tick);
  }

  Client.register(KIND_JUMP, (data) => {
    for (const id of data.tokenIds ?? []) playJump(id);
  });

  EventRegistry.register({
    type: "setToken",
    label: "Set Token",
    category: "Token",
    defaultData: { type: "setToken", name: "", visibility: "show", tint: "keep", color: DEFAULT_COLOR },
    summary: (row) => {
      const parts = [String(row?.name ?? "").trim() || "(no token)"];
      if (pick(VISIBILITY, row?.visibility) !== "keep") parts.push(row.visibility === "jump" ? "jump away" : row.visibility);
      if (pick(TINT, row?.tint) !== "keep") parts.push(row.tint === "set" ? `tint ${validColor(row.color)}` : "no tint");
      return parts.join(", ");
    },
    execute: async (row, context) => {
      const scene = game.scenes?.get(context?.sceneId) ?? canvas?.scene ?? null;
      const names = namesIn(row?.name);
      const found = [...new Set(names.flatMap(n => tokensNamed(scene, n)))];
      const missing = names.filter(n => !tokensNamed(scene, n).length);
      if (missing.length) {
        console.warn(INSTALL_TAG, "Set Token: no token by that name on this scene.", missing);
        ui.notifications?.warn?.(`Event: no token named ${missing.join(", ")} on this scene. That part was skipped.`);
      }
      if (!found.length) return { ok: false, type: "setToken", reason: "notFound" };

      const change = {};
      const visibility = pick(VISIBILITY, row?.visibility);
      if (visibility === "show" || visibility === "hide") change.hidden = visibility === "hide";
      const tint = pick(TINT, row?.tint);
      if (tint !== "keep") change["texture.tint"] = tint === "set" ? validColor(row?.color) : NO_TINT;

      if (visibility === "jump") {
        // Only tokens that can be seen jump; the copy needs a drawn sprite.
        Client.run(context?.tileId, KIND_JUMP, { tokenIds: found.filter(t => !t.hidden).map(t => t.id) });
        await scene.updateEmbeddedDocuments("Token", found.map(t => ({ _id: t.id, hidden: true, ...change })));
        await window.oni.EventSystem.Flow?.wait?.(context?.tileId, JUMP_TOTAL_MS);
        return { ok: true, type: "setToken", changed: found.length };
      }

      if (!Object.keys(change).length) return { ok: true, type: "setToken", changed: 0 };

      await scene.updateEmbeddedDocuments("Token", found.map(t => ({ _id: t.id, ...change })));
      return { ok: true, type: "setToken", changed: found.length };
    },
    buildFields: (row, kit) => {
      const tint = pick(TINT, row.tint);
      const body = kit.fields(
        kit.field(
          "Token names",
          `<input type="text" class="oni-event-row-token-name" value="${kit.escapeHTML(row.name ?? "")}" placeholder="Names of tokens on this scene, separated by commas" />`,
          "All of them change at the same moment. Matches a token's name or its actor's. Hidden tokens can be named here. A name with no token is skipped with a warning to the GM."
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
