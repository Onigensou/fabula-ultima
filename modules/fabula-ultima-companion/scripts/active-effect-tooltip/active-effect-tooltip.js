const FU_EFFECT_TOOLTIP = (() => {
  const MODULE_ID = "fabula-ultima-companion";
  const KEY = "__ONI_EFFECT_TOOLTIP__";

  function normalizePath(p) {
    return String(p ?? "").replace(/^https?:\/\/[^/]+/i, "").trim();
  }

  function extractTexturePath(obj) {
    return (
      obj?.texture?.baseTexture?.resource?.src ??
      obj?.texture?.baseTexture?.resource?.url ??
      obj?.texture?.baseTexture?.cacheId ??
      obj?.icon?.texture?.baseTexture?.resource?.src ??
      obj?.children?.[0]?.texture?.baseTexture?.resource?.src ??
      null
    );
  }

  function walk(root, out = [], depth = 0) {
    if (!root) return out;
    out.push({ obj: root, depth });
    for (const child of root.children ?? []) walk(child, out, depth + 1);
    return out;
  }

  function pointInRect(px, py, x, y, w, h) {
    return px >= x && px <= x + w && py >= y && py <= y + h;
  }

function createState() {
  return {
    active: true,
    tooltipEl: null,
    currentHoverKey: null,
    moveHandler: null,
    leaveHandler: null,
    raf: null,
    lastEvent: null,
    descCache: new Map(),
    board: null
  };
}

  function getTooltipEl(state) {
    if (state.tooltipEl) return state.tooltipEl;

    const el = document.createElement("div");
    el.id = "oni-effect-tooltip";

    Object.assign(el.style, {
      position: "fixed",
      zIndex: "100000",
      maxWidth: "320px",
      minWidth: "180px",
      padding: "10px 12px",
      borderRadius: "10px",
      background: "rgba(15,15,18,0.94)",
      border: "1px solid rgba(255,255,255,0.16)",
      boxShadow: "0 10px 24px rgba(0,0,0,0.45)",
      color: "#f1f1f1",
      font: "12px/1.45 sans-serif",
      pointerEvents: "none",
      whiteSpace: "normal",
      display: "none"
    });

    document.body.appendChild(el);
    state.tooltipEl = el;
    return el;
  }

  function hideTooltip(state) {
    const el = getTooltipEl(state);
    el.style.display = "none";
    state.currentHoverKey = null;
  }

  function placeTooltip(state, clientX, clientY) {
    const el = getTooltipEl(state);
    const pad = 14;
    let left = clientX + 16;
    let top = clientY + 16;

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const rect = el.getBoundingClientRect();

    if (left + rect.width + pad > vw) left = clientX - rect.width - 16;
    if (top + rect.height + pad > vh) top = clientY - rect.height - 16;

    el.style.left = `${Math.max(pad, left)}px`;
    el.style.top = `${Math.max(pad, top)}px`;
  }

  function formatChanges(effect) {
    const changes = Array.isArray(effect?.changes) ? effect.changes : [];
    if (!changes.length) return "";

    const rows = changes.map(c => {
      const key = c.key ?? "(no key)";
      const value = c.value ?? "";
      return `• ${key}: ${value}`;
    });

    return rows.join("<br>");
  }

  async function resolveDescription(state, effect) {
    if (!effect) return "(Missing Active Effect document.)";

    const cacheKey = effect.uuid ?? `${effect.parent?.uuid ?? "unknown-parent"}.${effect.id}`;
    if (state.descCache.has(cacheKey)) return state.descCache.get(cacheKey);

    let desc =
      effect.description ??
      effect.system?.description ??
      effect.flags?.world?.description ??
      effect.flags?.core?.description ??
      "";

    if (typeof desc === "object" && desc !== null) {
      desc = desc.value ?? "";
    }

    if (typeof desc !== "string") desc = String(desc ?? "");
    desc = desc.trim();

    // Try origin item description if the effect itself has no description
    if (!desc && effect.origin) {
      try {
        const originDoc = await fromUuid(effect.origin);
        const originDesc =
          originDoc?.system?.description ??
          originDoc?.description ??
          originDoc?.flags?.world?.description ??
          "";

        let candidate = originDesc;
        if (typeof candidate === "object" && candidate !== null) {
          candidate = candidate.value ?? "";
        }
        if (typeof candidate !== "string") candidate = String(candidate ?? "");
        if (candidate.trim()) desc = candidate.trim();
      } catch (err) {
        console.warn("[ONI][EffectTooltip] Failed to resolve origin description", err);
      }
    }

    // Final fallback: show changes
    if (!desc) {
      const changesText = formatChanges(effect);
      if (changesText) desc = changesText;
    }

    if (!desc) desc = "(No description field found on this Active Effect.)";

    state.descCache.set(cacheKey, desc);
    return desc;
  }

  function buildTooltipHtml({ effect, texturePath }) {
    const img = effect?.img ?? effect?.icon ?? texturePath ?? "";
    const name = effect?.name ?? effect?.label ?? "Unnamed Effect";

    return {
      title: name,
      icon: img
    };
  }

  function findHoveredEffect(clientX, clientY) {
    const hits = [];

    for (const token of canvas?.tokens?.placeables ?? []) {
      if (!token?.visible || !token?.actor || !token?.effects) continue;

      const actorEffects = (token.actor.effects?.contents ?? []).map(e => ({
        effect: e,
        imgNorm: normalizePath(e.img ?? e.icon ?? "")
      }));

      const nodes = walk(token.effects);

      for (const { obj, depth } of nodes) {
        if (obj === token.effects) continue;
        if (obj.visible === false) continue;
        if (typeof obj.getBounds !== "function") continue;

        let b;
        try {
          b = obj.getBounds();
        } catch {
          continue;
        }

        if (!b) continue;

        const w = b.width ?? 0;
        const h = b.height ?? 0;
        const area = w * h;

        if (area < 16 || area > 12000) continue;
        if (!pointInRect(clientX, clientY, b.x, b.y, w, h)) continue;

        const texturePath = extractTexturePath(obj);
        const texNorm = normalizePath(texturePath);

        const matched = actorEffects.find(e => e.imgNorm && texNorm && e.imgNorm === texNorm);
        if (!matched) continue;

        hits.push({
          token,
          effect: matched.effect,
          obj,
          depth,
          bounds: {
            x: Math.round(b.x),
            y: Math.round(b.y),
            w: Math.round(w),
            h: Math.round(h)
          },
          texturePath
        });
      }
    }

    hits.sort((a, b) => {
      const areaA = a.bounds.w * a.bounds.h;
      const areaB = b.bounds.w * b.bounds.h;
      return areaA - areaB;
    });

    return hits[0] ?? null;
  }

  async function renderTooltip(state, hit, clientX, clientY) {
    const el = getTooltipEl(state);
    const hoverKey = `${hit.token.id}:${hit.effect.id}`;

    if (state.currentHoverKey !== hoverKey) {
      const meta = buildTooltipHtml(hit);
      const desc = await resolveDescription(state, hit.effect);

      if (!state.active) return;

      el.innerHTML = `
        <div style="display:flex; gap:10px; align-items:flex-start;">
          ${
            meta.icon
              ? `<img src="${meta.icon}" style="width:32px; height:32px; object-fit:cover; border-radius:6px; flex:0 0 auto;">`
              : ""
          }
          <div style="min-width:0;">
            <div style="font-weight:700; font-size:13px;">${meta.title}</div>
          </div>
        </div>
        <div style="margin-top:6px; border-top:1px solid rgba(255,255,255,0.10); padding-top:8px; font-size:12px;">
          ${desc}
        </div>
      `;

      state.currentHoverKey = hoverKey;
    }

    el.style.display = "block";
    placeTooltip(state, clientX, clientY);
  }

  async function tick(state) {
    state.raf = null;
    if (!state.active || !state.lastEvent) return;

    const ev = state.lastEvent;
    const hit = findHoveredEffect(ev.clientX, ev.clientY);

    if (!hit) {
      hideTooltip(state);
      return;
    }

    await renderTooltip(state, hit, ev.clientX, ev.clientY);
  }

  function stop() {
    const instance = window[KEY];
    const state = instance?.state;
    if (!state) return;

    state.active = false;

    if (state.raf) {
      cancelAnimationFrame(state.raf);
      state.raf = null;
    }

    if (state.board && state.moveHandler) {
      state.board.removeEventListener("mousemove", state.moveHandler, true);
    }

    if (state.board && state.leaveHandler) {
      state.board.removeEventListener("mouseleave", state.leaveHandler, true);
    }

    if (state.tooltipEl) {
      state.tooltipEl.remove();
      state.tooltipEl = null;
    }

    delete window[KEY];
  }

  function start({ notify = false } = {}) {
    const board = canvas?.app?.view;
    if (!board) {
      if (notify) ui.notifications?.error("Could not find Foundry canvas view.");
      return false;
    }

    // Clean previous instance first so reloading scenes does not duplicate listeners.
    stop();

    const state = createState();
    state.board = board;

    function onMove(ev) {
      state.lastEvent = ev;
      if (state.raf) return;

      state.raf = requestAnimationFrame(() => {
        tick(state).catch(err => {
          console.error("[ONI][EffectTooltip] Tick failed", err);
        });
      });
    }

    function onLeave() {
  hideTooltip(state);
}

state.moveHandler = onMove;
state.leaveHandler = onLeave;

board.addEventListener("mousemove", state.moveHandler, true);
board.addEventListener("mouseleave", state.leaveHandler, true);

    window[KEY] = {
      stop,
      state
    };

if (notify) {
  ui.notifications?.info("Effect tooltip installed. Hover a token effect icon.");
}

    return true;
  }

  function restart({ notify = false } = {}) {
    stop();
    return start({ notify });
  }

  function isRunning() {
    return Boolean(window[KEY]?.state?.active);
  }

  return {
    start,
    stop,
    restart,
    isRunning
  };
})();

/* -------------------------------------------- */
/*  Hooks                                       */
/* -------------------------------------------- */

Hooks.once("ready", () => {
  const mod = game.modules.get("fabula-ultima-companion");
  if (mod) {
    mod.api = mod.api || {};
    mod.api.effectTooltip = {
      start: (options = {}) => FU_EFFECT_TOOLTIP.start(options),
      stop: () => FU_EFFECT_TOOLTIP.stop(),
      restart: (options = {}) => FU_EFFECT_TOOLTIP.restart(options),
      isRunning: () => FU_EFFECT_TOOLTIP.isRunning()
    };
  }

  // If canvas is already ready for some reason, try to start immediately.
  if (canvas?.ready) {
    FU_EFFECT_TOOLTIP.start({ notify: false });
  }
});

Hooks.on("canvasReady", () => {
  FU_EFFECT_TOOLTIP.start({ notify: false });
});

Hooks.on("canvasTearDown", () => {
  FU_EFFECT_TOOLTIP.stop();
});
