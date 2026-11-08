#!/usr/bin/env node
"use strict";
// ============================================================================
// Write Hina's Lunar Bow attack animation (original pixelfx effects, 2026-11-09)
// onto EVERY "Lunar Bow" weapon: the world item and every embedded copy.
//
//   node bin/_build-lunar-bow-animation.js            # dry run, validates only
//   node bin/_build-lunar-bow-animation.js --write    # write to LevelDB (GAME CLOSED)
//
// Stored on the weapon's own template fields (weapon_animation_panel):
//   system.props.animation_script                 HTML-escaped (anim-studio encode)
//   system.props.animation_damage_timing_options  "default" (gate = oni:animationEnd)
//   system.props.animation_damage_timing_offset   0
//   system.props.animation_preload_urls           the 6 layer webms (warmed in PREP)
// resolveAnimationSpec step 3 (weapon) prefers this over the default bow animation.
// Source of truth: tools/anim-studio/hina-lunar-bow.js.
// ============================================================================
const path = require("path");
const fs = require("fs");
const { openCollection } = require("../lib/db");
const LIB = path.resolve(__dirname, "..", "..", "anim-studio", "lib");
const { encode, validate } = require(path.join(LIB, "encode.js"));
const SRC = path.resolve(__dirname, "..", "..", "anim-studio", "hina-lunar-bow.js");

const NAME = "lunar bow";
const PX = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Animation/pixelfx/";
const PRELOAD = ["pxfx_light_lunar_arrow", "pxfx_light_lunar_impact"]
  .flatMap((b) => ["back", "front", "light"].map((l) => `${PX}${b}_${l}.webm`));

const isTarget = (doc) => String(doc?.name ?? "").trim().toLowerCase() === NAME && doc?.type === "equippableItem"
  && String(doc?.system?.props?.item_type ?? "").toLowerCase() === "weapon";

function apply(doc, stored) {
  const p = (doc.system.props = doc.system.props || {});
  p.animation_script = stored;
  p.animation_damage_timing_options = "default";
  p.animation_damage_timing_offset = 0;
  p.animation_preload_urls = PRELOAD.join("\n");
}

async function main() {
  const write = process.argv.includes("--write");
  const script = fs.readFileSync(SRC, "utf8");
  const r = validate(script);
  if (!r.ok) { console.error("✗ INVALID"); r.errors.forEach((e) => console.error("    " + e)); process.exit(1); }
  r.warnings.forEach((w) => console.warn("  ! " + w));
  const stored = encode(script);
  console.log(`built + validated: ${script.length}b script → ${stored.length}b stored, ${PRELOAD.length} preload urls`);
  let wrote = 0;
  for (const coll of ["items", "actors"]) {
    const db = await openCollection(coll);
    try {
      const prefix = coll === "items" ? "!items!" : "!actors.items!";
      const hits = [];
      for await (const [key, val] of db.iterator()) { if (key.startsWith(prefix) && isTarget(val)) hits.push([key, val]); }
      for (const [key, doc] of hits) {
        const had = String(doc.system?.props?.animation_script ?? "").replace(/<[^>]+>/g, "").trim().length;
        console.log((write ? "  ✓ " : "  [dry] ") + coll + " " + key + (had ? `  (REPLACES an existing ${had}-char script)` : ""));
        if (write) { apply(doc, stored); await db.put(key, doc); wrote++; }
      }
    } finally { await db.close(); }
  }
  console.log(write ? `\nwrote ${wrote}` : "\nDry run — pass --write to apply. GAME MUST BE CLOSED.");
}
main().catch((e) => { console.error(e); process.exit(1); });
