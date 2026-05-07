/**
 * TreasureRoulette — Tile Front-End (Monk's Active Tile Triggers)
 * Foundry VTT v12
 * -----------------------------------------------------------------------------
 * What this script does:
 * 1) When the Database token enters a "Treasure Tile", it posts a chat prompt with a "Roll!" button.
 * 2) The first player who presses "Roll!" becomes the recipient (their linked Actor).
 * 3) It then fires TreasureRoulette Core with the correct payload.
 * 4) When TreasureRoulette finishes (Hooks event TR:COMPLETED), it clears/disables the tile.
 *
 * Required:
 * - FUCompanion DB Resolver API (api.getCurrentGameDb) is available. (Used in Core too)
 * - TreasureRoulette Core already installed: window["oni.TreasureRoulette.Core"].request(...)
 * - AwardDispatcher emits Hooks.callAll("TR:COMPLETED", { requestId, packet, ... }) after award is done.
 * - (Optional but recommended) Run the MATT macro action "as GM" so tile flags + clearing always succeed.
 *
 * Notes:
 * - Tile type is detected by the tile's texture.src URL (your provided tile images).
 * - Table UUIDs are CONFIG — set them to your RollTable UUIDs.
 */

Hooks.once("ready", () => {
  const KEY = "oni.TreasureRoulette.TileFrontEnd";
  if (window[KEY]) return;

  // ---------------------------------------------------------------------------
  // CONFIG
  // ---------------------------------------------------------------------------
  const MODULE_ID = "fabula-ultima-companion";
  const SOCKET_CHANNEL = `module.${MODULE_ID}`;

  // The blank tile image your ClearTile script uses (update if yours differs)
  // (Used when "consuming" the tile after reward is granted)
  const BLANK_TILE_SRC =
    "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Fabula%20Ultima/Dungeon%20Tile/Special%20Tile/Blank_Tile.png";

  // ClearTile FX (mirrors your ClearTile.js)
  const CLEAR_FX_WEBM =
    "modules/JB2A_DnD5e/Library/Generic/Smoke/SmokePuffRing01_02_Regular_White_400x400.webm";
  const CLEAR_SFX_OGG =
    "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/Door1.ogg";

  // Default roulette behavior (tweak freely)
  const DEFAULT_POOL_SIZE = 8;
  const DEFAULT_SPIN_MS = 6000;
  const DEFAULT_CONSUME_RESULTS = false; // consume RollTable results after win?

  // If true, we also set a "consumed" flag on the Tile so re-entering does nothing.
  const MARK_TILE_CONSUMED_FLAG = true;

  // Tile → Roulette Type detection by image source (exact matches)
  const TILE_SRC = {
    Weapon:
      "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Fabula%20Ultima/Dungeon%20Tile/Special%20Tile/Weapon_Tile.png",
    Accessories:
      "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Fabula%20Ultima/Dungeon%20Tile/Special%20Tile/Accessory_Tile.png",
    IP:
      "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Fabula%20Ultima/Dungeon%20Tile/Special%20Tile/Item_Tile.png",
    Zenit:
      "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Fabula%20Ultima/Dungeon%20Tile/Special%20Tile/Gold_Tile.png",
    Treasure:
      "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Fabula%20Ultima/Dungeon%20Tile/Special%20Tile/Treasure_Tile.png",
    Consumable:
      "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Fabula%20Ultima/Dungeon%20Tile/Special%20Tile/Consumeable_Tile.png",
    Armor:
      "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Fabula%20Ultima/Dungeon%20Tile/Special%20Tile/Armor_Tile.png",
    Status:
      "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Fabula%20Ultima/Dungeon%20Tile/Special%20Tile/Status_Tile.png",
  };

  // RollTables are read from the CURRENT SCENE's Dungeon Configuration flags.
  // This matches your Scene Config UI fields (Dungeon Configuration → Loot):
  //   flags.fabula-ultima-companion.oniDungeon.loot.weapon
  //   flags.fabula-ultima-companion.oniDungeon.loot.armor
  //   flags.fabula-ultima-companion.oniDungeon.loot.accessory
  //   flags.fabula-ultima-companion.oniDungeon.loot.consumable
  //   flags.fabula-ultima-companion.oniDungeon.loot.item
  //   flags.fabula-ultima-companion.oniDungeon.loot.treasure
  //
  // Optional / forward-compatible keys (if you add them later):
  //   flags.fabula-ultima-companion.oniDungeon.loot.zenit
  //   flags.fabula-ultima-companion.oniDungeon.loot.status
  //
  // Fallback order (same as your Dungeon Config UI):
  //   1) flags.<MODULE_ID>.oniDungeon
  //   2) flags.world.oniDungeon
  //   3) flags.oniDungeon (legacy v1)
  const DUNGEON_ROOT_KEY = "oniDungeon";
  
  const readDungeonData = (scene) => {
    try {
      const mod = scene?.flags?.[MODULE_ID]?.[DUNGEON_ROOT_KEY];
      if (mod && typeof mod === "object" && Object.keys(mod).length) return mod;
      const world = scene?.flags?.world?.[DUNGEON_ROOT_KEY];
      if (world && typeof world === "object" && Object.keys(world).length) return world;
      const legacy = scene?.flags?.[DUNGEON_ROOT_KEY];
      if (legacy && typeof legacy === "object" && Object.keys(legacy).length) return legacy;
    } catch (_) {}
    return {};
  };
  
  const getLootTableUuidFromScene = (tileType, scene = canvas.scene) => {
    const data = readDungeonData(scene);
    const loot = data?.loot || {};
  
    // Normalize tileType → key
    const key = (() => {
      if (tileType === "Weapon") return "weapon";
      if (tileType === "Armor") return "armor";
      if (tileType === "Accessories") return "accessory";
      if (tileType === "Consumable") return "consumable";
      if (tileType === "Treasure") return "treasure";
      // Your rule: IP tile uses the Item table
      if (tileType === "IP") return "item";

      // NEW: Zenit tile reads from Dungeon Configuration → Loot → Zenit
      if (tileType === "Zenit") return "zenit";

      // (Optional) if you ever add a Status loot field later:
      if (tileType === "Status") return "status";

      return null;
    })();
  
    if (key && typeof loot[key] === "string" && loot[key].trim()) return loot[key].trim();
  
    // Backward/compat fallbacks:
    // - Status: if no loot.status field exists, we fall back to treasure to avoid hard failure.
    if (tileType === "Status" && typeof loot.treasure === "string" && loot.treasure.trim()) return loot.treasure.trim();
  
    return "";
  };
  
    // If you want some tile types to ALWAYS consume results differently:
  // (If omitted, DEFAULT_CONSUME_RESULTS is used.)
  const CONSUME_RESULTS_BY_TYPE = {
    // Zenit: false,
    // IP: false,
  };

  // ---------------------------------------------------------------------------
  // SOCKET MESSAGE TYPES (new, only for this Tile front-end)
  // ---------------------------------------------------------------------------
  const MSG_TILE_CLAIM = "ONI_TR_TILE_CLAIM";
  const MSG_TILE_CLAIM_RESULT = "ONI_TR_TILE_CLAIM_RESULT";
  const MSG_TILE_FX = "ONI_TR_TILE_FX";

  // ---------------------------------------------------------------------------
  // INTERNAL STATE
  // ---------------------------------------------------------------------------
  // requestId -> { tileUuid, messageId }
  const tileByRequestId = new Map();

  // ---------------------------------------------------------------------------
  // HELPERS
  // ---------------------------------------------------------------------------
  const log = (...a) => console.log("[TR TileFE]", ...a);
  const warn = (...a) => console.warn("[TR TileFE]", ...a);

  const stripQuery = (src) => String(src ?? "").split("?")[0];
  const isTruthy = (v) => !!v;

  const getActiveGM = () => game.users?.contents?.find((u) => u.isGM && u.active) || null;
  const isAuthorityClient = () => {
    const gm = getActiveGM();
    if (!gm) return true; // no active GM → allow whoever is running
    return game.user?.id === gm.id;
  };

  const safeGetTileSrc = (tileDoc) => {
    // TileDocument in v12 uses texture.src
    return stripQuery(tileDoc?.texture?.src ?? tileDoc?.img ?? "");
  };

  const detectTileType = (tileDoc) => {
    const src = safeGetTileSrc(tileDoc);

    if (src === TILE_SRC.Weapon) return "Weapon";
    if (src === TILE_SRC.Armor) return "Armor";
    if (src === TILE_SRC.Accessories) return "Accessories";
    if (src === TILE_SRC.Consumable) return "Consumable";
    if (src === TILE_SRC.Treasure) return "Treasure";
    if (src === TILE_SRC.Status) return "Status";
    if (src === TILE_SRC.Zenit) return "Zenit";
    if (src === TILE_SRC.IP) return "IP";

    return null;
  };

  const rouletteTypeFromTileType = (tileType) => {
    // Your rule: Zenit tile = Zenit, Item tile = IP, rest are "normal treasure mode"
    // We still keep the label for clarity in UI + logging.
    if (tileType === "Zenit") return "Zenit";
    if (tileType === "IP") return "IP";
    return tileType; // Weapon / Armor / Accessories / Consumable / Treasure / Status
  };

  const tableUuidFromTileType = (tileType) => getLootTableUuidFromScene(tileType, canvas.scene);
  const canStartRouletteForTile = async (tileDoc) => {
    if (!tileDoc) return false;

    // If we already consumed this tile, never prompt again.
    const consumed = tileDoc.getFlag(MODULE_ID, "trTileConsumed");
    if (consumed) return false;

    // Simple anti-spam cooldown (prevents multiple prompts if the token jitters on the border).
    const last = Number(tileDoc.getFlag(MODULE_ID, "trLastPromptAt") || 0);
    if (last && (Date.now() - last) < 1500) return false;

    return true;
  };

  const getCore = () => window["oni.TreasureRoulette.Core"] || null;

  const getDbUuids = async () => {
    const api = window.FUCompanion?.api;
    if (!api?.getCurrentGameDb) return { dbActorUuid: null, sourceActorUuid: null };

    // Core uses this too: const { db, dbUuid } = await api.getCurrentGameDb()
    const { db, dbUuid, source } = await api.getCurrentGameDb();
    return {
      dbActorUuid: dbUuid || db?.uuid || null,
      sourceActorUuid: source?.uuid || null,
    };
  };

  const isDbToken = async (tokenDoc) => {
    if (!tokenDoc) return false;
    const { dbActorUuid, sourceActorUuid } = await getDbUuids();
    const actorUuid = tokenDoc?.actor?.uuid || tokenDoc?.actorUuid || null;
    return actorUuid === dbActorUuid || actorUuid === sourceActorUuid;
  };

  const tryGetRollTableImg = async (tableUuid) => {
    try {
      if (!tableUuid) return null;
      const doc = await fromUuid(tableUuid);
      return doc?.img || null;
    } catch (e) {
      return null;
    }
  };

  const esc = (s) =>
    String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");

  const buildPromptHtml = ({
    titleText,
    iconSrc,
    buttonLabel,
    disabled,
    claimedText,
  }) => {
    const icon = iconSrc
      ? `<img class="tr-tilefe-icon" src="${esc(iconSrc)}" />`
      : "";
    const claimLine = claimedText
      ? `<div class="tr-tilefe-claimed">${esc(claimedText)}</div>`
      : "";

    return `
<div class="tr-tilefe" style="padding:10px 10px 12px 10px; border-radius:12px;">
  <style>
    /* Keep this style scoped to the card */
    .tr-tilefe { background: rgba(12,12,12,0.70); border: 1px solid rgba(255,255,255,0.12); }
    .tr-tilefe-head { display:flex; align-items:center; gap:10px; }
    .tr-tilefe-title { font-weight:800; font-size:16px; letter-spacing:0.2px; }
    .tr-tilefe-icon { width:28px; height:28px; object-fit:contain; background:transparent; border:none; box-shadow:none; }
    .tr-tilefe-btnwrap { margin-top:10px; display:flex; justify-content:flex-start; gap:8px; align-items:center; }
    .tr-tilefe-btn { padding:7px 12px; border-radius:10px; font-weight:800; border: 1px solid rgba(255,255,255,0.20); }
    .tr-tilefe-btn[disabled] { opacity:0.55; cursor:not-allowed; }
    .tr-tilefe-claimed { margin-top:8px; font-size:12px; opacity:0.85; font-style:italic; }
    .tr-tilefe-small { font-size:12px; opacity:0.70; font-style:italic; margin-top:6px; }
  </style>

  <div class="tr-tilefe-head">
    ${icon}
    <div class="tr-tilefe-title">${esc(titleText)}</div>
  </div>

  <div class="tr-tilefe-btnwrap">
    <button class="tr-tilefe-roll tr-tilefe-btn" type="button" ${disabled ? "disabled" : ""}>
      ${esc(buttonLabel)}
    </button>
    <div class="tr-tilefe-small">First click claims the roll.</div>
  </div>

  ${claimLine}
</div>
`;
  };

  const hideChatHeader = (html) => {
    // Hide speaker header ("Cherry" grey line) if present.
    try {
      html.find("header.message-header").css("display", "none");
    } catch (_) {}
  };

  const resolveTileAndTokenFromContext = (context) => {
    // Monk's Active Tile Triggers can pass different shapes depending on action config.
    // We handle a bunch of common patterns without assuming a specific one.
    // The goal: get TileDocument + TokenDocument (the triggering token).
    let tileDoc = null;
    let tokenDoc = null;

    // 1) Direct objects
    const maybeTile =
      context?.tile?.document ||
      context?.tileDocument ||
      context?.tile ||
      globalThis.tile?.document ||
      globalThis.tile ||
      null;

    const maybeToken =
      context?.token?.document ||
      context?.tokenDocument ||
      context?.token ||
      globalThis.token?.document ||
      globalThis.token ||
      null;

    if (maybeTile?.documentName === "Tile") tileDoc = maybeTile;
    if (maybeTile?.document?.documentName === "Tile") tileDoc = maybeTile.document;

    if (maybeToken?.documentName === "Token") tokenDoc = maybeToken;
    if (maybeToken?.document?.documentName === "Token") tokenDoc = maybeToken.document;

    // 2) IDs
    if (!tileDoc) {
      const tileId = context?.tileId || context?.tile_id || context?.tile?.id || null;
      if (tileId) tileDoc = canvas.tiles?.get(tileId)?.document || null;
    }

    if (!tokenDoc) {
      const tokenId = context?.tokenId || context?.token_id || context?.token?.id || null;
      if (tokenId) tokenDoc = canvas.tokens?.get(tokenId)?.document || null;
    }

    // 3) UUIDs
    if (!tileDoc) {
      const tileUuid = context?.tileUuid || context?.tile_uuid || null;
      // fromUuid works async; we won't do that here.
      if (tileUuid && tileUuid.includes(".Tile.")) {
        const parts = tileUuid.split(".");
        const tileId = parts[parts.length - 1];
        tileDoc = canvas.tiles?.get(tileId)?.document || null;
      }
    }

    if (!tokenDoc) {
      const tokenUuid = context?.tokenUuid || context?.token_uuid || null;
      if (tokenUuid && tokenUuid.includes(".Token.")) {
        const parts = tokenUuid.split(".");
        const tokenId = parts[parts.length - 1];
        tokenDoc = canvas.tokens?.get(tokenId)?.document || null;
      }
    }

    return { tileDoc, tokenDoc };
  };

  const clearTileVisualAndDisable = async (tileUuid) => {
    try {
      const tileDoc = await fromUuid(tileUuid);
      if (!tileDoc) return;

      // Update the tile to blank
      const update = {
        _id: tileDoc.id,
        texture: { src: BLANK_TILE_SRC },
        "flags.monks-active-tiles.active": false,
      };

      // Optional: mark consumed (prevents re-trigger even if tile remains active)
      if (MARK_TILE_CONSUMED_FLAG) {
        update.flags = update.flags || {};
        update.flags[MODULE_ID] = update.flags[MODULE_ID] || {};
        update.flags[MODULE_ID].trTileConsumed = true;
        update.flags[MODULE_ID].trTileInProgress = false;
        update.flags[MODULE_ID].trTileRequestId = null;
        update.flags[MODULE_ID].trTilePrompted = false;
        update.flags[MODULE_ID].trPromptMessageId = null;
      }

      await canvas.scene.updateEmbeddedDocuments("Tile", [update]);

      // Broadcast the ClearTile FX so every connected client sees the animation + sound.
      try {
        game.socket.emit(SOCKET_CHANNEL, {
          type: MSG_TILE_FX,
          payload: {
            sceneId: tileDoc.parent?.id || canvas.scene?.id,
            tileId: tileDoc.id,
          },
        });
      } catch (_) {}
log("Tile consumed:", tileUuid);
    } catch (e) {
      warn("Failed to clear tile:", tileUuid, e);
    }
  };

  // ---------------------------------------------------------------------------
  // CORE FLOW: called by the tile trigger macro
  // ---------------------------------------------------------------------------
  const onDbEnterTile = async (context = {}) => {
    try {
      log("onDbEnterTile called", {
        hasContext: !!context,
        contextKeys: (context && typeof context === "object") ? Object.keys(context) : [],
        user: game.user?.name,
        isGM: game.user?.isGM
      });
      if (!isAuthorityClient()) return;

      const { tileDoc, tokenDoc } = resolveTileAndTokenFromContext(context);
      if (!tileDoc || !tokenDoc) {
        warn("No tile/token context received. If testing manually: select ONE token (DB token) and ONE tile, then run the trigger macro.", {
          tileDoc: tileDoc?.uuid || null,
          tokenDoc: tokenDoc?.uuid || null,
          context
        });
        return;
      }

      // Only DB token should create prompts
      const okDb = await isDbToken(tokenDoc);
      if (!okDb) {
        log("Trigger ignored: token is not DB token", { token: tokenDoc?.uuid, actor: tokenDoc?.actor?.uuid || tokenDoc?.actorUuid || null });
        return;
      }

      // Already consumed/prompted?
      const can = await canStartRouletteForTile(tileDoc);
      if (!can) return;

      // Detect which tile type
      const tileType = detectTileType(tileDoc);
      if (!tileType) {
        log("Trigger ignored: tile image not recognized as a TR tile", { tile: tileDoc?.uuid, src: safeGetTileSrc(tileDoc) });
        return;
      }

      const rouletteType = rouletteTypeFromTileType(tileType);
      const tableUuid = tableUuidFromTileType(tileType);

      if (!tableUuid) {
        ui.notifications.warn(
          `[TreasureRoulette] TileFrontEnd: No RollTable UUID configured for "${tileType}" on this Scene (Dungeon Configuration → Loot).`
        );
        return;
      }

      // Try to use RollTable img (you asked "rollabletable image icon")
      const iconSrc = (await tryGetRollTableImg(tableUuid)) || safeGetTileSrc(tileDoc);

      const titleText = `${rouletteType} Tile`;

      const content = buildPromptHtml({
        titleText,
        iconSrc,
        buttonLabel: "Roll!",
        disabled: false,
        claimedText: "",
      });

      // Create the prompt message (create as GM/authority so we can update later)
      const msg = await ChatMessage.create({
        speaker: { alias: "" },
        content,
        flags: {
          [MODULE_ID]: {
            oniTRTilePrompt: {
              tileUuid: tileDoc.uuid,
              sceneId: canvas.scene?.id || null,
              tileId: tileDoc.id,
              tileType,
              rouletteType,
              tableUuid,
              iconSrc,
              claimedByUserId: null,
              claimedByActorUuid: null,
              claimedByName: null,
            },
          },
        },
      });

      // Record last prompt time (anti-spam). We intentionally DO NOT "lock" the tile here;
// if the DB token leaves and re-enters before anyone clicks Roll, we'll allow re-prompt.
await tileDoc.setFlag(MODULE_ID, "trLastPromptAt", Date.now());
await tileDoc.setFlag(MODULE_ID, "trPromptMessageId", msg.id);

      log("Prompt created:", { tileType, rouletteType, tableUuid, messageId: msg.id });
    } catch (e) {
      warn("onDbEnterTile failed:", e);
    }
  };

  // ---------------------------------------------------------------------------
  // CHAT RENDER: wire up the button
  // ---------------------------------------------------------------------------
  Hooks.on("renderChatMessage", (message, html) => {
    const data = message.getFlag(MODULE_ID, "oniTRTilePrompt");
    if (!data) return;

    hideChatHeader(html);

    const btn = html.find("button.tr-tilefe-roll");
    if (!btn?.length) return;

    // If already claimed, disable and show claim line
    if (data.claimedByUserId) {
      btn.prop("disabled", true);
      btn.text("Rolling...");
      return;
    }

    // Bind click (avoid double-binding)
    btn.off("click.trtilefe");
    btn.on("click.trtilefe", async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();

      // Disable immediately on this client
      btn.prop("disabled", true);
      btn.text("Rolling...");

      const actorUuid = game.user?.character?.uuid || null;
      if (!actorUuid) {
        ui.notifications.warn(
          "[TreasureRoulette] You must have a linked Actor (User Configuration → Character) to roll on this tile."
        );
        btn.prop("disabled", false);
        btn.text("Roll!");
        return;
      }

      // Pull the tableUuid stored on the prompt (created from Scene Dungeon Configuration)
      // Fallback: re-resolve from current scene flags using tileType.
      const tableUuid = data.tableUuid || tableUuidFromTileType(data.tileType);
      const rouletteType = data.rouletteType || rouletteTypeFromTileType(data.tileType);

      if (!tableUuid) {
        ui.notifications.error(
          `[TreasureRoulette] TileFrontEnd: No RollTable UUID configured for "${rouletteType}". Check Scene Config → Fabula Configuration → Dungeon Configuration → Loot.`
        );
        btn.prop("disabled", false);
        btn.text("Roll!");
        return;
      }

      try {
        // Ask the authority client (GM) to arbitrate the claim and start the roulette.
        // This prevents multiple clients from rolling the same tile.
        const claimPayload = {
          messageId: message.id,
          userId: game.user?.id,
          userName: game.user?.name,
          recipientActorUuid: actorUuid,
          tableUuid,
          rouletteType
        };

        // IMPORTANT:
        // Foundry's module socket does not always "echo" back to the sender.
        // So if *this* client is the authority (active GM), call onClaim() directly.
        if (isAuthorityClient()) {
          await onClaim(claimPayload);
        } else {
          game.socket.emit(SOCKET_CHANNEL, {
            type: MSG_TILE_CLAIM,
            payload: claimPayload
          });
        }

        btn.text("Claiming...");} catch (e) {
        console.error("[TR TileFE] Failed to emit claim:", e);
        ui.notifications.error("[TR TileFE] Failed to start roll. See console.");
        btn.prop("disabled", false);
        btn.text("Roll!");
      }

      return;
    });

  });

  // ---------------------------------------------------------------------------
  // SOCKET: claim arbitration + start Core (authority side)
  // ---------------------------------------------------------------------------
  const ensureSocketListener = () => {
    const GUARD = "__ONI_TR_TILEFE_SOCKET_LISTENER__";
    if (window[GUARD]) return;
    window[GUARD] = true;

    game.socket.on(SOCKET_CHANNEL, async (msg) => {
      try {
        if (!msg || typeof msg !== "object") return;
        const { type, payload } = msg;

        if (type === MSG_TILE_CLAIM) {
          await onClaim(payload);
          return;
        }

        if (type === MSG_TILE_FX) {
          await onTileFx(payload);
          return;
        }

        // Best-effort: inform the clicker if their claim was rejected.
        if (type === MSG_TILE_CLAIM_RESULT) {
          const to = payload?.toUserId;
          if (to && to !== game.user?.id) return;

          const ok = !!payload?.ok;
          if (!ok) {
            // If our local UI was disabled while claiming, re-enable it.
            if (payload?.messageId) resetPromptButton(payload.messageId);

            const reason = payload?.reason || "unknown";
            const by = payload?.claimedByName ? ` (claimed by ${payload.claimedByName})` : "";
            ui.notifications?.warn?.(`[TreasureRoulette] Claim rejected: ${reason}${by}`);
          }
          return;
        }
} catch (e) {
        warn("Socket handler error:", e);
      }
    });
  };

  const replyClaimResult = (toUserId, result) => {
    // best-effort: we broadcast, but clients can ignore if not them
    game.socket.emit(SOCKET_CHANNEL, {
      type: MSG_TILE_CLAIM_RESULT,
      payload: { toUserId, ...result },
    });
  };

  const onTileFx = async (payload) => {
    try {
      const sceneId = payload?.sceneId;
      const tileId = payload?.tileId;
      if (!sceneId || !tileId) return;
      if (!canvas?.scene || canvas.scene.id !== sceneId) return;

      const tileObj = canvas.tiles?.get(tileId);
      if (!tileObj) return;
      if (!globalThis.Sequence) return;

      new Sequence()
        .effect()
        .file(CLEAR_FX_WEBM)
        .atLocation(tileObj)
        .sound()
        .file(CLEAR_SFX_OGG)
        .volume(0.9)
        .play();
    } catch (e) {
      warn("Tile FX error:", e);
    }
  };

  const resetPromptButton = (messageId) => {
  try {
    const el = document.querySelector(`li.chat-message[data-message-id="${messageId}"]`);
    if (!el) return;
    const btn = el.querySelector("button.tr-tilefe-roll");
    if (!btn) return;
    btn.disabled = false;
    btn.textContent = "Roll!";
  } catch (_) {}
};


  const onClaim = async (payload) => {
    if (!payload) return;
    if (!isAuthorityClient()) return;

    const message = game.messages?.get(payload.messageId) || null;
    if (!message) return;

    const data = message.getFlag(MODULE_ID, "oniTRTilePrompt");
    if (!data) return;

    // Already claimed?
    if (data.claimedByUserId) {
      replyClaimResult(payload.userId, {
        ok: false,
        reason: "already-claimed",
        claimedByName: data.claimedByName,
        messageId: message.id,
      });
      return;
    }

    // Still not consumed?
    try {
      const tileDoc = await fromUuid(data.tileUuid);
      const consumed = tileDoc?.getFlag(MODULE_ID, "trTileConsumed");
      if (consumed) {
        replyClaimResult(payload.userId, { ok: false, reason: "tile-consumed", messageId: message.id });
        return;
      }
    } catch (_) {}

    // Accept claim
    const newData = {
      ...data,
      claimedByUserId: payload.userId,
      claimedByActorUuid: payload.recipientActorUuid,
      claimedByName: payload.userName,
    };

    const newContent = buildPromptHtml({
      titleText: `${newData.rouletteType} Tile`,
      iconSrc: newData.iconSrc,
      buttonLabel: "Rolling...",
      disabled: true,
      claimedText: `Claimed by ${newData.claimedByName}.`,
    });

    await message.update({
      content: newContent,
      flags: { [MODULE_ID]: { oniTRTilePrompt: newData } },
    });

    // Consume the tile immediately (player clicked Roll):
    // - Deactivate the tile (Monk Active Tiles "Active" checkbox OFF)
    // - Turn it into a Blank Tile
    // - Play your ClearTile smoke puff + door sound (broadcast to all clients)
    await clearTileVisualAndDisable(newData.tileUuid);

    replyClaimResult(payload.userId, { ok: true, messageId: message.id });

    // Start TreasureRoulette Core
    const core = getCore();
    if (!core?.request) {
      ui.notifications.error("[TreasureRoulette] Core not found: window['oni.TreasureRoulette.Core'].");
      return;
    }

    const tileType = newData.tileType;
    const consumeResults =
      (tileType in CONSUME_RESULTS_BY_TYPE ? CONSUME_RESULTS_BY_TYPE[tileType] : DEFAULT_CONSUME_RESULTS) || false;

    // Mirror your known-good test request shape as closely as possible.
    const req = {
      tableUuid: newData.tableUuid,
      recipient: { actorUuid: payload.recipientActorUuid },
      rouletteType: newData.rouletteType,
      pool: { poolSize: DEFAULT_POOL_SIZE },
      consumeResults,
      authorityMode: "gmOnly",
      visibility: "all",
      ui: { spinMs: DEFAULT_SPIN_MS },

      // Still include roller info (useful for logs + AwardDispatcher requestedByUserId)
      roller: { userId: payload.userId, actorUuid: payload.recipientActorUuid },

      // Extra context for downstream scripts (safe to ignore)
      meta: {
        source: "TileFrontEnd",
        tileUuid: newData.tileUuid,
        tileId: newData.tileId,
        sceneId: newData.sceneId,
        messageId: message.id,
        tileType: newData.tileType
      }
    };

    log("Starting Core.request:", req);

    let res = null;
    try {
      res = await core.request(req);
    } catch (e) {
      console.error("[TR TileFE] Core.request threw:", e);
      ui.notifications.error("[TreasureRoulette] Failed to start roulette. See console.");
      // Leave tile un-consumed; player can re-trigger by stepping again (or GM can delete the prompt message).
      return;
    }

    if (!res?.ok) {
      console.warn("[TR TileFE] Core.request returned not-ok:", res);
      ui.notifications.warn("[TreasureRoulette] Roulette request was rejected (see console).");
      // Leave tile un-consumed.
      return;
    }

    const requestId = res.requestId || req.requestId || null;
    if (requestId) {
      tileByRequestId.set(requestId, { tileUuid: newData.tileUuid, messageId: message.id });

      // Optional: mark tile in-progress (debug)
      try {
        const tileDoc = await fromUuid(newData.tileUuid);
        if (tileDoc) {
          await tileDoc.setFlag(MODULE_ID, "trTileInProgress", true);
          await tileDoc.setFlag(MODULE_ID, "trTileRequestId", requestId);
        }
      } catch (_) {}
    }

    log("Core.request accepted:", { requestId, routed: !!res.routed });
  };

  ensureSocketListener();

  // ---------------------------------------------------------------------------
  // COMPLETION: clear tile after award is done
  // ---------------------------------------------------------------------------
  const __oniTR_onCompleted = async (data) => {
    try {
      if (!isAuthorityClient()) return;

      const requestId = data?.requestId || data?.packet?.requestId || null;
      if (!requestId) return;

      const entry = tileByRequestId.get(requestId);
      if (!entry) return;

      tileByRequestId.delete(requestId);

      // Tile is consumed immediately when the Roll button is pressed.
      // We keep this hook only as a no-op cleanup point.
    } catch (e) {
      warn("TR:COMPLETED handler failed:", e);
    }
  };

  Hooks.on("TR:COMPLETED", __oniTR_onCompleted);
  Hooks.on("oni.TR:COMPLETED", __oniTR_onCompleted);


  // ---------------------------------------------------------------------------
  // PUBLIC API
  // ---------------------------------------------------------------------------
  window[KEY] = {
    onDbEnterTile,
    _debug: {
      detectTileType,
      rouletteTypeFromTileType,
      tableUuidFromTileType,
      clearTileVisualAndDisable,
      tileByRequestId,
    },
  };

  log("Installed.");
})();
