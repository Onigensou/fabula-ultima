// scripts/fabula-arcana/fa-drops-core.js
// Monster card drops: the pure rules (no Foundry calls; node-tested in fa-drops.test.mjs).
//
//   Chance per roll: soldier 25% · elite 40% · champion (boss) 100%.
//   Pity: guaranteed on the Nth eligible fight without a drop (soldier 4th, elite 3rd). Per character, per card.
//   One roll per species per battle, per character. Owned card → no roll and no pity count (one copy each).

export const DROP = {
  chance: { soldier: 0.25, elite: 0.40, champion: 1 },
  pityAt: { soldier: 4, elite: 3, champion: 1 },
};
const RANK_ORDER = ["soldier", "elite", "champion"];
export const normRank = (r) => (RANK_ORDER.includes(String(r ?? "").toLowerCase().trim()) ? String(r).toLowerCase().trim() : "soldier");

/** Fold a battle's enemies into one entry per card, keeping the highest rank seen. */
export function speciesOf(enemies) {
  const out = new Map();
  for (const e of enemies ?? []) {
    if (!e?.cid) continue;
    const r = normRank(e.rank);
    const cur = out.get(e.cid);
    if (!cur || RANK_ORDER.indexOf(r) > RANK_ORDER.indexOf(cur)) out.set(e.cid, r);
  }
  return [...out.entries()].map(([cid, rank]) => ({ cid, rank }));
}

/**
 * Decide this battle's drops.
 * @param {{cid:string, rank:string}[]} enemies  every enemy that maps to a card (duplicates fine)
 * @param {{id:string, owned:string[], pity:Object<string,number>}[]} recipients
 * @param {() => number} rng
 * @returns {{ drops: {actorId:string, cid:string, pity:boolean}[], pity: Object<string, Object<string,number>> }}
 *   pity = the NEW pity map per actor id (write it back as-is).
 */
export function decideDrops(enemies, recipients, rng = Math.random) {
  const species = speciesOf(enemies);
  const drops = [], pity = {};
  for (const r of recipients ?? []) {
    const owned = new Set(r.owned ?? []);
    const p = { ...(r.pity ?? {}) };
    for (const { cid, rank } of species) {
      if (owned.has(cid)) { delete p[cid]; continue; }
      const n = (Number(p[cid]) || 0) + 1;
      const forced = n >= (DROP.pityAt[rank] ?? 4);
      if (forced || rng() < (DROP.chance[rank] ?? 0)) {
        drops.push({ actorId: r.id, cid, pity: forced && (DROP.chance[rank] ?? 0) < 1 });
        owned.add(cid); delete p[cid];
      } else p[cid] = n;
    }
    pity[r.id] = p;
  }
  return { drops, pity };
}

/** Which card an enemy drops: explicit flag, then bestiary art file, then name. Returns a card id or null. */
export function matchCard({ flag, images = [], name = "" }, cards, artFiles) {
  if (flag === false || flag === "none") return null;
  if (typeof flag === "string" && flag && cards[flag]) return flag;
  const base = (p) => { try { return decodeURIComponent(String(p ?? "").split("?")[0].split("/").pop() || "").toLowerCase(); } catch { return String(p ?? "").split("/").pop().toLowerCase(); } };
  const playable = (cid) => cards[cid] && !cards[cid].future && !cards[cid].retired && !cards[cid].character;   // character cards never drop from monsters
  const imgs = images.map(base).filter(Boolean);
  for (const [cid, file] of Object.entries(artFiles ?? {})) if (playable(cid) && imgs.includes(base(file))) return cid;
  const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z]/g, "");
  const n = norm(name);
  if (n) for (const [cid, c] of Object.entries(cards)) if (playable(cid) && norm(c.name) === n) return cid;
  return null;
}
