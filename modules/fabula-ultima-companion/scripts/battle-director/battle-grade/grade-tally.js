// Battle Grade v2 — the per-battle tally. Runs on the BD host only.
//
// The battle log can't feed the grade: its rows carry no sides (dealer/target
// disposition is hard-coded "neutral"), most heals write no row, and buffs /
// statuses never reach it. So this collector listens to the Battle Director's
// own events and keeps a compact event list (grade-core.js turns it into the
// grade at battle end):
//
//   builtin settle reactor  every queued trigger, ledger family or not:
//                           creature_hit_by_action, creature_lose_resource,
//                           creature_gain_resource, creature_guards
//   Hooks createActiveEffect  director-applied effects (flag directorAppliedBy):
//                           buffs on allies, debuffs / statuses on enemies
//   Hooks fu-director-action  one "act" per declared action (first pass)
//
// Misses and affinity come from the battle record rows instead (they are the
// one thing the log does record well).
//
// Persistence: a world setting, written at most once a second (an action
// produces a burst of events), so an F5 mid-battle loses at most the last
// second. Lifecycle mirrors the battle record (director-battle-log.js):
// cleared by a fresh start(), after a battle ends, and before a follow-up
// ambush. A rewind drops the events from rounds after the restored round.

import { log, warn } from "../logger.js";
import { crisisThreshold } from "../crisis-reactor.js";

const NS = "fabula-ultima-companion";
const SETTING = "battleGradeTally";
const SAVE_MS = 1000;
const MAX_EVENTS = 4000;   // runaway guard

const SKIP_AE = new Set(["crisis", "ko", "defeated", "covered", "guard", "guarding"]);

let _t = null;         // in-memory tally
let _saveTimer = null;
let _rewindPending = false;

const blank = () => ({ v: 1, roster: {}, events: [], down: {}, killed: {}, seq: 0 });

Hooks.once("init", () => {
  try {
    game.settings.register(NS, SETTING, { scope: "world", config: false, type: Object, default: blank() });
  } catch (e) { warn("grade-tally: setting registration failed", e); }
});

const director = () => globalThis.FUCompanion?.api?.experimental?.battleDirector?.getActiveDirector?.() ?? null;
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const prop = (a, k) => a?.system?.props?.[k];

function load() {
  if (_t) return _t;
  let v = null;
  try { v = game.settings.get(NS, SETTING); } catch { v = null; }
  _t = (v && Array.isArray(v.events)) ? foundry.utils.deepClone(v) : blank();
  _t.roster ??= {}; _t.down ??= {}; _t.killed ??= {};
  return _t;
}

function scheduleSave() {
  if (!game.user?.isGM) return;
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => { _saveTimer = null; saveNow(); }, SAVE_MS);
}

async function saveNow() {
  if (!game.user?.isGM || !_t) return;
  try { await game.settings.set(NS, SETTING, _t); }
  catch (e) { warn("grade-tally: save failed", e); }
}

// ── Roster: every creature seen this battle (kept after a defeat removes it) ──

async function recipientOf(c) {
  try {
    const { isRewardRecipient } = await import("../battle-end/battle-end-rewards.js");
    return isRewardRecipient(c);
  } catch { return c?.side === "party"; }
}

async function syncRoster(d) {
  const t = load();
  const list = d?.dCombat?.combatants ?? [];
  let added = false;
  for (const c of list) {
    const key = c.actorUuid ?? c.tokenUuid;
    if (!key || t.roster[key]) continue;
    const a = c.actorDoc;
    t.roster[key] = {
      key, side: c.side === "enemy" ? "enemy" : "party",
      name: c.name ?? a?.name ?? "",
      actorUuid: c.actorUuid ?? null, tokenUuid: c.tokenUuid ?? null,
      level: num(prop(a, "level")), rank: String(prop(a, "npc_rank") ?? c.rank ?? "soldier"),
      activation: Math.max(1, num(prop(a, "activation"), 1)),
      maxHp: num(prop(a, "max_hp")),
      recipient: await recipientOf(c),
    };
    added = true;
  }
  if (added) scheduleSave();
}

function keyOf(uuid) {
  if (!uuid) return null;
  const t = load();
  if (t.roster[uuid]) return uuid;
  for (const r of Object.values(t.roster)) if (r.actorUuid === uuid || r.tokenUuid === uuid) return r.key;
  return null;
}
const sideOf = (key) => load().roster[key]?.side ?? null;

function push(ev) {
  const t = load();
  const d = director();
  ev.r = num(d?.dCombat?.round, 0);
  ev.id = ++t.seq;
  t.events.push(ev);
  if (t.events.length > MAX_EVENTS) t.events.splice(0, t.events.length - MAX_EVENTS);
  scheduleSave();
}

// ── The settle reactor ───────────────────────────────────────────────────────

export async function gradeTallyReactor(d, cfg) {
  if (!cfg?.trigger || !game.user?.isGM) return;
  const p = cfg.payload ?? {};
  await syncRoster(d);
  switch (cfg.trigger) {
    case "creature_hit_by_action": {
      const t = keyOf(p.subjectActorUuid ?? p.targetActorUuid), a = keyOf(p.causeActorUuid ?? p.attackerActorUuid);
      if (t && a && sideOf(t) !== sideOf(a)) push({ k: "hit", a, t });
      break;
    }
    case "creature_lose_resource": {
      if (String(p.resource) !== "hp") break;
      const t = keyOf(p.subjectActorUuid ?? p.sourceActorUuid), a = keyOf(p.causeActorUuid);
      if (!t) break;
      const amount = num(p.amount);
      if (p.isDamage) push({ k: "dmg", a, t, v: amount, c: !!p.isCrit, di: p.damageInstance ?? null, dmg: true });
      // Down / defeated: the snapshot is the subject BEFORE this loss (a killed
      // soldier's token is gone by the time the event runs).
      const before = num(p.subjectSnapshot?.hp, NaN);
      let after = Number.isFinite(before) ? before - amount : NaN;
      if (!Number.isFinite(after)) {
        try { after = num(prop(cfg.casterActor, "current_hp"), NaN); } catch { after = NaN; }
      }
      const tl = load();
      if (Number.isFinite(after) && after <= 0) {
        if (sideOf(t) === "party" && !tl.down[t]) { tl.down[t] = true; push({ k: "ko", t, a }); }
        if (sideOf(t) === "enemy" && !tl.killed[t]) { tl.killed[t] = true; push({ k: "kill", t, a }); }
      }
      break;
    }
    case "creature_gain_resource": {
      const t = keyOf(p.subjectActorUuid ?? p.sourceActorUuid), a = keyOf(p.causeActorUuid);
      if (!t) break;
      const res = String(p.resource);
      if (res === "hp") {
        const tl = load();
        if (tl.down[t]) tl.down[t] = false;           // revived / healed back up
        if (!a) break;
        const amount = num(p.amount);
        const requested = num(p.requested, amount);
        const pre = Number.isFinite(Number(p.preValue)) ? Number(p.preValue) : NaN;
        let cr = false;
        try { const at = crisisThreshold(cfg.casterActor); cr = at != null && Number.isFinite(pre) && pre <= at; } catch { cr = false; }
        push({ k: "heal", a, t, v: amount, o: Math.max(0, requested - amount), cr });
      } else if (res === "mp" && a) {
        push({ k: "mp", a, t, v: num(p.amount) });
      }
      break;
    }
    case "creature_guards": {
      const a = keyOf(p.guarderActorUuid ?? p.sourceActorUuid);
      if (a) push({ k: "guard", a, cover: !!p.didCoverAlly });
      break;
    }
    default: break;
  }
}

// ── Hooks ────────────────────────────────────────────────────────────────────

Hooks.on("fu-director-action", (info) => {
  try {
    const d = director();
    if (!d || !game.user?.isGM) return;
    syncRoster(d).then(() => {
      const a = keyOf(info?.actorUuid);
      if (!a) return;
      const tg = (info?.targetTokenUuids ?? []).map(keyOf).filter(Boolean);
      push({ k: "act", a, ak: info?.actionKind ?? null, tg });
    }).catch((e) => warn("grade-tally: act failed", e));
  } catch (e) { warn("grade-tally: fu-director-action threw", e); }
});

Hooks.on("createActiveEffect", (eff) => {
  try {
    const d = director();
    if (!d || !game.user?.isGM) return;
    const by = eff?.flags?.[NS]?.directorAppliedBy;
    if (!by?.reactorActorUuid) return;
    const name = String(eff.name ?? eff.label ?? "").trim().toLowerCase();
    if (SKIP_AE.has(name)) return;
    // Conflict-start passives (Protect, Prophetic Defender, …) fire on their own
    // before anyone acts; they are not play, so they don't feed the grade. A
    // Free Round's actions log "act" first, so their effects still count.
    if (!load().events.some((e) => e.k === "act")) return;
    const a = keyOf(by.reactorActorUuid) ?? keyOf(by.reactorTokenUuid);
    const host = eff.parent;
    const t = keyOf(host?.uuid) ?? keyOf(host?.token?.uuid ?? null);
    if (!a || !t) return;
    const tags = Array.isArray(eff.system?.tags) ? eff.system.tags.map((x) => String(x).toLowerCase()) : [];
    push({ k: "ae", a, t, buff: !tags.includes("debuff"), n: eff.name ?? "" });
  } catch (e) { warn("grade-tally: createActiveEffect threw", e); }
});

// Rewind: stop(reason "rewind") then a resume fires fu-director-started. Drop
// what happened after the restored round.
Hooks.on("fu-director-stopped", (info) => { if (info?.reason === "rewind") _rewindPending = true; });
Hooks.on("fu-director-started", (d) => {
  if (!_rewindPending) return;
  _rewindPending = false;
  try {
    const t = load();
    const round = num(d?.dCombat?.round, 0);
    const before = t.events.length;
    t.events = t.events.filter((e) => num(e.r) <= round);
    // Rebuild the down / killed latches from what is left.
    t.down = {}; t.killed = {};
    for (const e of t.events) {
      if (e.k === "ko") t.down[e.t] = true;
      if (e.k === "kill") t.killed[e.t] = true;
      if (e.k === "heal") t.down[e.t] = false;
    }
    log(`grade-tally: rewind to round ${round} dropped ${before - t.events.length} event(s)`);
    scheduleSave();
  } catch (e) { warn("grade-tally: rewind trim failed", e); }
});

// ── API ──────────────────────────────────────────────────────────────────────

/** The current battle's tally (roster + events), refreshed from the live roster. */
export async function readTally() {
  const d = director();
  if (d) await syncRoster(d);
  return foundry.utils.deepClone(load());
}

export async function clearTally() {
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  _t = blank();
  _rewindPending = false;
  if (game.user?.isGM) {
    try { await game.settings.set(NS, SETTING, _t); } catch (e) { warn("grade-tally: clear failed", e); }
  }
}

Hooks.once("ready", () => {
  globalThis.FUCompanion = globalThis.FUCompanion || {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
  globalThis.FUCompanion.api.battleGrade = Object.assign(globalThis.FUCompanion.api.battleGrade ?? {}, { readTally, clearTally });
});
