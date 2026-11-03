// canvas-mode-test — proves the headless canvas modes (lib/foundry.js useCanvasMode) are safe:
//   1. a headless connect() defaults to "off" and nothing is drawn between captures,
//   2. page.screenshot() in "off" captures the same picture as "full" (drawn for real),
//   3. PIXI renderer.extract in "off" gives the same pixels as in "full",
//   4. the mode survives a page reload.
// Run against the Staging World (it writes nothing):  FVTT_STAGING=1 node scripts/canvas-mode-test.mjs
import { connect } from "../lib/foundry.js";

const fvtt = await connect();
const { page } = fvtt;
const R = { checks: [] };
const check = (name, pass, detail) => { R.checks.push({ name, pass: !!pass, detail }); console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  " + JSON.stringify(detail) : ""}`); };

// pixel stats of a PNG (decoded in the page, so no image library is needed)
const stats = (buf) => page.evaluate(async (b64) => {
  const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
  const c = new OffscreenCanvas(img.width, img.height), x = c.getContext("2d");
  x.drawImage(img, 0, 0);
  const d = x.getImageData(0, 0, img.width, img.height).data;
  let sum = 0, nonDark = 0;
  for (let i = 0; i < d.length; i += 4) { const v = d[i] + d[i + 1] + d[i + 2]; sum += v; if (v > 60) nonDark++; }
  return { w: img.width, h: img.height, mean: +(sum / (d.length / 4) / 3).toFixed(1), nonDarkShare: +(nonDark / (d.length / 4)).toFixed(3) };
}, buf.toString("base64"));
const diff = (a, b) => page.evaluate(async ([a64, b64]) => {
  const load = async (s) => { const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${s}`)).blob()); const c = new OffscreenCanvas(img.width, img.height); const x = c.getContext("2d"); x.drawImage(img, 0, 0); return x.getImageData(0, 0, img.width, img.height).data; };
  const A = await load(a64), B = await load(b64);
  if (A.length !== B.length) return { sameSize: false };
  let s = 0; for (let i = 0; i < A.length; i += 4) s += Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]);
  return { sameSize: true, meanAbsDiff: +(s / (A.length / 4) / 3).toFixed(2) };
}, [a.toString("base64"), b.toString("base64")]);
const state = () => page.evaluate(() => {
  const r = canvas.app.renderer;
  return { mode: globalThis.__fvttCanvas?.mode ?? "full", resolution: r.resolution, renderIsNoop: r.render.toString().replace(/\s/g, "") === "function(){}" };
});
const countDraws = () => page.evaluate(async () => {
  const r = canvas.app.renderer, gl = r.gl; let n = 0;
  const real = gl.drawElements; gl.drawElements = function (...a) { n++; return real.apply(this, a); };
  await new Promise((res) => setTimeout(res, 1500));
  gl.drawElements = real; return n;
});
const extractSig = () => page.evaluate(async () => {
  const px = canvas.app.renderer.extract.pixels(canvas.stage);
  const d = px instanceof Uint8Array || px instanceof Uint8ClampedArray ? px : (await px);
  let s = 0; for (let i = 0; i < d.length; i += 97) s += d[i];
  return { len: d.length, sig: s };
});

try {
  const s0 = await state();
  check("headless connect() defaults to off", s0.mode === "off" && s0.renderIsNoop && s0.resolution === 0.25, s0);
  const drawsOff = await countDraws();
  check("off: no GL draw calls between captures", drawsOff === 0, { drawCallsIn1500ms: drawsOff });

  // Bracket the off capture between two full ones, all after the page has settled: the
  // first draft compared an early off shot with later full ones, and the page itself was
  // still changing (a 5.2 "difference" that a fair ordering does not show).
  await page.waitForTimeout(3000);
  await fvtt.setCanvas("full"); await page.waitForTimeout(800);
  const drawsFull = await countDraws();
  const fullA = await page.screenshot({ path: "shots/canvas-mode-fullA.png" });
  const extA = await extractSig();
  await fvtt.setCanvas("off"); await page.waitForTimeout(800);
  const offShot = await page.screenshot({ path: "shots/canvas-mode-off.png" });
  const offStats = await stats(offShot);
  const offExtract = await extractSig();
  const s1 = await state();
  check("off: back to no drawing after the capture", s1.renderIsNoop && s1.resolution === 0.25, s1);
  await fvtt.setCanvas("full"); await page.waitForTimeout(800);
  const fullB = await page.screenshot({ path: "shots/canvas-mode-fullB.png" });
  const extB = await extractSig();
  check("full: the canvas really draws", drawsFull > 0, { drawCallsIn1500ms: drawsFull });
  check("off screenshot is a real picture (not blank)", offStats.nonDarkShare > 0.05, offStats);
  const dA = await diff(offShot, fullA), dB = await diff(offShot, fullB), floor = await diff(fullA, fullB);
  const dOff = Math.min(dA.meanAbsDiff, dB.meanAbsDiff);
  check("off screenshot ≈ full screenshots (within the full-vs-full noise floor)",
    dA.sameSize && dOff <= Math.max(1, floor.meanAbsDiff * 1.5), { offVsFullA: dA.meanAbsDiff, offVsFullB: dB.meanAbsDiff, fullAvsFullB: floor.meanAbsDiff });
  const sigFloor = Math.abs(extA.sig - extB.sig), sigDiff = Math.min(Math.abs(offExtract.sig - extA.sig), Math.abs(offExtract.sig - extB.sig));
  check("extract in off ≈ extract in full (within the full-vs-full noise floor)",
    offExtract.len === extA.len && sigDiff <= Math.max(extA.sig * 0.01, sigFloor * 1.5), { offExtract, extA, extB, sigDiff, sigFloor });

  await fvtt.setCanvas("off");
  await fvtt.hardReload();
  await page.waitForFunction(() => globalThis.canvas?.ready === true, null, { timeout: 60000 });
  await page.waitForTimeout(1000);
  const s2 = await state();
  check("the mode survives a reload", s2.mode === "off" && s2.renderIsNoop, s2);
} catch (e) { check("test ran", false, e.message); }
finally { await fvtt.close(); }
const bad = R.checks.filter((c) => !c.pass).length;
console.log(bad ? `✗ ${bad} check(s) failed` : `✓ all ${R.checks.length} checks passed`);
process.exitCode = bad ? 1 : 0;
