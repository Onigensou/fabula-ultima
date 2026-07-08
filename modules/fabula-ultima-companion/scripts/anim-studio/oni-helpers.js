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
  const { canvas, PIXI, wait } = env;
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
  function sfx(nameOrUrl, { volume = 1, rate = 1, delay = 0 } = {}) {
    const url = sfxUrl(nameOrUrl);
    if (!url) { console.warn("[oni] sfx not found:", nameOrUrl); return null; }
    const play = () => {
      try {
        const a = new Audio(url);
        a.volume = Math.max(0, Math.min(1, volume));
        a.playbackRate = rate;
        a.play().catch(() => {});
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

  return {
    // context conveniences
    ctx,
    caster: ctx?.casterToken ?? null,
    targets: ctx?.targetTokens ?? [],
    // timing
    tween, EASE, wait,
    // space + layers
    screen, layer,
    // tokens
    cloneToken, hideToken,
    // textures / media
    gradientTexture, radialTexture, webmSprite,
    // full-screen fx
    whiteout, dim, screenshake,
    // audio
    sfx, sfxUrl,
    // gate + lifecycle
    fireDone, dispose,
  };
}
