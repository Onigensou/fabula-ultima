/* --------------------------------------------
 * [ONI][TEMP] Matador Cape Crisis DEF Solver
 * 
 * Purpose:
 * - Matador Cape already gives +1 DEF normally.
 * - This script adds/removes the EXTRA +1 DEF while:
 *   1. Actor has Matador Cape equipped
 *   2. Actor is in Crisis: current_hp <= ceil(max_hp / 2)
 *
 * This avoids item-scope formula issues.
 * -------------------------------------------- */

(() => {
  const MODULE_ID = "fabula-ultima-companion";
  const TAG = "[ONI][MatadorCapeCrisisDEF]";
  const DEBUG = false;

  const ITEM_NAME = "Matador Cape";
  const EFFECT_NAME = "[TEMP] Matador Cape Crisis DEF";

  // Use the same Attribute Key style that your working DEF item effect uses.
  // If your active effects require full path, change this to "system.props.defense".
  const DEF_KEY = "defense";

  const FLAG_KEY = "matadorCapeCrisisDefSolver";

  const log = (...args) => {
    if (DEBUG) console.log(TAG, ...args);
  };

  const warn = (...args) => console.warn(TAG, ...args);

  const normalize = (v) => String(v ?? "").trim().toLowerCase();

  const toNumber = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  const isTrue = (v) => {
    if (v === true) return true;
    if (v === 1) return true;
    const s = normalize(v);
    return s === "true" || s === "1" || s === "yes" || s === "on";
  };

  const getProp = (doc, key) => {
    return foundry.utils.getProperty(doc, `system.props.${key}`);
  };

  const isResponsibleGM = () => {
    if (!game.user?.isGM) return false;

    // Prevent duplicate handling if two GM clients are open.
    const activeGM = game.users?.activeGM;
    if (!activeGM) return true;

    return activeGM.id === game.user.id;
  };

  const getEquippedMatadorCape = (actor) => {
    if (!actor?.items) return null;

    return actor.items.find((item) => {
      if (normalize(item.name) !== normalize(ITEM_NAME)) return false;
      return isTrue(getProp(item, "isEquipped"));
    }) ?? null;
  };

  const isActorInCrisis = (actor) => {
    const currentHp = toNumber(getProp(actor, "current_hp"));
    const maxHp = toNumber(getProp(actor, "max_hp"));

    if (maxHp <= 0) return false;

    const crisisThreshold = Math.ceil(maxHp / 2);
    return currentHp <= crisisThreshold;
  };

  const getSolverEffects = (actor) => {
    if (!actor?.effects) return [];

    return actor.effects.filter((effect) => {
      const byFlag = effect.getFlag?.(MODULE_ID, FLAG_KEY) === true;
      const byName = effect.name === EFFECT_NAME || effect.label === EFFECT_NAME;
      return byFlag || byName;
    });
  };

  const createSolverEffect = async (actor, item) => {
    await actor.createEmbeddedDocuments("ActiveEffect", [
      {
        name: EFFECT_NAME,
        icon: item?.img ?? "icons/svg/shield.svg",
        origin: item?.uuid ?? actor.uuid,
        disabled: false,
        transfer: false,
        changes: [
          {
            key: DEF_KEY,
            mode: CONST.ACTIVE_EFFECT_MODES.ADD,
            value: "1",
            priority: 20
          }
        ],
        flags: {
          [MODULE_ID]: {
            [FLAG_KEY]: true,
            sourceItemName: ITEM_NAME,
            sourceItemUuid: item?.uuid ?? null
          }
        }
      }
    ]);

    log("Applied extra +1 DEF:", actor.name);
  };

  const removeSolverEffects = async (actor, effects) => {
    const ids = effects.map((e) => e.id).filter(Boolean);
    if (!ids.length) return;

    await actor.deleteEmbeddedDocuments("ActiveEffect", ids);
    log("Removed extra +1 DEF:", actor.name);
  };

  const refreshActor = async (actor) => {
    try {
      if (!isResponsibleGM()) return;
      if (!actor) return;

      const item = getEquippedMatadorCape(actor);
      const inCrisis = isActorInCrisis(actor);
      const shouldHaveEffect = !!item && inCrisis;

      const effects = getSolverEffects(actor);

      if (shouldHaveEffect) {
        if (effects.length === 0) {
          await createSolverEffect(actor, item);
          return;
        }

        // Clean duplicate copies, just in case.
        if (effects.length > 1) {
          await removeSolverEffects(actor, effects.slice(1));
        }

        return;
      }

      if (!shouldHaveEffect && effects.length > 0) {
        await removeSolverEffects(actor, effects);
      }
    } catch (err) {
      warn("Refresh failed:", actor?.name, err);
    }
  };

  const pending = new Map();

  const scheduleRefresh = (actor, reason = "unknown") => {
    if (!actor) return;

    const uuid = actor.uuid ?? actor.id;
    if (!uuid) return;

    clearTimeout(pending.get(uuid));

    pending.set(uuid, setTimeout(() => {
      pending.delete(uuid);
      log("Refreshing actor:", actor.name, "Reason:", reason);
      refreshActor(actor);
    }, 100));
  };

  const updateTouchesHp = (changes) => {
    const props = foundry.utils.getProperty(changes, "system.props") ?? {};
    return Object.prototype.hasOwnProperty.call(props, "current_hp")
      || Object.prototype.hasOwnProperty.call(props, "max_hp");
  };

  const updateTouchesEquip = (changes) => {
    const props = foundry.utils.getProperty(changes, "system.props") ?? {};
    return Object.prototype.hasOwnProperty.call(props, "isEquipped");
  };

  Hooks.on("updateActor", (actor, changes) => {
    if (!updateTouchesHp(changes)) return;
    scheduleRefresh(actor, "HP changed");
  });

  Hooks.on("updateItem", (item, changes) => {
    const actor = item?.parent;
    if (!actor) return;

    const isMatadorCape = normalize(item.name) === normalize(ITEM_NAME);
    if (!isMatadorCape && !updateTouchesEquip(changes)) return;

    scheduleRefresh(actor, "item updated");
  });

  Hooks.on("createItem", (item) => {
    const actor = item?.parent;
    if (!actor) return;
    if (normalize(item.name) !== normalize(ITEM_NAME)) return;

    scheduleRefresh(actor, "Matador Cape created");
  });

  Hooks.on("deleteItem", (item) => {
    const actor = item?.parent;
    if (!actor) return;
    if (normalize(item.name) !== normalize(ITEM_NAME)) return;

    scheduleRefresh(actor, "Matador Cape deleted");
  });

  Hooks.once("ready", () => {
    if (!isResponsibleGM()) return;

    for (const actor of game.actors.contents) {
      scheduleRefresh(actor, "startup scan");
    }

    console.log(`${TAG} Ready. Temporary solver active.`);
  });

  Hooks.on("canvasReady", () => {
    if (!isResponsibleGM()) return;

    for (const token of canvas.tokens?.placeables ?? []) {
      if (token.actor) scheduleRefresh(token.actor, "canvas scan");
    }
  });
})();