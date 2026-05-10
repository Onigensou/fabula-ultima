// ============================================================================
// Dungeon Pathing System — In-Canvas Confirmation Buttons
// Renders two PIXI buttons directly on the scene stage, offset to the
// top-right of the party token:
//
//   ┌─────────────┐
//   │  ✔ Confirm  │  ← top button
//   ├─────────────┤
//   │  ⟲ Go Back  │  ← bottom button
//   └─────────────┘
//
// No pop-up dialog — everything lives in the game canvas.
// ============================================================================
(() => {
  const DP  = globalThis.DungeonPathing ??= {};
  const TAG = "[DungeonPathing][ConfirmUI]";

  // ── Layout constants ───────────────────────────────────────────────────────
  const BTN_W      = 160;
  const BTN_H      = 46;
  const BTN_GAP    = 5;
  const CORNER_R   = 10;
  const FONT_SIZE  = 17;

  // Colours
  const C = {
    confirmBg:     0x1a6b32,
    confirmHover:  0x22883f,
    revertBg:      0x5a3030,
    revertHover:   0x7a4040,
    border:        0xffffff,
    text:          0xffffff,
  };

  let _container = null;

  // ── Helpers ────────────────────────────────────────────────────────────────
  function destroyContainer() {
    try { _container?.destroy({ children: true }); } catch {}
    _container = null;
  }

  function makeButton(label, bgColor, hoverColor, onClick) {
    const root = new PIXI.Container();
    root.eventMode = "static";
    root.cursor    = "pointer";

    const bg = new PIXI.Graphics();

    function drawBg(color) {
      bg.clear();
      bg.lineStyle(1.5, C.border, 0.55);
      bg.beginFill(color, 0.92);
      bg.drawRoundedRect(0, 0, BTN_W, BTN_H, CORNER_R);
      bg.endFill();
    }
    drawBg(bgColor);
    root.addChild(bg);

    const text = new PIXI.Text(label, {
      fontFamily:      "Arial",
      fontSize:        FONT_SIZE,
      fontWeight:      "bold",
      fill:            C.text,
      stroke:          "#000000",
      strokeThickness: 2,
      align:           "center",
    });
    text.anchor.set(0.5, 0.5);
    text.x = BTN_W / 2;
    text.y = BTN_H / 2;
    root.addChild(text);

    // Hit area matches button size
    root.hitArea = new PIXI.Rectangle(0, 0, BTN_W, BTN_H);

    root.on("pointerover",  () => drawBg(hoverColor));
    root.on("pointerout",   () => drawBg(bgColor));
    root.on("pointerdown",  (ev) => {
      ev.stopPropagation?.();
      onClick();
    });

    return root;
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  DP.ConfirmDialog = {
    isOpen: false,

    /**
     * Show the in-canvas confirm buttons offset to the top-right of the token.
     * Returns a Promise<boolean>: true = confirm, false = go back.
     */
    ask(token) {
      destroyContainer();
      this.isOpen = true;

      return new Promise((resolve) => {
        const done = (result) => {
          this.isOpen = false;
          destroyContainer();
          resolve(result);
        };

        const root = new PIXI.Container();
        root.name   = "ONI DungeonPathing ConfirmUI";
        root.zIndex = 1000000;

        const confirmBtn = makeButton("✔  Confirm",  C.confirmBg, C.confirmHover, () => done(true));
        const revertBtn  = makeButton("⟲  Go Back",  C.revertBg,  C.revertHover,  () => done(false));

        confirmBtn.y = 0;
        revertBtn.y  = BTN_H + BTN_GAP;

        root.addChild(confirmBtn);
        root.addChild(revertBtn);

        // Position: top-right of the token, shifted right and slightly up
        const docX  = Number(token.document?.x ?? 0);
        const docY  = Number(token.document?.y ?? 0);
        const tokW  = Number(token.w ?? 100);
        const tokH  = Number(token.h ?? 100);

        root.x = docX + tokW + 14;
        root.y = docY + tokH / 2 - (BTN_H * 2 + BTN_GAP) / 2; // centred vertically beside token

        try {
          canvas.stage.sortableChildren = true;
          canvas.stage.addChild(root);
        } catch (e) {
          console.warn(TAG, "Could not add confirm buttons to stage", e);
          done(false);
          return;
        }

        _container = root;
      });
    },

    /** Force-close without resolution (called on deactivate / scene change). */
    forceClose() {
      this.isOpen = false;
      destroyContainer();
    }
  };
})();
