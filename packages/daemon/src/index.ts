/**
 * tappy daemon.
 *
 * Runs on the user's machine. Owns provider discovery, agent processes, and the
 * per-session event log, then bridges all of it to the relay over one WebSocket.
 *
 * It is deliberately the fan-out point: ACP is a 1-client-to-1-agent protocol,
 * so the daemon — not the agent — is what lets a phone and a desktop observe the
 * same session at the same time.
 */
import { loadProviders, isAvailable, unavailableReason } from "./providers/registry.js";
import type { AskAnswer } from "./acp/connect.js";
import { SessionLog } from "./session/log.js";
import { readDisabled } from "./providers/enabled.js";
import { discardAttachments } from "./attachments.js";
import { folderName } from "./workspace.js";
import { writeConfigPref } from "./config-prefs.js";
import { writeSessionPrefs } from "./session-prefs.js";
import type { wire } from "@tappy/protocol";
import { DaemonConnectSession } from "./daemon/connect-session.js";
import {
  codexHome,
  codexSource,
  ggcoderSessions,
  ggcoderSource,
} from "./terminals/agent-mirrors.js";
import { claudeHome, claudeSource } from "./terminals/claude-mirror.js";
import {
  launchAgent,
  type LaunchOptions,
  type LaunchResult,
  rememberTerminalApp,
} from "./terminals/launch.js";
import { samePath, terminalPlatform } from "./terminals/platform.js";
import { GgcoderLog, type LogRun } from "./terminals/ggcoder-log.js";
import { dirname, join } from "node:path";
import { type MirrorSource, TerminalMirror } from "./terminals/mirror.js";
import { TerminalRegistry } from "./terminals/registry.js";
import { pushFinishedTurn } from "./push.js";

/** How each terminal agent is named in a notification. */
const TERMINAL_AGENT_NAMES = { claude: "Claude", codex: "Codex", ggcoder: "GG Coder" } as const;
import {
  GG_GOALS_ID,
  GG_PROVIDER_ID,
  REPLAY_BATCH_SIZE,
  goalsProviderFrom,
  queuedForWire,
  rememberTurnText,
  type ActiveSession,
} from "./daemon/types.js";

export {
  GG_GOALS_ID,
  GG_PROVIDER_ID,
  goalsRoot,
  withStoredPrefs,
  type PromptOutcome,
  type ProviderCapabilities,
} from "./daemon/types.js";

export class Daemon extends DaemonConnectSession {
  /**
   * Agents started the ordinary way in a terminal, that the phone can type into.
   * Every change goes to every client, the same fan-out as the session log.
   */
  readonly terminals = new TerminalRegistry(
    () => {
      this.syncMirrors();
      this.announceTerminals();
    },
    Date.now,
    {
      activity: (id, activity) => this.terminalActivity(id, activity),
      live: (id, live) => {
        this.screenLive.add(id);
        this.terminalLive(id, live);
      },
    },
  );

  /** Terminals whose wrapper reads the screen itself; GG Coder's log is not needed for them. */
  private readonly screenLive = new Set<string>();
  /** GG Coder's debug log, followed while any GG Coder terminal is open (`ggcoder-log.ts`). */
  private ggcoderLog?: GgcoderLog;

  /**
   * What GG Coder's log says one of its processes is doing, for the terminals
   * running it — only those whose wrapper predates the screen reader, so the
   * two never both drive one terminal.
   */
  private ggcoderRun(run: LogRun) {
    for (const link of this.terminals.links()) {
      if (link.agent !== "ggcoder" || link.pid !== run.pid || this.screenLive.has(link.id))
        continue;
      // Activity first: a run starting sets the previous screen aside, and the
      // run itself then replaces it.
      this.terminalActivity(link.id, run.activity);
      this.terminalLive(link.id, { turn: run.turn, messages: run.messages });
    }
  }

  /**
   * The run each terminal's screen shows that its file does not have yet.
   *
   * Shown only while it is news: while the agent works, and for a moment after
   * it stops while the file is written. The file wins as soon as it has the
   * turn — the first time the mirror appends a message from the person, the
   * live copy of that turn is retired for good, so the phone never shows the
   * same turn twice. Retired too after a grace period if the file never comes
   * (an agent that crashed mid-turn), rather than a stale screen staying up.
   */
  private readonly live = new Map<
    string,
    {
      turn: number;
      messages: wire.TerminalMessage[];
      retired?: number;
      sent: string;
      grace?: ReturnType<typeof setTimeout>;
      /**
       * Whether `messages` was read during this run. A run starting is
       * reported before its screen is; until then `messages` is the screen
       * from before, which must not be shown as the new run.
       */
      fresh?: boolean;
    }
  >();
  private static readonly LIVE_GRACE_MS = 15_000;

  private terminalLive(id: string, report: { turn: number; messages: wire.TerminalMessage[] }) {
    const state = this.live.get(id) ?? { turn: report.turn, messages: [], sent: "[]" };
    this.live.set(id, state);
    if (report.turn !== state.turn) {
      state.turn = report.turn;
      clearTimeout(state.grace);
      state.grace = undefined;
    }
    state.messages = report.messages;
    state.fresh = true;
    this.publishLive(id);
  }

  /** Send a terminal's live run if it is worth showing, or take it down if it is not. */
  private publishLive(id: string) {
    const state = this.live.get(id);
    if (!state) return;
    const terminal = this.terminals.list().find((t) => t.id === id);
    const showing =
      state.fresh === true &&
      state.retired !== state.turn &&
      (terminal?.activity === "working" || state.grace !== undefined);
    const messages = showing ? state.messages : [];
    const key = JSON.stringify(messages);
    if (key === state.sent) return;
    state.sent = key;
    this.send({ t: "terminal.live", terminalId: id, messages } satisfies wire.TerminalLive);
  }

  /** What the agent said last in the run on screen, while the file may not have it yet. */
  private liveAgentText(id: string): string | undefined {
    const state = this.live.get(id);
    if (!state || state.retired === state.turn) return undefined;
    return [...state.messages].reverse().find((m) => m.role === "agent")?.text;
  }

  /** The run on screen is now in the file, or never will be: stop showing it. */
  private retireLive(id: string) {
    const state = this.live.get(id);
    if (!state) return;
    clearTimeout(state.grace);
    state.grace = undefined;
    state.retired = state.turn;
    this.publishLive(id);
  }

  /** Each terminal's conversation, followed for the phone. */
  private readonly mirrors = new Map<string, TerminalMirror>();

  /**
   * Where a terminal's conversation is, by agent. Claude and Codex are found
   * through the agent's own process, so they need the pid a current wrapper
   * sends; GG Coder through its project's folder.
   */
  private mirrorSource(
    link: ReturnType<TerminalRegistry["links"]>[number],
  ): MirrorSource | undefined {
    switch (link.agent) {
      case "claude":
        return link.pid
          ? claudeSource(link.pid, link.cwd, claudeHome(this.env), link.startedAt)
          : undefined;
      case "codex":
        return link.pid
          ? codexSource(link.pid, codexHome(this.env), { cwd: link.cwd, openedAt: link.startedAt })
          : undefined;
      case "ggcoder":
        return ggcoderSource(link.cwd, link.startedAt, ggcoderSessions(this.env));
    }
  }

  /** Notifications waiting to see whether a change of activity sticks. */
  private readonly pendingNotices = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * What an agent in a terminal says it is doing, and the two moments worth a
   * notification: a turn finishing, and the agent stopping to ask something.
   * The first reading after a terminal registers (or the daemon restarts) is
   * only a baseline — nothing has happened yet.
   *
   * Both wait a moment before sending: an agent can flick to idle between two
   * steps of one turn, and the question it stops on is read off its screen a
   * beat after its status says it is waiting.
   */
  private terminalActivity(id: string, activity: "working" | "waiting" | "idle") {
    const before = this.terminals.setActivity(id, activity);
    const live = this.live.get(id);
    // A run starting: what the screen showed until now belongs to the one before.
    if (live && activity === "working" && before !== "working") live.fresh = false;
    if (live && before === "working" && activity !== "working" && live.retired !== live.turn) {
      // Stopped: the file is about to be written. Keep the live copy up until
      // it is, but not for ever.
      clearTimeout(live.grace);
      live.grace = setTimeout(() => this.retireLive(id), Daemon.LIVE_GRACE_MS);
      live.grace.unref?.();
    }
    if (live) this.publishLive(id);
    if (before === undefined || before === activity) return;
    clearTimeout(this.pendingNotices.get(id));
    this.pendingNotices.delete(id);
    const finished = before === "working" && activity === "idle";
    const asking = activity === "waiting";
    if (!finished && !asking) return;
    const timer = setTimeout(
      () => {
        this.pendingNotices.delete(id);
        const terminal = this.terminals.list().find((t) => t.id === id);
        if (!terminal || terminal.activity !== activity) return;
        const question = this.terminals.questionOf(id);
        void pushFinishedTurn(this.pushTargets, {
          sessionId: `term:${id}`,
          folder: terminal.folder,
          agentName: TERMINAL_AGENT_NAMES[terminal.agent],
          lastText: asking
            ? `Needs your answer: ${question?.text ?? "it is waiting for you in the terminal."}`
            : (this.liveAgentText(id) ?? this.mirrors.get(id)?.lastAgentText()),
        });
      },
      finished ? 2500 : 1500,
    );
    timer.unref?.();
    this.pendingNotices.set(id, timer);
  }

  /** One mirror per terminal whose conversation can be found; none for the rest. */
  private syncMirrors() {
    // Where this person runs agents, so one started from the phone opens there.
    const newest = this.terminals.links().sort((a, b) => b.startedAt - a.startedAt)[0];
    if (newest?.app) void rememberTerminalApp(newest.app, this.env).catch(() => {});
    const live = new Map(this.terminals.links().map((link) => [link.id, link]));
    for (const [id, mirror] of this.mirrors) {
      if (live.has(id)) continue;
      mirror.stop();
      this.mirrors.delete(id);
      clearTimeout(this.pendingNotices.get(id));
      this.pendingNotices.delete(id);
    }
    for (const id of this.screenLive) if (!live.has(id)) this.screenLive.delete(id);
    const ggcoders = [...live.values()].filter((link) => link.agent === "ggcoder" && link.pid);
    if (ggcoders.length === 0) {
      this.ggcoderLog?.stop();
      this.ggcoderLog = undefined;
    } else if (!this.ggcoderLog) {
      this.ggcoderLog = new GgcoderLog(
        join(dirname(ggcoderSessions(this.env)), "debug.log"),
        (run) => this.ggcoderRun(run),
      );
      void this.ggcoderLog.begin();
    } else {
      // A terminal opened while the log was already followed: tell it where its process is.
      for (const run of this.ggcoderLog.runs()) {
        if (ggcoders.some((link) => link.pid === run.pid && !this.live.has(link.id)))
          this.ggcoderRun(run);
      }
    }
    for (const [id, state] of this.live) {
      if (live.has(id)) continue;
      clearTimeout(state.grace);
      this.live.delete(id);
    }
    for (const link of live.values()) {
      if (this.mirrors.has(link.id)) continue;
      const source = this.mirrorSource(link);
      if (!source) continue;
      const mirror = new TerminalMirror(
        source,
        (update) => {
          this.send({ t: "terminal.transcript", terminalId: link.id, ...update });
          // The file now holds a turn from the person: whatever the screen
          // showed live of it is there too. That includes the first read of a
          // file found for the first time — GG Coder creates the file with a
          // conversation's first run. Not while a run is going, though: a file
          // written as the next run starts is the previous one's turn, and the
          // run on screen is still news.
          const working =
            this.terminals.list().find((t) => t.id === link.id)?.activity === "working";
          if (!working && update.messages.some((m) => m.role === "user")) this.retireLive(link.id);
        },
        undefined,
        (conversation) => this.terminals.setConversation(link.id, conversation),
        (activity) => this.terminalActivity(link.id, activity),
      );
      this.mirrors.set(link.id, mirror);
      mirror.begin();
    }
  }

  /** Tell every client which terminals exist now. */
  announceTerminals() {
    this.send(this.terminalsFrame());
  }

  protected override isTerminalProject(cwd: string): boolean {
    const platform = terminalPlatform(this.env);
    return this.terminals.list().some((terminal) => samePath(terminal.cwd, cwd, platform));
  }

  /** Open an agent in a terminal on this computer, for the phone. See `terminals/launch.ts`. */
  launchTerminal(options: Omit<LaunchOptions, "env">): Promise<LaunchResult> {
    return launchAgent({ ...options, env: this.env });
  }

  terminalsFrame(): wire.Terminals {
    return { t: "terminals", terminals: this.terminals.list() };
  }

  /**
   * Everything a client is sent the moment its `hello` is accepted: what it
   * missed while away, then which terminals it can type into.
   *
   * One method because both transports answer `hello` themselves rather than
   * through `handleMessage`; a frame added to only one of them is a phone that
   * works at home and not on the bus. The terminal list was exactly that bug.
   */
  greet(
    cursors: Record<string, number>,
  ): Array<wire.Replay | wire.Terminals | wire.TerminalTranscript | wire.TerminalLive> {
    const transcripts = [...this.mirrors].map(([terminalId, mirror]): wire.TerminalTranscript => ({
      t: "terminal.transcript",
      terminalId,
      ...mirror.snapshot(),
    }));
    // A run in progress, for a phone that connects in the middle of it.
    const live = [...this.live]
      .filter(([, state]) => state.sent !== "[]")
      .map(([terminalId, state]): wire.TerminalLive => ({
        t: "terminal.live",
        terminalId,
        messages: JSON.parse(state.sent) as wire.TerminalMessage[],
      }));
    return [...this.catchUp(cursors), this.terminalsFrame(), ...transcripts, ...live];
  }

  /** Point the daemon at a transport. Called with the relay socket's `send`. */
  attach(send: (message: unknown) => void) {
    this.send = send;
    // Started here rather than in the constructor so building a Daemon in a test
    // does not leave a timer running. `unref` for the same reason: this must
    // never be the thing keeping the process alive.
    if (!this.reaper) {
      this.reaper = setInterval(() => this.reapIdleSessions(), Daemon.REAP_INTERVAL_MS);
      this.reaper.unref?.();
    }
  }

  /** Record a pending update and tell every client at once. */
  setUpdateStatus(status: { latest: string; automatic: boolean } | undefined) {
    this.updateStatus = status;
    this.announceProviders();
  }

  /**
   * Why this daemon is not safe to end right now, or undefined if it is.
   *
   * "Quiet" is the precondition for exiting to pick up a new binary. It is not
   * about elapsed time: a session can be silent for minutes while an agent
   * thinks or runs a long tool, and ending the process then loses that turn's
   * work with no way to resume it mid-flight.
   *
   * Three things make a daemon busy, and each is a different kind of loss:
   * a turn in flight (`working`) would be abandoned mid-write; an open
   * permission is a question already on someone's screen, and killing it makes
   * the tap do nothing; a session still opening has an agent process spawned
   * and not yet usable, which would be leaked rather than closed cleanly.
   *
   * Returns a reason rather than a boolean so a caller can log *why* it is
   * waiting — a daemon that never seems to update is otherwise unexplainable.
   */
  busyReason(): string | undefined {
    for (const [sessionId, session] of this.sessions) {
      if (session.working) return `session ${sessionId} is mid-turn`;
      if (
        (session.permissions?.size ?? 0) > 0 ||
        (session.working && (session.asks?.size ?? 0) > 0)
      ) {
        return `session ${sessionId} is waiting on an approval`;
      }
      if (!session.agentSessionId) return `session ${sessionId} is still opening`;
    }
    return undefined;
  }

  /**
   * End one conversation and release everything it holds.
   *
   * The single close path, because there are four callers — the idle reaper, the
   * live-session cap, an agent being disabled, and shutdown — and each used to
   * do its own subset. Only shutdown discarded the attachment files, so every
   * photo sent to a conversation that was later reaped stayed in the tempdir for
   * the daemon's lifetime.
   *
   * Deliberately silent: the callers batch one `announceProviders` per pass,
   * because the message is a full snapshot of `activeSessions`.
   */
  private closeSession(sessionId: string, session: ActiveSession) {
    // Every device closes the card on this, before the session goes.
    for (const requestId of [...(session.asks?.keys() ?? [])]) this.closeAsk(session, requestId);
    if (session.replayTimer) clearTimeout(session.replayTimer);
    session.replayTimer = undefined;
    session.handle?.close();
    // The files were only ever a delivery mechanism for the agent that is now
    // gone. Best effort, and in the tempdir either way.
    void discardAttachments(session.log.sessionId);
    this.sessions.delete(sessionId);
  }

  /**
   * Close agents for conversations nobody has touched in a long time.
   *
   * The process is the expensive part, not the conversation: the transcript is
   * on disk and the agent keeps its own history, so a closed session reopens by
   * resuming. What is being reclaimed is a language server sitting at 90-370MB
   * for a chat that was finished hours ago.
   *
   * Clients are told through the ordinary `providers` announce, whose
   * `activeSessions` is exactly the list of sessions this process still holds.
   * The app already reacts to an id disappearing from it — that is how it
   * survives a daemon restart — and resumes the conversation on screen instead
   * of prompting an id that no longer exists. Reaping deliberately reuses that
   * path rather than inventing a second one, so an older app on TestFlight
   * handles this correctly too.
   *
   * @param now Injectable for tests; the reaper is on an hour-long clock.
   * @returns The session ids closed.
   */
  reapIdleSessions(now: number = Date.now()): string[] {
    const reaped: string[] = [];
    for (const [sessionId, session] of this.sessions) {
      // A turn in flight is never idle, however quiet it has gone: an agent can
      // spend minutes inside one tool call without emitting anything. Unless it
      // is not working at all but waiting on an approval nobody answered, which
      // is the one kind of stopped that lasts for ever.
      // An open ask_user question is the same kind of wait.
      // Only while working: an idle session with an open ask is just idle.
      const blocked =
        (session.permissions?.size ?? 0) > 0 ||
        (session.working === true && (session.asks?.size ?? 0) > 0);
      if (session.working && !blocked) continue;
      const ttl = blocked ? Daemon.BLOCKED_TTL_MS : Daemon.SESSION_TTL_MS;
      if (now - session.lastUsedAt < ttl) continue;
      // Nothing to resume from means nothing to come back to. A conversation
      // the agent never named would be lost rather than closed, so it is kept
      // — these are rare and short-lived, since the id arrives during the
      // handshake.
      if (!session.agentSessionId) continue;
      this.closeSession(sessionId, session);
      reaped.push(sessionId);
    }
    // Announce once for the whole pass, not once per session: the message is a
    // full snapshot, so repeating it per id would be the same list several times.
    if (reaped.length > 0) this.announceProviders();
    return reaped;
  }

  /**
   * Close the least recently used conversations until only `MAX_LIVE_SESSIONS`
   * hold an agent. Called as a new one opens, so the ceiling is enforced at the
   * moment memory would actually grow rather than up to five minutes later.
   *
   * Least recently *used*, not oldest: a conversation started this morning and
   * still being worked in outranks one opened ten minutes ago and abandoned.
   *
   * @param exempt The session being opened, which must never be the one closed.
   * @returns The session ids closed.
   */
  private enforceSessionCap(exempt: string): string[] {
    const closable = [...this.sessions.entries()]
      // Same three exclusions the reaper uses, for the same reasons: a turn in
      // flight would lose work, and a conversation the agent never named has
      // nothing to resume from, so closing it loses it rather than parks it.
      .filter(([id, s]) => id !== exempt && !s.working && s.agentSessionId !== undefined)
      .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);

    const excess = this.sessions.size - Daemon.MAX_LIVE_SESSIONS;
    const closed: string[] = [];
    for (const [sessionId, session] of closable.slice(0, Math.max(0, excess))) {
      this.closeSession(sessionId, session);
      closed.push(sessionId);
    }
    // Same announce the reaper sends, and for the same reason: `activeSessions`
    // is how a client learns an id it still lists no longer exists here. Without
    // it the phone would keep offering a conversation whose agent is gone and
    // prompt it, which fails with "Unknown session" instead of resuming.
    if (closed.length > 0) this.announceProviders();
    return closed;
  }

  /** Rescan `providers/`. Safe to call at any time — this is what makes a newly
   *  added manifest show up on the phone without a restart. */
  async refreshProviders(): Promise<{ errors: { source: string; message: string }[] }> {
    const { providers, errors } = await loadProviders();
    const gg = providers.findIndex((p) => p.manifest.id === GG_PROVIDER_ID);
    const ggProvider = providers[gg];
    if (ggProvider && !providers.some((p) => p.manifest.id === GG_GOALS_ID)) {
      providers.splice(gg + 1, 0, goalsProviderFrom(ggProvider));
    }
    this.providers = providers;
    // Re-read every refresh, so `tappy providers disable` takes effect without
    // restarting the daemon.
    this.disabled = await readDisabled();
    this.closeDisabled();
    this.announceProviders();
    return { errors };
  }

  /**
   * Stop agents the user has just turned off.
   *
   * Turning one off only ever stopped it being announced, probed or spawned
   * *next* time. Anything already running kept running, so a machine that had
   * warmed Cline and Qwen before they were deselected still had both resident
   * hours later — which reads as the switch not working, and is the whole
   * reason someone turns an agent off.
   */
  private closeDisabled() {
    for (const [key, spare] of this.spares) {
      if (this.isEnabled(spare.providerId)) continue;
      clearTimeout(spare.timer);
      spare.handle.close();
      this.spares.delete(key);
    }
    for (const [sessionId, session] of this.sessions) {
      if (this.isEnabled(session.providerId)) continue;
      // A turn in flight is left alone. Killing an agent mid-answer would lose
      // work the user is waiting on, and the session is reaped on its own clock
      // once it finishes.
      if (session.working) continue;
      this.closeSession(sessionId, session);
    }
  }

  /** Whether an agent may be announced, probed, or spawned. */
  protected isEnabled(providerId: string): boolean {
    return !this.disabled.has(providerId);
  }

  private announceProviders() {
    const announce: wire.ProviderAnnounce = {
      t: "providers",
      machine: this.machine,
      providers: this.providers
        // Test fixtures are hidden unless explicitly asked for, so a demo or a
        // local run can still exercise the pipeline without any API keys.
        .filter((p) => !p.manifest.tappy.experimental || this.includeExperimental)
        // Turned off by the user. Filtered here rather than in the app, so the
        // phone is never even told about an agent it should not offer.
        .filter((p) => this.isEnabled(p.manifest.id))
        // GG Goals rides ggcoder: never announced without it.
        .filter((p) => p.manifest.id !== GG_GOALS_ID || this.isEnabled(GG_PROVIDER_ID))
        // Not on this machine at all. Nothing about it can be acted on from a
        // phone \u2014 you cannot install a CLI from there \u2014 so a dimmed row for it
        // is a permanent piece of furniture that never becomes useful.
        //
        // This is also what makes the phone agree with `tappy setup`: the picker
        // will not let these be chosen, so announcing them showed agents the
        // user was never offered. An agent that is installed but still needs a
        // key is a different case and stays, because it is really here and the
        // reason says what to do about it.
        .filter((p) => !p.commandMissing)
        .map((p) => ({
          id: p.manifest.id,
          name: p.manifest.name,
          description: p.manifest.description,
          transport: p.manifest.tappy.transport,
          color: p.manifest.tappy.color,
          requiresWorkspace: p.manifest.tappy.requiresWorkspace,
          available: isAvailable(p),
          unavailableReason: unavailableReason(p),
        })),
      // Which sessions this process actually holds. A client's list outlives
      // the daemon, so this is how it learns that an id it still shows died
      // with the previous process and must be resumed, not prompted.
      activeSessions: [...this.sessions.keys()],
      // Omitted entirely when there is nothing to say, so an app that has been
      // told once does not keep a stale banner when the update lands.
      update: this.updateStatus,
    };
    this.send(announce);
  }

  /**
   * Append to the session's log, sending only once the session is live.
   *
   * The log gets every event either way — seqs stay gapless, so the flush in
   * `markLive` and the reconnect replay both see the complete history.
   */
  protected record(session: ActiveSession, payload: unknown) {
    rememberTurnText(session, payload);
    const event = session.log.append(payload);
    if (!session.live) return;
    if (!session.streamingReplay) {
      this.send(event);
      return;
    }
    (session.pendingReplay ??= []).push(event);
    // ACP can deliver a thousand notifications in one event-loop turn; a timer
    // cannot fire during that burst, so flush by size as well as by frame.
    if (session.pendingReplay.length >= REPLAY_BATCH_SIZE) {
      this.flushStreamingReplay(session, false);
      return;
    }
    if (!session.replayTimer) {
      session.replayTimer = setTimeout(() => this.flushStreamingReplay(session, false), 16);
      session.replayTimer.unref?.();
    }
  }

  private flushStreamingReplay(session: ActiveSession, complete: boolean) {
    if (session.replayTimer) clearTimeout(session.replayTimer);
    session.replayTimer = undefined;
    const events = session.pendingReplay?.splice(0) ?? [];
    if (events.length > 0 || complete) {
      this.send({ t: "session.replay", sessionId: session.log.sessionId, events, complete });
    }
  }

  /**
   * Tell clients about everything a session has already produced.
   *
   * Callers broadcast `session.started` first; this is what guarantees a client
   * never sees an event for a session it has not been introduced to.
   */
  markLive(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session || session.live) return;
    session.live = true;
    // The backlog goes out as one batched frame rather than hundreds: the app
    // folds it into a single render. An empty frame still matters because it
    // marks a resumed transcript as fully loaded and dismisses its skeleton.
    const backlog = session.log.since(-1);
    this.send({ t: "session.replay", sessionId, events: backlog });
  }

  /** Announce first, then reveal resume history in frame-sized batches. */
  markStreaming(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session || session.live) return;
    session.live = true;
    session.streamingReplay = true;
    session.pendingReplay = session.log.since(-1);
    this.flushStreamingReplay(session, false);
  }

  finishStreaming(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.flushStreamingReplay(session, true);
    session.streamingReplay = false;
  }

  async startSession(providerId: string, cwd: string): Promise<string> {
    const provider = this.providers.find((p) => p.manifest.id === providerId);
    if (!provider) throw new Error(`Unknown provider '${providerId}'`);
    // Checked here too, not just where the list is announced. A phone that
    // connected before the agent was turned off still holds the old list, and
    // tapping one of those rows would otherwise spawn the very process that
    // turning it off was meant to prevent.
    if (!this.isEnabled(providerId)) {
      throw new Error(`'${provider.manifest.name}' is turned off on this machine.`);
    }
    if (!isAvailable(provider)) throw new Error(unavailableReason(provider)!);

    // Assign our own session id up front so events are attributable even if the
    // agent's own `session/new` is slow or fails.
    const log = new SessionLog(`${providerId}-${Date.now().toString(36)}`);
    // Registered before connecting so `record` has somewhere to hold events the
    // agent emits during the handshake itself.
    const session: ActiveSession = {
      handle: undefined,
      log,
      providerId,
      cwd,
      live: false,
      lastUsedAt: Date.now(),
      ready: Promise.resolve(),
    };
    this.sessions.set(log.sessionId, session);
    // Enforced as it opens, not on the reaper's five-minute tick: this is the
    // moment memory grows, and someone opening several conversations in a burst
    // would otherwise hold all of them until the next pass.
    this.enforceSessionCap(log.sessionId);

    try {
      await this.connectSession(session, provider, cwd, undefined);
    } catch (error) {
      // A session that never connected has no history worth keeping, and
      // leaving it registered would answer prompts with a broken handle.
      this.sessions.delete(log.sessionId);
      throw error;
    }

    return log.sessionId;
  }

  /**
   * The agent's own id for a session, once it has opened one.
   *
   * Clients list the agent's stored conversations alongside their own, so a
   * session started here has to name itself in the agent's terms — otherwise
   * the next history probe lists the very conversation on screen a second time
   * as a stub, and reopening *that* copy loses the session's settings.
   */
  agentSessionId(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.agentSessionId;
  }

  /** Selectors (model, thinking level, mode) advertised by a session's agent. */
  configOptions(sessionId: string) {
    return this.sessions.get(sessionId)?.handle?.configOptions ?? [];
  }

  /** Begin restoring immediately; callers can announce before the agent is ready. */
  beginResumeSession(providerId: string, agentSessionId: string, cwd: string) {
    const provider = this.providers.find((p) => p.manifest.id === providerId);
    if (!provider) throw new Error(`Unknown provider '${providerId}'`);
    // Checked here too, not just where the list is announced. A phone that
    // connected before the agent was turned off still holds the old list, and
    // tapping one of those rows would otherwise spawn the very process that
    // turning it off was meant to prevent.
    if (!this.isEnabled(providerId)) {
      throw new Error(`'${provider.manifest.name}' is turned off on this machine.`);
    }
    if (!isAvailable(provider)) throw new Error(unavailableReason(provider)!);

    const log = new SessionLog(`${providerId}-${Date.now().toString(36)}`);
    const session: ActiveSession = {
      handle: undefined,
      log,
      providerId,
      cwd,
      live: false,
      lastUsedAt: Date.now(),
      ready: Promise.resolve(),
    };
    this.sessions.set(log.sessionId, session);
    // Enforced as it opens, not on the reaper's five-minute tick: this is the
    // moment memory grows, and someone opening several conversations in a burst
    // would otherwise hold all of them until the next pass.
    this.enforceSessionCap(log.sessionId);
    session.ready = this.connectSession(session, provider, cwd, agentSessionId);
    return { sessionId: log.sessionId, ready: session.ready };
  }

  async resumeSession(providerId: string, agentSessionId: string, cwd: string) {
    const pending = this.beginResumeSession(providerId, agentSessionId, cwd);
    try {
      await pending.ready;
      return pending.sessionId;
    } catch (error) {
      this.sessions.delete(pending.sessionId);
      throw error;
    }
  }

  /**
   * Record a choice made before any session exists.
   *
   * The empty state offers the same selectors a live conversation does, but a
   * session is only created by the first prompt — so there is nothing to set
   * the option on yet. Storing it here is what makes the pill stick: the
   * session that prompt creates applies it on connect.
   */
  async rememberConfigOption(providerId: string, configId: string, value: string | boolean) {
    await writeConfigPref(providerId, configId, value);
    // Every other client is looking at the same empty state, and one of them
    // just changed what its next prompt will run on.
    void this.publishProviderConfig(providerId).catch(() => {});
  }

  async setConfigOption(sessionId: string, configId: string, value: string | boolean) {
    const session = this.require(sessionId);
    await session.ready;
    const updated = await session.handle!.setConfigOption(configId, value);
    // Only after the agent accepted it: remembering a rejected choice would
    // reapply a broken setting to every session that follows.
    void writeConfigPref(session.providerId, configId, value).catch(() => {});
    // ...and against this conversation, so reopening it restores the choice
    // rather than the agent's default. Both: the provider record seeds the next
    // new session, this one survives leaving and coming back.
    // Only when the agent named the conversation: without an id there is
    // nothing to key the record by, and a placeholder would hand its selectors
    // to the next session that also lacks one.
    const agentSessionId = session.agentSessionId;
    if (agentSessionId) {
      void writeSessionPrefs(session.providerId, agentSessionId, { [configId]: value }).catch(
        () => {},
      );
    }
    // The provider record above is what the *next* conversation opens with, so
    // the empty state has to move with it. Otherwise leaving this conversation
    // showed the selectors it was holding while the next prompt used these.
    void this.publishProviderConfig(session.providerId, updated).catch(() => {});
    return updated;
  }

  async cancel(sessionId: string) {
    const session = this.require(sessionId);
    // A stop takes the queue with it: those messages go back to the composer
    // rather than running after the user said stop.
    if (session.working) session.cancelling = true;
    this.returnQueue(session);
    await session.ready;
    await session.handle!.cancel();
  }

  /** An open ask stopped being open: forget it and log `ask_user_closed` once. */
  protected closeAsk(session: ActiveSession, requestId: string) {
    if (!session.asks?.delete(requestId)) return;
    this.record(session, { kind: "ask_user_closed", requestId });
  }

  /** Answer an open `_gg/ask_user` question. */
  answerAsk(sessionId: string, requestId: string, result: AskAnswer) {
    const session = this.require(sessionId);
    const answered = session.handle?.answerAsk(requestId, result) ?? false;
    if (answered) this.closeAsk(session, requestId);
    return answered;
  }

  answerPermission(sessionId: string, requestId: string, optionId: string) {
    const session = this.require(sessionId);
    const answered = session.handle?.answerPermission(requestId, optionId) ?? false;
    // Only on a real answer. A `false` means the connection had no such request
    // — a stale sheet from a previous turn, or a second client answering one
    // that was already resolved — and forgetting it here on that basis would
    // hide a *different*, still-open request from the next catch-up.
    if (answered) session.permissions?.delete(requestId);
    return answered;
  }

  /**
   * Where this session's agent is running, for resolving the relative paths it
   * uses to name files. Undefined once the session is gone, in which case the
   * caller falls back to the daemon's own workspace.
   */
  /** Which provider a live session runs under, if any. */
  sessionProvider(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.providerId;
  }

  sessionCwd(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.cwd;
  }

  /**
   * Who ran this session and in which project, for the "agent finished"
   * notification.
   *
   * Only this machine has the path, and the phone must be able to name the
   * work even for a session it is not currently showing — which is exactly the
   * case a notification exists for.
   */
  sessionOrigin(sessionId: string): { providerId?: string; folder?: string } {
    const session = this.sessions.get(sessionId);
    if (!session) return {};
    return { providerId: session.providerId, folder: folderName(session.cwd) };
  }

  /**
   * Everything a push notification for a finished turn needs to say.
   *
   * Separate from `sessionOrigin` because the two have different audiences. That
   * one feeds `session.idle` on the wire, where the app resolves `providerId`
   * against the provider list it already holds. A push has no app to resolve
   * anything: the text is rendered by iOS with no JavaScript running, so the
   * agent's display name has to be looked up here.
   */
  sessionNotice(sessionId: string): { folder?: string; agentName?: string; lastText?: string } {
    const session = this.sessions.get(sessionId);
    if (!session) return {};
    return {
      folder: folderName(session.cwd),
      agentName: this.providers.find((p) => p.manifest.id === session.providerId)?.manifest.name,
      lastText: session.turnText,
    };
  }

  /** Replay everything a reconnecting client has not seen yet. */
  replay(sessionId: string, cursor: number): wire.SessionEvent[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    // Reading a conversation is using it. Without this, a session someone is
    // sitting in — scrolling, reading a long answer — aged out on the same
    // clock as one nobody had opened since breakfast.
    session.lastUsedAt = Date.now();
    return session.log.since(cursor);
  }

  /**
   * Frames that bring a reconnecting client level with what it missed.
   *
   * A phone loses its socket constantly — the screen locks, iOS suspends the
   * app, the radio switches from wifi to cellular, the relay drops a room. The
   * agent does not stop for any of that, and a frame sent while the socket is
   * down is gone: the relay stores nothing and `RelayClient.send` drops it.
   *
   * So the client names the highest `seq` it holds per session in its `hello`,
   * and this answers with the rest. Without it a phone that blinked mid-turn
   * silently resumed at the live edge, and the first thing the user saw was a
   * shell command from twenty seconds into work it had watched none of.
   *
   * Only sessions the client already knows about: a client is introduced to a
   * session by `session.started`, and an event for one it has never heard of
   * has nowhere to go. Cursors name exactly the sessions it has seen.
   */
  catchUp(cursors: Record<string, number>): wire.Replay[] {
    const frames: wire.Replay[] = [];
    for (const [sessionId, cursor] of Object.entries(cursors)) {
      const session = this.sessions.get(sessionId);
      // Not live means clients were never told it exists; replaying into that
      // would break the same invariant `markLive` exists to hold.
      if (!session || !session.live) continue;
      const events = this.replay(sessionId, cursor);
      const permissions = [...(session.permissions ?? [])].map(([requestId, params]) => ({
        requestId,
        params,
      }));
      // A client that missed nothing still needs the running flag: it may have
      // been away for the `session.idle` that ended the turn it last saw.
      //
      // Every known session gets a frame, including one with nothing to report.
      // "No events, not working, nothing pending" is not silence — it is the
      // answer that dismisses an approval sheet the user resolved at the desk
      // while this phone was away, and skipping it left that sheet up for ever,
      // wired to a requestId the daemon has already forgotten.
      frames.push({
        t: "session.replay",
        sessionId,
        events,
        complete: true,
        catchUp: true,
        working: session.working === true,
        // Always sent, empty array included. The app reads an *absent* field as
        // "an older daemon says nothing, leave any open sheet alone" and an
        // empty one as "nothing is pending, dismiss it" — so omitting it made
        // the second case unreachable.
        permissions,
        // Same absent/empty rule as permissions.
        queued: (session.queue ?? []).map(queuedForWire),
        asks: [...(session.asks ?? [])].map(([requestId, questions]) => ({
          requestId,
          questions: questions as wire.AskQuestion[],
        })),
        // Only a goal's coordinator has one; absent otherwise.
        ...(session.goal ? { goal: session.goal } : {}),
        ...(session.plan ? { plan: session.plan } : {}),
        ...(session.autopilot ? { autopilot: session.autopilot } : {}),
      });
    }
    return frames;
  }

  closeAll() {
    if (this.reaper) {
      clearInterval(this.reaper);
      this.reaper = undefined;
    }
    for (const [sessionId, session] of [...this.sessions]) {
      this.closeSession(sessionId, session);
    }
    this.sessions.clear();
    for (const spare of this.spares.values()) {
      clearTimeout(spare.timer);
      spare.handle.close();
    }
    this.spares.clear();
  }

  protected require(sessionId: string): ActiveSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown session '${sessionId}'`);
    return session;
  }
}

if (import.meta.main) {
  const daemon = new Daemon({ id: "local", name: "this machine" });
  daemon.attach((message) => console.log(JSON.stringify(message)));

  const { errors } = await daemon.refreshProviders();
  for (const error of errors) console.error(error.message);

  process.on("SIGINT", () => {
    daemon.closeAll();
    process.exit(0);
  });
}
