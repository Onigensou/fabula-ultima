/**
 * Migration: 2026-11-28-asura-update  (Asura post-playtest update)
 * ---------------------------------------------------------------------------
 * Approved by the user 2026-11-28 after the manual Valley trio playtest
 * (session-planning/2026-11-28/notes.md, To-do 1-6; memory project_asura_air_vs_flying).
 * Report: reports/2026-11-28-asura-update.md.
 *
 *   A. IM Paralyzed. Paralyzed disables the Skill action = his Enchants + Asura
 *      Strike, i.e. his whole clock (same call as Rakshasa 11-28).
 *   B. Air Aspect reaches Flying. The "Air Aspect" AE template on Elemental Aspect
 *      gains `can_target_flying_with` (empty = any melee), read by
 *      snapshot.attackerCanMeleeFlying / CAN_REACH_FLYING on the NPC range gate.
 *      While Air is his Aspect, Elemental Slash (and Overflow) can hit flyers.
 *      Text: one line on the Air Aspect AE, and "Can target Flying creatures." on
 *      the Air line of both Elemental Slash items.
 *   C. AI hunts flyers. New pattern row: Sword Enchant - Air, priority 9 (3 above
 *      Asura Strike's 6: the picker's priority window then drops every other row,
 *      so the hunt is deterministic), condition `formula`:
 *        ENEMY_COUNT_FLYING > 0 && ENEMY_COUNT_GROUNDED == 0 && AE_COUNT_AIR_ASPECT == 0
 *      = every enemy still standing is Flying and Air is not his Aspect yet.
 *      The Enchant's 10 Air self-damage sets the Air Aspect (Elemental Aspect row 3).
 *   D. Overflow feeds the Aspect. Elemental Aspect's rows scoped to "Elemental Slash"
 *      (slash element/bonus + status marks) now read
 *      "Elemental Slash, Elemental Slash: Overflow" (comma list, engine same commit).
 *      Four-Armed Fury and Ascension ALREADY carry their own Overflow rows — not
 *      touched (adding Overflow to their Slash rows would count it twice).
 *   E. Asura Strike ignores Provoke: action keyword `ignore_provoke`
 *      (provoke-bypass.js, same commit). Taunts still apply.
 *   F. No Enchant swapping vs an all-flyer party (user call 2026-11-28). The Fire / Bolt /
 *      Ice Enchant rows ("self lacks <X> Mark") become formula rows that also need a
 *      grounded enemy:  AE_COUNT_<X>_MARK == 0 && ENEMY_COUNT_GROUNDED > 0
 *      so while only flyers stand he keeps the Air Aspect and slashes instead of
 *      replacing it. The Air Enchant row is untouched.
 *
 * Idempotent: every step checks the current value first and skips when already done.
 */

export const key = "2026-11-28-asura-update";
export const description = "Asura: IM Paralyzed; Air Aspect can target Flying (+ text); AI goes Air when only flyers remain; Overflow feeds Elemental Aspect; Asura Strike ignores Provoke; no Enchant swapping when only flyers remain.";

const ASURA = "0AwQ7wEDz4ISA9mA";
const ID = {
  aspect: "nYbYx0X2yfIdteZ7", airAspectAe: "nUaYGTfMlry3rDaZ",
  slash: "ohrbXuZkGB4hNrPp", slashEnch: "NkLZkuMIVqAZJgXl",
  strike: "NFruWlBHrgfNSJmM",
};
const FLYING_ID = "q6keqwDWUsEgSWDw"; // Flying keyword journal (keyword-registry.js)
const FLYING = `<a class="content-link" data-uuid="JournalEntry.${FLYING_ID}" data-id="${FLYING_ID}" data-type="JournalEntry">Flying</a>`;
const FLY_CHANGE = { key: "can_target_flying_with", mode: 0, value: "", priority: 20 };

const SLASH = "Elemental Slash";
const OVERFLOW = "Elemental Slash: Overflow";
const PATTERN_FORMULA = "ENEMY_COUNT_FLYING > 0 && ENEMY_COUNT_GROUNDED == 0 && AE_COUNT_AIR_ASPECT == 0";
const IGNORE_PROVOKE = "ignore_provoke";
// The pattern picker weighs every feasible row inside a 2-point window under the top
// one (gap 0/1/2 = weight 3/2/1, gap 3+ = out; actionReader-matchAndPickAction.js).
// 9 = 3 above Asura Strike (6), so the flyer hunt is deterministic when it is live.
const PRIORITY = "9";
const GATED_ENCHANTS = ["Fire", "Bolt", "Ice"];
export const enchantGateFormula = (el) => `AE_COUNT_${el.toUpperCase()}_MARK == 0 && ENEMY_COUNT_GROUNDED > 0`;

// A. ───────────────────────────────────────────────────────────────────────────
async function immuneParalyzed(actor, out) {
  if (actor.system?.props?.condition_paralyzed === "IM") { out.push("= A: already IM Paralyzed"); return; }
  const was = actor.system?.props?.condition_paralyzed;
  await actor.update({ "system.props.condition_paralyzed": "IM" });
  out.push(`~ A: condition_paralyzed ${was} -> IM`);
}

// B. ───────────────────────────────────────────────────────────────────────────
const withFlyChange = (changes) => (changes ?? []).some((c) => c?.key === FLY_CHANGE.key)
  ? null : [...(changes ?? []).map((c) => ({ ...c })), { ...FLY_CHANGE }];
const AIR_AE_LINE = `<p>Elemental Slash can target ${FLYING} creatures.</p>`;

async function airAspectReachesFlying(actor, out) {
  const aspect = actor.items.get(ID.aspect);
  const ae = aspect?.effects?.get(ID.airAspectAe);
  if (!ae) { out.push("! B: Air Aspect template not found"); return; }
  const patch = {};
  const changes = withFlyChange(ae.changes);
  if (changes) patch.changes = changes;
  const desc = String(ae.description ?? "");
  if (!desc.includes(FLYING_ID)) patch.description = desc + AIR_AE_LINE;
  const parts = Object.keys(patch); // read before update(), which stamps _id onto the patch
  if (parts.length) { await ae.update(patch); out.push(`~ B: Air Aspect template ${parts.join(" + ")}`); }
  else out.push("= B: Air Aspect template already reaches Flying");

  // A copy already applied to the actor (mid-fight save) gets the same change.
  for (const live of actor.effects ?? []) {
    if (String(live.name ?? "").trim() !== "Air Aspect") continue;
    const c = withFlyChange(live.changes);
    if (c) { await live.update({ changes: c }); out.push("~ B: live Air Aspect copy updated"); }
  }

  // The Air line of both Elemental Slash items.
  const AIR_TAIL = "Silence</a>d.</p></li></ul>";
  for (const id of [ID.slash, ID.slashEnch]) {
    const it = actor.items.get(id);
    const d = String(it?.system?.props?.description ?? "");
    if (!it) { out.push(`! B: item ${id} missing`); continue; }
    if (d.includes(FLYING_ID)) { out.push(`= B: ${it.name} text already says Flying`); continue; }
    if (!d.includes(AIR_TAIL)) { out.push(`! B: ${it.name} Air line not found, text left as is`); continue; }
    await it.update({ "system.props.description": d.replace(AIR_TAIL, `Silence</a>d. Can target ${FLYING} creatures.</p></li></ul>`) });
    out.push(`~ B: ${it.name} Air line + "Can target Flying creatures."`);
  }
}

// C. ───────────────────────────────────────────────────────────────────────────
async function airHuntPattern(actor, out) {
  const table = actor.system?.props?.action_pattern_table ?? {};
  const live = Object.entries(table).filter(([, r]) => r && !r.$deleted);
  const found = live.find(([, r]) => r.action_pattern_condition === "formula" && String(r.action_pattern_string ?? "").includes("ENEMY_COUNT_FLYING"));
  if (found) {
    const [k, r] = found;
    if (String(r.action_pattern_priority) === PRIORITY && r.action_pattern_string === PATTERN_FORMULA) { out.push("= C: flyer-hunt pattern row already present"); return; }
    await actor.update({ [`system.props.action_pattern_table.${k}.action_pattern_priority`]: PRIORITY,
      [`system.props.action_pattern_table.${k}.action_pattern_string`]: PATTERN_FORMULA });
    out.push(`~ C: flyer-hunt pattern row ${k} priority ${r.action_pattern_priority} -> ${PRIORITY}`); return;
  }
  const next = String(Math.max(-1, ...Object.keys(table).map((k) => Number(k)).filter(Number.isFinite)) + 1);
  await actor.update({ [`system.props.action_pattern_table.${next}`]: {
    $deleted: false,
    action_pattern_name: "Sword Enchant - Air",
    action_pattern_condition: "formula",
    action_pattern_string: PATTERN_FORMULA,
    action_pattern_value_1: "0", action_pattern_value_2: "0",
    action_pattern_priority: PRIORITY, action_pattern_cooldown: "0",
    action_pattern_hp_ceiling: "0", action_pattern_hp_reserve: "0",
    action_pattern_target_focus: "auto",
  } });
  out.push(`+ C: pattern row ${next} Sword Enchant - Air (priority ${PRIORITY}, formula)`);
}

// D. ───────────────────────────────────────────────────────────────────────────
async function overflowFeedsAspect(actor, out) {
  const aspect = actor.items.get(ID.aspect);
  const rows = aspect?.system?.props?.reaction_config_table ?? {};
  const patch = {};
  for (const [k, r] of Object.entries(rows)) {
    if (!r || r.$deleted) continue;
    if (String(r.reaction_source_skill ?? "").trim() !== SLASH) continue;
    patch[`system.props.reaction_config_table.${k}.reaction_source_skill`] = `${SLASH}, ${OVERFLOW}`;
  }
  const n = Object.keys(patch).length;
  if (!n) { out.push("= D: Elemental Aspect rows already accept Overflow"); return; }
  await aspect.update(patch);
  out.push(`~ D: Elemental Aspect ${n} rows "${SLASH}" -> "${SLASH}, ${OVERFLOW}"`);
}

// E. ───────────────────────────────────────────────────────────────────────────
async function strikeIgnoresProvoke(actor, out) {
  const it = actor.items.get(ID.strike);
  if (!it) { out.push("! E: Asura Strike missing"); return; }
  const kw = String(it.system?.props?.action_keywords ?? "");
  if (kw.split(/[,\n]+/).some((k) => k.trim().toLowerCase() === IGNORE_PROVOKE)) { out.push("= E: Asura Strike already ignores Provoke"); return; }
  const next = kw.trim() ? `${kw.trim()}, ${IGNORE_PROVOKE}` : IGNORE_PROVOKE;
  await it.update({ "system.props.action_keywords": next });
  out.push(`~ E: Asura Strike keywords "${kw}" -> "${next}"`);
}

// F. ───────────────────────────────────────────────────────────────────────────
/** Pattern-table patch gating the Fire/Bolt/Ice Enchant rows on a grounded enemy. */
export function enchantGatePatch(table = {}) {
  const patch = {};
  for (const [k, r] of Object.entries(table)) {
    if (!r || r.$deleted) continue;
    const el = GATED_ENCHANTS.find((e) => r.action_pattern_name === `Sword Enchant - ${e}`);
    if (!el) continue;
    const formula = enchantGateFormula(el);
    if (r.action_pattern_condition === "formula" && r.action_pattern_string === formula) continue;
    if (r.action_pattern_condition !== "self_lacks_status") continue; // hand-edited: leave it
    patch[`system.props.action_pattern_table.${k}.action_pattern_condition`] = "formula";
    patch[`system.props.action_pattern_table.${k}.action_pattern_string`] = formula;
  }
  return patch;
}
async function gateEnchantsOnGround(actor, out) {
  const patch = enchantGatePatch(actor.system?.props?.action_pattern_table ?? {});
  const n = Object.keys(patch).length / 2;
  if (!n) { out.push("= F: Fire/Bolt/Ice Enchant rows already gated"); return; }
  await actor.update(patch);
  out.push(`~ F: ${n} Enchant rows -> formula (needs a grounded enemy)`);
}

export async function migrate(game, log = () => {}) {
  const out = [];
  const actor = game.actors.get(ASURA);
  if (!actor) return { applied: false, summary: "Asura actor not found" };
  await immuneParalyzed(actor, out);
  await airAspectReachesFlying(actor, out);
  await airHuntPattern(actor, out);
  await overflowFeedsAspect(actor, out);
  await strikeIgnoresProvoke(actor, out);
  await gateEnchantsOnGround(actor, out);
  for (const l of out) log(l);
  return { applied: true, summary: out.join(" | ") };
}
