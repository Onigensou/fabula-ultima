// Tests for the plain helpers behind Play Animation's hold, Stop Animation,
// the letterbox and the Camera Pan two-shot. No game required.
// What this cannot check: a video freezing on its last frame, the bars sliding
// in, or the camera gliding on a client — those are sandbox checks.
// Run: node <this file>
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
let fail = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? "  " + detail : ""}`); if (!ok) fail++; };

const registered = [];
const clientKinds = new Map();
const runs = [];
globalThis.window = globalThis;
globalThis.Hooks = { on: () => 0, once: () => 0, off: () => 0 };
window.oni = { EventSystem: {
  Logic: { toNumber: (v, d) => (Number.isFinite(Number(v)) && String(v).trim() !== "" ? Number(v) : d) },
  EventRegistry: { register: (d) => registered.push(d) },
  Client: {
    register: (kind, fn) => clientKinds.set(kind, fn),
    run: (sourceId, kind, data) => runs.push({ sourceId, kind, data }),
    setMarker: () => {}, addCleanup: () => {}, removeCleanup: () => {}
  }
} };
const load = (name) => vm.runInThisContext(readFileSync(resolve(HERE, name), "utf8"), { filename: name });
load("event-rows-media.js");
load("event-rows-camera.js");
const M = window.oni.EventSystem.RowsMedia;
const C = window.oni.EventSystem.RowsCamera;
const def = (type) => registered.find(d => d.type === type);

// --- hold names -------------------------------------------------------------
check("hold name: the file name without folder or extension", M.holdKey("", "assets/fx/Smoke Puff.webm") === "smoke puff");
check("hold name: a query string is dropped", M.holdKey("", "fx/bolt.webm?v=3") === "bolt");
check("hold name: an encoded file name reads as written", M.holdKey("", "fx/Smoke%20Puff.webm") === "smoke puff");
check("hold name: the row's own name wins, without case", M.holdKey("  Portal Glow ", "fx/a.webm") === "portal glow");
check("hold name: 'smoke' and 'Smoke.webm' are the same hold", M.holdKey("smoke") === M.holdKey("Smoke.webm"));
check("hold name: blank = every hold", M.holdKey("") === "" && M.holdKey(null) === "");

// --- rows -------------------------------------------------------------------
const play = def("playAnimation");
check("Play Animation: hold is off by default, with no name", play.defaultData.hold === false && play.defaultData.holdName === "");
check("Play Animation: summary says it is held, and by what name",
  play.summary({ src: "fx/Seal.webm", hold: true, holdName: "" }) === 'Seal.webm · held as "seal"', play.summary({ src: "fx/Seal.webm", hold: true }));
check("Play Animation: summary unchanged without hold", play.summary({ src: "fx/Seal.webm" }) === "Seal.webm");

const stop = def("stopAnimation");
check("Stop Animation is registered under Screen, like Play Animation", !!stop && stop.category === play.category && stop.label === "Stop Animation");
check("Stop Animation defaults: every hold, 150 ms fade", stop.defaultData.name === "" && stop.defaultData.fadeMs === 150);
check("Stop Animation summary", stop.summary({ name: "" }) === "every held animation" && stop.summary({ name: "Seal.webm" }) === "seal");
check("Stop Animation runs on every client", clientKinds.has("screen.animation.stop"));

runs.length = 0;
await stop.execute({ name: "Portal.webm", fadeMs: 99999 }, { tileId: "t1" });
check("Stop Animation sends the hold name as a key and caps the fade",
  runs.length === 1 && runs[0].kind === "screen.animation.stop" && runs[0].data.key === "portal" && runs[0].data.fadeMs === 10000, JSON.stringify(runs[0]));

runs.length = 0;
window.oni.EventSystem.Flow = { wait: async () => {} };
await play.execute({ src: "fx/Seal.png", hold: true, holdName: "Big Seal", wait: true }, { tileId: "t1", tokenId: "p1" });
check("Play Animation sends hold and its key to the clients", runs[0]?.data?.hold === true && runs[0]?.data?.holdKey === "big seal", JSON.stringify(runs[0]?.data));

// Stop Animation on a client calls WorldFx with the key, for this event only.
const calls = [];
window.oni.EventSystem.WorldFx = { stopHeld: (...a) => calls.push(a) };
globalThis.FUCompanion = { api: { vfxSuppressed: () => false } };
clientKinds.get("screen.animation.stop")({ key: "seal", fadeMs: 150 }, { sourceId: "t1", presents: true });
check("Stop Animation hands the tokens' layer the same key and fade", JSON.stringify(calls) === JSON.stringify([["t1", "seal", 150]]));

// --- Screen Effect ----------------------------------------------------------
const fx = def("screenEffect");
runs.length = 0;
await fx.execute({ effect: "letterboxIn", seconds: 0.5, wait: false }, { tileId: "t1" });
check("Screen Effect knows letterbox in", runs[0]?.data?.effect === "letterboxIn" && runs[0]?.data?.durationMs === 500);
runs.length = 0;
await fx.execute({ effect: "letterboxOut", seconds: 0.4, wait: false }, { tileId: "t1" });
check("Screen Effect knows letterbox out", runs[0]?.data?.effect === "letterboxOut" && runs[0]?.data?.durationMs === 400);
check("Screen Effect summary", fx.summary({ effect: "letterboxIn" }) === "Letterbox bars in" && fx.summary({ effect: "letterboxOut" }) === "Letterbox bars out");

// --- two-shot ---------------------------------------------------------------
const close = (a, b) => Math.abs(a - b) < 1e-9;
let p = C.twoShotPoint({ x: 1000, top: 800, bottom: 1000 }, { x: 1400, top: 500, bottom: 900 });
check("two-shot: across, halfway between the centres", close(p.x, 1200), JSON.stringify(p));
check("two-shot: up and down, from the higher head to the lower feet", close(p.y, (500 + 1000) / 2), JSON.stringify(p));
p = C.twoShotPoint({ x: 1400, top: 500, bottom: 900 }, { x: 1000, top: 800, bottom: 1000 });
check("two-shot: the order of the two does not matter", close(p.x, 1200) && close(p.y, 750));
p = C.twoShotPoint({ x: 0, top: -200, bottom: 100 }, { x: 0, top: 0, bottom: 50 });
check("two-shot: one token above the other", close(p.x, 0) && close(p.y, -50));

const cam = def("cameraPan");
runs.length = 0;
await cam.execute({ mode: "twoShot", name: "Rakshasa", zoom: 2.2, seconds: 0.8, wait: false }, { tileId: "t1", tokenId: "party1" });
check("Camera Pan two-shot sends the name, the party token and the zoom",
  runs[0]?.data?.mode === "twoShot" && runs[0]?.data?.name === "Rakshasa" && runs[0]?.data?.partyTokenId === "party1" && runs[0]?.data?.zoom === 2.2, JSON.stringify(runs[0]?.data));
check("Camera Pan two-shot summary", cam.summary({ mode: "twoShot", name: "Rakshasa" }) === 'Two-shot: the party and "Rakshasa"');

console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
