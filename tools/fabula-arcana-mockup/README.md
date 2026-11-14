# Fabula Arcana design mockup

Builds the shareable mockup (claude.ai artifact TPxjnLiPcs57dyEzEugaLX) from the game's own duel page
(`modules/fabula-ultima-companion/assets/fabula-arcana/duel.html`, standalone vs-AI mode) plus the PvP
challenge panel (`scripts/fabula-arcana/fa-invite-ui.js`). Art, sounds and the board are inlined from the
local forge-mirror (Forge fallback), so nothing ripped is stored here.

    node tools/fabula-arcana-mockup/build.mjs <module dir> <out.html>

`demo.js` adds the mockup-only "Demo" panel (challenge panel, ready chips, timer fuse, banners,
result screen + PvP rematch, sound choices). Re-run after any duel.html / fa-invite-ui.js change and
republish to the same artifact URL.
