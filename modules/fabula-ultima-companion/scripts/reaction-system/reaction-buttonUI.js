/**
 * [ONI] Reaction System — Module Version (Foundry VTT v12)
 * ---------------------------------------------------------------------------
 * This file is safe to load automatically from a module (runs once per client).
 * Updated for merged same-token reaction windows.
 * ---------------------------------------------------------------------------
 */
// ============================================================================
// ONI ReactionButtonUI – Floating "Reaction" blade next to tokens (Foundry v12)
// ---------------------------------------------------------------------------
// PURPOSE
// -------
// This script ONLY handles the small floating "Reaction" button UI:
//
//   • Creates the #oni-reaction-root container and CSS
//   • Spawns / positions a "Reaction" blade next to a token
//   • Cleans up buttons when asked
//
// It exposes a small API on window["oni.ReactionButtonUI"]:
//
//   const ui = window["oni.ReactionButtonUI"];
//   ui.spawnButton(token, context, (ctxClicked) => { ... });
//   ui.removeButton(tokenId);
//   ui.clearAll();
//
// NOTES
// -----
// - It DOES NOT know anything about triggers, phases, or skill selection.
// - ReactionManager decides *when* to show a button and what happens when
//   it's clicked. This file just does the pretty floating UI.
// ============================================================================

function _installReactionButtonUI() {
  (() => {
    const KEY = "oni.ReactionButtonUI";

    if (window[KEY]) {
      console.debug("[ReactionButtonUI] Already installed.");
      return;
    }

    const STYLE_ID = "oni-reaction-manager-style";

    const ReactionUI = {
      root: null,
      // Reaction menus — one TurnUI named menu per reactor token. Map
      // keyed by tokenId so multiple reactors' menus coexist on the
      // same client (AoE on the GM, party-double-owner case, etc.).
      menusByToken: new Map(),       // Map<tokenId, { context }>
      // Ally indicators — read-only vertical info-lists rendered on
      // teammate tokens. Keyed by tokenId, distinct from menusByToken
      // since a single client never owns AND mirrors the same token.
      allyIndicators: {}
    };
    // Legacy alias: external callers may still read ReactionUI.buttons;
    // expose a stub map so reads don't crash. We don't populate it.
    ReactionUI.buttons = {};

    function menuIdForToken(tokenId) {
      return `reaction:${tokenId}`;
    }

    function byIdOnCanvas(tokenId) {
      if (!tokenId) return null;
      return canvas?.tokens?.get(tokenId) ?? null;
    }

    function ensureReactionStyles() {
      if (document.getElementById(STYLE_ID)) return;

      const css = document.createElement("style");
      css.id = STYLE_ID;

      css.textContent = `
        #oni-reaction-root {
          position: fixed;
          left: 0;
          top: 0;
          z-index: var(--z-index-canvas, 0);
          pointer-events: none;
        }

        #oni-reaction-root .oni-reaction-item {
          position: absolute;
          pointer-events: auto;
          opacity: 0;
          transform: translateX(-16px);
          transition:
            opacity 180ms ease-out,
            transform 180ms ease-out;
        }

        #oni-reaction-root .oni-reaction-item.is-visible {
          opacity: 1;
          transform: translateX(0);
        }

        #oni-reaction-root .oni-reaction-item.is-leaving {
          opacity: 0;
          transform: translateX(-16px);
        }

        #oni-reaction-root .oni-reaction-blade {
          position: relative;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          padding: 8px 14px;
          color: var(--bd-ink, #3a3228);
          font-family: "Inter", "Segoe UI", system-ui, -apple-system, sans-serif;
          font-weight: 800;
          letter-spacing: .32px;
          text-transform: uppercase;
          white-space: nowrap;
          user-select: none;
          cursor: pointer;
          font-size: 12px;
          background: linear-gradient(180deg,
            var(--bd-parchment-top, #f6f1e6),
            var(--bd-parchment-bot, #ebe3d0)
          );
          border: 2px solid var(--bd-stroke, #7a6a55);
          border-radius: 12px;
          box-shadow:
            0 3px 0 var(--bd-shadow, rgba(41,33,24,.55)),
            0 0 0 1px var(--bd-highlight, rgba(255,255,255,.7)) inset;
          text-shadow: 0 1px 0 rgba(255,255,255,0.75);
        }

        #oni-reaction-root .oni-reaction-blade .label {
          padding-top: 1px;
        }

        #oni-reaction-root .oni-reaction-blade .count {
          display: none;
          min-width: 18px;
          height: 18px;
          padding: 0 5px;
          align-items: center;
          justify-content: center;
          border-radius: 999px;
          border: 1px solid rgba(122,106,85,.9);
          background: rgba(58,50,40,.08);
          box-shadow: 0 1px 0 rgba(255,255,255,.55) inset;
          font-size: 11px;
          line-height: 1;
        }

        #oni-reaction-root .oni-reaction-blade.has-multiple .count {
          display: inline-flex;
        }

        /* Countdown badge — shows the live "seconds left" tick streamed by
           the reaction-window substrate. Hidden by default; .has-countdown
           on the blade reveals it. Colors shift as time runs out. */
        #oni-reaction-root .oni-reaction-blade .countdown {
          display: none;
          min-width: 20px;
          height: 20px;
          padding: 0 6px;
          align-items: center;
          justify-content: center;
          border-radius: 999px;
          border: 1px solid rgba(122,106,85,.9);
          background: linear-gradient(180deg,
            rgba(213,182,122,0.65),
            rgba(183,147,90,0.65)
          );
          box-shadow: 0 1px 0 rgba(255,255,255,.55) inset;
          font-family: "Inter", "Segoe UI", system-ui, -apple-system, sans-serif;
          font-size: 11px;
          font-weight: 800;
          line-height: 1;
          color: #2b2218;
          text-shadow: 0 1px 0 rgba(255,255,255,0.55);
        }

        #oni-reaction-root .oni-reaction-blade.has-countdown .countdown {
          display: inline-flex;
        }

        /* Last 2 seconds — warn color. */
        #oni-reaction-root .oni-reaction-blade.has-countdown.urgent .countdown {
          background: linear-gradient(180deg, #e9a36c, #c87038);
          border-color: #7a4022;
          color: #fff;
          text-shadow: 0 1px 0 rgba(0,0,0,.4);
        }

        #oni-reaction-root .oni-reaction-blade:hover {
          filter: brightness(1.04);
          box-shadow:
            0 4px 0 rgba(41,33,24,.65),
            0 0 0 1px rgba(255,255,255,.8) inset;
          transform: translateY(-1px);
        }

        #oni-reaction-root .oni-reaction-blade:active {
          transform: translateY(0) scale(.97);
        }

        /* Cancel pip — square red ✕ matching the reaction blade height.
           Width is set explicitly in JS after the blade renders (the
           aspect-ratio CSS hint is unreliable on stretched flex children
           because the cross-axis size is determined after layout). */
        #oni-reaction-root .oni-reaction-item {
          display: inline-flex;
          align-items: stretch; /* let the cancel grow to the blade height */
          gap: 6px;
        }
        #oni-reaction-root .oni-reaction-cancel {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          padding: 0;
          border-radius: 10px;
          border: 2px solid #6f1b1b;
          background: linear-gradient(180deg, #d4554b, #a82e26);
          box-shadow:
            0 3px 0 rgba(80,12,12,.55),
            0 0 0 1px rgba(255,255,255,.45) inset;
          color: #fff;
          font-family: "Inter", "Segoe UI", system-ui, -apple-system, sans-serif;
          font-weight: 900;
          font-size: 14px;
          line-height: 1;
          cursor: pointer;
          text-shadow: 0 1px 0 rgba(0,0,0,.45);
          user-select: none;
          box-sizing: border-box;
        }
        #oni-reaction-root .oni-reaction-cancel:hover {
          filter: brightness(1.08);
          transform: translateY(-1px);
          box-shadow:
            0 4px 0 rgba(80,12,12,.65),
            0 0 0 1px rgba(255,255,255,.55) inset;
        }
        #oni-reaction-root .oni-reaction-cancel:active {
          transform: translateY(0) scale(.96);
        }

        /* ============================================================
           Pill row — one pill per eligible reaction skill. Click a pill
           to fire that skill directly (skips the picker dialog). Hover
           reveals description + trigger context in the title tooltip.
           ============================================================ */
        #oni-reaction-root .oni-reaction-pills {
          display: inline-flex;
          align-items: stretch;
          gap: 4px;
          flex-wrap: nowrap;
        }

        #oni-reaction-root .oni-reaction-pill {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 5px 10px 5px 6px;
          color: var(--bd-ink, #3a3228);
          font-family: "Inter", "Segoe UI", system-ui, -apple-system, sans-serif;
          font-weight: 800;
          font-size: 11px;
          letter-spacing: .25px;
          white-space: nowrap;
          user-select: none;
          cursor: pointer;
          background: linear-gradient(180deg,
            var(--bd-parchment-top, #f6f1e6),
            var(--bd-parchment-bot, #ebe3d0)
          );
          border: 2px solid var(--bd-stroke, #7a6a55);
          border-radius: 12px;
          box-shadow:
            0 3px 0 var(--bd-shadow, rgba(41,33,24,.55)),
            0 0 0 1px var(--bd-highlight, rgba(255,255,255,.7)) inset;
          text-shadow: 0 1px 0 rgba(255,255,255,0.75);
          transition: transform 120ms ease-out, filter 120ms ease-out, box-shadow 120ms ease-out;
        }

        #oni-reaction-root .oni-reaction-pill:hover {
          filter: brightness(1.05);
          transform: translateY(-1px);
          box-shadow:
            0 4px 0 rgba(41,33,24,.65),
            0 0 0 1px rgba(255,255,255,.8) inset;
        }

        #oni-reaction-root .oni-reaction-pill:active {
          transform: translateY(0) scale(.97);
        }

        #oni-reaction-root .oni-reaction-pill .pill-icon {
          width: 20px;
          height: 20px;
          border-radius: 5px;
          border: 1px solid rgba(122,106,85,.7);
          background: rgba(255,255,255,.4);
          object-fit: cover;
          flex: 0 0 auto;
        }

        #oni-reaction-root .oni-reaction-pill .pill-name {
          padding-top: 1px;
        }

        /* Standalone countdown pip — placed between pill row and cancel
           pip so all interactive elements line up in one strip. */
        #oni-reaction-root .oni-reaction-countdown-pip {
          display: none;
          align-items: center;
          justify-content: center;
          min-width: 22px;
          padding: 0 7px;
          border-radius: 10px;
          border: 2px solid rgba(122,106,85,.9);
          background: linear-gradient(180deg,
            rgba(213,182,122,0.75),
            rgba(183,147,90,0.75)
          );
          box-shadow:
            0 3px 0 rgba(41,33,24,.45),
            0 0 0 1px rgba(255,255,255,.55) inset;
          font-family: "Inter", "Segoe UI", system-ui, -apple-system, sans-serif;
          font-size: 11px;
          font-weight: 800;
          color: #2b2218;
          text-shadow: 0 1px 0 rgba(255,255,255,0.55);
          user-select: none;
          pointer-events: none;
        }

        /* Countdown pip — temporarily disabled. The class still toggles
           and the tick handler still updates the pip text; we just hide
           the element. Re-enable by changing display:none to
           display:inline-flex on the rule below. */
        #oni-reaction-root .oni-reaction-item.has-countdown .oni-reaction-countdown-pip {
          display: none;
        }

        #oni-reaction-root .oni-reaction-item.urgent .oni-reaction-countdown-pip {
          background: linear-gradient(180deg, #e9a36c, #c87038);
          border-color: #7a4022;
          color: #fff;
          text-shadow: 0 1px 0 rgba(0,0,0,.4);
        }

        /* ============================================================
           Ally list — read-only vertical list of "[icon] [name]" rows
           on a teammate's token. Smaller and quieter than the owner
           Action Menu; just an information cue so the party knows
           what reactions their ally has in play.
           ============================================================ */
        #oni-reaction-root .oni-reaction-ally-list {
          display: inline-flex;
          flex-direction: column;
          align-items: stretch;
          gap: 2px;
          padding: 4px 7px;
          background: linear-gradient(180deg,
            rgba(246, 241, 230, .55),
            rgba(220, 210, 188, .55)
          );
          border: 1px dashed rgba(122, 106, 85, .55);
          border-radius: 7px;
          box-shadow: 0 1px 0 rgba(41, 33, 24, .2);
          pointer-events: none;
          filter: saturate(0.6);
        }

        #oni-reaction-root .oni-reaction-ally-row {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          font-family: "Inter", "Segoe UI", system-ui, -apple-system, sans-serif;
          font-size: 9.5px;
          font-weight: 700;
          letter-spacing: .15px;
          color: rgba(58, 50, 40, .8);
          text-shadow: 0 1px 0 rgba(255, 255, 255, .45);
          white-space: nowrap;
        }

        #oni-reaction-root .oni-reaction-ally-row .icon {
          width: 13px;
          height: 13px;
          border-radius: 3px;
          border: 1px solid rgba(122, 106, 85, .55);
          object-fit: cover;
          flex: 0 0 auto;
          opacity: .85;
        }

        #oni-reaction-root .oni-reaction-ally-row .owner {
          opacity: .65;
          font-weight: 800;
          margin-right: 2px;
        }
      `;

      document.head.appendChild(css);
    }

    function ensureRoot() {
      if (ReactionUI.root && document.body.contains(ReactionUI.root)) {
        return ReactionUI.root;
      }

      const root = document.createElement("div");
      root.id = "oni-reaction-root";
      document.body.appendChild(root);

      ReactionUI.root = root;
      return root;
    }

    function tokenAnchorWorld(token) {
      const c = token.center ?? token.getCenter?.() ?? {
        x: token.x + token.w / 2,
        y: token.y + token.h / 2
      };

      const offsetX = -token.w * 0.37;
      const offsetY = -token.h * 1;

      return {
        x: c.x + offsetX,
        y: c.y + offsetY
      };
    }

    function worldToClient(x, y) {
      const wt = canvas.stage.worldTransform;
      const out = new PIXI.Point();

      wt.apply({ x, y }, out);

      const rect = canvas.app.view.getBoundingClientRect();

      return {
        x: rect.left + out.x,
        y: rect.top + out.y
      };
    }

    function updateButtonPosition(rec) {
      if (!rec) return;

      const token = byIdOnCanvas(rec.tokenId);
      if (!token || !ReactionUI.root) return;

      const world = tokenAnchorWorld(token);
      const client = worldToClient(world.x, world.y);

      const el = rec.wrap;
      if (!el) return;

      el.style.left = `${client.x}px`;
      el.style.top = `${client.y}px`;
    }

    function escapePillText(s) {
      return String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    function getReactionGroupsForContext(context) {
      try {
        const api = window["oni.ReactionChooseSkill"];
        if (typeof api?.getReactionGroupsForCtx === "function") {
          return api.getReactionGroupsForCtx(context) ?? [];
        }
      } catch (e) {
        console.warn("[ReactionButtonUI] getReactionGroupsForCtx failed:", e);
      }
      return [];
    }

    function buildPillTooltip(group) {
      // Format: one "trigger | target" line per matched row (deduped),
      // blank line, description. Skill name is the pill text already.
      const lines = Array.isArray(group.triggerLines) ? group.triggerLines : [];
      const head = lines
        .map(l => l?.target ? `${l.trigger} | ${l.target}` : l?.trigger)
        .filter(Boolean)
        .join("\n");
      const parts = [];
      if (head) parts.push(head);
      if (group.description) parts.push(group.description);
      return parts.join("\n\n");
    }

    function renderPillsIntoContainer(container, groups, opts = {}) {
      if (!container) return;
      const isAlly = !!opts.isAlly;

      // Replace contents wholesale. Each render call is cheap (handful
      // of pills) and avoids fiddly diffing.
      container.replaceChildren();

      for (const group of groups) {
        const pill = document.createElement("div");
        pill.className = isAlly ? "oni-reaction-pill is-ally" : "oni-reaction-pill";
        pill.dataset.itemUuid = group.itemUuid ?? "";
        pill.title = buildPillTooltip(group);
        pill.innerHTML = `
          <img class="pill-icon" src="${escapePillText(group.img)}" alt="">
          <span class="pill-name">${escapePillText(group.name)}</span>
        `;
        if (!isAlly && typeof opts.onPillClick === "function") {
          pill.addEventListener("click", (ev) => {
            ev.stopPropagation();
            try { opts.onPillClick(group); }
            catch (e) { console.warn("[ReactionButtonUI] pill click handler threw:", e); }
          });
        }
        container.appendChild(pill);
      }
    }

    function applyContextToRecord(rec, context, onClick) {
      if (!rec) return;

      rec.context = context;
      rec.onClick = typeof onClick === "function" ? onClick : null;

      const container = rec.pillsContainer;
      if (!container) return;

      const groups = getReactionGroupsForContext(context);
      rec.groups = groups;

      renderPillsIntoContainer(container, groups, {
        isAlly: false,
        onPillClick: (group) => handleOwnerPillClick(rec, group)
      });
    }

    function handleOwnerPillClick(rec, group) {
      // Fire pickerOpened first so the substrate pauses this reactor's
      // timer while the downstream pipeline runs. Mirrors what the legacy
      // blade did on click before opening the picker dialog.
      try {
        const subKey = computeSubKeyForRec(rec);
        if (subKey) Hooks.callAll("oni:reactionWindow:pickerOpened", { subKey });
      } catch (e) {
        console.warn("[ReactionButtonUI] pickerOpened hook failed (non-fatal).", e);
      }

      // Close the menu immediately. executeChosenReaction respawns it on
      // cancel OR after resolve if more reactions remain.
      if (rec?.tokenId) {
        try { removeButton(rec.tokenId); } catch (_) {}
      }

      const api = window["oni.ReactionChooseSkill"];
      if (typeof api?.fireReactionByItemUuid !== "function") {
        ui.notifications?.error?.("[Reaction] ReactionChooseSkill.fireReactionByItemUuid missing.");
        console.error("[ReactionButtonUI] fireReactionByItemUuid not available.");
        return;
      }
      try {
        api.fireReactionByItemUuid(rec.context, group.itemUuid);
      } catch (e) {
        console.error("[ReactionButtonUI] fireReactionByItemUuid threw:", e);
      }
    }

    function detachTrackingHooks(rec) {
      if (!rec) return;

      for (const h of rec.hooks ?? []) {
        try {
          Hooks.off(h.event, h.handler);
        } catch (_e) {}
      }

      rec.hooks = [];
    }

    function attachTrackingHooks(rec) {
      if (!rec) return;

      if (!Array.isArray(rec.hooks)) {
        rec.hooks = [];
      }

      const tokenId = rec.tokenId;

      const updateTokenHandler = (doc) => {
        if (doc.id !== tokenId) return;
        updateButtonPosition(rec);
      };

      const canvasPanHandler = () => {
        updateButtonPosition(rec);
      };

      Hooks.on("updateToken", updateTokenHandler);
      Hooks.on("canvasPan", canvasPanHandler);

      rec.hooks.push(
        { event: "updateToken", handler: updateTokenHandler },
        { event: "canvasPan", handler: canvasPanHandler }
      );
    }

function getContextActionKey(context) {
  return String(
    context?.latestPhasePayload?.actionCardId ??
    context?.latestPhasePayload?.actionId ??
    context?.phasePayload?.actionCardId ??
    context?.phasePayload?.actionId ??
    ""
  ).trim();
}

function getContextTriggerKey(context) {
  return String(
    context?.latestTriggerKey ??
    context?.triggerKey ??
    ""
  ).trim();
}

function getContextPhaseBucket(context) {
  return String(
    context?.phaseBucket ??
    ""
  ).trim();
}

function shouldPlayRespawnAnimation(rec, nextContext) {
  if (!rec) return false;

  const wrap = rec.wrap;

  // If the button was in the middle of leaving, the next update should visibly
  // re-enter. This is the main phase-change case.
  if (rec.leaving || wrap?.classList?.contains?.("is-leaving")) {
    return true;
  }

  const oldContext = rec.context ?? {};

  const oldBucket = getContextPhaseBucket(oldContext);
  const newBucket = getContextPhaseBucket(nextContext);

  if (oldBucket && newBucket && oldBucket !== newBucket) {
    return true;
  }

  const oldTrigger = getContextTriggerKey(oldContext);
  const newTrigger = getContextTriggerKey(nextContext);

  if (oldTrigger && newTrigger && oldTrigger !== newTrigger) {
    return true;
  }

  // Same bucket + same trigger, but a different action card/action event.
  // Example: another creature performs another action during action_phase.
  const oldActionKey = getContextActionKey(oldContext);
  const newActionKey = getContextActionKey(nextContext);

  if (oldActionKey && newActionKey && oldActionKey !== newActionKey) {
    return true;
  }

  return false;
}

function playRespawnAnimation(rec) {
  const wrap = rec?.wrap;
  if (!wrap?.isConnected) return;

  // TUNING KNOB:
  // How long the button stays in its "leaving" pose before entering again.
  const RESPAWN_GAP_MS = 130;

  if (rec.respawnTimer) {
    clearTimeout(rec.respawnTimer);
    rec.respawnTimer = null;
  }

  // Temporarily prevent clicking during the tiny transition swap.
  wrap.style.pointerEvents = "none";

  // Step 1: visibly leave.
  wrap.classList.remove("is-visible");
  wrap.classList.add("is-leaving");

  // Force browser to notice the class change.
  // eslint-disable-next-line no-unused-expressions
  wrap.offsetWidth;

  rec.respawnTimer = setTimeout(() => {
    rec.respawnTimer = null;

    if (!wrap.isConnected) return;

    // Step 2: reset to hidden enter pose.
    wrap.classList.remove("is-leaving");

    // Force reset before entering.
    // eslint-disable-next-line no-unused-expressions
    wrap.offsetWidth;

    // Step 3: enter again.
    requestAnimationFrame(() => {
      if (!wrap.isConnected) return;

      wrap.classList.add("is-visible");
      wrap.style.pointerEvents = "";
    });
  }, RESPAWN_GAP_MS);
}

function updateExistingButton(rec, context, onClick) {
  if (!rec) return;

  const shouldRespawn = shouldPlayRespawnAnimation(rec, context);

  // Revive this record safely.
  rec.leaving = false;

  // Cancel any old delayed removal from removeButton().
  if (rec.removeTimer) {
    clearTimeout(rec.removeTimer);
    rec.removeTimer = null;
  }

  if (rec.finishRemove && rec.wrap) {
    try {
      rec.wrap.removeEventListener("transitionend", rec.finishRemove);
    } catch (_e) {}

    rec.finishRemove = null;
  }

  applyContextToRecord(rec, context, onClick);
  updateButtonPosition(rec);

  if (!Array.isArray(rec.hooks)) {
    rec.hooks = [];
  }

  if (rec.hooks.length === 0) {
    attachTrackingHooks(rec);
  }

  const wrap = rec.wrap;
  if (!wrap?.isConnected) return;

  if (shouldRespawn) {
    playRespawnAnimation(rec);
  } else {
    wrap.classList.remove("is-leaving");
    wrap.classList.add("is-visible");
  }
}

    // -----------------------------------------------------------------
    // Reaction menu — owner-side. Builds an Action-Menu-style command
    // list (icon + name per item, "Skip" at the end) and asks TurnUI to
    // render it. TurnUI's state is a singleton, so on a single client
    // only one reaction menu is visible at a time. Additional reactors'
    // sub-windows queue here and surface as their predecessors resolve.
    // -----------------------------------------------------------------
    function computeSubKeyForContext(context) {
      const rs = globalThis.FUCompanion?.api?.reactionSystem;
      const buildSubKey = rs?._internals?.buildSubKey;
      const computeBucket = rs?._internals?.computeBucket;
      if (!buildSubKey || !computeBucket) return null;
      const payload = context?.latestPhasePayload ?? context?.phasePayload ?? null;
      const tokenId = context?.token?.id ?? context?.combatant?.tokenId ?? null;
      if (!payload || !tokenId) return null;
      try {
        const bucket = computeBucket(payload);
        const actionCardId = payload?.actionCardId ?? payload?.meta?.actionCardId ?? null;
        return buildSubKey({ bucket, actionCardId, reactorTokenId: tokenId });
      } catch { return null; }
    }

    function handleMenuItemPick(context, group) {
      // Pause this sub-window's authoritative timer while the downstream
      // pipeline runs (mirrors the legacy blade click semantic). With the
      // substrate timeout disabled this is currently a no-op, but the hook
      // dispatch stays correct for when it's re-enabled.
      try {
        const subKey = computeSubKeyForContext(context);
        if (subKey) Hooks.callAll("oni:reactionWindow:pickerOpened", { subKey });
      } catch (e) {
        console.warn("[ReactionButtonUI] pickerOpened hook failed:", e);
      }

      // Close the menu immediately so it's not visually competing with the
      // targeting picker / animations that follow. executeChosenReaction
      // re-spawns it on cancel OR after resolve if more reactions remain.
      const reactorTokenId = context?.token?.id ?? context?.combatant?.tokenId ?? null;
      if (reactorTokenId) {
        try { removeButton(reactorTokenId); } catch (_) {}
      }

      const api = window["oni.ReactionChooseSkill"];
      if (typeof api?.fireReactionByItemUuid !== "function") {
        ui.notifications?.error?.("[Reaction] ReactionChooseSkill.fireReactionByItemUuid missing.");
        console.error("[ReactionButtonUI] fireReactionByItemUuid not available.");
        return;
      }
      try {
        api.fireReactionByItemUuid(context, group.itemUuid);
      } catch (e) {
        console.error("[ReactionButtonUI] fireReactionByItemUuid threw:", e);
      }
    }

    function handleMenuSkip(context, token) {
      try {
        const subKey = computeSubKeyForContext(context);
        if (subKey) {
          Hooks.callAll("oni:reactionWindow:pickerClosed", { subKey, picked: false });
        } else {
          removeButton(token?.id);
        }
      } catch (e) {
        console.warn("[ReactionButtonUI] skip handler threw:", e);
        removeButton(token?.id);
      }
    }

    function spawnReactionMenuViaTurnUI(token, context) {
      const TurnUI = globalThis.TurnUI;
      if (!TurnUI?.spawnButtonsForToken) {
        console.error("[ReactionButtonUI] TurnUI.spawnButtonsForToken unavailable — cannot render reaction menu.");
        return false;
      }

      const groups = getReactionGroupsForContext(context);
      if (!groups.length) {
        console.warn("[ReactionButtonUI] No reaction items for this context; skipping menu spawn.", { tokenId: token?.id });
        return false;
      }

      // Auto-skip: every reaction is unavailable in this chain (already
      // used, or charge AE missing). The menu would just be a forced
      // "Skip" press. Resolve the sub-window silently so the cascade
      // proceeds without making the player click through a dead prompt.
      // Covers both the initial open and the post-resolution re-prompt
      // case: after Counterattack fires, the next trigger emit for the
      // same reactor sees Counterattack marked-used and (assuming it was
      // the only available reaction) auto-skips immediately.
      if (groups.every(g => g.disabled)) {
        try {
          const subKey = computeSubKeyForContext(context);
          if (subKey) {
            Hooks.callAll("oni:reactionWindow:pickerClosed", { subKey, picked: false });
            console.debug("[ReactionButtonUI] Auto-skip: every reaction unavailable in current chain.", {
              tokenId: token?.id,
              subKey,
              reasons: groups.map(g => g.disabledReason).filter(Boolean)
            });
          } else {
            console.debug("[ReactionButtonUI] Auto-skip but no subKey computable; menu suppressed without sub resolution.", {
              tokenId: token?.id
            });
          }
        } catch (e) {
          console.warn("[ReactionButtonUI] auto-skip pickerClosed dispatch threw:", e);
        }
        return false;
      }

      const items = groups.map(group => ({
        label: group.name,
        icon: group.img,
        tooltip: buildPillTooltip(group),
        // Once-per-X reactions whose charge AE has been consumed surface
        // as `disabled + disabledReason: "Used"` from getReactionGroupsForCtx.
        // Forward that to the menu so the renderer can disable the blade
        // and overlay the reason text.
        enabled: !group.disabled,
        usedReason: group.disabledReason ?? null,
        onPick: () => handleMenuItemPick(context, group)
      }));

      items.push({
        label: "Skip",
        isSkip: true,
        tooltip: "Don't react. Skips this reactor's window without firing a reaction.",
        onPick: () => handleMenuSkip(context, token)
      });

      TurnUI.spawnButtonsForToken(token, {
        menuId: menuIdForToken(token.id),
        menuClass: "is-reaction-menu",
        pages: [{ name: "Reactions", items }],
        hidePager: true,
        hideBudgetLabel: true
      });
      return true;
    }

    function spawnButton(token, context, _legacyOnClick) {
      if (!token) return;
      ensureReactionStyles();
      const tokenId = token.id;

      // Per-token TurnUI named menu — replaces in place if already
      // present (TurnUI's spawnButtonsForToken does that for us when
      // the same menuId is reused).
      const ok = spawnReactionMenuViaTurnUI(token, context);
      if (ok) ReactionUI.menusByToken.set(tokenId, { context });
    }

    function removeButton(tokenId) {
      if (!tokenId) return;
      if (!ReactionUI.menusByToken.has(tokenId)) return;
      try {
        globalThis.TurnUI?.removeButtons?.({ menuId: menuIdForToken(tokenId) });
      } catch (_) {}
      ReactionUI.menusByToken.delete(tokenId);
    }

    function clearAll() {
      for (const tokenId of Array.from(ReactionUI.menusByToken.keys())) {
        try {
          globalThis.TurnUI?.removeButtons?.({ menuId: menuIdForToken(tokenId) });
        } catch (_) {}
      }
      ReactionUI.menusByToken.clear();
    }

    // ---------------------------------------------------------------------
    // Countdown badge: listen for tick events streamed by reaction-window
    // and update the blade whose tokenId is this sub-window's reactor.
    // ---------------------------------------------------------------------
    function computeSubKeyForRec(rec) {
      const rs = globalThis.FUCompanion?.api?.reactionSystem;
      const buildSubKey = rs?._internals?.buildSubKey;
      const computeBucket = rs?._internals?.computeBucket;
      if (!buildSubKey || !computeBucket) return null;
      const payload = rec?.context?.latestPhasePayload ?? rec?.context?.phasePayload ?? null;
      if (!payload || !rec?.tokenId) return null;
      try {
        const bucket = computeBucket(payload);
        const actionCardId = payload?.actionCardId ?? payload?.meta?.actionCardId ?? null;
        return buildSubKey({ bucket, actionCardId, reactorTokenId: rec.tokenId });
      } catch { return null; }
    }

    // Owner-side tick handler: when the substrate broadcasts a close-tick
    // for any reactor token whose menu we own, tear that specific menu
    // down. Other reactors' menus stay visible.
    Hooks.on("oni:reactionWindow:tick", ({ subKey, closed } = {}) => {
      if (!closed || !subKey) return;
      for (const [tokenId, rec] of Array.from(ReactionUI.menusByToken.entries())) {
        const currentSubKey = computeSubKeyForContext(rec.context);
        if (currentSubKey === subKey) {
          try { removeButton(tokenId); } catch (_) {}
        }
      }
    });

    // -----------------------------------------------------------------
    // Ally indicator — read-only pill row mirroring a teammate's
    // in-flight reaction window. Doesn't open the picker, doesn't carry
    // a countdown, doesn't expose a cancel pip. Cleanup is driven by
    // the same `oni:reactionWindow:tick` close events the owner row
    // uses, correlated by sub-window key.
    // -----------------------------------------------------------------
    function computeSubKeyFromBroadcast(payload) {
      const rs = globalThis.FUCompanion?.api?.reactionSystem;
      const buildSubKey = rs?._internals?.buildSubKey;
      const computeBucket = rs?._internals?.computeBucket;
      if (!buildSubKey || !computeBucket) return null;
      const phasePayload = payload?.latestPhasePayload ?? null;
      const tokenId = payload?.tokenId ?? null;
      if (!phasePayload || !tokenId) return null;
      try {
        const bucket = computeBucket(phasePayload);
        const actionCardId =
          phasePayload?.actionCardId ??
          phasePayload?.meta?.actionCardId ??
          payload?.actionCardId ??
          null;
        return buildSubKey({ bucket, actionCardId, reactorTokenId: tokenId });
      } catch { return null; }
    }

    function buildAllyEntriesFromBroadcast(payload) {
      const items = Array.isArray(payload?.items) ? payload.items : [];
      const ownerNames = (payload?.ownerUserIds ?? [])
        .filter(uid => uid && !game.users?.get(uid)?.isGM)
        .map(uid => game.users?.get(uid)?.name)
        .filter(Boolean);
      const ownerStr = ownerNames.length ? ownerNames[0] : null;

      const entries = items
        .filter(it => !!it?.itemUuid)
        .map(it => ({
          itemUuid: it.itemUuid,
          name: it.name ?? "(Unnamed)",
          img: it.img || "icons/svg/explosion.svg",
          description: typeof it.description === "string" ? it.description : "",
          triggers: Array.isArray(it.triggers) ? [...it.triggers] : []
        }));
      return { ownerStr, entries };
    }

    function renderAllyList(rec, payload) {
      const container = rec?.listContainer;
      if (!container) return;
      const { ownerStr, entries } = buildAllyEntriesFromBroadcast(payload);
      rec.entries = entries;
      container.replaceChildren();

      // Show the owner name once at the top so it's clear whose
      // reactions these are.
      if (ownerStr) {
        const header = document.createElement("div");
        header.className = "oni-reaction-ally-row";
        header.innerHTML = `<span class="owner">${escapePillText(ownerStr)}</span>`;
        container.appendChild(header);
      }

      for (const entry of entries) {
        const row = document.createElement("div");
        row.className = "oni-reaction-ally-row";
        // Ally side: one tooltip line per trigger (no target column yet —
        // the visibility broadcast doesn't carry the consumer's target_ref
        // resolution). Description below. Skill name is in the row text.
        const triggerLabels = entry.triggers
          .map(k => String(k).replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()));
        const tipParts = [];
        if (triggerLabels.length) tipParts.push(triggerLabels.join("\n"));
        if (entry.description) tipParts.push(entry.description);
        row.title = tipParts.join("\n\n");
        row.innerHTML = `
          <img class="icon" src="${escapePillText(entry.img)}" alt="" draggable="false">
          <span class="name">${escapePillText(entry.name)}</span>
        `;
        container.appendChild(row);
      }
    }

    function updateAllyIndicatorPosition(rec) {
      if (!rec) return;
      const token = byIdOnCanvas(rec.tokenId);
      if (!token || !ReactionUI.root) return;
      const world = tokenAnchorWorld(token);
      const client = worldToClient(world.x, world.y);
      const el = rec.wrap;
      if (!el) return;
      el.style.left = `${client.x}px`;
      el.style.top = `${client.y}px`;
    }

    function attachAllyTrackingHooks(rec) {
      if (!rec) return;
      if (!Array.isArray(rec.hooks)) rec.hooks = [];

      const tokenId = rec.tokenId;
      const updateTokenHandler = (doc) => {
        if (doc.id !== tokenId) return;
        updateAllyIndicatorPosition(rec);
      };
      const canvasPanHandler = () => updateAllyIndicatorPosition(rec);

      Hooks.on("updateToken", updateTokenHandler);
      Hooks.on("canvasPan", canvasPanHandler);

      rec.hooks.push(
        { event: "updateToken", handler: updateTokenHandler },
        { event: "canvasPan", handler: canvasPanHandler }
      );
    }

    function detachAllyTrackingHooks(rec) {
      if (!rec) return;
      for (const h of rec.hooks ?? []) {
        try { Hooks.off(h.event, h.handler); } catch (_) {}
      }
      rec.hooks = [];
    }

    function spawnAllyIndicator(token, payload) {
      if (!token || !payload) return;
      ensureReactionStyles();
      const root = ensureRoot();
      const tokenId = token.id;

      const existing = ReactionUI.allyIndicators[tokenId];
      if (existing) {
        existing.payload = payload;
        existing.subKey = computeSubKeyFromBroadcast(payload) ?? existing.subKey;
        renderAllyList(existing, payload);
        updateAllyIndicatorPosition(existing);
        return;
      }

      const wrap = document.createElement("div");
      wrap.className = "oni-reaction-item";

      const listContainer = document.createElement("div");
      listContainer.className = "oni-reaction-ally-list";

      wrap.appendChild(listContainer);
      root.appendChild(wrap);

      const rec = {
        wrap,
        listContainer,
        tokenId,
        payload,
        subKey: computeSubKeyFromBroadcast(payload),
        hooks: [],
        entries: [],
        leaving: false,
        removeTimer: null,
        finishRemove: null,
        removeSeq: 0
      };

      renderAllyList(rec, payload);
      updateAllyIndicatorPosition(rec);
      attachAllyTrackingHooks(rec);

      requestAnimationFrame(() => {
        if (!wrap.isConnected) return;
        wrap.classList.add("is-visible");
      });

      ReactionUI.allyIndicators[tokenId] = rec;
    }

    function removeAllyIndicator(tokenId) {
      const rec = ReactionUI.allyIndicators[tokenId];
      if (!rec || rec.leaving) return;
      rec.leaving = true;
      rec.removeSeq = (rec.removeSeq ?? 0) + 1;
      const seq = rec.removeSeq;

      detachAllyTrackingHooks(rec);
      const el = rec.wrap;
      if (!el) {
        if (ReactionUI.allyIndicators[tokenId] === rec) {
          delete ReactionUI.allyIndicators[tokenId];
        }
        return;
      }

      el.classList.remove("is-visible");
      el.classList.add("is-leaving");

      let done = false;
      const finish = () => {
        if (done || !rec.leaving || rec.removeSeq !== seq) return;
        done = true;
        try { el.removeEventListener("transitionend", finish); } catch (_) {}
        try { el.remove(); } catch (_) {}
        rec.finishRemove = null;
        rec.removeTimer = null;
        if (ReactionUI.allyIndicators[tokenId] === rec) {
          delete ReactionUI.allyIndicators[tokenId];
        }
      };

      rec.finishRemove = finish;
      el.addEventListener("transitionend", finish);
      rec.removeTimer = setTimeout(finish, 250);
    }

    function clearAllAllyIndicators() {
      for (const tokenId of Object.keys(ReactionUI.allyIndicators)) {
        removeAllyIndicator(tokenId);
      }
    }

    // When the owner sub-window resolves (timeout, pick, skip), the
    // substrate broadcasts a close-tick. Match by subKey and clear the
    // corresponding ally indicator on every non-owning client.
    Hooks.on("oni:reactionWindow:tick", ({ subKey, closed } = {}) => {
      if (!closed || !subKey) return;
      const recsSnapshot = Object.values(ReactionUI.allyIndicators).slice();
      for (const rec of recsSnapshot) {
        if (rec.subKey === subKey) {
          try { removeAllyIndicator(rec.tokenId); } catch (_) {}
        }
      }
    });

    window[KEY] = {
      spawnButton,
      removeButton,
      clearAll,
      spawnAllyIndicator,
      removeAllyIndicator,
      clearAllAllyIndicators
    };

    console.debug("[ReactionButtonUI] Installed. Provides oni.ReactionButtonUI API.");
  })();
}

(() => {
  if (globalThis?.game?.ready) _installReactionButtonUI();
  else Hooks.once("ready", _installReactionButtonUI);
})();