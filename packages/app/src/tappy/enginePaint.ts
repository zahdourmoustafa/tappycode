/**
 * Painting one frame of Tappy: projection, the LED face, the drawn face for
 * small sizes, and the extras around the head.
 *
 * Split out of `engine.ts`, which re-exports `ledFace` and `paintTappy`. Reads
 * the pose that `engineBody.ts` simulated; never moves a dot itself.
 *
 * Imports are safe for worklets in a way a helper further down this file is
 * not: `engineBody.ts` has finished evaluating before anything here is
 * defined, so every imported helper is captured as itself.
 */
import {
  TAPPY_AMBER,
  SCALE,
  TAU,
  blink,
  clamp,
  effectiveMood,
  fract,
  hash,
  motion,
  sleepClock,
  smooth,
  talkOpen,
  type Motion,
  type MoodState,
  type TappyBody,
  type TappyMood,
  type TappyPainter,
  type TappyPalette,
  type RGB,
} from "./engineBody";

/** Perspective distance, in body radii. */
const D = 4.5;
/** Upper-left key light. */
const LIGHT: RGB = [-0.4703, 0.6271, 0.6898];
const AMBER_INK: RGB = [35, 23, 3];
const WHITE: RGB = [255, 255, 255];
/** Below this many dots the face is drawn as shapes (an LED face would be a smudge). */
const LED_FACE_MIN = 300;
/** Extras (thought bubbles, z's, sparkles) need room to read. */
const EXTRAS_MIN = 56;
/** How far a small Tappy's unlit dots glow toward its colour (0 off, 1 lit). */
const SMALL_GLOW = 0.6;
const SMALL_GLOW_SLEEPY = 0.42;

function mixInto(out: RGB, a: RGB, b: RGB, t: number): RGB {
  "worklet";
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
  return out;
}

interface View {
  S: number;
  R: number;
  cx: number;
  cy: number;
  m: Motion;
  cyw: number;
  syw: number;
  cp: number;
  sp: number;
  cr: number;
  sr: number;
  facing: number;
}

interface Projected {
  sx: number;
  sy: number;
  z: number;
  f: number;
  x1: number;
  y2: number;
}

function proj3(x: number, y: number, z: number, V: View, out: Projected): Projected {
  "worklet";
  const x1 = x * V.cyw + z * V.syw;
  const z1 = -x * V.syw + z * V.cyw;
  const y2 = y * V.cp - z1 * V.sp;
  const z2 = y * V.sp + z1 * V.cp;
  const f = D / (D - z2);
  const lx = x1 * V.R * f * V.m.sx;
  const ly = -y2 * V.R * f * V.m.sy;
  out.sx = V.cx + lx * V.cr - ly * V.sr;
  out.sy = V.cy + lx * V.sr + ly * V.cr;
  out.z = z2;
  out.f = f;
  out.x1 = x1;
  out.y2 = y2;
  return out;
}

function projectAll(B: TappyBody, V: View): void {
  "worklet";
  const p = B.p;
  const s = B.scr;
  const P: Projected = { sx: 0, sy: 0, z: 0, f: 1, x1: 0, y2: 0 };
  for (let i = 0; i < B.n; i++) {
    proj3(p[i * 3]!, p[i * 3 + 1]!, p[i * 3 + 2]!, V, P);
    const len = Math.hypot(P.x1, P.y2, P.z) || 1;
    const nx = P.x1 / len;
    const ny = P.y2 / len;
    const nz = P.z / len;
    const o = i * 7;
    s[o] = P.sx;
    s[o + 1] = P.sy;
    s[o + 2] = P.z;
    s[o + 3] = P.f;
    s[o + 4] = Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]);
    s[o + 5] = nx;
    s[o + 6] = ny;
  }
  B.order.sort((a, b) => s[a * 7 + 2]! - s[b * 7 + 2]!);
}

// ── the LED face ────────────────────────────────────────────

/** REM flicker for the dreaming style: darting bursts with still gaps. */
function rem(T: number): number {
  "worklet";
  return fract(T / 3.1) < 0.45 ? Math.sin(T * 23) : 0;
}

/** Snore size 0..1 for the open-mouth styles. */
function snore(T: number): number {
  "worklet";
  return 0.5 + 0.5 * Math.sin(T * 0.9);
}

/** The LED face of a sleeping Tappy in style `sl`; `T` is its sleep clock. */
function sleepFace(u: number, w: number, T: number, sl: number): number {
  "worklet";
  const ey = 0.17;
  for (let side = -1; side <= 1; side += 2) {
    const ex = side * 0.32;
    if (sl === 1 && side === 1) {
      const du = (u - ex) / 0.13;
      const dw = (w - (ey - 0.03)) / 0.08;
      if (du * du + dw * dw < 1) return 1;
    } else if (sl === 2) {
      const d = Math.hypot(u - ex, w - (ey + 0.06));
      if (Math.abs(d - 0.14) < 0.05 && w < ey + 0.01) return 1;
    } else {
      const shift = sl === 7 ? rem(T) * 0.05 : 0;
      const y = sl === 6 ? ey - 0.08 : ey - 0.03;
      if (Math.abs(w - y) < 0.06 && Math.abs(u - ex - shift) < 0.15) return 1;
    }
  }
  const my = -0.22;
  switch (sl) {
    case 2: {
      const r = 0.06 + 0.06 * snore(T);
      return Math.abs(Math.hypot(u, w - my) - r) < 0.05 ? 1 : 0;
    }
    case 6:
      return Math.abs(w - my) < 0.05 && Math.abs(u) < 0.09 ? 1 : 0;
    case 7: {
      const d = Math.hypot(u, w - (my + 0.08));
      return Math.abs(d - 0.11) < 0.05 && w < my + 0.02 && Math.abs(u) < 0.11 ? 1 : 0;
    }
    case 9: {
      if (Math.hypot(u, w - my) < 0.07 + 0.03 * snore(T)) return 1;
      const len = 0.06 + 0.1 * fract(T / 5);
      return Math.abs(u - 0.09) < 0.04 && w < my - 0.04 && w > my - 0.04 - len ? 1 : 0;
    }
    default:
      return Math.hypot(u, w - my) < 0.07 ? 1 : 0;
  }
}

/** Is the LED at face coordinates (u, w) part of the face for this mood? 0..1 */
export function ledFace(u: number, w: number, mood: TappyMood, open: number, t: number, sleepIn?: number): number {
  "worklet";
  if (mood === "sleepy") return sleepFace(u, w, t, sleepIn ?? 0);
  for (let side = -1; side <= 1; side += 2) {
    const ex = side * 0.32;
    const ey = 0.17;
    if (mood === "happy") {
      const d = Math.hypot(u - ex, w - (ey - 0.05));
      if (Math.abs(d - 0.13) < 0.065 && w > ey - 0.06) return 1;
    } else {
      const big = mood === "oops" ? 1.25 : 1;
      const rh = (mood === "working" ? 0.1 : 0.21) * Math.max(0.12, open) * big;
      const du = (u - ex) / (0.14 * big);
      const dw = (w - ey) / rh;
      if (du * du + dw * dw < 1) return 1;
    }
  }
  const my = -0.22;
  switch (mood) {
    case "happy": {
      const d = Math.hypot(u, w - (my + 0.1));
      return Math.abs(d - 0.2) < 0.065 && w < my + 0.08 ? 1 : 0;
    }
    case "idle": {
      const d = Math.hypot(u, w - (my + 0.09));
      return Math.abs(d - 0.15) < 0.06 && w < my + 0.03 && Math.abs(u) < 0.15 ? 1 : 0;
    }
    case "talking": {
      const o = talkOpen(t);
      const rw = 0.11;
      const rh = 0.035 + 0.08 * o;
      const du = u / rw;
      const dw = (w - (my + 0.01)) / rh;
      return du * du + dw * dw < 1 ? 1 : 0;
    }
    case "oops": {
      const d = Math.hypot(u, w - my);
      return Math.abs(d - 0.08) < 0.05 ? 1 : 0;
    }
    case "working":
      return Math.abs(w - my) < 0.055 && Math.abs(u) < 0.12 ? 1 : 0;
    case "thinking":
      return Math.abs(w - (my + u * 0.25)) < 0.055 && u > -0.05 && u < 0.16 ? 1 : 0;
  }
  return 0;
}

const C1: RGB = [0, 0, 0];
/** Seconds a face takes to dissolve into the next mood's. */
const FACE_BLEND = 0.35;

function paintLeds(B: TappyBody, V: View, pal: TappyPalette, st: MoodState, t: number, open: number, P: TappyPainter): void {
  "worklet";
  const R = V.R;
  const base = R * Math.sqrt((4 * Math.PI) / B.n) * 0.36;
  const s = B.scr;
  const p = B.p;
  const mood = st.mood;
  let gu = clamp(B.lookX, -1, 1) * 0.08;
  let gw = -clamp(B.lookY, -1, 1) * 0.06;
  if (mood === "thinking") {
    gu = 0.1;
    gw = 0.08;
  }
  const lit = mood === "oops" ? TAPPY_AMBER : pal.base;
  const ledFaceOn = B.n >= LED_FACE_MIN;
  const T = mood === "sleepy" ? sleepClock(B, t) : t;
  // How much of the previous face is still showing: 1 at the change, eased to
  // 0 over FACE_BLEND seconds.
  const prev: TappyMood = B.prevMood === "" ? mood : B.prevMood;
  const blendOld = prev !== mood ? 1 - smooth(0, FACE_BLEND, st.age) : 0;
  for (let oi = 0; oi < B.order.length; oi++) {
    const i = B.order[oi]!;
    const o = i * 7;
    const z = s[o + 2]!;
    const f = s[o + 3]!;
    const lam = s[o + 4]!;
    const front = (clamp(z, -1, 1) + 1) / 2;
    const px = p[i * 3]!;
    const py = p[i * 3 + 1]!;
    const pz = p[i * 3 + 2]!;
    const len = Math.hypot(px, py, pz) || 1;
    const u = px / len;
    const w = py / len;
    const facing = pz / len;
    const lat = B.lat[i]!;
    const lon = B.lon[i]!;
    const r = B.rnd[i]!;
    let on = 0;
    if (ledFaceOn && facing > 0.2) {
      on = ledFace(u - gu, w - gw, mood, open, T, B.sleep);
      // Mid-change, the old face fades out as the new one fades in, so the
      // lit dots cross-dissolve instead of the face snapping.
      if (blendOld > 0) {
        const old = ledFace(u - gu, w - gw, prev, open, prev === "sleepy" ? sleepClock(B, t) : t, B.sleep);
        on = on * (1 - blendOld) + old * blendOld;
      }
    }
    switch (mood) {
      case "idle":
        if (fract(t * 0.35 + r * 7.3) < 0.035) on = Math.max(on, 0.5);
        break;
      case "talking":
        if (fract(t * 0.6 + r * 5.1) < 0.025) on = Math.max(on, 0.45);
        break;
      case "thinking":
        on = Math.max(on, smooth(0.88, 1, fract((lon / TAU) * 2 + lat / Math.PI - t * 0.45)) * 0.75);
        break;
      case "working": {
        const scan = Math.sin(t * 2.8) * 0.95;
        const sl = Math.sin(lat) - scan;
        on = Math.max(on, Math.exp(-(sl * sl) / 0.012) * 0.9, fract((lon / TAU) * 6 + t * 1.2) < 0.07 ? 0.4 : 0);
        break;
      }
      case "happy": {
        const d = Math.acos(clamp(facing, -1, 1));
        on = Math.max(on, fract(d * 0.8 - t * 1.3) < 0.1 ? 0.8 : 0);
        break;
      }
      case "sleepy":
        on *= 0.55 + 0.2 * Math.sin(T * 1.2);
        break;
      case "oops":
        if (hash(i * 3.1 + Math.floor(t * 14)) > 0.86) on = Math.max(on, 0.8 * st.decay + 0.15);
        break;
    }
    // A small Tappy has no LED face to light, so the Matrix look (a dark globe
    // with a lit face) would read as a dark ball: its body glows faintly in its
    // colour instead, which is what tells one agent's chip from another's.
    if (!ledFaceOn) on = Math.max(on, mood === "sleepy" ? SMALL_GLOW_SLEEPY : SMALL_GLOW);
    if (front < 0.5) {
      mixInto(C1, pal.off, lit, on * 0.6);
      P.dot(s[o]!, s[o + 1]!, base * f * 0.55, C1, 0.22);
      continue;
    }
    mixInto(C1, pal.off, on > 0.85 ? pal.light : lit, on);
    const k = 0.72 + 0.28 * lam;
    C1[0] *= k;
    C1[1] *= k;
    C1[2] *= k;
    P.dot(s[o]!, s[o + 1]!, base * f * (0.62 + 0.38 * front), C1, 0.35 + 0.65 * front);
    if (on > 0.45) P.glow(s[o]!, s[o + 1]!, base * f * 2.6, lit, on * 0.55 * front);
  }
}

// ── the drawn face (small sizes) ────────────────────────────

/** Points along an ellipse arc, as a polyline. */
function arc(cx: number, cy: number, rx: number, ry: number, rot: number, a0: number, a1: number, n: number): number[] {
  "worklet";
  const out: number[] = [];
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    const x = Math.cos(a) * rx;
    const y = Math.sin(a) * ry;
    out.push(cx + x * c - y * s, cy + x * s + y * c);
  }
  return out;
}

function faceProj(u: number, w: number, V: View, out: Projected): Projected {
  "worklet";
  const zc = Math.sqrt(Math.max(0, 1 - u * u - w * w)) * 1.03;
  return proj3(u, w, zc, V, out);
}

function drawFace(B: TappyBody, V: View, pal: TappyPalette, st: MoodState, t: number, open: number, P: TappyPainter, fade = 1): void {
  "worklet";
  const mood = st.mood;
  const oops = mood === "oops";
  // `fade` < 1 while this face is dissolving out (or in) across a mood change.
  const vis = smooth(0.02, 0.32, V.facing) * fade;
  if (vis <= 0) return;
  let gu = clamp(B.lookX, -1, 1) * 0.07;
  let gw = -clamp(B.lookY, -1, 1) * 0.05;
  if (mood === "thinking") {
    gu = 0.09;
    gw = 0.08;
  } else if (mood === "sleepy") {
    gu = 0;
    gw = -0.02;
  }
  const R = V.R;
  const fx = Math.max(0.3, V.facing);
  const col = oops ? TAPPY_AMBER : pal.eye;
  const gc = oops ? TAPPY_AMBER : pal.glow;
  const halo = R * 0.2;
  const rot = V.m.rot;
  const E: Projected = { sx: 0, sy: 0, z: 0, f: 1, x1: 0, y2: 0 };
  const T = sleepClock(B, t);
  for (let side = -1; side <= 1; side += 2) {
    faceProj(side * 0.3 + gu, 0.16 + gw, V, E);
    const k = E.f;
    if (mood === "happy") {
      P.line(arc(E.sx, E.sy + R * 0.06 * k, R * 0.12 * fx * k, R * 0.12 * k, rot, Math.PI * 1.1, Math.PI * 1.9, 8), R * 0.08 * k, col, vis, halo, gc);
    } else if (mood === "sleepy") {
      const sl = B.sleep;
      if (sl === 1 && side === 1) {
        P.oval(E.sx, E.sy, R * 0.08 * fx * k, R * 0.05 * k, rot, col, vis, halo, gc);
      } else if (sl === 2) {
        P.line(arc(E.sx, E.sy - R * 0.04 * k, R * 0.11 * fx * k, R * 0.09 * k, rot, Math.PI * 0.15, Math.PI * 0.85, 6), R * 0.06 * k, col, vis, halo, gc);
      } else {
        const sh = sl === 7 ? rem(T) * R * 0.04 * k : 0;
        const y = E.sy + (sl === 6 ? R * 0.06 * k : 0);
        const hw = R * (sl === 6 ? 0.12 : 0.1) * fx * k;
        P.line([E.sx - hw + sh, y, E.sx + hw + sh, y], R * (sl === 6 ? 0.045 : 0.06) * k, col, vis, halo, gc);
      }
    } else {
      const big = oops ? 1.25 : 1;
      const hh = mood === "working" ? 0.075 : 0.13;
      P.oval(E.sx, E.sy, R * 0.09 * big * fx * k, R * hh * big * Math.max(0.1, open) * k, rot, col, vis, halo, gc);
    }
  }
  faceProj(gu * 0.6, -0.2 + gw * 0.5, V, E);
  const k = E.f;
  const lw = R * 0.06 * k;
  switch (mood) {
    case "happy":
      P.line(arc(E.sx, E.sy - R * 0.08 * k, R * 0.16 * fx * k, R * 0.16 * k, rot, Math.PI * 0.2, Math.PI * 0.8, 10), lw, col, vis, halo, gc);
      break;
    case "oops":
      P.line(arc(E.sx, E.sy, R * 0.05 * fx * k, R * 0.055 * k, 0, 0, TAU, 12), lw, col, vis, halo, gc);
      break;
    case "idle":
      P.line(arc(E.sx, E.sy - R * 0.06 * k, R * 0.09 * fx * k, R * 0.09 * k, rot, Math.PI * 0.25, Math.PI * 0.75, 8), lw, col, vis, halo, gc);
      break;
    case "talking": {
      const o = talkOpen(t);
      P.oval(E.sx, E.sy, R * 0.06 * fx * k, R * (0.015 + 0.05 * o) * k, rot, col, vis, halo, gc);
      break;
    }
    case "working":
      P.line([E.sx - R * 0.06 * fx * k, E.sy, E.sx + R * 0.06 * fx * k, E.sy], lw, col, vis, halo, gc);
      break;
    case "thinking":
      P.line([E.sx - R * 0.02 * fx * k, E.sy + R * 0.01 * k, E.sx + R * 0.08 * fx * k, E.sy - R * 0.025 * k], lw, col, vis, halo, gc);
      break;
    case "sleepy":
      switch (B.sleep) {
        case 2: {
          const o = 0.04 + 0.04 * snore(T);
          P.line(arc(E.sx, E.sy, o * R * fx * k, o * 1.15 * R * k, 0, 0, TAU, 10), lw * 0.8, col, vis, halo, gc);
          break;
        }
        case 6:
          P.line([E.sx - R * 0.05 * fx * k, E.sy, E.sx + R * 0.05 * fx * k, E.sy], lw * 0.8, col, vis, halo, gc);
          break;
        case 7:
          P.line(arc(E.sx, E.sy - R * 0.05 * k, R * 0.07 * fx * k, R * 0.07 * k, rot, Math.PI * 0.25, Math.PI * 0.75, 6), lw * 0.8, col, vis, halo, gc);
          break;
        case 9: {
          P.oval(E.sx, E.sy, R * (0.04 + 0.015 * snore(T)) * k, R * (0.05 + 0.02 * snore(T)) * k, 0, col, vis, halo, gc);
          const len = R * (0.05 + 0.12 * fract(T / 5)) * k;
          const x = E.sx + R * 0.06 * fx * k;
          P.line([x, E.sy + R * 0.03 * k, x, E.sy + R * 0.03 * k + len], lw * 0.6, col, vis * 0.8, 0, gc);
          break;
        }
        default:
          P.oval(E.sx, E.sy, R * 0.035 * k, R * 0.045 * k, 0, col, vis, halo, gc);
      }
      break;
  }
}

// ── extras around the head ─────────────────────────────────

function star(x: number, y: number, r: number): number[] {
  "worklet";
  const pts: number[] = [];
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    const d = i % 2 ? r * 0.3 : r;
    pts.push(x + Math.cos(a) * d, y + Math.sin(a) * d);
  }
  return pts;
}

function extras(B: TappyBody, V: View, pal: TappyPalette, st: MoodState, t: number, ground: number, P: TappyPainter): void {
  "worklet";
  const R = V.R;
  const ax = V.cx;
  const ay = V.cy - R * 0.95 * V.m.sy;
  // Z bubbles (style 8) read at every size: they are the style.
  if (st.mood === "sleepy" && B.sleep === 8) {
    const T = sleepClock(B, t);
    for (let i = 0; i < 3; i++) {
      const p = fract(T * 0.3 + i / 3);
      const r = R * (0.14 + p * 0.16);
      const x = ax + R * 0.55 + p * R * 0.4 + Math.sin(p * 7 + i) * R * 0.08;
      const y = ay - R * 0.05 - p * R * 1.0;
      const a = (1 - p) * smooth(0, 0.15, p);
      P.line(arc(x, y, r, r, 0, 0, TAU, 12), r * 0.14, pal.glow, a * 0.55, 0, pal.glow);
      const z = r * 0.45;
      P.line([x - z, y - z, x + z, y - z, x - z, y + z, x + z, y + z], r * 0.16, pal.glow, a * 0.9, 0, pal.glow);
    }
    return;
  }
  if (V.S < EXTRAS_MIN) return;
  switch (st.mood) {
    case "thinking":
      for (let i = 0; i < 3; i++) {
        const ph = t * 3 - i * 0.6;
        P.dot(ax + R * (0.65 + i * 0.25), ay - R * (0.2 + i * 0.3) + Math.sin(ph) * R * 0.05, R * (0.055 + i * 0.035), pal.glow, 0.35 + 0.3 * (0.5 + 0.5 * Math.sin(ph)));
      }
      break;
    case "sleepy":
      // Only the snoring styles trail the classic z's; the rest doze quietly.
      if (B.sleep !== 0 && B.sleep !== 2 && B.sleep !== 9) break;
      for (let i = 0; i < 3; i++) {
        const p = (sleepClock(B, t) * 0.42 + i / 3) % 1;
        const zs = R * (0.2 + p * 0.26) * 0.7;
        const x = ax + R * 0.5 + p * R * 0.55 + Math.sin(p * 6) * R * 0.07;
        const y = ay - p * R * 1.1;
        P.line([x, y - zs, x + zs * 0.75, y - zs, x, y, x + zs * 0.75, y], zs * 0.16, pal.glow, (1 - p) * 0.85 * smooth(0, 0.12, p), 0, pal.glow);
      }
      break;
    case "happy":
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * TAU + t * 0.5;
        const p = (t * 1.1 + i * 0.37) % 1;
        const d = R * (1.2 + p * 0.4);
        const r = R * 0.11 * Math.sin(p * Math.PI);
        if (r > 0.2) P.poly(star(ax + Math.cos(a) * d, ay + R * 0.95 + Math.sin(a) * d * 0.8, r), i % 2 ? pal.glow : WHITE, 1);
      }
      break;
    case "working":
      for (let i = 0; i < 4; i++) {
        const p = (t * 1.6 + i / 4) % 1;
        const side = i % 2 ? 1 : -1;
        P.dot(ax + side * (R * 0.9 + p * R * 0.7), ground - R * 0.08 - p * R * 0.35, R * 0.07 * (1 - p * 0.4), pal.glow, (1 - p) * 0.4);
      }
      break;
    case "oops": {
      const sc = clamp(st.age * 6, 0, 1) * (1 + 0.15 * Math.max(0, 1 - st.age * 3));
      if (sc <= 0) break;
      const x = ax + R * 0.85;
      const y = ay - R * 0.1 + Math.sin(t * 3) * R * 0.04;
      P.dot(x, y, R * 0.22 * sc, TAPPY_AMBER, 1);
      P.line([x, y - R * 0.11 * sc, x, y + R * 0.02 * sc], R * 0.06 * sc, AMBER_INK, 1, 0, AMBER_INK);
      P.dot(x, y + R * 0.095 * sc, R * 0.035 * sc, AMBER_INK, 1);
      break;
    }
    case "idle":
    case "talking":
      break;
  }
}

// ── a frame ─────────────────────────────────────────────────

/**
 * Paint the current pose. `advanceTappy` (or `settleTappy`) must have run for
 * this `t` first; painting never changes the body except its draw order.
 */
export function paintTappy(B: TappyBody, t: number, mood: TappyMood, pal: TappyPalette, P: TappyPainter): void {
  "worklet";
  const S = B.S;
  const st = effectiveMood(B, t, mood);
  // The body's motion blends across a mood change too (hop, squash, tilt,
  // sway), so a smile's bounce eases back into the idle sway.
  let m = motion(st.mood, t, st.age, S, B);
  const prevMood = B.prevMood;
  if (prevMood !== "" && prevMood !== st.mood && st.age < FACE_BLEND) {
    const old = motion(prevMood, t, st.age, S, B);
    const k = smooth(0, FACE_BLEND, st.age);
    m = {
      hop: old.hop + (m.hop - old.hop) * k,
      sx: old.sx + (m.sx - old.sx) * k,
      sy: old.sy + (m.sy - old.sy) * k,
      rot: old.rot + (m.rot - old.rot) * k,
      dx: old.dx + (m.dx - old.dx) * k,
    };
  }
  const R = S * SCALE;
  const ground = S * 0.86;
  const yaw = B.yaw + B.yawExtra;
  const pitch = B.pitch + B.pitchExtra;
  const V: View = {
    S,
    R,
    cx: S / 2 + m.dx,
    cy: ground - m.hop - R * 1.08 * m.sy,
    m,
    cyw: Math.cos(yaw),
    syw: Math.sin(yaw),
    cp: Math.cos(pitch),
    sp: Math.sin(pitch),
    cr: Math.cos(m.rot),
    sr: Math.sin(m.rot),
    facing: Math.cos(yaw) * Math.cos(pitch),
  };
  const open = blink(t);
  const air = clamp(m.hop / (S * 0.06), 0, 1);
  P.shadow(S / 2, ground, R * (1 - 0.25 * air), R * 0.18, 0.5 * (1 - 0.4 * air));
  projectAll(B, V);
  paintLeds(B, V, pal, st, t, open, P);
  if (B.n < LED_FACE_MIN) {
    // Small Tappies draw the face as shapes: mid-change, the old face fades out
    // under the new one fading in, the same cross-dissolve as the LED face.
    const prev = B.prevMood;
    const k = prev !== "" && prev !== st.mood ? smooth(0, FACE_BLEND, st.age) : 1;
    if (k < 1 && prev !== "") drawFace(B, V, pal, { mood: prev, age: st.age, decay: st.decay }, t, open, P, 1 - k);
    drawFace(B, V, pal, st, t, open, P, k);
  }
  extras(B, V, pal, st, t, ground, P);
}
