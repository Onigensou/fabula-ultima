// scripts/fabula-arcana/fa-drops.js
// Monster card drops at battle end (GM side). Rules: fa-drops-core.js.
// Called by the battle-end orchestrator on a victory, after the grade and before the Victory screen;
// the screen lists them on its Drops page (page 2 of each character panel: icon · name · ×N).
//
// Which card an enemy drops: actor flag faCardDrop (a card id, or false for none), else its art file
// matches the card's bestiary art, else its name matches. Pity counts live on each character: flags.<mod>.faPity.

import { MODULE_ID, TAG, Catalog, artUrl, artFiles, EL_COLOR, gp } from "./fa-const.js";
import { ownedCards, grantCard } from "./fa-collection.js";
import { decideDrops, matchCard } from "./fa-drops-core.js";

export const FLAG_DROP = "faCardDrop";
export const FLAG_PITY = "faPity";

/** The card an enemy actor drops (or null). `token` is optional (its texture is checked too). */
export function cardForEnemy(actor, token = null) {
  const C = Catalog()?.CARDS; if (!C || !actor) return null;
  const images = [actor.img, gp(actor, "prototypeToken.texture.src", null), token?.texture?.src ?? token?.document?.texture?.src ?? null].filter(Boolean);
  return matchCard({ flag: gp(actor, `flags.${MODULE_ID}.${FLAG_DROP}`, undefined), images, name: actor.name }, C, artFiles());
}

/**
 * Roll and grant this battle's drops.
 * @param {{actor:Actor, token?:any, rank?:string}[]} enemies   the fallen enemies (rank = npc_rank)
 * @param {Actor[]} recipients                                   the party's own characters
 * @returns {Promise<{actorId, cid, name, img, el, pity}[]>}     what the Victory screen shows
 */
export async function rollCardDrops(enemies, recipients, { rng = Math.random } = {}) {
  const C = Catalog()?.CARDS; if (!C) return [];
  const list = [];
  for (const e of enemies ?? []) { const cid = cardForEnemy(e.actor, e.token); if (cid) list.push({ cid, rank: e.rank ?? gp(e.actor, "system.props.npc_rank", "soldier") }); }
  if (!list.length || !recipients?.length) return [];
  const recips = recipients.filter(Boolean).map((a) => ({ id: a.id, owned: ownedCards(a), pity: { ...(gp(a, `flags.${MODULE_ID}.${FLAG_PITY}`, {}) || {}) } }));
  const { drops, pity } = decideDrops(list, recips, rng);
  // pity: write zeros for cleared entries (a flag merge never deletes keys)
  for (const r of recips) {
    const a = game.actors.get(r.id); if (!a) continue;
    const next = {}; for (const k of Object.keys(r.pity)) next[k] = 0; Object.assign(next, pity[r.id] ?? {});
    const changed = Object.keys(next).some((k) => (Number(r.pity[k]) || 0) !== next[k]);
    if (changed) { try { await a.update({ [`flags.${MODULE_ID}.${FLAG_PITY}`]: next }); } catch (err) { console.warn(TAG, "pity write failed", a.name, err); } }
  }
  const out = [];
  for (const d of drops) {
    const a = game.actors.get(d.actorId); if (!a) continue;
    try {
      const g = await grantCard(a, d.cid);
      if (!g.ok) continue;
      const c = C[d.cid];
      out.push({ actorId: a.id, cid: d.cid, name: c.name, img: artUrl(d.cid), el: EL_COLOR[c.el] ?? EL_COLOR.phys, cost: c.cost, pity: !!d.pity });
      console.log(TAG, `card drop: ${a.name} got ${c.name}${d.pity ? " (pity)" : ""}`);
    } catch (err) { console.warn(TAG, "card grant failed", a.name, d.cid, err); }
  }
  return out;
}
