// ============================================================================
// Dungeon Pathing — World-Map Travel Resolver (GM-side)
// ----------------------------------------------------------------------------
// Fabula Ultima "Journeys and Travels" (Core p.106–108) on a World Map scene
// (DP.isWorldMap). Each Travel tile is one travel day:
//
//   walking client:  TravelRoll.performRoll(scene, { level })   (tile-event-travel.js)
//   GM, via socket:  count the day → resolve the outcome below
//
//   danger    → GM picks: Narrate · Fight · Customize fight · Hazard.
//               No pick in time → Battle 75 / Hazard 25. A battle that cannot
//               be built (no tables / battle map) falls back to a hazard.
//   discovery → GM picks: Narrate · Reveal · Treasure.
//               No pick in time → Reveal, else Treasure, else a Narrate card.
//   safe      → nothing beyond the day.
//
// The roll stays on the walking client so the Cartography reroll prompt lands
// on the player who owns it; everything that writes the world runs here, on
// ONE GM (socketlib executeAsGM, or the GM-direct path in DP.Socket).
//
// Hazards are the FALLBACK when the GM does not narrate the danger: a group
// Check (Check Requester) and, on a failure, FU danger damage (Core p.108,
// by party level) plus an optional status.
// ============================================================================
(() => {
  const DP  = globalThis.DungeonPathing ??= {};
  const TAG = "[DungeonPathing][Travel]";
  const MOD = DP.MODULE_ID ?? "fabula-ultima-companion";

  // How long the GM gets to choose, in ms. The GM's choice is the default
  // path, so this is long enough to pick Narrate — not a blink like the
  // Random Battle override (2.5 s).
  const CHOICE_WINDOW_MS = 10000;

  // Auto-pick when the GM lets the window run out.
  const DANGER_WEIGHTS = Object.freeze({ battle: 75, hazard: 25 });

  // Core p.108 — danger damage by party level.
  const DAMAGE_BANDS = Object.freeze([
    { minLevel: 40, minor: 30, heavy: 50, massive: 80 },
    { minLevel: 20, minor: 20, heavy: 40, massive: 60 },
    { minLevel: 0,  minor: 10, heavy: 30, massive: 40 },   // "5+" row; lower levels use it too
  ]);

  // Threat → hazard Difficulty Level and damage tier (FU DLs 10 / 13 / 16).
  const THREAT_DL   = Object.freeze({ minimal: 10, low: 10, medium: 10, high: 13, very_high: 16 });
  const THREAT_TIER = Object.freeze({ minimal: "minor", low: "minor", medium: "heavy", high: "heavy", very_high: "massive" });

  // Starter hazards. `status` is an Active Effect Manager registry name.
  const HAZARDS = Object.freeze([
    { id: "storm",     name: "Sudden Storm", text: "A howling storm tears across the road.",            attrA: "MIG", attrB: "WLP", status: null },
    { id: "miasma",    name: "Toxic Miasma", text: "A sickly mist rises from the ground.",              attrA: "MIG", attrB: "DEX", status: "Poisoned" },
    { id: "rockslide", name: "Rockslide",    text: "Stones thunder down the slope toward the party.",   attrA: "DEX", attrB: "INS", status: null },
    { id: "cold",      name: "Bitter Cold",  text: "A killing frost settles over the land.",            attrA: "MIG", attrB: "WLP", status: "Slow" },
  ]);

  const DAY_FLAG = "travelDay";

  const log  = (...a) => console.debug(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);

  // ── Threat ─────────────────────────────────────────────────────────────────
  /** The tile's own threat (dungeonPathing.travelThreat), else the scene's. */
  function threatFor(tileDoc, scene) {
    const TR  = globalThis.TravelRoll;
    const raw = tileDoc?.flags?.[MOD]?.[DP.PATHING_ROOT_KEY]?.travelThreat;
    if (raw && TR?.THREAT_DIE?.[raw]) return raw;
    return TR?.getThreatLevel?.(scene) ?? "medium";
  }

  // ── Day counter (on the Current Game DB, so saves carry it) ────────────────
  async function resolveDb() {
    try { return (await globalThis.FUCompanion?.api?.getCurrentGameDb?.())?.db ?? null; }
    catch { return null; }
  }

  async function getDay() {
    const db = await resolveDb();
    return Number(db?.getFlag?.(MOD, DAY_FLAG) ?? 0) || 0;
  }

  async function advanceDay() {
    const db = await resolveDb();
    if (!db) { warn("Current Game DB not resolved — travel day not counted"); return null; }
    const day = (Number(db.getFlag(MOD, DAY_FLAG) ?? 0) || 0) + 1;
    await db.setFlag(MOD, DAY_FLAG, day);
    return day;
  }

  // ── Chat ───────────────────────────────────────────────────────────────────
  // Authored text (hazard names, actor names) goes through textContent-safe
  // escaping; only fixed markup is interpolated raw.
  const esc = (s) => foundry.utils.escapeHTML?.(String(s ?? "")) ?? String(s ?? "");

  function postCard(title, body, color = "#a82828") {
    return ChatMessage.create({
      speaker: { alias: "System" },
      content: `<div style="padding:4px 2px;">
        <div style="font-weight:700;color:${color};">${title}</div>
        <div style="margin-top:2px;">${body}</div>
      </div>`,
    }).catch(e => warn("ChatMessage.create failed:", e));
  }

  // ── GM choice toast (Random Battle's look, generic buttons) ────────────────
  function showChoice({ kind, detail, buttons, ms = CHOICE_WINDOW_MS }) {
    const RB = DP.RandomBattle;
    RB?.injectToastStyles?.();
    const id = RB?.TOAST_ID ?? "oni-dp-encounter-toast";
    document.getElementById(id)?.remove();

    const el = document.createElement("div");
    el.id = id;
    el.innerHTML = `
      <div class="dp-enc-kind"></div>
      <div class="dp-enc-group"></div>
      <div class="dp-enc-actions" style="flex-wrap:wrap;"></div>
      <div class="dp-enc-bar"><i></i></div>`;
    el.querySelector(".dp-enc-kind").textContent  = kind;
    el.querySelector(".dp-enc-group").textContent = detail;
    const row = el.querySelector(".dp-enc-actions");
    for (const b of buttons) {
      const btn = document.createElement("button");
      btn.dataset.act = b.act;
      btn.textContent = b.label;
      btn.style.minWidth = "40%";
      row.appendChild(btn);
    }
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add("visible"));

    el.querySelector(".dp-enc-bar > i")?.animate(
      [{ transform: "scaleX(1)" }, { transform: "scaleX(0)" }],
      { duration: ms, easing: "linear", fill: "forwards" });

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
      row.querySelectorAll("button").forEach(b => b.addEventListener("click", () => finish(b.dataset.act)));
      const timer = setTimeout(() => finish("auto"), ms);
    });
  }

  function weightedPick(weights) {
    const entries = Object.entries(weights).filter(([, w]) => w > 0);
    const total = entries.reduce((s, [, w]) => s + w, 0);
    let r = Math.random() * total;
    for (const [k, w] of entries) { if ((r -= w) < 0) return k; }
    return entries.at(-1)?.[0] ?? null;
  }

  // ── Hazard ─────────────────────────────────────────────────────────────────
  function damageFor(level, partyLevel) {
    const band = DAMAGE_BANDS.find(b => partyLevel >= b.minLevel) ?? DAMAGE_BANDS.at(-1);
    return band[THREAT_TIER[level] ?? "heavy"];
  }

  async function runHazard({ level }) {
    const members = (await globalThis.CampSystem?.Party?.resolve?.().catch(() => []) ?? [])
      .map(m => m.actor).filter(Boolean);
    if (!members.length) { warn("no party members — hazard skipped"); return { ok: false, error: "No party members" }; }

    const hazard = HAZARDS[Math.floor(Math.random() * HAZARDS.length)];
    const dl     = THREAT_DL[level] ?? 10;
    const levels = members.map(a => Number(a.system?.props?.level) || 0);
    const partyLevel = Math.round(levels.reduce((s, n) => s + n, 0) / levels.length);
    const dmg    = damageFor(level, partyLevel);

    await postCard(`⚠ ${esc(hazard.name)}`, `${esc(hazard.text)} <i>(${hazard.attrA} + ${hazard.attrB}, DL ${dl})</i>`);

    const CR = globalThis.ONI?.CheckRequester;
    const results = CR?.request
      ? await CR.request(members, { attrA: hazard.attrA, attrB: hazard.attrB, dl, label: hazard.name, mode: "interactive", postChat: true })
          .catch(e => { warn("check failed — treating everyone as failed", e); return []; })
      : [];
    const passed = new Set((results ?? []).filter(r => r.pass).map(r => r.actorUuid));
    const failed = members.filter(a => !passed.has(a.uuid));

    const dmgApi = globalThis.FUCompanion?.api?.applyDamage?.applyToActor;
    for (const actor of failed) {
      try {
        await dmgApi?.({ baseDamage: dmg, valueType: "hp", targetActor: actor,
                         attackerName: hazard.name, sourceType: "Tile", verbosity: "silent" });
      } catch (e) { warn(`damage on ${actor.name} failed`, e); }
    }
    if (hazard.status && failed.length) {
      await globalThis.FUCompanion?.api?.activeEffectManager?.applyEffects?.({
        actorUuids: failed.map(a => a.uuid), effects: [hazard.status], duplicateMode: "skip", silent: true,
      })?.catch?.(e => warn("status apply failed", e));
    }

    const names = failed.map(a => esc(a.name)).join(", ");
    await postCard(`${esc(hazard.name)} — aftermath`, failed.length
      ? `${names} take${failed.length === 1 ? "s" : ""} <b>${dmg}</b> damage${hazard.status ? ` and ${failed.length === 1 ? "is" : "are"} <b>${esc(hazard.status.toLowerCase())}</b>` : ""}.`
      : "The party weathers it unharmed.");
    log(`hazard ${hazard.id} DL${dl} dmg${dmg} (party L${partyLevel}) failed=${failed.length}/${members.length}`);
    return { ok: true, hazard: hazard.id, failed: failed.length };
  }

  // ── Danger ─────────────────────────────────────────────────────────────────
  async function resolveDanger({ scene, tileId, level, day }) {
    const label = globalThis.TravelRoll?.THREAT_LABEL?.[level] ?? level;
    const pick = await showChoice({
      kind: "Travel — Danger!",
      detail: `Day ${day ?? "?"} · ${label} threat`,
      buttons: [
        { act: "narrate",   label: "Narrate" },
        { act: "fight",     label: "Fight" },
        { act: "customize", label: "Customize fight…" },
        { act: "hazard",    label: "Hazard" },
      ],
    });

    if (pick === "narrate") {
      await postCard("Danger!", "Something stands in the party's way… <i>(the GM describes it)</i>");
      return { ok: true, resolved: "narrate" };
    }

    const kind = pick === "auto" ? weightedPick(DANGER_WEIGHTS) : pick;
    if (kind === "fight" || kind === "customize" || kind === "battle") {
      const res = await DP.RandomBattle?.run?.({ sceneId: scene.id, tileId, forced: true,
                                                 verdict: kind === "customize" ? "customize" : "auto" });
      if (res?.appear || res?.launched) return { ...res, resolved: kind };
      warn("battle could not be built — falling back to a hazard:", res?.error);
    }
    const hz = await runHazard({ level });
    return { ...hz, resolved: "hazard", launched: false };
  }

  // ── Discovery ──────────────────────────────────────────────────────────────
  function revealCandidates(scene, tokenDoc) {
    const g  = canvas?.grid?.size ?? 100;
    const tx = (tokenDoc?.x ?? 0) + g / 2, ty = (tokenDoc?.y ?? 0) + g / 2;
    return (scene.tiles?.contents ?? [])
      .filter(t => t.flags?.[MOD]?.[DP.PATHING_ROOT_KEY]?.fogMode === "shroud"
                && !DP.TileState?.isFogRevealed?.(scene, t.id))
      .sort((a, b) => Math.hypot(a.x - tx, a.y - ty) - Math.hypot(b.x - tx, b.y - ty));
  }

  const hasTreasureTable = (scene) =>
    !!String(window.oni?.FabulaConfig?.readDungeon?.(scene)?.loot?.treasure ?? "").trim();

  async function reveal(scene, tileDoc) {
    await DP.TileState.markFogRevealed(scene, tileDoc.id);
    await postCard("Discovery!", `The party finds a hidden place: <b>${esc(tileDoc.name || "an unknown location")}</b>.`, "#b8860b");
    return { ok: true, resolved: "reveal", tileId: tileDoc.id };
  }

  async function treasure({ scene, tileId, tokenId, userId }) {
    const flow = window["oni.TreasureRoulette.Flow"];
    const res = await flow?.run?.({
      tileDoc: scene.tiles.get(tileId), tokenDoc: scene.tokens.get(tokenId), scene,
      dpTypeKey: "treasure", controllerUserId: userId ?? null,
      allowSkeletalKey: false, consumeTile: false,
    });
    return { ok: !!res?.ok, resolved: "treasure", error: res?.reason };
  }

  async function resolveDiscovery({ scene, tileId, tokenId, userId, day }) {
    const tokenDoc   = scene.tokens.get(tokenId);
    const candidates = revealCandidates(scene, tokenDoc);
    const canTreasure = hasTreasureTable(scene);

    const buttons = [{ act: "narrate", label: "Narrate" }];
    if (candidates.length) buttons.push({ act: "reveal", label: "Reveal hidden place" });
    if (canTreasure)       buttons.push({ act: "treasure", label: "Treasure" });

    const pick = await showChoice({ kind: "Travel — Discovery!", detail: `Day ${day ?? "?"}`, buttons });

    if (pick === "reveal"   && candidates.length) return reveal(scene, candidates[0]);
    if (pick === "treasure" && canTreasure)       return treasure({ scene, tileId, tokenId, userId });
    if (pick === "auto") {
      if (candidates.length) return reveal(scene, candidates[0]);
      if (canTreasure)       return treasure({ scene, tileId, tokenId, userId });
    }
    await postCard("Discovery!", "The party comes upon something worth remembering… <i>(the GM describes it)</i>", "#b8860b");
    return { ok: true, resolved: "narrate" };
  }

  // ── Entry point (GM) ───────────────────────────────────────────────────────
  /**
   * Resolve a Travel tile landing after the walking client rolled.
   * Never throws — it sits inside the player's turn loop.
   * @returns {Promise<{ok:boolean, day?:number, resolved?:string, launched?:boolean, error?:string}>}
   */
  async function resolve({ sceneId, tileId, tokenId, userId, outcome, level } = {}) {
    try {
      if (!game.user?.isGM) return { ok: false, error: "Not GM" };
      const scene = game.scenes?.get?.(sceneId);
      if (!scene) return { ok: false, error: "Scene not found" };

      const day = await advanceDay();
      log(`day ${day}: ${outcome} (${level}) on ${scene.name}`);

      if (outcome === "danger")    return { day, ...(await resolveDanger({ scene, tileId, level, day })) };
      if (outcome === "discovery") return { day, ...(await resolveDiscovery({ scene, tileId, tokenId, userId, day })) };
      return { ok: true, day, resolved: "safe" };
    } catch (e) {
      console.error(TAG, "resolve() threw", e);
      return { ok: false, error: String(e?.message ?? e) };
    }
  }

  DP.Travel = {
    resolve,
    threatFor,
    getDay,
    /** Exposed for live debugging and the offline check. */
    _internals: { damageFor, runHazard, resolveDanger, resolveDiscovery, weightedPick,
                  HAZARDS, DAMAGE_BANDS, THREAT_DL, THREAT_TIER, DANGER_WEIGHTS },
  };
})();
