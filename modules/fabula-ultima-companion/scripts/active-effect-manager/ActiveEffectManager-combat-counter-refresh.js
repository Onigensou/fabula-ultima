// ============================================================================
// ActiveEffectManager-combat-counter-refresh.js
// Foundry VTT V12 — Fabula Ultima Companion
//
// Purpose:
// - Fix Foundry V12 round/turn ActiveEffect counters for effects applied
//   outside combat.
// - Outside combat: no custom counter is shown.
// - When combat starts: round-based effects get combat timing stamped onto
//   their duration, so Foundry's native counter reads correctly.
// - Uses a temporary status-icon snapshot fade to smooth the transition.
//
// ⚡ Stamped by in-place UPDATE, not by recreating the effect (perf)
//   This used to create a replacement effect, delete the original, and then
//   call actor.prepareData() explicitly -- THREE full actor re-derivations per
//   effect, serialized per effect per actor. Under CSB each of those is a
//   ~360 ms synchronous main-thread block, so a five-combatant fight with a few
//   round-based effects each froze the canvas for many seconds at the exact
//   moment combat opened.
//
//   The recreate was never necessary. Foundry's ActiveEffect#_prepareDuration
//   derives the counter on every data prep purely from the STORED
//   duration.startRound / startTurn plus the live game.combat -- there is no
//   creation-time snapshot. So writing those two fields onto the existing
//   effect produces an identical result. Measured 2026-08-08 on a live effect:
//   unstamped under a round-3 combat read `label:"None", remaining:0` (i.e.
//   already expired -- the actual bug); after a plain update() with
//   startRound:2 it read `label:"2 Rounds", remaining:2`, in ONE cycle, with
//   the effect id unchanged.
//
//   Updates are additionally BATCHED per actor, so an actor costs one cycle no
//   matter how many effects it carries (Foundry batches per parent document,
//   which is the floor). Preserving effect ids is also a correctness win: the
//   old recreate invalidated every outstanding reference to the effect, which
//   is why it had to record `oldEffectId` at all.
// ============================================================================

Hooks.once("ready", () => {
  (() => {
    const TAG = "[ONI][AEM:CombatCounterRefresh]";
    const PATCH_KEY = "__ONI_AEM_COMBAT_COUNTER_REFRESH_MODULE_V1__";
    const MODULE_ID = "fabula-ultima-companion";

    const DEBUG = false;

    const CFG = {
      enabled: true,

      // Visual smoothing.
      fadeMs: 160,
      startDelayMs: 350,

      // Keep this false for normal module use.
      showUiNotification: false
    };

    if (globalThis[PATCH_KEY]) {
      console.warn(TAG, "Already installed. Skipping duplicate install.");
      return;
    }

    globalThis[PATCH_KEY] = true;

    const log = (...a) => DEBUG && console.log(TAG, ...a);
    const warn = (...a) => console.warn(TAG, ...a);

    const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));

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

    function getProperty(obj, path, fallback = undefined) {
      try {
        const value = foundry.utils.getProperty(obj, path);
        return value === undefined ? fallback : value;
      } catch (_e) {
        return fallback;
      }
    }

    function isPrimaryActiveGM() {
      if (!game.user?.isGM) return false;

      const activeGms = Array.from(game.users ?? [])
        .filter(u => u.active && u.isGM)
        .sort((a, b) => String(a.id).localeCompare(String(b.id)));

      return activeGms[0]?.id === game.user.id;
    }

    function getRawEffectData(effect) {
      try {
        return clone(effect.toObject?.(), {});
      } catch (_e) {
        return {};
      }
    }

    function getRawDuration(effect) {
      return getRawEffectData(effect).duration ?? {};
    }

    function hasRoundOrTurnDuration(duration) {
      const rounds = Number(duration.rounds ?? 0);
      const turns = Number(duration.turns ?? 0);

      return (
        (Number.isFinite(rounds) && rounds > 0) ||
        (Number.isFinite(turns) && turns > 0)
      );
    }

    function isReadyForCurrentCombat(effect, combat) {
      const duration = getRawDuration(effect);

      return (
        String(duration.combat ?? "") === String(combat?.id ?? "") &&
        duration.startRound != null &&
        duration.startTurn != null
      );
    }

    function isRoundBasedEffectNeedingRefresh(effect, combat) {
      if (!effect || effect.disabled) return false;

      const duration = getRawDuration(effect);

      if (!hasRoundOrTurnDuration(duration)) return false;

      // This helper is only for round/turn duration effects.
      if (Number(duration.seconds ?? 0) > 0) return false;

      // Effects already applied during this combat should already be native-ready.
      if (isReadyForCurrentCombat(effect, combat)) return false;

      return true;
    }

    function wasAlreadyProcessedForCombat(effect, combat) {
      const raw = getRawEffectData(effect);
      const combatId = getProperty(
        raw,
        `flags.${MODULE_ID}.activeEffectManager.nativeCounterRefresh.combatId`,
        null
      );

      return String(combatId ?? "") === String(combat?.id ?? "");
    }

    function getCombatActors(combat) {
      const byUuid = new Map();

      for (const combatant of combat?.combatants ?? []) {
        const actor = combatant?.actor;
        if (!actor?.uuid) continue;
        byUuid.set(actor.uuid, actor);
      }

      return Array.from(byUuid.values());
    }

    function getVisibleTokensForActor(actor) {
      if (!actor?.uuid) return [];

      return Array.from(canvas?.tokens?.placeables ?? [])
        .filter(token => token?.actor?.uuid === actor.uuid);
    }

    function makeCombatDuration(oldDuration, combat) {
      const round = Number(combat.round ?? 1) || 1;

      // At combat start, combat.turn can be null.
      // Native duration wants a numeric turn.
      const turn = Number.isFinite(Number(combat.turn))
        ? Number(combat.turn)
        : 0;

      const out = clone(oldDuration ?? {}, {});

      // `combat` is for THIS module's own idempotence check
      // (isReadyForCurrentCombat); Foundry's counter math ignores it entirely
      // and works off startRound/startTurn alone -- verified 2026-08-08.
      // ⚠ It is a foreign-key field: an id with no matching Combat fails
      // validation and the whole duration write is silently dropped (cost one
      // debugging round). Only ever assign a real combat.id here.
      out.combat = combat.id;
      out.startRound = round;
      out.startTurn = turn;

      if (out.rounds != null && out.rounds !== "") out.rounds = Number(out.rounds);
      if (out.turns != null && out.turns !== "") out.turns = Number(out.turns);

      return out;
    }

    function copyDisplayCommon(from, to) {
      to.x = from.x ?? 0;
      to.y = from.y ?? 0;
      to.rotation = from.rotation ?? 0;
      to.alpha = from.alpha ?? 1;
      to.visible = from.visible !== false;
      to.zIndex = from.zIndex ?? 0;

      try {
        to.scale?.set?.(from.scale?.x ?? 1, from.scale?.y ?? 1);
      } catch (_e) {}

      try {
        to.skew?.set?.(from.skew?.x ?? 0, from.skew?.y ?? 0);
      } catch (_e) {}
    }

    function cloneEffectDisplayChild(child) {
      if (!child || child.__oniAeSnapshot) return null;

      try {
        if (child instanceof PIXI.Text || child.constructor?.name === "Text") {
          const style = child.style?.clone ? child.style.clone() : child.style;
          const t = new PIXI.Text(child.text ?? "", style);
          copyDisplayCommon(child, t);

          try {
            t.anchor?.set?.(child.anchor?.x ?? 0, child.anchor?.y ?? 0);
          } catch (_e) {}

          return t;
        }

        if (child.texture) {
          const s = new PIXI.Sprite(child.texture);
          copyDisplayCommon(child, s);

          try {
            s.anchor?.set?.(child.anchor?.x ?? 0, child.anchor?.y ?? 0);
          } catch (_e) {}

          s.tint = child.tint ?? 0xFFFFFF;
          s.width = child.width ?? s.width;
          s.height = child.height ?? s.height;

          return s;
        }
      } catch (e) {
        warn("Could not clone token effect display child.", e);
      }

      return null;
    }

    function makeStatusIconSnapshot(token) {
      const effects = token?.effects;
      const parent = effects?.parent;

      if (!effects || !parent) {
        return {
          ok: false,
          token,
          thaw: async () => {}
        };
      }

      const oldAlpha = effects.alpha ?? 1;

      const snapshot = new PIXI.Container();
      snapshot.__oniAeSnapshot = true;
      snapshot.name = "ONI AE Status Icon Snapshot";
      snapshot.sortableChildren = true;

      copyDisplayCommon(effects, snapshot);
      snapshot.alpha = oldAlpha;
      snapshot.zIndex = (effects.zIndex ?? 0) + 999;

      for (const child of Array.from(effects.children ?? [])) {
        const cloned = cloneEffectDisplayChild(child);
        if (!cloned) continue;
        cloned.__oniAeSnapshot = true;
        snapshot.addChild(cloned);
      }

      if (snapshot.children.length) {
        parent.sortableChildren = true;
        parent.addChild(snapshot);
      }

      // Hide real icon layer while backend create/delete happens.
      effects.alpha = 0;

      const thaw = async () => {
        try {
          await nextFrame();

          effects.alpha = 0;

          const start = performance.now();

          await new Promise(resolve => {
            const tick = (now) => {
              const t = Math.min(1, (now - start) / CFG.fadeMs);
              const eased = t * (2 - t);

              effects.alpha = oldAlpha * eased;
              snapshot.alpha = oldAlpha * (1 - eased);

              if (t < 1) {
                requestAnimationFrame(tick);
              } else {
                resolve();
              }
            };

            requestAnimationFrame(tick);
          });

          effects.alpha = oldAlpha;
        } finally {
          try {
            snapshot.destroy?.({ children: true });
          } catch (_e) {
            try { snapshot.removeFromParent?.(); } catch (_e2) {}
          }
        }
      };

      return {
        ok: true,
        token,
        effects,
        snapshot,
        thaw
      };
    }

    function freezeActorStatusIcons(actor) {
      const tokens = getVisibleTokensForActor(actor);
      const freezes = tokens.map(makeStatusIconSnapshot);

      return async () => {
        for (const f of freezes) {
          try {
            await f.thaw();
          } catch (e) {
            warn("Failed thawing status icon snapshot.", e);
          }
        }
      };
    }

    async function redrawActorTokens(actor) {
      for (const token of getVisibleTokensForActor(actor)) {
        try {
          token.effects?.removeChildren?.().forEach(child => {
            try {
              child.destroy?.({ children: true });
            } catch (_e) {}
          });
        } catch (_e) {}

        try {
          await token.drawEffects?.();
        } catch (e) {
          warn("token.drawEffects failed.", {
            token: token.name,
            error: String(e?.message ?? e)
          });
        }

        try {
          token.refresh?.();
        } catch (_e) {}
      }
    }

    function summarizeEffect(effect) {
      const raw = getRawEffectData(effect);
      const duration = raw.duration ?? {};

      return {
        id: effect.id,
        name: effect.name,
        rawRounds: duration.rounds ?? null,
        rawTurns: duration.turns ?? null,
        rawCombat: duration.combat ?? null,
        rawStartRound: duration.startRound ?? null,
        rawStartTurn: duration.startTurn ?? null,
        preparedLabel: effect.duration?.label ?? null,
        preparedRemaining: effect.duration?.remaining ?? null
      };
    }

    // One entry in a batched updateEmbeddedDocuments payload. The duration and
    // the bookkeeping flag go in the SAME entry deliberately -- splitting them
    // would be a second write and put the third re-derivation straight back.
    function buildCounterRefreshUpdate(effect, combat) {
      const oldRaw = getRawEffectData(effect);

      return {
        _id: effect.id,
        duration: makeCombatDuration(oldRaw.duration ?? {}, combat),
        [`flags.${MODULE_ID}.activeEffectManager.nativeCounterRefresh`]: {
          combatId: combat.id,
          refreshedAt: new Date().toISOString(),
          reason: "effect-existed-before-combat-start"
        }
      };
    }

    async function processActor(actor, combat) {
      const report = {
        actor: actor.name,
        candidates: 0,
        skippedAlreadyProcessed: 0,
        refreshed: 0
      };

      const candidates = Array.from(actor.effects ?? [])
        .filter(effect => isRoundBasedEffectNeedingRefresh(effect, combat));

      report.candidates = candidates.length;

      if (!candidates.length) return report;

      // Decide everything BEFORE writing, then issue a single call. One actor
      // costs one re-derivation regardless of how many effects it carries.
      const updates = [];

      for (const effect of candidates) {
        if (wasAlreadyProcessedForCombat(effect, combat)) {
          report.skippedAlreadyProcessed++;
          continue;
        }

        updates.push(buildCounterRefreshUpdate(effect, combat));
      }

      if (!updates.length) return report;

      log("Stamping combat timing onto round-based effects.", {
        actor: actor.name,
        count: updates.length,
        before: candidates.map(summarizeEffect)
      });

      const thaw = freezeActorStatusIcons(actor);

      try {
        await nextFrame();

        await actor.updateEmbeddedDocuments("ActiveEffect", updates);
        report.refreshed = updates.length;

        // Effect ids are preserved now, so the icon row does not churn -- but
        // the counter badge still needs to repaint with its new value.
        await redrawActorTokens(actor);
        await wait(40);
      } finally {
        await thaw();
      }

      return report;
    }

    let lock = false;

    async function refreshCombatCounters(combat, reason = "unknown") {
      if (!CFG.enabled) return;
      if (!isPrimaryActiveGM()) return;
      if (!combat?.started) return;

      if (lock) {
        log("Skipped duplicate refresh while locked.", { reason });
        return;
      }

      lock = true;

      try {
        const actors = getCombatActors(combat);
        const report = [];

        for (const actor of actors) {
          report.push(await processActor(actor, combat));
        }

        const totalCandidates = report.reduce((sum, row) => sum + row.candidates, 0);
        const totalRecreated = report.reduce((sum, row) => sum + row.refreshed, 0);

        log("Result.", {
          reason,
          combatId: combat.id,
          combatRound: combat.round,
          combatTurn: combat.turn,
          totalCandidates,
          totalRecreated,
          report
        });

        if (CFG.showUiNotification && totalRecreated > 0) {
          ui.notifications.info(`Prepared ${totalRecreated} effect counter(s) for combat.`);
        }

        if (CFG.showUiNotification && totalRecreated <= 0 && totalCandidates > 0) {
          ui.notifications.warn(`Found ${totalCandidates} candidate(s), but none were recreated. Check console.`);
        }
      } catch (e) {
        console.error(TAG, "Refresh failed.", e);
        ui.notifications.error("Active Effect combat counter refresh failed. Check console.");
      } finally {
        lock = false;
      }
    }

    function schedule(combat, reason, delay = CFG.startDelayMs) {
      setTimeout(() => {
        refreshCombatCounters(combat, reason);
      }, delay);
    }

    function installHooks() {
      Hooks.on("combatStart", combat => {
        schedule(combat, "combatStart", CFG.startDelayMs);
      });

      Hooks.on("updateCombat", (combat, changed) => {
        if (!combat?.started) return;

        const relevant =
          changed?.started != null ||
          changed?.round != null ||
          changed?.turn != null;

        if (!relevant) return;

        schedule(combat, "updateCombat", CFG.startDelayMs + 150);
      });

      Hooks.on("createCombatant", combatant => {
        const combat = combatant?.combat ?? game.combat;
        if (!combat?.started) return;

        schedule(combat, "createCombatant", CFG.startDelayMs + 150);
      });

      if (game.combat?.started) {
        schedule(game.combat, "initial install while combat active", CFG.startDelayMs);
      }

      log("Installed hooks.");
    }

    function ensureApiRoot() {
      globalThis.FUCompanion = globalThis.FUCompanion || {};
      globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
      globalThis.FUCompanion.api.activeEffectManager =
        globalThis.FUCompanion.api.activeEffectManager || {};

      return globalThis.FUCompanion.api.activeEffectManager;
    }

    function exposeApi() {
      const api = {
        version: "1.0.0",
        config: CFG,
        refreshCombatCounters,
        refreshCurrentCombat: () => refreshCombatCounters(game.combat, "manual-api-call")
      };

      const root = ensureApiRoot();
      root.combatCounterRefresh = api;

      try {
        const mod = game.modules?.get?.(MODULE_ID);
        if (mod) {
          mod.api = mod.api || {};
          mod.api.activeEffectManager = mod.api.activeEffectManager || {};
          mod.api.activeEffectManager.combatCounterRefresh = api;
        }
      } catch (e) {
        warn("Could not expose combat counter refresh API.", e);
      }

      return api;
    }

    exposeApi();
    installHooks();

    console.debug(TAG, "Installed. Round-based effects applied before combat will receive native counters when combat starts.");
  })();
});