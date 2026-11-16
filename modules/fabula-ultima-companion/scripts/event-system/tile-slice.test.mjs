// Tests for Set Tile's slice geometry (event-rows-tile.js, TileSlice). No game
// required: the file publishes its pure geometry before it looks for the game.
//
// Run: node <this file>
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const print = console.log.bind(console);
let fail = 0;
const check = (name, ok, detail = "") => {
  print(`${ok ? "PASS" : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) fail++;
};
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

globalThis.window = globalThis;
const realError = console.error;
console.error = () => {};   // "Missing Logic..." is expected here
vm.runInThisContext(readFileSync(resolve(HERE, "event-rows-tile.js"), "utf8"), { filename: "event-rows-tile.js" });
console.error = realError;

const S = globalThis.oni?.EventSystem?.TileSlice;
check("TileSlice is published without the game", !!S);
if (!S) process.exit(1);

// --- parsing -------------------------------------------------------------
const parsed = S.parseCuts("-14.33, -34.1\n\n  56.11 , -27.7\n# note\nnonsense\n12");
check("parseCuts reads lines, skips blanks/comments/bad", parsed.length === 2
  && parsed[0].angleDeg === -14.33 && parsed[0].offsetPx === -34.1 && parsed[1].angleDeg === 56.11);
check("parseCuts takes saved arrays", S.parseCuts([{ angleDeg: 10, offsetPx: 5 }, [20, -3], { angleDeg: "x" }]).length === 2);
check("badCutLines lists the unreadable lines", JSON.stringify(S.badCutLines("1,2\nfoo\n3")) === JSON.stringify(["foo", "3"]));
check("formatCuts round-trips", S.parseCuts(S.formatCuts(parsed)).length === 2);
check("keepBelow default and clamp", S.clampKeepBelow(undefined) === 0.62 && S.clampKeepBelow(2) === 1 && S.clampKeepBelow(-1) === 0 && S.clampKeepBelow("") === 0.62);
check("normalizeSlice: no cuts is null", S.normalizeSlice({ cuts: [] }) === null && S.normalizeSlice(null) === null);

// --- the cut line --------------------------------------------------------
{
  const l = S.cutLine({ angleDeg: 0, offsetPx: 10 }, 100, 200);
  check("angle 0 is horizontal, offset moves it down (+90°)", near(l.dx, 1) && near(l.dy, 0) && near(l.px, 50) && near(l.py, 110));
  const v = S.cutLine({ angleDeg: 90, offsetPx: 10 }, 100, 200);
  check("angle 90 is vertical, offset moves it left", near(v.dx, 0) && near(v.dy, 1) && near(v.px, 40) && near(v.py, 100));
}

// --- splitting ---------------------------------------------------------
{
  const pieces = S.slicePieces(100, 100, [{ angleDeg: 0, offsetPx: 0 }]);
  check("one horizontal cut: two halves", pieces.length === 2);
  const ys = pieces.map(p => p.cy).sort((a, b) => a - b);
  check("halves centred at 25 and 75", near(ys[0], 25) && near(ys[1], 75), JSON.stringify(ys));
  const outside = S.slicePieces(100, 100, [{ angleDeg: 0, offsetPx: 500 }]);
  check("a cut that misses leaves the tile whole", outside.length === 1);
  const cls = S.classifyPieces(100, 100, { cuts: [{ angleDeg: 0, offsetPx: 0 }], keepBelow: 0.62 });
  check("top half falls, bottom half stays at 0.62? (75 > 62)", cls.find(p => p.cy > 50).keep === true && cls.find(p => p.cy < 50).keep === false);
}

// Areas add up to the whole tile.
const area = (poly) => Math.abs(poly.reduce((s, p, i) => {
  const q = poly[(i + 1) % poly.length];
  return s + (p[0] * q[1]) - (q[0] * p[1]);
}, 0)) / 2;

// --- the real scene's cuts ---------------------------------------------
{
  const W = 307.5, H = 410;
  const text = "-14.33, -34.1\n56.11, -27.7\n-57.59, 29.9\n28.19, 33.7";
  const slice = S.normalizeSlice({ cuts: S.parseCuts(text), keepBelow: 0.62 });
  check("real cuts: 4 cuts read", slice.cuts.length === 4);
  const pieces = S.classifyPieces(W, H, slice);
  const kept = pieces.filter(p => p.keep), falling = pieces.filter(p => !p.keep);
  print(`  real cuts: ${pieces.length} pieces, ${kept.length} kept, ${falling.length} falling`);
  for (const p of pieces) print(`    ${p.keep ? "keep" : "fall"}  centre ${p.cx.toFixed(1)}, ${p.cy.toFixed(1)}  corners ${p.poly.length}`);
  check("real cuts: several pieces", pieces.length >= 4, String(pieces.length));
  check("real cuts: at least one kept", kept.length >= 1);
  check("real cuts: at least one falling", falling.length >= 1);
  const total = pieces.reduce((s, p) => s + area(p.poly), 0);
  check("real cuts: pieces cover the tile exactly", near(total, W * H, 1e-3), `${total} vs ${W * H}`);
  check("keptPolygons matches the kept pieces", S.keptPolygons(W, H, slice).length === kept.length);
  check("every corner lies on the tile", pieces.every(p => p.poly.every(([x, y]) => x >= -1e-9 && x <= W + 1e-9 && y >= -1e-9 && y <= H + 1e-9)));
}

print(fail ? `\n${fail} FAILED` : "\nAll passed");
process.exit(fail ? 1 : 0);
