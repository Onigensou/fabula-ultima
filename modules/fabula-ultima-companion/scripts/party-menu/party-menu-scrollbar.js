// Party Menu — a drawn scrollbar for every list that scrolls.
//
// The native bar is hidden on these containers: Foundry's thin themed one barely
// shows against the parchment, and it differs per browser/OS. This one follows
// the usual desktop rules:
//   - shown only when the content is taller than the box;
//   - the thumb's length is the visible share of the list (box ÷ content), its
//     position the scrolled share — so it reads "how much is there, where am I";
//   - drag the thumb; click the track to page; the wheel over the bar scrolls.
// render() rebuilds the menu's DOM wholesale, so bars are re-attached after every
// render; the old ones go with the old DOM and their observers are dropped here.

const SCROLLERS = ".pm-skill-list, .pm-scroll, .pm-picker-list, .pm-effcard, .pm-cmpbody, .pm-aiwin";
const MIN_THUMB = 24;   // px — stays grabbable on a very long list
const INSET = 3;        // px — gap between the bar and the box's top/bottom/right edge

let _observers = [];

export function attachScrollbars(root) {
  for (const ro of _observers) ro.disconnect();
  _observers = [];
  if (!root) return;
  for (const el of root.querySelectorAll(SCROLLERS)) attach(el);
}

function attach(el) {
  const host = el.parentElement;
  if (!host) return;
  if (getComputedStyle(host).position === "static") host.style.position = "relative";
  const bar = document.createElement("div");
  bar.className = "pm-sbar";
  bar.setAttribute("aria-hidden", "true");
  const thumb = document.createElement("i");
  thumb.className = "pm-sbar-thumb";
  bar.appendChild(thumb);
  host.appendChild(bar);

  const layout = () => {
    const over = el.scrollHeight - el.clientHeight;
    if (over <= 1 || !el.isConnected) { bar.style.display = "none"; return; }
    bar.style.display = "";
    const track = el.clientHeight - INSET * 2;
    bar.style.top = `${el.offsetTop + INSET}px`;
    bar.style.height = `${track}px`;
    // Anchored on the right so the hover widening grows inward, over the list's own padding.
    bar.style.right = `${(el.offsetParent ?? host).clientWidth - (el.offsetLeft + el.clientWidth) + INSET}px`;
    const th = Math.min(track, Math.max(MIN_THUMB, Math.round(track * el.clientHeight / el.scrollHeight)));
    thumb.style.height = `${th}px`;
    thumb.style.transform = `translateY(${Math.round((track - th) * Math.min(1, el.scrollTop / over))}px)`;
  };

  el.addEventListener("scroll", layout, { passive: true });
  el.addEventListener("load", layout, true);   // an image in a description grows the content late
  const ro = new ResizeObserver(layout);
  ro.observe(el);
  for (const child of el.children) ro.observe(child);
  _observers.push(ro);

  thumb.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    thumb.setPointerCapture(e.pointerId);
    const y0 = e.clientY, s0 = el.scrollTop;
    const per = (el.scrollHeight - el.clientHeight) / Math.max(1, bar.clientHeight - thumb.offsetHeight);
    const move = (m) => { el.scrollTop = s0 + (m.clientY - y0) * per; };
    const up = () => {
      thumb.removeEventListener("pointermove", move);
      thumb.removeEventListener("pointerup", up);
      thumb.removeEventListener("pointercancel", up);
      bar.classList.remove("is-drag");
    };
    bar.classList.add("is-drag");
    thumb.addEventListener("pointermove", move);
    thumb.addEventListener("pointerup", up);
    thumb.addEventListener("pointercancel", up);
  });
  bar.addEventListener("pointerdown", (e) => {
    if (e.target === thumb) return;
    e.preventDefault();
    e.stopPropagation();
    const r = thumb.getBoundingClientRect();
    el.scrollBy({ top: (e.clientY < r.top ? -1 : 1) * el.clientHeight * 0.9 });
  });
  bar.addEventListener("click", (e) => e.stopPropagation());
  bar.addEventListener("wheel", (e) => { el.scrollTop += e.deltaY; e.preventDefault(); }, { passive: false });

  layout();
}
