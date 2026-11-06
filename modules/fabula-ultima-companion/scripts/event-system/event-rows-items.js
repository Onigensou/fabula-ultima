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
 *                       like any gift), or removed from the bag's stacks.
 *     The offered items removes one of each slot of this event's last
 *                       Offer Item offering (an Offer Item row never
 *                       takes them itself).
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

  function worldItemByName(name) {
    const want = Logic.nameKey(name);
    if (!want) return null;
    return (game.items?.contents ?? []).find(i => Logic.nameKey(i.name) === want) ?? null;
  }

  // Take `amount` units of the bag's stacks of one name (largest stack first).
  async function removeByName(party, name, amount) {
    const want = Logic.nameKey(name);
    const stacks = (gameState()?.bagItems?.() ?? []).filter(i => Logic.nameKey(i.name) === want).sort((a, b) => b.qty - a.qty);
    let left = amount;
    for (const stack of stacks) {
      if (left <= 0) break;
      const take = Math.min(stack.qty, left);
      await core().removeItemFromActor({ itemUuid: stack.uuid, quantity: take, senderActorUuid: party.uuid, requestedByUserId: game.user?.id });
      left -= take;
    }
    return amount - left;
  }

  async function execute(row, context) {
    const party = await gameState()?.refresh?.();
    if (!party) return { ok: false, reason: "noParty" };
    if (!core()) return { ok: false, reason: "noItemTransferCore" };

    try {
      if (row.what === "zenit") {
        const delta = row.op === "remove" ? -row.amount : row.amount;
        await core().adjustZenit({ actorUuid: party.uuid, delta, requestedByUserId: game.user?.id });
        return { ok: true, type: "changeItems", delta };
      }

      if (row.what === "offered") {
        if (row.op !== "remove") {
          console.warn(INSTALL_TAG, "Change Items: 'the offered items' can only be removed.");
          return { ok: true, type: "changeItems", skipped: true };
        }
        const ids = window.oni.EventSystem.RowsOffer?.lastOfferedIds?.(context?.tileId) ?? [];
        const counts = new Map();
        for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
        let removed = 0;
        for (const [id, qty] of counts) {
          const item = party.items?.get(id);
          if (!item) continue;
          await core().removeItemFromActor({ itemUuid: item.uuid, quantity: qty, senderActorUuid: party.uuid, requestedByUserId: game.user?.id });
          removed += qty;
        }
        return { ok: true, type: "changeItems", removed };
      }

      if (!row.name) return { ok: false, reason: "noName" };
      if (row.op === "remove") {
        const removed = await removeByName(party, row.name, row.amount);
        return { ok: true, type: "changeItems", removed };
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
