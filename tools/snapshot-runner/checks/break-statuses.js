// Armor Break / Magic Break (2026-11-10): DEF / M.DEF x0.75 rounded up, 3 bearer turns,
// `debuff` tag. Exercises the real paths: CONFIG.statusEffects entry (module code), CSB ->
// Convenient Effects template resolution (token-menu toggle), csb-ae-round-up, stacking
// with Slow / Dazed and a Barrier-style upgrade, the BD canonical-template + apply_ae
// lookup, the classifier, the cleanse selector, condition affinity (null: no column yet)
// and the action-card chip. Runner only (writes AEs + a token).
const MOD = "/modules/fabula-ultima-companion/scripts/battle-director/";
const SE = await import(MOD + "skill-effects.js");
const SC = await import(MOD + "status-classifier.js");
const AC = await import(MOD + "action-card.js");
const NS = "fabula-ultima-companion";
const IDS = { armor: "ArmrBreakStatId1", magic: "MagcBreakStatId1" };
const P = (a) => ({ def: a.system.props.defense, mdef: a.system.props.magic_defense });
const out = { errors: [] };
// toggleStatusEffect (CSB -> Convenient Effects) creates the AE AFTER it returns: poll for it.
const waitFor = async (fn, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); } return fn(); };
const toggle = async (a, id, on) => { await a.toggleStatusEffect(id, { active: on });
  return waitFor(() => { const e = a.effects.find((x) => x.statuses.has(id)); return on ? e : (e ? null : true); }); };
const safe = async (label, fn) => { try { return await fn(); } catch (e) { out.errors.push(`${label}: ${e.message}`); return null; } };

out.config = CONFIG.statusEffects.filter((s) => Object.values(IDS).includes(s.id))
  .map((s) => ({ id: s.id, name: s.name, img: String(s.img).split("/").pop(), linked: s.linkedEffectId }));
out.configCount = CONFIG.statusEffects.length;
out.containers = {};
for (const n of ["Armor Break", "Magic Break"]) {
  out.containers[n] = game.items.filter((i) => i.type === "activeEffectContainer")
    .flatMap((i) => i.effects.filter((e) => e.name === n).map((e) => `${i.name}:${e.id}`));
}
for (const [k, id] of Object.entries(IDS)) {
  const t = SE.resolveCanonicalConditionTemplate([id]);
  out[`canon_${k}`] = t ? { name: t.name, changes: t.changes, flags: t.flags?.[NS], tags: t.system?.tags } : null;
}

const slowId = CONFIG.statusEffects.find((s) => s.name === "Slow")?.id;
const dazedId = CONFIG.statusEffects.find((s) => s.name === "Dazed")?.id;
out.pcs = {};
for (const n of ["Hina", "Keren", "Blanche", "Zarg"]) {
  const a = game.actors.getName(n);
  if (!a) { out.errors.push(`no actor ${n}`); continue; }
  const r = { base: P(a) };
  await safe(`${n} armor`, async () => {
    const ae = await toggle(a, IDS.armor, true);
    r.armor = { ae: ae?.name, img: String(ae?.img).split("/").pop(), charges: ae?.flags?.[NS]?.charges, lifetime: ae?.flags?.[NS]?.lifetimeMode,
      ...P(a), tier: SC.classifyEffect(ae), affinity: SE.getConditionAffinityFor(a, { statuses: [...ae.statuses], name: ae.name }) };
    if (slowId) { await toggle(a, slowId, true); r.armor.withSlow = P(a).def; await toggle(a, slowId, false); }
    const [bar] = await a.createEmbeddedDocuments("ActiveEffect", [{ name: "Barrier Test", changes: [{ key: "defense", mode: 4, value: "12", priority: 20 }] }]);
    r.armor.withBarrier12 = P(a).def; await bar.delete();
    r.armor.cleanseSees = (SE.selectAEsOnActor(a, { filterTag: "debuff", where: "remove_tagged_ae" }) ?? []).map((e) => e.name ?? e);
    await toggle(a, IDS.armor, false);
    r.armor.after = P(a);
  });
  await safe(`${n} magic`, async () => {
    const ae = await toggle(a, IDS.magic, true);
    r.magic = { ae: ae?.name, img: String(ae?.img).split("/").pop(), ...P(a), tier: SC.classifyEffect(ae) };
    if (dazedId) { await toggle(a, dazedId, true); r.magic.withDazed = P(a).mdef; await toggle(a, dazedId, false); }
    await toggle(a, IDS.magic, false);
    r.magic.after = P(a);
  });
  out.pcs[n] = r;
}

// Battle Director apply_ae by bare template name (how a skill will apply it).
await safe("bd apply_ae", async () => {
  const blanche = game.actors.getName("Blanche");
  const zarg = game.actors.getName("Zarg");
  const scene = canvas.scene;
  const td = await blanche.getTokenDocument({ x: 1000, y: 1000 });
  const [tok] = await scene.createEmbeddedDocuments("Token", [td.toObject()]);
  const target = tok.actor;
  const before = P(target);
  const ctx = { casterActor: zarg, payload: { _capturedTargets: { t: [tok.uuid] } }, sourceUuid: zarg.uuid, skill: null };
  const res = await SE.applyEffectRow({ effect_kind: "apply_ae", effect_label: "test_ab", ae_template_ref: "Armor Break",
    target_ref: "t", ae_duplicate_mode: "replace" }, ctx);
  const ae = target.effects.find((e) => e.name === "Armor Break");
  out.bdApply = { ok: res?.ok ?? res, reason: res?.reason ?? null, before, after: P(target), ae: !!ae,
    charges: ae?.flags?.[NS]?.charges, lifetime: ae?.flags?.[NS]?.lifetimeMode ?? ae?.flags?.[NS]?.directorAppliedBy?.lifetimeMode,
    appliedBy: ae?.flags?.[NS]?.directorAppliedBy ?? null, statuses: ae ? [...ae.statuses] : null };
  // 3 of the bearer's turns, then gone.
  out.bdApply.ticks = [];
  for (let i = 0; i < 3; i++) {
    await SE.tickDirectorAEsForBearerTurnEnd(target.uuid);
    const e = target.effects.find((x) => x.name === "Armor Break");
    out.bdApply.ticks.push(e ? { charges: e.flags?.[NS]?.charges, def: P(target).def } : { gone: true, def: P(target).def });
  }
  await tok.delete();
});

// Action-card chip for a linked status in a description.
await safe("chip", async () => {
  const html = await TextEditor.enrichHTML(
    "<p>Inflict @UUID[JournalEntry.ArmrBreakStatus1]{Armor Break} and @UUID[JournalEntry.MagcBreakStatus1]{Magic Break}.</p>", { async: true });
  const parsed = AC.parseEffectDescription(html);
  out.chip = JSON.parse(JSON.stringify(parsed, (k, v) => (typeof v === "string" && v.length > 300 ? v.slice(0, 300) + "…" : v)));
});
return out;
