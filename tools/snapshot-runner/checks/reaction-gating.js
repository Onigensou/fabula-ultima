// Reaction gating (2026-11-04): action-blocking debuffs + Suppressed.
// For each actor × scenario, apply the real Debuff-hub AEs (Suppressed gets the
// `disable_passive` marker here, as the world migration will add it), then run
// getReactionGate over every reaction row on the actor's items and report what
// is blocked ("blocked" = dimmed, "condition" = silently suppressed). Also runs
// findPassiveCandidates once per scenario as an integration probe.
const se = await import("/modules/fabula-ultima-companion/scripts/battle-director/skill-effects.js");
const ACTORS = ["Zarg", "Hina", "Keren", "Blanche", "Pyro Gorger", "⭐️ Fafnir", "⭐️ Rauben"];
const SCEN = {
  none: [],
  Paralyzed: ["Paralyzed"],
  Frightened: ["Frightened"],
  Silence: ["Silence"],
  Disarmed: ["Disarmed"],
  Panic: ["Panic"],
  Berserk: ["Berserk"],
  Suppressed: ["Suppressed"],
  "Paralyzed+Domination": ["Paralyzed", "Domination State"],
  "Suppressed+Domination": ["Suppressed", "Domination State"],
};
// Source AEs: the Debuff hub first, then anything named so.
const src = {};
const hub = game.items.getName("Debuff");
for (const ae of hub?.effects ?? []) src[ae.name] = ae.toObject();
for (const it of game.items) for (const ae of it.effects) if (!src[ae.name]) src[ae.name] = ae.toObject();
for (const a of game.actors) for (const ae of a.effects) if (!src[ae.name]) src[ae.name] = ae.toObject();
const missing = [...new Set(Object.values(SCEN).flat())].filter((n) => !src[n]);
const aeData = (name) => {
  const d = foundry.utils.deepClone(src[name]);
  delete d._id; d.disabled = false; d.transfer = false;
  if (name === "Suppressed" && !(d.changes ?? []).some((c) => c.key === "disable_passive")) {
    d.changes = [...(d.changes ?? []), { key: "disable_passive", value: "1", mode: 5, priority: 0 }];
  }
  return d;
};
const out = { missing, actors: {} };
for (const name of ACTORS) {
  const actor = game.actors.getName(name);
  if (!actor) { out.actors[name] = "MISSING"; continue; }
  const rows = [];
  for (const item of actor.items) {
    const rc = item.system?.props?.reaction_config_table;
    if (!rc || typeof rc !== "object") continue;
    for (const [k, row] of Object.entries(rc)) {
      if (!row || row.$deleted || !String(row.reaction_trigger ?? "").trim()) continue;
      rows.push({ item, k, row });
    }
  }
  const res = { kind: (await import("/modules/fabula-ultima-companion/scripts/battle-director/actor-shape.js")).getActorKind(actor), scen: {} };
  for (const [sname, aes] of Object.entries(SCEN)) {
    const created = aes.length ? await actor.createEmbeddedDocuments("ActiveEffect", aes.filter((n) => src[n]).map(aeData)) : [];
    const blocked = [], hidden = [];
    for (const { item, k, row } of rows) {
      const g = se.getReactionGate(actor, {
        carrier: item, carrierKind: "item", row,
        effectTable: item.system?.props?.effect_table ?? {},
        refLabel: String(row.reaction_effect_ref ?? "").trim(),
      });
      if (!g) continue;
      const tag = `${item.name}#${k}(${String(row.reaction_passive_mode || "ask")})←${g.reason}`;
      (g.kind === "blocked" ? blocked : hidden).push(tag);
    }
    // Integration: a couple of common triggers through the real scan.
    const probe = {};
    for (const trig of ["creature_performs_action", "creature_hit_by_action", "creature_will_deal_damage", "turn_start"]) {
      try {
        const c = await se.findPassiveCandidates({ casterActor: actor, trigger: trig, includeUnavailable: true, payload: { sourceActorUuid: actor.uuid, actionKind: "Attack" } });
        const g = c.filter((x) => x.unavailableKind === "blocked" || (x.unavailableKind === "condition" && /Suppress|Paraly|Fright|Silence|Disarm|Panic|Berserk/.test(x.unavailableReason ?? "")));
        if (g.length) probe[trig] = g.map((x) => `${x.carrierName}:${x.unavailableKind}:${x.unavailableReason}`);
      } catch (e) { probe[trig] = "THREW " + e.message; }
    }
    if (created.length) await actor.deleteEmbeddedDocuments("ActiveEffect", created.map((e) => e.id));
    res.scen[sname] = { blocked, hidden, probe };
  }
  out.actors[name] = res;
}
return out;
