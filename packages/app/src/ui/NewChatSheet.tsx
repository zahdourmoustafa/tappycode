/**
 * "New chat" — where?
 *
 * The button used to start a conversation the instant it was tapped, which
 * meant a new chat always landed wherever the agent happened to be. That is the
 * right guess most of the time and unfixable from the phone the rest of it: the
 * only way to work in another repo was to walk back to the desk.
 *
 * So it asks, in one tap either way. The first step names the project you are
 * already in, because continuing here is the common case and it should not cost
 * a list. The second step is that list, for the times it is not.
 *
 * A sheet rather than the drawer's dropdown: this is a decision that starts
 * something, taken from the conversation, and it belongs on the same bottom
 * edge as commands and approvals rather than behind a menu in another panel.
 *
 * There is a third step, and it is the one that makes a new agent usable at all.
 * The project list is folded from an agent's *own* past sessions, so an agent
 * installed five minutes ago offers nothing: no projects, no way to start, and
 * no way out of that state from the phone. Browsing asks the desktop what is on
 * its disk — suggested git checkouts first, then any directory — which is the
 * only thing that breaks that loop.
 *
 * The steps are a **push**, not a swap: each pane arrives from the right as the
 * one before it leaves to the left, and the card resizes under them. Every step
 * stays mounted so none has to be rebuilt mid-travel, and the hidden ones are
 * inert. A cut between two cards of different heights reads as the sheet
 * flinching; this reads as one object with somewhere to go.
 */
import { memo, useEffect, useMemo, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { StageScroll } from "./stage/StageScroll";
import Animated, {
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import Ionicons from "@expo/vector-icons/Ionicons";
import { theme } from "../theme";
import { Dissolve } from "./motion/Dissolve";
import { PressScale } from "./stage/PressScale";
import { StageButton } from "./stage/StageButton";
import { Led } from "./stage/Led";
import { dashedOutline } from "./stage/DashedRule";
import { useAgentColor } from "./stage/agentColor";
import { withAlpha } from "../motion";
import { touchSlop } from "./controls";
import { Sheet, SHEET_ROW_HEIGHT, SHEET_VISIBLE_ROWS, sheetCardStyle } from "./Sheet";
import { haptics } from "./haptics";
import { useReducedMotion } from "./useReducedMotion";
import type { Project } from "../projects";

/** The grid's last cell when browsing is possible. */
const BROWSE_CELL = { browse: true } as const;
type GridCell = Project | typeof BROWSE_CELL;
const isBrowse = (cell: GridCell): cell is typeof BROWSE_CELL => "browse" in cell;
const cellKey = (cell: GridCell) => (isBrowse(cell) ? "browse" : cell.path);
/** How many cards stagger in on open (about one screenful). */
const STAGGERED = 8;
import type { WorkspaceBrowse } from "../useDaemon";

/**
 * The push, tuned to sit just inside `Sheet`'s own arrival.
 *
 * Quicker than the sheet's travel: this is a pane moving *within* a card already
 * on screen, and matching the arrival would read as the whole thing being
 * re-presented. Slightly tighter damping than the sheet too — a horizontal
 * overshoot on a list of projects looks like a bounce rather than a push.
 */
const STEP_SPRING = { duration: 340, dampingRatio: 0.92 } as const;

/**
 * Which pane is on screen. Ordered, because moving between them is a push.
 *
 * Two, not three. The project list and the folder browser are both reached from
 * step one and both return to it, so they are siblings rather than a stack —
 * giving the browser its own index would mean the pop from it travelled *past*
 * the project list, flashing a pane the user was never on. `listMode` decides
 * which of the two the second step holds.
 */
const STEP_CHOICES = 0;
const STEP_LIST = 1;

interface NewChatSheetProps {
  visible: boolean;
  /** The project the open conversation is in. Absent until the daemon answers. */
  currentFolder?: string;
  currentCwd?: string;
  projects: Project[];
  /** Starts a conversation in `cwd`, or wherever the agent last was when absent. */
  onStart: (cwd?: string) => void;
  onClose: () => void;
  /** What the desktop last reported for the picker. Absent until first asked. */
  browse?: WorkspaceBrowse;
  /** Ask the desktop for a listing. No path means "suggest repositories". */
  onBrowse?: (path?: string) => void;
  /**
   * Open the agent in a terminal on the computer instead, in `cwd` — the window
   * shows up on the laptop and the phone follows it. Absent for an agent that
   * cannot be opened that way.
   */
  onStartOnComputer?: (cwd: string, bypass: boolean) => void;
  /** The agent's name, for the computer button: "Claude". */
  computerAgent?: string;
  /** Whether this agent has a skip-permissions switch to offer. */
  bypassOffered?: boolean;
}

function NewChatSheetView({
  visible,
  currentFolder,
  currentCwd,
  projects,
  onStart,
  onClose,
  browse,
  onBrowse,
  onStartOnComputer,
  computerAgent,
  bypassOffered,
}: NewChatSheetProps) {
  const [step, setStep] = useState(STEP_CHOICES);
  // Off every time the sheet opens: skipping approvals is a choice made per
  // window, never a setting that quietly carries over.
  const [bypass, setBypass] = useState(false);
  useEffect(() => {
    if (!visible) setBypass(false);
  }, [visible]);
  const reduceMotion = useReducedMotion();

  const agent = useAgentColor();
  const [picked, setPicked] = useState<string | undefined>(undefined);
  // Chosen card: the user's pick, else the project already open, else the newest.
  const chosen = picked ?? currentCwd ?? projects[0]?.path;
  const chosenName =
    projects.find((p) => p.path === chosen)?.name ?? (chosen === currentCwd ? currentFolder : undefined) ?? (chosen ? folderOf(chosen) : undefined);
  const [now, setNow] = useState(() => Date.now());
  // Offered whenever the daemon can answer — including, especially, when there
  // are no projects at all. That is the cold start this exists for.
  const canBrowse = onBrowse !== undefined;
  const cells = useMemo<GridCell[]>(() => (canBrowse ? [...projects, BROWSE_CELL] : projects), [projects, canBrowse]);

  // One value for one movement. This used to be two — a native-driven spring
  // for the slide and a JS-driven one for the height, because legacy `Animated`
  // cannot put `height` on the native thread. They were started together and
  // still came apart: the JS half ran on React's clock, and React was busy
  // because the height spring's own `onLayout` was firing a `setState` on every
  // frame of it. That feedback loop is what made the step change stutter.
  //
  // On Reanimated `height` animates on the UI thread like anything else, so the
  // whole movement is one shared value and the re-render count for a step
  // change is one.
  const step$ = useSharedValue(STEP_CHOICES);

  // Measured, never assumed: the first step is a couple of fixed rows but the
  // others are lists whose height depends on the machine, and a guess would make
  // the card settle at the wrong size and then correct itself.
  //
  // Shared values rather than state, so a pane reporting its size does not
  // re-render the sheet — which is what turned every resize into a render storm.
  const firstHeight = useSharedValue(0);
  const secondHeight = useSharedValue(0);
  const width = useSharedValue(0);

  useEffect(() => {
    step$.value = reduceMotion ? step : withSpring(step, STEP_SPRING);
  }, [step, reduceMotion, step$]);

  // Always opens on the first step. A sheet that reopened onto the project list
  // because that is where it was last closed would hide its own primary action.
  //
  // Reset on the way *in*, not on the way out: `Sheet` stays mounted for its
  // exit animation, so clearing this on close swaps the list back to step one
  // while the card is still sliding down, in full view. Cut rather than
  // animated, since the sheet is off screen at the time — a push nobody can see
  // would only delay the next opening.
  useEffect(() => {
    if (!visible) return;
    setStep(STEP_CHOICES);
    setPicked(undefined);
    setNow(Date.now());
    step$.value = STEP_CHOICES;
  }, [visible, step$]);

  // The browser adds an "up" row below a root, which occupies list space and is
  // counted here or the card comes out a row short.
  const browseEntries = browse?.entries ?? [];
  // The refusal notice occupies a row of its own, above a list that is still
  // showing where the user was.
  const browseRows =
    browseEntries.length + (browse?.parent ? 1 : 0) + (browse?.refused ? 1 : 0);
  const browseHeight = Math.max(1, Math.min(browseRows, SHEET_VISIBLE_ROWS)) * SHEET_ROW_HEIGHT;
  const browseScrolls = browseRows > SHEET_VISIBLE_ROWS;

  // Explicit only once there is something real to be explicit about.
  //
  // Until the first pane has reported its size the card takes its height from
  // that pane directly, which is why the pane is in normal flow rather than
  // absolutely positioned like the one behind it. The alternative — falling back
  // to a placeholder height — is what made the first open of this sheet wrong:
  // the card was one point tall for the frame in which the sheet measured itself
  // to decide how far it had to travel, so it stopped short of the top and only
  // looked right on the second open, once these measurements were left over from
  // the first.
  const cardStyle = useAnimatedStyle(() => {
    const first = firstHeight.value;
    const second = secondHeight.value;
    if (first === 0 && second === 0) return { height: undefined };
    return {
      height: interpolate(
        step$.value,
        [STEP_CHOICES, STEP_LIST],
        [first || second, second || first],
      ),
    };
  });

  // Full-width travel, so each pane leaves and arrives at the card's own edge.
  // Zero until the card has been measured, which reads as a cross-fade for the
  // one frame before layout lands rather than as a pane flying in from nowhere.
  //
  // The fades run faster than the travel: a pane at the halfway point is already
  // mostly gone, which is what stops the two lists from reading as one doubled
  // list mid-push.
  // The next step rises from below while the one it replaces sinks back and
  // fades, the same direction the sheet itself arrives from. (It used to slide
  // in from the right, which reads as navigating away rather than going deeper
  // into the same sheet.)
  const RISE = 36;
  const outgoingStyle = useAnimatedStyle(() => ({
    opacity: interpolate(step$.value, [0, 0.5], [1, 0], "clamp"),
    transform: [
      { translateY: interpolate(step$.value, [0, 1], [0, -RISE / 2]) },
      { scale: interpolate(step$.value, [0, 1], [1, 0.97]) },
    ],
  }));
  const incomingStyle = useAnimatedStyle(() => ({
    opacity: interpolate(step$.value, [0.35, 1], [0, 1], "clamp"),
    transform: [{ translateY: interpolate(step$.value, [0, 1], [RISE, 0]) }],
  }));

  const goTo = (next: number) => {
    haptics.tap();
    setStep(next);
  };

  const openBrowser = () => {
    // Asked on the way in, every time. A listing goes stale the moment a
    // directory is made at the desk, and it is cheap — the daemon answered a
    // full scan of a real home directory in about 250ms.
    onBrowse?.(browse?.path);
    goTo(STEP_LIST);
  };

  return (
    <Sheet
      visible={visible}
      label="New chat"
      title={
        step === STEP_CHOICES
          ? "Where should it work?"
          : // Named while browsing: several levels down, "Browse" alone gives
            // no clue where you are, and the path is too long for a title.
            browse?.path
            ? folderOf(browse.path)
            : "Browse folders"
      }
      onClose={onClose}
      onBack={step === STEP_CHOICES ? undefined : () => goTo(STEP_CHOICES)}
      dismissLabel="Close new chat"
    >
      <Animated.View
        style={[styles.card, cardStyle]}
        onLayout={(event) => {
          width.value = event.nativeEvent.layout.width;
        }}
      >
        {/* Step one. Absolute so every pane occupies the same box and the card's
            animated height is the only thing deciding its size. */}
        <Animated.View
          style={[styles.firstPane, outgoingStyle]}
          // Inert once pushed past, or the invisible pane keeps taking the taps
          // meant for the list on top of it.
          pointerEvents={step === STEP_CHOICES ? "auto" : "none"}
          onLayout={(event) => {
            firstHeight.value = event.nativeEvent.layout.height;
          }}
        >
          {/* Virtualised: only the cards on screen exist. Every project on the
              computer used to be built at once, each with its own entrance
              animation, and opening the sheet froze the app for seconds on a
              machine with a few hundred (measured: ~3.3s of blocked JS). */}
          <FlatList
            style={{ maxHeight: GRID_MAX_HEIGHT }}
            data={cells}
            keyExtractor={cellKey}
            numColumns={2}
            columnWrapperStyle={styles.gridRow}
            contentContainerStyle={styles.grid}
            showsVerticalScrollIndicator={false}
            initialNumToRender={8}
            maxToRenderPerBatch={8}
            windowSize={5}
            removeClippedSubviews
            renderItem={({ item, index }) =>
              isBrowse(item) ? (
                <Dissolve kind="row" delay={Math.min(index, STAGGERED) * 50} style={styles.cell}>
                  <PressScale
                    feel="tap"
                    onPress={openBrowser}
                    accessibilityLabel="Browse folders on your computer"
                    style={[styles.tile, dashedOutline, styles.browseCard]}
                  >
                    <Ionicons name="search-outline" size={18} color={theme.color.textDim} />
                    <Text style={styles.cardTitle} numberOfLines={1}>Browse folders</Text>
                  </PressScale>
                </Dissolve>
              ) : (
                <ProjectCard
                  project={item}
                  index={index}
                  current={item.path === currentCwd}
                  selected={item.path === chosen}
                  agent={agent}
                  now={now}
                  onPick={setPicked}
                />
              )
            }
          />
          {(chosen !== undefined || !canBrowse) && onStartOnComputer && computerAgent && chosen !== undefined ? (
            <>
              <StageButton
                style={styles.primary}
                feel="sent"
                label={chosenName ? `Open ${computerAgent} in ${chosenName}` : `Open ${computerAgent}`}
                accessibilityLabel={`Open ${computerAgent} in a terminal on your computer${chosenName ? `, in ${chosenName}` : ""}`}
                accessibilityHint="A window opens on your computer, and this phone types into it"
                onPress={() => onStartOnComputer(chosen, bypassOffered === true && bypass)}
              />
              {bypassOffered && (
                <Pressable
                  onPress={() => setBypass((on) => !on)}
                  accessibilityRole="switch"
                  accessibilityState={{ checked: bypass }}
                  accessibilityLabel="Skip permission prompts"
                  accessibilityHint={`${computerAgent} will act without asking first`}
                  style={({ pressed }) => [styles.bypass, pressed && styles.rowPressed]}
                >
                  <View style={[styles.bypassDot, bypass && styles.bypassDotOn]} />
                  <View style={styles.rowText}>
                    <Text style={styles.rowTitle}>Skip permission prompts</Text>
                    <Text style={styles.rowDetail}>
                      {bypass
                        ? `${computerAgent} won't ask before editing files or running commands.`
                        : "Off: it asks before anything risky."}
                    </Text>
                  </View>
                </Pressable>
              )}
              <StageButton
                kind="secondary"
                compact
                style={styles.secondary}
                label="Chat here instead"
                accessibilityLabel={chosenName ? `Start a chat on this phone in ${chosenName}` : "Start a chat on this phone"}
                onPress={() => onStart(chosen)}
              />
            </>
          ) : (
            (chosen !== undefined || !canBrowse) && (
              <StageButton
                style={styles.primary}
                feel="sent"
                label={chosenName ? `Start in ${chosenName}` : "Start a chat"}
                accessibilityLabel={chosenName ? `Start a chat in ${chosenName}` : "Start a chat"}
                onPress={() => onStart(chosen)}
              />
            )
          )}
        </Animated.View>

        {/* Step two: whichever list was asked for. Mounted from the start so
            the push has something real to move; without it the first frame of
            the travel is an empty pane. */}
        {canBrowse && (
          <Animated.View
            style={[styles.pane, incomingStyle]}
            pointerEvents={step === STEP_LIST ? "auto" : "none"}
            onLayout={(event) => {
              secondHeight.value = event.nativeEvent.layout.height;
            }}
          >
            {(
              <StageScroll
                rail="inside"
                style={{ height: browseHeight }}
                bounces={browseScrolls}
              >
                {browse?.parent !== undefined && (
                  <Row
                    icon="arrow-up-outline"
                    title="Up"
                    detail={folderOf(browse.parent)}
                    divided={browseEntries.length > 0}
                    onPress={() => onBrowse?.(browse.parent)}
                  />
                )}
                {browseEntries.map((entry, index) => (
                  <Row
                    key={entry.path}
                    // A repository is what the user is nearly always after, and the
                    // icon is the only thing distinguishing it at a glance.
                    icon={entry.repo ? "git-branch-outline" : "folder-outline"}
                    title={entry.name}
                    detail={entry.repo ? "Git repository" : undefined}
                    divided={index < browseEntries.length - 1}
                    // The row starts a chat here; the chevron goes deeper. Split
                    // because a folder is both a destination and a container, and
                    // making one gesture mean both would pick the wrong one about
                    // half the time.
                    onPress={() => onStart(entry.path)}
                    onDescend={() => onBrowse?.(entry.path)}
                    descendLabel={`Open ${entry.name}`}
                  />
                ))}
                {/* A refusal keeps the listing the user was on, so this has to
                    show over a non-empty list too — otherwise tapping a folder
                    that cannot be opened looks like nothing happened at all. */}
                {(browseEntries.length === 0 || browse?.refused) && (
                  <View style={styles.empty}>
                    <Text style={styles.emptyText}>
                      {browse?.loading
                        ? "Looking…"
                        : browse?.refused
                          ? "That folder can't be opened"
                          : browse?.path
                            ? "No folders in here"
                            : "No projects found on your computer"}
                    </Text>
                  </View>
                )}
              </StageScroll>
            )}
          </Animated.View>
        )}
      </Animated.View>
    </Sheet>
  );
}

/** Three rows of cards, then the grid scrolls. */
const GRID_MAX_HEIGHT = 3 * 84 + 2 * 8;

/** "now", "5m", "3h", "2d" — the last time this project was worked in. */
function agoLabel(iso: string | undefined, now: number): string | undefined {
  if (!iso) return undefined;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return undefined;
  const mins = Math.max(0, Math.round((now - at) / 60000));
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/**
 * One project as a Stage card: dashed at rest, solid in the agent colour when
 * chosen. No sparkline — the daemon sends no per-project activity series, and
 * a drawn one would be invented.
 */
function ProjectCard({
  project,
  index,
  current,
  selected,
  agent,
  now,
  onPick,
}: {
  project: Project;
  index: number;
  current: boolean;
  selected: boolean;
  agent: string;
  now: number;
  onPick: (path: string) => void;
}) {
  const onPress = () => onPick(project.path);
  const ago = agoLabel(project.updatedAt, now);
  const meta = [
    current ? "here" : undefined,
    project.sessions !== undefined ? `${project.sessions} chat${project.sessions === 1 ? "" : "s"}` : undefined,
    ago,
  ].filter((part): part is string => part !== undefined);
  return (
    // Only the first screenful staggers in; cards further down appear as you
    // scroll to them, which is no moment for a delay.
    <Dissolve kind="row" delay={Math.min(index, STAGGERED) * 50} style={styles.cell}>
      <PressScale
        feel="select"
        onPress={onPress}
        accessibilityRole="radio"
        accessibilityState={{ selected }}
        accessibilityLabel={[project.name, ...meta].join(", ")}
        style={[
          styles.tile,
          selected ? { borderWidth: 1, borderColor: agent, backgroundColor: withAlpha(agent, 0.1) } : dashedOutline,
        ]}
      >
        <Text style={styles.cardTitle} numberOfLines={1}>
          {project.name}
        </Text>
        {meta.length > 0 && (
          <Led tone={selected ? "agent" : "dim"} size={theme.stage.ledSize}>
            {meta.join(" · ")}
          </Led>
        )}
      </PressScale>
    </Dissolve>
  );
}

/** Last path segment: the folder as a person says it. */
function folderOf(path: string): string {
  const segments = path.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

function Row({
  icon,
  title,
  detail,
  divided,
  chevron,
  onPress,
  onDescend,
  descendLabel,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  detail?: string;
  divided?: boolean;
  chevron?: boolean;
  onPress: () => void;
  /**
   * Go *into* this row rather than choose it.
   *
   * Only the browser passes one, because only there is a row both a place to
   * work and a container of other places. The two live on separate hit targets:
   * one gesture meaning both would guess wrong about half the time, and the
   * wrong guess starts an agent in the wrong directory.
   */
  onDescend?: () => void;
  descendLabel?: string;
}) {
  return (
    <View style={[styles.rowShell, divided && styles.rowDivided]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={detail ? `${title}, ${detail}` : title}
        hitSlop={touchSlop(theme.space(1))}
        onPress={onPress}
        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      >
        <Ionicons name={icon} size={20} color={theme.color.glyph} />
        <View style={styles.rowText}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {title}
          </Text>
          {!!detail && (
            <Text style={styles.rowDetail} numberOfLines={1}>
              {detail}
            </Text>
          )}
        </View>
        {/* Only on the row that leads somewhere: it promises a next step, and on
            a row that starts a chat it would be a lie. */}
        {chevron && <Ionicons name="chevron-forward" size={16} color={theme.color.textDim} />}
      </Pressable>
      {onDescend && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={descendLabel ?? `Open ${title}`}
          onPress={onDescend}
          // Wide enough to hit without aiming, and its own pressed state so it
          // is visibly a second control rather than part of the row.
          style={({ pressed }) => [styles.rowDescend, pressed && styles.rowPressed]}
        >
          <Ionicons name="chevron-forward" size={16} color={theme.color.textDim} />
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: sheetCardStyle,
  // The first pane stays in normal flow so the card has a natural height on the
  // frame it first appears, before any measurement has come back. Everything
  // after it is measured and driven by the card's animated height instead.
  firstPane: { width: "100%" },
  // Stacked over the first rather than after it: the two occupy one box, each
  // measuring its own natural height while the card animates between them.
  pane: { position: "absolute", left: 0, right: 0, top: 0 },
  row: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(3),
    height: SHEET_ROW_HEIGHT,
    paddingHorizontal: theme.space(4),
  },
  // Holds the row and its optional descend target side by side, so the divider
  // spans both rather than stopping at the seam between them.
  rowShell: { flexDirection: "row", alignItems: "center" },
  rowDivided: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.color.border,
  },
  rowDescend: {
    height: SHEET_ROW_HEIGHT,
    justifyContent: "center",
    paddingLeft: theme.space(2),
    paddingRight: theme.space(4),
  },
  empty: {
    height: SHEET_ROW_HEIGHT,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.space(4),
  },
  emptyText: {
    color: theme.color.textDim,
    fontSize: theme.font.small,
    textAlign: "center",
  },
  grid: { gap: theme.space(2), padding: theme.space(4), paddingBottom: theme.space(3) },
  gridRow: { gap: theme.space(2) },
  cell: { flex: 1, maxWidth: "50%" },
  tile: { height: 84, borderRadius: theme.radius.md, padding: theme.space(3), justifyContent: "space-between" },
  browseCard: { justifyContent: "center", gap: theme.space(1) },
  cardTitle: { color: theme.color.text, fontSize: theme.font.body },
  // On the sheet's rail, like the cards above it.
  primary: { marginTop: theme.space(3), marginBottom: theme.space(4) },
  secondary: { marginBottom: theme.space(4) },
  bypass: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(3),
    paddingVertical: theme.space(2),
    paddingHorizontal: theme.space(2),
    marginBottom: theme.space(3),
    borderRadius: theme.radius.md,
  },
  bypassDot: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    borderColor: theme.color.textDim,
  },
  bypassDotOn: { backgroundColor: theme.color.danger, borderColor: theme.color.danger },
  rowPressed: { backgroundColor: theme.glass.fillPressed },
  // Yields to the chevron rather than pushing it off the row.
  rowText: { flex: 1 },
  rowTitle: { color: theme.color.text, fontSize: theme.font.body },
  rowDetail: { color: theme.color.textDim, fontSize: theme.font.tiny },
});

export const NewChatSheet = memo(NewChatSheetView);
