/**
 * Claude Code's side of a terminal conversation. The tailing is shared
 * (`mirror.ts`); this is only where Claude keeps the conversation and what a
 * line of it means.
 *
 * - `~/.claude/sessions/<pid>.json` — one per running Claude, naming the
 *   conversation it is in. The wrapper knows the pid of the Claude it started,
 *   so a terminal maps to its conversation exactly. It changes with `/clear`.
 * - `~/.claude/projects/<project>/<conversation>.jsonl` — the conversation.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { asRecord, type wire } from "@tappy/protocol";
import { conversationEntry, displayMessagesFromLine, encodeCwd } from "../acp/claude-history.js";
import {
  type MirrorSource,
  type MirrorTarget,
  TerminalMirror,
  toolLabel,
  type MirrorUpdate,
} from "./mirror.js";
import { userHome } from "./platform.js";

export { toolLabel, type MirrorUpdate };

/** Where Claude keeps its files: `$CLAUDE_CONFIG_DIR`, as Claude itself reads it, or `~/.claude`. */
export function claudeHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR || join(userHome(env), ".claude");
}

/** A conversation id is used in a file name, so it is held to the shape Claude mints. */
const CONVERSATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/**
 * What one transcript line adds for the phone.
 *
 * The words through the same reader that replays a conversation into the app,
 * so both agree on what counts as part of it — including leaving out the
 * context Claude files beside the conversation. Thinking is left out, as the
 * terminal folds it away; pictures are left out for now, being megabytes each.
 */
export function terminalMessagesFromLine(line: string): wire.TerminalMessage[] {
  const entry = conversationEntry(line);
  if (!entry) return [];
  const messages: wire.TerminalMessage[] = [];
  // How a step ended, when it did not simply succeed: the person said no at
  // the prompt, or it failed. Filed as a tool result under the user role.
  if (entry.role === "user" && Array.isArray(entry.content)) {
    for (const block of entry.content) {
      const result = asRecord(block);
      if (result?.type !== "tool_result" || result.is_error !== true) continue;
      const said =
        typeof result.content === "string" ? result.content : JSON.stringify(result.content ?? "");
      messages.push({
        role: "tool",
        text: /doesn't want to proceed|rejected/i.test(said) ? "Declined" : "Failed",
      });
    }
  }
  for (const message of displayMessagesFromLine(line)) {
    if (message.role === "thought" || !message.text) continue;
    // Claude's own marker, not something anyone typed. After a declined step
    // the "Declined" line already says it; on its own it is Esc pressed mid-turn.
    const interrupted = /^\[Request interrupted by user( for tool use)?\]$/.exec(message.text);
    if (interrupted) {
      if (!interrupted[1]) messages.push({ role: "tool", text: "Stopped" });
      continue;
    }
    messages.push({ role: message.role === "user" ? "user" : "agent", text: message.text });
  }
  if (entry.role === "assistant" && Array.isArray(entry.content)) {
    for (const block of entry.content) {
      const tool = asRecord(block);
      if (tool?.type === "tool_use" && typeof tool.name === "string") {
        messages.push({ role: "tool", text: toolLabel(tool.name, tool.input) });
      }
    }
  }
  return messages;
}

/**
 * What Claude says it is doing, from the `status` it keeps in its own session
 * file (Claude Code 2.1: `busy`/`working`/`running` on a turn, `waiting` with a
 * `waitingFor` such as "permission prompt", `idle` at its prompt).
 */
export function claudeActivity(status: unknown): "working" | "waiting" | "idle" | undefined {
  switch (status) {
    case "busy":
    case "working":
    case "running":
      return "working";
    case "waiting":
      return "waiting";
    case "idle":
      return "idle";
    default:
      return undefined;
  }
}

/**
 * For a Claude that keeps no `sessions/` folder at all: the newest transcript
 * in the project written since the terminal opened, as GG Coder is followed.
 * Only then — where Claude does keep it, a missing pid record means "not
 * written yet", and guessing would pick up another window's conversation.
 */
async function newestTranscript(
  home: string,
  cwd: string,
  openedAt: number,
): Promise<MirrorTarget | undefined> {
  try {
    await stat(join(home, "sessions"));
    return undefined;
  } catch {
    // No such folder: this Claude never writes one.
  }
  const dir = join(home, "projects", encodeCwd(cwd));
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return undefined;
  }
  let newest: { id: string; mtime: number } | undefined;
  for (const name of names) {
    const id = name.slice(0, -".jsonl".length);
    if (!CONVERSATION_ID.test(id)) continue;
    try {
      const { mtimeMs } = await stat(join(dir, name));
      if (mtimeMs < openedAt - 2000) continue;
      if (!newest || mtimeMs > newest.mtime) newest = { id, mtime: mtimeMs };
    } catch {
      // Gone between the listing and now.
    }
  }
  if (!newest) return undefined;
  return { id: newest.id, path: join(dir, `${newest.id}.jsonl`), conversation: newest.id };
}

export function claudeSource(
  pid: number,
  cwd: string,
  home: string = claudeHome(),
  openedAt?: number,
): MirrorSource {
  return {
    async locate(): Promise<MirrorTarget | undefined> {
      let record: Record<string, unknown> | undefined;
      try {
        record = asRecord(
          JSON.parse(await readFile(join(home, "sessions", `${pid}.json`), "utf8")),
        );
      } catch {
        return openedAt === undefined ? undefined : newestTranscript(home, cwd, openedAt);
      }
      const id = record?.sessionId;
      if (typeof id !== "string" || !CONVERSATION_ID.test(id)) return undefined;
      // Claude's own idea of its project: the folder its transcript is filed under.
      const project = typeof record?.cwd === "string" && record.cwd ? record.cwd : cwd;
      return {
        id,
        path: join(home, "projects", encodeCwd(project), `${id}.jsonl`),
        conversation: id,
        activity: claudeActivity(record?.status),
      };
    },
    parse: terminalMessagesFromLine,
  };
}

/** Claude's conversation in one terminal. */
export class ClaudeMirror extends TerminalMirror {
  constructor(
    pid: number,
    cwd: string,
    onUpdate: (update: MirrorUpdate) => void,
    home: string = claudeHome(),
    pollMs?: number,
  ) {
    super(claudeSource(pid, cwd, home), onUpdate, pollMs);
  }
}
