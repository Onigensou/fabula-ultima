/**
 * [Reaction] Protect Feedback.js
 * Foundry VTT v12
 * ---------------------------------------------------------------------------
 * PURPOSE
 * -------
 * Visual/audio feedback helper for Protect-style reactions that no longer create
 * a normal Action Card.
 *
 * What it does:
 * 1) Shows a passive-style card: "💥 Protect"
 * 2) Plays the Protect animation:
 *    - protector pseudo-moves in front of the protected ally
 *    - plays shield FX + SFX
 *    - returns
 *
 * API
 * ---
 * window["oni.ReactionProtectFeedback"] = {
 *   playFromRedirect(payload, redirectResult, opts),
 *   play(opts)
 * }
 */

Hooks.once("ready", () => {
  (() => {
    const KEY = "oni.ReactionProtectFeedback";
    if (window[KEY]) {
      console.log("[ReactionProtectFeedback] Already installed.");
      return;
    }

    const MODULE_ID = "fabula-ultima-companion";
    const TAG = "[ReactionProtectFeedback]";
    const DEBUG = true;

    const log = (...a) => DEBUG && console.log(TAG, ...a);
    const warn = (...a) => DEBUG && console.warn(TAG, ...a);
    const err = (...a) => DEBUG && console.error(TAG, ...a);

    function clone(value, fallback = null) {
      try {
        if (foundry?.utils?.deepClone) return foundry.utils.deepClone(value);
      } catch (_e) {}
      try {
        return structuredClone(value);
      } catch (_e) {}
      try {
        return JSON.parse(JSON.stringify(value));
      } catch (_e) {}
      return fallback;
    }

    function firstNonBlank(...values) {
      for (const value of values) {
        if (value == null) continue;
        const s = String(value).trim();
        if (s) return s;
      }
      return "";
    }

    function isUuid(v) {
      return typeof v === "string" && v.includes(".");
    }

    async function resolveDocument(uuidOrDoc) {
      if (!uuidOrDoc) return null;
      if (typeof uuidOrDoc !== "string") return uuidOrDoc;
      try {
        return await fromUuid(uuidOrDoc);
      } catch (_e) {
        return null;
      }
    }

    async function resolveActor(uuidOrDoc) {
      const doc = await resolveDocument(uuidOrDoc);
      if (!doc) return null;
      if (doc?.documentName === "Actor") return doc;
      if (doc?.actor) return doc.actor;
      if (doc?.object?.actor) return doc.object.actor;
      if (doc?.token?.actor) return doc.token.actor;
      if (doc?.document?.actor) return doc.document.actor;
      return null;
    }

    async function resolveToken(ref) {
      if (!ref) return null;

      if (ref?.document && ref?.object) return ref.object ?? ref;
      if (ref?.object && ref?.documentName === "Token") return ref.object;
      if (ref?.id && canvas.tokens?.get(ref.id)) return canvas.tokens.get(ref.id);

      if (typeof ref === "string") {
        if (canvas.tokens?.get(ref)) return canvas.tokens.get(ref);

        if (isUuid(ref)) {
          const doc = await fromUuid(ref);
          if (!doc) return null;

          if (doc?.object) return doc.object;
          if (doc?.document?.object) return doc.document.object;

          // Actor UUID fallback -> active token
          const actor =
            doc?.documentName === "Actor"
              ? doc
              : (doc?.actor ?? null);

          if (actor) {
            try {
              const active = actor.getActiveTokens?.(true, true) ?? actor.getActiveTokens?.() ?? [];
              if (active?.[0]) return active[0];
            } catch (_e) {}
          }

          return null;
        }
      }

      return null;
    }

    function ensureONIEmit() {
      globalThis.ONI = globalThis.ONI ?? {};
      if (!ONI.emit) {
        ONI.emit = function (eventName, payload = {}, options = {}) {
          const { local = true, world = false } = options;
          if (local) Hooks.callAll(eventName, payload);
          if (world) game.socket.emit("world", { action: eventName, payload });
        };
      }
    }

    function getPassiveCardBroadcastApi() {
      return (
        globalThis.FUCompanion?.api?.passiveCard?.broadcast ??
        game.modules?.get(MODULE_ID)?.api?.passiveCard?.broadcast ??
        globalThis.FUCompanion?.api?.passiveCardBroadcast ??
        null
      );
    }

    async function broadcastProtectCard({
      payload = {},
      protectorTokenUuid = null,
      protectorActorUuid = null,
      protectedTargetUuid = null,
      title = "💥 Protect",
      executionMode = "reaction_protect"
    } = {}) {
      const cardApi = getPassiveCardBroadcastApi();
      if (typeof cardApi !== "function") {
        warn("Passive card broadcast skipped (API missing)");
        return { ok: false, reason: "passive_card_api_missing" };
      }

      const actionContext = clone(payload, {}) || {};
      actionContext.meta = actionContext.meta || {};

      const attackerUuid =
        firstNonBlank(
          protectorActorUuid,
          protectorTokenUuid,
          actionContext?.meta?.attackerUuid,
          actionContext?.attackerUuid,
          actionContext?.attackerActorUuid
        ) || null;

      if (attackerUuid) {
        actionContext.meta.attackerUuid = attackerUuid;
        actionContext.attackerUuid = attackerUuid;
      }

      if (protectorActorUuid) {
        actionContext.attackerActorUuid = protectorActorUuid;
      }

      if (protectedTargetUuid) {
        actionContext.targets = [protectedTargetUuid];
        actionContext.originalTargetUUIDs = [protectedTargetUuid];
        actionContext.meta.originalTargetUUIDs = [protectedTargetUuid];
      }

      actionContext.meta.protectFeedback = {
        used: true,
        title,
        protectorTokenUuid: protectorTokenUuid || null,
        protectorActorUuid: protectorActorUuid || null,
        protectedTargetUuid: protectedTargetUuid || null
      };

      try {
        await cardApi({
          title,
          attackerUuid,
          actionContext,
          options: {
            executionMode
          }
        });

        log("PASSIVE CARD broadcast done", {
          title,
          attackerUuid,
          protectedTargetUuid
        });

        return {
          ok: true,
          title,
          attackerUuid
        };
      } catch (e) {
        warn("PASSIVE CARD broadcast failed", {
          title,
          attackerUuid,
          error: String(e?.message ?? e)
        });

        return {
          ok: false,
          reason: "passive_card_broadcast_failed",
          error: String(e?.message ?? e)
        };
      }
    }

    async function playProtectAnimation({
      protectorTokenUuid = null,
      protectedTargetUuid = null,
      fxScale = 0.3,
      moveOutMs = 220,
      holdMs = 2000,
      moveBackMs = 220,
      squares = 0.60
    } = {}) {
      try {
        if (!game.modules.get("sequencer")?.active) {
          warn("Sequencer module is not active; skipping Protect animation.");
          return { ok: false, reason: "sequencer_missing" };
        }

        if (!game.ONI?.pseudo?.play) {
          warn("ONI Pseudo Animation API not found; skipping Protect animation.");
          return { ok: false, reason: "oni_pseudo_missing" };
        }

        ensureONIEmit();

        const sourceToken = await resolveToken(protectorTokenUuid);
        const targetToken = await resolveToken(protectedTargetUuid);

        if (!sourceToken) {
          warn("Protect animation skipped - no protector token resolved.", {
            protectorTokenUuid
          });
          return { ok: false, reason: "missing_protector_token" };
        }

        if (!targetToken) {
          warn("Protect animation skipped - no protected target token resolved.", {
            protectedTargetUuid
          });
          return { ok: false, reason: "missing_protected_target_token" };
        }

        const casterDisposition =
          sourceToken?.actor?.document?.disposition ??
          sourceToken?.document?.disposition ??
          0;

        const targetDisposition =
          targetToken?.actor?.document?.disposition ??
          targetToken?.document?.disposition ??
          0;

        const casterHostile = casterDisposition === -1;
        const targetHostile = targetDisposition === -1;

        // Target hostile (-1) is on LEFT and faces RIGHT => front is RIGHT of target
        // Target friendly is on RIGHT and faces LEFT => front is LEFT of target
        const frontIsRightOfTarget = targetHostile;

        const offsetPx = (canvas.grid?.size ?? 100) * squares;

        const destFront = {
          x: targetToken.document.x + (frontIsRightOfTarget ? +offsetPx : -offsetPx),
          y: targetToken.document.y
        };

        // Friendly unit protecting a hostile target may need flip on pseudo clone
        const shouldFlipCaster =
          (casterDisposition !== -1) &&
          (targetDisposition === -1) &&
          (casterDisposition !== targetDisposition);

        const originalMirrorX = sourceToken.document.mirrorX ?? false;

        ONI.emit(
          "oni:animationStart",
          {
            type: "skillProtect",
            sourceTokenId: sourceToken.id,
            targetTokenIds: [targetToken.id],
            sceneId: canvas.scene?.id ?? null,
            timestamp: Date.now(),
            meta: {
              casterHostile,
              targetHostile,
              frontIsRightOfTarget,
              shouldFlipCaster
            }
          },
          { local: true, world: false }
        );

        const FX_PROTECT =
          "modules/JB2A_DnD5e/Library/Generic/Conditions/Boon01/ConditionBoon01_012_Green_600x600.webm";
        const SFX_PROTECT =
          "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Shield2.wav";

        const scriptSource = `
const { casterToken, params } = ctx;
if (!casterToken) throw new Error("Need casterToken");

function easeInOutCubic(t) {
  return t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3)/2;
}

function animate(obj, fromX, fromY, toX, toY, durMs) {
  return new Promise(resolve => {
    const start = performance.now();
    const ticker = canvas.app.ticker;
    const update = () => {
      const raw = (performance.now() - start) / durMs;
      const t = Math.min(Math.max(raw, 0), 1);
      const e = easeInOutCubic(t);
      obj.x = fromX + (toX - fromX) * e;
      obj.y = fromY + (toY - fromY) * e;
      if (t >= 1) {
        ticker.remove(update);
        resolve();
      }
    };
    ticker.add(update);
  });
}

async function createClone(token) {
  const baseObj = token.mesh ?? token.icon;
  const texture = baseObj?.texture ?? await loadTexture(token.document.texture.src);
  const sprite = new PIXI.Sprite(texture);
  sprite.anchor.set(0.5);
  sprite.x = token.center.x;
  sprite.y = token.center.y;
  if (baseObj) {
    sprite.width = baseObj.width;
    sprite.height = baseObj.height;
  }
  sprite.zIndex = 5000;
  canvas.stage.sortableChildren = true;
  canvas.stage.addChild(sprite);
  canvas.stage.sortChildren();
  return sprite;
}

const toX = Number(params.toX);
const toY = Number(params.toY);
const moveOutMs = Number(params.moveOutMs ?? 220);
const holdMs = Number(params.holdMs ?? 0);
const moveBackMs = Number(params.moveBackMs ?? 220);
const shouldFlip = Boolean(params.shouldFlip ?? false);

const baseMesh = casterToken.mesh ?? casterToken.icon;
const originalTokenVisible = casterToken.visible;
const originalMeshVisible = baseMesh?.visible ?? true;

let sprite;
try {
  sprite = await createClone(casterToken);

  if (baseMesh) baseMesh.visible = false;
  casterToken.visible = false;

  const homeX = sprite.x;
  const homeY = sprite.y;

  await animate(sprite, homeX, homeY, toX, toY, moveOutMs);

  if (shouldFlip) sprite.scale.x = -Math.abs(sprite.scale.x);

  if (holdMs > 0) await wait(holdMs);

  if (shouldFlip) sprite.scale.x = Math.abs(sprite.scale.x);

  await animate(sprite, toX, toY, homeX, homeY, moveBackMs);
} finally {
  if (sprite) {
    canvas.stage.removeChild(sprite);
    sprite.destroy();
  }
  if (baseMesh) baseMesh.visible = originalMeshVisible;
  casterToken.visible = originalTokenVisible;
}
        `.trim();

        const wPx = (sourceToken.document.width ?? 1) * (canvas.grid?.size ?? 100);
        const hPx = (sourceToken.document.height ?? 1) * (canvas.grid?.size ?? 100);

        const frontCenterX = destFront.x + wPx / 2;
        const frontCenterY = destFront.y + hPx / 2;

        game.ONI.pseudo.play({
          scriptId: "oni.protect.moveToFrontHoldReturn",
          scriptSource,
          casterTokenUuid: sourceToken.document.uuid,
          targetTokenUuids: [targetToken.document.uuid],
          params: {
            toX: frontCenterX,
            toY: frontCenterY,
            moveOutMs,
            holdMs,
            moveBackMs,
            shouldFlip: shouldFlipCaster
          },
          meta: {
            source: "Protect",
            shouldFlipCaster,
            originalMirrorX
          }
        });

        const seq = new Sequence();

        seq.wait(moveOutMs);

        seq.sound()
          .file(SFX_PROTECT)
          .volume(0.95);

        seq.effect()
          .file(FX_PROTECT)
          .atLocation(targetToken)
          .scale(fxScale)
          .opacity(1.0);

        seq.wait(holdMs);
        seq.wait(moveBackMs);

        await seq.play();

        ONI.emit(
          "oni:animationEnd",
          {
            type: "skillProtect",
            sourceTokenId: sourceToken.id,
            targetTokenIds: [targetToken.id],
            sceneId: canvas.scene?.id ?? null,
            timestamp: Date.now()
          },
          { local: true, world: false }
        );

        log("Protect animation END", {
          sourceToken: sourceToken.name,
          targetToken: targetToken.name,
          moveOutMs,
          holdMs,
          moveBackMs,
          shouldFlipCaster
        });

        return {
          ok: true,
          sourceTokenUuid: sourceToken.document.uuid,
          targetTokenUuid: targetToken.document.uuid
        };
      } catch (e) {
        err("Protect animation crashed:", e);

        try {
          ensureONIEmit();
          ONI.emit(
            "oni:animationEnd",
            {
              type: "skillProtect",
              error: true,
              timestamp: Date.now()
            },
            { local: true, world: false }
          );
        } catch (_e) {}

        return {
          ok: false,
          reason: "animation_failed",
          error: String(e?.message ?? e)
        };
      }
    }

    async function play({
      payload = {},
      protectorTokenUuid = null,
      protectorActorUuid = null,
      protectedTargetUuid = null,
      cardTitle = "💥 Protect",
      broadcastCard = true,
      playAnimation = true,
      fxScale = 0.3,
      moveOutMs = 220,
      holdMs = 2000,
      moveBackMs = 220,
      squares = 0.60
    } = {}) {
      const out = {
        ok: false,
        card: null,
        animation: null
      };

      if (!protectedTargetUuid) {
        warn("play() aborted - missing protectedTargetUuid");
        return {
          ok: false,
          reason: "missing_protected_target_uuid"
        };
      }

      if (!protectorTokenUuid && !protectorActorUuid) {
        warn("play() aborted - missing protector token/actor uuid");
        return {
          ok: false,
          reason: "missing_protector_uuid"
        };
      }

      if (broadcastCard) {
        out.card = await broadcastProtectCard({
          payload,
          protectorTokenUuid,
          protectorActorUuid,
          protectedTargetUuid,
          title: cardTitle
        });
      }

      if (playAnimation) {
        out.animation = await playProtectAnimation({
          protectorTokenUuid: protectorTokenUuid || protectorActorUuid,
          protectedTargetUuid,
          fxScale,
          moveOutMs,
          holdMs,
          moveBackMs,
          squares
        });
      }

      out.ok = Boolean(out.card?.ok || out.animation?.ok);

      log("play() DONE", out);
      return out;
    }

    async function playFromRedirect(payload = {}, redirectResult = {}, opts = {}) {
      const protectorTokenUuid =
        firstNonBlank(
          opts?.protectorTokenUuid,
          redirectResult?.replacementTargetUuid,
          payload?.meta?.attackerUuid,
          payload?.attackerUuid
        ) || null;

      const protectorActorUuid =
        firstNonBlank(
          opts?.protectorActorUuid,
          redirectResult?.replacementActorUuid,
          payload?.attackerActorUuid
        ) || null;

      const protectedTargetUuid =
        firstNonBlank(
          opts?.protectedTargetUuid,
          redirectResult?.previousTargetUuid
        ) || null;

      if (!protectedTargetUuid) {
        warn("playFromRedirect() aborted - redirect result missing previousTargetUuid", {
          redirectResult
        });
        return {
          ok: false,
          reason: "missing_previous_target_uuid"
        };
      }

      return await play({
        payload,
        protectorTokenUuid,
        protectorActorUuid,
        protectedTargetUuid,
        cardTitle: opts?.cardTitle ?? "💥 Protect",
        broadcastCard: opts?.broadcastCard !== false,
        playAnimation: opts?.playAnimation !== false,
        fxScale: Number.isFinite(Number(opts?.fxScale)) ? Number(opts.fxScale) : 0.3,
        moveOutMs: Number.isFinite(Number(opts?.moveOutMs)) ? Number(opts.moveOutMs) : 220,
        holdMs: Number.isFinite(Number(opts?.holdMs)) ? Number(opts.holdMs) : 2000,
        moveBackMs: Number.isFinite(Number(opts?.moveBackMs)) ? Number(opts.moveBackMs) : 220,
        squares: Number.isFinite(Number(opts?.squares)) ? Number(opts.squares) : 0.60
      });
    }

    window[KEY] = {
      playFromRedirect,
      play
    };

    log("Installed.", { key: KEY });
  })();
});