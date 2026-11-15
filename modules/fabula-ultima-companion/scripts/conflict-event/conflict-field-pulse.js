// ============================================================================
// Conflict Event emblem pulse for the field-rule events (Updraft, Sylphid Blaze).
//
// The approved trigger feedback: the emblem swells once when the event does
// something (conflict-event-panel.js pulseConflictEventEmblem). The Storm and the
// Crystal pulse from their own FX files; these two have no FX file, so their
// pulse lives here. Every client, from AE hooks, gated on the event the emblem
// is showing, so a Burn on a Storm map never pulses the Storm's emblem.
//
//   Updraft        an Updraft Flying lands (the event marks it with a flag)
//   Sylphid Blaze  a Burn lands, or a Burn's stacks go UP (a tick takes one
//                  off every turn; that must stay quiet)
// ============================================================================

import { pulseConflictEventEmblem, conflictEventEmblemId } from "./conflict-event-panel.js";

const FLAG_NS = "fabula-ultima-companion";
const BURN = "burn";

let _on = false;
/** Last stack count this client saw per Burn AE (uuid → charges). Display-only. */
const _burnSeen = new Map();

const chargesOf = (ae) => Number(ae?.flags?.[FLAG_NS]?.charges ?? 0) || 0;
const isBurn = (ae) => String(ae?.name ?? "").trim().toLowerCase() === BURN && ae?.parent?.documentName === "Actor";

export function initConflictFieldPulse() {
  if (_on) return;
  _on = true;

  Hooks.on("createActiveEffect", (ae) => {
    if (isBurn(ae)) {
      _burnSeen.set(ae.uuid, chargesOf(ae));
      if (conflictEventEmblemId() === "sylphid-blaze") pulseConflictEventEmblem();
    }
  });

  Hooks.on("updateActiveEffect", (ae, change) => {
    const emblem = conflictEventEmblemId();
    if (emblem === "updraft") {
      // The event stamps the flag right after the Flying lands; a refresh
      // rewrites the charges of a flagged one.
      const f = change?.flags?.[FLAG_NS] ?? {};
      const mine = ae?.flags?.[FLAG_NS]?.updraft === true;
      if (mine && (f.updraft === true || f.charges != null)) pulseConflictEventEmblem();
      return;
    }
    if (!isBurn(ae)) return;
    const now = chargesOf(ae);
    const before = _burnSeen.get(ae.uuid);
    _burnSeen.set(ae.uuid, now);
    if (emblem === "sylphid-blaze" && before != null && now > before) pulseConflictEventEmblem();
  });

  Hooks.on("deleteActiveEffect", (ae) => { _burnSeen.delete(ae?.uuid); });
}
