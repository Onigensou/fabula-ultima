#!/usr/bin/env node
//
// Storyboard sheet generator.
//
//   node tools/anim-studio/bin/storyboard-template.js [--out DIR] [--subject NAME]
//                                                     [--pages N] [--start N]
//
// Writes printable/paintable storyboard sheets: a stack of panels, each with a
// drawing box on the left and a description column on the right.
//
// WHY THE PANEL IS 1.870:1 AND NOT 16:9
// mockup-templates.js captures the live viewport, and the existing pack in
// "VFX Mockups/Fafnir" is 1920x1027. A storyboard panel whose aspect does not
// match that is actively misleading: you would compose a shot in one frame and
// find it cropped in the other. The panel aspect is therefore pinned to the
// same number, and changing one without the other is a bug.
//
// NO DEPENDENCIES ON PURPOSE. anim-studio has an empty dependency list and the
// only reason this file would need one is rasterising, so the PNG encoder and
// the bitmap font are inline below. That is a deliberate trade of a hundred
// lines against a build step.

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

/* ── PNG encoding ────────────────────────────────────────────────────────── */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

// 8-bit RGB, filter type 0 on every scanline. Plenty for flat line art, and it
// keeps the encoder to one page.
function encodePNG(width, height, rgb) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ── Canvas ──────────────────────────────────────────────────────────────── */

function makeCanvas(w, h, fill = [255, 255, 255]) {
  const buf = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    buf[i * 3] = fill[0]; buf[i * 3 + 1] = fill[1]; buf[i * 3 + 2] = fill[2];
  }
  return {
    w, h, buf,
    px(x, y, c) {
      x |= 0; y |= 0;
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      const i = (y * w + x) * 3;
      buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2];
    },
    fillRect(x, y, rw, rh, c) {
      for (let j = y; j < y + rh; j++) for (let i = x; i < x + rw; i++) this.px(i, j, c);
    },
    strokeRect(x, y, rw, rh, c, t = 2) {
      this.fillRect(x, y, rw, t, c);
      this.fillRect(x, y + rh - t, rw, t, c);
      this.fillRect(x, y, t, rh, c);
      this.fillRect(x + rw - t, y, t, rh, c);
    },
    hLine(x, y, len, c, t = 2) { this.fillRect(x, y, len, t, c); },
    vLine(x, y, len, c, t = 2) { this.fillRect(x, y, t, len, c); },
    // Dashes read as "guide, not artwork" at a glance, which matters inside the
    // drawing box where a solid line would be mistaken for content.
    hDash(x, y, len, c, t = 1, on = 12, off = 12) {
      for (let i = 0; i < len; i += on + off) this.fillRect(x + i, y, Math.min(on, len - i), t, c);
    },
    vDash(x, y, len, c, t = 1, on = 12, off = 12) {
      for (let i = 0; i < len; i += on + off) this.fillRect(x, y + i, t, Math.min(on, len - i), c);
    },
  };
}

/* ── 5x7 bitmap font ─────────────────────────────────────────────────────── */

const FONT = {
  A: "01110,10001,10001,11111,10001,10001,10001",
  B: "11110,10001,10001,11110,10001,10001,11110",
  C: "01110,10001,10000,10000,10000,10001,01110",
  D: "11110,10001,10001,10001,10001,10001,11110",
  E: "11111,10000,10000,11110,10000,10000,11111",
  F: "11111,10000,10000,11110,10000,10000,10000",
  G: "01110,10001,10000,10111,10001,10001,01111",
  H: "10001,10001,10001,11111,10001,10001,10001",
  I: "11111,00100,00100,00100,00100,00100,11111",
  J: "00111,00010,00010,00010,00010,10010,01100",
  K: "10001,10010,10100,11000,10100,10010,10001",
  L: "10000,10000,10000,10000,10000,10000,11111",
  M: "10001,11011,10101,10101,10001,10001,10001",
  N: "10001,11001,10101,10011,10001,10001,10001",
  O: "01110,10001,10001,10001,10001,10001,01110",
  P: "11110,10001,10001,11110,10000,10000,10000",
  Q: "01110,10001,10001,10001,10101,10010,01101",
  R: "11110,10001,10001,11110,10100,10010,10001",
  S: "01111,10000,10000,01110,00001,00001,11110",
  T: "11111,00100,00100,00100,00100,00100,00100",
  U: "10001,10001,10001,10001,10001,10001,01110",
  V: "10001,10001,10001,10001,10001,01010,00100",
  W: "10001,10001,10001,10101,10101,11011,10001",
  X: "10001,10001,01010,00100,01010,10001,10001",
  Y: "10001,10001,01010,00100,00100,00100,00100",
  Z: "11111,00001,00010,00100,01000,10000,11111",
  0: "01110,10001,10011,10101,11001,10001,01110",
  1: "00100,01100,00100,00100,00100,00100,01110",
  2: "01110,10001,00001,00010,00100,01000,11111",
  3: "11111,00010,00100,00010,00001,10001,01110",
  4: "00010,00110,01010,10010,11111,00010,00010",
  5: "11111,10000,11110,00001,00001,10001,01110",
  6: "00110,01000,10000,11110,10001,10001,01110",
  7: "11111,00001,00010,00100,01000,01000,01000",
  8: "01110,10001,10001,01110,10001,10001,01110",
  9: "01110,10001,10001,01111,00001,00010,01100",
  " ": "00000,00000,00000,00000,00000,00000,00000",
  "/": "00001,00010,00010,00100,01000,01000,10000",
  ":": "00000,00100,00100,00000,00100,00100,00000",
  "-": "00000,00000,00000,11111,00000,00000,00000",
  ".": "00000,00000,00000,00000,00000,01100,01100",
  ",": "00000,00000,00000,00000,01100,00100,01000",
  "#": "01010,01010,11111,01010,11111,01010,01010",
  "(": "00010,00100,01000,01000,01000,00100,00010",
  ")": "01000,00100,00010,00010,00010,00100,01000",
  "+": "00000,00100,00100,11111,00100,00100,00000",
  "?": "01110,10001,00001,00010,00100,00000,00100",
};

function textWidth(str, scale, tracking = 1) {
  return str.length * (5 * scale + tracking * scale) - tracking * scale;
}

function drawText(cv, str, x, y, scale, color, tracking = 1) {
  let cx = x;
  for (const raw of String(str).toUpperCase()) {
    const rows = (FONT[raw] || FONT["?"]).split(",");
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 5; c++) {
        if (rows[r][c] === "1") cv.fillRect(cx + c * scale, y + r * scale, scale, scale, color);
      }
    }
    cx += 5 * scale + tracking * scale;
  }
  return cx;
}

/* ── Sheet layout ────────────────────────────────────────────────────────── */

const INK      = [26, 26, 30];
const RULE     = [120, 124, 134];
const FAINT    = [206, 210, 218];
const GUIDE    = [226, 229, 236];
const PAPER    = [255, 255, 255];
const BAR_TEXT = [255, 255, 255];

const VIEWPORT_ASPECT = 1920 / 1027;   // pinned to mockup-templates.js output

const SHEET_W = 2400;
const MARGIN  = 64;
const GAP     = 40;                     // drawing box -> description column
const IMG_W   = 1420;
const IMG_H   = Math.round(IMG_W / VIEWPORT_ASPECT);   // 759
const COL_X   = MARGIN + IMG_W + GAP;
const COL_W   = SHEET_W - MARGIN - COL_X;
const ROW_GAP = 60;
const HEAD_H  = 150;
const PANELS  = 4;
const SHEET_H = MARGIN + HEAD_H + PANELS * IMG_H + (PANELS - 1) * ROW_GAP + MARGIN;

// Labelled single-line fields, in the order these shots actually get specified.
const FIELDS = ["TIME", "CAMERA", "VFX", "SFX"];

function drawPanel(cv, top, label) {
  /* Drawing box. */
  cv.strokeRect(MARGIN, top, IMG_W, IMG_H, INK, 3);

  // Thirds + centre, dashed and pale: composition help that cannot be mistaken
  // for something you drew.
  for (let i = 1; i <= 2; i++) {
    cv.vDash(MARGIN + Math.round(IMG_W * i / 3), top + 4, IMG_H - 8, GUIDE, 2, 14, 16);
    cv.hDash(MARGIN + 4, top + Math.round(IMG_H * i / 3), IMG_W - 8, GUIDE, 2, 14, 16);
  }
  const cx = MARGIN + (IMG_W >> 1), cy = top + (IMG_H >> 1);
  cv.hDash(cx - 30, cy, 60, FAINT, 2, 60, 0);
  cv.vDash(cx, cy - 30, 60, FAINT, 2, 60, 0);

  /* Description column. */
  let y = top;

  // Header bar carries the panel number.
  cv.fillRect(COL_X, y, COL_W, 48, INK);
  drawText(cv, label, COL_X + 16, y + 15, 3, BAR_TEXT);
  y += 48 + 18;

  for (const f of FIELDS) {
    drawText(cv, f, COL_X, y, 2, RULE);
    cv.hLine(COL_X, y + 30, COL_W, FAINT, 2);
    y += 52;
  }

  y += 10;
  drawText(cv, "ACTION / NOTES", COL_X, y, 2, RULE);
  y += 30;

  // Ruled lines to the foot of the drawing box, so the two columns end level.
  const bottom = top + IMG_H;
  for (let ly = y + 26; ly <= bottom - 6; ly += 40) cv.hLine(COL_X, ly, COL_W, FAINT, 2);
}

function drawSheet({ subject, page, pages, startPanel, numbered }) {
  const cv = makeCanvas(SHEET_W, SHEET_H, PAPER);

  /* Header. */
  drawText(cv, "STORYBOARD", MARGIN, MARGIN, 6, INK);

  const sub = subject || "";
  if (sub) drawText(cv, sub, MARGIN, MARGIN + 56, 4, RULE);

  // Right-aligned page stamp.
  if (numbered) {
    const stamp = "PAGE " + String(page).padStart(2, "0") + " / " + String(pages).padStart(2, "0");
    drawText(cv, stamp, SHEET_W - MARGIN - textWidth(stamp, 3), MARGIN + 8, 3, RULE);
  }
  const seq = "SEQUENCE:";
  const sx = SHEET_W - MARGIN - 520;
  drawText(cv, seq, sx, MARGIN + 62, 3, RULE);
  cv.hLine(sx + textWidth(seq, 3) + 14, MARGIN + 84, 520 - textWidth(seq, 3) - 14, FAINT, 2);

  cv.hLine(MARGIN, MARGIN + HEAD_H - 28, SHEET_W - 2 * MARGIN, INK, 3);

  /* Panels. */
  for (let i = 0; i < PANELS; i++) {
    const top = MARGIN + HEAD_H + i * (IMG_H + ROW_GAP);
    const label = numbered
      ? "PANEL " + String(startPanel + i).padStart(2, "0")
      : "PANEL";
    drawPanel(cv, top, label);
  }

  return encodePNG(SHEET_W, SHEET_H, cv.buf);
}

/* ── CLI ─────────────────────────────────────────────────────────────────── */

function main() {
  const argv = process.argv.slice(2);
  const arg = (name, dflt) => {
    const i = argv.indexOf("--" + name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
  };

  const outRoot = arg("out", "C:/Users/Oni/OneDrive/Desktop/VFX Mockups");
  const subject = arg("subject", "");
  const pages   = Math.max(1, parseInt(arg("pages", "4"), 10) || 4);
  const start   = Math.max(1, parseInt(arg("start", "1"), 10) || 1);

  const outDir = subject ? path.join(outRoot, subject) : outRoot;
  fs.mkdirSync(outDir, { recursive: true });

  const written = [];

  if (subject) {
    for (let p = 1; p <= pages; p++) {
      const png = drawSheet({
        subject, page: p, pages, numbered: true,
        startPanel: start + (p - 1) * PANELS,
      });
      const f = path.join(outDir, "storyboard-p" + String(p).padStart(2, "0") + ".png");
      fs.writeFileSync(f, png);
      written.push([f, png.length]);
    }
  }

  // The reusable blank always lands at the root of the mockup folder.
  const blank = drawSheet({ subject: "", page: 1, pages: 1, startPanel: 1, numbered: false });
  const bf = path.join(outRoot, "storyboard-template.png");
  fs.writeFileSync(bf, blank);
  written.push([bf, blank.length]);

  console.log("sheet " + SHEET_W + "x" + SHEET_H +
              "  panel box " + IMG_W + "x" + IMG_H +
              " (aspect " + (IMG_W / IMG_H).toFixed(3) + ")" +
              "  " + PANELS + " panels/page");
  for (const [f, n] of written) {
    console.log("  " + (n / 1024).toFixed(0).padStart(5) + " KB  " + f);
  }
}

main();
