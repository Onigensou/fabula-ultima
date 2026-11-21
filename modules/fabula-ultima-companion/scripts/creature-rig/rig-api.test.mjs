// Node checks: the pure parts of the creature-rig trigger API (rig-api-core.js) — tokenRef resolution,
// broadcast targets, dedupe, socket-safe options, motion timing, the entrance beat, once-per gating.
// Run: node rig-api.test.mjs
import {
  RIG_MSG, parseTokenUuid, refTarget, resolveTokenRef, createSeen, makeMsgId, sanitizeOpts, acceptMessage,
  motionTiming, entranceMotionOf, createOncePer,
} from "./rig-api-core.js";

let pass = 0, fail = 0;
const ok = (name, cond, got) => { if (cond) pass++; else { fail++; console.log("FAIL", name, JSON.stringify(got)); } };

// ── fakes: a scene "S1" with token "T1" ──
const scene = { id: "S1" };
const doc = { documentName: "Token", id: "T1", parent: scene };
const placeable = { id: "T1", document: doc, destroyed: false };
doc.object = placeable;
const otherDoc = { documentName: "Token", id: "T9", parent: { id: "S2" } };
const env = { sceneId: "S1", get: (id) => (id === "T1" ? placeable : null) };

// ── uuid parsing ──
ok("uuid", JSON.stringify(parseTokenUuid("Scene.S1.Token.T1")) === JSON.stringify({ sceneId: "S1", tokenId: "T1" }), parseTokenUuid("Scene.S1.Token.T1"));
ok("uuid actor-delta path", parseTokenUuid("Scene.S1.Token.T1.Actor.A1")?.tokenId === "T1", parseTokenUuid("Scene.S1.Token.T1.Actor.A1"));
ok("uuid not a token", parseTokenUuid("Actor.A1") === null);
ok("uuid no scene", parseTokenUuid("Token.T1")?.sceneId === null);

// ── refTarget ──
ok("target id", refTarget("T1")?.tokenId === "T1" && refTarget("T1").sceneId === null);
ok("target doc", refTarget(doc)?.sceneId === "S1");
ok("target placeable", refTarget(placeable)?.tokenId === "T1");
ok("target junk", refTarget(null) === null && refTarget(42) === null && refTarget({}) === null);

// ── resolveTokenRef: every ref form lands on the live placeable ──
for (const [name, ref] of [["placeable", placeable], ["doc", doc], ["id", "T1"], ["uuid", "Scene.S1.Token.T1"]]) {
  ok(`resolve ${name}`, resolveTokenRef(ref, env) === placeable);
}
ok("resolve other scene uuid", resolveTokenRef("Scene.S2.Token.T1", env) === null);
ok("resolve other scene doc", resolveTokenRef(otherDoc, env) === null);
ok("resolve unknown id", resolveTokenRef("NOPE", env) === null);
ok("resolve null", resolveTokenRef(null, env) === null);
ok("resolve throwing get", resolveTokenRef("T1", { sceneId: "S1", get() { throw new Error("x"); } }) === null);
// a fresh placeable not yet indexed by the layer is trusted while alive
const fresh = { id: "T5", document: { documentName: "Token", id: "T5", parent: scene }, destroyed: false };
ok("resolve unindexed placeable", resolveTokenRef(fresh, env) === fresh);
ok("resolve destroyed placeable", resolveTokenRef({ ...fresh, destroyed: true }, env) === null);

// ── dedupe ──
const seen = createSeen(3);
ok("seen new", seen.check("a") === true);
ok("seen repeat", seen.check("a") === false);
seen.check("b"); seen.check("c"); seen.check("d");   // "a" falls off (cap 3)
ok("seen bounded", seen.size === 3 && seen.check("a") === true, seen.size);
ok("seen no id passes", seen.check(undefined) === true && seen.check(undefined) === true);
const ids = new Set(Array.from({ length: 500 }, () => makeMsgId("U1")));
ok("msg ids unique", ids.size === 500, ids.size);

// acceptMessage: the SENDER marks its id first, so the same message handed back is a duplicate;
// a receiver acts once; another scene / foreign type / bad op is skipped.
const s2 = createSeen();
const msg = { type: RIG_MSG, op: "play", id: makeMsgId("U1"), sceneId: "S1", tokenId: "T1", motion: "roar" };
s2.check(msg.id);   // sender
ok("echo to sender skipped", acceptMessage(msg, { sceneId: "S1", seen: s2 }) === "duplicate");
const rx = createSeen();
ok("receiver acts", acceptMessage(msg, { sceneId: "S1", seen: rx }) === null);
ok("receiver acts once", acceptMessage(msg, { sceneId: "S1", seen: rx }) === "duplicate");
ok("other scene", acceptMessage({ ...msg, id: "z" }, { sceneId: "S2", seen: createSeen() }) === "other-scene");
ok("foreign type", acceptMessage({ type: "oni.pseudo.play" }, { sceneId: "S1", seen: createSeen() }) === "not-mine");
ok("bad op", acceptMessage({ ...msg, op: "explode" }, { sceneId: "S1", seen: createSeen() }) === "bad-op");
// a skipped other-scene message must not burn the id (it never ran here)
const s3 = createSeen();
acceptMessage({ ...msg, id: "q" }, { sceneId: "S2", seen: s3 });
ok("other scene leaves id unseen", !s3.has("q"));

// ── sanitizeOpts ──
const so = sanitizeOpts({ hold: 2, jaw: NaN, speed: Infinity, exclusive: false, tag: "x", fn() {}, o: { a: 1 }, n: null });
ok("sanitize", JSON.stringify(so) === JSON.stringify({ hold: 2, exclusive: false, tag: "x" }), so);
ok("sanitize junk", JSON.stringify(sanitizeOpts(null)) === "{}");

// ── motion timing (agrees with rig-motions.js) ──
const roar = motionTiming("roar");
ok("roar timing", roar?.durationMs === 3800 && roar?.peakMs === 1100, roar);
ok("roar hold", motionTiming("roar", { hold: 3 })?.durationMs === 5200, motionTiming("roar", { hold: 3 }));
ok("roar speed", motionTiming("roar", { speed: 2 })?.peakMs === 550, motionTiming("roar", { speed: 2 }));
ok("unknown timing", motionTiming("moonwalk") === null);

// ── entrance beat ──
ok("entrance string", JSON.stringify(entranceMotionOf({ onEntrance: "roar" })) === JSON.stringify({ motion: "roar", opts: {} }));
ok("entrance object", JSON.stringify(entranceMotionOf({ onEntrance: { motion: "roar", hold: 2.5 } })) === JSON.stringify({ motion: "roar", opts: { hold: 2.5 } }));
ok("entrance none", entranceMotionOf({}) === null && entranceMotionOf(null) === null && entranceMotionOf({ onEntrance: 5 }) === null);

// ── once per window ──
const once = createOncePer(8000);
ok("once first", once("T1", 1000) === true);
ok("once repeat", once("T1", 3000) === false);
ok("once other token", once("T2", 3000) === true);
ok("once after window", once("T1", 9500) === true);

console.log(`rig-api: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
