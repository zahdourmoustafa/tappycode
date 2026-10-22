/**
 * The terminal bridge's Linux and Windows halves.
 *
 * Most of it is decided by pure rules — which PATH entries count, what the
 * launchers say, where the link lives, which window opens — and those are
 * checked here on every platform with `TAPPY_FAKE_PLATFORM`, so a Mac run
 * proves the Windows rules too. What only a real Windows can prove (ConPTY,
 * named pipes, cmd.exe running the launchers) is at the bottom, and runs in the
 * Windows CI job.
 */
import { afterAll, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wire } from "@tappy/protocol";
import { codexSource } from "./agent-mirrors.js";
import { claudeSource } from "./claude-mirror.js";
import {
  desktopFromSystemd,
  launchAgent,
  launchAttempts,
  launchScriptCmd,
  rememberTerminalApp,
} from "./launch.js";
import { isPipePath, terminalSocketPath } from "./link.js";
import { samePath, terminalPlatform } from "./platform.js";
import { TerminalRegistry } from "./registry.js";
import {
  hookBlock,
  installShellHook,
  shellStartupFile,
  shimCmd,
  shimDir,
  type UserPathStore,
  type UserPathValue,
  uninstallShellHook,
  userPathWith,
  userPathWithout,
  WINDOWS_PATH_LOCATION,
  withHook,
} from "./shell-hook.js";
import { startTerminalSocket } from "./socket.js";
import { detectTerminalApp } from "./terminal-app.js";
import { findRealAgent, keepLinked } from "./wrap.js";

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});
async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tappy-xp-"));
  roots.push(dir);
  return dir;
}

async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("timed out");
    await Bun.sleep(20);
  }
}

const WIN = { TAPPY_FAKE_PLATFORM: "win32" } as const;
const LINUX = { TAPPY_FAKE_PLATFORM: "linux" } as const;

// ── Platform rules ──────────────────────────────────────────

test("the platform can be pinned for tests, and posix means Linux", () => {
  expect(terminalPlatform(WIN)).toBe("win32");
  expect(terminalPlatform({ TAPPY_FAKE_PLATFORM: "posix" })).toBe("linux");
  expect(terminalPlatform({ TAPPY_FAKE_PLATFORM: "darwin" })).toBe("darwin");
});

test("a Windows folder is the same however it was typed; elsewhere a path is exact", () => {
  expect(samePath("C:\\Users\\Me\\Repo", "c:/users/me/repo\\", "win32")).toBe(true);
  expect(samePath("C:\\Repo", "C:\\Repo2", "win32")).toBe(false);
  expect(samePath("/Users/me/Repo", "/Users/me/repo", "darwin")).toBe(false);
});

// ── The link ────────────────────────────────────────────────

test("on Windows the link is a named pipe with a secret name, kept and reused", async () => {
  const home = await root();
  const env = { TAPPY_HOME: home };
  const first = terminalSocketPath(env, "win32");
  expect(first).toMatch(/^\\\\\.\\pipe\\tappy-terminals-[0-9a-f]{32}$/);
  expect(isPipePath(first)).toBe(true);
  // The daemon and every wrapper read the same name.
  expect(terminalSocketPath(env, "win32")).toBe(first);
  // A second machine (or account) gets a name of its own.
  expect(terminalSocketPath({ TAPPY_HOME: await root() }, "win32")).not.toBe(first);
  // Junk in the file is replaced, not trusted as a pipe name.
  await writeFile(join(home, "terminals.pipe"), "\\\\.\\pipe\\someone-elses\n");
  const replaced = terminalSocketPath(env, "win32");
  expect(replaced).toMatch(/^\\\\\.\\pipe\\tappy-terminals-[0-9a-f]{32}$/);
  expect(replaced).not.toBe("\\\\.\\pipe\\someone-elses");
});

test("on macOS and Linux the link is still the socket in ~/.tappy", () => {
  expect(terminalSocketPath({ TAPPY_HOME: "/h" }, "linux")).toBe(join("/h", "terminals.sock"));
  expect(isPipePath(join("/h", "terminals.sock"))).toBe(false);
});

// ── Which terminal ──────────────────────────────────────────

test("the terminal app is read from what each terminal leaves in its shells", () => {
  expect(detectTerminalApp({ __CFBundleIdentifier: "com.cmuxterm.app" }, "darwin")).toBe(
    "com.cmuxterm.app",
  );
  expect(detectTerminalApp({ WT_SESSION: "x" }, "win32")).toBe("windows-terminal");
  expect(detectTerminalApp({ TERM_PROGRAM: "vscode", WT_SESSION: "x" }, "linux")).toBe("vscode");
  expect(detectTerminalApp({}, "win32")).toBe("windows-console");
  expect(detectTerminalApp({ GNOME_TERMINAL_SCREEN: "/x" }, "linux")).toBe("gnome-terminal");
  expect(detectTerminalApp({ KITTY_WINDOW_ID: "1" }, "linux")).toBe("kitty");
  // WSL passes Windows Terminal's variable through; Linux cannot open its windows.
  expect(detectTerminalApp({ WT_SESSION: "x" }, "linux")).toBeUndefined();
});

// ── Taking over `claude` on Windows ─────────────────────────

test("the user PATH gets the launchers first, once, and loses only them again", () => {
  const env = { USERPROFILE: "C:\\Users\\me" };
  const dir = "C:\\Users\\me\\.tappy\\bin";
  const original = "%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;C:\\tools;;";
  const added = userPathWith(original, dir, env);
  expect(added).toBe(`${dir};${original}`);
  expect(userPathWith(added, dir, env)).toBe(added);
  expect(userPathWithout(added, dir, env)).toBe(original);
  // Already there further back, in another spelling: moved, not duplicated.
  const behind = `C:\\tools;"%USERPROFILE%\\.TAPPY\\bin\\";C:\\other`;
  expect(userPathWith(behind, dir, env)).toBe(`${dir};C:\\tools;C:\\other`);
  expect(userPathWith("", dir, env)).toBe(dir);
});

/** A user PATH held in memory, recording what was written and with which type. */
function memoryPath(
  initial?: UserPathValue,
): UserPathStore & { current?: UserPathValue; writes: number } {
  const store = {
    current: initial,
    writes: 0,
    async read() {
      return store.current;
    },
    async write(next: UserPathValue) {
      store.current = next;
      store.writes++;
    },
  };
  return store;
}

test("installing on Windows writes the launchers, backs up the PATH, keeps its type, and undoes cleanly", async () => {
  const home = await root();
  const env = { ...WIN, TAPPY_HOME: home };
  const original: UserPathValue = { value: "%USERPROFILE%\\bin;C:\\tools", kind: "ExpandString" };
  const userPath = memoryPath(original);
  const tappy = "C:\\Program Files\\Tappy\\tappy.exe";

  expect(await installShellHook(env, tappy, { userPath, now: 1 })).toEqual({
    file: WINDOWS_PATH_LOCATION,
    changed: true,
  });
  const dir = shimDir(env);
  expect(userPath.current).toEqual({ value: `${dir};${original.value}`, kind: "ExpandString" });
  for (const agent of wire.TERMINAL_AGENTS) {
    expect(await readFile(join(dir, `${agent}.cmd`), "utf8")).toBe(shimCmd(tappy, agent, dir));
    // For Git Bash, which runs a script by its exact name and wants forward slashes.
    expect(await readFile(join(dir, agent), "utf8")).toContain(
      "'C:/Program Files/Tappy/tappy.exe'",
    );
  }
  expect(
    JSON.parse(await readFile(join(home, "legacy-backup", "user-path-1.json"), "utf8")),
  ).toEqual(original);

  // Idempotent: nothing written the second time.
  expect(await installShellHook(env, tappy, { userPath, now: 2 })).toEqual({
    file: WINDOWS_PATH_LOCATION,
    changed: false,
  });
  expect(userPath.writes).toBe(1);
  expect(await readdir(join(home, "legacy-backup"))).toEqual(["user-path-1.json"]);

  expect(await uninstallShellHook(env, { userPath })).toEqual({
    file: WINDOWS_PATH_LOCATION,
    changed: true,
  });
  expect(userPath.current).toEqual(original);
  expect(await readdir(dir)).toEqual([]);
});

test("the Windows launcher hands over to tappy, and runs the agent itself once tappy is gone", () => {
  const cmd = shimCmd("C:\\T 100%\\tappy.exe", "codex", "C:\\Users\\me\\.tappy\\bin");
  const lines = cmd.split("\r\n");
  expect(lines).toContain('if not exist "C:\\T 100%%\\tappy.exe" goto missing');
  expect(lines).toContain('"C:\\T 100%%\\tappy.exe" wrap codex %*');
  expect(lines).toContain('set "PATH=%PATH:;C:\\Users\\me\\.tappy\\bin;=;%"');
  expect(lines.at(-2)).toBe("codex %*");
});

test("the real agent on Windows is a PATHEXT program, never our launcher or npm's Git Bash script", async () => {
  const home = await root();
  const env = { ...WIN, TAPPY_HOME: home, PATHEXT: ".EXE;.CMD" };
  await installShellHook(env, "C:\\tappy.exe", { userPath: memoryPath() });
  const npm = join(home, "npm");
  await mkdir(npm);
  // What `npm install -g` writes: a Git Bash script with no suffix, and the .cmd.
  await writeFile(join(npm, "claude"), "#!/bin/sh\n");
  await writeFile(join(npm, "claude.cmd"), "@echo off\r\n");
  // Another tool's launcher of ours, copied somewhere else, is still skipped.
  const copied = join(home, "copied");
  await mkdir(copied);
  await writeFile(join(copied, "claude.cmd"), shimCmd("C:\\tappy.exe", "claude", copied));
  const path = [`"${shimDir(env)}"`, copied, npm].join(";");
  expect(findRealAgent("claude", { ...env, PATH: path })).toBe(join(npm, "claude.cmd"));
  expect(findRealAgent("codex", { ...env, PATH: path })).toBeUndefined();
});

// ── Taking over `claude` in fish ────────────────────────────

test("fish gets a file of its own in conf.d, which uninstalling removes", async () => {
  const home = await root();
  const env = { ...LINUX, HOME: home, SHELL: "/usr/bin/fish" };
  const file = join(home, ".config", "fish", "conf.d", "tappy.fish");
  expect(shellStartupFile(env)).toBe(file);
  expect(await installShellHook(env, "/opt/tappy")).toEqual({ file, changed: true });
  expect(await readFile(file, "utf8")).toBe(withHook("", shimDir(env), "fish"));
  expect(await uninstallShellHook(env)).toEqual({ file, changed: true });
  expect(await Bun.file(file).exists()).toBe(false);
});

test.skipIf(!Bun.which("fish"))(
  "the fish block puts the launchers first on PATH, moving them forward",
  async () => {
    const script = `${hookBlock("/h/it's here/bin", "fish")}\nstring join : $PATH`;
    const proc = Bun.spawn(["fish", "--no-config", "-c", script], {
      env: { PATH: "/usr/bin:/h/it's here/bin:/bin" },
      stdout: "pipe",
    });
    expect((await new Response(proc.stdout).text()).trim()).toBe("/h/it's here/bin:/usr/bin:/bin");
  },
);

// ── Opening a window from the phone ─────────────────────────

test("Linux tries the emulator last used, then the system's choice, then the common ones", () => {
  const order = launchAttempts("linux", "kitty").map((a) => a.app);
  expect(order[0]).toBe("kitty");
  expect(order[1]).toBe("x-terminal-emulator");
  expect(order).toContain("gnome-terminal");
  expect(new Set(order).size).toBe(order.length);
  expect(launchAttempts("linux", undefined)[0]?.app).toBe("x-terminal-emulator");
});

test("Windows tries Windows Terminal, then a console window", () => {
  expect(launchAttempts("win32", undefined).map((a) => a.how)).toEqual(["wt", "console"]);
  expect(launchAttempts("win32", "windows-console").map((a) => a.how)).toEqual(["console", "wt"]);
  // A Mac or Linux app id means nothing here.
  expect(launchAttempts("win32", "kitty").map((a) => a.how)).toEqual(["wt", "console"]);
});

test("a systemd user service finds the desktop's display in the user manager", () => {
  const found = desktopFromSystemd(
    "HOME=/home/me\nDISPLAY=:0\nWAYLAND_DISPLAY=wayland-0\nPATH=/x\nXDG_RUNTIME_DIR=/run/user/1000\n",
  );
  expect(found).toEqual({
    DISPLAY: ":0",
    WAYLAND_DISPLAY: "wayland-0",
    XDG_RUNTIME_DIR: "/run/user/1000",
  });
});

test("the Windows launch script runs the agent through tappy in the project, and refuses what cmd cannot quote", () => {
  const script = launchScriptCmd(["C:\\T\\tappy.exe"], "claude", "C:\\Users\\me\\50% & more", [
    "--resume",
    "ab-1",
  ]);
  const lines = script.split("\r\n");
  expect(lines).toContain('cd /d "C:\\Users\\me\\50%% & more" || exit /b 1');
  expect(lines).toContain('"C:\\T\\tappy.exe" wrap claude "--resume" "ab-1"');
  expect(lines).toContain('(goto) 2>nul & del "%~f0" & powershell.exe -NoLogo');
  expect(() => launchScriptCmd(["C:\\t.exe"], "claude", 'C:\\a"b', [])).toThrow();
});

test("on Windows a launch writes a .cmd and opens Windows Terminal, falling back to a console window", async () => {
  const home = await root();
  const project = join(home, "app");
  await mkdir(project);
  const env = { ...WIN, TAPPY_HOME: home, HOME: home };
  const tried: Array<{ how: string; script: string }> = [];
  const result = await launchAgent({
    agent: "claude",
    cwd: project,
    env,
    tappy: ["C:\\t.exe"],
    open: async (how, _app, script) => {
      tried.push({ how, script });
      if (how === "wt") throw new Error("Windows Terminal is not installed");
    },
  });
  expect(result).toMatchObject({ ok: true, app: "a console window" });
  expect(tried.map((t) => t.how)).toEqual(["wt", "console"]);
  expect(tried[0]?.script).toMatch(/\.cmd$/);
  expect(await readFile(tried[0]?.script ?? "", "utf8")).toContain("wrap claude");
});

test("on Linux a launch remembers the emulator, and stops at once when there is no desktop at all", async () => {
  const home = await root();
  const project = join(home, "app");
  await mkdir(project);
  const env = { ...LINUX, TAPPY_HOME: home, HOME: home, SHELL: "/bin/bash" };
  await rememberTerminalApp("konsole", env);
  // A Mac bundle id is not a Linux terminal, and does not replace one.
  await rememberTerminalApp("com.apple.Terminal", env);
  const tried: string[] = [];
  const result = await launchAgent({
    agent: "codex",
    cwd: project,
    env,
    tappy: ["/t"],
    open: async (how, app, script) => {
      tried.push(app);
      expect(how).toBe("linux");
      expect(script).toMatch(/\.sh$/);
    },
  });
  expect(result).toMatchObject({ ok: true, app: "Konsole" });
  expect(tried).toEqual(["konsole"]);
});

// ── Finding the conversation ────────────────────────────────

test("on Windows Codex's conversation is the newest rollout started in this folder since the terminal opened", async () => {
  const home = await root();
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const day = join(
    home,
    "sessions",
    String(now.getFullYear()),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
  );
  await mkdir(day, { recursive: true });
  const id = "01a14981-2fb0-4c3d-8e9f-0123456789ab";
  const meta = (cwd: string, uuid: string) =>
    `${JSON.stringify({ type: "session_meta", payload: { id: uuid, cwd } })}\n`;
  const mine = join(day, `rollout-2026-10-17T11-56-05-${id}.jsonl`);
  const elsewhere = join(
    day,
    "rollout-2026-10-17T11-57-00-11111111-2222-3333-4444-555555555555.jsonl",
  );
  const older = join(day, "rollout-2026-10-17T08-00-00-66666666-7777-8888-9999-000000000000.jsonl");
  await writeFile(mine, meta("C:\\Users\\Me\\Repo", id));
  await writeFile(elsewhere, meta("C:\\Users\\Me\\Other", "x"));
  await writeFile(older, meta("C:\\Users\\Me\\Repo", "y"));
  const openedAt = Date.now() - 1000;
  const past = new Date(openedAt - 3_600_000);
  await utimes(older, past, past);

  const source = codexSource(4242, home, {
    cwd: "c:\\users\\me\\repo",
    openedAt,
    platform: "win32",
  });
  expect(await source.locate()).toEqual({ id: basenameOf(mine), path: mine, conversation: id });
  // No folder or time to go on: nothing, not a guess.
  expect(await codexSource(4242, home, undefined).locate()).toBeUndefined();
});

function basenameOf(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? path;
}

test("a Claude that keeps no sessions folder is followed by its newest transcript since the terminal opened", async () => {
  const home = await root();
  const project = join(home, "projects", "C--Users-me-repo");
  await mkdir(project, { recursive: true });
  const id = "5d1c7a0e-1111-2222-3333-444455556666";
  await writeFile(join(project, `${id}.jsonl`), "");
  const openedAt = Date.now() - 1000;
  const source = claudeSource(77, "C:\\Users\\me\\repo", home, openedAt);
  expect(await source.locate()).toMatchObject({ id, conversation: id });

  // Where Claude does keep one, a missing pid record is not a reason to guess.
  await mkdir(join(home, "sessions"));
  expect(await claudeSource(77, "C:\\Users\\me\\repo", home, openedAt).locate()).toBeUndefined();
});

// ── Real Windows ────────────────────────────────────────────

const windows = test.skipIf(process.platform !== "win32");

windows(
  "a wrapper reaches the daemon over the named pipe, and the phone's keys come back",
  async () => {
    const home = await root();
    const path = terminalSocketPath({ TAPPY_HOME: home });
    const registry = new TerminalRegistry();
    const server = await startTerminalSocket(registry, path);
    const typed: string[] = [];
    const link = keepLinked("claude", "C:\\repo", (data) => typed.push(data), 1234, path);
    try {
      await waitFor(() => registry.size === 1);
      const [terminal] = registry.list();
      expect(registry.write(terminal?.id ?? "", "hi")).toBe(true);
      await waitFor(() => typed.length === 1);
      expect(typed).toEqual(["hi"]);
    } finally {
      link.close();
      await server.stop();
    }
  },
);

windows(
  "Bun gives the agent a real console (ConPTY) on this Bun",
  async () => {
    let screen = "";
    const proc = Bun.spawn(["cmd.exe", "/d", "/c", "echo ready"], {
      terminal: {
        cols: 80,
        rows: 24,
        data: (_t, d) => void (screen += new TextDecoder().decode(d)),
      },
    });
    expect(await proc.exited).toBe(0);
    await waitFor(() => screen.includes("ready"));
    proc.terminal?.close();
  },
  20000,
);

windows(
  "the .cmd launcher runs through cmd.exe, hands over its arguments, and falls back to the real agent",
  async () => {
    const home = await root();
    const env = { ...process.env, TAPPY_HOME: home };
    // Stands in for tappy: reports what it was asked to wrap.
    const tappy = join(home, "fake-tappy.cmd");
    await writeFile(tappy, "@echo tappy %*\r\n");
    await installShellHook(env, tappy, { userPath: memoryPath() });
    const run = async (path: string) => {
      const proc = Bun.spawn(
        ["cmd.exe", "/d", "/c", join(shimDir(env), "claude.cmd"), "--resume", "abc"],
        {
          env: { ...env, PATH: path },
          stdout: "pipe",
          stdin: "ignore",
        },
      );
      return (await new Response(proc.stdout).text()).trim();
    };
    expect(await run(`${shimDir(env)};${process.env.PATH ?? ""}`)).toBe(
      "tappy wrap claude --resume abc",
    );

    // Tappy removed: the launcher steps off PATH and runs the agent itself.
    await rm(tappy);
    const real = join(home, "real");
    await mkdir(real);
    await writeFile(join(real, "claude.cmd"), "@echo real claude %*\r\n");
    await chmod(join(real, "claude.cmd"), 0o755);
    expect(await run(`${shimDir(env)};${real};${process.env.PATH ?? ""}`)).toBe(
      "real claude --resume abc",
    );
  },
  20000,
);

// ── Real Linux ──────────────────────────────────────────────

test.skipIf(process.platform !== "linux")(
  "on Linux Codex's open rollout is read from /proc, without lsof",
  async () => {
    const home = await root();
    const day = join(home, "sessions", "2026", "10", "17");
    await mkdir(day, { recursive: true });
    const id = "01a14981-2fb0-4c3d-8e9f-0123456789ab";
    const rollout = join(day, `rollout-2026-10-17T11-56-05-${id}.jsonl`);
    await writeFile(rollout, "");
    // Stands in for Codex: a process holding its conversation file open.
    const holder = Bun.spawn(["sh", "-c", `exec 3>>'${rollout}'; sleep 30`]);
    try {
      const source = codexSource(holder.pid, home, {
        cwd: "/x",
        openedAt: Date.now(),
        platform: "linux",
      });
      let found: Awaited<ReturnType<typeof source.locate>>;
      for (let i = 0; i < 50 && !found; i++) {
        found = await source.locate();
        if (!found) await Bun.sleep(50);
      }
      expect(found).toEqual({ id: basenameOf(rollout), path: rollout, conversation: id });
    } finally {
      holder.kill();
    }
  },
  20000,
);
