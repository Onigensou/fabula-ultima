/**
 * Fabula Initiative — Module Controller (Foundry V12)
 * - Auto-spawns UI for every client when combat starts (and despawns when combat ends)
 * - UI is decoupled from game state: it reads combat state and animates independently
 * - Player permissions: players can only activate/grant/undo for combatants they own
 *
 * Requires:
 * - This file is loaded by the module for all clients
 * - The UI library file registers globalThis.oniTurnBarUI.create(...)
 */
(() => {
  const MODULE_ID = "fabula-ultima-companion";
  const TAG = "[ONI][FabulaInitiative]";
  const MODULE_FLAG = "lancer-initiative";

  const IDS = {
    ROOT_ID: "oni-turnbar-root",
    STYLE_ID: "oni-turnbar-style",
  };

  // =========================================================
  // Summon filter helper
  // =========================================================
  const isSummonActor = (actor) => {
    if (!actor) return false;
    const v =
      foundry.utils.getProperty(actor, "system.props.isSummon") ??
      foundry.utils.getProperty(actor, "system.isSummon");
    return v === true;
  };

  // =========================================================
  // TUNERS (same values as demo; debug disabled)
  // =========================================================
  const TUNER = {
    // Positioning
    anchor: "top-left",
    offsetX: 155,
    offsetY: -40,

    // Layout
    maxIconsPerRow: 12,
    gap: 8,
    currentGap: 150,
    padding: 10,

    // Portrait framing
    basePortraitZoom: 1.7,

    // Default offsets/scales (used when actor fields are blank)
    defaultIconOffsetX: 0,
    defaultIconOffsetY: 20,
    defaultIconScale: 1,

    // Panel look
    showBackdropBlur: true,
    backdropBlur: 0.5,
    headerBgOpacity: 0.5,
    headerTextOpacity: 0.85,

    // Icon sizing & style
    iconSize: 67,
    imgInset: 1,
    borderWidth: 5,
    borderOpacity: 1,

    // Disposition border colors (RGB strings)
    borderColorEnemy: "255, 80, 80",
    borderColorAlly: "90, 170, 255",
    borderColorNeutral: "255, 210, 90",

    // Animations (UI uses these)
    removeDurationMs: 240,
    shiftDurationMs: 280,
    currentSlideMs: 260,
    easing: "cubic-bezier(.2,.8,.2,1)",

    spawnDurationMs: 380,
    spawnStaggerMs: 35,
    spawnFromX: 40,
    despawnDurationMs: 220,

    tooltipScaleMs: 120,
    tooltipOffsetY: 10,
    tooltipMaxWidth: 240,

    // Filtering
    includeHiddenTokens: false,
    includeDefeated: false,
    includeDepletedAsGrey: false,

    // Activation source (fallback when no combat)
    fallbackActivationDefault: 1,

    // WEBM thumb behavior
    webmThumbMaxPx: 128,
    webmThumbTimeoutMs: 2500,

    // Interaction
    optimisticCurrentOnClick: true,
  };

  // =========================================================
  // Socket (optional safety net)
  // =========================================================
  const SOCKET_NS = `module.${MODULE_ID}`;
  const socketEmit = (payload) => {
    try {
      game.socket?.emit?.(SOCKET_NS, payload);
    } catch (_) {}
  };

  const socketInstall = () => {
    try {
      game.socket?.on?.(SOCKET_NS, (msg) => {
        if (!msg || msg?.scope !== "fabula-initiative") return;

        if (msg.type === "OPEN") ctrl.open("socket");
        if (msg.type === "CLOSE") ctrl.close("socket");
        if (msg.type === "REFRESH") ctrl.refresh("socket");
      });
    } catch (_) {}
  };

  // =========================================================
  // Lancer-Initiative flag ops
  // =========================================================
  const liGet = (combatant, path, fallback = null) => {
    try {
      const v = combatant?.getFlag?.(MODULE_FLAG, path);
      return v ?? fallback;
    } catch (_) {
      return fallback;
    }
  };

  const liSet = async (combatant, path, value) => {
    return combatant?.setFlag?.(MODULE_FLAG, path, value);
  };

  const liAddValue = async (combatant, delta) => {
    const cur = Number(liGet(combatant, "activations.value", 0)) || 0;
    return liSet(combatant, "activations.value", cur + delta);
  };

  const liAddMax = async (combatant, delta) => {
    const cur = Number(liGet(combatant, "activations.max", 0)) || 0;
    return liSet(combatant, "activations.max", cur + delta);
  };

  // =========================================================
  // Permission: players can only touch combatants they own
  // =========================================================
  const canUserControlCombatant = (combat, combatantId, user = game.user) => {
    if (!combat || !combatantId || !user) return false;
    if (user.isGM) return true;

    const c = combat.combatants?.get?.(combatantId);
    if (!c) return false;

    // Prefer token ownership when possible (scene tokens)
    const tok = c.tokenId ? canvas?.tokens?.get?.(c.tokenId) : null;
    if (tok?.isOwner) return true;

    // Fallback: actor permission
    const actor = c.actor ?? (c.actorId ? game.actors?.get?.(c.actorId) : null);
    if (actor?.testUserPermission?.(user, "OWNER")) return true;

    // Fallback: combatant permission
    if (c?.testUserPermission?.(user, "OWNER")) return true;

    return false;
  };

  const deny = (msg) => {
    ui?.notifications?.warn?.(msg);
  };

  // =========================================================
  // Logic mutations
  // =========================================================
  /**
   * Activate: consume 1 activation, set combat.turn to that combatant's index.
   */
  const liActivateCombatant = async (combat, combatantId) => {
    const combatant =
      combat?.getEmbeddedDocument?.("Combatant", combatantId) ?? combat?.combatants?.get?.(combatantId);

    if (!combat || !combatantId || !combatant) return null;

    // Permission gate (players must own)
    if (!canUserControlCombatant(combat, combatantId)) return null;

    // Require remaining activations
    const value = Number(liGet(combatant, "activations.value", 0)) || 0;
    if (value <= 0) return null;

    // Consume
    await liAddValue(combatant, -1);

    // Find turn index
    const turnIndex = (combat.turns ?? []).findIndex((t) => t?.id === combatantId);
    if (turnIndex < 0) return null;

    const opts = { direction: 1, worldTime: { delta: CONFIG.time.turnTime } };
    return combat.update({ turn: turnIndex }, opts);
  };

  /**
   * Deactivate current: set combat.turn = null (only if requested is current)
   */
  const liDeactivateCombatant = async (combat, combatantId) => {
    if (!combat || !combatantId) return null;

    // Permission gate (players must own)
    if (!canUserControlCombatant(combat, combatantId)) return null;

    const turnIndex = (combat.turns ?? []).findIndex((t) => t?.id === combatantId);
    if (turnIndex < 0) return null;

    if (turnIndex !== combat.turn) return null;

    const opts = { direction: 0, worldTime: { delta: 0 } };
    return combat.update({ turn: null }, opts);
  };

  // =========================================================
  // Controller (one instance per client)
  // =========================================================
  const ctrl = {
    isOpen: false,
    hooks: [],
    ui: null,
    manualHidden: false,

    async open(reason = "open") {
      if (this.isOpen || this.manualHidden) return;

      if (!globalThis.oniTurnBarUI?.create) {
        console.error(`${TAG} UI lib missing (oniTurnBarUI). Make sure the UI script is loaded before this controller.`);
        return;
      }

      this.isOpen = true;

      this.ui = globalThis.oniTurnBarUI.create({
        tuner: TUNER,
        ids: IDS,
        callbacks: {
          canInteract: async (action, payload) => {
            const combat = game.combat;
            // If no combat, disallow interactions that would mutate state
            if (!combat) return false;

            // Resolve combatantId depending on action
            let cid = null;
            if (action === "activate" || action === "grant") cid = payload?.combatantId ?? null;
            else if (action === "undoCurrent" || action === "clearCurrent") cid = combat?.combatant?.id ?? payload?.combatantId ?? null;

            if (!cid) return false;
            const ok = canUserControlCombatant(combat, cid);

            if (!ok) {
              const msg =
                action === "grant"
                  ? "You can only grant activations to tokens you own."
                  : "You can only activate/undo turns for tokens you own.";
              ui?.notifications?.warn?.(msg);
            }
            return ok;
          },

          onRequestRefresh: () => this.refresh("manual"),
          onCloseRequested: () => this.hide("manual"),

          // Queue LEFT click
          onActivate: async (icon) => this.onActivate(icon),

          // Queue RIGHT click (grant +1 activation)
          onGrant: async (icon) => this.onGrant(icon),

          // Current RIGHT click (undo)
          onUndoCurrent: async (curIcon) => this.onUndoCurrent(curIcon),

          // Current LEFT click (clear current only)
          onClearCurrent: async () => this.onClearCurrent(),
        },
      });

      this.ui.open();
      this.refresh(reason);
      this._installHooks();
    },

    async close(reason = "close") {
      this.isOpen = false;
      this.manualHidden = false; // combat ended => reset manual hide
      this._removeHooks();
      await this.ui?.close();
      this.ui = null;
    },

    async hide(reason = "hide") {
      // user clicked ✕ : hide until next combatStart (or manual unhide)
      this.manualHidden = true;
      await this.close(reason);
    },

    refresh(reason = "refresh") {
      if (!this.isOpen) return;
      const model = this._buildModel();
      this.ui?.render(model, reason);
    },

    async onActivate(icon) {
      const combat = game.combat;
      const cid = icon?.combatantId ?? null;
      if (!combat || !cid) return;

      if (!canUserControlCombatant(combat, cid)) {
        deny("You can only activate turns for tokens you own.");
        this.refresh("deny");
        return;
      }

      try {
        await liActivateCombatant(combat, cid);
      } catch (e) {
        console.warn(`${TAG} Activate failed`, e);
      }
    },

    async onGrant(icon) {
      const combat = game.combat;
      const cid = icon?.combatantId ?? null;
      if (!combat || !cid) return;

      if (!canUserControlCombatant(combat, cid)) {
        deny("You can only grant activations to tokens you own.");
        this.refresh("deny");
        return;
      }

      const combatant = combat.combatants?.get?.(cid);
      if (!combatant) return;

      try {
        // Grant one extra activation (remaining + max)
        await liAddValue(combatant, 1);
        await liAddMax(combatant, 1);
      } catch (e) {
        console.warn(`${TAG} Grant failed`, e);
      }
    },

    async onUndoCurrent(curIcon) {
      const combat = game.combat;
      const cid = curIcon?.combatantId ?? null;
      if (!combat || !cid) return;

      if (!canUserControlCombatant(combat, cid)) {
        deny("You can only undo turns for tokens you own.");
        this.refresh("deny");
        return;
      }

      const combatant = combat.combatants?.get?.(cid);
      if (!combatant) return;

      try {
        // If this combatant is current, clear current
        if (combat.combatant?.id === cid && combat.turn != null) {
          await liDeactivateCombatant(combat, cid);
        }

        // Restore the spent activation (value only)
        await liAddValue(combatant, 1);
      } catch (e) {
        console.warn(`${TAG} UndoCurrent failed`, e);
      }
    },

    async onClearCurrent() {
      const combat = game.combat;
      const curId = combat?.combatant?.id ?? null;
      if (!combat || !curId) return;

      if (!canUserControlCombatant(combat, curId)) {
        deny("You can only clear current for tokens you own.");
        this.refresh("deny");
        return;
      }

      try {
        await liDeactivateCombatant(combat, curId);
      } catch (e) {
        console.warn(`${TAG} ClearCurrent failed`, e);
      }
    },

    _buildModel() {
      const scene = canvas?.scene;
      const combat = game.combat;
      const tokens = canvas?.tokens?.placeables ?? [];

      // CURRENT
      let current = null;
      if (combat && combat.scene?.id === scene?.id && combat.turn != null && combat.combatant) {
        const c = combat.combatant;
        const tok = c.tokenId ? canvas.tokens?.get(c.tokenId) : null;

        // NEW: if current actor is a Summon, hide CURRENT entirely
        const curActor = tok?.actor ?? c.actor ?? (c.actorId ? game.actors?.get?.(c.actorId) : null);
        const isSummon = isSummonActor(curActor);

        if (!isSummon) {
          const rawImg =
            tok?.document?.texture?.src ||
            c.token?.texture?.src ||
            c.actor?.img ||
            "icons/svg/mystery-man.svg";

          const disp =
            c.getFlag?.(MODULE_FLAG, "disposition") ??
            c.token?.disposition ??
            c.actor?.prototypeToken?.disposition ??
            0;

          current = {
            key: `current::${c.id}`,
            combatantId: c.id,
            tokenId: c.tokenId,
            actorId: c.actorId,
            name: c.name ?? c.actor?.name ?? "Current",
            rawImg,
            isWebm: typeof rawImg === "string" && /\.webm(\?|#|$)/i.test(rawImg),
            disposition: Number(disp ?? 0),
          };
        }
      }

      // QUEUE ENTRIES
      const entries = [];
      for (const tok of tokens) {
        if (!tok?.actor) continue;

        // NEW: skip Summons entirely
        if (isSummonActor(tok.actor)) continue;

        if (!TUNER.includeHiddenTokens && tok.document.hidden) continue;
        if (!TUNER.includeDefeated && tok.actor?.statuses?.has?.("defeated")) continue;

        // Custom System Builder sanity gate (keeps your old behavior)
        const maxHp = foundry.utils.getProperty(tok.actor, "system.props.max_hp");
        if (maxHp == null) continue;

        let remaining = null;
        let max = null;
        let combatantId = null;

        if (combat && combat.scene?.id === scene?.id) {
          const c = combat.combatants?.find((cc) => cc?.tokenId === tok.id);
          if (c) {
            // NEW: if the combatant actor is a Summon, ignore it (extra safety)
            const cActor = c?.actor ?? (c?.actorId ? game.actors?.get?.(c.actorId) : null);
            if (isSummonActor(cActor)) continue;

            combatantId = c.id;
            remaining = c.getFlag(MODULE_FLAG, "activations.value");
            max = c.getFlag(MODULE_FLAG, "activations.max");
            if (remaining == null) remaining = 0;
            if (max == null) max = TUNER.fallbackActivationDefault;
          }
        }

        // Fallback outside combat
        if (remaining == null) {
          const a1 = foundry.utils.getProperty(tok.actor, "system.activation");
          const a2 = foundry.utils.getProperty(tok.actor, "system.props.activation");
          const fb = Number.isFinite(Number(a1))
            ? Number(a1)
            : Number.isFinite(Number(a2))
              ? Number(a2)
              : TUNER.fallbackActivationDefault;
          remaining = fb;
          max = fb;
        }

        if (!TUNER.includeDepletedAsGrey && remaining <= 0) continue;

        const rawImg = tok.document?.texture?.src || tok.actor?.img || "icons/svg/mystery-man.svg";
        const disp = Number(tok.document?.disposition ?? 0);

        entries.push({
          tokenId: tok.id,
          actorId: tok.actor.id,
          combatantId,
          name: tok.name ?? tok.actor.name ?? "Unknown",
          rawImg,
          isWebm: typeof rawImg === "string" && /\.webm(\?|#|$)/i.test(rawImg),
          disposition: disp,
          remaining: Math.max(0, Number(remaining) || 0),
          max: Math.max(0, Number(max) || 0),
          depleted: remaining <= 0,
        });
      }

      // EXPAND INTO ICONS
      const icons = [];
      for (const e of entries) {
        const count = e.depleted && TUNER.includeDepletedAsGrey ? 1 : e.remaining;
        for (let i = 0; i < count; i++) {
          icons.push({
            key: `${e.tokenId}::${i}`,
            ...e,
            index: i,
          });
        }
      }

      return { current, icons };
    },

    _installHooks() {
      const h1 = Hooks.on("updateCombat", (combat) => {
        if (!this.isOpen) return;
        if (game.combat?.id !== combat?.id) return;
        this.refresh("updateCombat");
      });

      const h2 = Hooks.on("updateCombatant", (combatant) => {
        if (!this.isOpen) return;
        if (combatant?.parent?.id !== game.combat?.id) return;
        this.refresh("updateCombatant");
      });

      const h3 = Hooks.on("combatRound", () => {
        if (!this.isOpen) return;
        this.refresh("combatRound");
      });

      const h4 = Hooks.on("combatStart", () => {
        if (!this.isOpen) return;
        this.refresh("combatStart");
      });

      const h5 = Hooks.on("canvasReady", () => {
        // Scene changed / reloaded — rebuild model for this scene
        if (!this.isOpen) return;
        this.refresh("canvasReady");
      });

      this.hooks.push(
        ["updateCombat", h1],
        ["updateCombatant", h2],
        ["combatRound", h3],
        ["combatStart", h4],
        ["canvasReady", h5]
      );
    },

    _removeHooks() {
      for (const [name, id] of this.hooks) Hooks.off(name, id);
      this.hooks = [];
    },
  };

  // Expose (optional) for your future debugging tools
  globalThis.__ONI_FABULA_INITIATIVE__ = ctrl;

  // =========================================================
  // Auto-lifecycle: combat start/end (per-client)
  // =========================================================
  const shouldShowForCurrentClient = () => {
    const combat = game.combat;
    const scene = canvas?.scene;
    if (!combat || !scene) return false;
    if (!combat.started) return false;
    if (combat.scene?.id !== scene.id) return false;
    return true;
  };

  const openIfNeeded = (reason) => {
    if (ctrl.isOpen) return;
    if (ctrl.manualHidden) return;
    if (!shouldShowForCurrentClient()) return;
    ctrl.open(reason);
  };

  const closeIfOpen = (reason) => {
    if (!ctrl.isOpen) return;
    ctrl.close(reason);
  };

  const installLifecycleHooks = () => {
    // Combat start/end hooks fire on all clients (when documents update)
    Hooks.on("combatStart", (combat) => {
      // If we're not on the same scene, don't open
      if (combat?.scene?.id !== canvas?.scene?.id) return;

      // Everyone opens locally
      ctrl.manualHidden = false;
      ctrl.open("combatStart");

      // Optional: GM broadcasts as safety net
      if (game.user?.isGM) socketEmit({ scope: "fabula-initiative", type: "OPEN", combatId: combat.id });
    });

    Hooks.on("combatEnd", (combat) => {
      closeIfOpen("combatEnd");
      if (game.user?.isGM) socketEmit({ scope: "fabula-initiative", type: "CLOSE", combatId: combat?.id });
    });

    Hooks.on("deleteCombat", (combat) => {
      closeIfOpen("deleteCombat");
      if (game.user?.isGM) socketEmit({ scope: "fabula-initiative", type: "CLOSE", combatId: combat?.id });
    });

    // If user swaps scenes while combat is active, auto-close/open as needed
    Hooks.on("canvasReady", () => {
      if (shouldShowForCurrentClient()) openIfNeeded("canvasReady");
      else closeIfOpen("sceneMismatch");
    });

    // If player reloads mid-combat, open on ready
    Hooks.once("ready", () => openIfNeeded("ready"));
  };

  Hooks.once("ready", () => {
    socketInstall();
    installLifecycleHooks();

    // in case combat already active at ready time
    openIfNeeded("ready");
  });
})();
