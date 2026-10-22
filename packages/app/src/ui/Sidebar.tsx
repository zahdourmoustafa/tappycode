/**
 * The sidebar drawer: the Switchboard.
 *
 * A rail of Tappies down the left, one per agent (the chosen one awake with a lit
 * bar, the rest dozing), and the chosen agent's world on the right: its name,
 * the connection on one LED line, project tabs, then its latest chats.
 *
 * This is a push drawer: the conversation slides right to reveal it, so the
 * panel itself is static. App owns the motion.
 */
import { memo, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Alert, Dimensions, FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Ionicons from "@expo/vector-icons/Ionicons";
import { theme } from "../theme";
import { withAlpha } from "../motion";
import { CircleButton, touchSlop } from "./controls";
import { haptics } from "./haptics";
import { HistorySkeleton } from "./Skeleton";
import { orderProvidersByRecency } from "../providerRecency";
import type { DrawerRow } from "../historyMetadata";
import { recentSessionsForProvider } from "../sessionHistory";
import { useAppActive } from "./useAppActive";
import { projectTabItems, sessionsInProject, type Project } from "../projects";
import type { Provider, Status } from "../useDaemon";
import { lastActiveLabel, sortGoals, type GoalSummary } from "../ggState";
import { goalDrawerRow } from "../goalsAgent";
import { Tappy } from "../tappy/Tappy";
import { tappyInk } from "../tappy/palette";
import { Led } from "./stage/Led";
import { Pixel } from "./stage/Pixel";
import { DashedRule, dashedOutline } from "./stage/DashedRule";
import { useAgentColor } from "./stage/agentColor";
import { Dissolve } from "./motion/Dissolve";
import { DotGlyph } from "./stage/DotGlyph";

/**
 * The whole screen: the drawer is a page of its own now, with room for long
 * titles and the full chat list. The conversation slides fully out to its
 * right, so the drawer carries its own close (a button and a left swipe).
 */
export const DRAWER_WIDTH = Dimensions.get("window").width;

interface SidebarProps {
  open: boolean;
  providers: Provider[];
  sessions: DrawerRow[];
  activeProviderId?: string;
  activeSessionId?: string;
  onSelectProvider: (id: string) => void;
  onOpenSession: (id: string) => void;
  /**
   * Starts a conversation in `cwd`.
   *
   * Always called with one: the only button that reaches this is beside a named
   * project, which is what replaced a header button that could not say where
   * its chat would go.
   */
  /** A new chat: in the chosen project, or (on All) where this agent last worked. */
  onNewConversation: (cwd?: string) => void;
  /** Projects the selected agent has worked in, newest first. */
  projects: Project[];
  /** The chosen one, or undefined for all of them. */
  selectedProjectPath?: string;
  /** `undefined` clears the filter back to every project. */
  onSelectProject: (path?: string) => void;
  /** Host and port, retained for accessible detail and the Forget confirmation. */
  machineLabel: string;
  /** True when reached via a relay, so it works away from home. */
  machineRemote: boolean;
  connectionStatus: Status;
  onOpenConnection: () => void;
  /** Close the drawer (it covers the whole screen, so it needs its own way out). */
  onClose?: () => void;
  /**
   * A newer tappy the paired computer has not got, when there is one.
   *
   * Absent for the ordinary case, including a machine that updates itself — by
   * the time anyone could read a notice about it, it has already happened.
   */
  update?: { latest: string; automatic: boolean };
  /**
   * Agents are still answering what conversations they hold. Without this the
   * drawer claims "No conversations yet" for the first seconds after connect —
   * a false empty state on machines with plenty of history.
   */
  historyLoading?: boolean;
  /** Honor the phone's Reduce Motion accessibility preference. */
  reduceMotion?: boolean;
  /**
   * GG Goals selected: its goals replace the project picker and the chat
   * history (goal sessions are never mixed into another agent's list). They
   * are drawn by this file's own heading, list and `SessionRow`, so the two
   * lists cannot drift apart.
   */
  goals?: SidebarGoals;
}

export interface SidebarGoals {
  /** Absent until the first answer arrives (shows the same skeleton as chats). */
  list?: readonly GoalSummary[];
  loading: boolean;
  error?: string;
  onRefresh: () => void;
  onNew: () => void;
  onOpen: (goal: GoalSummary) => void;
  onDelete: (goal: GoalSummary) => void;
}

/** Rows that stagger in on open; the rest just appear. */
const STAGGERED_ROWS = 10;
const ROW_STAGGER_MS = 40;
const RAIL_WIDTH = 64;
const RAIL_TAPPY = 48;
const RAIL_BUTTON = 52;
/** The right column's own left rail: every heading, tab and row starts here. */
const COLUMN_PAD = theme.space(4);
/** Fixed status column so every row's title starts at the same x. */
const STATUS_COL = 16;

type Mark = "live" | "attention" | "unread" | undefined;

function rowMark(row: Pick<DrawerRow, "busy" | "unread"> & { permission?: unknown }): Mark {
  if (row.permission) return "attention";
  if (row.busy) return "live";
  if (row.unread) return "unread";
  return undefined;
}

/** "4m", "2h", "3d": the right-hand time, short so the title keeps the room. */
function shortWhen(ms?: number): string {
  if (!ms) return "";
  const label = lastActiveLabel(ms);
  return label === "just now" ? "now" : label.replace(" ago", "");
}

interface SessionRowProps {
  session: Pick<DrawerRow, "id" | "title" | "busy" | "unread"> & Partial<DrawerRow>;
  /** Spoken detail when the row is not a chat (a goal's status · when). */
  meta?: string;
  onLongPress?: (id: string) => void;
  index: number;
  active: boolean;
  reduceMotion: boolean;
  /** Shut drawer, or app in the background. */
  paused: boolean;
  /** Takes the id, so one stable callback serves every row. */
  onOpen: (id: string) => void;
}

/**
 * Sleeping styles down the rail, by position: a fixed shuffle of all ten, so
 * no two neighbours (and no two of the first ten) ever doze the same way.
 */
const RAIL_SLEEP = [0, 5, 8, 3, 7, 2, 9, 4, 6, 1] as const;

const SessionRow = memo(function SessionRow({ session, index, active, reduceMotion, paused, onOpen, meta, onLongPress }: SessionRowProps) {
  // Only rows that mount while the drawer is open cascade, captured at mount:
  // the list remounts behind a shut drawer when the daemon answers late, and a
  // cascade replayed on every open is the glitch this avoids.
  const [revealing] = useState(() => !paused);
  const agent = useAgentColor();
  const mark = rowMark(session);
  const when = shortWhen(session.startedAt);
  const status = mark === "live" ? "Working" : mark === "attention" ? "Waiting on you" : mark === "unread" ? "New reply" : undefined;
  return (
    <Dissolve kind="row" delay={index * ROW_STAGGER_MS} enabled={!reduceMotion && revealing && index < STAGGERED_ROWS}>
      {index > 0 && <DashedRule />}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={[session.title, status, meta ?? (when ? `${when} ago` : undefined)].filter(Boolean).join(", ")}
        accessibilityState={{ selected: active }}
        onPress={() => onOpen(session.id)}
        onLongPress={onLongPress ? () => onLongPress(session.id) : undefined}
        style={({ pressed }) => [styles.row, active && { backgroundColor: withAlpha(agent, 0.1) }, pressed && styles.pressed]}
      >
        {/* The title starts on the column's rail, under "Latest chats"; the
            status marker sits at the right edge beside the time, so a marked
            row never indents. */}
        <Text style={[styles.rowTitle, active && { color: agent }]} numberOfLines={1}>
          {session.title}
        </Text>
        {mark ? <View style={styles.statusCol}><Pixel kind={mark} paused={paused} /></View> : null}
        {when ? <Text style={styles.rowWhen} numberOfLines={1}>{when}</Text> : null}
      </Pressable>
    </Dissolve>
  );
});

/** "+ New chat" / "+ New goal": an LED action on the list heading's line. */
function LedAction({ label, a11y, onPress }: { label: string; a11y: string; onPress: () => void }) {
  return (
    <Dissolve kind="in">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={a11y}
        hitSlop={touchSlop(theme.space(2))}
        onPress={() => {
          haptics.tap();
          onPress();
        }}
        style={({ pressed }) => [styles.ledAction, pressed && styles.pressed]}
      >
        <Led>{`+ ${label}`}</Led>
      </Pressable>
    </Dissolve>
  );
}

function ListHead({ label, children }: { label: string; children?: ReactNode }) {
  return (
    <View style={styles.listHead}>
      <Led tone="dim">{label}</Led>
      {children}
    </View>
  );
}

/** GG Goals' half of the drawer: its goals in the same row style as chats. */
function GoalsSection({ goals, activeSessionId, reduceMotion, paused }: { goals: SidebarGoals; activeSessionId?: string; reduceMotion: boolean; paused: boolean }) {
  const sorted = useMemo(() => sortGoals([...(goals.list ?? [])]), [goals.list]);
  const byId = useMemo(() => new Map(sorted.map((goal) => [goal.id, goal])), [sorted]);
  // The system spinner only ever answers a pull the user made.
  const [pulled, setPulled] = useState(false);
  useEffect(() => {
    if (!goals.loading) setPulled(false);
  }, [goals.loading]);
  const { onOpen, onDelete } = goals;
  const open = useCallback(
    (id: string) => {
      const goal = byId.get(id);
      if (!goal) return;
      haptics.tap();
      onOpen(goal);
    },
    [byId, onOpen],
  );
  const confirmDelete = useCallback(
    (id: string) => {
      const goal = byId.get(id);
      if (!goal) return;
      haptics.warned();
      Alert.alert("Delete goal?", `“${goal.name}” will be removed from GG Goals on your computer.`, [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: () => onDelete(goal) },
      ]);
    },
    [byId, onDelete],
  );

  return (
    <>
      <ListHead label="Latest goals">
        <LedAction label="New goal" a11y="New goal" onPress={goals.onNew} />
      </ListHead>
      <FlatList
        style={styles.list}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
        data={sorted}
        extraData={`${activeSessionId ?? ""}:${reduceMotion}:${paused}`}
        keyExtractor={(goal) => goal.id}
        refreshControl={
          <RefreshControl
            refreshing={pulled && goals.loading}
            onRefresh={() => {
              setPulled(true);
              goals.onRefresh();
            }}
            tintColor={theme.color.textDim}
          />
        }
        ListEmptyComponent={
          goals.list === undefined && !goals.error ? (
            <HistorySkeleton label="Loading goals" />
          ) : (
            <Text style={styles.empty} numberOfLines={2}>{goals.error ?? "No goals yet. Start one with New goal."}</Text>
          )
        }
        renderItem={({ item: goal, index }) => {
          const { row, meta } = goalDrawerRow(goal, lastActiveLabel(goal.lastActiveMs));
          return (
            <SessionRow
              session={row}
              meta={meta}
              index={index}
              active={goal.sessionId !== undefined && goal.sessionId === activeSessionId}
              reduceMotion={reduceMotion}
              paused={paused}
              onOpen={open}
              onLongPress={confirmDelete}
            />
          );
        }}
      />
    </>
  );
}

/** One agent on the rail: its Tappy, a tinted tile when chosen (no edge bar: the user wants no coloured left edges anywhere), a status pixel. */
const RailAgent = memo(function RailAgent({
  provider, selected, mark, index, paused, reduceMotion, onPress,
}: { provider: Provider; selected: boolean; mark: Mark; index: number; paused: boolean; reduceMotion: boolean; onPress: (id: string) => void }) {
  const enabled = provider.available;
  const ink = tappyInk(provider.color);
  const [revealing] = useState(() => !paused);
  const spoken = mark === "attention" ? "needs you" : mark === "live" ? "working" : mark === "unread" ? "new reply" : undefined;
  return (
    <Dissolve kind="in" delay={index * ROW_STAGGER_MS} enabled={!reduceMotion && revealing}>
      <Pressable
        disabled={!enabled}
        accessibilityRole="button"
        accessibilityLabel={enabled ? [provider.name, spoken].filter(Boolean).join(", ") : `${provider.name}, unavailable. ${provider.unavailableReason ?? ""}`}
        accessibilityState={{ selected, disabled: !enabled }}
        onPress={() => {
          if (selected) return;
          haptics.select();
          onPress(provider.id);
        }}
        style={({ pressed }) => [styles.railButton, selected && { backgroundColor: withAlpha(ink, 0.13) }, !enabled && styles.unavailable, pressed && styles.pressed]}
      >
        <Tappy size={RAIL_TAPPY} color={provider.color} mood={!enabled ? "sleepy" : selected ? "idle" : "sleepy"} sleepKey={provider.id} sleepStyle={RAIL_SLEEP[index % RAIL_SLEEP.length]} paused={paused || !enabled} />
        {mark && <View style={styles.railBadge}><Pixel kind={mark} color={mark === "attention" ? undefined : ink} paused={paused} /></View>}
      </Pressable>
    </Dissolve>
  );
});

/** One project tab: dashed at rest, solid in the agent colour when chosen. */
const ALL_TAB = "\u0000all";

const ProjectTab = memo(function ProjectTab({ path, label, a11y, selected, onSelect }: { path?: string; label: string; a11y: string; selected: boolean; onSelect: (path?: string) => void }) {
  const agent = useAgentColor();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={a11y}
      accessibilityState={{ selected }}
      onPress={() => {
        if (selected) return;
        haptics.select();
        onSelect(path);
      }}
      style={({ pressed }) => [styles.tab, selected ? { borderStyle: "solid", borderColor: agent, backgroundColor: withAlpha(agent, 0.1) } : null, pressed && styles.pressed]}
    >
      <Text style={[styles.tabText, selected && { color: agent }]} numberOfLines={1}>{label}</Text>
    </Pressable>
  );
});

function SidebarView({
  open,
  providers,
  sessions,
  activeProviderId,
  activeSessionId,
  onSelectProvider,
  onOpenSession,
  onNewConversation,
  projects,
  selectedProjectPath,
  onSelectProject,
  machineLabel,
  machineRemote,
  connectionStatus,
  onOpenConnection,
  onClose,
  update,
  historyLoading = false,
  reduceMotion = false,
  goals,
}: SidebarProps) {
  const insets = useSafeAreaInsets();
  const appActive = useAppActive();
  // Nothing animates while the drawer is shut or the app is off screen.
  const rowsStill = !open || !appActive;

  // GG Coder and GG Goals pinned first, then most recently used.
  const orderedProviders = useMemo(() => orderProvidersByRecency(providers, sessions), [providers, sessions]);
  const activeProvider = orderedProviders.find((p) => p.id === activeProviderId);

  // One status per agent for its rail Tappy: needs you > working > unread.
  const marks = useMemo(() => {
    const out = new Map<string, Mark>();
    const rank = { attention: 3, live: 2, unread: 1 } as const;
    for (const row of sessions) {
      const mark = rowMark(row);
      if (!mark || !row.providerId) continue;
      const was = out.get(row.providerId);
      if (!was || rank[mark] > rank[was]) out.set(row.providerId, mark);
    }
    return out;
  }, [sessions]);

  const selectedProject = useMemo(() => projects.find((project) => project.path === selectedProjectPath), [projects, selectedProjectPath]);
  const tabItems = useMemo(() => projectTabItems(projects), [projects]);
  // Narrowed before the recent-work cap, or a project's older conversations
  // would be cut away by a window they were never in.
  const visible = useMemo(
    () => recentSessionsForProvider(sessionsInProject(sessions, selectedProject), activeProviderId),
    [sessions, selectedProject, activeProviderId],
  );

  const openRow = useCallback(
    (id: string) => {
      haptics.tap();
      onOpenSession(id);
    },
    [onOpenSession],
  );

  const connection =
    connectionStatus === "online"
      ? { word: "Online", tone: "plus" as const, spoken: "Healthy connection" }
      : connectionStatus === "connecting"
        ? { word: "Connecting", tone: "attention" as const, spoken: "Connecting" }
        : { word: "Offline", tone: "danger" as const, spoken: "Connection interrupted" };

  return (
    <View
      style={[styles.panel, { width: DRAWER_WIDTH }]}
      pointerEvents={open ? "auto" : "none"}
      // Mounted while closed, but not on screen: unreachable by swipe navigation.
      accessibilityElementsHidden={!open}
      importantForAccessibility={open ? "auto" : "no-hide-descendants"}
    >
      <View style={[styles.board, { paddingTop: insets.top + theme.headerInset }]}>
        <View style={[styles.rail, { paddingBottom: insets.bottom + theme.space(4) }]} accessibilityRole="tablist" accessibilityLabel="Agents">
          <DashedRule vertical style={styles.railEdge} />
          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.railList}>
            {orderedProviders.map((provider, index) => (
              <RailAgent
                key={provider.id}
                provider={provider}
                selected={provider.id === activeProviderId}
                mark={marks.get(provider.id)}
                index={index}
                paused={rowsStill}
                reduceMotion={reduceMotion}
                onPress={onSelectProvider}
              />
            ))}
          </ScrollView>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Connection details for ${machineLabel}${update ? (update.automatic ? ", updating tappy" : ", update available") : ""}`}
            hitSlop={touchSlop(theme.space(1))}
            onPress={() => {
              haptics.tap();
              onOpenConnection();
            }}
            style={({ pressed }) => [styles.railButton, pressed && styles.pressed]}
          >
            <Ionicons name="settings-outline" size={22} color={theme.color.textDim} />
            {update && <View style={styles.railBadge}><Pixel kind="attention" paused={rowsStill} /></View>}
          </Pressable>
        </View>

        <View style={styles.main}>
          <View style={styles.head}>
            <View style={styles.headTop}>
              <Text style={[styles.agentName, { color: tappyInk(activeProvider?.color) }]} numberOfLines={1}>
                {activeProvider?.name ?? "Agents"}
              </Text>
              {/* Full width now, so nothing of the conversation is left to tap:
                  the drawer closes itself. */}
              {onClose && (
                <CircleButton label="Close menu" size={40} onPress={onClose}>
                  <DotGlyph name="close" size={14} />
                </CircleButton>
              )}
            </View>
            <View
              accessibilityRole="text"
              accessibilityLabel={`${connection.spoken} to ${machineLabel}. ${machineRemote ? "Reachable from anywhere." : "Same network only."}`}
            >
              {/* Status only: the relay or host name is internal plumbing, and
                  the connection sheet has the details when they're wanted. */}
              <Led tone={connection.tone}>{connection.word}</Led>
            </View>
          </View>

          {goals ? (
            <GoalsSection goals={goals} activeSessionId={activeSessionId} reduceMotion={reduceMotion} paused={rowsStill} />
          ) : (
            <>
              {/* Horizontal tabs instead of a dropdown: the row scrolls, so many
                  projects still fit, and the choice is visible without a tap. */}
              {projects.length > 0 && (
<FlatList
                  // Windowed: GG Coder can hold hundreds of projects, and
                  // mounting every dashed pill at once made switching to it
                  // visibly slower than to any other agent.
                  key={activeProviderId ?? "all-providers"}
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  style={styles.tabScroller}
                  contentContainerStyle={styles.tabs}
                  data={tabItems}
                  extraData={selectedProject?.path}
                  keyExtractor={(item) => item.path ?? ALL_TAB}
                  initialNumToRender={8}
                  maxToRenderPerBatch={8}
                  windowSize={5}
                  renderItem={({ item }) => (
                    <ProjectTab
                      path={item.path}
                      label={item.label}
                      a11y={item.a11y}
                      selected={item.path === selectedProject?.path}
                      onSelect={onSelectProject}
                    />
                  )}
                />
              )}

              <ListHead label="Latest chats">
                {/* Always here, like New goal for GG Goals. With a project tab
                    chosen it opens there; on All it opens where this agent
                    last worked (the composer names the project, and it can be
                    changed from there before sending). */}
                <LedAction
                  key={selectedProject?.path ?? "all"}
                  label="New chat"
                  a11y={selectedProject ? `New chat in ${selectedProject.name}` : "New chat"}
                  onPress={() => onNewConversation(selectedProject?.path)}
                />
              </ListHead>

              {/* Windowed: a provider can hold hundreds of conversations. */}
              <FlatList
                // Remount on agent or project: scroll resets and rows enter once.
                key={`${activeProviderId ?? "all-providers"}:${selectedProjectPath ?? "all"}`}
                style={styles.list}
                contentContainerStyle={styles.listContent}
                showsVerticalScrollIndicator={false}
                data={visible}
                extraData={`${activeSessionId ?? ""}:${reduceMotion}:${rowsStill}`}
                keyExtractor={(session) => session.id}
                initialNumToRender={18}
                maxToRenderPerBatch={18}
                windowSize={9}
                removeClippedSubviews
                ListEmptyComponent={
                  historyLoading ? (
                    <HistorySkeleton />
                  ) : (
                    <Text style={styles.empty} numberOfLines={2}>
                      {selectedProject ? `No chats in ${selectedProject.name} yet.` : "No chats yet. Send a message to start one."}
                    </Text>
                  )
                }
                renderItem={({ item: session, index }) => (
                  <SessionRow
                    session={session}
                    index={index}
                    active={session.id === activeSessionId}
                    reduceMotion={reduceMotion}
                    paused={rowsStill}
                    onOpen={openRow}
                  />
                )}
              />
            </>
          )}
        </View>
      </View>
      {/* The drawer's edge, dashed like every other Stage rule. iOS draws a
          dashed border only on a box with all four sides, so this is a dashed
          box whose left, top and bottom run just outside the panel and are
          clipped away, leaving the right edge and its curved corners. */}
      <View style={styles.edge} pointerEvents="none" />
    </View>
  );
}

const styles = StyleSheet.create({
  // Static lower layer: the conversation slides right to reveal it.
  panel: {
    position: "absolute",
    top: 0,
    left: 0,
    bottom: 0,
    backgroundColor: theme.color.drawer,
    borderTopRightRadius: theme.radius.pane,
    borderBottomRightRadius: theme.radius.pane,
    overflow: "hidden",
  },
  edge: {
    position: "absolute",
    top: -2,
    bottom: -2,
    left: -2,
    right: 0,
    borderWidth: 1,
    borderStyle: "dashed",
    // Brighter than an in-panel rule: it draws the drawer's curved edge
    // against a canvas of nearly the same colour.
    borderColor: "rgba(255,255,255,0.28)",
    borderTopRightRadius: theme.radius.pane,
    borderBottomRightRadius: theme.radius.pane,
  },
  board: { flex: 1, flexDirection: "row" },
  pressed: { opacity: 0.6 },
  unavailable: { opacity: 0.4 },

  rail: {
    width: RAIL_WIDTH,
    alignItems: "center",
  },
  // A one-sided dashed border is not drawable on iOS: the rail's edge is a
  // vertical dashed rule laid over it instead.
  railEdge: { position: "absolute", top: 0, bottom: 0, right: 0 },
  railList: { alignItems: "center", gap: theme.space(1), paddingBottom: theme.space(2) },
  railButton: {
    width: RAIL_BUTTON,
    height: RAIL_BUTTON,
    borderRadius: theme.space(4),
    alignItems: "center",
    justifyContent: "center",
  },
  railBadge: { position: "absolute", top: theme.space(1), right: theme.space(1) },

  main: { flex: 1, minWidth: 0, paddingBottom: theme.space(4) },
  head: { paddingHorizontal: COLUMN_PAD, gap: theme.space(1), minHeight: theme.size.control, justifyContent: "center" },
  headTop: { flexDirection: "row", alignItems: "center", gap: theme.space(2) },
  agentName: { flex: 1, minWidth: 0, fontFamily: theme.display.regular, fontSize: theme.font.title, letterSpacing: 0.5 },

  tabScroller: { flexGrow: 0, marginTop: theme.space(4) },
  tabs: { paddingHorizontal: COLUMN_PAD, gap: theme.space(2), alignItems: "center" },
  tab: {
    ...dashedOutline,
    borderRadius: theme.radius.pill,
    minHeight: theme.size.chip,
    paddingHorizontal: theme.space(3),
    justifyContent: "center",
  },
  tabText: { color: theme.color.textDim, fontSize: theme.font.small },

  listHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.space(2),
    paddingHorizontal: COLUMN_PAD,
    marginTop: theme.space(5),
    // Constant height with or without the action, so choosing a project never shoves the list.
    minHeight: theme.size.touch,
  },
  ledAction: { minHeight: theme.size.touch, justifyContent: "center" },

  list: { flex: 1 },
  listContent: { paddingHorizontal: COLUMN_PAD },
  // The selected row's fill reaches a little past the rail on both sides
  // (negative margin, matching padding), so the text itself stays on it.
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(2),
    minHeight: theme.size.touch,
    paddingVertical: theme.space(2),
    marginHorizontal: -theme.space(2),
    paddingHorizontal: theme.space(2),
    borderRadius: theme.radius.sm,
  },
  statusCol: { width: STATUS_COL, alignItems: "center", justifyContent: "center" },
  rowTitle: { flex: 1, color: theme.color.text, fontSize: theme.font.body, lineHeight: theme.line.body },
  rowWhen: { color: theme.color.textDim, fontSize: theme.font.tiny },
  empty: {
    color: theme.color.textDim,
    fontSize: theme.font.small,
    lineHeight: 20,
    paddingTop: theme.space(2),
  },
});

// Memoized: a streamed chunk re-renders the screen many times a second, and
// none of those chunks change anything here.
export const Sidebar = memo(SidebarView);
