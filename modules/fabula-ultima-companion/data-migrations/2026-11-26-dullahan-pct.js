/**
 * Migration: 2026-11-26-dullahan-pct  (Dullahan Armor scales with the HP-% gap)
 * ---------------------------------------------------------------------------
 * User-approved 2026-11-26 after the balance-metric sweep (Mindscape check-item, Sealed
 * Cavern + house roster): the shipped flat ±5 read ~2× Rare in the drop zone; the approved
 * ladder brings the whole item close to the Rare budget.
 *
 *   gap = your HP % − the other creature's HP %   (only while > 0, as before)
 *   bonus = min(10, 5 + floor(gap / 10))  →  5 % at any gap, +1 % per 10 points, max 10 %
 *   Deal bonus % more damage to them; take bonus % less damage from them.
 *
 * Both rows use the new adjust_damage op "percent", so the bonus JOINS the % families
 * (2026-11-26 % rules): outgoing adds to the wearer's Damage %, incoming adds to the
 * wearer's damage-reduction % before the quiet curve.
 *
 * Updates every copy: the world item + its passive, actor/token-held copies (by name), the
 * Nox Executioner's loot shell and its steal-catalog text. Idempotent (rewrites to the same
 * values). Runs after 2026-11-26-nox-steals (manifest order), which creates the item.
 */

export const key = "2026-11-26-dullahan-pct";
export const description = "Dullahan Armor: ±5–10 % by HP-% gap (joins the Damage % / damage-reduction % families).";

const M = "fabula-ultima-companion";
const ARMOR_ID = "NoxStDullahArm01";
const PSV_ID = "NoxStDullahPsv01";
const EXEC_ID = "lCrB0iEWzPkNrzry";
const SHELL_ID = "NoxStLootExEqp01";

const ul = (...li) => `<ul>${li.map((t) => `<li><p>${t}</p></li>`).join("")}</ul>`;
const B = (s) => `<strong>${s}</strong>`;
const TEXT = ul(
  `Deal ${B("5%")} more damage to creatures with a lower HP percentage than yours. ${B("+1%")} for every 10% HP difference, up to ${B("10%")}.`,
  `Take ${B("5%")} less damage from creatures with a lower HP percentage than yours. ${B("+1%")} for every 10% HP difference, up to ${B("10%")}.`,
);

const GAP_OUT = "(CUR_HP * 100 / MAX_HP - TARGET_CURRENT_HP * 100 / TARGET_MAX_HP)";
const GAP_IN = "(CUR_HP * 100 / MAX_HP - ATTACKER_CURRENT_HP * 100 / ATTACKER_MAX_HP)";
const EFFECT_ROWS = {
  "0": { effect_kind: "adjust_damage", effect_label: "dl_press", damage_stage: "outgoing", damage_operation: "percent", damage_amount: `min(10, 5 + floor(${GAP_OUT} / 10))` },
  "1": { effect_kind: "adjust_damage", effect_label: "dl_guard", damage_stage: "incoming", damage_operation: "percent", damage_amount: `-min(10, 5 + floor(${GAP_IN} / 10))` },
};

function passivePatch(item) {
  const cur = item.system?.props?.effect_table ?? {};
  const patch = { "system.props.description": TEXT, "system.props.skill_description": TEXT };
  for (const k of Object.keys(cur)) if (!(k in EFFECT_ROWS)) patch[`system.props.effect_table.-=${k}`] = null;
  for (const [k, row] of Object.entries(EFFECT_ROWS)) patch[`system.props.effect_table.${k}`] = { ...(cur[k] ?? {}), ...row, $deleted: false };
  return patch;
}

async function syncCollection(items, label, out, parent = null) {
  const updates = [];
  for (const it of items ?? []) {
    if (it.name === "Dullahan Armor") updates.push({ _id: it.id, "system.props.description": TEXT });
    else if (it.name === "Dullahan Armor (Passive)") updates.push({ _id: it.id, ...passivePatch(it) });
  }
  if (!updates.length) return 0;
  if (parent) await parent.updateEmbeddedDocuments("Item", updates);
  else await Item.updateDocuments(updates);
  out.push(`~ ${label}: ${updates.length}`);
  return updates.length;
}

export async function migrate(game, log = () => {}) {
  const out = [];
  if (!game.items.get(ARMOR_ID) || !game.items.get(PSV_ID)) {
    out.push("! Dullahan Armor not in the world yet (2026-11-26-nox-steals must run first) — nothing to do");
    for (const l of out) log(l);
    return { applied: true, summary: out.join(" | ") };
  }
  await syncCollection(game.items.filter((i) => i.name === "Dullahan Armor" || i.name === "Dullahan Armor (Passive)"), "world items", out);
  for (const a of game.actors ?? []) await syncCollection(a.items, a.name, out, a);
  for (const scene of game.scenes ?? []) {
    for (const t of scene.tokens ?? []) {
      if (t.actorLink || !t.actor) continue;
      await syncCollection(t.actor.items, `${scene.name} / ${t.name}`, out, t.actor);
    }
  }
  // The steal catalog shows the loot's text; keep it in step with the item.
  const exec = game.actors.get(EXEC_ID);
  if (exec?.system?.props?.stealable_loot?.[SHELL_ID]) {
    await exec.update({ [`system.props.stealable_loot.${SHELL_ID}.loot_description`]: TEXT });
    out.push("~ Nox Executioner: steal catalog text");
  }
  for (const l of out) log(l);
  return { applied: true, summary: out.join(" | ") || "nothing to change" };
}
