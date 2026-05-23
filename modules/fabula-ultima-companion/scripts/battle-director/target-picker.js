// Minimal click-to-pick target picker.
//
// Replaces the legacy jrpg-targeting-system for v1 (per "make a new copy of
// the code instead of using legacy script"). This is the bare minimum:
//   - Highlight every eligible target on the canvas
//   - Click a token to select / deselect
//   - Hit Enter to confirm, Esc to cancel
//   - Resolves with { ok, cancelled, tokenUuids }
//
// No socket plumbing — picker runs on the GM client only in v1, matching
// the Turn UI ownership model.

import { log, warn } from "./logger.js";

const STYLE_ID = "fud-targetpicker-style";

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const css = document.createElement("style");
  css.id = STYLE_ID;
  css.textContent = `
    .fud-target-ring{
      position:absolute;
      border:3px dashed #7a9bb6;
      border-radius:50%;
      box-shadow:0 0 10px rgba(122,155,182,.6), inset 0 0 10px rgba(122,155,182,.3);
      pointer-events:none;
      z-index:30;
      transition:filter 100ms ease, border-color 100ms ease;
    }
    .fud-target-ring.is-hover{ filter:brightness(1.3); border-color:#a8c4d8; }
    .fud-target-ring.is-selected{ border-style:solid; border-color:#ffcc44; box-shadow:0 0 14px rgba(255,204,68,.8), inset 0 0 14px rgba(255,204,68,.3); }
    .fud-target-banner{
      position:fixed; left:50%; top:18%; transform:translate(-50%, 0);
      padding:10px 22px; border-radius:14px;
      background:linear-gradient(180deg,#f6f1e6,#ebe3d0);
      border:2px solid #5a6a85;
      box-shadow:0 4px 0 rgba(24,28,41,.55), 0 0 0 1px rgba(255,255,255,.7) inset;
      font-family:"Inter","Segoe UI",system-ui,sans-serif;
      font-weight:800; letter-spacing:.32px; text-transform:uppercase;
      color:#3a3228; z-index:9999; pointer-events:none;
      text-align:center;
    }
    .fud-target-banner .director-pip{ color:#5a6a85; opacity:.85; font-size:10px; letter-spacing:.5px; display:block; margin-top:2px;}
  `;
  document.head.appendChild(css);
}

function worldToClient(x, y) {
  const wt = canvas.stage.worldTransform;
  const out = new PIXI.Point();
  wt.apply({ x, y }, out);
  const rect = canvas.app.view.getBoundingClientRect();
  return { x: rect.left + out.x, y: rect.top + out.y };
}

// `eligible` is the snapshotEligibleTargets() output.
// Returns Promise<{ ok, cancelled, tokenUuids }>.
// `opts.mode`: "exact" or "up_to" (default "exact")
// `opts.count`: number of targets required/maximum (default 1)
// `opts.titleText`: banner text override
export function requestTargeting({ director, eligible, mode = "exact", count = 1, titleText = null } = {}) {
  if (!game.user?.isGM) {
    return Promise.resolve({ ok: false, cancelled: true, tokenUuids: [], reason: "non-GM client" });
  }
  if (!Array.isArray(eligible) || eligible.length === 0) {
    return Promise.resolve({ ok: false, cancelled: false, tokenUuids: [], reason: "no eligible targets" });
  }
  ensureStyles();

  return new Promise((resolve) => {
    // Build canvas-positioned rings around each eligible token.
    const rings = new Map(); // tokenUuid -> { el, token }
    const selected = new Set(); // tokenUuid

    const banner = document.createElement("div");
    banner.className = "fud-target-banner";
    document.body.appendChild(banner);

    function updateBanner() {
      const verb = mode === "up_to" ? "up to" : "";
      const label = titleText ?? `Pick ${verb ? verb + " " : ""}${count} target${count === 1 ? "" : "s"}`;
      banner.innerHTML = `<span>${label} — ${selected.size}/${count} selected — [Enter] confirm  [Esc] cancel</span><span class="director-pip">DIRECTOR TARGETING</span>`;
    }
    updateBanner();

    function positionRing(rec) {
      const t = rec.token;
      if (!t || t.destroyed) return;
      const c = t.center ?? t.getCenter?.() ?? { x: t.x + t.w / 2, y: t.y + t.h / 2 };
      const p = worldToClient(c.x, c.y);
      const sc = canvas.stage.scale?.x ?? 1;
      const w = (t.w ?? 100) * sc;
      const h = (t.h ?? 100) * sc;
      const size = Math.max(w, h) * 1.05;
      rec.el.style.left = `${p.x - size / 2}px`;
      rec.el.style.top = `${p.y - size / 2}px`;
      rec.el.style.width = `${size}px`;
      rec.el.style.height = `${size}px`;
    }

    function repositionAll() {
      for (const rec of rings.values()) positionRing(rec);
    }

    function buildRings() {
      for (const e of eligible) {
        const token = canvas?.tokens?.get(e.tokenId);
        if (!token) continue;
        const ring = document.createElement("div");
        ring.className = "fud-target-ring";
        document.body.appendChild(ring);
        const rec = { el: ring, token, tokenUuid: e.tokenUuid };
        rings.set(e.tokenUuid, rec);
        positionRing(rec);
        // pointer-events on the ring itself stay none, so click goes through to
        // the token. We track clicks via a global canvas listener instead.
      }
    }

    function setHover(tokenUuid, on) {
      const rec = rings.get(tokenUuid);
      if (!rec) return;
      rec.el.classList.toggle("is-hover", on);
    }

    function setSelected(tokenUuid, on) {
      const rec = rings.get(tokenUuid);
      if (!rec) return;
      rec.el.classList.toggle("is-selected", on);
    }

    function onTokenHover(token, hovered) {
      const uuid = token?.document?.uuid;
      if (!uuid || !rings.has(uuid)) return;
      setHover(uuid, !!hovered);
    }

    function onTokenClick(_event, token) {
      const uuid = token?.document?.uuid;
      if (!uuid || !rings.has(uuid)) return;
      if (selected.has(uuid)) {
        selected.delete(uuid);
        setSelected(uuid, false);
      } else {
        if (selected.size >= count && mode === "exact") {
          // Replace the oldest selection
          const firstUuid = selected.values().next().value;
          selected.delete(firstUuid);
          setSelected(firstUuid, false);
        } else if (selected.size >= count) {
          return; // up_to: don't add beyond max
        }
        selected.add(uuid);
        setSelected(uuid, true);
      }
      updateBanner();
    }

    function onKey(e) {
      if (e.key === "Escape") {
        e.preventDefault(); e.stopPropagation();
        finish({ ok: false, cancelled: true, tokenUuids: [] });
      } else if (e.key === "Enter") {
        e.preventDefault(); e.stopPropagation();
        if (mode === "exact" && selected.size !== count) {
          ui.notifications?.warn(`Pick exactly ${count} target${count === 1 ? "" : "s"}.`);
          return;
        }
        if (mode === "up_to" && selected.size < 1) {
          ui.notifications?.warn("Pick at least 1 target.");
          return;
        }
        finish({ ok: true, cancelled: false, tokenUuids: Array.from(selected) });
      }
    }

    // Wire hooks via the director's HookRegistry so cleanup is guaranteed.
    const hH = director.hooks.on("hoverToken", onTokenHover, { label: "tp:hoverToken" });
    const hP = director.hooks.on("canvasPan", repositionAll, { label: "tp:canvasPan" });
    const hU = director.hooks.on("updateToken", repositionAll, { label: "tp:updateToken" });
    const hD = director.hooks.on("preDeleteToken", (_scene, doc) => {
      const uuid = doc?.uuid;
      if (uuid && rings.has(uuid)) {
        const rec = rings.get(uuid);
        try { rec.el.remove(); } catch {}
        rings.delete(uuid);
        if (selected.has(uuid)) selected.delete(uuid);
        updateBanner();
      }
    }, { label: "tp:preDeleteToken" });

    // Token click via libWrapper-style — fall back to canvas pointer event.
    // For v1 we use the Foundry hook "clickToken" if available; otherwise
    // we intercept the canvas pointerdown and resolve tokens via canvas API.
    const handlerClick = (event) => {
      try {
        const rect = canvas?.app?.view?.getBoundingClientRect?.();
        const transform = canvas?.stage?.worldTransform;
        if (!rect || !transform) return;
        const local = transform.applyInverse({
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
        });
        const hit = canvas?.tokens?.placeables?.find?.((tok) => {
          const b = tok?.bounds;
          if (!b) return false;
          return local.x >= b.x && local.x <= b.x + b.width && local.y >= b.y && local.y <= b.y + b.height;
        });
        if (hit) {
          event.preventDefault?.();
          event.stopPropagation?.();
          onTokenClick(event, hit);
        }
      } catch (e) {
        warn("target picker pointerdown threw", e);
      }
    };
    canvas.app.view.addEventListener("pointerdown", handlerClick, true);
    window.addEventListener("keydown", onKey, true);

    buildRings();
    repositionAll();

    function finish(result) {
      try { window.removeEventListener("keydown", onKey, true); } catch {}
      try { canvas.app.view.removeEventListener("pointerdown", handlerClick, true); } catch {}
      try { banner.remove(); } catch {}
      for (const rec of rings.values()) { try { rec.el.remove(); } catch {} }
      rings.clear();
      // Hooks owned by HookRegistry — caller's director.hooks.disposeAll
      // handles them. But these are per-call so off them now.
      try { director.hooks.off(hH); } catch {}
      try { director.hooks.off(hP); } catch {}
      try { director.hooks.off(hU); } catch {}
      try { director.hooks.off(hD); } catch {}
      log("Target picker resolved:", result);
      resolve(result);
    }
  });
}
