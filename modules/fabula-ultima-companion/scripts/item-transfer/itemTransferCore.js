// ============================================================================
// ItemTransferCore
// ============================================================================
// Central logic for moving item documents around in your FabU / TRPG game.
// This script has **no UI**. Other scripts (shop UI, trade UI, loot UI, etc.)
// should build a payload object and call:
//
//   await window["oni.ItemTransferCore"].transfer(payload)
//
// Payload shape:
//
// {
//   mode: "actorToActor" | "gmToActor" | "actorToGm",
//
//   itemUuid: string,           // source item uuid
//   quantity?: number,          // how many to move (defaults to 1)
//
//   senderActorUuid?: string,   // required for actorToActor & actorToGm
//   receiverActorUuid?: string, // required for actorToActor & gmToActor
//
//   requestedByUserId?: string, // optional, for logging/permission checks
//
//   // NEW (UI option):
//   // If true/undefined => receiver will see "Obtained X Item" card.
//   // If false => do not show the transfer card UI.
//   showTransferCard?: boolean
// }
//
// Modes:
//   - "actorToActor":
//        Move from senderActor → receiverActor.
//        Quantity is decreased from sender; if it drops to 0, the sender’s
//        item is deleted. On receiver, if an item with the same name exists,
//        its quantity is increased; otherwise a new item is created by cloning
//        the source item.
//
//   - "gmToActor":
//        GM/system/template/world/shop → Actor.
//        The source item is **not** modified. We clone it and give it to
//        the receiver actor. If they already have an item with the same name,
//        we increase quantity instead of making a new copy.
//
//   - "actorToGm":
//        Actor → GM/system. The item is simply removed from the actor:
//        quantity is decreased, and if it reaches 0, the item is deleted.
//
// Notes:
//   - Sub-items (CSB `system.container` children — a gear shell's linked
//     `_skill`, an Elemental Shard's element variants, ...) travel with their
//     parent, nesting included, on every mode that mints a receiver item —
//     partial transfers as well as full ones. See the "Sub-item helpers"
//     section for why a plain `createEmbeddedDocuments` loses them.
//   - Quantity is stored at `system.props.item_quantity` (as in your demo).
//   - Shop sheets that are Actors can use "actorToActor" mode directly.
//   - This core is intentionally “dumb UI-wise”: it just manipulates data.
//
// ============================================================================

(() => {
  const KEY = "oni.ItemTransferCore";

  // Avoid double-installing if the script is executed twice
  if (window[KEY]) {
    console.warn("[ItemTransferCore] Already installed as window[\"oni.ItemTransferCore\"].");
    return;
  }

  // --------------------------------------------------------------------------
  // Small helpers
  // --------------------------------------------------------------------------

  /**
   * Normalize a quantity value:
   * - default to 1
   * - ensure it's a positive integer
   */
  function normalizeQuantity(rawQty) {
    let q = Number(rawQty);
    if (!Number.isFinite(q) || q <= 0) q = 1;
    return Math.max(1, Math.floor(q));
  }

  /**
   * Get the item_quantity value from an item document.
   * If missing, treat it as 1 (single copy).
   */
  function getItemQuantity(item) {
    return Number(item?.system?.props?.item_quantity ?? 1);
  }

  /**
   * Build an update path for item_quantity.
   * (Keeps the path in one place in case we change structure later.)
   */
  function makeQuantityUpdate(qty) {
    return { "system.props.item_quantity": qty };
  }

  /**
   * Resolve an Actor from a UUID, with error handling.
   */
  async function resolveActor(actorUuid, contextLabel) {
    if (!actorUuid) {
      throw new Error(`[ItemTransferCore] Missing actorUuid for ${contextLabel}.`);
    }
    const doc = await fromUuid(actorUuid);
    if (!doc || !(doc instanceof Actor)) {
      throw new Error(`[ItemTransferCore] Could not resolve Actor for ${contextLabel} from uuid=${actorUuid}`);
    }
    return doc;
  }

  /**
   * Resolve an Item from a UUID, with error handling.
   */
  async function resolveItem(itemUuid) {
    if (!itemUuid) {
      throw new Error("[ItemTransferCore] Missing itemUuid in payload.");
    }
    const doc = await fromUuid(itemUuid);
    if (!doc || !(doc instanceof Item)) {
      throw new Error(`[ItemTransferCore] Could not resolve Item from uuid=${itemUuid}`);
    }
    return doc;
  }

    /**
   * Try to find an "equivalent" item on an actor to stack with.
   *
   * IMPORTANT (Oni rule):
   * - Only "Consumable" items are allowed to stack.
   * - Weapons / Armor / Accessories (and everything else) should create new copies.
   *
   * We use your system fields:
   * - system.props.item_type
   * - system.props.item_quantity
   */
  function findStackableItemOnActor(actor, sourceItem) {
    const sourceName = sourceItem?.name;
    const sourceDocType = sourceItem?.type;

    // Your system category (Weapon/Armor/Accessories/Consumable/etc.)
    const sourceItemType = String(sourceItem?.system?.props?.item_type ?? "").trim().toLowerCase();

    if (!sourceName) return null;

    // Only allow stacking for Consumables
    if (sourceItemType !== "consumable") return null;

    return actor.items.find(i => {
      const targetItemType = String(i?.system?.props?.item_type ?? "").trim().toLowerCase();
      if (targetItemType !== "consumable") return false;

      return i.name === sourceName && i.type === sourceDocType;
    }) ?? null;
  }

    // --------------------------------------------------------------------------
  // Sub-item helpers (CSB itemContainer linkage)
  // --------------------------------------------------------------------------
  //
  // CSB links a child item to its parent via `child.system.container = parent.id`
  // (see CustomItem.items getter). An itemContainer component on the parent
  // (e.g. `related_item_list` on the _Item Template) shows those children and
  // stores per-row column data at `parent.system.props.<containerKey>[childId]`.
  //
  // `Actor#createEmbeddedDocuments` does NOT understand that linkage: CSB only
  // walks `data.items` in its own static `CustomItem.create`, so a plain
  // embedded create silently produces a childless parent. The helpers below
  // snapshot the whole container subtree, clone it onto the receiver with every
  // `system.container` re-pointed at the corresponding new id, and re-key the
  // parents' itemContainer prop dicts old-id → new-id.

  // Matches CustomItem.MAX_DEPTH — how deep CSB lets containers nest.
  const MAX_CHILD_DEPTH = 5;

  /**
   * Direct children of `parentItem` in whichever collection it lives in.
   * For an actor-owned parent that's `parent.parent.items`; for a world
   * item it's `game.items`.
   */
  function getSourceChildItems(parentItem) {
    if (!parentItem?.id) return [];
    const collection = parentItem.parent?.items ?? game.items;
    if (!collection) return [];
    const list = collection.contents ?? Array.from(collection);
    return list.filter((i) => i?.system?.container === parentItem.id);
  }

  /**
   * Snapshot the FULL container subtree under `parentItem` as
   * `[{ doc, srcId, srcContainerId }]`, depth-first, capped at CSB's nesting
   * limit. Must be called BEFORE any sender-side mutation: deleting the parent
   * makes CSB cascade-delete the children (CustomItem#_preDelete), which
   * removes them from the collection this walk reads.
   */
  function snapshotChildTree(parentItem, depth = 0, seen = new Set()) {
    if (depth >= MAX_CHILD_DEPTH) return [];
    const out = [];
    for (const child of getSourceChildItems(parentItem)) {
      if (!child?.id || seen.has(child.id)) continue; // cycle guard
      seen.add(child.id);
      out.push({ doc: child, srcId: child.id, srcContainerId: parentItem.id });
      out.push(...snapshotChildTree(child, depth + 1, seen));
    }
    return out;
  }

  /**
   * Re-key any object-shaped prop on `parentItem.system.props` whose row
   * keys match an entry in `idMap` (old child id → new child id). Only
   * touches props where at least one key actually maps; others are left
   * alone. Done as delete-then-set to avoid Foundry's mergeObject merging
   * the renamed row dict with the original.
   */
  async function rekeyItemContainerProps(parentItem, idMap) {
    const oldIds = Object.keys(idMap);
    if (!oldIds.length) return;
    const oldIdSet = new Set(oldIds);
    const props = parentItem.system?.props ?? {};
    const deletes = {};
    const sets = {};
    for (const [propKey, propValue] of Object.entries(props)) {
      if (!propValue || typeof propValue !== "object" || Array.isArray(propValue)) continue;
      const rowKeys = Object.keys(propValue);
      if (!rowKeys.some((k) => oldIdSet.has(k))) continue;
      const rekeyed = {};
      for (const [rowKey, rowData] of Object.entries(propValue)) {
        rekeyed[idMap[rowKey] ?? rowKey] = rowData;
      }
      deletes[`-=${propKey}`] = null;
      sets[propKey] = rekeyed;
    }
    if (!Object.keys(sets).length) return;
    await parentItem.update({ system: { props: deletes } });
    await parentItem.update({ system: { props: sets } });
  }

  /**
   * Clone a snapshotted subtree (from `snapshotChildTree`) onto
   * `receiverActor` under `receiverParent`.
   *
   * New ids are minted up front so a nested child's `system.container` can be
   * re-pointed at its own new parent id — the whole tree then goes in as ONE
   * `keepId: true` create, the same trick CSB's `createWithContents` uses.
   * Afterwards every container's itemContainer prop dicts are re-keyed
   * old-id → new-id. Returns the old-id → new-id map.
   */
  async function cloneChildTreeToReceiver(nodes, receiverActor, receiverParent, sourceParentId) {
    if (!nodes?.length || !receiverActor || !receiverParent?.id) return {};

    const idMap = {};
    if (sourceParentId) idMap[sourceParentId] = receiverParent.id;
    for (const n of nodes) idMap[n.srcId] = foundry.utils.randomID();

    const cloneData = nodes.map((n) => {
      const data = n.doc.toObject();
      // CSB's CustomItem#toObject() injects a `items` array of sub-item data.
      // It is not part of the Item schema and the sub-items are already in
      // `nodes` — leaving it in only produces validation noise.
      delete data.items;
      data._id = idMap[n.srcId];
      data.system = data.system ?? {};
      data.system.container = idMap[n.srcContainerId] ?? receiverParent.id;
      return data;
    });

    const created = await receiverActor.createEmbeddedDocuments("Item", cloneData, { keepId: true });

    // Re-key the row dicts on the receiver parent and on every cloned child
    // that is itself a container.
    await rekeyItemContainerProps(receiverParent, idMap);
    for (const doc of created ?? []) {
      await rekeyItemContainerProps(doc, idMap);
    }
    return idMap;
  }

  /**
   * PUBLIC primitive — give a freshly-created item the sub-item tree its
   * source had.
   *
   * Anything that copies an item onto an actor with a bare
   * `createEmbeddedDocuments` produces a CHILDLESS parent: CSB only walks
   * `data.items` inside its own static `CustomItem.create`. Loot drops,
   * character-creation equipment, camp rewards — all hit that. They can call
   * this straight after their create instead of re-deriving the linkage:
   *
   *   const [item] = await actor.createEmbeddedDocuments("Item", [data]);
   *   await window["oni.ItemTransferCore"]
   *     ?.copySubItemTree({ sourceItem, receiverActor: actor, receiverParent: item });
   *
   * `onlyIfEmpty` makes it safe to hand a STACK target: with it set, an item
   * that already has children is left alone, so the call can't duplicate.
   * Returns the old-id → new-id map ({} when there was nothing to copy).
   */
  async function copySubItemTree({ sourceItem, receiverActor, receiverParent, onlyIfEmpty = false } = {}) {
    if (!sourceItem?.id || !receiverActor || !receiverParent?.id) return {};
    if (onlyIfEmpty && getSourceChildItems(receiverParent).length) return {};

    const nodes = snapshotChildTree(sourceItem);
    if (!nodes.length) return {};

    return await cloneChildTreeToReceiver(nodes, receiverActor, receiverParent, sourceItem.id);
  }

  /**
   * Delete snapshotted sender-side children. CSB's `CustomItem#_preDelete`
   * already cascade-deletes children when their parent goes, so this is a
   * safety net for anything that survived — ids that are already gone are
   * filtered out so the call can't throw.
   */
  async function deleteChildTreeFromSender(nodes, senderActor) {
    if (!nodes?.length || !senderActor) return;
    const ids = nodes
      .map((n) => n.srcId)
      .filter((id) => id && senderActor.items?.has?.(id));
    if (ids.length) await senderActor.deleteEmbeddedDocuments("Item", ids);
  }

    // --------------------------------------------------------------------------
  // Transfer Card UI (multi-client emit helpers)
  // --------------------------------------------------------------------------

  // IMPORTANT:
  // Must match TransferCardUI.js
  const SOCKET_CHANNEL = "module.fabula-ultima-companion";
  const MSG_TYPE_SHOW_CARD = "ONI_ITEMTRANSFER_SHOW_CARD";

  /**
   * Decide which USERS should see the "Obtained" card for a receiver Actor.
   * We choose all users who have OWNER permission on that actor.
   * Also includes a user whose assigned character IS that actor.
   */
 function getRecipientUserIdsForActor(actor) {
  const ids = new Set();

  if (!actor || !game?.users) return [];

  const users = Array.from(game.users.contents || []).filter(Boolean);

  // ------------------------------------------------------------
  // A) Collect PLAYER recipients (non-GM)
  //    Priority:
  //    1) non-GM linked character match
  //    2) non-GM OWNER fallback
  // ------------------------------------------------------------

  const playerLinked = [];
  const playerOwners = [];

  // 1) non-GM linked character match
  for (const u of users) {
    if (!u?.id) continue;
    if (u.isGM) continue;

    if (u.character?.id && actor.id && u.character.id === actor.id) {
      playerLinked.push(u.id);
    }
  }

  // 2) non-GM OWNER fallback (only if no linked players)
  if (playerLinked.length === 0) {
    for (const u of users) {
      if (!u?.id) continue;
      if (u.isGM) continue;

      try {
        const isOwner = actor.testUserPermission?.(u, "OWNER") || false;
        if (isOwner) playerOwners.push(u.id);
      } catch (e) {
        // ignore
      }
    }
  }

  // Choose which player list we’re using (linked wins)
  const playerRecipients = playerLinked.length > 0 ? playerLinked : playerOwners;

  // Add selected player recipients
  for (const id of playerRecipients) ids.add(id);

  // ------------------------------------------------------------
  // B) GM rule (your requested behavior)
  //    Add GM ONLY if:
  //    - GM has a linked character (u.character exists)
  //    - AND that linked character IS the receiver actor
  //    This is ADDED even if players also own the actor.
  // ------------------------------------------------------------
  for (const u of users) {
    if (!u?.id) continue;
    if (!u.isGM) continue;

    // GM must have a linked character
    if (!u.character?.id) continue;

    // And it must match the receiver actor
    if (actor.id && u.character.id === actor.id) {
      ids.add(u.id);
    }
  }

  return Array.from(ids);
}

  /**
   * Emit a socket packet that asks ONLY the receiver-owner clients to show a card.
   * Every client receives the socket message, but only recipients will display it.
   */
   function emitTransferCardToRecipients({ receiverActor, quantity, itemName, itemImg, receiverItemUuid }) {
    try {
      if (!game?.socket) {
        console.warn("[ItemTransferCore] No game.socket; cannot emit transfer card.");
        return;
      }

      const recipientUserIds = getRecipientUserIdsForActor(receiverActor);
      if (!recipientUserIds.length) {
        console.warn("[ItemTransferCore] No recipient users found for receiverActor; skipping transfer card emit.", {
          receiverActorUuid: receiverActor?.uuid
        });
        return;
      }

      const payload = {
        recipientUserIds,
        quantity,
        itemName,
        itemImg,
        receiverActorUuid: receiverActor?.uuid ?? null,
        receiverItemUuid: receiverItemUuid ?? null,

        // Optional tuning
        lingerSeconds: 3.0,
        scale: 1.1
      };

      console.log("[ItemTransferCore] Emitting transfer card:", payload);

      // Prefer TransferCardUI helper (it includes LOCAL LOOPBACK so sender can also see the card)
            const tUI = window["oni.TransferCardUI"];
      if (tUI && typeof tUI.emitToRecipients === "function") {
        // IMPORTANT: TransferCardUI.emitToRecipients expects PAYLOAD ONLY.
        // It will wrap { type, payload } by itself.
        tUI.emitToRecipients(payload);
        return;
      }

      // Fallback: raw socket emit (note: sender usually won't receive its own message)
      game.socket.emit(SOCKET_CHANNEL, {
        type: MSG_TYPE_SHOW_CARD,
        payload
      });
    } catch (err) {
      console.error("[ItemTransferCore] Failed to emit transfer card:", err);
    }
  }

    // --------------------------------------------------------------------------
  // Zenit helpers (currency)
  // --------------------------------------------------------------------------

  /**
   * Read an Actor's current Zenit value.
   * Uses system.props.zenit as requested.
   */
  function getActorZenit(actor) {
    const raw = getProperty(actor, "system.props.zenit");
    const n = Number(raw ?? 0);
    return Number.isFinite(n) ? n : 0;
  }

  /**
   * Build an update object for setting Zenit.
   * Clamps to >= 0 and floors to integer.
   */
  function makeZenitUpdate(newValue) {
    const safe = Math.max(0, Math.floor(Number(newValue) || 0));
    return { "system.props.zenit": safe };
  }

  /**
   * Normalize a Zenit amount used in transfers.
   * Must be a positive finite integer.
   */
  function normalizeZenitAmount(rawAmount) {
    const n = Number(rawAmount);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`[ItemTransferCore] Invalid Zenit amount: ${rawAmount}`);
    }
    return Math.floor(n);
  }

  // --------------------------------------------------------------------------
  // Core operations
  // --------------------------------------------------------------------------

  /**
   * Actor → Actor transfer:
   *  - Decrease quantity from sender's embedded item
   *  - If sender's quantity hits 0, delete that item
   *  - On receiver, increase quantity if a stackable item exists,
   *    otherwise create a new cloned item with the transferred quantity.
   */
  async function transferActorToActor(payload) {
    const {
      itemUuid,
      quantity,
      senderActorUuid,
      receiverActorUuid,
      requestedByUserId
    } = payload || {};

    console.log("[ItemTransferCore] transferActorToActor called.", {
      itemUuid,
      quantity,
      senderActorUuid,
      receiverActorUuid,
      requestedByUserId
    });

    // Resolve the source item
    const sourceItem = await resolveItem(itemUuid);

    // Prefer the item's parent as sender if it is an Actor
    let senderActor = sourceItem.parent instanceof Actor ? sourceItem.parent : null;

    // If a senderActorUuid is explicitly given, cross-check / override
    if (senderActorUuid) {
      const explicitSender = await resolveActor(senderActorUuid, "senderActorUuid");
      if (senderActor && explicitSender.id !== senderActor.id) {
        console.warn("[ItemTransferCore] Source item parent Actor does not match senderActorUuid. Using senderActorUuid.", {
          itemParentUuid: senderActor.uuid,
          senderActorUuid
        });
      }
      senderActor = explicitSender;
    }

    if (!senderActor) {
      throw new Error("[ItemTransferCore] transferActorToActor: Could not determine sender actor from item parent or senderActorUuid.");
    }

    // Sanity check: make sure the source item actually belongs to the sender
    if (sourceItem.parent?.id !== senderActor.id) {
      console.warn("[ItemTransferCore] Source item parent does not match resolved sender actor. Attempting to refetch from senderActor.items.", {
        itemUuid,
        senderActorUuid: senderActor.uuid
      });

      // Try to find the item by id inside the sender actor
      const itemId = sourceItem.id;
      const embedded = senderActor.items.get(itemId);
      if (embedded) {
        // Use the embedded version instead
        console.log("[ItemTransferCore] Using senderActor embedded version of the item.");
      } else {
        console.warn("[ItemTransferCore] Could not find embedded item on senderActor; continuing with sourceItem anyway.");
      }
    }

    // Resolve the receiver
    const receiverActor = await resolveActor(receiverActorUuid, "receiverActorUuid");

    // Quantity logic
    const requestedQty = normalizeQuantity(quantity);
    const senderCurrentQty = getItemQuantity(sourceItem);

    if (senderCurrentQty <= 0) {
      console.warn("[ItemTransferCore] Sender's item quantity is <= 0. Nothing to transfer.", {
        senderCurrentQty,
        itemUuid
      });
      return {
        ok: false,
        reason: "sender_quantity_zero_or_negative",
        senderCurrentQty
      };
    }

    const transferQty = Math.min(requestedQty, senderCurrentQty);
    if (transferQty < requestedQty) {
      console.warn("[ItemTransferCore] Requested quantity is larger than sender's stock. Clamping.", {
        requestedQty,
        senderCurrentQty,
        transferQty
      });
    }

    // 1) Update sender: decrease quantity or delete item
    const senderRemaining = senderCurrentQty - transferQty;

    // Snapshot the sender-side sub-item tree BEFORE touching anything: on a
    // full transfer the parent's deletion cascade-deletes the children, which
    // destroys the system.container linkage the walk relies on.
    //
    // This runs for PARTIAL transfers too. Buying 1 of a stack of 100 mints a
    // brand-new parent on the receiver, and that copy needs its OWN children —
    // the sender keeping theirs is not the receiver getting any.
    const childNodesToCopy = snapshotChildTree(sourceItem);

    if (senderRemaining > 0) {
      await sourceItem.update(makeQuantityUpdate(senderRemaining));
      console.log("[ItemTransferCore] Updated sender item quantity.", {
        itemUuid: sourceItem.uuid,
        oldQty: senderCurrentQty,
        newQty: senderRemaining
      });
    } else {
      // Delete the item from the sender
      await senderActor.deleteEmbeddedDocuments("Item", [sourceItem.id]);
      console.log("[ItemTransferCore] Deleted sender item (quantity reached 0).", {
        actorUuid: senderActor.uuid,
        itemId: sourceItem.id
      });
    }

    // 2) Update receiver: stack or create new
    const stackTarget = findStackableItemOnActor(receiverActor, sourceItem);
    let receiverItemUuid = null;
    let receiverNewQty = null;
    let createdParent = null;

    if (stackTarget) {
      const receiverCurrentQty = getItemQuantity(stackTarget);
      receiverNewQty = receiverCurrentQty + transferQty;
      await stackTarget.update(makeQuantityUpdate(receiverNewQty));

      receiverItemUuid = stackTarget.uuid;
      console.log("[ItemTransferCore] Increased receiver stackable item quantity.", {
        receiverActorUuid: receiverActor.uuid,
        itemUuid: receiverItemUuid,
        oldQty: receiverCurrentQty,
        addedQty: transferQty,
        newQty: receiverNewQty
      });
    } else {
      const itemData = sourceItem.toObject();
      delete itemData._id;
      delete itemData.items; // CSB toObject() artifact — children are handled below
      itemData.system = itemData.system || {};
      itemData.system.props = itemData.system.props || {};
      itemData.system.props.item_quantity = transferQty;

      const created = await receiverActor.createEmbeddedDocuments("Item", [itemData]);
      createdParent = created[0];
      receiverItemUuid = createdParent.uuid;
      receiverNewQty = transferQty;

      console.log("[ItemTransferCore] Created new receiver item with transferred quantity.", {
        receiverActorUuid: receiverActor.uuid,
        itemUuid: receiverItemUuid,
        qty: receiverNewQty
      });
    }

    // 3) Carry the sub-item tree along.
    //
    //  - Fresh receiver item  -> always clone the tree onto it (full OR partial).
    //  - Stacked onto an existing item -> that stack normally has its own
    //    children already; only fill it in if it has NONE, which repairs copies
    //    minted by the old partial-transfer path. Gating on "zero children"
    //    means this can never duplicate.
    if (childNodesToCopy.length) {
      const target = createdParent
        ?? (stackTarget && !getSourceChildItems(stackTarget).length ? stackTarget : null);

      if (target) {
        const idMap = await cloneChildTreeToReceiver(
          childNodesToCopy, receiverActor, target, sourceItem.id
        );
        console.log("[ItemTransferCore] Cloned sub-item tree to receiver.", {
          receiverActorUuid: receiverActor.uuid,
          parentUuid: target.uuid,
          repairedStack: !createdParent,
          count: childNodesToCopy.length,
          idMap
        });
      }
    }

    // Only prune the sender's children when the sender's parent itself went
    // away. A partial transfer leaves the parent (and its children) in place.
    if (senderRemaining <= 0) {
      await deleteChildTreeFromSender(childNodesToCopy, senderActor);
    }

       const result = {
      ok: true,
      mode: "actorToActor",
      sender: {
        actorUuid: senderActor.uuid,
        remainingQty: Math.max(senderRemaining, 0)
      },
      receiver: {
        actorUuid: receiverActor.uuid,
        itemUuid: receiverItemUuid,
        quantityAfter: receiverNewQty
      },
      transferredQty: transferQty
    };

    // NEW: Transfer Card UI (receiver-only)
    // Default behavior: show card unless explicitly disabled.
    const showTransferCard = payload?.showTransferCard !== false;
    if (showTransferCard) {
      emitTransferCardToRecipients({
        receiverActor,
        quantity: transferQty,
        itemName: sourceItem.name,
        itemImg: sourceItem.img,
        receiverItemUuid
      });
    }

    return result;
  }

    // --------------------------------------------------------------------------
  // Zenit core operations
  // --------------------------------------------------------------------------

  /**
   * Transfer Zenit from one Actor to another.
   *
   * Payload:
   * {
   *   senderActorUuid:   string,   // required
   *   receiverActorUuid: string,   // required
   *   amount:            number,   // required (> 0)
   *   requestedByUserId?: string
   * }
   *
   * Returns:
   * {
   *   ok: boolean,
   *   reason?: "insufficient_funds" | string,
   *   transferredAmount?: number,
   *   sender?:   { actorUuid, before, after },
   *   receiver?: { actorUuid, before, after },
   *   requestedByUserId?: string
   * }
   */
  async function transferZenitBetweenActors(payload) {
    if (!payload || typeof payload !== "object") {
      throw new Error("[ItemTransferCore] transferZenitBetweenActors() requires a payload object.");
    }

    const {
      senderActorUuid,
      receiverActorUuid,
      amount,
      requestedByUserId
    } = payload;

    console.log("[ItemTransferCore] transferZenitBetweenActors called.", {
      senderActorUuid,
      receiverActorUuid,
      amount,
      requestedByUserId
    });

    if (!senderActorUuid) {
      throw new Error("[ItemTransferCore] transferZenitBetweenActors: Missing senderActorUuid.");
    }
    if (!receiverActorUuid) {
      throw new Error("[ItemTransferCore] transferZenitBetweenActors: Missing receiverActorUuid.");
    }

    const transferAmount = normalizeZenitAmount(amount);

    // Reuse the existing resolveActor helper
    const senderActor   = await resolveActor(senderActorUuid,   "senderActorUuid (Zenit)");
    const receiverActor = await resolveActor(receiverActorUuid, "receiverActorUuid (Zenit)");

    const senderBefore   = getActorZenit(senderActor);
    const receiverBefore = getActorZenit(receiverActor);

    if (senderBefore < transferAmount) {
      console.warn("[ItemTransferCore] Sender has insufficient Zenit for transfer.", {
        senderActorUuid: senderActor.uuid,
        needed: transferAmount,
        available: senderBefore
      });

      return {
        ok: false,
        reason: "insufficient_funds",
        transferredAmount: 0,
        sender: {
          actorUuid: senderActor.uuid,
          before: senderBefore,
          after: senderBefore
        },
        receiver: {
          actorUuid: receiverActor.uuid,
          before: receiverBefore,
          after: receiverBefore
        },
        requestedByUserId
      };
    }

    const senderAfter   = senderBefore   - transferAmount;
    const receiverAfter = receiverBefore + transferAmount;

    await senderActor.update(makeZenitUpdate(senderAfter));
    await receiverActor.update(makeZenitUpdate(receiverAfter));

    console.log("[ItemTransferCore] Zenit transfer complete.", {
      transferredAmount: transferAmount,
      sender: {
        actorUuid: senderActor.uuid,
        before: senderBefore,
        after: senderAfter
      },
      receiver: {
        actorUuid: receiverActor.uuid,
        before: receiverBefore,
        after: receiverAfter
      },
      requestedByUserId
    });

    return {
      ok: true,
      transferredAmount: transferAmount,
      sender: {
        actorUuid: senderActor.uuid,
        before: senderBefore,
        after: senderAfter
      },
      receiver: {
        actorUuid: receiverActor.uuid,
        before: receiverBefore,
        after: receiverAfter
      },
      requestedByUserId
    };
  }

  /**
   * Adjust Zenit for a single Actor by a delta.
   *
   * Payload:
   * {
   *   actorUuid:         string,
   *   delta:             number,  // + or -
   *   requestedByUserId?: string
   * }
   *
   * Returns:
   * {
   *   ok: boolean,
   *   reason?: string,
   *   actor: { actorUuid, before, after },
   *   deltaApplied?: number,
   *   requestedByUserId?: string
   * }
   */
  async function adjustActorZenit(payload) {
    if (!payload || typeof payload !== "object") {
      throw new Error("[ItemTransferCore] adjustActorZenit() requires a payload object.");
    }

    const { actorUuid, delta, requestedByUserId } = payload;

    console.log("[ItemTransferCore] adjustActorZenit called.", {
      actorUuid,
      delta,
      requestedByUserId
    });

    if (!actorUuid) {
      throw new Error("[ItemTransferCore] adjustActorZenit: Missing actorUuid.");
    }

    const nDelta = Number(delta);
    if (!Number.isFinite(nDelta) || nDelta === 0) {
      return {
        ok: false,
        reason: "delta_zero_or_invalid",
        actor: {
          actorUuid,
          before: null,
          after: null
        },
        requestedByUserId
      };
    }

    const actor  = await resolveActor(actorUuid, "actorUuid (Zenit)");
    const before = getActorZenit(actor);
    const after  = Math.max(0, Math.floor(before + nDelta));

    await actor.update(makeZenitUpdate(after));

    console.log("[ItemTransferCore] adjustActorZenit complete.", {
      actorUuid: actor.uuid,
      before,
      after,
      deltaApplied: after - before,
      requestedByUserId
    });

    return {
      ok: true,
      actor: {
        actorUuid: actor.uuid,
        before,
        after
      },
      deltaApplied: after - before,
      requestedByUserId
    };
  }

  /**
   * GM / system / template → Actor:
   *  - The source item is treated as a template (shop item, world item, etc.).
   *  - It is NOT modified.
   *  - On receiver, if a stackable item exists, increase quantity.
   *    Otherwise, create a new cloned item with the given quantity.
   */
  async function grantItemToActor(payload) {
    const {
      itemUuid,
      quantity,
      receiverActorUuid,
      requestedByUserId
    } = payload || {};

    console.log("[ItemTransferCore] grantItemToActor (gmToActor) called.", {
      itemUuid,
      quantity,
      receiverActorUuid,
      requestedByUserId
    });

    const templateItem = await resolveItem(itemUuid);
    const receiverActor = await resolveActor(receiverActorUuid, "receiverActorUuid");
    const grantQty = normalizeQuantity(quantity);

    // Try stacking first
    const stackTarget = findStackableItemOnActor(receiverActor, templateItem);
    let receiverItemUuid = null;
    let receiverNewQty = null;
    let createdParent = null;

    if (stackTarget) {
      const receiverCurrentQty = getItemQuantity(stackTarget);
      receiverNewQty = receiverCurrentQty + grantQty;
      await stackTarget.update(makeQuantityUpdate(receiverNewQty));

      receiverItemUuid = stackTarget.uuid;
      console.log("[ItemTransferCore] Increased receiver stackable item quantity (gmToActor).", {
        receiverActorUuid: receiverActor.uuid,
        itemUuid: receiverItemUuid,
        oldQty: receiverCurrentQty,
        addedQty: grantQty,
        newQty: receiverNewQty
      });
    } else {
      const itemData = templateItem.toObject();
      delete itemData._id;
      delete itemData.items; // CSB toObject() artifact — children are handled below
      itemData.system = itemData.system || {};
      itemData.system.props = itemData.system.props || {};
      itemData.system.props.item_quantity = grantQty;

      const created = await receiverActor.createEmbeddedDocuments("Item", [itemData]);
      createdParent = created[0];
      receiverItemUuid = createdParent.uuid;
      receiverNewQty = grantQty;

      console.log("[ItemTransferCore] Created new receiver item from template (gmToActor).", {
        receiverActorUuid: receiverActor.uuid,
        itemUuid: receiverItemUuid,
        qty: receiverNewQty
      });
    }

    // Carry the sub-item tree along. For gmToActor the source is a template
    // that is never consumed, so we only ever clone — nothing is deleted on
    // the source side. As in actorToActor, a stack target with no children at
    // all gets repaired rather than skipped.
    const childNodesToCopy = snapshotChildTree(templateItem);
    if (childNodesToCopy.length) {
      const target = createdParent
        ?? (stackTarget && !getSourceChildItems(stackTarget).length ? stackTarget : null);

      if (target) {
        const idMap = await cloneChildTreeToReceiver(
          childNodesToCopy, receiverActor, target, templateItem.id
        );
        console.log("[ItemTransferCore] Cloned sub-item tree from template to receiver.", {
          receiverActorUuid: receiverActor.uuid,
          parentUuid: target.uuid,
          repairedStack: !createdParent,
          count: childNodesToCopy.length,
          idMap
        });
      }
    }

        const result = {
      ok: true,
      mode: "gmToActor",
      receiver: {
        actorUuid: receiverActor.uuid,
        itemUuid: receiverItemUuid,
        quantityAfter: receiverNewQty
      },
      grantedQty: grantQty
    };

    // NEW: Transfer Card UI (receiver-only)
    const showTransferCard = payload?.showTransferCard !== false;
    if (showTransferCard) {
      emitTransferCardToRecipients({
        receiverActor,
        quantity: grantQty,
        itemName: templateItem.name,
        itemImg: templateItem.img,
        receiverItemUuid
      });
    }

    return result;
  }

  /**
   * Actor → GM / system:
   *  - The source item must be an embedded item of the sender actor.
   *  - Decrease quantity; delete if it reaches 0.
   *  - We do NOT create anything on GM side (treated as "going back to system").
   */
  async function removeItemFromActor(payload) {
    const {
      itemUuid,
      quantity,
      senderActorUuid,
      requestedByUserId
    } = payload || {};

    console.log("[ItemTransferCore] removeItemFromActor (actorToGm) called.", {
      itemUuid,
      quantity,
      senderActorUuid,
      requestedByUserId
    });

    const sourceItem = await resolveItem(itemUuid);

    // Determine sender actor like in transferActorToActor
    let senderActor = sourceItem.parent instanceof Actor ? sourceItem.parent : null;

    if (senderActorUuid) {
      const explicitSender = await resolveActor(senderActorUuid, "senderActorUuid");
      if (senderActor && explicitSender.id !== senderActor.id) {
        console.warn("[ItemTransferCore] Source item parent Actor does not match senderActorUuid. Using senderActorUuid.", {
          itemParentUuid: senderActor.uuid,
          senderActorUuid
        });
      }
      senderActor = explicitSender;
    }

    if (!senderActor) {
      throw new Error("[ItemTransferCore] removeItemFromActor: Could not determine sender actor from item parent or senderActorUuid.");
    }

    const requestedQty = normalizeQuantity(quantity);
    const senderCurrentQty = getItemQuantity(sourceItem);

    if (senderCurrentQty <= 0) {
      console.warn("[ItemTransferCore] Sender's item quantity is <= 0. Nothing to remove.", {
        senderCurrentQty,
        itemUuid
      });
      return {
        ok: false,
        reason: "sender_quantity_zero_or_negative",
        senderCurrentQty
      };
    }

    const removeQty = Math.min(requestedQty, senderCurrentQty);
    if (removeQty < requestedQty) {
      console.warn("[ItemTransferCore] Requested removal quantity larger than current stock. Clamping.", {
        requestedQty,
        senderCurrentQty,
        removeQty
      });
    }

    const senderRemaining = senderCurrentQty - removeQty;

    if (senderRemaining > 0) {
      await sourceItem.update(makeQuantityUpdate(senderRemaining));
      console.log("[ItemTransferCore] Updated sender item quantity (actorToGm).", {
        itemUuid: sourceItem.uuid,
        oldQty: senderCurrentQty,
        newQty: senderRemaining
      });
    } else {
      // Snapshot the tree before the parent's deletion breaks the
      // system.container linkage we use to find it.
      const childNodesToRemove = snapshotChildTree(sourceItem);
      await senderActor.deleteEmbeddedDocuments("Item", [sourceItem.id]);
      console.log("[ItemTransferCore] Deleted sender item (quantity reached 0) in actorToGm.", {
        actorUuid: senderActor.uuid,
        itemId: sourceItem.id
      });
      if (childNodesToRemove.length) {
        await deleteChildTreeFromSender(childNodesToRemove, senderActor);
        console.log("[ItemTransferCore] Deleted sender sub-items along with parent (actorToGm).", {
          actorUuid: senderActor.uuid,
          count: childNodesToRemove.length
        });
      }
    }

    return {
      ok: true,
      mode: "actorToGm",
      sender: {
        actorUuid: senderActor.uuid,
        remainingQty: Math.max(senderRemaining, 0)
      },
      removedQty: removeQty
    };
  }

  // --------------------------------------------------------------------------
  // Public dispatcher
  // --------------------------------------------------------------------------

  /**
   * Public entry point:
   *   await ItemTransferCore.transfer(payload)
   *
   * Decides which internal operation to run based on payload.mode.
   */
  async function transfer(payload) {
    if (!payload || typeof payload !== "object") {
      throw new Error("[ItemTransferCore] transfer() requires a payload object.");
    }

    const { mode } = payload;
    if (!mode) {
      throw new Error("[ItemTransferCore] transfer() payload is missing 'mode'.");
    }

    switch (mode) {
      case "actorToActor":
        return await transferActorToActor(payload);

      case "gmToActor":
        return await grantItemToActor(payload);

      case "actorToGm":
        return await removeItemFromActor(payload);

      default:
        throw new Error(`[ItemTransferCore] Unknown transfer mode: ${mode}`);
    }
  }

  // --------------------------------------------------------------------------
  // Install API
  // --------------------------------------------------------------------------

    window[KEY] = {
    // Item transfer API
    transfer,
    transferActorToActor,
    grantItemToActor,
    removeItemFromActor,

    // Sub-item (CSB container) primitive, for any copier outside this module
    copySubItemTree,

    // Zenit / currency API
    transferZenit: transferZenitBetweenActors,
    adjustZenit:  adjustActorZenit,
    getActorZenit
  };

  console.debug('[ItemTransferCore] Installed as window["oni.ItemTransferCore"].');
})();
