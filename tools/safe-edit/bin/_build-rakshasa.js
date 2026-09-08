// Rakshasa — L40 elite, Demon, Valley of the Dragon event encounter.
// The weapon-axis counterpart to Asura's element axis: Asura punishes you for
// NOT varying your element, Rakshasa punishes you for REPEATING a weapon.
//
// Design doc: modules/fabula-ultima-companion/docs/rakshasa-design-proposal.md
// Sim (paper design, pre-build): tools/mindscape/specs/rakshasa.json
//
// Run from tools/safe-edit; --apply to write.
//
// THE SHAPE. Four activations resolve Shift -> Strike -> Shift -> Strike. Form
// Shift costs an activation and announces the next attack; the attack is worth
// double because of it, and CONSUMES the stance, which is what forces the next
// activation back onto Form Shift. That cycle is emergent from the two gates,
// not scripted — exactly as it will read at the table.
const {
  FOLDER_FAFNIR, DONOR_ACTOR, DONOR_ATTACK, DONOR_SPELL_ACTOR, DONOR_SPELL, DONOR_PASSIVE,
  link, L, bullets, trig, ICON,
} = require("./_fafnir-lib");
const { blankActor, makeSkill, run } = require("./_fafnir-util");
const { getByKey } = require("../lib/db");

// "Current Dungeon" — the same folder Asura sits in.
const FOLDER = "4gMC1IxdJlF59BSi";

const IDS = {
  RK:          "Rk5haXsaDemonAAA",
  RK_SHIFT:    "RkFormShift01AAA",
  // ⚠ The ID constants keep their original spelling — an id is opaque and
  // renaming it would orphan the document. The ACTION NAMES are Saber and Mace.
  RK_SABER:    "RkExecuteSword01",
  RK_MACE:     "RkCrippleFlail01",
  RK_CHAKRAM:  "RkChakramThrow01",
  RK_RAIN:     "RkRainOfArrows01",
  RK_DEVOUR:   "RkDevourManEat01",
  RK_ADAPT:    "RkAdaptiveDef001",
  // Crisis kit — the dual-arm phase.
  RK_SHIFT2:   "RkFormShiftCris1",
  RK_VOLLEY:   "RkExecVolley0001",
  RK_ORBIT:    "RkRendingOrbit01",
  RK_VERDICT:  "RkSeveringVerd01",
  AE_C_SB:     "RkAeComboSwdBow1",
  AE_C_FT:     "RkAeComboFlaThr1",
  AE_C_SF:     "RkAeComboSwdFla1",
  AE_SWORD:    "RkAeStanceSword1",
  AE_BOW:      "RkAeStanceBow001",
  AE_THROW:    "RkAeStanceThrow1",
  AE_FLAIL:    "RkAeStanceFlail1",
  AE_CRIPPLED: "RkAeCrippledDef1",
};
const A = IDS.RK;

// ⚠ PLACEHOLDER ART — follows the Bestiary naming convention
// (Asura_Standard.png), but nobody has confirmed this file exists on the Forge.
// If the token renders blank, that is this line, not the build.
const ART = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Beastiary/Rakshasa_Standard.png";
const SCALE = 2.0;   // Asura is 2.25; Rakshasa reads slightly smaller. Eyeball live.

const ik = (i) => `!actors.items!${A}.${i}`;
const aek = (i, ae) => `!actors.items.effects!${A}.${i}.${ae}`;

// ── content links ──────────────────────────────────────────────────────────
const L_EXECUTE = link("JournalEntry.KHCaZjNmClkp7yfM", "Execute");
const L_CRIPPLE = link("JournalEntry.qXBYN6c9FMZzmS2n", "Cripple");
const L_MULTI   = link("JournalEntry.Gm3upxgpUVoLSK5u", "Multi (3)");
const L_OVERFLOW = link("JournalEntry.NUaxIAIPUu5Qnk8l", "Overflow");
const L_BLEED   = link("JournalEntry.GePNxftPupElcCWp", "Bleed");
const L_CRISIS  = link("JournalEntry.GJevbCPM8cffm1QM", "Crisis");
const L_DRAIN   = link("JournalEntry.CRPjA4dHUYLSAh0M", "Drain");

// ── Action text ────────────────────────────────────────────────────────────
// These are TOOLTIPS. Informative first, flavour second — one plain sentence of
// what the action looks like, then exactly what it does. Not poetry: a player
// reading this mid-turn needs the rule, not an image.
//
// Keywords ride as a leading bullet list and are NEVER restated in the body —
// the link carries the rules text.
const DESC = {
  shift:
    "<p>The Rakshasa changes its form:</p>" +
    bullets("Sword", "Bow", "Throwing", "Flail") +
    "<p>Then recovers a small amount of MP.</p>",
  saber:
    bullets(L_EXECUTE) +
    "<p>Perform a single downward cut. Deal <strong>heavy</strong>&nbsp;" +
    `${L.physical}&nbsp;damage to one creature. Only usable in Sword form.</p>`,
  mace:
    bullets(L_CRIPPLE) +
    "<p>Attack with a Pollachi. Deal <strong>heavy</strong>&nbsp;" +
    `${L.physical}&nbsp;damage to one creature and halve its Defence until the effect is ` +
    "removed. Only usable in Flail form.</p>",
  chakram:
    bullets(L_MULTI) +
    "<p>Throw a chakram that bounces between three enemies. Deal <strong>heavy</strong>&nbsp;" +
    `${L.physical}&nbsp;damage and inflict ${L_BLEED}. Only usable in Throwing form.</p>`,
  rain:
    bullets(L_OVERFLOW) +
    "<p>Shoot multiple volleys into the sky which fall down on the enemy. " +
    `Deal <strong>heavy</strong>&nbsp;${L.physical}&nbsp;damage to all enemies. ` +
    "Only usable in Bow form.</p>",
  devour:
    bullets(L_DRAIN) +
    "<p>It stops fighting for a moment and eats. This attack cannot miss. Deal " +
    `<strong>moderate</strong>&nbsp;${L.physical}&nbsp;damage to one creature and recover ` +
    "HP equal to half the damage dealt.</p>",
  adapt:
    bullets(trig("the Rakshasa is attacked with a weapon")) +
    "<p>Lower the efficiency of the triggering weapon type, but increase efficiency " +
    "against other weapons.</p>",
  shift2:
    "<p>The Rakshasa arms two weapons at once:</p>" +
    bullets("Sword and Bow", "Flail and Throwing", "Sword and Flail") +
    "<p>Then recovers a small amount of MP.</p>",
  volley:
    bullets(L_EXECUTE, L_OVERFLOW) +
    "<p>The Rakshasa looses a volley and cuts down whatever is still standing. " +
    `Deal <strong>heavy</strong>&nbsp;${L.physical}&nbsp;damage to all enemies. ` +
    "Only usable while armed with Sword and Bow.</p>",
  orbit:
    bullets(L_CRIPPLE, L_MULTI) +
    "<p>Chakrams orbit the Rakshasa on their chains and tear outward. " +
    `Deal <strong>heavy</strong>&nbsp;${L.physical}&nbsp;damage to three creatures and inflict ${L_BLEED}. ` +
    "Only usable while armed with Flail and Throwing.</p>",
  verdict:
    "<p>The Rakshasa raises both arms and brings them down as one. " +
    `Deal <strong>colossal</strong>&nbsp;${L.physical}&nbsp;damage to one creature. ` +
    "Only usable while armed with Sword and Flail.</p>",
};

// Bestiary voice, unlinked prose, as approved.
const STUDY =
  "A man-eating demon that lives off the mountain's leavings — travellers who strayed, " +
  "and whatever Fafnir did not finish. It does not hunt so much as collect: bodies, and " +
  "the weapons found on them. Every arm holds something somebody died holding.";

// The four stance AEs. Named exactly as the action_pattern `self_has_status`
// strings and as Form Shift's draw pool — a rename in one place and not the
// other silently stops the whole cycle.
const STANCES = [
  { id: IDS.AE_SWORD, name: "Sword Stance",    blurb: "A long straight blade, held low." },
  { id: IDS.AE_BOW,   name: "Bow Stance",      blurb: "A recurve strung with something pale." },
  { id: IDS.AE_THROW, name: "Throwing Stance", blurb: "Three rings, spinning on three fingers." },
  { id: IDS.AE_FLAIL, name: "Flail Stance",    blurb: "A haft, a chain, and a weight." },
];

// The Crisis combos. Only these THREE pairings exist — the other three possible
// pairs are never drawn, so there is no undefined combination to design a
// fallback for.
//
// ⚠ The action pattern cannot express "holds Sword AND Bow": its conditions take
// ONE status string and there is no formula/AND form. So a combo is a single AE
// naming the pair, not two stance AEs an attack tests for. Same fiction,
// expressible mechanics.
const COMBOS = [
  { id: IDS.AE_C_SB, name: "Sword and Bow Stance",
    blurb: "A blade in two hands, a drawn bow in the other two." },
  { id: IDS.AE_C_FT, name: "Flail and Throwing Stance",
    blurb: "Chains in two hands, rings spinning in the other two." },
  { id: IDS.AE_C_SF, name: "Sword and Flail Stance",
    blurb: "Every arm holding something heavy. Nothing left in reserve." },
];

// Every attack spends the stance that permitted it. Authored once — four copies
// of a removal row is four chances to typo the AE name.
//   ⚠ include_persistent is REQUIRED. selectAEsOnActor skips persistent_counter
//   AEs without it, so the removal is a SILENT no-op and the monster never
//   re-shifts. This is the exact omission that nearly TPK'd the party on Asura.
const consumeStance = (stanceName) => ({
  "9": {
    $deleted: false, effect_kind: "remove_ae", effect_label: "spend_stance",
    ae_template_ref: stanceName, target_ref: "self",
    include_persistent: "true", count: "1",
  },
});

// The combo twin. Separate label so a combo attack cannot accidentally spend a
// single stance, or vice versa.
const consumeCombo = (comboName) => ({
  "9": {
    $deleted: false, effect_kind: "remove_ae", effect_label: "spend_combo",
    ae_template_ref: comboName, target_ref: "self",
    include_persistent: "true", count: "1",
  },
});

run(async ({ changes, deletes }) => {
  const donorActor   = await getByKey("actors", `!actors!${DONOR_ACTOR}`);
  const donorAttack  = await getByKey("actors", `!actors.items!${DONOR_ACTOR}.${DONOR_ATTACK}`);
  const donorPassive = await getByKey("actors", `!actors.items!${DONOR_ACTOR}.${DONOR_PASSIVE}`);
  const donorSpell   = await getByKey("actors", `!actors.items!${DONOR_SPELL_ACTOR}.${DONOR_SPELL}`);
  if (!donorActor || !donorAttack || !donorPassive || !donorSpell) {
    throw new Error("donor documents missing — check _fafnir-lib IDs");
  }
  const skill = (src, id, name, img, props) => makeSkill(src, A, id, name, img, props);

  // ── Form Shift ───────────────────────────────────────────────────────────
  // ONE row draws from a 4-name pool with ae_pool_skip_existing, which draws
  // WITHOUT replacement — so it can never redraw the form it is already in.
  // Four gated per-form items would need four conditions and four priorities to
  // fake the same thing, and would still repeat.
  const shift = skill(donorSpell, IDS.RK_SHIFT, "Form Shift", ICON.active, {
    skill_type: "Active", skill_target: "Self", skill_range: "-",
    rolled_atr1: "-", rolled_atr2: "-",
    check_bonus: "0", damage_bonus: "", type_damage: "", defense_target_type: "def",
    isCheck: false, isOffensiveSpell: false, isReaction: false,
    cost: "-", duration: "Scene", details_roller: "Show",
    action_keywords: "", description: DESC.shift,
    on_activate_effect_ref: "fs_draw",
    effect_table: {
      "0": {
        $deleted: false, effect_kind: "apply_ae", effect_label: "fs_draw",
        ae_name_pool: STANCES.map((s) => s.name).join(","),
        ae_pool_skip_existing: "1",
        target_ref: "self", ae_duplicate_mode: "replace",
        chain_steps: "fs_mp",
      },
      "1": {
        $deleted: false, effect_kind: "grant", effect_label: "fs_mp",
        grant_resource: "mp", grant_amount: "15", target_ref: "self",
      },
    },
  });
  shift.effects = STANCES.map((s) => s.id);
  changes.push([ik(IDS.RK_SHIFT), shift,
    "NEW item — Form Shift (Active, pool draw without replacement, +15 MP)"]);

  for (const s of STANCES) {
    changes.push([aek(IDS.RK_SHIFT, s.id), {
      _id: s.id, name: s.name, img: ICON.active, icon: ICON.active,
      transfer: false, disabled: false, changes: [], statuses: [],
      description: `<p>${s.blurb}</p>`,
      duration: {}, origin: `Actor.${A}.Item.${IDS.RK_SHIFT}`,
      system: { tags: ["rakshasa_stance"] },
      // persistent_counter, or tickDirectorAEsForApplier reaps the stance at the
      // Rakshasa's very next activation — i.e. before the attack it announced.
      flags: { "fabula-ultima-companion": { crossScene: false, charges: 1, lifetimeMode: "persistent_counter" } },
    }, `NEW AE — ${s.name}`]);
  }

  // ── The four forms ───────────────────────────────────────────────────────
  // Damage sized so each strike is worth ~2 normal actions, because Form Shift
  // spent one. Execute/Cripple carry HALF that in damage_bonus and get the rest
  // from their keyword's conditional doubling (authored below, Kirin's pattern).
  const attack = (id, name, props) => skill(donorAttack, id, name, ICON.melee, {
    skill_type: "Attack", class: "NPC",
    check_bonus: "5", type_damage: "Physical", defense_target_type: "def",
    isCheck: true, isOffensiveSpell: false, details_roller: "Show",
    duration: "Instantaneous", cost: "-",
    ...props,
  });

  // Execute — 200% into a target already in Crisis. The finisher half.
  // isReaction TRUE: the doubling is a reaction row on this very item, and
  // reaction-triggerCore skips every row on an item without the flag. That one
  // field is why Kirin's identical Execute never fired.
  changes.push([ik(IDS.RK_SABER), attack(IDS.RK_SABER, "Saber", {
    skill_target: "One Creature", skill_range: "Melee",
    rolled_atr1: "MIG", rolled_atr2: "DEX", damage_bonus: "30",
    action_keywords: "execute", description: DESC.saber,
    isReaction: true,
    on_activate_effect_ref: "spend_stance",
    reaction_config_table: {
      "0": {
        $deleted: false, reaction_trigger: "creature_will_deal_damage",
        reaction_source: "self", reaction_source_skill: "Saber",
        condition_formula: "TARGET_AE_COUNT_CRISIS > 0",
        reaction_passive_mode: "force", reaction_effect_ref: "ex_double",
      },
    },
    effect_table: {
      "0": { $deleted: false, effect_kind: "adjust_damage", effect_label: "ex_double",
             damage_operation: "multiply", damage_amount: "2", damage_stage: "outgoing" },
      ...consumeStance("Sword Stance"),
    },
  }), "NEW item — Execute (Sword form, 200% vs a Crisis target)"]);

  // Cripple — 200% into a HEALTHY target. The opener half, plus a DEF debuff.
  changes.push([ik(IDS.RK_MACE), attack(IDS.RK_MACE, "Mace", {
    skill_target: "One Creature", skill_range: "Melee",
    rolled_atr1: "MIG", rolled_atr2: "MIG", damage_bonus: "28",
    action_keywords: "cripple", description: DESC.mace,
    isReaction: true,
    on_activate_effect_ref: "cr_debuff",
    reaction_config_table: {
      "0": {
        $deleted: false, reaction_trigger: "creature_will_deal_damage",
        reaction_source: "self", reaction_source_skill: "Mace",
        condition_formula: "TARGET_AE_COUNT_CRISIS == 0",
        reaction_passive_mode: "force", reaction_effect_ref: "cr_double",
      },
    },
    effect_table: {
      "0": { $deleted: false, effect_kind: "adjust_damage", effect_label: "cr_double",
             damage_operation: "multiply", damage_amount: "2", damage_stage: "outgoing" },
      "1": { $deleted: false, effect_kind: "apply_ae", effect_label: "cr_debuff",
             ae_template_ref: "Crippled", target_ref: "action_targets",
             ae_duplicate_mode: "replace", chain_steps: "spend_stance" },
      ...consumeStance("Flail Stance"),
    },
  }), "NEW item — Cripple (Flail form, 200% vs a healthy target, -DEF)"]);

  // The Cripple debuff. MULTIPLY mode on the derived `defense` prop — CSB
  // recomputes defence from the die plus modifiers, and a flat penalty would
  // land differently on every PC. `cleansable` so it can be removed.
  //   ⚠ VERIFY LIVE that CSB honours MULTIPLY on a derived prop. If it does not,
  //   the fallback is `bonus_defense` with a flat negative, and the action text
  //   must stop promising a percentage.
  changes.push([aek(IDS.RK_MACE, IDS.AE_CRIPPLED), {
    _id: IDS.AE_CRIPPLED, name: "Crippled", img: ICON.melee, icon: ICON.melee,
    transfer: false, disabled: false, statuses: [],
    description: "<p>A knee that no longer takes weight. Defence is halved.</p>",
    changes: [{ key: "defense", mode: 1, value: "0.5", priority: 20 }],
    duration: {}, origin: `Actor.${A}.Item.${IDS.RK_MACE}`,
    system: { tags: ["cleansable", "rakshasa_debuff"] },
    flags: { "fabula-ultima-companion": { crossScene: false } },
  }, "NEW AE — Crippled (DEF x0.5, cleansable)"]);

  // Chakram — Multi 3 plus Bleed. No keyword doubling, so it carries its full
  // damage in damage_bonus.
  changes.push([ik(IDS.RK_CHAKRAM), attack(IDS.RK_CHAKRAM, "Chakram", {
    skill_target: "Up to three creatures", skill_range: "Range",
    rolled_atr1: "DEX", rolled_atr2: "INS", damage_bonus: "16",
    action_keywords: "multi", description: DESC.chakram,
    isReaction: false,
    on_activate_effect_ref: "ch_bleed",
    effect_table: {
      "0": { $deleted: false, effect_kind: "apply_ae", effect_label: "ch_bleed",
             ae_template_ref: "Bleed", target_ref: "action_targets",
             ae_duplicate_mode: "replace", chain_steps: "spend_stance" },
      ...consumeStance("Throwing Stance"),
    },
  }), "NEW item — Chakram (Throwing form, Multi 3 + Bleed)"]);

  // Rain of Arrows — Overflow, all enemies. The 30 MP cost is what paces it:
  // Form Shift returns 15, so it is affordable roughly every other cycle.
  changes.push([ik(IDS.RK_RAIN), attack(IDS.RK_RAIN, "Rain of Arrows", {
    skill_target: "All Enemies", skill_range: "Range",
    rolled_atr1: "DEX", rolled_atr2: "INS", damage_bonus: "11",
    action_keywords: "overflow", cost: "30 MP", description: DESC.rain,
    isReaction: false,
    on_activate_effect_ref: "spend_stance",
    effect_table: { ...consumeStance("Bow Stance") },
  }), "NEW item — Rain of Arrows (Bow form, Overflow, 30 MP)"]);

  // Devour — the auto-hit, no-Check option. Auto-hit means damage-class null,
  // which bypasses Strike immunity: Asura's live test found ONE Strike-immune
  // enemy blanked its entire kit. Crisis-gated and on cooldown so it stays a
  // rare beat rather than competing with the Shift/Strike cycle.
  changes.push([ik(IDS.RK_DEVOUR), skill(donorSpell, IDS.RK_DEVOUR, "Devour", ICON.active, {
    skill_type: "Active", skill_target: "One Creature", skill_range: "Melee",
    rolled_atr1: "-", rolled_atr2: "-",
    check_bonus: "0", damage_bonus: "", type_damage: "", defense_target_type: "def",
    isCheck: false, isOffensiveSpell: false, isReaction: false,
    cost: "-", duration: "Instantaneous", details_roller: "Show",
    action_keywords: "", description: DESC.devour,
    on_activate_effect_ref: "dv_bite",
    effect_table: {
      "0": { $deleted: false, effect_kind: "deal_damage", effect_label: "dv_bite",
             damage_amount: "45", damage_element: "physical", damage_cause: "damage",
             target_ref: "action_targets", chain_steps: "dv_feed" },
      "1": { $deleted: false, effect_kind: "grant", effect_label: "dv_feed",
             grant_resource: "hp", grant_amount: "22", target_ref: "self" },
    },
  }), "NEW item — Devour (auto-hit, bypasses Strike immunity, self-heal)"]);

  // ── Adaptive Defense ─────────────────────────────────────────────────────
  // Two rows, one per trigger, because "it does not matter whether the attack
  // hits" is exactly the creature_hit_by_action + creature_miss_action pair.
  //
  // UNGATED. It used to carry `HAS_STATUS_CRISIS == 0` so Ten Thousand Arms
  // could take over the window at Crisis; that passive is gone (the Crisis
  // identity is now the dual-arm combo, and stacking a second escalation on top
  // of it overloads the phase). The read window therefore behaves identically
  // in both halves of the fight, which is also one less thing to explain.
  const readRow = (idx, trigger, ref) => ({
    [String(idx)]: {
      $deleted: false, reaction_trigger: trigger,
      reaction_source: "self",
      reaction_passive_mode: "force", reaction_effect_ref: ref,
    },
  });
  changes.push([ik(IDS.RK_ADAPT), skill(donorPassive, IDS.RK_ADAPT, "Adaptive Defense", ICON.passive, {
    skill_type: "Passive", skill_target: "-", skill_range: "-",
    rolled_atr1: "-", rolled_atr2: "-",
    check_bonus: "0", damage_bonus: "", type_damage: "",
    isCheck: false, isOffensiveSpell: false, isReaction: true,
    cost: "-", duration: "Scene", details_roller: "Show",
    action_keywords: "", description: DESC.adapt,
    reaction_config_table: {
      ...readRow(0, "creature_hit_by_action", "ad_read"),
      ...readRow(1, "creature_miss_action", "ad_read"),
    },
    effect_table: {
      "0": {
        $deleted: false, effect_kind: "weapon_read", effect_label: "ad_read",
        target_ref: "self",
        read_window: "4", read_curve: "25,40,60,80", read_evict: "1",
      },
    },
  }), "NEW item — Adaptive Defense (5-slot weapon-read window)"]);

  // ── Crisis: Form Shift (dual-arm) ────────────────────────────────────────
  // Same shape as the normal Form Shift, drawing from the COMBO pool instead.
  //
  // ⚠ It CLEARS the single-stance tag first. Without that, a Rakshasa holding
  // "Bow Stance" as it crosses into Crisis would hold a single AND a combo
  // stance, and Rain of Arrows would compete with the combo attack at the same
  // priority — a coin flip the player would read as the monster glitching.
  const shift2 = skill(donorSpell, IDS.RK_SHIFT2, "Form Shift (Dual)", ICON.active, {
    skill_type: "Active", skill_target: "Self", skill_range: "-",
    rolled_atr1: "-", rolled_atr2: "-",
    check_bonus: "0", damage_bonus: "", type_damage: "", defense_target_type: "def",
    isCheck: false, isOffensiveSpell: false, isReaction: false,
    cost: "-", duration: "Scene", details_roller: "Show",
    action_keywords: "", description: DESC.shift2,
    on_activate_effect_ref: "fs2_clear",
    effect_table: {
      "0": {
        $deleted: false, effect_kind: "remove_ae", effect_label: "fs2_clear",
        filter_tag: "rakshasa_stance", target_ref: "self",
        include_persistent: "true", count: "all", chain_steps: "fs2_draw",
      },
      "1": {
        $deleted: false, effect_kind: "apply_ae", effect_label: "fs2_draw",
        ae_name_pool: COMBOS.map((c) => c.name).join(","),
        ae_pool_skip_existing: "1",
        target_ref: "self", ae_duplicate_mode: "replace",
        chain_steps: "fs2_mp",
      },
      "2": {
        $deleted: false, effect_kind: "grant", effect_label: "fs2_mp",
        grant_resource: "mp", grant_amount: "15", target_ref: "self",
      },
    },
  });
  shift2.effects = COMBOS.map((c) => c.id);
  changes.push([ik(IDS.RK_SHIFT2), shift2,
    "NEW item — Form Shift (Dual) (Crisis: draws a combo, clears single stances)"]);

  for (const c of COMBOS) {
    changes.push([aek(IDS.RK_SHIFT2, c.id), {
      _id: c.id, name: c.name, img: ICON.active, icon: ICON.active,
      transfer: false, disabled: false, changes: [], statuses: [],
      description: "<p>" + c.blurb + "</p>",
      duration: {}, origin: `Actor.${A}.Item.${IDS.RK_SHIFT2}`,
      // A DIFFERENT tag from the single stances, so fs2_clear cannot wipe the
      // combo it just drew.
      system: { tags: ["rakshasa_combo"] },
      flags: { "fabula-ultima-companion": { crossScene: false, charges: 1, lifetimeMode: "persistent_counter" } },
    }, "NEW AE — " + c.name]);
  }

  // ── Crisis: the three combo attacks ──────────────────────────────────────
  // A combo is NOT its two components fired back to back. It takes elements
  // from each: one damage profile, and the keywords of both halves.

  // Sword + Bow — bow-tier damage across the line, doubling on anyone already
  // down. The finisher for a party that has taken casualties.
  changes.push([ik(IDS.RK_VOLLEY), attack(IDS.RK_VOLLEY, "Executioner's Volley", {
    skill_target: "All Enemies", skill_range: "Range",
    rolled_atr1: "DEX", rolled_atr2: "INS", damage_bonus: "14",
    action_keywords: "execute, overflow", description: DESC.volley,
    isReaction: true,
    on_activate_effect_ref: "spend_combo",
    reaction_config_table: {
      "0": {
        $deleted: false, reaction_trigger: "creature_will_deal_damage",
        reaction_source: "self", reaction_source_skill: "Executioner's Volley",
        condition_formula: "TARGET_AE_COUNT_CRISIS > 0",
        reaction_passive_mode: "force", reaction_effect_ref: "ev_double",
      },
    },
    effect_table: {
      "0": { $deleted: false, effect_kind: "adjust_damage", effect_label: "ev_double",
             damage_operation: "multiply", damage_amount: "2", damage_stage: "outgoing" },
      ...consumeCombo("Sword and Bow Stance"),
    },
  }), "NEW item — Executioner's Volley (Sword+Bow: overflow + execute)"]);

  // Flail + Throwing — chakram damage across three, doubling on the healthy.
  // The opener half of the pair, and the reason a fresh party cannot relax.
  changes.push([ik(IDS.RK_ORBIT), attack(IDS.RK_ORBIT, "Rending Orbit", {
    skill_target: "Up to three creatures", skill_range: "Range",
    rolled_atr1: "DEX", rolled_atr2: "MIG", damage_bonus: "18",
    action_keywords: "cripple, multi", description: DESC.orbit,
    isReaction: true,
    on_activate_effect_ref: "ro_bleed",
    reaction_config_table: {
      "0": {
        $deleted: false, reaction_trigger: "creature_will_deal_damage",
        reaction_source: "self", reaction_source_skill: "Rending Orbit",
        condition_formula: "TARGET_AE_COUNT_CRISIS == 0",
        reaction_passive_mode: "force", reaction_effect_ref: "ro_double",
      },
    },
    effect_table: {
      "0": { $deleted: false, effect_kind: "adjust_damage", effect_label: "ro_double",
             damage_operation: "multiply", damage_amount: "2", damage_stage: "outgoing" },
      "1": { $deleted: false, effect_kind: "apply_ae", effect_label: "ro_bleed",
             ae_template_ref: "Bleed", target_ref: "action_targets",
             ae_duplicate_mode: "replace", chain_steps: "spend_combo" },
      ...consumeCombo("Flail and Throwing Stance"),
    },
  }), "NEW item — Rending Orbit (Flail+Throwing: cripple + Bleed, 3 targets)"]);

  // Sword + Flail — NO keyword. Deliberately sized to kill any unguarded PC and
  // to be survivable by every guarded one:
  //   kills the tank unguarded   raw - 4 >= 166  ->  raw >= 170
  //   squishiest survives Guard  ceil(raw / 2) < 98  ->  raw <= 195
  // a ~25-point window. HR (MIG+MIG) spans 2..20 and the L40 flat is +10, so
  // bonus 162 gives raw 174..192 — lethal at every roll (measured: 158 only
  // killed the tank on a high roll, landing 162-168 against her 166), and
  // survivable at every roll if the target Guards (worst case leaves Hina 2 HP).
  // The window is ~25 points wide, so this is a TIGHT number: re-check it if the
  // party gains HP or the flat level bonus changes. Guard forces RS on all elements, so the halving
  // is reliable; a PC already below full still dies through it, which is the
  // point. Do NOT add a keyword here: doubling this is an unconditional TPK.
  changes.push([ik(IDS.RK_VERDICT), attack(IDS.RK_VERDICT, "Severing Verdict", {
    skill_target: "One Creature", skill_range: "Melee",
    rolled_atr1: "MIG", rolled_atr2: "MIG", damage_bonus: "162",
    action_keywords: "", description: DESC.verdict,
    isReaction: false,
    on_activate_effect_ref: "spend_combo",
    effect_table: { ...consumeCombo("Sword and Flail Stance") },
  }), "NEW item — Severing Verdict (Sword+Flail: one-shot unless Guarded)"]);

  // ── Actor ────────────────────────────────────────────────────────────────
  const a = blankActor(donorActor, A, "Rakshasa", FOLDER, ART, SCALE);
  const p = a.system.props;

  Object.assign(p, {
    level: "40", species: "Demon", npc_rank: "elite", activation: "4",
    subtype_list: "", attribute: "",
    traits: "Collector · Patient · Eats what it kills · Never the same twice",
    dex_base: "10", ins_base: "8", mig_base: "10", wlp_base: "8",
    // Derived from the dice + mods, but written explicitly: a clone carries the
    // DONOR's stored numbers to disk even though CSB recomputes them live, so an
    // offline read (export, preflight, co-dev) would otherwise see Ampere's.
    def_mod: "+4", mdef_mod: "+4", defense: 14, magic_defense: 12,
    // 1150. Ten Thousand Arms used to halve party output after Crisis, and that
  // brake is what made the second half of the bar take twice as long as the
  // first; without it the party keeps full output throughout, so the SAME 5.5-6
  // round shape needs a bigger bar. Mindscape puts that shape at ~285 HP against
  // its own unadapted party, and the measured live-to-modelled ratio is ~4.2.
  // Crisis still lands at the start of round 3 on its own: with a uniform party
  // rate, half the bar IS the midpoint of the fight.
    max_hp: "1200", current_hp: "1200", max_mp: "45", current_mp: "45",
    init: "12", max_zero: "6", ultima_points: "3",
    zenit_reward_min: "1400", zenit_reward_max: "1400",
    study_text: STUDY,
    // VU light (it is a demon) · RS dark + poison (the Demon species' two free
    // resistances; poison is the carrion-eater joke). Deliberately STATIC — the
    // weapon axis is already the moving puzzle and two at once is unreadable.
    affinity_8: "VU", affinity_4: "RS", affinity_9: "RS",
    // A weapon master cannot be disarmed, and it does not flinch. Four of the six
    // attribute-shrinkers stay fully open so there is always a play.
    condition_disarmed: "IM", condition_frightened: "IM",
    condition_slow: "RS", condition_weak: "RS",
    // Every lane starts NEUTRAL. A static profile here would fight the dynamic
    // one — Adaptive Defense is the only thing that moves these.
  });

  p.attack_list = {
    [IDS.RK_SABER]: {
      name: "Saber", id: "${item.id}", uuid: `Actor.${A}.Item.${IDS.RK_SABER}`,
      active_target: "One Creature", attribute_die1: "MIG", attribute_die2: "DEX",
      attack_description: DESC.saber, roll: "",
    },
    [IDS.RK_MACE]: {
      name: "Mace", id: "${item.id}", uuid: `Actor.${A}.Item.${IDS.RK_MACE}`,
      active_target: "One Creature", attribute_die1: "MIG", attribute_die2: "MIG",
      attack_description: DESC.mace, roll: "",
    },
    [IDS.RK_CHAKRAM]: {
      name: "Chakram", id: "${item.id}", uuid: `Actor.${A}.Item.${IDS.RK_CHAKRAM}`,
      active_target: "Up to three creatures", attribute_die1: "DEX", attribute_die2: "INS",
      attack_description: DESC.chakram, roll: "",
    },
    [IDS.RK_RAIN]: {
      name: "Rain of Arrows", id: "${item.id}", uuid: `Actor.${A}.Item.${IDS.RK_RAIN}`,
      active_target: "All Enemies", attribute_die1: "DEX", attribute_die2: "INS",
      attack_description: DESC.rain, roll: "",
    },
    [IDS.RK_VOLLEY]: {
      name: "Executioner's Volley", id: "${item.id}", uuid: `Actor.${A}.Item.${IDS.RK_VOLLEY}`,
      active_target: "All Enemies", attribute_die1: "DEX", attribute_die2: "INS",
      attack_description: DESC.volley, roll: "",
    },
    [IDS.RK_ORBIT]: {
      name: "Rending Orbit", id: "${item.id}", uuid: `Actor.${A}.Item.${IDS.RK_ORBIT}`,
      active_target: "Up to three creatures", attribute_die1: "DEX", attribute_die2: "MIG",
      attack_description: DESC.orbit, roll: "",
    },
    [IDS.RK_VERDICT]: {
      name: "Severing Verdict", id: "${item.id}", uuid: `Actor.${A}.Item.${IDS.RK_VERDICT}`,
      active_target: "One Creature", attribute_die1: "MIG", attribute_die2: "MIG",
      attack_description: DESC.verdict, roll: "",
    },
  };
  p.skill_active_list = {
    [IDS.RK_SHIFT]: {
      name: "Form Shift", id: "${item.id}", uuid: `Actor.${A}.Item.${IDS.RK_SHIFT}`,
      active_target: "Self", active_cost: "-", active_duration: "Scene",
      active_description: DESC.shift, roll: "",
    },
    [IDS.RK_SHIFT2]: {
      name: "Form Shift (Dual)", id: "${item.id}", uuid: `Actor.${A}.Item.${IDS.RK_SHIFT2}`,
      active_target: "Self", active_cost: "-", active_duration: "Scene",
      active_description: DESC.shift2, roll: "",
    },
    [IDS.RK_DEVOUR]: {
      name: "Devour", id: "${item.id}", uuid: `Actor.${A}.Item.${IDS.RK_DEVOUR}`,
      active_target: "One Creature", active_cost: "-", active_duration: "Instantaneous",
      active_description: DESC.devour, roll: "",
    },
  };
  p.skill_passive_list = {
    [IDS.RK_ADAPT]: {
      name: "Adaptive Defense", id: "${item.id}", uuid: `Actor.${A}.Item.${IDS.RK_ADAPT}`,
      passive_description: DESC.adapt, roll: "",
    },
  };

  // ── Enemy AI ─────────────────────────────────────────────────────────────
  // The whole cycle is two gates. Attacks at 8 are each gated on their own
  // stance, so at most ONE can pass; Form Shift at 4 is a gap of 4, so it is
  // excluded whenever an attack is legal and is the only survivor when none is.
  // No cooldowns needed — and action_pattern_cooldown would be inert on a
  // priority-exclusive row anyway.
  //
  // Devour sits level with Form Shift (gap 0 = 50/50) but only inside Crisis
  // (hp 0-50 is an inclusive PERCENT RANGE, not a threshold), on a 3-turn
  // cooldown, which at gap 0 is a real block.
  const atk = (i, name, stance) => ({
    [String(i)]: {
      $deleted: false, action_pattern_name: name,
      action_pattern_condition: "self_has_status", action_pattern_string: stance,
      action_pattern_value_1: "0", action_pattern_value_2: "100",
      action_pattern_priority: "8",
      // Focus follows the keyword: an `execute` row hunts the wounded, a
      // `cripple` row hunts the healthy, so each doubling actually pays out.
      // Severing Verdict carries no keyword and takes the weakest — it is a
      // kill, not a setup.
      action_pattern_target_focus:
        (name === "Saber" || name === "Severing Verdict") ? "lowest_hp"
        : (name === "Mace" || name === "Rending Orbit") ? "highest_hp"
        : "auto",
      action_pattern_cooldown: "0", action_pattern_hp_reserve: "0", action_pattern_hp_ceiling: "0",
    },
  });
  // The two Form Shifts are separated by the `hp` gate, which is an INCLUSIVE
  // PERCENT RANGE — 51-100 and 0-50 partition the bar exactly, so precisely one
  // is ever legal and Crisis flips the whole kit over in one step.
  p.action_pattern_table = {
    ...atk(0, "Saber", "Sword Stance"),
    ...atk(1, "Rain of Arrows", "Bow Stance"),
    ...atk(2, "Chakram", "Throwing Stance"),
    ...atk(3, "Mace", "Flail Stance"),
    ...atk(6, "Executioner's Volley", "Sword and Bow Stance"),
    ...atk(7, "Rending Orbit", "Flail and Throwing Stance"),
    ...atk(8, "Severing Verdict", "Sword and Flail Stance"),
    "4": { $deleted: false, action_pattern_name: "Form Shift",
           action_pattern_condition: "hp", action_pattern_string: "",
           action_pattern_value_1: "51", action_pattern_value_2: "100",
           action_pattern_priority: "4", action_pattern_target_focus: "auto",
           action_pattern_cooldown: "0", action_pattern_hp_reserve: "0", action_pattern_hp_ceiling: "0" },
    "9": { $deleted: false, action_pattern_name: "Form Shift (Dual)",
           action_pattern_condition: "hp", action_pattern_string: "",
           action_pattern_value_1: "0", action_pattern_value_2: "50",
           action_pattern_priority: "4", action_pattern_target_focus: "auto",
           action_pattern_cooldown: "0", action_pattern_hp_reserve: "0", action_pattern_hp_ceiling: "0" },
    "5": { $deleted: false, action_pattern_name: "Devour",
           action_pattern_condition: "hp", action_pattern_string: "",
           action_pattern_value_1: "0", action_pattern_value_2: "50",
           action_pattern_priority: "4", action_pattern_target_focus: "lowest_hp",
           action_pattern_cooldown: "3", action_pattern_hp_reserve: "0", action_pattern_hp_ceiling: "0" },
  };

  a.items = [
    IDS.RK_SHIFT, IDS.RK_SABER, IDS.RK_MACE, IDS.RK_CHAKRAM,
    IDS.RK_RAIN, IDS.RK_DEVOUR, IDS.RK_ADAPT,
    IDS.RK_VOLLEY, IDS.RK_ORBIT, IDS.RK_VERDICT, IDS.RK_SHIFT2,
  ];
  changes.push([`!actors!${A}`, a, "NEW actor — Rakshasa (L40 elite, Demon, 4 activations)"]);

  // Ten Thousand Arms is RETIRED — the Crisis identity is the dual-arm combo,
  // and stacking a second escalation on top of it overloaded the phase. The doc
  // must be dropped, not merely unlisted: an item left in the keyspace while the
  // actor's items[] no longer names it is an orphan the sheet can still render.
  deletes.push([`!actors.items!${A}.RkTenThousandArm`,
    "Ten Thousand Arms — retired, replaced by the dual-arm Crisis combos"]);
}, "valley-of-the-dragon: Rakshasa");
