// scripts/refinement-system/refinement-bootstrap.js

Hooks.once("ready", () => {
  _rfInjectChatStyles();

  const handler = new RefinementSocketHandler();
  game.socket.on(REFINEMENT_CHANNEL, handler._onSocket);

  const mod = game.modules.get("fabula-ultima-companion");
  if (mod) {
    mod.api ??= {};
    mod.api.refinement = {
      refine:             ({ itemUuid, actorUuid, refinerActorUuid = null }) =>
                            handler.requestRefine({ itemUuid, actorUuid, refinerActorUuid }),
      broadcastFeedback:  (payload) => handler.broadcastRefineFeedback(payload),
      canRefine:          rfCanRefine,
      getRefineLevel:     rfGetRefineLevel,
      getMaxRefineLevel:  rfGetMaxRefineLevel,
      getSuccessRate:     rfGetSuccessRate,
      getBreakRate:       rfGetBreakRate,
      getCost:            rfGetCost,
      computeBonus:       rfComputeBonus,
      buildDisplayName:   rfBuildDisplayName,
    };
  }

  console.log("[FU Companion] Refinement system ready.");
});

function _rfInjectChatStyles() {
  const STYLE_ID = "fu-refine-chat-style";
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
/* ── Refinement chat message: hide speaker header ── */
.fu-refine-msg .message-header { display: none !important; }
.fu-refine-msg .message-content { padding: 2px 0 !important; }

/* ── Refinement result card ── */
.fu-refine-card {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px 5px 6px;
  background: #e8dfc8;
  border: 1px solid #b09060;
  border-left: 4px solid #7a5c38;
  border-radius: 6px;
  font-size: 12px;
  font-family: inherit;
  color: #2c1a0a;
  line-height: 1.4;
}
.fu-rc-success { border-left-color: #3a7a3a; }
.fu-rc-fail    { border-left-color: #7a5c38; }
.fu-rc-break   { border-left-color: #9a2a1a; }

.fu-rc-portrait {
  width: 30px; height: 30px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
  border: 1px solid rgba(122,92,56,0.35) !important;
  box-shadow: none !important;
}

.fu-rc-body {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
}

.fu-rc-icon { font-size: 13px; line-height: 1; }

.fu-rc-from { font-weight: 700; color: #4a2f10; }
.fu-rc-sep  { color: #7a5c38; font-weight: 700; }

.fu-rc-to-success { font-weight: 800; color: #2a6a2a; }
.fu-rc-to-fail    { font-style: italic; color: #7a5c38; opacity: 0.75; font-size: 11px; }
.fu-rc-to-break   { font-weight: 800; color: #9a2a1a; }

.fu-rc-tag {
  font-size: 9px; font-weight: 800; letter-spacing: 0.05em;
  padding: 1px 5px; border-radius: 10px;
  background: rgba(154,42,26,0.15); color: #9a2a1a;
  border: 1px solid rgba(154,42,26,0.3);
  text-transform: uppercase;
}
  `;
  document.head.appendChild(s);
}
