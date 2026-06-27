/**
 * [CheckRoller] LuckySevenButtons — Foundry VTT v12
 * -----------------------------------------------------------------------------
 * Phase 2 of Hina's Lucky Seven: the OPEN-CHECK path. Adds a pair of
 * "🍀 First die / 🍀 Second die" buttons to a CheckRoller card, letting the
 * checker replace ONE rolled die with their lucky number (the replaced face
 * becomes the new lucky number). Mirrors checkRoller-divinationButtons.js; the
 * BD action-card path (attacks / offensive spells) is Phase 1 (set_check_die).
 *
 * RAW: "Once per scene after YOU perform a Check, replace one die's value with
 * your lucky number (even an impossible value); the replaced value becomes your
 * new lucky number."
 *
 * Authoring contract (lives in `worlds/`, authored by _author-hina-lucky-seven.js):
 *   - "Lucky Number" AE — the value store:
 *       flags.fabula-ultima-companion.chargeKey = "lucky_number"
 *       flags.fabula-ultima-companion.charges   = <current lucky number, seed 7>
 *   - "Lucky Seven Ready" AE — the once-per-scene budget (armed at conflict_start):
 *       flags.fabula-ultima-companion.chargeKey = "lucky_seven"
 *       flags.fabula-ultima-companion.charges   = 1
 * This file only READS/CONSUMES those AEs; arming + seeding is the BD's job.
 *
 * Gating (all must hold, else no button):
 *   - The viewer OWNS the actor that performed THIS check (self-only — RAW "your
 *     dice"; unlike Divination's observer model). payload.meta.actorUuid.
 *   - That actor has a "Lucky Seven Ready" charge > 0 (the shared once-per-scene
 *     budget — the SAME charge Phase 1 spends, so it can fire at most once per
 *     scene across attacks AND open checks). In-combat only (Ready is armed at
 *     conflict_start); out-of-combat is a deferred enhancement.
 *   - That actor has a "Lucky Number" store AE (the value to swap in).
 *   - The current roll is NOT a Crit or Fumble (RAW: locked outcomes).
 *
 * Runtime behavior on click:
 *   - Replace the chosen die with the lucky number, recompute total/crit/fumble
 *     (open-check rule), write the payload back (via GMExecutor when the viewer
 *     doesn't own the message), re-render.
 *   - Consume 1 "Lucky Seven Ready" charge (deletes the AE → buttons vanish for
 *     the rest of the scene; Phase 1 also hides).
 *   - Write the replaced OLD face back to the "Lucky Number" store (never delete).
 *   - Emit `creature_check_adjusted` (mechanism "lucky_seven") on an outcome flip
 *     so Hina's Zero Trigger: Foresight grants a Zero Power — same channel as
 *     Divination.
 */

(() => {
  const TAG = "[ONI][CheckRoller:LuckySeven]";
  const MANAGER = globalThis.ONI?.CheckRoller;

  if (!MANAGER || !MANAGER.__isCheckRollerManager) {
    console.error(`${TAG} Manager not found at ONI.CheckRoller`);
    return;
  }
  if (globalThis.ONI.__CheckRollerLuckySevenInstalled) {
    console.debug(`${TAG} Already installed. (Re-run ignored)`);
    return;
  }

  const { CONST } = MANAGER;
  const MODULE_SCOPE = "fabula-ultima-companion";
  const READ_SCOPES = Array.from(new Set([CONST.FLAG_SCOPE, MODULE_SCOPE].filter(Boolean)));
  const WRITE_SCOPE = game.modules?.has(CONST.FLAG_SCOPE) ? CONST.FLAG_SCOPE : MODULE_SCOPE;
  const PASS_LS_PREFIX = "oni.luckySevenPassed";

  const READY_KEY = "lucky_seven";   // once-per-scene budget (shared with Phase 1)
  const STORE_KEY = "lucky_number";  // the value store (read + writeback)

  // ---------------------------------------------------------------------------
  // Tiny helpers
  // ---------------------------------------------------------------------------
  const safeStr = (v, fb = "") => (typeof v === "string" ? v : (v == null ? fb : String(v)));
  const safeInt = (v, fb = 0) => {
    const n = typeof v === "number" ? v : parseInt(String(v ?? "").replace(/[^\d-]/g, ""), 10);
    return Number.isFinite(n) ? n : fb;
  };
  const esc = (s) => safeStr(s, "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  const sumParts = (parts) => Array.isArray(parts)
    ? parts.reduce((a, p) => a + safeInt(p?.value, 0), 0) : 0;
  const deepClone = (obj) => foundry.utils.deepClone(obj);
  const chargesApi = () => globalThis?.FUCompanion?.api?.charges ?? null;

  // ---------------------------------------------------------------------------
  // Open-check helpers (self-contained — divinationCore.js / ONI.Divination is
  // NOT loaded by this build's manifest, so we inline the few small helpers we
  // need rather than depend on it. Crit/fumble + outcome-flip semantics match
  // divinationCore.js's open-check rule verbatim so Foresight fires identically.)
  // ---------------------------------------------------------------------------
  const isLockedByCritOrFumble = (r) => !!(r?.isCrit || r?.isFumble);

  // Open-Check rule: matched dice ≥ 6 = crit, double-1 = fumble.
  const computeOpenCheckResult = (rA, rB) => {
    const isFumble = (rA === 1 && rB === 1);
    const isCrit = (!isFumble && rA === rB && rA >= 6);
    return { isCrit, isFumble };
  };

  const snapshotCheckResult = (res) => ({
    rollA: safeInt(res?.rollA, 0),
    rollB: safeInt(res?.rollB, 0),
    total: safeInt(res?.total, 0),
    hr: safeInt(res?.hr, 0),
    isCrit: !!res?.isCrit,
    isFumble: !!res?.isFumble,
    pass: (res?.pass === true || res?.pass === false) ? res.pass : null,
  });

  const outcomeOpenCheck = (result, dl) => {
    if (result?.isCrit) return "success";
    if (result?.isFumble) return "failure";
    const n = Number(dl);
    if (!Number.isFinite(n)) return "unknown";
    return Number(result?.total) >= n ? "success" : "failure";
  };
  // Conservative: when the outcome can't be determined (no DL), DO NOT emit —
  // the GM grants the Zero Power manually (same design decision as Divination).
  const outcomeFlippedOpenCheck = (before, after, dl) => {
    const a = outcomeOpenCheck(before, dl);
    const b = outcomeOpenCheck(after, dl);
    if (a === "unknown" || b === "unknown") return false;
    return a !== b;
  };

  // Emit `creature_check_adjusted` (self-flip: subject == causer == actor) so
  // Hina's Zero Trigger: Foresight grants a Zero Power. Same payload shape +
  // channel as divinationCore.emitOutcomeFlipped.
  const emitCheckAdjusted = ({ actor, before, after, mechanism = "lucky_seven" }) => {
    if (!actor) return;
    const tokens = (typeof actor.getActiveTokens === "function") ? actor.getActiveTokens(true, true) : [];
    const token = Array.isArray(tokens) && tokens[0] ? tokens[0] : null;
    const tokenUuid = token?.document?.uuid ?? null;
    const reactionPayload = {
      kind: "check_adjusted", trigger: "creature_check_adjusted", timestamp: Date.now(),
      actorUuid: actor.uuid ?? null, tokenUuid, sourceUuid: tokenUuid, sourceActorUuid: actor.uuid ?? null,
      subjectTokenUuid: tokenUuid, subjectActorUuid: actor.uuid ?? null,
      causerActorUuid: actor.uuid ?? null, causerTokenUuid: tokenUuid,
      mechanism, flipMechanism: mechanism, resultChanged: true,
      before: { ...(before ?? {}) }, after: { ...(after ?? {}) },
      requestedByUserId: game.user?.id ?? null, requestedByUserName: game.user?.name ?? null,
    };
    const channel = `module.${MODULE_SCOPE}`;
    if (game.user?.isGM) {
      if (globalThis.ONI?.emit) ONI.emit("oni:reactionPhase", reactionPayload, { local: true, world: false });
    } else {
      if (game.socket) game.socket.emit(channel, { type: "OniReactionPhaseRequest", payload: reactionPayload });
      if (globalThis.ONI?.emit) ONI.emit("oni:reactionPhase", reactionPayload, { local: true, world: false });
    }
  };

  const getPayload = (message) => {
    for (const scope of READ_SCOPES) {
      try {
        const p = message?.getFlag(scope, CONST.FLAG_KEY_CARD);
        if (p) return p;
      } catch (_) {}
    }
    return null;
  };

  const isCheckRollerMessage = (message) => {
    const p = getPayload(message);
    return Boolean(p && p.kind === "fu_check");
  };

  // ---------------------------------------------------------------------------
  // Self-only caster lookup: the actor that performed THIS check, IF the viewer
  // owns it AND it holds a Lucky Seven Ready budget + a Lucky Number store.
  // ---------------------------------------------------------------------------
  function findLuckyCasterForCheck(payload) {
    const api = chargesApi();
    if (!api) return null;
    const checkerUuid = safeStr(payload?.meta?.actorUuid, "");
    if (!checkerUuid) return null;

    // Must be the checking actor (self-only) AND owned by this viewer.
    let actor = null;
    for (const a of (game.actors ?? [])) {
      if (a?.uuid === checkerUuid) { actor = a; break; }
    }
    if (!actor || !actor.isOwner) return null;

    const readyHits = api.findOnActor(actor, { key: READY_KEY });   // charges > 0
    if (!readyHits.length) return null;
    const storeHits = api.findOnActor(actor, { key: STORE_KEY });
    if (!storeHits.length) return null;

    return {
      actor,
      readyEffect: readyHits[0].effect,
      readyCharges: readyHits[0].charges,
      storeEffect: storeHits[0].effect,
      luckyNumber: storeHits[0].charges,
    };
  }

  // ---------------------------------------------------------------------------
  // Pass-state (per-viewer, per-card, per-actor) — local only
  // ---------------------------------------------------------------------------
  const passKey = (msgId, actorId) => `${PASS_LS_PREFIX}.${msgId}.${actorId}`;
  const hasPassed = (msgId, actorId) => {
    try { return window.localStorage?.getItem(passKey(msgId, actorId)) === "1"; }
    catch (_) { return false; }
  };
  const setPassed = (msgId, actorId, on) => {
    try {
      if (on) window.localStorage?.setItem(passKey(msgId, actorId), "1");
      else window.localStorage?.removeItem(passKey(msgId, actorId));
    } catch (_) {}
  };

  // ---------------------------------------------------------------------------
  // Cross-permission message-payload write (mirrors divinationButtons)
  // ---------------------------------------------------------------------------
  async function writePayload(message, nextPayload) {
    const ownsMessage = game.user?.isGM || message?.user?.id === game.user?.id;
    if (ownsMessage) {
      await message.setFlag(WRITE_SCOPE, CONST.FLAG_KEY_CARD, nextPayload);
      return;
    }
    const gmExec = globalThis?.FUCompanion?.api?.GMExecutor;
    if (!gmExec?.executeSnippet) throw new Error("GMExecutor unavailable for cross-permission Lucky Seven write.");
    const scriptText = `
      const msg = game.messages.get(payload.msgId);
      if (!msg) return { ok: false, reason: "message_not_found" };
      await msg.setFlag(payload.scope, payload.key, payload.next);
      return { ok: true };
    `;
    const res = await gmExec.executeSnippet({
      scriptText,
      payload: { msgId: message.id, scope: WRITE_SCOPE, key: CONST.FLAG_KEY_CARD, next: nextPayload }
    });
    if (!res?.ok) throw new Error(`GMExecutor refused Lucky Seven write: ${safeStr(res?.reason, "unknown")}`);
  }

  // ---------------------------------------------------------------------------
  // Apply Lucky Seven to a CheckRoller message — replace die `which` ("A"|"B").
  // ---------------------------------------------------------------------------
  async function applyLuckySeven(message, which) {
    const payload = getPayload(message);
    if (!payload) return;

    payload.meta = payload.meta || {};
    payload.meta.invoked = payload.meta.invoked || { trait: false, bond: false };
    if (payload.meta.invoked.luckySeven) {
      ui.notifications?.warn("Lucky Seven already used on this check.");
      return;
    }
    if (isLockedByCritOrFumble(payload.result)) {
      ui.notifications?.warn("Critical and Fumble results cannot be changed.");
      return;
    }

    const caster = findLuckyCasterForCheck(payload);
    if (!caster) {
      ui.notifications?.warn("Lucky Seven unavailable (no Ready charge or not your check).");
      return;
    }
    const { actor, readyEffect, storeEffect, luckyNumber } = caster;

    const result = payload.result || {};
    const rollA = safeInt(result.rollA, 0);
    const rollB = safeInt(result.rollB, 0);
    if (rollA <= 0 || rollB <= 0) {
      ui.notifications?.error("Lucky Seven: invalid dice on this check.");
      return;
    }

    const before = snapshotCheckResult(result);

    // Replace the chosen die with the lucky number; the OTHER die is kept. No
    // clamp — RAW allows an impossible value (a 7 on a d6).
    const oldFace = which === "A" ? rollA : rollB;
    const newA = which === "A" ? luckyNumber : rollA;
    const newB = which === "B" ? luckyNumber : rollB;

    const next = deepClone(payload);
    next.meta = next.meta || {};
    next.meta.invoked = next.meta.invoked || { trait: false, bond: false };
    next.meta.invoked.luckySeven = true;
    next.meta.luckySevenBy = {
      actorId: actor.id, actorUuid: actor.uuid, actorName: actor.name,
      which, oldFace, newFace: luckyNumber,
      userId: game.user?.id ?? null, userName: game.user?.name ?? null,
    };

    next.result = next.result || {};
    next.result.rollA = newA;
    next.result.rollB = newB;
    next.result.hr = Math.max(newA, newB);
    next.result.base = newA + newB;
    const modTotal = sumParts(next?.check?.modifier?.parts || []);
    next.result.modifierTotal = modTotal;
    next.result.total = next.result.base + modTotal;
    const cf = computeOpenCheckResult(newA, newB);
    next.result.isCrit = cf.isCrit;
    next.result.isFumble = cf.isFumble;

    // Spend the once-per-scene budget FIRST (abort the swap if it fails so the
    // player isn't charged for nothing).
    const api = chargesApi();
    const spent = await api.consume(readyEffect, { count: 1, deleteWhenEmpty: true });
    if (!spent?.ok) {
      console.error(`${TAG} Failed to consume Lucky Seven Ready charge; aborting.`, spent);
      ui.notifications?.error("Lucky Seven: could not spend the once-per-scene charge; aborted.");
      return;
    }

    try {
      await writePayload(message, next);
    } catch (e) {
      console.error(`${TAG} Reroll write failed; Ready charge already spent.`, e);
      ui.notifications?.error("Lucky Seven: change failed to apply (charge was spent).");
      return;
    }

    // The replaced face becomes the new lucky number (never delete the store).
    try {
      await api.set(storeEffect, oldFace, { deleteWhenEmpty: false });
    } catch (e) {
      console.warn(`${TAG} Lucky-number writeback failed (swap still applied).`, e);
    }

    if (typeof MANAGER.updateMessage === "function") {
      try { await MANAGER.updateMessage(message, { payload: next }); } catch (_) {}
    }

    console.log(`${TAG} Applied`, {
      msgId: message.id, actorName: actor.name, which,
      swap: `${oldFace} → ${luckyNumber}`, newTotal: next.result.total,
      newLuckyNumber: oldFace,
    });

    // Foresight feed — only on an actual pass↔fail flip (same gate + channel as
    // Divination). DL unknown → no emit (GM grants ZP manually, per design).
    const after = snapshotCheckResult(next.result);
    const flipped = outcomeFlippedOpenCheck(before, after, payload?.check?.dl);
    if (flipped) {
      emitCheckAdjusted({ actor, before, after, mechanism: "lucky_seven" });
    } else {
      console.log(`${TAG} Outcome unchanged; not emitting creature_check_adjusted.`, {
        dl: payload?.check?.dl ?? null, before, after,
      });
    }

    ui.notifications?.info(`Lucky Seven used. Your lucky number is now ${oldFace}.`);
  }

  // ---------------------------------------------------------------------------
  // Card injection / hydrate
  // ---------------------------------------------------------------------------
  const STYLE_ID = "oni-cr-luckyseven-style";
  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .oni-cr-luckyseven {
        display: grid;
        grid-template-columns: 1fr 1fr auto;
        gap: 6px;
        margin-top: 6px;
      }
      .oni-cr-luckyseven .oni-cr-btn-lucky {
        background: linear-gradient(180deg, #bfe6a8, #4e9c4e);
        border: 2px solid #2f6e2f;
        color: #fff;
        font-weight: 700;
        text-shadow: 0 1px 0 rgba(0,0,0,.3);
      }
      .oni-cr-luckyseven .oni-cr-btn-lucky:hover { filter: brightness(1.06); }
      .oni-cr-luckyseven .oni-cr-btn-pass {
        background: linear-gradient(180deg, #ddd, #b0b0b0);
        border: 2px solid #6b6b6b;
        color: #2a2a2a;
        font-weight: 600;
      }
      .oni-cr-luckyseven .oni-cr-btn-pass:hover { filter: brightness(1.05); }
      .oni-cr-luckyseven-passed { display: block; margin-top: 6px; }
      .oni-cr-luckyseven-passed .oni-cr-btn-passed {
        width: 100%;
        background: linear-gradient(180deg, #eaf5e0, #cfe6bf);
        border: 2px dashed #4e9c4e;
        color: #2f5e2f;
        font-style: italic;
        font-weight: 600;
        opacity: 0.85;
      }
      .oni-cr-luckyseven-passed .oni-cr-btn-passed:hover { opacity: 1; filter: brightness(1.03); }
    `;
    document.head.appendChild(style);
  }

  function buildLiveButtonsHtml(caster, payload) {
    const L = safeInt(caster.luckyNumber, 0);
    const rA = safeInt(payload?.result?.rollA, 0);
    const rB = safeInt(payload?.result?.rollB, 0);
    return `
      <div class="oni-cr-luckyseven" data-oni-luckyseven-state="live">
        <button type="button" class="oni-cr-btn oni-cr-btn-lucky"
                data-oni-cr-luckyseven data-oni-ls-die="A"
                title="Replace the first die (${rA}) with your lucky number (${L}). Spends Lucky Seven for this scene.">
          <span class="oni-cr-btn-label">🍀 First die: ${rA} → ${L}</span>
        </button>
        <button type="button" class="oni-cr-btn oni-cr-btn-lucky"
                data-oni-cr-luckyseven data-oni-ls-die="B"
                title="Replace the second die (${rB}) with your lucky number (${L}). Spends Lucky Seven for this scene.">
          <span class="oni-cr-btn-label">🍀 Second die: ${rB} → ${L}</span>
        </button>
        <button type="button" class="oni-cr-btn oni-cr-btn-pass"
                data-oni-cr-luckyseven-pass
                title="Skip Lucky Seven on this check (you can cancel later).">
          <span class="oni-cr-btn-label">Pass</span>
        </button>
      </div>
    `;
  }

  function buildPassedButtonHtml(actorName) {
    return `
      <div class="oni-cr-luckyseven-passed" data-oni-luckyseven-state="passed">
        <button type="button" class="oni-cr-btn oni-cr-btn-passed"
                data-oni-cr-luckyseven-cancelpass
                title="You chose not to use Lucky Seven here. Click to undo.">
          <span class="oni-cr-btn-label">✋ Passed (${esc(actorName)}) — click to cancel</span>
        </button>
      </div>
    `;
  }

  function findInjectionAnchor(rootEl) {
    return rootEl.querySelector(".oni-cr-divination")
      || rootEl.querySelector(".oni-cr-invoke")
      || rootEl.querySelector(".oni-cr-buttons")
      || rootEl.querySelector(".oni-cr-body")
      || rootEl.querySelector(".oni-cr-card");
  }

  function injectForViewer(rootEl, message, payload) {
    const existing = rootEl.querySelector(".oni-cr-luckyseven, .oni-cr-luckyseven-passed");
    if (existing) existing.remove();

    if (payload?.meta?.invoked?.luckySeven) return;
    if (isLockedByCritOrFumble(payload?.result)) return;

    const caster = findLuckyCasterForCheck(payload);
    if (!caster) return;

    const anchor = findInjectionAnchor(rootEl);
    if (!anchor) return;

    const html = hasPassed(message.id, caster.actor.id)
      ? buildPassedButtonHtml(caster.actor.name)
      : buildLiveButtonsHtml(caster, payload);

    if (anchor.classList.contains("oni-cr-card")) anchor.insertAdjacentHTML("beforeend", html);
    else anchor.insertAdjacentHTML("afterend", html);
  }

  function getMessageFromClick(ev) {
    const $btn = $(ev.currentTarget);
    const $card = $btn.closest(".oni-cr-card");
    const midFromCard = $card.attr("data-oni-cr-msgid");
    const midFromLi = $btn.closest("li.chat-message").attr("data-message-id");
    return game.messages.get(midFromCard || midFromLi || "") || null;
  }

  function rerenderBlock(rootEl, message) {
    const payload = getPayload(message);
    if (!payload) return;
    injectForViewer(rootEl, message, payload);
  }

  // ---------------------------------------------------------------------------
  // Click handlers
  // ---------------------------------------------------------------------------
  const onClickLucky = async (ev) => {
    try {
      ev.preventDefault();
      const msg = getMessageFromClick(ev);
      if (!msg || !isCheckRollerMessage(msg)) return;
      const which = safeStr($(ev.currentTarget).attr("data-oni-ls-die"), "A").toUpperCase() === "B" ? "B" : "A";
      await applyLuckySeven(msg, which);
    } catch (e) {
      console.warn(`${TAG} Lucky Seven click error`, e);
      ui.notifications?.error("Lucky Seven failed; see console.");
    }
  };

  const onClickPass = async (ev) => {
    try {
      ev.preventDefault();
      const msg = getMessageFromClick(ev);
      if (!msg) return;
      const caster = findLuckyCasterForCheck(getPayload(msg) || {});
      if (!caster) return;
      setPassed(msg.id, caster.actor.id, true);
      rerenderBlock(ev.currentTarget.closest("li.chat-message") || document, msg);
    } catch (e) { console.warn(`${TAG} Pass click error`, e); }
  };

  const onClickCancelPass = async (ev) => {
    try {
      ev.preventDefault();
      const msg = getMessageFromClick(ev);
      if (!msg) return;
      const caster = findLuckyCasterForCheck(getPayload(msg) || {});
      if (!caster) return;
      setPassed(msg.id, caster.actor.id, false);
      rerenderBlock(ev.currentTarget.closest("li.chat-message") || document, msg);
    } catch (e) { console.warn(`${TAG} Cancel-pass click error`, e); }
  };

  // ---------------------------------------------------------------------------
  // Hooks: render + reactive re-injection on AE / payload change
  // ---------------------------------------------------------------------------
  ensureStyles();

  Hooks.on("renderChatMessage", (message, html) => {
    try {
      if (!isCheckRollerMessage(message)) return;
      const root = (html instanceof jQuery) ? html[0] : html;
      if (!root) return;
      const payload = getPayload(message);
      if (!payload) return;
      injectForViewer(root, message, payload);
    } catch (e) { console.warn(`${TAG} hydrate error`, e); }
  });

  function refreshAllVisibleCards() {
    document.querySelectorAll("li.chat-message").forEach((li) => {
      const msgId = li.getAttribute("data-message-id");
      if (!msgId) return;
      const msg = game.messages.get(msgId);
      if (!msg || !isCheckRollerMessage(msg)) return;
      rerenderBlock(li, msg);
    });
  }

  let refreshScheduled = false;
  function scheduleRefresh() {
    if (refreshScheduled) return;
    refreshScheduled = true;
    requestAnimationFrame(() => {
      refreshScheduled = false;
      try { refreshAllVisibleCards(); } catch (e) { console.warn(`${TAG} refresh failed`, e); }
    });
  }

  function effectTouchesUs(effect) {
    const api = chargesApi();
    if (!api) return false;
    if (!api.isOwnedChargedEvent(effect)) return false;
    const info = api.read(effect);
    if (!info) return false;
    return !info.key || info.key === READY_KEY || info.key === STORE_KEY;
  }

  Hooks.on("createActiveEffect", (eff) => { if (effectTouchesUs(eff)) scheduleRefresh(); });
  Hooks.on("updateActiveEffect", (eff) => { if (effectTouchesUs(eff)) scheduleRefresh(); });
  Hooks.on("deleteActiveEffect", (eff) => { if (effectTouchesUs(eff)) scheduleRefresh(); });

  $(document).on("click.oni-cr-luckyseven", "[data-oni-cr-luckyseven]", onClickLucky);
  $(document).on("click.oni-cr-luckyseven", "[data-oni-cr-luckyseven-pass]", onClickPass);
  $(document).on("click.oni-cr-luckyseven", "[data-oni-cr-luckyseven-cancelpass]", onClickCancelPass);

  globalThis.ONI.__CheckRollerLuckySevenInstalled = true;
  console.debug(`${TAG} Installed.`);
})();
