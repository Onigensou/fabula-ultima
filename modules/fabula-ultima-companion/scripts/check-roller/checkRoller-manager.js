/**
 * ONI — Check Roller (Fabula Ultima) : CheckRoller_Manager
 * Foundry VTT v12
 * -----------------------------------------------------------------------------
 * Purpose
 * - Central “flow manager” for the Check Roller system.
 * - Owns: naming conventions, payload validation, process lifecycle + locking,
 *         and a modular step pipeline that other scripts can plug into.
 *
 * What this manager DOES (right now):
 * - Provides a safe global API: ONI.CheckRoller
 * - Prevents overlapping runs per-user (with optional queue mode)
 * - Validates + normalizes payload structure
 * - Runs a sequential pipeline of async steps with state transitions
 * - Emits Foundry Hooks events for each stage
 *
 * What other scripts will add later:
 * - ButtonInstall -> calls ONI.CheckRoller.openDialog()
 * - Dialog -> registers as adapter "openDialog"
 * - Core -> registers as adapter "computeRoll"
 * - CreateCard -> registers as adapter "renderCard"
 * - Hydrate -> listens to chat render + reads flags (separate)
 * - InvokeButtons -> updates message using manager helpers (separate)
 *
 * Collision-safe naming convention (no overlap with Action System):
 * - Flag scope:  "oni-check-roller"
 * - Flag key:    "checkRollerCard"
 * - Hook prefix: "oni.checkRoller.*"
 * - CSS prefix:  "oni-cr-"
 * - Data attrs:  data-oni-cr-*
 *
 * IMPORTANT
 * - This file is intentionally self-contained. Other scripts should call
 *   ONI.CheckRoller.registerAdapter(...) and ONI.CheckRoller.registerStep(...)
 *   instead of importing from Action System.
 */

(() => {
  // ---------------------------------------------------------------------------
  // Guard / Namespace
  // ---------------------------------------------------------------------------
  const ROOT = globalThis;
  ROOT.ONI = ROOT.ONI || {};

  const VERSION = "0.1.0";
  const TAG = "[ONI][CheckRoller:Manager]";

  // If re-running, gently replace (idempotent dev workflow).
  const previous = ROOT.ONI.CheckRoller;
  if (previous && previous.__isCheckRollerManager) {
    console.log(`${TAG} Replacing existing manager instance v${previous.version} -> v${VERSION}`);
  }

  // ---------------------------------------------------------------------------
  // Constants (collision-safe)
  // ---------------------------------------------------------------------------
  const CONST = Object.freeze({
    VERSION,
    FLAG_SCOPE: "fabula-ultima-companion", // ✅ valid module scope
    LEGACY_FLAG_SCOPE: "oni-check-roller", // ✅ read old cards already posted
    FLAG_KEY_CARD: "checkRollerCard",
    HOOK_PREFIX: "oni.checkRoller",
    CSS_PREFIX: "oni-cr-",
    DATA_PREFIX: "oniCr", // for dataset keys if needed later

    // Attribute icons (mirrors UI TESTER)
    ICONS: Object.freeze({
      MIG: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/asan.png",
      DEX: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/boot.png",
      WLP: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/stat.png",
      INS: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/book.png",
    }),

    DEFAULTS: Object.freeze({
      // Lock behavior:
      // - "block" : if a run is in progress for this user, reject new run
      // - "queue" : queue next run for this user
      LOCK_MODE: "block",

      // Visibility defaults:
      VISIBILITY: "all",      // "all" | "gm" | "self"
      DL_VISIBILITY: "hidden", // "shown" | "hidden"

      // UI tuning (mirrors UI TESTER)
      UI_TUNING: Object.freeze({
        // Portrait
        portraitUrl: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Character/Cherry/Cherry_Portrait.png",
        portraitSize: 76,
        portraitX: 0,
        portraitY: 0,

        // "Check" label
        checkText: "Check",
        checkSize: 20,
        checkX: 70,
        checkY: -14,

        // "Check" stroke/outline
        checkStrokeSize: 5,
        checkStrokeColor: "#f7ecd9",

        // Die A/B
        dieIconSize: 24,
        dieValueSize: 14,

        // Total
        totalRollMs: 1500,
        totalFontSize: 21,

          // Local-only roll SFX for the total roll-up
        rollSfxEnabled: true,
        rollSfxVolume: 0.8,
        rollSfxUrl: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Dice.wav",

        // Local-only special SFX for Crit/Fumble (overrides rollSfxUrl when applicable)
        critSfxUrl: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Flash2.ogg",
        fumbleSfxUrl: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/ME/Shock2.ogg"
      })
    })
  });

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------
  const now = () => Date.now();

  const randomId = () => {
  // Foundry v12+ preferred
  if (globalThis.foundry?.utils?.randomID) return globalThis.foundry.utils.randomID();

  // Back-compat fallback (older versions / unusual environments)
  if (typeof globalThis.randomID === "function") return globalThis.randomID();

  // Final fallback
  return `${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}`;
};

  const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

  const deepClone = (v) => {
    // Good enough for payload objects (no functions).
    try {
      return structuredClone(v);
    } catch (e) {
      return JSON.parse(JSON.stringify(v));
    }
  };

  const safeStr = (v, fallback = "") => (typeof v === "string" ? v : (v == null ? fallback : String(v)));
  const safeNum = (v, fallback = 0) => {
    const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(/[^\d.-]/g, ""));
    return Number.isFinite(n) ? n : fallback;
  };
  const safeInt = (v, fallback = 0) => Math.floor(safeNum(v, fallback));

  const clampInt = (n, a, b) => Math.max(a, Math.min(b, safeInt(n, a)));

  const hookName = (suffix) => `${CONST.HOOK_PREFIX}.${suffix}`;

  const callHook = (suffix, ...args) => {
    try {
      return Hooks.callAll(hookName(suffix), ...args);
    } catch (e) {
      console.warn(`${TAG} Hook call failed (${suffix}):`, e);
      return false;
    }
  };

  // ---------------------------------------------------------------------------
  // Process State
  // ---------------------------------------------------------------------------
  const STATE = Object.freeze({
    IDLE: "idle",
    VALIDATING: "validating",
    COMPUTING: "computing",
    RENDERING: "rendering",
    COMPLETE: "complete",
    ERROR: "error",
    CANCELLED: "cancelled"
  });

  /**
   * Per-user lock / queue
   * - locks: Map<userId, processObject>
   * - queues: Map<userId, Array<{payload, resolve, reject}>>
   */
  const locks = new Map();
  const queues = new Map();

  // ---------------------------------------------------------------------------
  // Adapters (pluggable functions provided by other scripts)
  // ---------------------------------------------------------------------------
  const adapters = {
    /**
     * openDialog(context) -> payload
     * Provided by: CheckRoller_Dialog
     */
    openDialog: null,

    /**
     * computeRoll(payload) -> { payload, result, rollData, ... }
     * Provided by: CheckRoller_Core
     */
    computeRoll: null,

    /**
     * renderCard(payloadOrContext) -> { messageId?, message?, html? }
     * Provided by: CheckRoller_CreateCard
     */
    renderCard: null,

    /**
     * updateMessage(message, {html, flags}) -> Promise<Message>
     * Provided optionally by: CheckRoller_CreateCard / InvokeButtons script
     */
    updateMessage: null
  };

  // ---------------------------------------------------------------------------
  // Steps (pipeline)
  // ---------------------------------------------------------------------------
  /**
   * Each step is: async (ctx) => ctx
   * ctx shape (manager-owned):
   * {
   *   processId, state, startedAt, finishedAt,
   *   userId, userName,
   *   payload,                 // normalized
   *   result,                  // from computeRoll
   *   message,                 // from renderCard
   *   messageId,
   *   errors: [],
   * }
   */
  const steps = [];

  const registerDefaultSteps = () => {
    steps.length = 0;

    // Step 1: validate + normalize payload
    steps.push({
      id: "validate",
      label: "Validate payload",
      run: async (ctx) => {
        ctx.state = STATE.VALIDATING;
        callHook("state", deepClone(ctx));

        const normalized = api.validateAndNormalizePayload(ctx.payload, ctx);
        ctx.payload = normalized;

        callHook("validated", deepClone(ctx));
        return ctx;
      }
    });

    // Step 2: compute roll (optional for now)
    steps.push({
      id: "compute",
      label: "Compute roll",
      run: async (ctx) => {
        ctx.state = STATE.COMPUTING;
        callHook("state", deepClone(ctx));

        if (typeof adapters.computeRoll !== "function") {
          console.warn(`${TAG} computeRoll adapter not registered yet. Skipping compute step.`);
          return ctx;
        }

        const out = await adapters.computeRoll(deepClone(ctx.payload), deepClone(ctx));
        // allow adapter to return {payload, result, ...}
        if (isObj(out) && out.payload) ctx.payload = out.payload;
        if (isObj(out) && "result" in out) ctx.result = out.result;

        callHook("computed", deepClone(ctx));
        return ctx;
      }
    });

    // Step 3: render chat card (optional for now)
    steps.push({
      id: "render",
      label: "Render card",
      run: async (ctx) => {
        ctx.state = STATE.RENDERING;
        callHook("state", deepClone(ctx));

        if (typeof adapters.renderCard !== "function") {
          console.warn(`${TAG} renderCard adapter not registered yet. Skipping render step.`);
          return ctx;
        }

        const out = await adapters.renderCard(deepClone(ctx.payload), deepClone(ctx));
        if (isObj(out)) {
          if (out.message) ctx.message = out.message;
          if (out.messageId) ctx.messageId = out.messageId;
        }

        callHook("rendered", deepClone(ctx));
        return ctx;
      }
    });
  };

  // ---------------------------------------------------------------------------
  // Payload validation + normalization
  // ---------------------------------------------------------------------------
  /**
   * Expected minimal payload:
   * {
   *   kind: "fu_check",
   *   meta: { userId, userName, actorUuid, actorName, invoked:{trait,bond} },
   *   check: { attrs:[A,B], dice:{A,B}, dl?, modifier? },
   *   result?: {...} // optional prefilled
   * }
   */
  const validateAndNormalizePayload = (rawPayload, ctx) => {
    const p = isObj(rawPayload) ? deepClone(rawPayload) : {};
    p.kind = safeStr(p.kind, "fu_check");

    p.meta = isObj(p.meta) ? p.meta : {};
    p.meta.schemaVersion = safeStr(p.meta.schemaVersion, "1");

    // Fill user identity
    const user = game?.user;
    p.meta.userId = safeStr(p.meta.userId, user?.id || "");
    p.meta.userName = safeStr(p.meta.userName, user?.name || "Unknown");

    // Actor identity (we’ll keep it flexible; Dialog will fill it later)
    p.meta.actorUuid = safeStr(p.meta.actorUuid, "");
    p.meta.actorName = safeStr(p.meta.actorName, "");

    // Visibility
    p.meta.visibility = safeStr(p.meta.visibility, CONST.DEFAULTS.VISIBILITY); // "all" | "gm" | "self"
    p.meta.dlVisibility = safeStr(p.meta.dlVisibility, CONST.DEFAULTS.DL_VISIBILITY); // "shown" | "hidden"

   // Invocation flags (once per check)
    p.meta.invoked = isObj(p.meta.invoked) ? p.meta.invoked : {};
    p.meta.invoked.trait = Boolean(p.meta.invoked.trait);
    p.meta.invoked.bond = Boolean(p.meta.invoked.bond);

    // UI tuning (mirrors UI TESTER)
    p.meta.ui = isObj(p.meta.ui) ? p.meta.ui : {};
    p.meta.ui.tuning = isObj(p.meta.ui.tuning) ? p.meta.ui.tuning : {};

    const d = CONST.DEFAULTS.UI_TUNING;
    const t = p.meta.ui.tuning;

    t.portraitUrl = safeStr(t.portraitUrl, d.portraitUrl);
    t.portraitSize = safeInt(t.portraitSize, d.portraitSize);
    t.portraitX = safeInt(t.portraitX, d.portraitX);
    t.portraitY = safeInt(t.portraitY, d.portraitY);

    t.checkText = safeStr(t.checkText, d.checkText);
    t.checkSize = safeInt(t.checkSize, d.checkSize);
    t.checkX = safeInt(t.checkX, d.checkX);
    t.checkY = safeInt(t.checkY, d.checkY);

    t.checkStrokeSize = safeInt(t.checkStrokeSize, d.checkStrokeSize);
    t.checkStrokeColor = safeStr(t.checkStrokeColor, d.checkStrokeColor);

    t.dieIconSize = safeInt(t.dieIconSize, d.dieIconSize);
    t.dieValueSize = safeInt(t.dieValueSize, d.dieValueSize);

    t.totalRollMs = safeInt(t.totalRollMs, d.totalRollMs);
    t.totalFontSize = safeInt(t.totalFontSize, d.totalFontSize);

          t.rollSfxEnabled = (typeof t.rollSfxEnabled === "boolean") ? t.rollSfxEnabled : d.rollSfxEnabled;
      t.rollSfxVolume = Math.max(0, Math.min(1, Number(t.rollSfxVolume ?? d.rollSfxVolume)));
      t.rollSfxUrl = safeStr(t.rollSfxUrl, d.rollSfxUrl);

      // Crit/Fumble SFX
      t.critSfxUrl = safeStr(t.critSfxUrl, d.critSfxUrl);
      t.fumbleSfxUrl = safeStr(t.fumbleSfxUrl, d.fumbleSfxUrl);

    // Process markers
    p.meta.requestId = safeStr(p.meta.requestId, randomId());
    p.meta.createdAt = safeInt(p.meta.createdAt, now());

    // Check block
    p.check = isObj(p.check) ? p.check : {};
    p.check.type = safeStr(p.check.type, "Attribute"); // Accuracy | Magic | Opposed | Open | Attribute (label only for now)

    // Attributes: ["DEX","MIG"] etc
    const attrs = Array.isArray(p.check.attrs) ? p.check.attrs.map((x) => safeStr(x).toUpperCase()).filter(Boolean) : [];
    p.check.attrs = attrs.length ? attrs.slice(0, 2) : ["DEX", "MIG"]; // safe fallback

    // Dice sizes
    p.check.dice = isObj(p.check.dice) ? p.check.dice : {};
    p.check.dice.A = clampInt(p.check.dice.A, 4, 20); // Fabula dice are typically d6-d12, but we’ll allow broader safely
    p.check.dice.B = clampInt(p.check.dice.B, 4, 20);

    // DL (optional)
    if (p.check.dl === "" || p.check.dl == null) {
      delete p.check.dl;
    } else {
      p.check.dl = safeInt(p.check.dl, 0);
    }

    // Modifiers
    p.check.modifier = isObj(p.check.modifier) ? p.check.modifier : {};
    p.check.modifier.parts = Array.isArray(p.check.modifier.parts) ? p.check.modifier.parts : [];
    p.check.modifier.parts = p.check.modifier.parts
      .map((m) => ({
        label: safeStr(m?.label, "Modifier"),
        value: safeInt(m?.value, 0)
      }))
      .filter((m) => m.label.length);

    p.check.modifier.total = safeInt(
      p.check.modifier.total,
      p.check.modifier.parts.reduce((a, b) => a + safeInt(b.value, 0), 0)
    );

    // Result block (optional)
    p.result = isObj(p.result) ? p.result : {};
    // We don’t compute here; Core does. But we normalize keys if present.
    if ("dieA" in p.result) p.result.dieA = safeInt(p.result.dieA, 0);
    if ("dieB" in p.result) p.result.dieB = safeInt(p.result.dieB, 0);
    if ("hr" in p.result) p.result.hr = safeInt(p.result.hr, 0);
    if ("total" in p.result) p.result.total = safeInt(p.result.total, 0);
    if ("isCrit" in p.result) p.result.isCrit = Boolean(p.result.isCrit);
    if ("isFumble" in p.result) p.result.isFumble = Boolean(p.result.isFumble);

    // Basic sanity validations (collect errors but don’t hard-crash)
    const errors = [];
    if (!p.meta.userId) errors.push("meta.userId is missing");
    if (!Array.isArray(p.check.attrs) || p.check.attrs.length !== 2) errors.push("check.attrs must be a 2-item array");
    if (!p.check.dice.A || !p.check.dice.B) errors.push("check.dice.A and check.dice.B are required");

    if (errors.length) {
      ctx.errors = ctx.errors || [];
      ctx.errors.push(...errors);
      console.warn(`${TAG} Payload validation warnings:`, errors, deepClone(p));
    }

    return p;
  };

  // ---------------------------------------------------------------------------
  // Locking / queueing
  // ---------------------------------------------------------------------------
  const getUserLockMode = () => safeStr(api.config.lockMode, CONST.DEFAULTS.LOCK_MODE);

  const isRunningForUser = (userId) => locks.has(userId);

  const enqueueForUser = (userId, entry) => {
    if (!queues.has(userId)) queues.set(userId, []);
    queues.get(userId).push(entry);
    console.log(`${TAG} Queued CheckRoller run for user=${userId}. QueueLen=${queues.get(userId).length}`);
  };

  const dequeueAndRunNext = async (userId) => {
    const q = queues.get(userId);
    if (!q || !q.length) return;

    const next = q.shift();
    if (!q.length) queues.delete(userId);

    try {
      const result = await api.run(next.payload);
      next.resolve(result);
    } catch (e) {
      next.reject(e);
    }
  };

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------
  const api = {
    __isCheckRollerManager: true,
    version: VERSION,
    CONST,
    STATE,

    // runtime config
    config: {
      lockMode: CONST.DEFAULTS.LOCK_MODE // "block" | "queue"
    },

    // adapters
    registerAdapter(name, fn) {
      if (!Object.prototype.hasOwnProperty.call(adapters, name)) {
        throw new Error(`${TAG} Unknown adapter name: ${name}`);
      }
      if (fn !== null && typeof fn !== "function") {
        throw new Error(`${TAG} Adapter ${name} must be a function or null`);
      }
      adapters[name] = fn;
      console.log(`${TAG} Adapter registered: ${name}`, fn ? "(function)" : "(null)");
    },

    // steps
    registerStep(step, { beforeId = null, afterId = null } = {}) {
      if (!isObj(step) || typeof step.id !== "string" || typeof step.run !== "function") {
        throw new Error(`${TAG} registerStep requires {id:string, run:function}`);
      }
      // prevent duplicates by id
      const existingIndex = steps.findIndex((s) => s.id === step.id);
      if (existingIndex !== -1) steps.splice(existingIndex, 1);

      if (beforeId) {
        const idx = steps.findIndex((s) => s.id === beforeId);
        if (idx === -1) steps.unshift(step);
        else steps.splice(idx, 0, step);
      } else if (afterId) {
        const idx = steps.findIndex((s) => s.id === afterId);
        if (idx === -1) steps.push(step);
        else steps.splice(idx + 1, 0, step);
      } else {
        steps.push(step);
      }

      console.log(`${TAG} Step registered: ${step.id}`);
    },

    listSteps() {
      return steps.map((s) => ({ id: s.id, label: s.label || s.id }));
    },

    // payload helpers
    validateAndNormalizePayload,

    // lock helpers
    isRunning() {
      const userId = game?.user?.id || "";
      return Boolean(userId && isRunningForUser(userId));
    },

    getActiveProcess() {
      const userId = game?.user?.id || "";
      return userId ? locks.get(userId) || null : null;
    },

    // core entry points
    async openDialog(dialogContext = {}) {
      if (typeof adapters.openDialog !== "function") {
        ui?.notifications?.warn("Check Roller: Dialog adapter not installed yet.");
        console.warn(`${TAG} openDialog called but adapter not registered.`);
        return null;
      }

      // Allow the dialog to build a payload. Dialog can call api.run(payload) itself,
      // but we also support Manager-driven flow:
      const safeCtx = (dialogContext && typeof dialogContext === "object") ? deepClone(dialogContext) : {};
      // Forward any caller-provided context (e.g., dl, dlVisibility, visibility) to the Dialog adapter.
      // We ALWAYS provide managerVersion + CONST so the dialog can stay collision-safe.
      const payload = await adapters.openDialog(Object.assign(safeCtx, {
        managerVersion: VERSION,
        CONST: deepClone(CONST)
      }));

      return payload;
    },

    /**
     * Run the full check flow:
     * - lock per-user
     * - validate/normalize
     * - compute (if adapter registered)
     * - render (if adapter registered)
     * Returns context object.
     */
    async run(rawPayload) {
      const user = game?.user;
      const userId = user?.id || "";
      if (!userId) throw new Error(`${TAG} Cannot run: game.user not available.`);

      // lock/queue behavior
      const mode = getUserLockMode();
      if (isRunningForUser(userId)) {
        if (mode === "queue") {
          return await new Promise((resolve, reject) => {
            enqueueForUser(userId, { payload: rawPayload, resolve, reject });
          });
        }
        // mode === "block"
        ui?.notifications?.warn("Check Roller is already running. Please finish the current check first.");
        throw new Error(`${TAG} Blocked: process already running for user=${userId}`);
      }

      // create process context
      const ctx = {
        processId: randomId(),
        state: STATE.IDLE,
        startedAt: now(),
        finishedAt: null,
        userId,
        userName: user?.name || "Unknown",
        payload: rawPayload,
        result: null,
        message: null,
        messageId: null,
        errors: []
      };

      // acquire lock
      locks.set(userId, ctx);
      callHook("processStart", deepClone(ctx));
      console.log(`${TAG} Process start`, { processId: ctx.processId, userId, mode });

      try {
        // run pipeline
        for (const step of steps) {
          callHook("stepStart", step.id, deepClone(ctx));
          console.log(`${TAG} Step -> ${step.id}`);
          ctx.payload = ctx.payload; // explicit
          const out = await step.run(ctx);
          if (out) {
            // allow step to return ctx (or partial)
            Object.assign(ctx, out);
          }
          callHook("stepEnd", step.id, deepClone(ctx));

          if (ctx.state === STATE.CANCELLED) {
            console.log(`${TAG} Process cancelled mid-pipeline.`);
            break;
          }
        }

        if (ctx.state !== STATE.CANCELLED) {
          ctx.state = STATE.COMPLETE;
        }

        ctx.finishedAt = now();
        callHook("processEnd", deepClone(ctx));
        console.log(`${TAG} Process end`, { processId: ctx.processId, state: ctx.state });

        return deepClone(ctx);
      } catch (e) {
        ctx.state = STATE.ERROR;
        ctx.finishedAt = now();
        ctx.errors.push(e?.message || String(e));

        callHook("processError", deepClone(ctx), e);
        console.error(`${TAG} Process error`, e);

        throw e;
      } finally {
        // release lock
        locks.delete(userId);

        // run next queued item (if any)
        if (getUserLockMode() === "queue") {
          await dequeueAndRunNext(userId);
        }
      }
    },

    /**
     * Optional helper for other scripts:
     * Read the check payload off a message flag, using our collision-safe keys.
     */
    getPayloadFromMessage(message) {
      if (!message) return null;
      const scope = CONST.FLAG_SCOPE;
      const key = CONST.FLAG_KEY_CARD;
      const v = message.getFlag(scope, key);
      return isObj(v) ? deepClone(v) : null;
    },

       /**
     * Optional helper for other scripts:
     * Update the UI of an existing CheckRoller chat message using the
     * currently-installed renderer (CreateCard).
     *
     * Used by InvokeButtons so rerolls keep the exact same chat card UI.
     */
    async updateMessage(message, { payload } = {}) {
      if (!message) throw new Error(`${TAG} updateMessage: message is required`);

      if (typeof adapters.updateMessage !== "function") {
        throw new Error(`${TAG} updateMessage adapter not registered. Run [CheckRoller] CreateCard first.`);
      }

      const normalized = payload
        ? validateAndNormalizePayload(payload, { errors: [] })
        : null;

      return await adapters.updateMessage(message, { payload: normalized });
    },

    /**
     * Optional helper for other scripts:
     * Set/update the payload on a message flag (used by CreateCard / Invoke).
     */
    async setPayloadOnMessage(message, payload) {
      if (!message) throw new Error(`${TAG} setPayloadOnMessage: message is required`);
      const scope = CONST.FLAG_SCOPE;
      const key = CONST.FLAG_KEY_CARD;
      const normalized = validateAndNormalizePayload(payload, { errors: [] });
      return await message.setFlag(scope, key, normalized);
    }
  };

  // ---------------------------------------------------------------------------
  // Initialize default steps and expose
  // ---------------------------------------------------------------------------
  registerDefaultSteps();

  ROOT.ONI.CheckRoller = api;

  console.log(`${TAG} Ready v${VERSION}`, {
    FLAG_SCOPE: CONST.FLAG_SCOPE,
    FLAG_KEY_CARD: CONST.FLAG_KEY_CARD,
    lockMode: api.config.lockMode,
    steps: api.listSteps()
  });

  // Emit a one-time "ready" hook so other scripts can register adapters/steps.
  callHook("ready", { version: VERSION, CONST: deepClone(CONST) });
})();
