// ============================================================================
// Dungeon Pathing — Random Battle Resolver (GM-side)
// ----------------------------------------------------------------------------
// Turns a Random Battle tile landing into an actual battle, end to end:
//
//   roll encounter chance → roll engagement → pick the group (novelty-biased)
//   → GM override window → build a Battle Director payload → launch
//
// Everything here runs on ONE GM client. The tile handler
// (tile-events/tile-event-random-battle.js) is a thin request that routes into
// `run()` via DP.Socket, because:
//   - the rolls decide real combat and must be authoritative, not per-client
//     (they used to be plain Math.random() on whichever client walked the turn);
//   - FUCompanion.api.experimental.battleDirector.start() is GM-only.
//
// socketlib's executeAsGM auto-routes to a single GM, and the GM-direct path in
// DP.Socket runs locally — so exactly one client resolves, either way. No
// primary-GM gate is needed here (unlike the raw game.socket channel, which
// broadcasts to every GM).
//
// See docs/dungeon-random-encounter-design.md.
// ============================================================================
(() => {
  const DP  = globalThis.DungeonPathing ??= {};
  const TAG = "[DungeonPathing][RandomBattle]";
  const MOD = DP.MODULE_ID ?? "fabula-ultima-companion";

  // GM-only sticky toggle: when ON, the next random battle skips the auto-launch
  // and hands the GM the standard Battle Prompt instead. Cleared once it fires.
  const CURATE_SETTING = "dpCurateNextEncounter";

  const BATTLE_INIT_MACRO = "BattleInit — BattleInit Manager";

  const SFX = {
    ambush:    "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/Down2.ogg",
    advantage: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/Up4.ogg",
    normal:    "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/Monster1.ogg",
  };

  // How long the GM gets to intercept, in ms. Deliberately short: it runs while
  // the encounter SFX plays, so it costs the player no visible pause.
  const OVERRIDE_WINDOW_MS = 2500;

  const log  = (...a) => console.debug(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);

  // ── Settings ───────────────────────────────────────────────────────────────
  Hooks.once("init", () => {
    try {
      game.settings.register(MOD, CURATE_SETTING, {
        scope: "world", config: false, default: false, type: Boolean,
      });
    } catch (e) { warn("settings.register failed", e); }
  });

  function getCurate() {
    try { return !!game.settings.get(MOD, CURATE_SETTING); } catch { return false; }
  }
  async function setCurate(on) {
    try { await game.settings.set(MOD, CURATE_SETTING, !!on); } catch (e) { warn("settings.set failed", e); }
  }

  // ── Weighted pick (borrowed from ActionReader) ─────────────────────────────
  // AR is an ES module and this file is a classic script, so it is pulled in
  // once via dynamic import and cached. If the import ever fails we fall back to
  // an equivalent local sweep rather than losing the bias silently.
  let _arPromise = null;
  function getAR() {
    if (!_arPromise) {
      _arPromise = import(`/modules/${MOD}/scripts/action-reader/actionReader-core.js`)
        .then(m => m.ActionReaderCore)
        .catch(e => { warn("ActionReaderCore import failed — using local weighted pick", e); return null; });
    }
    return _arPromise;
  }

  function localWeightedPick(entries, weightGetter) {
    const prepared = (entries ?? [])
      .map(entry => ({ entry, weight: Math.max(0, Number(weightGetter(entry)) || 0) }))
      .filter(x => x.weight > 0);
    if (!prepared.length) return null;
    let roll = Math.random() * prepared.reduce((s, x) => s + x.weight, 0);
    for (const part of prepared) { roll -= part.weight; if (roll < 0) return part.entry; }
    return prepared.at(-1)?.entry ?? null;
  }

  async function weightedPick(entries, weightGetter) {
    const AR = await getAR();
    return AR?.weightedPick
      ? AR.weightedPick(entries, weightGetter)
      : localWeightedPick(entries, weightGetter);
  }

  // ── Current Game DB (encounter rates live on its props) ────────────────────
  // Lifted from the old tile handler. A same-named canvas token overrides the
  // world actor so a per-session token copy can carry its own rates.
  async function resolveDb() {
    const CURRENT_GAME_UUID = "Actor.DMpK5Bi119jIrCFZ";

    const api = window.FUCompanion?.api;
    if (api?.getCurrentGameDb) {
      try {
        const res = await api.getCurrentGameDb();
        if (res?.db) return { dbSource: res.db, dbWriteTarget: res.db };
      } catch { /* fall through to the legacy lookup */ }
    }

    const cg = await fromUuid(CURRENT_GAME_UUID).catch(() => null);
    if (!cg) {
      ui.notifications?.error?.("Random Battle | 'Current Game' sheet not found.");
      return {};
    }
    const raw = foundry.utils.getProperty(cg, "system.props.game_id")?.trim();
    if (!raw) {
      ui.notifications?.error?.("Random Battle | Set the Current Game Database ID on the 'Current Game' sheet.");
      return {};
    }

    let dbActor = null;
    if (/^\s*Actor\./i.test(raw)) {
      dbActor = await fromUuid(raw).catch(() => null);
    } else {
      dbActor = game.actors?.get(raw) ?? await fromUuid(`Actor.${raw}`).catch(() => null);
    }
    if (!dbActor) {
      ui.notifications?.error?.(`Random Battle | Database actor not found: ${raw}`);
      return {};
    }

    const dbToken  = canvas.tokens?.placeables.find(t => t.name === dbActor.name);
    const dbSource = dbToken?.actor ?? dbActor;
    return { dbSource, dbWriteTarget: dbSource };
  }

  const toPct = (v, dflt = 0) => {
    const n = parseFloat(v);
    if (isNaN(n)) return dflt;
    return n > 1 ? Math.min(n, 100) : n * 100;
  };

  async function readRates() {
    const { dbSource, dbWriteTarget } = await resolveDb();
    if (!dbSource) return null;
    const props = dbSource.system?.props ?? {};
    return {
      writeTarget: dbWriteTarget,
      encounter: toPct(props.random_battle_percentage, 0),
      ambush:    toPct(props.ambush_percentage, 0),
      advantage: toPct(props.advantage_percentage, 0),
      normal:    toPct(props.normal_percentage, 100),
      minimum:   toPct(props.minimum_encounter_percentage, 5),
    };
  }

  // ── Pity scaling ───────────────────────────────────────────────────────────
  // Miss → the rate climbs 20–30 points. Hit → it halves, floored at the
  // configured minimum. Kept exactly as the tile handler had it.
  function nextRate(rates, appear) {
    return appear
      ? Math.max(rates.minimum, Math.round(rates.encounter * 0.5))
      : Math.min(100, rates.encounter + 20 + Math.random() * 10);
  }

  /**
   * Write the new encounter rate back to the DB actor.
   *
   * `defer` exists for the MISS path: the player's dungeon turn is still in
   * flight on their client, and a document update mid-turn contends with the
   * turn's own socket traffic. We wait for the graph rebuild that ends the turn,
   * with a 30s fallback in case the party leaves the dungeon and it never fires.
   * On the HIT path there is nothing to defer past — the scene is about to be
   * torn down — so the write is awaited immediately.
   */
  function applyRateUpdate(rates, appear, { defer } = { defer: true }) {
    const target = rates.writeTarget;
    const newPct = nextRate(rates, appear);
    if (!target || Math.round(newPct) === Math.round(rates.encounter)) return Promise.resolve();

    const patch = { "system.props.random_battle_percentage": String(Math.round(newPct)) };
    log(appear ? "Encounter!" : "No encounter", `${rates.encounter}% → ${Math.round(newPct)}%`);

    const write = () => target.update(patch, { render: false })
      .catch(e => warn("encounter % update failed:", e));

    if (!defer) return write();

    let done = false;
    const apply = () => {
      if (done) return;
      if (globalThis.__ONI_DUNGEON_PATHING__?.state?.busy) {
        Hooks.once(DP.HOOKS.GRAPH_REBUILT, () => setTimeout(apply, 0));
        return;
      }
      done = true;
      write();
    };
    Hooks.once(DP.HOOKS.GRAPH_REBUILT, () => setTimeout(apply, 0));
    setTimeout(() => { if (!done) apply(); }, 30_000);
    return Promise.resolve();
  }

  // ── Encounter selection ────────────────────────────────────────────────────

  async function resolveTable(ref) {
    const s = String(ref ?? "").trim();
    if (!s) return null;
    const direct = game.tables?.get?.(s);
    if (direct) return direct;
    const doc = await fromUuid(s).catch(() => null);
    return doc?.documentName === "RollTable" ? doc : null;
  }

  function readDungeonCfg(scene) {
    try { return window.oni?.FabulaConfig?.readDungeon?.(scene) ?? {}; }
    catch (e) { warn("readDungeon failed", e); return {}; }
  }

  function rowText(result) {
    return String(result?.text ?? result?.name ?? "").trim();
  }

  /** Authored odds: a row spanning 3 numbers stays 3× as likely as a 1-wide row. */
  function baseWeight(result) {
    const a = Number(result?.range?.[0]);
    const b = Number(result?.range?.[1]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return 1;
    return Math.max(1, b - a + 1);
  }

  /**
   * Highest number the table's formula can roll, or null if it cannot be read.
   *
   * Asks Foundry rather than guessing, so this stays in parity with what
   * `table.roll()` would actually accept — any formula Roll understands works,
   * not just the house `1dN`. The regex is a fallback for environments without
   * Roll (the offline harness in tools/), and covers the house style exactly.
   */
  function formulaMax(table) {
    const f = String(table?.formula ?? "").trim();
    if (!f) return null;
    try {
      const r = new Roll(f);
      if (typeof r.evaluateSync === "function") {
        const total = Number(r.evaluateSync({ maximize: true })?.total);
        if (Number.isFinite(total)) return total;
      }
    } catch { /* fall through to the regex */ }
    const m = /^(\d*)\s*d\s*(\d+)$/i.exec(f);
    return m ? Number(m[1] || 1) * Number(m[2]) : null;
  }

  /**
   * Rows the table's own formula can actually reach.
   *
   * ⚠ LOAD-BEARING. Reading `table.results` directly is what lets us weight the
   * draw, but it also bypasses the die — and a row parked ABOVE the die maximum
   * is the house idiom for "list this monster in the bestiary but never roll
   * it". `Ancient Temple - Enemies` is `1d8` with ⭐️ Geist at row 9 for exactly
   * that reason. Without this filter a random encounter could spawn a boss.
   *
   * A formula neither Roll nor the regex can read means Foundry could not roll
   * this table either, so it is treated as unusable rather than as "no ceiling".
   * The caller then falls back to the Enemies table, and failing that to a
   * graceful miss — never to an unbounded draw.
   */
  function rollableRows(table) {
    const rows = [...(table?.results ?? [])].filter(r => rowText(r));
    if (!rows.length) return rows;

    const max = formulaMax(table);
    if (max === null) {
      warn(`table "${table?.name}" has an unreadable formula (${JSON.stringify(table?.formula)}) — skipping it; Foundry could not roll it either`);
      return [];
    }

    const keep = rows.filter(r => Number(r?.range?.[0]) <= max);
    const dropped = rows.length - keep.length;
    if (dropped) log(`table "${table?.name}": ${dropped} row(s) above the ${max} maximum excluded (deliberately unrollable)`);
    return keep;
  }

  /**
   * "Has the party ever fought this monster?"
   *
   * The Monster Encyclopedia creates a placeholder page the moment a monster is
   * first spawned into a battle (ensurePlaceholderPagesForTokens, called from
   * the Director's init). So "no page" is exactly "never encountered" — there is
   * no separate seen-list to maintain.
   *
   * Fails CLOSED (treats everything as seen) if the encyclopedia is unavailable,
   * so a missing API degrades to an unbiased draw rather than an all-novel one.
   */
  function isUnseen(actor) {
    const enc = globalThis.FUCompanion?.api?.encyclopedia;
    if (!enc?.getPageForActor || !actor?.uuid) return false;
    try { return !enc.getPageForActor(actor.uuid); }
    catch (e) { warn("getPageForActor threw", e); return false; }
  }

  function readNoveltyBias(scene) {
    const raw = readDungeonCfg(scene)?.encounterNoveltyBias;
    if (raw === undefined || raw === null || String(raw).trim() === "") return 1;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 1;
  }

  /** Resolve one Encounter-row slot name to an Actor, honouring the `Random` keyword. */
  async function resolveSlot(slot, enemiesTable) {
    if (String(slot).trim().toLowerCase() === "random") {
      if (!enemiesTable) { warn(`slot "Random" but the dungeon has no Enemies table`); return null; }
      const draw = await enemiesTable.draw({ displayChat: false }).catch(() => null);
      const sub  = rowText(draw?.results?.[0]);
      const a    = sub ? game.actors?.getName?.(sub) : null;
      if (!a) warn(`"Random" slot drew "${sub}" — no such actor`);
      return a ?? null;
    }
    const a = game.actors?.getName?.(slot);
    // Encounter rows are plain text with no referential integrity — a renamed or
    // deleted monster breaks them silently, so say so loudly here.
    if (!a) warn(`encounter slot "${slot}" — no such actor (renamed or deleted?)`);
    return a ?? null;
  }

  /**
   * Pick an encounter group, biased toward monsters the party has not met.
   *
   * We read the table's rows directly rather than calling table.roll(), so our
   * novelty weight can be layered ON TOP of the author's own range widths
   * instead of replacing them. Once every monster has been seen, every
   * multiplier collapses to 1 and this is exactly the authored table.
   *
   * @returns {Promise<Array<{actorUuid, name, quantity}>>}
   */
  async function pickEncounter(scene) {
    const cfg          = readDungeonCfg(scene);
    const bias         = readNoveltyBias(scene);
    const encTable     = await resolveTable(cfg.encounterTable);
    const enemiesTable = await resolveTable(cfg.enemiesTable);

    const encRows = rollableRows(encTable);
    if (encRows.length) {
      // Pre-resolve every row once so novelty can be counted per row.
      const scored = [];
      for (const r of encRows) {
        const slots  = rowText(r).split(",").map(s => s.trim()).filter(Boolean);
        const actors = [];
        for (const s of slots) {
          // `Random` slots are resolved at spawn time, not here — a row is not
          // more novel just because it contains a wildcard.
          if (String(s).toLowerCase() === "random") continue;
          const a = game.actors?.getName?.(s);
          if (a) actors.push(a);
        }
        const unseen = new Set(actors.filter(isUnseen).map(a => a.id)).size;
        scored.push({ result: r, slots, weight: baseWeight(r) * (1 + bias * unseen), unseen });
      }

      const chosen = await weightedPick(scored, e => e.weight);
      if (chosen) {
        log(`encounter row "${rowText(chosen.result)}" (weight ${chosen.weight.toFixed(2)}, ${chosen.unseen} unseen, bias ${bias})`);
        const picks = [];
        for (const slot of chosen.slots) {
          const actor = await resolveSlot(slot, enemiesTable);
          if (actor) picks.push({ actorUuid: actor.uuid, name: actor.name, quantity: 1, isNew: isUnseen(actor) });
        }
        if (picks.length) return picks;
        warn("chosen encounter row resolved to zero actors — falling back to the Enemies table");
      }
    }

    // Fallback: no Encounter table, no rows, or every row unresolvable.
    // Mirrors the Director's own "random" branch — 3-5 draws from the bestiary.
    const eneRows = rollableRows(enemiesTable);
    if (!eneRows.length) return [];

    const scoredEnemies = eneRows.map(r => {
      const actor = game.actors?.getName?.(rowText(r));
      return { result: r, actor, weight: baseWeight(r) * (1 + bias * (actor && isUnseen(actor) ? 1 : 0)) };
    }).filter(e => e.actor);

    const count = 3 + Math.floor(Math.random() * 3);
    const picks = [];
    for (let i = 0; i < count; i++) {
      const e = await weightedPick(scoredEnemies, x => x.weight);
      if (e?.actor) picks.push({ actorUuid: e.actor.uuid, name: e.actor.name, quantity: 1, isNew: isUnseen(e.actor) });
    }
    if (picks.length) log(`fallback draw from the Enemies table: ${picks.map(p => p.name).join(", ")}`);
    return picks;
  }

  // ── Party ──────────────────────────────────────────────────────────────────
  // CampSystem.Party.resolve() is the shared reader for the game DB's
  // member_id_1..4. `slot` is only ever used to ORDER the spawn line
  // (director-init resolveParty sorts by it and nothing else reads the value),
  // so the roster's own order is all we need to preserve. Guests are merged in
  // downstream by resolveParty — do NOT add them here or they arrive twice.
  async function resolvePartyMembers() {
    const entries = await globalThis.CampSystem?.Party?.resolve?.() ?? [];
    return entries.map((e, i) => ({
      actorUuid: e.actor?.uuid,
      actorId:   e.actorId,
      name:      e.actor?.name,
      slot:      i + 1,
      img:       e.actor?.img ?? null,
    })).filter(m => m.actorUuid);
  }

  // ── Presentation ───────────────────────────────────────────────────────────

  function playEncounterSfx(engagement) {
    const src = SFX[engagement] ?? SFX.normal;
    try {
      // Sequencer broadcasts by default; AudioHelper needs to be told to.
      if (game.modules.get("sequencer")?.active) new Sequence().sound(src).play();
      else AudioHelper.play({ src, volume: 0.8, autoplay: true, loop: false }, true);
    } catch (e) { warn("SFX failed", e); }
  }

  function postMissCard() {
    const style = "font-size:1.4rem;font-style:italic;text-align:center;padding:6px;";
    ChatMessage.create({
      speaker: { alias: "System" },
      content: `<div style="${style}">Nothing appears…</div>`,
    }).catch(e => warn("ChatMessage.create failed:", e));
  }

  const TOAST_ID    = "oni-dp-encounter-toast";
  const TOAST_STYLE = "oni-dp-encounter-toast-styles";

  function injectToastStyles() {
    if (document.getElementById(TOAST_STYLE)) return;
    const s = document.createElement("style");
    s.id = TOAST_STYLE;
    s.textContent = `
#${TOAST_ID} {
  position: fixed; z-index: 100000; top: 72px; right: 24px; width: 340px;
  padding: 14px 16px 12px; border-radius: 10px;
  border: 2px solid rgba(200,160,80,0.65);
  background: radial-gradient(circle at 40% 0%, rgba(60,44,20,0.97) 0%, rgba(28,20,9,0.98) 100%);
  box-shadow: 0 0 18px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.10);
  color: #f0dfb0; font-family: var(--font-primary, sans-serif);
  opacity: 0; transform: translateY(-8px);
  transition: opacity 160ms ease, transform 160ms ease;
}
#${TOAST_ID}.visible { opacity: 1; transform: translateY(0); }
#${TOAST_ID} .dp-enc-kind {
  font-size: 0.72rem; letter-spacing: 0.12em; text-transform: uppercase;
  color: #e8c870; margin-bottom: 4px;
}
#${TOAST_ID} .dp-enc-group { font-size: 1.02rem; font-weight: 600; line-height: 1.3; color: #fff6df; }
#${TOAST_ID} .dp-enc-new { color: #8fe08f; font-size: 0.78rem; margin-top: 4px; }
#${TOAST_ID} .dp-enc-actions { display: flex; gap: 8px; margin-top: 10px; }
#${TOAST_ID} button {
  flex: 1; padding: 5px 8px; font-size: 0.82rem; cursor: pointer;
  border-radius: 6px; border: 1px solid rgba(200,160,80,0.5);
  background: rgba(0,0,0,0.35); color: #f0dfb0; line-height: 1.2;
}
#${TOAST_ID} button:hover { background: rgba(200,160,80,0.22); }
#${TOAST_ID} .dp-enc-bar { height: 3px; margin-top: 10px; background: rgba(255,255,255,0.12); border-radius: 2px; overflow: hidden; }
#${TOAST_ID} .dp-enc-bar > i { display: block; height: 100%; width: 100%; background: #e8c870; transform-origin: left center; }
    `;
    document.head.appendChild(s);
  }

  /**
   * GM-only interception window. Resolves "auto" | "customize" | "now".
   *
   * Runs concurrently with the encounter SFX, so the pause it adds is hidden
   * behind a beat the players are already watching.
   */
  function showOverrideToast(picks, engagement, ms) {
    injectToastStyles();
    document.getElementById(TOAST_ID)?.remove();

    const kind = engagement === "ambush" ? "Enemy Ambush"
               : engagement === "advantage" ? "Player Advantage"
               : "Random Battle";
    const group  = picks.map(p => p.name).join(", ");
    // `isNew` was captured when the group was resolved — do not re-derive it
    // here, the encyclopedia may already have been written to by then.
    const unseen = [...new Map(picks.filter(p => p.isNew).map(p => [p.name, p])).values()];

    const el = document.createElement("div");
    el.id = TOAST_ID;
    // Only fixed markup goes through innerHTML. Every monster name is authored
    // data and is written with textContent below — never interpolated here.
    el.innerHTML = `
      <div class="dp-enc-kind"></div>
      <div class="dp-enc-group"></div>
      ${unseen.length ? `<div class="dp-enc-new"></div>` : ""}
      <div class="dp-enc-actions">
        <button data-act="now">Fight now</button>
        <button data-act="customize">Customize…</button>
      </div>
      <div class="dp-enc-bar"><i></i></div>`;
    el.querySelector(".dp-enc-kind").textContent  = kind;
    el.querySelector(".dp-enc-group").textContent = group;
    if (unseen.length) {
      el.querySelector(".dp-enc-new").textContent = `✦ first encounter: ${unseen.map(u => u.name).join(", ")}`;
    }
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add("visible"));

    const bar = el.querySelector(".dp-enc-bar > i");
    if (bar) {
      bar.animate([{ transform: "scaleX(1)" }, { transform: "scaleX(0)" }],
                  { duration: ms, easing: "linear", fill: "forwards" });
    }

    return new Promise(resolve => {
      let settled = false;
      const finish = (verdict) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        el.classList.remove("visible");
        setTimeout(() => el.remove(), 200);
        resolve(verdict);
      };
      el.querySelectorAll("button").forEach(b => {
        b.addEventListener("click", () => finish(b.dataset.act));
      });
      const timer = setTimeout(() => finish("auto"), ms);
    });
  }

  function openBattlePrompt() {
    const m = game.macros?.getName?.(BATTLE_INIT_MACRO);
    if (!m) {
      ui.notifications?.error?.(`Random Battle | Macro not found: "${BATTLE_INIT_MACRO}"`);
      return;
    }
    m.execute().catch(e => warn("BattleInit Manager threw", e));
  }

  // ── Launch ─────────────────────────────────────────────────────────────────

  function buildPayload({ scene, picks, engagement, cfg, tileId }) {
    return {
      context: {
        battleSceneUuid: cfg.battleMap,
        sourceSceneId:   scene.id,
        sourceSceneUuid: scene.uuid,
        return:          { enabled: true },
      },
      // We already resolved the group ourselves (novelty-biased), so hand the
      // Director the deterministic manual branch rather than letting it re-roll.
      encounterPlan: { mode: "manual", manualPicks: picks },
      party:         { members: [] },   // filled by the caller
      battlePlan:    { type: "default", isBoss: false, initiativeMode: "rolled", engagement },
      battleConfig:  { bgm: String(cfg.battleBGM ?? ""), battleSceneUuid: cfg.battleMap },
      options:       { battleSystem: "director" },
      meta:          { source: "dungeon-random-battle", sceneId: scene.id, tileId },
    };
  }

  // ── Entry point ────────────────────────────────────────────────────────────

  /**
   * Resolve a Random Battle tile landing. GM-only; called from DP.Socket.
   * Never throws — a tile handler is inside the player's turn loop, and an
   * exception there would strand the turn.
   *
   * @returns {Promise<{ok:boolean, appear?:boolean, launched?:boolean, error?:string}>}
   */
  async function run({ sceneId, tileId } = {}) {
    if (!game.user?.isGM) return { ok: false, error: "Not GM" };

    const scene = game.scenes?.get?.(sceneId);
    if (!scene) return { ok: false, error: "Scene not found" };

    const rates = await readRates();
    if (!rates) return { ok: false, error: "Current Game DB not resolved" };

    // 1. Does anything happen at all?
    const d100 = Math.floor(Math.random() * 100) + 1;
    if (d100 > rates.encounter) {
      postMissCard();
      applyRateUpdate(rates, false);
      return { ok: true, appear: false, launched: false };
    }

    // 2. Resolve the group BEFORE committing to the encounter, so a misconfigured
    //    dungeon degrades into a clean "nothing happened" instead of a dead turn.
    const cfg   = readDungeonCfg(scene);
    const picks = await pickEncounter(scene);

    if (!picks.length || !cfg.battleMap) {
      const why = !picks.length
        ? `no encounter could be resolved on "${scene.name}" — check its Encounter/Enemies tables`
        : `no Battle Map is configured on "${scene.name}"`;
      warn("degrading to a miss:", why);
      ui.notifications?.warn?.(`Random Battle | ${why}`);   // GM-only: this runs on the GM
      postMissCard();
      applyRateUpdate(rates, false);
      return { ok: true, appear: false, launched: false, error: why };
    }

    // 3. Engagement — the same flat percentages the tile has always rolled,
    //    now actually carried through to the Director instead of discarded.
    const pool = rates.ambush + rates.advantage + rates.normal || 1;
    const roll = Math.random() * pool;
    const engagement = roll < rates.ambush ? "ambush"
                     : roll < rates.ambush + rates.advantage ? "advantage"
                     : "normal";

    log(`encounter: ${picks.map(p => p.name).join(", ")} | engagement=${engagement}`);

    // 4. SFX now — it covers the override window that follows.
    playEncounterSfx(engagement);

    // 5. GM interception.
    let verdict = "auto";
    if (getCurate()) {
      verdict = "customize";
      await setCurate(false);      // one-shot: consumed by this encounter
    } else if (OVERRIDE_WINDOW_MS > 0) {
      verdict = await showOverrideToast(picks, engagement, OVERRIDE_WINDOW_MS);
    }

    // The rate drop is owed either way — the encounter happened.
    await applyRateUpdate(rates, true, { defer: false });

    if (verdict === "customize") {
      openBattlePrompt();
      return { ok: true, appear: true, launched: false };
    }

    // 6. Launch.
    const api = globalThis.FUCompanion?.api?.experimental?.battleDirector;
    if (!api?.start) {
      ui.notifications?.error?.("Random Battle | Battle Director API not loaded (Setup-relaunch needed).");
      return { ok: false, appear: true, launched: false, error: "Director API missing" };
    }

    const payload = buildPayload({ scene, picks, engagement, cfg, tileId });
    payload.party.members = await resolvePartyMembers();
    if (!payload.party.members.length) {
      warn("no party members resolved from the game DB — the battle would be enemy-only");
      ui.notifications?.error?.("Random Battle | No party members in the game DB (member_id_1..4).");
      return { ok: false, appear: true, launched: false, error: "No party members" };
    }

    try {
      // Don't pre-check isRunning() — it is a bare `!!_instance` and reports
      // true for a WEDGED director that start()'s own preflightCleanup would
      // have recovered, so it would refuse launches that are actually fine.
      // start() is the single authority; we just read its verdict, which is
      // legible by identity: it returns a NEW director on success and the
      // EXISTING one when it refuses to clobber a live battle.
      const before  = api.getActiveDirector?.() ?? null;
      // start() awaits only IDLE → PREP; the transition, curtain and spawn run
      // asynchronously after this resolves. That is what lets the player's turn
      // loop finish promptly instead of blocking on the whole cinematic.
      const started = await api.start({ payload });

      if (!started || started === before) {
        warn("Director refused the launch (a battle is already running)");
        ui.notifications?.warn?.("Random Battle | A battle is already running — skipping the auto-launch.");
        return { ok: false, appear: true, launched: false, error: "Director already running" };
      }
      return { ok: true, appear: true, launched: true };
    } catch (e) {
      console.error(TAG, "battleDirector.start threw", e);
      ui.notifications?.error?.(`Random Battle | Failed to start: ${e?.message ?? e}`);
      return { ok: false, appear: true, launched: false, error: String(e?.message ?? e) };
    }
  }

  DP.RandomBattle = {
    run,
    getCurate,
    setCurate,
    /** Exposed for the offline weighting sanity-check and for live debugging. */
    _internals: { pickEncounter, isUnseen, baseWeight, readNoveltyBias, resolvePartyMembers, buildPayload },
  };
})();
