import { describe, expect, test } from "bun:test";
import {
  BACKSPACE,
  MAX_FRAME,
  agentForProvider,
  framesOf,
  keystrokesFor,
  answerLabel,
  currentStep,
  foldLive,
  foldTranscript,
  isDecline,
  linkedTerminal,
  providerForAgent,
  pruneTranscripts,
  SHIFT_TAB,
  terminalConfigKeys,
  terminalMoment,
  terminalToFollow,
  terminalTurns,
  TRUST_KEYS,
  type Terminal,
} from "./terminalTyping";

test("typing on sends only the new characters", () => {
  expect(keystrokesFor("", "h")).toBe("h");
  expect(keystrokesFor("h", "hi")).toBe("i");
  expect(keystrokesFor("hi", "hi")).toBe("");
});

test("deleting from the end sends backspaces", () => {
  expect(keystrokesFor("hello", "hell")).toBe(BACKSPACE);
  expect(keystrokesFor("hello", "")).toBe(BACKSPACE.repeat(5));
});

test("autocorrect replacing the last word rubs it out and retypes it", () => {
  expect(keystrokesFor("fix teh", "fix the")).toBe(`${BACKSPACE.repeat(2)}he`);
});

test("an edit in the middle is still exact, if wordier", () => {
  const typed = "add a buton here";
  const next = "add a button here";
  const keys = keystrokesFor(typed, next);
  // Replaying the keystrokes on what the terminal had gives what the phone shows.
  const screen = Array.from(typed);
  for (const key of keys) {
    if (key === BACKSPACE) screen.pop();
    else screen.push(key);
  }
  expect(screen.join("")).toBe(next);
});

test("an emoji is one backspace, never half a character", () => {
  expect(keystrokesFor("ok 👍", "ok ")).toBe(BACKSPACE);
  expect(keystrokesFor("ok ", "ok 👍")).toBe("👍");
});

const term = (id: string, agent: Terminal["agent"], cwd: string, startedAt: number): Terminal => ({
  id,
  agent,
  cwd,
  folder: cwd.split("/").pop() ?? cwd,
  startedAt,
});

test("the composer types only into its own agent's terminal in the same project", () => {
  const terminals = [
    term("a", "claude", "/Users/me/app", 1),
    term("b", "codex", "/Users/me/app", 2),
    term("c", "claude", "/Users/me/site", 3),
  ];
  expect(linkedTerminal(terminals, "claude-code", "/Users/me/app")?.id).toBe("a");
  expect(linkedTerminal(terminals, "codex", "/Users/me/app")?.id).toBe("b");
  expect(linkedTerminal(terminals, "claude-code", "/Users/me/app/")?.id).toBe("a");
  expect(linkedTerminal(terminals, "claude-code", "/Users/me/other")).toBeUndefined();
  expect(linkedTerminal(terminals, "gemini-cli", "/Users/me/app")).toBeUndefined();
  expect(linkedTerminal(terminals, "claude-code", undefined)).toBeUndefined();
});

test("two projects that share a folder name are never confused", () => {
  const terminals = [term("work", "claude", "/Users/me/work/app", 1)];
  expect(linkedTerminal(terminals, "claude-code", "/Users/me/play/app")).toBeUndefined();
  expect(linkedTerminal(terminals, "claude-code", "/Users/me/work/app")?.id).toBe("work");
});

test("with two windows on one project, the newest is the one typed into", () => {
  const terminals = [term("old", "claude", "/p/app", 1), term("new", "claude", "/p/app", 9)];
  expect(linkedTerminal(terminals, "claude-code", "/p/app")?.id).toBe("new");
});

test("only the three terminal agents map", () => {
  expect(agentForProvider("claude-code")).toBe("claude");
  expect(agentForProvider("codex")).toBe("codex");
  expect(agentForProvider("ggcoder")).toBe("ggcoder");
  expect(agentForProvider("echo")).toBeUndefined();
});

test("a big paste is split into frames the daemon accepts, never mid-character", () => {
  const paste = "👍".repeat(MAX_FRAME);
  const frames = framesOf(paste);
  expect(frames.every((frame) => frame.length <= MAX_FRAME)).toBe(true);
  expect(frames.join("")).toBe(paste);
  expect(frames.every((frame) => !/[\uD800-\uDBFF]$/.test(frame))).toBe(true);
  expect(framesOf("")).toEqual([]);
});

test("a terminal opened on the laptop is followed once, newest first", () => {
  const terminals = [term("a", "claude", "/p/app", 1), term("b", "codex", "/p/site", 5)];
  expect(terminalToFollow(terminals, new Set(), false)?.id).toBe("b");
  expect(terminalToFollow(terminals, new Set(["b"]), false)?.id).toBe("a");
  expect(terminalToFollow(terminals, new Set(["a", "b"]), false)).toBeUndefined();
});

test("the phone never jumps away from something it is busy with", () => {
  const terminals = [term("a", "claude", "/p/app", 1)];
  expect(terminalToFollow(terminals, new Set(), true)).toBeUndefined();
});

test("each terminal agent maps back to its provider", () => {
  expect(providerForAgent("claude")).toBe("claude-code");
  expect(providerForAgent("codex")).toBe("codex");
  expect(providerForAgent("ggcoder")).toBe("ggcoder");
  for (const agent of ["claude", "codex", "ggcoder"] as const) {
    expect(agentForProvider(providerForAgent(agent))).toBe(agent);
  }
});

describe("a terminal's conversation on the phone", () => {
  const say = (role: "user" | "agent" | "tool", text: string) => ({ role, text });

  test("a reset replaces, and an update is added only where the copy ends", () => {
    let held = foldTranscript(
      {},
      { terminalId: "t", start: 0, reset: true, messages: [say("user", "hi")] },
    );
    held = foldTranscript(held, {
      terminalId: "t",
      start: 1,
      reset: false,
      messages: [say("agent", "Hello!")],
    });
    expect(held.t).toEqual({ start: 0, messages: [say("user", "hi"), say("agent", "Hello!")] });

    // A gap: something went missing, so the update is not stitched on.
    const gapped = foldTranscript(held, {
      terminalId: "t",
      start: 5,
      reset: false,
      messages: [say("user", "?")],
    });
    expect(gapped).toBe(held);
    // An update for a terminal the phone has nothing for waits for the reset.
    expect(
      foldTranscript({}, { terminalId: "u", start: 0, reset: false, messages: [say("user", "x")] }),
    ).toEqual({});
  });

  test("a closed terminal's conversation is dropped with it", () => {
    const held = { a: { start: 0, messages: [] }, b: { start: 0, messages: [] } };
    expect(Object.keys(pruneTranscripts(held, [{ id: "a" }]))).toEqual(["a"]);
    expect(pruneTranscripts(held, [{ id: "a" }, { id: "b" }])).toBe(held);
  });

  test("a reply written in pieces is one bubble, with each step as a note between", () => {
    const turns = terminalTurns("t", {
      start: 10,
      messages: [
        say("user", "fix the tests"),
        say("agent", "Looking."),
        say("agent", "Found it."),
        say("tool", "Ran npm test"),
        say("agent", "All green."),
      ],
    });
    expect(turns).toEqual([
      { id: "term:t:10", role: "user", text: "fix the tests" },
      { id: "term:t:11", role: "agent", text: "Looking.\n\nFound it." },
      { id: "term:t:13", role: "note", text: "Ran npm test" },
      { id: "term:t:14", role: "agent", text: "All green." },
    ]);
    expect(terminalTurns("t", undefined)).toEqual([]);
  });

  test("a bubble keeps its id as more of the reply arrives", () => {
    const before = terminalTurns("t", { start: 0, messages: [say("agent", "One.")] });
    const after = terminalTurns("t", {
      start: 0,
      messages: [say("agent", "One."), say("agent", "Two.")],
    });
    expect(after[0]?.id).toBe(before[0]?.id);
  });
});

describe("changing a setting of an agent in a terminal", () => {
  const claude = (mode?: string) => ({ agent: "claude" as const, mode });

  test("model and effort are the slash commands Claude takes, on their own line", () => {
    expect(terminalConfigKeys(claude(), "model", "sonnet")).toEqual({
      keys: "/model sonnet\r",
      command: "/model sonnet",
    });
    expect(terminalConfigKeys(claude(), "effort", "high")).toEqual({
      keys: "/effort high\r",
      command: "/effort high",
    });
    expect(terminalConfigKeys(claude(), "model", "claude-haiku-4-5-20251001")?.command).toBe(
      "/model claude-haiku-4-5-20251001",
    );
  });

  test("a value that could smuggle in more keystrokes is never typed", () => {
    expect(terminalConfigKeys(claude(), "model", "opus\r/clear")).toBeUndefined();
    expect(terminalConfigKeys(claude(), "model", "a b")).toBeUndefined();
    expect(terminalConfigKeys(claude(), "model", "")).toBeUndefined();
  });

  test("the mode is reached by pressing Shift+Tab around Claude's cycle from where its screen is", () => {
    // auto → manual → accept edits → plan → auto, as Claude Code 2.1 cycles.
    expect(terminalConfigKeys(claude("auto"), "mode", "plan")).toEqual({
      keys: SHIFT_TAB.repeat(3),
    });
    expect(terminalConfigKeys(claude("plan"), "mode", "auto")).toEqual({ keys: SHIFT_TAB });
    expect(terminalConfigKeys(claude("default"), "mode", "acceptEdits")).toEqual({
      keys: SHIFT_TAB,
    });
    expect(terminalConfigKeys(claude("plan"), "mode", "plan")).toEqual({ keys: "" });
  });

  test("without knowing where the mode is, or for a mode outside the cycle, nothing is pressed", () => {
    expect(terminalConfigKeys(claude(undefined), "mode", "plan")).toBeUndefined();
    expect(terminalConfigKeys(claude("auto"), "mode", "bypassPermissions")).toBeUndefined();
  });

  test("agents that cannot take it by typing are not sent anything", () => {
    // GG Coder's /model takes no argument: typed one, it went to the model as a message.
    expect(terminalConfigKeys({ agent: "ggcoder" }, "model", "claude-sonnet-5-5")).toBeUndefined();
    expect(terminalConfigKeys({ agent: "codex" }, "model", "gpt-6")).toBeUndefined();
    expect(terminalConfigKeys(claude(), "fast", true)).toBeUndefined();
    expect(terminalConfigKeys(claude(), "something-else", "x")).toBeUndefined();
  });
});

test("Claude's trust menu starts on 'No, exit': trusting is Down then Return, exiting is Return", () => {
  expect(TRUST_KEYS.trust).toBe("\x1b[B\r");
  expect(TRUST_KEYS.exit).toBe("\r");
});

describe("answering a terminal's question from the phone", () => {
  test("an answer button keeps the choice and drops the bracketed hint", () => {
    expect(
      answerLabel(
        "Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session",
      ),
    ).toBe("Yes, and switch to accept edits");
    expect(answerLabel("Yes")).toBe("Yes");
    expect(answerLabel("x".repeat(60)).length).toBe(40);
  });

  test("the way out looks like the way out", () => {
    expect(isDecline("No")).toBe(true);
    expect(isDecline("No, and tell Claude what to do differently")).toBe(true);
    expect(isDecline("Yes")).toBe(false);
    expect(isDecline("Nothing to add")).toBe(false);
  });

  test("a notification is for a turn finishing, or the agent stopping to ask — never the first reading", () => {
    expect(terminalMoment("working", "idle")).toBe("finished");
    expect(terminalMoment("working", "waiting")).toBe("asking");
    expect(terminalMoment("idle", "waiting")).toBe("asking");
    expect(terminalMoment(undefined, "idle")).toBeUndefined();
    expect(terminalMoment(undefined, "waiting")).toBeUndefined();
    expect(terminalMoment("waiting", "working")).toBeUndefined();
    expect(terminalMoment("idle", "working")).toBeUndefined();
    expect(terminalMoment("idle", "idle")).toBeUndefined();
  });
});

describe("a run shown live before the file has it", () => {
  test("a live frame replaces that terminal's run, and an empty one removes it", () => {
    const run = [
      { role: "user" as const, text: "check it" },
      { role: "tool" as const, text: "Ran npm test · exit 0" },
    ];
    const one = foldLive({}, { terminalId: "t1", messages: run });
    expect(one).toEqual({ t1: run });
    expect(foldLive(one, { terminalId: "t1", messages: run.slice(0, 1) })).toEqual({
      t1: run.slice(0, 1),
    });
    expect(foldLive(one, { terminalId: "t1", messages: [] })).toEqual({});
    // Nothing to remove: the same object, so React skips the render.
    const empty = {};
    expect(foldLive(empty, { terminalId: "t9", messages: [] })).toBe(empty);
    // Anything that is not a message is dropped rather than drawn.
    expect(
      foldLive({}, { terminalId: "t1", messages: [{ role: "system", text: "x" } as never] }),
    ).toEqual({});
  });

  test("the live run follows the saved conversation, with ids of its own", () => {
    const turns = terminalTurns(
      "t1",
      {
        start: 4,
        messages: [
          { role: "user", text: "earlier" },
          { role: "agent", text: "done before" },
        ],
      },
      [
        { role: "user", text: "check it" },
        { role: "agent", text: "Starting." },
        { role: "tool", text: "Ran npm test · exit 0" },
      ],
    );
    expect(turns.map((t) => [t.id, t.role, t.text])).toEqual([
      ["term:t1:4", "user", "earlier"],
      ["term:t1:5", "agent", "done before"],
      ["term:t1:live:0", "user", "check it"],
      ["term:t1:live:1", "agent", "Starting."],
      ["term:t1:live:2", "note", "Ran npm test · exit 0"],
    ]);
    // With nothing saved yet, the run alone.
    expect(terminalTurns("t1", undefined, [{ role: "user", text: "hi" }])).toEqual([
      { id: "term:t1:live:0", role: "user", text: "hi" },
    ]);
  });
});

test("the step a run is on is the one still running, else the last", () => {
  expect(
    currentStep([
      { role: "user", text: "go" },
      { role: "tool", text: "Run a command · 55 times…" },
      { role: "tool", text: "Read a file · 2 times" },
    ]),
  ).toBe("Run a command · 55 times…");
  expect(
    currentStep([
      { role: "tool", text: "Ran npm test · exit 0" },
      { role: "tool", text: "Read a file" },
    ]),
  ).toBe("Read a file");
  expect(currentStep(undefined)).toBeUndefined();
});
