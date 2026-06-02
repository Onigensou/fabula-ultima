/**
 * [ONI] Opportunity System — Chat Card
 * Posts a styled ChatMessage announcing a spent opportunity.
 * Visible to all users.
 */
(() => {
  const TAG       = "[ONI][OpportunitySystem:ChatCard]";
  const MODULE_ID = "fabula-ultima-companion";

  const esc = s => String(s ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

  /**
   * Resolve the best available portrait for an actor.
   * Falls back through standard sprite → active token → proto token → actor img.
   */
  function resolvePortrait(actor) {
    if (!actor) return "icons/svg/mystery-man.svg";
    const std   = String(actor.system?.props?.sprite_standard ?? "").trim();
    const token = String(actor.getActiveTokens?.(true, true)?.[0]?.document?.texture?.src ?? "").trim();
    const proto = String(actor.prototypeToken?.texture?.src ?? "").trim();
    return std || token || proto || actor.img || "icons/svg/mystery-man.svg";
  }

  /**
   * Post a ChatMessage announcing the spent opportunity.
   *
   * @param {object} opts
   * @param {string}  opts.actorUuid   UUID of the actor who spent the opportunity
   * @param {string}  opts.actorName   Display name
   * @param {string}  opts.optionId    ID from opportunity-config (e.g. "advantage")
   * @param {object}  opts.option      Full option object from OpportunityConfig.OPTIONS
   * @param {object}  [opts.context]   Caller metadata, echoed into flags
   */
  async function postOpportunityCard({ actorUuid, actorName, optionId, option, context = {} }) {
    const actor    = actorUuid ? (await fromUuid(actorUuid).catch(() => null)) : null;
    const realActor = actor?.actor ?? (actor?.documentName === "Actor" ? actor : null);
    const portrait  = resolvePortrait(realActor);
    const isVideo   = /\.(webm|mp4|ogg)(\?|$)/i.test(portrait);

    const tokenMedia = isVideo
      ? `<video src="${esc(portrait)}" autoplay loop muted playsinline preload="auto"
           style="width:48px;height:48px;object-fit:contain;border:none;background:transparent;"></video>`
      : `<img src="${esc(portrait)}" alt=""
           style="width:48px;height:48px;object-fit:contain;border:none!important;background:transparent!important;
                  box-shadow:none!important;filter:none!important;border-radius:0!important;"
           onerror="this.src='icons/svg/mystery-man.svg'">`;

    const accentColor = option?.color ?? "#fcd470";

    const content = `
      <div style="
        font-family: 'Signika', serif;
        padding: 10px 13px 9px;
        border-radius: 10px;
        background: linear-gradient(160deg, #1c1408 0%, #2a1e0a 100%);
        border: 2px solid ${esc(accentColor)};
        color: #f6ebd3;
        display: flex;
        align-items: center;
        gap: 12px;
      ">
        <div style="flex-shrink:0;">${tokenMedia}</div>
        <div style="flex:1;min-width:0;">
          <div style="font-size:.78rem;opacity:.65;letter-spacing:.06em;text-transform:uppercase;margin-bottom:2px;">
            ✦ Opportunity Spent
          </div>
          <div style="font-weight:900;font-size:.95rem;line-height:1.2;margin-bottom:3px;">
            ${esc(actorName)}
          </div>
          <div style="
            display:inline-block;
            font-size:.82rem;font-weight:800;
            background:rgba(255,255,255,.08);
            border:1.5px solid ${esc(accentColor)};
            border-radius:6px;
            padding:2px 9px;
            color:${esc(accentColor)};
            margin-bottom:4px;
          ">
            ${option?.icon ? `<i class="fas ${esc(option.icon)}" style="margin-right:5px;"></i>` : ""}${esc(option?.label ?? optionId)}
          </div>
          <div style="font-size:.78rem;opacity:.75;line-height:1.4;">
            ${esc(option?.description ?? "")}
          </div>
        </div>
      </div>`;

    await ChatMessage.create({
      content,
      flags: {
        [MODULE_ID]: {
          opportunityResult: { actorUuid, optionId, context },
        },
      },
    }).catch(e => console.error(TAG, "Failed to post opportunity card:", e));
  }

  window["oni.OpportunityChatCard"] = Object.freeze({ postOpportunityCard });

  console.debug(`${TAG} Ready.`);
})();
