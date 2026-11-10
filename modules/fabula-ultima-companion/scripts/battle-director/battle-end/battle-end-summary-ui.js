// Battle End Summary UI — broadcasts the JRPG victory screen to all clients.
//
// Emits ONI_BATTLEEND_SUMMARY_UI via the module socket channel so every
// connected client runs the animation. Also fires locally on the GM since
// the socket does not echo back to the sender.
// The GM-local runner is awaited so the orchestrator holds until the animation
// finishes before starting the scene transition. Players run the animation
// independently via socket and are already watching when the black screen hits.

import { log, warn } from "../logger.js";

const MODULE_ID      = "fabula-ultima-companion";
const SOCKET_CHANNEL = `module.${MODULE_ID}`;
const MSG_TYPE       = "ONI_BATTLEEND_SUMMARY_UI";

const ZENIT_ICON_SRC = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/GP.png";

export async function runBattleEndSummaryUI(endCtx) {
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

  // Battle Grade v2 block (null when the battle had no tally → the screen falls
  // back to the shipped look). Titles / MVP are keyed by world actor id, the
  // same key as the cards.
  let gradeUi = null;
  let tallyHealing = 0;
  try {
    const g = endCtx.grade, gr = endCtx.gradeResult, roster = endCtx.gradeTally?.roster ?? {};
    if (g) {
      const { G, TITLE_LABEL } = await import("../battle-grade/grade-core.js");
      const idOf = (key) => {
        const r = roster[key];
        const m = String(r?.actorUuid ?? "").match(/^Actor\.([^.]+)$/);
        return m ? m[1] : (r ? (fromUuidSync?.(r.actorUuid ?? r.tokenUuid)?.id ?? null) : null);
      };
      const titles = {};
      for (const [k, t] of Object.entries(g.titles ?? {})) { const id = idOf(k); if (id) titles[id] = TITLE_LABEL[t] ?? t; }
      tallyHealing = Object.values(g.stats ?? {}).reduce((s, x) => s + (Number(x.healsTotal) || 0), 0);
      gradeUi = {
        letter: g.letter, score: g.score,
        gauges: g.gauges, max: G.MAX, stars: g.stars, crosses: g.crosses,
        mvpActorId: idOf(g.mvp), titles,
        board: gr ? { before: gr.before, after: gr.after, delta: gr.delta, perkPct: gr.perkPct, next: gr.next } : null,
        prize: gr?.prize ? { kind: gr.prize.kind, amount: gr.prize.amount ?? 1 } : null,
        couponImg: gr?.prize?.kind === "coupon" ? (game.items?.get?.("pcVQKM3teguaitRy")?.img ?? null) : null,
      };
    }
  } catch (e) { warn("[BattleEnd:SummaryUI] grade block failed (screen falls back to the shipped look)", e); }

  const uiPayload = {
    runId:        `sum_${Date.now()}`,
    lockInteractions: true,
    holdMs:       5000,
    totalRounds:  totalRounds ?? null,
    totalDamage:  combatTotals?.totalDamage ?? null,
    // Most heals write no battle-log row, so the tally's count is the fuller one.
    totalHealing: Math.max(Number(combatTotals?.totalHealing ?? 0) || 0, Math.floor(tallyHealing)) || (combatTotals?.totalHealing ?? null),
    grade:        gradeUi,
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

  // Run locally on GM and await — orchestrator holds here until animation completes,
  // then starts the scene transition (raiseCurtain → switch → dropCurtain).
  try {
    const runner = window.ONI_BattleEnd_SummaryUI?.run;
    if (typeof runner === "function") {
      await runner(uiPayload);
    } else {
      warn("[BattleEnd:SummaryUI] Local runner missing (ONI_BattleEnd_SummaryUI.run)");
    }
  } catch (e) {
    warn("[BattleEnd:SummaryUI] Local render threw:", e);
  }
  log("[BattleEnd:SummaryUI] Local render complete");
}
