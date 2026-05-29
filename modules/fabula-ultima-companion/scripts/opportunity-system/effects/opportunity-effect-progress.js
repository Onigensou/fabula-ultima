// ============================================================================
// Opportunity Effect — Progress
// Requires: Global Progress Clocks (global-progress-clocks)
//
// Flow (pre/post):
//   pre  — clock picker + delta dialog; returns { clockId, clockName, oldValue, newValue, max }
//   post — applies the clock update and posts the result chat card
// ============================================================================
(() => {
  const TAG = "[ONI][OpportunityEffect:Progress]";

  const esc = s => String(s ?? "")
    .replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");

  function renderDots(value, max, newValue = null) {
    const display = Math.min(max, 16);
    let out = "";
    for (let i = 0; i < display; i++) {
      const wasFilled    = i < value;
      const willBeFilled = newValue !== null ? i < newValue : wasFilled;
      let color;
      if (newValue !== null) {
        if (!wasFilled && willBeFilled)      color = "#7ec87a";
        else if (wasFilled && !willBeFilled) color = "#e08080";
        else if (willBeFilled)               color = "#f9a825";
        else                                 color = "#555";
      } else {
        color = wasFilled ? "#f9a825" : "#555";
      }
      out += `<span style="font-size:1.15rem;color:${color};line-height:1;">●</span>`;
    }
    if (max > display) out += `<span style="font-size:.8rem;opacity:.55;"> +${max - display}</span>`;
    return out;
  }

  async function postProgressCard({ actorName, clockName, oldValue, newValue, max }) {
    const filled  = newValue > oldValue;
    const accent  = filled ? "#2a6a8a" : "#8a3a2a";
    const verb    = filled ? "filled" : "erased";
    const count   = Math.abs(newValue - oldValue);
    const content = `
      <div style="font-family:'Signika',serif;padding:10px 13px;border-radius:10px;
        background:linear-gradient(160deg,#0d141a 0%,#0f1e2a 100%);
        border:2px solid ${esc(accent)};color:#c8d8e8;">
        <div style="font-size:.74rem;opacity:.6;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px;">
          <i class="fas fa-clock" style="margin-right:4px;"></i>Progress — ${esc(actorName)}
        </div>
        <div style="font-weight:900;font-size:.95rem;margin-bottom:6px;">${esc(clockName)}</div>
        <div style="margin-bottom:6px;">${renderDots(oldValue, max, newValue)}</div>
        <div style="font-size:.82rem;opacity:.8;">
          ${count} section${count !== 1 ? "s" : ""} ${esc(verb)} &nbsp;·&nbsp; ${oldValue} → ${newValue} / ${max}
        </div>
      </div>`;
    await ChatMessage.create({ content }).catch(e => console.error(TAG, "postProgressCard failed:", e));
  }

  Hooks.once("ready", () => {
    window["oni.OppEffectRegistry"]?.register("progress", {

      // ── Pre phase: clock + delta selection ────────────────────────────────
      async pre(ctx) {
        console.debug(TAG, "[entry]", { actorUuid: ctx.actorUuid, actorName: ctx.actorName });

        const db = window.clockDatabase;
        console.debug(TAG, "[pre] window.clockDatabase:", db ? "FOUND" : "NOT FOUND");
        if (!db) {
          ui.notifications?.warn("[Opportunity] Global Progress Clocks module not active.");
          console.warn(TAG, "[pre] window.clockDatabase missing");
          return null;
        }

        const clocks = [];
        db.forEach(c => clocks.push(c));
        console.debug(TAG, "[pre] clocks found:", clocks.map(c => `${c.name} (${c.value}/${c.max})`));
        if (!clocks.length) {
          ui.notifications?.warn("[Opportunity] No clocks found.");
          console.warn(TAG, "[pre] no clocks");
          return null;
        }

        console.debug(TAG, "[pre] opening clock picker dialog...");
        const result = await new Promise(resolve => {
          const opts = clocks.map((c, i) =>
            `<option value="${i}">${esc(c.name)} (${c.value}/${c.max})</option>`
          ).join("");

          const dlg = new Dialog({
            title:   "Progress — Choose Clock",
            content: `<div style="display:flex;flex-direction:column;gap:8px;padding:4px 0 4px;">
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
                  <button id="oni-prog-plus" style="width:32px;font-size:1.1rem;line-height:1;padding:4px;">+</button>
                </div>
              </div>
              <div id="oni-prog-preview"
                style="background:rgba(255,255,255,.05);border-radius:6px;padding:8px 10px;min-height:38px;"></div>
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
            render: html => {
              function updatePreview() {
                const idx   = parseInt(html.find("#oni-prog-clock").val() ?? "0", 10);
                const delta = parseInt(html.find("#oni-prog-delta").val() ?? "0", 10);
                const clock = clocks[Number.isFinite(idx) ? idx : 0];
                if (!clock) return;
                const safeDelta = Math.max(-2, Math.min(2, Number.isFinite(delta) ? delta : 0));
                const newValue  = Math.max(0, Math.min(clock.max, clock.value + safeDelta));
                html.find("#oni-prog-preview").html(`
                  <div style="margin-bottom:4px;">${renderDots(clock.value, clock.max, newValue)}</div>
                  <div style="font-size:.78rem;opacity:.65;">
                    ${clock.value} → ${newValue} / ${clock.max}
                    ${newValue === clock.value ? ' <em>(no change)</em>' : ""}
                  </div>`);
              }
              html.find("#oni-prog-delta").on("input", () => {
                const el = html.find("#oni-prog-delta");
                const v  = parseInt(el.val(), 10);
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
              updatePreview();
            },
          });
          dlg.render(true);
        });

        console.debug(TAG, "[pre] dialog result:", result ? { clockName: result.clock?.name, delta: result.delta } : "NULL");
        if (!result) { console.debug(TAG, "[pre] dialog cancelled"); return null; }

        const { clock, delta } = result;
        if (delta === 0) { console.debug(TAG, "[pre] delta is 0, no change"); return null; }

        const newValue = Math.max(0, Math.min(clock.max, clock.value + delta));
        if (newValue === clock.value) {
          ui.notifications?.info(`[Opportunity] "${clock.name}" is already at its limit.`);
          console.debug(TAG, "[pre] clock already at limit");
          return null;
        }

        return { clockId: clock.id, clockName: clock.name, oldValue: clock.value, newValue, max: clock.max };
      },

      // ── Post phase: apply clock update + post result card ──────────────────
      async post(ctx, preResult) {
        const { clockId, clockName, oldValue, newValue, max } = preResult ?? {};

        const db = window.clockDatabase;
        if (!db) { console.error(TAG, "[post] clockDatabase not available"); return; }

        console.debug(TAG, "[post] updating clock:", clockName, "|", oldValue, "→", newValue);
        await db.update({ id: clockId, value: newValue })
          .catch(e => console.error(TAG, "[post] clockDatabase.update failed:", e));

        console.debug(TAG, "[post] posting result card...");
        await postProgressCard({ actorName: ctx.actorName, clockName, oldValue, newValue, max });
        console.debug(TAG, "[done]");
      },
    });
  });
})();
