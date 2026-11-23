/**
 * Migration: 2026-11-23-spell-fencer-author  (Spell Fencer class rework, text + new Heroics)
 * ---------------------------------------------------------------------------
 * Design approved 2026-11-23 on the class page (rounds 1–4). This migration authors the TEXT and the new documents; the
 * rules (rows, props, Active Effects) are the move-engine export 2026-11-23-spell-fencer-rules, which runs after it.
 *
 *   1. Three new Heroic skills (world masters in 💥 Skill/Class Skill/Spell Fencer): Crescendo, Encore, Duelist's Guard.
 *      Cloned from Master of Duality (same template, heroic shape), fixed ids "SpFn…".
 *   2. They are embedded on the Spell Fencer class actor, so Level Up / Character Creation offer them
 *      (class-registry reads the class actor's embedded items).
 *   3. Final wording (Genshin mode, house item-text convention: bullets, bold 【formulas】, content links) on every copy of
 *      the 6 existing skills + the 3 new ones: the world master, the class actor's copy and every actor / unlinked-token
 *      copy (Keren's Spellblade Rhapsody + Spellweave). Levels and other fields are not touched.
 *      Master of Duality gets its heroic requirement; Spellblade Rhapsody's cost reads "2 Resonance".
 *   4. The class actor's Resonance explainer (classMechanic_text) follows the approved rules.
 *
 * Resonance links to the keyword registry entry "JournalEntry.SpFnResonanceKw1" (synthetic id like Fickle, text baked in
 * keyword-registry.js; no journal document needed).
 *
 * SEED-ONLY: new documents are skipped when they exist; text edits are gated per document by
 * flags.fabula-ultima-companion.spellFencerText, so a re-run never re-applies and later hand edits are kept.
 */

export const key = "2026-11-23-spell-fencer-author";
export const description = "Spell Fencer rework: final wording on all skills + copies, 3 new Heroics (Crescendo, Encore, Duelist's Guard) embedded on the class actor, Resonance explainer.";

const M = "fabula-ultima-companion";
const FLAG = "spellFencerText";
const TEXT_VERSION = "2026-11-23-r4";

const CLASS_ACTOR = "8XdohFASv0voFz4E";
const SKILL_FOLDER = "nNKbXiI5DqqWmDy0";      // 💥 Skill / Class Skill / Spell Fencer
const HEROIC_DONOR = "bmXjtAU8XKmnVQ0D";      // Master of Duality
const SK = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Skill%20Icon/FFXIVIcons%20Battle(PvE)/";
const REQ = "You must have mastered the Spell Fencer Class.";

const ID = {
  spellweave: "dDT8OrIPHFQuyfQp", rhapsody: "4qw6XEVHQmERzZ8y", bladework: "GqVU8ps3IJp0KQ3Y", infusion: "XwoHbYxHvfqvHHAZ",
  bookblade: "grSkhZspOgRbAgCJ", duality: "bmXjtAU8XKmnVQ0D",
  crescendo: "SpFnCrescendo001", encore: "SpFnEncore000001", guard: "SpFnDuelGuard001",
};

// ── links (house form: a plain content-link; lt-render dresses it) ───────────────────────────────────────────────────────
const J = (id, label) => `<a class="content-link" data-uuid="JournalEntry.${id}" data-id="${id}" data-type="JournalEntry">${label}</a>`;
const I = (id, label) => `<a class="content-link" data-uuid="Item.${id}" data-id="${id}" data-type="Item">${label}</a>`;
const RES = J("SpFnResonanceKw1", "Resonance");
const F = (s) => `<strong>【${s}】</strong>`;
const ATTACK = "【⚔️Attack】", SPELL = "【📕Spell】", OFFENSIVE = "【⚡Offensive Spell】";
const ul = (...lines) => "<ul>" + lines.map((l) => `<li><p>${l}</p></li>`).join("") + "</ul>";

const TEXT = {
  spellweave: ul(
    `Switching between a weapon attack and an ${OFFENSIVE} grants 1 ${RES}.`,
    `Start each conflict with 1 ${RES}. Max ${F("SL + 1")} stacks. Lost at the end of the scene.`,
    `When you cast an ${OFFENSIVE}, spend up to ${F("SL")} ${RES} for +1 Accuracy each.`),
  rhapsody: ul(
    `At the start of your turn: this turn, perform both the ${ATTACK} and ${SPELL} actions.`,
    `The spell must be an ${OFFENSIVE} costing ${F("SL × 10")} MP or less.`,
    `Generates no ${RES} this turn.`),
  bladework: ul(
    `After you cast an ${OFFENSIVE}, your next weapon attack deals ${F("SL")} extra damage.`,
    `On hit, recover ${F("SL × 2")} MP.`),
  infusion: ul(`After you cast an ${OFFENSIVE}, your next weapon attack deals that spell's damage type.`),
  bookblade: ul(`You can equip two-handed arcane weapons in one hand.`),
  duality: ul(`${I(ID.spellweave, "Spellweave")}, ${I(ID.bladework, "Bladework")} and ${I(ID.rhapsody, "Spellblade Rhapsody")} work with every ${SPELL}, not only ${OFFENSIVE}.`),
  crescendo: ul(`During ${I(ID.rhapsody, "Spellblade Rhapsody")}, your ${ATTACK} and your ${SPELL} each deal 10 extra damage.`),
  encore: ul(`Once per scene, ${I(ID.rhapsody, "Spellblade Rhapsody")} costs no ${RES}.`),
  guard: ul(`While you have 2 or more ${RES}, gain +2 DEF and +2 MDEF.`),
};

const MECHANIC_TEXT =
  `<h1>Resonance</h1><h3>SYMPHONY OF MAGIC AND STEEL</h3>` +
  `<p>${RES} is the harmony between your blade and your spellcraft. Keep switching between the two to build it.</p>` +
  `<h3>GAINING RESONANCE</h3>` + ul(
    `Switching between a weapon attack and an ${OFFENSIVE} grants 1 ${RES}.`,
    `Start each conflict with 1. Max ${F("Spellweave SL + 1")}. Lost at the end of the scene.`,
    `${I(ID.rhapsody, "Spellblade Rhapsody")} turns generate none.`) +
  `<h3>SPENDING RESONANCE</h3>` + ul(
    `${I(ID.rhapsody, "Spellblade Rhapsody")}: 2 ${RES} to attack and cast in the same turn.`,
    `${I(ID.spellweave, "Spellweave")}: +1 Accuracy per ${RES} spent on an ${OFFENSIVE}.`) +
  `<h3>THE RHYTHM</h3>` + ul(
    `A blue aura means a spell comes next; a red aura means an attack. A golden aura means Spellblade Rhapsody is ready.`);

// per skill: name, world id, extra props for every copy (text goes to description + skill_description)
const SKILLS = [
  { k: "spellweave", name: "Spellweave" },
  { k: "rhapsody", name: "Spellblade Rhapsody", props: { cost: "2 Resonance" } },
  { k: "bladework", name: "Bladework" },
  { k: "infusion", name: "Mystic Infusion" },
  { k: "bookblade", name: "Book and Blade" },
  { k: "duality", name: "Master of Duality", props: { isHeroic: true, heroic_requirement: REQ } },
  { k: "crescendo", name: "Crescendo", img: SK + "15_RDM/verflare.png", isNew: true },
  { k: "encore", name: "Encore", img: SK + "15_RDM/embolden.png", isNew: true },
  { k: "guard", name: "Duelist's Guard", img: SK + "15_RDM/veraero.png", isNew: true },
];

// ── 1. new Heroic world masters ──────────────────────────────────────────────────────────────────────────────────────
function heroicData(s) {
  const src = game.items.get(HEROIC_DONOR);
  if (!src) throw new Error(`donor ${HEROIC_DONOR} (Master of Duality) missing`);
  const d = src.toObject();
  const id = ID[s.k], text = TEXT[s.k];
  d._id = id; d.name = s.name; d.img = s.img; d.folder = SKILL_FOLDER;
  d.effects = [];
  d.system.container = null;
  d.system.uniqueId = id;
  d.system.props = { ...d.system.props, name: s.name, id, uuid: `Item.${id}`, img: s.img, class: "Spell Fencer",
    skill_type: "Passive", skill_target: "Self", isHeroic: true, heroic_requirement: REQ, level: "1", max_level: "1",
    cost: "-", description: text, skill_description: text, effect_table: {}, reaction_config_table: {} };
  d.flags = { ...(d.flags ?? {}), [M]: { ...(d.flags?.[M] ?? {}), [FLAG]: TEXT_VERSION } };
  delete d._stats; delete d.sort; delete d.ownership;
  return d;
}
async function createHeroics(out) {
  for (const s of SKILLS.filter((x) => x.isNew)) {
    if (game.items.get(ID[s.k])) { out.push(`= ${s.name} exists`); continue; }
    await Item.createDocuments([heroicData(s)], { keepId: true });
    out.push(`+ ${s.name} (${ID[s.k]})`);
  }
}

// ── 2. embed them on the class actor ─────────────────────────────────────────────────────────────────────────────────
async function embedOnClass(out) {
  const cls = game.actors.get(CLASS_ACTOR);
  if (!cls) { out.push(`! class actor ${CLASS_ACTOR} missing`); return; }
  const add = [];
  for (const s of SKILLS.filter((x) => x.isNew)) {
    if (cls.items.find((i) => i.system?.uniqueId === ID[s.k] || i.name === s.name)) continue;
    const w = game.items.get(ID[s.k]);
    if (!w) { out.push(`! ${s.name} world master missing`); continue; }
    const d = w.toObject(); delete d._id; delete d.folder; delete d._stats; delete d.sort; delete d.ownership;
    d.system.uniqueId = ID[s.k];
    add.push(d);
  }
  if (!add.length) { out.push("= class actor already has the new Heroics"); return; }
  const made = await cls.createEmbeddedDocuments("Item", add);
  out.push(`+ Spell Fencer class: ${made.map((i) => i.name).join(", ")}`);
}

// ── 3. text on every copy ────────────────────────────────────────────────────────────────────────────────────────────
function copiesOf(s) {
  const id = ID[s.k], out = [];
  const w = game.items.get(id); if (w) out.push(w);
  const match = (it) => it.system?.uniqueId === id || (it.name === s.name && String(it.system?.props?.class ?? "") === "Spell Fencer");
  for (const a of game.actors) for (const it of a.items) if (match(it)) out.push(it);
  for (const sc of game.scenes) for (const t of sc.tokens) if (!t.actorLink && t.actor) for (const it of t.actor.items) if (match(it)) out.push(it);
  return out;
}
async function writeText(out) {
  let n = 0;
  for (const s of SKILLS) {
    for (const it of copiesOf(s)) {
      if (it.getFlag?.(M, FLAG) === TEXT_VERSION) continue;   // written already (new Heroics are born with it)
      const text = TEXT[s.k];
      const patch = { "system.props.description": text, "system.props.skill_description": text, [`flags.${M}.${FLAG}`]: TEXT_VERSION };
      for (const [k, v] of Object.entries(s.props ?? {})) patch["system.props." + k] = v;
      await it.update(patch);
      n++;
    }
  }
  out.push(`~ text written on ${n} cop${n === 1 ? "y" : "ies"}`);
}

// ── 4. the class explainer ───────────────────────────────────────────────────────────────────────────────────────────
async function writeMechanic(out) {
  const cls = game.actors.get(CLASS_ACTOR);
  if (!cls) return;
  if (cls.getFlag?.(M, FLAG) === TEXT_VERSION) { out.push("= class explainer already written"); return; }
  await cls.update({ "system.props.classMechanic_text": MECHANIC_TEXT, [`flags.${M}.${FLAG}`]: TEXT_VERSION });
  out.push("~ class explainer (Resonance)");
}

export async function migrate(game, log = () => {}) {
  const out = [];
  if (!game.items.get(HEROIC_DONOR)) { log("Spell Fencer skills not in this world — nothing to do"); return { applied: true, summary: "no Spell Fencer in world" }; }
  await createHeroics(out);
  await embedOnClass(out);
  await writeText(out);
  await writeMechanic(out);
  for (const l of out) log(l);
  return { applied: true, summary: out.join(" | ") };
}
