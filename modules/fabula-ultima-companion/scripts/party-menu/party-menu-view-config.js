// Party Menu — Config view (everyone).
//
// FF9's Config page: this user's own display options. Left: the option groups
// (Graphic, …). Right: the options in the selected group, each a row of its
// choices with the chosen one lit and its explanation underneath.
//
// Everything here is a client setting (shared/client-options.js): it changes
// only this user's screen, so there is nothing to grant and no GM relay.

import { OPTION_GROUPS, getClientOption, setClientOption } from "../shared/client-options.js";
import { esc, play, SND } from "./party-menu-ui.js";

const group = (v) => OPTION_GROUPS[v.g] ?? OPTION_GROUPS[0];

export const configView = {
  id: "config",
  title: "Config",

  enter(ctx) { ctx.S.v = { col: "group", g: 0, o: 0 }; },

  nav(ctx) {
    const v = ctx.S.v;
    const actions = v.col === "opt"
      ? [{ key: "Enter", label: "Change", icon: "fa-arrows-left-right" }]
      : [{ key: "Enter", label: "Open", icon: "fa-sliders" }];
    return { crumbs: v.col === "opt" ? ["Config", group(v).label] : ["Config"], actions };
  },

  render(ctx) {
    const v = ctx.S.v;
    const g = group(v);
    const groups = OPTION_GROUPS.map((gr, i) => `
      <div class="pm-surow pm-hit ${v.g === i ? (v.col === "group" ? "is-cursor" : "is-held") : ""}" data-action="cf-group" data-index="${i}">
        <i class="fas ${esc(gr.icon)} pm-check"></i><span class="pm-suname">${esc(gr.label)}</span>
      </div>`).join("");
    const rows = g.options.map((opt, i) => {
      const cur = getClientOption(opt.key);
      const chosen = opt.choices.find((c) => c.value === cur) ?? opt.choices[0];
      const chips = opt.choices.map((c) => `
        <span class="pm-cfval pm-hit ${c.value === cur ? "is-on" : ""}" data-action="cf-val" data-index="${i}" data-value="${esc(c.value)}">${esc(c.label)}</span>`).join("");
      return `
        <div class="pm-cfrow pm-hit ${v.col === "opt" && v.o === i ? "is-cursor" : ""}" data-action="cf-opt" data-index="${i}">
          <div class="pm-cfhead"><span class="pm-suname">${esc(opt.label)}</span><span class="pm-cfvals">${chips}</span></div>
          <div class="pm-sub">${esc(chosen?.hint ?? opt.hint)}</div>
        </div>`;
    }).join("");
    return `
      <div class="pm-ability">
        ${ctx.nav()}
        <div class="pm-ability-top">
          <div class="pm-win pm-title"><span class="pm-pill">Config</span></div>
          <div class="pm-win pm-who pm-who-plain"><div class="pm-who-body">
            <div class="pm-member-top"><span class="pm-name">${esc(game.user?.name ?? "")}</span></div>
            <div class="pm-sub">These options are yours: they change only what this screen shows.</div>
          </div></div>
        </div>
        <div class="pm-ability-body">
          <div class="pm-win pm-skills"><div class="pm-label">Options</div><div class="pm-skill-list pm-onecol pm-sulist">${groups}</div></div>
          <div class="pm-win pm-detail"><div class="pm-scroll pm-sulist">
            <div class="pm-label">${esc(g.label)}</div>${rows}
          </div></div>
        </div>
      </div>`;
  },

  async choose(ctx, i, value) {
    const opt = group(ctx.S.v).options[i];
    if (!opt || ctx.S.busy) return;
    if (getClientOption(opt.key) === value) return;
    ctx.setBusy(true);
    let ok = false;
    try { ok = await setClientOption(opt.key, value); }
    catch (e) { console.error("[PartyMenu] config write failed", e); }
    finally { ctx.setBusy(false); }
    if (ok) {
      play(SND.ok);
      ctx.toast(`${opt.label}: ${opt.choices.find((c) => c.value === value)?.label ?? value}`);
    } else {
      play(SND.buzz, 0.5);
      ctx.toast(`Could not change ${opt.label}.`);
    }
  },

  /** Step option `i` to its next (or previous) choice. */
  step(ctx, i, dir) {
    const opt = group(ctx.S.v).options[i];
    if (!opt) return;
    const n = opt.choices.length;
    const at = Math.max(0, opt.choices.findIndex((c) => c.value === getClientOption(opt.key)));
    return this.choose(ctx, i, opt.choices[(at + dir + n) % n].value);
  },

  key(ctx, k) {
    const v = ctx.S.v;
    if (v.col === "group") {
      const n = OPTION_GROUPS.length;
      if (k === "Escape") return ctx.back();
      if (k === "ArrowUp") { v.g = (v.g - 1 + n) % n; play(SND.move, 0.4); ctx.render(); }
      else if (k === "ArrowDown") { v.g = (v.g + 1) % n; play(SND.move, 0.4); ctx.render(); }
      else if (k === "Enter" || k === "ArrowRight") { v.col = "opt"; v.o = 0; play(SND.ok); ctx.render(); }
      return;
    }
    const n = group(v).options.length;
    if (k === "Escape") { v.col = "group"; play(SND.back); ctx.render(); }
    else if (k === "ArrowUp") { v.o = (v.o - 1 + n) % n; play(SND.move, 0.4); ctx.render(); }
    else if (k === "ArrowDown") { v.o = (v.o + 1) % n; play(SND.move, 0.4); ctx.render(); }
    else if (k === "ArrowLeft") this.step(ctx, v.o, -1);
    else if (k === "ArrowRight" || k === "Enter") this.step(ctx, v.o, 1);
  },

  async click(ctx, a, el) {
    const v = ctx.S.v;
    const i = Number(el.dataset.index);
    switch (a) {
      case "cf-group": v.g = i; v.col = "opt"; v.o = 0; play(SND.ok); ctx.render(); break;
      case "cf-opt": v.col = "opt"; v.o = i; play(SND.move, 0.4); ctx.render(); break;
      case "cf-val": v.col = "opt"; v.o = i; await this.choose(ctx, i, el.dataset.value); break;
      default: break;
    }
  },

  hover(ctx, a, i) {
    const v = ctx.S.v;
    if (a === "cf-group" && v.col === "group" && v.g !== i) { v.g = i; return true; }
    if ((a === "cf-opt" || a === "cf-val") && (v.col !== "opt" || v.o !== i)) { v.col = "opt"; v.o = i; return true; }
    return false;
  },
};

export const CONFIG_CSS = (ROOT_ID) => `
#${ROOT_ID} .pm-cfrow { display: flex; flex-direction: column; gap: 4px; padding: 8px 8px 10px; border-radius: 8px; cursor: pointer; }
#${ROOT_ID} .pm-cfrow + .pm-cfrow { border-top: 1px dashed rgba(92,66,30,.3); }
#${ROOT_ID} .pm-cfhead { display: flex; align-items: center; gap: 12px; }
#${ROOT_ID} .pm-cfvals { margin-left: auto; display: inline-flex; gap: 6px; }
#${ROOT_ID} .pm-cfval { min-width: 72px; padding: 3px 12px; border-radius: 999px; text-align: center; font-size: 14px; font-weight: 700; cursor: pointer;
  color: var(--ink); border: 1px solid rgba(112,74,29,.45); background: rgba(255,255,255,.35); }
#${ROOT_ID} .pm-cfval:hover { border-color: var(--gold-3); }
#${ROOT_ID} .pm-cfval.is-on { color: #fff3e6; border-color: #e2c27e; background: linear-gradient(180deg,#c4473a,#8e2219 60%,#741a14); box-shadow: 0 0 8px rgba(222,66,46,.45); }
`;
