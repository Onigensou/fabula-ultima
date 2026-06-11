/**
 * Migration: 2026-06-12-dungeon-inferex-chomp-author
 * ---------------------------------------------------------------------------
 * Inferex "Chomp" — CONFIG pass (items 2–4). The Pierce-when-damage≥100 clause
 * (item 1) needs a new conditional-Pierce mechanism and is handled separately.
 *
 *   2. SCOPE the Kill-Frenzy grant. `chomp_kill_apply` reacts on
 *      creature_deals_damage / self / TARGET_CURRENT_HP <= 0 — with NO skill gate,
 *      so it grants Kill Frenzy on ANY Inferex kill (verified: it fires during a
 *      Blast Breath / Voracious kill too). RAW: "When THIS ATTACK [Chomp] reduces
 *      a target to 0 HP." Add `TRIGGER_IS_SELF == 1 &&` so it only fires on a
 *      Chomp kill.
 *   3. DEDUP the embedded "Kill Frenzy" template. The Chomp item carries 40+
 *      duplicate embedded "Kill Frenzy" AEs (authoring pollution). Keep ONE
 *      (prefer the directorPermanent copy = scene-lasting, charges 1), delete the
 *      rest — resolveAeTemplate clones whichever it finds, so the dupes are noise.
 *   4. stack → add_charges. `chomp_kill_apply` used ae_duplicate_mode "stack"
 *      (a fresh Kill Frenzy AE per kill); switch to add_charges + ae_initial_charges
 *      1 so kills grow ONE AE's charge count (charge-as-stack; AE_CHARGES_KILL_FRENZY
 *      reads the stack total either way, but one growing AE is clean + one badge).
 *
 *   5. +100%/stack as a MULTIPLIER. chomp_kill_bonus was additive `(HR + 45)`
 *      (Chomp's base) on an UNSCOPED creature_will_deal_damage reaction — so on a
 *      non-Chomp attack it added Chomp's number, not a true +100%. Retype to
 *      `damage_operation: "multiply"`, `damage_amount: "1 + AE_CHARGES_KILL_FRENZY"`
 *      (1 stack → ×2, 2 → ×3, …). Kept unscoped so it boosts ALL the Inferex's
 *      attacks per RAW ("this creature gains 100% increased damage"). Uses the
 *      existing outgoing multiply op (computeSenderDamageBonuses → applyDamageOp).
 *
  *   1. Pierce when the FINAL hit (post ×Kill-Frenzy) ≥ 100. Generic
 *      `apply_action_keyword` effect_kind (keyword "pierce") on a Chomp-scoped
 *      reaction: creature_will_deal_damage / self / `TRIGGER_IS_SELF == 1` →
 *      chomp_pierce, with the threshold on the EFFECT row's `condition_formula`
 *      = `FINAL_DAMAGE >= 100`. FINAL_DAMAGE is evaluated AFTER the pre-resolve
 *      bonuses (the ×Kill-Frenzy multiply), so the gate sees the real outgoing
 *      hit — a discovery-time reaction condition (RAW_DAMAGE, pre-multiply)
 *      could not. Pierce treats the target's Resistance (RS) as neutral for that
 *      hit (RS only; VU/IM/AB unchanged), applied in recomputePerTargetDamages.
 *      Reusable: any "apply keyword X when FINAL_DAMAGE/… condition" is a reaction
 *      row + apply_action_keyword, no deal_damage changes. Requires the engine
 *      pieces (apply_action_keyword kind, FINAL_DAMAGE identifier, keyword-condition
 *      pass + recompute pierce branch) — cross-module → hard refresh to go live.
 *
 * RUN ONCE (NOT manifest-tagged idempotent) so it won't re-apply over a co-dev's
 * later edits; the patch logic is still drift-safe if re-run. Inferex is a co-dev
 * world actor; sharing via WORLD-DATA PUSH (feedback_world_data_sharing_hazard).
 */

export const key = "2026-06-12-dungeon-inferex-chomp-author";
export const description =
  "Inferex Chomp config (2-4): scope chomp_kill_apply to Chomp kills " +
  "(TRIGGER_IS_SELF); dedup 40+ embedded 'Kill Frenzy' templates to 1 " +
  "(directorPermanent, charges 1); chomp_kill_apply stack→add_charges; " +
  "chomp_kill_bonus → multiply by (1 + AE_CHARGES_KILL_FRENZY) (+100%/stack, all attacks); " +
  "Pierce via apply_action_keyword(pierce), Chomp-scoped reaction + effect-row " +
  "condition_formula FINAL_DAMAGE>=100 (RS→neutral, post-multiply).";

const ACTOR_NAME = "Inferex";
const NS = "fabula-ultima-companion";

function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const keys = Object.keys(v).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}
const deepEqual = (a, b) => stableStringify(a) === stableStringify(b);

// Patch chomp_kill_apply's effect row (add_charges + ae_initial_charges) — clone,
// edit, return the table or null if no drift.
function buildEffectTable(item) {
  const src = item.system?.props?.effect_table;
  if (!src || typeof src !== "object") return null;
  const table = foundry.utils.deepClone(src);
  let hasPierce = false;
  for (const row of Object.values(table)) {
    if (row?.effect_label === "chomp_kill_apply") {
      row.ae_duplicate_mode = "add_charges";
      row.ae_initial_charges = "1";
    }
    // +100% damage per Kill Frenzy stack as a generic MULTIPLIER (works on any
    // attack's damage, not just Chomp). 1 stack → ×2, 2 → ×3, … Was an additive
    // `(HR + 45)` (Chomp's base), which wasn't a true +100% on other attacks.
    if (row?.effect_label === "chomp_kill_bonus") {
      row.damage_operation = "multiply";
      row.damage_amount = "1 + AE_CHARGES_KILL_FRENZY";
    }
    if (row?.effect_label === "chomp_pierce") {
      hasPierce = true;
      row.effect_kind = "apply_action_keyword";
      row.action_keyword = "pierce";
      // Gate on the POST-bonus hit (after the ×Kill-Frenzy multiply), evaluated
      // in the keyword-condition pass — a discovery-time reaction couldn't see it.
      row.condition_formula = "FINAL_DAMAGE >= 100";
    }
  }
  // Item 1 — Pierce when the final hit (post ×Kill-Frenzy) is ≥ 100. Generic
  // apply_action_keyword(pierce) gated by FINAL_DAMAGE; pierce treats RS as neutral.
  if (!hasPierce) {
    const nextKey = String(1 + Math.max(-1, ...Object.keys(table).map((k) => Number(k)).filter(Number.isFinite)));
    table[nextKey] = { effect_label: "chomp_pierce", effect_kind: "apply_action_keyword", action_keyword: "pierce", condition_formula: "FINAL_DAMAGE >= 100" };
  }
  return table;
}

function buildReactionTable(item) {
  const src = item.system?.props?.reaction_config_table;
  if (!src || typeof src !== "object") return null;
  const table = foundry.utils.deepClone(src);
  let hasPierceRx = false;
  for (const row of Object.values(table)) {
    if (row?.reaction_effect_ref === "chomp_kill_apply") {
      row.condition_formula = "TRIGGER_IS_SELF == 1 && TARGET_CURRENT_HP <= 0";
    }
    if (row?.reaction_effect_ref === "chomp_pierce") {
      hasPierceRx = true;
      // Reaction just says "this is a Chomp hit"; the ≥100 gate moved to the
      // effect row's condition_formula (FINAL_DAMAGE, post-multiply).
      row.condition_formula = "TRIGGER_IS_SELF == 1";
    }
  }
  // Pierce reaction — pre-resolve, per target, scoped to Chomp. The big-hit gate
  // lives on the effect row (FINAL_DAMAGE >= 100), evaluated post-bonus.
  if (!hasPierceRx) {
    const nextKey = String(1 + Math.max(-1, ...Object.keys(table).map((k) => Number(k)).filter(Number.isFinite)));
    table[nextKey] = {
      reaction_trigger: "creature_will_deal_damage",
      reaction_source: "self",
      reaction_passive_mode: "on",
      condition_formula: "TRIGGER_IS_SELF == 1",
      reaction_effect_ref: "chomp_pierce",
    };
  }
  return table;
}

async function dedupKillFrenzy(item, log) {
  const dupes = item.effects.filter((e) => e.name === "Kill Frenzy");
  if (dupes.length <= 1) {
    // Ensure the single survivor is canonical (scene-lasting, 1 charge).
    if (dupes.length === 1) await ensureCanonical(dupes[0]);
    return dupes.length === 1 ? 0 : 0;
  }
  // Keep the directorPermanent copy if present, else the first.
  const keep = dupes.find((e) => e.flags?.[NS]?.directorPermanent === true) ?? dupes[0];
  const drop = dupes.filter((e) => e.id !== keep.id).map((e) => e.id);
  await item.deleteEmbeddedDocuments("ActiveEffect", drop);
  await ensureCanonical(item.effects.find((e) => e.name === "Kill Frenzy"));
  log(`  [${item.parent?.name}] Chomp/Kill Frenzy: deduped ${dupes.length} → 1 (deleted ${drop.length})`);
  return 1;
}

async function ensureCanonical(ae) {
  if (!ae) return;
  const f = ae.flags?.[NS] ?? {};
  const upd = {};
  if (f.directorPermanent !== true) upd[`flags.${NS}.directorPermanent`] = true;
  if (Number(f.charges) !== 1) upd[`flags.${NS}.charges`] = 1;
  if (Object.keys(upd).length) await ae.update(upd);
}

async function patchActor(actor, log) {
  const chomp = actor.items.find((i) => i.name === "Chomp");
  if (!chomp) { log(`  [${actor.name}] "Chomp": item not found — skipped`); return 0; }
  let changed = 0;

  const et = buildEffectTable(chomp);
  if (et && !deepEqual(chomp.system?.props?.effect_table ?? {}, et)) {
    await chomp.update({ "system.props.-=effect_table": null });
    await chomp.update({ "system.props.effect_table": et });
    log(`  [${actor.name}] Chomp.effect_table: chomp_kill_apply → add_charges +1`);
    changed++;
  }

  const rt = buildReactionTable(chomp);
  if (rt && !deepEqual(chomp.system?.props?.reaction_config_table ?? {}, rt)) {
    await chomp.update({ "system.props.reaction_config_table": rt });
    log(`  [${actor.name}] Chomp.reaction: chomp_kill_apply scoped (TRIGGER_IS_SELF)`);
    changed++;
  }

  changed += await dedupKillFrenzy(chomp, log);
  return changed;
}

export async function migrate(game, log = () => {}) {
  const actors = (game.actors?.contents ?? []).filter((a) => a.name === ACTOR_NAME);
  if (!actors.length) return { applied: false, summary: `No "${ACTOR_NAME}" actor found` };
  let changed = 0;
  for (const actor of actors) changed += await patchActor(actor, log);
  return { applied: true, summary: `Inferex Chomp config patched (changes: ${changed})` };
}
