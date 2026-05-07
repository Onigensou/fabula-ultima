/**
 * [CheckRoller] ButtonInstall — Foundry VTT v12
 * -----------------------------------------------------------------------------
 * Purpose:
 * - Installs a small floating button on the client UI for the Check Roller.
 * - Player clicks -> calls ONI.CheckRoller.openDialog() (later will open dialog).
 *
 * Design goals:
 * - Collision-safe DOM ids/classes (prefixed).
 * - Idempotent: rerunning the script updates/refreshes the button (no duplicates).
 * - Player-first: optional GM guard (default: show for players, hide for GM).
 *
 * Requirements:
 * - [CheckRoller] Manager must be loaded first (ONI.CheckRoller exists).
 */

Hooks.once("ready", () => {
  (() => {
    const TAG = "[ONI][CheckRoller:ButtonInstall]";
  const MANAGER = globalThis.ONI?.CheckRoller;

  if (!MANAGER || !MANAGER.__isCheckRollerManager) {
    ui?.notifications?.error("Check Roller: Manager not found. Run [CheckRoller] Manager first.");
    console.error(`${TAG} Manager not found at ONI.CheckRoller`);
    return;
  }

  // ---------------------------------------------------------------------------
  // CONFIG (safe defaults)
  // ---------------------------------------------------------------------------
  const CFG = {
    // Show button for GM clients?
    // Recommended: false (GM usually uses tokens / different flow)
    showForGM: true,

    // Position
    // bottom-right default; tuned so it doesn't overlap Foundry's default UI too much.
    offsetRightPx: 313,
    offsetBottomPx: 38,

    // Visual
    sizePx: 60,
    zIndex: 80, // above most UI, below popups
    iconText: "🎲", // replace later with your own icon if desired
    label: "Check Roller",

    // Behavior
    clickSound: null, // set to a sound path later if you want
  };

  // ---------------------------------------------------------------------------
  // Id / class naming (collision safe)
  // ---------------------------------------------------------------------------
  const DOM = {
    ROOT_ID: "oni-cr-button-root",
    BTN_ID: "oni-cr-button",
    STYLE_ID: "oni-cr-button-style",
  };

  // ---------------------------------------------------------------------------
  // Guards
  // ---------------------------------------------------------------------------
  if (!CFG.showForGM && game.user.isGM) {
    // Clean up if previously installed
    document.getElementById(DOM.ROOT_ID)?.remove();
    document.getElementById(DOM.STYLE_ID)?.remove();
    console.log(`${TAG} GM client detected (showForGM=false). Button removed/disabled.`);
    return;
  }

  // ---------------------------------------------------------------------------
  // Install CSS (idempotent)
  // ---------------------------------------------------------------------------
  const ensureStyle = () => {
    let style = document.getElementById(DOM.STYLE_ID);
    if (style) return style;

    style = document.createElement("style");
    style.id = DOM.STYLE_ID;
    style.textContent = `
      /* [CheckRoller] Floating Button */
      #${DOM.ROOT_ID} {
        position: fixed;
        right: ${CFG.offsetRightPx}px;
        bottom: ${CFG.offsetBottomPx}px;
        z-index: ${CFG.zIndex};
        pointer-events: none; /* allow only button to receive clicks */
      }

      #${DOM.BTN_ID} {
        pointer-events: auto;
        width: ${CFG.sizePx}px;
        height: ${CFG.sizePx}px;
        border-radius: 999px;
        border: 1px solid rgba(255,255,255,0.22);
        background: rgba(18, 18, 22, 0.86);
        box-shadow:
          0 10px 24px rgba(0,0,0,0.35),
          0 2px 0 rgba(255,255,255,0.06) inset;
        display: grid;
        place-items: center;
        cursor: pointer;
        user-select: none;
        -webkit-user-select: none;
        transform: translateZ(0);
        transition: transform 120ms ease, background 120ms ease, border-color 120ms ease;
      }

      #${DOM.BTN_ID}:hover {
        transform: translateY(-1px) scale(1.02);
        background: rgba(28, 28, 34, 0.92);
        border-color: rgba(255,255,255,0.32);
      }

      #${DOM.BTN_ID}:active {
        transform: translateY(0px) scale(0.99);
      }

      #${DOM.BTN_ID} .oni-cr-icon {
        font-size: 22px;
        line-height: 1;
        filter: drop-shadow(0 2px 2px rgba(0,0,0,0.45));
      }

      #${DOM.BTN_ID} .oni-cr-tip {
        position: absolute;
        right: 0;
        bottom: calc(100% + 10px);
        background: rgba(10,10,12,0.92);
        border: 1px solid rgba(255,255,255,0.18);
        border-radius: 10px;
        padding: 8px 10px;
        font-size: 12px;
        color: rgba(255,255,255,0.9);
        white-space: nowrap;
        opacity: 0;
        transform: translateY(4px);
        transition: opacity 120ms ease, transform 120ms ease;
        pointer-events: none;
        box-shadow: 0 10px 24px rgba(0,0,0,0.35);
      }

      #${DOM.BTN_ID}:hover .oni-cr-tip {
        opacity: 1;
        transform: translateY(0);
      }

      #${DOM.BTN_ID}[data-disabled="1"] {
        opacity: 0.55;
        cursor: not-allowed;
        filter: grayscale(0.2);
      }

      #${DOM.BTN_ID}[data-disabled="1"]:hover {
        transform: none;
        background: rgba(18, 18, 22, 0.86);
        border-color: rgba(255,255,255,0.22);
      }
    `;
    document.head.appendChild(style);
    return style;
  };

  // ---------------------------------------------------------------------------
  // Install DOM (idempotent)
  // ---------------------------------------------------------------------------
  const ensureRoot = () => {
    let root = document.getElementById(DOM.ROOT_ID);
    if (!root) {
      root = document.createElement("div");
      root.id = DOM.ROOT_ID;
      document.body.appendChild(root);
    }
    return root;
  };

  const buildButton = () => {
    const root = ensureRoot();
    root.innerHTML = "";

    const btn = document.createElement("div");
    btn.id = DOM.BTN_ID;
    btn.setAttribute("role", "button");
    btn.setAttribute("tabindex", "0");
    btn.setAttribute("aria-label", CFG.label);

    btn.innerHTML = `
      <div class="oni-cr-tip">${CFG.label}</div>
      <div class="oni-cr-icon">${CFG.iconText}</div>
    `;

    // Click handler
    const onClick = async (ev) => {
      ev?.preventDefault?.();
      ev?.stopPropagation?.();

      // If manager is currently running, soft block (Manager also hard-blocks)
      if (MANAGER.isRunning()) {
        ui?.notifications?.warn("Check Roller is already running. Finish the current check first.");
        return;
      }

      // Optional click sound
      if (CFG.clickSound) {
        try { AudioHelper.play({ src: CFG.clickSound, volume: 0.6, autoplay: true, loop: false }, true); } catch (_) {}
      }

      try {
        // Prefer Manager flow
        const payload = await MANAGER.openDialog();

        // If Dialog returns a payload and wants manager to run:
        // We'll run it here (Dialog can also call MANAGER.run itself later if you prefer).
        if (payload) {
          await MANAGER.run(payload);
        }
      } catch (e) {
        console.error(`${TAG} Button click error:`, e);
        ui?.notifications?.error("Check Roller: An error occurred. Check console.");
      }
    };

    // Keyboard support: Enter/Space
    const onKeyDown = (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        onClick(ev);
      }
    };

    btn.addEventListener("click", onClick);
    btn.addEventListener("keydown", onKeyDown);

    root.appendChild(btn);
    return btn;
  };

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  ensureStyle();
  const btn = buildButton();

  console.log(`${TAG} Installed`, {
    user: game.user?.name,
    showForGM: CFG.showForGM,
    right: CFG.offsetRightPx,
    bottom: CFG.offsetBottomPx
  });
  })();
});
