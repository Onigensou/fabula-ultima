/**
 * [ONI] Opportunity System — Effects
 * Handlers for all opportunity options.
 * Each handler receives a context object and returns a Promise.
 *
 * Context shape:
 *   { actorUuid, actorName, optionId, option, source, context: { payload?, checkResult?, ... } }
 *
 * All handlers run on the GM's client (applyAndAnnounce is GM-only).
 */
(() => {
  const TAG       = "[ONI][OpportunitySystem:Effects]";
  const MODULE_ID = "fabula-ultima-companion";
  const esc = s => String(s ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");

  // ── Element affinity constants (matches apply-damage-core.js) ─────────────────
  const ELEMENT_NAMES = ["Physical","Air","Bolt","Dark","Earth","Fire","Ice","Light","Poison"];
  const AFFINITY_LABEL = { RS:"🛡 Resistant", VU:"💥 Vulnerable", IM:"🚫 Immune", AB:"♻ Absorbs" };

  // ── Helpers ───────────────────────────────────────────────────────────────────

  /** Resolve the world-actor from any UUID (token or actor). */
  async function resolveActor(uuid) {
    if (!uuid) return null;
    const doc = await fromUuid(uuid).catch(() => null);
    const actor = doc?.actor ?? (doc?.documentName === "Actor" ? doc : null);
    if (!actor) return null;
    return actor.isToken ? (game.actors?.get(actor.id) ?? actor) : actor;
  }

  /**
   * Show a token picker dialog (GM-side).
   * Returns the chosen PlaceableToken or null if cancelled.
   */
  function pickToken({ title = "Choose Target", excludeActorId = null } = {}) {
    const tokens = (canvas?.tokens?.placeables ?? []).filter(t => {
      if (!t.actor) return false;
      if (excludeActorId && t.actor.id === excludeActorId) return false;
      return true;
    });
    if (!tokens.length) {
      ui.notifications?.warn("[Opportunity] No valid tokens on scene.");
      return Promise.resolve(null);
    }
    if (tokens.length === 1) return Promise.resolve(tokens[0]);

    return new Promise(resolve => {
      const opts = tokens.map((t, i) =>
        `<option value="${i}">${esc(t.name ?? `Token ${i+1}`)}</option>`
      ).join("");
      new Dialog({
        title,
        content: `<div style="padding:4px 0 8px;">
          <select id="oni-opp-target-sel" style="width:100%;padding:4px;">${opts}</select>
        </div>`,
        buttons: {
          confirm: {
            label: "Confirm",
            callback: html => {
              const idx = parseInt(html.find("#oni-opp-target-sel").val() ?? "0", 10);
              resolve(tokens[Number.isFinite(idx) ? idx : 0] ?? null);
            },
          },
          cancel: { label: "Cancel", callback: () => resolve(null) },
        },
        default: "confirm",
        close: () => resolve(null),
      }).render(true);
    });
  }

  // ── Scan helpers ──────────────────────────────────────────────────────────────

  async function postScanCard({ targetName, targetPortrait, scanType, resultHtml }) {
    const accent = "#2a7a5a";
    const typeLabel = scanType === "vulnerability" ? "Vulnerability" : "Trait";
    const typeIcon  = scanType === "vulnerability" ? "fa-shield-halved" : "fa-scroll";

    const content = `
      <div style="
        font-family:'Signika',serif; padding:10px 13px 10px; border-radius:10px;
        background:linear-gradient(160deg,#0d1f1a 0%,#122a22 100%);
        border:2px solid ${esc(accent)}; color:#d4edd8;
      ">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
          <img src="${esc(targetPortrait)}"
               style="width:40px;height:40px;object-fit:contain;border:none!important;background:transparent!important;box-shadow:none!important;border-radius:0!important;"
               onerror="this.src='icons/svg/mystery-man.svg'" />
          <div>
            <div style="font-size:.74rem;opacity:.6;text-transform:uppercase;letter-spacing:.06em;">
              <i class="fas ${esc(typeIcon)}" style="margin-right:4px;"></i>Scan — ${esc(typeLabel)}
            </div>
            <div style="font-weight:900;font-size:.95rem;">${esc(targetName)}</div>
          </div>
        </div>
        <div style="font-size:.82rem;line-height:1.55;border-top:1px solid ${esc(accent)}55;padding-top:7px;">
          ${resultHtml}
        </div>
      </div>`;

    await ChatMessage.create({ content })
      .catch(e => console.error(TAG, "postScanCard failed:", e));
  }

  // ── Effect handlers ───────────────────────────────────────────────────────────

  const EFFECTS = {

    // ── Advantage ───────────────────────────────────────────────────────────────
    // Applies a charged AE (charges=1, chargeKey="opportunityAdvantage") to the
    // actor. The CheckRoller "opportunity-advantage" pipeline step (registered in
    // opportunity-action-hook.js) consumes it before compute and adds +4 to the
    // modifier parts.
    advantage: async (ctx) => {
      const actor = await resolveActor(ctx.actorUuid);
      if (!actor) {
        console.warn(TAG, "advantage: could not resolve actor", ctx.actorUuid);
        return;
      }

      await actor.createEmbeddedDocuments("ActiveEffect", [{
        name:  "Advantage",
        label: "Advantage",
        icon:  "icons/magic/control/debuff-arrows-up-gold.webp",
        flags: {
          [MODULE_ID]: {
            charges:    1,
            chargesMax: 1,
            chargeKey:  "opportunityAdvantage",
          },
        },
      }]).catch(e => console.error(TAG, "advantage: AE creation failed:", e));
    },

    // ── Affliction ──────────────────────────────────────────────────────────────
    // GM picks status (dazed/shaken/slow/weak) and target token.
    // Creates an AE on the target actor.
    affliction: async (ctx) => {
      const STATUSES = ["dazed","shaken","slow","weak"];
      const STATUS_LABEL = { dazed:"Dazed", shaken:"Shaken", slow:"Slow", weak:"Weak" };

      // Step 1: pick status
      const status = await new Promise(resolve => {
        const buttons = {};
        STATUSES.forEach(s => {
          buttons[s] = { label: STATUS_LABEL[s], callback: () => resolve(s) };
        });
        buttons.cancel = { label: "Cancel", callback: () => resolve(null) };
        new Dialog({
          title: "Affliction — Choose Status",
          content: `<p style="margin:4px 0 8px;">
            <strong>${esc(ctx.actorName)}</strong> inflicts a status. Which one?
          </p>`,
          buttons,
          default: "dazed",
          close: () => resolve(null),
        }).render(true);
      });
      if (!status) return;

      // Step 2: pick target (exclude the afflicting actor)
      const scannerActor = await resolveActor(ctx.actorUuid);
      const token = await pickToken({
        title:         "Affliction — Choose Target",
        excludeActorId: scannerActor?.id ?? null,
      });
      if (!token) return;

      // Step 3: look up icon from CONFIG.statusEffects, fall back gracefully
      const cfgStatus = CONFIG.statusEffects?.find(s => s.id === status);
      const icon = cfgStatus?.icon ?? "icons/svg/mystery-man.svg";

      await token.actor.createEmbeddedDocuments("ActiveEffect", [{
        name:     STATUS_LABEL[status],
        label:    STATUS_LABEL[status],
        statuses: [status],
        icon,
      }]).catch(e => console.error(TAG, "affliction: AE creation failed:", e));
    },

    // ── Bonding ──────────────────────────────────────────────────────────────────
    bonding: async (ctx) => {
      // TODO: standalone bond editor UI using BondUpdater.readBonds / writeSlot
      console.debug(TAG, "bonding — placeholder", ctx);
    },

    // ── Faux Pas ─────────────────────────────────────────────────────────────────
    faux_pas: async (ctx) => {
      // Narrative only — no mechanical automation
      console.debug(TAG, "faux_pas — placeholder", ctx);
    },

    // ── Favor ─────────────────────────────────────────────────────────────────────
    favor: async (ctx) => {
      // Narrative only — no mechanical automation
      console.debug(TAG, "favor — placeholder", ctx);
    },

    // ── Information ───────────────────────────────────────────────────────────────
    information: async (ctx) => {
      // TODO: GM text-input dialog → whisper/post result card
      console.debug(TAG, "information — placeholder", ctx);
    },

    // ── Lost Item ─────────────────────────────────────────────────────────────────
    lost_item: async (ctx) => {
      // TODO: item picker → remove / flag item from actor inventory
      console.debug(TAG, "lost_item — placeholder", ctx);
    },

    // ── Plot Twist ────────────────────────────────────────────────────────────────
    plot_twist: async (ctx) => {
      // Narrative only — no mechanical automation
      console.debug(TAG, "plot_twist — placeholder", ctx);
    },

    // ── Progress ──────────────────────────────────────────────────────────────────
    progress: async (ctx) => {
      // TODO: needs clock system — placeholder until Clock infrastructure is built
      console.debug(TAG, "progress — placeholder", ctx);
    },

    // ── Scan ──────────────────────────────────────────────────────────────────────
    // GM picks a target token and whether to reveal Vulnerability or Trait.
    // Vulnerability: reads affinity_1–9 from actor props and posts all non-neutral values.
    // Trait: reads system.props.traits (rich text) and posts it verbatim.
    scan: async (ctx) => {
      // Exclude the scanning actor's token from the target list
      const scannerActor = await resolveActor(ctx.actorUuid);

      const token = await pickToken({
        title:         "Scan — Choose Target",
        excludeActorId: scannerActor?.id ?? null,
      });
      if (!token) return;

      const targetActor  = token.actor;
      const props        = targetActor.system?.props ?? {};

      const portrait = String(props.sprite_standard ?? "").trim()
        || String(targetActor.prototypeToken?.texture?.src ?? "").trim()
        || targetActor.img
        || "icons/svg/mystery-man.svg";

      // Pick scan type
      const scanType = await new Promise(resolve => {
        new Dialog({
          title: `Scan — ${targetActor.name}`,
          content: `<p style="margin:4px 0 8px;">
            What to reveal about <strong>${esc(targetActor.name)}</strong>?
          </p>`,
          buttons: {
            vulnerability: { label: "💥 Vulnerability", callback: () => resolve("vulnerability") },
            trait:         { label: "📜 Trait",         callback: () => resolve("trait") },
            cancel:        { label: "Cancel",            callback: () => resolve(null) },
          },
          default: "vulnerability",
          close: () => resolve(null),
        }).render(true);
      });
      if (!scanType) return;

      let resultHtml;

      if (scanType === "vulnerability") {
        const rows = ELEMENT_NAMES.map((el, i) => {
          const val = String(props[`affinity_${i + 1}`] ?? "").trim().toUpperCase();
          if (!val) return null;
          const label = AFFINITY_LABEL[val] ?? val;
          const isVu  = val === "VU";
          return `<div style="${isVu ? "font-weight:800;color:#f9a825;" : "opacity:.75;"}">${esc(el)}: ${esc(label)}</div>`;
        }).filter(Boolean);

        resultHtml = rows.length
          ? rows.join("")
          : `<div style="opacity:.6;">All affinities are neutral.</div>`;

      } else {
        // Traits are stored as rich text in system.props.traits
        const raw = String(props.traits ?? "").trim();
        resultHtml = raw || `<div style="opacity:.6;">No trait information available.</div>`;
      }

      await postScanCard({ targetName: targetActor.name, targetPortrait: portrait, scanType, resultHtml });
    },

    // ── Unmask ────────────────────────────────────────────────────────────────────
    unmask: async (ctx) => {
      // TODO: reveal goals/motivations field from chosen actor's CSB props
      console.debug(TAG, "unmask — placeholder", ctx);
    },

    // ── Custom ────────────────────────────────────────────────────────────────────
    custom: async (ctx) => {
      // TODO: GM text-input dialog → post custom twist card
      console.debug(TAG, "custom — placeholder", ctx);
    },
  };

  window["oni.OpportunityEffects"] = Object.freeze(EFFECTS);
  console.debug(`${TAG} Loaded ${Object.keys(EFFECTS).length} handlers.`);
})();
