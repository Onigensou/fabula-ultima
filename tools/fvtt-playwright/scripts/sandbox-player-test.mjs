// sandbox-player-test.mjs — Sonic Blow + Gunblade with a REAL player client on a sandbox server (own dataPath/port).
// GM = headless (canvas off) runs the director; the player (Keren's user) is a visible GPU client that clicks the
// real UI: Octopath → Skill → Sonic Blow → target → Confirm; then (round 2) Equipment → Firearm chip → Confirm,
// Attack → target → Confirm, and the turn-end "Gunblade: Transform" ask on the player's screen.
//   FVTT_BASE_URL=http://localhost:30152 FVTT_DATA_PATH=<sandbox> node scripts/sandbox-player-test.mjs --out <dir>
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, launch, waitReady } from "../lib/foundry.js";

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const OUT = arg("--out") ?? "sandbox-player"; mkdirSync(OUT, { recursive: true });
const PLAYER = arg("--player") ?? "Blumairwen";
const base = loadConfig();
const R = { steps: [], gm: [], player: [], errors: [] };
const t0 = Date.now();
const note = (s, extra) => { const e = { t: Date.now() - t0, s, ...(extra ? { extra } : {}) }; R.steps.push(e); console.log(`[${(e.t / 1000).toFixed(1)}s] ${s}${extra ? " " + JSON.stringify(extra).slice(0, 300) : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function joinAs(cfg, label) {
  const { browser, page } = await launch(cfg);
  page.on("console", (m) => { const tx = m.text(); if (m.type() === "error" || /Sonic Blow|Gunblade|Chain 8|Perfect|transform|carrier|DataMigration|Opportunity|applied \d+ dmg/i.test(tx)) R[label].push({ t: Date.now() - t0, type: m.type(), text: tx.slice(0, 500) }); });
  page.on("pageerror", (e) => R.errors.push({ who: label, t: Date.now() - t0, e: String(e.message).slice(0, 400) }));
  await page.goto(cfg.baseURL, { waitUntil: "domcontentloaded" });
  for (let i = 0; i < 60; i++) {
    const s = await page.evaluate(() => (document.querySelector('select[name="userid"]') ? "join" : (globalThis.game?.ready ? "game" : "other"))).catch(() => "other");
    if (s === "join") { await page.locator('select[name="userid"]').selectOption({ label: cfg.user }); await page.locator('button[name="join"]').click(); break; }
    if (s === "game") break; await sleep(1000);
  }
  await waitReady(page, cfg);
  return { browser, page };
}
const shot = async (page, name) => { try { await page.screenshot({ path: join(OUT, name + ".png") }); } catch {} };
// click the deepest visible element whose own text matches, inside an optional root selector
const clickText = (page, rx, root = "body") => page.evaluate(({ src, flags, root }) => {
  const re = new RegExp(src, flags); const R0 = document.querySelector(root); if (!R0) return null;
  const vis = (el) => { const r = el.getBoundingClientRect(); const st = getComputedStyle(el); return r.width > 2 && r.height > 2 && st.visibility !== "hidden" && st.display !== "none" && +st.opacity > 0.05; };
  const all = [...R0.querySelectorAll("*")].filter((el) => re.test((el.textContent || "").trim()) && vis(el));
  const leaf = all.filter((el) => ![...el.children].some((c) => all.includes(c)));
  const el = leaf[0]; if (!el) return null;
  const btn = el.closest("button, a, li, .blade, [data-fud-action], .fud-lp-row, .lp-row, [role=button]") || el;
  btn.scrollIntoView?.({ block: "center" }); btn.click(); return (btn.className || btn.tagName) + " :: " + (btn.textContent || "").trim().slice(0, 60);
}, { src: rx.source, flags: rx.flags, root });
const visible = (page, sel) => page.evaluate((s) => [...document.querySelectorAll(s)].some((el) => { const r = el.getBoundingClientRect(); return r.width > 2 && r.height > 2 && getComputedStyle(el).visibility !== "hidden"; }), sel).catch(() => false);
const gmEval = (gm, fn, a) => gm.page.evaluate(fn, a);

let gm = null, pl = null;
try {
  gm = await joinAs({ ...base, headless: true, canvas: "off", gpu: false }, "gm");
  await gmEval(gm, async () => { if (game.paused) await game.togglePause(false, true); });
  note("GM ready (unpaused)");
  pl = await joinAs({ ...base, user: PLAYER, headless: false, gpu: true }, "player");
  note("player ready", { user: PLAYER });

  // ── setup on the GM: Keren wields Sonic Katar; the dummy is the foe ──
  const setup = await gmEval(gm, async () => {
    const NS = "fabula-ultima-companion";
    const k = game.actors.find((a) => a.name === "Keren" && a.hasPlayerOwner);
    const give = async (wid) => { const w = game.items.get(wid); const d = w.toObject(); delete d._id; d.flags = { ...(d.flags ?? {}), [NS]: { ...(d.flags?.[NS] ?? {}), sgTest: true } };
      const [nw] = await k.createEmbeddedDocuments("Item", [d]); for (const c of game.items.filter((i) => i.system?.container === wid)) { const cd = c.toObject(); delete cd._id; cd.system.container = nw.id; await k.createEmbeddedDocuments("Item", [cd]); } return nw; };
    const ES = await import("/modules/fabula-ultima-companion/scripts/battle-director/equipment-swap.js");
    const katar = await give("3ZV5drjroWrvXqkw"); const gun = await give("mODVDmjIfozcfERi");
    await ES.applyEquipmentSwap(k, { main: katar.id, off: null }); if (!katar.system.props.isEquipped) await katar.update({ "system.props.isEquipped": true });
    await k.update({ "system.props.current_mp": Number(k.system.props.max_mp) || 70 });
    window.__SGT = { kerenUuid: k.uuid, katarId: katar.id, gunId: gun.id };
    return { keren: k.uuid, main: k.system.props.main_hand, mp: k.system.props.current_mp, katar: katar.id, gun: gun.id };
  });
  note("setup", setup);

  // ── start a battle: Keren (party) vs Test Target Enemy, party advantage (Keren acts first) ──
  await gmEval(gm, async () => {
    const k = await fromUuid(window.__SGT.kerenUuid); const d = game.actors.getName("Test Target Enemy"); const sc = game.scenes.getName("Training Ground");
    window.__SGT.log = []; const L = window.__SGT.log;
    const bd = FUCompanion.api.experimental.battleDirector;
    // record every action result + chain plan the GM director builds
    const seen = new Set(); window.__SGT.iv = setInterval(() => { const dd = bd.getActiveDirector?.(); const ar = dd?.ctx?.actionResult; if (ar && !seen.has(ar)) { seen.add(ar); L.push({ t: Date.now(), state: dd.state, kind: ar.kind, w: ar.weapon?.name, A: ar.weapon ? ar.weapon.A1 + "/" + ar.weapon.A2 + " " + ar.weapon.range : null, cost: ar.costSerialized, chain: ar.chain?.count ?? null, plan: ar.chainPlan ? ar.chainPlan.strikes.map((s) => (s.outcomes?.[0]?.kind ?? "?") + (s.outcomes?.[0]?.amount != null ? " " + s.outcomes[0].amount : "") + (s.perfect ? "P" : "")) : null, opp: !!dd.ctx.hasPendingOpportunity, forms: ar.weaponFormSelections ?? null }); } }, 50);
    window.__SGT.forms = []; Hooks.on("updateItem", (it, ch) => { const f = ch?.flags?.["fabula-ultima-companion"]; if (f && ("activeForm" in f || "transformFreeUsedRound" in f)) window.__SGT.forms.push({ t: Date.now(), item: it.name, actor: it.parent?.name, round: bd.getActiveDirector?.()?.dCombat?.round ?? null, ...f }); });
    window.__SGT.mp = []; Hooks.on("updateActor", (a, ch) => { const v = ch?.system?.props?.current_mp; if (v !== undefined && a.name === "Keren") window.__SGT.mp.push(v); });
    await bd.start({ payload: { context: { battleSceneUuid: sc.uuid, sourceSceneId: sc.id, lean: true }, encounterPlan: { mode: "manual", manualPicks: [{ actorUuid: d.uuid, name: d.name, quantity: 1 }] },
      party: { members: [{ actorUuid: k.uuid, actorId: k.id, name: k.name, slot: 0, img: k.img }] }, battlePlan: { engagement: "advantage" } } });
  });
  note("battle started");

  // ── the player drives: a step table, each a (when visible) → (click) rule ──
  const PASS = { name: "pass other reaction", when: ".rxh-card", click: () => pl.page.evaluate(() => { const cards = [...document.querySelectorAll(".rxh-card")]; if (cards.some((x) => /Gunblade/i.test(x.textContent))) return null; const p = document.querySelector(".rxh-pass") || cards.find((x) => /^s*Pass/i.test(x.textContent)); if (!p) return null; p.click(); return "pass (" + cards.map((x) => (x.querySelector(".rxh-name")?.textContent || "").trim()).join(",") + ")"; }) };
  const UNPAUSE = { name: "unpause", when: "body", click: () => gmEval(gm, async () => { if (!game.paused) return null; await game.togglePause(false, true); return "unpaused"; }) };
  async function drive(goal, rules, ms) {
    rules = [UNPAUSE, ...rules, PASS];
    const until = Date.now() + ms; let last = "";
    while (Date.now() < until) {
      if (await goal()) return true;
      for (const r of rules) {
        if (r.once && r.done) continue;
        if (!(await visible(pl.page, r.when))) continue;
        const c = r.click ? await r.click() : await clickText(pl.page, r.text, r.root ?? r.when);
        if (c) { if (c !== last) { note(`player: ${r.name}`, c); await shot(pl.page, `${r.name.replace(/\W+/g, "_")}-${Date.now() - t0}`); } last = c; r.done = true; await sleep(r.after ?? 700); break; }
      }
      await sleep(250);
    }
    return false;
  }
  const gmLog = () => gmEval(gm, () => ({ log: window.__SGT.log.slice(), forms: window.__SGT.forms.slice(), mp: window.__SGT.mp.slice(), state: FUCompanion.api.experimental.battleDirector.getActiveDirector?.()?.state ?? null, round: FUCompanion.api.experimental.battleDirector.getActiveDirector?.()?.dCombat?.round ?? null, bd: (globalThis.__bdLog || []).slice(-30) }));

  // 1) Sonic Blow from the player's own menu
  const okSB = await drive(async () => (await gmLog()).log.some((x) => x.w === "Sonic Blow" && x.plan), [
    { name: "octopath Skill", when: ".fud-octopath", text: /^Skill$/i },
    { name: "pick Sonic Blow", when: ".fud-lp-root", text: /^Sonic Blow$/ , once: true},
    { name: "pick target", when: ".fud-lp-root", text: /Test Target Enemy/ },
    { name: "confirm card", when: ".fud-bf-card [data-fud-action=\"confirm\"]", click: () => pl.page.evaluate(() => { const b = document.querySelector('.fud-bf-card [data-fud-action="confirm"]'); if (!b) return null; b.click(); return "confirm"; }) },
  ], 120000);
  note("Sonic Blow resolved via the player", { ok: okSB });
  await sleep(6000); await shot(pl.page, "after-sonic-blow");
  R.afterSonic = await gmLog();

  // 2) swap Keren to the Gunblade (GM, between turns), then the player: Equipment → Firearm chip → Confirm (free),
  //    Attack → target → Confirm, and the turn-end transform ask.
  await gmEval(gm, async () => { const k = await fromUuid(window.__SGT.kerenUuid); const ES = await import("/modules/fabula-ultima-companion/scripts/battle-director/equipment-swap.js");
    await ES.applyEquipmentSwap(k, { main: window.__SGT.gunId, off: null }); const g = k.items.get(window.__SGT.gunId); if (!g.system.props.isEquipped) await g.update({ "system.props.isEquipped": true }); });
  note("GM: Keren now holds the Gunblade");
  const formOf = () => gmEval(gm, () => { const k = fromUuidSync(window.__SGT.kerenUuid); return k.items.get(window.__SGT.gunId)?.getFlag("fabula-ultima-companion", "activeForm") ?? 0; });
  const okEq = await drive(async () => (await formOf()) === 1, [
    { name: "octopath Equipment", when: ".fud-octopath", text: /^Equipment$/i },
    { name: "Firearm chip", when: ".fud-bf-card .fud-bf-form-chip", click: () => pl.page.evaluate(() => { const c = [...document.querySelectorAll(".fud-bf-card .fud-bf-form-chip")].find((x) => /Firearm/i.test(x.textContent)); if (!c) return null; c.click(); return "chip " + c.textContent.trim(); }), once: true },
    { name: "confirm equipment", when: ".fud-bf-card [data-fud-action=\"confirm\"]", click: () => pl.page.evaluate(() => { const b = document.querySelector('.fud-bf-card [data-fud-action="confirm"]'); if (!b) return null; b.click(); return "confirm"; }) },
  ], 150000);
  note("before-action transform via the Equipment card", { ok: okEq, form: await formOf() });
  await shot(pl.page, "after-equipment");
  const okAtk = await drive(async () => (await gmLog()).log.some((x) => x.w === "Gunblade" && x.kind === "Attack"), [
    { name: "octopath Attack", when: ".fud-octopath", text: /^Attack$/i },
    { name: "pick target 2", when: ".fud-lp-root", text: /Test Target Enemy/ },
    { name: "confirm attack", when: ".fud-bf-card [data-fud-action=\"confirm\"]", click: () => pl.page.evaluate(() => { const b = document.querySelector('.fud-bf-card [data-fud-action="confirm"]'); if (!b) return null; b.click(); return "confirm"; }) },
  ], 120000);
  note("Firearm attack declared", { ok: okAtk });
  // the turn-end ask: it must NOT appear (the free transform was spent before the action this round)
  await sleep(8000);
  R.askAfterBefore = await pl.page.evaluate(() => [...document.querySelectorAll(".rxh-card, .rxh-name")].map((e) => e.textContent.trim()).filter((s) => /Gunblade/i.test(s)));
  note("turn-end ask after a before-action transform (expect none)", R.askAfterBefore);
  await shot(pl.page, "turn-end-round2");
  // next round: plain attack, then the turn-end ask SHOULD appear on the player; use it
  const okAsk = await drive(async () => (await gmLog()).forms.some((f) => f.activeForm === 0), [
    { name: "octopath Attack r3", when: ".fud-octopath", text: /^Attack$/i },
    { name: "pick target 3", when: ".fud-lp-root", text: /Test Target Enemy/ },
    { name: "confirm attack r3", when: ".fud-bf-card [data-fud-action=\"confirm\"]", click: () => pl.page.evaluate(() => { const b = document.querySelector('.fud-bf-card [data-fud-action="confirm"]'); if (!b) return null; b.click(); return "confirm"; }) },
    { name: "use the transform ask", keepAsks: true, when: ".rxh-card", click: () => pl.page.evaluate(() => { const c = [...document.querySelectorAll(".rxh-card")].find((x) => /Gunblade/i.test(x.textContent)); if (!c) return null; c.click(); return "rxh " + c.textContent.trim().slice(0, 60); }) },
  ], 180000);
  note("turn-end ask used on the player client", { ok: okAsk, form: await formOf() });
  R.final = await gmLog();
  await shot(pl.page, "final");
} catch (e) { R.errors.push({ fatal: String(e.stack ?? e.message).slice(0, 1500) }); note("FATAL " + e.message); }
finally {
  try { if (gm) await gmEval(gm, () => { try { clearInterval(window.__SGT?.iv); FUCompanion.api.experimental.battleDirector.stop?.(); } catch {} }); } catch {}
  writeFileSync(join(OUT, "result.json"), JSON.stringify(R, null, 1));
  try { await pl?.browser?.close(); } catch {} try { await gm?.browser?.close(); } catch {}
}
console.log("done ->", join(OUT, "result.json"));
