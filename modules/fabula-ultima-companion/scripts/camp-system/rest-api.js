// ============================================================================
// Camp System — Rest API
//
// Performs the full rest sequence: plays jingle on all clients, restores HP/MP
// for every party member, and clears non-permanent active effects.
//
// GM-only execution. Audio is broadcast via AudioHelper so all clients hear it.
// Active effects tagged "permanent" (via statuses) are preserved.
// ============================================================================
(() => {
  const CAMP      = globalThis.CampSystem ??= {};
  const TAG       = "[CampSystem][RestAPI]";

  // Jingle played during rest. Override CAMP.RestAPI.jingle before calling perform().
  const DEFAULT_JINGLE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Inn_A.mp3";

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Resolve all party actor IDs from the Database Actor via db-resolver.
   * The DB actor stores party members as member_id_1..member_id_4.
   * Returns an array of resolved Actor documents.
   */
  async function _getPartyActors() {
    const api = window.FUCompanion?.api;
    if (!api?.getCurrentGameDb) {
      console.warn(TAG, "db-resolver not available.");
      return [];
    }

    const { db, source } = await api.getCurrentGameDb();
    const dbActor = source ?? db;
    if (!dbActor) {
      console.warn(TAG, "Database actor not found.");
      return [];
    }

    const props = dbActor.system?.props ?? {};
    const actors = [];

    for (let i = 1; i <= 4; i++) {
      const raw = String(props[`member_id_${i}`] ?? "").trim();
      if (!raw) continue;

      let actor = game.actors?.get(raw) ?? null;
      if (!actor && raw.includes(".")) {
        actor = await fromUuid(raw).catch(() => null);
      }
      if (!actor) {
        actor = await fromUuid(`Actor.${raw}`).catch(() => null);
      }

      if (actor) {
        actors.push(actor);
      } else {
        console.warn(TAG, `member_id_${i} could not be resolved: "${raw}"`);
      }
    }

    return actors;
  }

  function isPermanent(effect) {
    return effect.statuses?.has?.("permanent") === true;
  }

  function getAudioHelper() {
    return foundry.audio?.AudioHelper ?? globalThis.AudioHelper ?? null;
  }

  // ---------------------------------------------------------------------------
  // Jingle preload cache
  // ---------------------------------------------------------------------------
  // Warm the jingle into the browser's audio cache as soon as possible so
  // AudioHelper.play() fires instantly on first use instead of stalling to fetch.
  function _preloadJingle(src) {
    const AH = getAudioHelper();
    if (!AH) return;
    try {
      if (typeof AH.preload === "function") {
        AH.preload(src).catch(() => {});
      } else {
        // Fallback: HTMLAudio preload hint (triggers HTTP fetch + cache)
        const a = new Audio();
        a.preload = "auto";
        a.src = src;
      }
    } catch (e) {
      console.warn(TAG, "Jingle preload failed:", e);
    }
  }

  // ---------------------------------------------------------------------------
  // BGM helpers
  // ---------------------------------------------------------------------------

  /** Snapshot whatever playlist + sound is currently playing. */
  function _captureBgm() {
    const playlist = [...game.playlists].find(pl => pl.sounds.some(s => s.playing)) ?? null;
    const sound    = playlist?.sounds.find(s => s.playing) ?? null;
    return { playlist, sound };
  }

  /** Stop all sounds in the captured playlist. */
  async function _stopBgm(playlist) {
    if (playlist) await playlist.stopAll();
  }

  /** Resume a specific sound in its playlist. */
  async function _resumeBgm(playlist, sound) {
    if (!playlist || !sound) return;
    try { await playlist.playSound(sound); }
    catch (e) { console.warn(TAG, "BGM resume failed:", e); }
  }

  /**
   * Schedule BGM resume once the jingle sound ends.
   * Falls back to a fixed timeout if the Sound object has no event API.
   */
  function _scheduleResume(jingleSound, playlist, sound, fallbackMs = 35_000) {
    if (!playlist || !sound) return;

    if (typeof jingleSound?.once === "function") {
      jingleSound.once("end", () => _resumeBgm(playlist, sound));
    } else if (typeof jingleSound?.addEventListener === "function") {
      jingleSound.addEventListener("end", () => _resumeBgm(playlist, sound), { once: true });
    } else {
      setTimeout(() => _resumeBgm(playlist, sound), fallbackMs);
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------
  CAMP.RestAPI = {
    jingle: DEFAULT_JINGLE,

    /**
     * Run the full rest sequence. Must be called from GM context.
     * 1. Stop current BGM.
     * 2. Broadcast jingle to all clients; schedule BGM resume for when it ends.
     * 3. Restore HP & MP for every party member.
     * 4. Delete all non-permanent active effects from party actors.
     * 5. Post a chat message.
     */
    async perform() {
      // 1 — Snapshot & stop BGM
      const { playlist: bgmPlaylist, sound: bgmSound } = _captureBgm();
      await _stopBgm(bgmPlaylist);

      // 2 — Play jingle on all clients, schedule BGM resume
      const AH = getAudioHelper();
      let jingleSound = null;
      if (AH) {
        try {
          jingleSound = await AH.play({ src: this.jingle, volume: 0.8, autoplay: true, loop: false }, true);
        } catch (e) {
          console.warn(TAG, "AudioHelper.play failed:", e);
        }
      } else {
        console.warn(TAG, "AudioHelper not available; jingle skipped.");
      }
      _scheduleResume(jingleSound, bgmPlaylist, bgmSound);

      // Pause while the screen is black so the jingle plays before feedback appears.
      await new Promise(r => setTimeout(r, 5000));

      // 3 & 4 — Process each party member
      const actors = await _getPartyActors();
      if (!actors.length) {
        console.warn(TAG, "No party actors found in DB; skipping restore.");
        return;
      }

      for (const actor of actors) {
        await _restoreResources(actor);
        await _clearTemporaryEffects(actor);
        await _tickCampRestEffects(actor);
      }

      // Clear exploration debuffs now that rest has applied them
      await CAMP.State?.clearExplorationDebuffs?.();

      // 5 — Chat message
      await _postChatMessage();

      console.debug(TAG, "Rest complete.");
    },
  };

  // ---------------------------------------------------------------------------
  // Internal steps
  // ---------------------------------------------------------------------------
  async function _restoreResources(actor) {
    const props = actor.system?.props;
    if (!props) {
      console.warn(TAG, `No system.props on ${actor.name}; skipping restore.`);
      return;
    }
    if (props.max_hp === undefined || props.max_mp === undefined) {
      console.warn(TAG, `max_hp/max_mp undefined on ${actor.name}; skipping restore.`);
      return;
    }

    // Check for Exploration "Ouch!" debuff — recover only half the missing HP/MP
    const debuffs  = CAMP.State?.getExplorationDebuffs?.() ?? {};
    const halfRest = !!debuffs[actor.id]?.halfRest;
    const curHp    = parseInt(props.current_hp) || 0;
    const curMp    = parseInt(props.current_mp) || 0;
    const newHp    = halfRest ? curHp + Math.floor((props.max_hp - curHp) / 2) : props.max_hp;
    const newMp    = halfRest ? curMp + Math.floor((props.max_mp - curMp) / 2) : props.max_mp;

    await actor.update({
      "system.props.current_hp": newHp,
      "system.props.current_mp": newMp,
    });
    console.debug(TAG, `Restored ${actor.name}: HP=${newHp} MP=${newMp}${halfRest ? " (Ouch! — halved)" : ""}`);
  }

  async function _clearTemporaryEffects(actor) {
    // Only delete effects that live directly on the actor (not transferred from
    // equipped items). Item-sourced effects have an origin pointing to an Item UUID.
    const toDelete = actor.effects.filter(e => {
      if (isPermanent(e)) return false;
      const origin = e.origin ?? "";
      return !origin || origin.startsWith("Actor.");
    });

    for (const effect of toDelete) {
      try {
        await actor.deleteEmbeddedDocuments("ActiveEffect", [effect.id]);
      } catch (e) {
        console.warn(TAG, `Could not delete effect "${effect.name}" (${effect.id}) from ${actor.name}:`, e.message);
      }
    }

    if (toDelete.length) {
      console.debug(TAG, `Cleared ${toDelete.length} effect(s) from ${actor.name}.`);
    }
  }

  // Generic rest-charge tick.
  // Any AE with flags["fabula-ultima-companion"].campRestCharges: N is decremented
  // each rest. When the value is already 0 at tick time the AE is deleted.
  // Convention:
  //   campRestCharges: 0  → expires at the very next rest
  //   campRestCharges: 1  → survives 1 rest, expires at the following one
  //   campRestCharges: N  → survives N rests, expires at rest N+1
  // The AE must also carry statuses: ["permanent"] so _clearTemporaryEffects
  // does not remove it on the same pass.
  async function _tickCampRestEffects(actor) {
    const MODULE_ID = "fabula-ultima-companion";
    const snapshot  = Array.from(actor.effects);
    for (const effect of snapshot) {
      const charges = effect.flags?.[MODULE_ID]?.campRestCharges;
      if (charges === undefined || charges === null) continue;
      const n = Number(charges);
      if (!Number.isFinite(n)) continue;
      if (n <= 0) {
        try {
          await effect.delete();
          console.debug(TAG, `campRestCharges expired — deleted "${effect.name}" from ${actor.name}.`);
        } catch (e) {
          console.warn(TAG, `Could not delete rest-charge effect "${effect.name}":`, e.message);
        }
      } else {
        try {
          await effect.setFlag(MODULE_ID, "campRestCharges", n - 1);
          console.debug(TAG, `campRestCharges decremented to ${n - 1} on "${effect.name}" (${actor.name}).`);
        } catch (e) {
          console.warn(TAG, `Could not decrement rest charges on "${effect.name}":`, e.message);
        }
      }
    }
  }

  async function _postChatMessage() {
    const msg = await ChatMessage.create({
      content: `
        <div style="font-weight:700; line-height:1.25; padding:2px 0;">
          The Party fully recovers their
          <span style="color:#c62828; font-weight:800;">HP</span>
          and
          <span style="color:#1565c0; font-weight:800;">MP</span>!
        </div>
      `,
    });

    // Hide the chat header on the local client for a clean system-message look.
    const styleId = `oni-rest-style-${msg.id}`;
    if (!document.getElementById(styleId)) {
      const style = document.createElement("style");
      style.id = styleId;
      style.textContent = `
        .chat-message[data-message-id="${msg.id}"] .message-header { display: none !important; }
        .chat-message[data-message-id="${msg.id}"] { padding-top: 6px !important; }
        .chat-message[data-message-id="${msg.id}"] .message-content { margin: 0 !important; }
      `;
      document.head.appendChild(style);
    }
  }

  // Warm the jingle cache when the world is ready, and again when the party
  // reaches SLEEP_LOBBY (covers scene reloads that bypass the ready hook window).
  Hooks.once("ready", () => _preloadJingle(CAMP.RestAPI.jingle));

  Hooks.on("updateSetting", (setting) => {
    const key = `${CAMP.MODULE_ID}.${CAMP.SETTING?.PHASE}`;
    if (setting?.key === key && game.settings.get(CAMP.MODULE_ID, CAMP.SETTING.PHASE) === CAMP.PHASE.SLEEP_LOBBY) {
      _preloadJingle(CAMP.RestAPI.jingle);
    }
  });

  console.debug(TAG, "Rest API loaded.");
})();
