/**
 * The main screen's nav: menu, title, the goal controls or new-conversation
 * button, the ticker and a goal's crew, over the frosted cover for its zone.
 */
import type { Dispatch, SetStateAction } from "react";
import { Text, View } from "react-native";
import type { EdgeInsets } from "react-native-safe-area-context";
import { theme } from "../theme";
import { styles } from "../appStyles";
import type { Provider, useDaemon } from "../useDaemon";
import type { useGoalControls } from "../useGoalControls";
import { CircleButton } from "./controls";
import { DotGlyph } from "./stage/DotGlyph";
import { Ticker } from "./Ticker";
import { CrewRow } from "./CrewRow";
import { CanvasCover } from "./CanvasCover";

export function ScreenTopBar({
  daemon,
  goals,
  insets,
  navHeight,
  setNavHeight,
  setMenuOpen,
  setNewChatOpen,
  sessionTitle,
  inThread,
  holdingRestore,
  active,
  terminal,
  terminalStep,
}: {
  daemon: ReturnType<typeof useDaemon>;
  goals: ReturnType<typeof useGoalControls>;
  insets: EdgeInsets;
  navHeight: number;
  setNavHeight: Dispatch<SetStateAction<number>>;
  setMenuOpen: Dispatch<SetStateAction<boolean>>;
  setNewChatOpen: Dispatch<SetStateAction<boolean>>;
  sessionTitle: string;
  inThread: boolean;
  holdingRestore: boolean;
  active: Provider | undefined;
  /**
   * The terminal the phone is following, when it is showing one rather than
   * one of its own chats; the bar then says what that terminal is doing.
   */
  terminal?: { activity?: string; folder: string; question?: { text: string } };
  /** That terminal's latest step, from its run in progress. */
  terminalStep?: string;
}) {
  const {
    inGoal,
    goalPaused,
    goalId,
    resumeGoal,
    pauseGoal,
    openGoalSettings,
    askHere,
    kenSays,
    goalState,
  } = goals;
  return (
    <>
      {/* Absolute over the thread: messages scroll beneath the nav and fade
          out under the CanvasCover instead of hitting a panel edge, so the
          conversation keeps the full screen height. */}
      <View
        style={[styles.topBarOverlay, { top: insets.top }]}
        onLayout={(e) => setNavHeight(e.nativeEvent.layout.height)}
      >
        <View style={styles.topBar}>
          <View style={inGoal && [styles.navActionsGoal, styles.navLeadGoal]}>
            <CircleButton
              label={`Open menu. Daemon ${daemon.status}.`}
              onPress={() => setMenuOpen(true)}
            >
              <DotGlyph name="menu" size={16} />
            </CircleButton>
            {/* Connection state as a dot on the menu button: always visible, but
              it never competes with the model name for space. */}
            {daemon.status !== "online" && (
              <View
                style={[
                  styles.statusDot,
                  {
                    backgroundColor:
                      daemon.status === "connecting" ? theme.color.accent : theme.color.danger,
                  },
                ]}
              />
            )}
          </View>

          <Text
            style={styles.sessionTitle}
            numberOfLines={1}
            ellipsizeMode="tail"
            accessibilityRole="header"
            accessibilityLabel={sessionTitle}
          >
            {sessionTitle}
          </Text>

          <View style={[styles.navAction, inGoal && styles.navActionsGoal]}>
            {inGoal ? (
              // A goal is one long conversation, so there is no "new conversation"
              // here: its two controls take the spot instead of a card over the thread.
              <>
                <CircleButton
                  label={goalPaused ? "Resume goal" : "Pause goal"}
                  disabled={!goalId}
                  onPress={goalPaused ? resumeGoal : pauseGoal}
                >
                  <DotGlyph name={goalPaused ? "play" : "pause"} size={14} />
                </CircleButton>
                <CircleButton label="Goal settings" disabled={!goalId} onPress={openGoalSettings}>
                  <DotGlyph name="gear" size={16} />
                </CircleButton>
              </>
            ) : (
              inThread && (
                // Asks where, rather than starting one immediately: the old behaviour
                // always landed wherever the agent happened to be, which is the wrong
                // project as often as the right one and was unfixable from the phone.
                <CircleButton label="New conversation" onPress={() => setNewChatOpen(true)}>
                  <DotGlyph name="compose" size={16} />
                </CircleButton>
              )
            )}
          </View>
        </View>
        {/* Not while a chat is reopening: that screen is Tappy alone, centred,
          and the ticker fades in with the messages once they've loaded. */}
        {(inThread || daemon.restoreTarget) &&
          !(
            daemon.restoreTarget &&
            daemon.loadingSession &&
            (daemon.turns.length === 0 || holdingRestore)
          ) && (
            <Ticker
              color={active?.color}
              working={(daemon.busy && !daemon.loadingSession) || terminal?.activity === "working"}
              activity={daemon.activity}
              step={terminal?.activity === "working" ? terminalStep : undefined}
              needs={
                daemon.permission
                  ? daemon.permission.title
                  : askHere
                    ? "Question"
                    : terminal?.activity === "waiting"
                      ? (terminal.question?.text ?? "Answer in the terminal")
                      : undefined
              }
              offline={daemon.status !== "online" || Boolean(daemon.unreachable)}
              project={terminal?.folder ?? daemon.workspace?.folder}
              changes={daemon.workspace?.uncommitted}
              say={kenSays?.text}
            />
          )}
        {/* A goal's crew: one slidable row of its workers under the ticker, each
          its own Tappy in its role colour. Inside the measured overlay, so the
          thread starts below it. */}
        {inGoal && goalState && !daemon.restoreTarget && <CrewRow workers={goalState.workers} />}
      </View>

      {/* Frosted cover for the nav zone only — it ends exactly at the nav's
          bottom edge and touches nothing below it. pointerEvents-none, so it
          never swallows a tap on a message or a pill. */}
      {navHeight > 0 && (
        <CanvasCover
          // From the very top edge to the nav's bottom edge. No tail.
          height={insets.top + navHeight}
          style={styles.navFade}
        />
      )}
    </>
  );
}
