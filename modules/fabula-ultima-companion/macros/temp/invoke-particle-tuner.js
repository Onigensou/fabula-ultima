// ============================================================================
// Invoke Particle Live Tuner • Foundry VTT v12
// ----------------------------------------------------------------------------
// Select a token on the canvas first, then run.
// Adjust sliders to tune the aura particle effect, then click "Copy Values"
// and paste the output back into invoke-hud.js.
// ============================================================================

(function invokeTuner() {
  const STYLE_ID = "fud-pt-style";
  const AURA_ID  = "fud-pt-aura";
  const PANEL_ID = "fud-pt-panel";

  // ── Current values (start from live invoke-hud.js values) ─────────────────
  let cfg = {
    w:     1.5,      // particle width px
    h:     22,       // particle height px
    scale: 1.85,     // aura container = max(token w,h) * scale
    rise:  130,      // how far up particles travel px
    cycle: 0.75,     // animation cycle seconds
    color: "#ff781e" // core particle colour (orange)
  };

  // ── Particle layout (mirror of invoke-hud.js _PARTICLES) ──────────────────
  const PARTICLES = [
    { lp: 30, tp: 88, dx: -6, delay: 0.00 },
    { lp: 55, tp: 85, dx:  4, delay: 0.14 },
    { lp: 44, tp: 92, dx:  0, delay: 0.28 },
    { lp: 70, tp: 87, dx:  8, delay: 0.40 },
    { lp: 22, tp: 90, dx: -9, delay: 0.55 },
    { lp: 51, tp: 84, dx:  5, delay: 0.08 },
    { lp: 38, tp: 91, dx: -4, delay: 0.68 },
    { lp: 63, tp: 89, dx:  7, delay: 0.32 },
    { lp: 46, tp: 86, dx: -2, delay: 0.47 },
    { lp: 76, tp: 93, dx: -7, delay: 0.62 },
    { lp: 15, tp: 88, dx:  3, delay: 0.22 },
    { lp: 58, tp: 86, dx:  6, delay: 0.75 },
  ];

  // ── Helpers ────────────────────────────────────────────────────────────────

  function hexToRgb(hex) {
    const h = hex.replace("#", "");
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
    };
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function updateStyle() {
    let s = document.getElementById(STYLE_ID);
    if (!s) { s = document.createElement("style"); s.id = STYLE_ID; document.head.appendChild(s); }
    const { r, g, b } = hexToRgb(cfg.color);
    const bright = `rgba(${clamp(r+20,0,255)},${clamp(g+50,0,255)},${clamp(b+30,0,255)},1)`;
    const mid    = `rgba(${r},${g},${b},.9)`;
    const edge   = `rgba(${r},${g},${b},0)`;
    s.textContent = `
      #${AURA_ID} {
        position: fixed;
        pointer-events: none;
        transform: translate(-50%, -50%);
        z-index: 9000;
      }
      .fud-pt-particle {
        position: absolute;
        width: ${cfg.w}px;
        height: ${cfg.h}px;
        border-radius: 1px;
        background: linear-gradient(to bottom,
          ${edge}   0%,
          ${mid}   35%,
          ${bright} 50%,
          ${mid}   65%,
          ${edge}  100%);
        box-shadow: 0 0 4px ${mid};
        animation: fud-pt-rise ${cfg.cycle}s linear infinite both;
      }
      @keyframes fud-pt-rise {
        0%   { opacity: 0;   transform: translateY(10px)           translateX(0); }
        12%  { opacity: 1; }
        75%  { opacity: 0.7; }
        100% { opacity: 0;   transform: translateY(-${cfg.rise}px) translateX(var(--pdx, 0px)); }
      }
    `;
  }

  function getTokenCenter() {
    const token = canvas?.tokens?.controlled?.[0];
    if (!token) return { cx: window.innerWidth / 2, cy: window.innerHeight / 2, tokenSize: 100 };
    try {
      const st     = canvas.stage?.worldTransform;
      const board  = document.getElementById("board");
      const bounds = board?.getBoundingClientRect() ?? { left: 0, top: 0 };
      const tw     = token.w ?? 100;
      const th     = token.h ?? 100;
      const cx     = bounds.left + (token.x + tw / 2) * st.a + st.tx;
      const cy     = bounds.top  + (token.y + th / 2) * st.d + st.ty;
      return { cx, cy, tokenSize: Math.max(tw, th) * st.a };
    } catch { return { cx: window.innerWidth / 2, cy: window.innerHeight / 2, tokenSize: 100 }; }
  }

  function rebuildAura() {
    document.getElementById(AURA_ID)?.remove();
    const { cx, cy, tokenSize } = getTokenCenter();
    const size = tokenSize * cfg.scale;
    const el   = document.createElement("div");
    el.id            = AURA_ID;
    el.style.left    = `${cx}px`;
    el.style.top     = `${cy}px`;
    el.style.width   = `${size}px`;
    el.style.height  = `${size}px`;
    for (const p of PARTICLES) {
      const span = document.createElement("span");
      span.className = "fud-pt-particle";
      span.style.left = `${p.lp}%`;
      span.style.top  = `${p.tp}%`;
      span.style.setProperty("--pdx", `${p.dx}px`);
      span.style.animationDelay = `${p.delay}s`;
      el.appendChild(span);
    }
    document.body.appendChild(el);
  }

  function apply() { updateStyle(); rebuildAura(); }

  function cleanup() {
    document.getElementById(AURA_ID)?.remove();
    document.getElementById(STYLE_ID)?.remove();
    document.getElementById(PANEL_ID)?.remove();
  }

  // ── Tuner panel ────────────────────────────────────────────────────────────

  function buildPanel() {
    document.getElementById(PANEL_ID)?.remove();

    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    Object.assign(panel.style, {
      position:   "fixed", top: "20px", right: "340px", width: "290px",
      zIndex:     "9001",  background: "#1e1e1e", color: "#eee",
      borderRadius: "10px", padding: "14px 16px",
      fontFamily: "monospace", fontSize: "13px",
      boxShadow:  "0 8px 32px rgba(0,0,0,.85)",
      border:     "1px solid #444",
    });

    // Title
    const title = document.createElement("div");
    Object.assign(title.style, { fontSize: "14px", fontWeight: "bold", color: "#ff9040", marginBottom: "12px" });
    title.textContent = "⚡ Particle Tuner";
    panel.appendChild(title);

    // Helper: labelled slider row
    function addSlider({ label, min, max, step, key, fmt }) {
      const row = document.createElement("div");
      Object.assign(row.style, { display: "flex", alignItems: "center", gap: "8px", marginBottom: "9px" });

      const lbl = document.createElement("span");
      Object.assign(lbl.style, { width: "84px", flexShrink: "0", color: "#999" });
      lbl.textContent = label;

      const inp = document.createElement("input");
      inp.type  = "range"; inp.min = min; inp.max = max; inp.step = step;
      inp.value = cfg[key];
      Object.assign(inp.style, { flex: "1", accentColor: "#ff781e" });

      const val = document.createElement("span");
      Object.assign(val.style, { minWidth: "44px", textAlign: "right", color: "#fff", fontWeight: "bold" });
      val.textContent = fmt ? fmt(cfg[key]) : cfg[key];

      inp.addEventListener("input", () => {
        cfg[key] = +inp.value;
        val.textContent = fmt ? fmt(cfg[key]) : cfg[key];
        apply();
      });
      row.append(lbl, inp, val);
      panel.appendChild(row);
    }

    addSlider({ label: "Width (px)",  min: 0.5, max: 5,   step: 0.5,  key: "w",     fmt: v => v + "px" });
    addSlider({ label: "Height (px)", min: 8,   max: 60,  step: 1,    key: "h",     fmt: v => v + "px" });
    addSlider({ label: "Container×",  min: 1.0, max: 3.0, step: 0.05, key: "scale", fmt: v => v + "×"  });
    addSlider({ label: "Rise (px)",   min: 50,  max: 250, step: 5,    key: "rise",  fmt: v => v + "px" });
    addSlider({ label: "Speed (s)",   min: 0.3, max: 2.0, step: 0.05, key: "cycle", fmt: v => v + "s"  });

    // Colour picker row
    const colorRow = document.createElement("div");
    Object.assign(colorRow.style, { display: "flex", alignItems: "center", gap: "8px", marginBottom: "9px" });
    const colorLbl = document.createElement("span");
    Object.assign(colorLbl.style, { width: "84px", flexShrink: "0", color: "#999" });
    colorLbl.textContent = "Colour";
    const colorInp = document.createElement("input");
    colorInp.type  = "color"; colorInp.value = cfg.color;
    Object.assign(colorInp.style, { flex: "1", height: "30px", border: "none", padding: "0", cursor: "pointer", background: "none", borderRadius: "4px" });
    const colorVal = document.createElement("span");
    Object.assign(colorVal.style, { minWidth: "64px", textAlign: "right", color: "#fff", fontWeight: "bold" });
    colorVal.textContent = cfg.color;
    colorInp.addEventListener("input", () => { cfg.color = colorInp.value; colorVal.textContent = cfg.color; apply(); });
    colorRow.append(colorLbl, colorInp, colorVal);
    panel.appendChild(colorRow);

    // Divider
    const hr = document.createElement("hr");
    Object.assign(hr.style, { border: "none", borderTop: "1px solid #333", margin: "10px 0" });
    panel.appendChild(hr);

    // Copy Values button
    const copyBtn = document.createElement("button");
    copyBtn.textContent = "📋  Copy Values";
    Object.assign(copyBtn.style, {
      width: "100%", marginBottom: "6px", padding: "7px",
      borderRadius: "6px", background: "#333", color: "#eee",
      border: "1px solid #555", cursor: "pointer", fontSize: "13px",
    });
    copyBtn.addEventListener("click", () => {
      const out = [
        `// invoke-hud.js particle values`,
        `width:  ${cfg.w}px`,
        `height: ${cfg.h}px`,
        `scale:  ${cfg.scale}   // aura container multiplier`,
        `rise:   ${cfg.rise}px  // translateY distance`,
        `cycle:  ${cfg.cycle}s  // animation-duration`,
        `color:  ${cfg.color}   // core gradient colour`,
      ].join("\n");
      navigator.clipboard?.writeText(out).catch(() => {});
      console.log("[ParticleTuner]\n" + out);
      copyBtn.textContent = "✅  Copied to clipboard + console";
      setTimeout(() => { copyBtn.textContent = "📋  Copy Values"; }, 2000);
    });
    panel.appendChild(copyBtn);

    // Close button
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "✖  Close & remove preview";
    Object.assign(closeBtn.style, {
      width: "100%", padding: "7px",
      borderRadius: "6px", background: "#2a1515", color: "#ff7070",
      border: "1px solid #552", cursor: "pointer", fontSize: "13px",
    });
    closeBtn.addEventListener("click", cleanup);
    panel.appendChild(closeBtn);

    document.body.appendChild(panel);
  }

  // ── Init ───────────────────────────────────────────────────────────────────
  cleanup(); // remove any previous instance
  apply();
  buildPanel();

})();
