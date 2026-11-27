/**
 * [ONI] Event System — Run Contest
 * Foundry VTT v12
 *
 * File:
 * scripts/event-system/event-rows-contest.js
 *
 * What this does:
 * - Registers the "Run Contest" event action: two characters roll against each
 *   other on the Contest Check HUD (ONI.Contest; core p.48 Opposed Checks), then
 *   the events under "Side A wins" or under "Side B wins" run.
 *
 * Each side is one character, worked out when the row runs:
 *   controller · member (slot) · pick · name   — as in Run Check
 *   stage   the first NPC whose Theatre portrait is up right now (the one the
 *           party is talking to in a roleplay scene, token or no token)
 * Each side has its own two Attributes (RAW: the same Check for both — the
 * defaults match).
 *
 * After the contest, "Passed the last check" = the winner and "Failed the last
 * check" = the loser, so a later Deal Damage / Apply Status can act on them.
 * "Store margin" writes the winner's lead (Side A's total minus Side B's).
 *
 * Requires: event-rows-check.js (RowsCheck), scripts/check-requester/cr-contest.js
 */

(() => {
  const INSTALL_TAG = "[ONI][EventSystem][RowsContest]";

  window.oni = window.oni || {};
  window.oni.EventSystem = window.oni.EventSystem || {};
  if (window.oni.EventSystem.RowsContest?.installed) return;

  const Logic = window.oni.EventSystem.Logic;
  const EventRegistry = window.oni.EventSystem.EventRegistry;
  const Client = window.oni.EventSystem.Client;
  const RowsCheck = window.oni.EventSystem.RowsCheck;
  if (!Logic || !EventRegistry || !Client || !RowsCheck) {
    console.error(INSTALL_TAG, "Missing Logic, EventRegistry, Client or RowsCheck. Check load order.");
    return;
  }

  const ATTRIBUTES = [["DEX", "Dexterity"], ["INS", "Insight"], ["MIG", "Might"], ["WLP", "Willpower"]];
  const SIDE_KINDS = [
    ["controller", "Main controller's character"],
    ["member", "Party member in slot"],
    ["pick", "The table picks one"],
    ["name", "Character by name"],
    ["stage", "NPC on stage (Theatre portrait)"]
  ];
  const isKind = (v) => SIDE_KINDS.some(([k]) => k === v);
  const isAttr = (v) => ATTRIBUTES.some(([k]) => k === v);
  const flow = () => window.oni.EventSystem.Flow;
  const gameState = () => window.oni.EventSystem.GameState;

  function onStageNpc() {
    const t = globalThis.Theatre?.instance;
    const actors = (t?.portraitDocks ?? [])
      .filter((i) => i?.dockContainer && !i.deleting && String(i.imgId ?? "").startsWith("theatre-"))
      .map((i) => game.actors?.get(String(i.imgId).replace(/^theatre-/, ""))).filter(Boolean);
    return actors.find((a) => !a.hasPlayerOwner) ?? null;
  }

  async function resolveSide(side, context) {
    if (side?.kind === "stage") return { actor: onStageNpc(), aborted: false };
    const r = await RowsCheck.resolveTargets({ targets: [{ kind: side?.kind ?? "controller", slot: side?.slot ?? 1, name: side?.name ?? "" }] }, context);
    return { actor: r?.actors?.[0] ?? null, aborted: !!r?.aborted };
  }

  function normSide(s, fallback) {
    const o = { ...(fallback ?? {}), ...(s ?? {}) };
    if (!isKind(o.kind)) o.kind = fallback?.kind ?? "controller";
    o.slot = Math.min(4, Math.max(1, Logic.toNumber(o.slot, 1)));
    o.name = String(o.name ?? "");
    if (!isAttr(o.attrA)) o.attrA = "DEX";
    if (!isAttr(o.attrB)) o.attrB = "MIG";
    return o;
  }
  function prepare(row) {
    row.sideA = normSide(row.sideA, { kind: "controller" });
    row.sideB = normSide(row.sideB, { kind: "stage" });
    row.aRows = Array.isArray(row.aRows) ? row.aRows : [];
    row.bRows = Array.isArray(row.bRows) ? row.bRows : [];
    return row;
  }
  const describeSide = (s) => (s.kind === "member" ? `Slot ${s.slot}` : s.kind === "name" ? (s.name || "?") : SIDE_KINDS.find(([k]) => k === s.kind)?.[1] ?? s.kind);

  async function execute(row, context) {
    prepare(row);
    const sourceId = String(context?.tileId || "");
    const CT = globalThis.ONI?.Contest;
    if (!CT?.request) return { ok: false, reason: "noContest" };

    const A = await resolveSide(row.sideA, context);
    if (A.aborted) return { ok: true, type: "runContest", aborted: true };
    const B = await resolveSide(row.sideB, context);
    if (B.aborted) return { ok: true, type: "runContest", aborted: true };
    if (!A.actor || !B.actor) {
      console.warn(INSTALL_TAG, "Run Contest: a side has nobody in it.", { sideA: row.sideA, sideB: row.sideB, a: A.actor?.name, b: B.actor?.name });
      return { ok: false, reason: "noSide" };
    }
    if (A.actor.uuid === B.actor.uuid) {
      console.warn(INSTALL_TAG, "Run Contest: both sides are the same character.", A.actor.name);
      return { ok: false, reason: "sameSide" };
    }

    const f = flow();
    f?.hold?.(sourceId);
    Client.setMarker(sourceId, "check", "running a contest");
    let r = null;
    try {
      r = await CT.request({
        sides: [
          { actorUuid: A.actor.uuid, attrA: row.sideA.attrA, attrB: row.sideA.attrB },
          { actorUuid: B.actor.uuid, attrA: row.sideB.attrA, attrB: row.sideB.attrB },
        ],
        attrA: row.sideA.attrA, attrB: row.sideA.attrB,
        label: row.label || "Contest", stakes: row.stakes || "",
        autoRoll: row.npcAutoRoll ? "npc" : "none",
        context: { source: "event", tileId: sourceId },
      });
    } catch (e) {
      console.error(INSTALL_TAG, "Run Contest failed:", e);
    } finally {
      f?.release?.(sourceId);
      Client.setMarker(sourceId, "check", null);
    }
    if (!r?.winner) return { ok: true, type: "runContest", ran: false };

    const aWon = r.winner.index === 0;
    RowsCheck.rememberCheck(context, {
      passed: [aWon ? A.actor.uuid : B.actor.uuid],
      failed: [aWon ? B.actor.uuid : A.actor.uuid]
    });
    if (row.storeVar) {
      const m = (r.sides?.[0]?.total ?? 0) - (r.sides?.[1]?.total ?? 0);
      await gameState()?.setVariable?.(row.storeVar, "set", m);
    }
    const result = await context.runRows(aWon ? row.aRows : row.bRows);
    return { ...result, type: "runContest", outcome: aWon ? "a" : "b", margin: r.margin };
  }

  function sideFields(key, side, kit) {
    return `<div class="oni-event-inline-row oni-contest-side" data-side="${key}">
      <select class="oni-contest-kind">${kit.options(SIDE_KINDS, side.kind)}</select>
      <select class="oni-contest-slot">${kit.options([1, 2, 3, 4].map((n) => [String(n), `Slot ${n}`]), String(side.slot ?? 1))}</select>
      <input type="text" class="oni-contest-name oni-grow" value="${kit.escapeHTML(side.name ?? "")}" placeholder="Character name (exact)" />
      <select class="oni-contest-a">${kit.options(ATTRIBUTES, side.attrA)}</select><span>+</span>
      <select class="oni-contest-b">${kit.options(ATTRIBUTES, side.attrB)}</select>
    </div>`;
  }
  const readSide = (rowEl, key) => {
    const el = rowEl.querySelector(`.oni-contest-side[data-side="${key}"]`);
    return {
      kind: el?.querySelector(".oni-contest-kind")?.value ?? "controller",
      slot: Logic.toNumber(el?.querySelector(".oni-contest-slot")?.value, 1),
      name: String(el?.querySelector(".oni-contest-name")?.value ?? "").trim(),
      attrA: el?.querySelector(".oni-contest-a")?.value ?? "DEX",
      attrB: el?.querySelector(".oni-contest-b")?.value ?? "MIG",
    };
  };

  EventRegistry.register({
    type: "runContest",
    label: "Run Contest",
    category: "Dialogue",
    defaultData: {
      type: "runContest", label: "", stakes: "",
      sideA: { kind: "controller", slot: 1, name: "", attrA: "DEX", attrB: "MIG" },
      sideB: { kind: "stage", slot: 1, name: "", attrA: "DEX", attrB: "MIG" },
      npcAutoRoll: false, storeVar: "", aRows: [], bRows: []
    },
    prepare,
    childLists: (row) => [{ label: "Side A wins", rows: row.aRows }, { label: "Side B wins", rows: row.bRows }],
    summary: (row) => { prepare(row); return `${describeSide(row.sideA)} vs ${describeSide(row.sideB)}${row.label ? ` — ${row.label}` : ""}`.slice(0, 60); },
    execute,
    buildFields: (row, kit) => {
      prepare(row);
      const body = kit.fields(
        kit.field("Label", `<input type="text" class="oni-contest-label" value="${kit.escapeHTML(row.label ?? "")}" placeholder="Arm Wrestle — shown on the HUD and the chat card" />`),
        kit.field("Stakes", `<input type="text" class="oni-contest-stakes" value="${kit.escapeHTML(row.stakes ?? "")}" placeholder="Optional · e.g. loser pays for the next round" />`),
        kit.field("Side A", sideFields("a", row.sideA, kit)),
        kit.field("Side B", sideFields("b", row.sideB, kit),
          `<b>NPC on stage</b> = the first NPC whose Theatre portrait is up when the row runs. Both sides roll the same Check by default (RAW); change the dice per side if the fiction calls for it.`),
        kit.field("NPC dice", `<label><input type="checkbox" class="oni-contest-auto" ${row.npcAutoRoll ? "checked" : ""} /> NPC sides roll by themselves</label>`,
          "Off: the GM clicks the NPC's dice on the HUD."),
        kit.field("Store margin", kit.nameInput("oni-contest-store", row.storeVar, "variable"),
          "Optional. Side A's total minus Side B's (negative when B won).")
      );
      for (const key of ["a", "b"]) {
        const el = body.querySelector(`.oni-contest-side[data-side="${key}"]`);
        const kindEl = el.querySelector(".oni-contest-kind");
        const sync = () => {
          el.querySelector(".oni-contest-slot").hidden = kindEl.value !== "member";
          el.querySelector(".oni-contest-name").hidden = kindEl.value !== "name";
        };
        kindEl.addEventListener("change", sync); sync();
      }
      body.appendChild(kit.subList("contestA", "Side A wins", row.aRows));
      body.appendChild(kit.subList("contestB", "Side B wins", row.bRows));
      return body;
    },
    collectFields: (rowEl, kit) => ({
      label: kit.readText(rowEl, ".oni-contest-label", "").trim(),
      stakes: kit.readText(rowEl, ".oni-contest-stakes", "").trim(),
      sideA: readSide(rowEl, "a"),
      sideB: readSide(rowEl, "b"),
      npcAutoRoll: !!kit.own(rowEl, ".oni-contest-auto")?.checked,
      storeVar: kit.readText(rowEl, ".oni-contest-store", "").trim(),
      aRows: kit.readSubList(rowEl, "contestA"),
      bRows: kit.readSubList(rowEl, "contestB")
    })
  });

  window.oni.EventSystem.RowsContest = { installed: true, prepare, resolveSide, onStageNpc, SIDE_KINDS };
  console.debug(INSTALL_TAG, "Installed.");
})();
