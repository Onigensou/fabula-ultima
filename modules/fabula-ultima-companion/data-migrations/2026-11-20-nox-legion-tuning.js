/**
 * Migration: 2026-11-20-nox-legion-tuning  (Sealed Cavern / Nox Legion, playtest pass 1)
 * ---------------------------------------------------------------------------
 * Follows 2026-11-20-nox-legion-author. Every change below was approved by the
 * user after the 113-sim playtest (2026-11-20):
 *   1. HP for a 3-4 round pace (secret end-game area): soldiers x1.6, elites x1.5;
 *      pass 2 (after the re-run): soldiers another x1.25 and +20% on Nox attack damage.
 *   2. Battler scale batch from the "Sealed Cavern Battler Scale" mockup
 *      (prototype token texture scale; Nox keep their negative scaleX). Roo and
 *      Carlbero are guests that also appear on other maps; the user approved them.
 *   3. Beheading's line 15% -> 25%.
 *   4. Zombie counts down on the VICTIM's turns (lifetimeMode target_turn_end, like
 *      Poisoned): before, it counted on the caster's turns and was reaped when the
 *      caster (Nox Priest, Nox Hound) left the battle.
 *   5. Coil and Zombie Bite never target summons or guests (players-only rule).
 *   6. Revive only reaches a Zombie'd or Undead creature.
 *   7. Devour Soul / Soul Sever AI rows wait for a fragment that has Called (the
 *      Soul Tithe now marks it with a visible "Called" status).
 *   8. Nidhogg (both actors) is immune to revive kills (`reviveKillImmune`).
 *
 * Idempotent: every step writes only what differs from the target value.
 */

export const key = "2026-11-20-nox-legion-tuning";
export const description = "Nox Legion tuning: HP, battler scale, Beheading 25%, Zombie on victim turns, players-only Coil/Zombie Bite, Revive targets, Called-aware eaters, Nidhogg revive-kill immunity.";

const M = "fabula-ultima-companion";
const FLAG = "noxLegion";

// pass 2 (re-run still 2.5 rounds): soldiers another x1.25; elites already on pace (3.3 rounds)
const HP = { ghoul: 300, hound: 240, wraith: 260, viper: 275, priest: 450, executioner: 480 };
// pass 2: +20% on the average hit (HR + ~7-8 dice average), absolute values so a re-run is a no-op.
// Not raised: Lux Finis (user: Finis cycle), Gravis and Soul Sever (HP-based).
const HR = {
  ghoul: { "Grave Claw": "47", "Poison Blade": "55" },
  hound: { "Rending Fangs": "17", "Zombie Bite": "31" },
  priest: { "Nox Tome": "25" },
  wraith: { "Soul Ripper": "53" },
  viper: { "Poison Fang": "44", "Coil": "29", "Bile Spew": "35" },
  executioner: { "Nox Guillotine": "46", "Nox Gibbet": "46" },
};
// token texture scale (magnitude); sign of scaleX is kept as it is in the world
const SCALE_NOX = { ghoul: 1.42, hound: 1.45, wraith: 1.47, viper: 1.74, priest: 2.26, executioner: 2.60 };
const SCALE_GUEST = { "Roo": 1.50, "Carlbero": 2.57 };

const PLAYERS_ONLY = "IS_SUMMON == 0 && IS_GUEST == 0";
const REVIVE_TARGET = "HAS_STATUS_ZOMBIE == 1 || SPECIES_IS_UNDEAD == 1";

const byFlag = (k) => game.actors.find((a) => a.getFlag?.(M, FLAG) === k || a.flags?.[M]?.[FLAG] === k) ?? null;
const itemNamed = (actor, name) => actor?.items?.find?.((i) => i.name === name) ?? null;

// Replace inside every string of a nested value (CSB tables are plain objects).
function mapStrings(v, fn) {
  if (typeof v === "string") return fn(v);
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, fn));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapStrings(x, fn)]));
  return v;
}

async function setScale(actor, mag, out) {
  const t = actor.prototypeToken?.texture ?? {};
  const sx = Number(t.scaleX ?? 1), sy = Number(t.scaleY ?? 1);
  const nx = (sx < 0 ? -1 : 1) * mag;
  if (Math.abs(sx - nx) < 1e-6 && Math.abs(sy - mag) < 1e-6) return;
  await actor.update({ "prototypeToken.texture.scaleX": nx, "prototypeToken.texture.scaleY": mag });
  out.push(`${actor.name}: token scale ${Math.abs(sx).toFixed(2)} -> ${mag.toFixed(2)}`);
}

async function setItemProps(actor, name, props, out) {
  const it = itemNamed(actor, name);
  if (!it) { out.push(`${actor.name}: no "${name}" skill, skipped`); return; }
  const upd = {};
  for (const [k, v] of Object.entries(props)) if (it.system?.props?.[k] !== v) upd[`system.props.${k}`] = v;
  if (!Object.keys(upd).length) return;
  await it.update(upd);
  out.push(`${actor.name} / ${name}: ${Object.keys(upd).map((k) => k.replace("system.props.", "")).join(", ")}`);
}

async function setAiString(actor, rowName, value, out) {
  const t = actor.system?.props?.action_pattern_table ?? {};
  const upd = {};
  for (const [k, row] of Object.entries(t)) {
    if (row?.$deleted || row?.action_pattern_name !== rowName) continue;
    if (row.action_pattern_string !== value) upd[`system.props.action_pattern_table.${k}.action_pattern_string`] = value;
  }
  if (!Object.keys(upd).length) return;
  await actor.update(upd);
  out.push(`${actor.name}: AI row "${rowName}" now waits for "${value}"`);
}

async function beheading25(actor, out) {
  const it = itemNamed(actor, "Beheading");
  if (!it) { out.push("Executioner: no Beheading skill, skipped"); return; }
  const fix = (s) => s.replace(/\* 0\.15\)/g, "* 0.25)").replace(/<strong>15%<\/strong>/g, "<strong>25%</strong>").replace(/\b15% of its maximum/g, "25% of its maximum");
  const upd = {};
  for (const k of ["description", "reaction_config_table", "effect_table", "targeting_table", "targeting_config_table"]) {
    const cur = it.system?.props?.[k];
    if (cur == null) continue;
    const next = mapStrings(cur, fix);
    if (JSON.stringify(next) !== JSON.stringify(cur)) upd[`system.props.${k}`] = next;
  }
  // any other prop holding the line (targeting rows can live under another table key)
  for (const [k, cur] of Object.entries(it.system?.props ?? {})) {
    if (upd[`system.props.${k}`] || typeof cur !== "object" || cur == null) continue;
    const next = mapStrings(cur, fix);
    if (JSON.stringify(next) !== JSON.stringify(cur)) upd[`system.props.${k}`] = next;
  }
  if (Object.keys(upd).length) { await it.update(upd); out.push(`Beheading: line 15% -> 25% (${Object.keys(upd).length} field(s))`); }
  const mark = it.effects?.find?.((e) => e.name === "Beheading");
  if (mark && /15%/.test(mark.description ?? "")) { await mark.update({ description: mark.description.replace(/15%/g, "25%") }); out.push("Beheading mark: description 25%"); }
}

async function zombieOnVictimTurns(out, log) {
  const { authorCommonAe } = await import("./_common-ae-author.js");
  const r = await authorCommonAe(game, { name: "Zombie", container: "Debuff", patch: { [`flags.${M}.lifetimeMode`]: "target_turn_end" } }, log);
  out.push(`Zombie: counts on the victim's turns (masters ${r.masters}, copies ${r.actorCopies + r.itemCopies + r.tokenCopies}, already ${r.skipped})`);
}

async function nidhoggImmune(out) {
  for (const a of game.actors.filter((x) => /nidhogg/i.test(x.name) && x.type !== "_template")) {
    if (a.flags?.[M]?.reviveKillImmune === true) continue;
    await a.update({ [`flags.${M}.reviveKillImmune`]: true });
    out.push(`${a.name}: immune to revive kills`);
  }
}

export async function migrate(game, log) {
  const out = [];
  for (const [k, hp] of Object.entries(HP)) {
    const a = byFlag(k);
    if (!a) { out.push(`${k}: Nox actor missing, skipped`); continue; }
    const p = a.system?.props ?? {};
    if (Number(p.max_hp) !== hp) { await a.update({ "system.props.max_hp": String(hp), "system.props.current_hp": String(hp) }); out.push(`${a.name}: HP ${p.max_hp} -> ${hp}`); }
    await setScale(a, SCALE_NOX[k], out);
    for (const [skill, hr] of Object.entries(HR[k] ?? {})) await setItemProps(a, skill, { damage_bonus: hr }, out);
  }
  for (const [name, mag] of Object.entries(SCALE_GUEST)) {
    const a = game.actors.find((x) => x.name === name && x.type !== "_template");
    if (a) await setScale(a, mag, out); else out.push(`${name}: not found, scale skipped`);
  }
  const ex = byFlag("executioner"); if (ex) await beheading25(ex, out);
  const hound = byFlag("hound"); if (hound) await setItemProps(hound, "Zombie Bite", { target_eligibility: PLAYERS_ONLY }, out);
  const viper = byFlag("viper"); if (viper) await setItemProps(viper, "Coil", { target_eligibility: PLAYERS_ONLY }, out);
  const priest = byFlag("priest"); if (priest) await setItemProps(priest, "Revive", { target_eligibility: REVIVE_TARGET }, out);
  const wraith = byFlag("wraith"); if (wraith) await setAiString(wraith, "Devour Soul", "Called", out);
  if (ex) await setAiString(ex, "Soul Sever", "Called", out);
  await zombieOnVictimTurns(out, log);
  await nidhoggImmune(out);
  log?.(out.join(" | "));
  return { applied: true, summary: out.join("; ") || "nothing to change" };
}
