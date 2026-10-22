/**
 * Claude's conversation in a terminal, followed for the phone. Each test builds
 * a throwaway Claude home — `sessions/<pid>.json` and a transcript — the way
 * Claude Code lays them out, and steps the mirror by hand.
 */
import { afterAll, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { encodeCwd } from "../acp/claude-history.js";
import { Daemon } from "../index.js";
import {
  ClaudeMirror,
  claudeActivity,
  type MirrorUpdate,
  terminalMessagesFromLine,
  toolLabel,
} from "./claude-mirror.js";

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const PID = 4242;
const CWD = "/Users/me/my-app";

const user = (text: string) =>
  JSON.stringify({ type: "user", message: { role: "user", content: text } });
const agent = (...content: unknown[]) =>
  JSON.stringify({ type: "assistant", message: { role: "assistant", content } });
const say = (text: string) => ({ type: "text", text });
const tool = (name: string, input: unknown) => ({ type: "tool_use", id: "t1", name, input });

async function claudeHome(conversation = "conv-1") {
  const home = await mkdtemp(join(tmpdir(), "claude-home-"));
  roots.push(home);
  await mkdir(join(home, "sessions"));
  await mkdir(join(home, "projects", encodeCwd(CWD)), { recursive: true });
  const setConversation = (id: string) =>
    writeFile(
      join(home, "sessions", `${PID}.json`),
      JSON.stringify({ pid: PID, sessionId: id, cwd: CWD }),
    );
  await setConversation(conversation);
  const transcript = (id = conversation) => join(home, "projects", encodeCwd(CWD), `${id}.jsonl`);
  return { home, setConversation, transcript };
}

function mirrorOf(home: string) {
  const updates: MirrorUpdate[] = [];
  const mirror = new ClaudeMirror(PID, CWD, (update) => updates.push(update), home);
  return { mirror, updates };
}

// ── Reading a line ──────────────────────────────────────────

test("what was typed and what the agent said become messages", () => {
  expect(terminalMessagesFromLine(user("fix the login bug"))).toEqual([
    { role: "user", text: "fix the login bug" },
  ]);
  expect(terminalMessagesFromLine(agent(say("Found it.")))).toEqual([
    { role: "agent", text: "Found it." },
  ]);
});

test("each tool call is a short step, as the terminal shows it", () => {
  expect(
    terminalMessagesFromLine(
      agent(say("Running the tests."), tool("Bash", { command: "npm test\nmore" })),
    ),
  ).toEqual([
    { role: "agent", text: "Running the tests." },
    { role: "tool", text: "Run npm test" },
  ]);
  expect(toolLabel("Edit", { file_path: "/p/src/App.tsx" })).toBe("Edit App.tsx");
  expect(toolLabel("Read", { file_path: "/p/README.md" })).toBe("Read README.md");
  expect(toolLabel("Grep", { pattern: "useState" })).toBe("Search for useState");
  expect(toolLabel("mcp__thing__do", {})).toBe("Use mcp__thing__do");
  expect(toolLabel("Bash", { command: "x".repeat(200) }).length).toBeLessThanOrEqual(84);
});

test("thinking, tool results, side conversations and junk are not part of it", () => {
  expect(terminalMessagesFromLine(agent({ type: "thinking", thinking: "hmm" }))).toEqual([]);
  expect(
    terminalMessagesFromLine(
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", content: "ok" }] },
      }),
    ),
  ).toEqual([]);
  expect(
    terminalMessagesFromLine(
      JSON.stringify({
        isSidechain: true,
        message: { role: "assistant", content: [say("helper chatter")] },
      }),
    ),
  ).toEqual([]);
  expect(terminalMessagesFromLine("{not json")).toEqual([]);
  expect(terminalMessagesFromLine(JSON.stringify({ type: "summary", summary: "x" }))).toEqual([]);
});

// ── Following a conversation ────────────────────────────────

test("a phone gets the conversation so far, then only what is new, numbered to follow on", async () => {
  const { home, transcript } = await claudeHome();
  await writeFile(transcript(), `${user("hi")}\n${agent(say("Hello!"))}\n`);
  const { mirror, updates } = mirrorOf(home);

  await mirror.poll();
  expect(updates).toEqual([
    {
      start: 0,
      reset: true,
      messages: [
        { role: "user", text: "hi" },
        { role: "agent", text: "Hello!" },
      ],
    },
  ]);

  await appendFile(transcript(), `${user("add a test")}\n`);
  await mirror.poll();
  expect(updates.at(-1)).toEqual({
    start: 2,
    reset: false,
    messages: [{ role: "user", text: "add a test" }],
  });

  // Nothing new, nothing sent.
  await mirror.poll();
  expect(updates.length).toBe(2);
  expect(mirror.snapshot().messages.length).toBe(3);
});

test("a line Claude is still writing waits for its end", async () => {
  const { home, transcript } = await claudeHome();
  const line = user("half a message");
  await writeFile(transcript(), line.slice(0, 10));
  const { mirror, updates } = mirrorOf(home);
  await mirror.poll();
  expect(updates).toEqual([{ start: 0, reset: true, messages: [] }]);

  await appendFile(transcript(), `${line.slice(10)}\n`);
  await mirror.poll();
  expect(updates.at(-1)).toEqual({
    start: 0,
    reset: false,
    messages: [{ role: "user", text: "half a message" }],
  });
});

test("a character split across two writes still arrives whole", async () => {
  const { home, transcript } = await claudeHome();
  const bytes = Buffer.from(`${user("café ☕ 👍")}\n`);
  const { mirror, updates } = mirrorOf(home);
  // Cut inside the emoji's four bytes.
  const cut = bytes.indexOf(Buffer.from("👍")) + 2;
  await writeFile(transcript(), bytes.subarray(0, cut));
  await mirror.poll();
  await appendFile(transcript(), bytes.subarray(cut));
  await mirror.poll();
  expect(updates.at(-1)?.messages).toEqual([{ role: "user", text: "café ☕ 👍" }]);
});

test("/clear moves to a new conversation, and the phone is told to start over", async () => {
  const { home, setConversation, transcript } = await claudeHome();
  await writeFile(transcript(), `${user("old chat")}\n`);
  const { mirror, updates } = mirrorOf(home);
  await mirror.poll();

  await setConversation("conv-2");
  await writeFile(transcript("conv-2"), `${user("fresh start")}\n`);
  await mirror.poll();
  expect(updates.at(-1)).toEqual({
    start: 0,
    reset: true,
    messages: [{ role: "user", text: "fresh start" }],
  });
});

test("before Claude has written anything there is nothing to send, and no error", async () => {
  const { home } = await claudeHome();
  const { mirror, updates } = mirrorOf(home);
  await mirror.poll();
  expect(updates).toEqual([{ start: 0, reset: true, messages: [] }]);
});

test("a conversation id that is not Claude's shape never becomes a path", async () => {
  const { home } = await claudeHome();
  await writeFile(
    join(home, "sessions", `${PID}.json`),
    JSON.stringify({ sessionId: "../../etc/passwd", cwd: CWD }),
  );
  const { mirror, updates } = mirrorOf(home);
  await mirror.poll();
  expect(updates).toEqual([]);
});

test("a stopped mirror sends nothing more", async () => {
  const { home, transcript } = await claudeHome();
  await writeFile(transcript(), `${user("hi")}\n`);
  const { mirror, updates } = mirrorOf(home);
  mirror.stop();
  await mirror.poll();
  expect(updates).toEqual([]);
});

// ── In the daemon ───────────────────────────────────────────

test("a Claude terminal's conversation reaches every phone, and a connecting one gets it whole", async () => {
  const { home, transcript } = await claudeHome();
  await writeFile(transcript(), `${user("hi")}\n${agent(say("Hello!"))}\n`);
  const daemon = new Daemon({ id: "test", name: "test" }, true, {
    TAPPY_HOME: home,
    CLAUDE_CONFIG_DIR: home,
  });
  const sent: any[] = [];
  daemon.attach((m) => sent.push(m));
  const id = daemon.terminals.register({
    agent: "claude",
    cwd: CWD,
    pid: PID,
    deliver: () => true,
  });

  const until = Date.now() + 5000;
  while (!sent.some((m) => m.t === "terminal.transcript") && Date.now() < until)
    await Bun.sleep(20);
  expect(sent.find((m) => m.t === "terminal.transcript")).toEqual({
    t: "terminal.transcript",
    terminalId: id,
    start: 0,
    reset: true,
    messages: [
      { role: "user", text: "hi" },
      { role: "agent", text: "Hello!" },
    ],
  });

  const greeting = daemon.greet({});
  expect(greeting.find((m) => m.t === "terminal.transcript")).toMatchObject({
    terminalId: id,
    reset: true,
  });

  // Closing the terminal stops following it.
  daemon.terminals.remove(id);
  expect(daemon.greet({}).some((m) => m.t === "terminal.transcript")).toBe(false);
  daemon.closeAll();
});

test("a Claude or Codex terminal from a wrapper too old to send its pid is not followed", async () => {
  // Both are found through the agent's own process; without a pid there is
  // nothing exact to go on, and guessing could show another conversation.
  const { home } = await claudeHome();
  const daemon = new Daemon({ id: "test", name: "test" }, true, {
    TAPPY_HOME: home,
    CLAUDE_CONFIG_DIR: home,
    CODEX_HOME: home,
    HOME: home,
  });
  daemon.terminals.register({ agent: "claude", cwd: CWD, deliver: () => true });
  daemon.terminals.register({ agent: "codex", cwd: CWD, deliver: () => true });
  await Bun.sleep(50);
  expect(daemon.greet({}).some((m) => m.t === "terminal.transcript")).toBe(false);
  daemon.closeAll();
});

test("the context Claude sent the model never reaches the phone", () => {
  // Seen on a real conversation: CLAUDE.md and the account's email, filed as an
  // `api-request-blob` with a user-role message inside.
  const blob = JSON.stringify({
    type: "api-request-blob",
    hash: "abc",
    message: {
      role: "user",
      content: [{ type: "text", text: "<system-reminder>email a@b.c</system-reminder>" }],
    },
  });
  expect(terminalMessagesFromLine(blob)).toEqual([]);
});

test("Claude's own status is read as what it is doing", () => {
  expect(claudeActivity("busy")).toBe("working");
  expect(claudeActivity("waiting")).toBe("waiting");
  expect(claudeActivity("idle")).toBe("idle");
  expect(claudeActivity("something-new")).toBeUndefined();
  expect(claudeActivity(undefined)).toBeUndefined();
});

test("a finished turn and a question each send one notification, with what Claude said", async () => {
  const { home, transcript } = await claudeHome();
  await writeFile(transcript(), `${user("fix the tests")}\n${agent(say("All green now."))}\n`);
  const status = (value: string, waitingFor?: string) =>
    writeFile(
      join(home, "sessions", `${PID}.json`),
      JSON.stringify({ pid: PID, sessionId: "conv-1", cwd: CWD, status: value, waitingFor }),
    );
  const daemon = new Daemon({ id: "test", name: "test" }, true, {
    TAPPY_HOME: home,
    CLAUDE_CONFIG_DIR: home,
  });
  daemon.pushTargets.register("phone-1", "ExponentPushToken[test]", "android");
  const pushed: any[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    pushed.push(...JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ data: [{ status: "ok" }] }));
  }) as typeof fetch;
  try {
    await status("busy");
    daemon.terminals.register({ agent: "claude", cwd: CWD, pid: PID, deliver: () => true });
    const until = (check: () => boolean, ms = 8000) =>
      (async () => {
        const end = Date.now() + ms;
        while (!check() && Date.now() < end) await Bun.sleep(50);
      })();
    await until(() => daemon.terminals.list()[0]?.activity === "working");
    // The first reading is only where it already was: nothing to say yet.
    expect(pushed).toEqual([]);

    await status("idle");
    await until(() => pushed.length > 0);
    expect(pushed[0]).toMatchObject({ title: "my-app · Claude", body: "All green now." });
    expect(pushed[0].data.sessionId).toMatch(/^term:term_/);

    await status("waiting", "permission prompt");
    await until(() => pushed.length > 1);
    expect(pushed[1].body).toContain("Needs your answer");
  } finally {
    globalThis.fetch = realFetch;
    daemon.closeAll();
  }
}, 20000);

test("a step that was declined says so, and Claude's interrupt marker is not shown as typed", () => {
  // As Claude Code 2.1 files a write the person said no to at the prompt.
  const declined = JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "t1",
          is_error: true,
          content: "The user doesn't want to proceed with this tool use. The tool use was rejected",
        },
      ],
    },
    toolUseResult: "User rejected tool use",
  });
  expect(terminalMessagesFromLine(declined)).toEqual([{ role: "tool", text: "Declined" }]);
  const failed = JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t2", is_error: true, content: "Exit code 1" }],
    },
  });
  expect(terminalMessagesFromLine(failed)).toEqual([{ role: "tool", text: "Failed" }]);
  const marker = (text: string) =>
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
  expect(terminalMessagesFromLine(marker("[Request interrupted by user for tool use]"))).toEqual(
    [],
  );
  expect(terminalMessagesFromLine(marker("[Request interrupted by user]"))).toEqual([
    { role: "tool", text: "Stopped" },
  ]);
  // A successful result says nothing more: the step line already did.
  const ok = JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t3", content: "File created" }],
    },
  });
  expect(terminalMessagesFromLine(ok)).toEqual([]);
});
