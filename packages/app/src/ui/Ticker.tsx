/**
 * The chat's LED ticker: one dotted strip under the title naming what the agent
 * is doing. Tool calls never enter the thread; this is where they live. Tap it
 * to drop down this turn's steps. Words are decided in `tickerText.ts`.
 */
import { memo, useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, View, type LayoutChangeEvent } from "react-native";
import Animated, {
  FadeIn,
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import Ionicons from "@expo/vector-icons/Ionicons";
import { theme } from "../theme";
import { Tappy } from "../tappy/Tappy";
import { Led } from "./stage/Led";
import { DotGrid } from "./stage/DotGrid";
import { Pixel } from "./stage/Pixel";
import { haptics } from "./haptics";
import { useReducedMotion } from "./useReducedMotion";
import { receiptLength, receiptParts, receiptText, revealParts, tickerLine, tickerSteps, type TickerInput } from "./tickerText";
import type { TurnReceipt } from "../activity";
import { useStatusRowHeight } from "./useStatusRowHeight";
import { SPRING } from "../motion";

const TAPPY = 40;
const STRIP = 34;
/** Marquee pace, points per second. */
const SPEED = 40;

type Props = TickerInput & { color?: string };

function Marquee({ text, tone, color }: { text: string; tone: "agent" | "attention" | "dim"; color?: string }) {
  const reduced = useReducedMotion();
  const [box, setBox] = useState(0);
  const [width, setWidth] = useState(0);
  const x = useSharedValue(0);
  const overflow = box > 0 && width > box;
  useEffect(() => {
    cancelAnimation(x);
    x.value = 0;
    if (!overflow || reduced) return;
    const distance = width - box + theme.space(4);
    x.value = withRepeat(
      withSequence(
        withDelay(1200, withTiming(-distance, { duration: (distance / SPEED) * 1000, easing: Easing.linear })),
        withDelay(1200, withTiming(0, { duration: 300 })),
      ),
      -1,
    );
  }, [overflow, reduced, width, box, x, text]);
  const moving = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  return (
    <View style={styles.marquee} onLayout={(e: LayoutChangeEvent) => setBox(e.nativeEvent.layout.width)}>
      <Animated.View style={[styles.marqueeRun, moving]}>
        <View onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}>
          <Led tone={tone} color={tone === "agent" ? color : undefined}>{text}</Led>
        </View>
      </Animated.View>
    </View>
  );
}

function TickerView({ color, ...input }: Props) {
  const reduced = useReducedMotion();
  const line = tickerLine(input);
  const steps = useMemo(() => tickerSteps(input.activity), [input.activity]);
  const [open, setOpen] = useState(false);
  const [listHeight, setListHeight] = useState(0);
  const height = useSharedValue(0);
  const turn = useSharedValue(0);
  useEffect(() => {
    const to = open ? listHeight : 0;
    height.value = reduced ? to : withSpring(to, SPRING.settle);
    turn.value = reduced ? (open ? 1 : 0) : withTiming(open ? 1 : 0, { duration: 180 });
  }, [open, listHeight, reduced, height, turn]);
  const drop = useAnimatedStyle(() => ({ height: height.value }));
  const chevron = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.value * 180}deg` }] }));

  return (
    // Fades in when it mounts (a chat that has just finished reopening), so
    // the strip arrives with the messages rather than snapping in.
    <Animated.View entering={reduced ? undefined : FadeIn.duration(260)}>
      <Pressable
        onPress={() => {
          haptics.select();
          setOpen((o) => !o);
        }}
        accessibilityRole="button"
        accessibilityLabel={line.text}
        accessibilityState={{ expanded: open }}
        accessibilityHint="Shows this turn's steps"
        style={styles.strip}
      >
        <DotGrid fine />
        <Tappy size={TAPPY} mood={line.mood} color={color} style={styles.tappy} />
        <Marquee text={line.text} tone={line.tone} color={color} />
        <Animated.View style={chevron}>
          <Ionicons name="chevron-down" size={14} color={theme.color.textDim} />
        </Animated.View>
      </Pressable>
      {/* Hangs over the thread rather than sitting in the measured top area:
          growing that area moved the whole chat down every time the list
          opened. Absolute, so the ticker's own height never changes. */}
      <Animated.View style={[styles.drop, drop]} pointerEvents={open ? "auto" : "none"}>
        <View style={styles.list} onLayout={(e: LayoutChangeEvent) => setListHeight(e.nativeEvent.layout.height)}>
          {steps.length === 0 ? (
            <Led tone="dim">NO STEPS THIS TURN</Led>
          ) : (
            steps.map((step) => (
              <View key={step.id} style={styles.step}>
                <View style={styles.stepMark}>
                  {step.state === "live" ? (
                    <Pixel kind="live" color={color} />
                  ) : (
                    <Ionicons
                      name={step.state === "failed" ? "close" : "checkmark"}
                      size={12}
                      color={step.state === "failed" ? theme.color.danger : theme.color.textDim}
                    />
                  )}
                </View>
                <Led tone={step.state === "live" ? "agent" : "dim"} color={step.state === "live" ? color : undefined}>
                  {step.verb}
                </Led>
                <View style={styles.stepTarget}>
                  <Led tone="dim">{step.target}</Led>
                </View>
              </View>
            ))
          )}
        </View>
      </Animated.View>
    </Animated.View>
  );
}

export const Ticker = memo(TickerView);

const styles = StyleSheet.create({
  strip: {
    height: STRIP,
    marginHorizontal: theme.gutter,
    marginBottom: theme.space(2),
    borderRadius: STRIP / 2,
    overflow: "hidden",
    backgroundColor: theme.stage.strip,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(2),
    paddingLeft: theme.space(1),
    paddingRight: theme.space(3),
  },
  // The globe fills ~60% of its box; overhang instead of growing the strip.
  tappy: { marginVertical: -(TAPPY - STRIP) / 2 - 2 },
  marquee: { flex: 1, overflow: "hidden" },
  // Wide enough that the measured child keeps its natural one-line width.
  marqueeRun: { flexDirection: "row", width: 4000 },
  // Directly under the strip, over whatever is beneath it, on the canvas
  // colour with the strip's own rounding so it reads as the strip unfolding.
  drop: {
    position: "absolute",
    top: STRIP,
    left: theme.gutter,
    right: theme.gutter,
    zIndex: 10,
    overflow: "hidden",
    backgroundColor: theme.stage.strip,
    borderBottomLeftRadius: theme.radius.lg,
    borderBottomRightRadius: theme.radius.lg,
    shadowColor: "#000",
    shadowOpacity: 0.5,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 10 },
  },
  list: { position: "absolute", left: 0, right: 0, top: 0, gap: theme.space(2), paddingHorizontal: theme.space(3), paddingTop: theme.space(3), paddingBottom: theme.space(3) },
  step: { flexDirection: "row", alignItems: "center", gap: theme.space(2) },
  stepMark: { width: 16, alignItems: "center" },
  stepTarget: { flex: 1 },
  // On the thread's rail like the replies above it: the list's footer spans
  // the full width, so the row carries the gutter itself (the receipt it
  // replaced did too; without it the LED line ran off the left edge).
  receipt: { marginTop: theme.space(5), paddingHorizontal: theme.gutter, flexDirection: "row", alignItems: "center", gap: theme.space(2), overflow: "hidden" },
});

/** Per character of the receipt's type-on. */
const TYPE_MS = 28;

/** The finished turn under the thread, typed on left to right the first time. */
function LedReceiptView({ receipt }: { receipt: TurnReceipt }) {
  const reduced = useReducedMotion();
  const height = useStatusRowHeight();
  const parts = useMemo(() => receiptParts(receipt), [receipt]);
  const total = receiptLength(parts);
  const [shown, setShown] = useState(reduced ? total : 0);
  useEffect(() => {
    if (reduced) {
      setShown(total);
      return;
    }
    setShown(0);
    const timer = setInterval(() => {
      setShown((n) => {
        if (n + 1 >= total) clearInterval(timer);
        return Math.min(total, n + 1);
      });
    }, TYPE_MS);
    return () => clearInterval(timer);
  }, [parts, total, reduced]);
  return (
    <View style={[styles.receipt, { height }]} accessible accessibilityLabel={receiptText(receipt)}>
      {revealParts(parts, shown).map((part, i) => (
        <Led key={i} tone={part.tone}>{part.text}</Led>
      ))}
    </View>
  );
}

export const LedReceipt = memo(LedReceiptView);
