// ============================================================================
// expAwarder-ui.js (Foundry V12 Module Script) — UPDATED (Multi-client)
// - Still plays UI locally via Hooks.on("oni:expAwarded")
// - ALSO broadcasts the same payload to other clients via Foundry socket
// - Prevents infinite loops with __fromSocket guard + runId dedupe
// ============================================================================

(() => {
  const TAG = "[ONI][EXPAwarder][UI]";
  const DBG = true;          // UI debug
  const NET_DBG = true;      // Socket debug (turn off later)

  function log(...args) { if (DBG) console.log(TAG, ...args); }
  function warn(...args) { console.warn(TAG, ...args); }
  function err(...args) { console.error(TAG, ...args); }

  const nlog = (...a) => (NET_DBG ? console.log(`${TAG}[NET]`, ...a) : null);
  const nwarn = (...a) => console.warn(`${TAG}[NET]`, ...a);
  const nerr = (...a) => console.error(`${TAG}[NET]`, ...a);

  // ----------------------------------------------------------------------------
  // Socket broadcaster config
  // ----------------------------------------------------------------------------
  const SOCKET_CHANNEL = "module.fabula-ultima-companion";
  const MSG_TYPE = "expAwarder:playUi";

  const DEDUPE_TTL_MS = 30_000;
  const seenBroadcast = new Map(); // runId -> timestamp

  function now() { return Date.now(); }
  function cleanupBroadcastSeen() {
    const t = now();
    for (const [k, ts] of seenBroadcast.entries()) {
      if (t - ts > DEDUPE_TTL_MS) seenBroadcast.delete(k);
    }
  }
  function markBroadcastSeen(runId) {
    cleanupBroadcastSeen();
    if (!runId) return;
    seenBroadcast.set(runId, now());
  }
  function hasBroadcastSeen(runId) {
    cleanupBroadcastSeen();
    if (!runId) return false;
    return seenBroadcast.has(runId);
  }

  function canUseSocket() {
    return !!game?.socket && typeof game.socket.emit === "function";
  }

  function broadcastToOthers(payload) {
    try {
      if (!canUseSocket()) {
        nwarn("Socket not available; cannot broadcast.");
        return;
      }

      if (!payload?.runId) {
        nwarn("No runId; skipping broadcast.");
        return;
      }

      // If this payload came from socket already, NEVER rebroadcast (prevents loops)
      if (payload.__fromSocket) {
        nlog("Skip broadcast (__fromSocket=true)", payload.runId);
        return;
      }

      // Dedupe broadcasts from the same client
      if (hasBroadcastSeen(payload.runId)) {
        nlog("Skip broadcast (already broadcast this runId)", payload.runId);
        return;
      }

      markBroadcastSeen(payload.runId);

      const msg = {
        type: MSG_TYPE,
        fromUser: game.user?.id ?? null,
        fromUserName: game.user?.name ?? "Unknown",
        sentAt: Date.now(),
        payload, // Send the whole payload (entries already a decoupled snapshot)
      };

      // Foundry V12: does NOT echo back to local client (good; we still play locally)
      game.socket.emit(SOCKET_CHANNEL, msg);

      nlog("Broadcast sent", {
        runId: payload.runId,
        entries: payload?.entries?.length ?? 0,
        channel: SOCKET_CHANNEL,
      });
    } catch (e) {
      nerr("Broadcast crashed", e);
    }
  }

  // ----------------------------------------------------------------------------
  // Queue system (hard rule: only 1 UI at a time)
  // ----------------------------------------------------------------------------
  const UI_STATE = {
    lock: false,
    queue: [],
  };

  Hooks.on("oni:expAwarded", (payload) => {
    try {
      const entries = Array.isArray(payload?.entries) ? payload.entries : [];
      if (!entries.length) return;

      // NEW: Broadcast to other clients
      broadcastToOthers(payload);

      for (const e of entries) UI_STATE.queue.push({ meta: payload, entry: e });

      log("Event received; queued entries=", entries.length, "queueSize=", UI_STATE.queue.length, {
        runId: payload?.runId,
        fromSocket: !!payload?.__fromSocket,
      });

      if (!UI_STATE.lock) drainQueue();
    } catch (e) {
      err("oni:expAwarded handler crashed", e);
    }
  });

  async function drainQueue() {
    UI_STATE.lock = true;
    try {
      while (UI_STATE.queue.length) {
        const { meta, entry } = UI_STATE.queue.shift();
        log("UI start", { actorName: entry?.actorName, actorUuid: entry?.actorUuid, runId: meta?.runId });
        await runOnce(entry, meta);
        log("UI end", { actorName: entry?.actorName, remaining: UI_STATE.queue.length });
        await sleep(GAP_MS);
      }
    } catch (e) {
      err("Queue drain crashed", e);
    } finally {
      UI_STATE.lock = false;
      removeRoot();
      log("Queue drain complete");
    }
  }

  // ----------------------------------------------------------------------------
  // TUNING KNOBS
  // ----------------------------------------------------------------------------
  const LOOP_ENABLED = false;

  const INTRO_MS = 260;   // fade+slide in
  const OUTRO_MS = 220;   // fade+slide out
  const HOLD_MS = 650;
  const BAR_ANIM_MS = 900;

  const GAP_MS = 250;     // between queued actors
  const SLIDE_PX = 18;    // how far it slides from left

  const PAD_X = 18;
  const PAD_Y = 18;

  // Floating LEVEL UP! text position tuning (relative to the EXP panel)
  // +Y moves it DOWN (less likely to go off-screen)
  const LEVELUP_OFFSET_X = 0;
  const LEVELUP_OFFSET_Y = 22;

  // ----------------------------------------------------------------------------
  // Utilities
  // ----------------------------------------------------------------------------
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  function clamp(n, a, b) { return Math.min(Math.max(n, a), b); }

  function removeRoot() {
    const old = document.querySelector(".oni-exp-root");
    if (old) old.remove();
  }

  function ensureStyles() {
    const id = "oni-exp-ui-style";
    const old = document.getElementById(id);
    if (old) old.remove();

    const css = `
      :root{
        --oni-exp-bg: rgba(8, 10, 14, 0.62);
        --oni-exp-border: rgba(255,255,255,0.18);
        --oni-exp-text: rgba(255,255,255,0.92);
        --oni-exp-sub: rgba(255,255,255,0.72);
        --oni-exp-accent: rgba(255, 210, 120, 0.95);
        --oni-exp-bar-bg: rgba(255,255,255,0.14);
        --oni-exp-shadow: 0 10px 30px rgba(0,0,0,0.35);
      }

      .oni-exp-root{
        position: fixed;
        inset: 0;
        z-index: 100000;
        pointer-events: none;
        font-family: "Signika","Segoe UI",sans-serif;
      }

      .oni-exp-ui{
        position: absolute;
        top: ${PAD_Y}px;
        left: ${PAD_X}px;
        right: auto;
        bottom: auto;
      }

      .oni-exp-card{
        width: 520px;
        max-width: calc(100vw - ${PAD_X * 2}px);
        padding: 18px 18px 16px;
        border-radius: 16px;
        background: var(--oni-exp-bg);
        border: 1px solid var(--oni-exp-border);
        box-shadow: var(--oni-exp-shadow);
        backdrop-filter: blur(10px);

        transform: translateX(-${SLIDE_PX}px);
        opacity: 0;

        transition:
          transform ${INTRO_MS}ms ease,
          opacity ${INTRO_MS}ms ease;

        /* IMPORTANT: allow floating elements above the card */
        overflow: visible;
      }

      .oni-exp-card.is-in{
        transform: translateX(0);
        opacity: 1;
      }

      .oni-exp-header{
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 10px;
      }
      .oni-exp-name{
        color: var(--oni-exp-text);
        font-size: 20px;
        font-weight: 700;
        letter-spacing: 0.2px;
      }
      .oni-exp-lv{
        color: var(--oni-exp-sub);
        font-size: 14px;
      }
      .oni-exp-lv strong{
        color: var(--oni-exp-text);
        font-size: 16px;
      }

      .oni-exp-row{
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 10px;
      }
      .oni-exp-label{
        color: var(--oni-exp-sub);
        font-size: 13px;
        letter-spacing: 0.5px;
      }
      .oni-exp-pct{
        color: var(--oni-exp-text);
        font-size: 14px;
        font-weight: 700;
      }

      .oni-exp-bar{
        position: relative;
        height: 12px;
        border-radius: 999px;
        background: var(--oni-exp-bar-bg);
        overflow: hidden;
      }
      .oni-exp-fill{
        position: absolute;
        inset: 0 auto 0 0;
        width: 0%;
        background: linear-gradient(90deg, rgba(255,214,130,0.95), rgba(255,170,80,0.95));
      }

      .oni-exp-levelup-float{
        position: absolute;
        left: ${12 + LEVELUP_OFFSET_X}px;
        top: ${-32 + LEVELUP_OFFSET_Y}px;
        font-weight: 1000;
        font-size: 18px;
        letter-spacing: 1px;
        color: rgba(255,255,255,0.96);
        text-shadow:
          -1px  0px 0 rgba(0,0,0,0.85),
           1px  0px 0 rgba(0,0,0,0.85),
           0px -1px 0 rgba(0,0,0,0.85),
           0px  1px 0 rgba(0,0,0,0.85),
           0 2px 0 rgba(0,0,0,0.35);
        opacity: 0;
        transform: translateY(-8px) scale(1.2);
        pointer-events:none;
        z-index: 3;
      }
      .oni-exp-levelup-float.is-show{
        animation: oniExpLevelUp 1400ms ease-in-out forwards;
      }

      @keyframes oniExpLevelUp{
        0%{ opacity: 0; transform: translateY(-10px) scale(1.18); }
        18%{ opacity: 1; transform: translateY(0px) scale(1.22); }
        80%{ opacity: 1; transform: translateY(0px) scale(1.22); }
        100%{ opacity: 0; transform: translateY(-8px) scale(1.18); }
      }
    `;

    const style = document.createElement("style");
    style.id = id;
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ----------------------------------------------------------------------------
  // Decoupled data shaping
  // ----------------------------------------------------------------------------
  function shapeData(entry) {
    let levelBefore = entry?.levelBefore;
    let levelAfter = entry?.levelAfter;

    // Prefer API-provided percent snapshot (now correct)
    let expPctFrom = entry?.expPctFrom;
    let expPctTo = entry?.expPctTo;

    // Fallback only if API didn't provide
    if (expPctFrom == null || expPctTo == null) {
      const expBeforeRaw = Number(entry?.expBefore ?? 0);
      const expAfterRaw = Number(entry?.expAfter ?? expBeforeRaw);

      // Old fallback model (kept for safety)
      const FALLBACK_STEP = 100;

      if (levelBefore == null) levelBefore = Math.floor(expBeforeRaw / FALLBACK_STEP) + 1;
      if (levelAfter == null) levelAfter = Math.floor(expAfterRaw / FALLBACK_STEP) + 1;

      if (expPctFrom == null) expPctFrom = (expBeforeRaw % FALLBACK_STEP) / FALLBACK_STEP * 100;
      if (expPctTo == null) expPctTo = (expAfterRaw % FALLBACK_STEP) / FALLBACK_STEP * 100;
    }

    return {
      actorName: entry?.actorName ?? "Unknown",
      levelBefore: levelBefore ?? 1,
      levelAfter: levelAfter ?? (levelBefore ?? 1),
      expPctFrom: Number(expPctFrom ?? 0),
      expPctTo: Number(expPctTo ?? 0),
    };
  }

  // ----------------------------------------------------------------------------
  // UI build + animation
  // ----------------------------------------------------------------------------
  function buildUI(data) {
    removeRoot();

    const root = document.createElement("div");
    root.className = "oni-exp-root";

    const ui = document.createElement("div");
    ui.className = "oni-exp-ui";
    root.appendChild(ui);

    const card = document.createElement("div");
    card.className = "oni-exp-card";
    ui.appendChild(card);

    const levelUp = document.createElement("div");
    levelUp.className = "oni-exp-levelup-float";
    levelUp.textContent = "LEVEL UP!";
    ui.appendChild(levelUp);

    const header = document.createElement("div");
    header.className = "oni-exp-header";
    card.appendChild(header);

    const name = document.createElement("div");
    name.className = "oni-exp-name";
    name.textContent = String(data.actorName || "Unknown");
    header.appendChild(name);

    const lv = document.createElement("div");
    lv.className = "oni-exp-lv";
    lv.innerHTML = `Lv <strong class="oni-exp-lv-num">${Number(data.levelBefore || 1)}</strong>`;
    header.appendChild(lv);

    const row = document.createElement("div");
    row.className = "oni-exp-row";
    card.appendChild(row);

    const label = document.createElement("div");
    label.className = "oni-exp-label";
    label.textContent = "EXP";
    row.appendChild(label);

    const pct = document.createElement("div");
    pct.className = "oni-exp-pct";
    pct.textContent = `${Number(data.expPctFrom || 0).toFixed(1)}%`;
    row.appendChild(pct);

    const bar = document.createElement("div");
    bar.className = "oni-exp-bar";
    card.appendChild(bar);

    const fill = document.createElement("div");
    fill.className = "oni-exp-fill";
    bar.appendChild(fill);

    document.body.appendChild(root);

    return {
      root,
      ui,
      card,
      lvNum: lv.querySelector(".oni-exp-lv-num"),
      pct,
      fill,
      levelUp,
    };
  }

  function setBar(ui, pct) {
    const p = clamp(Number(pct), 0, 100);
    ui.fill.style.width = `${p.toFixed(2)}%`;
    ui.pct.textContent = `${p.toFixed(1)}%`;
  }

  function flashLevelUp(ui) {
    ui.levelUp.classList.remove("is-show");
    void ui.levelUp.offsetWidth;
    ui.levelUp.classList.add("is-show");
  }

  async function animateBar(ui, fromPct, toPct, durationMs) {
    const a = clamp(Number(fromPct), 0, 100);
    const b = clamp(Number(toPct), 0, 100);

    if (durationMs <= 0) {
      setBar(ui, b);
      return;
    }

    const start = performance.now();
    return new Promise((resolve) => {
      function frame(now) {
        const t = clamp((now - start) / durationMs, 0, 1);
        const v = a + (b - a) * t;
        setBar(ui, v);
        if (t >= 1) resolve();
        else requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
    });
  }

  async function teardown(ui) {
    ui.card.classList.remove("is-in");
    ui.card.style.transition = `transform ${OUTRO_MS}ms ease, opacity ${OUTRO_MS}ms ease`;
    ui.card.style.transform = `translateX(-${SLIDE_PX}px)`;
    ui.card.style.opacity = "0";

    await sleep(OUTRO_MS + 10);
    removeRoot();
  }

  async function runOnce(entry, meta) {
    ensureStyles();

    const data = shapeData(entry);
    const ui = buildUI(data);

    const lvBefore = Math.floor(Number(data.levelBefore || 1));
    const lvAfter = Math.floor(Number(data.levelAfter || lvBefore));
    const gainedRaw = Number(entry?.levelsGained);
    const levelsGained = Number.isFinite(gainedRaw) ? Math.max(0, Math.floor(gainedRaw)) : Math.max(0, lvAfter - lvBefore);

    ui.lvNum.textContent = String(lvBefore);
    setBar(ui, data.expPctFrom);

    await sleep(0);
    ui.card.classList.add("is-in");

    const durScaled = (from, to, base) => {
      const dist = Math.abs(clamp(Number(to), 0, 100) - clamp(Number(from), 0, 100));
      const ms = base * (dist / 100);
      return Math.max(120, Math.floor(ms));
    };

    if (levelsGained <= 0) {
      await animateBar(ui, data.expPctFrom, data.expPctTo, BAR_ANIM_MS);
    } else {
      const d1 = durScaled(data.expPctFrom, 100, BAR_ANIM_MS);
      await animateBar(ui, data.expPctFrom, 100, d1);
      await sleep(90);

      let shownLv = lvBefore;

      for (let i = 0; i < levelsGained; i++) {
        shownLv += 1;
        ui.lvNum.textContent = String(shownLv);
        flashLevelUp(ui);

        setBar(ui, 0);
        await sleep(80);

        if (i < levelsGained - 1) {
          await animateBar(ui, 0, 100, BAR_ANIM_MS);
          await sleep(90);
        }
      }

      const dLast = durScaled(0, data.expPctTo, BAR_ANIM_MS);
      await animateBar(ui, 0, data.expPctTo, dLast);
    }

    await sleep(HOLD_MS);
    await teardown(ui);
  }

  Hooks.once("ready", () => {
    log("UI script ready. Listening for oni:expAwarded + broadcasting to other clients.", {
      socketChannel: SOCKET_CHANNEL,
      user: { id: game.user?.id, name: game.user?.name, gm: !!game.user?.isGM },
    });
  });
})();
