/**
 * Migration: 2026-07-14-arcanist-avatar-vengeance-author
 * ---------------------------------------------------------------------------
 * Author the Arcanist summon loop + Hina's first Arcanum, "Avatar of Vengeance".
 *
 * Pieces:
 *  1. Bind and Summon (Hina's existing skill) → rewired to the summon control
 *     surface: skill_type "Active", cost "" (the effect does its own debit), and
 *     on_activate → a single `summon_arcanum` row. The MP cost formula bakes in
 *     Emergency Arcanum: `40 - HAS_STATUS_CRISIS * SL_EMERGENCY_ARCANUM * 5`
 *     (Emergency Arcanum stays a pure passive — its SL is read here, no rows of
 *     its own).
 *  2. "Avatar of Vengeance" — an Arcanum CONTAINER item on the _Arcanum Template
 *     (flag isArcanum, domain "Vengeance, Burn", element "fire").
 *  3. Three linked child _skills (container = the Arcanum's uniqueId — stable
 *     across master + actor copy; each carries arcanum_role). While the Arcanum is
 *     MERGED, the usable children surface as first-class actor skills (the picker
 *     lets a merged Arcanum's children through) and the reactive child's reaction
 *     goes live (containerReactionInPlay gates it to the merged window):
 *       • Merge   — apply the "Avatar of Vengeance" marker AE to self (menu_hidden;
 *         skill_type Passive → shows under the Arcanum sheet's Passive section + never
 *         lists as a usable turn-action). ALSO carries the merge
 *         REACTION on its own reaction_config_table: whenever ANY creature's Burn
 *         triggers on the field (creature_status_triggered / Burn, reaction_source ""),
 *         regen 2% max HP + 2% max MP. The reaction is live only while merged (the
 *         marker AE gates it).
 *       • Pulse   — apply Burn (3 stacks) to up to 3 CREATURES (self/ally/enemy per
 *         RAW wording). No extra cost. First-class usable skill while merged.
 *       • Dismiss — 30 Fire to all enemies, then REMOVE the marker AE (un-merge).
 *         The Zero-Trigger overload is a PRE-RESOLVE reaction PILL on the Dismiss action
 *         card (creature_will_deal_damage / self / ask, scoped by reaction_source_skill):
 *         the player clicks Apply to spend 6 Zero Trigger → +10 Fire × each hit creature's
 *         Burn stacks. First-class usable skill while merged.
 *
 * Masters live under Battle Director / Arcanist; a copy of each is embedded on
 * Hina (the summon picker reads the caster's own items). Idempotent: re-running
 * refreshes the masters and re-embeds Hina's copies from them.
 *
 * Requires the engine `summon_arcanum` effect_kind + the isArcanum flag reader
 * (skill-effects.js) and the _Arcanum Template (2026-07-14-arcanum-template).
 */

import { ensureFolderPath } from "./_folder-tree.js";

export const key = "2026-07-14-arcanist-avatar-vengeance-author";
export const description =
  "Author Arcanist Bind and Summon control surface + Hina's Avatar of Vengeance " +
  "Arcanum (Merge regen-on-Burn, Pulse Burn ×3, Dismiss 30 Fire + Zero-Trigger overload).";

const NS = "fabula-ultima-companion";
const SKILL_TEMPLATE_ID = "j0F5Msw5RZ8aIB3j";
const ARCANUM_TEMPLATE_NAME = "_Arcanum Template";
const AVATAR_ICON = "icons/magic/fire/flame-burning-skull-orange.webp";

function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const keys = Object.keys(v).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}
const deepEqual = (a, b) => stableStringify(a) === stableStringify(b);

// ── Bind and Summon control surface ────────────────────────────────────────
const BIND_SUMMON_ON_ACTIVATE = "arcanum_control";
const BIND_SUMMON_EFFECT_TABLE = {
  "0": {
    effect_label: "arcanum_control",
    // Selection via the VERIFIED open_action_menu (pre-card capture + cancel-to-
    // menu + icons), fed by the dynamic Arcanum source. Each option dispatches
    // summon_arcanum in executor mode (summon_target / arcanum_action). The summon
    // MP cost lives here (all summon options share it); the preview + affordability
    // read it (Free while merged, when the pick is a free Pulse/Dismiss).
    effect_kind: "open_action_menu",
    menu_dynamic_source: "arcanum",
    menu_title: "Bind and Summon",
    menu_subtitle: "Choose an Arcanum",
    summon_cost_formula: "40 - HAS_STATUS_CRISIS * SL_EMERGENCY_ARCANUM * 5",
  },
};

// ── Avatar of Vengeance: Merge — apply the marker AE to self + host the reaction ─
// The Merge child's own effect_table holds BOTH the summon-time apply (aov_merge_apply,
// its on_activate) AND the reaction target chain (aov_regen), referenced by the child's
// reaction_config_table below. The reaction fires via the item-reaction scan
// (findPassiveCandidates), gated to the merged window by containerReactionInPlay.
const MERGE_EFFECT_TABLE = {
  "0": { effect_label: "aov_merge_apply", effect_kind: "apply_ae", ae_template_ref: "Avatar of Vengeance", target_ref: "self", ae_duplicate_mode: "replace" },
  "1": { effect_label: "aov_regen", effect_kind: "chain", chain_steps: "aov_regen_hp,aov_regen_mp" },
  "2": { effect_label: "aov_regen_hp", effect_kind: "grant", grant_resource: "hp", grant_amount: "ceil(MAX_HP * 0.02)", target_ref: "self" },
  "3": { effect_label: "aov_regen_mp", effect_kind: "grant", grant_resource: "mp", grant_amount: "ceil(MAX_MP * 0.02)", target_ref: "self" },
};
// The merge REACTION lives on the Merge child skill (not the AE): whenever ANY creature's
// Burn triggers on the field, regen 2% max HP + 2% max MP. reaction_source "" (any subject,
// NOT "enemy") — mirrors Wandering Flame's Ignition ("+10 MP +1 ZP when ANY creature's Burn
// triggers"); "enemy" needs canvas tokens for both sides and silently misses off-canvas /
// non-enemy Burns. Gated to the merged window by containerReactionInPlay (the child's
// container is the Arcanum → live only while merged).
const MERGE_REACTION_TABLE = {
  "0": {
    reaction_trigger: "creature_status_triggered",
    reaction_source: "",
    reaction_passive_mode: "force",
    reaction_status_filter: "Burn",
    reaction_effect_ref: "aov_regen",
  },
};
// ── The "dismiss before OR after your action" free-action offer — CENTRALIZED on the
// shared merge AE (an AE-carried reactionConfig, the proven Acceleration / Ninja Log path).
// Authored ONCE here, so EVERY Arcanum (and every Arcanist, not just Hina) inherits the
// dismiss mechanic with zero per-Arcanum wiring. The AE exists only while merged, so the
// offer is AUTO-GATED (no ARCANUM_MERGED condition) — it appears on summon and vanishes the
// instant Dismiss un-merges (removing this AE), which also makes it naturally once-per-merge.
//
// turn_start + turn_end (ask, self) mirror the Dancer's before/after free-action model. Both
// point at `dismiss_free`, a PRESET free action: action_ref "merged_arcanum:dismiss" resolves
// THIS actor's currently-merged Arcanum (via this very AE's arcanumUniqueId) → its dismiss-role
// child, and stages it directly. Being a preset, it skips composeAction's skill picker AND
// (skipTargetConfirm + Dismiss's "All enemies" target) auto-resolves targets — so the player
// goes straight from the "Dismiss?" blade to the Dismiss action card (no Skill→pick→confirm).
const MERGE_AE_REACTION = {
  reaction_config_table: {
    "0": { reaction_trigger: "turn_start", reaction_source: "self", reaction_passive_mode: "ask", reaction_effect_ref: "dismiss_free" },
    "1": { reaction_trigger: "turn_end",   reaction_source: "self", reaction_passive_mode: "ask", reaction_effect_ref: "dismiss_free" },
  },
  effect_table: {
    "0": { effect_label: "dismiss_free", effect_kind: "free_action", action_ref: "merged_arcanum:dismiss" },
  },
};

// The merge AE (embedded on the Merge child) is the "summoned" marker: the arcanumMerge flag
// + token icon + arcanumUniqueId (which Arcanum is merged), PLUS the centralized dismiss
// free-action offer (MERGE_AE_REACTION). The Merge child's own reaction_config_table still
// hosts the Burn-regen; this AE hosts the dismiss offer (it's the thing that exists exactly
// while merged and knows which Arcanum is bound).
function mergeAe(arcanumUniqueId) {
  return {
    name: "Avatar of Vengeance",
    icon: AVATAR_ICON,
    description: MERGE_AE_DESC,
    transfer: false,
    disabled: false,
    duration: {},
    statuses: ["fud-arcanum-merge"],
    changes: [],
    system: { tags: ["arcanum-merge", "buff"] },
    flags: {
      [NS]: {
        arcanumMerge: true,
        arcanumUniqueId,
        directorPermanent: true,   // persists until Dismiss removes it
        reactionConfig: MERGE_AE_REACTION,
      },
    },
  };
}

// ── Avatar of Vengeance: Pulse — Burn ×3 to up to 3 CREATURES (no cost) ─────
// Targeting is driven by skill_target "Up to three creatures" (the STANDARD picker →
// action card → reactable), NOT an in-effect-table targeting row. The apply_ae lands
// on `action_targets` (the picked creatures) — mirrors Elemental Shroud (pure status-
// on-action_targets). "creatures" → category any (self/ally/enemy all pickable).
const PULSE_EFFECT_TABLE = {
  "0": { effect_label: "aov_pulse", effect_kind: "apply_ae", ae_template_ref: "Burn", target_ref: "action_targets", ae_duplicate_mode: "add_charges", ae_initial_charges: "3" },
};

// ── Avatar of Vengeance: Dismiss — 30 Fire to ALL enemies, then un-merge ────
// Dismiss is a FREE ACTION, NOT a standalone turn-action: menu_hidden (never in the
// action picker), performed instead via the merge AE's turn_start/turn_end free-action
// offer (see MERGE_AE_REACTION — the "dismiss before OR after your action" mechanic is
// authored ONCE on the shared merge AE, not per Dismiss skill). This skill just defines
// WHAT Dismiss does when performed; the merge AE owns WHEN/HOW it's offered.
//
// The Zero-Trigger overload is a REACTION the player MAY apply (DISMISS_REACTION_TABLE
// below): when Dismiss deals its Fire damage, the player is offered "spend 6 Zero Trigger →
// +10 Fire × each hit creature's Burn." The aov_overload* rows live here as the reaction's
// effect target (reaction_effect_ref). The 30 Fire to all enemies is a no-check damage
// PROFILE (type_damage "fire" + damage_bonus "30" + check_mode "none" on the Dismiss props
// via extraProps), NOT an effect_table deal_damage. Only a profile gives the action
// `hasDamage` + perTargetResults — which the card renders as real damage AND which the
// creature_will_deal_damage overload pill requires (its CONFIRM phase is gated on hasDamage).
// skill_target "All enemies" auto-hits them. on_activate here just un-merges after the
// profile damage resolves.
const DISMISS_EFFECT_TABLE = {
  "0": { effect_label: "aov_dismiss_unmerge", effect_kind: "remove_tagged_ae", target_ref: "self", filter_tag: "arcanum-merge", count: "all" },
  // Overload reaction target — fired by DISMISS_REACTION_TABLE when the pill is Applied.
  // aov_overload_dmg uses adjust_damage (NOT deal_damage): a creature_will_deal_damage
  // reaction AUGMENTS the pending per-target damage — computeSenderDamageBonuses folds the
  // +10×Burn into each hit enemy's Dismiss Fire number (mirror of Centuaros Fiery Onslaught
  // / Dryad Enkindle). The consume_resource + remove_tagged_ae side-effects run at RESOLVE
  // via the reaction fire path — AFTER the damage (which used the Burn count) is applied, so
  // aov_overload_consume then strips all Burn from the hit enemies. TARGET_AE_CHARGES_BURN
  // resolves per-target.
  "1": { effect_label: "aov_overload", effect_kind: "chain", chain_steps: "aov_overload_cost,aov_overload_dmg,aov_overload_consume" },
  "2": { effect_label: "aov_overload_cost", effect_kind: "consume_resource", consume_resource: "zero_power", consume_amount: "6", target_ref: "self", on_empty: "abort" },
  "3": { effect_label: "aov_overload_dmg", effect_kind: "adjust_damage", damage_amount: "TARGET_AE_CHARGES_BURN * 10", damage_operation: "add", damage_stage: "outgoing" },
  "4": { effect_label: "aov_overload_consume", effect_kind: "remove_tagged_ae", filter_tag: "burn", target_ref: "hit_action_targets", count: "all" },
};
// The overload REACTION (on the Dismiss child). creature_will_deal_damage — the PRE-RESOLVE,
// ON-CARD Apply/Skip PILL (Warning Shot / Cheap Shot hook): spend 6 Zero Trigger → +10 Fire ×
// each hit creature's Burn. Fires at CONFIRM (before RESOLVE's un-merge), so the merged-gate
// still passes. Scoped to Dismiss's own damage via reaction_source_skill + TRIGGER_IS_SELF so
// it never offers on other fire the Avatar deals. (The turn_start/turn_end "dismiss before or
// after your action" offer is NOT here — it's on the shared merge AE, MERGE_AE_REACTION.)
const DISMISS_REACTION_TABLE = {
  "0": {
    reaction_trigger: "creature_will_deal_damage",
    reaction_source: "self",
    reaction_passive_mode: "ask",
    condition_formula: "TRIGGER_IS_SELF == 1",
    reaction_effect_ref: "aov_overload",
    reaction_source_skill: "Avatar of Vengeance: Dismiss",
  },
};

// ── Descriptions (Fabula Ultima house style: <p> paragraphs; <strong> for status
// names / actions / key terms; formulas + values in fullwidth 【…】 brackets; <em>
// for clarifications). The AE marker's blurb is deliberately ONE short line. ──
const BIND_SUMMON_DESC =
  "<p>You call upon one of your bound <strong>Arcana</strong>, <strong>merging</strong> with it by paying " +
  "its summon cost in <strong>Mind Points</strong>. While merged, you may use that Arcanum's skills.</p>" +
  "<p>Only one Arcanum may be merged at a time — you must <strong>Dismiss</strong> your current Arcanum " +
  "before summoning another.</p>";
const ARCANUM_DESC =
  "<p><strong>Domain:</strong> Vengeance, Burn.</p>" +
  "<p>An Arcanum of wrathful flame. While merged with the <strong>Avatar of Vengeance</strong>, every " +
  "<strong>Burn</strong> that flares across the battlefield feeds your fury — spread the flames with " +
  "<strong>Pulse</strong>, then release the Avatar in a blaze with <strong>Dismiss</strong>.</p>";
const MERGE_DESC =
  "<p>You <strong>merge</strong> with the Avatar of Vengeance. While merged, whenever <strong>any " +
  "creature's Burn</strong> triggers, you recover <strong>【2% of your Max HP】</strong> and " +
  "<strong>【2% of your Max MP】</strong> <em>(rounded up)</em>.</p>";
const PULSE_DESC =
  "<p>You channel the Avatar's flame, inflicting <strong>3 stacks of Burn</strong> on up to " +
  "<strong>three creatures</strong> you can see.</p>";
const DISMISS_DESC =
  "<p><em>As a free action, before or after your action on your turn,</em> you release the Avatar " +
  "in a final blaze, dealing <strong>【30】 Fire damage</strong> to <strong>all enemies</strong> " +
  "and ending the merge.</p>" +
  "<p>As you do, you may spend <strong>【6 Zero Power】</strong> to deal additional <strong>Fire " +
  "damage</strong> to each enemy equal to <strong>【10 × their Burn stacks】</strong>, then remove " +
  "all <strong>Burn</strong> from those enemies.</p>";
const MERGE_AE_DESC =
  "<p>Merged with the <strong>Avatar of Vengeance</strong>. You recover HP &amp; MP whenever " +
  "<strong>Burn</strong> triggers.</p>";

// Common child-skill prop scaffold. menuHidden defaults true (the reactive Merge
// child stays out of the usable list); Pulse/Dismiss pass false so they surface as
// first-class actor skills while the Arcanum is merged. reactionTable is optional
// (only the Merge child carries a reaction_config_table).
function childProps({ role, skillType, onActivate, effectTable, reactionTable = null, menuHidden = true, skillTarget = "", extraProps = null, description = "" }) {
  const props = {
    class: "Arcanist",
    skill_type: skillType,
    arcanum_role: role,
    menu_hidden: menuHidden,
    // skill_target drives the STANDARD TARGET step (picker + action card + reactability),
    // exactly like any other targeted skill. Empty = self-targeted (no card) — which is
    // why Pulse/Dismiss must set it. Text parses to category+mode+count:
    // "Up to three creatures" → any / up_to / 3; "All enemies" → enemy / all.
    skill_target: skillTarget,
    cost: "",
    level: "1",
    max_level: "1",
    on_activate_effect_ref: onActivate,
    effect_table: effectTable,
    description,
  };
  if (reactionTable) props.reaction_config_table = reactionTable;
  // extraProps — e.g. Dismiss's no-check damage PROFILE (type_damage/damage_bonus/
  // check_mode) so its 30 Fire lands in the action profile (hasDamage + perTargetResults),
  // not an effect_table deal_damage. That's what renders damage on the card AND enables
  // the creature_will_deal_damage overload pill.
  if (extraProps) Object.assign(props, extraProps);
  return props;
}

// ── generic world-master ensure (Item.create → reloadTemplate → props → AE) ──
async function ensureMaster(game, { name, folderId, templateId, props, flags, activeEffects, img }, log) {
  let item = game.items?.find((it) =>
    it.type === "equippableItem" && it.name === name &&
    it.system?.template === templateId &&
    (it.folder?.id ?? it.folder ?? null) === folderId
  ) ?? null;

  if (!item) {
    item = await Item.create({
      name, img: img ?? "icons/svg/daze.svg", type: "equippableItem", folder: folderId,
      system: { template: templateId, uniqueId: "", unique: true },
      flags: flags ?? {},
    });
    try { await item.templateSystem?.reloadTemplate?.(); } catch (e) { log(`  reloadTemplate failed on ${name}: ${e.message}`); }
    item = game.items?.get(item.id) ?? item;
    log(`  created master ${name} (${item.id})`);
  }

  if (flags && !deepEqual(item.flags?.[NS] ?? {}, flags[NS] ?? {})) {
    await item.update({ [`flags.${NS}`]: flags[NS] });
  }
  if (img && item.img !== img) await item.update({ img });

  // Merge scalar props; replace tables wholesale (CSB merge artefacts).
  if (props) {
    const baseProps = foundry.utils.deepClone(item.system?.props ?? {});
    const merged = foundry.utils.mergeObject(baseProps, props, { inplace: false, insertKeys: true, insertValues: true, overwrite: true, recursive: true });
    const tableKeys = ["effect_table", "reaction_config_table"];
    // Tables are REPLACED wholesale, not merged: mergeObject key-merges, so a row the
    // new table dropped (e.g. an old overload row) would otherwise survive in `merged`
    // and get written straight back, defeating the `-=` delete below. Force each table
    // in `merged` to the new props value so delete+set yields exactly the new table.
    for (const tk of tableKeys) {
      if (props[tk]) merged[tk] = foundry.utils.deepClone(props[tk]);
    }
    if (!deepEqual(item.system?.props ?? {}, merged)) {
      for (const tk of tableKeys) {
        if (props[tk] && !deepEqual(item.system?.props?.[tk] ?? {}, props[tk])) {
          await item.update({ [`system.props.-=${tk}`]: null });
        }
      }
      await item.update({ "system.props": merged });
      log(`  ${name}: props written`);
    }
  }

  // Embedded AEs — replace by name.
  if (Array.isArray(activeEffects)) {
    for (const want of activeEffects) {
      const existing = item.effects?.find((e) => e.name === want.name);
      if (existing) await item.deleteEmbeddedDocuments("ActiveEffect", [existing.id]);
      await item.createEmbeddedDocuments("ActiveEffect", [want]);
      log(`  ${name}: AE "${want.name}" (re)created`);
    }
  }
  return game.items?.get(item.id) ?? item;
}

// Re-embed a master's current state onto an actor. NON-DESTRUCTIVE: embed the
// fresh copy FIRST, and only delete the stale prior copies once the embed
// succeeded. If the embed is blocked (e.g. CSB not ready early in a boot-time
// migration → createEmbeddedDocuments returns []), leave the existing copies
// untouched rather than wiping the actor's Arcanum. (Learned the hard way: a
// delete-then-embed that failed the embed erased Hina's Arcana.)
async function syncCopyOntoActor(actor, master, log) {
  const uid = String(master.system?.uniqueId ?? "").trim();
  const obj = master.toObject();
  delete obj._id;
  const created = await actor.createEmbeddedDocuments("Item", [obj]);
  const copy = created?.[0];
  if (!copy) {
    log(`  ! embed FAILED for ${master.name} on ${actor.name} — leaving existing copies untouched`);
    return null;
  }
  if (uid) {
    const stale = actor.items.filter((i) => String(i.system?.uniqueId ?? "").trim() === uid && i.id !== copy.id);
    if (stale.length) await actor.deleteEmbeddedDocuments("Item", stale.map((i) => i.id));
  }
  log(`  embedded ${master.name} onto ${actor.name} (${copy.id})`);
  return copy;
}

export async function migrate(game, log = () => {}) {
  const hina = game.actors?.find((a) => a.name === "Hina" && a.type === "character");
  if (!hina) return { applied: false, summary: `Hina (character) not found` };

  const arcanumTpl = game.items?.find((it) => it.type === "_equippableItemTemplate" && it.name === ARCANUM_TEMPLATE_NAME);
  if (!arcanumTpl) return { applied: false, summary: `${ARCANUM_TEMPLATE_NAME} not found — run 2026-07-14-arcanum-template first` };

  // Masters live under 💥 Skill / Arcanum / <Arcanum name> — one folder per
  // Arcanum (Arcanum sits directly under Skill so a per-Arcanum subfolder stays
  // within Foundry's 4-level nesting cap).
  const { folder } = await ensureFolderPath(game, ["💥 Skill", "Arcanum", "Avatar of Vengeance"], { log });
  const folderId = folder?.id ?? null;

  // 1. Arcanum container master (uniqueId is the stable link target for children).
  const arcanum = await ensureMaster(game, {
    name: "Avatar of Vengeance", folderId, templateId: arcanumTpl.id, img: AVATAR_ICON,
    flags: { [NS]: { isArcanum: true } },
    props: { class: "Arcanum", domain: "Vengeance, Burn", element: "fire", description: ARCANUM_DESC },
  }, log);
  const arcUid = String(arcanum.system?.uniqueId ?? "").trim();

  // 2. Child skills (container = arcanum uniqueId).
  const merge = await ensureMaster(game, {
    name: "Avatar of Vengeance: Merge", folderId, templateId: SKILL_TEMPLATE_ID, img: AVATAR_ICON,
    props: childProps({ role: "merge", skillType: "Passive", onActivate: "aov_merge_apply", effectTable: MERGE_EFFECT_TABLE, reactionTable: MERGE_REACTION_TABLE, description: MERGE_DESC }),
    activeEffects: [mergeAe(arcUid)],
  }, log);
  const pulse = await ensureMaster(game, {
    name: "Avatar of Vengeance: Pulse", folderId, templateId: SKILL_TEMPLATE_ID, img: AVATAR_ICON,
    props: childProps({ role: "pulse", skillType: "Active", onActivate: "aov_pulse", effectTable: PULSE_EFFECT_TABLE, menuHidden: false, skillTarget: "Up to three creatures", description: PULSE_DESC }),
  }, log);
  const dismiss = await ensureMaster(game, {
    name: "Avatar of Vengeance: Dismiss", folderId, templateId: SKILL_TEMPLATE_ID, img: AVATAR_ICON,
    // menu_hidden defaults true → Dismiss is a free-action-only skill (Dance parity), never
    // in the standalone action picker. Performed via the merge AE's turn_start/turn_end
    // preset free-action offer (MERGE_AE_REACTION), which resolves this child by arcanum_role.
    props: childProps({ role: "dismiss", skillType: "Active", onActivate: "aov_dismiss_unmerge", effectTable: DISMISS_EFFECT_TABLE, reactionTable: DISMISS_REACTION_TABLE, skillTarget: "All enemies",
      extraProps: { type_damage: "fire", damage_bonus: "30", check_mode: "none" }, description: DISMISS_DESC }),
  }, log);
  // Stamp container on the three children (after arcanum uniqueId is known).
  for (const child of [merge, pulse, dismiss]) {
    if (String(child.system?.container ?? "") !== arcUid) {
      await child.update({ "system.container": arcUid });
      log(`  ${child.name}: container -> ${arcUid}`);
    }
  }

  // 3. Embed copies onto Hina (summon reads the caster's own items).
  const freshMerge = game.items.get(merge.id);
  const freshPulse = game.items.get(pulse.id);
  const freshDismiss = game.items.get(dismiss.id);
  const freshArc = game.items.get(arcanum.id);
  const copyArc = await syncCopyOntoActor(hina, freshArc, log);
  const copyMerge = await syncCopyOntoActor(hina, freshMerge, log);
  const copyPulse = await syncCopyOntoActor(hina, freshPulse, log);
  const copyDismiss = await syncCopyOntoActor(hina, freshDismiss, log);

  // Re-point the embedded children's container at the EMBEDDED arcanum id (not the
  // uniqueId). CSB's container model expects the embedded parent id on an actor; a
  // container that resolves to no embedded item is treated as dangling and CSB can
  // prune the child on reload (this is what wiped Hina's Arcana). The engine's
  // findArcanumChild accepts either id or uniqueId, so this stays compatible.
  const embeddedArcId = copyArc?.id
    ?? hina.items.find((i) => String(i.system?.uniqueId ?? "") === arcUid && (i.flags?.[NS]?.isArcanum))?.id
    ?? null;
  if (embeddedArcId) {
    for (const c of [copyMerge, copyPulse, copyDismiss]) {
      const live = c ? hina.items.get(c.id) : null;
      if (live && String(live.system?.container ?? "") !== embeddedArcId) {
        await live.update({ "system.container": embeddedArcId });
      }
    }
    log(`  child containers -> embedded arcanum id ${embeddedArcId}`);
  }

  // 4. Rewire Hina's Bind and Summon.
  const bas = hina.items.find((i) => i.name === "Bind and Summon");
  if (bas) {
    if (!deepEqual(bas.system?.props?.effect_table ?? {}, BIND_SUMMON_EFFECT_TABLE)) {
      await bas.update({ "system.props.-=effect_table": null });
      await bas.update({ "system.props.effect_table": BIND_SUMMON_EFFECT_TABLE });
    }
    const upd = {};
    if (bas.system?.props?.on_activate_effect_ref !== BIND_SUMMON_ON_ACTIVATE) upd["system.props.on_activate_effect_ref"] = BIND_SUMMON_ON_ACTIVATE;
    // Pre-activate = same row: the Arcanum picker runs in the pre-card capture
    // window, so the choice is made BEFORE the action card, then replayed at
    // RESOLVE (no re-prompt). summon_arcanum's captureMode branch handles this.
    if (bas.system?.props?.pre_activate_effect_ref !== BIND_SUMMON_ON_ACTIVATE) upd["system.props.pre_activate_effect_ref"] = BIND_SUMMON_ON_ACTIVATE;
    if (bas.system?.props?.skill_type !== "Active") upd["system.props.skill_type"] = "Active";
    // skill_target "Self" is what routes the skill through TARGET → COMPUTE, where
    // pre_activate fires (before the card). Without a skill_target the picker only
    // runs at RESOLVE, AFTER the card. This is the Golem Dance pattern (Golem Dance
    // = Active / Self / pre_activate = on_activate = its open_action_menu).
    if (bas.system?.props?.skill_target !== "Self") upd["system.props.skill_target"] = "Self";
    if (bas.system?.props?.cost !== "") upd["system.props.cost"] = "";
    if (bas.system?.props?.description !== BIND_SUMMON_DESC) upd["system.props.description"] = BIND_SUMMON_DESC;
    if (Object.keys(upd).length) await bas.update(upd);
    log(`  Bind and Summon rewired (pre+on_activate ${BIND_SUMMON_ON_ACTIVATE}, Active/Self)`);
  } else {
    log(`  ! Bind and Summon not found on Hina`);
  }

  return { applied: true, summary: `Avatar of Vengeance authored (arcanum ${arcUid}) + Bind and Summon rewired on ${hina.name}` };
}
