// scripts/gacha/gacha-socket-banner.js
(() => {
  const MODULE_ID = "fabula-ultima-companion";
  const CHANNEL = `module.${MODULE_ID}`;
  const TAG = "[FU][GachaSocket]";
  const DEBUG = true;

  const log  = (...a) => DEBUG && console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);

  async function resolveDbActorViaApi() {
    // Uses your db-resolver.js API (preferred)
    const API = window.FUCompanion?.api;
    if (!API?.getCurrentGameDb) return null;

    const resolved = await API.getCurrentGameDb();
    // Per your resolver guide: returns { db, source, gameName, ... } :contentReference[oaicite:3]{index=3}
    return resolved?.source || resolved?.db || null;
  }

  Hooks.once("ready", () => {
    log("Ready. Registering socket listener:", CHANNEL);

    game.socket.on(CHANNEL, async (payload) => {
      if (!payload || typeof payload !== "object") return;

      // 1) Client-side notification handler (everyone receives, but we gate by toUserId)
      if (payload.type === "GACHA_SET_BANNER_RESULT") {
        if (payload.toUserId && payload.toUserId !== game.user.id) return;
        if (payload.ok) ui.notifications.info(payload.message || `Banner switched to: ${payload.banner}`);
        else ui.notifications.error(payload.message || `Failed to switch banner.`);
        return;
      }

      // 2) GM-only banner set handler
      if (payload.type !== "GACHA_SET_BANNER") return;
      if (!game.user.isGM) return; // Only GM should actually write to DB

      const banner = String(payload.banner ?? "").trim();
      const toUserId = String(payload.userId ?? "").trim();

      if (!banner) {
        warn("Reject empty banner.", payload);
        game.socket.emit(CHANNEL, {
          type: "GACHA_SET_BANNER_RESULT",
          ok: false,
          banner: "",
          toUserId,
          message: "No banner name was provided."
        });
        return;
      }

      try {
        const db = await resolveDbActorViaApi();
        if (!db) throw new Error("DB Resolver API couldn't resolve a Database Actor.");

        log(`GM updating DB: system.props.gacha_banner = "${banner}"`, { db: db.name });

        await db.update({ "system.props.gacha_banner": banner });

        game.socket.emit(CHANNEL, {
          type: "GACHA_SET_BANNER_RESULT",
          ok: true,
          banner,
          toUserId,
          message: `Gacha banner switched to: ${banner}`
        });
      } catch (err) {
        console.error(TAG, err);
        game.socket.emit(CHANNEL, {
          type: "GACHA_SET_BANNER_RESULT",
          ok: false,
          banner,
          toUserId,
          message: `GM failed to switch banner. (${err?.message ?? "Unknown error"})`
        });
      }
    });
  });
})();
