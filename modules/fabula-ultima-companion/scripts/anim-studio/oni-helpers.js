// ============================================================================
// Anim Studio — `oni` inner-script helper library
//
// Injected as the extra `oni` argument into every pseudo-animation inner
// scriptSource (see pseudoAnimation-listener.js). Codifies the proven visual
// recipes from the animation-authoring guide so each becomes a one-liner
// instead of 40 hand-written lines that re-hit the token-hide / screen-lock /
// backtick footguns.
//
// ADDITIVE + BACKWARD-COMPATIBLE: existing inner scripts don't reference `oni`
// and are unaffected. New scripts opt in by calling oni.* .
//
// Runs on EVERY client (the inner script is broadcast + executed per-client),
// so this module is imported by the listener, which loads everywhere.
//
// Built PER-RUN via buildOni(ctx, env) so `screen()` snapshots the CURRENT
// stage transform and token clones reference this run's caster/targets. All
// PIXI/canvas access goes through the passed `env` (the inner function scope
// does NOT receive `game`).
// ============================================================================

// ── Easing ──────────────────────────────────────────────────────────────────
export const EASE = {
  linear: (t) => t,
  inQuad: (t) => t * t,
  outQuad: (t) => 1 - (1 - t) * (1 - t),
  inOutQuad: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  inCubic: (t) => t * t * t,
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
};

// Inject the screenshake keyframes once per document.
function ensureShakeStyle() {
  if (document.getElementById("oni-anim-shake-style")) return;
  const el = document.createElement("style");
  el.id = "oni-anim-shake-style";
  el.textContent = `
    @keyframes oni-anim-shake {
      0%,100% { transform: translate(0,0); }
      20% { transform: translate(calc(var(--oni-shake,6px) * -1), var(--oni-shake,6px)); }
      40% { transform: translate(var(--oni-shake,6px), calc(var(--oni-shake,6px) * -1)); }
      60% { transform: translate(calc(var(--oni-shake,6px) * -0.6), calc(var(--oni-shake,6px) * 0.6)); }
      80% { transform: translate(calc(var(--oni-shake,6px) * 0.6), calc(var(--oni-shake,6px) * -0.6)); }
    }
    .oni-anim-shaking { animation: oni-anim-shake 90ms linear infinite; }
  `;
  document.head.appendChild(el);
}

export function buildOni(ctx, env) {
  const { canvas, PIXI, wait, loadTexture } = env;
  const app = canvas?.app ?? null;
  const ticker = app?.ticker ?? null;

  // Track everything we create so a single dispose() (or the caller's finally)
  // can guarantee no PIXI leak — the smoke test asserts stage returns to
  // baseline. hideToken restores are tracked here too.
  const _disposers = [];
  const track = (fn) => { if (typeof fn === "function") _disposers.push(fn); return fn; };

  // ── Ticker tween ────────────────────────────────────────────────────────
  function tween({ from = 0, to = 1, duration = 300, ease = EASE.linear, onUpdate, onComplete } = {}) {
    return new Promise((resolve) => {
      if (!ticker) { onUpdate?.(to, 1); onComplete?.(); return resolve(); }
      const t0 = performance.now();
      const tick = () => {
        const t = duration > 0 ? Math.min(1, (performance.now() - t0) / duration) : 1;
        try { onUpdate?.(from + (to - from) * ease(t), t); } catch (e) { /* keep ticking */ }
        if (t >= 1) { ticker.remove(tick); try { onComplete?.(); } catch {} resolve(); }
      };
      ticker.add(tick);
      _disposers.push(() => ticker.remove(tick));
    });
  }

  // ── Screen-lock transforms (snapshot once) ───────────────────────────────
  function screen() {
    const W = app?.renderer?.screen?.width ?? window.innerWidth;
    const H = app?.renderer?.screen?.height ?? window.innerHeight;
    const WT = canvas.stage.worldTransform.clone();
    const zoom = canvas.stage.scale?.x || 1;
    const S2W = (fx, fy) => WT.applyInverse(new PIXI.Point(fx * W, fy * H));
    const wLen = (px) => px / zoom;
    const hPx = (frac) => wLen(frac * H);
    return { W, H, zoom, WT, S2W, wLen, hPx };
  }

  // A high-zIndex container on the stage for overlay art; auto-tracked.
  function layer({ zIndex = 90000 } = {}) {
    canvas.stage.sortableChildren = true;
    const c = new PIXI.Container();
    c.zIndex = zIndex;
    c.sortableChildren = true;
    canvas.stage.addChild(c);
    track(() => { try { c.destroy({ children: true }); } catch {} });
    return c;
  }

  // ── Token helpers ─────────────────────────────────────────────────────────

  // Sprite clone of a token's RENDERED mesh (folds in facing + mirror).
  function cloneToken(token, { parent = null } = {}) {
    const mesh = token?.mesh;
    if (!mesh?.texture) return null;
    const spr = new PIXI.Sprite(mesh.texture);
    spr.anchor.set(0.5);
    spr.width = mesh.width;
    spr.height = mesh.height;
    spr.position.set(token.center.x, token.center.y);
    spr.angle = mesh.angle ?? 0;
    // Flip = sign of the rendered mesh scale (Mirror-H + facing), NOT doc.texture.
    spr.scale.x = Math.abs(spr.scale.x) * (Math.sign(mesh.scale?.x || 1) || 1);
    (parent ?? canvas.stage).addChild(spr);
    track(() => { try { spr.destroy(); } catch {} });
    return spr;
  }

  // Hide a token robustly (renderable=false re-asserted each tick; a cull pass
  // can flip it back). Returns a restore fn; also auto-restored on dispose().
  function hideToken(token) {
    if (!token) return () => {};
    const guard = () => {
      try { token.renderable = false; if (token.mesh) token.mesh.renderable = false; } catch {}
    };
    guard();
    ticker?.add(guard);
    let restored = false;
    const restore = () => {
      if (restored) return; restored = true;
      ticker?.remove(guard);
      try {
        token.renderable = true;
        if (token.mesh) token.mesh.renderable = true;
        token.renderFlags?.set?.({ refreshVisibility: true, refreshMesh: true, refreshState: true });
      } catch {}
    };
    _disposers.push(restore);
    return restore;
  }

  // ── Generated textures ────────────────────────────────────────────────────

  // Vertical gradient (e.g. sky). stops = [[offset0..1, "#rrggbb"], …].
  function gradientTexture(stops, { width = 8, height = 256 } = {}) {
    const cv = document.createElement("canvas");
    cv.width = width; cv.height = height;
    const g2 = cv.getContext("2d");
    const grad = g2.createLinearGradient(0, 0, 0, height);
    for (const [off, col] of stops) grad.addColorStop(off, col);
    g2.fillStyle = grad; g2.fillRect(0, 0, width, height);
    return PIXI.Texture.from(cv);
  }

  // Radial gradient (glow / soft shadow). Use blendMode ADD for light.
  function radialTexture(inner = "rgba(255,255,255,1)", outer = "rgba(255,255,255,0)", { size = 256 } = {}) {
    const cv = document.createElement("canvas");
    cv.width = cv.height = size;
    const g2 = cv.getContext("2d");
    const r = size / 2;
    const grad = g2.createRadialGradient(r, r, 0, r, r, r);
    grad.addColorStop(0, inner);
    grad.addColorStop(1, outer);
    g2.fillStyle = grad; g2.fillRect(0, 0, size, size);
    return PIXI.Texture.from(cv);
  }

  // webm as a sprite — fresh <video> per use (never mutate Foundry's shared
  // texture cache). Returns { sprite, video }. Set loop, or listen 'ended'.
  function webmSprite(url, { loop = false, parent = null, autoplay = true } = {}) {
    const vid = document.createElement("video");
    vid.src = url; vid.crossOrigin = "anonymous"; vid.loop = loop; vid.muted = true;
    vid.playsInline = true;
    const tex = PIXI.Texture.from(vid);
    const spr = new PIXI.Sprite(tex);
    spr.anchor.set(0.5);
    (parent ?? canvas.stage).addChild(spr);
    if (autoplay) vid.play?.().catch(() => {});
    track(() => { try { spr.destroy(); } catch {} try { vid.pause(); vid.src = ""; } catch {} });
    return { sprite: spr, video: vid };
  }

  // ── Full-screen effects ─────────────────────────────────────────────────

  // Whiteout impact: fade a full-screen sheet in, fire onPeak at the top (the
  // damage moment), hold, fade out. Screen-locked under any pan/zoom.
  async function whiteout({ fadeIn = 160, hold = 100, fadeOut = 240, color = 0xffffff, alpha = 1, onPeak = null, zIndex = 100000 } = {}) {
    const s = screen();
    const g = new PIXI.Graphics();
    const tl = s.S2W(0, 0);
    g.beginFill(color, 1).drawRect(tl.x, tl.y, s.wLen(s.W), s.wLen(s.H)).endFill();
    g.alpha = 0; g.zIndex = zIndex;
    canvas.stage.sortableChildren = true;
    canvas.stage.addChild(g);
    const cleanup = track(() => { try { g.destroy(); } catch {} });

    await tween({ from: 0, to: alpha, duration: fadeIn, ease: EASE.outQuad, onUpdate: (v) => (g.alpha = v) });
    try { onPeak?.(); } catch (e) { console.warn("[oni] whiteout onPeak threw", e); }
    if (hold > 0) await wait(hold);
    await tween({ from: alpha, to: 0, duration: fadeOut, ease: EASE.inQuad, onUpdate: (v) => (g.alpha = v) });
    cleanup();
  }

  // Blackout — a whiteout to black. Same fade-in → onPeak → hold → fade-out
  // envelope; use for ominous cut-to-black / scene transitions.
  async function blackout(opts = {}) {
    return whiteout({ color: 0x000000, fadeIn: 200, hold: 120, fadeOut: 300, ...opts });
  }

  // Cinematic dim sheet (returns { fadeOut }). Handy behind cut-ins / charges.
  async function dim({ to = 0.6, fadeIn = 200, color = 0x000000, zIndex = 80000 } = {}) {
    const s = screen();
    const g = new PIXI.Graphics();
    const tl = s.S2W(0, 0);
    g.beginFill(color, 1).drawRect(tl.x, tl.y, s.wLen(s.W), s.wLen(s.H)).endFill();
    g.alpha = 0; g.zIndex = zIndex;
    canvas.stage.sortableChildren = true;
    canvas.stage.addChild(g);
    const destroy = track(() => { try { g.destroy(); } catch {} });
    await tween({ from: 0, to, duration: fadeIn, ease: EASE.outQuad, onUpdate: (v) => (g.alpha = v) });
    return {
      graphic: g,
      fadeOut: async ({ duration = 220 } = {}) => {
        await tween({ from: g.alpha, to: 0, duration, ease: EASE.inQuad, onUpdate: (v) => (g.alpha = v) });
        destroy();
      },
    };
  }

  // Screenshake — CSS transform on the PIXI canvas element.
  function screenshake({ duration = 380, intensity = 7 } = {}) {
    ensureShakeStyle();
    const view = app?.view;
    if (!view) return;
    view.style.setProperty("--oni-shake", `${intensity}px`);
    view.classList.add("oni-anim-shaking");
    const stop = () => { try { view.classList.remove("oni-anim-shaking"); } catch {} };
    const timer = setTimeout(stop, duration);
    _disposers.push(() => { clearTimeout(timer); stop(); });
  }

  // ── SFX ─────────────────────────────────────────────────────────────────

  // Resolve a manifest name (or pass a full URL through) → URL.
  function sfxUrl(nameOrUrl, opts) {
    if (!nameOrUrl) return null;
    if (/^https?:\/\//i.test(nameOrUrl) || nameOrUrl.startsWith("/")) return nameOrUrl;
    const r = globalThis.ONI_SFX?.(nameOrUrl, opts);
    return r ?? null;
  }

  // Play an SFX by manifest name (or URL). Returns the Audio element.
  // Non-fatal on missing manifest / 404 (matches the house convention).
  // fadeAfter/fadeMs exist because several library sounds ring on long past the
  // shot that triggered them — a wind bed still blowing after the dragon has
  // finished breathing reads as a bug, not atmosphere. Fading beats picking a
  // different sound: the attack of the sample is usually the part you wanted.
  function sfx(nameOrUrl, { volume = 1, rate = 1, delay = 0, fadeAfter = 0, fadeMs = 400 } = {}) {
    const url = sfxUrl(nameOrUrl);
    if (!url) { console.warn("[oni] sfx not found:", nameOrUrl); return null; }
    const play = () => {
      try {
        const a = new Audio(url);
        a.volume = Math.max(0, Math.min(1, volume));
        a.playbackRate = rate;
        a.play().catch(() => {});
        if (fadeAfter > 0) {
          const t0 = setTimeout(() => {
            const v0 = a.volume;
            const start = performance.now();
            const step = () => {
              const p = fadeMs > 0 ? Math.min(1, (performance.now() - start) / fadeMs) : 1;
              try { a.volume = Math.max(0, v0 * (1 - p)); } catch {}
              if (p >= 1) { try { a.pause(); } catch {} return; }
              requestAnimationFrame(step);
            };
            step();
          }, fadeAfter);
          _disposers.push(() => clearTimeout(t0));
        }
        return a;
      } catch (e) { console.warn("[oni] sfx play failed", e); return null; }
    };
    if (delay > 0) { const t = setTimeout(play, delay); _disposers.push(() => clearTimeout(t)); return null; }
    return play();
  }

  // ── Damage gate ───────────────────────────────────────────────────────────

  // Fire the BD damage gate (oni:animationEnd via the doneHook the outer script
  // set). Call this at the impact moment so damage lands on impact.
  function fireDone() {
    const hook = ctx?.params?.doneHook;
    if (hook) { try { Hooks.callAll(hook); } catch (e) { console.warn("[oni] fireDone threw", e); } }
  }

  // Tear down everything created via this helper (idempotent). The listener
  // calls this in a finally after the inner script resolves, so even a script
  // that forgets to clean up leaves the stage at baseline.
  function dispose() {
    for (const fn of _disposers.splice(0).reverse()) { try { fn(); } catch {} }
  }

  // ── Camera-proof screen space (live transform) ───────────────────────────
  //
  // `screen()` above snapshots the world transform ONCE, which is correct only
  // while the camera is still. Any script that pans or zooms mid-sequence must
  // use this instead: every accessor re-reads canvas.stage.worldTransform at
  // call time, so a world-anchored overlay stays glued to the screen through a
  // pan. Same shape as screen(), so the two are drop-in interchangeable.
  //
  // (Flat full-screen washes should prefer domDim/domFlash below — those are
  // real screen space and need no re-projection at all.)
  function screenLive() {
    const api = {
      get W() { return app?.renderer?.screen?.width ?? window.innerWidth; },
      get H() { return app?.renderer?.screen?.height ?? window.innerHeight; },
      get zoom() { return canvas.stage.scale?.x || 1; },
      get WT() { return canvas.stage.worldTransform; },
      S2W: (fx, fy) => canvas.stage.worldTransform.applyInverse(
        new PIXI.Point(fx * api.W, fy * api.H),
      ),
      wLen: (px) => px / (canvas.stage.scale?.x || 1),
      hPx: (frac) => (frac * api.H) / (canvas.stage.scale?.x || 1),
    };
    return api;
  }

  // ── Screen-space DOM overlays ────────────────────────────────────────────
  //
  // A PIXI Graphics sheet lives in WORLD space, so it slides off-screen the
  // moment the camera moves. A position:fixed div projected from the canvas
  // element's client rect is true screen space and is immune to pan/zoom — the
  // idiom already shipped in battle-end/followups/wandering-flame-entrance.js.
  //
  // Trade-off: DOM sits ABOVE the whole PIXI canvas, so world-space art cannot
  // render over it. Use these for flat washes (dim / whiteout / colour flash)
  // and keep anything that must appear on top in DOM too.
  //
  // z-index stays under 100 so Foundry app windows (sheets/config) still cover
  // it, matching domination-crest.js's ordering contract.
  const DOM_Z = { dim: 70, flash: 75 };

  function domSheet({ color = "#000", zIndex = DOM_Z.dim } = {}) {
    const view = app?.view;
    const el = document.createElement("div");
    el.className = "oni-anim-sheet";
    el.style.cssText = [
      "position: fixed",
      "pointer-events: none",
      "opacity: 0",
      "background: " + color,
      "z-index: " + zIndex,
    ].join("; ");
    const place = () => {
      const r = view?.getBoundingClientRect?.();
      if (!r) { el.style.inset = "0"; return; }
      el.style.left = r.left + "px";
      el.style.top = r.top + "px";
      el.style.width = r.width + "px";
      el.style.height = r.height + "px";
    };
    place();
    window.addEventListener("resize", place);
    document.body.appendChild(el);
    track(() => {
      window.removeEventListener("resize", place);
      try { el.remove(); } catch {}
    });
    return el;
  }

  // Cinematic dim in screen space. Returns { el, fadeOut }.
  async function domDim({ to = 0.6, fadeIn = 400, color = "#000", zIndex = DOM_Z.dim } = {}) {
    const el = domSheet({ color, zIndex });
    await tween({
      from: 0, to, duration: fadeIn, ease: EASE.inOutQuad,
      onUpdate: (v) => { el.style.opacity = String(v); },
    });
    return {
      el,
      fadeOut: async ({ duration = 500 } = {}) => {
        const from = Number(el.style.opacity) || 0;
        await tween({
          from, to: 0, duration, ease: EASE.inOutQuad,
          onUpdate: (v) => { el.style.opacity = String(v); },
        });
        try { el.remove(); } catch {}
      },
    };
  }

  // ── Scene dim (the RIGHT layer for a spotlight dim) ──────────────────────
  //
  // A dim and a curtain are different tools and belong at different depths:
  //
  //   dim      — darkens the SCENE so the subject and its VFX pop. It must sit
  //              ABOVE the background art and tiles but BELOW the tokens and
  //              the effect layers. Everything the shot is about stays lit.
  //   curtain  — whiteout / blackout for a transition or an impact. Sits above
  //              essentially everything. That is domFlash, above.
  //
  // domDim cannot be a dim: DOM sits above the entire PIXI canvas, so it buries
  // the clones and VFX it is supposed to be highlighting.
  //
  // Token sprites live in canvas.primary (PrimaryCanvasGroup) next to the
  // background and tiles, so the sheet has to go INSIDE that group. The group
  // re-sorts its children on its own schedule, so rather than fight its
  // comparator we re-assert the child index every frame: immediately below the
  // lowest Token child. Cheap, and deterministic no matter how it sorts.
  //
  // Anything drawn via oni.layer() lives on canvas.stage, which renders above
  // the whole rendered group — so VFX and token clones are automatically above
  // this dim, which is exactly the intent.
  //
  // World space, so the rect is redrawn from the LIVE transform each frame and
  // a camera pan or zoom cannot slide it off.
  async function sceneDim({ to = 0.6, fadeIn = 400, color = 0x000000 } = {}) {
    const primary = canvas?.primary;
    const g = new PIXI.Graphics();
    g.alpha = 0;
    (primary ?? canvas.stage).addChild(g);

    const S = screenLive();
    const redraw = () => {
      const tl = S.S2W(0, 0);
      g.clear();
      // Overdraw by half a screen on each side so a mid-fade camera move never
      // exposes an undimmed edge.
      g.beginFill(color, 1)
        .drawRect(tl.x - S.wLen(S.W) * 0.5, tl.y - S.wLen(S.H) * 0.5, S.wLen(S.W) * 2, S.wLen(S.H) * 2)
        .endFill();
    };

    const reindex = () => {
      if (!primary || g.destroyed) return;
      const kids = primary.children;
      let firstToken = -1;
      for (let i = 0; i < kids.length; i++) {
        const n = kids[i]?.name;
        if (typeof n === "string" && n.startsWith("Token.")) { firstToken = i; break; }
      }
      const want = firstToken < 0 ? kids.length - 1 : Math.max(0, firstToken - 1);
      const cur = kids.indexOf(g);
      if (cur >= 0 && cur !== want) {
        try { primary.setChildIndex(g, Math.min(want, kids.length - 1)); } catch {}
      }
    };

    const tick = () => { redraw(); reindex(); };
    tick();
    ticker?.add(tick);

    let removed = false;
    const destroy = () => {
      if (removed) return; removed = true;
      ticker?.remove(tick);
      try { g.destroy(); } catch {}
    };
    _disposers.push(destroy);

    await tween({
      from: 0, to, duration: fadeIn, ease: EASE.inOutQuad,
      onUpdate: (v) => { g.alpha = v; },
    });

    return {
      graphic: g,
      fadeOut: async ({ duration = 500 } = {}) => {
        await tween({
          from: g.alpha, to: 0, duration, ease: EASE.inOutQuad,
          onUpdate: (v) => { if (!g.destroyed) g.alpha = v; },
        });
        destroy();
      },
    };
  }

  // Screen-space colour flash (whiteout / element-tinted hit flash). onPeak
  // fires at full opacity — the damage moment for an impact whiteout.
  async function domFlash({
    color = "#fff", fadeIn = 220, hold = 140, fadeOut = 420,
    alpha = 1, onPeak = null, zIndex = DOM_Z.flash,
  } = {}) {
    const el = domSheet({ color, zIndex });
    await tween({
      from: 0, to: alpha, duration: fadeIn, ease: EASE.outQuad,
      onUpdate: (v) => { el.style.opacity = String(v); },
    });
    try { onPeak?.(); } catch (e) { console.warn("[oni] domFlash onPeak threw", e); }
    if (hold > 0) await wait(hold);
    await tween({
      from: alpha, to: 0, duration: fadeOut, ease: EASE.inOutQuad,
      onUpdate: (v) => { el.style.opacity = String(v); },
    });
    try { el.remove(); } catch {}
  }

  // ── webm (replaces the broken webmSprite) ────────────────────────────────
  //
  // webmSprite uses PIXI.Texture.from(video), which in this Foundry v12/PIXI
  // build never binds the video: tex.valid stays false and orig.width is 1, so
  // sprite.width = N scales a 1x1 and renders nothing. Foundry's loadTexture()
  // returns a VALID video texture. Async — always await it.
  async function webm(url, {
    size = 400, x = 0, y = 0, parent = null, loop = false,
    zIndex = 95000, blend = null, alpha = 1, angle = 0,
    // Foundry caches video textures by URL, so several sprites of the same clip
    // SHARE one <video>. Restarting it then yanks every existing sprite back to
    // frame 0 in lockstep, which is very visible when the clip is used as
    // scattered decoration. Pass restart:false for those.
    restart = true,
  } = {}) {
    let tex = null;
    try { tex = await loadTexture?.(url); } catch (e) { console.warn("[oni] webm load failed", url, e); }
    if (!tex) return null;
    const ratio = (tex.orig?.width && tex.orig?.height) ? tex.orig.height / tex.orig.width : 1;
    const spr = new PIXI.Sprite(tex);
    spr.anchor.set(0.5);
    spr.width = size;
    spr.height = size * ratio;
    spr.position.set(x, y);
    spr.zIndex = zIndex;
    spr.alpha = alpha;
    spr.angle = angle;
    if (blend != null) spr.blendMode = blend;
    (parent ?? canvas.stage).addChild(spr);
    const vid = tex.baseTexture?.resource?.source ?? null;
    if (vid) {
      try {
        vid.loop = loop;
        if (restart) vid.currentTime = 0;
        vid.play?.().catch(() => {});
      } catch {}
    }
    track(() => {
      try { spr.destroy(); } catch {}
      try { if (vid) vid.pause(); } catch {}
    });
    // Failsafe on `ended`: a hidden tab or a stalled decode must never hang the
    // sequence behind an await that will not resolve.
    const ended = new Promise((resolve) => {
      if (!vid || loop) return resolve();
      let settled = false;
      const done = () => {
        if (settled) return; settled = true;
        try { vid.removeEventListener("ended", done); } catch {}
        resolve();
      };
      vid.addEventListener("ended", done);
      const t = setTimeout(done, 8000);
      _disposers.push(() => clearTimeout(t));
    });
    return { sprite: spr, video: vid, ended };
  }

  // ── Particle emitter ─────────────────────────────────────────────────────
  //
  // One emitter covers the three shapes every template in this pass needs:
  //   burst  — radiate outward from origin (impacts, elemental bursts)
  //   gather — converge INWARD onto origin (charge-ups, drains)
  //   stream — directional flow origin → toward (breath, MP drain trails)
  //
  // Positions are WORLD coordinates. Returns a promise resolving when the last
  // particle dies, so a caller can await the tail.
  function particles({
    x = 0, y = 0, toX = null, toY = null,
    count = 24, color = 0xffffff, size = 10, sizeJitter = 0.5,
    radius = 160, radiusJitter = 0.4,
    life = 900, lifeJitter = 0.3, stagger = 0,
    gravity = 0, mode = "burst", parent = null, blend = null,
    alphaFrom = 1, alphaTo = 0, ease = EASE.outQuad,
  } = {}) {
    const host = parent ?? layer({ zIndex: 94000 });
    const r8 = (color >> 16) & 255, g8 = (color >> 8) & 255, b8 = color & 255;
    const tex = radialTexture(
      "rgba(" + r8 + "," + g8 + "," + b8 + ",1)",
      "rgba(" + r8 + "," + g8 + "," + b8 + ",0)",
      { size: 64 },
    );
    const jit = (base, amt) => base * (1 + (Math.random() * 2 - 1) * amt);
    const runs = [];
    for (let i = 0; i < count; i++) {
      const ang = Math.random() * Math.PI * 2;
      const rad = jit(radius, radiusJitter);
      const spr = new PIXI.Sprite(tex);
      spr.anchor.set(0.5);
      const px = jit(size, sizeJitter);
      spr.width = spr.height = px;
      if (blend != null) spr.blendMode = blend;
      host.addChild(spr);

      let sx, sy, ex, ey;
      if (mode === "gather") {
        sx = x + Math.cos(ang) * rad; sy = y + Math.sin(ang) * rad;
        ex = x; ey = y;
      } else if (mode === "stream" && toX != null && toY != null) {
        // Fan out around the origin, converge loosely on the destination.
        const spread = rad * 0.35;
        sx = x + Math.cos(ang) * spread * 0.4;
        sy = y + Math.sin(ang) * spread * 0.4;
        ex = toX + Math.cos(ang) * spread;
        ey = toY + Math.sin(ang) * spread;
      } else {
        sx = x; sy = y;
        ex = x + Math.cos(ang) * rad; ey = y + Math.sin(ang) * rad;
      }
      spr.position.set(sx, sy);
      spr.alpha = 0;

      const dur = jit(life, lifeJitter);
      const delay = stagger > 0 ? Math.random() * stagger : 0;
      runs.push(
        (delay > 0 ? wait(delay) : Promise.resolve()).then(() =>
          tween({
            from: 0, to: 1, duration: dur, ease,
            onUpdate: (t) => {
              spr.position.set(
                sx + (ex - sx) * t,
                sy + (ey - sy) * t + gravity * t * t,
              );
              spr.alpha = alphaFrom + (alphaTo - alphaFrom) * t;
            },
            onComplete: () => { try { spr.destroy(); } catch {} },
          }),
        ),
      );
    }
    return Promise.all(runs);
  }

  // ── Camera ───────────────────────────────────────────────────────────────
  //
  // Routed through FUCompanion.api.camera so every move is clamped to the
  // artwork (a raw canvas.animatePan can sail into the bleed / void). `zoom` is
  // a MULTIPLE OF REST SCALE, so 1 is the resting framing on every client
  // regardless of window size — and 1 is therefore a NO-OP, because rest
  // framing already contains the whole stage. Any pan beat must zoom in.
  //
  // home is captured on first use and restore is auto-registered as a disposer,
  // so a script that throws still hands the camera back.
  function makeCamera() {
    const capi = () => globalThis.FUCompanion?.api?.camera ?? null;
    let home = null;

    // Write the stage transform DIRECTLY.
    //
    // Driving the transform ourselves (rather than canvas.pan / animatePan) keeps
    // a cinematic independent of whatever else wants to move the camera: modules
    // that patch those prototypes, Foundry own re-framing on canvasReady, and the
    // canvasPan listeners that re-fit the view. A shot should play the same way
    // regardless of what is installed.
    //
    // Targets still come from FUCompanion.api.camera.resolveIntent, so the stage
    // rect and the on-artwork clamp are the shared ones — this bypasses the
    // plumbing, not the rules.
    const apply = (v) => {
      canvas.stage.pivot.set(v.x, v.y);
      canvas.stage.scale.set(v.scale, v.scale);
      try { canvas.updateBlur?.(); } catch {}
      try { canvas.hud?.align?.(); } catch {}
      try { canvas.scene._viewPosition = { x: v.x, y: v.y, scale: v.scale }; } catch {}
    };

    // Where the camera should end up. On a v2 conflict scene that is the
    // authored REST framing, not wherever the camera happened to be when this
    // shot started: if a previous shot left it wide, captured home would carry
    // that error forward and the framing would ratchet out over a fight.
    const homeTarget = () => {
      const c = capi();
      try {
        if (c?.hasStageRect?.(canvas.scene) && c?.restViewFor) return c.restViewFor(canvas.scene);
      } catch { /* fall through */ }
      return home;
    };

    let restored = false;

    const capture = () => {
      if (home) return home;
      const st = canvas.stage;
      home = { x: st.pivot.x, y: st.pivot.y, scale: st.scale.x };
      // Hand the camera to this shot: the authority stops clamping, and a
      // sidebar toggle defers its re-frame until we are done rather than
      // fighting the choreography mid-move.
      try { globalThis.FUCompanion?.api?.cameraAuthority?.suspend?.(); } catch {}
      _disposers.push(() => { try { globalThis.FUCompanion?.api?.cameraAuthority?.resume?.(); } catch {} });
      // Safety net for a script that throws before restoring. It must resolve
      // the SAME target restore() would, or it silently undoes it — dispose()
      // runs after the script body, so a naive apply(home) here wins.
      _disposers.push(() => {
        if (restored) return;
        try { apply(homeTarget()); } catch {}
      });
      return home;
    };

    // zoom is a MULTIPLE OF REST SCALE. Rest framing already contains the whole
    // stage, so >1 pushes in and <1 pulls out to show more of the bleed.
    const resolve = ({ point, zoom }) => {
      const c = capi();
      if (c?.resolveIntent) return c.resolveIntent({ point, zoom }, canvas.scene);
      const st = canvas.stage;
      return { x: point?.x ?? st.pivot.x, y: point?.y ?? st.pivot.y, scale: (st.scale.x || 1) * (zoom || 1) };
    };

    const glide = (to, duration, ease) => {
      const st = canvas.stage;
      const from = { x: st.pivot.x, y: st.pivot.y, scale: st.scale.x };
      return tween({
        from: 0, to: 1, duration, ease: ease || EASE.inOutQuad,
        onUpdate: (t) => apply({
          x: from.x + (to.x - from.x) * t,
          y: from.y + (to.y - from.y) * t,
          scale: from.scale + (to.scale - from.scale) * t,
        }),
      });
    };

    return {
      capture,
      home: () => home,
      apply,
      async focus({ point, zoom = 1.4, duration = 900, ease = null } = {}) {
        capture();
        const to = resolve({ point, zoom });
        await glide(to, duration, ease);
        return to;
      },
      snap({ point, zoom = 1.4 } = {}) {
        capture();
        const v = resolve({ point, zoom });
        apply(v);
        return v;
      },
      // Restore to the scene REST framing when the scene defines a stage rect
      // (a v2 conflict scene), not to whatever the camera happened to be at.
      //
      // Captured home is the wrong target there: if a previous shot left the
      // camera wide — or one was interrupted — the next shot captures THAT as
      // home and restores to it, so the framing ratchets further out with every
      // cinematic. Rest framing is the arena default that settleRestFraming
      // already asserts at battle start, so it is the correct place to land.
      // Scenes without a stage rect keep the captured-home behaviour, since
      // there is no authored framing to return to.
      async restore({ duration = 900, ease = null } = {}) {
        const target = homeTarget();
        if (!target) return;
        restored = true;
        await glide(target, duration, ease);
        apply(target);
      },
    };
  }

  return {
    // context conveniences
    ctx,
    caster: ctx?.casterToken ?? null,
    targets: ctx?.targetTokens ?? [],
    // timing
    tween, EASE, wait,
    // space + layers
    screen, screenLive, layer,
    // tokens
    cloneToken, hideToken,
    // textures / media
    gradientTexture, radialTexture, webmSprite, webm,
    // full-screen fx (PIXI helpers are WORLD space; dom* are camera-proof)
    whiteout, blackout, dim, screenshake,
    domSheet, domDim, domFlash, sceneDim,
    // particles + camera
    particles, camera: makeCamera(),
    // audio
    sfx, sfxUrl,
    // gate + lifecycle
    fireDone, dispose,
  };
}
