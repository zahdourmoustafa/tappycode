/**
 * The soft pool of the agent's colour behind a large Tappy (home, the agent
 * carousel).
 *
 * A colour change blends on the UI thread, from whatever is showing to the new
 * colour, never through nothing: a cross-fade of two glows dipped to half
 * strength in the middle, which read as the colour blinking out between
 * agents. The gradient's stops are derived values, so a change redraws the
 * one canvas every frame for ~400ms and React never re-renders during it.
 */
import { useEffect } from "react";
import { Canvas, Circle, RadialGradient, vec } from "@shopify/react-native-skia";
import { StyleSheet, View } from "react-native";
import { Easing, interpolateColor, useDerivedValue, useSharedValue, withTiming } from "react-native-reanimated";
import { withAlpha } from "../motion";
import { useReducedMotion } from "./useReducedMotion";

export interface AgentGlowProps {
  color: string;
  /** Edge of the square the glow fills. */
  size: number;
}

/** Long enough to read as a blend, short enough to keep up with a swipe. */
const BLEND_MS = 420;

export function AgentGlow({ color, size }: AgentGlowProps) {
  const r = size / 2;
  const reduce = useReducedMotion();
  const from = useSharedValue(color);
  const to = useSharedValue(color);
  const t = useSharedValue(1);

  useEffect(() => {
    if (color === to.value) return;
    // Start from what is on screen right now, so a change mid-blend (a fast
    // swipe through several agents) carries on smoothly instead of jumping.
    from.value = interpolateColor(t.value, [0, 1], [from.value, to.value]) as string;
    to.value = color;
    t.value = 0;
    t.value = reduce ? 1 : withTiming(1, { duration: BLEND_MS, easing: Easing.out(Easing.cubic) });
  }, [color, reduce, from, to, t]);

  const colors = useDerivedValue(() => {
    const c = interpolateColor(t.value, [0, 1], [from.value, to.value]) as string;
    return [withAlphaW(c, 0.32), withAlphaW(c, 0.1), withAlphaW(c, 0)];
  });

  return (
    <View pointerEvents="none" style={[styles.box, { width: size, height: size, marginLeft: -r, marginTop: -r }]}>
      <Canvas style={{ width: size, height: size }}>
        <Circle cx={r} cy={r} r={r}>
          <RadialGradient c={vec(r, r)} r={r} colors={colors} positions={[0, 0.45, 1]} />
        </Circle>
      </Canvas>
    </View>
  );
}

/**
 * `withAlpha` for the UI thread: interpolateColor hands back `rgba(r, g, b, a)`
 * (or hex for a settled value), and this rewrites its alpha.
 */
function withAlphaW(c: string, a: number): string {
  "worklet";
  const m = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/.exec(c);
  if (m) return `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${a})`;
  if (c.charAt(0) === "#" && c.length >= 7) {
    const n = parseInt(c.slice(1, 7), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }
  return c;
}

// Kept for callers that tint with the JS-side helper.
export { withAlpha };

const styles = StyleSheet.create({
  box: { position: "absolute", left: "50%", top: "50%" },
});
