// ============================================================================
// BattleInit — Unleash Detector (Step 7) v2 DEBUG • Foundry VTT v12
// ----------------------------------------------------------------------------
// Fix goals:
// - Always show "macro ran" feedback (toast + console)
// - Pull enemy tokens from payload.spawn.step5b.enemyTokenIds
// - Fallback: find tokens on the current scene that were spawned by Step 5b
//   (Token flag: token.getFlag("world","battleInit").role === "enemy")
// - Scan enemy actor.system.props.special_list / other_list for "Unleash"
// - Post results to chat with pacing + optional SFX
// ============================================================================

(async () => {
  const DEBUG = false;

  const PAYLOAD_SCOPE = "world";
  const PAYLOAD_KEY   = "battleInit.latestPayload";

  // SFX (optional)
  const UNLEASH_SFX_URL = "";   // leave "" to disable sound
  const UNLEASH_SFX_VOL = 0.8;

  // pacing
  const INITIAL_DELAY_MS = 500;
  const BETWEEN_POST_MS  = 1500;

  const tag = "[BattleInit:UnleashDetector:Step7]";
  const log = (...a) => DEBUG && console.log(tag, ...a);
  const warn = (...a) => console.warn(tag, ...a);
  const error = (...a) => console.error(tag, ...a);

  // HARD proof macro ran:
  log("RUNNING ✅", { user: game.user?.name, isGM: game.user?.isGM, scene: canvas.scene?.name });

  const { getProperty } = foundry.utils;

  // -----------------------------
  // Helpers
  // -----------------------------
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const nowIso = () => new Date().toISOString();

  function uniq(arr) {
    return [...new Set((arr ?? []).filter(Boolean))];
  }

  function escapeHtml(str) {
    const s = String(str ?? "");
    return s
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

      function htmlToText(html) {
    let raw = String(html ?? "").trim();
    if (!raw) return "";

    // 1) Convert common "block" / "break" tags into newlines BEFORE stripping tags
    //    This preserves formatting like:
    //    Unleash
    //    Scaldra perform Swift Chomp.
    raw = raw
      // <br> becomes newline
      .replace(/<br\s*\/?>/gi, "\n")
      // Closing block tags become newline
      .replace(/<\/(p|div|li|tr|h1|h2|h3|h4|h5|h6)>/gi, "\n")
      // Opening list tags (optional spacing)
      .replace(/<(ul|ol)>/gi, "\n")
      .replace(/<\/(ul|ol)>/gi, "\n");

    // 2) Strip remaining tags safely by using DOM parsing
    const div = document.createElement("div");
    div.innerHTML = raw;

    let text = div.textContent || div.innerText || "";

    // 3) Normalize whitespace
    text = text.replace(/\r/g, "");
    // collapse trailing spaces on each line
    text = text.split("\n").map(l => l.trimEnd()).join("\n");
    // collapse too many blank lines
    text = text.replace(/\n{3,}/g, "\n\n");

    return text.trim();
  }

      function renderSkill(nameKey, skillObj, ownerName) {
    const skillName = skillObj?.[nameKey] || "Unknown Skill";

    // Convert HTML description into readable plain text
    const detailsTextRaw = htmlToText(skillObj?.details);

    // Build "bullet style" like your sheet:
    // • Unleash
    //   Scaldra perform Swift Chomp.
    const lines = String(detailsTextRaw ?? "")
      .split("\n")
      .map(l => l.trim())
      .filter(l => l.length > 0);

    let detailsBulleted = "";
    if (!lines.length) {
      detailsBulleted = "(no details)";
    } else if (lines.length === 1) {
      detailsBulleted = `• ${lines[0]}`;
    } else {
      const first = `• ${lines[0]}`;
      const rest  = lines.slice(1).map(l => `  ${l}`).join("\n"); // indent like the sheet
      detailsBulleted = `${first}\n${rest}`;
    }

    return `
      <div style="padding:10px 12px; border:1px solid var(--color-border-light-primary); border-radius:10px;">
        <div style="font-weight:900; font-size:16px;">${escapeHtml(skillName)}</div>
        <div style="margin-top:4px; opacity:0.85;"><strong>Owner:</strong> ${escapeHtml(ownerName)}</div>

        <div style="margin-top:8px; padding-left:10px; border-left:3px solid var(--color-border-light-primary); opacity:0.95; white-space:pre-wrap;">
          ${escapeHtml(detailsBulleted)}
        </div>
      </div>
    `;
  }

  async function playSfx() {
    const src = String(UNLEASH_SFX_URL ?? "").trim();
    if (!src) return;
    try {
      await AudioHelper.play({ src, volume: UNLEASH_SFX_VOL, autoplay: true, loop: false }, true);
    } catch (e) {
      warn("SFX failed (non-fatal):", e);
    }
  }

  async function postQueue(queue) {
    await wait(INITIAL_DELAY_MS);

    for (const html of queue) {
      await playSfx();
      await ChatMessage.create({
        content: html,
        speaker: ChatMessage.getSpeaker({ alias: "BattleInit" })
      });
      await wait(BETWEEN_POST_MS);
    }
  }

  function findBattleInitPayloadForThisBattleScene() {
    const currentSceneId = canvas.scene?.id;
    if (!currentSceneId) return null;

    // 1) current scene
    const local = canvas.scene.getFlag(PAYLOAD_SCOPE, PAYLOAD_KEY);
    if (local) return { payload: local, sourceScene: canvas.scene, from: "current-scene" };

    // 2) search other scenes that "own" the payload
    for (const s of (game.scenes?.contents ?? [])) {
      const p = s.getFlag(PAYLOAD_SCOPE, PAYLOAD_KEY);
      if (!p) continue;

      const transitionedBattleId =
        p?.step4?.battleScene?.id ??
        p?.step4?.battleSceneId ??
        p?.layout?.step5a?.battleScene?.id ??
        null;

      if (transitionedBattleId && transitionedBattleId === currentSceneId) {
        return { payload: p, sourceScene: s, from: "scene-search" };
      }
    }
    return null;
  }

  // -----------------------------
  // Guards
  // -----------------------------
  if (!game.user?.isGM) {
    ui.notifications?.warn?.("BattleInit Step 7: GM only.");
    warn("ABORT: not GM");
    return;
  }
  if (!canvas?.scene) {
    ui.notifications?.error?.("BattleInit Step 7: No active scene.");
    error("ABORT: no canvas.scene");
    return;
  }

  // -----------------------------
  // Load Payload
  // -----------------------------
  const found = findBattleInitPayloadForThisBattleScene();
  if (!found) {
    ui.notifications?.error?.("BattleInit Step 7: No payload found. Run Step 1–6 first.");
    error("ABORT: payload not found");
    return;
  }

  const { payload, sourceScene, from } = found;
  log("Payload found ✅", { from, sourceScene: { id: sourceScene.id, name: sourceScene.name } });

  const spawnInfo = payload?.spawn?.step5b;
  if (!spawnInfo) {
    ui.notifications?.error?.("BattleInit Step 7: Missing payload.spawn.step5b. Run Step 5b first.");
    error("ABORT: spawnInfo missing", payload?.spawn);
    return;
  }

  const runId = String(payload?.meta?.runId ?? spawnInfo?.runId ?? "").trim();
  log("runId =", runId || "(missing)");

  // -----------------------------
  // Enemy token selection (payload first, fallback to token flags)
  // -----------------------------
  const enemyTokenIdsFromPayload = uniq(spawnInfo.enemyTokenIds);
  log("enemyTokenIdsFromPayload =", enemyTokenIdsFromPayload);

  const sceneTokenDocs = canvas.scene.tokens?.contents ?? [];

  let enemyTokenDocs = [];

  if (enemyTokenIdsFromPayload.length) {
    enemyTokenDocs = enemyTokenIdsFromPayload
      .map(id => sceneTokenDocs.find(t => t.id === id))
      .filter(Boolean);
    log("Enemy tokens resolved from payload IDs =", enemyTokenDocs.map(t => ({ id: t.id, name: t.name })));
  }

  // Fallback: find tokens spawned by Step 5b flags on THIS scene
  if (!enemyTokenDocs.length) {
    const flagged = sceneTokenDocs.filter(t => {
      const f = t.getFlag("world", "battleInit");
      if (!f) return false;
      if (f.role !== "enemy") return false;
      // if runId exists, match it; if not, accept
      if (runId && f.runId && String(f.runId) !== runId) return false;
      return true;
    });

    enemyTokenDocs = flagged;
    log("Enemy tokens resolved by flag fallback =", enemyTokenDocs.map(t => ({ id: t.id, name: t.name })));
  }

  if (!enemyTokenDocs.length) {
    ui.notifications?.warn?.("BattleInit Step 7: No enemy tokens found on this scene (payload + fallback).");
    warn("ABORT: no enemy tokens. Are you on the battle battle scene?");
    return;
  }

  // -----------------------------
  // Scan for Unleash skills
  // -----------------------------
  const chatQueue = [];
  const warnings = [];

  for (const tokDoc of enemyTokenDocs) {
    const enemyActor = tokDoc.actor;
    if (!enemyActor) {
      warnings.push(`Enemy token "${tokDoc.name}" has no actor.`);
      continue;
    }

    const specialList = getProperty(enemyActor, "system.props.special_list") ?? [];
    const otherList   = getProperty(enemyActor, "system.props.other_list") ?? [];

    // scan first 10 entries from each list
    for (let i = 0; i < 10; i++) {
      const skill = specialList[i];
      if (skill?.details?.includes?.("Unleash")) {
        chatQueue.push(renderSkill("special_name", skill, enemyActor.name));
      }
    }
    for (let i = 0; i < 10; i++) {
      const skill = otherList[i];
      if (skill?.details?.includes?.("Unleash")) {
        chatQueue.push(renderSkill("other_name", skill, enemyActor.name));
      }
    }
  }

  log("Scan complete:", { enemies: enemyTokenDocs.length, found: chatQueue.length, warnings });

  // -----------------------------
  // Save to payload
  // -----------------------------
  payload.unleash ??= {};
  payload.unleash.step7 = {
    at: nowIso(),
    runId: runId || null,
    enemyTokenIds: enemyTokenDocs.map(t => t.id),
    enemyCount: enemyTokenDocs.length,
    found: chatQueue.length,
    warnings,
    status: chatQueue.length ? "ok" : "none"
  };

  payload.phases ??= {};
  payload.phases.unleash = {
    status: chatQueue.length ? "ok" : "none",
    at: payload.unleash.step7.at,
    found: chatQueue.length
  };

  await sourceScene.setFlag(PAYLOAD_SCOPE, PAYLOAD_KEY, payload);
  log("Saved payload.unleash.step7 ✅", payload.unleash.step7);

  // -----------------------------
  // Post results
  // -----------------------------
    if (!chatQueue.length) {
    // (Removed: confirmation toast)
    if (warnings.length) warn("Warnings:", warnings);

    // (Removed: optional chat marker)

    return;
  }

  if (warnings.length) warn("Warnings:", warnings);

  await postQueue(chatQueue);
})();
