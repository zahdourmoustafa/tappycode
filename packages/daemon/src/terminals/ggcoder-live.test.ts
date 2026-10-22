/**
 * The daemon's half of GG Coder's live view: when the run on screen is shown,
 * and when the file takes over. Driven through the registry exactly as the
 * wrapper's status lines drive it (`socket.ts`), with GG Coder's session file
 * written by hand the way GG Coder writes it — all at once, after the run.
 */
import { afterAll, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { wire } from "@tappy/protocol";
import { Daemon } from "../index.js";
import { ggcoderProjectDir } from "./agent-mirrors.js";

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function setup() {
  const home = await mkdtemp(join(tmpdir(), "tappy-gglive-"));
  roots.push(home);
  const cwd = join(home, "proj");
  const sessions = join(home, ".gg", "sessions");
  const dir = join(sessions, ggcoderProjectDir(cwd));
  await mkdir(dir, { recursive: true });
  const daemon = new Daemon({ id: "t", name: "t" }, true, {
    TAPPY_HOME: join(home, ".tappy"),
    HOME: home,
  });
  const sent: any[] = [];
  daemon.attach((m) => sent.push(m));
  const id = daemon.terminals.register({
    agent: "ggcoder",
    cwd,
    deliver: () => true,
    since: Date.now() - 1000,
  });
  const lives = () =>
    sent.filter((m) => m.t === "terminal.live").map((m) => m.messages as wire.TerminalMessage[]);
  const file = join(dir, "s1.jsonl");
  /** What GG Coder appends when a run completes. */
  const saveRun = async (user: string, reply: string) => {
    const line = (role: string, text: string) =>
      `${JSON.stringify({ type: "message", message: { role, content: [{ type: "text", text }] } })}\n`;
    await appendFile(file, line("user", user) + line("assistant", reply));
  };
  return { daemon, id, sent, lives, saveRun, file };
}

const RUN = [
  { role: "user", text: "check it" },
  { role: "agent", text: "Starting." },
  { role: "tool", text: "Ran npm test · exit 0" },
] satisfies wire.TerminalMessage[];

test("while GG Coder works, the run on its screen reaches the phone; not when it is idle", async () => {
  const { daemon, id, lives } = await setup();
  // A screen that shows an old turn while nothing runs is not news.
  daemon.terminals.reportActivity(id, "idle");
  daemon.terminals.reportLive(id, { turn: 0, messages: RUN });
  expect(lives()).toEqual([]);
  daemon.terminals.reportActivity(id, "working");
  daemon.terminals.reportLive(id, { turn: 1, messages: RUN.slice(0, 2) });
  daemon.terminals.reportLive(id, { turn: 1, messages: RUN });
  expect(lives()).toEqual([RUN.slice(0, 2), RUN]);
  // The list says it is working, which is what the phone's status shows.
  expect(daemon.terminals.list()[0]?.activity).toBe("working");
});

test("once the file has the turn the live copy is taken down, and a later report of it stays down", async () => {
  const { daemon, id, lives, saveRun } = await setup();
  daemon.terminals.reportActivity(id, "working");
  daemon.terminals.reportLive(id, { turn: 1, messages: RUN });
  daemon.terminals.reportActivity(id, "idle");
  // Stopped but not saved yet: still shown, so nothing blinks out in between.
  expect(lives().at(-1)).toEqual(RUN);
  await saveRun("check it", "All done.");
  // The mirror polls the file once a second.
  for (let i = 0; i < 40 && lives().at(-1)?.length !== 0; i++) await Bun.sleep(100);
  expect(lives().at(-1)).toEqual([]);
  daemon.terminals.reportLive(id, { turn: 1, messages: RUN });
  expect(lives().at(-1)).toEqual([]);
  // The next run is news again.
  daemon.terminals.reportActivity(id, "working");
  daemon.terminals.reportLive(id, { turn: 2, messages: [{ role: "user", text: "and again" }] });
  expect(lives().at(-1)).toEqual([{ role: "user", text: "and again" }]);
}, 15_000);

test("a phone that connects mid-run is sent the run with everything else", async () => {
  const { daemon, id } = await setup();
  daemon.terminals.reportActivity(id, "working");
  daemon.terminals.reportLive(id, { turn: 1, messages: RUN });
  const greeting = daemon.greet({});
  expect(greeting.find((m) => m.t === "terminal.live")).toEqual({
    t: "terminal.live",
    terminalId: id,
    messages: RUN,
  });
});

test("a run that finishes notifies with its own last reply, not the previous turn's", async () => {
  const { daemon, id } = await setup();
  daemon.terminals.reportActivity(id, "working");
  daemon.terminals.reportLive(id, {
    turn: 1,
    messages: [...RUN, { role: "agent", text: "All green." }],
  });
  // What the notification would quote, read the way it reads it.
  expect(
    (daemon as unknown as { liveAgentText(id: string): string | undefined }).liveAgentText(id),
  ).toBe("All green.");
});

test("a GG Coder window opened before the screen reader still shows working and its steps, from GG Coder's log", async () => {
  const { daemon, sent } = await setup();
  const home = (daemon as unknown as { env: NodeJS.ProcessEnv }).env.HOME!;
  const log = join(home, ".gg", "debug.log");
  const cwd = join(home, "old");
  const id = daemon.terminals.register({
    agent: "ggcoder",
    cwd,
    pid: 4242,
    deliver: () => true,
    since: Date.now(),
  });
  const sid = "abcd1234";
  const line = (category: string, text: string) =>
    `[2026-10-21T13:00:00.000Z] [sid=${sid}] [INFO] [${category}] ${text}\n`;
  await appendFile(log, line("startup", "ggcoder v5.85.0 started provider=anthropic pid=4242"));
  // Give the follower its first read, then a run.
  await Bun.sleep(700);
  await appendFile(
    log,
    line("input", "User input: fix the login page") +
      line("ui", "run_start provider=anthropic messages=3") +
      line("tool", "Tool call started: read id=t1"),
  );
  const liveFor = () =>
    sent
      .filter((m) => m.t === "terminal.live" && m.terminalId === id)
      .map((m) => m.messages as wire.TerminalMessage[]);
  for (let i = 0; i < 40 && !liveFor().some((m) => m.length === 2); i++) await Bun.sleep(100);
  expect(daemon.terminals.list().find((t) => t.id === id)?.activity).toBe("working");
  expect(liveFor().at(-1)).toEqual([
    { role: "user", text: "fix the login page" },
    { role: "tool", text: "Read a file…" },
  ]);
  await appendFile(log, line("agent", "Agent done duration=900ms toolsUsed=read"));
  for (
    let i = 0;
    i < 40 && daemon.terminals.list().find((t) => t.id === id)?.activity !== "idle";
    i++
  )
    await Bun.sleep(100);
  expect(daemon.terminals.list().find((t) => t.id === id)?.activity).toBe("idle");
}, 15_000);

test("a window whose wrapper reads its own screen is never also driven by the log", async () => {
  const { daemon, id, lives } = await setup();
  daemon.terminals.reportActivity(id, "working");
  daemon.terminals.reportLive(id, { turn: 1, messages: RUN });
  (daemon as unknown as { ggcoderRun(run: unknown): void }).ggcoderRun({
    pid: daemon.terminals.links().find((l) => l.id === id)?.pid ?? -1,
    activity: "idle",
    turn: 9,
    messages: [],
  });
  expect(lives().at(-1)).toEqual(RUN);
  expect(daemon.terminals.list()[0]?.activity).toBe("working");
});
