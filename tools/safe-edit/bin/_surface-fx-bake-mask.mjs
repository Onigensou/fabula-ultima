// ============================================================================
// Surface FX mask bake: the gas / water mask that scripts/map-system/
// map-surface-fx.js and map-ambience.js read.
//
//   node tools/safe-edit/bin/_surface-fx-bake-mask.mjs <painting.png> <preset> <out.webp>
//   node tools/safe-edit/bin/_surface-fx-bake-mask.mjs <painting.png> <preset> <out.webp> --preview <preview.png>
//
// Presets live below (one per map). The colour rules are the approved mockup's
// (Underground Decor mockup, 2026-11-06), so the game masks the same pixels the
// user approved.
//
// Output: quarter-size lossless webp.
//   R = the surface (gas or water), lightly softened
//   G = the same, widely blurred: how close a pixel is to the surface
//       (underglow reach, plume reach)
//   B = 0
// Needs ffmpeg on PATH (decode and encode only).
// ============================================================================

import { execFileSync } from "node:child_process";

const PRESETS = {
  // Nether Bridge, Valley_Map032.png 2048x3072: green gas in the chasm.
  "nether-bridge": {
    k: 4,
    pick(r, g, b, mx, my) {
      if (my > 2560 || my < 380 || inPoly(mx, my, DECK)) return 0;
      const ratio = g / (Math.max(r, b) + 8);
      return Math.min(1, Math.max(0, (ratio - 1.02) / 0.22));
    },
  },
  // Ancient Mural, Valley_Map019.png 1448x944: the dark blue pool.
  "ancient-mural": {
    k: 4,
    pick(r, g, b, mx, my) {
      const luma = 0.3 * r + 0.5 * g + 0.2 * b;
      return g >= r - 4 && b > g * 1.25 && luma < 115 && my > 470 ? 1 : 0;
    },
  },
  // Valley of the Dragon - Camp, Valley_Map011.png 1448x1086: the pond, as the
  // approved Valley camp mockup (2026-11-06) drew it (shallows + deep polygons).
  "valley-camp": {
    k: 4,
    pick(r, g, b, mx, my) {
      return inPoly(mx, my, CAMP_POND_DEEP) || inPoly(mx, my, CAMP_POND_SHALLOW) ? 1 : 0;
    },
  },
  // Underground Lake, Valley_Map034.png 1448x1086: the lake as the approved
  // mockup (2026-11-07) drew it, a little past the Regions so the shimmer
  // reaches the painted shoreline.
  "underground-lake": {
    k: 4,
    pick(r, g, b, mx, my) { return inPoly(mx, my, LAKE_LOOK) ? 1 : 0; },
  },
  // Cave Dwelling, Valley_Map033.png 1448x1086: no water. An empty mask so the
  // water-mode lighting, crystal glows and haze run with nothing rippling.
  "cave-dwelling": {
    k: 4,
    pick() { return 0; },
  },
};
const LAKE_LOOK = [[330,520],[520,470],[900,430],[1448,420],[1448,800],[1250,870],[1100,1000],[880,990],[740,920],[620,850],[500,790],[400,710],[350,640]];

// Valley camp pond (map px), same points as the water Regions on Valley_Map004.
const CAMP_POND_DEEP = [[890,575],[930,552],[990,545],[1060,550],[1130,552],[1150,580],[1150,605],[1195,615],[1245,608],[1295,622],[1322,660],[1318,715],[1290,752],[1240,778],[1180,800],[1120,802],[1060,792],[1000,798],[940,795],[895,775],[885,700],[895,620]];
const CAMP_POND_SHALLOW = [[705,640],[745,616],[805,612],[852,596],[890,575],[895,620],[885,700],[895,775],[860,752],[800,740],[745,730],[712,700]];

// The bridge deck (map px). Gas never flows across it.
const DECK = [[985, 680], [878, 1272], [555, 2530], [1565, 2530], [1212, 1272], [1095, 680]];

function inPoly(x, y, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

function boxBlur(a, w, h, r, passes) {
  const tmp = new Float32Array(a.length);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) {
      let s = 0; const row = y * w;
      for (let x = -r; x <= r; x++) s += a[row + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) { tmp[row + x] = s / (2 * r + 1); s += a[row + Math.min(w - 1, x + r + 1)] - a[row + Math.max(0, x - r)]; }
    }
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let y = -r; y <= r; y++) s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) { a[y * w + x] = s / (2 * r + 1); s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x]; }
    }
  }
  return a;
}

function probe(file) {
  const out = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file]).toString().trim();
  const [w, h] = out.split(",").map(Number);
  return { w, h };
}

function main() {
  const [src, presetName, out, flag, preview] = process.argv.slice(2);
  const preset = PRESETS[presetName];
  if (!src || !preset || !out) {
    console.error(`usage: bake-mask.mjs <painting> <${Object.keys(PRESETS).join("|")}> <out.webp> [--preview <png>]`);
    process.exit(2);
  }
  const { w: W, h: H } = probe(src);
  const k = preset.k, w = Math.round(W / k), h = Math.round(H / k);
  // area downscale, like the mockup's canvas drawImage
  const px = execFileSync("ffmpeg", ["-v", "error", "-i", src, "-vf", `scale=${w}:${h}:flags=area`, "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { maxBuffer: 1 << 28 });
  const raw = new Float32Array(w * h);
  for (let i = 0, y = 0; y < h; y++) for (let x = 0; x < w; x++, i++) {
    raw[i] = preset.pick(px[i * 4], px[i * 4 + 1], px[i * 4 + 2], x * k, y * k);
  }
  const sharp = boxBlur(Float32Array.from(raw), w, h, 2, 2);
  const wide = boxBlur(Float32Array.from(raw), w, h, 18, 3);
  const rgb = Buffer.alloc(w * h * 3);
  let cover = 0;
  for (let i = 0; i < w * h; i++) {
    const s = Math.min(1, sharp[i] * 1.25);
    rgb[i * 3] = Math.round(s * 255);
    rgb[i * 3 + 1] = Math.round(Math.min(1, wide[i] * 1.6) * 255);
    if (s > 0.5) cover++;
  }
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${w}x${h}`, "-i", "-", "-c:v", "libwebp", "-lossless", "1", out], { input: rgb });
  console.log(`${presetName}: ${W}x${H} -> ${w}x${h} mask, surface ${(100 * cover / (w * h)).toFixed(1)}% -> ${out}`);

  if (flag === "--preview" && preview) {
    // the painting with the mask tinted over it (R = surface in magenta, G = reach in cyan)
    const tint = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      tint[i * 4] = rgb[i * 3]; tint[i * 4 + 1] = 0; tint[i * 4 + 2] = rgb[i * 3];
      tint[i * 4 + 3] = Math.round(rgb[i * 3] * 0.55);
    }
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", src, "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${w}x${h}`, "-i", "-",
      "-filter_complex", `[0:v]scale=${w}:${h}[a];[a][1:v]overlay=0:0`, "-frames:v", "1", preview], { input: tint });
    console.log(`preview -> ${preview}`);
  }
}

main();
