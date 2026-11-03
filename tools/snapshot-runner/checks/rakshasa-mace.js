// Rakshasa's Mace, as the monster really uses it (NPC Attack path): Crippled lands on a HIT
// only, and halves DEF on the PCs it hits. Runner only (the DEF check writes an AE).
const scene = canvas.scene;
const tok = (n) => scene.tokens.find((t) => t.actor?.name === n);
const rTok = tok("Rakshasa");
const mace = rTok.actor.items.find((i) => i.name === "Mace");
const T = FUCompanion.api.test;
const summary = (s) => ({ ok: s?.ok ?? null, err: s?.error ?? s?.reason ?? null, aeCreates: (s?.captures?.aeCreates ?? []).map((a) => `${a.name}@${a.parentName}`),
  hit: (s?.passes?.[0]?.actionResult ?? s?.passes?.[0]?.compute?.actionResult)?.hitTokenUuids?.length ?? s?.hitsOnTargets ?? null,
  hp: Object.fromEntries((s?.perActorWrites ?? []).map((w) => [w.actorName, w.propPatches?.["system.props.current_hp"]]).filter(([, v]) => v !== undefined)) });
const out = { effect: mace.effects.contents.map((e) => ({ name: e.name, changes: e.changes, tags: e.system?.tags })), runs: {} };
for (const target of ["Keren", "Blanche", "Test Target Enemy"]) {
  const tt = tok(target);
  for (const [label, force] of [["hit", { rA: 9, rB: 8 }], ["miss", { rA: 2, rB: 3 }]]) {
    try {
      const s = await T.runDirectorAttackSimulate({ attackerTokenUuid: rTok.uuid, targetTokenUuids: [tt.uuid], mode: "npc", npcAttackItemUuid: mace.uuid, force });
      out.runs[`${target} ${label}`] = summary(s);
    } catch (e) { out.runs[`${target} ${label}`] = { threw: e.message }; }
  }
  // DEF with Crippled, for real on the token actor (the stand-in server accepts it)
  const a = tt.actor; const before = a.system.props.defense;
  const data = mace.effects.contents[0].toObject(); delete data._id; data.origin = mace.uuid;
  const [ae] = await a.createEmbeddedDocuments("ActiveEffect", [data]);
  const withC = a.system.props.defense; await ae.delete();
  out[`DEF ${target}`] = { before, withCrippled: withC, type: typeof withC, after: a.system.props.defense };
}
return out;
