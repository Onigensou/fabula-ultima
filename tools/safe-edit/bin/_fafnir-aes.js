// Two new AEs in the shared Debuff container (Item.XVOWOq9oUmEECGrU), which is
// what every `ae_template_ref` resolves against.
// Run from tools/safe-edit; --apply to write.
//
//  1. Deadly Temptation — the Succubus's Charmed RIDER. A rename-and-reskin of
//     Fafnir's "Draconic Domination" (MHPx2Q1ZVMeDJD4p), which is the shipped
//     implementation of exactly this rule. Two changes do the work:
//       disable_action_intent "aid, neutral" — strips every non-hostile option
//       allegiance_override  "ally:enemy"    — so the hostile ones now point at
//                                              the victim's own party
//     `riderOf: "Charmed"` ties its lifetime to the Charmed status, so curing
//     the Charm takes the compulsion with it.
//
//     Per the user's pick this rides the UNIVERSAL Charmed AE rather than a
//     facsimile, so player `condition_charm` IM/RS and normal cures still work.
//
//  2. Lance Spent — an invisible once-per-conflict marker for Hilde-Fafnir's
//     Lance of Ruin. `lifetimeMode: "persistent_counter"` (the shipped idiom
//     for a tracker AE — Drakoza's Fury uses it) so nothing reaps it mid-fight
//     and `isBuffOrDebuffAE` never classifies it as a cleansable debuff. It
//     still goes at battle end with every other transient AE, which is what
//     re-arms the Lance for the next fight. The action pattern gates on
//     `self_lacks_status`. A cooldown could NOT do this job — an
//     `action_pattern_cooldown` is inert on a priority-exclusive row, which is
//     exactly what Lance of Ruin has to be.
const { getByKey } = require("../lib/db");
const { IDS, AE_CONTAINER, ICON } = require("./_fafnir-lib");
const { run } = require("./_fafnir-util");

const aek = (ae) => `!items.effects!${AE_CONTAINER}.${ae}`;

// Mirrors the shape of every other row in the container: dfreds flags so the
// Convenient Effects UI lists it, statuscounter so charges render.
const ceFlags = (slug, extra = {}) => ({
  "dfreds-convenient-effects": {
    ceEffectId: `ce-${slug}`, isConvenient: true, isBackup: false,
    isTemporary: false, isViewable: true, isDynamic: false,
  },
  statuscounter: { config: { multiplyEffect: true, type: "default" }, value: 1, visible: false },
  "custom-system-builder": {
    isPredefined: true, originalParentId: AE_CONTAINER,
    originalId: extra.id, originalUuid: `Item.${AE_CONTAINER}.ActiveEffect.${extra.id}`,
    isFromTemplate: false,
  },
  "fabula-ultima-companion": extra.fu ?? {},
});

run(async ({ changes }) => {
  const container = await getByKey("items", `!items!${AE_CONTAINER}`);
  if (!container) throw new Error("missing Debuff AE container");
  const donor = await getByKey("items", aek("MHPx2Q1ZVMeDJD4p"));
  if (!donor) throw new Error("missing Draconic Domination donor AE");

  // ── Deadly Temptation ───────────────────────────────────────────────────
  const tempt = JSON.parse(JSON.stringify(donor));
  tempt._id = IDS.AE_TEMPT;
  tempt.name = "Deadly Temptation";
  tempt.img = ICON.charm;
  tempt.icon = ICON.charm;
  tempt.statuses = [];
  tempt.description = "<p>On your turn, you must spend your action to perform a harmful action against an ally.</p>";
  tempt.duration = { rounds: 3, startTime: null, seconds: null, turns: null, startRound: null, startTurn: null, combat: null };
  tempt.changes = [
    { key: "disable_action_intent", value: "aid, neutral", mode: 5, priority: 0 },
    { key: "allegiance_override", value: "ally:enemy", mode: 5, priority: 0 },
  ];
  tempt.flags = ceFlags("deadly-temptation", { id: IDS.AE_TEMPT, fu: { riderOf: "Charmed", lifetimeMode: "" } });
  changes.push([aek(IDS.AE_TEMPT), tempt, "NEW AE — Deadly Temptation (Charmed rider, 3 rounds)"]);

  // ── Lance Spent ─────────────────────────────────────────────────────────
  const spent = JSON.parse(JSON.stringify(donor));
  spent._id = IDS.AE_SPENT;
  spent.name = "Lance Spent";
  spent.img = ICON.domin;
  spent.icon = ICON.domin;
  spent.statuses = [];
  spent.description = "<p>The Lance of Ruin has been thrown. It will not come again this battle.</p>";
  spent.duration = {};
  spent.changes = [];
  spent.transfer = false;
  spent.disabled = false;
  spent.flags = ceFlags("lance-spent", { id: IDS.AE_SPENT, fu: { crossScene: false, lifetimeMode: "persistent_counter" } });
  // Invisible: it is bookkeeping for the action pattern, not information the
  // players read off the boss's status bar.
  spent.flags["dfreds-convenient-effects"].isViewable = false;
  changes.push([aek(IDS.AE_SPENT), spent, "NEW AE — Lance Spent (persistent once-per-conflict marker)"]);

  // The container holds a string[] of AE ids; an AE written only at its own key
  // is never enumerated, and every `ae_template_ref` to it silently resolves to
  // nothing. Same trap as an inline `effects: [{...}]` on an item.
  const effects = Array.isArray(container.effects) ? [...container.effects] : [];
  for (const id of [IDS.AE_TEMPT, IDS.AE_SPENT]) if (!effects.includes(id)) effects.push(id);
  container.effects = effects;
  changes.push([`!items!${AE_CONTAINER}`, container, `container effects list ${effects.length - 2} -> ${effects.length}`]);
}, "fafnir-castle: AE library", "items");
