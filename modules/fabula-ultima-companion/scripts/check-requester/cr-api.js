// ============================================================================
// Check Requester — Global Attribute Check API
//
// Public API:  globalThis.ONI.CheckRequester
//   .request(actors, options)   → Promise<CheckResult[]>
//   .requestOne(actor, options) → Promise<CheckResult | null>
//
// Options:
//   attrA        {string}   "DEX"|"MIG"|"INS"|"WLP"        default "DEX"
//   attrB        {string}   "DEX"|"MIG"|"INS"|"WLP"        default "MIG"
//   dl           {number}   Difficulty Level                default 10
//   label        {string}   Title shown in UI and chat      default ""
//   mode         {string}   "interactive" | "silent"        default "interactive"
//   allowInvokes {boolean}  Allow Trait/Bond/Divination     default true
//   postChat     {boolean}  Post grouped chat card          default true
//   modifiers    {Array}    [{label,value}] pre-applied     default []
//   timeout      {number}   ms before auto-confirm (UI)     default null
//   context      {object}   Caller metadata, echoed in results default {}
//
// CheckResult fields:
//   actorUuid, actorName, tokenImg
//   attrA, attrB, dieA, dieB
//   rollA, rollB, hr, base, modifierParts, modTotal, total
//   dl, pass, isCrit, isFumble
//   usedTrait, usedBond, usedDivination
//   context   (echoed from options.context)
// ============================================================================

(() => {
  const ONI       = globalThis.ONI ??= {};
  const TAG       = "[ONI][CheckRequester]";
  const MODULE_ID = "fabula-ultima-companion";
  const SOCKET_CH = `module.${MODULE_ID}`;
  const GUARD     = "__ONI_CHECK_REQUESTER__";

  if (window[GUARD]) { console.debug(TAG, "Already installed."); return; }
  window[GUARD] = true;

  // ── Socket message types (CR_ prefix, won't clash with DP_SC_ messages) ──
  const MSG_OPEN    = "CR_OPEN";
  const MSG_ROLL    = "CR_ROLL";
  const MSG_UPDATE  = "CR_UPDATE";
  const MSG_CONFIRM = "CR_CONFIRM";
  const MSG_REVEAL  = "CR_REVEAL";
  const MSG_CLOSE   = "CR_CLOSE";

  // ── Attribute icons ───────────────────────────────────────────────────────
  const ATTR_ICONS = {
    MIG: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/asan.png",
    DEX: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/boot.png",
    WLP: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/stat.png",
    INS: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/book.png",
  };

  // ── Defaults ──────────────────────────────────────────────────────────────
  const DEFAULTS = {
    attrA: "DEX", attrB: "MIG",
    dl: 10, label: "",
    mode: "interactive",
    allowInvokes: true,
    postChat: true,
    modifiers: [],
    timeout: null,
    context: {},
    singleDie: false,
    hiddenDl: true,
    skipGroupOutcomeSound: false,
    revealTimeout: 2300,
    checkBuffActions: [],
  };

  // ── Helpers ───────────────────────────────────────────────────────────────
  const safeInt = (v, fb = 0) => {
    const n = typeof v === "number" ? v : parseInt(String(v ?? "").replace(/[^\d-]/g, ""), 10);
    return Number.isFinite(n) ? n : fb;
  };
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const esc  = s  => String(s ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;");

  // ── Equipped-gear action-scoped Check buffs (e.g. Encyclopedia +2 Study) ──
  // When the GM tags a Request Check with one or more named actions (Study /
  // Stealth / Strength / Mobility), each tag is matched — purely BY STRING —
  // against every selected actor's EQUIPPED-gear passive `check_buff` rows and
  // any matching +N is folded into that actor's roll as a modifier. This reuses
  // the exact engine the Study action already runs (sumEquippedCheckBuffs in
  // battle-director/skill-effects.js); the dropdown just opens it up to arbitrary
  // checks. cr-api.js is a CLASSIC script, so the module is reached by absolute
  // URL (relative import() would resolve against the page, not this file) and the
  // promise is cached WITHOUT a cache-bust so we share the canonical singleton.
  let _seBuffFnPromise = null;
  const getCheckBuffFn = () => {
    if (!_seBuffFnPromise) {
      _seBuffFnPromise = import(
        `${window.location.origin}/modules/${MODULE_ID}/scripts/battle-director/skill-effects.js`
      ).then(m => m?.sumEquippedCheckBuffs ?? null)
       .catch(e => { console.warn(TAG, "check_buff: skill-effects import failed:", e); return null; });
    }
    return _seBuffFnPromise;
  };

  // Resolve an actor's equipped check_buff modifiers for the given action tokens.
  // Returns [{label, value}] ready to merge into modifierParts. Deduped per gear
  // source so picking two actions a single gear covers never double-counts.
  async function resolveEquippedCheckBuffMods(actor, actions) {
    const list = Array.isArray(actions)
      ? actions.map(a => String(a ?? "").trim().toLowerCase()).filter(Boolean)
      : [];
    if (!actor || !list.length) return [];
    const fn = await getCheckBuffFn();
    if (typeof fn !== "function") return [];
    const bySource = new Map(); // gear name → amount (first match wins per gear)
    for (const cmd of list) {
      let res = null;
      try { res = fn(actor, cmd) ?? null; } catch (e) { console.warn(TAG, "check_buff resolve:", e); }
      for (const p of (res?.parts ?? [])) {
        const src = p?.source ?? "Equipment";
        if (!bySource.has(src)) bySource.set(src, safeInt(p?.amount, 0));
      }
    }
    return [...bySource.entries()]
      .filter(([, amt]) => amt !== 0)
      .map(([src, amt]) => ({ label: src, value: amt }));
  }

  // Decide whether the final die should play intense anticipation.
  // Always intense if the total lands within 3 of DL (close call).
  // Otherwise 8% surprise chance so it doesn't feel fully predictable.
  const pickIntense = (dl, total) => {
    if (dl == null || !Number.isFinite(Number(dl))) return false;
    if (Math.abs(total - Number(dl)) <= 3) return true;
    return Math.random() < 0.08;
  };

  // ── Actor utilities ───────────────────────────────────────────────────────
  const getDieSize = (actor, attr) =>
    safeInt(actor?.system?.props?.[`${attr.toLowerCase()}_current`], 8);

  const getFP = actor => safeInt(actor?.system?.props?.fabula_point, 0);

  const getTokenImg = actor => {
    const std   = String(actor?.system?.props?.sprite_standard ?? "").trim();
    const token = String(actor.getActiveTokens?.(true, true)?.[0]?.document?.texture?.src ?? "").trim();
    const proto = String(actor?.prototypeToken?.texture?.src ?? "").trim();
    return std || token || proto || actor.img || "icons/svg/mystery-man.svg";
  };

  // Resolve an actor or actor UUID → Actor document
  const resolveActorInput = async (input) => {
    if (typeof input === "string") {
      try {
        const doc = await fromUuid(input);
        if (doc?.documentName === "Actor") return doc;
        if (doc?.actor) return doc.actor;
      } catch { return null; }
    }
    return input ?? null;
  };

  const canOwnerAct = (actorUuid) => {
    if (game.user?.isGM) return true;
    const byWorld = game.actors.find(a => a.uuid === actorUuid);
    if (byWorld) return byWorld.testUserPermission(game.user, "OWNER");
    for (const t of (canvas.tokens?.placeables ?? []))
      if (t.actor?.uuid === actorUuid) return t.actor.testUserPermission(game.user, "OWNER");
    return false;
  };

  const resolveActor = async (uuid) => {
    try {
      const doc = await fromUuid(uuid);
      if (doc?.actor) return doc.actor;
      if (doc?.documentName === "Actor") return doc;
    } catch {}
    return null;
  };

  const collectBonds = (actor) => {
    const P   = actor?.system?.props ?? {};
    const POS = new Set(["admiration", "loyalty", "affection"]);
    const NEG = new Set(["inferiority", "mistrust", "hatred"]);
    const bonds = [];
    for (let i = 1; i <= 6; i++) {
      const name = String(P[`bond_${i}`] ?? "").trim();
      if (!name) continue;
      const emotions = [1, 2, 3]
        .map(j => String(P[`emotion_${i}_${j}`] ?? "").trim().toLowerCase())
        .filter(Boolean);
      let filledPos = 0, filledNeg = 0;
      for (const e of emotions) {
        if (POS.has(e)) filledPos++;
        else if (NEG.has(e)) filledNeg++;
      }
      bonds.push({ idx: i, name, bonus: Math.min(3, emotions.length), filledPos, filledNeg });
    }
    return bonds;
  };

  const findDivinationAe = (actor) => {
    for (const ae of (actor?.effects ?? [])) {
      const fl = ae.flags?.[MODULE_ID] ?? {};
      if (fl.chargeKey === "divination" && safeInt(fl.charges, 0) > 0) return ae;
    }
    return null;
  };

  // Observer-model Divination (RAW, Entropist): a creature OTHER than the checker
  // may force the reroll using ITS OWN divination charges ("after a creature you
  // can see performs a Check … you may force that creature to reroll"). Returns an
  // actor the LOCAL user controls (GM → any) that holds divination charges and is
  // NOT the checking actor (that's the self-path, handled by findDivinationAe).
  // Client-local: each client offers the button iff it controls a charge-holder.
  const findObserverDivinationActor = (checkingActorUuid) => {
    for (const actor of (game.actors ?? [])) {
      if (!actor?.isOwner) continue;
      if (actor.uuid === checkingActorUuid) continue;
      if (findDivinationAe(actor)) return actor;
    }
    return null;
  };

  // GM-side "is a divination reroll possible on this check at all" (self OR any
  // observer anywhere) — broadcast via st.canDivination so the checker's client
  // keeps the panel open (suppresses no-options auto-confirm) long enough for an
  // observer to react. Per-client button visibility is refined in syncPanel.
  const anyDivinationAvailable = (checkingActor) => {
    if (findDivinationAe(checkingActor)) return true;
    for (const actor of (game.actors ?? [])) {
      if (actor !== checkingActor && findDivinationAe(actor)) return true;
    }
    return false;
  };

  const consumeDivinationCharge = async (actor) => {
    const ae = findDivinationAe(actor);
    if (!ae) return { ok: false };
    const newCharges = safeInt(ae.flags?.[MODULE_ID]?.charges, 1) - 1;
    try {
      if (newCharges <= 0) await ae.delete();
      else await ae.update({ [`flags.${MODULE_ID}.charges`]: newCharges });
      return { ok: true, remaining: newCharges };
    } catch (e) { console.error(TAG, "consumeDivinationCharge:", e); return { ok: false }; }
  };

  // ── Lucky Seven (Phase 2b) ─────────────────────────────────────────────────
  // SELF-only (RAW "replace one of YOUR dice"): the checking actor replaces one
  // rolled die with its "Lucky Number" (the replaced face becomes the new lucky
  // number), spending the shared once-per-scene "Lucky Seven Ready" charge (the
  // SAME budget Phase 1's set_check_die spends). Reads/writes via the generic
  // charges API. Returns the ready + store effects + current lucky number, or
  // null when unavailable (no Ready charge — out of combat / already used — or no
  // Lucky Number store).
  const chargesApi = () => globalThis?.FUCompanion?.api?.charges ?? null;
  const LS_USED_SCENE_FLAG = "luckySevenUsedScene";
  const currentSceneId = () => canvas?.scene?.id ?? game.scenes?.current?.id ?? game.scenes?.active?.id ?? null;
  const findLuckyState = (actor) => {
    const api = chargesApi();
    if (!api || !actor) return null;
    const store = api.findOnActor(actor, { key: "lucky_number" })[0];
    if (!store) return null;                                  // no value store → never
    const ready = api.findOnActor(actor, { key: "lucky_seven" })[0] ?? null;
    const sceneId = currentSceneId();
    const usedScene = store.effect.flags?.[MODULE_ID]?.[LS_USED_SCENE_FLAG] ?? null;
    // Available IN combat via the "Lucky Seven Ready" charge (armed at
    // conflict_start), OR — OUT of combat, where no Ready charge exists — once per
    // Foundry scene, tracked by a scene-id marker on the store AE (auto-resets
    // when the scene changes). A re-armed Ready charge (a new conflict) overrides
    // a stale marker, so each new battle still grants a fresh use.
    const available = !!ready || (!!sceneId && usedScene !== sceneId);
    if (!available) return null;
    return {
      readyEffect: ready?.effect ?? null,
      readyCharges: ready?.charges ?? 0,
      storeEffect: store.effect,
      luckyNumber: store.charges,
      sceneId,
      viaReady: !!ready,
    };
  };

  // ── Dice & math ───────────────────────────────────────────────────────────
  // Generic dice roller — the shared primitive for "roll N dice of any size".
  // Installed on the ONI global so BOTH the Check Requester (below) and the
  // Battle Director effect engine (the `roll_dice` effect_kind in
  // battle-director/skill-effects.js) roll through ONE code path. Returns every
  // individual face plus the summed total.
  ONI.Dice ??= {};
  ONI.Dice.roll = async (count, faces) => {
    const c = Math.max(1, Math.min(100, safeInt(count, 1)));
    const f = Math.max(1, Math.min(1000, safeInt(faces, 6)));
    const roll = new Roll(`${c}d${f}`);
    await roll.evaluate();
    const rolls = (roll.dice?.[0]?.results ?? []).map(r => safeInt(r.result, 1));
    return { count: c, faces: f, rolls, total: safeInt(roll.total, c) };
  };

  // Attribute-check die: clamps to the d4–d20 band, then delegates the actual
  // roll to the generic ONI.Dice.roll primitive above.
  const rollDie = async (faces) => {
    const f = Math.max(4, Math.min(20, safeInt(faces, 8)));
    return (await ONI.Dice.roll(1, f)).total;
  };

  const computeCheck = (rollA, rollB, modParts, dl, singleDie = false) => {
    const modTotal = (modParts ?? []).reduce((a, p) => a + safeInt(p?.value, 0), 0);
    if (singleDie) {
      const total = rollA + modTotal;
      const pass  = dl != null && Number.isFinite(Number(dl)) ? total >= Number(dl) : null;
      return { hr: rollA, base: rollA, modTotal, total, isFumble: false, isCrit: false, pass };
    }
    const hr       = Math.max(rollA, rollB);
    const base     = rollA + rollB;
    const total    = base + modTotal;
    const isFumble = rollA === 1 && rollB === 1;
    const isCrit   = !isFumble && rollA === rollB && hr >= 6;
    const pass     = dl != null && Number.isFinite(Number(dl)) ? total >= Number(dl) : null;
    return { hr, base, modTotal, total, isFumble, isCrit, pass };
  };

  // Compute authoritative outcome key from an array of check results.
  // Used by the GM to stamp the key into MSG_REVEAL so all clients play the same sound.
  function _computeOutcomeKey(results) {
    if (!results?.length) return null;
    if (results.some(r => r.isFumble))                     return "fumble";
    if (results.every(r => r.isCrit))                      return "crit";
    if (results.every(r => r.pass === true || r.isCrit))   return "success";
    return "fail";
  }

  // Play the group outcome sound that matches a pre-computed key.
  function _playSoundByKey(key) {
    const S = globalThis.ONI?.CheckRequester?.Sound;
    if (!S) return;
    switch (key) {
      case "fumble":  S.playGroupOutcome([{ isFumble: true }]); break;
      case "crit":    S.playGroupOutcome([{ isCrit: true, pass: true }]); break;
      case "success": S.playGroupOutcome([{ pass: true }]); break;
      default:        S.playGroupOutcome([{ pass: false }]); break;
    }
  }

  // ── Silent mode ───────────────────────────────────────────────────────────
  async function silentRequest(actors, opts) {
    const { attrA, attrB, dl, modifiers, context, singleDie } = opts;
    const results = [];
    for (const actor of actors) {
      const dieA     = getDieSize(actor, attrA);
      const dieB     = singleDie ? dieA : getDieSize(actor, attrB);
      const rollA    = await rollDie(dieA);
      const rollB    = singleDie ? rollA : await rollDie(dieB);
      // `attributes` = the dice this check actually rolls, so attribute-scoped
      // gear ("+1 to checks that require the MIG die") applies. singleDie rolls
      // attrA twice; resolve() dedupes either way.
      const actorMods = globalThis.ONI?.CheckModifiers?.resolve?.(
        actor, context?.checkContext ?? null, { attributes: singleDie ? [attrA] : [attrA, attrB] },
      ) ?? [];
      const buffMods  = await resolveEquippedCheckBuffMods(actor, opts.checkBuffActions);
      const modParts = [...actorMods, ...buffMods, ...(modifiers ?? [])];
      const computed = computeCheck(rollA, rollB, modParts, dl, singleDie);
      results.push({
        actorUuid: actor.uuid, actorName: actor.name, tokenImg: getTokenImg(actor),
        attrA, attrB, dieA, dieB, rollA, rollB, singleDie: !!singleDie,
        modifierParts: modParts, ...computed,
        usedTrait: false, usedBond: false, usedDivination: false, usedLuckySeven: false,
        context: context ?? {},
      });
    }
    if (opts.postChat) await postGroupedChatCard(results, opts.label, dl, opts.hiddenDl ?? false);
    return results;
  }

  // =========================================================================
  // CSS
  // =========================================================================
  const STYLE_ID = "oni-cr-style";

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
      .oni-cr-backdrop {
        position: fixed; inset: 0;
        background: rgba(0,0,0,.60);
        z-index: 100010;
        display: flex; flex-direction: column;
        align-items: center; justify-content: center;
        gap: 14px; pointer-events: auto;
      }
      .oni-cr-title {
        font-size: 1.05rem; font-weight: 800; color: #f6ebd3;
        text-shadow: 0 1px 5px rgba(0,0,0,.8);
        letter-spacing: .04em; text-align: center;
      }
      .oni-cr-panels { display: flex; flex-wrap: wrap; justify-content: center; gap: 14px; max-width: 880px; }

      /* Panel entrance animation */
      @keyframes oni-cr-panel-in {
        from { opacity: 0; transform: translateY(20px) scale(0.97); }
        to   { opacity: 1; transform: translateY(0)    scale(1); }
      }

      /* Panel */
      .oni-cr-panel {
        width: 186px;
        background:
          radial-gradient(120% 80% at 50% 0%, rgba(255,255,255,.45) 0%,
            rgba(255,255,255,.15) 22%, transparent 40%),
          linear-gradient(180deg, #f6ebd3 0%, #eddecb 55%, #e4d0b5 100%);
        border: 2.5px solid rgba(91,63,38,.95); border-radius: 16px;
        box-shadow: 0 10px 26px rgba(0,0,0,.28), inset 0 1px 0 rgba(255,248,232,.7);
        color: #3b2a19;
        display: flex; flex-direction: column; align-items: center;
        padding: 12px 10px 10px; gap: 8px; transition: opacity .3s;
        animation: oni-cr-panel-in 300ms cubic-bezier(.22,1,.36,1) both;
      }
      .oni-cr-panel.is-confirmed { opacity: .5; }

      /* Token portrait — transparent container, full sprite visible */
      .oni-cr-portrait {
        width: 86px; height: 86px;
        flex-shrink: 0; position: relative;
        background: transparent !important;
        border: none !important; box-shadow: none !important;
      }
      .oni-cr-portrait img, .oni-cr-portrait video {
        width: 100%; height: 100%; display: block; object-fit: contain;
        background: transparent !important; border: none !important;
        outline: none !important; box-shadow: none !important; filter: none !important;
      }
      .oni-cr-actor-name {
        font-size: .84rem; font-weight: 800; text-align: center;
        max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }

      /* Attribute icon row — always visible throughout check */
      .oni-cr-attr-row { display: flex; align-items: center; justify-content: center; gap: 5px; width: 100%; }
      .oni-cr-attr-block-sm { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 1px; }
      .oni-cr-attr-icon {
        width: 30px; height: 30px; object-fit: contain;
        background: none !important; border: none !important; box-shadow: none !important;
      }
      .oni-cr-attr-label { font-size: .7rem; font-weight: 700; opacity: .7; }

      /* Roll buttons row (hidden after all dice rolled) */
      .oni-cr-roll-row { display: flex; align-items: center; justify-content: center; gap: 5px; width: 100%; }
      .oni-cr-roll-btn {
        font-size: .75rem; font-weight: 800; padding: 3px 8px; border-radius: 8px;
        border: 2px solid rgba(91,63,38,.85);
        background: linear-gradient(180deg, #f6ebd3, #d9c4a4);
        color: #3b2a19; cursor: pointer; transition: filter .1s, transform .1s; white-space: nowrap; line-height: 1.3;
      }
      .oni-cr-roll-btn:hover:not(:disabled) { filter: brightness(1.08); transform: translateY(-1px); }
      .oni-cr-roll-btn:disabled { opacity: .35; cursor: not-allowed; transform: none; filter: none; }
      .oni-cr-roll-btn.is-done { background: linear-gradient(180deg, #c8e6c9, #a5d6a7); border-color: #2e7d32; }
      .oni-cr-plus-sep { font-weight: 900; opacity: .55; flex-shrink: 0; }

      /* Die chips */
      .oni-cr-die-row { display: flex; align-items: center; justify-content: center; gap: 5px; width: 100%; }
      .oni-cr-die-chip {
        display: inline-flex; align-items: center; justify-content: center;
        min-width: 34px; height: 34px; border-radius: 8px;
        background: rgba(0,0,0,.08); border: 1.5px solid rgba(0,0,0,.18);
        font-weight: 900; font-size: 1.05rem; color: #3b2a19;
      }
      /* Number text lives inside the chip; only it gets animated — box stays static */
      .oni-cr-die-num { display: inline-block; transform-origin: center; }
      @keyframes oni-cr-num-land {
        0%   { opacity: 0.1; transform: scale(1.8); }
        55%  { transform: scale(0.88); }
        100% { opacity: 1;   transform: scale(1); }
      }
      .oni-cr-die-num.is-landing {
        animation: oni-cr-num-land 360ms cubic-bezier(.22,1,.36,1) both;
      }

      /* Modifier bonus display (e.g. Helper Bonus from Group Check) */
      .oni-cr-mod-row {
        display: flex; flex-direction: column; align-items: center; gap: 2px; width: 100%;
      }
      .oni-cr-mod-entry {
        font-size: .70rem; font-weight: 700;
        color: #2a7a35;
        background: rgba(46,125,50,.13); border-radius: 5px;
        padding: 2px 9px; text-align: center;
      }

      /* Result */
      .oni-cr-result-block { display: flex; flex-direction: column; align-items: center; gap: 3px; }
      .oni-cr-total { font-size: 1.5rem; font-weight: 900; line-height: 1; }
      .oni-cr-verdict {
        font-size: .75rem; font-weight: 800; padding: 2px 9px; border-radius: 6px;
        text-transform: uppercase; letter-spacing: .05em;
      }
      .oni-cr-verdict.pass   { background: rgba(46,125,50,.18);  color: #2f8a3a; }
      .oni-cr-verdict.fail   { background: rgba(179,58,47,.18);  color: #b33a2f; }
      .oni-cr-verdict.crit   { background: rgba(181,124,0,.2);   color: #7a5000; }
      .oni-cr-verdict.fumble { background: rgba(100,0,0,.18);    color: #7a0000; }
      @keyframes oni-cr-result-in {
        0%   { opacity: 0; transform: translateY(7px) scale(0.90); }
        100% { opacity: 1; transform: translateY(0)   scale(1); }
      }
      .oni-cr-result-block.oni-cr-result-fadein {
        animation: oni-cr-result-in 350ms cubic-bezier(.22,1,.36,1) both;
      }

      /* Panel expansion — invoke area and confirm button slide up when they first appear */
      @keyframes oni-cr-zone-in {
        from { opacity: 0; transform: translateY(7px); }
        to   { opacity: 1; transform: translateY(0); }
      }
      .oni-cr-zone-slide-in {
        animation: oni-cr-zone-in 1500ms cubic-bezier(.22,1,.36,1) both;
      }

      @keyframes oni-cr-verdict-stamp {
        0%   { opacity: 0; transform: scale(2.4); }
        100% { opacity: 1; transform: scale(1); }
      }
      .oni-cr-verdict.oni-cr-verdict-fadein {
        animation: oni-cr-verdict-stamp 520ms cubic-bezier(0.22, 1.55, 0.36, 1) both;
        transform-origin: center;
        position: relative;
        z-index: 5;
      }

      .oni-cr-sep { width: 80%; height: 1px; background: rgba(0,0,0,.14); flex-shrink: 0; }

      /* Invoke area */
      .oni-cr-invoke-area { display: flex; flex-direction: column; gap: 4px; width: 100%; }
      .oni-cr-invoke-btn {
        font-size: .73rem; font-weight: 700; padding: 4px 7px;
        border-radius: 8px; border: 1.5px solid rgba(91,63,38,.8);
        background: linear-gradient(180deg, #f6ebd3, #d9c4a4);
        color: #3b2a19; cursor: pointer; text-align: left; transition: filter .1s;
      }
      .oni-cr-invoke-btn:hover:not(:disabled) { filter: brightness(1.07); }
      .oni-cr-invoke-btn:disabled { opacity: .35; cursor: not-allowed; }
      .oni-cr-invoke-btn.used { opacity: .35; text-decoration: line-through; cursor: not-allowed; }

      /* Confirm */
      .oni-cr-confirm-btn {
        width: 100%; padding: 6px; font-size: .82rem; font-weight: 800;
        border-radius: 10px; border: 2px solid #2e7d32;
        background: linear-gradient(180deg, #4caf50, #2e7d32);
        color: #fff; cursor: pointer; letter-spacing: .03em;
        box-shadow: 0 3px 8px rgba(0,0,0,.2); transition: filter .1s, transform .1s;
      }
      .oni-cr-confirm-btn:hover:not(:disabled) { filter: brightness(1.1); transform: translateY(-1px); }
      .oni-cr-confirm-btn:disabled { opacity: .4; cursor: not-allowed; transform: none; }

      .oni-cr-waiting   { font-size: .78rem; opacity: .55; font-style: italic; text-align: center; }
      .oni-cr-confirmed { font-size: .78rem; color: #2f8a3a; font-weight: 700; text-align: center; }


      /* Sub-panel (inline Invoke selection) */
      .oni-cr-subpanel-overlay {
        position: absolute; inset: 0;
        background: rgba(0,0,0,.42);
        display: flex; align-items: center; justify-content: center; z-index: 10;
      }
      .oni-cr-subpanel {
        background:
          radial-gradient(120% 80% at 50% 0%, rgba(255,255,255,.45) 0%,
            rgba(255,255,255,.15) 22%, transparent 40%),
          linear-gradient(180deg, #f6ebd3 0%, #eddecb 55%, #e4d0b5 100%);
        border: 2.5px solid rgba(91,63,38,.95); border-radius: 16px;
        box-shadow: 0 12px 32px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,248,232,.7);
        padding: 14px 14px 12px; min-width: 220px; max-width: 300px; color: #3b2a19;
      }
      .oni-cr-subpanel-title {
        font-size: .88rem; font-weight: 900; margin-bottom: 10px;
        border-bottom: 1px solid rgba(0,0,0,.15); padding-bottom: 6px;
      }
      .oni-cr-subpanel-rows { display: flex; flex-direction: column; gap: 5px; }
      .oni-cr-subpanel-row {
        display: flex; align-items: center; gap: 8px; padding: 7px 10px;
        border-radius: 10px; border: 2px solid rgba(91,63,38,.6);
        background: linear-gradient(180deg, #f6ebd3, #e4d0b5);
        cursor: pointer; transition: filter .1s;
      }
      .oni-cr-subpanel-row:hover { filter: brightness(1.06); }
      .oni-cr-subpanel-row.on { outline: 2.5px solid #e35151; }
      .oni-cr-subpanel-row img {
        width: 22px; height: 22px; object-fit: contain;
        background: none !important; border: none !important; box-shadow: none !important;
      }
      .oni-cr-subpanel-lbl { flex: 1; font-weight: 800; font-size: .82rem; }
      .oni-cr-subpanel-val { font-weight: 900; font-size: 1rem; }
      .oni-cr-subpanel-footer { display: flex; gap: 7px; margin-top: 10px; }
      .oni-cr-subpanel-btn {
        flex: 1; padding: 6px 4px; border-radius: 10px;
        border: 2px solid rgba(91,63,38,.8);
        font-size: .78rem; font-weight: 800; cursor: pointer;
        background: linear-gradient(180deg, #f6ebd3, #d9c4a4);
        color: #3b2a19; transition: filter .1s, transform .1s;
      }
      .oni-cr-subpanel-btn:hover:not(:disabled) { filter: brightness(1.08); transform: translateY(-1px); }
      .oni-cr-subpanel-btn.primary {
        background: linear-gradient(180deg, #4caf50, #2e7d32); border-color: #2e7d32; color: #fff;
      }
      .oni-cr-subpanel-btn:disabled { opacity: .4; cursor: not-allowed; transform: none; filter: none; }

      /* Trait reroll ticker cards */
      .oni-cr-trait-dice-row { display:flex; gap:10px; justify-content:center; margin-bottom:2px; }
      .oni-cr-trait-die-card {
        display:flex; flex-direction:column; align-items:center; gap:3px;
        padding:10px 14px; border-radius:12px; min-width:64px;
        border:2.5px solid rgba(91,63,38,.6);
        background:linear-gradient(180deg,#f6ebd3,#e4d0b5);
        cursor:pointer; user-select:none;
        transition:border-color .12s, background .12s, box-shadow .12s;
      }
      .oni-cr-trait-die-card:hover { filter:brightness(1.06); }
      .oni-cr-trait-die-card.on {
        border-color:#c0392b;
        background:linear-gradient(180deg,#ffe5e2,#ffc9c4);
        box-shadow:0 0 0 2px rgba(192,57,43,.25);
      }
      .oni-cr-trait-die-card img {
        width:26px; height:26px; object-fit:contain;
        background:none!important; border:none!important; box-shadow:none!important;
      }
      .oni-cr-trait-die-name { font-size:.75rem; font-weight:800; opacity:.8; }
      .oni-cr-trait-die-size { font-size:.68rem; opacity:.55; }
      .oni-cr-trait-die-val  { font-size:1.3rem; font-weight:900; line-height:1; }
    `;
    document.head.appendChild(s);
  }

  // =========================================================================
  // Session state
  // =========================================================================
  let _session = null; // { sessionId, panelStates: Map, backdropEl, dl, opts }

  // =========================================================================
  // Panel HTML
  // =========================================================================
  function buildPanelHtml(pd) {
    const isSingle  = pd.singleDie;
    const iconA     = ATTR_ICONS[pd.attrA] ?? ATTR_ICONS.DEX;
    const iconB     = ATTR_ICONS[pd.attrB] ?? ATTR_ICONS.MIG;
    const isVideo   = /\.(webm|mp4|ogg)(\?|$)/i.test(pd.tokenImg ?? "");
    const tokenMedia = isVideo
      ? `<video src="${esc(pd.tokenImg)}" autoplay loop muted playsinline preload="auto"></video>`
      : `<img src="${esc(pd.tokenImg)}" alt="" onerror="this.src='icons/svg/mystery-man.svg'">`;

    // Attr icon row (always visible — persists after rolling so players know which die is which)
    const attrHeaderA = `
      <div class="oni-cr-attr-block-sm">
        <img class="oni-cr-attr-icon" src="${iconA}" title="${pd.attrA}">
        <div class="oni-cr-attr-label">${pd.attrA}</div>
      </div>`;
    const attrHeaderB = `
      <div class="oni-cr-attr-block-sm">
        <img class="oni-cr-attr-icon" src="${iconB}" title="${pd.attrB}">
        <div class="oni-cr-attr-label">${pd.attrB}</div>
      </div>`;
    const attrHeader = isSingle
      ? attrHeaderA
      : `${attrHeaderA}<div class="oni-cr-plus-sep">+</div>${attrHeaderB}`;

    // Roll buttons (hidden when all dice are in)
    const rollBtns = isSingle
      ? `<button class="oni-cr-roll-btn" data-die="A" data-slot="${pd.slotId}">d${pd.dieA}</button>`
      : `<button class="oni-cr-roll-btn" data-die="A" data-slot="${pd.slotId}">d${pd.dieA}</button>
         <div class="oni-cr-plus-sep">+</div>
         <button class="oni-cr-roll-btn" data-die="B" data-slot="${pd.slotId}">d${pd.dieB}</button>`;

    return `
      <div class="oni-cr-panel" data-slot="${pd.slotId}">
        <div class="oni-cr-portrait">${tokenMedia}</div>
        <div class="oni-cr-actor-name" title="${esc(pd.actorName)}">${esc(pd.actorName)}</div>

        <!-- Attribute icons — always visible -->
        <div class="oni-cr-attr-row">${attrHeader}</div>

        <!-- Roll buttons — hidden when allRolled -->
        <div class="oni-cr-roll-row" data-zone="roll">${rollBtns}</div>

        <div class="oni-cr-die-row" data-zone="dice" style="display:none">
          <div class="oni-cr-die-chip" data-chip="A"><span class="oni-cr-die-num">—</span></div>
          ${!isSingle ? `<div class="oni-cr-plus-sep">+</div><div class="oni-cr-die-chip" data-chip="B"><span class="oni-cr-die-num">—</span></div>` : ""}
        </div>

        <div class="oni-cr-mod-row" data-zone="mods" style="display:none"></div>

        <div class="oni-cr-result-block" data-zone="result" style="display:none">
          <div class="oni-cr-total" data-field="total">—</div>
          <div class="oni-cr-verdict" data-field="verdict"></div>
        </div>

        <div class="oni-cr-sep" data-zone="sep1" style="display:none"></div>

        <div class="oni-cr-invoke-area" data-zone="invoke" style="display:none">
          <button class="oni-cr-invoke-btn" data-action="trait"      data-slot="${pd.slotId}">🎭 Invoke Trait</button>
          <button class="oni-cr-invoke-btn" data-action="bond"       data-slot="${pd.slotId}">🤝 Invoke Bond</button>
          <button class="oni-cr-invoke-btn" data-action="divination" data-slot="${pd.slotId}">🔮 Divination</button>
          <button class="oni-cr-invoke-btn" data-action="lucky"      data-slot="${pd.slotId}">🍀 Lucky Seven</button>
        </div>

        <div class="oni-cr-sep" data-zone="sep2" style="display:none"></div>

        <button class="oni-cr-confirm-btn" data-slot="${pd.slotId}" data-zone="confirm" style="display:none">✓ Confirm</button>
        <div class="oni-cr-confirmed" data-zone="confirmed" style="display:none">Confirmed ✓</div>
        <div class="oni-cr-waiting"   data-zone="waiting">Waiting…</div>
      </div>`;
  }

  // =========================================================================
  // DOM helpers
  // =========================================================================
  const getPanelEl = slot =>
    _session?.backdropEl?.querySelector(`.oni-cr-panel[data-slot="${CSS.escape(slot)}"]`);

  const zone     = (el, name) => el?.querySelector(`[data-zone="${name}"]`);
  const showZone = (el, name, visible) => { const z = zone(el, name); if (z) z.style.display = visible ? "" : "none"; };

  // =========================================================================
  // Sync panel DOM
  // =========================================================================
  function syncPanel(slot) {
    const ses = _session;
    if (!ses) return;
    const st = ses.panelStates.get(slot);
    const el = getPanelEl(slot);
    if (!st || !el) return;

    const isOwner   = canOwnerAct(st.actorUuid);
    const isSingle  = !!st.singleDie;
    const hasA      = st.rollA !== null;
    const hasB      = st.rollB !== null;
    const allRolled = hasA && (isSingle || hasB);

    // Roll buttons (zone hidden when all dice in; attr-row stays visible always)
    showZone(el, "roll", !allRolled);
    {
      const bA = el.querySelector(`.oni-cr-roll-row [data-die="A"]`);
      const bB = el.querySelector(`.oni-cr-roll-row [data-die="B"]`);
      if (bA) { bA.disabled = !isOwner || st.confirmed || hasA; if (hasA) bA.classList.add("is-done"); }
      if (bB && !isSingle) { bB.disabled = !isOwner || st.confirmed || hasB; if (hasB) bB.classList.add("is-done"); }
    }

    // Die chips — show as soon as any die lands
    if (hasA || hasB) {
      showZone(el, "dice", true);
      const cA = el.querySelector("[data-chip='A'] .oni-cr-die-num") ?? el.querySelector("[data-chip='A']");
      const cB = el.querySelector("[data-chip='B'] .oni-cr-die-num") ?? el.querySelector("[data-chip='B']");
      if (cA) cA.textContent = hasA ? String(st.rollA) : "—";
      if (cB && !isSingle) cB.textContent = hasB ? String(st.rollB) : "—";
    } else {
      showZone(el, "dice", false);
    }

    // Modifier row — shows helper bonuses and other pre-applied modifiers after rolling
    const modRowEl = el.querySelector("[data-zone='mods']");
    if (modRowEl) {
      const nonZero = (st.modifierParts ?? []).filter(p => (p?.value ?? 0) !== 0);
      if (allRolled && nonZero.length > 0) {
        modRowEl.style.display = "";
        modRowEl.innerHTML = nonZero.map(p =>
          `<div class="oni-cr-mod-entry">${p.value > 0 ? "+" : ""}${p.value}${p.label ? ` — ${esc(p.label)}` : ""}</div>`
        ).join("");
      } else {
        modRowEl.style.display = "none";
      }
    }

    // Total + verdict
    if (allRolled && st.result) {
      const resultZone = zone(el, "result");
      if (resultZone) {
        // Only animate fade-in on hidden→visible; subsequent syncs leave it static
        const wasHidden = resultZone.style.display === "none";
        resultZone.style.display = "";
        if (wasHidden) {
          resultZone.classList.remove("oni-cr-result-fadein");
          void resultZone.offsetWidth;
          resultZone.classList.add("oni-cr-result-fadein");
        }
      }
      showZone(el, "sep1", true);
      const totalEl   = el.querySelector("[data-field='total']");
      const verdictEl = el.querySelector("[data-field='verdict']");
      if (totalEl) totalEl.textContent = String(st.result.total);
      if (verdictEl) {
        // hiddenDl=true: badge stays hidden until explicit reveal after all confirm
        // hiddenDl=false: badge shows immediately once all dice are in
        const showVerdict = st._revealed || !ses.opts?.hiddenDl;
        if (showVerdict) {
          // Animate badge only on first time it becomes visible
          const wasHidden = verdictEl.style.display === "none";
          verdictEl.style.display = "";
          verdictEl.className = "oni-cr-verdict";
          if (wasHidden) void verdictEl.offsetWidth;
          if (st.result.isFumble)            { verdictEl.textContent = "FUMBLE";    verdictEl.classList.add("fumble"); }
          else if (st.result.isCrit)         { verdictEl.textContent = "CRITICAL!"; verdictEl.classList.add("crit");   }
          else if (st.result.pass === true)  { verdictEl.textContent = ses.opts?.hiddenDl ? "✓ Pass" : `✓ DL ${ses.dl}`; verdictEl.classList.add("pass"); }
          else if (st.result.pass === false) { verdictEl.textContent = ses.opts?.hiddenDl ? "✗ Fail" : `✗ DL ${ses.dl}`; verdictEl.classList.add("fail"); }
          else                               { verdictEl.textContent = `Total ${st.result.total}`; }
          if (wasHidden) {
            verdictEl.classList.add("oni-cr-verdict-fadein");
            if (!st._stampSounded) {
              st._stampSounded = true;
              globalThis.ONI?.CheckRequester?.Sound?.playStamp(st.result);
            }
          }
        } else {
          // Hidden DL mode — keep verdict invisible until reveal fires
          verdictEl.style.display = "none";
          verdictEl.textContent = "";
        }
      }
    } else {
      showZone(el, "result", false);
      showZone(el, "sep1",   false);
    }

    // Invoke area
    const allowInvokes = ses.opts?.allowInvokes !== false;
    const canInvoke    = allowInvokes && isOwner && allRolled && !st.confirmed && !st.result?.isFumble;
    // Divination (RAW observer-model): usable by the LOCAL client if it owns the
    // check AND the checker holds a divination charge (self-path), OR it controls
    // a DIFFERENT divination charge-holder (observer-path). Independent of isOwner;
    // gated like the self-path (rolled, not confirmed, not crit/fumble, not used).
    const divReady    = allowInvokes && allRolled && !st.confirmed
      && !st.result?.isCrit && !st.result?.isFumble && !st.usedDivination;
    const selfDivAe   = divReady ? findDivinationAe(st._actor) : null;
    const obsDivActor = (divReady && !(isOwner && selfDivAe)) ? findObserverDivinationActor(st.actorUuid) : null;
    st._obsDivActorUuid = obsDivActor?.uuid ?? null;
    const divUsable   = !!((isOwner && selfDivAe) || obsDivActor);
    // Lucky Seven (Phase 2b) — SELF-only: the checker (owned by this client)
    // replaces one die with its lucky number, gated on the shared once-per-scene
    // "Lucky Seven Ready" charge (in-combat only). Same rolled / not-confirmed /
    // not-crit-or-fumble / not-used gating as Divination.
    const luckReady   = allowInvokes && isOwner && allRolled && !st.confirmed
      && !st.result?.isCrit && !st.result?.isFumble && !st.usedLuckySeven;
    const luckState   = luckReady ? findLuckyState(st._actor) : null;
    const luckUsable  = !!luckState;
    st._luckyNumber   = luckState?.luckyNumber ?? null;
    const anyInvoke    = st.canTrait || st.canBond || st.canDivination;
    const invokeEl = zone(el, "invoke");
    const shouldShowInvoke = (canInvoke && anyInvoke) || divUsable || luckUsable;
    showZone(el, "invoke", shouldShowInvoke);
    let invokeJustShown = false;
    if (shouldShowInvoke && !st._invokeShown && invokeEl) {
      st._invokeShown = true;
      invokeJustShown = true;
      invokeEl.classList.add("oni-cr-zone-slide-in");
    }
    // Trait / Bond — self-only (owner of the check, spends the checker's FP).
    if (canInvoke && anyInvoke) {
      const applyBtn = (sel, used, can) => {
        const btn = el.querySelector(sel);
        if (!btn) return;
        btn.disabled = used || !can;
        btn.classList.toggle("used", used);
      };
      applyBtn("[data-action='trait']",      st.usedTrait,      st.canTrait);
      applyBtn("[data-action='bond']",       st.usedBond,       st.canBond);
    }
    // Divination — self OR observer; shown independent of check ownership.
    {
      const divBtn = el.querySelector("[data-action='divination']");
      if (divBtn) {
        if (!divUsable && !st.usedDivination) {
          divBtn.style.display = "none";
        } else {
          divBtn.style.display = "";
          divBtn.disabled = st.usedDivination || !divUsable;
          divBtn.classList.toggle("used", st.usedDivination);
        }
      }
    }
    // Lucky Seven — self-only; shows the current lucky number in the label.
    {
      const luckBtn = el.querySelector("[data-action='lucky']");
      if (luckBtn) {
        if (!luckUsable && !st.usedLuckySeven) {
          luckBtn.style.display = "none";
        } else {
          luckBtn.style.display = "";
          luckBtn.disabled = st.usedLuckySeven || !luckUsable;
          luckBtn.classList.toggle("used", st.usedLuckySeven);
          luckBtn.textContent = st._luckyNumber != null
            ? `🍀 Lucky Seven (${st._luckyNumber})`
            : "🍀 Lucky Seven";
        }
      }
    }

    // Confirm / waiting / done
    const confirmEl        = zone(el, "confirm");
    const shouldShowConfirm = isOwner && allRolled && !st.confirmed;
    showZone(el, "sep2",      !st.confirmed);
    showZone(el, "confirm",   shouldShowConfirm);
    showZone(el, "confirmed", st.confirmed);
    showZone(el, "waiting",   !isOwner && !st.confirmed);
    if (shouldShowConfirm && !st._confirmShown && confirmEl) {
      st._confirmShown = true;
      confirmEl.style.animationDelay = invokeJustShown ? "60ms" : "";
      confirmEl.classList.add("oni-cr-zone-slide-in");
    }

    if (st.confirmed) el.classList.add("is-confirmed");
    else              el.classList.remove("is-confirmed");
  }

  // =========================================================================
  // Rolling animation
  // =========================================================================
  async function animateDie(panelEl, chipSel, finalValue, faces, { intense = false } = {}) {
    const chip = panelEl?.querySelector(`[data-chip="${chipSel}"]`);
    if (!chip) return;
    const diceRow = panelEl.querySelector("[data-zone='dice']");
    if (diceRow) diceRow.style.display = "";

    const num = chip.querySelector(".oni-cr-die-num") ?? chip;

    // SFX fires when the animation starts (not on landing)
    try {
      const sfx = globalThis.ONI?.CheckRoller?.CONST?.DEFAULTS?.UI_TUNING?.rollSfxUrl;
      if (sfx) (foundry.audio.AudioHelper ?? AudioHelper).play({ src: sfx, volume: 0.55, autoplay: true }, false);
    } catch (_) {}

    let lastShown = -1;
    const pick = (exclude = lastShown) => {
      let n;
      do { n = Math.floor(Math.random() * faces) + 1; } while (n === exclude && faces > 1);
      return n;
    };

    const showFrame = async (v, tickMs) => {
      await wait(tickMs);
      num.textContent = String(lastShown = v);
    };

    // Pre-compute Phase 2 case BEFORE Phase 1 so we can bridge the last tumble
    // frame into the sequential start with no downward jump at the handoff.
    //
    // Four decel cases — picked randomly each roll:
    //   Case 0: approach → N (no tick) ——stagger——→ stamp N   ("is this it?")
    //   Case 1: approach → N-1 ——stagger——→ stamp N
    //   Case 2: approach → N-2 —hold— tick → N-1 ——stagger——→ stamp N
    //   Case 3: approach → N-3 —hold— tick → N-2 —midHold— tick → N-1 ——stagger——→ stamp N
    //
    // All cases end with ~1s stagger so players can read the "final?" number.
    const decelCase = faces > 1 ? Math.floor(Math.random() * 4) : 0;
    const numSeq    = decelCase === 0 ? 0 : Math.min(decelCase, faces - 1);

    // Sequential values: always upward, wrapping at faces, ending at finalValue-1.
    // Empty for case 0 (lands directly on finalValue).
    const seqValues = [];
    for (let i = numSeq; i >= 1; i--) {
      let v = finalValue - i;
      while (v < 1) v += faces;
      seqValues.push(v);
    }

    // Bridge value: one step below wherever Phase 2 first lands (mod faces).
    // Forced as last Phase 1 frame so the P1→P2 handoff is always upward.
    let bridgeVal = null;
    if (faces > 1) {
      const firstP2 = decelCase === 0 ? finalValue : seqValues[0];
      bridgeVal = firstP2 - 1;
      if (bridgeVal < 1) bridgeVal += faces;
    }

    // Per-case timing constants — intense mode is more dramatic.
    const staggerMs   = intense ? 1200 :  950;  // final hold before stamp
    const midHoldMs   = intense ?  700 :  480;  // Case 3 mid-hold
    const shortHoldMs = intense ?  400 :  280;  // Case 2/3 first hold
    const approachMs  = intense ?  380 :  240;  // slow approach to first seq value
    const tickMs      = intense ?  200 :  140;  // quick tick between seq values

    // Phase 1: fast random tumble — frames 0–6 random, frame 7 forced to bridgeVal.
    for (let i = 0; i < 8; i++) {
      const isLast = i === 7;
      const v = (isLast && bridgeVal !== null) ? bridgeVal : pick();
      await showFrame(v, 48 + Math.floor(Math.random() * 22));
    }

    // Phase 2: case-based decel with explicit stagger holds.
    if (decelCase === 0) {
      await showFrame(finalValue, approachMs); // land directly on final
      await wait(staggerMs);                   // hold: "is this it?"
    } else if (decelCase === 1) {
      await showFrame(seqValues[0], approachMs);
      await wait(staggerMs);
    } else if (decelCase === 2) {
      await showFrame(seqValues[0], approachMs);
      await wait(shortHoldMs);
      await showFrame(seqValues[1], tickMs);
      await wait(staggerMs);
    } else {
      await showFrame(seqValues[0], approachMs);
      await wait(shortHoldMs);
      await showFrame(seqValues[1], tickMs);
      await wait(midHoldMs);
      await showFrame(seqValues[2], tickMs);
      await wait(staggerMs);
    }
    num.classList.remove("is-landing");
    void num.offsetWidth;
    num.textContent = String(finalValue);
    num.classList.add("is-landing");
  }

  // =========================================================================
  // Inline sub-panel
  // =========================================================================
  function showSubPanel(titleText, rowsHtml, confirmLabel, cancelLabel = "Cancel") {
    return new Promise(resolve => {
      const backdrop = _session?.backdropEl;
      if (!backdrop) { resolve(null); return; }

      const overlay = document.createElement("div");
      overlay.className = "oni-cr-subpanel-overlay";

      const panel = document.createElement("div");
      panel.className = "oni-cr-subpanel";
      panel.innerHTML = `
        <div class="oni-cr-subpanel-title">${titleText}</div>
        <div class="oni-cr-subpanel-rows">${rowsHtml}</div>
        <div class="oni-cr-subpanel-footer">
          <button class="oni-cr-subpanel-btn" data-sp="cancel">${cancelLabel}</button>
          <button class="oni-cr-subpanel-btn primary" data-sp="confirm" disabled>${confirmLabel}</button>
        </div>`;
      overlay.appendChild(panel);
      backdrop.appendChild(overlay);

      let selected = null;
      panel.querySelectorAll(".oni-cr-subpanel-row").forEach(r =>
        r.addEventListener("click", () => {
          panel.querySelectorAll(".oni-cr-subpanel-row").forEach(x => x.classList.remove("on"));
          r.classList.add("on");
          selected = r.dataset.value ?? null;
          const cb = panel.querySelector("[data-sp='confirm']");
          if (cb) cb.disabled = false;
        })
      );
      panel.addEventListener("click", e => {
        const btn = e.target.closest("[data-sp]");
        if (!btn || btn.disabled) return;
        overlay.remove();
        resolve(btn.dataset.sp === "confirm" ? selected : null);
      });
      overlay.addEventListener("click", e => { if (e.target === overlay) { overlay.remove(); resolve(null); } });
    });
  }

  // =========================================================================
  // Trait reroll ticker panel (replaces generic showSubPanel for invokeTrait)
  // =========================================================================
  function showTraitRerollPanel(st, isSingle) {
    return new Promise(resolve => {
      const backdrop = _session?.backdropEl;
      if (!backdrop) { resolve(null); return; }

      const iconA = ATTR_ICONS[st.attrA] ?? "";
      const iconB = ATTR_ICONS[st.attrB] ?? "";
      const rB    = isSingle ? st.rollA : (st.rollB ?? "—");

      const overlay = document.createElement("div");
      overlay.className = "oni-cr-subpanel-overlay";

      const panel = document.createElement("div");
      panel.className = "oni-cr-subpanel";
      panel.innerHTML = `
        <div class="oni-cr-subpanel-title">🎭 Invoke Trait — Select dice to reroll</div>
        <div class="oni-cr-trait-dice-row">
          <div class="oni-cr-trait-die-card" data-die="A">
            <img src="${iconA}" alt="${st.attrA}">
            <div class="oni-cr-trait-die-name">${st.attrA}</div>
            <div class="oni-cr-trait-die-size">d${st.dieA}</div>
            <div class="oni-cr-trait-die-val">${st.rollA}</div>
          </div>
          ${!isSingle ? `
          <div class="oni-cr-trait-die-card" data-die="B">
            <img src="${iconB}" alt="${st.attrB}">
            <div class="oni-cr-trait-die-name">${st.attrB}</div>
            <div class="oni-cr-trait-die-size">d${st.dieB}</div>
            <div class="oni-cr-trait-die-val">${rB}</div>
          </div>` : ""}
        </div>
        <div class="oni-cr-subpanel-footer">
          <button class="oni-cr-subpanel-btn" data-sp="cancel">Cancel</button>
          <button class="oni-cr-subpanel-btn primary" data-sp="confirm" disabled>Reroll</button>
        </div>`;
      overlay.appendChild(panel);
      backdrop.appendChild(overlay);

      const selected   = new Set();
      const confirmBtn = panel.querySelector("[data-sp='confirm']");

      panel.querySelectorAll(".oni-cr-trait-die-card").forEach(card => {
        card.addEventListener("click", () => {
          const die = card.dataset.die;
          if (selected.has(die)) { selected.delete(die); card.classList.remove("on"); }
          else                   { selected.add(die);    card.classList.add("on"); }
          if (confirmBtn) confirmBtn.disabled = selected.size === 0;
        });
      });

      panel.addEventListener("click", e => {
        const btn = e.target.closest("[data-sp]");
        if (!btn || btn.disabled) return;
        overlay.remove();
        if (btn.dataset.sp === "cancel") { resolve(null); return; }
        const hasA = selected.has("A"), hasB = selected.has("B");
        resolve(hasA && hasB ? "AB" : hasA ? "A" : hasB ? "B" : null);
      });
      overlay.addEventListener("click", e => { if (e.target === overlay) { overlay.remove(); resolve(null); } });
    });
  }

  // =========================================================================
  // Reveal screen — stagger-reveal all verdict badges, then auto-proceed
  // =========================================================================
  function showRevealAndWait() {
    return new Promise(resolve => {
      const ses = _session;
      if (!ses) { resolve(); return; }

      // Stagger each panel's verdict badge reveal for anticipation.
      // Gaps: 420ms between each participant, plus an extra 380ms pause before
      // the last one when there are multiple participants (roulette decel feel).
      const slots = [...ses.panelStates.keys()];
      const n     = slots.length;
      let lastDelay = 0;

      // Base delay ensures even single-actor checks have a beat before the badge
      // appears (0ms felt instant/mechanical vs. group check's natural stagger).
      const BASE_REVEAL = 420;
      slots.forEach((slot, i) => {
        const isLast = n > 1 && i === n - 1 && !ses.opts?.skipGroupOutcomeSound;
        const delay  = BASE_REVEAL + i * 420 + (isLast ? 380 : 0);
        if (i === n - 1) lastDelay = delay;
        setTimeout(() => {
          const st = ses.panelStates.get(slot);
          if (!st || _session?.sessionId !== ses.sessionId) return;
          st._revealed = true;
          syncPanel(slot);
        }, delay);
      });

      const timeout = ses.opts?.revealTimeout ?? 2300;

      // Group outcome fanfare fires at the end of the tension window,
      // same moment as the auto-proceed resolve — skipped for helper-phase
      // checks so the fanfare only plays on the final (leader) check.
      if (!ses.opts?.skipGroupOutcomeSound) {
        setTimeout(() => {
          // Allow _session to be null (session just closed cleanly by MSG_CLOSE racing the timer).
          // Only block if a DIFFERENT session has taken over — that means a new check started
          // before the sound fired, and we must not play the stale sound.
          if (_session !== null && _session.sessionId !== ses.sessionId) return;
          // Prefer GM-authoritative key stamped into session; fall back to local computation
          // so the GM (which sets the key before its own showRevealAndWait call) is also covered.
          const key = ses._outcomeKey;
          if (key) {
            _playSoundByKey(key);
          } else {
            const results = [...ses.panelStates.values()]
              .filter(s => s.result).map(s => s.result);
            globalThis.ONI?.CheckRequester?.Sound?.playGroupOutcome(results);
          }
        }, lastDelay + timeout);
      }

      // Auto-proceed after the configured tension window
      setTimeout(resolve, lastDelay + timeout);
    });
  }

  // =========================================================================
  // Open overlay
  // =========================================================================
  function openOverlay(data, opts) {
    closeOverlay();
    ensureStyles();
    const { sessionId, panels, dl, tileLabel } = data;

    const backdrop = document.createElement("div");
    backdrop.className = "oni-cr-backdrop";
    backdrop.id = "oni-cr-backdrop";

    const titleEl = document.createElement("div");
    titleEl.className = "oni-cr-title";
    const dlLabel = dl != null ? `(DL ${opts?.hiddenDl ? "?" : dl})` : "";
    titleEl.textContent = [tileLabel ? `Skill Check — ${tileLabel}` : "Skill Check", dlLabel].filter(Boolean).join(" ");
    backdrop.appendChild(titleEl);

    const row = document.createElement("div");
    row.className = "oni-cr-panels";
    row.innerHTML = panels.map(buildPanelHtml).join("");
    backdrop.appendChild(row);
    document.body.appendChild(backdrop);
    globalThis.ONI?.CheckRequester?.Sound?.playCheckStart();

    // Stagger panel entrance — each spawns 90ms after the previous
    row.querySelectorAll(".oni-cr-panel").forEach((el, i) => {
      el.style.animationDelay = `${i * 90}ms`;
    });

    const panelStates = new Map();
    for (const pd of panels) {
      panelStates.set(pd.slotId, {
        ...pd,
        rollA: null, rollB: null,
        result: null, modifierParts: [...(pd.checkBuffMods ?? []), ...(opts?.modifiers ?? [])],
        canTrait: false, usedTrait: false,
        canBond: false,  usedBond: false,
        canDivination: false, usedDivination: false,
        canLuckySeven: false, usedLuckySeven: false,
        confirmed: false, _actor: null, _bonds: null,
        _invokeShown: false, _confirmShown: false, _stampSounded: false,
      });
    }

    _session = { sessionId, panelStates, backdropEl: backdrop, dl, opts };

    backdrop.addEventListener("click", async ev => {
      const rollBtn    = ev.target.closest(".oni-cr-roll-btn");
      const invokeBtn  = ev.target.closest(".oni-cr-invoke-btn");
      const confirmBtn = ev.target.closest(".oni-cr-confirm-btn");
      if (rollBtn)    await onRollClick(rollBtn).catch(e => console.error(TAG, e));
      if (invokeBtn)  await onInvokeClick(invokeBtn).catch(e => console.error(TAG, e));
      if (confirmBtn) await onConfirmClick(confirmBtn).catch(e => console.error(TAG, e));
    });

    for (const [slot, st] of panelStates) {
      syncPanel(slot);
      loadActorCheckMods(slot);
      if (canOwnerAct(st.actorUuid) && opts?.allowInvokes !== false) loadInvokeAvailability(slot);
    }
  }

  // =========================================================================
  // Load actor check modifiers into panel state (unconditional, all actors)
  // =========================================================================
  async function loadActorCheckMods(slot) {
    const ses = _session;
    const st = ses?.panelStates?.get(slot);
    if (!st) return;
    const actor = await resolveActor(st.actorUuid);
    if (!actor || !_session || _session.sessionId !== ses.sessionId) return;
    const mods = globalThis.ONI?.CheckModifiers?.resolve?.(
      actor, ses.opts?.context?.checkContext ?? null,
      { attributes: st.singleDie ? [st.attrA] : [st.attrA, st.attrB] },
    ) ?? [];
    if (!mods.length) return;
    st.modifierParts = [...mods, ...(st.modifierParts ?? [])];
    syncPanel(slot);
  }

  // =========================================================================
  // Load invoke availability
  // =========================================================================
  async function loadInvokeAvailability(slot) {
    const ses = _session;
    if (!ses || ses.opts?.allowInvokes === false) return;
    const st = ses.panelStates.get(slot);
    if (!st) return;
    const actor = await resolveActor(st.actorUuid);
    if (!actor || !_session || _session.sessionId !== ses.sessionId) return;
    const fp = getFP(actor), bonds = collectBonds(actor);
    st._actor = actor; st._bonds = bonds;
    st.canTrait = fp >= 1;
    st.canBond  = fp >= 1 && bonds.length > 0;
    // Broadcast "divination possible" = self OR any observer (RAW observer-model).
    // Keeps the panel open for an observer to force a reroll; per-client button
    // visibility is decided locally in syncPanel.
    st.canDivination = anyDivinationAvailable(actor);
    syncPanel(slot);
  }

  // =========================================================================
  // Close overlay
  // =========================================================================
  function closeOverlay() {
    _session?.backdropEl?.remove();
    _session = null;
  }

  // =========================================================================
  // Roll button
  // =========================================================================
  async function onRollClick(btn) {
    const ses  = _session;
    if (!ses) return;
    const slot = btn.dataset.slot;
    const die  = btn.dataset.die;
    const st = ses.panelStates.get(slot);
    if (!st || st.confirmed) return;
    if (!canOwnerAct(st.actorUuid)) return;
    const isSingle = !!st.singleDie;
    if (die === "A" && st.rollA !== null) return;
    if (die === "B" && (st.rollB !== null || isSingle)) return;
    btn.disabled = true;
    globalThis.ONI?.CheckRequester?.Sound?.playRoll();

    if (isSingle && die === "A") {
      const vA = await rollDie(st.dieA), vB = await rollDie(st.dieA);
      st.rollA = vA; st.rollB = vB;
      game.socket.emit(SOCKET_CH, { type: MSG_ROLL, payload: { sessionId: ses.sessionId, slot, die: "BOTH", rollA: vA, rollB: vB } });
      const panelEl = getPanelEl(slot);
      if (panelEl) {
        const modTotal = (st.modifierParts ?? []).reduce((a, p) => a + safeInt(p?.value, 0), 0);
        await animateDie(panelEl, "A", vA, st.dieA, { intense: pickIntense(ses.dl, vA + modTotal) });
      }
      afterAllRolled(slot);
      return;
    }

    const faces = die === "A" ? st.dieA : st.dieB;
    const value = await rollDie(faces);
    if (die === "A") st.rollA = value; else st.rollB = value;
    game.socket.emit(SOCKET_CH, { type: MSG_ROLL, payload: { sessionId: ses.sessionId, slot, die, value } });
    const panelEl = getPanelEl(slot);
    if (panelEl) {
      let intense = false;
      if (die === "B" && st.rollA !== null) {
        const modTotal = (st.modifierParts ?? []).reduce((a, p) => a + safeInt(p?.value, 0), 0);
        intense = pickIntense(ses.dl, st.rollA + value + modTotal);
      }
      await animateDie(panelEl, die, value, faces, { intense });
    }
    afterAllRolled(slot);
  }

  function afterAllRolled(slot) {
    const ses = _session;
    if (!ses) return;
    const st = ses.panelStates.get(slot);
    if (!st) return;
    const isSingle = !!st.singleDie;
    const allDone  = st.rollA !== null && (isSingle || st.rollB !== null);
    if (!allDone) { syncPanel(slot); return; }
    const rB = isSingle ? st.rollA : (st.rollB ?? st.rollA);
    st.result = computeCheck(st.rollA, rB, st.modifierParts, ses.dl, ses.opts?.singleDie);
    // Record pre-invoke pass state so doConfirm can detect outcome flips
    if (st.initialPass === undefined) st.initialPass = st.result.pass;
    syncPanel(slot);
    if (canOwnerAct(st.actorUuid)) scheduleAutoConfirm(slot);
  }

  // =========================================================================
  // Auto-confirm
  // =========================================================================
  async function scheduleAutoConfirm(slot) {
    const ses = _session;
    if (!ses) return;
    await wait(400);
    if (!_session || _session.sessionId !== ses.sessionId) return;
    const st = ses.panelStates.get(slot);
    if (!st || st.confirmed) return;

    const isFumble  = st.result?.isFumble;
    const noOptions = !st.canTrait && !st.canBond && !st.canDivination;
    // Also auto-confirm if caller passed a timeout
    const timedOut  = ses.opts?.timeout != null;

    if (isFumble || noOptions) {
      const delay = timedOut ? Math.min(ses.opts.timeout, 900) : 900;
      await wait(delay);
      if (_session?.sessionId === ses.sessionId && !st.confirmed) await doConfirm(slot);
    } else if (timedOut) {
      await wait(ses.opts.timeout);
      if (_session?.sessionId === ses.sessionId && !st.confirmed) await doConfirm(slot);
    }
  }

  // =========================================================================
  // Invoke handlers
  // =========================================================================
  async function onInvokeClick(btn) {
    const { action, slot } = btn.dataset;
    const st0 = _session?.panelStates.get(slot);
    if (!st0) return;
    const ownsCheck = canOwnerAct(st0.actorUuid);
    // Divination may be invoked by an OBSERVER who doesn't own the check (RAW
    // observer-model); trait/bond stay owner-only.
    if (action === "divination") {
      if (!ownsCheck && !st0._obsDivActorUuid) return;
    } else if (!ownsCheck) return;
    globalThis.ONI?.CheckRequester?.Sound?.playInvoke();
    if (action === "trait")      await invokeTrait(slot);
    else if (action === "bond")  await invokeBond(slot);
    else if (action === "divination") await invokeDivination(slot);
    else if (action === "lucky") await invokeLuckySeven(slot);
  }

  async function invokeTrait(slot) {
    const ses = _session;
    if (!ses) return;
    const st = ses.panelStates.get(slot);
    if (!st || st.usedTrait || st.result?.isFumble) return;
    const actor = st._actor ?? await resolveActor(st.actorUuid);
    if (!actor || getFP(actor) < 1) { ui.notifications?.warn("Not enough Fabula Points (need 1)."); return; }

    const isSingle = !!st.singleDie;
    const choice = await showTraitRerollPanel(st, isSingle);
    if (!choice) return;

    await actor.update({ "system.props.fabula_point": getFP(actor) - 1 });

    const rA = st.rollA, rB = isSingle ? st.rollA : (st.rollB ?? st.rollA);
    let newA = rA, newB = rB;
    if (choice === "A" || choice === "AB") newA = await rollDie(st.dieA);
    if ((choice === "B" || choice === "AB") && !isSingle) newB = await rollDie(st.dieB);

    st.usedTrait = true; st.canTrait = false;
    st.rollA = newA;
    if (!isSingle) st.rollB = newB;
    st.result = computeCheck(newA, isSingle ? newA : newB, st.modifierParts, ses.dl, ses.opts?.singleDie);

    // Build animation descriptor first — reused for local playback and broadcast.
    const modTotal = (st.modifierParts ?? []).reduce((a, p) => a + safeInt(p?.value, 0), 0);
    const animateDice = [];
    if (choice === "A" || choice === "AB") {
      const isLastDie = isSingle || choice === "A";
      const totA = isSingle ? (newA + modTotal) : (choice === "A" ? (newA + rB + modTotal) : 0);
      animateDice.push({ die: "A", value: newA, faces: st.dieA, intense: isLastDie ? pickIntense(ses.dl, totA) : false });
    }
    if ((choice === "B" || choice === "AB") && !isSingle) {
      const effA = choice === "AB" ? newA : (st.rollA ?? 0);
      animateDice.push({ die: "B", value: newB, faces: st.dieB, intense: pickIntense(ses.dl, effA + newB + modTotal) });
    }
    const panelEl = getPanelEl(slot);
    if (panelEl) {
      showZone(panelEl, "result", false);
      for (const { die, value, faces, intense } of animateDice) {
        await animateDie(panelEl, die, value, faces, { intense });
      }
    }
    broadcastUpdate(slot, animateDice.length ? animateDice : null); syncPanel(slot);
  }

  async function animateTotalRollup(panelEl, fromVal, toVal) {
    const totalEl = panelEl?.querySelector("[data-field='total']");
    if (!totalEl || fromVal === toVal) return;
    const step = toVal > fromVal ? 1 : -1;
    let cur = fromVal;
    while (cur !== toVal) {
      cur += step;
      await wait(160);
      totalEl.textContent = String(cur);
    }
  }

  async function invokeBond(slot) {
    const ses = _session;
    if (!ses) return;
    const st = ses.panelStates.get(slot);
    if (!st || st.usedBond || st.result?.isFumble) return;
    const actor = st._actor ?? await resolveActor(st.actorUuid);
    if (!actor || getFP(actor) < 1) { ui.notifications?.warn("Not enough Fabula Points (need 1)."); return; }
    const bonds = st._bonds ?? collectBonds(actor);
    if (!bonds.length) { ui.notifications?.warn("No bonds found."); return; }

    const bondRowsHtml = bonds.map(b => `
      <div class="oni-cr-subpanel-row" data-value="${b.idx}">
        <div class="oni-cr-subpanel-lbl">${esc(b.name)}<span style="opacity:.6;font-size:.75rem;margin-left:5px;">${'<span style="color:#f472b6;">❤</span>'.repeat(b.filledPos)}${"💜".repeat(b.filledNeg)}</span></div>
        <div class="oni-cr-subpanel-val">+${b.bonus}</div>
      </div>`).join("");

    const bondChoice = await showSubPanel("🤝 Invoke Bond — Choose a Bond", bondRowsHtml, "Invoke");
    if (!bondChoice) return;
    const bond = bonds.find(b => b.idx === parseInt(bondChoice, 10));
    if (!bond) return;

    const oldTotal = st.result?.total ?? null;
    await actor.update({ "system.props.fabula_point": getFP(actor) - 1 });
    st.modifierParts = [...(st.modifierParts ?? []), { label: `Bond: ${bond.name}`, value: bond.bonus }];
    const isSingle = !!st.singleDie;
    st.result = computeCheck(st.rollA, isSingle ? st.rollA : (st.rollB ?? st.rollA), st.modifierParts, ses.dl, ses.opts?.singleDie);
    st.usedBond = true; st.canBond = false;
    const newTotal = st.result.total;
    const totalRollup = oldTotal !== null && oldTotal !== newTotal ? { from: oldTotal, to: newTotal } : null;
    const panelEl = getPanelEl(slot);
    if (panelEl && totalRollup) await animateTotalRollup(panelEl, totalRollup.from, totalRollup.to);
    broadcastUpdate(slot, null, totalRollup); syncPanel(slot);
  }

  async function invokeDivination(slot) {
    const ses = _session;
    if (!ses) return;
    const st = ses.panelStates.get(slot);
    if (!st || st.usedDivination) return;
    if (st.result?.isCrit || st.result?.isFumble) { ui.notifications?.warn("Cannot reroll Critical or Fumble."); return; }
    const checker = st._actor ?? await resolveActor(st.actorUuid);
    // Whose charge pays: the checker's own (self-model) if present, else the local
    // observer's (RAW observer-model — forcing a reroll on a creature you can see).
    let chargeActor = (checker && findDivinationAe(checker)) ? checker : null;
    if (!chargeActor) {
      chargeActor = (st._obsDivActorUuid ? await resolveActor(st._obsDivActorUuid) : null)
        ?? findObserverDivinationActor(st.actorUuid);
    }
    if (!chargeActor || !findDivinationAe(chargeActor)) { ui.notifications?.warn("No Divination charges remaining."); return; }

    const newA = await rollDie(st.dieA), newB = await rollDie(st.dieB);
    const res  = await consumeDivinationCharge(chargeActor);
    if (!res.ok) { ui.notifications?.error("Failed to consume Divination charge."); return; }

    const isSingle = !!st.singleDie;
    st.rollA = newA;
    if (!isSingle) st.rollB = newB;
    st.result = computeCheck(newA, isSingle ? newA : newB, st.modifierParts, ses.dl, ses.opts?.singleDie);
    st.usedDivination = true; st.canDivination = false;

    const modTotal = (st.modifierParts ?? []).reduce((a, p) => a + safeInt(p?.value, 0), 0);
    const animateDice = isSingle
      ? [{ die: "A", value: newA, faces: st.dieA, intense: pickIntense(ses.dl, newA + modTotal) }]
      : [{ die: "A", value: newA, faces: st.dieA, intense: false },
         { die: "B", value: newB, faces: st.dieB, intense: pickIntense(ses.dl, newA + newB + modTotal) }];
    const panelEl = getPanelEl(slot);
    if (panelEl) {
      showZone(panelEl, "result", false);
      for (const { die, value, faces, intense } of animateDice) {
        await animateDie(panelEl, die, value, faces, { intense });
      }
    }
    broadcastUpdate(slot, animateDice); syncPanel(slot);
    ui.notifications?.info(res.remaining > 0 ? `Divination used. ${res.remaining} charge${res.remaining === 1 ? "" : "s"} remaining.` : "Divination used. Active Effect ended.");
  }

  // Lucky Seven (Phase 2b) — replace ONE die with the lucky number; the replaced
  // face becomes the new lucky number. Spends the shared once-per-scene budget.
  async function invokeLuckySeven(slot) {
    const ses = _session;
    if (!ses) return;
    const st = ses.panelStates.get(slot);
    if (!st || st.usedLuckySeven) return;
    if (st.result?.isCrit || st.result?.isFumble) { ui.notifications?.warn("Cannot change a Critical or Fumble."); return; }

    const checker = st._actor ?? await resolveActor(st.actorUuid);
    const luck = findLuckyState(checker);
    if (!luck) { ui.notifications?.warn("Lucky Seven unavailable (no Ready charge this scene)."); return; }

    const isSingle = !!st.singleDie;
    const L = luck.luckyNumber;

    // Pick which die to replace (single-die checks have only die A).
    let which = "A";
    if (!isSingle) {
      const rowsHtml = `
        <div class="oni-cr-subpanel-row" data-value="A">
          <div class="oni-cr-subpanel-lbl">First die (${esc(st.attrA)})</div>
          <div class="oni-cr-subpanel-val">${st.rollA} → ${L}</div>
        </div>
        <div class="oni-cr-subpanel-row" data-value="B">
          <div class="oni-cr-subpanel-lbl">Second die (${esc(st.attrB)})</div>
          <div class="oni-cr-subpanel-val">${st.rollB} → ${L}</div>
        </div>`;
      const choice = await showSubPanel(`🍀 Lucky Seven — replace a die with ${L}`, rowsHtml, "Replace");
      if (!choice) return;
      which = choice === "B" ? "B" : "A";
    }

    const oldFace = which === "A" ? st.rollA : st.rollB;
    const newA = which === "A" ? L : st.rollA;
    const newB = which === "B" ? L : (st.rollB ?? st.rollA);

    // Spend the once-per-scene budget first (abort if it fails): the Ready charge
    // IN combat, else the scene-id marker OUT of combat. Always stamp the marker
    // too, so a later out-of-combat check this same scene is correctly blocked.
    const api = chargesApi();
    if (luck.viaReady) {
      const spent = await api.consume(luck.readyEffect, { count: 1, deleteWhenEmpty: true });
      if (!spent?.ok) { ui.notifications?.error("Lucky Seven: could not spend the once-per-scene charge."); return; }
    }
    if (luck.sceneId) {
      try { await luck.storeEffect.update({ [`flags.${MODULE_ID}.${LS_USED_SCENE_FLAG}`]: luck.sceneId }); }
      catch (e) {
        console.error(TAG, "Lucky Seven: scene-marker write failed:", e);
        if (!luck.viaReady) { ui.notifications?.error("Lucky Seven: could not mark used this scene."); return; }
      }
    }

    st.rollA = newA;
    if (!isSingle) st.rollB = newB;
    st.result = computeCheck(newA, isSingle ? newA : newB, st.modifierParts, ses.dl, ses.opts?.singleDie);
    st.usedLuckySeven = true; st.canLuckySeven = false;

    // The replaced face becomes the new lucky number (never delete the store).
    try { await api.set(luck.storeEffect, oldFace, { deleteWhenEmpty: false }); }
    catch (e) { console.warn(TAG, "Lucky-number writeback failed (swap still applied):", e); }

    const modTotal = (st.modifierParts ?? []).reduce((a, p) => a + safeInt(p?.value, 0), 0);
    const effTotal = (isSingle ? newA : newA + newB) + modTotal;
    const animateDice = [{ die: which, value: which === "A" ? newA : newB, faces: which === "A" ? st.dieA : st.dieB, intense: pickIntense(ses.dl, effTotal) }];
    const panelEl = getPanelEl(slot);
    if (panelEl) {
      showZone(panelEl, "result", false);
      for (const { die, value, faces, intense } of animateDice) {
        await animateDie(panelEl, die, value, faces, { intense });
      }
    }
    broadcastUpdate(slot, animateDice); syncPanel(slot);
    ui.notifications?.info(`Lucky Seven used. Your lucky number is now ${oldFace}.`);
  }

  function broadcastUpdate(slot, animateDice = null, totalRollup = null) {
    const ses = _session;
    if (!ses) return;
    const st = ses.panelStates.get(slot);
    if (!st) return;
    game.socket.emit(SOCKET_CH, {
      type: MSG_UPDATE,
      payload: { sessionId: ses.sessionId, slot, rollA: st.rollA, rollB: st.rollB,
        modifierParts: st.modifierParts, usedTrait: st.usedTrait, usedBond: st.usedBond, usedDivination: st.usedDivination, usedLuckySeven: st.usedLuckySeven,
        animateDice: animateDice ?? null, totalRollup: totalRollup ?? null },
    });
  }

  // =========================================================================
  // Confirm
  // =========================================================================
  async function onConfirmClick(btn) {
    const slot = btn.dataset.slot;
    const st = _session?.panelStates.get(slot);
    if (!st || !canOwnerAct(st.actorUuid)) return;
    globalThis.ONI?.CheckRequester?.Sound?.playConfirm();
    await doConfirm(slot);
  }

  async function doConfirm(slot) {
    const ses = _session;
    if (!ses) return;
    const st = ses.panelStates.get(slot);
    if (!st || st.confirmed || !canOwnerAct(st.actorUuid)) return;

    const isSingle  = !!st.singleDie;
    const singleDie = ses.opts?.singleDie ?? false;
    const rA  = st.rollA ?? 0;
    const rB  = isSingle ? rA : (st.rollB ?? rA);
    const res = st.result ?? computeCheck(rA, rB, st.modifierParts, ses.dl, singleDie);

    st.confirmed = true;
    syncPanel(slot);

    const anyInvokeUsed = st.usedTrait || st.usedBond || st.usedDivination || st.usedLuckySeven;
    const cp = {
      sessionId: ses.sessionId, slotId: slot, actorUuid: st.actorUuid,
      actorName: st.actorName, tokenImg: st.tokenImg ?? "",
      attrA: st.attrA, attrB: st.attrB, dieA: st.dieA, dieB: st.dieB,
      rollA: rA, rollB: rB, modifierParts: st.modifierParts,
      total: res.total, pass: res.pass, isCrit: res.isCrit, isFumble: res.isFumble,
      usedTrait: st.usedTrait, usedBond: st.usedBond, usedDivination: st.usedDivination, usedLuckySeven: st.usedLuckySeven,
      flippedOutcome: anyInvokeUsed && (st.initialPass !== res.pass),
      dl: ses.dl,
      context: ses.opts?.context ?? {}, singleDie,
    };

    game.socket.emit(SOCKET_CH, { type: MSG_CONFIRM, payload: cp });

    // socket.emit doesn't echo to the sender; collect directly on GM
    if (game.user?.isGM) {
      const pending = _pendingSessions.get(ses.sessionId);
      if (pending) { pending.confirms.set(slot, cp); pending.checkComplete(); }
    }
  }

  // =========================================================================
  // Grouped chat card
  // =========================================================================
  async function postGroupedChatCard(confirmPayloads, label, dl, hiddenDl = false) {
    if (!confirmPayloads.length) return;
    const dlLabel   = dl != null ? `(DL ${hiddenDl ? "?" : dl})` : "";
    const titleText = [label ? `Skill Check — ${label}` : "Skill Check", dlLabel].filter(Boolean).join(" ");

    const actorRows = confirmPayloads.map(cp => {
      const { actorName, tokenImg, attrA, attrB, dieA, dieB,
              rollA, rollB, total, pass, isCrit, isFumble, modifierParts, singleDie } = cp;
      const modTotal = (modifierParts ?? []).reduce((a, p) => a + safeInt(p?.value, 0), 0);
      const hr = singleDie ? rollA : Math.max(rollA, rollB), base = singleDie ? rollA : rollA + rollB;

      let verdictText, verdictColor, summaryBg;
      if (isFumble)            { verdictText = "FUMBLE";   verdictColor = "#7a0000"; summaryBg = "rgba(122,0,0,.06)"; }
      else if (isCrit)         { verdictText = "CRITICAL"; verdictColor = "#7a5000"; summaryBg = "rgba(122,80,0,.06)"; }
      else if (pass === true)  { verdictText = "✓ PASS";   verdictColor = "#2f8a3a"; summaryBg = "rgba(46,125,50,.06)"; }
      else if (pass === false) { verdictText = "✗ FAIL";   verdictColor = "#b33a2f"; summaryBg = "rgba(179,58,47,.06)"; }
      else                     { verdictText = String(total); verdictColor = "#3b2a19"; summaryBg = "transparent"; }

      const modRows = (modifierParts ?? [])
        .filter(p => p?.label && safeInt(p.value, 0) !== 0)
        .map(p => `<tr><td style="opacity:.55;padding-right:10px;padding-bottom:2px;">${esc(p.label)}</td>
                       <td style="padding-bottom:2px;">${p.value >= 0 ? "+" : ""}${p.value}</td></tr>`)
        .join("");

      const imgSrc = tokenImg || "icons/svg/mystery-man.svg";
      return `
        <details style="margin-bottom:4px;border-radius:8px;overflow:hidden;border:1.5px solid rgba(91,63,38,.25);">
          <summary style="list-style:none;display:flex;align-items:center;gap:8px;
            cursor:pointer;padding:5px 8px;background:${summaryBg};user-select:none;">
            <img src="${esc(imgSrc)}" alt=""
              style="width:34px;height:34px;flex-shrink:0;object-fit:contain;
                background:transparent!important;border:none!important;
                box-shadow:none!important;filter:none!important;border-radius:0!important;">
            <span style="flex:1;font-weight:800;font-size:.86rem;">${esc(actorName)}</span>
            <span style="font-weight:800;font-size:.82rem;color:${verdictColor};">${verdictText}</span>
          </summary>
          <div style="padding:7px 10px 5px;background:rgba(0,0,0,.03);border-top:1px solid rgba(91,63,38,.18);">
            <table style="width:100%;border-collapse:collapse;font-size:.8rem;color:#3b2a19;">
              <tr><td style="opacity:.55;padding-right:10px;padding-bottom:2px;">Formula</td>
                  <td style="padding-bottom:2px;">${esc(attrA)}${singleDie ? "" : ` + ${esc(attrB)}`}</td></tr>
              <tr><td style="opacity:.55;padding-bottom:2px;">Dice</td>
                  <td style="padding-bottom:2px;">d${dieA}${singleDie ? "" : ` + d${dieB}`}</td></tr>
              <tr><td style="opacity:.55;padding-bottom:2px;">Rolls</td>
                  <td style="padding-bottom:2px;">${rollA}${singleDie ? "" : `, ${rollB}<span style="opacity:.5;"> (HR ${hr})</span>`}</td></tr>
              <tr><td style="opacity:.55;padding-bottom:2px;">Base</td>
                  <td style="padding-bottom:2px;">${base}</td></tr>
              ${modTotal !== 0 ? `<tr><td style="opacity:.55;padding-bottom:2px;">Modifier</td>
                  <td style="padding-bottom:2px;">${modTotal >= 0 ? "+" : ""}${modTotal}</td></tr>` : ""}
              ${modRows}
              <tr><td style="opacity:.55;font-weight:800;padding-top:3px;">Total</td>
                  <td style="font-weight:900;font-size:.95rem;padding-top:3px;">${total}</td></tr>
            </table>
          </div>
        </details>`;
    }).join("");

    await ChatMessage.create({
      content: `
        <div style="font-family:inherit;padding:9px 11px 7px;border-radius:10px;
          background:linear-gradient(180deg,#f6ebd3,#e4d0b5);
          border:2px solid rgba(91,63,38,.8);color:#3b2a19;">
          <div style="font-weight:900;font-size:.92rem;margin-bottom:8px;
            border-bottom:1px solid rgba(0,0,0,.15);padding-bottom:5px;">${esc(titleText)}</div>
          ${actorRows}
        </div>`,
    }).catch(e => console.warn(TAG, "postGroupedChatCard failed:", e));
  }

  // =========================================================================
  // Socket listener
  // =========================================================================
  const _pendingSessions = new Map();

  function setupSocket() {
    if (window["__ONI_CR_SOCKET__"]) return;
    window["__ONI_CR_SOCKET__"] = true;

    game.socket.on(SOCKET_CH, async msg => {
      if (!msg?.type?.startsWith("CR_")) return;

      if (msg.type === MSG_OPEN) {
        openOverlay(msg.payload, msg.opts ?? {});
        return;
      }

      if (msg.type === MSG_ROLL) {
        const { sessionId, slot, die, value, rollA, rollB } = msg.payload ?? {};
        const ses = _session;
        if (!ses || ses.sessionId !== sessionId) return;
        const st = ses.panelStates.get(slot);
        if (!st) return;
        if (die === "BOTH") {
          if (st.rollA !== null) return;
          st.rollA = rollA; st.rollB = rollB;
          const el = getPanelEl(slot);
          if (el) await animateDie(el, "A", rollA, st.dieA);
          afterAllRolled(slot);
        } else {
          if (die === "A" && st.rollA !== null) return;
          if (die === "B" && st.rollB !== null) return;
          if (die === "A") st.rollA = value; else st.rollB = value;
          const el = getPanelEl(slot);
          if (el) await animateDie(el, die, value, die === "A" ? st.dieA : st.dieB);
          afterAllRolled(slot);
        }
        return;
      }

      if (msg.type === MSG_UPDATE) {
        const { sessionId, slot, rollA, rollB, modifierParts, usedTrait, usedBond, usedDivination, usedLuckySeven, animateDice, totalRollup } = msg.payload ?? {};
        const ses = _session;
        if (!ses || ses.sessionId !== sessionId) return;
        const st = ses.panelStates.get(slot);
        if (!st) return;
        Object.assign(st, { rollA, rollB, modifierParts: modifierParts ?? [], usedTrait, usedBond, usedDivination, usedLuckySeven });
        const isSingle = !!st.singleDie;
        if (rollA !== null) st.result = computeCheck(rollA, isSingle ? rollA : (rollB ?? rollA), st.modifierParts, ses.dl, ses.opts?.singleDie);
        const panelEl = getPanelEl(slot);
        if (animateDice?.length && panelEl) {
          showZone(panelEl, "result", false);
          for (const { die, value, faces, intense } of animateDice) {
            await animateDie(panelEl, die, value, faces, { intense: !!intense });
          }
        }
        if (totalRollup?.from !== undefined && panelEl) {
          await animateTotalRollup(panelEl, totalRollup.from, totalRollup.to);
        }
        syncPanel(slot);
        return;
      }

      if (msg.type === MSG_CONFIRM) {
        const { sessionId, slotId } = msg.payload ?? {};
        const ses = _session;
        if (ses && ses.sessionId === sessionId) {
          const st = ses.panelStates.get(slotId);
          if (st) { st.confirmed = true; syncPanel(slotId); }
        }
        if (game.user?.isGM) {
          const pending = _pendingSessions.get(sessionId);
          if (pending) { pending.confirms.set(slotId, msg.payload); pending.checkComplete(); }
        }
        return;
      }

      if (msg.type === MSG_REVEAL) {
        const { sessionId, outcomeKey } = msg.payload ?? {};
        if (_session?.sessionId !== sessionId) return;
        if (!_session?.opts?.hiddenDl) return; // only fires in hidden-DL mode
        // Store GM-authoritative outcome key so showRevealAndWait plays the correct sound.
        if (outcomeKey && _session) _session._outcomeKey = outcomeKey;
        // Non-GM: staggered reveal + auto-proceed; MSG_CLOSE may arrive first.
        showRevealAndWait().then(() => {
          if (_session?.sessionId === sessionId) closeOverlay();
        });
        return;
      }

      if (msg.type === MSG_CLOSE) {
        if (_session?.sessionId === msg.payload?.sessionId) closeOverlay();
      }
    });

    console.debug(TAG, "Socket listener installed.");
  }

  // =========================================================================
  // Reaction system integration
  // Emits oni:reactionPhase events on the GM client after each check resolves.
  // Triggers: creature_performs_check, creature_fumbles_check,
  //           creature_check_outcome_flipped (invoke flipped pass↔fail)
  // =========================================================================
  function emitCheckReactions(cp) {
    if (!game.user?.isGM) return;
    const emit = globalThis.ONI?.emit;
    if (typeof emit !== "function") return;

    // Resolve active token UUID for subject-matching in the reaction system
    const shortId  = String(cp.actorUuid ?? "").replace(/^Actor\./, "");
    const actor    = game.actors?.get(shortId);
    const tokenUuid = actor?.getActiveTokens?.(true, true)?.[0]?.document?.uuid ?? null;

    const base = {
      kind:           "check_requester",
      timestamp:      Date.now(),
      // Subject fields — covers all SUBJECT_PERFORMER field names
      actorUuid:      cp.actorUuid,
      checkActorUuid: cp.actorUuid,
      sourceActorUuid: cp.actorUuid,
      tokenUuid,
      checkTokenUuid: tokenUuid,
      sourceUuid:     tokenUuid,
      // Check data
      attrA:         cp.attrA,
      attrB:         cp.attrB,
      dl:            cp.dl,
      rollA:         cp.rollA,
      rollB:         cp.rollB,
      total:         cp.total,
      pass:          cp.pass,
      isCrit:        cp.isCrit,
      isFumble:      cp.isFumble,
      singleDie:     !!cp.singleDie,
      usedTrait:     !!cp.usedTrait,
      usedBond:      !!cp.usedBond,
      usedDivination: !!cp.usedDivination,
      flippedOutcome: !!cp.flippedOutcome,
      source:        "ONI.CheckRequester",
    };

    const opts = { local: true, world: false };

    emit("oni:reactionPhase", { ...base, trigger: "creature_performs_check" }, opts);

    if (cp.isFumble) {
      emit("oni:reactionPhase", { ...base, trigger: "creature_fumbles_check" }, opts);
    }

    if (cp.flippedOutcome) {
      // A reactive intervention (invoke trait/bond/divination) flipped this open
      // check's pass↔fail. Causer = the checker (self-flip); the director bridge
      // also dispatches causer-side. mechanism best-effort from what was used.
      const mechanism = cp.usedLuckySeven ? "lucky_seven" : cp.usedDivination ? "divination" : cp.usedTrait ? "invoke_trait" : cp.usedBond ? "invoke_bond" : "check";
      emit("oni:reactionPhase", {
        ...base,
        trigger: "creature_check_adjusted",
        subjectActorUuid: cp.actorUuid,
        causerActorUuid: cp.actorUuid,
        causerTokenUuid: tokenUuid,
        mechanism,
        flipMechanism: mechanism,
        resultChanged: true,
        direction: cp.pass ? "improved" : "worsened",
        scope: "check",
      }, opts);
    }
  }

  // =========================================================================
  // Interactive mode
  // =========================================================================
  async function interactiveRequest(actors, opts) {
    if (!game.user?.isGM) throw new Error(`${TAG} interactive mode must run on the GM client.`);
    const { attrA, attrB, dl, label, context } = opts;
    const sessionId = foundry.utils.randomID();

    // slotId — a per-PARTICIPANT identity distinct from actorUuid, so the same
    // actor can occupy multiple panels (e.g. a Protector who takes a redirected
    // save in addition to their own rolls twice). All panel/confirm/socket
    // bookkeeping keys on slotId; actorUuid stays a data field for actor ops.
    const panels = await Promise.all(actors.map(async (actor, i) => {
      const dieA = getDieSize(actor, attrA);
      // Per-actor equipped check_buff modifiers — computed authoritatively on the
      // GM and shipped inside the panel payload (MSG_OPEN), so every client shows
      // the identical bonus from the start. Empty unless the GM tagged actions.
      const checkBuffMods = await resolveEquippedCheckBuffMods(actor, opts.checkBuffActions);
      return {
        slotId: `${actor.uuid}#${i}`,
        actorUuid: actor.uuid, actorName: actor.name, tokenImg: getTokenImg(actor),
        attrA, attrB, singleDie: opts.singleDie ?? false,
        dieA, dieB: opts.singleDie ? dieA : getDieSize(actor, attrB),
        checkBuffMods,
      };
    }));
    const expectedCount = panels.length;

    let _resolve;
    const done = new Promise(res => { _resolve = res; });
    const confirms = new Map();
    _pendingSessions.set(sessionId, {
      confirms,
      checkComplete() { if (confirms.size >= expectedCount) _resolve(Array.from(confirms.values())); },
    });

    const overlayData = { sessionId, panels, dl, tileLabel: label };
    game.socket.emit(SOCKET_CH, { type: MSG_OPEN, payload: overlayData, opts });
    openOverlay(overlayData, opts);

    const confirmPayloads = await done;
    _pendingSessions.delete(sessionId);

    // hiddenDl mode: stagger-reveal verdicts across all clients then auto-proceed.
    // Non-hidden mode: verdicts already visible, close immediately after all confirm.
    if (opts.hiddenDl) {
      const outcomeKey = _computeOutcomeKey(confirmPayloads);
      if (_session) _session._outcomeKey = outcomeKey;
      game.socket.emit(SOCKET_CH, { type: MSG_REVEAL, payload: { sessionId, outcomeKey } });
      await showRevealAndWait();
    }

    if (opts.postChat) await postGroupedChatCard(confirmPayloads, label, dl, opts.hiddenDl ?? false);

    // Opportunity system: offer picker for any crits before reactions trigger.
    // Awaited so reactions are blocked until all pickers resolve or are declined.
    const critPayloads = confirmPayloads.filter(cp => cp.isCrit && !cp.isFumble);
    if (critPayloads.length > 0) {
      await globalThis.ONI?.OpportunitySystem?.processCheckCrits?.(critPayloads);
    }

    // Emit reaction phase events per actor (GM-only, local)
    for (const cp of confirmPayloads) emitCheckReactions(cp);

    game.socket.emit(SOCKET_CH, { type: MSG_CLOSE, payload: { sessionId } });
    closeOverlay();

    return confirmPayloads.map(cp => ({
      actorUuid:    cp.actorUuid,
      actorName:    cp.actorName,
      tokenImg:     cp.tokenImg,
      attrA:        cp.attrA,   attrB:  cp.attrB,
      dieA:         cp.dieA,    dieB:   cp.dieB,
      rollA:        cp.rollA,   rollB:  cp.rollB,
      hr:           cp.singleDie ? cp.rollA : Math.max(cp.rollA, cp.rollB),
      base:         cp.singleDie ? cp.rollA : cp.rollA + cp.rollB,
      modifierParts: cp.modifierParts ?? [],
      modTotal:     (cp.modifierParts ?? []).reduce((a, p) => a + safeInt(p?.value, 0), 0),
      total:        cp.total,
      dl,
      pass:         cp.pass,
      isCrit:       cp.isCrit,
      isFumble:     cp.isFumble,
      usedTrait:    cp.usedTrait,
      usedBond:     cp.usedBond,
      usedDivination: cp.usedDivination,
      usedLuckySeven: cp.usedLuckySeven,
      context:      context ?? {},
    }));
  }

  // =========================================================================
  // Interactive COST ROLL — self-contained single/N-die roll routed to an
  // actor's OWNER (Fatigue / Instability-style reaction costs). Reuses the
  // check-panel CSS + animateDie + ONI.Dice.roll, but is NOT an attribute
  // check (no DL / pass-fail / Invokes). The GM rolls authoritatively; the
  // owner clicks to reveal + animate; the value returns to the caller. Uses a
  // "COSTROLL_" socket prefix so the CR_ check handler ignores these.
  // =========================================================================
  const COSTROLL_OPEN  = "COSTROLL_OPEN";
  const COSTROLL_ROLL  = "COSTROLL_ROLL";
  const COSTROLL_CLOSE = "COSTROLL_CLOSE";
  const _costSessions = new Map(); // sessionId -> { resolve, value, actorUuid, timer }
  let _costBackdrop = null;

  function buildCostOverlayHtml(d) {
    const isVideo = /\.(webm|mp4|ogg)(\?|$)/i.test(d.tokenImg ?? "");
    const media = isVideo
      ? `<video src="${esc(d.tokenImg)}" autoplay loop muted playsinline></video>`
      : `<img src="${esc(d.tokenImg)}" alt="" onerror="this.src='icons/svg/mystery-man.svg'">`;
    const dieLabel = `${d.count > 1 ? d.count : ""}d${d.faces}`;
    return `
      <div class="oni-cr-panel" data-crc="${d.sessionId}" style="width:200px">
        <div class="oni-cr-title">${esc(d.title ?? "Cost Roll")}</div>
        <div class="oni-cr-portrait">${media}</div>
        <div class="oni-cr-actor-name" title="${esc(d.actorName)}">${esc(d.actorName)}</div>
        ${d.label ? `<div class="oni-cr-mod-row"><div class="oni-cr-mod-entry">${esc(d.label)}</div></div>` : ""}
        <div class="oni-cr-roll-row" data-zone="roll">
          <button class="oni-cr-roll-btn" data-crc-roll="${d.sessionId}">🎲 Roll ${dieLabel}</button>
        </div>
        <div class="oni-cr-die-row" data-zone="dice" style="display:none">
          <div class="oni-cr-die-chip" data-chip="A"><span class="oni-cr-die-num">—</span></div>
        </div>
        <div class="oni-cr-waiting" data-zone="waiting" style="display:none">Waiting for player…</div>
      </div>`;
  }

  function closeCostOverlay() {
    if (_costBackdrop) { try { _costBackdrop.remove(); } catch (_) {} _costBackdrop = null; }
  }

  // Owner reveal → tell the GM (or resolve locally if THIS client is the GM,
  // since socket.emit does not loop back to the sender).
  function finalizeCostRoll(sessionId) {
    if (game.user?.isGM) {
      const s = _costSessions.get(sessionId);
      if (s) { if (s.timer) clearTimeout(s.timer); s.resolve(s.value); }
    } else {
      game.socket.emit(SOCKET_CH, { type: COSTROLL_ROLL, payload: { sessionId } });
    }
  }

  function openCostOverlay(d) {
    ensureStyles();
    closeCostOverlay();
    const bd = document.createElement("div");
    bd.className = "oni-cr-backdrop";
    // The cost roll fires DURING an action card's RESOLVE, and the action card
    // sits at z-index 2147483646 (action-card.js). The shared .oni-cr-backdrop
    // z-index (100010) would render this panel BEHIND the card — invisible +
    // unclickable, so it would silently time out. Force it to the top.
    bd.style.zIndex = "2147483647";
    bd.dataset.crc = d.sessionId;
    bd.innerHTML = buildCostOverlayHtml(d);
    document.body.appendChild(bd);
    _costBackdrop = bd;

    const isOwner = canOwnerAct(d.actorUuid);
    const btn = bd.querySelector(`[data-crc-roll="${CSS.escape(d.sessionId)}"]`);
    const rollRow = bd.querySelector('[data-zone="roll"]');
    const waiting = bd.querySelector('[data-zone="waiting"]');
    if (!isOwner) {
      if (rollRow) rollRow.style.display = "none";
      if (waiting) waiting.style.display = "";
      return;
    }
    if (!btn) return;
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      const panel = bd.querySelector(`[data-crc="${CSS.escape(d.sessionId)}"]`);
      const dice = panel?.querySelector('[data-zone="dice"]');
      if (rollRow) rollRow.style.display = "none";
      if (dice) dice.style.display = "";
      await animateDie(panel, "A", d.value, d.faces, { intense: false }).catch(() => {});
      finalizeCostRoll(d.sessionId);
    });
  }

  // Public: GM-only entry. Returns { total, rolls, count, faces }.
  async function rollCost({ actorUuid, faces = 6, count = 1, label = "", title = "Cost Roll", timeoutMs = 90000 } = {}) {
    if (!game.user?.isGM) throw new Error(`${TAG} rollCost must run on the GM client.`);
    const actor = await resolveActor(actorUuid);
    const rolled = await ONI.Dice.roll(count, faces);
    if (!actor) return rolled;
    const sessionId = foundry.utils.randomID();
    const overlayData = {
      sessionId, actorUuid, actorName: actor.name, tokenImg: getTokenImg(actor),
      faces: rolled.faces, count: rolled.count, label, title, value: rolled.total,
    };
    let _resolve;
    const done = new Promise(res => { _resolve = res; });
    const timer = setTimeout(() => _resolve(rolled), Math.max(3000, safeInt(timeoutMs, 90000)));
    _costSessions.set(sessionId, { resolve: _resolve, value: rolled, actorUuid, timer });

    game.socket.emit(SOCKET_CH, { type: COSTROLL_OPEN, payload: overlayData });
    openCostOverlay(overlayData);

    const result = await done;
    const s = _costSessions.get(sessionId);
    if (s?.timer) clearTimeout(s.timer);
    _costSessions.delete(sessionId);
    game.socket.emit(SOCKET_CH, { type: COSTROLL_CLOSE, payload: { sessionId } });
    closeCostOverlay();
    return result ?? rolled;
  }

  function setupCostSocket() {
    if (window["__ONI_COSTROLL_SOCKET__"]) return;
    window["__ONI_COSTROLL_SOCKET__"] = true;
    game.socket.on(SOCKET_CH, async (msg) => {
      if (!msg?.type?.startsWith?.("COSTROLL_")) return;
      if (msg.type === COSTROLL_OPEN) {
        if (game.user?.isGM) return; // GM already opened it locally in rollCost
        openCostOverlay(msg.payload ?? {});
      } else if (msg.type === COSTROLL_ROLL) {
        if (!game.user?.isGM) return;
        const s = _costSessions.get(msg.payload?.sessionId);
        if (s) { if (s.timer) clearTimeout(s.timer); s.resolve(s.value); }
      } else if (msg.type === COSTROLL_CLOSE) {
        closeCostOverlay();
      }
    });
  }

  // =========================================================================
  // Public API
  // =========================================================================
  async function request(actorsInput, options = {}) {
    const opts = { ...DEFAULTS, ...options };
    opts.attrA = String(opts.attrA ?? "DEX").toUpperCase();
    opts.attrB = opts.singleDie ? opts.attrA : String(opts.attrB ?? "MIG").toUpperCase();
    opts.dl    = safeInt(opts.dl, 10);
    opts.modifiers = Array.isArray(opts.modifiers) ? opts.modifiers : [];
    opts.checkBuffActions = Array.isArray(opts.checkBuffActions) ? opts.checkBuffActions : [];

    // Accept actor objects or UUID strings
    const rawActors = Array.isArray(actorsInput) ? actorsInput : [actorsInput];
    const actors = (await Promise.all(rawActors.map(resolveActorInput))).filter(Boolean);
    if (!actors.length) return [];

    if (opts.mode === "silent") return silentRequest(actors, opts);
    return interactiveRequest(actors, opts);
  }

  async function requestOne(actorInput, options = {}) {
    const results = await request([actorInput], options);
    return results[0] ?? null;
  }

  // =========================================================================
  // Boot
  // =========================================================================
  ONI.CheckRequester = { request, requestOne, rollCost };

  Hooks.once("ready", () => {
    setupSocket();
    setupCostSocket();
    console.debug(TAG, "Ready. ONI.CheckRequester available.");
  });
})();
