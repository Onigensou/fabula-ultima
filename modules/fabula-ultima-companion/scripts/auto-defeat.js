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
 *  Who acts (2026-11-04): ONE client — the primary GM — and only while no
 *  Battle Director battle is hosted (defeat-reactor.js owns defeats then, on
 *  every client). Players used to send AUTO_DEFEAT_REQUEST and the GM ran the
 *  defeat once per client: the "Token ... does not exist!" double delete.
 *  No chat card; the defeat itself is the BD's (playDefeat: FF7 red fade by rank).
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

  // The one client that acts: the primary GM, and nobody while a Battle Director
  // battle is hosted anywhere (its defeat reactor owns defeats then).
  function shouldAct() {
    if (!game.user?.isGM) return false;
    const primary = globalThis.FUCompanion?.isPrimaryGM;
    if (typeof primary === "function" && !primary()) return false;
    const bd = globalThis.FUCompanion?.api?.experimental?.battleDirector;
    try { if (bd?.host?.()?.hostUserId || bd?.isRunning?.()) return false; } catch {}
    return true;
  }

  // Tokens being defeated — one run per token, whatever repeats the HP write.
  const inFlight = new Set();

  // The auto-defeat option, read off the game DB (slow on a loaded client), kept
  // for a minute: it is a campaign setting, not something that flips mid-fight.
  const OPTION_TTL_MS = 60000;
  let optionCache = null;   // { value, at }

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
    const tokenDoc = tokenLike?.document ?? tokenLike; // if Token, .document is TokenDocument
    const scene = tokenDoc?.parent;

    if (!tokenDoc?.id || !scene?.id) {
      warn("performDefeat aborted: invalid tokenDoc or scene.", { tokenDoc, scene });
      return;
    }
    const uuid = tokenDoc.uuid;
    if (inFlight.has(uuid)) {
      log("Defeat already running for this token -> skip:", tokenDoc.name);
      return;
    }
    inFlight.add(uuid);

    log("GM performing defeat:", {
      scene: scene.name,
      token: tokenDoc.name,
      tokenId: tokenDoc.id,
    });

    // Note: creature_defeated reaction emit is now owned by
    // scripts/creature-defeated-emitter.js, which fires on the universal
    // HP->0 transition (regardless of disposition/rank). Auto-defeat keeps
    // only the physical-removal pipeline below.

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

    const removeTokenFromCombatIfNeeded = async (tokenDocToRemove) => {
      const activeCombat = getActiveCombatOnActiveScene();
      if (!activeCombat) return;

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

    try {
      // The Battle Director's defeat (FF7 red fade by rank, a monster's own
      // Battle Defeat style, KO fall), played on every client.
      const bd = globalThis.FUCompanion?.api?.experimental?.battleDirector;
      if (typeof bd?.playDefeat === "function") await bd.playDefeat(tokenDoc);

      // Only if nothing else took it meanwhile — a second delete is a server error.
      if (!scene.tokens?.has(tokenDoc.id)) {
        log("Token already gone after the defeat -> nothing to delete:", tokenDoc.name);
        return;
      }
      await removeTokenFromCombatIfNeeded(tokenDoc);
      await tokenDoc.delete();
      log("Defeat completed -> token deleted (after animation).");
    } catch (e) {
      err("performDefeat failed:", e);
      ui.notifications?.error(`Auto Defeat failed for ${tokenDoc.name}.`);
    } finally {
      inFlight.delete(uuid);
    }
  }

  async function autoDefeatOptionOn() {
    if (optionCache && performance.now() - optionCache.at < OPTION_TTL_MS) return optionCache.value;
    const db = await resolveDatabaseActor();
    if (!db) {
      warn("No database actor resolved -> skip.");
      return false;
    }
    const opt = get(db, PATH_DB_OPTION);
    const value = parseDbOption(opt);
    log("DB option check:", {
      dbActor: `${db.name} (${db.id})`,
      optionPath: PATH_DB_OPTION,
      rawValue: opt,
      enabled: value,
    });
    optionCache = { value, at: performance.now() };
    return value;
  }

  // -------------------------
  // Main Gate Pipeline
  // -------------------------
  async function tryAutoDefeatForActor(actor, updateData, options, userId) {
    if (!actor) return;
    if (!shouldAct()) return;

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
    if (!(await autoDefeatOptionOn())) return;

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
    installHooks();
    log("Auto Defeat system READY.");
  });
})();
