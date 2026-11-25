/**
 * Fabula Arcana — card catalog + tunables (data only; no Foundry calls; node-testable)
 *
 * File: scripts/fabula-arcana/fa-catalog.js
 *
 * Monster cards, roles, the six action items, element chart, AI profiles and every [TUNE] number.
 * Lifted 1:1 from the approved mockup (Launch Roster v2.4 + user tuning, 2026-11-14).
 * `future:true` cards are kept for later unlocks and never enter the pool (IDS in fa-engine.js).
 * `retired:true` = no longer part of the game (Bandit Roo was replaced by Roo).
 * ITEMS[*].art are asset keys the UI maps to icons.
 */
(() => {
  const CFG = { TEAM:3, BUDGET:5, ROUND_CAP:20, STR:2, GOLEM:3, REMEDY:3, SHARD:1, ADV:2, DIS:2, AB_HEAL:2, AI_NOISE:0.25, TIMER:30, PYRE_N:1, PYRE_BURST:4, VORACIOUS:3, ENTRY:2, CHARM:2, KNIFE:9999, VENOM:2, KCHARGE:3, TAILWIND:3, TW_ALL:0, ROO_LEAVE:1, ROO_MARK:0, ROO_BENCH:2, ROO_GOLEM:0, ROO_STEPS:2, HOWL_NEXT:0, WINDUP_NEXT:1, BARRAGE:2, FORETELL_S:10, TIPS_HEAL:2, FOXFIRE:2, FOXFIRE_CAP:6, SPD_MAX:5, SLIPSTREAM:2, SERENADE:2, SERENADE_ROUNDS:4, BERSERK_ATK:3, BERSERK_TAKE:1, TWIN:1, GRACE_HEAL:2, GRACE_SELF:0, GRACE_MODE:4, REGEN:3, REGEN_ROUNDS:4, SERENADE_DEF:2, SERENADE_MODE:2, BREATH_ATK:1, BREATH_ROUNDS:3, PIERCE:2, THIEF_BOW:2, NULL_GUARD:3, HEAVY_ARMOR:2, RIVAL:1, GEIST_BN:1, DIVE:2, SUPPLY_MIN:3, HAND_MAX:8 };   // HAND_MAX: cards a hand can hold (items + created); a card created into a full hand fizzles   // ROO_BENCH: 0 per-victim, 1 walks on bench, 2 field only
  const AI_DIFF = { casual:{noise:0.25, rand:0.15, speed:false}, skilled:{noise:0.10, rand:0.03, speed:true, lookahead:true} };
  const AI_STYLE = {
    aggressive:{ STRENGTH:1.5, SHARD:1.3, SMOKE:1.2, SWITCH:0.6, GOLEM:0.8, REMEDY:0.8, rand:0 },
    defensive:{ GOLEM:1.5, REMEDY:1.5, SWITCH:1.4, STRENGTH:0.75, SHARD:0.9, rand:0 },
    trickster:{ SMOKE:1.8, SHARD:1.5, PASS:1.1, rand:0.08 },
  };
  const EL = { phys:'Physical', air:'Air', bolt:'Bolt', dark:'Dark', earth:'Earth', fire:'Fire', ice:'Ice', light:'Light', poison:'Poison', none:'Elementless' };
  // v0.3 universal chart: Ice > Fire > Air > Earth > Bolt > Ice; Light <> Dark and Poison <> Physical are mutual.
  const BEATS = { ice:'fire', fire:'air', air:'earth', earth:'bolt', bolt:'ice', light:'dark', dark:'light', poison:'phys', phys:'poison' };
  // Roles = descriptive tags only (ChatGPT v2). Rank (cost) is separate: soldier ★, elite ★★, boss ★★★.
  const ROLES = {
    Striker:  'Consistent attack pressure or a reliable damage bonus.',
    Hunter:   'Strong against weakened targets or finishing KOs.',
    Guardian: 'Durability and damage mitigation.',
    Survivor: 'Stays active or avoids defeat.',
    Combo:    'Builds toward a burst, or rewards a specific sequence.',
    Pivot:    'Gains value from switching and repositioning.',
    Punisher: "Capitalises on the opponent's choices or on being attacked.",
    Support:  'Sets up or empowers the rest of your team.',
  };
  const CARDS = {
    // ---- launch pool v2 (16, all met in the bestiary) ----
    skizzik:  {name:'Skizzik', el:'bolt', cost:1, role:'Combo', atk:3, hp:8, def:0, ab:'Static Buildup', txt:'Every 3rd damaging attack from this unit deals +3 DMG.'},
    pyrefly:  {name:'Pyrefly', el:'fire', cost:1, role:'Combo', atk:2, hp:8, def:0, ab:'Funeral Pyre', txt:'After this unit\'s attack deals damage: the target gains Burn. This unit\'s next attack on a Burning card uses up Burn for +4 ATK.'},
    salamander:{name:'Salamander', el:'fire', cost:1, role:'Guardian', atk:3, hp:10, def:1, ab:'Pyrophagy', txt:'The first Fire attack against this unit deals −2 DMG. Once per Match.'},
    manaray:  {name:'Mana Ray', el:'bolt', cost:1, role:'Punisher', atk:3, hp:9, def:0, ab:'Mana Catcher', txt:'+1 ATK in rounds the opponent uses an item.'},
    hellhound:{name:'Hellhound', el:'dark', cost:1, role:'Hunter', atk:4, hp:8, def:0, ab:'On the Hunt', txt:'+1 ATK against cards at half HP or less.'},
    scorpion: {name:'Bandit Scorpion', el:'poison', cost:1, role:'Striker', atk:3, hp:9, def:0, ab:'Venom Sting', txt:'This unit\'s first damaging attack deals +2 DMG. Once per Match.'},
    archer:   {name:'Bandit Archer', el:'phys', cost:1, role:'Striker', atk:3, hp:8, def:1, ab:'Double Strafe', txt:'When this unit attacks: deal 1 Piercing DMG to a random enemy Bench card.'},
    wolf:     {name:'Wolf', el:'phys', cost:1, role:'Combo', atk:3, hp:10, def:0, ab:'Howl', txt:'When this unit Passes: +1 ATK this round.'},
    obsidrax: {name:'Obsidrax', el:'earth', cost:1, role:'Guardian', atk:3, hp:9, def:1, ab:'Earthen Wire', txt:'The first Bolt attack against this unit is redirected to a random enemy. Once per Match.'},
    fulgimite:{name:'Fulgimite', el:'bolt', cost:2, role:'Pivot', atk:4, hp:9, def:0, ab:'Evasion', txt:'When Switched In: this unit takes −2 DMG this round.'},
    kirin:    {name:'Kirin', el:'bolt', cost:2, role:'Punisher', atk:2, hp:10, def:1, ab:'Lightning Charge', txt:'After this unit takes attack damage: +3 ATK next round.'},
    cryo:     {name:'Cryo Gorger', el:'ice', cost:1, role:'Punisher', atk:3, hp:9, def:0, ab:'Cryo Explosion', txt:'When this unit is KO\'d by an attack: deal 2 DMG to the attacker.'},
    inferex:  {name:'Inferex', el:'fire', cost:2, role:'Hunter', atk:4, hp:9, def:0, ab:'Voracious', txt:'After this unit\'s attack KOs the enemy active card, if this unit survives: deal 3 DMG to a random enemy Bench card.'},
    roper:    {name:'Roper', el:'phys', cost:2, role:'Punisher', atk:3, hp:11, def:1, ab:'Entangle', txt:'+1 ATK against a card Switched In this round.'},
    rgolem:   {name:'Rock Golem', el:'earth', cost:2, role:'Guardian', atk:2, hp:11, def:2, ab:'Wind Up', txt:'After a round this unit Passes: this unit\'s next attack also deals 1 DMG to each enemy Bench card.'},
    gigas:    {name:'Gigas', el:'earth', cost:3, role:'Striker', atk:5, hp:9, def:1, ab:'Crushing Blow', txt:'+1 ATK against cards with printed DEF 1+.'},
    flame:    {name:'Wandering Flame', el:'fire', cost:3, role:'Pivot', atk:5, hp:11, def:0, ab:'Dynamic Entry', txt:'When Switched In: deal 2 Piercing Fire DMG to the enemy active card.'},
    // ---- future unlocks / retired (never in the launch pool) ----
    roo:      {name:'Roo', el:'dark', cost:1, role:'Combo', atk:0, hp:12, def:2, ab:"Chef's Knife", txt:'This unit\'s attacks deal no damage. End of round on the field: gain 1 Step (lost when this unit leaves). At 3 Steps: deal 9999 DMG, then this unit leaves the duel.'},
    walrog:   {name:'Walrog', el:'ice', cost:3, role:'Guardian', atk:4, hp:12, def:1, ab:'Thick Skin', txt:'The first attack against this unit deals −3 DMG. Once per Match.'},
    broo:     {future:true, retired:true, name:'Bandit Roo', el:'dark', cost:1, role:'Pivot', atk:3, hp:9, def:0, ab:'Soft Landing', txt:'Takes 2 less attack damage in a round it enters by voluntary Switch.'},
    gorger:   {name:'Aero Gorger', el:'air', cost:1, role:'Punisher', atk:3, hp:9, def:0, ab:'Aero Explosion', txt:'When this unit is KO\'d by an attack: deal 2 DMG to the attacker.'},
    succubus: {name:'Succubus', el:'dark', cost:2, role:'Pivot', atk:4, hp:10, def:0, ab:'Charm', txt:'When Switched In: the enemy active card becomes Charmed.'},
    carlbero: {name:'Carlbero', el:'poison', cost:3, role:'Punisher', atk:3, hp:10, def:1, ab:'Stinking Breath', txt:'After this unit\'s attack deals damage: the target gets −1 ATK, −1 DEF and −1 SPD. Duration (Rounds): 3.'},
    life:     {future:true, name:'Life Gorger', el:'light', cost:1, role:'Survivor', atk:3, hp:10, def:0, ab:'Renewal', txt:'The first time it survives an attack at 4 HP or less, restore 2 HP. Once per match.'},
    sylph:    {name:'Sylph', el:'air', cost:1, role:'Support', atk:3, hp:8, def:0, ab:'Tailwind', txt:'When this unit attacks: your Air cards gain +1 SPD. Duration (Rounds): 3.'},
    // ---- character cards (★★★ PCs / NPCs / bosses; playtest v1 2026-11-14, sim: 40-62% with all five in the pool) ----
    // character:true = never drops from monsters (fa-drops-core matchCard) and is never a starter gift.
    hina:     {character:true, name:'Hina', el:'light', cost:3, role:'Support', atk:4, hp:11, def:1, ab:'Foretell', txt:'While active: you see the opponent\'s card as soon as it\'s placed, and get 10 extra seconds.'},
    zarg:     {character:true, name:'Zarg', el:'phys', cost:3, role:'Hunter', atk:3, hp:9, def:0, ab:'Barrage', txt:'When this unit attacks: deal 2 Piercing DMG to the enemy Bench card with the lowest HP.'},
    raubens:  {character:true, name:'Raubens', el:'none', cost:3, role:'Striker', atk:3, hp:10, def:1, ab:'Bandit King', txt:'While active: each item the opponent uses gives this unit +1 ATK for the rest of the match.'},
    geist:    {character:true, name:'Geist', el:'dark', cost:3, role:'Guardian', atk:3, hp:5, def:2, ab:'The Blackest Night', txt:'The first time this unit is KO\'d: revive at full HP with +1 ATK for the rest of the match. Once per Match.'},
    blanche:  {character:true, name:'Blanche', el:'phys', cost:3, role:'Support', atk:3, hp:12, def:2, ab:'Give me tips or 5 stars', txt:'When this unit Passes: heal 2 HP to your Bench card with the lowest HP.'},
    keren:    {character:true, name:'Keren', el:'fire', cost:3, role:'Striker', atk:1, hp:12, def:0, ab:'Fox Fire', txt:'+2 ATK for each KO\'d card on either side (max +6). Counts while on the Bench.'},
    gryphon:  {character:true, name:'Gryphon', el:'air', cost:3, role:'Guardian', atk:3, hp:11, def:1, ab:'Slipstream', txt:'+2 DEF against slower attackers.'},
    love:     {character:true, name:'Love', el:'light', cost:3, role:'Support', atk:1, hp:11, def:2, ab:'Love Serenade', txt:'When this unit is Switched Out: the incoming card gains +2 ATK and +2 DEF. Duration (Rounds): 4.'},
    jack:     {character:true, name:'Jack', el:'poison', cost:2, role:'Hunter', atk:3, hp:11, def:0, ab:'Thief Bow', txt:'+2 ATK in rounds the opponent uses an item. Twin: when Jill is KO\'d, +1 ATK for the rest of the match.'},
    jill:     {character:true, name:'Jill', el:'phys', cost:2, role:'Guardian', atk:3, hp:12, def:0, ab:'Temper Tantrum', txt:'At half HP or less: becomes Berserk. Twin: when Jack is KO\'d, +1 ATK for the rest of the match.'},
    // ---- batch 4 (2026-11-16): Bruce V (tutorial boss), Nullis + Gardner (rivals) ----
    brucev:   {character:true, name:'Bruce V', el:'phys', cost:2, role:'Striker', atk:4, hp:10, def:0, ab:'Teleportation Strike', txt:'This unit\'s attacks ignore 2 DEF.'},
    nullis:   {character:true, name:'Nullis', el:'light', cost:2, role:'Punisher', atk:3, hp:11, def:1, ab:'Null Guard', txt:'+3 DEF in rounds the opponent uses an item. Rival: when Gardner is KO\'d, +1 DEF for the rest of the match.'},
    gardner:  {character:true, name:'Gardner', el:'earth', cost:2, role:'Guardian', atk:3, hp:10, def:2, ab:'Heavy Armor', txt:'+2 DEF in rounds the opponent Passes. Rival: when Nullis is KO\'d, +1 DEF for the rest of the match.'},
    hilde:    {character:true, name:'Princess Hilde', el:'light', cost:3, role:'Support', atk:2, hp:14, def:1, ab:'Royal Grace', txt:'When this unit Passes: your side gains Regen from next round. Duration (Rounds): 4.'},
    kalina:   {character:true, name:'Kalina', el:'air', cost:3, role:'Pivot', atk:2, hp:11, def:2, ab:'Skyfall Dive', txt:'After this unit attacks: swap in a Bench card of your choice (the new card takes any incoming attack). This unit becomes Dive Ready.'},
    // ---- batch 5 (2026-11-17) ----
    hako:     {character:true, name:'Hako', el:'none', cost:3, role:'Support', atk:3, hp:12, def:0, ab:'Trusty Supplier', txt:'Start of round, while active: if 3+ of your items are used, 1 random one returns to your hand.'},
  };
  // v0.5 Speed = DEX die tier (d6=1, d8=2, d10=3, d12=4) from the world sheets
  const SPD = { gigas:1, gorger:2, carlbero:2, kirin:2, flame:2, cryo:2, sylph:2, fulgimite:3, broo:3, life:3, pyrefly:4, skizzik:4,
    salamander:2, manaray:3, hellhound:3, scorpion:2, archer:2, wolf:2, inferex:3, roper:2, obsidrax:2, roo:1, walrog:1, succubus:3, rgolem:1,
    hina:1, zarg:4, raubens:2, geist:3, kalina:3, blanche:2, keren:3, gryphon:4, love:3, jack:3, jill:2, hilde:3, brucev:2, nullis:2, gardner:1, hako:2 };   // characters: their sheets' DEX dice (Hina d6, Zarg d12, Rauben d8, Geist d10, Kalina d10)   // Roo SPD 1 by design (slow Tonberry), not its DEX die
  for (const k of Object.keys(CARDS)) CARDS[k].spd = SPD[k];
  const ITEMS = {
    STRENGTH:{t:'Tincture of Strength', k:'Attack', d:`+${CFG.STR} ATK this round`, art:'i_strength'},
    GOLEM:{t:'Golem Fragment', k:'Guard', d:`+${CFG.GOLEM} DEF this round`, art:'i_golem'},
    REMEDY:{t:'Remedy', k:'Recover', d:`Heal ${CFG.REMEDY} HP before attacks`, art:'i_remedy'},
    SMOKE:{t:'Smoke Bomb', k:'Trick', d:'Your attack ignores DEF this round.', art:'i_smoke'},
    SHARD:{t:'Elemental Shard', k:'Neutralize', d:`Your attack becomes Elementless and gains +${CFG.SHARD} ATK.`, art:'i_shard'},
    CAFE:{t:'Café au Lait', k:'Swift', d:'+1 SPD this round.', art:'i_cafe'},
    // ---- created cards (2026-11-25, hand model v2): never in the starting hand, Hako never restocks them, gone after use.
    // Effects are DATA (fx), read by the same steps as the items above: atk / def (this round), spd (this round),
    // heal (before attacks), dmg { n, el } (before attacks, ignores DEF and items; el = element chart applies).
    // Numbers are the approved drafts; the new NPC cards' balance sims (phase 4) may retune them.
    LUCKY:{created:true, t:'Lucky Trinket', k:'Created', d:'+1 ATK and +1 DEF this round', art:'c_lucky', fx:{atk:1, def:1}},
    GRAPE:{created:true, t:'Grape Juice', k:'Created', d:'+1 ATK and +1 SPD this round', art:'c_grape', fx:{atk:1, spd:1}},
    APPLE_BOMB:{created:true, t:'Apple Bomb', k:'Created', d:'Deal 2 Piercing Fire DMG to the enemy active card before attacks', art:'c_applebomb', fx:{dmg:{n:2, el:'fire'}}},
    STEW:{created:true, t:'Hearty Stew', k:'Created', d:'Heal 4 HP before attacks', art:'c_stew', fx:{heal:4}},
    ARC_SUN:{created:true, t:'Arcana: The Sun', k:'Created', d:'+2 ATK this round', art:'c_sun', fx:{atk:2}},
    ARC_MOON:{created:true, t:'Arcana: The Moon', k:'Created', d:'+2 DEF this round', art:'c_moon', fx:{def:2}},
    ARC_STAR:{created:true, t:'Arcana: The Star', k:'Created', d:'Heal 2 HP before attacks', art:'c_star', fx:{heal:2}},
    WHETSTONE:{created:true, t:'Whetstone', k:'Created', d:'+2 ATK this round', art:'c_whetstone', fx:{atk:2}},
  };
  const ACT_T = { ...Object.fromEntries(Object.entries(ITEMS).map(([k,v])=>[k,v.t])), PASS:'Pass', SWITCH:'Switch' };
  // Card text keywords (2026-11-25, Genius Invokation style): a card only NAMES these; the duel window shows the
  // definition on hover. Card text never uses a pronoun: "this unit".
  const KEYWORDS = {
    'Switched In':'Entered by a voluntary Switch.',
    'Enters':'Switched In or sent in after a KO.',
    'Piercing DMG':'Ignores DEF and items. Elementless unless an element is named.',
    'Burn':'Pyrefly\x27s next attack on this unit uses up Burn for +4 ATK.',
    'Charmed':'−2 ATK. Duration (Rounds): 2.',
    'Berserk':'+3 ATK, takes +1 DMG from every hit.',
    'Regen':'End of round: your active card heals 3 HP (not the card that raised it).',
    'Dive Ready':'Next time this unit Enters: deal 2 Piercing DMG to the enemy active card.',
  };

  const Catalog = Object.freeze({ CFG, AI_DIFF, AI_STYLE, EL, BEATS, ROLES, CARDS, SPD, ITEMS, ACT_T, KEYWORDS });
  globalThis.FabulaArcana = globalThis.FabulaArcana || {};
  globalThis.FabulaArcana.Catalog = Catalog;
})();
