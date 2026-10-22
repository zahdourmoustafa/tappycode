/**
 * Context: a ring of dots lit up to the used fraction, Tappy in the middle.
 *
 * An agent that sends no `usage_update` gets an honest "no reading", never 0%.
 */
import { useEffect } from "react";
import { StyleSheet, Text, View } from "react-native";
import { StageScroll } from "./stage/StageScroll";
import { Canvas, Circle, Group, Path, Skia } from "@shopify/react-native-skia";
import { Easing, useDerivedValue, useReducedMotion, useSharedValue, withTiming } from "react-native-reanimated";
import { Sheet, SHEET_CARD_HEIGHT } from "./Sheet";
import { theme } from "../theme";
import { contextDetails } from "../contextDetails";
import { usagePercent, type ContextUsage } from "../contextUsage";
import type { Workspace } from "../useDaemon";
import { Tappy } from "../tappy/Tappy";
import { Led } from "./stage/Led";
import { DashedRule } from "./stage/DashedRule";
import { useAgentColor } from "./stage/agentColor";

const RING = 168;
const DOTS = 48;
const DOT_R = 3;
const RADIUS = RING / 2 - DOT_R * 2;
const POINTS = Array.from({ length: DOTS }, (_, i) => {
  const a = (i / DOTS) * Math.PI * 2 - Math.PI / 2;
  return { x: RING / 2 + Math.cos(a) * RADIUS, y: RING / 2 + Math.sin(a) * RADIUS };
});

function tokens(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(Math.round(n));
}

function DotRing({ fraction, color, visible }: { fraction: number; color: string; visible: boolean }) {
  const reduce = useReducedMotion();
  const lit = useSharedValue(0);
  useEffect(() => {
    const target = Math.round(fraction * DOTS);
    if (!visible) {
      lit.value = 0;
      return;
    }
    lit.value = reduce ? target : withTiming(target, { duration: 900, easing: Easing.out(Easing.cubic) });
  }, [fraction, visible, reduce, lit]);
  const path = useDerivedValue(() => {
    const p = Skia.Path.Make();
    const n = Math.floor(lit.value);
    for (let i = 0; i < n && i < DOTS; i++) {
      const pt = POINTS[i];
      if (pt) p.addCircle(pt.x, pt.y, DOT_R);
    }
    return p;
  });
  return (
    <Canvas style={styles.canvas}>
      <Group>
        {POINTS.map((pt, i) => (
          <Circle key={i} cx={pt.x} cy={pt.y} r={DOT_R} color={theme.stage.dash} />
        ))}
      </Group>
      <Path path={path} color={color} />
    </Canvas>
  );
}

export function ContextDetailsSheet({
  visible,
  workspace,
  usage,
  inConversation = true,
  onClose,
}: {
  visible: boolean;
  workspace?: Workspace;
  usage?: ContextUsage;
  /** A conversation is open. Without one there is nothing to measure yet, which is not the agent's fault. */
  inConversation?: boolean;
  onClose: () => void;
}) {
  const agent = useAgentColor();
  const details = contextDetails(workspace, usage);
  const percent = usage ? usagePercent(usage) : undefined;
  const mood = percent === undefined ? "sleepy" : percent < 60 ? "idle" : percent <= 85 ? "thinking" : "oops";
  // Three honest states: a reading; no conversation yet (home); and a
  // conversation whose agent has sent nothing (some agents never do).
  const title = percent !== undefined ? `${percent}% used` : inConversation ? "No reading yet" : "Nothing to measure yet";
  const sub = usage
    ? `${tokens(usage.used)} of ${tokens(usage.size)} tokens`
    : inConversation
      ? "Appears once the agent reports it."
      : "Starts with your first message.";
  const ringColor = percent !== undefined && percent > 85 ? theme.color.danger : agent;
  return (
    <Sheet visible={visible} label="Context" title={title} onClose={onClose} dismissLabel="Close context details">
      <StageScroll style={styles.scroll} contentContainerStyle={styles.content}>
        <Text style={styles.sub} numberOfLines={1} accessibilityLabel={details.usageAccessibility}>
          {sub}
        </Text>
        <View style={styles.ring}>
          <DotRing fraction={percent === undefined ? 0 : percent / 100} color={ringColor} visible={visible} />
          <View style={styles.center} pointerEvents="box-none">
            <Tappy size={88} mood={mood} color={agent} paused={!visible} accessibilityLabel={`Tappy, ${mood}`} />
          </View>
        </View>
        <DashedRule />
        <View style={styles.rows}>
          <View style={styles.row}>
            <Led tone="dim" size={10}>Project</Led>
            <Text selectable style={styles.value} numberOfLines={1}>{details.project}</Text>
          </View>
          <View style={styles.row}>
            <Led tone="dim" size={10}>Changes</Led>
            <Text style={styles.value} numberOfLines={1} accessibilityLabel={details.changesAccessibility}>{details.changes}</Text>
          </View>
          {usage && (
            <View style={styles.row}>
              <Led tone="dim" size={10}>Free</Led>
              <Text style={styles.value} numberOfLines={1}>{tokens(Math.max(0, usage.size - usage.used))}</Text>
            </View>
          )}
        </View>
      </StageScroll>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  scroll: { maxHeight: SHEET_CARD_HEIGHT + theme.space(20) },
  content: { gap: theme.space(4), paddingBottom: theme.space(2) },
  sub: { color: theme.color.textDim, fontSize: theme.font.small, lineHeight: 18 },
  ring: { alignSelf: "center", width: RING, height: RING },
  canvas: { width: RING, height: RING },
  center: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center" },
  rows: { gap: theme.space(3) },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: theme.space(4) },
  value: { flexShrink: 1, color: theme.color.text, fontSize: theme.font.body, textAlign: "right" },
});
