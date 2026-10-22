/**
 * The last step of first launch, over the main screen: go and type `claude`.
 *
 * This is the moment the product makes sense or doesn't. Everything before it
 * is plumbing; here the person does the one thing Tappy is built around — use
 * their agent in their own terminal, as always — and watches the phone answer.
 * So it waits live on the computer's terminal list, and the instant a terminal
 * registers it says so and steps aside; the main screen's auto-follow then
 * opens that very conversation.
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
import { DotGrid } from "./stage/DotGrid";
import { Led } from "./stage/Led";
import { tappyInk } from "../tappy/palette";
import { commandsToTry } from "../onboarding";

const TAPPY_CORAL = tappyInk();
/** Long enough to read "Found it", short enough not to make anyone wait. */
const FOUND_HOLD_MS = 1400;

interface Props {
  online: boolean;
  providers: readonly { id: string; available?: boolean }[];
  /** The computer's open agent terminals; the first to appear ends this step. */
  terminals: readonly { id: string; agent: string; folder: string }[];
  terminalsKnown: boolean;
  onDone: () => void;
}

const NAMES: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  ggcoder: "GG Coder",
};

export function TryItOverlay({ online, providers, terminals, terminalsKnown, onDone }: Props) {
  const insets = useSafeAreaInsets();
  const reduce = useReducedMotion();
  const commands = commandsToTry(providers);
  const found = terminalsKnown ? terminals[0] : undefined;
  const [celebrated, setCelebrated] = useState(false);

  useEffect(() => {
    if (!found || celebrated) return;
    setCelebrated(true);
    haptics.finished();
    const t = setTimeout(onDone, FOUND_HOLD_MS);
    return () => clearTimeout(t);
  }, [found, celebrated, onDone]);

  // The waiting line breathes, so it reads as listening rather than stuck.
  const pulse = useSharedValue(1);
  useEffect(() => {
    if (reduce || found) {
      pulse.value = 1;
      return;
    }
    pulse.value = withRepeat(
      withSequence(withTiming(0.35, { duration: 800 }), withTiming(1, { duration: 800 })),
      -1,
    );
  }, [reduce, found, pulse]);
  const pulseStyle = useAnimatedStyle(() => ({ opacity: pulse.value }));

  return (
    <View style={styles.root} accessibilityViewIsModal>
      <DotGrid />
      <View style={[styles.skipRow, { paddingTop: insets.top + theme.space(2) }]}>
        {!found ? (
          <Pressable
            onPress={onDone}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Skip, I'll try it later"
          >
            <Led tone="dim">Skip</Led>
          </Pressable>
        ) : null}
      </View>

      <View style={styles.centre}>
        <Tappy
          size={180}
          mood={found ? "happy" : "idle"}
          accessibilityLabel="Tappy"
          style={styles.tappy}
        />
        <Led color={found ? theme.color.success : TAPPY_CORAL}>
          {found ? "Found it" : "Last step"}
        </Led>
        <Text style={styles.title} accessibilityRole="header">
          {found ? `${NAMES[found.agent] ?? "Your agent"} in ${found.folder}` : "Try it now"}
        </Text>
        {found ? (
          <Text style={styles.body}>Everything you do in that terminal shows up here.</Text>
        ) : (
          <>
            <Text style={styles.body}>
              On your computer, open a new terminal in any project and type
              {commands.length > 1 ? " one of these" : ""}, just like always:
            </Text>
            <View style={styles.commands}>
              {commands.map((c) => (
                <View
                  key={c.command}
                  style={styles.commandPill}
                  accessibilityLabel={`${c.command}, for ${c.name}`}
                >
                  <Text style={styles.prompt}>›</Text>
                  <Text style={styles.command}>{c.command}</Text>
                </View>
              ))}
            </View>
          </>
        )}
      </View>

      <View
        style={[styles.status, { paddingBottom: insets.bottom + theme.space(10) }]}
        accessibilityLiveRegion="polite"
      >
        {!found ? (
          <Animated.View style={pulseStyle}>
            <Led tone="dim">
              {online ? "Waiting for a terminal" : "Connecting to your computer"}
            </Led>
          </Animated.View>
        ) : null}
        {!found ? (
          <Text style={styles.hint}>
            Use a new terminal tab: ones already open before setup aren&apos;t connected.
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { ...StyleSheet.absoluteFillObject, backgroundColor: theme.color.bg, zIndex: 100 },
  skipRow: {
    minHeight: theme.size.touch,
    alignItems: "flex-end",
    justifyContent: "center",
    paddingHorizontal: theme.gutter,
  },
  centre: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.gutter,
    gap: theme.space(3),
  },
  tappy: { marginBottom: -theme.space(4) },
  title: {
    color: theme.color.text,
    fontFamily: theme.display.regular,
    fontSize: 28,
    letterSpacing: 0.5,
    textAlign: "center",
  },
  body: {
    color: theme.color.textDim,
    fontSize: 15,
    lineHeight: 22,
    textAlign: "center",
    maxWidth: 340,
  },
  commands: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: theme.space(2),
    marginTop: theme.space(2),
  },
  commandPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(2),
    paddingHorizontal: theme.space(4),
    minHeight: theme.size.touch,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.color.border,
    backgroundColor: theme.color.surface,
  },
  prompt: { color: TAPPY_CORAL, fontFamily: "Menlo", fontSize: 16 },
  command: { color: theme.color.text, fontFamily: "Menlo", fontSize: 16 },
  status: { alignItems: "center", paddingHorizontal: theme.gutter, gap: theme.space(3) },
  hint: {
    color: theme.color.textFaint,
    fontSize: 13,
    lineHeight: 19,
    textAlign: "center",
    maxWidth: 320,
  },
});
