/**
 * GG Coder's dissolve language as plain numbers, Expo-free so `bun test` can
 * load it. Mirrors gg-app/src/App.css `:root` (--dur-*, --ease-*) and
 * transcript-motion.ts. The native primitive is ui/motion/Dissolve.tsx.
 *
 * Content resolves out of a soft blur (here: opacity + a hair of scale, since
 * RN cannot blur a live view cheaply), never slides sideways.
 */

/** Cubic-bezier control points; feed to `Easing.bezier(...)`. */
export type Bezier = readonly [number, number, number, number];

export const EASE = {
  /** Things arriving: quick start, soft land. `--ease-out`. */
  out: [0.22, 1, 0.36, 1],
  /** Things leaving: gathers speed on the way out. `--ease-in`. */
  in: [0.4, 0, 1, 1],
  /** In-place change (height, progress). `--ease-in-out`. */
  inOut: [0.4, 0, 0.2, 1],
  /** Instant-then-settle growth (composer, toasts). `--ease-expo`. */
  expo: [0.16, 1, 0.3, 1],
} as const satisfies Record<string, Bezier>;

/**
 * Springs, one vocabulary app-wide. tappy settles rather than bounces: every
 * spring here is near critically damped (dampingRatio ≥ 0.9), so a thing
 * arrives, eases in and stops, with no overshoot and no wobble. Bouncy
 * springs (low damping, high stiffness) read as gooey and were removed.
 *
 *   settle  something moving into place (a chip's neighbours closing a gap,
 *           a list making room, a highlight sliding to its tab)
 *   arrive  something appearing at its spot (a chip, a worker)
 *   press   the give under a finger, and the release
 */
export const SPRING = {
  settle: { duration: 300, dampingRatio: 0.95 },
  arrive: { duration: 280, dampingRatio: 1 },
  press: { duration: 160, dampingRatio: 1 },
} as const;

export const DUR = {
  press: 100,
  exit: 120,
  enter: 160,
  /** Per-word streaming fade. `--dur-row`. */
  row: 220,
  /** The shared "this just appeared / changed" entrance. `--dur-dissolve`. */
  dissolve: 340,
  /** Restored history resolving in place of the skeleton. */
  restore: 420,
  /** Reduced-motion substitute: a short plain fade. */
  reduced: 160,
  /**
   * A streamed word dissolving in on the phone: out of a soft blur into sharp
   * text. Longer than the desktop's `--dur-row` on purpose — a phone reveals a
   * few words per frame, and at 220ms the fade finished before the eye caught
   * it, which read as plain streaming. At this length several words are always
   * mid-resolve, so the edge of the reply is a soft gradient that moves.
   */
  word: 520,
} as const;

export type DissolveKind = "in" | "swap" | "restore" | "row";

export interface DissolvePlan {
  duration: number;
  delay: number;
  /** Opacity the animation starts from. */
  fromOpacity: number;
  /** Scale the animation starts from (1 = none). Stands in for blur. */
  fromScale: number;
  easing: Bezier;
}

/**
 * How a dissolve runs. Reduced motion keeps a plain short fade (no scale),
 * matching App.css's `prefers-reduced-motion` rule that swaps to `fade-in`.
 * Rows are opacity only: geometry belongs to the list's layout, and a scaled
 * row would move what FlashList has already measured.
 */
export function dissolvePlan(kind: DissolveKind, reduceMotion: boolean, delay = 0): DissolvePlan {
  if (reduceMotion) {
    return { duration: DUR.reduced, delay: 0, fromOpacity: 0, fromScale: 1, easing: EASE.out };
  }
  switch (kind) {
    case "row":
      return { duration: DUR.dissolve, delay, fromOpacity: 0, fromScale: 1, easing: EASE.out };
    case "restore":
      return { duration: DUR.restore, delay, fromOpacity: 0, fromScale: 1.012, easing: EASE.out };
    case "swap":
      return { duration: DUR.dissolve, delay, fromOpacity: 0, fromScale: 0.985, easing: EASE.out };
    default:
      return { duration: DUR.dissolve, delay, fromOpacity: 0, fromScale: 1.012, easing: EASE.out };
  }
}

/**
 * Session-local high-water mark, the same contract as GG Coder's
 * `createEntranceLifetime`: a row id animates at most once, and only when it
 * is newer than anything already seen. Recycled cells, replays and scrolling
 * back through history never re-run an entrance.
 *
 * Ids here are ordinal positions (a turn's index in the thread), because tappy
 * turn keys are strings; `settle` marks a range as already on screen.
 */
export interface EntranceLifetime {
  consume: (ordinal: number) => boolean;
  settle: (ordinal: number) => void;
}
export function createEntranceLifetime(first: number): EntranceLifetime {
  let next = first;
  return {
    consume(ordinal) {
      if (ordinal < next) return false;
      next = ordinal + 1;
      return true;
    },
    settle(ordinal) {
      next = Math.max(next, ordinal + 1);
    },
  };
}

/** Value at progress `t` (0..1) between `from` and 1; used by tests and for linear fallbacks. */
export function lerpFrom(from: number, t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return from + (1 - from) * clamped;
}

/**
 * A CSS `cubic-bezier(x1, y1, x2, y2)` evaluated at progress `t` (0..1): solve
 * x(s) = t for the curve parameter by Newton steps, falling back to bisection,
 * then return y(s). Matches what the browser does for GG Coder's keyframes.
 */
export function bezierAt([x1, y1, x2, y2]: Bezier, t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const x = (s: number) => ((ax * s + bx) * s + cx) * s;
  const dx = (s: number) => (3 * ax * s + 2 * bx) * s + cx;
  let s = t;
  for (let i = 0; i < 8; i++) {
    const err = x(s) - t;
    if (Math.abs(err) < 1e-6) return ((ay * s + by) * s + cy) * s;
    const d = dx(s);
    if (Math.abs(d) < 1e-6) break;
    s -= err / d;
  }
  let lo = 0;
  let hi = 1;
  s = t;
  for (let i = 0; i < 30; i++) {
    const v = x(s);
    if (Math.abs(v - t) < 1e-6) break;
    if (v < t) lo = s;
    else hi = s;
    s = (lo + hi) / 2;
  }
  return ((ay * s + by) * s + cy) * s;
}

/**
 * A streamed word's opacity `elapsedMs` after it landed: GG Coder's
 * `md-word-fade` (opacity 0 → 1 over `--dur-row`, `--ease-out`). Negative
 * elapsed (not yet painted) is fully transparent.
 */
export function wordFadeAlpha(elapsedMs: number, durationMs: number = DUR.row): number {
  if (elapsedMs <= 0) return 0;
  if (elapsedMs >= durationMs) return 1;
  return bezierAt(EASE.out, elapsedMs / durationMs);
}

/**
 * `color` at opacity `alpha`, as `rgba()`. React Native draws a nested `Text`
 * span's colour (alpha included) but not an animated `opacity` on it, so this
 * is how a single word inside a paragraph can fade. Accepts #rgb, #rrggbb,
 * #rrggbbaa, rgb() and rgba(); anything else is returned unchanged.
 */
export function withAlpha(color: string, alpha: number): string {
  const a = Math.min(1, Math.max(0, alpha));
  const round = (n: number) => Math.round(n * 1000) / 1000;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(color.trim());
  if (hex) {
    let h = hex[1]!;
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    const r = Number.parseInt(h.slice(0, 2), 16);
    const g = Number.parseInt(h.slice(2, 4), 16);
    const b = Number.parseInt(h.slice(4, 6), 16);
    const base = h.length === 8 ? Number.parseInt(h.slice(6, 8), 16) / 255 : 1;
    return `rgba(${r},${g},${b},${round(base * a)})`;
  }
  const fn = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(color.trim());
  if (fn) {
    const base = fn[4] === undefined ? 1 : Number(fn[4]);
    return `rgba(${fn[1]},${fn[2]},${fn[3]},${round(base * a)})`;
  }
  return color;
}

/** One streamed word's look, `elapsedMs` after it appeared. */
export interface WordDissolve {
  /** Fill opacity of the glyphs, 0..1. */
  alpha: number;
  /** Soft-glow radius in points: the "blur" the word resolves out of. */
  blur: number;
  /** Opacity of that glow, 0..1. */
  glow: number;
}

/**
 * The phone's dissolve for a streamed word: it arrives as a soft, blurred
 * smudge (a glow of its own colour, no sharp fill) and resolves into crisp
 * text — the effect of GG Coder's `md-word-in` (opacity + blur), built from
 * what a nested native text span can draw: its colour and its text shadow.
 */
export function wordDissolve(elapsedMs: number, durationMs: number = DUR.word): WordDissolve {
  if (elapsedMs >= durationMs) return { alpha: 1, blur: 0, glow: 0 };
  const t = Math.max(0, elapsedMs) / durationMs;
  const eased = bezierAt(EASE.out, t);
  return {
    alpha: eased,
    blur: 7 * (1 - eased),
    // Strongest at the start, gone by the time the fill is solid.
    glow: 0.7 * (1 - eased),
  };
}
