/**
 * Opening an agent in a terminal on the computer, from the phone. The window
 * itself is stubbed: what is checked is what would be opened, where, and that
 * nothing the phone sends ever becomes a command of its own.
 */
import { afterAll, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleMessage } from "../handler.js";
import { Daemon } from "../index.js";
import {
  agentArgs,
  DEFAULT_TERMINAL,
  launchAgent,
  launchScript,
  rememberTerminalApp,
  tappyCommand,
} from "./launch.js";

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});
async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tappy-launch-"));
  roots.push(dir);
  return dir;
}

test("each agent is resumed and given its skip-permissions switch its own way", () => {
  expect(agentArgs("claude", "4f9c-aa", true)).toEqual([
    "--resume",
    "4f9c-aa",
    "--dangerously-skip-permissions",
  ]);
  expect(agentArgs("claude", undefined, false)).toEqual([]);
  expect(agentArgs("codex", "01a14981-2fb0", true)).toEqual([
    "resume",
    "01a14981-2fb0",
    "--dangerously-bypass-approvals-and-sandbox",
  ]);
  expect(agentArgs("ggcoder", "3225647e", false)).toEqual(["--resume", "3225647e"]);
  // GG Coder has no such switch, so the combination is refused, not ignored.
  expect(agentArgs("ggcoder", undefined, true)).toBeUndefined();
});

test.skipIf(process.platform === "win32")(
  "the script runs the agent through tappy in the project, quoted, and deletes itself",
  async () => {
    // Run for real, with a stand-in tappy that reports where it ran and with what:
    // quoting is proved by what the program receives, not by the text.
    const home = await root();
    const project = join(home, 'it\'s a "project" $HOME');
    await mkdir(project);
    const tappy = join(home, "tappy");
    await Bun.write(tappy, '#!/bin/sh\nprintf "%s|" "$PWD" "$@" > "$TAPPY_OUT"\n');
    await chmod(tappy, 0o755);
    const scriptPath = join(home, "go.command");
    await Bun.write(
      scriptPath,
      launchScript([tappy], "claude", project, ["--resume", "a b;c"], "/bin/sh"),
    );
    await chmod(scriptPath, 0o700);
    const out = join(home, "out");
    const proc = Bun.spawn([scriptPath], {
      env: { PATH: "/usr/bin:/bin", HOME: home, TAPPY_OUT: out },
      stdin: "ignore",
    });
    await proc.exited;
    // `$PWD` is the folder exactly as the script was given it (launchAgent hands it the
    // resolved one); the quotes and `$HOME` in its name, and `a b;c`, all arrive untouched.
    expect(await readFile(out, "utf8")).toBe(`${project}|wrap|claude|--resume|a b;c|`);
    expect(await Bun.file(scriptPath).exists()).toBe(false);
  },
);

test("tappy is run as itself: the binary when released, bun plus the CLI from a checkout", () => {
  const command = tappyCommand();
  // These tests run from a checkout, never a compiled binary.
  expect(command).toEqual([process.execPath, expect.stringMatching(/\/cli\/index\.ts$/)]);
});

test("it opens in the terminal app this person last ran an agent in", async () => {
  const home = await root();
  const project = join(home, "app");
  await mkdir(project);
  // The Mac's rules, wherever the suite runs; Linux and Windows have their own tests.
  const env = { HOME: home, TAPPY_HOME: home, SHELL: "/bin/zsh", TAPPY_FAKE_PLATFORM: "darwin" };
  const opened: Array<{ how: string; app: string }> = [];
  const open = async (how: string, app: string) => void opened.push({ how, app });

  // Nothing known yet: the Mac's own terminal.
  expect(
    await launchAgent({ agent: "claude", cwd: project, env, open, tappy: ["/t"] }),
  ).toMatchObject({
    ok: true,
    app: "Terminal",
  });
  expect(opened.at(-1)).toEqual({ how: "open", app: DEFAULT_TERMINAL });

  await rememberTerminalApp("com.cmuxterm.app", env);
  expect(
    await launchAgent({ agent: "claude", cwd: project, env, open, tappy: ["/t"] }),
  ).toMatchObject({ app: "cmux" });
  expect(opened.at(-1)).toEqual({ how: "cmux", app: "com.cmuxterm.app" });

  // An app tappy cannot drive is never remembered over a good one.
  await rememberTerminalApp("com.example.unknown", env);
  expect((await readFile(join(home, "terminal-app"), "utf8")).trim()).toBe("com.cmuxterm.app");
});

test("if that app cannot be reached, the Mac's own terminal is used instead", async () => {
  const home = await root();
  const project = join(home, "app");
  await mkdir(project);
  const env = { HOME: home, TAPPY_HOME: home, TAPPY_FAKE_PLATFORM: "darwin" };
  await rememberTerminalApp("com.mitchellh.ghostty", env);
  const tried: string[] = [];
  const result = await launchAgent({
    agent: "codex",
    cwd: project,
    env,
    tappy: ["/t"],
    open: async (_how, app) => {
      tried.push(app);
      if (app !== DEFAULT_TERMINAL) throw new Error("not running");
    },
  });
  expect(tried).toEqual(["com.mitchellh.ghostty", DEFAULT_TERMINAL]);
  expect(result).toMatchObject({ ok: true, app: "Terminal" });
});

test("a project that is gone, or a switch the agent lacks, fails with a reason and opens nothing", async () => {
  const home = await root();
  let opened = 0;
  const open = async () => void opened++;
  const env = { HOME: home, TAPPY_HOME: home };
  const gone = await launchAgent({ agent: "claude", cwd: join(home, "nope"), env, open });
  expect(gone.ok).toBe(false);
  expect(gone.message).toContain("not on the computer");
  const project = join(home, "app");
  await mkdir(project);
  const noSwitch = await launchAgent({ agent: "ggcoder", cwd: project, bypass: true, env, open });
  expect(noSwitch.ok).toBe(false);
  expect(opened).toBe(0);
});

test.skipIf(process.platform === "win32")(
  "launch scripts live in a private folder, and a failed launch leaves none behind",
  async () => {
    const home = await root();
    const project = join(home, "app");
    await mkdir(project);
    const env = { HOME: home, TAPPY_HOME: home };
    const result = await launchAgent({
      agent: "claude",
      cwd: project,
      env,
      tappy: ["/t"],
      open: async () => {
        throw new Error("no terminal at all");
      },
    });
    expect(result.ok).toBe(false);
    expect((await stat(join(home, "launch"))).mode & 0o777).toBe(0o700);
    expect(await readdir(join(home, "launch"))).toEqual([]);
  },
);

// ── Through the daemon ──────────────────────────────────────

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

test("the phone can only open a project the computer has already offered", async () => {
  const home = await root();
  const daemon = new Daemon({ id: "test", name: "test" }, true, { HOME: home, TAPPY_HOME: home });
  const out = await send(daemon, { t: "terminal.launch", agent: "claude", cwd: "/etc" }, "phone-1");
  expect(out).toEqual([
    expect.objectContaining({
      t: "terminal.launched",
      ok: false,
      message: expect.stringContaining("isn't one this computer has offered"),
    }),
  ]);
  daemon.closeAll();
});

test("an unproved sender cannot open anything", async () => {
  const home = await root();
  const daemon = new Daemon({ id: "test", name: "test" }, true, { HOME: home, TAPPY_HOME: home });
  const out = await send(daemon, { t: "terminal.launch", agent: "claude", cwd: home });
  expect(out[0]).toMatchObject({ t: "terminal.launched", ok: false });
  daemon.closeAll();
});

test("a conversation id that is not an agent's shape is refused at the schema", async () => {
  const home = await root();
  const daemon = new Daemon({ id: "test", name: "test" }, true, { HOME: home, TAPPY_HOME: home });
  const out = await send(
    daemon,
    { t: "terminal.launch", agent: "claude", cwd: home, resume: "x; rm -rf ~" },
    "phone-1",
  );
  expect(out.some((m) => m.t === "terminal.launched" && m.ok)).toBe(false);
  expect(out[0]?.t).toBe("error");
  daemon.closeAll();
});

test("a conversation already open in a terminal is not opened a second time", async () => {
  const home = await root();
  const daemon = new Daemon({ id: "test", name: "test" }, true, { HOME: home, TAPPY_HOME: home });
  const id = daemon.terminals.register({ agent: "claude", cwd: home, deliver: () => true });
  daemon.terminals.setConversation(id, "988264dc-2604-44a1-8361-579c667aa36c");
  const out = await send(
    daemon,
    {
      t: "terminal.launch",
      agent: "claude",
      cwd: home,
      resume: "988264dc-2604-44a1-8361-579c667aa36c",
    },
    "phone-1",
  );
  expect(out[0]).toMatchObject({
    t: "terminal.launched",
    ok: false,
    message: expect.stringContaining("already open"),
  });
  daemon.closeAll();
});
