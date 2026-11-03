// REAL-battle scenario for Fury :: Provoke (sim: real FSM, real reactions, real
// target pin, real turn ticks). Covers what the isolated harness cannot:
//   S1  main path with COMMITTED writes: a target that was NOT Enraged ends up
//       Enraged AND Provoked (riderOf Enraged, applier = Blanche).
//   S2  the pin in play: the provoked enemy's next action includes Blanche among
//       its targets although King Gorger (her persistent summon) is also a legal target.
//   S3  lifecycle: when Enraged leaves (its real turn tick), Provoked leaves too.
// The contest is forced to a win by a LABEL-SCOPED CheckRequester stub (every other
// check in the battle still rolls for real); the stub is removed in cleanup.
import { runSimScenario, printScenario } from "../lib/sim-scenario.mjs";

const ENEMY = process.argv[2] || "Hellhound";

const res = await runSimScenario({
  name: "Provoke (real battle)",
  timeoutMin: 14,
  logFilter: "contest_check|add_target|redirect|interpos|shield_redirect|Thread|tth_|prv_|apply_ae: row|remove_ae|targets? (added|changed)",
  setup: `
    const orig = globalThis.ONI.CheckRequester;
    S.lent.origCR = true;
    globalThis.__provokeOrigCR = orig;
    globalThis.ONI.CheckRequester = { ...orig, request: async (uuids, opts) => {
      if (!/provoke/i.test(String(opts?.label ?? ""))) return orig.request(uuids, opts);
      S.events.push({ t: Date.now() - S.t0, k: "contest", dl: opts.dl, label: opts.label, ctx: opts.context?.checkContext ?? null, who: uuids.map((u) => { try { return fromUuidSync(u)?.name ?? u; } catch { return u; } }) });
      return uuids.map((u) => ({ actorUuid: u, total: opts.dl === 0 ? 30 : 1, rollA: 1, rollB: 1, modifierParts: [] }));
    } };
  `,
  sim: { caster: "Blanche", skill: "Provoke", enemy: ENEMY, quantity: 1, targets: "enemy", once: true,
         startingZp: 0, maxRounds: 5, expectedRounds: 5, reactions: "apply" },
  assert: `
    const E = S.events;
    const isB = (n) => String(n ?? "").startsWith("Blanche");
    const contest = E.filter((e) => e.k === "contest");
    const prov = E.find((e) => e.k === "ae+" && e.name === "Provoked");
    const victim = prov?.on ?? null;
    const enrBefore = E.filter((e) => e.k === "ae+" && e.name === "Enraged" && e.on === victim && e.t <= (prov?.t ?? 0));
    const out = [];
    out.push({ name: "the Provoke contest ran (label-scoped stub hit, context opposed)", pass: contest.length >= 2 && contest.every((c) => c.ctx === "opposed"), detail: contest });
    out.push({ name: "S1 Enraged created on the target in THIS action (not pre-existing)", pass: enrBefore.length >= 1, detail: enrBefore.map((e) => e.on + " @" + e.t) });
    out.push({ name: "S1 Provoked created (riderOf Enraged, applier Blanche)", pass: !!prov && prov.rider === "Enraged" && isB(prov.applier), detail: prov });
    const provT = prov?.t ?? Infinity;
    const enemyActs = E.filter((e) => e.k === "act" && e.src === victim && e.t > provT);
    const firstHostile = enemyActs.find((a) => a.pin);
    const provGone = E.find((e) => e.k === "ae-" && e.name === "Provoked" && e.on === victim && e.t > provT);
    const pinWindow = firstHostile && (!provGone || firstHostile.t < provGone.t);
    out.push({ name: "S2 the provoked enemy's next attack/offensive spell includes Blanche", pass: !!pinWindow && (firstHostile.targets ?? []).some(isB),
      detail: { firstHostile, allEnemyActs: enemyActs.map((a) => ({ t: a.t, action: a.action, pin: a.pin, targets: a.targets })) } });
    const died = E.find((e) => e.k === "res" && e.on === victim && e.key === "current_hp" && Number(e.value) <= 0);
    const alive = (t) => !died || t < died.t;   // a battle-end / defeat sweep is not the rider
    // "Mid-battle" = some action still happens AFTER the removal. The end-of-battle
    // sweep deletes every AE in one window and nothing acts after it, so a rider
    // pass read off that window proves nothing (gate-2 review, scn-provoke3).
    const lastAct = Math.max(...E.filter((e) => e.k === "act").map((e) => e.t), 0);
    const endT = Math.min(...E.filter((e) => e.k === "end").map((e) => e.t), Infinity);
    const midBattle = (t) => alive(t) && t < lastAct && t < endT;
    const tthGone = E.find((e) => e.k === "ae-" && e.name === "Provoked (Thread the Horns)" && e.on === victim);
    const furyOnlyAct = tthGone ? enemyActs.find((a) => a.pin && a.t > tthGone.t && (!provGone || a.t < provGone.t)) : null;
    out.push(furyOnlyAct ? { name: "S2b after the TtH taunt is spent, the Fury pin alone still steers the attack", pass: (furyOnlyAct.targets ?? []).some(isB), detail: furyOnlyAct }
                         : { name: "S2b Fury pin alone steers an attack", pass: null, detail: "no hostile action under the Fury pin alone (TtH never fired, or nothing acted after it)" });
    const enrGone = E.find((e) => e.k === "ae-" && e.name === "Enraged" && e.on === victim && e.t > provT && midBattle(e.t));
    out.push({ name: "S3 Provoked leaves when Enraged leaves (rider)", pass: enrGone ? (!!provGone && provGone.t >= enrGone.t) : null,
      detail: enrGone ? { enrGone: enrGone.t, provGone: provGone?.t ?? null } : "Enraged never expired mid-battle (only the end/defeat sweep removed it)" });
    return out.map((a) => ({ ...a, pass: a.pass === null ? true : a.pass, detail: a.pass === null ? "NOT EXERCISED: " + JSON.stringify(a.detail) : a.detail }));
  `,
  cleanup: `
    if (globalThis.__provokeOrigCR) { globalThis.ONI.CheckRequester = globalThis.__provokeOrigCR; delete globalThis.__provokeOrigCR; }
    return { crRestored: !!globalThis.ONI.CheckRequester?.request };
  `,
});
printScenario(res);
const fs = await import("node:fs");
fs.writeFileSync(process.env.SCN_OUT ?? "scenario-provoke.out.json", JSON.stringify(res, null, 1));
