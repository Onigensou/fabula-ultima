/**
 * [CheckRoller] CardHydrate — Foundry VTT v12 (UPDATED for new UI)
 * -----------------------------------------------------------------------------
 * What it does:
 * - Removes speaker header line for a clean JRPG-style card
 * - Forces overflow visible so portrait / DL badge can stick outside the panel
 * - Binds drawer expand/collapse (click shell)
 * - Enables tooltips (global tooltip host: .fu-tip-host)
 * - Animates BIG Total number roll-up + plays dice SFX (fast)
 * - Shows Invoke buttons only to GM + the roller, and disables used invokes
 *
 * Install order:
 * 1) [CheckRoller] Manager
 * 2) [CheckRoller] CreateCard
 * 3) [CheckRoller] CardHydrate
 */

(() => {
  const TAG = "[ONI][CheckRoller:CardHydrate]";
  const MANAGER = globalThis.ONI?.CheckRoller;

  if (!MANAGER || !MANAGER.__isCheckRollerManager) {
    ui?.notifications?.error("Check Roller: Manager not found. Run [CheckRoller] Manager first.");
    console.error(`${TAG} Manager not found at ONI.CheckRoller`);
    return;
  }

    const { CONST } = MANAGER;

  // ---------------------------------------------------------------------------
  // IMPORTANT (Multi-client parity)
  // - CSS is injected by CreateCard into each client's <head>.
  // - Ensure it's present even if this client didn't create the message.
  // ---------------------------------------------------------------------------
  try { MANAGER.__ensureCheckRollerCardStyle?.(); } catch (_) {}

  const safeStr = (v, fb = "") => (typeof v === "string" ? v : (v == null ? fb : String(v)));
  const safeInt = (v, fb = 0) => {
    const n = typeof v === "number" ? v : parseInt(String(v ?? "").replace(/[^\d-]/g, ""), 10);
    return Number.isFinite(n) ? n : fb;
  };

  // ----------------------------------------------------------------------------
  // Read payload off message flags (supports legacy scope too)
  // ----------------------------------------------------------------------------
  const getPayload = (message) => {
    const read = (scope) => {
      try {
        if (message?.getFlag) return message.getFlag(scope, CONST.FLAG_KEY_CARD) || null;
      } catch (_) {}
      try {
        const flags = message?.flags || message?.data?.flags || message?.message?.flags || null;
        return flags?.[scope]?.[CONST.FLAG_KEY_CARD] ?? null;
      } catch (_) {}
      return null;
    };

    return read(CONST.FLAG_SCOPE) || read(CONST.LEGACY_FLAG_SCOPE) || null;
  };

  const canSeeInvoke = (payload) => {
    if (game.user.isGM) return true;
    const rollerId = safeStr(payload?.meta?.userId, "");
    return rollerId && rollerId === game.user.id;
  };

  const applyInvokeState = (rootEl, payload) => {
    const invoked = payload?.meta?.invoked || {};
    const traitUsed = Boolean(invoked.trait);
    const bondUsed = Boolean(invoked.bond);

    const fumbleLocked = !!(
      payload?.result?.isFumble === true ||
      payload?.meta?.invokeLockedByFumble === true
    );

    const invokeHost =
      rootEl.querySelector(".oni-cr-invoke") ||
      rootEl.querySelector(".oni-cr-buttons");

    if (!invokeHost) return;

    const traitBtn = invokeHost.querySelector("[data-oni-cr-trait]");
    const bondBtn = invokeHost.querySelector("[data-oni-cr-bond]");

    const renderLocked = (btn, label, title) => {
      if (!btn) return;

      // Important:
      // Do NOT set disabled=true here.
      // Disabled buttons do not reliably fire click events, so the player would not get a warning.
      btn.disabled = false;
      btn.setAttribute("data-disabled", "0");
      btn.setAttribute("data-oni-cr-invoke-locked", "fumble");
      btn.setAttribute("aria-disabled", "true");
      btn.title = title;

      btn.classList.add("oni-cr-btn-locked");
      btn.style.opacity = "";
      btn.style.cursor = "not-allowed";

      btn.innerHTML = `
        <span class="oni-cr-btn-label">${label}</span>
        <span class="oni-cr-lock-overlay" aria-hidden="true"><i class="fa-solid fa-lock"></i></span>
      `;
    };

    const renderNormal = (btn, label, used) => {
      if (!btn) return;

      btn.classList.remove("oni-cr-btn-locked");
      btn.removeAttribute("data-oni-cr-invoke-locked");
      btn.setAttribute("aria-disabled", used ? "true" : "false");

      btn.disabled = used;
      btn.setAttribute("data-disabled", used ? "1" : "0");
      btn.textContent = used ? `${label} (Used)` : label;
      btn.style.opacity = used ? "0.55" : "";
      btn.style.cursor = used ? "not-allowed" : "";
    };

    if (fumbleLocked) {
      renderLocked(traitBtn, "🎭 Invoke Trait", "Locked: Invoke Trait cannot be used on a Fumble.");
      renderLocked(bondBtn, "🤝 Invoke Bond", "Locked: Invoke Bond cannot be used on a Fumble.");
      return;
    }

    renderNormal(traitBtn, "🎭 Invoke Trait", traitUsed);
    renderNormal(bondBtn, "🤝 Invoke Bond", bondUsed);
  };

  // ----------------------------------------------------------------------------
  // Global tooltip binder (hover) — mirrors UI TESTER
  // ----------------------------------------------------------------------------
  const ensureGlobalTooltip = () => {
    if (window.__fuGlobalTipBound) return;
    window.__fuGlobalTipBound = true;

    const TT_ID = "fu-global-tooltip";
    let tipEl = document.getElementById(TT_ID);
    if (!tipEl) {
      tipEl = document.createElement("div");
      tipEl.id = TT_ID;
      Object.assign(tipEl.style, {
        position: "fixed",
        zIndex: "2147483647",
        display: "none",
        background: "rgba(0,0,0,.90)",
        color: "#fff",
        padding: ".45rem .6rem",
        borderRadius: "6px",
        fontSize: "12px",
        maxWidth: "360px",
        pointerEvents: "none",
        boxShadow: "0 2px 8px rgba(0,0,0,.4)",
        border: "1px solid rgba(255,255,255,.15)",
        textAlign: "left",
        whiteSpace: "pre-wrap"
      });
      document.body.appendChild(tipEl);
    }

    const TIP_MARGIN = 10;
    const CURSOR_GAP = 12;

    const placeTipAt = (x, y) => {
      const vw = innerWidth, vh = innerHeight;
      const r = tipEl.getBoundingClientRect();
      let tx = x + CURSOR_GAP;
      let ty = y + CURSOR_GAP;
      if (tx + r.width + TIP_MARGIN > vw) tx = x - r.width - CURSOR_GAP;
      if (tx < TIP_MARGIN) tx = TIP_MARGIN;
      if (ty + r.height + TIP_MARGIN > vh) ty = y - r.height - CURSOR_GAP;
      if (ty < TIP_MARGIN) ty = TIP_MARGIN;
      tipEl.style.left = `${tx}px`;
      tipEl.style.top = `${ty}px`;
    };

    const showTip = (html, x, y) => {
      tipEl.style.visibility = "hidden";
      tipEl.style.display = "block";
      tipEl.innerHTML = html;
      placeTipAt(x, y);
      tipEl.style.visibility = "visible";
    };

    const hideTip = () => { tipEl.style.display = "none"; };

    document.addEventListener("mouseover", (ev) => {
      const host = ev.target.closest?.(".fu-tip-host");
      if (!host) return;

      const html = decodeURIComponent(host.getAttribute("data-tip") || "");
      if (!html) return;

      showTip(html, ev.clientX, ev.clientY);

      const mouseMoveFollower = (e) => placeTipAt(e.clientX, e.clientY);
      document.addEventListener("mousemove", mouseMoveFollower);

      host.addEventListener("mouseout", function onOut() {
        hideTip();
        document.removeEventListener("mousemove", mouseMoveFollower);
        host.removeEventListener("mouseout", onOut);
      }, { once: true });
    });
  };

  // ----------------------------------------------------------------------------
  // Roll-up animation + SFX (BIG Total only) — mirrors UI TESTER
  // ----------------------------------------------------------------------------
  const runTotalRollUp = (rootEl, payload) => {
    try {
      const rollEl = rootEl.querySelector(".oni-cr-rollnum");
      if (!rollEl) return;
      if (rollEl.__oniRolled) return;
      rollEl.__oniRolled = true;

            const tuning = payload?.meta?.ui?.tuning || {};
      const sfxEnabled = (typeof tuning.rollSfxEnabled === "boolean") ? tuning.rollSfxEnabled : true;

      const isFumble = Boolean(payload?.result?.isFumble);
      const isCrit = (!isFumble && Boolean(payload?.result?.isCrit)); // fumble always wins

      const defaultCrit = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Flash2.ogg";
      const defaultFumble = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/ME/Shock2.ogg";

      const critUrl = safeStr(tuning.critSfxUrl, defaultCrit);
      const fumbleUrl = safeStr(tuning.fumbleSfxUrl, defaultFumble);

      let sfxUrl = safeStr(tuning.rollSfxUrl, "");
      if (isFumble && fumbleUrl) sfxUrl = fumbleUrl;
      else if (isCrit && critUrl) sfxUrl = critUrl;

      const sfxVol = Math.max(0, Math.min(1, Number(tuning.rollSfxVolume ?? 0.8)));

      if (sfxEnabled && !rollEl.__oniSfxPlayed) {
        rollEl.__oniSfxPlayed = true;
        try {
          if (sfxUrl) {
            AudioHelper.play(
              { src: sfxUrl, volume: sfxVol, loop: false },
              true
            );
          }
        } catch (err) {
          console.warn(`${TAG} rollSfx failed:`, err);
        }
      }

      const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
      const final = Number(rollEl.dataset.final || "0");
      const durRaw = Number(rollEl.dataset.rollms || "360");
      const dur = Math.max(220, Math.min(650, durRaw));

      const fmt = (n) => n.toLocaleString?.() ?? String(n);
      const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

      if (reduceMotion || !Number.isFinite(final) || final <= 0) {
        rollEl.textContent = fmt(Number.isFinite(final) ? final : 0);
      } else {
        const startVal = 1;
        const t0 = performance.now();

        const frame = (now) => {
          const p = Math.min(1, (now - t0) / dur);
          const v = Math.max(
            startVal,
            Math.floor(startVal + (final - startVal) * easeOutCubic(p))
          );
          rollEl.textContent = fmt(v);

          if (p < 1) requestAnimationFrame(frame);
          else rollEl.textContent = fmt(final);
        };

        requestAnimationFrame(frame);
      }
    } catch (e) {
      console.warn(`${TAG} Total roll-up skipped:`, e);
    }
  };

  // ----------------------------------------------------------------------------
  // Drawer toggle binding (mirrors UI TESTER)
  // ----------------------------------------------------------------------------
  const bindDrawer = (rootEl) => {
    const shell = rootEl.querySelector(".oni-cr-shell");
    const details = rootEl.querySelector(".oni-cr-details");
    if (!shell || !details) return;

    const setOpen = (open) => {
      shell.dataset.open = open ? "true" : "false";
      if (open) {
        details.style.paddingTop = ".45rem";
        details.style.paddingBottom = ".45rem";

        requestAnimationFrame(() => {
          const buffer = 24;
          details.style.maxHeight = (details.scrollHeight + buffer) + "px";
        });
      } else {
        details.style.maxHeight = "0px";
        details.style.paddingTop = "0";
        details.style.paddingBottom = "0";
      }
    };

    setOpen(false);

    if (shell.__oniDrawerBound) return;
    shell.__oniDrawerBound = true;

    rootEl.addEventListener("click", (ev) => {
      const inShell = ev.target.closest?.(".oni-cr-shell");
      if (!inShell) return;
      if (ev.target.closest("a, button, input, select, textarea")) return;
      setOpen(shell.dataset.open !== "true");
    });
  };

  // ----------------------------------------------------------------------------
  // Idempotent hook install guard
  // ----------------------------------------------------------------------------
  if (globalThis.ONI.__CheckRollerHydrateHookInstalled) {
    console.log(`${TAG} Hook already installed. (Re-run ignored)`);
    ui?.notifications?.info("Check Roller Hydrate already installed.");
    return;
  }

  Hooks.on("renderChatMessage", (message, html) => {
    try {
           const payload = getPayload(message);
      if (!payload || payload.kind !== "fu_check") return;

      // Make sure the card CSS exists on this client before we touch layout.
      try { MANAGER.__ensureCheckRollerCardStyle?.(); } catch (_) {}

      ensureGlobalTooltip();

      const root = (html instanceof jQuery) ? html[0] : html;
      if (!root) return;

      const card = root.querySelector(".oni-cr-card");
      if (!card) return;

      const header = root.querySelector(".message-header");
      if (header) header.remove();

      root.style.overflow = "visible";
      const mc = root.querySelector(".message-content");
      if (mc) {
        mc.style.overflow = "visible";
        mc.style.position = "relative";
        mc.style.paddingTop = "0";
        mc.style.marginTop = "0";
      }

      const invokeHost =
        root.querySelector(".oni-cr-invoke") ||
        root.querySelector(".oni-cr-buttons");

      if (invokeHost) {
        if (canSeeInvoke(payload)) {
          invokeHost.style.display = "grid";
          applyInvokeState(root, payload);
        } else {
          invokeHost.style.display = "none";
        }
      }

      bindDrawer(root);
      runTotalRollUp(root, payload);

      card.setAttribute("data-oni-cr", "1");
      card.setAttribute("data-oni-cr-msgid", message.id);

      console.log(`${TAG} Hydrated`, {
        messageId: message.id,
        user: game.user.name,
        canSeeInvoke: canSeeInvoke(payload)
      });
    } catch (e) {
      console.warn(`${TAG} Hydrate error`, e);
    }
  });

  globalThis.ONI.__CheckRollerHydrateHookInstalled = true;
  console.log(`${TAG} Installed (renderChatMessage hook).`);
})();
