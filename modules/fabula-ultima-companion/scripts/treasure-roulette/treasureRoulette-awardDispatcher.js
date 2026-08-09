// ============================================================================
// [TreasureRoulette] AwardDispatcher • Foundry VTT v12
// ----------------------------------------------------------------------------
// Owns the ACT of awarding a locked roulette result to an Actor, plus a lean
// bookkeeping chat line.
//
// TWO ENTRY POINTS:
//
// 1. award({ packet, recipientActorUuid })  — the v2 path.
//    TR.Flow calls this directly once the player has chosen a recipient AFTER
//    the spin. No acks, no timers: the caller already knows the animation ended
//    (it awaited Net.waitBarrier) and already knows who the reward goes to.
//    Returns { ok, kind, receiverItemUuid } — receiverItemUuid is the GRANTED
//    instance on the recipient, which is what the equip step needs.
//
// 2. queue(packet) — the legacy path (award.mode: "grant").
//    Waits for every client's UI_FINISHED ack (or a timeout), then awards to the
//    recipient baked into the packet. Kept so the old macro entry point and any
//    non-tile caller keep working. Core does NOT queue in deferred mode.
//
// Socket channel: "module.fabula-ultima-companion"
// - ONI_TR_PLAY_UI      (from Core)    -> register a request packet
// - ONI_TR_UI_FINISHED  (from clients) -> ack that UI finished on that client
//
// Reward kinds:
// - "Item"        -> ItemTransferCore.transfer({ mode:"gmToActor", ... })
// - "Zenit"       -> ItemTransferCore.adjustZenit({ ... })
// - "ItemPoint"   -> direct actor update, clamped to max_ip (never to the DB actor)
// - "StatusEffect"-> StatusEffectCore if present
//
// Chat rule (v2): ONE lean line, bookkeeping only. The player-facing announcement
// is the on-screen reveal, not this.
//     Obtained  <icon> Blazing Sword  ›  Keren
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

  // Multi-GM dedupe. This game runs two GM clients in real sessions and every
  // raw-socket message lands on BOTH, so an ungated award writes the item twice.
  // Use the SHARED gate — the old local copy picked users.contents[0] (collection
  // order) while everything else picks game.users.activeGM (lowest id), so the two
  // could elect different hosts.
  const isGM = () => !!game.user?.isGM;
  const isPrimaryGM = () => globalThis.FUCompanion?.isPrimaryGM?.() ?? false;

  // requestId -> record (legacy queue path only)
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
  // Different sheet templates store IP at different paths; pick the first that
  // reads as a number.
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

  // --------------------------------------------------------------------------
  // Chat: header silencer + one lean card
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

        const header =
          root.querySelector?.(".message-header") ||
          root.querySelector?.("header") ||
          root.querySelector?.(".message-metadata") ||
          null;

        if (header) header.style.display = "none";

        const sender = root.querySelector?.(".message-sender");
        if (sender) sender.style.display = "none";

        if (root.style) root.style.paddingTop = "4px";
      } catch (e) {
        console.warn("[TreasureRoulette][AwardDispatcher] renderChatMessage hook failed:", e);
      }
    });

    console.debug("[TreasureRoulette][AwardDispatcher] Silent award chat hook installed.");
  }

  function buildItemIconHtml(itemImg, itemName) {
    return `
      <img src="${esc(itemImg)}" alt="${esc(itemName)}"
           loading="eager" decoding="async"
           style="width:22px;height:22px;object-fit:contain;border:none;box-shadow:none;outline:none;background:transparent;vertical-align:middle;">
    `.trim();
  }

  /**
   * The ONE award chat line. Bookkeeping only — the reveal overlay is what the
   * players actually watch.
   *
   *   Obtained  <icon> <b>Blazing Sword</b>  ›  <b>Keren</b>
   *
   * @param {string} rewardHtml    already-escaped inline HTML for the reward itself
   * @param {string} recipientName display name of the receiving actor / "Party Inventory"
   */
  async function postAwardCard({ rewardHtml, recipientName }) {
    try {
      ensureSilentAwardChatHookInstalled();

      const content = `
        <span style="display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;">
          <b>Obtained</b> ${rewardHtml}
          <span style="opacity:0.55;">&rsaquo;</span>
          <b>${esc(recipientName || "—")}</b>
        </span>
      `.trim();

      await ChatMessage.create({
        speaker: { alias: "" },
        content,
        flags: { [MODULE_ID]: { oniTreasureAward: true } }
      });
    } catch (e) {
      console.warn("[TreasureRoulette][AwardDispatcher] postAwardCard failed:", e);
    }
  }

  // --------------------------------------------------------------------------
  // Shared resolution helpers
  // --------------------------------------------------------------------------
  async function resolveDbActorUuid() {
    try {
      const api = window.FUCompanion?.api;
      if (api && typeof api.getCurrentGameDb === "function") {
        const { db, dbUuid } = await api.getCurrentGameDb();
        return db?.uuid ?? dbUuid ?? null;
      }
    } catch (e) {
      console.warn("[TreasureRoulette][AwardDispatcher] getCurrentGameDb failed:", e);
    }
    return null;
  }

  async function actorNameOf(actorUuid, fallback = "") {
    try {
      const a = actorUuid ? await fromUuid(actorUuid) : null;
      return a?.name ? a.name : fallback;
    } catch {
      return fallback;
    }
  }

  // --------------------------------------------------------------------------
  // PUBLIC: award()
  // The v2 entry point. Caller supplies the recipient chosen after the spin.
  // --------------------------------------------------------------------------
  /**
   * @param {object}  opts
   * @param {object}  opts.packet              locked Result Packet from Core
   * @param {string}  opts.recipientActorUuid  chosen recipient (DB actor = Party Inventory)
   * @param {boolean} [opts.postChat=true]     write the lean bookkeeping line
   * @param {boolean} [opts.showTransferCard=false]
   *        The v2 flow shows its own on-screen reveal, so the ItemTransfer card is
   *        redundant noise; legacy callers pass true.
   * @returns {Promise<{ok:boolean, kind:string, receiverItemUuid:string|null, reason?:string}>}
   */
  async function award({ packet, recipientActorUuid, postChat = true, showTransferCard = false } = {}) {
    const fail = (reason, kind = "") => {
      console.error("[TreasureRoulette][AwardDispatcher] award failed:", reason, { packet, recipientActorUuid });
      return { ok: false, kind, receiverItemUuid: null, reason };
    };

    if (!isGM()) return fail("non-GM client called award()");
    if (!isPrimaryGM()) return fail("secondary GM called award() — primary GM owns the write");

    const reward = packet?.reward;
    if (!reward) return fail("missing reward descriptor");

    const kind = String(reward.kind ?? "").toLowerCase();

    const itc = window["oni.ItemTransferCore"];
    if (!itc) return fail("missing window['oni.ItemTransferCore']", kind);

    const dbActorUuid = await resolveDbActorUuid();
    const isPartyInventory = !!(dbActorUuid && recipientActorUuid && recipientActorUuid === dbActorUuid);

    // IP can never live on the DB actor (game rule). Everything else requires a
    // recipient by this point — the flow's picker guarantees one.
    if (kind !== "itempoint" && !recipientActorUuid) return fail("missing recipientActorUuid", kind);
    if (kind === "itempoint" && isPartyInventory) return fail("IP cannot be stored on the Party Inventory actor", kind);

    const recipientName = isPartyInventory
      ? "Party Inventory"
      : await actorNameOf(recipientActorUuid, "—");

    console.log("[TreasureRoulette][AwardDispatcher] Awarding:", {
      requestId: packet?.requestId, kind, recipientActorUuid, isPartyInventory
    });

    // ---------------------------------------------------------------- Item ---
    if (kind === "item") {
      const itemUuid = reward.itemUuid;
      const quantity = Math.max(1, safeInt(reward.quantity ?? 1, 1));

      let res = null;
      try {
        res = await itc.transfer({
          mode: "gmToActor",
          itemUuid,
          quantity,
          receiverActorUuid: recipientActorUuid,
          requestedByUserId: packet?.roller?.userId ?? game.user?.id,
          showTransferCard
        });
      } catch (e) {
        return fail(`ItemTransferCore.transfer threw: ${e?.message ?? e}`, kind);
      }

      const display = {
        name: packet?.winner?.name ?? null,
        img: packet?.winner?.img ?? null
      };
      if (!display.name || !display.img) {
        try {
          const doc = await fromUuid(itemUuid);
          if (doc) {
            display.name = display.name ?? doc.name;
            display.img = display.img ?? doc.img;
          }
        } catch {}
      }

      if (postChat) {
        const qtyHtml = quantity > 1 ? ` <em>&times;${quantity}</em>` : "";
        await postAwardCard({
          rewardHtml: `${buildItemIconHtml(display.img ?? "icons/svg/chest.svg", display.name ?? "Item")} <b>${esc(display.name ?? "Item")}</b>${qtyHtml}`,
          recipientName
        });
      }

      return {
        ok: true,
        kind,
        receiverItemUuid: res?.receiver?.itemUuid ?? null
      };
    }

    // --------------------------------------------------------------- Zenit ---
    if (kind === "zenit") {
      const amount = safeInt(reward.amount ?? reward.quantity ?? 0, 0);
      if (amount <= 0) return fail("zenit amount <= 0", kind);

      try {
        await itc.adjustZenit({
          actorUuid: recipientActorUuid,
          delta: amount,
          requestedByUserId: packet?.roller?.userId ?? game.user?.id
        });
      } catch (e) {
        return fail(`adjustZenit threw: ${e?.message ?? e}`, kind);
      }

      if (postChat) {
        const img = packet?.winner?.img ?? "icons/svg/coins.svg";
        await postAwardCard({
          rewardHtml: `${buildItemIconHtml(img, "Zenit")} <b>${esc(amount)}</b> Zenit`,
          recipientName
        });
      }

      return { ok: true, kind, receiverItemUuid: null };
    }

    // ----------------------------------------------------------- ItemPoint ---
    if (kind === "itempoint") {
      const fillToMax = !!reward.fillToMax;
      const rolled = safeInt(reward.amount ?? 0, 0);
      const img = packet?.winner?.img ?? "icons/svg/daze.svg";

      let actor = null;
      try { actor = await fromUuid(recipientActorUuid); } catch {}
      if (!actor) return fail("ItemPoint recipient actor not found", kind);

      const { cur: curRef, max: maxRef } = resolveIpPaths(actor);
      const cur = safeInt(curRef.value ?? 0, 0);
      const max = Math.max(0, safeInt(maxRef.value ?? 0, 0));

      if (max <= 0) return fail("IP max not found or 0 — cannot apply IP", kind);

      const newCur = fillToMax ? max : clamp(cur + Math.max(0, rolled), 0, max);
      const deltaApplied = Math.max(0, newCur - cur);

      try {
        await actor.update({ [curRef.path]: newCur });
      } catch (e) {
        return fail(`IP update threw: ${e?.message ?? e}`, kind);
      }

      if (postChat) {
        await postAwardCard({
          rewardHtml: `${buildItemIconHtml(img, "Inventory Points")} <b>+${esc(deltaApplied)}</b> IP`,
          recipientName
        });
      }

      return { ok: true, kind, receiverItemUuid: null, ipApplied: deltaApplied };
    }

    // -------------------------------------------------------- StatusEffect ---
    if (kind === "statuseffect") {
      const sec = window["oni.TreasureRoulette.StatusEffectCore"];
      if (!sec || typeof sec.apply !== "function") return fail("StatusEffectCore missing", kind);

      await sec.apply({
        recipientActorUuid,
        effect: reward.effect ?? null,
        requestedByUserId: packet?.roller?.userId ?? game.user?.id
      });

      return { ok: true, kind, receiverItemUuid: null };
    }

    return fail(`unknown reward.kind "${kind}"`, kind);
  }

  // --------------------------------------------------------------------------
  // LEGACY queue path (award.mode: "grant")
  // --------------------------------------------------------------------------
  function getSpinMs(packet) {
    const a = safeInt(packet?.spinMs, 0);
    const b = safeInt(packet?.ui?.spinMs, 0);
    return clamp(Math.max(a, b, 0), 0, 600000);
  }

  function getExpectedAcks(packet) {
    const ids = packet?.audience?.expectedAcks;
    if (Array.isArray(ids) && ids.length) return ids.slice();
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
    const timeoutMs = clamp(spinMs + 2000, 2500, 650000);

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

  // Legacy: recipient comes from the packet, with a DB-actor fallback for
  // everything except IP.
  async function doAward(rec, reason) {
    const packet = rec.packet;

    if (!isGM()) {
      console.warn("[TreasureRoulette][AwardDispatcher] Non-GM client reached award stage; skipping.", {
        requestId: rec.requestId, reason
      });
      return;
    }
    if (!isPrimaryGM()) {
      console.warn("[TreasureRoulette][AwardDispatcher] Secondary GM reached award stage; skipping.", {
        requestId: rec.requestId, reason, localUserId: game.user?.id ?? null
      });
      return;
    }

    const kind = String(packet?.reward?.kind ?? "").toLowerCase();
    let recipientActorUuid = packet?.recipient?.actorUuid ?? null;

    if (!recipientActorUuid && kind !== "itempoint") {
      const dbActorUuid = await resolveDbActorUuid();
      if (dbActorUuid) {
        recipientActorUuid = dbActorUuid;
        console.warn("[TreasureRoulette][AwardDispatcher] recipient missing; falling back to Database Actor:", dbActorUuid);
      }
    }

    await award({ packet, recipientActorUuid, postChat: true, showTransferCard: true });
  }

  async function tryFinalize(requestId, reason) {
    const rec = _records.get(requestId);
    if (!rec) return;
    if (rec.awarded) return;

    const ready = reason === "timeout" ? true : allAcked(rec);
    if (!ready) return;

    rec.awarded = true;

    try { clearTimeout(rec.timer); } catch {}

    let awardOk = false;

    try {
      await doAward(rec, reason);
      awardOk = true;
    } catch (e) {
      console.error("[TreasureRoulette][AwardDispatcher] Award failed:", e);
    } finally {
      if (awardOk) {
        for (const hook of ["TR:COMPLETED", "oni.TR:COMPLETED"]) {
          try {
            Hooks.callAll(hook, { requestId, packet: rec.packet, reason });
          } catch (e) {
            console.warn(`[TreasureRoulette][AwardDispatcher] Hooks.callAll(${hook}) failed:`, e);
          }
        }
      }

      setTimeout(() => { _records.delete(requestId); }, 2000);
    }
  }

  // --------------------------------------------------------------------------
  // Socket listeners
  // --------------------------------------------------------------------------
  function installSocketListener() {
    if (!game?.socket) return;

    const guardKey = "oni._treasureRouletteAwardDispatcherSocketInstalled";
    if (window[guardKey]) return;
    window[guardKey] = true;

    game.socket.on(SOCKET_CHANNEL, async (msg) => {
      try {
        if (!msg || !msg.type) return;

        // Only the legacy grant path keeps records. Deferred packets are owned by
        // TR.Flow, which never queues here.
        if (msg.type === MSG_TR_PLAY_UI) {
          const packet = msg.payload;
          if (packet?.awardMode === "deferred") return;
          ensureRecord(packet);
          return;
        }

        if (msg.type === MSG_TR_UI_FINISHED) {
          const ack = msg.payload;
          const requestId = ack?.requestId;
          const userId = ack?.userId;
          if (!requestId) return;

          // Ack for a deferred (flow-owned) request — nothing to finalize here.
          if (!_records.has(requestId)) return;

          markFinished(requestId, userId);
          return;
        }
      } catch (e) {
        console.error("[TreasureRoulette][AwardDispatcher] Socket handler error:", e);
      }
    });

    console.debug("[TreasureRoulette][AwardDispatcher] Socket listener installed on:", SOCKET_CHANNEL);
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------
  function queue(packet) {
    if (packet?.awardMode === "deferred") {
      console.debug("[TreasureRoulette][AwardDispatcher] queue() ignored for deferred packet:", packet?.requestId);
      return null;
    }
    return ensureRecord(packet);
  }

  window[KEY] = {
    queue,
    award,
    postAwardCard,
    _records
  };

  ensureSilentAwardChatHookInstalled();
  installSocketListener();

  console.log(
    `[TreasureRoulette][AwardDispatcher] Installed as window["${KEY}"]. ` +
    `GM=${isGM()} primaryGM=${isPrimaryGM()}`
  );
});
