// formation.js — where battle units stand. Pure geometry, no Foundry.
//
// Everything works in the director's 1682x788 reference stage (the same space
// computeLayout's anchors are written in); the caller scales in and out with the
// scene's stage rect. A unit is { key, w, h, lw, lh, rank, kind, caster }:
//   w/h    drawn sprite size (texture "contain"-fitted into the token box × scale)
//   lw/lh  its name label at the feet (0 = no label: PCs have a HUD card instead)
//   rank   npc_rank ("elite" / "champion" make a boss)
//   kind   "enemy" | "pc" | "guest" | "summon"
//   caster key of the PC that summoned it (party side), optional
//
// Enemy side: one picker per fight (proposal agreed 2026-10-27, mockup v26):
//   override → an elite or champion with adds → C (two columns, boss back-middle)
//            → B (one diagonal, spaced by size) if it fits clean
//            → B×2 (two diagonals; 5 = three in front + two behind in the gaps)
//            → C.
//   A joiner extends B, else takes a free spot touching no one, else everyone
//   re-forms and the picker runs again (Hybrid).
// Party side: Support row. PCs keep the tuned diagonal; every guest and summon
// stands behind it in a gap of the PC line (summons nearest their caster).
//
// The one rule both sides obey: no label sits on another unit's body or label,
// and no two sprites pile more than a tenth onto each other.

export const REF_W = 1682, REF_H = 788;
// A sprite taller than this (Fafnir at ×5 is ~825) has hand-tuned placement; callers skip the planner.
export const GIANT_H = 400;
const LAB_GAP = 2, LAB_SIDE = 6, STEP_GAP = 10, MARGIN = 16;
export const LIFT = 0.5;  // back-row lift: 0 = straight sideways from a gap, 1 = right angle to the slant

// Enemy zone + today's enemy line (director-init computeLayout, ENEMY_SPREAD applied).
const Z = { x0: 80, x1: 660, y0: 90, y1: 776 };
const E0 = { x: 360.8, y: 226.2 }, E1 = { x: 249.2, y: 463.8 };
const BACK_X = 265, FRONT_X = 478, ZIG = 22;
const SLOPE = (E1.x - E0.x) / (E1.y - E0.y), LANE_GAP = FRONT_X - BACK_X;

// Party diagonal (user-tuned 2026-05-29) and the action card column it keeps clear of.
export const P0 = { x: 1202, y: 162 }, P1 = { x: 1367, y: 492 };
const CARD_X1 = 1001;

// ── geometry ─────────────────────────────────────────────────────────────
// Body = the drawn frame minus 12% each side and 6% off the top (transparent margins).
export function body(u, p) {
  const ix = u.w * 0.12;
  return { x0: p.x - u.w / 2 + ix, x1: p.x + u.w / 2 - ix, y0: p.y - u.h / 2 + u.h * 0.06, y1: p.y + u.h / 2 };
}
export function labelRect(u, p) {
  if (!(u.lw > 0 && u.lh > 0)) return null;
  const y = p.y + u.h / 2 + LAB_GAP;
  return { x0: p.x - u.lw / 2, x1: p.x + u.lw / 2, y0: y, y1: y + u.lh };
}
const hit = (a, b) => !!a && !!b && a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
const pad = (r, g) => r && { x0: r.x0 - g, x1: r.x1 + g, y0: r.y0, y1: r.y1 };
function pile(a, b) {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  if (w <= 0 || h <= 0) return false;
  return w * h > 0.10 * Math.min((a.x1 - a.x0) * (a.y1 - a.y0), (b.x1 - b.x0) * (b.y1 - b.y0));
}
// Clashes between two placed units. PC-on-PC overlap is the tuned party look and never counts.
export function pairClashes(a, pa, b, pb) {
  if (a.kind === "pc" && b.kind === "pc") return 0;
  let n = 0;
  const la = labelRect(a, pa), lb = labelRect(b, pb), ba = body(a, pa), bb = body(b, pb);
  if (hit(la, bb)) n++;
  if (hit(lb, ba)) n++;
  if (hit(pad(la, LAB_SIDE), lb)) n++;
  if (pile(ba, bb)) n++;
  return n;
}
export function clashes(units, pos) {
  let n = 0;
  for (let i = 0; i < units.length; i++) for (let j = i + 1; j < units.length; j++) {
    n += pairClashes(units[i], pos[units[i].key], units[j], pos[units[j].key]);
  }
  return n;
}
function bbox(units, pos) {
  const b = { x0: 1e9, x1: -1e9, y0: 1e9, y1: -1e9 };
  for (const u of units) {
    const p = pos[u.key], s = body(u, p), l = labelRect(u, p);
    b.x0 = Math.min(b.x0, s.x0, l ? l.x0 : 1e9); b.x1 = Math.max(b.x1, s.x1, l ? l.x1 : -1e9);
    b.y0 = Math.min(b.y0, p.y - u.h / 2); b.y1 = Math.max(b.y1, l ? l.y1 : s.y1);
  }
  return b;
}
function fitsClean(units, pos) {
  const b = bbox(units, pos);
  return clashes(units, pos) === 0 && b.y1 <= REF_H && b.y0 >= 0;
}

// ── enemy formations ─────────────────────────────────────────────────────
// B · today's diagonal, each step only as long as the clearance rule needs.
function line(units) {
  const dx = E1.x - E0.x, dy = E1.y - E0.y, L = Math.hypot(dx, dy), ux = dx / L, uy = dy / L, pos = {};
  units.forEach((u, i) => {
    let p = { x: 0, y: 0 };
    if (i) {
      const q = pos[units[i - 1].key];
      for (let t = 10; t < 900; t += 2) {
        p = { x: q.x + ux * t, y: q.y + uy * t };
        if (units.slice(0, i).every((v) => pairClashes(v, pos[v.key], u, p) === 0)) break;
      }
    }
    pos[u.key] = p;
  });
  return centre(units, pos, 305);
}
function centre(units, pos, cx) {
  const b = bbox(units, pos);
  const mx = units.reduce((s, u) => s + pos[u.key].x, 0) / units.length;
  let oy = (Z.y0 + Z.y1) / 2 - (b.y0 + b.y1) / 2;
  if (b.y0 + oy < Z.y0 && b.y1 - b.y0 <= Z.y1 - Z.y0) oy = Z.y0 - b.y0;
  const out = {};
  for (const u of units) out[u.key] = { x: pos[u.key].x + cx - mx, y: pos[u.key].y + oy };
  return out;
}
// C · two columns. Biggest first, each unit joins the shorter column, the biggest sits mid.
function columns(units) {
  const sorted = units.slice().sort((a, b) => b.h - a.h), cols = { back: [], front: [] }, hgt = { back: 0, front: 0 };
  sorted.forEach((u, i) => {
    const c = i === 0 ? "back" : (hgt.back <= hgt.front ? "back" : "front");
    cols[c].push(u); hgt[c] += u.h + LAB_GAP + u.lh + STEP_GAP;
  });
  const pos = {}, room = Z.y1 - Z.y0;
  for (const c of ["back", "front"]) {
    const mid = [];
    cols[c].forEach((u, i) => { if (i % 2) mid.push(u); else mid.unshift(u); });
    const total = hgt[c] - STEP_GAP, squeeze = total > room ? (room - total) / Math.max(1, mid.length - 1) : 0;
    let y = Z.y0 + Math.max(0, (room - total) / 2);
    mid.forEach((u, k) => {
      const base = c === "back" ? BACK_X : FRONT_X, zig = (k % 2 ? 1 : -1) * (c === "back" ? -ZIG : ZIG);
      pos[u.key] = { x: base - Math.max(0, u.w - 110) * 0.3 + zig, y: y + u.h / 2 };
      y += u.h + LAB_GAP + u.lh + STEP_GAP + squeeze;
    });
  }
  return pos;
}
// B×2 · two of B's diagonals. Bigger units behind; front gets ceil(n/2). With one fewer
// behind, each back unit starts midway between two front neighbours and steps back.
function twoLines(units) {
  const sorted = units.slice().sort((a, b) => b.h - a.h), nb = Math.floor(units.length / 2);
  const order = (list) => list.sort((a, b) => units.indexOf(a) - units.indexOf(b));
  const back = order(sorted.slice(0, nb)), front = order(sorted.slice(nb)), inter = front.length > back.length;
  const need = (lane) => {
    let p = 0;
    for (let i = 1; i < lane.length; i++) p = Math.max(p, lane[i].h * 0.94 + LAB_GAP + lane[i - 1].lh + STEP_GAP);
    return p;
  };
  const P = Math.max(need(front), need(back), 1), cx = FRONT_X - 20, pos = {};
  front.forEach((u, k) => { pos[u.key] = { y: k * P - u.h / 2 }; });
  back.forEach((u, k) => { pos[u.key] = { y: (k + (inter ? 0.5 : 0)) * P - u.h / 2 }; });
  let top = 1e9, bot = -1e9;
  for (const u of units) { const y = pos[u.key].y; top = Math.min(top, y - u.h / 2); bot = Math.max(bot, y + u.h / 2 + LAB_GAP + u.lh); }
  const my = (Z.y0 + Z.y1) / 2, dy = my - (top + bot) / 2;
  for (const u of front) { const y = pos[u.key].y + dy; pos[u.key] = { x: cx + (y - my) * SLOPE, y }; }
  const ys = {};
  for (const u of back) ys[u.key] = pos[u.key].y + dy;
  const vl = Math.hypot(SLOPE, 1), vx = SLOPE / vl, vy = 1 / vl, px = -vy, py = vx;
  const place = (d) => back.forEach((u, k) => {
    if (inter) {
      const a = pos[front[k].key], b = pos[front[k + 1].key], mx = (a.x + b.x) / 2, mY = (a.y + b.y) / 2;
      pos[u.key] = { x: mx + (1 - LIFT) * -d + LIFT * px * d, y: mY + LIFT * py * d };
    } else pos[u.key] = { x: cx - d + (ys[u.key] - my) * SLOPE, y: ys[u.key] };
  });
  let g = LANE_GAP;
  if (inter) {
    for (let t = 40; t <= LANE_GAP + 60; t += 4) { place(t); if (clashes(units, pos) === 0) { g = t + MARGIN; break; } }
  }
  place(g);
  return pos;
}
const isBoss = (u) => u.rank === "elite" || u.rank === "champion";

/** Positions for a whole enemy group. mode: "auto" | "line" | "columns". */
export function planEnemies(units, { mode = "auto" } = {}) {
  if (!units.length) return { pos: {}, pick: "none", why: "no enemies" };
  if (mode === "line") return { pos: line(units), pick: "B", why: "encounter override" };
  if (mode === "columns") return { pos: columns(units), pick: "C", why: "encounter override" };
  if (units.length > 1 && units.some(isBoss)) return { pos: columns(units), pick: "C", why: "an elite or champion with adds" };
  const b = line(units);
  if (fitsClean(units, b)) return { pos: b, pick: "B", why: `all ${units.length} fit on one diagonal` };
  const l = twoLines(units);
  if (fitsClean(units, l)) return { pos: l, pick: "B×2", why: "too many for one diagonal" };
  return { pos: columns(units), pick: "C", why: "two diagonals would not fit" };
}

// Closest free spot to `ideal` whose body touches no one and that clashes with nothing.
function cleanSpot(placed, pos, u, ideal) {
  let best = null, bs = Infinity;
  for (let x = Z.x0 + u.w / 2; x <= Z.x1 - u.w / 2; x += 8) {
    for (let y = Z.y0 + u.h / 2; y <= Z.y1 - u.h / 2 - u.lh; y += 8) {
      const p = { x, y };
      let bad = false;
      for (const v of placed) {
        if (pairClashes(v, pos[v.key], u, p) || hit(body(v, pos[v.key]), body(u, p))) { bad = true; break; }
      }
      if (bad) continue;
      const s = (x - ideal.x) ** 2 + (y - ideal.y) ** 2;
      if (s < bs) { bs = s; best = p; }
    }
  }
  return best;
}

/**
 * An enemy joining a live fight. `placed` keep their spots unless nothing fits.
 * anchor (optional) = the caster-front point of a summon; the joiner then stays as
 * close to it as it can and the group never re-forms.
 * Returns { pos: {key: p} for the joiner only, or for everyone when reform: true }.
 */
export function planEnemyJoin(placed, current, u, { anchor = null } = {}) {
  if (anchor) {
    // No clean spot → pos null, and the caller keeps its own caster-front fan.
    const p = cleanSpot(placed, current, u, anchor);
    return { pos: { [u.key]: p }, reform: false, why: p ? "nearest clean spot to its caster" : "no clean spot near its caster" };
  }
  const base = planEnemies(placed);
  if (base.pick === "B") {
    const sorted = placed.slice().sort((a, b) => current[a.key].y - current[b.key].y);
    const last = current[sorted[sorted.length - 1].key];
    const dx = E1.x - E0.x, dy = E1.y - E0.y, L = Math.hypot(dx, dy);
    for (let t = 10; t < 900; t += 2) {
      const p = { x: last.x + dx / L * t, y: last.y + dy / L * t };
      if (placed.every((v) => pairClashes(v, current[v.key], u, p) === 0)) {
        const all = { ...current, [u.key]: p };
        if (fitsClean([...placed, u], all)) return { pos: { [u.key]: p }, reform: false, why: "extends the line" };
        break;
      }
    }
  }
  const ideal = columns([...placed, u])[u.key];
  const q = cleanSpot(placed, current, u, ideal);
  if (q && q.y + u.h / 2 + u.lh <= REF_H) return { pos: { [u.key]: q }, reform: false, why: "a clean free spot" };
  const r = planEnemies([...placed, u]);
  return { pos: r.pos, reform: true, why: `no clean spot, everyone re-forms (${r.pick})` };
}

// ── party side: Support row ──────────────────────────────────────────────
export function partyLine(count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0.5 : i / (count - 1);
    out.push({ x: P0.x + (P1.x - P0.x) * t, y: P0.y + (P1.y - P0.y) * t });
  }
  return out;
}
const pdx = P1.x - P0.x, pdy = P1.y - P0.y, pdl = Math.hypot(pdx, pdy);
const BACK = { x: pdy / pdl, y: -pdx / pdl };   // away from the enemies: right, and up the slant
function backOffset(d) { return { x: (1 - LIFT) * d + LIFT * BACK.x * d, y: LIFT * BACK.y * d }; }
function inParty(u, p) {
  const b = body(u, p), l = labelRect(u, p);
  const x0 = Math.min(b.x0, l ? l.x0 : 1e9), y1 = l ? l.y1 : b.y1;
  return x0 > CARD_X1 + 8 && b.x1 < REF_W - 8 && b.y0 > 8 && y1 < REF_H - 8;
}
// Feet points of the gaps between PCs (top→bottom), plus one past each end.
function gapFeet(pcs, pos) {
  const feet = pcs.map((u) => ({ x: pos[u.key].x, y: pos[u.key].y + u.h / 2 }));
  const out = [];
  for (let i = 0; i + 1 < feet.length; i++) out.push({ x: (feet[i].x + feet[i + 1].x) / 2, y: (feet[i].y + feet[i + 1].y) / 2, k: i + 0.5 });
  if (feet.length >= 2) {
    const a = feet[0], b = feet[1], c = feet[feet.length - 1], d = feet[feet.length - 2];
    out.push({ x: a.x - (b.x - a.x) / 2, y: a.y - (b.y - a.y) / 2, k: -0.5 });
    out.push({ x: c.x + (c.x - d.x) / 2, y: c.y + (c.y - d.y) / 2, k: feet.length - 0.5 });
  } else if (feet.length === 1) {
    out.push({ x: feet[0].x, y: feet[0].y - 90, k: -0.5 }, { x: feet[0].x, y: feet[0].y + 90, k: 0.5 });
  }
  return out;
}
/**
 * Place one support-row ally behind the PC line. `pcs` must be sorted top→bottom.
 * Returns a centre point, or null when no lane has a clean spot.
 */
export function placeSupport(pcs, placed, pos, u, used = {}) {
  const casterIdx = u.caster ? pcs.findIndex((p) => p.key === u.caster) : -1;
  const near = u.kind === "guest" || casterIdx < 0 ? (pcs.length - 1) / 2 : casterIdx;
  const slots = gapFeet(pcs, pos).sort((p, q) => Math.abs(p.k - near) - Math.abs(q.k - near) || p.k - q.k);
  for (let lane = 0; lane < 2; lane++) {
    for (const s of slots) {
      const key = `${s.k}:${lane}`;
      if (used[key]) continue;
      for (let d = 24 + lane * 150; d <= 24 + lane * 150 + 260; d += 4) {
        const at = (dd) => { const o = backOffset(dd); return { x: s.x + o.x, y: s.y + o.y - u.h / 2 }; };
        const p = at(d);
        if (!inParty(u, p)) continue;
        if (placed.some((v) => pairClashes(v, pos[v.key], u, p))) continue;
        const p2 = at(d + MARGIN);
        used[key] = true;
        return inParty(u, p2) && !placed.some((v) => pairClashes(v, pos[v.key], u, p2)) ? p2 : p;
      }
    }
  }
  return null;
}
/** Battle start: PCs on the tuned diagonal (top→bottom in given order), then every extra behind. */
export function planParty(pcs, extras) {
  const pos = {}, line = partyLine(pcs.length);
  pcs.forEach((u, i) => { pos[u.key] = line[i]; });
  const placed = pcs.slice(), used = {};
  for (const u of extras) {
    const p = placeSupport(pcs, placed, pos, u, used);
    if (p) { pos[u.key] = p; placed.push(u); }
  }
  return pos;
}
