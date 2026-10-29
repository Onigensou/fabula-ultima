"use strict";

/**
 * suite: camp — camp scenes have a bed for every member.
 *
 * Every camp scene needs one sleep pose spot per member (4): at bedtime
 * camp-walk.js lays each member on the sleep spot paired with their member
 * spot (event-system/pose-spots). A camp with fewer still works (the rest go
 * back to their spot, standing), so this is a WARN.
 *
 * A sleep spot = a tile with flags.oni-event-system.poseSpot
 *   { enabled, pose: "sleep", place, slot? }
 * Slots, when set, must be 1-4 and not shared.
 */

const { SEVERITY, finding } = require("../util");

const ID = "camp";
const TITLE = "Camp sleep spots";
const MOD = "fabula-ultima-companion";
const ES_SCOPE = "oni-event-system";
const MEMBERS = 4;

const isCamp = (scene) => scene?.flags?.[MOD]?.oniFabula?.general?.sceneMode === "camp";

function run(world) {
  const out = [];
  for (const scene of world.scenes) {
    if (!isCamp(scene)) continue;
    const ref = { doc: "scene", id: scene._id };
    const beds = (scene.tiles || []).filter((t) => {
      const s = t.flags?.[ES_SCOPE]?.poseSpot;
      return s?.enabled && s.pose === "sleep" && Number.isFinite(s.place?.x) && !t.hidden;
    });
    if (beds.length < MEMBERS) {
      out.push(finding(ID, SEVERITY.WARN,
        `Camp "${scene.name}": ${beds.length} sleep spot(s), needs ${MEMBERS} (one per member) — the rest sleep standing on their spot`,
        ref));
    }
    const seen = new Map();
    for (const t of beds) {
      const slot = t.flags[ES_SCOPE].poseSpot.slot;
      if (slot == null || slot === "") continue;
      if (!Number.isInteger(Number(slot)) || slot < 1 || slot > MEMBERS) {
        out.push(finding(ID, SEVERITY.WARN, `Camp "${scene.name}": sleep spot ${t._id} has bedtime slot "${slot}" (must be 1-${MEMBERS})`, { ...ref, extra: t._id }));
      } else if (seen.has(Number(slot))) {
        out.push(finding(ID, SEVERITY.WARN, `Camp "${scene.name}": sleep spots ${seen.get(Number(slot))} and ${t._id} share bedtime slot ${slot}`, { ...ref, extra: t._id }));
      } else seen.set(Number(slot), t._id);
    }
  }
  return out;
}

module.exports = { id: ID, title: TITLE, run };
