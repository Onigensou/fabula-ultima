/**
 * [ONI] Event System — Set Token, Set Facing
 * Foundry VTT v12
 *
 * File:
 * scripts/event-system/event-rows-token.js
 *
 * What this does:
 * - Registers the "Set Token" event action: show or hide a named token on this
 *   scene and change its tint, so a cutscene can bring characters on and take
 *   them off with nobody clicking anything.
 * - Registers "Set Facing": turn the party or a token to one of eight directions.
 * - Registers "Set Token Position": place the party or a token at once, on a
 *   marker token or a point, without moving anyone's camera.
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
 * - The copy and its take-off smoke draw among the tokens (event-worldFx.js), so
 *   a tile at elevation 1, such as a cliff edge they stand behind, stays in front.
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

  const DIRECTIONS = [
    ["up", "Straight up"],
    ["upLeft", "Up and left"],
    ["upRight", "Up and right"]
  ];
  const SIDEWAYS = { up: 0, upLeft: -1, upRight: 1 };
  const JUMP_DRIFT_PX = 520;
  const pickDirection = (value) => (DIRECTIONS.some(([key]) => key === value) ? value : "up");

  // Guilty Gear white masks, in the same pair and colour as the Dreadwyrm's take-off.
  const SMOKE_DIR = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Animation/Guilty%20Gear%20Strive/webm/";
  const SMOKE = {
    plume: { src: `${SMOKE_DIR}smoke_anim14.webm`, width: 300 },
    kick: { src: `${SMOKE_DIR}dashsmoke_anim05.webm`, width: 230 },
    tint: 0xb9a9cc,
    alpha: 0.6,
    // Their baseline sits at 95% of the square clip.
    anchorY: 0.95,
    // A plume leans out to the side the character is not going.
    plumeOffsetPx: 28
  };

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
  function playJump(tokenId, { direction = "up", smoke = false, sourceId = "" } = {}) {
    if (document.visibilityState === "hidden") return;
    const mesh = canvas?.tokens?.get(tokenId)?.mesh;
    const host = canvas?.primary;
    const worldFx = window.oni.EventSystem.WorldFx;
    if (!mesh?.texture?.valid || !host || !worldFx) return;

    const sprite = new PrimarySpriteMesh({ texture: mesh.texture, name: "oniEventJump" });
    sprite.anchor.set(0.5, 1);
    sprite.tint = mesh.tint;
    sprite.elevation = 0;
    sprite.sortLayer = PrimaryCanvasGroup.SORT_LAYERS.TOKENS;
    sprite.sort = worldFx.SORT.COPIES;
    const baseX = mesh.scale.x;
    const baseY = mesh.scale.y;
    const footX = mesh.x;
    const footY = mesh.y + Math.abs(mesh.height) * (1 - mesh.anchor.y);
    const drift = SIDEWAYS[direction] ?? 0;
    sprite.position.set(footX, footY);
    sprite.scale.set(baseX, baseY);
    host.addChild(sprite);
    mesh.renderable = false;

    let smoked = !smoke;
    const puff = () => {
      smoked = true;
      const common = { y: footY, sourceId, anchorY: SMOKE.anchorY, sort: worldFx.SORT.OVER_TOKENS, alpha: SMOKE.alpha, tint: SMOKE.tint };
      worldFx.play({ ...common, src: SMOKE.plume.src, x: footX - (drift * SMOKE.plumeOffsetPx), width: SMOKE.plume.width, mirror: drift > 0 });
      worldFx.play({ ...common, src: SMOKE.kick.src, x: footX, width: SMOKE.kick.width, mirror: drift >= 0 });
    };

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
          if (!smoked) puff();
          const u = (elapsed - JUMP.crouchMs) / JUMP.launchMs;
          const k = Math.min(1, u / JUMP.snap);
          sx = mix(JUMP.squash.x, JUMP.stretch.x, k);
          sy = mix(JUMP.squash.y, JUMP.stretch.y, k);
          rise = JUMP.risePx * u * u;
          if (u > JUMP.fadeFrom) alpha = 1 - (u - JUMP.fadeFrom) / (1 - JUMP.fadeFrom);
        }

        sprite.scale.set(baseX * sx, baseY * sy);
        sprite.y = footY - rise;
        sprite.x = footX + (drift * JUMP_DRIFT_PX * (rise / JUMP.risePx));
        sprite.alpha = alpha;
      } catch (e) {
        console.warn(INSTALL_TAG, "Jump frame failed; dropping the effect.", e);
        finish();
      }
    };
    ticker.add(tick);
  }

  Client.register(KIND_JUMP, (data, info) => {
    for (const id of data.tokenIds ?? []) {
      playJump(id, { direction: pickDirection(data.direction), smoke: data.smoke === true, sourceId: info.sourceId });
    }
  });

  EventRegistry.register({
    type: "setToken",
    label: "Set Token",
    category: "Token",
    defaultData: { type: "setToken", name: "", visibility: "show", tint: "keep", color: DEFAULT_COLOR, direction: "up", smoke: false, wait: true },
    mediaOf: (row) => (row?.visibility === "jump" && row?.smoke === true
      ? namesIn(row?.name).flatMap(() => [SMOKE.plume.src, SMOKE.kick.src])
      : []),
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
        Client.run(context?.tileId, KIND_JUMP, {
          tokenIds: found.filter(t => !t.hidden).map(t => t.id),
          direction: pickDirection(row?.direction),
          smoke: row?.smoke === true
        });
        await scene.updateEmbeddedDocuments("Token", found.map(t => ({ _id: t.id, hidden: true, ...change })));
        if (row?.wait !== false) await window.oni.EventSystem.Flow?.wait?.(context?.tileId, JUMP_TOTAL_MS);
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
        `<div class="oni-event-row-token-jump-wrap">${kit.field(
          "Jump",
          `<select class="oni-event-row-token-direction">${kit.options(DIRECTIONS, pickDirection(row.direction))}</select>
           <label><input type="checkbox" class="oni-event-row-token-smoke" ${row.smoke === true ? "checked" : ""} /> take-off smoke</label>
           <label><input type="checkbox" class="oni-event-row-token-wait" ${row.wait !== false ? "checked" : ""} /> wait for it</label>`,
          "For several directions, use one row each with wait off, so they go together. The smoke sits in front of tokens and behind any tile at elevation 1."
        )}</div>`,
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
      const visibilityEl = body.querySelector(".oni-event-row-token-visibility");
      const sync = () => {
        body.querySelector(".oni-event-row-token-color-wrap").hidden = tintEl.value !== "set";
        body.querySelector(".oni-event-row-token-jump-wrap").hidden = visibilityEl.value !== "jump";
      };
      tintEl.addEventListener("change", sync);
      visibilityEl.addEventListener("change", sync);
      sync();

      return body;
    },
    collectFields: (rowEl, kit) => ({
      name: kit.readText(rowEl, ".oni-event-row-token-name", "").trim(),
      visibility: pick(VISIBILITY, kit.readText(rowEl, ".oni-event-row-token-visibility", "keep")),
      tint: pick(TINT, kit.readText(rowEl, ".oni-event-row-token-tint", "keep")),
      color: validColor(kit.readText(rowEl, ".oni-event-row-token-color", DEFAULT_COLOR)),
      direction: pickDirection(kit.readText(rowEl, ".oni-event-row-token-direction", "up")),
      smoke: !!kit.own(rowEl, ".oni-event-row-token-smoke")?.checked,
      wait: !!kit.own(rowEl, ".oni-event-row-token-wait")?.checked
    })
  });

  // ------------------------------------------------------------
  // Set Facing
  // ------------------------------------------------------------
  // Turns a token on every client through the facing system, which holds the
  // fallbacks: a direction the character has no art for shows the nearest one that
  // exists, and a character with no direction art keeps its image and mirrors.
  const KIND_FACING = "token.facing";

  const FACING_TARGETS = [
    ["party", "The party"],
    ["source", "This event's token"],
    ["token", "A named token"]
  ];
  const FACINGS = [
    ["up", "Up (back to the screen)"],
    ["upRight", "Up and right"],
    ["right", "Right"],
    ["downRight", "Down and right"],
    ["down", "Down (facing the screen)"],
    ["downLeft", "Down and left"],
    ["left", "Left"],
    ["upLeft", "Up and left"]
  ];
  const pickFacing = (value) => (FACINGS.some(([key]) => key === value) ? value : "up");
  const pickFacingTarget = (value) => (FACING_TARGETS.some(([key]) => key === value) ? value : "party");
  const facingApi = () => globalThis.__ONI_SPRITE_FACING_RUNTIME__ ?? null;

  function facingDocs(row, scene, context) {
    const target = pickFacingTarget(row?.target);
    if (target === "party") {
      const doc = scene?.tokens?.get(context?.tokenId);
      return doc ? [doc] : [];
    }
    if (target === "source") {
      return context?.sourceDoc?.documentName === "Token" ? [context.sourceDoc] : [];
    }
    return namesIn(row?.name).flatMap(n => tokensNamed(scene, n));
  }

  Client.register(KIND_FACING, (data) => {
    for (const id of data.tokenIds ?? []) {
      const token = canvas?.tokens?.get(id);
      if (token) facingApi()?.setDirection?.(token, data.direction);
    }
  });

  EventRegistry.register({
    type: "setFacing",
    label: "Set Facing",
    category: "Token",
    defaultData: { type: "setFacing", target: "party", name: "", direction: "up" },
    summary: (row) => {
      const who = pickFacingTarget(row?.target) === "token" ? (String(row?.name ?? "").trim() || "(no token)")
        : (pickFacingTarget(row?.target) === "source" ? "this token" : "the party");
      return `${who}: ${pickFacing(row?.direction)}`;
    },
    execute: async (row, context) => {
      const scene = game.scenes?.get(context?.sceneId) ?? canvas?.scene ?? null;
      const docs = facingDocs(row, scene, context);
      if (!docs.length) {
        console.warn(INSTALL_TAG, "Set Facing: no token to turn; passed over.", row);
        return { ok: false, type: "setFacing", reason: "notFound" };
      }

      const direction = pickFacing(row?.direction);
      Client.run(context?.tileId, KIND_FACING, { tokenIds: docs.map(d => d.id), direction });

      // Saved like the end of a walk, so a reload and a late joiner see it.
      const named = facingApi()?.NAMED_DIRECTIONS?.[direction];
      if (named) {
        const flags = { "flags.fabula-ultima-companion.facingDir": named.dir };
        if (named.side) flags["flags.fabula-ultima-companion.facing"] = named.side;
        await scene.updateEmbeddedDocuments("Token", docs.map(d => ({ _id: d.id, ...flags })));
      }

      return { ok: true, type: "setFacing", changed: docs.length };
    },
    buildFields: (row, kit) => {
      const body = kit.fields(
        kit.field(
          "Who",
          `<select class="oni-event-row-facing-target">${kit.options(FACING_TARGETS, pickFacingTarget(row.target))}</select>`
        ),
        `<div class="oni-event-row-facing-name-wrap">${kit.field(
          "Token names",
          `<input type="text" class="oni-event-row-facing-name" value="${kit.escapeHTML(row.name ?? "")}" placeholder="Names of tokens on this scene, separated by commas" />`
        )}</div>`,
        kit.field(
          "Direction",
          `<select class="oni-event-row-facing-direction">${kit.options(FACINGS, pickFacing(row.direction))}</select>`,
          "Stays after the event. If the character has no art for this direction, the nearest one it has is shown; with no direction art at all, it keeps its image and only mirrors left or right."
        )
      );

      const targetEl = body.querySelector(".oni-event-row-facing-target");
      const sync = () => {
        body.querySelector(".oni-event-row-facing-name-wrap").hidden = targetEl.value !== "token";
      };
      targetEl.addEventListener("change", sync);
      sync();

      return body;
    },
    collectFields: (rowEl, kit) => ({
      target: pickFacingTarget(kit.readText(rowEl, ".oni-event-row-facing-target", "party")),
      name: kit.readText(rowEl, ".oni-event-row-facing-name", "").trim(),
      direction: pickFacing(kit.readText(rowEl, ".oni-event-row-facing-direction", "up"))
    })
  });

  // ------------------------------------------------------------
  // Set Token Position
  // ------------------------------------------------------------
  // Places a token at once, with no walk, no footsteps and no turning. Foundry
  // pans a player's camera to a controlled token that lands offscreen, so the
  // move says not to: an event moving the party out of sight keeps its camera.
  const POSITION_MODES = [
    ["token", "On a marker token"],
    ["point", "At a point on the map"]
  ];
  const pickPositionMode = (value) => (POSITION_MODES.some(([key]) => key === value) ? value : "token");

  function positionTarget(row, scene) {
    if (pickPositionMode(row?.mode) === "point") {
      return { x: Logic.toNumber(row?.x, 0), y: Logic.toNumber(row?.y, 0) };
    }
    const mark = tokensNamed(scene, String(row?.mark ?? "").trim())[0];
    if (!mark) return null;
    const grid = scene.grid.size;
    return { x: mark.x + (mark.width * grid) / 2, y: mark.y + (mark.height * grid) / 2 };
  }

  EventRegistry.register({
    type: "setTokenPosition",
    label: "Set Token Position",
    category: "Token",
    defaultData: { type: "setTokenPosition", target: "party", name: "", mode: "token", mark: "", x: 0, y: 0 },
    summary: (row) => {
      const who = pickFacingTarget(row?.target) === "token" ? (String(row?.name ?? "").trim() || "(no token)")
        : (pickFacingTarget(row?.target) === "source" ? "this token" : "the party");
      const where = pickPositionMode(row?.mode) === "point" ? `${row?.x}, ${row?.y}` : (String(row?.mark ?? "").trim() || "(no marker)");
      return `${who} to ${where}`;
    },
    execute: async (row, context) => {
      const scene = game.scenes?.get(context?.sceneId) ?? canvas?.scene ?? null;
      const docs = facingDocs(row, scene, context);
      const at = positionTarget(row, scene);
      if (!docs.length || !at) {
        console.warn(INSTALL_TAG, "Set Token Position: no token or no marker; passed over.", row);
        return { ok: false, type: "setTokenPosition", reason: "notFound" };
      }

      const grid = scene.grid.size;
      await scene.updateEmbeddedDocuments("Token", docs.map(d => ({
        _id: d.id,
        x: at.x - (d.width * grid) / 2,
        y: at.y - (d.height * grid) / 2
      })), { animate: false, pan: false });

      return { ok: true, type: "setTokenPosition", changed: docs.length };
    },
    buildFields: (row, kit) => {
      const body = kit.fields(
        kit.field(
          "Who",
          `<select class="oni-event-row-position-target">${kit.options(FACING_TARGETS, pickFacingTarget(row.target))}</select>`
        ),
        `<div class="oni-event-row-position-name-wrap">${kit.field(
          "Token names",
          `<input type="text" class="oni-event-row-position-name" value="${kit.escapeHTML(row.name ?? "")}" placeholder="Names of tokens on this scene, separated by commas" />`
        )}</div>`,
        kit.field(
          "Where",
          `<select class="oni-event-row-position-mode">${kit.options(POSITION_MODES, pickPositionMode(row.mode))}</select>`,
          "The token's centre lands there at once. It doesn't move the camera: pan to where they'll be first if the player shouldn't see the jump."
        ),
        `<div class="oni-event-row-position-mark-wrap">${kit.field(
          "Marker token",
          `<input type="text" class="oni-event-row-position-mark" value="${kit.escapeHTML(row.mark ?? "")}" placeholder="Name of a token on this scene; a hidden one works" />`
        )}</div>`,
        `<div class="oni-event-row-position-point-wrap">${kit.field(
          "Point (x, y)",
          `${kit.numberInput("oni-event-row-position-x", Logic.toNumber(row.x, 0))} ${kit.numberInput("oni-event-row-position-y", Logic.toNumber(row.y, 0))}`
        )}</div>`
      );

      const targetEl = body.querySelector(".oni-event-row-position-target");
      const modeEl = body.querySelector(".oni-event-row-position-mode");
      const sync = () => {
        body.querySelector(".oni-event-row-position-name-wrap").hidden = targetEl.value !== "token";
        body.querySelector(".oni-event-row-position-mark-wrap").hidden = modeEl.value !== "token";
        body.querySelector(".oni-event-row-position-point-wrap").hidden = modeEl.value !== "point";
      };
      targetEl.addEventListener("change", sync);
      modeEl.addEventListener("change", sync);
      sync();

      return body;
    },
    collectFields: (rowEl, kit) => ({
      target: pickFacingTarget(kit.readText(rowEl, ".oni-event-row-position-target", "party")),
      name: kit.readText(rowEl, ".oni-event-row-position-name", "").trim(),
      mode: pickPositionMode(kit.readText(rowEl, ".oni-event-row-position-mode", "token")),
      mark: kit.readText(rowEl, ".oni-event-row-position-mark", "").trim(),
      x: kit.readNumber(rowEl, ".oni-event-row-position-x", 0),
      y: kit.readNumber(rowEl, ".oni-event-row-position-y", 0)
    })
  });

  window.oni.EventSystem.RowsToken = { installed: true };
  console.debug(INSTALL_TAG, "Installed.");
})();
