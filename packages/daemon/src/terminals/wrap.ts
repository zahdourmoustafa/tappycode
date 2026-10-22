/**
 * `tappy wrap <agent> [args…]` — what `claude`, `codex` and `ggcoder` run once
 * the shell hook is installed. Never typed by a person.
 *
 * It runs the real agent inside a PTY it owns and passes the user's terminal
 * through byte for byte — keyboard in, screen out, resizes, exit code — so the
 * agent looks and behaves exactly as it does unwrapped. Beside that, it keeps a
 * connection to the daemon's local socket and writes whatever the phone types
 * into the same PTY.
 *
 * The rule above everything else: this must never stop someone's agent from
 * running. No terminal (a pipe, a script), or already inside a wrapper, means a
 * plain passthrough. No daemon means the agent runs normally and the phone just
 * cannot see it; the link keeps retrying, so a daemon started later still finds
 * it.
 *
 * The same on Windows, where Bun's PTY is a ConPTY: the platform differences
 * are which PATH entries count as the agent, how a `.cmd` agent is started,
 * and that a closing window cannot be passed on as SIGHUP.
 */
import {
  accessSync,
  constants as fs,
  openSync,
  readSync,
  closeSync,
  realpathSync,
  statSync,
} from "node:fs";
import { createConnection, type Socket } from "node:net";
import { constants } from "node:os";
import { join } from "node:path";
import { wire } from "@tappy/protocol";
import { launchSpec } from "../acp/launch.js";
import { pathDelimiter, type TerminalPlatform, terminalPlatform } from "./platform.js";
import { detectTerminalApp } from "./terminal-app.js";
import { ggcoderScreenWatcher } from "./ggcoder-screen.js";
import {
  type ClaudeMode,
  DaemonLine,
  parseLine,
  type ScreenPrompt,
  type ScreenQuestion,
  takeLines,
  terminalSocketPath,
} from "./link.js";
import { SHIM_MARKER, shimDir } from "./shell-hook.js";

/** How long to wait before trying the daemon's socket again. */
const RELINK_MS = 3000;

/** Set in the agent's environment, so a nested `claude` is not wrapped twice. */
const WRAPPED_ENV = "TAPPY_WRAPPED";

function exitCodeOf(proc: { exitCode: number | null; signalCode: string | null }): number {
  if (proc.exitCode !== null) return proc.exitCode;
  const signal = proc.signalCode as keyof typeof constants.signals | null;
  return signal && constants.signals[signal] ? 128 + constants.signals[signal] : 1;
}

/** What to start: the agent's argv, and whether it is a Windows command line built by hand. */
interface AgentCommand {
  argv: string[];
  windowsVerbatimArguments?: boolean;
}

/** Run the agent attached straight to this terminal, as if never wrapped. */
async function runPlain(command: AgentCommand, env: NodeJS.ProcessEnv): Promise<number> {
  const proc = Bun.spawn(command.argv, {
    stdio: ["inherit", "inherit", "inherit"],
    env,
    windowsVerbatimArguments: command.windowsVerbatimArguments,
  });
  // The agent shares this process group, so a Ctrl-C reaches it directly. The
  // wrapper outliving it is what lets its exit code come back to the shell.
  const ignore = () => {};
  process.on("SIGINT", ignore);
  await proc.exited;
  process.off("SIGINT", ignore);
  return exitCodeOf(proc);
}

export interface Link {
  /** Tell the daemon what the agent's screen shows now; re-sent after a reconnect. */
  status(update: {
    mode?: ClaudeMode;
    prompt?: ScreenPrompt | null;
    question?: ScreenQuestion | null;
    activity?: "working" | "idle";
    live?: { turn: number; messages: wire.TerminalMessage[] };
  }): void;
  close(): void;
}

/** Escape sequences, so what is left is the text a person sees. */
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/** Claude's status line, as Claude Code 2.1 draws it, to its config value. */
const CLAUDE_MODES: Array<[RegExp, ClaudeMode]> = [
  [/auto mode on/g, "auto"],
  [/manual mode on/g, "default"],
  [/accept edits on/g, "acceptEdits"],
  [/plan mode on/g, "plan"],
];

/**
 * The numbered question last drawn on Claude's screen — "Do you want to create
 * hello.txt?" with "1. Yes", "2. …", "3. No" under it — and where it starts in
 * `text`, or undefined when the last question drawn is not a numbered one.
 *
 * Read from text with its escapes already blanked out, where Claude's lines are
 * separated by carriage returns. Only the newest question counts: an older one
 * further up has been answered. The markers it is known by were read off a real
 * Claude Code 2.1 permission prompt (see the fixture in the tests).
 */
/** Words drawn with cursor moves between them come out with a space before punctuation. */
function tidy(text: string): string {
  return text.replace(/\s+([?!.,:;])/g, "$1");
}

export function parseClaudeQuestion(
  text: string,
): { question: ScreenQuestion; at: number } | undefined {
  const lines = [...text.matchAll(/[^\r\n]+/g)]
    .map((match) => ({ text: match[0].replace(/\s+/g, " ").trim(), at: match.index }))
    .filter((line) => line.text.length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line?.text.endsWith("?")) continue;
    const options: ScreenQuestion["options"] = [];
    for (let j = i + 1; j < lines.length && j <= i + 16; j++) {
      const row = lines[j]?.text ?? "";
      if (/^Esc to cancel/.test(row)) break;
      const option = /^(?:❯\s*)?([1-9])\.\s+(.+)$/.exec(row);
      if (!option?.[1] || !option[2]) continue;
      // In order, and once each: a redraw caught half-way can repeat a row.
      if (Number(option[1]) !== options.length + 1) break;
      options.push({ key: option[1], label: tidy(option[2]).slice(0, 200) });
    }
    if (options.length < 2) return undefined;
    return {
      question: { text: tidy(line.text).slice(-400), options: options.slice(0, 9) },
      at: line.at,
    };
  }
  return undefined;
}

/** Claude asking whether to trust a folder it has not opened before. */
const CLAUDE_TRUST = /Yes, I trust this folder/g;

/**
 * What Claude's own screen shows, read as it goes past: its permission mode,
 * and whether it is stopped on a question no file records.
 *
 * Claude writes neither anywhere a file reader can see, but it draws both: the
 * status line every time the mode changes ("plan mode on"), and the trust
 * question before anything else in a new folder. The screen arrives in pieces
 * that can end mid-word or mid-escape, so a short tail of text is kept and the
 * last thing drawn wins — a status line after the question means it was
 * answered.
 */
export function claudeScreenWatcher(
  onMode: (mode: ClaudeMode) => void,
  onPrompt: (prompt: ScreenPrompt | null) => void,
  onQuestion: (question: ScreenQuestion | null) => void = () => {},
): (data: Uint8Array) => void {
  const decoder = new TextDecoder();
  let tail = "";
  let mode: ClaudeMode | undefined;
  let prompt: ScreenPrompt | null = null;
  let question = "null";
  return (data) => {
    tail = `${tail}${decoder.decode(data, { stream: true })}`.slice(-8192);
    const text = tail.replace(ANSI, " ");
    let latest: { at: number; mode: ClaudeMode } | undefined;
    for (const [pattern, value] of CLAUDE_MODES) {
      for (const match of text.matchAll(pattern)) {
        if (!latest || match.index > latest.at) latest = { at: match.index, mode: value };
      }
    }
    let trustAt = -1;
    for (const match of text.matchAll(CLAUDE_TRUST)) trustAt = Math.max(trustAt, match.index);
    if (latest && latest.mode !== mode) {
      mode = latest.mode;
      onMode(latest.mode);
    }
    const asking: ScreenPrompt | null =
      trustAt > (latest?.at ?? -1) ? "trust" : prompt && latest ? null : prompt;
    if (asking !== prompt) {
      prompt = asking;
      onPrompt(asking);
    }
    // A numbered question is over once the normal screen, with its status
    // line, has been drawn after it.
    const found = parseClaudeQuestion(text);
    const current = found && !(latest && latest.at > found.at) ? found.question : null;
    const key = JSON.stringify(current);
    if (key !== question) {
      question = key;
      onQuestion(current);
    }
  };
}

/** Claude's permission mode alone, read off its screen. See `claudeScreenWatcher`. */
export function claudeModeWatcher(onMode: (mode: ClaudeMode) => void): (data: Uint8Array) => void {
  return claudeScreenWatcher(onMode, () => {});
}

/**
 * Stay registered with the daemon for as long as the agent runs, reconnecting
 * after a daemon restart. `onInput` receives the phone's keystrokes.
 */
export function keepLinked(
  agent: wire.TerminalAgent,
  cwd: string,
  onInput: (data: string) => void,
  pid?: number,
  path: string = terminalSocketPath(),
): Link {
  let closed = false;
  // Sent with every registration, so a daemon that restarts still knows this
  // window is as old as it is.
  const since = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** The connection, once it is up; writes before then would go ahead of `register`. */
  let socket: Socket | undefined;
  let connecting: Socket | undefined;
  let last: Parameters<Link["status"]>[0] = {};
  const statusLine = () => `${JSON.stringify({ t: "status", ...last })}\n`;
  // The app this terminal belongs to: where an agent started from the phone
  // should open next time.
  const app = detectTerminalApp(process.env, terminalPlatform());

  const retry = () => {
    socket = undefined;
    connecting = undefined;
    if (closed || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      connect();
    }, RELINK_MS);
    timer.unref?.();
  };

  // `node:net`, which reaches a Windows named pipe as well as a Unix socket.
  const connect = () => {
    if (closed) return;
    const decoder = new TextDecoder();
    let buffer = "";
    let over = false;
    const s = createConnection(path);
    connecting = s;
    const lost = () => {
      if (over) return;
      over = true;
      if (connecting === s || socket === s) retry();
    };
    s.on("connect", () => {
      if (closed) {
        s.end();
        return;
      }
      socket = s;
      connecting = undefined;
      s.write(`${JSON.stringify({ t: "register", agent, cwd, pid, app, since })}\n`);
      // A daemon that restarted knows nothing of the screen; tell it again.
      if (Object.keys(last).length > 0) s.write(statusLine());
    });
    s.on("data", (chunk: Buffer) => {
      const taken = takeLines(buffer, decoder.decode(chunk, { stream: true }));
      if (!taken) {
        s.end();
        return;
      }
      buffer = taken.rest;
      for (const line of taken.lines) {
        const message = parseLine(DaemonLine, line);
        if (message?.t === "input" && !closed) onInput(message.data);
      }
    });
    // No daemon yet, or it went away: `close` follows and retries.
    s.on("error", () => {});
    s.on("close", lost);
  };

  connect();
  return {
    status(update) {
      last = { ...last, ...update };
      socket?.write(statusLine());
    },
    close() {
      closed = true;
      clearTimeout(timer);
      socket?.end();
      connecting?.destroy();
    },
  };
}

/** Run the agent in a PTY this process owns, proxied to the real terminal. */
async function runInPty(
  agent: wire.TerminalAgent,
  command: AgentCommand,
  env: NodeJS.ProcessEnv,
  platform: TerminalPlatform,
): Promise<number> {
  let exited = false;
  let eof: () => void = () => {};
  const drained = new Promise<void>((resolve) => (eof = resolve));

  // Set once the link exists; until then the screen is only passed through.
  let watchScreen: ((data: Uint8Array) => void) | undefined;
  const proc = Bun.spawn(command.argv, {
    env,
    windowsVerbatimArguments: command.windowsVerbatimArguments,
    terminal: {
      cols: process.stdout.columns || 80,
      rows: process.stdout.rows || 24,
      data: (_terminal, data) => {
        process.stdout.write(data);
        watchScreen?.(data);
      },
      exit: () => eof(),
    },
  });
  const terminal = proc.terminal;
  if (!terminal) {
    // Cannot happen with the `terminal` option (a ConPTY on Windows); if it
    // ever does, the agent is already running headless, so wait it out.
    await proc.exited;
    return exitCodeOf(proc);
  }

  const forward = (data: Buffer) => {
    if (!exited) terminal.write(data);
  };
  const resize = () => terminal.resize(process.stdout.columns || 80, process.stdout.rows || 24);
  // A terminal window closing hangs up on us; the agent must go with it rather
  // than run on, orphaned and unreachable. Windows has no SIGHUP to pass on —
  // closing the console is reported as one, and the agent is ended outright.
  const hangUp = () => proc.kill(platform === "win32" ? undefined : "SIGHUP");
  const terminate = () => proc.kill("SIGTERM");
  // In raw mode Ctrl-C arrives as a byte and goes to the agent; a SIGINT sent
  // to this process directly must not kill the wrapper out from under it.
  const ignore = () => {};

  process.stdin.setRawMode(true);
  process.stdin.on("data", forward);
  process.stdin.resume();
  process.stdout.on("resize", resize);
  process.on("SIGHUP", hangUp);
  process.on("SIGTERM", terminate);
  process.on("SIGINT", ignore);

  const link = keepLinked(
    agent,
    reportedCwd(platform),
    (data) => {
      if (!exited) terminal.write(data);
    },
    proc.pid,
  );
  // Only Claude draws a mode the phone can act on.
  if (agent === "claude") {
    watchScreen = claudeScreenWatcher(
      (mode) => link.status({ mode }),
      (prompt) => link.status({ prompt }),
      (question) => link.status({ question }),
    );
  }
  // GG Coder saves a turn only when it ends; until then its screen is the only
  // place the phone can see it working.
  if (agent === "ggcoder") {
    const watcher = ggcoderScreenWatcher(
      ({ activity, turn, items }) => link.status({ activity, live: { turn, messages: items } }),
      { rows: () => process.stdout.rows || 24 },
    );
    watchScreen = watcher.feed;
  }

  await proc.exited;
  exited = true;
  link.close();
  // The last of the agent's output can still be in the PTY when it exits.
  await Promise.race([drained, Bun.sleep(250)]);

  process.stdin.off("data", forward);
  process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdout.off("resize", resize);
  process.off("SIGHUP", hangUp);
  process.off("SIGTERM", terminate);
  process.off("SIGINT", ignore);
  terminal.close();
  return exitCodeOf(proc);
}

/** The first few hundred bytes of a file, or "" if it cannot be read. */
function head(path: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(512);
    return buffer.toString("utf8", 0, readSync(fd, buffer, 0, buffer.length, 0));
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function realDir(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

/**
 * The folder the agent runs in, as the phone should know it. On Windows the
 * real spelling: PowerShell keeps whatever case was typed at `cd`, and the
 * project list holds the folder as it is on disk.
 */
function reportedCwd(platform: TerminalPlatform): string {
  const cwd = process.cwd();
  if (platform !== "win32") return cwd;
  try {
    return realpathSync.native(cwd);
  } catch {
    return cwd;
  }
}

/**
 * The files in `dir` that would run as `agent`, in the order the shell tries
 * them. On Windows only names with a PATHEXT suffix run — npm's extensionless
 * `claude` beside `claude.cmd` is a Git Bash script, not a program.
 */
function candidatesIn(
  dir: string,
  agent: string,
  env: NodeJS.ProcessEnv,
  platform: TerminalPlatform,
): string[] {
  if (platform !== "win32") return [join(dir, agent)];
  const exts = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((ext) => ext.trim().toLowerCase())
    .filter(Boolean);
  return exts.map((ext) => join(dir, `${agent}${ext}`));
}

function runnable(path: string, platform: TerminalPlatform): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    // Windows has no execute bit; the suffix is what makes it a program.
    if (platform !== "win32") accessSync(path, fs.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The agent itself: the first executable of that name on PATH that is not a
 * launcher of ours, and not another tool's launcher sitting in front of it.
 *
 * Both of those resolve back to `tappy wrap` — ours directly, cmux's through its
 * own wrapper and then ours — so running either would loop until something gave
 * up. Skipped by what they are rather than where PATH happens to put them.
 */
export function findRealAgent(
  agent: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: TerminalPlatform = terminalPlatform(env),
): string | undefined {
  const windows = platform === "win32";
  const key = (dir: string) =>
    windows
      ? realDir(dir)
          .replace(/[\\/]+$/, "")
          .toLowerCase()
      : realDir(dir);
  const ours = key(shimDir(env, platform));
  for (const entry of (env.PATH ?? "").split(pathDelimiter(platform))) {
    // Windows PATH entries are often quoted when they hold a space.
    const dir = windows ? entry.trim().replace(/^"(.*)"$/, "$1") : entry;
    if (!dir || key(dir) === ours) continue;
    // cmux's per-terminal `claude` shims, which re-enter cmux's wrapper.
    if (/[\\/]cmux-cli-shims([\\/]|$)/.test(dir)) continue;
    for (const candidate of candidatesIn(dir, agent, env, platform)) {
      if (!runnable(candidate, platform)) continue;
      if (head(candidate).includes(SHIM_MARKER)) continue;
      return candidate;
    }
  }
  return undefined;
}

export async function runWrap(args: string[]): Promise<number> {
  const [name, ...rest] = args;
  const agent = wire.TerminalAgent.safeParse(name);
  if (!agent.success) {
    console.error(`tappy wrap: '${name ?? ""}' is not an agent tappy can wrap.`);
    return 2;
  }
  // The launcher that called us is first on PATH under this very name, so a
  // plain PATH lookup would find it again. See `findRealAgent`.
  const bin = findRealAgent(agent.data);
  if (!bin) {
    console.error(`${agent.data}: command not found`);
    return 127;
  }
  const platform = terminalPlatform();
  const nested = process.env[WRAPPED_ENV] === "1";
  const env = { ...process.env, [WRAPPED_ENV]: "1" };
  // An npm-installed agent is a `.cmd` on Windows, which has to be started
  // through cmd.exe with its line escaped; `launchSpec` is that, shared with
  // the providers. Elsewhere it is run as found.
  const spec = platform === "win32" ? launchSpec(bin, rest, env) : { command: bin, args: rest };
  const command: AgentCommand = {
    argv: [spec.command, ...spec.args],
    windowsVerbatimArguments:
      "windowsVerbatimArguments" in spec ? spec.windowsVerbatimArguments : undefined,
  };
  if (nested || !process.stdin.isTTY || !process.stdout.isTTY) return runPlain(command, env);
  return runInPty(agent.data, command, env, platform);
}
