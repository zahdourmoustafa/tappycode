/**
 * Codex's and GG Coder's side of a terminal conversation. The tailing is
 * shared (`mirror.ts`); each source here is only where that agent keeps the
 * conversation and what one line of it means.
 *
 * Both formats were read off real files on a working machine (Codex 0.147,
 * GG Coder 5.83), not from documentation.
 */
import { execFile } from "node:child_process";
import { open, readdir, readlink, stat } from "node:fs/promises";
import { basename, join, sep } from "node:path";
import { promisify } from "node:util";
import { asRecord, type wire } from "@tappy/protocol";
import { encodeCwd as ggcoderProjectDir } from "../acp/ggcoder-history.js";
import { type MirrorSource, type MirrorTarget, toolLabel } from "./mirror.js";
import { samePath, type TerminalPlatform, terminalPlatform, userHome } from "./platform.js";

export { ggcoderProjectDir };

const run = promisify(execFile);

// ── Codex ───────────────────────────────────────────────────

/** Where Codex keeps its files: `$CODEX_HOME`, as Codex itself reads it, or `~/.codex`. */
export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME || join(userHome(env), ".codex");
}

/** A Codex conversation file: `rollout-<time>-<id>.jsonl`, under `sessions/`, with either slash. */
const ROLLOUT = /[\\/]sessions[\\/](?:[^\\/]+[\\/])*rollout-[^\\/]+\.jsonl$/;

function itemText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const block = asRecord(part);
      return typeof block?.text === "string" ? block.text : "";
    })
    .join("")
    .trim();
}

/**
 * What one line of a Codex rollout adds for the phone.
 *
 * Only `item_completed` events are read: Codex files each one when the person
 * has typed something, the agent has said something, or a command has run.
 * The rest of the file is what Codex sends its model — the developer
 * instructions, the `<environment_context>` block, skills and permissions text,
 * reasoning — filed as `response_item` lines beside the conversation. None of
 * those are read, so none of them can reach the phone.
 */
export function codexMessagesFromLine(line: string): wire.TerminalMessage[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }
  const entry = asRecord(parsed);
  if (entry?.type !== "event_msg") return [];
  const payload = asRecord(entry.payload);
  if (payload?.type !== "item_completed") return [];
  const item = asRecord(payload.item);
  switch (item?.type) {
    case "UserMessage": {
      const text = itemText(item.content);
      return text ? [{ role: "user", text }] : [];
    }
    case "AgentMessage": {
      // Commentary between steps is filed too, often empty; only words count.
      const text = itemText(item.content);
      return text ? [{ role: "agent", text }] : [];
    }
    case "CommandExecution": {
      // `["/bin/zsh", "-lc", "ls -a"]`: the command is the last argument.
      const argv = Array.isArray(item.command)
        ? item.command.filter((part): part is string => typeof part === "string")
        : [];
      const command =
        argv.length >= 3 && /^-\w*c$/.test(argv[argv.length - 2] ?? "")
          ? argv[argv.length - 1]
          : argv.join(" ");
      return [{ role: "tool", text: toolLabel("exec_command", { command }) }];
    }
    case "FileChange":
      return [{ role: "tool", text: "Edit files" }];
    case "WebSearch":
      return [{ role: "tool", text: toolLabel("web_search", { query: item.query }) }];
    default:
      return [];
  }
}

/**
 * The rollout a Codex process has open, by asking the system which files it
 * holds. Codex writes no record of its own pid, but it keeps its conversation
 * file open for as long as the conversation runs — and opens a new one for a
 * new conversation, which is how a `/new` is noticed.
 */
async function openRollout(pid: number, platform: TerminalPlatform): Promise<string | undefined> {
  // Linux lists a process's open files itself, without lsof (which many
  // distributions do not install).
  if (platform === "linux") return openRolloutFromProc(pid);
  let stdout: string;
  try {
    ({ stdout } = await run("lsof", ["-Fn", "-p", String(pid)], { timeout: 5000 }));
  } catch (error) {
    // lsof exits 1 when it finds nothing to list; what it printed still counts.
    stdout = (error as { stdout?: string }).stdout ?? "";
  }
  const paths = stdout
    .split("\n")
    .filter((line) => line.startsWith("n") && ROLLOUT.test(line))
    .map((line) => line.slice(1));
  // Newest by name: rollouts are named by when they started.
  return paths.sort().at(-1);
}

/** `/proc/<pid>/fd`: each entry links to what the process holds open. */
async function openRolloutFromProc(pid: number): Promise<string | undefined> {
  let fds: string[];
  try {
    fds = await readdir(`/proc/${pid}/fd`);
  } catch {
    return undefined;
  }
  const paths: string[] = [];
  for (const fd of fds) {
    try {
      const target = await readlink(`/proc/${pid}/fd/${fd}`);
      if (ROLLOUT.test(target)) paths.push(target);
    } catch {
      // Closed between the listing and now.
    }
  }
  return paths.sort().at(-1);
}

/** The folder a rollout's first line says Codex was started in. */
async function rolloutCwd(path: string): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(path, "r");
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const first = buffer.subarray(0, bytesRead).toString("utf8").split("\n")[0] ?? "";
    const meta = asRecord(JSON.parse(first));
    const payload = asRecord(meta?.payload);
    return meta?.type === "session_meta" && typeof payload?.cwd === "string"
      ? payload.cwd
      : undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

/**
 * Without a way to ask which files a process has open — Windows — the newest
 * rollout started in this folder since the terminal opened. Rollouts are filed
 * by day (`sessions/2026/10/17/`), so only today's and yesterday's folders are
 * read. Two Codex windows opened in one folder within the same moment can be
 * mistaken for each other; nothing on disk tells them apart.
 */
async function newestRolloutFor(
  sessions: string,
  cwd: string,
  openedAt: number,
  platform: TerminalPlatform,
): Promise<string | undefined> {
  const days = [new Date(openedAt), new Date(), new Date(openedAt - 86_400_000)].map((day) => {
    const pad = (n: number) => String(n).padStart(2, "0");
    return join(sessions, String(day.getFullYear()), pad(day.getMonth() + 1), pad(day.getDate()));
  });
  let newest: { path: string; mtime: number } | undefined;
  for (const dir of new Set(days)) {
    let names: string[];
    try {
      names = (await readdir(dir)).filter((name) => /^rollout-.+\.jsonl$/.test(name));
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(dir, name);
      try {
        const { mtimeMs, birthtimeMs } = await stat(path);
        // Begun (or, for a resumed one, written) since the terminal opened,
        // with the same slack the GG Coder lookup allows.
        if (Math.max(birthtimeMs, mtimeMs) < openedAt - 2000) continue;
        if (newest && mtimeMs <= newest.mtime) continue;
        const started = await rolloutCwd(path);
        if (started && samePath(started, cwd, platform)) newest = { path, mtime: mtimeMs };
      } catch {
        // Gone between the listing and now.
      }
    }
  }
  return newest?.path;
}

/** Where to look for the terminal's conversation besides its pid. */
export interface CodexLookup {
  cwd: string;
  /** When the terminal opened, in ms. */
  openedAt: number;
  platform?: TerminalPlatform;
}

/**
 * The Codex conversation in one terminal.
 *
 * `pid` is the process the wrapper started, which for an npm-installed Codex
 * is a small launcher whose child is Codex itself — so its children are asked
 * too. Windows cannot be asked which files a process holds, so there it is
 * found by folder and time instead (`newestRolloutFor`).
 */
export function codexSource(
  pid: number,
  home: string = codexHome(),
  lookup?: CodexLookup,
): MirrorSource {
  const sessions = join(home, "sessions");
  const platform = lookup?.platform ?? terminalPlatform();
  return {
    async locate(): Promise<MirrorTarget | undefined> {
      let path: string | undefined;
      if (platform === "win32") {
        if (!lookup) return undefined;
        path = await newestRolloutFor(sessions, lookup.cwd, lookup.openedAt, platform);
      } else {
        const candidates = [pid, ...(await childrenOf(pid))];
        const found: string[] = [];
        for (const candidate of candidates) {
          const open = await openRollout(candidate, platform);
          if (open) found.push(open);
        }
        path = found.sort().at(-1);
      }
      // Only a file under this Codex home: the lookup is by pid, and a pid can
      // be reused by anything once the agent is gone.
      if (!path || !path.startsWith(`${sessions}${sep}`)) return undefined;
      // `rollout-2026-10-17T11-56-05-<uuid>.jsonl`: the uuid is what `codex resume` takes.
      const conversation =
        /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(path)?.[1];
      return { id: basename(path), path, conversation };
    },
    parse: codexMessagesFromLine,
  };
}

async function childrenOf(pid: number): Promise<number[]> {
  try {
    const { stdout } = await run("pgrep", ["-P", String(pid)], { timeout: 5000 });
    return stdout
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((child) => Number.isInteger(child) && child > 0);
  } catch {
    return [];
  }
}

// ── GG Coder ────────────────────────────────────────────────

/** Where GG Coder keeps conversations: `~/.gg/sessions`. */
export function ggcoderSessions(env: NodeJS.ProcessEnv = process.env): string {
  return join(userHome(env), ".gg", "sessions");
}

function ggcoderText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const block = asRecord(part);
      return block?.type === "text" && typeof block.text === "string" ? block.text : "";
    })
    .join("")
    .trim();
}

/**
 * What one line of a GG Coder session adds for the phone.
 *
 * A message GG Coder marks with `provenance.visibility` other than
 * `transcript` is one the person never typed: background-task notices,
 * Autopilot turns, completion gates, compaction summaries. GG Coder hides those
 * in its own window, and so does this — the same rule the app's replay of a
 * GG Coder conversation uses. Thinking, tool results and bookkeeping entries
 * are left out as well.
 */
export function ggcoderMessagesFromLine(line: string): wire.TerminalMessage[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }
  const entry = asRecord(parsed);
  if (entry?.type !== "message") return [];
  const message = asRecord(entry.message);
  const provenance = asRecord(message?.provenance);
  if (provenance?.visibility !== undefined && provenance.visibility !== "transcript") return [];
  if (message?.role === "user") {
    const text = ggcoderText(message.content);
    // Older sessions file a compacted summary without provenance.
    if (!text || text.startsWith("[Previous conversation summary]")) return [];
    return [{ role: "user", text }];
  }
  if (message?.role !== "assistant") return [];
  const messages: wire.TerminalMessage[] = [];
  const text = ggcoderText(message.content);
  if (text && !text.startsWith("I have the full context from the summary above")) {
    messages.push({ role: "agent", text });
  }
  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      const block = asRecord(part);
      if (block?.type === "tool_call" && typeof block.name === "string") {
        messages.push({ role: "tool", text: toolLabel(block.name, block.args) });
      }
    }
  }
  return messages;
}

/**
 * The GG Coder conversation in one terminal: the newest session file in its
 * project's folder that has been written since the terminal opened.
 *
 * GG Coder keeps no record of which process owns which file, and closes the
 * file between writes, so there is nothing more exact to go on. Files older
 * than the terminal are ignored, so an old conversation in the same project is
 * never mistaken for this one; a `/clear` or new session writes a newer file,
 * which is followed — and the phone is told to start over.
 */
/** The session id GG Coder writes on a session file's first line — what `--resume` takes. */
async function ggcoderSessionId(path: string): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(path, "r");
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const first = buffer.subarray(0, bytesRead).toString("utf8").split("\n")[0] ?? "";
    const header = asRecord(JSON.parse(first));
    return header?.type === "session" && typeof header.id === "string" ? header.id : undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

export function ggcoderSource(
  cwd: string,
  openedAt: number,
  sessions: string = ggcoderSessions(),
): MirrorSource {
  const dir = join(sessions, ggcoderProjectDir(cwd));
  return {
    async locate(): Promise<MirrorTarget | undefined> {
      let names: string[];
      try {
        names = (await readdir(dir)).filter((name) => name.endsWith(".jsonl"));
      } catch {
        return undefined;
      }
      let newest: { name: string; mtime: number } | undefined;
      for (const name of names) {
        try {
          const { mtimeMs } = await stat(join(dir, name));
          // A little slack: the clock that stamped the file and this one can
          // disagree by a moment, and a conversation resumed with `continue`
          // writes to its file right away.
          if (mtimeMs < openedAt - 2000) continue;
          if (!newest || mtimeMs > newest.mtime) newest = { name, mtime: mtimeMs };
        } catch {
          // Gone between the listing and now.
        }
      }
      if (!newest) return undefined;
      const path = join(dir, newest.name);
      return { id: newest.name, path, conversation: await ggcoderSessionId(path) };
    },
    parse: ggcoderMessagesFromLine,
  };
}
