/**
 * Tappy's body: the dots, their springs, moods, touch and whole-body motion.
 *
 * Split out of `engine.ts`, which re-exports the public half; painting a frame
 * lives in `enginePaint.ts`. Same rules as the rest of the engine: pure,
 * Expo-free, and every function a `"worklet"` because `Tappy.tsx` runs it on
 * the UI thread.
 */
export type TappyMood = "idle" | "thinking" | "working" | "talking" | "happy" | "sleepy" | "oops";

export const TAPPY_MOODS: readonly TappyMood[] = ["idle", "thinking", "working", "talking", "happy", "sleepy", "oops"];

/** 0..255 per channel. */
export type RGB = [number, number, number];

export interface TappyPalette {
  /** The brightest lit LED. */
  light: RGB;
  /** A lit LED. */
  base: RGB;
  dark: RGB;
  /** Glow around lit dots and the face. */
  glow: RGB;
  /** The face at small sizes. */
  eye: RGB;
  /** An unlit LED: the body's resting colour. */
  off: RGB;
}

export interface TappyPainter {
  dot(x: number, y: number, r: number, c: RGB, a: number): void;
  /** A soft additive halo of radius `r`. */
  glow(x: number, y: number, r: number, c: RGB, a: number): void;
  /** A filled ellipse, rotated by `rot` radians, with an optional halo `glowR` in `gc`. */
  oval(cx: number, cy: number, rx: number, ry: number, rot: number, c: RGB, a: number, glowR: number, gc: RGB): void;
  /** A round-capped polyline `[x0, y0, x1, y1, …]`, with an optional halo. */
  line(pts: number[], width: number, c: RGB, a: number, glowR: number, gc: RGB): void;
  /** A filled polygon `[x0, y0, …]`. */
  poly(pts: number[], c: RGB, a: number): void;
  /** The soft ground shadow: an ellipse fading out from its centre. */
  shadow(cx: number, cy: number, w: number, h: number, a: number): void;
}

/** Everything one Tappy remembers between frames. Lives on the UI thread. */
export interface TappyBody {
  S: number;
  n: number;
  home: Float32Array;
  p: Float32Array;
  v: Float32Array;
  rnd: Float32Array;
  lat: Float32Array;
  lon: Float32Array;
  /** Per point after projection: sx, sy, z, f (perspective), lambert, nx, ny. */
  scr: Float32Array;
  order: number[];
  yaw: number;
  pitch: number;
  spinV: number;
  yawExtra: number;
  pitchExtra: number;
  pitchV: number;
  dragging: boolean;
  /** Until when a poke keeps it happy (seconds, same clock as `t`). */
  reactUntil: number;
  mood: TappyMood | "";
  since: number;
  /**
   * The mood it was showing before the current one, and the face blends out
   * of it over FACE_BLEND seconds: a poke's smile eases back to the resting
   * face, a working face eases into a happy one, rather than snapping.
   */
  prevMood: TappyMood | "";
  /** Last time it was advanced; also "now" for gestures. */
  last: number;
  lookX: number;
  lookY: number;
  /** Sleeping style 0..9 (`TAPPY_SLEEP_STYLES`): how it dozes in the sleepy mood. */
  sleep: number;
  /** The seed it was built from (-1 for none), so a host can tell when to rebuild. */
  seed: number;
  /** Breathing phase (radians) and rate so two dozing Tappies never move in sync. */
  sleepPh: number;
  sleepRate: number;
}

/** How many sleeping styles there are. */
export const TAPPY_SLEEP_STYLES = 10;

/** A stable 32-bit hash of a string (FNV-1a): seeds a Tappy's sleeping style. */
export function tappySleepSeed(key: string): number {
  "worklet";
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // Final avalanche so ids differing only in their last char spread out.
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  return h >>> 0;
}

/** The sleeping style (0..9) for a key such as a provider id. */
export function tappySleepStyle(key: string): number {
  "worklet";
  return tappySleepSeed(key) % TAPPY_SLEEP_STYLES;
}

// ── constants ───────────────────────────────────────────────

export const TAU = Math.PI * 2;
/** Body radius as a share of the box. */
export const SCALE = 0.29;
const SPRING_K = 90;
const SPRING_C = 11;
const SEED = 1.6;
export const TAPPY_AMBER: RGB = [242, 180, 90];

// ── small maths ─────────────────────────────────────────────

export function clamp(v: number, a: number, b: number): number {
  "worklet";
  return v < a ? a : v > b ? b : v;
}
function lerp(a: number, b: number, t: number): number {
  "worklet";
  return a + (b - a) * t;
}
export function smooth(e0: number, e1: number, x: number): number {
  "worklet";
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}
export function fract(x: number): number {
  "worklet";
  return x - Math.floor(x);
}
export function hash(n: number): number {
  "worklet";
  return fract(Math.sin(n * 127.1 + 311.7) * 43758.5453);
}
// ORDER MATTERS. On the UI thread each worklet captures the helpers it calls
// at the moment it is defined, so a helper declared further down is captured
// as undefined: "fract is not a function", "talkOpen is not a function".
// bun tests run on the JS thread, where order doesn't matter, so the test
// "no worklet calls a helper declared below it" guards this instead.

/** Sleep time: the clock run at this Tappy's own breathing rate and phase. */
export function sleepClock(B: TappyBody, t: number): number {
  "worklet";
  return t * B.sleepRate + B.sleepPh;
}

/** Nodding off (style 5): 0 upright .. 1 head dropped; a slow dip then a jerk back up. */
function nodDip(T: number): number {
  "worklet";
  const p = fract(T / 4.6);
  return p < 0.82 ? smooth(0.1, 0.82, p) : 1 - smooth(0.82, 0.88, p);
}

/** How open the mouth is while talking, 0..1: syllables, not a metronome. */
export function talkOpen(t: number): number {
  "worklet";
  const syllable = 0.5 + 0.5 * Math.sin(t * 13.5);
  const phrase = 0.55 + 0.45 * Math.sin(t * 2.3 + Math.sin(t * 0.7) * 2);
  const pause = fract(t / 3.1) > 0.82 ? 0.15 : 1;
  return clamp(syllable * phrase * pause, 0, 1);
}

function wrapAngle(a: number): number {
  "worklet";
  let r = (a + Math.PI) % TAU;
  if (r < 0) r += TAU;
  return r - Math.PI;
}

// ── the body ────────────────────────────────────────────────

/** How many dots a Tappy of edge `S` is made of. */
export function tappyCount(S: number): number {
  "worklet";
  return S > 140 ? 1000 : S > 50 ? 420 : S > 28 ? 180 : 120;
}

/**
 * Rows of dots, like an LED globe: the tappy icon wrapped round a ball.
 * Alternate rows are offset half a dot so the grid reads as a weave.
 */
export function gridPoints(target: number): Float32Array {
  "worklet";
  const rows = Math.max(7, Math.round(Math.sqrt(target / 1.27)));
  const pts: number[] = [];
  for (let r = 0; r < rows; r++) {
    const lat = -Math.PI / 2 + ((r + 0.5) / rows) * Math.PI;
    const cols = Math.max(4, Math.round(rows * 2 * Math.cos(lat)));
    for (let c = 0; c < cols; c++) {
      const lon = (c / cols) * TAU + (r % 2) * (Math.PI / cols);
      pts.push(Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon));
    }
  }
  return Float32Array.from(pts);
}

/**
 * A new Tappy. It starts as a speck at its centre and bursts out to its full
 * size on the first frames, which is its "coming alive" entrance.
 */
export function makeTappyBody(S: number, seed?: number): TappyBody {
  "worklet";
  const sd = Math.abs(Math.floor(seed ?? 0));
  const sleep = sd % TAPPY_SLEEP_STYLES;
  // Style 0 with no seed keeps the original timing exactly.
  const ph = seed === undefined ? 0 : hash(Math.floor(sd / TAPPY_SLEEP_STYLES) * 0.013 + sleep * 3.7);
  const home = gridPoints(tappyCount(S));
  const n = home.length / 3;
  const rnd = new Float32Array(n);
  const lat = new Float32Array(n);
  const lon = new Float32Array(n);
  const p = new Float32Array(n * 3);
  const order: number[] = [];
  for (let i = 0; i < n; i++) {
    rnd[i] = hash(i * 1.37 + 0.5);
    lat[i] = Math.asin(clamp(home[i * 3 + 1]!, -1, 1));
    lon[i] = Math.atan2(home[i * 3 + 2]!, home[i * 3]!);
    order.push(i);
  }
  for (let i = 0; i < n * 3; i++) p[i] = home[i]! * 0.05;
  return {
    S,
    n,
    home,
    p,
    v: new Float32Array(n * 3),
    rnd,
    lat,
    lon,
    scr: new Float32Array(n * 7),
    order,
    yaw: 0,
    pitch: 0,
    spinV: 0,
    yawExtra: 0,
    pitchExtra: 0,
    pitchV: 0,
    dragging: false,
    reactUntil: -1,
    mood: "",
    since: 0,
    prevMood: "",
    last: 0,
    lookX: 0,
    lookY: 0,
    sleep,
    seed: seed === undefined ? -1 : sd,
    sleepPh: ph * TAU,
    sleepRate: seed === undefined ? 1 : 0.82 + 0.36 * hash(ph * 91.7 + 2.1),
  };
}

export interface MoodState {
  mood: TappyMood;
  age: number;
  decay: number;
}

/** The mood it is actually showing: a poke makes it happy for a moment. */
export function effectiveMood(B: TappyBody, t: number, mood: TappyMood): MoodState {
  "worklet";
  const shown: TappyMood = t < B.reactUntil ? "happy" : mood;
  if (shown !== B.mood) {
    B.prevMood = B.mood;
    B.mood = shown;
    B.since = t;
  }
  const age = Math.max(0, t - B.since);
  return { mood: shown, age, decay: Math.max(0, 1 - age / 0.8) };
}

/** Where point `i` wants to be, for this mood. */
function target(o: Float32Array, i: number, B: TappyBody, t: number, st: MoodState): void {
  "worklet";
  const h = B.home;
  const x = h[i * 3]!;
  const y = h[i * 3 + 1]!;
  const z = h[i * 3 + 2]!;
  const lat = B.lat[i]!;
  const r = B.rnd[i]!;
  let k = 1 + 0.015 * Math.sin(t * 2 + y * 3);
  let sx = 1;
  let sy = 1;
  switch (st.mood) {
    case "thinking":
      k = 1 + 0.045 * Math.sin(lat * 7 - t * 3);
      break;
    case "working":
      k = 1 + 0.07 * Math.sin(lat * 7 - t * 7);
      break;
    case "talking":
      k = 1 + 0.015 * Math.sin(t * 2 + y * 3) + 0.012 * talkOpen(t) * (y < 0 ? 1 : 0.3);
      break;
    case "happy":
      k = 1 + 0.04 * Math.sin(t * 8) + 0.03 * Math.sin(lat * 5 + t * 10);
      break;
    case "sleepy":
      k = 1 + 0.02 * Math.sin(sleepClock(B, t) * (B.sleep === 6 ? 0.6 : 1.1));
      sy = B.sleep === 6 ? 0.8 : 0.88;
      sx = B.sleep === 6 ? 1.1 : 1.06;
      break;
    case "oops":
      k = 1 + 0.2 * st.decay * st.decay * (r - 0.3) + 0.012 * Math.sin(t * 40 + r * 30);
      break;
    default:
      break;
  }
  o[0] = x * k * sx;
  o[1] = y * k * sy;
  o[2] = z * k * sx;
}

const TMP = new Float32Array(3);

function step(B: TappyBody, t: number, dt: number, st: MoodState): void {
  "worklet";
  const p = B.p;
  const v = B.v;
  const o = TMP;
  for (let i = 0; i < B.n; i++) {
    target(o, i, B, t, st);
    const kk = SPRING_K * (0.75 + 0.5 * B.rnd[i]!);
    for (let a = 0; a < 3; a++) {
      const j = i * 3 + a;
      v[j] = v[j]! + ((o[a]! - p[j]!) * kk - v[j]! * SPRING_C) * dt;
      p[j] = p[j]! + v[j]! * dt;
    }
  }
}

/**
 * Idle life: every so often it glances to one side, and now and then it hops.
 * Deterministic in `t` so it needs no state.
 */
function idleGlance(t: number): number {
  "worklet";
  const period = 9.7;
  const ph = fract(t / period);
  if (ph > 0.14) return 0;
  const side = hash(Math.floor(t / period)) > 0.5 ? 1 : -1;
  return side * 0.75 * Math.sin((ph / 0.14) * Math.PI);
}
function idleHop(t: number): number {
  "worklet";
  const ph = fract(t / 13.3 + 0.4);
  return ph < 0.09 ? Math.sin((ph / 0.09) * Math.PI) : 0;
}

function turn(B: TappyBody, t: number, dt: number, st: MoodState): void {
  "worklet";
  let yawT = 0;
  let pitchT: number;
  let spin = 0;
  switch (st.mood) {
    case "thinking":
      yawT = Math.sin(t * 0.9) * 0.85;
      pitchT = 0.25 + Math.sin(t * 1.3) * 0.08;
      break;
    case "working":
      spin = 2.3;
      pitchT = Math.sin(t * 1.7) * 0.12;
      break;
    case "sleepy": {
      const sl = B.sleep;
      yawT = sl === 3 ? -0.3 : sl === 4 ? 0.4 : sl === 1 ? 0.04 : 0.12;
      pitchT = sl === 5 ? -0.2 - 0.45 * nodDip(sleepClock(B, t)) : sl === 6 ? -0.42 : -0.3;
      break;
    }
    default:
      yawT = B.lookX * 0.6 + Math.sin(t * 0.7) * 0.15 + (st.mood === "idle" ? idleGlance(t) : 0);
      pitchT = B.lookY * 0.38 + Math.sin(t * 0.9) * 0.05;
  }
  if (st.mood === "happy") yawT += Math.sin(t * 10) * 0.1;
  if (spin) B.yaw += spin * dt;
  else B.yaw += wrapAngle(yawT - B.yaw) * (1 - Math.exp(-dt * 5));
  B.pitch += (pitchT - B.pitch) * (1 - Math.exp(-dt * 5));
  if (!B.dragging) {
    B.yawExtra += B.spinV * dt;
    B.spinV *= Math.exp(-dt * 1.4);
    if (Math.abs(B.spinV) < 0.6) {
      const home = Math.round(B.yawExtra / TAU) * TAU;
      B.yawExtra += (home - B.yawExtra) * (1 - Math.exp(-dt * 3));
    }
    B.pitchV += (-B.pitchExtra * 40 - B.pitchV * 9) * dt;
    B.pitchExtra += B.pitchV * dt;
  }
}

/**
 * One frame of life. `look` is where something interesting is, -1..1 on each
 * axis (a finger, the composer); without one it drifts and glances by itself.
 */
export function advanceTappy(B: TappyBody, t: number, dt: number, mood: TappyMood, lookX?: number, lookY?: number): void {
  "worklet";
  const step_ = clamp(dt, 0.001, 1 / 30);
  B.last = t;
  const st = effectiveMood(B, t, mood);
  const tx = lookX ?? Math.sin(t * 0.5) * 0.3;
  const ty = lookY ?? Math.sin(t * 0.37) * 0.2;
  const ease = 1 - Math.exp(-step_ * 5);
  B.lookX += (clamp(tx, -1, 1) - B.lookX) * ease;
  B.lookY += (clamp(ty, -1, 1) - B.lookY) * ease;
  turn(B, t, step_, st);
  step(B, t, step_, st);
}

/** Jump straight to the resting pose for `mood` (reduced motion, paused). */
export function settleTappy(B: TappyBody, t: number, mood: TappyMood, lookX = 0, lookY = 0): void {
  "worklet";
  B.last = t;
  const st = effectiveMood(B, t, mood);
  B.lookX = lookX;
  B.lookY = lookY;
  const o = TMP;
  for (let i = 0; i < B.n; i++) {
    target(o, i, B, t, st);
    for (let a = 0; a < 3; a++) {
      B.p[i * 3 + a] = o[a]!;
      B.v[i * 3 + a] = 0;
    }
  }
  B.yaw = mood === "sleepy" ? (B.sleep === 3 ? -0.3 : B.sleep === 4 ? 0.4 : B.sleep === 1 ? 0.04 : 0.12) : lookX * 0.6;
  B.pitch = mood === "sleepy" ? (B.sleep === 5 ? -0.45 : B.sleep === 6 ? -0.42 : -0.3) : mood === "thinking" ? 0.25 : lookY * 0.38;
}

// ── touch ───────────────────────────────────────────────────

/** A tap at (x, y) in the box: a ripple out from the finger, and a happy moment. */
export function pokeTappy(B: TappyBody, x: number, y: number): void {
  "worklet";
  const R = B.S * SCALE;
  const reach = R * 0.6;
  const s = B.scr;
  const p = B.p;
  const v = B.v;
  for (let i = 0; i < B.n; i++) {
    const d = Math.hypot(s[i * 7]! - x, s[i * 7 + 1]! - y);
    if (d > reach || s[i * 7 + 2]! < -0.3) continue;
    const fall = 1 - d / reach;
    const len = Math.hypot(p[i * 3]!, p[i * 3 + 1]!, p[i * 3 + 2]!) || 1;
    const push = 3.4 * fall * fall;
    v[i * 3] = v[i * 3]! - (p[i * 3]! / len) * push;
    v[i * 3 + 1] = v[i * 3 + 1]! - (p[i * 3 + 1]! / len) * push;
    v[i * 3 + 2] = v[i * 3 + 2]! - (p[i * 3 + 2]! / len) * push;
  }
  B.reactUntil = B.last + 1.3;
}

/** A drag of (dx, dy) points taking `dt` seconds: spins it, with momentum. */
export function dragTappy(B: TappyBody, dx: number, dy: number, dt: number): void {
  "worklet";
  B.dragging = true;
  B.yawExtra += dx * 0.013;
  B.pitchExtra = clamp(B.pitchExtra + dy * 0.009, -0.9, 0.9);
  B.spinV = lerp(B.spinV, (dx * 0.013) / Math.max(0.008, dt), 0.5);
}

/** The finger lifted: it keeps spinning and springs back upright. */
export function releaseTappy(B: TappyBody): void {
  "worklet";
  B.dragging = false;
}

// ── motion, light and projection ────────────────────────────

export interface Motion {
  hop: number;
  sx: number;
  sy: number;
  rot: number;
  dx: number;
}

export function motion(mood: TappyMood, t: number, age: number, S: number, B: TappyBody): Motion {
  "worklet";
  let hop = 0;
  let sx = 1;
  let sy = 1;
  let rot = 0;
  let dx = 0;
  switch (mood) {
    case "idle": {
      const b = Math.sin(t * 2.1) * 0.02;
      sy = 1 + b;
      sx = 1 - b * 0.6;
      rot = Math.sin(t * 1.1) * 0.025;
      const h = idleHop(t);
      hop = h * S * 0.045;
      if (h > 0) {
        const squash = Math.pow(1 - h, 4) * 0.08;
        sy -= squash;
        sx += squash * 0.8;
      }
      break;
    }
    case "talking": {
      const b = Math.sin(t * 2.1) * 0.015 + talkOpen(t) * 0.012;
      sy = 1 + b;
      sx = 1 - b * 0.6;
      rot = Math.sin(t * 1.4) * 0.03;
      break;
    }
    case "thinking": {
      rot = -0.08 + Math.sin(t * 1.4) * 0.035;
      const b = Math.sin(t * 1.6) * 0.018;
      sy = 1 + b;
      sx = 1 - b * 0.6;
      break;
    }
    case "working": {
      const h = Math.abs(Math.sin(t * 6.4));
      hop = h * S * 0.05;
      const k = Math.pow(1 - h, 6) * 0.13;
      sy = 1 - k + 0.03 * h;
      sx = 1 + k * 0.8 - 0.015 * h;
      rot = Math.sin(t * 3.2) * 0.03;
      break;
    }
    case "happy": {
      const h = Math.abs(Math.sin(t * 5));
      hop = h * S * 0.05;
      const k = Math.pow(1 - h, 6) * 0.12;
      sy = 1 - k;
      sx = 1 + k * 0.8;
      rot = Math.sin(t * 10) * 0.06;
      break;
    }
    case "sleepy": {
      const T = sleepClock(B, t);
      const sl = B.sleep;
      const b = Math.sin(T * (sl === 6 ? 0.6 : sl === 2 ? 0.9 : 1.1)) * (sl === 2 ? 0.04 : 0.03);
      sy = 1 + b;
      sx = 1 - b * 0.5;
      switch (sl) {
        case 1:
          rot = 0.04;
          break;
        case 3:
          rot = -0.24 + Math.sin(T * 0.5) * 0.015;
          dx = -S * 0.025;
          break;
        case 4:
          rot = 0.24 + Math.sin(T * 0.5) * 0.015;
          dx = S * 0.025;
          break;
        case 5: {
          const d = nodDip(T);
          hop = -d * S * 0.04;
          rot = 0.05 + d * 0.05;
          break;
        }
        case 6:
          sy = 0.9 + b * 0.6;
          sx = 1.08 - b * 0.3;
          rot = 0;
          break;
        case 7:
          rot = 0.05 + Math.sin(T * 0.5) * 0.03;
          break;
        case 9:
          hop = Math.abs(Math.sin(T * 1.6)) * S * 0.015;
          dx = Math.sin(T * 0.8) * S * 0.03;
          rot = Math.sin(T * 0.8) * 0.07;
          break;
        default:
          rot = 0.08;
      }
      break;
    }
    case "oops": {
      const s = age < 0.7 ? 1 - age / 0.7 : 0;
      dx = Math.sin(t * 45) * S * 0.02 * s;
      rot = Math.sin(t * 45) * 0.04 * s;
      break;
    }
  }
  return { hop, sx, sy, rot, dx };
}

/** Eye openness 0..1: a blink every few seconds, sometimes a double. */
export function blink(t: number, seedIn?: number): number {
  "worklet";
  // Not a default parameter: the worklet compiler does not capture module
  // constants that appear only in a parameter default.
  const seed = seedIn ?? SEED;
  const period = 3.4 + seed * 1.7;
  const p = (t + seed * 7.3) % period;
  if (p < 0.15) return 1 - Math.sin((p / 0.15) * Math.PI);
  const q = (t + seed * 7.3 + 0.32) % (period * 3);
  if (q < 0.15) return 1 - Math.sin((q / 0.15) * Math.PI);
  return 1;
}
