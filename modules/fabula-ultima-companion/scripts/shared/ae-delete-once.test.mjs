// Node checks: two writers deleting the same Active Effect send ONE delete.
// Run: node ae-delete-once.test.mjs
import { deleteEffectsOnce, _inFlightCount } from "./ae-delete-once.js";

let pass = 0, fail = 0;
const ok = (name, c, got) => { if (c) pass++; else { fail++; console.log("FAIL", name, JSON.stringify(got)); } };

// Fake actor with a server that throws like Foundry's on a missing id, after a delay.
function fakeActor(uuid, ids) {
  const live = new Set(ids);
  const calls = [];
  return {
    uuid, calls,
    effects: { has: (id) => live.has(id) },
    async deleteEmbeddedDocuments(type, del) {
      calls.push([...del]);
      await new Promise((r) => setTimeout(r, 20));
      for (const id of del) if (!live.has(id)) throw new Error(`ActiveEffect "${id}" does not exist!`);
      for (const id of del) live.delete(id);
      return del;
    },
  };
}

// 1. The Crisis race: two callers, same id, same frame.
{
  const a = fakeActor("Actor.k", ["crisis"]);
  const [r1, r2] = await Promise.all([deleteEffectsOnce(a, ["crisis"]), deleteEffectsOnce(a, ["crisis"])]);
  ok("one server delete", a.calls.length === 1, a.calls);
  ok("first caller owns it", r1.length === 1 && r2.length === 0, [r1, r2]);
  ok("gone afterwards", !a.effects.has("crisis"));
  ok("in-flight map empties", _inFlightCount() === 0, _inFlightCount());
}

// 2. Overlap: second caller still deletes the ids nobody else is deleting.
{
  const a = fakeActor("Actor.o", ["x", "y"]);
  await Promise.all([deleteEffectsOnce(a, ["x"]), deleteEffectsOnce(a, ["x", "y"])]);
  ok("two calls, no shared id", a.calls.length === 2 && a.calls[1].join() === "y", a.calls);
  ok("both gone", !a.effects.has("x") && !a.effects.has("y"));
}

// 3. Already gone → no call at all.
{
  const a = fakeActor("Actor.g", []);
  const r = await deleteEffectsOnce(a, ["nope", null, ""]);
  ok("no call for a missing id", a.calls.length === 0 && r.length === 0, a.calls);
}

// 4. The waiting caller resumes only after the delete committed.
{
  const a = fakeActor("Actor.w", ["c"]);
  const p1 = deleteEffectsOnce(a, ["c"]);
  await deleteEffectsOnce(a, ["c"]);
  ok("waiter sees it gone", !a.effects.has("c"));
  await p1;
}

// 5. Same id on two different actors is not a clash.
{
  const a = fakeActor("Actor.a", ["same"]), b = fakeActor("Actor.b", ["same"]);
  await Promise.all([deleteEffectsOnce(a, ["same"]), deleteEffectsOnce(b, ["same"])]);
  ok("per-actor keys", a.calls.length === 1 && b.calls.length === 1);
}

// 6. A real server error still reaches the owning caller, and the lock clears.
{
  const a = fakeActor("Actor.e", ["e"]);
  a.deleteEmbeddedDocuments = async () => { await new Promise((r) => setTimeout(r, 5)); throw new Error("boom"); };
  let threw = false;
  try { await deleteEffectsOnce(a, ["e"]); } catch { threw = true; }
  ok("owner sees the error", threw);
  ok("lock released after error", _inFlightCount() === 0, _inFlightCount());
}

console.log(`ae-delete-once: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
