/**
 * [ONI] Event System — Run Check
 * Foundry VTT v12
 *
 * File:
 * scripts/event-system/event-rows-check.js
 *
 * What this does:
 * - Registers the "Run Check" event action: ask one or more characters for an
 *   attribute check, then run the events under Success or under Failure
 *   (and, if the author asks for it, under Critical or Fumble).
 *
 * Who rolls is a list of targets, worked out when the row runs so the same
 * event fits any party:
 *   controller   the character of whoever interacted with the event
 *   party        every member on the party database sheet
 *   member       the member in slot 1-4
 *   pick         the table picks one member from a menu
 *   name         a character by name
 *
 * With more than one roller the row says how their results count:
 *   all     everyone must succeed
 *   any     one success is enough
 *   group   a Fabula Ultima Group Check (a leader, the rest help)
 *
 * How it fits together:
 * - The rolling itself is the existing Check Requester (ONI.CheckRequester /
 *   ONI.GroupCheck): the same panels, invokes, chat card and opportunity
 *   picker as a check asked for from the sidebar. This file only chooses who
 *   rolls and reads the result.
 * - A check cannot be abandoned once its panels are open (the Check Requester
 *   has no cancel, and none was added). If the GM ends the event during a
 *   check, the panels stay until the rolls are in; the result is then dropped
 *   and nothing further runs.
 * - The event's safety timers are held while the check is open.
 *
 * Requires:
 * - event-logic.js, event-eventRegistry.js, event-client.js, event-flow.js
 * - event-rows-choices.js (the "pick one" menu), event-gameState.js
 * - scripts/check-requester/cr-api.js, cr-group-check.js
 * - scripts/db-resolver.js, scripts/map-system/movementControl-api.js
 */

(() => {
  const INSTALL_TAG = "[ONI][EventSystem][RowsCheck]";

  window.oni = window.oni || {};
  window.oni.EventSystem = window.oni.EventSystem || {};

  if (window.oni.EventSystem.RowsCheck?.installed) {
    console.debug(INSTALL_TAG, "Already installed; skipping.");
    return;
  }

  const Logic = window.oni.EventSystem.Logic;
  const EventRegistry = window.oni.EventSystem.EventRegistry;
  const Client = window.oni.EventSystem.Client;
  if (!Logic || !EventRegistry || !Client) {
    console.error(INSTALL_TAG, "Missing Logic, EventRegistry or Client. Check load order.");
    return;
  }

  const MODULE_ID = "fabula-ultima-companion";
  const PARTY_SLOTS = 4;
  const MAX_TARGETS = 6;

  const ATTRIBUTES = [["DEX", "Dexterity"], ["INS", "Insight"], ["MIG", "Might"], ["WLP", "Willpower"]];

  const TARGET_KINDS = [
    ["controller", "Main controller's character"],
    ["party", "Whole party"],
    ["member", "Party member in slot"],
    ["pick", "The table picks one"],
    ["name", "Character by name"]
  ];

  const COMBINE = [
    ["all", "Everyone must succeed"],
    ["any", "One success is enough"],
    ["group", "Group Check (a leader, the rest help)"]
  ];

  const flow = () => window.oni.EventSystem.Flow;
  const gameState = () => window.oni.EventSystem.GameState;

  const isAttribute = (value) => ATTRIBUTES.some(([key]) => key === value);
  const isKind = (value) => TARGET_KINDS.some(([key]) => key === value);

  // ------------------------------------------------------------
  // Who rolls
  // ------------------------------------------------------------
  async function actorFromId(raw) {
    const id = String(raw ?? "").trim();
    if (!id) return null;
    const uuid = id.includes(".") ? id : `Actor.${id}`;
    try { return (await fromUuid(uuid)) ?? null; } catch (_) { return null; }
  }

  // The party's members, in sheet order; a slot with nobody in it is null.
  async function partyMembers() {
    const db = (await globalThis.FUCompanion?.api?.getCurrentGameDb?.())?.db ?? null;
    const props = db?.system?.props ?? {};
    const slots = [];
    for (let i = 1; i <= PARTY_SLOTS; i += 1) slots.push(await actorFromId(props[`member_id_${i}`]));
    return slots;
  }

  // The character of whoever interacted with the event.
  //   A player pressed the prompt  -> the party member that player owns.
  //   Otherwise (the GM pressed)   -> the main controller's character, then
  //                                   the last known one, then the first member.
  async function controllerActor(requesterId, members) {
    const present = members.filter(Boolean);
    const isMember = (actor) => !!actor && present.some(m => m.uuid === actor.uuid);

    const requester = game.users?.get(requesterId);
    if (requester && !requester.isGM) {
      const own = present.find(m => m.testUserPermission?.(requester, "OWNER"));
      if (own) return own;
    }

    try {
      const controller = await globalThis.FUCompanion?.api?.MovementControl?.getCurrentControllerUser?.();
      const user = controller?.userId ? game.users?.get(controller.userId) : null;
      const own = user ? present.find(m => m.testUserPermission?.(user, "OWNER")) : null;
      if (own) return own;
    } catch (_) { /* fall through to the stored state */ }

    for (const actor of game.actors ?? []) {
      const stored = actor.flags?.[MODULE_ID]?.movementControlState?.controllerActorUuid;
      if (!stored) continue;
      const last = await actorFromId(stored);
      if (isMember(last)) return last;
    }

    return present[0] ?? null;
  }

  function actorByName(name) {
    const wanted = String(name ?? "").trim().toLowerCase();
    if (!wanted) return null;
    return game.actors?.find(a => String(a.name ?? "").trim().toLowerCase() === wanted) ?? null;
  }

  // The targets of a row -> the actors that roll, each once, in order.
  // Returns { actors, aborted }.
  async function resolveTargets(row, context) {
    const members = await partyMembers();
    const out = [];
    const add = (actor) => { if (actor && !out.some(a => a.uuid === actor.uuid)) out.push(actor); };

    for (const target of row.targets ?? []) {
      switch (target.kind) {
        case "controller":
          add(await controllerActor(context?.requesterId, members));
          break;
        case "party":
          members.forEach(add);
          break;
        case "member":
          add(members[Logic.toNumber(target.slot, 1) - 1] ?? null);
          break;
        case "name":
          add(actorByName(target.name));
          break;
        case "pick": {
          const choices = members.filter(Boolean).filter(m => !out.some(a => a.uuid === m.uuid));
          if (!choices.length) break;
          if (choices.length === 1) { add(choices[0]); break; }

          const ask = window.oni.EventSystem.RowsChoices?.ask;
          if (!ask) { add(choices[0]); break; }

          const answer = await ask(context?.tileId, {
            prompt: row.label ? `${row.label}: who attempts it?` : "Who attempts it?",
            options: choices.map(m => ({ id: m.uuid, label: m.name, cancel: false })),
            roleplay: false,
            roleplayLabel: ""
          });
          if (answer.kind === "abort") return { actors: out, aborted: true };
          if (answer.kind === "option") add(choices[answer.index]);
          break;
        }
        default:
          break;
      }
    }

    return { actors: out, aborted: false };
  }

  // ------------------------------------------------------------
  // Reading the result
  // ------------------------------------------------------------
  // results: one per roller, each { pass, isCrit, isFumble }.
  // A critical always succeeds and a fumble always fails, whatever the total.
  function passed(result) {
    if (result?.isFumble) return false;
    return result?.isCrit === true || result?.pass === true;
  }

  // -> { success, special: "crit" | "fumble" | null, successes }
  function readIndividual(results, combine) {
    const list = Array.isArray(results) ? results : [];
    const successes = list.filter(passed).length;
    const success = list.length > 0 && (combine === "any" ? successes > 0 : successes === list.length);

    let special = null;
    if (success && list.some(r => r?.isCrit && !r?.isFumble)) special = "crit";
    if (!success && list.some(r => r?.isFumble)) special = "fumble";

    return { success, special, successes };
  }

  function readGroup(raw) {
    const leader = raw?.leaderResult ?? null;
    const success = raw?.leaderPass === true;
    const helpers = (raw?.helperResults ?? []).filter(passed).length;

    let special = null;
    if (success && leader?.isCrit && !leader?.isFumble) special = "crit";
    if (!success && leader?.isFumble) special = "fumble";

    return { success, special, successes: helpers + (success ? 1 : 0) };
  }

  // Which list of events runs. Critical and Fumble only when the author
  // turned them on and put something under them.
  function branchFor(row, outcome) {
    if (row.useSpecial && outcome.special === "crit" && row.critRows?.length) return { key: "crit", rows: row.critRows };
    if (row.useSpecial && outcome.special === "fumble" && row.fumbleRows?.length) return { key: "fumble", rows: row.fumbleRows };
    return outcome.success ? { key: "success", rows: row.successRows } : { key: "failure", rows: row.failureRows };
  }

  // ------------------------------------------------------------
  // The action
  // ------------------------------------------------------------
  function prepare(row) {
    row.label = String(row.label ?? "");
    row.attrA = isAttribute(row.attrA) ? row.attrA : "DEX";
    row.attrB = isAttribute(row.attrB) ? row.attrB : "MIG";
    row.dl = Math.max(0, Math.round(Logic.toNumber(row.dl, 10)));
    row.hiddenDl = row.hiddenDl !== false;
    row.combine = COMBINE.some(([key]) => key === row.combine) ? row.combine : "all";
    row.useSpecial = row.useSpecial === true;
    row.storeVar = String(row.storeVar ?? "").trim();

    const targets = (Array.isArray(row.targets) ? row.targets : [])
      .filter(t => isKind(t?.kind))
      .slice(0, MAX_TARGETS)
      .map(t => ({
        kind: t.kind,
        slot: Math.min(PARTY_SLOTS, Math.max(1, Math.round(Logic.toNumber(t.slot, 1)))),
        name: String(t.name ?? "").trim()
      }));
    row.targets = targets.length ? targets : [{ kind: "controller", slot: 1, name: "" }];

    for (const key of ["successRows", "failureRows", "critRows", "fumbleRows"]) {
      if (!Array.isArray(row[key])) row[key] = [];
    }
  }

  function describeTargets(row) {
    return (row.targets ?? []).map((t) => {
      if (t.kind === "member") return `slot ${t.slot}`;
      if (t.kind === "name") return t.name || "(no name)";
      return TARGET_KINDS.find(([key]) => key === t.kind)?.[1] ?? t.kind;
    }).join(", ");
  }

  async function execute(row, context) {
    const sourceId = String(context?.tileId || "");
    const f = flow();

    const requester = globalThis.ONI?.CheckRequester;
    if (!requester?.request) return { ok: false, reason: "noCheckRequester" };

    const { actors, aborted } = await resolveTargets(row, context);
    if (aborted) return { ok: true, type: "runCheck", aborted: true };
    if (!actors.length) {
      console.warn(INSTALL_TAG, "Run Check: no character to roll. Check the targets and the party sheet.", row.targets);
      return { ok: false, reason: "noRollers" };
    }

    const shared = {
      attrA: row.attrA,
      attrB: row.attrB,
      label: row.label || "Check",
      allowInvokes: true,
      postChat: true,
      hiddenDl: row.hiddenDl
    };

    f?.hold?.(sourceId);
    Client.setMarker(sourceId, "check", "rolling a check");

    let outcome;
    try {
      const group = row.combine === "group" && actors.length > 1 && globalThis.ONI?.GroupCheck?.request;

      if (group) {
        const raw = await globalThis.ONI.GroupCheck.request({
          ...shared,
          leaderUuid: null,
          participantMode: "open",
          helperActorUuids: [],
          allActorUuids: actors.map(a => a.uuid),
          helperDl: row.dl,
          leaderDl: row.dl,
          helperBonus: 1
        });
        // No leader result: the lobby was closed without a roll.
        if (!raw?.leaderResult) return { ok: true, type: "runCheck", ran: false };
        outcome = readGroup(raw);
      } else {
        const results = await requester.request(actors, { ...shared, dl: row.dl, mode: "interactive" });
        if (!results?.length) return { ok: true, type: "runCheck", ran: false };
        outcome = readIndividual(results, row.combine === "any" ? "any" : "all");
      }
    } finally {
      f?.release?.(sourceId);
      Client.setMarker(sourceId, "check", null);
    }

    if (row.storeVar) await gameState()?.setVariable?.(row.storeVar, "set", outcome.successes);

    const branch = branchFor(row, outcome);
    const result = await context.runRows(branch.rows ?? []);
    return { ...result, type: "runCheck", outcome: branch.key, successes: outcome.successes };
  }

  // One target in the config window: what kind, and its slot or name.
  function buildTargetElement(target, kit, onChange) {
    const el = document.createElement("div");
    el.className = "oni-check-target oni-event-inline-row";
    el.innerHTML = `
      <select class="oni-check-target-kind">${kit.options(TARGET_KINDS, target.kind)}</select>
      <select class="oni-check-target-slot">${kit.options([1, 2, 3, 4].map(n => [String(n), `Slot ${n}`]), String(target.slot ?? 1))}</select>
      <input type="text" class="oni-check-target-name oni-grow" value="${kit.escapeHTML(target.name ?? "")}" placeholder="Character name" />
      <button type="button" class="oni-check-target-remove" title="Remove this target"><i class="fas fa-trash"></i></button>
    `;

    const kindEl = el.querySelector(".oni-check-target-kind");
    const sync = () => {
      el.querySelector(".oni-check-target-slot").hidden = kindEl.value !== "member";
      el.querySelector(".oni-check-target-name").hidden = kindEl.value !== "name";
    };
    kindEl.addEventListener("change", sync);
    sync();

    el.querySelector(".oni-check-target-remove").addEventListener("click", () => {
      const host = el.parentElement;
      if (host && host.children.length <= 1) return;
      el.remove();
      onChange(host);
    });

    return el;
  }

  EventRegistry.register({
    type: "runCheck",
    label: "Run Check",
    category: "Dialogue",
    defaultData: {
      type: "runCheck",
      label: "",
      attrA: "DEX",
      attrB: "MIG",
      dl: 10,
      hiddenDl: true,
      targets: [{ kind: "controller", slot: 1, name: "" }],
      combine: "all",
      useSpecial: false,
      storeVar: "",
      successRows: [],
      failureRows: [],
      critRows: [],
      fumbleRows: []
    },
    prepare,
    childLists: (row) => [
      { label: "Success", rows: row.successRows },
      { label: "Failure", rows: row.failureRows },
      { label: "Critical", rows: row.critRows },
      { label: "Fumble", rows: row.fumbleRows }
    ],
    summary: (row) => `${row?.attrA ?? ""} + ${row?.attrB ?? ""} vs ${row?.dl ?? ""} — ${describeTargets(row ?? {})}`.slice(0, 60),
    execute,
    buildFields: (row, kit) => {
      const body = kit.fields(
        kit.field(
          "Label",
          `<input type="text" class="oni-check-label" value="${kit.escapeHTML(row.label ?? "")}" placeholder="Shown on the roll panels and the chat card" />`
        ),
        kit.field(
          "Check",
          `<div class="oni-event-inline-row">
             <select class="oni-check-attr-a">${kit.options(ATTRIBUTES, row.attrA)}</select>
             <span>+</span>
             <select class="oni-check-attr-b">${kit.options(ATTRIBUTES, row.attrB)}</select>
             <span>against</span>
             ${kit.numberInput("oni-check-dl", row.dl, { min: 0, max: 40, step: 1 })}
             <label><input type="checkbox" class="oni-check-hidden-dl" ${row.hiddenDl !== false ? "checked" : ""} /> hide the difficulty</label>
           </div>`
        ),
        kit.field(
          "Who rolls",
          `<div class="oni-check-targets oni-event-row-body"></div>
           <div class="oni-event-list-actions">
             <button type="button" class="oni-check-target-add"><i class="fas fa-plus"></i> Add target</button>
           </div>`,
          `Worked out when the event runs. <b>Main controller's character</b> is the character of whoever
           interacted with the event. A character named twice rolls once.`
        ),
        kit.field(
          "If several roll",
          `<select class="oni-check-combine">${kit.options(COMBINE, row.combine)}</select>`,
          "Only matters when more than one character rolls."
        ),
        kit.field(
          "Critical / fumble",
          `<label><input type="checkbox" class="oni-check-special" ${row.useSpecial ? "checked" : ""} /> also branch on a critical success and a fumble</label>`,
          `Off: a critical runs Success and a fumble runs Failure. On: two more lists appear;
           one left empty still falls back to Success or Failure.`
        ),
        kit.field(
          "Store successes",
          kit.nameInput("oni-check-store", row.storeVar, "variable"),
          "Optional. Writes how many characters succeeded into this variable."
        )
      );

      // Who rolls.
      const host = body.querySelector(".oni-check-targets");
      const addBtn = body.querySelector(".oni-check-target-add");
      const onChange = (el) => {
        addBtn.disabled = host.children.length >= MAX_TARGETS;
        kit.notify(el ?? host);
      };
      for (const target of row.targets ?? []) host.appendChild(buildTargetElement(target, kit, onChange));
      addBtn.disabled = host.children.length >= MAX_TARGETS;
      addBtn.addEventListener("click", () => {
        if (host.children.length >= MAX_TARGETS) return;
        host.appendChild(buildTargetElement({ kind: "member", slot: 1, name: "" }, kit, onChange));
        onChange(host);
      });

      // What happens.
      body.appendChild(kit.subList("success", "Success", row.successRows));
      body.appendChild(kit.subList("failure", "Failure", row.failureRows));
      const crit = kit.subList("crit", "Critical success", row.critRows);
      const fumble = kit.subList("fumble", "Fumble", row.fumbleRows);
      body.append(crit, fumble);

      const specialEl = body.querySelector(".oni-check-special");
      const sync = () => {
        crit.hidden = !specialEl.checked;
        fumble.hidden = !specialEl.checked;
      };
      specialEl.addEventListener("change", sync);
      sync();

      return body;
    },
    collectFields: (rowEl, kit) => ({
      label: kit.readText(rowEl, ".oni-check-label", "").trim(),
      attrA: kit.readText(rowEl, ".oni-check-attr-a", "DEX"),
      attrB: kit.readText(rowEl, ".oni-check-attr-b", "MIG"),
      dl: Math.max(0, Math.round(kit.readNumber(rowEl, ".oni-check-dl", 10))),
      hiddenDl: !!kit.own(rowEl, ".oni-check-hidden-dl")?.checked,
      targets: kit.ownAll(rowEl, ".oni-check-target").map((el) => ({
        kind: el.querySelector(".oni-check-target-kind")?.value ?? "controller",
        slot: Logic.toNumber(el.querySelector(".oni-check-target-slot")?.value, 1),
        name: String(el.querySelector(".oni-check-target-name")?.value ?? "").trim()
      })),
      combine: kit.readText(rowEl, ".oni-check-combine", "all"),
      useSpecial: !!kit.own(rowEl, ".oni-check-special")?.checked,
      storeVar: kit.readText(rowEl, ".oni-check-store", "").trim(),
      successRows: kit.readSubList(rowEl, "success"),
      failureRows: kit.readSubList(rowEl, "failure"),
      // Kept even while hidden, so turning the checkbox off and on loses nothing.
      critRows: kit.readSubList(rowEl, "crit"),
      fumbleRows: kit.readSubList(rowEl, "fumble")
    })
  });

  window.oni.EventSystem.RowsCheck = {
    installed: true,
    // For tests and the console.
    readIndividual,
    readGroup,
    branchFor,
    resolveTargets
  };

  console.debug(INSTALL_TAG, "Installed.");
})();
