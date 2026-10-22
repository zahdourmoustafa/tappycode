/**
 * Spawns a provider process and speaks ACP to it over stdio.
 *
 * Everything the agent emits is funnelled into a single ordered callback so the
 * session log stays the one source of truth. Permission requests are surfaced
 * the same way, and resolved later by id when the phone answers.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { client, ndJsonStream } from "@agentclientprotocol/sdk";
import { humanError } from "../errors.js";
import type { StoredAttachment } from "../attachments.js";
import { promptBlocks, type PromptCapabilities } from "./promptBlocks.js";
import { SESSION_HISTORY_LIMIT } from "../session-history.js";
import { hydrateMessageCounts } from "./messageCounts.js";
import { foldProjects } from "../projects.js";
import { DETACH_CHILDREN, registerChild, terminateChild, unregisterChild } from "../children.js";

import {
  MODE_CONFIG_ID,
  MODEL_CONFIG_ID,
  modelsAsConfigOption,
  normaliseConfigOptions,
  readAvailableCommands,
  type AcpSessionHandle,
  type AdoptOptions,
  type AgentSession,
  type AgentSessionList,
  type AskAnswer,
  type AvailableCommand,
  type ConfigOption,
  type ConnectOptions,
  type GgCallbacks,
  type GgCapabilities,
  type GgGoalMeta,
  type SessionModelState,
} from "./connect-types.js";

export {
  MODE_CONFIG_ID,
  MODEL_CONFIG_ID,
  type AcpSessionHandle,
  type AdoptOptions,
  type AgentSession,
  type AgentSessionList,
  type AskAnswer,
  type AvailableCommand,
  type ConfigOption,
  type ConnectOptions,
  type GgCallbacks,
  type GgCapabilities,
  type GgGoalMeta,
  type PromptOptions,
} from "./connect-types.js";

import {
  HANDSHAKE_TIMEOUT_MARKER,
  HANDSHAKE_TIMEOUT_MS,
  applyConfigUpdate,
  restoreMethodFor,
  toWebStreams,
  withTimeout,
} from "./connect-helpers.js";
import { launchSpec } from "./launch.js";

export { HANDSHAKE_TIMEOUT_MARKER, restoreMethodFor, withTimeout } from "./connect-helpers.js";
export { launchSpec } from "./launch.js";

export async function connectProvider(options: ConnectOptions): Promise<AcpSessionHandle> {
  const { provider, cwd } = options;

  // Never with a faked platform: this one actually spawns, so simulating
  // Windows here would try to run cmd.exe on a Mac.
  const launch = launchSpec(provider.command, provider.args, {
    ...process.env,
    TAPPY_FAKE_PLATFORM: undefined,
  });

  const child = spawn(launch.command, launch.args, {
    cwd,
    // Set only on the Windows batch-shim path, where the command line was
    // escaped by hand above. Letting Node re-quote it would undo that.
    windowsVerbatimArguments: launch.windowsVerbatimArguments,
    // ACP mandates stdout carry only protocol messages, so logs go to stderr.
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
    // Its own process group, so `kill` can address the whole tree. Five bundled
    // providers run through `npx`: signalling only the process we spawned kills
    // the launcher and reparents the real agent to pid 1, where it runs until
    // the machine reboots. Detaching also stops a terminal's Ctrl-C reaching
    // agents directly — the daemon's own handler closes them in order instead.
    // Never on Windows, where the same flag means "outlive the parent".
    detached: DETACH_CHILDREN,
  }) as ChildProcessWithoutNullStreams;

  // A missing executable surfaces asynchronously as an 'error' event. Without a
  // listener Node treats it as unhandled and takes the whole daemon down, so one
  // uninstalled provider would kill every other session. Convert it to a
  // rejection of this call instead.
  const spawned = new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", (error: NodeJS.ErrnoException) => {
      reject(
        error.code === "ENOENT"
          ? new Error(
              `'${provider.command}' was not found on PATH. Install it, or point the manifest at an absolute path.`,
            )
          : error,
      );
    });
  });
  await spawned;

  // Recorded so that a daemon which dies without running a handler — SIGKILL,
  // OOM, panic — can still be cleaned up after, by the next one to start.
  const pid = child.pid;
  if (pid !== undefined) {
    void registerChild({
      pid,
      providerId: provider.manifest.id,
      fallbackCommand: [provider.command, ...provider.args].join(" "),
    });
  }

  // The exit listener is re-pointed on `adopt`, so a reused process reports
  // its death to the session currently living on it, not the first one.
  let exitHandler = options.onExit;
  let exited = false;
  child.on("exit", (code, signal) => {
    exited = true;
    if (pid !== undefined) void unregisterChild(pid);
    exitHandler?.(code, signal);
  });

  /**
   * SIGTERM to the whole group, SIGKILL to whatever ignored it.
   *
   * @param graceMs Time between the two. Zero for a process already known to be
   * wedged, where the request is a formality.
   */
  const stop = (graceMs?: number) => {
    if (exited || pid === undefined) return;
    terminateChild(pid, () => exited, graceMs);
  };

  // Always read stderr, even with no `onStderr` listener. An agent that fails to
  // hand shake explains itself there and nowhere else — `npm error ENOENT` from a
  // corrupt npx cache, or a login prompt — and without it the only thing to
  // report is that nothing happened. Also drains the pipe: a child that fills
  // its stderr buffer with nobody reading blocks forever, which is itself a way
  // to hang the handshake.
  const stderrTail: string[] = [];
  {
    let buffer = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        options.onStderr?.(line);
        // Bounded: a chatty agent must not accumulate its whole log here.
        stderrTail.push(line);
        if (stderrTail.length > 12) stderrTail.shift();
      }
    });
  }

  // Open permission requests, keyed by the id the app answers with.
  //
  // `null` is settled-without-an-answer: closing the connection has to resolve
  // every entry it still holds, or the `session/request_permission` handler
  // awaits a promise nobody can ever fulfil — which retains the request, its
  // handler and the closure around this whole connection for the life of the
  // daemon process.
  const pending = new Map<string, (optionId: string | null) => void>();
  let permissionCounter = 0;
  // Same rule for GG's `_gg/ask_user` questions: `null` answers as cancel.
  const asksPending = new Map<string, (result: AskAnswer | null) => void>();
  let askCounter = 0;

  const { input, output } = toWebStreams(child);
  const stream = ndJsonStream(output, input);

  // Updates and permission requests are routed per agent session: `adopt`
  // puts a second session on this connection, and the probe's throwaway must
  // never write into a live conversation. `pendingRoute` covers the window
  // inside `session/new`, whose id only exists once it resolves.
  const updateHandlers = new Map<string, (payload: unknown) => void>();
  const permissionHandlers = new Map<string, ConnectOptions["onPermissionRequest"]>();
  const ggHandlers = new Map<string, GgCallbacks>();
  let pendingRoute:
    | {
        onUpdate: (payload: unknown) => void;
        onPermissionRequest: ConnectOptions["onPermissionRequest"];
        gg?: GgCallbacks;
      }
    | undefined;
  const ggRoute = (params: unknown): GgCallbacks | undefined => {
    const sid = (params as { sessionId?: unknown } | null)?.sessionId;
    return (typeof sid === "string" ? ggHandlers.get(sid) : undefined) ?? pendingRoute?.gg;
  };

  // Commands arrive as a notification after `session/new` resolves, so they
  // cannot be part of its result. Captured here rather than only forwarded,
  // because the capability probe throws its updates away and still needs them:
  // the app offers commands in the empty state, before a session exists.
  let availableCommands: AvailableCommand[] = [];

  // Assigned by the first `openSession` below. Initialised rather than left in
  // the temporal dead zone: `session/load` replays through the notification
  // handler *before* that assignment lands, and the config branch there reads
  // this — a bare `let` would throw mid-replay.
  let current: { sessionId: string; configOptions: ConfigOption[]; goal?: GgGoalMeta } = {
    sessionId: "",
    configOptions: [],
  };
  const configHandlers = new Map<string, (options: ConfigOption[]) => void>();

  const app = client({ name: "tappy-daemon" })
    .onNotification("session/update", async (ctx: { params: unknown }) => {
      const params = ctx.params as {
        sessionId?: string;
        update?: {
          sessionUpdate?: string;
          availableCommands?: unknown;
          configOptions?: unknown;
          currentModeId?: unknown;
        };
      };
      if (params?.update?.sessionUpdate === "available_commands_update") {
        availableCommands = readAvailableCommands(params.update.availableCommands);
      }
      // The agent changing the session's selectors on its own. Scoped to the
      // session prompts actually target: one connection carries several — the
      // capability probe's throwaway, and whatever `adopt` opened before this —
      // and letting any of them write here would hand a live conversation the
      // wrong agent's model list.
      if (params?.sessionId && params.sessionId === current.sessionId) {
        const changed = applyConfigUpdate(current.configOptions, params.update);
        if (changed) {
          current = { ...current, configOptions: changed };
          configHandlers.get(params.sessionId)?.(changed);
        }
      }
      const sid = params?.sessionId;
      const handler = (sid ? updateHandlers.get(sid) : undefined) ?? pendingRoute?.onUpdate;
      handler?.(ctx.params);
    })
    .onRequest("session/request_permission", async (ctx: { params: unknown }) => {
      const requestId = `perm_${++permissionCounter}`;
      // Register the resolver *before* notifying, otherwise a caller that answers
      // synchronously finds no pending entry and the agent waits forever.
      const answered = new Promise<string | null>((resolve) => {
        pending.set(requestId, resolve);
      });
      const sid = (ctx.params as { sessionId?: string })?.sessionId;
      const handler =
        (sid ? permissionHandlers.get(sid) : undefined) ??
        pendingRoute?.onPermissionRequest ??
        options.onPermissionRequest;
      handler({ requestId, params: ctx.params });
      const optionId = await answered;
      // Null means the connection went away with the question unanswered. ACP
      // has a word for that, and saying it lets the agent unwind instead of
      // sitting on a request whose client no longer exists.
      if (optionId === null) return { outcome: { outcome: "cancelled" } };
      return { outcome: { outcome: "selected", optionId } };
    })
    // GG Coder's ask_user. Exactly the permission rule: the resolver is
    // registered before anyone is told, and a connection that closes with the
    // question open answers it as cancelled rather than leaving it hanging.
    .onRequest(
      "_gg/ask_user",
      (params: unknown) => params,
      async (ctx: { params: unknown; signal?: AbortSignal }) => {
        const requestId = `ask_${++askCounter}`;
        const answered = new Promise<AskAnswer | null>((resolve) => {
          asksPending.set(requestId, resolve);
        });
        const handler = ggRoute(ctx.params)?.onAskUser;
        if (!handler) {
          asksPending.delete(requestId);
          return { action: "cancel" };
        }
        const route = ggRoute(ctx.params);
        // Never timed out here: an ask stays open past its turn by design.
        // Only the agent withdrawing it (or close) ends it unanswered.
        ctx.signal?.addEventListener(
          "abort",
          () => {
            const resolve = asksPending.get(requestId);
            if (!resolve) return;
            asksPending.delete(requestId);
            route?.onAskClosed?.(requestId);
            resolve(null);
          },
          { once: true },
        );
        handler({ requestId, params: ctx.params });
        return (await answered) ?? { action: "cancel" };
      },
    )
    .onNotification(
      "_gg/queue_update",
      (params: unknown) => params,
      async (ctx: { params: unknown }) => {
        ggRoute(ctx.params)?.onQueueUpdate?.(ctx.params);
      },
    )
    .onNotification(
      "_gg/goal_state",
      (params: unknown) => params,
      async (ctx: { params: unknown }) => {
        ggRoute(ctx.params)?.onGoalState?.(ctx.params);
      },
    )
    .onNotification(
      "_gg/plan_state",
      (params: unknown) => params,
      async (ctx: { params: unknown }) => {
        ggRoute(ctx.params)?.onPlanState?.(ctx.params);
      },
    )
    .onNotification(
      "_gg/session_reset",
      (params: unknown) => params,
      async (ctx: { params: unknown }) => {
        ggRoute(ctx.params)?.onSessionReset?.(ctx.params);
      },
    )
    .onNotification(
      "_gg/autopilot_state",
      (params: unknown) => params,
      async (ctx: { params: unknown }) => {
        ggRoute(ctx.params)?.onAutopilotState?.(ctx.params);
      },
    )
    .onNotification(
      "_gg/autopilot_event",
      (params: unknown) => params,
      async (ctx: { params: unknown }) => {
        ggRoute(ctx.params)?.onAutopilotEvent?.(ctx.params);
      },
    )
    .onNotification(
      "_gg/checklist_changed",
      (params: unknown) => params,
      async (ctx: { params: unknown }) => {
        ggRoute(ctx.params)?.onChecklistChanged?.(ctx.params);
      },
    );

  const connection = app.connect(stream);

  // How the agent was started, and whatever it said before failing. Both
  // failures below are otherwise unattributable: "ACP connection closed" does
  // not say which agent, what was run, or why it died.
  const failureContext = () => {
    const invocation = `It was started with: ${provider.command} ${provider.args.join(" ")}`;
    return stderrTail.length > 0 ? `${invocation}\n${stderrTail.join("\n")}` : invocation;
  };

  // Bounded, because this await is the one that used to hang forever. Nothing
  // downstream — the capability probe, the app's session list — has a timeout of
  // its own, so an agent that never answers left the phone on a loading skeleton
  // with no error, no log line and no way back except restarting the daemon.
  const handshake = withTimeout(
    connection.agent.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        // Opt in to boolean selectors; agents must not send them otherwise.
        session: { configOptions: { boolean: {} } },
        // GG Coder registers its ask_user tool only for clients that can answer
        // it. Inert for every other agent: `_meta` is ACP's extension slot.
        _meta: { gg: { askUser: true, planReview: true } },
      },
      clientInfo: { name: "tappy", title: "tappy", version: "0.1.0" },
    }),
    options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS,
    () => {
      // The process is wedged, not merely slow: leaving it running would leak a
      // child per attempt for as long as the user keeps tapping. No grace, since
      // it has already failed to answer for the whole handshake window — but by
      // group, or a wrapped agent survives the launcher it was started behind.
      stop(0);
      return new Error(
        `'${provider.manifest.name}' ${HANDSHAKE_TIMEOUT_MARKER}. ${failureContext()}`,
      );
    },
  );

  // An agent that dies immediately — bad arguments, missing config — already
  // rejects here promptly, but as a bare "ACP connection closed" that names
  // neither the agent nor the reason it printed on the way out.
  const initialized = (await handshake.catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes(HANDSHAKE_TIMEOUT_MARKER)) throw error;
    throw new Error(`'${provider.manifest.name}' failed to start: ${message}. ${failureContext()}`);
  })) as {
    agentCapabilities?: {
      loadSession?: boolean;
      promptCapabilities?: PromptCapabilities;
      sessionCapabilities?: { list?: unknown; resume?: unknown };
      _meta?: { gg?: GgCapabilities };
    };
  };

  const caps = initialized.agentCapabilities;
  const canLoadSession = caps?.loadSession === true;
  // `session/resume` reconnects to a stored conversation *without* replaying it.
  //
  // Worth a separate capability check because it is the difference between
  // reopening a conversation in 150ms and in 1.2s: measured against GG Coder, a
  // `session/load` of one long conversation pushed 8,354 update notifications
  // and blocked for 938ms — all of which the daemon then discarded, because it
  // had already painted the same history from its own cache.
  //
  // `{}` is how ACP says "supported" for a capability with no options of its
  // own, so presence is the test, not truthiness.
  const canResumeSession = caps?.sessionCapabilities?.resume !== undefined;
  // How an attachment may be sent to this agent: pixels inline, file text
  // inline, or a path it can open for itself.
  const promptCapabilities = caps?.promptCapabilities;
  // Asking an agent that never advertised `session/list` is a protocol error,
  // not an empty list, so the capability is checked rather than the call tried.
  const canListSessions = caps?.sessionCapabilities?.list !== undefined;
  const rawGg = caps?._meta?.gg;
  const ggCapabilities: GgCapabilities | undefined =
    rawGg && typeof rawGg === "object" ? rawGg : undefined;

  type NewSessionResult = {
    sessionId: string;
    configOptions?: ConfigOption[];
    models?: SessionModelState;
    modes?: {
      currentModeId: string;
      availableModes: { id: string; name: string; description?: string }[];
    };
    _meta?: { gg?: { goal?: unknown } };
  };

  function readGoalMeta(created: NewSessionResult): GgGoalMeta | undefined {
    const goal = created._meta?.gg?.goal as Partial<GgGoalMeta> | undefined;
    if (!goal || typeof goal.id !== "string") return undefined;
    return {
      id: goal.id,
      ...(typeof goal.phase === "string" ? { phase: goal.phase } : {}),
      ...(typeof goal.paused === "boolean" ? { paused: goal.paused } : {}),
      needsKickoff: goal.needsKickoff === true,
    };
  }

  // Three shapes, all live in the wild, and an agent may send more than one.
  // Claude Code returns `models` + `modes` and no `configOptions` at all, so
  // reading only the last of these silently dropped its entire model list.
  function buildConfigOptions(created: NewSessionResult): ConfigOption[] {
    const advertised = normaliseConfigOptions(created.configOptions);
    const modes: ConfigOption[] = created.modes
      ? [
          {
            id: MODE_CONFIG_ID,
            name: "Mode",
            category: "mode",
            type: "select",
            currentValue: created.modes.currentModeId,
            options: created.modes.availableModes.map((mode) => ({
              value: mode.id,
              name: mode.name,
              description: mode.description,
            })),
          },
        ]
      : [];

    // An explicit `configOptions` entry always wins: it is the current
    // protocol, so it must not be shadowed by the legacy block describing the
    // same thing.
    const has = (category: string) =>
      advertised.some((option) => option.category === category);
    return [
      ...advertised,
      ...(has("model") ? [] : modelsAsConfigOption(created.models)),
      ...(has("mode") ? [] : modes),
    ];
  }

  // Resuming replays the agent's own history through the update handler before
  // it resolves, so the route must exist before the request is made.
  async function openSession(
    loadSessionId: string | undefined,
    /**
     * Where this session runs. Defaults to the directory the process was
     * spawned in, which is right for the first session on a cold connection
     * and wrong for every adopted one.
     */
    sessionCwd: string,
    route: {
      onUpdate: (payload: unknown) => void;
      onPermissionRequest: ConnectOptions["onPermissionRequest"];
      onConfigOptions?: (options: ConfigOption[]) => void;
      gg?: GgCallbacks;
    },
    /** The caller already has the transcript; see {@link ConnectOptions.haveHistory}. */
    haveHistory = false,
  ): Promise<{ sessionId: string; configOptions: ConfigOption[]; goal?: GgGoalMeta }> {
    if (loadSessionId) {
      updateHandlers.set(loadSessionId, route.onUpdate);
      permissionHandlers.set(loadSessionId, route.onPermissionRequest);
      if (route.gg) ggHandlers.set(loadSessionId, route.gg);
      if (route.onConfigOptions) configHandlers.set(loadSessionId, route.onConfigOptions);
    }
    // Belongs to the session being replaced, and the next one may be a
    // different project entirely.
    availableCommands = [];
    pendingRoute = route;
    try {
      const restoreMethod = restoreMethodFor(haveHistory, canResumeSession);
      const created: NewSessionResult = loadSessionId
        ? {
            ...((await connection.agent.request(restoreMethod, {
              sessionId: loadSessionId,
              cwd: sessionCwd,
              mcpServers: [],
            })) as Omit<NewSessionResult, "sessionId">),
            sessionId: loadSessionId,
          }
        : ((await connection.agent.request("session/new", {
            cwd: sessionCwd,
            mcpServers: [],
          })) as NewSessionResult);
      updateHandlers.set(created.sessionId, route.onUpdate);
      permissionHandlers.set(created.sessionId, route.onPermissionRequest);
      if (route.gg) ggHandlers.set(created.sessionId, route.gg);
      if (route.onConfigOptions) configHandlers.set(created.sessionId, route.onConfigOptions);
      const goal = readGoalMeta(created);
      return {
        sessionId: created.sessionId,
        configOptions: buildConfigOptions(created),
        ...(goal ? { goal } : {}),
      };
    } finally {
      pendingRoute = undefined;
    }
  }

  // Opening the first session is the last thing that can fail before the caller
  // gets a handle — and until it does, nothing else has a reference to this
  // process. So a failure here has to kill it: there is no `close()` to call
  // when the call you would have got it from is the one that threw.
  //
  // `tappy setup` proved the cost. Every agent that answered the handshake and
  // then failed to open a session — the ordinary not-signed-in case — left a
  // live process behind, one per agent per run, until the machine was rebooted.
  //
  // Bounded for the same reason the handshake is: an agent that accepts
  // `session/new` and never answers used to hang this await for ever, with the
  // child parked on it.
  try {
    current = await withTimeout(
      openSession(
        options.loadSessionId,
        cwd,
        {
          onUpdate: options.onUpdate,
          onPermissionRequest: options.onPermissionRequest,
          onConfigOptions: options.onConfigOptions,
          gg: options.gg,
        },
        options.haveHistory,
      ),
      options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS,
      () =>
        new Error(
          `'${provider.manifest.name}' answered the handshake but never opened a session. ${failureContext()}`,
        ),
    );
  } catch (error) {
    // No grace period: it either never answered, or answered with a refusal it
    // has already finished sending.
    stop(0);
    throw error;
  }

  return {
    connection,
    child,
    get sessionId() {
      return current.sessionId;
    },
    get configOptions() {
      return current.configOptions;
    },
    get availableCommands() {
      return availableCommands;
    },
    get goal() {
      return current.goal;
    },
    ggCapabilities,
    canLoadSession,

    async adopt(adoptOptions: AdoptOptions) {
      current = await openSession(
        adoptOptions.loadSessionId,
        adoptOptions.cwd,
        {
          onUpdate: adoptOptions.onUpdate,
          onPermissionRequest: adoptOptions.onPermissionRequest,
          onConfigOptions: adoptOptions.onConfigOptions,
          gg: adoptOptions.gg,
        },
        adoptOptions.haveHistory,
      );
      exitHandler = adoptOptions.onExit;
    },

    async listSessions(): Promise<AgentSessionList> {
      if (!canListSessions) return { sessions: [], projects: [], all: [] };
      const result = (await connection.agent.request("session/list", {})) as {
        sessions?: (AgentSession & { _meta?: { messageCount?: unknown } })[];
      };
      const listed = Array.isArray(result?.sessions) ? result.sessions : [];
      // ACP keeps agent-specific list data in `_meta`. Promote the one field the
      // drawer understands so it survives the typed daemon/app wire boundary.
      const all: AgentSession[] = listed
        .map(({ _meta, ...session }) => {
          const messageCount = _meta?.messageCount;
          return {
            ...session,
            ...(typeof messageCount === "number" &&
            Number.isInteger(messageCount) &&
            messageCount >= 0
              ? { messageCount }
              : {}),
          };
        })
        // Newest first, so both the project fold and the cap below see the
        // list in the order the drawer renders it.
        .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));

      // Folded from the uncapped list deliberately: the cap below is a
      // recent-work window, and grouping *that* would offer only the projects
      // the user has touched this week as if they were all that existed.
      const projects = foldProjects(all);
      // Capped before counts are hydrated. This turns a provider with 600
      // archived chats into 30 small local reads instead of 600. The rows are
      // shared with `all`, so the newest ones carry their counts either way.
      const sessions = all.slice(0, SESSION_HISTORY_LIMIT);

      // Both agents have local indexes that are dramatically faster than
      // loading 30 transcripts one-by-one over ACP just to count visible rows.
      await hydrateMessageCounts(provider.manifest.id, sessions);

      // No per-session counting pass beyond that.
      //
      // There used to be one: for agents without a local index, every session
      // was opened with `session/load` purely to count the messages that came
      // back. Each load is a full transcript over a pipe — about 1.7s on GitHub
      // Copilot — so sixteen conversations took 28 seconds, and the drawer had
      // nothing to show for the whole time. What it bought was a subtitle.
      //
      // No ACP client does this. Zed, PostHog's desktop agent, qwen-code and
      // vscode-acp all return `session/list` as the agent gives it and page
      // with a cursor; the count is simply absent when the agent does not
      // supply one, which the app already renders as a plain title.

      return { sessions, projects, all };
    },
    async setConfigOption(configId: string, value: string | boolean) {
      try {
        // The selectors synthesised from `models` and `modes` have no config id
        // the agent knows, so each routes to its own dedicated method instead.
        const synthetic =
          configId === MODEL_CONFIG_ID
            ? { method: "session/set_model", key: "modelId" }
            : configId === MODE_CONFIG_ID
              ? { method: "session/set_mode", key: "modeId" }
              : undefined;

        if (synthetic) {
          await connection.agent.request(synthetic.method, {
            sessionId: current.sessionId,
            [synthetic.key]: String(value),
          });
          // Neither method returns anything useful, so reflect it locally.
          const updated = current.configOptions.map((option) =>
            option.id === configId ? { ...option, currentValue: value } : option,
          );
          current = { ...current, configOptions: updated };
          return updated;
        }

        const result = (await connection.agent.request("session/set_config_option", {
          sessionId: current.sessionId,
          configId,
          ...(typeof value === "boolean" ? { type: "boolean" } : {}),
          value,
        })) as { configOptions?: unknown };
        // The agent replies with the complete list, so trust it over local
        // state — but only when it actually sent one. Not every agent echoes the
        // list back, and treating a silent reply as "no options" wiped every
        // selector the session had: pick a model, lose the thinking level and
        // the mode with it.
        const echoed = normaliseConfigOptions(result?.configOptions);
        const updated =
          echoed.length > 0
            ? echoed
            : current.configOptions.map((option) =>
                option.id === configId ? { ...option, currentValue: value } : option,
              );
        current = { ...current, configOptions: updated };
        return updated;
      } catch (error) {
        // The agent's real reason travels in the JSON-RPC `data`, so reading
        // `.message` here would substitute a bare "Internal error" and throw
        // the explanation away before anyone could see it.
        const detail = humanError(error);
        // Name the option only when the agent's own wording does not, so the
        // message stays one short sentence instead of saying it twice.
        // `cause` keeps the agent's original error for anyone reading a stack
        // trace, while the message stays the short readable one.
        throw new Error(
          detail.includes(configId) ? detail : `Could not set '${configId}': ${detail}`,
          { cause: error },
        );
      }
    },
    promptCapabilities,
    prompt: (text: string, attachments: readonly StoredAttachment[] = [], promptOptions = {}) =>
      promptOptions.goalTurn || promptOptions.planDecision
        ? // A GG Goals turn or a plan decision: empty prompt, the turn kind rides in `_meta`.
          connection.agent.request<unknown>("session/prompt", {
            sessionId: current.sessionId,
            prompt: [],
            _meta: {
              gg: promptOptions.goalTurn
                ? { goalTurn: promptOptions.goalTurn }
                : { planDecision: promptOptions.planDecision },
            },
          })
        : connection.agent.request("session/prompt", {
            sessionId: current.sessionId,
            prompt: promptBlocks(text, attachments, promptCapabilities),
          }),
    extRequest: <T,>(method: string, params: Record<string, unknown>) =>
      connection.agent.request<T>(method, params),
    answerAsk(requestId, result) {
      const resolve = asksPending.get(requestId);
      if (!resolve) return false;
      asksPending.delete(requestId);
      resolve(result);
      return true;
    },
    cancel: () =>
      connection.agent.notify("session/cancel", { sessionId: current.sessionId }),
    answerPermission(requestId, optionId) {
      const resolve = pending.get(requestId);
      if (!resolve) return false;
      pending.delete(requestId);
      resolve(optionId);
      return true;
    },
    close() {
      // Settle before tearing the transport down: an unresolved promise here is
      // a permission request the agent is still blocked on, and its resolver
      // keeps this connection's entire closure reachable.
      for (const resolve of pending.values()) resolve(null);
      pending.clear();
      for (const resolve of asksPending.values()) resolve(null);
      asksPending.clear();
      connection.close();
      stop();
    },
  };
}
