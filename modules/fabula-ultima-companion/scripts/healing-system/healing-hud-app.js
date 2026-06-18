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

import { HEAL_TAG, HEAL_CATEGORY, HEAL_KEYS, HEAL_RESOURCE, playHealSfx } from "./healing-const.js";
import { injectHealingStyles } from "./healing-hud-styles.js";
import { gatherHealingActions } from "./healing-actions.js";
import { requestApply } from "./healing-socket.js";

const CATEGORY_ORDER = [HEAL_CATEGORY.SKILL, HEAL_CATEGORY.SPELL, HEAL_CATEGORY.ITEM];

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}
function keyMatch(ev, list) { return list.includes(ev.key); }

const HealingHUD = {
  _root: null,
  _caster: null,
  _members: [],           // [{actor, actorId, userId, userName}] padded conceptually
  _actions: { Skill: [], Spell: [], Item: [] },
  _category: HEAL_CATEGORY.SKILL,
  _listIndex: 0,
  _zone: "list",          // "list" | "targets"
  _armed: null,           // descriptor
  _targetIndex: 0,
  _keyHandler: null,
  _updateHook: null,
  _refreshing: false,

  get isOpen() { return !!this._root; },

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  async open(opts = {}) {
    // Re-open: tear down the existing HUD instantly (no exit anim/sfx).
    if (this._root) {
      if (this._keyHandler) { window.removeEventListener("keydown", this._keyHandler, true); this._keyHandler = null; }
      if (this._updateHook) { Hooks.off("updateActor", this._updateHook); this._updateHook = null; }
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

    requestAnimationFrame(() => this._root?.classList.add("visible"));
  },

  close() {
    if (this._keyHandler) { window.removeEventListener("keydown", this._keyHandler, true); this._keyHandler = null; }
    if (this._updateHook) { Hooks.off("updateActor", this._updateHook); this._updateHook = null; }
    const root = this._root;
    this._root = null;
    this._armed = null;
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

    root.querySelector(".oni-heal-close").addEventListener("click", () => { this.close(); });
    // Click on the dark backdrop (outside the frame) closes.
    root.addEventListener("pointerdown", (ev) => { if (ev.target === root) this.close(); });

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
        this._listIndex = i; this._renderList();
        this._armAction();
      });
      listEl.appendChild(row);
    });
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
      cell.className = "oni-heal-cell" + (entry ? "" : " empty")
        + (entry && i === this._targetIndex && this._zone === "targets" ? " sel targeting" : "")
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
        </div>`;
      cell.addEventListener("click", () => {
        if (!this._armed) { this._zone = "targets"; this._targetIndex = i; this._renderParty(); return; }
        this._targetIndex = i; this._renderParty();
        this._confirmHeal();
      });
      gridEl.appendChild(cell);
    }
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

  _renderBanner() {
    const el = this._root?.querySelector(".oni-heal-banner");
    if (!el) return;
    if (this._armed) {
      el.className = "oni-heal-banner armed";
      el.innerHTML = `Using <b>${escapeHtml(this._armed.name)}</b> (${escapeHtml(this._armed.healLabel)}) — choose a target`;
    } else {
      el.className = "oni-heal-banner";
      el.textContent = "Select a healing action on the left.";
    }
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

  _armAction() {
    const desc = this._currentRows()[this._listIndex];
    if (!desc) return;
    if (!desc.affordable) { playHealSfx("DENY"); ui.notifications?.warn(`Cannot use ${desc.name}: not enough resources.`); return; }
    this._armed = desc;
    this._zone = "targets";
    if (!this._members[this._targetIndex]) this._targetIndex = 0;
    playHealSfx("ARM");
    this._renderList(); this._renderParty(); this._renderBanner();
  },

  _disarm() {
    if (!this._armed && this._zone === "list") return false;
    this._armed = null;
    this._zone = "list";
    playHealSfx("CANCEL");
    this._renderList(); this._renderParty(); this._renderBanner();
    return true;
  },

  _moveTarget(dCol, dRow) {
    const i = this._targetIndex;
    let col = i % 2, row = Math.floor(i / 2);
    if (dCol) col = Math.max(0, Math.min(1, col + dCol));
    if (dRow) row = Math.max(0, Math.min(1, row + dRow));
    const next = row * 2 + col;
    if (this._members[next] && next !== i) { this._targetIndex = next; playHealSfx("MOVE"); this._renderParty(); }
  },

  async _confirmHeal() {
    const desc = this._armed;
    const entry = this._members[this._targetIndex];
    if (!desc || !entry?.actor) return;
    if (!desc.affordable) { playHealSfx("DENY"); return; }

    const payload = {
      casterUuid: this._caster.uuid,
      targetUuid: entry.actor.uuid,
      effectItemUuid: desc.effectItemUuid,
      costItemUuid: desc.costItemUuid,
      consumableUuid: desc.consumableUuid ?? null,
    };
    const result = await requestApply(payload).catch((e) => { console.warn(HEAL_TAG, "requestApply threw", e); return { ok: false, reason: "exception" }; });

    if (!result?.ok) {
      playHealSfx("DENY");
      ui.notifications?.warn(`Heal failed: ${result?.reason ?? "unknown"}.`);
      return;
    }
    playHealSfx("HEAL");
    this._flashCell(this._targetIndex);
    const healed = (result.applied ?? []).filter((a) => a.healed > 0).map((a) => `+${a.healed} ${HEAL_RESOURCE[a.resource]?.label ?? a.resource}`).join(", ");
    ui.notifications?.info(`${desc.name}: ${entry.actor.name} ${healed || "fully recovered"}.`);

    // Refresh bars now (hook also fires) and re-evaluate caster affordability/stock.
    this._renderParty();
    await this._refreshActions();   // cost spent / consumable count changed → stay armed if still usable
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
      this._renderList(); this._renderBanner();
    } finally { this._refreshing = false; }
  },

  _installUpdateHook() {
    const watched = new Set([this._caster.id, ...this._members.map((m) => m.actorId)]);
    this._updateHook = (actor) => {
      if (!this._root) return;
      if (!watched.has(actor.id)) return;
      // Re-render party bars for any watched actor.
      this._renderParty();
      // If the CASTER changed (cost spent elsewhere), refresh affordability.
      if (actor.id === this._caster.id) this._refreshActions();
    };
    Hooks.on("updateActor", this._updateHook);
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
        if (this._zone === "targets") { this._disarm(); }
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
      } else { // targets
        if (keyMatch(ev, HEAL_KEYS.UP))    { this._moveTarget(0, -1); return; }
        if (keyMatch(ev, HEAL_KEYS.DOWN))  { this._moveTarget(0, +1); return; }
        if (keyMatch(ev, HEAL_KEYS.LEFT))  { this._moveTarget(-1, 0); return; }
        if (keyMatch(ev, HEAL_KEYS.RIGHT)) { this._moveTarget(+1, 0); return; }
        if (keyMatch(ev, HEAL_KEYS.CONFIRM)) { this._confirmHeal(); return; }
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
