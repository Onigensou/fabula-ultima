"use strict";

// Declare `skill_free_action` + `skill_skip_action_card` on the live skill template.
//
// WHY. Two separate things a skill may want, which the engine could only express
// as hard-coded special cases before this:
//
//   skill_free_action     — using it does NOT spend the turn. The FSM already has
//                           this path: RESOLVE sets `ctx.returnToMenuAfterCleanup`
//                           and CLEANUP routes back to DECLARE instead of TURN_END
//                           (states.js:224). But it was reachable ONLY via two
//                           hard-coded conditions in state-handlers.js:6751-6756 —
//                           `ar.equipmentFree` (the free Equipment transform) and
//                           `ar.kind === "Domination"`. Any third case meant a
//                           third hard-coded disjunct. This makes it authorable.
//
//   skill_skip_action_card — no battlefield Action Card; a plain confirm dialog,
//                           then straight to RESOLVE. For a self-contained action
//                           with no targets and no damage, the card is pure
//                           ceremony: "click Dismiss -> Confirm -> it happens".
//
// They are INDEPENDENT on purpose. "Free" without "skip card" is a normal action
// that happens not to end your turn (the Equipment transform's shape). "Skip card"
// without "free" is a one-click action that still costs your turn. Birth of the
// Cruel's Dismiss wants both.
//
// ⚠ THE COST OF SKIPPING THE CARD, stated because it is not obvious: the Action
// Card is the ONLY place several player affordances exist. Skip it and they are
// gone, silently. So the flag is a REQUEST, not a command — CONFIRM refuses it
// whenever skipping would cost the player something:
//   * a live REACTION pill (scanned into cardReactions at state-handlers.js:4841
//     and handed to postActionCard — there is nowhere else to render them);
//   * an action with a ROLL, because the accuracy/damage preview AND the
//     Fabula-Point INVOKE offer live on the card. Invoke is available to every PC
//     (invoke-core: no npc_rank -> "full"), so skipping a rolled action would take
//     a player's invoke away without a word.
//   * a summon's armed auto-confirm, which is itself a card affordance.
// It therefore takes effect only on a self-contained, roll-less action — which is
// the only shape it was ever meant for.
//
// WHY DECLARED. `reloadTemplate()` prunes every undeclared prop, and both failures
// are silent: a pruned `skill_free_action` quietly starts costing the turn, and a
// pruned `skill_skip_action_card` quietly restores the card. Same hole that ate
// `availability_formula` on 2026-09-05.
//
// PLACEMENT — its own nested panel after `companion_skills_panel`, colSpan 2
// (the header is a CSS grid; a bare nested panel takes one column and collapses
// its contents). Gated on ACTION types: a Passive never takes an action, so the
// pair is meaningless there. This is the OPPOSITE call from companion_skills,
// which is deliberately ungated because Birth of the Cruel — the one skill that
// needs it — is itself a Passive.
//
// GAME MUST BE CLOSED. Idempotent: re-running removes any previous insertion and
// rebuilds it, so this file stays the single description of the final shape.
//
// Usage:
//   node tools/csb-template/scripts/_add-quick-action-fields.js --dry-run
//   node tools/csb-template/scripts/_add-quick-action-fields.js

const { CsbTree, build } = require("../lib/tree");
const { lint } = require("../lib/lint");
const { loadFromDb, saveToDb } = require("../lib/source");

const DRY = process.argv.includes("--dry-run");

const TARGETS = [
  { uuid: "Item.j0F5Msw5RZ8aIB3j", label: "_Skill Template  [live, 2325 docs]" },
];

const ANCHOR = "companion_skills_panel";
const PANEL_KEY = "quick_action_panel";
const FREE_KEY = "skill_free_action";
const SKIP_KEY = "skill_skip_action_card";

const ACTION_TYPES =
  "or(or(equalText(skill_type, 'Active'), equalText(skill_type, 'Spell')), equalText(skill_type, 'Attack'))";

function quickActionPanel() {
  return build.panel(PANEL_KEY, {
    flow: "horizontal",
    align: "left",
    colSpan: 2,
    cssClass: "fud-quick-action",
    visibilityFormula: ACTION_TYPES,
    contents: [
      build.checkbox(FREE_KEY, {
        label: "Does Not Spend Turn",
        tooltip:
          "CHECK for an action that can be used WITHOUT using up the turn: it resolves, then the "
          + "action menu re-opens for the same character with their turn still intact. Use it for a "
          + "release / toggle / bookkeeping action the rules grant \"at any time\", not for anything "
          + "that deals damage or would otherwise be a free extra attack. Resource costs are still "
          + "paid normally — this changes the ACTION economy only.",
      }),
      build.checkbox(SKIP_KEY, {
        label: "Skip Action Card",
        tooltip:
          "CHECK to skip the battlefield Action Card: the player gets a plain confirm dialog and the "
          + "skill resolves straight away. For a self-contained action with no target picking and no "
          + "damage to preview, the card is pure ceremony. The engine treats this as a REQUEST, not "
          + "a command, and posts the full card anyway whenever skipping it would cost the player "
          + "something only the card offers: a live reaction pill, or an action with a ROLL (whose "
          + "accuracy/damage preview and Fabula-Point invoke live on the card). So it takes effect "
          + "only on a self-contained, roll-less action.",
      }),
    ],
  });
}

(async () => {
  let failed = 0;
  for (const { uuid, label } of TARGETS) {
    const { doc } = await loadFromDb(uuid);
    const tree = new CsbTree(doc);

    for (const k of [PANEL_KEY, FREE_KEY, SKIP_KEY]) {
      while (tree.findByKey(k)) { if (!tree.remove(k)) break; }
    }

    const hit = tree.findByKey(ANCHOR);
    if (!hit || !hit.parent) { console.error(`  x ${label}: anchor "${ANCHOR}" not found`); failed++; continue; }
    if (Array.isArray(hit.index)) { console.error(`  x ${label}: anchor is a static-table cell`); failed++; continue; }

    hit.parent[hit.parentField].splice(hit.index + 1, 0, quickActionPanel());

    const issues = lint(tree);
    const errors = (issues ?? []).filter((i) => (i.severity ?? "error") === "error");
    if (errors.length) {
      console.error(`  x ${label}: lint FAILED`);
      for (const e of errors) console.error(`      ${e.code ?? ""} ${e.message ?? JSON.stringify(e)}`);
      failed++; continue;
    }
    for (const k of [FREE_KEY, SKIP_KEY]) {
      if (!tree.findByKey(k)) { console.error(`  x ${label}: "${k}" not present after insert`); failed++; }
    }

    const order = hit.parent[hit.parentField].map((c) => c.key || `(${c.type})`).join(" > ");
    console.log(`  ${DRY ? "[dry-run] would patch" : "OK patched"} ${label}`);
    console.log(`      lint: ${issues.length} issue(s), 0 errors`);
    console.log(`      header order: ${order}`);
    if (!DRY) {
      const patch = tree.patch({ bumpVersion: true });
      await saveToDb(uuid, patch, { note: "declare skill_free_action + skill_skip_action_card (quick-action primitive)" });
    }
  }
  if (failed) { console.error(`\n${failed} target(s) FAILED`); process.exit(1); }
  console.log(DRY ? "\ndry-run complete" : "\ndone");
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
