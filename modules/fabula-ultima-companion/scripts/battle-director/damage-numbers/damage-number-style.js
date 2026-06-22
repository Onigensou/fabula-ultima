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

// Element → numeral color for a neutral (NE) hit. Persona-ish saturated hues,
// readable on the dark battlefield with the dark text-stroke the renderer adds.
export const ELEMENT_COLORS = Object.freeze({
  fire:        "#ff5a3c",
  ice:         "#5ad1ff",
  bolt:        "#ffe04a",
  lightning:   "#ffe04a",
  earth:       "#c8924a",
  air:         "#eaf4ff",
  wind:        "#eaf4ff",
  light:       "#ffe9a8",
  dark:        "#b07cff",
  poison:      "#9be15d",
  physical:    "#ffffff",
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
    tag: null,
    tagVariant: null,
    critBanner: false,
    number: null,
    color: DEFAULT_COLOR,
    fontPx: magnitudeFont(amount),
    crit: !!isCrit,
    pierce: !!pierce,
    shake: false,
  };

  switch (kind) {
    case "miss":
      spec.tag = "MISS";
      spec.tagVariant = "miss";
      spec.color = "#cfd6e0";
      break;

    case "immune":
      spec.tag = "IMMUNE";
      spec.tagVariant = "immune";
      spec.color = "#bcd2e8";
      break;

    case "absorb":
      spec.tag = "ABSORB";
      spec.tagVariant = "absorb";
      spec.number = `+${Math.abs(amount)}`;
      spec.color = "#5ad1ff";
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
      if (resource === "mp")          spec.color = "#7fb6ff";
      else if (resource === "shield") spec.color = "#d9e2ec";
      else                            spec.color = elementColor(element);

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
