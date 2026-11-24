// ============================================================================
// socket-noise-gate — quiet the pre-ready "No socket handler" storm.
//
//     node scripts/battle-director/socket-noise-gate.test.mjs
//
// Pins: before our ready work is done, a COMMAND for an unregistered handler is
// dropped without an error; a REQUEST still reaches socketlib (which answers
// UNREGISTERED so the sender does not hang); a registered handler always runs;
// after the flag everything behaves exactly as stock socketlib.
// ============================================================================

const gate = await import("./socket-noise-gate.js");

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${label}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};

// A stand-in SocketlibSocket: the stock _handleRequest throws for an unknown name.
function fakeSocket() {
  const calls = [];
  return {
    calls,
    functions: new Map([["FU_KNOWN", (...a) => calls.push(["known", ...a])]]),
    async _handleRequest(message) {
      const fn = this.functions.get(message.handlerName);
      if (!fn) { calls.push(["unregistered", message.type, message.handlerName]); throw new Error(`No socket handler with the name '${message.handlerName}' has been registered.`); }
      return fn(...(message.args ?? []));
    },
  };
}
const CMD = (n) => ({ type: 0, handlerName: n, args: [1] });
const REQ = (n) => ({ type: 1, handlerName: n, args: [1], id: "r1" });

gate._resetForTest();
const s = gate.gateSocket(fakeSocket());
eq("gateSocket is idempotent", gate.gateSocket(s) === s, true);

let threw = 0;
const run = async (m) => { try { await s._handleRequest(m, "sender"); } catch { threw++; } };

await run(CMD("FU_DIRECTOR_HUD_PHASE"));
await run(CMD("FU_DIRECTOR_HUD_PHASE"));
await run(CMD("FU_BRAND_MARK_VIS"));
eq("pre-ready unregistered COMMANDs: no error", threw, 0);
eq("pre-ready unregistered COMMANDs never reach socketlib", s.calls.filter((c) => c[0] === "unregistered").length, 0);
eq("dropped count by name", gate.droppedPreReady(), { total: 3, byName: { FU_DIRECTOR_HUD_PHASE: 2, FU_BRAND_MARK_VIS: 1 } });

await run(REQ("FU_LATE_JOIN_DIGEST"));
eq("pre-ready REQUEST still goes to socketlib (UNREGISTERED reply path)", s.calls.at(-1), ["unregistered", 1, "FU_LATE_JOIN_DIGEST"]);
threw = 0;

await run(CMD("FU_KNOWN"));
eq("pre-ready registered COMMAND runs", s.calls.at(-1), ["known", 1]);

gate.markSocketHandlersReady();
eq("flag open", gate.socketHandlersReady(), true);
await run(CMD("FU_DIRECTOR_HUD_PHASE"));
eq("after the flag an unregistered COMMAND errors again (real bug stays visible)", [threw, s.calls.at(-1)], [1, ["unregistered", 0, "FU_DIRECTOR_HUD_PHASE"]]);

// The gate opens from its OWN ready hook (registered at install), one tick after ready.
{
  const hooks = {};
  globalThis.Hooks = { once: (name, fn) => { (hooks[name] ??= []).push(fn); } };
  gate._resetForTest();
  gate.installSocketNoiseGate("fu-test");
  gate.installSocketNoiseGate("fu-test");
  eq("install registers exactly one ready hook", (hooks.ready ?? []).length, 1);
  eq("gate shut before ready", gate.socketHandlersReady(), false);
  hooks.ready[0]();
  eq("still shut inside ready (other ready hooks may still be registering)", gate.socketHandlersReady(), false);
  await new Promise((r) => setTimeout(r, 5));
  eq("open one tick after ready", gate.socketHandlersReady(), true);
  delete globalThis.Hooks;
}

// The pure rule.
eq("shouldDrop: response types never", gate.shouldDrop({ type: 2, handlerName: "x" }, new Map(), false), false);
eq("shouldDrop: ready never", gate.shouldDrop(CMD("x"), new Map(), true), false);
eq("shouldDrop: pre-ready unknown command", gate.shouldDrop(CMD("x"), new Map(), false), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
