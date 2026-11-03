// A template layout edit must reach an instance after reloadTemplate, through the shared
// build cache: item path (instance with no layout of its own -> master build) and actor
// path (own layout -> content-keyed build). Mirrors CSB's saveTemplate: new body + new version.
const findComp = (node, type) => {
  if (!node || typeof node !== "object") return null;
  if (node.type === type && node.key) return node;
  for (const v of Object.values(node)) { const r = Array.isArray(v) ? v.map((x) => findComp(x, type)).find(Boolean) : findComp(v, type); if (r) return r; }
  return null;
};
async function probe(instance, template, label) {
  const KEY = `fu_cache_probe_${label}`;
  const before = Object.keys(instance.templateSystem.componentMap).includes(KEY);
  const body = foundry.utils.deepClone(template.system.body);
  const proto = findComp(body, "textField") ?? findComp(body, "label");
  if (!proto) return { label, error: "no textField/label in template body" };
  const comp = { ...foundry.utils.deepClone(proto), key: KEY };
  body.contents = [...(body.contents ?? []), comp];
  await template.update({ system: { body, templateSystemUniqueVersion: (Math.random() * 0x100000000) >>> 0 } });
  const stillOldBeforeReload = !Object.keys(instance.templateSystem.componentMap).includes(KEY);
  await instance.templateSystem.reloadTemplate();
  const after = Object.keys(instance.templateSystem.componentMap).includes(KEY);
  return { label, instance: instance.name, template: template.name, compType: comp.type, before, stillOldBeforeReload, after,
    instanceBodyEmpty: !(instance.system.body?.contents?.length) };
}
const out = {};
// item path: an embedded item whose own layout is blank (dedup) and whose master resolves
const hina = game.actors.getName("Hina");
const inst = hina.items.find((i) => i.system?.template && !(i.system.body?.contents?.length) && game.items.get(i.system.template));
out.item = inst ? await probe(inst, game.items.get(inst.system.template), "item") : "no dedup item found";
// actor path: a character with its own layout copy
const actor = game.actors.find((a) => a.type === "character" && a.system?.template && a.system.body?.contents?.length && game.actors.get(a.system.template) && a.name !== "Hina");
out.actor = actor ? await probe(actor, game.actors.get(actor.system.template), "actor") : "no actor found";
out.tree = { ...globalThis.__fuLayoutTreeCache.stats, size: globalThis.__fuLayoutTreeCache.size };
return out;
