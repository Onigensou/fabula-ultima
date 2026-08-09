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
// ── WATCHING: a DENYLIST, not an allowlist ────────────────────────────────
// This was an allowlist of 28 hand-picked props until 2026-08-10. An allowlist
// makes every prop nobody thought to list a permanent blind spot, and the two
// most recent additions (`availability_formula`, `duration`) were both found the
// same way: a real live edit produced NO drift. That is the failure mode
// announcing itself twice.
//
// A census of the authored corpus (3557 skill-shaped docs, 141 distinct prop
// keys) put a number on the gap — 113 of 141 keys were unwatched, including:
//
//   custom_logic_action (88 docs) / custom_logic_resolution (77)
//   passive_logic_action (67) / passive_logic_resolution (23)
//                       ...executable behaviour. Edit the code a skill runs and
//                       the config golden said "unchanged".
//   weapon_range (1273)  ...the EXACT prop whose blank value silently killed 10
//                       melee gates — trigger fires, candidate matches, gate
//                       declines (see feedback_monster_attack_blank_range…).
//   hand_slots, item_rarity, set_name, isSet, isMartial, isFacet,
//   heroic_requirement, item_baseDef/Mdef, ip_cost, related_item_list,
//   item_skill_active/passive, action_command, check_mode, has_pierce, …
//
// Each of those was confirmed read by engine code, not inferred from its name.
// So the rule is inverted: everything is watched unless it is listed below as
// churn. `skill-claims render` already works this way — "add a field to the data
// model and it shows up with no code change" — and that is the only shape that
// cannot under-cover.
// ───────────────────────────────────────────────────────────────────────────
"use strict";

const crypto = require("crypto");

const NS = "fabula-ultima-companion";

/**
 * CHURN — moves without behaviour changing, or is presentation only.
 * Anything not matched here is watched. Add to this list only with a reason.
 */
const CHURN_PROPS = [
  // Identity + provenance. `name` and `id` are how the golden KEYS a doc
  // (collect-structure.js), so recording them again inside the value would make
  // every rename a double-report.
  /^(id|uuid|name|img)$/,
  // Prose for humans. `skill_information` and `details_roller` have zero engine
  // readers; the rest reach only sheet/chat rendering. NOTE `heroic_requirement`
  // is deliberately NOT here — it reads like prose but requirement-eval.js
  // parses it, so it is content.
  /^(description|skill_description|skill_information|flavor_text|set_description|details_roller)$/,
  // Legitimately per-copy: the same master sits at different ranks on different
  // actors, which is authoring, not drift.
  /^(level|max_level)$/,
  // Written by PLAY (and by every sim run), never authored — same rationale as
  // world-export's VOLATILE_PROPS.
  /^battle_log(_table)?$/,
  // Presentation. Timing offsets, JB2A asset URLs, and the animation script are
  // all cosmetic; `animation_script` alone is 632 docs of HTML that would swamp
  // the diff surface this tool exists to keep readable.
  /^skill_animation_/, /^animation_/,
  // CSB bookkeeping, not authored config.
  /^(optional_params|use_optional_params|\$deleted)$/,
];

const isChurn = (k) => CHURN_PROPS.some((re) => re.test(k));

/**
 * Template defaults every document carries whether or not anyone authored them:
 * the ~27 species affinities sit at 100 (neutral), unset flags at false, unset
 * numerics at 0. Recording them would add ~33k inert entries to the golden and
 * bury the handful that were actually set.
 *
 * Suppressing a default costs NO signal, because it is suppressed on both
 * sides: `item_def_bonus 2 -> 0` still reports as `present -> (removed)`, and
 * `0 -> 2` as `(absent) -> present`. Same mechanism `blank()` already used.
 */
function isTemplateDefault(k, s) {
  if (/_ef$/.test(k)) return s === "100";           // species affinity, neutral
  if (/^(is|has|use)[A-Z_]/.test(k)) return s === "false";
  return s === "0" || s === "+0" || s === "-" || s === "false";
}

// Long values (the custom_logic_* / passive_logic_* code blobs, big projection
// tables) are stored as a content hash: still an exact change detector, but the
// golden stays a reviewable size instead of carrying 88 embedded HTML scripts.
const HASH_OVER = 240;
const digest = (s) => `#sha1:${crypto.createHash("sha1").update(s).digest("hex").slice(0, 16)} (${s.length} chars)`;

/** Row fields that are noise rather than behaviour. */
const ROW_NOISE = new Set(["menu_description", "menu_label", "menu_title", "menu_subtitle",
  "menu_option_labels", "menu_option_descriptions", "menu_option_colors", "menu_option_icons"]);

const blank = (v) => {
  if (v === undefined || v === null || v === "" || v === false) return true;
  // An empty table/array is "unset", not content — 2331 docs carry an empty
  // `active_effect_config_table` and 14 an empty `reaction_effect_table`.
  if (typeof v === "object") return !Object.keys(v).length;
  return false;
};

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
  for (const k of Object.keys(p).sort()) {
    if (isChurn(k)) continue;
    const v = p[k];
    if (blank(v)) continue;
    // The two big tables get their own row-wise signatures below; keeping them
    // here as well would double-report every row edit.
    if (k === "effect_table" || k === "reaction_config_table") continue;
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    if (isTemplateDefault(k, s)) continue;
    props[k] = s.length > HASH_OVER ? digest(s) : s;
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

module.exports = { structureOf, diffStructure, CHURN_PROPS, isChurn };
