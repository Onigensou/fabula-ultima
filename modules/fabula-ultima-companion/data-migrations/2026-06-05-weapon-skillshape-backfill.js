/**
 * Migration: 2026-06-05-weapon-skillshape-backfill
 * ---------------------------------------------------------------------------
 * Weapons-as-skill-shaped-items (Option B), step 2 of 3 — data backfill.
 *
 * Runs AFTER 2026-06-05-weapon-skillshape-template (which adds the columns).
 *
 * Two jobs:
 *
 * 1. DEFAULT skill_target. Every weapon Item (world master + actor copy) that
 *    lacks a skill_target gets "One Enemy" so the unified targeting resolver
 *    (resolveActionTargets) and the Attack TARGET branch have a value to read.
 *    Weapons authored with a wider target (e.g. "All Enemies") are left alone.
 *
 * 2. LEGACY on-hit census + (where unambiguous) conversion. The legacy
 *    `active_effect_config_table` weapon on-hit mechanism is consumed only by
 *    the pre-BD Action Pipeline macros — the Director never reads it. To make
 *    those on-hit effects fire in the BD, each row needs to become a
 *    `creature_deals_damage` reaction_config_table row → an effect_table
 *    apply_ae row (target_ref: "hit_action_targets").
 *
 *    Per [[no-per-skill-custom-logic]] / "surface the gap, don't fake the
 *    mechanic": we ONLY auto-convert rows whose semantics map cleanly and
 *    UNAMBIGUOUSLY (registered in LEGACY_MODE_CONVERTERS). Everything else is
 *    REPORTED (logged + counted), not silently mis-converted. As of authoring,
 *    the live world holds two modes — both NON-trivial — so this run reports
 *    rather than converts; the converters land once the semantics are locked:
 *
 *      - "conquer"    : margin/DL-gated status infliction ("Conquer 5 → Stagger,
 *                       Conquer 8 → Frightened"). Needs a TOTAL >= DL condition
 *                       + a per-DL status→AE mapping. NOT a flat apply_ae.
 *      - "percentage" : an N% CHANCE to apply the AE referenced by
 *                       active_effect_id. BD apply_ae has NO probability gate,
 *                       so converting it would make it fire 100% of the time —
 *                       a behavior change, not a port. Needs an engine "chance"
 *                       capability first.
 *
 *    Converted rows are MOVED (cleared from active_effect_config_table) for a
 *    single source of truth. Reported rows are LEFT untouched so the legacy
 *    data (and the guarded legacy macro path) stays intact until ported.
 *
 * IDEMPOTENT: skill_target default skips weapons already set; conversion skips
 * weapons that already carry the converted effect_table/reaction rows.
 */

export const key = "2026-06-05-weapon-skillshape-backfill";
export const description =
  "Default skill_target on weapons; census legacy active_effect_config_table " +
  "on-hit rows and convert the unambiguous ones to creature_deals_damage " +
  "reaction + effect_table apply_ae (others reported, not faked).";

const DEFAULT_TARGET = "One Enemy";

// Registry of legacy apply_mode → converter. A converter returns
//   { effectRow, reactionRow }  to inject, or null to DECLINE (report only).
// Intentionally empty for the ambiguous modes present in the world today —
// see the file header. Add entries here once a mode's semantics are locked.
const LEGACY_MODE_CONVERTERS = {
  // "somemode": (row, weaponItem) => ({ effectRow, reactionRow }),
};

function isWeapon(item) {
  return String(item?.system?.props?.item_type ?? "").toLowerCase() === "weapon";
}

function liveRows(table) {
  if (!table || typeof table !== "object") return [];
  return Object.entries(table)
    .filter(([, r]) => r && !r.$deleted)
    .map(([k, r]) => ({ k, r }));
}

// Returns { targetUpdate, report:[...], convertUpdate } for one weapon.
function planWeapon(item) {
  const props = item.system?.props ?? {};
  const out = { targetUpdate: null, report: [], convertUpdate: null };

  // (1) skill_target default.
  const st = String(props.skill_target ?? "").trim();
  if (!st) out.targetUpdate = DEFAULT_TARGET;

  // (2) legacy on-hit rows.
  const legacy = liveRows(props.active_effect_config_table);
  if (legacy.length) {
    const newEffect = foundry.utils.duplicate(props.effect_table ?? {});
    const newReaction = foundry.utils.duplicate(props.reaction_config_table ?? {});
    const newLegacy = foundry.utils.duplicate(props.active_effect_config_table ?? {});
    let converted = 0;
    let nextEffectKey = liveRows(newEffect).length;
    let nextReactionKey = liveRows(newReaction).length;

    for (const { k, r } of legacy) {
      const mode = String(r.active_effect_apply_mode ?? "").toLowerCase().trim();
      const conv = LEGACY_MODE_CONVERTERS[mode];
      if (!conv) {
        out.report.push({
          weapon: item.name, itemId: item.id, mode,
          trigger: String(r.active_effect_trigger ?? ""),
          percent: r.active_effect_percent, dl: r.active_effect_dl,
          effectId: r.active_effect_id,
          reason: "no registered converter (ambiguous semantics)",
        });
        continue;
      }
      const built = conv(r, item);
      if (!built) {
        out.report.push({ weapon: item.name, itemId: item.id, mode, reason: "converter declined" });
        continue;
      }
      newEffect[String(nextEffectKey++)] = built.effectRow;
      newReaction[String(nextReactionKey++)] = built.reactionRow;
      newLegacy[k] = { $deleted: true }; // MOVE: drop the converted legacy row
      converted++;
    }

    if (converted > 0) {
      out.convertUpdate = {
        "system.props.effect_table": newEffect,
        "system.props.reaction_config_table": newReaction,
        "system.props.active_effect_config_table": newLegacy,
      };
    }
  }

  return out;
}

export async function migrate(game, log) {
  const report = [];
  let targetDefaulted = 0;
  let converted = 0;

  async function processCollection(items, applyUpdate) {
    for (const item of items) {
      if (!isWeapon(item)) continue;
      let plan;
      try { plan = planWeapon(item); }
      catch (e) { log(`plan failed for "${item.name}" [${item.id}]: ${e?.message ?? e}`); continue; }

      const update = {};
      if (plan.targetUpdate) { update["system.props.skill_target"] = plan.targetUpdate; }
      if (plan.convertUpdate) { Object.assign(update, plan.convertUpdate); converted++; }
      if (plan.targetUpdate) targetDefaulted++;
      report.push(...plan.report);

      if (Object.keys(update).length) {
        try { await applyUpdate(item, update); }
        catch (e) { log(`update failed for "${item.name}" [${item.id}]: ${e?.message ?? e}`); }
      }
    }
  }

  // World masters.
  await processCollection(game.items?.contents ?? [], (item, u) => item.update(u));
  // Actor-embedded copies.
  for (const actor of game.actors?.contents ?? []) {
    await processCollection(actor.items?.contents ?? [], (item, u) => item.update(u));
  }

  // Report unconverted legacy rows so they aren't silently lost.
  if (report.length) {
    log(`LEGACY on-hit rows NOT auto-converted (${report.length}) — left intact, need manual/feature port:`);
    for (const r of report) {
      log(`  • ${r.weapon}: mode="${r.mode}" trigger="${r.trigger ?? ""}" ` +
          `percent=${r.percent ?? ""} dl=${r.dl ?? ""} effectId=${r.effectId ?? ""} — ${r.reason}`);
    }
  }

  return {
    applied: true,
    summary: `skill_target defaulted on ${targetDefaulted} weapon(s); ` +
      `${converted} weapon(s) had legacy on-hit rows converted; ` +
      `${report.length} legacy row(s) reported (not converted).`,
  };
}
