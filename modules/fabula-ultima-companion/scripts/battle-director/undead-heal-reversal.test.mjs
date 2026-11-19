// ============================================================================
// Undead / Zombie heal reversal (A1) + Revive on Undead pool (A2) — pure checks.
//
//     node scripts/battle-director/undead-heal-reversal.test.mjs
//
// The decision shared by the card preview (action-profile), the apply path
// (skill-effects grantApply / setResourceApply) and out-of-combat healing
// (healing-socket): who counts as Undead, when a heal flips into damage, the
// `heal_ignore_undead` opt-out, and which revive texts may reach a living Undead.
// ============================================================================

globalThis.Hooks = globalThis.Hooks ?? { on() {}, once() {}, callAll() {} };

const F = await import("./skill-formulas.js");
const S = await import("./snapshot.js");
const C = await import("./action-card.js");

let failed = 0;
function check(label, got, expected) {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label} -> ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
}

const ae = (name, extra = {}) => ({ name, disabled: false, statuses: new Set(), changes: [], ...extra });
const actor = ({ species = null, flags = {}, effects = [] } = {}) =>
  ({ flags, effects, system: { props: { species, current_hp: 30, max_hp: 60 } } });

// ── who is Undead ────────────────────────────────────────────────────────────
check("species UNDEAD",                  F.isHealReversedActor(actor({ species: "UNDEAD" })), true);
check("species Undead (case)",           F.isHealReversedActor(actor({ species: "Undead" })), true);
check("species BEAST",                   F.isHealReversedActor(actor({ species: "BEAST" })), false);
check("PC (no species)",                 F.isHealReversedActor(actor()), false);
check("AE species_override UNDEAD",      F.isHealReversedActor(actor({ species: "BEAST", flags: { "fabula-ultima-companion": { species_override: "UNDEAD" } } })), true);
check("override wins over own species",  F.isHealReversedActor(actor({ species: "UNDEAD", flags: { "fabula-ultima-companion": { species_override: "CONSTRUCT" } } })), false);
check("Zombie status by AE name",        F.isHealReversedActor(actor({ effects: [ae("Zombie")] })), true);
check("Zombie status by status id",      F.isHealReversedActor(actor({ effects: [ae("Something", { statuses: new Set(["zombie"]) })] })), true);
check("disabled Zombie AE ignored",      F.isHealReversedActor(actor({ effects: [ae("Zombie", { disabled: true })] })), false);
check("null actor",                      F.isHealReversedActor(null), false);

// ── when a heal flips ────────────────────────────────────────────────────────
const undead = actor({ species: "UNDEAD" });
const living = actor({ species: "HUMANOID" });
check("hp heal on undead reverses",      F.shouldReverseHeal(undead, { resource: "hp", amount: 20 }), true);
check("hp heal on living heals",         F.shouldReverseHeal(living, { resource: "hp", amount: 20 }), false);
check("mp restore never reverses",       F.shouldReverseHeal(undead, { resource: "mp", amount: 20 }), false);
check("zero amount never reverses",      F.shouldReverseHeal(undead, { resource: "hp", amount: 0 }), false);
check("negative grant (drain) no flip",  F.shouldReverseHeal(undead, { resource: "hp", amount: -10 }), false);
check("heal_ignore_undead true",         F.shouldReverseHeal(undead, { resource: "hp", amount: 20, row: { heal_ignore_undead: true } }), false);
check("heal_ignore_undead \"true\"",     F.shouldReverseHeal(undead, { resource: "hp", amount: 20, row: { heal_ignore_undead: "true" } }), false);
check("heal_ignore_undead false",        F.shouldReverseHeal(undead, { resource: "hp", amount: 20, row: { heal_ignore_undead: false } }), true);

// Heal-receiving math itself is untouched (still clamped ≥ 0 for the living).
const bleed = { appliedEffects: [ae("Bleed", { changes: [{ key: "heal_receiving_mod_all", value: "-0.5" }] })], system: { props: {} } };
check("applyHealReceiving Bleed unchanged", F.applyHealReceiving(bleed, 20), 10);

// ── revive text + pool (A2) ──────────────────────────────────────────────────
check("One KO Ally is a KO-ally revive",       S.targetsKnockedOutAlly("One KO Ally"), true);
check("Up to three KO allies",                 S.targetsKnockedOutAlly("Up to three KO allies"), true);
check("One KO Creature is not",                S.targetsKnockedOutAlly("One KO Creature"), false);
check("One Ally (living) is not",              S.targetsKnockedOutAlly("One Ally"), false);
const ko = [{ tokenUuid: "T.ko", name: "KO ally" }];
const allies = [{ tokenUuid: "T.a1" }, { tokenUuid: "T.z", undeadOrZombie: true }];
const enemies = [{ tokenUuid: "T.ghoul", undeadOrZombie: true }, { tokenUuid: "T.hound" }];
check("merge adds living undead both sides",
  S.mergeUndeadRevivePool(ko, allies, enemies).map((t) => t.tokenUuid), ["T.ko", "T.z", "T.ghoul"]);
check("merge dedupes",
  S.mergeUndeadRevivePool([{ tokenUuid: "T.ghoul", undeadOrZombie: true }], enemies).map((t) => t.tokenUuid), ["T.ghoul"]);
check("merge with no undead = KO pool",       S.mergeUndeadRevivePool(ko, [{ tokenUuid: "x" }]).length, 1);

// ── card label (preview) ─────────────────────────────────────────────────────
const healRow = { hit: true, grantAmount: 25, grantResource: "hp", resourceCur: 60, resourceMax: 60 };
check("normal full-HP heal label",   C.resultLabelFor(healRow), "FULL · NO EFFECT");
check("reversed heal label",         C.resultLabelFor({ ...healRow, healReversed: true }), `UNDEAD · HIT <span class="t-num">25</span>`);
check("reversed heal class",         C.resultClsFor({ ...healRow, healReversed: true }), "hit");

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
