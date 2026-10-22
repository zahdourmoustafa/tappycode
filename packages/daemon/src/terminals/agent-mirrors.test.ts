/**
 * Codex's and GG Coder's conversations in a terminal, followed for the phone.
 *
 * The fixture lines are shaped exactly like lines read off real files on a
 * working machine — Codex 0.147 rollouts and GG Coder 5.83 sessions — with the
 * long instruction text cut down. The hidden-context cases are the point: each
 * agent files what it sends its model beside the conversation, and none of it
 * may reach the phone.
 */
import { afterAll, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codexMessagesFromLine,
  ggcoderMessagesFromLine,
  ggcoderProjectDir,
  ggcoderSource,
} from "./agent-mirrors.js";
import { type MirrorUpdate, TerminalMirror } from "./mirror.js";

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

// ── Codex ───────────────────────────────────────────────────

const codexEvent = (item: unknown) =>
  JSON.stringify({
    timestamp: "2026-10-17T10:56:22.000Z",
    type: "event_msg",
    payload: { type: "item_completed", thread_id: "01a14981", turn_id: "01a14981-6cfd", item },
  });
const codexItem = (role: string, text: string) =>
  JSON.stringify({
    timestamp: "2026-10-17T10:56:21.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role,
      content: [{ type: role === "assistant" ? "output_text" : "input_text", text }],
    },
  });

test("codex: what was typed and what Codex said become messages", () => {
  expect(
    codexMessagesFromLine(
      codexEvent({
        type: "UserMessage",
        id: "01a14981-6cfd-75d2",
        content: [{ type: "text", text: "Reply with only the word ok.", text_elements: [] }],
      }),
    ),
  ).toEqual([{ role: "user", text: "Reply with only the word ok." }]);
  expect(
    codexMessagesFromLine(
      codexEvent({
        type: "AgentMessage",
        id: "msg_04",
        content: [{ type: "Text", text: "ok" }],
        phase: "final_answer",
      }),
    ),
  ).toEqual([{ role: "agent", text: "ok" }]);
});

test("codex: a command it ran is one short step, and empty commentary is nothing", () => {
  expect(
    codexMessagesFromLine(
      codexEvent({
        type: "CommandExecution",
        id: "exec-0f41",
        process_id: "78297",
        command: ["/bin/zsh", "-lc", "ls -a"],
        cwd: "file:///private/tmp/codex-test",
      }),
    ),
  ).toEqual([{ role: "tool", text: "Run ls -a" }]);
  expect(
    codexMessagesFromLine(
      codexEvent({
        type: "AgentMessage",
        id: "msg_05",
        content: [{ type: "Text", text: "" }],
        phase: "commentary",
      }),
    ),
  ).toEqual([]);
});

test("codex: the instructions and context it sends its model never reach the phone", () => {
  const hidden = [
    // The developer instructions: skills, permissions, collaboration mode.
    codexItem(
      "developer",
      "<permissions instructions> Filesystem sandboxing defines which files can be read",
    ),
    // The environment block, filed under the user role.
    codexItem(
      "user",
      "<environment_context>\n  <cwd>/private/tmp/codex-test</cwd>\n  <shell>zsh</shell>",
    ),
    // Even the model-facing copy of a real message is not read: the event is.
    codexItem("user", "Reply with only the word ok."),
    codexItem("assistant", "ok"),
    JSON.stringify({
      type: "session_meta",
      payload: { base_instructions: { text: "You are Codex, an agent" } },
    }),
    JSON.stringify({ type: "turn_context", payload: { cwd: "/p", model: "gpt" } }),
    JSON.stringify({
      type: "response_item",
      payload: { type: "reasoning", summary: [{ text: "thinking" }] },
    }),
    JSON.stringify({ type: "event_msg", payload: { type: "token_count" } }),
    "{not json",
  ];
  for (const line of hidden) expect(codexMessagesFromLine(line)).toEqual([]);
});

// ── GG Coder ────────────────────────────────────────────────

const ggUser = (content: unknown, provenance?: unknown) =>
  JSON.stringify({
    type: "message",
    id: "u1",
    parentId: null,
    timestamp: "2026-10-17T10:00:00.000Z",
    message: { role: "user", content, ...(provenance ? { provenance } : {}) },
  });
const ggAgent = (...content: unknown[]) =>
  JSON.stringify({
    type: "message",
    id: "a1",
    parentId: "u1",
    message: { role: "assistant", content },
  });

test("gg: what was typed and what GG Coder said become messages, with each step", () => {
  expect(
    ggcoderMessagesFromLine(
      ggUser("fix the login bug", { kind: "prompt", visibility: "transcript" }),
    ),
  ).toEqual([{ role: "user", text: "fix the login bug" }]);
  expect(
    ggcoderMessagesFromLine(
      ggAgent(
        { type: "thinking", thinking: "Let me look." },
        { type: "text", text: "Found it." },
        { type: "tool_call", id: "toolu_01", name: "bash", args: { command: "npm test" } },
        {
          type: "tool_call",
          id: "toolu_02",
          name: "edit",
          args: { file_path: "/p/src/login.ts", edits: [] },
        },
      ),
    ),
  ).toEqual([
    { role: "agent", text: "Found it." },
    { role: "tool", text: "Run npm test" },
    { role: "tool", text: "Edit login.ts" },
  ]);
});

test("gg: turns the person never typed stay hidden, as GG Coder hides them", () => {
  const hidden = [
    ggUser("[Status update on background work you started.]", {
      kind: "notification",
      visibility: "hidden",
    }),
    ggUser("[Autopilot] This turn was triggered by Ken", {
      kind: "automation",
      visibility: "hidden",
    }),
    ggUser("Background-process completion gate", { kind: "completion_gate", visibility: "hidden" }),
    ggUser("[Previous conversation summary] ### Next Step", {
      kind: "compaction_summary",
      visibility: "summary",
    }),
    // An older session with no provenance still marks its summary in the text.
    ggUser("[Previous conversation summary] earlier work"),
    JSON.stringify({
      type: "message",
      message: { role: "tool", content: [{ type: "tool_result", content: "ok" }] },
    }),
    JSON.stringify({ type: "message", message: { role: "system", content: "You are GG Coder" } }),
    JSON.stringify({ type: "custom", kind: "turn_metric", data: { usage: {} } }),
    JSON.stringify({ type: "session", id: "3225647e", cwd: "/p", model: "claude" }),
    ggAgent({ type: "thinking", thinking: "private" }),
  ];
  for (const line of hidden) expect(ggcoderMessagesFromLine(line)).toEqual([]);
  // A message someone typed while the agent was working is still theirs.
  expect(
    ggcoderMessagesFromLine(
      ggUser("also add a test", { kind: "steering", visibility: "transcript" }),
    ),
  ).toEqual([{ role: "user", text: "also add a test" }]);
});

test("gg: the newest session written since the terminal opened is followed, and a new one resets", async () => {
  const sessions = await mkdtemp(join(tmpdir(), "gg-sessions-"));
  roots.push(sessions);
  const cwd = "/Users/me/my-app";
  const dir = join(sessions, ggcoderProjectDir(cwd));
  await mkdir(dir, { recursive: true });
  const openedAt = Date.now();

  // An old conversation in the same project, from before the terminal opened.
  await writeFile(join(dir, "old.jsonl"), `${ggUser("an old chat")}\n`);
  const longAgo = new Date(openedAt - 60_000);
  await utimes(join(dir, "old.jsonl"), longAgo, longAgo);

  const updates: MirrorUpdate[] = [];
  const mirror = new TerminalMirror(ggcoderSource(cwd, openedAt, sessions), (update) =>
    updates.push(update),
  );
  await mirror.poll();
  expect(updates).toEqual([]); // the old chat is never mistaken for this one

  await writeFile(
    join(dir, "now.jsonl"),
    `${ggUser("hi", { kind: "prompt", visibility: "transcript" })}\n`,
  );
  await mirror.poll();
  expect(updates.at(-1)).toEqual({
    start: 0,
    reset: true,
    messages: [{ role: "user", text: "hi" }],
  });

  await appendFile(join(dir, "now.jsonl"), `${ggAgent({ type: "text", text: "Hello!" })}\n`);
  await mirror.poll();
  expect(updates.at(-1)).toEqual({
    start: 1,
    reset: false,
    messages: [{ role: "agent", text: "Hello!" }],
  });

  // `/clear`: GG Coder starts a new file, and the phone starts over.
  await Bun.sleep(20);
  await writeFile(
    join(dir, "fresh.jsonl"),
    `${ggUser("new topic", { kind: "prompt", visibility: "transcript" })}\n`,
  );
  const later = new Date(Date.now() + 1000);
  await utimes(join(dir, "fresh.jsonl"), later, later);
  await mirror.poll();
  expect(updates.at(-1)).toEqual({
    start: 0,
    reset: true,
    messages: [{ role: "user", text: "new topic" }],
  });
  mirror.stop();
});

test("gg: no session folder yet is nothing to send, not an error", async () => {
  const updates: MirrorUpdate[] = [];
  const mirror = new TerminalMirror(
    ggcoderSource("/nowhere", Date.now(), "/nonexistent/sessions"),
    (u) => updates.push(u),
  );
  await mirror.poll();
  expect(updates).toEqual([]);
});
