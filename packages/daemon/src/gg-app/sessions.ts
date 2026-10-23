/**
 * GG Coder's stored conversations, read straight from `~/.gg/sessions`.
 *
 * The desktop app and the CLI write the same files, so this is how the phone
 * lists — and reopens — chats the user had in the app. The app's own API has no
 * listing, and its session ids last only as long as the app process does; the
 * conversation id in each file's header is the one identity that survives.
 *
 * Layout: one directory per project, one `.jsonl` per checkpoint. A long
 * conversation is several checkpoints sharing a `conversationId`; it is listed
 * once, as its newest file. Line one is the header, the rest are entries.
 */
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface StoredConversation {
  /** The conversation id: stable across checkpoints and app restarts. */
  sessionId: string;
  cwd: string;
  title: string | null;
  updatedAt: string;
  /** The newest checkpoint file — what the app reopens. */
  path: string;
}

export function ggSessionsRoot(home: string = homedir()): string {
  return join(home, ".gg", "sessions");
}

/** Enough to find the first user message without reading a whole transcript. */
const HEAD_BYTES = 256 * 1024;
const TITLE_LENGTH = 80;

async function readHead(file: string): Promise<string> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block && typeof block === "object" && (block as { type?: unknown }).type === "text"
        ? ((text) => (typeof text === "string" ? text : ""))((block as { text?: unknown }).text)
        : "",
    )
    .join(" ");
}

interface Parsed {
  id: string;
  conversationId: string;
  cwd: string;
  title: string | null;
  hasMessages: boolean;
}

/** Header plus the first real user message. Undefined for anything that is not a session. */
export function parseHead(head: string): Parsed | undefined {
  const lines = head.split("\n");
  let header: { type?: unknown; id?: unknown; conversationId?: unknown; cwd?: unknown };
  try {
    header = JSON.parse(lines[0] ?? "");
  } catch {
    return undefined;
  }
  if (
    header.type !== "session" ||
    typeof header.id !== "string" ||
    typeof header.cwd !== "string"
  ) {
    return undefined;
  }
  let title: string | null = null;
  let hasMessages = false;
  // The last line may be cut mid-entry by HEAD_BYTES; JSON.parse rejects it.
  for (const line of lines.slice(1)) {
    if (!line.includes('"type":"message"')) continue;
    let entry: { message?: { role?: unknown; content?: unknown }; provenance?: unknown };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const role = entry.message?.role;
    if (role !== "user" && role !== "assistant") continue;
    hasMessages = true;
    if (role === "user" && title === null && !entry.provenance) {
      const flat = textOf(entry.message?.content).replace(/\s+/g, " ").trim();
      if (flat && !flat.startsWith("[Previous conversation summary]")) {
        title = flat.length > TITLE_LENGTH ? `${flat.slice(0, TITLE_LENGTH - 1)}…` : flat;
      }
    }
    if (title !== null) break;
  }
  return {
    id: header.id,
    conversationId: typeof header.conversationId === "string" ? header.conversationId : header.id,
    cwd: header.cwd,
    title,
    hasMessages,
  };
}

/** Every conversation with at least one message, newest first. */
export async function listConversations(
  root: string = ggSessionsRoot(),
): Promise<StoredConversation[]> {
  let projects: string[];
  try {
    projects = await readdir(root);
  } catch {
    return [];
  }
  const newest = new Map<string, StoredConversation & { mtime: number; hasMessages: boolean }>();
  // A title can live in an older checkpoint when the newest one starts with a
  // compaction summary, so titles are gathered per conversation separately.
  const titles = new Map<string, string>();
  for (const project of projects.sort()) {
    let files: string[];
    try {
      files = await readdir(join(root, project));
    } catch {
      continue;
    }
    for (const name of files.filter((entry) => entry.endsWith(".jsonl")).sort()) {
      const file = join(root, project, name);
      let parsed: Parsed | undefined;
      let mtime: number;
      try {
        const info = await stat(file);
        // A `.jsonl` this small beside a `.jsonl.gz` is an archive redirect.
        if (info.size < 64) continue;
        mtime = info.mtimeMs;
        parsed = parseHead(await readHead(file));
      } catch {
        continue;
      }
      if (!parsed) continue;
      if (parsed.title && !titles.has(parsed.conversationId))
        titles.set(parsed.conversationId, parsed.title);
      const current = newest.get(parsed.conversationId);
      if (current && current.mtime >= mtime) {
        if (parsed.hasMessages) current.hasMessages = true;
        continue;
      }
      newest.set(parsed.conversationId, {
        sessionId: parsed.conversationId,
        cwd: parsed.cwd,
        title: null,
        updatedAt: new Date(mtime).toISOString(),
        path: file,
        mtime,
        hasMessages: parsed.hasMessages || current?.hasMessages === true,
      });
    }
  }
  return [...newest.values()]
    .filter((entry) => entry.hasMessages)
    .sort((a, b) => b.mtime - a.mtime || a.sessionId.localeCompare(b.sessionId))
    .map(({ mtime: _mtime, hasMessages: _has, ...entry }) => ({
      ...entry,
      title: titles.get(entry.sessionId) ?? null,
    }));
}
