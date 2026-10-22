/**
 * First launch: "Wake up".
 *
 * A sleeping Tappy on the dot grid. Tapping it pokes it awake and the greeting
 * and the one useful action rise in. Nobody is stuck behind the poke: a quiet
 * "Skip" connects straight away, and the action appears on its own after a
 * few seconds.
 */
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { theme } from "../theme";
import { haptics } from "./haptics";
import { Tappy } from "../tappy/Tappy";
import type { TappyMood } from "../tappy/engine";
import { StageButton } from "./stage/StageButton";
import { DotGrid } from "./stage/DotGrid";
import { Led } from "./stage/Led";
import { Dissolve } from "./motion/Dissolve";
import { tappyInk } from "../tappy/palette";

/** tappy's own coral: nobody has picked an agent yet. */
const TAPPY_CORAL = tappyInk();

interface Props {
  onConnect: () => void;
}

/** The action surfaces unprompted after this, so a non-tapper is never stuck. */
const AUTO_WAKE_MS = 6000;

export function LaunchScreen({ onConnect }: Props) {
  const insets = useSafeAreaInsets();
  const reduce = useReducedMotion();
  const [awake, setAwake] = useState(false);
  const [mood, setMood] = useState<TappyMood>("sleepy");

  // Blinking "Tap to wake" hint; held lit under Reduce Motion.
  const blink = useSharedValue(1);
  useEffect(() => {
    if (reduce || awake) {
      blink.value = 1;
      return;
    }
    blink.value = withRepeat(
      withSequence(withTiming(0.25, { duration: 700 }), withTiming(1, { duration: 700 })),
      -1,
    );
  }, [reduce, awake, blink]);
  const blinkStyle = useAnimatedStyle(() => ({ opacity: blink.value }));

  useEffect(() => {
    if (awake) return;
    const t = setTimeout(() => setAwake(true), AUTO_WAKE_MS);
    return () => clearTimeout(t);
  }, [awake]);

  useEffect(() => {
    if (mood !== "happy") return;
    const t = setTimeout(() => setMood("idle"), 2500);
    return () => clearTimeout(t);
  }, [mood]);

  const wake = () => {
    haptics.poke();
    setMood("happy");
    setAwake(true);
  };

  const connect = () => {
    haptics.tap();
    onConnect();
  };

  return (
    <View style={styles.root}>
      <DotGrid />
      <View style={[styles.skipRow, { paddingTop: insets.top + theme.space(2) }]}>
        {!awake ? (
          <Pressable
            onPress={connect}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Skip and connect your computer"
          >
            <Led tone="dim">Skip</Led>
          </Pressable>
        ) : null}
      </View>

      <View style={styles.centre}>
        <Tappy
          size={260}
          mood={mood}
          interactive
          onPress={awake ? () => haptics.poke() : wake}
          accessibilityLabel={awake ? "Tappy" : "Tappy is asleep. Tap to wake Tappy"}
          style={styles.tappy}
        />
        {!awake ? (
          <Animated.View style={blinkStyle}>
            <Led tone="dim">Tap to wake Tappy</Led>
          </Animated.View>
        ) : (
          <View style={styles.copy}>
            <Dissolve delay={0} enabled={!reduce}>
              <Text style={styles.title} numberOfLines={1} adjustsFontSizeToFit>
                Hi, I&apos;m Tappy.
              </Text>
            </Dissolve>
            <Dissolve delay={120} enabled={!reduce}>
              <Text style={styles.body} numberOfLines={2}>
                I bring your coding agent to your pocket.
              </Text>
            </Dissolve>
          </View>
        )}
      </View>

      <View style={[styles.actions, { paddingBottom: insets.bottom + theme.space(8) }]}>
        {awake ? (
          <Dissolve delay={240} enabled={!reduce}>
            {/* connect() plays the haptic. tappy's own coral: no agent yet. */}
            <StageButton color={TAPPY_CORAL} feel="none" label="Connect your computer" onPress={connect} />
          </Dissolve>
        ) : (
          <View style={styles.buttonSpace} />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.color.bg },
  skipRow: {
    minHeight: theme.size.touch,
    alignItems: "flex-end",
    justifyContent: "center",
    paddingHorizontal: theme.gutter,
  },
  centre: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: theme.gutter },
  // The globe fills ~60% of its box; pull the copy up under it.
  tappy: { marginBottom: -theme.space(10) },
  copy: { alignSelf: "stretch", alignItems: "center", gap: theme.space(2) },
  title: { color: theme.color.text, fontFamily: theme.display.regular, fontSize: 32, letterSpacing: 0.5 },
  body: { color: theme.color.textDim, fontSize: 15, lineHeight: theme.line.body, textAlign: "center" },
  actions: { paddingHorizontal: theme.gutter },
  button: { paddingVertical: theme.space(4), alignItems: "center", justifyContent: "center", minHeight: 56 },
  buttonSpace: { minHeight: 56 },
  buttonPressed: { backgroundColor: theme.glass.fillPressed },
  buttonText: { color: theme.color.text, fontSize: theme.font.title, fontWeight: "600" },
});
