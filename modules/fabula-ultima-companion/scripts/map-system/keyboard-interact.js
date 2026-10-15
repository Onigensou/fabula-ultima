/**
 * keyboard-interact.js
 * [ONI] Keyboard interaction on walk maps
 * Foundry VTT v12
 *
 * What this does:
 * - Lets a keyboard-only player use the overhead buttons on walk maps: the
 *   examine "!", the NPC talk bubble, Shop, Refine
 * - Picks one target among the buttons in reach: the one the party last
 *   walked toward, else the nearest. While the player is on the keyboard that
 *   target's buttons glow; a mouse player never sees the glow.
 * - Confirm on a target with one command runs it. A target with two or more
 *   (an NPC with Talk and Shop) opens a small command menu instead: Up / Down
 *   to choose, Confirm to pick, Cancel to close. The menu takes the mouse too.
 *
 * The mouse buttons are untouched; this only reads what they offer.
 *
 * Systems offer their commands through a registry:
 *   window.oni.Interact.register("shop", () => [{
 *     target: "token:<id>",     // commands on the same target share one menu
 *     label: "Shop",
 *     icon: "fas fa-tag",       // Font Awesome classes, shown in the menu
 *     order: 20,                // menu order, lowest first
 *     anchor: { x, y },         // world point, for distance and direction
 *     el: HTMLElement | null,   // the button on screen, to glow while focused
 *     allowed: true,            // false: not this user's to press (skipped)
 *     run: () => { ... }
 *   }]);
 *   window.oni.Interact.unregister("shop");
 *
 *   // Proximity buttons kept in a Map of tokenId -> { el, state }:
 *   window.oni.Interact.register("shop", window.oni.Interact.tokenButtons(ui._btnByTokenId, {
 *     label: "Shop", icon: "fas fa-tag", order: 20, run: (tokenId) => ...
 *   }));
 *
 * Exposes API to:
 *   window.oni.Interact
 */

(() => {
  const INSTALL_TAG = "[ONI][Interact]";

  window.oni = window.oni || {};
  if (window.oni.Interact?.installed) {
    console.debug(INSTALL_TAG, "Already installed; skipping.");
    return;
  }

  const STYLE_ID = "oni-interact-style";
  const MENU_ID = "oni-interact-menu";
  const FOCUS_CLASS = "oni-kb-focus";
  const MENU_LOCK_ID = "interact-menu";

  // How often the focused target is re-picked while the player is on the keyboard.
  const FOCUS_REFRESH_MS = 120;

  // The focus stays on its target until another one is clearly better, so it
  // does not flick between two NPCs standing at much the same distance.
  const FOCUS_STICKINESS = 1.25;

  // A target behind the party (away from the way it last walked) counts as
  // this much farther away.
  const BEHIND_PENALTY = 3;
  const FACING_MIN_COS = 0.35;

  // After an event ends, a Confirm this soon is swallowed, and each swallowed
  // press starts the wait again: someone mashing through the last line of
  // dialogue must stop for a moment before Confirm opens anything. Without
  // the restart, steady mashing reopened the menu and ran the same talk again
  // (seen live: four talks in a row).
  const AFTER_EVENT_QUIET_MS = 400;

  // Buttons over an NPC (Talk, Shop, Refine) appear when the party stands next
  // to it, JRPG-style: at most this many squares of gap between the party's
  // square and the NPC's. One rule for all three; they used to be 75 px from
  // the NPC's edge (Talk) and 140 px centre to centre (Shop, Refine), which
  // showed buttons from two squares away.
  const NPC_RANGE_GRID = 0.5;

  const MENU_IN_MS = 260;
  const MENU_OUT_MS = 200;

  const providers = new Map();

  let focusedTarget = null;
  let painted = [];
  let refreshTimer = null;
  let quietUntil = 0;
  let menu = null;

  function runtime() {
    return globalThis.FUCompanion?.api?.MovementControlCameraRuntime ?? null;
  }

  function register(id, provider) {
    if (!id || typeof provider !== "function") return;
    providers.set(String(id), provider);
  }

  function unregister(id) {
    providers.delete(String(id));
  }

  // A provider for buttons kept as tokenId -> { el, state } (Shop, Refine).
  function tokenButtons(buttonMap, { label, icon = "", order = 50, run }) {
    return () => {
      const out = [];
      for (const [tokenId, rec] of buttonMap?.entries?.() ?? []) {
        if (!rec?.el || rec.state === "hiding") continue;
        const token = canvas?.tokens?.get?.(tokenId);
        if (!token) continue;
        out.push({
          target: `token:${tokenId}`,
          label,
          icon,
          order,
          anchor: { x: token.x + (token.w / 2), y: token.y + (token.h / 2) },
          el: rec.el,
          run: () => run(tokenId)
        });
      }
      return out;
    };
  }

  // A token's square as { left, top, right, bottom }, around a given centre
  // (a walking token's live one) or where the token is drawn.
  function rectOf(token, center = null) {
    const c = center ?? { x: token.x + (token.w / 2), y: token.y + (token.h / 2) };
    return {
      left: c.x - (token.w / 2),
      top: c.y - (token.h / 2),
      right: c.x + (token.w / 2),
      bottom: c.y + (token.h / 2)
    };
  }

  // Is the party (its token, centred at partyCenter) next to the NPC's square?
  function npcInRange(partyToken, partyCenter, npcRect) {
    const a = rectOf(partyToken, partyCenter);
    const gx = Math.max(0, npcRect.left - a.right, a.left - npcRect.right);
    const gy = Math.max(0, npcRect.top - a.bottom, a.top - npcRect.bottom);
    const grid = canvas?.dimensions?.size || 100;
    return Math.hypot(gx, gy) <= (grid * NPC_RANGE_GRID) + 0.5;
  }

  // Walk maps only, players only: the GM keeps the mouse and Foundry's keys.
  function isActive() {
    if (game.user?.isGM) return false;
    if (!canvas?.ready) return false;
    const rt = runtime();
    return !!rt && rt.state?.mode !== "inactive" && !!rt.state?.followEnabledForScene;
  }

  function partyCenter() {
    const token = runtime()?.getFollowToken?.();
    if (!token) return null;
    return { x: token.x + (token.w / 2), y: token.y + (token.h / 2) };
  }

  // Every command on offer, grouped by target.
  function collectTargets() {
    const groups = new Map();

    for (const provider of providers.values()) {
      let list = [];
      try {
        list = provider() ?? [];
      } catch (e) {
        console.warn(INSTALL_TAG, "A provider threw.", e);
        continue;
      }

      for (const cmd of list) {
        if (!cmd?.target || typeof cmd.run !== "function") continue;
        if (cmd.allowed === false) continue;

        let group = groups.get(cmd.target);
        if (!group) {
          group = { target: cmd.target, anchor: cmd.anchor ?? null, commands: [] };
          groups.set(cmd.target, group);
        }
        group.anchor ??= cmd.anchor ?? null;
        group.commands.push(cmd);
      }
    }

    for (const group of groups.values()) {
      group.commands.sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
    }
    return [...groups.values()];
  }

  // Which way the party faces, as a unit vector: the sprite's own direction
  // (it follows click walks too), else the last keyboard direction.
  const DIRECTION_VECTORS = {
    left: [1, 0], downLeft: [Math.SQRT1_2, Math.SQRT1_2], down: [0, 1],
    up: [0, -1], upLeft: [Math.SQRT1_2, -Math.SQRT1_2]
  };

  function partyFacing() {
    const token = runtime()?.getFollowToken?.();
    const sf = globalThis.FUCompanion?.api?.spriteFacing;
    const v = token && DIRECTION_VECTORS[sf?.getDirection?.(token)];
    if (v) {
      // The art is drawn facing left; "right" mirrors it.
      const side = sf.getFacing?.(token) === "right" ? 1 : -1;
      return { x: v[0] === 0 ? 0 : v[0] * side, y: v[1] };
    }
    return runtime()?.getKeyFacing?.() ?? null;
  }

  // Lower is better; Infinity rules a target out. A keyboard player talks to
  // the NPC the party faces, as in a JRPG: an NPC beside or behind is not
  // chosen. Examine points are areas the party may stand on, so only their
  // distance counts, with the ones behind put last.
  function scoreTarget(group, here, facing) {
    if (!group.anchor) return Infinity;
    const dx = group.anchor.x - here.x;
    const dy = group.anchor.y - here.y;
    const distance = Math.hypot(dx, dy);
    if (!facing || distance < 1) return distance;

    const cos = ((dx * facing.x) + (dy * facing.y)) / distance;
    if (cos >= FACING_MIN_COS) return distance;
    return group.target.startsWith("token:") ? Infinity : distance * BEHIND_PENALTY;
  }

  function pickTarget(groups) {
    if (!groups.length) return null;
    const here = partyCenter();
    if (!here) return groups[0];

    const facing = partyFacing();
    let best = null;
    let bestScore = Infinity;
    let current = null;
    let currentScore = Infinity;

    for (const group of groups) {
      const score = scoreTarget(group, here, facing);
      if (score < bestScore) {
        best = group;
        bestScore = score;
      }
      if (group.target === focusedTarget) {
        current = group;
        currentScore = score;
      }
    }

    if (bestScore === Infinity) return null;
    if (current && currentScore <= bestScore * FOCUS_STICKINESS) return current;
    return best;
  }

  // ------------------------------------------------------------
  // Focus glow
  // ------------------------------------------------------------
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
.${FOCUS_CLASS} {
  filter: drop-shadow(0 0 2px #fff6d0) drop-shadow(0 0 5px #f4c040) drop-shadow(0 0 11px rgba(244,192,64,0.85)) !important;
  animation: oni-kb-focus-pulse 1600ms ease-in-out infinite;
}
@keyframes oni-kb-focus-pulse {
  0%, 100% { filter: drop-shadow(0 0 2px #fff6d0) drop-shadow(0 0 5px #f4c040) drop-shadow(0 0 11px rgba(244,192,64,0.85)); }
  50%      { filter: drop-shadow(0 0 2px #fff6d0) drop-shadow(0 0 3px #f4c040) drop-shadow(0 0 6px rgba(244,192,64,0.55)); }
}

#${MENU_ID} {
  position: fixed;
  z-index: 9990;
  box-sizing: border-box;
  min-width: 168px;
  padding: 12px 12px 12px;
  border: 2px solid #c9a44a;
  border-radius: 10px;
  background: linear-gradient(168deg, #f8f0d4 0%, #ede0b0 100%);
  box-shadow: 0 0 0 2px #7a4e20, 0 0 0 4px #b8865a, 0 0 22px rgba(0,0,0,0.38), inset 0 1px 0 rgba(255,245,200,0.70);
  font-family: "Signika","Noto Sans","Segoe UI",sans-serif;
  color: #3a1e06;
  user-select: none;
  pointer-events: auto;
  opacity: 0;
  transform: translateX(-24px);   /* enters from the left */
  transition: opacity ${MENU_IN_MS}ms cubic-bezier(.25,.46,.45,.94),
              transform ${MENU_IN_MS}ms cubic-bezier(.25,.46,.45,.94);
}
#${MENU_ID}::before {
  content: ''; position: absolute; inset: 0; pointer-events: none; border-radius: 8px;
  background: repeating-linear-gradient(0deg, transparent, transparent 23px, rgba(140,90,30,0.04) 23px, rgba(140,90,30,0.04) 24px);
}
#${MENU_ID}.is-visible {
  opacity: 1;
  transform: translateX(0);
}
#${MENU_ID}.is-leaving {
  opacity: 0;
  transform: translateX(24px);   /* leaves to the right */
  transition: opacity ${MENU_OUT_MS}ms cubic-bezier(.55,.085,.68,.53),
              transform ${MENU_OUT_MS}ms cubic-bezier(.55,.085,.68,.53);
  pointer-events: none;
}
#${MENU_ID} .oni-interact-list {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
#${MENU_ID} .oni-interact-btn {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  box-sizing: border-box;
  width: 100%;
  min-height: 36px;
  margin: 0;
  padding: 6px 18px 6px 14px;
  border: 1px solid #9b7040;
  border-radius: 8px;
  background: linear-gradient(180deg, #7a5230 0%, #5c3818 100%);
  color: #f4e8c0;
  font-family: inherit;
  font-size: 16px;
  font-weight: 400;
  line-height: 1.3;
  letter-spacing: .4px;
  text-align: left;
  cursor: pointer;
  box-shadow: 0 2px 6px rgba(40,18,4,0.38), inset 0 1px 0 rgba(255,225,140,0.14);
  transition: border-color .12s, color .12s, background .12s, box-shadow .12s;
}
#${MENU_ID} .oni-interact-btn:focus { outline: none; }
#${MENU_ID} .oni-interact-btn i {
  width: 18px;
  text-align: center;
  opacity: .9;
}
#${MENU_ID} .oni-interact-btn.is-picked {
  border-color: #f4d488; color: #fff8e0;
  background: linear-gradient(180deg, #9b6840 0%, #7a4a22 100%);
  box-shadow: 0 0 0 2px #f4d488, 0 0 18px rgba(244,212,136,0.55), 0 2px 6px rgba(40,18,4,0.38), inset 0 1px 0 rgba(255,225,140,0.22);
}
    `;
    document.head.appendChild(style);
  }

  function clearPaint() {
    for (const el of painted) el.classList.remove(FOCUS_CLASS);
    painted = [];
  }

  function paint(group) {
    const els = (group?.commands ?? []).map(c => c.el).filter(el => el instanceof HTMLElement);
    if (els.length === painted.length && els.every((el, i) => el === painted[i])) return;
    clearPaint();
    ensureStyle();
    for (const el of els) el.classList.add(FOCUS_CLASS);
    painted = els;
  }

  // Re-pick and glow. Only while the player is on the keyboard; the menu,
  // once open, shows the choice itself.
  function refreshFocus() {
    const onKeys = window.oni.Input?.mode === "key";
    if (!onKeys || !isActive() || menu) {
      clearPaint();
      if (!menu) focusedTarget = null;
      return;
    }
    const group = pickTarget(collectTargets());
    focusedTarget = group?.target ?? null;
    paint(group);
  }

  function syncRefresh() {
    const want = window.oni.Input?.mode === "key";
    if (want && !refreshTimer) {
      refreshTimer = setInterval(refreshFocus, FOCUS_REFRESH_MS);
      refreshFocus();
    } else if (!want && refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
      refreshFocus();
    }
  }

  // ------------------------------------------------------------
  // Running a command
  // ------------------------------------------------------------
  async function runCommand(cmd) {
    try {
      await cmd.run();
    } catch (e) {
      console.warn(INSTALL_TAG, `"${cmd.label}" failed.`, e);
    }
  }

  // ------------------------------------------------------------
  // Command menu (two or more commands on one target)
  // ------------------------------------------------------------
  function paintMenu() {
    menu?.el.querySelectorAll(".oni-interact-btn").forEach((btn, index) => {
      btn.classList.toggle("is-picked", index === menu.highlight);
    });
  }

  function moveMenu(index) {
    if (!menu) return;
    const count = menu.commands.length;
    menu.highlight = ((index % count) + count) % count;
    paintMenu();
  }

  function closeMenu({ immediate = false } = {}) {
    if (!menu) return;
    const { el, stopInput, onOutside } = menu;
    menu = null;

    stopInput?.();
    window.removeEventListener("pointerdown", onOutside, { capture: true });
    runtime()?.unlockMovement?.(MENU_LOCK_ID);

    if (immediate) {
      el.remove();
    } else {
      el.classList.remove("is-visible");
      el.classList.add("is-leaving");
      setTimeout(() => el.remove(), MENU_OUT_MS + 40);
    }
    refreshFocus();
  }

  function pickMenu(index) {
    if (!menu || game.paused) return;
    const cmd = menu.commands[index];
    closeMenu();
    if (cmd) runCommand(cmd);
  }

  // Beside the target's buttons, kept clear of the window edges and the sidebar.
  function placeMenu(el, group) {
    const rects = group.commands
      .map(c => c.el?.getBoundingClientRect?.())
      .filter(r => r && r.width);

    let x;
    let y;
    if (rects.length) {
      x = Math.max(...rects.map(r => r.right)) + 14;
      y = Math.min(...rects.map(r => r.top));
    } else {
      const wt = canvas.app.stage.worldTransform;
      x = (group.anchor.x * wt.a) + wt.tx + 40;
      y = (group.anchor.y * wt.d) + wt.ty - 40;
    }

    const box = el.getBoundingClientRect();
    const sidebarLeft = document.getElementById("sidebar")?.getBoundingClientRect?.().left ?? window.innerWidth;
    const maxX = Math.min(window.innerWidth, sidebarLeft) - box.width - 12;
    const maxY = window.innerHeight - box.height - 12;

    el.style.left = `${Math.round(Math.max(12, Math.min(x, maxX)))}px`;
    el.style.top = `${Math.round(Math.max(12, Math.min(y, maxY)))}px`;
  }

  function openMenu(group) {
    closeMenu({ immediate: true });
    ensureStyle();
    clearPaint();

    const el = document.createElement("div");
    el.id = MENU_ID;
    el.setAttribute("role", "menu");
    el.innerHTML = `<div class="oni-interact-list"></div>`;

    const list = el.querySelector(".oni-interact-list");
    group.commands.forEach((cmd, index) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "oni-interact-btn";
      btn.setAttribute("role", "menuitem");
      if (cmd.icon) {
        const icon = document.createElement("i");
        icon.className = cmd.icon;
        btn.appendChild(icon);
      }
      btn.appendChild(document.createTextNode(cmd.label ?? ""));
      // Only a cursor that actually moves takes the highlight (see the
      // choices menu: a resting cursor stole it from the keyboard).
      btn.addEventListener("pointermove", (ev) => {
        if (ev.movementX || ev.movementY) moveMenu(index);
      });
      btn.addEventListener("click", () => pickMenu(index));
      list.appendChild(btn);
    });

    // A click on the menu never reaches the canvas underneath.
    el.addEventListener("pointerdown", (ev) => ev.stopPropagation());

    const A = window.oni.Input?.ACTIONS ?? {};
    const stopInput = window.oni.Input?.listen?.(({ action }) => {
      if (!menu) return false;
      if (action === A.UP) moveMenu(menu.highlight - 1);
      else if (action === A.DOWN) moveMenu(menu.highlight + 1);
      else if (action === A.CONFIRM) pickMenu(menu.highlight);
      else if (action === A.CANCEL) closeMenu();
      else return false;
      return true;
    }) ?? null;

    // A click anywhere else closes it, as Cancel does.
    const onOutside = (ev) => {
      if (menu && !menu.el.contains(ev.target)) closeMenu();
    };

    menu = { el, group, commands: group.commands, highlight: 0, stopInput, onOutside };

    // The party stands still while the menu is open; the arrows are the menu's.
    runtime()?.lockMovement?.(MENU_LOCK_ID);

    document.body.appendChild(el);
    placeMenu(el, group);
    paintMenu();
    window.addEventListener("pointerdown", onOutside, { capture: true });

    // Two frames so the starting (hidden, offset) state is painted first.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (menu?.el === el) el.classList.add("is-visible");
    }));
  }

  // ------------------------------------------------------------
  // Confirm on the walk map
  // ------------------------------------------------------------
  function onPress({ action }) {
    if (menu) return false;
    if (action !== window.oni.Input?.ACTIONS?.CONFIRM) return false;
    if (!isActive()) return false;
    const now = performance.now();
    if (now < quietUntil) {
      quietUntil = now + AFTER_EVENT_QUIET_MS;
      return true;
    }

    const group = pickTarget(collectTargets());
    if (!group) return false;

    focusedTarget = group.target;
    if (group.commands.length === 1) {
      runCommand(group.commands[0]);
    } else {
      openMenu(group);
    }
    return true;
  }

  window.oni.Interact = {
    installed: true,
    register,
    unregister,
    tokenButtons,
    NPC_RANGE_GRID,
    npcInRange,
    rectOf,
    // For tests and debugging: what Confirm would act on right now.
    peek: () => {
      const group = pickTarget(collectTargets());
      return group ? { target: group.target, commands: group.commands.map(c => c.label) } : null;
    },
    isMenuOpen: () => !!menu,
    closeMenu: () => closeMenu({ immediate: true })
  };

  Hooks.once("ready", () => {
    if (game.user?.isGM) return;

    // Registered at ready, so it is the last listener asked: a dialogue or a
    // choice menu opened later always gets Confirm first.
    window.oni.Input?.listen?.(onPress);

    Hooks.on("oniInputMode", syncRefresh);
    Hooks.on("oniEventExecuteDone", () => {
      quietUntil = performance.now() + AFTER_EVENT_QUIET_MS;
    });
    Hooks.on("canvasTearDown", () => {
      closeMenu({ immediate: true });
      clearPaint();
      focusedTarget = null;
    });
    syncRefresh();
  });

  console.debug(INSTALL_TAG, "Installed. API: window.oni.Interact");
})();
