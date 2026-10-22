/**
 * Messages waiting for the running turn, above the composer — Stage "Packets".
 *
 * A sleeping Tappy, a dotted wire, and one glowing packet per queued message
 * bobbing on it. Tap a packet to cancel that message (it shrinks away). When
 * the queue empties on its own — the agent took them — the packets fly off
 * the right end of the wire before the row collapses.
 *
 * A cancel by tap is remembered so the last packet being cancelled reads as a
 * cancel, not a delivery. Reduce Motion: no bob, no fly; the row just goes.
 */
import { memo, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { theme } from "../theme";
import { haptics } from "./haptics";
import { useReducedMotion } from "./useReducedMotion";
import { queuePreview, type QueuedMessage } from "../queue";
import { Tappy } from "../tappy/Tappy";
import { DashedRule } from "./stage/DashedRule";
import { useAgentColor } from "./stage/agentColor";
import { withAlpha } from "../motion";

const EMPTY: readonly QueuedMessage[] = [];
const CANCEL_MS = 180;
const FLY_MS = 360;
const FLY_STAGGER = 60;
const PACKET = 10;

interface QueuedStripProps {
  messages?: readonly QueuedMessage[];
  onCancel: (id: string) => void;
}

function QueuedStripView({ messages = EMPTY, onCancel }: QueuedStripProps) {
  const reduceMotion = useReducedMotion();
  const agent = useAgentColor();
  const [shown, setShown] = useState<readonly QueuedMessage[]>(messages);
  const [flying, setFlying] = useState(false);
  const cancelled = useRef(false);

  useEffect(() => {
    if (messages.length > 0) {
      cancelled.current = false;
      setFlying(false);
      setShown(messages);
      return;
    }
    if (reduceMotion || cancelled.current) {
      cancelled.current = false;
      setShown(EMPTY);
      return;
    }
    // Delivered: the packets leave down the wire, then the row goes.
    haptics.sent();
    setFlying(true);
    const timer = setTimeout(() => {
      setFlying(false);
      setShown(EMPTY);
    }, FLY_MS + FLY_STAGGER * 4);
    return () => clearTimeout(timer);
  }, [messages, reduceMotion]);

  const current = messages.length > 0 ? messages : shown;
  if (current.length === 0) return null;
  const leaving = messages.length === 0;

  return (
    <View
      style={styles.strip}
      pointerEvents={leaving ? "none" : "auto"}
      accessibilityElementsHidden={leaving}
      accessibilityLiveRegion="polite"
    >
      <Tappy size={32} mood="sleepy" color={agent} paused={reduceMotion} style={styles.tappy} />
      <View style={styles.wire}>
        <DashedRule />
        <View style={styles.packets}>
          {current.map((message, index) => (
            <Packet
              key={message.id}
              message={message}
              index={index}
              color={agent}
              flying={flying}
              still={reduceMotion}
              onCancel={(id) => {
                if (current.length === 1) cancelled.current = true;
                onCancel(id);
              }}
            />
          ))}
        </View>
      </View>
    </View>
  );
}

function Packet({
  message,
  index,
  color,
  flying,
  still,
  onCancel,
}: {
  message: QueuedMessage;
  index: number;
  color: string;
  flying: boolean;
  still: boolean;
  onCancel: (id: string) => void;
}) {
  const bob = useSharedValue(0);
  const scale = useSharedValue(1);
  const opacity = useSharedValue(1);
  const fly = useSharedValue(0);
  const [gone, setGone] = useState(false);

  useEffect(() => {
    if (still) {
      cancelAnimation(bob);
      bob.value = 0;
      return;
    }
    const ease = Easing.inOut(Easing.sin);
    bob.value = withDelay(
      index * 140,
      withRepeat(withSequence(withTiming(-3, { duration: 600, easing: ease }), withTiming(0, { duration: 600, easing: ease })), -1),
    );
    return () => cancelAnimation(bob);
  }, [still, index, bob]);

  useEffect(() => {
    if (!flying || still) return;
    const delay = index * FLY_STAGGER;
    fly.value = withDelay(delay, withTiming(320, { duration: FLY_MS, easing: Easing.in(Easing.cubic) }));
    opacity.value = withDelay(delay, withTiming(0, { duration: FLY_MS }));
  }, [flying, still, index, fly, opacity]);

  const style = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateX: fly.value }, { translateY: bob.value }, { scale: scale.value }],
  }));

  const cancel = () => {
    if (gone) return;
    setGone(true);
    haptics.warned();
    if (still) {
      onCancel(message.id);
      return;
    }
    scale.value = withTiming(0.2, { duration: CANCEL_MS, easing: Easing.out(Easing.quad) });
    opacity.value = withTiming(0, { duration: CANCEL_MS });
    setTimeout(() => onCancel(message.id), CANCEL_MS);
  };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Cancel: ${queuePreview(message.text)}`}
      hitSlop={12}
      onPress={cancel}
      style={styles.hit}
    >
      <Animated.View
        style={[
          styles.packet,
          { backgroundColor: color, shadowColor: color, borderColor: withAlpha(color, 0.5) },
          style,
        ]}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  strip: {
    marginHorizontal: theme.gutter,
    marginBottom: theme.space(2),
    height: theme.space(8),
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(2),
  },
  // The globe fills ~60% of its box; pull the box in so the row stays tight.
  tappy: { marginVertical: -theme.space(1) },
  wire: { flex: 1, justifyContent: "center", overflow: "hidden" },
  packets: {
    ...StyleSheet.absoluteFillObject,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(3),
    paddingLeft: theme.space(2),
  },
  hit: { width: PACKET + 8, height: PACKET + 8, alignItems: "center", justifyContent: "center" },
  packet: {
    width: PACKET,
    height: PACKET,
    borderRadius: 2,
    borderWidth: 1,
    shadowOpacity: 0.8,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 0 },
  },
});

export const QueuedStrip = memo(QueuedStripView);
