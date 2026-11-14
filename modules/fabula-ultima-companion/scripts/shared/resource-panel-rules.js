// ============================================================================
// Resource Panel — pure rules (no Foundry, no DOM). FU.ResourcePanel shows a
// party's resource changes in scenes that have no resource HUD (events, story
// scenes, conflict events). Approved on the trap mockup v2, 2026-11-10:
// https://claude.ai/artifact/EgW2YkyzCqX3PDokaiSLQY (second screen).
// ============================================================================

export const DEFAULTS = Object.freeze({
  topPct: 14.5,          // same spot as FU.SystemMessage (approved size)
  fontPx1080: 18,        // base font at 1920 wide
  holdMs: 2400,          // after the bars settle
  enterMs: 260,
  leaveMs: 280,
  maxQueueAgeMs: 8000,   // a panel still waiting this long has missed its moment
});

export const RESOURCES = Object.freeze(["hp", "mp", "ip"]);

// Card count → panel width (% of the screen). Four cards = the System
// Message width; fewer cards shrink so one card is not a wide empty box.
export function widthPct(count) {
  const n = Math.max(1, Math.min(4, Number(count) || 1));
  return [12, 22, 31, 38][n - 1];
}

function num(v, d = 0) { const n = Number(v); return Number.isFinite(n) ? n : d; }

// Tags a caller may pass: "resist", "immune", "absorb", "weak", "held", "dr:N".
function parseTag(t) {
  const s = String(t ?? "").trim().toLowerCase();
  if (s === "resist") return { kind: "rs", label: "Resist" };
  if (s === "immune") return { kind: "im", label: "Immune" };
  if (s === "absorb") return { kind: "ab", label: "Absorb" };
  if (s === "weak") return { kind: "vu", label: "Weak" };
  if (s === "held") return { kind: "one", label: "Held at 1" };
  const m = /^dr:(\d+)$/.exec(s);
  if (m && Number(m[1]) > 0) return { kind: "dr", label: `DR −${Number(m[1])}` };
  return null;
}

// One card. Input: { name, img, resource, before, after, max, tags }
export function normalizeRow(row = {}) {
  const resource = RESOURCES.includes(String(row.resource).toLowerCase()) ? String(row.resource).toLowerCase() : "hp";
  const max = Math.max(1, num(row.max, 1));
  const before = Math.max(0, num(row.before));
  const after = Math.max(0, num(row.after, before));
  const delta = after - before;
  const chips = (Array.isArray(row.tags) ? row.tags : []).map(parseTag).filter(Boolean);
  // Crisis is worked out here: an HP loss that crosses half max.
  if (resource === "hp" && before > max / 2 && after <= max / 2 && !chips.some((c) => c.kind === "one")) {
    chips.push({ kind: "cr", label: "Crisis" });
  }
  return {
    name: String(row.name ?? ""),
    img: String(row.img ?? ""),
    resource, before, after, max, delta,
    gain: delta > 0,
    amount: Math.abs(delta),
    chips,
  };
}

// HP colour band, same as the battle HP bar.
export function band(current, max) {
  const f = num(current) / Math.max(1, num(max, 1));
  return f > 0.5 ? "ok" : f > 0.25 ? "crisis" : "low";
}

export function amountLabel(r) {
  if (!r.amount) return "0";
  return (r.gain ? "+" : "−") + r.amount + (r.resource === "hp" ? "" : " " + r.resource.toUpperCase());
}

// A panel call: { label?, rows, hold? } → normalized, at most 4 cards.
export function normalizePanel(input = {}) {
  const rows = (Array.isArray(input.rows) ? input.rows : []).slice(0, 4).map(normalizeRow);
  return {
    label: String(input.label ?? "").trim(),
    rows,
    hold: Math.max(600, num(input.hold, DEFAULTS.holdMs)),
    widthPct: widthPct(rows.length),
  };
}
