/**
 * [ONI] Event System — Card Duel (Fabula Arcana)
 * Foundry VTT v12
 *
 * File:
 * scripts/event-system/event-rows-card-duel.js
 *
 * What this does:
 * - Registers the "Card Duel" event action: the Main Controller sits down to a
 *   Fabula Arcana duel against an NPC token (default: the token this event is
 *   on), with the team, AI and Best of set on the row. Everyone else can watch.
 *   The event waits, with no time limit, until the duel window is closed.
 * - The result goes into a variable for Condition rows:
 *     1 = the party won   2 = the NPC won   3 = draw (left after a drawn game)
 *     0 = cancelled (left mid-match or before it started, or the GM ended it)
 * - Works while the card game is still locked ("Fabula Arcana Unlocked" OFF):
 *   a story duel is how it gets unlocked. A character with no playable cards
 *   gets the starter gift when the duel opens (Run Code
 *   `FUCompanion.api.fabulaArcana.grantStarterToParty()` gives the whole party
 *   theirs at a moment of your choosing).
 *
 * Requires:
 * - event-logic.js, event-eventRegistry.js, event-flow.js, event-gameState.js
 * - scripts/fabula-arcana/fa-boot.js (FUCompanion.api.fabulaArcana, looked up when used)
 */

(() => {
  const INSTALL_TAG = "[ONI][EventSystem][RowsCardDuel]";

  window.oni = window.oni || {};
  window.oni.EventSystem = window.oni.EventSystem || {};

  if (window.oni.EventSystem.RowsCardDuel?.installed) return;

  const Logic = window.oni.EventSystem.Logic;
  const EventRegistry = window.oni.EventSystem.EventRegistry;
  if (!Logic || !EventRegistry) {
    console.error(INSTALL_TAG, "Missing Logic or EventRegistry. Check load order.");
    return;
  }

  const flow = () => window.oni.EventSystem.Flow;
  const api = () => globalThis.FUCompanion?.api?.fabulaArcana;
  const RESULT_CODE = { win: 1, loss: 2, draw: 3, cancel: 0 };
  const DIFFS = [["casual", "Casual"], ["skilled", "Skilled"]];
  const STYLES = [["", "Balanced"], ["aggressive", "Aggressive"], ["defensive", "Defensive"], ["trickster", "Trickster"]];

  const teamOf = (text) => String(text ?? "").split(/[,\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean).slice(0, 3);

  function prepare(row) {
    row.npc = String(row.npc ?? "").trim();
    row.team = teamOf(row.team).join(", ");
    row.diff = DIFFS.some(([k]) => k === row.diff) ? row.diff : "casual";
    row.style = STYLES.some(([k]) => k === row.style) ? row.style : "";
    row.bestOf = [1, 3, 5].includes(Number(row.bestOf)) ? Number(row.bestOf) : 1;
    row.quote = String(row.quote ?? "");
    row.variable = String(row.variable ?? "").trim();
  }

  function npcToken(row, context) {
    const scene = canvas?.scene;
    if (!row.npc) return context?.sourceDoc?.documentName === "Token" ? context.sourceDoc : null;
    const wanted = row.npc.toLowerCase();
    return (scene?.tokens?.contents ?? []).find((t) => String(t.name ?? "").trim().toLowerCase() === wanted || String(t.actor?.name ?? "").trim().toLowerCase() === wanted) ?? null;
  }

  EventRegistry.register({
    type: "cardDuel",
    label: "Card Duel",
    category: "Flow",
    defaultData: { type: "cardDuel", npc: "", team: "", diff: "casual", style: "", bestOf: 1, quote: "", variable: "Card Duel Result" },
    prepare,
    summary: (row) => {
      const team = teamOf(row?.team);
      const C = api()?.Catalog?.CARDS ?? {};
      const names = team.map((c) => C[c]?.name ?? `${c}?`).join(" / ");
      return `vs ${row?.npc || "this token"} · ${names || "random team"} · ${row?.diff === "skilled" ? "Skilled" : "Casual"} AI · Best of ${row?.bestOf ?? 1}${row?.variable ? ` → ${row.variable}` : ""}`;
    },
    execute: async (row, context) => {
      const FA = api();
      if (!FA?.eventDuel) return { ok: false, type: "cardDuel", reason: "noFabulaArcana" };
      const tok = npcToken(row, context);
      if (!tok) {
        ui.notifications?.warn?.(`Card Duel: no token called "${row?.npc || "(this event's token)"}" on this scene.`);
        return { ok: false, type: "cardDuel", reason: "noToken" };
      }
      const team = teamOf(row?.team);
      const C = FA.Catalog?.CARDS ?? {};
      if (team.length && (team.length !== 3 || team.some((c) => !C[c]))) {
        ui.notifications?.warn?.(`Card Duel: the team "${row.team}" isn't three known cards; the NPC plays a random team.`);
      }

      const f = flow();
      const id = String(context?.tileId || "");
      if (id) f?.hold?.(id);
      let offAbort = null, res = null;
      try {
        // ending the event from the GM chip ends the duel (it reports "cancelled")
        offAbort = id ? f?.onAbort?.(id, () => FA.cancelEventDuels?.()) : null;
        res = await FA.eventDuel({
          npcTokenUuid: tok.uuid, npcActorId: tok.actor?.id ?? null,
          team: team.length === 3 && team.every((c) => C[c]) ? team : null,
          diff: row?.diff, style: row?.style || null, bestOf: row?.bestOf, quote: row?.quote,
        });
      } catch (e) {
        console.error(INSTALL_TAG, e);
        ui.notifications?.error?.(`Card Duel: ${e.message}`);
        return { ok: false, type: "cardDuel", reason: "threw", stop: true };
      } finally {
        offAbort?.();
        if (id) f?.release?.(id);
      }

      const result = res?.result ?? "cancel";
      if (row?.variable) {
        try { await window.oni?.GameState?.setVariable?.(row.variable, "set", RESULT_CODE[result] ?? 0); }
        catch (e) { console.warn(INSTALL_TAG, "result variable", e); }
      }
      if (id && f?.isAborted?.(id)) return { ok: true, type: "cardDuel", aborted: true, result };
      return { ok: true, type: "cardDuel", result };
    },
    buildFields: (row, kit) => kit.fields(
      kit.field("Opponent", `<input type="text" class="oni-event-row-cd-npc" value="${kit.escapeHTML(row.npc ?? "")}" placeholder="(this event's token)" />`,
        "Token name on this scene. Empty = the token this event belongs to."),
      kit.field("NPC team", `<input type="text" class="oni-event-row-cd-team" value="${kit.escapeHTML(row.team ?? "")}" placeholder="wolf, salamander, manaray" />`,
        "Three card ids, lead card first. Empty or invalid = a random legal team."),
      kit.field("AI", `<select class="oni-event-row-cd-diff">${DIFFS.map(([k, n]) => `<option value="${k}" ${row.diff === k ? "selected" : ""}>${n}</option>`).join("")}</select>
        <select class="oni-event-row-cd-style">${STYLES.map(([k, n]) => `<option value="${k}" ${row.style === k ? "selected" : ""}>${n}</option>`).join("")}</select>`, ""),
      kit.field("Best of", `<select class="oni-event-row-cd-bo">${[1, 3, 5].map((n) => `<option value="${n}" ${Number(row.bestOf) === n ? "selected" : ""}>${n}</option>`).join("")}</select>`,
        "The duel window offers Leave only at the end: a story duel is played once."),
      kit.field("Quote", `<input type="text" class="oni-event-row-cd-quote" value="${kit.escapeHTML(row.quote ?? "")}" />`,
        "The NPC's line on the duel's opening screen."),
      kit.field("Result variable", `<input type="text" class="oni-event-row-cd-var" value="${kit.escapeHTML(row.variable ?? "")}" placeholder="Card Duel Result" />`,
        "Set when the window closes: 1 party won · 2 NPC won · 3 draw · 0 cancelled. Branch on it with Condition rows.")
    ),
    collectFields: (rowEl, kit) => ({
      npc: kit.readText(rowEl, ".oni-event-row-cd-npc", "").trim(),
      team: kit.readText(rowEl, ".oni-event-row-cd-team", "").trim(),
      diff: kit.readText(rowEl, ".oni-event-row-cd-diff", "casual"),
      style: kit.readText(rowEl, ".oni-event-row-cd-style", ""),
      bestOf: Number(kit.readText(rowEl, ".oni-event-row-cd-bo", "1")) || 1,
      quote: kit.readText(rowEl, ".oni-event-row-cd-quote", ""),
      variable: kit.readText(rowEl, ".oni-event-row-cd-var", "").trim()
    })
  });

  window.oni.EventSystem.RowsCardDuel = { installed: true };
})();
