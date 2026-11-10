// Armor Break / Magic Break token cue (status-cues.js): a cracked-cuirass silhouette + down arrow beside the
// chest, orange = DEF, blue = M.DEF, stacked when both are held, gone when removed.
// Runner only: fakes "a battle is running" through the scene's directorState flag
// (battle-focus.js battleHere), creates a token and toggles the statuses.
const NS = "fabula-ultima-companion";
const out = { errors: [] };
const scene = canvas.scene;
const waitFor = async (fn, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); } return fn(); };
const chips = (tok) => {
  const root = document.getElementById("fu-status-cue-root");
  return [...(root?.querySelectorAll(".fu-cue .brk") ?? [])].map((e) => ({ cls: e.className, left: e.style.left, top: e.style.top, size: e.style.getPropertyValue("--c") }));
};
try {
  await scene.setFlag(NS, "directorState", { dCombat: { started: true, ended: false, combatants: [{ id: "x" }] } });
  out.battle = await waitFor(() => FUCompanion.api.statusCues && document.getElementById("fu-status-cue-root") !== undefined) && true;
  const a = game.actors.getName("Blanche");
  const td = await a.getTokenDocument({ x: 1200, y: 900 });
  const [tok] = await scene.createEmbeddedDocuments("Token", [td.toObject()]);
  await waitFor(() => tok.object);
  const toggle = async (id, on) => { await a.toggleStatusEffect(id, { active: on });
    await waitFor(() => { const e = a.effects.find((x) => x.statuses.has(id)); return on ? e : !e; }); await new Promise((r) => setTimeout(r, 150)); };
  out.none = chips();
  await toggle("ArmrBreakStatId1", true);  out.armor = chips();
  await toggle("MagcBreakStatId1", true);  out.both = chips();
  await toggle("ArmrBreakStatId1", false); out.magicOnly = chips();
  await toggle("MagcBreakStatId1", false); out.cleared = chips();
  out.cuesApi = FUCompanion.api.statusCues ? [...FUCompanion.api.statusCues.cuesOf(a)] : "no api";
  await tok.delete();
  await scene.unsetFlag(NS, "directorState");
} catch (e) { out.errors.push(e.message); }
return out;
