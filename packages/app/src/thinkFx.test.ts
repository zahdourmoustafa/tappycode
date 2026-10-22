import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FxPainter, FxPalette } from "./launchFx";
import {
  changeSpark,
  energy,
  orbiter,
  ORBITERS,
  paintDialBack,
  paintDialFront,
  tappyKick,
  SPARKS,
  stopFraction,
  TRACK_DOTS,
  type DialGeometry,
  type DialMoment,
} from "./thinkFx";

const G: DialGeometry = { size: 260, radius: 104, tappyR: 36, start: (150 * Math.PI) / 180, span: (240 * Math.PI) / 180, stops: 5 };
const PAL: FxPalette = { bg: [10, 10, 12], base: [217, 119, 87], light: [255, 190, 160], off: [52, 54, 62] };
const still = (level: number): DialMoment => ({ t: 1, level, since: 10, dir: 1, stop: 0 });

function recorder() {
  const calls = { dot: 0, glow: 0, ring: 0, radial: 0, bad: 0 };
  const check = (...n: number[]) => {
    if (n.some((v) => !Number.isFinite(v))) calls.bad++;
  };
  const p: FxPainter = {
    dot: (x, y, r, _c, a) => (check(x, y, r, a), calls.dot++),
    glow: (x, y, r, _c, a) => (check(x, y, r, a), calls.glow++),
    ring: (x, y, r, w, _c, a) => (check(x, y, r, w, a), calls.ring++),
    cover: (_c, a, h) => check(a, h),
    radial: (x, y, r, _c, a) => (check(x, y, r, a), calls.radial++),
  };
  return { p, calls };
}

const visibleOrbiters = (level: number) => {
  const out = new Float32Array(4);
  let n = 0;
  for (let i = 0; i < ORBITERS; i++) {
    orbiter(G, i, 2, level, out);
    if (out[3]! > 0.01) n++;
  }
  return n;
};

describe("energy", () => {
  test("rises with the level, from nothing to everything", () => {
    expect(energy(0)).toBe(0);
    expect(energy(1)).toBe(1);
    expect(energy(0.5)).toBeGreaterThan(energy(0.25));
  });

  test("the lowest level has no sparks round Tappy, the top has them all", () => {
    expect(visibleOrbiters(0)).toBeLessThanOrEqual(1);
    expect(visibleOrbiters(0.5)).toBeGreaterThan(visibleOrbiters(0.25));
    expect(visibleOrbiters(1)).toBe(ORBITERS);
  });

  test("orbits stay round Tappy and inside the dial", () => {
    const out = new Float32Array(4);
    for (let i = 0; i < ORBITERS; i++) {
      for (let t = 0; t < 5; t += 0.1) {
        orbiter(G, i, t, 1, out);
        const d = Math.hypot(out[0]! - G.size / 2, out[1]! - G.size / 2);
        expect(d).toBeLessThan(G.radius);
      }
    }
  });
});

describe("a change", () => {
  test("stepping up throws sparks outward from the stop that lit", () => {
    const out = new Float32Array(4);
    const m: DialMoment = { t: 1, level: 1, since: 0.25, dir: 1, stop: 4 };
    let outward = 0;
    for (let i = 0; i < SPARKS; i++) {
      changeSpark(G, m, i, out);
      if (out[3]! > 0 && Math.hypot(out[0]! - G.size / 2, out[1]! - G.size / 2) > G.radius) outward++;
    }
    expect(outward).toBeGreaterThan(SPARKS / 2);
  });

  test("stepping down drops sparks that fall", () => {
    const out = new Float32Array(4);
    const m = (since: number): DialMoment => ({ t: 1, level: 0.5, since, dir: -1, stop: 3 });
    changeSpark(G, m(0.05), 0, out);
    const y0 = out[1]!;
    changeSpark(G, m(0.4), 0, out);
    expect(out[1]!).toBeGreaterThan(y0);
  });

  test("a change fires a ring and sparks; a settled dial has neither", () => {
    const busy = recorder();
    paintDialBack(G, { t: 1, level: 0.75, since: 0.2, dir: 1, stop: 3 }, PAL, busy.p, new Float32Array(4));
    paintDialFront(G, { t: 1, level: 0.75, since: 0.2, dir: 1, stop: 3 }, PAL, busy.p, new Float32Array(4));
    expect(busy.calls.ring).toBeGreaterThan(0);
    const calm = recorder();
    paintDialBack(G, still(0.75), PAL, calm.p, new Float32Array(4));
    expect(calm.calls.ring).toBe(0);
  });

  test("Tappy swells on a step up and shrinks on a step down, then settles", () => {
    expect(tappyKick(0.12, 1)).toBeGreaterThan(1);
    expect(tappyKick(0.12, -1)).toBeLessThan(1);
    expect(tappyKick(1, 1)).toBe(1);
  });
});

test("the track and every stop are drawn at any level", () => {
  const { p, calls } = recorder();
  paintDialBack(G, still(0), PAL, p, new Float32Array(4));
  expect(calls.dot).toBeGreaterThanOrEqual(TRACK_DOTS + G.stops);
  expect(stopFraction(G, 0)).toBe(0);
  expect(stopFraction(G, 4)).toBe(1);
});

test("every frame of a run up and down is finite", () => {
  const { p, calls } = recorder();
  const s = new Float32Array(4);
  for (let f = 0; f < 300; f++) {
    const t = f / 60;
    const m: DialMoment = { t, level: (Math.sin(t) + 1) / 2, since: t % 1.2, dir: f % 2 ? 1 : -1, stop: f % 5 };
    paintDialBack(G, m, PAL, p, s);
    paintDialFront(G, m, PAL, p, s);
  }
  expect(calls.bad).toBe(0);
});

test("worklets never call a helper declared below them", () => {
  const src = readFileSync(join(import.meta.dir, "thinkFx.ts"), "utf8");
  const fns = [...src.matchAll(/^(?:export )?function (\w+)/gm)].map((m) => [m[1]!, m.index!] as const);
  fns.forEach(([, at], k) => {
    const body = src.slice(at, fns[k + 1]?.[1] ?? src.length);
    for (const [other, otherAt] of fns) if (otherAt > at) expect(body.includes(`${other}(`)).toBe(false);
  });
});
