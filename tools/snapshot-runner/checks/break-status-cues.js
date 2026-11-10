// Armor Break / Magic Break token cue (status-cues.js): the word DEF / MDEF + a bobbing down arrow beside the
// chest, orange = DEF, blue = M.DEF, stacked when both are held, gone when removed.
// Runner only: fakes "a battle is running" through the scene's directorState flag
// (battle-focus.js battleHere), creates a token and toggles the statuses.
const NS = "fabula-ultima-companion";
const out = { errors: [] };
const scene = canvas.scene;
const waitFor = async (fn, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); } return fn(); };
const chips = (tok) => {
  const root = document.getElementById("fu-status-cue-root");
  return [...(root?.querySelectorAll(".fu-cue .brk") ?? [])].map((e) => {
    const box = e.parentElement.getBoundingClientRect(), wb = e.querySelector("b")?.getBoundingClientRect(), ab = e.querySelector("i")?.getBoundingClientRect();
    return { cls: e.className, word: e.querySelector("b")?.textContent, left: e.style.left, right: e.style.right, top: e.style.top, size: e.style.getPropertyValue("--c"),
      display: getComputedStyle(e).display, font: getComputedStyle(e.querySelector("b")).fontFamily,
      arrowRightOfWord: !!(wb && ab && ab.left >= wb.right - 1 && Math.abs((ab.top + ab.bottom) / 2 - (wb.top + wb.bottom) / 2) < wb.height * 0.5),
      outsideFrame: !!(wb && (wb.left >= box.right - box.width * 0.07 || wb.right <= box.left + box.width * 0.07)),
      wordW: Math.round(wb?.width ?? 0), wordH: Math.round(wb?.height ?? 0) };
  });
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
  // Rakshasa's Crippled (its own item AE, not a CONFIG status) draws the same DEF word; with
  // Armor Break also held it still draws ONE DEF word.
  const [crip] = await a.createEmbeddedDocuments("ActiveEffect", [{ name: "Crippled", statuses: ["crippled"], system: { tags: ["cleansable", "rakshasa_debuff", "debuff"] },
    changes: [{ key: "defense", mode: 1, value: "0.5", priority: 50 }], flags: { [NS]: { roundUp: ["defense"] } } }]);
  await new Promise((r) => setTimeout(r, 300)); out.crippled = chips();
  await toggle("ArmrBreakStatId1", true); out.crippledPlusArmor = chips();
  await toggle("ArmrBreakStatId1", false); await crip.delete(); await new Promise((r) => setTimeout(r, 300)); out.crippledCleared = chips();
  out.cuesApi =FUCompanion.api.statusCues ? [...FUCompanion.api.statusCues.cuesOf(a)] : "no api";
  await tok.delete();
  await scene.unsetFlag(NS, "directorState");
} catch (e) { out.errors.push(e.message); }
return out;
