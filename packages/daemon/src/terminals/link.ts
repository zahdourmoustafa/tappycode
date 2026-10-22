/**
 * The local conversation between `tappy wrap` and the daemon.
 *
 * Newline-delimited JSON over a Unix socket in `~/.tappy` — a named pipe on
 * Windows. Both ends parse with these schemas, so a malformed or oversized line
 * is refused rather than trusted, whichever side sent it.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { wire } from "@tappy/protocol";
import { type TerminalPlatform, terminalPlatform } from "./platform.js";

const PIPE_NAME = /^\\\\\.\\pipe\\tappy-terminals-[0-9a-f]{32}$/;

/**
 * Where the wrapper finds the daemon: `~/.tappy/terminals.sock`, or under
 * `$TAPPY_HOME`.
 *
 * On Windows, a named pipe instead. Pipes live in one namespace for the whole
 * machine, so a fixed name could be taken first by another account, which would
 * then receive every wrapper's registration and type into its agents. The name
 * carries 128 random bits kept in `~/.tappy/terminals.pipe`, inside a profile
 * only this user can read; whichever side needs it first writes it.
 */
export function terminalSocketPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: TerminalPlatform = terminalPlatform(env),
): string {
  const home = env.TAPPY_HOME ?? join(homedir(), ".tappy");
  if (platform !== "win32") return join(home, "terminals.sock");
  const file = join(home, "terminals.pipe");
  const read = () => {
    try {
      const name = readFileSync(file, "utf8").trim();
      return PIPE_NAME.test(name) ? name : undefined;
    } catch {
      return undefined;
    }
  };
  const existing = read();
  if (existing) return existing;
  const name = `\\\\.\\pipe\\tappy-terminals-${randomBytes(16).toString("hex")}`;
  mkdirSync(home, { recursive: true, mode: 0o700 });
  try {
    // `wx`: if the daemon and a wrapper both start at once, the first name
    // written is the one both use.
    writeFileSync(file, `${name}\n`, { flag: "wx", mode: 0o600 });
    return name;
  } catch {
    // Written by the other side meanwhile — or unreadable junk, which is
    // replaced rather than leaving terminals unreachable for ever.
    const raced = read();
    if (raced) return raced;
    writeFileSync(file, `${name}\n`, { mode: 0o600 });
    return name;
  }
}

/** True for a Windows named pipe, which has no file to chmod or remove. */
export function isPipePath(path: string): boolean {
  return path.startsWith("\\\\.\\pipe\\");
}

/**
 * Longest line either side accepts. A register line is a few hundred bytes and
 * an input line is capped by the wire at 4096 characters, so anything past this
 * is a broken or hostile peer and the connection is dropped.
 */
export const MAX_LINE_BYTES = 64 * 1024;

/** Wrapper -> daemon. Sent once, first, on every connection. */
export const RegisterLine = z.object({
  t: z.literal("register"),
  agent: wire.TerminalAgent,
  cwd: z.string().min(1).max(4096),
  /**
   * The agent's own process id. How Claude's conversation is found for the
   * phone (`claude-mirror.ts`); absent from a wrapper too old to send it.
   */
  pid: z.number().int().positive().optional(),
  /**
   * The terminal app it runs in: a macOS bundle id (`com.cmuxterm.app`), or on
   * Linux and Windows one of `terminal-app.ts`'s names (`windows-terminal`).
   * Remembered so an agent started from the phone opens where this person
   * works; absent when it can't be told, or from an older wrapper.
   */
  app: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9.-]{0,199}$/)
    .optional(),
  /**
   * When the wrapper started, in ms. A daemon restart has every running wrapper
   * register again at once, so the time of registering says nothing about
   * which window is newest — or which conversation files are this agent's.
   */
  since: z.number().int().positive().optional(),
});

/**
 * Claude's permission modes, as Claude's own config values, in the order its
 * Shift+Tab cycles through them (verified against Claude Code 2.1).
 */
export const CLAUDE_MODE_CYCLE = ["auto", "default", "acceptEdits", "plan"] as const;
export const ClaudeMode = z.enum(CLAUDE_MODE_CYCLE);
export type ClaudeMode = z.output<typeof ClaudeMode>;

/** A question on the agent's screen the phone can answer (see `wire.TerminalInfo.prompt`). */
export const ScreenPrompt = z.enum(["trust"]);
export type ScreenPrompt = z.output<typeof ScreenPrompt>;

/** A numbered question on the agent's screen: what it asks, and what typing each number answers. */
export const ScreenQuestion = z.object({
  text: z.string().min(1).max(400),
  options: z
    .array(z.object({ key: z.string().regex(/^[1-9]$/), label: z.string().min(1).max(200) }))
    .min(2)
    .max(9),
});
export type ScreenQuestion = z.output<typeof ScreenQuestion>;

/** Wrapper -> daemon, any time after `register`: what the agent's screen shows now. */
export const StatusLine = z.object({
  t: z.literal("status"),
  mode: ClaudeMode.optional(),
  /** The question it is waiting on; null once it has been answered. */
  prompt: ScreenPrompt.nullable().optional(),
  /** A numbered question it is waiting on; null once it has gone. */
  question: ScreenQuestion.nullable().optional(),
  /** Whether a run is in progress, for an agent whose file cannot tell. */
  activity: z.enum(["working", "idle"]).optional(),
  /** The run on screen, for an agent whose file lags behind it (`ggcoder-screen.ts`). */
  live: z
    .object({
      turn: z.number().int().nonnegative(),
      messages: z.array(wire.TerminalMessage).max(60),
    })
    .optional(),
});

/** Daemon -> wrapper. */
export const DaemonLine = z.discriminatedUnion("t", [
  z.object({ t: z.literal("registered"), id: z.string().min(1) }),
  z.object({ t: z.literal("input"), data: z.string().min(1).max(wire.MAX_TERMINAL_INPUT) }),
]);

export type RegisterLine = z.output<typeof RegisterLine>;
export type DaemonLine = z.output<typeof DaemonLine>;

/**
 * Split a byte stream into complete lines, keeping the unfinished tail.
 *
 * Returns undefined when the tail has grown past {@link MAX_LINE_BYTES} without
 * a newline: the caller closes the connection rather than buffer without bound.
 */
export function takeLines(
  buffer: string,
  chunk: string,
): { lines: string[]; rest: string } | undefined {
  const joined = buffer + chunk;
  const parts = joined.split("\n");
  const rest = parts.pop() ?? "";
  if (Buffer.byteLength(rest) > MAX_LINE_BYTES) return undefined;
  return { lines: parts.filter((line) => line.length > 0), rest };
}

/** Parse one line against a schema; undefined for bad JSON or a bad shape. */
export function parseLine<T>(schema: z.ZodType<T>, line: string): T | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  const result = schema.safeParse(value);
  return result.success ? result.data : undefined;
}
