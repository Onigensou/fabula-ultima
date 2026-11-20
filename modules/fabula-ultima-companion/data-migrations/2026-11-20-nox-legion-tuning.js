/**
 * Migration: 2026-11-20-nox-legion-tuning  (Sealed Cavern / Nox Legion, playtest pass 1)
 * ---------------------------------------------------------------------------
 * Follows 2026-11-20-nox-legion-author. Every change below was approved by the
 * user after the 113-sim playtest (2026-11-20):
 *   1. HP for a 3-4 round pace (secret end-game area): soldiers x1.6, elites x1.5;
 *      pass 2 (after the re-run): soldiers another x1.25 and +20% on Nox attack damage;
 *      pass 3: another +25% on Nox attack damage (not Lux Finis / Soul Sever), Gravis -> Gravis Alta (50%);
 *      pass 4: Hound VU Fire / Viper VU Ice instead of Light, HP 190 / 230; weapon efficiency
 *      for Viper (sword 150, brawling 75), Wraith (arcane 150, bow 75), Executioner (flail 150, dagger 75).
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
export const description = "Nox Legion tuning: HP, battler scale, Beheading 25%, Zombie on victim turns, players-only Coil/Zombie Bite, Revive (now Resurrection) targets, Called-aware eaters, Nidhogg revive-kill immunity.";

const M = "fabula-ultima-companion";
const FLAG = "noxLegion";

// pass 2 (re-run still 2.5 rounds): soldiers another x1.25; elites already on pace (3.3 rounds)
// pass 4: Hound / Viper lose the Light weakness (47% of party damage went into it), HP down to compensate.
const HP = { ghoul: 300, hound: 190, wraith: 260, viper: 230, priest: 450, executioner: 480 };
// affinity_1..9 = physical air bolt dark earth fire ice light poison
const AFFINITY = {
  hound: { affinity_6: "VU", affinity_8: "NA" },  // Fire weakness (beasts fear fire)
  viper: { affinity_7: "VU", affinity_8: "NA" },  // Ice weakness (cold-blooded)
};
// pass 4 (user): weapon efficiency for the three Nox that had none, read off the sprites.
const WEAPON_EF = {
  viper: { sword_ef: "150", brawling_ef: "75" },      // a blade cuts the thin hood; fists sink into coils
  wraith: { arcane_ef: "150", bow_ef: "75" },         // magic bites a spirit; arrows pass through rags
  executioner: { flail_ef: "150", dagger_ef: "75" },  // a flail wraps the shield; small blades slide off plate
};
const STUDY_HINT = {
  hound: ["It shies from <strong>light</strong>.", "It shies from <strong>fire</strong>."],
  viper: ["It recoils from <strong>light</strong>.", "The <strong>cold</strong> makes it sluggish."],
};
// pass 2: +20% on the average hit (HR + ~7.5 dice average); pass 3: another +25% (user: lower party HP,
// same round count). Absolute values so a re-run is a no-op.
// Not raised: Lux Finis (user), Soul Sever (fragment HP by design). Gravis -> Gravis Alta (50%) below.
const HR = {
  ghoul: { "Grave Claw": "61", "Poison Blade": "71" },
  hound: { "Rending Fangs": "23", "Zombie Bite": "41" },
  priest: { "Nox Tome": "33" },
  wraith: { "Soul Ripper": "68" },
  viper: { "Poison Fang": "57", "Coil": "38", "Bile Spew": "46" },
  executioner: { "Nox Guillotine": "59", "Nox Gibbet": "59" },
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

// pass 3 (user): Gravis -> Gravis Alta, half of current HP instead of a quarter (still never KOs: floor).
async function gravisAlta(priest, out) {
  const it = itemNamed(priest, "Gravis") ?? itemNamed(priest, "Gravis Alta");
  if (!it) { out.push("Priest: no Gravis skill, skipped"); return; }
  const upd = {};
  if (it.name !== "Gravis Alta") { upd.name = "Gravis Alta"; upd["system.props.name"] = "Gravis Alta"; }
  const fx = it.system?.props?.effect_table;
  if (fx) { const next = mapStrings(fx, (s) => s.replace("floor(CUR_HP * 0.25)", "floor(CUR_HP * 0.5)")); if (JSON.stringify(next) !== JSON.stringify(fx)) upd["system.props.effect_table"] = next; }
  const d = it.system?.props?.description ?? "";
  if (/a quarter of its current/.test(d)) upd["system.props.description"] = d.replace("a quarter of its current", "half of its current");
  if (Object.keys(upd).length) { await it.update(upd); out.push(`Priest: Gravis -> Gravis Alta, 50% of current HP (${Object.keys(upd).length} field(s))`); }
  const t = priest.system?.props?.action_pattern_table ?? {};
  const rowUpd = {};
  for (const [k, row] of Object.entries(t)) {
    if (row?.$deleted || !/^Gravis( Alta)?$/.test(row?.action_pattern_name ?? "")) continue;
    if (row.action_pattern_name !== "Gravis Alta") rowUpd[`system.props.action_pattern_table.${k}.action_pattern_name`] = "Gravis Alta";
    // No cooldown (user 2026-11-20): Gravis Alta is now answerable by defender
    // reactions (Prophetic Defender etc.), so the counterplay is the players'.
    if (String(row.action_pattern_cooldown ?? "0") !== "0") rowUpd[`system.props.action_pattern_table.${k}.action_pattern_cooldown`] = "0";
  }
  if (Object.keys(rowUpd).length) { await priest.update(rowUpd); out.push("Priest: AI row Gravis Alta (name / no cooldown)"); }
}

// user 2026-11-20: the Priest's Revive is renamed Resurrection (item, sheet name, AI row, spell list entry).
async function resurrection(priest, out) {
  const it = itemNamed(priest, "Revive");
  if (it) { await it.update({ name: "Resurrection", "system.props.name": "Resurrection" }); out.push("Priest: Revive -> Resurrection"); }
  const upd = {};
  for (const [k, row] of Object.entries(priest.system?.props?.action_pattern_table ?? {}))
    if (!row?.$deleted && row?.action_pattern_name === "Revive") upd[`system.props.action_pattern_table.${k}.action_pattern_name`] = "Resurrection";
  for (const [k, row] of Object.entries(priest.system?.props?.normal_spell_list ?? {}))
    if (row?.name === "Revive") upd[`system.props.normal_spell_list.${k}.name`] = "Resurrection";
  if (Object.keys(upd).length) { await priest.update(upd); out.push(`Priest: Resurrection AI row / spell list (${Object.keys(upd).length} field(s))`); }
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
    if (WEAPON_EF[k]) {
      const upd = {};
      for (const [key, v] of Object.entries(WEAPON_EF[k])) if (String(p[key]) !== v) upd[`system.props.${key}`] = v;
      if (Object.keys(upd).length) { await a.update(upd); out.push(`${a.name}: weapon efficiency ${Object.entries(WEAPON_EF[k]).map(([s, v]) => s.replace("_ef", "") + " " + v).join(", ")}`); }
    }
    if (AFFINITY[k]) {
      const upd = {};
      for (const [slot, v] of Object.entries(AFFINITY[k])) if (p[slot] !== v) upd[`system.props.${slot}`] = v;
      const [from, to] = STUDY_HINT[k] ?? [];
      if (from && String(p.study_text ?? "").includes(from)) upd["system.props.study_text"] = p.study_text.replace(from, to);
      if (Object.keys(upd).length) { await a.update(upd); out.push(`${a.name}: affinity ${Object.entries(AFFINITY[k]).map(([s, v]) => s + "=" + v).join(" ")}`); }
    }
    for (const [skill, hr] of Object.entries(HR[k] ?? {})) await setItemProps(a, skill, { damage_bonus: hr }, out);
  }
  for (const [name, mag] of Object.entries(SCALE_GUEST)) {
    const a = game.actors.find((x) => x.name === name && x.type !== "_template");
    if (a) await setScale(a, mag, out); else out.push(`${name}: not found, scale skipped`);
  }
  const ex = byFlag("executioner"); if (ex) await beheading25(ex, out);
  const hound = byFlag("hound"); if (hound) await setItemProps(hound, "Zombie Bite", { target_eligibility: PLAYERS_ONLY }, out);
  const viper = byFlag("viper"); if (viper) await setItemProps(viper, "Coil", { target_eligibility: PLAYERS_ONLY }, out);
  const priest = byFlag("priest");
  if (priest) await resurrection(priest, out);
  if (priest) await setItemProps(priest, "Resurrection", { target_eligibility: REVIVE_TARGET }, out);
  if (priest) await gravisAlta(priest, out);
  const wraith = byFlag("wraith"); if (wraith) await setAiString(wraith, "Devour Soul", "Called", out);
  if (ex) await setAiString(ex, "Soul Sever", "Called", out);
  await zombieOnVictimTurns(out, log);
  await nidhoggImmune(out);
  log?.(out.join(" | "));
  return { applied: true, summary: out.join("; ") || "nothing to change" };
}
