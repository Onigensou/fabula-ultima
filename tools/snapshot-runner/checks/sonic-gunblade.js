// Sonic Blow + Gunblade (2026-11-21, branch feat/sonic-gunblade): migration result and live
// sim battles through the real FSM. Runner only (writes to the throwaway world).
//   run.mjs --snapshot snap-sonic --port 30150 --code <sha> --eval checks/sonic-gunblade.js --dump out.json
// globalThis.__SG = { only: ["A","B",...] } picks scenarios (default: all).
const NS = "fabula-ultima-companion";
const O = Object.assign({ only: null, maxRounds: 1, pace: "fast" }, globalThis.__SG ?? {});
const want = (k) => !O.only || O.only.includes(k);
for (let i = 0; i < 240 && !FUCompanion.api.experimental?.sim?.mode; i++) await new Promise((r) => setTimeout(r, 250));
const sim = FUCompanion.api.experimental?.sim;
const bd = FUCompanion.api.experimental?.battleDirector;
if (game.paused) await game.togglePause(false, true);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { scenarios: {} };

// ── 1. migration ─────────────────────────────────────────────────────────────
for (let i = 0; i < 240 && !game.items.get("mODVDmjIfozcfERi")?.getFlag(NS, "sonicGunblade"); i++) await wait(250);
const it = (id) => game.items.get(id);
const sb = it("f3QKcoZ4HwrR607a"), katar = it("3ZV5drjroWrvXqkw"), gb = it("mODVDmjIfozcfERi");
out.migration = {
  katar: { flag: katar?.getFlag(NS, "sonicGunblade"), effects: katar?.effects.map((e) => e.name), desc: katar?.system.props.description?.slice(0, 200), rarity: katar?.system.props.item_rarity, cost: katar?.system.props.item_cost },
  sonicBlow: { cost: sb?.system.props.cost, target: sb?.system.props.skill_target, range: sb?.system.props.skill_range, kw: sb?.system.props.action_keywords, carrier: sb?.system.props.attack_with_carrier,
    check: sb?.system.props.check_bonus, flags: sb?.flags?.[NS]?.carrierAttack, effects: sb?.effects.map((e) => e.name), onActivate: sb?.system.props.on_activate_effect_ref, rows: Object.keys(sb?.system.props.effect_table ?? {}).length,
    scriptLen: String(sb?.system.props.animation_script ?? "").length },
  katarPassive: { rows: Object.keys(it("rSdCKOYJzRyfFcVe")?.system.props.reaction_config_table ?? {}).length },
  gunblade: { name: gb?.name, img: gb?.img, rarity: gb?.system.props.item_rarity, cost: gb?.system.props.item_cost, martial: gb?.system.props.isMartial, atr: [gb?.system.props.rolled_atr1, gb?.system.props.rolled_atr2], dmg: gb?.system.props.damage_bonus,
    forms: gb?.flags?.[NS]?.weaponForms, kids: game.items.filter((i) => i.system?.container === "mODVDmjIfozcfERi").map((i) => i.name), scriptLen: String(gb?.system.props.animation_script ?? "").length },
  migLog: (() => { try { const l = game.settings.get(NS, "appliedMigrations"); const o = typeof l === "string" ? JSON.parse(l) : l; return o?.["2026-11-21-sonic-gunblade"] ?? (Array.isArray(o) ? o.find((x) => (x?.key ?? x) === "2026-11-21-sonic-gunblade") : null) ?? null; } catch (e) { return "ERR " + e.message; } })(),
};

// ── helpers ──────────────────────────────────────────────────────────────────
const pc = (n) => game.actors.find((a) => a.name === n && a.hasPlayerOwner && String(a.system?.props?.main_hand ?? "").trim());
const dummy = game.actors.getName("Test Target Enemy");
const ES = await import("/modules/fabula-ultima-companion/scripts/battle-director/equipment-swap.js");
async function giveWeapon(actor, weaponId) {
  const old = actor.items.filter((i) => i.getFlag(NS, "sgTest"));
  for (const o of old) { for (const k of actor.items.filter((i) => i.system?.container === o.id)) await k.delete(); await o.delete(); }
  const w = it(weaponId); const d = w.toObject(); delete d._id; d.flags = { ...(d.flags ?? {}), [NS]: { ...(d.flags?.[NS] ?? {}), sgTest: true } };
  const [nw] = await actor.createEmbeddedDocuments("Item", [d]);
  for (const k of game.items.filter((i) => i.system?.container === weaponId)) { const kd = k.toObject(); delete kd._id; kd.system.container = nw.id; await actor.createEmbeddedDocuments("Item", [kd]); }
  await ES.applyEquipmentSwap(actor, { main: nw.id, off: null });
  // a swap to a same-named weapon reads as "no change": mark the new copy worn
  if (!nw.system?.props?.isEquipped) await nw.update({ "system.props.isEquipped": true });
  return nw;
}
// watch the live director: every action result, the chain plans, Opportunity, MP of the caster
function watch(casterName) {
  const seen = new Set(); const ars = []; let opp = false; const mp = []; const forms = [];
  const iv = setInterval(() => {
    const d = bd.getActiveDirector?.(); const ar = d?.ctx?.actionResult;
    if (ar && !seen.has(ar) && (ar.chainPlan || ar.kind === "Attack")) {
      if (ar.chainPlan || !ars.some((x) => x._id === ar._instanceId)) {
        seen.add(ar);
        ars.push({ _id: ar._instanceId, kind: ar.kind, by: ar.attacker?.name, weapon: ar.weapon ? { name: ar.weapon.name, A1: ar.weapon.A1, A2: ar.weapon.A2, checkBonus: ar.weapon.checkBonus, damageBonus: ar.weapon.damageBonus, range: ar.weapon.range, weaponType: ar.weapon.weaponType, damageMult: ar.weapon.damageMult, critDamageMult: ar.weapon.critDamageMult, noCritOpportunity: ar.weapon.noCritOpportunity, chainPerfectMult: ar.weapon.chainPerfectMult, hand: ar.weapon.hand } : null,
          chain: ar.chain ? { count: ar.chain.count, mode: ar.chain.mode, perfectMult: ar.chain.perfectMult } : null, cost: ar.costSerialized, rawCost: ar.rawCost,
          roll: ar.roll ? { rA: ar.roll.rA, rB: ar.roll.rB, total: ar.roll.total, hr: ar.roll.hr, isCrit: ar.roll.isCrit } : null,
          rows: (ar.perTargetResults ?? []).map((r) => ({ name: r.name, hit: r.hit, crit: r.crit, damage: r.damage, element: r.element ?? r.damageType, affinity: r.affinity, parts: (r.damageModParts ?? r.breakdown?.parts ?? []).map?.((p) => `${p.source}:${p.amount}`) })),
          plan: ar.chainPlan ? { landed: ar.chainPlan.landed, perfect: ar.chainPlan.perfect, attackerOpportunity: ar.chainPlan.attackerOpportunity,
            strikes: ar.chainPlan.strikes.map((s) => ({ i: s.index, perfect: !!s.perfect, roll: s.roll ? `${s.roll.rA}/${s.roll.rB}=${s.roll.total} hr${s.roll.hr}${s.roll.isCrit ? " CRIT" : ""}` : null, o: (s.outcomes ?? []).map((o) => `${o.kind}${o.amount != null ? " " + o.amount : ""}${o.isCrit ? "★" : ""}${o.critBanner === false ? "(nobanner)" : ""}`).join(",") })),
            perTarget: Object.values(ar.chainPlan.perTarget ?? {}).map((t) => ({ name: t.name, landed: t.landed, missed: t.missed, crits: t.crits, damage: t.damage, perfectBonus: t.perfectBonus ?? null, hpLoss: t.hpLoss })) } : null });
      }
    }
    if (d?.ctx?.hasPendingOpportunity) opp = true;
  }, 25);
  const hid = Hooks.on("updateActor", (a, ch) => {
    const v = ch?.system?.props?.current_mp; if (v !== undefined && String(a.name).startsWith(casterName)) mp.push(v);
  });
  const nums = [];
  const hid3 = Hooks.on("fuDamageNumber", (p) => nums.push({ wall: performance.now(), kind: p?.kind, amount: p?.amount, element: p?.element, affinity: p?.affinity, isCrit: !!p?.isCrit, critBanner: p?.critBanner, resource: p?.resource }));
  const hid2 = Hooks.on("updateItem", (i, ch) => { const f = ch?.flags?.[NS]; if (f && ("activeForm" in f || "transformFreeUsedRound" in f)) forms.push({ item: i.name, actor: i.parent?.name, round: bd.getActiveDirector?.()?.dCombat?.round ?? null, ...f }); });
  return { stop() { clearInterval(iv); Hooks.off("updateActor", hid); Hooks.off("updateItem", hid2); Hooks.off("fuDamageNumber", hid3); return { ars, opp, mp, forms, nums }; } };
}
const logs = [];
const origLog = console.log;
const cap = (...a) => { const s = a.map((x) => (typeof x === "string" ? x : "")).join(" "); if (/Chain 8|Perfect|carrier|transform_weapon|applyWeaponForm|Gunblade|Sonic Blow|OPPORTUNITY|creature_transforms_weapon|turn_end/i.test(s)) logs.push(s.slice(0, 300)); };
console.log = (...a) => { try { cap(...a); } catch {} return origLog(...a); };
const origWarn = console.warn; const warns = [];
console.warn = (...a) => { try { const s = a.map((x) => (typeof x === "string" ? x : x?.message ?? "")).join(" "); if (/carrier|Sonic|Gunblade|transform|chain|volley/i.test(s)) warns.push(s.slice(0, 300)); } catch {} return origWarn(...a); };

async function sonicRun(label, card, strikes) {
  const zarg = pc(O.caster || "Zarg");
  await giveWeapon(zarg, "3ZV5drjroWrvXqkw");
  const foe = O.enemy ? game.actors.getName(O.enemy) : dummy;
  globalThis.__FU_CHAIN_FORCED_DICE__ = strikes;
  globalThis.__SB_TRACE = [];
  // frame gaps + long tasks (perf), wall-clock ms like the trace's wall field
  const perf = { gaps: [], long: [] }; let lastF = performance.now(), rafOn = true;
  const rafLoop = (t) => { if (!rafOn) return; if (t - lastF > 50) perf.gaps.push({ at: Math.round(lastF), ms: Math.round(t - lastF) }); lastF = t; requestAnimationFrame(rafLoop); }; requestAnimationFrame(rafLoop);
  let po = null; try { po = new PerformanceObserver((l) => { for (const e of l.getEntries()) perf.long.push({ at: Math.round(e.startTime), ms: Math.round(e.duration), name: e.name, attr: (e.attribution || []).map((x) => x.containerSrc || x.containerName || x.name).join("|") }); }); po.observe({ type: "longtask", buffered: false }); } catch (e) { perf.err = e.message; }
  // reference shots (O.shots): the board view + the timeline overlay, at fixed beats of the trace
  const shots = {}; let shotIv = null;
  if (O.shots) {
    const want = [["miss", (e) => e.type === "hit" && e.kind === "miss", 40], ["strike3", (e) => e.type === "hit" && e.i === 3, 30], ["strike8", (e) => e.type === "hit" && e.i === 8, 30], ["perfect", (e) => e.type === "hit" && e.i === "perfect", 50], ["hophome", (e) => e.type === "beat" && e.name === "Back", 260]];
    const full = O.shots === "full" && typeof window.__runnerShot === "function";
    const grab = () => { try { const r = canvas.app.renderer; const base = r.extract.canvas(); const W = base.width, H = base.height; const out = document.createElement("canvas"); out.width = W; out.height = H; const g = out.getContext("2d"); g.drawImage(base, 0, 0);
      for (const c of document.querySelectorAll("canvas")) { if (c === r.view || c.width < 200) continue; const st = getComputedStyle(c); if (st.position !== "fixed" && st.position !== "absolute") continue; if (+st.zIndex < 1 && !c.closest("#board")) continue; try { g.drawImage(c, 0, 0, W, H); } catch {} }
      return out.toDataURL("image/jpeg", 0.85); } catch (e) { return "ERR " + e.message; } };
    shotIv = setInterval(() => { const tr = globalThis.__SB_TRACE || []; for (const [k, fn, delay] of want) { if (shots[k] !== undefined) continue; const e = tr.find(fn); if (e) { shots[k] = null; setTimeout(async () => { if (full) { const p = await window.__runnerShot((O.shotPrefix || "sb") + "-" + k).catch((er) => "ERR " + er); shots[k] = { atMs: e.atMs + delay, file: p }; } else shots[k] = { atMs: e.atMs + delay, img: grab() }; }, delay); } } }, 5);
  }
  const errs = []; const origErr = console.error; console.error = (...a) => { try { errs.push(a.map((x) => (typeof x === "string" ? x : x?.stack ?? x?.message ?? String(x))).join(" ").slice(0, 400)); } catch {} return origErr(...a); };
  const onErr = (e) => errs.push("window.onerror " + String(e?.message ?? e).slice(0, 300)); window.addEventListener("error", onErr);
  logs.length = 0; warns.length = 0;
  const w = watch("Zarg");
  let r = null, err = null;
  try { r = await sim.run({ enemies: [{ uuid: foe.uuid, quantity: 1 }], party: [zarg.uuid], pace: O.pace, maxRounds: O.maxRounds, expectedRounds: O.maxRounds, guests: false, startingZp: 6,
      ...(O.scene ? { scene: O.scene } : {}), ...(O.forceReactions ? { forceReactions: O.forceReactions } : {}),
      scripts: [{ caster: zarg.uuid, skill: "Sonic Blow", targets: "enemy", force: card, once: true }] }); }
  catch (e) { err = String(e?.message ?? e); }
  globalThis.__FU_CHAIN_FORCED_DICE__ = null;
  console.error = origErr; window.removeEventListener("error", onErr);
  await wait(2500); if (shotIv) clearInterval(shotIv);
  const trace = globalThis.__SB_TRACE; globalThis.__SB_TRACE = null;
  rafOn = false; try { po?.disconnect(); } catch {}
  const seen = w.stop();
  out.scenarios[label] = { err, simOk: !!r, sonic: seen.ars.filter((a) => a.weapon?.name === "Sonic Blow"), otherAttacks: seen.ars.filter((a) => a.by?.startsWith("Zarg") && a.weapon?.name !== "Sonic Blow").length, opportunity: seen.opp, mpWrites: seen.mp, numbers: seen.nums, trace, perf, shots, errors: errs.filter((x) => !/ReactionConfigLint/.test(x)).slice(0, 40), logs: [...logs], warns: [...warns] };
}
// a plain Attack with a forced card roll (arm the dice when the directive declares it)
async function attackRun(label, actorName, weaponId, faces, { rounds = 1, setup = null, forceReactions = null } = {}) {
  const a = pc(actorName);
  await giveWeapon(a, weaponId);
  if (setup) await setup(a);
  const SM = sim.mode; const orig = SM.recordDeclaration.bind(SM);
  let n = 0;
  SM.recordDeclaration = (k, s) => { const f = Array.isArray(faces) ? faces[Math.min(n, faces.length - 1)] : faces; n++; if (f) SM.armDice(f[0], f[1], f[2], f[3]); return orig(k, s); };
  logs.length = 0; warns.length = 0;
  const w = watch(actorName);
  let r = null, err = null;
  try { r = await sim.run({ enemies: [{ uuid: dummy.uuid, quantity: 1 }], party: [a.uuid], pace: O.pace, maxRounds: rounds, expectedRounds: rounds, guests: false,
    scripts: [{ caster: a.uuid, skill: "Attack", attack: true, targets: "enemy", once: false }], ...(forceReactions ? { forceReactions } : {}) }); }
  catch (e) { err = String(e?.message ?? e); }
  SM.recordDeclaration = orig;
  const seen = w.stop();
  out.scenarios[label] = { err, simOk: !!r, attacks: seen.ars.filter((x) => x.by?.startsWith(actorName)), forms: seen.forms, numbers: seen.nums, logs: [...logs], warns: [...warns] };
}

const hit = O.hit || { rA: 10, rB: 9 };
if (want("A")) await sonicRun("A sonic 8/8 perfect", hit, Array(7).fill(hit));
if (want("B")) await sonicRun("B sonic 5/8 one crit", hit, (O.mixed || [{ rA: 1, rB: 2 }, { rA: 10, rB: 8 }, { rA: 7, rB: 7 }, { rA: 2, rB: 3 }, { rA: 9, rB: 8 }, { rA: 11, rB: 10 }, { rA: 1, rB: 3 }]));
if (want("C")) await sonicRun("C sonic 8/8 all crit", { rA: 8, rB: 8 }, Array(7).fill({ rA: 9, rB: 9 }));
if (want("N")) await attackRun("N katar normal hit", "Zarg", "3ZV5drjroWrvXqkw", [[10, 12, 9, 12]]);
// Gunblade, Sword form, Blanche (DEX d12 / MIG d12): an odd total, an even total, a crit, a miss
if (want("G")) {
  await attackRun("G1 gunblade 5+4", "Blanche", "mODVDmjIfozcfERi", [[5, 12, 4, 12]]);
  await attackRun("G2 gunblade 5+5", "Blanche", "mODVDmjIfozcfERi", [[5, 12, 5, 12]]);
  await attackRun("G3 gunblade crit 7+7", "Blanche", "mODVDmjIfozcfERi", [[7, 12, 7, 12]]);
  await attackRun("G4 gunblade crit 6+6", "Blanche", "mODVDmjIfozcfERi", [[6, 12, 6, 12]]);
}
// Transform after the action (turn_end ask, forced to accept) over 2 rounds: Sword → Firearm → Sword;
// round 2's attack must be the Firearm profile.
if (want("T")) await attackRun("T transform after, 2 rounds", "Blanche", "mODVDmjIfozcfERi", [[9, 12, 8, 12]], { rounds: 2, forceReactions: ["Gunblade: Transform"] });
// Transform BEFORE the action (the free Equipment chip's write + stamp, done at the wielder's
// turn start) then the after-action ask must NOT fire in the same round.
if (want("U")) {
  let hookId = null;
  await attackRun("U transform before → no after", "Blanche", "mODVDmjIfozcfERi", [[9, 12, 8, 12]], { rounds: 1, forceReactions: ["Gunblade: Transform"], setup: async () => {
    hookId = Hooks.on("updateActor", () => {});
    const once = { done: false };
    const iv = setInterval(async () => {
      const d = bd.getActiveDirector?.(); const snap = d?.ctx?.turnSnapshot;
      if (once.done || !snap || !String(snap.name).startsWith("Blanche") || d.state !== "DECLARE") return;
      once.done = true; clearInterval(iv);
      const actor = await fromUuid(snap.actorUuid); const item = actor.items.find((i) => i.name === "Gunblade" && !i.system.container);
      await ES.applyWeaponForm(actor, "main", 1);
      await item.setFlag(NS, "transformFreeUsedRound", d.dCombat.round);
      out.beforeTransform = { round: d.dCombat.round, form: item.getFlag(NS, "activeForm") };
    }, 20);
  } });
  if (hookId) Hooks.off("updateActor", hookId);
}
console.log = origLog; console.warn = origWarn;
return out;
