/**
 * The pairing "Handshake": this phone's Tappy and the computer's Tappy, joined by
 * a dotted wire. Packets travel the wire while a pairing is checked; the wire
 * goes solid green when it lands, and the computer's Tappy wakes or says oops.
 */
import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { theme } from "../theme";
import { DashedRule } from "./stage/DashedRule";
import { withAlpha } from "../motion";
import { Tappy } from "../tappy/Tappy";
import { Led } from "./stage/Led";
import { haptics } from "./haptics";

export type HandshakePhase = "waiting" | "pairing" | "paired" | "failed";

const TAPPY = 104;
const PACKET = 6;

function Packet({ width, offset }: { width: SharedValue<number>; offset: number }) {
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withRepeat(withTiming(1, { duration: 1100, easing: Easing.inOut(Easing.quad) }), -1);
    return () => cancelAnimation(t);
  }, [t]);
  const style = useAnimatedStyle(() => {
    const p = (t.value + offset) % 1;
    return { transform: [{ translateX: p * Math.max(0, width.value - PACKET) }], opacity: Math.sin(p * Math.PI) };
  });
  return <Animated.View style={[styles.packet, style]} />;
}

interface Props {
  phase: HandshakePhase;
}

export function Handshake({ phase }: Props) {
  const reduce = useReducedMotion();
  const width = useSharedValue(0);
  const paired = phase === "paired";
  const failed = phase === "failed";

  return (
    <View style={styles.row}>
      <View style={styles.end}>
        <Tappy size={TAPPY} mood={paired ? "happy" : "idle"} interactive onPress={() => haptics.poke()} accessibilityLabel="This phone" style={styles.tappy} />
        <Led tone="dim">Phone</Led>
      </View>

      <View
        style={styles.wire}
        onLayout={(e) => {
          width.value = e.nativeEvent.layout.width;
        }}
      >
        {/* iOS can't draw a one-sided dotted border, so the waiting wire is a
            clipped dotted box and a paired one a solid glowing bar. */}
        {paired ? (
          <View style={styles.lineSolid} />
        ) : (
          <DashedRule dotted weight={2} color={failed ? withAlpha(theme.color.danger, 0.5) : theme.stage.dash} />
        )}
        {phase === "pairing" && !reduce ? (
          <>
            <Packet width={width} offset={0} />
            <Packet width={width} offset={0.5} />
          </>
        ) : null}
      </View>

      <View style={styles.end}>
        <Tappy
          size={TAPPY}
          mood={paired ? "happy" : failed ? "oops" : "sleepy"}
          color={paired ? theme.color.success : failed ? theme.color.danger : theme.color.textFaint}
          accessibilityLabel="Your computer"
          style={styles.tappy}
        />
        <Led tone="dim">Computer</Led>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", marginTop: theme.space(4) },
  end: { alignItems: "center", width: TAPPY },
  // The globe fills ~60% of its box, so its box already leaves air under it;
  // the label sits just below that with a little more.
  tappy: { marginBottom: theme.space(1) },
  wire: { flex: 1, height: PACKET, justifyContent: "center", marginBottom: theme.space(4) },
  lineSolid: {
    height: 2,
    borderRadius: 1,
    backgroundColor: theme.color.success,
    shadowColor: theme.color.success,
    shadowOpacity: 0.9,
    shadowRadius: theme.stage.glow,
    shadowOffset: { width: 0, height: 0 },
  },
  packet: {
    position: "absolute",
    left: 0,
    width: PACKET,
    height: PACKET,
    borderRadius: PACKET / 2,
    backgroundColor: theme.color.accent,
    shadowColor: theme.color.accent,
    shadowOpacity: 1,
    shadowRadius: theme.stage.glow,
    shadowOffset: { width: 0, height: 0 },
  },
});
