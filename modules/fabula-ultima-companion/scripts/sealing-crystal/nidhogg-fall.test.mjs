// Node checks for Nidhogg's fall (pure parts): the ruled timeline (docs/nidhogg-boss-design.md §8b), the user's sound
// picks, the two painters, and the crystal renderer's new params.
//   node modules/fabula-ultima-companion/scripts/sealing-crystal/nidhogg-fall.test.mjs
import { fallState, fallEnd, FALL_SFX, FALL_BED, bedVolume, SOUL_UP_FX, SHOW, BEATS } from "./nidhogg-fall.js";
import { makeFallPainter, VOID_FRAME } from "./fall-painter.js";
import { makeCrystal, crystalMesh } from "./crystal-render.js";
import { LOOK } from "./crystal-painter.js";
import { cueStart } from "../shared/sfx-cues.js";
import { makeCurtain } from "../shared/hud-curtain.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("FAIL", m); } };
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

// ── the first fall's beats (§8b table) ──
{
  ok(near(fallEnd("first"), 20.6), "first fall is 20.6 s");
  ok(near(fallEnd("repeat"), 5.8), "later fall is 5.8 s");
  const at = (T) => fallState("first", T);
  ok(at(0.1).hud === 1 && at(0.6).hud === 0, "HUD fades out 0.15-0.6");
  ok(at(7.3).smoke && !at(7.4).smoke && at(7.4).arenaBlack, "black at 7.4 (smoke and arena go together)");
  ok(at(5).smokeOver, "first fall: the smoke covers the party");
  ok(at(7.0).party === 1 && at(7.5).party === 0 && at(18.4).party === 0 && near(at(19.4).party, 1), "party under the smoke, hidden in the dark, back 18.5-19.4");
  ok(at(7.5).cam === 0 && near(at(8.2).cam, 1) && near(at(18.2).cam, 1) && near(at(19.4).cam, 0), "camera in 7.5-8.2 (unseen), back 18.2-19.4");
  ok(at(8.2).arenaBlack, "the camera's move in is inside the black");
  ok(at(10.39).void === null && at(10.4).void, "blips start at 10.4");
  ok(at(13.19).crystal === null && at(13.2).crystal, "the crystal fades in from 13.2");
  ok(at(14.6).crystal.reveal === 1 && at(14.6).crystal.opaque === 1 && at(14.6).crystal.alpha === 1, "solid at 14.6 (opaque, no soul)");
  ok(at(17.1).crystal.sweep === null && at(17.3).crystal.sweep && at(17.66).crystal.sweep === null && at(17.66).crystal.opaque === 0, "ONE quick flash 17.2-17.65, then the glass is clear");
  ok(at(17.3).crystal.sweep.lines.length === 1 && at(17.3).crystal.sweep.lines[0].w === 2.6, "one thick line");
  ok(at(19.4).hud < 0.01 && near(at(19.9).hud, 1), "HUD returns 19.4-19.9");
  ok(!at(20.5).done && at(20.6).done, "done at 20.6");
  ok(BEATS.first.black === 7.4 && BEATS.first.end === 20.6, "beats a rule waits on");
}
// ── the later fall ──
{
  const at = (T) => fallState("repeat", T);
  ok([0, 2, 4, 5.7].every((T) => at(T).party === 1 && at(T).hud === 1 && at(T).cam === 0), "later fall: party, HUD and camera untouched");
  ok(!at(1).smokeOver, "later fall: the party stays over the smoke");
  ok(at(3.24).smoke && at(3.25).arenaBlack, "black at 3.25");
  ok(at(4.29).crystal === null && at(4.3).crystal && at(4.3).crystal.scale === 1.14 && at(4.3).crystal.hitAge === 0, "the crystal pops in at 4.3 (1.14, white frame)");
  ok(at(4.3).crystal.debris === false, "no glass shards");
  ok(at(4.7).crystal.scale === 1 && at(4.3).screenFlash > 0 && at(4.7).screenFlash === 0, "settles to 1, the screen flash is short");
}
// ── sound: the user's picks (file, volume, beat), start = beat - peak ──
{
  const f = (kind, file) => FALL_SFX[kind].filter((c) => c.file === file);
  ok(f("first", "Soundboard/Magic3.ogg")[0]?.beat === 1.0 && f("first", "Soundboard/Magic3.ogg")[0]?.vol === 0.5, "first: Magic3 on the flash");
  ok(f("first", "Flash.mp3")[0]?.vol === 0.55 && near(cueStart(f("first", "Flash.mp3")[0]), 0.5), "first: Flash.mp3 .55 starts 0.5 s early");
  ok(f("first", "Soundboard/Blind.ogg").map((c) => c.beat).join() === "10.4,11.9,12.8", "first: a Blind per blip");
  ok(near(f("first", "Soundboard/Wind1.ogg")[0]?.beat, 17.35) && near(f("first", "Soundboard/Fire1.ogg")[0]?.beat, 17.7), "first: Wind1 17.35, Fire1 17.7");
  ok(f("repeat", "Soundboard/Magic2.ogg")[0]?.beat === 3.95 && f("repeat", "Soundboard/Ice2.ogg")[0]?.beat === 4.3, "later: Magic2 3.95, Ice2 4.3");
  ok(f("repeat", "Soundboard/Blind.ogg").length === 0, "later: no blip sound");
  const B = FALL_BED.first;
  ok(bedVolume(B, 2.79) === 0 && near(bedVolume(B, 3.6), 0.5) && near(bedVolume(B, 6.8), 0.25) && bedVolume(B, 7.4) === 0, "the engulf bed fades in 0.8 s, out over 1.2 s");
  ok(FALL_BED.repeat.from === 1.0 && FALL_BED.repeat.to === 3.25, "later bed 1.0-3.25");
}
// ── the soul's height = the mockup's heart ──
{
  const m = crystalMesh(LOOK.seed), soulY = (m.bot - m.top) / 2 + 0.1 * (m.top + m.bot);
  ok(near(18 + m.bot - soulY, SOUL_UP_FX, 1e-6), "SOUL_UP_FX from the mesh");
}
// ── the painters ──
{
  const w = 120, h = 110, data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4, d = Math.hypot(x - 60, (y - 55) * 1.2); if (d < 50) { const g = d < 14; data[i] = g ? 40 : 120; data[i + 1] = g ? 220 : 60; data[i + 2] = g ? 90 : 50; data[i + 3] = 255; } }
  const sp = makeFallPainter({ layer: "smoke", kind: "first", W: 400, H: 240, img: { width: w, height: h, data }, x0: 120, y0: 40, k: 1.4, mirror: true });
  let r = sp.draw({ T: 0.05 });
  ok(r.cRect && r.cRect[0] >= 119 && r.cRect[2] <= 120 + Math.ceil(w * 1.4), "smoke: his body (the white first frame) is drawn where he stands");
  r = sp.draw({ T: 6.5 });
  const c = new Uint32Array(r.color);
  ok(r.cRect && r.cRect[0] === 0 && r.cRect[2] === 399 && (c[0] >>> 24) === 255, "smoke: the engulf covers the whole frame");
  r = sp.draw({ T: 7.5 });
  ok(r.cRect === null, "smoke: nothing after the settle (the arena's black plate takes over)");
  const vp = makeFallPainter({ layer: "void", kind: "first", ...VOID_FRAME });
  ok(vp.draw({ T: 10.3 }).cRect === null && vp.draw({ T: 10.45 }).cRect, "void: nothing before the first blip, light at it");
  const rp = makeFallPainter({ layer: "void", kind: "repeat", ...VOID_FRAME });
  const rr = rp.draw({ T: 4.45 });
  ok(rr.cRect && rr.cRect[0] < VOID_FRAME.W / 2 - 100, "void: the blip's shock ring spreads");
}
// ── the crystal renderer's new params ──
{
  const W = 608, H = 548, cr = makeCrystal(W, H), mesh = crystalMesh(68);
  const draw = (st) => { const f = cr.draw(3, { cx: 304, floorY: 424, ...LOOK, ...st, mesh, stage: 0, stageT: -1e9, floorClip: false }); return { c: f.color.slice(), l: f.light.slice() }; };
  const base = draw({}), solid = draw({ opaque: 1 }), dark = draw({ reveal: 0 });
  let dSolid = 0, dDark = 0, lit0 = 0, litDark = 0;
  for (let i = 0; i < base.c.length; i++) { if (base.c[i] !== solid.c[i]) dSolid++; if (base.c[i] !== dark.c[i]) dDark++; if (base.l[i]) lit0++; if (dark.l[i]) litDark++; }
  ok(dSolid > 1000, "opaque 1 hides the inside");
  ok(dDark > 1000 && litDark < lit0, "reveal 0 = dark glass, less light");
  const sw = draw({ opaque: 1, sweep: { pos: 0.5, k: 1, before: 1, after: 0, lines: [{ o: 0, w: 2.6, k: 1 }] } });
  let dSw = 0; for (let i = 0; i < sw.c.length; i++) if (sw.c[i] !== solid.c[i]) dSw++;
  ok(dSw > 300, "the sweep paints across the facets");
  const hit = (debris) => { const f = cr.draw(3.2, { cx: 304, floorY: 424, ...LOOK, mesh, stage: 0, stageT: -1e9, hitT: 3.1, hitSide: 1, debris, floorClip: false }); return f.color.slice(); };
  const a = hit(true), b = hit(false); let dd = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) dd++;
  ok(dd > 0, "debris false drops the shards");
}
// ── the HUD curtain: ref-counted, lowest level wins, fades, releases ──
{
  let s = 0; const cu = makeCurtain({ clock: () => s });
  const a = cu.hide("a", { fade: 1 });
  ok(cu.level() === 1, "a fade starts at shown");
  s = 1; ok(cu.level() === 0, "hidden after its fade");
  const b = cu.hide("b", { level: 0.5 });
  ok(cu.level() === 0 && cu.size === 2, "two holds: the lowest wins");
  cu.show(a, { fade: 1 }); s = 2.1;
  ok(near(cu.level(), 0.5) && cu.size === 1, "a's hold is gone after its fade back; b still holds");
  cu.set(b, 0.2); ok(near(cu.level(), 0.2), "the owner drives its level");
  cu.show(b, { fade: 0 }); ok(cu.level() === 1 && cu.size === 0, "all given back: shown");
  cu.hide("c", { fade: 0, maxS: 5 }); s = 8; ok(cu.level() === 1 && cu.size === 0, "a forgotten hold expires");
  cu.hide("d", { fade: 0 }); cu.hide("e", { fade: 0 }); cu.releaseAll("d"); ok(cu.size === 1, "release by reason");
  cu.releaseAll(); ok(cu.size === 0, "release all");
}

console.log(`${pass} pass, ${fail} fail`);
if (fail) process.exitCode = 1;
