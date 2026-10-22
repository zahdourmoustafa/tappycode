/**
 * What the agent is doing, right now, in one line.
 *
 * The transcript's footer used to be three fading dots: honest, but it says
 * only "something is happening" for what can be minutes of work on a machine
 * the user cannot see. The agent already reports every tool it calls, so this
 * names the current one instead — and lights it with a travelling gradient,
 * which is what separates "still working" from a line that has stalled.
 *
 * It is deliberately one row at the transcript's left rail, exactly where the
 * reply will begin: the answer lands where the activity was, so nothing shifts
 * when the work turns into text. And it exits the moment the turn is over —
 * `ui/TurnReceipt.tsx` takes its place with what actually happened.
 */
import { memo, useEffect, useRef } from "react";
import { Animated, StyleSheet, Text } from "react-native";
import { theme } from "../theme";
import { currentTool, queuedTools, type Activity } from "../activity";
import { ShimmerText } from "./ShimmerText";
import { Tappy } from "../tappy/Tappy";
import { activityMood } from "../tappy/palette";
import { activityOrbState } from "../activityOrb";
import { Dissolve } from "./motion/Dissolve";
import { useReducedMotion } from "./useReducedMotion";
import { STATUS_ROW_MAX_FONT_SCALE } from "./statusRow";
import { useStatusRowHeight } from "./useStatusRowHeight";

/** Continuous, and slower than the composer's badge: this runs for minutes. */
const SWEEP_DURATION = 2200;

/** Crossfade when the agent moves to the next tool. Fast enough to feel live. */
const SWAP_DURATION = 160;

/** Where a swap fades from. Never to zero: the row must not appear to blink out. */
const SWAP_FROM = 0.35;

function ActivityLineView({ activity, color }: { activity: Activity; color?: string }) {
  const tool = currentTool(activity);
  const queued = queuedTools(activity);
  const reduceMotion = useReducedMotion();
  const height = useStatusRowHeight();

  const fade = useRef(new Animated.Value(1)).current;
  // The row is one component reused across tools rather than one per tool, so
  // the swap is animated here instead of by mounting: remounting would restart
  // the sheen mid-sweep and read as a stutter.
  const shown = useRef<string | undefined>(tool?.id);
  useEffect(() => {
    if (reduceMotion) {
      fade.stopAnimation();
      fade.setValue(1);
      shown.current = tool?.id;
      return;
    }
    if (tool?.id === shown.current) return;
    shown.current = tool?.id;
    fade.setValue(SWAP_FROM);
    Animated.timing(fade, {
      toValue: 1,
      duration: SWAP_DURATION,
      useNativeDriver: true,
    }).start();
    return () => fade.stopAnimation();
  }, [fade, reduceMotion, tool?.id]);

  const title = tool?.title?.trim() || "Working";
  const orbState = activityOrbState(activity);

  return (
    <Animated.View
      style={[styles.row, { height, opacity: fade }]}
      // Grouped into one node, and announced when it changes rather than
      // stealing focus: this is progress, not something to act on.
      accessible
      accessibilityLiveRegion="polite"
      accessibilityLabel={queued > 0 ? `${title}, and ${queued} more` : title}
    >
      {/* Tappy at work, in the agent's colour: talking while it writes,
          busy on a tool, otherwise thinking. */}
      <Tappy size={28} mood={activityMood(orbState)} color={color} style={styles.tappy} />
      {/* The label dissolves in place on a tool change; the row stays mounted so
          ShimmerText's sweep never restarts. */}
      <Dissolve kind="swap" dissolveKey={tool?.id ?? "working"} style={styles.label}>
        <ShimmerText
          text={title}
          color={theme.color.textDim}
          size={theme.font.small}
          lineHeight={theme.line.body}
          weight="500"
          duration={SWEEP_DURATION}
          numberOfLines={1}
          // Capped at exactly what the row height stops at: the two scale
          // together, so large text grows the line instead of clipping in it.
          maxFontSizeMultiplier={STATUS_ROW_MAX_FONT_SCALE}
        />
      </Dissolve>
      {/* Agents run tools in parallel. Naming one and counting the rest keeps
          the line a single readable row instead of a scrolling log. */}
      {queued > 0 && (
        <Text style={styles.queued} maxFontSizeMultiplier={STATUS_ROW_MAX_FONT_SCALE}>
          +{queued}
        </Text>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  // Tappy's globe fills the middle of its box; the rest is room to bounce,
  // so the box overhangs the old icon's footprint instead of growing the row.
  tappy: { margin: -4 },
  // Mirrors `ChatThread`'s dot row so replacing one with the other never moves
  // the transcript, horizontally or vertically.
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(1.5),
    marginTop: theme.space(5),
    paddingHorizontal: theme.gutter,
  },
  // Shrinks so a long tool title truncates instead of pushing the count off the
  // edge of the screen.
  label: { flexShrink: 1 },
  queued: {
    fontSize: theme.font.tiny,
    fontWeight: "600",
    color: theme.color.textFaint,
  },
});

export const ActivityLine = memo(ActivityLineView);
