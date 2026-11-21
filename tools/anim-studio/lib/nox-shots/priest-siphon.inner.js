// ── Soul Siphon (passive, spec soulsiphon.md beat 2 = the Priest's own part): a stream of soul motes peels off the destroyed
// Soul Fragment and pours into the Priest's tome, it flares jade with a power-up (gate = the +30 MP). LIVE board.
// The fragment's own break (Soul Tithe's Destroyed show), the owner's refund heal and the MP number are the game's.
// Fragment = the row's target (trigger_actor), else a 0 HP fragment token on the scene; none found = no stream, the
// power-up still plays on the same clock.
S_(0, 'absorb2', 0.45);
let FIRST = Math.round(900 * 0.85);
if (FRAG && TOK.fr) FIRST = soulStream(0, centerOf('fr'), handAt(0), { n: 22, ms: 900, arc: 120 });
const GLOW = FIRST + 500, GATE = GLOW, OFF = GLOW + 900;
glowOn(GLOW, JADE, 10);
fx('051_powerup_1', GLOW, ftOf('k'), { scale: 1, filter: 'hue-rotate(110deg)' });
S_(GLOW, 'powerup', 0.4);
glowOff(OFF);
await runShot(OFF + 100, GATE);
