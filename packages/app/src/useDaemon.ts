/**
 * Daemon connection: one WebSocket, auto-reconnecting, translating the wire
 * envelope into rendered chat turns.
 *
 * ACP streams text as many small chunks, so consecutive agent chunks are
 * coalesced into a single message. Without this the list would grow by one row
 * per word and scrolling would fight the user.
 *
 * The hook owns the state, refs and effects; the work is split by
 * responsibility: `daemonState.ts` (state shape, timeouts, turn builders),
 * `useImageCache.ts` (desktop images), `daemonConnection.ts` (the socket),
 * `daemonFrame.ts` + `daemonReducer.ts` (each decrypted frame), and
 * `daemonActions.ts` (everything the phone sends).
 */
import { GOALS_PROVIDER_ID } from "./goalsAgent";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RestoreTarget } from "./restoreState";
import { SecureChannel, envelopeHeader } from "@tappy/protocol";
import { USE_FIXTURES, sampleSessions } from "./fixtures";
import { agentSessionKey } from "./agentHistory";
import type { OutboxEntry } from "./outbox";
import { visibleConfigs } from "./configTruth";
import { IDLE_ACTIVITY } from "./activity";
import type { Cursors } from "./cursors";
import type { PendingAttachment } from "./attachments";
import { defaultProviderId } from "./lastProvider";
import {
  loadCachedProviders,
  loadLastProvider,
  saveCachedProviders,
  saveLastProvider,
} from "./preferences";
import type { SlashCommand } from "./slashCommands";
import { capTurns } from "./replayFold";
import { EMPTY_GG, type GgState, type GoalSummary } from "./ggState";

export type {
  Status,
  Provider,
  ImageEntry,
  PermissionRequest,
  Turn,
  ConfigOption,
  Session,
  Workspace,
  WorkspaceEntry,
  WorkspaceBrowse,
} from "./daemonTypes";
import type { Provider, ConfigOption, Session } from "./daemonTypes";

import {
  LOADING_SESSION_TIMEOUT,
  stalledLoading,
  type DaemonOptions,
  type State,
  type TurnFinished,
} from "./daemonState";
import { useImageCache } from "./useImageCache";
import { openConnection } from "./daemonConnection";
import { createActions, deliverPrompt as deliverPromptVia } from "./daemonActions";
export type { PushAddress, TurnFinished } from "./daemonState";

/**
 * @param deviceId Identifies this phone to the relay, which uses it to tell
 * devices apart. Falls back to a constant so a direct LAN connection, where the
 * daemon does not care, still works.
 */
export function useDaemon(
  url: string,
  deviceId = "phone",
  /**
   * The pairing key, hex. Every frame is sealed with it.
   *
   * Empty means unpaired: the socket is never opened, because a connection with
   * nothing to encrypt with could only fail at the far end — and would look to
   * the user like a broken daemon rather than a missing pairing.
   */
  pairingKey = "",
  options: DaemonOptions = {},
) {
  const [state, setState] = useState<State>({
    status: "connecting",
    providers: [],
    turns: [],
    // Sample conversations in development so history and long-response
    // rendering can be reviewed with content. Real sessions are appended
    // ahead of these and never replaced by them.
    sessions: USE_FIXTURES ? sampleSessions() : [],
    configOptions: [],
    commands: [],
    busy: false,
    activity: IDLE_ACTIVITY,
    loadingSessions: false,
    loadingSession: false,
    projects: {},
    projectPath: {},
    workspaceNonce: 0,
    terminals: [],
    terminalsKnown: false,
    terminalTranscripts: {},
    terminalLive: {},
  });

  // Not in State: this is a cache keyed by provider, not part of the session.
  //
  // Never seeded from fixtures. These selectors drive the live top bar, so a
  // sample "Model: Sonnet" would be presented as this agent's real capability
  // and then be silently replaced by the truth once a session opened. Only an
  // agent's own advertisement may populate this.
  const [knownConfigs, setKnownConfigs] = useState<Record<string, ConfigOption[]>>({});
  // GG Coder's extensions — queued messages, open questions, goals — per
  // session. Its own state so the main reducer is untouched; see `ggState.ts`.
  const [gg, setGg] = useState<GgState>(EMPTY_GG);
  // Counter behind goal request ids.
  const goalCounter = useRef(0);
  const { images, requestedImages, storeImage, clearImages } = useImageCache();
  // Commands per provider, kept outside the session so opening a conversation
  // does not blank the menu for agents that never send the ACP notification and
  // are served from their project's files instead.
  const [knownCommands, setKnownCommands] = useState<Record<string, SlashCommand[]>>({});

  const restoring = useRef<RestoreTarget | undefined>(undefined);
  const streamGeneration = useRef(0);
  const streamBoundary = useRef<(() => void) | undefined>(undefined);
  const streamForeground = useRef(true);
  const setForeground = useCallback((active: boolean) => {
    streamForeground.current = active;
    if (!active) streamBoundary.current?.();
  }, []);
  const socket = useRef<WebSocket | null>(null);
  /** Encryption state for the live socket. Rebuilt on every reconnect. */
  const channel = useRef<SecureChannel | null>(null);
  /** Set once the daemon has refused this device for a reason retrying cannot fix. */
  const fatal = useRef(false);
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attempts = useRef(0);
  const alive = useRef(true);
  const resume = useRef<(() => void) | undefined>(undefined);
  // Mirrors state.sessionId so actions can read it without doing work inside a
  // state updater. Updaters must stay pure: React may invoke them twice.
  const sessionRef = useRef<string | undefined>(undefined);
  // Which drawer row the user is actually looking at, `sessionId` or not.
  //
  // Distinct from `sessionRef` because the cases that differ are exactly the
  // ones that went wrong: a conversation still waiting to be named has no
  // session id, and neither does the empty new-chat screen, yet they are
  // different places to be standing. Undefined means the empty screen.
  const viewingRef = useRef<string | undefined>(undefined);
  // Mirrors activeProviderId for the same reason sessionRef exists: message
  // handlers must not read state inside an updater.
  const providerRef = useRef<string | undefined>(undefined);
  // The chosen project per provider, mirrored out of state for the same reason
  // `providerRef` exists: `start` must read the choice made moments ago, not
  // the one captured when its callback was memoized.
  const projectRef = useRef<Record<string, string>>({});
  // The message entered before a session existed — text and any files with it.
  // Sent as soon as the daemon confirms one, so the composer works straight
  // from the empty state.
  const queued = useRef<
    { text: string; attachments: readonly PendingAttachment[] } | undefined
  >(undefined);
  // Counter behind the ids of optimistic user turns. Starting an agent can take
  // seconds, and the daemon's echo arrives only after that, so the prompt is
  // rendered locally first and reconciled when the echo lands.
  const localSeq = useRef(0);
  // Messages typed with no socket to send them on. See `outbox.ts`: the phone
  // is offline routinely, and a send that cannot go out waits here rather than
  // being refused at the keyboard or written to a dead socket and lost.
  //
  // A ref, and only a ref: it is read and written by socket handlers that must
  // not touch state, and it is deliberately not persisted — it holds attachment
  // bytes, and a queue that survives a force-quit would deliver a message the
  // user has long stopped expecting to send.
  const outbox = useRef<OutboxEntry[]>([]);
  // The `session.start` this client is waiting on, if any. Held outside state
  // because the message handler must read it without a render having happened,
  // and matched against the `requestId` echoed back so the answer adopts the
  // drawer row this client created rather than one another device's session
  // would land in. See `pendingSession`.
  const pendingStart = useRef<string | undefined>(undefined);
  // Whether this client is waiting for a conversation it asked to reopen.
  //
  // A resume is answered by the same broadcast `session.started` as a start,
  // and it carries no request id to match on, so "is this reopen mine?" can
  // only be answered by whether this client asked for one at all. Without that
  // a reopen on the laptop pulled every other device onto it.
  const awaitingResume = useRef(false);
  // Providers already asked for capabilities, so a reconnect's repeat provider
  // announcement does not spawn another probe for each one.
  const probed = useRef(new Set<string>());
  // Capability requests in flight, keyed by provider. One slow or broken agent
  // must not keep another provider's already-loaded history behind a skeleton.
  const pendingCapabilities = useRef(new Set<string>());
  // Per-project session requests in flight, keyed by `providerId:cwd`, so
  // choosing a project shows the loading skeleton rather than the empty state
  // it is about to replace.
  const pendingProjectSessions = useRef(new Set<string>());
  // The directory listing the picker is currently waiting for. Only the newest
  // request may write to state: tapping down two levels quickly produces two
  // listings in flight, and the slower one must not land last and rewind the
  // view the user is already looking at.
  const browseRequest = useRef<string | undefined>(undefined);
  const browseCounter = useRef(0);
  // Highest `seq` seen per session.
  //
  // This is what makes reconnecting gap-free. ACP does not replay messages
  // emitted while a client was away, so the relay stores them and hands back
  // everything after the cursor. On a phone this is not an edge case: the
  // socket dies every time the app is backgrounded or the network changes, and
  // without a cursor the tail of every interrupted turn is lost for good.
  const cursors = useRef<Cursors>({});
  // Daemon session ids the daemon says it currently holds.
  //
  // Session ids belong to a daemon *process*, but this list survives restarts
  // and reconnects, so a conversation on screen can name an id that no longer
  // exists — prompting it answered "Unknown session". The daemon reports its
  // open sessions with every provider announcement, and `hello` triggers one,
  // so a stale entry is reopened by `agentSessionId` instead.
  //
  // Undefined means the daemon never said (an older build): assume every id is
  // live rather than resuming conversations that were fine.
  const liveSessions = useRef<Set<string> | undefined>(undefined);
  // Mirrors state.sessions so openSession can look one up without doing that
  // work inside a state updater.
  const sessionsRef = useRef<Session[]>(state.sessions);
  // Synced in an effect rather than during render: writing a ref while
  // rendering is the same impurity the updaters above avoid.
  useEffect(() => {
    sessionsRef.current = state.sessions;
  }, [state.sessions]);

  // Agents by id, so a finished turn can be announced by name without reading
  // state inside the socket handler.
  const providersRef = useRef<Provider[]>(state.providers);
  useEffect(() => {
    providersRef.current = state.providers;
  }, [state.providers]);

  // Held in a ref so a changing handler never re-opens the socket.
  const notifiedTurns = useRef(new WeakSet<TurnFinished>());
  const onTurnFinished = useRef(options.onTurnFinished);
  useEffect(() => {
    onTurnFinished.current = options.onTurnFinished;
  }, [options.onTurnFinished]);
  useEffect(() => {
    const completed = state.completedTurns;
    if (!completed?.length) return;
    for (const turn of completed) {
      if (notifiedTurns.current.has(turn)) continue;
      notifiedTurns.current.add(turn);
      onTurnFinished.current?.(turn);
    }
    setState((prev) => ({ ...prev, completedTurns: prev.completedTurns?.filter((turn) => !completed.includes(turn)) }));
  }, [state.completedTurns]);

  // Same reason, for the rest of the options: the socket effect reads them when
  // it needs them rather than depending on them.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // What each session's agent has said during its current turn, keyed by
  // session, so a notification can quote a conversation that is not on screen.
  //
  // A ref, not state: this is a buffer for one message, it must not re-render
  // anything, and it is written from the socket handler where an updater's
  // "may run twice" rule would corrupt an accumulation.
  const turnText = useRef(new Map<string, string>());

  // Whether this connection has already told the daemon where to push.
  //
  // Reset when the socket is replaced, because a reconnection is exactly when
  // it is worth sending again: a token can rotate while the app is away, and a
  // daemon that restarted has forgotten every token it held.
  const pushRegistered = useRef(false);

  // The agent this device used last, read once from storage.
  //
  // Closing the app is not a decision to go back to whichever agent sorts
  // first, so a launch re-targets the last one used. Undefined means "not read
  // yet": the keychain read starts at mount and finishes long before the
  // daemon's provider list arrives over the socket, so no chip is shown for the
  // wrong agent first.
  const [rememberedProviderId, setRememberedProviderId] = useState<string | undefined>(
    undefined,
  );
  useEffect(() => {
    let cancelled = false;
    loadLastProvider()
      .then((id) => {
        if (!cancelled && id) setRememberedProviderId(id);
      })
      .catch(() => {
        // Secure storage can refuse to read (locked keychain, first run after a
        // restore). Remembering the last agent is a convenience, so falling
        // back to "no preference" is right - crashing the app for it is not.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The agents this machine last reported, restored for a launch with no
  // signal. Without it a cold start offline knew of no agent at all, so a new
  // conversation had nothing to address — the composer took the words and the
  // send was refused, whatever the outbox was willing to hold. See
  // `providerCache.ts`.
  //
  // Applied only over an empty list, and never after: the socket may well have
  // answered before the keychain did, and this must never overwrite what the
  // machine is saying right now with what it said last week.
  useEffect(() => {
    let cancelled = false;
    void loadCachedProviders().then((cached) => {
      if (cancelled || cached.length === 0) return;
      setState((s) => (s.providers.length > 0 ? s : { ...s, providers: cached }));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Written back whenever the machine answers, so the memory is of the last
  // truth rather than the first. Keyed on the ids and their availability, not
  // the array — which is rebuilt by frames that change neither.
  const providerKey = state.providers.map((p) => `${p.id}:${p.available}`).join(",");
  useEffect(() => {
    if (!providerKey) return;
    // The ref, not `state.providers`: reading it here keeps the list out of the
    // dependency array, so the write is driven by the key above.
    void saveCachedProviders(providersRef.current);
  }, [providerKey]);

  // Where the composer points before the user picks anything this launch.
  const fallbackProviderId = defaultProviderId(state.providers, rememberedProviderId);

  // Remember every agent the user lands on — chosen from the drawer, opened
  // from history, or started by the daemon — so the next launch resumes there.
  useEffect(() => {
    if (state.activeProviderId) void saveLastProvider(state.activeProviderId);
  }, [state.activeProviderId]);

  // The agent the composer targets, including the implicit first-available one
  // the user never explicitly chose. `providerRef` only knows about deliberate
  // selections, so on a fresh launch it is empty while the UI already names an
  // agent — and a model picked right then would have nowhere to go. Kept in an
  // effect below for the same reason as `sessionsRef`.
  const targetProviderRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    targetProviderRef.current = state.activeProviderId ?? fallbackProviderId;
  }, [state.activeProviderId, fallbackProviderId]);

  useEffect(
    () =>
      openConnection(
        {
          alive,
          attempts,
          awaitingResume,
          browseRequest,
          channel,
          clearImages,
          cursors,
          fatal,
          liveSessions,
          optionsRef,
          outbox,
          pendingCapabilities,
          pendingProjectSessions,
          pendingStart,
          probed,
          providerRef,
          providersRef,
          pushRegistered,
          queued,
          restoring,
          resume,
          retry,
          sessionRef,
          sessionsRef,
          setGg,
          setKnownCommands,
          setKnownConfigs,
          setState,
          socket,
          storeImage,
          streamBoundary,
          streamForeground,
          streamGeneration,
          turnText,
          viewingRef,
        },
        url,
        deviceId,
        pairingKey,
      ),
    // `pairingKey` and `deviceId` belong here beside `url`: the key is stripped
    // from the url before it is stored (`pairingLink.ts`), so re-pairing to the
    // same machine with a rotated key leaves this effect — and the
    // `SecureChannel` built inside it — holding the key that no longer opens
    // anything. `storeImage` and `clearImages` are `useCallback([])` and never
    // change identity, so listing them costs no reconnects.
    [url, deviceId, pairingKey, storeImage, clearImages],
  );

  /**
   * Send one sealed message.
   *
   * Returns false when nothing was sent, so a caller can report the failure.
   * A missing channel counts as not connected: sending in the clear would put
   * the very content this exists to protect on the wire, so it is not a
   * fallback — it is the failure.
   */
  const post = useCallback((message: unknown) => {
    streamBoundary.current?.();
    const ws = socket.current;
    const secure = channel.current;
    if (!ws || !secure || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(secure.seal(message, envelopeHeader(message))));
    return true;
  }, []);

  // Sent outside any state updater: React may invoke an updater twice, and a
  // socket write in one would ask the daemon for the same picture twice.
  const sendImageRequest = useCallback(
    (uri: string) => {
      const sent = post({
        t: "image.fetch",
        requestId: uri,
        sessionId: sessionRef.current,
        uri,
      });
      storeImage(
        uri,
        sent
          ? { status: "loading" }
          : // Offline: say so rather than spinning forever on a request that was
            // never written to a socket.
            { status: "error", message: "Not connected to your computer" },
      );
    },
    [post, storeImage],
  );

  /**
   * Retry the connection now instead of waiting out the backoff.
   *
   * Called when the app returns to the foreground. iOS suspends the socket on
   * background and it closes without ceremony, so a retry is usually already
   * queued — and because the delay doubles, it can be up to ten seconds out. The
   * user comes back to a conversation reporting itself offline on a network that
   * is perfectly fine, for no reason but a timer's opinion. Returning to the
   * foreground is strong evidence the network is worth another try.
   *
   * The `AppState` listener that calls this lives in the caller rather than in
   * here, and that is load-bearing rather than tidiness: this module is reached
   * by the daemon's own tests through `agentHistory.ts`, which imports `Session`
   * from it. A `react-native` import here drags React Native's global type
   * declarations into the daemon's TypeScript program, where they redefine
   * `setTimeout` as returning a browser-style `number` — breaking every
   * `.unref()` and `Timeout` in the daemon, in files nobody touched. Keeping
   * this hook free of native imports is the same rule the pure modules follow.
   */
  const resumeNow = useCallback(() => {
    resume.current?.();
  }, []);

  // Send a prompt, or hold it until there is a socket: see `deliverPrompt`
  // in `daemonActions.ts`.
  const deliverPrompt = useCallback(
    (sessionId: string, text: string, attachments: readonly PendingAttachment[]): boolean =>
      deliverPromptVia({ localSeq, outbox, sessionRef, setState, viewingRef }, post, sessionId, text, attachments),
    [post],
  );

  const actions = useMemo(
    () =>
      createActions(
        {
          awaitingResume,
          browseCounter,
          browseRequest,
          clearImages,
          goalCounter,
          liveSessions,
          localSeq,
          outbox,
          pendingStart,
          projectRef,
          providerRef,
          queued,
          requestedImages,
          restoring,
          sessionRef,
          sessionsRef,
          setGg,
          setKnownConfigs,
          setState,
          streamBoundary,
          targetProviderRef,
          viewingRef,
        },
        { post, deliverPrompt, sendImageRequest, deviceId },
      ),
    // `deviceId` identifies this phone in the ids `start` mints. It does not
    // change in practice, and listing it costs nothing if it ever does.
    // `requestedImages` is a ref from `useImageCache` and never changes
    // identity; it is listed only because the linter cannot see that through
    // a custom hook.
    [post, deliverPrompt, sendImageRequest, clearImages, deviceId, requestedImages],
  );

  /**
   * Open a GG Coder goal: its live session, else resume the agent's own
   * conversation for it, else start one in the goal's folder (the daemon runs
   * the kickoff turn itself when the goal needs one).
   */
  const openGoal = useCallback(
    (goal: GoalSummary) => {
      const providerId = GOALS_PROVIDER_ID;
      const rows = sessionsRef.current;
      if (goal.sessionId && rows.some((row) => row.id === goal.sessionId) &&
          (liveSessions.current === undefined || liveSessions.current.has(goal.sessionId))) {
        actions.openSession(goal.sessionId);
        return;
      }
      if (goal.agentSessionId) {
        const id = agentSessionKey(providerId, goal.agentSessionId);
        if (!rows.some((row) => row.id === id)) {
          restoring.current = { id, providerId, agentSessionId: goal.agentSessionId, title: goal.name, cwd: goal.path };
        }
        actions.openSession(id);
        return;
      }
      actions.select(providerId);
      actions.selectProject(providerId, goal.path);
      actions.start(providerId);
    },
    [actions],
  );

  // Goals live on the desktop and change there too: ask whenever the socket
  // comes up with GG Coder available. An older daemon answers with an error
  // the reducer records, and the drawer simply says nothing about goals.
  const hasGgCoder = state.providers.some((provider) => provider.id === GOALS_PROVIDER_ID && provider.available);
  const refreshGoals = actions.refreshGoals;
  useEffect(() => {
    if (state.status === "online" && hasGgCoder) refreshGoals();
  }, [state.status, hasGgCoder, refreshGoals]);

  // Give up on a conversation that is taking impossibly long to open.
  //
  // Every other spinner in this app has something that ends it: a turn ends
  // with `session.idle`, a connection ends with an open socket or a retry. The
  // resume skeleton was the exception — it ended only when the transcript
  // arrived, so if the transcript never arrived it did not end at all. That is
  // the state that had to be force-quit out of. See `stalledLoading`.
  //
  // `busy` goes with it: the two are set together on the way in, and clearing
  // only the skeleton would reveal a composer that still thought a turn was
  // running.
  useEffect(() => {
    if (!state.loadingSession) return;
    const timer = setTimeout(() => {
      const failure = stalledLoading(localSeq.current++);
      setState((s) =>
        s.loadingSession
          ? {
              ...s,
              loadingSession: false,
              busy: false,
              activity: IDLE_ACTIVITY,
              restoreError: s.restoreTarget ? failure.text : undefined,
              turns: s.restoreTarget ? s.turns : capTurns([...s.turns, failure]),
            }
          : s,
      );
    }, LOADING_SESSION_TIMEOUT);
    return () => clearTimeout(timer);
    // `sessionId` restarts the clock when one conversation is opened while
    // another is still loading: without it the second would inherit whatever
    // was left of the first one's budget and could fail in a second or two.
  }, [state.loadingSession, state.sessionId, state.restoreTarget?.id]);

  // Which project the bar above the composer names.
  //
  // Driven by the session and agent on screen rather than by a one-off request:
  // opening a past conversation, switching agents or reconnecting all change
  // the answer, and each of those is exactly a change to these values. Live
  // edits are covered by the `session.idle` refresh in the socket handler, and
  // the cases that clear the row without changing any of these carry the nonce.
  const workspaceProviderId = state.activeProviderId ?? fallbackProviderId;
  // Before a session exists this is what the context row describes: the project
  // the next prompt will open in, rather than whichever one the agent happened
  // to use last. Named here rather than inline in the dependency array so the
  // one value that matters is what the effect keys on — the whole `projectPath`
  // map changes when any *other* agent's project is chosen.
  const workspaceCwd = workspaceProviderId ? state.projectPath[workspaceProviderId] : undefined;
  useEffect(() => {
    if (state.status !== "online") return;
    post({
      t: "workspace.status",
      sessionId: state.sessionId,
      providerId: workspaceProviderId,
      cwd: workspaceCwd,
    });
  }, [
    post,
    state.status,
    state.sessionId,
    workspaceProviderId,
    workspaceCwd,
    // Leaving a conversation changes none of the above when the project is
    // already the chosen one, and the row would stay empty until a prompt.
    state.workspaceNonce,
  ]);

  // Fall back to the last selectors this agent advertised, so the model picker
  // is available on an empty screen instead of only mid-conversation.
  //
  // The provider defaults the same way the UI does: before an explicit choice
  // this launch, the composer already targets the remembered agent, so the
  // selector has to describe that same agent rather than nothing.
  const effectiveProviderId = state.activeProviderId ?? fallbackProviderId;
  const configOptions = visibleConfigs({
    session: state.configOptions,
    provider: effectiveProviderId ? knownConfigs[effectiveProviderId] : undefined,
    // An open conversation is the one case where the provider's list is not the
    // answer: a restored one comes back at the selectors it was last used with,
    // which need not be the remembered ones, and they arrive a moment after the
    // session does. A guess about which model is answering is the one thing this
    // pill must never be — so it shows nothing until the session says.
    inConversation: state.sessionId !== undefined || state.loadingSession,
  });
  // The live session's own list wins; otherwise the provider's, which is what
  // agents that never send the notification rely on entirely.
  const commands =
    state.commands.length > 0
      ? state.commands
      : (effectiveProviderId ? knownCommands[effectiveProviderId] : undefined) ?? [];
  const loadingSessions = effectiveProviderId
    ? pendingCapabilities.current.has(effectiveProviderId) ||
      state.loadingProject !== undefined
    : false;

  // Fetch the chosen project's conversations.
  //
  // An effect rather than part of `selectProject` so the one rule covers a
  // reconnect too: the socket dies on every backgrounding, and a request
  // written to the dead one is never answered.
  const openProjectPath = effectiveProviderId
    ? state.projectPath[effectiveProviderId]
    : undefined;
  useEffect(() => {
    if (state.status !== "online" || !effectiveProviderId || !openProjectPath) return;
    const key = `${effectiveProviderId}:${openProjectPath}`;
    if (pendingProjectSessions.current.has(key)) return;
    pendingProjectSessions.current.add(key);
    const sent = post({
      t: "provider.sessions",
      providerId: effectiveProviderId,
      cwd: openProjectPath,
    });
    if (!sent) {
      pendingProjectSessions.current.delete(key);
      return;
    }
    setState((s) => ({ ...s, loadingProject: key }));
  }, [post, state.status, effectiveProviderId, openProjectPath]);

  return {
    ...state,
    ...actions,
    resumeNow,
    setForeground,
    // Exported so the UI names the same agent the composer targets: the drawer
    // and top bar must not show Claude Code while a prompt would go elsewhere.
    effectiveProviderId,
    configOptions,
    /** Last selectors each provider advertised, by provider id (goal worker model picker). */
    providerConfigs: knownConfigs,
    commands,
    loadingSessions,
    images,
    gg,
    hasGgCoder,
    openGoal,
  };
}
