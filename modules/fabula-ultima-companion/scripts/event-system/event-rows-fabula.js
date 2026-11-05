/**
 * [ONI] Event System — Fabula Point commands
 * Foundry VTT v12
 *
 * File:
 * scripts/event-system/event-rows-fabula.js
 *
 * Three RPG Maker-style commands, one job each (user's call, 2026-11-05):
 *
 *   Change Fabula Points    target(s), increase / decrease, a number or a
 *                           variable. A plain award or spend, like Change Gold.
 *                           The 10 cap applies to gains; the tab shows.
 *   Villain Entrance        "these villains just appeared": +1 each to the
 *                           party through the Fabula Ledger, so the same
 *                           once-per-visit rule as detection applies and a
 *                           portrait or token of theirs later in the same
 *                           visit pays nothing. No GM prompt: the author decided.
 *   Change Villain Status   villain / neutral / never / unset. "Reveal" also
 *                           pays at once, as the villain's entrance.
 *
 * The Fabula Ledger (scripts/fabula-ledger/) does the work; these rows only
 * collect who and how much. Targets reuse Run Check's picker.
 *
 * Requires:
 * - event-logic.js, event-eventRegistry.js, event-rows-check.js, event-gameState.js
 * - scripts/fabula-ledger/fl-ledger.js (at run time)
 */
(() => {
  const INSTALL_TAG = "[ONI][EventSystem][RowsFabula]";

  window.oni = window.oni || {};
  window.oni.EventSystem = window.oni.EventSystem || {};

  if (window.oni.EventSystem.RowsFabula?.installed) {
    console.debug(INSTALL_TAG, "Already installed; skipping.");
    return;
  }

  const Logic = window.oni.EventSystem.Logic;
  const EventRegistry = window.oni.EventSystem.EventRegistry;
  const Check = window.oni.EventSystem.RowsCheck;
  if (!Logic || !EventRegistry || !Check?.resolveTargets) {
    console.error(INSTALL_TAG, "Missing Logic, EventRegistry or RowsCheck. Check load order.");
    return;
  }

  const MAX_VILLAINS = 6;
  const ACTOR_LIST_ID = "oni-fabula-actor-names";
  const ledger = () => globalThis.FabulaLedger?.api ?? null;
  const gameState = () => window.oni.EventSystem.GameState;

  const OPS = [["increase", "Increase"], ["decrease", "Decrease"]];
  const OPERANDS = [["constant", "Number"], ["variable", "Variable"]];
  const STATUSES = [["villain", "Villain (pays when they appear)"], ["neutral", "Neutral (not hostile now; pays nothing for appearing)"], ["never", "Never (not part of the story)"], ["auto", "Unset (Champions ask the GM)"]];

  // ------------------------------------------------------------
  // Actor picking: a name box with a list of every non-player actor.
  // ------------------------------------------------------------
  function isNpc(actor) {
    const p = actor?.system?.props ?? {};
    return !!(String(p.npc_rank ?? "").trim() || String(p.species ?? "").trim());
  }

  function ensureActorList() {
    let list = document.getElementById(ACTOR_LIST_ID);
    if (!list) {
      list = document.createElement("datalist");
      list.id = ACTOR_LIST_ID;
      document.body.appendChild(list);
    }
    const names = [...new Set((game.actors ?? []).filter(isNpc).map(a => a.name))].sort((a, b) => a.localeCompare(b));
    list.innerHTML = names.map(n => `<option value="${String(n).replace(/"/g, "&quot;")}"></option>`).join("");
  }

  // { id, name } -> the actor; the id wins, the name is the fallback (a copied
  // event in another world).
  function actorOf(ref) {
    return game.actors?.get(ref?.id ?? "") ?? game.actors?.getName?.(ref?.name ?? "") ?? null;
  }

  function refFromName(name, previous = []) {
    const n = String(name ?? "").trim();
    if (!n) return null;
    const kept = previous.find(p => p.name === n && game.actors?.get(p.id));
    if (kept) return { id: kept.id, name: n };
    const actor = game.actors?.getName?.(n) ?? null;
    return { id: actor?.id ?? "", name: n };
  }

  function actorInput(cls, ref, kit) {
    return `<input type="text" class="${cls} oni-grow" list="${ACTOR_LIST_ID}" value="${kit.escapeHTML(ref?.name ?? "")}" placeholder="Actor name" />`;
  }

  const unknownNames = (refs) => (refs ?? []).filter(r => r?.name && !actorOf(r)).map(r => r.name);

  // ------------------------------------------------------------
  // Change Fabula Points
  // ------------------------------------------------------------
  function prepareChange(row) {
    row.op = OPS.some(([k]) => k === row.op) ? row.op : "increase";
    row.operand = OPERANDS.some(([k]) => k === row.operand) ? row.operand : "constant";
    row.amount = Math.max(0, Math.round(Logic.toNumber(row.amount, 1)));
    row.variable = String(row.variable ?? "").trim();
    const targets = (Array.isArray(row.targets) ? row.targets : [])
      .filter(t => Check.isKind(t?.kind))
      .slice(0, Check.MAX_TARGETS)
      .map(t => ({ kind: t.kind, slot: Math.min(4, Math.max(1, Math.round(Logic.toNumber(t.slot, 1)))), name: String(t.name ?? "").trim() }));
    row.targets = targets.length ? targets : [{ kind: "party", slot: 1, name: "" }];
  }

  async function executeChange(row, context) {
    const api = ledger();
    if (!api) return { ok: false, reason: "noFabulaLedger" };
    const amount = row.operand === "variable"
      ? Math.round(Logic.toNumber(gameState()?.getVariable?.(row.variable), 0))
      : row.amount;
    const delta = row.op === "decrease" ? -amount : amount;
    if (!delta) return { ok: true, type: "changeFabulaPoints", skipped: true };

    const { actors, aborted } = await Check.resolveTargets(row, context);
    if (aborted) return { ok: true, type: "changeFabulaPoints", aborted: true };
    if (!actors.length) {
      console.warn(INSTALL_TAG, "Change Fabula Points: nobody to change. Check the targets and the party sheet.", row.targets);
      return { ok: false, reason: "noTargets" };
    }
    const res = await api.change(actors, delta, { reason: "event", label: "event" });
    return { ok: res?.ok !== false, type: "changeFabulaPoints", delta };
  }

  EventRegistry.register({
    type: "changeFabulaPoints",
    label: "Change Fabula Points",
    category: "Party",
    defaultData: { type: "changeFabulaPoints", targets: [{ kind: "party", slot: 1, name: "" }], op: "increase", operand: "constant", amount: 1, variable: "" },
    prepare: prepareChange,
    summary: (row) => {
      const how = row?.operand === "variable" ? `variable ${row?.variable || "(none)"}` : String(row?.amount ?? 0);
      return `${row?.op === "decrease" ? "−" : "+"}${how} → ${Check.describeTargets(row ?? {})}`.slice(0, 60);
    },
    execute: executeChange,
    buildFields: (row, kit) => {
      const body = kit.fields(
        kit.field(
          "Who",
          `<div class="oni-fabula-targets oni-event-row-body"></div>
           <div class="oni-event-list-actions"><button type="button" class="oni-fabula-target-add"><i class="fas fa-plus"></i> Add target</button></div>`,
          "Worked out when the event runs. A character named twice changes once."
        ),
        kit.field(
          "Operation",
          `<select class="oni-fabula-op">${kit.options(OPS, row.op)}</select>`
        ),
        kit.field(
          "Operand",
          `<div class="oni-event-inline-row">
             <select class="oni-fabula-operand">${kit.options(OPERANDS, row.operand)}</select>
             <span class="oni-fabula-amount-wrap">${kit.numberInput("oni-fabula-amount", row.amount, { min: 0, max: 99, step: 1 })}</span>
             <span class="oni-fabula-var-wrap">${kit.nameInput("oni-fabula-var", row.variable, "variable")}</span>
           </div>`,
          "Gains stop at 10 Fabula Points; a total already above 10 is left alone. Spends floor at 0."
        )
      );

      const host = body.querySelector(".oni-fabula-targets");
      const addBtn = body.querySelector(".oni-fabula-target-add");
      const onChange = (el) => { addBtn.disabled = host.children.length >= Check.MAX_TARGETS; kit.notify(el ?? host); };
      for (const t of row.targets ?? []) host.appendChild(Check.buildTargetElement(t, kit, onChange));
      addBtn.disabled = host.children.length >= Check.MAX_TARGETS;
      addBtn.addEventListener("click", () => {
        if (host.children.length >= Check.MAX_TARGETS) return;
        host.appendChild(Check.buildTargetElement({ kind: "member", slot: 1, name: "" }, kit, onChange));
        onChange(host);
      });

      const operandEl = body.querySelector(".oni-fabula-operand");
      const sync = () => {
        body.querySelector(".oni-fabula-amount-wrap").hidden = operandEl.value !== "constant";
        body.querySelector(".oni-fabula-var-wrap").hidden = operandEl.value !== "variable";
      };
      operandEl.addEventListener("change", sync);
      sync();
      return body;
    },
    collectFields: (rowEl, kit) => ({
      targets: kit.ownAll(rowEl, ".oni-check-target").map((el) => ({
        kind: el.querySelector(".oni-check-target-kind")?.value ?? "party",
        slot: Logic.toNumber(el.querySelector(".oni-check-target-slot")?.value, 1),
        name: String(el.querySelector(".oni-check-target-name")?.value ?? "").trim()
      })),
      op: kit.readText(rowEl, ".oni-fabula-op", "increase"),
      operand: kit.readText(rowEl, ".oni-fabula-operand", "constant"),
      amount: Math.max(0, Math.round(kit.readNumber(rowEl, ".oni-fabula-amount", 1))),
      variable: kit.readText(rowEl, ".oni-fabula-var", "").trim()
    })
  });

  // ------------------------------------------------------------
  // Villain Entrance
  // ------------------------------------------------------------
  function prepareEntrance(row) {
    row.villains = (Array.isArray(row.villains) ? row.villains : [])
      .map(v => ({ id: String(v?.id ?? ""), name: String(v?.name ?? "").trim() }))
      .filter(v => v.id || v.name)
      .slice(0, MAX_VILLAINS);
  }

  function villainLine(ref, kit, onChange) {
    const el = document.createElement("div");
    el.className = "oni-fabula-villain oni-event-inline-row";
    el.innerHTML = `${actorInput("oni-fabula-villain-name", ref, kit)}
      <button type="button" class="oni-fabula-villain-remove" title="Remove"><i class="fas fa-trash"></i></button>`;
    el.querySelector(".oni-fabula-villain-remove").addEventListener("click", () => {
      const host = el.parentElement;
      el.remove();
      onChange(host);
    });
    return el;
  }

  EventRegistry.register({
    type: "villainEntrance",
    label: "Villain Entrance",
    category: "Party",
    defaultData: { type: "villainEntrance", villains: [] },
    prepare: prepareEntrance,
    summary: (row) => {
      const names = (row?.villains ?? []).map(v => v.name).filter(Boolean);
      const missing = unknownNames(row?.villains);
      return (names.length ? `${names.join(", ")} (+1 each)` : "no villains named") + (missing.length ? ` — not found: ${missing.join(", ")}` : "");
    },
    execute: async (row) => {
      const api = ledger();
      if (!api) return { ok: false, reason: "noFabulaLedger" };
      const actors = (row.villains ?? []).map(actorOf).filter(Boolean);
      const missing = unknownNames(row.villains);
      if (missing.length) console.warn(INSTALL_TAG, "Villain Entrance: no actor named", missing);
      if (!actors.length) return { ok: true, type: "villainEntrance", skipped: true };
      await api.villainEntrance(actors);
      return { ok: true, type: "villainEntrance", count: actors.length };
    },
    buildFields: (row, kit) => {
      ensureActorList();
      const body = kit.fields(
        kit.field(
          "Villains",
          `<div class="oni-fabula-villains oni-event-row-body"></div>
           <div class="oni-event-list-actions"><button type="button" class="oni-fabula-villain-add"><i class="fas fa-plus"></i> Add villain</button></div>`,
          `Each pays the party +1, once per visit to this map. A Theatre portrait or token of theirs
           later in the same visit pays nothing more. Any rank counts: the event says they are villains,
           so an actor whose status is unset becomes a Villain (Neutral and Never are kept).`
        )
      );
      const host = body.querySelector(".oni-fabula-villains");
      const addBtn = body.querySelector(".oni-fabula-villain-add");
      const onChange = (el) => { addBtn.disabled = host.children.length >= MAX_VILLAINS; kit.notify(el ?? host); };
      const list = row.villains?.length ? row.villains : [{ id: "", name: "" }];
      for (const v of list) host.appendChild(villainLine(v, kit, onChange));
      addBtn.disabled = host.children.length >= MAX_VILLAINS;
      addBtn.addEventListener("click", () => {
        if (host.children.length >= MAX_VILLAINS) return;
        host.appendChild(villainLine({ id: "", name: "" }, kit, onChange));
        onChange(host);
      });
      body.dataset.prev = JSON.stringify(row.villains ?? []);
      return body;
    },
    collectFields: (rowEl, kit) => {
      let prev = [];
      try { prev = JSON.parse(kit.own(rowEl, "[data-prev]")?.dataset?.prev ?? "[]"); } catch { prev = []; }
      return {
        villains: kit.ownAll(rowEl, ".oni-fabula-villain-name")
          .map(el => refFromName(el.value, prev))
          .filter(Boolean)
      };
    }
  });

  // ------------------------------------------------------------
  // Change Villain Status
  // ------------------------------------------------------------
  EventRegistry.register({
    type: "changeVillainStatus",
    label: "Change Villain Status",
    category: "Party",
    defaultData: { type: "changeVillainStatus", actor: { id: "", name: "" }, status: "villain", reveal: false },
    prepare: (row) => {
      row.actor = { id: String(row.actor?.id ?? ""), name: String(row.actor?.name ?? "").trim() };
      row.status = STATUSES.some(([k]) => k === row.status) ? row.status : "villain";
      row.reveal = row.reveal === true && row.status === "villain";
    },
    summary: (row) => {
      const who = row?.actor?.name || "(nobody)";
      const label = STATUSES.find(([k]) => k === row?.status)?.[0] ?? row?.status;
      const missing = row?.actor?.name && !actorOf(row.actor) ? " — not found" : "";
      return `${who} → ${label}${row?.reveal ? ", reveal (+1)" : ""}${missing}`;
    },
    execute: async (row) => {
      const api = ledger();
      if (!api) return { ok: false, reason: "noFabulaLedger" };
      const actor = actorOf(row.actor);
      if (!actor) { console.warn(INSTALL_TAG, "Change Villain Status: no actor named", row.actor?.name); return { ok: false, reason: "noActor" }; }
      if (row.reveal && row.status === "villain") await api.reveal(actor);
      else await api.setStatus(actor, row.status);
      return { ok: true, type: "changeVillainStatus" };
    },
    buildFields: (row, kit) => {
      ensureActorList();
      const body = kit.fields(
        kit.field("Actor", actorInput("oni-fabula-status-actor", row.actor, kit)),
        kit.field("Status", `<select class="oni-fabula-status">${kit.options(STATUSES, row.status)}</select>`),
        kit.field(
          "Reveal",
          `<label><input type="checkbox" class="oni-fabula-reveal" ${row.reveal ? "checked" : ""} /> pay +1 now, as their entrance</label>`,
          "Only with Villain: the moment a neutral character turns on the party."
        )
      );
      const statusEl = body.querySelector(".oni-fabula-status");
      const revealEl = body.querySelector(".oni-fabula-reveal");
      const sync = () => { revealEl.disabled = statusEl.value !== "villain"; if (revealEl.disabled) revealEl.checked = false; };
      statusEl.addEventListener("change", sync);
      sync();
      body.dataset.prev = JSON.stringify(row.actor?.name ? [row.actor] : []);
      return body;
    },
    collectFields: (rowEl, kit) => {
      let prev = [];
      try { prev = JSON.parse(kit.own(rowEl, "[data-prev]")?.dataset?.prev ?? "[]"); } catch { prev = []; }
      const status = kit.readText(rowEl, ".oni-fabula-status", "villain");
      return {
        actor: refFromName(kit.readText(rowEl, ".oni-fabula-status-actor", ""), prev) ?? { id: "", name: "" },
        status,
        reveal: status === "villain" && !!kit.own(rowEl, ".oni-fabula-reveal")?.checked
      };
    }
  });

  window.oni.EventSystem.RowsFabula = { installed: true, actorOf, refFromName };
  console.debug(INSTALL_TAG, "Installed.");
})();
