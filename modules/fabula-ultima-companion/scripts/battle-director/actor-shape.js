// actor-shape — detect whether an actor follows the PC or NPC template
// shape and surface the canonical attack-source for each kind.
//
// PCs carry `system.props.weapon_list` (a map of equipped weapons) and the
// main_hand / off_hand / weapon1_* props that `snapshot.resolveAttackerWeapon`
// reads. Their basic Attack pulls from the equipped weapon.
//
// NPCs carry `system.props.attack_list` (a CSB itemContainer that displays
// Items whose `skill_type === "Attack"`). Their basic Attack pulls from
// ONE of those Items; they have no equipped-weapon concept.
//
// Detection lets the BD pick the right flow without forking every site that
// touches Attack. Snapshot, compose-action, state-handlers, and skill-cost
// all read the kind to branch.

const SKILL_TYPE_ATTACK = "attack";

// Returns "pc" | "npc" | "unknown".
//
// PC signal: weapon_list is present AND non-empty, OR main_hand / off_hand
// is set. We don't require BOTH — empty starts and unequipped hands are
// legitimate transient states for a PC.
//
// NPC signal: attack_list is present as an object. The CSB itemContainer
// initialises this key on every NPC even when the actor has no attack
// items, so the presence of the key is a reliable discriminator. The
// itemContainer's keys map to Item IDs of skill_type:"Attack" items on
// the actor.
//
// "unknown" covers actors whose template predates the NPC v2 layout or
// world-data drift (corrupted props). Caller decides whether to default
// to PC behavior or refuse the action.
export function getActorKind(actor) {
  const props = actor?.system?.props ?? actor?.system ?? {};
  const hasWeaponShape =
    (props.weapon_list && typeof props.weapon_list === "object") ||
    props.main_hand !== undefined ||
    props.off_hand !== undefined;
  const hasAttackListShape =
    props.attack_list && typeof props.attack_list === "object";

  if (hasWeaponShape && !hasAttackListShape) return "pc";
  if (hasAttackListShape && !hasWeaponShape) return "npc";

  // Both / neither: prefer the strongest signal. attack_list with at
  // least one entry beats an empty weapon_list. main_hand explicitly set
  // (even to null) beats an attack_list with zero entries.
  const attackEntries = hasAttackListShape ? Object.keys(props.attack_list).length : 0;
  const weaponEntries = (props.weapon_list && typeof props.weapon_list === "object")
    ? Object.keys(props.weapon_list).length : 0;
  if (attackEntries > 0 && weaponEntries === 0) return "npc";
  if (weaponEntries > 0 && attackEntries === 0) return "pc";

  return "unknown";
}

// Pull the actor's Attack-typed items. Filters embedded items by
// `skill_type === "Attack"` (case-insensitive), and also includes
// offensive spells (`isOffensiveSpell === true` + `isCheck === true`)
// so NPC spellcasters can use their Spell-type skills as attack options.
//
// `buildPseudoWeaponFromNpcAttack` forwards `defense_target_type`, so an NPC
// Attack (or offensive spell) tagged `mdef` resolves its check vs Magic Defense
// and classifies as Magic damage; blank falls back to DEF.
//
// Returns an array of Item docs in the order they appear on the actor.
// Empty array = no attack item; caller surfaces "no attack available".
export function getNpcAttackItems(actor) {
  const items = actor?.items?.contents ?? [];
  return items.filter((it) => {
    // An item living INSIDE another item (`system.container` — the gear
    // `_skill` / launcher-strike pattern, e.g. Geist's Shadowbringers Strike
    // inside its launcher skill) is not a top-level attack option: it is
    // performed via its container (a free_action preset), never picked
    // directly. Preset paths resolve the item by UUID and are unaffected;
    // this only hides it from the Attack picker + sheet-facing lists.
    if (String(it?.system?.container ?? "").trim()) return false;
    const p = it?.system?.props ?? {};
    const t = String(p.skill_type ?? "").trim().toLowerCase();
    if (t === SKILL_TYPE_ATTACK) return true;
    return p.isOffensiveSpell === true && p.isCheck === true;
  });
}

// Build a "weapon-shaped" object from an NPC Attack item so the downstream
// COMPUTE Attack code (state-handlers) can consume it without forking.
// Mirrors the field names returned by `resolveAttackerWeapon` for a PC
// weapon — A1/A2 attribute pair, checkBonus (accuracy), damageBonus,
// damageType, range, name, imageUrl.
//
// Returns null if the item is missing required fields (rolled_atr1 etc.).
// Caller refuses the action when this returns null.
export function buildPseudoWeaponFromNpcAttack(item) {
  const p = item?.system?.props ?? {};
  const A1 = String(p.rolled_atr1 ?? "").toUpperCase().trim();
  const A2 = String(p.rolled_atr2 ?? "").toUpperCase().trim();
  if (!A1 || !A2) return null;

  const checkBonus = Number(p.check_bonus ?? 0) || 0;
  const damageBonus = Number(p.damage_bonus ?? 0) || 0;
  const damageType = String(p.type_damage ?? "Physical");
  const range = String(p.skill_range ?? "Melee");

  return Object.freeze({
    // hand: NPC has no concept of main/off; flag the source kind so
    // downstream code can recognise it (e.g. CONFIRM/RESOLVE text that
    // says "Main Hand" can suppress that label for "npc").
    hand: "npc",
    name: String(item?.name ?? p.name ?? "Attack"),
    A1, A2,
    checkBonus,
    damageBonus,
    damageType,
    range,
    weaponType: String(p.weapon_type ?? p.category ?? ""),
    // Defense stat this attack resolves against ("def" | "mdef"). Mirrors the PC
    // weapon snapshot (resolveAttackerWeapon, snapshot.js) so an NPC Attack tagged
    // `defense_target_type: "mdef"` (Geist's Torcleaver, any magic monster attack)
    // resolves its check vs MDEF AND classifies as Magic — via resolvesVsMagicDefense,
    // the single source of truth for the hit test, the Strike/Magic card icon, and
    // the damage-class affinity. Blank falls back to DEF (the default for attacks).
    defenseTargetType: String(p.defense_target_type ?? "").trim().toLowerCase(),
    imageUrl: item?.img ?? null,
    // Effect prose (e.g. "On hit, inflicts Bleed") — surfaced in the action
    // card's Effect section. Normal Attacks can carry on-hit effects too, so
    // the attack card renders this just like a Skill's description.
    descriptionHtml: String(p.description ?? ""),
    // Carry the source Item UUID so the action card can deep-link back to
    // the attack sheet, and so rewind can attribute the action correctly.
    npcAttackItemUuid: item?.uuid ?? null,
    // Unified `uuid` (mirrors resolveAttackerWeapon) so on-hit reaction rows
    // on the attack Item attribute to THIS source (see weaponReactionInPlay).
    uuid: item?.uuid ?? null,
    // skill_target text — drives all-enemies auto-targeting (mirrors the
    // Skill/Spell branch's /\ball\b/ check). Stored lowercase for easy test.
    skillTarget: String(p.skill_target ?? "").trim().toLowerCase(),
    // Keyword bookkeeping tags — read by future interaction code.
    // Does NOT drive targeting logic (that comes from skillTarget above).
    hasPierce:   !!p.has_pierce,
    hasRoulette: !!p.has_roulette,
    hasOverflow: !!p.has_overflow,
  });
}
