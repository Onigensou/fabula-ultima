// node scripts/dungeon-pathing-system/dp-fog.test.mjs
// Fog / shroud discs (dp-fog.js) under fast moves — to-do #10, 2026-11-24.
// Loads the real dp-fog.js into a sandbox with PIXI / canvas stubs and replays
// the party's adjacency over a fake clock.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const SRC = fs.readFileSync(fileURLToPath(new URL("./dp-fog.js", import.meta.url)), "utf8");

function makeWorld({ fogMode = "fog" } = {}) {
  let now = 0;
  const raf = [];
  const hooks = {};
  const marked = [];
  class Container {
    constructor() { this.children = []; this.alpha = 1; this.destroyed = false; this.parent = null; }
    addChild(...c) { for (const x of c) { x.parent = this; this.children.push(x); } return c[0]; }
    removeChild(c) { this.children = this.children.filter(x => x !== c); c.parent = null; }
    destroy() { this.destroyed = true; }
  }
  const ids = ["A", "B", "F"];                       // chain A - B - F; F is the Unknown tile
  const meshes = Object.fromEntries(ids.map(id => [id, { alpha: 1, destroyed: false }]));
  const docs = new Map(ids.map(id => [id, {
    id, getFlag: (_m, k) => (id === "F" && k.endsWith("fogMode")) ? fogMode : undefined,
  }]));
  const ctx = {
    console: { ...console, debug() {} }, Promise, Set, Map, Math,
    performance: { now: () => now },
    requestAnimationFrame: f => raf.push(f),
    PIXI: { Container, Sprite: class extends Container {}, Texture: { EMPTY: {} } },
    Hooks: { once() {}, on(name, fn) { (hooks[name] ??= []).push(fn); } },
    loadTexture: () => Promise.resolve({}), getTexture: () => null,
    game: { user: { isGM: false } },
    canvas: {
      stage: new Container(),
      scene: { id: "S", flags: {}, tiles: docs },
      tiles: { get: id => ({ id, mesh: meshes[id] }) },
    },
  };
  ctx.globalThis = ctx;
  ctx.DungeonPathing = {
    MODULE_ID: "m", PATHING_ROOT_KEY: "dungeonPathing",
    Look: { unknownDisc: () => new Container() },
    LinkLayer: { redraw() {} },
    Socket: { markFogRevealed: (_s, id) => { marked.push(id); return Promise.resolve(); } },
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const Fog = ctx.DungeonPathing.Fog;
  const node = id => ({ nodeId: id, bounds: { left: 0, top: 0, right: 41, bottom: 41 } });
  const graph = { nodes: ids.map(node), edges: [] };
  const nbrs = { A: ["B"], B: ["A", "F"], F: ["B"] };
  return {
    Fog, meshes, hooks, marked,
    at: id => Fog.refresh(graph, node(id), nbrs[id].map(node)),
    advance(ms) { const end = now + ms; while (now < end) { now += 16; raf.splice(0).forEach(f => f()); } },
  };
}

let n = 0;
const t = (name, fn) => { fn(); n++; console.log("  ok", name); };

for (const gap of [50, 300, 550]) {
  t(`fog comes back when the party leaves ${gap} ms into the lift`, () => {
    const w = makeWorld();
    w.at("A"); w.advance(100);
    w.at("B"); w.advance(gap);
    w.at("A"); w.advance(2000);
    assert.equal(w.Fog.isConcealed("F"), true);
    assert.equal(w.meshes.F.alpha, 0);
  });
}

t("a finished lift reveals the tile; leaving later brings the fog back", () => {
  const w = makeWorld();
  w.at("A"); w.advance(100);
  w.at("B"); w.advance(1000);
  assert.equal(w.Fog.isConcealed("F"), false);
  assert.equal(w.meshes.F.alpha, 1);
  w.at("A"); w.advance(1000);
  assert.equal(w.Fog.isConcealed("F"), true);
  assert.equal(w.meshes.F.alpha, 0);
});

t("coming back while the fog is still returning lifts it again", () => {
  const w = makeWorld();
  w.at("A"); w.advance(100);
  w.at("B"); w.advance(1000);
  w.at("A"); w.advance(200);              // re-fog fade (500 ms) in flight
  w.at("B"); w.advance(2000);
  assert.equal(w.Fog.isConcealed("F"), false);
  assert.equal(w.meshes.F.alpha, 1);
});

t("a shroud that started to part stays revealed, marked once", () => {
  const w = makeWorld({ fogMode: "shroud" });
  w.at("A"); w.advance(100);
  w.at("B"); w.advance(200);
  w.at("A"); w.advance(2000);
  assert.equal(w.Fog.isConcealed("F"), false);
  assert.deepEqual([...w.marked], ["F"]);
});

t("a tile refresh that resets mesh.alpha is put back under the disc", () => {
  const w = makeWorld();
  w.at("A"); w.advance(100);
  w.meshes.F.alpha = 1;                    // Foundry Tile#_refreshState
  for (const fn of w.hooks.refreshTile ?? []) fn({ id: "F", mesh: w.meshes.F });
  assert.equal(w.meshes.F.alpha, 0);
  w.meshes.F.alpha = 1;                    // and the next rebuild re-asserts it too
  w.at("A");
  assert.equal(w.meshes.F.alpha, 0);
});

console.log(`dp-fog: ${n} passed`);
