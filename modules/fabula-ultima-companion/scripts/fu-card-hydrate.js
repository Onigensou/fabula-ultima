// scripts/fu-card-hydrate.js — Foundry VTT v12
// Hydrates FU chat cards so tooltips, collapses, roll-ups, and per-user
// button visibility work locally for everyone — without touching other apps.

(() => {
  const MODULE_NS = "fabula-ultima-companion";
  const TT_ID = "fu-global-tooltip";

  // ---------- 1) One-time global delegated UI (idempotent & chat-scoped) ----------
  function installGlobalUIOnce() {
    if (window.__fuCardUIBound) return;
    window.__fuCardUIBound = true;

    // Tooltip node
    let tipEl = document.getElementById(TT_ID);
    if (!tipEl) {
      tipEl = document.createElement("div");
      tipEl.id = TT_ID;
      Object.assign(tipEl.style, {
        position: "fixed", zIndex: "2147483647", display: "none",
        background: "rgba(0,0,0,.90)", color: "#fff", padding: ".45rem .6rem",
        borderRadius: "6px", fontSize: "12px", maxWidth: "320px",
        pointerEvents: "none", boxShadow: "0 2px 8px rgba(0,0,0,.4)",
        border: "1px solid rgba(255,255,255,.15)", textAlign: "left",
        whiteSpace: "pre-wrap"
      });
      document.body.appendChild(tipEl);
      
     // Inject once: effect preview CSS (black text + fade overlay support)
if (!document.getElementById("fu-effect-preview-css-v2")) {
  const style = document.createElement("style");
  style.id = "fu-effect-preview-css-v2";
  style.textContent = `
  /* Keep regular body text black */
.chat-message .message-content .fu-effect .fu-effect-inner {
  color: #000;              /* no !important */
  text-shadow: none;        /* no !important */
}
/* Do NOT recolor content-links; let your Custom CSS handle them */
.chat-message .message-content .fu-effect .fu-effect-inner a.content-link,
.chat-message .message-content .fu-effect .fu-effect-inner a.content-link * {
  color: inherit;           /* external !important colors (e.g., Bolt) win */
  text-shadow: none;
}
 /* Ensure headers keep their themed color even if old styles linger */
.fu-effect > .fu-effect-header,
.fu-effect > .oni-collapsible__header,
.fu-effect .fu-effect-title {
  color: inherit !important;
}
  .fu-effect-body {
    will-change: max-height;
    max-height: 0;
    overflow: hidden;
    transition: max-height .28s ease, padding .28s ease;
    position: relative;
    padding: 0 .25rem;
    margin-top: .05rem;
  }
  .fu-effect-body.preview .fu-fade {
    position: absolute;
    left: 0; right: 0; bottom: 0;
    height: var(--fade-height, 2.2em);
    pointer-events: none;
    z-index: 1;
    background: var(--fade-overlay,
      linear-gradient(to bottom,
        rgba(217,215,203,0) 0%,
        rgba(217,215,203,0.85) 65%,
        rgba(217,215,203,1) 100%)
    );
    display: block;
  }
  .fu-effect-hint { opacity:.7; font-size:12px; margin-left:.35rem; }
  .fu-effect[data-collapsed="false"] .fu-effect-hint { opacity:.9; }
  `;
  document.head.appendChild(style);
}
    }

    const TIP_MARGIN = 10, CURSOR_GAP = 12;

    // Only react to events that happen inside chat (main log or chat popouts)
    const inChatScope = (evOrEl) => {
      const el = evOrEl?.target ?? evOrEl;
      return !!el?.closest?.("#chat-log, .chat-popout, .app.chat-popout");
    };

    const placeTipAt = (x,y) => {
      const vw = innerWidth, vh = innerHeight, r = tipEl.getBoundingClientRect();
      let tx = x + CURSOR_GAP, ty = y + CURSOR_GAP;
      if (tx + r.width + TIP_MARGIN > vw) tx = x - r.width - CURSOR_GAP;
      if (tx < TIP_MARGIN) tx = TIP_MARGIN;
      if (ty + r.height + TIP_MARGIN > vh) ty = y - r.height - CURSOR_GAP;
      if (ty < TIP_MARGIN) ty = TIP_MARGIN;
      tipEl.style.left = `${tx}px`; tipEl.style.top = `${ty}px`;
    };
    const showTip = (html,x,y)=>{ tipEl.style.visibility="hidden"; tipEl.style.display="block"; tipEl.innerHTML=html; placeTipAt(x,y); tipEl.style.visibility="visible"; };
    const hideTip = ()=>{ tipEl.style.display="none"; };

    // Delegated tooltip — chat-scoped
    document.addEventListener("mouseover", (ev) => {
      if (!inChatScope(ev)) return;
      const host = ev.target.closest?.(".fu-tip-host");
      if (!host) return;
      const html = decodeURIComponent(host.getAttribute("data-tip") || "");
      showTip(html, ev.clientX, ev.clientY);
      function mouseMoveFollower(e){ placeTipAt(e.clientX, e.clientY); }
      document.addEventListener("mousemove", mouseMoveFollower);
      host.addEventListener("mouseout", function onOut() {
        hideTip();
        document.removeEventListener("mousemove", mouseMoveFollower);
        host.removeEventListener("mouseout", onOut);
      }, { once:true });
    });

    // Delegated content-link opening — chat-scoped
    document.addEventListener("click", async (ev) => {
      if (!inChatScope(ev)) return; // only hijack content-link clicks inside chat
      const a = ev.target.closest?.("a.content-link[data-doc-uuid],a.content-link[data-uuid]");
      if (!a) return;
      ev.preventDefault(); ev.stopPropagation();
      const uuid = a.dataset.docUuid || a.dataset.uuid;
      if (!uuid) return;
      try {
        if (globalThis.Hotbar?.toggleDocumentSheet) {
          await Hotbar.toggleDocumentSheet(uuid);
        } else {
          const doc = await fromUuid(uuid);
          doc?.sheet?.render(true);
        }
      } catch {
        try { const doc = await fromUuid(uuid); doc?.sheet?.render(true); }
        catch { ui.notifications?.error("Could not open linked document."); }
      }
    });

    // Delegated Effect toggle — chat-scoped (uses per-card preview sizing)
document.addEventListener("click", (ev) => {
  if (!inChatScope(ev)) return;
  const eff = ev.target.closest?.(".fu-effect");
  if (!eff) return;
  if (ev.target.closest("a")) return; // allow links inside

  const body = eff.querySelector(".fu-effect-body");
  const hint = eff.querySelector(".fu-effect-hint");
  const fade = eff.querySelector(".fu-fade");
  if (!body) return;

  const previewPx = Number(body.dataset.previewPx || 0) || 0;
  const collapsed = eff.dataset.collapsed !== "false";

  if (collapsed) {
    // Expand
    eff.dataset.collapsed = "false";
    if (hint) hint.textContent = "(click to collapse)";
    if (!body.style.maxHeight || body.style.maxHeight === "none") {
      body.style.maxHeight = body.scrollHeight + "px";
      body.getBoundingClientRect();
    }
    body.classList.remove("preview");
    if (fade) fade.style.display = "none";
    body.style.paddingTop = ".25rem";
    body.style.paddingBottom = ".25rem";
    body.style.maxHeight = body.scrollHeight + "px";
    const onEnd = (e) => {
      if (e.propertyName !== "max-height") return;
      body.style.maxHeight = "none";
      body.removeEventListener("transitionend", onEnd);
    };
    body.addEventListener("transitionend", onEnd);
  } else {
    // Collapse
    eff.dataset.collapsed = "true";
    if (hint) hint.textContent = "(click to expand)";
    if (!body.style.maxHeight || body.style.maxHeight === "none") {
      body.style.maxHeight = body.scrollHeight + "px";
      body.getBoundingClientRect();
    }
    body.classList.add("preview");
    body.style.paddingTop = "0";
    body.style.paddingBottom = "0";
    body.style.maxHeight = `${Math.max(0, previewPx)}px`;
    queueMicrotask(() => { if (fade) fade.style.display = "block"; });
  }
});

    // Roll-up numbers animation for any .fu-rollnum that appears
    const reduceMotion = matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    const clamp=(n,a,b)=>Math.min(Math.max(n,a),b);
    const fmt=(n)=>n.toLocaleString?.() ?? String(n);
    const easeOutCubic=t=>1-Math.pow(1-t,3);
    function animateRollNumber(el) {
      if (!el || el.__rolled) return;
      el.__rolled = true;
      const final = Number(el.dataset.final || "0");
      const start = Math.min(1, final>0?1:0);
      if (!Number.isFinite(final) || final <= 0 || reduceMotion) { el.textContent = fmt(final); return; }
      const dur = clamp(800, 500, 900);
      const t0 = performance.now();
      function frame(now){
        const p = clamp((now - t0)/dur, 0, 1);
        const v = Math.max(start, Math.floor(start + (final - start) * easeOutCubic(p)));
        el.textContent = fmt(v);
        if (p < 1) requestAnimationFrame(frame);
        else el.textContent = fmt(final);
      }
      requestAnimationFrame(frame);
    }

    // ---- Observe chat for new .fu-rollnum (support main chat + any popouts) ----
    const io = "IntersectionObserver" in window
      ? new IntersectionObserver((ents, obs) => {
          for (const e of ents) if (e.isIntersecting) { animateRollNumber(e.target); obs.unobserve(e.target); }
        }, { threshold: 0.1 })
      : null;

    // FIX #1: Kick existing nodes now — query .fu-rollnum directly (not "#chat-log .fu-rollnum")
    document.querySelectorAll(".fu-rollnum")
      .forEach(n => io ? io.observe(n) : animateRollNumber(n));

    // Attach MutationObservers to all chat roots available now
    const roots = [
      document.getElementById("chat-log"),
      ...Array.from(document.querySelectorAll(".chat-popout, .app.chat-popout"))
    ].filter(Boolean);

    // FIX #2: If no root found (edge cases), fall back to document.body
    if (!roots.length) roots.push(document.body);

    for (const chatRoot of roots) {
      const mo = new MutationObserver((muts)=>{
        for (const m of muts) {
          m.addedNodes?.forEach?.(node => {
            if (!(node instanceof HTMLElement)) return;
            node.querySelectorAll?.(".fu-rollnum")
              .forEach(n => io ? io.observe(n) : animateRollNumber(n));
          });
        }
      });
      mo.observe(chatRoot, { childList:true, subtree:true });
    }

    // Clean tooltip when a message closes (works for main & popouts)
    Hooks.on("closeChatMessage", () => {
      const t=document.getElementById(TT_ID);
      if (t) t.style.display="none";
    });
  }

  // ---------- 2) Per-message hydration & per-client visibility ----------
  async function hydratePerClient(chatMsg, htmlJQ) {
    // Only bother if this message has our card
    const root = htmlJQ?.[0];
    if (!root) return;
    const card = root.querySelector?.(".fu-card");
    if (!card) return;

    // Hide GM-only Apply button for non-GMs (local, per-client)
    if (!game.user?.isGM) {
      root.querySelectorAll("[data-gm-only]").forEach(el => el.style.display = "none");
    }

    // ------------------------------------------------------------
    // Confirm state hydration (fix for GM button "reset" on re-render)
    // ------------------------------------------------------------
    // Foundry re-renders chat messages when flags update. If we only
    // grey-out the Confirm button via DOM mutation, a re-render will
    // recreate the original yellow button. So we re-apply the confirmed
    // UI on EVERY render based on the message flag.
    try {
      const applied = await chatMsg.getFlag(MODULE_NS, "actionApplied");
      if (applied) {
        const btn = root.querySelector?.("[data-fu-confirm]");
        if (btn) {
          btn.disabled = true;
          btn.textContent = "Confirmed ✔";
          btn.style.filter = "grayscale(1)";
          btn.dataset.fuLock = "1";
        }

        const stamp = root.querySelector?.("[data-fu-stamp]");
        if (stamp) {
          const byName = game.users?.get(applied?.by)?.name ?? "GM";
          stamp.textContent = `Confirmed by: ${byName}`;
          stamp.style.opacity = ".9";
        }
      }
    } catch (e) {
      console.warn("[fu-card-hydrate] actionApplied hydration failed:", e);
    }



// Gate owner-only buttons (Confirm / Invoke) using the saved payload on the message
let canAct = false;
try {
  const saved = await chatMsg.getFlag(MODULE_NS, "actionCard");
  const payload = saved?.payload ?? null;

  const attackerUuid = payload?.meta?.attackerUuid || payload?.core?.attackerUuid || null;
  const ownerUserId  = payload?.meta?.ownerUserId ?? null;

  if (game.user?.isGM) canAct = true;
  else if (ownerUserId && ownerUserId === game.userId) canAct = true;
  else if (attackerUuid) {
    const doc = await fromUuid(attackerUuid).catch(()=>null);
    const actor =
      doc?.actor ??
      (doc?.documentName === "Actor" ? doc : null) ??
      (doc?.documentName === "Token" ? doc.actor : null) ??
      (doc?.documentName === "TokenDocument" ? doc.actor : null);

    canAct = !!actor?.isOwner;
  }
} catch (err) {
  console.warn("[fu-card-hydrate] Could not resolve attacker ownership:", err);
}

if (!canAct) {
  root.querySelectorAll("[data-fu-confirm],[data-fu-trait],[data-fu-bond]").forEach(el => el.style.display = "none");
}

    // Initialize the Effect preview once for this message
    initEffectPreviewOnce(root);

  }

  // ---------- Half-open Effect preview init (idempotent per message) ----------
function initEffectPreviewOnce(root) {
  if (!root || root.dataset.fuEffectInit === "1") return;

  try {
    const eff   = root.querySelector(".fu-effect");
    const body  = eff?.querySelector(".fu-effect-body");
    const inner = eff?.querySelector(".fu-effect-inner");
    const hint  = eff?.querySelector(".fu-effect-hint");
    let   fade  = eff?.querySelector(".fu-fade");

    if (!eff || !body || !inner) return; // no effect section present

    // Ensure a fade child exists
    if (!fade) {
      fade = document.createElement("div");
      fade.className = "fu-fade";
      fade.setAttribute("aria-hidden", "true");
      Object.assign(fade.style, {
        position: "absolute", left: "0", right: "0", bottom: "0",
        zIndex: "1", pointerEvents: "none", display: "none",
        height: "32px", background: "transparent"
      });
      body.appendChild(fade);
    }

    // Compute ~5 lines worth of height for preview
    const PREVIEW_LINES = 8;
    const cs = getComputedStyle(inner);
    const lineH = parseFloat(cs.lineHeight) || 16;
    const padT  = parseFloat(cs.paddingTop) || 0;
    const padB  = parseFloat(cs.paddingBottom) || 0;
    const previewPx = Math.round(lineH * PREVIEW_LINES + padT + padB);
    body.dataset.previewPx = String(previewPx);

    // Build a background-matched gradient for the fade
    const msgContent = root.querySelector(".message-content") || root;
    let bg = getComputedStyle(msgContent).backgroundColor || "rgb(217, 215, 203)";
    if (bg === "rgba(0, 0, 0, 0)" || bg === "transparent") bg = "rgb(217, 215, 203)";

    const toRgba = (alpha) => {
      const m = bg.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*[\d.]+)?\s*\)/i);
      if (m) return `rgba(${m[1]},${m[2]},${m[3]},${alpha})`;
      const hex = bg.match(/^#([0-9a-f]{6})$/i);
      if (hex) {
        const r = parseInt(hex[1].slice(0,2),16),
              g = parseInt(hex[1].slice(2,4),16),
              b = parseInt(hex[1].slice(4,6),16);
        return `rgba(${r},${g},${b},${alpha})`;
      }
      return `rgba(217,215,203,${alpha})`;
    };

    const fadeOverlay = `linear-gradient(to bottom,
      ${toRgba(0)} 0%,
      ${toRgba(0.85)} 65%,
      ${toRgba(1)} 100%)`;
    const fadeHeight = Math.round(lineH * 2);

    // Default collapsed state with preview + fade
    eff.dataset.collapsed = "true";
    body.classList.add("preview");
    body.style.maxHeight = `${previewPx}px`;
    body.style.paddingTop = "0";
    body.style.paddingBottom = "0";
    fade.style.display = "block";
    fade.style.height = `${fadeHeight}px`;
    fade.style.background = fadeOverlay;

    if (hint) hint.textContent = "(click to expand)";

    // Mark done
    root.dataset.fuEffectInit = "1";
  } catch (e) {
    console.warn("[fu-card-hydrate] Effect preview init failed:", e);
  }
}

  // ---------- Hooks ----------
  Hooks.once("ready", () => {
  installGlobalUIOnce();
  // Try initializing any existing messages already in the DOM (e.g., after refresh)
  document.querySelectorAll(".chat-message").forEach(msg => {
    initEffectPreviewOnce(msg);
  });
});

  Hooks.on("renderChatMessage", async (chatMsg, html /*, data */) => {
    // Ensure global UI is present (covers late loads or popouts)
    installGlobalUIOnce();
    hydratePerClient(chatMsg, html);
  });
})();
