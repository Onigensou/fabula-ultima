// ============================================================================
// BattleInit — Layout Engine (Step 5a) • Foundry VTT v12
// ----------------------------------------------------------------------------
// Purpose:
// - Computes token placement coordinates for Party (right side) + Enemies (left)
// - Supports enemy formation: "line" or "pyramid"
// - Stores results back into the SAME payload in the scene flag
//
// IMPORTANT:
// - This does NOT spawn tokens yet. It only writes payload.layout
//
// Your battle maps are gridless but have consistent dimensions:
// - Scene size: 1682 x 788
// - "Grid size" reference: 110 (for spacing assumptions)
// ============================================================================

(async () => {
  const DEBUG = false;

  // -----------------------------
  // TUNING (Enemy spacing)
  // - 1.00 = original spacing
  // - >1.00 = spread out more
  // - <1.00 = tighter
  // -----------------------------
  const ENEMY_SPREAD = 1.80;

 // Formation offsets (moves the WHOLE formation as a group)
  // +X = move right, -X = move left
  // +Y = move down,  -Y = move up
  //
  // Your request: move the PARTY formation down a tad bit ✅
  const PARTY_OFFSET_X = 0;
  const PARTY_OFFSET_Y = 22;

  const ENEMY_OFFSET_X = 0;
  const ENEMY_OFFSET_Y = 22;

  const PAYLOAD_SCOPE = "world";
  const PAYLOAD_KEY   = "battleInit.latestPayload";

  const tag = "[BattleInit:LayoutEngine:Step5a]";
  const log = (...a) => DEBUG && console.log(tag, ...a);

  // -----------------------------
  // 0) Helpers
  // -----------------------------
  const wait = (ms) => new Promise(r => setTimeout(r, ms));

  function clamp(n, min, max) {
    const x = Number(n);
    if (!Number.isFinite(x)) return min;
    return Math.max(min, Math.min(max, x));
  }

    function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function lerpPoint(p1, p2, t) {
    return { x: lerp(p1.x, p2.x, t), y: lerp(p1.y, p2.y, t) };
  }

  function offsetPoint(p, dx, dy) {
    return { x: p.x + dx, y: p.y + dy };
  }


  // Scales a line segment (A<->B) around its midpoint.
  // scale = 1.00 keeps it the same
  // scale > 1.00 stretches it (more spread)
  // scale < 1.00 shrinks it (tighter)
  function scaleSegmentAroundMidpoint(a, b, scale) {
    const mid = lerpPoint(a, b, 0.5);
    return {
      top: lerpPoint(mid, a, scale),
      bottom: lerpPoint(mid, b, scale)
    };
  }

  function distributeOnLine(top, bottom, count) {
    if (count <= 0) return [];
    if (count === 1) return [lerpPoint(top, bottom, 0.5)];
    const out = [];
    for (let i = 0; i < count; i++) {
      const t = i / (count - 1);
      out.push(lerpPoint(top, bottom, t));
    }
    return out;
  }

  function pickRandom(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  // Find payload even if it's stored on the exploration scene
  function findBattleInitPayloadForCurrentBattleScene() {
  const currentSceneId = canvas.scene?.id;
  if (!currentSceneId) return null;

  const currentSceneUuid = canvas.scene?.uuid ?? null;

  function payloadTargetsThisBattleScene(p) {
    const id =
      p?.step4?.battleScene?.id ??
      p?.step4?.battleSceneId ??
      p?.context?.battleSceneId ??
      null;

    const uuid =
      p?.step4?.battleScene?.uuid ??
      p?.context?.battleSceneUuid ??
      null;

    if (id && id === currentSceneId) return true;
    if (uuid && currentSceneUuid && uuid === currentSceneUuid) return true;
    return false;
  }

  function gateResolveOk(p) {
    return (p?.phases?.gate?.status === "ok") && (p?.phases?.resolve?.status === "ok");
  }

  // 1) Prefer payload stored on OTHER scenes that transitioned into THIS battle scene
  let best = null;

  for (const s of (game.scenes?.contents ?? [])) {
    const p = s.getFlag(PAYLOAD_SCOPE, PAYLOAD_KEY);
    if (!p) continue;
    if (!payloadTargetsThisBattleScene(p)) continue;

    const transitionedAt = Number(p?.step4?.transitionedAt ?? 0) || 0;
    const score = (gateResolveOk(p) ? 1_000_000_000 : 0) + transitionedAt;

    if (!best || score > best.score) best = { score, payload: p, sourceScene: s };
  }

  if (best) return { payload: best.payload, sourceScene: best.sourceScene };

  // 2) Fallback: current scene payload (could be stale, but better than nothing)
  const local = canvas.scene.getFlag(PAYLOAD_SCOPE, PAYLOAD_KEY);
  if (local) return { payload: local, sourceScene: canvas.scene };

  return null;
}

  // -----------------------------
  // 1) Guards + Load Payload
  // -----------------------------
  if (!game.user?.isGM) {
    ui.notifications?.warn?.("BattleInit: Step 5a is GM only.");
    return;
  }
  if (!canvas?.scene) {
    ui.notifications?.error?.("BattleInit: No active scene.");
    return;
  }

  const found = findBattleInitPayloadForCurrentBattleScene();
  if (!found) {
    ui.notifications?.error?.("BattleInit: No payload found for this battle scene. Run Step 1 → Step 4 first.");
    return;
  }

  const { payload, sourceScene } = found;
  log("Payload sourceScene =", { id: sourceScene.id, name: sourceScene.name });

  // Gate/Resolve safety (optional but recommended)
  const gateOk = (payload?.phases?.gate?.status === "ok");
  const resolveOk = (payload?.phases?.resolve?.status === "ok");
  if (!gateOk || !resolveOk) {
    ui.notifications?.error?.("BattleInit: Gate/Resolver not OK. Run Step 2 + Step 3 first.");
    log("Blocked:", { gate: payload?.phases?.gate, resolve: payload?.phases?.resolve });
    return;
  }

  // -----------------------------
  // 2) Inputs
  // -----------------------------
  // Party list (Step 1 already resolved/stored this)
  const partyMembers = (Array.isArray(payload?.party?.members) ? payload.party.members : [])
    .slice()
    .sort((a, b) => Number(a.slot ?? 99) - Number(b.slot ?? 99));

  // Resolved enemies from Step 3 (names only; may not resolve to Actor yet)
  const resolvedEnemies = Array.isArray(payload?.encounterResolved?.enemies) ? payload.encounterResolved.enemies : [];

  const enemyCount = resolvedEnemies.length;
  const partyCount = partyMembers.length;

  // Formation preference (if you later add a selector, put it here)
  // We will support:
  // - payload.encounterPlan.formationPreset: "line" | "pyramid" | "auto"
  // Fallback: "auto"
  const formationPreset = String(payload?.encounterPlan?.formationPreset ?? "auto").trim().toLowerCase();

   // -----------------------------
  // 3) Placement Anchors (CENTER points)
  // -----------------------------
  // These are the CENTER points you gave from your screenshot.

  // Party (right side) BASE points:
  const PARTY_TOP_BASE    = { x: 790,  y: 181 };
  const PARTY_BOTTOM_BASE = { x: 1082, y: 356 };

  // Apply formation offset (moves WHOLE PARTY formation)
  const PARTY_TOP    = offsetPoint(PARTY_TOP_BASE, PARTY_OFFSET_X, PARTY_OFFSET_Y);
  const PARTY_BOTTOM = offsetPoint(PARTY_BOTTOM_BASE, PARTY_OFFSET_X, PARTY_OFFSET_Y);

  // Enemies (left side) BASE points for LINE formation:
  const ENEMY_TOP_BASE    = { x: 336, y: 197 };
  const ENEMY_BOTTOM_BASE = { x: 274, y: 329 };

  // Apply formation offset (moves WHOLE ENEMY formation)
  const ENEMY_TOP    = offsetPoint(ENEMY_TOP_BASE, ENEMY_OFFSET_X, ENEMY_OFFSET_Y);
  const ENEMY_BOTTOM = offsetPoint(ENEMY_BOTTOM_BASE, ENEMY_OFFSET_X, ENEMY_OFFSET_Y);

  // Pyramid formation tuning
  // Front row is slightly more to the right (closer to party).
  // Apply ENEMY_OFFSET_X so pyramid shifts horizontally with the same tuner.
  const PYRAMID_FRONT_X = 320 + ENEMY_OFFSET_X;
  const PYRAMID_BACK_X  = 240 + ENEMY_OFFSET_X;

  // Vertical spacing (gridSize 110-ish, but tighter looks better)
  // We multiply by ENEMY_SPREAD so you can tune it from the top.
  const SPACING_Y = 85;
  const ENEMY_SPACING_Y = SPACING_Y * ENEMY_SPREAD;

  // Safety clamps (avoid going too low / too far right)
  // (These are conservative; adjust later if needed)
  const SAFE_Y_MIN = 140;
  const SAFE_Y_MAX = 420;
  const SAFE_X_MIN = 120;
  const SAFE_X_MAX = 1200;

  // -----------------------------
  // 4) Decide Enemy Formation
  // -----------------------------
  let enemyFormation = "line";
  if (formationPreset === "line" || formationPreset === "pyramid") {
    enemyFormation = formationPreset;
  } else {
    // auto
    enemyFormation = pickRandom(["line", "pyramid"]);
  }

  // If only 1 enemy, pyramid looks silly — force line
  if (enemyCount <= 1) enemyFormation = "line";

  // -----------------------------
  // 5) Compute PARTY positions (line)
  // -----------------------------
  const partyPoints = distributeOnLine(PARTY_TOP, PARTY_BOTTOM, partyCount)
    .map(p => ({
      x: clamp(p.x, SAFE_X_MIN, SAFE_X_MAX),
      y: clamp(p.y, SAFE_Y_MIN, SAFE_Y_MAX)
    }));

  const partyLayout = partyMembers.map((m, idx) => ({
    slot: m.slot,
    name: m.name,
    actorUuid: m.actorUuid,
    x: partyPoints[idx]?.x ?? PARTY_TOP.x,
    y: partyPoints[idx]?.y ?? PARTY_TOP.y
  }));

  // -----------------------------
  // 6) Compute ENEMY positions (line OR pyramid)
  // -----------------------------
  let enemyPoints = [];

    if (enemyFormation === "line") {
    const seg = scaleSegmentAroundMidpoint(ENEMY_TOP, ENEMY_BOTTOM, ENEMY_SPREAD);
    enemyPoints = distributeOnLine(seg.top, seg.bottom, enemyCount);
    } else {
    // Pyramid:
    // - Front row: ceil(N/2)
    // - Back row : floor(N/2)
    const frontCount = Math.ceil(enemyCount / 2);
    const backCount  = enemyCount - frontCount;

    // Center around the average of your enemy y range
    const centerY = Math.floor((ENEMY_TOP.y + ENEMY_BOTTOM.y) / 2);

    // Build front row points
    const frontYs = [];
    if (frontCount === 1) {
      frontYs.push(centerY);
    } else {
      const startY = centerY - Math.floor((frontCount - 1) * ENEMY_SPACING_Y / 2);
      for (let i = 0; i < frontCount; i++) frontYs.push(startY + i * ENEMY_SPACING_Y);
    }

    // Build back row points (slightly higher by half spacing so it forms a pyramid feel)
    const backYs = [];
    if (backCount === 1) {
      backYs.push(centerY - Math.floor(ENEMY_SPACING_Y / 2));
    } else if (backCount > 1) {
      const startY = centerY - Math.floor((backCount - 1) * ENEMY_SPACING_Y / 2) - Math.floor(ENEMY_SPACING_Y / 2);
      for (let i = 0; i < backCount; i++) backYs.push(startY + i * ENEMY_SPACING_Y);
    }

    // Combine: front row first (so index order is stable), then back row
    const pts = [];
    for (let i = 0; i < frontYs.length; i++) pts.push({ x: PYRAMID_FRONT_X, y: frontYs[i] });
    for (let i = 0; i < backYs.length; i++)  pts.push({ x: PYRAMID_BACK_X,  y: backYs[i] });

    enemyPoints = pts;
  }

  enemyPoints = enemyPoints.map(p => ({
    x: clamp(p.x, SAFE_X_MIN, SAFE_X_MAX),
    y: clamp(p.y, SAFE_Y_MIN, SAFE_Y_MAX)
  }));

  const enemyLayout = resolvedEnemies.map((e, idx) => ({
    index: idx + 1,
    name: e.name,
    x: enemyPoints[idx]?.x ?? ENEMY_TOP.x,
    y: enemyPoints[idx]?.y ?? ENEMY_TOP.y
  }));

  // -----------------------------
  // 7) Save to payload
  // -----------------------------
  payload.layout ??= {};
  payload.layout.step5a = {
    at: new Date().toISOString(),
    battleScene: { id: canvas.scene.id, name: canvas.scene.name, uuid: canvas.scene.uuid },
    formation: { preset: formationPreset, chosen: enemyFormation },
    party: partyLayout,
    enemies: enemyLayout
  };

  payload.phases ??= {};
  payload.phases.layout = {
    status: "ok",
    at: payload.layout.step5a.at,
    partyCount,
    enemyCount,
    formation: enemyFormation
  };

  // Write back to the scene that actually holds the payload
  await sourceScene.setFlag(PAYLOAD_SCOPE, PAYLOAD_KEY, payload);

  log("Layout saved:", payload.layout.step5a);
})();
