import { expect, test } from "bun:test";
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listConversations, parseHead } from "./sessions.js";

const header = (id: string, cwd: string, conversationId = id) =>
  JSON.stringify({ type: "session", version: 2, id, conversationId, cwd, timestamp: "t" });
const message = (role: string, content: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "message", id: "m", message: { role, content }, ...extra });

async function write(root: string, project: string, name: string, lines: string[], mtime: number) {
  await mkdir(join(root, project), { recursive: true });
  const file = join(root, project, name);
  await writeFile(file, `${lines.join("\n")}\n`);
  await utimes(file, mtime, mtime);
}

test("titles come from the first real user message", () => {
  const parsed = parseHead(
    [
      header("a", "/w"),
      message("user", "[Previous conversation summary] old stuff"),
      message("user", "scheduled", { provenance: { kind: "automation" } }),
      message("user", [{ type: "text", text: "Fix   the\nbuild" }]),
    ].join("\n"),
  );
  expect(parsed).toEqual({ id: "a", conversationId: "a", cwd: "/w", title: "Fix the build", hasMessages: true });
});

test("non-session files are ignored", () => {
  expect(parseHead("not json")).toBeUndefined();
  expect(parseHead(JSON.stringify({ type: "other" }))).toBeUndefined();
});

test("one row per conversation, newest checkpoint, newest first, empty ones hidden", async () => {
  const root = await mkdtemp(join(tmpdir(), "gg-sessions-"));
  await write(root, "proj", "1_aaaa.jsonl", [header("c1", "/proj"), message("user", "first ask")], 1_000);
  await write(root, "proj", "2_bbbb.jsonl", [header("c1b", "/proj", "c1"), message("assistant", "more")], 3_000);
  await write(root, "other", "3_cccc.jsonl", [header("c2", "/other"), message("user", "second chat")], 2_000);
  await write(root, "other", "4_dddd.jsonl", [header("c3", "/other")], 4_000);

  const listed = await listConversations(root);
  expect(listed.map((c) => [c.sessionId, c.title, c.cwd])).toEqual([
    ["c1", "first ask", "/proj"],
    ["c2", "second chat", "/other"],
  ]);
  expect(listed[0]?.path).toEndWith("2_bbbb.jsonl");
});

test("a missing sessions folder lists nothing", async () => {
  expect(await listConversations(join(tmpdir(), "no-gg-here"))).toEqual([]);
});
