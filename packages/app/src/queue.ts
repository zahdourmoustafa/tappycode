/**
 * Messages sent while a turn runs, waiting for the agent to pick them up.
 *
 * The daemon owns the queue (`session.queue`, replace-list, broadcast); this
 * module is the app's reading of it. Expo-free so `bun test` can load it.
 */
import type { wire } from "@tappy/protocol";

export type QueuedMessage = wire.QueuedMessage;

/** Copy used by the strip. "Next turn", not "after this run": see GG's QueuedBar. */
export const QUEUED_WHEN = "queued for the next turn";

/** First line of a queued message, clipped for one row. */
export function queuePreview(text: string, max = 64): string {
  const firstLine = text.split("\n")[0] ?? text;
  return firstLine.length > max ? `${firstLine.slice(0, max - 1)}\u2026` : firstLine;
}

export type QueueSummary =
  | { kind: "none" }
  | { kind: "single"; message: QueuedMessage; preview: string }
  | { kind: "several"; count: number; label: string };

/**
 * One message is cancelled in place; several need the list open first, because
 * an × on a collapsed count would be a guess about which one it cancels.
 */
export function summariseQueue(queued: readonly QueuedMessage[]): QueueSummary {
  const first = queued[0];
  if (!first) return { kind: "none" };
  if (queued.length === 1) return { kind: "single", message: first, preview: queuePreview(first.text) };
  return { kind: "several", count: queued.length, label: `${queued.length} messages ${QUEUED_WHEN}` };
}

/**
 * What to put back into the composer for messages the daemon handed back
 * unsent (a cancelled turn). Only into an empty draft: overwriting words the
 * user is typing would destroy them.
 */
export function returnedDraft(
  returned: readonly QueuedMessage[] | undefined,
  draft: string,
): string | undefined {
  if (!returned || returned.length === 0) return undefined;
  if (draft.trim().length > 0) return undefined;
  const text = returned
    .map((message) => message.text.trim())
    .filter((text) => text.length > 0)
    .join("\n\n");
  return text.length > 0 ? text : undefined;
}

/**
 * Whether a prompt to this conversation will be queued by the daemon rather
 * than start a turn: it went out over a live socket while the agent is
 * mid-turn. Such a message is shown in the strip, not as a transcript bubble —
 * the daemon logs it as a `user_message` at the moment the agent reads it.
 */
export function sendsToQueue(state: { sent: boolean; busy: boolean; loading: boolean }): boolean {
  return state.sent && state.busy && !state.loading;
}
