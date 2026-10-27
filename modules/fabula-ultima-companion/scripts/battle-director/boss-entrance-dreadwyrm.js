// ============================================================================
// Boss Entrance FX — `dreadwyrm`: ⭐️ Fafnir's entrance, the mockup port.
//
// A style whose render is a TIMELINE (anim-studio/oni-timeline.js) rather than
// the DOM faller of `flame` / `shadowstorm`. The track list below is the
// approved "Dreadwyrm Descent · entrance overhaul" shot from the Fafnir Action
// Shots mockup (revision 26), beat for beat:
//
//   0.0  stillness, nothing on the enemy side        1.3  scene dim
//   2.9  cut to the sky: letterbox, the storm plate tilting up, far strikes
//   5.25 she appears high and small, dark, and descends toward the camera in
//        three wing-beat drops then a flare (0.18 → 1.45 screen heights), each
//        near strike lighting her up
//   9.0  the last strike lands on her: white            9.4  HARD CUT: she is
//        down — shake, dust, a violet pillar + burst on her, strikes around her
//  10.3  held pause                                     11.7 roar: the camera is
//        thrown back to rest in a third of a second; blur shockwave to the border
//  12.8  undim                                          14.7 end
//
// `done` (the director's impact gate, which reveals the real token) fires at
// the hard cut. The overlay keeps painting her until the run ends, so the
// reveal underneath is seamless.
// ============================================================================

import { buildOni } from "../anim-studio/oni-helpers.js";

const FORGE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/";
const ANIM = FORGE + "Animation/";
const CAMP = FORGE + "Campaign/The%20Legend%20of%20Dragonslayer/Image/";
const SND = FORGE + "Sound/";

export const DREADWYRM_ASSETS = {
  skyImg: CAMP + "Map/Game%20Map/Fafnir_Map001.png",
  cutinImg: CAMP + "VFX/Fafnir_Cutin_lightning.webp",
  casterArt: FORGE + "Beastiary/Fafnir/Fafnir_Lightning_NoShadow.png",
  casterShadow: FORGE + "Beastiary/Fafnir/Fafnir_Lightning_Shadow.png",
  clips: {
    thunder1:    { url: ANIM + "RPG%20Maker%20MV/076_thunder_one_1.webm", w: 624, h: 704, dur: 467, ax: 0.5, ay: 0.858 },
    thunderall2: { url: ANIM + "RPG%20Maker%20MV/079_thunder_all_2.webm", w: 992, h: 800, dur: 933, ax: 0.4879, ay: 0.65 },
    energycoat:  { url: ANIM + "Ragnarok%20Online/energycoat.webm", w: 392, h: 392, dur: 1000, ax: 0.4974, ay: 0.8061 },
    dust05:      { url: ANIM + "Guilty%20Gear%20Strive/webm/dashsmoke_anim05.webm", w: 512, h: 512, dur: 800, ax: 0.5, ay: 0.95, mask: true },
    smoke12:     { url: ANIM + "Guilty%20Gear%20Strive/webm/smoke_anim12.webm", w: 512, h: 512, dur: 700, ax: 0.5, ay: 0.7, mask: true },
    smoke14:     { url: ANIM + "Guilty%20Gear%20Strive/webm/smoke_anim14.webm", w: 512, h: 512, dur: 800, ax: 0.5, ay: 0.95, mask: true },
  },
  sfx: [
    [3400, SND + "Soundboard/Thunder5.ogg", 0.35], [4300, SND + "Soundboard/Thunder5.ogg", 0.35], [5250, SND + "Wind1.ogg", 0.5],
    [5300, SND + "Thunder10.m4a", 0.45], [6470, SND + "Wind1.ogg", 0.5], [6300, SND + "Soundboard/Thunder1.ogg", 0.55],
    [7620, SND + "Wind1.ogg", 0.5], [7400, SND + "Soundboard/Thunder9.ogg", 0.6], [8300, SND + "Soundboard/Thunder1.ogg", 0.6],
    [9000, SND + "Soundboard/Thunder9.ogg", 0.7], [9400, SND + "Soundboard/SE_DOWNC.wav", 0.9], [9400, SND + "Amalthea_Explosion.ogg", 0.6],
    [11670, SND + "Monster5.ogg", 0.95],
  ],
  totalMs: 14700,
  impactMs: 9400,
  casterFoot: 0.905,
};

/**
 * Play the dreadwyrm entrance for `token` on this client. Calls `done` at the
 * hard cut (impact); resolves when the whole run is over and torn down.
 */
export async function runDreadwyrmEntrance({ token, done, assets = DREADWYRM_ASSETS } = {}) {
  if (!token || !canvas?.ready) { done?.(); return; }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const oni = buildOni({ casterToken: token, targetTokens: [], params: {} }, { canvas, PIXI, loadTexture, fromUuid, wait, foundry });
  let doneFired = false;
  const fireDone = () => { if (doneFired) return; doneFired = true; try { done?.(); } catch (e) { console.warn("[boss-entrance][dreadwyrm] done threw", e); } };
  try {
    const tl = oni.timeline({
      tokens: { faf: { token, art: assets.casterArt, shadow: assets.casterShadow, foot: assets.casterFoot, nativeDir: -1, hurt: null, hidden: true } },
      images: { sky: assets.skyImg, cutin: assets.cutinImg },
      clips: assets.clips,
    });
    await tl.load();
    const E = tl.E, seg = tl.seg, lerp = tl.lerp;
    const TOK = tl.TOK, IMG = tl.IMG, feet = tl.feet, REST = tl.REST, D = tl.draw;
    const T = []; const m = tl.mk(T);
    const F = TOK.faf; const f = feet(F); const V = "#c9a5ff";

    m.hold(0, 9400, (t, S) => { S.tok.faf.hidden = true; }); m.beat(0, "stillness");
    m.beat(1300, "dim"); m.dim(1300, 1100, 0.6);
    m.beat(2900, "the sky");
    // [at, strength, x, wh, alpha, blur]; y is derived so the clip's top stays just inside the frame (anchor .858 from the top)
    const strikes = [[3400, 0.4, 0.22, 0.30, 0.5, 4], [4300, 0.45, 0.74, 0.28, 0.55, 4], [5300, 0.6, 0.5, 0.45, 0.7, 2], [6300, 1, 0.18, 0.95, 1, 0], [7400, 1, 0.82, 1.0, 1, 0], [8300, 0.9, 0.35, 0.9, 1, 0]];
    const flashAt = (t) => { let fl = 0; for (const s of strikes) { const u = t - s[0]; if (u < 0) continue; const env = u < 40 ? u / 40 : u < 90 ? 1 - 0.7 * (u - 40) / 50 : u < 130 ? 0.3 + 0.7 * (u - 90) / 40 : Math.max(0, 1 - (u - 130) / 380); fl = Math.max(fl, s[1] * env); } return fl; };
    m.hold(2900, 9400, (t, S) => { S.hideBoard = true; S.black = 1; const fade = E.sine(seg(t, 0, 400)); const fl = flashAt(t + 2900); S.screen.push({ draw: (g) => { const W = g.W, H = g.H; const oy = lerp(-H * 0.22, H * 0.10, E.sine(seg(t, 0, 6500)));
      g.save(); g.filter = "blur(" + (2 * (H / 788)).toFixed(1) + "px)"; D.drawCover(g, IMG.sky, W, H, 1.12, 0, oy, fade); g.restore();
      if (fl > 0) { g.save(); g.globalAlpha = 0.45 * fl * fade; g.fillStyle = "#c9a5ff"; g.fillRect(0, 0, W, H); g.restore(); }
      const v = g.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, Math.max(W, H) * 0.62); v.addColorStop(0, "rgba(0,0,0,0)"); v.addColorStop(1, "rgba(0,0,0,.75)"); g.fillStyle = v; g.fillRect(0, 0, W, H); } }); S.letterbox = 0.1 * fade; });
    for (const [at, str, x, wh, al, bl] of strikes) { m.clip("thunder1", at, { screen: { x, y: 0.858 * wh + 0.03 }, wh, add: bl === 0, tint: V, blur: bl, alpha: () => al }); m.hold(at, at + 260, (t, S) => { S.shake = Math.max(S.shake, 6 * str * (1 - t / 260)); }); }
    m.clip("thunderall2", 4000, { screen: { x: 0.5, y: 0.45 }, wh: 0.9, add: true, tint: V, alpha: () => 0.45 });
    // her cut-in art, descending toward the camera: dark, lit by the strikes; wing-beat drops, growing as she comes
    m.beat(5250, "she descends");
    const beats = [[0.34, 520, 300, 400, 0.045], [0.62, 490, 280, 380, 0.038], [0.86, 450, 260, 400, 0.030], [1, 640, 0, 0, 0]];
    m.hold(5250, 9400, (t, S) => { let tt = t, p = 0, prev = 0; for (const [to, drop, reb, holdMs, rf] of beats) { if (tt < drop) { p = lerp(prev, to, E.inQ(tt / drop)); break; } tt -= drop; p = to; if (tt < reb) { p = to - rf * Math.sin(tt / reb * Math.PI); break; } tt -= reb; if (tt < holdMs) { p = to + Math.sin(tt / holdMs * Math.PI * 2) * 0.006; break; } tt -= holdMs; prev = to; }
      const fl = flashAt(t + 5250); S.screen.push({ draw: (g) => { const W = g.W, H = g.H; const img = IMG.cutin, dark = tl.tinted("cutin", "#06020c"); if (!img || !dark) return; const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height; const h = H * lerp(0.18, 1.45, p), w = h * iw / ih; const cx = W * lerp(0.5, 0.46, p), cy = H * lerp(0.12, 0.62, p);
        g.save(); g.translate(cx, cy); g.filter = "blur(" + ((1 - p) * 3 * (H / 788)).toFixed(1) + "px)"; g.shadowColor = "rgba(200,160,255," + (0.3 + 0.7 * fl) + ")"; g.shadowBlur = (8 + 40 * fl) * (H / 788); g.drawImage(img, -w / 2, -h / 2, w, h); g.filter = "none"; g.shadowBlur = 0; g.globalAlpha = 0.78 - 0.6 * fl; g.drawImage(dark, -w / 2, -h / 2, w, h); g.restore(); } }); });
    m.beat(9000, "the strike · white"); m.clip("thunder1", 9000, { screen: { x: 0.46, y: 0.858 * 1.0 + 0.03 }, wh: 1.0, add: true, tint: V });
    m.hold(9050, 9400, (t, S) => { S.white = Math.max(S.white, E.sine(seg(t, 0, 300))); });
    m.beat(9400, "cut · impact");
    m.hold(9400, 1e9, (t, S) => { S.tok.faf.hidden = false; });
    // the director's impact gate: reveal the real token under the overlay now
    m.hold(assets.impactMs, 1e9, () => { fireDone(); });
    // landed: hold a tight frame on her; at the roar the camera is thrown back to its rest framing in a third of a second
    m.hold(9400, 11670, (t, S) => { S.cam = { cx: F.x + 60 * (F.dir || 1), cy: F.y - 40, zoom: 1.3 }; });
    m.hold(11670, 1e9, (t, S) => { const k = E.outC(seg(t, 0, 340)); S.cam = { cx: lerp(F.x + 60 * (F.dir || 1), REST.cx, k), cy: lerp(F.y - 40, REST.cy, k), zoom: lerp(1.3, 1, k) }; });
    m.hold(9400, 10270, (t, S) => { S.tok.faf.black = 1 - E.sine(seg(t, 0, 320)); S.tok.faf.glow = 1 - t / 900 * 0.5; });
    m.clip("thunderall2", 9400, { x: F.x, y: F.y - 60, w: 1400, z: 49, add: true, tint: V }); m.clip("energycoat", 9400, { x: F.x, y: F.y + 40, w: 1300, z: 48, add: true, tint: V });
    [[F.x - 380, f.y - 20, 0], [F.x + 360, f.y - 40, 80], [F.x - 120, f.y + 40, 160], [F.x + 200, f.y - 120, 240]].forEach(([x, y, d]) => m.clip("thunder1", 9400 + d, { x, y, w: 460, z: 50, add: true, tint: V }));
    m.flash(9400, 80, 600, "#c9a5ff", 0.5); m.shake(9400, 1200, 42); m.dust(9400, F.x, f.y + 10, 1100, "land");
    m.hold(10270, 14700, (t, S) => { S.tok.faf.glow = 0.4; }); m.beat(10270, "held pause");
    m.beat(11670, "roar · camera thrown back"); m.hold(11670, 12820, (t, S) => { const k = Math.sin(t / 1150 * Math.PI); S.tok.faf.sy = 1 + 0.06 * k; S.tok.faf.glow = 0.4 + 0.8 * k; S.shake = Math.max(S.shake, 14 * k + 30 * (1 - seg(t, 0, 400))); S.over.push({ draw: (g) => D.shockRing(g, F.x + 60 * (F.dir || 1), F.y - 40, t, 1150) }); });
    m.undim(12820, 1800, 0.6);

    await tl.run(T, { total: assets.totalMs, sfx: assets.sfx.map(([at, url, v]) => ({ at, url, v })) });
  } catch (e) {
    console.warn("[boss-entrance][dreadwyrm] run threw", e);
  } finally {
    fireDone();
    try { oni.dispose(); } catch {}
  }
}
