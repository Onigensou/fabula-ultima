// Party Menu — Bonds view (read-only).
//
// Two pages, Tab switches between them:
//   - Bonds: one character's bonds (the six sheet slots, the camp rest's
//     temporary bond and any bond an Active Effect grants — BondUpdater.readBondsAll,
//     the same set every bond formula reads). The card shows each feeling against
//     its opposite (Admiration | Inferiority …), the strength (number of feelings)
//     and, when the bond is with a party member, how THAT member feels back.
//   - Party: who is bonded to whom across the party, as a grid. Enter on a cell
//     opens that character's bond.
// Bonds are written at camp (camp-system's bond updater); this view never writes.

import { esc, play, SND, img, kbd } from "./party-menu-ui.js";
import { who } from "./party-menu-view-gear.js";

const PAIRS = [["admiration", "inferiority"], ["loyalty", "mistrust"], ["affection", "hatred"]];
const POSITIVE = new Set(["admiration", "loyalty", "affection"]);
const ICON = {
  admiration: "fa-star", inferiority: "fa-arrow-down-wide-short", loyalty: "fa-handshake", mistrust: "fa-eye-slash",
  affection: "fa-heart", hatred: "fa-heart-crack",
};
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : "");
// Names are typed by hand on the sheet ("⭐️ Geist", "Wanderring flame") — compare letters only.
const norm = (s) => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]/gu, "");

function bondsOf(actor) {
  const BU = globalThis.BondUpdater;
  if (!BU || !actor) return [];
  return BU.readBondsAll(actor).map((b) => {
    const feelings = [b.e1, b.e2, b.e3].map((e) => String(e ?? "").trim().toLowerCase()).filter(Boolean);
    const pos = feelings.filter((f) => POSITIVE.has(f)).length;
    return {
      key: String(b.idx),
      name: String(b.name ?? "").trim(),
      rel: String(b.rel ?? "").trim(),
      picks: [b.e1, b.e2, b.e3].map((e) => String(e ?? "").trim().toLowerCase()),
      feelings,
      strength: feelings.length,
      tone: !feelings.length ? "none" : pos === feelings.length ? "pos" : pos === 0 ? "neg" : "mixed",
      temp: b.idx === "temp" || b.source === "ae",
      effectId: b.effectId ?? null,
    };
  });
}

function partyOf(ctx) {
  const r = ctx.roster();
  return [...(r?.active ?? []), ...(r?.reserve ?? [])];
}

/**
 * The actor a bond names, when this user may see who that is: a party member,
 * an actor they can see, or a creature in the Bestiary. Otherwise just the name —
 * a bond with a stranger must not show a portrait the party has never seen.
 */
function targetOf(ctx, name) {
  const n = norm(name);
  if (!n) return null;
  const party = partyOf(ctx).find((a) => norm(a.name) === n);
  if (party) return { actor: party, party: true };
  const any = game.actors?.find((a) => norm(a.name) === n);
  if (!any) return null;
  if (game.user?.isGM || any.testUserPermission?.(game.user, "LIMITED")) return { actor: any, party: false };
  const seen = FUCompanion?.api?.encyclopedia?.getPageForActor?.(any.uuid);
  return seen ? { actor: any, party: false } : null;
}

function pips(n, tone) {
  return `<span class="pm-bpips tone-${tone}">${[0, 1, 2].map((i) => `<i class="${i < n ? "on" : ""}"></i>`).join("")}</span>`;
}

function feelingChips(b) {
  return b.feelings.map((f) => `<span class="pm-bfeel ${POSITIVE.has(f) ? "is-pos" : "is-neg"}"><i class="fas ${ICON[f] ?? "fa-circle"}"></i>${esc(cap(f))}</span>`).join("");
}

function avatar(t, name, cls = "") {
  return t?.actor
    ? `<div class="pm-portrait ${cls}">${img(t.actor.img)}</div>`
    : `<div class="pm-portrait ${cls} pm-mono"><span>${esc((name || "?").replace(/[^\p{L}\p{N}]/gu, "").slice(0, 1).toUpperCase() || "?")}</span></div>`;
}

function card(ctx, actor, b) {
  if (!b) return `<div class="pm-empty">${esc(actor.name)} has no bonds yet. Bonds are made and changed at camp.</div>`;
  const t = targetOf(ctx, b.name);
  const pairs = PAIRS.map(([pos, neg], i) => {
    const pick = b.picks[i];
    const side = (f, good) => `<span class="pm-bside ${pick === f ? `is-on ${good ? "is-pos" : "is-neg"}` : ""}"><i class="fas ${ICON[f]}"></i>${cap(f)}</span>`;
    return `<div class="pm-bpair">${side(pos, true)}<span class="pm-bvs">or</span>${side(neg, false)}</div>`;
  }).join("");
  let back = "";
  if (t?.party && t.actor.id !== actor.id) {
    const theirs = bondsOf(t.actor).find((x) => norm(x.name) === norm(actor.name));
    back = theirs
      ? `<div class="pm-label">How ${esc(t.actor.name)} feels about ${esc(actor.name)}</div>
         <div class="pm-bback">${pips(theirs.strength, theirs.tone)}${feelingChips(theirs) || `<em>No feelings yet</em>`}
         ${theirs.rel ? `<span class="pm-brel">“${esc(theirs.rel)}”</span>` : ""}</div>`
      : `<div class="pm-label">How ${esc(t.actor.name)} feels about ${esc(actor.name)}</div><div class="pm-sub">No bond back yet.</div>`;
  }
  const kind = t?.party ? "Party member" : t ? "Known" : "";
  const temp = b.temp ? `<div class="pm-locked"><i class="fas fa-hourglass-half"></i> Temporary bond${b.effectId ? ` (from ${esc(actor.effects.get(b.effectId)?.name ?? "an effect")})` : " (until it is resolved at camp)"}</div>` : "";
  return `
    <div class="pm-bhead">${avatar(t, b.name, "sm")}<div>
      <div class="pm-detail-name">${esc(b.name)}</div>
      <div class="pm-sub">${esc(kind)}${kind ? " · " : ""}Strength ${b.strength} ${pips(b.strength, b.tone)}</div>
    </div></div>
    ${temp}
    ${b.rel ? `<div class="pm-brel big">“${esc(b.rel)}”</div>` : ""}
    <div class="pm-label">Feelings</div>
    <div class="pm-bpairs">${pairs}</div>
    <div class="pm-sub pm-bnote">Strength is the number of feelings in a bond (0 to 3).</div>
    ${back}`;
}

// ── Party grid ──
function grid(ctx, v) {
  const party = partyOf(ctx);
  if (party.length < 2) return `<div class="pm-empty">The grid needs at least two party members.</div>`;
  v.row = Math.max(0, Math.min(v.row, party.length - 1));
  v.col = Math.max(0, Math.min(v.col, party.length - 1));
  const head = `<div class="pm-bgcorner"><span>feels about →</span></div>` + party.map((a, j) =>
    `<div class="pm-bgcol ${v.col === j ? "is-on" : ""}" title="${esc(a.name)}">${img(a.img)}</div>`).join("");
  const rows = party.map((a, i) => {
    const bonds = bondsOf(a);
    const cells = party.map((b, j) => {
      if (i === j) return `<div class="pm-bgcell is-self"></div>`;
      const bond = bonds.find((x) => norm(x.name) === norm(b.name));
      const cur = v.row === i && v.col === j;
      return `<div class="pm-bgcell pm-hit ${cur ? "is-cursor" : ""} ${bond ? `tone-${bond.tone}` : "is-none"}" data-action="bd-cell" data-index="${i * party.length + j}"
        title="${esc(`${a.name} → ${b.name}: ${bond ? bond.feelings.map(cap).join(", ") || "no feelings yet" : "no bond"}`)}">
        ${bond ? `<span class="pm-bgfeel">${bond.feelings.map((f) => `<i class="fas ${ICON[f] ?? "fa-circle"} ${POSITIVE.has(f) ? "is-pos" : "is-neg"}" title="${esc(cap(f))}"></i>`).join("") || "<em>—</em>"}</span>${pips(bond.strength, bond.tone)}` : "<span>—</span>"}</div>`;
    }).join("");
    return `<div class="pm-bgrow ${v.row === i ? "is-on" : ""}"><div class="pm-portrait xs">${img(a.img)}</div><span>${esc(a.name)}</span></div>${cells}`;
  }).join("");
  return `<div class="pm-bgrid" style="grid-template-columns: 150px repeat(${party.length}, minmax(52px, 1fr))">${head}${rows}</div>
    <div class="pm-sub pm-bnote">Each cell: how the row's character feels about the column's. Gold = warm, red = hostile, purple = mixed.</div>`;
}

export const bondsView = {
  id: "bonds",
  title: "Bonds",
  usesCharacter: true,

  enter(ctx) {
    const prev = ctx.S.v?.tab;
    ctx.S.v = { tab: prev === "party" ? "party" : "mine", idx: 0, row: 0, col: 1 };
    const party = partyOf(ctx);
    const i = party.findIndex((a) => a.id === ctx.actor()?.id);
    if (i >= 0) { ctx.S.v.row = i; ctx.S.v.col = i === 0 ? 1 : 0; }
  },

  nav(ctx) {
    const v = ctx.S.v;
    if (v.tab !== "party") return { crumbs: [`Bonds · ${ctx.actor()?.name ?? ""}`], actions: [{ key: "Tab", label: "Party grid", icon: "fa-diagram-project" }] };
    const party = partyOf(ctx);
    const a = party[v.row], b = party[v.col];
    const has = a && b && a !== b && bondsOf(a).some((x) => norm(x.name) === norm(b.name));
    return {
      crumbs: ["Bonds · Party"],
      actions: [...(has ? [{ key: "Enter", label: "Open bond", icon: "fa-link" }] : []), { key: "Tab", label: "List", icon: "fa-list" }],
    };
  },

  /** What the hand is on, in words (the party grid's cells only show icons). */
  readout(ctx) {
    const v = ctx.S.v;
    const actor = ctx.actor();
    if (v.tab === "party") {
      const party = partyOf(ctx);
      const a = party[v.row], b = party[v.col];
      if (!a || !b || a === b) return "How the party feels about each other.";
      const bond = bondsOf(a).find((x) => norm(x.name) === norm(b.name));
      return bond ? `${a.name} → ${b.name}: ${bond.feelings.map(cap).join(", ") || "no feelings yet"}${bond.rel ? ` — “${bond.rel}”` : ""}` : `${a.name} has no bond with ${b.name}.`;
    }
    const b = bondsOf(actor)[v.idx];
    return b ? `${b.name}: ${b.feelings.map(cap).join(", ") || "no feelings yet"}${b.rel ? ` — “${b.rel}”` : ""}` : `${actor?.name ?? ""} has no bonds yet.`;
  },

  render(ctx) {
    const actor = ctx.actor();
    if (!actor) return `<div class="pm-win pm-empty">That character is gone.</div>`;
    const v = ctx.S.v;
    const tabs = [["mine", "fa-link", `${actor.name}'s bonds`], ["party", "fa-diagram-project", "Party"]].map(([id, icon, label]) =>
      `<span class="pm-tab pm-hit ${v.tab === id ? "is-on" : ""}" data-action="bd-tab" data-id="${id}"><i class="fas ${icon}"></i>${esc(label)}</span>`).join("");
    let body;
    if (v.tab === "party") {
      body = `<div class="pm-win pm-skills pm-bwide"><div class="pm-tabs">${tabs}${kbd("Tab")}</div><div class="pm-scroll">${grid(ctx, v)}<div class="pm-bgread">${esc(this.readout(ctx))}</div></div></div>`;
    } else {
      const bonds = bondsOf(actor);
      v.idx = Math.max(0, Math.min(v.idx, Math.max(0, bonds.length - 1)));
      let last = null;
      const list = bonds.map((b, i) => {
        const g = b.temp ? "temp" : "main";
        const head = g !== last ? `<div class="pm-section"><i class="fas ${g === "temp" ? "fa-hourglass-half" : "fa-link"}"></i>${g === "temp" ? "Temporary" : "Bonds"}</div>` : "";
        last = g;
        const t = targetOf(ctx, b.name);
        return `${head}<div class="pm-skill pm-hit pm-bond ${v.idx === i ? "is-cursor" : ""}" data-action="bd-bond" data-index="${i}">
          ${avatar(t, b.name, "xs")}<span class="pm-skill-name">${esc(b.name)}</span>
          <span class="pm-bfeels">${feelingChips(b)}</span>${pips(b.strength, b.tone)}</div>`;
      }).join("") || `<div class="pm-empty">No bonds yet.</div>`;
      body = `
        <div class="pm-win pm-skills"><div class="pm-tabs">${tabs}${kbd("Tab")}</div><div class="pm-skill-list pm-onecol pm-bondlist">${list}</div></div>
        <div class="pm-win pm-detail"><div class="pm-scroll" data-key="bond|${esc(actor.id)}|${v.idx}">${card(ctx, actor, bonds[v.idx])}</div></div>`;
    }
    return `
      <div class="pm-ability">
        ${ctx.nav()}
        ${who(ctx, actor, "Bonds")}
        <div class="pm-ability-body ${v.tab === "party" ? "pm-onebody" : ""}">${body}</div>
      </div>`;
  },

  openCell(ctx) {
    const v = ctx.S.v;
    const party = partyOf(ctx);
    const a = party[v.row], b = party[v.col];
    if (!a || !b || a === b) return;
    const i = bondsOf(a).findIndex((x) => norm(x.name) === norm(b.name));
    if (i < 0) { play(SND.buzz, 0.5); ctx.toast(`${a.name} has no bond with ${b.name}.`); return; }
    ctx.S.actorId = a.id;
    Object.assign(v, { tab: "mine", idx: i });
    ctx.animate("tab");
    play(SND.ok);
    ctx.render();
  },

  key(ctx, k, ev) {
    const v = ctx.S.v;
    if (k === "Tab") { v.tab = v.tab === "party" ? "mine" : "party"; ctx.animate("tab"); play(SND.move, 0.45); ctx.render(); return; }
    if (k === "Escape") return ctx.back();
    if (v.tab === "party") {
      const n = partyOf(ctx).length;
      if (!n) return;
      const step = (key, d) => { v[key] = (v[key] + d + n) % n; if (n > 1 && v.row === v.col) v[key] = (v[key] + d + n) % n; };
      if (k === "ArrowUp") step("row", -1);
      else if (k === "ArrowDown") step("row", 1);
      else if (k === "ArrowLeft") step("col", -1);
      else if (k === "ArrowRight") step("col", 1);
      else if (k === "Enter") return this.openCell(ctx);
      else return;
      play(SND.move, 0.4); ctx.render();
      return;
    }
    if (k === "q" || k === "Q" || k === "PageUp" || k === "ArrowLeft") return ctx.cycleCharacter(-1);
    if (k === "e" || k === "E" || k === "PageDown" || k === "ArrowRight") return ctx.cycleCharacter(1);
    const n = bondsOf(ctx.actor()).length;
    if (k === "ArrowUp" && n) { v.idx = (v.idx - 1 + n) % n; play(SND.move, 0.4); ctx.render(); }
    else if (k === "ArrowDown" && n) { v.idx = (v.idx + 1) % n; play(SND.move, 0.4); ctx.render(); }
  },

  async click(ctx, a, el) {
    const v = ctx.S.v;
    if (a === "bd-tab") { if (v.tab !== el.dataset.id) ctx.animate("tab"); v.tab = el.dataset.id; play(SND.move, 0.45); ctx.render(); }
    else if (a === "bd-bond") { v.idx = Number(el.dataset.index); play(SND.move, 0.4); ctx.render(); }
    else if (a === "bd-cell") {
      const n = partyOf(ctx).length;
      const i = Number(el.dataset.index);
      const row = Math.floor(i / n), col = i % n;
      if (v.row === row && v.col === col) this.openCell(ctx);
      else { v.row = row; v.col = col; play(SND.move, 0.4); ctx.render(); }
    }
  },

  hover(ctx, a, i) {
    const v = ctx.S.v;
    if (a === "bd-bond" && v.tab === "mine" && v.idx !== i) { v.idx = i; return true; }
    if (a === "bd-cell" && v.tab === "party") {
      const n = partyOf(ctx).length;
      const row = Math.floor(i / n), col = i % n;
      if (v.row !== row || v.col !== col) { v.row = row; v.col = col; return true; }
    }
    return false;
  },
};

export const BONDS_CSS = `
#fud-party-menu .pm-bond .pm-portrait.xs { width: 30px; height: 30px; }
#fud-party-menu .pm-bondlist .pm-skill { padding: 4px 6px; }
#fud-party-menu .pm-mono { display: flex; align-items: center; justify-content: center; background: linear-gradient(#efdfc3, #d9c08a); }
#fud-party-menu .pm-mono span { font-weight: 700; color: var(--ink-soft); font-size: 1.1em; }
#fud-party-menu .pm-portrait.sm.pm-mono span { font-size: 26px; }
#fud-party-menu .pm-bfeels { display: inline-flex; gap: 4px; flex: 0 1 auto; min-width: 0; overflow: hidden; }
#fud-party-menu .pm-bfeel { display: inline-flex; align-items: center; gap: 3px; font-size: 11px; font-weight: 700; padding: 0 6px; border-radius: 999px; white-space: nowrap; }
#fud-party-menu .pm-bfeel i { font-size: 9px; }
#fud-party-menu .pm-bfeel.is-pos { color: #7a5a10; background: rgba(240,200,90,.25); box-shadow: inset 0 0 0 1px rgba(170,130,30,.35); }
#fud-party-menu .pm-bfeel.is-neg { color: #9b2222; background: rgba(200,60,60,.12); box-shadow: inset 0 0 0 1px rgba(160,40,40,.3); }
#fud-party-menu .pm-bpips { display: inline-flex; gap: 3px; vertical-align: middle; flex: 0 0 auto; }
#fud-party-menu .pm-bpips i { width: 9px; height: 9px; border-radius: 50%; background: rgba(59,42,25,.14); box-shadow: inset 0 0 0 1px rgba(59,42,25,.25); }
#fud-party-menu .pm-bpips.tone-pos i.on { background: radial-gradient(circle at 35% 35%, #fff3c0, #d9a530 70%); box-shadow: 0 0 4px rgba(217,165,48,.6); }
#fud-party-menu .pm-bpips.tone-neg i.on { background: radial-gradient(circle at 35% 35%, #ffb0a0, #b42a1e 70%); }
#fud-party-menu .pm-bpips.tone-mixed i.on { background: radial-gradient(circle at 35% 35%, #e0c6ff, #7a3fb4 70%); }
#fud-party-menu .pm-bhead { display: flex; gap: 12px; align-items: center; margin-bottom: 8px; }
#fud-party-menu .pm-brel { font-style: italic; color: var(--ink-soft); font-size: 13px; }
#fud-party-menu .pm-brel.big { font-size: 16px; margin: 4px 0 10px; padding-left: 10px; border-left: 3px solid rgba(154,122,43,.5); }
#fud-party-menu .pm-bpairs { display: flex; flex-direction: column; gap: 6px; margin: 6px 0 4px; }
#fud-party-menu .pm-bpair { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 8px; }
#fud-party-menu .pm-bside { display: flex; align-items: center; justify-content: center; gap: 6px; padding: 4px 8px; border-radius: 8px;
  font-weight: 700; font-size: 14px; color: var(--ink-dim); background: rgba(59,42,25,.05); }
#fud-party-menu .pm-bside.is-on.is-pos { color: #6b4d0c; background: linear-gradient(#fff3c8, #f0d488); box-shadow: inset 0 0 0 1px rgba(170,130,30,.5), 0 0 8px rgba(240,200,90,.45); }
#fud-party-menu .pm-bside.is-on.is-neg { color: #fff; background: linear-gradient(#d65a4a, #9b2222); box-shadow: inset 0 0 0 1px rgba(110,20,20,.6); }
#fud-party-menu .pm-bvs { font-size: 11px; color: var(--ink-dim); text-transform: uppercase; letter-spacing: .08em; }
#fud-party-menu .pm-bnote { margin: 6px 0 12px; }
#fud-party-menu .pm-bback { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 4px 0 8px; }
#fud-party-menu .pm-bgread { margin: 10px 0 0 36px; font-size: 15px; color: var(--ink-soft); min-height: 1.4em; }
#fud-party-menu .pm-onebody { grid-template-columns: minmax(0, 1fr); }
#fud-party-menu .pm-bwide { padding: 12px 18px 14px; }
#fud-party-menu .pm-bgrid { display: grid; gap: 6px; align-items: center; padding: 8px 4px 4px 36px; }
#fud-party-menu .pm-bgcorner { font-size: 11px; color: var(--ink-soft); text-transform: uppercase; letter-spacing: .06em; text-align: right; padding-right: 6px; }
#fud-party-menu .pm-bgcol { justify-self: center; width: 44px; height: 44px; border-radius: 8px; overflow: hidden; border: 2px solid var(--edge); opacity: .8; }
#fud-party-menu .pm-bgcol.is-on { opacity: 1; box-shadow: 0 0 0 2px var(--gold-2), 0 0 10px var(--glow); }
#fud-party-menu .pm-bgcol img { width: 100%; height: 100%; object-fit: cover; object-position: top; border: 0; }
#fud-party-menu .pm-bgrow { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 15px; min-width: 0; }
#fud-party-menu .pm-bgrow span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#fud-party-menu .pm-bgrow.is-on span { color: var(--accent); }
#fud-party-menu .pm-bgcell { height: 52px; display: flex; align-items: center; justify-content: center; border-radius: 8px; cursor: pointer;
  background: rgba(59,42,25,.05); box-shadow: inset 0 0 0 1px rgba(59,42,25,.12); }
#fud-party-menu .pm-bgcell.is-self { background: repeating-linear-gradient(45deg, rgba(59,42,25,.06) 0 6px, transparent 6px 12px); box-shadow: none; cursor: default; }
#fud-party-menu .pm-bgcell.is-none span { color: var(--ink-dim); }
#fud-party-menu .pm-bgcell { flex-direction: column; gap: 3px; }
#fud-party-menu .pm-bgfeel { display: flex; gap: 6px; font-size: 14px; }
#fud-party-menu .pm-bgfeel .is-pos { color: #b58410; } #fud-party-menu .pm-bgfeel .is-neg { color: #a32a1e; }
#fud-party-menu .pm-bgfeel em { margin: 0; color: var(--ink-dim); }
#fud-party-menu .pm-bgcell.tone-pos { background: rgba(240,200,90,.2); }
#fud-party-menu .pm-bgcell.tone-neg { background: rgba(200,60,60,.13); }
#fud-party-menu .pm-bgcell.tone-mixed { background: rgba(130,70,190,.13); }
#fud-party-menu .pm-bgcell.is-cursor { box-shadow: inset 0 0 0 2px rgba(154,122,43,.8), 0 0 10px var(--glow); }
#fud-party-menu .pm-bgcell.is-cursor::before { display: none; }
`;
