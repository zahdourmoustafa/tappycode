import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentSession } from "./connect";
import { hydrateClaudeMessageCounts, loadClaudeDisplayHistory } from "./claude-history";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("counts only rows the official Claude ACP replay renders", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tappy-claude-history-"));
  roots.push(root);
  const cwd = "/Users/test/my-project";
  const directory = path.join(root, "-Users-test-my-project");
  await mkdir(directory, { recursive: true });
  const sessionId = "12345678-1234-1234-1234-123456789abc";
  const entries = [
    { type: "user", message: { role: "user", content: "Question" } },
    {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "Working" }] },
    },
    {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", content: "done" }] },
    },
    {
      type: "user",
      isMeta: true,
      message: { role: "user", content: "Base directory for this skill" },
    },
    {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "Done" }] },
    },
    {
      type: "user",
      message: {
        role: "user",
        content: "<local-command-stdout>synthetic output</local-command-stdout>",
      },
    },
    { type: "user", message: { role: "user", content: "Thanks" } },
    {
      type: "assistant",
      message: { role: "assistant", content: "Please run /login · API Error" },
    },
    { type: "assistant", message: { role: "assistant", content: "Any time" } },
  ];
  await writeFile(
    path.join(directory, `${sessionId}.jsonl`),
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );
  const sessions: AgentSession[] = [{ sessionId, cwd, title: "Stored session" }];

  await hydrateClaudeMessageCounts(sessions, root);
  const display = await loadClaudeDisplayHistory(sessionId, cwd, root);

  // Working + Done coalesce around invisible tool/meta events; synthetic login is skipped.
  expect(sessions[0]!.messageCount).toBe(4);
  expect(display?.map(({ role, text }) => `${role}:${text}`)).toEqual([
    "user:Question",
    "assistant:Working",
    "assistant:Done",
    "user:Thanks",
    "assistant:Any time",
  ]);
});

test("a pasted screenshot survives replay, even as the whole message", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tappy-claude-images-"));
  roots.push(root);
  const cwd = "/Users/test/shots";
  const directory = path.join(root, "-Users-test-shots");
  await mkdir(directory, { recursive: true });
  const sessionId = "22345678-1234-1234-1234-123456789abc";
  const entries = [
    {
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "text", text: "what is this" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAB" } },
        ],
      },
    },
    {
      // No words at all: emptiness is judged on text *and* images, or this
      // message disappears from a resumed thread.
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "BBBC" } },
        ],
      },
    },
  ];
  await writeFile(
    path.join(directory, `${sessionId}.jsonl`),
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );

  const display = await loadClaudeDisplayHistory(sessionId, cwd, root);

  expect(display?.map(({ text, images }) => [text, images])).toEqual([
    ["what is this", [{ type: "image", mimeType: "image/png", data: "AAAB" }]],
    ["", [{ type: "image", mimeType: "image/jpeg", data: "BBBC" }]],
  ]);
});

test("the context Claude sent the model is not replayed as a message someone typed", async () => {
  // Claude files it as `api-request-blob` with a user-role message inside:
  // CLAUDE.md, the account's email, git status. It is not the conversation.
  const root = await mkdtemp(path.join(tmpdir(), "tappy-claude-history-"));
  roots.push(root);
  const cwd = "/Users/test/my-project";
  await mkdir(path.join(root, "-Users-test-my-project"), { recursive: true });
  const sessionId = "12345678-1234-1234-1234-123456789abd";
  const lines = [
    { type: "user", message: { role: "user", content: "Reply with ok" } },
    {
      type: "api-request-blob",
      hash: "abc",
      message: { role: "user", content: [{ type: "text", text: "<system-reminder>The user's email is a@b.c</system-reminder>" }] },
    },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
  ];
  await writeFile(
    path.join(root, "-Users-test-my-project", `${sessionId}.jsonl`),
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
  );
  const messages = await loadClaudeDisplayHistory(sessionId, cwd, root);
  expect(messages?.map(({ role, text }) => [role, text])).toEqual([
    ["user", "Reply with ok"],
    ["assistant", "ok"],
  ]);
});
