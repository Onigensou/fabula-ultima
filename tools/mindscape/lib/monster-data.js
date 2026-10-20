"use strict";
//
// Mindscape — the monster-data interpreter.
//
// WHY THIS EXISTS
// Until 2026-10-20 every monster mechanic Mindscape knew about was a hand-written
// registry entry (reactions.js) or a stance inference (stances.js). Each one was a
// transcription of a passive's text, written after somebody noticed it was missing:
// the Electro Slime's death burst, Drako Fury, the Gigas' Oaf. A transcription is
// only as good as the noticing, and the noticing was being done by the designer,
// fight by fight. The game itself never needed any of that — the Battle Director
// reads the same three tables off every monster:
//
//   reaction_config_table   WHEN something happens (trigger, scope, condition)
//   effect_table            WHAT happens (chains of effect rows)
//   action_pattern_table    WHICH action the monster picks on its turn
//
// plus the status templates those effects apply. This module reads them the way the
// Battle Director does, so a monster built in the game plays in the sim with nothing
// written for the sim's benefit.
//
// SOURCES (read 2026-10-20, transcribed rather than paraphrased):
//   action pick      action-reader/actionReader-matchAndPickAction.js
//                    (gating → HP reserve/ceiling → feasibility → priority window
//                     3/2/1 → cooldown hard-block / repeat ×0.3 → weighted pick)
//   row conditions   action-reader/actionReader-evaluateConditions.js
//   target focus     action-reader/actionReader-buildAndPickTargets.js focusWeightFor
//   status lifetimes battle-director/skill-effects.js (tickDirectorAEs*, chargeTickFor)
//   action gating    battle-director/snapshot.js getBlockedActionLabels
//   on-use effect    skill props `on_activate_effect_ref` (state-handlers RESOLVE step 3)
//
// WHAT IT DOES NOT DO, stated rather than hidden: anything it cannot interpret is
// recorded as a GAP (state.dataGaps, and statically by coverage()) with the monster
// and the exact kind / identifier / trigger, never silently approximated. Player
// prompts ("ask" reactions, open_action_menu, redirect_target) are gaps by design:
// they are decisions a person makes at the table.

const NS = "fabula-ultima-companion";
const ELEMENTS = ["physical", "air", "bolt", "dark", "earth", "fire", "ice", "light", "poison"];
const AFF_BY_INDEX = { 1: "physical", 2: "air", 3: "bolt", 4: "dark", 5: "earth", 6: "fire", 7: "ice", 8: "light", 9: "poison" };
const AFF_RANK = { VU: -1, NE: 0, RS: 1, IM: 2, AB: 3 };
const ATTRS = ["dex", "ins", "mig", "wlp"];
const MAX_DEPTH = 6;          // reaction-in-reaction guard; the game has none, but a loop must end
const DIE = [4, 6, 8, 10, 12, 20];

const s = (v) => String(v ?? "").trim();
const norm = (v) => s(v).toLowerCase();
// AE_COUNT_FIRE_MARK -> "fire mark"; "Sword and Bow Stance" -> "sword and bow stance".
const key = (v) => norm(v).replace(/[^a-z0-9]+/g, " ").trim();
const rows = (t) => (t && typeof t === "object" ? (Array.isArray(t) ? t : Object.values(t)) : [])
  .filter((r) => r && typeof r === "object" && r.$deleted !== true);
const list = (v) => s(v).split(",").map((x) => x.trim()).filter(Boolean);

// ── Expression evaluator ────────────────────────────────────────────────────
// The sheet's formula language: numbers, identifiers, calls, arithmetic, comparison,
// && || ! and ?:. A real parser rather than `new Function`, so the same code runs in
// the Balance Board page. Unknown identifiers THROW — the caller records the gap.
function tokenize(src) {
  const out = [];
  const re = /\s*(\d+(?:\.\d+)?|[A-Za-z_][A-Za-z0-9_]*|&&|\|\||==|!=|<=|>=|[-+*/%<>!(),?:])/y;
  let m, i = 0;
  while (i < src.length) {
    re.lastIndex = i;
    m = re.exec(src);
    if (!m) { if (/^\s*$/.test(src.slice(i))) break; throw new Error(`cannot read formula "${src}"`); }
    out.push(m[1]);
    i = re.lastIndex;
  }
  return out;
}

const BIN = { "||": 1, "&&": 2, "==": 3, "!=": 3, "<": 4, "<=": 4, ">": 4, ">=": 4, "+": 5, "-": 5, "*": 6, "/": 6, "%": 6 };

function parse(tokens) {
  let p = 0;
  const peek = () => tokens[p];
  const next = () => tokens[p++];
  function primary() {
    const t = next();
    if (t == null) throw new Error("formula ends early");
    if (t === "(") { const e = ternary(); if (next() !== ")") throw new Error("missing )"); return e; }
    if (t === "-") return { op: "neg", a: primary() };
    if (t === "+") return primary();
    if (t === "!") return { op: "not", a: primary() };
    if (/^\d/.test(t)) return { num: Number(t) };
    if (/^[A-Za-z_]/.test(t)) {
      if (peek() === "(") {
        next();
        const args = [];
        if (peek() !== ")") { do { args.push(ternary()); } while (peek() === "," && next()); }
        if (next() !== ")") throw new Error(`missing ) after ${t}(`);
        return { call: t, args };
      }
      return { id: t };
    }
    throw new Error(`unexpected "${t}"`);
  }
  function binary(minPrec) {
    let left = primary();
    for (;;) {
      const op = peek();
      const prec = BIN[op];
      if (!prec || prec < minPrec) return left;
      next();
      left = { op, a: left, b: binary(prec + 1) };
    }
  }
  function ternary() {
    const c = binary(1);
    if (peek() !== "?") return c;
    next();
    const a = ternary();
    if (next() !== ":") throw new Error("missing : in ?:");
    return { op: "?:", c, a, b: ternary() };
  }
  const e = ternary();
  if (p < tokens.length) throw new Error(`unexpected "${tokens[p]}"`);
  return e;
}

const FUNCS = {
  ceil: Math.ceil, floor: Math.floor, round: Math.round, abs: Math.abs,
  min: Math.min, max: Math.max,
};

function run(node, scope) {
  if ("num" in node) return node.num;
  if ("id" in node) return scope.id(node.id);
  if (node.call) {
    const args = node.args.map((x) => run(x, scope));
    if (node.call === "chance") return scope.chance(args[0]);
    const f = FUNCS[node.call];
    if (!f) { const e = new Error(`unknown function ${node.call}()`); e.gap = `function ${node.call}()`; throw e; }
    return f(...args);
  }
  switch (node.op) {
    case "neg": return -run(node.a, scope);
    case "not": return run(node.a, scope) ? 0 : 1;
    case "?:": return run(node.c, scope) ? run(node.a, scope) : run(node.b, scope);
    case "&&": return run(node.a, scope) && run(node.b, scope) ? 1 : 0;
    case "||": return run(node.a, scope) || run(node.b, scope) ? 1 : 0;
  }
  const a = run(node.a, scope), b = run(node.b, scope);
  switch (node.op) {
    case "+": return a + b; case "-": return a - b; case "*": return a * b;
    case "/": return b === 0 ? 0 : a / b; case "%": return b === 0 ? 0 : a % b;
    case "==": return a === b ? 1 : 0; case "!=": return a !== b ? 1 : 0;
    case "<": return a < b ? 1 : 0; case "<=": return a <= b ? 1 : 0;
    case ">": return a > b ? 1 : 0; case ">=": return a >= b ? 1 : 0;
  }
  throw new Error(`bad operator ${node.op}`);
}

const PARSED = new Map();
function compile(src) {
  let n = PARSED.get(src);
  if (!n) { n = parse(tokenize(src)); PARSED.set(src, n); }
  return n;
}

// Identifiers a formula names, for the static coverage report.
function identifiers(src) {
  const out = new Set();
  try {
    (function walk(n) {
      if (!n) return;
      if ("id" in n) out.add(n.id);
      if (n.call) { if (!FUNCS[n.call] && n.call !== "chance") out.add(`${n.call}()`); n.args.forEach(walk); }
      for (const k of ["a", "b", "c"]) if (n[k]) walk(n[k]);
    })(compile(src));
  } catch { out.add(`unreadable:${src}`); }
  return [...out];
}

// ── Status templates ────────────────────────────────────────────────────────
function toTemplate(eff) {
  if (!eff) return null;
  const f = eff.flags?.[NS] ?? {};
  const rc = f.reactionConfig;
  return {
    name: s(eff.name),
    changes: (eff.changes ?? []).map((c) => ({ key: s(c.key), value: s(c.value), mode: Number(c.mode) })),
    lifetime: norm(f.lifetimeMode),
    charges: f.charges == null || f.charges === "" ? null : Number(f.charges),
    chargesMax: f.chargesMax == null || f.chargesMax === "" ? null : Number(f.chargesMax),
    permanent: f.directorPermanent === true,
    riderOf: f.riderOf ? s(f.riderOf) : null,
    reciprocal: f.reciprocalAe ? s(f.reciprocalAe) : null,
    tags: (Array.isArray(eff.system?.tags) ? eff.system.tags : []).map(norm).filter(Boolean),
    chargeKey: f.chargeKey ? norm(f.chargeKey) : null,
    reaction: rc ? {
      rows: rows(rc.reaction_config_table),
      effects: rows(rc.effect_table ?? rc.reaction_effect_table),
    } : null,
  };
}

// The world's status library: every effect on an `activeEffectContainer` item, first
// name wins (skill-effects resolveAeTemplate step 3 takes the first match too).
function buildStatusLibrary(worldItems) {
  const lib = {};
  for (const it of worldItems) {
    if (it.type !== "activeEffectContainer") continue;
    for (const e of it.effects ?? []) {
      const t = toTemplate(e);
      if (t?.name && !lib[t.name]) lib[t.name] = t;
    }
  }
  return lib;
}

// ── Per-combatant setup ─────────────────────────────────────────────────────
function itemModel(it) {
  const p = it.props ?? {};
  const effects = rows(p.effect_table);
  return {
    name: s(it.name),
    skillType: norm(p.skill_type),
    props: p,
    table: new Map(effects.map((r) => [s(r.effect_label), r])),
    reactionRows: rows(p.reaction_config_table),
    onActivate: s(p.on_activate_effect_ref),
    templates: (it.effects ?? []).map(toTemplate).filter(Boolean),
  };
}

const ACTION_TYPES = new Set(["attack", "spell", "active", "skill"]);

// `dataDriven`: this combatant's own items drive its reactions and action choice.
// Every combatant gets a status list — a PC can be Burning, Wet or Charmed.
// `reactionsOnly` (a PC under the data rules): its items' automatic reaction rows run,
// but its turn is still the party policy's, and its skills' on-use chains are not run
// (the policy scripts those). `skipItems`: names the policy already plays.
function attach(c, { dataDriven = false, reactionsOnly = false, skipItems = null, library = null } = {}) {
  c.aes = [];
  c.vars = {};
  c.md = null;
  if (!dataDriven && !reactionsOnly) return;
  const skip = new Set([...(skipItems ?? [])].map(key));
  const items = (c.actor.items ?? []).filter((it) => !skip.has(key(it.name))).map(itemModel);
  c.md = {
    items,
    byName: new Map(items.map((i) => [key(i.name), i])),
    patterns: rows(c.actor._rawProps?.action_pattern_table).map((r) => ({
      name: s(r.action_pattern_name),
      condition: norm(r.action_pattern_condition) || "always",
      string: s(r.action_pattern_string),
      v1: r.action_pattern_value_1, v2: r.action_pattern_value_2,
      priority: Number.isFinite(Number(r.action_pattern_priority)) && s(r.action_pattern_priority) !== "" ? Math.trunc(Number(r.action_pattern_priority)) : 5,
      focus: norm(r.action_pattern_target_focus) || "auto",
      focusStatus: s(r.action_pattern_focus_status),
      cooldown: Math.trunc(Number(r.action_pattern_cooldown) || 0),
      hpReserve: Math.trunc(Number(r.action_pattern_hp_reserve) || 0),
      hpCeiling: Math.trunc(Number(r.action_pattern_hp_ceiling) || 0),
    })).filter((r) => r.name),
    memory: { last: null, used: {} },
    reactionsOnly,
  };
  if (reactionsOnly) c.md.patterns = [];
  c.library = library;
}

// ── Status (AE) state ───────────────────────────────────────────────────────
function aesNamed(c, name) {
  const k = key(name);
  return (c.aes ?? []).filter((a) => key(a.name) === k);
}
function hasAe(c, name) { return aesNamed(c, name).length > 0; }
function aeCharges(c, name) {
  return aesNamed(c, name).reduce((t, a) => t + (a.charges == null ? 1 : a.charges), 0);
}

// Crisis is a state, not an AE, in this model: HP at or under half.
const inCrisis = (c) => c.alive && c.hp > 0 && c.hp <= c.maxHp / 2;

function resolveTemplate(state, name, item, holder) {
  // "Actor.<id>.Item.<id>.ActiveEffect.<id>" / "Item.<id>.ActiveEffect.<id>": by id.
  const u = /Item\.([^.]+)\.ActiveEffect\.([^.]+)$/.exec(s(name));
  if (u) {
    for (const c of [holder, ...(state.combatants ?? [])]) {
      const it = (c?.actor?.items ?? []).find((i) => i.id === u[1]);
      const eff = (it?.effects ?? []).find((e) => e._id === u[2] || e.id === u[2]);
      if (eff) return toTemplate(eff);
    }
  }
  const k = key(name);
  for (const t of item?.templates ?? []) if (key(t.name) === k) return t;
  const lib = state.statusLibrary ?? {};
  for (const [n, t] of Object.entries(lib)) if (key(n) === k) return t;
  // Last resort: any template on the acting creature's own items (the game would
  // not look here, so a hit is reported — but the status is real).
  for (const it of holder?.md?.items ?? []) for (const t of it.templates) if (key(t.name) === k) { gap(state, holder, "template", `${name} (found on another of its skills)`); return t; }
  return null;
}

function addAe(state, target, tpl, { applier = null, mode = "replace", charges = null, rounds = null } = {}) {
  const existing = aesNamed(target, tpl.name);
  if (existing.length && mode === "skip") return false;
  let initial = charges != null ? charges : (rounds != null ? rounds : tpl.charges);
  if (existing.length && mode === "add_charges") {
    const add = charges != null ? charges : (tpl.charges ?? 1);
    const a = existing[0];
    a.charges = (a.charges ?? 0) + add;
    if (tpl.chargesMax != null && tpl.chargesMax > 0) a.charges = Math.min(a.charges, tpl.chargesMax);
    refreshDerived(target);
    return true;
  }
  if (existing.length) target.aes = target.aes.filter((a) => !existing.includes(a));
  if (initial != null && !Number.isFinite(initial)) initial = tpl.charges;
  state._statusApplied = state._statusApplied ?? [];
  state._statusApplied.push({ target, applier, name: tpl.name });
  target.aes.push({
    name: tpl.name, template: tpl, charges: initial,
    lifetime: rounds != null && !tpl.lifetime ? "" : tpl.lifetime,
    applier, appliedRound: state.round,
  });
  // Reciprocal statuses (Grappled on the victim -> Grappling on the grappler).
  if (tpl.reciprocal && applier && applier !== target) {
    const r = resolveTemplate(state, tpl.reciprocal, null, applier);
    if (r && !hasAe(applier, r.name)) applier.aes.push({ name: r.name, template: r, charges: r.charges, lifetime: r.lifetime, applier: target, appliedRound: state.round });
    refreshDerived(applier);
  }
  refreshDerived(target);
  return true;
}

function removeAes(target, predicate, count = Infinity) {
  let n = 0;
  const removed = [];
  target.aes = target.aes.filter((a) => {
    if (n < count && predicate(a)) { n++; removed.push(a.name); return false; }
    return true;
  });
  // A rider goes with its host (Deadly Temptation rides Charmed).
  const gone = new Set(removed.map(key));
  if (gone.size) target.aes = target.aes.filter((a) => !(a.template.riderOf && gone.has(key(a.template.riderOf))));
  refreshDerived(target);
  return removed;
}

// Flags the engine reads directly.
// A data-driven creature's Flying / Delay ARE its statuses (Mana Ray's conflict_start
// apply_ae Flying, the Gigas' Oaf Delay); anyone else keeps the registry traits.
function refreshDerived(c) {
  if (!c.md) return;
  c.flying = hasAe(c, "Flying");
  c.delay = hasAe(c, "Delay");
}

// What every carried status does to its bearer, folded from the template changes.
function changesOf(c) {
  const out = [];
  for (const a of c.aes ?? []) for (const ch of a.template.changes) out.push({ ...ch, ae: a });
  return out;
}

// Die-size steps: `bonus_dex=-2` (Slow) is one die down, `dex_current=2` (Swift) one up.
function attrSteps(c) {
  const steps = { dex: 0, ins: 0, mig: 0, wlp: 0 };
  for (const ch of changesOf(c)) {
    const m = /^(?:bonus_(dex|ins|mig|wlp)|(dex|ins|mig|wlp)_current)$/.exec(ch.key);
    if (!m) continue;
    const v = Number(ch.value);
    if (Number.isFinite(v)) steps[m[1] ?? m[2]] += v / 2;
  }
  return steps;
}

function applyAttrSteps(attrs, c) {
  if (!c.aes?.length) return attrs;
  const st = attrSteps(c);
  const out = { ...attrs };
  for (const k of ATTRS) {
    if (!st[k] || out[k] == null) continue;
    const i = DIE.indexOf(out[k]);
    if (i < 0) continue;
    const j = Math.max(st[k] < 0 ? 1 : 0, Math.min(DIE.length - 2, i + Math.trunc(st[k])));
    out[k] = DIE[j];
  }
  return out;
}

function checkMod(c, action) {
  let m = 0;
  for (const ch of changesOf(c)) {
    const v = Number(ch.value);
    if (!Number.isFinite(v)) continue;
    if (ch.key === "check_mod_all" || ch.key === "check_mod_accuracy") m += v;
    else if (ch.key === "check_mod_magic" && action?.defenseTarget === "mdef") m += v;
  }
  return m;
}

// DEF / MDEF after statuses. CSB change modes: 1 multiply, 2 add, 5 override.
function defense(c, lane) {
  const base = lane === "mdef" ? c.actor.mdef : c.actor.def;
  let v = base;
  for (const ch of changesOf(c)) {
    const isDef = /^(defense|def|current_def)$/.test(ch.key), isMdef = /^(magic_defense|mdef|current_mdef)$/.test(ch.key);
    if (!(lane === "mdef" ? isMdef : isDef)) continue;
    const n = Number(ch.value);
    if (!Number.isFinite(n)) continue;
    if (ch.mode === 1 || (ch.mode !== 2 && ch.mode !== 5 && n > 0 && n < 1)) v = Math.floor(v * n);
    else if (ch.mode === 5) v = n;
    else v += n;
  }
  if (c.armorHidden && lane === "def") v = Math.max(0, v - (c.armorHidden.def ?? 0));
  if (c.armorHidden && lane === "mdef") v = Math.max(0, v - (c.armorHidden.mdef ?? 0));
  return v;
}

// Affinities after statuses: Wet makes Bolt VU, Illusory Form floors Physical at RS.
function affinities(c) {
  if (!c.aes?.length) return c.actor.affinities;
  let out = null;
  for (const ch of changesOf(c)) {
    const m = /^affinity_(\d)$/.exec(ch.key);
    if (!m) continue;
    const el = AFF_BY_INDEX[m[1]];
    if (!el) continue;
    out = out ?? { ...c.actor.affinities };
    const floor = /aeAffinityFloor\("?(VU|NE|RS|IM|AB)"?\)/i.exec(ch.value);
    if (floor) {
      const want = floor[1].toUpperCase();
      if ((AFF_RANK[out[el]] ?? 0) < AFF_RANK[want]) out[el] = want;
    } else if (/^(VU|NE|RS|IM|AB)$/i.test(ch.value)) out[el] = ch.value.toUpperCase();
  }
  return out ?? c.actor.affinities;
}

// Turn-action labels the bearer may not use (snapshot.js getBlockedActionLabels).
const GATEABLE = ["Attack", "Spell", "Skill", "Guard", "Study", "Objective", "Equipment", "Item"];
function canonLabel(l) { const x = norm(l); return GATEABLE.find((g) => g.toLowerCase() === x) ?? null; }
function blockedLabels(c) {
  const out = new Set();
  for (const ch of changesOf(c)) {
    if (ch.key === "disable_action") for (const l of ch.value.split(/[\s,]+/)) { const L = canonLabel(l); if (L) out.add(L); }
    else if (ch.key === "enable_action_only") {
      const allow = new Set(ch.value.split(/[\s,]+/).map(canonLabel));
      for (const g of GATEABLE) if (!allow.has(g)) out.add(g);
    }
  }
  return out;
}
function actionLabel(action) {
  if (action?.basicAttack || action?.virtual) return "Attack";
  const t = norm(action?.skillType);
  if (t === "attack") return "Attack";
  if (t === "spell") return "Spell";
  return "Skill";
}
function isBlocked(c, action) {
  if (!c.aes?.length) return false;
  return blockedLabels(c).has(actionLabel(action));
}

// Charmed: may not target the caster. Domination / Deadly Temptation: fights for the
// other side.
function cannotTarget(c) {
  const out = new Set();
  for (const ch of changesOf(c)) if (ch.key === "cannot_target_uuids" && ch.ae.applier) out.add(ch.ae.applier);
  return out;
}
function turnedAgainst(c) {
  return changesOf(c).some((ch) => ch.key === "allegiance_override");
}
function healFactor(c) {
  let f = 1;
  for (const ch of changesOf(c)) if (ch.key === "heal_receiving_mod_all") { const v = Number(ch.value); if (Number.isFinite(v)) f += v; }
  return Math.max(0, f);
}

// ── Lifetimes ───────────────────────────────────────────────────────────────
// lifetimeMode ""           ticks at the APPLIER's turn start (the 3-turn default)
//              target_turn_end / target_turn_start   the bearer's own turn
//              applier_turn_end
//              round_end    gone at the end of the round
//              on_activation / persistent_counter    spent by use, never ticked
// No charge counter, or directorPermanent: lasts the conflict.
function tick(state, c, a) {
  if (a.template.permanent || a.charges == null) return;
  a.charges -= 1;
  if (a.charges <= 0) removeAes(c, (x) => x === a, 1);
}

function forEachAe(state, fn) {
  for (const c of state.combatants) for (const a of [...(c.aes ?? [])]) fn(c, a);
}

function onTurnStart(state, actor) {
  forEachAe(state, (c, a) => {
    if (c === actor && a.lifetime === "target_turn_start") tick(state, c, a);
    else if (a.applier === actor && a.lifetime === "") tick(state, c, a);
  });
}
function onTurnEnd(state, actor) {
  forEachAe(state, (c, a) => {
    if (c === actor && a.lifetime === "target_turn_end") tick(state, c, a);
    else if (a.applier === actor && a.lifetime === "applier_turn_end") tick(state, c, a);
  });
}
// creature_status_applied fires once the application has settled (Skull Orb).
function flushStatusApplied(state) {
  const list = state._statusApplied;
  if (!list?.length || !state.mdApi) return;
  state._statusApplied = [];
  for (const x of list) emit(state, "creature_status_applied", { subject: x.target, victim: x.target, actor: x.applier, causeActor: x.applier, status: x.name });
}

function onRoundEnd(state) {
  for (const c of state.combatants) if (c.aes?.length) removeAes(c, (a) => a.lifetime === "round_end");
}

// ── Gaps ────────────────────────────────────────────────────────────────────
function gap(state, who, kind, what) {
  if (!state) return;
  const k = `${who?.name ?? "?"}|${kind}|${what}`;
  state.dataGaps = state.dataGaps ?? {};
  state.dataGaps[k] = (state.dataGaps[k] ?? 0) + 1;
}

// ── Formula scope ───────────────────────────────────────────────────────────
// `ctx` carries the reactor (whose sheet CUR_HP etc. read), the triggering event, the
// current target of a per-target evaluation, and chain variables.
function relation(a, b) { return a === b ? "self" : a.side === b.side ? "ally" : "enemy"; }
function sideOf(c) { return c.side; }
// Objects (a Lightning Crystal) are invisible to the AI: never a target, never counted
// (actionReader-core isUntargetableActor).
function livingFoesOf(state, c) { return state.combatants.filter((x) => x.alive && !x.object && sideOf(x) !== sideOf(c)); }
function livingAlliesOf(state, c) { return state.combatants.filter((x) => x.alive && !x.object && x !== c && sideOf(x) === sideOf(c)); }

function evalFormula(state, src, ctx, { fallback = 0 } = {}) {
  const raw = s(src);
  if (!raw || raw === "-") return fallback;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  const me = ctx.reactor;
  const ev = ctx.ev ?? {};
  const tgt = ctx.target ?? null;
  const scope = {
    chance: (p) => (state.rng.float() * 100 < Number(p) ? 1 : 0),
    id(name) {
      const N = name.toUpperCase();
      switch (N) {
        case "CUR_HP": return me.hp;
        case "MAX_HP": return me.maxHp;
        case "CUR_MP": return me.mp;
        case "MAX_MP": return me.actor.mp.max ?? me.mp;
        case "CUR_IP": return me.ip;
        case "TARGET_CURRENT_HP": case "TARGET_CUR_HP": return tgt ? tgt.hp : 0;
        case "TARGET_MAX_HP": return tgt ? tgt.maxHp : 0;
        case "TARGET_CURRENT_MP": case "TARGET_CUR_MP": return tgt ? tgt.mp : 0;
        case "TARGET_MAX_MP": return tgt ? (tgt.actor.mp.max ?? tgt.mp) : 0;
        case "HP_DEALT": case "DAMAGE_DEALT": case "TRIGGER_AMOUNT": return Number(ev.amount) || 0;
        case "INCOMING_DAMAGE": return Number(ev.incoming) || 0;
        case "ATTACK_CHECK_RESULT": return Number(ev.checkResult) || 0;
        case "TRIGGER_IS_SELF": return ev.actor === me ? 1 : 0;
        case "SUBJECT_IS_SELF": return ev.subject === me ? 1 : 0;
        case "CAUSE_IS_SELF": return ev.causeActor === me ? 1 : 0;
        case "IS_MY_TURN": return state.activeActor === me ? 1 : 0;
        case "ENEMY_IN_CRISIS": return livingFoesOf(state, me).some(inCrisis) ? 1 : 0;
        case "ALLY_COUNT": return livingAlliesOf(state, me).length;
        case "ENEMY_COUNT": return livingFoesOf(state, me).length;
        case "ROUND": return state.round;
        case "ACTION_TARGET_COUNT": return Math.max(1, Number(ctx.actionTargetCount) || 1);
        case "RANK_IS_CHAMPION": return /champion/i.test(s(me.actor.rank ?? me.actor._rawProps?.npc_rank)) ? 1 : 0;
        case "CHAR_LEVEL": case "LEVEL": return Number(me.actor.level) || 0;
        // The action in progress (performs / will deal / deals / completes).
        case "ACTION_IS_ATTACK": return ev.action && actionLabel(ev.action) === "Attack" ? 1 : 0;
        case "ACTION_IS_SPELL": return ev.action && actionLabel(ev.action) === "Spell" ? 1 : 0;
        case "ACTION_IS_SKILL": return ev.action && actionLabel(ev.action) === "Skill" ? 1 : 0;
        case "ATTACK_IS_RANGED": return ev.action && actionLabel(ev.action) === "Attack" && isRanged(ev.actor, ev.action) ? 1 : 0;
        case "ATTACK_IS_MELEE": return ev.action && actionLabel(ev.action) === "Attack" && !isRanged(ev.actor, ev.action) ? 1 : 0;
        case "SINGLE_TARGET_ATTACK": return ev.action && actionLabel(ev.action) === "Attack" && (ev.targets?.length ?? ev.action.target?.count ?? 1) === 1 ? 1 : 0;
        case "ACTION_TARGET_COUNT": return Math.max(1, Number(ctx.actionTargetCount ?? ev.targets?.length) || 1);
        case "ACTION_IS_FREE_CAST": return ev.free ? 1 : 0;
        // Skill Level of the item carrying the row (formula.js reads SL_<NAME> the same way).
        case "SL": return Math.max(1, Number(ctx.item?.props?.level ?? ctx.item?.props?.skill_level) || 1);
        case "TARGET_STATUS_COUNT": { const t = tgt ?? ev.victim; return t ? (t.aes ?? []).length : 0; }
        case "HAS_ARCANE_WEAPON": return norm(me.actor.weapon?.family) === "arcane" ? 1 : 0;
        case "CREATURE_ELEMENTAL_PRESENT": return state.combatants.some((c) => c.alive && /elemental/i.test(s(c.actor.species))) ? 1 : 0;
        // Summons as the model has them: the party's phantasms are a count (party-policy.js),
        // a summoned monster knows its summoner; nothing else is ever summoned in the sim.
        case "OWN_PHANTASM_COUNT": return Number(me.phantasms) || 0;
        case "OWN_MINION_COUNT": case "OWN_NUMEN_COUNT": case "OWN_SUMMON_COUNT": return state.combatants.filter((c) => c.alive && c.summonedBy === me).length;
        case "SUBJECT_IS_MY_SUMMON": case "SUBJECT_IS_MY_PHANTASM": case "SUBJECT_IS_MY_MINION": return ev.subject?.summonedBy === me ? 1 : 0;
      }
      let m;
      if ((m = /^HAS_WEAPON_CATEGORY_(.+)$/.exec(N))) return norm(me.actor.weapon?.family) === m[1].toLowerCase() ? 1 : 0;
      if ((m = /^TARGET_SPECIES_IS_(.+)$/.exec(N))) { const t = tgt ?? ev.victim; return t && norm(t.actor.species) === m[1].toLowerCase() ? 1 : 0; }
      if ((m = /^ANY_TARGET_HAS_(.+)$/.exec(N))) return (ev.targets ?? (ev.victim ? [ev.victim] : [])).some((t) => aeCount(state, t, m[1], false) > 0) ? 1 : 0;
      if ((m = /^SKILL_HAS_TAG_(.+)$/.exec(N))) return skillTags(ev).includes(m[1].toLowerCase()) ? 1 : 0;
      if ((m = /^TARGET_AE_COUNT_(.+)$/.exec(N))) { const t = tgt ?? ev.victim; return t ? aeCount(state, t, m[1], false) : 0; }
      if ((m = /^TARGET_AE_CHARGES_(.+)$/.exec(N))) { const t = tgt ?? ev.victim; return t ? aeCount(state, t, m[1], true) : 0; }
      if ((m = /^HAS_STATUS_(.+)$/.exec(N))) return aeCount(state, me, m[1], false) > 0 ? 1 : 0;
      if ((m = /^HAS_SKILL_(.+)$/.exec(N))) { const k = key(m[1].replace(/_/g, " ")); return (me.actor.items ?? []).some((i) => key(i.name) === k) ? 1 : 0; }
      if ((m = /^TRIGGER_DAMAGE_IS_([A-Z]+)$/.exec(N))) return norm(ev.element) === m[1].toLowerCase() ? 1 : 0;
      if ((m = /^COMBAT_MAX_AE_CHARGES_(.+)$/.exec(N))) return Math.max(0, ...state.combatants.filter((c) => c.alive).map((c) => aeCount(state, c, m[1], true)));
      if ((m = /^AE_COUNT_(.+)$/.exec(N))) return aeCount(state, tgt && ctx.targetScope ? tgt : me, m[1], false);
      if ((m = /^AE_CHARGES_(.+)$/.exec(N))) return aeCount(state, tgt && ctx.targetScope ? tgt : me, m[1], true);
      if ((m = /^VAR_(.+)$/.exec(N))) return Number(ctx.vars?.[m[1].toLowerCase()]) || 0;
      const e = new Error(`unknown identifier ${N}`);
      e.gap = `identifier ${N}`;
      throw e;
    },
  };
  try {
    const v = run(compile(raw), scope);
    return Number.isFinite(v) ? v : fallback;
  } catch (e) {
    gap(state, me, "formula", e.gap ?? `${raw}: ${e.message}`);
    return null;
  }
}

// Tags on the skill being used: its sheet's skill_tags (comma list), lower-case.
function skillTags(ev) {
  const items = ev.actor?.actor?.items ?? [];
  const it = items.find((i) => key(i.name) === key(ev.skillName));
  return s(it?.props?.skill_tags).toLowerCase().split(/[,\s]+/).filter(Boolean);
}
function isRanged(actor, action) {
  if (action?.range) return norm(action.range) === "ranged";
  return norm(actor?.actor?.weapon?.range) === "ranged";
}

function aeCount(state, c, rawName, charges) {
  const k = key(rawName.replace(/_/g, " "));
  if (k === "crisis") return inCrisis(c) ? 1 : 0;
  // The Storm's Rod is engine state (conflict-events.js), an AE in play.
  if (k === "lightning rod") return state.rod === c ? 1 : 0;
  return charges ? aeCharges(c, k) : aesNamed(c, k).length;
}

function condition(state, src, ctx) {
  const raw = s(src);
  if (!raw || raw === "-") return true;
  const v = evalFormula(state, raw, ctx, { fallback: 0 });
  return v != null && !!v;
}

// ── Targets ─────────────────────────────────────────────────────────────────
function inCategory(me, c, category) {
  const cat = norm(category) || "creature";
  if (cat === "creature" || cat === "any" || cat === "all") return true;
  const rel = relation(me, c);
  if (cat === "enemy") return rel === "enemy";
  if (cat === "ally") return rel === "ally" || rel === "self";
  return true;
}

function resolveTargeting(state, row, ctx) {
  const me = ctx.reactor;
  const src = norm(row.candidate_source) || "combat";
  let pool;
  if (src === "trigger_subject") pool = triggerSubject(ctx);
  else if (src === "trigger_attacker") pool = ctx.ev?.attacker ? [ctx.ev.attacker] : (ctx.ev?.actor ? [ctx.ev.actor] : []);
  else if (src === "combat") pool = state.combatants.filter((c) => c.alive);
  else if (src === "self") pool = [me];
  else { gap(state, me, "targeting", `candidate_source ${src}`); pool = []; }
  pool = pool.filter((c) => c.alive || src !== "combat");
  if (src === "combat") pool = pool.filter((c) => inCategory(me, c, row.category));
  if (row.exclude_self === true || norm(row.exclude_self) === "true") pool = pool.filter((c) => c !== me);
  const filter = s(row.target_filter);
  if (filter) pool = pool.filter((c) => condition(state, filter, { ...ctx, target: c, targetScope: true }));
  const mode = norm(row.mode) || "all";
  const count = Math.max(1, Math.trunc(Number(evalFormula(state, row.count, ctx, { fallback: 1 })) || 1));
  if (mode === "all") return pool;
  // "exact" / "random": a person picks at the table; the sim draws.
  const out = [];
  const p = pool.slice();
  while (out.length < count && p.length) out.push(p.splice(state.rng.int(0, p.length - 1), 1)[0]);
  return out;
}

// payload.subjectTokenUuid ?? targetTokenUuid (skill-targeting collectTriggerSubject):
// the creature the event happened TO — the hit creature on creature_deals_damage, the
// creature whose HP moved on a ledger event.
function triggerSubject(ctx) {
  const t = ctx.ev?.victim ?? ctx.ev?.subject;
  return t ? [t] : [];
}

function targetsFor(state, ref, ctx) {
  const r = s(ref);
  const k = norm(r);
  if (!k) return ctx.actionTargets ?? [];
  if (k === "self") return [ctx.reactor];
  if (k === "action_targets") return ctx.actionTargets ?? (ctx.ev?.victim ? [ctx.ev.victim] : []);
  if (k === "hit_action_targets") return ctx.hitTargets ?? (ctx.ev?.victim ? [ctx.ev.victim] : []);
  if (k === "trigger_subject") return triggerSubject(ctx);
  if (k === "trigger_attacker") return ctx.ev?.attacker ? [ctx.ev.attacker] : [];
  if (k === "save_failed_targets") return ctx.saveFailed ?? [];
  if (k === "save_passed_targets") return ctx.savePassed ?? [];
  if (k === "contest_lost_targets") return ctx.contestLost ?? [];
  let m;
  if ((m = /^save_tier_(\d+)$/.exec(k))) return ctx.saveTiers?.[Number(m[1]) - 1] ?? [];
  // A named targeting row in this skill's table, memoised so a chain sees one draw.
  ctx.cache = ctx.cache ?? new Map();
  if (ctx.cache.has(r)) return ctx.cache.get(r);
  const row = ctx.item?.table?.get(r);
  if (row && norm(row.effect_kind) === "targeting") {
    const t = resolveTargeting(state, row, ctx);
    ctx.cache.set(r, t);
    return t;
  }
  gap(state, ctx.reactor, "target_ref", r);
  return [];
}

// ── Effects ─────────────────────────────────────────────────────────────────
const SUPPORTED_KINDS = new Set([
  "chain", "deal_damage", "apply_ae", "remove_ae", "remove_tagged_ae", "grant", "consume_resource",
  "adjust_damage", "change_damage_element", "free_action", "targeting", "save_check", "contest_check",
  "hide_item", "roll_dice", "weapon_read", "play_animation", "leave_combat", "set_battle_outcome",
  "summon", "add_target",
]);

function runLabel(state, label, ctx, depth = 0) {
  const row = ctx.item?.table?.get(s(label));
  if (!row) { gap(state, ctx.reactor, "effect_ref", `${ctx.item?.name ?? "?"} → ${label}`); return; }
  return runRow(state, row, ctx, depth);
}

function runRow(state, row, ctx, depth = 0) {
  if (depth > 24) return;
  const kind = norm(row.effect_kind);
  if (s(row.condition_formula) && kind !== "targeting" && !condition(state, row.condition_formula, ctx)) {
    return norm(row.on_condition_fail) === "abort" ? { abort: true } : undefined;
  }
  let res;
  switch (kind) {
    case "chain":
      for (const step of list(row.chain_steps)) {
        const r = runLabel(state, step, ctx, depth + 1);
        if (r?.abort) return r;
      }
      return;
    case "targeting":
      return;                                     // resolved lazily by name
    case "play_animation":
      break;
    case "deal_damage": res = effDealDamage(state, row, ctx); break;
    case "apply_ae": res = effApplyAe(state, row, ctx); break;
    case "remove_ae": case "remove_tagged_ae": res = effRemoveAe(state, row, ctx, kind); break;
    case "grant": res = effGrant(state, row, ctx, +1); break;
    case "consume_resource": res = effGrant(state, row, ctx, -1); break;
    case "adjust_damage": res = effAdjustDamage(state, row, ctx); break;
    case "change_damage_element":
      if (ctx.damageAdjust) ctx.damageAdjust.element = norm(row.change_element) || ctx.damageAdjust.element;
      break;
    case "free_action": res = effFreeAction(state, row, ctx); break;
    case "save_check": res = effSave(state, row, ctx); break;
    case "contest_check": res = effContest(state, row, ctx); break;
    case "hide_item": res = effHideItem(state, row, ctx); break;
    case "roll_dice": {
      const n = Math.max(1, Math.trunc(Number(row.dice_count) || 1));
      const f = Math.max(2, Math.trunc(Number(row.dice_faces) || 6));
      let t = 0;
      for (let i = 0; i < n; i++) t += state.rng.int(1, f);
      ctx.vars = ctx.vars ?? {};
      ctx.vars[norm(row.prompt_var) || "roll"] = t;
      break;
    }
    case "weapon_read":
      state.mdApi.weaponRead(state, ctx.reactor, row, ctx);
      break;
    case "leave_combat":
      for (const t of targetsFor(state, row.target_ref || "self", ctx)) {
        if (!t.alive) continue;
        t.alive = false; t.escaped = true; t.downedOnRound = state.round;
        state.log.push({ round: state.round, actor: t.name, action: "leaves the battle", escaped: true });
      }
      break;
    case "set_battle_outcome":
      state.forcedOutcome = norm(row.outcome_value) || "escaped";
      break;
    case "summon": res = effSummon(state, row, ctx); break;
    case "add_target":
      break;                                      // resolved by expandTargets() before the hit
    default:
      gap(state, ctx.reactor, "effect", kind || "(blank)");
      return;
  }
  if (res?.abort) return res;
  // A non-chain row may continue with chain_steps of its own (Rakshasa's Chakram:
  // Bleed, then spend the stance).
  if (kind !== "chain" && s(row.chain_steps)) {
    for (const step of list(row.chain_steps)) {
      const r = runLabel(state, step, ctx, depth + 1);
      if (r?.abort) return r;
    }
  }
  return res;
}

function effDealDamage(state, row, ctx) {
  const targets = targetsFor(state, row.target_ref, ctx);
  const resource = norm(row.damage_resource) || "hp";
  const element = norm(row.damage_element) || "physical";
  const kw = norm(row.damage_keywords);
  const cause = norm(row.damage_cause) === "hazard" ? "hazard" : "damage";
  for (const t of targets) {
    if (!t.alive) continue;
    const amount = evalFormula(state, row.damage_amount, { ...ctx, target: t }, { fallback: 0 });
    if (amount == null || amount <= 0) continue;
    if (resource === "mp") {
      const lost = Math.min(t.mp, Math.round(amount));
      t.mp -= lost;
      state.log.push({ round: state.round, actor: ctx.reactor.name, action: ctx.label ?? s(row.effect_label), target: t.name, mpDamage: lost, reaction: true });
      emit(state, "creature_lose_resource", { subject: t, actor: ctx.reactor, causeActor: ctx.reactor, resource: "mp", amount: lost, cause, element: null });
      continue;
    }
    state.mdApi.applyFlatDamage(state, ctx.reactor, t, Math.round(amount), element, ctx.label ?? s(row.effect_label), cause, {
      ignoreAffinity: row.damage_ignore_affinity === true || norm(row.damage_ignore_affinity) === "true",
      keywords: kw || null,
    });
  }
}

function effApplyAe(state, row, ctx) {
  const targets = targetsFor(state, row.target_ref, ctx);
  const mode = norm(row.ae_duplicate_mode) || "replace";
  const pool = list(row.ae_name_pool);
  const skipExisting = s(row.ae_pool_skip_existing) === "1" || row.ae_pool_skip_existing === true;
  const rounds = s(row.ae_duration_rounds) ? Number(row.ae_duration_rounds) : null;
  ctx.drawn = ctx.drawn ?? new Set();
  for (const t of targets) {
    if (!t.alive && t !== ctx.reactor) continue;
    const chanceRaw = s(row.ae_chance_percent);
    if (chanceRaw) {
      const p = evalFormula(state, chanceRaw, { ...ctx, target: t }, { fallback: 100 });
      if (p == null || state.rng.float() * 100 >= p) continue;
    }
    let name = s(row.ae_template_ref);
    if (pool.length) {
      const options = skipExisting ? pool.filter((n) => !hasAe(t, n) && !ctx.drawn.has(key(n))) : pool;
      if (!options.length) continue;
      name = options[state.rng.int(0, options.length - 1)];
      ctx.drawn.add(key(name));
    }
    if (!name) { gap(state, ctx.reactor, "apply_ae", "no template named"); continue; }
    const tpl = resolveTemplate(state, name, ctx.item, ctx.reactor);
    if (!tpl) { gap(state, ctx.reactor, "status template", name); continue; }
    if (statusImmune(t, tpl)) continue;
    const chRaw = s(row.ae_initial_charges);
    const charges = chRaw ? evalFormula(state, chRaw, { ...ctx, target: t }, { fallback: null }) : null;
    if (addAe(state, t, tpl, { applier: ctx.reactor, mode, charges: charges == null ? null : Math.round(charges), rounds })) {
      state.log.push({ round: state.round, actor: ctx.reactor.name, action: ctx.label ?? s(row.effect_label), target: t.name, status: tpl.name, reaction: true, quiet: true });
    }
  }
}

// Sheet status immunities (`statuses` on the loaded model: { isSlow: "IM" } style is not
// stored; a creature with an "immunity_<status>" flag would go here). Kept as one seam.
function statusImmune(t, tpl) {
  const im = t.actor.statusImmunities;
  return !!(im && (im["*"] || im[key(tpl.name)] || (tpl.chargeKey && im[tpl.chargeKey])));
}

function effRemoveAe(state, row, ctx, kind) {
  const targets = targetsFor(state, row.target_ref || "self", ctx);
  const names = list(row.ae_template_ref).map(key);
  const tags = list(row.filter_tag).map(norm);
  const persistent = row.include_persistent === true || norm(row.include_persistent) === "true";
  const countRaw = norm(row.count);
  const count = !countRaw || countRaw === "all" ? Infinity : Math.max(1, Number(countRaw) || 1);
  for (const t of targets) {
    removeAes(t, (a) => {
      if (a.lifetime === "persistent_counter" && !persistent) return false;
      const byName = names.includes(key(a.name));
      const byTag = tags.some((g) => g === "*" || g === "all" || a.template.tags.includes(g) || a.template.chargeKey === g);
      return byName || byTag;
    }, count);
  }
}

function effGrant(state, row, ctx, sign) {
  const targets = targetsFor(state, row.target_ref || "self", ctx);
  const resource = norm(row.grant_resource) || "hp";
  for (const t of targets) {
    if (!t.alive) continue;
    let amount = evalFormula(state, row.grant_amount, { ...ctx, target: t }, { fallback: 0 });
    if (amount == null) continue;
    amount = Math.round(amount) * sign;
    if (!amount) continue;
    if (resource === "hp") {
      if (amount > 0) {
        const healed = Math.min(t.maxHp - t.hp, Math.floor(amount * healFactor(t)));
        if (healed <= 0) continue;
        t.hp += healed;
        state.log.push({ round: state.round, actor: ctx.reactor.name, action: ctx.label ?? s(row.effect_label), target: t.name, damage: healed, direction: "recover", reaction: true });
        emit(state, "creature_gain_resource", { subject: t, actor: ctx.reactor, causeActor: ctx.reactor, resource: "hp", amount: healed, cause: "damage", element: null });
      } else {
        state.mdApi.applyFlatDamage(state, ctx.reactor, t, -amount, null, ctx.label ?? s(row.effect_label), "hazard", { ignoreAffinity: true, keywords: "crush" });
      }
    } else if (resource === "mp") {
      const cap = t.actor.mp.max ?? t.mp;
      const before = t.mp;
      t.mp = Math.max(0, Math.min(cap, t.mp + amount));
      const moved = t.mp - before;
      if (moved) emit(state, moved > 0 ? "creature_gain_resource" : "creature_lose_resource", { subject: t, actor: ctx.reactor, causeActor: ctx.reactor, resource: "mp", amount: Math.abs(moved), cause: "damage", element: null });
    } else if (resource === "ip") {
      t.ip = Math.max(0, t.ip + amount);
    } else if (resource === "shield") {
      t.shield = Math.max(0, (t.shield ?? 0) + amount);
    } else if (resource === "zero_power" || resource === "zp") {
      t.zp = Math.max(0, Math.min(100, (t.zp ?? 0) + amount));
    } else gap(state, ctx.reactor, "grant", `resource ${resource}`);
  }
}

function effAdjustDamage(state, row, ctx) {
  if (!ctx.damageAdjust) { gap(state, ctx.reactor, "adjust_damage", "outside a damage step"); return; }
  const amount = evalFormula(state, row.damage_amount, { ...ctx, target: ctx.damageAdjust.target }, { fallback: 0 });
  if (amount == null) return;
  const op = norm(row.damage_operation) || "add";
  if (op === "add") ctx.damageAdjust.add += amount;
  else if (op === "subtract") ctx.damageAdjust.add -= amount;
  else if (op === "multiply") ctx.damageAdjust.mult *= amount;
  else gap(state, ctx.reactor, "adjust_damage", `operation ${op}`);
}

function effFreeAction(state, row, ctx) {
  const ref = s(row.action_ref);
  const me = ctx.reactor;
  // `action_ref: "self"` — the item carrying the row (Dreadwyrm Descent autocasts).
  const item = norm(ref) === "self" ? ctx.item : me.md?.byName.get(key(ref));
  if (!item) { gap(state, me, "free_action", `no action "${ref}"`); return; }
  const action = actionFor(state, me, item, { anyType: true });
  if (!action) { gap(state, me, "free_action", `cannot build "${item.name}"`); return; }
  const bonus = s(row.damage_bonus_formula) ? evalFormula(state, row.damage_bonus_formula, ctx, { fallback: 0 }) : 0;
  const act = bonus ? { ...action, damageBonus: (action.damageBonus ?? 0) + bonus } : action;
  let targets = s(row.target_ref) ? targetsFor(state, row.target_ref, ctx) : pickTargets(state, me, act, "auto", "");
  targets = targets.filter((t) => t.alive);
  if (!targets.length && act.target?.side !== "self") return;
  if (!state.mdApi.canAfford(me, act, targets.length)) return;
  state.log.push({ round: state.round, actor: me.name, action: ctx.label ?? item.name, reaction: true, announce: true });
  state.mdApi.perform(state, me, bind(state, me, act, targets), targets, { free: true });
}

// A Save: the target rolls its two attributes against the DL. Tiers are CUMULATIVE
// (reference_bd_save_tiers_and_pool_draws): a total of 9 against 16,14,12,10,8,6 lands
// in tiers 1-4.
function effSave(state, row, ctx) {
  const targets = targetsFor(state, row.target_ref, ctx);
  const dl = Number(evalFormula(state, row.save_dl, ctx, { fallback: 10 })) || 10;
  const tiers = list(row.save_tiers).map(Number).filter(Number.isFinite);
  ctx.saveFailed = []; ctx.savePassed = []; ctx.saveTiers = tiers.map(() => []);
  for (const t of targets) {
    if (!t.alive) continue;
    const a = state.mdApi.attrs(t);
    const d1 = a[norm(row.save_attr1)] ?? 8, d2 = a[norm(row.save_attr2)] ?? 8;
    const total = state.rng.die(d1) + state.rng.die(d2);
    (total >= dl ? ctx.savePassed : ctx.saveFailed).push(t);
    tiers.forEach((th, i) => { if (total < th) ctx.saveTiers[i].push(t); });
  }
}

// Opposed check: the caster's two attributes + bonus against the target's. A target
// that rolls lower loses. Interactive rerolls (contest_max_rerolls) are a table
// decision and are not taken.
function effContest(state, row, ctx) {
  const targets = targetsFor(state, row.target_ref, ctx);
  const me = ctx.reactor;
  const ma = state.mdApi.attrs(me);
  ctx.contestLost = [];
  for (const t of targets) {
    if (!t.alive) continue;
    const ta = state.mdApi.attrs(t);
    const mine = state.rng.die(ma[norm(row.contest_attr1)] ?? 8) + state.rng.die(ma[norm(row.contest_attr2)] ?? 8) + (Number(row.contest_bonus) || 0);
    const theirs = state.rng.die(ta[norm(row.save_attr1)] ?? 8) + state.rng.die(ta[norm(row.save_attr2)] ?? 8);
    if (mine > theirs) ctx.contestLost.push(t);
  }
}

// Strip Weapon / Strip Armor: the item leaves the slot until the fight ends.
function effHideItem(state, row, ctx) {
  const slot = norm(row.hide_item_slot);
  for (const t of targetsFor(state, row.target_ref, ctx)) {
    if (slot === "weapon") t.weaponHidden = true;
    else if (slot === "armor") t.armorHidden = t.armorHidden ?? armorShare(t);
    else { gap(state, ctx.reactor, "hide_item", `slot ${slot}`); continue; }
    state.log.push({ round: state.round, actor: ctx.reactor.name, action: ctx.label ?? s(row.effect_label), target: t.name, stripped: slot, reaction: true });
  }
}

// DEF/MDEF the worn armour contributes, read off the equipped armour item.
function armorShare(t) {
  const it = (t.actor.items ?? []).find((i) => norm(i.props?.item_type) === "armor" && (i.props?.isEquipped === true || i.props?.isEquipped === "true"));
  if (!it) return { def: 0, mdef: 0 };
  const n = (k) => Number(it.props?.[k]) || 0;
  return { def: n("def") || n("defense") || n("armor_def"), mdef: n("mdef") || n("magic_defense") || n("armor_mdef") };
}

// Summon: "Actor.<id>,Actor.<id>" — one of them per count, never more than
// summon_max alive from this summoner. The models are loaded by the caller
// (summonRefs) and handed in as runBattle({ summons }).
function summonIds(row) {
  return list(row.summon_actor).map((x) => x.replace(/^Actor\./, "").trim()).filter(Boolean);
}
function effSummon(state, row, ctx) {
  const me = ctx.reactor;
  const ids = summonIds(row);
  const count = Math.max(1, Math.trunc(Number(evalFormula(state, row.summon_count, ctx, { fallback: 1 })) || 1));
  const max = Math.trunc(Number(evalFormula(state, row.summon_max, ctx, { fallback: 0 })) || 0);
  for (let i = 0; i < count; i++) {
    const alive = state.combatants.filter((c) => c.alive && c.summonedBy === me).length;
    if (max > 0 && alive >= max) return;
    const have = new Set(state.combatants.filter((c) => c.alive && c.summonedBy === me).map((c) => c.summonId));
    const pool = ids.filter((id) => !have.has(id));
    const id = (pool.length ? pool : ids)[state.rng.int(0, (pool.length ? pool : ids).length - 1)];
    const model = state.summons?.[id];
    if (!model) { gap(state, me, "summon", `actor ${id} not loaded`); return; }
    const c = state.mdApi.spawn(state, model, me.side);
    c.summonedBy = me; c.summonId = id;
    state.log.push({ round: state.round, actor: me.name, action: ctx.label ?? s(row.effect_label), target: c.name, summoned: true, reaction: true });
  }
}

// Actor ids a creature can summon, for the loader.
function summonRefs(actor) {
  const out = new Set();
  for (const it of actor.items ?? []) for (const r of rows(it.props?.effect_table)) if (norm(r.effect_kind) === "summon") for (const id of summonIds(r)) out.add(id);
  return [...out];
}

// add_target (Carlbero's Grappling): a harmful action aimed at a creature that is
// grappling someone also lands on the creature it holds. Resolved before the hits,
// as the live card mutation does.
function expandTargets(state, actor, action, targets) {
  if (action.target?.side === "ally" || action.target?.self) return targets;
  const out = targets.slice();
  for (const t of targets) {
    for (const a of t.aes ?? []) {
      const r = a.template.reaction;
      if (!r) continue;
      for (const row of r.rows) {
        if (norm(row.reaction_trigger) !== "creature_targeted_by_action") continue;
        const eff = r.effects.find((e) => s(e.effect_label) === s(row.reaction_effect_ref));
        if (!eff || norm(eff.effect_kind) !== "add_target") continue;
        const src = norm(eff.target_ref?.candidate_source ?? eff.candidate_source);
        if (src !== "grappled_by_self") { gap(state, t, "add_target", src || "(blank)"); continue; }
        for (const c of state.combatants) {
          if (!c.alive || out.includes(c) || c === actor) continue;
          if ((c.aes ?? []).some((x) => x.applier === t && key(x.name) === key(a.template.reciprocal ?? "Grappled"))) out.push(c);
          else if ((c.aes ?? []).some((x) => x.applier === t && key(x.name) === "grappled")) out.push(c);
        }
      }
    }
  }
  if (out.length > targets.length) state.log.push({ round: state.round, actor: actor.name, action: action.name, reaction: true, announce: true, added: out.slice(targets.length).map((c) => c.name) });
  return out;
}

// A damage formula that needs the moment of use (Ruinous Breath: 300 / ACTION_TARGET_COUNT).
function bind(state, c, action, targets) {
  if (!action?.damageFormula) return action;
  const v = evalFormula(state, action.damageFormula, { reactor: c, vars: {}, actionTargetCount: targets.length }, { fallback: 0 });
  return { ...action, damageBonus: v ?? 0 };
}

// ── Trigger dispatch ────────────────────────────────────────────────────────
// Every reaction source in play: each data-driven creature's items, and every status
// that carries a reactionConfig (Burn, Envenomed, Searing Brand) on whoever holds it.
function sourcesOf(c) {
  const out = [];
  if (c.md) for (const it of c.md.items) if (it.reactionRows.length) out.push({ item: it, rows: it.reactionRows, ae: null });
  for (const a of c.aes ?? []) {
    const r = a.template.reaction;
    if (!r?.rows?.length) continue;
    out.push({
      item: { name: a.name, table: new Map(r.effects.map((e) => [s(e.effect_label), e])), templates: [], reactionRows: r.rows },
      rows: r.rows, ae: a,
    });
  }
  return out;
}

const SKIP_MODES = new Set(["off", "ask", "manual"]);

function emit(state, trigger, ev) {
  if (!state.mdApi) return;
  if ((state.mdDepth ?? 0) >= MAX_DEPTH) { gap(state, ev.subject, "reaction depth", trigger); return; }
  state.mdDepth = (state.mdDepth ?? 0) + 1;
  try {
    for (const R of state.combatants.slice()) {
      // A dead creature reacts only to its own death (the Electro Slime's burst).
      if (!R.alive && !(trigger === "creature_defeated" && ev.subject === R)) continue;
      if (ev.onlyReactor && R !== ev.onlyReactor) continue;
      for (const src of sourcesOf(R)) {
        for (const row of src.rows) {
          if (norm(row.reaction_trigger) !== trigger) continue;
          const mode = norm(row.reaction_passive_mode);
          if (SKIP_MODES.has(mode)) {
            // A person decides at the table (the GM, or — with reaction_responder
            // "target" — the player being targeted). Recorded once per fight.
            const who = norm(row.reaction_responder) === "target" ? "the targeted player" : (R.side === "party" ? "the player" : "the GM");
            state._askSeen = state._askSeen ?? new Set();
            const k = `${R.name}|${src.item.name}`;
            if (!state._askSeen.has(k)) { state._askSeen.add(k); gap(state, R, "decided at the table", `${src.item.name} (${who})`); }
            continue;
          }
          if (!scopeMatches(R, row, ev, src)) continue;
          if (!condition(state, row.condition_formula, { reactor: R, ev, item: src.item })) continue;
          fire(state, R, src, row, ev);
        }
      }
    }
  } finally {
    state.mdDepth--;
  }
}

function scopeMatches(R, row, ev, src) {
  const scope = norm(row.reaction_source);
  // A status's own row with no scope belongs to its bearer.
  const subjectScope = scope || (src.ae ? "self" : "");
  if (subjectScope === "self" && ev.subject !== R) return false;
  if (subjectScope === "ally" && (!ev.subject || ev.subject.side !== R.side || ev.subject === R)) return false;
  if (subjectScope === "enemy" && (!ev.subject || ev.subject.side === R.side)) return false;
  const skill = s(row.reaction_source_skill);
  if (skill && key(skill) !== key(ev.skillName)) return false;
  const cause = norm(row.reaction_cause_filter);
  if (cause && cause !== norm(ev.cause)) return false;
  const res = norm(row.reaction_resource_filter);
  if (res && ev.resource && res !== norm(ev.resource)) return false;
  return true;
}

// A reaction never re-fires from inside its own resolution: Searing Brand's 50 Fire
// on its bearer is itself HP loss, and would otherwise detonate again until the
// bearer died. (The slime chain is unaffected — each slime is its own reactor.)
function fire(state, R, src, row, ev) {
  state._firing = state._firing ?? new Set();
  if (state._firing.has(row)) return;
  state._firing.add(row);
  try { fireInner(state, R, src, row, ev); } finally { state._firing.delete(row); }
}

function fireInner(state, R, src, row, ev) {
  R.reactionsFired = (R.reactionsFired ?? 0) + 1;
  const label = src.ae ? src.ae.name : src.item.name;
  const ctx = {
    reactor: R, ev, item: src.item, label, vars: { ...(R.vars ?? {}) },
    actionTargets: ev.targets ?? null, hitTargets: ev.victim ? [ev.victim] : null,
    damageAdjust: ev.damageAdjust ?? null,
  };
  if (src.ae?.lifetime === "on_activation") tick(state, R, src.ae);
  runLabel(state, row.reaction_effect_ref, ctx);
}

// creature_will_deal_damage: the attacker's outgoing riders (adjust_damage add /
// change_damage_element), collected before the damage is computed.
function willDeal(state, actor, action, target) {
  const adj = { add: 0, mult: 1, element: action.element, target };
  emit(state, "creature_will_deal_damage", { subject: actor, actor, causeActor: actor, skillName: action.name, action, target, victim: target, targets: [target], element: action.element, damageAdjust: adj });
  return adj;
}

// ── Actions ─────────────────────────────────────────────────────────────────
// An engine action for one of a creature's items. Damage-shaped items come from the
// shared extractor (skills.js); everything else becomes an effect-only action whose
// whole meaning is its on-use chain (War Howl, Prank, Charm, Form Shift).
function actionFor(state, c, item, { anyType = false } = {}) {
  // A damage action the shared extractor already parsed — but never a stance-arming
  // stand-in or a self/ally-targeted skill: those deal no damage roll in play (Sword
  // Enchant's whole effect is its on-use chain).
  const fromEngine = (c.actions ?? []).find((a) => key(a.name) === key(item.name));
  if (fromEngine && !fromEngine.stanceGrants && !fromEngine.target?.self && fromEngine.target?.side !== "ally") return { ...fromEngine, mdItem: item };
  if (!ACTION_TYPES.has(item.skillType) && !anyType) return null;
  c._mdActions = c._mdActions ?? new Map();
  if (c._mdActions.has(item.name)) return c._mdActions.get(item.name);
  const p = item.props;
  const T = state.mdApi.parseTarget(p.skill_target);
  const cost = state.mdApi.parseCost(p.cost);
  const a1 = norm(p.rolled_atr1), a2 = norm(p.rolled_atr2);
  const act = {
    name: item.name, skillType: item.skillType, mdItem: item, effectOnly: true,
    attrA: ATTRS.includes(a1) ? a1 : null, attrB: ATTRS.includes(a2) ? a2 : null,
    damageBonus: 0, checkBonus: Number(p.check_bonus) || 0,
    element: norm(p.type_damage) || "physical",
    defenseTarget: norm(p.defense_target_type) === "mdef" ? "mdef" : "def",
    target: T?.unparseable || !T?.side ? { side: "enemy", count: 1, guessed: true } : T,
    cost: cost?.unpriceable ? { resource: null, amount: 0 } : cost,
    keywords: s(p.action_keywords) || null, weaponFamily: null,
  };
  // Damage the extractor could not price (no accuracy roll, or a use-time formula):
  // a real damage action, auto-hit when the sheet names no attributes.
  const dmgRaw = s(p.damage_bonus);
  if (norm(p.type_damage) && dmgRaw && dmgRaw !== "0" && dmgRaw !== "-" && !act.target.self && act.target.side !== "ally") {
    act.effectOnly = false;
    act.noRoll = !(act.attrA && act.attrB);
    act.attrA = act.attrA ?? "mig"; act.attrB = act.attrB ?? "mig";
    if (/^-?\d+(\.\d+)?$/.test(dmgRaw)) act.damageBonus = Number(dmgRaw);
    else act.damageFormula = dmgRaw;
    act.weaponFamily = item.skillType === "spell" ? "arcane" : null;
  }
  // "Special" (a summon, a field effect): when the on-use chain never reads the
  // action's targets, the action simply has none — aimed at its user.
  if (act.target.guessed) {
    const usesTargets = [...item.table.values()].some((r) => /^(hit_)?action_targets$/.test(norm(r.target_ref)));
    if (usesTargets) gap(state, c, "skill_target", `${item.name}: "${s(p.skill_target)}"`);
    else act.target = { side: "ally", count: 1, self: true };
  }
  c._mdActions.set(item.name, act);
  return act;
}

// On-use chain, after the action's accuracy and damage have resolved.
function runOnActivate(state, actor, action, { targets = [], hits = [] } = {}) {
  if (actor.md?.reactionsOnly) return;
  const item = action.mdItem ?? actor.md?.byName.get(key(action.name));
  if (!item?.onActivate) return;
  runLabel(state, item.onActivate, {
    reactor: actor, item, label: item.name, vars: {},
    actionTargets: targets, hitTargets: hits, ev: { subject: actor, actor, skillName: item.name },
  });
}

// ── Action patterns ─────────────────────────────────────────────────────────
const PRIORITY_WEIGHT = [3, 2, 1];

function range(v1, v2) {
  const a = Math.trunc(Number(v1) || 0), b = Math.trunc(Number(v2) || 0);
  return { min: Math.min(a, b), max: Math.max(a, b) };
}
const pct = (cur, max) => (max > 0 ? Math.ceil((cur / max) * 100) : 0);

function rowPasses(state, c, r) {
  const foes = livingFoesOf(state, c);
  switch (r.condition) {
    case "always": return true;
    case "hp": case "mp": case "ip": case "zero_power": {
      const cur = r.condition === "hp" ? c.hp : r.condition === "mp" ? c.mp : r.condition === "ip" ? c.ip : c.zp;
      const max = r.condition === "hp" ? c.maxHp : r.condition === "mp" ? (c.actor.mp.max ?? c.mp) : r.condition === "ip" ? (c.actor.ip.max ?? c.ip) : 100;
      const { min, max: hi } = range(r.v1, r.v2);
      const p = pct(cur, max);
      return p >= min && p <= hi;
    }
    case "round": case "turn": {
      const cur = state.round;
      const a = Math.trunc(Number(r.v1) || 0), b = Math.trunc(Number(r.v2) || 0);
      if (cur < a) return false;
      if (b <= 0) return cur === a;
      return (cur - a) % b === 0;
    }
    case "self_has_status": case "active_effect": return !!r.string && aeCount(state, c, r.string, false) > 0;
    case "self_lacks_status": return !!r.string && aeCount(state, c, r.string, false) === 0;
    case "enemy_count": case "ally_count": {
      const n = r.condition === "enemy_count" ? foes.length : livingAlliesOf(state, c).length;
      const { min, max } = range(r.v1, r.v2);
      return n >= min && n <= max;
    }
    case "enemy_has_status": return !!r.string && foes.some((f) => aeCount(state, f, r.string, false) > 0);
    case "enemy_lacks_status": return !!r.string && foes.some((f) => aeCount(state, f, r.string, false) === 0);
    case "ally_has_status": return !!r.string && livingAlliesOf(state, c).some((f) => aeCount(state, f, r.string, false) > 0);
    case "ally_in_crisis": {
      const n = livingAlliesOf(state, c).filter(inCrisis).length;
      const has = s(r.v1) !== "" || s(r.v2) !== "";
      const { min, max } = has ? range(r.v1, r.v2) : { min: 1, max: Infinity };
      return n >= min && n <= max;
    }
    case "creature_has_status": return !!r.string && state.combatants.some((x) => x.alive && x !== c && aeCount(state, x, r.string, false) > 0);
    case "effect_stacks": {
      const n = aeCount(state, c, r.string, true);
      const min = Math.max(1, Math.trunc(Number(r.v1) || 1));
      const max = Math.trunc(Number(r.v2) || 0);
      return max > 0 ? n >= min && n <= max : n >= min;
    }
    case "random": return state.rng.float() * 100 < Math.max(0, Math.min(100, Math.trunc(Number(r.v1) || 0)));
    case "activation": {
      const { min, max } = range(r.v1, r.v2);
      const i = c.activationIndex ?? 0;
      return i > 0 && i >= min && i <= max;
    }
    case "target_count": return true;         // deferred to the match, as live
    default:
      gap(state, c, "pattern condition", r.condition);
      return false;
  }
}

// Target selection with the live focus weights (focusWeightFor).
function affinityMult(t, element) {
  switch (affinities(t)?.[element]) {
    case "VU": return 2.0; case "RS": return 0.5; case "IM": return 0.05; case "AB": return 0.02;
    default: return 1;
  }
}
function hpBias(t, kind) {
  const p = Math.max(0, Math.min(1, t.hp / t.maxHp));
  if (kind === "low") return 0.2 + (1 - p) * 1.8;
  if (kind === "high") return 0.2 + p * 1.8;
  if (kind === "mildLow") return 0.8 + (1 - p) * 0.6;
  return 1;
}
function focusWeight(t, focus, action) {
  let w = 1;
  if ((focus === "auto" || focus === "by_affinity") && action.element && !action.effectOnly) {
    let m = affinityMult(t, action.element);
    if (focus === "by_affinity") m = Math.pow(m, 1.5);
    w *= m;
  }
  if (focus === "lowest_hp") w *= hpBias(t, "low");
  else if (focus === "highest_hp") w *= hpBias(t, "high");
  else if (focus === "auto") w *= hpBias(t, "mildLow");
  if (focus === "squishy") {
    const v = defense(t, action.defenseTarget === "mdef" ? "mdef" : "def");
    w *= Math.max(0.3, Math.min(2.5, 20 / (v + 5)));
  }
  return Math.max(0.001, w);
}

function reachable(state, c, action) {
  const side = action.target?.side;
  let pool;
  if (side === "self" || action.target?.self) return [c];
  if (side === "ally") pool = state.combatants.filter((x) => x.alive && !x.object && x.side === c.side);
  else pool = livingFoesOf(state, c);
  if (turnedAgainst(c) && side !== "ally") pool = state.combatants.filter((x) => x.alive && !x.object && x.side === c.side && x !== c);
  if (state.mdApi.isMelee(c, action)) pool = pool.filter((f) => !f.flying);
  const barred = cannotTarget(c);
  if (barred.size) pool = pool.filter((f) => !barred.has(f));
  return pool;
}

function pickTargets(state, c, action, focus, focusStatus) {
  let pool = reachable(state, c, action);
  if (!pool.length) return [];
  if (action.target?.side === "self" || action.target?.self) return [c];
  const n = action.target?.count === Infinity ? pool.length : Math.min(Math.max(1, action.target?.count ?? 1), pool.length);
  if (n >= pool.length) return pool.slice();
  // status_focus / status_avoid narrow the pool (fail-open when nobody qualifies).
  const st = focusStatus || (/^status_(focus|avoid):(.+)$/.exec(focus)?.[2] ?? "");
  const fmode = /^status_(focus|avoid)/.exec(focus)?.[1] ?? null;
  if (fmode && st) {
    const narrowed = pool.filter((t) => (aeCount(state, t, st, false) > 0) === (fmode === "focus"));
    if (narrowed.length) pool = narrowed;
  }
  const base = fmode ? "auto" : focus;
  const out = [];
  const p = pool.slice();
  while (out.length < n && p.length) {
    const ws = p.map((t) => focusWeight(t, base, action));
    const tot = ws.reduce((x, y) => x + y, 0);
    let r = state.rng.float() * tot, i = 0;
    for (; i < ws.length - 1; i++) { r -= ws[i]; if (r <= 0) break; }
    out.push(p.splice(i, 1)[0]);
  }
  return out;
}

function weightedPick(state, pool, w) {
  const tot = pool.reduce((t, x) => t + w(x), 0);
  if (tot <= 0) return pool[0] ?? null;
  let r = state.rng.float() * tot;
  for (const x of pool) { r -= w(x); if (r <= 0) return x; }
  return pool[pool.length - 1];
}

// The monster's turn: which action, at whom. Returns null when it has no pattern
// table (the caller falls back to the engine's generic pick) or nothing legal.
function chooseAction(state, c) {
  if (!c.md?.patterns.length) return null;
  const blocked = blockedLabels(c);
  const cands = [];
  for (const r of c.md.patterns) {
    if (!rowPasses(state, c, r)) continue;
    const item = c.md.byName.get(key(r.name));
    if (!item || !ACTION_TYPES.has(item.skillType)) { if (!item) gap(state, c, "pattern action", r.name); continue; }
    const action = actionFor(state, c, item);
    if (!action) continue;
    cands.push({ row: r, item, action });
  }
  // Action gating (Frightened, Silence, Paralyzed...) before anything else, so the
  // pick routes to the next legal action — the Gigas' Bodyslam when Frightened.
  const legal = cands.filter((x) => !blocked.has(actionLabel(x.action)));
  const hpPct = pct(c.hp, c.maxHp);
  const affordable = legal.filter((x) => !(x.row.hpReserve > 0 && c.hp < x.row.hpReserve) && !(x.row.hpCeiling > 0 && hpPct > x.row.hpCeiling));
  const feasible = affordable.filter((x) => {
    const t = reachable(state, c, x.action);
    if (x.row.condition === "target_count") {
      const { min, max } = s(x.row.v1) || s(x.row.v2) ? range(x.row.v1, x.row.v2) : { min: 1, max: Infinity };
      if (t.length < min || t.length > max) return false;
    }
    return t.length > 0 && state.mdApi.canAfford(c, x.action, 1);
  });
  let working = feasible;
  if (!working.length && affordable.length) {
    const free = affordable.filter((x) => !x.action.cost?.resource);
    working = free.length ? free : [];
  }
  if (!working.length) return { none: true };
  const top = Math.max(...working.map((x) => x.row.priority));
  const retained = working.map((x) => ({ ...x, w: PRIORITY_WEIGHT[top - x.row.priority] ?? 0 })).filter((x) => x.w > 0);
  const mem = c.md.memory;
  let pool = retained.map((x) => {
    const last = mem.used[key(x.item.name)];
    if (x.row.cooldown > 0 && last != null && state.round - last < x.row.cooldown) return { ...x, cw: 0 };
    if (mem.last === key(x.item.name)) return { ...x, cw: x.w * 0.3 };
    return { ...x, cw: x.w };
  }).filter((x) => x.cw > 0);
  if (!pool.length) pool = retained.map((x) => ({ ...x, cw: x.w }));
  const pick = weightedPick(state, pool, (x) => x.cw);
  mem.last = key(pick.item.name);
  mem.used[mem.last] = state.round;
  const targets = pickTargets(state, c, pick.action, pick.row.focus, pick.row.focusStatus);
  return { action: pick.action, targets, row: pick.row };
}

// ── Static coverage ─────────────────────────────────────────────────────────
// What in a creature's data this interpreter cannot run — read off the tables, so the
// audit can say it before a single fight is simulated.
const KNOWN_TRIGGERS = new Set([
  "conflict_start", "turn_start", "turn_end", "round_end", "creature_deals_damage", "creature_will_deal_damage",
  "creature_lose_resource", "creature_gain_resource", "creature_defeated", "creature_targeted_by_action",
  "creature_hit_by_action", "creature_miss_action", "creature_performs_action",
  "creature_completes_action", "creature_completes_attack", "creature_completes_spell", "creature_completes_skill",
  "creature_status_applied", "round_start",
]);
const KNOWN_IDS = /^(HAS_WEAPON_CATEGORY_.+|ACTION_IS_FREE_CAST|SL|TARGET_STATUS_COUNT|HAS_ARCANE_WEAPON|CREATURE_ELEMENTAL_PRESENT|OWN_(PHANTASM|MINION|NUMEN|SUMMON)_COUNT|SUBJECT_IS_MY_(SUMMON|PHANTASM|MINION)|TARGET_SPECIES_IS_.+|ANY_TARGET_HAS_.+|ACTION_IS_(ATTACK|SPELL|SKILL)|ATTACK_IS_(RANGED|MELEE)|SINGLE_TARGET_ATTACK|SKILL_HAS_TAG_.+|TARGET_AE_(COUNT|CHARGES)_.+|HAS_STATUS_.+|HAS_SKILL_.+|ACTION_TARGET_COUNT|CUR_HP|MAX_HP|CUR_MP|MAX_MP|CUR_IP|TARGET_(CURRENT|CUR|MAX)_(HP|MP)|HP_DEALT|DAMAGE_DEALT|TRIGGER_AMOUNT|INCOMING_DAMAGE|ATTACK_CHECK_RESULT|TRIGGER_IS_SELF|SUBJECT_IS_SELF|CAUSE_IS_SELF|IS_MY_TURN|ENEMY_IN_CRISIS|ALLY_COUNT|ENEMY_COUNT|ROUND|RANK_IS_CHAMPION|CHAR_LEVEL|LEVEL|TRIGGER_DAMAGE_IS_[A-Z]+|COMBAT_MAX_AE_CHARGES_.+|AE_COUNT_.+|AE_CHARGES_.+|VAR_.+)$/;
const KNOWN_PATTERN = new Set(["always", "hp", "mp", "ip", "zero_power", "round", "turn", "self_has_status", "active_effect", "self_lacks_status", "enemy_count", "ally_count", "enemy_has_status", "enemy_lacks_status", "ally_has_status", "ally_in_crisis", "creature_has_status", "effect_stacks", "random", "activation", "target_count"]);
const PROMPTS = new Set(["open_action_menu", "redirect_target"]);

function coverage(actor) {
  const out = [];
  const add = (what) => { if (!out.includes(what)) out.push(what); };
  const formula = (src, where) => {
    const raw = s(src);
    if (!raw || raw === "-" || /^-?\d+(\.\d+)?$/.test(raw)) return;
    for (const id of identifiers(raw)) if (!KNOWN_IDS.test(id) && !/^chance\(\)$/.test(id)) add(`${where}: ${id}`);
  };
  for (const it of actor.items ?? []) {
    const p = it.props ?? {};
    for (const r of rows(p.reaction_config_table)) {
      const trig = norm(r.reaction_trigger);
      if (!KNOWN_TRIGGERS.has(trig)) add(`${it.name}: trigger ${trig}`);
      const mode = norm(r.reaction_passive_mode);
      if (SKIP_MODES.has(mode)) add(`${it.name}: a player decides (${mode})`);
      formula(r.condition_formula, it.name);
    }
    for (const r of rows(p.effect_table)) {
      const k = norm(r.effect_kind);
      if (PROMPTS.has(k)) add(`${it.name}: ${k.replace(/_/g, " ")}`);
      else if (!SUPPORTED_KINDS.has(k)) add(`${it.name}: effect ${k}`);
      for (const f of ["damage_amount", "grant_amount", "ae_initial_charges", "ae_chance_percent", "condition_formula", "target_filter", "damage_bonus_formula"]) formula(r[f], it.name);
    }
  }
  for (const r of rows(actor._rawProps?.action_pattern_table)) {
    const c = norm(r.action_pattern_condition) || "always";
    if (!KNOWN_PATTERN.has(c)) add(`pattern ${s(r.action_pattern_name)}: condition ${c}`);
  }
  return out;
}

// ── Pattern lint ────────────────────────────────────────────────────────────
// Facts about a monster's action_pattern_table that follow from the action reader's
// rules alone (priority window 3/2/1, cooldown fallback, feasibility), read statically.
// Each is a way the table plays differently from how it reads.
function lintPatterns(actor) {
  const out = [];
  const pats = rows(actor._rawProps?.action_pattern_table).map((r) => ({
    name: s(r.action_pattern_name), cond: norm(r.action_pattern_condition) || "always",
    pri: s(r.action_pattern_priority) === "" ? 5 : Math.trunc(Number(r.action_pattern_priority) || 0),
    cd: Math.trunc(Number(r.action_pattern_cooldown) || 0), string: s(r.action_pattern_string),
    v1: r.action_pattern_value_1, v2: r.action_pattern_value_2,
  })).filter((r) => r.name);
  if (!pats.length) return out;
  const items = new Map((actor.items ?? []).map((i) => [key(i.name), i]));
  const mpMax = Number(actor.mp?.max) || 0, mpStart = Number.isFinite(Number(actor.mp?.cur)) ? Number(actor.mp.cur) : mpMax;
  const costOf = (n) => { const m = /^\s*(\d+)\s*(?:x\s*T\s*)?MP/i.exec(s(items.get(key(n))?.props?.cost)); return m ? Number(m[1]) : 0; };
  const grantsMp = (actor.items ?? []).some((i) => rows(i.props?.effect_table).some((r) => norm(r.effect_kind) === "grant" && norm(r.grant_resource) === "mp"));
  for (const p of pats) {
    const it = items.get(key(p.name));
    if (!it) { out.push(`pattern row "${p.name}" names no action this monster has — it is never used`); continue; }
    const others = pats.filter((o) => o !== p && items.has(key(o.name)));
    // 1. A cooldown with nothing inside the window to hand the turn to.
    if (p.cd > 0 && !others.some((o) => o.pri >= p.pri - 2)) {
      out.push(`${p.name} repeats every turn its condition holds: its ${p.cd}-round cooldown never applies (no other row within 2 priority of ${p.pri})`);
    }
    // 2. Shadowed by an always-on row 3+ priority above it.
    const shadow = others.find((o) => o.cond === "always" && o.pri >= p.pri + 3 && !costOf(o.name) && o.cd === 0);
    if (shadow) out.push(`${p.name} (priority ${p.pri}) can never be picked: ${shadow.name} is always available at priority ${shadow.pri}`);
    // 3. Costs it cannot pay.
    const cost = costOf(p.name);
    if (cost > mpMax) out.push(`${p.name} costs ${cost} MP but max MP is ${mpMax} — never usable`);
    else if (cost > mpStart && !grantsMp) out.push(`${p.name} costs ${cost} MP; the monster starts at ${mpStart} MP and nothing restores it`);
    else if (cost > mpStart) out.push(`${p.name} costs ${cost} MP; the monster starts at ${mpStart} MP and must charge up first`);
    // 4. A stack threshold its status can never reach.
    if (p.cond === "effect_stacks" && p.string) {
      const need = Math.max(1, Math.trunc(Number(p.v1) || 1));
      for (const i of actor.items ?? []) for (const e of i.effects ?? []) {
        if (key(e.name) !== key(p.string)) continue;
        const cap = Number(e.flags?.[NS]?.chargesMax);
        if (Number.isFinite(cap) && cap > 0 && cap < need) out.push(`${p.name} needs ${need} ${p.string} but ${p.string} caps at ${cap} — never usable`);
      }
    }
  }
  return [...new Set(out)];
}

module.exports = {
  lintPatterns,
  attach, buildStatusLibrary, toTemplate, coverage,
  emit, willDeal, runOnActivate, flushStatusApplied, chooseAction, actionFor, pickTargets, bind, expandTargets, summonRefs,
  onTurnStart, onTurnEnd, onRoundEnd,
  hasAe, aeCharges, addAe, removeAes, resolveTemplate,
  applyAttrSteps, checkMod, defense, affinities, blockedLabels, isBlocked, actionLabel,
  cannotTarget, turnedAgainst, healFactor, refreshDerived,
  evalFormula, identifiers, compile, run,
  SUPPORTED_KINDS, KNOWN_TRIGGERS,
};
