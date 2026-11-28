// ============================================================================
// "Out of battle only" consumables (to-do #13).
//
//     node scripts/battle-director/field-only-items.test.mjs
//
// Forget me Nut (a skill reset) showed as usable in the battle Item menu. The
// item now carries system.props.out_of_battle_only; the menu greys it out.
// Detection reads the prop only, never the name. Also runs the one-time
// migration against a fake game.
// ============================================================================

const { isOutOfBattleOnly, isOutOfBattleOnlyItem, OUT_OF_BATTLE_PROP, OUT_OF_BATTLE_LABEL } =
  await import("./field-only-items.js");
const mig = await import("../../data-migrations/2026-11-28-forget-me-nut-out-of-battle.js");

let failed = 0;
function check(label, got, expected) {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label} -> ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
}

check("prop key", OUT_OF_BATTLE_PROP, "out_of_battle_only");
check("label", OUT_OF_BATTLE_LABEL, "Out of battle only");

// ── detection ───────────────────────────────────────────────────────────────
check("checkbox true", isOutOfBattleOnly({ out_of_battle_only: true }), true);
check("checkbox false", isOutOfBattleOnly({ out_of_battle_only: false }), false);
check("string 'true'", isOutOfBattleOnly({ out_of_battle_only: "true" }), true);
check("string 'false'", isOutOfBattleOnly({ out_of_battle_only: "false" }), false);
check("1", isOutOfBattleOnly({ out_of_battle_only: 1 }), true);
check("missing (every legacy item)", isOutOfBattleOnly({ item_type: "consumable" }), false);
check("empty string", isOutOfBattleOnly({ out_of_battle_only: "" }), false);
check("null props", isOutOfBattleOnly(null), false);
check("NOT by name", isOutOfBattleOnlyItem({ name: "Forget me Nut", system: { props: { item_type: "consumable" } } }), false);
check("by prop on a doc", isOutOfBattleOnlyItem({ name: "Anything", system: { props: { out_of_battle_only: true } } }), true);
check("doc without system", isOutOfBattleOnlyItem({}), false);

// ── migration ───────────────────────────────────────────────────────────────
function fakeItem(id, name, props = {}, extra = {}) {
  const it = { id, name, system: { props: { ...props } }, ...extra, updates: [] };
  it.update = async (data) => {
    it.updates.push(data);
    for (const [k, v] of Object.entries(data)) if (k.startsWith("system.props.")) it.system.props[k.slice(13)] = v;
  };
  return it;
}
function fakeActor(name, items) {
  const a = { name, items, calls: [] };
  a.updateEmbeddedDocuments = async (type, ups) => {
    a.calls.push([type, ups]);
    for (const u of ups) {
      const it = items.find((i) => i.id === u._id);
      for (const [k, v] of Object.entries(u)) if (k.startsWith("system.props.")) it.system.props[k.slice(13)] = v;
    }
  };
  for (const it of items) it.parent = a;
  return a;
}
const world = fakeItem("fOEeRwVzYy6YQuIN", "Forget me Nut", { item_type: "consumable" });
const otherWorld = fakeItem("x1", "Elixir", { item_type: "consumable" });
const viaSource = fakeItem("c1", "Forget me Nut", {}, { _stats: { compendiumSource: "Item.fOEeRwVzYy6YQuIN" } });
const renamed = fakeItem("c2", "Nut (renamed)", {}, { _stats: { compendiumSource: "Item.fOEeRwVzYy6YQuIN" } });
const byName = fakeItem("c3", "Forget me Nut");
const already = fakeItem("c4", "Forget me Nut", { out_of_battle_only: true });
const elixir = fakeItem("c5", "Elixir");
const zarg = fakeActor("Zarg", [viaSource, elixir]);
const rume = fakeActor("Rume", [renamed, byName, already]);
const nobody = fakeActor("Nobody", [fakeItem("c6", "Remedy")]);
const items = [world, otherWorld];
items.get = (id) => items.find((i) => i.id === id) ?? null;
const game = { items, actors: [zarg, rume, nobody] };

check("migration key", mig.key, "2026-11-28-forget-me-nut-out-of-battle");
const res = await mig.migrate(game);
check("applied", res.applied, true);
check("world item set", world.system.props.out_of_battle_only, true);
check("other world item untouched", otherWorld.updates.length, 0);
check("copy via source link", viaSource.system.props.out_of_battle_only, true);
check("renamed copy via source link", renamed.system.props.out_of_battle_only, true);
check("copy by exact name", byName.system.props.out_of_battle_only, true);
check("Elixir copy untouched", elixir.system.props.out_of_battle_only, undefined);
check("already-set copy not rewritten", rume.calls[0][1].map((u) => u._id), ["c2", "c3"]);
check("actor with no copy: no write", nobody.calls.length, 0);
// second run: zero writes
const before = [world.updates.length, zarg.calls.length, rume.calls.length];
await mig.migrate(game);
check("re-run writes nothing", [world.updates.length, zarg.calls.length, rume.calls.length], before);

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
if (failed) process.exit(1);
