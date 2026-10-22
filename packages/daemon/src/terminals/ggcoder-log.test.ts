/**
 * GG Coder's debug log, read the way the daemon follows it. The lines are real
 * GG Coder 5.85 lines, from one window and one other interleaved with it.
 */
import { afterAll, expect, test } from "bun:test";
import { appendFile, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GgcoderLog, GgcoderLogState, type LogRun } from "./ggcoder-log.js";

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const A = "d88098f6";
const B = "4918dff6";
const at = (n: number) => `[2026-10-21T13:${String(38 + n).padStart(2, "0")}:00.000Z]`;
const lines = {
  startA: `${at(0)} [sid=${A}] [INFO] [startup] ggcoder v5.85.0 started provider=anthropic model=claude-opus-5-5 thinking=medium pid=1976`,
  startB: `${at(0)} [sid=${B}] [INFO] [startup] ggcoder v5.84.2 started provider=anthropic model=claude-opus-5-5 thinking=high pid=1363`,
  inputA: `${at(1)} [sid=${A}] [INFO] [input] User input: okay so listen to me for noww i have the mac okay , and my android phone is everything is workign as...`,
  runA: `${at(1)} [sid=${A}] [INFO] [ui] run_start provider=anthropic model=claude-opus-5-5 thinking=on messages=171`,
  toolA: `${at(1)} [sid=${A}] [INFO] [tool] Tool call started: bash id=toolu_01Sp1AVsPkuoFJdABBhaPyXK`,
  readA: `${at(1)} [sid=${A}] [INFO] [tool] Tool call started: read id=toolu_01Sp1AVsPkuoFJdABBhaPyXL`,
  toolB: `${at(1)} [sid=${B}] [INFO] [tool] Tool call started: grep id=toolu_013MagpH53XNQdH3o15qMjLg`,
  doneA: `${at(2)} [sid=${A}] [INFO] [agent] Agent done duration=21123ms toolsUsed=bash`,
};

test("a run is told from the log: its message, each step as it starts, and when it ends", () => {
  const state = new GgcoderLogState();
  state.apply(lines.startA);
  expect(state.run(A)).toEqual({ pid: 1976, activity: "idle", turn: 0, messages: [] });
  state.apply(lines.inputA);
  expect(state.apply(lines.runA)).toBe(A);
  expect(state.run(A)).toEqual({
    pid: 1976,
    activity: "working",
    turn: 1,
    messages: [
      {
        role: "user",
        text: "okay so listen to me for noww i have the mac okay , and my android phone is everything is workign as…",
      },
    ],
  });
  state.apply(lines.toolA);
  expect(state.run(A)?.messages.slice(1)).toEqual([{ role: "tool", text: "Run a command…" }]);
  state.apply(lines.readA);
  state.apply(lines.toolA);
  state.apply(lines.toolA);
  // Repeats are counted, not listed: the log has no arguments to tell them apart.
  expect(state.run(A)?.messages.slice(1)).toEqual([
    { role: "tool", text: "Run a command · 3 times…" },
    { role: "tool", text: "Read a file" },
  ]);
  expect(state.apply(lines.doneA)).toBe(A);
  expect(state.run(A)?.activity).toBe("idle");
  expect(state.run(A)?.messages.slice(1)).toEqual([
    { role: "tool", text: "Run a command · 3 times" },
    { role: "tool", text: "Read a file" },
  ]);
});

test("two windows interleaved in one log stay apart, and an instance with no known process is never reported", () => {
  const state = new GgcoderLogState();
  for (const line of [lines.startA, lines.inputA, lines.runA, lines.toolB, lines.toolA])
    state.apply(line);
  // B's startup line is not in this log (it rotated away): nothing to report it under.
  expect(state.run(B)).toBeUndefined();
  expect(state.runs().map((r) => r.pid)).toEqual([1976]);
  expect(state.run(A)?.messages.map((m) => m.role)).toEqual(["user", "tool"]);
  // Anything that is not a GG Coder log line is ignored.
  expect(state.apply("not a log line")).toBeUndefined();
});

test("a message typed while it works belongs to the next run, not this one", () => {
  const state = new GgcoderLogState();
  state.apply(lines.startA);
  state.apply(lines.runA);
  state.apply(`${at(1)} [sid=${A}] [INFO] [input] User input: and then this`);
  expect(state.run(A)?.messages).toEqual([]);
  state.apply(lines.doneA);
  state.apply(lines.runA);
  expect(state.run(A)?.messages).toEqual([{ role: "user", text: "and then this" }]);
  expect(state.run(A)?.turn).toBe(2);
});

test("the follower reports runs as lines are appended, and survives the log rotating", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tappy-gglog-"));
  roots.push(dir);
  const path = join(dir, "debug.log");
  // B started before the last rotation: only the rotated file names its process.
  await writeFile(`${path}.1`, `${lines.startB}\n`);
  await writeFile(path, `${lines.startA}\n`);
  const reports: LogRun[] = [];
  const log = new GgcoderLog(path, (run) => reports.push(run), 20);
  await log.begin();
  // On start, every known process is reported once, idle.
  expect(reports.map((r) => [r.pid, r.activity]).sort()).toEqual([
    [1363, "idle"],
    [1976, "idle"],
  ]);
  reports.length = 0;

  await appendFile(path, `${lines.inputA}\n${lines.runA}\n${lines.toolA}\n`);
  for (let i = 0; i < 50 && !reports.some((r) => r.messages.length === 2); i++) await Bun.sleep(20);
  expect(reports.at(-1)).toMatchObject({ pid: 1976, activity: "working", turn: 1 });

  // GG Coder rotates: the old file moves aside and a fresh one starts.
  await rename(path, `${path}.1`);
  await writeFile(path, `${lines.toolB}\n${lines.doneA}\n`);
  for (let i = 0; i < 50 && reports.at(-1)?.activity !== "idle"; i++) await Bun.sleep(20);
  expect(reports.at(-1)).toMatchObject({ pid: 1976, activity: "idle" });
  log.stop();
});
