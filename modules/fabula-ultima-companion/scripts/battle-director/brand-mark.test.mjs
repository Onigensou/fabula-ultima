// ============================================================================
// Brand Mark — mark detection harness.
//
//     node scripts/battle-director/brand-mark.test.mjs
//
// Bare Node, no Foundry. Only the pure half is covered: whether a given AE
// counts as a mark, and which mark an actor is currently carrying. The badge
// itself is DOM + PIXI bounds and belongs in a live review, not here.
//
// The load-bearing case is the REAL Searing Brand AE fixture below. The badge
// is meant to light up with no data change to that effect, purely off its
// name — if that match ever breaks, the mark goes invisible at the table and
// nothing else in the system complains.
// ============================================================================

import { readFileSync } from "node:fs";
import { MARK_STYLES, markStyleOfEffect, readMark } from "./brand-mark.js";

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; return; }
  fail++;
  console.error(`FAIL  ${label}\n        got  ${g}\n        want ${w}`);
};
const ok = (label, cond) => eq(label, !!cond, true);

const FLAG_NS = "fabula-ultima-companion";

/* ── The real thing ──────────────────────────────────────────────────────
 *
 * Copied from the live world: Actor.P1uCkpNnxLRBNqZr → Item.eLMFbgeZkVWUbE0i
 * → ActiveEffect.bS8dwsANxoxdpiaT (⭐ Fafnir → Searing Brand). Flags trimmed to
 * the ones that exist; note it carries NO markIcon flag, which is the point —
 * it is matched by name.
 */
const REAL_SEARING_BRAND = {
  name: "Searing Brand",
  disabled: false,
  duration: { rounds: 3 },
  flags: {
    [FLAG_NS]: {
      lifetimeMode: "target_turn_start",
      chargeKey: "searing_brand",
      charges: 3,
      chargesMax: 3,
    },
  },
};

eq("REAL Searing Brand AE is detected", markStyleOfEffect(REAL_SEARING_BRAND), "searing_brand");
eq("REAL AE on an actor is read",       readMark({ effects: [REAL_SEARING_BRAND] }), "searing_brand");

// The same AE once it has been suppressed rather than deleted.
eq("REAL AE disabled → no mark",
   markStyleOfEffect({ ...REAL_SEARING_BRAND, disabled: true }), null);

/* ── Name matching ───────────────────────────────────────────────────────── */

eq("exact name",            markStyleOfEffect({ name: "Searing Brand" }), "searing_brand");
eq("lowercase",             markStyleOfEffect({ name: "searing brand" }), "searing_brand");
eq("uppercase",             markStyleOfEffect({ name: "SEARING BRAND" }), "searing_brand");
eq("padded",                markStyleOfEffect({ name: "  Searing Brand  " }), "searing_brand");
eq("inner whitespace run",  markStyleOfEffect({ name: "Searing   Brand" }), "searing_brand");

// Must NOT match — a badge on the wrong effect is worse than no badge.
eq("different effect",      markStyleOfEffect({ name: "Burn" }), null);
eq("substring is not a match", markStyleOfEffect({ name: "Searing Brand of Ruin" }), null);
eq("prefixed is not a match",  markStyleOfEffect({ name: "Greater Searing Brand" }), null);
eq("empty name",            markStyleOfEffect({ name: "" }), null);
eq("missing name",          markStyleOfEffect({}), null);

/* ── Flag matching ───────────────────────────────────────────────────────── */

const flagged = (v) => ({ name: "Anything At All", flags: { [FLAG_NS]: { markIcon: v } } });

eq("explicit flag",         markStyleOfEffect(flagged("searing_brand")), "searing_brand");
eq("flag is trimmed",       markStyleOfEffect(flagged("  searing_brand  ")), "searing_brand");
// An unregistered style must not fall through to name matching and must not
// render — there is no art for it and no colour to draw it in.
eq("unregistered flag → null", markStyleOfEffect(flagged("moon_sigil")), null);
eq("flag wins over name",
   markStyleOfEffect({ name: "Searing Brand", flags: { [FLAG_NS]: { markIcon: "moon_sigil" } } }), null);
eq("blank flag falls back to name",
   markStyleOfEffect({ name: "Searing Brand", flags: { [FLAG_NS]: { markIcon: "" } } }), "searing_brand");
eq("other namespace ignored",
   markStyleOfEffect({ name: "Burn", flags: { theatre: { markIcon: "searing_brand" } } }), null);

/* ── Robustness ──────────────────────────────────────────────────────────── */

eq("null effect",       markStyleOfEffect(null), null);
eq("undefined effect",  markStyleOfEffect(undefined), null);
const hostile = new Proxy({}, { get(_, k) { if (k === "disabled") return false; throw new Error("boom"); } });
eq("throwing effect",   markStyleOfEffect(hostile), null);

eq("actor with no effects",     readMark({ effects: [] }), null);
eq("actor with null effects",   readMark({ effects: null }), null);
eq("null actor",                readMark(null), null);
eq("actor with unrelated AEs",  readMark({ effects: [{ name: "Burn" }, { name: "Slow" }] }), null);

{
  // The realistic shape: a marked creature is also carrying ordinary statuses.
  const actor = { effects: [{ name: "Slow" }, REAL_SEARING_BRAND, { name: "Shaken" }] };
  eq("mark found among other statuses", readMark(actor), "searing_brand");
}

{
  // Disabled mark plus live statuses — nothing should render.
  const actor = { effects: [{ name: "Slow" }, { ...REAL_SEARING_BRAND, disabled: true }] };
  eq("disabled mark among statuses", readMark(actor), null);
}

/* ── Style table integrity ───────────────────────────────────────────────── */

for (const [key, spec] of Object.entries(MARK_STYLES)) {
  ok(`${key}: has a colour`, typeof spec.color === "string" && spec.color.length > 0);
  ok(`${key}: has a glow`,   typeof spec.glow === "string" && spec.glow.length > 0);
  ok(`${key}: has a label`,  typeof spec.label === "string" && spec.label.length > 0);
  ok(`${key}: icon is a URL or null (placeholder chevron)`,
     spec.icon === null || (typeof spec.icon === "string" && spec.icon.length > 0));
  // A style reachable ONLY by flag is legal, but one with a matchName must
  // actually match its own label — the cheapest guard against a typo'd regex.
  if (spec.matchName) {
    ok(`${key}: matchName matches its own label`, spec.matchName.test(spec.label));
  }
}

// The placeholder reminder that used to live here has done its job: the
// authored sigil landed, so this now pins the opposite — that the art is
// wired and nothing has quietly reverted the style to the chevron.
ok("searing_brand uses the authored sigil, not the chevron",
   typeof MARK_STYLES.searing_brand.icon === "string"
   && /^https?:\/\//.test(MARK_STYLES.searing_brand.icon)
   && /vfx_SearingBrand\.png$/i.test(MARK_STYLES.searing_brand.icon));

/* ── Badge sizing, approved live ─────────────────────────────────────────── */
//
// The on-screen size was signed off against the real sigil (65x83 on a Dire
// Orc at rest framing). Pinning the constants the way the flame entrance's are
// pinned: a re-tune of something already approved should have to be deliberate,
// not something that drifts in while tuning a different shot.
//
// Read out of the source rather than exported, because they are a tuning
// detail of the tick and not API — exporting them just to test them would make
// them look like a knob other code may turn.
{
  const src = readFileSync(new URL("./brand-mark.js", import.meta.url), "utf8");
  const m = /Math\.min\((\d+), Math\.max\((\d+), Math\.max\(b\.width, b\.height\) \* ([\d.]+)\)\)/.exec(src);
  ok("badge sizing formula still present", !!m);
  if (m) {
    eq("badge size ceiling", Number(m[1]), 130);
    eq("badge size floor",   Number(m[2]), 46);
    eq("badge scale of sprite", Number(m[3]), 0.42);
  }
  // The box must follow the art's aspect, not be square — a square box
  // letterboxes a tall sigil and silently shrinks it.
  ok("badge width follows the art aspect", /size \* \(rec\.aspect \|\| 1\)/.test(src));
  // Foundry's global img border draws a rectangle around transparent art.
  ok("img border is zeroed", /border: 0 !important/.test(src));
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
