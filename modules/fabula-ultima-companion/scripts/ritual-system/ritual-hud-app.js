// ============================================================================
// Ritual System — the setup window (local, single instance).
//
// Steps 1 and 2 of the flowchart (core p. 119): describe the effect, declare
// the discipline, and let the potency × area tables price it. Step 3 — spend
// the MP, roll the Magic Check — happens GM-side in ritual-cast.js.
//
// Ineligible disciplines are shown GREYED with the reason rather than hidden,
// so a player can see that Elementalism exists and what it would take to learn
// it. Insufficient MP likewise disables Cast without hiding it: a GM operating
// the window may cast anyway (fiat), a player may not.
// ============================================================================

import { RITUAL_TAG, POTENCY, AREA, POTENCY_ORDER, AREA_ORDER, DISCIPLINE_ORDER, disciplineById } from "./ritual-const.js";
import { computeCost, describeCost, canAfford, currentMp } from "./ritual-cost.js";
import { resolvePerformer, disciplinesForActor, ineligibilityReason } from "./ritual-actor.js";
import { injectRitualStyles } from "./ritual-hud-styles.js";
import { requestCast } from "./ritual-socket.js";

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

const RitualHUD = {
  _root: null,
  _performer: null,
  _eligible: [],          // [{id, label, via, reason}]
  _spec: null,
  _casting: false,

  get isOpen() { return Boolean(this._root); },

  open() {
    if (this._root) { this.close(); }

    const performer = resolvePerformer();
    if (!performer) {
      ui.notifications?.warn(game.user?.isGM
        ? "Ritual: select a token to perform as."
        : "Ritual: no character assigned to your user.");
      return;
    }

    injectRitualStyles();
    this._performer = performer;
    this._eligible = disciplinesForActor(performer.actor);

    if (!this._eligible.length) {
      ui.notifications?.warn(`Ritual: ${performer.name} knows no ritual disciplines.`);
      return;
    }

    this._spec = {
      discipline: this._eligible[0].id,
      potency: "minor",
      area: "individual",
      ingredient: false,
      ingredientName: "",
      description: "",
      useAltAttrs: false,
      groupCheck: false,
    };
    this._casting = false;

    this._build();
    this._installKeyboard();
    requestAnimationFrame(() => this._root?.classList.add("visible"));
  },

  close() {
    if (!this._root) return;
    if (this._keyHandler) { window.removeEventListener("keydown", this._keyHandler, true); this._keyHandler = null; }
    const root = this._root;
    this._root = null;
    root.classList.remove("visible");
    setTimeout(() => root.remove(), 200);
  },

  // ── DOM ──────────────────────────────────────────────────────────────────
  _build() {
    const root = document.createElement("div");
    root.className = "oni-ritual-overlay";
    root.innerHTML = `
      <div class="oni-ritual-frame">
        <div class="oni-ritual-header">
          <img src="${escapeHtml(this._performer.img)}" />
          <div class="title">Ritual</div>
          <div class="performer">${escapeHtml(this._performer.name)} · ${currentMp(this._performer.actor)} MP</div>
          <div class="oni-ritual-close" title="Close (Esc)">✕</div>
        </div>
        <div class="oni-ritual-body">
          <div class="oni-ritual-section">
            <h3>Discipline</h3>
            <div class="oni-ritual-grid" data-grid="discipline"></div>
            <div class="oni-ritual-alt" data-alt hidden>
              <label><input type="checkbox" data-field="useAltAttrs" /> Use <b>MIG + WLP</b> instead of INS + WLP</label>
            </div>
          </div>

          <div class="oni-ritual-section">
            <h3>Potency</h3>
            <div class="oni-ritual-grid" data-grid="potency"></div>
          </div>

          <div class="oni-ritual-section">
            <h3>Area</h3>
            <div class="oni-ritual-grid" data-grid="area"></div>
          </div>

          <div class="oni-ritual-section oni-ritual-desc">
            <h3>What do you want to accomplish?</h3>
            <textarea data-field="description" placeholder="Describe the effect and the area or creatures you want to affect…"></textarea>
          </div>

          <div class="oni-ritual-section oni-ritual-toggles">
            <label>
              <input type="checkbox" data-field="ingredient" />
              Offer a rare or powerful ingredient <span style="opacity:.7">(halves the cost, once)</span>
            </label>
            <label style="padding-left: 24px;">
              <input type="text" data-field="ingredientName" placeholder="Which ingredient?" disabled />
            </label>
            <label>
              <input type="checkbox" data-field="groupCheck" />
              Perform as a <b>Group Check</b> <span style="opacity:.7">(allies may help; you lead)</span>
            </label>
          </div>

          <div class="oni-ritual-readout">
            <div class="cost"></div>
            <div class="mp"></div>
          </div>
        </div>
        <div class="oni-ritual-footer">
          <button class="oni-ritual-btn ghost" data-act="cancel">Cancel</button>
          <button class="oni-ritual-btn" data-act="cast">Perform Ritual</button>
        </div>
      </div>`;

    document.body.appendChild(root);
    this._root = root;

    root.querySelector(".oni-ritual-close").addEventListener("click", () => this.close());
    root.querySelector('[data-act="cancel"]').addEventListener("click", () => this.close());
    root.querySelector('[data-act="cast"]').addEventListener("click", () => this._cast());
    root.addEventListener("click", (ev) => { if (ev.target === root) this.close(); });

    for (const el of root.querySelectorAll("[data-field]")) {
      const field = el.dataset.field;
      const evt = el.type === "checkbox" ? "change" : "input";
      el.addEventListener(evt, () => {
        this._spec[field] = el.type === "checkbox" ? el.checked : el.value;
        if (field === "ingredient") {
          root.querySelector('[data-field="ingredientName"]').disabled = !el.checked;
        }
        this._refreshReadout();
      });
    }

    this._renderDisciplines();
    this._renderTable("potency", POTENCY_ORDER, POTENCY);
    this._renderTable("area", AREA_ORDER, AREA);
    this._refreshAltToggle();
    this._refreshReadout();
  },

  _renderDisciplines() {
    const grid = this._root.querySelector('[data-grid="discipline"]');
    const eligibleIds = new Map(this._eligible.map((d) => [d.id, d]));
    grid.innerHTML = DISCIPLINE_ORDER.map((id) => {
      const d = disciplineById(id);
      const hit = eligibleIds.get(id);
      const cls = ["oni-ritual-opt"];
      if (!hit) cls.push("disabled");
      if (this._spec.discipline === id) cls.push("selected");
      const why = hit
        ? (hit.via === "class" ? `via ${escapeHtml(hit.reason)}` : escapeHtml(d.blurb))
        : escapeHtml(ineligibilityReason(id));
      return `<div class="${cls.join(" ")}" data-id="${id}" title="${escapeHtml(d.blurb)}">
        <div class="name">${escapeHtml(d.label)}${d.homebrew ? " ✦" : ""}</div>
        <div class="why">${why}</div>
      </div>`;
    }).join("");

    for (const el of grid.querySelectorAll(".oni-ritual-opt:not(.disabled)")) {
      el.addEventListener("click", () => {
        this._spec.discipline = el.dataset.id;
        this._spec.useAltAttrs = false;
        this._renderDisciplines();
        this._refreshAltToggle();
        this._refreshReadout();
      });
    }
  },

  _renderTable(kind, order, table) {
    const grid = this._root.querySelector(`[data-grid="${kind}"]`);
    const byId = Object.fromEntries(Object.values(table).map((r) => [r.id, r]));
    grid.innerHTML = order.map((id) => {
      const row = byId[id];
      const sel = this._spec[kind] === id ? " selected" : "";
      const sub = kind === "potency"
        ? `${row.mp} MP · DL ${row.dl}`
        : `× ${row.multiplier}`;
      return `<div class="oni-ritual-opt${sel}" data-id="${id}" title="${escapeHtml(row.example)}">
        <div class="name">${escapeHtml(row.label)}</div>
        <div class="why">${sub}</div>
      </div>`;
    }).join("");

    for (const el of grid.querySelectorAll(".oni-ritual-opt")) {
      el.addEventListener("click", () => {
        this._spec[kind] = el.dataset.id;
        this._renderTable(kind, order, table);
        this._refreshReadout();
      });
    }
  },

  /** Chimerism is the only discipline the book gives a second attribute pair. */
  _refreshAltToggle() {
    const d = disciplineById(this._spec.discipline);
    const wrap = this._root.querySelector("[data-alt]");
    wrap.hidden = !d?.altAttrs;
    if (wrap.hidden) this._root.querySelector('[data-field="useAltAttrs"]').checked = false;
  },

  _refreshReadout() {
    const cost = computeCost(this._spec);
    const readout = this._root.querySelector(".oni-ritual-readout");
    const castBtn = this._root.querySelector('[data-act="cast"]');
    if (!cost) return;

    const mp = currentMp(this._performer.actor);
    const affordable = canAfford(this._performer.actor, cost);

    readout.querySelector(".cost").textContent = describeCost(this._spec);
    const mpEl = readout.querySelector(".mp");
    mpEl.textContent = affordable
      ? `${mp} MP available → ${mp - cost.mp} MP remaining`
      : `${mp} MP available — ${cost.mp - mp} MP short`;
    mpEl.classList.toggle("short", !affordable);

    // A GM may cast anyway; a player may not.
    castBtn.disabled = this._casting || (!affordable && !game.user?.isGM);
    castBtn.textContent = this._casting ? "Performing…"
      : (!affordable && game.user?.isGM) ? "Perform Anyway (GM)"
      : "Perform Ritual";
  },

  async _cast() {
    if (this._casting) return;
    const cost = computeCost(this._spec);
    if (!cost) return;
    if (!this._spec.description.trim()) {
      ui.notifications?.warn("Ritual: describe what you want to accomplish first.");
      return;
    }

    this._casting = true;
    this._refreshReadout();

    const spec = { ...this._spec };
    const performerUuid = this._performer.uuid;
    // GM fiat only — requestCast ignores this on a player client anyway, since
    // the GM re-validates affordability at the far end.
    const override = Boolean(game.user?.isGM) && !canAfford(this._performer.actor, cost);

    this.close();
    try {
      await requestCast({ performerUuid, spec, override });
    } catch (e) {
      console.error(RITUAL_TAG, "cast failed", e);
      ui.notifications?.error("Ritual: the cast failed. See console.");
    }
  },

  _installKeyboard() {
    this._keyHandler = (ev) => {
      if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); this.close(); }
    };
    window.addEventListener("keydown", this._keyHandler, true);
  },
};

export { RitualHUD };
