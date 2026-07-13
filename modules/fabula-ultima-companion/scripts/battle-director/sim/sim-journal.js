// Sim Journal — a machine-readable record of what the AI was THINKING.
//
// Why this exists: three separate bugs in a row ("Zarg won't use Gadgets") each cost a
// full round-trip to diagnose, because the only evidence was an HP bar that didn't
// move. A refusal is invisible. The transcript helped, but it lives in browser memory
// and has to be fished out over the bridge one query at a time.
//
// So every run now writes a JSON file to disk that can be read directly:
//
//     Data/worlds/<world>/sim-logs/sim-<timestamp>.json
//
// It records not just what happened but what was CONSIDERED and REJECTED, with the
// reason — because "he never used Gadgets" and "he considered Gadgets and believed he
// had 0 IP" look identical from the outside and have completely different fixes.
//
// Read it with: FUCompanion.api.experimental.sim.journal()  (in-memory, live)
// or just open the file.

import { log, warn } from "../logger.js";

const MODULE_DIR = "sim-logs";

const _state = {
  entries: [],
  runId: null,
  startedAt: 0,
};

export const Journal = {
  begin(runId, config) {
    _state.entries = [];
    _state.runId = runId;
    _state.startedAt = Date.now();
    this.write("run", "begin", { config });
  },

  // The core primitive. `kind` groups it; `what` is the headline; `data` is whatever
  // a future me needs to see to understand the decision without re-running anything.
  write(kind, what, data = {}) {
    _state.entries.push({
      t: Date.now() - _state.startedAt,
      round: currentRound(),
      kind,
      what,
      ...data,
    });
  },

  // A decision WITH its alternatives — the shape that actually answers "why not?".
  // `considered` is [{ option, ok, why }], so a rejection carries its own reason and
  // nothing has to be inferred from an absence.
  decision(actor, kind, chosen, considered = []) {
    this.write("decision", chosen ?? "(nothing)", {
      actor,
      decisionKind: kind,
      chosen: chosen ?? null,
      considered,
    });
  },

  entries() { return _state.entries.slice(); },

  // Write the whole thing to disk so it can be read outside the browser.
  async flush(summary = {}) {
    try {
      this.write("run", "end", { summary });

      const world = game.world?.id ?? "world";
      const dir = `worlds/${world}/${MODULE_DIR}`;
      try { await FilePicker.createDirectory("data", dir); } catch { /* already exists */ }

      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const name = `sim-${stamp}.json`;
      const body = JSON.stringify(
        { runId: _state.runId, summary, entries: _state.entries },
        null,
        2,
      );

      const file = new File([body], name, { type: "application/json" });
      await FilePicker.upload("data", dir, file, {}, { notify: false });

      log(`[SIM] journal written → ${dir}/${name} (${_state.entries.length} entries)`);
      return `${dir}/${name}`;
    } catch (e) {
      warn("[SIM] journal flush failed — the log is still in memory via sim.journal()", e);
      return null;
    }
  },
};

function currentRound() {
  try {
    return globalThis.FUCompanion?.api?.experimental?.battleDirector
      ?.getActiveDirector?.()?.dCombat?.round ?? null;
  } catch { return null; }
}
