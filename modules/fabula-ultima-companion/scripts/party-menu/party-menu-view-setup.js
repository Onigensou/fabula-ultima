// Party Menu — Setup view (GM only).
//
// Left: the party roster — Active / Reserve / Away slots on the party database
// (the same `*_id_N` fields the CSB Party Sheet edits by hand). Right: which
// Party Menu commands players may open. Setup itself is never grantable.
//
// The view refuses to render for a non-GM even if reached some other way; the
// writes it calls (setRosterSlot, setPlayerCommands) are GM-gated as well.

import { rosterSlots, rosterCandidates, setRosterSlot } from "./party-menu-inventory.js";
import { COMMAND_DEFS, playerCommands, setPlayerCommands } from "./party-menu-access.js";
import { folderPath } from "./party-menu-core.js";
import { esc, play, SND, img } from "./party-menu-ui.js";

const grantable = () => COMMAND_DEFS.filter((c) => !c.gmOnly);

const ROSTER_REASONS = {
  "not-gm": "Only a GM can change this.",
  "no-db": "No party database is set for the current game.",
  "no-such-slot": "That roster slot doesn't exist.",
  "bad-target": "That actor can't join the party.",
};

export const setupView = {
  id: "setup",
  title: "Setup",

  enter(ctx) { ctx.S.v = { col: "roster", idx: 0, acc: 0, picker: null }; },

  help(ctx) {
    const v = ctx.S.v;
    if (v.picker) return `Choose who sits in ${v.picker.label}.`;
    if (v.col === "access") return grantable()[v.acc]?.hint ?? "";
    const s = rosterSlots(ctx.roster().db)[v.idx];
    return s ? `${s.group} ${s.slot}: ${s.actor?.name ?? "empty"}${s.ref && !s.actor ? ` (missing actor "${s.ref}")` : ""}` : "";
  },

  render(ctx) {
    if (!game.user?.isGM) return `<div class="pm-win pm-empty">Setup is for the GM.</div>`;
    const v = ctx.S.v;
    const db = ctx.roster().db;
    const slots = rosterSlots(db);
    let lastGroup = null;
    const rows = slots.map((s, i) => {
      const head = s.group === lastGroup ? "" : `<div class="pm-section"><i class="fas fa-users"></i><span>${esc(s.group)}</span></div>`;
      lastGroup = s.group;
      const cursor = !v.picker && v.col === "roster" && v.idx === i;
      return `${head}
        <div class="pm-surow pm-hit ${cursor ? "is-cursor" : ""} ${v.picker && v.idx === i ? "is-held" : ""}" data-action="su-slot" data-index="${i}">
          <span class="pm-sunum">${s.slot}</span>
          <div class="pm-portrait xs">${s.actor ? img(s.actor.img) : ""}</div>
          <span class="pm-suname ${s.actor ? "" : "is-empty"}">${esc(s.actor?.name ?? (s.ref ? `Missing: ${s.ref}` : "— empty —"))}</span>
          ${s.actor ? `<button type="button" class="pm-btn pm-hit pm-mini" data-action="su-clear" data-index="${i}" title="Empty this slot">✕</button>` : ""}
        </div>`;
    }).join("");

    const granted = new Set(playerCommands());
    const access = [
      ...grantable().map((c, i) => `
        <div class="pm-surow pm-hit ${!v.picker && v.col === "access" && v.acc === i ? "is-cursor" : ""}" data-action="su-cmd" data-index="${i}">
          <i class="fas ${granted.has(c.id) ? "fa-square-check" : "fa-square"} pm-check"></i>
          <span class="pm-suname">${esc(c.label)}</span><span class="pm-sub">${esc(c.hint)}</span>
        </div>`),
      ...COMMAND_DEFS.filter((c) => c.gmOnly).map((c) => `
        <div class="pm-surow is-locked"><i class="fas fa-lock pm-check"></i><span class="pm-suname">${esc(c.label)}</span><span class="pm-sub">GM only</span></div>`),
    ].join("");

    return `
      <div class="pm-ability">
        <div class="pm-win pm-help"><span>${esc(this.help(ctx))}</span></div>
        <div class="pm-ability-top">
          <div class="pm-win pm-title"><span class="pm-pill">Setup</span></div>
          <div class="pm-win pm-who pm-who-plain"><div class="pm-who-body">
            <div class="pm-member-top"><span class="pm-name">${esc(ctx.roster().gameName || db?.name || "Party")}</span></div>
            <div class="pm-sub">Party database: ${esc(db?.name ?? "—")} · changes here apply to every player</div>
          </div></div>
        </div>
        <div class="pm-ability-body">
          <div class="pm-win pm-skills"><div class="pm-label">Party roster</div><div class="pm-skill-list pm-onecol pm-sulist">${rows}</div></div>
          <div class="pm-win pm-detail"><div class="pm-scroll pm-sulist">
            <div class="pm-label">Players may open</div>${access}
            <div class="pm-sub pm-sunote">The GM always sees every command. Players only change what they own — their character, and the Party Bag.</div>
          </div></div>
        </div>
        <div class="pm-hint">${v.col === "roster" ? "↑↓ slot · Enter choose · Del empty · → access · Esc back" : "↑↓ command · Enter toggle · ← roster · Esc back"}</div>
      </div>
      ${v.picker ? this.renderPicker(ctx) : ""}`;
  },

  renderPicker(ctx) {
    const p = ctx.S.v.picker;
    const q = p.query.trim().toLowerCase();
    const list = q ? p.list.filter((a) => a.name.toLowerCase().includes(q) || folderPath(a).toLowerCase().includes(q)) : p.list;
    p.visible = list;
    p.index = Math.max(0, Math.min(p.index, list.length));
    const groups = new Map();
    list.forEach((a, i) => {
      const g = folderPath(a) || "(no folder)";
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push({ a, i: i + 1 });
    });
    const seated = new Map(rosterSlots(ctx.roster().db).filter((s) => s.actor).map((s) => [s.actor.id, `${s.group} ${s.slot}`]));
    const body = [...groups.entries()].map(([g, rows]) => `
      <div class="pm-pick-group">${esc(g)}</div>
      ${rows.map(({ a, i }) => `<div class="pm-pick pm-hit ${p.index === i ? "is-cursor" : ""}" data-action="su-pick" data-index="${i}">
        <div class="pm-portrait xs">${img(a.img)}</div><span>${esc(a.name)}</span>${seated.has(a.id) ? `<em class="pm-why">${esc(seated.get(a.id))}</em>` : ""}</div>`).join("")}`).join("");
    return `
      <div class="pm-picker-veil"></div>
      <div class="pm-win pm-picker">
        <div class="pm-picker-head"><span class="pm-label">${esc(p.label)}</span></div>
        <input type="text" class="pm-search" placeholder="Search…" value="${esc(p.query)}">
        <div class="pm-picker-list">
          <div class="pm-pick pm-hit ${p.index === 0 ? "is-cursor" : ""}" data-action="su-pick" data-index="0"><div class="pm-portrait xs"></div><span>— empty —</span></div>
          ${body || `<div class="pm-empty">No matching characters.</div>`}
        </div>
        <div class="pm-hint">↑↓ choose · Enter confirm · Esc cancel · a seated character moves here</div>
      </div>`;
  },

  openPicker(ctx, i) {
    const db = ctx.roster().db;
    const s = rosterSlots(db)[i];
    if (!s) return;
    const list = rosterCandidates(db).sort((a, b) => folderPath(a).localeCompare(folderPath(b)) || a.name.localeCompare(b.name));
    const at = s.actor ? list.indexOf(s.actor) : -1;
    ctx.S.v.idx = i; ctx.S.v.col = "roster";
    ctx.S.v.picker = { slotIndex: i, label: `${s.group} ${s.slot}`, query: "", index: at >= 0 ? at + 1 : 0, list, focusSearch: true };
    ctx.focusSearch();
    play(SND.ok);
    ctx.render();
  },

  async seat(ctx, slotIndex, actor) {
    const s = rosterSlots(ctx.roster().db)[slotIndex];
    if (!s) return;
    ctx.setBusy(true);
    let res;
    try { res = await setRosterSlot(s.kind, s.slot, actor); }
    catch (e) { console.error("[PartyMenu] roster write failed", e); res = { ok: false, reason: e?.message ?? "error" }; }
    finally { ctx.setBusy(false); }
    if (ctx.S.v) ctx.S.v.picker = null;
    if (res?.ok) { play(SND.done, 0.5); await ctx.refreshRoster(); ctx.toast(`${s.group} ${s.slot}: ${actor?.name ?? "empty"}`); }
    else { play(SND.buzz, 0.5); ctx.toast(ROSTER_REASONS[res?.reason] ?? `Could not change the roster (${res?.reason}).`); }
  },

  async toggle(ctx, i) {
    const c = grantable()[i];
    if (!c || ctx.S.busy) return;
    const cur = new Set(playerCommands());
    if (cur.has(c.id)) cur.delete(c.id); else cur.add(c.id);
    // Busy until the write lands: a second quick toggle would otherwise read the
    // old grant and overwrite the first.
    ctx.setBusy(true);
    let res;
    try { res = await setPlayerCommands([...cur]); }
    catch (e) { res = { ok: false, reason: e?.message ?? "error" }; }
    finally { ctx.setBusy(false); }
    if (res.ok) { play(SND.ok); ctx.toast(`Players ${cur.has(c.id) ? "can" : "can no longer"} open ${c.label}`); }
    else { play(SND.buzz, 0.5); ctx.toast(ROSTER_REASONS[res.reason] ?? `Could not change player access (${res.reason}).`); }
  },

  key(ctx, k) {
    const v = ctx.S.v;
    if (v.picker) {
      const max = (v.picker.visible ?? v.picker.list).length;
      if (k === "ArrowUp") { v.picker.index = (v.picker.index + max) % (max + 1); play(SND.move, 0.4); ctx.render(); }
      else if (k === "ArrowDown") { v.picker.index = (v.picker.index + 1) % (max + 1); play(SND.move, 0.4); ctx.render(); }
      else if (k === "Enter") this.pickAt(ctx, v.picker.index);
      else if (k === "Escape") { v.picker = null; play(SND.back); ctx.render(); }
      return;
    }
    if (k === "Escape") return ctx.back();
    if (k === "ArrowRight" && v.col === "roster") { v.col = "access"; play(SND.move, 0.4); return ctx.render(); }
    if (k === "ArrowLeft" && v.col === "access") { v.col = "roster"; play(SND.move, 0.4); return ctx.render(); }
    if (v.col === "roster") {
      const n = rosterSlots(ctx.roster().db).length;
      if (k === "ArrowUp") { v.idx = (v.idx - 1 + n) % n; play(SND.move, 0.4); ctx.render(); }
      else if (k === "ArrowDown") { v.idx = (v.idx + 1) % n; play(SND.move, 0.4); ctx.render(); }
      else if (k === "Enter") this.openPicker(ctx, v.idx);
      else if (k === "Delete" || k === "Backspace") this.seat(ctx, v.idx, null);
    } else {
      const n = grantable().length;
      if (k === "ArrowUp") { v.acc = (v.acc - 1 + n) % n; play(SND.move, 0.4); ctx.render(); }
      else if (k === "ArrowDown") { v.acc = (v.acc + 1) % n; play(SND.move, 0.4); ctx.render(); }
      else if (k === "Enter") this.toggle(ctx, v.acc);
    }
  },

  pickAt(ctx, i) {
    const p = ctx.S.v.picker;
    if (!p) return;
    if (i === 0) return this.seat(ctx, p.slotIndex, null);
    const a = (p.visible ?? p.list)[i - 1];
    if (a) return this.seat(ctx, p.slotIndex, a);
  },

  async click(ctx, a, el) {
    const v = ctx.S.v;
    const i = Number(el.dataset.index);
    switch (a) {
      case "su-slot":
        if (v.picker) break;
        if (v.col === "roster" && v.idx === i) this.openPicker(ctx, i);
        else { v.col = "roster"; v.idx = i; play(SND.move, 0.4); ctx.render(); }
        break;
      case "su-clear": if (!v.picker) await this.seat(ctx, i, null); break;
      case "su-cmd": if (!v.picker) { v.col = "access"; v.acc = i; await this.toggle(ctx, i); } break;
      case "su-pick": await this.pickAt(ctx, i); break;
      default: break;
    }
  },

  hover(ctx, a, i) {
    const v = ctx.S.v;
    if (a === "su-slot" && !v.picker && (v.col !== "roster" || v.idx !== i)) { v.col = "roster"; v.idx = i; return true; }
    if (a === "su-cmd" && !v.picker && (v.col !== "access" || v.acc !== i)) { v.col = "access"; v.acc = i; return true; }
    if (a === "su-pick" && v.picker && v.picker.index !== i) { v.picker.index = i; return true; }
    return false;
  },

  input(ctx, ev) {
    const p = ctx.S.v.picker;
    if (!p || !ev.target.classList?.contains("pm-search")) return;
    p.query = ev.target.value;
    p.index = p.query ? 1 : 0;
    ctx.render();
  },
};
