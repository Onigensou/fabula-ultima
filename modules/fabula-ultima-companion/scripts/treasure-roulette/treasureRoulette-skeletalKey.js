// ============================================================================
// [TreasureRoulette] Skeletal Key • Foundry VTT v12
// ----------------------------------------------------------------------------
// The key that turns a loot roulette into a pick. This file owns only the
// inventory side: how many keys the party holds, and spending one. TR.Flow
// decides when to ask; the screens live in the picker UI.
//
// WHERE KEYS COUNT
// Party Inventory (the database actor) plus every party member (member_id_N).
// A key in anybody's bag makes the prompt appear.
//
// SPEND ORDER
// Party Inventory first — it is the shared stash — then members in slot order.
// A stack that reaches 0 is deleted rather than left behind as a "×0" entry.
//
// Keys are matched by NAME, the same rule the gacha uses for its tickets: an
// actor holds its own copy of the world item, not a link back to it.
//
// WRITES ARE PRIMARY-GM ONLY. TR.Flow is the only caller and is already gated;
// the check here is so a stray console call on a second GM can't double-spend.
// ============================================================================

(() => {
  const KEY = "oni.TreasureRoulette.SkeletalKey";
  if (window[KEY]) {
    console.warn(`[TreasureRoulette][SkeletalKey] Already installed as window["${KEY}"].`);
    return;
  }

  const TAG = "[TreasureRoulette][SkeletalKey]";
  const NAME = "Skeletal Key";
  const ICON = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/Key.png";

  const isPrimaryGM = () => globalThis.FUCompanion?.isPrimaryGM?.() ?? false;

  // Quantities are stored as strings on most items ("1"). A key with no readable
  // quantity still counts as one — it is sitting in the bag.
  function qtyOf(item) {
    const n = Math.floor(Number(item?.system?.props?.item_quantity));
    return Number.isFinite(n) ? Math.max(0, n) : 1;
  }

  /**
   * Every stack of keys the party holds, in spend order.
   * @param {Actor|null} db       Party Inventory (the database actor)
   * @param {Actor[]}    members  party member actors
   * @returns {{actor: Actor, item: Item, qty: number}[]}
   */
  function holdings(db, members = []) {
    const seen = new Set();
    const out = [];
    for (const actor of [db, ...members]) {
      if (!actor || seen.has(actor.uuid)) continue;
      seen.add(actor.uuid);
      for (const item of actor.items ?? []) {
        if (item.name !== NAME) continue;
        const qty = qtyOf(item);
        if (qty > 0) out.push({ actor, item, qty });
      }
    }
    return out;
  }

  /** Total keys across the party. */
  function count(db, members = []) {
    return holdings(db, members).reduce((n, h) => n + h.qty, 0);
  }

  /**
   * Spend one key. Re-reads the live inventories, so a key that moved since the
   * prompt was counted is still found (or correctly missed).
   * @returns {Promise<{ok: boolean, remaining?: number, fromActorName?: string, reason?: string}>}
   */
  async function spendOne(db, members = []) {
    if (!isPrimaryGM()) return { ok: false, reason: "not-primary-gm" };

    const stack = holdings(db, members)[0];
    if (!stack) return { ok: false, reason: "no-key" };
    const { actor, item, qty } = stack;

    try {
      if (qty <= 1) {
        await actor.deleteEmbeddedDocuments("Item", [item.id]);
      } else {
        // Keep the stored type — most items carry the quantity as a string.
        const raw = item.system?.props?.item_quantity;
        const next = qty - 1;
        await item.update({ "system.props.item_quantity": typeof raw === "number" ? next : String(next) });
      }
    } catch (e) {
      console.error(TAG, "spend failed:", e);
      return { ok: false, reason: String(e?.message ?? e) };
    }

    const remaining = count(db, members);
    console.log(TAG, `spent 1 from ${actor.name}; ${remaining} left.`);
    return { ok: true, remaining, fromActorUuid: actor.uuid, fromActorName: actor.name };
  }

  const api = { NAME, ICON, holdings, count, spendOne };

  window[KEY] = api;
  globalThis.ONI ??= {};
  globalThis.ONI.TreasureRoulette ??= {};
  globalThis.ONI.TreasureRoulette.SkeletalKey = api;

  console.debug(`${TAG} Installed as window["${KEY}"].`);
})();
