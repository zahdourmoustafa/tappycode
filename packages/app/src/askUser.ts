/**
 * GG Coder's `ask_user` questions: reading them off the wire and building the
 * answer. Ported from gg-app's `ask-user.ts` / `AskBand.tsx` rules. Expo-free.
 */
import type { wire } from "@tappy/protocol";

export type AskQuestion = wire.AskQuestion;
export type AskOption = wire.AskOption;
export type AskRequest = wire.AskRequest;
export type AskResult = wire.AskResult;
export type AskAnswer = string | string[];

/** What the agent gets back for an option: its value, else its label. */
export function optionValue(option: AskOption): string {
  return option.value ?? option.label;
}

/** Free text is offered unless the agent opts out; always on `text`. */
export function allowsOther(question: AskQuestion): boolean {
  return question.kind === "text" || question.allowOther !== false;
}

/** The rows a question offers. A `confirm` with none means Yes / No. */
export function questionOptions(question: AskQuestion): AskOption[] {
  if (question.kind === "text") return [];
  const options = question.options ?? [];
  if (options.length > 0) return options;
  return question.kind === "confirm" ? [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }] : [];
}

/** A one-line nudge under a question. */
export function questionHint(question: AskQuestion): string | undefined {
  if (question.kind === "text") return undefined;
  const pick = question.kind === "multi" ? "Pick any that apply" : "Pick one";
  return allowsOther(question) ? `${pick}, or write your own` : pick;
}

function isOption(value: unknown): value is AskOption {
  if (typeof value !== "object" || value === null) return false;
  const option = value as Record<string, unknown>;
  return typeof option.label === "string" &&
    (option.value === undefined || typeof option.value === "string") &&
    (option.hint === undefined || typeof option.hint === "string");
}

const KINDS = new Set(["confirm", "choice", "multi", "text"]);

function isQuestion(value: unknown): value is AskQuestion {
  if (typeof value !== "object" || value === null) return false;
  const q = value as Record<string, unknown>;
  return typeof q.id === "string" &&
    typeof q.question === "string" &&
    typeof q.kind === "string" && KINDS.has(q.kind) &&
    // A non-array here once blanked a whole window in gg-app.
    (q.options === undefined || (Array.isArray(q.options) && q.options.every(isOption)));
}

/** An `ask_user` request in any shape the daemon sends it, or undefined. */
export function readAskRequest(value: unknown): AskRequest | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { requestId, questions } = value as Record<string, unknown>;
  if (typeof requestId !== "string" || !Array.isArray(questions) || questions.length === 0) return undefined;
  if (!questions.every(isQuestion)) return undefined;
  return { requestId, questions };
}

/** A logged `session.event` payload `{kind:"ask_user", requestId, questions}`. */
export function readAskEvent(payload: unknown): AskRequest | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  if ((payload as { kind?: unknown }).kind !== "ask_user") return undefined;
  return readAskRequest(payload);
}

/** `Replay.asks`: undefined stays undefined (older daemon), junk entries drop. */
export function readAskList(value: unknown): AskRequest[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((entry) => {
    const ask = readAskRequest(entry);
    return ask ? [ask] : [];
  });
}

/** What the card holds while the user decides. */
export interface AskDraft {
  /** Picked option values, per question. One for single kinds, any for multi. */
  picks: Record<string, string[]>;
  /** Free text, per question. */
  other: Record<string, string>;
}

export const EMPTY_DRAFT: AskDraft = { picks: {}, other: {} };

/** Tap an option. Single kinds replace (and clear typed text); multi toggles. */
export function pickOption(draft: AskDraft, question: AskQuestion, value: string): AskDraft {
  const current = draft.picks[question.id] ?? [];
  if (question.kind === "multi") {
    const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
    return { ...draft, picks: { ...draft.picks, [question.id]: next } };
  }
  const next = current[0] === value ? [] : [value];
  const other = { ...draft.other };
  delete other[question.id];
  return { picks: { ...draft.picks, [question.id]: next }, other };
}

/** Type free text. On a single kind it replaces the picked option. */
export function typeOther(draft: AskDraft, question: AskQuestion, text: string): AskDraft {
  const other = { ...draft.other, [question.id]: text };
  if (question.kind === "multi" || text.trim().length === 0) return { ...draft, other };
  return { picks: { ...draft.picks, [question.id]: [] }, other };
}

/** One question's answer, or undefined while it has none. */
export function answerFor(draft: AskDraft, question: AskQuestion): AskAnswer | undefined {
  const typed = allowsOther(question) ? (draft.other[question.id] ?? "").trim() : "";
  const picks = question.kind === "text" ? [] : (draft.picks[question.id] ?? []);
  if (question.kind === "multi") {
    const all = typed ? [...picks, typed] : picks;
    return all.length > 0 ? all : undefined;
  }
  if (typed) return typed;
  return picks[0];
}

/**
 * The whole card's answer: every question answered, keyed by question id.
 * Undefined until complete — a half-filled form never reaches the agent.
 */
export function buildAskResult(questions: readonly AskQuestion[], draft: AskDraft): AskResult | undefined {
  const answers: Record<string, AskAnswer> = {};
  for (const question of questions) {
    const answer = answerFor(draft, question);
    if (answer === undefined) return undefined;
    answers[question.id] = answer;
  }
  return { action: "answer", answers };
}

export const CANCEL_RESULT: AskResult = { action: "cancel" };
