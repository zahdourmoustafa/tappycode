/**
 * The thinking-level dial in the model sheet: Tappy in the middle of an LED arc,
 * with the level shown as energy round him (`thinkFx.ts`).
 *
 * The light show is two Skia layers painted on the UI thread, one behind Tappy
 * and one in front, so sparks orbit round him. The stops are real buttons laid
 * over the arc (tap one to jump to it, or use − and +), and the level's name
 * rolls up or down on the LED readout with the direction of the change.
 * Reduce Motion keeps the dial and drops the motion: one still frame per level.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Canvas, Picture, type SkPicture } from "@shopify/react-native-skia";
import { beginFrame, blankPicture, endFrame } from "./skiaFrame";
import Reanimated, {
  Easing,
  FadeInDown,
  FadeInUp,
  FadeOutDown,
  FadeOutUp,
  runOnUI,
  useAnimatedStyle,
  useFrameCallback,
  useSharedValue,
  withTiming,
  type FrameInfo,
  type SharedValue,
} from "react-native-reanimated";
import Ionicons from "@expo/vector-icons/Ionicons";
import { theme } from "../theme";
import { haptics } from "./haptics";
import { useReducedMotion } from "./useReducedMotion";
import { useAppActive } from "./useAppActive";
import { Led } from "./stage/Led";
import { dashedOutline } from "./stage/DashedRule";
import { Tappy } from "../tappy/Tappy";
import { tappyPalette } from "../tappy/palette";
import type { TappyMood } from "../tappy/engine";
import { DUR } from "../motion";
import { sounds } from "./sounds";
import { levelSound, SOUND_NAMES } from "../soundsPolicy";
import { hexRgb, skiaFx } from "./LaunchFx";
import { paintDialBack, paintDialFront, tappyKick, stopFraction, type DialGeometry, type DialMoment } from "../thinkFx";
import type { FxPalette } from "../launchFx";

const SIZE = 260;
const RADIUS = 104;
const TAPPY = 120;
const ARC_START = (150 * Math.PI) / 180;
const ARC_SPAN = (240 * Math.PI) / 180;
const HIT = 36;

/** Tappy's mood for a position along the dial, 0..1. */
export function levelMood(fraction: number): TappyMood {
  if (fraction <= 0) return "sleepy";
  if (fraction < 0.5) return "idle";
  if (fraction < 0.85) return "thinking";
  return "working";
}

interface Values {
  clock: SharedValue<number>;
  level: SharedValue<number>;
  since: SharedValue<number>;
  dir: SharedValue<number>;
  stop: SharedValue<number>;
}

function paintLayer(g: DialGeometry, m: DialMoment, pal: FxPalette, front: boolean): SkPicture {
  "worklet";
  const canvas = beginFrame(g.size, g.size);
  const p = skiaFx(canvas, { w: g.size, h: g.size, cx: g.size / 2, cy: g.size / 2 });
  const scratch = new Float32Array(4);
  if (front) paintDialFront(g, m, pal, p, scratch);
  else paintDialBack(g, m, pal, p, scratch);
  return endFrame();
}

function Ticker({ g, pal, v, back, front }: { g: DialGeometry; pal: FxPalette; v: Values; back: SharedValue<SkPicture>; front: SharedValue<SkPicture> }) {
  const sinceDraw = useSharedValue(1);
  const tick = useCallback(
    (info: FrameInfo) => {
      "worklet";
      const dt = Math.min(1 / 30, Math.max(0.001, (info.timeSincePreviousFrame ?? 16) / 1000));
      v.clock.value += dt;
      v.since.value += dt;
      sinceDraw.value += dt;
      if (sinceDraw.value < 1 / 61) return;
      sinceDraw.value = 0;
      const m: DialMoment = { t: v.clock.value, level: v.level.value, since: v.since.value, dir: v.dir.value, stop: v.stop.value };
      back.value = paintLayer(g, m, pal, false);
      front.value = paintLayer(g, m, pal, true);
    },
    [g, pal, v, back, front, sinceDraw],
  );
  useFrameCallback(tick, true);
  return null;
}

export interface ThinkingDialProps {
  names: string[];
  index: number;
  color: string;
  /** The sheet is closed: stop drawing. */
  paused: boolean;
  onStep: (index: number) => void;
}

export function ThinkingDial({ names, index, color, paused, onStep }: ThinkingDialProps) {
  const reduce = useReducedMotion();
  const active = useAppActive();
  const count = names.length;
  const fraction = count > 1 ? index / (count - 1) : 0;
  const g = useMemo<DialGeometry>(
    () => ({ size: SIZE, radius: RADIUS, tappyR: TAPPY * 0.3, start: ARC_START, span: ARC_SPAN, stops: Math.max(1, count) }),
    [count],
  );
  const pal = useMemo<FxPalette>(() => {
    const p = tappyPalette(color);
    return { bg: hexRgb(theme.color.bg), base: p.base, light: p.light, off: hexRgb(theme.stage.dash) };
  }, [color]);
  const v: Values = {
    clock: useSharedValue(0),
    level: useSharedValue(fraction),
    since: useSharedValue(10),
    dir: useSharedValue(1),
    stop: useSharedValue(index),
  };
  const back = useSharedValue<SkPicture>(blankPicture());
  const front = useSharedValue<SkPicture>(blankPicture());
  const live = !paused && active && !reduce;

  // A change: the track sweeps to the new level and the event fires.
  const prev = useRef(index);
  const [dir, setDir] = useState(1);
  useEffect(() => {
    const from = prev.current;
    prev.current = index;
    if (from === index) {
      v.level.value = fraction;
      return;
    }
    const up = index > from;
    setDir(up ? 1 : -1);
    v.dir.value = up ? 1 : -1;
    // Up lights the new stop; down puts out the one that was on.
    v.stop.value = up ? index : from;
    v.since.value = 0;
    v.level.value = withTiming(fraction, { duration: 420, easing: Easing.bezier(0.22, 1, 0.36, 1) });
    // `v` is a new object each render around stable shared values; only a new
    // stop should animate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, fraction]);

  // Still frame when not animating (Reduce Motion, closed, background).
  useEffect(() => {
    if (live) return;
    const m: DialMoment = { t: 0, level: fraction, since: 10, dir: 1, stop: index };
    // Painted on the UI thread like every frame (Skia objects live there).
    const paint = (gg: DialGeometry, mm: DialMoment, pp: FxPalette) => {
      "worklet";
      back.value = paintLayer(gg, mm, pp, false);
      front.value = paintLayer(gg, mm, pp, true);
    };
    runOnUI(paint)(g, m, pal);
  }, [live, fraction, index, g, pal, back, front]);

  const tappyStyle = useAnimatedStyle(() => ({ transform: [{ scale: tappyKick(v.since.value, v.dir.value) }] }));

  useEffect(() => {
    if (!paused) sounds.preload(SOUND_NAMES.filter((n) => n.startsWith("level-")));
  }, [paused]);

  const step = (to: number) => {
    if (to < 0 || to >= count || to === index) return;
    const sound = levelSound(index, to, count);
    if (sound) sounds.play(sound);
    // The feel climbs with the level: a tick low down, a thump at the top.
    const f = count > 1 ? to / (count - 1) : 0;
    if (to < index) haptics.poke();
    else if (f >= 1) haptics.attention();
    else if (f >= 0.5) haptics.detent();
    else haptics.select();
    onStep(to);
  };

  const centre = SIZE / 2;
  const at = (i: number) => {
    const a = ARC_START + ARC_SPAN * stopFraction(g, i);
    return { left: centre + Math.cos(a) * RADIUS - HIT / 2, top: centre + Math.sin(a) * RADIUS - HIT / 2 };
  };
  const first = at(0);
  const last = at(count - 1);

  return (
    <View style={styles.wrap}>
      <View style={styles.dial}>
        {live && <Ticker g={g} pal={pal} v={v} back={back} front={front} />}
        <Canvas style={StyleSheet.absoluteFill} pointerEvents="none">
          <Picture picture={back as SharedValue<SkPicture>} />
        </Canvas>
        <Reanimated.View style={[styles.tappy, tappyStyle]} pointerEvents="none">
          <Tappy size={TAPPY} mood={levelMood(fraction)} color={color} paused={paused} accessibilityLabel="Tappy" />
        </Reanimated.View>
        <Canvas style={StyleSheet.absoluteFill} pointerEvents="none">
          <Picture picture={front as SharedValue<SkPicture>} />
        </Canvas>
        {names.map((name, i) => (
          <Pressable
            key={name}
            accessibilityRole="button"
            accessibilityLabel={`${name} thinking`}
            accessibilityState={{ selected: i === index }}
            onPress={() => step(i)}
            style={[styles.hit, at(i)]}
          />
        ))}
        <StepButton icon="remove" label="Less thinking" disabled={index <= 0} at={{ left: first.left - 4, top: first.top + HIT + 6 }} onPress={() => step(index - 1)} />
        <StepButton icon="add" label="More thinking" disabled={index >= count - 1} at={{ left: last.left - 4, top: last.top + HIT + 6 }} onPress={() => step(index + 1)} />
      </View>
      {/* The level's name rolls the way the level went. */}
      <View style={styles.readout}>
        <Reanimated.View
          key={names[index] ?? ""}
          style={styles.readoutLine}
          entering={reduce ? undefined : (dir > 0 ? FadeInDown : FadeInUp).duration(DUR.dissolve)}
          exiting={reduce ? undefined : (dir > 0 ? FadeOutUp : FadeOutDown).duration(DUR.enter)}
        >
          <Led size={theme.stage.ledSize + 4} color={color} tone="agent">{names[index] ?? ""}</Led>
        </Reanimated.View>
      </View>
    </View>
  );
}

function StepButton({ icon, label, disabled, at, onPress }: {
  icon: "add" | "remove";
  label: string;
  disabled: boolean;
  at: { left: number; top: number };
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.stepButton, at, disabled && styles.disabled, pressed && styles.pressed]}
    >
      <Ionicons name={icon} size={18} color={theme.color.text} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: "center", gap: theme.space(1) },
  dial: { width: SIZE, height: SIZE },
  tappy: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center" },
  hit: { position: "absolute", width: HIT, height: HIT, borderRadius: HIT / 2 },
  readout: { height: 28, alignSelf: "stretch", alignItems: "center", justifyContent: "center" },
  readoutLine: { position: "absolute" },
  stepButton: {
    ...dashedOutline,
    position: "absolute",
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  disabled: { opacity: 0.35 },
  pressed: { opacity: 0.7 },
});
