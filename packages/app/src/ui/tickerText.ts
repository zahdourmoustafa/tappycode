/**
 * What the chat's LED ticker says, and the step list it drops down.
 *
 * Pure (no React Native) so `bun test` can read it: `Ticker.tsx` only draws.
 * Tool calls never reach the thread; this is the one place they are named.
 */
import type { Activity, ToolKind, ToolRun, TurnReceipt } from "../activity";

export type TickerTone = "agent" | "attention" | "dim";
export type TickerMood = "working" | "talking" | "thinking" | "sleepy" | "idle";

export interface TickerStep {
  id: string;
  verb: string;
  target: string;
  state: "done" | "live" | "failed";
}

const VERBS: Record<ToolKind, string> = {
  read: "READ",
  edit: "EDIT",
  delete: "DELETE",
  move: "MOVE",
  search: "SEARCH",
  execute: "RUN",
  think: "THINK",
  fetch: "FETCH",
  other: "TOOL",
};

/** Agents title tools "Read cursors.ts"; the verb is already said, so drop it. */
function targetOf(tool: ToolRun, verb: string): string {
  const title = tool.title.trim();
  const [first = "", ...rest] = title.split(/\s+/);
  const lead = first.toUpperCase();
  if (rest.length > 0 && (lead === verb || lead.startsWith(verb.slice(0, 4))))
    return rest.join(" ");
  return title;
}

export function tickerSteps(activity: Activity): TickerStep[] {
  return activity.tools.map((tool) => {
    const verb = VERBS[tool.kind];
    const running = tool.status === "pending" || tool.status === "in_progress";
    return {
      id: tool.id,
      verb,
      target: targetOf(tool, verb),
      state: running ? "live" : tool.status === "failed" ? "failed" : "done",
    };
  });
}

export interface TickerInput {
  working: boolean;
  activity: Activity;
  /**
   * What a terminal the phone follows is doing, when it is that terminal
   * working rather than one of the app's own chats: its latest step, as the
   * terminal shows it ("Ran npm test · exit 0"). Steps of the app's own
   * activity win when there are any.
   */
  step?: string;
  /** What a pending permission or question asks, when one is open. */
  needs?: string;
  offline: boolean;
  project?: string;
  /** Uncommitted files, when the daemon reported them. */
  changes?: number;
  /** A goal's coordinator (Ken) speaking: his latest line, shown while idle. */
  say?: string;
}

export interface TickerLine {
  text: string;
  tone: TickerTone;
  mood: TickerMood;
}

const stepLabel = (step: TickerStep) => (step.target ? `${step.verb} ${step.target}` : step.verb);

/** Priority: needs you, offline, working, ready. */
export function tickerLine(input: TickerInput): TickerLine {
  if (input.needs !== undefined) {
    const what = input.needs.trim();
    return {
      text: what ? `NEEDS YOU · ${what}` : "NEEDS YOU",
      tone: "attention",
      mood: "thinking",
    };
  }
  if (input.offline) return { text: "OFFLINE · MESSAGES WAIT", tone: "dim", mood: "sleepy" };
  if (input.working) {
    const steps = tickerSteps(input.activity);
    const recent = steps.slice(-2).map(stepLabel);
    const live = steps.some((step) => step.state === "live");
    const mood: TickerMood = input.activity.speaking ? "talking" : live ? "working" : "thinking";
    if (recent.length === 0) {
      const step = input.step?.trim();
      if (step) {
        const running = step.endsWith("…");
        return {
          text: running ? `${step.slice(0, -1).trim()} …` : step,
          tone: "agent",
          mood: running ? "working" : "thinking",
        };
      }
      return { text: input.activity.speaking ? "WRITING …" : "THINKING …", tone: "agent", mood };
    }
    return { text: `${recent.join(" · ")}${live ? " …" : ""}`, tone: "agent", mood };
  }
  const said = input.say?.trim();
  if (said) return { text: `KEN · ${said}`, tone: "agent", mood: "talking" };
  const parts = ["READY"];
  if (input.project) parts.push(input.project);
  if (input.changes !== undefined && input.changes > 0) parts.push(`+${input.changes}`);
  return { text: parts.join(" · "), tone: "agent", mood: "idle" };
}

export interface ReceiptPart {
  text: string;
  tone: "dim" | "plus" | "minus";
}

/** The finished turn as LED segments: what it touched, what failed, how long. */
export function receiptParts(receipt: TurnReceipt): ReceiptPart[] {
  const parts: ReceiptPart[] = [];
  if (receipt.tools > 0)
    parts.push({ text: `${receipt.tools} ${receipt.tools === 1 ? "STEP" : "STEPS"}`, tone: "dim" });
  // Not "+ok −failed": in a coding app a plus and a minus read as lines added
  // and removed, which the receipt doesn't know. Failures are named instead.
  if (receipt.failed > 0) parts.push({ text: `${receipt.failed} FAILED`, tone: "minus" });
  parts.push({ text: receipt.duration, tone: "dim" });
  return parts;
}

/** Splits a typed-on reveal of `shown` characters across the segments (with one-space gaps). */
export function revealParts(parts: ReceiptPart[], shown: number): ReceiptPart[] {
  const out: ReceiptPart[] = [];
  let left = shown;
  for (const [i, part] of parts.entries()) {
    const gap = i === 0 ? 0 : 1;
    left -= gap;
    if (left <= 0) break;
    out.push({ ...part, text: part.text.slice(0, left) });
    left -= part.text.length;
  }
  return out;
}

export const receiptLength = (parts: ReceiptPart[]) =>
  parts.reduce((sum, part, i) => sum + part.text.length + (i === 0 ? 0 : 1), 0);

/** The receipt read aloud. */
export const receiptText = (receipt: TurnReceipt) =>
  receiptParts(receipt)
    .map((part) => part.text)
    .join(" ");
