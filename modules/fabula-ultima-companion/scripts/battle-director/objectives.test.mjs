// ============================================================================
// Objective action — option-pool harness.
//
//     node scripts/battle-director/objectives.test.mjs
//
// collectObjectives decides which Objective actions a creature may take. Every
// way it can be wrong is silent at the table: a missing option looks like a
// creature that simply can't do the thing, and an extra one looks like a rule
// nobody remembers writing. The grant/deny asymmetry in particular has no
// visible symptom until a dominating boss is quietly holding every unique
// Objective in the world.
//
// Foundry globals are stubbed just far enough for the module graph to load.
// ============================================================================

const MODULE_ID = "fabula-ultima-companion";

// ── Stubs ───────────────────────────────────────────────────────────────────
// Set BEFORE importing: the module graph reads `game` at call time, but some
// siblings touch Hooks while evaluating.
globalThis.Hooks = { on() {}, once() {}, callAll() {}, off() {} };
globalThis.canvas = { scene: null, tokens: { placeables: [] } };
globalThis.ui = { notifications: { warn() {}, info() {}, error() {} } };
globalThis.CONFIG = {};

let _items = [];
globalThis.game = {
  get items() { return _items; },
  user: { isGM: true },
  combat: null,
  scenes: { contents: [], current: null },
  modules: { get: () => ({ api: {} }) },
  settings: { get: () => null, set: () => {} },
};

const { collectObjectives, validateObjectivePick, objectiveIdOf } =
  await import("./objectives.js");

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${label}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};

// ── Fixtures ────────────────────────────────────────────────────────────────

function item(id, { scope = "all", gate = null, gateReason = null, name = null } = {}) {
  return {
    type: "equippableItem",
    uuid: `Item.${id}`,
    name: name ?? id,
    img: "",
    flags: { [MODULE_ID]: {
      coreAction: `objective:${id}`,
      ...(scope ? { objectiveScope: scope } : {}),
      ...(gate ? { objectiveGate: gate } : {}),
      ...(gateReason ? { objectiveGateReason: gateReason } : {}),
    } },
    system: { props: { description: "", cost: "" } },
  };
}

// `changes` are AE change rows; `npc` flips the PC/NPC discriminator.
function actor({ changes = [], npc = false, dominating = false } = {}) {
  const effects = [];
  if (changes.length) effects.push({ disabled: false, changes });
  if (dominating) effects.push({ disabled: false, changes: [{ key: "ignore_action_gating", value: "1" }] });
  return {
    name: "Test",
    uuid: "Actor.test",
    system: { props: { ...(npc ? { npc_rank: "soldier" } : {}), level: 40 } },
    effects: { contents: effects },
  };
}

const ids = (rows) => rows.map((r) => r.id).sort();

// ── Identity ────────────────────────────────────────────────────────────────
eq("flag prefix is stripped", objectiveIdOf(item("run")), "run");
eq("a non-objective coreAction is not an option",
  objectiveIdOf({ flags: { [MODULE_ID]: { coreAction: "guard" } } }), null);
eq("an unflagged item is not an option", objectiveIdOf({ flags: {} }), null);

// ── World defaults + scope ──────────────────────────────────────────────────
_items = [item("run", { scope: "pc" }), item("clock"), item("secret", { scope: "none" })];

eq("a PC sees pc-scoped and all-scoped, never grant-only",
  ids(collectObjectives({ actor: actor() })), ["clock", "run"]);
eq("an NPC does not see a pc-scoped option",
  ids(collectObjectives({ actor: actor({ npc: true }) })), ["clock"]);

// ── Grants ──────────────────────────────────────────────────────────────────
const grant = (v) => [{ key: "grant_objective", value: v }];
const deny  = (v) => [{ key: "deny_objective", value: v }];

eq("a grant surfaces a grant-only option",
  ids(collectObjectives({ actor: actor({ changes: grant("secret") }) })), ["clock", "run", "secret"]);
eq("a grant matches by NAME too",
  ids(collectObjectives({ actor: actor({ changes: grant("Secret") }) })), ["clock", "run", "secret"]);
eq("a comma list grants several",
  ids(collectObjectives({ actor: actor({ npc: true, changes: grant("secret, run") }) })),
  ["clock", "run", "secret"]);

// ── Denies ──────────────────────────────────────────────────────────────────
eq("a deny removes a world default",
  ids(collectObjectives({ actor: actor({ changes: deny("clock") }) })), ["run"]);
eq("deny beats grant on the same option",
  ids(collectObjectives({ actor: actor({ changes: [...grant("secret"), ...deny("secret")] }) })),
  ["clock", "run"]);

// ── The asymmetry that has no visible symptom ───────────────────────────────
// A Domination bypass makes RESTRICTIONS inert. It must not manufacture options
// the creature was never given — a grant is a capability, not a restriction.
eq("Domination makes a deny inert",
  ids(collectObjectives({ actor: actor({ changes: deny("clock"), dominating: true }) })),
  ["clock", "run"]);
eq("Domination does NOT conjure a grant-only option",
  ids(collectObjectives({ actor: actor({ dominating: true }) })), ["clock", "run"]);

// ── Battle-plan lists ───────────────────────────────────────────────────────
const director = (plan) => ({ ctx: { payload: { battlePlan: plan } } });

eq("the battle plan can grant",
  ids(collectObjectives({ actor: actor(), director: director({ objectiveGrant: ["secret"] }) })),
  ["clock", "run", "secret"]);
eq("the battle plan can deny",
  ids(collectObjectives({ actor: actor(), director: director({ objectiveDeny: ["run"] }) })),
  ["clock"]);
eq("a plan deny beats an AE grant",
  ids(collectObjectives({
    actor: actor({ changes: grant("secret") }),
    director: director({ objectiveDeny: ["secret"] }),
  })), ["clock", "run"]);

// ── Gates ───────────────────────────────────────────────────────────────────
// A gated option is SHOWN dimmed with its reason, never hidden — the same
// shown-not-hidden treatment the action-gating blades use.
_items = [item("run", { gate: "0", gateReason: "No escaping this one" }), item("clock")];

const gated = collectObjectives({ actor: actor() });
eq("a failed gate keeps the row", ids(gated), ["clock", "run"]);
eq("a failed gate stamps its reason",
  gated.find((r) => r.id === "run").disabledReason, "No escaping this one");
eq("an open gate leaves the row usable",
  gated.find((r) => r.id === "clock").disabledReason, null);
eq("the plan's allow list bypasses the gate",
  collectObjectives({ actor: actor(), director: director({ objectiveAllow: ["run"] }) })
    .find((r) => r.id === "run").disabledReason, null);

// ── The DECLARE backstop (X1) ───────────────────────────────────────────────
eq("validate accepts an available option",
  validateObjectivePick({ actor: actor(), id: "clock" })?.id, "clock");
eq("validate refuses an option this creature never had",
  validateObjectivePick({ actor: actor(), id: "secret" }), null);
eq("validate refuses a GATED option (a stale pick from before the gate closed)",
  validateObjectivePick({ actor: actor(), id: "run" }), null);
eq("validate refuses an unknown id", validateObjectivePick({ actor: actor(), id: "nope" }), null);
eq("validate refuses a blank id", validateObjectivePick({ actor: actor(), id: "" }), null);

// ── Empty world ─────────────────────────────────────────────────────────────
_items = [];
eq("no authored options yields an empty pool", collectObjectives({ actor: actor() }), []);
eq("no actor yields an empty pool", collectObjectives({ actor: null }), []);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
