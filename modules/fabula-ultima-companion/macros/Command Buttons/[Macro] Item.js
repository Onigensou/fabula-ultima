// ============================================================================
// Foundry VTT v12 – Item Button (Use/Create tabs) → ActionDataFetch
//
// Use mode:
//   - Traditional JRPG item usage.
//   - Reads actor.system.props.consumable_list.
//   - Requires owned quantity.
//   - Later execution consumes item quantity.
//
// Create mode:
//   - Fabula Ultima "create item with IP" usage.
//   - Reads recipes through scripts/Item-create.js API.
//   - Does NOT require owned item quantity.
//   - Sends IP cost into the pipeline through meta.costRawFinal.
// ============================================================================

(async () => {
  const ACTION_DATA_FETCH_NAME = "ActionDataFetch";
  const TAG = "[ONI][Item]";
  const DEBUG = true;

  const log  = (...args) => DEBUG && console.log(TAG, ...args);
  const warn = (...args) => DEBUG && console.warn(TAG, ...args);
  const err  = (...args) => DEBUG && console.error(TAG, ...args);

  // --------------------------------------------------------------------------
  // Cursor-move sound
  // --------------------------------------------------------------------------

  const SOUND_URL          = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/CursorMove.mp3";
  const SOUND_COOLDOWN_MS  = 90;
  let   _lastSoundTimeItem = 0;

  function playMove() {
    const now = (typeof performance !== "undefined" && performance.now)
      ? performance.now()
      : Date.now();

    if (now - _lastSoundTimeItem < SOUND_COOLDOWN_MS) return;
    _lastSoundTimeItem = now;

    try {
      AudioHelper.play(
        {
          src: SOUND_URL,
          volume: 0.5,
          autoplay: true,
          loop: false
        },
        false
      );
    } catch (e) {
      console.warn("Item dialog cursor sound failed:", e);
    }
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  function resolveActorForUser(user) {
    // 1) If GM: prefer selected token
    if (user.isGM) {
      const controlled = canvas.tokens.controlled[0];
      if (controlled?.actor) return controlled.actor;

      // Fallback: first token with an actor
      const ownedToken = canvas.tokens.placeables.find(t => t.actor);
      return ownedToken?.actor ?? null;
    }

    // 2) Player: prefer their linked character
    if (user.character) {
      return game.actors.get(user.character.id) ?? null;
    }

    // 3) Fallback: first token the user owns
    const candidate = canvas.tokens.placeables.find(t => {
      return t.actor && t.actor.testUserPermission(user, "OWNER");
    });

    return candidate?.actor ?? null;
  }

  function htmlEscape(str = "") {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function stripTags(html = "") {
    try {
      const tmp = document.createElement("div");
      tmp.innerHTML = String(html ?? "");
      return tmp.textContent ?? tmp.innerText ?? "";
    } catch {
      return String(html ?? "").replace(/<[^>]*>/g, "");
    }
  }

  function safeString(value, fallback = "") {
    const s = String(value ?? "").trim();
    return s.length ? s : fallback;
  }

  function asObjectValues(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value.filter(Boolean);
    if (typeof value === "object") return Object.values(value).filter(Boolean);
    return [];
  }

  function getItemCreateApi() {
    return (
      globalThis.FUCompanion?.api?.itemCreate ??
      game.modules?.get("fabula-ultima-companion")?.api?.itemCreate ??
      null
    );
  }

  function extractSkillUuid(entry) {
    if (!entry) return "";
    if (typeof entry === "string") return entry.trim();

    return safeString(
      entry.uuid ??
      entry.skillUuid ??
      entry.skill_uuid ??
      entry.itemUuid ??
      entry.item_uuid ??
      ""
    );
  }

  function getActiveSkillEntriesFromItem(item) {
    const props = item?.system?.props ?? {};
    const container =
      props.item_skill_active ??
      props.active_skill_list ??
      props.skill_active_list ??
      {};

    return asObjectValues(container).filter(entry => !!extractSkillUuid(entry));
  }

  function getTargetsFromUser() {
    return Array.from(game.user?.targets ?? [])
      .map(t => t.document?.uuid)
      .filter(Boolean);
  }

  function cleanupTipRefs(refs) {
    if (!refs) return;
    if (refs.tipTimer) {
      clearTimeout(refs.tipTimer);
      refs.tipTimer = null;
    }
    if (refs.liveTip) {
      refs.liveTip.remove();
      refs.liveTip = null;
    }
  }

  function createTip(text, anchorEl) {
    const tip = document.createElement("div");
    tip.className = "jrpg-tip";
    tip.textContent = text;
    document.body.appendChild(tip);

    const r   = anchorEl.getBoundingClientRect();
    const pad = 8;

    const top = Math.max(
      8,
      Math.min(
        window.innerHeight - tip.offsetHeight - 8,
        r.top + (r.height - tip.offsetHeight) / 2
      )
    );

    const left = Math.min(
      window.innerWidth - tip.offsetWidth - 8,
      r.right + pad
    );

    tip.style.top  = `${top}px`;
    tip.style.left = `${left}px`;

    return tip;
  }

  // --------------------------------------------------------------------------
  // Skill picker
  // --------------------------------------------------------------------------

  async function pickSkillFromItem(item, skillEntries) {
    if (!Array.isArray(skillEntries) || !skillEntries.length) return null;

    const skillInfos = [];

    for (const entry of skillEntries) {
      const uuid = extractSkillUuid(entry);
      if (!uuid) continue;

      let skillDoc = null;
      try {
        skillDoc = await fromUuid(uuid);
      } catch (e) {
        console.error("pickSkillFromItem | fromUuid failed:", e, entry);
      }

      const name = entry?.name ?? skillDoc?.name ?? "(No name)";
      const img  = skillDoc?.img || skillDoc?.system?.img || "icons/svg/explosion.svg";

      const descHtml =
        entry?.skill_description ??
        entry?.description ??
        skillDoc?.system?.props?.description ??
        "";

      const descPlain = stripTags(descHtml);

      skillInfos.push({
        uuid,
        name,
        img,
        desc: descPlain
      });
    }

    if (!skillInfos.length) return null;

    const rowsHtml = skillInfos.map(info => {
      const safeUuid = htmlEscape(info.uuid);
      const safeName = htmlEscape(info.name);
      const safeDesc = htmlEscape(info.desc);
      const safeImg  = htmlEscape(info.img);

      return `
        <div class="jrpg-row">
          <button type="button"
                  class="jrpg-skill-btn"
                  data-uuid="${safeUuid}"
                  data-desc="${safeDesc}"
                  title="${safeDesc}">
            <img class="jrpg-skill-icon" src="${safeImg}" alt="" />
            <span class="jrpg-skill-label">${safeName}</span>
          </button>
        </div>
      `;
    }).join("");

    const itemNameSafe = htmlEscape(item?.name ?? "Item");

    const skillDialogContent = `
      <style>
        .jrpg-wrap {
          max-height: 460px;
          overflow: auto;
          padding: 8px;
        }

        .jrpg-row {
          position: relative;
        }

        .jrpg-skill-btn {
          position: relative;
          display: flex;
          align-items: center;
          gap: 8px;
          width: 100%;
          margin: 6px 0;
          padding: 8px 12px;
          border: 2px solid rgba(120,78,20,.9);
          outline: none;
          border-radius: 9999px;
          box-shadow:
            0 2px 0 rgba(0,0,0,.25),
            inset 0 0 0 1px rgba(255,255,255,.25);
          background: linear-gradient(#f2d9a2,#e1c385);
          font-weight: 600;
          font-size: 14px;
          text-align: left;
          cursor: pointer;
          transition: filter .05s, transform .05s, box-shadow .05s;
        }

        .jrpg-skill-btn:hover {
          filter: brightness(1.05);
          transform: translateY(-1px);
        }

        .jrpg-skill-btn:active {
          transform: translateY(0);
          box-shadow:
            0 1px 0 rgba(0,0,0,.3),
            inset 0 0 0 1px rgba(255,255,255,.25);
        }

        .jrpg-skill-btn:focus,
        .jrpg-skill-btn.is-active {
          box-shadow:
            0 0 0 3px rgba(255,255,255,.6),
            0 0 0 6px rgba(120,78,20,.55),
            0 2px 0 rgba(0,0,0,.25);
        }

        .jrpg-skill-icon {
          width: 24px;
          height: 24px;
          image-rendering: pixelated;
          flex: 0 0 24px;
          border-radius: 4px;
          box-shadow: 0 0 0 1px rgba(0,0,0,.15) inset;
          background: rgba(0,0,0,.05);
        }

        .jrpg-skill-label {
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          flex: 1;
        }

        .jrpg-tip {
          position: fixed;
          z-index: 999999;
          max-width: 340px;
          padding: 8px 10px;
          border: 2px solid rgba(80,50,12,.95);
          border-radius: 10px;
          background: #f7f1e3;
          color: #2b2b2b;
          box-shadow: 0 6px 18px rgba(0,0,0,.35);
          font-size: 13px;
          line-height: 1.2;
          font-weight: 600;
          pointer-events: none;
        }
      </style>

      <div class="jrpg-wrap" tabindex="-1">
        ${rowsHtml}
      </div>
    `;

    const chosenSkillUuid = await new Promise(resolve => {
      const tipRefs = {
        liveTip: null,
        tipTimer: null
      };

      const dlg = new Dialog(
        {
          title: "Skills in " + itemNameSafe,
          content: skillDialogContent,
          buttons: {},
          close: () => {
            cleanupTipRefs(tipRefs);
            resolve(null);
          }
        },
        { width: 420 }
      );

      let resolved = false;
      const safeResolve = (value) => {
        if (resolved) return;
        resolved = true;
        cleanupTipRefs(tipRefs);
        resolve(value);
        dlg.close();
      };

      const onRender = (app, html) => {
        if (app.id !== dlg.id) return;

        const $wrap = html.find(".jrpg-wrap");
        const wrapEl = $wrap.get(0);
        const $btns = html.find(".jrpg-skill-btn");

        const first = $btns.get(0);
        if (first) {
          first.classList.add("is-active");
          first.focus({ preventScroll: true });
        }

        html.on("mouseenter", ".jrpg-skill-btn", ev => {
          const btnEl = ev.currentTarget;

          $btns.removeClass("is-active");
          btnEl.classList.add("is-active");
          btnEl.focus({ preventScroll: true });

          playMove();
          cleanupTipRefs(tipRefs);

          const text = btnEl?.dataset?.desc || "";
          if (!text) return;

          tipRefs.tipTimer = setTimeout(() => {
            tipRefs.liveTip = createTip(text, btnEl);
          }, 120);
        });

        html.on("mouseleave", ".jrpg-skill-btn", () => {
          cleanupTipRefs(tipRefs);
        });

        html.on("click", ".jrpg-skill-btn", ev => {
          const btnEl = ev.currentTarget;
          const uuid  = btnEl?.dataset?.uuid || null;
          safeResolve(uuid);
        });

        $wrap.on("keydown", ev => {
          const KEY = ev.key;
          const btnEls = $btns.toArray();
          if (!btnEls.length) return;

          const activeIx = btnEls.findIndex(b => b.classList.contains("is-active"));
          let nextIx = activeIx >= 0 ? activeIx : 0;

          if (KEY === "ArrowDown") {
            nextIx = Math.min(btnEls.length - 1, activeIx + 1);
            ev.preventDefault();
          } else if (KEY === "ArrowUp") {
            nextIx = Math.max(0, activeIx - 1);
            ev.preventDefault();
          } else if (KEY === "Home") {
            nextIx = 0;
            ev.preventDefault();
          } else if (KEY === "End") {
            nextIx = btnEls.length - 1;
            ev.preventDefault();
          } else if (KEY === "Enter" || KEY === " ") {
            ev.preventDefault();
            const btnEl = btnEls[Math.max(0, activeIx)];
            safeResolve(btnEl?.dataset?.uuid || null);
            return;
          } else if (KEY === "Escape") {
            ev.preventDefault();
            safeResolve(null);
            return;
          } else {
            return;
          }

          if (nextIx !== activeIx) {
            const btnEl = btnEls[nextIx];

            $btns.removeClass("is-active");
            btnEl.classList.add("is-active");
            btnEl.focus({ preventScroll: true });

            if (wrapEl && btnEl) {
              const c = wrapEl.getBoundingClientRect();
              const e = btnEl.getBoundingClientRect();
              const pad = 8;

              if (e.top < c.top + pad) {
                wrapEl.scrollTop -= (c.top + pad - e.top);
              } else if (e.bottom > c.bottom - pad) {
                wrapEl.scrollTop += (e.bottom - (c.bottom - pad));
              }
            }

            cleanupTipRefs(tipRefs);
            playMove();
          }
        });
      };

      Hooks.once("renderDialog", onRender);
      dlg.render(true);
    });

    return chosenSkillUuid || null;
  }

  // --------------------------------------------------------------------------
  // Build Use candidates
  // --------------------------------------------------------------------------

  async function buildUseCandidates(actor) {
    const actorProps = actor.system?.props ?? {};
    const consumableMap = actorProps.consumable_list ?? {};
    const entries = Object.values(consumableMap);

    if (!entries.length) return [];

    const candidatePromises = entries.map(async entry => {
      const uuid = entry?.uuid;
      if (!uuid) return null;

      let item = null;
      try {
        item = await fromUuid(uuid);
      } catch (e) {
        warn("Could not resolve consumable item.", { uuid, entry, error: e });
        return null;
      }

      if (!item) return null;

      const itemProps = item.system?.props ?? {};

      if (itemProps.item_type !== "consumable") return null;

      const isUnique = !!itemProps.isUnique;

      let quantity = null;
      if (!isUnique) {
        const liveQty   = Number(itemProps.item_quantity ?? NaN);
        const cachedQty = Number(entry.quantity ?? NaN);

        if (Number.isFinite(liveQty)) quantity = liveQty;
        else if (Number.isFinite(cachedQty)) quantity = cachedQty;
        else quantity = 0;
      }

      return {
        mode: "use",
        key: item.uuid,
        entry,
        item,
        itemProps,
        isUnique,
        quantity,
        name: entry.name ?? item.name ?? "(No name)",
        img: item.img || item.system?.img || "icons/svg/potion.svg",
        descriptionHtml: entry.consume_description ?? itemProps.description ?? "",
        descriptionText: stripTags(entry.consume_description ?? itemProps.description ?? "")
      };
    });

    let candidates = (await Promise.all(candidatePromises)).filter(Boolean);

    // Remove non-unique items that have 0 quantity.
    candidates = candidates.filter(c => c.isUnique || (c.quantity ?? 0) > 0);

    candidates.sort((a, b) => {
      return String(a.name ?? "").localeCompare(String(b.name ?? ""), game.i18n.lang);
    });

    return candidates;
  }

  // --------------------------------------------------------------------------
  // Build Create candidates
  // --------------------------------------------------------------------------

  async function buildCreateCandidates(actor) {
    const itemCreateApi = getItemCreateApi();

    if (!itemCreateApi?.getCreatableItems) {
      warn("Item-create API not found. Create tab will be empty.");
      return [];
    }

    try {
      const list = await itemCreateApi.getCreatableItems({
        actor,
        includeParty: true
      });

      return (Array.isArray(list) ? list : []).map((candidate, index) => {
        return {
          ...candidate,
          mode: "create",
          key: `create-${index}-${candidate.itemUuid ?? candidate.name ?? "item"}`,
          name: candidate.name ?? candidate.itemName ?? "(No name)",
          img: candidate.img ?? candidate.item?.img ?? "icons/svg/item-bag.svg",
          descriptionHtml: candidate.descriptionHtml ?? candidate.itemProps?.description ?? "",
          descriptionText: candidate.descriptionText ?? stripTags(candidate.descriptionHtml ?? candidate.itemProps?.description ?? "")
        };
      });
    } catch (e) {
      err("Failed to build Create item candidates.", e);
      ui.notifications.warn("Could not read item recipes for Create mode. See console.");
      return [];
    }
  }

  // --------------------------------------------------------------------------
  // Main actor resolution
  // --------------------------------------------------------------------------

  const actor = resolveActorForUser(game.user);

  if (!actor) {
    ui.notifications.warn("Could not find an actor for this user to use items.");
    return;
  }

  log("Actor resolved.", {
    actor: actor.name,
    uuid: actor.uuid
  });

  const useCandidates = await buildUseCandidates(actor);
  const createCandidates = await buildCreateCandidates(actor);

  if (!useCandidates.length && !createCandidates.length) {
    ui.notifications.warn("You have no usable consumables and no creatable recipe items.");
    return;
  }

  const useByKey = new Map();
  for (const c of useCandidates) useByKey.set(c.key, c);

  const createByKey = new Map();
  for (const c of createCandidates) createByKey.set(c.key, c);

  // --------------------------------------------------------------------------
  // Dialog HTML
  // --------------------------------------------------------------------------

  function buildUseRowsHtml() {
    if (!useCandidates.length) {
      return `
        <div class="jrpg-empty">
          No owned consumable items available.
        </div>
      `;
    }

    return useCandidates.map(c => {
      const qtyLabel = c.isUnique ? "∞" : String(c.quantity ?? 0);

      return `
        <div class="jrpg-row">
          <button type="button"
                  class="jrpg-skill-btn"
                  data-mode="use"
                  data-key="${htmlEscape(c.key)}"
                  data-desc="${htmlEscape(c.descriptionText)}"
                  title="${htmlEscape(c.descriptionText)}">
            <img class="jrpg-skill-icon" src="${htmlEscape(c.img)}" alt="" />
            <span class="jrpg-skill-label">${htmlEscape(c.name)}</span>

            <div class="jrpg-costs">
              <span class="jrpg-cost">x${htmlEscape(qtyLabel)}</span>
            </div>
          </button>
        </div>
      `;
    }).join("");
  }

  function buildCreateRowsHtml() {
    if (!createCandidates.length) {
      return `
        <div class="jrpg-empty">
          No creatable items unlocked by recipes.
        </div>
      `;
    }

    return createCandidates.map(c => {
      const ipCost = Number(c.ipCost ?? 0) || 0;
      const recipeName = c.recipeName ? `Recipe: ${c.recipeName}` : "";
      const desc = c.descriptionText || recipeName || "";

      return `
        <div class="jrpg-row">
          <button type="button"
                  class="jrpg-skill-btn"
                  data-mode="create"
                  data-key="${htmlEscape(c.key)}"
                  data-desc="${htmlEscape(desc)}"
                  title="${htmlEscape(desc)}">
            <img class="jrpg-skill-icon" src="${htmlEscape(c.img)}" alt="" />
            <span class="jrpg-skill-label">${htmlEscape(c.name)}</span>

            <div class="jrpg-costs">
              <span class="jrpg-cost jrpg-ip-cost">${htmlEscape(ipCost)} IP</span>
            </div>
          </button>
        </div>
      `;
    }).join("");
  }

  const itemDialogContent = `
    <style>
.jrpg-item-root {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 420px;
}

.jrpg-wrap {
  flex: 1 1 auto;
  min-height: 0;
}

      .jrpg-tabs {
        display: flex;
        gap: 6px;
        padding: 4px 6px 0;
      }

      .jrpg-tab-btn {
        flex: 1;
        border: 2px solid rgba(120,78,20,.9);
        border-radius: 9999px;
        padding: 6px 10px;
        background: linear-gradient(#e8d0a0,#cfa86d);
        color: #2f2110;
        font-weight: 700;
        cursor: pointer;
        box-shadow:
          0 2px 0 rgba(0,0,0,.25),
          inset 0 0 0 1px rgba(255,255,255,.25);
      }

      .jrpg-tab-btn:hover {
        filter: brightness(1.05);
      }

      .jrpg-tab-btn.is-active {
        background: linear-gradient(#fff0bd,#e4bf78);
        box-shadow:
          0 0 0 3px rgba(255,255,255,.5),
          0 0 0 5px rgba(120,78,20,.45),
          0 2px 0 rgba(0,0,0,.25);
      }

      .jrpg-mode-note {
        margin: 0 8px;
        padding: 6px 8px;
        border-radius: 8px;
        background: rgba(80,50,12,.08);
        color: #3a2a14;
        font-size: 12px;
        line-height: 1.25;
        font-weight: 600;
      }

      .jrpg-wrap {
        max-height: 460px;
        overflow: auto;
        padding: 8px;
      }

      .jrpg-panel {
        display: none;
      }

      .jrpg-panel.is-active {
        display: block;
      }

      .jrpg-row {
        position: relative;
      }

      .jrpg-skill-btn {
        position: relative;
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        margin: 6px 0;
        padding: 8px 12px;
        border: 2px solid rgba(120,78,20,.9);
        outline: none;
        border-radius: 9999px;
        box-shadow:
          0 2px 0 rgba(0,0,0,.25),
          inset 0 0 0 1px rgba(255,255,255,.25);
        background: linear-gradient(#f2d9a2,#e1c385);
        font-weight: 600;
        font-size: 14px;
        text-align: left;
        cursor: pointer;
        transition: filter .05s, transform .05s, box-shadow .05s;
      }

      .jrpg-skill-btn:hover {
        filter: brightness(1.05);
        transform: translateY(-1px);
      }

      .jrpg-skill-btn:active {
        transform: translateY(0);
        box-shadow:
          0 1px 0 rgba(0,0,0,.3),
          inset 0 0 0 1px rgba(255,255,255,.25);
      }

      .jrpg-skill-btn:focus,
      .jrpg-skill-btn.is-active {
        box-shadow:
          0 0 0 3px rgba(255,255,255,.6),
          0 0 0 6px rgba(120,78,20,.55),
          0 2px 0 rgba(0,0,0,.25);
      }

      .jrpg-skill-icon {
        width: 24px;
        height: 24px;
        image-rendering: pixelated;
        flex: 0 0 24px;
        border-radius: 4px;
        box-shadow: 0 0 0 1px rgba(0,0,0,.15) inset;
        background: rgba(0,0,0,.05);
      }

      .jrpg-skill-label {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        flex: 1;
      }

      .jrpg-costs {
        margin-left: auto;
        display: flex;
        align-items: center;
        gap: 6px;
      }

      .jrpg-cost {
        font-weight: 550;
        font-style: italic;
        color: #3a2a14;
        text-shadow: none;
        letter-spacing: .4px;
        font-size: 13px;
      }

      .jrpg-ip-cost {
        color: #9a4b22;
        font-weight: 800;
      }

      .jrpg-empty {
        margin: 10px 4px;
        padding: 12px;
        border: 2px dashed rgba(120,78,20,.45);
        border-radius: 12px;
        background: rgba(255,255,255,.25);
        color: #4a3720;
        font-size: 13px;
        font-weight: 700;
        text-align: center;
      }

      .jrpg-tip {
        position: fixed;
        z-index: 999999;
        max-width: 340px;
        padding: 8px 10px;
        border: 2px solid rgba(80,50,12,.95);
        border-radius: 10px;
        background: #f7f1e3;
        color: #2b2b2b;
        box-shadow: 0 6px 18px rgba(0,0,0,.35);
        font-size: 13px;
        line-height: 1.2;
        font-weight: 600;
        pointer-events: none;
      }
    </style>

<div class="jrpg-item-root">
  <div class="jrpg-wrap" tabindex="-1">
    <div class="jrpg-panel is-active" data-panel="use">
      ${buildUseRowsHtml()}
    </div>

    <div class="jrpg-panel" data-panel="create">
      ${buildCreateRowsHtml()}
    </div>
  </div>

  <div class="jrpg-tabs">
    <button type="button" class="jrpg-tab-btn is-active" data-tab="use">
      Use
    </button>
    <button type="button" class="jrpg-tab-btn" data-tab="create">
      Create
    </button>
  </div>

  <div class="jrpg-mode-note" data-mode-note>
    Use an item you already own. This consumes item quantity after the action is confirmed.
  </div>
</div>
  `;

  // --------------------------------------------------------------------------
  // Item selection dialog
  // --------------------------------------------------------------------------

  const chosen = await new Promise(resolve => {
    const tipRefs = {
      liveTip: null,
      tipTimer: null
    };

    const dlg = new Dialog(
      {
        title: "Choose Item",
        content: itemDialogContent,
        buttons: {},
        close: () => {
          cleanupTipRefs(tipRefs);
          resolve(null);
        }
      },
      { width: 440 }
    );

    let resolved = false;
    const safeResolve = (value) => {
      if (resolved) return;
      resolved = true;
      cleanupTipRefs(tipRefs);
      resolve(value);
      dlg.close();
    };

    const onRender = (app, html) => {
      if (app.id !== dlg.id) return;

      const $wrap = html.find(".jrpg-wrap");
      const wrapEl = $wrap.get(0);

      function getActivePanelName() {
        return html.find(".jrpg-tab-btn.is-active").attr("data-tab") || "use";
      }

      function getActiveButtons() {
        const panelName = getActivePanelName();
        return html.find(`.jrpg-panel[data-panel="${panelName}"] .jrpg-skill-btn`);
      }

      function focusFirstActiveButton() {
        const $btns = getActiveButtons();
        html.find(".jrpg-skill-btn").removeClass("is-active");

        const first = $btns.get(0);
        if (first) {
          first.classList.add("is-active");
          first.focus({ preventScroll: true });
        } else {
          const wrap = $wrap.get(0);
          if (wrap) wrap.focus({ preventScroll: true });
        }
      }

      function switchTab(tabName) {
        const safeTab = String(tabName || "use");

        html.find(".jrpg-tab-btn").removeClass("is-active");
        html.find(`.jrpg-tab-btn[data-tab="${safeTab}"]`).addClass("is-active");

        html.find(".jrpg-panel").removeClass("is-active");
        html.find(`.jrpg-panel[data-panel="${safeTab}"]`).addClass("is-active");

        const note = html.find("[data-mode-note]").get(0);
        if (note) {
          if (safeTab === "create") {
            note.textContent = "Create an item from known recipes. This spends IP after the action is confirmed.";
          } else {
            note.textContent = "Use an item you already own. This consumes item quantity after the action is confirmed.";
          }
        }

        cleanupTipRefs(tipRefs);
        focusFirstActiveButton();
        playMove();
      }

      html.on("click", ".jrpg-tab-btn", ev => {
        const tab = ev.currentTarget?.dataset?.tab || "use";
        switchTab(tab);
      });

      html.on("mouseenter", ".jrpg-skill-btn", ev => {
        const btn = ev.currentTarget;

        html.find(".jrpg-skill-btn").removeClass("is-active");
        btn.classList.add("is-active");
        btn.focus({ preventScroll: true });

        playMove();
        cleanupTipRefs(tipRefs);

        const text = btn?.dataset?.desc || "";
        if (!text) return;

        tipRefs.tipTimer = setTimeout(() => {
          tipRefs.liveTip = createTip(text, btn);
        }, 120);
      });

      html.on("mouseleave", ".jrpg-skill-btn", () => {
        cleanupTipRefs(tipRefs);
      });

      html.on("click", ".jrpg-skill-btn", ev => {
        const btn = ev.currentTarget;

        safeResolve({
          mode: btn?.dataset?.mode || "use",
          key: btn?.dataset?.key || null
        });
      });

      $wrap.on("keydown", ev => {
        const KEY = ev.key;

        if (KEY === "Tab") return;

        if (KEY === "ArrowLeft") {
          ev.preventDefault();
          switchTab("use");
          return;
        }

        if (KEY === "ArrowRight") {
          ev.preventDefault();
          switchTab("create");
          return;
        }

        const $btns = getActiveButtons();
        const btnEls = $btns.toArray();

        if (!btnEls.length) {
          if (KEY === "Escape") {
            ev.preventDefault();
            safeResolve(null);
          }
          return;
        }

        const activeIx = btnEls.findIndex(b => b.classList.contains("is-active"));
        let nextIx = activeIx >= 0 ? activeIx : 0;

        if (KEY === "ArrowDown") {
          nextIx = Math.min(btnEls.length - 1, activeIx + 1);
          ev.preventDefault();
        } else if (KEY === "ArrowUp") {
          nextIx = Math.max(0, activeIx - 1);
          ev.preventDefault();
        } else if (KEY === "Home") {
          nextIx = 0;
          ev.preventDefault();
        } else if (KEY === "End") {
          nextIx = btnEls.length - 1;
          ev.preventDefault();
        } else if (KEY === "Enter" || KEY === " ") {
          ev.preventDefault();

          const btn = btnEls[Math.max(0, activeIx)];

          safeResolve({
            mode: btn?.dataset?.mode || "use",
            key: btn?.dataset?.key || null
          });

          return;
        } else if (KEY === "Escape") {
          ev.preventDefault();
          safeResolve(null);
          return;
        } else {
          return;
        }

        if (nextIx !== activeIx) {
          const btn = btnEls[nextIx];

          html.find(".jrpg-skill-btn").removeClass("is-active");
          btn.classList.add("is-active");
          btn.focus({ preventScroll: true });

          if (wrapEl && btn) {
            const c = wrapEl.getBoundingClientRect();
            const e = btn.getBoundingClientRect();
            const pad = 8;

            if (e.top < c.top + pad) {
              wrapEl.scrollTop -= (c.top + pad - e.top);
            } else if (e.bottom > c.bottom - pad) {
              wrapEl.scrollTop += (e.bottom - (c.bottom - pad));
            }
          }

          cleanupTipRefs(tipRefs);
          playMove();
        }
      });

      focusFirstActiveButton();
    };

    Hooks.once("renderDialog", onRender);
    dlg.render(true);
  });

  if (!chosen?.key) return;

  // --------------------------------------------------------------------------
  // Resolve chosen item and active skill
  // --------------------------------------------------------------------------

  let mode = chosen.mode || "use";
  let item = null;
  let itemProps = {};
  let skillEntries = [];
  let createCandidate = null;

  if (mode === "create") {
    createCandidate = createByKey.get(chosen.key);

    if (!createCandidate) {
      ui.notifications.error("Could not resolve the created item candidate.");
      return;
    }

    item = createCandidate.item ?? null;

    if (!item && createCandidate.itemUuid) {
      try {
        item = await fromUuid(createCandidate.itemUuid);
      } catch (e) {
        err("Could not resolve created item document.", e);
      }
    }

    if (!item) {
      ui.notifications.error("Could not resolve the item created by this recipe.");
      return;
    }

    itemProps = item.system?.props ?? {};

    const itemCreateApi = getItemCreateApi();
    skillEntries =
      Array.isArray(createCandidate.activeSkillEntries) && createCandidate.activeSkillEntries.length
        ? createCandidate.activeSkillEntries
        : itemCreateApi?.getActiveSkillEntries
          ? itemCreateApi.getActiveSkillEntries(item)
          : getActiveSkillEntriesFromItem(item);
  } else {
    mode = "use";

    const useCandidate = useByKey.get(chosen.key);

    if (!useCandidate) {
      ui.notifications.error("Could not resolve the chosen item.");
      return;
    }

    item = useCandidate.item;
    itemProps = useCandidate.itemProps ?? item.system?.props ?? {};
    skillEntries = getActiveSkillEntriesFromItem(item);
  }

  if (!skillEntries.length) {
    ui.notifications.warn("This item has no Active skills wired into it.");
    return;
  }

  let chosenSkillUuid = null;

  if (skillEntries.length === 1) {
    chosenSkillUuid = extractSkillUuid(skillEntries[0]);
  } else {
    chosenSkillUuid = await pickSkillFromItem(item, skillEntries);
  }

  if (!chosenSkillUuid) return;

  const skillItem = await fromUuid(chosenSkillUuid).catch(e => {
    err("Could not resolve selected Skill inside item.", e);
    return null;
  });

  if (!skillItem) {
    ui.notifications.error("Could not resolve the selected Skill inside the item.");
    return;
  }

  // --------------------------------------------------------------------------
  // Forward to ActionDataFetch
  // --------------------------------------------------------------------------

  const adfMacro = game.macros.getName(ACTION_DATA_FETCH_NAME);

  if (!adfMacro) {
    ui.notifications.error(`Macro "${ACTION_DATA_FETCH_NAME}" not found or no permission.`);
    return;
  }

  const targets = getTargetsFromUser();

  let payload = null;

  if (mode === "create") {
    const itemCreateApi = getItemCreateApi();

    if (!itemCreateApi?.buildCreatePayload) {
      ui.notifications.error("Item Create API is missing buildCreatePayload().");
      return;
    }

    payload = itemCreateApi.buildCreatePayload({
      actor,
      candidate: createCandidate,
      skillItem,
      targets
    });

    log("Forwarding Create item payload to ActionDataFetch.", {
      actor: actor.name,
      item: createCandidate?.itemName ?? createCandidate?.name,
      recipe: createCandidate?.recipeName,
      ipCost: createCandidate?.ipCost,
      skill: skillItem.name,
      payload
    });
  } else {
    payload = {
      source: "Item",

      // Use the same field name ActionDataFetch already looks for.
      attacker_uuid: actor.uuid,

      // Actual active skill wired into the consumable.
      skillUuid: skillItem.uuid,

      // Item identity.
      itemUuid: item.uuid,
      itemName: item.name,

      // Explicit mode marker for later scripts.
      itemUseMode: "use",

      meta: {
        itemUseMode: "use"
      },

      targets
    };

    log("Forwarding Use item payload to ActionDataFetch.", {
      actor: actor.name,
      item: item.name,
      skill: skillItem.name,
      payload
    });
  }

  await adfMacro.execute({
    __AUTO: true,
    __PAYLOAD: payload
  });
})();