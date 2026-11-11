// Battle Grade v2 — the persistent side: Bonus Board + MVP Prize bag, and
// paying the prize. GM / BD host only.
//
// State lives on the party DB actor (the same actor that holds the battle log
// and the gacha coupon pool):
//   flags.fabula-ultima-companion.battleGrade = { sessionId, slots, bag, last }
//
// The board resets to 0 when the Fabula Ledger opens a new session: the stored
// sessionId no longer matches the ledger's, so the next read treats it as 0.

import { log, warn } from "../logger.js";
import { applyBoard, perkPct, nextPerk, drawPrize, zenitPrize, G } from "./grade-core.js";

const NS = "fabula-ultima-companion";
const FLAG = "battleGrade";
const FP_PROP = "fabula_point", FP_CAP = 10;
const ZP_PROP = "zero_power_value", ZP_CAP = 6;
const ZENIT_PROP = "zenit";

const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

async function dbActor() {
  try {
    const out = await globalThis.FUCompanion?.api?.getCurrentGameDb?.();
    return out?.db ?? out?.dbActor ?? out?.actor ?? null;
  } catch { return null; }
}

const ledgerSessionId = () => {
  try { return globalThis.FabulaLedger?._internal?.readState?.()?.session?.id ?? null; } catch { return null; }
};

/** The board as it stands now (0 slots if a new session opened since it was written). */
export async function readBoard(db = null) {
  const a = db ?? await dbActor();
  const s = a?.getFlag?.(NS, FLAG) ?? {};
  const sid = ledgerSessionId();
  const fresh = sid && s.sessionId !== sid;
  return {
    sessionId: sid ?? s.sessionId ?? null,
    slots: fresh ? 0 : Math.max(0, Math.min(G.BOARD_MAX, num(s.slots))),
    bag: Array.isArray(s.bag) ? s.bag.slice() : [],
    last: s.last ?? null,
  };
}

async function writeBoard(a, state) {
  if (!a || !game.user?.isGM) return;
  try { await a.setFlag(NS, FLAG, state); } catch (e) { warn("grade-state: board write failed", e); }
}

/** EXP multiplier for the NEXT victory, read at PREP (battle-end-rewards). */
export async function boardExpMultiplier() {
  try { return 1 + perkPct((await readBoard()).slots) / 100; } catch { return 1; }
}

async function actorOfKey(roster, key) {
  const r = roster?.[key];
  if (!r) return null;
  const doc = await fromUuid(r.actorUuid ?? r.tokenUuid).catch(() => null);
  return doc?.actor ?? doc ?? null;
}

/**
 * After the rank: move the board and, on S, pay the MVP Prize.
 * Writes endCtx.gradeResult = { before, after, delta, perkPct, next, prize }.
 */
export async function applyBattleGrade(endCtx) {
  const grade = endCtx?.grade;
  const db = await dbActor();
  if (!grade || !db) { endCtx.gradeResult = null; return null; }
  const board = await readBoard(db);
  const before = board.slots;
  const after = applyBoard(before, grade.boardDelta);

  let prize = null;
  let bagState = { bag: board.bag, last: board.last };
  if (grade.letter === "S" && grade.mvp) {
    const mvp = await actorOfKey(endCtx.gradeTally?.roster, grade.mvp);
    if (mvp) {
      const eligible = (p) =>
        p === "fp" ? num(mvp.system?.props?.[FP_PROP]) < FP_CAP :
        p === "zp" ? num(mvp.system?.props?.[ZP_PROP]) < ZP_CAP : true;
      const d = drawPrize(bagState, { eligible });
      bagState = d.state;
      if (d.prize) prize = await payPrize(d.prize, mvp, db, endCtx);
    }
  }

  await writeBoard(db, { sessionId: board.sessionId, slots: after, bag: bagState.bag, last: bagState.last });
  const res = { before, after, delta: after - before, perkPct: perkPct(after), next: nextPerk(after), prize };
  endCtx.gradeResult = res;
  log(`[BattleGrade] ${grade.letter} ${grade.score} · board ${before}→${after} · MVP ${grade.mvp ?? "-"}${prize ? ` · prize ${prize.kind} ${prize.amount ?? ""}` : ""}`);
  return res;
}

async function payPrize(kind, mvp, db, endCtx) {
  try {
    if (kind === "fp") {
      const r = await globalThis.FUCompanion?.api?.fabula?.change?.([mvp], 1, { reason: "mvp-prize", label: mvp.name });
      return { kind, amount: 1, actorId: mvp.id, ok: r?.ok !== false };
    }
    if (kind === "zp") {
      const cur = num(mvp.system?.props?.[ZP_PROP]);
      await mvp.update({ [`system.props.${ZP_PROP}`]: Math.min(ZP_CAP, cur + 1) });
      return { kind, amount: 1, actorId: mvp.id, ok: true };
    }
    if (kind === "coupon") {
      const { grantCoupons } = await import("../../gacha-system/gacha-state.js");
      const r = await grantCoupons(db, 1);
      return { kind, amount: 1, actorId: mvp.id, ok: !!r?.ok };
    }
    if (kind === "zenit") {
      const party = (endCtx.summaryResults?.zenitApplied ?? []).reduce((s, z) => s + num(z?.zenit?.gained), 0);
      const amount = zenitPrize(party);
      const cur = num(mvp.system?.props?.[ZENIT_PROP]);
      await mvp.update({ [`system.props.${ZENIT_PROP}`]: cur + amount });
      return { kind, amount, actorId: mvp.id, ok: true };
    }
  } catch (e) {
    warn(`grade-state: paying ${kind} failed`, e);
    return { kind, amount: 0, actorId: mvp.id, ok: false };
  }
  return null;
}

/** A wipe or fleeing clears the board. */
export async function clearBoardOnLoss(outcome) {
  if (outcome !== "escaped" && outcome !== "defeat") return;
  const db = await dbActor();
  if (!db) return;
  const b = await readBoard(db);
  if (!b.slots) return;
  await writeBoard(db, { ...b, slots: 0 });
  log(`[BattleGrade] board cleared (${outcome})`);
}

Hooks.once("ready", () => {
  globalThis.FUCompanion = globalThis.FUCompanion || {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
  globalThis.FUCompanion.api.battleGrade = Object.assign(globalThis.FUCompanion.api.battleGrade ?? {}, { readBoard, boardExpMultiplier });
});
