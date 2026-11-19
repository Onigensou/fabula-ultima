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
    fadeFrom: 0.65
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

  const KIND_TELEPORT = "jump.teleport";
  const KIND_LEVITATE = "jump.levitate";

  // Teleport, from the Deva Junction mockup (round 4): squeeze into a thin vertical
  // line of light and fade (170 ms), gone for 140 ms, then un-squeeze at the next
  // point (210 ms). A gold beam and sparkles mark both ends.
  const TELE = {
    outMs: 170,
    gapMs: 140,
    inMs: 210,
    line: { x: 0.04, y: 1.45 },
    beamMs: 420,
    beamColor: 0xffe6a0,
    sparkColor: 0xf6d68c
  };
  // Levitate (round 8): straight up, eased in and out, a gold glow; the camera
  // follows on players' screens; a white flash takes the token near the top.
  const LEVITATE = {
    risePx: 1150,
    riseMs: 2600,
    flashLeadMs: 550,
    flashMs: 1100,
    glowColor: 0xffd678,
    glowAlpha: 0.55
  };
  // Sacrificial Altar (2026-11-19, approved mockup): a beam of light falls on the
  // token first, it spins through its 8 standing directions (slow, then fast, like
  // an old Pokémon warp pad), then is pulled up with an ease-in ("suck"), stretching,
  // leaving afterimages; the flash comes as it leaves the top of the screen.
  const ASCEND = {
    beamSrc: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Animation/RPG%20Maker%20MV/117_light_pillar_1.webm",
    beamLeadMs: 1300,          // beam falls (320 ms reveal), the token lights up, a beat
    beamRevealMs: 320,
    beamWidthK: 3.1,           // beam width = token height × this
    beamLoop: [0.95, 1.55],    // the pillar's steady frames, looped while it rises
    beamHue: { violet: 228, gold: 0 },
    spinMs: 2100,
    spinRate: [2.2, 24, 28],   // steps per second: start, end of the spin-up, during the pull
    hoverPx: 26,
    suckHoverMs: 700,          // the hover before the pull when there is no spin
    suckStretch: { y: 0.38, x: 0.3 },
    suckFlashAt: 0.84,         // the flash, as a share of the pull
    trail: 5
  };
  const SPIN_ORDER = ["down", "downLeft", "left", "upLeft", "up", "upRight", "right", "downRight"];   // clockwise
  const hexColor = (s, d) => { const m = /^#?([0-9a-f]{6})$/i.exec(String(s ?? "").trim()); return m ? parseInt(m[1], 16) : d; };
  const easeInCubic = (t) => t * t * t;
  // How long a levitate takes before the rise itself, and where the flash falls.
  function ascendTimes(opts) {
    const beam = !!opts.beam && opts.beam !== "none";
    const pre = beam ? ASCEND.beamLeadMs : 0;
    const hover = opts.spin === true ? clamp(opts.spinMs, 300, 8000, ASCEND.spinMs) : (opts.curve === "suck" ? ASCEND.suckHoverMs : 0);
    return { pre, hover };
  }

  const DEFAULT_TAKEOFF = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/SE_JUMPLANDA.wav";

  const TARGETS = [
    ["party", "The party"],
    ["token", "A named token"]
  ];
  const STYLES = [
    ["hop", "Hop along the path"],
    ["teleport", "Teleport along the path (squeeze into light)"],
    ["leapOut", "Leap out of view, then hide"],
    ["levitate", "Levitate up out of view, camera follows, then hide"],
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
  // Teleport and levitate, on this client
  // ------------------------------------------------------------
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  // A plain additive white quad (beam, spark, glow) among the tokens.
  function glowQuad(color, sort) {
    const q = new PrimarySpriteMesh({ texture: PIXI.Texture.WHITE, name: "oniEventJumpLight" });
    q.anchor.set(0.5, 1);
    q.tint = color;
    q.blendMode = PIXI.BLEND_MODES.ADD;
    q.elevation = 0;
    q.sortLayer = PrimaryCanvasGroup.SORT_LAYERS.TOKENS;
    q.sort = sort;
    return q;
  }

  // A beam of light standing on (x, y) plus a burst of sparks, fading on its own.
  function lightBurst(host, x, y, heightPx) {
    const sort = (window.oni.EventSystem.WorldFx?.SORT?.COPIES ?? 500000) + 1;
    const beam = glowQuad(TELE.beamColor, sort);
    beam.position.set(x, y + 6);
    host.addChild(beam);
    const sparks = [];
    for (let i = 0; i < 14; i++) {
      const s = glowQuad(TELE.sparkColor, sort);
      const a = Math.random() * Math.PI * 2, sp = 0.6 + Math.random() * 2.2;
      s.anchor.set(0.5, 0.5);
      s.position.set(x + Math.cos(a) * 18, y - heightPx * 0.5 + Math.sin(a) * 30);
      s._v = { x: Math.cos(a) * sp, y: Math.sin(a) * sp - 1.2 };
      const size = 3 + Math.random() * 4;
      s.width = size; s.height = size;
      host.addChild(s);
      sparks.push(s);
    }
    const ticker = canvas.app.ticker;
    const startedAt = performance.now();
    const tick = () => {
      const u = (performance.now() - startedAt) / TELE.beamMs;
      if (u >= 1 || beam.destroyed) {
        ticker.remove(tick);
        for (const q of [beam, ...sparks]) if (!q.destroyed) q.destroy();
        return;
      }
      const a = Math.sin(Math.min(1, u * 1.6) * Math.PI) * 0.85;
      beam.alpha = Math.max(0, a);
      beam.width = Math.max(2, 52 * (1 - u * 0.6) * (heightPx / 250));
      beam.height = heightPx * 1.7;
      for (const s of sparks) {
        s.x += s._v.x; s.y += s._v.y; s._v.y += 0.05;
        s.alpha = Math.max(0, 1 - u);
      }
    };
    ticker.add(tick);
  }

  function playTeleport(data, info) {
    if (globalThis.FUCompanion?.api?.vfxSuppressed?.() === true) return;
    const token = canvas?.tokens?.get(data.tokenId);
    const mesh = token?.mesh;
    const host = canvas?.primary;
    if (!token || !mesh?.texture?.valid || !host) return;
    rowsToken()?.takeHeld?.(data.tokenId);

    const dx = data.to.x - data.from.x;
    const dy = data.to.y - data.from.y;
    if (data.face !== false) {
      try { facingApi()?.turnTo?.(token, dx, dy); } catch (_) {}
    }
    const foot = footOffset(token, mesh);
    const from = { x: data.from.x + foot.x, y: data.from.y + foot.y };
    const to = { x: data.to.x + foot.x, y: data.to.y + foot.y };
    const baseX = mesh.scale.x;
    const baseY = mesh.scale.y;
    const f0 = Number(depthApi()?.factorAtY?.(from.y)) || 1;
    const f1 = Number(depthApi()?.factorAtY?.(to.y)) || 1;
    const depthEnd = f1 / f0;
    const heightPx = Math.abs(mesh.height);

    const sprite = copyOf(mesh, mesh.texture, "oniEventJumpTeleport");
    sprite.position.set(from.x, from.y);
    host.addChild(sprite);
    mesh.renderable = false;
    if (data.takeoffSrc) window.oni.EventSystem.RowsMedia?.playSound?.(data.takeoffSrc, data.takeoffVolume ?? 0.6);
    lightBurst(host, from.x, from.y, heightPx);

    const ticker = canvas.app.ticker;
    const startedAt = performance.now();
    const arriveAt = TELE.outMs + TELE.gapMs;
    const endAt = arriveAt + TELE.inMs;
    let arrived = false;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      ticker.remove(tick);
      if (!sprite.destroyed) sprite.destroy();
      revealWhen(mesh, data.fadeOut
        ? () => token.document?.hidden === true
        : () => Math.hypot(token.center.x - data.to.x, token.center.y - data.to.y) < 2);
    };
    const tick = () => {
      try {
        if (sprite.destroyed || !sprite.parent) return finish();
        const t = performance.now() - startedAt;
        if (t >= endAt || (data.fadeOut && t >= TELE.outMs)) return finish();
        if (t < TELE.outMs) {
          const e = easeIn(t / TELE.outMs);
          sprite.scale.set(baseX * mix(1, TELE.line.x, e), baseY * mix(1, TELE.line.y, e));
          sprite.alpha = 1 - e;
          return;
        }
        if (t < arriveAt) { sprite.alpha = 0; return; }
        if (!arrived) {
          arrived = true;
          sprite.position.set(to.x, to.y);
          const src = data.landSrc || data.takeoffSrc;
          if (src) window.oni.EventSystem.RowsMedia?.playSound?.(src, data.takeoffVolume ?? 0.6);
          lightBurst(host, to.x, to.y, heightPx * depthEnd);
        }
        const e = easeOut((t - arriveAt) / TELE.inMs);
        sprite.scale.set(baseX * depthEnd * mix(TELE.line.x, 1, e), baseY * depthEnd * mix(TELE.line.y, 1, e));
        sprite.alpha = e;
      } catch (e) {
        console.warn(INSTALL_TAG, "Teleport frame failed; dropping the effect.", e);
        finish();
      }
    };
    ticker.add(tick);
    Client.addCleanup(info?.sourceId, `jump.teleport.${data.tokenId}`, () => { if (!done) finish(); });
  }

  function playLevitate(data, info) {
    if (globalThis.FUCompanion?.api?.vfxSuppressed?.() === true) return;
    const token = canvas?.tokens?.get(data.tokenId);
    const mesh = token?.mesh;
    const host = canvas?.primary;
    if (!token || !mesh?.texture?.valid || !host) return;
    rowsToken()?.takeHeld?.(data.tokenId);

    const foot = footOffset(token, mesh);
    const at = { x: token.center.x + foot.x, y: token.center.y + foot.y };
    const heightPx = Math.abs(mesh.height);
    const riseMs = Math.max(200, Number(data.riseMs) || LEVITATE.riseMs);
    const risePx = Number.isFinite(Number(data.risePx)) ? Number(data.risePx) : LEVITATE.risePx;
    const suck = data.curve === "suck";
    const { pre, hover } = ascendTimes(data);
    const hoverPx = hover > 0 ? ASCEND.hoverPx : 0;
    const playSound = (src, vol) => { if (src) window.oni.EventSystem.RowsMedia?.playSound?.(src, vol ?? 0.6); };

    const sprite = copyOf(mesh, mesh.texture, "oniEventJumpLevitate");
    sprite.position.set(at.x, at.y);
    // The glow: an additive copy over the sprite (gold unless the row says), a touch larger.
    const glow = copyOf(mesh, mesh.texture, "oniEventJumpLevitateGlow");
    glow.tint = hexColor(data.glowColor, LEVITATE.glowColor);
    glow.blendMode = PIXI.BLEND_MODES.ADD;
    glow.sort = sprite.sort + 1;
    glow.alpha = 0;
    glow.position.set(at.x, at.y);
    glow.scale.set(mesh.scale.x * 1.06, mesh.scale.y * 1.03);
    host.addChild(sprite);
    host.addChild(glow);
    mesh.renderable = false;
    if (dustAtTakeoff(data.dust)) dust(at.x, at.y, heightPx, false, info?.sourceId);
    // Without a beam or a hover the take-off sound plays now, as before; otherwise at the pull.
    if (!pre && !hover) playSound(data.takeoffSrc, data.takeoffVolume);

    // Afterimages for the pull (suck): additive copies trailing below.
    const trail = [];
    if (suck) {
      for (let i = 0; i < ASCEND.trail; i++) {
        const g = copyOf(mesh, mesh.texture, "oniEventJumpLevitateTrail");
        g.blendMode = PIXI.BLEND_MODES.ADD; g.tint = 0xe6dcff; g.alpha = 0; g.sort = sprite.sort - 1; g.position.set(at.x, at.y);
        host.addChild(g); trail.push(g);
      }
    }
    const ys = [];   // recent sprite y, for the trail

    // The spin: the standing art for each direction, loaded now, used when ready.
    const spinTex = new Map();
    let spinFrom = 0;
    if (data.spin === true) {
      const sf = globalThis.FUCompanion?.api?.spriteFacing;
      const dir = sf?.getDirection?.(token) ?? "down";
      const side = sf?.getFacing?.(token) ?? "left";
      const startName = dir === "up" || dir === "down" ? dir : (side === "right" ? dir.replace("Left", "Right").replace(/^left$/, "right") : dir);
      spinFrom = Math.max(0, SPIN_ORDER.indexOf(startName));
      for (const name of SPIN_ORDER) Promise.resolve(sf?.standFor?.(token, name)).then((r) => { if (r?.texture?.valid) spinTex.set(name, r); }).catch(() => {});
    }
    let spinPhase = spinFrom, lastT = 0, shownSpin = null;
    const showSpin = (name) => {
      const r = spinTex.get(name);
      if (!r || shownSpin === name) return;
      shownSpin = name;
      const s = heightPx / (r.texture.height || 1), sx = (r.mirror ? -1 : 1) * s;
      for (const sp of [sprite, ...trail]) { sp.texture = r.texture; sp.scale.set(sx, s); }
      glow.texture = r.texture; glow.scale.set(sx * 1.06, s * 1.03);
      baseScale = { x: sx, y: s };
    };
    let baseScale = { x: mesh.scale.x, y: mesh.scale.y };

    // The beam: the pillar clip stretched from the top of the view to the feet.
    const beam = { shaft: null, base: null, video: null, texture: null, alpha: 1, hold: true, filter: null };
    const beamKind = data.beam && data.beam !== "none" ? (data.beam === "gold" ? "gold" : "violet") : null;
    if (beamKind) {
      playSound(data.beamSoundSrc, data.takeoffVolume);
      (async () => {
        try {
          const tex = await loadTexture(data.beamSrc || ASCEND.beamSrc);
          const src = tex?.baseTexture?.resource?.source;
          if (done || !(src instanceof HTMLVideoElement) || !game.video?.cloneTexture) return;
          const clone = await game.video.cloneTexture(src);
          const video = clone?.baseTexture?.resource?.source;
          if (done || !video) { try { clone?.destroy(true); } catch (_) {} return; }
          video.muted = true; video.loop = false;
          try { video.currentTime = 0; } catch (_) {}
          video.play().catch(() => {});
          const bt = clone.baseTexture, W = bt.width, H = bt.height, cut = Math.round(H * 290 / 384);
          beam.video = video; beam.texture = clone;
          beam.shaft = new PrimarySpriteMesh({ texture: new PIXI.Texture(bt, new PIXI.Rectangle(0, 0, W, cut)), name: "oniEventJumpBeam" });
          beam.base = new PrimarySpriteMesh({ texture: new PIXI.Texture(bt, new PIXI.Rectangle(0, cut, W, H - cut)), name: "oniEventJumpBeamBase" });
          const f = new PIXI.ColorMatrixFilter(); f.hue(ASCEND.beamHue[beamKind], false); if (beamKind === "violet") f.brightness(1.08, true);
          beam.filter = f;
          for (const s of [beam.shaft, beam.base]) {
            s.elevation = 0; s.sortLayer = PrimaryCanvasGroup.SORT_LAYERS.TOKENS; s.sort = sprite.sort - 2;
            s.blendMode = PIXI.BLEND_MODES.ADD; s.filters = beamKind === "gold" ? null : [f];
            host.addChild(s);
          }
          beam.shaft.anchor.set(0.5, 0); beam.base.anchor.set(0.5, 0);
          beam.t0 = performance.now();
        } catch (e) { console.warn(INSTALL_TAG, "Levitate beam failed; rising without it.", e); }
      })();
    }
    const placeBeam = (now) => {
      if (!beam.shaft || beam.shaft.destroyed) return;
      const v = beam.video;
      if (beam.hold && v && v.currentTime > ASCEND.beamLoop[1]) { try { v.currentTime = ASCEND.beamLoop[0]; } catch (_) {} }
      const W = beam.texture.baseTexture.width, k = (heightPx * ASCEND.beamWidthK) / (W || 1);
      const scale = canvas.stage.scale.y || 1, scrH = canvas.screenDimensions?.[1] ?? window.innerHeight;
      const viewTop = canvas.stage.pivot.y - scrH / 2 / scale - 20;
      const baseTop = at.y - 27 * k;
      const reveal = Math.min(1, (now - beam.t0) / ASCEND.beamRevealMs), bottom = viewTop + (baseTop - viewTop) * (1 - Math.pow(1 - reveal, 3));
      beam.shaft.position.set(at.x, viewTop);
      beam.shaft.scale.set(k, Math.max(0.001, bottom - viewTop) / (beam.shaft.texture.height || 1));
      beam.base.position.set(at.x, baseTop); beam.base.scale.set(k, k);
      beam.base.visible = reveal >= 0.95;
      beam.shaft.alpha = beam.base.alpha = beam.alpha;
    };

    // Players' cameras ride along, aimed a little above the middle.
    if (data.follow !== false) {
      window.oni.EventSystem.RowsCamera?.followPoint?.(info?.sourceId,
        () => (sprite.destroyed ? null : { x: sprite.x, y: sprite.y - heightPx * 0.7 }), pre + hover + riseMs + 400);
    }

    const ticker = canvas.app.ticker;
    const startedAt = performance.now();
    let done = false, pulled = false;
    const finish = () => {
      if (done) return;
      done = true;
      ticker.remove(tick);
      for (const s of [sprite, glow, ...trail]) if (!s.destroyed) s.destroy();
      // The beam fades out on its own, then lets go of its clip.
      if (beam.shaft && !beam.shaft.destroyed) {
        beam.hold = false;
        const t0 = performance.now();
        const fade = () => {
          const u = (performance.now() - t0) / 450;
          if (u >= 1 || beam.shaft.destroyed) {
            ticker.remove(fade);
            for (const s of [beam.shaft, beam.base]) if (s && !s.destroyed) s.destroy();
            try { beam.video?.pause(); } catch (_) {}
            try { beam.texture?.destroy(true); } catch (_) {}
            return;
          }
          beam.alpha = 1 - u; placeBeam(performance.now());
        };
        ticker.add(fade);
      } else {
        try { beam.texture?.destroy(true); } catch (_) {}
      }
      revealWhen(mesh, () => token.document?.hidden === true);
    };
    const tick = () => {
      try {
        if (sprite.destroyed || !sprite.parent) return finish();
        const now = performance.now(), t = now - startedAt, dt = Math.max(0, (t - lastT) / 1000); lastT = t;
        // Gone the moment the GM hides the token (under the flash), or a little after the rise.
        if (token.document?.hidden === true || t >= pre + hover + riseMs + 1500) return finish();
        placeBeam(now);

        // the spin: slow, then fast; it keeps going through the pull
        if (data.spin === true && t >= pre) {
          const ts = t - pre, rate = ts < hover
            ? ASCEND.spinRate[0] + (ASCEND.spinRate[1] - ASCEND.spinRate[0]) * easeInCubic(ts / hover)
            : ASCEND.spinRate[2];
          spinPhase += dt * rate;
          showSpin(SPIN_ORDER[Math.floor(spinPhase) % 8]);
        }

        let y = at.y, e = 0;
        if (t < pre) y = at.y;
        else if (t < pre + hover) y = at.y - hoverPx * easeInOut((t - pre) / hover);
        else {
          if (!pulled) { pulled = true; if (pre || hover) playSound(data.takeoffSrc, data.takeoffVolume); }
          const u = Math.min(1, (t - pre - hover) / riseMs);
          e = suck ? easeInCubic(u) : easeInOut(u);
          y = at.y - hoverPx - (risePx - hoverPx) * e;
        }
        sprite.y = y; glow.y = y;
        if (suck) {
          const sy = 1 + ASCEND.suckStretch.y * e, sx = 1 - ASCEND.suckStretch.x * e;
          sprite.scale.set(baseScale.x * sx, baseScale.y * sy);
          glow.scale.set(baseScale.x * sx * 1.06, baseScale.y * sy * 1.03);
          ys.unshift(y); if (ys.length > ASCEND.trail * 2) ys.pop();
          trail.forEach((g, i) => { const ty = ys[(i + 1) * 2]; if (ty === undefined) return; g.y = ty; g.scale.set(sprite.scale.x, sprite.scale.y); g.alpha = 0.35 * e * Math.pow(0.7, i); });
        }
        glow.alpha = LEVITATE.glowAlpha * Math.min(1, Math.max(0, t - (pre ? 380 : 0)) / 500) * (0.85 + 0.15 * Math.sin(t / 90));
      } catch (e) {
        console.warn(INSTALL_TAG, "Levitate frame failed; dropping the effect.", e);
        finish();
      }
    };
    ticker.add(tick);
    Client.addCleanup(info?.sourceId, `jump.levitate.${data.tokenId}`, () => { if (!done) finish(); });
  }

  Client.register(KIND_TELEPORT, (data, info) => playTeleport(data, info));
  Client.register(KIND_LEVITATE, (data, info) => playLevitate(data, info));

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
   * One teleport of each token in docs to the point `to`, paced on the GM: out
   * where it stands, in at `to`. opts.fadeOut: it never comes back in, and lands
   * hidden. Returns false if the event was ended mid-way.
   */
  async function teleport(docs, to, opts = {}, sourceId = null) {
    const list = (Array.isArray(docs) ? docs : [docs]).filter(Boolean);
    if (!list.length || !to) return true;
    const scene = list[0].parent;
    const grid = scene.grid.size;
    for (const doc of list) {
      Client.run(sourceId, KIND_TELEPORT, {
        tokenId: doc.id,
        from: centerOf(doc), to: { x: to.x, y: to.y },
        face: opts.face !== false,
        takeoffSrc: String(opts.takeoffSrc ?? ""),
        takeoffVolume: clamp(opts.takeoffVolume, 0, 1, 0.6),
        landSrc: String(opts.landSrc ?? ""),
        fadeOut: opts.fadeOut === true
      });
    }
    if (await pace(sourceId, TELE.outMs + TELE.gapMs) === false) return false;
    await scene.updateEmbeddedDocuments("Token", list.map(doc => ({
      _id: doc.id,
      x: to.x - (doc.width * grid) / 2,
      y: to.y - (doc.height * grid) / 2,
      ...(opts.fadeOut === true ? { hidden: true } : {})
    })), { animate: false, pan: false, oniJump: true });
    return opts.fadeOut === true ? true : (await pace(sourceId, TELE.inMs)) !== false;
  }

  /**
   * Levitate: each visible token in docs floats straight up out of view (players'
   * cameras follow it); near the top a flash (opts.flashColor, "" for none) and the
   * landing sound (opts.landSrc) take it, and it is hidden where it stood.
   * opts: risePx, riseMs, takeoffSrc, takeoffVolume, landSrc, flashColor, dust,
   * and (Sacrificial Altar) beam ("violet" | "gold" | "none"), beamSoundSrc, spin,
   * spinMs, curve ("smooth" | "suck"), glowColor. With a beam or a hover the
   * take-off sound plays as the pull starts.
   */
  async function levitate(docs, opts = {}, sourceId = null) {
    const list = (Array.isArray(docs) ? docs : [docs]).filter(Boolean);
    if (!list.length) return true;
    const scene = list[0].parent;
    const riseMs = clamp(opts.riseMs, 300, 10000, LEVITATE.riseMs);
    const risePx = clamp(opts.risePx, 0, 5000, LEVITATE.risePx);
    const curve = opts.curve === "suck" ? "suck" : "smooth";
    const beam = ["violet", "gold"].includes(opts.beam) ? opts.beam : "none";
    const spin = opts.spin === true;
    const spinMs = clamp(opts.spinMs, 300, 8000, ASCEND.spinMs);
    for (const doc of list.filter(d => !d.hidden)) {
      Client.run(sourceId, KIND_LEVITATE, {
        tokenId: doc.id, riseMs, risePx,
        follow: opts.follow !== false,
        dust: pickDust(opts.dust),
        takeoffSrc: String(opts.takeoffSrc ?? ""),
        takeoffVolume: clamp(opts.takeoffVolume, 0, 1, 0.6),
        curve, beam, spin, spinMs,
        beamSoundSrc: String(opts.beamSoundSrc ?? ""),
        glowColor: String(opts.glowColor ?? "")
      });
    }
    const { pre, hover } = ascendTimes({ beam, spin, spinMs, curve });
    if (pre + hover > 0 && await pace(sourceId, pre + hover) === false) return false;
    // A "suck" pull flashes as the token leaves the top of the screen; a smooth rise as before.
    const lead = curve === "suck" ? Math.round(riseMs * (1 - ASCEND.suckFlashAt)) : Math.min(LEVITATE.flashLeadMs, riseMs);
    if (await pace(sourceId, riseMs - lead) === false) return false;
    const flashColor = String(opts.flashColor ?? "#ffffff").trim();
    if (flashColor) Client.run(sourceId, "screen.effect", { effect: "flash", color: flashColor, durationMs: LEVITATE.flashMs });
    if (opts.landSrc) Client.run(sourceId, "sound.play", { src: String(opts.landSrc), volume: clamp(opts.takeoffVolume, 0, 1, 0.6) });
    if (await pace(sourceId, 60) === false) return false;
    await scene.updateEmbeddedDocuments("Token", list.map(doc => ({ _id: doc.id, hidden: true })));
    return (await pace(sourceId, Math.max(0, lead - 60))) !== false;
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
      const move = opts.style === "teleport" ? teleport : hop;
      if (!await move(list, points[i].at, hopOpts, sourceId)) return { ok: false, reason: "ended" };
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
    hop, teleport, levitate, path: jumpPath, leapOut, dropIn, resolvePoint, resolvePath, parsePartyOffset, clampToScene,
    HOP, LEAP, DROP, TELE, LEVITATE, LEAP_MS, DROP_MS
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
      style: "hop", dust: "none", fadeOut: false,
      risePx: LEVITATE.risePx, riseMs: LEVITATE.riseMs, flashColor: "#ffffff", follow: true,
      curve: "smooth", beam: "none", beamSoundSrc: "", spin: false, spinMs: ASCEND.spinMs, glowColor: ""
    },
    mediaOf: (row) => {
      const style = pickStyle(row?.style);
      const media = [style !== "dropIn" ? row?.takeoffSrc : "", style !== "leapOut" ? row?.landSrc : ""].filter(Boolean);
      if (style === "levitate" && ["violet", "gold"].includes(row?.beam)) media.push(ASCEND.beamSrc, ...(row?.beamSoundSrc ? [row.beamSoundSrc] : []));
      if (style === "teleport" || style === "levitate") return media;
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
      else if (style === "levitate") {
        const extra = [["violet", "gold"].includes(row?.beam) ? `in a ${row.beam} beam` : "", row?.spin === true ? "spinning" : "", row?.curve === "suck" ? "pulled up" : ""].filter(Boolean).join(", ");
        text = `${who} levitates up out of view${extra ? ` (${extra})` : ""}${String(row?.flashColor ?? "#ffffff").trim() ? " into a flash" : ""}`;
      }
      else if (style === "teleport") text = lines.length ? `${who} teleports → ${lines.join(" → ")}${row?.fadeOut === true ? ", vanishing" : ""}` : `${who} (no path)`;
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
      if (style === "levitate") {
        const ok = await levitate(docs, opts, sourceId);
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
        `<div class="oni-event-row-jump-levitate-wrap">${[
          kit.field(
            "Rise (px)",
            kit.numberInput("oni-event-row-jump-rise", clamp(row.risePx, 0, 5000, LEVITATE.risePx), { min: 0, max: 5000, step: 10 }),
            "How far up it floats, in map px."
          ),
          kit.field(
            "Rise time (ms)",
            kit.numberInput("oni-event-row-jump-rise-ms", clamp(row.riseMs, 300, 10000, LEVITATE.riseMs), { min: 300, max: 10000, step: 50 })
          ),
          kit.field(
            "End flash colour",
            `<input type="text" class="oni-event-row-jump-flash" value="${kit.escapeHTML(row.flashColor ?? "#ffffff")}" placeholder="#ffffff (empty: no flash)" />`,
            "A screen flash near the top of the rise takes the token; the landing sound plays with it. Empty: no flash."
          ),
          kit.field(
            "Camera",
            `<label><input type="checkbox" class="oni-event-row-jump-follow" ${row.follow !== false ? "checked" : ""} /> players' cameras follow it up</label>`
          ),
          kit.field(
            "Beam",
            `<select class="oni-event-row-jump-beam">${kit.options([["none", "None"], ["violet", "Violet beam from the sky"], ["gold", "Gold beam from the sky"]], ["violet", "gold"].includes(row.beam) ? row.beam : "none")}</select>`,
            "A pillar of light falls on the token first (1.3 s), from the top of the screen to its feet, and stays while it rises."
          ),
          kit.field("Beam sound", kit.fileInput("oni-event-row-jump-beam-sound", row.beamSoundSrc ?? "", "audio", "Sound as the beam falls (empty: none)")),
          kit.field(
            "Spin",
            `<label><input type="checkbox" class="oni-event-row-jump-spin" ${row.spin === true ? "checked" : ""} /> spin through the 8 standing directions, slow then fast, before the pull</label>
             ${kit.numberInput("oni-event-row-jump-spin-ms", clamp(row.spinMs, 300, 8000, ASCEND.spinMs), { min: 300, max: 8000, step: 50 })} ms`,
            "Uses the character's directional standing art (Character sheet sprites); a missing direction borrows the nearest one, as walking does."
          ),
          kit.field(
            "Rise",
            `<select class="oni-event-row-jump-curve">${kit.options([["smooth", "Smooth (ease in and out)"], ["suck", "Pulled up: hover, then speed up and stretch"]], row.curve === "suck" ? "suck" : "smooth")}</select>`,
            "Pulled up: the flash comes as the token leaves the top of the screen. With a beam or a spin, the take-off sound plays as the pull starts."
          ),
          kit.field(
            "Glow colour",
            `<input type="text" class="oni-event-row-jump-glow" value="${kit.escapeHTML(row.glowColor ?? "")}" placeholder="#ffd678 (gold, the default)" />`
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
        body.querySelector(".oni-event-row-jump-path-wrap").hidden = styleEl.value === "leapOut" || styleEl.value === "levitate";
        body.querySelector(".oni-event-row-jump-hop-wrap").hidden = styleEl.value !== "hop" && styleEl.value !== "teleport";
        body.querySelector(".oni-event-row-jump-levitate-wrap").hidden = styleEl.value !== "levitate";
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
      risePx: clamp(kit.readNumber(rowEl, ".oni-event-row-jump-rise", LEVITATE.risePx), 0, 5000, LEVITATE.risePx),
      riseMs: clamp(kit.readNumber(rowEl, ".oni-event-row-jump-rise-ms", LEVITATE.riseMs), 300, 10000, LEVITATE.riseMs),
      flashColor: kit.readText(rowEl, ".oni-event-row-jump-flash", "#ffffff").trim(),
      follow: !!kit.own(rowEl, ".oni-event-row-jump-follow")?.checked,
      beam: (v => (["violet", "gold"].includes(v) ? v : "none"))(kit.readText(rowEl, ".oni-event-row-jump-beam", "none")),
      beamSoundSrc: kit.readText(rowEl, ".oni-event-row-jump-beam-sound", "").trim(),
      spin: !!kit.own(rowEl, ".oni-event-row-jump-spin")?.checked,
      spinMs: clamp(kit.readNumber(rowEl, ".oni-event-row-jump-spin-ms", ASCEND.spinMs), 300, 8000, ASCEND.spinMs),
      curve: kit.readText(rowEl, ".oni-event-row-jump-curve", "smooth") === "suck" ? "suck" : "smooth",
      glowColor: kit.readText(rowEl, ".oni-event-row-jump-glow", "").trim(),
      dust: pickDust(kit.readText(rowEl, ".oni-event-row-jump-dust", "none"))
    })
  });

  window.oni.EventSystem.RowsJump = { installed: true };
  console.debug(INSTALL_TAG, "Installed.");
})();
