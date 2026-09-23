// [ONI] Skill Forge — the application.
// ---------------------------------------------------------------------------
// Ties the five stages into one window:
//
//   START    pick a PATTERN (stage 2), or carry on with a draft
//   BASICS   the top-level props the publish gate can block on
//   WIRE     the effect rows as a GRAPH (stage 1)
//   GATE     conditions from dropdowns (stage 3)
//   TEST     run it and say what actually happened (stage 4)
//   PUBLISH  validate, then leave draft (stage 5 + stage 0)
//
// Every panel is a thin view over a tested module. The logic lives in
// patterns.js / graph-model.js / condition-builder.js / test-runner.js /
// publish.js, each with its own suite, because a UI is the one layer that
// cannot be checked without a running game — so as little as possible of the
// thinking happens here.
//
// ⚠ THE SAVE PATH IS THE DANGEROUS SURFACE.
//   Writing `system.props.*_table` DEEP-MERGES in CSB, so a partial row leaves
//   whatever was underneath in place. `saveGraph` therefore NULLS each table
//   and then writes the full key set, which is the only shape that cannot leak
//   a key from whatever the row previously held.

import { PATTERNS, patternsByWhen, WHEN_LABELS, patternSearchText, expand, defaultsFor } from "./patterns.js";
import {
  toGraph, fromGraphWithEdges, graphProblems, assignDepths, REF_FIELDS,
  renameNode, setNodeRef, removeNode, setEntry, setNodeField, addNode, FIRE_POINTS,
} from "./graph-model.js";
import { stepKinds, columnsForKind, requiredFieldsForKind, newRowFor } from "./step-palette.js";
import * as CB from "./condition-builder.js";
import { runTest, describeRun, tableRows } from "./test-runner.js";
import { canPublish, explainDecision, isDraft, draftPatch, publish } from "./publish.js";
import { registerDevTool } from "../battle-director/dev-tools-menu.js";
// Imported, not retyped: the slot order is derived from one element list, so
// this cannot drift out of step with the damage pipeline's own mapping.
import { AFFINITY_SLOT_BY_ELEMENT } from "../action-reader/actionReader-core.js";
// The engine's own readings of the two FREE-TEXT fields, imported rather than
// reimplemented so the panel cannot tell an author something the engine will
// then contradict.
import { actionDurationRank } from "../battle-director/skill-formulas.js";
import { skillTargetIsMulti, skillTargetIsUpTo } from "../battle-director/snapshot.js";

const NS = "fabula-ultima-companion";

// The graph model names its problems for a programmer. Rendered raw, the
// headline of each problem read "dangling ref" / "duplicate label" — the two
// words in the message an author is least able to act on. Unmapped kinds keep
// the old de-underscored fallback so a new problem type still surfaces.
const PROBLEM_TITLES = Object.freeze({
  dangling_ref: "Points at a step that isn't there",
  duplicate_label: "Two steps have the same name",
  unreachable: "This step never runs",
  unknown_target_ref: "Acts on nobody",
  not_checked: "NOT CHECKED",
});

/**
 * The engine's own list of reserved target words, or null.
 *
 * `skill-targeting.js` publishes this at import time precisely so a second
 * opinion cannot drift from the resolver — its comment says the first cut had
 * "the lint answering from the prefix list while resolveTargetRef answered
 * from RESERVED_REFS alone", and every `own_persistent_summons_<kind>` ref
 * resolved to nothing while the lint called it valid.
 *
 * So this reads the published oracle and NEVER keeps a copy. Absent, the
 * panel says a check did not run rather than guessing — a hand-maintained
 * list is exactly what made `formula-audit` vouch for a dead identifier.
 */
function reservedTargetRefOracle() {
  const fn = globalThis.FUCompanion?.api?.targetRefs?.isReserved;
  return typeof fn === "function" ? fn : null;
}
const TAG = "[SkillForge]";
const SKILL_TEMPLATE_ID = "j0F5Msw5RZ8aIB3j";
// CSB gives skills and gear the same document type; `system.template` is the
// ONLY discriminator (`reference_skill_identity_fields`). Both skill templates
// are openable — monster skills are skills, and excluding them would make a
// whole side of the catalogue unreachable for no reason. Gear is not: it has a
// different shape and its own policy about where behaviour may live.
const MONSTER_SKILL_TEMPLATE_ID = "FZmpKcQRP7hZQqbV";
const SKILL_TEMPLATES = Object.freeze([SKILL_TEMPLATE_ID, MONSTER_SKILL_TEMPLATE_ID]);
// A world of this size has ~2400 skill documents. Rendering them all as cards
// is not an option, so the list is search-driven: nothing until you type, and
// a hard cap with an honest "and N more" rather than a silent truncation.
const EXISTING_MIN_QUERY = 2;
const EXISTING_MAX_SHOWN = 40;

/** Validate through the in-game bridge, which owns ctx assembly. */
function validate(doc) {
  const fn = globalThis.FUCompanion?.api?.lint?.validateSkillDoc;
  if (typeof fn !== "function") return { findings: [], skipped: ["validator not loaded"] };
  try { return fn(doc); } catch (e) {
    console.error(`${TAG} validate threw`, e);
    return { findings: [], skipped: [`validator threw: ${e.message}`] };
  }
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export class SkillForgeApp extends Application {
  constructor(options = {}) {
    super(options);
    this.item = options.item ?? null;
    this.tab = this.item ? "wire" : "start";
    this.patternId = null;
    this.patternValues = {};
    this.graph = null;
    this.lastTest = null;
    this.selectedNode = null;
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "fud-skill-forge",
      title: "Skill Forge",
      template: null,
      width: 980,
      height: 720,
      resizable: true,
      classes: ["fud-skill-forge"],
    });
  }

  /** Open on a document, or on the pattern picker when given none. */
  static open(item = null) {
    // \U0001f9a0 F7. This used to construct a new instance every time. Foundry keys
    // windows by DOM id, so the second render REPLACED the first on screen
    // while the original object stayed alive holding the pattern selection,
    // the unsaved graph and the last test result — all now unreachable, with
    // no error and nothing on screen to say so. It is what corrupted one of
    // the screenshots for the report before anyone noticed.
    //
    // Reuse the live one instead, and bring it to the front so a second click
    // is visibly the same window rather than a silently different one.
    const open = Object.values(ui.windows ?? {}).find((w) => w instanceof SkillForgeApp);
    if (open) {
      if (item && item !== open.item) open._openDocument(item.uuid);
      else open.render(true);
      open.bringToTop?.();
      return open;
    }
    const app = new SkillForgeApp({ item });
    app.render(true);
    return app;
  }

  // ── data ──────────────────────────────────────────────────────────────────
  get docObject() {
    if (!this.item) return null;
    return typeof this.item.toObject === "function" ? this.item.toObject() : this.item;
  }

  /**
   * Rebuild the graph from the document.
   *
   * 🪤 UNSAVED EDITS WIN unless forced. Every Basics field writes the document
   * and then refreshes, so without this guard, typing a new Duration silently
   * threw away a rewire the author had not saved yet — no prompt, no message,
   * the cards simply reverted while their attention was on another tab.
   */
  refreshGraph({ force = false } = {}) {
    if (this.graphDirty && !force) return;
    const doc = this.docObject;
    this.graph = doc ? toGraph(doc.system?.props ?? {}) : null;
  }

  /** Open a different document, abandoning any unsaved rewire deliberately. */
  async _openDocument(uuid) {
    if (this.graphDirty) {
      const ok = await Dialog.confirm({
        title: "Unsaved changes",
        content: `<p>You have unsaved changes to <strong>${esc(this.item?.name ?? "this skill")}</strong>.</p>
          <p>Opening another skill discards them.</p>`,
      });
      if (!ok) return false;
    }
    const doc = await fromUuid(uuid);
    if (!doc) { ui.notifications?.warn("That skill no longer exists."); return false; }
    this.item = doc;
    this.patternId = null;
    this.lastTest = null;
    this.lastTestAgainst = null;
    this.selectedNode = null;
    this.graphDirty = false;
    this.tab = "wire";
    this.refreshGraph({ force: true });
    this.render(false);
    return true;
  }

  /**
   * The window title names the document being edited.
   *
   * It used to read the literal string "Skill Forge" for the whole session, so
   * once past the Start tab nothing on screen said WHICH skill you were
   * looking at — the name appeared only buried in the test prose and the
   * publish decision.
   */
  get title() {
    const doc = this.item;
    if (!doc) return "Skill Forge";
    const where = doc.parent?.documentName === "Actor" ? ` · ${doc.parent.name}` : "";
    return `Skill Forge — ${doc.name}${isDraft(doc) ? " (draft)" : ""}${where}`;
  }

  // ── render ────────────────────────────────────────────────────────────────
  async _renderInner() {
    const html = `
      <div class="sf-root">
        ${this._styles()}
        <nav class="sf-tabs">
          ${this._tabButton("start", "Start")}
          ${this._tabButton("basics", "Basics", !this.item)}
          ${this._tabButton("wire", "Wire", !this.item)}
          ${this._tabButton("gate", "Conditions", !this.item)}
          ${this._tabButton("test", "Test", !this.item)}
          ${this._tabButton("publish", "Publish", !this.item)}
        </nav>
        ${this._documentBanner()}
        <section class="sf-body">${this._panel()}</section>
      </div>`;
    return $(html);
  }

  /**
   * What is open, and what editing it means.
   *
   * Two facts the author cannot get from anywhere else on screen, and both
   * change what a save DOES:
   *
   *  · a PUBLISHED skill is in play. Saving changes it for whoever has it,
   *    immediately. A draft cannot be picked at all, so the same button is a
   *    very different act depending on which one is open;
   *  · an actor's copy of a skill is a SEPARATE DOCUMENT from the one in the
   *    Items sidebar. Editing one does not touch the other, and this world has
   *    a documented history of master/copy drift. Someone who opened the copy
   *    believing it was the master will see their change not take effect
   *    anywhere else and have no way to find out why.
   */
  _documentBanner() {
    const doc = this.item;
    if (!doc) return "";
    const lines = [];

    if (!isDraft(doc)) {
      lines.push(`<strong>This skill is live.</strong> Saving changes it for anyone who has it,
        straight away. Use <em>Back to draft</em> on the Publish tab to take it out of play
        while you work.`);
    }

    // \U0001f9a0 Y1. 53 documents in this world name a skill template that DOES NOT
    // EXIST as a world item — Create Phantasm, Drain Spirit, Numen Attack and
    // more. They still work, because a CSB instance keeps its own copy of the
    // layout, but `reloadTemplate` throws on them, and so would anything that
    // calls it (world-import's prop guard does).
    //
    // ⚠ And the missing template is currently PROTECTING them. Recreating it
    // from an instance's stored body would declare 12 keys, and 7 of these
    // documents carry authored props that body does not declare — effect_table
    // on 5, reaction_config_table on 2 — so the recovery that looks obvious
    // deletes the behaviour it was meant to save. Say that here rather than
    // letting someone discover it by doing it.
    const tplId = String(doc.system?.template ?? "");
    if (tplId && !game.items?.get(tplId)) {
      lines.push(`<strong>This skill's template is missing from the world.</strong> It works, and
        editing it here is safe — but anything that <em>reloads</em> the template will fail on it,
        and re-creating that template from what this skill remembers would delete any field the
        remembered layout does not declare. Do not "fix" it by re-creating the template without
        checking what the other skills on it carry.`);
    }

    if (doc.parent?.documentName === "Actor") {
      // The world document this copy came from, if it still exists. Matched on
      // `system.uniqueId` — `flags.core.sourceId` is absent on every authored
      // copy in this world and `system.props.id` holds the embedded _id, so
      // both of those would answer "no master" for a skill that has one.
      const masterId = doc.system?.uniqueId;
      const master = masterId ? game.items?.get(masterId) : null;
      lines.push(master
        ? `You are editing <strong>${esc(doc.parent.name)}'s copy</strong>. The master
           “${esc(master.name)}” in the Items sidebar is a different document and will not
           change.`
        : `You are editing the copy on <strong>${esc(doc.parent.name)}</strong>.`);
    }

    if (!lines.length) return "";
    return `<div class="sf-banner">${lines.map((l) => `<p>${l}</p>`).join("")}</div>`;
  }

  _tabButton(id, label, disabled = false) {
    return `<button type="button" class="sf-tab ${this.tab === id ? "active" : ""}"
      data-tab="${id}" ${disabled ? "disabled" : ""}>${label}</button>`;
  }

  _panel() {
    switch (this.tab) {
      case "start":   return this._panelStart();
      case "basics":  return this._panelBasics();
      case "wire":    return this._panelWire();
      case "gate":    return this._panelGate();
      case "test":    return this._panelTest();
      case "publish": return this._panelPublish();
      default:        return "";
    }
  }

  // ── START: pattern picker (stage 2) ───────────────────────────────────────
  /**
   * Skills already in progress.
   *
   * Without this the Forge was WRITE-ONCE: the dev-tools launcher only ever
   * calls open() with no argument, nothing registers an item-sheet button, and
   * a created draft lands loose among hundreds of world items. Close the
   * window and the only way back to your own draft was
   * `FUCompanion.api.skillForge.open(...)` in the F12 console — the exact act
   * this tool exists to make unnecessary.
   */
  _panelContinue() {
    const drafts = [];
    for (const it of game.items ?? []) if (isDraft(it)) drafts.push({ doc: it, owner: null });
    for (const a of game.actors ?? []) {
      if (a.type === "_template") continue;
      for (const it of a.items ?? []) if (isDraft(it)) drafts.push({ doc: it, owner: a });
    }
    if (!drafts.length) return "";
    drafts.sort((x, y) => (y.doc._stats?.modifiedTime ?? 0) - (x.doc._stats?.modifiedTime ?? 0));
    // Every draft is rendered. An earlier version cut the list at twelve, which
    // meant that past twelve your own work was simply unreachable — the same
    // dead end as having no list at all, just further in. The search box above
    // is what keeps a long list usable.
    const cards = drafts.map(({ doc, owner }) => `
      <button type="button" class="sf-card" data-continue="${esc(doc.uuid)}"
        data-find="${esc(`${doc.name} ${owner ? owner.name : "sidebar items"}`.toLowerCase())}">
        <strong>${esc(doc.name)}</strong>
        <span>draft · ${owner ? `on ${esc(owner.name)}` : "in the Items sidebar"}</span>
      </button>`).join("");
    return `
      <h3 class="sf-group" data-group>Carry on with a draft <span class="sf-count" data-total="${drafts.length}">${drafts.length}</span></h3>
      <p class="sf-note" data-group-note>These are started but not published, so nobody can use them yet.</p>
      <div class="sf-cards" data-cards>${cards}</div>`;
  }

  _panelStart() {
    if (this.patternId) return this._panelPatternForm();
    const groups = patternsByWhen();
    const sections = [...groups.entries()].map(([when, list]) => `
      <h3 class="sf-group" data-group>${esc(WHEN_LABELS[when] ?? when)}
        <span class="sf-count" data-total="${list.length}">${list.length}</span></h3>
      <div class="sf-cards" data-cards>
        ${list.map((p) => `
          <button type="button" class="sf-card" data-pattern="${esc(p.id)}"
            data-find="${esc(patternSearchText(p))}">
            <strong>${esc(p.label)}</strong>
            <span>${esc(p.blurb)}</span>
          </button>`).join("")}
      </div>`).join("");
    return `
      <label class="sf-search">
        <span class="sf-search-label">Find</span>
        <input type="search" data-find-box placeholder="What should it do? e.g. burn one enemy, heal the party, react when hit">
      </label>
      <p class="sf-note" data-find-count hidden></p>
      ${this._panelContinue()}
      ${this._panelExisting()}
      <h3 class="sf-group" data-section-head="patterns">Start something new</h3>
      <p class="sf-lede" data-section-head="patterns">Pick what you want the skill to do. It will be
      built for you, and you can check every step before anyone can use it.</p>
      ${sections}`;
  }

  /**
   * Filter both lists in the DOM, WITHOUT re-rendering.
   *
   * 🪤 Every other input here re-renders on change, which replaces the panel —
   * and replacing the panel under a box someone is typing into destroys focus
   * and the caret on the first keystroke. So this hides and shows cards
   * directly, and never touches the Application. It also means the filter runs
   * on `input`, i.e. per character, rather than waiting for blur.
   */
  _applyFind(root, raw) {
    const q = String(raw ?? "").trim().toLowerCase();
    let shown = 0, total = 0;
    for (const card of root.querySelectorAll("[data-find]")) {
      total += 1;
      const hit = !q || card.dataset.find.includes(q);
      card.hidden = !hit;
      if (hit) shown += 1;
    }
    // A heading over nothing is noise; hide a group whose cards all went away.
    for (const list of root.querySelectorAll("[data-cards]")) {
      const any = Array.from(list.querySelectorAll("[data-find]")).some((c) => !c.hidden);
      list.hidden = !any;
      const head = list.previousElementSibling?.matches?.("[data-group-note]")
        ? list.previousElementSibling.previousElementSibling
        : list.previousElementSibling;
      const note = list.previousElementSibling?.matches?.("[data-group-note]")
        ? list.previousElementSibling : null;
      if (head?.matches?.("[data-group]")) {
        head.hidden = !any;
        // The badge has to agree with what is on screen. Left at the total it
        // read "11" over two visible cards — a number contradicting the thing
        // it labels, which is the whole failure mode this tool exists to stop.
        const badge = head.querySelector(".sf-count");
        if (badge) {
          const n = Array.from(list.querySelectorAll("[data-find]")).filter((c) => !c.hidden).length;
          badge.textContent = q ? String(n) : (badge.dataset.total ?? String(n));
        }
      }
      if (note) note.hidden = !any;
    }
    // The OUTER section header sits above all the pattern groups, so it is not
    // the previous sibling of any card list and the per-group logic above never
    // touched it. Filtering to something no pattern matches therefore left
    // "Start something new" and its lede standing over an empty page —
    // the same "a heading over nothing is noise" rule, missed one level up.
    const anyPattern = Array.from(root.querySelectorAll("[data-pattern]"))
      .some((c) => !c.hidden);
    for (const el of root.querySelectorAll("[data-section-head='patterns']")) {
      el.hidden = !anyPattern;
    }

    const counter = root.querySelector("[data-find-count]");
    if (counter) {
      counter.hidden = !q;
      // The existing-skill list below is filtered by the SAME box but is not
      // made of `[data-find]` cards, so it is not in `shown`/`total`. Left out
      // of this sentence, the counter said "Nothing matches" directly above a
      // list of things that matched.
      const existing = q.length >= EXISTING_MIN_QUERY
        ? this._skillIndex().filter((s) => s.find.includes(q)).length : 0;
      counter.textContent = shown
        ? `${shown} of ${total} match “${q}”.${existing ? ` ${existing} existing skill(s) too — see below.` : ""}`
        : existing
          ? `No pattern or draft matches “${q}”, but ${existing} existing skill(s) do — see below.`
          : `Nothing matches “${q}”. Try a plainer word — what would you tell another player it does?`;
    }
  }

  /**
   * Every skill document in the world, indexed once.
   *
   * Built lazily and cached for the life of the window. It is a read of
   * `game.items` plus every actor's items — cheap per document, but ~2400 of
   * them, so not something to redo on each keystroke of a filter.
   */
  _skillIndex() {
    if (this._skillIndexCache) return this._skillIndexCache;
    // Invalidated by `_forgetSkillIndex()` whenever this window creates,
    // publishes or deletes a document. A cache with no invalidation is how a
    // skill you JUST made becomes unfindable by the search that is supposed
    // to find it.
    const out = [];
    const add = (doc, owner) => {
      if (!SKILL_TEMPLATES.includes(doc?.system?.template)) return;
      out.push({
        uuid: doc.uuid,
        name: doc.name,
        owner: owner?.name ?? null,
        draft: isDraft(doc),
        monster: doc.system.template === MONSTER_SKILL_TEMPLATE_ID,
        find: `${doc.name} ${owner?.name ?? "items sidebar"}`.toLowerCase(),
      });
    };
    for (const it of game.items ?? []) add(it, null);
    for (const a of game.actors ?? []) {
      if (a.type === "_template") continue;
      for (const it of a.items ?? []) add(it, a);
    }
    out.sort((x, y) => x.name.localeCompare(y.name) || String(x.owner).localeCompare(String(y.owner)));
    this._skillIndexCache = out;
    return out;
  }

  /**
   * Open a skill that already exists.
   *
   * Until this existed the Forge could only reopen its OWN drafts, so the
   * ~2400 skills already in the world were unreachable by every panel in the
   * tool — the validator, the Basics readings, the Test button and the graph
   * all worked, on nothing but what the Forge itself had made.
   */
  _panelExisting() {
    const total = this._skillIndex().length;
    if (!total) return "";
    return `
      <h3 class="sf-group">Open a skill that already exists
        <span class="sf-count">${total}</span></h3>
      <p class="sf-note">Type in the Find box above to search all ${total} of them. Opening one
      does not change it — nothing is written until you save.</p>
      <div class="sf-cards" data-existing></div>`;
  }

  /**
   * Render matches for the existing-skill list.
   *
   * Separate from `_applyFind` because that one HIDES cards that are already
   * in the DOM, and there is no version of this list that can all be in the
   * DOM. Like `_applyFind` it must never re-render the Application: that would
   * replace the search box mid-keystroke and take the caret with it.
   */
  _renderExistingMatches(root, raw) {
    const box = root.querySelector("[data-existing]");
    if (!box) return;
    const q = String(raw ?? "").trim().toLowerCase();
    if (q.length < EXISTING_MIN_QUERY) {
      box.innerHTML = `<p class="sf-note">Type at least ${EXISTING_MIN_QUERY} letters to search.</p>`;
      return;
    }
    const hits = this._skillIndex().filter((s) => s.find.includes(q));
    if (!hits.length) {
      box.innerHTML = `<p class="sf-note">No existing skill matches “${esc(q)}”.</p>`;
      return;
    }
    const shown = hits.slice(0, EXISTING_MAX_SHOWN);
    box.innerHTML = shown.map((s) => `
      <button type="button" class="sf-card" data-open="${esc(s.uuid)}">
        <strong>${esc(s.name)}</strong>
        <span>${s.draft ? "draft · " : ""}${s.monster ? "monster skill · " : ""}${
          s.owner ? `on ${esc(s.owner)}` : "in the Items sidebar"}</span>
      </button>`).join("") +
      // An honest cap. A list that silently stops at 40 is a list that tells
      // you your skill does not exist.
      (hits.length > shown.length
        ? `<p class="sf-note">…and ${hits.length - shown.length} more. Type a bit more to narrow it.</p>`
        : "");
  }

  _panelPatternForm() {
    const p = PATTERNS.find((x) => x.id === this.patternId);
    if (!p) return "";
    const v = { ...defaultsFor(p.id), ...this.patternValues };
    const fields = p.fields.map((f) => {
      const val = v[f.key] ?? "";
      let input;
      if (f.kind === "choice") {
        input = `<select data-field="${esc(f.key)}">${f.options.map((o) =>
          `<option value="${esc(o)}" ${String(val) === String(o) ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
      } else if (f.kind === "boolean") {
        input = `<input type="checkbox" data-field="${esc(f.key)}" ${val ? "checked" : ""}>`;
      } else {
        input = `<input type="${f.kind === "number" ? "number" : "text"}"
          data-field="${esc(f.key)}" value="${esc(val)}">`;
      }
      return `<label class="sf-field"><span>${esc(f.label)}${f.optional ? " <em>(optional)</em>" : ""}</span>${input}</label>`;
    }).join("");

    const { missing } = expand(p.id, v);
    return `
      <button type="button" class="sf-back" data-back="1">← all patterns</button>
      <h3>${esc(p.label)}</h3>
      <p class="sf-lede">${esc(p.blurb)}</p>
      <div class="sf-form">${fields}</div>
      ${missing.length ? `<p class="sf-warn">Still needed: ${missing.map(esc).join(", ")}</p>` : ""}
      <label class="sf-field"><span>Name</span>
        <input type="text" data-newname value="${esc(this.patternValues.__name ?? "")}"></label>
      <label class="sf-field"><span>Who knows this skill?</span>
        ${this._ownerSelect()}</label>
      <p class="sf-note">Leave this unset to keep the skill in the Items sidebar and hand it out
        later. Picking someone creates it on them directly.</p>
      <button type="button" class="sf-primary" data-create="1" ${missing.length ? "disabled" : ""}>
        Create this skill as a draft</button>
      <p class="sf-note">It is created as a <strong>draft</strong>: not offered in play until you publish it.</p>`;
  }

  /**
   * Who can be given this skill.
   *
   * Grouped by folder because a flat list is 300-odd names in this world and
   * unusable; `_template` actors are excluded because they are CSB scaffolding,
   * not creatures anyone plays. The default is deliberately "nobody yet" — it
   * is the behaviour every earlier version had, so choosing an owner is an
   * addition rather than a change of meaning.
   */
  _ownerSelect() {
    const chosen = String(this.patternValues.__owner ?? "");
    const byFolder = new Map();
    for (const a of game.actors ?? []) {
      if (a.type === "_template") continue;
      const folder = a.folder?.name ?? "No folder";
      if (!byFolder.has(folder)) byFolder.set(folder, []);
      byFolder.get(folder).push(a);
    }
    const groups = [...byFolder.entries()]
      .sort((x, y) => x[0].localeCompare(y[0]))
      .map(([folder, actors]) => `<optgroup label="${esc(folder)}">${actors
        .sort((x, y) => x.name.localeCompare(y.name))
        .map((a) => `<option value="${esc(a.id)}" ${chosen === a.id ? "selected" : ""}>${esc(a.name)}</option>`)
        .join("")}</optgroup>`).join("");
    return `<select data-owner>
      <option value="" ${chosen ? "" : "selected"}>Nobody yet — keep it in the sidebar</option>
      ${groups}
    </select>`;
  }

  // ── BASICS: the top-level props the publish gate can block on ─────────────
  //
  // The gate used to name fixes the Forge could not perform: it blocked on
  // `skill_target` and told the author to set it, while no control in any tab
  // edited that field — or `cost`, `duration`, the name or the description.
  // The pattern wrote them once at creation and they became unreachable, so
  // the only route was the raw CSB sheet, which the authoring guideline forbids.

  /** Options a SELECT field declares on the live template — never invented here. */
  _templateOptions(key) {
    const tpl = game.items?.get(SKILL_TEMPLATE_ID);
    let found = null;
    const seen = new Set();
    const walk = (node) => {
      if (found || !node || typeof node !== "object" || seen.has(node)) return;
      seen.add(node);
      if (Array.isArray(node)) return node.forEach(walk);
      if ((node.key ?? node.name) === key && Array.isArray(node.options)) { found = node.options; return; }
      for (const v of Object.values(node)) if (v && typeof v === "object") walk(v);
    };
    walk(tpl?._source?.system?.body);
    walk(tpl?._source?.system?.header);
    return found ?? [];
  }

  _select(field, value, options, { blank = null } = {}) {
    const opts = options.map((o) => {
      const k = typeof o === "string" ? o : o.key;
      const label = typeof o === "string" ? o : (o.value ?? o.key);
      return `<option value="${esc(k)}" ${String(value) === String(k) ? "selected" : ""}>${esc(label)}</option>`;
    }).join("");
    const known = options.some((o) => String(typeof o === "string" ? o : o.key) === String(value));
    return `<select data-basic="${esc(field)}">
      ${blank ? `<option value="" ${value ? "" : "selected"}>${esc(blank)}</option>` : ""}
      ${opts}
      ${!known && value ? `<option value="${esc(value)}" selected>${esc(value)} (not a listed value)</option>` : ""}
    </select>`;
  }

  /** What the ENGINE will make of the free-text fields, stated plainly. */
  _readsAs(props) {
    const target = String(props.skill_target ?? "");
    // The self test is compose-action's: `!text || /^self$/i`. A "-" is NOT a
    // no-target sentinel — it falls through and opens the enemy picker, which
    // is why the validator calls it worse than blank.
    const self = !target.trim() || /^self$/i.test(target.trim());
    const targetReads = !target.trim() ? "nothing yet — it will act on the user"
      : target.trim() === "-" ? "NOT self — it will open the enemy picker"
      : self ? "the user"
      : skillTargetIsMulti(target) ? `several creatures${skillTargetIsUpTo(target) ? " (up to a limit)" : ""}`
      : "one creature";
    const rank = actionDurationRank(props.duration);
    const durReads = ["over at once (Instantaneous)",
                      "lasting into a later turn",
                      "lasting the whole Scene or longer"][rank];
    return { targetReads, durReads, dash: target.trim() === "-" };
  }

  _panelBasics() {
    const doc = this.docObject;
    if (!doc) return `<p class="sf-lede">Open a skill first.</p>`;
    const p = doc.system?.props ?? {};
    const reads = this._readsAs(p);
    const TARGETS = ["Self", "One Creature", "One Enemy", "One Ally",
                     "Up to three creatures", "All Enemies", "All Allies", "Special"];
    const DURATIONS = ["Instantaneous", "Until the start of your next turn", "Scene"];
    return `
      <p class="sf-lede">The few things every skill has to declare. These are what the
      Publish check looks at, so this is where you fix anything it objects to.</p>

      <label class="sf-field"><span>Name</span>
        <input type="text" data-basic="name" value="${esc(doc.name ?? "")}"></label>

      <label class="sf-field"><span>Kind of skill</span>
        ${this._select("skill_type", p.skill_type ?? "", this._templateOptions("skill_type"),
          { blank: "— choose —" })}</label>

      <label class="sf-field"><span>What it hits</span>
        ${this._select("skill_target", p.skill_target ?? "", TARGETS, { blank: "— choose —" })}</label>
      <p class="sf-note ${reads.dash ? "sf-warn" : ""}">Reads as: <strong>${esc(reads.targetReads)}</strong>.</p>

      <label class="sf-field"><span>Reach</span>
        ${this._select("skill_range", p.skill_range ?? "", this._templateOptions("skill_range"),
          { blank: "— choose —" })}</label>

      <label class="sf-field"><span>How long it lasts</span>
        ${this._select("duration", p.duration ?? "", DURATIONS, { blank: "— choose —" })}</label>
      <p class="sf-note">Reads as: <strong>${esc(reads.durReads)}</strong>.
        This field is matched on the words in it, so a misspelling does not fail —
        it quietly means something else.</p>

      <label class="sf-field"><span>Cost <em>(e.g. “10 MP”, or blank for free)</em></span>
        <input type="text" data-basic="cost" value="${esc(p.cost ?? "")}"></label>

      <label class="sf-field sf-field-tall"><span>What it says to a player</span>
        <textarea data-basic="description" rows="4">${esc(p.description ?? "")}</textarea></label>`;
  }

  // ── WIRE: the graph (stage 1) ─────────────────────────────────────────────
  _panelWire() {
    if (!this.graph) this.refreshGraph();
    if (!this.graph) return `<p class="sf-lede">Open a skill first.</p>`;
    const depths = assignDepths(this.graph);
    const problems = graphProblems(this.graph, { isReservedTargetRef: reservedTargetRefOracle() });

    const cols = new Map();
    for (const n of this.graph.nodes) {
      const d = depths.get(n.id) ?? 0;
      if (!cols.has(d)) cols.set(d, []);
      cols.get(d).push(n);
    }
    // \ud83e\udea4 F8. These columns used to read "runs first / step 2 / step 3", which
    // claims EXECUTION ORDER. They are reference DEPTH from a fire point, and
    // the two are not the same thing: a targeting step has to resolve before
    // the damage that points at it, yet it sits one column further right
    // because it is reached THROUGH that damage row. Labelling depth as order
    // told the reader the opposite of what happens.
    //
    // Depth is still worth drawing \u2014 it is what makes the graph readable \u2014 so
    // the fix is to name it honestly rather than to compute something else.
    const columns = [...cols.entries()].sort((a, b) => a[0] - b[0]).map(([d, list]) => `
      <div class="sf-col">
        <div class="sf-col-head">${d === 0 ? "starts here" : `${d} step(s) away`}</div>
        ${list.map((n) => this._nodeCard(n)).join("")}
      </div>`).join("");

    // A row with no `effect_label` cannot be named by a fire point — the label
    // on its card is one this model invented, and writing it would point the
    // skill at something that exists nowhere in the data.
    const labels = this.graph.nodes
      .filter((n) => !n.isTrigger && !n.labelIsSynthetic).map((n) => n.label);
    const entry = this.graph.entry ?? "";

    // Only the fire points this document carries. `on_activate_effect_ref` is
    // always offered because every skill needs one and its absence is the
    // failure being prevented; the other two appear only where they are
    // already authored, since adding one means adding a prop.
    const firePoints = Object.entries(FIRE_POINTS).filter(([field]) =>
      field === "on_activate_effect_ref" || field in (this.graph.entries ?? {}));

    return `
      ${this._wireBar()}
      <p class="sf-lede">Each card is one step. Click one to rename it, change what it points
      at, or remove it. Renaming carries every reference along with it.</p>
      <p class="sf-note">Columns show how far each step is from a starting point, not what order
      things happen in \u2014 a step that is pointed AT sits to the right of the step pointing at it,
      even when it has to resolve first.</p>
      ${this._arrayShapeWarning()}
      ${firePoints.map(([field, label]) => {
        const value = this.graph.entries?.[field] ?? (field === "on_activate_effect_ref" ? entry : "");
        return `
        <label class="sf-field sf-entry">
          <span>${esc(label)}</span>
          <select data-entry="${esc(field)}">
            <option value=""${value ? "" : " selected"}>— nothing —</option>
            ${labels.map((l) => `<option value="${esc(l)}"${l === value ? " selected" : ""}>${esc(l)}</option>`).join("")}
          </select>
        </label>`;
      }).join("")}
      ${entry ? "" : `<p class="sf-note sf-warn">Nothing runs when this skill is used. Every step
        below is authored but dead until you pick one here.</p>`}
      ${problems.length ? `<div class="sf-problems">${problems.map((p) =>
        `<div class="sf-problem sf-p-${esc(p.kind)}"><strong>${esc(PROBLEM_TITLES[p.kind] ?? p.kind.replace(/_/g, " "))}</strong> ${esc(p.text)}</div>`).join("")}</div>` : ""}
      <div class="sf-graph">${columns || "<p>No steps yet.</p>"}</div>
      ${this._addStep()}
      ${this._nodeInspector()}`;
  }

  /**
   * Save / discard, and an honest statement of what is on screen.
   *
   * The bar is always rendered, not only when dirty: a control that appears on
   * the first edit is a control nobody knows exists until they have already
   * made one, which is the wrong order for the only button in this tool that
   * writes to a live document.
   */
  _wireBar() {
    const dirty = !!this.graphDirty;
    return `
      <div class="sf-bar">
        <span class="sf-bar-state">${dirty
          ? "Unsaved changes — nothing has been written yet."
          : "No unsaved changes."}</span>
        <button type="button" class="sf-primary" data-graph-save ${dirty ? "" : "disabled"}>Save changes</button>
        <button type="button" data-graph-discard ${dirty ? "" : "disabled"}>Discard</button>
      </div>`;
  }

  /**
   * 3 documents in this world store a table as a JSON ARRAY rather than a CSB
   * row object. Saving rewrites it to the object shape CSB itself creates —
   * which is a fix, but it is not the edit the author asked for, so it is said
   * out loud rather than done quietly.
   */
  _arrayShapeWarning() {
    const props = this.docObject?.system?.props ?? {};
    const odd = ["effect_table", "reaction_config_table"].filter((t) => Array.isArray(props[t]));
    if (!odd.length) return "";
    return `<p class="sf-note sf-warn">This skill stores its ${odd.join(" and ")} as a list
      rather than the numbered rows every other skill uses. Saving will convert it. Nothing is
      lost, but it will show as a larger change than you made.</p>`;
  }

  /**
   * Add a step.
   *
   * The kind list and the columns a new row carries both come from
   * `step-palette.js`, i.e. from the column registry — never from a list
   * written here. A key this panel invented would be written, reported as
   * saved, and silently dropped.
   */
  _addStep() {
    const kinds = stepKinds();
    const kind = this.addKind ?? "";
    const req = kind ? requiredFieldsForKind(kind) : { all: [], either: [] };
    const needs = [...req.all, ...req.either.map((g) => g.join(" or "))];
    return `
      <div class="sf-addstep">
        <label class="sf-field">
          <span>Add a step that…</span>
          <select data-add-kind>
            <option value=""${kind ? "" : " selected"}>— pick what it does —</option>
            ${kinds.map((k) => `<option value="${esc(k)}"${k === kind ? " selected" : ""}>${esc(k.replace(/_/g, " "))}</option>`).join("")}
          </select>
        </label>
        <label class="sf-field">
          <span>…called</span>
          <input type="text" data-add-name value="${esc(this.addName ?? "")}" placeholder="a short name, used by other steps">
        </label>
        ${kind && needs.length ? `<p class="sf-note">This kind needs ${needs.map((x) => `<code>${esc(x)}</code>`).join(", ")} —
          a blank slot for each is created, and you fill it below once the step exists.</p>` : ""}
        <button type="button" data-add-go="1" ${kind && String(this.addName ?? "").trim() ? "" : "disabled"}>Add it</button>
      </div>`;
  }

  /** The selected step, with the controls that edit it. */
  _nodeInspector() {
    const n = this.graph?.nodes.find((x) => x.id === this.selectedNode);
    if (!n) return `<p class="sf-note">Click a step to edit it.</p>`;

    // Same rule as the fire-point picker: only rows that HAVE a name can be
    // pointed at. Every trigger row in this world is nameless, so without this
    // the "then" dropdown offered `__reaction_0` as a destination.
    const others = this.graph.nodes
      .filter((x) => x.id !== n.id && !x.labelIsSynthetic).map((x) => x.label);
    const reserved = reservedTargetRefOracle();

    // Only fields the row ALREADY carries are offered. Adding one means adding
    // a column, and a column the row's effect_kind does not declare is written,
    // reported as saved, and silently dropped — the failure this whole tool
    // exists to make impossible. Adding fields belongs to a kind-aware palette,
    // not to a free-for-all select.
    const fields = Object.keys(n.refs ?? {}).filter((f) => REF_FIELDS[f]);

    const controls = fields.map((field) => {
      const spec = REF_FIELDS[field];
      const current = this.graph.edges
        .filter((e) => e.from === n.id && e.field === field)
        .sort((a, b) => a.order - b.order)
        .map((e) => e.toLabel);
      const value = current.join(", ");

      if (spec.points_at === "step") {
        if (spec.kind === "single") {
          return `
            <label class="sf-field">
              <span>${esc(spec.label)}</span>
              <select data-ref="${esc(field)}" data-node-ref="${esc(n.id)}">
                <option value=""${value ? "" : " selected"}>— nothing —</option>
                ${others.map((l) => `<option value="${esc(l)}"${l === value ? " selected" : ""}>${esc(l)}</option>`).join("")}
              </select>
            </label>`;
        }
        // A list of steps, edited as text but CHECKED against the steps that
        // exist — the names are already on screen, and a multi-select that
        // cannot express order is worse than a line the author can read.
        const unknown = current.filter((c) => !others.includes(c));
        return `
          <label class="sf-field">
            <span>${esc(spec.label)}</span>
            <input type="text" data-ref="${esc(field)}" data-node-ref="${esc(n.id)}"
              value="${esc(value)}" placeholder="step names, in order, separated by commas">
          </label>
          ${unknown.length ? `<p class="sf-note sf-warn">No step is called
            ${unknown.map((u) => `"${esc(u)}"`).join(", ")}. It will not run.</p>` : ""}
          <p class="sf-note">Available: ${others.map((l) => esc(l)).join(", ") || "none"}</p>`;
      }

      // A target ref. The vocabulary is the engine's reserved words PLUS the
      // targeting rows in this skill — and when the engine's half is not
      // available, the field stays free text and says so, rather than offering
      // a list that silently omits most of the legal answers.
      const targetingRows = this.graph.nodes
        .filter((x) => String(x.kind).trim() === "targeting").map((x) => x.label);
      const bad = reserved ? current.filter((c) => !reserved(c) && !targetingRows.includes(c)) : [];
      return `
        <label class="sf-field">
          <span>${esc(spec.label)}</span>
          <input type="text" data-ref="${esc(field)}" data-node-ref="${esc(n.id)}"
            value="${esc(value)}" placeholder="self, action_targets, or a targeting step">
        </label>
        ${bad.length ? `<p class="sf-note sf-warn">${bad.map((b) => `"${esc(b)}"`).join(", ")}
          ${bad.length > 1 ? "are" : "is"} not a target the engine knows, and no targeting step is
          named that. This step would act on nobody.</p>` : ""}
        ${reserved
          ? `<p class="sf-note">Targeting steps here: ${targetingRows.map((l) => esc(l)).join(", ") || "none"}</p>`
          : `<p class="sf-note">NOT CHECKED — the engine's list of target words is not loaded, so
             this value cannot be verified from here.</p>`}`;
    }).join("");

    const referrers = this.graph.edges
      .filter((e) => e.to === n.id)
      .map((e) => (e.from === "__document__"
        ? "the skill itself"
        : this.graph.nodes.find((x) => x.id === e.from)?.label ?? e.from));

    return `
      <div class="sf-inspector">
        <h3>${esc(n.kind || "step")}</h3>
        ${n.labelIsSynthetic
          // Offering a box that the model will refuse is worse than offering
          // nothing: the author types, tabs away, sees a toast, and has no way
          // to tell a refusal from a save. Every trigger row in this world is
          // in this state.
          ? `<p class="sf-note">${n.isTrigger
              ? "A trigger row has no name of its own — it is identified by what it reacts to. " +
                "The name on the card is one this panel made up so it can draw the arrows."
              : "This row has no name stored in the data, so there is nothing to rename."}</p>`
          : `<label class="sf-field">
              <span>Name</span>
              <input type="text" data-rename="${esc(n.id)}" value="${esc(n.label)}">
            </label>`}
        <p class="sf-note">${referrers.length
          ? `Reached from ${referrers.map((r) => esc(String(r))).join(", ")}. Renaming updates ${referrers.length > 1 ? "them all" : "it"}.`
          : "Nothing reaches this step, so it never runs."}</p>
        ${controls || `<p class="sf-note">This step points at nothing.</p>`}
        ${this._kindFields(n)}
        <button type="button" class="sf-danger" data-remove="${esc(n.id)}">Remove this step</button>
      </div>`;
  }

  /**
   * How to draw one arrow: fine, broken, or not knowable from here.
   *
   * 🩸 "No node on the other end" is NOT the same as broken. `target_ref:
   * "self"` has no node and is completely correct — 1263 rows in this world say
   * it. The problems list learned that; the CARDS had not, so every one of
   * those rows would have shown a red "acts on → self (missing)".
   *
   * A target word this panel cannot check is drawn neutrally and says so,
   * rather than picking either lie.
   */
  _edgeStatus(e) {
    if (!e.dangling) return { cls: "", note: "" };
    if (e.pointsAt !== "target") return { cls: "sf-dangling", note: " <em>(missing)</em>" };
    const reserved = reservedTargetRefOracle();
    if (!reserved) return { cls: "sf-unchecked", note: " <em>(not checked)</em>" };
    return reserved(e.toLabel)
      ? { cls: "", note: "" }
      : { cls: "sf-dangling", note: " <em>(acts on nobody)</em>" };
  }

  _nodeCard(n) {
    const outs = this.graph.edges.filter((e) => e.from === n.id);
    const links = outs.map((e) => {
      const spec = REF_FIELDS[e.field];
      const label = spec?.label ?? e.field;
      const { cls, note } = this._edgeStatus(e);
      return `<li class="${cls}">${esc(label)} → ${esc(e.toLabel)}${note}</li>`;
    }).join("");
    const shown = Object.entries(n.extra)
      // `$…` are CSB's own bookkeeping (`$deleted`, `$predefinedIdx`), never
      // authored content. They ride through the round trip but showing them
      // would put "$deleted false" on the face of every card.
      .filter(([k, v]) => !k.startsWith("$") &&
        !["effect_kind", "effect_label"].includes(k) && String(v ?? "").trim() !== "")
      .slice(0, 5)
      .map(([k, v]) => `<li><span>${esc(k)}</span> ${esc(String(v).slice(0, 40))}</li>`).join("");
    return `
      <div class="sf-node ${n.isTrigger ? "sf-trigger" : ""}${
        n.id === this.selectedNode ? " sf-selected" : ""}" data-node="${esc(n.id)}">
        <div class="sf-node-kind">${esc(n.kind || "(no kind)")}</div>
        ${n.labelIsSynthetic
          // The handle this model invented for a nameless row is not a name and
          // must not be shown as one — a card reading `__reaction_0` teaches an
          // author an identifier that exists nowhere and that they cannot use.
          // The kind line above already says what the row is.
          ? `<div class="sf-node-label sf-unnamed">no name of its own</div>`
          : `<div class="sf-node-label">${esc(n.label)}</div>`}
        ${shown ? `<ul class="sf-node-fields">${shown}</ul>` : ""}
        ${links ? `<ul class="sf-node-links">${links}</ul>` : ""}
      </div>`;
  }

  // ── GATE: condition builder (stage 3) ─────────────────────────────────────
  /**
   * STAGE 3 — conditions, read AND written.
   *
   * ═══ THE RULE THIS PANEL IS BUILT AROUND ══════════════════════════════════
   *
   * The builder may never REPLACE a formula it could not READ. Over the whole
   * corpus it represents 571 of 778 authored gates and declines the other 207,
   * and the suite's headline invariant is that it alters ZERO. A tab that
   * offered to "edit" a declined formula would break that invariant at the one
   * moment it matters — with the author watching a plain-English sentence that
   * does not mean what their text meant.
   *
   * So a formula it cannot parse gets no edit control, only its own text and a
   * separate, explicit REPLACE action that says what is about to be lost.
   */
  _panelGate() {
    if (!this.graph) this.refreshGraph();
    if (!this.graph) return `<p class="sf-lede">Open a skill first.</p>`;

    const cards = this.graph.nodes.map((n) => {
      const raw = String(n.extra?.condition_formula ?? "").trim();
      const model = raw ? CB.parse(raw) : null;
      const editing = this.gateEditing === n.id;
      const where = `${n.kind || "step"} · ${n.labelIsSynthetic ? "no name of its own" : n.label}`;

      let body;
      if (editing) {
        body = this._gateBuilder(n);
      } else if (!raw) {
        body = `<div class="sf-gate-plain">Always applies.</div>
          <button type="button" data-gate-edit="${esc(n.id)}">Add a condition</button>`;
      } else if (model) {
        body = `<div class="sf-gate-plain">${esc(CB.explain(model))}</div>
          <code>${esc(raw)}</code>
          <button type="button" data-gate-edit="${esc(n.id)}">Edit</button>
          <button type="button" data-gate-clear="${esc(n.id)}">Remove the condition</button>`;
      } else {
        body = `<div class="sf-gate-plain"><em>kept as written</em></div>
          <code>${esc(raw)}</code>
          <p class="sf-note">The builder cannot read this one, so it will not offer to change
          it — anything it wrote would be a guess at what you meant. Edit it as text, or
          replace it outright.</p>
          <button type="button" data-gate-edit="${esc(n.id)}">Replace it with a built condition</button>
          <button type="button" data-gate-clear="${esc(n.id)}">Remove the condition</button>`;
      }

      return `<div class="sf-gate${editing ? " sf-gate-open" : ""}">
        <div class="sf-gate-where">${esc(where)}</div>
        ${body}
      </div>`;
    }).join("");

    return `
      ${this._wireBar()}
      <p class="sf-lede">A condition decides when a step applies. Build one from the lists —
      nothing here is typed as code unless you want it to be.</p>
      ${cards || "<p>This skill has no steps yet.</p>"}`;
  }

  /** The clause editor for one step. */
  _gateBuilder(node) {
    const draft = this.gateDraft ?? { join: "&&", clauses: [{ left: "", op: ">=", right: "" }] };
    const compiled = CB.compile(draft);
    const options = CB.identifierOptions();

    const clauses = draft.clauses.map((c, i) => {
      const known = options.some((o) => o.name === c.left);
      const desc = c.left ? CB.describeIdentifier(c.left) : null;
      return `
        <div class="sf-clause">
          <select data-clause="${i}" data-part="left">
            <option value=""${c.left ? "" : " selected"}>— pick a value —</option>
            ${options.map((o) => `<option value="${esc(o.name)}"${o.name === c.left ? " selected" : ""}>${esc(o.label)}</option>`).join("")}
            ${c.left && !known ? `<option value="${esc(c.left)}" selected>${esc(c.left)}</option>` : ""}
          </select>
          <select data-clause="${i}" data-part="op">
            ${CB.OPERATORS.map((o) => `<option value="${esc(o.op)}"${o.op === c.op ? " selected" : ""}>${esc(o.label)}</option>`).join("")}
          </select>
          <input type="text" data-clause="${i}" data-part="right" value="${esc(c.right ?? "")}" placeholder="value">
          ${draft.clauses.length > 1 ? `<button type="button" data-clause-remove="${i}">✕</button>` : ""}
          ${desc?.unlisted ? `<p class="sf-note sf-warn">“${esc(c.left)}” is not one the engine
            is known to serve. An identifier it does not know reads as 0, which blocks the step
            forever while still showing your reason.</p>` : ""}
        </div>`;
    }).join("");

    return `
      <div class="sf-gate-build">
        ${draft.clauses.length > 1 ? `
          <label class="sf-field">
            <span>Apply when</span>
            <select data-gate-join>
              ${CB.CONNECTIVES.map((c) => `<option value="${esc(c.join)}"${c.join === draft.join ? " selected" : ""}>${esc(c.label)}</option>`).join("")}
            </select>
          </label>` : ""}
        ${clauses}
        <button type="button" data-clause-add="1">Add another line</button>
        <p class="sf-gate-plain">${compiled
          ? esc(CB.explain(draft))
          : "<em>Nothing yet — pick a value and a comparison.</em>"}</p>
        ${compiled ? `<code>${esc(compiled)}</code>` : ""}
        <div class="sf-bar">
          <span class="sf-bar-state"></span>
          <button type="button" class="sf-primary" data-gate-apply="${esc(node.id)}" ${compiled ? "" : "disabled"}>Use this condition</button>
          <button type="button" data-gate-cancel="1">Cancel</button>
        </div>
      </div>`;
  }

  // ── TEST (stage 4) ────────────────────────────────────────────────────────
  /**
   * The verdict, in three states.
   *
   * "Did it work?" is the question this whole tab exists to answer, and the
   * panel used to answer it only by implication: a clean pass and a run that
   * proved nothing rendered as the same grey monospace block, distinguished by
   * a 3px border. Text AND colour, never colour alone.
   */
  _verdict(r) {
    if (!r) return "";
    const blocked = (r.caveats ?? []).some((c) => c.severity === "blocking");
    const didSomething = /\n\s{2}\S/.test(String(r.prose ?? "")) &&
      !/NOTHING WAS WRITTEN|THE RUN DID NOT START/.test(String(r.prose ?? ""));
    if (blocked) {
      return `<p class="sf-verdict sf-v-unknown">? This run cannot tell us whether it works.</p>`;
    }
    if (!didSomething) {
      return `<p class="sf-verdict sf-v-nothing">✕ It did nothing.</p>`;
    }
    return `<p class="sf-verdict sf-v-ok">✓ It did what it says below.</p>`;
  }

  /**
   * The practice target's affinities, read off the ACTOR.
   *
   * The panel used to pass `fixtures.enemy.affinities`, which the fixtures
   * helper has never returned — it answers `{ actorUuid, tokenUuid }` and
   * nothing else. So the immunity caveat was permanently unreachable, on a
   * bench dummy that is deliberately air-IMMUNE and bolt-VULNERABLE: an air
   * skill scored 0, and the one sentence that would have explained why never
   * printed. Read from the document instead of hoping a fixture carries it.
   */
  _affinitiesOf(fixture) {
    try {
      const actor = fixture?.actorUuid ? fromUuidSync(fixture.actorUuid) : null;
      const props = actor?.system?.props;
      if (!props) return null;
      const out = {};
      for (const [element, slot] of Object.entries(AFFINITY_SLOT_BY_ELEMENT)) {
        const code = String(props[slot] ?? "NA").trim().toUpperCase();
        if (code && code !== "NA") out[element] = code;
      }
      return out;
    } catch (e) {
      console.warn(`${TAG} could not read target affinities`, e);
      return null;
    }
  }

  _panelTest() {
    const r = this.lastTest;
    const busy = !!this.testRunning;
    return `
      <p class="sf-lede">Runs the skill against a practice creature. Nothing is saved and no
      real creature is touched.</p>
      ${this.graphDirty
        // The harness reads the DOCUMENT. An unsaved rewire is not in it, so a
        // run now measures the old wiring and reports it as this skill's
        // behaviour — a pass that proves nothing about what is on screen,
        // which is the exact failure mode the caveat system exists for.
        ? `<p class="sf-note sf-warn">The Wire tab has changes you have not saved. A test now
             runs the <strong>saved</strong> version, not what you are looking at.</p>`
        : ""}
      ${busy
        ? `<button type="button" class="sf-primary" disabled>Running the test…</button>
           <p class="sf-note sf-running">Setting up the practice fight and running the skill.
             This takes a few seconds.</p>`
        : `<button type="button" class="sf-primary" data-run="1">Run the test</button>`}
      ${!busy && this.lastTestPicksOwn
        ? `<p class="sf-note">This skill chooses its own target on the battlefield, so the
             practice run let it pick — the result below says who it actually affected.</p>`
        : (!busy && this.lastTestAgainst
          ? `<p class="sf-note">Tested against <strong>${esc(this.lastTestAgainst)}</strong>.</p>` : "")}
      <div aria-live="polite" aria-atomic="true">
        ${busy ? "" : this._verdict(r)}
        ${r && !busy ? `<pre class="sf-result ${(r.caveats ?? []).some((c) => c.severity === "blocking") ? "sf-unproven" : ""}">${esc(r.prose ?? "")}</pre>` : ""}
        ${r && !r.ok && !busy ? `<p class="sf-warn">${esc(r.reason ?? "the run did not complete")}</p>` : ""}
      </div>`;
  }

  // ── PUBLISH (stage 5) ─────────────────────────────────────────────────────
  _panelPublish() {
    const doc = this.docObject;
    if (!doc) return "";
    const { findings, skipped } = validate(doc);
    const decision = canPublish(findings);
    const draft = isDraft(doc);
    return `
      <p class="sf-lede">${draft ? "This skill is a <strong>draft</strong> — it is not offered in play yet."
        : "This skill is <strong>published</strong>."}</p>
      ${skipped?.length ? `<div class="sf-skipped"><strong>Not checked:</strong>
        <ul>${skipped.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>
        <em>These checks did not run, so this report does not cover them.</em></div>` : ""}
      <pre class="sf-decision ${decision.ok ? "sf-ok" : "sf-blocked"}">${esc(
        // \U0001f9a0 F9. `explainDecision` only ever answers "MAY this be published",
        // so after publishing it kept reading "… is ready to publish" directly
        // under a line saying the skill already was. Two sentences disagreeing,
        // on the one panel whose job is to tell a non-programmer what state
        // their skill is in.
        //
        // The decision is still the validator's; only the tense is ours.
        draft
          ? explainDecision(decision, doc.name)
          : decision.ok
            ? `${doc.name} is published, and still passes every check.`
              + (decision.advisories.length
                ? `\n\nIt has advisories that do not change what it does:\n`
                  + decision.advisories.map((a) => `  · ${a.title} (${a.where.length}×)`).join("\n")
                : "")
            // Published AND failing: it went out before a check existed, or it
            // was forced. Say so — this is the one combination a reader must
            // not mistake for either clean state.
            : `${doc.name} is PUBLISHED but no longer passes:\n\n`
              + explainDecision(decision, doc.name).split("\n").slice(1).join("\n")
      )}</pre>
      ${draft ? `<button type="button" class="sf-primary" data-publish="1" ${decision.ok ? "" : "disabled"}>Publish</button>`
        : `<button type="button" data-unpublish="1">Back to draft</button>`}`;
  }

  /**
   * The plain (non-reference) fields this step's KIND declares.
   *
   * Only columns the registry gates to this kind are offered, so the editor
   * cannot write one the kind does not declare. A field the row already carries
   * but the kind does not claim is still shown — it is authored content, and
   * hiding it would be the same "uneditable from any sheet" trap that
   * visibility-audit exists to report.
   */
  _kindFields(n) {
    const cols = columnsForKind(n.kind).filter((c) => !REF_FIELDS[c.key] &&
      !["effect_kind", "effect_label"].includes(c.key));
    const byKey = new Map(cols.map((c) => [c.key, c]));
    // Anything already on the row that the kind does not claim.
    const extraKeys = Object.keys(n.extra ?? {})
      .filter((k) => !k.startsWith("$") && !byKey.has(k) &&
        !["effect_kind", "effect_label"].includes(k));

    const required = new Set(requiredFieldsForKind(n.kind).all);
    const shown = [...cols.filter((c) => required.has(c.key) || String(n.extra?.[c.key] ?? "").trim() !== "")];
    const unused = cols.filter((c) => !shown.includes(c));

    const field = (key, label, tip) => {
      const v = String(n.extra?.[key] ?? "");
      const missing = required.has(key) && !v.trim();
      return `
        <label class="sf-field" title="${esc(tip ?? "")}">
          <span>${esc(label || key)}${required.has(key) ? " *" : ""}</span>
          <input type="text" data-field="${esc(key)}" data-field-node="${esc(n.id)}" value="${esc(v)}">
        </label>
        ${missing ? `<p class="sf-note sf-warn">This kind will not run without it.</p>` : ""}`;
    };

    return `
      <div class="sf-kindfields">
        ${shown.map((c) => field(c.key, c.colName, c.tooltip)).join("")}
        ${extraKeys.map((k) => field(k, k, "Authored on this row, though this kind does not declare it.")).join("")}
        ${unused.length ? `
          <details>
            <summary>${unused.length} more field(s) this kind can take</summary>
            ${unused.map((c) => field(c.key, c.colName, c.tooltip)).join("")}
          </details>` : ""}
      </div>`;
  }

  // ── events ────────────────────────────────────────────────────────────────
  activateListeners(html) {
    super.activateListeners(html);
    const root = html instanceof jQuery ? html[0] : html;

    root.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => {
      // An open clause editor belongs to the tab it was opened on. Carrying it
      // to another tab and back would show a builder half-filled with a step
      // the author is no longer looking at.
      if (b.dataset.tab !== "gate") { this.gateEditing = null; this.gateDraft = null; }
      this.tab = b.dataset.tab; this.render(false);
    }));
    root.querySelectorAll("[data-pattern]").forEach((b) => b.addEventListener("click", () => {
      this.patternId = b.dataset.pattern; this.patternValues = {}; this.render(false);
    }));
    const findBox = root.querySelector("[data-find-box]");
    if (findBox) {
      findBox.addEventListener("input", () => {
        this._applyFind(root, findBox.value);
        this._renderExistingMatches(root, findBox.value);
      });
      this._renderExistingMatches(root, findBox.value);
      // Esc clears rather than closing the window out from under the author.
      findBox.addEventListener("keydown", (ev) => {
        if (ev.key !== "Escape" || !findBox.value) return;
        ev.stopPropagation(); findBox.value = "";
        this._applyFind(root, "");
        this._renderExistingMatches(root, "");
      });
    }
    root.querySelectorAll("[data-continue]").forEach((b) => b.addEventListener("click", () => {
      this._openDocument(b.dataset.continue);
    }));
    // DELEGATED, because `_renderExistingMatches` writes these cards into the
    // DOM after this function has already run — a per-button listener here
    // would bind to the zero cards that exist at render time.
    root.querySelector("[data-existing]")?.addEventListener("click", (ev) => {
      const card = ev.target.closest?.("[data-open]");
      if (card) this._openDocument(card.dataset.open);
    });
    root.querySelectorAll("[data-basic]").forEach((el) => el.addEventListener("change", async () => {
      await this._saveBasic(el.dataset.basic, el.value);
    }));
    root.querySelector("[data-back]")?.addEventListener("click", () => {
      this.patternId = null; this.render(false);
    });
    root.querySelectorAll("[data-field]").forEach((el) => el.addEventListener("change", () => {
      this.patternValues[el.dataset.field] = el.type === "checkbox" ? el.checked : el.value;
      this.render(false);
    }));
    root.querySelector("[data-newname]")?.addEventListener("change", (ev) => {
      this.patternValues.__name = ev.target.value;
    });
    // No re-render: re-rendering would rebuild the 300-option list and throw
    // away the name the author may have typed but not yet committed.
    root.querySelector("[data-owner]")?.addEventListener("change", (ev) => {
      this.patternValues.__owner = ev.target.value;
    });
    root.querySelector("[data-create]")?.addEventListener("click", () => this._createFromPattern());
    root.querySelector("[data-run]")?.addEventListener("click", () => this._runTest());
    root.querySelector("[data-publish]")?.addEventListener("click", () => this._publish());
    root.querySelector("[data-unpublish]")?.addEventListener("click", () => this._setDraft(true));
    root.querySelectorAll("[data-node]").forEach((el) => el.addEventListener("click", () => {
      this.selectedNode = el.dataset.node; this.render(false);
    }));

    // ── wire editing ────────────────────────────────────────────────────────
    root.querySelectorAll("[data-entry]").forEach((el) => el.addEventListener("change", () => {
      setEntry(this.graph, el.value, el.dataset.entry);
      this._graphChanged();
    }));
    root.querySelector("[data-rename]")?.addEventListener("change", (ev) => {
      const res = renameNode(this.graph, ev.target.dataset.rename, ev.target.value);
      if (!res.ok) {
        // Put the old name back on screen. Leaving the rejected text in the box
        // under a toast reads as "saved, with a note" — the author walks away
        // believing the rename happened.
        ui.notifications?.warn(`Not renamed — ${res.reason}.`);
        this.render(false);
        return;
      }
      this._graphChanged();
    });
    root.querySelectorAll("[data-ref]").forEach((el) => el.addEventListener("change", () => {
      const parts = String(el.value ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      const res = setNodeRef(this.graph, el.dataset.nodeRef, el.dataset.ref, parts);
      // A silently-dropped value is the thing this tool exists to stop, even
      // when dropping it was right.
      if (res?.refused) {
        ui.notifications?.warn(`Ignored ${res.refused.join(", ")} — ` +
          `${res.refused.length > 1 ? "those rows have" : "that row has"} no name to point at.`);
      }
      this._graphChanged();
    }));
    root.querySelector("[data-remove]")?.addEventListener("click", async (ev) => {
      const id = ev.currentTarget.dataset.remove;
      const node = this.graph?.nodes.find((n) => n.id === id);
      if (!node) return;
      const ok = await Dialog.confirm({
        title: "Remove this step?",
        content: `<p>Remove <strong>${esc(node.label)}</strong>?</p>
          <p>Anything pointing at it will stop pointing at it. Nothing is written until you
          press Save.</p>`,
      });
      if (!ok) return;
      removeNode(this.graph, id);
      this.selectedNode = null;
      this._graphChanged();
    });
    // ── conditions (stage 3) ────────────────────────────────────────────────
    root.querySelectorAll("[data-gate-edit]").forEach((b) => b.addEventListener("click", () => {
      const node = this.graph?.nodes.find((n) => n.id === b.dataset.gateEdit);
      if (!node) return;
      const raw = String(node.extra?.condition_formula ?? "").trim();
      const model = raw ? CB.parse(raw) : null;
      // An unreadable formula is NOT loaded into the builder. Seeding it with a
      // partial reading is how "edit" becomes "silently rewrite" — the one
      // thing the builder's 0-ALTERED invariant forbids. Start empty, and the
      // panel has already said the old text is about to be replaced.
      this.gateDraft = model
        ? { join: model.join ?? "&&", clauses: model.clauses.map((c) => ({ ...c })) }
        : { join: "&&", clauses: [{ left: "", op: ">=", right: "" }] };
      this.gateEditing = node.id;
      this.render(false);
    }));
    root.querySelector("[data-gate-cancel]")?.addEventListener("click", () => {
      this.gateEditing = null; this.gateDraft = null; this.render(false);
    });
    root.querySelector("[data-gate-join]")?.addEventListener("change", (ev) => {
      this.gateDraft.join = ev.target.value === "||" ? "||" : "&&";
      this.render(false);
    });
    root.querySelectorAll("[data-clause]").forEach((el) => el.addEventListener("change", () => {
      const i = Number(el.dataset.clause);
      const c = this.gateDraft?.clauses?.[i];
      if (!c) return;
      c[el.dataset.part] = el.value;
      this.render(false);
    }));
    root.querySelector("[data-clause-add]")?.addEventListener("click", () => {
      this.gateDraft.clauses.push({ left: "", op: ">=", right: "" });
      this.render(false);
    });
    root.querySelectorAll("[data-clause-remove]").forEach((b) => b.addEventListener("click", () => {
      this.gateDraft.clauses.splice(Number(b.dataset.clauseRemove), 1);
      if (!this.gateDraft.clauses.length) this.gateDraft.clauses.push({ left: "", op: ">=", right: "" });
      this.render(false);
    }));
    root.querySelector("[data-gate-apply]")?.addEventListener("click", (ev) => {
      const id = ev.currentTarget.dataset.gateApply;
      const formula = CB.compile(this.gateDraft);
      if (!formula) return ui.notifications?.warn("Nothing to apply yet.");
      const res = setNodeField(this.graph, id, "condition_formula", formula);
      if (!res.ok) return ui.notifications?.error(`Could not set it: ${res.reason}`);
      this.gateEditing = null; this.gateDraft = null;
      this._graphChanged();
    });
    root.querySelectorAll("[data-gate-clear]").forEach((b) => b.addEventListener("click", async () => {
      const node = this.graph?.nodes.find((n) => n.id === b.dataset.gateClear);
      if (!node) return;
      const raw = String(node.extra?.condition_formula ?? "").trim();
      const ok = await Dialog.confirm({
        title: "Remove this condition?",
        content: `<p>The step will apply <strong>always</strong>.</p><p><code>${esc(raw)}</code></p>
          <p>Nothing is written until you press Save.</p>`,
      });
      if (!ok) return;
      setNodeField(this.graph, node.id, "condition_formula", "");
      this.gateEditing = null; this.gateDraft = null;
      this._graphChanged();
    }));

    root.querySelector("[data-add-kind]")?.addEventListener("change", (ev) => {
      this.addKind = ev.target.value; this.render(false);
    });
    // No re-render on every keystroke — that would replace the box being typed
    // into and take the caret with it, the same trap as the Find field.
    root.querySelector("[data-add-name]")?.addEventListener("input", (ev) => {
      this.addName = ev.target.value;
      const go = root.querySelector("[data-add-go]");
      if (go) go.disabled = !(this.addKind && this.addName.trim());
    });
    root.querySelector("[data-add-go]")?.addEventListener("click", () => {
      const made = newRowFor(this.addKind, this.addName);
      if (!made.ok) return ui.notifications?.warn(made.reason);
      const res = addNode(this.graph, "effect_table", made.row);
      if (!res.ok) return ui.notifications?.warn(`Not added — ${res.reason}.`);
      this.selectedNode = res.nodeId;
      this.addKind = ""; this.addName = "";
      ui.notifications?.info(`Added "${made.row.effect_label}". Nothing is written until you save.`);
      this._graphChanged();
    });
    root.querySelectorAll("[data-field]").forEach((el) => el.addEventListener("change", () => {
      const res = setNodeField(this.graph, el.dataset.fieldNode, el.dataset.field, el.value);
      if (!res.ok) return ui.notifications?.error(`Could not set it: ${res.reason}`);
      this._graphChanged();
    }));
    root.querySelector("[data-graph-save]")?.addEventListener("click", () => this._saveGraph());
    root.querySelector("[data-graph-discard]")?.addEventListener("click", () => {
      this.refreshGraph({ force: true });
      this.graphDirty = false;
      this.selectedNode = null;
      this.render(false);
    });
  }

  /** One edit landed on the in-memory graph. Nothing is written yet. */
  _graphChanged() {
    this.graphDirty = true;
    this.render(false);
  }

  // ── actions ───────────────────────────────────────────────────────────────
  async _createFromPattern() {
    const { props, effects, missing } = expand(this.patternId, this.patternValues);
    if (missing.length) return ui.notifications?.warn(`Still needed: ${missing.join(", ")}`);
    const name = String(this.patternValues.__name ?? "").trim() || "New Skill";

    const data = {
      name, type: "equippableItem",
      system: { template: SKILL_TEMPLATE_ID, props: { ...props, name } },
      // Created as a DRAFT. A half-authored skill must not be pickable in play,
      // and the publish gate is what decides when that changes.
      flags: { [NS]: { skillForgeDraft: true } },
    };
    if (effects.length) {
      data.effects = effects.map((e) => ({ ...e, name: e.name === "__SKILL_NAME__" ? name : e.name }));
    }
    // An owner turns this into an EMBEDDED item on that creature, which is the
    // only shape the play layer looks at: `gatherSkillsForActor` walks
    // `actor.items` for anything carrying a `skill_type`. A world Item in the
    // sidebar is never offered to anyone — before this existed, every skill the
    // Forge produced had to be dragged onto a sheet by hand, and nothing in the
    // panel said so.
    const ownerId = String(this.patternValues.__owner ?? "").trim();
    const owner = ownerId ? game.actors?.get(ownerId) : null;
    if (ownerId && !owner) {
      return ui.notifications?.error("That creature no longer exists — pick another owner.");
    }

    try {
      const created = owner
        ? (await owner.createEmbeddedDocuments("Item", [data]))?.[0]
        : await Item.create(data);
      if (!created) return ui.notifications?.error("Could not create the skill.");
      this.item = created;
      this.tab = "wire";
      this.graphDirty = false;
      this._forgetSkillIndex();
      this.refreshGraph({ force: true });
      ui.notifications?.info(owner
        ? `Created "${name}" on ${owner.name} as a draft.`
        : `Created "${name}" as a draft, in the Items sidebar.`);
      this.render(false);
    } catch (e) {
      console.error(`${TAG} create failed`, e);
      ui.notifications?.error(`Could not create the skill: ${e.message}`);
    }
  }

  /**
   * Write one Basics field.
   *
   * 🪤 The NAME lives in two places: the document's own `name`, and
   * `system.props.name`, which the pattern writes and the CSB sheet renders.
   * Setting only one leaves the skill called two different things depending on
   * where you look, so both move together.
   */
  async _saveBasic(field, raw) {
    if (!this.item) return;
    const value = String(raw ?? "");
    try {
      if (field === "name") {
        const name = value.trim();
        if (!name) return ui.notifications?.warn("A skill needs a name.");
        await this.item.update({ name, "system.props.name": name });
        // The list is searched BY name.
        this._forgetSkillIndex();
      } else {
        await this.item.update({ [`system.props.${field}`]: value });
      }
      this.refreshGraph();
      this.render(false);
    } catch (e) {
      console.error(`${TAG} could not save ${field}`, e);
      ui.notifications?.error(`Could not save that change: ${e.message}`);
    }
  }

  /**
   * Current resource values for the practice creatures, keyed by actor uuid.
   *
   * Only the paths the result renderer can label. A snapshot of everything
   * would be a second opinion about what a resource IS, next to the one
   * `RESOURCE_LABELS` already holds.
   */
  _snapshotResources(fixtures) {
    const out = {};
    const PATHS = ["system.props.hp", "system.props.mp", "system.props.ip",
      "system.props.shield_value", "system.props.current_hp", "system.props.current_mp"];
    for (const f of Object.values(fixtures ?? {})) {
      const uuid = f?.actorUuid;
      if (!uuid) continue;
      let actor = null;
      try { actor = fromUuidSync(uuid); } catch (_e) { actor = null; }
      if (!actor) continue;
      const bag = {};
      for (const path of PATHS) {
        const v = foundry.utils.getProperty(actor, path);
        if (typeof v === "number") bag[path] = v;
      }
      if (Object.keys(bag).length) out[uuid] = bag;
    }
    return out;
  }

  async _runTest() {
    // Every early return below CLEARS the previous result first. Returning on a
    // toast alone left the last run's green prose sitting under the button the
    // author had just pressed — which reads as "I tested it again and it is
    // still fine", the most expensive possible misreading.
    const stop = (msg) => {
      this.lastTest = null;
      this.render(false);
      return ui.notifications?.warn(msg);
    };

    const api = globalThis.FUCompanion?.api?.test;
    if (typeof api?.getDirectorTestFixtures !== "function") {
      return stop("The test harness is not available in this world.");
    }

    // 🪤 getDirectorTestFixtures() returns NULL when any of Test Caster / Test
    // Target Ally / Test Target Enemy / the Training Ground scene is missing —
    // not only when the harness is absent. Reporting that as "harness
    // unavailable" is the exact wrong-blame this guard exists to remove, and
    // the missing-fixtures case is by far the likelier one.
    const fixtures = await api.getDirectorTestFixtures();
    if (!fixtures) {
      return stop("The practice scene or its test creatures are missing, so there is nothing " +
        "to test against. Restore the Training Ground fixtures and try again.");
    }

    // The actors can exist while their TOKENS have been cleared off the scene;
    // the helper then answers with null uuids and the harness refuses with a
    // message about arguments, which reads like the skill is broken.
    const missing = [
      !fixtures.caster?.tokenUuid && "Test Caster",
      !fixtures.enemy?.tokenUuid && "Test Target Enemy",
    ].filter(Boolean);
    if (missing.length) {
      return stop(`The practice scene is missing its ${missing.join(" and ")} token(s), so there ` +
        `is nothing to test against. Place them on the practice scene and try again.`);
    }

    if (!this.item) return stop("Open a skill before running the test.");
    // 🚨 Re-entrancy is not cosmetic here. The simulate monkey-patches the
    // Actor/Item/ActiveEffect prototypes to capture writes, and runTest's own
    // catch documents that a throw leaves those patches INSTALLED, after which
    // every document write in the session is silently swallowed. Two clicks on
    // an undisabled button during a ~15s run is the easy way to get there.
    if (this.testRunning) return;

    // WHICH practice creature. The panel used to hand every skill the ENEMY
    // fixture, so `heal_ally`, `buff_ally` and `cleanse_ally` resolved their
    // ally-category targeting against a hostile, matched nothing, wrote nothing
    // — and the tab then reported a perfectly good skill as doing nothing, with
    // no control anywhere to change the target. The ally fixture was returned
    // by the harness all along and simply never used.
    const props = this.docObject?.system?.props ?? {};
    const targetSide = String(props.skill_target ?? "").toLowerCase();
    const wantsAlly = /ally|allies/.test(targetSide);
    const wantsSelf = /^self$/.test(targetSide.trim());
    const targetFixture = wantsAlly ? fixtures.ally : fixtures.enemy;
    const targetName = wantsAlly ? "Test Target Ally" : "Test Target Enemy";

    // ⚠ A skill carrying its own `targeting` step RESOLVES ITS OWN TARGET from
    // the battlefield and ignores the one handed to it. Measured: an
    // enemy-targeting skill given the practice dummy hit a different creature
    // entirely. So the panel must not promise "tested against X" for these —
    // that is a claim the run does not honour, which is the same species of
    // quiet untruth this tab exists to stamp out.
    const picksOwnTarget = tableRows(props.effect_table)
      .some((r) => String(r.effect_kind ?? "") === "targeting");

    // A skill that belongs to a creature should be tested AS that creature —
    // its attributes, affinities and equipment are what the numbers come from.
    // That only works when the owner has a token on the practice scene; when it
    // does not, the run still happens as the practice caster, but saying so is
    // the difference between a number and a misleading number.
    const owner = this.item?.parent;
    const ownerTokenUuid = (owner?.documentName === "Actor")
      ? Array.from(game.scenes?.get(fixtures.scene?.id)?.tokens ?? [])
          .find((t) => t.actor?.id === owner.id)?.uuid ?? null
      : null;
    const standIn = !!owner && owner.documentName === "Actor" && !ownerTokenUuid;

    // An ally skill cast by a creature with no ALLY on the practice scene
    // resolves its ally-category targeting against nobody, writes nothing, and
    // reads as a broken skill. Swapping in the ally fixture does not help: the
    // targeting row judges "ally" relative to the CASTER, so a monster's allies
    // are other monsters. Detect it up front and say so, rather than let a
    // working heal report as dead.
    const scene = game.scenes?.get(fixtures.scene?.id);
    const casterTok = Array.from(scene?.tokens ?? [])
      .find((t) => t.uuid === (ownerTokenUuid ?? fixtures.caster?.tokenUuid));
    const sideMates = Array.from(scene?.tokens ?? []).filter((t) =>
      t.uuid !== casterTok?.uuid && t.disposition === casterTok?.disposition);
    const allyImpossible = wantsAlly && !wantsSelf && sideMates.length === 0;

    this.testRunning = true;
    this.lastTestAgainst = wantsSelf ? "itself"
      : picksOwnTarget ? null      // the skill chooses; do not promise a name
      : targetName;
    this.lastTestPicksOwn = picksOwnTarget && !wantsSelf;
    this.render(false);
    try {
      // 🩸 F8. Snapshot the practice creatures' resources BEFORE the run, so
      // the result can say "-26 from 9999" instead of "set to 9973". The
      // harness reports only the value it wrote; the number the author is
      // actually checking is the difference, and on a dummy that starts at
      // 9999 the landing value buries it.
      //
      // Read off the ACTOR, not a fixture field: `getDirectorTestFixtures()`
      // returns `{actorUuid, tokenUuid}` and nothing else — asking it for more
      // is how two caveats in this file came to be permanently unreachable.
      this.lastTestBefore = this._snapshotResources(fixtures);
      this.lastTest = await runTest({
        skillUuid: this.item?.uuid,
        casterTokenUuid: ownerTokenUuid ?? fixtures.caster?.tokenUuid,
        targetTokenUuids: wantsSelf ? [] : [targetFixture?.tokenUuid].filter(Boolean),
        acceptReactions: true,
        doc: this.docObject,
        targetAffinities: this._affinitiesOf(targetFixture),
      });
    } finally {
      this.testRunning = false;
    }
    // 🩸 A restore tested on a creature at FULL health writes nothing, because
    // there is nothing to restore — and "nothing written" is the panel's signal
    // for a dead skill. Measured: a correct `heal_ally` reported NOTHING WAS
    // WRITTEN purely because every creature on the practice scene sits at max
    // HP. Without this the tool tells an author their working heal is broken.
    const grantRow = tableRows(props.effect_table)
      .find((r) => String(r.effect_kind ?? "") === "grant" && r.grant_resource);
    if (grantRow && this.lastTest && !((this.lastTest.raw?.captures?.actorUpdates ?? []).length)) {
      const res = String(grantRow.grant_resource).toLowerCase();
      const full = [];
      for (const fx of [targetFixture, fixtures.caster]) {
        const actor = fx?.actorUuid ? fromUuidSync(fx.actorUuid) : null;
        const p = actor?.system?.props;
        if (!p) continue;
        const cur = Number(p[`current_${res}`]), max = Number(p[`max_${res}`]);
        if (Number.isFinite(cur) && Number.isFinite(max) && cur >= max) full.push(actor.name);
      }
      if (full.length) {
        this.lastTest.caveats = [{
          severity: "blocking",
          text: `Nothing was restored because ${full.join(" and ")} ${full.length > 1 ? "are" : "is"} ` +
            `already at full ${res.toUpperCase()}. A restore with nothing to restore writes ` +
            `nothing, which looks exactly like a broken skill from here.`,
          fix: `Wound a practice creature first, then run this again.`,
        }, ...(this.lastTest.caveats ?? [])];
        this.lastTest.prose = describeRun({
        result: this.lastTest.raw, doc: this.docObject, caveats: this.lastTest.caveats,
        before: this.lastTestBefore,
      });
      }
    }

    if (allyImpossible && this.lastTest) {
      const who = (ownerTokenUuid ? this.item?.parent?.name : "The practice caster") ?? "The caster";
      this.lastTest.caveats = [{
        severity: "blocking",
        text: `This skill helps an ally, but ${who} has nobody on their side on the practice ` +
          `scene — so there was no ally to act on and nothing could happen. That is a gap in ` +
          `the practice setup, NOT evidence about this skill.`,
        fix: `Put a second creature on ${who}'s side of the practice scene, or test this one in play.`,
      }, ...(this.lastTest.caveats ?? [])];
      this.lastTest.prose = describeRun({
        result: this.lastTest.raw, doc: this.docObject, caveats: this.lastTest.caveats,
        before: this.lastTestBefore,
      });
    }
    if (standIn && this.lastTest) {
      this.lastTest.caveats = [{
        severity: "note",
        text: `${owner.name} has no token on the practice scene, so this ran as the practice ` +
          `caster instead. Any number that depends on who is casting — attributes, bonuses, ` +
          `equipment — is not ${owner.name}'s.`,
        fix: `Place ${owner.name} on the practice scene to test with their own numbers.`,
      }, ...(this.lastTest.caveats ?? [])];
      this.lastTest.prose = describeRun({
        result: this.lastTest.raw, doc: this.docObject, caveats: this.lastTest.caveats,
        before: this.lastTestBefore,
      });
    }
    this.render(false);
  }

  /**
   * Persist the graph.
   *
   * NULL the table first, then write the full key set. A CSB update on a
   * `*_table` deep-merges, so writing rows over the top of the old ones leaves
   * any key the new row omits still sitting there — behaviour nobody authored.
   */
  async saveGraph() {
    if (!this.item || !this.graph) return { ok: false, reason: "nothing open" };
    const tables = fromGraphWithEdges(this.graph);

    // 🩸 THE NULL IS A CLIFF. Between the two updates below the skill has NO
    // rows at all, so a failure on the second one leaves a document that is
    // not half-saved — it is empty. That was tolerable while `saveGraph` had
    // no caller; it is not tolerable behind a button. Keep what was there and
    // put it back if the write does not land.
    const before = this.docObject?.system?.props ?? {};
    const rollback = {
      "system.props.effect_table": before.effect_table ?? null,
      "system.props.reaction_config_table": before.reaction_config_table ?? null,
    };
    // Write back only the fire points this document actually carries — adding
    // `pre_activate_effect_ref: ""` to a skill that never had it is an
    // undeclared prop, which `reloadTemplate` prunes while reporting success.
    const firePointPatch = {};
    for (const field of Object.keys(FIRE_POINTS)) {
      if (!(field in (this.graph.entries ?? {}))) continue;
      rollback[`system.props.${field}`] = before[field] ?? "";
      firePointPatch[`system.props.${field}`] = this.graph.entries[field] ?? "";
    }

    try {
      await this.item.update({
        "system.props.effect_table": null,
        "system.props.reaction_config_table": null,
      });
      await this.item.update({
        "system.props.effect_table": tables.effect_table,
        "system.props.reaction_config_table": tables.reaction_config_table,
        // Fire points are top-level props, not rows — the one thing the graph
        // could change that this function did not write. All THREE of them: a
        // live run caught a rename leaving `pre_activate_effect_ref` pointing
        // at a step that no longer existed.
        ...firePointPatch,
      });
    } catch (e) {
      console.error(`${TAG} saveGraph failed — restoring`, e);
      try {
        await this.item.update({ "system.props.effect_table": null, "system.props.reaction_config_table": null });
        await this.item.update(rollback);
      } catch (e2) {
        console.error(`${TAG} rollback ALSO failed`, e2);
        return { ok: false, reason: e.message, rolledBack: false };
      }
      return { ok: false, reason: e.message, rolledBack: true };
    }

    this.refreshGraph({ force: true });
    return { ok: true };
  }

  /** Save, then say what the document now says — not what we meant to write. */
  async _saveGraph() {
    const res = await this.saveGraph();
    if (!res?.ok) {
      this.render(false);
      return ui.notifications?.error(res?.rolledBack === false
        ? `Could not save, AND could not put the old rows back: ${res.reason}. ` +
          `Do not close this window — the skill's steps may be missing.`
        : `Could not save: ${res?.reason ?? "unknown"}. Nothing was changed.`);
    }
    this.graphDirty = false;
    // Re-validating here is the point: a rewire can create exactly the
    // findings the publish gate blocks on, and the author should learn that
    // now rather than two tabs later.
    const { findings } = validate(this.docObject);
    const errors = findings.filter((f) => f.severity === "error");
    ui.notifications?.info(errors.length
      ? `Saved. ${errors.length} problem(s) now block publishing — see the Publish tab.`
      : "Saved.");
    this.render(false);
  }

  /** The world changed under the index; rebuild it on next use. */
  _forgetSkillIndex() { this._skillIndexCache = null; }

  async _setDraft(on) {
    if (!this.item) return;
    await this.item.update(draftPatch(on));
    // Draft state is shown on every card in the list.
    this._forgetSkillIndex();
    this.render(false);
  }

  async _publish() {
    const doc = this.docObject;
    const { findings } = validate(doc);
    const res = await publish({ doc, findings, write: (p) => this.item.update(p) });
    if (res.ok) this._forgetSkillIndex();
    if (res.ok) ui.notifications?.info(`Published "${doc.name}".`);
    else ui.notifications?.warn("Not published — see the reasons listed.");
    this.render(false);
  }

  _styles() {
    return `<style>
      .fud-skill-forge .sf-root { font-family: var(--font-primary); padding: 4px 8px; }
      .fud-skill-forge .sf-tabs { display: flex; gap: 4px; border-bottom: 1px solid #0003; margin-bottom: 10px; }
      /* 🪤 Same trap as .sf-primary: Foundry core styles a body-level button to
         FULL WIDTH, so the flex row stretched all six tabs to an identical
         153px each — 918px of a 948px strip, with 32px spare. That reads as a
         hard ceiling on how many sections the tool can ever have, when it is
         only an inherited rule. Measured with width reclaimed: 374px total,
         48-88px per tab, room for roughly fifteen. */
      .fud-skill-forge .sf-tab { background: none; border: none; padding: 6px 12px; cursor: pointer;
        border-bottom: 2px solid transparent; width: auto; flex: 0 0 auto; }
      .fud-skill-forge .sf-tab.active { border-bottom-color: #7a4; font-weight: 600; }
      .fud-skill-forge .sf-tab:disabled { opacity: .4; cursor: default; }
      .fud-skill-forge .sf-lede { opacity: .8; margin: 0 0 10px; }
      .fud-skill-forge .sf-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 8px; }
      .fud-skill-forge .sf-card { text-align: left; padding: 8px; border: 1px solid #0002; border-radius: 6px;
        background: #0000000a; cursor: pointer; display: flex; flex-direction: column; gap: 4px; }
      .fud-skill-forge .sf-card:hover { background: #0000001a; }
      .fud-skill-forge .sf-card span { font-size: 11px; opacity: .75; }
      .fud-skill-forge .sf-group { margin: 12px 0 6px; text-transform: capitalize; }
      .fud-skill-forge .sf-field { display: flex; align-items: center; gap: 8px; margin: 4px 0; }
      .fud-skill-forge .sf-field > span { flex: 0 0 210px; }
      /* 🪤 Foundry core styles a body-level button to FULL WIDTH, which turned
         every primary action ("Create this skill as a draft", "Run the test",
         "Publish") into an edge-to-edge bar that reads as a banner rather than
         a control — and a full-width bar also swallows clicks meant for what
         sits beside it. Width must be reclaimed explicitly. */
      .fud-skill-forge .sf-primary {
        width: auto; display: inline-block; margin-top: 10px;
        padding: 6px 16px; font-weight: 600; cursor: pointer;
        border: 1px solid rgba(0,0,0,.35); border-radius: 4px;
      }
      .fud-skill-forge .sf-primary:hover:not(:disabled) { background: rgba(0,0,0,.07); }
      .fud-skill-forge .sf-running { font-style: italic; }
      /* 🩸 The hidden PROPERTY sets display:none through the UA sheet, which
         ANY author display rule outranks — and .sf-card is display:flex. So
         filtering set the property on all thirty cards and every one of them
         stayed on screen, under a counter cheerfully reporting "2 of 45 match".
         Caught by looking at a screenshot: the probe read back the same
         property the filter writes, so it agreed with itself. */
      .fud-skill-forge [hidden] { display: none !important; }
      .fud-skill-forge .sf-search { display: flex; align-items: center; gap: 8px; margin: 2px 0 12px; }
      .fud-skill-forge .sf-search-label { font-weight: 600; flex: 0 0 auto; }
      .fud-skill-forge .sf-search input { flex: 1 1 auto; width: auto; }
      .fud-skill-forge .sf-count {
        font-size: 11px; font-weight: 600; opacity: .65; margin-left: 6px;
        border: 1px solid currentColor; border-radius: 8px; padding: 0 6px;
      }
      .fud-skill-forge .sf-field-tall { align-items: flex-start; }
      .fud-skill-forge .sf-field-tall textarea { width: 100%; font-family: inherit; }
      .fud-skill-forge .sf-field em { opacity: .7; font-size: 11px; }
      /* The verdict answers "did it work?" in one glance. Glyph + word carry
         the meaning; colour only reinforces it. */
      .fud-skill-forge .sf-verdict {
        font-weight: 700; margin: 12px 0 4px; padding: 6px 10px;
        border-left: 4px solid currentColor; border-radius: 0 4px 4px 0;
      }
      .fud-skill-forge .sf-v-ok      { color: #2f6b3a; background: rgba(47,107,58,.10); }
      .fud-skill-forge .sf-v-unknown { color: #8a5a12; background: rgba(138,90,18,.10); }
      .fud-skill-forge .sf-v-nothing { color: #8f2f28; background: rgba(143,47,40,.10); }
      .fud-skill-forge .sf-tab:focus-visible,
      .fud-skill-forge .sf-card:focus-visible,
      .fud-skill-forge .sf-back:focus-visible,
      .fud-skill-forge .sf-primary:focus-visible {
        outline: 2px solid #7a4; outline-offset: 2px;
      }
      /* A blocked gate has to LOOK blocked. Both the publish button and the
         "create" button render as disabled when their gate refuses, but only
         the tab rule covered :disabled — so the button sat there looking
         perfectly clickable, did nothing when pressed, and gave the author no
         clue that the red panel above it was the reason. */
      .fud-skill-forge .sf-primary:disabled {
        opacity: .45; cursor: not-allowed; font-style: italic;
      }
      .fud-skill-forge .sf-graph { display: flex; gap: 14px; overflow-x: auto; padding-bottom: 8px; }
      .fud-skill-forge .sf-col { min-width: 190px; }
      .fud-skill-forge .sf-col-head { font-size: 11px; opacity: .6; margin-bottom: 4px; }
      .fud-skill-forge .sf-node { border: 1px solid #0003; border-radius: 6px; padding: 6px; margin-bottom: 8px;
        background: #0000000a; cursor: pointer; }
      .fud-skill-forge .sf-node.sf-trigger { border-color: #c93; background: #c9930f14; }
      .fud-skill-forge .sf-node-kind { font-size: 10px; text-transform: uppercase; opacity: .6; }
      .fud-skill-forge .sf-node-label { font-weight: 600; }
      .fud-skill-forge .sf-node-fields, .fud-skill-forge .sf-node-links { margin: 4px 0 0; padding-left: 14px; font-size: 11px; }
      .fud-skill-forge .sf-node-fields span { opacity: .6; }
      .fud-skill-forge .sf-dangling { color: #c33; }
      /* Not knowable from here is neither fine nor broken — see _edgeStatus.
         NO BACKTICKS IN THIS FUNCTION: it is one template literal, so a pair
         of them closes and reopens it and the file still has an EVEN count.
         This is the fourth time that has broken this file. */
      .fud-skill-forge .sf-unchecked { color: #c93; }
      .fud-skill-forge .sf-unnamed { font-weight: 400; font-style: italic; opacity: .55; }
      .fud-skill-forge .sf-gate-open { border-color: #7a4; background: #77aa4410; }
      .fud-skill-forge .sf-gate-build { margin-top: 8px; }
      .fud-skill-forge .sf-clause { display: flex; gap: 6px; align-items: center; margin: 4px 0; flex-wrap: wrap; }
      .fud-skill-forge .sf-clause select { flex: 1 1 180px; min-width: 120px; }
      .fud-skill-forge .sf-clause input { flex: 0 1 120px; }
      .fud-skill-forge .sf-clause button { width: auto; flex: 0 0 auto; }
      .fud-skill-forge .sf-clause .sf-note { flex: 1 1 100%; }
      .fud-skill-forge .sf-gate button { width: auto; }
      .fud-skill-forge .sf-addstep { border: 1px dashed #0003; border-radius: 6px; padding: 8px;
        margin-top: 10px; }
      .fud-skill-forge .sf-addstep button { width: auto; }
      .fud-skill-forge .sf-kindfields { margin-top: 8px; border-top: 1px solid #0002; padding-top: 8px; }
      .fud-skill-forge .sf-kindfields summary { cursor: pointer; opacity: .75; font-size: 12px; margin: 6px 0; }
      .fud-skill-forge .sf-problems { margin-bottom: 10px; }
      .fud-skill-forge .sf-problem { border-left: 3px solid #c33; padding: 4px 8px; margin-bottom: 4px;
        background: #c3333314; font-size: 12px; }
      /* "We did not check this" is NOT a fault — painting it the same red as a
         broken reference is how a skip gets read as a failure and dismissed
         along with the rest. Amber, and its title says NOT CHECKED. */
      .fud-skill-forge .sf-problem.sf-p-not_checked { border-left-color: #c93; background: #cc993314; }
      .fud-skill-forge .sf-banner { border-left: 3px solid #c93; background: #cc993314; padding: 6px 10px;
        margin: 0 0 10px; font-size: 12px; }
      .fud-skill-forge .sf-banner p { margin: 2px 0; }
      .fud-skill-forge .sf-bar { display: flex; align-items: center; gap: 8px; margin-bottom: 8px;
        padding-bottom: 8px; border-bottom: 1px solid #0002; }
      .fud-skill-forge .sf-bar-state { flex: 1 1 auto; font-size: 12px; opacity: .8; }
      /* Same full-width-button trap as the tabs: Foundry styles a body-level
         button to 100%, which would stack the bar vertically and push the
         graph off screen. */
      .fud-skill-forge .sf-bar button { width: auto; flex: 0 0 auto; }
      .fud-skill-forge .sf-entry { margin-bottom: 8px; }
      .fud-skill-forge .sf-inspector { border: 1px solid #0002; border-radius: 6px; padding: 8px;
        margin-top: 10px; background: #0000000a; }
      .fud-skill-forge .sf-inspector h3 { margin: 0 0 6px; text-transform: capitalize; }
      .fud-skill-forge .sf-danger { width: auto; margin-top: 6px; border-color: #c33; color: #c33; }
      .fud-skill-forge .sf-node.sf-selected { outline: 2px solid #7a4; }
      .fud-skill-forge .sf-gate { border: 1px solid #0002; border-radius: 6px; padding: 6px; margin-bottom: 6px; }
      .fud-skill-forge .sf-gate-where { font-size: 10px; opacity: .6; }
      .fud-skill-forge .sf-gate-plain { font-weight: 600; margin: 2px 0; }
      .fud-skill-forge .sf-gate code { font-size: 11px; opacity: .7; }
      .fud-skill-forge .sf-result { white-space: pre-wrap; background: #0000000d; padding: 8px; border-radius: 6px; }
      .fud-skill-forge .sf-result.sf-unproven { border-left: 3px solid #c93; }
      .fud-skill-forge .sf-decision { white-space: pre-wrap; padding: 8px; border-radius: 6px; }
      .fud-skill-forge .sf-decision.sf-ok { background: #3a3a; }
      .fud-skill-forge .sf-decision.sf-blocked { background: #c3333314; border-left: 3px solid #c33; }
      .fud-skill-forge .sf-skipped { background: #c9930f14; border-left: 3px solid #c93; padding: 6px 8px; margin-bottom: 8px; font-size: 12px; }
      .fud-skill-forge .sf-warn { color: #c33; }
      .fud-skill-forge .sf-note { font-size: 11px; opacity: .7; }
      .fud-skill-forge .sf-back { background: none; border: none; cursor: pointer; opacity: .7; padding: 0 0 6px; }
    </style>`;
  }
}

// ── registration ────────────────────────────────────────────────────────────
Hooks.once("ready", () => {
  globalThis.FUCompanion = globalThis.FUCompanion ?? {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api ?? {};
  globalThis.FUCompanion.api.skillForge = {
    open: (item) => SkillForgeApp.open(item),
    App: SkillForgeApp,
  };

  // Register on the dev-tools launcher the way every other tool does — a direct
  // import of the ES export. An earlier version guessed at
  // `FUCompanion.api.devTools.registerDevTool`, which does not exist; wrapped in
  // a try/catch it would have failed SILENTLY and the Forge would simply never
  // have appeared in the launcher, with nothing in the console to say why.
  // The import is static (see the top of this file), so a rename breaks the
  // module load loudly instead.
  registerDevTool({
    id: "skill-forge", icon: "🛠", label: "Skill Forge",
    onClick: () => SkillForgeApp.open(),
  });

  console.debug(`${TAG} ready — FUCompanion.api.skillForge.open()`);
});
