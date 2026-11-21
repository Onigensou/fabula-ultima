import { migrate } from "../../data-migrations/2026-11-21-template-options-stays-down.js";
import assert from "node:assert/strict";
globalThis.foundry = { utils: { deepClone: (x) => structuredClone(x) } };
const tmpl = (fail) => ({ name: "T", toObject: () => ({ system: { c: { key: "reaction_trigger", options: [] } } }), update: async () => { if (fail) throw new Error("x"); } });
const g = (fail) => ({ items: { get: () => tmpl(fail) } });
assert.equal((await migrate(g(true), () => {})).applied, false);
assert.equal((await migrate(g(false), () => {})).applied, true);
console.log("migration ok");
