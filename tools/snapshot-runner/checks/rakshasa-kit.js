// Rakshasa's whole kit: stances spent, MP spent / recovered, Devour heals, Bleed / Crippled
// on a hit only, Crippled scene-long with DEF rounded up. Runner only (writes go to the
// stand-in server). Profile: --profile rakshasa (Rakshasa + Keren + Blanche + the dummy).
const T = FUCompanion.api.test;
const scene = canvas.scene;
const tok = (n) => scene.tokens.find((t) => t.actor?.name === n);
const rTok = tok("Rakshasa"), rak = rTok.actor;
const item = (n) => rak.items.find((i) => i.name === n);
// stance / combo AE data, as Form Shift (Dual) carry them
const stanceData = (name) => {
  for (const i of rak.items) for (const e of i.effects) if (e.name === name) { const d = e.toObject(); delete d._id; return d; }
  throw new Error(`no stance AE "${name}"`);
};
const mpWrite = (s) => s?.perActorWrites?.find((w) => w.actorName === "Rakshasa")?.propPatches?.["system.props.current_mp"];
const hpWrite = (s, who) => s?.perActorWrites?.find((w) => w.actorName === who)?.propPatches?.["system.props.current_hp"];
const sum = (s) => ({
  ok: s?.ok ?? null, err: s?.error ?? s?.reason ?? s?.resolveError ?? null,
  hit: (s?.passes?.[0]?.actionResult)?.hitTokenUuids?.length ?? null,
  created: (s?.captures?.aeCreates ?? []).map((a) => `${a.name}@${a.parentName}${a.flags?.["fabula-ultima-companion"]?.charges != null ? `(charges ${a.flags["fabula-ultima-companion"].charges})` : "(no counter)"}`),
  deleted: (s?.captures?.aeDeletes ?? []).map((d) => `${d.name ?? d.effectName ?? (d.names ?? d.ids ?? []).join("+") ?? "?"}@${d.parentName ?? d.actorName ?? ""}` + (d.name || d.effectName || d.names ? "" : ` ${JSON.stringify(d).slice(0, 120)}`)),
  mp: mpWrite(s) ?? null,
});
await rak.update({ "system.props.current_mp": 40 });
const out = { mpStart: rak.system.props.current_mp, hpStart: rak.system.props.current_hp, max_mp: rak.system.props.max_mp };
const atk = async (name, stance, target, dice) => sum(await T.runDirectorAttackSimulate({
  attackerTokenUuid: rTok.uuid, targetTokenUuids: [tok(target).uuid], mode: "npc", npcAttackItemUuid: item(name).uuid, force: dice,
  preApply: [{ targetActorUuid: rak.uuid, data: stanceData(stance) }],
}));
const HIT = { rA: 9, rB: 8 }, MISS = { rA: 2, rB: 3 };
out.attacks = {
  "Saber hit": await atk("Saber", "Sword Stance", "Keren", HIT),
  "Mace hit": await atk("Mace", "Flail Stance", "Keren", HIT),
  "Mace miss": await atk("Mace", "Flail Stance", "Keren", MISS),
  "Chakram hit": await atk("Chakram", "Throwing Stance", "Blanche", HIT),
  "Chakram miss": await atk("Chakram", "Throwing Stance", "Blanche", MISS),
  "Rain of Arrows hit": await atk("Rain of Arrows", "Bow Stance", "Keren", HIT),
  "Executioner's Volley hit": await atk("Executioner's Volley", "Sword and Bow Stance", "Keren", HIT),
  "Rending Orbit hit": await atk("Rending Orbit", "Flail and Throwing Stance", "Blanche", HIT),
  "Rending Orbit miss": await atk("Rending Orbit", "Flail and Throwing Stance", "Blanche", MISS),
  "Severing Verdict hit": await atk("Severing Verdict", "Sword and Flail Stance", "Keren", HIT),
};
await rak.update({ "system.props.current_mp": 10 });
out.mpBeforeSkills = rak.system.props.current_mp;
const skill = async (name, target, preApply = []) => {
  const s = await T.runDirectorSkillSimulate({ skillUuid: item(name).uuid, casterTokenUuid: rTok.uuid, targetTokenUuids: [tok(target).uuid], force: { rA: 9, rB: 8 }, preApply });
  return { ...sum(s), rakHp: hpWrite(s, "Rakshasa") ?? null, targetHp: hpWrite(s, target) ?? null };
};
out.skills = {
  "Form Shift (from no stance)": await skill("Form Shift", "Rakshasa"),
  "Form Shift (from Flail)": await skill("Form Shift", "Rakshasa", [{ targetActorUuid: rak.uuid, data: stanceData("Flail Stance") }]),
  "Form Shift (Dual) (from Bow)": await skill("Form Shift (Dual)", "Rakshasa", [{ targetActorUuid: rak.uuid, data: stanceData("Bow Stance") }]),
  "Devour": await skill("Devour", "Keren"),
};
// Crippled for real on the token actors (the stand-in server accepts the write)
const cripple = item("Mace").effects.contents[0].toObject(); delete cripple._id; cripple.origin = item("Mace").uuid;
out.crippledTemplate = { changes: cripple.changes, roundUp: cripple.flags?.["fabula-ultima-companion"]?.roundUp ?? null, tags: cripple.system?.tags };
for (const n of ["Keren", "Blanche", "Test Target Enemy"]) {
  const a = tok(n).actor; const before = a.system.props.defense;
  const [ae] = await a.createEmbeddedDocuments("ActiveEffect", [cripple]);
  const withC = a.system.props.defense, temporary = ae.isTemporary;
  // with another AE on `defense` too (review question): Flying +2 (mode 2) and a Barrier (upgrade to 12)
  const combos = {};
  for (const [label, ch] of [["Flying +2", { key: "defense", mode: 2, value: "2", priority: 20 }], ["Barrier 12", { key: "defense", mode: 4, value: "12", priority: 20 }]]) {
    const [x] = await a.createEmbeddedDocuments("ActiveEffect", [{ name: label, changes: [ch] }]);
    combos[label] = a.system.props.defense; await x.delete();
  }
  await ae.delete();
  out[`DEF ${n}`] = { before, withCrippled: withC, tokenIcon: temporary, combos, after: a.system.props.defense };
}
// Crippled stacked with the other AEs that change `defense` directly (Flying +2, Barrier upgrade 12)
const combos = { Flying: { mode: 2, value: "2" }, Barrier: { mode: 4, value: "12" } };
for (const n of ["Keren", "Blanche", "Test Target Enemy"]) for (const [cn, ch] of Object.entries(combos)) {
  const a = tok(n).actor;
  const [o] = await a.createEmbeddedDocuments("ActiveEffect", [{ name: `${cn} test`, changes: [{ key: "defense", priority: 20, ...ch }] }]);
  const withOther = a.system.props.defense;
  const [c] = await a.createEmbeddedDocuments("ActiveEffect", [cripple]);
  const both = a.system.props.defense; const temp = c.isTemporary;
  await c.delete(); await o.delete();
  out[`combo ${n} + ${cn}`] = { withOther, withCrippled: both, crippledIsTemporary: temp, after: a.system.props.defense };
}
return out;
