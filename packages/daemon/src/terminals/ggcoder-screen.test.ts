/**
 * GG Coder's screen, read back from a real recording.
 *
 * `fixtures/ggcoder-turn.ansi.gz` is GG Coder 5.85 in an 80×30 PTY, asked to
 * say a line, run `sleep 3; echo one`, say another, run `sleep 3; echo two`
 * and finish — every byte it drew, up to the end of that run. It is what the
 * phone missed: the session file stays silent through all of it.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  ggcoderScreenWatcher,
  ggcoderTurn,
  ggcoderWorking,
  ScreenModel,
  type ScreenTurn,
} from "./ggcoder-screen.js";

const RECORDING = new TextDecoder().decode(
  gunzipSync(readFileSync(join(import.meta.dir, "fixtures", "ggcoder-turn.ansi.gz"))),
);
const PROMPT =
  "First say exactly: Starting the check now. Then run `sleep 3; echo one` with bash. Then say exactly: Halfway there. Then run `sleep 3; echo two` with bash. Then reply: All done.";

/** The screen after `text`, fed in uneven pieces the way a PTY delivers it. */
function screenAfter(text: string): ScreenModel {
  const screen = new ScreenModel(() => 30);
  for (let at = 0; at < text.length; at += 997) screen.feed(text.slice(at, at + 997));
  return screen;
}

/** The recording up to the end of the frame that first drew `marker`. */
function upToFrameWith(marker: string): string {
  const at = RECORDING.indexOf(marker);
  expect(at).toBeGreaterThan(0);
  const end = RECORDING.indexOf("\x1b[?2026l", at);
  return RECORDING.slice(0, end + "\x1b[?2026l".length);
}

test("mid-run, the turn so far: the message, what it said, and the step it ran", () => {
  const screen = screenAfter(upToFrameWith("Ran\x1b"));
  expect(ggcoderWorking(screen.title)).toBe(true);
  expect(ggcoderTurn(screen)).toEqual([
    { role: "user", text: PROMPT },
    { role: "agent", text: "Starting the check now." },
    { role: "tool", text: "Ran sleep 3; echo one · exit 0" },
  ]);
});

test("at the end, the whole run, and the title says it stopped", () => {
  const screen = screenAfter(RECORDING);
  expect(ggcoderWorking(screen.title)).toBe(false);
  const turn = ggcoderTurn(screen);
  expect(turn[0]).toEqual({ role: "user", text: PROMPT });
  expect(turn.filter((m) => m.role === "agent").map((m) => m.text)).toEqual([
    "Starting the check now.",
    "Halfway there.",
    "All done.",
  ]);
  // Ink folds finished steps into the summary line; nothing of the spinner,
  // rules or the summary is ever taken for something said.
  expect(turn.some((m) => /Working|Executed|Ready to go|─/.test(m.text))).toBe(false);
});

test("before any message, there is no turn", () => {
  const screen = screenAfter(RECORDING.slice(0, RECORDING.indexOf("First say")));
  expect(ggcoderTurn(screen)).toEqual([]);
});

test("the watcher reports a run as it happens, numbered, without repeating itself", async () => {
  const reports: ScreenTurn[] = [];
  const watcher = ggcoderScreenWatcher((turn) => reports.push(turn), {
    rows: () => 30,
    throttleMs: 5,
  });
  const bytes = new TextEncoder().encode(RECORDING);
  for (let at = 0; at < bytes.length; at += 4096) {
    watcher.feed(bytes.subarray(at, at + 4096));
    await Bun.sleep(1);
  }
  watcher.flush();
  // It went working, then idle, all within one numbered run.
  expect(reports.some((r) => r.activity === "working")).toBe(true);
  expect(reports.at(-1)?.activity).toBe("idle");
  const runs = new Set(reports.filter((r) => r.items.length > 0).map((r) => r.turn));
  expect(runs.size).toBe(1);
  // The step was seen live, before the run ended.
  expect(
    reports.some(
      (r) =>
        r.activity === "working" && r.items.some((m) => m.text.startsWith("Ran sleep 3; echo one")),
    ),
  ).toBe(true);
  // No two reports in a row say the same thing.
  for (let i = 1; i < reports.length; i++) {
    expect(JSON.stringify(reports[i])).not.toBe(JSON.stringify(reports[i - 1]));
  }
});

test("a long run is cut to fit one line on the wrapper's link, keeping the message and the newest", () => {
  const screen = new ScreenModel(() => 30);
  const rule = "▄".repeat(40);
  const floor = "▀".repeat(40);
  const replies = Array.from({ length: 80 }, (_, i) => ` ⏺ ${`reply ${i} `.repeat(30)}\r\n`).join(
    "",
  );
  screen.feed(
    `${rule}\r\n > ${"m".repeat(500)}\r\n${floor}\r\n${replies}${rule}\r\n >   Type your message\r\n${floor}\r\n`,
  );
  const turn = ggcoderTurn(screen);
  expect(turn[0]?.role).toBe("user");
  expect(turn.at(-1)?.text.startsWith("reply 79")).toBe(true);
  expect(JSON.stringify(turn).length).toBeLessThan(32 * 1024);
});

test("an escape split across two reads is finished, not lost", () => {
  const screen = new ScreenModel(() => 10);
  screen.feed("\x1b]0;● proj");
  screen.feed("\x07hello\x1b[");
  screen.feed("1mworld");
  expect(screen.title).toBe("● proj");
  expect(screen.text().at(-1)).toBe("helloworld");
  expect(screen.cells().at(-1)?.[5]?.bold).toBe(true);
});

test("without colour, a step is still told from a reply by its verb and how it ends", () => {
  const screen = new ScreenModel(() => 30);
  const top = "▄".repeat(30);
  const floor = "▀".repeat(30);
  screen.feed(
    [
      top,
      " > check it",
      floor,
      " ⏺ Read the README first, then we can talk.",
      " ⏺ Running npm test…",
      " ⏺ Ran sleep 4; echo one · exit 0",
      " ⏺ Read config.ts · 42 lines",
      top,
      " >   Type your message",
      floor,
      "",
    ].join("\r\n"),
  );
  expect(ggcoderTurn(screen).map((m) => m.role)).toEqual(["user", "agent", "tool", "tool", "tool"]);
});
