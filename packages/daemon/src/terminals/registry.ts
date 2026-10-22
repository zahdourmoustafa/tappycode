/**
 * The terminals a phone can type into, and the only route bytes take to reach one.
 *
 * A terminal exists here only because a `tappy wrap` process connected to the
 * local socket and registered the agent it is running (`socket.ts`). The phone
 * addresses input by the opaque id minted below, never by a tty, pid or path,
 * so a `terminal.input` frame can only ever land in a PTY that a wrapper offered
 * — not in an arbitrary process, and not in the user's shell.
 */
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { wire } from "@tappy/protocol";

/** What the wrapper side must provide: somewhere to deliver keystrokes. */
export interface TerminalLink {
  agent: wire.TerminalAgent;
  cwd: string;
  /** The agent's process id, when the wrapper sent one. */
  pid?: number;
  /** The macOS app the terminal belongs to, by bundle id. */
  app?: string;
  /** When the wrapper started, if it said; otherwise now. */
  since?: number;
  /** Hand bytes to the wrapper. Returns false once the link is gone. */
  deliver: (data: string) => boolean;
}

type Activity = "working" | "waiting" | "idle";
type Question = { text: string; options: Array<{ key: string; label: string }> };

interface Entry extends TerminalLink {
  id: string;
  startedAt: number;
  mode?: string;
  conversation?: string;
  prompt?: "trust";
  activity?: Activity;
  question?: Question;
}

/** What a wrapper reports off its agent's screen, beyond what the list shows. */
export interface ScreenReports {
  /** A run started or ended, for an agent whose files cannot tell. */
  activity?: (id: string, activity: "working" | "idle") => void;
  /** The run as the screen shows it (`ggcoder-screen.ts`). */
  live?: (id: string, live: { turn: number; messages: wire.TerminalMessage[] }) => void;
}

export class TerminalRegistry {
  private readonly entries = new Map<string, Entry>();

  constructor(
    /** Told after every add and remove, so the daemon can re-announce the list. */
    private readonly onChange: () => void = () => {},
    private readonly now: () => number = Date.now,
    private readonly reports: ScreenReports = {},
  ) {}

  /** A wrapper's report that a run started or ended. Ignored for a terminal that has gone. */
  reportActivity(id: string, activity: "working" | "idle"): void {
    if (this.entries.has(id)) this.reports.activity?.(id, activity);
  }

  /** A wrapper's report of the run on screen. Ignored for a terminal that has gone. */
  reportLive(id: string, live: { turn: number; messages: wire.TerminalMessage[] }): void {
    if (this.entries.has(id)) this.reports.live?.(id, live);
  }

  /** Record a newly wrapped agent. Returns the id the phone will address. */
  register(link: TerminalLink): string {
    // Random rather than a counter: the id is the only handle input travels by,
    // so it should not be something a stale client could guess its way into.
    const id = `term_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    const now = this.now();
    // The wrapper's own start time, trusted only if it is plausible: never in
    // the future, never before this machine could have been running it.
    const startedAt =
      link.since && link.since <= now && link.since > now - 30 * 86_400_000 ? link.since : now;
    this.entries.set(id, { ...link, id, startedAt });
    this.onChange();
    return id;
  }

  /** The mode the agent's screen shows now. Announced only when it changed. */
  setMode(id: string, mode: string): void {
    const entry = this.entries.get(id);
    if (!entry || entry.mode === mode) return;
    entry.mode = mode;
    this.onChange();
  }

  /** The question the agent's screen is waiting on, or none. Announced only when it changed. */
  setPrompt(id: string, prompt: "trust" | undefined): void {
    const entry = this.entries.get(id);
    if (!entry || entry.prompt === prompt) return;
    entry.prompt = prompt;
    this.onChange();
  }

  /**
   * What the agent says it is doing. Returns what it was doing before, so the
   * caller can tell a turn finishing from one that never started; announced
   * only when it changed.
   */
  setActivity(id: string, activity: Activity): Activity | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    const before = entry.activity;
    if (before === activity) return before;
    entry.activity = activity;
    this.onChange();
    return before;
  }

  /** The numbered question on the agent's screen, or none. Announced only when it changed. */
  setQuestion(id: string, question: Question | undefined): void {
    const entry = this.entries.get(id);
    if (!entry || JSON.stringify(entry.question) === JSON.stringify(question)) return;
    entry.question = question;
    if (entry.activity === "waiting") this.onChange();
  }

  /** The question a terminal is stopped on right now, if it is stopped on one. */
  questionOf(id: string): Question | undefined {
    const entry = this.entries.get(id);
    return entry?.activity === "waiting" ? entry.question : undefined;
  }

  /** The agent's own id for the conversation it is in now. Announced only when it changed. */
  setConversation(id: string, conversation: string | undefined): void {
    const entry = this.entries.get(id);
    if (!entry || entry.conversation === conversation) return;
    entry.conversation = conversation;
    this.onChange();
  }

  /** Forget a terminal: its wrapper disconnected or the agent exited. */
  remove(id: string): void {
    if (this.entries.delete(id)) this.onChange();
  }

  /**
   * Type into one terminal. False when there is no such terminal, or its link
   * has gone away — in which case it is dropped so the phone stops offering it.
   */
  write(id: string, data: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    if (entry.deliver(data)) return true;
    this.remove(id);
    return false;
  }

  /** Every live terminal, oldest first, in the shape the phone lists. */
  list(): wire.TerminalInfo[] {
    return [...this.entries.values()]
      .sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))
      .map(({ id, agent, cwd, startedAt, mode, conversation, prompt, activity, question }) => ({
        id,
        agent,
        cwd,
        folder: basename(cwd) || cwd,
        startedAt,
        ...(mode ? { mode } : {}),
        ...(conversation ? { conversation } : {}),
        ...(prompt ? { prompt } : {}),
        ...(activity ? { activity } : {}),
        // Only while the agent itself says it is waiting: what was read off the
        // screen can linger after an answer, the agent's own status cannot.
        ...(activity === "waiting" && question ? { question } : {}),
      }));
  }

  /** Every live terminal with what only the daemon needs: the agent's pid. */
  links(): Array<{
    id: string;
    agent: wire.TerminalAgent;
    cwd: string;
    pid?: number;
    startedAt: number;
    app?: string;
  }> {
    return [...this.entries.values()].map(({ id, agent, cwd, pid, startedAt, app }) => ({
      id,
      agent,
      cwd,
      pid,
      startedAt,
      app,
    }));
  }

  get size(): number {
    return this.entries.size;
  }
}
