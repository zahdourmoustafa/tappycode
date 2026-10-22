/**
 * Which operating system's rules the terminal bridge follows.
 *
 * Everything that differs between macOS, Linux and Windows — how the wrapper
 * reaches the daemon, how a typed `claude` is taken over, how a terminal window
 * is opened — asks this one function, so the Windows and Linux halves can be
 * exercised from a Mac test run. `TAPPY_FAKE_PLATFORM` is the same override the
 * provider resolver honours (`providers/registry.ts`); its `posix` value means
 * "not Windows", which here is Linux, the one POSIX system without the Mac's
 * extras.
 */
import { homedir } from "node:os";

export type TerminalPlatform = "darwin" | "linux" | "win32";

export function terminalPlatform(env: NodeJS.ProcessEnv = process.env): TerminalPlatform {
  const fake = env.TAPPY_FAKE_PLATFORM;
  if (fake === "darwin" || fake === "linux" || fake === "win32") return fake;
  if (fake === "posix") return "linux";
  if (process.platform === "win32" || process.platform === "darwin") return process.platform;
  return "linux";
}

/**
 * The user's home folder, where agents keep their files. On Windows the
 * profile folder, never `HOME`: Git Bash sets a `HOME` of its own, while Claude,
 * Codex and GG Coder all file under the profile.
 */
export function userHome(
  env: NodeJS.ProcessEnv,
  platform: TerminalPlatform = terminalPlatform(env),
): string {
  return platform === "win32" ? homedir() : env.HOME || homedir();
}

/** PATH's separator on that platform — not `path.delimiter`, which is the host's. */
export function pathDelimiter(platform: TerminalPlatform): string {
  return platform === "win32" ? ";" : ":";
}

/**
 * The same folder, as that platform sees it. Windows paths are not case
 * sensitive and take either slash, and PowerShell keeps whatever case was
 * typed at `cd`, so `C:\Repo` from one terminal and `c:/repo\` from another are
 * one project. Everywhere else a path is exactly its bytes.
 */
export function samePath(a: string, b: string, platform: TerminalPlatform): boolean {
  if (platform !== "win32") return a === b;
  const norm = (path: string) => path.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  return norm(a) === norm(b);
}
