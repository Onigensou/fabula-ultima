// Re-export sentinel — bumped whenever a new identifier ships so
// reload-aware callers can verify they have a fresh enough module.
// Currently 5 (added ALLY_COUNT / ANY_ALLY_IN_CRISIS identifiers for the Guest
// system; prev: TARGET_MDEF / CLASS_COUNT / ENEMY_COUNT; pow(); ALL_TARGETS_HIT).
// Not load-bearing; diagnostic only.
export const SKILL_FORMULAS_SCHEMA = 8;

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
const T_STRING = "str";
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
    // String literals — single- or double-quoted. Enables string equality in
    // formulas (e.g. `PERFORMED_SKILL == "Golem Dance"`, or comparing two
    // string accessors like `AE_FLAG(...) != PERFORMED_SKILL`). No escapes —
    // a literal is everything up to the matching closing quote.
    if (ch === "'" || ch === '"') {
      const quote = ch;
      let j = i + 1;
      let str = "";
      while (j < s.length && s[j] !== quote) { str += s[j]; j++; }
      if (j >= s.length) throw new Error(`tokenize: unterminated string literal in "${s}"`);
      tokens.push({ type: T_STRING, value: str });
      i = j + 1;
      continue;
    }
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
    if (t.type === T_STRING) { eat(); return { kind: "str", value: t.value }; }
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
  pow:   (base, exp) => Math.pow(base, exp),
  // chance(N): probability gate, returns 1 with N% likelihood else 0. Lets a
  // condition_formula express "N% chance to fire" (e.g. weapon on-hit
  // "25% chance to inflict Poison" → condition_formula "chance(25)"). Rolls
  // ONCE per condition evaluation (one evaluation per trigger fire in the BD
  // passive path). Math.random is fine in live play; only cron/workflow
  // contexts forbid it, and reactions never fire there.
  chance: (n) => (Math.random() * 100 < Number(n) ? 1 : 0),
  // randint(a, b): inclusive random integer in [a, b] (order-agnostic). Same
  // live-play-only caveat as chance() — uses Math.random, so never author it in
  // a cron/workflow formula. Pyrefly's Gentle Blaze applies randint(1,10) Burn.
  randint: (a, b) => {
    let lo = Math.floor(Number(a)), hi = Math.floor(Number(b));
    if (!Number.isFinite(lo)) lo = 0;
    if (!Number.isFinite(hi)) hi = lo;
    if (hi < lo) { const t = lo; lo = hi; hi = t; }
    return lo + Math.floor(Math.random() * (hi - lo + 1));
  },
};

// Surface unknown-identifier typos / wrong-evaluator mistakes instead of
// silently folding them to 0 (the dual-evaluator "silent-0 trap": an
// identifier that exists only in the BD evaluator returns 0 with no trace if
// reused in a passive *_formula, and vice-versa). Deduped per identifier name
// so the per-render re-eval of card pills doesn't flood the console. Mirrors
// the warn the legacy oni.ReactionFormula evaluator already emits — the BD
// side was the only one staying silent.
const _UNKNOWN_IDENT_WARNED = new Set();
function warnUnknownIdentifier(name) {
  const key = String(name ?? "");
  if (_UNKNOWN_IDENT_WARNED.has(key)) return;
  _UNKNOWN_IDENT_WARNED.add(key);
  console.warn(
    `[skill-formulas] unknown identifier "${key}" → evaluated as 0. ` +
    `Likely a typo, or an identifier that only exists in the other ` +
    `(passive *_formula / reaction-system) evaluator.`,
  );
}

function evalNode(node, resolver) {
  switch (node.kind) {
    case "num":   return node.value;
    case "str":   return node.value;
    case "ident": {
      const v = resolver(node.name);
      // Unresolved → 0 (matches schema doc "all return 0 if unresolvable").
      // String-valued identifiers (e.g. PERFORMED_SKILL) pass through unchanged
      // so == / != can compare them as strings; everything else coerces numeric.
      if (v === null || v === undefined) return 0;
      if (typeof v === "string") return v;
      const n = Number(v);
      return Number.isNaN(n) ? 0 : n;
    }
    case "call": {
      const args = node.args.map((a) => evalNode(a, resolver));
      const fn = FUNCTIONS[node.name];
      if (fn) return fn(...args);
      // Resolver-aware accessor (e.g. AE_FLAG(name, key)) — reads richer context
      // than a bare identifier and MAY return a string. Unknown names fold to 0
      // (fail-open) via the resolver's default, matching the identifier path.
      const v = resolver(node.name, args);
      return (v === null || v === undefined) ? 0 : v;
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

// "No-damage" placeholders that a `type_damage` field may carry to mean "this
// action deals no damage" (so it's a restore / status, not a 0-damage hit).
// Blanks, dashes, and resource/recovery words all collapse to "". "mp" is NOT
// here — it's a real damage type (MP-damage). The single guard against the
// "type_damage:'-' reads as an element → false damage mode" footgun.
const _NO_DAMAGE_DT = new Set([
  "", "-", "–", "—", "none", "n/a", "na", "/", "healing", "heal", "recovery", "hp", "restore",
]);

// Normalize a `type_damage` for DAMAGE classification. Returns "" when the value
// is a no-damage placeholder, else the trimmed/lowercased value (real elements +
// "mp" pass through). Use this as the single reader before deciding damage mode.
export function normalizeDamageType(raw) {
  const s = String(raw ?? "").trim().toLowerCase();
  return _NO_DAMAGE_DT.has(s) ? "" : s;
}

// The "no element" damage token. Canonical form is "null" (displayed "Null");
// "elementless"/"elementaless" are legacy aliases that mean the same thing — a
// real damage type with NO elemental affinity (so the target's affinity is
// always NE: nothing is Vulnerable/Resistant/Immune/Absorbing to it). Treated
// like any other element through the pipeline (deals damage, can be overridden
// by a reaction, displays its name) — it just never finds an affinity entry.
const _NULL_ELEMENT_ALIASES = new Set(["null", "elementless", "elementaless"]);
export function isNullElement(el) {
  return _NULL_ELEMENT_ALIASES.has(String(el ?? "").trim().toLowerCase());
}
// Display label for a damage element: the null-family → "Null", every real
// element → Capitalized (Fire, Ice, …). Blank stays blank (no-damage actions).
export function displayElement(el) {
  const s = String(el ?? "").trim().toLowerCase();
  if (!s) return "";
  if (isNullElement(s)) return "Null";
  return s.charAt(0).toUpperCase() + s.slice(1);
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

// Read the Invoker wellspring availability for an element from the scene's Fabula
// Configuration flags: `flags.fabula-ultima-companion.oniFabula.general.wellspring_<elem>`
// (per-element boolean, set by the Scene Config UI). Prefers the active combat's scene,
// then the active/viewed scene. UNSET → available (returns 1) so the skill works out-of-box
// before a GM restricts the scene; only an explicit `false` (GM unchecked it) gates it.
function wellspringAvailable(elem) {
  try {
    const scene = globalThis.game?.combat?.scene
      ?? globalThis.game?.scenes?.active
      ?? globalThis.canvas?.scene
      ?? null;
    const g = scene?.flags?.["fabula-ultima-companion"]?.oniFabula?.general;
    return g?.[`wellspring_${elem}`] === false ? 0 : 1;
  } catch { return 1; }
}

// 1 if any creature on the scene matches `needle` by SPECIES or NPC RANK, else 0.
// Prefers the active combat's combatants (a battle), else the active/viewed scene's
// tokens. `needle` is compared case-insensitively with underscores→spaces against both
// `system.props.species` (elemental/undead/…) and `system.props.npc_rank` (soldier/
// elite/champion). Backs the dynamic CREATURE_<X>_PRESENT identifier.
function creaturePresentOnScene(needle) {
  try {
    const want = String(needle ?? "").replace(/_/g, " ").toLowerCase().trim();
    if (!want) return 0;
    const actors = [];
    const combatants = globalThis.game?.combat?.combatants;
    if (combatants?.size) {
      for (const c of combatants) { if (c.actor) actors.push(c.actor); }
    } else {
      const scene = globalThis.game?.scenes?.active ?? globalThis.canvas?.scene ?? null;
      for (const t of (scene?.tokens ?? [])) { if (t.actor) actors.push(t.actor); }
    }
    for (const a of actors) {
      const sp = String(a?.system?.props?.species ?? "").replace(/_/g, " ").toLowerCase().trim();
      const rk = String(a?.system?.props?.npc_rank ?? "").replace(/_/g, " ").toLowerCase().trim();
      if (sp === want || rk === want) return 1;
    }
    return 0;
  } catch { return 0; }
}

export function buildSkillResolver({ actor = null, payload = null, skill = null, round = 0, vars = null } = {}) {
  return (name, args = null) => {
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
    // Caller-injected variables — context the resolver itself can't derive
    // from (actor, payload, skill) alone. Consulted before the switch so a
    // caller can supply identifiers it computes with extra context. First use:
    // skill-targeting's per-candidate `target_filter` injects IS_ALLY / IS_ENEMY
    // (disposition of THIS candidate relative to the reactor — needs the reactor
    // token + allegiance overrides, which the resolver doesn't carry), so a pool
    // filter can express "ally OR debuffed-enemy" in one formula.
    if (vars && Object.prototype.hasOwnProperty.call(vars, name)) {
      const n = Number(vars[name]);
      if (Number.isFinite(n)) return n;
    }
    switch (name) {
      // ── String-valued accessors ─────────────────────────────────────────
      // These return STRINGS (evalNode passes them through uncoerced); use them
      // only with == / != (numeric ops on a string are author error → NaN-safe
      // fold). General building blocks for identity checks against AE-stored data.
      //
      // PERFORMED_SKILL — name of the action currently being performed
      // (payload.sourceSkillName). Present on creature_performs_action / *_uses_item
      // payloads. Pairs with AE_FLAG for "is this the same thing a marker recorded".
      case "PERFORMED_SKILL": return String(payload?.sourceSkillName ?? "");
      // AE_FLAG(aeName, flagKey) — the `fabula-ultima-companion` flag `flagKey`
      // off the FIRST non-disabled AE named `aeName` on the actor, as a STRING
      // ("" if the AE or flag is absent). General reader for AE-stored data —
      // e.g. base Dance's repeat-discount compares the single "Dancing" marker's
      // `rememberedAction` (stamped by apply_ae `ae_remember_action`) to the dance
      // being performed now:
      //   AE_FLAG("Dancing","rememberedAction") != PERFORMED_SKILL   → 1 if a DIFFERENT dance.
      case "AE_FLAG": {
        const aeName = String(args?.[0] ?? "").trim().toLowerCase();
        const key = String(args?.[1] ?? "").trim();
        if (!aeName || !key) return "";
        const effects = actor?.effects?.contents ?? Array.from(actor?.effects ?? []);
        const hit = effects.find((e) => !e.disabled && String(e?.name ?? "").trim().toLowerCase() === aeName);
        return String(hit?.flags?.["fabula-ultima-companion"]?.[key] ?? "");
      }
      // Skill level — base level + any RUNTIME boost (gear/effects that raise a
      // skill's EFFECTIVE level without persistently mutating system.level; see
      // skillLevelBonus). Floored at 1 like the bare base read.
      case "SL": return Math.max(1, (Number(skill?.system?.level ?? skill?.system?.props?.skill_level ?? skill?.system?.props?.level ?? 1) || 1) + skillLevelBonus(actor, skill));
      // Character (caster) total level — sum of class levels in
      // Fabula Ultima, lives at `actor.system.props.level`. Used by
      // skills that scale on the caster's overall power (Heal's
      // "Skill Enhancement Lv. 20 → 50 / Lv. 40 → 60" tiers, e.g.).
      case "CHAR_LEVEL": return Number(actor?.system?.props?.level ?? actor?.system?.level ?? 0) || 0;
      // Number of DISTINCT classes the caster owns — reads the CSB `class_list`
      // dynamic table (rows { $deleted, class_name, level }), unioning class_name
      // case-insensitively. Backs Ring of Onions ("+2 max HP/MP per distinct
      // class"). 0 if the actor carries no class_list.
      case "CLASS_COUNT": return countDistinctClasses(actor);
      // Invoker wellsprings — is the given element's wellspring present on the scene?
      // 1 = available (gate passes), 0 = not. Reads the combat/active scene flag
      // `flags.fabula-ultima-companion.oniFabula.wellsprings`; UNSET → all available
      // (so the skill works out-of-box before a GM restricts the scene). Used by the
      // Invocation menu's per-option condition_formula alongside the SL tier gate.
      case "WELLSPRING_AIR_AVAILABLE":   return wellspringAvailable("air");
      case "WELLSPRING_EARTH_AVAILABLE": return wellspringAvailable("earth");
      case "WELLSPRING_FIRE_AVAILABLE":  return wellspringAvailable("fire");
      case "WELLSPRING_BOLT_AVAILABLE":  return wellspringAvailable("bolt");
      case "WELLSPRING_ICE_AVAILABLE":   return wellspringAvailable("ice");
      // Reactor resources
      // MP this actor has spent on SPELL actions so far THIS turn (Bimagus).
      // Combat-scoped, per-actor state the resolver can't derive from `actor`
      // alone, so it reads the ambient active dCombat (set in
      // DirectorCombat.start / cleared on stop). 0 out of combat or pre-spend.
      case "MP_SPENT_THIS_TURN":
        return Number(globalThis.__fudActiveDCombat?.spellMpSpentThisTurn?.(actor?.id) ?? 0) || 0;
      // Printed MP cost of the spell that just resolved — stamped on the
      // creature_completes_spell payload (Bimagus sizes its 2nd free cast off
      // this: "2nd spell ≤ ½ the first"). 0 when not in that reaction context.
      case "LAST_SPELL_MP":
        return Number(payload?.lastSpellMp ?? 0) || 0;
      // Predicted damage THIS reactor is about to take from the in-flight action,
      // stamped on the pre-resolve `creature_targeted_by_action` payload (the
      // subject's own perTargetResults.damage at CONFIRM). Lets a DEFENDER
      // incoming-damage reaction gate on "am I actually being damaged?" — a
      // beneficial/non-damaging action that merely TARGETS the reactor (Cleanse,
      // Heal, buffs) or an attack that misses/is nullified predicts 0, so the
      // reaction stays dormant. Matches RAW "when you take damage" (Ninja Log).
      // 0 outside that trigger (payload doesn't carry it), so a stray gate is safe.
      case "INCOMING_DAMAGE":
        return Math.max(0, Number(payload?.incomingDamage ?? 0) || 0);
      // Native resource cost of the in-flight action, stamped on the pre-resolve
      // `creature_performs_action` payload (ar.costSerialized at CONFIRM). Lets a
      // performer-side cost reaction gate on "am I paying a cost, and how much?" —
      // Fugitive Experiment ("suffer 1d8 Instability to ignore a ≤100 HP/MP/IP cost").
      // 0 outside that trigger (payload doesn't carry it), so a stray gate is safe.
      case "ACTION_COST_HP": return Math.max(0, Number(payload?.costHp ?? 0) || 0);
      case "ACTION_COST_MP": return Math.max(0, Number(payload?.costMp ?? 0) || 0);
      case "ACTION_COST_IP": return Math.max(0, Number(payload?.costIp ?? 0) || 0);
      case "ACTION_COST_TOTAL":
        return Math.max(0,
          (Number(payload?.costHp ?? 0) || 0)
          + (Number(payload?.costMp ?? 0) || 0)
          + (Number(payload?.costIp ?? 0) || 0));
      // EFFECTIVE cost = base folded with adjust_cost overrides (overcharge /
      // discount / waive) via computeEffectiveCost — the amount actually PAID.
      // Stamped on the payload (`effectiveCost*`) wherever the override is known
      // (RESOLVE / card-mutation contexts); falls back to the base cost when no
      // override has been computed yet (e.g. the card-build performer scan), so a
      // gate reading this is always safe. Use these (not ACTION_COST_*) when a gate
      // must respect Cataclysm-style overcharge.
      case "ACTION_EFFECTIVE_COST_HP": return Math.max(0, Number(payload?.effectiveCostHp ?? payload?.costHp ?? 0) || 0);
      case "ACTION_EFFECTIVE_COST_MP": return Math.max(0, Number(payload?.effectiveCostMp ?? payload?.costMp ?? 0) || 0);
      case "ACTION_EFFECTIVE_COST_IP": return Math.max(0, Number(payload?.effectiveCostIp ?? payload?.costIp ?? 0) || 0);
      case "ACTION_EFFECTIVE_COST_TOTAL":
        return Math.max(0,
          (Number(payload?.effectiveCostHp ?? payload?.costHp ?? 0) || 0)
          + (Number(payload?.effectiveCostMp ?? payload?.costMp ?? 0) || 0)
          + (Number(payload?.effectiveCostIp ?? payload?.costIp ?? 0) || 0));
      case "CUR_HP": return readProp(actor, "current_hp");
      case "MAX_HP": return readProp(actor, "max_hp");
      case "CUR_MP": return readProp(actor, "current_mp");
      case "MAX_MP": return readProp(actor, "max_mp");
      case "CUR_IP": return readProp(actor, "current_ip");
      case "MAX_IP": return readProp(actor, "max_ip");
      // Remaining shield buffer (shield_value resource). Symmetric read-token for
      // the grant/set_resource "shield" writers (resources.js) — nothing else
      // could read the live shield before this. Powers "consume any remaining
      // Shield to deal damage equal to the amount consumed" (Geist's Shadow Wall):
      // a round_end row reads CUR_SHIELD for the AoE amount, then zeroes it.
      case "CUR_SHIELD": return readProp(actor, "shield_value");
      // Boss Zero Power pool (Fafnir). CUR_ZERO_POWER / ZERO_POWER read the
      // current stack count; used to cap an accumulator trigger (Zero Trigger:
      // Suffering gains ZP only while ZERO_POWER < 3).
      case "ZERO_POWER":
      case "CUR_ZERO_POWER": return readProp(actor, "zero_power_value");
      case "MAX_ZERO_POWER": return readProp(actor, "max_zero");
      // ── creature_check_adjusted identifier kit ──────────────────────
      // Reusable surface for "a reactive intervention changed a check".
      // Read off the creature_check_adjusted payload; default 0 when the
      // reactor evaluates outside that trigger (so a stray gate is safe).
      //   causer  = who applied the intervention (reroll / +acc / −DEF …)
      //   subject = whose check it is (the action-taker / checker)
      //   target  = for a per-target attack flip, which target moved
      // 1 if THIS reactor is the one who adjusted the check (Foresight:
      // "when Hina changes the outcome"). Works for self-flips AND observer
      // flips (Hina rerolls an ally's check) — the dispatch fires on the
      // causer too, not just the subject.
      case "CHECK_ADJUSTED_BY_ME":
        return (payload?.causerActorUuid && payload.causerActorUuid === actor?.uuid) ? 1 : 0;
      // 1 if it was MY OWN check that got adjusted (react to being meddled with).
      case "CHECK_ADJUSTED_ON_MINE":
        return (payload?.subjectActorUuid && payload.subjectActorUuid === actor?.uuid) ? 1 : 0;
      // 1 if the adjustment actually changed the result (pass↔fail / miss↔hit).
      // Foresight pairs this with CHECK_ADJUSTED_BY_ME so a non-flipping tweak
      // (e.g. +accuracy on an already-hitting target) grants nothing.
      case "CHECK_RESULT_CHANGED":
        return payload?.resultChanged ? 1 : 0;
      // 1 if a per-target attack flip landed on ME (an attack got flipped onto
      // me, or my defence change moved my own slot). target-scope only.
      case "CHECK_ADJUST_AGAINST_ME":
        return (payload?.targetActorUuid && payload.targetActorUuid === actor?.uuid) ? 1 : 0;
      // Direction of the change relative to the subject's success.
      case "CHECK_ADJUST_IMPROVED":
        return payload?.direction === "improved" ? 1 : 0;
      case "CHECK_ADJUST_WORSENED":
        return payload?.direction === "worsened" ? 1 : 0;
      // Signed change in the check total (after − before). Lets a future skill
      // scale by how much the check moved.
      case "CHECK_TOTAL_DELTA":
        return (Number(payload?.after?.total) || 0) - (Number(payload?.before?.total) || 0);
      // Status / bond counts
      case "STATUS_COUNT": return countStatusDebuffs(actor);
      // Distinct debuff TYPES across all enemy combatants (Zero Trigger:
      // Strategy — "two or more DIFFERENT status effects"). Unions identities,
      // so two Dazed enemies = 1, one Dazed + one Slow = 2.
      case "ENEMY_DISTINCT_STATUS_COUNT": return countEnemyDistinctStatuses(actor);
      // 1 if ANY enemy combatant is currently in Crisis, else 0 (Fafnir's
      // "Zero Trigger: Suffering" — gain Zero Power at any turn start while an
      // enemy is bloodied). Crisis = the canonical "Crisis" AE (crisis-reactor).
      case "ENEMY_IN_CRISIS":
      case "ANY_ENEMY_IN_CRISIS": return anyEnemyInCrisis(actor) ? 1 : 0;
      // Number of ENEMY creatures on the scene relative to the reactor — the
      // plain head-count behind Army Wrecker's Overflow ("+1 Accuracy per
      // enemy"). Same enemy enumeration as ENEMY_DISTINCT_STATUS_COUNT /
      // ENEMY_IN_CRISIS (enemyActorsOf: combat roster, canvas-token fallback).
      // 0 out of combat.
      case "ENEMY_COUNT": return enemyActorsOf(actor).length;
      // Ally head-count / any-ally-in-Crisis, relative to the reactor (strict
      // same-sign disposition, self excluded). Backs the Guest system's heal
      // gate. Same enumeration as ENEMY_COUNT, mirrored to the ally side.
      case "ALLY_COUNT": return allyActorsOf(actor).length;
      case "ALLY_IN_CRISIS":
      case "ANY_ALLY_IN_CRISIS": return anyAllyInCrisis(actor) ? 1 : 0;
      // 1 if an ALLY who is THIS actor's focus (carries a Focus AE — status
      // fud-focus — that this actor applied) is currently in Crisis, else 0.
      // Life Transference's eligibility half: "you may heal yourself or an ALLY
      // who is your focus, IF in Crisis" → gate the reaction on
      // `HAS_STATUS_CRISIS == 1 || MY_FOCUS_IN_CRISIS == 1` (self OR ally-focus).
      // Ally-restricted because the focus can be an enemy (Cognitive Focus may
      // mark a Dazed/Enraged/Shaken enemy) but Life Transference only heals an
      // ally focus. Per-applier match (actorHasNamedStatusFromApplier) so a
      // sibling Esper's focus doesn't qualify.
      case "MY_FOCUS_IN_CRISIS": return myFocusInCrisis(actor, payload) ? 1 : 0;
      // 1 if this actor currently has an Arcanum MERGED — an active AE flagged
      // `fabula-ultima-companion.arcanumMerge` (the Arcanist merge/marker AE).
      // Powers Bind and Summon's dynamic card cost (summoning costs MP; while
      // merged the action is Pulse/Dismiss, which are free) and any "while
      // merged" gate. General, not per-Arcanum.
      case "ARCANUM_MERGED": return actorHasArcanumMerge(actor) ? 1 : 0;
      // Number of live summons (incl. phantasms) THIS actor put on the field —
      // tokens flagged summonedBy == me + isSummon/isPhantasm. Gates Create
      // Phantasm: Strike's "Command an existing Phantasm" menu option
      // (OWN_SUMMON_COUNT >= 1). General (not per-skill); reused for the 4-cap.
      case "OWN_SUMMON_COUNT": return ownSummonCount(actor);
      // Number of NUMEN summons (actor.system.props.isNumen) THIS actor has out —
      // gates Create Phantasm: Numen to one Numen (availability_formula
      // "OWN_NUMEN_COUNT == 0"). Subset of OWN_SUMMON_COUNT.
      case "OWN_NUMEN_COUNT": return ownSummonCount(actor, { numenOnly: true });
      // Number of PHANTASM summons (token flag isPhantasm) THIS actor has out —
      // gates the regular Create Phantasm skills to a 3-Phantasm cap
      // ("OWN_PHANTASM_COUNT < 3"). Excludes the Numen, which is a full own-turn
      // summon (no isPhantasm flag) and carries its own one-of-a-kind limit.
      case "OWN_PHANTASM_COUNT": return ownSummonCount(actor, { phantasmOnly: true });
      // Number of PERSISTENT-summon minions this actor owns — world Actors flagged
      // `isPersistentSummon` + `summonOwnerActorUuid == me`. Unlike OWN_SUMMON_COUNT
      // (LIVE tokens only, and includes phantasms), this counts the persisted Actor
      // so a standing minion blocks a second raise whether or not it's currently on
      // the field (between battles / not yet re-added), and Phantasms never count.
      // Birth of the Cruel's authoritative one-at-a-time gate
      // (OWN_PERSISTENT_SUMMON_COUNT == 0) — independent of the Grave Toll AE, which
      // can desync from the minion.
      case "OWN_PERSISTENT_SUMMON_COUNT": return ownPersistentSummonCount(actor);
      case "BOND_STRENGTH": return bondStrengthTowardSubject(actor, payload);
      case "BOND_COUNT": return countBondSlots(actor);
      case "BOND_COUNT_ADMIRATION": return countBondsByEmotion(actor, "admiration");
      case "BOND_COUNT_INFERIORITY": return countBondsByEmotion(actor, "inferiority");
      case "BOND_COUNT_LOYALTY":    return countBondsByEmotion(actor, "loyalty");
      case "BOND_COUNT_MISTRUST":   return countBondsByEmotion(actor, "mistrust");
      case "BOND_COUNT_AFFECTION":  return countBondsByEmotion(actor, "affection");
      case "BOND_COUNT_HATRED":     return countBondsByEmotion(actor, "hatred");
      // Strongest Bond the reactor holds toward ANY creature in the trigger's
      // target/hit list (vs BOND_STRENGTH which only reads the single payload
      // subject by name). Resolves each target uuid → actor → name, matched
      // case-insensitively against the reactor's Bond slots; returns the best
      // emotion-count found, else 0. Prefers the HIT list (creatures actually
      // damaged) so "after you deal damage, if Bonded to one of them" gates
      // resolve correctly on multi-target spells whose action-level payload
      // carries no subject name. Used by Agony (Darkblade).
      case "BOND_WITH_ANY_TARGET": {
        if (!actor) return 0;
        const list = payload?.hitTargets ?? payload?.hitTargetTokenUuids
          ?? payload?.targetActorUuids ?? payload?.targets
          ?? payload?.targetTokenUuids
          ?? (payload?.subjectActorUuid ? [payload.subjectActorUuid] : []);
        const slots = getBondSlots(actor);
        if (!slots.length || !Array.isArray(list)) return 0;
        let best = 0;
        for (const ref of list) {
          const a = _resolveActorByUuidSync(String(ref));
          if (!a) continue;
          const names = [a.name, a.token?.name, a.prototypeToken?.name]
            .filter(Boolean).map((n) => String(n).toLowerCase());
          for (const slot of slots) {
            if (names.includes(String(slot.name).toLowerCase())) {
              best = Math.max(best, slot.emotions.filter(Boolean).length);
            }
          }
        }
        return best;
      }
      // 1 if the ACTING creature (payload source/subject — e.g. the Heart of
      // Darkness caster) already holds a Bond toward THIS candidate (`actor`),
      // matched by name across BOTH authored prop bonds and AE-carried bonds
      // (getBondSlots unions them). Designed for a `target_filter` on a pick row:
      // "SOURCE_BONDED_TO_ME == 0" excludes creatures the caster is already bonded
      // to, so a HoD-style picker only offers valid (unbonded) targets instead of
      // a creature whose create_bond would no-op. The candidate is `actor`; the
      // caster comes from the trigger payload (self-reaction → source == reactor).
      case "SOURCE_BONDED_TO_ME": {
        if (!actor) return 0;
        const srcRef = payload?.sourceActorUuid ?? payload?.subjectActorUuid ?? null;
        const src = srcRef ? _resolveActorByUuidSync(String(srcRef)) : null;
        if (!src) return 0;
        const slots = getBondSlots(src);
        if (!slots.length) return 0;
        const myNames = [actor.name, actor.token?.name, actor.prototypeToken?.name]
          .filter(Boolean).map((n) => String(n).toLowerCase());
        return slots.some((s) => myNames.includes(String(s.name).toLowerCase())) ? 1 : 0;
      }
      // 1 if THIS candidate (`actor`) holds a Bond toward the ACTING creature
      // (payload source — the caster). Exact MIRROR of SOURCE_BONDED_TO_ME with
      // the bond DIRECTION reversed: SOURCE_BONDED_TO_ME asks "does the caster's
      // bond list name this candidate", BONDED_TO_SOURCE asks "does THIS
      // candidate's bond list name the caster". Reads authored prop bonds + AE
      // bonds via getBondSlots. Designed for a `target_filter` on an ally pick —
      // the RAW "choose an ally that has a Bond towards you" (Unicorn Dance):
      // "BONDED_TO_SOURCE >= 1".
      case "BONDED_TO_SOURCE": {
        if (!actor) return 0;
        const srcRef = payload?.sourceActorUuid ?? payload?.subjectActorUuid ?? null;
        const src = srcRef ? _resolveActorByUuidSync(String(srcRef)) : null;
        if (!src) return 0;
        const slots = getBondSlots(actor);
        if (!slots.length) return 0;
        const srcNames = [src.name, src.token?.name, src.prototypeToken?.name]
          .filter(Boolean).map((n) => String(n).toLowerCase());
        return slots.some((s) => srcNames.includes(String(s.name).toLowerCase())) ? 1 : 0;
      }
      // Like SOURCE_BONDED_TO_ME but only counts a bond that ALREADY carries the
      // HATRED emotion (honoring getBondSlots' AE-override). Heart of Darkness's
      // pick filter uses "SOURCE_HATRED_BOND_TO_ME == 0" so it excludes only
      // creatures the caster already HATES (re-applying would be a no-op) while
      // still offering creatures with a different Bond — whose bond the new
      // Bond of Hatred AE then overrides at runtime.
      case "SOURCE_HATRED_BOND_TO_ME": {
        if (!actor) return 0;
        const srcRef = payload?.sourceActorUuid ?? payload?.subjectActorUuid ?? null;
        const src = srcRef ? _resolveActorByUuidSync(String(srcRef)) : null;
        if (!src) return 0;
        const slots = getBondSlots(src);
        if (!slots.length) return 0;
        const myNames = [actor.name, actor.token?.name, actor.prototypeToken?.name]
          .filter(Boolean).map((n) => String(n).toLowerCase());
        return slots.some((s) =>
          myNames.includes(String(s.name).toLowerCase()) && s.emotions.includes("hatred")
        ) ? 1 : 0;
      }
      // Like SOURCE_BONDED_TO_ME but only counts a bond that carries the
      // AFFECTION emotion (mirror of SOURCE_HATRED_BOND_TO_ME). Follow my lead's
      // ally picker uses "SOURCE_AFFECTION_BOND_TO_ME >= 1" for the RAW "choose
      // one ally you can see towards whom you have a Bond of affection".
      case "SOURCE_AFFECTION_BOND_TO_ME": {
        if (!actor) return 0;
        const srcRef = payload?.sourceActorUuid ?? payload?.subjectActorUuid ?? null;
        const src = srcRef ? _resolveActorByUuidSync(String(srcRef)) : null;
        if (!src) return 0;
        const slots = getBondSlots(src);
        if (!slots.length) return 0;
        const myNames = [actor.name, actor.token?.name, actor.prototypeToken?.name]
          .filter(Boolean).map((n) => String(n).toLowerCase());
        return slots.some((s) =>
          myNames.includes(String(s.name).toLowerCase()) && s.emotions.includes("affection")
        ) ? 1 : 0;
      }
      // Damage-card payload reads (per-target — payload is per-event)
      // RAW_DAMAGE: the PRE-affinity damage this hit WILL deal — available on the
      // pre-resolve creature_will_deal_damage payload (state-handlers stamps
      // rawDamage per target). For conditions that gate on the size of the
      // pending hit, e.g. Chomp's "if the damage dealt is ≥ 100, gain Pierce"
      // (RAW_DAMAGE >= 100). Distinct from DAMAGE_DEALT (post-affinity, set at
      // HP-write on creature_deals_damage).
      case "RAW_DAMAGE":         return Number(payload?.rawDamage) || 0;
      // FINAL_DAMAGE: the outgoing hit AFTER pre-resolve bonuses (add/multiply)
      // but BEFORE the target's affinity — what an attack is about to deal. Set
      // by computeSenderDamageBonuses' keyword-condition pass so a keyword gate
      // (e.g. pierce "FINAL_DAMAGE >= 100") sees the post-multiply value.
      case "FINAL_DAMAGE":       return Number(payload?.finalDamage) || 0;
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
      // 1 if the acting creature (reactor) is among the action's own targets,
      // else 0. Reads the action target list (token OR actor uuids resolve).
      // Used by Nocebo Weapon to grant its free attack only when you imbue your
      // OWN weapon (cast on self) — skipped when cast on an ally.
      case "ACTION_TARGETS_SELF": {
        if (!actor) return 0;
        const list = payload?.targetActorUuids ?? payload?.targets
          ?? payload?.targetTokenUuids ?? payload?.actionTargetUuids
          ?? (payload?.targetUuid ? [payload.targetUuid] : []);
        const selfUuid = String(actor.uuid ?? "");
        const selfId = String(actor.id ?? "");
        for (const ref of (Array.isArray(list) ? list : [])) {
          const s = String(ref);
          if (selfUuid && s === selfUuid) return 1;
          const a = _resolveActorByUuidSync(s);
          if (a && (a.uuid === actor.uuid || (selfId && a.id === selfId))) return 1;
        }
        return 0;
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
      // Current HP of the trigger's subject (the target that was damaged).
      // Reads after damage is applied, so 0 means the target just died.
      // Used by kill-detection gates (Voracious, Chomp kill buff).
      case "TARGET_CURRENT_HP": {
        const subjectUuid = String(payload?.subjectActorUuid ?? "").trim();
        if (!subjectUuid) return 0;
        const subject = _resolveActorByUuidSync(subjectUuid);
        return subject ? (Number(subject?.system?.props?.current_hp ?? 0) || 0) : 0;
      }
      // Max HP of the trigger's subject (the target). Twin of TARGET_CURRENT_HP
      // (same subjectActorUuid resolve), reading max_hp instead of current_hp.
      // Powers per-victim "% of the target's max HP" damage riders evaluated in
      // the outgoing-damage pass (computeSenderDamageBonuses), where the resolver's
      // `actor` is the CASTER — so plain MAX_HP would read the caster's HP, not the
      // victim's. Meteor Impact's Burn-detonation: 10% of the target's max HP per
      // Burn stack (`TARGET_AE_CHARGES_BURN * TARGET_MAX_HP * 0.1`).
      case "TARGET_MAX_HP": {
        const subjectUuid = String(payload?.subjectActorUuid ?? "").trim();
        if (!subjectUuid) return 0;
        const subject = _resolveActorByUuidSync(subjectUuid);
        return subject ? (Number(subject?.system?.props?.max_hp ?? 0) || 0) : 0;
      }
      // Remaining shield buffer of the trigger's SUBJECT (the current target).
      // Twin of CUR_SHIELD resolved against subjectActorUuid, for per-victim
      // shield reads in the outgoing-damage pass.
      case "TARGET_CUR_SHIELD": {
        const subjectUuid = String(payload?.subjectActorUuid ?? "").trim();
        if (!subjectUuid) return 0;
        const subject = _resolveActorByUuidSync(subjectUuid);
        return subject ? (Number(subject?.system?.props?.shield_value ?? 0) || 0) : 0;
      }
      // Magic Defense (derived) of the trigger's SUBJECT creature (the current
      // target). Twin of TARGET_MAX_HP (same subjectActorUuid resolve), reading
      // the derived magic_defense prop (fallback current_mdef/mdef — the same
      // read order action-execution-core / the director test-harness use).
      // Powers Witchbane's "×2 damage vs a target whose MDEF > 12" gate
      // (TARGET_MDEF > 12). 0 when no subject is threaded.
      case "TARGET_MDEF": {
        const subjectUuid = String(payload?.subjectActorUuid ?? "").trim();
        if (!subjectUuid) return 0;
        const subject = _resolveActorByUuidSync(subjectUuid);
        if (!subject) return 0;
        const p = subject?.system?.props ?? {};
        return Number(p.magic_defense ?? p.current_mdef ?? p.mdef ?? 0) || 0;
      }
      // 1 iff the trigger's SUBJECT creature is Champion-rank (NPC rank lives at
      // system.props.npc_rank — soldier/elite/champion/companion). Twin of
      // TARGET_CURRENT_HP (same subjectActorUuid resolve). Used by The Tormentor's
      // "20% current-HP bonus damage, reduced to 10% vs Champions".
      case "TARGET_IS_CHAMPION": {
        const subjectUuid = String(payload?.subjectActorUuid ?? "").trim();
        if (!subjectUuid) return 0;
        const subject = _resolveActorByUuidSync(subjectUuid);
        return String(subject?.system?.props?.npc_rank ?? "").trim().toLowerCase() === "champion" ? 1 : 0;
      }
      // 1 iff the trigger's SUBJECT is currently Flying (and NOT already grounded).
      // Mirrors snapshot.targetIsFlying — kept inline to avoid a skill-formulas <->
      // snapshot import cycle (snapshot already imports this module). A
      // `flying_grounded` suppressor AE negates flight; otherwise flight = the
      // "flying" CONFIG status OR an AE named "Flying". Gates Dragontrap Bow's
      // force-land so it only fires on airborne targets (TARGET_IS_FLYING == 1).
      case "TARGET_IS_FLYING": {
        const subjectUuid = String(payload?.subjectActorUuid ?? "").trim();
        if (!subjectUuid) return 0;
        const subject = _resolveActorByUuidSync(subjectUuid);
        if (!subject) return 0;
        const effs = subject.appliedEffects ?? subject.effects?.contents ?? subject.effects ?? [];
        for (const ae of effs) {
          if (ae?.disabled) continue;
          if ((ae.changes ?? []).some((ch) => ch?.key === "flying_grounded")) return 0;
        }
        const flyId = (CONFIG.statusEffects ?? []).find(
          (s) => String(s.name ?? s.label ?? "").trim().toLowerCase() === "flying"
        )?.id ?? null;
        if (flyId && subject.statuses?.has?.(flyId)) return 1;
        return (subject.effects ?? []).some?.((e) => !e.disabled && (
          (flyId && e.statuses?.has?.(flyId)) ||
          String(e.name ?? "").trim().toLowerCase() === "flying"
        )) ? 1 : 0;
      }
      // Total (character) level of the trigger's SUBJECT creature — the twin of
      // CHAR_LEVEL (caster level) for the TARGET. Reads payload.subjectActorUuid,
      // so it requires a per-target context that threads the subject (per-victim
      // effect loops set this). Used to compare target power vs the caster, e.g.
      // Draconic Roar's "enemies lower level than you suffer a stronger debuff"
      // (`TARGET_LEVEL < CHAR_LEVEL`). 0 when no subject is threaded.
      case "TARGET_LEVEL": {
        const subjectUuid = String(payload?.subjectActorUuid ?? "").trim();
        if (!subjectUuid) return 0;
        const subject = _resolveActorByUuidSync(subjectUuid);
        return subject ? (Number(subject?.system?.props?.level ?? subject?.system?.level ?? 0) || 0) : 0;
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
      // 1 if every targeted creature was hit this action, else 0.
      // Populated by creature_completes_attack payload (allTargetsHit field).
      // Returns 0 on creature_deals_damage (per-target) — use this identifier
      // only in creature_completes_attack rows.
      case "ALL_TARGETS_HIT": return payload?.allTargetsHit ? 1 : 0;
      // 1 if every targeted creature actually took > 0 damage this action, else 0.
      // The damage-dealing twin of ALL_TARGETS_HIT: a target can be HIT (accuracy
      // connected) yet take no damage (immune / absorb / reduced to 0), so this is
      // strictly stronger. Populated by creature_completes_attack payload
      // (allTargetsDamaged field). Returns 0 on per-target triggers — use only in
      // creature_completes_attack rows. Powers Blazing Sweep's "repeat if all
      // targets are damaged" gate.
      case "ALL_TARGETS_DAMAGED": return payload?.allTargetsDamaged ? 1 : 0;
      // 1 if the action is a basic weapon ATTACK (ar.kind/view.kind === "Attack").
      // Reads payload.actionKind. The Attack twin of ACTION_IS_SPELL — lets a reaction
      // scope to the Attack action ONLY: e.g. Swordbreaker's on-miss Bane fires on a
      // missed ATTACK, not a missed offensive spell/skill (both stamp actionKind
      // "Skill"). Available wherever the payload carries actionKind (creature_miss_action,
      // the *_completes_* / performs_action payloads).
      case "ACTION_IS_ATTACK":
        return String(payload?.actionKind ?? "").toLowerCase() === "attack" ? 1 : 0;
      // 1 if the action is a Spell. Reads payload.actionKind (the real kind on the
      // post-resolve completion payloads — Consume's "deal damage WITH A SPELL"
      // gate) OR payload.actionSkillType (the casting item's skill_type, carried on
      // the creature_performs_action payload — Hypercognition). Needed because the
      // BD stamps both Skill AND Spell as ar.kind:"Skill", so actionKind alone can't
      // distinguish a spell from a skill on creature_performs_action.
      case "ACTION_IS_SPELL": {
        const k  = String(payload?.actionKind ?? "").toLowerCase();
        const st = String(payload?.actionSkillType ?? "").toLowerCase();
        return (k === "spell" || st === "spell") ? 1 : 0;
      }
      // 1 if the action is an OFFENSIVE spell — a Spell (see ACTION_IS_SPELL)
      // that ALSO rolls a Check (the ⚡ offensive spell in FU; buff/heal spells
      // are isCheck:false). Reads payload.actionIsCheck, stamped on the
      // creature_performs_action payload. Powers Magical Artillery's "when you
      // cast an offensive spell" gate — narrower than ACTION_IS_SPELL, which
      // also matches non-Check utility spells.
      case "ACTION_IS_OFFENSIVE_SPELL": {
        const k  = String(payload?.actionKind ?? "").toLowerCase();
        const st = String(payload?.actionSkillType ?? "").toLowerCase();
        const isSpell = (k === "spell" || st === "spell");
        return (isSpell && payload?.actionIsCheck === true) ? 1 : 0;
      }
      // Ordinal RANK of how long the acting skill's effect lasts, read from the
      // skill's free-form `duration` string (forwarded as payload.skillDuration by
      // the creature_performs_action / creature_uses_item payload builders):
      //   0 = Instantaneous / none / "-"
      //   1 = lasts into a later turn ("Until the start of your next turn", etc.)
      //   2 = Scene-or-longer (scene / rest / session)
      // A general "how persistent is this action" gate — compare with >= so longer
      // scopes can be added later without touching call sites. Dances are only ever
      // Instantaneous (0) or Until-start-of-next-turn (1); Follow my lead shares a
      // dance's lasting benefit only when ACTION_DURATION >= 1 (RAW: non-instant only).
      case "ACTION_DURATION": {
        const d = String(payload?.skillDuration ?? "").toLowerCase().trim();
        if (!d || d === "-" || d.includes("instant")) return 0;
        if (d.includes("scene") || d.includes("rest") || d.includes("session")) return 2;
        return 1;
      }
      // 1 if the action ROLLS ACCURACY — an attack OR a check (the canonical
      // `ar.canMiss` capability, stamped as payload.actionCanMiss on the
      // creature_performs_action payload). Powers Adversity's "bonus on actions that
      // roll a check" gate: attacks + offensive spells + opposed/Hinder checks fire,
      // Heal/buff/utility (no accuracy roll) do not. Reusable for any accuracy-only
      // rider. NOTE reads the single-source flag — do NOT re-derive kind/isCheck here.
      case "ACTION_ROLLS_ACCURACY": {
        return payload?.actionCanMiss === true ? 1 : 0;
      }
      // The in-flight action's native MP cost (printed/serialized), stamped on the
      // creature_will_deal_damage payload. Lets a damage-window cost reaction
      // (Cataclysm's overcharge) gate affordability against the FULL resulting
      // cost — `CUR_MP >= ACTION_MP_COST + <overcharge>` — since the overcharge is
      // folded into the spell's single (clamping) debit. 0 outside that context.
      case "ACTION_MP_COST":
        return Number(payload?.actionMpCost ?? 0) || 0;
      // 1 if the in-flight action is a FREE cast (a free_of_cost free action —
      // e.g. a Bimagus free spell). Lets Cataclysm exclude free casts (RAW: a
      // free spell "costs no MP", so its cost can't be increased). Stamped on the
      // creature_will_deal_damage payload from the live free-action grant.
      case "ACTION_IS_FREE_CAST":
        return payload?.actionIsFreeCast === true ? 1 : 0;
      // 1 if the action targets EXACTLY ONE creature AND that creature carries MY
      // Focus (per-applier, status fud-focus), else 0. Powers Hypercognition's
      // "SL × 2 if your focus is the only target" cost discount. Mirrors
      // ANY_TARGET_HAS_MY_FOCUS's applier match (TOKEN-first, actor-uuid fallback)
      // restricted to the single-target case.
      case "FOCUS_IS_ONLY_TARGET": {
        const list = payload?.targetActorUuids
          ?? payload?.hitTargets ?? payload?.targets ?? payload?.targetTokenUuids ?? [];
        const arr = Array.isArray(list) ? list : [];
        if (arr.length !== 1) return 0;
        const selfTokenUuid = String(payload?.sourceTokenUuid ?? "").trim();
        const selfActorUuid = String(actor?.uuid ?? "").trim();
        const a = _resolveActorByUuidSync(String(arr[0]));
        return (a && actorHasNamedStatusFromApplier(a, "focus", selfTokenUuid, selfActorUuid)) ? 1 : 0;
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
      // HIT_MARGIN — how much the action's accuracy total beat the subject's
      // defense (the SAME defense the attack checked: DEF or MDEF, already
      // baked into the per-target `defense`). Threaded onto the per-target
      // creature_deals_damage payload as `hitMargin`. Drives "Conquer N"
      // weapon on-hit gates: condition_formula "HIT_MARGIN >= N". Negative or
      // 0 when no margin was threaded → a "HIT_MARGIN >= N" gate fails closed.
      case "HIT_MARGIN": return Number(payload?.hitMargin ?? 0) || 0;
      // Equipped-weapon predicates. Read from actor.system.props.weapon_list
      // (CSB's stored equip list); each row carries `weapon_type` per the
      // legacy schema. Returns 1 if at least one EQUIPPED weapon has the
      // matching type, else 0. Authors call as e.g. `HAS_ARCANE_WEAPON`
      // (no parens — formula parser identifier).
      case "HAS_ARCANE_WEAPON":   return hasEquippedWeaponOfType(actor, "arcane") ? 1 : 0;
      case "HAS_MELEE_WEAPON":    return hasEquippedWeaponOfType(actor, "melee") ? 1 : 0;
      case "HAS_RANGED_WEAPON":   return hasEquippedWeaponOfType(actor, "ranged") ? 1 : 0;
      // Weapon-family gate: 1 if an equipped weapon's Category is "firearm"
      // (matches the `category`/`weapon_type` field, not the range). Used by
      // Bullet Break's "with a ranged firearm weapon you have equipped" RAW gate.
      case "HAS_FIREARM":         return hasEquippedWeaponOfType(actor, "firearm") ? 1 : 0;
      // Equipped-shield + martial-armor predicates. Walk actor.items
      // for any EQUIPPED item whose item_type matches "shield" or
      // "armor" (martial flag required for the armor variant). Used by
      // Dodge's "while no shield and no martial armor" RAW gate.
      case "HAS_SHIELD":          return hasEquippedItemOfType(actor, "shield") ? 1 : 0;
      case "HAS_MARTIAL_ARMOR":   return hasEquippedItemOfType(actor, "armor", { requireMartial: true }) ? 1 : 0;
      // Count-aware variants — author can gate on N copies. Used by
      // Dual Shieldbearer's Twin Shields exposure (`EQUIPPED_SHIELD_COUNT >= 2`).
      case "EQUIPPED_SHIELD_COUNT":  return countEquippedItemsOfType(actor, "shield");
      case "EQUIPPED_WEAPON_COUNT":  return countEquippedItemsOfType(actor, "weapon");
      case "EQUIPPED_ARMOR_COUNT":   return countEquippedItemsOfType(actor, "armor");
      // Base attribute die sizes — pre-status reductions. Used by skills
      // that scale on the bearer's underlying attribute regardless of
      // current Shaken/Dazed/Slow/Weak penalties (Prophetic Defender's
      // permanent +INS-die HP, future "base attribute = die size" gates).
      case "INS_BASE_DIE": return readProp(actor, "ins_base");
      case "MIG_BASE_DIE": return readProp(actor, "mig_base");
      case "DEX_BASE_DIE": return readProp(actor, "dex_base");
      case "WLP_BASE_DIE": return readProp(actor, "wlp_base");
      // Current attribute die sizes — post-reduction. Used by skills
      // that scale on the attribute as it is at cast time.
      case "INS_CURRENT_DIE": return readProp(actor, "ins_current") || readProp(actor, "ins_base");
      case "MIG_CURRENT_DIE": return readProp(actor, "mig_current") || readProp(actor, "mig_base");
      case "DEX_CURRENT_DIE": return readProp(actor, "dex_current") || readProp(actor, "dex_base");
      case "WLP_CURRENT_DIE": return readProp(actor, "wlp_current") || readProp(actor, "wlp_base");
      // Guard-payload identifier — 1 when the triggering Guard action
      // covered an ally, else 0. Used by Bodyguard's `creature_guards`
      // reaction-config row to gate the RS-to-all grant on
      // `DID_COVER_ALLY == 1`. Read from payload.didCoverAlly (queued by
      // state-handlers.js Guard RESOLVE).
      case "DID_COVER_ALLY":      return payload?.didCoverAlly ? 1 : 0;
      // In-flight-attack weapon-class predicates. Read the triggering
      // action's weapon TYPE off the payload (`weaponType` = the homebrew
      // CSB melee/ranged/arcane class, threaded by the Attack damage
      // path onto both creature_will_deal_damage (pre-resolve) and
      // creature_deals_damage (post-resolve) payloads). Unlike
      // HAS_RANGED_WEAPON (which asks "is a ranged weapon EQUIPPED"),
      // these ask "is THIS attack a ranged/melee/arcane one" — the gate
      // Sharpshooter's Hawkeye / Warning Shot need so a "next ranged
      // attack" buff doesn't fire on a melee swing. 0 when no weaponType
      // was threaded (non-weapon action / skill) → a `== 1` gate fails closed.
      // RANGED/MELEE read the attack weapon's RANGE (payload.weaponRange,
      // e.g. "Ranged"/"Melee" from weapon.range) — NOT weaponType, which holds
      // the weapon FAMILY (sword/bow/brawling) and would never equal "ranged".
      // Substring match tolerates the capitalized sheet value. Falls back to a
      // legacy weaponType === "ranged" reading for any old caller that set it.
      case "ATTACK_IS_RANGED": {
        const wr = String(payload?.weaponRange ?? "").toLowerCase();
        return (wr.includes("rang") || String(payload?.weaponType ?? "").toLowerCase() === "ranged") ? 1 : 0;
      }
      case "ATTACK_IS_MELEE": {
        const wr = String(payload?.weaponRange ?? "").toLowerCase();
        return (wr.includes("mele") || String(payload?.weaponType ?? "").toLowerCase() === "melee") ? 1 : 0;
      }
      // Resource of the action's pending damage (creature_will_deal_damage payload
      // carries `valueType`). Lets a damage rider scope to HP vs MP/Shield — e.g.
      // Adversity's "+2 damage" must NOT inflate Drain Spirit's MP burn (MP loss is
      // not "damage" in FU). Absent valueType defaults to "hp" so legacy HP riders
      // and contexts without the field still read DAMAGE_IS_HP == 1 (backward-safe).
      case "DAMAGE_IS_HP": return String(payload?.valueType ?? "hp").toLowerCase() === "hp" ? 1 : 0;
      case "DAMAGE_IS_MP": return String(payload?.valueType ?? "").toLowerCase() === "mp" ? 1 : 0;
      // How far an incoming attack fell SHORT of the defender's Defense
      // (DEF − accuracy total), threaded onto the creature_miss_action payload by
      // the §7d emit. Matador's Fancy Footwork gates on it: "if their Accuracy
      // check is at least 【6 − SL】 lower than your Defense" → `MISS_MARGIN >= 6 - SL`.
      // 0 when no margin is in the payload (so a `>= n` gate fails closed).
      case "MISS_MARGIN": return Number(payload?.missMargin ?? 0) || 0;
      // ARCANE is a weapon FAMILY (not a range), so it correctly reads weaponType.
      case "ATTACK_IS_ARCANE": return String(payload?.weaponType ?? "").toLowerCase() === "arcane" ? 1 : 0;
      // Which Defense the in-flight attack's Check resolves against — the
      // "strike" (vs DEF) vs "magic" (vs MDEF) axis the damage engine + card
      // labels use, threaded onto the creature_targeted_by_action payload as
      // `defenseResolved` ("def" | "mdef" | null). Lets a Defense-specific
      // reaction gate to attacks it can actually mitigate: Verónica's +2 DEF
      // fires on ATTACK_VS_DEF == 1, skipping offensive spells / mdef-tagged
      // weapon Attacks (Arc Wand) that resolve vs Magic Defense. BOTH read 0
      // when no accuracy Check was rolled (auto-hit / non-Check action, where
      // defenseResolved is null) → a `== 1` gate fails closed.
      case "ATTACK_VS_DEF":  return payload?.defenseResolved === "def"  ? 1 : 0;
      case "ATTACK_VS_MDEF": return payload?.defenseResolved === "mdef" ? 1 : 0;
      // The in-flight action's Accuracy Check total Result (post-roll). Threaded
      // onto the creature_targeted_by_action payload at CONFIRM so a reaction to
      // an incoming attack can scale by it — Crossfire spends MP equal to the
      // attacker's Accuracy Result. 0 when no roll info is in the payload.
      case "ATTACK_CHECK_RESULT": return Number(payload?.checkTotal ?? 0) || 0;
      // 1 if the in-flight attack's Accuracy Check was a critical success / a
      // fumble. Used as a gate (Crossfire "has no effect if the Accuracy Check
      // was a critical success" → condition `ATTACK_IS_CRIT == 0`). 0 when no
      // roll info is threaded, so a `== 0` gate passes by default.
      case "ATTACK_IS_CRIT": return payload?.isCrit ? 1 : 0;
      case "ATTACK_IS_FUMBLE": return payload?.isFumble ? 1 : 0;
      // The two FACES the in-flight Check rolled (die A = rA, die B = rB). 0 when
      // no roll is threaded. Lets a reaction reference the actual rolled value —
      // primarily for live menu-label interpolation (Lucky Seven's die picker
      // shows "First die: 3 → 7"); the attribute NAMES travel as string vars
      // (CHECK_DIE_A_ATTR / _B_ATTR), not here, since formulas are numeric.
      case "CHECK_DIE_A": return Number(payload?.rollDieA ?? 0) || 0;
      case "CHECK_DIE_B": return Number(payload?.rollDieB ?? 0) || 0;
      // The flat check modifier (Accuracy/Magic bonus) on the in-flight Check.
      // Lets a menu compute a post-swap total = kept die + new die + CHECK_BONUS.
      case "CHECK_BONUS": return Number(payload?.rollCheckBonus ?? 0) || 0;
      // TRIGGER_IS_SELF — 1 when the action that fired this trigger IS this
      // reaction's own carrier skill, else 0. Scopes on-hit riders (Bite's
      // grappled bonus, Flame Breath's Burn, Sting's Oil) to the skill that
      // owns them so they don't cross-fire on every OTHER damaging action the
      // monster takes (the unscoped-rider cross-contamination bug). The
      // carrier item is `skill` — evaluateConditionFormula passes the
      // reaction's source item as the resolver's `skill`. The triggering
      // action's item uuid is threaded onto the payload as `weaponUuid`
      // (Attack path), `spellUuid` (Skill/Spell path), or `skillUuid`. For an
      // NPC attack the pseudo-weapon's uuid IS the attack skill's item uuid,
      // so `weaponUuid` matches. Author as `condition_formula:
      // "TRIGGER_IS_SELF == 1 && chance(50)"` to keep the working chance/status
      // gate AND scope it. Returns 0 when no carrier or no action uuid is
      // threaded → a `== 1` gate fails closed (rider simply won't fire).
      case "TRIGGER_IS_SELF": {
        const carrierUuid = String(skill?.uuid ?? "").trim();
        if (!carrierUuid) return 0;
        const ids = [payload?.weaponUuid, payload?.spellUuid, payload?.skillUuid];
        return ids.some((u) => u && String(u).trim() === carrierUuid) ? 1 : 0;
      }
      // SUBJECT_IS_SELF — 1 when the trigger's SUBJECT (the creature the event
      // HAPPENED TO, e.g. the damage victim on creature_takes_damage) IS the
      // reactor, else 0. The subject-side twin of the matcher's
      // reaction_source:"self" — distinct from TRIGGER_IS_SELF, which tests the
      // triggering ACTION's carrier, not the subject. Use `SUBJECT_IS_SELF == 0`
      // to scope a reaction to "another creature" (RAW "when ANOTHER creature
      // loses HP …", Beyond the Realms of Death). Correct for linked PCs (Keren);
      // matches by actor uuid (with a resolved-actor fallback). Returns 0 when no
      // subject is threaded.
      case "SUBJECT_IS_SELF": {
        const subjectUuid = String(payload?.subjectActorUuid ?? "").trim();
        if (!subjectUuid) return 0;
        const selfUuid = String(actor?.uuid ?? "").trim();
        if (selfUuid && subjectUuid === selfUuid) return 1;
        const subj = _resolveActorByUuidSync(subjectUuid);
        if (subj && actor && subj.uuid === actor.uuid) return 1;
        return 0;
      }
      // CAUSE_IS_SELF — 1 when THIS reactor is the CAUSE/applier of the trigger
      // (the creature who applied the status on creature_status_applied, the
      // attacker on a resource-ledger event, …), else 0. The cause-side twin of
      // SUBJECT_IS_SELF. Powers "when YOU apply a status …" gear reactions
      // (Skull Orb). Reads payload.causeActorUuid; matches by actor uuid with a
      // resolved-actor fallback (correct for linked PCs). 0 when no cause threaded.
      case "CAUSE_IS_SELF": {
        const causeUuid = String(payload?.causeActorUuid ?? "").trim();
        if (!causeUuid) return 0;
        const selfUuid = String(actor?.uuid ?? "").trim();
        if (selfUuid && causeUuid === selfUuid) return 1;
        const c = _resolveActorByUuidSync(causeUuid);
        if (c && actor && c.uuid === actor.uuid) return 1;
        return 0;
      }
      // 1 when the trigger SUBJECT is a Phantasm that THIS reactor summoned —
      // reads the event payload (summonedBy + isPhantasm), NOT the live token, so
      // it still matches after the phantasm despawns (destroy_summon stamps both
      // into the creature_defeated payload before removing the token). Powers
      // Phantasmal Echo ("recover MP when MY phantasm is shattered"). summonedBy
      // is the summoner's ACTOR uuid (= the reactor's actor uuid).
      case "SUBJECT_IS_MY_PHANTASM": {
        if (!payload?.isPhantasm) return 0;
        const by = String(payload?.summonedBy ?? "").trim();
        const me = String(actor?.uuid ?? "").trim();
        return (by && me && by === me) ? 1 : 0;
      }
      // 1 when the trigger SUBJECT is any summon I created (phantasm OR not) —
      // the phantasm-agnostic twin of SUBJECT_IS_MY_PHANTASM. Reads the event
      // payload's `summonedBy` (the summoner's ACTOR uuid, stamped on every
      // director summon token) so it still matches after the summon despawns
      // (creature_defeated carries summonedBy before token removal). Powers the
      // reanimated-minion lifecycle (Birth of the Cruel): "when MY minion is
      // destroyed, restore the Grave Toll" fires regardless of phantasm-ness.
      case "SUBJECT_IS_MY_SUMMON": {
        const by = String(payload?.summonedBy ?? "").trim();
        const me = String(actor?.uuid ?? "").trim();
        return (by && me && by === me) ? 1 : 0;
      }
      default:
        // Dynamic VAR_<NAME> — a chain-local variable captured earlier in the
        // SAME effect chain. `prompt_number` stores the player's entered amount
        // under `prompt_var`; later rows read it back as VAR_<NAME>. Stashed on
        // payload._chainVars so it rides the per-target resolver every consumer
        // builds. Name grammar: VAR_MOVE_AMOUNT → key "move_amount" (lowercased;
        // underscores kept, unlike the AE-name identifiers). 0 when unset.
        if (name.startsWith("VAR_")) {
          const key = name.slice("VAR_".length).toLowerCase().trim();
          const vars = payload?._chainVars;
          return vars ? (Number(vars[key]) || 0) : 0;
        }
        // Dynamic TRIGGER_DAMAGE_IS_<ELEMENT> identifier — 1 when the damage
        // event that fired this trigger was of <ELEMENT>, else 0. Reads
        // `payload.element` (fire/ice/bolt/earth/air/light/dark/physical/poison),
        // populated on creature_lose_resource / creature_gain_resource and the
        // damage-event payloads. The tokenizer has NO string literals, so the
        // element is baked into the identifier name (lowercased), mirroring
        // HAS_SKILL_<NAME>/AE_COUNT_<NAME>. Examples:
        //   TRIGGER_DAMAGE_IS_ICE  → 1 if the killing/dealt damage was Ice
        //   TRIGGER_DAMAGE_IS_FIRE → 1 if Fire
        // "Reduced to 0 by NON-Ice" = `CUR_HP <= 0 && TRIGGER_DAMAGE_IS_ICE == 0`
        // (Fire Slime's Flame Burst). Returns 0 when the payload carries no
        // element (e.g. cost/drain losses) → an `== 0` non-X gate reads true.
        if (name.startsWith("TRIGGER_DAMAGE_IS_")) {
          const want = name.slice("TRIGGER_DAMAGE_IS_".length).replace(/_/g, " ").toLowerCase().trim();
          const got = String(payload?.element ?? "").toLowerCase().trim();
          return got && got === want ? 1 : 0;
        }
        // Dynamic HAS_SKILL_<NAME> identifier — "Does this actor own
        // a skill named <NAME>?". Returns 1 / 0. The tokenizer
        // doesn't support string literals, so the skill name is
        // baked into the identifier: spaces become underscores,
        // case is uppercased. Examples:
        //   HAS_SKILL_PILLAGE      → "Pillage"
        //   HAS_SKILL_SOUL_STEAL   → "Soul Steal"
        //   HAS_SKILL_SEE_YOU_LATER → "See You Later"
        // Used by Pillage to gate Soul Steal's multi-target option,
        // and by any other cross-skill requirement check.
        if (name.startsWith("HAS_SKILL_")) {
          const needle = name
            .slice("HAS_SKILL_".length)
            .replace(/_/g, " ")
            .toLowerCase()
            .trim();
          return hasNamedSkill(actor, needle) ? 1 : 0;
        }
        // Dynamic HAS_WEAPON_CATEGORY_<X> — 1 if the actor has an EQUIPPED weapon
        // of family <X> (dagger, flail, sword, …), else 0. Generalizes the fixed
        // HAS_ARCANE_WEAPON / HAS_FIREARM cases to ANY category so authors don't
        // need a per-family hardcoded identifier. Name grammar mirrors HAS_SKILL_:
        //   HAS_WEAPON_CATEGORY_DAGGER → "dagger".  HAS_WEAPON_CATEGORY_FLAIL → "flail".
        // Used by Consume's "arcane, dagger or flail weapon equipped" gate.
        if (name.startsWith("HAS_WEAPON_CATEGORY_")) {
          const fam = name
            .slice("HAS_WEAPON_CATEGORY_".length)
            .replace(/_/g, " ")
            .toLowerCase()
            .trim();
          return hasEquippedWeaponOfType(actor, fam) ? 1 : 0;
        }
        // Dynamic FLAG_<NAME> — reads the namespaced actor flag
        // flags["fabula-ultima-companion"].<name> as a number (default 0). This is how
        // GEAR exposes a tunable parameter to a SKILL's formula WITHOUT the skill ever
        // enumerating gear: each item carries an equip-gated AE that SETS the flag, and
        // the skill reads FLAG_<NAME> with its own default. The dependency inverts — the
        // 11th weapon is pure data (author its AE); the skill/engine never change.
        // (Cataclysm's overcharge cap: Arc Wand sets `cataclysm_mp_cap`; the skill falls
        // back to its default when the flag is 0.) Same "scope lives in the flag NAME"
        // idiom as check_mod_* / damage_dealt_mult_* / skill_level_bonus_*.
        if (name.startsWith("FLAG_")) {
          const key = name.slice("FLAG_".length).toLowerCase().trim();
          const v = actor?.flags?.["fabula-ultima-companion"]?.[key];
          return Number(v) || 0;
        }
        // Dynamic SKILL_HAS_TAG_<X> — 1 if the ACTION's skill (the one that fired the
        // trigger) carries tag <X> in its `skill_tags`, else 0. The trigger payload
        // forwards the acting skill's tags as `payload.skillTags` (a comma/space list);
        // this reads them WITHOUT a doc lookup so it stays a sync formula. General
        // tag-gated-reaction primitive — Maid Cap's craft discount gates on
        // SKILL_HAS_TAG_POTION / SKILL_HAS_TAG_MAGISPHERE. Name grammar: underscores → spaces.
        if (name.startsWith("SKILL_HAS_TAG_")) {
          const needle = name.slice("SKILL_HAS_TAG_".length).replace(/_/g, " ").toLowerCase().trim();
          const tags = String(payload?.skillTags ?? "")
            .split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
          return tags.includes(needle) ? 1 : 0;
        }
        // Dynamic AFFECTED_BY_<TAG> — 1 if a `<tag>`-tagged Active Effect ACTUALLY
        // APPLIED its damage-increase to the hit that fired this trigger, else 0.
        // The resource-ledger stamps `payload.appliedEffectTags` with the tags of
        // every AE whose `damage_taken_increased_<element>` bump contributed to
        // THIS hit — element-gated, so an effect inert for the dealt element is NOT
        // listed (an Invoker Hex covering {bolt,fire} reads AFFECTED_BY_HEX == 1 on
        // a fire hit but 0 on an ice hit). General "react when the damage was
        // amplified by a <tag> effect" primitive; the Invoker's Ripples gates on
        // AFFECTED_BY_HEX. Provenance is by-tag, not mere AE presence — a hex
        // sitting on the target that didn't touch this element does NOT count.
        if (name.startsWith("AFFECTED_BY_")) {
          const needle = name.slice("AFFECTED_BY_".length).replace(/_/g, " ").toLowerCase().trim();
          const tags = Array.isArray(payload?.appliedEffectTags) ? payload.appliedEffectTags : [];
          return tags.map((t) => String(t ?? "").toLowerCase().trim()).includes(needle) ? 1 : 0;
        }
        // Dynamic ANY_TARGET_HAS_MY_<STATUS> — per-applier twin of
        // ANY_TARGET_HAS_<STATUS>: 1 if ANY of the action's targets carries the
        // named status/AE THAT THIS ACTOR APPLIED (the AE's directorAppliedBy
        // applier == the resolver actor; TOKEN-first, actor-uuid fallback — same
        // rule as TARGET_GRAPPLED_BY_SELF so sibling NPC tokens don't cross-
        // credit). Generic "I get a bonus while acting against a creature I
        // marked" gate; Cognitive Focus's "+SL accuracy when my focus is among
        // the targets" uses ANY_TARGET_HAS_MY_FOCUS (status fud-focus). MUST be
        // tested before the plain ANY_TARGET_HAS_ branch below — startsWith would
        // otherwise consume the "MY_…" and read needle = "my <status>".
        if (name.startsWith("ANY_TARGET_HAS_MY_")) {
          const needle = name
            .slice("ANY_TARGET_HAS_MY_".length)
            .replace(/_/g, " ")
            .toLowerCase()
            .trim();
          const list = payload?.targetActorUuids
            ?? payload?.hitTargets ?? payload?.targets ?? payload?.targetTokenUuids ?? [];
          const selfTokenUuid = String(payload?.sourceTokenUuid ?? "").trim();
          const selfActorUuid = String(actor?.uuid ?? "").trim();
          for (const ref of (Array.isArray(list) ? list : [])) {
            const a = _resolveActorByUuidSync(String(ref));
            if (a && actorHasNamedStatusFromApplier(a, needle, selfTokenUuid, selfActorUuid)) return 1;
          }
          return 0;
        }
        // Dynamic ANY_TARGET_HAS_<STATUS> — 1 if ANY creature in the trigger's
        // target list has the named status, else 0. Scans payload.targetActorUuids
        // (falls back to hitTargets / targets / targetTokenUuids — token OR actor
        // uuids both resolve via _resolveActorByUuidSync). Matches by FU status id
        // (statuses[] contains the needle, so "weak" matches "fud-weak") OR by AE
        // name. Used by Fear Is the Key's "at least one [damaged enemy] is Shaken
        // and/or Weak" gate on the per-action creature_completes_action trigger.
        if (name.startsWith("ANY_TARGET_HAS_")) {
          const needle = name
            .slice("ANY_TARGET_HAS_".length)
            .replace(/_/g, " ")
            .toLowerCase()
            .trim();
          const list = payload?.targetActorUuids
            ?? payload?.hitTargets ?? payload?.targets ?? payload?.targetTokenUuids ?? [];
          for (const ref of (Array.isArray(list) ? list : [])) {
            const a = _resolveActorByUuidSync(String(ref));
            if (a && actorHasNamedStatus(a, needle)) return 1;
          }
          return 0;
        }
        // Dynamic HAS_STATUS_<NAME> — 1 if the RESOLVER's own actor carries the
        // named status, else 0. Twin of ANY_TARGET_HAS_<STATUS>, but reads
        // `actor` (the resolver subject) instead of scanning a target list — so
        // it works inside a per-candidate `target_filter` (skill-targeting.js),
        // where `actor` is the candidate being kept-or-dropped. Matches by FU
        // status id (statuses[] contains the needle, "shaken" → "fud-shaken")
        // OR by AE name. Powers Cognitive Focus's "enemy must be Dazed/Enraged/
        // Shaken" pool filter: target_filter "HAS_STATUS_DAZED + HAS_STATUS_ENRAGED
        // + HAS_STATUS_SHAKEN" (kept when > 0).
        if (name.startsWith("HAS_STATUS_")) {
          const needle = name
            .slice("HAS_STATUS_".length)
            .replace(/_/g, " ")
            .toLowerCase()
            .trim();
          return (actor && actorHasNamedStatus(actor, needle)) ? 1 : 0;
        }
        // Dynamic SL_<NAME> — current SL of a named owned skill, 0 if
        // not owned. Cross-skill arithmetic gate: Dual Shieldbearer's
        // Twin Shields virtual weapon uses `SL_DEFENSIVE_MASTERY` to add
        // the bearer's Defensive Mastery SL as bonus damage. Same name
        // grammar as HAS_SKILL_<NAME>: underscores → spaces,
        // case-insensitive match.
        if (name.startsWith("SL_")) {
          const needle = name
            .slice("SL_".length)
            .replace(/_/g, " ")
            .toLowerCase()
            .trim();
          return getNamedSkillLevel(actor, needle);
        }
        // Dynamic GADGET_<TYPE>_TIER — the unlock tier of a branch of the
        // consolidated Tinkerer "Gadgets" meta-skill, read off the CARRIER
        // skill's props (mirrors how SL reads skill.system.props.level). With
        // one Gadgets skill holding all branches, "which types/tiers the
        // character has" lives in numeric props on that item:
        //   gadget_infusion_tier / gadget_alchemy_tier / gadget_magitech_tier
        //   0 = none, 1 = basic, 2 = advanced, 3 = superior
        // Used by per-infusion condition_formula gates, e.g.
        //   GADGET_INFUSION_TIER >= 2  (Advanced infusions: Cyclone/Exorcism/…)
        // Returns 0 when the prop is absent → the option is dropped by the
        // affordability/menu walker, giving a tier-appropriate menu for free.
        if (name.startsWith("GADGET_") && name.endsWith("_TIER")) {
          const branch = name
            .slice("GADGET_".length, name.length - "_TIER".length)
            .toLowerCase()
            .trim();
          return Number(skill?.system?.props?.[`gadget_${branch}_tier`] ?? 0) || 0;
        }
        // Dynamic COMBAT_MAX_AE_CHARGES_<NAME> — the HIGHEST charge total of the
        // named status across ALL combatants in the current encounter (0 if no
        // combat / nobody carries it). A field-wide scan (not reactor- or
        // subject-scoped), for a lifecycle reaction that must gate on "does ANY
        // creature carry N stacks?" — Pyrefly's Funeral Pyre fires at turn_end
        // only when COMBAT_MAX_AE_CHARGES_BURN >= 10. Sync (combatants + their
        // actors are in-memory). Must be tested before AE_CHARGES_ below, but the
        // COMBAT_ prefix already disambiguates.
        //
        // Combatant SOURCE: a Battle Director fight runs its OWN combat model
        // (director.dCombat) and does NOT populate Foundry's `game.combat` — so
        // reading `game.combat.combatants` returns 0 in every BD battle (the
        // original bug: this gate never passed under BD). Prefer the active
        // director's dCombat.combatants; fall back to `game.combat` for the
        // legacy / non-BD path. DirectorCombatant exposes the live actor as
        // `.actor` / `.actorDoc`; a core Combatant exposes `.actor` / `.token.actor`.
        if (name.startsWith("COMBAT_MAX_AE_CHARGES_")) {
          const needle = name
            .slice("COMBAT_MAX_AE_CHARGES_".length)
            .replace(/_/g, " ")
            .toLowerCase()
            .trim();
          let combatants = [];
          try {
            const dc = globalThis?.FUCompanion?.api?.experimental?.battleDirector
              ?.getActiveDirector?.()?.dCombat;
            if (dc?.combatants) {
              combatants = Array.isArray(dc.combatants)
                ? dc.combatants
                : Object.values(dc.combatants);
            }
          } catch (_) { /* no director / API — fall through to core combat */ }
          if (!combatants.length) {
            combatants = game?.combat?.combatants?.contents
              ?? Array.from(game?.combat?.combatants ?? []);
          }
          let best = 0;
          for (const c of combatants) {
            const a = c?.actor ?? c?.actorDoc ?? c?.token?.actor ?? null;
            if (!a) continue;
            const effects = a?.effects?.contents ?? Array.from(a?.effects ?? []);
            const total = effects
              .filter((e) => !e.disabled && aeNameForNeedle(e?.name) === needle)
              .reduce((sum, e) => sum + (Number(e?.flags?.["fabula-ultima-companion"]?.charges ?? 0) || 0), 0);
            if (total > best) best = total;
          }
          return best;
        }
        // Dynamic AE_COUNT_<NAME> identifier — counts non-disabled AEs
        // with the given name on the reactor. Spaces → underscores,
        // case-insensitive. Examples:
        //   AE_COUNT_BURN      → number of "Burn" AEs on the actor
        //   AE_COUNT_SOUL_LINK → number of "Soul Link" AEs
        // Counts AE INSTANCES (presence), NOT charges — for stack/charge totals
        // (e.g. Burn stacks under the charge-as-stack model) use AE_CHARGES_<NAME>.
        if (name.startsWith("AE_COUNT_")) {
          const needle = name
            .slice("AE_COUNT_".length)
            .replace(/_/g, " ")
            .toLowerCase()
            .trim();
          const effects = actor?.effects?.contents ?? Array.from(actor?.effects ?? []);
          return effects.filter(
            (e) => !e.disabled && aeNameForNeedle(e?.name) === needle
          ).length;
        }
        // Dynamic AE_CHARGES_<NAME> — sums charges across all non-disabled
        // AEs with the given name. Works for both the single-AE-with-charges
        // model (returns that AE's charge count) and the multi-AE stacking
        // model (returns 0 for chargeless AEs, sum for any that have charges).
        // Examples:
        //   AE_CHARGES_BURN → total charges on all "Burn" AEs (e.g. 3)
        if (name.startsWith("AE_CHARGES_")) {
          const needle = name
            .slice("AE_CHARGES_".length)
            .replace(/_/g, " ")
            .toLowerCase()
            .trim();
          const effects = actor?.effects?.contents ?? Array.from(actor?.effects ?? []);
          return effects
            .filter((e) => !e.disabled && aeNameForNeedle(e?.name) === needle)
            .reduce((sum, e) => sum + (Number(e?.flags?.["fabula-ultima-companion"]?.charges ?? 0) || 0), 0);
        }
        // Dynamic TARGET_AE_CHARGES_<NAME> — same as AE_CHARGES_<NAME> but
        // reads from the trigger's SUBJECT (the attack target) rather than
        // the reactor. Uses payload.subjectActorUuid (sync lookup).
        // Used by Blaze-style passives that consume stacks on the TARGET.
        //   TARGET_AE_CHARGES_BURN → total Burn charges on the target
        if (name.startsWith("TARGET_AE_CHARGES_")) {
          const needle = name
            .slice("TARGET_AE_CHARGES_".length)
            .replace(/_/g, " ")
            .toLowerCase()
            .trim();
          const subjectUuid = String(payload?.subjectActorUuid ?? "").trim();
          const subject = subjectUuid ? _resolveActorByUuidSync(subjectUuid) : null;
          if (!subject) {
            // Subject removed (e.g. a lethal KO deleted the token). Fall back to
            // the pre-damage snapshot on the trigger payload. See
            // captureSubjectSnapshot in snapshot.js.
            const snap = payload?.subjectSnapshot;
            if (!snap?.effects) return 0;
            return snap.effects
              .filter((e) => aeNameForNeedle(e?.name) === needle)
              .reduce((sum, e) => sum + (Number(e?.charges ?? 0) || 0), 0);
          }
          const effects = subject?.effects?.contents ?? Array.from(subject?.effects ?? []);
          return effects
            .filter((e) => !e.disabled && aeNameForNeedle(e?.name) === needle)
            .reduce((sum, e) => sum + (Number(e?.flags?.["fabula-ultima-companion"]?.charges ?? 0) || 0), 0);
        }
        // Dynamic TARGET_AE_COUNT_<NAME> — counts non-disabled AEs with the
        // given name on the trigger's SUBJECT (the attack target), the
        // subject-side twin of AE_COUNT_<NAME>. Unlike TARGET_AE_CHARGES_<NAME>
        // (which sums the charges flag and returns 0 for a chargeless AE), this
        // is a pure PRESENCE check — correct for status conditions that don't
        // carry charges (e.g. Grappled). Used by Bite's "deals 50% more on a
        // Grappled creature" gate: `TARGET_AE_COUNT_GRAPPLED > 0`.
        //   TARGET_AE_COUNT_GRAPPLED → number of "Grappled" AEs on the target
        if (name.startsWith("TARGET_AE_COUNT_")) {
          const needle = name
            .slice("TARGET_AE_COUNT_".length)
            .replace(/_/g, " ")
            .toLowerCase()
            .trim();
          const subjectUuid = String(payload?.subjectActorUuid ?? "").trim();
          const subject = subjectUuid ? _resolveActorByUuidSync(subjectUuid) : null;
          if (!subject) {
            // Subject removed — fall back to the pre-damage payload snapshot
            // (presence count). See captureSubjectSnapshot in snapshot.js.
            const snap = payload?.subjectSnapshot;
            if (!snap?.effects) return 0;
            return snap.effects.filter((e) => aeNameForNeedle(e?.name) === needle).length;
          }
          const effects = subject?.effects?.contents ?? Array.from(subject?.effects ?? []);
          return effects.filter(
            (e) => !e.disabled && aeNameForNeedle(e?.name) === needle
          ).length;
        }
        // Dynamic SPECIES_IS_<X> — 1 when the RESOLVER ACTOR's own species
        // (`system.props.species`, e.g. "HUMANOID") matches <X>, else 0. The
        // actor-side twin of TARGET_SPECIES_IS_<X> (which reads the trigger
        // SUBJECT via payload). Because it reads the resolver's actor directly,
        // it works inside a per-candidate `target_filter` (where actor = the
        // candidate token) — e.g. Love Potion "only affects Humanoid enemies":
        // target_filter "SPECIES_IS_HUMANOID == 1". Case-insensitive; underscores
        // → spaces. Actors with no species prop (PCs) return 0.
        if (name.startsWith("SPECIES_IS_")) {
          const needle = name
            .slice("SPECIES_IS_".length)
            .replace(/_/g, " ")
            .toLowerCase()
            .trim();
          const species = String(actor?.system?.props?.species ?? "")
            .replace(/_/g, " ")
            .toLowerCase()
            .trim();
          return species && species === needle ? 1 : 0;
        }
        // Dynamic RANK_IS_<X> — 1 when the RESOLVER ACTOR's NPC rank
        // (`system.props.npc_rank`, values "soldier" | "elite" | "champion")
        // matches <X>, else 0. Twin of SPECIES_IS_<X>; reads the resolver actor,
        // so it works inside a per-candidate `target_filter` (actor = candidate).
        // PCs carry no npc_rank → 0. Used by Love Potion's "no effect on Champion"
        // gate: target_filter "... && RANK_IS_CHAMPION == 0".
        if (name.startsWith("RANK_IS_")) {
          const needle = name
            .slice("RANK_IS_".length)
            .replace(/_/g, " ")
            .toLowerCase()
            .trim();
          const rank = String(actor?.system?.props?.npc_rank ?? "")
            .replace(/_/g, " ")
            .toLowerCase()
            .trim();
          return rank && rank === needle ? 1 : 0;
        }
        // Dynamic CREATURE_<X>_PRESENT — 1 if ANY creature on the scene matches <X>
        // by SPECIES or NPC RANK, else 0. Scene-scoped (combat combatants, else active-
        // scene tokens), NOT the resolver actor — a "is there an X anywhere on the
        // battlefield" gate. E.g. CREATURE_ELEMENTAL_PRESENT (Elemental Harmony's heal
        // bonus), CREATURE_CHAMPION_PRESENT. Case-insensitive; underscores → spaces.
        if (name.startsWith("CREATURE_") && name.endsWith("_PRESENT")) {
          return creaturePresentOnScene(name.slice("CREATURE_".length, name.length - "_PRESENT".length));
        }
        // Dynamic TARGET_SPECIES_IS_<X> — 1 when the trigger SUBJECT's species
        // (enemy template `system.props.species`, e.g. "UNDEAD") matches <X>,
        // else 0. Case-insensitive; underscores → spaces. Players/PCs carry NO
        // species prop, so this returns 0 for them — i.e. a `... == 0` gate
        // treats anything without species data as "not that species" (passes).
        // Used by Beyond the Realms of Death's "if they are not undead" gate:
        //   TARGET_SPECIES_IS_UNDEAD == 0
        if (name.startsWith("TARGET_SPECIES_IS_")) {
          const needle = name
            .slice("TARGET_SPECIES_IS_".length)
            .replace(/_/g, " ")
            .toLowerCase()
            .trim();
          const subjectUuid = String(payload?.subjectActorUuid ?? "").trim();
          if (!subjectUuid) return 0;
          const subject = _resolveActorByUuidSync(subjectUuid);
          if (!subject) return 0;
          const species = String(subject?.system?.props?.species ?? "")
            .replace(/_/g, " ")
            .toLowerCase()
            .trim();
          return species && species === needle ? 1 : 0;
        }
        // TARGET_IS_VILLAIN — 1 when the trigger SUBJECT (payload.subjectActorUuid)
        // is a Villain NPC (`system.props.isVillain` truthy), else 0. PCs and
        // ordinary NPCs → 0. Subject-based twin of TARGET_SPECIES_IS_<X> (reads the
        // defeated/triggering creature, not the resolver). Powers Birth of the
        // Cruel's "non-Villain NPC" reanimation gate: `... && TARGET_IS_VILLAIN == 0`.
        if (name === "TARGET_IS_VILLAIN") {
          const subjectUuid = String(payload?.subjectActorUuid ?? "").trim();
          if (!subjectUuid) return 0;
          const subject = _resolveActorByUuidSync(subjectUuid);
          if (!subject) return 0;
          return subject?.system?.props?.isVillain ? 1 : 0;
        }
        // Dynamic TARGET_HAS_MY_<STATUS> — PER-TARGET twin of
        // ANY_TARGET_HAS_MY_<STATUS>: 1 when the SINGLE subject being evaluated
        // (payload.subjectActorUuid) carries the named status/AE THAT THIS ACTOR
        // APPLIED. Used by per-target adjustments (adjust_scope:"per_target") that
        // gate on the specific target — e.g. Cognitive Focus's heal-amp only
        // boosts the heal to the focus target. Mirrors TARGET_GRAPPLED_BY_SELF
        // (subject = target, applier = reactor/self).
        if (name.startsWith("TARGET_HAS_MY_")) {
          const needle = name
            .slice("TARGET_HAS_MY_".length)
            .replace(/_/g, " ")
            .toLowerCase()
            .trim();
          const subjectUuid = String(payload?.subjectActorUuid ?? "").trim();
          if (!subjectUuid) return 0;
          const subject = _resolveActorByUuidSync(subjectUuid);
          if (!subject) return 0;
          const selfTokenUuid = String(payload?.sourceTokenUuid ?? "").trim();
          const selfActorUuid = String(actor?.uuid ?? "").trim();
          return actorHasNamedStatusFromApplier(subject, needle, selfTokenUuid, selfActorUuid) ? 1 : 0;
        }
        // TARGET_GRAPPLED_BY_SELF — 1 when the trigger SUBJECT (the target) has a
        // "Grappled" AE whose grappler is THIS reactor (the acting creature),
        // else 0. Implements "deals more damage on a creature Grappled BY YOU"
        // (Bite) — not merely "Grappled by anyone" (which TARGET_AE_COUNT_GRAPPLED
        // covers). The grappler is stamped on the Grappled AE's
        // directorAppliedBy.reactorTokenUuid / reactorActorUuid at apply time
        // (see [[project_grappled_advanced_debuff]] P0). Matches TOKEN-first
        // (so one NPC token's grapple doesn't buff a sibling token sharing the
        // same base actor), with an actor-uuid fallback for linked tokens.
        if (name === "TARGET_GRAPPLED_BY_SELF") {
          const subjectUuid = String(payload?.subjectActorUuid ?? "").trim();
          if (!subjectUuid) return 0;
          const subject = _resolveActorByUuidSync(subjectUuid);
          if (!subject) return 0;
          const selfTokenUuid = String(payload?.sourceTokenUuid ?? "").trim();
          const selfActorUuid = String(actor?.uuid ?? "").trim();
          const effects = subject?.effects?.contents ?? Array.from(subject?.effects ?? []);
          for (const e of effects) {
            if (e.disabled || String(e?.name ?? "").trim().toLowerCase() !== "grappled") continue;
            const by = e.flags?.["fabula-ultima-companion"]?.directorAppliedBy;
            if (!by) continue;
            if (selfTokenUuid && by.reactorTokenUuid === selfTokenUuid) return 1;
            if (selfActorUuid && by.reactorActorUuid === selfActorUuid) return 1;
          }
          return 0;
        }
        warnUnknownIdentifier(name);
        return null;  // unknown → fold to 0 in evalNode
    }
  };
}

// Does this actor own an item whose name matches `wantedLower`
// (case-insensitive)? Skill / spell / heroic items all live on
// actor.items; the cross-skill `HAS_SKILL_<NAME>` identifier uses
// this to gate behavior on the bearer's loadout.
function hasNamedSkill(actor, wantedLower) {
  if (!actor) return false;
  const items = actor.items?.contents ?? (Array.isArray(actor.items) ? actor.items : []);
  for (const item of items) {
    if (String(item?.name ?? "").trim().toLowerCase() === wantedLower) return true;
  }
  return false;
}

// ── Identifier resolvers (kept private; surfaced through buildSkillResolver) ──

function readProp(actor, key) {
  const v = actor?.system?.props?.[key];
  return Number.isFinite(Number(v)) ? Number(v) : 0;
}

// Distinct class identities the actor owns — reads the CSB `class_list`
// dynamic table (each row { $deleted, class_name, level }), unioning
// class_name case-insensitively and skipping deleted / blank rows. Backs
// CLASS_COUNT (Ring of Onions). Mirrors camp-constants.actorHasClass's read of
// the same table.
function countDistinctClasses(actor) {
  const list = actor?.system?.props?.class_list;
  if (!list || typeof list !== "object") return 0;
  const seen = new Set();
  for (const row of Object.values(list)) {
    if (!row || row.$deleted) continue;
    const name = String(row.class_name ?? "").trim().toLowerCase();
    if (name) seen.add(name);
  }
  return seen.size;
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
    // `category`/`weapon_type` hold the weapon FAMILY (sword, bow, arcane, …)
    // while `weapon_range` holds melee/ranged. "ranged"/"melee" are ranges,
    // not families — so match against BOTH so HAS_RANGED_WEAPON /
    // HAS_MELEE_WEAPON work (via weapon_range) alongside HAS_ARCANE_WEAPON
    // and other family gates (via category).
    const cat = String(p.category ?? p.weapon_type ?? p.type ?? "").toLowerCase();
    const range = String(p.weapon_range ?? "").toLowerCase();
    if (cat === wanted || range === wanted) return true;
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

// Count of EQUIPPED items of a given `item_type` — the multi-item
// generalisation of `hasEquippedItemOfType`. Used by Dual Shieldbearer
// (`EQUIPPED_SHIELD_COUNT >= 2` to gate the Twin Shields virtual
// weapon) and by any future "wield N copies of X" rule.
function countEquippedItemsOfType(actor, item_type) {
  if (!actor) return 0;
  const wanted = String(item_type ?? "").toLowerCase();
  const items = actor.items?.contents ?? (Array.isArray(actor.items) ? actor.items : []);
  let count = 0;
  for (const item of items) {
    const p = item?.system?.props ?? {};
    if (String(p.item_type ?? "").toLowerCase() !== wanted) continue;
    if (!p.isEquipped) continue;
    count += 1;
  }
  return count;
}

// Slug a skill NAME into the suffix used by the runtime skill-level-boost
// flag family: lowercase, non-alphanumeric runs collapsed to "_", edges
// trimmed. "Capote" → "capote", "Thread the Horns" → "thread_the_horns".
export function skillNameSlug(name) {
  return String(name ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

// RUNTIME skill-level boost. Gear/effects can raise a skill's EFFECTIVE level
// at resolution time — WITHOUT persistently mutating skill.system.level — by
// carrying an AE that ADDs to a flag in the
//   flags.fabula-ultima-companion.skill_level_bonus_<slug>
// family (<slug> = skillNameSlug of the target skill's name), plus a universal
// `skill_level_bonus_all` that lifts every skill. Mirrors the check_mod_* /
// damage_dealt_mult_* idiom: the scope lives in the flag NAME, so this is fully
// data-driven with no per-skill engine branch. Matador Cape's "【Provoke】SL+1"
// rides `skill_level_bonus_capote` +1 while equipped. ADD-mode flags need no
// accumulator seeding (an absent flag reads as 0). Read by the `SL` identifier
// (both formula evaluators) and getNamedSkillLevel so SL_<NAME> reflects it too.
export function skillLevelBonus(actor, skill) {
  const fns = actor?.flags?.["fabula-ultima-companion"];
  if (!fns || !skill) return Number(fns?.skill_level_bonus_all) || 0;
  const slug = skillNameSlug(skill?.name);
  const perSkill = slug ? (Number(fns[`skill_level_bonus_${slug}`]) || 0) : 0;
  return perSkill + (Number(fns.skill_level_bonus_all) || 0);
}

// Current SL of the named skill on the actor, 0 if not owned. Used by
// the dynamic `SL_<NAME>` formula identifier — Dual Shieldbearer reads
// `SL_DEFENSIVE_MASTERY` to add the bearer's Defensive Mastery SL as
// the Twin Shields damage rider. Skill items expose level at
// `system.level`, `system.props.skill_level`, or `system.props.level`
// depending on template — check all three (same fallback chain as the
// `SL` identifier in buildSkillResolver). Includes the runtime skill-level
// boost (skillLevelBonus) so a gear-boosted skill scales SL_<NAME> too.
function getNamedSkillLevel(actor, wantedLower) {
  if (!actor) return 0;
  const items = actor.items?.contents ?? (Array.isArray(actor.items) ? actor.items : []);
  for (const item of items) {
    if (String(item?.name ?? "").trim().toLowerCase() !== wantedLower) continue;
    const lvl = Number(item?.system?.level
      ?? item?.system?.props?.skill_level
      ?? item?.system?.props?.level
      ?? 0);
    const base = Number.isFinite(lvl) ? Math.max(0, lvl) : 0;
    return base + skillLevelBonus(actor, item);
  }
  return 0;
}

// Build a per-source breakdown of an actor's damage bonus for an attack
// hand. Surfaced in the action-card Damage tooltip so the player sees
// where each +N came from (weapon base, Hoplite, Twin Shields' SL_DM,
// free-action grant, etc.).
//
// Returns: [{source: "Weapon (Muscly Arm)", amount: 5}, {source: "Hoplite", amount: 5}, ...]
//
// Strategy:
//   1. Look up the equipped item for the hand → its `damage_bonus` is the
//      weapon base. PC main reads `props.main_hand`; PC off reads
//      `props.off_hand`. NPCs lack these props and fall through to a
//      single "Weapon (name)" entry equal to weapon.damageBonus.
//   2. Walk `actor.appliedEffects` for AEs whose `changes[]` write to
//      the prop CSB stores the hand's aggregated damage_bonus
//      (`weapon1_damage` for main, `off_mod_2` for off). Each contributing
//      AE adds a `{source: ae.name, amount}` entry.
//   3. Caller appends grant entries (free-action damageBonus) after.
//
// The parsed AE contribution is an APPROXIMATION:
//   - Numeric value strings → use the number directly.
//   - `aeXxxWhen("query", "N")` gate values → use N (assumes the gate is
//     active; appliedEffects already filters disabled/suppressed AEs).
//   - Other formula values → fall through to 0 (won't surface).
// If the sum of parts doesn't match `weapon.damageBonus`, an "Other"
// entry absorbs the difference so the breakdown remains internally
// consistent. False-positive Hoplite (gate active showing as
// contributing when the slot conditions actually evaluated false) is
// caught by this reconciliation.
export function buildDamageBonusParts({ actor, weapon, hand = "main", attackGrant = null } = {}) {
  const parts = [];
  if (!weapon) return parts;
  const targetKey = hand === "off" ? "off_mod_2" : "weapon1_damage";
  const handNameKey = hand === "off" ? "off_hand" : "main_hand";
  const expectedTotal = Number(weapon.damageBonus) || 0;
  const grantAmount = attackGrant ? (Number(attackGrant.damageBonus) || 0) : 0;
  // The grant contributes outside the actor-level AE walk; expected total
  // for the AE-derived breakdown excludes it.
  const aggregateTarget = expectedTotal - grantAmount;

  // 1. Weapon base — from the equipped item.
  const handName = actor?.system?.props?.[handNameKey];
  let weaponName = weapon?.name ?? "Weapon";
  let weaponBase = 0;
  if (handName) {
    const items = actor?.items?.contents ?? (Array.isArray(actor?.items) ? actor.items : []);
    const item = items.find((i) =>
      String(i?.system?.props?.name ?? "").trim() === String(handName).trim()
      && i?.system?.props?.isEquipped);
    if (item) {
      weaponBase = Number(item.system?.props?.damage_bonus ?? 0) || 0;
      weaponName = item.name;
    }
  }
  // NPCs (no weapon_list / no main_hand): the pseudo-weapon's damageBonus IS
  // the attack's base damage, so attribute it to a named line (the attack name)
  // instead of letting it fall through to "Other (unattributed)" below.
  if (!handName && weapon) {
    weaponBase = aggregateTarget; // = weapon.damageBonus − grant
  }
  if (weaponBase !== 0 || handName) {
    parts.push({ source: handName ? `Weapon (${weaponName})` : weaponName, amount: weaponBase });
  }

  // 2. Actor AE contributions to the target prop key.
  let effs = [];
  try {
    if (actor?.appliedEffects) effs = Array.from(actor.appliedEffects);
    else if (actor?.allApplicableEffects) effs = Array.from(actor.allApplicableEffects()).filter((e) => !e.disabled);
    else if (actor?.effects?.contents) effs = actor.effects.contents;
  } catch (_e) { effs = []; }

  const gateValueRe = /^ae\w+When\s*\(\s*["'][^"']*["']\s*,\s*["']?(-?\d+(?:\.\d+)?)["']?\s*\)$/i;
  const numericRe = /^-?\d+(?:\.\d+)?$/;
  for (const ae of effs) {
    if (ae?.disabled) continue;
    for (const change of (ae?.changes ?? [])) {
      if (change.key !== targetKey) continue;
      if (Number(change.mode) !== 2) continue; // Only ADD mode counts as a contribution
      const raw = String(change.value ?? "").trim();
      let amount = 0;
      if (numericRe.test(raw)) {
        amount = Number(raw);
      } else {
        const gateMatch = raw.match(gateValueRe);
        if (gateMatch) amount = Number(gateMatch[1]) || 0;
      }
      if (amount !== 0) {
        parts.push({ source: ae.name || "Effect", amount });
      }
    }
  }

  // 3. Reconciliation — if the AE walker over- or under-counted (gate
  //    parsing approximation), absorb the difference into an "Other"
  //    entry so the displayed parts sum to weapon.damageBonus - grant.
  const parsedSum = parts.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const discrepancy = aggregateTarget - parsedSum;
  if (discrepancy !== 0) {
    parts.push({ source: "Other (unattributed)", amount: discrepancy });
  }

  // 4. Free-action grant — explicit, distinct from AE-driven bonuses.
  if (grantAmount !== 0) {
    parts.push({ source: attackGrant?.sourceLabel || "Free Action grant", amount: grantAmount });
  }

  return parts;
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

// AE-name → identifier-needle normalization. Identifier names can only carry
// [A-Z0-9_] (underscores decode to spaces), so an AE named with a HYPHEN —
// "Half-Life" — would otherwise be unreachable by the whole AE_*_<NAME>
// identifier family (needle "half life" ≠ raw "half-life"). Hyphens in the AE
// name normalize to spaces (runs collapse) before comparing.
function aeNameForNeedle(name) {
  return String(name ?? "").replace(/-/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

// True if the actor carries a non-disabled status/AE matching `needle`
// (lowercased, spaces). Matches by FU status id — `statuses[]` contains the
// needle as a substring, so "weak" matches both "weak" and "fud-weak" — or by
// exact AE name ("Weak"). Powers the ANY_TARGET_HAS_<STATUS> identifier.
function actorHasNamedStatus(actor, needle) {
  if (!actor?.effects || !needle) return false;
  const effects = actor.effects.contents ?? Array.from(actor.effects);
  for (const e of effects) {
    if (e.disabled) continue;
    const statuses = e.statuses ? Array.from(e.statuses) : [];
    if (statuses.some((s) => String(s).toLowerCase().includes(needle))) return true;
    if (aeNameForNeedle(e?.name) === needle) return true;
  }
  return false;
}

// Per-applier twin of actorHasNamedStatus: the matching status/AE must ALSO
// have been applied by the given applier — matched TOKEN-first, then actor uuid
// (same discriminator as TARGET_GRAPPLED_BY_SELF, so one NPC token's mark doesn't
// credit a sibling token sharing the base actor). Powers ANY_TARGET_HAS_MY_<STATUS>.
export function actorHasNamedStatusFromApplier(actor, needle, applierTokenUuid, applierActorUuid) {
  if (!actor?.effects || !needle) return false;
  const effects = actor.effects.contents ?? Array.from(actor.effects);
  for (const e of effects) {
    if (e.disabled) continue;
    const statuses = e.statuses ? Array.from(e.statuses) : [];
    const matches = statuses.some((s) => String(s).toLowerCase().includes(needle))
      || aeNameForNeedle(e?.name) === needle;
    if (!matches) continue;
    const by = e.flags?.["fabula-ultima-companion"]?.directorAppliedBy;
    if (!by) continue;
    if (applierTokenUuid && by.reactorTokenUuid === applierTokenUuid) return true;
    if (applierActorUuid && by.reactorActorUuid === applierActorUuid) return true;
  }
  return false;
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
// RAW FU Status Effects — the six conditions any AE can apply. Recognised
// by their canonical Foundry status IDs so an AE with `statuses: ["weak"]`
// (regardless of provenance — Hinder pipeline, AE Manager UI, sheet edit,
// legacy template) counts toward TARGET_STATUS_COUNT. The opt-in
// `system.tags: ["debuff"]` path (and AEM/flag classifiers) still apply,
// for AEs whose status array doesn't match a RAW debuff but the author
// wants counted (e.g. Vismagus's custom "Sluggish" debuff).
const RAW_DEBUFF_STATUSES = new Set([
  "weak", "dazed", "shaken", "slow", "enraged", "poisoned",
]);

function countStatusDebuffs(actor) {
  // Single source of truth: delegate to the shared identifier registry when
  // present (see scripts/shared/identifier-registry.js). The body below is a
  // fail-soft fallback for the case the registry hasn't loaded.
  const reg = globalThis["oni.IdentifierRegistry"];
  if (reg?.countDebuffs) return reg.countDebuffs(actor);
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
    // 4. statuses[] array contains a RAW FU debuff status ID. Catches
    //    AEs applied by paths that didn't tag system.tags (manual sheet
    //    placement, legacy templates, etc.) — the status ID itself is
    //    the canonical identity of a RAW debuff, so trusting it here
    //    keeps Cheap Shot et al. firing on standard debuffs regardless
    //    of how the AE landed.
    const statuses = eff.statuses;
    if (statuses && typeof statuses[Symbol.iterator] === "function") {
      let matched = false;
      for (const s of statuses) {
        if (RAW_DEBUFF_STATUSES.has(String(s).toLowerCase())) { matched = true; break; }
      }
      if (matched) { count++; continue; }
    }
  }
  return count;
}

// ── enemy distinct status counting (Zero Trigger: Strategy) ──────────────
// RAW: trigger fires when enemies collectively suffer "two or more DIFFERENT
// status effects". We union the debuff IDENTITIES across all enemy combatants
// and return the set size — two Dazed enemies = 1, one Dazed + one Slow = 2.
// Identity = a RAW status id if present, else the AE's first status id, else
// its normalized name (so custom debuffs like Burn/Frightened dedupe too).
function _combatDisposition(actor) {
  const combat = globalThis.game?.combat;
  let d = combat?.combatants?.find?.((c) => c.actor === actor)?.token?.disposition;
  if (d == null) d = actor?.prototypeToken?.disposition;
  if (d == null) {
    try { const t = actor?.getActiveTokens?.(true, true)?.[0]; d = t?.document?.disposition ?? t?.disposition; } catch {}
  }
  const n = Number(d);
  return Number.isFinite(n) ? n : null;
}

function collectDebuffStatusKeys(actor) {
  const out = new Set();
  if (!actor?.effects) return out;
  const aem = globalThis.FUCompanion?.api?.activeEffectManager;
  for (const eff of Array.from(actor.effects)) {
    if (eff.disabled) continue;
    const statuses = (eff.statuses && typeof eff.statuses[Symbol.iterator] === "function")
      ? [...eff.statuses].map((s) => String(s).toLowerCase()) : [];
    let isDebuff = false;
    let key = null;
    for (const s of statuses) { if (RAW_DEBUFF_STATUSES.has(s)) { isDebuff = true; key = s; break; } }
    if (!isDebuff) {
      let aemCat = null; try { aemCat = aem?.inferCategory?.(eff); } catch {}
      const flagCat = eff.flags?.["fabula-ultima-companion"]?.category;
      const tags = eff.system?.tags;
      if (String(aemCat ?? "").toLowerCase() === "debuff"
        || String(flagCat ?? "").toLowerCase() === "debuff"
        || (Array.isArray(tags) && tags.includes("debuff"))) {
        isDebuff = true;
      }
    }
    if (!isDebuff) continue;
    if (!key) key = statuses[0] ?? String(eff.name ?? "").trim().toLowerCase();
    if (key) out.add(key);
  }
  return out;
}

// Enemy actors relative to `actor` (opposite disposition sign). Prefers the
// Foundry combat roster, but FALLS BACK to canvas tokens — the Battle Director
// runs on its own `dCombat` and often leaves `game.combat` null, so a combat-
// only scan would miss every enemy mid-battle. Single source for every
// enemy-iterating formula (ENEMY_DISTINCT_STATUS_COUNT, ENEMY_IN_CRISIS).
// A Guest (bdGuest) is a visual-only round-end helper — invisible to enemy/ally
// COUNTS too, so it never sways an enemy's ENEMY_COUNT branch or a PC's ALLY_COUNT.
function _isGuestActor(a) { return !!foundry.utils.getProperty(a ?? {}, "flags.fabula-ultima-companion.bdGuest"); }

function enemyActorsOf(actor) {
  if (!actor) return [];
  const myDisp = _combatDisposition(actor);
  if (myDisp == null) return [];
  const out = [];
  const seen = new Set();
  const consider = (a, disp) => {
    if (!a || a === actor || seen.has(a)) return;
    if (_isGuestActor(a)) return; // guest is inert — never counted
    const d = Number(disp);
    if (!Number.isFinite(d) || d * myDisp >= 0) return; // not an enemy
    seen.add(a);
    out.push(a);
  };
  const combat = globalThis.game?.combat;
  const roster = combat?.combatants;
  if (roster && (roster.size || roster.length)) {
    for (const c of roster) consider(c.actor, c.token?.disposition ?? _combatDisposition(c.actor));
    return out;
  }
  for (const t of (globalThis.canvas?.tokens?.placeables ?? [])) {
    consider(t?.actor, t.document?.disposition ?? t.disposition);
  }
  return out;
}

function countEnemyDistinctStatuses(actor) {
  const union = new Set();
  for (const a of enemyActorsOf(actor)) {
    for (const k of collectDebuffStatusKeys(a)) union.add(k);
  }
  return union.size;
}

// True if any ENEMY of `actor` is in Crisis. Crisis is the canonical "Crisis"
// AE applied by crisis-reactor.js — matched by the `bdCrisis` flag or the
// literal name "crisis" (mirrors isCrisisAE), kept dependency-free to avoid a
// circular import. Enemy iteration goes through enemyActorsOf (canvas fallback).
function anyEnemyInCrisis(actor) {
  const inCrisis = (a) =>
    (a?.effects?.contents ?? []).some((e) => {
      if (e?.disabled) return false;
      if (e?.flags?.["fabula-ultima-companion"]?.bdCrisis === true) return true;
      return String(e?.name ?? "").trim().toLowerCase() === "crisis";
    });
  return enemyActorsOf(actor).some(inCrisis);
}

// ALLY enumeration — the mirror of enemyActorsOf (same-disposition combatants,
// excluding self; strict same-sign so neutral 0 is neither ally nor enemy).
// Backs ALLY_COUNT / ANY_ALLY_IN_CRISIS for the Guest system (a party-side
// guest heals a PC ally). Same combat-roster-then-canvas fallback as the enemy
// scan (the Battle Director often leaves game.combat null mid-battle).
function allyActorsOf(actor) {
  if (!actor) return [];
  const myDisp = _combatDisposition(actor);
  if (myDisp == null || myDisp === 0) return [];
  const out = [];
  const seen = new Set();
  const consider = (a, disp) => {
    if (!a || a === actor || seen.has(a)) return;
    if (_isGuestActor(a)) return; // guest is inert — never counted
    const d = Number(disp);
    if (!Number.isFinite(d) || d * myDisp <= 0) return; // ally = strict same-sign
    seen.add(a);
    out.push(a);
  };
  const combat = globalThis.game?.combat;
  const roster = combat?.combatants;
  if (roster && (roster.size || roster.length)) {
    for (const c of roster) consider(c.actor, c.token?.disposition ?? _combatDisposition(c.actor));
    return out;
  }
  for (const t of (globalThis.canvas?.tokens?.placeables ?? [])) {
    consider(t?.actor, t.document?.disposition ?? t.disposition);
  }
  return out;
}

// True if any ALLY of `actor` is in Crisis. Crisis = the canonical "Crisis" AE
// (bdCrisis flag or literal name) OR current HP at/below half of max — the
// fraction fallback so the gate holds even before the crisis-reactor has
// stamped the AE (and out of a director context). Powers the Guest heal gate.
function anyAllyInCrisis(actor) {
  const inCrisis = (a) => {
    const hasAe = (a?.effects?.contents ?? []).some((e) => {
      if (e?.disabled) return false;
      if (e?.flags?.["fabula-ultima-companion"]?.bdCrisis === true) return true;
      return String(e?.name ?? "").trim().toLowerCase() === "crisis";
    });
    if (hasAe) return true;
    const cur = Number(a?.system?.props?.current_hp);
    const max = Number(a?.system?.props?.max_hp);
    return Number.isFinite(cur) && Number.isFinite(max) && max > 0 && cur * 2 <= max;
  };
  return allyActorsOf(actor).some(inCrisis);
}

// 1 if `actor` currently has an Arcanum merged — any active AE flagged
// fabula-ultima-companion.arcanumMerge (the Arcanist merge/marker AE). Powers the
// ARCANUM_MERGED identifier.
function actorHasArcanumMerge(actor) {
  for (const e of (actor?.effects?.contents ?? actor?.effects ?? [])) {
    if (e?.disabled) continue;
    if (e?.flags?.["fabula-ultima-companion"]?.arcanumMerge) return true;
  }
  return false;
}

// 1 if an ALLY who carries THIS actor's Focus AE (status fud-focus, applied by
// `actor` — per-applier match) is in Crisis, else 0. Powers MY_FOCUS_IN_CRISIS
// (Life Transference's "heal an ally focus in Crisis" eligibility). Ally =
// same/neutral disposition (mirrors enemyActorsOf's `d * myDisp >= 0` test);
// self is skipped (the caller's HAS_STATUS_CRISIS covers the self branch).
function myFocusInCrisis(actor, payload) {
  if (!actor) return false;
  const selfTokenUuid = String(payload?.sourceTokenUuid ?? "").trim();
  const selfActorUuid = String(actor?.uuid ?? "").trim();
  const myDisp = _combatDisposition(actor);
  const isCrisis = (a) =>
    (a?.effects?.contents ?? []).some((e) => {
      if (e?.disabled) return false;
      if (e?.flags?.["fabula-ultima-companion"]?.bdCrisis === true) return true;
      return String(e?.name ?? "").trim().toLowerCase() === "crisis";
    });
  const consider = (a, disp) => {
    if (!a || a === actor) return false;
    const d = Number(disp);
    // ally/neutral: not an enemy (same rule as enemyActorsOf, inverted)
    const isAlly = myDisp == null || !Number.isFinite(d) || d * myDisp >= 0;
    if (!isAlly) return false;
    if (!actorHasNamedStatusFromApplier(a, "focus", selfTokenUuid, selfActorUuid)) return false;
    return isCrisis(a);
  };
  const roster = globalThis.game?.combat?.combatants;
  if (roster && (roster.size || roster.length)) {
    for (const c of roster) {
      if (consider(c.actor, c.token?.disposition ?? _combatDisposition(c.actor))) return true;
    }
    return false;
  }
  for (const t of (globalThis.canvas?.tokens?.placeables ?? [])) {
    if (consider(t?.actor, t.document?.disposition ?? t.disposition)) return true;
  }
  return false;
}

// Count live summons (incl. phantasms) THIS actor put on the field — canvas
// tokens whose `summonedBy` flag == the actor's uuid and that still carry
// isSummon/isPhantasm. Powers OWN_SUMMON_COUNT.
function ownSummonCount(actor, { numenOnly = false, phantasmOnly = false } = {}) {
  const meUuid = String(actor?.uuid ?? "").trim();
  if (!meUuid) return 0;
  const NS = "fabula-ultima-companion";
  let n = 0;
  for (const t of (globalThis.canvas?.tokens?.placeables ?? [])) {
    const td = t?.document;
    if (!td?.actor) continue;
    const f = td.flags?.[NS] ?? {};
    if (String(f.summonedBy ?? "") !== meUuid) continue;
    // Numen identity: prefer the isNumen TOKEN flag stamped by the summon effect
    // (summon_type:"numen"), so the tag travels with the spawned token no matter
    // what CSB template the base actor uses. Fall back to the legacy actor prop
    // (system.props.isNumen) for Numen actors that carry it as a template column.
    if (numenOnly) { if (f.isNumen || td.actor?.system?.props?.isNumen) n++; continue; }
    // phantasmOnly counts only Illusionist Phantasms (token flag isPhantasm,
    // stamped by the summon effect for summon_type:"phantasm" rows). The Numen
    // is a full own-turn summon — no isPhantasm flag — so it never counts here.
    if (phantasmOnly) { if (f.isPhantasm) n++; continue; }
    if (f.isSummon || f.isPhantasm) n++;
  }
  return n;
}

// Count PERSISTENT-summon minions (world Actors flagged isPersistentSummon, owned
// by this actor via summonOwnerActorUuid) — the cross-battle-authoritative twin of
// ownSummonCount. Counts the persisted Actor, not a live token, so a standing ally
// counts whether or not it's on the current field; Phantasms are never flagged
// isPersistentSummon so they never count. Powers Birth of the Cruel's one-at-a-time.
function ownPersistentSummonCount(actor) {
  const meUuid = String(actor?.uuid ?? "").trim();
  if (!meUuid) return 0;
  const NS = "fabula-ultima-companion";
  let n = 0;
  for (const a of (globalThis.game?.actors?.contents ?? [])) {
    const f = a?.flags?.[NS] ?? {};
    if (f.isPersistentSummon && String(f.summonOwnerActorUuid ?? "") === meUuid) n++;
  }
  return n;
}

// Bond data lives at `actor.system.props.bond_N` / `emotion_N_M`.
// Strength = count of non-empty emotion fields per slot (0..3).
//
// PLUS AE-carried temporary bonds: an AE on the actor stamping
// `flags.fabula-ultima-companion.bondAE = { bond_name, emotions:[…] }`
// contributes one VIRTUAL bond slot — the non-destructive bond form used by
// `create_bond` (Heart of Darkness) so a created Bond never overwrites the
// player's authored `bond_N` props. Every BOND_* identifier reads through here,
// so they all honor AE bonds automatically.
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
  // AE-carried temporary bonds (non-destructive). An AE bond OVERRIDES any
  // same-name prop/earlier bond at RUNTIME: its emotions REPLACE that slot's,
  // so e.g. Heart of Darkness's "Bond of Hatred" makes the bearer read as
  // Hatred toward the target while the AE exists, and the original prop Bond
  // returns automatically when the AE is removed (no prop is ever written —
  // pure runtime override). A name with no existing slot is added fresh. This
  // also means an AE bond never double-counts against a same-name prop bond.
  let aeIdx = 0;
  for (const eff of (actor.appliedEffects ?? actor.effects ?? [])) {
    const b = eff?.flags?.["fabula-ultima-companion"]?.bondAE;
    if (!b) continue;
    const name = String(b.bond_name ?? b.name ?? "").trim();
    if (!name) continue;
    const emotions = Array.isArray(b.emotions)
      ? b.emotions.map((e) => String(e ?? "").trim().toLowerCase()).filter(Boolean)
      : [b.emotion_1, b.emotion_2, b.emotion_3].map((e) => String(e ?? "").trim().toLowerCase());
    const existing = out.find((s) => s.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      existing.emotions = emotions;     // override the prop bond's emotions
      existing.fromAE = true;
      existing.overrodeBond = true;
    } else {
      out.push({ slot: `ae${aeIdx++}`, name, emotions, fromAE: true });
    }
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

// ════════════════════════════════════════════════════════════════════
// Actor-status modifier layer
// ════════════════════════════════════════════════════════════════════
//
// The actor sheet derives a family of "status modifier" props (accuracy,
// outgoing damage, incoming reduction, crit) that the BD resolver
// historically DROPPED — it computed an attack from weapon + attribute +
// defense + affinity only. This section is the single source of truth that
// BOTH Attack COMPUTE and Skill/Spell COMPUTE consume, so the two paths
// can't diverge.
//
// KEY-NAME CANON: the prop key names mirror apply-damage-core.js exactly
// (that file documents the full sheet mapping). Keep the two in sync.
//
// CRITICAL — do NOT read `skill_accuracy` / `skill_attack_damage` here.
// The CSB sheet already folds them into `weapon1_mod` / `weapon1_damage`
//   weapon1_mod    = weapon1_base_mod    + skill_accuracy
//   weapon1_damage = weapon1_base_damage + skill_attack_damage
// which the snapshot surfaces as `weapon.checkBonus` / `weapon.damageBonus`.
// Re-adding them would double-count. Only the *_mod_* families below are
// unaccounted-for by the snapshot.
//
// Every resolver returns a `{ source, amount }[]` parts list (same shape as
// buildDamageBonusParts) so each contribution is traceable in the action
// card Check / Damage tooltips.

const _mnum = (v) => {
  if (v === null || v === undefined) return 0;
  const n = Number(String(v).replace(/%/g, "").trim());
  return Number.isFinite(n) ? n : 0;
};

const _capWord = (s) => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1) : s);

// "Melee" | "Ranged" | "range" → "melee" | "ranged" | null
function normalizeModRange(range) {
  const s = String(range ?? "").toLowerCase().trim();
  if (s === "melee") return "melee";
  if (s === "ranged" || s === "range") return "ranged";
  return null;
}

// ── Per-AE attribution ─────────────────────────────────────────────────
// The actor sheet derives each modifier prop (e.g. check_mod_ranged)
// as the SUM of every AE that writes to it, so the prop alone can't tell us
// WHICH skill contributed. To surface the source name in the action card
// ("Ranged Weapon Mastery +1" instead of "Accuracy (Ranged) +1") we walk the
// actor's active effects and attribute the derived total to the AE(s) writing
// that key. The derived prop stays authoritative — returned parts always sum
// to it, so hit/damage math is unchanged; only the labels improve.
const _numChangeRe  = /^-?\d+(?:\.\d+)?$/;
const _gateChangeRe = /^ae\w+When\s*\(\s*["'][^"']*["']\s*,\s*["']?(-?\d+(?:\.\d+)?)["']?\s*\)$/i;

function _activeEffectsOf(actor) {
  try {
    if (actor?.appliedEffects) return Array.from(actor.appliedEffects);
    if (actor?.allApplicableEffects) return Array.from(actor.allApplicableEffects()).filter((e) => !e.disabled);
    if (actor?.effects?.contents) return actor.effects.contents;
  } catch (_e) { /* fall through */ }
  return [];
}

// Numeric value of a change, or null when unparseable (e.g. a CSB ref
// formula like "${level}$" — common on transfer passives such as RWM).
function _changeAmount(raw) {
  const s = String(raw ?? "").trim();
  if (_numChangeRe.test(s)) return Number(s);
  const g = s.match(_gateChangeRe);
  if (g) return Number(g[1]) || 0;
  return null;
}

// Attribute a derived modifier total to the AE(s) that set `key`. Returns
// `{ source, amount }[]` summing to `total`. `label` is the generic fallback
// used when no AE can be matched (base-prop value) or to absorb a parsing
// remainder. `sign` multiplies the displayed amount (-1 for reductions).
export function attributeModParts({ actor, key, total, label, sign = 1 } = {}) {
  const T = Number(total) || 0;
  if (T === 0) return [];
  const mk = (src, amt) => ({ source: src, amount: amt * sign });
  if (!actor) return [mk(label, T)];

  const contribs = [];
  for (const ae of _activeEffectsOf(actor)) {
    if (ae?.disabled) continue;
    for (const ch of (ae?.changes ?? [])) {
      if (ch?.key === key) contribs.push({ ae, change: ch });
    }
  }
  if (contribs.length === 0) return [mk(label, T)];
  // Single source — attribute the whole derived total to it. Handles the
  // common passive case (one skill → one key) including unparseable CSB
  // formula values like RWM's "${level}$".
  if (contribs.length === 1) return [mk(contribs[0].ae.name || label, T)];

  // Multiple sources — parse what we can, reconcile the remainder.
  const parts = [];
  let parsedSum = 0;
  const unparsed = [];
  for (const c of contribs) {
    const amt = _changeAmount(c.change.value);
    if (amt === null) { unparsed.push(c); continue; }
    if (amt !== 0) { parts.push(mk(c.ae.name || label, amt)); parsedSum += amt; }
  }
  const remainder = T - parsedSum;
  if (remainder !== 0) {
    // Exactly one unparsed contributor → it owns the remainder by name.
    if (unparsed.length === 1) parts.push(mk(unparsed[0].ae.name || label, remainder));
    else parts.push(mk(label, remainder));
  }
  return parts;
}

// ── Accuracy (added to the attack/spell Check total) ───────────────────
// `kind`: "melee" | "ranged" | "magic". Accuracy IS a Check, but the keys
// have different SCOPES:
//   check_mod_all       → EVERY check (request checks, accuracy, any) — the
//                         universal modifier (legacy attack_accuracy_mod_all
//                         unified here 2026-06-28).
//   check_mod_accuracy  → ALL accuracy checks, both strike (melee/ranged) AND
//                         magic (spell attacks), but NOT non-attack checks
//                         (Study/Stealth/request). Applied unconditionally for
//                         every attack kind below. Use this for "+N Accuracy"
//                         gear (Spectacles, Diver Goggle) — NOT check_mod_all.
//   check_mod_melee/ranged/magic → per-range refinement of attacks of that kind.
// `skill_accuracy` is intentionally absent (already in weapon.checkBonus,
// see header). Pass `actor` to get per-skill source names; `props` alone
// falls back to the generic label.
export function resolveAccuracyParts({ actor = null, props = null, kind = null } = {}) {
  const p = props ?? actor?.system?.props ?? null;
  if (!p) return [];
  const parts = [];
  const add = (key, label) => {
    const total = _mnum(p[key]);
    if (total !== 0) parts.push(...attributeModParts({ actor, key, total, label }));
  };
  add("check_mod_all", "Check (All)");
  add("check_mod_accuracy", "Accuracy");          // all accuracy checks (strike + magic)
  if (kind === "melee")  add("check_mod_melee",  "Check (Melee)");
  if (kind === "ranged") add("check_mod_ranged", "Check (Ranged)");
  if (kind === "magic")  add("check_mod_magic",  "Check (Magic)");
  return parts;
}

// ── Outgoing damage (added to rawDamage, pre-reduction/affinity) ───────
// `kind`: "melee" | "ranged" | "spell". `elementType` lowercased element
// (physical/fire/…). `weaponKey` lowercased weapon family (sword/bow/…) or
// null (spells / NPC attacks). `skill_attack_damage` is intentionally
// absent (already in weapon.damageBonus, see header). Pass `actor` for
// per-skill source names.
export function resolveOutgoingDamageParts({ actor = null, props = null, kind = null, elementType = null, weaponKey = null } = {}) {
  const p = props ?? actor?.system?.props ?? null;
  if (!p) return [];
  const parts = [];
  const add = (key, label) => {
    const total = _mnum(p[key]);
    if (total !== 0) parts.push(...attributeModParts({ actor, key, total, label }));
  };
  add("extra_damage_mod_all", "Damage (All)");
  if (kind === "melee")  add("extra_damage_mod_melee",  "Damage (Melee)");
  if (kind === "ranged") add("extra_damage_mod_ranged", "Damage (Ranged)");
  if (kind === "spell")  add("extra_damage_mod_spell",  "Damage (Spell)");
  if (kind === "item")   add("extra_damage_mod_item",   "Damage (Item)");
  const el = String(elementType ?? "").toLowerCase();
  if (el && !isNullElement(el)) add(`extra_damage_mod_${el}`, `Damage (${_capWord(el)})`);
  const wk = String(weaponKey ?? "").toLowerCase();
  if (wk && wk !== "none") add(`extra_damage_mod_${wk}`, `Damage (${_capWord(wk)})`);
  return parts;
}

// ── Outgoing restore modifier ──────────────────────────────────────────
// The heal/restore counterpart to resolveOutgoingDamageParts: a SINGLE source
// of truth for "+X to a resource you restore", read by BOTH the card preview
// (buildHealPerTarget) AND the apply path (applyGrantEffect) so they can never
// disagree. Families mirror the damage layer — add a line here to introduce a
// new one. Currently: `item_restore_mod` applies only to item-use actions
// (Secret Formula's passive AE), so created potions restore extra but normal
// heals are untouched. Returns a flat resource-agnostic bonus (RAW: "+SL×5 to
// each restored amount").
export function resolveRestoreParts({ actor = null, props = null, kind = null } = {}) {
  const p = props ?? actor?.system?.props ?? null;
  if (!p) return [];
  const parts = [];
  const add = (key, label) => {
    const total = _mnum(p[key]);
    if (total !== 0) parts.push(...attributeModParts({ actor, key, total, label }));
  };
  if (String(kind ?? "").toLowerCase() === "item") add("item_restore_mod", "Restore (Item)");
  return parts;
}

// Sum a parts list (resolveRestoreParts output) to a flat bonus.
export function sumRestoreParts(parts) {
  return (Array.isArray(parts) ? parts : []).reduce((s, p) => s + (Number(p?.amount) || 0), 0);
}

// ── Incoming-heal modifier (RECIPIENT side) ────────────────────────────
// The heal counterpart of apply-damage-core's `damage_receiving_*` — read off
// the HEALED actor (not the healer). `heal_receiving_mod_all` is a FRACTIONAL
// modifier on HP recovery: the recovered amount is multiplied by (1 + sum), so
// -0.5 = "incoming healing reduced by 50%" (Bleed). Clamped at 0 (a heal can
// never become damage). Read by BOTH applyGrantEffect (apply) and
// buildHealPerTarget (preview) so they can't drift. Resource-scoped by the
// caller (HP recovery only — "healing"; MP restore is untouched).
export function healReceivingMultiplier(targetActor) {
  if (!targetActor) return 1;
  // Sum the modifier straight off the bearer's active-effect changes rather than
  // system.props: unlike the damage_receiving_* family, `heal_receiving_mod_all`
  // is NOT a CSB template column, so it never surfaces to system.props (verified).
  // Reading the AE changes is column-independent and self-contained.
  let mod = 0;
  const effects = targetActor.appliedEffects ?? targetActor.effects?.contents ?? targetActor.effects ?? [];
  for (const e of effects) {
    if (e?.disabled) continue;
    for (const c of (e.changes ?? [])) {
      if (c?.key === "heal_receiving_mod_all") mod += Number(c.value) || 0;
    }
  }
  if (!mod) return 1;
  return Math.max(0, 1 + mod);
}

// Apply an `adjust_grant` op to an already-final restore amount — the heal
// counterpart of adjust_damage's op model (multiply / add / set / cap / floor).
// `adjust` is { op, value, round } (e.g. Potion Rain: multiply 0.5 round up).
// Absent / unparseable → no-op, so a non-adjusted heal is untouched. `round`
// (up default, RAW "round up") only affects fractional multiply results.
// Shared adjustment arithmetic — the ONE op table used by both damage ops
// (applyDamageOp, which delegates here) and grant adjustments (applyGrantAdjust).
// Pure integer/float math; rounding for a fractional multiply is the caller's call.
export function applyAdjustOp(base, op, value) {
  switch (op) {
    case "add":      return base + value;
    case "subtract": return base - value;
    case "multiply": return base * value;
    case "set":      return value;
    case "cap":      return Math.min(base, value); // upper bound
    case "floor":    return Math.max(base, value); // lower bound
    default:         return base;
  }
}

// Unified adjustment row reader — maps a namespaced adjustment row
// (<prefix>_operation / _amount / _round / _stage / _scope) onto ONE descriptor,
// so adjust_accuracy ("accuracy", defaultOp "set"), adjust_damage ("damage") and
// adjust_grant ("grant") parse the same way. Each handler consumes the fields it
// cares about (damage: stage; grant: round; accuracy: op/amount). `scope`
// (per_action | per_target) is the shared knob for scope-aware adjustments.
export function readAdjustment(row, prefix, { defaultOp = "add" } = {}) {
  return {
    op: String(row[`${prefix}_operation`] ?? defaultOp).trim().toLowerCase(),
    amountFormula: String(row[`${prefix}_amount`] ?? "0"),
    round: String(row[`${prefix}_round`] ?? "up").trim().toLowerCase(),
    stage: String(row[`${prefix}_stage`] ?? "outgoing").trim().toLowerCase(),
    scope: String(row[`${prefix}_scope`] ?? "per_target").trim().toLowerCase(),
  };
}

export function applyGrantAdjust(amount, adjust) {
  const a = Number(amount) || 0;
  if (!adjust) return a;
  const v = Number(adjust.value);
  if (!Number.isFinite(v)) return a;
  // Grant ops are {multiply,set,cap,floor}; anything else (incl. "add"/unknown)
  // is add — matches the legacy switch's default. Multiply rounds up unless "down".
  const op = String(adjust.op ?? "add").toLowerCase();
  const eff = (op === "multiply" || op === "set" || op === "cap" || op === "floor") ? op : "add";
  const r = applyAdjustOp(a, eff, v);
  if (eff === "multiply") return String(adjust.round ?? "up").toLowerCase() === "down" ? Math.floor(r) : Math.ceil(r);
  return r;
}

// ── Crit detection ─────────────────────────────────────────────────────
// Mirrors invokeButtons.js / checkRoller-core.js: a crit needs the two
// dice within `critical_dice_range` of each other AND at least one die >=
// `minimum_critical_dice`. Sheet defaults (minCrit 6, range 0) reproduce
// the classic "matching dice both >= 6". A fumble is never a crit.
export function resolveCritParams(props) {
  const rangeRaw = _mnum(props?.critical_dice_range);
  const critRange = rangeRaw > 0 ? rangeRaw : 0;
  const minRaw = Number(props?.minimum_critical_dice);
  const critMin = Number.isFinite(minRaw) && minRaw > 0 ? minRaw : 6;
  return { critMin, critRange };
}

export function isCriticalHit({ rA, rB, props, isFumble = false } = {}) {
  if (isFumble) return false;
  const { critMin, critRange } = resolveCritParams(props);
  return Math.abs(Number(rA) - Number(rB)) <= critRange &&
    (Number(rA) >= critMin || Number(rB) >= critMin);
}

// ── Crit damage (attacker-side; applied to rawDamage on a crit) ────────
// Mirrors apply-damage-core steps 5-6: + critical_damage_bonus then ×
// critical_damage_multiplier. Returns { value, parts }. Pass `actor` to
// attribute the flat bonus to the skill that granted it.
export function applyCritDamage({ raw, props = null, actor = null } = {}) {
  const p = props ?? actor?.system?.props ?? null;
  const parts = [];
  let v = _mnum(raw);
  const flat = _mnum(p?.critical_damage_bonus);
  if (flat !== 0) {
    v += flat;
    const named = attributeModParts({ actor, key: "critical_damage_bonus", total: flat, label: "Critical Bonus" });
    parts.push(...named);
  }
  const multRaw = Number(p?.critical_damage_multiplier);
  const mult = Number.isFinite(multRaw) && multRaw > 0 ? multRaw : 1;
  if (mult !== 1) {
    const before = v;
    v = Math.ceil(v * mult);
    parts.push({ source: `Critical ×${mult}`, amount: v - before });
  } else {
    v = Math.ceil(v);
  }
  return { value: v, parts };
}

// ── Incoming damage reduction (target-side; pre-affinity) ──────────────
// Mirrors apply-damage-core steps 3-4: flat (damage_receiving_mod_*) then
// % (damage_receiving_percentage_*). `range`: "melee" | "ranged". NOTE the
// sheet's FLAT ranged key is `damage_receiving_mod_range` (not `_ranged`)
// — quirk preserved from apply-damage-core. Returns { value, parts }
// where parts carry NEGATIVE amounts (they subtract from damage).
export function resolveIncomingReduction({ actor = null, props = null, elementType = null, range = null, raw = 0 } = {}) {
  const parts = [];
  const base = _mnum(raw);
  const p = props ?? actor?.system?.props ?? null;
  if (!p) return { value: base, parts };
  const r = normalizeModRange(range);
  const el = String(elementType ?? "").toLowerCase();

  // Flat reduction — attribute each key to the AE(s) that set it (negative
  // amounts, since reductions subtract). Falls back to the generic label.
  let flat = 0;
  const addFlat = (key, label) => {
    const v = _mnum(p[key]);
    if (v !== 0) { flat += v; parts.push(...attributeModParts({ actor, key, total: v, label, sign: -1 })); }
  };
  addFlat("damage_receiving_mod_all", "Reduction (All)");
  if (r === "melee")  addFlat("damage_receiving_mod_melee", "Reduction (Melee)");
  if (r === "ranged") addFlat("damage_receiving_mod_range", "Reduction (Ranged)");
  if (el && !isNullElement(el)) addFlat(`damage_receiving_mod_${el}`, `Reduction (${_capWord(el)})`);

  let v = base - flat;

  // % reduction (sum the family, then 1 − pct/100).
  let pct = 0;
  pct += _mnum(p.damage_receiving_percentage_all);
  if (r === "melee")  pct += _mnum(p.damage_receiving_percentage_melee);
  if (r === "ranged") pct += _mnum(p.damage_receiving_percentage_range);
  if (el && !isNullElement(el)) pct += _mnum(p[`damage_receiving_percentage_${el}`]);
  if (pct !== 0) {
    const mult = Math.max(0, 1 - pct / 100);
    const before = Math.ceil(Math.max(0, v));
    v = v * mult;
    const after = Math.ceil(Math.max(0, v));
    parts.push({ source: `Reduction (${pct}%)`, amount: after - before });
  }

  return { value: Math.max(0, Math.ceil(v)), parts };
}
