// ⭐️ Fafnir two-phase AI (2026-09-20) — the one new AE it needs, in the shared
// Debuff container (Item.XVOWOq9oUmEECGrU) every `ae_template_ref` resolves
// against. Run from tools/safe-edit; --apply to write. Run BEFORE
// _fafnir-ai.js, whose Storm Gathering passive applies it.
//
// Storm Gathering — the RECOVERY-PHASE marker. Fafnir's whole AI hangs off it:
// Storm Calm and Summon Elemental Drake gate on `self_has_status: Storm
// Gathering` at priority 9/10, which makes their window exclusive, so while she
// carries it she can pick nothing else.
//
// Cloned from Lance Spent (same invisible-bookkeeping shape, and it already
// carries the lifetimeMode this needs) with TWO deliberate differences:
//
//  1. `lifetimeMode: "persistent_counter"` is KEPT, not replaced. The phase must
//     NOT expire on a timer. Every turn-ticked mode counts APPLIER or BEARER
//     turns, and `tickDirectorAEsForApplier` runs at every TURN_START with no
//     activation gate — so on a 4-activation champion a 2-charge marker would be
//     gone in half a round. `round_end` is worse: it is swept at the end of the
//     round it was applied in, which is a partial round, not a phase.
//     The phase ends on an MP THRESHOLD instead (see _fafnir-ai.js): enter below
//     100 MP, leave at 300. That hysteresis is what makes it a phase rather than
//     a flicker, and it is independent of her activation count.
//  2. VIEWABLE. Lance Spent is invisible bookkeeping; this one is a tell. The
//     party is meant to SEE that she has gone defensive — that is the window the
//     fight is built around.
const { getByKey } = require("../lib/db");
const { run } = require("./_fafnir-util");

const AE_CONTAINER = "XVOWOq9oUmEECGrU";
const AE_DONOR = "3THoUX00A2aDDmrZ";          // Lance Spent
const AE_STORM = "StormGather01AE0";
const ICON = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Skill%20Icon/Epic%207/show%20-%202025-07-20T213946.309.png";

const aek = (ae) => "!items.effects!" + AE_CONTAINER + "." + ae;

run(async ({ changes }) => {
  const container = await getByKey("items", "!items!" + AE_CONTAINER);
  if (!container) throw new Error("missing Debuff AE container");
  const donor = await getByKey("items", aek(AE_DONOR));
  if (!donor) throw new Error("missing Lance Spent donor AE");

  const storm = JSON.parse(JSON.stringify(donor));
  storm._id = AE_STORM;
  storm.name = "Storm Gathering";
  storm.img = ICON;
  storm.icon = ICON;
  storm.description = "<p>Fafnir has spent her magic and withdrawn to gather the storm. "
    + "She will not press the attack until it is hers again.</p>";
  storm.duration = {};
  storm.changes = [];
  storm.statuses = [];
  storm.system = { tags: [] };

  const ce = storm.flags["dfreds-convenient-effects"];
  ce.ceEffectId = "ce-storm-gathering";
  ce.isViewable = true;          // a tell, not bookkeeping — see header
  ce.isTemporary = false;

  const csb = storm.flags["custom-system-builder"];
  csb.originalId = AE_STORM;
  csb.originalUuid = "Item." + AE_CONTAINER + ".ActiveEffect." + AE_STORM;

  // persistent_counter: never turn-ticked, and invisible to Dispel/Cleanse tag
  // sweeps unless a row opts in with include_persistent — which is correct, a
  // boss's phase is not a debuff the party gets to strip.
  storm.flags["fabula-ultima-companion"] = { crossScene: false, lifetimeMode: "persistent_counter" };

  if (storm.flags.statuscounter) storm.flags.statuscounter.visible = false;
  if (storm._stats) { storm._stats.createdTime = null; storm._stats.modifiedTime = null; storm._stats.duplicateSource = null; }

  const blob = JSON.stringify(storm);
  if (blob.includes(donor.name)) throw new Error("donor name survives in Storm Gathering");
  if (blob.includes(AE_DONOR)) throw new Error("donor id survives in Storm Gathering");

  changes.push([aek(AE_STORM), storm, "NEW AE — Storm Gathering (Fafnir recovery-phase marker, MP-gated)"]);

  const effects = Array.isArray(container.effects) ? [...container.effects] : [];
  if (!effects.includes(AE_STORM)) effects.push(AE_STORM);
  container.effects = effects;
  changes.push(["!items!" + AE_CONTAINER, container, "container effects list -> " + effects.length]);
}, "fafnir two-phase AI: Storm Gathering AE", "items");
