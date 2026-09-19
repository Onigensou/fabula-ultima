// Hilde-Fafnir benchmark (2026-09-20) — the one new AE it needs, in the shared
// Debuff container (Item.XVOWOq9oUmEECGrU) every `ae_template_ref` resolves
// against. Run from tools/safe-edit; --apply to write. Run BEFORE
// _hilde-benchmark.js, whose Reinslaughter applies it.
//
// Culling — an invisible self-marker Reinslaughter stamps on Hilde-Fafnir.
// Zero Trigger: Contempt ignores Crisis entries and KOs while she carries it,
// which is how "her Zero Power does not feed her own gauge" is expressed: the
// Crisis / defeat ledger events carry no source skill, so the gate has to be a
// state on the reactor. Cloned from Lance Spent (same invisible bookkeeping
// shape) with ONE deliberate difference: NO `persistent_counter` lifetime. The
// default mode ticks at the start of the applier's turn, and the row seeds 1
// charge, so the marker clears the moment her next turn begins.
const { getByKey } = require("../lib/db");
const { IDS, AE_CONTAINER, ICON } = require("./_fafnir-lib");
const { run } = require("./_fafnir-util");

const aek = (ae) => `!items.effects!${AE_CONTAINER}.${ae}`;

run(async ({ changes }) => {
  const container = await getByKey("items", `!items!${AE_CONTAINER}`);
  if (!container) throw new Error("missing Debuff AE container");
  const donor = await getByKey("items", aek(IDS.AE_SPENT));
  if (!donor) throw new Error("missing Lance Spent donor AE");

  const cull = JSON.parse(JSON.stringify(donor));
  cull._id = IDS.AE_CULLING;
  cull.name = "Culling";
  cull.img = ICON.zeropower;
  cull.icon = ICON.zeropower;
  cull.description = "<p>Hilde-Fafnir is unleashing Reinslaughter. What falls to it does not feed Contempt.</p>";
  cull.duration = {};
  cull.changes = [];
  const ce = cull.flags["dfreds-convenient-effects"];
  ce.ceEffectId = "ce-culling";
  ce.isViewable = false;
  const csb = cull.flags["custom-system-builder"];
  csb.originalId = IDS.AE_CULLING;
  csb.originalUuid = `Item.${AE_CONTAINER}.ActiveEffect.${IDS.AE_CULLING}`;
  cull.flags["fabula-ultima-companion"] = { crossScene: false };
  changes.push([aek(IDS.AE_CULLING), cull, "NEW AE — Culling (Reinslaughter self-marker, 1 turn)"]);

  const effects = Array.isArray(container.effects) ? [...container.effects] : [];
  if (!effects.includes(IDS.AE_CULLING)) effects.push(IDS.AE_CULLING);
  container.effects = effects;
  changes.push([`!items!${AE_CONTAINER}`, container, `container effects list -> ${effects.length}`]);
}, "hilde-fafnir benchmark: Culling AE", "items");
