/**
 * Tappy, tappy's living mascot, as a React Native component.
 *
 *   <Tappy size={120} mood="working" color="#4ade80" interactive />
 *
 * The body is simulated and painted entirely on the UI thread: a Reanimated
 * frame callback advances `engine.ts` and records the frame into a Skia
 * picture, which the canvas draws. The React tree never re-renders while it
 * moves, so a busy transcript cannot make it stutter and it cannot slow the
 * transcript down.
 *
 * It sleeps when nobody can see it: the app in the background, `paused`, or
 * Reduce Motion (then it holds one settled, still pose in its mood). A small
 * Tappy runs at half rate; nobody can tell at chip size and it halves the cost.
 *
 * Decorative by default (hidden from assistive tech); pass
 * `accessibilityLabel` when it carries meaning on its own.
 */
import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { BlurStyle, Canvas, Picture, Skia, type SkCanvas, type SkPicture } from "@shopify/react-native-skia";
import { runOnJS, runOnUI, useFrameCallback, useSharedValue, type FrameInfo, type SharedValue } from "react-native-reanimated";
import { haptics } from "../ui/haptics";
import { useAppActive } from "../ui/useAppActive";
import { useReducedMotion } from "../ui/useReducedMotion";
import {
  advanceTappy,
  dragTappy,
  makeTappyBody,
  tappySleepSeed,
  TAPPY_SLEEP_STYLES,
  paintTappy,
  pokeTappy,
  releaseTappy,
  settleTappy,
  type TappyBody,
  type TappyMood,
  type TappyPainter,
  type TappyPalette,
  type RGB,
} from "./engine";
import { tappyPalette } from "./palette";
import { beginFrame, blankPicture, endFrame } from "../ui/skiaFrame";

export interface TappyProps {
  /** Edge of its square box, in points. */
  size: number;
  mood?: TappyMood;
  /** The agent's brand colour; none is tappy's own coral. */
  color?: string;
  /** Drag to spin it, tap to poke it. */
  interactive?: boolean;
  /**
   * Called after a tap pokes it (implies `interactive`). Home opens the agent
   * carousel this way: the poke lands first, so the tap still feels physical.
   */
  onPress?: () => void;
  /**
   * Hold still while this is strictly between 0 and 1: a transition that must
   * get every frame (home passes the keyboard's progress, so the composer
   * tracks the keyboard at full rate). Read on the UI thread, so it costs no
   * re-render to start or stop.
   */
  holdWhile?: SharedValue<number>;
  /** Freeze it (an off-screen row, a closed drawer). */
  paused?: boolean;
  accessibilityLabel?: string;
  /** Picks one of ten sleeping styles (hashed), e.g. a provider id, so a column of dozing Tappies differs. */
  sleepKey?: string;
  /**
   * Picks the sleeping style outright (0–9) instead of from the key's hash, for
   * a list that must never repeat one next to another (the agent rail). The key
   * still gives each its own breathing phase.
   */
  sleepStyle?: number;
  style?: StyleProp<ViewStyle>;
}

/** Below this edge it runs at half rate. */
const HALF_RATE_BELOW = 40;

/** Paints one recorded frame through Skia. Built per frame on the UI thread. */
/**
 * The Skia objects a frame paints with, made once per UI runtime and reused.
 *
 * Measured: the hero Tappy used to cost so much UI-thread time per frame that the
 * whole screen fell to ~20fps (the keyboard-tracking events arrived every 50ms
 * instead of every 16ms, so the composer stepped behind the keyboard). Most of
 * it was allocation and string parsing per dot: three Paints and a set of blur
 * filters built every frame, and every colour formatted as an `rgba(...)`
 * string and parsed back by `Skia.Color`. Now the paints and filters live for
 * the runtime and a colour is four floats written into one reused array.
 */
interface TappyTools {
  fill: ReturnType<typeof Skia.Paint>;
  halo: ReturnType<typeof Skia.Paint>;
  stroke: ReturnType<typeof Skia.Paint>;
  col: Float32Array;
  blurs: Record<number, ReturnType<typeof Skia.MaskFilter.MakeBlur>>;
  /** One path, reset per shape: a recorded picture keeps its own copy. */
  shape: ReturnType<typeof Skia.Path.Make>;
}

function tappyTools(): TappyTools {
  "worklet";
  const g = globalThis as unknown as { __tappyTools?: TappyTools };
  if (g.__tappyTools) return g.__tappyTools;
  const fill = Skia.Paint();
  fill.setAntiAlias(true);
  const halo = Skia.Paint();
  halo.setAntiAlias(true);
  halo.setBlendMode(12); // Plus: lights add up, like LEDs
  const stroke = Skia.Paint();
  stroke.setAntiAlias(true);
  stroke.setStyle(1); // Stroke
  stroke.setStrokeCap(1); // Round
  g.__tappyTools = { fill, halo, stroke, col: new Float32Array(4), blurs: {}, shape: Skia.Path.Make() };
  return g.__tappyTools;
}

/** Paints one recorded frame through Skia. */
function skiaPainter(canvas: SkCanvas): TappyPainter {
  "worklet";
  const { fill, halo, stroke, col, blurs, shape } = tappyTools();
  // Writes the colour into the shared array; setColor copies it on the call.
  const color = (c: RGB, a: number) => {
    col[0] = c[0] / 255;
    col[1] = c[1] / 255;
    col[2] = c[2] / 255;
    col[3] = a < 0 ? 0 : a > 1 ? 1 : a;
    return col;
  };
  const black = (a: number) => {
    col[0] = 0;
    col[1] = 0;
    col[2] = 0;
    col[3] = a;
    return col;
  };
  // Blur filters cached by rounded radius, for the runtime's life.
  const blur = (sigma: number) => {
    const k = Math.max(0.5, Math.round(sigma * 2) / 2);
    return (blurs[k] ??= Skia.MaskFilter.MakeBlur(BlurStyle.Normal, k, true));
  };
  const path = (pts: number[], close: boolean) => {
    const p = shape;
    p.reset();
    p.moveTo(pts[0]!, pts[1]!);
    for (let i = 2; i < pts.length; i += 2) p.lineTo(pts[i]!, pts[i + 1]!);
    if (close) p.close();
    return p;
  };
  fill.setMaskFilter(null);
  return {
    dot(x, y, r, c, a) {
      if (r <= 0.05 || a <= 0.01) return;
      fill.setColor(color(c, a));
      canvas.drawCircle(x, y, r, fill);
    },
    glow(x, y, r, c, a) {
      if (r <= 0.1 || a <= 0.01) return;
      halo.setColor(color(c, a));
      halo.setMaskFilter(blur(r * 0.45));
      canvas.drawCircle(x, y, r * 0.55, halo);
    },
    oval(cx, cy, rx, ry, rot, c, a, glowR, gc) {
      if (rx <= 0.05 || ry <= 0.05) return;
      canvas.save();
      canvas.translate(cx, cy);
      canvas.rotate((rot * 180) / Math.PI, 0, 0);
      const rect = Skia.XYWHRect(-rx, -ry, rx * 2, ry * 2);
      if (glowR > 0) {
        halo.setColor(color(gc, a * 0.9));
        halo.setMaskFilter(blur(glowR * 0.5));
        canvas.drawOval(rect, halo);
      }
      fill.setColor(color(c, a));
      canvas.drawOval(rect, fill);
      canvas.restore();
    },
    line(pts, width, c, a, glowR, gc) {
      if (pts.length < 4) return;
      const p = path(pts, false);
      if (glowR > 0) {
        stroke.setStrokeWidth(width * 1.6);
        stroke.setColor(color(gc, a * 0.7));
        stroke.setMaskFilter(blur(glowR * 0.5));
        canvas.drawPath(p, stroke);
      }
      stroke.setMaskFilter(null);
      stroke.setStrokeWidth(width);
      stroke.setColor(color(c, a));
      canvas.drawPath(p, stroke);
    },
    poly(pts, c, a) {
      if (pts.length < 6) return;
      fill.setColor(color(c, a));
      canvas.drawPath(path(pts, true), fill);
    },
    shadow(cx, cy, w, h, a) {
      if (w <= 0.1) return;
      fill.setColor(black(a));
      fill.setMaskFilter(blur(Math.max(1, h * 0.8)));
      canvas.drawOval(Skia.XYWHRect(cx - w * 0.85, cy - h * 0.6, w * 1.7, h * 1.2), fill);
      fill.setMaskFilter(null);
    },
  };
}

/** One frame, recorded with the runtime's shared recorder (see `skiaFrame.ts`). */
function recordFrame(body: TappyBody, t: number, mood: TappyMood, pal: TappyPalette): SkPicture {
  "worklet";
  const canvas = beginFrame(body.S, body.S);
  paintTappy(body, t, mood, pal, skiaPainter(canvas));
  return endFrame();
}

interface TickerProps {
  S: number;
  seed: number;
  body: SharedValue<TappyBody | null>;
  mood: SharedValue<TappyMood>;
  palette: SharedValue<TappyPalette>;
  /** The palette actually painted, easing toward `palette`. */
  shown: SharedValue<TappyPalette | null>;
  picture: SharedValue<SkPicture>;
  clock: SharedValue<number>;
  /** Seconds since the last repaint (repaints are capped per second). */
  sinceDraw: SharedValue<number>;
  /** While strictly between 0 and 1, hold still (see TappyProps.holdWhile). */
  hold?: SharedValue<number>;
}

const PALETTE_KEYS = ["base", "light", "dark", "glow", "eye", "off"] as const;

/**
 * The heartbeat, mounted only while Tappy is awake. Mounting and unmounting is
 * how it starts and stops: Reanimated registers a frame callback in an effect,
 * and toggling one with `setActive` while it re-registers can reach a callback
 * that is already gone. The callback is stable for the same reason — a new
 * function every render would re-register it every render.
 */
function TappyTicker({ S, seed, body, mood, palette, shown, picture, clock, sinceDraw, hold }: TickerProps) {
  const tick = useCallback(
    (info: FrameInfo) => {
      "worklet";
      if (body.value === null || body.value.S !== S || body.value.seed !== seed) body.value = makeTappyBody(S, seed < 0 ? undefined : seed);
      const B = body.value;
      const dt = Math.min(1 / 30, Math.max(0.001, (info.timeSincePreviousFrame ?? 16) / 1000));
      clock.value += dt;
      advanceTappy(B, clock.value, dt, mood.value);
      // Something on screen is moving that must not be starved of frames
      // (the keyboard, while the composer tracks it): hold this pose.
      if (hold && hold.value > 0.01 && hold.value < 0.99) return;
      // Repainted at most 60 times a second (30 for a small Tappy), whatever the
      // display's rate: a 120Hz screen otherwise doubles the cost of something
      // nobody can see the difference in. The simulation still runs every frame.
      sinceDraw.value += dt;
      if (sinceDraw.value < (S < HALF_RATE_BELOW ? 1 / 31 : 1 / 61)) return;
      sinceDraw.value = 0;
      // A colour change morphs: the painted palette eases toward the target,
      // so switching agent recolours the same Tappy instead of swapping it.
      const target = palette.value;
      let pal = shown.value;
      if (pal === null) pal = target;
      else if (pal !== target) {
        const k = 1 - Math.exp(-dt * 9);
        let done = true;
        const next = {} as TappyPalette;
        for (const key of PALETTE_KEYS) {
          const a = pal[key];
          const b = target[key];
          const c: RGB = [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
          if (Math.abs(c[0] - b[0]) + Math.abs(c[1] - b[1]) + Math.abs(c[2] - b[2]) > 1.5) done = false;
          next[key] = c;
        }
        pal = done ? target : next;
      }
      shown.value = pal;
      picture.value = recordFrame(B, clock.value, mood.value, pal);
    },
    [S, seed, body, mood, palette, shown, picture, clock, sinceDraw, hold],
  );
  useFrameCallback(tick, true);
  return null;
}

function TappyView({ size, mood = "idle", color, interactive: interactiveProp = false, onPress, paused = false, accessibilityLabel, sleepKey, sleepStyle, holdWhile, style }: TappyProps) {
  const hashed = sleepKey === undefined ? -1 : tappySleepSeed(sleepKey);
  // The style is the seed's remainder by the style count: swap just that part.
  const seed =
    sleepStyle === undefined
      ? hashed
      : Math.max(0, hashed) - (Math.max(0, hashed) % TAPPY_SLEEP_STYLES) + (((sleepStyle % TAPPY_SLEEP_STYLES) + TAPPY_SLEEP_STYLES) % TAPPY_SLEEP_STYLES);
  const interactive = interactiveProp || onPress !== undefined;
  const pressRef = useRef(onPress);
  pressRef.current = onPress;
  const tapped = useCallback(() => {
    haptics.poke();
    pressRef.current?.();
  }, []);
  const spun = useCallback(() => haptics.select(), []);
  const S = Math.max(10, Math.round(size));
  const appActive = useAppActive();
  const reduceMotion = useReducedMotion();
  const palette = useMemo(() => tappyPalette(color), [color]);

  // UI-thread state. The body is rebuilt only when the size changes.
  const body = useSharedValue<TappyBody | null>(null);
  const moodSV = useSharedValue<TappyMood>(mood);
  const paletteSV = useSharedValue<TappyPalette>(palette);
  const shownPal = useSharedValue<TappyPalette | null>(null);
  // The app-wide blank, never one of its own: see skiaFrame.ts (the crash).
  const picture = useSharedValue<SkPicture>(blankPicture());
  const clock = useSharedValue(0);
  const sinceDraw = useSharedValue(1);

  useEffect(() => {
    moodSV.value = mood;
  }, [mood, moodSV]);
  useEffect(() => {
    paletteSV.value = palette;
  }, [palette, paletteSV]);

  const live = appActive && !paused && !reduceMotion;

  // Not animating: one settled, still frame in its mood (and repaint on change).
  useEffect(() => {
    if (live) return;
    // On the UI thread like every other frame: the engine paints through
    // module-level scratch colours, and once a worklet has captured those the
    // JS-thread copies are frozen, so painting here would warn on every write.
    runOnUI((size: number, m: TappyMood, pal: TappyPalette, sd: number) => {
      "worklet";
      const still = makeTappyBody(size, sd < 0 ? undefined : sd);
      settleTappy(still, 1.2, m);
      picture.value = recordFrame(still, 1.2, m, pal);
    })(S, mood, palette, seed);
  }, [live, S, mood, palette, picture, seed]);

  const gesture = useMemo(() => {
    if (!interactive) return undefined;
    const pan = Gesture.Pan()
      .minDistance(4)
      .onStart(() => {
        "worklet";
        runOnJS(spun)();
      })
      .onChange((e) => {
        "worklet";
        if (body.value) dragTappy(body.value, e.changeX, e.changeY, 1 / 60);
      })
      .onFinalize(() => {
        "worklet";
        if (body.value) releaseTappy(body.value);
      });
    const tap = Gesture.Tap().onEnd((e) => {
      "worklet";
      if (body.value) pokeTappy(body.value, e.x, e.y);
      runOnJS(tapped)();
    });
    return Gesture.Exclusive(pan, tap);
  }, [interactive, body, tapped, spun]);

  const canvas = (
    <Canvas style={{ width: S, height: S }} pointerEvents="none">
      <Picture picture={picture as SharedValue<SkPicture>} />
    </Canvas>
  );

  return (
    <View
      style={[{ width: S, height: S }, style]}
      accessible={accessibilityLabel !== undefined}
      accessibilityLabel={accessibilityLabel}
      accessibilityElementsHidden={accessibilityLabel === undefined}
      importantForAccessibility={accessibilityLabel === undefined ? "no-hide-descendants" : "yes"}
    >
      {live ? (
        <TappyTicker S={S} seed={seed} body={body} mood={moodSV} palette={paletteSV} shown={shownPal} picture={picture} clock={clock} sinceDraw={sinceDraw} hold={holdWhile} />
      ) : null}
      {/* The canvas never takes touches (pointerEvents none), so a detector
          attached to it saw nothing: a real view holds the gesture instead. */}
      {gesture ? (
        <GestureDetector gesture={gesture}>
          <View collapsable={false} style={StyleSheet.absoluteFill}>
            {canvas}
          </View>
        </GestureDetector>
      ) : (
        canvas
      )}
    </View>
  );
}

export const Tappy = memo(TappyView);
