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
 */
import { agent, ndJsonStream } from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { Readable, Writable } from "node:stream";

import { AppClient, type AppEvent, type AppWindow } from "./client.js";
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
  return matches.sort(
    (a, b) => b.viewers - a.viewers || Number(a.busy) - Number(b.busy),
  )[0];
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
  const unopened = new Map<string, string>();
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

  async function join(
    ctx: { client: { notify: (method: string, params: unknown) => Promise<void>; request: (method: string, params: unknown) => Promise<unknown> } },
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
    const win = sessionPath ? undefined : await pickWindow(await api.windows(), cwd);
    return win?.sessionId ?? (await api.createSession(cwd, sessionPath));
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
      unopened.set(sessionId, cwd);
      return { sessionId };
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
        return {};
      }
      // A stored chat. Join the window that has it open if there is one, so
      // phone and window stay in step; otherwise reopen it in the app's engine.
      const stored = await findStored(sessionId);
      if (!stored) {
        throw new Error(`GG Coder has no chat '${sessionId}' on this computer (${cwd}).`);
      }
      const open = windows.find((w) => w.sessionPath !== null && samePathSync(w.sessionPath, stored.path));
      const appSessionId = open?.sessionId ?? (await api.createSession(stored.cwd, stored.path));
      await replay(ctx, sessionId, appSessionId);
      await join(ctx, sessionId, appSessionId);
      return {};
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
      const pendingCwd = unopened.get(sessionId);
      const entry =
        joined.get(sessionId) ??
        (pendingCwd !== undefined
          ? await join(ctx, sessionId, await openFor(pendingCwd))
          : await join(ctx, sessionId));
      unopened.delete(sessionId);
      const api = client ?? (await app());
      const done = new Promise<StopReason>((resolveTurn) => {
        entry.turn = { resolve: resolveTurn };
      });
      try {
        await api.prompt(entry.appSessionId, text);
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
