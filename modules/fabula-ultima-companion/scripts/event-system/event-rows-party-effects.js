/**
 * [ONI] Event System — Deal Damage / Apply Status
 * Foundry VTT v12
 *
 * File:
 * scripts/event-system/event-rows-party-effects.js
 *
 * Two actions so an event can resolve its own consequences (built for the
 * Skill Check tile's preset events, usable in any event):
 *
 *   Deal Damage   amount + element to the chosen characters, through the same
 *                 damage pipeline as the Dirt tile's explosion (affinities,
 *                 resistances and damage mods all apply).
 *   Apply Status  one status, either
 *                   now        an ordinary status that counts down N dungeon
 *                              steps (the way a dungeon tile lands one), or
 *                   next battle carried into the actor's next battle, where it
 *                              counts down as usual (shared/held-status.js).
 *                 Immune characters are skipped.
 *
 * Who is picked with Run Check's target list (controller / party / slot /
 * table picks / by name). Runs on the GM like every action.
 *
 * Requires:
 * - event-logic.js, event-eventRegistry.js, event-rows-check.js
 * - scripts/apply-damage-core.js, scripts/shared/held-status.js (at run time)
 */
(() => {
  const INSTALL_TAG = "[ONI][EventSystem][RowsPartyEffects]";

  window.oni = window.oni || {};
  window.oni.EventSystem = window.oni.EventSystem || {};

  if (window.oni.EventSystem.RowsPartyEffects?.installed) return;

  const Logic = window.oni.EventSystem.Logic;
  const EventRegistry = window.oni.EventSystem.EventRegistry;
  const Check = window.oni.EventSystem.RowsCheck;
  if (!Logic || !EventRegistry || !Check?.resolveTargets) {
    console.error(INSTALL_TAG, "Missing Logic, EventRegistry or RowsCheck. Check load order.");
    return;
  }

  const ELEMENTS = [
    ["physical", "Physical"], ["fire", "Fire"], ["ice", "Ice"], ["bolt", "Bolt"], ["earth", "Earth"],
    ["air", "Air"], ["light", "Light"], ["dark", "Dark"], ["poison", "Poison"], ["elementless", "No element"]
  ];
  const TIMINGS = [
    ["now", "Now (counts down while exploring)"],
    ["held", "Carried into their next battle"]
  ];

  const readTargets = (rowEl, kit, fallback) => kit.ownAll(rowEl, ".oni-check-target").map((el) => ({
    kind: el.querySelector(".oni-check-target-kind")?.value ?? fallback,
    slot: Logic.toNumber(el.querySelector(".oni-check-target-slot")?.value, 1),
    name: String(el.querySelector(".oni-check-target-name")?.value ?? "").trim()
  }));

  // The shared "who" block: Run Check's target lines + an Add button.
  function targetsField(kit, row, cls, help) {
    const field = kit.field(
      "Who",
      `<div class="${cls} oni-event-row-body"></div>
       <div class="oni-event-list-actions"><button type="button" class="${cls}-add"><i class="fas fa-plus"></i> Add target</button></div>`,
      help
    );
    return field;
  }
  function wireTargets(body, kit, row, cls) {
    const host = body.querySelector(`.${cls}`);
    const addBtn = body.querySelector(`.${cls}-add`);
    const onChange = (el) => { addBtn.disabled = host.children.length >= Check.MAX_TARGETS; kit.notify(el ?? host); };
    for (const t of row.targets ?? []) host.appendChild(Check.buildTargetElement(t, kit, onChange));
    addBtn.disabled = host.children.length >= Check.MAX_TARGETS;
    addBtn.addEventListener("click", () => {
      if (host.children.length >= Check.MAX_TARGETS) return;
      host.appendChild(Check.buildTargetElement({ kind: "member", slot: 1, name: "" }, kit, onChange));
      onChange(host);
    });
  }
  function prepareTargets(row, fallbackKind) {
    row.targets = (Array.isArray(row.targets) ? row.targets : [])
      .filter(t => Check.isKind(t?.kind))
      .map(t => ({ kind: t.kind, slot: Logic.toNumber(t.slot, 1), name: String(t.name ?? "") }))
      .slice(0, Check.MAX_TARGETS);
    if (!row.targets.length) row.targets = [{ kind: fallbackKind, slot: 1, name: "" }];
  }

  // ------------------------------------------------------------
  // Deal Damage
  // ------------------------------------------------------------
  function prepareDamage(row) {
    prepareTargets(row, "party");
    row.amount = Math.max(0, Math.round(Logic.toNumber(row.amount, 10)));
    row.element = ELEMENTS.some(([k]) => k === row.element) ? row.element : "physical";
    row.source = String(row.source ?? "");
  }

  async function executeDamage(row, context) {
    const dmg = globalThis.FUCompanion?.api?.applyDamage?.applyToActor;
    if (!dmg) return { ok: false, reason: "noDamageApi" };
    if (!row.amount) return { ok: true, type: "dealDamage", skipped: true };
    const { actors, aborted } = await Check.resolveTargets(row, context);
    if (aborted) return { ok: true, type: "dealDamage", aborted: true };
    if (!actors.length) return { ok: false, reason: "noTargets" };
    const hit = [];
    for (const actor of actors) {
      try {
        await dmg({
          baseDamage: row.amount,
          elementType: row.element,
          valueType: "hp",
          isRecovery: false,
          targetActor: actor,
          attackerName: row.source || "Event",
          sourceType: "Tile",
          verbosity: "fx",
        });
        hit.push(actor.name);
      } catch (e) {
        console.warn(INSTALL_TAG, `Deal Damage failed on ${actor.name}`, e);
      }
    }
    return { ok: true, type: "dealDamage", hit };
  }

  EventRegistry.register({
    type: "dealDamage",
    label: "Deal Damage",
    category: "Party",
    defaultData: { type: "dealDamage", targets: [{ kind: "party", slot: 1, name: "" }], amount: 10, element: "physical", source: "" },
    prepare: prepareDamage,
    summary: (row) => `${row?.amount ?? 0} ${row?.element ?? ""} → ${Check.describeTargets(row ?? {})}`.slice(0, 60),
    execute: executeDamage,
    buildFields: (row, kit) => {
      const body = kit.fields(
        targetsField(kit, row, "oni-dmg-targets", "Worked out when the event runs. A character named twice is hit once."),
        kit.field("Damage", `<div class="oni-event-inline-row">
            ${kit.numberInput("oni-dmg-amount", row.amount, { min: 0, max: 999, step: 1 })}
            <select class="oni-dmg-element">${kit.options(ELEMENTS, row.element)}</select>
          </div>`, "Affinities, resistances and damage modifiers apply, as for a trap."),
        kit.field("Source", `<input type="text" class="oni-dmg-source oni-grow" value="${kit.escapeHTML(row.source)}" placeholder="Shown as the attacker, e.g. Rolling Boulder" />`)
      );
      wireTargets(body, kit, row, "oni-dmg-targets");
      return body;
    },
    collectFields: (rowEl, kit) => ({
      targets: readTargets(rowEl, kit, "party"),
      amount: Math.max(0, Math.round(kit.readNumber(rowEl, ".oni-dmg-amount", 10))),
      element: kit.readText(rowEl, ".oni-dmg-element", "physical"),
      source: kit.readText(rowEl, ".oni-dmg-source", "").trim()
    })
  });

  // ------------------------------------------------------------
  // Apply Status
  // ------------------------------------------------------------
  const held = () => globalThis.FUCompanion?.api?.heldStatus ?? null;

  function prepareStatus(row) {
    prepareTargets(row, "party");
    row.status = String(row.status ?? "");
    row.timing = TIMINGS.some(([k]) => k === row.timing) ? row.timing : "now";
    row.steps = Math.max(1, Math.round(Logic.toNumber(row.steps, 3)));
    row.turns = Math.max(0, Math.round(Logic.toNumber(row.turns, 0)));
    row.source = String(row.source ?? "");
  }

  async function executeStatus(row, context) {
    const api = held();
    if (!api) return { ok: false, reason: "noHeldStatusApi" };
    if (!row.status) return { ok: false, reason: "noStatus" };
    const { actors, aborted } = await Check.resolveTargets(row, context);
    if (aborted) return { ok: true, type: "applyStatus", aborted: true };
    if (!actors.length) return { ok: false, reason: "noTargets" };
    const res = row.timing === "held"
      ? await api.inflict({ actors, status: row.status, source: row.source, turns: row.turns || null })
      : await api.applyNow({ actors, status: row.status, steps: row.steps, source: row.source });
    if (res?.error) console.warn(INSTALL_TAG, `Apply Status: ${res.error}`, row.status);
    // Everyone immune is not a broken event: carry on.
    return { ok: res?.error ? false : true, type: "applyStatus", applied: (res?.applied ?? []).map(a => a.name), skipped: res?.skipped ?? [] };
  }

  EventRegistry.register({
    type: "applyStatus",
    label: "Apply Status",
    category: "Party",
    defaultData: { type: "applyStatus", targets: [{ kind: "party", slot: 1, name: "" }], status: "", timing: "now", steps: 3, turns: 0, source: "" },
    prepare: prepareStatus,
    summary: (row) => `${row?.status || "(no status)"}${row?.timing === "held" ? " · next battle" : ""} → ${Check.describeTargets(row ?? {})}`.slice(0, 60),
    execute: executeStatus,
    buildFields: (row, kit) => {
      const names = held()?.statusNames?.() ?? [];
      if (row.status && !names.includes(row.status)) names.unshift(row.status);
      const body = kit.fields(
        targetsField(kit, row, "oni-st-targets", "Worked out when the event runs. Characters immune to the status are skipped."),
        kit.field("Status", `<select class="oni-st-status">${kit.options([["", "(pick one)"], ...names.map(n => [n, n])], row.status)}</select>`),
        kit.field("Lasts", `<div class="oni-event-inline-row">
            <select class="oni-st-timing">${kit.options(TIMINGS, row.timing)}</select>
            <span class="oni-st-steps-wrap">${kit.numberInput("oni-st-steps", row.steps, { min: 1, max: 20, step: 1 })} steps</span>
            <span class="oni-st-turns-wrap">${kit.numberInput("oni-st-turns", row.turns, { min: 0, max: 10, step: 1 })} battle turns (0 = usual)</span>
          </div>`,
          "Next battle: it does not count down while exploring; it starts counting on their turns in their next battle and is gone when that battle ends. A Rest cures it either way."),
        kit.field("Source", `<input type="text" class="oni-st-source oni-grow" value="${kit.escapeHTML(row.source)}" placeholder="For the GM's list, e.g. Collapsing Bridge" />`)
      );
      wireTargets(body, kit, row, "oni-st-targets");
      const timingEl = body.querySelector(".oni-st-timing");
      const sync = () => {
        body.querySelector(".oni-st-steps-wrap").hidden = timingEl.value !== "now";
        body.querySelector(".oni-st-turns-wrap").hidden = timingEl.value !== "held";
      };
      timingEl.addEventListener("change", sync);
      sync();
      return body;
    },
    collectFields: (rowEl, kit) => ({
      targets: readTargets(rowEl, kit, "party"),
      status: kit.readText(rowEl, ".oni-st-status", ""),
      timing: kit.readText(rowEl, ".oni-st-timing", "now"),
      steps: Math.max(1, Math.round(kit.readNumber(rowEl, ".oni-st-steps", 3))),
      turns: Math.max(0, Math.round(kit.readNumber(rowEl, ".oni-st-turns", 0))),
      source: kit.readText(rowEl, ".oni-st-source", "").trim()
    })
  });

  window.oni.EventSystem.RowsPartyEffects = { installed: true, ELEMENTS, TIMINGS };
})();
