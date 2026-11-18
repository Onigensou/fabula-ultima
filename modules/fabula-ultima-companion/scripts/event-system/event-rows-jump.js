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
 * - A path line is a marker token's name (a hidden one works), "x, y", or
 *   "party:dx,dy": where the party token stands when the row starts, moved by
 *   dx, dy map px and kept inside the scene. Markers sit on the stones; the last
 *   line is where the party lands.
 * - Bobbing stones (map-system/tile-bob.js) dip when a foot lands on them.
 * - Two more styles. Leap out: crouch, then launch straight up out of the
 *   camera's view, and the token is hidden where it stood (the path is not
 *   used). Drop in: the token is put on the path's last point while hidden, then
 *   falls into place from high above and squashes on landing. Leap out, a
 *   Camera Pan, then Drop in reads as one jump across the map.
 * - Guilty Gear dust at take-off, landing or both, sized by the jumper's drawn
 *   height; the clips and colour are Set Token's (event-rows-token.js ggDust).
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
    settleMs: 1500,
    // "Fade out on the last hop": share of the flight before the fade starts.
    fadeFrom: 0.55
  };

  const KIND_LEAP = "jump.leapOut";
  const KIND_DROP = "jump.dropIn";

  // Leap out and drop in, from the Asura mockup: a crouch, then up 640 px in
  // 260 ms eased out, stretched; down from 640 px in 300 ms eased in, a 60 ms
  // squash and a springy 320 ms back to standing.
  const LEAP = {
    crouchMs: 170,
    launchMs: 260,
    liftPx: 640,
    squash: { x: 1.2, y: 0.72 },
    stretch: { x: 0.88, y: 1.18 },
    // Share of the launch left when it starts to fade, for a camera zoomed out
    // far enough to still see 640 px up.
    fadeFrom: 0.75
  };
  const DROP = {
    liftPx: 640,
    fallMs: 300,
    fadeInMs: 120,
    squashMs: 60,
    standMs: 320,
    stretch: { x: 0.88, y: 1.18 },
    land: { x: 1.25, y: 0.7 },
    overshoot: 1.6
  };
  const LEAP_MS = LEAP.crouchMs + LEAP.launchMs;
  const DROP_MS = DROP.fallMs + DROP.squashMs + DROP.standMs;

  const DEFAULT_TAKEOFF = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/SE_JUMPLANDA.wav";

  const TARGETS = [
    ["party", "The party"],
    ["token", "A named token"]
  ];
  const STYLES = [
    ["hop", "Hop along the path"],
    ["leapOut", "Leap out of view, then hide"],
    ["dropIn", "Drop in from above, at the last point"]
  ];
  const DUSTS = [
    ["none", "None"],
    ["takeoff", "At take-off"],
    ["landing", "At landing"],
    ["both", "Both"]
  ];
  const pickTarget = (value) => (TARGETS.some(([key]) => key === value) ? value : "party");
  const pickStyle = (value) => (STYLES.some(([key]) => key === value) ? value : "hop");
  const pickDust = (value) => (DUSTS.some(([key]) => key === value) ? value : "none");
  const dustAtTakeoff = (dust) => dust === "takeoff" || dust === "both";
  const dustAtLanding = (dust) => dust === "landing" || dust === "both";
  const clamp = (v, lo, hi, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
  };
  const mix = (a, b, t) => a + (b - a) * Math.min(1, Math.max(0, t));
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);
  const easeIn = (t) => t * t * t;
  const outBack = (t) => 1 + ((DROP.overshoot + 1) * Math.pow(t - 1, 3)) + (DROP.overshoot * Math.pow(t - 1, 2));

  const flow = () => window.oni.EventSystem.Flow;
  const facingApi = () => globalThis.__ONI_SPRITE_FACING_RUNTIME__ ?? null;
  const depthApi = () => globalThis.__ONI_DEPTH_INDEX__ ?? null;
  const rowsToken = () => window.oni.EventSystem.RowsToken ?? null;

  // Paced on the GM by the event, or a plain timer for a jump with no event.
  const pace = (sourceId, ms) => (sourceId && flow()?.wait ? flow().wait(sourceId, ms) : new Promise(r => setTimeout(() => r(true), ms)));

  // Guilty Gear dust at a jumper's feet, on this client. heightPx: its drawn height.
  function dust(x, y, heightPx, landing, sourceId) {
    const rt = rowsToken();
    if (!rt?.ggDust) return;
    try { rt.ggDust(x, y, rt.dustSize(heightPx, landing), landing, sourceId ?? ""); } catch (_) {}
  }

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

  // "party:+86,0" -> { anchor: "party", dx: 86, dy: 0 }, or null when the line is not one.
  // "party:+86,0@Pit Shot": the same, but dx turns round when the party stands
  // left of the token "Pit Shot" (one path for whichever side they came from).
  // "self:+10,+210": the same, measured from where the (first) jumper stands
  // when the row starts, for a token whose spot is not known in advance
  // (Rakshasa lands beside the party wherever they dodged, then leaps into the pit).
  function parsePartyOffset(line) {
    const m = String(line).match(/^\s*(party|self)\s*:\s*([+-]?\d+(?:\.\d+)?)\s*,\s*([+-]?\d+(?:\.\d+)?)\s*(?:@\s*(.+?))?\s*$/i);
    if (!m) return null;
    const out = { anchor: m[1].toLowerCase(), dx: Number(m[2]), dy: Number(m[3]) };
    if (m[4]) out.mirrorRef = m[4].trim();
    return out;
  }

  // A point kept inside the scene's own area (not its padding). A scene with no
  // dimensions to hand leaves the point as it is.
  function clampToScene(scene, x, y) {
    const r = scene?.dimensions?.sceneRect;
    if (!r || !Number.isFinite(r.width) || !Number.isFinite(r.height)) return { x, y };
    return {
      x: Math.min(r.x + r.width, Math.max(r.x, x)),
      y: Math.min(r.y + r.height, Math.max(r.y, y))
    };
  }

  const resolvePath = (scene, lines, party = null, self = null) => pathLines(lines).map(line => ({ line, at: resolvePoint(scene, line, party, self) }));

  // A path line as a map point (the centre a token lands on), or null.
  // party: the party token's document, for "party:dx,dy" lines; self: the
  // jumper's own document, for "self:dx,dy" lines.
  function resolvePoint(scene, line, party = null, self = null) {
    const rel = parsePartyOffset(line);
    if (rel) {
      const anchor = rel.anchor === "self" ? self : party;
      if (!anchor) return null;
      const c = centerOf(anchor);
      let dx = rel.dx;
      if (rel.mirrorRef) {
        const ref = tokensNamed(scene, rel.mirrorRef)[0];
        if (ref && c.x < centerOf(ref).x) dx = -dx;
      }
      return { ...clampToScene(scene, c.x + dx, c.y + rel.dy), label: line };
    }
    const m = String(line).match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (m) return { x: Number(m[1]), y: Number(m[2]), label: line };
    const mark = tokensNamed(scene, line)[0];
    if (!mark) return null;
    const grid = scene.grid.size;
    return { x: mark.x + (mark.width * grid) / 2, y: mark.y + (mark.height * grid) / 2, label: line };
  }

  function centerOf(doc) {
    const grid = doc.parent?.grid?.size ?? 100;
    return { x: doc.x + (doc.width * grid) / 2, y: doc.y + (doc.height * grid) / 2 };
  }

  // A copy of a token's sprite among the tokens, at the mesh's scale; not yet
  // added to the canvas.
  function copyOf(mesh, texture, name) {
    const sprite = new PrimarySpriteMesh({ texture, name });
    sprite.anchor.set(0.5, 1);
    sprite.tint = mesh.tint;
    sprite.elevation = 0;
    sprite.sortLayer = PrimaryCanvasGroup.SORT_LAYERS.TOKENS;
    sprite.sort = window.oni.EventSystem.WorldFx?.SORT?.COPIES ?? 500000;
    sprite.scale.set(mesh.scale.x, mesh.scale.y);
    return sprite;
  }

  // Where the mesh's feet are, measured from the token's centre: true whether or
  // not this client has the token's latest move yet.
  function footOffset(token, mesh) {
    return {
      x: mesh.x - token.center.x,
      y: mesh.y + Math.abs(mesh.height) * (1 - mesh.anchor.y) - token.center.y
    };
  }

  // Show the real token again once test() holds (or give up waiting).
  function revealWhen(mesh, test, ms = HOP.settleMs) {
    const reveal = () => { if (!mesh.destroyed) mesh.renderable = true; };
    let ok = false;
    try { ok = test(); } catch (_) { ok = true; }
    if (ok) return reveal();
    const ticker = canvas.app.ticker;
    const giveUpAt = performance.now() + ms;
    const wait = () => {
      try {
        if (test() || performance.now() > giveUpAt || mesh.destroyed) { ticker.remove(wait); reveal(); }
      } catch (_) { ticker.remove(wait); reveal(); }
    };
    ticker.add(wait);
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
    rowsToken()?.takeHeld?.(data.tokenId);

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
    const heightPx = Math.abs(mesh.height);

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
      // A fading hop ends hidden: wait for that instead, so it never pops back.
      const reveal = () => { if (!mesh.destroyed) mesh.renderable = true; };
      const settled = data.fadeOut
        ? () => token.document?.hidden === true
        : () => Math.hypot(token.center.x - data.to.x, token.center.y - data.to.y) < 2;
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
            if (dustAtTakeoff(data.dust)) dust(from.x, from.y, heightPx, false, info?.sourceId);
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
          // Fading hop: gone by touchdown, as if it dropped out of sight (into a pit).
          if (data.fadeOut) sprite.alpha = u <= HOP.fadeFrom ? 1 : Math.max(0, 1 - (u - HOP.fadeFrom) / (1 - HOP.fadeFrom));
          return;
        }

        if (phase === "air") {
          phase = "land";
          if (data.landSrc) window.oni.EventSystem.RowsMedia?.playSound?.(data.landSrc, data.takeoffVolume ?? 0.6);
          try { window.oni.TileBob?.dip?.(data.to.x, data.to.y); } catch (_) {}
          if (dustAtLanding(data.dust)) dust(to.x, to.y, heightPx * depthEnd, true, info?.sourceId);
        }
        if (data.fadeOut) { sprite.alpha = 0; return; }
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
  // Leap out and drop in, on this client
  // ------------------------------------------------------------
  // Leap out: a crouch (from Set Token's crouch, when one is held), then up out
  // of view. The token itself stays put; the GM hides it at the end.
  function playLeap(data, info) {
    if (globalThis.FUCompanion?.api?.vfxSuppressed?.() === true) return;
    const token = canvas?.tokens?.get(data.tokenId);
    const mesh = token?.mesh;
    const host = canvas?.primary;
    if (!token || !mesh?.texture?.valid || !host) return;

    const start = rowsToken()?.takeHeld?.(data.tokenId) ?? { sx: 1, sy: 1 };
    const foot = footOffset(token, mesh);
    const at = { x: token.center.x + foot.x, y: token.center.y + foot.y };
    const baseX = mesh.scale.x;
    const baseY = mesh.scale.y;
    const heightPx = Math.abs(mesh.height);
    const sprite = copyOf(mesh, mesh.texture, "oniEventJumpLeap");
    sprite.position.set(at.x, at.y);
    sprite.scale.set(baseX * start.sx, baseY * start.sy);
    host.addChild(sprite);
    mesh.renderable = false;

    const ticker = canvas.app.ticker;
    const startedAt = performance.now();
    let launched = false;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      ticker.remove(tick);
      if (!sprite.destroyed) sprite.destroy();
      revealWhen(mesh, () => token.document?.hidden === true);
    };
    const tick = () => {
      try {
        if (sprite.destroyed || !sprite.parent) return finish();
        const t = performance.now() - startedAt;
        if (t >= LEAP_MS) return finish();

        if (t < LEAP.crouchMs) {
          const e = Math.sin((t / LEAP.crouchMs) * Math.PI / 2);
          sprite.scale.set(baseX * mix(start.sx, LEAP.squash.x, e), baseY * mix(start.sy, LEAP.squash.y, e));
          return;
        }
        if (!launched) {
          launched = true;
          if (data.takeoffSrc) window.oni.EventSystem.RowsMedia?.playSound?.(data.takeoffSrc, data.takeoffVolume ?? 0.6);
          if (dustAtTakeoff(data.dust)) dust(at.x, at.y, heightPx, false, info?.sourceId);
        }
        const u = (t - LEAP.crouchMs) / LEAP.launchMs;
        sprite.scale.set(baseX * LEAP.stretch.x, baseY * LEAP.stretch.y);
        sprite.y = at.y - (LEAP.liftPx * easeOut(u));
        sprite.alpha = u > LEAP.fadeFrom ? 1 - ((u - LEAP.fadeFrom) / (1 - LEAP.fadeFrom)) : 1;
      } catch (e) {
        console.warn(INSTALL_TAG, "Leap frame failed; dropping the effect.", e);
        finish();
      }
    };
    ticker.add(tick);
    Client.addCleanup(info?.sourceId, `jump.leap.${data.tokenId}`, () => { if (!done) finish(); });
  }

  // Drop in: the copy falls onto data.to (the token's centre there) from high
  // above, stretched, and squashes on landing. The GM shows the token at touchdown.
  function playDrop(data, info) {
    if (globalThis.FUCompanion?.api?.vfxSuppressed?.() === true) return;
    const token = canvas?.tokens?.get(data.tokenId);
    const mesh = token?.mesh;
    const host = canvas?.primary;
    if (!token || !mesh?.texture?.valid || !host) return;

    rowsToken()?.takeHeld?.(data.tokenId);
    const foot = footOffset(token, mesh);
    const to = { x: data.to.x + foot.x, y: data.to.y + foot.y };
    // The mesh may still stand where it was: scale it for depth at the landing.
    const meshFootY = token.center.y + foot.y;
    const f0 = Number(depthApi()?.factorAtY?.(meshFootY)) || 1;
    const f1 = Number(depthApi()?.factorAtY?.(to.y)) || 1;
    const k = f1 / f0;
    const baseX = mesh.scale.x * k;
    const baseY = mesh.scale.y * k;
    const heightPx = Math.abs(mesh.height) * k;
    const sprite = copyOf(mesh, mesh.texture, "oniEventJumpDrop");
    sprite.position.set(to.x, to.y - DROP.liftPx);
    sprite.scale.set(baseX * DROP.stretch.x, baseY * DROP.stretch.y);
    sprite.alpha = 0;
    host.addChild(sprite);
    mesh.renderable = false;

    const ticker = canvas.app.ticker;
    const startedAt = performance.now();
    let landed = false;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      ticker.remove(tick);
      if (!sprite.destroyed) sprite.destroy();
      revealWhen(mesh, () => token.document?.hidden === false
        && Math.hypot(token.center.x - data.to.x, token.center.y - data.to.y) < 2);
    };
    const tick = () => {
      try {
        if (sprite.destroyed || !sprite.parent) return finish();
        const t = performance.now() - startedAt;
        if (t >= DROP_MS) return finish();
        sprite.tint = mesh.tint;

        if (t < DROP.fallMs) {
          const u = t / DROP.fallMs;
          sprite.alpha = Math.min(1, t / DROP.fadeInMs);
          sprite.y = to.y - (DROP.liftPx * (1 - easeIn(u)));
          return;
        }
        if (!landed) {
          landed = true;
          sprite.alpha = 1;
          sprite.y = to.y;
          if (data.landSrc) window.oni.EventSystem.RowsMedia?.playSound?.(data.landSrc, data.takeoffVolume ?? 0.6);
          try { window.oni.TileBob?.dip?.(data.to.x, data.to.y); } catch (_) {}
          if (dustAtLanding(data.dust)) dust(to.x, to.y, heightPx, true, info?.sourceId);
        }
        const s = t - DROP.fallMs;
        let sx, sy;
        if (s < DROP.squashMs) {
          sx = mix(DROP.stretch.x, DROP.land.x, s / DROP.squashMs);
          sy = mix(DROP.stretch.y, DROP.land.y, s / DROP.squashMs);
        } else {
          // Springs back past standing a little; mix() would clip the overshoot.
          const e = outBack(Math.min(1, (s - DROP.squashMs) / DROP.standMs));
          sx = DROP.land.x + ((1 - DROP.land.x) * e);
          sy = DROP.land.y + ((1 - DROP.land.y) * e);
        }
        sprite.scale.set(baseX * sx, baseY * sy);
      } catch (e) {
        console.warn(INSTALL_TAG, "Drop frame failed; dropping the effect.", e);
        finish();
      }
    };
    ticker.add(tick);
    Client.addCleanup(info?.sourceId, `jump.drop.${data.tokenId}`, () => { if (!done) finish(); });
  }

  Client.register(KIND_LEAP, (data, info) => playLeap(data, info));
  Client.register(KIND_DROP, (data, info) => playDrop(data, info));

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
        landSrc: String(opts.landSrc ?? ""),
        dust: pickDust(opts.dust),
        fadeOut: opts.fadeOut === true
      });
    }

    const wait = (ms) => (sourceId && flow()?.wait ? flow().wait(sourceId, ms) : new Promise(r => setTimeout(() => r(true), ms)));
    if (await wait(HOP.crouchMs + HOP.holdMs + longest) === false) return false;
    // A fading hop lands hidden (one update, so it never shows at the landing).
    await scene.updateEmbeddedDocuments("Token", list.map(doc => ({
      _id: doc.id,
      x: to.x - (doc.width * grid) / 2,
      y: to.y - (doc.height * grid) / 2,
      ...(opts.fadeOut === true ? { hidden: true } : {})
    })), { animate: false, pan: false, oniJump: true });
    return (await wait(HOP.landMs)) !== false;
  }

  /**
   * Leap out: each token in docs that can be seen crouches and launches out of
   * view, then all of them are hidden where they stand. Returns false if the
   * event was ended mid-leap. opts: dust, takeoffSrc, takeoffVolume
   */
  async function leapOut(docs, opts = {}, sourceId = null) {
    const list = (Array.isArray(docs) ? docs : [docs]).filter(Boolean);
    if (!list.length) return true;
    const scene = list[0].parent;
    for (const doc of list.filter(d => !d.hidden)) {
      Client.run(sourceId, KIND_LEAP, {
        tokenId: doc.id,
        dust: pickDust(opts.dust),
        takeoffSrc: String(opts.takeoffSrc ?? ""),
        takeoffVolume: clamp(opts.takeoffVolume, 0, 1, 0.6)
      });
    }
    if (await pace(sourceId, LEAP_MS) === false) return false;
    await scene.updateEmbeddedDocuments("Token", list.map(doc => ({ _id: doc.id, hidden: true })));
    return true;
  }

  /**
   * Drop in: each token in docs is put at the point `to` while hidden, falls into
   * place from above and is shown at touchdown. Returns false if the event was
   * ended mid-fall. opts: dust, landSrc, takeoffVolume
   */
  async function dropIn(docs, to, opts = {}, sourceId = null) {
    const list = (Array.isArray(docs) ? docs : [docs]).filter(Boolean);
    if (!list.length || !to) return true;
    const scene = list[0].parent;
    const grid = scene.grid.size;
    await scene.updateEmbeddedDocuments("Token", list.map(doc => ({
      _id: doc.id,
      x: to.x - (doc.width * grid) / 2,
      y: to.y - (doc.height * grid) / 2,
      hidden: true
    })), { animate: false, pan: false, oniJump: true });
    for (const doc of list) {
      Client.run(sourceId, KIND_DROP, {
        tokenId: doc.id,
        to: { x: to.x, y: to.y },
        dust: pickDust(opts.dust),
        landSrc: String(opts.landSrc ?? ""),
        takeoffVolume: clamp(opts.takeoffVolume, 0, 1, 0.6)
      });
    }
    if (await pace(sourceId, DROP.fallMs) === false) return false;
    await scene.updateEmbeddedDocuments("Token", list.map(doc => ({ _id: doc.id, hidden: false })));
    return (await pace(sourceId, DROP.squashMs + DROP.standMs)) !== false;
  }

  /**
   * Hops along a whole path. lines: marker names, "x, y", "party:dx,dy" or
   * "self:dx,dy". opts.party: the party token's document, for "party:" lines;
   * "self:" lines use the first jumper. All are worked out from where they
   * stand now. opts.fadeOut: the last hop fades out and lands hidden.
   * Returns { ok, reason, missing }.
   */
  async function jumpPath(docs, lines, opts = {}, sourceId = null) {
    const list = (Array.isArray(docs) ? docs : [docs]).filter(Boolean);
    if (!list.length) return { ok: false, reason: "noToken" };
    const scene = list[0].parent;
    const points = resolvePath(scene, lines, opts.party ?? null, list[0]);
    const missing = points.filter(p => !p.at).map(p => p.line);
    if (missing.length) return { ok: false, reason: "missingMarker", missing };

    const pauseMs = clamp(opts.pauseMs, 0, 5000, 220);
    for (let i = 0; i < points.length; i++) {
      const hopOpts = { ...opts, fadeOut: opts.fadeOut === true && i === points.length - 1 };
      if (!await hop(list, points[i].at, hopOpts, sourceId)) return { ok: false, reason: "ended" };
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

  window.oni.EventSystem.Jump = {
    hop, path: jumpPath, leapOut, dropIn, resolvePoint, resolvePath, parsePartyOffset, clampToScene,
    HOP, LEAP, DROP, LEAP_MS, DROP_MS
  };

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
      takeoffSrc: DEFAULT_TAKEOFF, takeoffVolume: 0.6, landSrc: "",
      style: "hop", dust: "none", fadeOut: false
    },
    mediaOf: (row) => {
      const style = pickStyle(row?.style);
      const media = [style !== "dropIn" ? row?.takeoffSrc : "", style !== "leapOut" ? row?.landSrc : ""].filter(Boolean);
      const dustKind = pickDust(row?.dust);
      const rt = rowsToken();
      if (dustKind === "none" || !rt?.dustPuffs) return media;
      const puffs = (landing) => rt.dustPuffs(0, 0, 1, landing).map(p => p.src);
      const hops = style === "hop" ? Math.max(1, pathLines(row?.path).length) : 1;
      for (let i = 0; i < hops; i++) {
        if (style !== "dropIn" && dustAtTakeoff(dustKind)) media.push(...puffs(false));
        if (style !== "leapOut" && dustAtLanding(dustKind)) media.push(...puffs(true));
      }
      return media;
    },
    summary: (row) => {
      const lines = pathLines(row?.path);
      const who = pickTarget(row?.target) === "party" ? "the party" : (String(row?.name ?? "").trim() || "(no token)");
      const style = pickStyle(row?.style);
      const dustKind = pickDust(row?.dust);
      let text;
      if (style === "leapOut") text = `${who} leaps out of view`;
      else if (style === "dropIn") text = lines.length ? `${who} drops in at ${lines[lines.length - 1]}` : `${who} drops in (no point)`;
      else text = lines.length ? `${who} → ${lines.join(" → ")}${row?.fadeOut === true ? ", fading out" : ""}` : `${who} (no path)`;
      return dustKind === "none" ? text : `${text}, dust ${dustKind === "both" ? "at take-off and landing" : `at ${dustKind === "takeoff" ? "take-off" : "landing"}`}`;
    },
    execute: async (row, context) => {
      const scene = game.scenes?.get(context?.sceneId) ?? canvas?.scene ?? null;
      const docs = jumpers(row, scene, context);
      if (!docs.length) {
        console.warn(INSTALL_TAG, "Jump To: nobody to jump; passed over.", row);
        return { ok: false, type: "jumpTo", reason: "notFound" };
      }
      // A row saved before a field existed gets its default; an emptied field stays empty.
      const opts = { takeoffSrc: DEFAULT_TAKEOFF, ...row, party: scene?.tokens?.get(context?.tokenId) ?? null };
      const style = pickStyle(row?.style);
      const sourceId = context?.tileId;

      if (style === "leapOut") {
        const ok = await leapOut(docs, opts, sourceId);
        return { ok, type: "jumpTo", reason: ok ? undefined : "ended" };
      }

      let result;
      if (style === "dropIn") {
        const points = resolvePath(scene, row?.path, opts.party, docs[0]);
        const last = points[points.length - 1];
        if (!last) result = { ok: false, reason: "noPoint" };
        else if (!last.at) result = { ok: false, reason: "missingMarker", missing: [last.line] };
        else result = (await dropIn(docs, last.at, opts, sourceId)) ? { ok: true } : { ok: false, reason: "ended" };
        if (result.reason === "noPoint") ui.notifications?.warn?.("Event: Jump To (drop in) has no point to land on. The drop was skipped.");
      } else {
        result = await jumpPath(docs, row?.path, opts, sourceId);
      }
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
          "Style",
          `<select class="oni-event-row-jump-style">${kit.options(STYLES, pickStyle(row.style))}</select>`,
          "Leap out: crouch, launch straight up out of view, then the token is hidden where it stood. Drop in: the token is put on the path's last point while hidden, then falls into place from above. Leap out, Camera Pan, Drop in: one jump across the map."
        ),
        `<div class="oni-event-row-jump-path-wrap">${kit.field(
          "Path, in order",
          `<textarea class="oni-event-textarea oni-event-row-jump-path" rows="4" placeholder="One per line: a marker token's name (hidden is fine), x, y, party:dx,dy or self:dx,dy">${kit.escapeHTML(pathLines(row.path).join("\n"))}</textarea>`,
          "One hop per line. Put hidden marker tokens on the stones; the last line is where they land. A line like 845, 562 is a map point. A line like party:+86,0 is where the party stands when the row starts, moved by that many map px (kept inside the scene). self:+10,+210 is the same from where the jumper itself stands."
        )}</div>`,
        kit.field(
          "Dust",
          `<select class="oni-event-row-jump-dust">${kit.options(DUSTS, pickDust(row.dust))}</select>`,
          "Guilty Gear dust at the feet, sized to the jumper. In front of tokens, behind any tile at elevation 1."
        ),
        `<div class="oni-event-row-jump-hop-wrap">${[
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
          kit.field(
            "Vanish",
            `<label><input type="checkbox" class="oni-event-row-jump-fade" ${row.fadeOut === true ? "checked" : ""} /> fade out on the last hop, then hide</label>`,
            "For a jump that leaves the scene downwards, e.g. into a pit: the last hop fades away before touchdown and the token lands hidden."
          )
        ].join("")}</div>`,
        kit.field("Take-off sound", kit.fileInput("oni-event-row-jump-takeoff", row.takeoffSrc ?? "", "audio", "Sound at each take-off (empty: none)")),
        kit.field(
          "Volume",
          kit.numberInput("oni-event-row-jump-volume", clamp(row.takeoffVolume, 0, 1, 0.6), { min: 0, max: 1, step: 0.05 })
        ),
        kit.field("Landing sound", kit.fileInput("oni-event-row-jump-land", row.landSrc ?? "", "audio", "Sound at each landing (empty: none)"))
      );

      const targetEl = body.querySelector(".oni-event-row-jump-target");
      const styleEl = body.querySelector(".oni-event-row-jump-style");
      const sync = () => {
        body.querySelector(".oni-event-row-jump-name-wrap").hidden = targetEl.value !== "token";
        body.querySelector(".oni-event-row-jump-path-wrap").hidden = styleEl.value === "leapOut";
        body.querySelector(".oni-event-row-jump-hop-wrap").hidden = styleEl.value !== "hop";
      };
      targetEl.addEventListener("change", sync);
      styleEl.addEventListener("change", sync);
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
      fadeOut: !!kit.own(rowEl, ".oni-event-row-jump-fade")?.checked,
      takeoffSrc: kit.readText(rowEl, ".oni-event-row-jump-takeoff", "").trim(),
      takeoffVolume: clamp(kit.readNumber(rowEl, ".oni-event-row-jump-volume", 0.6), 0, 1, 0.6),
      landSrc: kit.readText(rowEl, ".oni-event-row-jump-land", "").trim(),
      style: pickStyle(kit.readText(rowEl, ".oni-event-row-jump-style", "hop")),
      dust: pickDust(kit.readText(rowEl, ".oni-event-row-jump-dust", "none"))
    })
  });

  window.oni.EventSystem.RowsJump = { installed: true };
  console.debug(INSTALL_TAG, "Installed.");
})();
