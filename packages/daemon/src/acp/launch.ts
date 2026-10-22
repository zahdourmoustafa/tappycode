/**
 * Turning a manifest's command into something `spawn` can run, including the
 * Windows batch-shim path through `cmd.exe`. Moved out of `connect.ts`
 * unchanged; `launchSpec` is re-exported from there.
 */
import { findOnPath } from "../providers/registry.js";

/**
 * Characters cmd.exe treats as syntax rather than text — including the space,
 * which is why a path can be escaped instead of quoted.
 *
 * Taken from cross-spawn, which is the de-facto implementation of this problem
 * and has had a decade of Windows bug reports filed against it.
 */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/**
 * One argument, as the target program's C runtime will parse it back.
 *
 * Two layers, and they are not the same layer. First MSVCRT quoting, which is
 * what the receiving program applies: a backslash is literal *except* directly
 * before a quote, so those runs are doubled and the quote escaped. Then cmd's
 * own layer on top, since with `windowsVerbatimArguments` this text reaches
 * cmd.exe unaltered — including the quotes we just added, which have to be
 * `^`-escaped or cmd eats them as delimiters.
 */
function escapeArgument(arg: string): string {
  const quoted = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;
  return quoted.replace(CMD_META, "^$1");
}

/**
 * How to actually launch what `findOnPath` found.
 *
 * On POSIX, unchanged: the command is spawned as given.
 *
 * On Windows, two things are true that are not true anywhere else. The command
 * has to be resolved to a real file first — libuv only ever appends `.com` and
 * `.exe`, so a bare `npx` never finds the `npx.cmd` that npm actually installed.
 * And since CVE-2024-27980 (Node 18.20.2 / 20.12.2 / 21.7.3) spawning a `.cmd`
 * or `.bat` without a shell is refused outright with EINVAL, because argument
 * quoting for those is a command-injection surface.
 *
 * So a batch shim goes through `cmd.exe` explicitly — never `shell: true`, which
 * hands an unescaped line to a parser and is the vulnerability itself.
 *
 * The escaping is not optional decoration. Passing the parts as ordinary argv
 * entries looks right and is wrong: Node quotes them MSVCRT-style, then `/s`
 * strips the *first and last* quote of everything after `/c` — which unquotes
 * the program path. `C:\Program Files\nodejs\npx.cmd`, the default location of
 * the launcher five bundled providers run through, would split at the space and
 * fail with a syntax error nobody could act on. So the line is built here,
 * escaped for both parsers, and handed over verbatim — the same shape npm,
 * nodemon and cross-spawn all settled on.
 */
export function launchSpec(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[]; windowsVerbatimArguments?: boolean } {
  // Same override the resolver honours, so the Windows path is reachable from a
  // Linux CI run — the only reason this behaviour is testable at all.
  const windows = env.TAPPY_FAKE_PLATFORM
    ? env.TAPPY_FAKE_PLATFORM === "win32"
    : process.platform === "win32";
  if (!windows) return { command, args };

  // Falls back to the bare name so the spawn still happens and still produces a
  // real ENOENT: refusing here would report "not installed" for a command the
  // user may have added to PATH since the registry last looked.
  const resolved = findOnPath(command, env) ?? command;
  const lower = resolved.toLowerCase();
  if (!lower.endsWith(".cmd") && !lower.endsWith(".bat")) {
    return { command: resolved, args };
  }

  // The program is `^`-escaped rather than quoted, so a space in the path is
  // literal without opening a quote that `/s` would later strip.
  const line = [resolved.replace(CMD_META, "^$1"), ...args.map(escapeArgument)].join(" ");

  // `/d` skips AutoRun commands from the registry — without it, whatever a user
  // or their IT department set there runs before every agent. `/s` makes the
  // outer quotes mean exactly "strip these two", which is what the line is
  // built to expect.
  return {
    command: env.COMSPEC ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    windowsVerbatimArguments: true,
  };
}
