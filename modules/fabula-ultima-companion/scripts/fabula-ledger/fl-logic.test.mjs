// Tests for the Fabula Ledger rules. No game required.
// Run: node scripts/fabula-ledger/fl-logic.test.mjs
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
vm.runInThisContext(readFileSync(resolve(HERE, "fl-logic.js"), "utf8"), { filename: "fl-logic.js" });
const L = globalThis.FabulaLedger.Logic;

let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? "  " + JSON.stringify(detail) : ""}`);
  if (!ok) fail++;
};
const empty = () => ({ visit: { paid: [] }, prevVisit: { paid: [] }, paidTokens: {}, muted: {} });
const geist = (over = {}) => ({ actorId: "geist", source: "token", status: "villain", rank: "champion", tokenId: "t1", sceneId: "town", x: 100, y: 200, ...over });
const is = (d, action, extra = {}) => d.action === action && Object.entries(extra).every(([k, v]) => d[k] === v);

// ── statuses ─────────────────────────────────────────────────────────────────
check("villain token pays", is(L.decideAppearance(geist(), empty()), "pay"));
check("hidden never pays from detection", is(L.decideAppearance(geist({ status: "hidden" }), empty()), "ignore", { reason: "status-hidden" }));
check("never never pays", is(L.decideAppearance(geist({ status: "never" }), empty()), "ignore", { reason: "status-never" }));
check("unset Champion asks (first)", is(L.decideAppearance(geist({ status: "auto" }), empty()), "ask", { prompt: "first" }));
check("unset Champion pays with Auto-pay", is(L.decideAppearance(geist({ status: "auto" }), empty(), { autoPay: true }), "pay", { reason: "auto-pay" }));
check("unset elite is not a villain", is(L.decideAppearance(geist({ status: "auto", rank: "elite" }), empty()), "ignore", { reason: "not-a-villain" }));
check("declared elite villain pays (Asura)", is(L.decideAppearance(geist({ rank: "elite" }), empty()), "pay"));
check("junk status reads as auto", L.normStatus("Villainous") === "auto" && L.normStatus(" VILLAIN ") === "villain");

// ── visits ───────────────────────────────────────────────────────────────────
{
  const s = empty(); s.visit.paid = ["geist"];
  check("paid this visit: talking again pays nothing", is(L.decideAppearance(geist({ source: "theatre" }), s), "ignore", { reason: "paid-this-visit" }));
}
{
  const s = empty(); s.visit.paid = ["a", "b", "c"];
  check("4th villain in one visit stays quiet", is(L.decideAppearance(geist(), s), "ignore", { reason: "visit-cap" }));
}

// ── loop gate ────────────────────────────────────────────────────────────────
{
  const s = empty(); s.paidTokens[L.tokenKey(geist())] = L.tokenSpot(geist());
  check("came back, same token, same spot: ask (stationary)", is(L.decideAppearance(geist(), s), "ask", { prompt: "loop", loop: "stationary" }));
  check("stationary asks even with Auto-pay", is(L.decideAppearance(geist(), s, { autoPay: true }), "ask", { loop: "stationary" }));
  check("came back, token moved: pays", is(L.decideAppearance(geist({ x: 400 }), s), "pay"));
  check("a 1px nudge still counts as not moved", is(L.decideAppearance(geist({ x: 101 }), s), "ask"));
}
{
  const s = empty(); s.prevVisit.paid = ["geist"];
  check("paid on the visit before: ask (followed)", is(L.decideAppearance(geist({ tokenId: "t2", sceneId: "house" }), s), "ask", { loop: "followed" }));
  check("followed, via Theatre: ask too", is(L.decideAppearance(geist({ source: "theatre", tokenId: null }), s), "ask", { loop: "followed" }));
}
{
  const s = empty(); s.muted[L.tokenKey(geist())] = L.tokenSpot(geist());
  s.paidTokens[L.tokenKey(geist())] = L.tokenSpot(geist());
  check("skipped loop stays quiet next lap", is(L.decideAppearance(geist(), s), "ignore", { reason: "muted" }));
  check("muted token that moved asks/pays again", !is(L.decideAppearance(geist({ y: 600 }), s), "ignore"));
}
{
  const s = empty(); s.paidTokens[L.tokenKey(geist())] = L.tokenSpot(geist());
  check("unset Champion: status question comes before the loop question", is(L.decideAppearance(geist({ status: "auto" }), s), "ask", { prompt: "first" }));
}

// ── explicit sources ─────────────────────────────────────────────────────────
{
  const s = empty(); s.prevVisit.paid = ["geist"];
  check("event pays through a 'followed' loop", is(L.decideAppearance(geist({ source: "event" }), s), "pay"));
  check("event pays a hidden actor (author named them)", is(L.decideAppearance(geist({ source: "event", status: "hidden" }), empty()), "pay"));
  check("event does not pay a never actor", is(L.decideAppearance(geist({ source: "event", status: "never" }), empty()), "ignore"));
  s.visit.paid = ["geist"];
  check("event does not double-pay in one visit", is(L.decideAppearance(geist({ source: "event" }), s), "ignore", { reason: "paid-this-visit" }));
  check("escalation pays even if paid this visit", is(L.decideAppearance(geist({ source: "escalate" }), s), "pay", { reason: "escalation" }));
}
{
  // The trio: one Villain Entrance row naming three.
  const s = empty();
  const paid = [];
  for (const id of ["asura", "deva", "rakshasa"]) {
    const d = L.decideAppearance({ actorId: id, source: "event", status: "villain", rank: "elite" }, s);
    if (d.action === "pay") { paid.push(id); s.visit.paid.push(id); }
  }
  check("trio entrance pays 3", paid.length === 3, paid);
  const again = L.decideAppearance({ actorId: "asura", source: "theatre", status: "villain", rank: "elite" }, s);
  check("trio portrait after the row pays nothing", is(again, "ignore", { reason: "paid-this-visit" }));
}

// ── cap ──────────────────────────────────────────────────────────────────────
const cap = (c, d) => L.applyCap(c, d);
check("4 + 1 = 5", JSON.stringify(cap(4, 1)) === JSON.stringify({ next: 5, gained: 1, overflow: 0 }));
check("9 + 3 = 10, 2 lost", JSON.stringify(cap(9, 3)) === JSON.stringify({ next: 10, gained: 1, overflow: 2 }));
check("10 + 1 stays 10", cap(10, 1).next === 10 && cap(10, 1).overflow === 1);
check("Blanche 12 + 1 stays 12 (not cut to 10)", cap(12, 1).next === 12 && cap(12, 1).gained === 0);
check("Blanche 12 - 1 = 11 (a spend is never clamped)", cap(12, -1).next === 11);
check("1 - 3 floors at 0", cap(1, -3).next === 0 && cap(1, -3).gained === -1);

// ── prompt ───────────────────────────────────────────────────────────────────
check("first prompt has 4 buttons", L.promptButtons("first").join() === "confirm,skip,hidden,never");
check("loop prompt has 2 buttons", L.promptButtons("loop").join() === "confirm,skip");
check("reason text: stationary", L.promptReason(geist(), { loop: "stationary" }) === "same spot");
check("reason text: followed", L.promptReason(geist(), { loop: "followed" }) === "followed in");
check("reason text: theatre", L.promptReason(geist({ source: "theatre" }), {}) === "Theatre");

console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
