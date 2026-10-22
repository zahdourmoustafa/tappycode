/**
 * Open an agent in a terminal on this computer, because the phone asked.
 *
 * The person picks an agent, a project, and either a past conversation or a
 * new one; a terminal window opens on the computer running it, wrapped like any
 * other, and the phone follows it there. Nothing to configure: it opens in the
 * terminal app this person last ran an agent in — Tappy notes that every time
 * one starts — and falls back to the one the system always has: Terminal on a
 * Mac, Windows Terminal or a console window on Windows, and on Linux whichever
 * common emulator is installed.
 *
 * Built so the phone can never run anything of its own choosing: the agent is
 * one of three, its arguments are built here from fixed options, the project
 * must be one this daemon has already published, and the command goes through
 * a script file this module writes, never through a string the phone sent.
 */
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { wire } from "@tappy/protocol";
import { isCompiled } from "../cli/service-shared.js";
import { type TerminalPlatform, terminalPlatform } from "./platform.js";

const run = promisify(execFile);

/** How a terminal is told to open: one way per kind of app, on each platform. */
export type OpenHow = "cmux" | "ghostty" | "open" | "linux" | "wt" | "console";

/** The terminal apps that can be told "open this and run it", by macOS bundle id. */
export const TERMINAL_APPS: Record<string, { name: string; how: "cmux" | "ghostty" | "open" }> = {
  "com.cmuxterm.app": { name: "cmux", how: "cmux" },
  "com.mitchellh.ghostty": { name: "Ghostty", how: "ghostty" },
  "com.googlecode.iterm2": { name: "iTerm", how: "open" },
  "com.apple.Terminal": { name: "Terminal", how: "open" },
};

const AGENT_NAMES: Record<wire.TerminalAgent, string> = {
  claude: "Claude",
  codex: "Codex",
  ggcoder: "GG Coder",
};

/** Apple's own, on every Mac: the fallback when nothing else is known. */
export const DEFAULT_TERMINAL = "com.apple.Terminal";

/**
 * The Linux emulators that can be told to run a script in a new window, by the
 * name `terminal-app.ts` reports, and how. Tried in this order when the one
 * this person uses is not known or not there; `x-terminal-emulator` is the
 * system's own choice on Debian and Ubuntu, so it goes first.
 */
export const LINUX_TERMINALS: Record<string, { name: string; argv: (script: string) => string[] }> =
  {
    "x-terminal-emulator": { name: "Terminal", argv: (s) => ["x-terminal-emulator", "-e", s] },
    "gnome-terminal": { name: "GNOME Terminal", argv: (s) => ["gnome-terminal", "--", s] },
    konsole: { name: "Konsole", argv: (s) => ["konsole", "-e", s] },
    kitty: { name: "kitty", argv: (s) => ["kitty", s] },
    wezterm: { name: "WezTerm", argv: (s) => ["wezterm", "start", "--", s] },
    ghostty: { name: "Ghostty", argv: (s) => ["ghostty", "-e", s] },
    alacritty: { name: "Alacritty", argv: (s) => ["alacritty", "-e", s] },
    "xfce4-terminal": { name: "Xfce Terminal", argv: (s) => ["xfce4-terminal", "-x", s] },
    xterm: { name: "xterm", argv: (s) => ["xterm", "-e", s] },
  };

/** The Windows ways to open a window: Windows Terminal, else a console window. */
export const WINDOWS_TERMINALS: Record<string, { name: string; how: "wt" | "console" }> = {
  "windows-terminal": { name: "Windows Terminal", how: "wt" },
  "windows-console": { name: "a console window", how: "console" },
};

/** Whether `app` is one this platform can open, and so worth remembering. */
function knownApp(app: string, platform: TerminalPlatform): boolean {
  if (platform === "darwin") return TERMINAL_APPS[app] !== undefined;
  if (platform === "win32") return WINDOWS_TERMINALS[app] !== undefined;
  return LINUX_TERMINALS[app] !== undefined;
}

/** `~/.tappy/terminal-app`: the bundle id of the app an agent last ran in. */
function appFile(env: NodeJS.ProcessEnv): string {
  return join(env.TAPPY_HOME ?? join(env.HOME || homedir(), ".tappy"), "terminal-app");
}

/** Note the app an agent just started in, so the next launch opens there too. */
export async function rememberTerminalApp(
  app: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!app || !knownApp(app, terminalPlatform(env))) return;
  const file = appFile(env);
  try {
    if ((await readFile(file, "utf8")).trim() === app) return;
  } catch {
    // Not written yet.
  }
  await mkdir(join(file, ".."), { recursive: true, mode: 0o700 });
  await writeFile(file, `${app}\n`, { mode: 0o600 });
}

async function rememberedApp(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  try {
    const app = (await readFile(appFile(env), "utf8")).trim();
    return knownApp(app, terminalPlatform(env)) ? app : undefined;
  } catch {
    return undefined;
  }
}

/** The agent's argv, from fixed options only. Undefined for a combination it does not support. */
export function agentArgs(
  agent: wire.TerminalAgent,
  resume: string | undefined,
  bypass: boolean,
): string[] | undefined {
  switch (agent) {
    case "claude":
      return [
        ...(resume ? ["--resume", resume] : []),
        ...(bypass ? ["--dangerously-skip-permissions"] : []),
      ];
    case "codex":
      return [
        ...(resume ? ["resume", resume] : []),
        ...(bypass ? ["--dangerously-bypass-approvals-and-sandbox"] : []),
      ];
    case "ggcoder":
      // GG Coder has no switch to skip its approvals.
      if (bypass) return undefined;
      return resume ? ["--resume", resume] : [];
  }
}

/** Single-quoted for sh. */
function sh(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The script a terminal is given to run: start in the project, run the agent
 * through tappy, and leave a shell behind when it exits so the window stays
 * useful instead of vanishing.
 *
 * A login, interactive shell does the work so the person's own setup applies —
 * the PATH their `claude` lives on, their environment — exactly as in a tab
 * they opened themselves.
 */
export function launchScript(
  tappy: string[],
  agent: wire.TerminalAgent,
  cwd: string,
  args: string[],
  shell: string,
): string {
  const command = [...tappy.map(sh), "wrap", agent, ...args.map(sh)].join(" ");
  return [
    "#!/bin/sh",
    "# Written by tappy to open an agent the phone asked for; deleted once used.",
    'rm -f "$0"',
    `cd ${sh(cwd)} || exit 1`,
    `exec ${sh(shell)} -l -i -c ${sh(`${command}; exec ${shell} -l -i`)}`,
    "",
  ].join("\n");
}

/**
 * One argument in a `.cmd` file, quoted. Inside double quotes cmd treats
 * `& | < > ^` as text; `%` still expands, so it is doubled. A double quote
 * cannot appear in a Windows path and nothing here produces one, so it is
 * refused rather than escaped — there is no escape for it inside quotes.
 */
function cmdQuote(value: string): string {
  if (/["\r\n]/.test(value)) throw new Error("unquotable for cmd");
  return `"${value.replaceAll("%", "%%")}"`;
}

/**
 * The Windows script a terminal is given: start in the project, run the agent
 * through tappy, then leave PowerShell behind so the tab stays useful, as the
 * Mac and Linux script leaves a shell.
 *
 * `(goto) 2>nul & del "%~f0"` is how a batch file deletes itself: cmd reads a
 * script line by line from disk, so deleting it any earlier makes the next line
 * fail. That line is parsed whole before the `goto` ends the script, so what
 * follows on it still runs.
 */
export function launchScriptCmd(
  tappy: string[],
  agent: wire.TerminalAgent,
  cwd: string,
  args: string[],
): string {
  const command = [...tappy.map(cmdQuote), "wrap", agent, ...args.map(cmdQuote)].join(" ");
  return [
    "@echo off",
    "rem Written by tappy to open an agent the phone asked for; deleted once used.",
    `cd /d ${cmdQuote(cwd)} || exit /b 1`,
    command,
    '(goto) 2>nul & del "%~f0" & powershell.exe -NoLogo',
    "",
  ].join("\r\n");
}

/**
 * How to run tappy itself: the released binary is that binary; a source
 * checkout is the runtime plus the CLI entry point. Never the runtime alone —
 * under `bun run`, `process.execPath` is Bun, and `bun wrap` is not a command.
 */
export function tappyCommand(): string[] {
  if (isCompiled()) return [process.execPath];
  return [process.execPath, fileURLToPath(new URL("../cli/index.ts", import.meta.url))];
}

/** `~/.tappy/launch`, private to this user: where launch scripts wait to be run. */
function launchDir(env: NodeJS.ProcessEnv): string {
  return join(env.TAPPY_HOME ?? join(env.HOME || homedir(), ".tappy"), "launch");
}

/** Remove scripts a terminal never got round to running. */
async function sweep(dir: string): Promise<void> {
  try {
    for (const name of await readdir(dir)) {
      const path = join(dir, name);
      if (Date.now() - (await stat(path)).mtimeMs > 10 * 60_000) await rm(path, { force: true });
    }
  } catch {
    // Nothing there yet.
  }
}

export interface LaunchResult {
  ok: boolean;
  cwd: string;
  app?: string;
  message?: string;
}

export interface LaunchOptions {
  agent: wire.TerminalAgent;
  cwd: string;
  resume?: string;
  bypass?: boolean;
  env?: NodeJS.ProcessEnv;
  /** How the script runs tappy; see `tappyCommand`. */
  tappy?: string[];
  /** Overrides how the terminal is opened, for tests. */
  open?: (how: OpenHow, app: string, script: string, cwd: string, title: string) => Promise<void>;
}

/** Thrown when Linux has no desktop session to open a window in: nothing else will do better. */
class NoDesktop extends Error {}

const DESKTOP_KEYS = [
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "XDG_SESSION_TYPE",
  "XDG_CURRENT_DESKTOP",
] as const;

/**
 * The desktop session's variables out of `systemctl --user show-environment`.
 * A daemon run as a systemd user service starts without `DISPLAY` or
 * `WAYLAND_DISPLAY`, but GNOME and KDE hand them to the user manager at login,
 * so that is where an emulator learns which screen to open on.
 */
export function desktopFromSystemd(text: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const at = line.indexOf("=");
    const key = line.slice(0, at);
    if (at > 0 && (DESKTOP_KEYS as readonly string[]).includes(key))
      found[key] = line.slice(at + 1);
  }
  return found;
}

/** This environment with a desktop to draw on, or undefined when there is none (SSH, a server). */
async function desktopEnv(env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv | undefined> {
  if (env.DISPLAY || env.WAYLAND_DISPLAY) return env;
  try {
    const { stdout } = await run("systemctl", ["--user", "show-environment"], { timeout: 5000 });
    const desktop = desktopFromSystemd(stdout);
    if (desktop.DISPLAY || desktop.WAYLAND_DISPLAY) return { ...env, ...desktop };
  } catch {
    // No systemd, or no user manager.
  }
  return undefined;
}

/**
 * Start an emulator and let it go. Many stay attached until their window is
 * closed, so success is "did not fail at once", not an exit code: one that
 * cannot reach a display gives up within a moment, nonzero.
 */
async function spawnWindow(argv: string[], env: NodeJS.ProcessEnv): Promise<void> {
  const [command, ...args] = argv;
  if (!command || !Bun.which(command, { PATH: env.PATH ?? "" })) throw new Error("not installed");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: "ignore", detached: true });
    let settled = false;
    const done = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => done(), 1500);
    child.once("error", (error) => done(error));
    child.once("exit", (code) => done(code === 0 ? undefined : new Error(`exited ${code}`)));
    child.unref();
  });
}

/** A tab title Windows Terminal and `start` both take as text: no quotes, `;`, `%` or `^`. */
function windowsTitle(title: string): string {
  return title.replace(/[^\p{L}\p{N} ._·-]/gu, " ").trim() || "Tappy";
}

/** How each kind of app is told to run a script in a new window or tab. */
async function openIn(
  how: OpenHow,
  app: string,
  script: string,
  cwd: string,
  title: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  switch (how) {
    case "linux": {
      const terminal = LINUX_TERMINALS[app];
      if (!terminal) throw new Error("unknown terminal");
      const desktop = await desktopEnv(env);
      if (!desktop) throw new NoDesktop("no desktop");
      await spawnWindow(terminal.argv(script), desktop);
      return;
    }
    case "wt":
      // `-w 0`: a new tab in the window used last, or a new window if none is
      // open. Arguments after the title are the command, run as given.
      await run(
        "wt.exe",
        [
          "-w",
          "0",
          "new-tab",
          "--title",
          windowsTitle(title),
          "cmd.exe",
          "/d",
          "/v:off",
          "/c",
          script,
        ],
        { timeout: 15_000, env },
      );
      return;
    case "console": {
      // `start` opens a window of its own and returns at once. The line is
      // built here and handed over verbatim, the same way `acp/launch.ts` runs
      // a batch file: `/s` strips exactly the outer quotes.
      if (/["%]/.test(script)) throw new Error("unquotable script path");
      const line = `start "${windowsTitle(title)}" cmd.exe /d /v:off /c "${script}"`;
      await run(env.COMSPEC ?? "cmd.exe", ["/d", "/s", "/c", `"${line}"`], {
        timeout: 15_000,
        env,
        windowsVerbatimArguments: true,
      });
      return;
    }
    case "cmux": {
      // cmux's own command line opens a tab in the running app, named the way
      // a person would name it rather than after the script's file.
      const cli = "/Applications/cmux.app/Contents/Resources/bin/cmux";
      await run(cli, ["new-workspace", "--name", title, "--cwd", cwd, "--command", script], {
        timeout: 15_000,
        env: { ...process.env, CMUX_QUIET: "1" },
      });
      return;
    }
    case "ghostty":
      // Ghostty runs what follows -e in a new window of its own.
      await run("open", ["-na", "Ghostty", "--args", "-e", script], { timeout: 15_000 });
      return;
    case "open":
      // Terminal and iTerm run an executable file they are handed, in a new window.
      await run("open", ["-b", app, script], { timeout: 15_000 });
      return;
  }
}

export async function launchAgent(options: LaunchOptions): Promise<LaunchResult> {
  const env = options.env ?? process.env;
  let cwd: string;
  try {
    // The path the agent will see, so its terminal is recognised by it.
    cwd = await realpath(options.cwd);
    if (!(await stat(cwd)).isDirectory()) throw new Error("not a directory");
  } catch {
    return {
      ok: false,
      cwd: options.cwd,
      message: "That project folder is not on the computer any more.",
    };
  }
  const args = agentArgs(options.agent, options.resume, options.bypass === true);
  if (!args) return { ok: false, cwd, message: "That agent can't skip its approvals." };

  const platform = terminalPlatform(env);
  const remembered = await rememberedApp(env);
  const tappy = options.tappy ?? tappyCommand();
  const title = `${AGENT_NAMES[options.agent]} · ${basename(cwd)}`;

  const dir = launchDir(env);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  void sweep(dir);
  const name = `tappy-${randomBytes(8).toString("hex")}`;
  let script: string;
  try {
    if (platform === "win32") {
      script = join(dir, `${name}.cmd`);
      await writeFile(script, launchScriptCmd(tappy, options.agent, cwd, args), { mode: 0o700 });
    } else {
      // `.command` is what Terminal and iTerm run when handed a file.
      script = join(dir, platform === "darwin" ? `${name}.command` : `${name}.sh`);
      await writeFile(
        script,
        launchScript(tappy, options.agent, cwd, args, loginShell(env, platform)),
        {
          mode: 0o700,
        },
      );
    }
  } catch {
    return {
      ok: false,
      cwd,
      message: "That project folder's name can't be opened from the phone.",
    };
  }

  const open =
    options.open ?? ((how, app, file, at, label) => openIn(how, app, file, at, label, env));
  for (const attempt of launchAttempts(platform, remembered)) {
    try {
      await open(attempt.how, attempt.app, script, cwd, title);
      return { ok: true, cwd, app: attempt.name };
    } catch (error) {
      // No desktop at all: no other emulator will find one either.
      if (error instanceof NoDesktop) {
        await rm(script, { force: true });
        return {
          ok: false,
          cwd,
          message:
            "This computer has no desktop to open a window on. Start the agent in a terminal there and the phone will find it.",
        };
      }
      // The app this person uses could not be reached (closed, removed,
      // refused): the next one, ending with the one the system always has.
    }
  }
  await rm(script, { force: true });
  return {
    ok: false,
    cwd,
    message: "Couldn't open a terminal on the computer. Is it awake and logged in?",
  };
}

/**
 * The login shell the script runs the agent in, so the person's own setup —
 * the PATH their `claude` lives on — applies. macOS has always defaulted to
 * zsh; Linux reads the account's shell when the daemon's environment does not
 * say, since a systemd service is often started without `SHELL`.
 */
function loginShell(env: NodeJS.ProcessEnv, platform: TerminalPlatform): string {
  const safe = (shell: string | undefined) =>
    shell && /^\/[\w/.-]+$/.test(shell) ? shell : undefined;
  if (platform === "darwin") return safe(env.SHELL) ?? "/bin/zsh";
  let account: string | undefined;
  try {
    account = userInfo().shell ?? undefined;
  } catch {
    // No passwd entry (some containers).
  }
  return safe(env.SHELL) ?? safe(account) ?? "/bin/sh";
}

/** Where to try opening, in order: the app last used first, then the platform's fallbacks. */
export function launchAttempts(
  platform: TerminalPlatform,
  remembered: string | undefined,
): Array<{ how: OpenHow; app: string; name: string }> {
  if (platform === "darwin") {
    const app = remembered ?? DEFAULT_TERMINAL;
    const target = TERMINAL_APPS[app] ?? { name: "Terminal", how: "open" as const };
    const first = { how: target.how, app, name: target.name };
    // The Mac's own terminal can always be reached.
    return app === DEFAULT_TERMINAL
      ? [first]
      : [first, { how: "open", app: DEFAULT_TERMINAL, name: "Terminal" }];
  }
  const table: Record<string, { name: string; how: OpenHow }> =
    platform === "win32"
      ? WINDOWS_TERMINALS
      : Object.fromEntries(
          Object.entries(LINUX_TERMINALS).map(([id, t]) => [
            id,
            { name: t.name, how: "linux" as const },
          ]),
        );
  const order = [...(remembered && table[remembered] ? [remembered] : []), ...Object.keys(table)];
  return [...new Set(order)].flatMap((app) => {
    const target = table[app];
    return target ? [{ how: target.how, app, name: target.name }] : [];
  });
}
