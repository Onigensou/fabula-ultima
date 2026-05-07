// ============================================================================
// [TreasureRoulette] AwardDispatcher • Foundry VTT v12
// ----------------------------------------------------------------------------
// Purpose:
// - Wait until TreasureRoulette UI is finished (multi-client)
// - Then award the locked result to the recipient Actor
// - ALSO print a loot ChatMessage (DEMO-style)
//
// Socket channel: "module.fabula-ultima-companion"
// Messages:
// - ONI_TR_PLAY_UI       (from Core)    -> used to register a request packet
// - ONI_TR_UI_FINISHED   (from clients) -> ack that UI finished on that client
//
// Award logic:
// - reward.kind === "Item"  -> ItemTransferCore.transfer({ mode:"gmToActor", ... })
// - reward.kind === "Zenit" -> ItemTransferCore.adjustZenit({ ... })
// - reward.kind === "StatusEffect" -> calls StatusEffectCore if present
//
// Chat print rule:
// - Normal recipient: "<RecipientName> received <qty> <icon> <itemName>"
// - Party Inventory (Database Actor):
//     "Obtained <qty> <icon> <itemName>"
//     (faded italic) "Moving to Party Inventory"
//
// Additionally: hide the grey "speaker" header line for these messages.
// ============================================================================

Hooks.once("ready", () => {
  const KEY = "oni.TreasureRoulette.AwardDispatcher";
  if (window[KEY]) {
    console.warn(`[TreasureRoulette][AwardDispatcher] Already installed as window["${KEY}"].`);
    return;
  }

  const MODULE_ID = "fabula-ultima-companion";
  const SOCKET_CHANNEL = `module.${MODULE_ID}`;
  const MSG_TR_PLAY_UI = "ONI_TR_PLAY_UI";
  const MSG_TR_UI_FINISHED = "ONI_TR_UI_FINISHED";

  // Only one elected GM client should actually award.
  // Players can still install the listener harmlessly.
  const isGM = () => !!game.user?.isGM;

  function getPrimaryActiveGM() {
    const gms = (game.users?.contents ?? []).filter((u) => u?.isGM && u?.active);
    return gms[0] ?? null;
  }

  function isPrimaryActiveGM() {
    const gm = getPrimaryActiveGM();
    return !!gm && game.user?.id === gm.id;
  }

  // requestId -> record
  const _records = new Map();

  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const safeInt = (v, fallback = 0) => {
    const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(/[^\d.-]/g, ""));
    return Number.isFinite(n) ? Math.floor(n) : fallback;
  };

  const esc = (v) =>
    String(v ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  // --------------------------------------------------------------------------
  // IP (Inventory Points) path resolver
  // Your sheet shows IP, but different systems/templates may store it differently.
  // We try a few known candidates and pick the first numeric one.
  // --------------------------------------------------------------------------
  function getFirstNumericProp(actor, candidates, fallback = 0) {
    const utils = foundry?.utils;
    for (const path of candidates) {
      try {
        const v = utils?.getProperty ? utils.getProperty(actor, path) : undefined;
        const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(/[^\d.-]/g, ""));
        if (Number.isFinite(n)) {
          return { path, value: Math.floor(n), found: true };
        }
      } catch {}
    }
    return { path: candidates?.[0] ?? null, value: fallback, found: false };
  }

  function resolveIpPaths(actor) {
    // Most likely based on what you told me: system.actor.props.current_ip / max_ip
    // But we also support common alternates used by some templates.
    const curCandidates = [
      "system.actor.props.current_ip",
      "system.props.current_ip",
      "system.actor.props.ip",
      "system.props.ip"
    ];

    const maxCandidates = [
      "system.actor.props.max_ip",
      "system.props.max_ip",
      "system.actor.props.ip_max",
      "system.props.ip_max"
    ];

    const cur = getFirstNumericProp(actor, curCandidates, 0);
    const max = getFirstNumericProp(actor, maxCandidates, 0);

    return { cur, max };
  }

  function getSpinMs(packet) {
    const a = safeInt(packet?.spinMs, 0);
    const b = safeInt(packet?.ui?.spinMs, 0);
    return clamp(Math.max(a, b, 0), 0, 600000);
  }

  function getExpectedAcks(packet) {
    const ids = packet?.audience?.expectedAcks;
    if (Array.isArray(ids) && ids.length) return ids.slice();
    // fallback: at least wait for the roller client (or GM)
    if (packet?.roller?.userId) return [packet.roller.userId];
    return [game.user?.id].filter(Boolean);
  }

  function ensureRecord(packet) {
    if (!packet?.requestId) return null;

    const id = packet.requestId;
    if (_records.has(id)) return _records.get(id);

    const expected = new Set(getExpectedAcks(packet));
    const finished = new Set();

    const spinMs = getSpinMs(packet);
    const timeoutMs = clamp(spinMs + 2000, 2500, 650000); // spin + buffer

    const rec = {
      requestId: id,
      packet,
      expected,
      finished,
      createdAt: Date.now(),
      timeoutMs,
      timer: null,
      awarded: false
    };

    // Timeout failsafe: if someone never acks, we still award
    rec.timer = setTimeout(() => {
      tryFinalize(id, "timeout");
    }, timeoutMs);

    _records.set(id, rec);

    console.log("[TreasureRoulette][AwardDispatcher] Queued request:", {
      requestId: id,
      expectedAcks: Array.from(expected),
      timeoutMs
    });

    return rec;
  }

  function markFinished(requestId, userId) {
    const rec = _records.get(requestId);
    if (!rec) return;

    if (userId) rec.finished.add(userId);

    console.log("[TreasureRoulette][AwardDispatcher] UI finished ack:", {
      requestId,
      userId,
      finishedNow: Array.from(rec.finished),
      expectedAcks: Array.from(rec.expected)
    });

    tryFinalize(requestId, "allAcked");
  }

  function allAcked(rec) {
    for (const uid of rec.expected) {
      if (!rec.finished.has(uid)) return false;
    }
    return true;
  }

  // --------------------------------------------------------------------------
  // Chat message header silencer
  // - We tag our messages with a flag
  // - Each client hides the header when it renders
  // --------------------------------------------------------------------------
  function ensureSilentAwardChatHookInstalled() {
    const guardKey = "oni._treasureRouletteSilentAwardChatHookInstalled";
    if (window[guardKey]) return;
    window[guardKey] = true;

    Hooks.on("renderChatMessage", (message, html) => {
      try {
        if (!message) return;

        const isAward = !!message.getFlag(MODULE_ID, "oniTreasureAward");
        if (!isAward) return;

        const root = html?.[0] ?? html;
        if (!root) return;

        // Hide header areas if they exist (Foundry templates vary slightly)
        const header =
          root.querySelector?.(".message-header") ||
          root.querySelector?.("header") ||
          root.querySelector?.(".message-metadata") ||
          null;

        if (header) header.style.display = "none";

        const sender = root.querySelector?.(".message-sender");
        if (sender) sender.style.display = "none";

        // Also reduce top padding if header is gone
        if (root.style) {
          root.style.paddingTop = "4px";
        }
      } catch (e) {
        console.warn("[TreasureRoulette][AwardDispatcher] renderChatMessage hook failed:", e);
      }
    });

    console.log("[TreasureRoulette][AwardDispatcher] Silent award chat hook installed.");
  }

  function buildItemIconHtml(itemImg, itemName) {
    return `
      <img src="${esc(itemImg)}" alt="${esc(itemName)}"
           loading="eager" decoding="async"
           style="width:22px;height:22px;object-fit:contain;border:none;box-shadow:none;outline:none;background:transparent;vertical-align:middle;">
    `.trim();
  }

  function buildItemLinkHtml({ itemUuid, itemImg, itemName }) {
    const iconHtml = buildItemIconHtml(itemImg, itemName);

    if (itemUuid) {
      return `
        <a class="content-link" data-uuid="${esc(itemUuid)}"
           style="text-decoration:none;display:inline-flex;align-items:center;gap:6px;">
          ${iconHtml}
          <b>${esc(itemName)}</b>
        </a>
      `.trim();
    }

    return `
      <span style="display:inline-flex;align-items:center;gap:6px;">
        ${iconHtml}
        <b>${esc(itemName)}</b>
      </span>
    `.trim();
  }

  async function postAwardChatItem({ recipientActorUuid, isPartyInventory, quantity, display }) {
    try {
      ensureSilentAwardChatHookInstalled();

      const qty = Math.max(1, safeInt(quantity ?? 1, 1));

      const itemName = String(display?.name ?? "Unknown");
      const itemImg = String(display?.img ?? "icons/svg/chest.svg");
      const itemUuid = display?.uuid ? String(display.uuid) : null;

      const itemHtml = buildItemLinkHtml({ itemUuid, itemImg, itemName });

      let content = "";

      if (isPartyInventory) {
        content = `
          <div style="display:flex;flex-direction:column;gap:4px;">
            <span style="display:inline-flex;align-items:center;gap:6px;">
              <b>Obtained</b> ${qty} ${itemHtml}
            </span>
            <span style="opacity:0.55;font-size:12px;"><i>Moving to Party Inventory</i></span>
          </div>
        `.trim();
      } else {
        let recipientName = "";
        try {
          const a = recipientActorUuid ? await fromUuid(recipientActorUuid) : null;
          recipientName = a?.name ? a.name : "";
        } catch {}

        content = `
          <span style="display:inline-flex;align-items:center;gap:6px;">
            <b>${esc(recipientName)}</b> received ${qty} ${itemHtml}
          </span>
        `.trim();
      }

      // Speaker: keep it blank; header is also hidden by hook.
      await ChatMessage.create({
        speaker: { alias: "" },
        content,
        flags: {
          [MODULE_ID]: {
            oniTreasureAward: true
          }
        }
      });
    } catch (e) {
      console.warn("[TreasureRoulette][AwardDispatcher] postAwardChatItem failed:", e);
    }
  }

  async function postAwardChatZenit({ recipientActorUuid, isPartyInventory, amount, display }) {
    try {
      ensureSilentAwardChatHookInstalled();

      const amt = safeInt(amount ?? 0, 0);
      if (amt <= 0) return;

      const zenitName = String(display?.name ?? "Zenit");
      const zenitImg = String(display?.img ?? "icons/svg/coins.svg");

      // Use the same icon styling as items (no border/outline/black square).
      const iconHtml = buildItemIconHtml(zenitImg, zenitName);

      let content = "";

      if (isPartyInventory) {
        // "Obtained <icon>X Zenit" + fading line (same as item fallback)
        content = `
          <div style="display:flex;flex-direction:column;gap:4px;">
            <span style="display:inline-flex;align-items:center;gap:6px;">
              <b>Obtained</b> ${iconHtml} <b>${esc(amt)}</b> Zenit
            </span>
            <span style="opacity:0.55;font-size:12px;"><i>Moving to Party Inventory</i></span>
          </div>
        `.trim();
      } else {
        let recipientName = "";
        try {
          const a = recipientActorUuid ? await fromUuid(recipientActorUuid) : null;
          recipientName = a?.name ? a.name : "";
        } catch {}

        // "<Actor name> received <zenit icon> X Zenit"
        content = `
          <span style="display:inline-flex;align-items:center;gap:6px;">
            <b>${esc(recipientName)}</b> received ${iconHtml} <b>${esc(amt)}</b> Zenit
          </span>
        `.trim();
      }

      await ChatMessage.create({
        speaker: { alias: "" },
        content,
        flags: {
          [MODULE_ID]: {
            oniTreasureAward: true
          }
        }
      });
    } catch (e) {
      console.warn("[TreasureRoulette][AwardDispatcher] postAwardChatZenit failed:", e);
    }
  }

  async function postAwardChatIP({ recipientActorUuid, hasRecipient, ipDelta, display, warnNoRecipient }) {
    try {
      ensureSilentAwardChatHookInstalled();

      const delta = safeInt(ipDelta ?? 0, 0);

      const rowName = String(display?.name ?? "Inventory Points");
      const rowImg = String(display?.img ?? "icons/svg/daze.svg");

      const iconHtml = buildItemIconHtml(rowImg, rowName);

      let recipientName = "";
      if (hasRecipient) {
        try {
          const a = recipientActorUuid ? await fromUuid(recipientActorUuid) : null;
          recipientName = a?.name ? a.name : "";
        } catch {}
      }

      let content = "";

      if (!hasRecipient) {
        content = `
          <div style="display:flex;flex-direction:column;gap:4px;">
            <span style="display:inline-flex;align-items:center;gap:6px;">
              <b>Obtained</b> ${iconHtml} <b>+${esc(delta)}</b> IP
            </span>
            <span style="opacity:0.55;font-size:12px;"><i>${esc(warnNoRecipient ? "No Recipient" : "")}</i></span>
            <span style="opacity:0.7;font-size:12px;"><i>${esc(rowName)}</i></span>
          </div>
        `.trim();
      } else {
        content = `
          <div style="display:flex;flex-direction:column;gap:4px;">
            <span style="display:inline-flex;align-items:center;gap:6px;">
              <b>${esc(recipientName)}</b> received ${iconHtml} <b>+${esc(delta)}</b> IP
            </span>
            <span style="opacity:0.7;font-size:12px;"><i>${esc(rowName)}</i></span>
          </div>
        `.trim();
      }

      await ChatMessage.create({
        speaker: { alias: "" },
        content,
        flags: {
          [MODULE_ID]: {
            oniTreasureAward: true
          }
        }
      });
    } catch (e) {
      console.warn("[TreasureRoulette][AwardDispatcher] postAwardChatIP failed:", e);
    }
  }

  async function doAward(rec, reason) {
    const packet = rec.packet;

    if (!isGM()) {
      console.warn("[TreasureRoulette][AwardDispatcher] Non-GM client reached award stage; skipping.", {
        requestId: rec.requestId,
        reason
      });
      return;
    }

    if (!isPrimaryActiveGM()) {
      console.warn("[TreasureRoulette][AwardDispatcher] Secondary GM reached award stage; skipping.", {
        requestId: rec.requestId,
        reason,
        localUserId: game.user?.id ?? null,
        primaryGmUserId: getPrimaryActiveGM()?.id ?? null
      });
      return;
    }

    // Guard: ItemTransferCore must exist
    const itc = window["oni.ItemTransferCore"];
    if (!itc) {
      console.error("[TreasureRoulette][AwardDispatcher] Missing window['oni.ItemTransferCore'].");
      return;
    }

    const reward = packet?.reward;
    const kind = String(reward?.kind ?? "").toLowerCase();

    // Resolve DB actor UUID (Party Inventory) once, and use it for:
    // - fallback recipient (ONLY for Item/Zenit/etc.)
    // - Party Inventory chat formatting rule
    let dbActorUuid = null;
    try {
      const api = window.FUCompanion?.api;
      if (api && typeof api.getCurrentGameDb === "function") {
        const { db, dbUuid } = await api.getCurrentGameDb();
        dbActorUuid = db?.uuid ?? dbUuid ?? null;
      }
    } catch (e) {
      console.warn("[TreasureRoulette][AwardDispatcher] getCurrentGameDb failed:", e);
    }

    let recipientActorUuid = packet?.recipient?.actorUuid ?? null;

    // Fallback recipient if missing (Database Actor)
    // IMPORTANT: For IP (ItemPoint), DO NOT fallback to DB Actor. Game rule: no IP storage in DB.
    if (!recipientActorUuid && dbActorUuid && kind !== "itempoint") {
      recipientActorUuid = dbActorUuid;
      console.warn("[TreasureRoulette][AwardDispatcher] recipient missing; falling back to Database Actor:", dbActorUuid);
    }

    if (!reward) {
      console.error("[TreasureRoulette][AwardDispatcher] Missing reward.", { reward });
      return;
    }

    // For non-IP rewards we still require a recipient after fallback.
    if (kind !== "itempoint" && !recipientActorUuid) {
      console.error("[TreasureRoulette][AwardDispatcher] Missing recipientActorUuid.", {
        reward,
        recipientActorUuid
      });
      return;
    }

    const isPartyInventory = !!(dbActorUuid && recipientActorUuid && recipientActorUuid === dbActorUuid);

    console.log("[TreasureRoulette][AwardDispatcher] Awarding now:", {
      requestId: rec.requestId,
      reason,
      reward,
      recipientActorUuid,
      isPartyInventory
    });

    // ----------------------------
    // Reward kinds
    // ----------------------------

    if (kind === "item") {
      const itemUuid = reward.itemUuid;
      const quantity = safeInt(reward.quantity ?? 1, 1);

      // GM → Actor grant (clones template item, shows transfer card to owners)
      await itc.transfer({
        mode: "gmToActor",
        itemUuid,
        quantity,
        receiverActorUuid: recipientActorUuid,
        requestedByUserId: packet?.roller?.userId ?? game.user?.id,
        showTransferCard: true
      });

      // Build display from locked winner (best match to roulette visuals)
      const display = {
        name: packet?.winner?.name ?? null,
        img: packet?.winner?.img ?? null,
        uuid: packet?.winner?.uuid ?? itemUuid ?? null
      };

      // If winner fields missing, resolve the item for name/img
      if (!display.name || !display.img) {
        try {
          const doc = await fromUuid(itemUuid);
          if (doc) {
            display.name = display.name ?? doc.name;
            display.img = display.img ?? doc.img;
            display.uuid = display.uuid ?? doc.uuid;
          }
        } catch {}
      }

      await postAwardChatItem({
        recipientActorUuid,
        isPartyInventory,
        quantity,
        display
      });

      return;
    }

    if (kind === "zenit") {
      const amount = safeInt(reward.amount ?? reward.quantity ?? 0, 0);
      if (amount <= 0) {
        console.warn("[TreasureRoulette][AwardDispatcher] Zenit reward amount <= 0; skipping.", { reward });
        return;
      }

      // Uses your ItemTransferCore Zenit API
      await itc.adjustZenit({
        actorUuid: recipientActorUuid,
        delta: amount,
        requestedByUserId: packet?.roller?.userId ?? game.user?.id
      });

      // Mirror Item chat-card timing/formatting, but for Zenit:
      // - Normal: "<Actor> received <icon> X Zenit"
      // - Party Inventory (DB Actor): "Obtained <icon> X Zenit" + "Moving to Party Inventory"
      // Icon source: same as the rolltable winner row (packet.winner.img)
      const display = {
        name: packet?.winner?.name ?? "Zenit",
        img: packet?.winner?.img ?? "icons/svg/coins.svg"
      };

      await postAwardChatZenit({
        recipientActorUuid,
        isPartyInventory,
        amount,
        display
      });

      return;
    }

    if (kind === "itempoint") {
      // "ItemPoint" in your system = Inventory Points (IP)
      // Data lives at:
      // - current: actor.system.actor.props.current_ip
      // - max:     actor.system.actor.props.max_ip
      //
      // Rules:
      // - Add IP but do not exceed max
      // - If reward.fillToMax === true, set current_ip to max_ip
      // - If NO recipient provided: do NOT update any actor. Only print chat + warning.

      const fillToMax = !!reward.fillToMax;
      const rolled = safeInt(reward.amount ?? 0, 0);

      // Winner display is the flavor text row (Result Type = Text)
      const display = {
        name: packet?.winner?.name ?? "Inventory Points",
        img: packet?.winner?.img ?? "icons/svg/daze.svg"
      };

      // No recipient: chat only + warn
      if (!recipientActorUuid) {
        await postAwardChatIP({
          recipientActorUuid: null,
          hasRecipient: false,
          ipDelta: 0,
          display,
          warnNoRecipient: true
        });
        return;
      }

      // Resolve actor
      let actor = null;
      try {
        actor = await fromUuid(recipientActorUuid);
      } catch {}
      if (!actor) {
        console.warn("[TreasureRoulette][AwardDispatcher] ItemPoint recipient actor not found; chat only.", {
          recipientActorUuid
        });

        await postAwardChatIP({
          recipientActorUuid,
          hasRecipient: false,
          ipDelta: 0,
          display,
          warnNoRecipient: true
        });
        return;
      }

      // Read current/max using resolved paths (supports different sheet templates)
      const { cur: curRef, max: maxRef } = resolveIpPaths(actor);

      const cur = safeInt(curRef.value ?? 0, 0);
      const max = Math.max(0, safeInt(maxRef.value ?? 0, 0));

      // If max is still 0, we can't apply IP safely (avoid awarding +0 silently)
      if (max <= 0) {
        console.warn("[TreasureRoulette][AwardDispatcher] IP max not found or is 0; cannot apply IP.", {
          recipientActorUuid,
          curRef,
          maxRef,
          actorUuid: actor?.uuid
        });

        await postAwardChatIP({
          recipientActorUuid,
          hasRecipient: true,
          ipDelta: 0,
          display,
          warnNoRecipient: true
        });
        return;
      }

      let newCur = cur;
      if (fillToMax) {
        newCur = clamp(max, 0, max);
      } else {
        const add = Math.max(0, rolled);
        newCur = clamp(cur + add, 0, max);
      }

      const deltaApplied = Math.max(0, newCur - cur);

      // Update actor at the resolved current_ip path
      try {
        await actor.update({
          [curRef.path]: newCur
        });
      } catch (e) {
        console.warn("[TreasureRoulette][AwardDispatcher] Failed to update IP; chat only.", e);

        await postAwardChatIP({
          recipientActorUuid,
          hasRecipient: true,
          ipDelta: 0,
          display,
          warnNoRecipient: true
        });
        return;
      }

      // Chat card (Zenit-style) shows the actual applied delta (clamped)
      await postAwardChatIP({
        recipientActorUuid,
        hasRecipient: true,
        ipDelta: deltaApplied,
        display,
        warnNoRecipient: false
      });

      return;
    }

    if (kind === "statuseffect") {
      // Future: apply Active Effects / conditions here
      const sec = window["oni.TreasureRoulette.StatusEffectCore"];
      if (!sec || typeof sec.apply !== "function") {
        console.warn("[TreasureRoulette][AwardDispatcher] StatusEffectCore missing. Reward not applied.", { reward });
        return;
      }

      await sec.apply({
        recipientActorUuid,
        effect: reward.effect ?? null,
        requestedByUserId: packet?.roller?.userId ?? game.user?.id
      });

      return;
    }

    console.warn("[TreasureRoulette][AwardDispatcher] Unknown reward.kind; nothing awarded.", { reward });
  }

  async function tryFinalize(requestId, reason) {
    const rec = _records.get(requestId);
    if (!rec) return;

    if (rec.awarded) return;

    const ready = reason === "timeout" ? true : allAcked(rec);
    if (!ready) return;

    rec.awarded = true;

    try {
      clearTimeout(rec.timer);
    } catch {}

    let awardOk = false;

    try {
      await doAward(rec, reason);
      awardOk = true;
    } catch (e) {
      console.error("[TreasureRoulette][AwardDispatcher] Award failed:", e);
    } finally {
      // Signal completion for front-ends (Tiles, etc.)
      // We emit on BOTH names for backward compatibility.
      if (awardOk) {
        try {
          Hooks.callAll("TR:COMPLETED", { requestId, packet: rec.packet, reason });
        } catch (e) {
          console.warn("[TreasureRoulette][AwardDispatcher] Hooks.callAll(TR:COMPLETED) failed:", e);
        }
        try {
          Hooks.callAll("oni.TR:COMPLETED", { requestId, packet: rec.packet, reason });
        } catch (e) {
          console.warn("[TreasureRoulette][AwardDispatcher] Hooks.callAll(oni.TR:COMPLETED) failed:", e);
        }
      }

      // cleanup record after a short delay (keeps logs readable)
      setTimeout(() => {
        _records.delete(requestId);
      }, 2000);
    }
  }

  // ----------------------------
  // Socket listeners
  // ----------------------------
  function installSocketListener() {
    if (!game?.socket) return;

    const guardKey = "oni._treasureRouletteAwardDispatcherSocketInstalled";
    if (window[guardKey]) return;
    window[guardKey] = true;

    game.socket.on(SOCKET_CHANNEL, async (msg) => {
      try {
        if (!msg || !msg.type) return;

        // Register packet so dispatcher knows expectedAcks + reward info
        if (msg.type === MSG_TR_PLAY_UI) {
          const packet = msg.payload;
          ensureRecord(packet);
          return;
        }

        // UI finished ack
        if (msg.type === MSG_TR_UI_FINISHED) {
          const ack = msg.payload;
          const requestId = ack?.requestId;
          const userId = ack?.userId;
          if (!requestId) return;

          // If ack arrives before we saw the packet, try to recover from Core memory
          if (!_records.has(requestId)) {
            const core = window["oni.TreasureRoulette.Core"];
            const lastPacket =
              core?._requests && core._requests instanceof Map
                ? Array.from(core._requests.values()).find((r) => r?.packet?.requestId === requestId)?.packet
                : null;

            if (lastPacket) ensureRecord(lastPacket);
          }

          markFinished(requestId, userId);
          return;
        }
      } catch (e) {
        console.error("[TreasureRoulette][AwardDispatcher] Socket handler error:", e);
      }
    });

    console.log("[TreasureRoulette][AwardDispatcher] Socket listener installed on:", SOCKET_CHANNEL);
  }

  // ----------------------------
  // Public API
  // ----------------------------
  function queue(packet) {
    return ensureRecord(packet);
  }

  window[KEY] = {
    queue
  };

  // Install hook on ALL clients (so header is hidden everywhere),
  // even though only GM awards.
  ensureSilentAwardChatHookInstalled();

  installSocketListener();

  console.log(
    `[TreasureRoulette][AwardDispatcher] Installed as window["${KEY}"]. ` +
    `GM=${isGM()} primaryGM=${isPrimaryActiveGM()} primaryGMUserId=${getPrimaryActiveGM()?.id ?? "none"}`
  );
});