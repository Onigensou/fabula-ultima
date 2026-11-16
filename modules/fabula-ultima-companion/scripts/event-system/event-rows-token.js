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
 * - Show can fade in: every client fades a copy in while it rises into place,
 *   then the GM shows the token. "Crouch" ends the copy squashed and holds it a
 *   moment, so a Jump To that leaps out next takes over from the crouch.
 * - A tint can fade: every client blends the mesh's tint over the time, then the
 *   GM writes the new tint, so it stays as before.
 * - Set Facing can turn toward the party or a named token, worked out when the
 *   row runs: one of eight directions, and a left or right mirror for a token
 *   with a single picture (straight up or down still mirrors to that side).
 * - The Guilty Gear dust (ggDust) is shared with Jump To.
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
  const KIND_SHOW = "token.show";
  const KIND_TINT = "token.tint";

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

  // Dust for a leap or a landing, by the jumper's drawn height (map px). The
  // mockup's sizes: 150 and 175 for a 260 px Asura; the party, about 80.
  const DUST = {
    takeoff: 150 / 260,
    landing: 175 / 260,
    minPx: 80,
    // The mockup's puffs, as share of the size: [clip, dx, dy, width, mirror, alpha].
    // A landing adds two low spikes out to the sides.
    launch: [
      ["kick", 0, 0.06, 1.25, false, 0.6],
      ["plume", -0.42, 0.02, 0.95, true, 0.56],
      ["plume", 0.42, 0.02, 0.95, false, 0.56]
    ],
    land: [
      ["kick", -0.5, 0.08, 0.8, true, 0.42],
      ["kick", 0.5, 0.08, 0.8, false, 0.42]
    ]
  };

  const dustSize = (heightPx, landing) => Math.max(DUST.minPx, Math.round((Number(heightPx) || 0) * (landing ? DUST.landing : DUST.takeoff)));

  // The clips of one puff of dust at x, y (the jumper's feet), size from dustSize.
  function dustPuffs(x, y, size, landing) {
    return [...DUST.launch, ...(landing ? DUST.land : [])].map(([clip, dx, dy, w, mirror, alpha]) => ({
      src: SMOKE[clip].src, x: x + (dx * size), y: y + (dy * size), width: w * size, mirror, alpha
    }));
  }

  // Plays on this client.
  function ggDust(x, y, size, landing, sourceId = "") {
    const worldFx = window.oni.EventSystem.WorldFx;
    if (!worldFx) return;
    for (const puff of dustPuffs(x, y, size, landing)) {
      worldFx.play({ ...puff, sourceId, anchorY: SMOKE.anchorY, sort: worldFx.SORT.OVER_TOKENS, tint: SMOKE.tint });
    }
  }

  const TINT = [
    ["keep", "Leave as it is"],
    ["clear", "Clear (no tint)"],
    ["set", "Set to a colour"]
  ];

  const DEFAULT_COLOR = "#16102a";
  const NO_TINT = "#ffffff";

  // Show with a fade: the copy fades in while it rises into place, eased out.
  // Crouch: it goes from a deep squash to a crouch, as Asura behind the rubble.
  const SHOW = {
    crouchFrom: { x: 1.1, y: 0.6 },
    crouch: { x: 1.2, y: 0.72 },
    // A crouch no jump takes over stands back up after this.
    holdMs: 1500,
    standMs: 200,
    // A late token update: keep the real token hidden until it is shown (or give up).
    settleMs: 1500
  };
  const MAX_FADE_MS = 10000;
  const fadeMsOf = (v) => Math.min(MAX_FADE_MS, Math.max(0, Math.round(Number(v) || 0)));
  const risePxOf = (v) => Math.min(2000, Math.max(0, Math.round(Number(v) || 0)));

  const pick = (list, value) => (list.some(([key]) => key === value) ? value : "keep");

  function validColor(raw) {
    const s = String(raw ?? "").trim();
    return /^#[0-9a-f]{6}$/i.test(s) ? s : DEFAULT_COLOR;
  }

  const colorNumber = (hex) => parseInt(String(hex).slice(1), 16);

  // A colour part way from a to b (0xrrggbb numbers), each channel on its own.
  function mixColor(a, b, t) {
    const k = Math.min(1, Math.max(0, t));
    let out = 0;
    for (const shift of [16, 8, 0]) {
      const ca = (a >> shift) & 0xff;
      const cb = (b >> shift) & 0xff;
      out |= Math.round(ca + (cb - ca) * k) << shift;
    }
    return out;
  }

  const hiddenTab = () => document.visibilityState === "hidden";

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
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);

  // A copy of a token's sprite standing where its feet are, among the tokens.
  // Not yet added to the canvas.
  function copyOf(mesh, name) {
    const sprite = new PrimarySpriteMesh({ texture: mesh.texture, name });
    sprite.anchor.set(0.5, 1);
    sprite.tint = mesh.tint;
    sprite.elevation = 0;
    sprite.sortLayer = PrimaryCanvasGroup.SORT_LAYERS.TOKENS;
    sprite.sort = window.oni.EventSystem.WorldFx?.SORT?.COPIES ?? 500000;
    const baseX = mesh.scale.x;
    const baseY = mesh.scale.y;
    const footX = mesh.x;
    const footY = mesh.y + Math.abs(mesh.height) * (1 - mesh.anchor.y);
    sprite.position.set(footX, footY);
    sprite.scale.set(baseX, baseY);
    return { sprite, baseX, baseY, footX, footY };
  }

  // Copies left crouching by a Show, by token id: a Jump To takes one over.
  const held = new Map();

  /**
   * Ends a crouching copy at once, on this client, and gives its squash
   * ({ sx, sy }), or null when there is none. The real mesh stays unrendered:
   * the caller draws its own copy from here.
   */
  function takeHeld(tokenId) {
    const h = held.get(tokenId);
    if (!h) return null;
    held.delete(tokenId);
    return h.take();
  }

  // One token's fade-in on this client: a copy fades in rising into place.
  function playShow(tokenId, { fadeMs, risePx = 0, crouch = false, sourceId = "" } = {}) {
    if (hiddenTab()) return;
    const token = canvas?.tokens?.get(tokenId);
    const mesh = token?.mesh;
    const host = canvas?.primary;
    if (!mesh?.texture?.valid || !host) return;

    takeHeld(tokenId);
    const { sprite, baseX, baseY, footX, footY } = copyOf(mesh, "oniEventShow");
    sprite.alpha = 0;
    host.addChild(sprite);
    mesh.renderable = false;

    const ticker = canvas.app.ticker;
    const startedAt = performance.now();
    let squash = { sx: 1, sy: 1 };
    let done = false;

    const stop = () => {
      done = true;
      ticker.remove(tick);
      if (held.get(tokenId)?.sprite === sprite) held.delete(tokenId);
      if (!sprite.destroyed) sprite.destroy();
    };
    const finish = () => {
      if (done) return;
      stop();
      // Show the real token once this client has it shown (or give up waiting).
      const reveal = () => { if (!mesh.destroyed) mesh.renderable = true; };
      if (!token.document?.hidden) return reveal();
      const giveUpAt = performance.now() + SHOW.settleMs;
      const wait = () => {
        try {
          if (!token.document?.hidden || performance.now() > giveUpAt || mesh.destroyed) { ticker.remove(wait); reveal(); }
        } catch (_) { ticker.remove(wait); reveal(); }
      };
      ticker.add(wait);
    };
    if (crouch) {
      held.set(tokenId, {
        sprite,
        take: () => { const s = { ...squash }; stop(); return s; }
      });
    }

    const tick = () => {
      try {
        if (sprite.destroyed || !sprite.parent) return finish();
        const t = performance.now() - startedAt;
        const u = Math.min(1, t / fadeMs);
        const e = easeOut(u);
        sprite.alpha = e;
        sprite.y = footY + (risePx * (1 - e));
        sprite.tint = mesh.tint;

        if (!crouch) {
          if (u >= 1) return finish();
          return;
        }
        if (t < fadeMs + SHOW.holdMs) {
          squash = { sx: mix(SHOW.crouchFrom.x, SHOW.crouch.x, e), sy: mix(SHOW.crouchFrom.y, SHOW.crouch.y, e) };
        } else {
          const s = (t - fadeMs - SHOW.holdMs) / SHOW.standMs;
          if (s >= 1) return finish();
          squash = { sx: mix(SHOW.crouch.x, 1, s), sy: mix(SHOW.crouch.y, 1, s) };
        }
        sprite.scale.set(baseX * squash.sx, baseY * squash.sy);
        sprite.x = footX;
      } catch (e) {
        console.warn(INSTALL_TAG, "Show frame failed; dropping the effect.", e);
        finish();
      }
    };
    tick();
    ticker.add(tick);
    Client.addCleanup(sourceId, `token.show.${tokenId}`, () => { if (!done) finish(); });
  }

  // One token's tint fade on this client. The target is held on the mesh until
  // the token's own tint arrives, so it does not blink back meanwhile.
  function playTint(tokenId, { to, ms, sourceId = "" } = {}) {
    const token = canvas?.tokens?.get(tokenId);
    const mesh = token?.mesh;
    if (!mesh || !Number.isFinite(to)) return;
    const was = Number(mesh.tint);
    const from = Number.isFinite(was) ? was : 0xffffff;

    const ticker = canvas.app.ticker;
    const startedAt = performance.now();
    let done = false;
    const finish = () => { done = true; ticker.remove(tick); };
    const arrived = () => Number(token.document?.texture?.tint ?? 0xffffff) === to;
    const tick = () => {
      try {
        if (mesh.destroyed) return finish();
        const t = performance.now() - startedAt;
        if (t >= ms && (arrived() || t >= ms + SHOW.settleMs)) {
          mesh.tint = to;
          return finish();
        }
        mesh.tint = mixColor(from, to, t / ms);
      } catch (e) {
        console.warn(INSTALL_TAG, "Tint frame failed; dropping the effect.", e);
        finish();
      }
    };
    ticker.add(tick);
    Client.addCleanup(sourceId, `token.tint.${tokenId}`, () => { if (!done) finish(); });
  }

  Client.register(KIND_SHOW, (data, info) => {
    for (const id of data.tokenIds ?? []) {
      playShow(id, { fadeMs: fadeMsOf(data.fadeMs) || 1, risePx: risePxOf(data.risePx), crouch: data.crouch === true, sourceId: info.sourceId });
    }
  });

  Client.register(KIND_TINT, (data, info) => {
    for (const id of data.tokenIds ?? []) {
      playTint(id, { to: Number(data.to), ms: fadeMsOf(data.ms) || 1, sourceId: info.sourceId });
    }
  });

  // One token's jump on this client. Each frame is guarded: a throw inside a
  // ticker callback would stop PIXI's whole frame loop.
  function playJump(tokenId, { direction = "up", smoke = false, sourceId = "" } = {}) {
    if (document.visibilityState === "hidden") return;
    const mesh = canvas?.tokens?.get(tokenId)?.mesh;
    const host = canvas?.primary;
    const worldFx = window.oni.EventSystem.WorldFx;
    if (!mesh?.texture?.valid || !host || !worldFx) return;

    takeHeld(tokenId);
    const { sprite, baseX, baseY, footX, footY } = copyOf(mesh, "oniEventJump");
    const drift = SIDEWAYS[direction] ?? 0;
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
    defaultData: {
      type: "setToken", name: "", visibility: "show", tint: "keep", color: DEFAULT_COLOR, direction: "up", smoke: false, wait: true,
      fadeMs: 0, risePx: 0, crouch: false, tintFadeMs: 0
    },
    mediaOf: (row) => (row?.visibility === "jump" && row?.smoke === true
      ? namesIn(row?.name).flatMap(() => [SMOKE.plume.src, SMOKE.kick.src])
      : []),
    summary: (row) => {
      const parts = [String(row?.name ?? "").trim() || "(no token)"];
      const visibility = pick(VISIBILITY, row?.visibility);
      if (visibility !== "keep") parts.push(visibility === "jump" ? "jump away" : visibility);
      if (visibility === "show" && fadeMsOf(row?.fadeMs) > 0) {
        parts.push(`fade in ${fadeMsOf(row.fadeMs)} ms${risePxOf(row?.risePx) ? ` rising ${risePxOf(row.risePx)} px` : ""}${row?.crouch === true ? " into a crouch" : ""}`);
      }
      if (pick(TINT, row?.tint) !== "keep") {
        parts.push(row.tint === "set" ? `tint ${validColor(row.color)}` : "no tint");
        if (visibility !== "jump" && fadeMsOf(row?.tintFadeMs) > 0) parts.push(`tint fade ${fadeMsOf(row.tintFadeMs)} ms`);
      }
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

      // Fades: every client plays them, then the GM writes what they faded to.
      // An instant part is written first, so a Show and a tint fade together
      // shows the token and then blends its tint.
      const fadeMs = visibility === "show" ? fadeMsOf(row?.fadeMs) : 0;
      const tintMs = tint !== "keep" ? fadeMsOf(row?.tintFadeMs) : 0;
      const later = {};
      if (fadeMs > 0) { later.hidden = false; delete change.hidden; }
      if (tintMs > 0) {
        later["texture.tint"] = change["texture.tint"];
        delete change["texture.tint"];
        // Hiding after a tint fade: hide at its end, not before it.
        if (visibility === "hide") { later.hidden = true; delete change.hidden; }
      }

      if (Object.keys(change).length) {
        await scene.updateEmbeddedDocuments("Token", found.map(t => ({ _id: t.id, ...change })));
      }
      if (!Object.keys(later).length) return { ok: true, type: "setToken", changed: found.length };

      const fading = found.filter(t => t.hidden).map(t => t.id);
      if (fadeMs > 0 && fading.length) {
        Client.run(context?.tileId, KIND_SHOW, { tokenIds: fading, fadeMs, risePx: risePxOf(row?.risePx), crouch: row?.crouch === true });
      }
      if (tintMs > 0) {
        Client.run(context?.tileId, KIND_TINT, { tokenIds: found.map(t => t.id), to: colorNumber(later["texture.tint"]), ms: tintMs });
      }
      const go = await window.oni.EventSystem.Flow?.wait?.(context?.tileId, Math.max(fading.length ? fadeMs : 0, tintMs));
      if (go === false) return { ok: false, type: "setToken", reason: "ended" };

      await scene.updateEmbeddedDocuments("Token", found.map(t => ({ _id: t.id, ...later })));
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
        `<div class="oni-event-row-token-show-wrap">${kit.field(
          "Fade in (ms)",
          `${kit.numberInput("oni-event-row-token-fade", fadeMsOf(row.fadeMs), { min: 0, max: MAX_FADE_MS, step: 10 })}
           rising ${kit.numberInput("oni-event-row-token-rise", risePxOf(row.risePx), { min: 0, max: 2000, step: 5 })} px
           <label><input type="checkbox" class="oni-event-row-token-crouch" ${row.crouch === true ? "checked" : ""} /> into a crouch</label>`,
          "0 = shown at once. Otherwise it fades in while it rises into place from that far below, then the row goes on. Into a crouch: it ends squashed, ready for a Jump To that leaps out next (1.5 s, then it stands up)."
        )}</div>`,
        kit.field(
          "Tint",
          `<select class="oni-event-row-token-tint">${kit.options(TINT, tint)}</select>`,
          "A near-black tint makes a silhouette against a bright background."
        ),
        `<div class="oni-event-row-token-color-wrap">${kit.field(
          "Colour",
          `<input type="color" class="oni-event-row-token-color" value="${validColor(row.color)}" />`
        )}</div>`,
        `<div class="oni-event-row-token-tint-fade-wrap">${kit.field(
          "Tint fade (ms)",
          kit.numberInput("oni-event-row-token-tint-fade", fadeMsOf(row.tintFadeMs), { min: 0, max: MAX_FADE_MS, step: 10 }),
          "0 = at once. Otherwise the tint blends over this time, then the row goes on: a silhouette cleared over 1200 ms. Not with Jump away."
        )}</div>`
      );

      const tintEl = body.querySelector(".oni-event-row-token-tint");
      const visibilityEl = body.querySelector(".oni-event-row-token-visibility");
      const sync = () => {
        body.querySelector(".oni-event-row-token-color-wrap").hidden = tintEl.value !== "set";
        body.querySelector(".oni-event-row-token-tint-fade-wrap").hidden = tintEl.value === "keep" || visibilityEl.value === "jump";
        body.querySelector(".oni-event-row-token-jump-wrap").hidden = visibilityEl.value !== "jump";
        body.querySelector(".oni-event-row-token-show-wrap").hidden = visibilityEl.value !== "show";
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
      wait: !!kit.own(rowEl, ".oni-event-row-token-wait")?.checked,
      fadeMs: fadeMsOf(kit.readNumber(rowEl, ".oni-event-row-token-fade", 0)),
      risePx: risePxOf(kit.readNumber(rowEl, ".oni-event-row-token-rise", 0)),
      crouch: !!kit.own(rowEl, ".oni-event-row-token-crouch")?.checked,
      tintFadeMs: fadeMsOf(kit.readNumber(rowEl, ".oni-event-row-token-tint-fade", 0))
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
    ["upLeft", "Up and left"],
    ["towardParty", "Toward the party"],
    ["towardToken", "Toward a named token"]
  ];
  const pickFacing = (value) => (FACINGS.some(([key]) => key === value) ? value : "up");
  const pickFacingTarget = (value) => (FACING_TARGETS.some(([key]) => key === value) ? value : "party");
  const facingApi = () => globalThis.__ONI_SPRITE_FACING_RUNTIME__ ?? null;

  // Toward a point: the eight slices, 0 = right, clockwise on screen (y down).
  const TOWARD_SLICES = ["right", "downRight", "down", "downLeft", "left", "upLeft", "up", "upRight"];
  // Straight up or down keeps the side a token had, so a single picture would
  // not turn at all: past this far to one side, it mirrors that way too.
  const TOWARD_SIDE_PX = 24;

  /** The named direction from a token toward a point dx, dy away, and a side for up or down; null when on top of it. */
  function towardFacing(dx, dy) {
    if (Math.hypot(dx, dy) < 1e-6) return null;
    const direction = TOWARD_SLICES[((Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) % 8) + 8) % 8];
    const upright = direction === "up" || direction === "down";
    const side = upright && Math.abs(dx) > TOWARD_SIDE_PX ? (dx > 0 ? "right" : "left") : null;
    return { direction, side };
  }

  function docCenter(doc) {
    const grid = doc.parent?.grid?.size ?? 100;
    return { x: doc.x + (doc.width * grid) / 2, y: doc.y + (doc.height * grid) / 2 };
  }

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

  // data.turns: [{ tokenId, direction, side }], one per token (a toward row turns
  // each its own way); data.tokenIds + data.direction: all the same way.
  Client.register(KIND_FACING, (data) => {
    const turns = data.turns ?? (data.tokenIds ?? []).map(tokenId => ({ tokenId, direction: data.direction }));
    for (const turn of turns) {
      const token = canvas?.tokens?.get(turn.tokenId);
      if (!token) continue;
      const turned = facingApi()?.setDirection?.(token, turn.direction);
      if (turned && turn.side) facingApi()?.setFacing?.(token, turn.side, { instant: true });
    }
  });

  // Who a toward row turns, and what each looks at. Toward a named token: the
  // name field holds the token looked at, so the party or this event's token turn.
  function towardTurns(row, scene, context, direction) {
    const target = pickFacingTarget(row?.target);
    let lookAt = null;
    let docs = [];
    if (direction === "towardParty") {
      lookAt = scene?.tokens?.get(context?.tokenId) ?? null;
      docs = facingDocs(row, scene, context);
    } else if (target !== "token") {
      lookAt = tokensNamed(scene, namesIn(row?.name)[0])[0] ?? null;
      docs = facingDocs(row, scene, context);
    }
    if (!lookAt) return [];
    const at = docCenter(lookAt);
    return docs.filter(d => d.id !== lookAt.id).map((doc) => {
      const from = docCenter(doc);
      const way = towardFacing(at.x - from.x, at.y - from.y);
      return way ? { doc, ...way } : null;
    }).filter(Boolean);
  }

  function facingWho(row) {
    const target = pickFacingTarget(row?.target);
    if (target === "source") return "this token";
    if (target === "party") return "the party";
    return String(row?.name ?? "").trim() || "(no token)";
  }

  EventRegistry.register({
    type: "setFacing",
    label: "Set Facing",
    category: "Token",
    defaultData: { type: "setFacing", target: "party", name: "", direction: "up" },
    summary: (row) => {
      const direction = pickFacing(row?.direction);
      if (direction === "towardParty") return `${facingWho(row)}: toward the party`;
      if (direction === "towardToken") return `${facingWho(row)}: toward ${namesIn(row?.name)[0] ?? "(no token)"}`;
      return `${facingWho(row)}: ${direction}`;
    },
    execute: async (row, context) => {
      const scene = game.scenes?.get(context?.sceneId) ?? canvas?.scene ?? null;
      const direction = pickFacing(row?.direction);
      const toward = direction === "towardParty" || direction === "towardToken";
      const turns = toward
        ? towardTurns(row, scene, context, direction)
        : facingDocs(row, scene, context).map(doc => ({ doc, direction, side: null }));
      if (!turns.length) {
        console.warn(INSTALL_TAG, "Set Facing: no token to turn (or none to turn toward); passed over.", row);
        return { ok: false, type: "setFacing", reason: "notFound" };
      }

      Client.run(context?.tileId, KIND_FACING, {
        turns: turns.map(t => ({ tokenId: t.doc.id, direction: t.direction, side: t.side }))
      });

      // Saved like the end of a walk, so a reload and a late joiner see it.
      const named = facingApi()?.NAMED_DIRECTIONS ?? {};
      const updates = turns.filter(t => named[t.direction]).map((t) => {
        const update = { _id: t.doc.id, "flags.fabula-ultima-companion.facingDir": named[t.direction].dir };
        const side = named[t.direction].side ?? t.side;
        if (side) update["flags.fabula-ultima-companion.facing"] = side;
        return update;
      });
      if (updates.length) await scene.updateEmbeddedDocuments("Token", updates);

      return { ok: true, type: "setFacing", changed: turns.length };
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
          "Stays after the event. If the character has no art for this direction, the nearest one it has is shown; with no direction art at all, it keeps its image and only mirrors left or right. Toward: worked out when the row runs, from where both stand. Toward a named token is for the party or this event's token: put the token to look at in Token names."
        )
      );

      const targetEl = body.querySelector(".oni-event-row-facing-target");
      const directionEl = body.querySelector(".oni-event-row-facing-direction");
      const sync = () => {
        body.querySelector(".oni-event-row-facing-name-wrap").hidden = targetEl.value !== "token" && directionEl.value !== "towardToken";
      };
      targetEl.addEventListener("change", sync);
      directionEl.addEventListener("change", sync);
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

  // Shared with Jump To (event-rows-jump.js) and the tests.
  window.oni.EventSystem.RowsToken = {
    installed: true,
    SMOKE,
    ggDust,
    dustSize,
    dustPuffs,
    takeHeld,
    towardFacing,
    mixColor
  };
  console.debug(INSTALL_TAG, "Installed.");
})();
