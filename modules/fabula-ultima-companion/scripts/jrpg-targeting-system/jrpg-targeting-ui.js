// ============================================
// JRPG Targeting System - UI
// File: jrpg-targeting-ui.js
// Foundry VTT V12
// ============================================

import {
  GLOBALS,
  UI
} from "./jrpg-targeting-constants.js";

import {
  createJRPGTargetingDebugger,
  makeJRPGTargetingRunId
} from "./jrpg-targeting-debug.js";

const dbg = createJRPGTargetingDebugger("UI");

/* -------------------------------------------- */
/* Internal helpers                             */
/* -------------------------------------------- */

function toFiniteNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clampMin(value, min, fallback = min) {
  const n = toFiniteNumber(value, fallback);
  return Math.max(min, n);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function mergeSettings(base = {}, extra = {}) {
  return {
    ...base,
    ...(extra || {})
  };
}

function formatCountText(count = 0) {
  const safe = Math.max(0, Number(count) || 0);
  return `${safe} target${safe === 1 ? "" : "s"} selected`;
}

function swallowEvent(event, label = "UI EVENT", runId = "") {
  try {
    dbg.logRun(runId, `${label} SWALLOWED`, {
      type: event?.type,
      button: event?.button
    });
    event?.preventDefault?.();
    event?.stopPropagation?.();
    event?.stopImmediatePropagation?.();
  } catch (err) {
    dbg.errorRun(runId, `${label} SWALLOW FAILED`, err);
  }
}

function ensureUIRegistry() {
  if (!globalThis[GLOBALS.UI_STATE_KEY]) {
    globalThis[GLOBALS.UI_STATE_KEY] = {
      active: null,
      instances: {}
    };
    dbg.log("UI REGISTRY CREATED");
  }

  return globalThis[GLOBALS.UI_STATE_KEY];
}

function registerUIInstance(instance) {
  const registry = ensureUIRegistry();
  registry.instances[instance.instanceId] = instance;
  registry.active = instance;
  dbg.logRun(instance.runId, "UI REGISTERED", {
    instanceId: instance.instanceId
  });
}

function unregisterUIInstance(instance) {
  const registry = ensureUIRegistry();
  delete registry.instances[instance.instanceId];

  if (registry.active?.instanceId === instance.instanceId) {
    registry.active = null;
  }

  dbg.logRun(instance.runId, "UI UNREGISTERED", {
    instanceId: instance.instanceId
  });
}

function getStyleId() {
  return UI.IDS.STYLE;
}

function ensureStyleElement() {
  const existing = document.getElementById(getStyleId());
  if (existing) return existing;

  const style = document.createElement("style");
  style.id = getStyleId();
  style.textContent = `
    .${UI.CLASSES.RESET},
    .${UI.CLASSES.RESET} * {
      box-sizing: border-box;
      font-family: var(--font-primary);
    }

    .${UI.CLASSES.FLOATING} {
      position: fixed;
      user-select: none;
    }

    .${UI.CLASSES.CARD} {
      min-width: 240px;
      border: 2px solid #b9985a;
      border-radius: 12px;
      background: rgba(15, 15, 18, 0.94);
      color: #f5ead7;
      box-shadow: 0 6px 18px rgba(0,0,0,0.45);
      backdrop-filter: blur(2px);
    }

    .${UI.CLASSES.TOP_INNER} {
      text-align: center;
      padding: 10px 18px;
      transform-origin: 50% 50%;
      will-change: transform, opacity;
    }

    .${UI.CLASSES.TITLE} {
      font-size: 18px;
      font-weight: 700;
      line-height: 1.2;
    }

    .${UI.CLASSES.COUNT} {
      margin-top: 4px;
      font-size: 12px;
      opacity: 0.85;
      color: #d9c39a;
      line-height: 1.2;
    }

    .${UI.CLASSES.CONTROLS_ROW} {
      display: flex;
      align-items: center;
      gap: 10px;
      transform-origin: 100% 100%;
      will-change: transform, opacity;
    }

    .${UI.CLASSES.BUTTON} {
      appearance: none;
      border-radius: 10px;
      padding: 10px 16px;
      font-weight: 700;
      cursor: pointer;
      box-shadow: 0 4px 10px rgba(0,0,0,0.35);
      transition: filter 120ms ease, transform 120ms ease, opacity 120ms ease;
      pointer-events: auto;
    }

    .${UI.CLASSES.BUTTON}:hover:not(:disabled) {
      filter: brightness(1.06);
      transform: translateY(-1px);
    }

    .${UI.CLASSES.BUTTON}:active:not(:disabled) {
      transform: translateY(0);
    }

    .${UI.CLASSES.BUTTON}:disabled {
      cursor: not-allowed;
      opacity: 0.55;
      filter: grayscale(0.2);
    }

    .${UI.CLASSES.CONFIRM} {
      border: 2px solid #5a8f5a;
      background: #233523;
      color: #eaf7ea;
    }

    .${UI.CLASSES.CANCEL} {
      border: 2px solid #9a5a5a;
      background: #3b2020;
      color: #ffeaea;
    }
  `;

  document.head.appendChild(style);
  dbg.log("STYLE INSTALLED", { id: style.id });
  return style;
}

/* -------------------------------------------- */
/* UI Class                                     */
/* -------------------------------------------- */

export class JRPGTargetingUI {
  constructor(options = {}) {
    this.instanceId = options.instanceId || makeJRPGTargetingRunId("UI");
    this.runId = this.instanceId;

    this.sessionId = options.sessionId ?? null;
    this.userId = options.userId ?? game.user?.id ?? null;

    this.settings = mergeSettings(UI.TUNING, options.settings || {});
    this.titleText = String(options.titleText || UI.TEXT.DEFAULT_TITLE);
    this.countText = String(options.countText || UI.TEXT.DEFAULT_COUNT_ZERO);
    this.confirmText = String(options.confirmText || UI.TEXT.CONFIRM);
    this.cancelText = String(options.cancelText || UI.TEXT.CANCEL);

    this.state = {
      created: false,
      visible: false,
      destroyed: false,
      idleRunning: false
    };

    this.dom = {
      style: null,
      topOuter: null,
      topInner: null,
      title: null,
      count: null,
      controlsOuter: null,
      controlsRow: null,
      confirm: null,
      cancel: null
    };

    this.listeners = {
      confirm: null,
      cancel: null
    };

    this.callbacks = {
      onConfirm: null,
      onCancel: null
    };

    this.animations = {
      topIdle: null,
      controlsIdle: null
    };

    dbg.logRun(this.runId, "CTOR", {
      sessionId: this.sessionId,
      userId: this.userId,
      settings: this.settings
    });
  }

  /* ---------------------------------------- */
  /* Create / Mount                           */
  /* ---------------------------------------- */

  create() {
    if (this.state.created || this.state.destroyed) return this;

    dbg.logRun(this.runId, "CREATE START");

    this.dom.style = ensureStyleElement();

    const topOuter = document.createElement("div");
    topOuter.id = UI.IDS.TOP_WRAP;
    topOuter.className = `${UI.CLASSES.RESET} ${UI.CLASSES.FLOATING}`;
    topOuter.style.pointerEvents = "none";

    topOuter.innerHTML = `
      <div class="${UI.CLASSES.CARD} ${UI.CLASSES.TOP_INNER}">
        <div id="${UI.IDS.TITLE}" class="${UI.CLASSES.TITLE}">${escapeHtml(this.titleText)}</div>
        <div id="${UI.IDS.COUNT}" class="${UI.CLASSES.COUNT}">${escapeHtml(this.countText)}</div>
      </div>
    `;

    const controlsOuter = document.createElement("div");
    controlsOuter.id = UI.IDS.CONTROLS;
    controlsOuter.className = `${UI.CLASSES.RESET} ${UI.CLASSES.FLOATING}`;
    controlsOuter.style.pointerEvents = "auto";

    controlsOuter.innerHTML = `
      <div class="${UI.CLASSES.CONTROLS_ROW}">
        <button
          id="${UI.IDS.CONFIRM}"
          type="button"
          class="${UI.CLASSES.BUTTON} ${UI.CLASSES.CONFIRM}"
        >${escapeHtml(this.confirmText)}</button>

        <button
          id="${UI.IDS.CANCEL}"
          type="button"
          class="${UI.CLASSES.BUTTON} ${UI.CLASSES.CANCEL}"
        >${escapeHtml(this.cancelText)}</button>
      </div>
    `;

    document.body.appendChild(topOuter);
    document.body.appendChild(controlsOuter);

    this.dom.topOuter = topOuter;
    this.dom.topInner = topOuter.querySelector(`.${UI.CLASSES.TOP_INNER}`);
    this.dom.title = topOuter.querySelector(`#${UI.IDS.TITLE}`);
    this.dom.count = topOuter.querySelector(`#${UI.IDS.COUNT}`);

    this.dom.controlsOuter = controlsOuter;
    this.dom.controlsRow = controlsOuter.querySelector(`.${UI.CLASSES.CONTROLS_ROW}`);
    this.dom.confirm = controlsOuter.querySelector(`#${UI.IDS.CONFIRM}`);
    this.dom.cancel = controlsOuter.querySelector(`#${UI.IDS.CANCEL}`);

    this.bindButtons();
    this.applyLayout();

    this.state.created = true;
    registerUIInstance(this);

    dbg.logRun(this.runId, "CREATE END", {
      titleText: this.titleText,
      countText: this.countText
    });

    return this;
  }

  bindButtons() {
    if (!this.dom.confirm || !this.dom.cancel) return;

    this.listeners.confirm = async (event) => {
      swallowEvent(event, "CONFIRM BUTTON", this.runId);

      dbg.logRun(this.runId, "CONFIRM CLICKED");

      if (typeof this.callbacks.onConfirm === "function") {
        try {
          await this.callbacks.onConfirm({
            instance: this,
            sessionId: this.sessionId,
            userId: this.userId,
            event
          });
        } catch (err) {
          dbg.errorRun(this.runId, "CONFIRM CALLBACK FAILED", err);
        }
      }
    };

    this.listeners.cancel = async (event) => {
      swallowEvent(event, "CANCEL BUTTON", this.runId);

      dbg.logRun(this.runId, "CANCEL CLICKED");

      if (typeof this.callbacks.onCancel === "function") {
        try {
          await this.callbacks.onCancel({
            instance: this,
            sessionId: this.sessionId,
            userId: this.userId,
            event
          });
        } catch (err) {
          dbg.errorRun(this.runId, "CANCEL CALLBACK FAILED", err);
        }
      }
    };

    this.dom.confirm.addEventListener("click", this.listeners.confirm, true);
    this.dom.cancel.addEventListener("click", this.listeners.cancel, true);

    dbg.logRun(this.runId, "BUTTONS BOUND");
  }

  unbindButtons() {
    if (this.dom.confirm && this.listeners.confirm) {
      this.dom.confirm.removeEventListener("click", this.listeners.confirm, true);
    }

    if (this.dom.cancel && this.listeners.cancel) {
      this.dom.cancel.removeEventListener("click", this.listeners.cancel, true);
    }

    this.listeners.confirm = null;
    this.listeners.cancel = null;

    dbg.logRun(this.runId, "BUTTONS UNBOUND");
  }

  /* ---------------------------------------- */
  /* Public callbacks                         */
  /* ---------------------------------------- */

  setConfirmHandler(fn) {
    this.callbacks.onConfirm = typeof fn === "function" ? fn : null;
    dbg.logRun(this.runId, "SET CONFIRM HANDLER", {
      hasHandler: Boolean(this.callbacks.onConfirm)
    });
    return this;
  }

  setCancelHandler(fn) {
    this.callbacks.onCancel = typeof fn === "function" ? fn : null;
    dbg.logRun(this.runId, "SET CANCEL HANDLER", {
      hasHandler: Boolean(this.callbacks.onCancel)
    });
    return this;
  }

  /* ---------------------------------------- */
  /* Layout / content                         */
  /* ---------------------------------------- */

  applyLayout(partialSettings = {}) {
    this.settings = mergeSettings(this.settings, partialSettings || {});

    const s = this.settings;
    const topY = clampMin(s.topY, 0, UI.TUNING.topY);
    const topWidth = clampMin(s.topWidth, 1, UI.TUNING.topWidth);
    const topScale = clampMin(s.topScale, 0.05, UI.TUNING.topScale);
    const controlsScale = clampMin(s.controlsScale, 0.05, UI.TUNING.controlsScale);
    const controlsGap = clampMin(s.controlsGap, 0, UI.TUNING.controlsGap);
    const zIndexTop = clampMin(s.zIndexTop, 1, UI.TUNING.zIndexTop);
    const zIndexControls = clampMin(s.zIndexControls, 1, UI.TUNING.zIndexControls);

    if (this.dom.topOuter) {
      this.dom.topOuter.style.top = `${topY}px`;
      this.dom.topOuter.style.zIndex = String(zIndexTop);

      const topX = toFiniteNumber(s.topX, null);
      if (topX === null) {
        this.dom.topOuter.style.left = "50%";
        this.dom.topOuter.style.right = "auto";
        this.dom.topOuter.style.transform = "translateX(-50%)";
      } else {
        this.dom.topOuter.style.left = `${topX}px`;
        this.dom.topOuter.style.right = "auto";
        this.dom.topOuter.style.transform = "none";
      }
    }

    if (this.dom.topInner) {
      this.dom.topInner.style.minWidth = `${topWidth}px`;
      this.dom.topInner.style.transform = `translateY(0px) scale(${topScale})`;
    }

    if (this.dom.controlsOuter) {
      this.dom.controlsOuter.style.zIndex = String(zIndexControls);

      const controlsX = toFiniteNumber(s.controlsX, null);
      const controlsY = toFiniteNumber(s.controlsY, null);

      if (controlsX === null) {
        this.dom.controlsOuter.style.left = "auto";
        this.dom.controlsOuter.style.right = "20px";
      } else {
        this.dom.controlsOuter.style.left = `${controlsX}px`;
        this.dom.controlsOuter.style.right = "auto";
      }

      if (controlsY === null) {
        this.dom.controlsOuter.style.top = "auto";
        this.dom.controlsOuter.style.bottom = "20px";
      } else {
        this.dom.controlsOuter.style.top = `${controlsY}px`;
        this.dom.controlsOuter.style.bottom = "auto";
      }
    }

    if (this.dom.controlsRow) {
      this.dom.controlsRow.style.gap = `${controlsGap}px`;
      this.dom.controlsRow.style.transform = `translateY(0px) scale(${controlsScale})`;
    }

    dbg.logRun(this.runId, "APPLY LAYOUT", {
      settings: this.settings
    });

    if (this.state.idleRunning) {
      this.restartIdle();
    }

    return this;
  }

  updateTitle(titleText = UI.TEXT.DEFAULT_TITLE) {
    this.titleText = String(titleText ?? UI.TEXT.DEFAULT_TITLE);
    if (this.dom.title) {
      this.dom.title.textContent = this.titleText;
    }

    dbg.logRun(this.runId, "UPDATE TITLE", {
      titleText: this.titleText
    });

    return this;
  }

  updateCountText(countText = UI.TEXT.DEFAULT_COUNT_ZERO) {
    this.countText = String(countText ?? UI.TEXT.DEFAULT_COUNT_ZERO);
    if (this.dom.count) {
      this.dom.count.textContent = this.countText;
    }

    dbg.logRun(this.runId, "UPDATE COUNT TEXT", {
      countText: this.countText
    });

    return this;
  }

  updateCount(count = 0) {
    return this.updateCountText(formatCountText(count));
  }

  setConfirmEnabled(enabled = true) {
    if (this.dom.confirm) {
      this.dom.confirm.disabled = !enabled;
    }

    dbg.logRun(this.runId, "SET CONFIRM ENABLED", { enabled: Boolean(enabled) });
    return this;
  }

  setCancelEnabled(enabled = true) {
    if (this.dom.cancel) {
      this.dom.cancel.disabled = !enabled;
    }

    dbg.logRun(this.runId, "SET CANCEL ENABLED", { enabled: Boolean(enabled) });
    return this;
  }

  setButtonsEnabled({ confirm = true, cancel = true } = {}) {
    this.setConfirmEnabled(confirm);
    this.setCancelEnabled(cancel);
    return this;
  }

  setButtonLabels({ confirmText, cancelText } = {}) {
    if (typeof confirmText === "string") {
      this.confirmText = confirmText;
      if (this.dom.confirm) this.dom.confirm.textContent = this.confirmText;
    }

    if (typeof cancelText === "string") {
      this.cancelText = cancelText;
      if (this.dom.cancel) this.dom.cancel.textContent = this.cancelText;
    }

    dbg.logRun(this.runId, "SET BUTTON LABELS", {
      confirmText: this.confirmText,
      cancelText: this.cancelText
    });

    return this;
  }

  /* ---------------------------------------- */
  /* Animation                                */
  /* ---------------------------------------- */

  stopIdle() {
    this.animations.topIdle?.cancel?.();
    this.animations.controlsIdle?.cancel?.();
    this.animations.topIdle = null;
    this.animations.controlsIdle = null;
    this.state.idleRunning = false;

    const topScale = clampMin(this.settings.topScale, 0.05, UI.TUNING.topScale);
    const controlsScale = clampMin(this.settings.controlsScale, 0.05, UI.TUNING.controlsScale);

    if (this.dom.topInner) {
      this.dom.topInner.style.transform = `translateY(0px) scale(${topScale})`;
    }

    if (this.dom.controlsRow) {
      this.dom.controlsRow.style.transform = `translateY(0px) scale(${controlsScale})`;
    }

    dbg.logRun(this.runId, "IDLE STOPPED");
    return this;
  }

  startIdle() {
    this.stopIdle();

    const idleEnabled = Boolean(this.settings.idleEnabled);
    if (!idleEnabled || !this.state.visible) {
      dbg.logRun(this.runId, "IDLE SKIPPED", {
        idleEnabled,
        visible: this.state.visible
      });
      return this;
    }

    const idlePx = clampMin(this.settings.idlePx, 0, UI.TUNING.idlePx);
    const idleMs = clampMin(this.settings.idleMs, 50, UI.TUNING.idleMs);
    const topScale = clampMin(this.settings.topScale, 0.05, UI.TUNING.topScale);
    const controlsScale = clampMin(this.settings.controlsScale, 0.05, UI.TUNING.controlsScale);

    if (this.dom.topInner) {
      this.animations.topIdle = this.dom.topInner.animate(
        [
          { transform: `translateY(0px) scale(${topScale})` },
          { transform: `translateY(${-idlePx}px) scale(${topScale})` },
          { transform: `translateY(0px) scale(${topScale})` }
        ],
        {
          duration: idleMs,
          iterations: Infinity,
          easing: "ease-in-out"
        }
      );
    }

    if (this.dom.controlsRow) {
      this.animations.controlsIdle = this.dom.controlsRow.animate(
        [
          { transform: `translateY(0px) scale(${controlsScale})` },
          { transform: `translateY(${idlePx}px) scale(${controlsScale})` },
          { transform: `translateY(0px) scale(${controlsScale})` }
        ],
        {
          duration: idleMs,
          iterations: Infinity,
          easing: "ease-in-out"
        }
      );
    }

    this.state.idleRunning = true;
    dbg.logRun(this.runId, "IDLE STARTED", {
      idlePx,
      idleMs
    });

    return this;
  }

  restartIdle() {
    this.stopIdle();
    this.startIdle();
    return this;
  }

  async animateIn() {
    const spawnMs = clampMin(this.settings.spawnMs, 0, UI.TUNING.spawnMs);
    const topScale = clampMin(this.settings.topScale, 0.05, UI.TUNING.topScale);
    const controlsScale = clampMin(this.settings.controlsScale, 0.05, UI.TUNING.controlsScale);

    const anims = [];

    if (this.dom.topInner) {
      this.dom.topOuter.style.opacity = "1";
      anims.push(
        this.dom.topInner.animate(
          [
            { opacity: 0, transform: `translateY(-12px) scale(${topScale * 0.96})` },
            { opacity: 1, transform: `translateY(0px) scale(${topScale})` }
          ],
          {
            duration: spawnMs,
            easing: "ease-out",
            fill: "forwards"
          }
        ).finished.catch(() => {})
      );
    }

    if (this.dom.controlsRow) {
      this.dom.controlsOuter.style.opacity = "1";
      anims.push(
        this.dom.controlsRow.animate(
          [
            { opacity: 0, transform: `translateY(12px) scale(${controlsScale * 0.96})` },
            { opacity: 1, transform: `translateY(0px) scale(${controlsScale})` }
          ],
          {
            duration: spawnMs,
            easing: "ease-out",
            fill: "forwards"
          }
        ).finished.catch(() => {})
      );
    }

    await Promise.all(anims);

    dbg.logRun(this.runId, "ANIMATE IN DONE", { spawnMs });
    return this;
  }

  async animateOut() {
    const despawnMs = clampMin(this.settings.despawnMs, 0, UI.TUNING.despawnMs);
    const topScale = clampMin(this.settings.topScale, 0.05, UI.TUNING.topScale);
    const controlsScale = clampMin(this.settings.controlsScale, 0.05, UI.TUNING.controlsScale);

    const anims = [];

    if (this.dom.topInner) {
      anims.push(
        this.dom.topInner.animate(
          [
            { opacity: 1, transform: `translateY(0px) scale(${topScale})` },
            { opacity: 0, transform: `translateY(-8px) scale(${topScale * 0.96})` }
          ],
          {
            duration: despawnMs,
            easing: "ease-in",
            fill: "forwards"
          }
        ).finished.catch(() => {})
      );
    }

    if (this.dom.controlsRow) {
      anims.push(
        this.dom.controlsRow.animate(
          [
            { opacity: 1, transform: `translateY(0px) scale(${controlsScale})` },
            { opacity: 0, transform: `translateY(8px) scale(${controlsScale * 0.96})` }
          ],
          {
            duration: despawnMs,
            easing: "ease-in",
            fill: "forwards"
          }
        ).finished.catch(() => {})
      );
    }

    await Promise.all(anims);

    dbg.logRun(this.runId, "ANIMATE OUT DONE", { despawnMs });
    return this;
  }

  /* ---------------------------------------- */
  /* Visibility / lifecycle                    */
  /* ---------------------------------------- */

  async show({ animate = true } = {}) {
    if (this.state.destroyed) return this;
    if (!this.state.created) this.create();

    if (this.dom.topOuter) this.dom.topOuter.style.display = "";
    if (this.dom.controlsOuter) this.dom.controlsOuter.style.display = "";

    this.state.visible = true;

    if (animate) {
      await this.animateIn();
    }

    this.startIdle();

    dbg.logRun(this.runId, "SHOW", { animate });
    return this;
  }

  async hide({ animate = true } = {}) {
    if (!this.state.created || this.state.destroyed) return this;

    this.stopIdle();

    if (animate) {
      await this.animateOut();
    }

    if (this.dom.topOuter) this.dom.topOuter.style.display = "none";
    if (this.dom.controlsOuter) this.dom.controlsOuter.style.display = "none";

    this.state.visible = false;

    dbg.logRun(this.runId, "HIDE", { animate });
    return this;
  }

  async destroy({ animate = true } = {}) {
    if (this.state.destroyed) return;

    dbg.logRun(this.runId, "DESTROY START", { animate });

    try {
      if (this.state.visible) {
        await this.hide({ animate });
      } else {
        this.stopIdle();
      }

      this.unbindButtons();

      this.dom.topOuter?.remove?.();
      this.dom.controlsOuter?.remove?.();

      this.dom.topOuter = null;
      this.dom.topInner = null;
      this.dom.title = null;
      this.dom.count = null;
      this.dom.controlsOuter = null;
      this.dom.controlsRow = null;
      this.dom.confirm = null;
      this.dom.cancel = null;

      this.state.visible = false;
      this.state.created = false;
      this.state.destroyed = true;

      unregisterUIInstance(this);
    } catch (err) {
      dbg.errorRun(this.runId, "DESTROY FAILED", err);
    }

    dbg.logRun(this.runId, "DESTROY END", {
      instanceId: this.instanceId
    });
  }
}

/* -------------------------------------------- */
/* Factory / registry helpers                   */
/* -------------------------------------------- */

export function createJRPGTargetingUI(options = {}) {
  const ui = new JRPGTargetingUI(options);
  ui.create();
  return ui;
}

export function getActiveJRPGTargetingUI() {
  return ensureUIRegistry().active ?? null;
}

export async function destroyActiveJRPGTargetingUI({ animate = true } = {}) {
  const active = getActiveJRPGTargetingUI();
  if (!active) return null;
  await active.destroy({ animate });
  return null;
}

export function getJRPGTargetingUIRegistrySnapshot() {
  const registry = ensureUIRegistry();

  return {
    activeInstanceId: registry.active?.instanceId ?? null,
    instanceIds: Object.keys(registry.instances ?? {})
  };
}

export default {
  JRPGTargetingUI,
  createJRPGTargetingUI,
  getActiveJRPGTargetingUI,
  destroyActiveJRPGTargetingUI,
  getJRPGTargetingUIRegistrySnapshot
};
