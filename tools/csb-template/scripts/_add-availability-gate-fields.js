"use strict";

// Declare `availability_formula` + `availability_reason` on the live skill template.
//
// WHY. Both props are engine-read but were DECLARED NOWHERE, and `reloadTemplate()`
// prunes every undeclared prop (persisted `system.props['-=key'] = true`). Measured
// 2026-09-05: reloading a gated skill dropped exactly these two keys, every time.
// The failure direction is permissive and silent — a pruned formula means NO gate,
// so the skill goes always-clickable with no reason chip and nothing reports it.
// 13 documents depend on it (Numen's one-Numen cap, Bimagus x6, Quaking Titan,
// Brainwave Discharge, Birth of the Cruel: Dismiss x2).
//
// PLACEMENT — the pair lives in its OWN nested panel, inserted after
// `target_eligibility`. Not loose in the header, for two measured reasons:
//
//   1. The header is a WRAPPING FLEX ROW (`full-size` = flex:1 1 0), not a fixed
//      grid. Two loose conditionally-visible fields pull the entire tail across
//      columns: hiding "Unavailable Reason" moved Duration, Range, Action Keywords
//      AND Level into different columns. ~2312 of 2325 skills have no gate, so the
//      ungated layout is the norm and the gated sheet became the odd one out — the
//      exact moment a GM is comparing a working example against their own.
//      A nested panel contains the reflow inside one row; everything below keeps a
//      stable column forever.
//   2. Loose `full-size` fields share a row two-up, giving ~223px inputs — and the
//      real formulas are longer than that. `OWN_PERSISTENT_SUMMON_COUNT >= 1` and
//      `AE_CHARGES_BRAINWAVE_CLOCK >= 4` are both 31 chars and clipped mid-token.
//      Their own row roughly doubles the width and holds every current formula.
//
// The pair still reads in sequence with the target-side filter it belongs beside:
// Target -> Target Filter -> [ Usable When | Unavailable Reason ].
//
// Also renames the pre-existing `target_eligibility` LABEL to "Target Filter"
// (label only — the key is untouched, so no data migration). "Eligibility Filter"
// vs "Usable When" gave no hint the two are the same mechanism at different
// scopes; "Target Filter" makes the axis explicit: one filters TARGETS, the other
// filters the whole SKILL.
//
// GAME MUST BE CLOSED (direct LevelDB write). Idempotent: re-running removes any
// previous insertion and rebuilds it, so this file stays the single description
// of the final shape.
//
// Usage:
//   node tools/csb-template/scripts/_add-availability-gate-fields.js --dry-run
//   node tools/csb-template/scripts/_add-availability-gate-fields.js

const { CsbTree, build } = require("../lib/tree");
const { lint } = require("../lib/lint");
const { loadFromDb, saveToDb } = require("../lib/source");

const DRY = process.argv.includes("--dry-run");

// ONLY the live skill template. "_Skill Template (Copy)" (Sodp3LYHuhrZI5xO) is
// deliberately NOT patched: it backs 0 documents and is a stale snapshot several
// generations behind — no target_eligibility, no skill_tags, no action_keywords.
// Adding one modern field to a dead template missing three others is cargo-cult.
const TARGETS = [
  { uuid: "Item.j0F5Msw5RZ8aIB3j", label: "_Skill Template  [live, 2325 docs]" },
];

const ANCHOR = "target_eligibility";
const PANEL_KEY = "availability_gate_panel";
const ACTION_TYPES =
  "or(or(equalText(skill_type, 'Active'), equalText(skill_type, 'Spell')), equalText(skill_type, 'Attack'))";

// `availability_reason` has TWO engine consumers, not one:
//   - skill-picker.js        : the greyed picker row, paired with availability_formula
//   - state-handlers.js:4477 : the pre_activate refusal notification (Quaking
//     Titan's path), which needs NO formula — only a `pre_activate_effect_ref`
//     (state-handlers.js:4437 reads exactly that before it can refuse).
// Gating the box on availability_formula alone would hide an authored value from
// its own sheet for that second case, so show it when EITHER trigger is present.
//
// 🩸 NOT `not(equalText(availability_reason, ''))`. A visibility formula that
// references ITS OWN prop breaks CSB's compiler — it emitted a page-level
// `SyntaxError: Unexpected identifier 'availability_reason'` on every load. The
// sheet still LOOKED right (the field showed and hid correctly), so this was
// invisible until a Playwright run surfaced the uncaught page error. Referencing
// `pre_activate_effect_ref` expresses the same intent with no self-reference —
// and is the more precise condition anyway, since that is what actually enables
// the second consumer.
const REASON_VIS =
  `and(${ACTION_TYPES}, or(not(equalText(availability_formula, '')), not(equalText(pre_activate_effect_ref, ''))))`;

function gatePanel() {
  return build.panel(PANEL_KEY, {
    // VERTICAL, so each field gets the whole spanned row rather than half of it.
    // Side by side they were 221px and a 31-char formula still clipped mid-token;
    // stacked they get ~513px, which holds every formula in the corpus with room
    // to spare. The cost is one extra row of sheet height on the 13 skills that
    // actually author a gate — the other ~2312 show a single empty "Usable When".
    flow: "vertical",
    align: "left",
    // colSpan 2 — the header is a CSS GRID (parent carries `grid`; children get
    // `grid-span-N`), NOT a flex row. Measured the hard way: a bare nested panel
    // occupies ONE column and collapsed the two inputs to 82px/56px, and a
    // `flex: 1 0 100%` rule computed correctly but did nothing because flex sizing
    // is inert inside a grid. Spanning both columns is the CSB-native fix and gives
    // the pair a genuine full-width row.
    colSpan: 2,
    cssClass: "fud-availability-gate",
    visibilityFormula: ACTION_TYPES,
    contents: [
      build.textField("availability_formula", {
        label: "Usable When",
        size: "full-size",
        tooltip:
          "Optional formula gating whether this skill can be USED at all. Falsy = the skill still "
          + "appears in the picker but is greyed out, with \"Unavailable Reason\" shown beside it. "
          + "Blank = always usable. This is the whole-skill twin of \"Target Filter\", which gates "
          + "individual TARGETS instead; same formula language. "
          + "Example: OWN_PERSISTENT_SUMMON_COUNT >= 1",
      }),
      build.textField("availability_reason", {
        label: "Unavailable Reason",
        size: "full-size",
        visibilityFormula: REASON_VIS,
        tooltip:
          "Why the skill is unavailable, in the PLAYER's words (e.g. \"You have no Minion to "
          + "destroy\", \"Numen already active\"). Keep it under ~30 characters — it renders as a "
          + "badge beside the skill name in the picker, and a long one squeezes the name. "
          + "Also used for the pre-activate refusal notification, which needs no formula. "
          + "Blank falls back to \"Unavailable\".",
      }),
    ],
  });
}

(async () => {
  let failed = 0;
  for (const { uuid, label } of TARGETS) {
    const { doc } = await loadFromDb(uuid);
    const tree = new CsbTree(doc);

    // Idempotent rebuild: drop any previous form of this edit first.
    for (const k of [PANEL_KEY, "availability_formula", "availability_reason"]) {
      while (tree.findByKey(k)) { if (!tree.remove(k)) break; }
    }

    const hit = tree.findByKey(ANCHOR);
    if (!hit || !hit.parent) { console.error(`  x ${label}: anchor "${ANCHOR}" not found`); failed++; continue; }
    if (Array.isArray(hit.index)) { console.error(`  x ${label}: anchor is a static-table cell`); failed++; continue; }

    // Label-only rename of the neighbouring filter (key untouched).
    tree.setConfig(ANCHOR, { label: "Target Filter" });

    // The containing panel has no key, so insertChild(parentKey, ...) cannot address
    // it — splice into the located array directly, right after the anchor.
    hit.parent[hit.parentField].splice(hit.index + 1, 0, gatePanel());

    const issues = lint(tree);
    const errors = (issues ?? []).filter((i) => (i.severity ?? "error") === "error");
    if (errors.length) {
      console.error(`  x ${label}: lint FAILED`);
      for (const e of errors) console.error(`      ${e.code ?? ""} ${e.message ?? JSON.stringify(e)}`);
      failed++; continue;
    }
    const order = hit.parent[hit.parentField].map((c) => c.key || `(${c.type})`).join(" > ");
    console.log(`  ${DRY ? "[dry-run] would patch" : "OK patched"} ${label}`);
    console.log(`      lint: ${issues.length} issue(s), 0 errors`);
    console.log(`      header order: ${order}`);
    if (!DRY) {
      const patch = tree.patch({ bumpVersion: true });
      await saveToDb(uuid, patch, { note: "availability gate: own panel, Target Filter rename" });
    }
  }
  if (failed) { console.error(`\n${failed} target(s) FAILED`); process.exit(1); }
  console.log(DRY ? "\ndry-run complete" : "\ndone");
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
