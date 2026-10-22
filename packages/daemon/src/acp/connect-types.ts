/**
 * The ACP connection's public types, and the normalisers that turn an agent's
 * raw selector/command payloads into them. Moved out of `connect.ts`
 * unchanged; `connect.ts` re-exports every public name.
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { ClientConnection } from "@agentclientprotocol/sdk";
import { asRecord, asString } from "@tappy/protocol";
import type { LoadedProvider } from "../providers/registry.js";
import type { StoredAttachment } from "../attachments.js";
import type { PromptCapabilities } from "./promptBlocks.js";
import type { AgentProject } from "../projects.js";

/**
 * A session-level selector advertised by the agent: model, thinking level, mode.
 * tappy never hardcodes model names — each agent reports its own, so connecting a
 * new app automatically brings its models and reasoning levels with it.
 * https://agentclientprotocol.com/protocol/v1/session-config-options
 */
export interface ConfigOption {
  id: string;
  name: string;
  description?: string;
  /** 'model' | 'thought_level' | 'mode' | 'model_config', or a custom '_' name. */
  category?: string;
  type: string;
  currentValue: string | boolean;
  options?: { value: string; name: string; description?: string }[];
}

/**
 * Agents differ on the identifier field: ACP v1 uses `id`, the v2 draft uses
 * `configId`. Accept either so a mixed-version fleet works, and emit `id`.
 */
export function normaliseConfigOptions(raw: unknown): ConfigOption[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const option = entry as Record<string, unknown>;
    const id = (option.id ?? option.configId) as string | undefined;
    if (!id || typeof option.name !== "string") return [];
    return [
      {
        id,
        name: option.name,
        description: option.description as string | undefined,
        category: (option.category ?? undefined) as string | undefined,
        type: typeof option.type === "string" ? option.type : "select",
        currentValue: option.currentValue as string | boolean,
        options: Array.isArray(option.options)
          ? (option.options as ConfigOption["options"])
          : undefined,
      },
    ];
  });
}

/**
 * The `models` block `session/new` may return, alongside or instead of
 * `configOptions`. Claude Code's adapter reports its live model list this way —
 * the set is whatever that install currently offers, so it tracks agent updates
 * on its own and tappy must never carry a model list of its own.
 */
export interface SessionModelState {
  availableModels?: { modelId: string; name: string; description?: string }[];
  currentModelId?: string;
}

/** Present the agent's `models` block as the same selector shape as the rest. */
export function modelsAsConfigOption(models: SessionModelState | undefined): ConfigOption[] {
  const available = models?.availableModels;
  if (!Array.isArray(available) || available.length === 0) return [];
  return [
    {
      id: MODEL_CONFIG_ID,
      name: "Model",
      category: "model",
      type: "select",
      currentValue: models?.currentModelId ?? available[0]!.modelId,
      options: available.map((model) => ({
        value: model.modelId,
        name: model.name,
        description: model.description,
      })),
    },
  ];
}

/**
 * Synthetic id for the selector built from `models`.
 *
 * That block has no config id of its own, so setting it routes to
 * `session/set_model` rather than `session/set_config_option`.
 */
export const MODEL_CONFIG_ID = "__acp_model";

/**
 * Synthetic id for the selector built from `modes`.
 *
 * Same story as the model: the legacy `modes` block carries no config id, so
 * setting it routes to `session/set_mode`. Sending `session/set_config_option`
 * for an id the agent never advertised is silently accepted and does nothing —
 * which is exactly what "I picked a mode and nothing happened" looks like.
 */
export const MODE_CONFIG_ID = "__acp_mode";

/**
 * A conversation the agent already has on disk.
 *
 * Coding agents keep their own history, so a phone should see the work started
 * at the desk, not just what it started itself.
 * https://agentclientprotocol.com/protocol/v1/session-listing
 */
export interface AgentSession {
  sessionId: string;
  cwd: string;
  title?: string;
  /** ISO 8601 timestamp of last activity, when the agent tracks one. */
  updatedAt?: string;
  /** Number of message rows the app will render before this session is opened. */
  messageCount?: number;
}

/**
 * What one `session/list` call yields.
 *
 * Three views of the same answer because they serve different screens: the
 * capped `sessions` are the drawer's recent history (the only ones whose
 * message counts are worth reading from disk up front), `projects` is the
 * complete set of places this agent has worked, and `all` is kept so choosing
 * one of those projects can be answered without asking the agent again.
 */
export interface AgentSessionList {
  sessions: AgentSession[];
  projects: AgentProject[];
  all: AgentSession[];
}

/** A slash command the agent offers, as advertised over ACP. */
export interface AvailableCommand {
  name: string;
  description: string;
  /** Placeholder for the argument it expects, when it takes one. */
  hint?: string;
}

/**
 * Normalise an `available_commands_update` payload.
 *
 * Nothing is filtered here: which commands make sense on a phone is a client
 * decision, and the daemon also serves clients that are not this app.
 */
export function readAvailableCommands(raw: unknown): AvailableCommand[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .flatMap((entry: unknown) => {
      const command = asRecord(entry);
      const name = asString(command?.name)?.trim();
      if (!command || !name) return [];
      const hint = asString(asRecord(command.input)?.hint);
      return [
        {
          name,
          description: asString(command.description) ?? "",
          ...(hint !== undefined ? { hint } : {}),
        },
      ];
    });
}

/**
 * GG Coder's ACP extensions (`_meta.gg` on `initialize`), as the agent
 * advertised them. Absent for every other agent and for an older ggcoder —
 * which is the signal to behave exactly as before.
 */
export interface GgCapabilities {
  queue?: unknown;
  askUser?: unknown;
  goals?: unknown;
  planReview?: unknown;
  autopilot?: unknown;
  checklist?: unknown;
}

/** `_meta.gg.goal` on a session opened in a GG Goals folder. */
export interface GgGoalMeta {
  id: string;
  phase?: string;
  paused?: boolean;
  needsKickoff?: boolean;
}

/** Per-session receivers for GG's agent -> client extension traffic. */
export interface GgCallbacks {
  /** `_gg/ask_user`; answer with `answerAsk`. Registered before this is called. */
  onAskUser?: (request: { requestId: string; params: unknown }) => void;
  /** The agent withdrew an open ask (JSON-RPC cancel); drop it from state. */
  onAskClosed?: (requestId: string) => void;
  /** `_gg/queue_update` notification params. */
  onQueueUpdate?: (params: unknown) => void;
  /** `_gg/goal_state` notification params. */
  onGoalState?: (params: unknown) => void;
  /** `_gg/plan_state` notification params. */
  onPlanState?: (params: unknown) => void;
  /** `_gg/session_reset` notification params (an accepted plan's fresh context). */
  onSessionReset?: (params: unknown) => void;
  /** `_gg/autopilot_state` notification params. */
  onAutopilotState?: (params: unknown) => void;
  /** `_gg/autopilot_event` notification params. */
  onAutopilotEvent?: (params: unknown) => void;
  /** `_gg/checklist_changed` notification params. */
  onChecklistChanged?: (params: unknown) => void;
}

/** What an `_gg/ask_user` request is answered with. */
export type AskAnswer =
  | { action: "answer"; answers: Record<string, string | string[]> }
  | { action: "cancel" };

/** A GG Goals turn: a `session/prompt` with an empty prompt and `_meta.gg.goalTurn`. */
export interface PromptOptions {
  goalTurn?: "kickoff" | "resume";
  /** Decide a pending plan: an empty prompt with `_meta.gg.planDecision`. */
  planDecision?: {
    action: "accept" | "feedback" | "reject";
    feedback?: string;
    generation: number;
  };
}

export interface AcpSessionHandle {
  connection: ClientConnection;
  child: ChildProcessWithoutNullStreams;
  /** The session prompts currently target. Changes when `adopt` opens another. */
  readonly sessionId: string;
  /** Selectors for the current session. Empty when it offers none. */
  readonly configOptions: ConfigOption[];
  /**
   * Slash commands the agent advertised for the current session.
   *
   * Sent as a notification shortly after `session/new`, not as part of its
   * result, so this fills in a moment after the session opens. The set depends
   * on the project's own `commands/` directories, so it is per session rather
   * than a property of the agent.
   */
  readonly availableCommands: AvailableCommand[];
  /** True when the agent can replay a past session via `session/load`. */
  canLoadSession: boolean;
  /**
   * The agent's own stored conversations, newest first.
   *
   * Empty when the agent does not advertise `session/list` — not every agent
   * persists history, and asking one that doesn't is an error, not an empty list.
   */
  listSessions(): Promise<AgentSessionList>;
  /**
   * Open another session on this same agent process.
   *
   * Booting the process is the expensive part of a connection — GG Coder
   * takes ~5s while `session/load` itself answers in ~30ms — so the daemon
   * keeps a warm handle per provider and adopts it for the next conversation
   * instead of spawning again.
   */
  adopt(options: AdoptOptions): Promise<void>;
  /**
   * What this agent accepts in a prompt besides text.
   *
   * Undefined when it advertised nothing, which means text only: sending an
   * image block to an agent that never claimed `image` is a protocol error,
   * not a graceful degradation.
   */
  readonly promptCapabilities?: PromptCapabilities;
  prompt(
    text: string,
    attachments?: readonly StoredAttachment[],
    options?: PromptOptions,
  ): Promise<unknown>;
  cancel(): Promise<void>;
  /** `agentCapabilities._meta.gg`, undefined when the agent advertised none. */
  readonly ggCapabilities?: GgCapabilities;
  /** `_meta.gg.goal` from opening the current session, when it is a goal's coordinator. */
  readonly goal?: GgGoalMeta;
  /** Send an extension (`_`-prefixed) request on this connection. */
  extRequest<T = unknown>(method: string, params: Record<string, unknown>): Promise<T>;
  /** Answer an open `_gg/ask_user`. False when no such question is pending. */
  answerAsk(requestId: string, result: AskAnswer): boolean;
  setConfigOption(configId: string, value: string | boolean): Promise<ConfigOption[]>;
  answerPermission(requestId: string, optionId: string): boolean;
  close(): void;
}

export interface AdoptOptions {
  /** Resume this stored session; a fresh one is created when omitted. */
  loadSessionId?: string;
  /**
   * The project this conversation opens in.
   *
   * Required, and not optional with a fallback: a warm process was spawned for
   * whatever workspace the capability probe happened to use, which under
   * launchd is the home directory. Reusing that for a session the user opened
   * against a chosen project is what made the agent report the wrong `cwd` —
   * so every adopt has to say where it is going.
   */
  cwd: string;
  /** As on {@link ConnectOptions}: skip the replay, keep the agent context. */
  haveHistory?: boolean;
  onUpdate: (payload: unknown) => void;
  onPermissionRequest: (request: { requestId: string; params: unknown }) => void;
  onConfigOptions?: (options: ConfigOption[]) => void;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  gg?: GgCallbacks;
}

export interface ConnectOptions {
  /** GG Coder extension receivers for the first session. */
  gg?: GgCallbacks;
  provider: LoadedProvider;
  cwd: string;
  /** Called for every ACP `session/update` notification, in arrival order. */
  onUpdate: (payload: unknown) => void;
  /**
   * Called when the agent asks the user to approve something. Resolve the
   * returned promise by calling `answerPermission` with one of the option ids.
   */
  onPermissionRequest: (request: { requestId: string; params: unknown }) => void;
  /**
   * The agent changed the session's selectors on its own.
   *
   * Not every change comes from `setConfigOption`: the option set is
   * model-dependent, so switching model adds or removes the thinking-level
   * selector, and `/model` typed as a prompt changes it with no request at all.
   * Without this the pills keep describing the model that was current when the
   * session opened.
   */
  onConfigOptions?: (options: ConfigOption[]) => void;
  onStderr?: (line: string) => void;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  /**
   * Resume one of the agent's own sessions instead of starting a fresh one.
   *
   * `session/load` replays the whole conversation through `onUpdate` before it
   * resolves, which is how a phone picks up a thread started at the desk.
   */
  loadSessionId?: string;
  /**
   * The caller already has this conversation's history and does not want it
   * replayed — only the agent-side context back.
   *
   * Set when the daemon painted the thread from its own cache, which it does
   * for every provider. Without it the agent replays a transcript the user is
   * already looking at, and the daemon drops every message of it: 8,354
   * notifications and 938ms, measured against GG Coder, to arrive at the screen
   * that was already drawn.
   *
   * Only a hint. An agent that does not advertise `session/resume` still gets a
   * `session/load`, and the duplicate replay is still discarded as before.
   */
  haveHistory?: boolean;
  /**
   * How long to wait for the agent to answer `initialize`.
   *
   * Overridable mainly so tests do not have to wait out the real budget.
   */
  handshakeTimeoutMs?: number;
}
