// Party Menu — shared presentation helpers (escaping, sanitising, sound,
// stat labels, keyboard grid stepping). No state lives here.

export const SND = {
  move: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BattleCursor_2.wav",
  ok: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BattleCursor_4.wav",
  back: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BattleCursor_1.wav",
  buzz: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/Buzzer2.ogg",
  done: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/success_4.wav",
};

export function play(src, volume = 0.6) {
  try { foundry.audio.AudioHelper.play({ src, volume, loop: false }, false); }
  catch { /* sound is decoration */ }
}

// Same stat labels as the CSB character sheet: red heart HP, blue star MP, briefcase IP.
export const STAT = {
  hp: `<em class="hp"><i class="fas fa-heart"></i>HP</em>`,
  mp: `<em class="mp"><i class="fas fa-star"></i>MP</em>`,
  ip: `<em class="ip"><i class="fas fa-briefcase"></i>IP</em>`,
};

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]
));

// Descriptions are player-editable HTML and this menu is opened by the GM, so
// they are parsed INERT (DOMParser runs no scripts and loads no images, unlike
// innerHTML on a detached element) and stripped of anything active before they
// are shown.
const inert = (html) => new DOMParser().parseFromString(String(html ?? ""), "text/html").body;

// textContent glues block elements together ("Choose one:the Phantasm inflicts
// Weakthe…"), so put a space after every block before flattening.
export const plain = (html) => {
  const body = inert(html);
  body.querySelectorAll("p,li,div,br,h1,h2,h3,h4,h5,h6,tr,hr").forEach((el) => el.after(" "));
  return (body.textContent ?? "").replace(/\s+/g, " ").trim();
};

const DROP_TAGS = "script,style,iframe,object,embed,link,meta,base,form,input,button,textarea,select,svg,math,template";

// Some descriptions keep Foundry's raw @UUID[…]{Label} syntax instead of an
// enriched link; turn it into the same link so it reads (and hovers) like one.
const UUID_REF = /@UUID\[([^\]]+)\](?:\{([^}]*)\})?/g;
function linkRefs(html) {
  return String(html ?? "").replace(UUID_REF, (m, uuid, label) => {
    let name = label;
    if (!name) { try { name = fromUuidSync(uuid)?.name; } catch { name = null; } }
    return `<a class="content-link" data-uuid="${esc(uuid)}">${esc(name || uuid.split(".").pop())}</a>`;
  });
}

export function safeHtml(html) {
  const body = inert(linkRefs(html));
  body.querySelectorAll(DROP_TAGS).forEach((el) => el.remove());
  for (const el of body.querySelectorAll("*")) {
    for (const attr of [...el.attributes]) {
      const n = attr.name.toLowerCase();
      const v = attr.value.trim().toLowerCase();
      // Inline colour/weight styling is kept — descriptions are authored for the
      // parchment sheets and their keyword colours read correctly on it. Anything
      // that can fetch, overlay or script is not.
      const badStyle = n === "style" && /url\(|expression|position|behavior|binding|@import|z-index/.test(v);
      // data-tooltip: Foundry would pop its own one-word tooltip ("Item") over the menu's.
      if (n.startsWith("on") || n === "srcdoc" || badStyle || n === "data-tooltip"
          || ((n === "href" || n === "src" || n === "xlink:href") && !/^(https?:|\/|#|[\w.-]+\/)/.test(v))) {
        el.removeAttribute(attr.name);
      }
    }
  }
  return body.innerHTML;
}

export function bar(cur, max, cls) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (cur / max) * 100)) : 0;
  return `<div class="pm-bar ${cls}"><i style="width:${pct.toFixed(1)}%"></i></div>`;
}

export const img = (src, cls = "") =>
  `<img ${cls ? `class="${cls}" ` : ""}src="${esc(src)}" alt="" onerror="this.style.visibility='hidden'">`;

/**
 * Next index for an arrow key in a grid of `selector` rows, found by LAYOUT
 * rather than index math: section headers span the full row, so after a section
 * with an odd count the columns no longer line up with `index ± 2`. Left/Right
 * stay in reading order; Up/Down pick the nearest row above/below, closest column.
 */
export function gridStep(root, selector, index, key) {
  const els = [...root?.querySelectorAll(selector) ?? []];
  const cur = els[index];
  if (!cur) return null;
  if (key === "ArrowLeft") return index > 0 ? index - 1 : null;
  if (key === "ArrowRight") return index < els.length - 1 ? index + 1 : null;
  const r0 = cur.getBoundingClientRect();
  const down = key === "ArrowDown";
  let best = null, bestScore = Infinity;
  els.forEach((el, i) => {
    const r = el.getBoundingClientRect();
    const dy = down ? r.top - r0.top : r0.top - r.top;
    if (dy < 4) return;                       // same row or wrong direction
    const score = dy * 1000 + Math.abs(r.left - r0.left);
    if (score < bestScore) { bestScore = score; best = i; }
  });
  return best;
}

export const cap = (s) => (s ? String(s)[0].toUpperCase() + String(s).slice(1) : "");

/**
 * The portrait row at the top of a per-character view: every character (and,
 * for the Item view, the Party Bag) as a chip, so one click jumps straight to
 * it instead of stepping with Q/E. `entries` = [{ id, name, img?, icon?, reserve?, comp? }];
 * reserve entries, then guests / summons (`comp` = their role), each sit after a divider. `info` = HTML for the selected entry,
 * shown to the right of the chips.
 */
export function portraitStrip(entries, selectedId, action, info = "") {
  let group = null;
  const chips = entries.map((e, i) => {
    const g = e.comp ? "comp" : e.reserve ? "reserve" : "party";
    const divider = i > 0 && g !== group ? `<span class="pm-chipsep" title="${g === "comp" ? "Guests & summons" : "Reserve"}"></span>` : "";
    group = g;
    const face = e.icon ? `<i class="fas ${esc(e.icon)} pm-bagicon"></i>` : img(e.img);
    const note = e.comp ? ` (${e.comp})` : e.reserve ? " (reserve)" : "";
    return `${divider}<span class="pm-pchip pm-hit ${e.id === selectedId ? "is-on" : ""} ${e.reserve ? "is-reserve" : ""} ${e.comp ? "is-comp" : ""}"
      data-action="${esc(action)}" data-id="${esc(e.id)}" title="${esc(e.name)}${esc(note)}">${face}</span>`;
  }).join("");
  // Q / E step through the same row, so their key caps sit at its two ends.
  const ends = entries.length > 1 ? [kbd("q"), kbd("e")] : ["", ""];
  return `<div class="pm-win pm-who pm-strip"><div class="pm-chips">${ends[0]}${chips}${ends[1]}</div><div class="pm-who-body pm-stripinfo">${info}</div></div>`;
}

const KEY_LABEL = { Enter: "Enter", Delete: "Del", Escape: "Esc", Tab: "Tab", u: "U", q: "Q", e: "E" };
/** A small key cap, for showing which key does what beside the thing it does. */
export const kbd = (k) => `<kbd class="pm-kbd">${esc(KEY_LABEL[k] ?? k)}</kbd>`;

/**
 * The bar at the top of every view: Back, the path to here (each earlier step
 * clickable), and this screen's actions as buttons that carry their key.
 * `crumbs` = [{ label, up }] where `up` is "main" or how many steps back the
 * crumb is; the last crumb is where you are. `actions` = [{ key, label, icon? }]
 * — a click sends that key, so a button can never do something the key doesn't.
 */
export function navBar(crumbs, actions = []) {
  const path = crumbs.map((c, i) => (i === crumbs.length - 1
    ? `<b class="pm-crumb is-here">${esc(c.label)}</b>`
    : `<span class="pm-crumb pm-hit" data-action="nav-crumb" data-up="${esc(c.up)}" title="Back to ${esc(c.label)}">${esc(c.label)}</span>`))
    .join(`<i class="fas fa-chevron-right pm-crumbsep"></i>`);
  const acts = actions.map((a) => `<button type="button" class="pm-btn pm-navact pm-hit" data-action="nav-key" data-key="${esc(a.key)}">`
    + `${a.icon ? `<i class="fas ${esc(a.icon)}"></i>` : ""}${esc(a.label)}${kbd(a.key)}</button>`).join("");
  return `<div class="pm-win pm-nav">
    <button type="button" class="pm-btn pm-navback pm-hit" data-action="nav-back" title="Back (Esc or right-click)"><i class="fas fa-chevron-left"></i>Back</button>
    <div class="pm-crumbs">${path}</div>
    <div class="pm-navacts">${acts}</div>
  </div>`;
}

/** Footer of an overlay window: its key hint and a Cancel button (a mouse user's Esc). */
export const overlayFoot = (hint) =>
  `<div class="pm-pickfoot"><span class="pm-hint">${esc(hint)}</span><button type="button" class="pm-btn pm-hit" data-action="nav-back">Cancel</button></div>`;
