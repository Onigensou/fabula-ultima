// ============================================================================
// late-join-core — digest compare + reconcile plan.
//
//     node scripts/battle-director/late-join-core.test.mjs
//
// A client that loaded during battle setup missed every document change made
// before its `ready` (late-join-hunt-2026-11-24, root cause 2): 14 statuses
// missing on 5 actors in the measured case. Pins: the digest finds a missing
// AE, an extra (ghost) AE, a missing token, an HP difference; an event seen
// only once is not drift; the plan replays server data (not host data), actors
// before tokens before effects, under the right parent (world Actor or the
// token's ActorDelta).
// ============================================================================

const C = await import("./late-join-core.js");

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${label}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};

// ── Document look-alikes ────────────────────────────────────────────────────
const ae = (id, disabled = false) => ({ id, _id: id, name: `AE ${id}`, disabled });
const actor = (id, effects, hp = 100, mp = 50) => ({ id, effects, system: { props: { current_hp: hp, current_mp: mp } } });
const tok = (id, { actorId, link = true, x = 0, y = 0, hidden = false, actor: a = null }) => ({ id, actorId, actorLink: link, x, y, hidden, actor: a });

// HOST world: Hina (linked) has Flying + Protect; Nidhogg token (unlinked) has Boss Cycle; Field actor has Wellspring.
const H = {
  hina: actor("hina", [ae("fly"), ae("pro")], 128, 161),
  nidBase: actor("nid", [ae("base1")], 9000, 300),
  field: actor("field", [ae("well")]),
};
const hostScene = { id: "S1", tokens: [
  tok("tH", { actorId: "hina", x: 100, y: 200, actor: H.hina }),
  tok("tN", { actorId: "nid", link: false, x: 500, y: 200, actor: actor("nid", [ae("base1"), ae("cycle")], 8800, 300) }),
  tok("tSum", { actorId: "summ", link: true, x: 300, y: 300, actor: actor("summ", []) }),
] };
const hostActors = { hina: H.hina, nid: H.nidBase, field: H.field, summ: actor("summ", []) };
const host = C.buildDigest({ scene: hostScene, actorIds: ["field"], getActor: (id) => hostActors[id] ?? null, settled: true });

eq("host digest: linked token carries no fx (actor map covers it)", host.tokens.tH.fx, undefined);
eq("host digest: unlinked token carries its synthetic fx", host.tokens.tN.fx, ["base1:1", "cycle:1"]);
eq("host digest: actor map = token actors + Field", Object.keys(host.actors).sort(), ["field", "hina", "nid", "summ"]);

// ── A clean client compares clean ───────────────────────────────────────────
const clean = C.buildDigest({ scene: hostScene, actorIds: Object.keys(host.actors), getActor: (id) => hostActors[id] ?? null });
eq("identical state: no issues", C.compareDigests(host, clean), []);
eq("no battle: no issues", C.compareDigests({ active: false }, clean), []);

// ── The late joiner: Hina lacks Protect and holds a ghost; Nidhogg lacks Boss Cycle;
//    Hina's HP is stale; the summon (actor + token) never arrived; a deleted token lingers.
const L = {
  hina: actor("hina", [ae("fly"), ae("ghost")], 129, 161),
  nidBase: actor("nid", [ae("base1")], 9000, 300),
  field: actor("field", [ae("well", true)]),
};
const localScene = { id: "S1", tokens: [
  tok("tH", { actorId: "hina", x: 100, y: 200, actor: L.hina }),
  tok("tN", { actorId: "nid", link: false, x: 500, y: 260, actor: actor("nid", [ae("base1")], 8800, 300) }),
  tok("tOld", { actorId: "nid", link: false, actor: actor("nid", []) }),
] };
const localActors = { hina: L.hina, nid: L.nidBase, field: L.field };
const local = C.buildDigest({ scene: localScene, actorIds: Object.keys(host.actors), getActor: (id) => localActors[id] ?? null });
const issues = C.compareDigests(host, local);
const byK = Object.fromEntries(issues.map((i) => [i.k, i]));

eq("missing AE + extra AE on a linked actor", [byK["actor-fx:hina"]?.missing, byK["actor-fx:hina"]?.extra], [["pro"], ["ghost"]]);
eq("HP difference", byK["actor-vitals:hina"]?.want, [128, 161]);
eq("disabled flip is a change", byK["actor-fx:field"]?.changed, ["well"]);
eq("missing summon actor", !!byK["actor-missing:summ"], true);
eq("missing token", byK["token-missing:tSum"]?.actorId, "summ");
eq("extra (ghost) token", !!byK["token-extra:tOld"], true);
eq("moved token", byK["token-fields:tN"]?.fields, ["y"]);
eq("missing AE on an unlinked token", byK["token-fx:tN"]?.missing, ["cycle"]);
eq("issue count", issues.length, 8);

// ── Stability: drift seen once is not drift ─────────────────────────────────
const second = issues.filter((i) => i.k !== "token-fields:tN");    // the move landed in between
eq("stable = in both reads", C.stableIssues(issues, second).map((i) => i.k).includes("token-fields:tN"), false);
eq("stable keeps the rest", C.stableIssues(issues, second).length, 7);

// ── Phase 1: actor-level issues are fixed first, alone ──────────────────────
const fp1 = C.fetchPlan(issues, host);
eq("phase 1 = actors, fetch only actors", [fp1.phase, fp1.scene, fp1.actorIds.sort()], ["actors", false, ["field", "hina", "summ"]]);

// Server truth (raw sources). The server says Hina's HP is 127 — the plan must use THIS, not the host's 128.
const srvActors = {
  hina: { _id: "hina", system: { props: { current_hp: 127, current_mp: 161 } }, effects: [{ _id: "fly", disabled: false }, { _id: "pro", disabled: false, name: "Protect" }] },
  field: { _id: "field", system: {}, effects: [{ _id: "well", disabled: false }] },
  summ: { _id: "summ", system: {}, effects: [] },
  nid: { _id: "nid", system: {}, effects: [{ _id: "base1", disabled: false }] },
};
const p1 = C.planReconcile(C.stableIssues(issues, issues), { local, sceneId: "S1", serverActors: srvActors, localDeltaId: () => "D_N" });
const sig = (o) => `${o.action} ${o.type} ${o.parentUuid ?? "-"} ${JSON.stringify(o.result.map((r) => r?._id ?? r))}`;
eq("phase 1 ops (ordered: actor create, actor update, then effects)", p1.ops.map(sig), [
  `create Actor - ["summ"]`,
  `update Actor - ["hina"]`,
  `create ActiveEffect Actor.hina ["pro"]`,
  `update ActiveEffect Actor.field ["well"]`,
  `delete ActiveEffect Actor.hina ["ghost"]`,
]);
eq("vitals use the SERVER value", p1.ops.find((o) => o.type === "Actor" && o.action === "update").result[0].system.props.current_hp, 127);
eq("phase 1 has no token ops", p1.ops.some((o) => o.type === "Token"), false);
eq("nothing unfixable", p1.unfixable, []);

// ── Phase 2: token-level, once actors agree ─────────────────────────────────
const tokIssues = issues.filter((i) => i.kind.startsWith("token-"));
const fp2 = C.fetchPlan(tokIssues, host);
eq("phase 2 = tokens, fetch the scene", [fp2.phase, fp2.scene], ["tokens", true]);
const srvScene = { _id: "S1", tokens: [
  { _id: "tH", actorId: "hina", actorLink: true, x: 100, y: 200, hidden: false },
  { _id: "tN", actorId: "nid", actorLink: false, x: 500, y: 200, hidden: false, delta: { _id: "D_N", system: { props: { current_hp: 8800 } }, effects: [{ _id: "cycle", disabled: false }] } },
  { _id: "tSum", actorId: "summ", actorLink: true, x: 300, y: 300, hidden: false },
] };
const p2 = C.planReconcile(tokIssues, { local, sceneId: "S1", serverScene: srvScene, serverActors: srvActors, localDeltaId: (t) => (t === "tN" ? "D_N" : null) });
eq("phase 2 ops", p2.ops.map(sig), [
  `create Token Scene.S1 ["tSum"]`,
  `update Token Scene.S1 ["tN"]`,
  `delete Token Scene.S1 ["tOld"]`,
  `create ActiveEffect Scene.S1.Token.tN.ActorDelta.D_N ["cycle"]`,
]);

// A ghost token the server still has is not ours to delete.
const p3 = C.planReconcile([{ k: "token-extra:tH", kind: "token-extra", tokenId: "tH" }], { local, sceneId: "S1", serverScene: srvScene, serverActors: {} });
eq("never delete what the server still holds", [p3.ops.length, p3.unfixable.length], [0, 1]);

// A token whose actor never arrived: create the actor, then re-initialise the token.
const p4 = C.planReconcile([{ k: "token-no-actor:tX", kind: "token-no-actor", tokenId: "tX", actorId: "summ" }], { local, sceneId: "S1", serverActors: srvActors });
eq("missing token actor: create + reset-token", p4.ops.map((o) => `${o.action} ${o.type}`), ["create Actor", "reset-token Token"]);

// Server tombstone on the delta hides a base effect: the client's copy is extra.
const eff = C.effectiveDeltaEffects([{ _id: "a" }, { _id: "b" }], [{ _id: "b", _tombstone: true }, { _id: "c" }]);
eq("effective delta effects", [...eff.keys()].sort(), ["a", "c"]);

// The replay wire shape.
const r = C.toSocketResponse(p2.ops[1], { userId: "HOST", now: 5 });
eq("socket response shape", [r.type, r.action, r.userId, r.operation.parentUuid, r.operation.diff, r.operation.modifiedTime], ["Token", "update", "HOST", "Scene.S1", false, 5]);
eq("create response has no update options", "diff" in C.toSocketResponse(p2.ops[0], { userId: "HOST" }).operation, false);

// ── Gate fixes (fix pass, 2026-11-24) ───────────────────────────────────────

// Every replay is quiet: no scrolling status text burst for old news.
eq("create replay: animate:false", C.toSocketResponse(p1.ops[2], { userId: "HOST" }).operation.animate, false);
eq("update replay: animate:false", C.toSocketResponse(p1.ops[1], { userId: "HOST" }).operation.animate, false);

// Actor vitals send only the two vitals, never the whole `system`.
const srvFat = { ...srvActors, hina: { ...srvActors.hina, system: { props: { current_hp: 127, current_mp: 160, portrait: "x.png", max_hp: 200 }, other: 1 } } };
const pv = C.planReconcile([byK["actor-vitals:hina"]], { local, sceneId: "S1", serverActors: srvFat });
eq("actor-vitals op = current_hp / current_mp only", pv.ops[0].result[0], { _id: "hina", system: { props: { current_hp: 127, current_mp: 160 } } });

// B1: an AE that arrives normally between the local digest and the server read
// must not be created a second time. l2 (before the fetch) lacks "pro"; by the
// time the fetch returns the broadcast has landed, so l3 (rebuilt after the
// fetch) holds it.
{
  const hinaLate = actor("hina", [ae("fly"), ae("pro")], 128, 161);           // Protect arrived during the fetch
  const actorsL3 = { ...localActors, hina: hinaLate };
  const sceneL3 = { id: "S1", tokens: [tok("tH", { actorId: "hina", x: 100, y: 200, actor: hinaLate })] };
  const hostH = C.buildDigest({ scene: { id: "S1", tokens: [hostScene.tokens[0]] }, actorIds: [], getActor: (id) => hostActors[id] ?? null });
  const l2 = C.buildDigest({ scene: { id: "S1", tokens: [tok("tH", { actorId: "hina", x: 100, y: 200, actor: actor("hina", [ae("fly")], 128, 161) })] }, actorIds: ["hina"], getActor: (id) => (id === "hina" ? actor("hina", [ae("fly")], 128, 161) : null) });
  const stable = C.compareDigests(hostH, l2);
  eq("B1 setup: l2 sees Protect missing", stable.map((i) => i.k), ["actor-fx:hina"]);
  const srv = { hina: { _id: "hina", system: { props: { current_hp: 128, current_mp: 161 } }, effects: [{ _id: "fly" }, { _id: "pro" }] } };
  // Old behaviour (plan from l2): one create for "pro".
  const stale = C.planReconcile(stable, { local: l2, sceneId: "S1", serverActors: srv });
  eq("B1: planning from the stale digest would re-create Protect", stale.ops.map(sig), [`create ActiveEffect Actor.hina ["pro"]`]);
  // New behaviour: rebuild after the fetch, keep only issues still present.
  const l3 = C.buildDigest({ scene: sceneL3, actorIds: ["hina"], getActor: (id) => actorsL3[id] ?? null });
  const live = C.stableIssues(stable, C.compareDigests(hostH, l3));
  const fresh = C.planReconcile(live, { local: l3, sceneId: "S1", serverActors: srv });
  eq("B1: rebuilt digest -> no issue left, no create", [live.length, fresh.ops.length], [0, 0]);
  // Belt and braces: even a stale plan loses the create when the id is already here.
  const held = new Set(["ActiveEffect:Actor.hina:pro"]);
  const kept = C.dropExistingCreates(stale.ops, (op, id) => held.has(`${op.type}:${op.parentUuid}:${id}`));
  eq("B1: dropExistingCreates removes the already-held create", [kept.ops.length, kept.dropped], [0, ["ActiveEffect:pro"]]);
}
{
  const ops = [
    { type: "Actor", action: "create", parentUuid: null, result: [{ _id: "a1" }, { _id: "a2" }] },
    { type: "ActiveEffect", action: "delete", parentUuid: "Actor.a1", result: ["x"] },
  ];
  const r2 = C.dropExistingCreates(ops, (op, id) => id === "a1");
  eq("dropExistingCreates keeps the missing half + non-creates", r2.ops.map((o) => `${o.action}:${o.result.map((x) => x?._id ?? x)}`), ["create:a2", "delete:x"]);
}

// Per-id stability (post-test gate): the server read is OLDER than a live event.
{
  const dig = (hinaFx) => C.buildDigest({ scene: { id: "S1", tokens: [tok("tH", { actorId: "hina", x: 100, y: 200, actor: actor("hina", hinaFx, 128, 161) })] }, actorIds: ["hina"], getActor: (id) => (id === "hina" ? actor("hina", hinaFx, 128, 161) : null) });
  const host = (fx) => dig(fx);
  const srvOld = { hina: { _id: "hina", system: { props: { current_hp: 128, current_mp: 161 } }, effects: [{ _id: "fly" }, { _id: "pro" }] } };
  // (1) Z arrives LIVE after the reads: host has fly+pro+z, local lacked pro (stable); the server read predates z; l3 holds pro? no -- holds z.
  const h = host([ae("fly"), ae("pro"), ae("z")]);
  const i1 = C.compareDigests(h, dig([ae("fly")]));
  const i2 = C.compareDigests(h, dig([ae("fly")]));
  const stable = C.stableIssues(i1, i2);
  eq("per-id: stable lists", [stable[0].missing, stable[0].extra], [["pro", "z"], []]);
  const l3 = dig([ae("fly"), ae("z"), ae("pro")]);                // z AND pro arrived live
  eq("per-id: nothing left after both landed live", C.stableIssues(stable, C.compareDigests(h, l3)).length, 0);
  const l3b = dig([ae("fly"), ae("z")]);                           // only z landed live
  const liveB = C.stableIssues(stable, C.compareDigests(h, l3b));
  eq("per-id: only pro still missing", liveB[0].missing, ["pro"]);
  const planB = C.planReconcile(liveB, { local: l3b, sceneId: "S1", serverActors: srvOld });
  eq("per-id: AE arriving live during the fetch is NOT deleted (old server read lacks z)", planB.ops.map(sig), [`create ActiveEffect Actor.hina ["pro"]`]);
  // (2) An AE removed live after its actor was read is NOT recreated: local had it in both reads (not missing), l3 lost it, server read still lists it.
  const hHave = host([ae("fly"), ae("pro")]);
  const j1 = C.compareDigests(hHave, dig([ae("fly"), ae("pro"), ae("ghost")]));   // only a ghost differs
  const j2 = C.compareDigests(hHave, dig([ae("fly"), ae("pro"), ae("ghost")]));
  const stableJ = C.stableIssues(j1, j2);
  const l3j = dig([ae("fly")]);                                     // pro removed live, ghost removed live
  const liveJ = C.stableIssues(stableJ, C.compareDigests(hHave, l3j));
  const planJ = C.planReconcile(liveJ, { local: l3j, sceneId: "S1", serverActors: srvOld });
  eq("per-id: AE removed live after the read is NOT recreated", planJ.ops.filter((o) => o.action === "create").length, 0);
  // Whole-list diff would have recreated it: prove the scoping is what prevents it.
  const unscoped = C.planReconcile([{ k: "actor-fx:hina", kind: "actor-fx", actorId: "hina" }], { local: l3j, sceneId: "S1", serverActors: srvOld });
  eq("per-id: (control) an unscoped issue still diffs the whole list", unscoped.ops.map(sig), [`create ActiveEffect Actor.hina ["pro"]`]);
  // (3) An extra id is deleted only when extra in both reads.
  const k1 = C.compareDigests(host([ae("fly")]), dig([ae("fly"), ae("g1")]));
  const k2 = C.compareDigests(host([ae("fly")]), dig([ae("fly"), ae("g1"), ae("g2")]));
  eq("per-id: g2 (seen once) is not stable, g1 is", C.stableIssues(k1, k2)[0].extra, ["g1"]);
  // recheckOp: handler-time re-check
  const held = new Set(["Actor.hina:pro", "Actor.hina:gone-not"]);
  const has = (op, id) => held.has(`${op.parentUuid}:${id}`);
  eq("recheckOp: create of a held id -> null", C.recheckOp({ type: "ActiveEffect", action: "create", parentUuid: "Actor.hina", result: [{ _id: "pro" }] }, has), null);
  eq("recheckOp: delete of an id already gone -> null", C.recheckOp({ type: "ActiveEffect", action: "delete", parentUuid: "Actor.hina", result: ["z"] }, has), null);
  eq("recheckOp: delete keeps only ids still held", C.recheckOp({ type: "ActiveEffect", action: "delete", parentUuid: "Actor.hina", result: ["pro", "z"] }, has)?.result, ["pro"]);
  eq("recheckOp: update passes through", C.recheckOp({ type: "Actor", action: "update", result: [{ _id: "hina" }] }, has)?.action, "update");
}

// B2: reload fallback busy predicate (host side).
const S = (state, cached = null, extra = {}) => C.hostSettledFor({ state, cached, userId: "U1", ...extra });
eq("settled: DECLARE, nothing cached", S("DECLARE"), true);
eq("busy: ANY cached entry for the user (even a kind nobody listed)", S("DECLARE", [{ menuSpec: { kind: "whatever-new" } }]), false);
eq("busy: cached action-card", S("TARGET", [{ menuSpec: { kind: "action-card", ownerUserId: "U2" } }]), false);
eq("not settled: reaction window / resolve", [S("REACTION_WINDOW"), S("RESOLVE"), S("STANDALONE_REACTION_WINDOW")], [false, false, false]);
eq("CONFIRM owned by this player is not settled", S("CONFIRM", null, { actingOwnerId: "U1" }), false);
eq("CONFIRM owned by someone else, nothing cached = settled", S("CONFIRM", [], { actingOwnerId: "U2" }), true);

// B2: page probe (client side) — real selectors from reaction-hand / action-card / remote-pick.
const fakeQ = (present) => (sel) => (present[sel] ?? null);
const SEL = C.BUSY_SELECTORS;
eq("page free", C.pageBusyReason(fakeQ({}), { userId: "U1" }), null);
eq("page busy: remote picker open", C.pageBusyReason(fakeQ({}), { userId: "U1", picksOpen: 1 }), "remote-pick");
eq("page busy: a card in the reaction hand", C.pageBusyReason(fakeQ({ [SEL.reactionCard]: {} }), { userId: "U1" }), "reaction-hand");
eq("page busy: Pass card showing", C.pageBusyReason(fakeQ({ [SEL.reactionPass]: {} }), { userId: "U1" }), "reaction-pass");
eq("page busy: my own action card", C.pageBusyReason(fakeQ({ [SEL.mirror]: { dataset: { fudConfirmUserId: "U1" } } }), { userId: "U1" }), "action-card");
eq("page free: someone else's action card", C.pageBusyReason(fakeQ({ [SEL.mirror]: { dataset: { fudConfirmUserId: "U2" } } }), { userId: "U1" }), null);
eq("selectors are the real class names", [SEL.reactionCard, SEL.reactionPass, SEL.mirror], [".rxh-clip .rxh-card:not(.is-leaving)", ".rxh-clip .rxh-pass:not(.is-hidden)", "#fud-bf-mirror-root"]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
