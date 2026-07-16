// Sim Runner — launches a hands-free Battle Director fight and reports how it went.
//
// Normally driven from the 🧪 dev-tools panel (sim-panel.js). The console entry point:
//
//   await FUCompanion.api.experimental.sim.run({
//     enemies: [{ uuid: "Actor.xxx", quantity: 2 }],  // an encounter group
//     party:   ["Actor.xxx", …],       // omit → the DB-resolved party
//     pace:    "fast",                 // "watch" | "fast" | "batch"
//     expectedRounds: 7,               // unresolved by here = a design failure
//     phoenixFeathers: 0,              // revives the party walks in with
//     startingZp: 0,                   // 6 = a charged limit break
//     fabulaPoints: 3,                 // invokes spend these
//   });
//
// Every run writes a machine-readable decision log to
// `worlds/<world>/sim-logs/sim-<timestamp>.json` (see sim-journal.js) — that journal is
// how you find out WHY the AI didn't do something, which is otherwise invisible.
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
import { Journal } from "./sim-journal.js";

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

// ── The real party ──────────────────────────────────────────────────────────
// "The party" is whoever the DB actor says it is — `member_id_1..N` on the
// current-game DB actor (see [[feedback_players_means_party]]). NOT
// `hasPlayerOwner`, which is true for ~150 actors in this world (every retired
// PC, guest and class shell). Slot 1 stores a bare id while the others store
// full uuids, so normalize both.
export async function resolveDbParty() {
  try {
    const data = await globalThis.FUCompanion?.api?.getCurrentGameDb?.();
    const props = data?.db?.system?.props ?? null;
    if (!props) return [];

    const out = [];
    for (let i = 1; i <= 8; i++) {
      const raw = String(props[`member_id_${i}`] ?? "").trim();
      if (!raw) continue;
      const uuid = raw.includes(".") ? raw : `Actor.${raw}`;
      const actor = await fromUuid(uuid).catch(() => null);
      if (actor) out.push({ uuid: actor.uuid, name: actor.name });
    }
    return out;
  } catch (e) {
    warn("[SIM] resolveDbParty threw", e);
    return [];
  }
}

async function ensureScratchFolder() {
  const existing = game.folders?.find((f) => f.type === "Actor" && f.name === SCRATCH_FOLDER);
  if (existing) return existing;
  return Folder.create({ name: SCRATCH_FOLDER, type: "Actor" });
}

// ── Phoenix Feathers ────────────────────────────────────────────────────────
// A revive item is the single biggest swing in a fight that goes wrong — the run
// where Keren went down early and it snowballed would have looked completely
// different with one. But how many the party is carrying is a scenario variable,
// not a property of the characters, so the dev sets it per run and we stock the
// clones accordingly.
//
// The stack goes to ONE carrier (whoever already owns the item — Zarg does), and
// every other clone is zeroed, so `N feathers` means the PARTY has N, not N each.
const FEATHER_RE = /phoenix\s*feather/i;

function feathersOn(actorDoc) {
  return (actorDoc?.items ?? []).find((i) => FEATHER_RE.test(i.name ?? ""));
}

async function stockFeathers(clones, count) {
  const n = Math.max(0, Number(count) | 0);

  const carriers = clones.filter((c) => feathersOn(c));
  if (!carriers.length) {
    if (n > 0) warn(`[SIM] no party member owns a Phoenix Feather — cannot stock ${n}. Give one to a PC first.`);
    return;
  }

  for (let i = 0; i < carriers.length; i++) {
    const item = feathersOn(carriers[i]);
    const qty = i === 0 ? n : 0;   // one carrier holds the party's stack
    try {
      await item.update({ "system.props.item_quantity": String(qty) });
    } catch (e) {
      warn(`[SIM] could not set Phoenix Feather count on ${carriers[i].name}`, e);
    }
  }
  log(`[SIM] party stocked with ${n} Phoenix Feather(s) — carried by ${carriers[0].name}`);
}

// ── Party cloning ───────────────────────────────────────────────────────────
async function cloneParty(actorRefs, _startZp = 0, _startFp = 3) {
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

    // START FROM A KNOWN STATE. A clone inherits whatever HP/MP/IP the real PC
    // happens to be sitting on — Blanche was at 69/164 when we cloned her — which
    // silently makes a fight look harder than it is and makes two runs of the same
    // encounter incomparable. Full HP/MP/IP, and Zero Power at 0 (a party does not
    // walk into a fight with a charged limit break). Note the CURRENT zero-power
    // value is `zero_power_value`; there is no `current_zp` on the actor.
    const p = data.system?.props;
    if (p) {
      if (p.max_hp != null) p.current_hp = p.max_hp;
      if (p.max_mp != null) p.current_mp = p.max_mp;
      if (p.max_ip != null) p.current_ip = p.max_ip;
      // Zero Power and Fabula Points are SCENARIO variables — how charged the party is
      // walking in — so they come from the run config, not from whatever the real PC
      // happens to be sitting on.
      p.zero_power_value = _startZp;
      p.fabula_point = _startFp;
    }

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

// Turn the raw outcome into the sentence the designer actually wants to read.
// Deliberately opinionated — the whole point of the tool is to stop hedging about
// whether a fight landed.
function verdictFor(outcome, hpLeft, rounds, expectedRounds) {
  const pct = hpLeft == null ? null : Math.round(hpLeft * 100);
  switch (outcome) {
    case "overtime":
      return `UNRESOLVED after ${expectedRounds} rounds — neither side can close it out. The fight is not designed well enough: by now the party should have won or lost.`;
    case "stalled":
      return "STALLED — the harness stopped seeing progress. Probably a gate still waiting on a human, not a balance result. Do not read numbers off this run.";
    case "defeat":
      return `DEFEAT in ${rounds} round(s).`;
    case "mutual-destruction":
      return `MUTUAL DESTRUCTION in ${rounds} round(s) — everyone died.`;
    case "victory":
      if (pct == null) return `VICTORY in ${rounds} round(s).`;
      if (pct >= 85) return `VICTORY in ${rounds} round(s) at ${pct}% HP — TRIVIAL. The party was never in danger.`;
      if (pct >= 70) return `VICTORY in ${rounds} round(s) at ${pct}% HP — too easy; there was no real pressure.`;
      if (pct >= 40) return `VICTORY in ${rounds} round(s) at ${pct}% HP — a real fight.`;
      return `VICTORY in ${rounds} round(s) at ${pct}% HP — a close call.`;
    default:
      return `INCONCLUSIVE after ${rounds} round(s).`;
  }
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
  enemy,                 // single enemy (kept for the console path)
  quantity = 1,
  enemies = null,        // encounter GROUP: [{ uuid, quantity }, …] — wins over `enemy`
  party = null,          // omit → the DB-resolved party
  pace = "fast",
  reactions = "apply",
  expectedRounds = 7,
  maxRounds = 30,
  phoenixFeathers = 0,   // how many the party walks in carrying
  startingZp = 0,        // Zero Power each PC walks in with (6 = a charged limit break)
  fabulaPoints = 3,      // Fabula Points each PC walks in with (invokes spend these)
  scripts = null,        // skill-under-test directives — force a caster's action(s)
} = {}) {
  const a = api();
  if (!a?.start) { ui.notifications?.error("[SIM] Battle Director API not ready."); return null; }
  if (a.isRunning?.()) { ui.notifications?.warn("[SIM] A battle is already running — end it first."); return null; }
  if (SimMode.active) { ui.notifications?.warn("[SIM] A sim is already in progress."); return null; }

  // Encounter group: a list of different enemies with counts, exactly like the
  // Test Battle tool's payload. A bare `enemy` is just a one-row group.
  const group = Array.isArray(enemies) && enemies.length
    ? enemies
    : (enemy ? [{ uuid: enemy, quantity }] : []);
  if (!group.length) { ui.notifications?.error("[SIM] no enemies given."); return null; }

  const manualPicks = [];
  for (const g of group) {
    const actor = await resolveActor(g?.uuid ?? g);
    if (!actor) { warn(`[SIM] enemy not found: ${g?.uuid ?? g}`); continue; }
    manualPicks.push({
      actorUuid: actor.uuid,
      name: actor.name,
      quantity: Math.max(1, Number(g?.quantity ?? 1) | 0),
    });
  }
  if (!manualPicks.length) { ui.notifications?.error("[SIM] none of the enemies resolved."); return null; }

  const scene = game.scenes?.find((s) => s.name === SCENE_NAME) ?? game.scenes?.active ?? canvas?.scene ?? null;
  if (!scene) { ui.notifications?.error("[SIM] no scene to launch on."); return null; }

  // The party defaults to whoever the DB actor says the party IS — never to
  // `hasPlayerOwner`, which matches ~150 actors here (retired PCs, guests, class
  // shells). Cloning is what keeps a sim off the real PCs, so the set must always
  // be one somebody actually named.
  const refs = Array.isArray(party) && party.length
    ? party.filter(Boolean)
    : (await resolveDbParty()).map((m) => m.uuid);
  if (!refs.length) {
    ui.notifications?.error("[SIM] no party — the DB actor has no members, so pass `party: [uuid, …]`.");
    return null;
  }

  let clones = [];
  let result = null;

  try {
    SimMode.begin({ pace, reactions, expectedRounds, maxRounds });
    // Skill-under-test directives: resolve each caster to { name, uuid } so the
    // hands-free hook can match it on the field (PC clones carry a " [SIM]" suffix,
    // which the matcher strips). Registered AFTER begin() clears prior state.
    const directives = await normalizeScripts(scripts);
    if (directives.length) SimMode.setScripts(directives);
    Journal.begin(foundry.utils.randomID(), { pace, reactions, expectedRounds, phoenixFeathers, startingZp, fabulaPoints, scripts: directives.length });

    clones = await cloneParty(refs, startingZp, fabulaPoints);
    if (!clones.length) throw new Error("no party clones were created");
    await stockFeathers(clones, phoenixFeathers);

    const members = clones.map((c, i) => ({
      actorUuid: c.uuid, actorId: c.id, name: c.name, slot: i + 1, img: c.img,
    }));

    const payload = {
      context: { battleSceneUuid: scene.uuid, sourceSceneId: scene.id, lean: true },
      encounterPlan: { mode: "manual", manualPicks },
      party: { members },
    };

    const foeLabel = manualPicks.map((p) => `${p.name}×${p.quantity}`).join(" + ");
    SimMode.note("start", `${members.length} PC(s) vs ${foeLabel}`);
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
    let overtime = false;
    let stalled = false;

    for (;;) {
      const director = a.getActiveDirector?.() ?? globalThis.__fuDirector_lastInstance ?? null;
      const snap = snapshotCombat(director);

      if (snap) {
        final = snap;
        const sig = `${snap.round}|${snap.combatants.map((c) => `${c.name}:${c.hp}:${c.defeated}`).join(",")}`;
        if (sig !== lastSig) { lastSig = sig; lastProgress = Date.now(); }

        if (snap.ended) { SimMode.note("end", `combat ended in round ${snap.round}`); break; }

        // The design budget. Past this round the fight has failed to resolve
        // either way, which IS the finding — so stop and report it rather than
        // grinding on to the hard cap. (The Wandering Flame run that prompted
        // this would have run until the heat death of the universe: it absorbs
        // Hina's fire and out-heals the party's chip damage.)
        if (snap.round > expectedRounds) {
          overtime = true;
          SimMode.note("overtime", `still unresolved after the ${expectedRounds}-round budget — stopping`);
          break;
        }

        if (snap.round > maxRounds) { overtime = true; break; }   // absolute backstop
      }

      if (!a.isRunning?.()) { SimMode.note("end", "director stopped"); break; }

      if (Date.now() - lastProgress > STALL_TIMEOUT_MS) {
        stalled = true;
        SimMode.note("abort", `no progress for ${STALL_TIMEOUT_MS / 1000}s — aborting (a gate is probably still waiting on a human)`);
        break;
      }

      await sleep(POLL_MS);
    }

    // "overtime" outranks whatever the board happened to look like: a fight that
    // needed more than its budget is a design problem regardless of who was
    // ahead on HP when the buzzer went.
    const outcome = stalled ? "stalled" : overtime ? "overtime" : classify(final);
    const hpLeft = partyHpRemaining(final);
    result = {
      outcome,
      verdict: verdictFor(outcome, hpLeft, final?.round ?? 0, expectedRounds),
      rounds: final?.round ?? 0,
      partyHpRemaining: hpLeft,
      durationSec: Math.round((Date.now() - started) / 1000),
      combatants: final?.combatants ?? [],
      transcript: [...SimMode.transcript],
      config: { pace, reactions, expectedRounds, maxRounds, phoenixFeathers, startingZp, fabulaPoints },
    };

    try { result.journalPath = await Journal.flush({ outcome, rounds: result.rounds, partyHpRemaining: hpLeft }); } catch {}

    log(`[SIM] RESULT — ${outcome} in ${result.rounds} round(s); party at ${hpLeft == null ? "?" : Math.round(hpLeft * 100)}% HP (${result.durationSec}s wall)`);
    log(`[SIM] VERDICT — ${result.verdict}`);
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

// Escape hatch. Leaves sim mode FIRST (so the injected branches stop firing even
// if the director's teardown is slow), then stops the battle and sweeps the
// clones. Awaited properly — a fire-and-forget stop() left the director running
// the first time we needed this.
export async function abort() {
  const wasActive = forceEndSim("manual abort");
  try { if (api()?.isRunning?.()) await api().stop(); }
  catch (e) { warn("[SIM] abort: stop threw", e); }
  try {
    const folder = game.folders?.find((f) => f.type === "Actor" && f.name === SCRATCH_FOLDER);
    const ids = folder ? game.actors.filter((x) => x.folder?.id === folder.id).map((x) => x.id) : [];
    if (ids.length) await Actor.deleteDocuments(ids);
  } catch (e) { warn("[SIM] abort: clone sweep threw", e); }
  return wasActive;
}

// ── Scripted directives (skill-under-test) ───────────────────────────────────
// Normalize the `scripts` option into the shape SimMode + scripted-action.js
// expect: [{ match: { name, uuid }, skill, targets, force, once }]. Accepts either
//   - an array:  [{ caster, skill, targets, force, once }, …]
//   - an object: { "Hina": { skill: "Iceberg", targets: "enemy" }, "Zarg": "…" }
//                (a bare string value is shorthand for { skill: <string> })
// `caster` is a name or UUID; it is resolved so the on-field clone (which carries a
// " [SIM]" suffix) still matches by UUID or base name.
async function normalizeScripts(scripts) {
  if (!scripts) return [];
  const raw = Array.isArray(scripts)
    ? scripts
    : Object.entries(scripts).map(([caster, v]) =>
        typeof v === "string" ? { caster, skill: v } : { caster, ...v });

  const out = [];
  for (const d of raw) {
    if (!d?.skill) { warn("[SIM] script directive has no skill — skipped", d); continue; }
    const actor = d.caster ? await resolveActor(d.caster) : null;
    if (!actor && d.caster) warn(`[SIM] script caster not found: ${d.caster} — matching by name only`);
    out.push({
      match: { name: actor?.name ?? String(d.caster ?? ""), uuid: actor?.uuid ?? null },
      skill: String(d.skill),
      targets: d.targets ?? "enemy",
      force: d.force ?? null,
      once: !!d.once,
    });
  }
  return out;
}

// PC vs NPC — the same discriminator the sim panel uses (a player-owned actor with
// a main hand is a fightable PC; everything else is an NPC).
function isPcActor(actor) {
  const p = actor?.system?.props ?? {};
  return !!actor?.hasPlayerOwner && String(p.main_hand ?? "").trim() !== "";
}

// ── testSkill — the ergonomic skill-under-test entry point ───────────────────
// Force ONE combatant to cast ONE skill, in a live hands-free battle, and report
// what happened. The caster's side is inferred (PC → party, monster → enemy) and it
// is auto-placed on that side; you supply the opposition (the "dummy" to cast at).
//
//   await FUCompanion.api.experimental.sim.testSkill({
//     caster: "Hina",                       // a party PC (name or UUID)
//     skill:  "Iceberg",                    // a skill the caster owns (name or UUID)
//     enemy:  "Actor.someDummy",            // who to test against (single) …
//     // enemies: [{ uuid, quantity }],     // … or a full encounter group
//     targets: "enemy",                     // "enemy"|"enemies"|"self"|"allies"|[names/uuids]
//     force:   { crit: true },              // optional: crit|fumble|hit|miss|{rA,rB}
//     party:   ["Actor.otherPC", …],        // optional extra allies (default: just the caster)
//     pace: "fast", expectedRounds: 30,     // usual run knobs pass through
//   });
//
// For a MONSTER skill, name the boss as `caster`; it is placed on the enemy side and
// `party` becomes the dummies it casts at (defaults to the DB party). For anything
// more elaborate (multiple scripted casters, multi-round sequences) call `run` with
// a `scripts` array directly — that is the general form; this is the common case.
export async function testSkill({
  caster, skill, targets = "enemy", force = null, once = false,
  casterSide = null,          // "party" | "enemy" — override the inference
  enemy = null, enemies = null, quantity = 1,
  party = null,
  // Skill tests want to WATCH the skill land, not be cut short by a round budget —
  // so expectedRounds defaults high. Everything else mirrors `run`'s defaults.
  pace = "fast", reactions = "apply", expectedRounds = 30, maxRounds = 30,
  phoenixFeathers = 0, startingZp = 6, fabulaPoints = 3,
} = {}) {
  if (!caster || !skill) {
    ui.notifications?.error("[SIM] testSkill needs { caster, skill }.");
    return null;
  }
  const casterActor = await resolveActor(caster);
  if (!casterActor) { ui.notifications?.error(`[SIM] testSkill: caster not found: ${caster}`); return null; }

  const side = casterSide ?? (isPcActor(casterActor) ? "party" : "enemy");

  // Assemble the two sides so the caster is on `side` and the opposition exists.
  let enemyGroup = Array.isArray(enemies) && enemies.length
    ? enemies.map((g) => ({ uuid: g?.uuid ?? g, quantity: Math.max(1, Number(g?.quantity ?? 1) | 0) }))
    : (enemy ? [{ uuid: enemy, quantity: Math.max(1, Number(quantity) | 0) }] : []);
  let partyRefs = Array.isArray(party) && party.length ? party.filter(Boolean) : [];

  if (side === "party") {
    // Caster fights with the party; it must be cloned, so ensure it is in the set.
    if (!partyRefs.some((r) => sameActor(r, casterActor))) partyRefs = [casterActor.uuid, ...partyRefs];
    if (!enemyGroup.length) {
      ui.notifications?.error("[SIM] testSkill: give an `enemy` (or `enemies`) for the caster to test against.");
      return null;
    }
  } else {
    // Caster is a monster: it spawns on the enemy side, and the party are the dummies.
    if (!enemyGroup.some((g) => sameActor(g.uuid, casterActor))) enemyGroup = [{ uuid: casterActor.uuid, quantity: 1 }, ...enemyGroup];
    if (!partyRefs.length) partyRefs = (await resolveDbParty()).map((m) => m.uuid);
    if (!partyRefs.length) {
      ui.notifications?.error("[SIM] testSkill: a monster caster needs a `party` to cast at (none, and no DB party).");
      return null;
    }
  }

  return run({
    enemies: enemyGroup,
    party: partyRefs,
    pace, reactions, expectedRounds, maxRounds,
    phoenixFeathers, startingZp, fabulaPoints,
    scripts: [{ caster: casterActor.uuid, skill, targets, force, once }],
  });
}

// Loose actor-ref equality: a UUID string, a name, or an actor doc all compare to
// the same actor.
function sameActor(ref, actor) {
  if (!ref || !actor) return false;
  const s = typeof ref === "string" ? ref : (ref?.uuid ?? ref?.name ?? "");
  return s === actor.uuid || s === actor.id || String(s).trim().toLowerCase() === String(actor.name).trim().toLowerCase();
}
