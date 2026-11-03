// warm — the in-page half of the warm Snapshot Runner (bin/warm.mjs).
//
// One page stays open and takes test after test. Between tests the world goes back to how
// it was when the page had booted (the BASELINE), so every test starts where a fresh run
// would. Only what a test wrote is put back: fake-io records the id of every document the
// page writes, and reset() diffs just those documents (with everything embedded in them)
// against the baseline.
//
// Changes go in the way the server would send another client's writes: a "modifyDocument"
// response pushed through the fake socket. Foundry applies it, fires the usual hooks, and
// the page never sends anything back. The user it comes from is another user of the world,
// so hooks that only act on their own user's writes stay quiet, as they would in play.
//
// applyWorld() uses the same path to take in world data that changed on disk (only the
// changed documents), then makes the result the new baseline.
(() => {
  const R = window.__runner;
  if (!R?.socket) throw new Error("warm.js needs fake-io's socket (window.__runner.socket)");
  const realTimeout = (globalThis.__timeWarp?.real?.st ?? globalThis.setTimeout).bind(globalThis);
  const sleep = (ms) => new Promise((r) => realTimeout(r, ms));
  const now = globalThis.__timeWarp?.real?.pn ?? performance.now.bind(performance);
  const NONE = Symbol("none");
  const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const same = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);
  const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  const cls = (type) => CONFIG[type]?.documentClass;
  // world collections by their payload key ("actors") and by document name ("Actor")
  const collections = () => [...game.collections.values()];
  const byKey = (key) => collections().find((c) => c.documentClass.metadata.collection === key);

  const W = window.__warm = {
    baseline: null,     // Map "Type.id" -> source, for every world document
    writeMark: 0,       // R.writes index the baseline is good up to
    scene: null, storage: null, windows: null, otherUser: null,
    stats: { resets: 0, pushed: 0 },
  };

  /** Update object that turns `a` into `b`: changed leaves, plus "-=key" for keys `b` lacks. */
  function diff(a, b) {
    if (isObj(a) && isObj(b)) {
      let out = null;
      for (const k of Object.keys(b)) { const d = diff(a[k], b[k]); if (d !== NONE) (out ??= {})[k] = d; }
      // an undefined value is an absent key (the baseline is a JSON copy)
      for (const k of Object.keys(a)) if (!(k in b) && a[k] !== undefined) (out ??= {})[`-=${k}`] = null;
      return out ?? NONE;
    }
    return same(a, b) ? NONE : clone(b);
  }

  /** The operations that turn the live document `cur` into `tgt`, embedded documents included. */
  function planDoc(plan, type, parentUuid, cur, tgt) {
    const emb = cls(type)?.metadata?.embedded ?? {};
    const fields = new Set(Object.values(emb));
    const own = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => !fields.has(k)));
    const d = diff(own(cur), own(tgt));
    if (d !== NONE) plan.push({ action: "update", type, parentUuid, data: { _id: tgt._id, ...d } });
    const uuid = parentUuid ? `${parentUuid}.${type}.${tgt._id}` : `${type}.${tgt._id}`;
    const list = (v) => (Array.isArray(v) ? v : isObj(v) ? [v] : []);   // ActorDelta is a single doc
    for (const [childType, field] of Object.entries(emb)) {
      const c = new Map(list(cur[field]).map((x) => [x._id, x]));
      const t = new Map(list(tgt[field]).map((x) => [x._id, x]));
      for (const id of c.keys()) if (!t.has(id)) plan.push({ action: "delete", type: childType, parentUuid: uuid, id });
      for (const [id, x] of t) {
        if (!c.has(id)) plan.push({ action: "create", type: childType, parentUuid: uuid, data: clone(x) });
        else planDoc(plan, childType, uuid, c.get(id), x);
      }
    }
  }

  /** Plan for a set of root uuids ("Actor.<id>"): live document vs `target` source (null = absent). */
  function planRoots(roots, targetOf) {
    const plan = [];
    for (const root of roots) {
      const [type, id] = root.split(".");
      const coll = game.collections.get(type);
      if (!coll) continue;
      const cur = coll.get(id)?._source ?? null, tgt = targetOf(root);
      if (cur && !tgt) plan.push({ action: "delete", type, parentUuid: null, id });
      else if (!cur && tgt) plan.push({ action: "create", type, parentUuid: null, data: clone(tgt) });
      else if (cur && tgt) planDoc(plan, type, null, cur, tgt);
    }
    return plan;
  }

  /** Push a plan through the socket, grouped per (action, type, parent), deletes first. */
  function push(plan) {
    const order = { delete: 0, create: 1, update: 2 };
    const groups = new Map();
    for (const op of plan) {
      const k = `${op.action}|${op.type}|${op.parentUuid ?? ""}`;
      if (!groups.has(k)) groups.set(k, { ...op, items: [] });
      groups.get(k).items.push(op.action === "delete" ? op.id : op.data);
    }
    for (const g of [...groups.values()].sort((a, b) => order[a.action] - order[b.action])) {
      const operation = { modifiedTime: Date.now(), render: true, renderSheet: false, parentUuid: g.parentUuid ?? undefined };
      if (g.action === "create") operation.keepId = true;
      if (g.action === "update") Object.assign(operation, { diff: true, recursive: true });
      R.socket._push("modifyDocument", { type: g.type, action: g.action, operation, result: g.items, userId: W.otherUser });
      W.stats.pushed += g.items.length;
    }
  }

  /** Roots the page wrote to since `mark` (compendium writes are not world state). */
  function dirtySince(mark) {
    const out = new Set();
    for (const w of R.writes.slice(mark)) {
      if (w.pack) continue;
      if (w.parentUuid) { out.add(w.parentUuid.split(".").slice(0, 2).join(".")); continue; }
      if (!w.ids) return null;   // an old record without ids: caller falls back to a full scan
      for (const id of w.ids) if (id) out.add(`${w.type}.${id}`);
    }
    return out;
  }
  const allRoots = () => {
    const s = new Set(W.baseline.keys());
    for (const c of collections()) for (const d of c) s.add(`${c.documentName}.${d.id}`);
    return s;
  };

  /** Wait until the page stops writing (hooks reacting to a push can write in turn). */
  async function settle(quietMs = 120, maxMs = 5000) {
    const t0 = now();
    let n = R.writes.length, since = now();
    await sleep(0);
    while (now() - t0 < maxMs) {
      await sleep(20);
      if (R.writes.length !== n) { n = R.writes.length; since = now(); }
      else if (now() - since >= quietMs) break;
    }
  }

  /** Stop whatever a test left running, the way its own cleanup would. */
  async function stopLeftovers() {
    const exp = globalThis.FUCompanion?.api?.experimental;
    const out = [];
    try { if (exp?.sim?.mode?.active) { await exp.sim.abort(); out.push("sim aborted"); } } catch (e) { out.push(`sim abort threw: ${e?.message ?? e}`); }
    try { if (exp?.battleDirector?.isRunning?.()) { await exp.battleDirector.stop({ reason: "warm-reset" }); out.push("director stopped"); } } catch (e) { out.push(`director stop threw: ${e?.message ?? e}`); }
    return out;
  }

  /** Take the baseline: what every test starts from. Call once the page has settled. */
  W.takeBaseline = async () => {
    await settle(300, 15000);
    const b = new Map();
    for (const c of collections()) for (const d of c) b.set(`${c.documentName}.${d.id}`, clone(d._source));
    W.baseline = b;
    W.writeMark = R.writes.length;
    W.scene = canvas?.scene?.id ?? null;
    W.storage = Object.fromEntries(Object.entries(localStorage));
    W.windows = new Set(Object.keys(ui.windows ?? {}));
    const me = game.user.id;
    W.otherUser = game.users.find((u) => u.id !== me && u.isGM)?.id ?? game.users.find((u) => u.id !== me)?.id ?? me;
    return { docs: b.size, scene: canvas?.scene?.name ?? null, otherUser: game.users.get(W.otherUser)?.name ?? null };
  };

  /**
   * Put the world back to the baseline. `all` diffs every document instead of only the ones
   * written to (slower; what verify() uses). Repeats while hooks keep reacting to the reset.
   */
  W.reset = async ({ all = false } = {}) => {
    const t0 = now();
    const left = await stopLeftovers();
    if (left.length) await settle();
    let roots = all ? allRoots() : (dirtySince(W.writeMark) ?? allRoots());
    let pushed = 0, passes = 0;
    for (; passes < 6; passes++) {
      const plan = planRoots(roots, (r) => W.baseline.get(r) ?? null);
      if (!plan.length) break;
      const mark = R.writes.length;
      push(plan); pushed += plan.length;
      await settle();
      roots = new Set([...roots, ...(dirtySince(mark) ?? allRoots())]);
    }
    const residue = planRoots(roots, (r) => W.baseline.get(r) ?? null);
    W.writeMark = R.writes.length;
    // what is not a document
    for (const k of Object.keys(localStorage)) if (!(k in W.storage)) localStorage.removeItem(k);
    for (const [k, v] of Object.entries(W.storage)) if (localStorage.getItem(k) !== v) localStorage.setItem(k, v);
    for (const [id, w] of Object.entries(ui.windows ?? {})) if (!W.windows.has(id)) { try { await w.close({ force: true }); } catch {} }
    try { game.user.updateTokenTargets([]); canvas?.tokens?.releaseAll?.(); } catch {}
    if (W.scene && canvas?.scene?.id !== W.scene) { try { await game.scenes.get(W.scene)?.view(); } catch {} }
    W.stats.resets++;
    return { roots: roots.size, pushed, passes, residue: residue.map((p) => `${p.action} ${p.parentUuid ? p.parentUuid + "." : ""}${p.type}.${p.id ?? p.data?._id}`), left, ms: Math.round(now() - t0) };
  };

  /**
   * Idle between requests: stop the PIXI tickers and pause running CSS animations, and put back
   * exactly those on wake(). Freezing the page alone (bin/warm.mjs) left the compositor and the
   * GPU process drawing: an idle page cost ~75% of a core, ~10% after this (2026-11-03).
   */
  W.quiet = () => {
    const q = (W.quieted = { tickers: [], anims: [] });
    for (const t of new Set([globalThis.canvas?.app?.ticker, globalThis.PIXI?.Ticker?.shared])) if (t?.started) { t.stop(); q.tickers.push(t); }
    for (const a of document.getAnimations()) if (a.playState === "running") { a.pause(); q.anims.push(a); }
    return { tickers: q.tickers.length, anims: q.anims.length };
  };
  W.wake = () => {
    const q = W.quieted; W.quieted = null;
    if (!q) return null;
    for (const t of q.tickers) t.start();
    for (const a of q.anims) { try { a.play(); } catch {} }
    return { tickers: q.tickers.length, anims: q.anims.length };
  };

  /** Every document vs the baseline, without changing anything: the reset's own check. */
  W.verify = () => {
    const plan = planRoots(allRoots(), (r) => W.baseline.get(r) ?? null);
    return { docs: W.baseline.size, differ: plan.length, sample: plan.slice(0, 12).map((p) => ({ op: `${p.action} ${p.parentUuid ? p.parentUuid + "." : ""}${p.type}.${p.id ?? p.data?._id}`, data: p.action === "update" ? JSON.stringify(p.data).slice(0, 300) : undefined })) };
  };

  /**
   * World data that changed on disk: { changed: { actors: [raw, ...] }, removed: { actors: [id] } },
   * payload keys as in world.json. Raw documents are cleaned the way Foundry cleans a payload,
   * applied, and what Foundry made of them becomes their baseline.
   */
  W.applyWorld = async ({ changed = {}, removed = {} } = {}) => {
    const t0 = now();
    const targets = new Map(), roots = new Set(), unknown = [];
    for (const [key, docs] of Object.entries(changed)) {
      const c = byKey(key); if (!c) { unknown.push(key); continue; }
      const C = c.documentClass;
      for (const raw of docs) {
        const src = clone(C.cleanData(C.migrateDataSafe(clone(raw))));
        const root = `${c.documentName}.${raw._id}`;
        targets.set(root, src); roots.add(root);
      }
    }
    for (const [key, ids] of Object.entries(removed)) {
      const c = byKey(key); if (!c) { unknown.push(key); continue; }
      for (const id of ids) { const root = `${c.documentName}.${id}`; targets.set(root, null); roots.add(root); }
    }
    const plan = planRoots(roots, (r) => targets.get(r) ?? null);
    const mark = R.writes.length;
    push(plan);
    await settle();
    for (const root of roots) {
      const [type, id] = root.split(".");
      const doc = game.collections.get(type)?.get(id);
      if (doc) W.baseline.set(root, clone(doc._source)); else W.baseline.delete(root);
    }
    // hooks that reacted to the new data wrote to other documents: those are test state, not
    // world data, so the next reset() puts them back (writeMark stays where it was)
    return { docs: roots.size, ops: plan.length, reactedWrites: R.writes.length - mark, unknown, ms: Math.round(now() - t0) };
  };
})();
