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
  const CFG = { TEAM:3, BUDGET:5, ROUND_CAP:20, STR:2, GOLEM:3, REMEDY:3, SHARD:1, ADV:2, DIS:2, AB_HEAL:2, AI_NOISE:0.25, TIMER:30, PYRE_N:1, PYRE_BURST:4, VORACIOUS:3, ENTRY:2, CHARM:2, KNIFE:9999, VENOM:2, KCHARGE:3, TAILWIND:3, TW_ALL:0, ROO_LEAVE:1, ROO_MARK:0, ROO_BENCH:2, ROO_GOLEM:0, ROO_STEPS:2, HOWL_NEXT:0, WINDUP_NEXT:1, BARRAGE:2 };   // ROO_BENCH: 0 per-victim, 1 walks on bench, 2 field only
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
    skizzik:  {name:'Skizzik', el:'bolt', cost:1, role:'Combo', atk:3, hp:8, def:0, ab:'Static Buildup', txt:'Each damaging attack banks 1 Static. Its third damaging attack deals +3 damage and clears Static.'},
    pyrefly:  {name:'Pyrefly', el:'fire', cost:1, role:'Combo', atk:2, hp:8, def:0, ab:'Funeral Pyre', txt:'Its damaging attack puts Burn on the target. Its next attack on a Burning target consumes it for +4 ATK.'},
    salamander:{name:'Salamander', el:'fire', cost:1, role:'Guardian', atk:3, hp:10, def:1, ab:'Pyrophagy', txt:'The first Fire attack that would damage it deals 2 less. Once per match.'},
    manaray:  {name:'Mana Ray', el:'bolt', cost:1, role:'Punisher', atk:3, hp:9, def:0, ab:'Mana Catcher', txt:'+1 ATK in a round the opponent plays an item.'},
    hellhound:{name:'Hellhound', el:'dark', cost:1, role:'Hunter', atk:4, hp:8, def:0, ab:'On the Hunt', txt:'+1 ATK against a monster at half its max HP or less.'},
    scorpion: {name:'Bandit Scorpion', el:'poison', cost:1, role:'Striker', atk:3, hp:9, def:0, ab:'Venom Sting', txt:'The first time its attack deals damage, +2 damage. Once per match.'},
    archer:   {name:'Bandit Archer', el:'phys', cost:1, role:'Striker', atk:3, hp:8, def:1, ab:'Double Strafe', txt:'Whenever it attacks, it also deals 1 damage to a random benched enemy (ignores DEF, items and elements).'},
    wolf:     {name:'Wolf', el:'phys', cost:1, role:'Combo', atk:3, hp:10, def:0, ab:'Howl', txt:'When it Passes, its attack this round gets +1 ATK.'},
    obsidrax: {name:'Obsidrax', el:'earth', cost:1, role:'Guardian', atk:3, hp:9, def:1, ab:'Earthen Wire', txt:'The first Bolt attack that would damage it is grounded: it takes none, and that damage hits a random enemy instead. Once per match.'},
    fulgimite:{name:'Fulgimite', el:'bolt', cost:2, role:'Pivot', atk:4, hp:9, def:0, ab:'Evasion', txt:'Takes 2 less attack damage in a round it enters by voluntary Switch.'},
    kirin:    {name:'Kirin', el:'bolt', cost:2, role:'Punisher', atk:2, hp:10, def:1, ab:'Lightning Charge', txt:'When an attack damages it, it charges: +3 ATK on its attack next round.'},
    cryo:     {name:'Cryo Gorger', el:'ice', cost:1, role:'Punisher', atk:3, hp:9, def:0, ab:'Cryo Explosion', txt:'When an attack KOs it, it bursts: 2 damage to the attacker.'},
    inferex:  {name:'Inferex', el:'fire', cost:2, role:'Hunter', atk:4, hp:9, def:0, ab:'Voracious', txt:'When its attack KOs the enemy active monster and it survives, 3 damage to a random benched enemy.'},
    roper:    {name:'Roper', el:'phys', cost:2, role:'Punisher', atk:3, hp:11, def:1, ab:'Entangle', txt:'+1 ATK against a monster that entered by voluntary Switch this round.'},
    rgolem:   {name:'Rock Golem', el:'earth', cost:2, role:'Guardian', atk:2, hp:9, def:2, ab:'Wind Up', txt:'After a round in which it Passes, its next attack is an Earthquake: it also deals 1 damage to every benched enemy (does not stack).'},
    gigas:    {name:'Gigas', el:'earth', cost:3, role:'Striker', atk:4, hp:9, def:1, ab:'Crushing Blow', txt:'+1 ATK against a monster with printed DEF 1 or more.'},
    flame:    {name:'Wandering Flame', el:'fire', cost:3, role:'Pivot', atk:5, hp:11, def:0, ab:'Dynamic Entry', txt:'When it enters by voluntary Switch, it deals 2 Fire damage to the enemy active monster (ignores DEF and items).'},
    // ---- future unlocks / retired (never in the launch pool) ----
    roo:      {name:'Roo', el:'dark', cost:1, role:'Combo', atk:0, hp:12, def:2, ab:"Chef's Knife", txt:'It does not hurry and it does not stop: +1 step at the end of each round it stays on the field (steps reset if it leaves). On its 3rd round on the field it draws the knife: 9999 damage, then Roo walks away and leaves the duel.'},
    walrog:   {name:'Walrog', el:'ice', cost:3, role:'Guardian', atk:4, hp:12, def:1, ab:'Thick Skin', txt:'The first attack that would damage it deals 3 less. Once per match.'},
    broo:     {future:true, retired:true, name:'Bandit Roo', el:'dark', cost:1, role:'Pivot', atk:3, hp:9, def:0, ab:'Soft Landing', txt:'Takes 2 less attack damage in a round it enters by voluntary Switch.'},
    gorger:   {name:'Aero Gorger', el:'air', cost:1, role:'Punisher', atk:3, hp:9, def:0, ab:'Aero Explosion', txt:'When an attack KOs it, it bursts: 2 damage to the attacker.'},
    succubus: {name:'Succubus', el:'dark', cost:2, role:'Pivot', atk:4, hp:10, def:0, ab:'Charm', txt:'When it enters by voluntary Switch, the enemy active monster is Charmed: −2 ATK this round and next round.'},
    carlbero: {future:true, name:'Carlbero', el:'poison', cost:1, role:'Guardian', atk:3, hp:10, def:1, ab:'Fortify', txt:'When its owner uses Golem Fragment, takes 1 less damage (even through Smoke Bomb).'},
    life:     {future:true, name:'Life Gorger', el:'light', cost:1, role:'Survivor', atk:3, hp:10, def:0, ab:'Renewal', txt:'The first time it survives an attack at 4 HP or less, restore 2 HP. Once per match.'},
    sylph:    {name:'Sylph', el:'air', cost:1, role:'Support', atk:3, hp:8, def:0, ab:'Tailwind', txt:'When Sylph attacks, it raises a Tailwind: for the next 3 rounds your Air monsters have +1 SPD (max 4), even after Sylph leaves.'},
    // ---- character cards (★★★ PCs / NPCs / bosses; playtest v1 2026-11-14, sim: 40-62% with all five in the pool) ----
    // character:true = never drops from monsters (fa-drops-core matchCard) and is never a starter gift.
    hina:     {character:true, name:'Hina', el:'light', cost:3, role:'Support', atk:4, hp:11, def:1, ab:'Foretell', txt:'While Hina is your active card, your opponent chooses first and you see their card before you choose (you get your own timer). Both sides Foretelling = a normal round.'},
    zarg:     {character:true, name:'Zarg', el:'phys', cost:3, role:'Hunter', atk:3, hp:10, def:0, ab:'Barrage', txt:'Whenever he attacks, he also deals 2 damage to the benched enemy with the lowest HP (ignores DEF, items and elements).'},
    raubens:  {character:true, name:'Raubens', el:'none', cost:3, role:'Striker', atk:3, hp:10, def:1, ab:'Bandit King', txt:'Whenever the opponent uses an item while Raubens is your active card, he gains +1 ATK for the rest of the match.'},
    geist:    {character:true, name:'Geist', el:'dark', cost:3, role:'Guardian', atk:3, hp:5, def:1, ab:'The Blackest Night', txt:'The first time he would fall to 0 HP (anywhere, any source), he rises again at full HP; extra damage is lost. The second time, he falls for real.'},
    kalina:   {character:true, name:'Kalina', el:'air', cost:3, role:'Combo', atk:1, hp:10, def:5, ab:'Jump', txt:'When she Passes, she Jumps: she still attacks this round, then lands next round with her ATK and DEF swapped for that round.'},
  };
  // v0.5 Speed = DEX die tier (d6=1, d8=2, d10=3, d12=4) from the world sheets
  const SPD = { gigas:1, gorger:2, carlbero:2, kirin:2, flame:2, cryo:2, sylph:2, fulgimite:3, broo:3, life:3, pyrefly:4, skizzik:4,
    salamander:2, manaray:3, hellhound:3, scorpion:2, archer:2, wolf:2, inferex:3, roper:2, obsidrax:2, roo:1, walrog:1, succubus:3, rgolem:1,
    hina:1, zarg:4, raubens:2, geist:3, kalina:3 };   // characters: their sheets' DEX dice (Hina d6, Zarg d12, Rauben d8, Geist d10, Kalina d10)   // Roo SPD 1 by design (slow Tonberry), not its DEX die
  for (const k of Object.keys(CARDS)) CARDS[k].spd = SPD[k];
  const ITEMS = {
    STRENGTH:{t:'Tincture of Strength', k:'Attack', d:`+${CFG.STR} ATK this round`, art:'i_strength'},
    GOLEM:{t:'Golem Fragment', k:'Guard', d:`−${CFG.GOLEM} damage taken`, art:'i_golem'},
    REMEDY:{t:'Remedy', k:'Recover', d:`Heal ${CFG.REMEDY} HP before attacks`, art:'i_remedy'},
    SMOKE:{t:'Smoke Bomb', k:'Trick', d:'Your attack ignores Golem Fragment', art:'i_smoke'},
    SHARD:{t:'Elemental Shard', k:'Neutralize', d:`Attack turns Elementless, +${CFG.SHARD} ATK`, art:'i_shard'},
    CAFE:{t:'Café au Lait', k:'Swift', d:'+1 SPD this round (max 4)', art:'i_cafe'},
  };
  const ACT_T = { ...Object.fromEntries(Object.entries(ITEMS).map(([k,v])=>[k,v.t])), PASS:'Pass', SWITCH:'Switch' };

  const Catalog = Object.freeze({ CFG, AI_DIFF, AI_STYLE, EL, BEATS, ROLES, CARDS, SPD, ITEMS, ACT_T });
  globalThis.FabulaArcana = globalThis.FabulaArcana || {};
  globalThis.FabulaArcana.Catalog = Catalog;
})();
