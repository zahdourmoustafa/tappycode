/**
 * GG Coder's runs, followed through its own debug log.
 *
 * The screen reader (`ggcoder-screen.ts`) lives in the wrapper, so it only
 * helps terminals started after it shipped: a wrapper keeps the code it was
 * started with. GG Coder also writes `~/.gg/debug.log` as it goes, though, and
 * the daemon can read that for every window at once — including ones opened
 * long before. Each line carries the instance's short id (`sid=…`); its
 * `[startup]` line names the process (`pid=…`), which is exactly the pid the
 * wrapper registered (the agent it spawned). From that this reports, per pid:
 *
 * - a run starting (`[ui] run_start`) and ending (`[agent] Agent done`);
 * - the message that started it (`[input] User input: …`, which GG Coder
 *   truncates to about a hundred characters);
 * - each step as it begins (`[tool] Tool call started: <name>`).
 *
 * What the agent says is not in the log; that comes from the screen in a new
 * window, and from the session file once the run is saved. Nothing here ever
 * writes to GG Coder's files.
 */
import { open, stat } from "node:fs/promises";
import type { wire } from "@tappy/protocol";
import { toolLabel } from "./mirror.js";

/** One run as the log tells it. */
export interface LogRun {
  pid: number;
  activity: "working" | "idle";
  /** Counts runs in this GG Coder instance; a new number is a new run. */
  turn: number;
  messages: wire.TerminalMessage[];
}

interface Instance {
  pid?: number;
  running: boolean;
  turn: number;
  /** The message that started the run, if the log named it. */
  prompt?: string;
  /** Steps by kind, in the order each kind was first used. */
  steps: Map<string, number>;
  /** The kind of step running now. */
  current?: string;
  /** A message typed: the next run is its run. */
  pendingInput?: string;
}

const LINE = /^\[[^\]]*\] \[sid=([0-9a-f]+)\] \[[A-Z]+\] \[([a-z_-]+)\] (.*)$/;
/** Kinds of step kept per run. */
const MAX_KINDS = 20;

/**
 * One line per kind of step: "Run a command", then "Run a command · 12 times",
 * with `…` on the kind running right now. The log names a step's tool but not
 * its arguments, so a hundred commands listed one by one would be a hundred
 * identical lines.
 */
function stepLine(kind: string, count: number, running: boolean): string {
  const times = count > 1 ? ` · ${count} times` : "";
  return `${kind}${times}${running ? "…" : ""}`;
}

/**
 * The state of every GG Coder instance the log has mentioned. Pure: feed it
 * lines, ask it what changed. Kept apart from the file reading so it can be
 * tested line by line.
 */
export class GgcoderLogState {
  private readonly instances = new Map<string, Instance>();

  /** Apply one log line. Returns the sid it changed, if it changed what a phone sees. */
  apply(line: string): string | undefined {
    const match = LINE.exec(line);
    if (!match) return undefined;
    const [, sid, category, message] = match as unknown as [string, string, string, string];
    let instance = this.instances.get(sid);
    if (!instance) {
      instance = { running: false, turn: 0, steps: new Map() };
      this.instances.set(sid, instance);
    }
    if (category === "startup") {
      const pid = /\bpid=(\d+)\b/.exec(message)?.[1];
      if (pid) instance.pid = Number(pid);
      return undefined;
    }
    if (category === "input" && message.startsWith("User input: ")) {
      const text = message
        .slice("User input: ".length)
        .replace(/\.\.\.$/, "…")
        .trim();
      // The run it starts is the next `run_start` — at once, or after the run
      // going now, since GG Coder queues a message typed while it works.
      if (text) instance.pendingInput = text;
      return undefined;
    }
    if (category === "ui" && message.startsWith("run_start")) {
      instance.running = true;
      instance.turn++;
      instance.prompt = instance.pendingInput;
      instance.pendingInput = undefined;
      instance.steps = new Map();
      instance.current = undefined;
      return sid;
    }
    if (category === "tool" && message.startsWith("Tool call started: ")) {
      if (!instance.running) return undefined;
      const name = message.slice("Tool call started: ".length).split(/\s/)[0] ?? "";
      if (!name) return undefined;
      const kind = toolLabel(name, {});
      instance.steps.set(kind, (instance.steps.get(kind) ?? 0) + 1);
      if (instance.steps.size > MAX_KINDS) {
        const oldest = instance.steps.keys().next().value;
        if (oldest !== undefined) instance.steps.delete(oldest);
      }
      instance.current = kind;
      return sid;
    }
    if (category === "agent" && message.startsWith("Agent done")) {
      if (!instance.running) return undefined;
      instance.running = false;
      instance.current = undefined;
      return sid;
    }
    return undefined;
  }

  /** What the log says about one instance now, if it knows its process. */
  run(sid: string): LogRun | undefined {
    const instance = this.instances.get(sid);
    if (!instance?.pid) return undefined;
    const messages: wire.TerminalMessage[] = [];
    if (instance.prompt) messages.push({ role: "user", text: instance.prompt });
    for (const [kind, count] of instance.steps) {
      const running = instance.running && instance.current === kind;
      messages.push({ role: "tool", text: stepLine(kind, count, running) });
    }
    return {
      pid: instance.pid,
      activity: instance.running ? "working" : "idle",
      turn: instance.turn,
      messages,
    };
  }

  /** Every instance whose process is known. */
  runs(): LogRun[] {
    return [...this.instances.keys()]
      .map((sid) => this.run(sid))
      .filter((r): r is LogRun => r !== undefined);
  }
}

/** Bytes read per poll at most; GG Coder logs a few kilobytes a second at its busiest. */
const CHUNK = 4 * 1024 * 1024;

/**
 * Follow `debug.log`: read all of it once (that is where the processes and any
 * run already going are), then only what is appended. A rotated log — GG Coder
 * renames it to `debug.log.1` at about ten megabytes — is noticed by its size
 * shrinking and read again from the start; the rotated file is read once at
 * the beginning too, for instances whose `[startup]` line is in it.
 */
export class GgcoderLog {
  private readonly state = new GgcoderLogState();
  private offset = 0;
  private partial = "";
  private timer?: ReturnType<typeof setInterval>;
  private polling = false;
  private stopped = false;

  constructor(
    private readonly path: string,
    private readonly onRun: (run: LogRun) => void,
    private readonly pollMs = 500,
  ) {}

  async begin(): Promise<void> {
    // The rotated log first: older, and only its process lines matter.
    await this.readWhole(`${this.path}.1`);
    this.offset = 0;
    this.partial = "";
    await this.poll(true);
    if (this.stopped) return;
    for (const run of this.state.runs()) this.onRun(run);
    this.timer = setInterval(() => void this.poll(false), this.pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
  }

  /** The latest the log knows for every process. */
  runs(): LogRun[] {
    return this.state.runs();
  }

  private async readWhole(path: string): Promise<void> {
    let handle;
    try {
      handle = await open(path, "r");
      const { size } = await handle.stat();
      let at = 0;
      let rest = "";
      while (at < size && !this.stopped) {
        const length = Math.min(CHUNK, size - at);
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buffer, 0, length, at);
        if (bytesRead === 0) break;
        at += bytesRead;
        const text = rest + buffer.subarray(0, bytesRead).toString("utf8");
        const lines = text.split("\n");
        rest = lines.pop() ?? "";
        for (const line of lines) this.state.apply(line);
      }
    } catch {
      // No rotated log yet, or unreadable: nothing older to learn.
    } finally {
      await handle?.close();
    }
  }

  /** One poll. `quiet` applies lines without reporting, for the first read. */
  async poll(quiet: boolean): Promise<void> {
    if (this.polling || this.stopped) return;
    this.polling = true;
    let handle;
    try {
      const { size } = await stat(this.path);
      if (size < this.offset) {
        // Rotated: everything in the new file is unread.
        this.offset = 0;
        this.partial = "";
      }
      if (size === this.offset) return;
      handle = await open(this.path, "r");
      const changed = new Set<string>();
      while (this.offset < size && !this.stopped) {
        const length = Math.min(CHUNK, size - this.offset);
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buffer, 0, length, this.offset);
        if (bytesRead === 0) break;
        this.offset += bytesRead;
        const text = this.partial + buffer.subarray(0, bytesRead).toString("utf8");
        const lines = text.split("\n");
        this.partial = lines.pop() ?? "";
        if (this.partial.length > 1024 * 1024) this.partial = "";
        for (const line of lines) {
          const sid = this.state.apply(line);
          if (sid) changed.add(sid);
        }
        if (!quiet) break;
      }
      if (quiet || this.stopped) return;
      for (const sid of changed) {
        const run = this.state.run(sid);
        if (run) this.onRun(run);
      }
    } catch {
      // No log yet (GG Coder never run with logging), or mid-rotation.
    } finally {
      this.polling = false;
      await handle?.close();
    }
  }
}
