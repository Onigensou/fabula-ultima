// ═════════ Class skills · SKILL BLOCKS (move-engine Phase 4) — plain data, rules only (no move, no page sliders)
// Same contract as moves/sonic-katar/skills.js: a block names the logic fields of one game document; the export writes the
// migration, `export --check` proves the round trip. `aes` = embedded Active Effects by name (changes + transfer); other AEs
// on the item are left alone.
//   node tools/move-engine/bin/move-engine.js export class-skills [skill…] [--check]
const MOVE_SKILLS = {
  // Blade Adept (Weaponmaster heroic, also on Rogue): "While you have a melee dagger equipped: +1 DEF and M.DEF, you can attack
  // flying creatures with it, and it counts as a brawling, sword and thrown weapon for your skills and effects."
  // One AE (the name Keren's live flying-reach AE already has, 2026-11-22 session, so that copy is updated in place):
  //   +1 DEF / M.DEF   aeEquippedWhen gate on the equipped melee dagger (0 without one)
  //   counts as        weapon_category_alias (weapon-alias.js): HAS_WEAPON_CATEGORY_* / USED_WEAPON_CATEGORY_IS_* / aeEquippedWhen
  //   flying reach     can_target_flying_with "dagger"
  blade_adept: {
    doc: { id: "OM63d9oT3OOOtRdr", name: "Blade Adept" },
    props: {},
    aes: [
      { name: "Blade Adept", transfer: true, changes: [
        { key: "bonus_defense", mode: 2, value: "aeEquippedWhen(\"melee_dagger\", \"1\")", priority: 20 },
        { key: "bonus_magic_defense", mode: 2, value: "aeEquippedWhen(\"melee_dagger\", \"1\")", priority: 20 },
        { key: "weapon_category_alias", mode: 0, value: "melee_dagger: brawling, sword, thrown", priority: 20 },
        { key: "can_target_flying_with", mode: 5, value: "dagger", priority: 20 },
      ] },
    ],
  },
};
if (typeof module !== "undefined" && module.exports) module.exports = MOVE_SKILLS;
