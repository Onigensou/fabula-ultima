// ============================================================================
// Out-of-Combat Healing — HUD controller (local, single instance).
//
// A JRPG-style overworld heal menu. Left panel = healing actions in Skill /
// Spell / Item tabs; right panel = a 2×2 party panel showing each member's
// HP / MP / IP. The player picks an action ("arms" it), targets a member, and
// confirms — the heal is applied (GM-mediated) and the HUD STAYS armed for
// repeat healing until cancelled out.
//
// Controls (mouse + keyboard):
//   LIST zone:    ↑/↓ move • ←/→ (or Q/E/Tab) switch tab • Z arm action • X exit
//   TARGET zone:  ↑/↓/←/→ pick member • Z confirm heal (stays armed) • X back
//   Click:        tabs, rows, party cells, and the × button all work directly.
//
// Local-only: only the operator sees the HUD. Resource changes are real
// GM-applied actor updates, so the panel bars also refresh live (updateActor
// hook) if numbers change underneath.
// ============================================================================

import { HEAL_TAG, HEAL_CATEGORY, HEAL_KEYS, HEAL_RESOURCE, HEAL_CURSOR_SRC, HEAL_TUNE, tuneVars, playHealSfx } from "./healing-const.js";
import { injectHealingStyles } from "./healing-hud-styles.js";
import { gatherHealingActions } from "./healing-actions.js";
import { requestApply, broadcastHealFeedback } from "./healing-socket.js";
import { actorDebuffs } from "./healing-cleanse.js";

const CATEGORY_ORDER = [HEAL_CATEGORY.SKILL, HEAL_CATEGORY.SPELL, HEAL_CATEGORY.ITEM, HEAL_CATEGORY.CREATE];

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}
function keyMatch(ev, list) { return list.includes(ev.key); }

const HealingHUD = {
  _root: null,
  _caster: null,
  _members: [],           // [{actor, actorId, userId, userName}] padded conceptually
  _actions: { Skill: [], Spell: [], Item: [], Create: [] },
  _category: HEAL_CATEGORY.SKILL,
  _listIndex: 0,
  _zone: "list",          // "list" | "targets" | "debuffs"
  _armed: null,           // descriptor
  _targetIndex: 0,
  _targetMode: "single",  // "single" | "all" | "self" (from armed.targeting)
  _debuffIndex: 0,        // index within the targeted actor's debuff list (picker)
  _keyHandler: null,
  _updateHook: null,
  _refreshing: false,
  _cursorEl: null,
  _cursorReady: false,
  _extraCursors: [],      // additional feather cursors for "all" targeting
  _aeTooltipEl: null,
  _aeHooks: [],

  get isOpen() { return !!this._root; },

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  async open(opts = {}) {
    // Re-open: tear down the existing HUD instantly (no exit anim/sfx).
    if (this._root) {
      if (this._keyHandler) { window.removeEventListener("keydown", this._keyHandler, true); this._keyHandler = null; }
      if (this._updateHook) { Hooks.off("updateActor", this._updateHook); this._updateHook = null; }
      this._teardownAeHooks();
      this._clearExtraCursors();
      this._cursorEl?.remove(); this._cursorEl = null; this._cursorReady = false;
      this._aeTooltipEl?.remove(); this._aeTooltipEl = null;
      this._root.remove(); this._root = null; this._armed = null;
    }
    injectHealingStyles();

    // Resolve caster: explicit → user's assigned character → (GM fallback) first party member.
    let caster = opts.casterActor ?? null;
    if (!caster && opts.casterActorId) caster = game.actors?.get(opts.casterActorId) ?? null;
    if (!caster) caster = game.user?.character ?? null;

    // Resolve party members (the 2×2 panel).
    this._members = await this._resolveParty();
    if (!caster && game.user?.isGM) caster = this._members[0]?.actor ?? null;

    if (!caster) {
      ui.notifications?.warn("Healing: no caster actor (assign a character to your user first).");
      return;
    }
    this._caster = caster;

    if (!this._members.length) {
      ui.notifications?.warn("Healing: no party members found to heal.");
      return;
    }

    this._actions = await gatherHealingActions(caster);
    // Start on the first tab that has entries.
    this._category = CATEGORY_ORDER.find((c) => this._actions[c]?.length) ?? HEAL_CATEGORY.SKILL;
    this._listIndex = 0;
    this._zone = "list";
    this._armed = null;
    this._targetIndex = 0;

    this._build();
    this._installKeyboard();
    this._installUpdateHook();
    playHealSfx("OPEN");

    requestAnimationFrame(() => {
      this._root?.classList.add("visible");
      this._updateCursor();
    });
  },

  close() {
    if (this._keyHandler) { window.removeEventListener("keydown", this._keyHandler, true); this._keyHandler = null; }
    if (this._updateHook) { Hooks.off("updateActor", this._updateHook); this._updateHook = null; }
    const root = this._root;
    this._root = null;
    this._armed = null;
    this._teardownAeHooks();
    this._clearExtraCursors();
    this._cursorEl?.remove(); this._cursorEl = null; this._cursorReady = false;
    this._aeTooltipEl?.remove(); this._aeTooltipEl = null;
    if (!root) return;
    // Reverse of the entrance: frame slides down + fades, cells slide out
    // staggered (their inline animation-delay is reused by the closing rule).
    playHealSfx("EXIT");
    root.classList.remove("visible");
    root.classList.add("closing");
    setTimeout(() => root.remove(), 520);
  },

  async _resolveParty() {
    try {
      const party = await globalThis.CampSystem?.Party?.resolve?.();
      if (Array.isArray(party) && party.length) return party.slice(0, 4);
    } catch (e) { console.warn(HEAL_TAG, "party resolve failed", e); }
    // Fallback: the user's own character only.
    const me = game.user?.character;
    return me ? [{ actor: me, actorId: me.id, userId: game.user.id, userName: game.user.name }] : [];
  },

  // ── DOM construction ────────────────────────────────────────────────────
  _build() {
    const root = document.createElement("div");
    root.className = "oni-heal-overlay";
    root.innerHTML = `
      <div class="oni-heal-frame">
        <div class="oni-heal-header">
          <div class="title"><span class="heart">❤</span>Healing</div>
          <div class="caster">Caster: <b>${escapeHtml(this._caster.name)}</b></div>
          <div class="oni-heal-close" title="Close (X)">✕</div>
        </div>
        <div class="oni-heal-body">
          <div class="oni-heal-left">
            <div class="oni-heal-tabs"></div>
            <div class="oni-heal-list"></div>
          </div>
          <div class="oni-heal-right">
            <div class="oni-heal-banner"></div>
            <div class="oni-heal-grid"></div>
          </div>
        </div>
        <div class="oni-heal-footer">
          <span><span class="k">↑↓</span>Move</span>
          <span><span class="k">←→</span>Tab</span>
          <span><span class="k">Z</span>Confirm</span>
          <span><span class="k">X</span>Back / Close</span>
        </div>
      </div>`;
    document.body.appendChild(root);
    this._root = root;
    this.applyTune();   // push tunable layout constants → CSS vars

    // Feather cursor (same pattern as the Save/Load UI).
    this._cursorReady = false;
    this._cursorEl = document.createElement("img");
    this._cursorEl.id = "oni-heal-cursor";
    this._cursorEl.src = HEAL_CURSOR_SRC;
    document.body.appendChild(this._cursorEl);

    // Debuff tooltip element.
    this._aeTooltipEl = document.createElement("div");
    this._aeTooltipEl.id = "oni-heal-ae-tooltip";
    document.body.appendChild(this._aeTooltipEl);

    root.querySelector(".oni-heal-close").addEventListener("click", () => { this.close(); });
    // Click on the dark backdrop (outside the frame) closes.
    root.addEventListener("pointerdown", (ev) => { if (ev.target === root) this.close(); });

    // Debuff-icon hover tooltip (event delegation on the grid).
    const grid = root.querySelector(".oni-heal-grid");
    grid.addEventListener("mouseover", (ev) => {
      const icon = ev.target.closest?.(".oni-heal-debuff");
      if (!icon) return;
      const cell = icon.closest(".oni-heal-cell");
      this._showAeTooltip(Number(cell?.dataset.idx), icon.dataset.effId, ev.clientX, ev.clientY);
    });
    grid.addEventListener("mousemove", (ev) => {
      if (this._aeTooltipEl?.style.display === "block") this._placeAeTooltip(ev.clientX, ev.clientY);
    });
    grid.addEventListener("mouseout", (ev) => {
      if (ev.target.closest?.(".oni-heal-debuff")) this._hideAeTooltip();
    });
    // Click a debuff icon while in the picker → cleanse that debuff.
    grid.addEventListener("click", (ev) => {
      const icon = ev.target.closest?.(".oni-heal-debuff");
      if (!icon || this._zone !== "debuffs") return;
      const cell = icon.closest(".oni-heal-cell");
      if (Number(cell?.dataset.idx) !== this._targetIndex) return;
      const target = this._members[this._targetIndex]?.actor;
      if (target && icon.dataset.effId) this._applyCleanseOne(target, icon.dataset.effId);
    });

    this._renderTabs();
    this._renderList();
    this._renderParty(true);   // staggered intro
    this._renderBanner();
  },

  _renderTabs() {
    const tabsEl = this._root.querySelector(".oni-heal-tabs");
    tabsEl.innerHTML = "";
    for (const cat of CATEGORY_ORDER) {
      const count = this._actions[cat]?.length ?? 0;
      const tab = document.createElement("div");
      tab.className = "oni-heal-tab" + (cat === this._category ? " active" : "");
      tab.innerHTML = `${escapeHtml(cat)}<span class="count">${count}</span>`;
      tab.addEventListener("click", () => { this._switchTab(cat); });
      tabsEl.appendChild(tab);
    }
  },

  _renderList() {
    const listEl = this._root.querySelector(".oni-heal-list");
    listEl.innerHTML = "";
    const rows = this._actions[this._category] ?? [];
    if (!rows.length) {
      const empty = document.createElement("div");
      empty.className = "oni-heal-empty";
      empty.textContent = `No ${this._category.toLowerCase()} heals available.`;
      listEl.appendChild(empty);
      if (this._zone === "list") this._updateCursor();
      return;
    }
    if (this._listIndex >= rows.length) this._listIndex = rows.length - 1;
    rows.forEach((desc, i) => {
      const row = document.createElement("div");
      row.className = "oni-heal-row"
        + (i === this._listIndex && this._zone === "list" ? " sel" : "")
        + (desc.affordable ? "" : " disabled");
      const srcTag = desc.source !== "actor" ? `<span class="src-tag" title="${escapeHtml(desc.sourceItemName ?? "")}">⚔</span>` : "";
      const qty = desc.quantity != null ? ` ·x${desc.quantity}` : "";
      row.innerHTML = `
        <img src="${escapeHtml(desc.img)}" />
        <div class="meta">
          <div class="name">${srcTag}${escapeHtml(desc.name)}</div>
          <div class="sub">${escapeHtml(desc.skillTarget || desc.descriptionText || "")}</div>
        </div>
        <div class="badges">
          <div class="heal-badge">${escapeHtml(desc.healLabel)}</div>
          <div class="cost-badge">${escapeHtml(desc.costLabel)}${qty}</div>
        </div>`;
      row.addEventListener("click", () => {
        // Toggle: clicking the already-armed action disarms it (mouse parity
        // with the keyboard X-to-cancel behaviour).
        if (this._armed && this._armed.effectItemUuid === desc.effectItemUuid) { this._disarm(); return; }
        this._listIndex = i; this._renderList();
        this._armAction();
      });
      listEl.appendChild(row);
    });
    if (this._zone === "list") this._updateCursor();
  },

  // Battle-sprite (transparent) with token fallback. Animated .webm sprites
  // render as a looping muted <video>; everything else as <img>.
  _spriteHtml(actor) {
    const battle = actor.system?.props?.sprite_battle;
    const token = actor.prototypeToken?.texture?.src || actor.token?.texture?.src || actor.img;
    const src = (typeof battle === "string" && battle.trim()) ? battle.trim() : (token || "icons/svg/mystery-man.svg");
    const safe = escapeHtml(src);
    if (/\.webm(\?.*)?$/i.test(src)) {
      return `<video class="oni-heal-sprite" src="${safe}" autoplay loop muted playsinline disablepictureinpicture></video>`;
    }
    return `<img class="oni-heal-sprite" src="${safe}" />`;
  },

  _renderParty(intro = false) {
    const gridEl = this._root.querySelector(".oni-heal-grid");
    gridEl.innerHTML = "";
    for (let i = 0; i < 4; i++) {
      const entry = this._members[i] ?? null;
      const cell = document.createElement("div");
      const dimFull = entry && this._armed && !this._canBenefit(entry.actor, this._armed);
      cell.className = "oni-heal-cell" + (entry ? "" : " empty")
        + (entry && i === this._targetIndex && this._zone === "targets" ? " sel targeting" : "")
        + (dimFull ? " dim-full" : "")
        + (intro && entry ? " intro-cell" : "");
      cell.dataset.idx = String(i);
      cell.style.animationDelay = `${i * 70}ms`;   // stagger (reused on exit)
      if (!entry) { cell.innerHTML = `<div class="pc-name" style="opacity:.5">—</div>`; gridEl.appendChild(cell); continue; }
      const a = entry.actor;
      cell.innerHTML = `
        <div class="flash"></div>
        <div class="oni-heal-sprite-wrap">${this._spriteHtml(a)}</div>
        <div class="pc-info">
          <div class="pc-name">${escapeHtml(a.name)}</div>
          ${this._resHtml(a, "hp")}
          ${this._resHtml(a, "mp")}
          ${this._resHtml(a, "ip")}
          <div class="oni-heal-debuffs">${this._debuffsHtml(a)}</div>
        </div>`;
      cell.addEventListener("click", () => {
        if (!this._armed) { return; }   // must arm an action first
        if (this._zone === "debuffs") return;   // debuff icons handle their own clicks
        if (this._targetMode === "all") { this._onConfirmTargets(); return; }
        this._targetIndex = i; this._updateCellStates();
        this._onConfirmTargets();
      });
      gridEl.appendChild(cell);
    }
    this._updateCursor();
  },

  // Update only the selection / dim classes on existing cells — does NOT rebuild
  // innerHTML, so the battle-sprite <video>s never reload (no blink on navigate).
  // In "all" targeting every benefiting cell shows as targeted.
  _updateCellStates() {
    const inTargets = this._zone === "targets" || this._zone === "debuffs";
    const cells = this._root?.querySelectorAll(".oni-heal-cell") ?? [];
    cells.forEach((cell) => {
      const i = Number(cell.dataset.idx);
      const entry = this._members[i] ?? null;
      const canBenefit = !!entry && (!this._armed || this._canBenefit(entry.actor, this._armed));
      const targeting = !!entry && inTargets && !!this._armed
        && (this._targetMode === "all" ? canBenefit : i === this._targetIndex);
      const dimFull = !!entry && !!this._armed && !canBenefit;
      cell.classList.toggle("sel", targeting);
      cell.classList.toggle("targeting", targeting);
      cell.classList.toggle("dim-full", dimFull);
    });
    this._updateCursor();
  },

  // Update only the resource readout text (after a heal / actor update).
  _updateResources() {
    const cells = this._root?.querySelectorAll(".oni-heal-cell") ?? [];
    cells.forEach((cell) => {
      const i = Number(cell.dataset.idx);
      const a = this._members[i]?.actor;
      if (!a) return;
      for (const key of ["hp", "mp", "ip"]) {
        const def = HEAL_RESOURCE[key];
        const cur = Number(a.system?.props?.[def.cur] ?? 0) || 0;
        const max = Number(a.system?.props?.[def.max] ?? 0) || 0;
        const el = cell.querySelector(`.oni-heal-res.${key} .rval`);
        if (el) el.textContent = `${cur} / ${max}`;
      }
    });
  },

  // Would this action actually restore anything on this target? True if any of
  // the action's grant resources is below the target's max. Drives both the
  // confirm gate and the dimmed "can't benefit" cell styling.
  _canBenefit(actor, desc) {
    if (desc?.kind === "cleanse") return this._actorDebuffs(actor).length > 0;   // needs a debuff to remove
    const grants = desc?.grants ?? [];
    if (!grants.length) return false;
    return grants.some((g) => {
      const def = HEAL_RESOURCE[g.resource];
      if (!def) return false;
      const cur = Number(actor.system?.props?.[def.cur] ?? 0) || 0;
      const max = Number(actor.system?.props?.[def.max] ?? 0) || 0;
      return cur < max;
    });
  },

  _resHtml(actor, key) {
    const def = HEAL_RESOURCE[key];
    const cur = Number(actor.system?.props?.[def.cur] ?? 0) || 0;
    const max = Number(actor.system?.props?.[def.max] ?? 0) || 0;
    return `
      <div class="oni-heal-res ${key}" data-res="${key}">
        <span class="rlabel">${def.label}</span>
        <span class="rval">${cur} / ${max}</span>
      </div>`;
  },

  _actorDebuffs(actor) { return actorDebuffs(actor); },

  // Icon-only row of the actor's debuff effects (empty placeholder when none).
  _debuffsHtml(actor) {
    const debuffs = this._actorDebuffs(actor);
    if (!debuffs.length) return "";   // blank row when no debuffs
    return debuffs.map((e) => {
      const img = e.img || e.icon || "icons/svg/downgrade.svg";
      return `<img class="oni-heal-debuff" data-eff-id="${escapeHtml(e.id)}" src="${escapeHtml(img)}" />`;
    }).join("");
  },

  // Rebuild only the debuff rows (no sprite touch) — called on AE create/delete/update.
  // While the picker is open, highlight the selected debuff icon on the target cell.
  _updateDebuffs() {
    const cells = this._root?.querySelectorAll(".oni-heal-cell") ?? [];
    cells.forEach((cell) => {
      const i = Number(cell.dataset.idx);
      const a = this._members[i]?.actor;
      const row = cell.querySelector(".oni-heal-debuffs");
      if (!a || !row) return;
      row.innerHTML = this._debuffsHtml(a);
      if (this._zone === "debuffs" && i === this._targetIndex) {
        const icons = row.querySelectorAll(".oni-heal-debuff");
        icons[this._debuffIndex]?.classList.add("picker-sel");
      }
    });
  },

  // ── Debuff tooltip (follows cursor; mirrors active-effect-tooltip) ──────────
  _showAeTooltip(actorIdx, effId, clientX, clientY) {
    const a = this._members[actorIdx]?.actor;
    const eff = a?.effects?.get?.(effId) ?? this._actorDebuffs(a).find((e) => e.id === effId);
    if (!eff || !this._aeTooltipEl) return;
    let desc = eff.description ?? eff.system?.description ?? "";
    if (typeof desc === "object") desc = desc?.value ?? "";
    this._aeTooltipEl.innerHTML = `
      <div class="tt-title">${escapeHtml(eff.name ?? "Effect")}</div>
      <div class="tt-body">${desc || "<em>(no description)</em>"}</div>`;
    this._aeTooltipEl.style.display = "block";
    this._placeAeTooltip(clientX, clientY);
  },

  _placeAeTooltip(x, y) {
    const el = this._aeTooltipEl;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let left = x + 16, top = y + 16;
    if (left + r.width + 14 > window.innerWidth) left = x - r.width - 16;
    if (top + r.height + 14 > window.innerHeight) top = y - r.height - 16;
    el.style.left = `${Math.max(8, left)}px`;
    el.style.top = `${Math.max(8, top)}px`;
  },

  _hideAeTooltip() { if (this._aeTooltipEl) this._aeTooltipEl.style.display = "none"; },

  // Feather cursor — points at the focused element (selected list row, or the
  // targeted party cell). Same mechanism as the Save/Load UI: position via
  // getBoundingClientRect, smooth transition, float animation, no-anim first show.
  _placeCursorAt(el, rect) {
    const x = rect.right, y = rect.bottom;
    if (!this._cursorReady) {
      el.classList.add("no-anim"); el.style.left = `${x}px`; el.style.top = `${y}px`; el.classList.add("is-visible");
      requestAnimationFrame(() => el?.classList.remove("no-anim"));
      this._cursorReady = true;
    } else {
      el.style.left = `${x}px`; el.style.top = `${y}px`; el.classList.add("is-visible");
    }
  },

  _clearExtraCursors() {
    for (const c of this._extraCursors) c.remove();
    this._extraCursors = [];
  },

  _updateCursor() {
    if (!this._cursorEl || !this._root) return;

    // "All" targeting → one feather per benefiting cell; hide the single cursor.
    if (this._zone === "targets" && this._targetMode === "all") {
      this._cursorEl.classList.remove("is-visible");
      this._clearExtraCursors();
      const cells = this._root.querySelectorAll(".oni-heal-cell.targeting");
      cells.forEach((cell) => {
        const cur = document.createElement("img");
        cur.className = "oni-heal-cursor";
        cur.src = HEAL_CURSOR_SRC;
        document.body.appendChild(cur);
        this._extraCursors.push(cur);
        const r = cell.getBoundingClientRect();
        cur.style.left = `${r.right}px`; cur.style.top = `${r.bottom}px`; cur.classList.add("is-visible");
      });
      return;
    }
    this._clearExtraCursors();

    let targetEl = null;
    if (this._zone === "debuffs") {
      const icons = this._root.querySelectorAll(`.oni-heal-cell[data-idx="${this._targetIndex}"] .oni-heal-debuff`);
      targetEl = icons[this._debuffIndex] ?? icons[0] ?? null;
    } else if (this._zone === "targets") {
      targetEl = this._root.querySelector(`.oni-heal-cell[data-idx="${this._targetIndex}"]`);
    } else {
      targetEl = this._root.querySelectorAll(".oni-heal-row")[this._listIndex] ?? null;
    }
    if (!targetEl) { this._cursorEl.classList.remove("is-visible"); return; }
    this._placeCursorAt(this._cursorEl, targetEl.getBoundingClientRect());
  },

  // Push the live-tunable layout constants (HEAL_TUNE) onto the overlay root as
  // CSS custom properties. Called on build and by the tuner for instant updates.
  applyTune() {
    if (!this._root) return;
    const vars = tuneVars(HEAL_TUNE);
    for (const [k, v] of Object.entries(vars)) this._root.style.setProperty(k, v);
  },

  _renderBanner() {
    const el = this._root?.querySelector(".oni-heal-banner");
    if (!el) return;
    if (!this._armed) {
      el.className = "oni-heal-banner";
      el.textContent = "Select a healing action on the left.";
      return;
    }
    el.className = "oni-heal-banner armed";
    const a = this._armed;
    let tail;
    if (this._zone === "debuffs") tail = "choose a debuff to cleanse";
    else if (this._targetMode === "all") tail = "confirm to apply to all";
    else if (a.targeting === "self") tail = "confirm on self";
    else tail = "choose a target";
    el.innerHTML = `Using <b>${escapeHtml(a.name)}</b> (${escapeHtml(a.healLabel)}) — ${tail}`;
  },

  // ── Interaction ───────────────────────────────────────────────────────────
  _currentRows() { return this._actions[this._category] ?? []; },

  _switchTab(cat) {
    if (cat === this._category) return;
    this._category = cat;
    this._listIndex = 0;
    this._zone = "list";
    playHealSfx("MOVE");
    this._renderTabs(); this._renderList();
  },

  _cycleTab(dir) {
    const idx = CATEGORY_ORDER.indexOf(this._category);
    const next = CATEGORY_ORDER[(idx + dir + CATEGORY_ORDER.length) % CATEGORY_ORDER.length];
    this._switchTab(next);
  },

  _casterIndex() {
    const idx = this._members.findIndex((m) => m.actor?.id === this._caster?.id);
    return idx >= 0 ? idx : 0;
  },

  _armAction() {
    const desc = this._currentRows()[this._listIndex];
    if (!desc) return;
    if (!desc.affordable) { playHealSfx("DENY"); ui.notifications?.warn(`Cannot use ${desc.name}: not enough resources.`); return; }
    this._armed = desc;
    this._targetMode = desc.targeting ?? "single";
    this._zone = "targets";
    if (this._targetMode === "self") this._targetIndex = this._casterIndex();
    else if (!this._members[this._targetIndex]) this._targetIndex = 0;
    playHealSfx("ARM");
    this._renderList(); this._updateCellStates(); this._renderBanner();
  },

  _disarm() {
    if (!this._armed && this._zone === "list") return false;
    // From the debuff picker, X backs out to target selection (not all the way).
    if (this._zone === "debuffs") {
      this._zone = "targets";
      playHealSfx("CANCEL");
      this._updateDebuffs(); this._updateCellStates(); this._renderBanner();
      return true;
    }
    this._armed = null;
    this._targetMode = "single";
    this._zone = "list";
    playHealSfx("CANCEL");
    this._renderList(); this._updateCellStates(); this._renderBanner();
    return true;
  },

  // 2x2 grid navigation: up/down move between rows, left/right between columns.
  // Disabled in "all" (everyone targeted) and "self" (locked to caster).
  _moveTarget(dCol, dRow) {
    if (this._targetMode === "all" || this._targetMode === "self") return;
    const i = this._targetIndex;
    let col = i % 2, row = Math.floor(i / 2);
    if (dCol) col = Math.max(0, Math.min(1, col + dCol));
    if (dRow) row = Math.max(0, Math.min(1, row + dRow));
    const next = row * 2 + col;
    if (this._members[next] && next !== i) { this._targetIndex = next; playHealSfx("MOVE"); this._updateCellStates(); }
  },

  // Move within the targeted actor's debuff icons (picker mode).
  _moveDebuff(dir) {
    const debuffs = this._actorDebuffs(this._members[this._targetIndex]?.actor);
    if (debuffs.length <= 1) return;
    const next = Math.max(0, Math.min(debuffs.length - 1, this._debuffIndex + dir));
    if (next !== this._debuffIndex) { this._debuffIndex = next; playHealSfx("MOVE"); this._updateDebuffs(); this._updateCursor(); }
  },

  // List of target entries for the armed action's targeting mode.
  _resolvedTargets() {
    if (this._targetMode === "all") return this._members.filter((m) => m?.actor);
    const entry = this._members[this._targetIndex];
    return entry?.actor ? [entry] : [];
  },

  // Z on a target. Routes to the debuff picker for single-target cleanse-one,
  // else applies directly.
  _onConfirmTargets() {
    const desc = this._armed;
    if (!desc) return;
    if (desc.kind === "cleanse" && desc.cleanseScope === "one" && this._targetMode !== "all") {
      this._enterDebuffPicker();
      return;
    }
    this._applyAction();
  },

  // Single-target cleanse-one: auto-resolve when the target has exactly one
  // debuff; otherwise open the picker.
  _enterDebuffPicker() {
    const target = this._members[this._targetIndex]?.actor;
    if (!target) return;
    const debuffs = this._actorDebuffs(target);
    if (!debuffs.length) { playHealSfx("FULL"); return; }
    if (debuffs.length === 1) { this._applyCleanseOne(target, debuffs[0].id); return; }
    this._zone = "debuffs";
    this._debuffIndex = 0;
    playHealSfx("ARM");
    this._updateDebuffs(); this._updateCellStates(); this._renderBanner();
  },

  // Build the cost/source fields shared by every apply payload.
  _costFields() {
    const d = this._armed;
    return {
      casterUuid: this._caster.uuid,
      effectItemUuid: d.effectItemUuid,
      costItemUuid: d.costItemUuid,
      consumableUuid: d.consumableUuid ?? null,
      mode: d.mode ?? "use",
      ipCost: d.ipCost ?? 0,
    };
  },

  // Apply heal / cleanse-all to the resolved target(s) (one request).
  async _applyAction() {
    const desc = this._armed;
    if (!desc) return;
    const targets = this._resolvedTargets().filter((t) => this._canBenefit(t.actor, desc));
    if (!targets.length) { playHealSfx("FULL"); return; }

    const payload = {
      ...this._costFields(),
      kind: desc.kind,
      cleanseScope: desc.cleanseScope ?? null,
      targetUuids: targets.map((t) => t.actor.uuid),
      targetCount: targets.length,
    };
    const result = await requestApply(payload).catch((e) => { console.warn(HEAL_TAG, "requestApply threw", e); return { ok: false, reason: "exception" }; });
    this._afterApply(desc, result, targets.map((t) => this._members.indexOf(t)));
  },

  // Apply a single picked debuff removal (cleanse-one).
  async _applyCleanseOne(target, debuffId) {
    const desc = this._armed;
    if (!desc) return;
    const payload = {
      ...this._costFields(),
      kind: "cleanse",
      cleanseScope: "one",
      targetUuids: [target.uuid],
      cleansePicks: { [target.uuid]: debuffId },
      targetCount: 1,
    };
    const result = await requestApply(payload).catch((e) => { console.warn(HEAL_TAG, "requestApply threw", e); return { ok: false, reason: "exception" }; });
    this._afterApply(desc, result, [this._targetIndex]);

    // Picker persists: stay if the target still has debuffs, else back to targets.
    if (result?.ok && this._zone === "debuffs") {
      const left = this._actorDebuffs(target);
      if (!left.length) this._zone = "targets";
      else this._debuffIndex = Math.min(this._debuffIndex, left.length - 1);
      this._updateDebuffs(); this._updateCellStates(); this._renderBanner();
    }
  },

  // Shared post-apply: SFX, flash, spectator broadcast, notification, refresh.
  _afterApply(desc, result, cellIdxs) {
    if (!result?.ok) { playHealSfx("DENY"); ui.notifications?.warn(`${desc.kind === "cleanse" ? "Cleanse" : "Heal"} failed: ${result?.reason ?? "unknown"}.`); return; }
    playHealSfx(desc.kind === "cleanse" ? "CLEANSE" : "HEAL");
    for (const i of cellIdxs) if (i >= 0) this._flashCell(i);

    const lines = this._feedbackLines(desc, result);
    if (lines.length) broadcastHealFeedback({ casterName: this._caster.name, lines });
    if (lines.length) ui.notifications?.info(lines[0].text ?? `${desc.name} used.`);

    this._updateResources(); this._updateDebuffs(); this._updateCellStates();
    this._refreshActions();
  },

  // Shape GM result.applied into toast lines (heal / cleanse-one / cleanse-all).
  _feedbackLines(desc, result) {
    const applied = result.applied ?? [];
    const caster = this._caster.name;
    if (desc.kind === "cleanse") {
      if (desc.cleanseScope === "all") {
        const seen = new Set(); const lines = [];
        for (const a of applied) {
          if (seen.has(a.targetName)) continue; seen.add(a.targetName);
          lines.push({ kind: "cleanse-all", casterName: caster, targetName: a.targetName, text: `${caster} cleanses ${a.targetName}` });
        }
        return lines;
      }
      return applied.map((a) => ({ kind: "cleanse-one", casterName: caster, targetName: a.targetName, debuff: a.debuffName, text: `${caster} cures ${a.debuffName} from ${a.targetName}` }));
    }
    return applied.filter((a) => a.healed > 0).map((a) => ({
      kind: "heal", casterName: caster, targetName: a.targetName,
      resource: a.resource, amount: a.healed, after: a.after, max: a.max,
      text: `${caster} restores ${a.healed} ${(HEAL_RESOURCE[a.resource]?.label ?? a.resource)} to ${a.targetName}`,
    }));
  },

  _flashCell(idx) {
    const cell = this._root?.querySelector(`.oni-heal-cell[data-idx="${idx}"] .flash`);
    if (!cell) return;
    cell.classList.remove("go"); void cell.offsetWidth; cell.classList.add("go");
  },

  // Re-gather actions (caster resources/stock changed). Preserve the armed
  // action by name+category when possible; disarm if it's no longer usable.
  async _refreshActions() {
    if (this._refreshing) return;
    this._refreshing = true;
    try {
      this._actions = await gatherHealingActions(this._caster);
      this._renderTabs();
      // Re-bind the armed descriptor to the refreshed list (affordability/qty updated).
      if (this._armed) {
        const fresh = (this._actions[this._armed.category] ?? []).find((d) => d.effectItemUuid === this._armed.effectItemUuid);
        if (fresh && fresh.affordable) { this._armed = fresh; }
        else { this._armed = null; this._zone = "list"; }
      }
      this._renderList(); this._updateCellStates(); this._renderBanner();
    } finally { this._refreshing = false; }
  },

  _installUpdateHook() {
    const watched = new Set([this._caster.id, ...this._members.map((m) => m.actorId)]);
    this._updateHook = (actor) => {
      if (!this._root) return;
      if (!watched.has(actor.id)) return;
      // Update resource numbers + dim states for any watched actor (no sprite rebuild).
      this._updateResources(); this._updateCellStates();
      // If the CASTER changed (cost spent elsewhere), refresh affordability.
      if (actor.id === this._caster.id) this._refreshActions();
    };
    Hooks.on("updateActor", this._updateHook);

    // Refresh the debuff icon rows when effects change on a watched actor.
    const onAe = (effect) => {
      if (!this._root) return;
      const parent = effect?.parent;
      if (parent && watched.has(parent.id)) this._updateDebuffs();
    };
    this._aeHooks = [
      ["createActiveEffect", onAe],
      ["deleteActiveEffect", onAe],
      ["updateActiveEffect", onAe],
    ];
    for (const [name, fn] of this._aeHooks) Hooks.on(name, fn);
  },

  _teardownAeHooks() {
    for (const [name, fn] of (this._aeHooks ?? [])) Hooks.off(name, fn);
    this._aeHooks = [];
  },

  _installKeyboard() {
    this._keyHandler = (ev) => {
      if (!this._root) return;
      // Swallow keys while the HUD is open.
      if ([...HEAL_KEYS.UP, ...HEAL_KEYS.DOWN, ...HEAL_KEYS.LEFT, ...HEAL_KEYS.RIGHT,
           ...HEAL_KEYS.CONFIRM, ...HEAL_KEYS.CANCEL, ...HEAL_KEYS.TAB_NEXT, ...HEAL_KEYS.TAB_PREV].includes(ev.key)) {
        ev.preventDefault(); ev.stopPropagation();
      } else { return; }

      if (keyMatch(ev, HEAL_KEYS.CANCEL)) {
        if (this._zone === "targets" || this._zone === "debuffs") { this._disarm(); }
        else { this.close(); }
        return;
      }
      if (keyMatch(ev, HEAL_KEYS.TAB_NEXT)) { if (this._zone === "list") this._cycleTab(+1); return; }
      if (keyMatch(ev, HEAL_KEYS.TAB_PREV)) { if (this._zone === "list") this._cycleTab(-1); return; }

      if (this._zone === "list") {
        if (keyMatch(ev, HEAL_KEYS.UP))    { this._moveList(-1); return; }
        if (keyMatch(ev, HEAL_KEYS.DOWN))  { this._moveList(+1); return; }
        if (keyMatch(ev, HEAL_KEYS.LEFT))  { this._cycleTab(-1); return; }
        if (keyMatch(ev, HEAL_KEYS.RIGHT)) { this._cycleTab(+1); return; }
        if (keyMatch(ev, HEAL_KEYS.CONFIRM)) { this._armAction(); return; }
      } else if (this._zone === "debuffs") { // debuff picker (one debuff at a time)
        if (keyMatch(ev, HEAL_KEYS.LEFT) || keyMatch(ev, HEAL_KEYS.UP))    { this._moveDebuff(-1); return; }
        if (keyMatch(ev, HEAL_KEYS.RIGHT) || keyMatch(ev, HEAL_KEYS.DOWN)) { this._moveDebuff(+1); return; }
        if (keyMatch(ev, HEAL_KEYS.CONFIRM)) {
          const target = this._members[this._targetIndex]?.actor;
          const debuffs = this._actorDebuffs(target);
          const eff = debuffs[this._debuffIndex] ?? debuffs[0];
          if (target && eff) this._applyCleanseOne(target, eff.id);
          return;
        }
      } else { // targets (2x2 grid)
        if (keyMatch(ev, HEAL_KEYS.UP))    { this._moveTarget(0, -1); return; }
        if (keyMatch(ev, HEAL_KEYS.DOWN))  { this._moveTarget(0, +1); return; }
        if (keyMatch(ev, HEAL_KEYS.LEFT))  { this._moveTarget(-1, 0); return; }
        if (keyMatch(ev, HEAL_KEYS.RIGHT)) { this._moveTarget(+1, 0); return; }
        if (keyMatch(ev, HEAL_KEYS.CONFIRM)) { this._onConfirmTargets(); return; }
      }
    };
    window.addEventListener("keydown", this._keyHandler, true);
  },

  _moveList(dir) {
    const rows = this._currentRows();
    if (!rows.length) return;
    this._listIndex = Math.max(0, Math.min(rows.length - 1, this._listIndex + dir));
    playHealSfx("MOVE");
    this._renderList();
  },
};

export { HealingHUD };
