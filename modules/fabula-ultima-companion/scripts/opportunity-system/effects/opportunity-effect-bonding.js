// ============================================================================
// Opportunity Effect — Bonding
//
// Flow (pre/post):
//   pre  — opens the bond editor on the owning client.
//          GM-owned actors: awaits editor close; captures the changelog via
//          the onConfirmed callback; returns { bonded, actorName, changelog }
//          so post can immediately broadcast FX.
//          Player-owned actors: dispatches OPP_BOND_EDIT via socket and returns
//          { bonded, actorName, changelog: null } immediately (fire-and-forget).
//          FX fires independently when OPP_BOND_DONE arrives on the GM.
//   post — if changelog is non-empty, broadcasts FX + result banner to all
//          clients. Otherwise a no-op (FX will fire via the OPP_BOND_DONE path).
//
// Sockets:
//   OPP_BOND_EDIT  GM → targeted player  — open bond editor on player's screen
//   OPP_BOND_DONE  player → GM           — editor confirmed; carry changelog back
//   OPP_BOND_FX    GM → all others       — broadcast FX + banner to every client
//
// Visual FX:
//   - PIXI floating hearts on source token + bond-target token (name match)
//   - Pink hearts (#FF6B9D) for positive emotions; purple (#A855F7) for negative
//   - Sound: emotion_up.wav / emotion_down.wav from Forge CDN
//   - Second log banner below the main opportunity banner showing the change log
// ============================================================================
(() => {
  const TAG       = "[ONI][OpportunityEffect:Bonding]";
  const SOCKET_CH = "module.fabula-ultima-companion";
  const MSG_EDIT  = "OPP_BOND_EDIT";
  const MSG_DONE  = "OPP_BOND_DONE";
  const MSG_FX    = "OPP_BOND_FX";

  const SFX_POSITIVE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/emotion_up.wav";
  const SFX_NEGATIVE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/emotion_down.wav";
  const HEART_PINK   = "#FF6B9D";
  const HEART_PURPLE = "#A855F7";

  function playSound(url, vol = 0.7) {
    try { (foundry.audio.AudioHelper ?? AudioHelper).play({ src: url, volume: vol, autoplay: true }, false); }
    catch (_) {}
  }

  // ── PIXI floating heart FX ────────────────────────────────────────────────
  // Spawns COUNT hearts that float upward and fade out over the target token.
  // Uses PIXI.Text("♥") — no external textures, no font loading required.
  function playHeartFX(token, polarity) {
    if (!canvas?.app?.ticker || !PIXI?.Text || !token) return;

    const gridSize = canvas.scene?.grid?.size ?? 100;
    const tw       = (token.document?.width  ?? 1) * gridSize;
    const th       = (token.document?.height ?? 1) * gridSize;
    const cx       = (token.x ?? 0) + tw / 2;
    const cy       = (token.y ?? 0) + th / 2;

    const colorHex    = polarity === "negative" ? HEART_PURPLE : HEART_PINK;
    const DURATION_MS = 1400;
    const COUNT       = 5;
    const SPREAD      = tw * 0.55;
    const RISE        = th * 1.1;

    const container = new PIXI.Container();
    container.position.set(cx, cy - th * 0.25);
    canvas.tokens.addChild(container);

    const { ticker } = canvas.app;

    function spawnHeart() {
      if (!container.parent) return; // safety: container may have been cleaned up

      const offsetX  = (Math.random() - 0.5) * SPREAD;
      const fontSize = 18 + Math.floor(Math.random() * 12);
      const style    = new PIXI.TextStyle({
        fontSize,
        fill:               colorHex,
        dropShadow:         true,
        dropShadowColor:    "#000000",
        dropShadowBlur:     2,
        dropShadowAlpha:    0.4,
        dropShadowDistance: 1,
      });
      const text = new PIXI.Text("♥", style);
      text.anchor.set(0.5, 0.5);
      text.x = offsetX;
      text.y = 0;
      container.addChild(text);

      let elapsed = 0;
      function tick() {
        elapsed += ticker.deltaMS;
        const t     = Math.min(elapsed / DURATION_MS, 1);
        text.y      = -t * RISE;
        text.alpha  = t < 0.25 ? 1 : 1 - ((t - 0.25) / 0.75);
        text.scale.set(1 + t * 0.15);
        if (t >= 1) {
          ticker.remove(tick);
          text.destroy();
        }
      }
      ticker.add(tick);
    }

    for (let i = 0; i < COUNT; i++) {
      setTimeout(spawnHeart, i * 200);
    }

    // Safety cleanup after all hearts are done
    setTimeout(() => {
      if (container.parent) {
        container.parent.removeChild(container);
        container.destroy({ children: true });
      }
    }, DURATION_MS + COUNT * 200 + 300);
  }

  // ── Bond result banner ─────────────────────────────────────────────────────
  // Slides in below the main opportunity banner (offset 165 px vs 100 px).
  // Reuses the .oni-opp-log-banner CSS class already injected by the manager.
  const BANNER_TOP_PX    = 165;
  const BANNER_ENTER_MS  = 750;
  const BANNER_LINGER_MS = 2800;
  const BANNER_EXIT_MS   = 410;

  function _capitalize(str) {
    return str ? str.charAt(0).toUpperCase() + str.slice(1) : str;
  }

  function playBondBanner(entry, actorName) {
    if (!entry) return;

    const bondName = (entry.after?.name ?? entry.before?.name ?? "?").trim();
    let label, color, icon;

    if (entry.type === "add") {
      label = `${actorName} + ${bondName}`;
      color = "#CAA44D";
      icon  = "fa-plus-circle";
    } else {
      // Find the newly added emotion (was empty before, non-empty after)
      const eb = [entry.before?.e1, entry.before?.e2, entry.before?.e3];
      const ea = [entry.after?.e1,  entry.after?.e2,  entry.after?.e3];
      let newEmotion = "";
      for (let i = 0; i < 3; i++) {
        if (!eb[i] && ea[i]) { newEmotion = ea[i]; break; }
      }
      const pol = globalThis.BondUpdater?.emotionPolarity?.(newEmotion) ?? "none";
      color = pol === "negative" ? HEART_PURPLE : HEART_PINK;
      icon  = "fa-heart";
      label = newEmotion
        ? `${actorName} → ${bondName} (${_capitalize(newEmotion)})`
        : `${actorName} → ${bondName}`;
    }

    const esc = s => String(s ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
    const col = esc(color);

    const banner = document.createElement("div");
    banner.className = "oni-opp-log-banner";
    banner.style.top             = `${BANNER_TOP_PX}px`;
    banner.style.borderLeftColor = col;
    banner.style.borderLeftWidth = "5px";
    banner.style.transform       = "translateX(calc(-50% - 100px))";
    banner.style.opacity         = "0";
    banner.innerHTML = `
      <span class="oni-opp-log-banner-icon" style="color:${col}">
        <i class="fas ${esc(icon)}"></i>
      </span>
      <span class="oni-opp-log-banner-label">${esc(label)}</span>`;
    document.body.appendChild(banner);

    // Enter
    requestAnimationFrame(() => requestAnimationFrame(() => {
      banner.style.transition = [
        `transform ${BANNER_ENTER_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`,
        `opacity   ${Math.round(BANNER_ENTER_MS * 0.7)}ms ease-out`,
      ].join(", ");
      banner.style.transform = "translateX(-50%)";
      banner.style.opacity   = "1";
    }));

    // Exit
    setTimeout(() => {
      banner.style.transition = [
        `transform ${BANNER_EXIT_MS}ms cubic-bezier(0.55, 0, 1, 0.45)`,
        `opacity   ${Math.round(BANNER_EXIT_MS * 0.7)}ms ease-in`,
      ].join(", ");
      banner.style.transform = "translateX(calc(-50% + 100px))";
      banner.style.opacity   = "0";
      setTimeout(() => banner.remove(), BANNER_EXIT_MS + 60);
    }, BANNER_ENTER_MS + BANNER_LINGER_MS);
  }

  // ── FX helpers ─────────────────────────────────────────────────────────────

  // Derive polarity from a changelog: look for the newly added emotion.
  function _derivePolarity(changelog) {
    for (const entry of changelog ?? []) {
      if (entry.type === "update") {
        const eb = [entry.before?.e1, entry.before?.e2, entry.before?.e3];
        const ea = [entry.after?.e1,  entry.after?.e2,  entry.after?.e3];
        for (let i = 0; i < 3; i++) {
          if (!eb[i] && ea[i]) {
            const p = globalThis.BondUpdater?.emotionPolarity?.(ea[i]) ?? "none";
            if (p !== "none") return p;
          }
        }
      } else if (entry.type === "add") {
        for (const e of [entry.after?.e1, entry.after?.e2, entry.after?.e3]) {
          const p = globalThis.BondUpdater?.emotionPolarity?.(e) ?? "none";
          if (p !== "none") return p;
        }
      }
    }
    return "positive";
  }

  function _findSourceToken(actorUuid) {
    if (!actorUuid) return null;
    const shortId = String(actorUuid).replace(/^.*\.Actor\./, "").replace(/^Actor\./, "");
    return (canvas?.tokens?.placeables ?? []).find(t =>
      t.actor?.uuid === actorUuid || t.actor?.id === shortId
    ) ?? null;
  }

  function _findTokenByName(name) {
    if (!name?.trim()) return null;
    const lower = name.trim().toLowerCase();
    return (canvas?.tokens?.placeables ?? []).find(t =>
      (t.name ?? "").toLowerCase() === lower
    ) ?? null;
  }

  // Play FX + banner locally on this client.
  function _playFXLocally({ actorName, actorUuid, changelog }) {
    if (!changelog?.length) return;

    const entry    = changelog[0];
    const polarity = _derivePolarity(changelog);

    // Hearts on source token
    const srcToken = _findSourceToken(actorUuid);
    if (srcToken) playHeartFX(srcToken, polarity);

    // Hearts on bond target (best-effort name match)
    const bondName = (entry.after?.name ?? entry.before?.name ?? "").trim();
    const tgtToken = _findTokenByName(bondName);
    if (tgtToken && tgtToken !== srcToken) playHeartFX(tgtToken, polarity);

    // Sound
    playSound(polarity === "negative" ? SFX_NEGATIVE : SFX_POSITIVE);

    // Result banner
    playBondBanner(entry, actorName);
  }

  // ── Boot ───────────────────────────────────────────────────────────────────
  Hooks.once("ready", () => {
    const utils = window["oni.OppEffectUtils"] ?? {};

    // ── Socket listener ──────────────────────────────────────────────────────
    game.socket.on(SOCKET_CH, async msg => {

      // OPP_BOND_EDIT — show bond editor on the targeted player's client
      if (msg?.type === MSG_EDIT) {
        const { actorUuid, targetUserId } = msg.payload ?? {};
        if (game.user.id !== targetUserId) return;

        console.debug(TAG, "[socket] OPP_BOND_EDIT received, resolving actor:", actorUuid);
        const doc   = await fromUuid(actorUuid).catch(() => null);
        const actor = doc?.actor ?? (doc?.documentName === "Actor" ? doc : null);
        if (!actor) { console.warn(TAG, "[socket] could not resolve actor:", actorUuid); return; }
        const worldActor = actor.isToken ? (game.actors?.get(actor.id) ?? actor) : actor;

        await window["oni.OppBondUI"]?.show(worldActor, changelog => {
          // Player confirmed — send changelog back to GM to trigger FX
          game.socket.emit(SOCKET_CH, {
            type:    MSG_DONE,
            payload: { actorUuid, actorName: worldActor.name, changelog },
          });
        });
        return;
      }

      // OPP_BOND_DONE — GM receives confirmed changelog from player; broadcasts FX
      if (msg?.type === MSG_DONE && game.user?.isGM) {
        const { actorUuid, actorName, changelog } = msg.payload ?? {};
        if (!changelog?.length) return;
        const payload = { actorName, actorUuid, changelog };
        // Play locally (GM), then broadcast to all other clients
        _playFXLocally(payload);
        game.socket.emit(SOCKET_CH, { type: MSG_FX, payload });
        return;
      }

      // OPP_BOND_FX — all non-emitting clients play FX + banner locally
      if (msg?.type === MSG_FX) {
        _playFXLocally(msg.payload ?? {});
        return;
      }
    });

    // ── Effect handler ───────────────────────────────────────────────────────
    window["oni.OppEffectRegistry"]?.register("bonding", {

      // ── Pre phase: open bond editor (all user interaction) ───────────────
      async pre(ctx) {
        console.debug(TAG, "[entry]", { actorUuid: ctx.actorUuid, actorName: ctx.actorName });

        const { resolveActor, resolveOwnerUserId } = utils;
        if (!resolveActor || !resolveOwnerUserId) {
          console.error(TAG, "[pre] OppEffectUtils not loaded"); return null;
        }

        const actor = await resolveActor(ctx.actorUuid);
        if (!actor) { console.warn(TAG, "[pre] could not resolve actor"); return null; }

        const ownerUserId = resolveOwnerUserId(ctx.actorUuid);
        const amOwner     = !ownerUserId || game.user.id === ownerUserId;
        console.debug(TAG, "[pre]", { ownerUserId, amOwner });

        if (amOwner) {
          // GM-owned: await the editor, capture changelog via callback
          let changelog = null;
          await window["oni.OppBondUI"]?.show(actor, cl => { changelog = cl; });
          console.debug(TAG, "[pre] bond UI closed, changelog:", changelog);
          return { bonded: true, actorName: ctx.actorName, changelog };
        } else {
          // Player-owned: dispatch to player; FX fires asynchronously via OPP_BOND_DONE
          console.debug(TAG, "[pre] dispatching OPP_BOND_EDIT to player:", ownerUserId);
          game.socket.emit(SOCKET_CH, {
            type:    MSG_EDIT,
            payload: { actorUuid: ctx.actorUuid, actorName: ctx.actorName, targetUserId: ownerUserId },
          });
          return { bonded: true, actorName: ctx.actorName, changelog: null };
        }
      },

      // ── Post phase: broadcast FX if changelog is ready ───────────────────
      async post(ctx, preResult) {
        const { changelog, actorName } = preResult ?? {};
        // For player-owned actors changelog is null here; FX fires from OPP_BOND_DONE
        if (!changelog?.length) return;

        const payload = {
          actorName: actorName ?? ctx.actorName,
          actorUuid: ctx.actorUuid,
          changelog,
        };
        // Play locally (GM), broadcast to all other clients
        _playFXLocally(payload);
        game.socket.emit(SOCKET_CH, { type: MSG_FX, payload });
      },
    });

    console.debug(TAG, "Bonding effect + socket listener registered.");
  });
})();
