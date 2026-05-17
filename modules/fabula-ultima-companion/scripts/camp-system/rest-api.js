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
      await new Promise(r => setTimeout(r, 4000));

      // 3 & 4 — Process each party member
      const actors = await _getPartyActors();
      if (!actors.length) {
        console.warn(TAG, "No party actors found in DB; skipping restore.");
        return;
      }

      for (const actor of actors) {
        await _restoreResources(actor);
        await _clearTemporaryEffects(actor);
      }

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
    await actor.update({
      "system.props.current_hp": props.max_hp,
      "system.props.current_mp": props.max_mp,
    });
    console.debug(TAG, `Restored ${actor.name}: HP=${props.max_hp} MP=${props.max_mp}`);
  }

  async function _clearTemporaryEffects(actor) {
    const ids = actor.effects
      .filter(e => !isPermanent(e))
      .map(e => e.id);
    if (ids.length) {
      await actor.deleteEmbeddedDocuments("ActiveEffect", ids);
      console.debug(TAG, `Cleared ${ids.length} effect(s) from ${actor.name}.`);
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

  console.debug(TAG, "Rest API loaded.");
})();
