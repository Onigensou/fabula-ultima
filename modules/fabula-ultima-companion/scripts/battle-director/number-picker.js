// number-picker.js — the BD's amount selector (picker-wheel Dialog).
//
// Extracted from skill-effects.js so it can be a ROUTABLE leaf picker, the same
// way list-picker.js / target-picker.js are: remote-pick.js renders it from a
// broadcast spec on the acting player's client while the GM races an identical
// local copy. Living inside skill-effects would have forced a player client to
// import the whole effect engine just to show a number prompt.
//
// `prompt_number` is the only caller (skill-effects.applyPromptNumberEffect);
// skill-effects re-exports promptNumberDialog so existing importers are
// unaffected. See remote-pick.js + [[director-player-driven-input]].

// Horizontal picker-wheel (carousel) amount selector. The value in the CENTER
// slot is the selection; the player drags the strip so the number they want lands
// in the middle, and numbers fade + shrink as they approach the left/right edges.
// Wheel-scroll and clicking a number also center it; snap-scroll settles on the
// nearest. Returns the chosen integer, or null if dismissed. Options are the
// stepped grid min, min+step, …, max.
//
// `externalCancel` (a thenable) dismisses an open dialog and resolves null —
// the tear-down signal remote-pick uses when the other side of the race wins.
export async function promptNumberDialog({ label, min, max, step = 1, def, title, externalCancel = null }) {
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const stp = Math.max(1, Math.floor(Number(step) || 1));
  const opts = [];
  for (let v = min; v <= max; v += stp) opts.push(v);
  if (!opts.length) opts.push(min);
  const initial = opts.includes(def) ? def : opts[opts.length - 1];
  return new Promise((resolve) => {
    let resolved = false;
    let selected = initial;
    let cleanup = null;
    const done = (v) => { if (!resolved) { resolved = true; try { cleanup?.(); } catch { /* noop */ } resolve(v); } };
    const content = `
      <style>
        .fud-numc-wrap{display:flex;flex-direction:column;gap:8px;padding:4px 2px;}
        .fud-numc-view{position:relative;overflow:hidden;padding:12px 0;width:288px;max-width:82vw;margin:0 auto;
          -webkit-mask-image:linear-gradient(90deg,transparent,#000 22%,#000 78%,transparent);
          mask-image:linear-gradient(90deg,transparent,#000 22%,#000 78%,transparent);}
        .fud-numc-slot{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);
          width:60px;height:46px;border-radius:10px;border:1px solid #5ab3d4;
          background:rgba(90,179,212,0.16);z-index:0;pointer-events:none;}
        .fud-numc-scroll{overflow-x:auto;scroll-snap-type:x mandatory;scrollbar-width:none;user-select:none;touch-action:pan-x;}
        .fud-numc-scroll::-webkit-scrollbar{display:none;}
        .fud-numc-track{display:flex;gap:6px;position:relative;width:max-content;min-width:max-content;}
        .fud-numc-item{flex:0 0 auto;scroll-snap-align:center;min-width:54px;padding:10px 4px;
          text-align:center;font-size:19px;font-weight:700;line-height:1;color:inherit;
          cursor:grab;user-select:none;z-index:1;transition:opacity .06s linear,transform .06s linear;}
        .fud-numc-grab{cursor:grabbing !important;}
      </style>
      <div class="fud-numc-wrap">
        <label style="font-size:13px;">${esc(label)}</label>
        <div class="fud-numc-view">
          <div class="fud-numc-slot"></div>
          <div class="fud-numc-scroll" role="slider" aria-label="${esc(label)}" aria-valuemin="${min}" aria-valuemax="${max}" aria-valuenow="${initial}" tabindex="0">
            <div class="fud-numc-track">
              ${opts.map((v) => `<div class="fud-numc-item" data-val="${v}">${v}</div>`).join("")}
            </div>
          </div>
        </div>
        <div style="font-size:11px;opacity:0.75;text-align:center;">Drag to spin · <b class="fud-numc-sel">${initial}</b> · step ${stp} · ${min}–${max}</div>
      </div>`;
    const dlg = new Dialog({
      title,
      content,
      buttons: {
        cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel", callback: () => done(null) },
        ok: { icon: '<i class="fas fa-check"></i>', label: "Confirm", callback: () => done(selected) },
      },
      default: "ok",
      // Cancel button / header-X / Escape all resolve null → the caller treats it as
      // an abort (no selection confirmed), NOT as picking the minimum.
      close: () => done(null),
      render: (html) => {
        const root = html?.[0] ?? html;
        const scroll = root?.querySelector?.(".fud-numc-scroll");
        const track = root?.querySelector?.(".fud-numc-track");
        const items = Array.from(root?.querySelectorAll?.(".fud-numc-item") ?? []);
        const selEl = root?.querySelector?.(".fud-numc-sel");
        if (!scroll || !track || !items.length) return;

        // Pad the track so the FIRST and LAST numbers can still reach the center.
        // Floor the width at the FIXED viewport width (288) so the padding is correct
        // even when this runs mid-animate-in while scroll.clientWidth still reads 0 —
        // that produced 0 padding → no overflow → nothing to drag.
        const VIEW_W = 288;
        const setPad = () => {
          const cw = Math.max(VIEW_W, scroll.clientWidth || 0);
          const iw = items[0].offsetWidth || 54;
          const p = Math.max(0, (cw - iw) / 2);
          track.style.paddingLeft = track.style.paddingRight = `${p}px`;
        };
        setPad();

        // Fade + shrink each number by its distance from center; the nearest number
        // is the live selection. Called SYNCHRONOUSLY (no requestAnimationFrame —
        // rAF is paused when the tab is backgrounded, which stalled the selection
        // update) on every scroll and directly during a drag.
        const update = () => {
          const cRect = scroll.getBoundingClientRect();
          const cx = cRect.left + cRect.width / 2;
          const half = (cRect.width / 2) || 1;
          let best = null, bestDist = Infinity;
          for (const it of items) {
            const r = it.getBoundingClientRect();
            const dist = Math.abs((r.left + r.width / 2) - cx);
            const ratio = Math.min(1, dist / half);
            it.style.opacity = String(Math.max(0.12, 1 - 0.9 * ratio));
            it.style.transform = `scale(${(1 - 0.34 * ratio).toFixed(3)})`;
            if (dist < bestDist) { bestDist = dist; best = it; }
          }
          if (best) {
            selected = Number(best.dataset.val);
            if (selEl) selEl.textContent = String(selected);
            scroll.setAttribute("aria-valuenow", String(selected));
          }
        };
        scroll.addEventListener("scroll", update, { passive: true });

        const centerOn = (el, smooth = true) => {
          const cRect = scroll.getBoundingClientRect();
          const r = el.getBoundingClientRect();
          scroll.scrollBy({ left: (r.left + r.width / 2) - (cRect.left + cRect.width / 2), behavior: smooth ? "smooth" : "auto" });
          update();
        };

        // Vertical wheel → horizontal spin.
        scroll.addEventListener("wheel", (e) => { if (e.deltaY) { scroll.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });

        // Mouse drag-to-spin. `mousedown` on the strip, but `mousemove`/`mouseup`
        // on `document` so a fast drag that leaves the strip keeps tracking. Snap is
        // disabled WHILE dragging — `scroll-snap-type: mandatory` otherwise keeps
        // yanking scrollLeft back to a snap point, which is exactly what made the
        // drag look frozen — then re-enabled + centered on release. Touch uses the
        // native snap-scroll (touch-action: pan-x), so it needs no JS drag.
        let isDown = false, startX = 0, startScroll = 0, moved = false;
        const moveDrag = (e) => {
          if (!isDown) return;
          const dx = e.clientX - startX;
          if (Math.abs(dx) > 3) moved = true;
          scroll.scrollLeft = startScroll - dx;
          update();
          e.preventDefault();
        };
        const endDrag = () => {
          if (!isDown) return;
          isDown = false; scroll.classList.remove("fud-numc-grab");
          scroll.style.scrollSnapType = "x mandatory";
          const cRect = scroll.getBoundingClientRect();
          const cx = cRect.left + cRect.width / 2;
          let best = null, bd = Infinity;
          for (const it of items) { const r = it.getBoundingClientRect(); const d = Math.abs((r.left + r.width / 2) - cx); if (d < bd) { bd = d; best = it; } }
          if (best) centerOn(best);
        };
        scroll.addEventListener("mousedown", (e) => {
          isDown = true; moved = false; startX = e.clientX; startScroll = scroll.scrollLeft;
          scroll.style.scrollSnapType = "none"; scroll.classList.add("fud-numc-grab");
          e.preventDefault();
        });
        document.addEventListener("mousemove", moveDrag);
        document.addEventListener("mouseup", endDrag);
        cleanup = () => {
          document.removeEventListener("mousemove", moveDrag);
          document.removeEventListener("mouseup", endDrag);
        };

        // Click a number to bring it to the center (unless it was a drag).
        for (const it of items) it.addEventListener("click", () => { if (!moved) centerOn(it); });
        // Arrow keys nudge the selection.
        scroll.addEventListener("keydown", (e) => {
          const i = items.findIndex((x) => Number(x.dataset.val) === selected);
          if (e.key === "ArrowRight" && i < items.length - 1) { centerOn(items[i + 1]); e.preventDefault(); }
          else if (e.key === "ArrowLeft" && i > 0) { centerOn(items[i - 1]); e.preventDefault(); }
        });

        // Center the default value on open, and RE-center whenever the strip's size
        // changes. Foundry animates the dialog in, so the scroll box often has width
        // 0 on the first render pass — a single early setPad() then leaves the track
        // with no padding and (with only a few options) NO scrollable overflow, which
        // is exactly why the drag moved nothing (scrollLeft pinned at 0). A
        // ResizeObserver recomputes padding + centering once the real width lands; the
        // fixed viewport width also guarantees overflow regardless of option count.
        const initEl = items.find((it) => Number(it.dataset.val) === initial) ?? items[items.length - 1];
        const recenter = () => { setPad(); const cur = items.find((it) => Number(it.dataset.val) === selected) ?? initEl; centerOn(cur, false); update(); };
        recenter();
        setTimeout(recenter, 30);
        setTimeout(recenter, 200);
        let ro = null;
        try { ro = new ResizeObserver(() => recenter()); ro.observe(scroll); } catch (e) { /* noop */ }
        const dragCleanup = cleanup;
        cleanup = () => { try { ro?.disconnect(); } catch (e) { /* noop */ } dragCleanup?.(); };
      },
    });
    dlg.render(true);
    // Race lost / caller tore the prompt down — close the dialog. Its own
    // `close` handler resolves null, and `done` is idempotent, so a dismissal
    // that arrives after the user already confirmed is a no-op.
    if (externalCancel && typeof externalCancel.then === "function") {
      externalCancel.then(() => { try { dlg.close(); } catch { /* already gone */ } done(null); }).catch(() => {});
    }
  });
}
