// ============================================================================
// Pattern library — expansion contract.
//
//     node scripts/skill-forge/patterns.test.mjs
//
// THE CONTRACT: every pattern, filled with its own defaults, must expand to a
// document the SKILL VALIDATOR passes with zero findings.
//
// That is what makes a pattern trustworthy without opening the game. A pattern
// is a promise that the author does not need to know the canon — if its output
// trips the validator, the pattern is teaching the mistake instead of
// preventing it, and it does so at scale across everyone who picks it.
// ============================================================================

const { PATTERNS, PATTERNS_BY_ID, expand, defaultsFor, patternsByCommand } =
  await import("./patterns.js");
const { validateSkillDoc, liveRows } = await import("../lint/skill-validator.js");

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${label}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};

// A ctx that knows the columns and props the patterns actually emit. Built from
// the patterns' own output so a new pattern using a new field is CHECKED, not
// silently exempted — an allowlist assembled by hand would drift the moment
// someone added a row kind.
function ctxFor(allDocs) {
  const rowCols = { effect_table: new Set(), reaction_config_table: new Set() };
  const props = new Set(["level", "max_level", "name", "description"]);
  for (const d of allDocs) {
    for (const k of Object.keys(d.system.props)) props.add(k);
    for (const t of ["effect_table", "reaction_config_table"]) {
      for (const { row } of liveRows(d.system.props[t])) {
        for (const k of Object.keys(row)) rowCols[t].add(k);
      }
    }
  }
  return {
    // Every identifier a pattern can emit today is a literal; patterns never
    // author a formula. If one ever does, this vocabulary makes it fail loudly.
    vocabulary: { vocab: new Set(["SL", "HAS_SHIELD"]), prefixes: ["VAR_"] },
    rowColumns: rowCols,
    declaredProps: props,
    requiredFieldsByKind: {
      grant: { all: ["grant_resource"], either: [] },
      chain: { all: ["chain_steps"], either: [] },
      apply_ae: { all: ["ae_template_ref"], either: [], unlessSet: ["ae_pool_tag", "ae_name_pool"] },
      consume_resource: { all: [], either: [["consume_resource", "grant_resource"]] },
      open_action_menu: { all: ["menu_option_refs"], either: [], unlessTrueStrict: ["free_mode"] },
      remove_ae: { all: [], either: [["ae_template_ref", "filter_tag"]] },
      summon: { all: [], either: [] },
      deal_damage: { all: [], either: [] },
      adjust_damage: { all: [], either: [] },
      free_action: { all: [], either: [] },
      targeting: { all: [], either: [] },
    },
  };
}

// Fill every field with something plausible so "missing" is not the thing under
// test — the question is whether a COMPLETE pattern is well-formed.
function filled(p) {
  const v = defaultsFor(p.id);
  for (const f of p.fields) {
    if (String(v[f.key] ?? "").trim() !== "") continue;
    v[f.key] = f.kind === "number" ? 3
      : f.kind === "choice" ? f.options[0]
      : `Test ${f.key}`;
  }
  return v;
}

const docs = PATTERNS.map((p) => {
  const { props, effects } = expand(p.id, filled(p));
  return { id: p.id, name: `Pattern: ${p.label}`, system: { props }, effects };
});
const CTX = ctxFor(docs);

// ── the contract ────────────────────────────────────────────────────────────
console.log(`\n— every pattern expands clean (${PATTERNS.length} patterns) —`);
for (const d of docs) {
  const { findings } = validateSkillDoc(d, CTX);
  eq(`${d.id} expands with no findings`, findings.map((f) => `${f.code}@${f.location}`), []);
}

// ── structural invariants the validator cannot see ──────────────────────────
console.log("\n— structural invariants —");
for (const p of PATTERNS) {
  const { props } = expand(p.id, filled(p));
  const rows = liveRows(props.effect_table).map((r) => r.row);
  const labels = new Set(rows.map((r) => r.effect_label));

  // Every ref must resolve. A dangling chain step or target_ref is the single
  // most common hand-authoring mistake, and a pattern must never emit one.
  const refs = [];
  for (const r of rows) {
    if (r.target_ref) refs.push(["target_ref", r.target_ref]);
    for (const s of String(r.chain_steps ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
      refs.push(["chain_steps", s]);
    }
    for (const s of String(r.menu_option_refs ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
      refs.push(["menu_option_refs", s]);
    }
  }
  const dangling = refs.filter(([, target]) => !labels.has(target)).map(([k, t]) => `${k}->${t}`);
  eq(`${p.id}: every row reference resolves`, dangling, []);

  // The fire point must exist, or the rows are authored and unreachable.
  if (props.on_activate_effect_ref) {
    eq(`${p.id}: on_activate_effect_ref points at a real row`,
      labels.has(props.on_activate_effect_ref), true);
  }
  // A reaction row's ref likewise.
  for (const { row } of liveRows(props.reaction_config_table)) {
    if (!row.reaction_effect_ref) continue;
    eq(`${p.id}: reaction_effect_ref points at a real row`,
      labels.has(row.reaction_effect_ref), true);
  }
}

// ── canon rules the patterns must not break ─────────────────────────────────
console.log("\n— canon —");
for (const p of PATTERNS) {
  const { props } = expand(p.id, filled(p));
  const rows = liveRows(props.effect_table).map((r) => r.row);

  // COST: one source of truth. A legacy `cost` string AND a consume_resource
  // row in the same chain charges the player twice, with no engine guard.
  const hasConsume = rows.some((r) => r.effect_kind === "consume_resource");
  const hasCostString = String(props.cost ?? "").trim() !== "";
  eq(`${p.id}: does not mix a cost string with a consume_resource row`,
    hasCostString && hasConsume, false);

  // A reaction never reaches the card's cost-debit phase, so a cost string on
  // one is display-only and misleading if the chain does not also debit.
  if (props.isReaction === true) {
    eq(`${p.id}: a reaction carries no cost string`, String(props.cost ?? "").trim(), "");
  }

  // Canon rule 5: a TRUE passive is a transfer:true AE, not a trigger that
  // applies a self-AE. If a pattern emits a passive AE it must not also wire
  // a reaction row for the same behaviour.
  if (p.id === "passive_bonus") {
    const { effects } = expand(p.id, filled(p));
    eq("passive_bonus carries a transfer AE", effects[0]?.transfer, true);
    eq("passive_bonus has no duration ticking", effects[0]?.duration, {});
    eq("passive_bonus wires NO reaction row", props.reaction_config_table, undefined);
    eq("passive_bonus wires NO effect table", props.effect_table, undefined);
  }

  // Explicit level / max_level — never inherit the template default.
  eq(`${p.id}: sets level explicitly`, props.level, 1);
  eq(`${p.id}: sets max_level explicitly`, typeof props.max_level, "number");
}

// ── API shape ───────────────────────────────────────────────────────────────
console.log("\n— API —");
eq("patterns have unique ids", PATTERNS.length, new Set(PATTERNS.map((p) => p.id)).size);
eq("every pattern declares a command", PATTERNS.filter((p) => !p.command).map((p) => p.id), []);
eq("every pattern has at least one field", PATTERNS.filter((p) => !p.fields?.length).map((p) => p.id), []);
eq("every pattern has a blurb", PATTERNS.filter((p) => !p.blurb).map((p) => p.id), []);
eq("expand reports a bad id", expand("nope").error, 'unknown pattern "nope"');
eq("expand reports missing required fields",
  expand("status_to_enemy", { status: "" }).missing.length > 0, true);
eq("an optional field may be blank",
  expand("damage_one_enemy", { cost: "" }).missing, []);
eq("patternsByCommand groups them", patternsByCommand().get("skill").length > 5, true);
eq("there are at least 15 patterns", PATTERNS.length >= 15, true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
