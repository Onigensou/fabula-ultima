// Battle End Summary UI — broadcasts the JRPG victory screen to all clients.
//
// Emits ONI_BATTLEEND_SUMMARY_UI via the module socket channel so every
// connected client runs the animation. Also fires locally on the GM since
// the socket does not echo back to the sender.
// Fire-and-forget: caller does NOT await — the transition can start while
// players are still watching the summary screen.

import { log, warn } from "../logger.js";

const MODULE_ID      = "fabula-ultima-companion";
const SOCKET_CHANNEL = `module.${MODULE_ID}`;
const MSG_TYPE       = "ONI_BATTLEEND_SUMMARY_UI";

const ZENIT_ICON_SRC = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/GP.png";

export function runBattleEndSummaryUI(endCtx) {
  const { summaryResults, rank, totalRounds } = endCtx;
  if (!summaryResults) { warn("[BattleEnd:SummaryUI] No summaryResults — skipping"); return; }

  const { expApplied, zenitApplied, combatTotals, expRule } = summaryResults;
  if (!Array.isArray(expApplied) || !expApplied.length) {
    warn("[BattleEnd:SummaryUI] expApplied empty — skipping");
    return;
  }

  // Build zenit lookup from zenitApplied
  const zenitById = {};
  for (const row of (zenitApplied ?? [])) {
    if (row?.actorId) zenitById[row.actorId] = row.zenit ?? { before: 0, gained: 0, after: 0 };
  }

  const uiPayload = {
    runId:        `sum_${Date.now()}`,
    lockInteractions: true,
    holdMs:       5000,
    totalRounds:  totalRounds ?? null,
    totalDamage:  combatTotals?.totalDamage ?? null,
    totalHealing: combatTotals?.totalHealing ?? null,
    rank: {
      letter: rank?.letter ?? "S",
      score:  rank?.score  ?? null,
    },
    rankLetter: rank?.letter ?? "S",
    rule: {
      expStart:  expRule?.expStart  ?? 1,
      levelUpAt: expRule?.levelUpAt ?? 10,
    },
    zenitIconSrc: ZENIT_ICON_SRC,
    entries: expApplied.map(e => {
      const z = zenitById[e.actorId] ?? { before: 0, gained: 0, after: 0 };
      return {
        actorId:    e.actorId,
        actorName:  e.actorName,
        exp:        e.exp,
        level:      e.level,
        segments:   e.segments,
        zenitBefore: Math.floor(Number(z.before ?? 0)),
        zenitAfter:  Math.floor(Number(z.after  ?? 0)),
        zenitGain:   Math.floor(Number(z.gained ?? 0)),
      };
    }),
  };

  // Broadcast to all clients
  try {
    game.socket.emit(SOCKET_CHANNEL, { type: MSG_TYPE, sceneId: canvas.scene?.id ?? "", payload: uiPayload });
    log("[BattleEnd:SummaryUI] Socket broadcast sent");
  } catch (e) {
    warn("[BattleEnd:SummaryUI] Socket emit failed:", e);
  }

  // Run locally on GM (socket does not echo back to sender)
  Promise.resolve()
    .then(() => {
      const runner = window.ONI_BattleEnd_SummaryUI?.run;
      if (typeof runner === "function") return runner(uiPayload);
      warn("[BattleEnd:SummaryUI] Local runner missing (ONI_BattleEnd_SummaryUI.run)");
    })
    .then(() => log("[BattleEnd:SummaryUI] Local render complete"))
    .catch(e => warn("[BattleEnd:SummaryUI] Local render threw:", e));
}
