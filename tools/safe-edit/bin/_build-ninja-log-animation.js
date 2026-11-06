#!/usr/bin/env node
"use strict";
// ============================================================================
// Build + write Ninja Log's substitution animation (approved mockup round 3,
// 2026-11-06) onto EVERY "Ninja Log" item: the world item and every embedded
// copy on any actor.
//
//   node bin/_build-ninja-log-animation.js            # dry run, validates only
//   node bin/_build-ninja-log-animation.js --write    # write to LevelDB (GAME CLOSED)
//
// Stored as item FLAGS (flags.fabula-ultima-companion.animationScript /
// animationTiming / animationOffset / animationPreload): the accessory template
// has no animation_script field. Played by director-vfx playBlockVfx →
// director-animation playCarrierAnimation at the BLOCK moment.
// Source of truth: tools/anim-studio/lib/ninja-log-signature.js (+ party-shots/ninja-log.inner.js).
// ============================================================================

const path = require("path");
const { openCollection } = require("../lib/db");
const LIB = path.resolve(__dirname, "..", "..", "anim-studio", "lib");
const { ninjaLog } = require(path.join(LIB, "ninja-log-signature.js"));
const { encode, validate } = require(path.join(LIB, "encode.js"));
const NS = "fabula-ultima-companion";
const NAME = "ninja log";

function apply(doc, built) {
  doc.flags = doc.flags || {}; const f = (doc.flags[NS] = doc.flags[NS] || {});
  f.animationScript = built.stored;
  f.animationTiming = built.timing.mode;
  f.animationOffset = built.timing.offset;
  f.animationPreload = built.preload.join("\n");
}
const isNinjaLog = (doc) => String(doc?.name ?? "").trim().toLowerCase() === NAME && doc?.type === "equippableItem";

async function main() {
  const write = process.argv.includes("--write");
  const out = ninjaLog();
  const r = validate(out.script);
  if (!r.ok) { console.error("✗ INVALID"); r.errors.forEach((e) => console.error("    " + e)); process.exit(1); }
  r.warnings.forEach((w) => console.warn("  ! " + w));
  const built = { stored: encode(out.script), timing: out.timing, preload: out.preload };
  console.log("built + validated: " + out.script.length + "b script, timing " + built.timing.mode + ", " + built.preload.length + " preload urls");

  let wrote = 0;
  for (const coll of ["items", "actors"]) {
    const db = await openCollection(coll);
    try {
      const prefix = coll === "items" ? "!items!" : "!actors.items!";
      const hits = [];
      for await (const [key, val] of db.iterator()) { if (key.startsWith(prefix) && isNinjaLog(val)) hits.push([key, val]); }
      for (const [key, doc] of hits) {
        console.log((write ? "  ✓ " : "  [dry] ") + coll + " " + key);
        if (write) { apply(doc, built); await db.put(key, doc); wrote++; }
      }
    } finally { await db.close(); }
  }
  console.log(write ? "\nwrote " + wrote : "\nDry run — pass --write to apply. GAME MUST BE CLOSED.");
}

main().catch((e) => { console.error(e); process.exit(1); });
