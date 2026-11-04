// ONI — Divination (with timing hooks)
(async () => {
const TAG = "[ONI][FX]";
const FX_BURST = "modules/JB2A_DnD5e/Library/Generic/Particles/ParticleBurstStar01_01_Regular_BluePurple_600x600.webm";
const FX_CIRCLE = "modules/JB2A_DnD5e/Library/Generic/Cast/CastShapeCircleSingle01_01_Regular_Blue_600x600.webm";
const SFX_START_1 = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/Up3.ogg";
const SFX_START_2 = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/Starlight.ogg";
if (!game.modules.get("sequencer")?.active) {
ui.notifications.error(`${TAG} Sequencer module is not active.`);
return;
}
const targets = Array.from(game.user.targets ?? []);
if (targets.length !== 1) {
ui.notifications.warn(`${TAG} Please target exactly 1 token.`);
return;
}
const token = targets[0];
const center = token.center;
const squaresUp = 0.9;
const yUpPx = canvas.grid.size * squaresUp;
const locAbove = { x: center.x, y: center.y - yUpPx };
const locOn = { x: center.x, y: center.y };
// ✅ Tell the handler “animation started”
Hooks.callAll("oni:animationStart", { tag: "Divination", tokenId: token.id });
const seq = new Sequence()
.sound().file(SFX_START_1).volume(0.8)
.effect().file(FX_BURST).atLocation(locAbove).scaleToObject(1.3).anchor({ x: 0.5, y: 0.5 }).opacity(1.0).belowTokens(false)
.wait(1500)
.sound().file(SFX_START_2).volume(0.8)
.effect().file(FX_CIRCLE).atLocation(locOn).scaleToObject(1.8).anchor({ x: 0.5, y: 0.5 }).opacity(0.5).belowTokens(false);
// IMPORTANT: await play so we can emit “end” at the true end
await seq.play();
// ✅ Tell the handler “animation ended”
Hooks.callAll("oni:animationEnd", { tag: "Divination", tokenId: token.id });
})();
