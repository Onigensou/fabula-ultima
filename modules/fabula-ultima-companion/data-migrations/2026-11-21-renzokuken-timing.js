/**
 * Migration: 2026-11-21-renzokuken-timing  (Renzokuken gauge = the mockup's timing)
 * ---------------------------------------------------------------------------
 * User call 2026-11-21 ("mockup exactly"): the trigger gauge runs at the
 * approved mockup's numbers: 460 ms per sweep, 70 ms between sweeps, 380 ms
 * lead-in (zone 70-92 % unchanged). 2026-11-21-lionheart (v1.0.650) wrote
 * gauge_sweep_ms "650" on the Renzokuken timed_strikes row and no gap, so the
 * engine default (260) applied. This rewrites that row on every copy: the
 * world item and any actor / unlinked-token copy.
 *
 * Only rows still on the shipped value (650, or blank) change; a hand-tuned
 * row is left alone. Idempotent: a second run finds nothing to do.
 */

export const key = "2026-11-21-renzokuken-timing";
export const description = "Renzokuken trigger gauge uses the approved mockup's timing (460 ms sweep, 70 ms gap).";

const SWEEP = "460";
const GAP = "70";
const SHIPPED = new Set(["", "650"]);

function allItems() {
  const items = [...game.items];
  for (const a of game.actors) items.push(...a.items);
  for (const s of game.scenes) for (const t of s.tokens) if (!t.actorLink && t.actor) items.push(...t.actor.items);
  return items;
}

export async function migrate(game, log = () => {}) {
  const out = [];
  let n = 0;
  for (const it of allItems()) {
    const tbl = it.system?.props?.effect_table;
    if (!tbl || typeof tbl !== "object") continue;
    const upd = {};
    for (const [k, row] of Object.entries(tbl)) {
      if (row?.effect_kind !== "timed_strikes" || String(row.gauge_title ?? "") !== "Renzokuken") continue;
      const sweep = String(row.gauge_sweep_ms ?? "").trim();
      const gap = String(row.gauge_gap_ms ?? "").trim();
      if (SHIPPED.has(sweep) && sweep !== SWEEP) upd[`system.props.effect_table.${k}.gauge_sweep_ms`] = SWEEP;
      if (gap === "" || gap === "260") { if (gap !== GAP) upd[`system.props.effect_table.${k}.gauge_gap_ms`] = GAP; }
    }
    if (!Object.keys(upd).length) continue;
    await it.update(upd);
    n++;
    out.push(`~ ${it.parent ? `${it.parent.name} / ` : ""}${it.name} (${it.id})`);
  }
  if (!n) out.push("= Renzokuken timing already set");
  for (const l of out) log(l);
  return { applied: true, summary: out.join(" | ") };
}
