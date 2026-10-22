/**
 * A GG Goals crew: one scrollable row of worker chips (small Tappy + LED name).
 * Tapping a chip selects it and shows a one-line tip: role · activity · time.
 */
import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { theme } from "../theme";
import { withAlpha } from "../motion";
import { Tappy } from "../tappy/Tappy";
import { roleColor, workerMood } from "../tappy/palette";
import { elapsedLabel, workerElapsed, type GoalWorker } from "../ggState";
import { Led } from "./stage/Led";
import { PressScale } from "./stage/PressScale";
import { dashedOutline } from "./stage/DashedRule";
import Reanimated, { FadeIn, FadeOut, LinearTransition, ZoomIn, ZoomOut } from "react-native-reanimated";
import { useReducedMotion } from "./useReducedMotion";
import { EASE_OUT } from "./motion/ease";
import { SPRING } from "../motion";

export interface CrewRowProps {
  workers: readonly GoalWorker[];
  onPressWorker?: (worker: GoalWorker) => void;
}

const isLive = (w: GoalWorker) => w.state === "starting" || w.state === "running";

/**
 * Only the workers doing something now. A finished, failed or closed worker
 * leaves the row (with an exit animation) instead of lingering on screen for
 * the rest of the goal; the row itself is gone when nobody is working.
 */
export function liveWorkers(workers: readonly GoalWorker[]): GoalWorker[] {
  return workers.filter(isLive);
}

export function CrewRow({ workers: all, onPressWorker }: CrewRowProps) {
  const workers = liveWorkers(all);
  const [selected, setSelected] = useState<string | undefined>();
  const [now, setNow] = useState(() => Date.now());
  const reduce = useReducedMotion();
  const picked = workers.find((w) => w.id === selected);

  // Tick the tip's clock only while it shows a live worker.
  useEffect(() => {
    if (!picked || !isLive(picked)) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [picked]);

  const tip = picked
    ? [picked.agent ?? "worker", picked.activity ?? picked.error ?? picked.state, elapsedLabel(workerElapsed(picked, now))]
        .filter(Boolean)
        .join(" · ")
    : undefined;

  if (workers.length === 0) return null;
  return (
    <Reanimated.View
      // The whole row arrives with the first worker and leaves with the last.
      entering={reduce ? undefined : FadeIn.duration(220)}
      exiting={reduce ? undefined : FadeOut.duration(200)}
    >
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
        {workers.map((w, i) => {
          const color = roleColor(w.agent ?? w.name);
          const live = isLive(w);
          const on = w.id === selected;
          return (
            <Reanimated.View
              key={w.id}
              // Arrives with a little spring, leaves by shrinking away, and the
              // chips beside it slide over to close the gap.
              entering={reduce ? undefined : ZoomIn.duration(SPRING.arrive.duration).easing(EASE_OUT).delay(Math.min(i, 4) * 40)}
              exiting={reduce ? undefined : ZoomOut.duration(220)}
              layout={reduce ? undefined : LinearTransition.duration(SPRING.settle.duration).easing(EASE_OUT)}
            >
              <PressScale
                feel="select"
                onPress={() => {
                  setNow(Date.now());
                  setSelected(on ? undefined : w.id);
                  onPressWorker?.(w);
                }}
                style={[
                  styles.chip,
                  live || on ? { borderStyle: "solid", borderColor: color } : null,
                  on ? { backgroundColor: withAlpha(color, 0.1) } : null,
                ]}
              >
                <View style={styles.tappy}>
                  <Tappy size={28} mood={workerMood(w.state)} color={color} paused={!live} />
                </View>
                <Led color={color} unlit={!live} style={styles.name}>
                  {w.name}
                </Led>
              </PressScale>
            </Reanimated.View>
          );
        })}
      </ScrollView>
      {tip && picked && (
        <Reanimated.View entering={reduce ? undefined : FadeIn.duration(180)} exiting={reduce ? undefined : FadeOut.duration(140)}>
          <Text style={styles.tip} numberOfLines={1}>
            {tip.toUpperCase()}
          </Text>
        </Reanimated.View>
      )}
    </Reanimated.View>
  );
}

const styles = StyleSheet.create({
  row: { paddingHorizontal: theme.gutter, gap: theme.space(2) },
  chip: {
    ...dashedOutline,
    flexDirection: "row",
    alignItems: "center",
    height: 32,
    borderRadius: 16,
    paddingLeft: theme.space(1),
    paddingRight: theme.space(3),
    gap: theme.space(1),
  },
  tappy: { width: 24, height: 24, alignItems: "center", justifyContent: "center", overflow: "visible" },
  name: { maxWidth: 140 },
  tip: { color: theme.color.textDim, fontSize: 12, marginTop: theme.space(2), paddingHorizontal: theme.gutter },
});
