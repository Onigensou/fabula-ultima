/**
 * move-engine Phase 4: apply SKILL BLOCKS (tools/move-engine/moves/<family>/skills.js, resolved by `move-engine export`) to the
 * world. One code path for both uses:
 *   dryRun: true   → only report what differs (the `export --check` round trip runs this in the snapshot runner)
 *   dryRun: false  → write it (an export migration calls this)
 * A block's LOGIC fields only: system.props keys it names, the effect_table / reaction_config_table rows (a table it names is
 * replaced whole: an update MERGES objects, so the old row keys are deleted explicitly), the module flags it names, and the
 * embedded Active Effects it names (`aes: [{ name, changes, transfer }]`, matched by name; other AEs are left alone).
 * Every copy: the world item by id, plus actor / unlinked-token copies by name (and parent weapon name when `doc.container`).
 * Text, art and animation fields are not touched.
 */
const M = "fabula-ultima-companion";
const TABLES = { effects: "effect_table", reactions: "reaction_config_table" };
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const rowsOf = (t) => Object.keys(t ?? {}).filter((k) => t[k] && typeof t[k] === "object").sort((a, b) => Number(a) - Number(b)).map((k) => t[k]);

function copiesOf(block) {
  const out = []; const w = game.items.get(block.doc.id); if (w) out.push(w);
  const parentName = block.doc.container ? game.items.get(block.doc.container)?.name ?? null : null;
  const embedded = (items) => { for (const it of items) { if (it.name !== block.doc.name) continue;
    if (parentName) { const c = it.system?.container; if (c && it.parent?.items?.get?.(c)?.name !== parentName) continue; } out.push(it); } };
  for (const a of game.actors) embedded(a.items);
  for (const s of game.scenes) for (const t of s.tokens) if (!t.actorLink && t.actor) embedded(t.actor.items);
  return out;
}

// the differences between one item and a block (empty = identical in every logic field the block names)
export function diffSkill(item, block) {
  const p = item.system?.props ?? {}, diffs = [];
  for (const [k, v] of Object.entries(block.props ?? {})) if (!same(p[k], v)) diffs.push({ field: "props." + k, game: p[k] ?? null, block: v });
  for (const [key, table] of Object.entries(TABLES)) {
    if (!(key in block)) continue;
    const have = rowsOf(p[table]), want = block[key] ?? [];
    if (have.length !== want.length) diffs.push({ field: table + " (rows)", game: have.length, block: want.length });
    for (let i = 0; i < Math.max(have.length, want.length); i++) {
      const h = have[i] ?? {}, w = want[i] ?? {};
      for (const f of new Set([...Object.keys(h), ...Object.keys(w)])) {
        const hv = h[f], wv = w[f];
        if (wv === undefined && (hv === "" || hv === null || hv === undefined || hv === false)) continue;   // an empty cell the block does not name
        if (!same(hv, wv)) diffs.push({ field: table + "[" + i + "]." + f, game: hv ?? null, block: wv ?? null });
      }
    }
  }
  for (const [k, v] of Object.entries(block.flags ?? {})) if (!same(item.flags?.[M]?.[k], v)) diffs.push({ field: "flags." + k, game: item.flags?.[M]?.[k] ?? null, block: v });
  // embedded Active Effects the block names (by name): their changes (key / mode / value / priority) and transfer.
  // Other AEs on the item are not touched.
  for (const want of block.aes ?? []) {
    const ae = item.effects?.find?.((e) => e.name === want.name);
    if (!ae) { diffs.push({ field: "ae " + want.name, game: null, block: "(create)" }); continue; }
    const norm = (chs) => (chs ?? []).map((c) => ({ key: c.key, mode: Number(c.mode ?? 0), value: String(c.value ?? ""), priority: c.priority == null ? null : Number(c.priority) }));
    if (!same(norm(ae.changes), norm(want.changes))) diffs.push({ field: "ae " + want.name + ".changes", game: norm(ae.changes), block: norm(want.changes) });
    if (want.transfer != null && !!ae.transfer !== !!want.transfer) diffs.push({ field: "ae " + want.name + ".transfer", game: !!ae.transfer, block: !!want.transfer });
  }
  return diffs;
}
async function applyAes(item, block) {
  for (const want of block.aes ?? []) {
    const data = { name: want.name, changes: want.changes, transfer: want.transfer ?? true, disabled: false, ...(want.img ? { img: want.img } : {}) };
    const ae = item.effects?.find?.((e) => e.name === want.name);
    if (ae) await ae.update({ changes: data.changes, transfer: data.transfer }); else await item.createEmbeddedDocuments("ActiveEffect", [data]);
  }
}

function patchFor(item, block) {
  const patch = {}; const p = item.system?.props ?? {};
  for (const [k, v] of Object.entries(block.props ?? {})) patch["system.props." + k] = v;
  for (const [key, table] of Object.entries(TABLES)) {
    if (!(key in block)) continue;
    for (const old of Object.keys(p[table] ?? {})) patch["system.props." + table + ".-=" + old] = null;
    (block[key] ?? []).forEach((row, i) => { patch["system.props." + table + "." + i] = row; });
  }
  for (const [k, v] of Object.entries(block.flags ?? {})) patch["flags." + M + "." + k] = v;
  return patch;
}

// blocks: resolved skill blocks ({ doc, props, effects, reactions, flags }). Returns { results: [{ name, copies: [{ id, parent, diffs }] }] }
export async function applySkills(game, blocks, { dryRun = true, log = () => {} } = {}) {
  const results = [];
  for (const block of blocks) {
    const copies = copiesOf(block), res = { name: block.doc.name, id: block.doc.id, found: copies.length, copies: [] };
    if (!copies.length) { log(`! ${block.doc.name} (${block.doc.id}) not in the world`); results.push(res); continue; }
    for (const it of copies) {
      const diffs = diffSkill(it, block);
      res.copies.push({ id: it.id, parent: it.parent?.name ?? null, diffs });
      if (!diffs.length) { log(`= ${it.parent ? it.parent.name + " / " : ""}${it.name} matches`); continue; }
      if (dryRun) { log(`~ ${it.parent ? it.parent.name + " / " : ""}${it.name}: ${diffs.length} field(s) differ`); continue; }
      // a table rewrite: delete the old row keys first, then write the rows (one update with both would merge)
      const p = patchFor(it, block), dels = Object.fromEntries(Object.entries(p).filter(([k]) => k.includes(".-="))), sets = Object.fromEntries(Object.entries(p).filter(([k]) => !k.includes(".-=")));
      if (Object.keys(dels).length) await it.update(dels);
      if (Object.keys(sets).length) await it.update(sets);
      if ((block.aes ?? []).length) await applyAes(it, block);
      log(`~ ${it.parent ? it.parent.name + " / " : ""}${it.name}: ${diffs.length} field(s) written`);
    }
    results.push(res);
  }
  return { results };
}
