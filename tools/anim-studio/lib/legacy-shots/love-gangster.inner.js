// Love: Gangster Paradise (inner script). Port of the approved Legacy boss mockup (part-b3.js "gangster").
// The IP LOGIC is untouched and runs in the outer script (legacy-love-signatures.js, gangsterLogic),
// before this plays, exactly as the shipped script did (IP taken from every foe, shared at random
// among his allies, written to the sheets). It passes cfg.gp = { loss: [{ id, amount }], gain: [{ id, amount }] }.
// Here: he plays a tune (notes from his hand), coins drain from every foe that lost IP into one point
// above the field, then fly on to every ally that gained. No floating numbers (the old +/- text is gone).
if (!caster) { K.ready(); oni.fireDone(); return; }
const t = cfg.t || {}; const GP = cfg.gp || null;
const SIDES = LV.sides();
// tokens: foes and allies that take part, keyed f0.. / a0.. (targets keep their t-key)
const tk = new Map(); targets.forEach((x, i) => tk.set(x.id, 't' + i));
const extra = {}; const FK = [], AK = [];
const lossOf = new Map(), gainOf = new Map();
if (GP) { for (const e of GP.loss || []) lossOf.set(e.id, Number(e.amount) || 0); for (const e of GP.gain || []) gainOf.set(e.id, Number(e.amount) || 0); }
SIDES.foes.forEach((x, i) => { if (GP && !(lossOf.get(x.id) > 0)) return; const k = tk.get(x.id) || ('f' + i); if (!tk.has(x.id)) extra[k] = { token: x }; FK.push(k); });
SIDES.allies.forEach((x, i) => { if (GP && !(gainOf.get(x.id) > 0)) return; const k = tk.get(x.id) || ('a' + i); if (!tk.has(x.id)) extra[k] = { token: x }; AK.push(k); });
const { tl, T, m, TOK } = await boot(extra);
LV.init(tl, TOK, SIDES.foes);
const U = LV.U;
const HI = LV.layer(m, 80);
// the coin pool: the mockup's (760, 220) = half-way across, above everyone's heads
const all = FK.concat(AK).concat(['c']).filter((k) => TOK[k]);
let minHead = Infinity; for (const k of all) minHead = Math.min(minHead, LV.head(k).y);
const fx = FK.length ? FK.reduce((s, k) => s + LV.F(k).x, 0) / FK.length : LV.F('c').x + LV.DIR * 600 * U;
const POOL = { x: (LV.F('c').x + fx) / 2, y: minHead - 40 * U };

// the tune: notes from his hand from the start until the last coin lands
LV.noteStream(HI, 0, t.gate, 140, LV.hand('c'));
LV.S(0, 'steal', 0.45);
// coins from every foe that lost IP into the pool (2 each, 600 ms), then from the pool to every ally that gained (2 each, 520 ms)
FK.forEach((k, i) => { LV.coinsTo(HI, t.drain, LV.body(k), POOL, 2, 600); LV.S(t.drain + i, 'coin', 0.45); });
AK.forEach((k, i) => { LV.coinsTo(HI, t.share, POOL, LV.body(k), 2, 520); LV.S(t.share + i, 'coin', 0.45); });
LV.gate(m, t.gate);
await tl.run(T, { total: t.gate + 700, sfx: LV.sfx, onStart: K.ready });
oni.fireDone();
