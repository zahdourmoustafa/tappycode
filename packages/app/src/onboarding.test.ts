import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  afterPairing,
  commandsToTry,
  terminalHint,
  INSTALL_BASE,
  installCommand,
  PAIR_AGAIN_COMMAND,
  shareText,
  terminalName,
} from "./onboarding";

const ROOT = join(import.meta.dir, "..", "..", "..");

test("each computer gets the one command for it", () => {
  expect(installCommand("mac")).toBe(`curl -fsSL ${INSTALL_BASE}/install.sh | sh`);
  expect(installCommand("linux")).toBe(installCommand("mac"));
  expect(installCommand("windows")).toBe(`irm ${INSTALL_BASE}/install.ps1 | iex`);
  expect(terminalName("windows")).toBe("PowerShell");
  expect(terminalName("mac")).toBe("Terminal");
});

test("the installers the screen names are the ones in this repository, and both end in pairing", () => {
  // The screen links to these by path; renaming one would strand every new user.
  const sh = readFileSync(join(ROOT, "install.sh"), "utf8");
  const ps1 = readFileSync(join(ROOT, "install.ps1"), "utf8");
  expect(sh).toContain('exec "$INSTALL_DIR/tappy" pair');
  expect(ps1).toContain("pair");
  // And they install from the same repository the command fetches them from.
  const repo = INSTALL_BASE.split("/").slice(3, 5).join("/");
  expect(sh).toContain(`REPO="${repo}"`);
  expect(ps1).toContain(repo);
  expect(PAIR_AGAIN_COMMAND).toBe("tappy pair");
});

test("the shared text carries the command and says what to do with it", () => {
  const text = shareText("windows");
  expect(text).toContain(installCommand("windows"));
  expect(text).toContain("PowerShell");
  expect(text).toContain("QR code");
});

test("notifications are asked once, and setup always ends on trying it", () => {
  expect(afterPairing("undetermined")).toBe("notifications");
  expect(afterPairing("granted")).toBe("try");
  expect(afterPairing("denied")).toBe("try");
});

test("the try step names the agents this computer has, and Claude before the list arrives", () => {
  expect(commandsToTry([])).toEqual([{ command: "claude", name: "Claude Code" }]);
  expect(
    commandsToTry([
      { id: "codex" },
      { id: "gemini-cli" },
      { id: "claude-code", available: false },
      { id: "ggcoder" },
    ]).map((c) => c.command),
  ).toEqual(["codex", "ggcoder"]);
});

test("home reminds that the terminal is where the work happens, for agents it can follow", () => {
  expect(terminalHint("claude-code")).toBe("Type claude in a terminal to see it here.");
  expect(terminalHint("gemini-cli")).toBeUndefined();
  expect(terminalHint(undefined)).toBeUndefined();
});
