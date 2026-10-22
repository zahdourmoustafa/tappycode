/**
 * Dev-only visual harness for the redesign: the screens the user actually sees,
 * with no daemon, pairing or network. `EXPO_PUBLIC_SHOWCASE` picks the view at
 * bundle time: `home` (empty state), `chat` (a working conversation with an
 * error card), `stream` (a reply streaming in), `ask` (an ask_user sheet with
 * long questions and a recommended option, for the pill and the scroll rail),
 * `goal` (the New goal wizard; `EXPO_PUBLIC_DEV_GOAL_STEP` picks the step, and
 * `EXPO_PUBLIC_DEV_LAUNCH_DEMO=1` on the launch step holds Ken by itself),
 * `think` (the model sheet, stepping the thinking level up and back down by itself).
 *
 *   EXPO_PUBLIC_HARNESS=Showcase EXPO_PUBLIC_SHOWCASE=chat npx expo start
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import * as SplashScreen from "expo-splash-screen";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { theme } from "../theme";
import type { Activity } from "../activity";
import { ChatThread, type ChatThreadRef } from "./ChatThread";
import { ComposerDock } from "./ComposerDock";
import { HomeGreeting } from "./HomeGreeting";
import { GgControlStrip, PlanReviewSheet } from "./GgReview";
import { QueuedStrip } from "./QueuedStrip";
import { AskUserSheet } from "./AskUserSheet";
import { NewGoalSheet } from "./NewGoalSheet";
import { ConfigPicker } from "./ConfigPicker";
import type { ConfigOption } from "../useDaemon";
import type { AskRequest } from "../askUser";
import type { GoalResult, GoalSummary } from "../ggState";
import type { Turn } from "../useDaemon";

const VIEW = process.env.EXPO_PUBLIC_SHOWCASE ?? "chat";

const REPLY =
  "I traced the reconnect bug to `cursors.ts`: replay overlapped the live stream, so " +
  "the newest chunk was folded twice.\n\n- Dropped events at or below the cursor\n- Kept " +
  "`session.idle` unfiltered\n\nTests pass. Want me to open the diff?";

const TURNS: Turn[] = [
  { id: "u1", role: "user", text: "Why does the phone show duplicated text after reconnecting?" },
  { id: "a1", role: "agent", text: REPLY },
  { id: "u2", role: "user", text: "Yes, and run the e2e check too." },
  { id: "s1", role: "system", text: "The agent stopped: `e2e-check.mjs` needs a running daemon." },
  { id: "u3", role: "user", text: "Start it and try again." },
];

/** The `review` view: Autopilot, plan markers and the plan sheet. */
const REVIEW_TURNS: Turn[] = [
  { id: "r-u1", role: "user", text: "Add a /health endpoint to the relay and cover it with a test." },
  { id: "r-n1", role: "note", text: "Plan accepted · fresh context · 3 steps" },
  { id: "r-a1", role: "agent", text: "Added `GET /health` in `relay/src/index.ts` and a test in `admission.test.ts`. All 1,296 tests pass." },
  { id: "r-k1", role: "ken", text: "The endpoint has no test for the not-paired case. Add one, then run the relay tests.", ken: { phase: "prompted", round: 1 } },
  { id: "r-a2", role: "agent", text: "Added the unpaired case; `bun test packages/relay` passes (8 tests)." },
  { id: "r-k2", role: "ken", text: "Looks done: endpoint, both cases tested, suite green.", ken: { phase: "done" } },
];

const PLAN = {
  planPath: "/tmp/plan.md",
  generation: 2,
  content:
    "# Plan: queue strip polish\n\n1. Show the first line of a single queued message with a cancel button\n" +
    "2. Collapse several into a count that expands\n3. Dissolve rows in and out\n\n" +
    "Verification: `bun test ./packages/app/src` and a simulator screenshot.",
};

const ASK: AskRequest = {
  requestId: "ask-1",
  questions: [
    {
      id: "store",
      kind: "choice",
      question: "Where should the queued messages live while the phone is offline and the daemon restarts in between?",
      options: [
        { label: "In the daemon's session log, replayed to every client that reconnects", hint: "Survives a restart and shows on the desktop too.", recommended: true },
        { label: "Only on the phone, in the outbox, until the socket is back", hint: "Simplest, but the desktop never sees them." },
        { label: "Both, deduplicated by message id when they meet" },
      ],
    },
    {
      id: "motion",
      kind: "multi",
      question: "Which surfaces should use the dissolve animation when their content changes?",
      options: [
        { label: "Streaming replies" },
        { label: "Sheets and pickers as rows arrive", recommended: true },
        { label: "Status pills and the ticker under the chat title" },
      ],
    },
  ],
};

const LEVELS = ["off", "low", "medium", "high", "max"];
const thinkOptions = (level: number): ConfigOption[] => [
  { id: "model", name: "Model", category: "model", type: "select", currentValue: "opus", options: [{ value: "opus", name: "Claude Opus 4.5" }, { value: "sonnet", name: "Claude Sonnet 4.5" }] },
  { id: "thinking", name: "Thinking", category: "thought_level", type: "select", currentValue: LEVELS[level]!, options: LEVELS.map((v) => ({ value: v, name: v[0]!.toUpperCase() + v.slice(1) })) },
];
/** Up to the top, then back down: 1 2 3 4 3 2 1 0 … */
const THINK_PATH = [1, 2, 3, 4, 4, 3, 2, 1, 0, 0];

const DEMO_GOAL: GoalSummary = {
  id: "g1",
  name: "Tappy polish",
  goal: "Make every screen feel alive.",
  context: [],
  path: "/tmp/tappy-polish",
  createdAt: "2026-10-14T00:00:00Z",
  lastActiveMs: 0,
  status: "briefing",
};

const WORKING: Activity = {
  startedAt: 0,
  speaking: false,
  tools: [{ id: "t1", title: "Running bun run packages/daemon/src/server.ts", kind: "execute", status: "in_progress" }],
};

function Screen() {
  const insets = useSafeAreaInsets();
  const list = useRef<ChatThreadRef>(null);
  const noop = useCallback(() => {}, []);
  const send = useCallback(() => true, []);
  const [streamed, setStreamed] = useState(VIEW === "stream" ? 0 : REPLY.length);
  // The `goal` view's launch: a create answered after a short wait, then the
  // goal's conversation behind the sheet, "Starting" as in the app.
  const [goalOpen, setGoalOpen] = useState(true);
  const [thinkStep, setThinkStep] = useState(-1);
  // A tap takes over from the automatic run, answered after a realistic delay
  // (the agent's round trip), so the dial's own instant response shows.
  const [thinkPicked, setThinkPicked] = useState<number>();
  useEffect(() => {
    if (VIEW !== "think" || thinkPicked !== undefined) return;
    const timer = setInterval(() => setThinkStep((n) => (n + 1) % THINK_PATH.length), 1100);
    return () => clearInterval(timer);
  }, [thinkPicked]);
  const pickThink = useCallback((_id: string, value: string | boolean) => {
    const at = LEVELS.indexOf(String(value));
    setTimeout(() => setThinkPicked(at), 450);
  }, []);
  const [goalStarted, setGoalStarted] = useState(false);
  const [goalResults, setGoalResults] = useState<Record<string, GoalResult>>({});
  const createGoal = useCallback(() => {
    setTimeout(() => setGoalResults({ g1: { t: "goal.result", requestId: "g1", ok: true, goal: DEMO_GOAL } }), 700);
    return "g1";
  }, []);

  useEffect(() => {
    if (VIEW !== "stream") return;
    // Loops (pausing at the end) so the fade can be watched and captured.
    const timer = setInterval(() => setStreamed((n) => (n >= REPLY.length + 40 ? 0 : n + 6)), 60);
    return () => clearInterval(timer);
  }, []);

  // `EXPO_PUBLIC_SHOWCASE_TOP=1`: jump to the very top after layout, which is
  // where any slack above a short thread would show as a blank band.
  useEffect(() => {
    if (process.env.EXPO_PUBLIC_SHOWCASE_TOP !== "1") return;
    const timer = setTimeout(() => {
      list.current?.scrollToOffset({ offset: 0, animated: false });
    }, 2500);
    return () => clearTimeout(timer);
  }, []);

  // Measured, as App.tsx does: the composer plus whatever strips ride on it.
  const [measured, setMeasured] = useState(0);
  const dock = measured || theme.size.composerResting + theme.space(4) + insets.bottom;
  const turns =
    VIEW === "stream"
      ? [TURNS[0] as Turn, { id: "a1", role: "agent", text: REPLY.slice(0, Math.min(REPLY.length, streamed)) } as Turn]
      : VIEW === "review" || VIEW === "plan"
        ? REVIEW_TURNS
        : TURNS;

  return (
    <View style={styles.screen}>
      <StatusBar style="light" />
      {VIEW === "home" ? (
        <View style={[styles.home, { paddingBottom: dock }]}>
          <HomeGreeting providerId="ggcoder" busy={false} text="What are we building today?" />
        </View>
      ) : (
        <ChatThread
          ref={list}
          turns={goalStarted ? [] : turns}
          restore={goalStarted ? { title: DEMO_GOAL.name, state: "starting", onRetry: noop } : undefined}
          activeStream={VIEW === "stream" ? { sessionId: "s", turnKey: "a1", generation: 0 } : undefined}
          threadTop={insets.top + theme.space(4)}
          threadBottom={dock + theme.space(2)}
          working={VIEW === "chat"}
          activity={WORKING}
          indicatorTop={insets.top}
          indicatorBottom={dock}
          onAtBottomChange={noop}
          onOpenThought={noop}
          onRetry={noop}
        />
      )}
      {VIEW === "ask" && <AskUserSheet ask={ASK} onAnswer={noop} />}
      {VIEW === "think" && (
        <ConfigPicker visible onClose={noop} options={thinkOptions(thinkPicked ?? (thinkStep < 0 ? 0 : THINK_PATH[thinkStep]!))} onSelect={pickThink} />
      )}
      {VIEW === "goal" && (
        <NewGoalSheet
          visible={goalOpen}
          onClose={() => setGoalOpen(false)}
          onCreate={createGoal}
          results={goalResults}
          onCreated={() => setGoalStarted(true)}
          onBrowse={noop}
          online={false}
        />
      )}
      {VIEW === "plan" && <PlanReviewSheet plan={PLAN} busy={false} onDecide={noop} />}
      <View style={styles.bottom} onLayout={(e) => setMeasured(Math.round(e.nativeEvent.layout.height))}>
      {(VIEW === "review" || VIEW === "plan") && (
        <View style={styles.strips}>
          <GgControlStrip
            planMode={false}
            autopilot={{ enabled: true, reviewing: VIEW === "review" }}
            showAutopilot
            showChecklist
            onToggleAutopilot={noop}
            onOpenChecklist={noop}
          />
          <QueuedStrip messages={[{ id: "q1", text: "Also bump the relay version when you're done" }]} onCancel={noop} />
        </View>
      )}
      <ComposerDock
        style={[styles.dock, { paddingBottom: insets.bottom + theme.space(2) }]}
        onHeightSettled={noop}
        typing={false}
        showCommands={false}
        onCommands={noop}
        onProjectDetails={noop}
        onSend={send}
        editable
        placeholder="Ask GG Coder anything"
        attachments={[]}
        onAttach={noop}
        onRemoveAttachment={noop}
        dictation={{ available: true, listening: false, toggle: noop, cancel: noop }}
      />
      </View>
    </View>
  );
}

export default function ShowcaseHarness() {
  useEffect(() => {
    SplashScreen.hideAsync().catch(() => undefined);
  }, []);
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardProvider>
        <SafeAreaProvider>
          <Screen />
        </SafeAreaProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.color.bg },
  home: { flex: 1, justifyContent: "center" },
  strips: { paddingTop: theme.space(2) },
  bottom: { position: "absolute", left: 0, right: 0, bottom: 0, backgroundColor: theme.color.bg },
  dock: { paddingHorizontal: theme.gutter, paddingTop: theme.space(2) },
});
