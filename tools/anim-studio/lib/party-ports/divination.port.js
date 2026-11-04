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

// ONI — Divination (with timing hooks) — ported off the old effect player (PORT shim)
(async () => {
const TAG = "[ONI][FX]";
const FX_BURST = "modules/JB2A_DnD5e/Library/Generic/Particles/ParticleBurstStar01_01_Regular_BluePurple_600x600.webm";
const FX_CIRCLE = "modules/JB2A_DnD5e/Library/Generic/Cast/CastShapeCircleSingle01_01_Regular_Blue_600x600.webm";
const SFX_START_1 = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/Up3.ogg";
const SFX_START_2 = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/Starlight.ogg";
// Divination is a SELF spell: BD may hand it no target at all. The legacy returned
// here without firing oni:animationEnd, so BD sat on its 35 s timeout. Fall back to
// the caster (payload, then the controlled token) and never return silently.
const targets = Array.from(game.user.targets ?? []);
const __P = globalThis.__PAYLOAD ?? {};
let __caster = null;
for (const u of [__P.casterTokenUuid, __P.sourceTokenUuid, __P.tokenUuid]) { try { const d = u ? fromUuidSync(u) : null; if (d?.object) { __caster = d.object; break; } } catch (e) {} }
const token = targets[0] ?? __caster ?? canvas.tokens.controlled?.[0] ?? null;
if (!token) {
  console.warn(TAG, "Divination: no caster or target token");
  Hooks.callAll("oni:animationEnd", { type: "divination", error: true, timestamp: Date.now() });
  return;
}
const center = token.center;
const squaresUp = 0.9;
const yUpPx = canvas.grid.size * squaresUp;
const locAbove = { x: center.x, y: center.y - yUpPx };
const locOn = { x: center.x, y: center.y };
// Clip lengths (GM-side metadata) so the end lands when the effects finish, as before.
const burstDurP = __fxDurMs(FX_BURST, 1000);
const circleDurP = __fxDurMs(FX_CIRCLE, 1000);
// ✅ Tell the handler “animation started”
Hooks.callAll("oni:animationStart", { tag: "Divination", tokenId: token.id });
const t0 = performance.now();
// scaleToObject(s) at a bare point = s grid squares wide (600px native file -> fileGrid 600)
PORT.sound(SFX_START_1, 0.8);
PORT.effect({ file: FX_BURST, at: locAbove, scale: 1.3, fileGrid: 600, opacity: 1.0, below: false });
await PORT.wait(1500);
PORT.sound(SFX_START_2, 0.8);
PORT.effect({ file: FX_CIRCLE, at: locOn, scale: 1.8, fileGrid: 600, opacity: 0.5, below: false });
// IMPORTANT: wait for both effects to finish so we emit “end” at the true end
const circleDur = await circleDurP;
await PORT.wait(circleDur);
const burstLeft = (await burstDurP) - (performance.now() - t0);
if (burstLeft > 0) await PORT.wait(burstLeft);
// ✅ Tell the handler “animation ended”
Hooks.callAll("oni:animationEnd", { tag: "Divination", tokenId: token.id });
})();
