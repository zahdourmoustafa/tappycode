/**
 * Paints the New goal launch (`launchFx.ts`) full screen, on the UI thread.
 *
 * The moment is entirely shared values, so the hold, the blast and the
 * opening never wait on React: the owner sets `charge` with a timing, the
 * blast starts on the UI thread the instant the charge completes (`burst`
 * goes from -1 to 0 and this ticker advances it), and `reveal`/`fade` are
 * timings too. A frame is recorded into a Skia picture, as `Tappy` does, at
 * most 60 times a second.
 */
import { useCallback, useMemo } from "react";
import { StyleSheet } from "react-native";
import { Canvas, Picture, Skia, BlurStyle, type SkCanvas, type SkPicture } from "@shopify/react-native-skia";
import { beginFrame, blankPicture, endFrame } from "./skiaFrame";
import { useFrameCallback, useSharedValue, type FrameInfo, type SharedValue } from "react-native-reanimated";
import { paintLaunch, type FxPainter, type FxPalette, type FxRGB, type FxScene } from "../launchFx";
import { tappyPalette } from "../tappy/palette";
import { theme } from "../theme";

export interface LaunchFxValues {
  /** Seconds; advanced by the ticker. */
  clock: SharedValue<number>;
  charge: SharedValue<number>;
  /** Seconds since the blast, -1 before it; advanced by the ticker once it is 0 or more. */
  burst: SharedValue<number>;
  reveal: SharedValue<number>;
  fade: SharedValue<number>;
}

export function hexRgb(hex: string): FxRGB {
  const n = parseInt(hex.replace("#", "").slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

interface FxTools {
  fill: ReturnType<typeof Skia.Paint>;
  halo: ReturnType<typeof Skia.Paint>;
  stroke: ReturnType<typeof Skia.Paint>;
  col: Float32Array;
  blurs: Record<number, ReturnType<typeof Skia.MaskFilter.MakeBlur>>;
}

/** Paints and filters made once per UI runtime (see `tappyTools` in Tappy.tsx). */
function fxTools(): FxTools {
  "worklet";
  const g = globalThis as unknown as { __launchFxTools?: FxTools };
  if (g.__launchFxTools) return g.__launchFxTools;
  const fill = Skia.Paint();
  fill.setAntiAlias(true);
  const halo = Skia.Paint();
  halo.setAntiAlias(true);
  halo.setBlendMode(12); // Plus: lights add up
  const stroke = Skia.Paint();
  stroke.setAntiAlias(true);
  stroke.setStyle(1);
  g.__launchFxTools = { fill, halo, stroke, col: new Float32Array(4), blurs: {} };
  return g.__launchFxTools;
}

/** The `FxPainter` both effects draw through; `s` is only used by `cover`. */
export function skiaFx(canvas: SkCanvas, s: { w: number; h: number; cx: number; cy: number }): FxPainter {
  "worklet";
  const { fill, halo, stroke, col, blurs } = fxTools();
  const color = (c: FxRGB, a: number) => {
    col[0] = c[0] / 255;
    col[1] = c[1] / 255;
    col[2] = c[2] / 255;
    col[3] = a < 0 ? 0 : a > 1 ? 1 : a;
    return col;
  };
  // Cached by an ~8% step of the radius: a growing glow would otherwise make
  // a new filter on almost every frame (see skiaFrame.ts for why that hurts).
  const blur = (sigma: number) => {
    const k = Math.round(Math.log(Math.max(0.5, sigma)) * 12);
    let f = blurs[k];
    if (!f) {
      f = Skia.MaskFilter.MakeBlur(BlurStyle.Normal, Math.exp(k / 12), true);
      blurs[k] = f;
    }
    return f;
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
    ring(cx, cy, r, width, c, a) {
      if (r <= 0.5 || a <= 0.01) return;
      stroke.setMaskFilter(null);
      stroke.setStrokeWidth(width);
      stroke.setColor(color(c, a));
      canvas.drawCircle(cx, cy, r, stroke);
    },
    cover(c, a, hole) {
      if (a <= 0.005) return;
      // A ring from the hole's edge to past the farthest corner, rather than a
      // rect with a hole cut in a fresh path every frame.
      const far = Math.hypot(Math.max(s.cx, s.w - s.cx), Math.max(s.cy, s.h - s.cy)) + 4;
      const inner = Math.max(0, hole);
      stroke.setMaskFilter(null);
      stroke.setStrokeWidth(far - inner);
      stroke.setColor(color(c, a));
      canvas.drawCircle(s.cx, s.cy, (far + inner) / 2, stroke);
    },
    radial(cx, cy, r, c, a) {
      if (r <= 0.5 || a <= 0.01) return;
      // A soft disc: a blurred circle on the additive paint, no per-frame shader.
      halo.setColor(color(c, a));
      halo.setMaskFilter(blur(r * 0.38));
      canvas.drawCircle(cx, cy, r * 0.62, halo);
    },
  };
}

function Ticker({ scene, palette, values, picture }: { scene: FxScene; palette: FxPalette; values: LaunchFxValues; picture: SharedValue<SkPicture> }) {
  const sinceDraw = useSharedValue(1);
  const { clock, charge, burst, reveal, fade } = values;
  const tick = useCallback(
    (info: FrameInfo) => {
      "worklet";
      const dt = Math.min(1 / 30, Math.max(0.001, (info.timeSincePreviousFrame ?? 16) / 1000));
      clock.value += dt;
      if (burst.value >= 0) burst.value += dt;
      sinceDraw.value += dt;
      if (sinceDraw.value < 1 / 61) return;
      sinceDraw.value = 0;
      const canvas = beginFrame(scene.w, scene.h);
      paintLaunch(scene, { t: clock.value, charge: charge.value, burst: burst.value, reveal: reveal.value, fade: fade.value }, palette, skiaFx(canvas, scene));
      picture.value = endFrame();
    },
    [scene, palette, clock, charge, burst, reveal, fade, sinceDraw, picture],
  );
  useFrameCallback(tick, true);
  return null;
}

/** Full-screen, touch-through. Mount it only while the launch step is up. */
export function LaunchFx({ scene, color, values }: { scene: FxScene; color: string; values: LaunchFxValues }) {
  const palette = useMemo<FxPalette>(() => {
    const pal = tappyPalette(color);
    return { bg: hexRgb(theme.color.bg), base: pal.base, light: pal.light, off: hexRgb(theme.stage.dash) };
  }, [color]);
  const picture = useSharedValue<SkPicture>(blankPicture());
  return (
    <>
      <Ticker scene={scene} palette={palette} values={values} picture={picture} />
      <Canvas style={StyleSheet.absoluteFill} pointerEvents="none">
        <Picture picture={picture as SharedValue<SkPicture>} />
      </Canvas>
    </>
  );
}
