/**
 * Typing from the phone into an agent started normally in a terminal.
 *
 * Unix socket paths are capped at 104 bytes on macOS, and the run's own temp
 * root is far down `/var/folders/…`, so the socket tests work in a short
 * directory under `/tmp` and remove it themselves.
 */
import { afterAll, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { handleMessage } from "../handler.js";
import { Daemon } from "../index.js";
import { takeLines } from "./link.js";
import { TerminalRegistry } from "./registry.js";
import {
  hookBlock,
  installShellHook,
  shimDir,
  uninstallShellHook,
  withHook,
  withoutHook,
} from "./shell-hook.js";
import {
  claudeModeWatcher,
  claudeScreenWatcher,
  findRealAgent,
  parseClaudeQuestion,
} from "./wrap.js";
import { startTerminalSocket } from "./socket.js";

const CLI = join(import.meta.dir, "..", "cli", "index.ts");
const roots: string[] = [];

/** Tests of the Unix socket, sh launchers and rc files: Windows has none of them, and has its own below. */
const posix = test.skipIf(process.platform === "win32");
/** zsh is the Mac's shell; a Linux runner may not have it. */
const withZsh = test.skipIf(process.platform === "win32" || !Bun.which("zsh"));

async function shortRoot(): Promise<string> {
  const root = await mkdtemp(process.platform === "win32" ? join(tmpdir(), "tpw-") : "/tmp/tpw-");
  roots.push(root);
  return root;
}

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("timed out");
    await Bun.sleep(20);
  }
}

// ── Registry ────────────────────────────────────────────────

test("input reaches only the terminal it is addressed to", () => {
  const got: Record<string, string[]> = { a: [], b: [] };
  const registry = new TerminalRegistry();
  const a = registry.register({
    agent: "claude",
    cwd: "/p/app",
    deliver: (d) => (got.a!.push(d), true),
  });
  registry.register({ agent: "codex", cwd: "/p/site", deliver: (d) => (got.b!.push(d), true) });

  expect(registry.write(a, "hi")).toBe(true);
  expect(got).toEqual({ a: ["hi"], b: [] });
});

test("an id the registry never minted reaches nothing", () => {
  const registry = new TerminalRegistry();
  registry.register({ agent: "claude", cwd: "/p/app", deliver: () => true });
  expect(registry.write("term_guess", "rm -rf ~\r")).toBe(false);
  expect(registry.write("", "x")).toBe(false);
});

test("a terminal whose link has gone is dropped and announced", () => {
  let changes = 0;
  const registry = new TerminalRegistry(() => changes++);
  const id = registry.register({ agent: "claude", cwd: "/p/app", deliver: () => false });
  expect(changes).toBe(1);
  expect(registry.write(id, "x")).toBe(false);
  expect(registry.size).toBe(0);
  expect(changes).toBe(2);
});

test("the list names the project by its folder, oldest first", () => {
  let now = 100;
  const registry = new TerminalRegistry(
    () => {},
    () => now++,
  );
  registry.register({ agent: "codex", cwd: "/Users/me/site", deliver: () => true });
  registry.register({ agent: "claude", cwd: "/Users/me/app", deliver: () => true });
  expect(registry.list().map(({ agent, cwd, folder }) => ({ agent, cwd, folder }))).toEqual([
    { agent: "codex", cwd: "/Users/me/site", folder: "site" },
    { agent: "claude", cwd: "/Users/me/app", folder: "app" },
  ]);
});

test("ids are not guessable counters", () => {
  const registry = new TerminalRegistry();
  const first = registry.register({ agent: "claude", cwd: "/p", deliver: () => true });
  const second = registry.register({ agent: "claude", cwd: "/p", deliver: () => true });
  expect(first).toMatch(/^term_[0-9a-f]{24}$/);
  expect(first).not.toBe(second);
});

// ── Line framing ────────────────────────────────────────────

test("lines are split across chunks and an endless line is refused", () => {
  const first = takeLines("", '{"a":1}\n{"b"');
  expect(first).toEqual({ lines: ['{"a":1}'], rest: '{"b"' });
  expect(takeLines(first!.rest, ":2}\n")).toEqual({ lines: ['{"b":2}'], rest: "" });
  expect(takeLines("", "x".repeat(70 * 1024))).toBeUndefined();
});

// ── Local socket ────────────────────────────────────────────

posix("the socket is private to this user", async () => {
  const root = await shortRoot();
  const path = join(root, "home", "terminals.sock");
  const server = await startTerminalSocket(new TerminalRegistry(), path);
  try {
    expect((await stat(join(root, "home"))).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  } finally {
    await server.stop();
  }
});

posix("a peer that does not register as a wrapper is cut off and registers nothing", async () => {
  const root = await shortRoot();
  const registry = new TerminalRegistry();
  const server = await startTerminalSocket(registry, join(root, "t.sock"));
  let closed = false;
  try {
    await Bun.connect({
      unix: server.path,
      socket: {
        open: (s) => void s.write('{"t":"register","agent":"bash","cwd":"/"}\n'),
        data: () => {},
        close: () => void (closed = true),
      },
    });
    await waitFor(() => closed);
    expect(registry.size).toBe(0);
  } finally {
    await server.stop();
  }
});

// ── Shell hook ──────────────────────────────────────────────

test("the hook is added once, replaced in place, and removed without a trace", () => {
  const rc = "export PATH=$HOME/bin:$PATH\nalias ll='ls -l'\n";
  const once = withHook(rc, "/h/.tappy/bin");
  expect(withHook(once, "/h/.tappy/bin")).toBe(once);
  expect(once.startsWith(rc.trimEnd())).toBe(true);
  expect(once.split(hookBlock("/h/.tappy/bin")).length).toBe(2);
  expect(withoutHook(once)).toBe(rc);
  expect(withHook("", "/x")).toBe(`${hookBlock("/x")}\n`);
});

withZsh(
  "the hook puts the launchers first on PATH, even when a parent shell had them further back",
  async () => {
    const script = `${hookBlock("/h/.tappy/bin")}\nprint -r -- $PATH`;
    const proc = Bun.spawn(["/bin/zsh", "-f", "-c", script], {
      env: { PATH: "/usr/local/bin:/h/.tappy/bin:/usr/bin" },
      stdout: "pipe",
    });
    expect((await new Response(proc.stdout).text()).trim()).toBe(
      "/h/.tappy/bin:/usr/local/bin:/usr/bin",
    );
    expect(await proc.exited).toBe(0);
  },
);

posix("the hook parses in bash", async () => {
  const proc = Bun.spawn(["bash", "-n", "-c", hookBlock("/h/it's here/bin")], { stderr: "pipe" });
  expect(await proc.exited).toBe(0);
});

/** A home with a real agent on PATH and the hook installed, as `tappy pair` leaves it. */
async function installedHome() {
  const home = await shortRoot();
  const realBin = join(home, "real-bin");
  await mkdir(realBin);
  await writeFile(join(realBin, "claude"), '#!/bin/sh\nprintf "real claude got: %s" "$*"\n');
  await chmod(join(realBin, "claude"), 0o755);
  // Stands in for `tappy`: proves the launcher handed over, and with what.
  const tappy = join(home, "fake-tappy");
  await writeFile(tappy, '#!/bin/sh\nprintf "tappy %s" "$*"\n');
  await chmod(tappy, 0o755);
  const rc = join(home, ".zshrc");
  await writeFile(rc, "export EDITOR=vim\n", { mode: 0o600 });
  const env = { HOME: home, SHELL: "/bin/zsh", PATH: `${realBin}:/usr/bin:/bin` };
  return { home, realBin, tappy, rc, env };
}

posix(
  "installing writes the launchers and keeps the user's file, its mode, and is idempotent",
  async () => {
    const { rc, env, tappy } = await installedHome();
    expect(await installShellHook(env, tappy)).toEqual({ file: rc, changed: true });
    expect(await installShellHook(env, tappy)).toEqual({ file: rc, changed: false });
    const written = await readFile(rc, "utf8");
    expect(written).toContain("export EDITOR=vim");
    expect(written).toContain(shimDir(env));
    expect((await stat(rc)).mode & 0o777).toBe(0o600);
    expect((await stat(join(shimDir(env), "claude"))).mode & 0o777).toBe(0o755);

    expect(await uninstallShellHook(env)).toEqual({ file: rc, changed: true });
    expect(await readFile(rc, "utf8")).toBe("export EDITOR=vim\n");
    expect(await Bun.file(join(shimDir(env), "claude")).exists()).toBe(false);
  },
);

withZsh(
  "a typed `claude` reaches tappy, flags intact, through the user's real startup file",
  async () => {
    const { home, env, tappy } = await installedHome();
    await installShellHook(env, tappy);
    const proc = Bun.spawn(["zsh", "-i", "-c", "claude --resume abc"], {
      env: { ...env, ZDOTDIR: home },
      stdout: "pipe",
    });
    expect(await new Response(proc.stdout).text()).toBe("tappy wrap claude --resume abc");
  },
);

withZsh(
  "a terminal that defines its own `claude` after the startup file still lands on tappy",
  async () => {
    // What cmux does: a `claude` function defined after .zshrc, that looks the
    // real binary up on PATH and runs it. A function of ours was replaced by it
    // and never ran; the launcher is what its lookup finds.
    const { home, env, tappy } = await installedHome();
    await installShellHook(env, tappy);
    const cmuxLike =
      'function claude { local d; for d in ${(s.:.)PATH}; do [[ -x $d/claude ]] && { "$d/claude" "$@"; return; }; done; }';
    const proc = Bun.spawn(["zsh", "-i", "-c", `${cmuxLike}\nclaude hi`], {
      env: { ...env, ZDOTDIR: home },
      stdout: "pipe",
    });
    expect(await new Response(proc.stdout).text()).toBe("tappy wrap claude hi");
  },
);

posix("tappy wrap runs the real agent, never a launcher of ours or cmux's", async () => {
  const { home, realBin, env, tappy } = await installedHome();
  await installShellHook(env, tappy);
  const cmuxShims = join(home, ".cmuxterm", "cmux-cli-shims", "SURFACE");
  await mkdir(cmuxShims, { recursive: true });
  await writeFile(join(cmuxShims, "claude"), "#!/bin/sh\nexit 99\n");
  await chmod(join(cmuxShims, "claude"), 0o755);
  const path = `${cmuxShims}:${shimDir(env)}:${realBin}:/usr/bin`;
  expect(findRealAgent("claude", { ...env, PATH: path })).toBe(join(realBin, "claude"));
  expect(findRealAgent("codex", { ...env, PATH: path })).toBeUndefined();
});

posix("with tappy gone, the launcher still runs the real agent", async () => {
  const { env } = await installedHome();
  await installShellHook(env, "/nonexistent/tappy");
  const proc = Bun.spawn([join(shimDir(env), "claude"), "--version"], {
    env: { ...env, PATH: `${shimDir(env)}:${env.PATH}` },
    stdout: "pipe",
  });
  expect(await new Response(proc.stdout).text()).toBe("real claude got: --version");
});

posix("a shell the hook is not written for is left alone", async () => {
  expect(
    await installShellHook({ HOME: "/nonexistent", SHELL: "/usr/local/bin/nu" }, "/t"),
  ).toEqual({
    changed: false,
  });
});

// ── Handler ─────────────────────────────────────────────────

async function send(daemon: Daemon, message: unknown, deviceId?: string) {
  const out: any[] = [];
  await handleMessage(JSON.stringify(message), {
    daemon,
    deviceId,
    reply: (m) => out.push(m),
    broadcast: (m) => out.push(m),
  });
  return out;
}

async function daemonWithTerminal() {
  const daemon = new Daemon({ id: "test", name: "test" }, true, { TAPPY_HOME: await shortRoot() });
  const typed: string[] = [];
  const id = daemon.terminals.register({
    agent: "claude",
    cwd: "/p/app",
    deliver: (d) => (typed.push(d), true),
  });
  return { daemon, id, typed };
}

test("a proved device types into a terminal", async () => {
  const { daemon, id, typed } = await daemonWithTerminal();
  const out = await send(daemon, { t: "terminal.input", terminalId: id, data: "a" }, "phone-1");
  expect(typed).toEqual(["a"]);
  expect(out).toEqual([]);
});

test("a sender that has not proved itself cannot type", async () => {
  const { daemon, id, typed } = await daemonWithTerminal();
  const out = await send(daemon, { t: "terminal.input", terminalId: id, data: "a" });
  expect(typed).toEqual([]);
  expect(out[0]).toMatchObject({ t: "error", code: "terminal_unidentified" });
});

test("typing into a terminal that has closed says so and refreshes the list", async () => {
  const { daemon } = await daemonWithTerminal();
  const out = await send(
    daemon,
    { t: "terminal.input", terminalId: "term_gone", data: "a" },
    "phone-1",
  );
  expect(out[0]).toMatchObject({ t: "error", code: "terminal_gone" });
  expect(out[1]).toMatchObject({ t: "terminals" });
  expect(out[1].terminals).toHaveLength(1);
});

test("an oversized frame is refused at the schema", async () => {
  const { daemon, id, typed } = await daemonWithTerminal();
  const out = await send(
    daemon,
    { t: "terminal.input", terminalId: id, data: "x".repeat(4097) },
    "phone-1",
  );
  expect(typed).toEqual([]);
  expect(out[0]).toMatchObject({ t: "error", code: "bad_message" });
});

test("a phone that connects is told which terminals exist, on either transport", async () => {
  // Both transports answer `hello` themselves and send `greet()`; the list
  // used to live in the handler's `hello` case, which neither of them reaches.
  const { daemon } = await daemonWithTerminal();
  const frames = daemon.greet({});
  expect(frames.at(-1)).toMatchObject({
    t: "terminals",
    terminals: [expect.objectContaining({ agent: "claude", cwd: "/p/app", folder: "app" })],
  });
  const source = (file: string) => Bun.file(join(import.meta.dir, "..", file)).text();
  for (const transport of ["server.ts", "relay-client.ts"]) {
    expect(await source(transport)).toContain(".greet(wire.readCursors(hello.cursors))");
  }
});

test("every client hears when a terminal opens or closes", async () => {
  const daemon = new Daemon({ id: "test", name: "test" }, true, { TAPPY_HOME: await shortRoot() });
  const sent: any[] = [];
  daemon.attach((m) => sent.push(m));
  const id = daemon.terminals.register({ agent: "codex", cwd: "/p/site", deliver: () => true });
  daemon.terminals.remove(id);
  expect(sent.map((m) => [m.t, m.terminals.length])).toEqual([
    ["terminals", 1],
    ["terminals", 0],
  ]);
  daemon.closeAll();
});

// ── The wrapper, for real ───────────────────────────────────

/**
 * A stand-in agent named `claude`: reads one line and records it.
 *
 * Every test that runs the wrapper gives it a PATH of only this directory and
 * the system ones. With the user's own PATH, a stand-in the wrapper does not
 * find falls through to their real `claude` — and a failing test then types
 * into a real Claude Code session. It did, once.
 */
async function fakeAgent(root: string, out: string): Promise<string> {
  // Not `bin`: these tests set TAPPY_HOME to `root`, and `root/bin` is where
  // tappy keeps its own launchers — which the wrapper rightly skips.
  const bin = join(root, "agent-bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "claude"),
    `#!/bin/sh\nIFS= read -r line\nprintf '%s' "$line" > '${out}'\nexit 3\n`,
  );
  await chmod(join(bin, "claude"), 0o755);
  return bin;
}

posix(
  "keystrokes from the phone land in an agent typed normally in a terminal",
  async () => {
    const root = await shortRoot();
    const out = join(root, "typed.txt");
    const bin = await fakeAgent(root, out);
    const registry = new TerminalRegistry();
    const server = await startTerminalSocket(registry, join(root, "terminals.sock"));
    let screen = "";
    try {
      // Run inside a PTY, as a person's terminal would, so the wrapper takes its
      // interactive path rather than the plain passthrough.
      const proc = Bun.spawn([process.execPath, CLI, "wrap", "claude"], {
        cwd: root,
        env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, TAPPY_HOME: root, TAPPY_WRAPPED: "" },
        terminal: {
          cols: 80,
          rows: 24,
          data: (_t, d) => void (screen += new TextDecoder().decode(d)),
        },
      });

      await waitFor(() => registry.size === 1);
      const [terminal] = registry.list();
      expect(terminal).toMatchObject({ agent: "claude", folder: basename(root) });
      // The agent's own pid, which is how its conversation is found for the phone.
      expect(registry.links()[0]?.pid).toBeGreaterThan(0);

      // One keystroke at a time, the way the phone sends them.
      for (const key of ["h", "i", " ", "x", "\x7f", "t", "h", "e", "r", "e", "\r"]) {
        expect(registry.write(terminal!.id, key)).toBe(true);
      }

      // The agent's own exit code comes back, and its terminal disappears.
      expect(await proc.exited).toBe(3);
      expect(await readFile(out, "utf8")).toBe("hi there");
      await waitFor(() => registry.size === 0);
      // The typing showed on the laptop's screen as it happened, the mistyped
      // "x" included — and then visibly rubbed out by the backspace.
      expect(screen).toContain("hi x\b \bthere");
      proc.terminal?.close();
    } finally {
      await server.stop();
    }
  },
  20000,
);

posix(
  "without a terminal the wrapper is a plain passthrough and registers nothing",
  async () => {
    const root = await shortRoot();
    const out = join(root, "typed.txt");
    const bin = await fakeAgent(root, out);
    const registry = new TerminalRegistry();
    const server = await startTerminalSocket(registry, join(root, "terminals.sock"));
    try {
      const proc = Bun.spawn([process.execPath, CLI, "wrap", "claude"], {
        cwd: root,
        env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, TAPPY_HOME: root, TAPPY_WRAPPED: "" },
        stdin: new Blob(["piped line\n"]),
        stdout: "pipe",
      });
      expect(await proc.exited).toBe(3);
      expect(await readFile(out, "utf8")).toBe("piped line");
      expect(registry.size).toBe(0);
    } finally {
      await server.stop();
    }
  },
  20000,
);

posix(
  "with no daemon running the agent still runs normally",
  async () => {
    const root = await shortRoot();
    const out = join(root, "typed.txt");
    const bin = await fakeAgent(root, out);
    const proc = Bun.spawn([process.execPath, CLI, "wrap", "claude"], {
      cwd: root,
      env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, TAPPY_HOME: root, TAPPY_WRAPPED: "" },
      terminal: { cols: 80, rows: 24 },
    });
    await Bun.sleep(300);
    proc.terminal!.write("still works\r");
    expect(await proc.exited).toBe(3);
    expect(await readFile(out, "utf8")).toBe("still works");
    proc.terminal?.close();
  },
  20000,
);

posix(
  "the agent's own flags reach the agent, not tappy",
  async () => {
    // `claude --version` printed tappy's version: the CLI read `--version` as its
    // own flag before ever reaching `wrap`.
    const root = await shortRoot();
    const bin = join(root, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "claude"), `#!/bin/sh\nprintf 'agent got: %s' "$*"\n`);
    await chmod(join(bin, "claude"), 0o755);
    const proc = Bun.spawn([process.execPath, CLI, "wrap", "claude", "--version", "--json"], {
      env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, TAPPY_WRAPPED: "" },
      stdin: "ignore",
      stdout: "pipe",
    });
    expect(await new Response(proc.stdout).text()).toBe("agent got: --version --json");
    expect(await proc.exited).toBe(0);
  },
  20000,
);

test("only the agents tappy knows can be wrapped", async () => {
  const proc = Bun.spawn([process.execPath, CLI, "wrap", "bash"], { stderr: "pipe" });
  expect(await proc.exited).toBe(2);
  expect(await new Response(proc.stderr).text()).toContain("not an agent tappy can wrap");
});

test("a project an agent is open in, in a terminal, is a project the phone may pick", async () => {
  // The phone follows a terminal into its project and asks about it; refusing
  // left the composer saying "Unknown project" beside a window open in it.
  const { daemon } = await daemonWithTerminal();
  expect(await daemon.knownProject("claude-code", "/p/app")).toBe("/p/app");
  // Only the exact path a terminal is in: not its parent, not a sibling.
  expect(await daemon.knownProject("claude-code", "/p")).toBeUndefined();
  expect(await daemon.knownProject("claude-code", "/p/other")).toBeUndefined();
});

// ── Claude's mode, read off its screen ──────────────────────

test("Claude's mode is read off its status line, the newest one winning", () => {
  const seen: string[] = [];
  const watch = claudeModeWatcher((mode) => seen.push(mode));
  const bytes = (text: string) => new TextEncoder().encode(text);
  watch(bytes("\x1b[2K\x1b[38;5;214m  ⏵⏵ auto mode on\x1b[39m (shift+tab to cycle)"));
  // Split mid-phrase, the way a PTY delivers it.
  watch(bytes("\x1b[2K  ⏸ plan mo"));
  watch(bytes("de on (shift+tab to cycle)"));
  watch(bytes("\x1b[2K  ⏵⏵ accept edits on (shift+tab to cycle)"));
  watch(bytes("\x1b[2K  ⏸ manual mode on · ? for shortcuts"));
  // Redrawing the same status says nothing new.
  watch(bytes("\x1b[2K  ⏸ manual mode on · ? for shortcuts"));
  expect(seen).toEqual(["auto", "plan", "acceptEdits", "default"]);
});

posix(
  "a wrapper's mode report reaches the phone's terminal list, and nothing else is accepted after registering",
  async () => {
    const root = await shortRoot();
    let changes = 0;
    const registry = new TerminalRegistry(() => changes++);
    const server = await startTerminalSocket(registry, join(root, "t.sock"));
    let closed = false;
    try {
      const socket = await Bun.connect({
        unix: server.path,
        socket: { data: () => {}, close: () => void (closed = true) },
      });
      socket.write('{"t":"register","agent":"claude","cwd":"/p/app","pid":4242}\n');
      await waitFor(() => registry.size === 1);
      socket.write('{"t":"status","mode":"plan"}\n');
      await waitFor(() => registry.list()[0]?.mode === "plan");
      // The same mode again is not a change worth announcing.
      const before = changes;
      socket.write('{"t":"status","mode":"plan"}\n');
      await Bun.sleep(50);
      expect(changes).toBe(before);
      // Only a known mode: anything else ends the connection.
      socket.write('{"t":"status","mode":"rm -rf"}\n');
      await waitFor(() => closed);
      expect(registry.size).toBe(0);
    } finally {
      await server.stop();
    }
  },
);

test("a terminal keeps the time it really started, across a daemon restart", () => {
  const now = 1_000_000_000_000;
  const registry = new TerminalRegistry(
    () => {},
    () => now,
  );
  const old = registry.register({
    agent: "claude",
    cwd: "/p/a",
    since: now - 3_600_000,
    deliver: () => true,
  });
  const fresh = registry.register({ agent: "claude", cwd: "/p/b", deliver: () => true });
  // A start time in the future, or absurdly old, is not believed.
  const future = registry.register({
    agent: "claude",
    cwd: "/p/c",
    since: now + 60_000,
    deliver: () => true,
  });
  const byId = Object.fromEntries(registry.list().map((t) => [t.id, t.startedAt]));
  expect(byId[old]).toBe(now - 3_600_000);
  expect(byId[fresh]).toBe(now);
  expect(byId[future]).toBe(now);
});

test("Claude's trust question is seen on its screen, and is over once its status line returns", () => {
  const prompts: Array<string | null> = [];
  const modes: string[] = [];
  const watch = claudeScreenWatcher(
    (mode) => modes.push(mode),
    (prompt) => prompts.push(prompt),
  );
  const bytes = (text: string) => new TextEncoder().encode(text);
  // As Claude Code 2.1 draws it in a folder it has not opened before.
  watch(bytes(" Quick safety check: Is this a project you created or one you trust?\r\n"));
  watch(bytes(" \x1b[36m❯\x1b[39m No, exit\r\n   Yes, I trust "));
  watch(bytes("this folder\r\n Enter to confirm · Esc to cancel"));
  expect(prompts).toEqual(["trust"]);
  // Answered: the normal screen, with its status line, takes over.
  watch(bytes("\x1b[2J\x1b[H ❯ \r\n  ⏵⏵ auto mode on (shift+tab to cycle)"));
  expect(prompts).toEqual(["trust", null]);
  expect(modes).toEqual(["auto"]);
});

posix("a wrapper reports the trust question, and its answer, to the phone's list", async () => {
  const root = await shortRoot();
  const registry = new TerminalRegistry();
  const server = await startTerminalSocket(registry, join(root, "t.sock"));
  try {
    const socket = await Bun.connect({ unix: server.path, socket: { data: () => {} } });
    socket.write('{"t":"register","agent":"claude","cwd":"/p/new"}\n');
    await waitFor(() => registry.size === 1);
    socket.write('{"t":"status","prompt":"trust"}\n');
    await waitFor(() => registry.list()[0]?.prompt === "trust");
    socket.write('{"t":"status","mode":"auto","prompt":null}\n');
    await waitFor(() => registry.list()[0]?.mode === "auto");
    expect(registry.list()[0]?.prompt).toBeUndefined();
    socket.end();
  } finally {
    await server.stop();
  }
});

// ── A question on Claude's screen, answered from the phone ──

const FIXTURE = join(import.meta.dir, "fixtures", "claude-permission-prompt.ansi");

test("a real Claude permission prompt is read as its question and numbered answers", async () => {
  // Recorded from Claude Code 2.1 in a PTY: manual mode, asked to write a file.
  const watch: Array<unknown> = [];
  const watcher = claudeScreenWatcher(
    () => {},
    () => {},
    (question) => watch.push(question),
  );
  const bytes = new Uint8Array(await Bun.file(FIXTURE).arrayBuffer());
  // Fed in small pieces, the way a PTY delivers it.
  for (let i = 0; i < bytes.length; i += 97) watcher(bytes.subarray(i, i + 97));
  expect(watch.at(-1)).toEqual({
    text: "Do you want to create hello.txt?",
    options: [
      { key: "1", label: "Yes" },
      {
        key: "2",
        label:
          "Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session",
      },
      { key: "3", label: "No" },
    ],
  });
});

test("a question is over once Claude's normal screen is drawn after it", () => {
  const seen: Array<unknown> = [];
  const watcher = claudeScreenWatcher(
    () => {},
    () => {},
    (question) => seen.push(question),
  );
  const bytes = (text: string) => new TextEncoder().encode(text);
  watcher(bytes("\r Do you want to proceed?\r ❯ 1. Yes\r 2. No\r Esc to cancel · Tab to amend\r"));
  watcher(bytes("\x1b[2J\x1b[H❯ \r  ⏸ manual mode on · ? for shortcuts"));
  expect(seen).toEqual([
    {
      text: "Do you want to proceed?",
      options: [
        { key: "1", label: "Yes" },
        { key: "2", label: "No" },
      ],
    },
    null,
  ]);
});

test("a question without numbered answers, or a stray question mark, is not a question", () => {
  expect(
    parseClaudeQuestion(
      "\r Is this a project you trust?\r ❯ No, exit\r Yes, I trust this folder\r",
    ),
  ).toBeUndefined();
  expect(parseClaudeQuestion("\r ⏸ manual mode on · ? for shortcuts\r")).toBeUndefined();
  // Only the newest question counts: one further up was already answered.
  expect(
    parseClaudeQuestion("\r Old?\r 1. A\r 2. B\r Esc to cancel\r New question?\r just text\r")
      ?.question,
  ).toBeUndefined();
});

test("the phone sees a question only while the agent itself says it is waiting", () => {
  const registry = new TerminalRegistry();
  const id = registry.register({ agent: "claude", cwd: "/p/app", deliver: () => true });
  const question = {
    text: "Do you want to proceed?",
    options: [
      { key: "1", label: "Yes" },
      { key: "2", label: "No" },
    ],
  };
  registry.setQuestion(id, question);
  expect(registry.list()[0]?.question).toBeUndefined();
  expect(registry.setActivity(id, "waiting")).toBeUndefined();
  expect(registry.list()[0]).toMatchObject({ activity: "waiting", question });
  // Answered: the agent goes back to work, and the question goes with it.
  expect(registry.setActivity(id, "working")).toBe("waiting");
  expect(registry.list()[0]?.question).toBeUndefined();
});

posix(
  "a compiled tappy also gets a `tappy` launcher on the same PATH, removed with the rest",
  async () => {
    const root = await shortRoot();
    const env = { HOME: root, TAPPY_HOME: join(root, ".tappy"), SHELL: "/bin/zsh" };
    const binary = join(root, "Tappy Install", "tappy");
    await installShellHook(env, binary, {}, true);
    const launcher = join(shimDir(env), "tappy");
    const script = await readFile(launcher, "utf8");
    expect(script).toContain(`exec '${binary}' "$@"`);
    // It actually runs whatever tappy is, with its arguments.
    await mkdir(dirname(binary), { recursive: true });
    await writeFile(binary, `#!/bin/sh\nprintf 'tappy got: %s' "$*"\n`);
    await chmod(binary, 0o755);
    const run = Bun.spawnSync([launcher, "pair", "--json"]);
    expect(run.stdout.toString()).toBe("tappy got: pair --json");
    await uninstallShellHook(env);
    expect(await Bun.file(launcher).exists()).toBe(false);
  },
);
