// ============================================================================
// Opportunity Effect — Progress
//
// Effect: Fill or erase up to two sections on a Clock.
//
// Requires: Global Progress Clocks module (global-progress-clocks)
//   https://github.com/CarlosFdez/global-progress-clocks
//
// Implementation: GM picks a clock from the active list, chooses how many
// sections to fill (+1/+2) or erase (-1/-2), then the clock is updated via
// window.clockDatabase.update(). A result card is posted to chat.
// ============================================================================
(() => {
  const TAG = "[ONI][OpportunityEffect:Progress]";

  const esc = s => String(s ?? "")
    .replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");

  // ── Clock visualiser ──────────────────────────────────────────────────────────
  // Renders filled/empty dots for a clock value. Caps display at 16 to avoid
  // overflow for large "tracker" clocks.
  function renderDots(value, max, newValue = null) {
    const display = Math.min(max, 16);
    let out = "";
    for (let i = 0; i < display; i++) {
      const wasFilled   = i < value;
      const willBeFilled = newValue !== null ? i < newValue : wasFilled;
      let color, title;
      if (newValue !== null) {
        if (!wasFilled && willBeFilled)  { color = "#7ec87a"; title = "filling";  }  // new fill = green
        else if (wasFilled && !willBeFilled) { color = "#e08080"; title = "erasing"; }  // erasing = red
        else if (willBeFilled)           { color = "#f9a825"; title = "filled";   }  // was & stays filled
        else                             { color = "#555";    title = "empty";    }
      } else {
        color = wasFilled ? "#f9a825" : "#555";
        title = wasFilled ? "filled" : "empty";
      }
      out += `<span title="${title}" style="font-size:1.15rem;color:${color};line-height:1;">●</span>`;
    }
    if (max > display) out += `<span style="font-size:.8rem;opacity:.55;"> +${max - display}</span>`;
    return out;
  }

  // ── Post result card to chat ──────────────────────────────────────────────────
  async function postProgressCard({ actorName, clockName, oldValue, newValue, max }) {
    const filled  = newValue > oldValue;
    const accent  = filled ? "#2a6a8a" : "#8a3a2a";
    const verb    = filled ? "filled" : "erased";
    const count   = Math.abs(newValue - oldValue);
    const section = count === 1 ? "section" : "sections";

    const content = `
      <div style="
        font-family:'Signika',serif; padding:10px 13px; border-radius:10px;
        background:linear-gradient(160deg,#0d141a 0%,#0f1e2a 100%);
        border:2px solid ${esc(accent)}; color:#c8d8e8;
      ">
        <div style="font-size:.74rem;opacity:.6;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px;">
          <i class="fas fa-clock" style="margin-right:4px;"></i>Progress — ${esc(actorName)}
        </div>
        <div style="font-weight:900;font-size:.95rem;margin-bottom:6px;">${esc(clockName)}</div>
        <div style="margin-bottom:6px;letter-spacing:.06em;">${renderDots(oldValue, max, newValue)}</div>
        <div style="font-size:.82rem;opacity:.8;">
          ${esc(count)} ${section} ${esc(verb)} &nbsp;·&nbsp; ${oldValue} → ${newValue} / ${max}
        </div>
      </div>`;

    await ChatMessage.create({ content })
      .catch(e => console.error(TAG, "postProgressCard failed:", e));
  }

  // ── Effect handler ────────────────────────────────────────────────────────────
  Hooks.once("ready", () => {
    window["oni.OppEffectRegistry"]?.register("progress", async (ctx) => {

      // Guard: check module is loaded
      const db = window.clockDatabase;
      if (!db) {
        ui.notifications?.warn("[Opportunity] Global Progress Clocks module not active — cannot use Progress.");
        console.warn(TAG, "window.clockDatabase not found.");
        return;
      }

      // Collect all clocks
      const clocks = [];
      db.forEach(c => clocks.push(c));
      if (!clocks.length) {
        ui.notifications?.warn("[Opportunity] No clocks found. Create a clock first.");
        return;
      }

      // Build dialog — clock picker + delta control + live preview
      const result = await new Promise(resolve => {
        const opts = clocks.map((c, i) =>
          `<option value="${i}">${esc(c.name)} (${c.value}/${c.max})</option>`
        ).join("");

        const dlg = new Dialog({
          title:  "Progress — Choose Clock",
          content:`<div style="display:flex;flex-direction:column;gap:8px;padding:4px 0 4px;">
            <div>
              <label style="font-size:.82rem;opacity:.7;display:block;margin-bottom:3px;">Clock</label>
              <select id="oni-prog-clock" style="width:100%;padding:4px;">${opts}</select>
            </div>
            <div>
              <label style="font-size:.82rem;opacity:.7;display:block;margin-bottom:3px;">
                Sections to fill (+) or erase (−) &nbsp;<em style="opacity:.55;">(max ±2)</em>
              </label>
              <div style="display:flex;align-items:center;gap:8px;">
                <button id="oni-prog-minus" style="width:32px;font-size:1.1rem;line-height:1;padding:4px;">−</button>
                <input id="oni-prog-delta" type="number" min="-2" max="2" value="1"
                  style="flex:1;text-align:center;padding:4px;font-size:1rem;" />
                <button id="oni-prog-plus"  style="width:32px;font-size:1.1rem;line-height:1;padding:4px;">+</button>
              </div>
            </div>
            <div id="oni-prog-preview"
              style="background:rgba(255,255,255,.05);border-radius:6px;padding:8px 10px;min-height:38px;">
            </div>
          </div>`,
          buttons: {
            confirm: {
              label:    "Confirm",
              callback: html => {
                const idx   = parseInt(html.find("#oni-prog-clock").val() ?? "0", 10);
                const delta = parseInt(html.find("#oni-prog-delta").val() ?? "0", 10);
                resolve({
                  clock: clocks[Number.isFinite(idx) ? idx : 0],
                  delta: Math.max(-2, Math.min(2, Number.isFinite(delta) ? delta : 0)),
                });
              },
            },
            cancel: { label: "Cancel", callback: () => resolve(null) },
          },
          default: "confirm",
          close:   () => resolve(null),
          render:  html => {
            function updatePreview() {
              const idx   = parseInt(html.find("#oni-prog-clock").val() ?? "0", 10);
              const delta = parseInt(html.find("#oni-prog-delta").val() ?? "0", 10);
              const clock = clocks[Number.isFinite(idx) ? idx : 0];
              if (!clock) return;
              const safeDelta   = Math.max(-2, Math.min(2, Number.isFinite(delta) ? delta : 0));
              const newValue    = Math.max(0, Math.min(clock.max, clock.value + safeDelta));
              const preview     = html.find("#oni-prog-preview");
              preview.html(`
                <div style="margin-bottom:4px;">${renderDots(clock.value, clock.max, newValue)}</div>
                <div style="font-size:.78rem;opacity:.65;">
                  ${clock.value} → ${newValue} / ${clock.max}
                  ${newValue === clock.value ? ' <em>(no change)</em>' : ""}
                </div>`);
            }

            // clamp delta on change, keep within -2/+2
            html.find("#oni-prog-delta").on("input", () => {
              const el  = html.find("#oni-prog-delta");
              let v = parseInt(el.val(), 10);
              if (Number.isFinite(v)) el.val(Math.max(-2, Math.min(2, v)));
              updatePreview();
            });
            html.find("#oni-prog-clock").on("change", updatePreview);
            html.find("#oni-prog-minus").on("click", () => {
              const el = html.find("#oni-prog-delta");
              el.val(Math.max(-2, parseInt(el.val() ?? "0", 10) - 1));
              updatePreview();
            });
            html.find("#oni-prog-plus").on("click", () => {
              const el = html.find("#oni-prog-delta");
              el.val(Math.min(2, parseInt(el.val() ?? "0", 10) + 1));
              updatePreview();
            });

            updatePreview();  // populate immediately on open
          },
        });
        dlg.render(true);
      });

      if (!result) return;
      const { clock, delta } = result;
      if (delta === 0) return;

      const newValue = Math.max(0, Math.min(clock.max, clock.value + delta));
      if (newValue === clock.value) {
        ui.notifications?.info(`[Opportunity] "${clock.name}" is already at its limit.`);
        return;
      }

      await db.update({ id: clock.id, value: newValue })
        .catch(e => console.error(TAG, "clockDatabase.update failed:", e));

      await postProgressCard({
        actorName: ctx.actorName,
        clockName: clock.name,
        oldValue:  clock.value,
        newValue,
        max:       clock.max,
      });
    });
  });
})();
