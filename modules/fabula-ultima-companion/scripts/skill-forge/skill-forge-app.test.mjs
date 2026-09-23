// ============================================================================
// Skill Forge — the application's FILE-LEVEL guards and CONTRACT checks.
//
//     node scripts/skill-forge/skill-forge-app.test.mjs
//
// The Application cannot be unit-tested without a running Foundry, which is
// exactly why it is the layer that keeps breaking. These are the checks that
// do NOT need a game — every one of them is a failure mode this file has
// actually suffered, not a hypothetical.
// ============================================================================

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(here, "skill-forge-app.js");
const src = readFileSync(APP, "utf8");

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${label}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};

// ── 1. the file parses ──────────────────────────────────────────────────────
//
// 🩸 `node --check` does NOT catch this class — see
// `feedback_node_check_misses_esm_syntax_errors`. A real dynamic import does.
// Success is `ReferenceError: Application is not defined`: the module parsed
// and then reached for a Foundry global. A SyntaxError is the failure.
console.log("\n— the file parses —");
{
  let err = null;
  try { await import("./skill-forge-app.js"); } catch (e) { err = e; }
  eq("it is not a SyntaxError", err?.constructor?.name === "SyntaxError", false);
  eq("it parsed far enough to want Foundry", err?.constructor?.name, "ReferenceError");
  if (err && err.constructor.name === "SyntaxError") console.log(`        ${err.message}`);
}

// ── 2. NO BACKTICKS inside _styles() ────────────────────────────────────────
//
// 🩸 Broken FOUR times. `_styles()` returns one template literal, so a pair of
// backticks inside it closes and reopens the literal — which means the file's
// TOTAL backtick count stays EVEN and "are the backticks balanced" is
// worthless as a check. The only thing that works is: the body contains
// exactly the ONE that opens it.
console.log("\n— _styles() is one unbroken template literal —");
{
  const start = src.indexOf("_styles() {");
  const end = src.indexOf("</style>", start);
  eq("_styles() was found", start > -1 && end > start, true);
  const body = src.slice(start, end);
  const ticks = (body.match(/`/g) ?? []).length;
  eq("exactly one backtick — the one that opens it", ticks, 1);
  if (ticks !== 1) {
    const lines = body.split("\n").filter((l) => l.includes("`"));
    console.log(`        offending line(s):\n        ${lines.join("\n        ")}`);
  }
}

// ── 3. no stray control bytes ───────────────────────────────────────────────
//
// 🩸 `feedback_backslash_b_written_as_backspace_byte`: a scripted edit once
// planted a literal 0x08 inside a regex and cost two days. Invisible in every
// editor.
console.log("\n— no control bytes —");
{
  const bad = [];
  for (let i = 0; i < src.length; i++) {
    const c = src.charCodeAt(i);
    if (c < 9 || (c > 13 && c < 32)) bad.push({ at: i, code: c });
  }
  eq("the source holds no stray control characters", bad.slice(0, 5), []);
}

// ── 4. the reserved-ref oracle is READ, never copied ────────────────────────
//
// `formula-audit.js` kept a HAND-MAINTAINED prefix list and therefore vouched
// for `TARGET_HAS_STATUS_`, an identifier the resolver does not serve. The one
// defence against repeating that is to never hold a second copy of a
// vocabulary.
console.log("\n— the target-word vocabulary is not duplicated here —");
{
  eq("it reads the published oracle",
    src.includes("FUCompanion?.api?.targetRefs?.isReserved"), true);

  // What a COPY of the vocabulary actually looks like: several reserved words
  // as quoted literals near each other. Checking for one word on its own was
  // useless — `self` appears in ordinary prose and in a placeholder, so the
  // assertion passed no matter what the file contained.
  const WORDS = ["self", "action_targets", "trigger_subject", "trigger_actor", "combat",
    "self_or_my_focus", "own_persistent_summons", "cover_target", "all_enemies"];
  const offenders = src.split("\n")
    .map((line, i) => ({ i: i + 1, line, hits: WORDS.filter((w) => line.includes(`"${w}"`)) }))
    .filter((r) => r.hits.length >= 2)
    .map((r) => `line ${r.i}: ${r.hits.join(", ")}`);
  eq("no list of reserved words is kept here", offenders, []);
}

// ── 5. the shapes this panel reads off other modules ────────────────────────
//
// 🪤 The Conditions builder shipped broken because this file destructured
// `CB.OPERATORS` as `[symbol, label]` pairs when it is an array of
// `{ op, label }` objects. Array-destructuring an object THROWS, so the whole
// panel failed to render — and that was invisible to every suite, because no
// suite renders a panel.
//
// `feedback_read_the_declared_shape_not_a_sample` is the standing lesson. This
// is that lesson as a check: assert the shapes against the module that
// declares them, so the assumption cannot drift again.
console.log("\n— the shapes the panel reads off condition-builder —");
{
  const CB = await import("./condition-builder.js");

  eq("OPERATORS entries carry {op,label}",
    CB.OPERATORS.every((o) => o && typeof o.op === "string" && typeof o.label === "string"), true);
  eq("…and are NOT array pairs", Array.isArray(CB.OPERATORS[0]), false);

  eq("CONNECTIVES entries carry {join,label}",
    CB.CONNECTIVES.every((c) => c && typeof c.join === "string" && typeof c.label === "string"), true);

  eq("identifierOptions() yields {name,label}",
    CB.identifierOptions().every((o) => typeof o.name === "string" && typeof o.label === "string"), true);

  const model = CB.parse("CUR_MP >= 10");
  eq("parse() yields {join,clauses}", !!(model && Array.isArray(model.clauses)), true);
  eq("…with {left,op,right} clauses",
    model.clauses.every((c) => "left" in c && "op" in c && "right" in c), true);
  eq("compile() round-trips it", CB.compile(model), "CUR_MP >= 10");
  eq("parse() DECLINES what it cannot read, rather than guessing",
    CB.parse("max(chance(50), SL) > 2 && weird"), null);

  // The dead identifier must not come back: the resolver never served it, so it
  // folds to 0 and blocks the step forever while still printing its reason.
  eq("TARGET_HAS_STATUS_ is no longer advertised as a family",
    CB.describeIdentifier("TARGET_HAS_STATUS_POISONED").family, undefined);
  eq("…and the supported spelling is catalogued",
    CB.describeIdentifier("TARGET_AE_COUNT_POISONED").family, "TARGET_AE_COUNT_");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
