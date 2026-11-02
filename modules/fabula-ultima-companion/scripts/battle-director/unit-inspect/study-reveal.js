// Study result — shows a Study on the Inspect card on every client and holds the
// battle until it has been read. The Encyclopedia journal stays the only record;
// this is presentation.
//
//   host (RESOLVE, state-handlers)   runStudyReveal: tells everyone, then waits
//   every client                     unit-inspect.openStudy: the card and its reveal
//   the studier's client, or a GM    Continue → releaseStudy → the host stops waiting
//
// The battle never waits on a player who isn't there (player-presence.js): the wait
// ends if the studier drops, the GM desk can end it, and a hard cap catches anything
// else. The cap is a safety net for a broken client, shown to nobody.

import { log, warn } from "../logger.js";
import { trackWait, watchGone } from "../player-presence.js";

const CHANNEL = "module.fabula-ultima-companion";
const HOLD_CAP_MS = 60_000;
const PEER_DELAY_MS = 400;   // lets Foundry's page broadcast land before the card reads it

const _holds = new Map();    // id → finish(), host only
const _ended = new Set();    // ended before this client's delayed open ran

const emit = (type, data) => { try { game.socket?.emit?.(CHANNEL, { type, ...data }); } catch (e) { warn("[study-reveal] emit failed", e); } };
const inspectApi = () => globalThis.FUCompanion?.api?.unitInspect ?? null;

async function showHere(p) {
  if (_ended.delete(p.id)) return;
  const owner = p.ownerUserId ? game.user?.id === p.ownerUserId : !!game.user?.isGM;
  let ok = false;
  try {
    if (p.sceneId === canvas?.scene?.id) ok = !!(await inspectApi()?.openStudy?.(canvas.tokens?.get(p.tokenId), p));
  } catch (e) { warn("[study-reveal] open failed", e); }
  // Whoever has to press Continue can't see it, so nobody is left to press it.
  if (!ok && owner) releaseStudy(p.id);
}

function onSocket(data) {
  if (data?.type === "study:reveal") setTimeout(() => showHere(data), PEER_DELAY_MS);
  else if (data?.type === "study:release") _holds.get(data.id)?.();
  else if (data?.type === "study:done") { _ended.add(data.id); inspectApi()?.endStudy?.(data.id); setTimeout(() => _ended.delete(data.id), 10_000); }
}

export function installStudyReveal() {
  try { game.socket?.on?.(CHANNEL, onSocket); }
  catch (e) { warn("[study-reveal] socket listener failed", e); }
}

/** Continue was pressed here. */
export function releaseStudy(id) {
  const here = _holds.get(id);
  if (here) here();
  else emit("study:release", { id });
}

/**
 * Host only. Resolves once the battle may move on.
 * `ownerUserId` null = nobody at the table owns the studier, so a GM continues.
 */
export function runStudyReveal({ tokenUuid, actorUuid, ownerUserId, studierName, total, previousBest, newBest }) {
  const parts = String(tokenUuid ?? "").split(".");
  const payload = {
    id: foundry.utils.randomID(),
    sceneId: parts[parts.indexOf("Scene") + 1] ?? canvas?.scene?.id,
    tokenId: parts.at(-1),
    actorUuid, ownerUserId: ownerUserId ?? null,
    studierName, total, previousBest, newBest,
  };
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(cap);
      stopGone();
      stopWait();
      Hooks.off("fu-director-stopped", onStopped);
      _holds.delete(payload.id);
      emit("study:done", { id: payload.id });
      inspectApi()?.endStudy?.(payload.id);
      resolve();
    };
    const onStopped = () => finish();
    const cap = setTimeout(() => { log(`[study-reveal] hold cap reached for ${studierName}`); finish(); }, HOLD_CAP_MS);
    const stopGone = watchGone(ownerUserId, finish);
    const stopWait = trackWait({
      userId: ownerUserId, label: `${studierName}'s Study result`,
      actions: [{ id: "continue", label: "Continue", run: finish }],
    });
    Hooks.on("fu-director-stopped", onStopped);
    _holds.set(payload.id, finish);
    emit("study:reveal", payload);
    showHere(payload);
  });
}
