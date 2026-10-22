/**
 * Which terminal app a wrapper is running in, so an agent started from the
 * phone can open in the same one next time.
 *
 * macOS says so directly: every app it launches is given its bundle id
 * (`__CFBundleIdentifier`). Linux and Windows have nothing like it, but each
 * common terminal leaves its own variable in the shells it starts, and that is
 * what is read. A terminal this does not know gives undefined, and the launch
 * falls back to the platform's default — never a guess.
 */
import type { TerminalPlatform } from "./platform.js";

/** The names this returns on Linux and Windows. macOS returns a bundle id instead. */
export type TerminalAppId =
  | "windows-terminal"
  | "windows-console"
  | "vscode"
  | "wezterm"
  | "ghostty"
  | "kitty"
  | "konsole"
  | "gnome-terminal"
  | "alacritty"
  | "xterm";

export function detectTerminalApp(
  env: NodeJS.ProcessEnv,
  platform: TerminalPlatform,
): string | undefined {
  if (platform === "darwin") return env.__CFBundleIdentifier || undefined;

  // Windows Terminal, which WSL also passes through to Linux — where it names a
  // window the Linux side cannot open, so it counts on Windows alone.
  if (platform === "win32" && env.WT_SESSION) return "windows-terminal";
  const programs: Record<string, TerminalAppId> = {
    vscode: "vscode",
    WezTerm: "wezterm",
    ghostty: "ghostty",
  };
  const program = programs[env.TERM_PROGRAM ?? ""];
  if (program) return program;
  if (platform === "win32") {
    // Not Windows Terminal and no other host said who it is: the classic
    // console window, which `start` opens.
    return env.TERM_PROGRAM ? undefined : "windows-console";
  }
  if (env.KITTY_WINDOW_ID) return "kitty";
  if (env.KONSOLE_VERSION) return "konsole";
  if (env.GNOME_TERMINAL_SCREEN || env.GNOME_TERMINAL_SERVICE) return "gnome-terminal";
  if (env.ALACRITTY_WINDOW_ID || env.ALACRITTY_SOCKET) return "alacritty";
  if (env.XTERM_VERSION) return "xterm";
  return undefined;
}
