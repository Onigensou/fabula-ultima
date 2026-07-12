// Sim Runner — launches a hands-free Battle Director fight and reports how it went.
//
// PHASE 0 SCOPE: one battle, console-driven, no panel and no aggregate report.
// The single question it answers is "can the FSM run a whole fight with nobody
// at the keyboard?" Everything else (batching, per-PC profiles, the HTML report,
// the dev-tools panel) is deliberately not here yet.
//
//   await FUCompanion.api.experimental.sim.run({
//     enemy: "Actor.KygETN50UthluNPl",   // or an actor NAME
//     quantity: 1,
//     party: ["Actor.xxx", "Actor.yyy"], // omit → every PC in the party folder
//     pace: "fast",                       // "watch" | "fast" | "batch"
//   });
//
// SAFETY — why the party is cloned. Party tokens spawn LINKED (director-init:490
// "PCs linked, NPCs unlinked"), so every point of damage a sim deals to a PC
// writes through to the real world actor. Enemies are unlinked and take their
// damage on a throwaway synthetic actor, so they need no protection — but the
// party MUST be cloned or a playtest run would chew your real characters' HP and
// MP. The clones are GM-owned (ownership.default = 0), which also keeps the FSM
// from trying to route any decision to a connected player's client.

import { log, warn } from "../logger.js";
import { SimMode, forceEndSim } from "./sim-mode.js";

const SCRATCH_FOLDER = "BD Sim";
const SCENE_NAME = "Training Ground";
const POLL_MS = 400;
const STALL_TIMEOUT_MS = 180_000;   // no observable progress for 3 min → abort

function api() {
  return globalThis.FUCompanion?.api?.experimental?.battleDirector ?? null;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function resolveActor(ref) {
  if (!ref) return null;
  if (typeof ref === "string" && ref.includes(".")) {
    const byUuid = await fromUuid(ref).catch(() => null);
    if (byUuid) return byUuid;
  }
  return game.actors?.getName?.(String(ref)) ?? null;
}

async function ensureScratchFolder() {
  const existing = game.folders?.find((f) => f.type === "Actor" && f.name === SCRATCH_FOLDER);
  if (existing) return existing;
  return Folder.create({ name: SCRATCH_FOLDER, type: "Actor" });
}

// ── Party cloning ───────────────────────────────────────────────────────────
async function cloneParty(actorRefs) {
  const folder = await ensureScratchFolder();
  const clones = [];
  for (const ref of actorRefs) {
    const src = await resolveActor(ref);
    if (!src) { warn(`[SIM] party member not found: ${ref}`); continue; }

    const data = src.toObject();
    delete data._id;
    data.name = `${src.name} [SIM]`;
    data.folder = folder.id;
    // GM-only. Replaces (not merges) the source's ownership map, so no player
    // owns the clone: nothing to remote-route a decision to, and hasPlayerOwner
    // reads false even before the sim's AI-gate override kicks in.
    data.ownership = { default: 0 };

    const doc = await Actor.create(data);
    if (doc) {
      clones.push(doc);
      log(`[SIM] cloned ${src.name} → ${doc.name}`);
    }
  }
  return clones;
}

async function deleteClones(clones) {
  const ids = clones.map((c) => c?.id).filter(Boolean);
  if (!ids.length) return;
  try {
    await Actor.deleteDocuments(ids);
    log(`[SIM] cleaned up ${ids.length} clone(s)`);
  } catch (e) {
    warn("[SIM] clone cleanup failed — scratch actors left in the BD Sim folder", e);
  }
}

// ── Observation ─────────────────────────────────────────────────────────────
function readHp(actorDoc) {
  const p = actorDoc?.system?.props ?? {};
  const cur = Number(p.current_hp);
  const max = Number(p.max_hp ?? p.hp_max);
  return {
    hp: Number.isFinite(cur) ? cur : null,
    maxHp: Number.isFinite(max) ? max : null,
  };
}

function snapshotCombat(director) {
  const dc = director?.dCombat;
  if (!dc) return null;
  return {
    round: dc.round ?? 0,
    ended: !!dc.ended,
    combatants: (dc.combatants ?? []).map((c) => ({
      name: c.name,
      side: c.side,
      defeated: !!c.isDefeatedLive?.(),
      ...readHp(c.actorDoc),
    })),
  };
}

function classify(snap) {
  if (!snap) return "unknown";
  const party = snap.combatants.filter((c) => c.side === "party");
  const enemy = snap.combatants.filter((c) => c.side === "enemy");
  const partyDead = party.length > 0 && party.every((c) => c.defeated);
  const enemyDead = enemy.length > 0 && enemy.every((c) => c.defeated);
  if (partyDead && enemyDead) return "mutual-destruction";
  if (partyDead) return "defeat";
  if (enemyDead) return "victory";
  return "inconclusive";
}

// Party HP remaining, as a fraction of the party's total max HP. THE headline
// balance number: a fight the party walks out of at >70% never really happened.
function partyHpRemaining(snap) {
  const party = (snap?.combatants ?? []).filter((c) => c.side === "party");
  const cur = party.reduce((a, c) => a + Math.max(0, c.hp ?? 0), 0);
  const max = party.reduce((a, c) => a + (c.maxHp ?? 0), 0);
  if (!max) return null;
  return cur / max;
}

// ── The run ─────────────────────────────────────────────────────────────────
export async function run({
  enemy,
  quantity = 1,
  party = null,
  pace = "fast",
  reactions = "skip",
  maxRounds = 30,
} = {}) {
  const a = api();
  if (!a?.start) { ui.notifications?.error("[SIM] Battle Director API not ready."); return null; }
  if (a.isRunning?.()) { ui.notifications?.warn("[SIM] A battle is already running — end it first."); return null; }
  if (SimMode.active) { ui.notifications?.warn("[SIM] A sim is already in progress."); return null; }

  const enemyActor = await resolveActor(enemy);
  if (!enemyActor) { ui.notifications?.error(`[SIM] enemy actor not found: ${enemy}`); return null; }

  const scene = game.scenes?.find((s) => s.name === SCENE_NAME) ?? game.scenes?.active ?? canvas?.scene ?? null;
  if (!scene) { ui.notifications?.error("[SIM] no scene to launch on."); return null; }

  // The party MUST be explicit. There is no safe default: `hasPlayerOwner` is
  // true for ~150 actors in this world (every retired PC, guest and class shell),
  // and a "convenience" fallback would happily clone all of them. Cloning is the
  // safety mechanism that keeps a sim off the real PCs — it must never run on a
  // set the caller didn't name.
  const refs = Array.isArray(party) ? party.filter(Boolean) : [];
  if (!refs.length) {
    ui.notifications?.error("[SIM] pass an explicit `party: [uuid, …]` — there is no default.");
    return null;
  }

  let clones = [];
  let result = null;

  try {
    SimMode.begin({ pace, reactions, maxRounds });

    clones = await cloneParty(refs);
    if (!clones.length) throw new Error("no party clones were created");

    const members = clones.map((c, i) => ({
      actorUuid: c.uuid, actorId: c.id, name: c.name, slot: i + 1, img: c.img,
    }));

    const payload = {
      context: { battleSceneUuid: scene.uuid, sourceSceneId: scene.id, lean: true },
      encounterPlan: { mode: "manual", manualPicks: [{ actorUuid: enemyActor.uuid, name: enemyActor.name, quantity }] },
      party: { members },
    };

    SimMode.note("start", `${members.length} PC(s) vs ${enemyActor.name} ×${quantity}`);
    await a.start({ payload });

    // ── Watch it play ─────────────────────────────────────────────────────
    // Poll the director's own authoritative model rather than adding hooks to
    // the FSM. Two ways out: the combat ends itself (checkSideWipe → dc.end()
    // → BATTLE_ENDING, which lean mode short-circuits straight to STOPPED), or
    // a guard trips. A sim must ALWAYS terminate — a hang costs a page reload.
    const started = Date.now();
    let lastProgress = Date.now();
    let lastSig = "";
    let final = null;

    for (;;) {
      const director = a.getActiveDirector?.() ?? globalThis.__fuDirector_lastInstance ?? null;
      const snap = snapshotCombat(director);

      if (snap) {
        final = snap;
        const sig = `${snap.round}|${snap.combatants.map((c) => `${c.name}:${c.hp}:${c.defeated}`).join(",")}`;
        if (sig !== lastSig) { lastSig = sig; lastProgress = Date.now(); }

        if (snap.ended) { SimMode.note("end", `combat ended in round ${snap.round}`); break; }

        if (snap.round > maxRounds) {
          SimMode.note("abort", `hit the ${maxRounds}-round cap — calling it a stalemate`);
          break;
        }
      }

      if (!a.isRunning?.()) { SimMode.note("end", "director stopped"); break; }

      if (Date.now() - lastProgress > STALL_TIMEOUT_MS) {
        SimMode.note("abort", `no progress for ${STALL_TIMEOUT_MS / 1000}s — aborting (a gate is probably still waiting on a human)`);
        break;
      }

      await sleep(POLL_MS);
    }

    const outcome = classify(final);
    const hpLeft = partyHpRemaining(final);
    result = {
      outcome,
      rounds: final?.round ?? 0,
      partyHpRemaining: hpLeft,
      durationSec: Math.round((Date.now() - started) / 1000),
      combatants: final?.combatants ?? [],
      transcript: [...SimMode.transcript],
      config: { pace, reactions, maxRounds },
    };

    log(`[SIM] RESULT — ${outcome} in ${result.rounds} round(s); party at ${hpLeft == null ? "?" : Math.round(hpLeft * 100)}% HP (${result.durationSec}s wall)`);
  } catch (e) {
    warn("[SIM] run threw", e);
    ui.notifications?.error(`[SIM] run failed: ${e?.message ?? e}`);
  } finally {
    // Order matters: stop the battle (which sweeps its spawned tokens) BEFORE
    // deleting the clone actors, or the sweep is left holding tokens whose actor
    // is gone. Then leave sim mode LAST and unconditionally — if the flag stayed
    // set, the next real card a GM opened would confirm itself.
    try { if (api()?.isRunning?.()) await api().stop(); } catch (e) { warn("[SIM] stop threw", e); }
    await deleteClones(clones);
    forceEndSim("run complete");
  }

  return result;
}

// Escape hatch, for when a run wedges and the console is all you have.
export function abort() {
  try { api()?.stop?.(); } catch {}
  return forceEndSim("manual abort");
}
