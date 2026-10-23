/**
 * The GG Coder desktop app, presented to tappy as an ordinary ACP agent.
 *
 * Tappy's daemon only ever speaks ACP over stdio, and the app speaks its own
 * HTTP + SSE API on loopback. This is the translator between them, run as a
 * child process (`tappy gg-app-bridge`) exactly like any other provider, so the
 * daemon needs no special case: spawning, the seq'd log, replay, permissions
 * and question cards all behave as they do for the GG Coder CLI.
 *
 * The difference from the CLI is *where the agent runs*. The CLI provider
 * starts its own `ggcoder acp`; this one joins the engine inside the user's
 * open app, so a prompt from the phone streams in the app window too, and a
 * turn started in the window streams to the phone.
 *
 * Mapping, kept deliberately close to GG Coder's own `acp-mode.ts`:
 *   text_delta      → agent_message_chunk
 *   thinking_delta  → agent_thought_chunk
 *   tool_call_start → tool_call (in_progress)
 *   tool_call_end   → tool_call_update (completed | failed)
 *   prompt_sent     → user_message_chunk, for prompts typed in the window
 *   ask_user        → `_gg/ask_user` request, answered back to `/ask/:id`
 *   run_end         → the open `session/prompt` resolves with its stop reason
 *   model_change / thinking_change → config_option_update, so the phone's
 *                     pickers follow a switch made in the window
 *
 * Model and thinking are the app's footer pickers, offered as GG Coder's own
 * `model` / `thinking` selectors; the command list is the app's slash commands
 * plus its skills (`controls.ts`).
 */
import { agent, ndJsonStream } from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { Readable, Writable } from "node:stream";

import { AppClient, type AppEvent, type AppWindow } from "./client.js";
import { readProbeCache } from "../probe-cache.js";
import {
  buildCommands,
  buildConfigOptions,
  MODEL_OPTION_ID,
  rewriteSkillPrompt,
  THINKING_OFF,
  THINKING_OPTION_ID,
  type AppCommand,
  type AppSkill,
  type BridgeCommand,
  type BridgeConfigOption,
} from "./controls.js";
import { discoverApps } from "./discovery.js";
import { listConversations, type StoredConversation } from "./sessions.js";

/** ACP `kind` for GG Coder's tool names; the same table `acp-mode.ts` uses. */
const TOOL_KINDS: Record<string, string> = {
  read: "read",
  grep: "search",
  find: "search",
  ls: "search",
  edit: "edit",
  write: "edit",
  bash: "execute",
  screenshot: "execute",
  web_fetch: "fetch",
  source_path: "fetch",
  subagent: "think",
  spawn_agent: "think",
  enter_plan: "switch_mode",
  exit_plan: "switch_mode",
};

/** `name(first string argument)`, clipped for a phone; mirrors GG's own titles. */
export function toolTitle(name: string, args: unknown): string {
  if (args && typeof args === "object") {
    for (const value of Object.values(args as Record<string, unknown>)) {
      if (typeof value !== "string" || value.length === 0) continue;
      const flat = value.replace(/\s+/g, " ").trim();
      return `${name}(${flat.length > 80 ? `${flat.slice(0, 79)}…` : flat})`;
    }
  }
  return name;
}

/** An ACP `session/update` payload, or nothing for events tappy has no row for. */
export type SessionUpdate = Record<string, unknown> & { sessionUpdate: string };

/**
 * Translate one app event. Pure, so the whole mapping is testable without an
 * app, a socket or a phone.
 */
export function translateEvent(event: AppEvent): SessionUpdate | undefined {
  const d = event.data;
  switch (event.type) {
    case "text_delta":
      return typeof d.text === "string" && d.text
        ? { sessionUpdate: "agent_message_chunk", content: { type: "text", text: d.text } }
        : undefined;
    case "thinking_delta":
      return typeof d.text === "string" && d.text
        ? { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: d.text } }
        : undefined;
    case "tool_call_start": {
      if (typeof d.toolCallId !== "string" || typeof d.name !== "string") return undefined;
      return {
        sessionUpdate: "tool_call",
        toolCallId: d.toolCallId,
        title: toolTitle(d.name, d.args),
        kind: TOOL_KINDS[d.name] ?? "other",
        status: "in_progress",
        rawInput: d.args ?? {},
      };
    }
    case "tool_call_end": {
      if (typeof d.toolCallId !== "string") return undefined;
      return {
        sessionUpdate: "tool_call_update",
        toolCallId: d.toolCallId,
        status: d.isError === true ? "failed" : "completed",
        content: [
          {
            type: "content",
            content: { type: "text", text: typeof d.result === "string" ? d.result : "" },
          },
        ],
      };
    }
    case "prompt_sent":
      // Prompts tappy sent are already in its log; only the window's are news.
      return d.origin !== "tappy" && typeof d.text === "string" && d.text.trim()
        ? { sessionUpdate: "user_message_chunk", content: { type: "text", text: d.text } }
        : undefined;
    default:
      return undefined;
  }
}

/** The ACP stop reason a `run_end` frame stands for. */
export function stopReason(data: Record<string, unknown>): "end_turn" | "cancelled" | "refusal" {
  if (data.cancelled === true) return "cancelled";
  if (data.failed === true) return "refusal";
  return "end_turn";
}

/** Both sides canonicalised: macOS `/tmp` is a symlink, Windows letters vary in case. */
async function samePath(a: string, b: string): Promise<boolean> {
  const canon = async (p: string) => {
    const absolute = resolve(p);
    const real = await realpath(absolute).catch(() => absolute);
    return process.platform === "win32" ? real.toLowerCase() : real;
  };
  return (await canon(a)) === (await canon(b));
}

/**
 * Put a conversation in an open app window, and return that window's session.
 *
 * The phone's prompts should run where the user can see them. The window does
 * the switching (only its webview can re-point itself), so this asks, then
 * waits until a window is on the conversation. `match` says which window state
 * counts: the stored file for a resumed chat, the project for a new one.
 * Undefined when no window took it in time — the caller then runs the
 * conversation without a window, which still works, just off screen.
 */
export async function openInAppWindow(
  api: AppClient,
  request: { cwd: string; sessionPath?: string },
  match: (win: AppWindow) => boolean,
  { timeoutMs = 15_000, pollMs = 250 }: { timeoutMs?: number; pollMs?: number } = {},
): Promise<string | undefined> {
  if (!(await api.openInWindow(request.cwd, request.sessionPath))) return undefined;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, pollMs));
    const win = (await api.windows().catch(() => [])).find((w) => w.viewers > 0 && match(w));
    if (win) return win.sessionId;
  }
  return undefined;
}

/** Same file, ignoring separator style and (on Windows) letter case. */
export function samePathSync(a: string, b: string): boolean {
  const norm = (p: string) => {
    const absolute = resolve(p);
    return process.platform === "win32" ? absolute.toLowerCase() : absolute;
  };
  return norm(a) === norm(b);
}

/**
 * The open window to join for a project: the one the user is looking at
 * (most viewers), preferring an idle one so the phone does not barge into a
 * run. Undefined means no window has that project open.
 */
export async function pickWindow(
  windows: AppWindow[],
  cwd: string,
): Promise<AppWindow | undefined> {
  const matches: AppWindow[] = [];
  for (const win of windows) if (await samePath(win.cwd, cwd)) matches.push(win);
  return matches.sort((a, b) => b.viewers - a.viewers || Number(a.busy) - Number(b.busy))[0];
}

/** What the phone shows for one app session: pickers and the command list. */
export interface Controls {
  configOptions: BridgeConfigOption[];
  commands: BridgeCommand[];
  appCommands: AppCommand[];
  skills: AppSkill[];
}

/** Read an app session's pickers, commands and skills in one go. */
export async function readControls(api: AppClient, sessionId: string): Promise<Controls> {
  const [state, models, appCommands, skills] = await Promise.all([
    api.controlState(sessionId),
    api.models(sessionId).catch(() => []),
    api.commands(sessionId).catch(() => []),
    api.skills(sessionId),
  ]);
  return {
    configOptions: state.model ? buildConfigOptions(state, models) : [],
    commands: buildCommands(appCommands, skills),
    appCommands,
    skills,
  };
}

/**
 * An app session to read controls from before a conversation has its own:
 * a watched window on this project, else any watched window, else any.
 * The model list is the same in every window; the current model and the
 * project's commands are this project's when such a window exists.
 */
export function referenceSession(windows: AppWindow[], cwd: string): string | undefined {
  const ranked = [...windows].sort((a, b) => b.viewers - a.viewers);
  return (
    ranked.find((w) => w.viewers > 0 && samePathSync(w.cwd, cwd)) ??
    ranked.find((w) => w.viewers > 0) ??
    ranked[0]
  )?.sessionId;
}

/**
 * Model and thinking pickers for when no GG Coder window is open to ask.
 *
 * The app and the GG Coder CLI share one engine, one model registry and one
 * sign-in, so the CLI's last probe (cached on disk by this daemon) names the
 * same models by the same ids. Without this the phone showed no model button
 * at all for GG Coder App unless a window happened to be open at that moment.
 * A pick made against it is held and applied when the app session opens.
 */
export async function fallbackConfigOptions(): Promise<BridgeConfigOption[]> {
  const cached = await readProbeCache("ggcoder").catch(() => undefined);
  return (cached?.configOptions ?? []).flatMap((option) => {
    if (option.id !== MODEL_OPTION_ID && option.id !== THINKING_OPTION_ID) return [];
    if (option.type !== "select" || !Array.isArray(option.options) || option.options.length === 0)
      return [];
    return [
      {
        id: option.id,
        name: option.name,
        ...(option.description ? { description: option.description } : {}),
        category: option.id === MODEL_OPTION_ID ? "model" : "thought_level",
        type: "select" as const,
        currentValue: String(option.currentValue),
        options: option.options.map((choice) => ({
          value: String(choice.value),
          name: choice.name,
          ...(choice.description ? { description: choice.description } : {}),
        })),
      },
    ];
  });
}

/**
 * The open app's pickers and commands for a project, or undefined when the
 * app is closed, unreachable or slow. Bounded, because the phone's whole chat
 * list waits on the answer this feeds.
 */
export async function liveGgAppControls(
  cwd: string,
  timeoutMs = 4000,
): Promise<Controls | undefined> {
  const read = (async () => {
    const api = await findLiveApp();
    if (!api) return undefined;
    const ref = referenceSession(await api.windows(), cwd);
    return ref ? await readControls(api, ref) : undefined;
  })().catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout(undefined), timeoutMs);
  });
  try {
    return await Promise.race([read, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Apply one picker change the way the app's own footer does. */
export async function applyPick(
  api: AppClient,
  sessionId: string,
  configId: string,
  value: string,
): Promise<void> {
  if (configId === MODEL_OPTION_ID) return api.setModel(sessionId, value);
  if (configId === THINKING_OPTION_ID) {
    return api.setThinking(sessionId, value === THINKING_OFF ? null : value);
  }
  throw new Error(`GG Coder app has no setting '${configId}'.`);
}

type StopReason = ReturnType<typeof stopReason>;

interface Turn {
  resolve: (reason: StopReason) => void;
}

interface Joined {
  /** The id tappy knows this conversation by. */
  externalId: string;
  /** The id the app's engine knows it by; changes whenever the app restarts. */
  appSessionId: string;
  stream: AbortController;
  turn?: Turn;
}

/**
 * The running app, confirmed by asking it rather than trusting a pid check:
 * the newest connection file whose app answers `/windows` with its token.
 */
export async function findLiveApp(
  options: { dir?: string; fetchImpl?: typeof fetch } = {},
): Promise<AppClient | undefined> {
  const candidates = await discoverApps({
    ...(options.dir ? { dir: options.dir } : {}),
    includeUnverified: true,
  });
  for (const candidate of candidates) {
    const api = new AppClient(candidate, options.fetchImpl);
    try {
      await api.windows(AbortSignal.timeout(3000));
      return api;
    } catch {
      // Stale file from a crashed app, or an app without `/windows`.
    }
  }
  return undefined;
}

/** Run the bridge on stdio. Exits with the parent, like every ACP agent. */
export async function runBridge(): Promise<void> {
  // Keyed by the id tappy uses. A stored chat keeps its GG conversation id on
  // the phone for good, while the app hands out a fresh session id each time
  // it reopens one, so every request is translated through this map.
  const joined = new Map<string, Joined>();
  // New conversations not yet opened in the app, by tappy id → project.
  // `session/new` answers without touching the app: tappy opens a session on
  // every probe, purely to read the agent's capabilities and its chat list,
  // and making that need the app meant a closed (or unreachable) app wiped
  // the phone's whole chat and project list. The app conversation is created
  // when the first message is sent, which is when the app is really needed.
  //
  // Picker changes made before then are held here and applied to the app
  // session once it exists, before the first message runs.
  const unopened = new Map<
    string,
    { cwd: string; picks: Map<string, string>; configOptions: BridgeConfigOption[] }
  >();
  let client: AppClient | undefined;

  async function app(): Promise<AppClient> {
    const found = await findLiveApp();
    if (!found) {
      throw new Error(
        "GG Coder app is not running. Open it on this computer, then try again. " +
          "(It needs the build from github.com/zahdourmoustafa/gg-coder.)",
      );
    }
    client = found;
    return client;
  }

  const connection = agent({ name: "tappy-gg-app" });

  type Notifier = { client: { notify: (method: string, params: unknown) => Promise<void> } };

  /**
   * Send the phone this session's pickers and/or command list. Run after the
   * reply that created the session (a timer, as GG Coder's ACP mode does): the
   * daemon only files an update under a session it has already been told of.
   */
  function announce(
    ctx: Notifier,
    externalId: string,
    controls: Controls,
    what: { config: boolean; commands: boolean },
  ): void {
    setTimeout(() => {
      if (what.config && controls.configOptions.length > 0) {
        void ctx.client
          .notify("session/update", {
            sessionId: externalId,
            update: {
              sessionUpdate: "config_option_update",
              configOptions: controls.configOptions,
            },
          })
          .catch(() => {});
      }
      if (what.commands) {
        void ctx.client
          .notify("session/update", {
            sessionId: externalId,
            update: {
              sessionUpdate: "available_commands_update",
              availableCommands: controls.commands,
            },
          })
          .catch(() => {});
      }
    }, 0);
  }

  /** Re-read a joined session's controls and send them, or nothing on failure. */
  async function refreshControls(
    ctx: Notifier,
    externalId: string,
    appSessionId: string,
    what: { config: boolean; commands: boolean },
  ): Promise<Controls | undefined> {
    const api = client ?? (await app().catch(() => undefined));
    if (!api) return undefined;
    const controls = await readControls(api, appSessionId).catch(() => undefined);
    if (controls) announce(ctx, externalId, controls, what);
    return controls;
  }

  async function join(
    ctx: {
      client: {
        notify: (method: string, params: unknown) => Promise<void>;
        request: (method: string, params: unknown) => Promise<unknown>;
      };
    },
    externalId: string,
    appSessionId: string = externalId,
  ): Promise<Joined> {
    const existing = joined.get(externalId);
    if (existing?.appSessionId === appSessionId) return existing;
    existing?.stream.abort();
    const api = client ?? (await app());
    const entry: Joined = { externalId, appSessionId, stream: new AbortController() };
    joined.set(externalId, entry);

    void (async () => {
      try {
        for await (const event of api.events(appSessionId, entry.stream.signal)) {
          const update = translateEvent(event);
          if (update) {
            await ctx.client.notify("session/update", { sessionId: externalId, update });
            continue;
          }
          if (event.type === "model_change" || event.type === "thinking_change") {
            // Switched in the window (or by the phone): the pickers follow.
            void refreshControls(ctx, externalId, appSessionId, { config: true, commands: false });
            continue;
          }
          if (event.type === "run_end") {
            const turn = entry.turn;
            entry.turn = undefined;
            turn?.resolve(stopReason(event.data));
            continue;
          }
          if (event.type === "ask_user" && typeof event.data.id === "string") {
            const askId = event.data.id;
            // Answered on the phone or not at all: the app's own window can
            // answer the same question, and whichever lands first wins there.
            void ctx.client
              .request("_gg/ask_user", {
                sessionId: externalId,
                questions: event.data.questions,
              })
              .then((answer) => api.answer(appSessionId, askId, answer ?? { action: "cancel" }))
              .catch(() => {
                // Already answered in the window (409), or the app went away.
              });
          }
        }
      } catch {
        // Stream ended: the app quit or the session closed. Release any turn.
      } finally {
        entry.turn?.resolve("cancelled");
        entry.turn = undefined;
        if (joined.get(externalId) === entry) joined.delete(externalId);
      }
    })();
    return entry;
  }

  async function replay(
    ctx: { client: { notify: (method: string, params: unknown) => Promise<void> } },
    externalId: string,
    appSessionId: string = externalId,
  ): Promise<void> {
    const api = client ?? (await app());
    for (const row of await api.history(appSessionId)) {
      await ctx.client.notify("session/update", {
        sessionId: externalId,
        update: {
          sessionUpdate: row.role === "user" ? "user_message_chunk" : "agent_message_chunk",
          content: { type: "text", text: row.text },
        },
      });
    }
  }

  /** The window for this project, or a new conversation in the app's engine. */
  async function openFor(cwd: string, sessionPath?: string): Promise<string> {
    const api = client ?? (await app());
    const before = await api.windows();
    const win = sessionPath
      ? undefined
      : await pickWindow(
          before.filter((w) => w.viewers > 0),
          cwd,
        );
    if (win) return win.sessionId;
    // A new chat from the phone: ask a window to start one for the project, so
    // it runs on screen. A window counts once it is on the project with a
    // session it did not have before.
    const known = new Set(before.map((w) => w.sessionId));
    const opened = await openInAppWindow(
      api,
      { cwd, ...(sessionPath ? { sessionPath } : {}) },
      (w) => !known.has(w.sessionId) && samePathSync(w.cwd, cwd),
    );
    return opened ?? (await api.createSession(cwd, sessionPath));
  }

  /** The `session/load` reply: the window's pickers, with its commands to follow. */
  async function loadedControls(
    ctx: Notifier,
    externalId: string,
    appSessionId: string,
  ): Promise<{ configOptions?: BridgeConfigOption[] }> {
    const api = client ?? (await app());
    const controls = await readControls(api, appSessionId).catch(() => undefined);
    if (!controls) return {};
    announce(ctx, externalId, controls, { config: false, commands: true });
    return { configOptions: controls.configOptions };
  }

  function appIdFor(externalId: string): string {
    return joined.get(externalId)?.appSessionId ?? externalId;
  }

  async function findStored(sessionId: string): Promise<StoredConversation | undefined> {
    return (await listConversations()).find((entry) => entry.sessionId === sessionId);
  }

  const app_ = connection
    .onRequest("initialize", async () => {
      // No app lookup here. Listing chats only reads ~/.gg/sessions, so a
      // closed app — or one tappy cannot find — must not make the whole
      // provider fail, which left the phone with no chats and no projects.
      // Opening or sending is what needs the app, and says so when it is gone.
      return {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          // Listed from ~/.gg/sessions, which the app and the CLI share.
          sessionCapabilities: { list: {} },
          promptCapabilities: { image: false },
          // Questions are GG's `_gg/ask_user`, which tappy already renders.
          _meta: { gg: { askUser: true } },
        },
        agentInfo: { name: "gg-coder-app", title: "GG Coder App", version: "0.1.0" },
        authMethods: [],
      };
    })
    .onRequest("session/new", async (ctx) => {
      const { cwd } = ctx.params as { cwd: string };
      const sessionId = `gg-app-${randomUUID()}`;
      const pending = {
        cwd,
        picks: new Map<string, string>(),
        configOptions: [] as BridgeConfigOption[],
      };
      unopened.set(sessionId, pending);
      // Best effort: pickers and commands come from an open window, so a
      // closed app still gets a session — just without them until it opens.
      const api = client ?? (await findLiveApp().catch(() => undefined));
      if (api) {
        client = api;
        const ref = referenceSession(await api.windows().catch(() => []), cwd);
        const controls = ref ? await readControls(api, ref).catch(() => undefined) : undefined;
        if (controls) {
          pending.configOptions = controls.configOptions;
          announce(ctx, sessionId, controls, { config: false, commands: true });
        }
      }
      if (pending.configOptions.length === 0) pending.configOptions = await fallbackConfigOptions();
      return { sessionId, configOptions: pending.configOptions };
    })
    .onRequest("session/list", async () => ({
      sessions: (await listConversations()).map((entry) => ({
        sessionId: entry.sessionId,
        cwd: entry.cwd,
        title: entry.title,
        updatedAt: entry.updatedAt,
      })),
    }))
    .onRequest("session/load", async (ctx) => {
      const { sessionId, cwd } = ctx.params as { sessionId: string; cwd: string };
      const api = client ?? (await app());
      const windows = await api.windows();
      // A conversation started from the phone this app session: still open.
      if (windows.some((w) => w.sessionId === sessionId)) {
        await replay(ctx, sessionId);
        await join(ctx, sessionId);
        return await loadedControls(ctx, sessionId, sessionId);
      }
      // A stored chat. Join the window that has it open if there is one, so
      // phone and window stay in step; otherwise reopen it in the app's engine.
      const stored = await findStored(sessionId);
      if (!stored) {
        throw new Error(`GG Coder has no chat '${sessionId}' on this computer (${cwd}).`);
      }
      const isStored = (w: AppWindow) =>
        w.sessionPath !== null && samePathSync(w.sessionPath, stored.path);
      const open = windows.find((w) => w.viewers > 0 && isStored(w)) ?? windows.find(isStored);
      const appSessionId =
        open?.sessionId ??
        (await openInAppWindow(api, { cwd: stored.cwd, sessionPath: stored.path }, isStored)) ??
        (await api.createSession(stored.cwd, stored.path));
      await replay(ctx, sessionId, appSessionId);
      await join(ctx, sessionId, appSessionId);
      return await loadedControls(ctx, sessionId, appSessionId);
    })
    .onRequest("session/set_config_option", async (ctx) => {
      const { sessionId, configId, value } = (ctx.params ?? {}) as {
        sessionId?: string;
        configId?: string;
        value?: unknown;
      };
      if (!sessionId || !configId || typeof value !== "string") {
        throw new Error(
          "session/set_config_option needs a sessionId, configId and a string value.",
        );
      }
      const pending = unopened.get(sessionId);
      if (pending) {
        // No app session yet: remember it, and apply it before the first message.
        pending.picks.set(configId, value);
        pending.configOptions = pending.configOptions.map((option) =>
          option.id === configId ? { ...option, currentValue: value } : option,
        );
        return { configOptions: pending.configOptions };
      }
      const api = client ?? (await app());
      const appSessionId = appIdFor(sessionId);
      await applyPick(api, appSessionId, configId, value);
      // The full set: a new model can change which thinking levels exist.
      return { configOptions: (await readControls(api, appSessionId)).configOptions };
    })
    .onNotification("session/cancel", async (ctx) => {
      const { sessionId } = (ctx.params ?? {}) as { sessionId?: string };
      if (sessionId && client && joined.has(sessionId)) {
        await client.cancel(appIdFor(sessionId)).catch(() => {});
      }
    })
    .onRequest("session/prompt", async (ctx) => {
      const { sessionId, prompt } = ctx.params as {
        sessionId: string;
        prompt: { type: string; text?: string }[];
      };
      const text = prompt
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("\n")
        .trim();
      const pending = unopened.get(sessionId);
      const entry =
        joined.get(sessionId) ??
        (pending !== undefined
          ? await join(ctx, sessionId, await openFor(pending.cwd))
          : await join(ctx, sessionId));
      unopened.delete(sessionId);
      const api = client ?? (await app());
      if (pending) {
        // Model before thinking: the model decides which levels exist.
        for (const id of [MODEL_OPTION_ID, THINKING_OPTION_ID]) {
          const value = pending.picks.get(id);
          if (value !== undefined) await applyPick(api, entry.appSessionId, id, value);
        }
        // Now the conversation's own window: its project's commands and model.
        void refreshControls(ctx, sessionId, entry.appSessionId, { config: true, commands: true });
      }
      const sent = text.startsWith("/")
        ? rewriteSkillPrompt(
            text,
            await api.commands(entry.appSessionId).catch(() => []),
            await api.skills(entry.appSessionId),
          )
        : text;
      const done = new Promise<StopReason>((resolveTurn) => {
        entry.turn = { resolve: resolveTurn };
      });
      try {
        await api.prompt(entry.appSessionId, sent);
      } catch (error) {
        entry.turn = undefined;
        throw error;
      }
      return { stopReason: await done };
    });

  const connected = app_.connect(
    ndJsonStream(
      Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>,
      Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
    ),
  );
  // Held open until the ACP connection itself closes. A web-stream wrapper
  // over stdin does not always keep the event loop alive, and the bridge used
  // to exit the instant it started — before answering the handshake — so the
  // provider failed and the phone showed GG Coder App with no chats at all.
  const keepAlive = setInterval(() => {}, 60_000);
  await connected.closed.catch(() => {});
  clearInterval(keepAlive);
  for (const entry of joined.values()) entry.stream.abort();
}
