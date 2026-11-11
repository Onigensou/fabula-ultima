// Tests for the Alter the Story rules. No game required.
// Run: node scripts/alter-story/as-logic.test.mjs
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
vm.runInThisContext(readFileSync(resolve(HERE, "as-logic.js"), "utf8"), { filename: "as-logic.js" });
const L = globalThis.AlterStory.Logic;

let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? "  " + JSON.stringify(detail) : ""}`);
  if (!ok) fail++;
};
const base = () => L.create({ id: "r1", userId: "uKeren", actorId: "aKeren", actorName: "Keren", fp: 3, now: 1 });
const zarg = { actorId: "aZarg", name: "Zarg", userId: "uZarg" };
const hina = { actorId: "aHina", name: "Hina", userId: "uHina" };
const offline = { actorId: "aBlanche", name: "Blanche", userId: null };

// ── canOpen ──────────────────────────────────────────────────────────────────
check("player with FP may open", L.canOpen({ hasCharacter: true, fp: 1 }).ok);
check("GM may not open", L.canOpen({ isGM: true, hasCharacter: true, fp: 5 }).reason === "gm");
check("no character", L.canOpen({ fp: 3 }).reason === "no-character");
check("0 FP", L.canOpen({ hasCharacter: true, fp: 0 }).reason === "no-fp");
check("busy beats FP", L.canOpen({ hasCharacter: true, fp: 0, active: {} }).reason === "busy");
check("title screen", L.canOpen({ hasCharacter: true, fp: 3, sceneMode: "Title" }).reason === "scene");

// ── submit ───────────────────────────────────────────────────────────────────
let r = L.reduce(base(), { type: "submit", text: "  The innkeeper   owes Keren. " }, 2);
check("submit without heroes goes to GM", r.req.phase === "gm" && r.req.text === "The innkeeper owes Keren.");
check("empty text refused", L.reduce(base(), { type: "submit", text: "   " }).effect === "ignored");
r = L.reduce(base(), { type: "submit", text: "", spoken: true });
check("spoken with no text is fine", r.req.phase === "gm" && r.req.spoken);
check("text clamped", L.reduce(base(), { type: "submit", text: "x".repeat(900) }).req.text.length === L.TEXT_MAX);
r = L.reduce(base(), { type: "submit", text: "t", involves: [zarg, zarg, offline] });
check("tagged online hero asks consent", r.req.phase === "consent" && Object.keys(r.req.consents).join() === "aZarg");
check("duplicate tags dropped", r.req.involves.length === 2);
r = L.reduce(base(), { type: "submit", text: "t", involves: [offline] });
check("offline hero falls to GM", r.req.phase === "gm");
r = L.reduce(base(), { type: "submit", text: "t", involves: [{ actorId: "aKeren", name: "Keren", userId: "uKeren" }] });
check("tagging yourself asks nobody", r.req.phase === "gm");
check("bad kind becomes add", L.reduce(base(), { type: "submit", text: "t", kind: "nuke" }).req.kind === "add");

// ── consent ──────────────────────────────────────────────────────────────────
let c = L.reduce(base(), { type: "submit", text: "t", involves: [zarg, hina] }).req;
let c1 = L.reduce(c, { type: "consent", actorId: "aZarg", yes: true }).req;
check("one of two agreed: still consent", c1.phase === "consent");
let c2 = L.reduce(c1, { type: "consent", actorId: "aHina", yes: true }).req;
check("all agreed: GM", c2.phase === "gm");
let cn = L.reduce(c, { type: "consent", actorId: "aHina", yes: false }).req;
check("refusal returns to writing with a reason", cn.phase === "writing" && /Hina said no/.test(cn.reason) && cn.text === "t");
check("double answer ignored", L.reduce(c1, { type: "consent", actorId: "aZarg", yes: false }).effect === "ignored");
check("stranger consent ignored", L.reduce(c, { type: "consent", actorId: "aNope", yes: true }).effect === "ignored");

// ── GM ───────────────────────────────────────────────────────────────────────
let g = L.reduce(base(), { type: "submit", text: "t" }).req;
let a = L.reduce(g, { type: "approve", note: "He wants a favour back." });
check("approve → fate + spend", a.req.phase === "fate" && a.effect === "spend" && a.req.note === "He wants a favour back.");
check("approve twice ignored", L.reduce(a.req, { type: "approve" }).effect === "ignored");
check("approve while writing ignored", L.reduce(base(), { type: "approve" }).effect === "ignored");
let d = L.reduce(g, { type: "deny" });
check("deny → denied, no spend", d.req.phase === "denied" && d.effect === "none");
let v = L.reduce(g, { type: "revise", reason: "Smaller, please." });
check("revise → writing keeps text", v.req.phase === "writing" && v.req.text === "t" && v.req.reason === "Smaller, please.");
check("revise default reason", /change it/.test(L.reduce(g, { type: "revise" }).req.reason));
check("finish after fate closes", L.reduce(a.req, { type: "finish" }).req === null);
check("finish while open ignored", L.reduce(g, { type: "finish" }).effect === "ignored");
check("cancel while writing closes", L.reduce(base(), { type: "cancel" }).effect === "closed");
check("cancel during fate ignored (already paid)", L.reduce(a.req, { type: "cancel" }).effect === "ignored");

// ── who may act ──────────────────────────────────────────────────────────────
check("writer submits", L.mayAct(base(), { type: "submit" }, { userId: "uKeren" }));
check("other player can't submit", !L.mayAct(base(), { type: "submit" }, { userId: "uZarg" }));
check("GM cancels anyone's", L.mayAct(base(), { type: "cancel" }, { userId: "uGM", isGM: true }));
check("other player can't cancel", !L.mayAct(base(), { type: "cancel" }, { userId: "uZarg" }));
check("tagged player consents", L.mayAct(c, { type: "consent", actorId: "aZarg" }, { userId: "uZarg" }));
check("wrong player can't consent for Zarg", !L.mayAct(c, { type: "consent", actorId: "aZarg" }, { userId: "uHina" }));
check("player can't approve", !L.mayAct(g, { type: "approve" }, { userId: "uKeren" }));

// ── text ─────────────────────────────────────────────────────────────────────
const long = L.reduce(base(), { type: "submit", text: "y".repeat(300) }).req;
check("recap fits Party Talk", L.recapLine(long).length <= 110 && L.recapLine(long).endsWith("…"));
check("recap short stays whole", L.recapLine(g) === "Fate altered by Keren: t");
const sp = L.reduce(base(), { type: "submit", spoken: true }).req;
const spA = L.reduce(sp, { type: "approve", summary: "An old comrade hides us" }).req;
check("spoken: GM summary becomes the statement", spA.text === "An old comrade hides us");
check("spoken recap uses summary", L.recapLine(spA) === "Fate altered by Keren: An old comrade hides us");
const spB = L.reduce(sp, { type: "approve" }).req;
check("spoken without summary", L.cineText(spB) === "Told at the table." && /told aloud/.test(L.recapLine(spB)));
check("summary ignored for written requests", L.reduce(g, { type: "approve", summary: "zzz" }).req.text === "t");
check("cine quotes text", L.cineText(g) === "“t”");

console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
