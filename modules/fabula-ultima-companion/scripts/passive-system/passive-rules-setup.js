// Passive rules auto-setup at startup: write rules into item.system.props.passive_logic_action (rich text JSON)
(function(){
  const TAG='[PassiveLogicActionSetup]';
  const wants = [
    { keys: ['Ice Mastery (Test)','Ice Mastery'], rules: [{ id:'ice-mastery-flat', label:'Ice Mastery', when:{ all:[{ action:{ elementIn:['ice'] } }] }, effects:[{ type:'flat', scope:'outgoing', element:'ice', amount:9999 }] }] },
    { keys: ['Cognitive Focus'], rules: [{ id:'focus-outgoing-bonus', label:'Cognitive Focus', when:{ all:[{ actor:{ flagEquals:{ ns:'oni', key:'focus.active', equals:true } } }] }, effects:[{ type:'percent', scope:'outgoing', element:'all', amount:0.25 }], options:{ recalcOnConfirm:'ifElementUnknown' } }] },
    { keys: ['Hypercognition'], rules: [{ id:'hyper-crit-ramp', label:'Hypercognition', when:{ all:[{ actor:{ flagCompare:{ ns:'oni', key:'focus.stacks', op:">=", value:3 } } }] }, effects:[{ type:'critMult', amount:1.5 }, { type:'flat', scope:'outgoing', element:'ice', amount:250 }] }] }
  ];

  function byKeysMatch(items, keys){
    const lower = keys.map(k => String(k).toLowerCase());
    const exactFirst = items.find(i => lower.includes(String(i.name).toLowerCase()));
    if (exactFirst) return [exactFirst];
    return items.filter(i => lower.some(k => String(i.name).toLowerCase().includes(k)));
  }

  function parseRules(raw){
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    if (typeof raw !== 'string') return [];
    try {
      let s = String(raw).replace(/<[^>]*>/g,'').trim();
      try {
        const p = JSON.parse(s);
        return Array.isArray(p) ? p : [];
      } catch {}

      s = s.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"')
           .replace(/([\{,]\s*)([A-Za-z_][\w-]*)\s*:/g, '$1"$2":')
           .replace(/'([^']*)'/g, '"$1"')
           .replace(/,\s*([}\]])/g, '$1');

      const p2 = JSON.parse(s);
      return Array.isArray(p2) ? p2 : [];
    } catch {
      return [];
    }
  }

  async function ensurePropsRules(it, rules){
    const ip = it?.system?.props ?? {};
    const have = parseRules(ip.passive_logic_action);
    if (have.length) return false;

    const html = `<p>${JSON.stringify(rules)}</p>`;
    await it.update({ 'system.props.passive_logic_action': html });
    return true;
  }

  Hooks.once('ready', async () => {
    try {
      const seeded = [];

      for (const want of wants){
        const worldHits = byKeysMatch(game.items ?? [], want.keys);
        for (const it of worldHits){
          if (await ensurePropsRules(it, want.rules)) {
            console.log(TAG, 'set passive_logic_action on World Item', it.name);
            seeded.push(it.name);
          }
        }

        for (const a of game.actors ?? []){
          const hits = byKeysMatch(a.items ?? [], want.keys);
          for (const it of hits){
            if (await ensurePropsRules(it, want.rules)) {
              console.log(TAG, 'set passive_logic_action on', it.name, 'owner', a.name);
              seeded.push(`${it.name}@${a.name}`);
            }
          }
        }
      }

      if (seeded.length) {
        ui.notifications?.info(`Passive Logic Action props seeded: ${seeded.length}`);
      }
    } catch (e) {
      console.error(TAG,'setup failed', e);
    }
  });

  // Seed rules when new items are created mid-session (GM only)
  Hooks.on('createItem', async (item, options, userId) => {
    try {
      if (!game.user?.isGM) return; // avoid multi-user duplication

      const lower = (s)=>String(s||'').toLowerCase();
      const name = lower(item.name);

      const want = wants.find(w => w.keys.some(k => {
        const key = lower(k);
        return name === key || name.includes(key);
      }));

      if (!want) return;

      const wrote = await ensurePropsRules(item, want.rules);
      if (wrote) {
        console.log(TAG, 'seeded passive_logic_action on create', item.name, item.parent?.name ?? 'World');
      }
    } catch (e) {
      console.error(TAG, 'createItem seed failed', e);
    }
  });
})();