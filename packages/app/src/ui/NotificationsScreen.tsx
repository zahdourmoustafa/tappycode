/**
 * Asked once, right after pairing, with the reason first.
 *
 * The system's own prompt says only that the app "would like to send
 * notifications", and on iOS it can be shown exactly once. Saying what they are
 * for before it appears is what earns the yes: here they are the whole point of
 * leaving the phone in a pocket while an agent works.
 */
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { theme } from "../theme";
import { haptics } from "./haptics";
import { Tappy } from "../tappy/Tappy";
import { DotGrid } from "./stage/DotGrid";
import { Led } from "./stage/Led";
import { StageButton } from "./stage/StageButton";
import { tappyInk } from "../tappy/palette";
import { ensureNotificationPermission } from "./notifier";

const TAPPY_CORAL = tappyInk();

interface Props {
  /** Called with the answer, or false for "Not now". Never blocks: setup goes on either way. */
  onDone: (granted: boolean) => void;
  /** The paired computer's name, so the screen continues the one before it. */
  machine?: string;
}

export function NotificationsScreen({ onDone, machine }: Props) {
  const insets = useSafeAreaInsets();
  const [asking, setAsking] = useState(false);

  const allow = async () => {
    setAsking(true);
    const granted = await ensureNotificationPermission();
    if (granted) haptics.finished();
    onDone(granted);
  };

  return (
    <View style={styles.root}>
      <DotGrid />
      <View style={[styles.centre, { paddingTop: insets.top + theme.space(8) }]}>
        <Tappy size={200} mood="happy" accessibilityLabel="Tappy" style={styles.tappy} />
        <Led tone="plus">{machine ? `Connected · ${machine}` : "Connected"}</Led>
        <Text style={styles.title} accessibilityRole="header">
          Know when it&apos;s done
        </Text>
        <Text style={styles.body}>
          Put the phone away while your agent works. Tappy tells you when it finishes, or when it
          needs your answer.
        </Text>
      </View>
      <View style={[styles.actions, { paddingBottom: insets.bottom + theme.space(8) }]}>
        <StageButton
          color={TAPPY_CORAL}
          feel="none"
          disabled={asking}
          label="Turn on notifications"
          onPress={() => void allow()}
        />
        <Pressable
          onPress={() => onDone(false)}
          accessibilityRole="button"
          hitSlop={12}
          style={styles.later}
        >
          <Text style={styles.laterText}>Not now</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.color.bg },
  centre: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.gutter,
    gap: theme.space(3),
  },
  tappy: { marginBottom: -theme.space(6) },
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
  actions: { paddingHorizontal: theme.gutter, gap: theme.space(2) },
  later: { minHeight: theme.size.touch, alignItems: "center", justifyContent: "center" },
  laterText: { color: theme.color.textDim, fontSize: 15, fontWeight: "600" },
});
