/**
 * What a new person is told to run on their computer, and the order the first
 * screens go in.
 *
 * Pure on purpose — no Expo — so the copy a new user depends on is pinned by
 * `bun test`: a wrong command on this screen is a person who never gets past
 * it, and nobody notices because everyone working on the app is already set up.
 */

/** The computer the phone is being connected to. */
export type ComputerKind = "mac" | "windows" | "linux";

/** Where the installers are published. One place, so the screen and the docs cannot drift. */
export const INSTALL_BASE = "https://raw.githubusercontent.com/zahdourmoustafa/tappycode/main";

/**
 * The single command that installs tappy, starts it, and shows the code to
 * scan. macOS and Linux share the shell installer; Windows runs PowerShell's.
 */
export function installCommand(kind: ComputerKind): string {
  if (kind === "windows") return `irm ${INSTALL_BASE}/install.ps1 | iex`;
  return `curl -fsSL ${INSTALL_BASE}/install.sh | sh`;
}

/** Where to paste it, named the way each system names it. */
export function terminalName(kind: ComputerKind): string {
  if (kind === "windows") return "PowerShell";
  return "Terminal";
}

/** For a person who already installed it once and only needs a fresh code. */
export const PAIR_AGAIN_COMMAND = "tappy pair";

/**
 * The text sent from the phone to the computer with the share button, so
 * nobody types a long command off a phone screen. Says what it is for as well,
 * because it arrives in an email or a chat with no app around it.
 */
export function shareText(kind: ComputerKind): string {
  return [
    `Set up Tappy on this computer: open ${terminalName(kind)} and paste this.`,
    "",
    installCommand(kind),
    "",
    "It shows a QR code at the end. Scan it with the Tappy app.",
  ].join("\n");
}

/** The steps of first launch, in order. */
export type OnboardingStep = "welcome" | "install" | "scan" | "notifications" | "try";

/**
 * After pairing: ask for notifications only when the answer is still open —
 * a yes or a no already given is never asked again — and always end on trying
 * it, which is the step that teaches what the app is for.
 */
export function afterPairing(notifications: "granted" | "denied" | "undetermined"): OnboardingStep {
  return notifications === "undetermined" ? "notifications" : "try";
}

/** The agents the phone can follow in a terminal: the command typed, and the provider it is. */
const TERMINAL_COMMANDS = [
  { command: "claude", providerId: "claude-code", name: "Claude Code" },
  { command: "codex", providerId: "codex", name: "Codex" },
  { command: "ggcoder", providerId: "ggcoder", name: "GG Coder" },
] as const;

/**
 * What to tell a new person to type: the agents this computer has, in order,
 * or Claude when the list has not arrived (or holds none of them) — the one
 * most people have, and a fine thing to read while the list loads.
 */
export function commandsToTry(
  providers: readonly { id: string; available?: boolean }[],
): { command: string; name: string }[] {
  const have = TERMINAL_COMMANDS.filter((agent) =>
    providers.some((p) => p.id === agent.providerId && p.available !== false),
  );
  const list = have.length > 0 ? have : TERMINAL_COMMANDS.slice(0, 1);
  return list.map(({ command, name }) => ({ command, name }));
}

/**
 * The home screen's line while no agent runs in a terminal: the reminder that
 * the terminal is where the work happens. Undefined for an agent that cannot be
 * followed there, which keeps its ordinary greeting.
 */
export function terminalHint(providerId: string | undefined): string | undefined {
  const agent = TERMINAL_COMMANDS.find((a) => a.providerId === providerId);
  return agent ? `Type ${agent.command} in a terminal to see it here.` : undefined;
}
