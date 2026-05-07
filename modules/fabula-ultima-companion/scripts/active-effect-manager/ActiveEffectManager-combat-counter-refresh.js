// ============================================================================
// ActiveEffectManager-combat-counter-refresh.js
// Foundry VTT V12 — Fabula Ultima Companion
//
// Purpose:
// - Fix Foundry V12 round/turn ActiveEffect counters for effects applied
//   outside combat.
// - Outside combat: no custom counter is shown.
// - When combat starts: round-based effects are recreated with combat timing,
//   allowing Foundry's native counter to appear.
// - Uses a temporary status-icon snapshot fade to hide the create/delete flicker.
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

    function setProperty(obj, path, value) {
      try {
        foundry.utils.setProperty(obj, path, value);
      } catch (_e) {}
      return obj;
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

    function cleanCreateData(data) {
      delete data._id;
      delete data.id;
      delete data.folder;
      delete data.sort;
      delete data.ownership;
      delete data._stats;

      return data;
    }

    function makeCombatDuration(oldDuration, combat) {
      const round = Number(combat.round ?? 1) || 1;

      // At combat start, combat.turn can be null.
      // Native duration wants a numeric turn.
      const turn = Number.isFinite(Number(combat.turn))
        ? Number(combat.turn)
        : 0;

      const out = clone(oldDuration ?? {}, {});

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

    async function recreateEffectForCombatCounter(actor, effect, combat) {
      const oldRaw = getRawEffectData(effect);
      const oldId = effect.id;
      const oldName = effect.name;

      const createData = cleanCreateData(clone(oldRaw, {}));
      createData.duration = makeCombatDuration(oldRaw.duration ?? {}, combat);

      createData.flags = createData.flags || {};
      createData.flags[MODULE_ID] = createData.flags[MODULE_ID] || {};
      createData.flags[MODULE_ID].activeEffectManager =
        createData.flags[MODULE_ID].activeEffectManager || {};

      setProperty(
        createData,
        `flags.${MODULE_ID}.activeEffectManager.nativeCounterRefresh`,
        {
          combatId: combat.id,
          oldEffectId: oldId,
          recreatedAt: new Date().toISOString(),
          reason: "effect-existed-before-combat-start"
        }
      );

      log("Recreating effect for native combat counter.", {
        actor: actor.name,
        before: summarizeEffect(effect),
        createDuration: createData.duration
      });

      // Create-before-delete is safer. The visual layer is hidden during this,
      // so players should not see the duplicate icon moment.
      const [created] = await actor.createEmbeddedDocuments("ActiveEffect", [createData], {
        render: false
      });

      if (!created) {
        throw new Error(`Failed to recreate effect: ${oldName}`);
      }

      await actor.deleteEmbeddedDocuments("ActiveEffect", [oldId], {
        render: false
      });

      await actor.prepareData?.();

      const fresh = actor.effects.get(created.id) ?? created;

      log("Recreated effect result.", {
        actor: actor.name,
        after: summarizeEffect(fresh)
      });

      return fresh;
    }

    async function processActor(actor, combat) {
      const report = {
        actor: actor.name,
        candidates: 0,
        skippedAlreadyProcessed: 0,
        recreated: 0
      };

      const candidates = Array.from(actor.effects ?? [])
        .filter(effect => isRoundBasedEffectNeedingRefresh(effect, combat));

      report.candidates = candidates.length;

      if (!candidates.length) return report;

      const thaw = freezeActorStatusIcons(actor);

      try {
        await nextFrame();

        for (const effect of candidates) {
          if (wasAlreadyProcessedForCombat(effect, combat)) {
            report.skippedAlreadyProcessed++;
            continue;
          }

          await recreateEffectForCombatCounter(actor, effect, combat);
          report.recreated++;
        }

        if (report.recreated > 0) {
          await redrawActorTokens(actor);
          await wait(40);
        }
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
        const totalRecreated = report.reduce((sum, row) => sum + row.recreated, 0);

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

    console.log(TAG, "Installed. Round-based effects applied before combat will receive native counters when combat starts.");
  })();
});