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
//   redirect→ a MIRROR pane at the owner, a straight ricochet, then the hit (damage dealt by a
//             damage-reaction follow-up: Obsidrax's Earthen Wire)
//
// Input is the rows that ACTUALLY RAN (the recorder in skill-effects
// applyEffectRow), with their real recipients — so a condition that failed or a
// random pick shows the truth. Tested by passive-anim-rules.test.mjs.
// ============================================================================

export const LINE_STYLE = {
  buff:    { dir: "up",   color: 0xffb347, sfx: "Soundboard/Up1.ogg" },
  debuff:  { dir: "down", color: 0x8f7dff, sfx: "Soundboard/Down2.ogg" },
  // HP / MP gains: BD's own gain VFX already floats the blue / green "+X" and
  // plays its gain sound (playResourceGainVfx) — one sound, so the lines stay quiet.
  heal:    { dir: "up",   color: 0x7dffa0, sfx: null },
  mp:      { dir: "up",   color: 0x6ec8ff, sfx: null },
  cleanse: { dir: "up",   color: 0xffffff, sfx: "Soundboard/Up3.ogg" },
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
  // a beat on the owner that also carries a System Message line
  const say = (k, item) => {
    add(k, ownerActorUuid);
    const b = beats.find((x) => x.k === k && (x.element ?? null) === null);
    b.say = mergeSay(b.say, [item]);
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
    } else if (kind === "weapon_read") {
      // Adaptive Defense (Rakshasa). Efficiency DOWN = resistance UP: the read
      // lane rises, earlier reads recover. Shown on the owner as rising then
      // falling lines, each with its System Message line (weaponReadLines).
      const fam = lc(rec.res.family);
      if (!ownerActorUuid || !fam) continue;
      if (rec.res.raised) say("buff", { t: "raise", fams: [fam] });
      else if (rec.res.maxed) say("note", { t: "maxed", fams: [fam] });
      const lowered = (Array.isArray(rec.res.lowered) ? rec.res.lowered : []).map(lc).filter(Boolean);
      if (lowered.length) say("debuff", { t: "lower", fams: lowered });
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
  return { beats: orderSayBeats(beats).slice(0, MAX_BEATS), skipped: null };
}

// Lines read rise → no-change → fall, whatever order the records came in.
const SAY_ORDER = { buff: 0, note: 1, debuff: 2 };
function orderSayBeats(beats) {
  if (!beats.some((b) => b.say)) return beats;
  return [...beats].sort((x, y) => (x.say ? SAY_ORDER[x.k] ?? 3 : 3) - (y.say ? SAY_ORDER[y.k] ?? 3 : 3));
}

function mergeSay(a, b) {
  const out = (a ?? []).map((s) => ({ ...s, fams: [...s.fams] }));
  for (const s of b ?? []) {
    const ex = out.find((x) => x.t === s.t);
    if (!ex) { out.push({ ...s, fams: [...s.fams] }); continue; }
    for (const f of s.fams) if (!ex.fams.includes(f)) ex.fams.push(f);
  }
  return out;
}

// Repeat fires of one passive inside one action collapse into one beat set
// (Lightning Charge firing once per creature a Bolt spell hits).
export function mergeBeats(a, b) {
  const out = (a ?? []).map((x) => ({ ...x, recipients: [...x.recipients], ...(x.say ? { say: mergeSay(x.say, []) } : {}) }));
  for (const nb of b ?? []) {
    const ex = out.find((x) => x.k === nb.k && (x.element ?? null) === (nb.element ?? null));
    if (!ex) { out.push({ ...nb, recipients: [...nb.recipients], ...(nb.say ? { say: mergeSay(nb.say, []) } : {}) }); continue; }
    for (const r of nb.recipients) if (!ex.recipients.includes(r)) ex.recipients.push(r);
    if (nb.say) ex.say = mergeSay(ex.say, nb.say);
  }
  return orderSayBeats(out).slice(0, MAX_BEATS);
}

// ── System Message lines for weapon_read beats ───────────────────────────
// Plural, as a resistance line reads them. Spells count as Arcane (the
// engine's own rule, resolveWeaponReadFamily).
export const WEAPON_FAMILY_NAME = Object.freeze({
  arcane: "Arcane", bow: "Bows", brawling: "Brawling", dagger: "Daggers", firearm: "Firearms",
  flail: "Flails", heavy: "Heavy weapons", spear: "Spears", sword: "Swords", thrown: "Thrown weapons",
});
const famName = (f) => WEAPON_FAMILY_NAME[f] ?? (f.charAt(0).toUpperCase() + f.slice(1));
function famList(fams) {
  const w = fams.map((f) => `{w:${famName(f)}}`);
  return w.length <= 1 ? (w[0] ?? "") : `${w.slice(0, -1).join(", ")} and ${w[w.length - 1]}`;
}

// beats → [{ text, beat }] in play order; `beat` indexes `beats`.
// User wording, 2026-11-10: "resistance to" + increased / decreased.
export function weaponReadLines(ownerName, beats) {
  const who = String(ownerName || "It");
  const out = [];
  const raised = new Set();
  (beats ?? []).forEach((b) => { if (b.k === "buff") for (const s of b.say ?? []) if (s.t === "raise") s.fams.forEach((f) => raised.add(f)); });
  (beats ?? []).forEach((b, i) => {
    for (const s of b.say ?? []) {
      // a lane both read and recovered inside one merged action only rose
      const fams = s.t === "raise" ? s.fams : s.fams.filter((f) => !raised.has(f));
      if (!fams.length) continue;
      if (s.t === "raise") out.push({ beat: i, text: `${who}'s resistance to ${famList(fams)} {up:increased}!` });
      else if (s.t === "maxed") out.push({ beat: i, text: `${who}'s resistance to ${famList(fams)} won't go any higher!` });
      else if (s.t === "lower") {
        const what = fams.length >= 3 ? "other weapons" : famList(fams);
        out.push({ beat: i, text: `${who}'s resistance to ${what} {down:decreased}!` });
      }
    }
  });
  return out;
}
