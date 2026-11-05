/**
 * Fabula Ledger — detectors (step 2)
 *
 * File: scripts/fabula-ledger/fl-detect.js
 *
 * Turns "a villain appeared" into ledger reports. The ledger decides; these
 * only notice. Which detector applies depends on the scene mode
 * (flags.<module>.oniFabula.general.sceneMode):
 *
 *   exploration        PLAYER CAMERA. Each player client reports a villain
 *                      token when its centre enters that player's view and
 *                      the player's vision can see it. The GM's camera never
 *                      counts. (User, 2026-11-05: a pre-placed villain pays
 *                      when the party walks up to it, not on map load.)
 *   any battle         BATTLE. Tokens the Battle Director spawns (flag
 *                      directorSpawned) are never reported on creation; most
 *                      battle maps are NOT sceneMode "conflict", so the flag is
 *                      the signal. Conflict-mode scenes also skip presence.
 *                      When a battle
 *                      starts (fu-director-started, after the entrance), the
 *                      host GM reports the hostile villains (inBattle) and the
 *                      boss point (any Champion enemy except Never). Reinforcements
 *                      that appear mid-battle are reported as they show, and a
 *                      Champion among them pays the boss point if none has yet.
 *   title, gacha       nothing.
 *   everything else    PRESENCE (primary GM). A villain token created or
 *   (theatre, camp,    unhidden on the ACTIVE scene, and every visible villain
 *    dungeon, none…)   token when a scene becomes active.
 *
 *   Theatre Inserts    any mode: a portrait ENTERING the stage, reported by the
 *                      client that brought it up (libWrapper on
 *                      Theatre.prototype.injectLeftPortrait / injectRightPortrait,
 *                      remote = false). If the wrap cannot attach (Theatre
 *                      missing or renamed), the GM gets one warning and the
 *                      rest still works.
 */
(() => {
  const TAG = "[FabulaLedger][Detect]";
  const MODULE_ID = "fabula-ultima-companion";
  const FL = globalThis.FabulaLedger = globalThis.FabulaLedger || {};
  const api = () => FL.api;
  const isPrimaryGM = () => globalThis.FUCompanion?.isPrimaryGM?.() ?? game.user?.isGM ?? false;
  const debug = (...a) => console.debug(TAG, ...a);

  const HOSTILE = -1, FRIENDLY = 1;
  const CAMERA_THROTTLE_MS = 250;

  const sceneMode = (scene) =>
    String(scene?.flags?.[MODULE_ID]?.oniFabula?.general?.sceneMode ?? "").trim().toLowerCase();
  const detectorFor = (scene) => {
    const m = sceneMode(scene);
    if (m === "exploration") return "camera";
    if (m === "conflict") return "battle";
    if (m === "title" || m === "gacha") return "none";
    return "presence";
  };

  const bdRunning = () => { try { return !!globalThis.FUCompanion?.api?.experimental?.battleDirector?.isRunning?.(); } catch { return false; } };

  function tokenAppearance(doc, extra = {}) {
    return {
      actorId: doc.actorId, source: "token", tokenId: doc.id, sceneId: doc.parent?.id ?? null,
      x: doc.x, y: doc.y, img: String(doc.texture?.src ?? "").includes("*") ? "" : (doc.texture?.src ?? ""),
      ...extra
    };
  }

  // On the GM every world actor is readable, so the pre-filter is exact.
  const gmCandidate = (doc) => !!doc?.actorId && api()?.isCandidate?.(doc.actorId);

  // Tokens the Battle Director spawns carry this flag. Only 6 of 19 battle maps
  // are sceneMode "conflict", so the flag, not the mode, is what marks a battle
  // token: they are reported by the battle detector after the entrance (or as
  // reinforcements once the battle runs), never on creation.
  const isBattleToken = (doc) => !!doc?.getFlag?.(MODULE_ID, "directorSpawned");

  // ── presence (primary GM) ──────────────────────────────────────────────────
  function presenceReport(doc) {
    const scene = doc?.parent;
    if (!scene?.active || doc.hidden || detectorFor(scene) !== "presence") return;
    if (isBattleToken(doc)) return;
    if (!gmCandidate(doc)) return;
    api()?.report?.(tokenAppearance(doc));
  }

  function sweepScene(scene) {
    if (!isPrimaryGM() || !scene?.active || detectorFor(scene) !== "presence") return;
    if (bdRunning()) return;   // a battle's own detector covers its scene
    for (const doc of scene.tokens ?? []) presenceReport(doc);
  }

  // Battle arrivals are noticed by the GM HOSTING the battle (only that client
  // knows the director is running); the ledger forwards to the primary GM.
  // Everything else is noticed by the primary GM.
  const isBattleDoc = (doc) => isBattleToken(doc) || detectorFor(doc.parent) === "battle";

  Hooks.on("createToken", (doc) => {
    if (!game.user?.isGM) return;
    if (isBattleDoc(doc)) return battleReinforcement(doc);
    if (isPrimaryGM()) presenceReport(doc);
  });

  Hooks.on("updateToken", (doc, changes) => {
    if (!game.user?.isGM || changes?.hidden !== false) return;
    if (isBattleDoc(doc)) return battleReinforcement(doc);
    if (isPrimaryGM()) presenceReport(doc);
  });

  // A scene becoming active is a new visit (fl-ledger.js); sweep it after.
  Hooks.on("updateScene", (scene, changes) => {
    if (changes?.active !== true || !isPrimaryGM()) return;
    setTimeout(() => sweepScene(game.scenes?.get(scene.id)), 400);
  });

  // ── battle (Battle Director host GM) ───────────────────────────────────────
  // The host is whichever GM runs the director; the ledger forwards to the
  // primary GM when they differ.
  function battleTokens(scene) {
    return [...(scene?.tokens ?? [])].filter(t => t.disposition === HOSTILE && !t.hidden && t.actorId);
  }

  // This client runs the battle (the director's host GM).
  function amBattleHost() {
    if (!game.user?.isGM) return false;
    const host = globalThis.FUCompanion?.api?.experimental?.battleDirector?.host?.();
    return host ? host.amHost !== false : isPrimaryGM();
  }

  Hooks.on("fu-director-started", () => {
    _battleLive = true;
    if (!amBattleHost()) return;
    const scene = game.scenes?.active ?? canvas?.scene;
    if (!scene) return;
    // A beat after the entrance so the tab does not land on the BATTLE START banner.
    setTimeout(() => {
      const enemies = battleTokens(scene);
      for (const doc of enemies) if (gmCandidate(doc)) api()?.report?.(tokenAppearance(doc, { inBattle: true }));
      api()?.bossFight?.({ enemyActorIds: [...new Set(enemies.map(t => t.actorId))] });
    }, 600);
  });

  // "Live" only between fu-director-started and fu-director-stopped. The
  // director already reports isRunning() while its entrance is still playing and
  // the starting enemies spawn, so those spawns came through here ~30 s early
  // (sandbox timing 2026-11-05) and could pay during the cinematic. The start
  // hook covers the starting roster; this path is for later arrivals only.
  let _battleLive = false;
  Hooks.on("fu-director-stopped", () => { _battleLive = false; });

  function battleReinforcement(doc) {
    if (!_battleLive || !amBattleHost() || !bdRunning() || doc.disposition !== HOSTILE || doc.hidden || !doc.parent?.active) return;
    // A Champion joining mid-battle is a boss appearing: the boss point, if this
    // visit hasn't paid one yet (a fight that started with only soldiers).
    if (doc.actorId) api()?.bossFight?.({ enemyActorIds: [doc.actorId] });
    if (!gmCandidate(doc)) return;
    api()?.report?.(tokenAppearance(doc, { inBattle: true }));
  }

  // ── camera (player clients, exploration mode) ──────────────────────────────
  const _seen = new Set();          // token ids already reported on this canvas
  let _camTimer = null;

  // A player client may not hold every world actor. Use the status when it
  // can read it; otherwise report any token that is not friendly and let the
  // GM decide (still once per token per scene).
  function playerCandidate(doc) {
    if (!doc?.actorId || doc.disposition === FRIENDLY) return false;
    const a = game.actors?.get(doc.actorId);
    if (!a) return true;
    return api()?.isCandidate?.(a) ?? true;
  }

  function viewRect() {
    const stage = canvas?.stage;
    if (!stage) return null;
    const sidebar = document.getElementById("sidebar")?.getBoundingClientRect?.();
    const right = sidebar && sidebar.width > 0 ? Math.min(window.innerWidth, sidebar.left) : window.innerWidth;
    const tl = stage.toLocal(new PIXI.Point(0, 0));
    const br = stage.toLocal(new PIXI.Point(right, window.innerHeight));
    return { x0: tl.x, y0: tl.y, x1: br.x, y1: br.y };
  }

  function cameraCheck() {
    _camTimer = null;
    if (game.user?.isGM || !canvas?.ready) return;
    const scene = canvas.scene;
    if (!scene?.active || detectorFor(scene) !== "camera") return;
    const r = viewRect();
    if (!r) return;
    for (const token of canvas.tokens?.placeables ?? []) {
      const doc = token.document;
      if (_seen.has(doc.id) || doc.hidden || !token.visible || isBattleToken(doc)) continue;
      if (!playerCandidate(doc)) continue;
      const c = token.center;
      if (c.x < r.x0 || c.x > r.x1 || c.y < r.y0 || c.y > r.y1) continue;
      _seen.add(doc.id);
      debug("in view", doc.name);
      api()?.report?.(tokenAppearance(doc));
    }
  }

  function scheduleCamera() {
    if (game.user?.isGM || _camTimer) return;
    _camTimer = setTimeout(cameraCheck, CAMERA_THROTTLE_MS);
  }

  Hooks.on("canvasReady", () => { _seen.clear(); scheduleCamera(); });
  Hooks.on("canvasPan", scheduleCamera);
  Hooks.on("refreshToken", scheduleCamera);
  Hooks.on("updateToken", scheduleCamera);
  Hooks.on("createToken", scheduleCamera);
  Hooks.on("sightRefresh", scheduleCamera);

  // ── fumbles (+1 to the PC who fumbled) ─────────────────────────────────────
  // Two places a Check is final:
  //  • Check Requester (exploration, events, any non-battle check): emits
  //    creature_fumbles_check on the GM after invokes are spent (cr-api.js
  //    emitCheckReactions). Only kind "check_requester": the legacy reaction
  //    window re-emits battle cards on F5 and must not pay again.
  //  • Battle Director: there is no native fumble event in battle, but a fumble
  //    always misses, and the attacker-side "I missed" trigger
  //    (creature_miss_action, once per action, after resolve) carries the final
  //    isFumble. It reaches observers through the read-only fu-director-trigger
  //    hook, on the client running the director.
  // The ledger pays party members only and drops a second report within 1.5 s.
  const actorFromUuid = (uuid) => {
    if (!uuid) return null;
    try { const d = fromUuidSync(uuid); return d?.actor ?? d ?? null; } catch { return null; }
  };

  Hooks.on("oni:reactionPhase", (p) => {
    if (!game.user?.isGM || p?.trigger !== "creature_fumbles_check" || p?.kind !== "check_requester") return;
    const a = actorFromUuid(p.actorUuid ?? p.checkActorUuid);
    if (a) api()?.fumble?.(a, { via: "check" });
  });

  Hooks.on("fu-director-trigger", ({ casterActor, trigger, payload } = {}) => {
    if (!game.user?.isGM || trigger !== "creature_miss_action" || !payload?.isFumble) return;
    const a = casterActor ?? actorFromUuid(payload.attackerActorUuid ?? payload.sourceActorUuid);
    if (a) api()?.fumble?.(a, { via: "battle" });
  });

  // ── Theatre Inserts ────────────────────────────────────────────────────────
  let _theatreDepth = 0;   // inject Left/Right call each other; report once

  async function theatreWrapper(wrapped, imgPath, portName, imgId, optAlign, emotions, remote, ...rest) {
    const had = !!this.getInsertById?.(imgId);
    _theatreDepth++;
    let result;
    try { result = await wrapped(imgPath, portName, imgId, optAlign, emotions, remote, ...rest); }
    finally { _theatreDepth--; }
    try {
      if (_theatreDepth === 0 && !remote && !had && this.getInsertById?.(imgId)) {
        const actorId = String(imgId ?? "").replace(/^theatre-/, "");
        const actor = game.actors?.get(actorId);
        if (actor && (game.user?.isGM ? api()?.isCandidate?.(actor) : true)) {
          debug("theatre portrait", actor.name);
          api()?.report?.({ actorId, source: "theatre" });
        }
      }
    } catch (e) { console.warn(TAG, "theatre report failed", e); }
    return result;
  }

  let _theatreWrapped = false;
  function wrapTheatre() {
    if (_theatreWrapped) return true;
    const proto = globalThis.Theatre?.prototype;
    if (!proto?.injectLeftPortrait || !proto?.injectRightPortrait) return false;
    const lw = globalThis.libWrapper;
    for (const name of ["injectLeftPortrait", "injectRightPortrait"]) {
      if (lw?.register) {
        lw.register(MODULE_ID, `Theatre.prototype.${name}`, theatreWrapper, "WRAPPER");
      } else {
        const orig = proto[name];
        proto[name] = function (...args) { return theatreWrapper.call(this, (...a) => orig.apply(this, a), ...args); };
      }
    }
    _theatreWrapped = true;
    debug("Theatre portrait entry wrapped", lw?.register ? "(libWrapper)" : "(direct)");
    return true;
  }

  Hooks.once("ready", () => {
    if (!game.modules?.get("theatre")?.active) return;
    // window.Theatre appears when the chat log first renders; give it a moment.
    let tries = 0;
    const attempt = () => {
      if (wrapTheatre()) return;
      if (++tries < 20) return setTimeout(attempt, 500);
      console.warn(TAG, "Theatre Inserts is active but its portrait methods were not found.");
      if (isPrimaryGM()) ui.notifications?.warn?.("Fabula Ledger: Theatre portraits can't be detected (Theatre Inserts changed). Use Villain Entrance or the Cameo key instead.");
    };
    attempt();
  });

  FL.Detect = { detectorFor, sweepScene, cameraCheck, viewRect, wrapTheatre, _seen };
  console.debug(TAG, "installed");
})();
