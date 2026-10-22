/**
 * A terminal agent's conversation, followed live for the phone.
 *
 * Every agent this drives — Claude Code, Codex, GG Coder — writes its
 * conversation to a JSONL file as it happens. What differs is only where that
 * file is and what one line of it means, so each agent is a small
 * {@link MirrorSource} and this file does the rest once: polling, reading whole
 * lines from where the last read stopped, numbering messages, and telling the
 * phone to start over when the agent moves to another conversation.
 *
 * Polled once a second: a reply lands on the phone within a second of the
 * agent writing it, and there is nothing to set up or tear down per file.
 * Nothing here ever writes to an agent's files.
 */
import { open } from "node:fs/promises";
import { basename } from "node:path";
import { asRecord, type wire } from "@tappy/protocol";

export interface MirrorUpdate {
  start: number;
  reset: boolean;
  messages: wire.TerminalMessage[];
}

/** Where a conversation lives. `id` changing is a new conversation. */
export interface MirrorTarget {
  id: string;
  path: string;
  /** The agent's own id for it — what `--resume` takes — when it can be told. */
  conversation?: string;
  /** What the agent says it is doing right now, when it says. */
  activity?: "working" | "waiting" | "idle";
}

/** What one agent contributes; everything else is shared. */
export interface MirrorSource {
  /** The conversation the terminal is in right now, or undefined if not known yet. */
  locate(): Promise<MirrorTarget | undefined>;
  /**
   * What one line of that conversation adds for the phone. Only what a person
   * would see in the terminal: their messages, the agent's replies, a short
   * label per step. Never the context an agent sends its model.
   */
  parse(line: string): wire.TerminalMessage[];
}

const POLL_MS = 1000;
/** Bytes read per round. A line longer than this is a pasted image, and is skipped. */
const CHUNK = 4 * 1024 * 1024;
/** Rounds per poll, so catching up on a very long conversation never blocks for long. */
const MAX_ROUNDS = 16;
/** Messages held in memory per terminal; older ones fall off the front. */
const KEEP = 1000;
/** What a phone is sent when it connects: enough to scroll back through, never megabytes. */
const SNAPSHOT_MESSAGES = 200;
const SNAPSHOT_BYTES = 1_500_000;

function shorten(text: string, max = 80): string {
  const line = text.split("\n")[0]?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * The step a tool call is, as a short line the way the CLI draws it: "Run npm
 * test", "Edit App.tsx" — what the agent asked to do, which is not always what
 * happened: a step can still be declined or fail, and that follows as its own line.
 *
 * Names are matched without case or separators, so Claude's `Bash`, GG Coder's
 * `bash` and Codex's `exec_command` land on the same wording.
 */
export function toolLabel(name: string, input: unknown): string {
  const args = asRecord(input) ?? {};
  const str = (key: string) => (typeof args[key] === "string" ? (args[key] as string) : "");
  const file = str("file_path") || str("notebook_path") || str("path");
  const command =
    str("command") || str("cmd") || (Array.isArray(args.command) ? args.command.join(" ") : "");
  switch (name.toLowerCase().replace(/[^a-z]/g, "")) {
    case "bash":
    case "shell":
    case "execcommand":
    case "localshell":
      return command ? `Run ${shorten(command)}` : "Run a command";
    case "read":
    case "readfile":
      return file ? `Read ${basename(file)}` : "Read a file";
    case "edit":
    case "multiedit":
    case "notebookedit":
      return file ? `Edit ${basename(file)}` : "Edit a file";
    case "applypatch":
      return "Edit files";
    case "write":
      return file ? `Write ${basename(file)}` : "Write a file";
    case "grep":
    case "glob":
    case "find":
      return str("pattern") ? `Search for ${shorten(str("pattern"), 60)}` : "Search the project";
    case "webfetch":
      return str("url") ? `Open ${shorten(str("url"), 60)}` : "Open a web page";
    case "websearch":
      return str("query") ? `Search the web for ${shorten(str("query"), 60)}` : "Search the web";
    case "todowrite":
    case "updateplan":
      return "Update the plan";
    case "task":
    case "agent":
    case "spawnagent":
      return str("description")
        ? `Start a helper: ${shorten(str("description"), 60)}`
        : "Start a helper";
    default:
      return `Use ${name}`;
  }
}

export class TerminalMirror {
  private target?: MirrorTarget;
  private offset = 0;
  /** A line longer than one read is being skipped to its end. */
  private skipping = false;
  /** Position in the whole conversation of `messages[0]`. */
  private start = 0;
  private messages: wire.TerminalMessage[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private polling = false;
  private stopped = false;

  constructor(
    private readonly source: MirrorSource,
    private readonly onUpdate: (update: MirrorUpdate) => void,
    private readonly pollMs: number = POLL_MS,
    /** Told the agent's own id for its conversation each time that changes. */
    private readonly onConversation: (conversation: string | undefined) => void = () => {},
    /** Told what the agent says it is doing, on every poll that knows. */
    private readonly onActivity: (activity: "working" | "waiting" | "idle") => void = () => {},
  ) {}

  begin(): void {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
  }

  /** What the agent said last, for a notification. */
  lastAgentText(): string | undefined {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const message = this.messages[i];
      if (message?.role === "agent") return message.text;
      if (message?.role === "user") return undefined;
    }
    return undefined;
  }

  /** Everything recent, as a phone that has nothing yet needs it. */
  snapshot(): MirrorUpdate {
    let from = Math.max(0, this.messages.length - SNAPSHOT_MESSAGES);
    let bytes = 0;
    for (let i = this.messages.length - 1; i >= from; i--) {
      bytes += this.messages[i]?.text.length ?? 0;
      if (bytes > SNAPSHOT_BYTES) {
        from = i + 1;
        break;
      }
    }
    return { start: this.start + from, reset: true, messages: this.messages.slice(from) };
  }

  /** One poll. Exposed so tests can step it instead of waiting on a timer. */
  async poll(): Promise<void> {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      const current = await this.source.locate();
      if (!current || this.stopped) return;
      if (current.activity) this.onActivity(current.activity);
      if (current.id !== this.target?.id || current.path !== this.target.path) {
        this.target = current;
        this.onConversation(current.conversation);
        this.offset = 0;
        this.skipping = false;
        this.start = 0;
        this.messages = [];
        this.append(await this.readNew());
        if (!this.stopped) this.onUpdate(this.snapshot());
        return;
      }
      const end = this.start + this.messages.length;
      const added = await this.readNew();
      if (added.length === 0 || this.stopped) return;
      this.append(added);
      this.onUpdate({ start: end, reset: false, messages: added });
    } catch {
      // A file mid-rename, or the agent gone: the next poll looks again.
    } finally {
      this.polling = false;
    }
  }

  private append(added: wire.TerminalMessage[]): void {
    this.messages.push(...added);
    const drop = this.messages.length - KEEP;
    if (drop > 0) {
      this.messages.splice(0, drop);
      this.start += drop;
    }
  }

  private async readNew(): Promise<wire.TerminalMessage[]> {
    const target = this.target;
    if (!target) return [];
    let handle;
    try {
      handle = await open(target.path, "r");
    } catch {
      // An agent writes the file with the first message, not at startup.
      return [];
    }
    const added: wire.TerminalMessage[] = [];
    try {
      const { size } = await handle.stat();
      if (size < this.offset) {
        // Rewritten in place: forget it, and the next poll starts over cleanly.
        this.target = undefined;
        return [];
      }
      for (let round = 0; round < MAX_ROUNDS && this.offset < size; round++) {
        const length = Math.min(size - this.offset, CHUNK);
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buffer, 0, length, this.offset);
        if (bytesRead === 0) break;
        const chunk = buffer.subarray(0, bytesRead);
        let consumed = 0;
        if (this.skipping) {
          const newline = chunk.indexOf(10);
          if (newline === -1) {
            this.offset += bytesRead;
            continue;
          }
          consumed = newline + 1;
          this.skipping = false;
        }
        const last = chunk.lastIndexOf(10);
        if (last < consumed) {
          if (consumed > 0) {
            this.offset += consumed;
            continue;
          }
          if (bytesRead === CHUNK) {
            // One line bigger than a whole read: an inline picture. Skipped.
            this.offset += bytesRead;
            this.skipping = true;
            continue;
          }
          break; // The last line is still being written.
        }
        // Newlines are single bytes that never occur inside a multi-byte
        // character, so cutting at one never splits a character.
        const text = chunk.subarray(consumed, last).toString("utf8");
        this.offset += last + 1;
        for (const line of text.split("\n")) {
          if (!line) continue;
          try {
            added.push(...this.source.parse(line));
          } catch {
            // One malformed line costs that line, never the conversation.
          }
        }
      }
    } finally {
      await handle.close();
    }
    return added;
  }
}
