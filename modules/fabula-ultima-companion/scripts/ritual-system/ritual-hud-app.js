// ============================================================================
// Ritual System — the setup window (local, single instance).
//
// Steps 1 and 2 of the flowchart (core p. 119): describe the effect, declare
// the discipline, and let the potency × area tables price it. Step 3 — spend
// the MP, roll the Magic Check — happens GM-side in ritual-cast.js.
//
// ── Shape ───────────────────────────────────────────────────────────────────
// Five focusable rows, top to bottom. Every row is one control, so the whole
// window is navigable with the arrow keys alone:
//
//     DISCIPLINE     ◀  (icon) Entropism  ▶      scroll label
//     POTENCY | AREA   ◀ Minor ▶ | ◀ Individual ▶   two scroll labels, one row
//     OFFER MATERIAL | GROUP CHECK                  button + toggle switch
//     INTENT                                        optional free text
//     FINALIZE                            Cost … | DL 7
//
// Only PERFORMABLE disciplines appear at all — the scroll never lands on one
// the performer cannot cast, so there is no disabled state to explain.
//
// ── Controls, imported from the Healing HUD ────────────────────────────────
//     ↑/↓  move between rows            ←/→ or wheel  scroll a value
//     Z    scroll forward / activate    X or Esc      cancel
//
// Z on a scroll row nudges it forward (the user's ask), so confirming a cast is
// reaching the FINALIZE row and pressing Z there — deliberate, not a stray key
// away from spending 200 MP.
//
// The intent box is a real textarea: while it holds DOM focus the global key
// handler stands down entirely, or typing "z" would scroll the discipline.
// ============================================================================

import {
  RITUAL_TAG, POTENCY, AREA, POTENCY_ORDER, AREA_ORDER,
  RITUAL_KEYS, RITUAL_CURSOR_SRC, RITUAL_MATERIAL_ICON, playRitualSfx, disciplineById,
} from "./ritual-const.js";
import { computeCost, canAfford, currentMp, shortfall } from "./ritual-cost.js";
import { resolvePerformer, disciplinesForActor } from "./ritual-actor.js";
import { injectRitualStyles } from "./ritual-hud-styles.js";
import { requestCast } from "./ritual-socket.js";
import { broadcastFeedback } from "./ritual-feedback.js";
import { openMaterialPicker } from "./ritual-material-picker.js";

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}
const keyMatch = (ev, list) => list.includes(ev.key);

// Row order == focus order. Kept as data so the keyboard handler never needs a
// switch on row names to know what comes next.
const ROWS = ["discipline", "potency", "area", "material", "group", "altattr", "intent", "confirm"];

// Controls that share one VISUAL row. ↑/↓ jumps clear of the whole group;
// ←/→ walks within it. A group, not a pair, because the actions row now holds
// three controls and `altattr` is only present for Chimerism.
const ROW_GROUPS = [["potency", "area"], ["material", "group", "altattr"]];
const groupOf = (row) => ROW_GROUPS.find((g) => g.includes(row)) ?? null;

// Rows whose value is changed by scrolling, and which therefore must be ENGAGED
// with Z before ←/→ will move that value rather than move between rows.
const SCROLL_ROWS = new Set(["discipline", "potency", "area"]);

// Slide/roll timings. SLIDE_MS must match the CSS transition on .v-layer, or a
// rebuild lands mid-animation and the value visibly jumps. The carousel runs a
// touch longer and drives itself off `transitionend`, so it has no such
// coupling — DISC_SLIDE_MS only feeds the inline transition it sets.
const SLIDE_MS = 200;
const DISC_SLIDE_MS = 280;
const ROLL_MS = 260;

// The carousel renders FIVE slots but shows three. The two off-stage slots are
// what slide in from behind the arrows: with only prev/cur/next, the position
// vacated by the incoming neighbour is empty for the whole slide, so the new
// neighbour could only appear at the rebuild — it snapped.
const DISC_SLOTS = 5;
const DISC_CENTER = 2;            // index of the current slot
const DISC_STEP_PCT = 100 / DISC_SLOTS;   // one slot, as a % of the track's own width

const RitualHUD = {
  _root: null,
  _performer: null,
  _disciplines: [],       // performable only, in DISCIPLINE_ORDER
  _spec: null,
  _casting: false,
  _row: "discipline",
  _cursorEl: null,
  _cursorReady: false,
  _keyHandler: null,
  _pickerOpen: false,
  _engaged: false,        // a scroll row is "entered": ←/→ change its VALUE
  _discAnim: false,       // guards the carousel against a mid-slide re-entry
  _shown: { mp: null, dl: null },   // last painted numbers, for the roll animation

  get isOpen() { return Boolean(this._root); },

  open() {
    if (this._root) this.close({ silent: true });

    const performer = resolvePerformer();
    if (!performer) {
      ui.notifications?.warn(game.user?.isGM
        ? "Ritual: select a token to perform as."
        : "Ritual: no character assigned to your user.");
      return;
    }

    const disciplines = disciplinesForActor(performer.actor);
    if (!disciplines.length) {
      ui.notifications?.warn(`Ritual: ${performer.name} knows no ritual disciplines.`);
      return;
    }

    injectRitualStyles();
    this._performer = performer;
    this._disciplines = disciplines;
    this._spec = {
      discipline: disciplines[0].id,
      potency: "minor",
      area: "individual",
      material: null,       // { actorUuid, itemId, name, rarity, discount, img }
      description: "",
      useAltAttrs: false,
      groupCheck: false,
    };
    this._casting = false;
    this._row = "discipline";
    this._engaged = false;
    this._cursorReady = false;
    this._discAnim = false;
    this._shown = { mp: null, dl: null };

    this._build();
    this._installKeyboard();
    playRitualSfx("OPEN");

    // Tell the table someone is mid-ritual — a minute of silent tuning in a
    // four-player game otherwise reads as a stalled session.
    broadcastFeedback({ kind: "open", performerName: performer.name });

    requestAnimationFrame(() => {
      this._root?.classList.add("visible");
      this._updateCursor();
    });
  },

  /** `silent` skips the cancel banner + SFX (used when re-opening over itself). */
  close({ silent = false } = {}) {
    if (!this._root) return;
    if (this._keyHandler) { window.removeEventListener("keydown", this._keyHandler, true); this._keyHandler = null; }

    if (!silent && !this._casting) {
      playRitualSfx("EXIT");
      broadcastFeedback({ kind: "cancel", performerName: this._performer?.name });
    }

    this._cursorEl?.remove(); this._cursorEl = null; this._cursorReady = false;
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
          <div class="performer"><b>${escapeHtml(this._performer.name)}</b> · <span data-mp></span> MP</div>
          <div class="oni-ritual-close" title="Close (X)">✕</div>
        </div>

        <div class="oni-ritual-body">
          <div class="oni-ritual-disc oni-ritual-focusable" data-row="discipline" tabindex="-1">
            <div class="lbl">Discipline</div>
            <div class="picker">
              <span class="arrow" data-dir="-1">◀</span>
              <div class="disc-viewport">
                <div class="disc-track" data-disc-track></div>
              </div>
              <span class="arrow" data-dir="1">▶</span>
            </div>
          </div>

          <div class="oni-ritual-duo">
            <div class="oni-ritual-scroll oni-ritual-focusable" data-row="potency" tabindex="-1">
              <div class="lbl">Potency</div>
              <div class="picker">
                <span class="arrow" data-dir="-1">◀</span>
                <span class="val" data-potency-val></span>
                <span class="arrow" data-dir="1">▶</span>
              </div>
            </div>
            <div class="oni-ritual-scroll oni-ritual-focusable" data-row="area" tabindex="-1">
              <div class="lbl">Area</div>
              <div class="picker">
                <span class="arrow" data-dir="-1">◀</span>
                <span class="val" data-area-val></span>
                <span class="arrow" data-dir="1">▶</span>
              </div>
            </div>
          </div>

          <div class="oni-ritual-actions">
            <button class="oni-ritual-mat oni-ritual-focusable" data-row="material" tabindex="-1">
              <img class="mat-crystal" src="${escapeHtml(RITUAL_MATERIAL_ICON)}" />
              <span data-mat-label data-text="Offer Material">Offer Material</span>
            </button>
            <div class="oni-ritual-group oni-ritual-focusable" data-row="group" tabindex="-1">
              <span class="tg-label">Group Check</span>
              <span class="tg-switch"><span class="knob"></span></span>
            </div>
            <div class="oni-ritual-group oni-ritual-focusable" data-row="altattr" tabindex="-1" hidden>
              <span class="tg-label">MIG + WLP</span>
              <span class="tg-switch"><span class="knob"></span></span>
            </div>
          </div>

          <div class="oni-ritual-intent oni-ritual-focusable" data-row="intent" tabindex="-1">
            <textarea data-field="description" rows="2"
              placeholder="(Optional) what do you want to accomplish?"></textarea>
          </div>

          <div class="oni-ritual-final oni-ritual-focusable" data-row="confirm" tabindex="-1">
            <div class="fin-mid">
              <div class="fin-cost" data-fin-cost></div>
              <div class="fin-note" data-fin-note></div>
            </div>
            <div class="fin-dl"><span class="dl-lbl">DL</span><span class="dl-val" data-fin-dl></span></div>
          </div>
        </div>

        <div class="oni-ritual-footer">
          <button class="oni-ritual-btn ghost" data-act="cancel">Cancel</button>
          <button class="oni-ritual-btn" data-act="cast">Perform</button>
        </div>
      </div>`;

    document.body.appendChild(root);
    this._root = root;

    this._cursorEl = document.createElement("img");
    this._cursorEl.id = "oni-ritual-cursor";
    this._cursorEl.src = RITUAL_CURSOR_SRC;
    document.body.appendChild(this._cursorEl);

    root.querySelector(".oni-ritual-close").addEventListener("click", () => this.close());
    root.querySelector('[data-act="cancel"]').addEventListener("click", () => this.close());
    root.querySelector('[data-act="cast"]').addEventListener("click", () => this._cast());
    root.addEventListener("click", (ev) => { if (ev.target === root) this.close(); });

    // Scroll rows: arrows, wheel, click-to-focus. The discipline carousel is a
    // different element but takes exactly the same interactions.
    for (const el of root.querySelectorAll(".oni-ritual-scroll, .oni-ritual-disc")) {
      const row = el.dataset.row;
      el.addEventListener("wheel", (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        this._focus(row, { silent: true });
        this._cycle(row, (ev.deltaY ?? 0) > 0 ? 1 : -1);
      }, { passive: false });
      for (const arrow of el.querySelectorAll(".arrow")) {
        arrow.addEventListener("click", (ev) => {
          ev.stopPropagation();
          this._focus(row, { silent: true });
          this._cycle(row, Number(arrow.dataset.dir));
        });
      }
      el.addEventListener("click", () => this._focus(row));
    }

    root.querySelector('[data-row="material"]').addEventListener("click", () => {
      this._focus("material", { silent: true });
      this._openMaterialPicker();
    });
    root.querySelector('[data-row="group"]').addEventListener("click", () => {
      this._focus("group", { silent: true });
      this._toggleGroup();
    });
    root.querySelector('[data-row="altattr"]').addEventListener("click", () => {
      this._focus("altattr", { silent: true });
      this._toggleAltAttrs();
    });
    root.querySelector('[data-row="confirm"]').addEventListener("click", () => this._focus("confirm"));

    const ta = root.querySelector('[data-field="description"]');
    ta.addEventListener("input", () => { this._spec.description = ta.value; });
    ta.addEventListener("focus", () => this._focus("intent", { silent: true, noFocusSteal: true }));
    // Esc inside the box returns to navigation rather than closing the window.
    ta.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Escape") { ev.preventDefault(); ta.blur(); this._root?.focus(); }
    });
    root.querySelector('[data-row="intent"]').addEventListener("click", () => { ta.focus(); });

    this._paintDiscipline();
    this._renderPotencyArea();
    this._renderMaterial();
    this._renderGroup();
    this._refreshFinalize();
    // Paint the starting row. Setting `_row` alone leaves every row unringed,
    // so the feather points at a control that does not look selected.
    this._focus(this._row, { silent: true });
  },

  // ── Value cycling ────────────────────────────────────────────────────────
  _cycle(row, dir) {
    if (!dir) return;
    const wrap = (list, cur) => list[(list.indexOf(cur) + dir + list.length) % list.length];

    // Potency and Area are ORDERED scales — minor…extreme, individual…huge — so
    // they clamp at the ends rather than wrapping. Rolling from Extreme back to
    // Minor on one more nudge is how you overshoot a 200 MP ritual by accident.
    // The discipline reel is an unordered set, so it still wraps.
    const clamp = (list, cur) => list[Math.min(list.length - 1, Math.max(0, list.indexOf(cur) + dir))];

    // The discipline reel has its own voice; potency and area keep the generic
    // cursor-scroll cue. Early returns above the SFX are deliberate — a scroll
    // that did not happen must not make a sound.
    if (row === "discipline") {
      if (this._discAnim || this._disciplines.length < 2) return;
      const ids = this._disciplines.map((d) => d.id);
      this._slideDiscipline(wrap(ids, this._spec.discipline), dir);
      playRitualSfx("DISCIPLINE");
    } else if (row === "potency" || row === "area") {
      const key = row === "potency" ? "potency" : "area";
      const list = row === "potency" ? [...POTENCY_ORDER] : [...AREA_ORDER];
      const next = clamp(list, this._spec[key]);
      if (next === this._spec[key]) { playRitualSfx("DENY"); return; }   // already at an end
      this._spec[key] = next;
      this._renderPotencyArea(dir);
      playRitualSfx("SCROLL");
    } else {
      return;
    }
    this._refreshFinalize();
  },

  /**
   * Slide + fade one text value out and the next in.
   *
   * Absolutely-stacked layers inside an overflow-hidden host: the outgoing one
   * leaves against the scroll direction, the incoming one arrives with it.
   *
   * Every layer that is not already leaving is retired, not just the first one.
   * `querySelector` returns the FIRST `.v-layer` in DOM order, which during a
   * fast scroll is the one already animating out — so retiring only that left
   * each previous incoming layer parented forever, and the values visibly
   * stacked on top of each other ("EMinore"). The `.exit` class is what makes
   * "already leaving" observable.
   */
  _swapValue(host, text, dir) {
    const olds = [...host.querySelectorAll(".v-layer:not(.exit)")];
    const next = document.createElement("span");
    next.className = "v-layer";
    next.textContent = text;

    if (!dir || !olds.length) {
      host.querySelectorAll(".v-layer").forEach((l) => l.remove());
      host.appendChild(next);
      return;
    }

    next.style.transform = `translateX(${dir * 60}%)`;
    next.style.opacity = "0";
    host.appendChild(next);

    // Commit the starting style with a forced reflow, THEN set the end style.
    //
    // requestAnimationFrame is not enough: rAF callbacks run before the frame's
    // style recalc, so when a wheel burst delivers two events inside one frame
    // the browser sees only the final transform and paints no transition — the
    // incoming label snapped into place while the outgoing one still slid away.
    // Clicks and keys fire one per frame, which is why they never showed it.
    // Reading offsetWidth flushes layout and pins the start of the transition.
    void next.offsetWidth;

    next.style.transform = "translateX(0)";
    next.style.opacity = "1";
    for (const old of olds) {
      old.style.transform = `translateX(${-dir * 60}%)`;
      old.style.opacity = "0";
    }
    for (const old of olds) {
      old.classList.add("exit");
      setTimeout(() => old.remove(), SLIDE_MS + 40);
    }
  },

  /**
   * The discipline carousel: previous / current / next, the neighbours faded.
   *
   * Sliding the whole track by one slot moves the neighbour the user asked for
   * into the centre; once it lands we rebuild the triple around the new centre
   * and snap the transform back to zero with the transition off, so the reset
   * is invisible.
   */
  _slideDiscipline(newId, dir) {
    const track = this._root.querySelector("[data-disc-track]");
    this._discAnim = true;

    // Land the rebuild on the real `transitionend` rather than a setTimeout
    // racing it: a timer that fires a frame early snaps the track back while
    // the compositor is still easing, which is what read as chop. The timeout
    // survives only as a safety net for a transition that never fires (the
    // element was hidden, the user tabbed away).
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      track.removeEventListener("transitionend", onEnd);

      this._spec.discipline = newId;
      this._spec.useAltAttrs = false;
      track.style.transition = "none";
      track.style.transform = "translate3d(0,0,0)";
      this._paintDiscipline();
      // Re-enable the transition only after the snap has been painted, or the
      // browser animates the snap itself and the carousel jitters backwards.
      requestAnimationFrame(() => {
        track.style.transition = "";
        track.style.willChange = "";
        this._discAnim = false;
      });
    };
    // Only the TRACK's own transform ends the slide. The slots are scaling at
    // the same time and bubble their own transform transitionend events, which
    // would settle the carousel early.
    const onEnd = (ev) => { if (ev.target === track && ev.propertyName === "transform") settle(); };
    track.addEventListener("transitionend", onEnd);
    setTimeout(settle, DISC_SLIDE_MS + 120);

    // Hand the "current" crown to the incoming slot NOW, so it grows and the
    // outgoing one shrinks across the same 280ms the track is travelling.
    // Swapping the classes after the rebuild is what made the label pop to full
    // size the instant it landed.
    const slots = track.children;
    slots[DISC_CENTER]?.classList.replace("cur", "side");
    slots[DISC_CENTER + dir]?.classList.replace("side", "cur");

    // Promote to its own layer before animating, and move on the compositor:
    // translate3d avoids the per-frame layout+repaint that plain translateX on
    // a grid of images was costing.
    track.style.willChange = "transform";
    // A frame between "promote" and "move" — setting both in one paint means the
    // first animated frame is also the frame that uploads the new layer.
    requestAnimationFrame(() => {
      track.style.transition = `transform ${DISC_SLIDE_MS}ms cubic-bezier(0.33, 0.0, 0.15, 1.0)`;
      track.style.transform = `translate3d(${-dir * DISC_STEP_PCT}%, 0, 0)`;
    });
  },

  _discSlotHtml(id, cls) {
    const d = disciplineById(id);
    if (!d) return `<div class="disc-slot ${cls}"></div>`;
    return `<div class="disc-slot ${cls}">
      <img class="disc-icon" src="${escapeHtml(d.icon)}" />
      <span class="disc-name">${escapeHtml(d.label)}${d.homebrew ? " ✦" : ""}</span>
    </div>`;
  },

  _paintDiscipline() {
    const ids = this._disciplines.map((d) => d.id);
    const i = ids.indexOf(this._spec.discipline);
    const n = ids.length;

    // Five slots centred on the current one, wrapping. With n < 5 the outer
    // slots legitimately repeat an id already on screen — that is what a short
    // reel looks like, and it is only ever visible mid-slide anyway.
    const track = this._root.querySelector("[data-disc-track]");
    let html = "";
    for (let s = 0; s < DISC_SLOTS; s++) {
      const offset = s - DISC_CENTER;
      const id = (n > 1 || offset === 0) ? ids[((i + offset) % n + n) % n] : null;
      html += this._discSlotHtml(id, s === DISC_CENTER ? "cur" : "side");
    }
    track.innerHTML = html;

    const d = disciplineById(this._spec.discipline);
    const rowEl = this._root.querySelector('[data-row="discipline"]');
    rowEl.title = d.blurb;
    // A single performable discipline has nothing to scroll to.
    rowEl.classList.toggle("solo", n < 2);
    this._renderAltAttrs();
  },

  /**
   * The alternate attribute pair exists only for Chimerism (MIG+WLP instead of
   * INS+WLP), so its switch is hidden for every other discipline — and hiding
   * it must also clear the flag, or a ritual could carry an invisible MIG+WLP.
   */
  _renderAltAttrs() {
    const d = disciplineById(this._spec.discipline);
    const el = this._root.querySelector('[data-row="altattr"]');
    const available = Boolean(d?.altAttrs);
    el.hidden = !available;
    if (!available) this._spec.useAltAttrs = false;
    el.classList.toggle("on", this._spec.useAltAttrs);
    el.title = available
      ? `Roll ${d.altAttrs.join(" + ")} instead of ${d.attrs.join(" + ")}`
      : "";
    // Never leave the cursor parked on a row that just disappeared.
    if (!available && this._row === "altattr") this._focus("group", { silent: true });
  },

  _toggleAltAttrs() {
    this._spec.useAltAttrs = !this._spec.useAltAttrs;
    this._renderAltAttrs();
    playRitualSfx("SELECT");
  },

  /** The value currently ARRIVING in a host — never one that is on its way out. */
  _liveLayerText(host) {
    const live = host.querySelectorAll(".v-layer:not(.exit)");
    return live.length ? live[live.length - 1].textContent : null;
  },

  _renderPotencyArea(dir = 0) {
    const p = Object.values(POTENCY).find((x) => x.id === this._spec.potency);
    const a = Object.values(AREA).find((x) => x.id === this._spec.area);
    const pHost = this._root.querySelector("[data-potency-val]");
    const aHost = this._root.querySelector("[data-area-val]");
    if (this._liveLayerText(pHost) !== p.label) this._swapValue(pHost, p.label, dir);
    if (this._liveLayerText(aHost) !== a.label) this._swapValue(aHost, a.label, dir);
    pHost.closest(".oni-ritual-scroll").title = p.example;
    aHost.closest(".oni-ritual-scroll").title = a.example;

    // Grey the arrow that no longer leads anywhere, so the clamp is visible
    // before it is heard.
    this._markEnds("potency", POTENCY_ORDER, this._spec.potency);
    this._markEnds("area", AREA_ORDER, this._spec.area);
  },

  _markEnds(row, order, current) {
    const el = this._root.querySelector(`[data-row="${row}"]`);
    const i = order.indexOf(current);
    el.querySelector('.arrow[data-dir="-1"]').classList.toggle("spent", i <= 0);
    el.querySelector('.arrow[data-dir="1"]').classList.toggle("spent", i >= order.length - 1);
  },

  _renderMaterial() {
    const btn = this._root.querySelector('[data-row="material"]');
    const label = btn.querySelector("[data-mat-label]");
    const crystal = btn.querySelector(".mat-crystal");
    const m = this._spec.material;
    btn.classList.toggle("offered", Boolean(m));
    if (!m) {
      crystal.src = RITUAL_MATERIAL_ICON;
      label.textContent = "Offer Material";
      // The outline is a ::before copy of this attribute — keep it in sync or
      // the label loses its stroke.
      label.dataset.text = "Offer Material";
      btn.title = "Offer a rare or powerful ingredient to reduce the cost.";
      return;
    }
    // The offered material takes over the prefix slot — showing both its icon
    // and a generic crystal would read as two separate ingredients.
    crystal.src = m.img;
    label.innerHTML = `${escapeHtml(m.name)}<span class="mat-off">−${Math.round(m.discount * 100)}%</span>`;
    label.dataset.text = m.name;
    btn.title = `${m.name} (${m.rarity}) — click to change or clear`;
  },

  _renderGroup() {
    this._root.querySelector('[data-row="group"]').classList.toggle("on", this._spec.groupCheck);
  },

  _toggleGroup() {
    this._spec.groupCheck = !this._spec.groupCheck;
    this._renderGroup();
    playRitualSfx("SELECT");
  },

  async _openMaterialPicker() {
    if (this._pickerOpen) return;
    this._pickerOpen = true;
    try {
      const picked = await openMaterialPicker({
        performer: this._performer,
        current: this._spec.material,
      });
      // undefined = dismissed, null = explicitly cleared, object = chosen.
      if (picked !== undefined) {
        this._spec.material = picked;
        this._renderMaterial();
        this._refreshFinalize();
      }
    } finally {
      this._pickerOpen = false;
      this._updateCursor();
    }
  },

  // ── Finalize panel ───────────────────────────────────────────────────────
  //
  // The one place a number is shown. No formula: the performer is choosing a
  // ritual, not auditing arithmetic. Everything goes red when it cannot be
  // performed, and only then does a shortage report appear.
  /**
   * Count a number up or down to its new value.
   *
   * `_shown` remembers what is on screen because the DOM text carries a suffix
   * and re-parsing it back out would be one more thing to get wrong. A null
   * previous value means "first paint" — snap, do not roll.
   */
  _rollNumber(el, key, to, suffix = "") {
    const from = this._shown[key];
    this._shown[key] = to;
    if (from === null || from === to) { el.textContent = `${to}${suffix}`; return; }

    const t0 = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - t0) / ROLL_MS);
      const eased = 1 - Math.pow(1 - t, 3);          // ease-out cubic
      el.textContent = `${Math.round(from + (to - from) * eased)}${suffix}`;
      // Bail if the window closed or another roll superseded this one.
      if (t < 1 && this._root && this._shown[key] === to) requestAnimationFrame(tick);
      else if (this._shown[key] === to && el.isConnected) el.textContent = `${to}${suffix}`;
    };
    requestAnimationFrame(tick);
  },

  _refreshFinalize() {
    const cost = computeCost({ ...this._spec, materialRarity: this._spec.material?.rarity ?? null });
    if (!cost) return;

    const mp = currentMp(this._performer.actor);
    const affordable = canAfford(this._performer.actor, cost);
    const short = shortfall(this._performer.actor, cost);

    this._root.querySelector("[data-mp]").textContent = String(mp);

    const panel = this._root.querySelector(".oni-ritual-final");
    panel.classList.toggle("short", !affordable);

    this._rollNumber(this._root.querySelector("[data-fin-cost]"), "mp", cost.mp, " MP");
    this._rollNumber(this._root.querySelector("[data-fin-dl]"), "dl", cost.dl);

    const note = this._root.querySelector("[data-fin-note]");
    if (!affordable) note.textContent = `${short} MP short`;
    else if (cost.saved > 0) note.textContent = `${cost.saved} MP saved by the offering`;
    else note.textContent = "";

    const castBtn = this._root.querySelector('[data-act="cast"]');
    castBtn.disabled = this._casting || (!affordable && !game.user?.isGM);
    castBtn.textContent = this._casting ? "Performing…"
      : (!affordable && game.user?.isGM) ? "Perform Anyway"
      : "Perform";
  },

  // ── Focus + engagement + feather cursor ──────────────────────────────────

  /** Enter or leave a scroll row. Only scroll rows can be engaged. */
  _setEngaged(on) {
    const next = Boolean(on) && SCROLL_ROWS.has(this._row);
    this._engaged = next;
    for (const el of this._root.querySelectorAll(".oni-ritual-focusable")) {
      el.classList.toggle("engaged", next && el.dataset.row === this._row);
    }
  },

  /** Is this control on screen? The MIG+WLP switch only exists for Chimerism. */
  _rowVisible(row) {
    const el = this._root?.querySelector(`.oni-ritual-focusable[data-row="${row}"]`);
    return Boolean(el) && !el.hidden;
  },

  _focus(row, { silent = false, noFocusSteal = false } = {}) {
    if (!ROWS.includes(row) || !this._rowVisible(row)) return;
    const changed = this._row !== row;
    this._row = row;
    // Moving off a row always releases it; an engaged row you are no longer
    // standing on would keep eating ←/→.
    if (changed) this._setEngaged(false);
    if (changed && !silent) playRitualSfx("MOVE");

    for (const el of this._root.querySelectorAll(".oni-ritual-focusable")) {
      el.classList.toggle("focused", el.dataset.row === row);
    }
    // Leaving the intent box must drop DOM focus, or the key handler stays down.
    if (row !== "intent" && !noFocusSteal) this._root.querySelector('[data-field="description"]')?.blur();
    this._updateCursor();
  },

  // Feather cursor — same mechanism as the Healing HUD: absolute placement from
  // getBoundingClientRect, no transition on first show, float animation after.
  _updateCursor() {
    if (!this._cursorEl || !this._root) return;
    const el = this._root.querySelector(`.oni-ritual-focusable[data-row="${this._row}"]`);
    if (!el) { this._cursorEl.classList.remove("is-visible"); return; }
    const r = el.getBoundingClientRect();
    const x = r.left, y = r.top + r.height / 2;
    if (!this._cursorReady) {
      this._cursorEl.classList.add("no-anim");
      this._cursorEl.style.left = `${x}px`; this._cursorEl.style.top = `${y}px`;
      this._cursorEl.classList.add("is-visible");
      requestAnimationFrame(() => this._cursorEl?.classList.remove("no-anim"));
      this._cursorReady = true;
    } else {
      this._cursorEl.style.left = `${x}px`; this._cursorEl.style.top = `${y}px`;
      this._cursorEl.classList.add("is-visible");
    }
  },

  // ── Keyboard ─────────────────────────────────────────────────────────────
  _installKeyboard() {
    this._keyHandler = (ev) => {
      if (!this._root) return;
      // The material picker owns the keyboard while it is open.
      if (this._pickerOpen) return;
      // The intent textarea owns every key while it holds focus, or typing "x"
      // in a sentence would close the window.
      if (document.activeElement?.matches?.('[data-field="description"]')) return;

      const idx = ROWS.indexOf(this._row);

      // ── Engaged: the row owns ←/→, and Z/X hand it back ──────────────────
      //
      // A scroll row must be entered before its value moves. Otherwise ←/→ is
      // overloaded — it would both walk between Potency and Area and change
      // whichever one you were standing on, and there is no way to reach Area
      // from Potency with the keyboard at all.
      if (this._engaged) {
        if (keyMatch(ev, RITUAL_KEYS.LEFT) || keyMatch(ev, RITUAL_KEYS.RIGHT)) {
          ev.preventDefault(); ev.stopPropagation();
          this._cycle(this._row, keyMatch(ev, RITUAL_KEYS.RIGHT) ? 1 : -1);
          return;
        }
        if (keyMatch(ev, RITUAL_KEYS.CONFIRM) || keyMatch(ev, RITUAL_KEYS.CANCEL)) {
          ev.preventDefault(); ev.stopPropagation();
          this._setEngaged(false);
          playRitualSfx(keyMatch(ev, RITUAL_KEYS.CONFIRM) ? "SELECT" : "CANCEL");
          return;
        }
        if (keyMatch(ev, RITUAL_KEYS.UP) || keyMatch(ev, RITUAL_KEYS.DOWN)) {
          // Leaving the row vertically releases it rather than trapping the user.
          this._setEngaged(false);
        }
      }

      if (keyMatch(ev, RITUAL_KEYS.CANCEL)) { ev.preventDefault(); ev.stopPropagation(); this.close(); return; }

      if (keyMatch(ev, RITUAL_KEYS.UP) || keyMatch(ev, RITUAL_KEYS.DOWN)) {
        ev.preventDefault(); ev.stopPropagation();
        const step = keyMatch(ev, RITUAL_KEYS.DOWN) ? 1 : -1;
        // Jump clear of the whole visual row: ↓ from Potency reaches Material,
        // never sideways to Area. Hidden controls are not landing spots.
        const here = groupOf(this._row);
        let next = idx + step;
        while (ROWS[next] && ((here && here.includes(ROWS[next])) || !this._rowVisible(ROWS[next]))) next += step;
        if (ROWS[next]) this._focus(ROWS[next]);
        return;
      }

      if (keyMatch(ev, RITUAL_KEYS.LEFT) || keyMatch(ev, RITUAL_KEYS.RIGHT)) {
        ev.preventDefault(); ev.stopPropagation();
        // Disengaged, ←/→ always walks sideways — never changes a value.
        const dir = keyMatch(ev, RITUAL_KEYS.RIGHT) ? 1 : -1;
        const members = (groupOf(this._row) ?? []).filter((r) => this._rowVisible(r));
        const at = members.indexOf(this._row);
        const target = members[at + dir];
        if (target) this._focus(target);
        return;
      }

      if (keyMatch(ev, RITUAL_KEYS.CONFIRM)) {
        ev.preventDefault(); ev.stopPropagation();
        if (SCROLL_ROWS.has(this._row)) { this._setEngaged(true); playRitualSfx("SELECT"); }
        else if (this._row === "confirm") this._cast();
        else if (this._row === "material") this._openMaterialPicker();
        else if (this._row === "group") this._toggleGroup();
        else if (this._row === "altattr") this._toggleAltAttrs();
        else if (this._row === "intent") this._root.querySelector('[data-field="description"]').focus();
        return;
      }
    };
    window.addEventListener("keydown", this._keyHandler, true);
  },

  // ── Cast ─────────────────────────────────────────────────────────────────
  async _cast() {
    if (this._casting) return;
    const cost = computeCost({ ...this._spec, materialRarity: this._spec.material?.rarity ?? null });
    if (!cost) return;

    const affordable = canAfford(this._performer.actor, cost);
    if (!affordable && !game.user?.isGM) { playRitualSfx("DENY"); return; }

    this._casting = true;
    this._refreshFinalize();
    // Only once the cast is actually committed — a DENY above returns first.
    playRitualSfx("PERFORM");

    const spec = {
      ...this._spec,
      // The GM re-resolves the material from this pointer; name/rarity/discount
      // on the client copy are display only and are never trusted.
      material: this._spec.material
        ? { actorUuid: this._spec.material.actorUuid, itemId: this._spec.material.itemId }
        : null,
    };
    const performerUuid = this._performer.uuid;
    const override = Boolean(game.user?.isGM) && !affordable;

    // `_casting` suppresses the cancel banner: this is a performance, not an
    // abandonment, and ritual-cast.js broadcasts its own "performs" line.
    this.close();
    try {
      await requestCast({ performerUuid, spec, override });
    } catch (e) {
      console.error(RITUAL_TAG, "cast failed", e);
      ui.notifications?.error("Ritual: the cast failed. See console.");
    }
  },
};

export { RitualHUD };
