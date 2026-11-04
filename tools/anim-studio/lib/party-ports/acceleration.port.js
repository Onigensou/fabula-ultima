// PORTED (Batch C, 2026-11-05): old effect-player calls replaced by the PORT shim
// (_port-shim.js, header comment trimmed). Same look and timing as the legacy script.
// PORT.sound = AudioHelper broadcast; PORT.effect = webm via game.ONI.pseudo.play; PORT.wait.
// Pseudo inners hide tokens with oni.hideToken (guarded), never by toggling visibility.
const PORT = (() => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  function sound(src, volume) {
    if (!src) return;
    try {
      const AH = (foundry && foundry.audio && foundry.audio.AudioHelper) || globalThis.AudioHelper;
      AH.play({ src: src, volume: volume == null ? 0.8 : volume, autoplay: true, loop: false }, true);
    } catch (e) { console.warn('[PORT] sound failed', src, e); }
  }
  const INNER = [
    "const p = ctx.params || {};",
    "const vid = document.createElement('video'); vid.src = p.file; vid.muted = true; vid.playsInline = true; vid.crossOrigin = 'anonymous';",
    "let tex; try { tex = await loadTexture(p.file); } catch (e) { tex = null; }",
    "if (!tex) return;",
    "const v = tex.baseTexture && tex.baseTexture.resource && tex.baseTexture.resource.source;",
    "const spr = new PIXI.Sprite(tex); spr.anchor.set(0.5, 0.5);",
    "const nw = (v && v.videoWidth) || tex.width || 100, nh = (v && v.videoHeight) || tex.height || 100;",
    "const k = (p.scale || 1) * (canvas.grid.size / (p.fileGrid || 200));",
    "spr.width = nw * k; spr.height = nh * k; if (p.mirrorX) spr.scale.x *= -1; if (p.mirrorY) spr.scale.y *= -1;",
    "spr.angle = -(p.rotate || 0); spr.x = p.x; spr.y = p.y; spr.alpha = p.fadeIn ? 0 : (p.opacity == null ? 1 : p.opacity);",
    "spr.zIndex = p.below ? 50 : 100500; canvas.stage.sortableChildren = true; canvas.stage.addChild(spr); canvas.stage.sortChildren();",
    "const op = p.opacity == null ? 1 : p.opacity;",
    "if (v) { try { v.loop = false; v.currentTime = 0; v.playbackRate = p.rate || 1; await v.play(); } catch (e) {} }",
    "const dur = p.duration || ((v && isFinite(v.duration) ? v.duration * 1000 / (p.rate || 1) : 1000));",
    "const t0 = performance.now();",
    "await new Promise((res) => { const tick = () => { const e = performance.now() - t0; let a = op; if (p.fadeIn && e < p.fadeIn) a = op * e / p.fadeIn; if (p.fadeOut && e > dur - p.fadeOut) a = op * Math.max(0, (dur - e) / p.fadeOut); spr.alpha = a; if (e >= dur) { canvas.app.ticker.remove(tick); res(); } }; canvas.app.ticker.add(tick); });",
    "try { spr.destroy(); } catch (e) {} try { if (v) v.pause(); } catch (e) {}",
  ].join("\n");
  function fileGrid() { return 100; } // raw file path default: native px x scale x (scene grid / 100)
  async function effect(o) {
    let x = 0, y = 0;
    const at = o.at && o.at.center ? o.at.center : (o.at || { x: 0, y: 0 });
    x = at.x + ((o.offset && o.offset.x) || 0); y = at.y + ((o.offset && o.offset.y) || 0);
    const params = { file: o.file, x, y, scale: o.scale, mirrorX: !!o.mirrorX, mirrorY: !!o.mirrorY, rotate: o.rotate || 0, fadeIn: o.fadeIn || 0, fadeOut: o.fadeOut || 0, below: !!o.below, opacity: o.opacity, duration: o.duration || 0, rate: o.rate || 1, fileGrid: o.fileGrid || fileGrid(o.file) };
    try { await game.ONI.pseudo.play({ scriptId: 'port.effect', scriptSource: INNER, casterTokenUuid: null, targetTokenUuids: [], params }); } catch (e) { console.warn('[PORT] effect failed', o.file, e); }
  }
  return { sound, effect, wait };
})();

// ── Port helper (this script only) ──────────────────────────────────────────
// PORT.effect resolves as soon as the broadcast is sent; the old player's play()
// resolved when its effects finished. To keep the legacy end timing, read the
// clip length here on the GM (metadata only) and wait it out explicitly.
function __fxDurMs(file, fallback) {
  return new Promise((res) => {
    const v = document.createElement('video');
    let done = false;
    const fin = (d) => { if (done) return; done = true; try { v.removeAttribute('src'); v.load(); } catch (e) {} res(d); };
    v.preload = 'metadata'; v.muted = true;
    v.onloadedmetadata = () => fin(isFinite(v.duration) && v.duration > 0 ? v.duration * 1000 : fallback);
    v.onerror = () => fin(fallback);
    setTimeout(() => fin(fallback), 4000);
    v.src = file;
  });
}

// ONI — Clockwork Blades (polished: X-only sidestep, no Y drift) — ported (PORT shim)
// The sidestep is now a pseudo clone (visual only, every client): the real token
// never moves and is hidden with oni.hideToken while the clone steps out/back.
(async () => {
  const TAG = "[ONI][FX]";
  // --- Assets ---
  const SFX_MOVE   = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Beginspell.mp3";
  const FX_TARGET  = "modules/boss-loot-assets-free/artwork/07-steampunk/clock/Clockwork_Blades_1_1200x1200.webm";
  const SFX_TARGET = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Haste.ogg";
  // --- Checks ---
  const caster = canvas.tokens.controlled?.[0];
  if (!caster) {
    ui.notifications.warn(`${TAG} Please SELECT exactly 1 token (the caster).`);
    return;
  }
  const targets = Array.from(game.user.targets ?? []);
  if (targets.length !== 1) {
    ui.notifications.warn(`${TAG} Please TARGET exactly 1 token.`);
    return;
  }
  const target = targets[0];
  // --- X-only sidestep distance ---
  const disp = caster.document.disposition;
  const squares = 0.35; // tweak distance here
  const offsetPx = canvas.grid.size * squares;
  // Hostile (-1) => move RIGHT, else => move LEFT
  const dx = (disp === -1) ? +offsetPx : -offsetPx;
  const MOVE_MS = 350;
  const PAUSE_MS = 500;
  // The clone holds out for: pause + target FX (full clip) + pause
  const fxDur = await __fxDurMs(FX_TARGET, 1500);
  const holdMs = PAUSE_MS + fxDur + PAUSE_MS;
  const stepInner = [
    "const { casterToken, params } = ctx;",
    "if (!casterToken) return;",
    "const dx = Number(params.dx || 0), dur = Number(params.dur || 350), hold = Number(params.hold || 0);",
    "const clone = oni.cloneToken(casterToken);",
    "if (!clone) return;",
    "clone.zIndex = 5000; canvas.stage.sortableChildren = true; canvas.stage.sortChildren();",
    "const __restore = oni.hideToken(casterToken);",
    "try {",
    "  const x0 = clone.x;",
    "  await oni.tween({ from: 0, to: 1, duration: dur, onUpdate: (v) => { clone.x = x0 + dx * v; } });",
    "  await wait(hold);",
    "  await oni.tween({ from: 0, to: 1, duration: dur, onUpdate: (v) => { clone.x = x0 + dx * (1 - v); } });",
    "} finally { __restore(); }",
  ].join("\n");
  // ✅ animation start hook
  Hooks.callAll("oni:animationStart", { tag: "ClockworkBlades", tokenId: caster.id });
  // Movement sound + move out (X-only, linear like the old moveTowards)
  PORT.sound(SFX_MOVE, 0.9);
  game.ONI.pseudo.play({
    scriptId: "oni.clockworkBlades.sidestep",
    scriptSource: stepInner,
    casterTokenUuid: caster.document.uuid,
    targetTokenUuids: [target.document.uuid],
    params: { dx, dur: MOVE_MS, hold: holdMs },
    meta: { source: "ClockworkBlades" },
  });
  await PORT.wait(MOVE_MS);
  // wait 0.5s
  await PORT.wait(PAUSE_MS);
  // Target SFX + FX (scaleToObject(2.15): 2.15 x target width; 1200px native file)
  PORT.sound(SFX_TARGET, 0.9);
  PORT.effect({ file: FX_TARGET, at: target, scale: 2.15 * target.w / canvas.grid.size, fileGrid: 1200, opacity: 1.0, below: false });
  await PORT.wait(fxDur);
  // wait 0.5s
  await PORT.wait(PAUSE_MS);
  // Move back (clone returns to the real token's spot)
  await PORT.wait(MOVE_MS);
  // ✅ animation end hook
  Hooks.callAll("oni:animationEnd", { tag: "ClockworkBlades", tokenId: caster.id });
})();
