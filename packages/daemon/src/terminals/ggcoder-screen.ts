/**
 * GG Coder's turn in progress, read off its screen.
 *
 * GG Coder saves a conversation only when a run completes (`onComplete` →
 * `persistNewMessages`), so its session file is silent for the whole time the
 * agent works — a phone following the file saw nothing from "Working…" to the
 * final answer, and showed "Ready" throughout. Everything it does is on the
 * screen the wrapper already proxies, though, so this rebuilds that screen and
 * reads the current turn from it: the message that started it, what the agent
 * has said so far, the steps it has run. The file still owns the record; this
 * is only what fills the gap until the file catches up (see the daemon's live
 * handling, which retires it the moment the file does).
 *
 * The screen is GG Coder's own Ink layout (5.85, read off a real terminal):
 *
 *     ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄
 *      > the person's message          ← a box: their message
 *     ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
 *      ⏺ Starting the check now.       ← plain: the agent talking
 *     ───────────────
 *      ⏺ Ran sleep 3; echo one · exit 0 ← bold verb: a step
 *     ───────────────
 *      ⠧ Working...  (11s)
 *     ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄
 *      >   Type your message…          ← the last box is always the input
 *     ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
 *
 * and its window title carries a `● ` while a run is in progress, which is the
 * one signal that needs no layout reading at all.
 */
import type { wire } from "@tappy/protocol";

/** One cell: the character and whether it was drawn bold. */
interface Cell {
  ch: string;
  bold: boolean;
}

/** Lines kept, scrollback included; beyond this the oldest are dropped. */
const MAX_LINES = 3000;

/**
 * Just enough of a terminal to replay what Ink draws: text, the cursor moves
 * and erases its renderer uses, bold, and the window title. Every line ever
 * drawn is kept (scrollback included), because Ink writes finished history
 * once and only redraws the live area below it.
 */
export class ScreenModel {
  private lines: Cell[][] = [[]];
  private row = 0;
  private col = 0;
  private bold = false;
  private pending = "";
  title = "";
  /**
   * Inside a synchronized update (`CSI ? 2026 h` … `l`): Ink wraps each frame
   * in one, and between the two the screen is half erased. Read it only when
   * this is false.
   */
  syncing = false;

  constructor(private readonly rows: () => number = () => 24) {}

  feed(text: string): void {
    const data = this.pending + text;
    this.pending = "";
    const token =
      // CSI · OSC (BEL or ST) · other ESC · controls · a run of text
      /\x1b\[([0-?]*)[ -/]*([@-~])|\x1b\]([^\x07\x1b]*)(?:\x07|\x1b\\)|\x1b[^[\]]|[\r\n\b\t]|[\x00-\x1a\x1c-\x1f\x7f]|[^\x1b\x00-\x1f\x7f]+/gy;
    let at = 0;
    while (at < data.length) {
      token.lastIndex = at;
      const match = token.exec(data);
      if (!match) {
        // An escape split across two reads: finish it next time.
        this.pending = data.slice(at);
        if (this.pending.length > 4096) this.pending = "";
        return;
      }
      at = token.lastIndex;
      const [whole, params, final, osc] = match;
      if (final !== undefined) this.csi(params ?? "", final);
      else if (osc !== undefined) this.osc(osc);
      else if (whole === "\r") this.col = 0;
      else if (whole === "\n") this.newline();
      else if (whole === "\b") this.col = Math.max(0, this.col - 1);
      else if (whole === "\t") this.col = (Math.floor(this.col / 8) + 1) * 8;
      else if (whole.charCodeAt(0) >= 0x20 && whole[0] !== "\x1b" && whole !== "\x7f")
        this.write(whole);
    }
  }

  /** Every line, scrollback included, as plain text with trailing spaces trimmed. */
  text(): string[] {
    return this.lines.map((line) =>
      line
        .map((cell) => cell.ch)
        .join("")
        .trimEnd(),
    );
  }

  /** Every line with which characters were bold, for telling a step from talk. */
  cells(): readonly (readonly Cell[])[] {
    return this.lines;
  }

  private line(): Cell[] {
    while (this.lines.length <= this.row) this.lines.push([]);
    return this.lines[this.row]!;
  }

  private write(text: string): void {
    const line = this.line();
    for (const ch of text) {
      while (line.length < this.col) line.push({ ch: " ", bold: false });
      line[this.col] = { ch, bold: this.bold };
      this.col++;
    }
  }

  private newline(): void {
    this.row++;
    this.col = 0;
    this.line();
    if (this.lines.length > MAX_LINES) {
      const drop = this.lines.length - MAX_LINES + 500;
      this.lines.splice(0, drop);
      this.row = Math.max(0, this.row - drop);
    }
  }

  private csi(params: string, final: string): void {
    if (params === "?2026" && (final === "h" || final === "l")) {
      this.syncing = final === "h";
      return;
    }
    const parts = params.replace(/^[?>=]/, "").split(";");
    const n = (i = 0, fallback = 1) => {
      const value = Number.parseInt(parts[i] ?? "", 10);
      return Number.isFinite(value) && value > 0 ? value : fallback;
    };
    switch (final) {
      case "A":
        this.row = Math.max(0, this.row - n());
        break;
      case "B":
        this.row += n();
        this.line();
        break;
      case "C":
        this.col += n();
        break;
      case "D":
        this.col = Math.max(0, this.col - n());
        break;
      case "E":
        this.row += n();
        this.col = 0;
        this.line();
        break;
      case "F":
        this.row = Math.max(0, this.row - n());
        this.col = 0;
        break;
      case "G":
        this.col = n() - 1;
        break;
      case "H":
      case "f": {
        // Absolute positions are on the visible screen: its top is this many
        // lines from the end of everything kept.
        const top = Math.max(0, this.lines.length - this.rows());
        this.row = top + n(0) - 1;
        this.col = n(1) - 1;
        this.line();
        break;
      }
      case "K": {
        const line = this.line();
        const mode = parts[0] || "0";
        if (mode === "0") line.length = Math.min(line.length, this.col);
        else if (mode === "1")
          for (let i = 0; i < Math.min(this.col + 1, line.length); i++)
            line[i] = { ch: " ", bold: false };
        else if (mode === "2") line.length = 0;
        break;
      }
      case "J": {
        const mode = parts[0] || "0";
        if (mode === "0") {
          const line = this.line();
          line.length = Math.min(line.length, this.col);
          this.lines.length = this.row + 1;
        } else if (mode === "2" || mode === "3") {
          this.lines = [[]];
          this.row = 0;
          this.col = 0;
        }
        break;
      }
      case "m":
        for (const part of params === "" ? ["0"] : parts) {
          if (part === "0" || part === "") this.bold = false;
          else if (part === "1") this.bold = true;
          else if (part === "22") this.bold = false;
        }
        break;
    }
  }

  private osc(body: string): void {
    const at = body.indexOf(";");
    const kind = body.slice(0, at);
    if (kind === "0" || kind === "2") this.title = body.slice(at + 1);
  }
}

/** The verbs GG Coder draws in bold before a step, running and done (`ui/tool-line-summary.js`). */
const STEP_VERBS = new Set([
  "Reading",
  "Read",
  "Listing",
  "Listed",
  "Searching",
  "Searched",
  "Finding",
  "Found",
  "Writing",
  "Wrote",
  "Updating",
  "Updated",
  "Running",
  "Ran",
  "Fetching",
  "Fetched",
  "Searching web",
  "Searched web",
  "Delegating",
  "Delegated",
  "Loading skill",
  "Loaded skill",
  "Resolving",
  "Resolved",
  "Updating tasks",
  "Updated tasks",
  "Checking checklist",
  "Checked checklist",
  "Capturing",
  "Captured",
  "Entering plan",
  "Entered plan",
  "Submitting plan",
  "Submitted plan",
  "Reading real code",
  "Read real code",
]);

/** The dot GG Coder starts every reply and step with: ⏺ on macOS, ● elsewhere. */
const DOT = /^\s?[⏺●] /;
const BOX_TOP = /^▄+$/;
const BOX_BOTTOM = /^▀+$/;
const RULE = /^─+$/;
/** The spinner line ("⠧ Working…", "⠿ Ready to go..") and the run summary ("✻ Executed…"). */
const CHROME = /^\s?(?:[\u2800-\u28ff]|✻) /;
/** At most this much of a long reply is sent live; the file has the rest moments later. */
const MAX_ITEM_TEXT = 1500;
const MAX_ITEMS = 60;
/**
 * Characters of text per report, newest kept. One report is one line on the
 * wrapper's link, which refuses lines over 64 KiB; this leaves room for JSON
 * escaping (a CJK character is three bytes).
 */
const MAX_TOTAL_TEXT = 12_000;

interface Box {
  top: number;
  bottom: number;
  text: string;
}

/** The ▄…▀ boxes on screen, last first, looking back no further than `limit` lines. */
function boxesFromEnd(lines: string[], limit: number): Box[] {
  const boxes: Box[] = [];
  const stop = Math.max(0, lines.length - limit);
  let bottom = -1;
  for (let i = lines.length - 1; i >= stop; i--) {
    const line = lines[i]!.trim();
    if (BOX_BOTTOM.test(line)) bottom = i;
    else if (BOX_TOP.test(line) && bottom > i) {
      const text = lines
        .slice(i + 1, bottom)
        .map((row, n) => (n === 0 ? row.replace(/^\s*>\s?/, "") : row).trim())
        .filter(Boolean)
        .join(" ");
      boxes.push({ top: i, bottom, text });
      bottom = -1;
    }
  }
  return boxes;
}

/**
 * Whether a dotted line is a step rather than something the agent said.
 *
 * GG Coder draws a step as `⏺ <verb> <detail>` with the verb in bold, ending
 * `…` while it runs and `· <summary>` once done (`ui/tool-line-summary.js`).
 * Bold is the surest sign, but a terminal without colour (`TERM=dumb`,
 * `NO_COLOR`) draws none, so without it a line counts as a step only when it
 * starts with one of GG Coder's verbs *and* ends the way a step does — a reply
 * that happens to begin "Read the README" does not end in `…` or `· exit 0`.
 */
function stepVerb(cells: readonly Cell[]): boolean {
  const text = cells.map((c) => c.ch).join("");
  const dot = DOT.exec(text);
  if (!dot) return false;
  let bold = "";
  for (let i = dot[0].length; i < cells.length && cells[i]!.bold; i++) bold += cells[i]!.ch;
  if (bold.trim()) return STEP_VERBS.has(bold.trim());
  const rest = text.slice(dot[0].length).trimEnd();
  const verb = [...STEP_VERBS].some((v) => rest === v || rest.startsWith(`${v} `));
  return verb && (rest.endsWith("…") || / · \S/.test(rest));
}

/**
 * The turn on screen now: the message in the box before the input box, then
 * every reply and step drawn after it. Empty when no message box is in view.
 */
export function ggcoderTurn(screen: ScreenModel): wire.TerminalMessage[] {
  const lines = screen.text();
  const cells = screen.cells();
  const boxes = boxesFromEnd(lines, 600);
  const input = boxes[0];
  const prompt = boxes[1];
  if (!input || !prompt || !prompt.text) return [];
  const items: wire.TerminalMessage[] = [{ role: "user", text: prompt.text }];
  for (let i = prompt.bottom + 1; i < input.top; i++) {
    const line = lines[i]!;
    const plain = line.trim();
    if (
      !plain ||
      RULE.test(plain) ||
      CHROME.test(line) ||
      BOX_TOP.test(plain) ||
      BOX_BOTTOM.test(plain)
    )
      continue;
    if (DOT.test(line)) {
      const text = line.replace(DOT, "").trim();
      items.push({ role: stepVerb(cells[i] ?? []) ? "tool" : "agent", text });
      continue;
    }
    // A wrapped or later line of the reply above; a step's output preview is
    // not part of the conversation.
    const last = items[items.length - 1];
    if (last?.role === "agent") last.text = `${last.text}\n${plain}`;
  }
  const clip = (item: wire.TerminalMessage): wire.TerminalMessage => ({
    role: item.role,
    text:
      item.text.length > MAX_ITEM_TEXT ? `${item.text.slice(0, MAX_ITEM_TEXT - 1)}…` : item.text,
  });
  // The message that started the turn always, then as much of the newest as fits.
  const [first, ...rest] = items.map(clip);
  let budget = MAX_TOTAL_TEXT - (first?.text.length ?? 0);
  const kept: wire.TerminalMessage[] = [];
  for (let i = rest.length - 1; i >= 0 && kept.length < MAX_ITEMS - 1; i--) {
    budget -= rest[i]!.text.length;
    if (budget < 0) break;
    kept.unshift(rest[i]!);
  }
  return first ? [first, ...kept] : [];
}

/** Whether a run is in progress, from the title GG Coder sets: `● folder` while it works. */
export function ggcoderWorking(title: string): boolean {
  return /^[●⏺] /.test(title);
}

export interface ScreenTurn {
  activity: "working" | "idle";
  /** Counts runs since the wrapper started; a new number is a new message. */
  turn: number;
  items: wire.TerminalMessage[];
}

/**
 * Feed GG Coder's output in; hear about its turn. Reports at most every
 * `throttleMs`, and only when something changed, so a spinner redrawing ten
 * times a second costs nothing.
 */
export function ggcoderScreenWatcher(
  onTurn: (turn: ScreenTurn) => void,
  options: { rows?: () => number; throttleMs?: number } = {},
): { feed: (data: Uint8Array) => void; flush: () => void } {
  const decoder = new TextDecoder();
  const screen = new ScreenModel(options.rows);
  const throttleMs = options.throttleMs ?? 400;
  let working = false;
  let turn = 0;
  let sent = "";
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    // Mid-frame the live area is erased and half redrawn; wait for the frame.
    if (screen.syncing) {
      timer = setTimeout(flush, 50);
      timer.unref?.();
      return;
    }
    const now = ggcoderWorking(screen.title);
    if (now && !working) turn++;
    working = now;
    const report: ScreenTurn = {
      activity: now ? "working" : "idle",
      turn,
      items: ggcoderTurn(screen),
    };
    const key = JSON.stringify(report);
    if (key === sent) return;
    sent = key;
    onTurn(report);
  };

  return {
    feed(data) {
      screen.feed(decoder.decode(data, { stream: true }));
      // The title flips the moment a run starts or ends; that is worth
      // reporting at once, the rest can wait for the next tick.
      if (ggcoderWorking(screen.title) !== working && !screen.syncing) flush();
      else if (!timer) {
        timer = setTimeout(flush, throttleMs);
        timer.unref?.();
      }
    },
    flush,
  };
}
