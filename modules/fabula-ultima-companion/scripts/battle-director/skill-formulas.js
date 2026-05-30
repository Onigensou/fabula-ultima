// Re-export sentinel — bumped whenever a new identifier ships so
// reload-aware callers can verify they have a fresh enough module.
// Currently 2 (Phase 1 of Cheap Shot integration added SINGLE_TARGET_ATTACK
// and TARGET_STATUS_COUNT). Not load-bearing; diagnostic only.
export const SKILL_FORMULAS_SCHEMA = 2;

// Skill formula resolver — director-native equivalent of legacy
// `window["oni.ReactionFormula"]`. The schema doc (docs/reaction-config-
// schema.md) is the source of truth for identifier names and grammar;
// this file is a from-scratch parser/evaluator that reads the SAME spec
// — no calls into legacy `scripts/reaction-system/`.
//
// Grammar (from the schema doc):
//
//   Operators:   + - * / %, < > <= >= == !=, && || !, unary - + !
//   Functions:   floor, ceil, round, abs, min, max
//   Booleans:    1 / 0; truthy = nonzero
//   Identifiers: SL, MAX_HP, CUR_HP, MAX_MP, CUR_MP, MAX_IP, CUR_IP,
//                BOND_STRENGTH, BOND_COUNT, BOND_COUNT_<EMOTION>,
//                STATUS_COUNT, DAMAGE_DEALT, HP_DEALT, MP_DEALT,
//                SHIELD_DEALT, ROUND, ACTION_TARGET_COUNT.
//                Unknown identifiers resolve to 0 (fail-open, matches legacy).
//
// No `eval` / `new Function`. Tokenizer + recursive-descent parser.

import { log, warn } from "./logger.js";

// ── Tokenizer ───────────────────────────────────────────────────────────

const T_NUMBER = "num";
const T_IDENT  = "id";
const T_OP     = "op";
const T_LPAREN = "(";
const T_RPAREN = ")";
const T_COMMA  = ",";
const T_END    = "$";

function tokenize(src) {
  const tokens = [];
  const s = String(src ?? "").trim();
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === "(") { tokens.push({ type: T_LPAREN }); i++; continue; }
    if (ch === ")") { tokens.push({ type: T_RPAREN }); i++; continue; }
    if (ch === ",") { tokens.push({ type: T_COMMA }); i++; continue; }
    // Numbers (integer or decimal)
    if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < s.length && /[0-9.]/.test(s[j])) j++;
      tokens.push({ type: T_NUMBER, value: Number(s.slice(i, j)) });
      i = j;
      continue;
    }
    // Identifiers / function names (uppercase / lowercase / digits / underscore)
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++;
      tokens.push({ type: T_IDENT, value: s.slice(i, j) });
      i = j;
      continue;
    }
    // Multi-char operators first
    const two = s.slice(i, i + 2);
    if (two === "&&" || two === "||" || two === "==" || two === "!="
        || two === "<=" || two === ">=") {
      tokens.push({ type: T_OP, value: two });
      i += 2;
      continue;
    }
    if (/[+\-*/%<>!]/.test(ch)) {
      tokens.push({ type: T_OP, value: ch });
      i++;
      continue;
    }
    throw new Error(`tokenize: unexpected char "${ch}" at index ${i} in "${s}"`);
  }
  tokens.push({ type: T_END });
  return tokens;
}

// ── Parser (recursive descent, precedence climbing) ──────────────────────
//
// Precedence (lowest → highest):
//   1. ||
//   2. &&
//   3. == !=
//   4. < > <= >=
//   5. + -
//   6. * / %
//   7. unary (- + !)
//   8. primary (number, identifier, function call, parenthesized)

function parse(tokens) {
  let pos = 0;
  const peek = () => tokens[pos];
  const eat = () => tokens[pos++];
  const expect = (type, value) => {
    const t = eat();
    if (t.type !== type) throw new Error(`expected ${type} but got ${t.type}`);
    if (value !== undefined && t.value !== value) throw new Error(`expected "${value}" but got "${t.value}"`);
    return t;
  };
  const consumeOp = (...ops) => {
    const t = peek();
    if (t.type === T_OP && ops.includes(t.value)) { eat(); return t.value; }
    return null;
  };

  // OR
  function parseOr() {
    let left = parseAnd();
    let op;
    while ((op = consumeOp("||"))) {
      const right = parseAnd();
      left = { kind: "bin", op, left, right };
    }
    return left;
  }
  // AND
  function parseAnd() {
    let left = parseEquality();
    let op;
    while ((op = consumeOp("&&"))) {
      const right = parseEquality();
      left = { kind: "bin", op, left, right };
    }
    return left;
  }
  function parseEquality() {
    let left = parseRel();
    let op;
    while ((op = consumeOp("==", "!="))) {
      const right = parseRel();
      left = { kind: "bin", op, left, right };
    }
    return left;
  }
  function parseRel() {
    let left = parseAdd();
    let op;
    while ((op = consumeOp("<", ">", "<=", ">="))) {
      const right = parseAdd();
      left = { kind: "bin", op, left, right };
    }
    return left;
  }
  function parseAdd() {
    let left = parseMul();
    let op;
    while ((op = consumeOp("+", "-"))) {
      const right = parseMul();
      left = { kind: "bin", op, left, right };
    }
    return left;
  }
  function parseMul() {
    let left = parseUnary();
    let op;
    while ((op = consumeOp("*", "/", "%"))) {
      const right = parseUnary();
      left = { kind: "bin", op, left, right };
    }
    return left;
  }
  function parseUnary() {
    const op = consumeOp("-", "+", "!");
    if (op) return { kind: "un", op, expr: parseUnary() };
    return parsePrimary();
  }
  function parsePrimary() {
    const t = peek();
    if (t.type === T_NUMBER) { eat(); return { kind: "num", value: t.value }; }
    if (t.type === T_LPAREN) {
      eat();
      const inner = parseOr();
      expect(T_RPAREN);
      return inner;
    }
    if (t.type === T_IDENT) {
      eat();
      // Function call?
      if (peek().type === T_LPAREN) {
        eat();
        const args = [];
        if (peek().type !== T_RPAREN) {
          args.push(parseOr());
          while (peek().type === T_COMMA) { eat(); args.push(parseOr()); }
        }
        expect(T_RPAREN);
        return { kind: "call", name: t.value, args };
      }
      return { kind: "ident", name: t.value };
    }
    throw new Error(`unexpected token ${t.type}${t.value ? ` "${t.value}"` : ""}`);
  }

  const tree = parseOr();
  if (peek().type !== T_END) {
    throw new Error(`trailing tokens after expression (next: ${peek().type})`);
  }
  return tree;
}

// ── Evaluator ───────────────────────────────────────────────────────────

const FUNCTIONS = {
  floor: (n) => Math.floor(n),
  ceil:  (n) => Math.ceil(n),
  round: (n) => Math.round(n),
  abs:   (n) => Math.abs(n),
  min:   (...n) => Math.min(...n),
  max:   (...n) => Math.max(...n),
};

function evalNode(node, resolver) {
  switch (node.kind) {
    case "num":   return node.value;
    case "ident": {
      const v = resolver(node.name);
      // Unresolved → 0 (matches schema doc "all return 0 if unresolvable").
      return (v === null || v === undefined || Number.isNaN(v)) ? 0 : Number(v);
    }
    case "call": {
      const fn = FUNCTIONS[node.name];
      if (!fn) throw new Error(`unknown function: ${node.name}`);
      const args = node.args.map((a) => evalNode(a, resolver));
      return fn(...args);
    }
    case "un": {
      const v = evalNode(node.expr, resolver);
      if (node.op === "-") return -v;
      if (node.op === "+") return +v;
      if (node.op === "!") return v ? 0 : 1;
      throw new Error(`unknown unary op: ${node.op}`);
    }
    case "bin": {
      const l = evalNode(node.left, resolver);
      const r = evalNode(node.right, resolver);
      switch (node.op) {
        case "+":  return l + r;
        case "-":  return l - r;
        case "*":  return l * r;
        case "/":  return r === 0 ? 0 : l / r;  // protect against div-by-zero
        case "%":  return r === 0 ? 0 : l % r;
        case "<":  return l <  r ? 1 : 0;
        case ">":  return l >  r ? 1 : 0;
        case "<=": return l <= r ? 1 : 0;
        case ">=": return l >= r ? 1 : 0;
        case "==": return l === r ? 1 : 0;
        case "!=": return l !== r ? 1 : 0;
        case "&&": return (l && r) ? 1 : 0;
        case "||": return (l || r) ? 1 : 0;
        default:   throw new Error(`unknown binary op: ${node.op}`);
      }
    }
    default: throw new Error(`unknown node kind: ${node.kind}`);
  }
}

// Public API — evaluate a formula string with a resolver function.
// Resolver gets called for every identifier reference; returns
// number | null. Null is treated as "unresolvable" and folds to 0.
//
// On parse / eval failure: logs a warn and returns the fallback (default
// 0). Author errors should be surface-visible in the console; they
// shouldn't crash the FSM mid-cast.
export function evaluateFormula(expression, resolver, fallback = 0) {
  if (expression == null || expression === "") return fallback;
  // Literal-number fast path — most damage_bonus / check_bonus props
  // are just plain numbers in the wild.
  if (typeof expression === "number") return expression;
  const asNum = Number(expression);
  if (Number.isFinite(asNum) && String(asNum) === String(expression).trim()) {
    return asNum;
  }
  try {
    const tokens = tokenize(expression);
    const tree = parse(tokens);
    return evalNode(tree, resolver);
  } catch (e) {
    warn(`skill-formulas.evaluateFormula: "${expression}" failed:`, e.message);
    return fallback;
  }
}

// True iff the value looks like an expression that needs parsing
// (rather than a literal number / blank). Used by callers that want to
// short-circuit without invoking the parser.
export function isFormulaString(value) {
  if (value == null || value === "") return false;
  if (typeof value === "number") return false;
  const s = String(value).trim();
  if (!s) return false;
  // Literal int / float?
  return !/^-?\d+(\.\d+)?$/.test(s);
}

// ── Context builder ─────────────────────────────────────────────────────
//
// Builds the standard resolver for skill activations + reactions. The
// returned function maps every identifier in the schema doc to a value;
// unknown identifiers fall through to 0.
//
// `ctx` shape:
//   - actor     (Actor | TokenDocument-bearing actor) — the reactor.
//   - payload   (object | null) — phase payload for reaction-time formulas.
//                Carries finalValue, valueType, targets, actionIntent, etc.
//   - skill     (Item | null)   — the firing skill, for SL.
//   - round     (number | null) — current dCombat.round; falls back to 0.

export function buildSkillResolver({ actor = null, payload = null, skill = null, round = 0 } = {}) {
  return (name) => {
    // Harness override hook — when `runDirectorSkillSimulate` was called
    // with `override: { SL, CHAR_LEVEL, BOND_COUNT, BOND_STRENGTH }`, the
    // harness stamps those values into a global registry that this resolver
    // consults BEFORE its switch. Lets tests pin identifiers that CSB would
    // otherwise derive from actor state (CHAR_LEVEL ← class_list, BOND_COUNT
    // ← bond_N) and clobber on every prepareData. Lives at
    // globalThis.__FU_HARNESS_FORMULA_OVERRIDES__; cleared in `finally`.
    const ov = globalThis.__FU_HARNESS_FORMULA_OVERRIDES__;
    if (ov && Object.prototype.hasOwnProperty.call(ov, name)) {
      const n = Number(ov[name]);
      if (Number.isFinite(n)) return n;
    }
    switch (name) {
      // Skill level
      case "SL": return Number(skill?.system?.level ?? skill?.system?.props?.skill_level ?? skill?.system?.props?.level ?? 1) || 1;
      // Character (caster) total level — sum of class levels in
      // Fabula Ultima, lives at `actor.system.props.level`. Used by
      // skills that scale on the caster's overall power (Heal's
      // "Skill Enhancement Lv. 20 → 50 / Lv. 40 → 60" tiers, e.g.).
      case "CHAR_LEVEL": return Number(actor?.system?.props?.level ?? actor?.system?.level ?? 0) || 0;
      // Reactor resources
      case "CUR_HP": return readProp(actor, "current_hp");
      case "MAX_HP": return readProp(actor, "max_hp");
      case "CUR_MP": return readProp(actor, "current_mp");
      case "MAX_MP": return readProp(actor, "max_mp");
      case "CUR_IP": return readProp(actor, "current_ip");
      case "MAX_IP": return readProp(actor, "max_ip");
      // Status / bond counts
      case "STATUS_COUNT": return countStatusDebuffs(actor);
      case "BOND_STRENGTH": return bondStrengthTowardSubject(actor, payload);
      case "BOND_COUNT": return countBondSlots(actor);
      case "BOND_COUNT_ADMIRATION": return countBondsByEmotion(actor, "admiration");
      case "BOND_COUNT_INFERIORITY": return countBondsByEmotion(actor, "inferiority");
      case "BOND_COUNT_LOYALTY":    return countBondsByEmotion(actor, "loyalty");
      case "BOND_COUNT_MISTRUST":   return countBondsByEmotion(actor, "mistrust");
      case "BOND_COUNT_AFFECTION":  return countBondsByEmotion(actor, "affection");
      case "BOND_COUNT_HATRED":     return countBondsByEmotion(actor, "hatred");
      // Damage-card payload reads (per-target — payload is per-event)
      case "DAMAGE_DEALT":       return Number(payload?.finalValue) || 0;
      case "DAMAGE_DEALT_TOTAL": return Number(payload?.finalValue) || 0;
      case "HP_DEALT":     return payload?.valueType === "hp" ? (Number(payload?.finalValue) || 0) : 0;
      case "HP_DEALT_TOTAL":     return payload?.valueType === "hp" ? (Number(payload?.finalValue) || 0) : 0;
      case "MP_DEALT":     return payload?.valueType === "mp" ? (Number(payload?.finalValue) || 0) : 0;
      case "MP_DEALT_TOTAL":     return payload?.valueType === "mp" ? (Number(payload?.finalValue) || 0) : 0;
      case "SHIELD_DEALT":       return payload?.valueType === "shield" ? (Number(payload?.finalValue) || 0) : 0;
      case "SHIELD_DEALT_TOTAL": return payload?.valueType === "shield" ? (Number(payload?.finalValue) || 0) : 0;
      // Combat state
      case "ROUND": return Math.max(0, Number(round ?? 0) || 0);
      case "ACTION_TARGET_COUNT": {
        const t = payload?.targets;
        return Array.isArray(t) ? t.length : 0;
      }
      // Boolean (1/0) alias for ACTION_TARGET_COUNT == 1 — reads cleaner
      // in gates like Cheap Shot's "SINGLE_TARGET_ATTACK && ..." than
      // the equality check. Returns 1 if exactly one target was selected.
      case "SINGLE_TARGET_ATTACK": {
        const t = payload?.targets;
        return Array.isArray(t) && t.length === 1 ? 1 : 0;
      }
      // Status (debuff) count on the trigger's SUBJECT creature — the
      // target of the action that fired the trigger. Used by per-target
      // damage reactions like Cheap Shot's "deal +X if target is statused".
      // Reads from payload.subjectActorUuid (the trigger payload's
      // canonical subject identifier — populated by per-target firing
      // sites like creature_will_deal_damage). Falls back to 0 if no
      // subject is threaded — fail-safe for triggers without a subject.
      case "TARGET_STATUS_COUNT": {
        const subjectUuid = String(payload?.subjectActorUuid ?? "").trim();
        if (!subjectUuid) return 0;
        const subject = _resolveActorByUuidSync(subjectUuid);
        return subject ? countStatusDebuffs(subject) : 0;
      }
      // Count of targets that PASSED the Check (hit). For Active Skill
      // RESOLVE, chainPayload populates payload.hitTargets (see
      // state-handlers.js Skill resolve). For attack RESOLVE the same
      // shape is used. Falls back to 0 when no hit info is threaded
      // (no-Check skill / passive grant) — pairs with the legacy
      // "fold unknown to 0" convention so `condition_formula:
      // "HIT_COUNT > 0"` on a grant row resolves to false (no grant)
      // instead of erroring. Used by Soul Steal to gate the IP grant
      // on Check success.
      case "HIT_COUNT": {
        const h = payload?.hitTargets;
        return Array.isArray(h) ? h.length : 0;
      }
      // Roll-derived identifiers — populated whenever the action's roll
      // is threaded onto `payload` (Skill resolveSkillAction does this
      // via makeChainContext.payload and the firePostDamageEffect
      // damagePayload). When no roll fired (no-Check skill / passive
      // grant), all four resolve to 0 — author-supplied formulas like
      // "HR + 5" still evaluate cleanly (→ 5).
      //
      //   HR     — high die roll (max(rA, rB)). 0 on fumble, 0 if no
      //            roll was made.
      //   CRIT   — 1 if the cast was a critical, else 0.
      //   FUMBLE — 1 if the cast was a fumble, else 0.
      //   TOTAL  — full accuracy check total (rA + rB + checkBonus).
      case "HR":     return Math.max(0, Number(payload?.hr ?? 0) || 0);
      case "CRIT":   return payload?.isCrit ? 1 : 0;
      case "FUMBLE": return payload?.isFumble ? 1 : 0;
      case "TOTAL":  return Math.max(0, Number(payload?.total ?? 0) || 0);
      // Equipped-weapon predicates. Read from actor.system.props.weapon_list
      // (CSB's stored equip list); each row carries `weapon_type` per the
      // legacy schema. Returns 1 if at least one EQUIPPED weapon has the
      // matching type, else 0. Authors call as e.g. `HAS_ARCANE_WEAPON`
      // (no parens — formula parser identifier).
      case "HAS_ARCANE_WEAPON":   return hasEquippedWeaponOfType(actor, "arcane") ? 1 : 0;
      case "HAS_MELEE_WEAPON":    return hasEquippedWeaponOfType(actor, "melee") ? 1 : 0;
      case "HAS_RANGED_WEAPON":   return hasEquippedWeaponOfType(actor, "ranged") ? 1 : 0;
      // Equipped-shield + martial-armor predicates. Walk actor.items
      // for any EQUIPPED item whose item_type matches "shield" or
      // "armor" (martial flag required for the armor variant). Used by
      // Dodge's "while no shield and no martial armor" RAW gate.
      case "HAS_SHIELD":          return hasEquippedItemOfType(actor, "shield") ? 1 : 0;
      case "HAS_MARTIAL_ARMOR":   return hasEquippedItemOfType(actor, "armor", { requireMartial: true }) ? 1 : 0;
      default:
        return null;  // unknown → fold to 0 in evalNode
    }
  };
}

// ── Identifier resolvers (kept private; surfaced through buildSkillResolver) ──

function readProp(actor, key) {
  const v = actor?.system?.props?.[key];
  return Number.isFinite(Number(v)) ? Number(v) : 0;
}

// True if the actor has any EQUIPPED weapon of the given `weaponType`.
// Walks `actor.items` for items with `item_type === "weapon"` and
// `isEquipped === true`, matching on `category` (CSB's authoritative
// weapon-class field — values like "Arcane", "Sword", "Bow"). Used by
// Spiritist's Healing Power / Support Magic passives which gate on
// "arcane weapon equipped". Returns boolean; the formula adapter
// coerces to 1/0.
//
// Why not `actor.system.props.weapon_list`? Those rows are a derived
// presentation list — they carry `name` + `type` + `uuid` but NOT
// `isEquipped` (the source-of-truth flag lives on the item itself).
function hasEquippedWeaponOfType(actor, weaponType) {
  if (!actor) return false;
  const wanted = String(weaponType ?? "").toLowerCase();
  const items = actor.items?.contents ?? (Array.isArray(actor.items) ? actor.items : []);
  for (const item of items) {
    const p = item?.system?.props ?? {};
    if (String(p.item_type ?? "").toLowerCase() !== "weapon") continue;
    if (!p.isEquipped) continue;
    const cat = String(p.category ?? p.weapon_type ?? p.type ?? "").toLowerCase();
    if (cat === wanted) return true;
  }
  return false;
}

// True if the actor has any EQUIPPED item with the given `item_type`
// (e.g. "shield", "armor"). Optional `requireMartial` filters for
// items whose `isMartial` flag is true — matches CSB's stored bool
// field on armor/shield items. Used by `HAS_SHIELD` and
// `HAS_MARTIAL_ARMOR` formula identifiers for Dodge's RAW gate.
function hasEquippedItemOfType(actor, item_type, { requireMartial = false } = {}) {
  if (!actor) return false;
  const wanted = String(item_type ?? "").toLowerCase();
  const items = actor.items?.contents ?? (Array.isArray(actor.items) ? actor.items : []);
  for (const item of items) {
    const p = item?.system?.props ?? {};
    if (String(p.item_type ?? "").toLowerCase() !== wanted) continue;
    if (!p.isEquipped) continue;
    if (requireMartial && !p.isMartial) continue;
    return true;
  }
  return false;
}

// Sync uuid → actor lookup. Foundry V12's fromUuidSync handles top-
// level actors (Actor.xxx) and embedded ones (Scene.x.Token.y.Actor.z).
// Used by TARGET_STATUS_COUNT to resolve the trigger's subject during
// formula evaluation (the formula resolver is sync, so we can't await).
// Returns null on miss — caller folds to 0.
function _resolveActorByUuidSync(uuid) {
  try {
    const doc = foundry.utils.fromUuidSync?.(uuid) ?? fromUuidSync?.(uuid);
    if (!doc) return null;
    // Token uuids resolve to a TokenDocument — unwrap to actor.
    if (doc.actor) return doc.actor;
    if (doc.documentName === "Actor") return doc;
    return null;
  } catch (_e) { return null; }
}

// Count active, non-disabled debuff-classified effects on the actor.
// Three independent classifier sources, checked in order — first match wins:
//   1. AEM `inferCategory` — preferred (heuristic + registry-aware).
//   2. `flags.fabula-ultima-companion.category` — explicit author tag.
//   3. `system.tags` array — opt-in classification per
//      [[opt-in-ae-classification]]. AEs from the standard
//      status-applying pipeline (Slow, Dazed, etc.) write
//      `system.tags: ["debuff"]`.
//
// Prior bug (fixed 2026-05-30): step 3 read `eff.system?.tags?.category`
// assuming an OBJECT, but `system.tags` is in fact an ARRAY. So even
// when an AE was correctly tagged with ["debuff"], the lookup failed
// silently and the count under-reported by every non-AEM-classified
// debuff. Cheap Shot's TARGET_STATUS_COUNT gate read 0 for any target
// whose debuffs came from the standard apply_ae path.
function countStatusDebuffs(actor) {
  if (!actor?.effects) return 0;
  const effects = Array.from(actor.effects);
  const aem = globalThis.FUCompanion?.api?.activeEffectManager;
  let count = 0;
  for (const eff of effects) {
    if (eff.disabled) continue;
    // 1. AEM classifier.
    let aemCat = null;
    try { aemCat = aem?.inferCategory?.(eff); } catch {}
    if (String(aemCat ?? "").toLowerCase() === "debuff") { count++; continue; }
    // 2. Explicit flag.
    const flagCat = eff.flags?.["fabula-ultima-companion"]?.category;
    if (String(flagCat ?? "").toLowerCase() === "debuff") { count++; continue; }
    // 3. system.tags array contains "debuff".
    const tags = eff.system?.tags;
    if (Array.isArray(tags) && tags.includes("debuff")) { count++; continue; }
  }
  return count;
}

// Bond data lives at `actor.system.props.bond_N` / `emotion_N_M`.
// Strength = count of non-empty emotion fields per slot (0..3).
function getBondSlots(actor) {
  const out = [];
  if (!actor?.system?.props) return out;
  const p = actor.system.props;
  for (const n of ["1", "2", "3", "4", "5", "6", "temp"]) {
    const name = p[`bond_${n}`];
    if (!name || String(name).trim() === "") continue;
    const emotions = [
      String(p[`emotion_${n}_1`] ?? "").trim().toLowerCase(),
      String(p[`emotion_${n}_2`] ?? "").trim().toLowerCase(),
      String(p[`emotion_${n}_3`] ?? "").trim().toLowerCase(),
    ];
    out.push({ slot: n, name: String(name).trim(), emotions });
  }
  return out;
}

function countBondSlots(actor) {
  return getBondSlots(actor).length;
}

function countBondsByEmotion(actor, emotionKey) {
  const target = String(emotionKey ?? "").toLowerCase();
  return getBondSlots(actor).filter((b) => b.emotions.includes(target)).length;
}

function bondStrengthTowardSubject(actor, payload) {
  if (!actor || !payload) return 0;
  // Subject name comes from the trigger payload (token name or actor name).
  // Case-insensitive match against any of the reactor's bond slots.
  const subjectNames = [
    payload.subjectName,
    payload.targetName,
    payload.tokenName,
    payload.actorName,
  ].filter(Boolean).map((n) => String(n).toLowerCase());
  if (!subjectNames.length) return 0;
  const slots = getBondSlots(actor);
  for (const slot of slots) {
    if (subjectNames.includes(slot.name.toLowerCase())) {
      return slot.emotions.filter(Boolean).length;
    }
  }
  return 0;
}
