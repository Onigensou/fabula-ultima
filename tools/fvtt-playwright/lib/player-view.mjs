// player-view — test what a PLAYER actually sees and can do, in a REAL (non-sim)
// Battle Director battle. Two browsers only: the GM seat is the held bridge client
// (evalGM), the player is ONE Playwright page logged in as that player.
//
// Why: the sim answers every human gate on the GM, so it can never show that an ask
// blade reaches the right player, that the target picker locks a Provoked pin on the
// player's screen, or that the player's check panel shows a bonus line. USER
// 2026-09-27: run it on the LIVE world (no copy) — see memory
// feedback_player_client_tests_on_live_world_ok. Map of every surface / selector:
// scratchpad bd-player-ui-map.md (2026-09-27), summarised in memory reference_player_view_driver.
//
// Live-world rules this enforces:
//  - Outside the sim party PCs are the REAL actors (linked token): snapshot the PC's
//    props / effects / items (equip + flags) before, restore after, delete lent docs by id.
//  - Owner routing picks the lowest-id ACTIVE non-GM owner: the test player must be the
//    ONLY active player (asserted).
//  - Connect the player BEFORE start() (menus only go to an active owner).
//  - Never click the GM page while a player surface is open (the GM renders its own copy).
//  - Two Chromium max (BSOD hazard); kill only chrome-headless-shell, never chrome.
import { connect } from "./foundry.js";
import { evalGM } from "../scripts/bridge.mjs";

export async function gm(code, timeoutMs = 120000) {
  const r = await evalGM(code, timeoutMs);
  if (!r.ok) throw new Error(`GM page error: ${r.error}\n${(r.errorStack ?? "").slice(0, 600)}`);
  return r.result;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Connect the player page and assert it is the only active player. */
export async function openPlayer(user) {
  const fvtt = await connect({ user, password: process.env.FVTT_PLAYER_PASSWORD ?? "", autoStartServer: false });
  const others = await gm(`return game.users.filter(u => u.active && !u.isGM).map(u => u.name);`);
  if (others.length !== 1 || others[0] !== user) {
    await fvtt.close();
    throw new Error(`player-view needs ${user} to be the ONLY active player; active players: ${JSON.stringify(others)}`);
  }
  // Player-side observer: every BD MENU envelope the player receives, for assertions.
  await fvtt.page.evaluate(() => {
    globalThis.__pt = { ev: [] };
    const push = (k, d) => { try { globalThis.__pt.ev.push({ t: Date.now(), k, ...d }); } catch {} };
    for (const h of ["fud.actionPickerOpen", "fud.actionPickerClose"]) Hooks.on(h, () => push(h, {}));
    const obs = new MutationObserver((muts) => { for (const m of muts) for (const n of m.addedNodes) {
      if (n.nodeType !== 1) continue;
      const cls = String(n.className ?? "");
      if (/fud-react-menu|fud-target|oni-cr|fud-octopath|fud-bf/.test(cls + " " + (n.id ?? "")))
        push("dom+", { id: n.id ?? null, cls: cls.slice(0, 120), trigger: n.dataset?.fudTrigger ?? null });
    } });
    obs.observe(document.body, { childList: true, subtree: true });
  });
  return fvtt;
}

/** Wait on the PLAYER page for a selector (optionally with text), polling (headless pages are "backgrounded"). */
export async function waitPlayer(page, selector, { text = null, timeoutMs = 60000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = await page.evaluate(({ selector, text }) => {
      const els = [...document.querySelectorAll(selector)];
      const el = text ? els.find((e) => (e.textContent ?? "").trim().includes(text)) : els[0];
      return el ? { found: true, text: (el.textContent ?? "").trim().slice(0, 200) } : { found: false, n: els.length };
    }, { selector, text });
    if (hit.found) return hit;
    await sleep(400);
  }
  return null;
}

/** Snapshot a real actor so the teardown can put it back (props, effect ids, item equip/flags). */
export async function snapshotActor(uuid) {
  return gm(`const a = await fromUuid(${JSON.stringify(uuid)});
    globalThis.__pvSnap ??= {};
    globalThis.__pvSnap[a.uuid] = { props: foundry.utils.deepClone(a.system.props), effectIds: a.effects.map(e => e.id), itemIds: a.items.map(i => i.id),
      items: a.items.map(i => ({ id: i.id, isEquipped: i.system?.props?.isEquipped ?? null, flags: foundry.utils.deepClone(i.flags ?? {}) })) };
    return { effects: a.effects.size, items: a.items.size, hp: a.system.props.current_hp, mp: a.system.props.current_mp };`);
}

/** Restore a snapshotted actor: delete new effects/items, put resource props + equip/flags back. */
export async function restoreActor(uuid) {
  return gm(`const a = await fromUuid(${JSON.stringify(uuid)}); const s = globalThis.__pvSnap?.[a.uuid];
    if (!s) return { skipped: "no snapshot" };
    const newAEs = a.effects.filter(e => !s.effectIds.includes(e.id)).map(e => e.id);
    if (newAEs.length) await a.deleteEmbeddedDocuments("ActiveEffect", newAEs);
    const newItems = a.items.filter(i => !s.itemIds.includes(i.id)).map(i => i.id);
    if (newItems.length) await a.deleteEmbeddedDocuments("Item", newItems);
    const keys = ["current_hp", "current_mp", "current_ip", "fabula_point", "zero_power", "current_zero_power"];
    const patch = {}; for (const k of keys) if (k in s.props && a.system.props[k] !== s.props[k]) patch["system.props." + k] = s.props[k];
    if (Object.keys(patch).length) await a.update(patch);
    const itemFix = [];
    for (const it of s.items) { const cur = a.items.get(it.id); if (!cur) continue;
      const upd = { _id: it.id }; let dirty = false;
      if ((cur.system?.props?.isEquipped ?? null) !== it.isEquipped) { upd["system.props.isEquipped"] = it.isEquipped; dirty = true; }
      if (JSON.stringify(cur.flags ?? {}) !== JSON.stringify(it.flags)) { upd.flags = it.flags; dirty = true; }
      if (dirty) itemFix.push(upd); }
    if (itemFix.length) await a.updateEmbeddedDocuments("Item", itemFix);
    const missingAEs = s.effectIds.filter(id => !a.effects.get(id));
    delete globalThis.__pvSnap[a.uuid];
    return { deletedAEs: newAEs.length, deletedItems: newItems.length, props: Object.keys(patch), itemsFixed: itemFix.length, missingOriginalAEs: missingAEs };`);
}

/** GM: start a real battle and wait until it has left PREP with every token placed on the GM canvas. */
export async function startBattle({ partyUuids, enemies, battlePlan = { initiativeMode: "sidePriority", engagement: "normal" }, sceneName = "Training Ground" }) {
  await gm(`const bd = FUCompanion.api.experimental.battleDirector;
    if (bd.isRunning()) throw new Error("a battle is already running");
    if (FUCompanion.api.experimental.sim.mode?.active) throw new Error("sim mode is active");
    const scene = game.scenes.getName(${JSON.stringify(sceneName)});
    const members = []; let slot = 1;
    for (const u of ${JSON.stringify(partyUuids)}) { const a = await fromUuid(u); members.push({ actorUuid: a.uuid, actorId: a.id, name: a.name, slot: slot++, img: a.img }); }
    const manualPicks = [];
    for (const e of ${JSON.stringify(enemies)}) { const a = await fromUuid(e.uuid); manualPicks.push({ actorUuid: a.uuid, name: a.name, quantity: e.quantity ?? 1 }); }
    await bd.start({ payload: { context: { battleSceneUuid: scene.uuid, sourceSceneId: scene.id, lean: true },
      battlePlan: ${JSON.stringify(battlePlan)}, encounterPlan: { mode: "manual", manualPicks }, party: { members } } });
    return true;`);
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const st = await gm(`const d = FUCompanion.api.experimental.battleDirector.getActiveDirector();
      const s = FUCompanion.api.experimental.battleDirector.status();
      const cs = d?.dCombat?.combatants ?? [];
      return { state: s?.state ?? d?.state ?? null, started: !!d?.dCombat?.started,
        combatants: cs.map(c => ({ name: c.name, side: c.side, placed: !!canvas.tokens.get(c.tokenId) })) };`, 30000);
    if (st.state && st.state !== "PREP" && st.combatants.length && st.combatants.every((c) => c.placed)) return st;
    await sleep(1500);
  }
  throw new Error("battle did not leave PREP with all tokens placed within 120 s");
}

export async function stopBattle() {
  return gm(`const bd = FUCompanion.api.experimental.battleDirector;
    if (!bd.isRunning()) return { wasRunning: false };
    await bd.stop({ reason: "player-view-test" });
    return { wasRunning: true, runningAfter: bd.isRunning() };`);
}

/** Click an element on the PLAYER page (optionally matching text), returns whether it was clicked. */
export async function clickPlayer(page, selector, { text = null } = {}) {
  return page.evaluate(({ selector, text }) => {
    const els = [...document.querySelectorAll(selector)];
    const el = text ? els.find((e) => (e.textContent ?? "").trim().includes(text)) : els[0];
    if (!el) return false;
    el.click();
    return true;
  }, { selector, text });
}

export async function pollGM(code, { until, timeoutMs = 15000, everyMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) { last = await gm(code, 30000); if (until(last)) return last; await sleep(everyMs); }
  return last;
}
