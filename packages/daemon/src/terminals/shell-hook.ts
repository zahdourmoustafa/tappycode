/**
 * The one piece of setup that makes a normally typed `claude` reachable.
 *
 * Installed by `tappy pair`, so pairing stays the only thing anyone runs.
 *
 * Three launchers — `claude`, `codex`, `ggcoder` — live in `~/.tappy/bin`, and
 * the shell's startup file puts that directory first on PATH. Typing `claude`
 * finds the launcher, which hands over to `tappy wrap claude`, which runs the
 * real one. Nothing about using them changes: same command, same flags, same
 * screen.
 *
 * Launchers on PATH, not shell functions, because something else usually wants
 * `claude` too. cmux (and tools like it) define their own `claude` function
 * *after* the startup file runs, then look the "real" binary up on PATH. A
 * function of ours was simply replaced and never ran; a launcher on PATH is
 * what their lookup finds, so both wrappers apply — theirs outside, ours under
 * it — in every terminal, alias or no alias.
 *
 * The rc block is marked so it can be replaced or removed exactly, and every
 * file is written atomically: `.zshrc` is read by every new terminal, and a
 * half-written one breaks all of them.
 *
 * Windows has no one startup file — PowerShell, cmd, Git Bash and VS Code each
 * read their own — but they all start from the user's PATH in the registry. So
 * there the directory goes first on that PATH, and the launchers are `.cmd`
 * files (what PowerShell and cmd run) plus the same sh script for Git Bash.
 * The old PATH is saved before it is first changed, only Tappy's own entry is
 * ever added or removed, and the value keeps its registry type: a PATH full of
 * `%USERPROFILE%\…` entries rewritten as plain text would stop expanding them.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { wire } from "@tappy/protocol";
import { type TerminalPlatform, terminalPlatform } from "./platform.js";
import { isCompiled } from "../cli/service-shared.js";

const run = promisify(execFile);

const BEGIN = "# >>> tappy terminal bridge >>>";
const END = "# <<< tappy terminal bridge <<<";

/** Marks a launcher as ours, so `tappy wrap` never mistakes one for the agent. */
export const SHIM_MARKER = "# tappy-launcher";

/**
 * `~/.tappy/bin`, or under `$TAPPY_HOME`. On Windows the profile folder, never
 * `HOME`: Git Bash sets one of its own, and `tappy pair` run there would put
 * the launchers where the daemon and every other shell never look.
 */
export function shimDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: TerminalPlatform = terminalPlatform(env),
): string {
  if (env.TAPPY_HOME) return join(env.TAPPY_HOME, "bin");
  return join(platform === "win32" ? homedir() : env.HOME || homedir(), ".tappy", "bin");
}

/** Single-quoted for sh, zsh and bash alike. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Single-quoted for fish, which escapes inside quotes with backslashes. */
function fishQuote(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

/**
 * The rc block: `dir` moved to the front of PATH.
 *
 * Moved, not just added: a PATH inherited from a parent shell can already hold
 * it further back, behind a directory that has the real `claude` in it, and an
 * "add if missing" check would leave it there and never be reached.
 */
export function hookBlock(dir: string, shell: "sh" | "fish" = "sh"): string {
  if (shell === "fish") {
    return [
      BEGIN,
      "# Lets the Tappy phone app type into claude, codex and ggcoder. Added by `tappy pair`.",
      `set -l __tappy_bin ${fishQuote(dir)}`,
      "set -gx PATH $__tappy_bin (string match -v -- $__tappy_bin $PATH)",
      END,
    ].join("\n");
  }
  const quoted = shellQuote(dir);
  return [
    BEGIN,
    "# Lets the Tappy phone app type into claude, codex and ggcoder. Added by `tappy pair`.",
    `__tappy_bin=${quoted}`,
    'PATH="$__tappy_bin:${PATH//$__tappy_bin:/}"',
    "export PATH",
    "unset __tappy_bin",
    END,
  ].join("\n");
}

/**
 * The launcher, identical for all three agents: it works out which one it is
 * from its own name.
 *
 * It never spells the agent's name next to `exec` or `command`. cmux reads a
 * PATH candidate's first lines and treats `exec claude`-shaped text as one of
 * its own re-entry shims, which it skips — and then Tappy would be skipped too.
 *
 * Falls back to the real agent further along PATH when `tappy` is gone, so
 * removing Tappy can never break `claude`.
 */
export function shimScript(tappyPath: string): string {
  return [
    "#!/bin/sh",
    SHIM_MARKER,
    "# Lets the Tappy phone app type into this agent. Added by `tappy pair`;",
    "# `tappy shell uninstall` removes it.",
    'agent=$(basename "$0")',
    'here=$(cd "$(dirname "$0")" && pwd -P)',
    `tappy_bin=${shellQuote(tappyPath)}`,
    'if [ -x "$tappy_bin" ]; then exec "$tappy_bin" wrap "$agent" "$@"; fi',
    "# Tappy is not installed any more: run the agent itself, further along PATH.",
    "IFS=:",
    "for dir in $PATH; do",
    "  # Compared resolved, so a symlinked or relative PATH entry cannot send this",
    "  # straight back to itself.",
    '  [ "$(cd "$dir" 2>/dev/null && pwd -P)" = "$here" ] && continue',
    '  [ -x "$dir/$agent" ] && exec "$dir/$agent" "$@"',
    "done",
    'echo "$agent: command not found" >&2',
    "exit 127",
    "",
  ].join("\n");
}

/**
 * `tappy` itself, beside the agents' launchers, so the directory pairing puts
 * on PATH also makes the `tappy` command work — without it a fresh install
 * ends on "add this folder to your PATH", homework before anything works.
 * Only for a compiled binary, whose path is stable: under `bun run` the path
 * is the developer's `bun`, and a `tappy` pointing there would be wrong.
 */
export function selfScript(tappyPath: string): string {
  return [
    "#!/bin/sh",
    SHIM_MARKER,
    "# Runs tappy. Added by `tappy pair`; `tappy shell uninstall` removes it.",
    `exec ${shellQuote(tappyPath)} "$@"`,
    "",
  ].join("\n");
}

/** `content` with no hook block in it. */
export function withoutHook(content: string): string {
  const start = content.indexOf(BEGIN);
  if (start === -1) return content;
  const stop = content.indexOf(END, start);
  if (stop === -1) return content;
  const before = content.slice(0, start).replace(/\n+$/, "");
  const after = content.slice(stop + END.length).replace(/^\n+/, "");
  if (!before) return after;
  return after ? `${before}\n\n${after}` : `${before}\n`;
}

/** `content` with exactly one, current hook block at the end. */
export function withHook(content: string, dir: string, shell: "sh" | "fish" = "sh"): string {
  const block = hookBlock(dir, shell);
  const base = withoutHook(content).replace(/\n+$/, "");
  return base ? `${base}\n\n${block}\n` : `${block}\n`;
}

/**
 * The startup file of the user's login shell, or undefined for a shell the hook
 * is not written for yet (nushell, elvish…). Fish gets a file of its own in
 * `conf.d`, which fish reads by itself — nothing of the user's is edited.
 */
export function shellStartupFile(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const home = env.HOME || homedir();
  const shell = basename(env.SHELL ?? "");
  if (shell === "zsh") return join(env.ZDOTDIR || home, ".zshrc");
  if (shell === "bash") return join(home, ".bashrc");
  if (shell === "fish")
    return join(env.XDG_CONFIG_HOME || join(home, ".config"), "fish", "conf.d", "tappy.fish");
  return undefined;
}

function shellOf(file: string): "sh" | "fish" {
  return file.endsWith(".fish") ? "fish" : "sh";
}

// ── Windows ─────────────────────────────────────────────────

/** Where the Windows install says it lives, for `tappy pair --json` and uninstall's message. */
export const WINDOWS_PATH_LOCATION = "HKCU\\Environment\\Path";

/** The user's PATH as the registry holds it: unexpanded, with its type. */
export interface UserPathValue {
  value: string;
  kind: "String" | "ExpandString";
}

/** Reads and writes the user's PATH. Injected in tests; PowerShell for real. */
export interface UserPathStore {
  read(): Promise<UserPathValue | undefined>;
  write(next: UserPathValue): Promise<void>;
}

/**
 * The registry through PowerShell, which every Windows 10 and 11 has. Both
 * scripts are constants: the new value travels in an environment variable,
 * never inside script text, so no PATH entry can be read as code.
 *
 * `SetEnvironmentVariable` is not used to write PATH itself — it saves every
 * value as plain text, which breaks `%USERPROFILE%` entries. It is used only on
 * a throwaway variable, because that is what tells Explorer and every program
 * started afterwards that the environment changed.
 */
export const powershellUserPath: UserPathStore = {
  async read() {
    const script = [
      "$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')",
      "$v = $k.GetValue('Path', $null, 'DoNotExpandEnvironmentNames')",
      "if ($null -eq $v) { '{}' } else { @{ value = [string]$v; kind = $k.GetValueKind('Path').ToString() } | ConvertTo-Json -Compress }",
    ].join("; ");
    const { stdout } = await run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        timeout: 20_000,
      },
    );
    const parsed = JSON.parse(stdout.trim() || "{}") as { value?: unknown; kind?: unknown };
    if (typeof parsed.value !== "string") return undefined;
    return { value: parsed.value, kind: parsed.kind === "String" ? "String" : "ExpandString" };
  },
  async write(next) {
    const script = [
      "$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)",
      "$k.SetValue('Path', $env:TAPPY_USER_PATH, [Microsoft.Win32.RegistryValueKind]$env:TAPPY_USER_PATH_KIND)",
      "$k.Close()",
      "[Environment]::SetEnvironmentVariable('TAPPY_PATH_REFRESH', '1', 'User')",
      "[Environment]::SetEnvironmentVariable('TAPPY_PATH_REFRESH', $null, 'User')",
    ].join("; ");
    await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      timeout: 20_000,
      env: { ...process.env, TAPPY_USER_PATH: next.value, TAPPY_USER_PATH_KIND: next.kind },
    });
  },
};

/** One PATH entry as Windows would resolve it, for comparing: no quotes, no trailing slash, any case. */
function windowsEntryKey(entry: string, env: NodeJS.ProcessEnv): string {
  const expanded = entry
    .trim()
    .replace(/^"(.*)"$/, "$1")
    .replace(/%([^%]+)%/g, (whole, name: string) => {
      const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
      return key ? (env[key] ?? whole) : whole;
    });
  return expanded.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

/** `value` with `dir` removed wherever it appears, in any spelling of it. Empty entries are kept as they were. */
export function userPathWithout(
  value: string,
  dir: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const ours = windowsEntryKey(dir, env);
  return value
    .split(";")
    .filter((entry) => !entry.trim() || windowsEntryKey(entry, env) !== ours)
    .join(";");
}

/** `value` with `dir` first, and nowhere else — moved forward, for the same reason as the rc block. */
export function userPathWith(
  value: string,
  dir: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const rest = userPathWithout(value, dir, env).replace(/^;+/, "");
  return rest ? `${dir};${rest}` : dir;
}

/**
 * The Windows launcher: a batch file, because that is what PowerShell and cmd
 * run by name. One per agent, its name written in, since `%~n0` is not worth a
 * subtlety here.
 *
 * Falls back, like the sh one, to the real agent when `tappy` is gone: it takes
 * its own folder off PATH for the rest of the script and runs the name again.
 */
export function shimCmd(tappyPath: string, agent: wire.TerminalAgent, dir: string): string {
  const tappy = tappyPath.replaceAll("%", "%%");
  return [
    "@echo off",
    `rem ${SHIM_MARKER}`,
    "rem Lets the Tappy phone app type into this agent. Added by `tappy pair`;",
    "rem `tappy shell uninstall` removes it.",
    `if not exist "${tappy}" goto missing`,
    `"${tappy}" wrap ${agent} %*`,
    "exit /b %errorlevel%",
    ":missing",
    "rem Tappy is not installed any more: run the agent itself, further along PATH.",
    "setlocal",
    'set "PATH=;%PATH%;"',
    `set "PATH=%PATH:;${dir};=;%"`,
    `${agent} %*`,
    "",
  ].join("\r\n");
}

/** The PATH folder for Windows' own shells; the sh launcher there is for Git Bash. */
function windowsLauncherFiles(
  tappyPath: string,
  dir: string,
): Array<{ name: string; content: string }> {
  return wire.TERMINAL_AGENTS.flatMap((agent) => [
    { name: `${agent}.cmd`, content: shimCmd(tappyPath, agent, dir) },
    // Git Bash runs a script by its exact name and takes `C:/…` where it would
    // stumble on backslashes.
    { name: agent, content: shimScript(tappyPath.replaceAll("\\", "/")) },
  ]);
}

/** Keep a copy of the PATH as it was, the first time it is changed. */
async function backUpUserPath(
  current: UserPathValue | undefined,
  env: NodeJS.ProcessEnv,
  now: number,
): Promise<void> {
  const dir = join(dirname(shimDir(env, "win32")), "legacy-backup");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, `user-path-${now}.json`), `${JSON.stringify(current ?? null)}\n`, {
    mode: 0o600,
  });
}

async function installWindowsHook(
  env: NodeJS.ProcessEnv,
  tappyPath: string,
  store: UserPathStore,
  now: number,
): Promise<HookResult> {
  const dir = shimDir(env, "win32");
  await mkdir(dir, { recursive: true });
  let changed = false;
  for (const file of windowsLauncherFiles(tappyPath, dir)) {
    if (await writeIfChanged(join(dir, file.name), file.content, 0o755)) changed = true;
  }
  const current = await store.read();
  const next = userPathWith(current?.value ?? "", dir, env);
  if (next !== current?.value) {
    await backUpUserPath(current, env, now);
    // A PATH that never existed is created expandable, as Windows itself would.
    await store.write({ value: next, kind: current?.kind ?? "ExpandString" });
    changed = true;
  }
  return { file: WINDOWS_PATH_LOCATION, changed };
}

async function uninstallWindowsHook(
  env: NodeJS.ProcessEnv,
  store: UserPathStore,
): Promise<HookResult> {
  const dir = shimDir(env, "win32");
  let changed = false;
  for (const agent of wire.TERMINAL_AGENTS) {
    for (const name of [`${agent}.cmd`, agent]) {
      if (await removeIfOurs(join(dir, name))) changed = true;
    }
  }
  const current = await store.read();
  if (current) {
    const next = userPathWithout(current.value, dir, env);
    if (next !== current.value) {
      await store.write({ value: next, kind: current.kind });
      changed = true;
    }
  }
  return { file: WINDOWS_PATH_LOCATION, changed };
}

/** Remove a launcher only if this module wrote it; anything else there is the user's. */
async function removeIfOurs(path: string): Promise<boolean> {
  try {
    if ((await readFile(path, "utf8")).includes(SHIM_MARKER)) {
      await rm(path);
      return true;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return false;
}

export interface HookResult {
  /** The file written, or undefined when this shell is not supported. */
  file?: string;
  /** False when everything was already exactly in place. */
  changed: boolean;
}

/** Write `next` over `file` atomically. False when it already held exactly that. */
async function writeIfChanged(file: string, next: string, fallbackMode: number): Promise<boolean> {
  let content: string | undefined;
  let mode = fallbackMode;
  try {
    content = await readFile(file, "utf8");
    mode = (await stat(file)).mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (next === content) return false;
  // Beside the target, so the rename is atomic: a reader sees the old file or
  // the new one, never a truncated one.
  const temp = join(dirname(file), `.${basename(file)}.tappy-${randomUUID()}`);
  await writeFile(temp, next, { mode });
  await rename(temp, file);
  return true;
}

/** The `tappy` the launchers call: the one this command was run as. */
function currentTappy(env: NodeJS.ProcessEnv): string {
  // A compiled binary is tappy: its own path, never a `tappy` found on PATH,
  // which may be the launcher this very hook writes.
  if (isCompiled()) return process.execPath;
  return Bun.which("tappy", { PATH: env.PATH ?? process.env.PATH ?? "" }) ?? process.execPath;
}

export interface HookOptions {
  /** The user's PATH on Windows; the registry unless a test says otherwise. */
  userPath?: UserPathStore;
  /** Stamps the Windows PATH backup. */
  now?: number;
}

export async function installShellHook(
  env: NodeJS.ProcessEnv = process.env,
  tappyPath: string = currentTappy(env),
  options: HookOptions = {},
  self: boolean = isCompiled(),
): Promise<HookResult> {
  if (terminalPlatform(env) === "win32") {
    return installWindowsHook(
      env,
      tappyPath,
      options.userPath ?? powershellUserPath,
      options.now ?? Date.now(),
    );
  }
  const file = shellStartupFile(env);
  if (!file) return { changed: false };

  const dir = shimDir(env);
  await mkdir(dir, { recursive: true, mode: 0o755 });
  let changed = false;
  for (const agent of wire.TERMINAL_AGENTS) {
    // Executable, and only by its owner to write: it runs every time `claude`
    // is typed.
    if (await writeIfChanged(join(dir, agent), shimScript(tappyPath), 0o755)) changed = true;
  }
  if (self && (await writeIfChanged(join(dir, "tappy"), selfScript(tappyPath), 0o755)))
    changed = true;

  let rc = "";
  try {
    rc = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // fish's `conf.d` may not exist yet; zsh's and bash's folder is home.
  await mkdir(dirname(file), { recursive: true });
  if (await writeIfChanged(file, withHook(rc, dir, shellOf(file)), 0o644)) changed = true;
  return { file, changed };
}

export async function uninstallShellHook(
  env: NodeJS.ProcessEnv = process.env,
  options: HookOptions = {},
): Promise<HookResult> {
  if (terminalPlatform(env) === "win32")
    return uninstallWindowsHook(env, options.userPath ?? powershellUserPath);
  const file = shellStartupFile(env);
  const dir = shimDir(env);
  let changed = false;
  for (const agent of wire.TERMINAL_AGENTS) {
    if (await removeIfOurs(join(dir, agent))) changed = true;
  }
  if (await removeIfOurs(join(dir, "tappy"))) changed = true;
  if (!file) return { changed };
  let rc: string | undefined;
  try {
    rc = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (rc !== undefined && shellOf(file) === "fish") {
    // The whole file is Tappy's; leaving it empty would be litter.
    if (!withoutHook(rc).trim()) {
      await rm(file, { force: true });
      return { file, changed: true };
    }
  }
  if (rc !== undefined && (await writeIfChanged(file, withoutHook(rc), 0o644))) changed = true;
  return { file, changed };
}
