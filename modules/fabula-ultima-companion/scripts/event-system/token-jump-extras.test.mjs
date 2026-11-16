// Tests for Set Token's fades, Set Facing's "toward" and Jump To's styles, dust
// and party-relative points: the plain helpers, and what the GM side sends and
// writes. No game required.
// What this cannot check: anything drawn (the sprite copies, the dust clips, the
// tint blend on a mesh) or a socket between two clients — those are sandbox checks.
// Run: node <this file>
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
let fail = 0;
let pass = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (ok) pass++; else fail++;
};

// ---------------------------------------------------------------------------
// Stand-ins
// ---------------------------------------------------------------------------
const registered = new Map();
const runs = [];
globalThis.window = globalThis;
console.debug = () => {};
globalThis.Hooks = { on: () => 0, once: () => 0, off: () => 0 };
globalThis.ui = { notifications: { warn: () => {}, error: () => {}, info: () => {} } };
window.oni = { EventSystem: {
  Logic: { toNumber: (v, d) => (Number.isFinite(Number(v)) && String(v).trim() !== "" ? Number(v) : d) },
  EventRegistry: { register: (d) => registered.set(d.type, d) },
  Client: { register: () => {}, run: (sourceId, kind, data) => runs.push({ kind, data }), addCleanup: () => {} },
  Flow: { wait: async () => true }
} };
const NAMED = {
  up: { dir: "up", side: null }, down: { dir: "down", side: null },
  left: { dir: "left", side: "left" }, right: { dir: "left", side: "right" },
  upLeft: { dir: "upLeft", side: "left" }, upRight: { dir: "upLeft", side: "right" },
  downLeft: { dir: "downLeft", side: "left" }, downRight: { dir: "downLeft", side: "right" }
};
globalThis.__ONI_SPRITE_FACING_RUNTIME__ = { NAMED_DIRECTIONS: NAMED };

for (const file of ["event-rows-token.js", "event-rows-jump.js"]) {
  vm.runInThisContext(readFileSync(resolve(HERE, file), "utf8"), { filename: file });
}
const RT = window.oni.EventSystem.RowsToken;
const Jump = window.oni.EventSystem.Jump;

// A 100 px grid scene: the party, Rakshasa and a marker. The scene's own area
// runs from (200, 200) to (1200, 900).
const updates = [];
function makeScene() {
  const scene = {
    id: "s1",
    grid: { size: 100 },
    dimensions: { sceneRect: { x: 200, y: 200, width: 1000, height: 700 } },
    tokens: null,
    async updateEmbeddedDocuments(kind, changes, options) {
      updates.push({ changes, options });
      for (const c of changes) {
        const doc = this.tokens.get(c._id);
        for (const [k, v] of Object.entries(c)) if (k !== "_id") doc[k] = v;
      }
    }
  };
  const doc = (id, name, x, y, hidden = false) => ({ id, name, x, y, width: 1, height: 1, hidden, actor: null, parent: scene });
  const docs = [doc("party", "Party", 1000, 400), doc("rak", "Rakshasa", 500, 600, true), doc("mark", "Land", 700, 300, true)];
  scene.tokens = { contents: docs, get: (id) => docs.find(d => d.id === id) ?? null };
  return scene;
}
let scene = makeScene();
globalThis.game = { scenes: { get: (id) => (id === scene.id ? scene : null) } };
const ctx = () => ({ sceneId: scene.id, tokenId: "party", tileId: "tile1" });
const reset = () => { scene = makeScene(); updates.length = 0; runs.length = 0; };

// ---------------------------------------------------------------------------
// Path points
// ---------------------------------------------------------------------------
check("party line: signed numbers", JSON.stringify(Jump.parsePartyOffset("party:+86,0")) === JSON.stringify({ dx: 86, dy: 0 }));
check("party line: spaces, case, negatives and decimals", JSON.stringify(Jump.parsePartyOffset("  Party : -135 , +25.5 ")) === JSON.stringify({ dx: -135, dy: 25.5 }));
check("party line: a marker name or a point is not one", Jump.parsePartyOffset("Party Spot") === null && Jump.parsePartyOffset("845, 562") === null);
check("party line: half a pair is not one", Jump.parsePartyOffset("party:86") === null);

const party = scene.tokens.get("party");   // centre (1050, 450)
const p1 = Jump.resolvePoint(scene, "party:+86,0", party);
check("party line: from the party's centre", p1?.x === 1136 && p1?.y === 450, JSON.stringify(p1));
const p2 = Jump.resolvePoint(scene, "party:-135,+25", party);
check("party line: Rakshasa's landing beside them", p2?.x === 915 && p2?.y === 475);
const p3 = Jump.resolvePoint(scene, "party:+400,-400", party);
check("party line: kept inside the scene's area", p3?.x === 1200 && p3?.y === 200, JSON.stringify(p3));
check("party line: no party token -> null (reported as missing)", Jump.resolvePoint(scene, "party:+86,0", null) === null);
check("plain points and markers still work", Jump.resolvePoint(scene, "845, 562")?.x === 845 && Jump.resolvePoint(scene, "land")?.x === 750);
check("a plain point is not clamped", Jump.resolvePoint(scene, "5000, 10")?.x === 5000);
check("clamp: a scene with no dimensions leaves the point", JSON.stringify(Jump.clampToScene({}, -5, 9)) === JSON.stringify({ x: -5, y: 9 }));

// ---------------------------------------------------------------------------
// Dust
// ---------------------------------------------------------------------------
check("dust size: a 260 px Asura takes off at 150", RT.dustSize(260, false) === 150);
check("dust size: and lands at 175", RT.dustSize(260, true) === 175);
check("dust size: a small party is held at 80", RT.dustSize(96, false) === 80 && RT.dustSize(96, true) === 80);
check("dust size: no height still makes dust", RT.dustSize(0, true) === 80 && RT.dustSize(undefined, false) === 80);
const launch = RT.dustPuffs(100, 200, 100, false);
const land = RT.dustPuffs(100, 200, 100, true);
check("dust: take-off is a ground spike and two side puffs", launch.length === 3
  && launch.filter(p => /dashsmoke_anim05/.test(p.src)).length === 1 && launch.filter(p => /smoke_anim14/.test(p.src)).length === 2);
check("dust: landing adds two low spikes", land.length === 5 && land.filter(p => /dashsmoke_anim05/.test(p.src)).length === 3);
const puffs = launch.filter(p => /smoke_anim14/.test(p.src));
check("dust: the left puff is mirrored, the right is not, both 42% out",
  puffs.some(p => p.x === 58 && p.mirror === true) && puffs.some(p => p.x === 142 && p.mirror === false));
check("dust: widths follow the size", launch[0].width === 125 && puffs[0].width === 95);

// ---------------------------------------------------------------------------
// Toward
// ---------------------------------------------------------------------------
const way = (dx, dy) => RT.towardFacing(dx, dy);
check("toward: right", way(100, 0).direction === "right" && way(100, 0).side === null);
check("toward: left", way(-100, 0).direction === "left");
check("toward: up-left and down-right", way(-100, -100).direction === "upLeft" && way(100, 100).direction === "downRight");
check("toward: straight down keeps its side", way(10, 100).direction === "down" && way(10, 100).side === null);
check("toward: down but well to the right mirrors right", way(30, 100).direction === "down" && way(30, 100).side === "right");
check("toward: up and to the left mirrors left", way(-30, -100).direction === "up" && way(-30, -100).side === "left");
check("toward: on top of it -> null", way(0, 0) === null);

check("tint: halfway from a silhouette to none", RT.mixColor(0x07060c, 0xffffff, 0.5) === 0x838386, RT.mixColor(0x07060c, 0xffffff, 0.5).toString(16));
check("tint: ends exact and clamps", RT.mixColor(0x07060c, 0xffffff, 1) === 0xffffff && RT.mixColor(0x07060c, 0xffffff, -1) === 0x07060c);

// ---------------------------------------------------------------------------
// Set Facing toward
// ---------------------------------------------------------------------------
{
  reset();
  const facing = registered.get("setFacing");
  // Rakshasa centre (550, 650), party (1050, 450): to its right, a little up.
  let r = await facing.execute({ target: "token", name: "Rakshasa", direction: "towardParty" }, ctx());
  const turn = runs.find(x => x.kind === "token.facing")?.data?.turns?.[0];
  check("facing: a named token turns toward the party", r.ok && turn?.tokenId === "rak" && turn.direction === "right", JSON.stringify(turn));
  const flags = updates[0]?.changes?.[0] ?? {};
  check("facing: it is saved (drawn direction and mirror side)",
    flags["flags.fabula-ultima-companion.facingDir"] === "left" && flags["flags.fabula-ultima-companion.facing"] === "right");

  reset();
  r = await facing.execute({ target: "party", name: "Rakshasa", direction: "towardToken" }, ctx());
  const t2 = runs.find(x => x.kind === "token.facing")?.data?.turns?.[0];
  check("facing: the party turns toward a named token", r.ok && t2?.tokenId === "party" && t2.direction === "left", JSON.stringify(t2));

  reset();
  r = await facing.execute({ target: "party", name: "Nobody", direction: "towardToken" }, ctx());
  check("facing: toward a missing token passes over", r.ok === false && !runs.length);
  r = await facing.execute({ target: "party", direction: "towardParty" }, ctx());
  check("facing: the party toward itself passes over", r.ok === false);
  r = await facing.execute({ target: "party", direction: "left" }, ctx());
  check("facing: a fixed direction still works", r.ok && runs.at(-1)?.data?.turns?.[0]?.direction === "left");
  check("facing: summaries", facing.summary({ target: "token", name: "Rakshasa", direction: "towardParty" }) === "Rakshasa: toward the party"
    && facing.summary({ target: "party", name: "Rakshasa", direction: "towardToken" }) === "the party: toward Rakshasa");
}

// ---------------------------------------------------------------------------
// Set Token fades
// ---------------------------------------------------------------------------
{
  const setToken = registered.get("setToken");
  reset();
  let r = await setToken.execute({ name: "Rakshasa", visibility: "show", fadeMs: 260, risePx: 40, crouch: true, tint: "keep" }, ctx());
  const show = runs.find(x => x.kind === "token.show")?.data;
  check("show fade: every client is sent the fade for the hidden token", show?.tokenIds?.join() === "rak" && show.fadeMs === 260 && show.risePx === 40 && show.crouch === true);
  check("show fade: then the token is shown, once", r.ok && updates.length === 1 && updates[0].changes[0].hidden === false);

  reset();
  r = await setToken.execute({ name: "Rakshasa", visibility: "show", tint: "keep" }, ctx());
  check("show: no fade is as before (no client effect)", r.ok && !runs.length && updates[0].changes[0].hidden === false);

  reset();
  r = await setToken.execute({ name: "Rakshasa", visibility: "keep", tint: "clear", tintFadeMs: 1200 }, ctx());
  const tint = runs.find(x => x.kind === "token.tint")?.data;
  check("tint fade: clients blend to white over the time", tint?.to === 0xffffff && tint.ms === 1200 && tint.tokenIds.join() === "rak");
  check("tint fade: the tint is written at the end", updates.length === 1 && updates[0].changes[0]["texture.tint"] === "#ffffff");

  reset();
  await setToken.execute({ name: "Rakshasa", visibility: "show", tint: "set", color: "#07060c", tintFadeMs: 500 }, ctx());
  check("show + tint fade: shown first, tint after", updates.length === 2 && updates[0].changes[0].hidden === false && updates[1].changes[0]["texture.tint"] === "#07060c");

  reset();
  await setToken.execute({ name: "Rakshasa", visibility: "hide", tint: "clear", tintFadeMs: 500 }, ctx());
  check("hide + tint fade: hidden at the end, with the tint", updates.length === 1 && updates[0].changes[0].hidden === true && updates[0].changes[0]["texture.tint"] === "#ffffff");

  check("set token: summary names the fades",
    setToken.summary({ name: "Asura", visibility: "show", fadeMs: 260, risePx: 40, crouch: true, tint: "clear", tintFadeMs: 1200 })
      === "Asura, show, fade in 260 ms rising 40 px into a crouch, no tint, tint fade 1200 ms");
}

// ---------------------------------------------------------------------------
// Jump To styles
// ---------------------------------------------------------------------------
{
  const jumpTo = registered.get("jumpTo");
  reset();
  // The party dodges sideways from where it stands.
  let r = await jumpTo.execute({ target: "party", path: "party:+86,0", hopMs: 380, pauseMs: 0, dust: "both" }, ctx());
  const hop = runs.find(x => x.kind === "jump.hop")?.data;
  const p = scene.tokens.get("party");
  check("dodge: the party hops to party:+86,0", r.ok && p.x === 1086 && p.y === 400, `${p.x},${p.y}`);
  check("dodge: the hop carries the dust and faces its way", hop?.dust === "both" && hop.face === true && hop.to.x === 1136);

  reset();
  r = await jumpTo.execute({ target: "token", name: "Rakshasa", path: "party:-135,+25", style: "dropIn", dust: "landing" }, ctx());
  const rak = scene.tokens.get("rak");
  const drop = runs.find(x => x.kind === "jump.dropIn")?.data;
  check("drop in: put on the point while hidden, then shown", r.ok && updates.length === 2
    && updates[0].changes[0].hidden === true && updates[0].changes[0].x === 865 && updates[0].changes[0].y === 425
    && updates[1].changes[0].hidden === false && rak.hidden === false, JSON.stringify(updates.map(u => u.changes[0])));
  check("drop in: no camera pan or slide", updates[0].options?.animate === false && updates[0].options?.pan === false);
  check("drop in: every client is sent the fall", drop?.to?.x === 915 && drop.to.y === 475 && drop.dust === "landing");

  reset();
  r = await jumpTo.execute({ target: "token", name: "Rakshasa", path: "", style: "dropIn" }, ctx());
  check("drop in: no point is skipped", r.ok === false && r.reason === "noPoint" && !updates.length);

  reset();
  scene.tokens.get("rak").hidden = false;
  r = await jumpTo.execute({ target: "token", name: "Rakshasa", style: "leapOut", dust: "takeoff" }, ctx());
  const leap = runs.find(x => x.kind === "jump.leapOut")?.data;
  const rak2 = scene.tokens.get("rak");
  check("leap out: clients leap, then the token is hidden where it stood", r.ok && leap?.tokenId === "rak" && leap.dust === "takeoff"
    && rak2.hidden === true && rak2.x === 500 && rak2.y === 600);

  check("jump to: summaries", jumpTo.summary({ target: "token", name: "Asura", style: "leapOut" }) === "Asura leaps out of view"
    && jumpTo.summary({ target: "token", name: "Asura", style: "dropIn", path: "Land", dust: "landing" }) === "Asura drops in at Land, dust at landing"
    && jumpTo.summary({ target: "party", path: "Stone 01\nStone 02" }) === "the party → Stone 01 → Stone 02");

  const media = jumpTo.mediaOf({ style: "dropIn", dust: "both", takeoffSrc: "a.wav", landSrc: "b.wav", path: "x\ny" });
  check("jump to: a drop in warms up only the landing dust and sound", media.length === 6 && media[0] === "b.wav");
  const hopMedia = jumpTo.mediaOf({ style: "hop", dust: "takeoff", takeoffSrc: "a.wav", landSrc: "", path: "x\ny" });
  check("jump to: a hop warms up take-off dust once per hop", hopMedia.length === 7);
  check("jump to: defaults are hop and no dust", jumpTo.defaultData.style === "hop" && jumpTo.defaultData.dust === "none");
}

console.log(`\n${pass} passed, ${fail} failed`);
console.log(fail ? `${fail} FAILED` : "all passed");
process.exitCode = fail ? 1 : 0;
