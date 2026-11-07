// ============================================================================
// Party Talk — core harness.
//
//     node scripts/party-talk/party-talk-core.test.mjs
//
// Bare Node, no Foundry. Covers the pure half: text units across English,
// Japanese and Thai, the limit, slash commands, action formatting, line
// validation, face crops and the bubble queue. The DOM, socket and keys belong
// in a live sandbox run.
// ============================================================================

import {
  MODES, LIMIT, PRESSURE,
  graphemes, units, langOf, clampUnits, duration, typeMs,
  parseSlash, toSegments, plainText, sanitizeLine,
  faceCrop, resolveFace, PARTY_FACES, TalkQueue, TALK_SCENE_MODES,
} from "./party-talk-core.js";

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; return; }
  fail++; console.error(`FAIL ${label}\n  got  ${g}\n  want ${w}`);
};
const ok = (label, cond) => eq(label, !!cond, true);

// ── units ──────────────────────────────────────────────────────────────────
eq("ascii units", units("Hello!"), 6);
eq("thai cluster is one grapheme", graphemes("ที่").length, 1);
eq("thai word clusters", units("ที่นี่"), 2);
eq("thai sentence counts clusters, not code points", [units("สวัสดี"), "สวัสดี".length], [4, 6]);   // ส วั ส ดี
eq("japanese counts double", units("井戸"), 4);
eq("kana counts double", units("のぞく"), 6);
eq("mixed", units("Hi 猫"), 5);
eq("emoji family is one cluster", units("👨‍👩‍👧"), 1);

eq("lang en", langOf("Hello"), "en");
eq("lang ja", langOf("こんにちは"), "ja");
eq("lang th", langOf("สวัสดี"), "th");
eq("lang thai wins over latin", langOf("OK นะ"), "th");

// ── clamp ──────────────────────────────────────────────────────────────────
eq("clamp english", clampUnits("a".repeat(130)).length, LIMIT);
eq("clamp japanese to 60 chars", graphemes(clampUnits("あ".repeat(80))).length, 60);
{
  const thai = "ที่".repeat(130);
  const c = clampUnits(thai);
  eq("clamp thai keeps whole clusters", graphemes(c).length, LIMIT);
  ok("clamp thai ends on a full cluster", c.endsWith("ที่"));
}
eq("clamp japanese never splits at odd budget", units(clampUnits("x" + "あ".repeat(80))), 119);

// ── timing ─────────────────────────────────────────────────────────────────
eq("duration floor", duration("Hi"), 5000);
eq("duration 40 letters", duration("a".repeat(40)), 6800);
eq("duration cap", duration("a".repeat(120)), 12000);
eq("duration japanese uses units", duration("あ".repeat(20)), 6800);
eq("type ms", Math.round(typeMs("a".repeat(70))), 1000);

// ── slash ──────────────────────────────────────────────────────────────────
eq("slash /y", parseSlash("/y Run!"), { mode: "shout", rest: "Run!" });
eq("slash /me", parseSlash("/me waves"), { mode: "action", rest: "waves" });
eq("slash /emote", parseSlash("/EMOTE sighs"), { mode: "action", rest: "sighs" });
eq("slash /t", parseSlash("/t hmm"), { mode: "think", rest: "hmm" });
eq("slash /s", parseSlash("/s hi"), { mode: "say", rest: "hi" });
eq("slash needs a space", parseSlash("/me"), { mode: null, rest: "/me" });
eq("slash unknown", parseSlash("/xyz hi"), { mode: null, rest: "/xyz hi" });
eq("no slash", parseSlash("hello"), { mode: null, rest: "hello" });

// ── segments ───────────────────────────────────────────────────────────────
eq("action english gets the name", toSegments("peers into the well.", "action", "Hina"),
  [{ t: "Hina", cls: "act-name" }, { t: " " }, { t: "peers into the well." }]);
eq("action already named", toSegments("Hina waves.", "action", "Hina"), [{ t: "Hina waves." }]);
eq("action japanese no name", toSegments("井戸をのぞく。", "action", "Hina"), [{ t: "井戸をのぞく。" }]);
eq("action thai no name", plainText(toSegments("ชะโงกมอง", "action", "Hina")), "ชะโงกมอง");
eq("action narrator no name", plainText(toSegments("The bucket creaks.", "action", "GM", { narrator: true })), "The bucket creaks.");
eq("action strips asterisks", plainText(toSegments("*waves*", "action", "Hina")), "Hina waves");
eq("inline action in say", toSegments("Hello *waves*", "say", "Hina"),
  [{ t: "Hello " }, { t: "waves", cls: "act-inline" }]);
eq("inline action japanese", toSegments("近道！*指さす*", "shout", "Hina"),
  [{ t: "近道！" }, { t: "指さす", cls: "act-inline" }]);
eq("lone asterisk stays text", plainText(toSegments("5 * 3", "say", "Hina")), "5 * 3");

// ── sanitize ───────────────────────────────────────────────────────────────
const base = { id: "a1", userId: "u1", mode: "say", text: "Hi", ts: 1, speaker: { key: "actor:x", actorId: "x", name: "Hina", face: { src: "s", fx: 0.5, fy: 0.5, fw: 0.4, cut: true } } };
eq("sanitize ok", sanitizeLine(base)?.text, "Hi");
eq("sanitize bad mode", sanitizeLine({ ...base, mode: "whisper" }), null);
eq("sanitize empty", sanitizeLine({ ...base, text: "   " }), null);
eq("sanitize clamps", units(sanitizeLine({ ...base, text: "b".repeat(500) }).text), LIMIT);
eq("sanitize strips control chars", sanitizeLine({ ...base, text: "a\u0000b" }).text, "a b");
eq("sanitize bad face numbers", sanitizeLine({ ...base, speaker: { ...base.speaker, face: { fx: "nope", fw: 9 } } }).speaker.face.fw, 0.5);
eq("sanitize junk", sanitizeLine("hello"), null);
eq("modes", MODES, ["say", "shout", "think", "action"]);

// ── faces ──────────────────────────────────────────────────────────────────
{
  const c = faceCrop({ fx: 0.52, fy: 0.6, fw: 0.4 }, 281, 420, 0.62, 0.5);
  ok("hina crop scale > 1", c.width > 100);
  ok("hina crop left within bounds", c.left <= 0 && c.left >= 100 - c.width);
  ok("hina crop top negative (face low in image)", c.top < -50);
}
eq("resolve party by first name", resolveFace({ name: "Hina", img: "x" }).src, PARTY_FACES.hina.src);
eq("resolve flag wins", resolveFace({ name: "Hina", img: "x", flag: { src: "f", fx: 0.3 } }).src, "f");
eq("resolve fallback", resolveFace({ name: "Merchant", img: "m.png" }), { fx: 0.5, fy: 0.38, fw: 0.55, cut: false, src: "m.png" });
ok("scene modes", TALK_SCENE_MODES.has("camp") && !TALK_SCENE_MODES.has("conflict"));

// ── queue ──────────────────────────────────────────────────────────────────
const L = (id, key, text = "Hello there") => ({ id, userId: key, mode: "say", text, speaker: { key } });
{
  const q = new TalkQueue();
  eq("first shows", q.offer(L("1", "a"), 0), "show");
  eq("second shows", q.offer(L("2", "b"), 0), "show");
  eq("third waits", q.offer(L("3", "c"), 0), "wait");
  eq("same speaker twice is two bubbles", q.offer(L("4", "a"), 0), "wait");
  eq("speaker cap", q.offer(L("5", "a"), 0), "wait");
  eq("speaker over cap goes to log", q.offer(L("6", "a"), 0), "log");

  // Typing takes typeMs; nothing expires before it is done.
  q.expire(0);
  eq("nothing expires while typing", q.expire(100), []);
  // Under pressure (lines waiting) timers run PRESSURE× faster:
  // duration("Hello there") = 5000; typing done at ~157 ms.
  const ready = typeMs("Hello there");
  const t = Math.ceil(ready + 5000 / PRESSURE) + 50;
  let gone = [];
  for (let now = 200; now <= t; now += 100) gone = gone.concat(q.expire(now));
  eq("both expire under pressure", gone.sort(), ["1", "2"]);
  q.remove("1"); q.remove("2");
  eq("promote fills two slots", q.promote(t).map((l) => l.id), ["3", "4"]);
  eq("one still waiting", q.waiting.map((l) => l.id), ["5"]);
}
{
  const q = new TalkQueue();
  q.offer(L("1", "a"), 0);
  q.expire(0);
  q.hold("1", true);
  eq("held bubble never expires", q.expire(20000).length + q.expire(40000).length, 0);
  q.hold("1", false);
  q.expire(40100);
  eq("released bubble expires", q.expire(60000), ["1"]);
}
{
  const q = new TalkQueue();
  q.offer(L("1", "a"), 0); q.offer(L("2", "b"), 0); q.offer(L("3", "c"), 0);
  eq("flush returns waiting", q.flush().map((l) => l.id), ["3"]);
  eq("flush empties", [q.visible.length, q.waiting.length], [0, 0]);
}
{
  const q = new TalkQueue();
  q.offer(L("1", "a"), 0); q.offer(L("2", "b"), 0); q.offer(L("3", "c"), 0);
  eq("new line waits behind a queue even with a free slot", (q.remove("1"), q.offer(L("4", "d"), 0)), "wait");
  eq("promote keeps order", q.promote(0).map((l) => l.id), ["3"]);
}

console.log(`party-talk core: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
