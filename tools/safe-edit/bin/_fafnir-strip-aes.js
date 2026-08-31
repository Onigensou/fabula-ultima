// Two marker AEs in the shared Debuff container (Item.XVOWOq9oUmEECGrU), for the
// Fafnir Castle Imp's Strip Armor / Strip Weapon.
// Run from tools/safe-edit; --apply to write.
//
// These carry NO `changes`. The mechanical loss is done by the `hide_item`
// effect, which takes the gear off the actor and vanishes it — the DEF/damage
// the item was granting goes with it, through the normal equip path. An AE that
// ALSO subtracted DEF would double-count.
//
// What they are for is the two things hide_item cannot do by itself:
//
//  1. TELL THE PLAYER. The item is gone from the sheet, so without a chip the
//     only evidence is a number that quietly moved. The icons are DEF DOWN /
//     ATK DOWN because that is what the loss actually costs you.
//
//  2. LET THE AI SEE ITS OWN WORK. The Imp's action pattern gates Strip on
//     `enemy_lacks_status` and aims it with `status_avoid`, so it works through
//     the party one victim at a time instead of stripping the same PC twice;
//     Prank then uses `status_focus` to land on somebody it has already robbed.
//     There is no "does this creature still have armour" condition and these
//     markers are the standing-in state.
//
// `lifetimeMode: "persistent_counter"` — the shipped idiom for a tracker AE
// (Lance Spent, Drakoza's Fury). Two reasons it matters here rather than a
// rounds duration:
//   - nothing reaps it mid-fight, so the chip lasts exactly as long as the
//     theft does (hide_item's own lifetime is "until the battle ends"), and
//   - `isBuffOrDebuffAE` never classifies it as a cleansable debuff. A Cleanse
//     that removed the chip but not the theft would make the sheet lie about
//     what the character is wearing.
// It still goes at battle end with every other transient AE — the same moment
// battle-end-cleanup restores the hidden items. The two stay in step.
const { getByKey } = require("../lib/db");
const { IDS, AE_CONTAINER, ICON } = require("./_fafnir-lib");
const { run } = require("./_fafnir-util");

const aek = (ae) => `!items.effects!${AE_CONTAINER}.${ae}`;

const ceFlags = (slug, id) => ({
  "dfreds-convenient-effects": {
    ceEffectId: `ce-${slug}`, isConvenient: true, isBackup: false,
    isTemporary: false, isViewable: true, isDynamic: false,
  },
  statuscounter: { config: { multiplyEffect: true, type: "default" }, value: 1, visible: false },
  "custom-system-builder": {
    isPredefined: true, originalParentId: AE_CONTAINER,
    originalId: id, originalUuid: `Item.${AE_CONTAINER}.ActiveEffect.${id}`,
    isFromTemplate: false,
  },
  "fabula-ultima-companion": { crossScene: false, lifetimeMode: "persistent_counter" },
});

function marker(donor, id, name, img, description) {
  const ae = JSON.parse(JSON.stringify(donor));
  ae._id = id;
  ae.name = name;
  ae.img = img;
  ae.icon = img;
  // No `statuses`: these are not core status conditions and must not collide
  // with a status id the rest of the system reasons about.
  ae.statuses = [];
  ae.description = description;
  ae.duration = {};
  ae.changes = [];
  ae.transfer = false;
  ae.disabled = false;
  ae.flags = ceFlags(name.toLowerCase().replace(/\s+/g, "-"), id);
  return ae;
}

run(async ({ changes }) => {
  const container = await getByKey("items", `!items!${AE_CONTAINER}`);
  if (!container) throw new Error("missing Debuff AE container");
  // Lance Spent is the closest shipped shape: a persistent, changes-free marker
  // already living in this container.
  const donor = await getByKey("items", aek(IDS.AE_SPENT));
  if (!donor) throw new Error("missing Lance Spent donor AE");

  changes.push([aek(IDS.AE_ARMOR), marker(
    donor, IDS.AE_ARMOR, "Armor Stripped", ICON.defdown,
    "<p>Your armor has been taken. It is gone from your inventory until this battle ends.</p>",
  ), "NEW AE — Armor Stripped (Imp marker)"]);

  changes.push([aek(IDS.AE_WEAPON), marker(
    donor, IDS.AE_WEAPON, "Weapon Stripped", ICON.atkdown,
    "<p>Your weapon has been taken. It is gone from your inventory until this battle ends.</p>",
  ), "NEW AE — Weapon Stripped (Imp marker)"]);

  // The container holds a string[] of AE ids; an AE written only at its own key
  // is never enumerated, and every `ae_template_ref` to it silently resolves to
  // nothing.
  const effects = Array.isArray(container.effects) ? [...container.effects] : [];
  const before = effects.length;
  for (const id of [IDS.AE_ARMOR, IDS.AE_WEAPON]) if (!effects.includes(id)) effects.push(id);
  container.effects = effects;
  changes.push([`!items!${AE_CONTAINER}`, container, `container effects list ${before} -> ${effects.length}`]);
}, "fafnir-castle: Strip marker AEs", "items");
