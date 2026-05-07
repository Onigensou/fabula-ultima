/*********************************************************
 *  Party Swap + Sheet Update – v2.0  ·  Foundry VTT v12
 *  • Swaps 1 active ↔ 1 benched token (position + visibility)
 *  • Updates ONLY the two affected slots on the Party sheet
 *********************************************************/
(async () => {

  /* ═════════════ 1 — CONFIG ═════════════ */
  const PARTY_ACTOR_ID = "Nexqp1BEGJfZNaLM";      // Party sheet
  const HARD_MAX_ZP    = 6;                       // game rule
  const PATH_STATS = "system.props";              // actor stat path
  const PATH_PARTY = "system.props";              // sheet stat path
  const SFX_MOVE  = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/Move1.ogg";
  const SFX_CURSOR= "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/CursorMove.mp3";

  /* Map actor-stat → party-sheet suffix ----------------- */
  const MAP = {
    level            : "level",
    experience       : "exp",
    current_hp       : "currenthp",
    max_hp           : "maxhp",
    current_mp       : "currentmp",
    max_mp           : "maxmp",
    current_ip       : "currentip",
    max_ip           : "maxip",
    zero_power_value : "currentzp",
    zenit            : "zenit"
    // maxzp handled separately (constant)
  };

  /* ═════════════ 2 — BASIC CHECKS ═════════════ */
  const partyActor = game.actors.get(PARTY_ACTOR_ID);
  if (!partyActor) return ui.notifications.error("Party Swap: Party sheet not found!");

  if (!game.scenes.active) {
    ui.notifications.warn("No active scene found.");
    return;
  }

  const tokens = canvas.tokens.placeables;
  const activeMembers = tokens.filter(t => t.document.disposition === 1 && !t.document.hidden);
  const benchedMembers = tokens.filter(t => t.document.disposition === 1 &&  t.document.hidden);

  if (!activeMembers.length || !benchedMembers.length) {
    ui.notifications.warn("Not enough members to swap.");
    return;
  }

  /* ═════════════ 3 — BUILD UI ═════════════ */
  const makeOpts = arr => arr.map(t => `<option value='${t.id}'>${t.name}</option>`).join("\n");
  const content = `
    <p>Select a party member to <b>swap out</b>:</p>
    <select id='swapOut'>${makeOpts(activeMembers)}</select>
    <p>Select a party member to <b>swap in</b>:</p>
    <select id='swapIn'>${makeOpts(benchedMembers)}</select>
  `;

  new Dialog({
    title: "Swap Party Members",
    content,
    render: html => html.find("select").on("change", () => new Sequence().sound(SFX_CURSOR).play()),
    buttons: {
      confirm: {
        label: "Swap",
        callback: async html => {
          /* -- selections ---------------------------- */
          const swapOutId = html.find("#swapOut").val();
          const swapInId  = html.find("#swapIn").val();
          if (!swapOutId || !swapInId) return ui.notifications.warn("Invalid selection.");

          const swapOut = tokens.find(t => t.id === swapOutId);
          const swapIn  = tokens.find(t => t.id === swapInId);
          if (!swapOut || !swapIn) return ui.notifications.error("Token lookup failed!");

          /* ═════════════ 4 — TOKEN SWAP ═════════════ */
          const {x: xA, y: yA} = swapOut;
          await swapOut.document.update({x: swapIn.x, y: swapIn.y});
          await swapIn.document.update({x: xA,      y: yA});
          await new Promise(r => setTimeout(r, 300));          // ensure movement finished
          await swapOut.document.update({hidden: true});
          await swapIn.document.update ({hidden: false});
          new Sequence().sound(SFX_MOVE).play();

          /* ═════════════ 5 — PARTY SHEET UPDATE ═════ */
          const gp  = foundry.utils.getProperty;
          const upd = {};

          // helper to find sheet slot (1-4) by name
          const findSlot = (kind, name) => {
            for (let i=1;i<=4;i++){
              if (gp(partyActor, `${PATH_PARTY}.${kind}_name_${i}`) === name) return i;
            }
            return 0;
          };

          const activeSlot = findSlot("member", swapOut.name) || 1; // fallback if missing
          const benchSlot  = findSlot("bench" , swapIn.name ) || 1;

          // write a whole stat block into the given slot
          const writeBlock = (kind, slot, actor) => {
            const write = (suffix, v) => upd[`${PATH_PARTY}.${kind}_${suffix}_${slot}`] = v;
            write("name", actor.name);
            Object.entries(MAP).forEach(([src, suffix]) =>
              write(suffix, gp(actor, `${PATH_STATS}.${src}`) ?? 0)
            );
            write("maxzp", HARD_MAX_ZP);
          };

          writeBlock("member", activeSlot, swapIn.actor);
          writeBlock("bench" , benchSlot , swapOut.actor);

          await partyActor.update(upd);

          /* ═════════════ 6 — CHAT FEEDBACK ══════════ */
          ChatMessage.create({
            content: `<b>${swapOut.name}</b> has been swapped out.<br><b>${swapIn.name}</b> is now active!`,
            type   : CONST.CHAT_MESSAGE_TYPES.OOC
          });
        }
      },
      cancel: { label: "Cancel" }
    }
  }).render(true);

  /* opening sound */
  new Sequence().sound(SFX_CURSOR).play();

})();
