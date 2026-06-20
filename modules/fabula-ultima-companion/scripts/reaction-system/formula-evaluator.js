/**
 * [ONI] Reaction System — Formula Evaluator (Foundry VTT v12)
 * ---------------------------------------------------------------------------
 * Safe arithmetic + identifier evaluator for declarative reaction effect
 * amount fields (grant_amount and related). Replaces the hard-coded
 * `Number(amount)` path so authors can write `SL * 2` or
 * `MP_DEALT_TOTAL / 2` instead of literals.
 *
 * No `eval`, no `new Function`. A small recursive-descent parser walks a
 * whitelisted token grammar:
 *
 *   expression  := add_sub
 *   add_sub     := mul_div ( ("+" | "-") mul_div )*
 *   mul_div     := unary   ( ("*" | "/") unary   )*
 *   unary       := ("-" | "+")? primary
 *   primary     := NUMBER
 *               |  "(" expression ")"
 *               |  IDENT
 *               |  IDENT "(" args? ")"
 *   args        := expression ("," expression)*
 *
 * Identifier resolution is context-driven (see `resolveIdentifier`). Unknown
 * identifiers warn + return 0 (fail-soft). Division by zero returns 0.
 * Functions are whitelisted: floor, ceil, round, abs, min, max.
 *
 * Exposed on:  window["oni.ReactionFormula"]
 *   evaluate(expr: string, context: FormulaContext): number
 *   describeIdentifiers(): { name, description }[]
 *
 * FormulaContext shape (all optional):
 *   {
 *     reactorActor: Actor          – the actor on whose behalf the formula runs
 *     reactorToken: Token | null   – the reactor's combat token (for subject compares)
 *     firingSkill:  Item | null    – the skill/AE-synth item that owns the effect row
 *     subjectToken: Token | null   – the trigger's subject creature (for BOND_*)
 *     payload:      object | null  – the trigger phase payload (for *_DEALT_*)
 *   }
 *
 * Pairs with: reaction-grant.js (consumer), reaction-config-schema.md (docs).
 */
Hooks.once("ready", () => {
  const KEY = "oni.ReactionFormula";
  if (window[KEY]) {
    console.debug("[ReactionFormula] Already installed.");
    return;
  }
  const TAG = "[ReactionFormula]";

  // ---------------------------------------------------------------------------
  // Tokenizer
  // ---------------------------------------------------------------------------
  function tokenize(src) {
    const out = [];
    let i = 0;
    const n = src.length;
    while (i < n) {
      const c = src[i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }

      // Number: leading digit OR leading dot followed by digit
      if ((c >= "0" && c <= "9") || (c === "." && src[i+1] >= "0" && src[i+1] <= "9")) {
        let j = i;
        let dotSeen = false;
        while (j < n) {
          const cj = src[j];
          if (cj >= "0" && cj <= "9") { j++; continue; }
          if (cj === "." && !dotSeen) { dotSeen = true; j++; continue; }
          break;
        }
        out.push({ type: "NUMBER", value: Number(src.slice(i, j)), pos: i });
        i = j;
        continue;
      }

      // Identifier: letter / underscore start
      if ((c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || c === "_") {
        let j = i;
        while (j < n) {
          const cj = src[j];
          if ((cj >= "A" && cj <= "Z") || (cj >= "a" && cj <= "z") || (cj >= "0" && cj <= "9") || cj === "_") {
            j++; continue;
          }
          break;
        }
        out.push({ type: "IDENT", value: src.slice(i, j), pos: i });
        i = j;
        continue;
      }

      if (c === "+" || c === "-" || c === "*" || c === "/" || c === "%") {
        out.push({ type: "OP", value: c, pos: i });
        i++; continue;
      }
      // Two-char operators: ==, !=, <=, >=, &&, ||
      if (c === "=" && src[i+1] === "=") { out.push({ type: "OP", value: "==", pos: i }); i += 2; continue; }
      if (c === "!" && src[i+1] === "=") { out.push({ type: "OP", value: "!=", pos: i }); i += 2; continue; }
      if (c === "<" && src[i+1] === "=") { out.push({ type: "OP", value: "<=", pos: i }); i += 2; continue; }
      if (c === ">" && src[i+1] === "=") { out.push({ type: "OP", value: ">=", pos: i }); i += 2; continue; }
      if (c === "&" && src[i+1] === "&") { out.push({ type: "OP", value: "&&", pos: i }); i += 2; continue; }
      if (c === "|" && src[i+1] === "|") { out.push({ type: "OP", value: "||", pos: i }); i += 2; continue; }
      // Single-char comparison + logical-not
      if (c === "<") { out.push({ type: "OP", value: "<", pos: i }); i++; continue; }
      if (c === ">") { out.push({ type: "OP", value: ">", pos: i }); i++; continue; }
      if (c === "!") { out.push({ type: "OP", value: "!", pos: i }); i++; continue; }
      if (c === "(") { out.push({ type: "LPAREN", pos: i }); i++; continue; }
      if (c === ")") { out.push({ type: "RPAREN", pos: i }); i++; continue; }
      if (c === ",") { out.push({ type: "COMMA",  pos: i }); i++; continue; }

      throw new Error(`Unexpected character '${c}' at position ${i}`);
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Parser (recursive descent)
  // ---------------------------------------------------------------------------
  function parse(tokens, context) {
    let pos = 0;
    const peek = () => tokens[pos] ?? null;
    const consume = () => tokens[pos++] ?? null;
    const atEnd  = () => pos >= tokens.length;

    // Boolean results are represented as 1 / 0 throughout — keeps the grammar
    // and identifier resolution numeric end-to-end. Truthy = nonzero.
    const b = (v) => v ? 1 : 0;
    const truthy = (v) => v !== 0;

    function expression() { return logicalOr(); }

    function logicalOr() {
      let left = logicalAnd();
      while (!atEnd() && peek().type === "OP" && peek().value === "||") {
        consume();
        const right = logicalAnd();
        left = b(truthy(left) || truthy(right));
      }
      return left;
    }

    function logicalAnd() {
      let left = equality();
      while (!atEnd() && peek().type === "OP" && peek().value === "&&") {
        consume();
        const right = equality();
        left = b(truthy(left) && truthy(right));
      }
      return left;
    }

    function equality() {
      let left = comparison();
      while (!atEnd() && peek().type === "OP" && (peek().value === "==" || peek().value === "!=")) {
        const op = consume().value;
        const right = comparison();
        left = op === "==" ? b(left === right) : b(left !== right);
      }
      return left;
    }

    function comparison() {
      let left = addSub();
      while (!atEnd() && peek().type === "OP" &&
             (peek().value === "<" || peek().value === ">" || peek().value === "<=" || peek().value === ">=")) {
        const op = consume().value;
        const right = addSub();
        if      (op === "<")  left = b(left <  right);
        else if (op === ">")  left = b(left >  right);
        else if (op === "<=") left = b(left <= right);
        else                  left = b(left >= right);
      }
      return left;
    }

    function addSub() {
      let left = mulDiv();
      while (!atEnd() && peek().type === "OP" && (peek().value === "+" || peek().value === "-")) {
        const op = consume().value;
        const right = mulDiv();
        left = op === "+" ? (left + right) : (left - right);
      }
      return left;
    }

    function mulDiv() {
      let left = unary();
      while (!atEnd() && peek().type === "OP" &&
             (peek().value === "*" || peek().value === "/" || peek().value === "%")) {
        const op = consume().value;
        const right = unary();
        if      (op === "*") left = left * right;
        else if (op === "/") left = right === 0 ? 0 : left / right;
        else                 left = right === 0 ? 0 : left - Math.floor(left / right) * right; // %
      }
      return left;
    }

    function unary() {
      if (!atEnd() && peek().type === "OP" && (peek().value === "-" || peek().value === "+" || peek().value === "!")) {
        const op = consume().value;
        const v = unary();
        if (op === "-") return -v;
        if (op === "+") return v;
        return b(!truthy(v)); // !
      }
      return primary();
    }

    function primary() {
      const tok = peek();
      if (!tok) throw new Error("Unexpected end of expression");

      if (tok.type === "NUMBER") {
        consume();
        return tok.value;
      }

      if (tok.type === "LPAREN") {
        consume();
        const v = expression();
        if (peek()?.type !== "RPAREN") throw new Error(`Missing ')' at position ${tok.pos}`);
        consume();
        return v;
      }

      if (tok.type === "IDENT") {
        consume();
        // Function call?
        if (!atEnd() && peek().type === "LPAREN") {
          consume();
          const args = [];
          if (peek()?.type !== "RPAREN") {
            args.push(expression());
            while (!atEnd() && peek().type === "COMMA") {
              consume();
              args.push(expression());
            }
          }
          if (peek()?.type !== "RPAREN") throw new Error(`Missing ')' for function ${tok.value}`);
          consume();
          return callFunction(tok.value, args);
        }
        // Variable
        return resolveIdentifier(tok.value, context);
      }

      throw new Error(`Unexpected token '${tok.type}' at position ${tok.pos}`);
    }

    const result = expression();
    if (pos !== tokens.length) {
      throw new Error(`Trailing tokens after expression (position ${tokens[pos]?.pos ?? "?"})`);
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Function whitelist
  // ---------------------------------------------------------------------------
  const FUNCTIONS = Object.freeze({
    floor: Math.floor,
    ceil:  Math.ceil,
    round: Math.round,
    abs:   Math.abs,
    min:   Math.min,
    max:   Math.max,
  });

  function callFunction(name, args) {
    const f = FUNCTIONS[name];
    if (!f) throw new Error(`Unknown function: ${name}`);
    return f(...args);
  }

  // ---------------------------------------------------------------------------
  // Identifier resolution
  // ---------------------------------------------------------------------------
  const BOND_SLOTS   = Object.freeze(["1","2","3","4","5","6","temp"]);
  const EMOTION_PAIR = Object.freeze({
    admiration:  1, inferiority: 1,
    loyalty:     2, mistrust:    2,
    affection:   3, hatred:      3,
  });

  function _norm(v) { return String(v ?? "").trim().toLowerCase(); }

  // Returns the bond entry whose `name` matches the subject token's actor
  // or token name (case-insensitive). Aggregates props slots + AE-borne bonds
  // via BondUpdater.readBondsAll.
  function _bondMatchingSubject(reactorActor, subjectToken) {
    if (!subjectToken) return null;
    const an = _norm(subjectToken?.actor?.name);
    const tn = _norm(subjectToken?.document?.name ?? subjectToken?.name);
    const bonds = globalThis.BondUpdater?.readBondsAll?.(reactorActor) ?? [];
    for (const b of bonds) {
      const bn = _norm(b?.name);
      if (!bn) continue;
      if (bn === an || (tn && bn === tn)) return b;
    }
    return null;
  }

  function _bondStrength(bond) {
    if (!bond) return 0;
    return (_norm(bond.e1) ? 1 : 0) + (_norm(bond.e2) ? 1 : 0) + (_norm(bond.e3) ? 1 : 0);
  }

  function _countBondsAny(reactorActor) {
    const bonds = globalThis.BondUpdater?.readBondsAll?.(reactorActor) ?? [];
    return bonds.length;
  }

  function _countStatusesOnActor(reactorActor) {
    if (!reactorActor) return 0;
    const inferCategory = globalThis?.FUCompanion?.api?.activeEffectRegistry?._internal?.inferCategory;
    if (typeof inferCategory !== "function") return 0;
    const effects = reactorActor.effects?.contents ?? reactorActor.effects ?? [];
    let n = 0;
    for (const e of effects) {
      if (!e || e.disabled || e.isSuppressed) continue;
      try { if (inferCategory(e) === "Debuff") n++; } catch {}
    }
    return n;
  }

  function _countBondsWithEmotion(reactorActor, emotion) {
    const pair = EMOTION_PAIR[_norm(emotion)];
    if (!pair) return 0;
    const bonds = globalThis.BondUpdater?.readBondsAll?.(reactorActor) ?? [];
    let n = 0;
    for (const b of bonds) {
      if (_norm(b?.[`e${pair}`]) === _norm(emotion)) n++;
    }
    return n;
  }

  function _sumOutcomes(outcomes, predicate) {
    if (!Array.isArray(outcomes)) return 0;
    let total = 0;
    for (const o of outcomes) {
      if (!o || !predicate(o)) continue;
      const v = Number(o.finalValue ?? o.amount ?? 0);
      if (Number.isFinite(v)) total += v;
    }
    return total;
  }

  // Per-event damage value read from a single-target trigger payload.
  // Create Damage Card emits one trigger per affected target, with the
  // target's outcome on `finalValue` + `valueType`. For multi-target spells
  // the trigger fires N times — formula-driven follow-up effects also fire
  // N times, which gives correct cumulative semantics (e.g. drain effects
  // that scale per damaged creature).
  function _eventValue(payload, allowedValueType) {
    if (!payload) return 0;
    if (allowedValueType) {
      const vt = String(payload.valueType ?? "").trim().toLowerCase();
      if (vt !== allowedValueType) return 0;
    }
    const v = Number(payload.finalValue ?? 0);
    return Number.isFinite(v) ? v : 0;
  }

  function resolveIdentifier(name, context) {
    const ctx = context ?? {};
    const reactorActor = ctx.reactorActor ?? ctx.reactorToken?.actor ?? null;
    const reactorProps = reactorActor?.system?.props ?? {};
    const firingSkill  = ctx.firingSkill ?? null;
    const subjectToken = ctx.subjectToken ?? null;
    const payload      = ctx.payload ?? null;
    const combat       = ctx.combat ?? game.combat ?? null;

    switch (name) {
      // Skill level
      case "SL": {
        const lv = firingSkill?.level
                ?? firingSkill?.system?.props?.level
                ?? firingSkill?.system?.level
                ?? 0;
        return Math.max(0, Number(lv) || 0);
      }
      // Combat / payload introspection — used by condition_formula gates.
      case "ROUND": return Number(combat?.round ?? 0) || 0;
      case "ACTION_TARGET_COUNT": {
        const t = payload?.targets;
        return Array.isArray(t) ? t.length : 0;
      }
      // Reactor resources
      case "MAX_HP": return Number(reactorProps.max_hp ?? 0) || 0;
      case "CUR_HP": return Number(reactorProps.current_hp ?? 0) || 0;
      case "MAX_MP": return Number(reactorProps.max_mp ?? 0) || 0;
      case "CUR_MP": return Number(reactorProps.current_mp ?? 0) || 0;
      case "MAX_IP": return Number(reactorProps.max_ip ?? 0) || 0;
      case "CUR_IP": return Number(reactorProps.current_ip ?? 0) || 0;
      // Bonds
      case "BOND_STRENGTH": {
        const bond = _bondMatchingSubject(reactorActor, subjectToken);
        return _bondStrength(bond);
      }
      case "BOND_COUNT": return _countBondsAny(reactorActor);
      // Status effects suffered by the reactor (debuff-classified, non-disabled,
      // non-suppressed). Delegates classification to the AEM registry's
      // inferCategory() so a single source of truth governs what counts as a
      // status effect across the reaction debuff_count filter AND this
      // identifier. Returns 0 if the registry is unavailable (fail-soft).
      case "STATUS_COUNT": return _countStatusesOnActor(reactorActor);
      // Action outcomes — per-event reads on the damage-card trigger payload
      // (Create Damage Card emits one trigger per affected target with
      // finalValue + valueType set on the payload).
      case "DAMAGE_DEALT": return _eventValue(payload, null);
      case "HP_DEALT":     return _eventValue(payload, "hp");
      case "MP_DEALT":     return _eventValue(payload, "mp");
      case "SHIELD_DEALT": return _eventValue(payload, "shield");
      // Aliases (in case authors expect "_TOTAL" wording for per-target events).
      case "DAMAGE_DEALT_TOTAL": return _eventValue(payload, null);
      case "HP_DEALT_TOTAL":     return _eventValue(payload, "hp");
      case "MP_DEALT_TOTAL":     return _eventValue(payload, "mp");
      case "SHIELD_DEALT_TOTAL": return _eventValue(payload, "shield");
      // Action-type + equipment gates for passive-formula skills. The
      // passive-modifier-engine pre-computes these as numeric flags on the
      // action context (= this payload), since the evaluator can't reach the
      // actor or action itself. Fail-safe 0 in any other context. Used by
      // Magical Artillery: HAS_ARCANE_WEAPON * ACTION_IS_SPELL * SL * 2.
      case "ACTION_IS_SPELL":           return Number(payload?._isSpell ?? 0) || 0;
      case "ACTION_IS_OFFENSIVE_SPELL": return Number(payload?._isOffensiveSpell ?? 0) || 0;
      case "HAS_ARCANE_WEAPON":         return Number(payload?._hasArcaneWeapon ?? 0) || 0;
    }

    // BOND_COUNT_<EMOTION>
    const emoMatch = name.match(/^BOND_COUNT_(ADMIRATION|INFERIORITY|LOYALTY|MISTRUST|AFFECTION|HATRED)$/);
    if (emoMatch) return _countBondsWithEmotion(reactorActor, emoMatch[1].toLowerCase());

    console.warn(TAG, `Unknown identifier: ${name}`);
    return 0;
  }

  // ---------------------------------------------------------------------------
  // Public entry
  // ---------------------------------------------------------------------------
  function evaluate(expr, context) {
    // Direct number shortcut (skip parse for the common literal case).
    if (typeof expr === "number") return Number.isFinite(expr) ? expr : 0;
    if (expr === null || expr === undefined) return 0;

    const s = String(expr).trim();
    if (!s) return 0;

    const direct = Number(s);
    if (Number.isFinite(direct)) return direct;

    try {
      const tokens = tokenize(s);
      const result = parse(tokens, context);
      return Number.isFinite(result) ? result : 0;
    } catch (e) {
      console.warn(TAG, `Failed to evaluate "${s}":`, e?.message ?? e);
      return 0;
    }
  }

  function describeIdentifiers() {
    return [
      { name: "SL",                description: "Firing skill's level." },
      { name: "MAX_HP / CUR_HP",   description: "Reactor's HP." },
      { name: "MAX_MP / CUR_MP",   description: "Reactor's MP." },
      { name: "MAX_IP / CUR_IP",   description: "Reactor's IP." },
      { name: "BOND_STRENGTH",     description: "Strength (0–3) of reactor's bond toward the trigger subject." },
      { name: "BOND_COUNT",        description: "Total non-empty bond slots on the reactor." },
      { name: "BOND_COUNT_<EMOTION>", description: "Count of reactor's bonds with a specific emotion. Replace <EMOTION> with one of ADMIRATION / INFERIORITY / LOYALTY / MISTRUST / AFFECTION / HATRED." },
      { name: "STATUS_COUNT",      description: "Count of debuff-classified active effects on the reactor (non-disabled, non-suppressed). Uses the AEM registry's inferCategory() classifier — same source of truth as the reaction debuff_count filter." },
      { name: "DAMAGE_DEALT",  description: "Damage value from the triggering event's payload (post-affinity). Each affected target gets its own event with its own value." },
      { name: "HP_DEALT",      description: "Same but 0 unless the event's valueType is hp." },
      { name: "MP_DEALT",      description: "Same but 0 unless the event's valueType is mp." },
      { name: "SHIELD_DEALT",  description: "Same but 0 unless the event's valueType is shield." },
      { name: "ROUND",         description: "Current combat round number (1-indexed). 0 outside combat." },
      { name: "ACTION_TARGET_COUNT", description: "Number of tokens targeted by the triggering action (payload.targets.length). 0 when the payload carries no target list." },
      { name: "ACTION_IS_SPELL", description: "1 if the action that triggered this passive is a Spell, else 0. Pre-computed by the passive-modifier-engine; 0 outside the passive-formula path." },
      { name: "ACTION_IS_OFFENSIVE_SPELL", description: "1 if the action is an Offensive Spell (isOffensiveSpell), else 0. Pre-computed by the passive-modifier-engine." },
      { name: "HAS_ARCANE_WEAPON", description: "1 if the reactor has an equipped arcane-category weapon, else 0. Pre-computed by the passive-modifier-engine." },
    ];
  }

  window[KEY] = Object.freeze({ evaluate, describeIdentifiers });

  console.debug(`${TAG} Installed. Exposed on window["${KEY}"].`);
});
