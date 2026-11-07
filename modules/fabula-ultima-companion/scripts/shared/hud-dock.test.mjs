// ============================================================================
// HUD Dock — harness.     node scripts/shared/hud-dock.test.mjs
//
// Loads the classic script into a bare context and checks the stacking against
// the positions the old per-file math produced (captured live 2026-11-07):
//   Skill Point badge 154; controller badge 154, or 212 above a 48px SP badge.
// ============================================================================
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const src = fs.readFileSync(fileURLToPath(new URL("./hud-dock.js", import.meta.url)), "utf8");
function fresh(extra = {}) {
  const ctx = { console, setTimeout, ...extra };
  ctx.globalThis = ctx;
  vm.runInNewContext(src, ctx);
  return ctx.oni.HudDock;
}

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; return; }
  fail++; console.error(`FAIL ${label}\n  got  ${g}\n  want ${w}`);
};

// ── pure layout: the old numbers ───────────────────────────────────────────
{
  const D = fresh();
  const L = (sp, at, cb) => D.layout([{ id: "sp", order: 20, h: sp }, { id: "attr", order: 21, h: at }, { id: "ctl", order: 30, h: cb }]);
  eq("nothing present: everyone's slot is 154", L(0, 0, 0).bottoms, { sp: 154, attr: 154, ctl: 154 });
  eq("controller alone at 154", L(0, 0, 32).bottoms.ctl, 154);
  eq("SP 48 pushes controller to 212 (live: 212)", L(48, 0, 32).bottoms, { sp: 154, attr: 212, ctl: 212 });
  eq("SP + attribute", L(48, 40, 32).bottoms, { sp: 154, attr: 212, ctl: 262 });
  eq("attribute alone sits at 154", L(0, 40, 32).bottoms, { sp: 154, attr: 154, ctl: 204 });
  eq("top of stack = controller top", L(0, 0, 32).top, 186);
  eq("no members present: top null", L(0, 0, 0).top, null);
  eq("heights are rounded like the old getBoundingClientRect math", L(47.6, 0, 31.5).bottoms.ctl, 212);
  const b = D.layout([{ id: "ctl", order: 30, h: 32 }, { id: "sp", order: 20, h: 48 }]).bottoms;
  eq("order wins over registration order", [b.sp, b.ctl], [154, 212]);
}
// ── Dungeon Pathing constants are honoured (as the old dockBottom did) ─────
{
  const D = fresh({ DungeonPathing: { UI: { SCAN_BUTTON: { BOTTOM: 90, SIZE: 70 } } } });
  eq("custom row geometry", D.layout([{ id: "a", order: 1, h: 10 }]).bottoms.a, 170);
}
// ── live registry ──────────────────────────────────────────────────────────
{
  const D = fresh();
  const placed = {};
  let sp = 0;
  D.register("ctl", { order: 30, height: () => 32, apply: (b, on) => { placed.ctl = [b, on]; } });
  D.register("sp", { order: 20, height: () => sp, apply: (b, on) => { placed.sp = [b, on]; } });
  eq("registered: controller at 154", placed.ctl, [154, true]);
  eq("absent SP still told its slot", placed.sp, [154, false]);
  let seen = null;
  D.onChange(({ stackTop }) => { seen = stackTop; });
  sp = 48; D.relayout();
  eq("SP appears: controller moves to 212", placed.ctl, [212, true]);
  eq("change listener gets new stack top", seen, 244);
  eq("stackTop", D.stackTop(), 244);
  sp = 0; D.relayout();
  eq("SP gone: controller back to 154", placed.ctl, [154, true]);
  D.unregister("ctl");
  eq("only rows: stack top is the row top when a row is visible", (D.registerRow("dp", () => true), D.stackTop()), 144);
}
{
  const D = fresh();
  D.registerRow("dp", () => false);
  eq("nothing at all: stack top 0", D.stackTop(), 0);
  D.register("bad", { order: 1, height: () => { throw new Error("boom"); }, apply: () => {} });
  eq("a throwing member counts as absent", D.stackTop(), 0);
}

// ── row packing: full sets reproduce the old fixed slots ──────────────────
{
  const D = fresh();
  const P = (present, travelOrder = 50) => D.packRow([
    { id: "scan", order: 10, present: present.includes("scan") },
    { id: "heal", order: 20, present: present.includes("heal") },
    { id: "helper", order: 30, present: present.includes("helper") },
    { id: "ft", order: 40, present: present.includes("ft") },
    { id: "travel", order: travelOrder, present: present.includes("travel") },
    { id: "ritual", order: 90, present: present.includes("ritual") },
  ]);
  eq("dungeon, everything on = old slots",
    P(["scan", "heal", "helper", "ft", "travel", "ritual"]), { scan: 20, heal: 94, helper: 168, ft: 242, travel: 316, ritual: 390 });
  eq("dungeon, Fast Travel off = old LEFT_NO_FT slots",
    P(["scan", "heal", "helper", "travel", "ritual"]), { scan: 20, heal: 94, helper: 168, travel: 242, ritual: 316 });
  eq("exploration (travel leads) = old exploration slots",
    P(["travel", "heal", "ritual"], 5), { travel: 20, heal: 94, ritual: 168 });
  eq("theatre: ritual alone = old LEFT_SOLO", P(["ritual"]), { ritual: 20 });
  eq("the reported gap: heal + ritual close up", P(["heal", "ritual"]), { heal: 20, ritual: 94 });
  eq("custom geometry", fresh({ DungeonPathing: { UI: { SCAN_BUTTON: { LEFT: 30, SIZE: 50 } } } })
    .packRow([{ id: "a", order: 1, present: true }, { id: "b", order: 2, present: true }]), { a: 30, b: 90 });
}

console.log(`hud-dock: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
