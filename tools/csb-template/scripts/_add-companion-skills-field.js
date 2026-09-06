"use strict";

// Declare `companion_skills` on the live skill template.
//
// WHY. A COMPANION skill comes WITH its parent instead of being bought. Birth of
// the Cruel's "Dismiss" is the release for the Minion the parent raises, and RAW
// hands it over as part of the same Heroic Skill ("You may also destroy your
// Minion at any time"); it is a separate document only because this engine has no
// out-of-conflict entry point for an Active skill. Before this prop existed there
// was no way to express that, and the two obvious workarounds both fail:
//
//   - Embedding the child on the class actor makes it a PURCHASABLE base skill.
//     class-registry.js splits a class actor's items by prop, not by container
//     (isHeroic / isFacet / skill_type === "Spell"), and the Dismiss is
//     isHeroic:false, isFacet:false, skill_type "Active" — so it lands in
//     `cls.skills`, whose buy path checks only class membership / points /
//     max_level and never reads heroic_requirement. A level-1 Necromancer could
//     spend a Skill Point on a release for a Minion they cannot raise.
//   - Leaving it off the class actor means it is never granted at all:
//     applyBaseSkill and applyHeroic each copy exactly ONE named item.
//
// `companion_skills` closes both ends at once: class-registry withholds every
// named companion from `skills` / `heroics` / `facets`, and grantCompanions()
// copies them alongside the parent.
//
// WHY IT MUST BE DECLARED. `reloadTemplate()` prunes every undeclared prop
// (persisted `system.props['-=key'] = true`). The failure direction here is the
// nasty one — a pruned list means the companion is silently NOT granted AND
// becomes purchasable again, i.e. the exact trap the prop closes, restored with
// no error anywhere. This is the same hole that ate `availability_formula` on
// 2026-09-05; see _add-availability-gate-fields.js.
//
// PLACEMENT — its own nested panel, inserted after `availability_gate_panel`, at
// the header tail. Following that script's two hard-won layout rules:
//   * colSpan 2, because the header is a CSS GRID (parent carries `grid`,
//     children get `grid-span-N`) and a bare nested panel takes ONE column and
//     collapses its input to ~82px;
//   * its own row rather than loose in the header, so it cannot pull the
//     surrounding fields across columns.
//
// NO VISIBILITY FORMULA, deliberately. The obvious gate — show it only for
// action-type skills, as the availability panel does — would hide it on exactly
// the skill that needs it: Birth of the Cruel is `skill_type: "Passive"`. And it
// cannot be self-gated on its own emptiness: a visibility formula that references
// its OWN prop breaks CSB's compiler (a page-level SyntaxError on every load,
// with the sheet still LOOKING correct — measured 2026-09-05). So it is always
// visible, which costs one row on every skill sheet and is the honest price.
//
// GAME MUST BE CLOSED (direct LevelDB write). Idempotent: re-running removes any
// previous insertion and rebuilds it, so this file stays the single description
// of the final shape.
//
// Usage:
//   node tools/csb-template/scripts/_add-companion-skills-field.js --dry-run
//   node tools/csb-template/scripts/_add-companion-skills-field.js

const { CsbTree, build } = require("../lib/tree");
const { lint } = require("../lib/lint");
const { loadFromDb, saveToDb } = require("../lib/source");

const DRY = process.argv.includes("--dry-run");

// ONLY the live skill template, matching _add-availability-gate-fields.js.
// "_Skill Template (Copy)" (Sodp3LYHuhrZI5xO) backs 0 documents and is several
// generations stale; adding a modern field to a dead template is cargo-cult.
const TARGETS = [
  { uuid: "Item.j0F5Msw5RZ8aIB3j", label: "_Skill Template  [live, 2325 docs]" },
];

const ANCHOR = "availability_gate_panel";
const PANEL_KEY = "companion_skills_panel";
const FIELD_KEY = "companion_skills";

function companionPanel() {
  return build.panel(PANEL_KEY, {
    flow: "vertical",
    align: "left",
    colSpan: 2,
    cssClass: "fud-companion-skills",
    contents: [
      build.textField(FIELD_KEY, {
        label: "Grants Companion Skills",
        size: "full-size",
        tooltip:
          "Comma-separated NAMES of other skills on this CLASS actor that come WITH this one "
          + "instead of being bought. Each named skill is withheld from the class browser "
          + "(it can never be purchased or offered as a heroic/facet) and is copied onto the "
          + "character automatically whenever this skill is taken or levelled. "
          + "Use it for a skill whose rules text grants a second action that needs its own "
          + "document. Blank = no companions, which is almost every skill. "
          + "Example: Birth of the Cruel: Dismiss",
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
    for (const k of [PANEL_KEY, FIELD_KEY]) {
      while (tree.findByKey(k)) { if (!tree.remove(k)) break; }
    }

    const hit = tree.findByKey(ANCHOR);
    if (!hit || !hit.parent) { console.error(`  x ${label}: anchor "${ANCHOR}" not found`); failed++; continue; }
    if (Array.isArray(hit.index)) { console.error(`  x ${label}: anchor is a static-table cell`); failed++; continue; }

    hit.parent[hit.parentField].splice(hit.index + 1, 0, companionPanel());

    const issues = lint(tree);
    const errors = (issues ?? []).filter((i) => (i.severity ?? "error") === "error");
    if (errors.length) {
      console.error(`  x ${label}: lint FAILED`);
      for (const e of errors) console.error(`      ${e.code ?? ""} ${e.message ?? JSON.stringify(e)}`);
      failed++; continue;
    }

    // The declaration is the whole point — prove the key is actually reachable
    // in the rebuilt tree before writing.
    if (!tree.findByKey(FIELD_KEY)) { console.error(`  x ${label}: "${FIELD_KEY}" not present after insert`); failed++; continue; }

    const order = hit.parent[hit.parentField].map((c) => c.key || `(${c.type})`).join(" > ");
    console.log(`  ${DRY ? "[dry-run] would patch" : "OK patched"} ${label}`);
    console.log(`      lint: ${issues.length} issue(s), 0 errors`);
    console.log(`      header order: ${order}`);
    if (!DRY) {
      const patch = tree.patch({ bumpVersion: true });
      await saveToDb(uuid, patch, { note: "declare companion_skills (level-up companion-grant primitive)" });
    }
  }
  if (failed) { console.error(`\n${failed} target(s) FAILED`); process.exit(1); }
  console.log(DRY ? "\ndry-run complete" : "\ndone");
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
