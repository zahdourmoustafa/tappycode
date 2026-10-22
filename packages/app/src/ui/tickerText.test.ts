import { expect, test } from "bun:test";
import { IDLE_ACTIVITY, type Activity } from "../activity";
import { receiptLength, receiptParts, revealParts, tickerLine, tickerSteps } from "./tickerText";

const busy: Activity = {
  startedAt: 0,
  speaking: false,
  tools: [
    { id: "a", title: "Read cursors.ts", kind: "read", status: "completed" },
    { id: "b", title: "advanceCursor", kind: "search", status: "in_progress" },
  ],
};

test("steps name verb and target, marking the live one", () => {
  expect(tickerSteps(busy)).toEqual([
    { id: "a", verb: "READ", target: "cursors.ts", state: "done" },
    { id: "b", verb: "SEARCH", target: "advanceCursor", state: "live" },
  ]);
});

test("working line joins the recent steps", () => {
  const line = tickerLine({ working: true, activity: busy, offline: false });
  expect(line).toEqual({
    text: "READ cursors.ts · SEARCH advanceCursor …",
    tone: "agent",
    mood: "working",
  });
});

test("needs you beats everything, offline beats ready", () => {
  expect(
    tickerLine({ working: true, activity: busy, offline: true, needs: "Run tests" }).tone,
  ).toBe("attention");
  expect(tickerLine({ working: false, activity: IDLE_ACTIVITY, offline: true }).text).toBe(
    "OFFLINE · MESSAGES WAIT",
  );
});

test("ready names the project and changes", () => {
  expect(
    tickerLine({
      working: false,
      activity: IDLE_ACTIVITY,
      offline: false,
      project: "tappy",
      changes: 3,
    }).text,
  ).toBe("READY · tappy · +3");
  expect(tickerLine({ working: false, activity: IDLE_ACTIVITY, offline: false }).text).toBe(
    "READY",
  );
});

test("receipt types on segment by segment", () => {
  const parts = receiptParts({ verb: "Edited", duration: "14s", tools: 3, failed: 1 });
  expect(parts.map((p) => p.text)).toEqual(["3 STEPS", "1 FAILED", "14s"]);
  expect(revealParts(parts, 0)).toEqual([]);
  expect(revealParts(parts, 9).map((p) => p.text)).toEqual(["3 STEPS", "1"]);
  expect(revealParts(parts, receiptLength(parts))).toEqual(parts);
});

test("a goal's ticker carries Ken's latest line while idle", () => {
  const idle = { working: false, activity: IDLE_ACTIVITY, offline: false, project: "tappy" };
  expect(tickerLine({ ...idle, say: "Builder is wiring the sidebar." }).text).toBe(
    "KEN · Builder is wiring the sidebar.",
  );
  expect(tickerLine({ ...idle, say: "  " }).text).toBe("READY · tappy");
  expect(tickerLine({ ...idle, say: "hi", needs: "Run tests" }).tone).toBe("attention");
});

test("a terminal the phone follows says what it is doing, not Ready", () => {
  const idle = { ...IDLE_ACTIVITY };
  expect(
    tickerLine({
      working: true,
      activity: idle,
      offline: false,
      step: "Run a command · 12 times…",
    }),
  ).toEqual({
    text: "Run a command · 12 times …",
    tone: "agent",
    mood: "working",
  });
  expect(
    tickerLine({ working: true, activity: idle, offline: false, step: "Ran npm test · exit 0" })
      .text,
  ).toBe("Ran npm test · exit 0");
  // Nothing known yet: still working, never Ready.
  expect(tickerLine({ working: true, activity: idle, offline: false }).text).toBe("THINKING …");
  expect(
    tickerLine({ working: false, activity: idle, offline: false, project: "geevs" }).text,
  ).toBe("READY · geevs");
});
