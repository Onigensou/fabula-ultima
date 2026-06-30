// Single source of truth for reaction firing-mode semantics.
//
// `reaction_passive_mode` (system.props.reaction_config_table row) is one of:
//   "ask"   — player decides per occurrence (clickable pill / reaction menu).
//   "on"    — auto-fires WITHOUT a prompt. The player MAY toggle it to ask/off
//             via the Passive Manager (it is a player-governed default).
//   "force" — auto-fires WITHOUT a prompt, FUNCTIONALLY IDENTICAL to "on", but
//             engine-mandatory: it can NOT be toggled to ask/off, and is hidden
//             from the player-facing pill / menu / Passive-Manager UI.
//   "off"   — never fires.
//
// ⚠ CRITICAL INVARIANT: "on" and "force" are THE SAME for every firing /
// auto-apply / damage-fold / decision computation. They differ ONLY in player
// governance (toggleable vs mandatory) and UI visibility — never in whether the
// reaction actually fires or what it computes.
//
// Therefore EVERY "does this auto-fire / auto-apply?" test MUST call
// `isAutoFireReactionMode(mode)`. Do NOT inline `mode === "on"` for an auto-fire
// decision — that silently drops force-mode reactions (this exact omission once
// dropped a force-mode outgoing-damage rider from the damage fold). Routing all
// such checks through this one predicate makes it impossible for the two modes
// to drift apart again.
//
// Leaf module (no imports) so it can be shared by skill-effects.js, action-card.js,
// reaction-menu.js, etc. without an import cycle.
export function isAutoFireReactionMode(mode) {
  const m = String(mode ?? "").trim().toLowerCase();
  return m === "on" || m === "force";
}
