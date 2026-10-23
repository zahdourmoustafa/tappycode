import { expect, test } from "bun:test";
import { mkdtemp, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AppWindow } from "./client.js";
import { openInAppWindow, pickWindow, stopReason, toolTitle, translateEvent } from "./bridge.js";

test("streamed text and thinking become ACP chunks", () => {
  expect(translateEvent({ type: "text_delta", data: { text: "Hi" } })).toEqual({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "Hi" },
  });
  expect(translateEvent({ type: "thinking_delta", data: { text: "hmm" } })).toEqual({
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text: "hmm" },
  });
  expect(translateEvent({ type: "text_delta", data: { text: "" } })).toBeUndefined();
});

test("tool calls open in progress and close with their outcome", () => {
  expect(
    translateEvent({
      type: "tool_call_start",
      data: { toolCallId: "t1", name: "read", args: { file_path: "src/a.ts" } },
    }),
  ).toEqual({
    sessionUpdate: "tool_call",
    toolCallId: "t1",
    title: "read(src/a.ts)",
    kind: "read",
    status: "in_progress",
    rawInput: { file_path: "src/a.ts" },
  });
  expect(
    translateEvent({ type: "tool_call_end", data: { toolCallId: "t1", result: "boom", isError: true } }),
  ).toEqual({
    sessionUpdate: "tool_call_update",
    toolCallId: "t1",
    status: "failed",
    content: [{ type: "content", content: { type: "text", text: "boom" } }],
  });
  expect(translateEvent({ type: "tool_call_start", data: { name: "read" } })).toBeUndefined();
});

test("a prompt typed in the window reaches the phone, tappy's own does not echo", () => {
  expect(translateEvent({ type: "prompt_sent", data: { text: "fix it", origin: "window" } })).toEqual({
    sessionUpdate: "user_message_chunk",
    content: { type: "text", text: "fix it" },
  });
  expect(translateEvent({ type: "prompt_sent", data: { text: "fix it", origin: "tappy" } })).toBeUndefined();
});

test("events with no tappy row are dropped", () => {
  expect(translateEvent({ type: "trophies", data: {} })).toBeUndefined();
  expect(translateEvent({ type: "run_start", data: {} })).toBeUndefined();
});

test("run_end maps to the ACP stop reason", () => {
  expect(stopReason({})).toBe("end_turn");
  expect(stopReason({ cancelled: true })).toBe("cancelled");
  expect(stopReason({ failed: true })).toBe("refusal");
});

test("tool titles use the first string argument, clipped for a phone", () => {
  expect(toolTitle("bash", { command: "ls   -la" })).toBe("bash(ls -la)");
  expect(toolTitle("grep", { count: 3 })).toBe("grep");
  expect(toolTitle("bash", { command: "x".repeat(100) })).toHaveLength(86);
});

function win(sessionId: string, cwd: string, over: Partial<AppWindow> = {}): AppWindow {
  return { sessionId, mode: "code", cwd, sessionPath: null, busy: false, viewers: 1, ...over };
}

test("joins the window the user is looking at for that project", async () => {
  const root = await mkdtemp(join(tmpdir(), "gg-bridge-"));
  const project = join(root, "proj");
  const other = join(root, "other");
  await mkdir(project);
  await mkdir(other);
  const windows = [
    win("background", project, { viewers: 0 }),
    win("elsewhere", other, { viewers: 5 }),
    win("focused", project, { viewers: 1 }),
  ];
  expect((await pickWindow(windows, project))?.sessionId).toBe("focused");
  expect(await pickWindow(windows, join(root, "missing"))).toBeUndefined();
});

test("prefers an idle window over a busy one with as many viewers", async () => {
  const project = await mkdtemp(join(tmpdir(), "gg-bridge-"));
  const windows = [win("busy", project, { busy: true }), win("idle", project)];
  expect((await pickWindow(windows, project))?.sessionId).toBe("idle");
});

test("matches a project reached through a symlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "gg-bridge-"));
  const real = join(root, "real");
  await mkdir(real);
  await symlink(real, join(root, "link"));
  expect((await pickWindow([win("w", real)], join(root, "link")))?.sessionId).toBe("w");
});

function fakeApp(script: { accepts: boolean; windowsAfter: AppWindow[]; afterPolls?: number }) {
  let polls = 0;
  const calls: string[] = [];
  const api = {
    async openInWindow(cwd: string, sessionPath?: string) {
      calls.push(`open ${cwd} ${sessionPath ?? "-"}`);
      return script.accepts;
    },
    async windows() {
      polls += 1;
      return polls > (script.afterPolls ?? 0) ? script.windowsAfter : [];
    },
  };
  return { api: api as unknown as import("./client.js").AppClient, calls };
}

test("a phone chat opens in a window and joins that window's session", async () => {
  const { api, calls } = fakeApp({
    accepts: true,
    afterPolls: 2,
    windowsAfter: [win("hidden", "/p", { viewers: 0 }), win("shown", "/p", { viewers: 1, sessionPath: "/s/a.jsonl" })],
  });
  const id = await openInAppWindow(api, { cwd: "/p", sessionPath: "/s/a.jsonl" }, (w) => w.sessionPath === "/s/a.jsonl", {
    pollMs: 1,
  });
  expect(id).toBe("shown");
  expect(calls).toEqual(["open /p /s/a.jsonl"]);
});

test("no window to open it means no window session, so the caller runs it off screen", async () => {
  expect(await openInAppWindow(fakeApp({ accepts: false, windowsAfter: [] }).api, { cwd: "/p" }, () => true)).toBeUndefined();
  const stuck = fakeApp({ accepts: true, windowsAfter: [] });
  expect(await openInAppWindow(stuck.api, { cwd: "/p" }, () => true, { timeoutMs: 20, pollMs: 2 })).toBeUndefined();
});
