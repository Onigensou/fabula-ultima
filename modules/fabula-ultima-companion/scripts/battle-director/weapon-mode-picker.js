// Weapon-Mode Picker — Attack's weapon-selection step.
//
// Thin builder over the shared list-picker (list-picker.js): it turns the
// attacker's weapon bundle into Single-Hand / Two-Weapon / Virtual sections and
// delegates rendering + lifecycle + keyboard to pickFromList. No bespoke overlay
// here anymore — only the Attack-specific choice-set construction.
//
// Shown by the TARGET state when the attacker has more than one attack option
// (RAW Core p.69 Two-Weapon Fighting when both hands share a Category; off-hand
// always available when equipped; AE-exposed virtual attacks).
//
// Returns a Promise resolving to one of:
//   "main"                  → main-hand only (no penalty)
//   "two-weapon"            → both, main hand fires first
//   "two-weapon-off-first"  → both, off hand fires first
//   "off"                   → off-hand only
//   "virtual:<N>"           → virtualAttacks[N] (e.g. Dual Shieldbearer Twin Shields)
//   null                    → cancelled (escape / cancel button)

import { log, warn } from "./logger.js";
import { pickFromList, ListPicker } from "./list-picker.js";

const WEAPON_ICON = {
  arcane: "fa-book", bow: "fa-bow-arrow", brawling: "fa-hand-fist",
  dagger: "fa-dagger", firearm: "fa-gun", flail: "fa-mace",
  heavy: "fa-hammer", spear: "fa-location-arrow", sword: "fa-sword",
  thrown: "fa-bomb",
};

function weaponIcon(weaponType) {
  const cls = WEAPON_ICON[String(weaponType || "").toLowerCase()] ?? "fa-sword";
  return `<i class="fa-solid ${cls}" aria-hidden="true"></i>`;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[m]));
}

// Inline URL guard — strips anything that could break inline HTML.
function safeUrl(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s || /['"<>\n\r]/.test(s)) return null;
  return s;
}

// `allowTwoWeapon` is true only when the two equipped weapons share the same
// Category (RAW Core p.69). RAW grants BOTH orders ("you perform the two attacks
// in any order you prefer") — order matters because weapon riders (poison ticks,
// status applies, on-hit reactions) depend on which strike lands first.
//
// `virtualAttacks` is an array of frozen profiles from snapshot.resolveVirtualAttacks
// — each becomes a pick option in a separate "Virtual" section.
// Name an N-strike option by its COUNT rather than by the mechanism that grants
// it: "Double Attack", "Triple Attack", … The old copy said "Attack twice",
// which reads as an instruction and doesn't generalise past two. Falls back to
// "N× Attack" beyond the named range so a future Chain 7 still renders sanely.
const MULTI_ATTACK_WORD = [null, null, "Double", "Triple", "Quadruple", "Quintuple", "Sextuple"];
function multiAttackLabel(n) {
  const word = MULTI_ATTACK_WORD[n];
  return word ? `${word} Attack` : `${n}× Attack`;
}

// Every multi-strike option resolves each strike with High Roll forced to 0
// (see ignoreHR in action-profile). That is the real cost of taking one, so it
// rides the option as a chip beside the cost instead of being buried in a
// section hint. Red, because it is a penalty.
const NO_HR_CHIP = { text: "No HR", tone: "danger" };

// Range-class lockouts (Snared blocks melee, Obscure blocks ranged). The picker
// still OPENS with these weapons listed — a player needs to see WHY a weapon is
// unavailable, not just find it missing — but the rows are disabled and struck
// with the SAME red rubber-stamp the turn menu puts across a Stagger/Panic-
// blocked blade, so a status lockout looks identical wherever it appears.
// `rangeBlock` is plain data: { melee: reason|null, ranged: reason|null }.
function blockReasonFor(weapon, rangeBlock) {
  if (!weapon || !rangeBlock) return null;
  const r = String(weapon.range ?? "").trim().toLowerCase();
  if (/ranged|distance/.test(r)) return rangeBlock.ranged ?? null;
  if (/melee/.test(r)) return rangeBlock.melee ?? null;
  return null;
}

// ── Row meta, matching the Skill / Spell picker ─────────────────────────────
// A weapon row used to read "Main Hand • MIG + MIG" — the hand, which the
// SECTION already states, and nothing about what the weapon actually does. The
// skill rows next to it show element • range • target • dice, so weapons now
// show the same four facts in the same order, with the redundant hand dropped.

// Default when a weapon declares no `skill_target` — the Attack TARGET branch
// falls back to a single enemy, so the row must say the same thing.
const DEFAULT_WEAPON_TARGET = "One Enemy";

// "one enemy" / "all enemies" arrive lowercased off system.props; Title Case
// them so the line matches a skill's own casing.
function titleCase(s) {
  return String(s ?? "").replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

// These props are hand-authored across ~90 weapons and are not clean: the survey
// of `weapon1_damagetype` turned up "Physical", "physical", "", "-" and
// ", bolt" (a stray leading separator). Rendering them raw put ", Bolt" on the
// row. Split, drop the empties and the "-" placeholder, Title Case what is left,
// and return "" when there is nothing to say so the caller omits the segment
// rather than printing a bullet with nothing after it.
function cleanList(raw) {
  const parts = String(raw ?? "")
    .split(/[,/]/)
    .map((s) => s.trim())
    .filter((s) => s && s !== "-")
    .map(titleCase);
  return [...new Set(parts)].join(" / ");
}

// Accuracy reads as the game writes it: the attribute pair plus the weapon's
// accuracy modifier when it has one ("DEX + INS + 2").
function accuracyText(w) {
  const bonus = Number(w?.checkBonus ?? 0) || 0;
  const pair = `${escapeHtml(w?.A1 ?? "")} + ${escapeHtml(w?.A2 ?? "")}`;
  return bonus ? `${pair} + ${bonus}` : pair;
}

// Damage as 【HR + N】, the notation on the character sheet and the action card.
// Multi-strike options force HR to 0, so those rows drop the HR term entirely
// and show the bare bonus — writing "HR + 6" beside a "No HR" chip would promise
// a High Roll the strike will not get. Kept in "+N" form so a 0-damage weapon
// reads as a bonus of zero rather than a naked "0" of unclear meaning.
function damageText(w, { noHighRoll = false } = {}) {
  const bonus = Number(w?.damageBonus ?? 0) || 0;
  if (noHighRoll) return `+ ${bonus}`;
  return bonus ? `HR + ${bonus}` : "HR";
}

// The dice pill is a chip, not another word in the list, so it is appended
// AFTER the dot-joined facts rather than joined into them. Dot-joining it left a
// dangling "•" at the end of the line whenever the pill wrapped to the next one.
function metaLine(textParts, dicePill) {
  const line = textParts.filter(Boolean)
    .map((b) => `<span class="bullet">${b}</span>`)
    .join(` <span class="dot">•</span> `);
  return dicePill ? `${line} <span class="check-attr">${dicePill}</span>` : line;
}

function weaponMeta(w) {
  if (!w) return "";
  return metaLine([
    escapeHtml(cleanList(w.damageType)),
    escapeHtml(cleanList(w.range)),
    escapeHtml(titleCase(w.skillTarget || DEFAULT_WEAPON_TARGET)),
  ], accuracyText(w));
}

// For a pair row the two weapons are usually the same category but rarely the
// same numbers, so shared facts collapse and differing ones show both sides in
// firing order — "Physical • Melee • One Enemy • MIG+MIG → DEX+DEX".
function pairMeta(first, second) {
  if (!first || !second) return weaponMeta(first || second);
  const merge = (a, b) => cleanList([cleanList(a), cleanList(b)].filter(Boolean).join(","));
  const a = accuracyText(first);
  const b = accuracyText(second);
  return metaLine([
    escapeHtml(merge(first.damageType, second.damageType)),
    escapeHtml(merge(first.range, second.range)),
    escapeHtml(titleCase(first.skillTarget || second.skillTarget || DEFAULT_WEAPON_TARGET)),
  ], a === b ? a : `${a} &rarr; ${b}`);
}

export async function pickWeaponMode({ director, mainWeapon, offWeapon, allowTwoWeapon = false, twoWeaponSolo = false, virtualAttacks = [], rangeBlock = null, externalCancel = null }) {
  const arrow = `<i class="fa-solid fa-arrow-right" style="opacity:0.55; font-size:10.5px;"></i>`;
  const sections = [];

  // A solo two-weapon grant (Double Arrow: a lone bow attacks twice) sets
  // offWeapon === mainWeapon. In that case there is no real off-hand, so we
  // skip the duplicate "Off-Hand" single row and present ONE clear "Attack
  // Twice" option rather than a confusing "Weapon → Weapon" pair.
  const soloDouble = !!(allowTwoWeapon && twoWeaponSolo && mainWeapon);
  const hasRealOffhand = !!(offWeapon && !soloDouble);

  // Primary visual = weapon image (or weapon-type FA icon); the meta line below
  // it carries what the weapon DOES (element / range / target / dice), matching
  // the Skill and Spell rows. The hand is not repeated — the section says it.
  // A row is blocked when ANY weapon it would swing is range-locked out; the
  // reason becomes a rubber-stamp across the row, not a trailing chip.
  const blockOf = (...weapons) => {
    const reasons = [...new Set(weapons.map((w) => blockReasonFor(w, rangeBlock)).filter(Boolean))];
    return reasons.length ? { disabled: true, stamp: reasons.join(" / ") } : null;
  };
  // Damage rides the trailing cell, where a skill puts its cost — same slot, and
  // the fact a player is actually comparing weapons on.
  const dmgChip = (w, opts) => ({ text: escapeHtml(damageText(w, opts)), tone: null });

  const singleHand = [];
  if (mainWeapon) {
    singleHand.push({
      value: "main",
      imageUrl: safeUrl(mainWeapon.imageUrl),
      fallbackIcon: weaponIcon(mainWeapon.weaponType),
      primary: escapeHtml(mainWeapon.name),
      secondary: weaponMeta(mainWeapon),
      badges: [dmgChip(mainWeapon)],
      ...(blockOf(mainWeapon) ?? {}),
    });
  }
  if (hasRealOffhand) {
    singleHand.push({
      value: "off",
      imageUrl: safeUrl(offWeapon.imageUrl),
      fallbackIcon: weaponIcon(offWeapon.weaponType),
      primary: escapeHtml(offWeapon.name),
      secondary: weaponMeta(offWeapon),
      badges: [dmgChip(offWeapon)],
      ...(blockOf(offWeapon) ?? {}),
    });
  }
  // With the hand dropped from every row, a lone-weapon double still needs the
  // single-strike option distinguished from the pair below it, and "Single Hand"
  // would be a lie for a bow. The section label carries it instead.
  if (singleHand.length) {
    sections.push({ label: soloDouble ? "Single Strike" : "Single Hand", hint: null, items: singleHand });
  }

  if (soloDouble) {
    // Lone-weapon multi-strike — one option, N separate attacks.
    sections.push({
      label: multiAttackLabel(2),
      hint: "One weapon, two separate rolls",
      items: [
        {
          value: "two-weapon",
          imageUrl: safeUrl(mainWeapon.imageUrl),
          fallbackIcon: `<i class="fa-solid fa-swords" aria-hidden="true"></i>`,
          primary: `${escapeHtml(mainWeapon.name)} ${arrow} ${escapeHtml(mainWeapon.name)}`,
          secondary: pairMeta(mainWeapon, mainWeapon),
          badges: [NO_HR_CHIP, dmgChip(mainWeapon, { noHighRoll: true })],
          ...(blockOf(mainWeapon) ?? {}),
        },
      ],
    });
  } else if (allowTwoWeapon && mainWeapon && offWeapon) {
    sections.push({
      label: multiAttackLabel(2),
      hint: "Both weapons strike",
      items: [
        {
          value: "two-weapon",
          imageUrl: safeUrl(mainWeapon.imageUrl),
          fallbackIcon: `<i class="fa-solid fa-swords" aria-hidden="true"></i>`,
          primary: `${escapeHtml(mainWeapon.name)} ${arrow} ${escapeHtml(offWeapon.name)}`,
          // The arrow in the primary already states the order, so the meta line
          // is free to carry the same four facts every other row carries.
          secondary: pairMeta(mainWeapon, offWeapon),
          badges: [NO_HR_CHIP],
          // Either hand being locked out kills the pair, so both weapons are tested.
          ...(blockOf(mainWeapon, offWeapon) ?? {}),
        },
        {
          value: "two-weapon-off-first",
          imageUrl: safeUrl(offWeapon.imageUrl),
          fallbackIcon: `<i class="fa-solid fa-swords" aria-hidden="true"></i>`,
          primary: `${escapeHtml(offWeapon.name)} ${arrow} ${escapeHtml(mainWeapon.name)}`,
          secondary: pairMeta(offWeapon, mainWeapon),
          badges: [NO_HR_CHIP],
          ...(blockOf(mainWeapon, offWeapon) ?? {}),
        },
      ],
    });
  }

  // Virtual attacks — synthesised profiles exposed by AEs (Dual Shieldbearer's
  // Twin Shields, future "X+Y unlocks Z"). Author label per profile so multiple
  // exposures are distinguishable.
  // Versatile entries are REAL weapons sitting in the bag, not synthesised
  // profiles, so they get their own section and their own "not equipped" hint —
  // "Virtual" would read as a phantom attack. Both kinds still emit `virtual:<i>`
  // against the SHARED index (see buildWeaponBundle), so the row's position in
  // its section is irrelevant; only the global index is used.
  if (Array.isArray(virtualAttacks) && virtualAttacks.length) {
    const row = (va, i) => ({
      value: `virtual:${i}`,
      imageUrl: safeUrl(va.imageUrl),
      fallbackIcon: weaponIcon(va.weaponType),
      primary: escapeHtml(va.name),
      secondary: weaponMeta(va),
      badges: [dmgChip(va)],
      ...(blockOf(va) ?? {}),
    });
    const indexed = virtualAttacks.map((va, i) => [va, i]);
    const synthesised = indexed.filter(([va]) => va?.hand !== "versatile");
    const versatile = indexed.filter(([va]) => va?.hand === "versatile");
    if (synthesised.length) {
      sections.push({
        label: "Virtual",
        hint: synthesised.length === 1 ? null : `${synthesised.length} options`,
        items: synthesised.map(([va, i]) => row(va, i)),
      });
    }
    if (versatile.length) {
      sections.push({
        label: "Versatile",
        hint: "Not equipped — usable anyway",
        items: versatile.map(([va, i]) => row(va, i)),
      });
    }
  }

  if (!sections.length) { warn("pickWeaponMode: no weapon options to show"); return null; }

  log("pickWeaponMode", sections.flatMap((s) => s.items.map((o) => o.value)).join(" / "));

  // The shared list-picker returns the chosen row's `value` (the mode string),
  // or null on cancel — exactly the old contract.
  return pickFromList({
    director,
    title: "Choose Attack Mode",
    sections,
    externalCancel,
    listHeight: "min(56vh, 440px)",  // consistent size across selector pickers
    zIndex: 96,
  });
}

// Lifecycle delegates to the shared list-picker (the overlay now lives there,
// keyed by director.combatId — same key pickFromList derives from `director`).
export const WeaponModePicker = {
  despawn({ director }) { ListPicker.despawn({ director }); },
  despawnAll() { ListPicker.despawnAll(); },
};
