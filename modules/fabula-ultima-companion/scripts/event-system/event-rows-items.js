/**
 * [ONI] Event System — Change Items
 * Foundry VTT v12
 *
 * File:
 * scripts/event-system/event-rows-items.js
 *
 * What this does:
 * - Registers the "Change Items" event action (RPG Maker's Change Items /
 *   Change Gold): add or remove items in the party bag, or zenit in the
 *   party stash.
 *     An item by name   added from the world's item of that name (stacks
 *                       like any gift) to the stash, or removed from
 *                       wherever the party holds it: stash first, then
 *                       members' bags, worn gear last.
 *     The offered items removes one of each slot of this event's last
 *                       Offer Item offering, from whoever gave it (an
 *                       Offer Item row never takes them itself).
 *   Removals return `taken: [{ name, qty, from, fromId }]` (and log it), so
 *   a later notice can say whose item went.
 *     Zenit             added to / taken from the party stash.
 * - It goes through the item transfer core (window["oni.ItemTransferCore"]),
 *   the same code as the GM's give / take tools, so stacks and gear with
 *   skills inside are handled the usual way.
 *
 * Runs on the GM running the event (the main GM).
 *
 * Requires:
 * - event-logic.js, event-eventRegistry.js, event-gameState.js,
 *   event-rows-offer.js (for "the offered items"), item-transfer core
 */

(() => {
  const INSTALL_TAG = "[ONI][EventSystem][RowsItems]";

  window.oni = window.oni || {};
  window.oni.EventSystem = window.oni.EventSystem || {};

  if (window.oni.EventSystem.RowsItems?.installed) {
    console.debug(INSTALL_TAG, "Already installed; skipping.");
    return;
  }

  const Logic = window.oni.EventSystem.Logic;
  const EventRegistry = window.oni.EventSystem.EventRegistry;
  if (!Logic || !EventRegistry) {
    console.error(INSTALL_TAG, "Missing Logic or EventRegistry. Check load order.");
    return;
  }

  const OPS = [["add", "Add"], ["remove", "Remove"]];
  const WHATS = [["item", "An item by name"], ["offered", "The offered items (last Offer Item)"], ["zenit", "Zenit (party stash)"]];

  const gameState = () => window.oni.EventSystem.GameState;
  const core = () => window["oni.ItemTransferCore"];

  function prepare(row) {
    row.op = row.op === "remove" ? "remove" : "add";
    row.what = WHATS.some(([k]) => k === row.what) ? row.what : "item";
    row.name = String(row.name ?? "").trim();
    row.amount = Math.max(1, Math.round(Logic.toNumber(row.amount, 1)));
  }

  // A name can match more than the item itself: a CSB sub-item (an item's own
  // skill / variant, kept as a hidden world item in "CSB - Embedded Items
  // Folder", system.container set) or a use-skill filed under the Skill folders
  // ("Remedy" in Consumable Skill). Prefer the real item; the first match took
  // the Remedy use-skill and gave the party that instead (found 2026-11-14).
  function folderNames(i) { const out = []; let f = i?.folder; while (f) { out.push(f.name); f = f.folder; } return out; }
  function isRealItem(i) {
    return !i.system?.container
      && !folderNames(i).some(n => /CSB - Embedded Items Folder/i.test(n) || /^\W*Skill\b/i.test(n));
  }
  function worldItemByName(name) {
    const want = Logic.nameKey(name);
    if (!want) return null;
    const hits = (game.items?.contents ?? []).filter(i => Logic.nameKey(i.name) === want);
    return hits.find(isRealItem) ?? hits[0] ?? null;
  }

  // Take `amount` units of one name from wherever the party holds it:
  // the stash first, then members' bags, worn gear last (largest stack first
  // within each). Returns who it was taken from: [{ name, qty, from, fromId }].
  async function removeByName(name, amount) {
    const want = Logic.nameKey(name);
    const rank = (i) => (i.stash ? 0 : i.equipped ? 2 : 1);
    const stacks = (gameState()?.partyItems?.() ?? [])
      .filter(i => Logic.nameKey(i.name) === want)
      .sort((a, b) => (rank(a) - rank(b)) || (b.qty - a.qty));
    const taken = [];
    let left = amount;
    for (const stack of stacks) {
      if (left <= 0) break;
      const want = Math.min(stack.qty, left);
      const take = await takeFrom(stack.item, game.actors?.get(stack.owner), want);
      if (take <= 0) continue;
      taken.push({ name: stack.name, qty: take, from: stack.ownerName, fromId: stack.owner });
      left -= take;
    }
    return taken;
  }

  // Take up to `qty` of one item from its owner through the transfer core,
  // and return how many really left. Measured on the owner, not trusted from
  // the core's answer: the core refuses a stack at 0, and it can throw AFTER
  // the item is gone (gear with skills inside: its sub-items are already
  // deleted when it tries to delete them again: "Item ... does not exist").
  async function takeFrom(item, owner, qty) {
    const left = () => {
      const it = owner?.items?.get(item.id);
      return it ? Math.max(0, Logic.toNumber(it.system?.props?.item_quantity, 1)) : 0;
    };
    const before = left();
    try {
      // announce: every screen reads "Keren handed over Old Bell." (FU.Feedback.items)
      await core().removeItemFromActor({ itemUuid: item.uuid, quantity: qty, senderActorUuid: owner.uuid, requestedByUserId: game.user?.id, announce: true });
    } catch (e) {
      console.warn(INSTALL_TAG, `Item transfer reported an error taking ${item.name} from ${owner?.name}; counting what actually left.`, e);
    }
    return Math.max(0, Math.round(before - left()));
  }

  const sumQty = (taken) => taken.reduce((n, t) => n + t.qty, 0);
  const logTaken = (taken) => {
    if (taken.length) console.log(INSTALL_TAG, "Taken:", taken.map(t => `${t.qty}× ${t.name} from ${t.from}`).join(", "));
  };

  // One row = one batch of feedback: whatever it adds or takes (stash and bags)
  // reads as one set of lines — "The party obtained …!", "Keren handed over …."
  async function execute(row, context) {
    const group = globalThis.FU?.Feedback?.group ?? ((f) => f());
    return group(() => executeRow(row, context));
  }

  async function executeRow(row, context) {
    const party = await gameState()?.refresh?.();
    if (!party) return { ok: false, reason: "noParty" };
    if (!core()) return { ok: false, reason: "noItemTransferCore" };

    try {
      if (row.what === "zenit") {
        const delta = row.op === "remove" ? -row.amount : row.amount;
        await core().adjustZenit({ actorUuid: party.uuid, delta, requestedByUserId: game.user?.id, announce: true });
        return { ok: true, type: "changeItems", delta };
      }

      if (row.what === "offered") {
        if (row.op !== "remove") {
          console.warn(INSTALL_TAG, "Change Items: 'the offered items' can only be removed.");
          return { ok: true, type: "changeItems", skipped: true };
        }
        // Each id is "<owner actor id>.<item id>" (a bare item id = the stash).
        const ids = window.oni.EventSystem.RowsOffer?.lastOfferedIds?.(context?.tileId) ?? [];
        const counts = new Map();
        for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
        const taken = [];
        for (const [key, qty] of counts) {
          const dot = key.indexOf(".");
          const owner = dot < 0 ? party : game.actors?.get(key.slice(0, dot));
          const item = owner?.items?.get(dot < 0 ? key : key.slice(dot + 1));
          if (!item) continue;
          const took = await takeFrom(item, owner, qty);
          if (took <= 0) continue;
          taken.push({ name: item.name, qty: took, from: owner.id === party.id ? "Party Stash" : owner.name, fromId: owner.id });
        }
        logTaken(taken);
        return { ok: true, type: "changeItems", removed: sumQty(taken), taken };
      }

      if (!row.name) return { ok: false, reason: "noName" };
      if (row.op === "remove") {
        const taken = await removeByName(row.name, row.amount);
        logTaken(taken);
        return { ok: true, type: "changeItems", removed: sumQty(taken), taken };
      }

      const template = worldItemByName(row.name);
      if (!template) {
        console.warn(INSTALL_TAG, `Change Items: no world item is named "${row.name}".`);
        return { ok: false, reason: "noSuchItem" };
      }
      await core().grantItemToActor({ itemUuid: template.uuid, quantity: row.amount, receiverActorUuid: party.uuid, requestedByUserId: game.user?.id });
      return { ok: true, type: "changeItems", added: row.amount };
    } catch (e) {
      console.warn(INSTALL_TAG, "Change Items failed.", e);
      return { ok: false, reason: "transferError", error: e };
    }
  }

  EventRegistry.register({
    type: "changeItems",
    label: "Change Items",
    category: "Party",
    defaultData: { type: "changeItems", op: "add", what: "item", name: "", amount: 1 },
    prepare,
    summary: (row) => {
      const op = row?.op === "remove" ? "Remove" : "Add";
      if (row?.what === "zenit") return `${op} ${row?.amount ?? 1} zenit`;
      if (row?.what === "offered") return `${op} the offered items`;
      return `${op} ${row?.amount ?? 1} × ${row?.name || "(no name)"}`;
    },
    execute,
    buildFields: (row, kit) => {
      const body = kit.fields(
        kit.field("Change",
          `<div class="oni-event-inline-row">
             <select class="oni-items-op">${kit.options(OPS, row.op)}</select>
             <select class="oni-items-what">${kit.options(WHATS, row.what)}</select>
           </div>`,
          "Items go to / come from the party bag; zenit the party stash."),
        kit.field("Item", `<input type="text" class="oni-items-name oni-grow" value="${kit.escapeHTML(row.name)}" placeholder="Item name (a world item, to add)" />`),
        kit.field("Amount", kit.numberInput("oni-items-amount", row.amount, { min: 1, step: 1 }))
      );
      const whatEl = body.querySelector(".oni-items-what");
      const nameField = body.querySelector(".oni-items-name").closest(".oni-event-inline-grid");
      const amountField = body.querySelector(".oni-items-amount").closest(".oni-event-inline-grid");
      const sync = () => {
        if (nameField) nameField.hidden = whatEl.value !== "item";
        if (amountField) amountField.hidden = whatEl.value === "offered";
      };
      whatEl.addEventListener("change", sync);
      sync();
      return body;
    },
    collectFields: (rowEl, kit) => ({
      op: kit.readText(rowEl, ".oni-items-op", "add"),
      what: kit.readText(rowEl, ".oni-items-what", "item"),
      name: kit.readText(rowEl, ".oni-items-name", "").trim(),
      amount: Math.max(1, Math.round(kit.readNumber(rowEl, ".oni-items-amount", 1)))
    })
  });

  window.oni.EventSystem.RowsItems = { installed: true, worldItemByName };

  console.debug(INSTALL_TAG, "Installed.");
})();
