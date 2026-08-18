// ============================================================================
// Offline check — camp landing phases
//
//   node tools/camp-landing-phase-check.js
//
// A save taken mid-ceremony must not restore a phase whose UI is a one-shot
// animation: replayed on load, `sleeping` runs a SECOND full rest (another
// jingle, another resource restore, another campRestCharges tick). CAMP.LANDING_PHASE
// is the rule that prevents it and this asserts it, with the Foundry globals
// stubbed so it runs with the game closed.
//
// It also fails when a NEW camp phase is added without a landing decision —
// that is the point. Add the phase to EXPECT below, deliberately.
//
// Scope: loads the real camp-constants.js + camp-state.js, but REPLICATES the
// few lines the campState extractor runs (loading save-extractors.js would need
// the whole Foundry document surface). It proves the rule, not that one call site.
// ============================================================================
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "modules", "fabula-ultima-companion");

// ── Stubs ───────────────────────────────────────────────────────────────────
const settings = new Map();
globalThis.Hooks = { once() {}, on() {}, callAll() {} };
globalThis.game = {
  user: { isGM: true },
  settings: {
    register() {},
    get: (mod, key) => settings.get(key),
    set: async (mod, key, val) => { settings.set(key, val); },
  },
};

function load(rel) {
  const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
  new Function(src)();
}

load("scripts/camp-system/camp-constants.js");
load("scripts/camp-system/camp-state.js");

const CAMP = globalThis.CampSystem;
let fails = 0;
const check = (name, got, want) => {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? "  ok " : "FAIL "} ${name}: got ${JSON.stringify(got)}${ok ? "" : ` want ${JSON.stringify(want)}`}`);
};

console.log("— landingPhaseFor over every phase —");
const EXPECT = {
  free_roam:         "free_roam",
  activity_select:   "activity_select",
  activity_resolve:  "free_roam",
  bond_update:       "bond_update",
  bond_summary:      "bond_summary",
  sleep_lobby:       "sleep_lobby",
  sleeping:          "set_out_lobby",
  rest_save_prompt:  "set_out_lobby",
  rest_saving:       "set_out_lobby",
  rest_title_prompt: "set_out_lobby",
  set_out_lobby:     "set_out_lobby",
};
for (const phase of Object.values(CAMP.PHASE)) {
  check(phase, CAMP.State.landingPhaseFor(phase), EXPECT[phase]);
}
check("unknown phase maps to itself", CAMP.State.landingPhaseFor("some_future_phase"), "some_future_phase");
check("undefined falls back to free_roam", CAMP.State.landingPhaseFor(undefined), "free_roam");

// Every phase must be accounted for in EXPECT — a new phase added without a
// decision here should trip this, not silently default.
const unlisted = Object.values(CAMP.PHASE).filter(p => !(p in EXPECT));
check("no phase missing from this test", unlisted.length, 0);

// ── campState extractor normalisation (replicated inline) ───────────────────
console.log("\n— campState snapshot normalisation —");
function snapshot(livePhase) {
  const result = {};
  for (const key of Object.values(CAMP.SETTING)) result[key] = settings.get(key) ?? "{}";
  result[CAMP.SETTING.PHASE] = livePhase;
  const landing = CAMP.State.landingPhaseFor(result[CAMP.SETTING.PHASE]);
  if (landing !== result[CAMP.SETTING.PHASE]) {
    result[CAMP.SETTING.PHASE] = landing;
    for (const name of CAMP.TRANSIENT_SETTINGS) {
      const key = CAMP.SETTING[name];
      if (key && key in result) result[key] = "{}";
    }
  }
  return result;
}

// Party mid-ceremony with a fully-ready sleep lobby behind them.
settings.set(CAMP.SETTING.SLEEP_READY, '{"u1":true,"u2":true}');
settings.set(CAMP.SETTING.SET_OUT_READY, '{"u1":true}');
settings.set(CAMP.SETTING.SELECTIONS, '{"a1":{"locked":"cooking"}}');
settings.set(CAMP.SETTING.EXPLORATION_DEBUFFS, '{"a1":{"halfRest":true}}');

const mid = snapshot(CAMP.PHASE.REST_SAVING);
check("phase normalised", mid[CAMP.SETTING.PHASE], "set_out_lobby");
check("sleep ready cleared", mid[CAMP.SETTING.SLEEP_READY], "{}");
check("set-out ready cleared", mid[CAMP.SETTING.SET_OUT_READY], "{}");
check("selections cleared", mid[CAMP.SETTING.SELECTIONS], "{}");
// Exploration debuffs are NOT transient state of the lobby — rest clears them
// itself, and a save taken before that must keep them.
check("exploration debuffs kept", mid[CAMP.SETTING.EXPLORATION_DEBUFFS], '{"a1":{"halfRest":true}}');

// A save taken during ordinary play must pass through untouched.
const calm = snapshot(CAMP.PHASE.FREE_ROAM);
check("free_roam untouched", calm[CAMP.SETTING.PHASE], "free_roam");
check("free_roam keeps ready maps", calm[CAMP.SETTING.SLEEP_READY], '{"u1":true,"u2":true}');

// ── SAVE_CHOICE accessor defaults ───────────────────────────────────────────
console.log("\n— save choice shape —");
settings.set(CAMP.SETTING.SAVE_CHOICE, "{}");
const empty = CAMP.State.getSaveChoice();
check("empty choice: asked", empty.asked, false);
check("empty choice: ok", empty.ok, null);
settings.set(CAMP.SETTING.SAVE_CHOICE, '{"asked":true,"save":true,"ok":true,"slotId":2}');
const filled = CAMP.State.getSaveChoice();
check("filled choice: slotId", filled.slotId, 2);
check("filled choice: error defaulted", filled.error, null);

console.log(`\n${fails ? `${fails} FAILURE(S)` : "all checks passed"}`);
process.exit(fails ? 1 : 0);
