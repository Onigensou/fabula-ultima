// ============================================================================
// Heals that hurt — the card / picker warning decisions (approved 2026-11-28).
//
//     node scripts/battle-director/heal-warning.test.mjs
//
// Bare Node, no Foundry. Covers:
//   * WHY a heal reverses (healReversalReason): Zombie status → "zombie", False Idol's
//     field → "effect", species Undead → "undead"; the Crysta species-only exemption
//     (healReversalExempt) and that a Zombie STATUS on her still reverses;
//   * the card row: "DAMAGE 40" red + Zombie / Undead pill + red wash + summary line;
//     an Undead the party hasn't Studied previews as a NORMAL heal (masked amount);
//     Bleed rows keep the halved "HEALED 20 HP" with no label; Wither MP rows the
//     halved "RESTORED 10 MP";
//   * the picker chip (heal-warning.js) for Zombie / studied Undead, none for an
//     unknown Undead, Bleed or attacks.
// ============================================================================

globalThis.Hooks = globalThis.Hooks ?? { on() {}, once() {}, callAll() {} };

const F = await import("./skill-formulas.js");
const C = await import("./action-card.js");
const W = await import("./heal-warning.js");

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else { fail++; console.error(`FAIL  ${label}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`); }
}

const NS = "fabula-ultima-companion";
const ae = (name, extra = {}) => ({ name, disabled: false, statuses: new Set(), changes: [], ...extra });
// The REAL Zombie / Bleed / Wither AEs (worlds/.../_authored-export Debuff container).
const ZOMBIE = () => ae("Zombie", { statuses: new Set(["bspDC7hFRTYuwdhf"]), changes: [
  { key: `flags.${NS}.species_override`, mode: 5, value: "UNDEAD" }, { key: "affinity_8", mode: 0, value: "VU" }] });
const BLEED = () => ae("Bleed", { statuses: new Set(["QOfrFCU2C6mx50gK"]), changes: [{ key: "heal_receiving_mod_all", mode: 2, value: "-0.5" }] });
const WITHER = () => ae("Wither", { statuses: new Set(["VxdXsFJ7YVEzAp3x"]), changes: [{ key: "mp_receiving_mod_all", mode: 2, value: "-0.5" }] });
const FALSE_IDOL = () => ae("False Idol", { changes: [{ key: "heal_reversed_all", mode: 2, value: "1" }] });
// An actor as the engine sees it AFTER AE application: the Zombie AE's species_override lands in flags.
const actor = ({ species = null, flags = {}, effects = [] } = {}) => {
  const f = { ...flags };
  for (const e of effects) for (const c of e.changes) if (c.key === `flags.${NS}.species_override` && !e.disabled) f[NS] = { ...(f[NS] ?? {}), species_override: c.value };
  return { flags: f, effects, appliedEffects: effects, system: { props: { species, current_hp: 30, max_hp: 60, current_mp: 10, max_mp: 50 } } };
};
const EXEMPT = { [NS]: { healReversalExempt: true } };

// ── why it reverses ────────────────────────────────────────────────────────
check("PC healed",                         F.healReversalReason(actor()), null);
check("Zombie status (non-undead)",         F.healReversalReason(actor({ effects: [ZOMBIE()] })), "zombie");
check("natural Undead",                     F.healReversalReason(actor({ species: "UNDEAD" })), "undead");
check("Undead + Zombie → the status",       F.healReversalReason(actor({ species: "UNDEAD", effects: [ZOMBIE()] })), "zombie");
check("Bleed only → heals",                 F.healReversalReason(actor({ effects: [BLEED()] })), null);
check("Bleed + Zombie → zombie",            F.healReversalReason(actor({ effects: [BLEED(), ZOMBIE()] })), "zombie");
check("False Idol field",                   F.healReversalReason(actor({ effects: [FALSE_IDOL()] })), "effect");
check("heal_ignore_undead row on Undead",   F.healReversalReason(actor({ species: "UNDEAD" }), { row: { heal_ignore_undead: true } }), null);
// Crysta: species part exempt, a Zombie status still counts
check("Crysta (Undead, exempt) heals",      F.isHealReversedActor(actor({ species: "UNDEAD", flags: EXEMPT })), false);
check("Crysta reason null",                 F.healReversalReason(actor({ species: "UNDEAD", flags: EXEMPT })), null);
check("Crysta no revive-kill target",       F.isReviveKillTarget(actor({ species: "UNDEAD", flags: EXEMPT })), false);
check("Crysta + Zombie status reverses",    F.isHealReversedActor(actor({ species: "UNDEAD", flags: EXEMPT, effects: [ZOMBIE()] })), true);
check("Crysta + Zombie reason zombie",      F.healReversalReason(actor({ species: "UNDEAD", flags: EXEMPT, effects: [ZOMBIE()] })), "zombie");
check("Crysta + Zombie revive-kill target", F.isReviveKillTarget(actor({ species: "UNDEAD", flags: EXEMPT, effects: [ZOMBIE()] })), true);
check("shouldReverseHeal Crysta",           F.shouldReverseHeal(actor({ species: "UNDEAD", flags: EXEMPT }), { resource: "hp", amount: 40 }), false);
check("exempt flag as string 'true'",       F.isHealReversalExempt(actor({ flags: { [NS]: { healReversalExempt: "true" } } })), true);

// ── card rows ──────────────────────────────────────────────────────────────
const row = (x = {}) => ({ hit: true, grantAmount: 40, grantResource: "hp", resourceCur: 30, resourceMax: 60, ...x });
const zRow = row({ healReversed: true, healReversedReason: "zombie" });
const uRow = row({ healReversed: true, healReversedReason: "undead" });
const uHidden = row({ healReversed: true, healReversedReason: "undead", healWarnHidden: true, healMaskAmount: 40 });
const DMG = `<span class="vb">DAMAGE</span> <span class="t-num">40</span>`;
check("Zombie row label",            C.resultLabelFor(zRow), DMG);
check("Zombie row class",            C.resultClsFor(zRow), "rev");
check("Zombie pill",                 /t-revpill"><img [^>]*>Zombie<\/span>/.test(C.healRevPillHTML(zRow)), true);
check("studied Undead label",        C.resultLabelFor(uRow), DMG);
check("studied Undead pill",         C.healRevPillHTML(uRow), `<span class="t-revpill ud">Undead</span>`);
check("UNKNOWN Undead: normal heal", C.resultLabelFor(uHidden), "HEALED 40 HP");
check("UNKNOWN Undead: heal class",  C.resultClsFor(uHidden), "heal");
check("UNKNOWN Undead: no pill",     C.healRevPillHTML(uHidden), "");
check("UNKNOWN Undead full HP",      C.resultLabelFor({ ...uHidden, resourceCur: 60 }), "FULL · NO EFFECT");
check("UNKNOWN Undead w/ Bleed shows the halved heal", C.resultLabelFor({ ...uHidden, healMaskAmount: 20 }), "HEALED 20 HP");
check("False Idol row: DAMAGE, no pill", [C.resultLabelFor(row({ healReversed: true, healReversedReason: "effect" })), C.healRevPillHTML(row({ healReversed: true, healReversedReason: "effect" }))], [DMG, ""]);
// Bleed / Wither stay exactly as today: the halved number, no label
check("Bleed row (halved by the profile)", [C.resultLabelFor(row({ grantAmount: 20 })), C.resultClsFor(row({ grantAmount: 20 })), C.healRevPillHTML(row({ grantAmount: 20 }))], ["HEALED 20 HP", "heal", ""]);
check("Wither MP row",              [C.resultLabelFor(row({ grantAmount: 10, grantResource: "mp", resourceCur: 10, resourceMax: 50 })), C.resultClsFor(row({ grantAmount: 10, grantResource: "mp" }))], ["RESTORED 10 MP", "restore-mp"]);
// the numbers the profile puts on those rows (same helpers as the apply path)
check("Bleed halves 40 → 20",       F.applyHealReceiving(actor({ effects: [BLEED()] }), 40), 20);
check("Wither halves 20 MP → 10",   F.applyMpReceiving(actor({ effects: [WITHER()] }), 20), 10);
check("Wither leaves HP alone",     F.applyHealReceiving(actor({ effects: [WITHER()] }), 40), 40);
// no summary line (user 2026-11-28: the DAMAGE row is enough)
check("summary line removed",       typeof C.healRevSummaryHTML, "undefined");

// ── picker chip ────────────────────────────────────────────────────────────
const known = () => true, unknown = () => false;
check("chip Zombie",                 W.healHurtsChip(actor({ effects: [ZOMBIE()] }), { known: unknown })?.text, "Heal hurts");
check("chip Zombie carries icon",    W.healHurtsChip(actor({ effects: [ZOMBIE()] }), { known: unknown })?.zombie, true);
check("chip studied Undead",         W.healHurtsChip(actor({ species: "UNDEAD" }), { known })?.text, "Heal hurts · Undead");
check("no chip: unknown Undead",     W.healHurtsChip(actor({ species: "UNDEAD" }), { known: unknown }), null);
check("no chip: Bleed",              W.healHurtsChip(actor({ effects: [BLEED()] }), { known }), null);
check("no chip: Crysta",             W.healHurtsChip(actor({ species: "UNDEAD", flags: EXEMPT }), { known }), null);
check("chip: Crysta + Zombie",       W.healHurtsChip(actor({ species: "UNDEAD", flags: EXEMPT, effects: [ZOMBIE()] }), { known })?.text, "Heal hurts");
check("chip: False Idol",            W.healHurtsChip(actor({ effects: [FALSE_IDOL()] }), { known: unknown })?.text, "Heal hurts");
// the Study gate: friendly picker vs a hostile target needs Identity; allies are known
const enc = { getPageForActor: (u) => (u === "Actor.studied" ? { getFlag: () => ({ bestResult: 9 }) } : u === "Actor.low" ? { getFlag: () => ({ bestResult: 5 }) } : null) };
check("gate: ally is known",         W.speciesKnown({ casterDisposition: 1, targetDisposition: 1, uuids: ["Actor.x"], enc }), true);
check("gate: studied foe",           W.speciesKnown({ casterDisposition: 1, targetDisposition: -1, uuids: ["Actor.studied"], enc }), true);
check("gate: foe studied < 7",       W.speciesKnown({ casterDisposition: 1, targetDisposition: -1, uuids: ["Actor.low"], enc }), false);
check("gate: unstudied foe",         W.speciesKnown({ casterDisposition: 1, targetDisposition: -1, uuids: ["Actor.none"], enc }), false);

console.log(fail ? `heal-warning: ${fail} FAILED, ${pass} passed` : `heal-warning: all ${pass} passed`);
if (fail) process.exit(1);
