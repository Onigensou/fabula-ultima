// [ONI] Skill Forge — the application.
// ---------------------------------------------------------------------------
// Ties the five stages into one window:
//
//   START    pick a PATTERN (stage 2) or open an existing skill
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

import { PATTERNS, patternsByCommand, expand, defaultsFor } from "./patterns.js";
import { toGraph, fromGraphWithEdges, graphProblems, assignDepths, REF_FIELDS } from "./graph-model.js";
import * as CB from "./condition-builder.js";
import { runTest } from "./test-runner.js";
import { canPublish, explainDecision, isDraft, draftPatch, publish } from "./publish.js";
import { registerDevTool } from "../battle-director/dev-tools-menu.js";

const NS = "fabula-ultima-companion";
const TAG = "[SkillForge]";
const SKILL_TEMPLATE_ID = "j0F5Msw5RZ8aIB3j";

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
    const app = new SkillForgeApp({ item });
    app.render(true);
    return app;
  }

  // ── data ──────────────────────────────────────────────────────────────────
  get docObject() {
    if (!this.item) return null;
    return typeof this.item.toObject === "function" ? this.item.toObject() : this.item;
  }

  refreshGraph() {
    const doc = this.docObject;
    this.graph = doc ? toGraph(doc.system?.props ?? {}) : null;
  }

  // ── render ────────────────────────────────────────────────────────────────
  async _renderInner() {
    const html = `
      <div class="sf-root">
        ${this._styles()}
        <nav class="sf-tabs">
          ${this._tabButton("start", "Start")}
          ${this._tabButton("wire", "Wire", !this.item)}
          ${this._tabButton("gate", "Conditions", !this.item)}
          ${this._tabButton("test", "Test", !this.item)}
          ${this._tabButton("publish", "Publish", !this.item)}
        </nav>
        <section class="sf-body">${this._panel()}</section>
      </div>`;
    return $(html);
  }

  _tabButton(id, label, disabled = false) {
    return `<button type="button" class="sf-tab ${this.tab === id ? "active" : ""}"
      data-tab="${id}" ${disabled ? "disabled" : ""}>${label}</button>`;
  }

  _panel() {
    switch (this.tab) {
      case "start":   return this._panelStart();
      case "wire":    return this._panelWire();
      case "gate":    return this._panelGate();
      case "test":    return this._panelTest();
      case "publish": return this._panelPublish();
      default:        return "";
    }
  }

  // ── START: pattern picker (stage 2) ───────────────────────────────────────
  _panelStart() {
    if (this.patternId) return this._panelPatternForm();
    const groups = patternsByCommand();
    const sections = [...groups.entries()].map(([command, list]) => `
      <h3 class="sf-group">${esc(command)}</h3>
      <div class="sf-cards">
        ${list.map((p) => `
          <button type="button" class="sf-card" data-pattern="${esc(p.id)}">
            <strong>${esc(p.label)}</strong>
            <span>${esc(p.blurb)}</span>
          </button>`).join("")}
      </div>`).join("");
    return `
      <p class="sf-lede">Pick the kind of thing you want to make. Each one fills in the
      wiring for you; you can rewire it afterwards.</p>
      ${sections}`;
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
      <button type="button" class="sf-primary" data-create="1" ${missing.length ? "disabled" : ""}>
        Create this skill as a draft</button>
      <p class="sf-note">It is created as a <strong>draft</strong>: not offered in play until you publish it.</p>`;
  }

  // ── WIRE: the graph (stage 1) ─────────────────────────────────────────────
  _panelWire() {
    if (!this.graph) this.refreshGraph();
    if (!this.graph) return `<p class="sf-lede">Open a skill first.</p>`;
    const depths = assignDepths(this.graph);
    const problems = graphProblems(this.graph);

    const cols = new Map();
    for (const n of this.graph.nodes) {
      const d = depths.get(n.id) ?? 0;
      if (!cols.has(d)) cols.set(d, []);
      cols.get(d).push(n);
    }
    const columns = [...cols.entries()].sort((a, b) => a[0] - b[0]).map(([d, list]) => `
      <div class="sf-col">
        <div class="sf-col-head">${d === 0 ? "runs first" : `step ${d + 1}`}</div>
        ${list.map((n) => this._nodeCard(n)).join("")}
      </div>`).join("");

    return `
      <p class="sf-lede">Each card is one step. Arrows are what it points at — you cannot
      point at a step that does not exist.</p>
      ${problems.length ? `<div class="sf-problems">${problems.map((p) =>
        `<div class="sf-problem"><strong>${esc(p.kind.replace(/_/g, " "))}</strong> ${esc(p.text)}</div>`).join("")}</div>` : ""}
      <div class="sf-graph">${columns || "<p>No steps yet.</p>"}</div>`;
  }

  _nodeCard(n) {
    const outs = this.graph.edges.filter((e) => e.from === n.id);
    const links = outs.map((e) => {
      const spec = REF_FIELDS[e.field];
      const label = spec?.label ?? e.field;
      return `<li class="${e.dangling ? "sf-dangling" : ""}">${esc(label)} →
        ${esc(e.toLabel)}${e.dangling ? " <em>(missing)</em>" : ""}</li>`;
    }).join("");
    const shown = Object.entries(n.extra)
      .filter(([k, v]) => !["effect_kind", "effect_label"].includes(k) && String(v ?? "").trim() !== "")
      .slice(0, 5)
      .map(([k, v]) => `<li><span>${esc(k)}</span> ${esc(String(v).slice(0, 40))}</li>`).join("");
    return `
      <div class="sf-node ${n.isTrigger ? "sf-trigger" : ""}" data-node="${esc(n.id)}">
        <div class="sf-node-kind">${esc(n.kind || "(no kind)")}</div>
        <div class="sf-node-label">${esc(n.label)}</div>
        ${shown ? `<ul class="sf-node-fields">${shown}</ul>` : ""}
        ${links ? `<ul class="sf-node-links">${links}</ul>` : ""}
      </div>`;
  }

  // ── GATE: condition builder (stage 3) ─────────────────────────────────────
  _panelGate() {
    const doc = this.docObject;
    if (!doc) return "";
    const rows = [];
    const props = doc.system?.props ?? {};
    for (const table of ["effect_table", "reaction_config_table"]) {
      const t = props[table];
      if (!t || typeof t !== "object") continue;
      for (const [key, row] of Object.entries(t)) {
        if (!row || row.$deleted === true) continue;
        const f = String(row.condition_formula ?? "").trim();
        if (!f) continue;
        const model = CB.parse(f);
        rows.push(`
          <div class="sf-gate">
            <div class="sf-gate-where">${esc(table)}[${esc(key)}] · ${esc(row.effect_label ?? row.reaction_trigger ?? "")}</div>
            <div class="sf-gate-plain">${model ? esc(CB.explain(model)) : `<em>kept as written:</em> ${esc(f)}`}</div>
            <code>${esc(f)}</code>
          </div>`);
      }
    }
    return `
      <p class="sf-lede">Conditions decide when a step applies. Where the builder can read one,
      it shows it in plain words; where it cannot, it leaves your text exactly as written
      rather than guessing.</p>
      ${rows.join("") || "<p>This skill has no conditions.</p>"}`;
  }

  // ── TEST (stage 4) ────────────────────────────────────────────────────────
  _panelTest() {
    const r = this.lastTest;
    return `
      <p class="sf-lede">Runs the skill against a practice target. Nothing is saved and no
      real creature is touched.</p>
      <button type="button" class="sf-primary" data-run="1">Run the test</button>
      ${r ? `<pre class="sf-result ${r.caveats?.some((c) => c.severity === "blocking") ? "sf-unproven" : ""}">${esc(r.prose ?? "")}</pre>` : ""}
      ${r && !r.ok ? `<p class="sf-warn">${esc(r.reason ?? "the run did not complete")}</p>` : ""}`;
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
      <pre class="sf-decision ${decision.ok ? "sf-ok" : "sf-blocked"}">${esc(explainDecision(decision, doc.name))}</pre>
      ${draft ? `<button type="button" class="sf-primary" data-publish="1" ${decision.ok ? "" : "disabled"}>Publish</button>`
        : `<button type="button" data-unpublish="1">Back to draft</button>`}`;
  }

  // ── events ────────────────────────────────────────────────────────────────
  activateListeners(html) {
    super.activateListeners(html);
    const root = html instanceof jQuery ? html[0] : html;

    root.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => {
      this.tab = b.dataset.tab; this.render(false);
    }));
    root.querySelectorAll("[data-pattern]").forEach((b) => b.addEventListener("click", () => {
      this.patternId = b.dataset.pattern; this.patternValues = {}; this.render(false);
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
    root.querySelector("[data-create]")?.addEventListener("click", () => this._createFromPattern());
    root.querySelector("[data-run]")?.addEventListener("click", () => this._runTest());
    root.querySelector("[data-publish]")?.addEventListener("click", () => this._publish());
    root.querySelector("[data-unpublish]")?.addEventListener("click", () => this._setDraft(true));
    root.querySelectorAll("[data-node]").forEach((el) => el.addEventListener("click", () => {
      this.selectedNode = el.dataset.node; this.render(false);
    }));
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
    try {
      const created = await Item.create(data);
      if (!created) return ui.notifications?.error("Could not create the skill.");
      this.item = created;
      this.tab = "wire";
      this.refreshGraph();
      ui.notifications?.info(`Created "${name}" as a draft.`);
      this.render(false);
    } catch (e) {
      console.error(`${TAG} create failed`, e);
      ui.notifications?.error(`Could not create the skill: ${e.message}`);
    }
  }

  async _runTest() {
    const fixtures = await globalThis.FUCompanion?.api?.test?.getDirectorTestFixtures?.();
    if (!fixtures) return ui.notifications?.warn("The test harness is not available.");
    this.lastTest = await runTest({
      skillUuid: this.item?.uuid,
      casterTokenUuid: fixtures.caster?.tokenUuid,
      targetTokenUuids: [fixtures.enemy?.tokenUuid].filter(Boolean),
      acceptReactions: true,
      doc: this.docObject,
      targetAffinities: fixtures.enemy?.affinities ?? null,
    });
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
    if (!this.item || !this.graph) return;
    const tables = fromGraphWithEdges(this.graph);
    await this.item.update({ "system.props.effect_table": null, "system.props.reaction_config_table": null });
    await this.item.update({
      "system.props.effect_table": tables.effect_table,
      "system.props.reaction_config_table": tables.reaction_config_table,
    });
    this.refreshGraph();
  }

  async _setDraft(on) {
    if (!this.item) return;
    await this.item.update(draftPatch(on));
    this.render(false);
  }

  async _publish() {
    const doc = this.docObject;
    const { findings } = validate(doc);
    const res = await publish({ doc, findings, write: (p) => this.item.update(p) });
    if (res.ok) ui.notifications?.info(`Published "${doc.name}".`);
    else ui.notifications?.warn("Not published — see the reasons listed.");
    this.render(false);
  }

  _styles() {
    return `<style>
      .fud-skill-forge .sf-root { font-family: var(--font-primary); padding: 4px 8px; }
      .fud-skill-forge .sf-tabs { display: flex; gap: 4px; border-bottom: 1px solid #0003; margin-bottom: 10px; }
      .fud-skill-forge .sf-tab { background: none; border: none; padding: 6px 12px; cursor: pointer;
        border-bottom: 2px solid transparent; }
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
      .fud-skill-forge .sf-primary { margin-top: 10px; padding: 6px 14px; font-weight: 600; }
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
      .fud-skill-forge .sf-problems { margin-bottom: 10px; }
      .fud-skill-forge .sf-problem { border-left: 3px solid #c33; padding: 4px 8px; margin-bottom: 4px;
        background: #c3333314; font-size: 12px; }
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
