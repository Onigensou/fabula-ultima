/**
 * [ONI] Event System — Jump To
 * Foundry VTT v12
 *
 * File:
 * scripts/event-system/event-rows-jump.js
 *
 * What this does:
 * - Registers the "Jump To" event action: the party (or a named token) jumps
 *   from point to point along a path of marker tokens, like the stone jumps of
 *   a JRPG. Each hop: a slight squeeze down, a leap on an arc holding one stride
 *   frame of the walk art, a squash on landing. Maelstrom Confluence's
 *   stepping stones are its first use.
 * - Exposes the jump on window.oni.EventSystem.Jump, so a Run Code row
 *   (event-rows-code.js) jumps exactly the same way.
 *
 * How it fits together:
 * - The GM runs the row and paces it with Flow.wait. At each landing the GM
 *   moves the real token at once (animate off, no pan), so the token, the
 *   follow camera and late joiners all agree on where the party stands.
 * - Every client plays the arc on a copy of the sprite among the tokens
 *   (event-worldFx.js order), the way Set Token's jump does: the real mesh is
 *   hidden for the hop, so nothing fights the idle bounce or the depth system.
 *   The copy grows or shrinks by the depth factor of the two ends.
 * - A path line is a marker token's name (a hidden one works) or "x, y".
 *   Markers sit on the stones; the last line is where the party lands.
 * - Bobbing stones (map-system/tile-bob.js) dip when a foot lands on them.
 *
 * Requires:
 * - event-logic.js, event-eventRegistry.js, event-client.js, event-flow.js,
 *   event-worldFx.js; uses sprite-facing-runtime.js and depth-index.js when present
 */

(() => {
  const INSTALL_TAG = "[ONI][EventSystem][RowsJump]";

  window.oni = window.oni || {};
  window.oni.EventSystem = window.oni.EventSystem || {};

  if (window.oni.EventSystem.RowsJump?.installed) {
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

  const KIND_HOP = "jump.hop";

  // One hop, in ms and map px. The squeeze and the squash are deliberately small:
  // anticipation, not a cartoon. The user tuned these in the Maelstrom mockup.
  const HOP = {
    crouchMs: 260,
    holdMs: 70,
    landMs: 190,
    crouch: { x: 1.05, y: 0.92 },
    reach: { x: 0.93, y: 1.09 },   // stretched leaving the ground
    fall: { x: 0.95, y: 1.07 },    // reaching down for the landing
    land: { x: 0.2, y: 0.22 },     // the landing squash, peak added to 1 / taken from 1
    // Arc height by hop length, before the row's arc %.
    arc: (dist) => Math.min(130, Math.max(34, 26 + dist * 0.4)),
    // Flight time by hop length, around the row's time per hop (set at 110 px).
    flight: (ms, dist) => ms * Math.min(1.35, Math.max(0.8, dist / 110)),
    // A late token update: keep the real token hidden until it is where it landed.
    settleMs: 1500
  };

  const DEFAULT_TAKEOFF = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/SE_JUMPLANDA.wav";

  const TARGETS = [
    ["party", "The party"],
    ["token", "A named token"]
  ];
  const pickTarget = (value) => (TARGETS.some(([key]) => key === value) ? value : "party");
  const clamp = (v, lo, hi, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
  };
  const mix = (a, b, t) => a + (b - a) * Math.min(1, Math.max(0, t));

  const flow = () => window.oni.EventSystem.Flow;
  const facingApi = () => globalThis.__ONI_SPRITE_FACING_RUNTIME__ ?? null;
  const depthApi = () => globalThis.__ONI_DEPTH_INDEX__ ?? null;

  function tokensNamed(scene, name) {
    const wanted = String(name ?? "").trim().toLowerCase();
    if (!wanted) return [];
    return (scene?.tokens?.contents ?? []).filter(t =>
      String(t.name ?? "").trim().toLowerCase() === wanted
      || String(t.actor?.name ?? "").trim().toLowerCase() === wanted
    );
  }

  const pathLines = (raw) => (Array.isArray(raw) ? raw : String(raw ?? "").split(/\r?\n/))
    .map(s => String(s).trim()).filter(Boolean);

  // A path line as a map point (the centre a token lands on), or null.
  function resolvePoint(scene, line) {
    const m = String(line).match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (m) return { x: Number(m[1]), y: Number(m[2]), label: line };
    const mark = tokensNamed(scene, line)[0];
    if (!mark) return null;
    const grid = scene.grid.size;
    return { x: mark.x + (mark.width * grid) / 2, y: mark.y + (mark.height * grid) / 2, label: line };
  }

  function centerOf(doc) {
    const grid = doc.parent.grid.size;
    return { x: doc.x + (doc.width * grid) / 2, y: doc.y + (doc.height * grid) / 2 };
  }

  // ------------------------------------------------------------
  // One hop on this client
  // ------------------------------------------------------------
  function playHop(data, info) {
    if (globalThis.FUCompanion?.api?.vfxSuppressed?.() === true) return;
    const token = canvas?.tokens?.get(data.tokenId);
    const mesh = token?.mesh;
    const host = canvas?.primary;
    const worldFx = window.oni.EventSystem.WorldFx;
    if (!token || !mesh?.texture?.valid || !host || !worldFx) return;

    const dx = data.to.x - data.from.x;
    const dy = data.to.y - data.from.y;
    if (data.face !== false) {
      try { facingApi()?.turnTo?.(token, dx, dy); } catch (_) {}
    }
    const stridePromise = Promise.resolve(facingApi()?.strideFor?.(token, dx, dy)).catch(() => null);

    // The copy stands where the mesh's feet are, measured from the token's centre,
    // so it lines up whether or not this client has the landing update yet.
    const footX = mesh.x - token.center.x;
    const footY = mesh.y + Math.abs(mesh.height) * (1 - mesh.anchor.y) - token.center.y;
    const from = { x: data.from.x + footX, y: data.from.y + footY };
    const to = { x: data.to.x + footX, y: data.to.y + footY };

    const standTex = mesh.texture;
    const baseX = mesh.scale.x;
    const baseY = mesh.scale.y;
    const f0 = Number(depthApi()?.factorAtY?.(from.y)) || 1;
    const f1 = Number(depthApi()?.factorAtY?.(to.y)) || 1;
    const depthEnd = f1 / f0;

    const sprite = new PrimarySpriteMesh({ texture: standTex, name: "oniEventJumpHop" });
    sprite.anchor.set(0.5, 1);
    sprite.tint = mesh.tint;
    sprite.elevation = 0;
    sprite.sortLayer = PrimaryCanvasGroup.SORT_LAYERS.TOKENS;
    sprite.sort = worldFx.SORT.COPIES;
    sprite.position.set(from.x, from.y);
    sprite.scale.set(baseX, baseY);
    host.addChild(sprite);
    mesh.renderable = false;

    let stride = null;
    stridePromise.then((s) => { stride = s; });

    const ticker = canvas.app.ticker;
    const startedAt = performance.now();
    const flightAt = HOP.crouchMs + HOP.holdMs;
    const landAt = flightAt + data.flightMs;
    const endAt = landAt + HOP.landMs;
    let phase = "crouch";

    const finish = () => {
      ticker.remove(tick);
      if (!sprite.destroyed) sprite.destroy();
      // Show the real token once it stands where the copy landed (or give up waiting).
      const reveal = () => { if (!mesh.destroyed) mesh.renderable = true; };
      const settled = () => Math.hypot(token.center.x - data.to.x, token.center.y - data.to.y) < 2;
      if (settled()) return reveal();
      const giveUpAt = performance.now() + HOP.settleMs;
      const wait = () => {
        try {
          if (settled() || performance.now() > giveUpAt || mesh.destroyed) { ticker.remove(wait); reveal(); }
        } catch (_) { ticker.remove(wait); reveal(); }
      };
      ticker.add(wait);
    };

    const setLook = (texture, sx, sy, mirror) => {
      if (sprite.texture !== texture) sprite.texture = texture;
      // A stride frame may be drawn at another size; keep the standing height.
      const fit = texture === standTex ? 1 : (standTex.height / Math.max(1, texture.height));
      const sign = mirror === null ? Math.sign(baseX) || 1 : (mirror ? -1 : 1);
      sprite.scale.set(Math.abs(baseX) * fit * sx * sign, Math.abs(baseY) * fit * sy);
    };

    const tick = () => {
      try {
        if (sprite.destroyed || !sprite.parent) return finish();
        const t = performance.now() - startedAt;
        if (t >= endAt) return finish();

        if (t < flightAt) {
          const e = Math.sin(Math.min(1, t / HOP.crouchMs) * Math.PI / 2);
          setLook(standTex, mix(1, HOP.crouch.x, e), mix(1, HOP.crouch.y, e), null);
          return;
        }

        if (t < landAt) {
          if (phase === "crouch") {
            phase = "air";
            if (data.takeoffSrc) window.oni.EventSystem.RowsMedia?.playSound?.(data.takeoffSrc, data.takeoffVolume ?? 0.6);
          }
          const u = (t - flightAt) / data.flightMs;
          const k = mix(1, depthEnd, u);
          let sx = 1, sy = 1;
          if (u < 0.18) { sx = mix(HOP.crouch.x, HOP.reach.x, u / 0.18); sy = mix(HOP.crouch.y, HOP.reach.y, u / 0.18); }
          else if (u < 0.5) { sx = mix(HOP.reach.x, 1, (u - 0.18) / 0.32); sy = mix(HOP.reach.y, 1, (u - 0.18) / 0.32); }
          else if (u > 0.72) { sx = mix(1, HOP.fall.x, (u - 0.72) / 0.28); sy = mix(1, HOP.fall.y, (u - 0.72) / 0.28); }
          if (stride?.texture?.valid) setLook(stride.texture, sx * k, sy * k, stride.mirror);
          else setLook(standTex, sx * k, sy * k, null);
          sprite.x = mix(from.x, to.x, u);
          sprite.y = mix(from.y, to.y, u) - data.arc * 4 * u * (1 - u);
          return;
        }

        if (phase === "air") {
          phase = "land";
          if (data.landSrc) window.oni.EventSystem.RowsMedia?.playSound?.(data.landSrc, data.takeoffVolume ?? 0.6);
          try { window.oni.TileBob?.dip?.(data.to.x, data.to.y); } catch (_) {}
        }
        const e = Math.sin(Math.min(1, (t - landAt) / HOP.landMs) * Math.PI);
        sprite.position.set(to.x, to.y);
        setLook(standTex, (1 + HOP.land.x * e) * depthEnd, (1 - HOP.land.y * e) * depthEnd, null);
      } catch (e) {
        console.warn(INSTALL_TAG, "Hop frame failed; dropping the effect.", e);
        finish();
      }
    };
    ticker.add(tick);
    Client.addCleanup(info?.sourceId, `jump.hop.${data.tokenId}`, () => { if (!sprite.destroyed) finish(); });
  }

  Client.register(KIND_HOP, (data, info) => playHop(data, info));

  // ------------------------------------------------------------
  // The jump itself (GM side), shared with Run Code
  // ------------------------------------------------------------
  /**
   * One hop of each token in docs to the point `to`, paced on the GM.
   * Returns false if the event was ended mid-hop.
   *   opts: arcPct (100), hopMs (640), face (true), takeoffSrc, takeoffVolume, landSrc
   */
  async function hop(docs, to, opts = {}, sourceId = null) {
    const list = (Array.isArray(docs) ? docs : [docs]).filter(Boolean);
    if (!list.length || !to) return true;
    const scene = list[0].parent;
    const grid = scene.grid.size;
    const arcK = clamp(opts.arcPct, 20, 300, 100) / 100;
    const hopMs = clamp(opts.hopMs, 150, 3000, 640);

    let longest = 0;
    for (const doc of list) {
      const from = centerOf(doc);
      const dist = Math.hypot(to.x - from.x, to.y - from.y);
      const flightMs = HOP.flight(hopMs, dist);
      longest = Math.max(longest, flightMs);
      Client.run(sourceId, KIND_HOP, {
        tokenId: doc.id,
        from, to: { x: to.x, y: to.y },
        arc: HOP.arc(dist) * arcK,
        flightMs,
        face: opts.face !== false,
        takeoffSrc: String(opts.takeoffSrc ?? ""),
        takeoffVolume: clamp(opts.takeoffVolume, 0, 1, 0.6),
        landSrc: String(opts.landSrc ?? "")
      });
    }

    const wait = (ms) => (sourceId && flow()?.wait ? flow().wait(sourceId, ms) : new Promise(r => setTimeout(() => r(true), ms)));
    if (await wait(HOP.crouchMs + HOP.holdMs + longest) === false) return false;
    await scene.updateEmbeddedDocuments("Token", list.map(doc => ({
      _id: doc.id,
      x: to.x - (doc.width * grid) / 2,
      y: to.y - (doc.height * grid) / 2
    })), { animate: false, pan: false, oniJump: true });
    return (await wait(HOP.landMs)) !== false;
  }

  /** Hops along a whole path. lines: marker names or "x, y". Returns { ok, reason, missing }. */
  async function jumpPath(docs, lines, opts = {}, sourceId = null) {
    const list = (Array.isArray(docs) ? docs : [docs]).filter(Boolean);
    if (!list.length) return { ok: false, reason: "noToken" };
    const scene = list[0].parent;
    const points = pathLines(lines).map(line => ({ line, at: resolvePoint(scene, line) }));
    const missing = points.filter(p => !p.at).map(p => p.line);
    if (missing.length) return { ok: false, reason: "missingMarker", missing };

    const pauseMs = clamp(opts.pauseMs, 0, 5000, 220);
    for (let i = 0; i < points.length; i++) {
      if (!await hop(list, points[i].at, opts, sourceId)) return { ok: false, reason: "ended" };
      if (i < points.length - 1 && pauseMs > 0) {
        const go = sourceId && flow()?.wait ? await flow().wait(sourceId, pauseMs) : true;
        if (go === false) return { ok: false, reason: "ended" };
      }
    }
    return { ok: true };
  }

  function jumpers(row, scene, context) {
    if (pickTarget(row?.target) === "party") {
      const doc = scene?.tokens?.get(context?.tokenId);
      return doc ? [doc] : [];
    }
    return String(row?.name ?? "").split(",").map(s => s.trim()).filter(Boolean).flatMap(n => tokensNamed(scene, n));
  }

  window.oni.EventSystem.Jump = { hop, path: jumpPath, resolvePoint, HOP };

  // ------------------------------------------------------------
  // The row
  // ------------------------------------------------------------
  EventRegistry.register({
    type: "jumpTo",
    label: "Jump To",
    category: "Token",
    defaultData: {
      type: "jumpTo", target: "party", name: "", path: "",
      arcPct: 100, hopMs: 640, pauseMs: 220, face: true,
      takeoffSrc: DEFAULT_TAKEOFF, takeoffVolume: 0.6, landSrc: ""
    },
    mediaOf: (row) => [row?.takeoffSrc, row?.landSrc].filter(Boolean),
    summary: (row) => {
      const lines = pathLines(row?.path);
      const who = pickTarget(row?.target) === "party" ? "the party" : (String(row?.name ?? "").trim() || "(no token)");
      return lines.length ? `${who} → ${lines.join(" → ")}` : `${who} (no path)`;
    },
    execute: async (row, context) => {
      const scene = game.scenes?.get(context?.sceneId) ?? canvas?.scene ?? null;
      const docs = jumpers(row, scene, context);
      if (!docs.length) {
        console.warn(INSTALL_TAG, "Jump To: nobody to jump; passed over.", row);
        return { ok: false, type: "jumpTo", reason: "notFound" };
      }
      // A row saved before a field existed gets its default; an emptied field stays empty.
      const result = await jumpPath(docs, row?.path, { takeoffSrc: DEFAULT_TAKEOFF, ...row }, context?.tileId);
      if (result.reason === "missingMarker") {
        ui.notifications?.warn?.(`Event: Jump To has no marker named ${result.missing.join(", ")} on this scene. The jump was skipped.`);
      }
      return { ok: result.ok, type: "jumpTo", reason: result.reason };
    },
    buildFields: (row, kit) => {
      const body = kit.fields(
        kit.field(
          "Who",
          `<select class="oni-event-row-jump-target">${kit.options(TARGETS, pickTarget(row.target))}</select>`
        ),
        `<div class="oni-event-row-jump-name-wrap">${kit.field(
          "Token names",
          `<input type="text" class="oni-event-row-jump-name" value="${kit.escapeHTML(row.name ?? "")}" placeholder="Names of tokens on this scene, separated by commas" />`
        )}</div>`,
        kit.field(
          "Path, in order",
          `<textarea class="oni-event-textarea oni-event-row-jump-path" rows="4" placeholder="One per line: a marker token's name (hidden is fine), or x, y">${kit.escapeHTML(pathLines(row.path).join("\n"))}</textarea>`,
          "One hop per line. Put hidden marker tokens on the stones; the last line is where they land. A line like 845, 562 is a map point."
        ),
        kit.field(
          "Arc height (%)",
          kit.numberInput("oni-event-row-jump-arc", clamp(row.arcPct, 20, 300, 100), { min: 20, max: 300, step: 5 }),
          "100 = a height that grows with the hop's length."
        ),
        kit.field(
          "Time per hop (ms)",
          kit.numberInput("oni-event-row-jump-ms", clamp(row.hopMs, 150, 3000, 640), { min: 150, max: 3000, step: 10 }),
          "For a hop of about two grid squares; longer hops take a little longer."
        ),
        kit.field(
          "Pause between hops (ms)",
          kit.numberInput("oni-event-row-jump-pause", clamp(row.pauseMs, 0, 5000, 220), { min: 0, max: 5000, step: 10 })
        ),
        kit.field(
          "Face",
          `<label><input type="checkbox" class="oni-event-row-jump-face" ${row.face !== false ? "checked" : ""} /> turn to face each hop</label>`
        ),
        kit.field("Take-off sound", kit.fileInput("oni-event-row-jump-takeoff", row.takeoffSrc ?? "", "audio", "Sound at each take-off (empty: none)")),
        kit.field(
          "Volume",
          kit.numberInput("oni-event-row-jump-volume", clamp(row.takeoffVolume, 0, 1, 0.6), { min: 0, max: 1, step: 0.05 })
        ),
        kit.field("Landing sound", kit.fileInput("oni-event-row-jump-land", row.landSrc ?? "", "audio", "Sound at each landing (empty: none)"))
      );

      const targetEl = body.querySelector(".oni-event-row-jump-target");
      const sync = () => {
        body.querySelector(".oni-event-row-jump-name-wrap").hidden = targetEl.value !== "token";
      };
      targetEl.addEventListener("change", sync);
      sync();
      return body;
    },
    collectFields: (rowEl, kit) => ({
      target: pickTarget(kit.readText(rowEl, ".oni-event-row-jump-target", "party")),
      name: kit.readText(rowEl, ".oni-event-row-jump-name", "").trim(),
      path: pathLines(kit.own(rowEl, ".oni-event-row-jump-path")?.value ?? "").join("\n"),
      arcPct: clamp(kit.readNumber(rowEl, ".oni-event-row-jump-arc", 100), 20, 300, 100),
      hopMs: clamp(kit.readNumber(rowEl, ".oni-event-row-jump-ms", 640), 150, 3000, 640),
      pauseMs: clamp(kit.readNumber(rowEl, ".oni-event-row-jump-pause", 220), 0, 5000, 220),
      face: !!kit.own(rowEl, ".oni-event-row-jump-face")?.checked,
      takeoffSrc: kit.readText(rowEl, ".oni-event-row-jump-takeoff", "").trim(),
      takeoffVolume: clamp(kit.readNumber(rowEl, ".oni-event-row-jump-volume", 0.6), 0, 1, 0.6),
      landSrc: kit.readText(rowEl, ".oni-event-row-jump-land", "").trim()
    })
  });

  window.oni.EventSystem.RowsJump = { installed: true };
  console.debug(INSTALL_TAG, "Installed.");
})();
