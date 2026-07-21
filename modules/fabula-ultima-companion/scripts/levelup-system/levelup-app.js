// ============================================================================
// Character Level-Up System — the window.
//
//     FUCompanion.api.levelUp.open(actorUuid)
//
// A pure consumer of FUCompanion.api.levelUp: every control here calls the same
// spend/refund/pickHeroic a macro would, so nothing this window can do is
// something a script cannot. All authority lives GM-side; this only renders
// what getState() reports and relays clicks.
//
// It opens ANYWHERE so a player can plan a build mid-session, but it is
// read-only unless the gate is open (camp lobbies, or the title screen). The
// gate is re-checked GM-side on arrival, so a window left open when the party
// sets out cannot slip a write through — the read-only styling here is a
// courtesy, not the enforcement.
// ============================================================================

import { LEVELUP } from "./levelup-const.js";
import { renderDescription, keywordRowHTML, RICHTEXT_CSS } from "./levelup-richtext.js";

const STYLE_ID = "oni-levelup-styles";
const ROOT_ID = "oni-levelup";

const esc = (s) => String(s ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

// Strip authored HTML down to readable text, for titles and tooltips where
// markup would be noise.
const plain = (html) => {
  const d = document.createElement("div");
  d.innerHTML = String(html ?? "");
  return (d.textContent ?? "").replace(/\s+/g, " ").trim();
};

// Authored description → keyword row + formatted prose. Clamping is left to
// CSS so the markup survives; slicing an HTML string would cut mid-tag.
function describe(html, { clamp = true } = {}) {
  const { keywords, bodyHtml } = renderDescription(html);
  if (!keywords.length && !bodyHtml) return "";
  return keywordRowHTML(keywords) +
    (bodyHtml ? `<div class="lu-rt${clamp ? " is-clamped" : ""}">${bodyHtml}</div>` : "");
}

const api = () => globalThis.FUCompanion?.api?.levelUp ?? null;

// Failure codes → something a player can act on.
const REASON = {
  no_points: "No Skill Points to spend.",
  class_maxed: "That class is already at level 10.",
  skill_maxed: "That skill is already at its maximum level.",
  skill_not_in_class: "That skill doesn't belong to this class.",
  too_many_unmastered: "You already have three unmastered classes — master one before starting another.",
  char_level_cap: "Character level cap reached.",
  benefit_required: "Choose a bonus for this class first.",
  gate_closed: "Skill Points can only be spent while resting at camp, or from the title screen.",
  class_not_held: "You don't have any levels in that class.",
  skill_not_held: "You don't have that skill.",
  no_heroic_slot: "No Heroic Skill slots — master another class first.",
  requirement_not_met: "You don't meet that Heroic Skill's requirements yet.",
  requirement_unevaluable: "That requirement needs a GM to adjudicate.",
  heroic_not_available: "That Heroic Skill isn't available to you.",
  actor_not_found: "Character not found.",
  timeout: "The GM didn't respond — are they connected?",
  gm_only: "Only the GM can do that.",
};

function explain(res) {
  if (res?.reason === "would_orphan_heroic") {
    const names = (res.broken ?? []).map((b) => b.name).join(", ");
    return `Unlearn ${names} first — it depends on this class.`;
  }
  return REASON[res?.reason] ?? res?.message ?? "That didn't work.";
}

// ── styles ────────────────────────────────────────────────────────────────

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
#${ROOT_ID} { position: fixed; inset: 0; z-index: 70; display: flex;
  align-items: center; justify-content: center; background: rgba(0,0,0,.62); }
#${ROOT_ID} * { box-sizing: border-box; }
#${ROOT_ID} .lu-panel { width: min(1120px, 94vw); height: min(760px, 92vh);
  display: flex; flex-direction: column; border-radius: 10px; overflow: hidden;
  background: #efe4cd; border: 2px solid #6b543a;
  box-shadow: 0 18px 60px rgba(0,0,0,.55); font-family: Signika, sans-serif; color: #2f2618; }

#${ROOT_ID} .lu-head { display: flex; align-items: center; gap: 14px; padding: 10px 14px;
  background: linear-gradient(180deg,#5d4630,#4a371f); color: #f6ecd8; flex: 0 0 auto; }
#${ROOT_ID} .lu-head > img { width: 46px; height: 46px; border-radius: 6px; object-fit: cover;
  border: 1px solid #29200f; background: #1c1509; }
#${ROOT_ID} .lu-name { font-size: 19px; font-weight: 700; line-height: 1.1; }
#${ROOT_ID} .lu-sub { font-size: 12px; opacity: .8; }
#${ROOT_ID} .lu-sp { margin-left: auto; text-align: center; padding: 4px 14px; border-radius: 8px;
  background: #2b2110; border: 1px solid #8a6c45; min-width: 96px; }
#${ROOT_ID} .lu-sp b { display: block; font-size: 26px; line-height: 1; color: #ffd479; }
#${ROOT_ID} .lu-sp span { font-size: 10px; letter-spacing: .09em; text-transform: uppercase; opacity: .85; }
#${ROOT_ID} .lu-x { background: none; border: 0; color: #f6ecd8; font-size: 24px; cursor: pointer;
  padding: 0 4px; line-height: 1; }

/* Skill / Facet tabs — file-tab shapes rising out of the header */
#${ROOT_ID} .lu-tabs { display: flex; align-items: flex-end; gap: 3px; align-self: stretch;
  margin: 0 2px -10px; }
#${ROOT_ID} .lu-tab { font: inherit; font-size: 13px; font-weight: 700; cursor: pointer;
  padding: 7px 18px 9px; border: 1px solid #2f2313; border-bottom: 0;
  border-radius: 9px 9px 0 0; background: #4a3722; color: #cbb894; }
#${ROOT_ID} .lu-tab:hover { background: #57422a; color: #f2e6cf; }
#${ROOT_ID} .lu-tab.on { background: #efe4cd; color: #2f2618; border-color: #6b543a; }

/* Facet list — same row as a skill; learned at full strength, rest dimmed */
#${ROOT_ID} .lu-frow.have { border-color: #5f8b3c; background: #eef6e5;
  box-shadow: 0 0 0 1px rgba(95,139,60,.3) inset; }
#${ROOT_ID} .lu-frow.have .lu-pips { color: #3f6b23; font-weight: 700; }
#${ROOT_ID} .lu-frow.away { border-color: #a3706f; background: #f6e9e9; }
#${ROOT_ID} .lu-tabdot { display: inline-block; min-width: 16px; padding: 0 4px; margin-left: 4px;
  border-radius: 8px; background: #d9a326; color: #2b2110; font-size: 11px; font-weight: 800; }

#${ROOT_ID} .lu-note { padding: 7px 14px; font-size: 12.5px; flex: 0 0 auto; }
#${ROOT_ID} .lu-note.warn { background: #f6e2b8; border-bottom: 1px solid #c9a768; color: #4a3306; }
#${ROOT_ID} .lu-note.drift { background: #f3d3d3; border-bottom: 1px solid #c08585; color: #5c1f1f;
  display: flex; align-items: center; gap: 10px; }
#${ROOT_ID} .lu-note button { margin-left: auto; }

#${ROOT_ID} .lu-body { flex: 1 1 auto; display: flex; min-height: 0; }
#${ROOT_ID} .lu-rail { width: 232px; flex: 0 0 auto; overflow-y: auto; padding: 8px;
  background: #e2d3b6; border-right: 1px solid #b79c72; }
#${ROOT_ID} .lu-cls { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left;
  padding: 7px 9px; margin-bottom: 4px; border-radius: 7px; cursor: pointer;
  background: #f2e8d3; border: 1px solid #bda57e; font: inherit; color: inherit; }
#${ROOT_ID} .lu-cls:hover { background: #fbf4e4; }
#${ROOT_ID} .lu-cls.on { background: #5d4630; color: #f6ecd8; border-color: #3a2b17; }
#${ROOT_ID} .lu-cls > img { width: 26px; height: 26px; border-radius: 4px; object-fit: cover; flex: 0 0 auto; }
#${ROOT_ID} .lu-cls .n { flex: 1 1 auto; font-size: 13px; font-weight: 600; }
#${ROOT_ID} .lu-cls .l { font-size: 12px; font-variant-numeric: tabular-nums; opacity: .85; }
#${ROOT_ID} .lu-cls .star { color: #d9a326; }
#${ROOT_ID} .lu-cls.new { justify-content: center; background: #d9c9a6; border-style: dashed; font-weight: 600; }
#${ROOT_ID} .lu-railhead { font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase;
  opacity: .65; margin: 8px 4px 4px; }

#${ROOT_ID} .lu-main { flex: 1 1 auto; overflow-y: auto; padding: 12px 14px; }
#${ROOT_ID} .lu-h2 { display: flex; align-items: baseline; gap: 10px; margin: 0 0 4px; }
#${ROOT_ID} .lu-h2 b { font-size: 18px; }
#${ROOT_ID} .lu-h2 span { font-size: 12px; opacity: .7; }
#${ROOT_ID} .lu-lore { font-size: 12px; opacity: .75; margin-bottom: 10px; }

#${ROOT_ID} .lu-skill { display: flex; align-items: center; gap: 10px; padding: 8px 10px;
  border-radius: 8px; margin-bottom: 6px; background: #f7f0df; border: 1px solid #c6ae87; }
#${ROOT_ID} .lu-skill.max { border-color: #a98a4e; background: #f1e6c6; }

/* Not-yet-acquired rows read as locked — but ONLY the content dims. Dimming a
   live + or − button makes an available action look unavailable, which is the
   opposite of what the state is trying to say. */
#${ROOT_ID} .lu-skill.miss > img,
#${ROOT_ID} .lu-skill.miss > .t { opacity: .45; filter: saturate(.3); }
#${ROOT_ID} .lu-skill.miss:hover > img,
#${ROOT_ID} .lu-skill.miss:hover > .t { opacity: .78; filter: saturate(.7); }
#${ROOT_ID} .lu-skill.miss { background: #f3ece0; }

#${ROOT_ID} .lu-learned { font-size: 11.5px; font-weight: 700; font-style: italic;
  opacity: .5; white-space: nowrap; letter-spacing: .02em; }
/* Direct child ONLY. As a descendant selector this also matched the inline
   keyword glyphs inside the description and blew them up to 34px — and at
   (1,1,1) it outranked the (1,1,0) rule meant to size them. */
#${ROOT_ID} .lu-skill > img { width: 34px; height: 34px; border-radius: 5px; object-fit: cover; flex: 0 0 auto; }
#${ROOT_ID} .lu-skill .t { flex: 1 1 auto; min-width: 0; }
#${ROOT_ID} .lu-skill .t b { font-size: 13.5px; }
#${ROOT_ID} .lu-skill .t .lu-rt { margin-top: 2px; font-size: 11.5px; opacity: .78; }
/* Clamp by line box rather than by slicing the HTML — cutting a markup string
   at N characters lands mid-tag and mangles the formatting. */
#${ROOT_ID} .lu-rt.is-clamped { display: -webkit-box; -webkit-line-clamp: 3;
  -webkit-box-orient: vertical; overflow: hidden; }
#${ROOT_ID} .lu-pips { font-size: 12.5px; font-variant-numeric: tabular-nums; white-space: nowrap; opacity: .8; }
#${ROOT_ID} .lu-btn { width: 28px; height: 28px; border-radius: 6px; cursor: pointer; font-size: 16px;
  line-height: 1; border: 1px solid #8a6c45; background: #e8d9b8; color: #2f2618; flex: 0 0 auto; }
#${ROOT_ID} .lu-btn:hover:not(:disabled) { background: #fff6e2; }
#${ROOT_ID} .lu-btn:disabled { opacity: .3; cursor: not-allowed; }
#${ROOT_ID} .lu-btn.buy { background: #d8e8c8; border-color: #6f8a52; }
#${ROOT_ID} .lu-btn.sell { background: #eedada; border-color: #a3706f; }

#${ROOT_ID} .lu-heroic { margin-top: 16px; padding-top: 10px; border-top: 2px solid #c0a67c; }
#${ROOT_ID} .lu-heroic h3 { margin: 0 0 6px; font-size: 14px; }
#${ROOT_ID} .lu-req { margin: 3px 0 0; font-size: 11px; color: #7a3d10; }
#${ROOT_ID} .lu-req.ok { color: #3f6b23; }
#${ROOT_ID} .lu-empty { font-size: 12.5px; opacity: .7; padding: 10px 2px; }
#${ROOT_ID} .lu-tag { font-size: 10px; padding: 1px 6px; border-radius: 9px; background: #d9c9a6;
  border: 1px solid #b79c72; }

/* staged, unwritten values */
#${ROOT_ID} .moved { color: #1f6f3f; font-weight: 700; }
#${ROOT_ID} .lu-sp.staged { border-color: #6f9c55; box-shadow: 0 0 0 1px #6f9c55 inset; }
#${ROOT_ID} .lu-sp.staged b { color: #b6f08a; }
#${ROOT_ID} .lu-tag.moved { background: #cfe6bd; border-color: #6f9c55; color: #234f14; }

#${ROOT_ID} .lu-foot { flex: 0 0 auto; display: flex; align-items: center; gap: 10px;
  padding: 9px 14px; background: #ded0b1; border-top: 2px solid #b79c72; }
#${ROOT_ID} .lu-foottext { flex: 1 1 auto; font-size: 12px; min-width: 0; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
#${ROOT_ID} .lu-cta { padding: 6px 16px; border-radius: 7px; cursor: pointer; font: inherit;
  font-size: 13px; font-weight: 600; border: 1px solid #8a6c45; }
#${ROOT_ID} .lu-cta.go { background: #3f6b23; border-color: #2b4a15; color: #f2ffe6; }
#${ROOT_ID} .lu-cta.go:hover { background: #4d8029; }
#${ROOT_ID} .lu-cta.ghost { background: #efe4cd; color: #4a3a22; }
#${ROOT_ID} .lu-cta.ghost:hover { background: #fbf4e4; }

#${ROOT_ID} .lu-picker { position: absolute; inset: 0; display: flex; align-items: center;
  justify-content: center; background: rgba(0,0,0,.45); }
#${ROOT_ID} .lu-pickpanel { width: min(620px, 88vw); height: min(640px, 84vh); }
#${ROOT_ID} .lu-pickpanel .lu-head { gap: 10px; }
#${ROOT_ID} .lu-pickpanel .lu-main { flex: 1 1 auto; min-height: 0; }

/* Facet picker — layered above the class browser */
#${ROOT_ID} .lu-facet { position: absolute; inset: 0; display: flex; align-items: center;
  justify-content: center; background: rgba(0,0,0,.55); }
#${ROOT_ID} .lu-facetpanel { width: min(660px, 90vw); height: min(680px, 86vh); }
#${ROOT_ID} .lu-confirmpanel { height: auto; max-height: min(560px, 82vh); }
#${ROOT_ID} .lu-facetpanel .lu-main { flex: 1 1 auto; min-height: 0; }
#${ROOT_ID} .lu-fbtn { display: block; width: 100%; text-align: left; font: inherit; color: inherit;
  padding: 9px 12px; margin-bottom: 7px; border-radius: 8px; cursor: pointer;
  background: #f7f0df; border: 1px solid #c6ae87; }
#${ROOT_ID} .lu-fbtn:hover { background: #fffaec; border-color: #a98a4e; }
#${ROOT_ID} .lu-fbtn b { font-size: 13.5px; }
#${ROOT_ID} .lu-fbtn .lu-rt { margin-top: 3px; font-size: 11.5px; opacity: .78; }
#${ROOT_ID} .lu-fhead { display: flex; align-items: center; gap: 8px; }
/* The global sheet stylesheet puts a border on every img; these are inline
   glyphs and must not inherit it. */
#${ROOT_ID} .lu-fhead > img { width: 26px; height: 26px; object-fit: contain; flex: 0 0 auto;
  border: 0 !important; outline: 0 !important; background: none; border-radius: 4px; }
#${ROOT_ID} .lu-fbtn.is-on { background: #dceccb; border-color: #5f8b3c; box-shadow: 0 0 0 1px #5f8b3c inset; }
#${ROOT_ID} .lu-fbtn.is-on b { color: #2c5216; }
#${ROOT_ID} .lu-btn.edit { background: #e3dcf1; border-color: #7a6aa3; }
${RICHTEXT_CSS(`#${ROOT_ID}`)}
`;
  document.head.appendChild(s);
}

// ── window ────────────────────────────────────────────────────────────────

const LevelUpApp = {
  _root: null,
  _actorUuid: null,
  _selected: null,      // class key — may be a class not yet taken
  _pickerOpen: false,   // the new-class browser, layered over the main window
  _facet: null,         // the Facet picker, layered above everything
  _tab: "skill",        // "skill" | "facet" — what the main pane shows
  _busy: false,

  // Staged, unwritten changes. Nothing touches the actor until Confirm.
  //
  // Besides being what a player wants (try a build, back out of it), this is
  // what keeps the sheet consistent: a spend writes the class row, the skill
  // and the point counter as three updates, and re-rendering between them
  // showed a drift warning for the instant the books didn't balance. Batching
  // means the window never observes a half-applied spend.
  _pending: [],         // [{ op:"spend"|"refund"|"heroic", classKey, skillUuid, benefit }]
  _applying: false,

  get isOpen() { return Boolean(this._root?.isConnected); },

  open(actorUuid) {
    const uuid = actorUuid ?? this._guessActor();
    if (!uuid) return ui.notifications?.warn?.("No character selected.");
    injectStyles();

    this._actorUuid = uuid;
    if (this.isOpen) return this.render();

    const root = document.createElement("div");
    root.id = ROOT_ID;
    root.innerHTML = `<div class="lu-panel"></div>`;
    document.body.appendChild(root);
    this._root = root;

    root.addEventListener("mousedown", (ev) => { if (ev.target === root) this.close(); });
    root.addEventListener("click", (ev) => this._onClick(ev));
    this._onKey = (ev) => { if (ev.key === "Escape") this.close(); };
    document.addEventListener("keydown", this._onKey);

    // Any change to the actor (a GM edit, another client's spend) re-renders.
    this._hook = Hooks.on("updateActor", (doc) => {
      if (doc?.uuid === this._actorUuid) this.render();
    });
    this._itemHook = Hooks.on("createItem", (i) => { if (i?.parent?.uuid === this._actorUuid) this.render(); });
    this._itemHook2 = Hooks.on("deleteItem", (i) => { if (i?.parent?.uuid === this._actorUuid) this.render(); });

    this.render();
  },

  close() {
    // Staged changes were never written; dropping them is the same as Discard.
    this._pending = [];
    this._facet = null;
    document.removeEventListener("keydown", this._onKey);
    if (this._hook) Hooks.off("updateActor", this._hook);
    if (this._itemHook) Hooks.off("createItem", this._itemHook);
    if (this._itemHook2) Hooks.off("deleteItem", this._itemHook2);
    this._root?.remove();
    this._root = null;
  },

  toggle(uuid) { this.isOpen ? this.close() : this.open(uuid); },

  // The character this user is here to level: their assigned actor, else a
  // selected token, else nothing.
  _guessActor() {
    const owned = game.user?.character?.uuid;
    if (owned) return owned;
    const tok = canvas?.tokens?.controlled?.[0]?.actor?.uuid;
    return tok ?? null;
  },

  // ── projection ──────────────────────────────────────────────────────────

  /**
   * Fold the staged operations over the real state so the window can show what
   * the character WOULD look like. Returns deltas keyed by class and skill,
   * plus the resulting Skill Point balance.
   */
  _project(s) {
    const classDelta = new Map();
    const skillDelta = new Map();
    let points = s.points.stored;
    const bump = (m, k, d) => m.set(k, (m.get(k) ?? 0) + d);

    for (const p of this._pending) {
      if (p.op === "heroic") continue;           // heroics are free
      const d = p.op === "spend" ? 1 : -1;
      bump(classDelta, p.classKey, d);
      bump(skillDelta, p.skillUuid, d);
      points -= d;
    }
    return { classDelta, skillDelta, points, heroics: this._pending.filter((p) => p.op === "heroic") };
  },

  _classLevel(s, cls, proj) { return cls.level + (proj.classDelta.get(cls.key) ?? 0); },
  _skillLevel(sk, proj) { return sk.level + (proj.skillDelta.get(sk.uuid) ?? 0); },

  /** Non-mastered classes after staging — for the p.227 three-class limit. */
  _projectedUnmastered(s, proj) {
    let n = 0;
    for (const c of s.classes) {
      const lvl = this._classLevel(s, c, proj);
      if (lvl > 0 && lvl < s.rules.maxClassLevel) n += 1;
    }
    return n;
  },

  // ── render ──────────────────────────────────────────────────────────────

  render() {
    if (!this.isOpen || this._applying) return;
    const s = api()?.getState(this._actorUuid);
    const panel = this._root.querySelector(".lu-panel");
    if (!s?.ok) {
      panel.innerHTML = `<div class="lu-empty" style="padding:24px">Could not read that character.</div>`;
      return;
    }

    const proj = this._project(s);
    // A class with staged levels counts as "taken" for the rail, so a class
    // opened this session appears immediately rather than after Confirm.
    const taken = s.classes
      .filter((c) => c.taken || this._classLevel(s, c, proj) > 0)
      .sort((a, b) => b.level - a.level || a.name.localeCompare(b.name));
    if (!this._selected || !s.classes.some((c) => c.key === this._selected)) {
      this._selected = taken[0]?.key ?? null;
    }

    panel.innerHTML =
      this._head(s, proj) + this._notes(s) +
      `<div class="lu-body">
         <div class="lu-rail">${this._rail(s, taken, proj)}</div>
         <div class="lu-main">${this._main(s, proj)}</div>
       </div>` +
      this._footer(s, proj);

    // The new-class browser is its own window layered over this one, so the
    // rail stays a short list of what you actually play.
    this._root.querySelector(`#${ROOT_ID}-picker`)?.remove();
    if (this._pickerOpen) {
      const p = document.createElement("div");
      p.id = `${ROOT_ID}-picker`;
      p.className = "lu-picker";
      p.innerHTML = `<div class="lu-panel lu-pickpanel">${this._picker(s)}</div>`;
      p.addEventListener("mousedown", (ev) => { if (ev.target === p) { this._pickerOpen = false; this.render(); } });
      this._root.appendChild(p);
    }

    // Facet picker sits above everything, including the class browser — it is
    // a decision the player is mid-way through and must resolve or dismiss.
    this._root.querySelector(`#${ROOT_ID}-facet`)?.remove();
    if (this._facet) {
      const wrap = document.createElement("div");
      wrap.innerHTML = this._facetOverlay();
      const el = wrap.firstElementChild;
      if (el) {
        // The id must land on the element actually appended, or the next
        // render cannot find it to remove and overlays stack up.
        el.id = `${ROOT_ID}-facet`;
        this._root.appendChild(el);
      }
    }
  },

  _head(s, proj) {
    const gate = s.gate.open
      ? `<span class="lu-tag">Spending open — ${esc(s.gate.where)}</span>`
      : `<span class="lu-tag">Viewing only</span>`;
    const staged = proj.points !== s.points.stored;
    return `<div class="lu-head">
      <img src="${esc(s.actor.img)}" alt="">
      <div>
        <div class="lu-name">${esc(s.actor.name)}</div>
        <div class="lu-sub">Level ${esc(s.level)} · ${s.classLevelTotal} class levels · ${gate}</div>
      </div>
      <div class="lu-sp ${staged ? "staged" : ""}"><b>${proj.points}</b>
        <span>${staged ? `Skill Points (was ${s.points.stored})` : "Skill Points"}</span></div>
      <div class="lu-tabs">
        <button class="lu-tab ${this._tab === "skill" ? "on" : ""}" data-act="tab" data-tab="skill">Skill</button>
        <button class="lu-tab ${this._tab === "facet" ? "on" : ""}" data-act="tab" data-tab="facet">Facet</button>
        <button class="lu-tab ${this._tab === "heroic" ? "on" : ""}" data-act="tab" data-tab="heroic">Heroic${
          s.heroic.open ? ` <span class="lu-tabdot">${s.heroic.open}</span>` : ""}</button>
      </div>
      <button class="lu-x" data-act="close" title="Close">×</button>
    </div>`;
  },

  _notes(s) {
    let html = "";
    if (!s.gate.open) {
      html += `<div class="lu-note warn">${esc(s.gate.reason)} You can still browse and plan.</div>`;
    }
    // Drift is a GM concern — a player can neither cause nor fix one. Hidden
    // while changes are staged: mid-edit the books legitimately don't balance,
    // and flashing a corruption warning during normal use is just noise.
    if (s.points.drift && game.user?.isGM && !this._pending.length) {
      html += `<div class="lu-note drift">
        <span>Skill Points read <b>${s.points.stored}</b> but level minus class levels gives <b>${s.points.expected}</b>.</span>
        <button class="lu-btn" style="width:auto;padding:2px 10px" data-act="heal">Fix</button>
      </div>`;
    }
    return html;
  },

  _rail(s, taken, proj) {
    const row = (c) => {
      const lvl = this._classLevel(s, c, proj);
      const moved = lvl !== c.level;
      return `<button class="lu-cls ${this._selected === c.key ? "on" : ""}" data-act="pick" data-key="${esc(c.key)}">
        <img src="${esc(c.img)}" alt="">
        <span class="n">${lvl >= s.rules.maxClassLevel ? "⭐ " : ""}${esc(c.name)}</span>
        <span class="l ${moved ? "moved" : ""}">${lvl}/${s.rules.maxClassLevel}</span>
      </button>`;
    };

    // A class chosen from the browser but not yet paid for shows here as
    // pending, so the rail still explains where the main pane came from.
    const pending = this._selected && !taken.some((c) => c.key === this._selected)
      ? s.classes.find((c) => c.key === this._selected)
      : null;

    return `<div class="lu-railhead">Classes</div>` +
      (taken.length ? taken.map(row).join("") : `<div class="lu-empty">No classes yet.</div>`) +
      (pending ? `<div class="lu-railhead">Starting</div>${row(pending)}` : "") +
      `<button class="lu-cls new" data-act="openpicker">＋ New Class</button>`;
  },

  _main(s, proj) {
    // Heroic Skills are not a property of the selected class — the pick is
    // free across every class — so that tab renders without one.
    if (this._tab === "heroic") return this._heroicTab(s);

    const cls = s.classes.find((c) => c.key === this._selected);
    if (!cls) {
      return `<div class="lu-empty">No classes yet — use <b>＋ New Class</b> to start one.</div>`;
    }

    if (this._tab === "facet") return this._facetGrid(s, cls);

    const clsLevel = this._classLevel(s, cls, proj);
    const opening = clsLevel === 0;   // staging the first level would open it
    const wouldExceedLimit =
      opening && this._projectedUnmastered(s, proj) >= s.rules.maxUnmastered;

    const skills = cls.skills.map((sk) => {
      const lvl = this._skillLevel(sk, proj);
      const moved = lvl !== sk.level;
      const atMax = lvl >= sk.maxLevel;
      const canBuy = s.gate.open && proj.points > 0 && !atMax
        && clsLevel < s.rules.maxClassLevel && !wouldExceedLimit;
      return `<div class="lu-skill ${atMax ? "max" : ""} ${lvl === 0 ? "miss" : ""}">
        <img src="${esc(sk.img)}" alt="">
        <div class="t">
          <b>${esc(sk.name)}</b>${sk.cost ? ` <span class="lu-tag">${esc(sk.cost)}</span>` : ""}
          ${describe(sk.description)}
        </div>
        <span class="lu-pips ${moved ? "moved" : ""}">${lvl} / ${sk.maxLevel}</span>
        ${this._facetEditBtn(sk)}
        <button class="lu-btn sell" data-act="refund" data-key="${esc(cls.key)}" data-uuid="${esc(sk.uuid)}"
          ${s.gate.open && lvl > 0 ? "" : "disabled"} title="Give back a level">−</button>
        <button class="lu-btn buy" data-act="spend" data-key="${esc(cls.key)}" data-uuid="${esc(sk.uuid)}"
          ${canBuy ? "" : "disabled"} title="Spend a Skill Point">+</button>
      </div>`;
    }).join("");

    const mastered = clsLevel >= s.rules.maxClassLevel;
    const note = wouldExceedLimit
      ? `<div class="lu-note warn" style="border-radius:7px;margin-bottom:10px">You already have ${s.rules.maxUnmastered} unmastered classes — take one to level 10 before starting another.</div>`
      : opening
        ? `<div class="lu-lore">You don't have this class yet — buying any skill below starts it at level 1.</div>`
        : "";

    return `<div class="lu-h2"><b>${mastered ? "⭐ " : ""}${esc(cls.name)}</b>
        <span>${clsLevel}/${s.rules.maxClassLevel}${mastered ? " · mastered" : ""}${cls.benefit ? ` · ${esc(LEVELUP.BENEFIT_LABEL[cls.benefit] ?? cls.benefit)}` : ""}</span></div>
      ${note}
      ${skills || `<div class="lu-empty">This class has no skills authored.</div>`}`;
  },

  // Revisit a Facet choice that is staged but not yet written. Only offered
  // while the batch is unconfirmed — afterwards the items exist on the sheet
  // and are the GM's to manage.
  _facetEditBtn(sk) {
    const idx = this._pending.findIndex(
      (p) => p.skillUuid === sk.uuid && Array.isArray(p.facetUuids) && p.facetUuids.length
    );
    if (idx < 0) return "";
    const n = this._pending[idx].facetUuids.length;
    return `<button class="lu-btn edit" data-act="facetedit" data-idx="${idx}"
      title="Change the ${n === 1 ? "chosen one" : `${n} chosen`}">✎</button>`;
  },

  _footer(s, proj) {
    const n = this._pending.length;
    if (!n) return "";
    const summary = this._summarise(s, proj);
    return `<div class="lu-foot">
      <span class="lu-foottext">${esc(summary)}</span>
      <button class="lu-cta ghost" data-act="cancel" title="Throw away the staged changes and keep the window open">Discard</button>
      <button class="lu-cta go" data-act="confirm">Confirm ${n} change${n === 1 ? "" : "s"}</button>
    </div>`;
  },

  _summarise(s, proj) {
    const bits = [];
    for (const [key, d] of proj.classDelta) {
      if (!d) continue;
      const c = s.classes.find((x) => x.key === key);
      bits.push(`${c?.name ?? key} ${c ? c.level : 0} → ${this._classLevel(s, c ?? { key, level: 0 }, proj)}`);
    }
    for (const p of proj.heroics) bits.push(`Heroic: ${p.name ?? "skill"}`);
    const facetsIn = this._pending.filter((p) => p.op === "spend").flatMap((p) => p.facetUuids ?? []).length;
    const facetsOut = this._pending.filter((p) => p.op === "refund").flatMap((p) => p.facetUuids ?? []).length;
    if (facetsIn) bits.push(`+${facetsIn} facet${facetsIn === 1 ? "" : "s"}`);
    if (facetsOut) bits.push(`−${facetsOut} facet${facetsOut === 1 ? "" : "s"}`);
    const spent = s.points.stored - proj.points;
    const cost = spent > 0 ? `${spent} point${spent === 1 ? "" : "s"} spent` : `${-spent} point${spent === -1 ? "" : "s"} returned`;
    return `${bits.join(" · ")}  —  ${cost}`;
  },

  /**
   * Every Facet the class offers, learned ones first and at full strength,
   * the rest dimmed underneath — a collection board rather than a list, so a
   * player can see at a glance how much of a class they have collected.
   *
   * Read-only. Facets are acquired by taking a level in the skill that grants
   * them, never picked directly, so there is nothing to click here.
   */
  _facetGrid(s, cls) {
    const staged = new Set(
      this._pending.filter((p) => p.op === "spend").flatMap((p) => p.facetUuids ?? [])
    );
    const givingBack = new Set(
      this._pending.filter((p) => p.op === "refund").flatMap((p) => p.facetUuids ?? [])
    );

    if (!cls.facets.length) {
      return `<div class="lu-h2"><b>${esc(cls.name)}</b><span>Facets</span></div>
        <div class="lu-empty">This class has no Facets.</div>`;
    }

    const rank = (f) => {
      if (staged.has(f.uuid)) return 0;                      // about to be learned
      if (f.held) return givingBack.has(f.uuid) ? 2 : 1;     // held, or handing back
      return 3;                                              // not learned
    };
    const sorted = [...cls.facets].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    const have = cls.facets.filter((f) => (f.held && !givingBack.has(f.uuid)) || staged.has(f.uuid)).length;

    // Same one-column row as the skill list — this is the same kind of thing
    // being read, and two layouts for one class would just look like two pages.
    const row = (f) => {
      const r = rank(f);
      const note = r === 0 ? `<span class="lu-tag moved">staged</span>`
        : r === 2 ? `<span class="lu-tag">giving back</span>` : "";
      return `<div class="lu-skill lu-frow ${r <= 1 ? "have" : r === 2 ? "away" : "miss"}">
        <img src="${esc(f.img)}" alt="">
        <div class="t">
          <b>${esc(f.name)}</b>${f.cost ? ` <span class="lu-tag">${esc(f.cost)}</span>` : ""}${note}
          ${describe(f.description)}
        </div>
        ${r <= 1 ? `<span class="lu-learned">Learned</span>` : ""}
      </div>`;
    };

    const learned = sorted.filter((f) => rank(f) <= 1);
    const rest = sorted.filter((f) => rank(f) > 1);

    // The grant is what a player needs to know to collect more of these.
    const granter = cls.skills.find((k) => k.facetGrant > 0);
    const hint = granter
      ? `<div class="lu-lore">Learned by taking levels in <b>${esc(granter.name)}</b> — ${granter.facetGrant} per level.</div>`
      : `<div class="lu-lore">This class has no skill that grants Facets; these are acquired elsewhere.</div>`;

    return `<div class="lu-h2"><b>${esc(cls.name)}</b><span>${have} of ${cls.facets.length} learned</span></div>
      ${hint}
      ${learned.map(row).join("")}
      ${rest.length && learned.length ? `<div class="lu-railhead" style="margin:10px 2px 5px">Not yet learned</div>` : ""}
      ${rest.map(row).join("")}`;
  },

  /**
   * The Heroic tab: what the character has, then what they could take, then
   * what is out of reach — the same unlockable shape as the Facet board.
   *
   * Not scoped to the selected class. Mastering a class earns the pick but does
   * not limit it (§4 of the design doc), so this is a character-wide view.
   */
  _heroicTab(s) {
    const { open, earned, used, available, owned } = s.heroic;

    const head = `<div class="lu-h2"><b>Heroic Skills</b>
      <span>${earned ? `${open} of ${earned} slot${earned === 1 ? "" : "s"} open · ${used} taken`
                     : "master a class to earn one"}</span></div>`;

    const learnedRows = (owned ?? []).map((h) => `<div class="lu-skill lu-frow have">
      <img src="${esc(h.img)}" alt="">
      <div class="t">
        <b>${esc(h.name)}</b>${h.from ? ` <span class="lu-tag">${esc(h.from)}</span>` : ""}${
          h.granted ? ` <span class="lu-tag">from equipment</span>` : ""}
        ${describe(h.description)}
      </div>
      <span class="lu-learned">Learned</span>
    </div>`).join("");

    const met = available.filter((h) => h.relevance === "met");
    const close = available.filter((h) => h.relevance === "close");
    const distant = available.filter((h) => h.relevance === "distant");

    const takeable = open
      ? this._heroicRows(s, met)
      : met.length
        ? `<div class="lu-empty">${met.length} would be available — master another class to earn a slot.</div>`
        : "";

    const noneMet = open && !met.length
      ? `<div class="lu-empty">A slot is open, but you don't yet meet the requirements for any Heroic Skill.</div>`
      : "";

    return head +
      (learnedRows || `<div class="lu-empty">No Heroic Skills yet.</div>`) +
      (met.length && open ? `<div class="lu-railhead" style="margin:12px 2px 5px">Available now</div>` : "") +
      noneMet + takeable +
      (close.length ? `<div class="lu-railhead" style="margin:12px 2px 5px">Not yet available</div>` : "") +
      this._heroicRows(s, close) +
      (distant.length ? `<div class="lu-empty">${distant.length} more need classes you haven't taken.</div>` : "");
  },

  _heroicRows(s, list) {
    return list.map((h) => {
      const from = h.from.map((f) => f.name).join(" / ");
      const req = !h.evaluable
        ? `<p class="lu-req">Requirement needs a GM: “${esc(h.prose)}”</p>`
        : h.met ? "" : `<p class="lu-req">${h.clauses.filter((c) => !c.met).map((c) => esc(c.label)).join(" · ")}</p>`;
      const staged = this._pending.some((p) => p.op === "heroic" && p.skillUuid === h.skill.uuid);
      const canTake = s.gate.open && h.met && (s.heroic.open > 0 || staged);
      return `<div class="lu-skill lu-frow ${staged ? "have" : h.met ? "" : "miss"}">
        <img src="${esc(h.skill.img)}" alt="">
        <div class="t">
          <b>${esc(h.skill.name)}</b> <span class="lu-tag">${esc(from)}</span>${staged ? ` <span class="lu-tag moved">staged</span>` : ""}
          ${describe(h.skill.description)}${req}
        </div>
        <button class="lu-btn buy" data-act="heroic" data-uuid="${esc(h.skill.uuid)}" data-name="${esc(h.skill.name)}"
          ${canTake ? "" : "disabled"} title="${staged ? "Un-stage" : "Take this Heroic Skill (free)"}">${staged ? "✓" : "★"}</button>
      </div>`;
    }).join("");
  },

  // Secondary window. Kept out of the rail on purpose — 42 classes would bury
  // the four or five a character actually plays.
  _picker(s) {
    const untaken = s.classes.filter((c) => !c.taken).sort((a, b) => a.name.localeCompare(b.name));
    const atLimit = s.unmastered >= s.rules.maxUnmastered;

    // Say WHY rather than silently greying every option out.
    const gateNote = atLimit
      ? `<div class="lu-note warn">
           You have ${s.unmastered} unmastered classes and the limit is ${s.rules.maxUnmastered}.
           Take one of them to level 10 before starting another.
         </div>`
      : "";

    const groups = ["Classic Classes", "Custom Classes"].map((folder) => {
      const rows = untaken.filter((c) => c.folder === folder).map((c) => `<div class="lu-skill none">
          <img src="${esc(c.img)}" alt="">
          <div class="t"><b>${esc(c.name)}</b>
            <p>${c.skills.length} skills · ${esc(c.benefit ? (LEVELUP.BENEFIT_LABEL[c.benefit] ?? c.benefit) : "you choose the bonus")}</p></div>
          <button class="lu-btn" style="width:auto;padding:2px 12px" data-act="pick" data-key="${esc(c.key)}"
            ${atLimit ? "disabled" : ""}>Choose</button>
        </div>`).join("");
      return rows ? `<div class="lu-railhead">${esc(folder)}</div>${rows}` : "";
    }).join("");

    return `<div class="lu-head">
        <div><div class="lu-name">Start a New Class</div>
        <div class="lu-sub">${untaken.length} available · your first level in a class grants one of its skills</div></div>
        <button class="lu-x" data-act="closepicker" title="Back">×</button>
      </div>
      ${gateNote}
      <div class="lu-main">${groups || `<div class="lu-empty">You already have every class.</div>`}</div>`;
  },

  // ── interaction ─────────────────────────────────────────────────────────

  async _onClick(ev) {
    const btn = ev.target.closest("[data-act]");
    if (!btn || this._busy) return;
    const act = btn.dataset.act;

    if (act === "close") return this.close();
    if (act === "tab") { this._tab = btn.dataset.tab; return this.render(); }
    if (act === "openpicker") { this._pickerOpen = true; return this.render(); }
    if (act === "closepicker") { this._pickerOpen = false; return this.render(); }
    if (act === "pick") {
      this._selected = btn.dataset.key;
      this._pickerOpen = false;   // choosing from the browser returns to the main pane
      return this.render();
    }

    // Staging — no writes. A spend and a refund of the same skill annihilate,
    // so clicking + then − leaves nothing queued rather than two no-ops that
    // would both hit the actor on Confirm.
    if (act === "spend" || act === "refund") {
      const opposite = act === "spend" ? "refund" : "spend";
      const i = this._pending.findIndex(
        (p) => p.op === opposite && p.skillUuid === btn.dataset.uuid && p.classKey === btn.dataset.key
      );
      if (i >= 0) { this._pending.splice(i, 1); return this.render(); }

      // Skills that award Facets ask which, at stage time rather than during
      // Confirm — a batch that stops to ask questions halfway through is worse
      // than one that asked up front. The picker stages the operation itself.
      if (this._openFacetPicker(act, btn.dataset.key, btn.dataset.uuid)) return;

      this._pending.push({ op: act, classKey: btn.dataset.key, skillUuid: btn.dataset.uuid });
      return this.render();
    }

    // ── facet picker ──────────────────────────────────────────────────────
    if (act === "facettoggle") {
      const f = this._facet;
      if (!f) return;
      const u = btn.dataset.uuid;
      const at = f.selected.indexOf(u);
      if (at >= 0) f.selected.splice(at, 1);           // re-click deselects
      else if (f.selected.length < f.need) f.selected.push(u);
      else { f.selected.shift(); f.selected.push(u); } // full: oldest drops out
      // Advance only once the player has nothing left to decide.
      if (f.selected.length === f.need) f.stage = "confirm";
      return this.render();
    }
    if (act === "facetback") {
      // Back clears the selection and starts the choice over, rather than
      // returning to a full basket the player has already second-guessed.
      this._facet.selected = [];
      this._facet.stage = "pick";
      return this.render();
    }
    if (act === "facetcancel") {
      // A Facet grant cannot be left unresolved: either the player chooses, or
      // the level is not taken at all. Half-taking it — a level with the grant
      // skipped — is precisely the drift the picker exists to prevent.
      // Editing is different: a complete choice already exists, so backing out
      // simply keeps it.
      this._facet = null;
      return this.render();
    }
    if (act === "facetok") {
      const f = this._facet;
      this._facet = null;
      if (f) {
        if (f.editIndex >= 0) this._pending[f.editIndex].facetUuids = f.selected;
        else this._pending.push({
          op: f.act, classKey: f.classKey, skillUuid: f.skillUuid, facetUuids: f.selected,
        });
      }
      return this.render();
    }
    if (act === "facetedit") {
      const idx = Number(btn.dataset.idx);
      const p = this._pending[idx];
      if (p) this._openFacetPicker(p.op, p.classKey, p.skillUuid, idx);
      return;
    }

    if (act === "heroic") {
      const i = this._pending.findIndex((p) => p.op === "heroic" && p.skillUuid === btn.dataset.uuid);
      if (i >= 0) this._pending.splice(i, 1);
      else this._pending.push({ op: "heroic", skillUuid: btn.dataset.uuid, name: btn.dataset.name });
      return this.render();
    }

    if (act === "cancel") { this._pending = []; return this.render(); }
    if (act === "confirm") return this._commit();

    const A = api();
    if (!A) return;
    this._busy = true;
    btn.disabled = true;
    try {
      if (act === "heal") {
        const res = await A.healPoints(this._actorUuid);
        if (res && !res.ok) ui.notifications?.warn?.(explain(res));
      }
    } finally {
      this._busy = false;
      this.render();
    }
  },

  /**
   * Write the staged operations, in order.
   *
   * Refunds go first: they free Skill Points that later spends may rely on, and
   * they relax the three-unmastered-class limit. Staging "drop Dancer, start
   * Guardian" with only one point has to work.
   *
   * On the first failure the rest are abandoned and left staged, so the window
   * shows exactly what did not go through. Each operation is individually
   * atomic GM-side, so a partial apply is a coherent state, not a corrupt one.
   */
  async _commit() {
    const A = api();
    if (!A || !this._pending.length) return;

    const ordered = [
      ...this._pending.filter((p) => p.op === "refund"),
      ...this._pending.filter((p) => p.op === "spend"),
      ...this._pending.filter((p) => p.op === "heroic"),
    ];

    this._applying = true;   // suppress re-render while the books are unbalanced
    this._busy = true;
    let mastered = false;

    try {
      for (let i = 0; i < ordered.length; i++) {
        const p = ordered[i];
        let res;
        if (p.op === "refund") {
          res = await A.refundPoint({
            actorUuid: this._actorUuid, classKey: p.classKey, skillUuid: p.skillUuid,
            facetUuids: p.facetUuids,
          });
        } else if (p.op === "spend") {
          res = await A.spendPoint({
            actorUuid: this._actorUuid, classKey: p.classKey, skillUuid: p.skillUuid,
            benefit: p.benefit ?? await this._benefitFor(p.classKey),
            facetUuids: p.facetUuids,
          });
          if (res?.ok && res.mastered) mastered = true;
        } else {
          res = await A.pickHeroic({ actorUuid: this._actorUuid, skillUuid: p.skillUuid });
        }

        if (!res?.ok) {
          this._pending = ordered.slice(i);   // keep what didn't apply
          ui.notifications?.warn?.(explain(res));
          return;
        }
      }
      this._pending = [];
      if (mastered) ui.notifications?.info?.("Class mastered — a Heroic Skill slot is open.");
    } catch (e) {
      console.error(LEVELUP.TAG, e);
      ui.notifications?.error?.("Level-up failed — see console.");
    } finally {
      this._applying = false;
      this._busy = false;
      this.render();
    }
  },

  /**
   * Open the Facet picker for a spend/refund, or to edit an already-staged
   * choice. Returns false when the skill grants no Facets, so the caller stages
   * the operation immediately as normal.
   *
   * `editIndex` points at an entry in `_pending` whose choice is being revised;
   * otherwise the picker stages a NEW operation on confirm.
   */
  _openFacetPicker(act, classKey, skillUuid, editIndex = -1) {
    const s = api()?.getState(this._actorUuid);
    const cls = s?.classes?.find((c) => c.key === classKey);
    const skill = cls?.skills?.find((k) => k.uuid === skillUuid);
    if (!cls || !skill || !skill.facetGrant) return false;

    // Facets spoken for by OTHER staged operations are unavailable, so taking
    // Dance twice in one batch cannot offer the same dance both times. The
    // entry being edited is excluded from that set — its own picks stay
    // selectable.
    const spoken = new Set(
      this._pending
        .filter((p, i) => i !== editIndex && p.op === act)
        .flatMap((p) => p.facetUuids ?? [])
    );
    const pool = cls.facets.filter((f) =>
      (act === "spend" ? !f.held : f.held) && !spoken.has(f.uuid)
    );
    if (!pool.length) return false;

    const need = Math.min(act === "spend" ? skill.facetGrant : 1, pool.length);
    this._facet = {
      act, classKey, skillUuid, editIndex,
      className: cls.name, skillName: skill.name,
      need,
      pool: pool.map((f) => ({
        uuid: f.uuid, name: f.name, cost: f.cost, description: f.description, img: f.img,
      })),
      selected: editIndex >= 0 ? [...(this._pending[editIndex].facetUuids ?? [])] : [],
      // Auto-advance to the confirmation only ever fires from a toggle, so
      // opening the editor on an already-complete choice stays on the picker.
      stage: "pick",
    };
    this.render();
    return true;
  },

  _facetNoun(className) {
    if (className === "Dancer") return "dance";
    if (className === "Symbolist") return "symbol";
    if (className === "Mutant") return "therioform";
    if (className === "Hunter") return "trap";
    return "facet";
  },

  _facetOverlay() {
    const f = this._facet;
    if (!f) return "";
    const noun = this._facetNoun(f.className);
    const plural = (n) => `${noun}${n === 1 ? "" : "s"}`;

    if (f.stage === "confirm") {
      const chosen = f.selected
        .map((u) => f.pool.find((p) => p.uuid === u))
        .filter(Boolean);
      return `<div class="lu-facet"><div class="lu-panel lu-facetpanel lu-confirmpanel">
        <div class="lu-head"><div>
          <div class="lu-name">${f.act === "spend" ? "Confirm your choice" : "Confirm what you give back"}</div>
          <div class="lu-sub">${esc(f.skillName)}</div></div></div>
        <div class="lu-main">
          <p class="lu-lore">${f.act === "spend"
            ? `You will learn ${chosen.length === 1 ? "this" : "these"} ${plural(chosen.length)}:`
            : `You will unlearn ${chosen.length === 1 ? "this" : "these"} ${plural(chosen.length)}:`}</p>
          ${chosen.map((c) => `<div class="lu-fbtn is-on" style="cursor:default">
            <span class="lu-fhead">${c.img ? `<img src="${esc(c.img)}" alt="">` : ""}
              <b>${esc(c.name)}</b>${c.cost ? ` <span class="lu-tag">${esc(c.cost)}</span>` : ""}</span>
            ${describe(c.description, { clamp: false })}</div>`).join("")}
        </div>
        <div class="lu-foot">
          <span class="lu-foottext">Nothing is written until you Confirm the whole batch.</span>
          <button class="lu-cta ghost" data-act="facetback">Back</button>
          <button class="lu-cta go" data-act="facetok">Confirm</button>
        </div>
      </div></div>`;
    }

    const left = f.need - f.selected.length;
    return `<div class="lu-facet"><div class="lu-panel lu-facetpanel">
      <div class="lu-head"><div>
        <div class="lu-name">${esc(f.skillName)}</div>
        <div class="lu-sub">${f.act === "spend"
          ? `Choose ${f.need} ${plural(f.need)}`
          : `Choose 1 ${noun} to give back`} — ${left > 0 ? `${left} to go` : "ready"}</div></div>
        <button class="lu-x" data-act="facetcancel" title="Back to the skill tree">×</button>
      </div>
      <div class="lu-main">
        ${f.pool.map((p) => {
          const on = f.selected.includes(p.uuid);
          return `<button class="lu-fbtn ${on ? "is-on" : ""}" data-act="facettoggle" data-uuid="${esc(p.uuid)}">
            <span class="lu-fhead">${p.img ? `<img src="${esc(p.img)}" alt="">` : ""}
              <b>${on ? "✓ " : ""}${esc(p.name)}</b>${p.cost ? ` <span class="lu-tag">${esc(p.cost)}</span>` : ""}</span>
            ${describe(p.description, { clamp: false })}
          </button>`;
        }).join("")}
      </div>
      <div class="lu-foot">
        <span class="lu-foottext">${f.selected.length} of ${f.need} chosen${
          f.editIndex >= 0 ? "" : " — the level is not taken unless you choose"}</span>
        <button class="lu-cta ghost" data-act="facetcancel">${
          f.editIndex >= 0 ? "Keep as is" : "Cancel"}</button>
      </div>
    </div></div>`;
  },

  // Only asked when a class is opened for the first time, and only when the
  // class doesn't fix its own benefit — class_list stores one benefit per
  // class row, so there is nowhere to record a per-level answer.
  async _benefitFor(classKey) {
    const s = api()?.getState(this._actorUuid);
    const cls = s?.classes?.find((c) => c.key === classKey);
    if (!cls || cls.taken || cls.benefit) return cls?.benefit ?? undefined;

    return await new Promise((resolve) => {
      new Dialog({
        title: `${cls.name} — permanent bonus`,
        content: `<p style="margin:6px 0 10px">Every level in <b>${esc(cls.name)}</b> grants this bonus. It cannot be changed later.</p>`,
        buttons: {
          hp: { label: "Max HP +5", callback: () => resolve("hp") },
          mp: { label: "Max MP +5", callback: () => resolve("mp") },
          ip: { label: "Max IP +2", callback: () => resolve("ip") },
        },
        default: "hp",
        close: () => resolve(undefined),
      }).render(true);
    });
  },
};

// ── registration ──────────────────────────────────────────────────────────

Hooks.once("ready", () => {
  const a = globalThis.FUCompanion?.api?.levelUp;
  if (!a) return;
  a.open = (uuid) => LevelUpApp.open(uuid);
  a.close = () => LevelUpApp.close();
  a.toggle = (uuid) => LevelUpApp.toggle(uuid);
  a.app = LevelUpApp;
});

export { LevelUpApp };
