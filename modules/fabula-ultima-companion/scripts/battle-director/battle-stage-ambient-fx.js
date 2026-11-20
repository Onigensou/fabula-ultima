// ============================================================================
// Battle stage ambient FX — generic idle scenery effects for a battle backdrop.
//
// Driven by `ambient.fx` in a backdrop's preset (battle-stage-3d-rules.js): a
// list of { k: <kind>, n: <sprite count>, ...kind data }, positions in canvas
// px on that image. Ported 1:1 from the approved mockup (2026-11-15,
// "Battlemap Ambience" artifact). battle-stage-ambient.js owns the layers, the
// pinning to the painting and the ticker; this file only builds and moves
// sprites.
//
// Budget (approved): about 60 sprites a map at most; textures are made once at
// start, never per frame; no filters; lights are sprites, not Foundry lights.
//
//   back  (over the backdrop, under the tokens): cloud-free washes, glows,
//         torches, flames, mist, smoke, ripples, drips, puffs, glints, shafts
//   front (over the tokens): gusts, embers, dust, leaves, fog banks, part of
//         a "big" mist, butterflies
//
// Kinds: gust puff mist drip bark wash embers dust leaves flame smoke torch
//        ripple shaft glint flutter fogbank cloud
//        beam pulse motes haze rain splash bubble slime flash   (2026-11-20,
//        Valley boss arenas mockup; speeds there were per 60 fps frame, here per second)
// Graphics-drawn kinds (rain splash bubble slime flash) take n: 1 and count
// their drops with their own key, so they cost no sprites.
//        cloudsea (2026-11-20, Sealed Cavern): the Sacrificial Altar / Fafnir
//        Castle Entrance cloud sea (map-ambience.js "clouds") as a battle
//        effect, recoloured. n: 1. Two halves pivot at { ox, oy }: the left
//        half turns counter-clockwise and drifts left, the right clockwise and
//        right, so the gas over the top rolls outward (the painted plume).
//        Masked to an ellipse { cx, cy, rx, ry } faded out between floor0 and
//        floor1; speed / alpha / size scale the Castle Entrance layer set.
// ============================================================================

const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const hex = (s) => (typeof s === "number" ? s : parseInt(String(s).replace("#", ""), 16));

export const AMBIENT_FX_KINDS = Object.freeze(["gust", "puff", "mist", "drip", "bark", "wash", "embers", "dust", "leaves", "flame", "smoke", "torch", "ripple", "shaft", "glint", "flutter", "fogbank", "cloud",
  "beam", "pulse", "motes", "haze", "rain", "splash", "bubble", "slime", "flash", "cloudsea"]);
const FRONT = new Set(["gust", "embers", "dust", "leaves", "fogbank", "flutter", "rain", "flash"]);

function canvasTex(w, h, paint) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  paint(c.getContext("2d"), w, h);
  return PIXI.Texture.from(c);
}
const radial = (inner, size = 128) => canvasTex(size, size, (g, w) => {
  const r = g.createRadialGradient(w / 2, w / 2, inner * w / 2, w / 2, w / 2, w / 2);
  r.addColorStop(0, "rgba(255,255,255,1)"); r.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = r; g.fillRect(0, 0, w, w);
});

// ── cloudsea ────────────────────────────────────────────────────────────────
// map-ambience.js cloudTexture(): 256 px tileable fbm (4 octaves), smoothstep alpha, colour × lift.
function seaNoise(rgb) {
  const N = 256, c = document.createElement("canvas"); c.width = c.height = N;
  const x = c.getContext("2d"), img = x.createImageData(N, N);
  const lerp = (a, b, t) => a + (b - a) * t, sm = (t) => t * t * (3 - 2 * t);
  const octs = [4, 8, 16, 32].map((p) => ({ p, L: Array.from({ length: p * p }, Math.random) }));
  const val = (o, xx, yy) => {
    const f = o.p / N, gx = xx * f, gy = yy * f, x0 = Math.floor(gx), y0 = Math.floor(gy), tx = sm(gx - x0), ty = sm(gy - y0), P = o.p;
    const at = (i, j) => o.L[((j % P + P) % P) * P + ((i % P + P) % P)];
    return lerp(lerp(at(x0, y0), at(x0 + 1, y0), tx), lerp(at(x0, y0 + 1), at(x0 + 1, y0 + 1), tx), ty);
  };
  for (let yy = 0; yy < N; yy++) for (let xx = 0; xx < N; xx++) {
    let v = 0, a = 0.5, tot = 0; for (const o of octs) { v += val(o, xx, yy) * a; tot += a; a *= 0.5; } v /= tot;
    const k = clamp((v - 0.38) / 0.42, 0, 1), al = k * k * (3 - 2 * k), i = (yy * N + xx) * 4, lift = 0.75 + 0.45 * v;
    img.data[i] = Math.min(255, rgb[0] * lift); img.data[i + 1] = Math.min(255, rgb[1] * lift); img.data[i + 2] = Math.min(255, rgb[2] * lift); img.data[i + 3] = 255 * al;
  }
  x.putImageData(img, 0, 0);
  const t = PIXI.Texture.from(c); t.baseTexture.wrapMode = PIXI.WRAP_MODES.REPEAT; return t;
}
// The Fafnir Castle Entrance layer set (build-sacrificial-altar.js CASTLE_CLOUDS); each half mirrors spin and dx.
const SEA_LAYERS = [{ s: 4.4, spin: 0.012, dx: 20, dy: -6, a: 0.6 }, { s: 2.8, spin: -0.018, dx: -24, dy: -2, a: 0.45 }, { s: 1.8, spin: 0.026, dx: 32, dy: -10, a: 0.3 }];
const SEA_H = 0.5;   // drawn at half the canvas size, like the altar mockup, then scaled ×2
// Half-size grey mask (RGB = coverage, alpha 255, the way map-ambience feeds sprite masks).
function seaMask(f, side) {
  const W = 2560 * SEA_H, H = 1270 * SEA_H, c = document.createElement("canvas"); c.width = W; c.height = H;
  const x = c.getContext("2d");
  x.save(); x.translate(f.cx * SEA_H, f.cy * SEA_H); x.scale(1, f.ry / f.rx);
  const rg = x.createRadialGradient(0, 0, 0, 0, 0, f.rx * SEA_H);
  rg.addColorStop(0, "#fff"); rg.addColorStop(0.55, "#fff"); rg.addColorStop(1, "rgba(255,255,255,0)");
  x.fillStyle = rg; x.fillRect(-f.rx * SEA_H, -f.rx * SEA_H, f.rx * 2 * SEA_H, f.rx * 2 * SEA_H); x.restore();
  x.globalCompositeOperation = "destination-in";
  const lg = x.createLinearGradient(0, f.floor0 * SEA_H, 0, f.floor1 * SEA_H); lg.addColorStop(0, "#fff"); lg.addColorStop(1, "rgba(255,255,255,0)");
  x.fillStyle = lg; x.fillRect(0, 0, W, H);
  const px = f.ox * SEA_H, sg = x.createLinearGradient(px - 60, 0, px + 60, 0);
  sg.addColorStop(0, side < 0 ? "#fff" : "rgba(255,255,255,0)"); sg.addColorStop(1, side < 0 ? "rgba(255,255,255,0)" : "#fff");
  x.fillStyle = sg; x.fillRect(0, 0, W, H);
  const d = x.getImageData(0, 0, W, H);
  for (let i = 0; i < W * H; i++) { const m = d.data[i * 4 + 3]; d.data[i * 4] = d.data[i * 4 + 1] = d.data[i * 4 + 2] = m; d.data[i * 4 + 3] = 255; }
  x.globalCompositeOperation = "source-over"; x.putImageData(d, 0, 0);
  return PIXI.Texture.from(c);
}

/**
 * @param {object[]} list   ambient.fx from the preset
 * @param {object} o        { back, front: PIXI.Container, pin(x, y) -> {x, y, s} }
 */
export function createAmbientFx(list, { back, front, pin }) {
  const tex = {
    glow: radial(0, 128), core: radial(0.15, 64), mist: radial(0, 256),
    leaf: canvasTex(32, 16, (g) => { g.fillStyle = "#fff"; g.beginPath(); g.ellipse(16, 8, 15, 7, 0, 0, Math.PI * 2); g.fill(); }),
    // beam: full at the top edge, fading to nothing at the bottom (anchor top-centre)
    beam: canvasTex(32, 256, (g) => { const gr = g.createLinearGradient(0, 0, 0, 256); gr.addColorStop(0, "rgba(255,255,255,1)"); gr.addColorStop(1, "rgba(255,255,255,0)"); g.fillStyle = gr; g.fillRect(0, 0, 32, 256); }),
    dot: canvasTex(16, 16, (g) => { g.fillStyle = "#fff"; g.beginPath(); g.arc(8, 8, 7.5, 0, Math.PI * 2); g.fill(); }),
  };
  const shaftTex = new Map();
  const extraTex = [];   // cloudsea noise + masks, destroyed with the rest
  const gfxBack = new PIXI.Graphics(); gfxBack.blendMode = PIXI.BLEND_MODES.ADD; back.addChild(gfxBack);
  const gfxFront = new PIXI.Graphics(); front.addChild(gfxFront);
  const parts = [];

  const sprite = (t, tint, blend, layer) => {
    const s = new PIXI.Sprite(t); s.anchor.set(0.5); s.tint = hex(tint ?? 0xffffff);
    s.blendMode = blend; s.visible = false; layer.addChild(s); return s;
  };
  const place = (s, x, y, w, h, alpha, rot = 0) => {
    const a = clamp(alpha, 0, 1);
    s.visible = a > 0.003;
    if (!s.visible) return;
    const p = pin(x, y);
    s.position.set(p.x, p.y);
    s.scale.set((w * p.s) / s.texture.width, (h * p.s) / s.texture.height);
    s.alpha = a; s.rotation = rot;
  };
  const ADD = PIXI.BLEND_MODES.ADD, SCREEN = PIXI.BLEND_MODES.SCREEN, NORMAL = PIXI.BLEND_MODES.NORMAL;

  function spawn(p, first) {
    const f = p.f, i = p.i;
    switch (f.k) {
      case "gust": p.w = rnd(520, 900); p.h = rnd(90, 170); p.y = rnd(f.y0, f.y1); p.v = f.speed * rnd(0.8, 1.25); p.x = -p.w - rnd(0, 500); p.wait = first ? rnd(0, 6) : rnd(3.5, 7.5); p.on = false; break;
      case "puff": { const a = f.at ? f.at[i % f.at.length] : [rnd(f.x0, f.x1), f.y]; p.bx = a[0] + rnd(-40, 40); p.by = a[1]; p.life = rnd(1.4, 2.4); p.age = first ? rnd(0, p.life) : 0; p.r = rnd(40, 90); break; }
      case "mist": p.x = rnd(f.x0 ?? -300, f.x1 ?? 2560); p.y = rnd(f.y0, f.y1); p.r = f.big ? rnd(420, 820) : rnd(260, 520); p.v = f.speed * rnd(0.5, 1.4) * (f.x0 != null ? (Math.random() < 0.5 ? -1 : 1) : 1); p.ph = rnd(0, 6.28); break;
      case "ripple": { const a = f.at[i % f.at.length]; p.x = a[0]; p.y = a[1]; p.R = a[2]; p.wait = rnd(0.5, 4); p.age = 0; p.on = false; break; }
      case "drip": p.wait = first ? rnd(0, 2.5) : rnd(1.0, 2.6); p.on = false; p.life = 0; break;
      case "bark": case "flame": case "torch": { p.a = f.at[i % f.at.length]; p.ph = rnd(0, 6.28); p.sp = rnd(0.7, 1.3); p.floor = f.k === "torch" && i >= f.at.length; break; }
      case "wash": case "shaft": p.a = f.at[i % f.at.length]; p.ph = rnd(0, 6.28); break;
      case "embers": case "dust": { const src = f.from[i % f.from.length]; p.x = src[0] + rnd(-src[2], src[2]); p.y = src[1] + rnd(-src[2] * 0.4, src[2] * 0.4); p.life = rnd(2.5, 5.5); p.age = first ? rnd(0, p.life) : 0; p.vx = rnd(-14, 26); p.vy = f.k === "embers" ? rnd(-70, -35) : (f.fall ? rnd(40, 90) : rnd(-8, 8)); p.r = f.k === "embers" ? rnd(3, 6) : rnd(2, 4); break; }
      case "leaves": p.x = rnd(f.x0, f.x1); p.y = first ? rnd(f.y0, 1270) : f.y0 + rnd(-60, 0); p.c = f.colors[i % f.colors.length]; p.vy = (f.up ? -1 : 1) * rnd(30, 60); p.vx = rnd(10, 40); p.rot = rnd(0, 6); p.ph = rnd(0, 6); if (f.up) p.y = first ? rnd(100, 1270) : 1300; break;
      case "smoke": p.a = f.at[i % f.at.length]; p.ph = rnd(0, 6.28); break;
      case "glint": p.x = rnd(f.x0, f.x1); p.y = rnd(f.y0, f.y1); p.wait = rnd(0, 2.5); p.age = 0; p.on = false; break;
      case "flutter": { const a = f.at[i % f.at.length]; p.bx = a[0]; p.by = a[1]; p.ph = rnd(0, 6); p.c = hex(f.colors[i % f.colors.length]); break; }
      case "fogbank": p.a = f.at[i % f.at.length]; p.ph = rnd(0, 6.28); p.off = rnd(0, 2560); break;
      case "cloud": p.x = first ? rnd(-600, 2560) : -900; p.y = rnd(400, 1150); p.r = rnd(500, 820); p.v = f.speed * rnd(0.8, 1.2); break;
      case "beam": case "pulse": p.a = f.at[i % f.at.length]; break;
      case "motes": { const [x, y, w, h] = f.area; p.x = rnd(x, x + w); p.y = rnd(y, y + h); p.vx = rnd(-9, 9); p.vy = rnd(-7, 3); p.r = rnd(1.5, 3.5); p.ph = rnd(0, 6.28); break; }
      case "haze": { const [x, y, w, h] = f.area; p.x = rnd(x, x + w); p.y = rnd(y, y + h); p.rx = rnd(160, 320); p.ry = f.low ? rnd(40, 80) : rnd(70, 140);
        p.vx = rnd(9, 27) * (Math.random() < 0.5 ? -1 : 1); p.vy = f.rise ?? 0; p.ph = rnd(0, 6.28); break; }
      case "rain": p.drops = Array.from({ length: f.drops ?? 150 }, () => ({ x: rnd(0, 2560), y: rnd(-1270, 1270), v: rnd(960, 1440), l: rnd(26, 46) })); break;
      case "splash": { const [x, y, w, h] = f.area; p.rips = Array.from({ length: f.count ?? 10 }, () => ({ x: rnd(x, x + w), y: rnd(y, y + h), t: rnd(0, 1) })); break; }
      case "bubble": { const [x, y, w, h] = f.at; p.bubs = Array.from({ length: f.count ?? 9 }, () => ({ x: rnd(x - w / 2, x + w / 2), y: rnd(y - h / 2, y + h / 2), t: rnd(0, 1), s: rnd(0.4, 0.8) })); break; }
      case "slime": p.drops = f.xs.map((x) => ({ x, y: rnd(f.y0, f.y1), v: rnd(90, 180), y1: f.y1 + rnd(80, 220) })); break;
      case "flash": p.f1 = 0; break;
    }
  }

  // Sprites per particle, made once.
  for (const f of list ?? []) {
    for (let i = 0; i < (f.n | 0); i++) {
      const p = { f, i, seed: Math.random() * 1000, s: [] };
      spawn(p, true);
      const front2 = FRONT.has(f.k) || (f.k === "mist" && f.big && i % 3 === 0);
      const L = front2 ? front : back;
      switch (f.k) {
        case "gust": p.s = [sprite(tex.mist, 0xffffff, SCREEN, L), sprite(tex.mist, 0xffffff, SCREEN, L)]; break;
        case "puff": p.s = [sprite(tex.glow, f.color, ADD, L)]; break;
        case "mist": p.s = [sprite(tex.mist, f.color, SCREEN, L)]; break;
        case "bark": p.s = [sprite(tex.glow, f.color, ADD, L), sprite(tex.core, 0xffd08a, ADD, L)]; break;
        case "flame": case "wash": p.s = [sprite(tex.glow, f.color, ADD, L)]; break;
        case "torch": p.s = p.floor ? [sprite(tex.glow, f.color, ADD, L)] : [sprite(tex.glow, f.color, ADD, L), sprite(tex.core, 0xfff0c0, ADD, L)]; break;
        case "embers": case "dust": p.s = [sprite(tex.core, f.color, ADD, L)]; break;
        case "leaves": p.s = [sprite(tex.leaf, p.c, NORMAL, L)]; break;
        case "smoke": p.s = [0, 1, 2].map(() => sprite(tex.mist, f.color, f.thin ? SCREEN : NORMAL, L)); break;
        case "glint": p.s = [sprite(tex.core, f.color, ADD, L)]; break;
        case "fogbank": p.s = [0, 1, 2].map(() => sprite(tex.mist, f.color, SCREEN, L)); break;
        case "cloud": p.s = [sprite(tex.mist, 0x000000, NORMAL, L)]; break;
        case "beam": { const b = sprite(tex.beam, f.color, SCREEN, L); b.anchor.set(0.5, 0); p.s = [b]; break; }
        case "pulse": p.s = [sprite(tex.glow, f.color, SCREEN, L)]; break;
        case "motes": p.s = [sprite(tex.dot, f.color, NORMAL, L)]; break;
        case "haze": p.s = [sprite(tex.mist, f.color, NORMAL, f.low ? front : back)]; break;
        case "cloudsea": {
          // One container in half-size canvas px, pivoted on the mask centre so it pins as one plane.
          const noise = seaNoise(Array.isArray(f.rgb) ? f.rgb : [92, 168, 52]); extraTex.push(noise);
          const W = 2560 * SEA_H, H = 1270 * SEA_H, box = new PIXI.Container();
          box.pivot.set(f.cx * SEA_H, f.cy * SEA_H); box.eventMode = "none"; box.visible = false;
          p.halves = [-1, 1].map((side) => {
            const half = new PIXI.Container();
            const sheets = SEA_LAYERS.map((L) => { const t = new PIXI.TilingSprite(noise, W, H); half.addChild(t); return { t, L }; });
            const mt = seaMask(f, side); extraTex.push(mt);
            const m = new PIXI.Sprite(mt); half.addChild(m); half.mask = m;
            box.addChild(half);
            return { side, sheets };
          });
          L.addChild(box); p.box = box; p.s = [];
          break;
        }
        case "shaft": {
          const [, , w, h] = p.a, key = `${w}x${h}`;
          if (!shaftTex.has(key)) shaftTex.set(key, canvasTex(256, 256, (g) => {
            const gr = g.createLinearGradient(0, 0, 0, 256);
            gr.addColorStop(0, "rgba(255,255,255,0)"); gr.addColorStop(0.35, "rgba(255,255,255,1)"); gr.addColorStop(1, "rgba(255,255,255,0.35)");
            g.fillStyle = gr; g.beginPath(); g.moveTo(128 - 46, 0); g.lineTo(128 + 46, 0); g.lineTo(256, 256); g.lineTo(0, 256); g.closePath(); g.fill();
          }));
          p.s = [sprite(shaftTex.get(key), f.color, ADD, L), sprite(tex.glow, f.color, ADD, L)];
          break;
        }
        default: p.s = [];   // ripple, drip, flutter draw into the shared Graphics
      }
      parts.push(p);
    }
  }

  function step(dt, t) {
    for (const p of parts) {
      const f = p.f;
      switch (f.k) {
        case "gust": if (!p.on) { p.wait -= dt; if (p.wait <= 0) p.on = true; } else { p.x += p.v * dt; p.y += Math.sin(t * 0.8 + p.seed) * 8 * dt; if (p.x > 2700) spawn(p, false); } break;
        case "puff": p.age += dt; if (p.age > p.life) spawn(p, false); break;
        case "mist": p.x += p.v * dt; if (p.v > 0 && p.x > 2900) p.x = -500; if (p.v < 0 && p.x < -500) p.x = 2900; break;
        case "ripple": case "glint": {
          const dur = f.k === "ripple" ? 1.8 : 0.9;
          if (!p.on) { p.wait -= dt; if (p.wait <= 0) { p.on = true; p.age = 0; if (f.k === "glint") { p.x = rnd(f.x0, f.x1); p.y = rnd(f.y0, f.y1); } } }
          else { p.age += dt; if (p.age > dur) { p.on = false; p.wait = f.k === "ripple" ? rnd(1.5, 5) : rnd(0.4, 2.6); } }
          break;
        }
        case "drip": if (!p.on) { p.wait -= dt; if (p.wait <= 0) { const c = f.points[(Math.random() * f.points.length) | 0]; p.x = c[0] + rnd(-20, 20); p.y0 = c[1]; p.y = p.y0 + rnd(f.fall[0], f.fall[1]); p.life = 0; p.on = true; } }
          else { p.life += dt; if (p.life >= 2.3) spawn(p, false); } break;
        case "embers": case "dust": p.age += dt; p.x += p.vx * dt + Math.sin(t * 1.3 + p.seed) * 6 * dt; p.y += p.vy * dt; if (p.age > p.life) spawn(p, false); break;
        case "leaves": p.y += p.vy * dt; p.x += (p.vx + Math.sin(t * 1.6 + p.ph) * 40) * dt; p.rot += dt * 2.2; if (p.y > 1320 || p.y < -80) spawn(p, false); break;
        case "cloud": p.x += p.v * dt; if (p.x > 3400) spawn(p, false); break;
        case "motes": { const [x, y, w, h] = f.area; p.x += p.vx * dt; p.y += p.vy * dt;
          if (p.y < y) p.y = y + h; if (p.y > y + h) p.y = y; if (p.x < x) p.x = x + w; if (p.x > x + w) p.x = x; break; }
        case "haze": { const [x, y, w, h] = f.area; p.x += p.vx * dt; p.y += p.vy * dt;
          if (p.x - p.rx > x + w) p.x = x - p.rx; if (p.x + p.rx < x) p.x = x + w + p.rx; if (p.y < y - 40) p.y = y + h; break; }
        case "rain": for (const d of p.drops) { d.y += d.v * dt; d.x -= d.v * 0.18 * dt; if (d.y > 1270) { d.y = rnd(-200, 0); d.x = rnd(0, 2700); } } break;
        case "splash": { const [x, y, w, h] = f.area; for (const r of p.rips) { r.t += 0.72 * dt; if (r.t > 1) { r.t = 0; r.x = rnd(x, x + w); r.y = rnd(y, y + h); } } break; }
        case "bubble": { const [x, y, w, h] = f.at; for (const b of p.bubs) { b.t += 0.6 * dt * b.s; if (b.t > 1) { b.t = 0; b.x = rnd(x - w / 2, x + w / 2); b.y = rnd(y - h / 2, y + h / 2); } } break; }
        case "slime": for (const d of p.drops) { d.y += d.v * dt; if (d.y > d.y1) { d.y = f.y0; d.v = rnd(90, 180); } } break;
        case "flash": if (Math.random() < dt / (f.every ?? 7)) p.f1 = 1; if (p.f1 > 0) p.f1 = Math.max(0, p.f1 - 3.6 * dt); break;
      }
    }
  }

  // Flicker: two fast sines + a slow wobble.
  const flick = (t, p) => 0.78 + 0.12 * Math.sin(t * 9.1 * p.sp + p.ph) + 0.08 * Math.sin(t * 15.7 * p.sp + p.ph * 2) + 0.06 * Math.sin(t * 1.3 + p.ph);

  function draw(t, k) {
    gfxBack.clear(); gfxFront.clear();
    for (const p of parts) {
      const f = p.f, s = p.s;
      switch (f.k) {
        case "gust": {
          if (!p.on) { s[0].visible = s[1].visible = false; break; }
          const u = clamp((p.x + p.w) / (2560 + p.w * 2), 0, 1), a = f.alpha * Math.sin(Math.PI * u) * k, cx = p.x + p.w / 2;
          place(s[0], cx, p.y, p.w, p.h, a); place(s[1], cx + p.w * 0.075, p.y + p.h * 0.07, p.w * 0.75, p.h * 0.5, a * 0.6); break;
        }
        case "puff": { const u = p.age / p.life, r = p.r * (0.6 + u); place(s[0], p.bx, p.by - u * 70, r * 2, r * 1.4, Math.sin(Math.PI * u) * 0.32 * k); break; }
        case "cloud": place(s[0], p.x, p.y, p.r * 2, p.r * 0.9, f.alpha * 1.5 * k); break;
        case "mist": place(s[0], p.x, p.y, p.r * 2, p.r * 0.6, f.alpha * (0.7 + 0.3 * Math.sin(t * 0.2 + p.ph)) * k); break;
        case "bark": { const [x, y, rx, ry] = p.a, b = 0.55 + 0.35 * Math.sin(t * 0.9 * p.sp + p.ph) + 0.1 * Math.sin(t * 3.1 + p.ph);
          place(s[0], x, y, rx * 2, ry * 2, b * 0.75 * k); place(s[1], x, y, rx * 0.9, ry * 1.2, b * 0.5 * k); break; }
        case "flame": { const [x, y, r0] = p.a, b = flick(t, p), r = r0 * 2.2 * (0.9 + 0.1 * b); place(s[0], x, y, r * 2, r * 2, b * 0.55 * k); break; }
        case "torch": { const a = p.a, b = flick(t, p);
          if (p.floor) place(s[0], a[0], a[1] + 260 * a[2], 760 * a[2], 240 * a[2], b * 0.22 * k);
          else { place(s[0], a[0], a[1], 300 * a[2], 300 * a[2], b * 0.6 * k); place(s[1], a[0], a[1], 68 * a[2], 88 * a[2], b * 0.7 * k); }
          break; }
        case "wash": { const [x, y, rx, ry] = p.a; place(s[0], x, y, rx * 2, ry * 2, f.alpha * (0.85 + 0.15 * Math.sin(t * 0.7 + p.ph)) * k); break; }
        case "shaft": { const [x, y, w, h] = p.a, b = 0.8 + 0.2 * Math.sin(t * 0.35 + p.ph);
          place(s[0], x, y + h / 2, w, h, f.alpha * b * k); place(s[1], x, y + h, w, w * 0.3, f.alpha * b * 1.2 * k); break; }
        case "embers": case "dust": { const u = p.age / p.life, r = p.r * 3; place(s[0], p.x, p.y, r * 2, r * 2, Math.sin(Math.PI * u) * (f.k === "embers" ? 0.95 : 0.55) * k); break; }
        case "leaves": place(s[0], p.x, p.y, 16, 8 * (Math.abs(Math.sin(p.rot * 1.7)) * 0.8 + 0.2), 0.9 * k, p.rot); break;
        case "smoke": { const [x, y] = p.a;
          s.forEach((sp, j) => { const u = (t * 0.08 + p.ph / 6.28 + j / 3) % 1, r = (f.thin ? 26 : 140) * (0.6 + u * 1.4);
            place(sp, x + u * (f.thin ? 70 : 160) + Math.sin(t * 0.5 + j) * 10, y - u * (f.thin ? 160 : 90), r * 2, r * 1.4, f.alpha * Math.sin(Math.PI * u) * k); });
          break; }
        case "fogbank": { const [y, a0] = p.a, b = 0.75 + 0.25 * Math.sin(t * 0.18 + p.ph), sx = (t * 12 + p.off) % 2560;
          s.forEach((sp, j) => place(sp, sx + (j - 1) * 1700 - 400, y, 1900, 320, a0 * b * k)); break; }
        case "glint": {
          if (!p.on) { s[0].visible = false; break; }
          const u = p.age / 0.9, a = Math.sin(Math.PI * u), r = 10 * (0.6 + a), q = pin(p.x, p.y);
          place(s[0], p.x, p.y, r * 1.2, r * 1.2, a * 0.95 * k);
          gfxBack.lineStyle(1.4 * q.s, hex(f.color), a * 0.95 * k);
          gfxBack.moveTo(q.x - r * q.s, q.y); gfxBack.lineTo(q.x + r * q.s, q.y); gfxBack.moveTo(q.x, q.y - r * q.s); gfxBack.lineTo(q.x, q.y + r * q.s);
          break; }
        case "ripple": {
          if (!p.on) break;
          const u = p.age / 1.8, q = pin(p.x, p.y);
          gfxBack.lineStyle(1.6 * q.s, hex(f.color), (1 - u) * 0.5 * k);
          gfxBack.drawEllipse(q.x, q.y, p.R * u * q.s, p.R * u * 0.3 * q.s); break; }
        // map-ambience.js point drips: falling streak, then two rings
        case "drip": {
          if (!p.on) break;
          if (p.life < 0.45) { const kk = p.life / 0.45, y = p.y0 + (p.y - p.y0) * kk * kk, q = pin(p.x, y);
            gfxBack.lineStyle(2 * q.s, 0xc8cdff, 0.55 * k); gfxBack.moveTo(q.x, q.y - 9 * q.s); gfxBack.lineTo(q.x, q.y); }
          else { const q = pin(p.x, p.y);
            for (let j = 0; j < 2; j++) { const kk = (p.life - 0.35 - j * 0.28) / 1.6; if (kk <= 0 || kk >= 1) continue;
              const rx = (4 + 30 * kk) * q.s * 1.3; gfxBack.lineStyle(1.7 * q.s, 0xbec3ff, 0.42 * (1 - kk) * k); gfxBack.drawEllipse(q.x, q.y, rx, rx * 0.42); } }
          break; }
        case "beam": { const [x, y, w, h, rot = 0] = p.a; place(s[0], x, y, w, h, (f.alpha ?? 0.1) * (1 + 0.5 * Math.sin(t * 0.7 + x)) * k, rot); break; }
        case "pulse": { const [x, y, r] = p.a; place(s[0], x, y, r * 2, r * 2, (f.alpha ?? 0.15) * (0.75 + 0.25 * Math.sin(t * 5.3 + x) * Math.sin(t * 2.1 + y)) * k); break; }
        case "motes": place(s[0], p.x, p.y, p.r * 2, p.r * 2, (0.35 + 0.3 * Math.sin(t * 2 + p.ph)) * k); break;
        case "haze": place(s[0], p.x, p.y, p.rx * 2, p.ry * 2, f.alpha * (0.7 + 0.3 * Math.sin(t * 0.4 + p.ph)) * k); break;
        case "rain": { const c = hex(f.color ?? "#cdc3f0");
          for (const d of p.drops) { const q = pin(d.x, d.y); gfxFront.lineStyle(1.6 * q.s, c, (f.alpha ?? 0.28) * k); gfxFront.moveTo(q.x, q.y); gfxFront.lineTo(q.x + d.l * 0.18 * q.s, q.y - d.l * q.s); }
          break; }
        case "splash": { const c = hex(f.color ?? "#d2c8ff");
          for (const r of p.rips) { const q = pin(r.x, r.y), rr = (6 + r.t * 34) * q.s; gfxBack.lineStyle(2 * q.s, c, 0.35 * (1 - r.t) * k); gfxBack.drawEllipse(q.x, q.y, rr, rr * 0.32); }
          break; }
        case "bubble": { const c = hex(f.color ?? "#c8ff78");
          for (const b of p.bubs) { const q = pin(b.x, b.y - b.t * 10), r = (3 + b.t * 11) * q.s;
            gfxBack.lineStyle(2 * q.s, c, 0.7 * (1 - b.t) * k); gfxBack.beginFill(c, 0.18 * (1 - b.t) * k); gfxBack.drawEllipse(q.x, q.y, r, r * 0.7); gfxBack.endFill(); }
          break; }
        case "slime": { const c = hex(f.color ?? "#aaff5a");
          for (const d of p.drops) { const q = pin(d.x, d.y); gfxBack.lineStyle(0); gfxBack.beginFill(c, 0.75 * k); gfxBack.drawEllipse(q.x, q.y, 3 * q.s, 6 * q.s); gfxBack.endFill(); }
          break; }
        case "cloudsea": {
          // map-ambience placeClouds(): translate(P) rotate(spin t) translate(-P + drift t) scale(s), per half
          const sec = t * (f.speed ?? 1), P = [f.ox * SEA_H, f.oy * SEA_H], q = pin(f.cx, f.cy);
          for (const h of p.halves) for (const { t: sp, L: Ly } of h.sheets) {
            const spin = Math.abs(Ly.spin) * h.side * (Ly.spin < 0 ? 0.7 : 1), dx = Math.abs(Ly.dx) * h.side * SEA_H, dy = -Math.abs(Ly.dy) * SEA_H;
            const th = sec * spin, cs = Math.cos(th), sn = Math.sin(th), ex = sec * dx - P[0], ey = sec * dy - P[1];
            sp.tileTransform.position.set(P[0] + cs * ex - sn * ey, P[1] + sn * ex + cs * ey);
            sp.tileTransform.rotation = th;
            sp.tileTransform.scale.set(Ly.s * SEA_H * (f.size ?? 1), Ly.s * SEA_H * (f.size ?? 1));
            sp.alpha = clamp(Ly.a * (f.alpha ?? 1), 0, 1);
          }
          p.box.visible = k > 0.003; p.box.alpha = clamp(k, 0, 1);
          p.box.position.set(q.x, q.y); p.box.scale.set(q.s / SEA_H, q.s / SEA_H);
          break; }
        case "flash": { if (p.f1 <= 0) break;   // whole view, not pinned: the flash is the sky lighting up
          gfxFront.lineStyle(0); gfxFront.beginFill(hex(f.color ?? "#d2beff"), (f.alpha ?? 0.22) * p.f1 * k); gfxFront.drawRect(-3000, -3000, 9000, 8000); gfxFront.endFill(); break; }
        case "flutter": {
          const x = p.bx + Math.sin(t * 0.4 + p.ph) * 140 + Math.sin(t * 1.1 + p.ph) * 40, y = p.by + Math.sin(t * 0.7 + p.ph * 2) * 50, q = pin(x, y);
          const w = (Math.abs(Math.sin(t * 14 + p.ph)) * 7 + 1) * q.s;
          gfxFront.lineStyle(0); gfxFront.beginFill(p.c, 0.95 * k);
          gfxFront.drawEllipse(q.x - w * 0.6, q.y, w, 5 * q.s); gfxFront.drawEllipse(q.x + w * 0.6, q.y, w, 5 * q.s); gfxFront.endFill();
          break; }
      }
    }
  }

  return {
    step, draw,
    count: () => parts.reduce((n, p) => n + Math.max(1, p.s.length), 0),
    destroy() {
      for (const t of [...Object.values(tex), ...shaftTex.values(), ...extraTex]) { try { t.destroy(true); } catch { /* already gone */ } }
    },
  };
}
