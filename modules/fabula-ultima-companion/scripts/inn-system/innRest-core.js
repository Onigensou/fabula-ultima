// scripts/inn-system/innRest-core.js
// Innkeeper → Rest / Short Rest. The operator's client shows the offer; the
// PRIMARY GM re-checks everything, charges, and runs it:
//   short → CampSystem.RestAPI.shortRest()
//   rest  → teleport the party token into the lobby's linked camp scene
//           (flags.<module>.campSceneUuid). That teleport is what records the
//           camp's Set Out return point (camp-set-out.js, teleporter.crossScene).
import { INN, isInnActor, planCharge, applyCharge } from "./innOpen-const.js";
import { showInnPrompt } from "./innRest-panel.js";

const isPrimaryGM = () => globalThis.FUCompanion?.isPrimaryGM?.() ?? false;

async function resolveParty() {
  const CAMP = globalThis.CampSystem;
  const members = (await CAMP?.RestAPI?.getPartyActors?.()) ?? [];
  const res = await globalThis.FUCompanion?.api?.getCurrentGameDb?.();
  const coffer = res?.db ?? null;
  const partyIds = [res?.db?.id, res?.source?.id].filter(Boolean);
  return { members, coffer, partyIds };
}

function campSceneFor(scene) {
  const raw = scene?.getFlag?.(INN.MODULE_ID, "campSceneUuid") ?? "";
  const id  = String(raw).trim().replace(/^Scene\./, "");
  const camp = id ? game.scenes.get(id) : null;
  return camp?.flags?.[INN.MODULE_ID]?.oniFabula?.general?.sceneMode === "camp" ? camp : null;
}

// flags.<module>.campArrival {x, y} (scene px, token centre) on the camp twin;
// else its Initial View point; else its centre.
function arrivalSpot(scene) {
  const a = scene?.flags?.[INN.MODULE_ID]?.campArrival;
  if (Number.isFinite(a?.x) && Number.isFinite(a?.y)) return { x: a.x, y: a.y };
  const i = scene?.initial;
  if (Number.isFinite(i?.x) && Number.isFinite(i?.y)) return { x: i.x, y: i.y };
  const d = scene?.dimensions;
  return { x: Math.round((d?.width ?? scene?.width ?? 0) / 2), y: Math.round((d?.height ?? scene?.height ?? 0) / 2) };
}

// ── Operator side ─────────────────────────────────────────────────────────
export async function openInn(innToken) {
  const scene = innToken?.document?.parent ?? canvas?.scene;
  const { members, coffer } = await resolveParty();
  const plan = planCharge(members, coffer);
  const choice = await showInnPrompt({
    innName: innToken?.document?.name || innToken?.actor?.name || "Innkeeper",
    plan,
    hasRoom: !!campSceneFor(scene),
  });
  if (!choice) return;

  const payload = { mode: choice, sceneId: scene?.id, innTokenId: innToken.id, userId: game.user.id };
  if (isPrimaryGM()) await execute(payload);
  else game.socket.emit(INN.SOCKET_CH, { type: INN.MSG.REQ, payload });
}

// ── Primary GM side ───────────────────────────────────────────────────────
let _busy = false;

function reply(userId, ok, message) {
  const payload = { userId, ok, message };
  game.socket.emit(INN.SOCKET_CH, { type: INN.MSG.RESULT, payload });
  onResult(payload);   // the GM's own client does not receive its emit
}

function onResult({ userId, ok, message } = {}) {
  if (userId !== game.user?.id || ok || !message) return;
  ui.notifications?.warn?.(message);
}

export async function execute({ mode, sceneId, innTokenId, userId } = {}) {
  if (!isPrimaryGM() || _busy) return;
  _busy = true;
  try {
    const scene  = game.scenes.get(sceneId);
    const innTok = scene?.tokens?.get(innTokenId);
    if (!innTok?.actor || !isInnActor(innTok.actor)) return reply(userId, false, "That is not an innkeeper.");
    if (mode !== "rest" && mode !== "short")         return reply(userId, false, "Unknown inn request.");

    const campScene = mode === "rest" ? campSceneFor(scene) : null;
    if (mode === "rest" && !campScene) {
      return reply(userId, false, "This inn has no room set up (Scene Config → Linked Camp Scene UUID).");
    }

    const { members, coffer, partyIds } = await resolveParty();
    let partyTok = null;
    if (mode === "rest") {
      partyTok = scene.tokens.find(t => partyIds.includes(t.actorId)) ?? null;
      if (!partyTok) return reply(userId, false, "The party token is not on this map.");
    }

    // Re-plan on the GM: the operator's quote may be stale.
    const plan = planCharge(members, coffer);
    if (!plan.ok) return reply(userId, false, plan.reason);
    await applyCharge(plan, coffer);
    try { await globalThis.FUCompanion?.api?.syncPartySheet?.(); } catch {}
    console.log(INN.TAG, `${mode === "rest" ? "Rest" : "Short Rest"} at ${innTok.name}: ${plan.total}z`
      + (plan.cofferNeed ? ` (${plan.cofferNeed}z from the party coffer)` : ""));

    if (mode === "short") {
      await globalThis.CampSystem?.RestAPI?.shortRest?.();
    } else {
      const TP = globalThis.TeleporterSystem?.api;
      if (!TP?.executeCrossSceneTeleport) throw new Error("TeleporterSystem unavailable");
      const spot = arrivalSpot(campScene);
      await TP.executeCrossSceneTeleport(partyTok.actorId, scene.id, campScene.id, spot.x, spot.y);
    }
    reply(userId, true, "");
  } catch (e) {
    console.error(INN.TAG, "execute failed:", e);
    reply(userId, false, `The inn could not serve you: ${e.message}`);
  } finally {
    _busy = false;
  }
}

export function installSocket() {
  game.socket.on(INN.SOCKET_CH, (msg) => {
    const { type, payload } = msg ?? {};
    if (type === INN.MSG.REQ)    { if (isPrimaryGM()) execute(payload); return; }
    if (type === INN.MSG.RESULT) { onResult(payload); }
  });
}
