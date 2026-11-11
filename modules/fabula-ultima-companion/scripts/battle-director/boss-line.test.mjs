// ============================================================================
// Boss line — config parsing and the once-per-playthrough gate.
//
//     node scripts/battle-director/boss-line.test.mjs
//
// playBossLine is driven with stub game / GameState / SystemMessage globals:
// says the line once, remembers it through the switch, plays every cast when
// the flag has no switch, and stays silent for players and unflagged skills.
// ============================================================================

const { readBossLine, bossLineMessage, playBossLine, _resetBossLineMemory } = await import("./boss-line.js");

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  if (!ok) console.log("FAIL", name, "\n  got ", JSON.stringify(got), "\n  want", JSON.stringify(want));
};
const NS = "fabula-ultima-companion";
const itemWith = (bossLine) => ({ flags: { [NS]: { bossLine } }, parent: { name: "Asura" } });

// ── readBossLine ──
eq("no flag", readBossLine({ flags: {} }), null);
eq("null item", readBossLine(null), null);
eq("blank text", readBossLine(itemWith({ text: "  " })), null);
eq("full", readBossLine(itemWith({ text: " Feel my battle prowess! ", switch: "Asura Battle Line", speaker: "Asura", hold: 2200 })),
  { text: "Feel my battle prowess!", speaker: "Asura", switchName: "Asura Battle Line", hold: 2200 });
eq("minimal", readBossLine(itemWith({ text: "Hah!" })), { text: "Hah!", speaker: null, switchName: null, hold: null });
eq("bad hold", readBossLine(itemWith({ text: "Hah!", hold: "x" })).hold, null);

// ── bossLineMessage ──
eq("msg speaker from line", bossLineMessage({ text: "Hi", speaker: "Asura", hold: null }, "Tok"), { kind: "speech", speaker: "Asura", text: "Hi" });
eq("msg fallback speaker + hold", bossLineMessage({ text: "Hi", speaker: null, hold: 2000 }, "Asura A"), { kind: "speech", speaker: "Asura A", text: "Hi", hold: 2000 });

// ── playBossLine (stubs) ──
const switches = new Map();
const shown = [];
let isGM = true;
const items = {};
globalThis.game = { get user() { return { isGM }; } };
globalThis.fromUuid = async (u) => items[u] ?? (u === "Tok" ? { name: "Asura A" } : null);
globalThis.oni = { GameState: {
  partyActor: () => ({ id: "db" }),
  getSwitch: (n) => !!switches.get(n),
  setSwitch: async (n, v) => { switches.set(n, !!v); return !!v; },
} };
globalThis.FU = { SystemMessage: { broadcast: async (m) => { shown.push(m); } } };

items.strike = itemWith({ text: "Feel my battle prowess!", switch: "Asura Battle Line" });
items.plain = { flags: {} };
items.every = itemWith({ text: "Again!" });
const ar = (skillUuid) => ({ skillUuid, attacker: { tokenUuid: "Tok" } });

eq("1st cast speaks", await playBossLine(ar("strike")), true);
eq("switch set", switches.get("Asura Battle Line"), true);
eq("speaker = token name", shown[0], { kind: "speech", speaker: "Asura A", text: "Feel my battle prowess!" });
eq("2nd cast silent", await playBossLine(ar("strike")), false);

// a load from before the first Strike, same page (no reload): the switch is off again
switches.set("Asura Battle Line", false);
eq("after load speaks again", await playBossLine(ar("strike")), true);

eq("unflagged skill", await playBossLine(ar("plain")), false);
eq("no switch = every cast", [await playBossLine(ar("every")), await playBossLine(ar("every"))], [true, true]);

isGM = false; switches.clear(); _resetBossLineMemory();
eq("player client never speaks", await playBossLine(ar("strike")), false);
isGM = true;

// no party database to hold the switch: still once per load
globalThis.oni = {};
_resetBossLineMemory();
eq("no GameState: 1st", await playBossLine(ar("strike")), true);
eq("no GameState: 2nd", await playBossLine(ar("strike")), false);

eq("shown count", shown.length, 5);
console.log(`boss-line: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
