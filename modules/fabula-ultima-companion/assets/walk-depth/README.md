# Walk-map parallax weights

One grey image per painted walk map, named after the scene's background image
(`Valley_Map010.png` -> `Valley_Map010.webp`), read by
`scripts/map-system/exploration-parallax.js`.

- 128 = rigid (the walkable ground, inside the walls: never moves)
- brighter = farther than the ground at that row (scrolls slower than the camera)
- darker = nearer (scrolls faster)
- half the painting's size is enough; the shader samples it smoothly

## Making one (on the GM's PC, not in the game)

The tools live outside the repo, next to the foreground-occluder tools:
`E:\Art(New Com)\DND\Fabula Ultima\Resource\Map Occluder\` (`env/` = Node
packages, `models/` = the Depth Anything model, downloaded on first use).

1. Put the painting at `_work/<name>/map.png`.
2. `node _tools/depth.mjs "<env>" _work/<name>/map.png _work/<name>`
   (Depth Anything V2 small, ~10 s) -> `depth.f32`, `depth.png`.
3. Export the scene's walls to `_work/<name>/walls.json`:
   `{ "w": <scene width>, "h": <scene height>, "walls": [[x1,y1,x2,y2], ...], "start": [x, y] }`,
   `start` being any point on the walkable ground. With the game open (GM console):
   `const s = canvas.scene; copy(JSON.stringify({ w: s.width, h: s.height, walls: s.walls.map(w => w.c), start: [x, y] }))`
   (the scene must have no padding, so wall and image pixels line up).
4. `node _tools/walk-parallax-bake.mjs "<env>" _work/<name>` -> `parallax.png` and
   `parallax-preview.png` (blue = moves less, red = moves more). Check the preview: the
   path must be untinted. A flood fill that "leaked" means a gap in the walls.
5. `ffmpeg -i _work/<name>/parallax.png -c:v libwebp -lossless 1 <this folder>/<name>.webp`
6. Scene Config -> Depth Index -> Walk Parallax on.
