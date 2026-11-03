// Cost of one actor write as seen in a battle: update a party member's HP 6 times
// (each update re-prepares the actor and all its items), median ms.
const out = {};
for (const name of ["Hina", "Keren", "Blanche", "Zarg"]) {
  const a = game.actors.getName(name); if (!a) continue;
  const hp = Number(a.system.props.current_hp ?? 0);
  const ms = [];
  for (let i = 0; i < 6; i++) {
    const t = performance.now();
    await a.update({ "system.props.current_hp": hp - 1 - (i % 2) });
    ms.push(performance.now() - t);
  }
  await a.update({ "system.props.current_hp": hp });
  ms.sort((x, y) => x - y);
  out[name] = { items: a.items.size, medianMs: Math.round(ms[3]), minMs: Math.round(ms[0]) };
}
return out;
