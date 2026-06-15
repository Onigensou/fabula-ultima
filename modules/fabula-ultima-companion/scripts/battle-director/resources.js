// Single source of truth for character RESOURCES (HP/MP/IP/Shield/Zero Power/…).
//
// One row here defines a resource's storage props + display, and is consumed by
// every layer so a NEW resource becomes fully supported everywhere at once:
//   - grant / consume / set_resource         (skill-effects.js)
//   - restore-preview headline + per-target   (action-profile.js buildHealPerTarget)
//   - the action-card RESTORE label/colour    (action-card.js, via healingObj)
//
// To add a future resource: add a row (prop + label + restorable:true). That's it.
//
// Fields:
//   prop        — actor.system.props key holding the current value (REQUIRED)
//   max         — actor.system.props key holding the max (null = uncapped)
//   hardMin     — clamp floor (default none)
//   hardMax     — clamp ceiling (default none / use `max`)
//   label       — display name on the card headline ("HP", "Zero Power", …)
//   restorable  — true if a positive `grant` to it should render a RESTORE preview
//   colour      — headline tint when restoring (falls back to a generic restore hue)

export const RESOURCE_REGISTRY = {
  hp:         { prop: "current_hp",       max: "max_hp",  label: "HP",             restorable: true, colour: "#2a8a3a" },
  mp:         { prop: "current_mp",       max: "max_mp",  label: "MP",             restorable: true, colour: "#1e6cff" },
  ip:         { prop: "current_ip",       max: "max_ip",  label: "IP",             restorable: true, colour: "#c9a227" },
  zero_power: { prop: "zero_power_value", max: null, hardMin: 0, hardMax: 6, label: "Zero Power", restorable: true, colour: "#b061ff" },
  zenit:      { prop: "zenit",            max: null,      label: "Zenit",          restorable: true, colour: "#c9a227" },
  enmity:     { prop: "enmity",           max: null,      label: "Enmity",         restorable: true, colour: "#c0392b" },
  fp:         { prop: "fabula_point",     max: null,      label: "Fabula Points",  restorable: true, colour: "#c9a227" },
  shield:     { prop: "shield_value",     max: null, hardMin: 0, label: "Shield",  restorable: true, colour: "#7f8c8d" },
};

// Author-friendly synonyms → canonical key. Keep lowercase.
const RESOURCE_ALIASES = {
  zp: "zero_power", "zero power": "zero_power", zeropower: "zero_power",
  hitpoints: "hp", mindpoints: "mp", inventorypoints: "ip",
  fabula: "fp", "fabula point": "fp", "fabula points": "fp", fabula_points: "fp",
};

// Resolve a resource key (case-insensitive, alias-aware) → its def (+ canonical key).
export function resolveResourceDef(key) {
  const k = String(key ?? "").trim().toLowerCase();
  if (!k) return null;
  const canon = RESOURCE_ALIASES[k] ?? k;
  const def = RESOURCE_REGISTRY[canon];
  return def ? { key: canon, ...def } : null;
}

export function resourceLabel(key) {
  return resolveResourceDef(key)?.label ?? String(key ?? "").toUpperCase();
}
