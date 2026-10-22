/**
 * `tappy --help`: the same chrome as every other screen (style B).
 *
 * Commands are grouped by what you do with them, each group under a spaced
 * title, and every command keeps its flags and its one-line description. The
 * commands and flags listed here are the full set; a test holds them to it.
 */
import { padEnd, spaced, styler, PALETTE, type Style } from "./ui.js";
import { rail, type RenderOptions } from "./rail.js";

interface Entry {
  command: string;
  note: string;
  /** Flags shown under the command, each with its own note. */
  flags?: [string, string][];
}

interface Group {
  title: string;
  entries: Entry[];
}

export const HELP_GROUPS: Group[] = [
  {
    title: "Setup",
    entries: [
      { command: "tappy setup [--json]", note: "Detect, verify and diagnose in one call" },
      {
        command: "tappy pair [--rotate]",
        note: "Show the QR a phone scans, then confirm it connected",
        flags: [["--no-wait", "Print the code and exit instead of waiting"]],
      },
      { command: "tappy relay <url|off>", note: "Reach this machine from anywhere" },
    ],
  },
  {
    title: "Run",
    entries: [
      { command: "tappy service install|restart", note: "Keep the daemon running across reboots" },
      { command: "tappy serve", note: "Run the daemon in this terminal" },
      { command: "tappy doctor [--json]", note: "What is wrong, and the command that fixes it" },
    ],
  },
  {
    title: "Agents",
    entries: [
      { command: "tappy detect [--json]", note: "Find installed agents and configure them" },
      {
        command: "tappy registry sync",
        note: "Add every agent in the public ACP registry",
        flags: [["--dry-run --force --json", "Preview / overwrite edited files / machine output"]],
      },
      { command: "tappy providers list", note: "List installed providers" },
      { command: "tappy providers validate", note: "Validate every manifest" },
      { command: "tappy providers add <id>", note: "Scaffold a new manifest" },
      { command: "tappy providers verify [id]", note: "Spawn a provider and prove it speaks ACP" },
      { command: "tappy providers disable <id>", note: "Hide an agent from the phone" },
      { command: "tappy providers enable <id>", note: "Show it again" },
    ],
  },
];

/** The version line is not a group: it stands alone at the foot. */
export const HELP_VERSION = { command: "tappy --version", note: "Which build this is" };

/** Every command the help names, flags included. Used by the test that holds the list complete. */
export function helpCommands(): string[] {
  const out: string[] = [HELP_VERSION.command];
  for (const group of HELP_GROUPS) {
    for (const entry of group.entries) {
      out.push(entry.command);
      for (const [flag] of entry.flags ?? []) out.push(flag);
    }
  }
  return out;
}

export function helpView(options: RenderOptions = {}): string[] {
  const s: Style = options.style ?? styler();
  const r = rail(options);

  const all = HELP_GROUPS.flatMap((group) => group.entries);
  const column = Math.max(...all.map((entry) => entry.command.length)) + 3;
  // Command in bold, its note dim, both on the same column so the notes line up.
  const row = (command: string, note: string) => `  ${s.bold(padEnd(command, column))}${s.hex(PALETTE.faint, note)}`;
  // A flag sits under its command, indented, with its own note on the same column.
  const flagRow = (flag: string, note: string) => `  ${s.hex(PALETTE.faint, padEnd(`    ${flag}`, column))}${s.hex(PALETTE.faint, note)}`;

  const out = [...r.intro("tappy", "your coding agents, on your phone")];
  for (const group of HELP_GROUPS) {
    out.push(...r.step(spaced(group.title)));
    for (const entry of group.entries) {
      out.push(row(entry.command, entry.note));
      for (const [flag, flagNote] of entry.flags ?? []) out.push(flagRow(flag, flagNote));
    }
  }
  out.push(...r.step(spaced("Version")));
  out.push(row(HELP_VERSION.command, HELP_VERSION.note));
  out.push(...r.outro(`Run ${s.bold("tappy <command> --help")} for details.`));
  return out;
}
