// ───────────────────────────────────────────────────────────────────────────
// The CONFIG half of the regression net.
//
// `collect.js` fingerprints what a skill DOES when COMPUTE runs it. That misses
// three whole classes of change, each of which shipped a real defect on
// 2026-08-09 while the behavioral golden stayed green:
//
//   1. Config COMPUTE never reads. `skill_tags: "dance, managed"` is what the
//      Dance framework matches on to bill the MP and set the `Dancing` marker.
//      26 wired dances lost it in a sync and the golden did not move.
//      Same for `target_eligibility` (the action-picker filter) and for an AE
//      change VALUE — Wardancer's +SL was ungated and no fingerprint noticed.
//   2. SKIPPED skills. `skip.json` entries record `reason:"skipped"` and nothing
//      else, so an interactive skill has no content coverage at all.
//   3. Skills that leave the roster. The collector only walks USABLE skills, so
//      flipping `skill_type` to Passive drops a doc out entirely — it reports as
//      "REMOVED" once and is then unwatched forever.
//
// This module fingerprints the DOCUMENT instead of the run: every skill-shaped
// doc in the world, whether or not it is usable, skipped, or reachable. It
// needs no bench and no COMPUTE — just the game open — so it costs seconds.
//
// Deliberately EXCLUDED (churn, not content): description/img/uuid/id, `level`
// and `max_level` (legitimately per-copy), battle logs, `_stats`, and animation
// timing. Everything kept is something an engine gate or the framework reads.
// ───────────────────────────────────────────────────────────────────────────
"use strict";

const NS = "fabula-ultima-companion";

/** Props whose value changes behaviour. Anything not listed is ignored. */
const KEPT_PROPS = [
  "skill_type", "isReaction", "isHeroic", "isOffensiveSpell", "isCheck", "isZeroPower",
  "cost", "skill_target", "target_eligibility", "skill_tags", "skill_range",
  "on_activate_effect_ref", "pre_activate_effect_ref", "post_damage_effect_ref",
  "type_damage", "damage_bonus", "check_bonus", "defense_target_type",
  "rolled_atr1", "rolled_atr2", "container", "item_type", "isEquipped",
  "action_keywords", "ignore_hr",
  // Whether the skill can be picked AT ALL (skill-picker.js ~L374): falsy
  // dims it with `availability_reason`. Adding Bimagus's missing
  // `HAS_ARCANE_WEAPON == 1` gate to 6 docs moved nothing here, which is the
  // failure mode — a skill silently LOSING its gate would read as unchanged.
  "availability_formula", "availability_reason",
  // `duration` is behaviour-bearing: ACTION_DURATION (skill-formulas ~L1115)
  // ranks this free-form string 0/1/2 and gates on it (Cataclysm is
  // instantaneous-only; Follow my lead needs >= 1). A TYPO silently reranks the
  // skill — Solar Beam shipped "Instnataneous", which the `includes("instant")`
  // normaliser does not catch, so it ranked 1 and would have lost Cataclysm.
  "duration",
];

// ⚠ KEPT_PROPS is an ALLOWLIST, so every prop nobody thought to list is a blind
// spot — the two above were found only because a live edit produced no drift.
// The header comment above describes a DENYLIST ("deliberately excluded: churn"),
// which is the shape that cannot under-cover; `skill-claims render` already
// works that way ("add a field to the data model and it appears with no code
// change"). Worth flipping, but that is a re-baseline of every doc carrying a
// previously-unwatched prop, so it is left as a deliberate follow-up rather
// than smuggled in alongside a two-field fix.

/** Row fields that are noise rather than behaviour. */
const ROW_NOISE = new Set(["menu_description", "menu_label", "menu_title", "menu_subtitle",
  "menu_option_labels", "menu_option_descriptions", "menu_option_colors", "menu_option_icons"]);

const blank = (v) => v === undefined || v === null || v === "" || v === false;

/** One table row -> a stable "k=v" list, empties dropped, sorted. */
function rowSig(row, { keepNoise = false } = {}) {
  if (!row || typeof row !== "object") return null;
  const parts = [];
  for (const k of Object.keys(row).sort()) {
    if (!keepNoise && ROW_NOISE.has(k)) continue;
    const v = row[k];
    if (blank(v)) continue;
    parts.push(`${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
  }
  return parts.join(" ");
}

function tableSig(table, opts) {
  const out = [];
  for (const k of Object.keys(table || {}).sort((a, b) => Number(a) - Number(b))) {
    const s = rowSig(table[k], opts);
    if (s) out.push(s);
  }
  return out;
}

/**
 * @param {object} doc  a plain skill/item object: { name, effects, system:{props} }
 * @returns {object|null} null when the doc carries nothing worth watching
 */
function structureOf(doc) {
  const p = doc?.system?.props ?? {};
  const props = {};
  for (const k of KEPT_PROPS) {
    const v = p[k];
    if (blank(v)) continue;
    props[k] = typeof v === "object" ? JSON.stringify(v) : String(v);
  }

  const effects = tableSig(p.effect_table);
  const reactions = tableSig(p.reaction_config_table);

  const aes = (doc.effects ?? []).map((e) => {
    const cfg = e?.flags?.[NS]?.reactionConfig ?? null;
    const rec = {
      name: e.name,
      transfer: !!e.transfer,
      disabled: !!e.disabled,
      statuses: [...(e.statuses ?? [])].sort(),
      tags: [...(e?.system?.tags ?? [])].sort(),
      // the flags the engine reads; ignore CSB's own bookkeeping
      family: e?.flags?.[NS]?.aeFamily ?? null,
      lifetime: e?.flags?.[NS]?.lifetimeMode ?? null,
      charges: e?.flags?.[NS]?.chargesMax ?? null,
      // AE change VALUES are load-bearing (an ungated `${level}$` vs a gated
      // aeWhen(...) is the whole Wardancer bug) — keep them verbatim.
      changes: (e.changes ?? []).map((c) => `${c.key} mode${c.mode} = ${c.value}`).sort(),
    };
    if (cfg) {
      rec.aeReactions = tableSig(cfg.reaction_config_table);
      rec.aeEffects = tableSig(cfg.effect_table);
    }
    return rec;
  }).sort((a, b) => String(a.name).localeCompare(String(b.name)));

  const empty = !Object.keys(props).length && !effects.length && !reactions.length
    && !aes.some((a) => a.changes.length || a.aeReactions || a.statuses.length);
  if (empty) return null;

  return { props, effects, reactions, aes };
}

/**
 * Recursive diff producing "path: a → b" lines.
 *
 * Arrays are walked element-wise rather than compared as blobs — dumping a
 * whole `aes` array as one JSON string on both sides is technically a diff and
 * practically unreadable, which defeats the point of a 2am regression report.
 * Arrays of objects carrying a `name` are matched BY NAME (AEs reorder freely);
 * arrays of strings are diffed as added/removed sets (effect + reaction rows).
 */
function diffStructure(a, b, prefix = "") {
  const out = [];
  const keys = [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])].sort();
  for (const k of keys) {
    const av = a?.[k];
    const bv = b?.[k];
    const path = prefix ? `${prefix}.${k}` : k;

    if (Array.isArray(av) || Array.isArray(bv)) {
      const aa = Array.isArray(av) ? av : [];
      const ba = Array.isArray(bv) ? bv : [];
      const named = [...aa, ...ba].every((x) => x && typeof x === "object" && "name" in x);
      if (named) {
        const byName = (arr) => new Map(arr.map((x) => [String(x.name), x]));
        const A = byName(aa), B = byName(ba);
        for (const n of [...new Set([...A.keys(), ...B.keys()])].sort()) {
          if (!A.has(n)) { out.push(`${path}[${n}]: (absent) → present`); continue; }
          if (!B.has(n)) { out.push(`${path}[${n}]: present → (removed)`); continue; }
          out.push(...diffStructure(A.get(n), B.get(n), `${path}[${n}]`));
        }
        continue;
      }
      // plain values (row signatures) — report as set membership
      const setA = new Set(aa.map((x) => JSON.stringify(x)));
      const setB = new Set(ba.map((x) => JSON.stringify(x)));
      for (const s of [...setA].filter((x) => !setB.has(x)).sort()) out.push(`${path}: removed ${s}`);
      for (const s of [...setB].filter((x) => !setA.has(x)).sort()) out.push(`${path}: added   ${s}`);
      continue;
    }

    const aIsObj = av && typeof av === "object";
    const bIsObj = bv && typeof bv === "object";
    if (aIsObj || bIsObj) { out.push(...diffStructure(av ?? {}, bv ?? {}, path)); continue; }
    const as = JSON.stringify(av ?? null);
    const bs = JSON.stringify(bv ?? null);
    if (as !== bs) out.push(`${path}: ${as} → ${bs}`);
  }
  return out;
}

module.exports = { structureOf, diffStructure, KEPT_PROPS };
