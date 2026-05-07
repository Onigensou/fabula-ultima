// ============================================================================
// [TreasureRoulette] Core • Foundry VTT v12
// ----------------------------------------------------------------------------
// Backend engine:
// - Validates request payload
// - Resolves RollTable
// - Authority rolls (or draws if consumeResults=true)
// - Builds display pool
// - Locks winner
// - Builds Result Packet
// - Broadcasts Result Packet to audience via socket
//
// NO UI here.
// NO awarding here.
// ============================================================================

(() => {
  const KEY = "oni.TreasureRoulette.Core";

  // Avoid double-install
  if (window[KEY]) {
    console.warn(`[TreasureRoulette][Core] Already installed as window["${KEY}"].`);
    return;
  }

  // --------------------------------------------------------------------------
  // Socket wiring (same channel style as ItemTransferCore)
  // --------------------------------------------------------------------------
  const SOCKET_CHANNEL = "module.fabula-ultima-companion";

  const MSG_TR_REQUEST = "ONI_TR_REQUEST";     // FrontEnd/Client -> Authority
  const MSG_TR_PLAY_UI = "ONI_TR_PLAY_UI";     // Authority -> Audience (locked packet)

  // --------------------------------------------------------------------------
  // In-memory state for idempotency / debug (AwardDispatcher will expand later)
  // --------------------------------------------------------------------------
  const _requests = new Map(); // requestId -> { state, packet, createdAt }

  // --------------------------------------------------------------------------
  // Helpers: safe number parsing
  // --------------------------------------------------------------------------
  const safeNum = (v, fallback = 0) => {
    const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(/[^\d.-]/g, ""));
    return Number.isFinite(n) ? n : fallback;
  };
  const safeInt = (v, fallback = 0) => Math.floor(safeNum(v, fallback));
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

  // --------------------------------------------------------------------------
  // Helpers: default request shape (based on your design doc)
  // --------------------------------------------------------------------------
  function applyDefaults(req) {
    const now = Date.now();

    const out = {
      version: 1,
      requestId: crypto?.randomUUID?.() ?? `${now}-${Math.random()}`,
      createdAt: now,

      tableUuid: null,

      roller: {
        userId: game.user?.id ?? null,
        actorUuid: game.user?.character?.uuid ?? null
      },

      recipient: {
        actorUuid: game.user?.character?.uuid ?? null
      },

      rouletteType: "Treasure",

      pool: {
        poolSize: 8,
        rollCount: 1,
        pickMode: "weightedSample", // "weightedSample" | "uniformSample"
        mustIncludeWinner: true,
        shufflePool: true
      },

      consumeResults: false,

      authorityMode: "gmOnly", // "gmOnly" | "auto" | "clientOnly"

      visibility: "all", // "all" | "gmOnly" | "rollerOnly" | "ownersOfRecipient" | "custom"
      recipients: [],

      ui: {
        uiDriverId: "rouletteWheel",
        lootTypeIcon: null,
        spinMs: 8000,
        adaptiveScaling: true,
        anticipation: { startPct: 0.86, maxMult: 2.1 },
        allowSkip: false
      },

      audio: {
        tickSfx: null,
        tickVol: 0.45,
        finalSfx: null,
        finalVol: 0.9
      },

      award: {
        mode: "grant", // "grant" | "chatOnly" | "none"
        showTransferCard: true,
        postToChatSummary: true,
        sync: {
          policy: "waitAllThenForce",
          maxWaitMs: 2500,
          minWaitMs: 200,
          postDelayMs: 250
        }
      }
    };

    // Merge shallowly, then nested merges
    const merged = { ...out, ...(req || {}) };

    merged.roller = { ...out.roller, ...(req?.roller || {}) };
    merged.recipient = { ...out.recipient, ...(req?.recipient || {}) };
    merged.pool = { ...out.pool, ...(req?.pool || {}) };
    merged.ui = { ...out.ui, ...(req?.ui || {}) };
    merged.audio = { ...out.audio, ...(req?.audio || {}) };
    merged.award = { ...out.award, ...(req?.award || {}) };
    merged.award.sync = { ...out.award.sync, ...(req?.award?.sync || {}) };

    // Normalize ints/bools
    merged.pool.poolSize = clamp(safeInt(merged.pool.poolSize, 8), 1, 99);
    merged.pool.rollCount = clamp(safeInt(merged.pool.rollCount, 1), 1, 99);
    merged.consumeResults = !!merged.consumeResults;
    merged.ui.spinMs = clamp(safeInt(merged.ui.spinMs, 8000), 250, 600000);

    if (!Array.isArray(merged.recipients)) merged.recipients = [];

    return merged;
  }

  // --------------------------------------------------------------------------
  // Validation
  // --------------------------------------------------------------------------
  function validateRequest(req) {
    const errors = [];

    if (!req.requestId) errors.push("Missing requestId.");
    if (!req.tableUuid) errors.push("Missing tableUuid (RollTable UUID).");

    if (!req.roller?.userId) errors.push("Missing roller.userId.");
    if (!req.recipient?.actorUuid) {
      // This is allowed, but award should degrade later; still warn.
      console.warn("[TreasureRoulette][Core] recipient.actorUuid missing; award should degrade to chatOnly later.");
    }

    const validAuthorityModes = new Set(["gmOnly", "auto", "clientOnly"]);
    if (!validAuthorityModes.has(req.authorityMode)) errors.push(`Invalid authorityMode: ${req.authorityMode}`);

    const validVisibility = new Set(["all", "gmOnly", "rollerOnly", "ownersOfRecipient", "custom"]);
    if (!validVisibility.has(req.visibility)) errors.push(`Invalid visibility: ${req.visibility}`);

    const validPickMode = new Set(["weightedSample", "uniformSample"]);
    if (!validPickMode.has(req.pool?.pickMode)) errors.push(`Invalid pool.pickMode: ${req.pool?.pickMode}`);

    return errors;
  }

  // --------------------------------------------------------------------------
  // Authority resolution + routing
  // --------------------------------------------------------------------------
  function findActiveGM() {
    const gms = game.users?.contents?.filter(u => u?.isGM && u?.active) ?? [];
    return gms[0] ?? null;
  }

  function isAuthorityForRequest(req) {
    if (req.authorityMode === "clientOnly") return true;

    const gm = findActiveGM();
    if (!gm) {
      // No active GM => requester becomes authority in "auto"
      return req.authorityMode === "auto";
    }

    // gmOnly or auto with GM present => that GM is authority
    return game.user?.id === gm.id;
  }

  function routeRequestToAuthority(req) {
    const gm = findActiveGM();

    // gmOnly: must have GM
    if (req.authorityMode === "gmOnly") {
      if (!gm) {
        return {
          ok: false,
          error: "No active GM found, but authorityMode is gmOnly."
        };
      }
      if (game.user?.id === gm.id) return { ok: true, routed: false };
      emitSocket(MSG_TR_REQUEST, { req, toUserId: gm.id });
      return { ok: true, routed: true, toUserId: gm.id };
    }

    // auto: GM if exists, else requester
    if (req.authorityMode === "auto") {
      if (gm && game.user?.id !== gm.id) {
        emitSocket(MSG_TR_REQUEST, { req, toUserId: gm.id });
        return { ok: true, routed: true, toUserId: gm.id };
      }
      return { ok: true, routed: false };
    }

    // clientOnly: never route
    return { ok: true, routed: false };
  }

  // --------------------------------------------------------------------------
  // RollTable resolving + row building
  // --------------------------------------------------------------------------
  async function resolveTable(idOrUuid) {
    if (!idOrUuid) return null;

    const byId = game.tables?.get(idOrUuid);
    if (byId) return byId;

    try {
      const doc = await fromUuid(idOrUuid);
      if (doc?.documentName === "RollTable") return doc;
    } catch (e) {
      // ignore
    }

    return null;
  }

  const FALLBACK_IMG = "icons/svg/chest.svg";

  async function buildAllTableRows(table) {
    const results = table?.results?.contents ?? [];
    const rows = [];

    for (const r of results) {
      let name = r.text || "Unknown";
      let img = r.img || FALLBACK_IMG;
      let uuid = null;

      if (r.documentCollection && r.documentId) {
        try {
          const linked = await r.getDocument?.();
          if (linked) {
            name = linked.name ?? name;
            img = linked.img ?? img;
            uuid = linked.uuid ?? `${r.documentCollection}.${r.documentId}`;
          } else {
            uuid = `${r.documentCollection}.${r.documentId}`;
          }
        } catch (e) {
          uuid = `${r.documentCollection}.${r.documentId}`;
        }
      }

      rows.push({
        name,
        img,
        uuid,
        tableResultId: r.id,

        // internal refs (not sent to clients)
        _weight: Number(r.weight ?? 1),
        _text: r.text ?? ""
      });
    }

    return rows;
  }

  // --------------------------------------------------------------------------
  // Pool sampling helpers
  // --------------------------------------------------------------------------
  function pickWeightedIndex(items) {
    const weights = items.map(it => Math.max(0, Number(it._weight ?? 1)));
    const total = weights.reduce((a, b) => a + b, 0);
    if (total <= 0) return Math.floor(Math.random() * items.length);

    let roll = Math.random() * total;
    for (let i = 0; i < items.length; i++) {
      roll -= weights[i];
      if (roll <= 0) return i;
    }
    return items.length - 1;
  }

  function pickUniformIndex(items) {
    return Math.floor(Math.random() * items.length);
  }

  function shuffleInPlace(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    return arr;
  }

  function sampleUniquePool(source, count, pickMode) {
    const pool = [];
    const bag = source.slice();

    while (pool.length < count && bag.length > 0) {
      const idx = (pickMode === "uniformSample")
        ? pickUniformIndex(bag)
        : pickWeightedIndex(bag);

      pool.push(bag[idx]);
      bag.splice(idx, 1);
    }

    return pool;
  }

  // --------------------------------------------------------------------------
  // Audience / visibility helpers
  // --------------------------------------------------------------------------
  async function resolveActorMaybe(uuid) {
    if (!uuid) return null;
    try {
      const doc = await fromUuid(uuid);
      return doc instanceof Actor ? doc : null;
    } catch (e) {
      return null;
    }
  }

  function getOwnerUserIdsForActor(actor) {
    const ids = new Set();
    if (!actor || !game?.users) return [];

    for (const u of game.users.contents) {
      if (!u) continue;

      // Assigned character is this actor
      if (u.character?.id && actor.id && u.character.id === actor.id) {
        ids.add(u.id);
        continue;
      }

      // Owner permission
      try {
        const isOwner = actor.testUserPermission?.(u, "OWNER") || false;
        if (isOwner) ids.add(u.id);
      } catch (e) {
        // ignore
      }
    }

    return Array.from(ids);
  }

  async function computeAudience(req) {
    const gmIds = (game.users?.contents ?? []).filter(u => u?.isGM).map(u => u.id);

    if (req.visibility === "gmOnly") {
      return { visibility: "gmOnly", expectedAcks: gmIds };
    }

    if (req.visibility === "rollerOnly") {
      // roller + GM (keeps GM in the loop for later award policies)
      const ids = new Set([req.roller?.userId, ...gmIds].filter(Boolean));
      return { visibility: "rollerOnly", expectedAcks: Array.from(ids) };
    }

    if (req.visibility === "ownersOfRecipient") {
      const actor = await resolveActorMaybe(req.recipient?.actorUuid);
      const owners = actor ? getOwnerUserIdsForActor(actor) : [];
      const ids = new Set([...owners, ...gmIds]);
      return { visibility: "ownersOfRecipient", expectedAcks: Array.from(ids) };
    }

    if (req.visibility === "custom") {
      const ids = new Set([...(req.recipients || []), ...gmIds].filter(Boolean));
      return { visibility: "custom", expectedAcks: Array.from(ids) };
    }

    // default: all active users
    const allActive = (game.users?.contents ?? []).filter(u => u?.active).map(u => u.id);
    return { visibility: "all", expectedAcks: allActive };
  }

  // --------------------------------------------------------------------------
  // Reward descriptor builder (lightweight; will get smarter later)
  // --------------------------------------------------------------------------
  function parseFirstIntFromText(text) {
  const m = String(text ?? "").match(/-?\d+/);
  if (!m) return null;
  const n = parseInt(m[0], 10);
  return Number.isFinite(n) ? n : null;
}

// Parse ONLY the (+X IP) pattern at the end (or anywhere), otherwise return 0.
// Special-case: "Refill all IP to full" => fillToMax=true.
function parseIpRewardFromText(text) {
  const s = String(text ?? "");

  // Special "refill" keyword from your table setup
  if (/refill\s+all\s+ip\s+to\s+full/i.test(s)) {
    return { fillToMax: true, amount: 0 };
  }

  // Primary pattern: (+X IP)
  // Example: "A bit of Supply (+2 IP)"
  const m1 = s.match(/\(\s*\+\s*(\d+)\s*IP\s*\)/i);
  if (m1 && m1[1] != null) {
    const n = parseInt(m1[1], 10);
    return { fillToMax: false, amount: Number.isFinite(n) ? Math.max(0, n) : 0 };
  }

  // Backup pattern: "+X IP" (in case someone forgets parentheses)
  const m2 = s.match(/\+\s*(\d+)\s*IP\b/i);
  if (m2 && m2[1] != null) {
    const n = parseInt(m2[1], 10);
    return { fillToMax: false, amount: Number.isFinite(n) ? Math.max(0, n) : 0 };
  }

  // No "+X IP" found => treat as +0 IP (Junk / It's Empty / etc.)
  return { fillToMax: false, amount: 0 };
}

function normalizeRouletteType(t) {
  return String(t ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

function isIpRouletteType(t) {
  const k = normalizeRouletteType(t);
  // Accept the name you're using in testing + common variants
  return k === "itempoints" || k === "itempoint" || k === "ip";
}

function isStatusRouletteType(t) {
  const k = normalizeRouletteType(t);
  return k === "statuseffect" || k === "statuseffects";
}

function buildRewardDescriptor(req, winnerRow) {
  const type = normalizeRouletteType(req.rouletteType || "Treasure");

  // If winnerRow.uuid points to an Item => Item reward (this is ALWAYS priority)
  if (winnerRow?.uuid && String(winnerRow.uuid).startsWith("Item.")) {
    return {
      kind: "Item",
      itemUuid: winnerRow.uuid,
      quantity: 1
    };
  }

  // Zenit: parse a number from table text/name if possible
  if (type === "zenit") {
    const amt = parseFirstIntFromText(winnerRow?._text) ?? parseFirstIntFromText(winnerRow?.name) ?? 0;
    return {
      kind: "Zenit",
      amount: Math.max(0, amt)
    };
  }

  // IP rouletteType: parse ONLY (+X IP) or "Refill all IP to full"
  if (isIpRouletteType(type)) {
    const src = String(winnerRow?._text ?? winnerRow?.name ?? "");
    const parsed = parseIpRewardFromText(src);

    return {
      kind: "ItemPoint",
      amount: Math.max(0, safeInt(parsed.amount ?? 0, 0)),
      fillToMax: !!parsed.fillToMax
    };
  }

  // StatusEffect rouletteType
  if (isStatusRouletteType(type)) {
    if (winnerRow?.uuid && String(winnerRow.uuid).startsWith("ActiveEffect.")) {
      return {
        kind: "StatusEffect",
        effectUuid: winnerRow.uuid
      };
    }
    return {
      kind: "StatusEffect",
      effectUuid: winnerRow?.uuid ?? null
    };
  }

  // Default fallback
  if (winnerRow?.uuid) {
    return {
      kind: "Item",
      itemUuid: winnerRow.uuid,
      quantity: 1
    };
  }

  return {
    kind: "Item",
    itemUuid: null,
    quantity: 1
  };
}

  // --------------------------------------------------------------------------
  // Authoritative roll/draw
  // --------------------------------------------------------------------------
  async function rollOrDrawWinner(table, consumeResults) {
    // NOTE:
    // - table.roll() respects weights, and table "replacement" rules.
    // - table.draw() depletes results (draw-without-replacement feel).
    // We use draw({displayChat:false}) when consumeResults=true to lockout.
    try {
      if (consumeResults && typeof table.draw === "function") {
        const draw = await table.draw({ displayChat: false });
        const picked = draw?.results?.[0] ?? null;
        return picked;
      }

      // default: roll
      const rolled = await table.roll({ displayChat: false });
      const picked = rolled?.results?.[0] ?? null;
      return picked;
    } catch (err) {
      console.error("[TreasureRoulette][Core] roll/draw failed:", err);
      return null;
    }
  }

  // --------------------------------------------------------------------------
  // Build Result Packet (locked output)
  // --------------------------------------------------------------------------
  async function buildResultPacket(req) {
    const table = await resolveTable(req.tableUuid);
    if (!table) {
      throw new Error(`[TreasureRoulette][Core] RollTable not found: ${req.tableUuid}`);
    }

    const allRows = await buildAllTableRows(table);
    if (!allRows.length) {
      throw new Error(`[TreasureRoulette][Core] RollTable has no results: ${req.tableUuid}`);
    }

    // 1) Authoritative winner selection
    const pickedResult = await rollOrDrawWinner(table, req.consumeResults);
    if (!pickedResult) {
      throw new Error(`[TreasureRoulette][Core] Failed to roll/draw a result from: ${req.tableUuid}`);
    }

    const winnerAllRow = allRows.find(r => r.tableResultId === pickedResult.id) ?? null;
    if (!winnerAllRow) {
      throw new Error(`[TreasureRoulette][Core] Rolled result not found in table rows. resultId=${pickedResult.id}`);
    }

    // 2) Build displayPool subset
    const poolSize = clamp(safeInt(req.pool?.poolSize, 8), 1, 99);
    let displayPool = [];

    if (poolSize >= allRows.length) {
      displayPool = allRows.slice();
    } else {
      if (req.pool?.mustIncludeWinner) {
        displayPool = [winnerAllRow];

        const candidates = allRows.filter(r => r.tableResultId !== winnerAllRow.tableResultId);
        const needed = Math.max(0, poolSize - displayPool.length);
        const sampled = sampleUniquePool(candidates, needed, req.pool?.pickMode);
        displayPool.push(...sampled);
      } else {
        displayPool = sampleUniquePool(allRows, poolSize, req.pool?.pickMode);
      }
    }

    if (req.pool?.shufflePool) shuffleInPlace(displayPool);

    // Ensure winner is inside the display pool (hard guarantee)
    let indexInPool = displayPool.findIndex(r => r.tableResultId === winnerAllRow.tableResultId);
    if (indexInPool < 0) {
      // Insert winner in a random slot
      const insertAt = Math.floor(Math.random() * (displayPool.length + 1));
      displayPool.splice(insertAt, 0, winnerAllRow);
      indexInPool = insertAt;

      // If we exceeded poolSize, drop one non-winner
      while (displayPool.length > poolSize) {
        const dropIdx = displayPool.findIndex((r, i) => i !== indexInPool);
        if (dropIdx >= 0) {
          displayPool.splice(dropIdx, 1);
          if (dropIdx < indexInPool) indexInPool -= 1;
        } else {
          break;
        }
      }
    }

    // 3) Audience
    const audience = await computeAudience(req);

    // 4) Packet
    const packet = {
      requestId: req.requestId,
      createdAt: req.createdAt,
      tableUuid: req.tableUuid,
      rouletteType: req.rouletteType,
      roller: req.roller,
      recipient: req.recipient,
      consumeResults: req.consumeResults,

      serverTime: Date.now(),
      spinMs: safeInt(req.ui?.spinMs, 8000),

      displayPool: displayPool.map(r => ({
        name: r.name,
        img: r.img,
        uuid: r.uuid,
        tableResultId: r.tableResultId
      })),

      winner: {
        name: winnerAllRow.name,
        img: winnerAllRow.img,
        uuid: winnerAllRow.uuid,
        tableResultId: winnerAllRow.tableResultId,
        indexInPool
      },

      reward: buildRewardDescriptor(req, winnerAllRow),

      audience
    };

    return packet;
  }

  // --------------------------------------------------------------------------
  // Socket helpers
  // --------------------------------------------------------------------------
  function emitSocket(type, payload) {
    if (!game?.socket) {
      console.warn("[TreasureRoulette][Core] No game.socket available.");
      return;
    }

    game.socket.emit(SOCKET_CHANNEL, {
      type,
      payload
    });
  }

  // --------------------------------------------------------------------------
  // Authority handler (when GM receives a routed request)
  // --------------------------------------------------------------------------
  
  // --------------------------------------------------------------------------
  // Recipient fallback: if recipient.actorUuid missing, use Database Actor
  // - Uses DB_resolver: await window.FUCompanion.api.getCurrentGameDb()
  // --------------------------------------------------------------------------
  async function applyRecipientFallback(req) {
  // IMPORTANT:
  // - For IP (rouletteType like "Itempoints"), do NOT fallback to Database Actor.
  // - Game rule: IP cannot be stored in DB Actor. If recipient missing, AwardDispatcher will only chat + warn.
  const type = normalizeRouletteType(req?.rouletteType ?? "");
  if (type === "itempoints" || type === "itempoint" || type === "ip") return req;

  if (req?.recipient?.actorUuid) return req;

  try {
    const api = window.FUCompanion?.api;
    if (!api || typeof api.getCurrentGameDb !== "function") {
      console.warn("[TreasureRoulette][Core] DB_resolver API missing; cannot fallback recipient.");
      return req;
    }

    const { db, dbUuid } = await api.getCurrentGameDb();
    const fallbackUuid = db?.uuid ?? dbUuid ?? null;

    if (!fallbackUuid) {
      console.warn("[TreasureRoulette][Core] DB_resolver returned no db/dbUuid; cannot fallback recipient.");
      return req;
    }

    req.recipient = req.recipient || {};
    req.recipient.actorUuid = fallbackUuid;

    console.warn("[TreasureRoulette][Core] recipient.actorUuid missing; falling back to Database Actor:", fallbackUuid);
    return req;
  } catch (e) {
    console.warn("[TreasureRoulette][Core] Failed to fallback recipient via DB_resolver:", e);
    return req;
  }
}

    async function handleAuthorityRequest(req) {
    const request = applyDefaults(req);

    // NEW: fill missing recipient with Database Actor
    await applyRecipientFallback(request);

    const errors = validateRequest(request);
    if (errors.length) {
      console.error("[TreasureRoulette][Core] Request validation failed:", errors, request);
      return {
        ok: false,
        errors
      };
    }

    // idempotency: if we already locked this requestId, do not re-roll
    if (_requests.has(request.requestId)) {
      const existing = _requests.get(request.requestId);
      console.warn("[TreasureRoulette][Core] Duplicate requestId detected; returning existing locked packet.", {
        requestId: request.requestId,
        state: existing?.state
      });
      return {
        ok: true,
        requestId: request.requestId,
        packet: existing?.packet ?? null,
        replay: true
      };
    }

    // Build packet (authority roll)
    let packet = null;
    try {
      packet = await buildResultPacket(request);
    } catch (err) {
      console.error("[TreasureRoulette][Core] Failed to build Result Packet:", err);
      return { ok: false, error: String(err?.message ?? err) };
    }

    _requests.set(request.requestId, {
      state: "LOCKED",
      packet,
      createdAt: Date.now()
    });

    // Broadcast to audience (UI listener will run it on OTHER clients)
emitSocket(MSG_TR_PLAY_UI, packet);

// Play locally (authority client might not receive its own socket)
try {
  const uiApi = window["oni.TreasureRoulette.UI"];
  if (uiApi && typeof uiApi.play === "function") {
    uiApi.play(packet);
  }
} catch (e) {
  // ignore
}

// Queue AwardDispatcher locally too (authority client might not receive its own socket)
try {
  const ad = window["oni.TreasureRoulette.AwardDispatcher"];
  if (ad && typeof ad.queue === "function") {
    ad.queue(packet);
  }
} catch (e) {
  // ignore
}

console.log("[TreasureRoulette][Core] Locked + broadcast packet:", packet);

    return {
      ok: true,
      requestId: request.requestId,
      packet
    };
  }

  // --------------------------------------------------------------------------
  // Public API: Core.request()
  // - Front ends call this.
  // - If not authority, routes to authority and returns early.
  // - If authority, locks result and broadcasts packet.
  // --------------------------------------------------------------------------
   async function request(req) {
    const request = applyDefaults(req);

    // NEW: fill missing recipient with Database Actor
    await applyRecipientFallback(request);

    const errors = validateRequest(request);
    if (errors.length) {
      return { ok: false, errors };
    }

    const routing = routeRequestToAuthority(request);
    if (!routing.ok) return routing;
    if (routing.routed) {
      console.log("[TreasureRoulette][Core] Routed request to authority:", routing);
      return {
        ok: true,
        routed: true,
        requestId: request.requestId,
        toUserId: routing.toUserId
      };
    }

    // We are authority (or clientOnly)
    return await handleAuthorityRequest(request);
  }

  // --------------------------------------------------------------------------
  // Socket listener setup
  // --------------------------------------------------------------------------
  function installSocketListener() {
    if (!game?.socket) return;

    // Only install once per client
    const guardKey = "oni._treasureRouletteCoreSocketInstalled";
    if (window[guardKey]) return;
    window[guardKey] = true;

    game.socket.on(SOCKET_CHANNEL, async (data) => {
      try {
        if (!data || data.type !== MSG_TR_REQUEST) return;

        const { req, toUserId } = data.payload || {};
        if (!req) return;

        // If packet is intended for a specific authority, ignore on others
        if (toUserId && game.user?.id !== toUserId) return;

        // Only authority should execute the roll/lock
        const fixed = applyDefaults(req);
        if (!isAuthorityForRequest(fixed)) return;

        console.log("[TreasureRoulette][Core] Received routed request; acting as authority.", fixed);
        await handleAuthorityRequest(fixed);
      } catch (err) {
        console.error("[TreasureRoulette][Core] Socket handler error:", err);
      }
    });

    console.log("[TreasureRoulette][Core] Socket listener installed.");
  }

  // --------------------------------------------------------------------------
  // Install API
  // --------------------------------------------------------------------------
  installSocketListener();

  window[KEY] = {
    // Main entry
    request,

    // Expose constants so UI/Award scripts can reuse exactly
    SOCKET_CHANNEL,
    MSG_TR_REQUEST,
    MSG_TR_PLAY_UI,

    // Debug helpers
    _requests
  };

  console.log(`[TreasureRoulette][Core] Installed as window["${KEY}"].`);
})();
