// ============================================================================
// Dungeon Pathing — Link play (what happens on the moving client)
//
//   split(scene, fromId, neighbours)  walkable vs. blocked neighbours (dp-bootstrap
//                                     rebuild): locked links and the wrong way of a
//                                     one-way link stay in the graph but can't be walked
//   onBlocked({...})                  a click on a blocked neighbour:
//                                       one-way / story switch → bump + hint
//                                       key lock               → Use Key / Go Back
//                                       skill check            → Roll / Go Back (GM runs it)
//                                     then, when the way opens, the normal move runs
//
// Turn hooks (same order as the game's turn: move → Confirm → tile event → turnEnd):
//   TURN_CONFIRMED  hazard path → its effect (tile effect engine); collapsing path → breaks
//   TURN_END        landing → hidden-until-landing paths revealed + "land" events (GM)
// So nothing new is revealed before the move is confirmed, as with fog.
// ============================================================================
(() => {
  const DP  = globalThis.DungeonPathing ??= {};
  const TAG = "[DungeonPathing][LinkPlay]";
  const MOD = "fabula-ultima-companion";
  const Core = () => DP.LinksCore;
  const L = () => DP.Links;
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const migrated = (scene) => !!L()?.isMigrated?.(scene);

  // ── Walkable vs. blocked ───────────────────────────────────────────────────
  function split(scene, fromId, neighbours) {
    const blocked = new Map();
    if (!migrated(scene) || !fromId) return { walk: neighbours, blocked };
    const links = L().read(scene), st = L().state(scene), ctx = { state: st, switchOn: L().switchOn };
    const walk = [];
    for (const n of neighbours) {
      const hit = Core().linkBetween(links, fromId, n.nodeId, st);
      const rule = hit ? Core().stepRule(hit.id, hit.link, fromId, ctx) : { ok: true };
      if (rule.ok || _passOnce.has(hit?.id)) walk.push(n);
      else blocked.set(n.nodeId, { id: hit.id, link: hit.link, reason: rule.reason });
    }
    return { walk, blocked };
  }
  const _passOnce = new Set();      // a skill check passed for this crossing only (lock.stays === false)

  // ── Small UI: hint strip, lock prompt, bump ────────────────────────────────
  const STYLE_ID = "oni-dp-linkplay-style";
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style"); s.id = STYLE_ID;
    s.textContent = `
#oni-dp-hint { position: fixed; left: 50%; bottom: 120px; z-index: 99991; pointer-events: none; transform: translate(-50%, 10px); opacity: 0;
  background: #fffaf1; color: #3a2410; border: 2px solid #4a2c18; border-radius: 12px; padding: 7px 16px; font: 700 14px "Palatino Linotype", Palatino, Georgia, serif;
  box-shadow: 0 4px 12px rgba(40,24,8,.35); transition: opacity 200ms ease, transform 200ms ease; max-width: 70vw; text-align: center; }
#oni-dp-hint.show { opacity: 1; transform: translate(-50%, 0); }
#oni-dp-lockprompt { position: fixed; z-index: 99999; display: flex; flex-direction: column; gap: 5px; width: 130px; }
#oni-dp-lockprompt .head { margin-bottom: 4px; font: italic 400 12px Signika, sans-serif; color: #f4e8c0; text-shadow: 0 1px 3px rgba(0,0,0,.9); white-space: nowrap; }
#oni-dp-lockprompt .oni-dp-btn { width: 130px; height: 42px; font-size: 13px; }
#oni-dp-lockprompt .oni-dp-btn[disabled] { filter: grayscale(.8) brightness(.7); cursor: not-allowed; }`;
    document.head.appendChild(s);
  }
  let _hintT = null;
  function hint(text) {
    ensureStyle(); let el = document.getElementById("oni-dp-hint");
    if (!el) { el = document.createElement("div"); el.id = "oni-dp-hint"; document.body.appendChild(el); }
    el.textContent = text; requestAnimationFrame(() => el.classList.add("show"));
    clearTimeout(_hintT); _hintT = setTimeout(() => el.classList.remove("show"), 2600);
  }
  /** A two-button panel beside the party token, in the game's move-button style. Resolves to the picked value. */
  function prompt(token, head, buttons) {
    ensureStyle(); document.getElementById("oni-dp-lockprompt")?.remove();
    const el = document.createElement("div"); el.id = "oni-dp-lockprompt";
    el.innerHTML = (head ? `<div class="head"></div>` : "") + buttons.map((b, i) => `<button class="oni-dp-btn ${b.cls}" data-i="${i}" ${b.disabled ? "disabled" : ""}></button>`).join("");
    if (head) el.querySelector(".head").textContent = head;
    el.querySelectorAll("button").forEach((btn, i) => { btn.textContent = buttons[i].label; });
    document.body.appendChild(el);
    let raf = null; const place = () => { try { const t = token?.document, gs = canvas.grid.size;
      const p = canvas.clientCoordinatesFromCanvas({ x: t.x + t.width * gs, y: t.y + t.height * gs / 2 });
      el.style.left = `${Math.round(p.x + 14)}px`; el.style.top = `${Math.round(p.y - el.offsetHeight / 2)}px`; } catch {} raf = requestAnimationFrame(place); };
    place();
    return new Promise(res => el.querySelectorAll("button").forEach((btn, i) => btn.addEventListener("pointerdown", (ev) => {
      ev.stopPropagation(); if (buttons[i].disabled) return; cancelAnimationFrame(raf); el.remove(); res(buttons[i].value);
    })));
  }
  /** Lean toward the refused tile and back (visual only; the token document never moves). */
  async function bump(token, toNode) {
    const mesh = token?.mesh; if (!mesh || mesh.destroyed) return;
    const c = token.center, dx = toNode.center.x - c.x, dy = toNode.center.y - c.y, d = Math.hypot(dx, dy) || 1, reach = Math.min(20, d * 0.3);
    const x0 = mesh.x, y0 = mesh.y, t0 = performance.now();
    await new Promise(res => { const step = () => { const k = Math.min(1, (performance.now() - t0) / 420);
      const out = k < 0.35 ? k / 0.35 : 1 - (k - 0.35) / 0.65, shake = k > 0.3 && k < 0.5 ? Math.sin(k * 120) * 2 : 0;
      if (!mesh.destroyed) { mesh.x = x0 + dx / d * reach * out + shake; mesh.y = y0 + dy / d * reach * out; }
      if (k < 1) requestAnimationFrame(step); else { if (!mesh.destroyed) { mesh.x = x0; mesh.y = y0; } token.renderFlags?.set?.({ refreshPosition: true }); res(); } };
      requestAnimationFrame(step); });
  }

  async function waitForState(scene, test, timeoutMs) {
    if (test(L().state(scene))) return true;
    return new Promise(res => {
      const id = Hooks.on("updateScene", (s) => { if (s.id === scene.id && test(L().state(scene))) { Hooks.off("updateScene", id); clearTimeout(to); res(true); } });
      const to = setTimeout(() => { Hooks.off("updateScene", id); res(false); }, timeoutMs);
    });
  }

  /**
   * Click on a neighbour the party can't walk to yet.
   * @returns {Promise<boolean>} true when the way is now open (the caller retries the move)
   */
  async function onBlocked({ scene, token, from, to, info, isWalkable }) {
    const l = info.link, name = l.label || "";
    if (info.reason === "oneway") { hint(name ? `${name}: there's no way back up.` : "You can't go this way."); await bump(token, to); return false; }
    if (info.reason === "switch") { hint(l.lock?.lever ? "The gate won't budge. A lever somewhere must open it." : "Sealed. Something has to open this way first."); await bump(token, to); return false; }
    if (info.reason === "key") {
      const item = l.lock.item || "Key", has = await L().partyHas(item);
      const pick = await prompt(token, `${name || "Locked"} · ${has ? `use the ${item}?` : `needs the ${item}`}`,
        [{ label: "🗝  Use Key", cls: "oni-dp-btn-key", value: "use", disabled: !has }, { label: "⟲  Go Back", cls: "oni-dp-btn-revert", value: "back" }]);
      if (pick !== "use") return false;
      if (l.lock.consume) await consumeItem(item);
      L().request(scene, "unlock", { id: info.id });
      await waitForState(scene, st => !!st.unlocked?.[info.id], 8000);
      hint(`${name || "The gate"} swings open.`); await wait(900);
      return waitWalkable(isWalkable);
    }
    if (info.reason === "check") {
      const lk = l.lock, pick = await prompt(token, `${name || "Obstacle"} · ${lk.attrA} + ${lk.attrB} · DL ${lk.dl}`,
        [{ label: "🎲  Roll", cls: "oni-dp-btn-confirm", value: "roll" }, { label: "⟲  Go Back", cls: "oni-dp-btn-revert", value: "back" }]);
      if (pick !== "roll") return false;
      const t0 = Date.now();
      L().request(scene, "check", { id: info.id });
      await waitForState(scene, st => (st.lastCheck?.id === info.id && st.lastCheck.at >= t0 - 2000), 10 * 60 * 1000);
      const res = L().state(scene).lastCheck;
      if (!res?.pass) { hint(`${name || "The way"} won't give. Try again later.`); await bump(token, to); return false; }
      if (lk.stays === false) _passOnce.add(info.id);
      return waitWalkable(isWalkable);
    }
    return false;
  }
  async function waitWalkable(isWalkable) { for (let i = 0; i < 40; i++) { if (isWalkable()) return true; await wait(100); } return isWalkable(); }
  async function consumeItem(itemName) {
    for (const a of await L().partyActors()) { const it = a.items?.find?.(i => i.name === itemName); if (!it) continue;
      try { const q = Number(it.system?.props?.quantity ?? it.system?.quantity ?? 1);
        if (q > 1) await it.update({ "system.props.quantity": q - 1 }); else await it.delete(); } catch (e) { console.warn(TAG, "could not use up", itemName, e); }
      return; }
  }

  // ── Turn hooks (on the moving client) ──────────────────────────────────────
  Hooks.on(DP.HOOKS?.TURN_CONFIRMED ?? "dungeonPathing.turnConfirmed", async (p) => {
    try {
      const scene = canvas?.scene; if (!migrated(scene) || !p?.fromNode || !p?.toNode) return;
      _passOnce.clear();
      const hit = Core().linkBetween(L().read(scene), p.fromNode.nodeId, p.toNode.nodeId, L().state(scene)); if (!hit) return;
      const l = hit.link;
      if (l.hazard?.effectConfig && DP.TileEffectEngine?.run) {        // same effect setup as a Hazard tile, applied on crossing
        const fake = { id: `link-${hit.id}`, name: l.label || "Hazard", flags: { [MOD]: { [DP.PATHING_ROOT_KEY ?? "dungeonPathing"]: { effectConfig: l.hazard.effectConfig } } } };
        await DP.TileEffectEngine.run(DP.TileEffectEngine.readConfig(fake), fake, p.tokenDoc, scene);
      }
      if (l.collapse) { hint(`${l.label || "The bridge"} collapses behind you.`); L().request(scene, "break", { id: hit.id }); }
    } catch (e) { console.error(TAG, "turnConfirmed", e); }
  });
  Hooks.on(DP.HOOKS?.TURN_END ?? "dungeonPathing.turnEnd", (p) => {
    try {
      const scene = canvas?.scene, tileId = p?.node?.nodeId; if (!migrated(scene) || !tileId) return;
      for (const id of Core().toRevealOnLanding(L().read(scene), tileId, L().state(scene))) L().request(scene, "reveal", { id });
      if (L().events(scene).length) L().request(scene, "land", { tileId });
    } catch (e) { console.error(TAG, "turnEnd", e); }
  });

  DP.LinkPlay = { split, onBlocked, hint, prompt, bump };
})();
