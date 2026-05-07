(() => {
  const TAG = "[ONI][Temp Swift Swimmer Wet Sync V2]";
  const MODULE_ID = "fabula-ultima-companion";

  const INSTALL_KEY = "__ONI_TEMP_SWIFT_SWIMMER_WET_SYNC_V2_INSTALLED__";

  if (globalThis[INSTALL_KEY]) {
    console.warn(TAG, "Already installed. Skipping duplicate install.");
    return;
  }

  globalThis[INSTALL_KEY] = true;

  const DEBUG = false;

  const SWIMSUIT_NAME = "Swimsuit";
  const AUTO_EFFECT_NAME = "[AUTO] Swift Swimmer - DEX d12 while Wet";

  const WET_PATH = "system.props.wet_status";
  const EQUIPPED_PATH = "system.props.isEquipped";

  const DEX_TARGET_KEY = "override_dex";
  const DEX_VALUE = "12";
  const DEX_PRIORITY = 50;

  const syncOptions = { oniTempSwiftSwimmerSync: true };

  const log = (...args) => {
    if (DEBUG) console.log(TAG, ...args);
  };

  const norm = (v) => String(v ?? "").trim().toLowerCase();

  const toNumber = (v) => {
    if (v === true) return 1;
    if (v === false) return 0;
    if (v == null || v === "") return 0;

    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  const isTruthy = (v) => {
    if (v === true) return true;

    const s = norm(v);
    return s === "true" || s === "1" || s === "yes" || s === "on";
  };

  const getLive = (doc, path) => foundry.utils.getProperty(doc, path);
  const getSource = (doc, path) => foundry.utils.getProperty(doc?._source ?? {}, path);

  const getBest = (doc, path) => {
    const live = getLive(doc, path);
    if (live !== undefined) return live;
    return getSource(doc, path);
  };

  const isResponsibleGM = () => {
    if (!game.user?.isGM) return false;

    const activeGMs = game.users
      .filter(u => u.active && u.isGM)
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));

    return activeGMs[0]?.id === game.user.id;
  };

  const findSwimsuit = (actor) => {
    if (!actor) return null;

    return actor.items.find(i => norm(i.name) === norm(SWIMSUIT_NAME))
      ?? actor.items.find(i => norm(i.name).includes("swimsuit"));
  };

  const isSwimsuitEquipped = (actor) => {
    const swimsuit = findSwimsuit(actor);
    if (!swimsuit) return false;

    return isTruthy(getBest(swimsuit, EQUIPPED_PATH));
  };

  const isActorWet = (actor) => {
    // First try the CSB prop.
    const wetValue = getBest(actor, WET_PATH);
    if (toNumber(wetValue) === 1) return true;

    // Fallback: check active effects by name/status.
    return Array.from(actor.effects ?? []).some(e => {
      if (e.disabled) return false;

      const name = norm(e.name ?? e.label);
      const statuses = Array.from(e.statuses ?? []).map(norm);

      return name === "wet" || statuses.includes("wet");
    });
  };

  const getAutoEffect = (actor) => {
    return Array.from(actor.effects ?? []).find(e => {
      const byFlag = e.getFlag?.(MODULE_ID, "tempSwiftSwimmerDex") === true;
      const byName = norm(e.name ?? e.label) === norm(AUTO_EFFECT_NAME);
      return byFlag || byName;
    });
  };

  const autoEffectData = (swimsuit) => ({
    name: AUTO_EFFECT_NAME,
    img: swimsuit?.img ?? "icons/svg/aura.svg",
    type: "base",
    system: { tags: [] },
    transfer: false,
    disabled: false,
    changes: [
      {
        key: DEX_TARGET_KEY,
        mode: CONST.ACTIVE_EFFECT_MODES.UPGRADE,
        value: DEX_VALUE,
        priority: DEX_PRIORITY
      }
    ],
    duration: {},
    origin: swimsuit?.uuid ?? null,
    description: "Temporary Swift Swimmer fix. Applies raw override_dex 12 while Wet and Swimsuit is equipped.",
    flags: {
      [MODULE_ID]: {
        tempSwiftSwimmerDex: true
      }
    }
  });

  const autoEffectNeedsRepair = (effect) => {
    if (!effect) return false;

    const c = effect.changes?.[0];

    return (
      effect.disabled ||
      String(c?.key ?? "") !== DEX_TARGET_KEY ||
      Number(c?.mode) !== CONST.ACTIVE_EFFECT_MODES.UPGRADE ||
      String(c?.value ?? "") !== DEX_VALUE ||
      Number(c?.priority ?? 0) !== DEX_PRIORITY
    );
  };

  const disableBrokenItemSwiftSwimmer = async (actor) => {
    const swimsuit = findSwimsuit(actor);
    if (!swimsuit) return false;

    let changed = false;

    for (const effect of Array.from(swimsuit.effects ?? [])) {
      const name = norm(effect.name ?? effect.label);
      if (!name.includes("swift swimmer")) continue;
      if (effect.disabled) continue;

      // For tonight, disable item-side Swift Swimmer formulas entirely.
      // The actor-owned auto effect below handles the actual DEX override.
      await effect.update({ disabled: true }, syncOptions);
      changed = true;

      log("Disabled item-side Swift Swimmer effect to prevent formula corruption.", {
        actor: actor.name,
        item: swimsuit.name,
        effect: effect.name
      });
    }

    return changed;
  };

  const safePrepare = (actor) => {
    try {
      actor.prepareData?.();
    } catch (err) {
      console.warn(TAG, "prepareData failed, continuing.", err);
    }
  };

  const syncActor = async (actor, reason = "unknown") => {
    if (!actor || !isResponsibleGM()) return;

    try {
      await disableBrokenItemSwiftSwimmer(actor);

      safePrepare(actor);

      const swimsuit = findSwimsuit(actor);
      const wet = isActorWet(actor);
      const equipped = isSwimsuitEquipped(actor);
      const shouldHave = wet && equipped;

      let auto = getAutoEffect(actor);

      if (shouldHave) {
        if (!auto) {
          await actor.createEmbeddedDocuments("ActiveEffect", [autoEffectData(swimsuit)], syncOptions);

          ui.notifications.info(`${actor.name}: Swift Swimmer enabled DEX d12`);

          log("Created actor-owned Swift Swimmer DEX effect.", {
            actor: actor.name,
            reason,
            wet,
            equipped,
            swimsuit: swimsuit?.name
          });

          return;
        }

        if (autoEffectNeedsRepair(auto)) {
          await auto.update({
            disabled: false,
            changes: autoEffectData(swimsuit).changes
          }, syncOptions);

          log("Repaired actor-owned Swift Swimmer DEX effect.", {
            actor: actor.name,
            reason,
            wet,
            equipped
          });

          return;
        }

        log("No update needed; auto effect already active.", {
          actor: actor.name,
          reason,
          wet,
          equipped
        });

        return;
      }

      if (!shouldHave && auto) {
        await auto.delete(syncOptions);

        ui.notifications.info(`${actor.name}: Swift Swimmer reset DEX override`);

        log("Deleted actor-owned Swift Swimmer DEX effect.", {
          actor: actor.name,
          reason,
          wet,
          equipped,
          swimsuit: swimsuit?.name
        });

        return;
      }

      log("No update needed; auto effect absent.", {
        actor: actor.name,
        reason,
        wet,
        equipped,
        swimsuit: swimsuit?.name
      });

    } catch (err) {
      console.error(TAG, "Failed to sync actor.", {
        actor,
        reason,
        err
      });
    }
  };

  const pending = new Map();

  const scheduleSync = (actor, reason = "unknown") => {
    if (!actor || !isResponsibleGM()) return;

    const key = actor.uuid ?? actor.id;

    if (pending.has(key)) {
      clearTimeout(pending.get(key));
    }

    const timeout = setTimeout(() => {
      pending.delete(key);
      syncActor(actor, reason);
    }, 150);

    pending.set(key, timeout);
  };

  const resolveActorFromEffect = (effect) => {
    const parent = effect?.parent;

    if (!parent) return null;
    if (parent.documentName === "Actor") return parent;

    if (parent.documentName === "Item") {
      const actor = parent.parent;
      if (actor?.documentName === "Actor") return actor;
    }

    return null;
  };

  const shouldIgnoreOptions = (options) => {
    return options?.oniTempSwiftSwimmerSync === true;
  };

  Hooks.once("ready", () => {
    if (!isResponsibleGM()) {
      console.log(TAG, "Loaded, but inactive on this client because it is not the responsible GM.");
      return;
    }

    console.log(TAG, "Ready. Responsible GM watcher active.");

    for (const actor of game.actors ?? []) {
      scheduleSync(actor, "ready world actor scan");
    }

    for (const token of canvas?.tokens?.placeables ?? []) {
      if (token.actor) scheduleSync(token.actor, "ready token scan");
    }
  });

  Hooks.on("canvasReady", () => {
    if (!isResponsibleGM()) return;

    for (const token of canvas?.tokens?.placeables ?? []) {
      if (token.actor) scheduleSync(token.actor, "canvasReady");
    }
  });

  Hooks.on("updateActor", (actor, changes, options) => {
    if (shouldIgnoreOptions(options)) return;

    if (
      foundry.utils.hasProperty(changes, "system.props") ||
      foundry.utils.hasProperty(changes, WET_PATH)
    ) {
      scheduleSync(actor, "updateActor");
    }
  });

  Hooks.on("updateItem", (item, changes, options) => {
    if (shouldIgnoreOptions(options)) return;

    const actor = item?.parent;
    if (actor?.documentName !== "Actor") return;

    const isSwimsuit =
      norm(item.name) === norm(SWIMSUIT_NAME) ||
      norm(item.name).includes("swimsuit");

    if (!isSwimsuit) return;

    if (
      foundry.utils.hasProperty(changes, "system.props") ||
      foundry.utils.hasProperty(changes, EQUIPPED_PATH)
    ) {
      scheduleSync(actor, "updateItem swimsuit");
    }
  });

  Hooks.on("createActiveEffect", (effect, options) => {
    if (shouldIgnoreOptions(options)) return;

    const actor = resolveActorFromEffect(effect);
    if (actor) scheduleSync(actor, "createActiveEffect");
  });

  Hooks.on("updateActiveEffect", (effect, changes, options) => {
    if (shouldIgnoreOptions(options)) return;

    const actor = resolveActorFromEffect(effect);
    if (actor) scheduleSync(actor, "updateActiveEffect");
  });

  Hooks.on("deleteActiveEffect", (effect, options) => {
    if (shouldIgnoreOptions(options)) return;

    const actor = resolveActorFromEffect(effect);
    if (actor) scheduleSync(actor, "deleteActiveEffect");
  });

  globalThis.ONI_TEMP_SYNC_SWIFT_SWIMMER_V2 = () => {
    if (!isResponsibleGM()) {
      ui.notifications.warn("Only the responsible GM client runs Swift Swimmer sync.");
      return;
    }

    const actors = new Set();

    for (const actor of game.actors ?? []) actors.add(actor);

    for (const token of canvas?.tokens?.placeables ?? []) {
      if (token.actor) actors.add(token.actor);
    }

    for (const actor of actors) {
      scheduleSync(actor, "manual global sync");
    }

    ui.notifications.info("Queued Swift Swimmer V2 sync.");
  };

  console.log(`${TAG} Installed.`);
})();