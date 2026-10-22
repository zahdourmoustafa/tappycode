/**
 * Module-level pieces of the daemon connection hook (`useDaemon.ts`): its
 * state shape, timeouts and the small turn builders it shares with the socket
 * handler and the actions. Platform-free; nothing here imports React.
 */
import type { LiveStreamIdentity } from "./smoothText";
import type { RestoreTarget } from "./restoreState";
import type { Activity, TurnReceipt } from "./activity";
import type { ChatImage } from "./images";
import type { SlashCommand } from "./slashCommands";
import type { WireProject } from "./projects";
import type { ContextUsage } from "./contextUsage";
import type {
  Status,
  Provider,
  PermissionRequest,
  Turn,
  ConfigOption,
  Session,
  Workspace,
  WorkspaceBrowse,
} from "./daemonTypes";
import type { Terminal, TerminalMessage, TerminalTranscript } from "./terminalTyping";

/**
 * Failed connection attempts before the app stops saying "connecting".
 *
 * With the capped exponential backoff below, four attempts is about fifteen
 * seconds — past a network switch or a daemon restart, and well short of the
 * forever that a rotated pairing used to spend pretending to connect.
 */
export const STALLED_ATTEMPTS = 4;

/**
 * How long a conversation may sit as a skeleton before the app admits it is
 * not coming.
 *
 * Generous on purpose. A resumed transcript reveals on its *first* batch rather
 * than its last, so even a thousand-event conversation clears this in the time
 * the agent takes to attach — which means anything still waiting at twenty
 * seconds is not slow, it is lost. Erring the other way is worse than it
 * sounds: cutting a live resume short would replace a transcript that was about
 * to appear with a message saying it failed.
 */
export const LOADING_SESSION_TIMEOUT = 20_000;

/**
 * How long a socket may stay in CONNECTING before it is treated as dead.
 *
 * Ten seconds is well past any real handshake, including a relay cold start,
 * and well short of the operating system's own connect timeout — which is the
 * point. The platform does eventually give up; it just does so on a timescale
 * where the user has already decided the app is broken.
 */
export const CONNECT_TIMEOUT = 10_000;

/**
 * `WebSocket.CONNECTING`, by value.
 *
 * React Native's WebSocket is not the DOM one, and the static constants are
 * absent on some engines while the instance `readyState` is always the same
 * standard number. Comparing against the literal is the portable form, and the
 * name is what keeps it readable.
 */
export const WEBSOCKET_CONNECTING = 0;

export interface State {
  status: Status;
  /**
   * A refusal the daemon explained, which reconnecting cannot fix.
   *
   * A wrong protocol version or a rotated key both produce a socket that opens
   * and is then closed. Without somewhere to put the reason, the app would sit
   * in an endless reconnect loop showing "Connecting..." — which is the same
   * thing it shows when the desktop is simply asleep, and tells the one user who
   * needs to act nothing at all.
   */
  fatal?: string;
  /**
   * Set once reconnecting has failed enough times to stop being a blip.
   *
   * Distinct from `fatal`, and deliberately weaker. The refusals that produce a
   * dead pairing happen *below* the WebSocket — the daemon answers 401, the
   * relay answers 409 for a room with no machine in it — so no frame ever
   * arrives to explain them, and the app cannot tell a rotated token from a
   * laptop that is merely asleep. Both must keep retrying, because one of them
   * comes back on its own.
   *
   * What must not continue is the claim that a connection is in progress.
   * "Connecting to your machine..." held forever is the state that sent someone
   * to a stuck screen with nothing to act on.
   */
  unreachable?: boolean;
  providers: Provider[];
  /**
   * A newer tappy the paired computer has not got, when there is one.
   *
   * Not about this app: the App Store handles that. This is the daemon on the
   * desk, which has no screen to tell anyone with.
   */
  update?: { latest: string; automatic: boolean };
  /**
   * The paired computer's own name (its hostname), as it reports itself. Shown
   * in settings in place of the relay's address. Absent from a daemon too old
   * to send it: settings then falls back to the status alone.
   */
  machineName?: string;
  sessionId?: string;
  /** The agent the composer will talk to. Chosen before a session exists. */
  activeProviderId?: string;
  turns: Turn[];
  /** Every conversation this client has seen, newest first. */
  sessions: Session[];
  /** Selectors for the open session, in the agent's own priority order. */
  configOptions: ConfigOption[];
  /**
   * Slash commands the agent offers, minus the ones this app hides. Depends on
   * the project it opened, so it is per session rather than per provider.
   */
  commands: SlashCommand[];
  permission?: PermissionRequest;
  busy: boolean;
  /**
   * Tool calls in the open session's current turn, folded live.
   *
   * Only the open session: this drives one line under the transcript, and a
   * background agent's tools are not what the reader is watching. It resets
   * with every prompt, so it is never a log — it is the present tense.
   */
  activity: Activity;
  /**
   * What the last turn did, shown once it is over and cleared when the next
   * one starts. Absent for a turn this client did not time itself.
   */
  receipt?: TurnReceipt;
  /**
   * At least one agent has been asked what it holds and has not answered yet.
   * The drawer shows skeleton rows instead of a false "No conversations yet".
   */
  loadingSessions: boolean;
  /** A stored transcript is loading and is not ready to reveal yet. */
  loadingSession: boolean;
  /** Ephemeral presentation identity, never persisted or sent over the wire. */
  activeStream?: LiveStreamIdentity;
  restoreTarget?: RestoreTarget;
  restoreError?: string;
  /** Terminal callbacks drain after this state (and its final text) commits. */
  completedTurns?: readonly TurnFinished[];
  /** Project and git state for the session on screen. Absent until asked. */
  workspace?: Workspace;
  /**
   * Browsing the desktop for a project to start in.
   *
   * Absent until the user opens the picker. This is the only way into an agent
   * with no history: its project list is folded from its own past sessions, so
   * a freshly installed one has nothing to offer.
   */
  browse?: WorkspaceBrowse;
  /**
   * How full the agent's context window is, for the session on screen.
   *
   * Absent until the agent volunteers one, and it stays absent for agents that
   * never do (GG Coder sends none today) — which is why the row omits the
   * reading entirely rather than showing a confident 0%.
   */
  usage?: ContextUsage;
  /**
   * Bumped whenever the answer is stale for a reason the request itself cannot
   * see.
   *
   * The workspace request is driven by session, provider and chosen project, so
   * it re-asks when one of those changes. Leaving a conversation changes none of
   * them: from the empty screen, with a project already picked, "new chat"
   * clears the workspace and every dependency stays equal — so nothing re-asked
   * and the project row simply vanished until a prompt created a session. This
   * is the explicit "ask again" the effect otherwise has no way to hear.
   */
  workspaceNonce: number;
  /**
   * Agents running in a terminal on the laptop that the composer can type into,
   * keystroke by keystroke. Empty until the daemon says otherwise, and from an
   * older daemon that has never heard of them.
   */
  terminals: Terminal[];
  /**
   * Whether the daemon has sent its terminal list since this app started.
   * Distinguishes "no terminals open" from "not told yet", which decides which
   * terminals count as already open when the app arrived.
   */
  terminalsKnown: boolean;
  /**
   * Each terminal's conversation, as the agent wrote it: what was typed on
   * either side, and what the agent answered. Keyed by terminal id.
   */
  terminalTranscripts: Record<string, TerminalTranscript>;
  /**
   * Each terminal's run in progress as its screen shows it, for an agent that
   * writes its file only when the run ends (GG Coder). Shown after the
   * transcript; the daemon empties it once the file has the turn.
   */
  terminalLive: Record<string, TerminalMessage[]>;
  /**
   * An agent the phone asked to open in a terminal on the computer: waiting for
   * its window, opened, or refused with a reason. Cleared once the terminal it
   * opened has arrived and been followed.
   */
  terminalLaunch?: {
    agent: Terminal["agent"];
    cwd: string;
    status: "opening" | "opened" | "failed";
    app?: string;
    message?: string;
    at: number;
  };
  /**
   * Every project each agent has worked in, keyed by provider id.
   *
   * Folded by the daemon from the agent's whole history, not from `sessions`:
   * that list is capped at the newest conversations and so describes a week's
   * work rather than the set of projects a user can return to.
   */
  projects: Record<string, WireProject[]>;
  /**
   * The project the drawer is narrowed to, per agent. Absent means all of
   * them, which is where every agent starts.
   *
   * Per agent rather than one global choice: the projects belong to an agent,
   * so switching apps and back must not carry a path the new agent has never
   * opened — and must not silently forget the one you just picked either.
   */
  projectPath: Record<string, string>;
  /**
   * `providerId:cwd` of the project whose conversations are being fetched.
   *
   * In state rather than a ref because it decides between the skeleton and
   * "No conversations in tappy yet" — a ref would be read during a render
   * nothing schedules, so the false empty state would show until the reply
   * landed, which is the flash this exists to prevent.
   */
  loadingProject?: string;
}

/**
 * A user turn rendered before the daemon has echoed it back. Its id is replaced
 * with the server's once the echo arrives, so it never renders twice.
 */
export function localTurn(
  seq: number,
  text: string,
  images?: ChatImage[],
  queued?: boolean,
): Turn {
  // `key` outlives the id swap in the echo path, so the cell rendering this
  // prompt survives reconciliation instead of remounting.
  return {
    id: `local:${seq}`,
    key: `local:${seq}`,
    role: "user",
    text: text.trim(),
    // Rendered from the phone's own copy, so an attached photo appears the
    // instant it is sent rather than after a round trip to fetch back the file
    // this device just uploaded.
    ...(images?.length ? { images } : {}),
    // Only when it is true: an ordinary send must not carry a false flag into
    // every turn comparison in the thread.
    ...(queued ? { queued: true as const } : {}),
  };
}

/**
 * Marks a first prompt that was stopped while its agent was still starting, so
 * it never reached the daemon. Carries a `local:` id like the prompt above it:
 * `session.started` keeps only locally-created turns, and this one belongs with
 * the message it explains.
 */
export function stoppedBeforeSend(seq: number): Turn {
  return {
    id: `local:${seq}`,
    key: `local:${seq}`,
    role: "system",
    text: "Stopped before the agent received this.",
  };
}

/**
 * Marks a conversation that was asked for and never arrived.
 *
 * Reopening a session is two messages far apart: `session.resume` goes out, and
 * the transcript follows once the agent has attached. Between them the screen
 * is a skeleton with no composer and no controls. Nothing ever timed that out,
 * so a resume whose answer was lost — the socket dropped, the agent failed to
 * spawn, the daemon was killed mid-handshake — left the phone showing a
 * loading conversation for as long as the app stayed open, with force-quitting
 * the only way back. The wait now ends, and says so where the transcript would
 * have been.
 */
export function stalledLoading(seq: number): Turn {
  return {
    id: `local:${seq}`,
    key: `local:${seq}`,
    role: "system",
    text: "Couldn't load this conversation. Open it again to retry.",
  };
}

export function firstUserText(turns: Turn[]): string | undefined {
  const first = turns.find((turn) => turn.role === "user");
  return first?.text.trim().slice(0, 60);
}



/**
 * A turn that just ended, reported to the app so it can announce it.
 *
 * The hook reports rather than decides: whether this is worth a banner depends
 * on whether the app is on screen, which only the component tree knows. See
 * `notificationPolicy.ts`.
 */
export interface TurnFinished {
  sessionId: string;
  /** Project folder as the daemon stamped it, e.g. "tappy". */
  folder?: string;
  /** Display name of the agent that ran it. */
  agentName?: string;
  /** What the agent said this turn, for the notification body. */
  lastText?: string;
  /** The conversation on screen when this landed, if any. */
  activeSessionId?: string;
}

/**
 * How much of an agent's turn is kept for a notification body.
 *
 * Only the first usable line is ever rendered, so this only has to be long
 * enough to contain it past any leading blank lines or a fenced block.
 */
export const NOTICE_BUFFER = 2000;


/** Where the daemon should push when this phone's app is asleep. */
export interface PushAddress {
  token: string;
  platform: "ios" | "android";
}

export interface DaemonOptions {
  /** Called once per finished turn, for any session — not just the open one. */
  onTurnFinished?: (turn: TurnFinished) => void;
  /**
   * This device's push address, asked for once the channel is up.
   *
   * Injected rather than imported because obtaining it means calling into Expo
   * and React Native, and this module is deliberately platform-free — the
   * daemon's own test suite imports app sources directly, so an SDK import here
   * drags React Native's globals into a Node typecheck and breaks it. The screen
   * supplies the platform half; this file only puts it on the wire.
   *
   * Resolves undefined when there can be no push: a simulator, a fresh clone
   * with no EAS project, or a refused permission.
   */
  pushAddress?: () => Promise<PushAddress | undefined>;
  /**
   * Whether the daemon now has somewhere to push, told to the screen.
   *
   * Reports acceptance, not acquisition: holding a token means nothing if the
   * daemon never stored it. A daemon older than `app.push` answers
   * `unknown_message`, and one that has not seen this device's `hello` refuses
   * it — in both cases no push will ever arrive, and the screen has to know so
   * it keeps raising the local banner instead of going silent.
   */
  onPushRegistered?: (registered: boolean) => void;
}
