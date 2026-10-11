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
export function safeHtml(html) {
  const body = inert(html);
  body.querySelectorAll(DROP_TAGS).forEach((el) => el.remove());
  for (const el of body.querySelectorAll("*")) {
    for (const attr of [...el.attributes]) {
      const n = attr.name.toLowerCase();
      const v = attr.value.trim().toLowerCase();
      // Inline colour/weight styling is kept — descriptions are authored for the
      // parchment sheets and their keyword colours read correctly on it. Anything
      // that can fetch, overlay or script is not.
      const badStyle = n === "style" && /url\(|expression|position|behavior|binding|@import|z-index/.test(v);
      if (n.startsWith("on") || n === "srcdoc" || badStyle
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
