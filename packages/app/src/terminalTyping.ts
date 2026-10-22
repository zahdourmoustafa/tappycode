/**
 * Typing on the phone, keystroke by keystroke, into an agent running in a
 * terminal on the laptop.
 *
 * Pure: no Expo, no React. The composer hands over its text on every change and
 * this works out the keystrokes that turn what the terminal already has into
 * what the phone now shows.
 */

/** A live terminal, as the daemon lists it (`wire.TerminalInfo`). */
export interface Terminal {
  id: string;
  agent: "claude" | "codex" | "ggcoder";
  cwd: string;
  folder: string;
  startedAt: number;
  /** The permission mode the agent's screen shows now, as its config value; Claude only. */
  mode?: string;
  /** The agent's own id for the conversation it is in, once known. */
  conversation?: string;
  /** A question the agent's screen is waiting on that the phone can answer. */
  prompt?: "trust";
  /** What the agent says it is doing: on a turn, stopped on the person, or at its prompt. */
  activity?: "working" | "waiting" | "idle";
  /** The numbered question it is stopped on; answering is typing the number. */
  question?: { text: string; options: Array<{ key: string; label: string }> };
}

/** DEL — what a terminal's Backspace key sends. */
export const BACKSPACE = "\x7f";
/** Return — what submits a line in every agent this drives. */
export const ENTER = "\r";

/**
 * The keystrokes that turn `typed` (already sent) into `next`.
 *
 * Edits are taken at the end of the text: everything after the first point the
 * two differ is rubbed out with backspaces and retyped. That is exact for the
 * ordinary cases — typing on, deleting from the end, autocorrect replacing the
 * last word — and still correct, if wordier, for an edit in the middle.
 *
 * Counted in code points, not UTF-16 units: an emoji is one backspace in a
 * terminal, and splitting it in half would leave a broken character behind.
 */
export function keystrokesFor(typed: string, next: string): string {
  const before = Array.from(typed);
  const after = Array.from(next);
  let same = 0;
  while (same < before.length && same < after.length && before[same] === after[same]) same++;
  return BACKSPACE.repeat(before.length - same) + after.slice(same).join("");
}

/** The terminal agent a provider manifest corresponds to, if any. */
export function agentForProvider(providerId: string | undefined): Terminal["agent"] | undefined {
  switch (providerId) {
    case "claude-code":
      return "claude";
    case "codex":
      return "codex";
    case "ggcoder":
      return "ggcoder";
    default:
      return undefined;
  }
}

/** A path without a trailing slash, so `/p/app/` and `/p/app` are one project. */
function samePath(a: string, b: string): boolean {
  const strip = (path: string) => (path.length > 1 ? path.replace(/\/+$/, "") : path);
  return strip(a) === strip(b);
}

/**
 * The terminal the composer should type into: the same agent, open in the same
 * project as the conversation on screen. The newest wins when there are two,
 * because that is the window someone just opened.
 */
export function linkedTerminal(
  terminals: readonly Terminal[],
  providerId: string | undefined,
  cwd: string | undefined,
): Terminal | undefined {
  const agent = agentForProvider(providerId);
  if (!agent || !cwd) return undefined;
  let best: Terminal | undefined;
  for (const terminal of terminals) {
    // The whole path, never the folder name: `~/work/app` and `~/play/app` are
    // different projects, and typing into the wrong one is the mistake to avoid.
    if (terminal.agent !== agent || !samePath(terminal.cwd, cwd)) continue;
    if (!best || terminal.startedAt > best.startedAt) best = terminal;
  }
  return best;
}

/**
 * The daemon's per-frame cap (`wire.MAX_TERMINAL_INPUT`). Measured the way the
 * daemon's schema measures it — `string.length`, UTF-16 units — so an emoji
 * counts as two here too, or a frame of them would be refused.
 */
export const MAX_FRAME = 4096;

/** Keystrokes split into frames the daemon accepts, never splitting a character. */
export function framesOf(keys: string): string[] {
  const frames: string[] = [];
  let frame = "";
  for (const char of keys) {
    if (frame.length + char.length > MAX_FRAME) {
      frames.push(frame);
      frame = "";
    }
    frame += char;
  }
  if (frame) frames.push(frame);
  return frames;
}

/** The provider manifest id for a terminal agent: the inverse of {@link agentForProvider}. */
export function providerForAgent(agent: Terminal["agent"]): string {
  return agent === "claude" ? "claude-code" : agent;
}

/**
 * The terminal the phone should follow, if any.
 *
 * Opening an agent on the laptop is how someone says "this is what I am working
 * on", so the phone switches to that agent and project by itself — the newest
 * terminal it has not followed yet. Only on arrival: once followed, an id is
 * never followed again, so picking something else on the phone sticks.
 *
 * Never while the phone is busy with something of its own: a conversation open
 * on screen, or words in the composer. Yanking either away to chase a window
 * the user may not even be looking at would lose their place.
 */
export function terminalToFollow(
  terminals: readonly Terminal[],
  followed: ReadonlySet<string>,
  busy: boolean,
): Terminal | undefined {
  if (busy) return undefined;
  let newest: Terminal | undefined;
  for (const terminal of terminals) {
    if (followed.has(terminal.id)) continue;
    if (!newest || terminal.startedAt > newest.startedAt) newest = terminal;
  }
  return newest;
}

/** One line of a terminal's conversation (`wire.TerminalMessage`). */
export interface TerminalMessage {
  role: "user" | "agent" | "tool";
  text: string;
}

/** The phone's copy of a terminal's conversation: messages from `start` on. */
export interface TerminalTranscript {
  start: number;
  messages: TerminalMessage[];
}

/** The daemon's `terminal.transcript` frame, as far as folding it needs. */
export interface TerminalTranscriptFrame {
  terminalId: string;
  start: number;
  reset: boolean;
  messages: TerminalMessage[];
}

/** How many messages the phone holds per terminal; older ones fall off the front. */
const KEEP_MESSAGES = 1000;

/**
 * Fold one `terminal.transcript` frame into the phone's copies.
 *
 * A reset replaces. An update is kept only when it starts exactly where the
 * phone's copy ends: anything else means a frame went missing, and the gap is
 * not papered over — the next connect sends the whole thing again. Returns the
 * same object when nothing changed, so React skips the render.
 */
export function foldTranscript(
  transcripts: Readonly<Record<string, TerminalTranscript>>,
  frame: TerminalTranscriptFrame,
): Record<string, TerminalTranscript> {
  const messages = Array.isArray(frame.messages) ? frame.messages : [];
  let next: TerminalTranscript;
  if (frame.reset) {
    next = { start: frame.start, messages };
  } else {
    const held = transcripts[frame.terminalId];
    if (!held || frame.start !== held.start + held.messages.length || messages.length === 0) {
      return transcripts as Record<string, TerminalTranscript>;
    }
    next = { start: held.start, messages: [...held.messages, ...messages] };
  }
  const drop = next.messages.length - KEEP_MESSAGES;
  if (drop > 0) next = { start: next.start + drop, messages: next.messages.slice(drop) };
  return { ...transcripts, [frame.terminalId]: next };
}

/** Copies for terminals that have closed, dropped; the same object when there are none. */
export function pruneTranscripts<T>(
  transcripts: Readonly<Record<string, T>>,
  terminals: readonly Pick<Terminal, "id">[],
): Record<string, T> {
  const open = new Set(terminals.map((terminal) => terminal.id));
  const ids = Object.keys(transcripts);
  if (ids.every((id) => open.has(id))) return transcripts as Record<string, T>;
  return Object.fromEntries(ids.filter((id) => open.has(id)).map((id) => [id, transcripts[id]!]));
}

/**
 * The step a terminal's run is on: the one still running (drawn ending `…`),
 * else the last one listed. Undefined with no steps.
 */
export function currentStep(live: readonly TerminalMessage[] | undefined): string | undefined {
  const steps = (live ?? []).filter((m) => m.role === "tool");
  return (steps.find((m) => m.text.trimEnd().endsWith("…")) ?? steps.at(-1))?.text;
}

/** The daemon's `terminal.live` frame, as far as folding it needs. */
export interface TerminalLiveFrame {
  terminalId: string;
  messages: TerminalMessage[];
}

/**
 * Fold one `terminal.live` frame in: it replaces that terminal's run outright,
 * and an empty one removes it. The same object when nothing changed.
 */
export function foldLive(
  live: Readonly<Record<string, TerminalMessage[]>>,
  frame: TerminalLiveFrame,
): Record<string, TerminalMessage[]> {
  const messages = Array.isArray(frame.messages)
    ? frame.messages.filter(
        (m) =>
          m &&
          typeof m.text === "string" &&
          (m.role === "user" || m.role === "agent" || m.role === "tool"),
      )
    : [];
  if (messages.length === 0) {
    if (!(frame.terminalId in live)) return live as Record<string, TerminalMessage[]>;
    const { [frame.terminalId]: _gone, ...rest } = live;
    return rest;
  }
  return { ...live, [frame.terminalId]: messages };
}

/** A turn of the chat thread, as far as a terminal's conversation fills one. */
export interface TerminalTurn {
  id: string;
  role: "user" | "agent" | "note";
  text: string;
}

/**
 * A terminal's conversation as chat turns.
 *
 * Claude writes one reply as several lines — a paragraph, a tool call, the
 * next paragraph — so neighbouring pieces of agent text are joined into one
 * bubble, and each tool step becomes a quiet note between them. Ids are the
 * position in the conversation, so a bubble keeps its identity as text joins
 * it and the list never re-renders what is already on screen.
 */
export function terminalTurns(
  terminalId: string,
  transcript: TerminalTranscript | undefined,
  live: readonly TerminalMessage[] = [],
): TerminalTurn[] {
  const saved = transcript?.messages ?? [];
  const start = transcript?.start ?? 0;
  // The run in progress follows what the file has. Its ids carry their own
  // prefix: once the file catches up these turns go and the saved ones come,
  // and a shared id would make the list reuse a bubble for different text.
  const all = [
    ...saved.map((message, index) => ({ message, id: `term:${terminalId}:${start + index}` })),
    ...live.map((message, index) => ({ message, id: `term:${terminalId}:live:${index}` })),
  ];
  if (all.length === 0) return [];
  const turns: TerminalTurn[] = [];
  all.forEach(({ message, id }) => {
    if (message.role === "tool") {
      turns.push({ id, role: "note", text: message.text });
      return;
    }
    const last = turns[turns.length - 1];
    if (message.role === "agent" && last?.role === "agent") {
      last.text = `${last.text}\n\n${message.text}`;
      return;
    }
    turns.push({ id, role: message.role, text: message.text });
  });
  return turns;
}

/** What a terminal's Down arrow sends. */
export const DOWN = "\x1b[B";

/**
 * Claude's "trust this folder?" menu, answered by keystroke. It opens with
 * "No, exit" selected, so trusting is Down then Return, and exiting is Return.
 */
export const TRUST_KEYS = { trust: `${DOWN}${ENTER}`, exit: ENTER } as const;

/**
 * A numbered answer as a button: short enough for a phone, without the hint
 * Claude puts in brackets ("Yes, and switch to accept edits (auto-approve …)").
 */
export function answerLabel(label: string): string {
  const short = label.replace(/\s*\(.*$/, "").trim() || label;
  return short.length > 40 ? `${short.slice(0, 39)}…` : short;
}

/** Whether an answer declines, so it can look like the way out rather than the way on. */
export function isDecline(label: string): boolean {
  return /^(no|deny|cancel|reject|exit)\b/i.test(label.trim());
}

/**
 * The moments in a terminal worth a notification, from what the agent said it
 * was doing before and says now: a turn finishing, or it stopping to ask.
 * Nothing for the first reading — that is where it already was.
 */
export function terminalMoment(
  before: Terminal["activity"],
  now: Terminal["activity"],
): "finished" | "asking" | undefined {
  if (!before || before === now) return undefined;
  if (before === "working" && now === "idle") return "finished";
  if (now === "waiting") return "asking";
  return undefined;
}

/** What a terminal's Shift+Tab key sends. */
export const SHIFT_TAB = "\x1b[Z";

/**
 * Claude's permission modes in the order Shift+Tab cycles through them
 * (Claude Code 2.1, read off a real terminal). Bypass is not in the cycle
 * unless Claude was started with it allowed, so it is not offered here.
 */
export const CLAUDE_MODE_CYCLE = ["auto", "default", "acceptEdits", "plan"] as const;

/** A config value safe to type after a slash command: no spaces, no control characters. */
const COMMAND_ARGUMENT = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,63}$/;

/**
 * A setting picked on the phone, as the keystrokes that make an agent running
 * in a terminal change it — or undefined when that agent cannot be told it by
 * typing. The picker's options come from the agent's own advertised list.
 *
 * Only Claude, and only what was checked against a real Claude Code:
 * `/model <name>` and `/effort <level>` (both may ask to confirm, in a menu the
 * phone cannot see), and the permission mode by pressing Shift+Tab as many
 * times as it takes to get from what its screen shows now to the choice.
 * GG Coder's `/model` takes no argument from the input line — typed one, it
 * went to the model as a message — so nothing is sent for it.
 */
export function terminalConfigKeys(
  terminal: Pick<Terminal, "agent" | "mode">,
  configId: string,
  value: string | boolean,
): { keys: string; command?: string } | undefined {
  if (terminal.agent !== "claude" || typeof value !== "string") return undefined;
  if (configId === "model" || configId === "effort") {
    if (!COMMAND_ARGUMENT.test(value)) return undefined;
    const command = `/${configId} ${value}`;
    return { keys: `${command}${ENTER}`, command };
  }
  if (configId === "mode") {
    const cycle: readonly string[] = CLAUDE_MODE_CYCLE;
    const from = terminal.mode ? cycle.indexOf(terminal.mode) : -1;
    const to = cycle.indexOf(value);
    if (from === -1 || to === -1) return undefined;
    const presses = (to - from + cycle.length) % cycle.length;
    return { keys: SHIFT_TAB.repeat(presses) };
  }
  return undefined;
}
