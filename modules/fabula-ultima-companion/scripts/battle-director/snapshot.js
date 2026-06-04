// State-entry snapshot helpers.
// See docs/battle-director-design.md §8 — every state captures an immutable
// snapshot of its inputs at entry so the state body operates on a frozen
// view rather than racing with live document mutations.

import { warn } from "./logger.js";
import { getActorKind, getNpcAttackItems } from "./actor-shape.js";

// ── Dual Shieldbearer / Twin Shield ──────────────────────────────────────────
// Mirrors the logic in [Macro] Attack - Player.js (v0.2 section).
// When a PC has both hands equipped with shields AND carries the Dual
// Shieldbearer passive, `buildWeaponBundle` injects a synthetic "Twin Shield"
// weapon so the BD attack flow sees a single main-hand option instead of two
// null slots.
//
// World item IDs (stable — these are world items, not compendium imports):
//   DSB  = Dual Shieldbearer passive   (Item.TwiggXCPpT07L0OR)
//   TWIN = Twin Shield virtual weapon  (Item.uENFXqIkJf5MeART)
const _DSB_BASE_ID  = "TwiggXCPpT07L0OR";
const _TWIN_ITEM_ID = "uENFXqIkJf5MeART";

function _normStr(v) {
  return (v ?? "").toString().trim().toLowerCase();
}

// Returns true if the actor owns the Dual Shieldbearer passive.
// Matches by compendium-source UUID suffix OR normalised item name.
function _hasDualShieldbearer(actor) {
  try {
    const items = Array.from(actor?.items ?? []);
    const hasUuidMatch = (it) => {
      const cands = [
        it?.uuid,
        it?.sourceId,
        foundry?.utils?.getProperty?.(it, "sourceId"),
        foundry?.utils?.getProperty?.(it, "flags.core.sourceId"),
        foundry?.utils?.getProperty?.(it, "_stats.compendiumSource"),
      ].filter(Boolean).map(String);
      return cands.some((u) => u.includes(`.${_DSB_BASE_ID}`));
    };
    return items.some((it) => hasUuidMatch(it) || _normStr(it?.name) === "dual shieldbearer");
  } catch {
    return false;
  }
}

// Returns true when the actor's equipped hand ("main" | "off") is a shield.
// Checks both the CSB attribute slot (A1 === "SHI") and the weapon_list entry
// type, mirroring the dual-check in Attack - Player.js::isShieldEntry /
// isShieldByAttrKeys.
function _isShieldHand(actor, which) {
  const props = actor?.system?.props ?? {};
  const A1key = which === "main" ? "main_attrib_1" : "off_attrib_1";
  const A1 = String(props[A1key] ?? "").toUpperCase();
  if (A1 === "SHI") return true;
  const handName = which === "main" ? props.main_hand : props.off_hand;
  if (!handName) return false;
  const entry = Object.values(props?.weapon_list ?? {}).find((w) => w?.name === handName) ?? null;
  return _normStr(entry?.weapon_type ?? entry?.category ?? "") === "shield";
}

// Build a frozen weapon row from the Twin Shield world item.
// Uses game.items cache (sync) instead of fromUuid (async) — equivalent for
// world items while keeping buildWeaponBundle synchronous.
// Returns null when the item is not present in the world.
function _buildTwinShieldRow() {
  try {
    const doc = game.items?.get?.(_TWIN_ITEM_ID) ?? null;
    if (!doc) { warn("Twin Shield item not found in world items", _TWIN_ITEM_ID); return null; }
    const GP = (k, d = "") => foundry?.utils?.getProperty?.(doc, `system.props.${k}`) ?? d;
    const A1 = (GP("rolled_atr1", "MIG") || "MIG").toUpperCase();
    const A2 = (GP("rolled_atr2", "MIG") || "MIG").toUpperCase();
    return Object.freeze({
      hand: "main",
      name: doc.name ?? "Twin Shield",
      A1,
      A2,
      checkBonus:  Number(GP("check_bonus",  0)) || 0,
      damageBonus: Number(GP("damage_bonus", 0)) || 0,
      damageType:  GP("type_damage", "Physical") || "Physical",
      range:       GP("weapon_range", GP("skill_range", "Melee")) || "Melee",
      weaponType:  GP("weapon_type", GP("category", "")) || "",
      imageUrl:    doc.img ?? null,
      isTwinShield: true,
    });
  } catch (e) {
    warn("_buildTwinShieldRow threw", e);
    return null;
  }
}
// ─────────────────────────────────────────────────────────────────────────────

// Element → affinity_N prop key mapping, mirroring legacy AdvanceDamage.js
// line 278. The CSB template stores elemental affinities under numbered keys
// (`affinity_1` etc.) — these are dropdown values: "" / "NE" (neutral),
// "VU" (vulnerable, 2x), "RS" (resistant, 0.5x), "IM" (immune, 0), or
// "AB" (absorbing, heal).
export const AFFINITY_KEY = Object.freeze({
  physical: "affinity_1",
  air:      "affinity_2",
  bolt:     "affinity_3",
  dark:     "affinity_4",
  earth:    "affinity_5",
  fire:     "affinity_6",
  ice:      "affinity_7",
  light:    "affinity_8",
  poison:   "affinity_9",
});

// Read all 9 elemental affinities for an actor in one pass. Returns a frozen
// map keyed by element name. Missing / empty values are normalised to "NE"
// so downstream consumers don't have to defend against undefined.
export function readAffinities(actor) {
  const props = actor?.system?.props ?? actor?.system ?? {};
  const out = {};
  for (const [element, key] of Object.entries(AFFINITY_KEY)) {
    const raw = String(props?.[key] ?? "").trim().toUpperCase();
    out[element] = (raw === "VU" || raw === "RS" || raw === "IM" || raw === "AB") ? raw : "NE";
  }
  return Object.freeze(out);
}

// Status conditions that force Vulnerable on a specific element when
// applied — mirrored from AdvanceDamage.js line 588 (legacy condVU map).
const FORCED_VU_BY_STATUS = Object.freeze({
  Wet: "bolt",
  Oil: "fire",
  Petrify: "earth",
  Hypothermia: "ice",
  Turbulence: "air",
  Zombie: "light",
});

// Read the list of active-effect labels currently on an actor. Used by the
// affinity resolver to apply forced-VU from status conditions.
function readActiveConditions(actor) {
  try {
    const effs = actor?.effects ?? actor?.appliedEffects ?? [];
    const labels = [];
    for (const e of effs) {
      const label = e?.label ?? e?.name ?? null;
      if (label) labels.push(String(label));
    }
    return labels;
  } catch (_) { return []; }
}

// Resolve the effective affinity code for an actor against a given element,
// honouring status-condition forced-Vulnerable. Returns "VU"/"RS"/"IM"/"AB"
// or "NE".
export function resolveAffinity(actor, element) {
  const el = String(element ?? "physical").toLowerCase();
  const affinities = readAffinities(actor);
  let code = affinities[el] ?? "NE";

  // Status-forced VU overrides — applied AFTER reading the sheet affinity.
  // Mirrors legacy AdvanceDamage line 589-591: any of these conditions on
  // the actor, paired with the matching element, forces VU regardless of
  // the sheet value (so a fire-resistant actor doused in Oil still takes
  // doubled fire damage).
  const conditions = readActiveConditions(actor);
  for (const cond of conditions) {
    const forcedEl = FORCED_VU_BY_STATUS[cond];
    if (forcedEl && forcedEl === el) { code = "VU"; break; }
  }
  return code;
}

// Apply an affinity code to a damage value. Returns the post-affinity
// damage (always non-negative). The caller checks `affinity === "AB"`
// separately to flip the effect direction (heal instead of damage) — the
// `value` returned is always the absolute amount.
//   VU → ceil(damage * 2)
//   RS → ceil(damage / 2)
//   IM → 0
//   AB → damage (caller flips to heal)
//   NE → damage
export function applyAffinityToDamage(damage, code) {
  const base = Math.max(0, Number(damage) | 0);
  switch (code) {
    case "VU": return Math.ceil(base * 2);
    case "RS": return Math.ceil(base / 2);
    case "IM": return 0;
    default:   return base;
  }
}

// Numeric prop reader with multiple candidate keys + default.
export function readPropNum(actor, keys, fallback = 0) {
  const props = actor?.system?.props ?? actor?.system ?? {};
  for (const k of keys) {
    const v = props?.[k];
    if (v == null) continue;
    const n = typeof v === "number" ? v : Number(String(v).replace(/[^0-9-]/g, ""));
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

// Look up a CSB attribute die size for an actor. Default to d8.
export function attrDieSize(actor, key) {
  if (!actor) return 8;
  const A = String(key || "").toUpperCase();
  const props = actor?.system?.props ?? actor?.system ?? {};
  const candidates = [
    props[`${A}_die_size`],
    props[`${A}_die`],
    props[`current_${A}_die`],
    props[`current_${A}`],
    props[A],
  ];
  for (const c of candidates) {
    const s = String(c ?? "").replace(/[^0-9]/g, "");
    const n = Number(s);
    if (Number.isFinite(n) && n >= 4) return n;
  }
  return 8;
}

// Resolve the attacker's currently-equipped weapon for Attack actions.
//
// Reads the same actor props the legacy `[Macro] Attack - Player.js` macro
// reads (lines 86-120) so the formulas line up: main_hand name lookup in
// weapon_list, main_attrib_1/2, weapon1_mod (accuracy bonus), weapon1_damage
// (damage bonus), weapon1_damagetype, plus weapon_range / weapon_type from
// the weapon_list entry.
//
// `which`: "main" | "off" — which equipped hand to read. Defaults to "main".
//
// Returns null if the requested hand isn't equipped or resolves to a shield
// (attribute "SHI"). Caller decides whether to fall back to the other hand
// or refuse the action.
//
// Buff effects (extra_damage_mod_*, attack_accuracy_mod_*) are NOT applied
// here — that's a later slice. We surface the raw weapon stats so the
// Compute state can roll them; buff aggregation happens above.
export function resolveAttackerWeapon(actor, { which = "main" } = {}) {
  if (!actor) return null;
  const props = actor?.system?.props ?? actor?.system ?? {};
  const weaponList = Object.values(props?.weapon_list ?? {});
  const isMain = which === "main";

  const handName = isMain ? props.main_hand : props.off_hand;
  if (!handName) return null;

  const entry = weaponList.find((w) => w?.name === handName) ?? null;

  // Attribute pair. Empty/SHI means no usable weapon in this hand.
  const A1 = String(isMain ? (props.main_attrib_1 ?? "") : (props.off_attrib_1 ?? "")).toUpperCase();
  const A2 = String(isMain ? (props.main_attrib_2 ?? "") : (props.off_attrib_2 ?? "")).toUpperCase();
  if (!A1 || A1 === "SHI" || A1 === "UNDEFINED") return null;

  // Accuracy bonus + damage bonus + damage type per hand. The off-hand
  // prop names are genuinely inverted in the CSB template (off_mod_1 is
  // accuracy, off_mod_2 is damage) — that's not a typo, it mirrors the
  // shipped data shape.
  const checkBonus = Number(
    isMain ? (props.weapon1_mod ?? 0) : (props.off_mod_1 ?? 0)
  ) || 0;
  const damageBonus = Number(
    isMain ? (props.weapon1_damage ?? 0) : (props.off_mod_2 ?? 0)
  ) || 0;
  const damageType = String(
    isMain ? (props.weapon1_damagetype ?? "Physical") : (props.weapon2_damagetype ?? "Physical")
  );

  const range = String(entry?.weapon_range ?? "Melee");
  const weaponType = String(entry?.weapon_type ?? entry?.category ?? entry?.type ?? "");

  // Resolve weapon item image. The entry's `uuid` field is canonical (the
  // `id` field is an unresolved CSB template literal `${item.id}$`). Local
  // lookup on the actor's items is enough — no async needed.
  let imageUrl = entry?.img ?? entry?.image ?? null;
  if (!imageUrl && entry?.uuid) {
    try {
      const itemId = String(entry.uuid).split(".").pop();
      const item = actor.items?.get?.(itemId);
      if (item?.img) imageUrl = item.img;
    } catch (_) {}
  }

  return Object.freeze({
    hand: which,
    name: String(handName),
    A1, A2,
    checkBonus,
    damageBonus,
    damageType,
    range,
    weaponType,
    imageUrl,
  });
}

// Build the weapon-related fields for a combatant snapshot — main weapon,
// off-hand, and the two-weapon eligibility flag — in one safe pass. Each
// piece is individually defended: if `resolveAttackerWeapon` throws for one
// hand, we still return the other plus `canTwoWeaponFight: false`. The
// snapshot must NEVER fail because of a malformed weapon entry — the
// attacker just ends up with no weapon and TARGET / COMPUTE handle that.
function buildWeaponBundle(actor) {
  // NPC actors have no equipped-weapon concept. They attack via Items with
  // skill_type === "Attack" (see actor-shape.js). Return empty weapon
  // fields + a list of the attack-item UUIDs so the compose / TARGET
  // phases can build the NPC picker from the snapshot alone.
  const kind = getActorKind(actor);
  if (kind === "npc") {
    let npcAttackItems = [];
    try {
      npcAttackItems = getNpcAttackItems(actor).map((it) => Object.freeze({
        uuid: it.uuid,
        id: it.id,
        name: it.name,
        img: it.img ?? null,
      }));
    } catch (e) {
      warn("buildWeaponBundle: getNpcAttackItems threw", e);
    }
    return {
      actorKind: "npc",
      weapon: null,
      offWeapon: null,
      canTwoWeaponFight: false,
      npcAttackItems: Object.freeze(npcAttackItems),
    };
  }

  let weapon = null;
  let offWeapon = null;
  try { weapon = resolveAttackerWeapon(actor, { which: "main" }); }
  catch (e) { warn("buildWeaponBundle: main resolve threw", e); weapon = null; }
  try { offWeapon = resolveAttackerWeapon(actor, { which: "off" }); }
  catch (e) { warn("buildWeaponBundle: off resolve threw", e); offWeapon = null; }

  let canTwoWeaponFight = false;
  try {
    if (weapon && offWeapon) {
      const mt = String(weapon.weaponType ?? "").trim().toLowerCase();
      const ot = String(offWeapon.weaponType ?? "").trim().toLowerCase();
      canTwoWeaponFight = !!mt && mt === ot;
    }
  } catch (e) { warn("buildWeaponBundle: canTwoWeaponFight threw", e); }

  // Dual Shieldbearer injection: when both hands resolved to null (shields
  // return null from resolveAttackerWeapon because A1 = "SHI") AND the actor
  // carries Dual Shieldbearer, replace the empty weapon slots with the Twin
  // Shield virtual weapon. This mirrors the injection in Attack - Player.js.
  if (!weapon && !offWeapon) {
    try {
      if (_isShieldHand(actor, "main") && _isShieldHand(actor, "off") && _hasDualShieldbearer(actor)) {
        const twin = _buildTwinShieldRow();
        if (twin) {
          weapon = twin;
          canTwoWeaponFight = false;
        }
      }
    } catch (e) { warn("buildWeaponBundle: Twin Shield injection threw", e); }
  }

  return { actorKind: kind, weapon, offWeapon, canTwoWeaponFight, npcAttackItems: Object.freeze([]) };
}

// Director-owned snapshot. Takes a DirectorCombatant (live tokenDoc + actorDoc
// refs) and produces the same frozen shape that snapshotCombatant returns.
// This is what TurnStart calls in the dCombat path.
export function snapshotDirectorCombatant(dc) {
  try {
    if (!dc) { warn("snapshotDirectorCombatant: null combatant"); return null; }
    const tokenDoc = dc.tokenDoc;
    const actor = dc.actorDoc;
    if (!tokenDoc) { warn("snapshotDirectorCombatant: combatant missing tokenDoc", dc.id); return null; }
    if (!actor) { warn("snapshotDirectorCombatant: combatant missing actor", dc.id); return null; }
    return Object.freeze({
      // dCombatantId — the director's combatant id (NOT a Foundry combatant)
      combatantId: dc.id,
      tokenId: tokenDoc.id,
      tokenUuid: tokenDoc.uuid,
      actorId: actor.id,
      actorUuid: actor.uuid,
      name: actor.name ?? dc.name ?? "Unknown",
      tokenImg: tokenDoc.texture?.src ?? tokenDoc.img ?? actor.img ?? null,
      disposition: dc.disposition ?? tokenDoc.disposition ?? 0,
      hp: readPropNum(actor, ["current_hp", "hp"]),
      maxHp: readPropNum(actor, ["max_hp"]),
      mp: readPropNum(actor, ["current_mp", "mp"]),
      maxMp: readPropNum(actor, ["max_mp"]),
      defense: readPropNum(actor, ["defense", "current_def", "def"]),
      magicDefense: readPropNum(actor, ["magic_defense", "current_mdef", "mdef"]),
      attributes: Object.freeze({
        DEX: attrDieSize(actor, "DEX"),
        INS: attrDieSize(actor, "INS"),
        MIG: attrDieSize(actor, "MIG"),
        WLP: attrDieSize(actor, "WLP"),
      }),
      // Default fumble threshold per RAW: a Fumble is two 1s. Per-actor
      // override via `fumble_threshold` (the highest die value that still
      // counts as a fumbled die — both dice must be ≤ threshold).
      fumbleThreshold: readPropNum(actor, ["fumble_threshold"], 1),
      ...buildWeaponBundle(actor),
    });
  } catch (e) {
    warn("snapshotDirectorCombatant threw", e);
    return null;
  }
}

// Snapshot the active combatant. Captures token + actor identity + a few
// numeric props so state bodies don't have to refetch.
//
// Legacy path: reads `combat.combatant` directly (Foundry Combat doc).
// Used only in the manual-fallback start path (no payload, no PREP).
export function snapshotCombatant(combat) {
  try {
    const combatant = combat?.combatant ?? null;
    if (!combatant) { warn("snapshotCombatant: no current combatant"); return null; }
    const token = combatant.token;
    const actor = combatant.actor;
    if (!token) { warn("snapshotCombatant: combatant has no token", combatant.id); return null; }
    if (!actor) { warn("snapshotCombatant: combatant has no actor", combatant.id); return null; }

    return Object.freeze({
      combatantId: combatant.id,
      tokenId: token.id,
      tokenUuid: token.uuid,
      actorId: actor.id,
      actorUuid: actor.uuid,
      name: actor.name ?? "Unknown",
      tokenImg: token.texture?.src ?? token.img ?? actor.img ?? null,
      disposition: token.disposition ?? 0,
      hp: readPropNum(actor, ["current_hp", "hp"]),
      maxHp: readPropNum(actor, ["max_hp"]),
      mp: readPropNum(actor, ["current_mp", "mp"]),
      maxMp: readPropNum(actor, ["max_mp"]),
      defense: readPropNum(actor, ["defense", "current_def", "def"]),
      magicDefense: readPropNum(actor, ["magic_defense", "current_mdef", "mdef"]),
      attributes: Object.freeze({
        DEX: attrDieSize(actor, "DEX"),
        INS: attrDieSize(actor, "INS"),
        MIG: attrDieSize(actor, "MIG"),
        WLP: attrDieSize(actor, "WLP"),
      }),
      fumbleThreshold: readPropNum(actor, ["fumble_threshold"], 1),
      ...buildWeaponBundle(actor),
    });
  } catch (e) {
    warn("snapshotCombatant threw", e);
    return null;
  }
}

// AE-driven target self-defense. Walks a potential target's active
// effects, collects every change row whose `key === "cannot_be_targeted_by"`,
// and returns a list of blocks each describing what attack types the
// target is protected from. Mirrors getCannotTargetReasons but reads
// from the TARGET side (vs Vanish reading the attacker side).
//
// Each AE may declare multiple ranges in one row (comma-separated). The
// canonical values are "melee", "ranged", "any" (for "spell" etc. add
// later as needed). The AE's name surfaces as the picker overlay reason
// — Cover writes "Covered", future Out-of-Sight skills would write
// "Hidden", etc.
//
// Returns Array<{ aeName: string, ranges: Set<string> }> — empty when
// no blocks apply. Caller (applyAttackRangeGate) checks whether the
// attacker's weapon range matches any block's `ranges` set.
export function getTargetSideBlocks(actor) {
  const out = [];
  const effects = actor?.effects?.contents ?? actor?.effects ?? [];
  for (const ae of effects) {
    if (ae?.disabled) continue;
    const changes = ae?.changes ?? [];
    const ranges = new Set();
    for (const ch of changes) {
      if (ch?.key !== "cannot_be_targeted_by") continue;
      const raw = String(ch.value ?? "").trim().toLowerCase();
      if (!raw) continue;
      for (const r of raw.split(/[\s,]+/)) {
        const trimmed = r.trim();
        if (trimmed) ranges.add(trimmed);
      }
    }
    if (ranges.size) {
      out.push({
        aeName: String(ae.name ?? "").trim() || "Blocked",
        ranges,
      });
    }
  }
  return out;
}

// AE-driven target exclusion. Walks the chooser's active effects, collects
// every change row whose `key === "cannot_target_uuids"`, and returns the
// set of actor UUIDs the chooser is forbidden from targeting.
//
// The change row's `value` is a comma-or-newline-separated list of UUIDs
// (typically one — Vanish writes the caster's actorUuid). We split on
// whitespace + commas so authors can pack multiple in a single row, and
// also merge across multiple AEs (Vanish from two casters → both UUIDs
// excluded).
//
// The bake-resolver in apply_ae substitutes `${casterActorUuid}$` at apply
// time, so by the time we read the AE here the value is already a literal
// UUID string. Disabled AEs are skipped.
//
// First consumer: Vanish's "Vanished from Caster" AE. Future consumers:
// any "you cannot see X" / "you cannot perceive X" reactive effect.
export function getCannotTargetUuids(actor) {
  return new Set(getCannotTargetReasons(actor).keys());
}

// Same walk as getCannotTargetUuids, but keeps the human-readable
// reason (AE name) for each excluded UUID. Used by the target picker
// to overlay a "WHY can't I target this?" label above the excluded
// tokens — players need to know whether the target is dropped because
// they're invisible, or for some other reason they should plan around.
//
// Returns Map<excludedActorUuid, string[]> — multiple AEs hitting the
// same UUID concatenate their names into the list, so the picker can
// surface all of them when relevant.
export function getCannotTargetReasons(actor) {
  const out = new Map();
  const effects = actor?.effects?.contents ?? actor?.effects ?? [];
  for (const ae of effects) {
    if (ae?.disabled) continue;
    const changes = ae?.changes ?? [];
    for (const ch of changes) {
      if (ch?.key !== "cannot_target_uuids") continue;
      const raw = String(ch.value ?? "").trim();
      if (!raw) continue;
      const reason = String(ae.name ?? "").trim() || "Cannot target";
      for (const u of raw.split(/[\s,]+/)) {
        const trimmed = u.trim();
        if (!trimmed) continue;
        const list = out.get(trimmed);
        if (list) list.push(reason);
        else out.set(trimmed, [reason]);
      }
    }
  }
  return out;
}

// Snapshot eligible targets read from a DirectorCombat (the no-Foundry-doc
// path). Same returned shape as `snapshotEligibleTargets` so callers can swap
// without changing downstream code.
export function snapshotEligibleTargetsFromDCombat(dCombat, attackerSnapshot, { category = "any" } = {}) {
  const combatants = dCombat?.combatants ?? [];
  const attackerDisp = attackerSnapshot?.disposition ?? 0;
  // AE-driven exclusion — walks the attacker's AEs once and collects every
  // `cannot_target_uuids` value plus its source-AE name (used as the
  // "why" label in the target picker). Excluded targets are filtered out
  // of the eligible list below AND collected separately into `excluded`,
  // attached to the returned array so the picker can render a greyed-out
  // overlay + reason label over each blocked token.
  // Skips self-targeting (category === "self") since that bypass is
  // already actor-id-based, and a self-targeted skill never honors
  // "I can't see this actor" exclusions per RAW.
  // The snapshot doesn't carry the live actor doc (frozen-data contract);
  // re-resolve via combatant.actorDoc on the dCombat side or
  // game.actors.get on the legacy side. Returns an empty map if no
  // attacker is resolvable.
  const attackerActorId = attackerSnapshot?.actorId ?? null;
  const attackerActor = attackerActorId
    ? (dCombat?.combatants?.find?.((c) => c.id === attackerSnapshot?.combatantId)?.actorDoc
        ?? game.actors?.get?.(attackerActorId)
        ?? null)
    : null;
  const exclusionReasons = (category === "self")
    ? new Map()
    : getCannotTargetReasons(attackerActor);
  const out = [];
  const excluded = [];
  for (const c of combatants) {
    const token = c.tokenDoc;
    const actor = c.actorDoc;
    if (!token || !actor) continue;
    const disp = c.disposition ?? token.disposition ?? 0;
    const hp = readPropNum(actor, ["current_hp", "hp"]);
    if (hp <= 0) continue;
    let ok = true;
    if (category === "ally") {
      ok = (disp === attackerDisp) && (disp !== 0);
    } else if (category === "enemy") {
      ok = (disp !== attackerDisp) || (disp === 0);
    } else if (category === "self") {
      ok = c.id === attackerSnapshot?.combatantId;
    }
    if (!ok) continue;
    if (exclusionReasons.size && exclusionReasons.has(actor.uuid)) {
      excluded.push(Object.freeze({
        combatantId: c.id,
        tokenId: token.id,
        tokenUuid: token.uuid,
        actorId: actor.id,
        actorUuid: actor.uuid,
        name: actor.name,
        tokenImg: token.texture?.src ?? token.img ?? actor.img ?? null,
        disposition: disp,
        reasons: Object.freeze([...exclusionReasons.get(actor.uuid)]),
      }));
      continue;
    }
    out.push(Object.freeze({
      combatantId: c.id,
      tokenId: token.id,
      tokenUuid: token.uuid,
      actorId: actor.id,
      actorUuid: actor.uuid,
      // World-actor UUID (the protoUuid the encyclopedia keys by) when the
      // token is unlinked — derived from token.actorId. Equals actorUuid for
      // linked actors. Used by the action card's "???" masking when a player
      // attacker hasn't Studied the target.
      worldActorUuid: (game.actors?.get?.(token.actorId)?.uuid) ?? actor.uuid,
      name: actor.name,
      tokenImg: token.texture?.src ?? token.img ?? actor.img ?? null,
      disposition: disp,
      hp,
      maxHp: readPropNum(actor, ["max_hp"]),
      defense: readPropNum(actor, ["defense", "current_def", "def"]),
      magicDefense: readPropNum(actor, ["magic_defense", "current_mdef", "mdef"]),
      affinities: readAffinities(actor),
      conditions: Object.freeze(readActiveConditions(actor)),
      // AE-driven target-side blocks (Cover, future Out-of-Sight, etc.).
      // Each entry: { aeName, ranges: Set<string> }. applyAttackRangeGate
      // reads this per-weapon to decide whether to move the target into
      // `.excluded` with the AE name as the reason. Stays empty for
      // most targets; ranges are normalized lowercase ("melee", "ranged",
      // "any").
      targetingBlocks: Object.freeze(getTargetSideBlocks(actor).map((b) =>
        Object.freeze({ aeName: b.aeName, ranges: Object.freeze([...b.ranges]) })
      )),
    }));
  }
  // Attach excluded list as a property BEFORE freezing — Object.freeze
  // applies recursively only one level, but we want the array property
  // accessible at all (assignment would silently fail post-freeze).
  out.excluded = Object.freeze(excluded);
  return Object.freeze(out);
}

// Apply the Attack range gate to an eligible-targets array, preserving
// the `excluded` side-channel that target-picker reads to render the
// "🚫 <reason>" overlay (Vanish etc.).
//
// The gate is data-driven via AE-config: each target may carry one or
// more `targetingBlocks` entries (collected by getTargetSideBlocks at
// snapshot time from `cannot_be_targeted_by` change rows). For each
// target, if ANY block's `ranges` set contains the attacker's weapon
// range OR `"any"`, the target moves into `.excluded` with the
// block's AE name as the reason.
//
// Cover (RAW Core p.70) is the canonical example — the Covered AE
// declares `cannot_be_targeted_by: "melee"`. Future targeting blocks
// (Out-of-Sight, Sanctuary, Concealment, etc.) author the same change
// row with their own scope and overlay the same way without engine
// changes.
//
// IMPORTANT: this function exists because `Array.prototype.filter()`
// returns a fresh array WITHOUT custom properties. Inlining a filter
// at the call site silently drops `.excluded` and the canvas overlay.
// All Attack call sites (PC composeAttack, NPC composeAttackNpc,
// TARGET re-snapshot) MUST route their range gating through this
// helper so the excluded-overlay contract holds uniformly.
export function applyAttackRangeGate(eligible, weapon) {
  if (!Array.isArray(eligible)) return eligible;
  const range = String(weapon?.range ?? "").trim().toLowerCase();
  if (!range) {
    // No weapon — nothing to gate on. Return as-is.
    return eligible;
  }
  const out = [];
  const newlyExcluded = [];
  for (const e of eligible) {
    const blocks = Array.isArray(e.targetingBlocks) ? e.targetingBlocks : [];
    const matchingReasons = [];
    for (const b of blocks) {
      const blockRanges = Array.isArray(b.ranges) ? b.ranges : [];
      if (blockRanges.includes("any") || blockRanges.includes(range)) {
        matchingReasons.push(b.aeName);
      }
    }
    if (matchingReasons.length) {
      newlyExcluded.push(Object.freeze({
        combatantId: e.combatantId,
        tokenId: e.tokenId,
        tokenUuid: e.tokenUuid,
        actorId: e.actorId,
        actorUuid: e.actorUuid,
        name: e.name,
        tokenImg: e.tokenImg,
        disposition: e.disposition,
        reasons: Object.freeze([...matchingReasons]),
      }));
      continue;
    }
    out.push(e);
  }
  // Union with the existing AE-driven exclusions (Vanish etc.). Both
  // groups render identically — the overlay code doesn't care WHY a
  // token is excluded, only that it is.
  const priorExcluded = Array.isArray(eligible.excluded) ? eligible.excluded : [];
  out.excluded = Object.freeze([...priorExcluded, ...newlyExcluded]);
  return out;
}

// Snapshot eligible targets for a given action category.
// `category`: "any" | "ally" | "enemy" | "self".
// For the prototype we keep this simple — token UUIDs + name + disposition.
export function snapshotEligibleTargets(combat, attackerSnapshot, { category = "any" } = {}) {
  const combatants = combat?.combatants ?? [];
  const attackerDisp = attackerSnapshot?.disposition ?? 0;
  // AE-driven exclusion — same as the dCombat variant above. The legacy
  // Foundry combat carries `combatant.actor` references; we re-resolve
  // via game.actors as a fallback if the snapshot doesn't carry one.
  const attackerActorId = attackerSnapshot?.actorId ?? null;
  const attackerActor = attackerActorId
    ? (combat?.combatants?.find?.((c) => c.id === attackerSnapshot?.combatantId)?.actor
        ?? game.actors?.get?.(attackerActorId)
        ?? null)
    : null;
  const exclusionReasons = (category === "self")
    ? new Map()
    : getCannotTargetReasons(attackerActor);
  const out = [];
  const excluded = [];
  for (const c of combatants) {
    const token = c.token;
    const actor = c.actor;
    if (!token || !actor) continue;
    const disp = token.disposition;
    const hp = readPropNum(actor, ["current_hp", "hp"]);
    if (hp <= 0) continue; // defeated combatants are not targetable in v1
    let ok = true;
    if (category === "ally") {
      ok = (disp === attackerDisp) && (disp !== 0);
    } else if (category === "enemy") {
      ok = (disp !== attackerDisp) || (disp === 0);
    } else if (category === "self") {
      ok = c.id === attackerSnapshot?.combatantId;
    }
    if (!ok) continue;
    if (exclusionReasons.size && exclusionReasons.has(actor.uuid)) {
      excluded.push(Object.freeze({
        combatantId: c.id,
        tokenId: token.id,
        tokenUuid: token.uuid,
        actorId: actor.id,
        actorUuid: actor.uuid,
        name: actor.name,
        tokenImg: token.document?.texture?.src ?? token.texture?.src ?? token.img ?? actor.img ?? null,
        disposition: disp,
        reasons: Object.freeze([...exclusionReasons.get(actor.uuid)]),
      }));
      continue;
    }
    out.push(Object.freeze({
      combatantId: c.id,
      tokenId: token.id,
      tokenUuid: token.uuid,
      actorId: actor.id,
      actorUuid: actor.uuid,
      worldActorUuid: (game.actors?.get?.(token.actorId)?.uuid) ?? actor.uuid,
      name: actor.name,
      tokenImg: token.document?.texture?.src ?? token.texture?.src ?? token.img ?? actor.img ?? null,
      disposition: disp,
      hp,
      maxHp: readPropNum(actor, ["max_hp"]),
      defense: readPropNum(actor, ["defense", "current_def", "def"]),
      magicDefense: readPropNum(actor, ["magic_defense", "current_mdef", "mdef"]),
      affinities: readAffinities(actor),
      conditions: Object.freeze(readActiveConditions(actor)),
      targetingBlocks: Object.freeze(getTargetSideBlocks(actor).map((b) =>
        Object.freeze({ aeName: b.aeName, ranges: Object.freeze([...b.ranges]) })
      )),
    }));
  }
  out.excluded = Object.freeze(excluded);
  return Object.freeze(out);
}

// Snapshot the action result computed by COMPUTE. Used by CONFIRM + RESOLVE.
export function freezeActionResult(obj) {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return Object.freeze(obj.map(freezeActionResult));
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = (v && typeof v === "object") ? freezeActionResult(v) : v;
  }
  return Object.freeze(out);
}

// Re-read live actor HP/MP. Used when the snapshot is stale (rare in v1).
export function readLiveResources(actor) {
  if (!actor) return null;
  try {
    return {
      hp: readPropNum(actor, ["current_hp", "hp"]),
      maxHp: readPropNum(actor, ["max_hp"]),
      mp: readPropNum(actor, ["current_mp", "mp"]),
      maxMp: readPropNum(actor, ["max_mp"]),
    };
  } catch (e) {
    warn("readLiveResources failed", e);
    return null;
  }
}
