"use strict";

// test-bridge client (GAME OPEN) + the gold-standard, in-page validators.
//
// The offline linter (lint.js) reproduces CSB's rules; this module runs CSB's
// OWN code against a proposed tree, which is the truest "will CSB accept this?"
// check. Three capabilities:
//   verify(...)  — parse body/header with the real ComponentFactory (throws on
//                  unknown type, exactly like load), and (if a real template
//                  UUID is given) list getAllProperties() so we can confirm new
//                  field keys actually materialize.
//   roundtrip(.) — parse then re-serialize (fromJSON -> toJSON) and report the
//                  prop-key set CSB would keep, to surface silent drops.
//   apply(...)   — doc.update() the patch, version-stamp every copy templated to
//                  it, and reloadTemplate a sample so the edit takes effect.
//
// Mirrors the proven bridge IPC in tools/safe-edit/bin/world-import.js.

const fs = require("fs");
const path = require("path");

const DEFAULT_WORLD = "fabula-ultima-2";

function bridgeDir(world) {
  return path.join(__dirname, "..", "..", "..", "worlds", world, "test-bridge");
}

async function bridgeEval(world, code, args, { timeoutMs = 300000 } = {}) {
  const dir = bridgeDir(world);
  const secretPath = path.join(dir, "bridge-secret.txt");
  if (!fs.existsSync(secretPath)) {
    throw new Error(`No bridge secret at ${secretPath}. Is Foundry open with the bridge active?`);
  }
  const secret = fs.readFileSync(secretPath, "utf8").trim();
  const id = "csb" + Math.random().toString(36).slice(2, 9);
  const reqPath = path.join(dir, "inbox", `req-${id}.json`);
  const resPath = path.join(dir, "outbox", `res-${id}.json`);
  const wrapped = `const ARGS = ${JSON.stringify(args)};\n${code}`;
  fs.writeFileSync(reqPath, JSON.stringify({ id, kind: "evalGM", auth: secret, timeoutMs, args: { code: wrapped } }));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const started = Date.now();
  let res = null;
  while (Date.now() - started < timeoutMs + 20000) {
    if (fs.existsSync(resPath)) { res = JSON.parse(fs.readFileSync(resPath, "utf8")); break; }
    await sleep(200);
  }
  try { fs.existsSync(reqPath) && fs.unlinkSync(reqPath); } catch { /* ignore */ }
  try { fs.existsSync(resPath) && fs.unlinkSync(resPath); } catch { /* ignore */ }
  if (!res) throw new Error("No bridge response — is Foundry open and the bridge running?");
  if (!res.ok) throw new Error(`bridge eval error: ${res.error}\n${res.errorStack || ""}`);
  return res.result;
}

// ── in-page programs ──────────────────────────────────────────────────────────

// Parse body/header with the real ComponentFactory; optionally list a live
// template's properties. `componentFactory` is a CSB global.
const VERIFY_PROG = `
const { body, header, uuid } = ARGS;
const out = { ok: true, parse: {}, props: null, errors: [] };
const parseRoot = (name, root) => {
  if (!root) return;
  try {
    componentFactory.createOneComponent(root, name);   // recursive; throws on unknown type
    out.parse[name] = { ok: true };
  } catch (e) {
    out.ok = false;
    out.parse[name] = { ok: false, error: String(e && e.message || e) };
    out.errors.push(name + ": " + String(e && e.message || e));
  }
};
parseRoot("body", body);
parseRoot("header", header);
if (uuid) {
  try {
    const doc = await fromUuid(uuid);
    const props = doc && doc.templateSystem && doc.templateSystem.getAllProperties();
    out.props = props ? Object.keys(props).sort() : null;
  } catch (e) { out.errors.push("getAllProperties: " + String(e && e.message || e)); }
}
return out;
`;

// Parse -> re-serialize body AND header, and return the TOP-LEVEL prop-owning
// key set CSB keeps (table keys included; rowLayout column keys deliberately
// NOT recursed, since those are row-scoped — this mirrors tree.propOwningKeys so
// the offline/online sets are comparable and a dropped FIELD stands out).
const ROUNDTRIP_PROG = `
const { body, header } = ARGS;
const out = { ok: true, error: null, keptKeys: [] };
const ownsProp = new Set(["textField","numberField","checkbox","select","radioButton","textArea",
  "dynamicTable","compactDynamicTable","itemContainer","activeEffectContainer","conditionalModifierList"]);
const keys = new Set();
const walk = (n) => {
  if (!n || typeof n !== "object") return;
  if (typeof n.type === "string" && ownsProp.has(n.type) && n.key) keys.add(n.key);
  if (Array.isArray(n.contents)) n.contents.forEach(c => Array.isArray(c) ? c.forEach(walk) : walk(c));
  // intentionally do NOT recurse rowLayout (row-scoped column keys)
};
try {
  for (const [name, root] of [["body", body], ["header", header]]) {
    if (!root) continue;
    const panel = componentFactory.createOneComponent(root, name);
    walk(panel.toJSON());
  }
  out.keptKeys = Array.from(keys).sort();
} catch (e) { out.ok = false; out.error = String(e && e.message || e); }
return out;
`;

// Write the patch to the master, then version-stamp + reload copies.
const APPLY_PROG = `
const { uuid, patch, reloadCopies } = ARGS;
const out = { ok: true, updated: false, version: null, copiesStamped: 0, copiesReloaded: 0, errors: [] };
try {
  const master = await fromUuid(uuid);
  if (!master) throw new Error("master not found: " + uuid);
  await master.update(patch);
  out.updated = true;
  out.version = master.system.templateSystemUniqueVersion;
  const masterId = master.id;
  // version-stamp every world item + actor-embedded item templated to this master
  const worldStamp = [];
  for (const it of game.items) if (it.system && it.system.template === masterId)
    worldStamp.push({ _id: it.id, "system.templateSystemUniqueVersion": out.version });
  if (worldStamp.length) { await Item.updateDocuments(worldStamp); out.copiesStamped += worldStamp.length; }
  for (const a of game.actors) {
    const emb = [];
    for (const it of a.items) if (it.system && it.system.template === masterId)
      emb.push({ _id: it.id, "system.templateSystemUniqueVersion": out.version });
    if (emb.length) { await a.updateEmbeddedDocuments("Item", emb); out.copiesStamped += emb.length; }
  }
  if (reloadCopies) {
    for (const it of game.items) if (it.system && it.system.template === masterId) {
      try { await it.templateSystem.reloadTemplate(); out.copiesReloaded++; } catch (e) { out.errors.push("reload " + it.id + ": " + (e.message||e)); }
    }
  }
} catch (e) { out.ok = false; out.errors.push(String(e && e.message || e)); }
return out;
`;

// The component types registered in the LIVE factory (base CSB + module
// extensions). Used to augment the static linter so a module-registered type
// isn't a false UNKNOWN_TYPE.
async function registeredTypes({ world = DEFAULT_WORLD } = {}) {
  return bridgeEval(world, "return Object.keys(componentFactory._componentTypes);", {});
}

async function verify({ body, header, uuid }, { world = DEFAULT_WORLD } = {}) {
  return bridgeEval(world, VERIFY_PROG, { body, header, uuid });
}
async function roundtrip({ body, header }, { world = DEFAULT_WORLD } = {}) {
  return bridgeEval(world, ROUNDTRIP_PROG, { body, header });
}
async function applyViaBridge(uuid, patch, { world = DEFAULT_WORLD, reloadCopies = false } = {}) {
  return bridgeEval(world, APPLY_PROG, { uuid, patch, reloadCopies });
}
// Read a template via the bridge (game open) for lint/show.
const READ_PROG = `
const { uuid } = ARGS;
const doc = await fromUuid(uuid);
if (!doc) return { ok:false, error:"not found: "+uuid };
return { ok:true, doc: doc.toObject() };
`;
async function loadViaBridge(ref, { world = DEFAULT_WORLD } = {}) {
  const uuid = /^(Item|Actor)\./.test(ref) ? ref : `Item.${ref}`;
  const res = await bridgeEval(world, READ_PROG, { uuid });
  if (!res.ok) throw new Error(res.error);
  return { doc: res.doc, uuid, source: "bridge" };
}

module.exports = { bridgeEval, verify, roundtrip, applyViaBridge, loadViaBridge, registeredTypes, DEFAULT_WORLD };
