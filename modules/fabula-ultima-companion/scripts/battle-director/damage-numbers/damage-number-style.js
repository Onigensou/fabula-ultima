// Pure style resolver for BD floating damage numbers.
//
// Maps a semantic damage-number payload → a render SPEC the renderer applies.
// Zero DOM, zero Foundry references — so the look is unit-testable in isolation
// and the renderer (director-damage-numbers.js) stays a dumb spec-applier.
//
// Payload shape (the semantic event the GM broadcasts; see
// director-damage-numbers.js):
//   { kind, resource, amount, affinity, element, isCrit, pierce }
//     kind:     "loss" | "gain" | "spend" | "immune" | "absorb" | "miss"
//     resource: "hp" | "mp" | "shield" | "ip" | "zenit" | ...
//     affinity: "NE" | "VU" | "RS" | "IM" | "AB"  (HP loss only; else ignored)
//     element:  "fire" | "ice" | ... | "elementless"  (colors an NE hit)

// Element → numeral color. Mirrors the CANONICAL element palette the Battle
// Director action card uses (ELEMENT_COLOR in action-card.js), LIGHTENED where
// the canon hue — tuned for the light parchment card — would be illegible on
// the dark battlefield. Identity (bolt = purple, air = green, etc.) is kept.
export const ELEMENT_COLORS = Object.freeze({
  physical:    "#ffffff", // canon #1b1b1b (near-black, for parchment) → white on battlefield
  fire:        "#e25822", // canon
  ice:         "#5ab3d4", // canon
  air:         "#48c774", // canon (air is green in this game)
  wind:        "#48c774",
  earth:       "#b5793f", // canon #8b5e3c, lightened for dark bg
  bolt:        "#b06cc9", // canon #9b59b6 (amethyst) lightened — PURPLE, not yellow
  lightning:   "#b06cc9",
  light:       "#d4bb5f", // canon #a38b50, lightened
  dark:        "#8c6cff", // canon #4b0082 (indigo) lightened — bluer than bolt to stay distinct
  poison:      "#3fae6c", // canon #2e8b57, lightened
  elementless: "#ffffff",
});

const DEFAULT_COLOR = "#ffffff";

function elementColor(element) {
  const key = String(element ?? "").toLowerCase();
  return ELEMENT_COLORS[key] ?? DEFAULT_COLOR;
}

// Magnitude → numeral font size (px). Small hits read ~30, big hits cap ~56,
// so a 400-damage nuke visibly dwarfs a 12-damage chip without unbounded growth.
function magnitudeFont(amount) {
  const a = Math.max(0, Number(amount) || 0);
  return Math.round(30 + Math.min(26, a / 7));
}

// Resolve the full render spec for a payload.
//
// Returns:
//   {
//     variant,      // root css modifier (kind) — "loss"|"gain"|...
//     tag,          // word tag above the number, or null
//     tagVariant,   // tag css modifier — "weak"|"resist"|"immune"|...
//     critBanner,   // show the gold "CRITICAL!" banner above everything
//     number,       // numeral string ("123" / "+40" / "-12") or null
//     color,        // numeral color
//     fontPx,       // numeral font size
//     crit, pierce, // booleans passed through for renderer modifiers
//     shake,        // numeral shake (used on WEAK)
//   }
export function resolveDamageNumberStyle(payload = {}) {
  const {
    kind = "loss",
    resource = "hp",
    amount = 0,
    affinity = "NE",
    element = "elementless",
    isCrit = false,
    pierce = false,
  } = payload;

  const spec = {
    variant: kind,
    tag: null,            // small slab word above the number
    tagVariant: null,
    critBanner: false,
    bigWord: null,        // large plain word rendered IN the numeral slot (MISS)
    iconClass: null,      // FontAwesome class prefixed inside the numeral (shield)
    number: null,
    color: DEFAULT_COLOR,
    fontPx: magnitudeFont(amount),
    crit: !!isCrit,
    pierce: !!pierce,
    shake: false,
  };

  switch (kind) {
    case "miss":
      // Big plain outlined word (not a compressed slab tag) — reads at a glance.
      spec.bigWord = "MISS";
      spec.color = "#eef2f7";
      spec.fontPx = 46;
      break;

    case "block":
      // A HIT whose damage a defender reaction (Ninja Log) soaked to 0 — the
      // visual twin of MISS, but a shield glyph + steel-blue word so it reads as
      // "blocked / nullified", NOT "dodged" (the attack DID land — RAW 0-damage
      // hit). Number-only event (no amount).
      spec.bigWord = "BLOCK";
      spec.iconClass = "fa-solid fa-shield-halved";
      spec.color = "#bcd2e8";
      spec.fontPx = 42;
      break;

    case "immune":
      spec.tag = "IMMUNE";
      spec.tagVariant = "immune";
      spec.color = "#bcd2e8";
      break;

    case "absorb":
      // Green number to mirror the heal pattern (an absorb IS a heal), but keep
      // the ABSORB tag so it never reads as a plain heal.
      spec.tag = "ABSORB";
      spec.tagVariant = "absorb";
      spec.number = `+${Math.abs(amount)}`;
      spec.color = "#52e36a";
      break;

    case "gain":
      spec.number = `+${Math.abs(amount)}`;
      spec.color = resource === "mp" ? "#3fb6ff" : "#52e36a";
      break;

    case "spend":
      spec.number = `-${Math.abs(amount)}`;
      spec.color = "#cfd2da";
      spec.fontPx = Math.round(spec.fontPx * 0.8);
      break;

    case "loss":
    default:
      spec.number = `${Math.abs(amount)}`;
      if (resource === "mp") {
        spec.color = "#7fb6ff";
      } else if (resource === "shield") {
        // Steel color + a shield glyph so it never reads as elemental HP damage.
        spec.color = "#d9e2ec";
        spec.iconClass = "fa-solid fa-shield-halved";
      } else {
        spec.color = elementColor(element);
      }

      if (affinity === "VU") {
        spec.tag = "WEAK!";
        spec.tagVariant = "weak";
        spec.color = "#ff7a2f";
        spec.fontPx = Math.round(spec.fontPx * 1.18);
        spec.shake = true;
      } else if (affinity === "RS") {
        spec.tag = "RESIST";
        spec.tagVariant = "resist";
        spec.color = "#8fb3d9";
        spec.fontPx = Math.round(spec.fontPx * 0.82);
      }
      break;
  }

  // Crit only applies to a landed damaging hit. It enlarges the numeral and
  // raises the gold CRITICAL banner — coexisting with a WEAK!/RESIST tag rather
  // than replacing it (a critical weakness hit shows BOTH).
  if (spec.crit && kind === "loss") {
    spec.fontPx = Math.round(spec.fontPx * 1.38);
    spec.critBanner = true;
  }

  return spec;
}
