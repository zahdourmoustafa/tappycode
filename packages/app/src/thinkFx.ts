/**
 * The thinking-level dial's light show, drawn round Tappy in the model sheet.
 *
 * The level is energy: an LED track sweeps round the arc to it with a bright
 * leading head, sparks orbit Tappy (more, faster, on tilted orbits the higher it
 * goes) and his aura swells. A change is an event: stepping up fires a shock
 * ring out of Tappy to the arc and a burst of sparks from the stop that just lit;
 * stepping down sucks a ring back in and the stop that went dark sheds sparks
 * that fall away. At the top the whole track shimmers.
 *
 * Pure and Expo-free (tested under bun); every frame is a function of the
 * moment. `ui/ThinkingDial.tsx` paints it with Skia on the UI thread in two
 * layers, behind and in front of Tappy, so orbiting sparks pass round him rather
 * than across him. Helpers sit above their callers: a worklet cannot call a
 * function declared below it.
 */
import type { FxPainter, FxPalette, FxRGB } from "./launchFx";

export interface DialGeometry {
  /** The box is size×size; Tappy sits at its centre. */
  size: number;
  /** Radius of the arc through the level stops. */
  radius: number;
  /** Tappy's body radius (his box is about 1.7× this). */
  tappyR: number;
  /** Arc start, radians clockwise from +x (screen coordinates). */
  start: number;
  /** Arc span, radians. */
  span: number;
  /** How many levels (stops) the agent offers. */
  stops: number;
}

export interface DialMoment {
  /** Seconds, any running clock. */
  t: number;
  /** 0..1 along the arc; animated, so the track sweeps. */
  level: number;
  /** Seconds since the last change (large: none recent). */
  since: number;
  /** +1 for a step up, -1 for a step down. */
  dir: number;
  /** The stop that changed: lit by a step up, put out by a step down. */
  stop: number;
}

/** Dots in the fine track between stops. */
export const TRACK_DOTS = 54;
/** Sparks orbiting Tappy at full energy. */
export const ORBITERS = 18;
/** Sparks thrown by a change. */
export const SPARKS = 22;
/** How long a change's effects play. */
export const PULSE_S = 0.9;

const WHITE: FxRGB = [255, 255, 255];

export function dialRand(i: number, k: number): number {
  "worklet";
  const s = Math.sin(i * 91.345 + k * 47.853) * 24634.6345;
  return s - Math.floor(s);
}

export function dialClamp(x: number): number {
  "worklet";
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Where along the arc (0..1) stop `i` sits. */
export function stopFraction(g: DialGeometry, i: number): number {
  "worklet";
  return g.stops > 1 ? i / (g.stops - 1) : 0.5;
}

/** A point on the arc at fraction `f`, at `radius` (default the stops' radius). */
export function arcPoint(g: DialGeometry, f: number, radius: number, out: Float32Array): void {
  "worklet";
  const a = g.start + g.span * f;
  out[0] = g.size / 2 + Math.cos(a) * radius;
  out[1] = g.size / 2 + Math.sin(a) * radius;
}

/** How much is going on at this level, 0..1: shapes everything that scales with it. */
export function energy(level: number): number {
  "worklet";
  const l = dialClamp(level);
  return l * (0.55 + 0.45 * l);
}

/**
 * Orbiting spark `i`: x, y, depth (-1 behind Tappy .. 1 in front) and alpha.
 * Orbits are ellipses tilted per spark, so together they read as a sphere of
 * thought round him; the count and speed follow the energy.
 */
export function orbiter(g: DialGeometry, i: number, t: number, level: number, out: Float32Array): void {
  "worklet";
  const e = energy(level);
  const shown = ORBITERS * e;
  if (i >= shown + 1) {
    out[3] = 0;
    return;
  }
  const c = g.size / 2;
  const r = g.tappyR * (1.25 + 0.45 * dialRand(i, 1));
  const tilt = (dialRand(i, 2) - 0.5) * 2.2;
  const flat = 0.28 + 0.3 * dialRand(i, 3);
  const speed = (0.6 + dialRand(i, 4) * 0.8) * (0.5 + 2.4 * e) * (dialRand(i, 5) < 0.5 ? 1 : -1);
  const a = dialRand(i, 6) * Math.PI * 2 + t * speed;
  const ex = Math.cos(a) * r;
  const ey = Math.sin(a) * r * flat;
  out[0] = c + ex * Math.cos(tilt) - ey * Math.sin(tilt);
  out[1] = c + ex * Math.sin(tilt) + ey * Math.cos(tilt);
  out[2] = Math.sin(a);
  // The newest spark fades in as the energy reaches it.
  out[3] = dialClamp(shown - i) * (0.55 + 0.45 * e);
}

/**
 * Spark `i` thrown by a change, `s` seconds in. Up: out of the stop that just
 * lit, flying outward. Down: off the stop that went out, falling away.
 */
export function changeSpark(g: DialGeometry, m: DialMoment, i: number, out: Float32Array): void {
  "worklet";
  const s = m.since;
  const life = 0.45 + dialRand(i, 11) * 0.45;
  if (s < 0 || s > life) {
    out[3] = 0;
    return;
  }
  arcPoint(g, stopFraction(g, m.stop), g.radius, out);
  const ox = out[0]!;
  const oy = out[1]!;
  const c = g.size / 2;
  const away = Math.atan2(oy - c, ox - c);
  if (m.dir > 0) {
    const a = away + (dialRand(i, 12) - 0.5) * 2.4;
    const v = 70 + dialRand(i, 13) * 150;
    const d = (v / 3) * (1 - Math.exp(-3 * s));
    out[0] = ox + Math.cos(a) * d;
    out[1] = oy + Math.sin(a) * d;
  } else {
    const a = away + (dialRand(i, 12) - 0.5) * 1.6;
    const v = 20 + dialRand(i, 13) * 50;
    out[0] = ox + Math.cos(a) * v * s;
    out[1] = oy + Math.sin(a) * v * s + 160 * s * s;
  }
  out[2] = (1 + dialRand(i, 14) * 1.8) * (1 - (0.5 * s) / life);
  out[3] = 1 - (s / life) * (s / life);
}

function pulse(g: DialGeometry, m: DialMoment, pal: FxPalette, p: FxPainter): void {
  "worklet";
  const q = m.since / PULSE_S;
  if (q < 0 || q > 1) return;
  const c = g.size / 2;
  const ease = 1 - (1 - q) * (1 - q) * (1 - q);
  const from = g.tappyR * 0.9;
  const to = g.radius + 10;
  const r = m.dir > 0 ? from + (to - from) * ease : to - (to - from) * ease;
  const a = (1 - q) * (m.dir > 0 ? 0.85 : 0.5);
  p.ring(c, c, r, 1.5 + 5 * (1 - q), m.dir > 0 ? pal.light : pal.base, a);
  if (m.dir > 0) p.ring(c, c, r * 0.82, 1.2, WHITE, a * 0.5);
}

/** Behind Tappy: aura, track, stops, the far side of the orbits, the pulse ring. */
export function paintDialBack(g: DialGeometry, m: DialMoment, pal: FxPalette, p: FxPainter, scratch: Float32Array): void {
  "worklet";
  const c = g.size / 2;
  const e = energy(m.level);
  const flare = m.since < PULSE_S && m.dir > 0 ? (1 - m.since / PULSE_S) * 0.35 : 0;
  p.radial(c, c, g.tappyR * (1.6 + 1.2 * e), pal.base, 0.06 + 0.42 * e + flare);
  pulse(g, m, pal, p);

  // The fine track, lit to the level, with a bright head sweeping along it.
  const top = m.level >= 0.999;
  for (let i = 0; i < TRACK_DOTS; i++) {
    const f = i / (TRACK_DOTS - 1);
    arcPoint(g, f, g.radius, scratch);
    const x = scratch[0]!;
    const y = scratch[1]!;
    const lit = dialClamp((m.level - f) * (TRACK_DOTS - 1) + 1);
    if (lit <= 0) {
      p.dot(x, y, 1.3, pal.off, 1);
      continue;
    }
    const head = Math.exp(-Math.abs(m.level - f) * 22);
    const shimmer = top ? 0.25 * (0.5 + 0.5 * Math.sin(m.t * 6 - f * 14)) : 0;
    const a = (0.45 + 0.35 * f + 0.55 * head + shimmer) * lit;
    if (head > 0.2 || shimmer > 0.15) p.glow(x, y, 8 + 10 * head, pal.base, 0.4 * (head + shimmer));
    p.dot(x, y, 1.5 + 1.4 * head, head > 0.6 ? WHITE : pal.light, dialClamp(a));
  }
  // The stops: bigger LEDs, lit up to the level.
  for (let i = 0; i < g.stops; i++) {
    const f = stopFraction(g, i);
    arcPoint(g, f, g.radius, scratch);
    const lit = dialClamp((m.level - f) * 12 + 1);
    const just = i === m.stop && m.since < PULSE_S ? 1 - m.since / PULSE_S : 0;
    p.dot(scratch[0]!, scratch[1]!, 6, pal.off, 1 - lit);
    if (lit > 0) {
      p.glow(scratch[0]!, scratch[1]!, 18 + 26 * just * (m.dir > 0 ? 1 : 0), pal.base, (0.5 + 0.5 * just) * lit);
      p.dot(scratch[0]!, scratch[1]!, 6 + 2.5 * just * (m.dir > 0 ? 1 : 0), pal.light, lit);
      p.dot(scratch[0]!, scratch[1]!, 2.4, WHITE, lit * (0.5 + 0.5 * just));
    }
  }
  for (let i = 0; i < ORBITERS; i++) {
    orbiter(g, i, m.t, m.level, scratch);
    if (scratch[3]! <= 0.01 || scratch[2]! >= 0) continue;
    p.dot(scratch[0]!, scratch[1]!, 1.4, pal.base, scratch[3]! * (0.35 + 0.35 * (1 + scratch[2]!)));
  }
}

/** In front of Tappy: the near side of the orbits (with trails) and the change's sparks. */
export function paintDialFront(g: DialGeometry, m: DialMoment, pal: FxPalette, p: FxPainter, scratch: Float32Array): void {
  "worklet";
  const e = energy(m.level);
  for (let i = 0; i < ORBITERS; i++) {
    for (let k = 3; k >= 0; k--) {
      orbiter(g, i, m.t - k * (0.025 + 0.02 * (1 - e)), m.level, scratch);
      const a = scratch[3]!;
      if (a <= 0.01 || scratch[2]! < 0) continue;
      const z = scratch[2]!;
      const r = (1.5 + 1.5 * z) * (1 - k * 0.2);
      if (k === 0) p.glow(scratch[0]!, scratch[1]!, 10, pal.base, 0.35 * a * z);
      p.dot(scratch[0]!, scratch[1]!, r, k === 0 ? pal.light : pal.base, a * (k === 0 ? 1 : 0.5 - k * 0.12));
    }
  }
  if (m.since > PULSE_S) return;
  for (let i = 0; i < SPARKS; i++) {
    changeSpark(g, m, i, scratch);
    const a = scratch[3]!;
    if (a <= 0.01) continue;
    const hot = m.dir > 0 && dialRand(i, 15) < 0.35;
    if (i % 4 === 0) p.glow(scratch[0]!, scratch[1]!, 9, pal.base, 0.5 * a);
    p.dot(scratch[0]!, scratch[1]!, scratch[2]!, hot ? WHITE : m.dir > 0 ? pal.light : pal.base, a);
  }
}

/** Tappy's own kick on a change: a scale for `since` seconds in, direction `dir`. */
export function tappyKick(since: number, dir: number): number {
  "worklet";
  if (since < 0 || since > 0.45) return 1;
  const q = since / 0.45;
  // Up: a quick swell that eases back. Down: a shrink, a sigh.
  const shape = Math.sin(Math.PI * Math.min(1, q * 1.4)) * (1 - q);
  return 1 + (dir > 0 ? 0.12 : -0.07) * shape;
}
