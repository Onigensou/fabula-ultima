"use strict";
//
// Mindscape — the loadout model.
//
// WHY THIS EXISTS
// The loader reads a PC's FINISHED sheet numbers (defense, max_hp, affinity_N,
// check_mod_*): values CSB derived from the template PLUS every Active Effect the
// character carries — equipment AND skills. So swapping one item cannot be a
// lookup. Dodge (+SL DEF) switches off under martial armor, Magical Artillery
// needs an arcane weapon, and the Swimsuit's Wet override changes the DEX die that
// base_defense reads. This module RE-DERIVES those numbers from scratch — template
// base + every applicable change, in CSB's order — so a swap (ruleset Part 6e) is
// a real re-derivation over the edited item list, not a guess.
//
// THE CONTRACT that makes it trustworthy is `verifyLoadout`: rebuilt from the REAL
// loadout, every number must land on the stored sheet. A PC that does not
// reproduce must be refused for swaps, never approximated.
//
// Mirrored sources — read them before changing anything here:
//   template   the LIVE template actor `OmwL5UqoVwjshkJo` in the world DB (read its
//              system body). The module's "Game Object/Template/[Actor] _FabU Char
//              Template v3.fire.json" copy is STALE on max_hp (says skill_hp).
//                defense      = base_defense + bonus_defense
//                base_defense = dex_current            (bonus_defense = 0)
//                dex_current  = override_dex > 0 ? clamp(override_dex, 4, 14)
//                                                : clamp(dex_base + bonus_dex, 4, 14)
//                max_hp       = level + 5*mig_base + 5*count(hp benefits) + bonus_hp
//   ordering   systems/custom-system-builder/.../TemplateSystem.js getSortedActiveEffects:
//              per key, ascending priority (default mode * 10). A value phrase sees
//              the PARENT's props (the item, for an item effect) plus `target` =
//              the actor's props.
//   CUSTOM     CustomActiveEffect.js applyCustomActiveEffectChange
//   gates      scripts/syntax-extender/syntaxExtender-conditionalChangeGate.js
//   helpers    scripts/syntax-extender/active-effect-syntax-extender.js
//   equip      scripts/battle-director/equipment-swap.js — an item that is not
//              equipped has its effects DISABLED, so it contributes nothing.

const { AFFINITY_KEY, WEAPON_FAMILIES } = require("./load-actors");

const MODES = Object.freeze({ CUSTOM: 0, MULTIPLY: 1, ADD: 2, DOWNGRADE: 3, UPGRADE: 4, OVERRIDE: 5 });
const EQUIP_TYPES = new Set(["weapon", "armor", "shield", "accessory"]);
const ELEMENTS = Object.keys(AFFINITY_KEY);

// Every key the combat model reads that equipment can move. `verifyLoadout`
// compares exactly these; a key absent from the stored sheet is skipped.
const VERIFY_KEYS = Object.freeze([
  "dex_current", "ins_current",
  "base_defense", "bonus_defense", "defense",
  "base_magic_defense", "bonus_magic_defense", "magic_defense",
  "bonus_hp", "max_hp",
  ...Object.values(AFFINITY_KEY),
  "check_mod_all", "check_mod_accuracy", "check_mod_magic", "check_mod_melee", "check_mod_ranged",
  "damage_receiving_mod_all", ...ELEMENTS.map((e) => `damage_receiving_mod_${e}`),
  "damage_receiving_mod_melee", "damage_receiving_mod_range",
  "extra_damage_mod_all", "extra_damage_mod_melee", "extra_damage_mod_ranged", "extra_damage_mod_spell",
  ...ELEMENTS.map((e) => `extra_damage_mod_${e}`),
  ...WEAPON_FAMILIES.map((f) => `extra_damage_mod_${f}`),
]);

// Same aliases as active-effect-syntax-extender.js normalizeWeaponCategory.
const WEAPON_CATEGORY_ALIASES = {
  arcana: "arcane", arcane: "arcane", wand: "arcane", staff: "arcane", tome: "arcane",
  dagger: "dagger", knife: "dagger",
  flail: "flail", mace: "flail",
};

function s(v) { return String(v ?? "").trim(); }
function norm(v) { return s(v).toLowerCase(); }
function isTrue(v) { return v === true || v === "true" || v === 1 || v === "1"; }
function isNumeric(v) { return typeof v === "number" || /^[+-]?\d+(\.\d+)?$/.test(s(v)); }
function numLike(v) {
  if (typeof v === "number" || typeof v === "boolean") return v;
  return isNumeric(v) ? Number(s(v)) : v;
}
function toNum(v) {
  if (typeof v === "boolean") return v ? 1 : 0;
  const n = Number(typeof v === "string" ? v.trim() : v);
  return Number.isFinite(n) ? n : 0;
}
function truthyVal(v) {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  const t = norm(v);
  return t !== "" && t !== "false" && t !== "0";
}
function weaponCategory(v) {
  const c = norm(v);
  return WEAPON_CATEGORY_ALIASES[c] ?? c;
}

// Thrown for anything the model cannot evaluate. Caught per change and REPORTED —
// the refusal policy: an unreadable effect is a gap to show, never a zero to hide.
class Unresolved extends Error {
  constructor(reason) { super(reason); this.unresolved = true; }
}

// ── Expression evaluator ─────────────────────────────────────────────────────
// The ${ ... }$ subset the sheet's effect values actually use: numbers, quoted
// strings, identifiers (item props, `target.<prop>`), + - * / %, comparisons,
// ternary, and(), or(), not(), min/max/floor/ceil/round/abs, and the ONI helpers.
// A real parser rather than eval(): nothing outside the grammar can execute, and
// the dead branch of a ternary is never evaluated (so it cannot fail a change).
function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
    if ((c >= "0" && c <= "9") || (c === "." && src[i + 1] >= "0" && src[i + 1] <= "9")) {
      let j = i;
      while (j < src.length && ((src[j] >= "0" && src[j] <= "9") || src[j] === ".")) j++;
      out.push({ t: "num", v: Number(src.slice(i, j)) });
      i = j; continue;
    }
    if (c === "'" || c === '"') {
      const j = src.indexOf(c, i + 1);
      if (j < 0) throw new Unresolved(`unterminated string in "${src}"`);
      out.push({ t: "str", v: src.slice(i + 1, j) });
      i = j + 1; continue;
    }
    if ((c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || c === "_") {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_.]/.test(src[j])) j++;
      out.push({ t: "id", v: src.slice(i, j) });
      i = j; continue;
    }
    const two = src.slice(i, i + 2);
    if (["<=", ">=", "==", "!=", "&&", "||"].includes(two)) { out.push({ t: "op", v: two }); i += 2; continue; }
    if ("+-*/%<>?:(),!".includes(c)) { out.push({ t: "op", v: c }); i++; continue; }
    throw new Unresolved(`unexpected character "${c}" in "${src}"`);
  }
  return out;
}

function parse(tokens) {
  let p = 0;
  const isOp = (v) => tokens[p]?.t === "op" && tokens[p].v === v;
  const expect = (v) => { if (!isOp(v)) throw new Unresolved(`expected "${v}"`); p++; };

  function expr() { return ternary(); }
  function ternary() {
    const cond = orExpr();
    if (!isOp("?")) return cond;
    p++;
    const a = expr();
    expect(":");
    const b = expr();
    return { k: "tern", cond, a, b };
  }
  function orExpr() { let l = andExpr(); while (isOp("||")) { p++; l = { k: "or", l, r: andExpr() }; } return l; }
  function andExpr() { let l = comparison(); while (isOp("&&")) { p++; l = { k: "and", l, r: comparison() }; } return l; }
  function comparison() {
    let l = additive();
    while (tokens[p]?.t === "op" && ["<", ">", "<=", ">=", "==", "!="].includes(tokens[p].v)) {
      const op = tokens[p++].v;
      l = { k: "bin", op, l, r: additive() };
    }
    return l;
  }
  function additive() {
    let l = term();
    while (isOp("+") || isOp("-")) { const op = tokens[p++].v; l = { k: "bin", op, l, r: term() }; }
    return l;
  }
  function term() {
    let l = unary();
    while (isOp("*") || isOp("/") || isOp("%")) { const op = tokens[p++].v; l = { k: "bin", op, l, r: unary() }; }
    return l;
  }
  function unary() {
    if (isOp("-")) { p++; return { k: "neg", e: unary() }; }
    if (isOp("+")) { p++; return unary(); }
    if (isOp("!")) { p++; return { k: "not", e: unary() }; }
    return primary();
  }
  function primary() {
    const tok = tokens[p];
    if (!tok) throw new Unresolved("unexpected end of expression");
    if (tok.t === "num" || tok.t === "str") { p++; return { k: "lit", v: tok.v }; }
    if (tok.t === "id") {
      p++;
      if (!isOp("(")) return { k: "id", name: tok.v };
      p++;
      const args = [];
      if (!isOp(")")) {
        args.push(expr());
        while (isOp(",")) { p++; args.push(expr()); }
      }
      expect(")");
      return { k: "call", name: tok.v, args };
    }
    if (isOp("(")) { p++; const e = expr(); expect(")"); return e; }
    throw new Unresolved(`unexpected token "${tok.v}"`);
  }

  const tree = expr();
  if (p !== tokens.length) throw new Unresolved("trailing tokens in expression");
  return tree;
}

function looseEq(a, b) {
  if (isNumeric(a) && isNumeric(b)) return toNum(a) === toNum(b);
  return s(a) === s(b);
}

function evalNode(n, env) {
  switch (n.k) {
    case "lit": return n.v;
    case "id": return env.ident(n.name);
    case "tern": return truthyVal(evalNode(n.cond, env)) ? evalNode(n.a, env) : evalNode(n.b, env);
    case "and": return truthyVal(evalNode(n.l, env)) && truthyVal(evalNode(n.r, env));
    case "or": return truthyVal(evalNode(n.l, env)) || truthyVal(evalNode(n.r, env));
    case "not": return !truthyVal(evalNode(n.e, env));
    case "neg": return -toNum(evalNode(n.e, env));
    case "call": return env.call(n.name, n.args);
    case "bin": {
      const a = evalNode(n.l, env);
      const b = evalNode(n.r, env);
      switch (n.op) {
        case "+":
          return (!isNumeric(a) && typeof a === "string") || (!isNumeric(b) && typeof b === "string")
            ? s(a) + s(b) : toNum(a) + toNum(b);
        case "-": return toNum(a) - toNum(b);
        case "*": return toNum(a) * toNum(b);
        case "/": return toNum(a) / toNum(b);
        case "%": return toNum(a) % toNum(b);
        case "<": return toNum(a) < toNum(b);
        case ">": return toNum(a) > toNum(b);
        case "<=": return toNum(a) <= toNum(b);
        case ">=": return toNum(a) >= toNum(b);
        case "==": return looseEq(a, b);
        case "!=": return !looseEq(a, b);
        default: throw new Unresolved(`unsupported operator "${n.op}"`);
      }
    }
    default: throw new Unresolved(`unsupported node "${n.k}"`);
  }
}

// A change value: a plain literal, or exactly one ${ ... }$ phrase.
function evaluatePhrase(raw, env) {
  if (typeof raw === "number" || typeof raw === "boolean") return raw;
  const text = s(raw);
  if (!text.includes("${")) return numLike(text);
  if (!text.startsWith("${") || !text.endsWith("}$")) {
    throw new Unresolved(`text mixed with a formula: "${text}"`);
  }
  const inner = text.slice(2, -2);
  if (inner.includes("${")) throw new Unresolved(`nested formula: "${text}"`);
  return numLike(evalNode(parse(tokenize(inner)), env));
}

// ── Gate helpers (conditionalChangeGate) ─────────────────────────────────────
// Whole-value wrappers. Same grammar as the live parseGateSyntax.
const GATE2_RE = /^\s*(?:\$\{\s*)?(aeWhen|aeUuidWhen|aeStatusWhen|aeEquippedWhen|aeNotEquippedWhen|aeSlotEquippedWhen)\s*\(\s*(['"])(.*?)\2\s*,\s*(?:(['"])(.*?)\4|([^)]*?))\s*\)\s*(?:\}\$)?\s*$/i;
const GATE1_RE = /^\s*(?:\$\{\s*)?(aeAffinityFloor)\s*\(\s*(['"])(.*?)\2\s*\)\s*(?:\}\$)?\s*$/i;

function isAffinityKey(key) { return /^affinity_\d+$/.test(key); }

// -> { skip: true } or { value }
function resolveChangeValue(change, env, current) {
  const text = typeof change.value === "string" ? change.value : null;

  const g2 = text ? GATE2_RE.exec(text) : null;
  if (g2) {
    const helper = g2[1].toLowerCase();
    const query = g2[3];
    const inner = g2[5] !== undefined ? g2[5] : (g2[6] ?? "");
    let active;
    if (helper === "aeequippedwhen") active = env.hasEquippedType(query);
    else if (helper === "aenotequippedwhen") active = !env.hasEquippedType(query);
    else if (helper === "aeslotequippedwhen") active = env.slotSpecActive(query);
    else { env.flagSituational(query); active = env.hasActorEffect(query); }

    if (active) return { value: evaluatePhrase(inner, env) };
    // A false gate becomes the key's identity (getBaseValueForChange): ADD -> 0,
    // MULTIPLY -> 1, an affinity -> "NA". Anything else falls back to the source
    // value, which in a from-scratch rebuild means "no change".
    if (change.mode === MODES.ADD) return { value: 0 };
    if (change.mode === MODES.MULTIPLY) return { value: 1 };
    if (isAffinityKey(change.key)) return { value: "NA" };
    return { skip: true };
  }

  const g1 = text ? GATE1_RE.exec(text) : null;
  if (g1) {
    // Always writes, but never downgrades an Immune/Absorb already in place.
    const cur = s(current).toUpperCase();
    return { value: cur === "IM" || cur === "AB" ? cur : evaluatePhrase(g1[3], env) };
  }

  return { value: evaluatePhrase(change.value, env) };
}

function applyMode(current, mode, value) {
  switch (mode) {
    case MODES.ADD: return toNum(current) + toNum(value);
    case MODES.MULTIPLY: return toNum(current) * toNum(value);
    case MODES.UPGRADE: return Math.max(toNum(current), toNum(value));
    case MODES.DOWNGRADE: return Math.min(toNum(current), toNum(value));
    case MODES.OVERRIDE:
    case MODES.CUSTOM: return value;
    default: throw new Unresolved(`unknown effect mode ${mode}`);
  }
}

// ── Which effects apply ──────────────────────────────────────────────────────
function isEquippedItem(item) {
  return EQUIP_TYPES.has(norm(item?.props?.item_type)) && isTrue(item?.props?.isEquipped);
}

function applicableEffects(model) {
  const out = [];
  for (const effect of model.actorEffects ?? []) {
    if (!effect?.disabled) out.push({ effect, item: null });
  }
  for (const item of model.items ?? []) {
    // equipment-swap keeps an unequipped item's effects disabled; a stale
    // `disabled: false` on one must not leak its bonus into the sheet.
    if (EQUIP_TYPES.has(norm(item?.props?.item_type)) && !isTrue(item?.props?.isEquipped)) continue;
    for (const effect of item.effects ?? []) {
      if (effect?.disabled) continue;
      if (effect?.transfer === false) continue;   // lives on the item, not the bearer
      out.push({ effect, item });
    }
  }
  return out;
}

function countHpBenefits(classList) {
  if (!classList || typeof classList !== "object") return 0;
  return Object.values(classList)
    .filter((row) => row && row.$deleted !== true && norm(row.benefit) === "hp").length;
}

// ── The rebuild ──────────────────────────────────────────────────────────────
// `model` needs `_rawProps`, `items` (each with `props` and `effects`) and
// `actorEffects`. Returns every derived key plus a report of what could not be
// evaluated and which values depend on situational state (Wet, Crisis, ...).
function rebuildSheet(model) {
  const props = model?._rawProps ?? {};
  const report = { unresolved: [], situational: [], applied: [] };
  const seen = new Set();
  const note = (list, entry) => {
    const id = JSON.stringify(entry);
    if (seen.has(id)) return;
    seen.add(id);
    list.push(entry);
  };

  const equipped = (model.items ?? []).filter(isEquippedItem);
  const actorEffectNames = new Set();
  for (const e of model.actorEffects ?? []) {
    if (e?.disabled) continue;
    for (const x of [e.name, e._id, e.id, ...(Array.isArray(e.statuses) ? e.statuses : [])]) {
      const k = norm(x);
      if (k) actorEffectNames.add(k);
    }
  }

  // Changes grouped per key, sorted by priority. Array.prototype.sort is stable,
  // so equal priorities keep collection order — the same tie-break CSB gets.
  const byKey = new Map();
  for (const { effect, item } of applicableEffects(model)) {
    for (const ch of effect.changes ?? []) {
      for (let key of s(ch.key).split(",")) {
        key = key.trim();
        if (key.startsWith("system.props.")) key = key.slice("system.props.".length);
        if (!key || key.includes(".")) continue;   // flags.* and friends: not sheet props
        const mode = Number(ch.mode ?? 0);
        const priority = Number(ch.priority ?? mode * 10);
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push({ key, mode, priority, value: ch.value, effect, item });
      }
    }
  }
  for (const list of byKey.values()) list.sort((a, b) => a.priority - b.priority);

  const hasEquippedType = (list) => {
    const wanted = s(list).split(/[,;]/).map(norm).filter(Boolean);
    return equipped.some((it) => {
      const type = norm(it.props.item_type);
      const martial = isTrue(it.props.isMartial);
      return wanted.some((tok) =>
        (tok === type && ["shield", "armor", "weapon"].includes(tok)) ||
        (tok === "martial_armor" && type === "armor" && martial));
    });
  };
  const countWeapons = (cat) => {
    const want = weaponCategory(cat);
    return equipped.filter((it) => norm(it.props.item_type) === "weapon" && weaponCategory(it.props.category) === want).length;
  };
  const slotSpecActive = (spec) => {
    const text = s(spec);
    if (!text) return false;
    const isAnd = text.includes("&");
    const parts = text.split(isAnd ? "&" : ",").map((x) => x.trim()).filter(Boolean);
    const results = parts.map((part) => {
      const [slot, type] = part.split(":").map(norm);
      const hand = slot === "main" ? s(props.main_hand) : slot === "off" ? s(props.off_hand) : "";
      if (!hand) return false;
      const isShield = s(slot === "main" ? props.main_attrib_1 : props.off_attrib_1).toUpperCase() === "SHI";
      if (type === "shield") return isShield;
      if (type === "weapon") return !isShield;
      return type === "any";
    });
    return isAnd ? results.every(Boolean) : results.some(Boolean);
  };

  const makeEnv = (c, current) => {
    // CUSTOM mode evaluates against the ACTOR's props plus `current`; every other
    // mode against the parent's props (the item, for an item effect).
    const phraseProps = c.mode === MODES.CUSTOM || !c.item ? props : (c.item.props ?? {});
    const source = c.item ? `${c.item.name} / ${c.effect.name}` : `actor / ${c.effect.name}`;
    const env = {
      ident(name) {
        if (name === "true") return true;
        if (name === "false") return false;
        if (name === "current") return current;
        if (name === "STATUS_COUNT") {
          note(report.situational, { key: c.key, source, state: "STATUS_COUNT" });
          return 0;
        }
        if (name.startsWith("target.")) {
          const k = name.slice("target.".length);
          if (!(k in props)) throw new Unresolved(`unknown actor prop "${k}"`);
          return numLike(props[k]);
        }
        if (name in phraseProps) return numLike(phraseProps[name]);
        throw new Unresolved(`unknown identifier "${name}"`);
      },
      call(fn, args) {
        const ev = (i) => {
          if (!args[i]) throw new Unresolved(`${fn}() is missing argument ${i + 1}`);
          return evalNode(args[i], env);
        };
        const all = () => args.map((a) => evalNode(a, env));
        switch (fn.toLowerCase()) {
          case "and": return all().every(truthyVal);
          case "or": return all().some(truthyVal);
          case "not": return !truthyVal(ev(0));
          case "min": return Math.min(...all().map(toNum));
          case "max": return Math.max(...all().map(toNum));
          case "floor": return Math.floor(toNum(ev(0)));
          case "ceil": return Math.ceil(toNum(ev(0)));
          case "round": return Math.round(toNum(ev(0)));
          case "abs": return Math.abs(toNum(ev(0)));
          case "ae":
          case "aestatus":
          case "aeuuid": {
            const q = s(ev(0));
            env.flagSituational(q);
            return env.hasActorEffect(q);
          }
          case "countae": {
            const q = s(ev(0));
            env.flagSituational(q);
            return env.hasActorEffect(q) ? 1 : 0;
          }
          case "aevalue": {
            const q = s(ev(0));
            env.flagSituational(q);
            return env.hasActorEffect(q) ? ev(1) : ev(2);
          }
          case "hasweapon": return countWeapons(ev(0)) > 0;
          case "countweapons": return countWeapons(ev(0));
          case "fetchfromparent": {
            const k = s(ev(0));
            if (!(k in props)) throw new Unresolved(`fetchFromParent: unknown actor prop "${k}"`);
            return numLike(props[k]);
          }
          case "ref": return env.ident(s(ev(0)));
          case "propatleast": return toNum(props[s(ev(0))]) >= toNum(ev(1)) ? ev(2) : ev(3);
          default: throw new Unresolved(`unsupported function "${fn}"`);
        }
      },
      hasActorEffect(q) { return actorEffectNames.has(norm(q)); },
      flagSituational(state) { note(report.situational, { key: c.key, source, state: s(state) }); },
      hasEquippedType,
      slotSpecActive,
    };
    return env;
  };

  const values = {};
  const derive = (key, base) => {
    let cur = base;
    for (const c of byKey.get(key) ?? []) {
      const source = c.item ? `${c.item.name} / ${c.effect.name}` : `actor / ${c.effect.name}`;
      try {
        const env = makeEnv(c, cur);
        const r = resolveChangeValue(c, env, cur);
        if (r.skip) continue;
        const next = applyMode(cur, c.mode, r.value);
        report.applied.push({ key, source, mode: c.mode, value: r.value, from: cur, to: next });
        cur = next;
      } catch (err) {
        if (!err?.unresolved) throw err;
        note(report.unresolved, { key, source, value: s(c.value), reason: err.message });
      }
    }
    values[key] = cur;
    return cur;
  };

  const clampDie = (v) => Math.min(Math.max(v, 4), 14);
  for (const attr of ["dex", "ins", "mig", "wlp"]) {
    const override = toNum(derive(`override_${attr}`, 0));
    const bonus = toNum(derive(`bonus_${attr}`, 0));
    derive(`${attr}_current`, override > 0 ? clampDie(override) : clampDie(toNum(props[`${attr}_base`]) + bonus));
  }

  const baseDef = derive("base_defense", values.dex_current);
  const bonusDef = derive("bonus_defense", 0);
  derive("defense", toNum(baseDef) + toNum(bonusDef));
  const baseMdef = derive("base_magic_defense", values.ins_current);
  const bonusMdef = derive("bonus_magic_defense", 0);
  derive("magic_defense", toNum(baseMdef) + toNum(bonusMdef));

  // The LIVE template adds `bonus_hp` (itself AE-driven: Survivor +5). The module's
  // JSON copy of the template still says `skill_hp` and is stale on this one field —
  // Blanche rebuilt 5 short against it (verified 2026-09-13).
  const bonusHp = derive("bonus_hp", 0);
  derive("max_hp", toNum(props.level) + 5 * toNum(props.mig_base)
    + 5 * countHpBenefits(props.class_list) + toNum(bonusHp));

  for (const key of Object.values(AFFINITY_KEY)) derive(key, "NA");
  for (const key of VERIFY_KEYS) if (!(key in values)) derive(key, 0);

  return { values, report, equipped: equipped.map((it) => ({ name: it.name, type: norm(it.props.item_type) })) };
}

function sameValue(stored, rebuilt) {
  if (isNumeric(stored) && isNumeric(rebuilt)) return toNum(stored) === toNum(rebuilt);
  return s(stored).toUpperCase() === s(rebuilt).toUpperCase();
}

// The round-trip gate: rebuild from the real loadout, compare to the stored sheet.
function verifyLoadout(model, { keys = VERIFY_KEYS } = {}) {
  const { values, report, equipped } = rebuildSheet(model);
  const props = model?._rawProps ?? {};
  const matched = [];
  const mismatches = [];
  for (const key of keys) {
    if (!(key in props)) continue;
    if (sameValue(props[key], values[key])) matched.push(key);
    else mismatches.push({ key, stored: props[key], rebuilt: values[key] });
  }
  const relevant = new Set(keys);
  return {
    name: model?.name ?? "(unnamed)",
    ok: mismatches.length === 0,
    matched,
    mismatches,
    equipped,
    unresolved: report.unresolved.filter((u) => relevant.has(u.key)),
    situational: report.situational.filter((u) => relevant.has(u.key)),
  };
}

module.exports = {
  MODES, VERIFY_KEYS, Unresolved,
  evaluatePhrase, rebuildSheet, verifyLoadout, applicableEffects, countHpBenefits,
};
