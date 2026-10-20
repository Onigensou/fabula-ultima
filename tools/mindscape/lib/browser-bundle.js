"use strict";
//
// Mindscape — bundle the combat engine into one browser script for the Balance Board's
// in-page battle simulator. CommonJS modules are wrapped in a tiny require shim; two
// browser-only changes are made to the copy (the Node sources are untouched):
//
//   formula.js  `new Function` (blocked on locked-down pages) -> a small safe evaluator for
//               the same arithmetic grammar formula.js already restricts input to.
//   engine.js   an opt-in hook (globalThis.__msTraceHp) that stamps every log entry with
//               each combatant's HP at that moment, so the page can animate HP bars.
//
// tests: bin/balance-board-build.js runs battles through the bundle and refuses to build if
// any differs from the Node engine.

const fs = require("fs");
const path = require("path");

const MODULES = ["rules", "formula", "stances", "skills", "utility", "reactions", "tinctures", "monster-data", "party-policy", "engine", "rng", "conflict-events"];

const SAFE_EVAL = String.raw`
function __safeEval(src, env) {
  let i = 0;
  const s = String(src);
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  const peek = (t) => { ws(); return s.startsWith(t, i); };
  const eat = (t) => { if (peek(t)) { i += t.length; return true; } return false; };
  function primary() {
    ws();
    if (eat("(")) { const v = ternary(); if (!eat(")")) throw new Error("expected )"); return v; }
    if (eat("-")) return -unary();
    if (eat("+")) return +unary();
    if (eat("!")) return !unary() ? 1 : 0;
    const num = /^\d+(\.\d+)?/.exec(s.slice(i));
    if (num) { i += num[0].length; return Number(num[0]); }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i));
    if (id) {
      i += id[0].length;
      const v = env[id[0]];
      if (typeof v === "function") {
        if (!eat("(")) throw new Error("expected ( after " + id[0]);
        const args = [];
        if (!eat(")")) { do { args.push(ternary()); } while (eat(",")); if (!eat(")")) throw new Error("expected )"); }
        return v(...args);
      }
      if (v === undefined) throw new Error("unknown " + id[0]);
      return v;
    }
    throw new Error("unexpected input at " + i);
  }
  const unary = primary;
  function mul() { let v = unary(); for (;;) { if (eat("*")) v *= unary(); else if (eat("/")) v /= unary(); else if (eat("%")) v %= unary(); else return v; } }
  function add() { let v = mul(); for (;;) { if (eat("+")) v += mul(); else if (eat("-")) v -= mul(); else return v; } }
  function cmp() { let v = add(); for (;;) {
    if (eat(">=")) v = v >= add() ? 1 : 0; else if (eat("<=")) v = v <= add() ? 1 : 0;
    else if (eat(">")) v = v > add() ? 1 : 0; else if (eat("<")) v = v < add() ? 1 : 0; else return v; } }
  function eq() { let v = cmp(); for (;;) {
    if (eat("===") || eat("==")) v = v === cmp() ? 1 : 0; else if (eat("!==") || eat("!=")) v = v !== cmp() ? 1 : 0; else return v; } }
  function and() { let v = eq(); while (eat("&&")) { const r = eq(); v = v && r; } return v; }
  function or() { let v = and(); while (eat("||")) { const r = and(); v = v || r; } return v; }
  function ternary() { const c = or(); if (eat("?")) { const a = ternary(); if (!eat(":")) throw new Error("expected :"); const b = ternary(); return c ? a : b; } return c; }
  const v = ternary(); ws();
  if (i !== s.length) throw new Error("trailing input at " + i);
  return v;
}`;

// Line-ending tolerant: the repo checks files out with CRLF on Windows.
const FN_FROM = /const fn = new Function\(\.\.\.names, `"use strict"; return \(\$\{src\}\);`\);\r?\n\s*const v = Number\(fn\(\.\.\.values\)\);/;
const FN_TO = "const v = Number(__safeEval(src, Object.fromEntries(names.map((n, k) => [n, values[k]]))));";
const TRACE_AT = "  if (state.event?.init) state.event.init(state);";
const TRACE_ADD = `${TRACE_AT}
  if (globalThis.__msTraceHp) {
    const push = state.log.push.bind(state.log);
    state.log.push = (...es) => { for (const e of es) e.__hp = state.combatants.map((c) => [Math.max(0, Math.round(c.hp)), c.alive]); return push(...es); };
  }`;

function bundleEngine() {
  const libDir = __dirname;
  const parts = MODULES.map((name) => {
    let src = fs.readFileSync(path.join(libDir, `${name}.js`), "utf8");
    if (name === "formula") {
      if (!FN_FROM.test(src)) throw new Error("formula.js changed: the new Function call to replace was not found");
      src = src.replace(FN_FROM, FN_TO);
    }
    if (name === "engine") {
      if (!src.includes(TRACE_AT)) throw new Error("engine.js changed: the trace hook anchor was not found");
      src = src.replace(TRACE_AT, TRACE_ADD);
    }
    if (/require\("(?!\.\/)/.test(src)) throw new Error(`${name}.js requires something outside lib/; it cannot run in a page`);
    return `"./${name}": function (module, exports, require) {\n${src}\n}`;
  });
  return `(function () {
${SAFE_EVAL}
const __defs = {
${parts.join(",\n")}
};
const __cache = {};
function __require(name) {
  if (__cache[name]) return __cache[name].exports;
  const def = __defs[name];
  if (!def) throw new Error("bundle: no module " + name);
  const module = { exports: {} };
  __cache[name] = module;
  def(module, module.exports, __require);
  return module.exports;
}
globalThis.Mindscape = { runBattle: __require("./engine").runBattle, Rng: __require("./rng").Rng, resolveEvent: __require("./conflict-events").resolveEvent };
})();`;
}

module.exports = { bundleEngine };
