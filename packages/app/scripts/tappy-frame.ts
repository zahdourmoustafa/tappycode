/**
 * Records one frame of Tappy, drawn by the real engine, as a list of draw calls
 * (JSON on stdout). `make-icon.py` paints them into the app icon, so the icon
 * is the same Tappy the app animates, not a drawing of him.
 *
 *   bun packages/app/scripts/tappy-frame.ts <size> <mood> [color] [t] [seed] [lift]
 *
 * `lift` (0..1) raises the unlit body dots toward the lit colour: on a small
 * icon a dark body on a dark canvas disappears.
 */
import { makeTappyBody, paintTappy, settleTappy, type TappyMood, type TappyPainter, type RGB } from "../src/tappy/engine";
import { tappyPalette } from "../src/tappy/palette";

const [size = "720", mood = "happy", color = "", t = "4", seed = "", lift = "0"] = process.argv.slice(2);
const S = Number(size);
const ops: unknown[] = [];
// Copied: the engine reuses one scratch colour for every dot it paints.
const c3 = (c: RGB): number[] => [c[0], c[1], c[2]];
const p: TappyPainter = {
  dot: (x, y, r, c, a) => ops.push(["dot", x, y, r, c3(c), a]),
  glow: (x, y, r, c, a) => ops.push(["glow", x, y, r, c3(c), a]),
  oval: (cx, cy, rx, ry, rot, c, a, glowR, gc) => ops.push(["oval", cx, cy, rx, ry, rot, c3(c), a, glowR, c3(gc)]),
  line: (pts, width, c, a, glowR, gc) => ops.push(["line", [...pts], width, c3(c), a, glowR, c3(gc)]),
  poly: (pts, c, a) => ops.push(["poly", [...pts], c3(c), a]),
  shadow: (cx, cy, w, h, a) => ops.push(["shadow", cx, cy, w, h, a]),
};
const body = makeTappyBody(S, seed ? Number(seed) : undefined);
settleTappy(body, Number(t), mood as TappyMood);
const pal = tappyPalette(color || undefined);
const k = Math.max(0, Math.min(1, Number(lift)));
const mix = (a: RGB, b: RGB): RGB => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
paintTappy(body, Number(t), mood as TappyMood, { ...pal, off: mix(pal.off, pal.base) }, p);
process.stdout.write(JSON.stringify({ size: S, ops }));
