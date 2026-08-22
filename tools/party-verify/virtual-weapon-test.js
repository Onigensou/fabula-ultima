// Virtual-weapon test suite (bridge script; run via bridge-eval).
//
// A VIRTUAL ATTACK is a weapon-shaped attack source exposed declaratively by an
// AE flag (`flags["fabula-ultima-companion"].exposedVirtualAttack`) rather than
// by an equipped item — Dual Shieldbearer's "Twin Shields", Brawling, etc.
//
// WHY THIS EXISTS. The director harness had ZERO awareness of them
// (`grep -c virtual` = 0): buildAttackerSnapshot only resolved main/off hand, so
// any virtual-weapon build reported `no_main_weapon`. That was recorded as
// "Blanche has no weapon, that is her build" — WRONG. She has Twin Shields, the
// live flow offers it as `virtual:0`, and Skill COMPUTE reaches it through
// resolvePrimaryAttackWeapon. A whole character's kit was mis-scored on it.
//
// Every assertion below carries a control that must FLIP. An exposure test that
// only ever checks the happy path cannot tell "the gate works" from "the gate is
// ignored" — which is the exact failure that produced the wrong verdict.
const FLAG = "fabula-ultima-companion";
const snap = await import("/modules/fabula-ultima-companion/scripts/battle-director/snapshot.js");
const T = FUCompanion.api.test;

const results = [];
const check = (name, pass, detail) => { results.push({ name, pass: !!pass, detail }); return pass; };
const withOverride = async (map, fn) => {
  const prev = globalThis.__FU_HARNESS_FORMULA_OVERRIDES__;
  globalThis.__FU_HARNESS_FORMULA_OVERRIDES__ = { ...(prev ?? {}), ...map };
  try { return await fn(); }
  finally {
    if (prev) globalThis.__FU_HARNESS_FORMULA_OVERRIDES__ = prev;
    else delete globalThis.__FU_HARNESS_FORMULA_OVERRIDES__;
  }
};

const who = ARGS.who ?? "Blanche";
const actor = game.actors.getName(who);
const tok = canvas.tokens.placeables.find((t) => t.actor?.name === who);
const enemyTok = canvas.tokens.placeables.find((t) => t.actor?.name === (ARGS.enemy ?? "Test Target Enemy"));
if (!actor || !tok || !enemyTok) return { err: "actor/token/enemy missing", who };

// ── 1. EXPOSURE ───────────────────────────────────────────────────────────
const virt = snap.resolveVirtualAttacks(actor) ?? [];
check("exposure: at least one virtual attack", virt.length > 0,
      virt.map((v) => v.name).join(", ") || "(none)");
const tw = virt[0] ?? null;
check("exposure: profile is weapon-shaped (name/A1/A2/damageBonus)",
      !!(tw?.name && tw?.A1 && tw?.A2 && tw?.damageBonus != null),
      tw ? `${tw.name} ${tw.A1}+${tw.A2} dmg=${tw.damageBonus} type=${tw.damageType} range=${tw.range}` : "none");

// ── 2. THE EXPOSURE GATE — control must flip ──────────────────────────────
// Twin Shields is gated `EQUIPPED_SHIELD_COUNT >= 2`.
const gateOn  = await withOverride({ EQUIPPED_SHIELD_COUNT: 2 }, () => snap.resolveVirtualAttacks(actor) ?? []);
const gateOff = await withOverride({ EQUIPPED_SHIELD_COUNT: 1 }, () => snap.resolveVirtualAttacks(actor) ?? []);
check("gate: exposed when EQUIPPED_SHIELD_COUNT = 2", gateOn.length > 0, `${gateOn.length} exposed`);
check("gate CONTROL: hidden when EQUIPPED_SHIELD_COUNT = 1", gateOff.length === 0,
      `${gateOff.length} exposed (want 0 - if non-zero the gate is NOT being read)`);

// ── 3. DAMAGE FORMULA — control must move the number ──────────────────────
// damageBonus is authored as "5 + SL_DEFENSIVE_MASTERY".
const dmg0 = await withOverride({ SL_DEFENSIVE_MASTERY: 0 }, () => (snap.resolveVirtualAttacks(actor) ?? [])[0]?.damageBonus);
const dmg7 = await withOverride({ SL_DEFENSIVE_MASTERY: 7 }, () => (snap.resolveVirtualAttacks(actor) ?? [])[0]?.damageBonus);
check("damage: SL_DEFENSIVE_MASTERY = 0 -> 5", Number(dmg0) === 5, `got ${dmg0}`);
check("damage CONTROL: SL_DEFENSIVE_MASTERY = 7 -> 12", Number(dmg7) === 12, `got ${dmg7}`);

// ── 4. PRIMARY-WEAPON FALLBACK (what Skill COMPUTE uses) ──────────────────
const prim = snap.resolvePrimaryAttackWeapon(actor);
check("fallback: resolvePrimaryAttackWeapon returns the virtual attack",
      !!prim && prim.name === tw?.name, prim ? prim.name : "null");

// ── 5. THE ATTACK PATH — the thing that used to say no_main_weapon ────────
let atkDefault = null, atkVirtual = null, atkBadIndex = null;
try {
  atkDefault = await T.runDirectorAttackCompute({
    attackerTokenUuid: tok.document.uuid, targetTokenUuids: [enemyTok.document.uuid],
    force: { hit: true }, depsToken: "vw" });
} catch (e) { atkDefault = { ok: false, reason: "threw:" + e.message }; }
try {
  atkVirtual = await T.runDirectorAttackCompute({
    attackerTokenUuid: tok.document.uuid, targetTokenUuids: [enemyTok.document.uuid],
    mode: "virtual:0", force: { hit: true }, depsToken: "vw" });
} catch (e) { atkVirtual = { ok: false, reason: "threw:" + e.message }; }
try {
  atkBadIndex = await T.runDirectorAttackCompute({
    attackerTokenUuid: tok.document.uuid, targetTokenUuids: [enemyTok.document.uuid],
    mode: "virtual:99", force: { hit: true }, depsToken: "vw" });
} catch (e) { atkBadIndex = { ok: false, reason: "threw:" + e.message }; }

check("attack: default mode no longer reports no_main_weapon",
      atkDefault?.reason !== "no_main_weapon", `reason=${atkDefault?.reason ?? "(ok)"}`);
check("attack: explicit virtual:0 resolves", atkVirtual?.ok === true || atkVirtual?.reason == null,
      `ok=${atkVirtual?.ok} reason=${atkVirtual?.reason}`);
check("attack CONTROL: virtual:99 is rejected, not silently substituted",
      atkBadIndex?.reason === "no_such_virtual_attack",
      `reason=${atkBadIndex?.reason} available=${JSON.stringify(atkBadIndex?.available ?? null)}`);

// ── 6. THE "WEAPON" SENTINEL — how a SKILL reaches the virtual weapon ─────
// A weapon-based skill authors rolled_atr1:"WEAPON" (also type_damage /
// skill_range) and inherits from main -> off -> virtual[0]. The harness used to
// skip this, so the literal string leaked into the roll: Tafallera rolled
// A1="WEAPON" (defaulting to d8) + A2="INS" = 6 vs defense 8 -> hit=false, and
// read as a broken skill. It is not: live it rolls Twin Shields' MIG/MIG.
let sentinel = null;
const sentinelSkill = (ARGS.sentinelSkill ?? "Tafallera");
const skillItem = actor.items.find((i) => i.name === sentinelSkill);
if (skillItem) {
  try {
    const r = await T.runDirectorSkillCompute({ skillUuid: skillItem.uuid,
      casterTokenUuid: tok.document.uuid, targetTokenUuids: [enemyTok.document.uuid],
      force: { hit: true }, depsToken: "vw" });
    const ar = r?.actionResult ?? {};
    sentinel = { rolledA1: ar.rolledA1, rolledA2: ar.rolledA2, damageType: ar.damageType,
                 roll: { A1: ar.roll?.A1, dA: ar.roll?.dA, dB: ar.roll?.dB, total: ar.roll?.total },
                 perTarget: (ar.perTargetResults ?? []).map((t) => `hit=${t.hit} dmg=${t.damage} def=${t.defense}`) };
    check(`sentinel: "${sentinelSkill}" rolledA1 is NOT the literal "WEAPON"`,
          String(ar.rolledA1).toUpperCase() !== "WEAPON", `rolledA1=${ar.rolledA1}`);
    check("sentinel: accuracy pair inherited from the virtual weapon",
          ar.rolledA1 === tw?.A1 && ar.rolledA2 === tw?.A2,
          `got ${ar.rolledA1}/${ar.rolledA2}, weapon is ${tw?.A1}/${tw?.A2}`);
    check("sentinel: blank rolled_atr2 did NOT leave the INS/INS default",
          String(ar.rolledA2).toUpperCase() !== "INS" || tw?.A2 === "INS",
          `rolledA2=${ar.rolledA2}`);
    check("sentinel: the skill can now actually land",
          (ar.perTargetResults ?? []).some((t) => t.hit),
          (sentinel.perTarget ?? []).join(" | "));
  } catch (e) { check("sentinel: compute ran", false, String(e?.message ?? e)); }
}

const perT = (r) => (r?.actionResult?.perTargetResults ?? []).map((t) => `hit=${t.hit} dmg=${t.damage ?? t.finalDamage ?? "-"}`);
return {
  who, virtualAttacks: virt.map((v) => ({ name: v.name, A1: v.A1, A2: v.A2, dmg: v.damageBonus, type: v.damageType })),
  attackDefault: { ok: atkDefault?.ok, reason: atkDefault?.reason, perTarget: perT(atkDefault) },
  attackVirtual: { ok: atkVirtual?.ok, reason: atkVirtual?.reason, perTarget: perT(atkVirtual) },
  sentinel,
  passed: results.filter((r) => r.pass).length, total: results.length,
  results,
};
