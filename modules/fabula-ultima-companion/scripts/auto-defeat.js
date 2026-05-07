/* ============================================
 *  ONI - Auto Defeat System (Foundry V12)
 *  File: auto-defeat.js
 * ============================================
 *  DB Resolver:
 *    await window.FUCompanion.api.getCurrentGameDb()
 *
 *  Gates:
 *   - DB option: system.props.option_autoDefeat enabled
 *   - Token disposition enemy: -1
 *   - Actor must have npc_rank (missing => skip)
 *   - npc_rank must be Soldier or Elite (never Champion)
 *   - token_option_persist true => skip
 *
 *  Debug toggle:
 *   globalThis.ONI_AUTO_DEFEAT_DEBUG = true/false
 * ============================================ */

(() => {
  // -------------------------
  // Debug Toggle
  // -------------------------
  const DEBUG =
    typeof globalThis.ONI_AUTO_DEFEAT_DEBUG === "boolean"
      ? globalThis.ONI_AUTO_DEFEAT_DEBUG
      : false;

  const TAG = "[ONI][AutoDefeat]";
  const log = (...a) => DEBUG && console.log(TAG, ...a);
  const warn = (...a) => DEBUG && console.warn(TAG, ...a);
  const err = (...a) => DEBUG && console.error(TAG, ...a);

  // -------------------------
  // Config
  // -------------------------
  const MODULE_ID = "fabula-ultima-companion";
  const SOCKET_NS = `module.${MODULE_ID}`;

  const PATH_DB_OPTION = "system.props.option_autoDefeat";
  const PATH_HP = "system.props.current_hp";
  const PATH_MAX_HP = "system.props.max_hp";

  const PATH_NPC_RANK = "system.props.npc_rank";
  const PATH_TOKEN_PERSIST = "system.props.token_option_persist";

  // -------------------------
  // Helpers
  // -------------------------
  function get(obj, path, fallback = undefined) {
    try {
      const v = foundry.utils.getProperty(obj, path);
      return v ?? fallback;
    } catch {
      return fallback;
    }
  }

  function toNumber(value, fallback = null) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function getHpSnapshot(actor) {
    if (!actor) return { cur: null, max: null };

    const sys = actor.system ?? {};
    const props = sys.props ?? {};

    const cur = toNumber(
      props.current_hp ??
      sys.current_hp ??
      sys.attributes?.hp?.value ??
      sys.hp?.value,
      null
    );

    const max = toNumber(
      props.max_hp ??
      sys.max_hp ??
      sys.attributes?.hp?.max ??
      sys.hp?.max,
      null
    );

    return { cur, max };
  }

  function parseDbOption(value) {
    if (typeof value === "boolean") return value;
    if (value == null) return false;
    const s = String(value).trim().toLowerCase();
    return s === "on" || s === "true" || s === "1" || s === "yes" || s === "enabled";
  }

  function normalizeRank(v) {
    return String(v ?? "").trim().toLowerCase();
  }

  function isAllowedRank(rank) {
    const r = normalizeRank(rank);
    if (!r) return false;
    if (r === "champion") return false;
    return r === "soldier" || r === "elite";
  }

  function hpUpdateDetected(updateData) {
    const flat = foundry.utils.flattenObject(updateData ?? {});
    const keys = Object.keys(flat);
    const hit = keys.some((k) => k.includes("current_hp"));
    return { hit, keys };
  }

  /**
   * ✅ Bulletproof disposition getter (Foundry v12 safe)
   *
   * tokenLike can be:
   * - Token (placeable object) -> has .document (TokenDocument)
   * - TokenDocument -> has .disposition
   */
  function getDisposition(tokenLike) {
    // Case A: TokenDocument
    if (tokenLike?.documentName === "Token" && typeof tokenLike?.disposition !== "undefined") {
      return tokenLike.disposition;
    }

    // Case B: placeable Token
    if (tokenLike?.document && typeof tokenLike.document.disposition !== "undefined") {
      return tokenLike.document.disposition;
    }

    // Case C: sometimes Token has direct .disposition getter (rare but possible)
    if (typeof tokenLike?.disposition !== "undefined") {
      return tokenLike.disposition;
    }

    return undefined;
  }

  function debugDispositionFailure(tokenLike) {
    if (!DEBUG) return;
    const tokenDoc = tokenLike?.document ?? tokenLike;

    log("Disposition debug dump:", {
      tokenLikeClass: tokenLike?.constructor?.name,
      tokenLikeDocumentName: tokenLike?.documentName,
      tokenLikeHasDocument: !!tokenLike?.document,
      tokenDocClass: tokenDoc?.constructor?.name,
      tokenDocDocumentName: tokenDoc?.documentName,
      tokenDocHasDispositionProp: tokenDoc ? Object.prototype.hasOwnProperty.call(tokenDoc, "disposition") : false,
      tokenDocDispositionValue: tokenDoc?.disposition,
      tokenLikeDispositionValue: tokenLike?.disposition,
      tokenLikeDocumentDispositionValue: tokenLike?.document?.disposition,
      tokenName: tokenDoc?.name ?? tokenLike?.name,
      tokenId: tokenDoc?.id ?? tokenLike?.id,
    });

    // Also try to print a compact key list (helpful for synthetic edge cases)
    try {
      const keys = Object.keys(tokenLike ?? {});
      log("tokenLike keys (first 30):", keys.slice(0, 30));
    } catch {}
  }

  // -------------------------
  // Reaction System Integration
  // -------------------------
  function emitReactionPhase(payload) {
    try {
      if (globalThis?.ONI?.emit) {
        globalThis.ONI.emit("oni:reactionPhase", payload, { local: true, world: false });
        return;
      }
    } catch (_e) {}

    try {
      Hooks.callAll?.("oni:reactionPhase", payload);
    } catch (_e) {
      warn("Could not emit oni:reactionPhase (no ONI.emit or Hooks.callAll).", payload);
    }
  }

  function buildDefeatReactionPayload(tokenDoc, actor, extra = {}) {
    return {
      trigger: "creature_defeated",
      tokenUuid: tokenDoc?.uuid ?? null,
      targetUuid: tokenDoc?.uuid ?? null,
      targets: tokenDoc?.uuid ? [tokenDoc.uuid] : [],
      actorUuid: actor?.uuid ?? null,
      targetActorUuid: actor?.uuid ?? null,
      defeatedTokenUuid: tokenDoc?.uuid ?? null,
      defeatedActorUuid: actor?.uuid ?? null,
      hpCur: extra?.hpCur ?? null,
      hpMax: extra?.hpMax ?? null,
      source: "auto-defeat",
      sceneId: tokenDoc?.parent?.id ?? null,
      tokenId: tokenDoc?.id ?? null,
      actorId: actor?.id ?? null,
      timestamp: Date.now()
    };
  }

  // -------------------------
  // DB Resolver
  // -------------------------
  async function resolveDatabaseActor() {
    const api = globalThis?.FUCompanion?.api || window?.FUCompanion?.api;

    if (!api || typeof api.getCurrentGameDb !== "function") {
      warn("FUCompanion.api.getCurrentGameDb() not found. Check load order for db-resolver.");
      return null;
    }

    try {
      const resolved = await api.getCurrentGameDb();
      const db = resolved?.db ?? null;

      log("DB resolved via getCurrentGameDb():", {
        gameName: resolved?.gameName ?? null,
        db: db ? `${db.name} (${db.id})` : null,
        source: resolved?.source ? `${resolved.source.name} (${resolved.source.id})` : null,
        rawGameId: resolved?.rawGameId ?? null,
      });

      return db;
    } catch (e) {
      err("getCurrentGameDb() failed:", e);
      return null;
    }
  }

  // -------------------------
  // Defeat Operation
  // -------------------------
  async function performDefeat(tokenLike) {
    // Normalize: tokenLike can be Token (placeable) or TokenDocument
    const token = tokenLike?.object ?? tokenLike; // if TokenDocument, .object is the placeable
    const tokenDoc = tokenLike?.document ?? tokenLike; // if Token, .document is TokenDocument
    const scene = tokenDoc?.parent;
    const actor = tokenDoc?.actor ?? token?.actor ?? null;

    if (!tokenDoc?.id || !scene?.id) {
      warn("performDefeat aborted: invalid tokenDoc or scene.", { tokenDoc, scene });
      return;
    }

    // Non-GM -> request GM (deleting/combat edits must be GM)
    if (!game.user.isGM) {
      log("Not GM -> sending AUTO_DEFEAT_REQUEST via socket:", {
        sceneId: scene.id,
        tokenId: tokenDoc.id,
        tokenName: tokenDoc.name,
      });

      game.socket.emit(SOCKET_NS, {
        type: "AUTO_DEFEAT_REQUEST",
        sceneId: scene.id,
        tokenId: tokenDoc.id,
      });
      return;
    }

    // Need the placeable token for Sequencer .on(token)
    if (!token) {
      warn("performDefeat aborted: TokenDocument has no placeable object (not rendered?).", {
        tokenId: tokenDoc.id,
        sceneId: scene.id,
      });
      return;
    }

    log("GM performing defeat:", {
      scene: scene.name,
      token: tokenDoc.name,
      tokenId: tokenDoc.id,
    });

    // Emit Reaction trigger BEFORE the token is removed from combat / scene.
    // This lets creature_defeated share the same resolution window as damage/crisis.
    try {
      const hp = getHpSnapshot(actor);
      const reactionPayload = buildDefeatReactionPayload(tokenDoc, actor, {
        hpCur: hp.cur,
        hpMax: hp.max
      });

      emitReactionPhase(reactionPayload);
      log("Emitted Reaction trigger: creature_defeated", reactionPayload);
    } catch (e) {
      warn("Failed to emit creature_defeated Reaction trigger (continuing auto-defeat):", e);
    }

    // --- Combat detection + removeTokenFromCombatIfNeeded (copied behavior style from Defeated.js) ---
    const getActiveCombatOnActiveScene = () => {
      const activeScene = canvas?.scene ?? null;
      const activeSceneId = activeScene?.id ?? null;

      const combats = game.combats?.contents ?? [];
      const matches = activeSceneId ? combats.filter(c => c.scene?.id === activeSceneId) : [];

      const picked =
        matches.find(c => (typeof c.started === "boolean" ? c.started : Number(c.round ?? 0) > 0)) ??
        matches.find(c => (typeof c.active === "boolean" ? c.active : false)) ??
        matches.find(c => (c.combatants?.size ?? 0) > 0) ??
        null;

      return picked;
    };

    const activeCombat = getActiveCombatOnActiveScene();
    const isInCombatOnThisScene = !!activeCombat;

    const removeTokenFromCombatIfNeeded = async (tokenDocToRemove) => {
      if (!isInCombatOnThisScene || !activeCombat) return;

      const combatant =
        activeCombat.combatants?.find(c => c.tokenId === tokenDocToRemove.id) ??
        null;

      if (!combatant) return;

      try {
        await activeCombat.deleteEmbeddedDocuments("Combatant", [combatant.id]);
      } catch (e) {
        console.warn(`${TAG} Failed to remove combatant for token "${tokenDocToRemove.name}"`, e);
      }
    };

    // --- EXACT animation chain from your Defeated.js (no dialog, auto-run) ---
    try {
      await new Sequence()
        .sound("https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Enemy_Death.ogg")
        .animation().on(token).tint("#ff0000").waitUntilFinished()
        .animation().on(token).fadeOut(1000).waitUntilFinished()
        .thenDo(async () => {
          // 1) remove from combat first
          await removeTokenFromCombatIfNeeded(tokenDoc);

          // 2) delete token AFTER animation
          await tokenDoc.delete();

          // 3) chat message
          ChatMessage.create({ content: `<b>${token.name}</b> was defeated!` });

          log("Defeat completed -> token deleted (after animation).");
        })
        .play();
    } catch (e) {
      err("performDefeat failed:", e);
      ui.notifications?.error(`Auto Defeat failed for ${tokenDoc.name}.`);
    }
  }

  // -------------------------
  // Main Gate Pipeline
  // -------------------------
  async function tryAutoDefeatForActor(actor, updateData, options, userId) {
    if (!actor) return;

    const hpGate = hpUpdateDetected(updateData);
    if (!hpGate.hit) return;

    const hp = Number(get(actor, PATH_HP, NaN));
    log("updateActor detected (HP related):", {
      actor: `${actor.name} (${actor.id})`,
      userId,
      newHp: hp,
      changedKeys: hpGate.keys,
    });

    if (!Number.isFinite(hp) || hp !== 0) return;

    // DB option gate
    const db = await resolveDatabaseActor();
    if (!db) {
      warn("No database actor resolved -> skip.");
      return;
    }

    const opt = get(db, PATH_DB_OPTION);
    const enabled = parseDbOption(opt);

    log("DB option check:", {
      dbActor: `${db.name} (${db.id})`,
      optionPath: PATH_DB_OPTION,
      rawValue: opt,
      enabled,
    });

    if (!enabled) return;

    // Persist gate
    const persist = Boolean(get(actor, PATH_TOKEN_PERSIST, false));
    if (persist) {
      log("token_option_persist TRUE -> skip:", { actor: actor.name, persist });
      return;
    }

    // npc_rank must exist gate
    const npcRank = get(actor, PATH_NPC_RANK, undefined);
    if (npcRank === undefined || npcRank === null || String(npcRank).trim() === "") {
      log("npc_rank missing -> skip:", { actor: actor.name, npcRank });
      return;
    }

    // rank allowed gate
    if (!isAllowedRank(npcRank)) {
      log("Rank not eligible -> skip:", { actor: actor.name, npcRank });
      return;
    }

    // Active tokens + disposition gate
    const tokens = actor.getActiveTokens(true, true) ?? [];
    if (!tokens.length) {
      warn("HP hit 0 but no active tokens found -> skip.", actor.name);
      return;
    }

    log("Active tokens found for actor:", tokens.map((t) => `${t.name} (${t.id})`));

    for (const token of tokens) {
      const disposition = getDisposition(token);

      if (typeof disposition === "undefined") {
        warn("Disposition is undefined -> cannot evaluate enemy gate.");
        debugDispositionFailure(token);
        continue;
      }

      if (disposition !== -1) {
        log("Disposition not enemy (-1) -> skip token:", {
          token: token.name,
          disposition,
        });
        continue;
      }

      log("AUTO DEFEAT PASSED ALL GATES -> executing:", {
        token: token.name,
        actor: actor.name,
        npcRank,
        disposition,
      });

      await performDefeat(token);
    }
  }

  // -------------------------
  // Socket Listener (GM executes)
  // -------------------------
  function installSocketListener() {
    game.socket.off(SOCKET_NS, onSocketMessage);
    game.socket.on(SOCKET_NS, onSocketMessage);
    log("Socket listener installed:", SOCKET_NS);
  }

  async function onSocketMessage(payload) {
    try {
      if (!payload || payload.type !== "AUTO_DEFEAT_REQUEST") return;
      if (!game.user.isGM) return;

      const { sceneId, tokenId } = payload;
      const scene = game.scenes.get(sceneId);
      const tokenDoc = scene?.tokens?.get(tokenId);

      log("GM received AUTO_DEFEAT_REQUEST:", {
        sceneId,
        tokenId,
        hasScene: !!scene,
        hasToken: !!tokenDoc,
      });

      if (!scene || !tokenDoc) return;
      await performDefeat(tokenDoc);
    } catch (e) {
      err("Socket handler crashed:", e);
    }
  }

  // -------------------------
  // Hooks
  // -------------------------
  async function onUpdateActor(actor, updateData, options, userId) {
    await tryAutoDefeatForActor(actor, updateData, options, userId);
  }

  function installHooks() {
    Hooks.off("updateActor", onUpdateActor);
    Hooks.on("updateActor", onUpdateActor);
    log("Hook installed: updateActor");
  }

  // -------------------------
  // Boot
  // -------------------------
  Hooks.once("ready", () => {
    log("Booting Auto Defeat system...", { DEBUG });
    installSocketListener();
    installHooks();
    log("Auto Defeat system READY.");
  });
})();
