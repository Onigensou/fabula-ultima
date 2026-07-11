// ============================================================================
// Dungeon Pathing — Gathering Summary UI
//
// The animated reveal shown after a Gathering tile's checks resolve. Deliberately
// reuses the Camp Bond Summary look-and-feel: the same `oni-camp-panel` /
// `oni-bond-summary-panel` shell, `oni-bond-log-*` entry rows, sequential
// `.visible` slide-in, and the camp bond-summary SFX (CAMP.Sound / CAMP.SFX).
//
// One group per party member; within a group, one revealed row per material
// stack, plus optional Zenit and Resourceful (IP) rows. show() runs identically
// on every client (GM broadcasts the summary), so the staggered reveal + local
// sounds stay in sync. Returns a promise that resolves after the last row plays
// its hold, so the GM can then broadcast DONE and clear the tile.
//
// API:  globalThis.ONI.GatheringSummaryUI.show(summary) -> Promise<void>
//       globalThis.ONI.GatheringSummaryUI.hide()
//   summary: Array<{
//     actorName, tokenImg,
//     materials: Array<{ name, img, qty }>,
//     zenit: number,
//     resourceful: { sl, applied } | null,
//   }>
// ============================================================================
(() => {
  const ONI    = globalThis.ONI ??= {};
  const TAG    = "[DungeonPathing][GatheringSummaryUI]";
  const OVL_ID = "oni-gathering-summary-overlay";

  const LOG_HOLD_MS  = 1100;  // hold between revealed rows
  const POST_HOLD_MS = 3200;  // hold after last row before the flow advances

  const ZENIT_ICON = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/barg.png";
  const IP_ICON    = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/bag.png";

  const STYLE_ID = "oni-gathering-summary-style";

  const _wait = ms => new Promise(r => setTimeout(r, ms));
  const esc = s => String(s ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;");

  // Full-screen dim backdrop that centers the panel (mirrors #oni-camp-overlay).
  // campFadeIn / campFadeOut keyframes are defined globally in camp-styles.js.
  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
      #${OVL_ID} {
        position: fixed; inset: 0; z-index: 1200;
        background: rgba(18, 10, 5, 0.72);
        display: flex; align-items: center; justify-content: center;
        animation: campFadeIn .35s ease both;
      }
      #${OVL_ID}.out { animation: campFadeOut .25s ease both; }
    `;
    document.head.appendChild(s);
  }

  // Camp sound helpers (bond-summary chimes). Degrades silently if camp not loaded.
  const CAMP = () => globalThis.CampSystem ?? null;
  const playSfx = (key) => {
    const c = CAMP();
    if (c?.Sound?.play && c?.SFX?.[key]) c.Sound.play(c.SFX[key]);
  };

  // A small parchment thumbnail for item/zenit/IP rows.
  function _thumb(img, alt) {
    const isVideo = /\.(webm|mp4|ogg)(\?|$)/i.test(img ?? "");
    return isVideo
      ? `<video src="${esc(img)}" autoplay loop muted playsinline
             style="width:26px;height:26px;object-fit:contain;background:transparent;border:none;box-shadow:none;"></video>`
      : `<img src="${esc(img)}" alt="${esc(alt)}" onerror="this.src='icons/svg/item-bag.svg'"
             style="width:26px;height:26px;object-fit:contain;background:transparent;border:none;box-shadow:none;">`;
  }

  // ── Row builders (mirror bond-summary log-item markup) ──────────────────────
  function _materialRow(mat) {
    const qty = Math.max(1, Number(mat.qty ?? 1));
    return `
      <div class="oni-bond-log-item oni-bond-log-entry" data-sfx="MATERIAL">
        <span class="bse-log-icon" style="width:26px;">${_thumb(mat.img, mat.name)}</span>
        <span class="bse-log-text">Gathered <strong>${esc(mat.name)}</strong>${qty > 1 ? ` <em>×${qty}</em>` : ""}</span>
      </div>`;
  }

  function _zenitRow(amount) {
    return `
      <div class="oni-bond-log-item oni-bond-log-entry" data-sfx="ZENIT">
        <span class="bse-log-icon" style="width:26px;">${_thumb(ZENIT_ICON, "Zenit")}</span>
        <span class="bse-log-text">Found <strong>${esc(amount)}</strong> Zenit glinting in the underbrush!</span>
      </div>`;
  }

  function _resourcefulRow(res) {
    const applied = Math.max(0, Number(res?.applied ?? 0));
    const sl      = Math.max(0, Number(res?.sl ?? 0));
    const body = applied > 0
      ? `<strong>Resourceful</strong> — recovered <strong>+${applied}</strong> IP`
      : `<strong>Resourceful</strong> — inventory already full <em>(SL ${sl})</em>`;
    return `
      <div class="oni-bond-log-item oni-bond-log-entry" data-sfx="RESOURCEFUL">
        <span class="bse-log-icon" style="width:26px;">${_thumb(IP_ICON, "Inventory Points")}</span>
        <span class="bse-log-text">${body}</span>
      </div>`;
  }

  function _emptyRow() {
    return `
      <div class="oni-bond-log-item oni-bond-log-entry" data-sfx="GENERIC">
        <span class="bse-log-icon"><i class="fas fa-wind"></i></span>
        <span class="bse-log-text">Searched, but came away empty-handed.</span>
      </div>`;
  }

  function _groupHTML(g) {
    const portrait = _thumb(g.tokenImg, g.actorName);
    const rows = [];
    for (const mat of (g.materials ?? [])) rows.push(_materialRow(mat));
    if (g.zenit > 0) rows.push(_zenitRow(g.zenit));
    if (g.resourceful) rows.push(_resourcefulRow(g.resourceful));
    if (!rows.length) rows.push(_emptyRow());

    return `
      <div class="oni-bond-log-group">
        <div class="oni-bond-log-actor-header oni-bond-log-entry" data-sfx="HEADER"
             style="display:flex;align-items:center;gap:8px;">
          <span style="width:24px;height:24px;flex-shrink:0;">${portrait}</span>
          ${esc(g.actorName)}
        </div>
        ${rows.join("")}
      </div>`;
  }

  // ── SFX mapping (reuse bond-summary chimes) ─────────────────────────────────
  function _sfxKeyFor(dataSfx) {
    switch (dataSfx) {
      case "MATERIAL":    return "BOND_SUM_EMOTION_UP";
      case "ZENIT":       return "BOND_SUM_LEVEL_2";
      case "RESOURCEFUL": return "BOND_SUM_LEVEL_1";
      case "HEADER":      return "BOND_SUM_GENERIC";
      default:            return "BOND_SUM_GENERIC";
    }
  }

  // ── Overlay ─────────────────────────────────────────────────────────────────
  function _buildOverlay(summary) {
    ensureStyles();
    document.getElementById(OVL_ID)?.remove();

    const groupsHTML = (summary ?? []).length
      ? summary.map(_groupHTML).join("")
      : `<div style="font-style:italic;text-align:center;padding:20px 0;opacity:.7;">No one gathered anything.</div>`;

    const overlay = document.createElement("div");
    overlay.id = OVL_ID;
    overlay.innerHTML = `
      <div class="oni-camp-panel oni-bond-summary-panel">
        <div class="oni-camp-panel__title"><i class="fas fa-leaf"></i> Gathering</div>
        <div class="oni-camp-inner-panel panel-body">
          <div style="font-size:.82em;margin-bottom:12px;">
            The party combs the area for anything of use…
          </div>
          ${groupsHTML}
        </div>
        <hr>
        <div style="display:flex;align-items:center;justify-content:flex-end;margin-top:6px;">
          <span style="font-size:.78em;opacity:.75;">
            <i class="fas fa-seedling"></i> Gathering complete.
          </span>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    return overlay;
  }

  ONI.GatheringSummaryUI = {
    async show(summary) {
      _buildOverlay(summary);
      playSfx("BOND_SUM_ENTER");

      const entryEls = Array.from(document.querySelectorAll(`#${OVL_ID} .oni-bond-log-entry`));
      if (!entryEls.length) { await _wait(1500); return; }

      const body = document.querySelector(`#${OVL_ID} .panel-body`);
      for (let i = 0; i < entryEls.length; i++) {
        const el = entryEls[i];
        playSfx(_sfxKeyFor(el.dataset.sfx));
        el.classList.add("visible");
        if (body) body.scrollTop = body.scrollHeight;
        if (i < entryEls.length - 1) await _wait(LOG_HOLD_MS);
      }
      await _wait(POST_HOLD_MS);
    },

    hide() {
      const el = document.getElementById(OVL_ID);
      if (!el) return;
      el.classList.add("out");
      setTimeout(() => el.remove(), 280);
    },
  };

  console.debug(TAG, "Gathering Summary UI loaded.");
})();
