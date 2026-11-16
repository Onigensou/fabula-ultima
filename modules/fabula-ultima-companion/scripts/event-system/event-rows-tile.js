/**
 * [ONI] Event System — Set Tile
 * Foundry VTT v12
 *
 * File:
 * scripts/event-system/event-rows-tile.js
 *
 * What this does:
 * - Registers the "Set Tile" event action: show, hide, fade or swap the picture
 *   of a named tile on this scene, or slice it so its top part falls apart.
 * - Adds a "Tile name" box to the Tile Config window (Basic tab). Tiles have no
 *   names of their own; this one is saved as flags.fabula-ultima-companion.tileName
 *   and is what the row looks for. A row can list several, separated by commas.
 *
 * How it fits together:
 * - A GM writes the tile document; every client sees it through Foundry, so the
 *   change stays after the event, as Set Token's does. A name with no tile is
 *   reported to the GM and the rest of the row and the event carry on.
 * - A fade is drawn by every client on the tile's own mesh, then the document is
 *   written so it stays: Show writes first (the fade starts from nothing), Hide
 *   and Opacity write when the fade is over.
 * - Slice: every client plays the break on its own (the random sways differ a
 *   little per screen). The pieces are copies of the tile's picture, each masked
 *   to its polygon, drawn in the map's own order at the tile's place, so a token
 *   behind the tile stays behind its pieces. The real tile is not drawn while
 *   they play.
 * - The broken result is saved on the tile: flags.fabula-ultima-companion.slice
 *   = { cuts, keepBelow }. Whenever a tile is drawn or refreshed on any client,
 *   a tile with that flag is masked to the pieces that stayed, so it survives a
 *   reload, a late joiner and the save system (which snapshots tile documents).
 *   Show with "restore whole", or a picture swap, clears it.
 * - The cut geometry is plain calculation, kept apart in TileSlice so it can be
 *   tested without a game (tile-slice.test.mjs).
 *
 * Requires:
 * - event-logic.js, event-eventRegistry.js, event-client.js, event-flow.js
 */

(() => {
  const INSTALL_TAG = "[ONI][EventSystem][RowsTile]";
  const MODULE_ID = "fabula-ultima-companion";

  window.oni = window.oni || {};
  window.oni.EventSystem = window.oni.EventSystem || {};

  // ------------------------------------------------------------
  // Slice geometry (pure; no Foundry)
  // ------------------------------------------------------------
  // Tile-local map px: (0, 0) is the tile's top-left, y goes down.
  const DEFAULT_KEEP_BELOW = 0.62;

  const finite = (v) => Number.isFinite(Number(v)) && String(v).trim() !== "";

  // One cut per line, "angleDeg, offsetPx". Also takes a saved array of
  // { angleDeg, offsetPx } or [angle, offset]. Lines that don't read are skipped.
  function parseCuts(raw) {
    const out = [];
    const push = (a, o) => {
      if (finite(a) && finite(o)) out.push({ angleDeg: Number(a), offsetPx: Number(o) });
    };
    if (Array.isArray(raw)) {
      for (const c of raw) {
        if (Array.isArray(c)) push(c[0], c[1]);
        else if (c && typeof c === "object") push(c.angleDeg, c.offsetPx);
        else if (typeof c === "string") out.push(...parseCuts(c));
      }
      return out;
    }
    for (const line of String(raw ?? "").split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s.startsWith("#")) continue;
      const parts = s.split(/[\s,;]+/).filter(Boolean);
      if (parts.length >= 2) push(parts[0], parts[1]);
    }
    return out;
  }

  // Lines of the cut box that do not read as two numbers.
  function badCutLines(text) {
    return String(text ?? "").split(/\r?\n/).map(l => l.trim())
      .filter(l => l && !l.startsWith("#") && !parseCuts(l).length);
  }

  const formatCuts = (cuts) => parseCuts(cuts).map(c => `${c.angleDeg}, ${c.offsetPx}`).join("\n");

  function clampKeepBelow(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || String(v ?? "").trim() === "") return DEFAULT_KEEP_BELOW;
    return Math.min(1, Math.max(0, n));
  }

  // A cut: a line through the tile's centre at angleDeg (0 = horizontal, screen
  // degrees, y down), moved offsetPx along the line's direction turned +90°.
  function cutLine(cut, w, h) {
    const a = (Number(cut.angleDeg) || 0) * Math.PI / 180;
    const dx = Math.cos(a), dy = Math.sin(a);
    const nx = -dy, ny = dx;
    const off = Number(cut.offsetPx) || 0;
    return { px: (w / 2) + (nx * off), py: (h / 2) + (ny * off), dx, dy };
  }

  // Splits a convex polygon ([[x, y], ...]) by a line; returns the pieces with
  // at least three corners (one, or two when the line crosses it).
  function splitPoly(poly, { px, py, dx, dy }) {
    const side = (p) => ((p[0] - px) * dy) - ((p[1] - py) * dx);
    const A = [], B = [];
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length], sp = side(p), sq = side(q);
      (sp >= 0 ? A : B).push(p);
      if ((sp >= 0) !== (sq >= 0)) {
        const t = sp / (sp - sq);
        const m = [p[0] + ((q[0] - p[0]) * t), p[1] + ((q[1] - p[1]) * t)];
        A.push(m);
        B.push(m);
      }
    }
    return [A, B].filter(x => x.length >= 3);
  }

  // Every piece of a w x h tile after all cuts, with its centre (the corners'
  // average, as in the approved mockup).
  function slicePieces(w, h, cuts) {
    let polys = [[[0, 0], [w, 0], [w, h], [0, h]]];
    for (const c of parseCuts(cuts)) {
      const line = cutLine(c, w, h);
      const next = [];
      for (const p of polys) next.push(...splitPoly(p, line));
      polys = next;
    }
    return polys.map(poly => ({
      poly,
      cx: poly.reduce((s, p) => s + p[0], 0) / poly.length,
      cy: poly.reduce((s, p) => s + p[1], 0) / poly.length
    }));
  }

  // keep: the piece's centre is below keepBelow of the height (from the top).
  function classifyPieces(w, h, slice) {
    const line = h * clampKeepBelow(slice?.keepBelow);
    return slicePieces(w, h, slice?.cuts).map(p => ({ ...p, keep: p.cy > line }));
  }

  const keptPolygons = (w, h, slice) => classifyPieces(w, h, slice).filter(p => p.keep).map(p => p.poly);

  // The saved flag, cleaned; null when there is nothing to cut.
  function normalizeSlice(raw) {
    if (!raw || typeof raw !== "object") return null;
    const cuts = parseCuts(raw.cuts);
    if (!cuts.length) return null;
    return { cuts, keepBelow: clampKeepBelow(raw.keepBelow) };
  }

  const TileSlice = {
    DEFAULT_KEEP_BELOW, parseCuts, badCutLines, formatCuts, clampKeepBelow,
    cutLine, splitPoly, slicePieces, classifyPieces, keptPolygons, normalizeSlice
  };
  window.oni.EventSystem.TileSlice = TileSlice;

  // ------------------------------------------------------------
  // Everything below needs the game
  // ------------------------------------------------------------
  if (window.oni.EventSystem.RowsTile?.installed) {
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

  const KIND_FADE = "tile.fade";
  const KIND_SLICE = "tile.slice";
  const FLAG_NAME = `flags.${MODULE_ID}.tileName`;
  const FLAG_SLICE_DELETE = `flags.${MODULE_ID}.-=slice`;

  const ACTIONS = [
    ["show", "Show"],
    ["hide", "Hide"],
    ["opacity", "Change opacity"],
    ["image", "Change picture"],
    ["slice", "Slice (the top falls apart)"]
  ];
  const pickAction = (value) => (ACTIONS.some(([key]) => key === value) ? value : "show");

  const MAX_FADE_MS = 30000;
  const DEFAULT_WAIT_MS = 380;
  const clampMs = (v, fallback = 0) => Math.min(MAX_FADE_MS, Math.max(0, Math.round(Logic.toNumber(v, fallback))));
  const clamp01 = (v, fallback = 1) => Math.min(1, Math.max(0, Logic.toNumber(v, fallback)));

  // The approved break (mockup breakStatue, slice branch).
  const SLICE = {
    edge: 0.9,
    keepMs: 400,
    delayMs: [0, 140],
    slideMs: 520,
    slideX: [18, 40],
    slideY: [8, 20],
    slideRot: [0.02, 0.08],
    fallMs: 650,
    fallX: [30, 70],
    fallRot: [0.3, 0.9],
    // The document is written once every screen has started its pieces.
    persistDelayMs: 250
  };
  const SLICE_TOTAL_MS = SLICE.delayMs[1] + SLICE.slideMs + SLICE.fallMs;
  const DUST_COLOR = 0xb0a4c8;

  const namesIn = (raw) => String(raw ?? "").split(",").map(s => s.trim()).filter(Boolean);
  const tileNameOf = (doc) => String(doc?.flags?.[MODULE_ID]?.tileName ?? "").trim();

  function tilesNamed(scene, name) {
    const wanted = String(name ?? "").trim().toLowerCase();
    if (!wanted) return [];
    return (scene?.tiles?.contents ?? []).filter(t => tileNameOf(t).toLowerCase() === wanted);
  }

  const mix = (a, b, t) => a + ((b - a) * t);
  const easeIn = (t) => t * t * t;
  const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - (Math.pow((-2 * t) + 2, 2) / 2));

  // Same numbers for one tile on one screen, from the row's seed.
  function seeded(seed) {
    let a = (seed >>> 0) || 1;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const hashString = (s) => [...String(s)].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0, 7);

  // A Graphics that sorts in the map's order. Foundry 12.343 exports the mixin,
  // not a ready PrimaryGraphics class (same as pose-bath-fx.js).
  let DustGraphics = null;
  function dustClass() {
    if (DustGraphics) return DustGraphics;
    const Mixin = globalThis.PrimaryCanvasObjectMixin;
    const Ready = globalThis.PrimaryGraphics ?? foundry.canvas?.primary?.PrimaryGraphics;
    DustGraphics = Ready ?? (Mixin ? class extends Mixin(PIXI.Graphics) {} : PIXI.Graphics);
    return DustGraphics;
  }

  // A tile-local point (map px from the tile's top-left) in the mesh's own
  // coordinates. The mesh is drawn centred on its anchor at texture size and
  // scaled to the tile, so a child of the mesh follows its size, mirror and
  // rotation. Assumes the picture fills the tile (Foundry's default fit).
  function meshLocal(mesh, w, h, x, y) {
    const tex = mesh.texture;
    const tw = tex?.orig?.width ?? tex?.width ?? w;
    const th = tex?.orig?.height ?? tex?.height ?? h;
    return [((x / w) - mesh.anchor.x) * tw, ((y / h) - mesh.anchor.y) * th];
  }

  const flatLocal = (mesh, w, h, poly) => poly.flatMap(p => meshLocal(mesh, w, h, p[0], p[1]));

  // ------------------------------------------------------------
  // The saved break: mask the real tile on every client
  // ------------------------------------------------------------
  function clearMask(mesh) {
    const g = mesh._oniSliceMask;
    if (!g) return;
    if (mesh.mask === g) mesh.mask = null;
    try { g.destroy(); } catch (_) {}
    mesh._oniSliceMask = null;
  }

  function applySliceMask(tile, override = null) {
    try {
      const mesh = tile?.mesh;
      if (!mesh || mesh.destroyed) return;
      const doc = tile.document;
      const slice = normalizeSlice(doc?.flags?.[MODULE_ID]?.slice) ?? normalizeSlice(override);
      const tex = mesh.texture;
      const key = slice
        ? JSON.stringify([slice, doc.width, doc.height, tex?.orig?.width ?? tex?.width, tex?.orig?.height ?? tex?.height, mesh.anchor.x, mesh.anchor.y])
        : "";
      if ((mesh._oniSliceKey ?? "") === key && (!key || mesh._oniSliceMask)) return;

      clearMask(mesh);
      mesh._oniSliceKey = key;
      if (!slice) return;

      const g = new PIXI.Graphics();
      g.beginFill(0xffffff, 1);
      const kept = keptPolygons(doc.width, doc.height, slice);
      for (const poly of kept) g.drawPolygon(flatLocal(mesh, doc.width, doc.height, poly));
      // Everything fell: a mask with no shape would show the whole tile.
      if (!kept.length) g.drawRect(0, 0, 0.0001, 0.0001);
      g.endFill();
      mesh.addChild(g);
      mesh.mask = g;
      mesh._oniSliceMask = g;
    } catch (e) {
      console.warn(INSTALL_TAG, "Could not mask a sliced tile.", e);
    }
  }

  Hooks.on("drawTile", (tile) => applySliceMask(tile));
  Hooks.on("refreshTile", (tile) => applySliceMask(tile));
  Hooks.on("updateTile", (doc, changes) => {
    if (changes?.flags?.[MODULE_ID] === undefined) return;
    if (doc?.parent?.id !== canvas?.scene?.id) return;
    applySliceMask(doc.object);
  });

  // ------------------------------------------------------------
  // Fades (every client)
  // ------------------------------------------------------------
  // Drives the mesh alpha a little before Foundry draws the frame, so a refresh
  // in between doesn't flash the old value. When it ends, the tile is refreshed
  // and Foundry's own value takes over: at once for a fade in (the document is
  // already shown), or when the document arrives for a fade out or an opacity.
  const FADE_PRIORITY = -1;
  const HOLD_MAX_MS = 2500;
  const fades = new Map();   // tileId -> { stop, release }

  function fadeTile(tileId, { mode = "out", alpha = 1, ms = 0 } = {}) {
    fades.get(tileId)?.stop?.();
    const first = canvas?.tiles?.get(tileId);
    if (!first?.mesh || document.visibilityState === "hidden") return;

    const from = mode === "in" ? 0 : first.mesh.alpha;
    const docAlpha = Math.max(0.01, Number(first.document.alpha) || 1);
    const target = () => {
      if (mode === "in") return Number(canvas.tiles.get(tileId)?.document?.alpha ?? 1);
      if (mode === "out") return 0;
      return from * (clamp01(alpha) / docAlpha);
    };

    const ticker = canvas.app.ticker;
    const startedAt = performance.now();
    let doneAt = 0;
    let released = false;
    const stop = (refresh = true) => {
      ticker.remove(tick);
      if (fades.get(tileId)?.stop === stop) fades.delete(tileId);
      if (refresh) canvas?.tiles?.get(tileId)?.renderFlags?.set?.({ refresh: true });
    };
    const tick = () => {
      try {
        const mesh = canvas?.tiles?.get(tileId)?.mesh;
        if (!mesh || mesh.destroyed) return stop(false);
        const now = performance.now();
        const t = ms > 0 ? Math.min(1, (now - startedAt) / ms) : 1;
        mesh.alpha = mix(from, target(), t);
        if (t < 1) return;
        if (!doneAt) doneAt = now;
        if (mode === "in" || released || now - doneAt > HOLD_MAX_MS) stop(true);
      } catch (e) {
        console.warn(INSTALL_TAG, "Fade frame failed; dropping the effect.", e);
        stop(true);
      }
    };
    fades.set(tileId, { stop, release: () => { released = true; } });
    ticker.add(tick, null, FADE_PRIORITY);
  }

  // The document arrived: a finished fade hands the alpha back to Foundry.
  Hooks.on("updateTile", (doc, changes) => {
    if (!("hidden" in (changes ?? {})) && !("alpha" in (changes ?? {}))) return;
    fades.get(doc?.id)?.release?.();
  });

  Client.register(KIND_FADE, (data) => {
    for (const id of data.tileIds ?? []) fadeTile(id, { mode: data.mode, alpha: data.alpha, ms: clampMs(data.ms) });
  });

  // ------------------------------------------------------------
  // Slice (every client)
  // ------------------------------------------------------------
  const running = new Set();   // stop functions of breaks in progress

  function makePiece(mesh) {
    const Cls = globalThis.PrimarySpriteMesh;
    const sprite = Cls ? new Cls({ texture: mesh.texture, name: "oniTileSlicePiece" }) : new PIXI.Sprite(mesh.texture);
    sprite.anchor.set(mesh.anchor.x, mesh.anchor.y);
    sprite.scale.set(mesh.scale.x, mesh.scale.y);
    sprite.tint = mesh.tint;
    sprite.blendMode = mesh.blendMode;
    sprite.elevation = mesh.elevation ?? 0;
    sprite.sortLayer = mesh.sortLayer ?? 0;
    sprite.sort = mesh.sort ?? 0;
    return sprite;
  }

  function playSlice(tileId, slice, seed) {
    if (document.visibilityState === "hidden") return;
    const tile = canvas?.tiles?.get(tileId);
    const mesh = tile?.mesh;
    const host = canvas?.primary;
    if (!tile || !host || !mesh || mesh.destroyed || !mesh.texture?.valid || !mesh.visible) return;

    const doc = tile.document;
    const w = doc.width, h = doc.height;
    const rnd = seeded((seed >>> 0) ^ hashString(tileId));
    const r = ([a, b]) => mix(a, b, rnd());
    const world = (x, y) => {
      const [lx, ly] = meshLocal(mesh, w, h, x, y);
      return host.toLocal(new PIXI.Point(lx, ly), mesh);
    };
    const centre = world(w / 2, h / 2);
    const baseY = Math.max(...[[0, 0], [w, 0], [w, h], [0, h]].map(([x, y]) => world(x, y).y));
    const baseAlpha = mesh.alpha;
    const edgeWidth = 2 / Math.max(0.0001, Math.abs(mesh.scale.x));

    // Dust: soft rising puffs (mockup dustBurst).
    const dust = new (dustClass())();
    dust.elevation = mesh.elevation ?? 0;
    dust.sortLayer = mesh.sortLayer ?? 0;
    dust.sort = (mesh.sort ?? 0) + 1;
    host.addChild(dust);
    const puffs = [];
    const burst = (x, y, n, spread) => {
      const t0 = performance.now();
      for (let i = 0; i < n; i++) {
        const a = mix(Math.PI, Math.PI * 2, rnd()), sp = mix(0.3, 1, rnd()) * spread;
        puffs.push({
          x: x + mix(-spread * 0.2, spread * 0.2, rnd()), y: y + mix(-6, 6, rnd()),
          vx: Math.cos(a) * sp * 1.6, vy: Math.sin(a) * sp * 0.55,
          r: mix(10, 26, rnd()) * spread / 90, life: mix(700, 1300, rnd()), t0
        });
      }
    };

    const pieces = classifyPieces(w, h, slice).map(p => {
      const sprite = makePiece(mesh);
      const local = flatLocal(mesh, w, h, p.poly);
      const mask = new PIXI.Graphics();
      mask.beginFill(0xffffff, 1).drawPolygon(local).endFill();
      sprite.addChild(mask);
      sprite.mask = mask;
      const edge = new PIXI.Graphics();
      edge.lineStyle({ width: edgeWidth, color: 0xffffff, alpha: 1 }).drawPolygon(local);
      sprite.addChild(edge);

      const [pvx, pvy] = meshLocal(mesh, w, h, p.cx, p.cy);
      sprite.pivot.set(pvx, pvy);
      const at = world(p.cx, p.cy);
      host.addChild(sprite);

      const piece = { sprite, edge, at, keep: p.keep, dusted: 0 };
      if (p.keep) {
        piece.settle = { ox: r([-4, 4]), oy: r([0, 3]) };
      } else {
        const dir = at.x < centre.x ? -1 : 1;
        piece.delay = r(SLICE.delayMs);
        piece.slide = { ox: dir * r(SLICE.slideX), oy: r(SLICE.slideY), rot: dir * r(SLICE.slideRot) };
        piece.fall = {
          ox: piece.slide.ox + (dir * r(SLICE.fallX)),
          oy: (baseY - at.y) + r([-30, 0]),
          rot: dir * r(SLICE.fallRot)
        };
      }
      return piece;
    });
    mesh.renderable = false;
    burst(centre.x, baseY - 20, 20, 120);

    const state = (p, t) => {
      if (p.keep) {
        const e = easeInOut(Math.min(1, t / SLICE.keepMs));
        return { ox: p.settle.ox * e, oy: p.settle.oy * e, rot: 0, alpha: 1, edge: mix(SLICE.edge, 0, e) };
      }
      const t1 = t - p.delay;
      if (t1 < 0) return { ox: 0, oy: 0, rot: 0, alpha: 1, edge: SLICE.edge };
      if (t1 < SLICE.slideMs) {
        const e = easeIn(t1 / SLICE.slideMs);
        return { ox: p.slide.ox * e, oy: p.slide.oy * e, rot: p.slide.rot * e, alpha: 1, edge: mix(SLICE.edge, 0.3, e) };
      }
      if (p.dusted === 0) {
        p.dusted = 1;
        burst(p.at.x + p.slide.ox, p.at.y + 30, 6, 70);
      }
      const e = easeIn(Math.min(1, (t1 - SLICE.slideMs) / SLICE.fallMs));
      if (e >= 1 && p.dusted === 1) {
        p.dusted = 2;
        burst(p.at.x + p.fall.ox, baseY - 10, 8, 90);
      }
      return {
        ox: mix(p.slide.ox, p.fall.ox, e), oy: mix(p.slide.oy, p.fall.oy, e),
        rot: mix(p.slide.rot, p.fall.rot, e), alpha: 1 - e, edge: mix(0.3, 0, e)
      };
    };

    const ticker = canvas.app.ticker;
    const startedAt = performance.now();
    const baseRotation = mesh.rotation;
    let piecesGone = false;
    const dropPieces = () => {
      if (piecesGone) return;
      piecesGone = true;
      for (const p of pieces) if (!p.sprite.destroyed) p.sprite.destroy({ children: true });
      // The real tile comes back masked to what stayed, flag or not yet.
      const now = canvas?.tiles?.get(tileId);
      if (now?.mesh && !now.mesh.destroyed) {
        applySliceMask(now, slice);
        now.mesh.renderable = true;
      }
    };
    const finish = () => {
      ticker.remove(tick);
      running.delete(finish);
      dropPieces();
      if (!dust.destroyed) dust.destroy();
    };
    const tick = () => {
      try {
        const now = performance.now();
        const t = now - startedAt;
        if (!piecesGone) {
          if (pieces.some(p => p.sprite.destroyed || !p.sprite.parent)) return finish();
          for (const p of pieces) {
            const s = state(p, t);
            p.sprite.position.set(p.at.x + s.ox, p.at.y + s.oy);
            p.sprite.rotation = baseRotation + s.rot;
            p.sprite.alpha = baseAlpha * s.alpha;
            p.edge.alpha = s.edge;
          }
          if (t >= SLICE_TOTAL_MS) dropPieces();
        }

        if (dust.destroyed) return finish();
        dust.clear();
        for (let i = puffs.length - 1; i >= 0; i--) {
          const d = puffs[i], u = (now - d.t0) / d.life;
          if (u >= 1) { puffs.splice(i, 1); continue; }
          const k = (u * d.life / 1000) * 60;
          dust.beginFill(DUST_COLOR, 0.5 * (1 - u)).drawCircle(d.x + (d.vx * k), d.y + (d.vy * k), d.r * (1 + (u * 1.6))).endFill();
        }
        if (piecesGone && !puffs.length) finish();
      } catch (e) {
        console.warn(INSTALL_TAG, "Slice frame failed; dropping the effect.", e);
        finish();
      }
    };
    running.add(finish);
    ticker.add(tick);
  }

  Client.register(KIND_SLICE, (data) => {
    const slice = normalizeSlice(data.slice);
    if (!slice) return;
    for (const id of data.tileIds ?? []) playSlice(id, slice, Number(data.seed) || 1);
  });

  Hooks.on("canvasTearDown", () => {
    for (const finish of [...running]) { try { finish(); } catch (_) {} }
    for (const { stop } of [...fades.values()]) { try { stop(false); } catch (_) {} }
  });

  // ------------------------------------------------------------
  // Tile Config: the name box
  // ------------------------------------------------------------
  Hooks.on("renderTileConfig", (app, html) => {
    try {
      const root = html?.[0] ?? html;
      const doc = app?.document ?? app?.object;
      if (!root?.querySelector || root.querySelector(".oni-tile-name-group")) return;
      const panel = root.querySelector('.tab[data-tab="basic"]') ?? root.querySelector(".tab[data-tab]") ?? root.querySelector("form");
      if (!panel) return;
      const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
      const group = document.createElement("div");
      group.className = "form-group oni-tile-name-group";
      group.innerHTML = `
        <label>Tile name</label>
        <div class="form-fields">
          <input type="text" name="${FLAG_NAME}" value="${esc(tileNameOf(doc))}" placeholder="For events: Set Tile finds it by this name" />
        </div>
        <p class="hint">Events find this tile by its name (Set Tile). Several tiles can share one name; they change together.</p>`;
      panel.prepend(group);
      app.setPosition?.({ height: "auto" });
    } catch (e) {
      console.warn(INSTALL_TAG, "Could not add the Tile name box.", e);
    }
  });

  // ------------------------------------------------------------
  // The row
  // ------------------------------------------------------------
  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  EventRegistry.register({
    type: "setTile",
    label: "Set Tile",
    category: "Token",
    defaultData: {
      type: "setTile", name: "", action: "show", alpha: 1, src: "", fadeMs: 0, restore: false,
      cuts: [], keepBelow: DEFAULT_KEEP_BELOW, waitMs: DEFAULT_WAIT_MS, wait: true
    },
    prepare: (row) => {
      row.action = pickAction(row.action);
      row.cuts = parseCuts(row.cuts);
      row.keepBelow = clampKeepBelow(row.keepBelow);
    },
    summary: (row) => {
      const who = String(row?.name ?? "").trim() || "(no tile)";
      const action = pickAction(row?.action);
      const fade = clampMs(row?.fadeMs) > 0 ? `, fade ${clampMs(row.fadeMs) / 1000} s` : "";
      if (action === "opacity") return `${who}, opacity ${clamp01(row?.alpha)}${fade}`;
      if (action === "image") return `${who}, picture ${String(row?.src ?? "").split("/").pop() || "(none)"}`;
      if (action === "slice") return `${who}, slice (${parseCuts(row?.cuts).length} cuts)`;
      return `${who}, ${action}${action === "show" && row?.restore === true ? " whole" : ""}${fade}`;
    },
    execute: async (row, context) => {
      const scene = game.scenes?.get(context?.sceneId) ?? canvas?.scene ?? null;
      const names = namesIn(row?.name);
      const found = [...new Set(names.flatMap(n => tilesNamed(scene, n)))];
      const missing = names.filter(n => !tilesNamed(scene, n).length);
      if (missing.length) {
        console.warn(INSTALL_TAG, "Set Tile: no tile by that name on this scene.", missing);
        ui.notifications?.warn?.(`Event: no tile named ${missing.join(", ")} on this scene. That part was skipped.`);
      }
      if (!found.length) return { ok: false, type: "setTile", reason: "notFound" };

      const sourceId = context?.tileId;
      const Flow = window.oni.EventSystem.Flow;
      const wait = row?.wait !== false;
      const action = pickAction(row?.action);
      const fadeMs = clampMs(row?.fadeMs);
      const update = (docs, change) => (docs.length
        ? scene.updateEmbeddedDocuments("Tile", docs.map(t => ({ _id: t.id, ...change })))
        : Promise.resolve());
      // The document is written when the fade ends, even if the event is ended early.
      const afterFade = async (docs, change) => {
        if (fadeMs > 0) await Flow?.wait?.(sourceId, fadeMs);
        await update(docs, change);
      };
      const done = { ok: true, type: "setTile", changed: found.length };

      if (action === "show") {
        const change = { hidden: false };
        if (row?.restore === true) change[FLAG_SLICE_DELETE] = null;
        const hidden = found.filter(t => t.hidden);
        if (fadeMs > 0 && hidden.length) Client.run(sourceId, KIND_FADE, { tileIds: hidden.map(t => t.id), mode: "in", ms: fadeMs });
        await update(found, change);
        if (fadeMs > 0 && hidden.length && wait) await Flow?.wait?.(sourceId, fadeMs);
        return done;
      }

      if (action === "hide" || action === "opacity") {
        const change = action === "hide" ? { hidden: true } : { alpha: clamp01(row?.alpha) };
        const fading = action === "hide" ? found.filter(t => !t.hidden) : found;
        if (fadeMs > 0 && fading.length) {
          Client.run(sourceId, KIND_FADE, { tileIds: fading.map(t => t.id), mode: action === "hide" ? "out" : "to", alpha: change.alpha, ms: fadeMs });
        }
        const writing = afterFade(found, change);
        if (wait) await writing;
        else writing.catch(e => console.warn(INSTALL_TAG, "Set Tile: could not save the tile.", e));
        return done;
      }

      if (action === "image") {
        const src = String(row?.src ?? "").trim();
        if (!src) {
          ui.notifications?.warn?.("Event: Set Tile has no picture to change to. That row was skipped.");
          return { ok: false, type: "setTile", reason: "noImage" };
        }
        await update(found, { "texture.src": src, [FLAG_SLICE_DELETE]: null });
        return done;
      }

      // slice
      const slice = normalizeSlice({ cuts: row?.cuts, keepBelow: row?.keepBelow });
      if (!slice) {
        ui.notifications?.warn?.("Event: Set Tile slice has no cuts. That row was skipped.");
        return { ok: false, type: "setTile", reason: "noCuts" };
      }
      Client.run(sourceId, KIND_SLICE, {
        tileIds: found.filter(t => !t.hidden).map(t => t.id),
        slice,
        seed: Math.floor(Math.random() * 0x7fffffff) + 1
      });
      // Saved right after every screen has started its pieces, so a reload or a
      // save mid-fall already has the broken tile.
      const saving = sleep(SLICE.persistDelayMs)
        .then(() => update(found, { [`flags.${MODULE_ID}.slice`]: slice }))
        .catch(e => console.warn(INSTALL_TAG, "Set Tile: could not save the slice.", e));
      if (wait) {
        await Flow?.wait?.(sourceId, clampMs(row?.waitMs, DEFAULT_WAIT_MS));
        await saving;
      }
      return done;
    },
    buildFields: (row, kit) => {
      const action = pickAction(row.action);
      const seconds = (ms) => Math.round(clampMs(ms) / 10) / 100;
      const body = kit.fields(
        kit.field(
          "Tile names",
          `<input type="text" class="oni-event-row-tile-name" value="${kit.escapeHTML(row.name ?? "")}" placeholder="Names of tiles on this scene, separated by commas" />`,
          "Name a tile in its Tile Config (Basic tab, Tile name). All of them change at the same moment. Hidden tiles can be named. A name with no tile is skipped with a warning to the GM."
        ),
        kit.field(
          "Action",
          `<select class="oni-event-row-tile-action">${kit.options(ACTIONS, action)}</select>`,
          "Stays after the event ends. Leave tiles how the next visitor should find them."
        ),
        `<div class="oni-event-row-tile-alpha-wrap">${kit.field(
          "Opacity",
          kit.numberInput("oni-event-row-tile-alpha", clamp01(row.alpha), { min: 0, max: 1, step: 0.05 }),
          "0 is invisible, 1 is solid."
        )}</div>`,
        `<div class="oni-event-row-tile-src-wrap">${kit.field(
          "Picture",
          kit.fileInput("oni-event-row-tile-src", row.src ?? "", "imagevideo", "The new picture"),
          "Swaps at once. A sliced tile comes back whole with its new picture."
        )}</div>`,
        `<div class="oni-event-row-tile-fade-wrap">${kit.field(
          "Fade (seconds)",
          kit.numberInput("oni-event-row-tile-fade", seconds(row.fadeMs), { min: 0, max: MAX_FADE_MS / 1000, step: 0.1 }),
          "0 is at once."
        )}</div>`,
        `<div class="oni-event-row-tile-restore-wrap">${kit.field(
          "Restore whole",
          `<label><input type="checkbox" class="oni-event-row-tile-restore" ${row.restore === true ? "checked" : ""} /> mend a sliced tile</label>`
        )}</div>`,
        `<div class="oni-event-row-tile-slice-wrap">${kit.field(
          "Cuts",
          `<textarea class="oni-event-textarea oni-event-row-tile-cuts" rows="4" placeholder="One per line: angle, offset (e.g. -14.33, -34.1)">${kit.escapeHTML(formatCuts(row.cuts))}</textarea>`,
          "Each cut is a straight line through the tile's centre: angle in degrees (0 is level, positive turns clockwise), then how many map pixels it is moved sideways from the centre."
        )}${kit.field(
          "Keep below",
          kit.numberInput("oni-event-row-tile-keep", clampKeepBelow(row.keepBelow), { min: 0, max: 1, step: 0.01 }),
          "Pieces whose middle is lower than this share of the tile's height (from its top) stay; the rest slide apart and fall. The broken tile is saved: it stays broken after a reload."
        )}${kit.field(
          "Next row after (seconds)",
          kit.numberInput("oni-event-row-tile-waitms", seconds(row.waitMs ?? DEFAULT_WAIT_MS), { min: 0, max: 5, step: 0.01 }),
          "With wait on, the next row starts this long after the cut, while the pieces still fall."
        )}</div>`,
        `<div class="oni-event-row-tile-wait-wrap">${kit.field(
          "Wait",
          `<label><input type="checkbox" class="oni-event-row-tile-wait" ${row.wait !== false ? "checked" : ""} /> wait for it</label>`
        )}</div>`
      );

      const actionEl = body.querySelector(".oni-event-row-tile-action");
      const sync = () => {
        const a = actionEl.value;
        body.querySelector(".oni-event-row-tile-alpha-wrap").hidden = a !== "opacity";
        body.querySelector(".oni-event-row-tile-src-wrap").hidden = a !== "image";
        body.querySelector(".oni-event-row-tile-fade-wrap").hidden = !["show", "hide", "opacity"].includes(a);
        body.querySelector(".oni-event-row-tile-restore-wrap").hidden = a !== "show";
        body.querySelector(".oni-event-row-tile-slice-wrap").hidden = a !== "slice";
        body.querySelector(".oni-event-row-tile-wait-wrap").hidden = a === "image";
      };
      actionEl.addEventListener("change", sync);
      sync();

      return body;
    },
    collectFields: (rowEl, kit) => ({
      name: kit.readText(rowEl, ".oni-event-row-tile-name", "").trim(),
      action: pickAction(kit.readText(rowEl, ".oni-event-row-tile-action", "show")),
      alpha: clamp01(kit.readNumber(rowEl, ".oni-event-row-tile-alpha", 1)),
      src: kit.readText(rowEl, ".oni-event-row-tile-src", "").trim(),
      fadeMs: clampMs(kit.readNumber(rowEl, ".oni-event-row-tile-fade", 0) * 1000),
      restore: !!kit.own(rowEl, ".oni-event-row-tile-restore")?.checked,
      cuts: parseCuts(kit.readText(rowEl, ".oni-event-row-tile-cuts", "")),
      keepBelow: clampKeepBelow(kit.readText(rowEl, ".oni-event-row-tile-keep", String(DEFAULT_KEEP_BELOW))),
      waitMs: clampMs(kit.readNumber(rowEl, ".oni-event-row-tile-waitms", DEFAULT_WAIT_MS / 1000) * 1000, DEFAULT_WAIT_MS),
      wait: !!kit.own(rowEl, ".oni-event-row-tile-wait")?.checked
    })
  });

  window.oni.EventSystem.RowsTile = { installed: true, tilesNamed, tileNameOf, applySliceMask };
  console.debug(INSTALL_TAG, "Installed.");
})();
