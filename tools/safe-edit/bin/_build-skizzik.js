// Skizzik rework build — docs/skizzik-rework-proposal.md rev2
// Run from tools/safe-edit.  --apply to write; default is dry-run.
const { openCollection, getByKey, putByKey } = require("./lib/db");
const { snapshotCollection } = require("./lib/backup");

const APPLY = process.argv.includes("--apply");
const A = "I2sSkVIQ4FCunZBE";                 // Skizzik
const TS = "vBuHp8f6NHuYNojr";                // Thunder Strike
const CR = "IbE6lOJCeAs8Bb4n";                // Chain Reaction

// new ids (16-char alphanumeric, Foundry style)
const RIP_P = "SkzRiposteP01aQ";              // Overload Riposte   (passive carrier)
const RIP_A = "SkzRiposteA02bR";              // Thunder Strike (Riposte)  (damage vehicle)
const STA_P = "SkzStaticP03cT";               // Static Buildup     (passive carrier)
const STA_AE = "SkzStaticAE04dU";             // "Static" AE template

const BOLT = 'Item.5XAuMMbDPlLzhJLw';
const TRIG = 'JournalEntry.P7eaFojxra2gTRTG';
const link = (uuid, label, tip) =>
  `<a class="content-link" data-uuid="${uuid}" data-id="${uuid.split(".").pop()}" data-type="${uuid.split(".")[0]}" data-tooltip="${tip}"><strong>${label}</strong></a>`;
const boltL = link(BOLT, "Bolt", "Item");
const trigL = link(TRIG, "Trigger", "Journal Entry");
const bullet = (t) => `<ul><li><p>${trigL}&nbsp;${t}</p></li></ul>`;

const DESC_RIP =
  bullet("When an attack strikes the Skizzik and the Result of the attacker's Accuracy Check was an <strong>even number</strong>") +
  `<p>It answers before the blow has landed, striking that creature with a <strong>free</strong> ${boltL}&nbsp;riposte.</p>` +
  `<p>${boltL}&nbsp;damage does not provoke it — that is <strong>Chain Reaction</strong>'s business.</p>`;

const DESC_STA =
  bullet("Whenever the Skizzik deals damage to an enemy") +
  `<p>It gathers a charge of <strong>Static</strong>. On the <strong>third</strong>, the charge earths out through that creature, dealing ${boltL}&nbsp;damage.</p>`;

const DESC_RIPA = `<p>Deal <strong>light</strong> ${boltL}&nbsp;damage to one creature.</p>`;

const STUDY =
  "<p>Living lightning, quicker than the eye can follow — <strong>bolt</strong> only rouses it, " +
  "and it repays every jolt with a strike of its own. Strike it cleanly or not at all: a sloppy " +
  "blow earns a riposte, and the charge it gathers has to go somewhere. <strong>Earth</strong> grounds it dead.</p>";

const ik = (id) => `!actors.items!${A}.${id}`;
const aek = (item, ae) => `!actors.items.effects!${A}.${item}.${ae}`;

const clone = (src, id, name) => {
  const d = JSON.parse(JSON.stringify(src));
  d._id = id; d.name = name; d.effects = [];
  d.system.props = { ...d.system.props, name, id: "${item.id}", uuid: `Actor.${A}.Item.${id}` };
  // clear inherited automation — every table is re-authored below
  for (const k of ["reaction_config_table", "effect_table", "optional_params", "active_effect_config_table"])
    d.system.props[k] = {};
  return d;
};

(async () => {
  const changes = [];
  const actor = await getByKey("actors", `!actors!${A}`);
  const ts = await getByKey("actors", ik(TS));
  const cr = await getByKey("actors", ik(CR));
  if (!actor || !ts || !cr) throw new Error("missing source doc");

  // ── 1. Thunder Strike: 48 → 30 ────────────────────────────────────────────
  const tsNew = JSON.parse(JSON.stringify(ts));
  tsNew.system.props.damage_bonus = "30";
  changes.push([ik(TS), tsNew, `Thunder Strike damage_bonus ${ts.system.props.damage_bonus} → 30`]);

  // ── 2. Chain Reaction: blank the cause filter so the Storm feeds it ───────
  const crNew = JSON.parse(JSON.stringify(cr));
  for (const k of Object.keys(crNew.system.props.reaction_config_table ?? {}))
    crNew.system.props.reaction_config_table[k].reaction_cause_filter = "";
  changes.push([ik(CR), crNew, "Chain Reaction reaction_cause_filter → blank (hazard feeds it)"]);

  // ── 3. Thunder Strike (Riposte) — damage vehicle, OFF attack_list ────────
  const ripA = clone(ts, RIP_A, "Thunder Strike (Riposte)");
  Object.assign(ripA.system.props, {
    damage_bonus: "12", check_bonus: "10", type_damage: "Bolt",
    rolled_atr1: "DEX", rolled_atr2: "MIG", defense_target_type: "def",
    skill_type: "Attack", skill_target: "One Creature", skill_range: "Melee",
    cost: "-", duration: "Instantaneous", isCheck: true, isReaction: false,
    description: DESC_RIPA,
  });
  changes.push([ik(RIP_A), ripA, "NEW item — Thunder Strike (Riposte), dmg 12"]);

  // ── 4. Overload Riposte — the counter ────────────────────────────────────
  const ripP = clone(cr, RIP_P, "Overload Riposte");
  Object.assign(ripP.system.props, {
    description: DESC_RIP,
    reaction_config_table: {
      "0": {
        reaction_trigger: "creature_targeted_by_action",
        reaction_source: "self",
        // ATTACK_CHECK_RESULT is stamped on THIS trigger's payload (checkTotal).
        // INCOMING_DAMAGE > 0 = hit-and-damaging only. The BOLT exclusion keeps
        // Chain Reaction's lane clear (no double free-action off one attack).
        condition_formula:
          "SUBJECT_IS_SELF == 1 && INCOMING_DAMAGE > 0 && ATTACK_CHECK_RESULT > 0 " +
          "&& ATTACK_CHECK_RESULT % 2 == 0 && TRIGGER_DAMAGE_IS_BOLT == 0",
        reaction_passive_mode: "on",
        reaction_effect_ref: "riposte_strike",
        reaction_cause_filter: "", reaction_resource_filter: "",
      },
    },
    effect_table: {
      // On creature_targeted_by_action BOTH sourceActorUuid and subjectActorUuid
      // are the REACTOR — trigger_attacker is the only source that reaches the
      // incoming creature (skill-authoring-guideline G6).
      "0": {
        effect_kind: "targeting", effect_label: "riposte_target",
        candidate_source: "trigger_attacker", mode: "exact", count: "1",
      },
      "1": {
        effect_kind: "free_action", effect_label: "riposte_strike",
        action_ref: "Thunder Strike (Riposte)", target_ref: "riposte_target",
      },
    },
  });
  changes.push([ik(RIP_P), ripP, "NEW item — Overload Riposte (uncapped even-parity counter)"]);

  // ── 5. Static Buildup — 3 stacks → 30 Bolt on the creature just damaged ──
  const staP = clone(cr, STA_P, "Static Buildup");
  Object.assign(staP.system.props, {
    description: DESC_STA,
    reaction_config_table: {
      // Row order is authored, but the two gates are MUTUALLY EXCLUSIVE, so
      // row 1's AE write can never be read by row 0 in the same fire.
      "0": {
        reaction_trigger: "creature_deals_damage", reaction_source: "self",
        condition_formula: "AE_CHARGES_STATIC >= 2",
        reaction_passive_mode: "on", reaction_effect_ref: "static_discharge",
        reaction_cause_filter: "", reaction_resource_filter: "",
      },
      "1": {
        reaction_trigger: "creature_deals_damage", reaction_source: "self",
        condition_formula: "AE_CHARGES_STATIC < 2",
        reaction_passive_mode: "on", reaction_effect_ref: "static_build",
        reaction_cause_filter: "", reaction_resource_filter: "",
      },
    },
    effect_table: {
      "0": {
        effect_kind: "chain", effect_label: "static_discharge",
        chain_steps: "static_blast, static_clear",
      },
      // subjectTokenUuid on the per-target creature_deals_damage payload IS the
      // victim (state-handlers.js ~L1141) — so trigger_subject = the creature
      // Skizzik just damaged. Single target, per the monster's DPS identity.
      "1": {
        effect_kind: "targeting", effect_label: "static_victim",
        candidate_source: "trigger_subject", mode: "exact", count: "1",
      },
      "2": {
        effect_kind: "deal_damage", effect_label: "static_blast",
        damage_amount: "30", damage_element: "bolt", damage_verbosity: "full",
        target_ref: "static_victim",
      },
      // include_persistent is MANDATORY: the AE is persistent_counter, and
      // without it this remove is a silent no-op (the Asura bug).
      "3": {
        effect_kind: "remove_ae", effect_label: "static_clear",
        ae_template_ref: "Static", include_persistent: true,
        count: "all", target_ref: "self",
      },
      "4": {
        effect_kind: "apply_ae", effect_label: "static_build",
        ae_template_ref: "Static", target_ref: "self",
        ae_duplicate_mode: "add_charges", ae_initial_charges: "1",
      },
    },
  });
  staP.effects = [STA_AE];
  changes.push([ik(STA_P), staP, "NEW item — Static Buildup (3 stacks → 30 Bolt)"]);

  // The AE must live at its OWN key with the item holding a string[] of ids —
  // an inline `effects: [{...}]` object is dropped on load.
  const staAE = {
    _id: STA_AE, name: "Static",
    img: cr.img, icon: cr.img,
    transfer: false, disabled: false, changes: [], statuses: [],
    description: "<p>Gathered charge. At three, it earths out.</p>",
    duration: {}, origin: `Actor.${A}.Item.${STA_P}`,
    system: { tags: ["static"] },
    flags: { "fabula-ultima-companion": { crossScene: false, charges: 1, chargesMax: 3, lifetimeMode: "persistent_counter" } },
  };
  changes.push([aek(STA_P, STA_AE), staAE, "NEW AE — Static (persistent_counter, 1 charge)"]);

  // ── 6. Actor: HP, item list, sheet mirrors, study text ───────────────────
  const aNew = JSON.parse(JSON.stringify(actor));
  const p = aNew.system.props;
  p.max_hp = "130"; p.current_hp = "130";
  p.study_text = STUDY;
  aNew.items = [TS, CR, RIP_A, RIP_P, STA_P];

  // sheet mirrors hold their OWN copy of the description — always re-sync
  p.skill_passive_list = {
    [CR]:    { ...p.skill_passive_list[CR] },
    [RIP_P]: { name: "Overload Riposte", id: "${item.id}", uuid: `Actor.${A}.Item.${RIP_P}`, passive_description: DESC_RIP, roll: "" },
    [STA_P]: { name: "Static Buildup",   id: "${item.id}", uuid: `Actor.${A}.Item.${STA_P}`, passive_description: DESC_STA, roll: "" },
  };
  // attack_list: Thunder Strike only. The Riposte is a free-action component —
  // listing it would offer it to the NPC action picker as a turn action.
  changes.push([`!actors!${A}`, aNew,
    `Actor — HP ${actor.system.props.max_hp} → 130, +3 items, passive mirrors, study text`]);

  // ── report / write ───────────────────────────────────────────────────────
  console.log(APPLY ? "=== APPLYING ===" : "=== DRY RUN (pass --apply to write) ===");
  for (const [k, , note] of changes) console.log(`  ${note}\n    key: ${k}`);

  if (!APPLY) { console.log("\nNo writes performed."); return; }

  const bk = snapshotCollection("actors");
  console.log(`\nbackup: ${bk}`);
  const db = await openCollection("actors");
  for (const [k, v] of changes) await db.put(k, v);   // put = full replace, no deep-merge
  await db.close();
  console.log(`wrote ${changes.length} docs.`);
})().catch((e) => { console.error(e); process.exit(1); });
