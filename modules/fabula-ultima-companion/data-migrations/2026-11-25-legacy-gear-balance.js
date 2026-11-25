/**
 * Migration: 2026-11-25-legacy-gear-balance  (balance pass on Hako's ledger gear)
 * ---------------------------------------------------------------------------
 * Runs after 2026-11-25-legacy-gear-authoring. User decisions 2026-11-25:
 *   Alpha Regalia   your own crits only; Uncommon.
 *   Mana Robe       HALF of each hit (after Shield) goes to MP.
 *   Gambler's Dice  crit rule removed; the fumble reroll keeps its Fabula Point; Common.
 *   Copycat         the copy costs the item's IP.
 *   Brief Respite   Shield = half the MP spent.
 *   Dominatrix      Charm only on a critical hit.
 *   Avalon          the shield's own +1/+1 removed (wearer +1/+1 like everyone); Legendary.
 *   Defense Matrix  5 Shield; stays Uncommon; switched off in Hako's pool.
 *   Ball Gag        Uncommon.
 *   Fairy Tunic     +2 MDEF while you have any buff or debuff (simplified wording).
 *   Kept: False Idol, Little Devil, Biker Suit.
 * Book items (Lid Shield, Ring of Onions, Slimy Jacket, Hekat Shield) get their
 * original book text back (the authoring pass had rewritten it); automation stays.
 *
 * Every carrier is updated: world item, actor copies (refine prefix ignored),
 * unlinked token copies, and their contained passives. Flag gearBalance per document.
 */

export const key = "2026-11-25-legacy-gear-balance";
export const description = "Balance pass on Hako's legacy gear (Alpha Regalia, Mana Robe, Gambler's Dice, Copycat, Brief Respite, Dominatrix, Avalon, Defense Matrix, Ball Gag, Fairy Tunic) + book text restored on 4 book items.";

const M = "fabula-ultima-companion";
const FLAG = "gearBalance";
const HAKO = "srAH3OHOoK0tvFih";

const ul = (...li) => `<ul>${li.map((t) => `<li><p>${t}</p></li>`).join("")}</ul>`;
const je = (jid, label) => `<a class="content-link" data-uuid="JournalEntry.${jid}" data-id="${jid}" data-type="JournalEntry">${label}</a>`;
const B = (s) => `<strong>${s}</strong>`;
const SHIELD = je("wrw2ENSwzCBjztvt", "Shield");

// Original world text of the book items (read from the world 2026-11-25, before the authoring pass).
const BOOK = {
  "UbFTDlw59jKvWab2": "<ul>\n<li>When you deal damage with a <strong>delicacy</strong>, you deal <strong>5</strong> extra damage</li>\n</ul>",
  "rp6c8fADXzWLAt68": "<ul><li>As long as you have this accessory equipped, increase your <strong>maximum Hit Points</strong> and <strong>maximum Mind Points</strong> by 2 for each different <strong>Class</strong> you have.</li></ul>",
  "g0S7SNOw5EJcJd1T": "<ul><li>You are immune to <a class=\"content-link\" data-uuid=\"JournalEntry.JltwIqzHbBKhkD45\" data-id=\"JltwIqzHbBKhkD45\" data-type=\"JournalEntry\">Poisoned</a></li></ul>",
  "96gMkuCexILXHXyI": "<ul>\n<li>You have <strong>Resistance</strong> to damage dealt by spells. When a spell deals damage to<br>you, you recover <strong>5</strong> Mind Points.</li>\n</ul>",
};

const selfTargeting = (label) => ({
  effect_label: label, effect_kind: "targeting", candidate_source: "self", mode: "exact", count: "1",
  exclude_self: false, auto_confirm_when_obvious: true, skip_when_passive: true, iteration_mode: "together",
});
// Patch the rows of a table (object keyed "0","1",…) whose label/ref matches.
const patchRows = (tableObj, byLabel) => {
  const t = foundry.utils.deepClone(tableObj ?? {});
  for (const [k, r] of Object.entries(t)) {
    const fn = byLabel[r?.effect_label] ?? byLabel[`rc:${r?.reaction_effect_ref}`];
    if (fn) t[k] = fn(r);
  }
  return t;
};

// spec: { text?, html?, props?, rarity?, passive?: { effect?, reaction? }, aes?: { [name]: (ae) => update|"delete" } }
const SPECS = {
  "0b9L1O59jxijKJ1I": { name: "Alpha Regalia", rarity: "Uncommon", text: [`Your critical hits deal ${B("200%")} damage.`],
    passive: { effect: { au_who: () => selfTargeting("au_who") } } },
  "jnhWaWPLwZcPQ883": { name: "Mana Robe", text: [`${B("50%")} of damage taken is dealt to your MP instead of your HP.`],
    aes: { "Mana Robe": (ae) => {
      const rc = ae.flags?.[M]?.reactionConfig ?? {};
      const half = "min(floor(INCOMING_DAMAGE / 2), CUR_MP)";
      return {
        [`flags.${M}.reactionConfig.effect_table`]: patchRows(rc.effect_table, {
          mr_soak: (r) => ({ ...r, damage_amount: half }), mr_drain: (r) => ({ ...r, consume_amount: half }) }),
        [`flags.${M}.reactionConfig.reaction_config_table`]: patchRows(rc.reaction_config_table, {
          "rc:mr_root": (r) => ({ ...r, condition_formula: "CUR_MP > 0 && INCOMING_DAMAGE > 1" }) }),
      };
    } } },
  "fXTiW1mHRFBGSGR8": { name: "Gambler's Dice", rarity: "Common",
    text: [`When you Fumble, you may reroll once. Once per round. (You still gain the Fabula Point)`],
    aes: { "Gambler's Dice": () => "delete" },
    passive: { effect: { gd_reroll: (r) => ({ ...r, allow_fumble: true, keep_fumble_fp: true }) } } },
  "Hurc7SbzCtjIAaC3": { name: "Copycat",
    text: [`When another creature uses a consumable, you may use a copy of it by paying its IP cost. Once per round.`],
    passive: { effect: { cc_copy: (r) => ({ ...r, free_of_cost: false, copy_pays_ip: true,
      menu_description: "Use a copy of the item just used, paying its IP cost." }) } } },
  "6f3U2Cz826kB5ZIp": { name: "Brief Respite",
    text: [`After spending MP on a spell or skill, gain ${SHIELD} equal to ${B("50%")} of the MP spent. Once per turn.`, `The Shield lasts until the start of your next turn.`],
    passive: { effect: {
      br_mark: (r) => ({ ...r, ae_initial_charges: "max(0, floor(ACTION_EFFECTIVE_COST_MP / 2) - CUR_SHIELD)" }),
      br_shield: (r) => ({ ...r, grant_amount: "floor(ACTION_EFFECTIVE_COST_MP / 2)" }),
    }, reaction: { "rc:br_root": (r) => ({ ...r, condition_formula: "ACTION_EFFECTIVE_COST_MP > 1 && ACTION_IS_FREE_CAST == 0 && ACTION_IS_ATTACK == 0" }) } } },
  "V3R1cSiLgIfXVgRj": { name: "Dominatrix Leotard",
    text: [`Flail attacks deal ${B("5")} extra damage.`, `Critical hits with flails inflict ${je("x6ByoJnflDAuVn9r", "Charm")}.`],
    passive: { reaction: { "rc:dl_charm": (r) => ({ ...r, condition_formula: "USED_WEAPON_CATEGORY_IS_FLAIL == 1 && DAMAGE_IS_HP == 1 && ATTACK_IS_CRIT == 1" }) } } },
  "vH6Q88n3beOHjxKq": { name: "Avalon", rarity: "Legendary", props: { item_def_bonus: "0", item_mdef_bonus: "0" } },
  "4OH9H2YYxr9KhhBx": { name: "Defense Matrix", text: [`At the start of your turn, gain ${B("5")} ${SHIELD}.`],
    passive: { effect: { dm_shield: (r) => ({ ...r, grant_amount: "5" }) } } },
  "Ef9i1q5WWmWw0ZcI": { name: "Ball Gag", rarity: "Uncommon" },
  "G8fBxPWSabEzD5V6": { name: "Fairy Tunic", text: [`${B("+2 MDEF")} while you have a buff or debuff.`],
    aes: { "Fairy Tunic": (ae) => ({ changes: (ae.changes ?? []).map((c) => c.key === "bonus_magic_defense" ? { ...c, value: "aeBuffDebuffWhen(2)" } : c) }) } },
  // Book text restored (automation unchanged).
  "UbFTDlw59jKvWab2": { name: "Lid Shield", html: BOOK["UbFTDlw59jKvWab2"] },
  "rp6c8fADXzWLAt68": { name: "Ring of Onions", html: BOOK["rp6c8fADXzWLAt68"] },
  "g0S7SNOw5EJcJd1T": { name: "Slimy Jacket", html: BOOK["g0S7SNOw5EJcJd1T"] },
  "96gMkuCexILXHXyI": { name: "Hekat Shield", html: BOOK["96gMkuCexILXHXyI"] },
};

const baseName = (n) => String(n ?? "").replace(/&#39;|&apos;/g, "'").replace(/^\+\d+\s+/, "").trim();

function carriersOf(name) {
  const out = [];
  const w = game.items.find((i) => !i.system?.container && baseName(i.name) === name);
  if (w) out.push(w);
  const actors = [...game.actors];
  for (const sc of game.scenes) for (const t of sc.tokens) if (!t.actorLink && t.actor) actors.push(t.actor);
  for (const a of actors) for (const c of a.items.filter((i) => !i.system?.container && baseName(i.name) === name)) {
    if (a.isToken && !a.token?.delta?.items?.get(c.id)) continue;
    out.push(c);
  }
  return out;
}
const kidsOf = (carrier) => (carrier.parent ? carrier.parent.items : game.items).filter((i) => i.system?.container === carrier.id);

async function applyCarrier(carrier, spec, out) {
  const where = carrier.parent ? `${carrier.parent.name}: ${carrier.name}` : carrier.name;
  if (carrier.getFlag(M, FLAG)) { out.push(`= ${where}`); return; }
  const html = spec.html ?? (spec.text ? ul(...spec.text) : null);
  const patch = { [`flags.${M}.${FLAG}`]: true };
  if (html) patch["system.props.description"] = html;
  if (spec.rarity) patch["system.props.item_rarity"] = spec.rarity;
  for (const [k, v] of Object.entries(spec.props ?? {})) patch[`system.props.${k}`] = v;
  await carrier.update(patch);
  for (const [aeName, fn] of Object.entries(spec.aes ?? {})) {
    for (const ae of carrier.effects.filter((e) => e.name === aeName)) {
      const u = fn(ae.toObject());
      if (u === "delete") await carrier.deleteEmbeddedDocuments("ActiveEffect", [ae.id]);
      else await ae.update(u);
    }
  }
  for (const kid of kidsOf(carrier).filter((k) => String(k.name).endsWith("(Passive)"))) {
    const kp = {};
    if (html) { kp["system.props.description"] = html; kp["system.props.skill_description"] = html; }
    if (spec.passive?.effect || spec.passive?.reaction) {
      const p = kid.system?.props ?? {};
      if (spec.passive.effect) kp["system.props.effect_table"] = patchRows(p.effect_table, spec.passive.effect);
      if (spec.passive.reaction) kp["system.props.reaction_config_table"] = patchRows(p.reaction_config_table, spec.passive.reaction);
    }
    if (Object.keys(kp).length) await kid.update(kp);
  }
  out.push(`~ ${where}`);
}

async function hakoPool(out) {
  const hako = game.actors.get(HAKO);
  const st = hako?.getFlag(M, "shopRoster");
  if (!st?.pool) { out.push("= no Hako roster pool"); return; }
  const id = "4OH9H2YYxr9KhhBx";
  if (st.pool.some((e) => e.id === id && e.off)) { out.push("= Defense Matrix already off"); return; }
  const pool = st.pool.map((e) => (e.id === id ? { ...e, off: true } : e));
  await hako.update({ [`flags.${M}.shopRoster.pool`]: pool });
  out.push("~ Hako pool: Defense Matrix switched off");
}

export async function migrate(game, log = () => {}) {
  const out = [];
  for (const spec of Object.values(SPECS)) {
    const list = carriersOf(spec.name);
    if (!list.length) { out.push(`! ${spec.name} missing`); continue; }
    for (const c of list) await applyCarrier(c, spec, out);
  }
  await hakoPool(out);
  for (const l of out) log(l);
  return { applied: true, summary: out.join(" | ") };
}
