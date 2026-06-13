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
export async function pickWeaponMode({ director, mainWeapon, offWeapon, allowTwoWeapon = false, twoWeaponSolo = false, virtualAttacks = [], externalCancel = null }) {
  const arrow = `<i class="fa-solid fa-arrow-right" style="opacity:0.55; font-size:10.5px;"></i>`;
  const sections = [];

  // A solo two-weapon grant (Double Arrow: a lone bow attacks twice) sets
  // offWeapon === mainWeapon. In that case there is no real off-hand, so we
  // skip the duplicate "Off-Hand" single row and present ONE clear "Attack
  // Twice" option rather than a confusing "Weapon → Weapon" pair.
  const soloDouble = !!(allowTwoWeapon && twoWeaponSolo && mainWeapon);
  const hasRealOffhand = !!(offWeapon && !soloDouble);

  // Primary visual = weapon image (or weapon-type FA icon); the Main/Off/Two-
  // Weapon role sits on the secondary line so the eye lands on the weapon.
  const singleHand = [];
  if (mainWeapon) {
    singleHand.push({
      value: "main",
      imageUrl: safeUrl(mainWeapon.imageUrl),
      fallbackIcon: weaponIcon(mainWeapon.weaponType),
      primary: escapeHtml(mainWeapon.name),
      secondary: `${soloDouble ? "Single Shot" : "Main Hand"}<span class="dot">•</span>${escapeHtml(mainWeapon.A1)} + ${escapeHtml(mainWeapon.A2)}`,
    });
  }
  if (hasRealOffhand) {
    singleHand.push({
      value: "off",
      imageUrl: safeUrl(offWeapon.imageUrl),
      fallbackIcon: weaponIcon(offWeapon.weaponType),
      primary: escapeHtml(offWeapon.name),
      secondary: `Off-Hand<span class="dot">•</span>${escapeHtml(offWeapon.A1)} + ${escapeHtml(offWeapon.A2)}`,
    });
  }
  if (singleHand.length) sections.push({ label: "Single Hand", hint: null, items: singleHand });

  if (soloDouble) {
    // Lone-weapon double attack — one option, two separate attacks (HR 0).
    sections.push({
      label: "Two-Weapon",
      hint: "Attack twice — HR 0",
      items: [
        {
          value: "two-weapon",
          imageUrl: safeUrl(mainWeapon.imageUrl),
          fallbackIcon: `<i class="fa-solid fa-swords" aria-hidden="true"></i>`,
          primary: `${escapeHtml(mainWeapon.name)} ${arrow} ${escapeHtml(mainWeapon.name)}`,
          secondary: `Attack twice (two separate rolls)`,
        },
      ],
    });
  } else if (allowTwoWeapon && mainWeapon && offWeapon) {
    sections.push({
      label: "Two-Weapon",
      hint: "Both attack — HR 0",
      items: [
        {
          value: "two-weapon",
          imageUrl: safeUrl(mainWeapon.imageUrl),
          fallbackIcon: `<i class="fa-solid fa-swords" aria-hidden="true"></i>`,
          primary: `${escapeHtml(mainWeapon.name)} ${arrow} ${escapeHtml(offWeapon.name)}`,
          secondary: `Main fires first`,
        },
        {
          value: "two-weapon-off-first",
          imageUrl: safeUrl(offWeapon.imageUrl),
          fallbackIcon: `<i class="fa-solid fa-swords" aria-hidden="true"></i>`,
          primary: `${escapeHtml(offWeapon.name)} ${arrow} ${escapeHtml(mainWeapon.name)}`,
          secondary: `Off fires first`,
        },
      ],
    });
  }

  // Virtual attacks — synthesised profiles exposed by AEs (Dual Shieldbearer's
  // Twin Shields, future "X+Y unlocks Z"). Author label per profile so multiple
  // exposures are distinguishable.
  if (Array.isArray(virtualAttacks) && virtualAttacks.length) {
    sections.push({
      label: "Virtual",
      hint: virtualAttacks.length === 1 ? null : `${virtualAttacks.length} options`,
      items: virtualAttacks.map((va, i) => ({
        value: `virtual:${i}`,
        imageUrl: safeUrl(va.imageUrl),
        fallbackIcon: weaponIcon(va.weaponType),
        primary: escapeHtml(va.name),
        secondary: `${escapeHtml(va.weaponType || "Brawling")}<span class="dot">•</span>${escapeHtml(va.A1)} + ${escapeHtml(va.A2)}`,
      })),
    });
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
