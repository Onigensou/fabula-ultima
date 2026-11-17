// Tests for the picture actions (event-rows-picture.js): field clamping,
// easing and tint mapping, the picture state reducer, summaries and what the
// rows send. No game required.
// What this cannot check: the stacking under the screen fade, the dissolve,
// the shake follow and the reload sync on real clients — those are live checks.
// Run: node <this file>
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
let fail = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? "  " + detail : ""}`); if (!ok) fail++; };
const load = (name) => vm.runInThisContext(readFileSync(resolve(HERE, name), "utf8"), { filename: name });

// --- without the game: the plain helpers are still published -----------------
globalThis.window = globalThis;
{
  const realError = console.error;
  console.error = () => {};   // "Missing EventRegistry or Client" is expected here
  load("event-rows-picture.js");
  console.error = realError;
  check("PictureLogic is published without the game", !!window.oni?.EventSystem?.PictureLogic);
  check("Pictures API is not claimed without the game", !window.oni.EventSystem.Pictures);
}

// --- with mocked deps -------------------------------------------------------
const registered = [];
const clientKinds = new Map();
const runs = [];
const hooks = new Map();
globalThis.Hooks = {
  on: (name, fn) => { if (!hooks.has(name)) hooks.set(name, []); hooks.get(name).push(fn); return 0; },
  once: (name, fn) => Hooks.on(name, fn),
  off: () => 0,
  callAll: () => true
};
window.oni = { EventSystem: {
  Constants: { MODULE_ID: "fabula-ultima-companion" },
  Logic: { toNumber: (v, d) => (Number.isFinite(Number(v)) && String(v).trim() !== "" ? Number(v) : d) },
  EventRegistry: { register: (d) => registered.push(d) },
  Client: {
    register: (kind, fn) => clientKinds.set(kind, fn),
    run: (sourceId, kind, data) => runs.push({ sourceId, kind, data }),
    setMarker: () => {}, addCleanup: () => {}, removeCleanup: () => {}
  }
} };
load("event-rows-picture.js");
const P = window.oni.EventSystem.PictureLogic;
const def = (type) => registered.find(d => d.type === type);

// --- fields -----------------------------------------------------------------
check("slot: 1-20, rounded", P.normSlot(1) === 1 && P.normSlot("20") === 20 && P.normSlot(3.4) === 3);
check("slot: out of range or junk is null", P.normSlot(0) === null && P.normSlot(21) === null && P.normSlot("x") === null && P.normSlot("") === null);
check("slot: 'all' only where allowed", P.normSlot("all", true) === "all" && P.normSlot("ALL", true) === "all" && P.normSlot("all") === null);

check("file: images and webm are taken", ["a/b.webp", "x.PNG", "y.jpg", "z.jpeg", "v.webm", "q.webp?v=2"].every(s => P.normSrc(s) === s));
check("file: blank, folders and other files are refused", ["", "  ", "a/b", "s.ogg", "doc.txt", null].every(s => P.normSrc(s) === ""));
check("file: webm counts as video", P.isVideoSrc("fx/a.webm") && !P.isVideoSrc("a.webp"));
check("file name: folder dropped, decoded", P.fileName("CG/Asura%20Flashback_1.webp?v=1") === "Asura Flashback_1.webp");

{
  const s = P.normShow({});
  check("Show defaults", s.slot === 1 && s.fit === "cover" && s.x === 50 && s.y === 50 && s.scale === 100
    && s.opacity === 100 && s.rotation === 0 && s.blend === "normal" && s.fadeSeconds === 0
    && s.tint.preset === "normal" && !s.vignette && !s.grain && !s.keep && s.wait === true, JSON.stringify(s));
  const c = P.normShow({ slot: 99, fit: "stretch", x: 900, y: -900, scale: 0, opacity: 400, rotation: 99999, blend: "lighten", fadeSeconds: -3, tint: "sunset" });
  check("Show clamps every field", c.slot === 1 && c.fit === "cover" && c.x === 200 && c.y === -100 && c.scale === 1
    && c.opacity === 100 && c.rotation === 3600 && c.blend === "normal" && c.fadeSeconds === 0 && c.tint.preset === "normal", JSON.stringify(c));
  check("Show reads numbers given as text", P.normShow({ x: "25", opacity: "40" }).x === 25 && P.normShow({ opacity: "40" }).opacity === 40);
}

{
  const m = P.normMove({ slot: 2, x: "", y: 30, scale: null, opacity: "0", rotation: undefined, seconds: 2, easing: "easeOut" });
  check("Move: blank keeps, numbers clamp", m.x === null && m.y === 30 && m.scale === null && m.opacity === 0 && m.rotation === null, JSON.stringify(m));
  check("Move defaults", P.normMove({}).seconds === 1 && P.normMove({}).easing === "easeInOut" && P.normMove({}).wait === false);
  check("Move: bad easing falls back", P.normMove({ easing: "bounce" }).easing === "easeInOut");
  check("Move: duration capped", P.normMove({ seconds: 9999 }).seconds === 60);
}

check("Tint row: 'all' allowed", P.normTintRow({ slot: "all" }).slot === "all");
check("Erase row: default slot 1, 'all' allowed, fade clamped",
  P.normErase({}).slot === 1 && P.normErase({ slot: "all" }).slot === "all" && P.normErase({ fadeSeconds: 120 }).fadeSeconds === 60);

// --- easing and tint --------------------------------------------------------
check("easing names to CSS", P.easingCss("linear") === "linear" && P.easingCss("easeIn") === "ease-in"
  && P.easingCss("easeOut") === "ease-out" && P.easingCss("easeInOut") === "ease-in-out" && P.easingCss("??") === "ease-in-out");
check("blend names to CSS", P.blendCss("add") === "screen" && P.blendCss("multiply") === "multiply" && P.blendCss("x") === "normal");

check("tint: normal is no filter", P.tintFilter({ preset: "normal" }) === "none" && P.tintFilter("normal") === "none");
check("tint: Faded memory", P.tintFilter({ preset: "memory" }) === "sepia(0.45) grayscale(0.15) brightness(0.92) saturate(1) hue-rotate(0deg)", P.tintFilter({ preset: "memory" }));
check("tint: grey", P.tintFilter("gray") === "sepia(0) grayscale(0.85) brightness(0.9) saturate(1) hue-rotate(0deg)");
check("tint: dark", P.tintFilter("dark") === "sepia(0) grayscale(0) brightness(0.35) saturate(1) hue-rotate(0deg)");
check("tint: night has a colour turn", /hue-rotate\(185deg\)/.test(P.tintFilter("night")));
check("tint: custom, clamped", P.tintFilter({ preset: "custom", sepia: 2, grayscale: 0.5, brightness: 9, saturate: -1 })
  === "sepia(1) grayscale(0.5) brightness(3) saturate(0) hue-rotate(0deg)");
check("tint: custom at defaults is no filter", P.tintFilter({ preset: "custom" }) === "none");
check("tint labels", P.tintLabel({ preset: "memory" }) === "Faded memory" && P.tintLabel("normal") === "" && P.tintLabel({ preset: "custom" }) === "Custom tint");
check("tint: every preset is the same filter list (they glide into each other)",
  ["memory", "gray", "night", "dark"].every(t => P.tintFilter(t).match(/[a-z-]+\(/g).join() === "sepia(,grayscale(,brightness(,saturate(,hue-rotate("));

// --- reducer ----------------------------------------------------------------
const pic = (slot, src, extra = {}) => P.pictureFrom(P.normShow({ slot, src, ...extra }), extra.owner ?? "ev1", extra.rev ?? 1);
{
  let s = P.reduce(undefined, { type: "show", owner: "ev1", rev: 5, picture: pic(1, "cg/a.webp") });
  check("show: into an empty slot", s.pictures[1]?.src === "cg/a.webp" && s.pictures[1].owner === "ev1" && s.pictures[1].rev === 5);
  const before = s;
  s = P.reduce(s, { type: "show", owner: "ev1", rev: 6, picture: pic(1, "cg/b.webp", { x: 20, tint: "memory" }) });
  check("show into a held slot replaces it (the dissolve)", s.pictures[1].src === "cg/b.webp" && s.pictures[1].x === 20 && s.pictures[1].tint.preset === "memory");
  check("reducer does not change the old state", before.pictures[1].src === "cg/a.webp");
  check("show: a bad picture changes nothing", Object.keys(P.reduce(s, { type: "show", picture: { slot: 2, src: "x.txt" } }).pictures).length === 1);

  s = P.reduce(s, { type: "show", owner: "ev1", rev: 7, picture: pic(3, "cg/c.webm", { keep: true }) });
  check("show: video flagged", s.pictures[3].video === true && s.pictures[3].keep === true);

  const moved = P.reduce(s, { type: "move", slot: 1, x: 70, y: null, opacity: 0, rev: 8 });
  check("move: given fields change, blank ones stay", moved.pictures[1].x === 70 && moved.pictures[1].y === 50 && moved.pictures[1].opacity === 0 && moved.pictures[1].rev === 8);
  check("move: an empty slot is ignored", !P.reduce(s, { type: "move", slot: 9, x: 1 }).pictures[9]);
  check("visible count skips opacity 0", P.visibleCount(moved) === 1 && P.visibleCount(s) === 2);

  const tinted = P.reduce(s, { type: "tint", slot: "all", tint: { preset: "gray" }, vignette: true, grain: true, rev: 9 });
  check("tint all: every picture", Object.values(tinted.pictures).every(p => p.tint.preset === "gray" && p.vignette && p.grain));
  const one = P.reduce(s, { type: "tint", slot: 3, tint: { preset: "dark" } });
  check("tint one: only that slot", one.pictures[3].tint.preset === "dark" && one.pictures[1].tint.preset === "memory");

  check("erase one", !P.reduce(s, { type: "erase", slot: 1 }).pictures[1] && !!P.reduce(s, { type: "erase", slot: 1 }).pictures[3]);
  check("erase all", Object.keys(P.reduce(s, { type: "erase", slot: "all" }).pictures).length === 0);

  const other = P.reduce(s, { type: "show", owner: "ev2", rev: 10, picture: pic(5, "cg/d.webp", { owner: "ev2" }) });
  const ended = P.reduce(other, { type: "endEvent", owner: "ev1" });
  check("end of event: its pictures go, kept ones and other events' stay",
    !ended.pictures[1] && ended.pictures[3]?.keep === true && ended.pictures[5]?.owner === "ev2", JSON.stringify(Object.keys(ended.pictures)));
  check("clear: everything", Object.keys(P.reduce(other, { type: "clear" }).pictures).length === 0);

  const synced = P.reduce({ pictures: { 1: { ...s.pictures[1], rev: 100 } } }, { type: "sync", pictures: { 1: { ...s.pictures[1], src: "cg/old.webp", rev: 50 }, 4: pic(4, "cg/e.webp") } });
  check("sync: merged slot by slot, the newer wins", synced.pictures[1].rev === 100 && synced.pictures[1].src === "cg/b.webp" && synced.pictures[4]?.src === "cg/e.webp");
  check("sync: junk from the wire is dropped", Object.keys(P.reduce(undefined, { type: "sync", pictures: { 1: { slot: 1, src: "evil.js" }, 2: { slot: 77, src: "a.png" } } }).pictures).length === 0);
  check("sync keeps tint from the wire", P.reduce(undefined, { type: "sync", pictures: { 2: s.pictures[1] } }).pictures[1].tint.preset === "memory");
}

// --- rows -------------------------------------------------------------------
const show = def("showPicture"), move = def("movePicture"), tint = def("tintPicture"), erase = def("erasePicture");
check("four rows, under Screen", [show, move, tint, erase].every(d => d && d.category === "Screen"));
check("labels", show.label === "Show Picture" && move.label === "Move Picture" && tint.label === "Tint Picture" && erase.label === "Erase Picture");
check("row defaults are what normalizing gives",
  JSON.stringify(P.normShow(show.defaultData)) === JSON.stringify(P.normShow({})) && show.defaultData.keep === false && show.defaultData.wait === true);
check("Show summary", show.summary({ slot: 1, src: "CG/Asura_Flashback_1.webp", fit: "cover", tint: "memory" }) === "#1 Asura_Flashback_1.webp · fill · Faded memory",
  show.summary({ slot: 1, src: "CG/Asura_Flashback_1.webp", fit: "cover", tint: "memory" }));
check("Show summary: extras", show.summary({ slot: 2, src: "a.png", fit: "native", vignette: true, grain: true, fadeSeconds: 1.5, keep: true }) === "#2 a.png · own size · dark edges · grain · fade 1.5 s · kept");
check("Move summary", move.summary({ slot: 1, x: 40, opacity: "", seconds: 2, easing: "easeOut" }) === "#1 · x 40% · 2 s ease out", move.summary({ slot: 1, x: 40, seconds: 2, easing: "easeOut" }));
check("Tint summary", tint.summary({ slot: "all", tint: "memory", vignette: true, seconds: 1 }) === "all · Faded memory · dark edges · 1 s");
check("Erase summary", erase.summary({ slot: "all" }) === "all pictures" && erase.summary({ slot: 3, fadeSeconds: 1 }) === "#3 · fade 1 s");
check("mediaOf: the picture, for preloading", JSON.stringify(show.mediaOf({ src: "cg/a.webp" })) === '["cg/a.webp"]' && show.mediaOf({ src: "" }).length === 0);
check("picture changes run on every client", clientKinds.has("screen.picture"));

// Execute: a bad / empty file is skipped with one warning.
const warns = [];
globalThis.ui = { notifications: { warn: (m) => warns.push(m) } };
const realWarn = console.warn;
console.warn = () => {};
runs.length = 0;
let r = await show.execute({ slot: 1, src: "" }, { tileId: "t1" });
await show.execute({ slot: 1, src: "" }, { tileId: "t1" });
check("Show with no file: skipped, warned once", r.ok === false && runs.length === 0 && warns.length === 1, JSON.stringify(warns));
r = await show.execute({ slot: 1, src: "notes.txt" }, { tileId: "t1" });
check("Show with a non-image file: skipped", r.ok === false && r.reason === "badPictureFile" && runs.length === 0);
console.warn = realWarn;

runs.length = 0;
await move.execute({ slot: 2, x: 500, y: "", seconds: 0, easing: "easeIn" }, { tileId: "t1" });
check("Move sends clamped values and keeps blanks", runs[0]?.kind === "screen.picture" && runs[0].data.action.x === 200
  && runs[0].data.action.y === null && runs[0].data.easing === "easeIn", JSON.stringify(runs[0]));
runs.length = 0;
await erase.execute({ slot: "all", fadeSeconds: 0 }, { tileId: "t1" });
check("Erase all sends 'all'", runs[0]?.data.action.type === "erase" && runs[0].data.action.slot === "all");
runs.length = 0;
await tint.execute({ slot: 4, tint: "custom", sepia: 5, seconds: 0 }, { tileId: "t1" });
check("Tint sends the clamped grade", runs[0]?.data.action.tint.preset === "custom" && runs[0].data.action.tint.sepia === 1);

console.log(fail ? `\n${fail} FAILED` : "\nAll passed");
process.exit(fail ? 1 : 0);
