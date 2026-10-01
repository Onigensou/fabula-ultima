// ============================================================================
// Skill Forge — the canvas's geometry and link rules.
//
//     node scripts/skill-forge/graph-canvas.test.mjs
//
// The canvas itself is DOM and needs a running game. What it DECIDES —
// where a card goes, which reference a drawn link becomes, what survives a
// reload — is here, and is what can silently go wrong.
// ============================================================================

const gc = await import("./graph-canvas.js");
const gm = await import("./graph-model.js");

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${label}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

const props = {
  on_activate_effect_ref: "root",
  effect_table: {
    0: { effect_kind: "targeting", effect_label: "tgt", candidate_source: "combat" },
    1: { effect_kind: "deal_damage", effect_label: "hit", target_ref: "tgt" },
    2: { effect_kind: "chain", effect_label: "root", chain_steps: "hit, heal" },
    3: { effect_kind: "heal", effect_label: "heal", target_ref: "self" },
    4: { effect_kind: "deal_damage", effect_label: "orphan", target_ref: "self" },
    5: { effect_kind: "deal_damage", target_ref: "self" },
  },
  reaction_config_table: { 0: { reaction_trigger: "on_hit", reaction_effect_ref: "heal" } },
};
const g = gm.toGraph(props);
const id = (l) => g.nodes.find((n) => n.label === l).id;

// ── layout ──────────────────────────────────────────────────────────────────
console.log("\n— auto layout —");
{
  const pos = gc.autoLayout(g, gm.assignDepths(g));
  eq("every step AND the document card is placed",
    Object.keys(pos).length, g.nodes.length + 1);
  eq("the document card is the leftmost column", pos[gc.DOC_NODE].x, 0);
  eq("a fire point's target sits one column right of the document",
    pos[id("root")].x, gc.CARD_W + gc.COL_GAP);
  eq("what it runs sits further right", pos[id("hit")].x > pos[id("root")].x, true);
  eq("a targeting step reached THROUGH damage sits right of the damage",
    pos[id("tgt")].x > pos[id("hit")].x, true);
  const orphanX = pos[id("orphan")].x;
  eq("an unreached step gets the far-right column, apart from the live ones",
    Object.values(pos).every((p) => p.x <= orphanX) && orphanX > pos[id("tgt")].x, true);

  // No two cards in one column overlap, with real measured heights.
  const sizes = Object.fromEntries(Object.keys(pos).map((k, i) => [k, { w: gc.CARD_W, h: 60 + i * 15 }]));
  const p2 = gc.autoLayout(g, gm.assignDepths(g), sizes);
  const cols = {};
  for (const [k, p] of Object.entries(p2)) (cols[p.x] ??= []).push({ y: p.y, h: sizes[k].h });
  const overlap = Object.values(cols).some((list) => list.sort((a, b) => a.y - b.y)
    .some((c, i) => i && list[i - 1].y + list[i - 1].h > c.y));
  eq("measured heights never overlap within a column", overlap, false);

  // Columns are centred on the tallest one, not hung off the top.
  const mid = (list) => (Math.min(...list.map((c) => c.y)) + Math.max(...list.map((c) => c.y + c.h))) / 2;
  const mids = Object.values(cols).map(mid);
  eq("every column shares one vertical midline",
    mids.every((m) => Math.abs(m - mids[0]) < 0.01), true);

  // A wide fan-out still fits: 150 steps as a binary tree.
  const rows = {};
  for (let i = 0; i < 150; i++) {
    const kids = [2 * i + 1, 2 * i + 2].filter((c) => c < 150).map((c) => `s${c}`);
    rows[i] = kids.length ? { effect_kind: "chain", effect_label: `s${i}`, chain_steps: kids.join(", ") }
      : { effect_kind: "deal_damage", effect_label: `s${i}`, target_ref: "self" };
  }
  const big = gm.toGraph({ on_activate_effect_ref: "s0", effect_table: rows });
  const bp = gc.autoLayout(big, gm.assignDepths(big));
  const boxes = Object.values(bp).map((p) => ({ ...p, w: gc.CARD_W, h: gc.EST_H }));
  const f = gc.fitView(boxes, 950, 560, 20);
  const inside = boxes.every((b) => b.x * f.k + f.x >= 19 && b.y * f.k + f.y >= 19 &&
    (b.x + b.w) * f.k + f.x <= 931 && (b.y + b.h) * f.k + f.y <= 541);
  eq("Fit shows a 150-step fan-out whole in a 950x560 canvas", inside, true);

  const saved = { [id("hit")]: { x: 999, y: -5 }, bogus: { x: "x", y: 1 } };
  const res = gc.resolveLayout(p2, saved);
  eq("a saved position wins", res[id("hit")], { x: 999, y: -5 });
  eq("an unsaved card keeps the auto position", res[id("root")], p2[id("root")]);
  eq("a saved id that no longer exists is not invented", "bogus" in res, false);
}

// ── view math ───────────────────────────────────────────────────────────────
console.log("\n— zoom / pan —");
{
  const v = { x: 30, y: -20, k: 1 };
  const before = gc.screenToWorld(v, 200, 150);
  const z = gc.zoomAt(v, 1.7, 200, 150);
  const after = gc.screenToWorld(z, 200, 150);
  eq("zooming keeps the point under the cursor fixed",
    near(before.x, after.x) && near(before.y, after.y), true);
  eq("zoom is clamped at the minimum", gc.zoomAt(v, 1e-6, 0, 0).k, gc.ZOOM_MIN);
  eq("zoom is clamped at the maximum", gc.zoomAt(v, 1e6, 0, 0).k, gc.ZOOM_MAX);

  const boxes = [{ x: 0, y: 0, w: 100, h: 50 }, { x: 900, y: 400, w: 100, h: 50 }];
  const f = gc.fitView(boxes, 500, 300, 20);
  const tl = { x: 0 * f.k + f.x, y: 0 * f.k + f.y };
  const br = { x: 1000 * f.k + f.x, y: 450 * f.k + f.y };
  eq("fit puts every box inside the canvas",
    tl.x >= 19.99 && tl.y >= 19.99 && br.x <= 480.01 && br.y <= 280.01, true);
  eq("fit never blows a small skill up past 100%",
    gc.fitView([{ x: 0, y: 0, w: 50, h: 50 }], 800, 600).k, 1);
  eq("fit of nothing is a sane default", gc.fitView([], 800, 600).k, 1);
}

// ── edges ───────────────────────────────────────────────────────────────────
console.log("\n— edge geometry —");
{
  const a = { x: 0, y: 0, w: 200, h: 80 }, b = { x: 400, y: 200, w: 200, h: 80 };
  const e = gc.edgeGeometry(a, b);
  eq("an arrow leaves the source's right edge", [e.sx, e.sy], [200, 40]);
  eq("…and enters the target's left edge", [e.tx, e.ty], [400, 240]);
  eq("the label sits at the curve's midpoint", [e.mx, e.my], [300, 140]);
  eq("the path is a single cubic", /^M [\d.-]+ [\d.-]+ C /.test(e.d), true);
  const back = gc.edgeGeometry(b, a);
  const handle = Number(back.d.split(" ")[4].replace(",", "")) - back.sx;
  eq("a BACKWARDS link loops out instead of cutting through the cards", handle >= 90, true);
  const s0 = gc.edgeGeometry(a, b, { slot: 0, slots: 3 }).sy;
  const s2 = gc.edgeGeometry(a, b, { slot: 2, slots: 3 }).sy;
  eq("several links from one card fan out", s0 < s2, true);
  eq("…but stay on the card", s0 >= a.y && s2 <= a.y + a.h, true);
}

// ── link rules ──────────────────────────────────────────────────────────────
console.log("\n— which reference a drawn link may become —");
{
  const fields = (from, to) => gc.linkFieldsFor(g, from, to).options.map((o) => o.field);

  eq("chain → effect offers chain_steps (declared for chain)",
    fields(id("root"), id("orphan")).includes("chain_steps"), true);
  eq("…but NOT a target field — orphan is not a targeting step",
    fields(id("root"), id("orphan")).includes("target_ref"), false);
  eq("damage → targeting offers target_ref", fields(id("orphan"), id("tgt")).includes("target_ref"), true);
  eq("…and never chain_steps — the damage kind does not declare it",
    fields(id("orphan"), id("tgt")).includes("chain_steps"), false);
  eq("an existing link is not offered again", fields(id("hit"), id("tgt")).includes("target_ref"), false);
  eq("…nor chain_steps for a step already in the chain",
    fields(id("root"), id("hit")).includes("chain_steps"), false);

  const trig = g.nodes.find((n) => n.isTrigger).id;
  eq("a trigger row offers what it carries (reaction_effect_ref)",
    fields(trig, id("hit")), ["reaction_effect_ref"]);
  const toTrig = gc.linkFieldsFor(g, id("root"), trig);
  eq("nothing may point at a trigger row, and it says why",
    [toTrig.options.length, !!toTrig.reason], [0, true]);
  const nameless = g.nodes.find((n) => n.labelIsSynthetic && !n.isTrigger).id;
  eq("nothing may point at a nameless row", gc.linkFieldsFor(g, id("root"), nameless).options.length, 0);
  eq("a step may not point at itself", gc.linkFieldsFor(g, id("root"), id("root")).options.length, 0);

  const docOpts = gc.linkFieldsFor(g, gc.DOC_NODE, id("hit")).options;
  eq("the document offers only the fire points it carries",
    docOpts.map((o) => o.field), ["on_activate_effect_ref"]);
  eq("…and reports what that fire point holds now", docOpts[0].current, "root");
  const already = gc.linkFieldsFor(g, gc.DOC_NODE, id("root"));
  eq("the fire point is not offered onto the step it already starts at",
    [already.options.length, already.reason], [0, "the skill already starts there"]);
  eq("an existing link says it is already linked, not that it cannot be",
    gc.linkFieldsFor(g, id("hit"), id("tgt")).reason, `"hit" already points at "tgt"`);

  // Every offer must be accepted by the writer: an option the model then
  // refuses is a control that silently does nothing.
  let refused = [], offered = 0;
  for (const a of [gc.DOC_NODE, ...g.nodes.map((n) => n.id)]) {
    for (const b of g.nodes.map((n) => n.id)) {
      for (const o of gc.linkFieldsFor(g, a, b).options) {
        offered += 1;
        const copy = gm.toGraph(props);
        const r = gm.connectNodes(copy, a, b, o.field);
        if (!r.ok) refused.push(`${a}->${b} ${o.field}: ${r.reason}`);
      }
    }
  }
  eq("every offered link is one connectNodes accepts", refused, []);
  // An empty sweep would pass the line above by construction.
  eq("…over a sweep that actually offered links", offered >= 10, true);
  console.log(`        ${offered} offers swept`);
}

// ── storage ─────────────────────────────────────────────────────────────────
console.log("\n— per-user placement —");
{
  const mem = new Map();
  const store = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
  eq("nothing saved reads as empty", gc.loadLayout(store, "Item.x"), { pos: {}, view: null });
  const live = new Set(["a"]);
  gc.saveLayout(store, "Item.x", { pos: { a: { x: 1, y: 2 }, gone: { x: 0, y: 0 } }, view: { x: 1, y: 2, k: 0.5 } }, live);
  eq("a save round-trips, pruned to live ids",
    gc.loadLayout(store, "Item.x"), { pos: { a: { x: 1, y: 2 } }, view: { x: 1, y: 2, k: 0.5 } });
  mem.set(gc.layoutKey("Item.bad"), "{not json");
  eq("corrupt storage reads as empty, never throws", gc.loadLayout(store, "Item.bad"), { pos: {}, view: null });
  const throwing = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  eq("blocked storage reads as empty", gc.loadLayout(throwing, "Item.x"), { pos: {}, view: null });
  eq("…and a refused save reports false", gc.saveLayout(throwing, "Item.x", {}), false);
  gc.clearLayout(store, "Item.x");
  eq("clear forgets it", gc.loadLayout(store, "Item.x").view, null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
