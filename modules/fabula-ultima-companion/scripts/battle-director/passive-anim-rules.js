// ============================================================================
// Passive fallback — the pure rules (approved on mockup v4, 2026-11-04).
//
// A passive / reaction whose chain plays no animation of its own gets short
// beats where its effects LAND. A passive is not a turn: nothing moves and
// nothing waits on it.
//
//   buff    → warm rising lines on the recipient
//   debuff  → cool falling lines
//   heal    → green rising lines        mp → blue rising lines
//   cleanse → white rising lines
//   damage  → the element's small hit clip on the recipient (BD's number plays
//             the sound — a passive never claims the hit, hit-sound-rules.js)
//   redirect→ a bolt-style arc from the owner, then the hit (damage dealt by a
//             damage-reaction follow-up: Obsidrax's Earthen Wire)
//
// Input is the rows that ACTUALLY RAN (the recorder in skill-effects
// applyEffectRow), with their real recipients — so a condition that failed or a
// random pick shows the truth. Tested by passive-anim-rules.test.mjs.
// ============================================================================

export const LINE_STYLE = {
  buff:    { dir: "up",   color: 0xffb347, sfx: "Soundboard/Powerup.ogg" },
  debuff:  { dir: "down", color: 0x8f7dff, sfx: "Soundboard/Down2.ogg" },
  // HP / MP gains: BD's own gain VFX already floats the blue / green "+X" and
  // plays its gain sound (playResourceGainVfx) — one sound, so the lines stay quiet.
  heal:    { dir: "up",   color: 0x7dffa0, sfx: null },
  mp:      { dir: "up",   color: 0x6ec8ff, sfx: null },
  cleanse: { dir: "up",   color: 0xffffff, sfx: "Soundboard/Powerup.ogg" },
};
// damage / redirect: the small element hit clip (no sound of its own)
export const PASSIVE_HIT_CLIP = {
  physical: "001_hit_physical", fire: "003_hit_fire", ice: "004_hit_ice", bolt: "005_hit_thunder",
  air: "002_hit_effect", earth: "002_hit_effect", dark: "002_hit_effect", light: "002_hit_effect", poison: "002_hit_effect",
};
// rows that mean "this chain draws its own picture" — the fallback stays out
export const OWN_ANIMATION_KINDS = new Set(["play_animation", "free_action"]);
const MAX_BEATS = 3;

const lc = (v) => String(v ?? "").trim().toLowerCase();
const ELEMENT_ALIAS = { lightning: "bolt", thunder: "bolt", electric: "bolt", wind: "air", shadow: "dark", holy: "light" };
export function hitElement(raw) {
  const s = lc(raw);
  if (PASSIVE_HIT_CLIP[s]) return s;
  return ELEMENT_ALIAS[s] ?? "physical";
}

// records: [{ kind, row, res }] in run order.
// opts:
//   ownerActorUuid           the passive's owner
//   sameSide(actorUuid)      → true when the recipient is on the owner's side
//   aeTagOf(appliedEntry)    → "buff" | "debuff" | null (the AE's tags)
//   redirect                 damage here is a damage-reaction follow-up
// → { beats: [{ k, recipients: [actorUuid], element? }], skipped: reason|null }
export function composePassiveBeats(records, { ownerActorUuid = null, sameSide = null, aeTagOf = null, redirect = false } = {}) {
  const list = Array.isArray(records) ? records : [];
  if (list.some((r) => OWN_ANIMATION_KINDS.has(lc(r?.kind)))) return { beats: [], skipped: "own-animation" };
  const beats = [];
  const add = (k, actorUuid, extra = {}) => {
    if (!actorUuid) return;
    let b = beats.find((x) => x.k === k && (x.element ?? null) === (extra.element ?? null));
    if (!b) { b = { k, recipients: [], ...extra }; beats.push(b); }
    if (!b.recipients.includes(actorUuid)) b.recipients.push(actorUuid);
  };
  const friendly = (uuid) => (uuid && uuid === ownerActorUuid) || (typeof sameSide === "function" && sameSide(uuid));
  for (const rec of list) {
    if (!rec?.res?.ok || rec.res.skipped) continue;
    const kind = lc(rec.kind);
    const applied = Array.isArray(rec.res.applied) ? rec.res.applied : [];
    if (kind === "apply_ae") {
      for (const e of applied) {
        if (!e?.actorUuid || e.removed || e.unchanged || e.skipped) continue;
        // charges added to an effect that is already there (a Grave Points
        // counter ticking up) or a refresh in place is bookkeeping — only a
        // newly applied effect is something to show (live sandbox, 2026-11-04)
        if (e.chargesAdded !== undefined || e.refreshedInPlace) continue;
        // buff / debuff tag → that; a status condition (Dazed, Poisoned…) →
        // by side; anything else is bookkeeping (a "Spent" / "Ready" marker)
        // that nobody should see.
        const tag = typeof aeTagOf === "function" ? aeTagOf(e) : null;
        if (tag === "buff" || tag === "debuff") add(tag, e.actorUuid);
        else if (tag === "status") add(friendly(e.actorUuid) ? "buff" : "debuff", e.actorUuid);
      }
    } else if (kind === "grant") {
      for (const e of applied) {
        const res = lc(e?.resource);
        const delta = Number(e?.delta ?? ((Number(e?.to) || 0) - (Number(e?.from) || 0)));
        if (!e?.actorUuid || !(delta > 0)) continue;
        if (res === "hp") add("heal", e.actorUuid);
        else if (res === "mp") add("mp", e.actorUuid);
      }
    } else if (kind === "deal_damage") {
      for (const e of applied) {
        const amt = Number(e?.final ?? e?.amount ?? 0);
        if (!e?.actorUuid || !(amt > 0) || lc(e?.direction) === "gain") continue;
        add(redirect ? "redirect" : "damage", e.actorUuid, { element: hitElement(e.element) });
      }
    } else if (kind === "remove_tagged_ae") {
      const tag = lc(rec.row?.filter_tag);
      for (const e of applied) {
        const uuid = typeof e === "string" ? e : e?.actorUuid;
        if (!uuid) continue;
        if (tag === "debuff") add("cleanse", uuid);
        else if (tag === "buff") add("debuff", uuid);
      }
    }
  }
  if (!beats.length) return { beats: [], skipped: "nothing-visible" };
  return { beats: beats.slice(0, MAX_BEATS), skipped: null };
}

// Repeat fires of one passive inside one action collapse into one beat set
// (Lightning Charge firing once per creature a Bolt spell hits).
export function mergeBeats(a, b) {
  const out = (a ?? []).map((x) => ({ ...x, recipients: [...x.recipients] }));
  for (const nb of b ?? []) {
    const ex = out.find((x) => x.k === nb.k && (x.element ?? null) === (nb.element ?? null));
    if (!ex) { out.push({ ...nb, recipients: [...nb.recipients] }); continue; }
    for (const r of nb.recipients) if (!ex.recipients.includes(r)) ex.recipients.push(r);
  }
  return out.slice(0, MAX_BEATS);
}
