/**
 * Migration: 2026-11-28-deva-tuning  (the first Deva fight fixes, user-approved 2026-11-28)
 * ---------------------------------------------------------------------------
 * 1. Deva (amxILxU7mqQ0jKhZ) IM Paralyzed. Paralyzed bars Skills, and her three top pattern rows are Skills
 *    (Enlightenment, Missile Fist, Rahu's Eclipse): the boss rule, IM to whatever blocks the main command set.
 * 2. Missile Fist "1 damage per hit, breaks after the third" (to-do 19). The cap was an incoming adjust_damage row on
 *    the Fuse ITEM's creature_takes_damage reaction, which runs post-resolve, AFTER the HP write: it never capped
 *    anything, so any hit of 3+ broke a fist (Hina's Glacies broke both in one cast). The cap now lives where the
 *    HP-write path reads it (skill-effects.resolveDamageReactions walks the victim's AEs): a hidden, always-on
 *    "Fist Shell" AE on the Missile Fist actor (summoned copies inherit it). Every source: attacks, spells, areas.
 * 3. Double Slap: each target hit has a 30% chance to be Stunned, otherwise it is Shaken (was always Shaken).
 *    The rider now points at a chance row (sl_roll → sl_stun / sl_shaken). Text updated (item + sheet entry).
 * Every copy (world actors, unlinked tokens). Idempotent.
 */
export const key = "2026-11-28-deva-tuning";
export const description = "Deva IM Paralyzed, Missile Fist damage cap on the HP-write path, Double Slap 30% Stunned else Shaken.";

const M = "fabula-ultima-companion";
const DEVA = "amxILxU7mqQ0jKhZ", FIST = "MsFistSummon0001", SLAP = "DvDoubleSlap0001";
const link = (uuid, label) => `<a class="content-link" data-uuid="${uuid}" data-id="${uuid.split(".").pop()}" data-type="${uuid.split(".")[0] === "Item" ? "Item" : "JournalEntry"}" data-tooltip="${uuid.split(".")[0] === "Item" ? "Item" : "Journal Entry"}"><strong>${label}</strong></a>`;
const SLAP_TEXT = `<ul><li><p>${link("JournalEntry.Gm3upxgpUVoLSK5u", "Multi (2)")}</p></li></ul>` +
  `<p>She slaps the insolent aside. Deals ${link("Item.XpKZuGo3VmT0TlTu", "Physical")}&nbsp;damage.</p>` +
  `<p>Each target hit has a 30% chance to be ${link("JournalEntry.StunnedKeyword01", "Stunned")}; otherwise it is ${link("JournalEntry.ImFKpNNGjstom7Q9", "Shaken")}.</p>`;
const SLAP_ROWS = [
  { $deleted: false, effect_kind: "chance", effect_label: "sl_roll", chance_percent: "30", chance_then_ref: "sl_stun", chance_else_ref: "sl_shaken" },
  { $deleted: false, effect_kind: "apply_ae", effect_label: "sl_stun", ae_template_ref: "Stunned", target_ref: "trigger_subject", ae_duplicate_mode: "replace" },
];
const SHELL = {
  _id: "MsAeFistShell001", name: "Fist Shell", img: null, transfer: false, disabled: false, changes: [], statuses: [],
  description: "<p>Takes 1 damage from each hit.</p>", duration: {}, origin: `Actor.${FIST}`, system: { tags: ["deva_fuse"] },
  flags: { [M]: { crossScene: false, charges: 1, lifetimeMode: "persistent_counter", hidden: true,
    reactionConfig: { name: "Fist Shell",
      reaction_config_table: { "0": { $deleted: false, reaction_trigger: "creature_takes_damage", reaction_source: "self", reaction_isPassive: true,
        reaction_passive_mode: "force", reaction_effect_ref: "fs_cap", reaction_cause_filter: "", reaction_resource_filter: "" } },
      effect_table: { "0": { $deleted: false, effect_kind: "adjust_damage", effect_label: "fs_cap", damage_stage: "incoming", damage_operation: "cap", damage_amount: "1" } } } } },
};

function actorsNamed(re, id) {
  const out = []; for (const a of game.actors) if (a.id === id || re.test(a.name ?? "")) out.push(a);
  for (const s of game.scenes) for (const t of s.tokens) if (!t.actorLink && t.actor && re.test(t.actor.name ?? "")) out.push(t.actor);
  return out;
}
const nextKey = (tbl) => String(Object.keys(tbl ?? {}).reduce((m, k) => Math.max(m, Number(k) + 1 || 0), 0));

export async function migrate(game, log = () => {}) {
  const out = [];
  // 1. Deva IM Paralyzed
  for (const a of actorsNamed(/^deva$/i, DEVA)) {
    if (a.system?.props?.condition_paralyzed === "IM") continue;
    await a.update({ "system.props.condition_paralyzed": "IM" }); out.push(`~ ${a.name}${a.isToken ? " (token)" : ""}: IM Paralyzed`);
  }
  // 2. Missile Fist cap on the HP-write path (base actor only: summoned copies inherit its effects)
  for (const a of game.actors) {
    if (a.id !== FIST && !/^missile fist$/i.test(a.name ?? "")) continue;
    if (a.effects.some((e) => e.name === SHELL.name)) continue;
    await a.createEmbeddedDocuments("ActiveEffect", [{ ...SHELL, origin: `Actor.${a.id}` }], a.id === FIST ? { keepId: true } : {});
    out.push(`+ ${a.name} (${a.id}): AE Fist Shell (cap 1 per hit)`);
  }
  // 3. Double Slap: 30% Stunned else Shaken (every copy of the skill on a Deva)
  for (const a of actorsNamed(/^deva$/i, DEVA)) {
    const it = a.items.get(SLAP) ?? a.items.find((i) => i.name === "Double Slap"); if (!it) continue;
    const P = it.system?.props ?? {}, upd = {};
    const et = P.effect_table ?? {}; let k = Number(nextKey(et));
    for (const r of SLAP_ROWS) if (!Object.values(et).some((x) => x?.effect_label === r.effect_label)) upd[`system.props.effect_table.${k++}`] = r;
    for (const [rk, r] of Object.entries(P.reaction_config_table ?? {})) if (r?.reaction_source_skill === "Double Slap" && r.reaction_effect_ref === "sl_shaken") upd[`system.props.reaction_config_table.${rk}.reaction_effect_ref`] = "sl_roll";
    if (P.description !== SLAP_TEXT) upd["system.props.description"] = SLAP_TEXT;
    if (Object.keys(upd).length) { await it.update(upd); out.push(`~ ${a.name}${a.isToken ? " (token)" : ""} / Double Slap: ${Object.keys(upd).map((x) => x.replace("system.props.", "")).join(", ")}`); }
    const al = a.system?.props?.attack_list?.[it.id];
    if (al && al.attack_description !== SLAP_TEXT) { await a.update({ [`system.props.attack_list.${it.id}.attack_description`]: SLAP_TEXT }); out.push(`~ ${a.name}${a.isToken ? " (token)" : ""}: sheet entry Double Slap text`); }
  }
  if (!out.length) out.push("= Deva tuning already applied (or no Deva in the world)");
  for (const l of out) log(l);
  return { applied: true, summary: out.join(" | ") };
}
