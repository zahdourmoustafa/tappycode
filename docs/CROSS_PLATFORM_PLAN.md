# Terminal bridge on Linux and Windows — plan

Companion to `TERMINAL_BRIDGE_PLAN.md`, which describes the macOS bridge.

## Status (17 Oct 2026)

Built, not yet released or committed. Items 1–9 are in the code:
`terminals/platform.ts` (one place that says which OS's rules apply),
`terminal-app.ts`, and per-platform branches in `link.ts`, `socket.ts`,
`wrap.ts`, `shell-hook.ts`, `launch.ts`, `agent-mirrors.ts` and
`claude-mirror.ts`.

- **macOS:** unchanged in behaviour; the whole suite passes.
- **Linux:** the terminal suite passes on real Linux (Bun 1.3.14 container),
  including the `/proc` Codex lookup. Not yet tried on a Linux desktop
  (opening a window from the phone).
- **Windows:** the rules are tested from the Mac via `TAPPY_FAKE_PLATFORM`.
  The three real-Windows tests (named pipe, ConPTY, `.cmd` launcher) are in
  `cross-platform.test.ts` and run only in the `windows-latest` CI job, which
  has not run yet. Nothing has been tried by hand on Windows.

Two decisions changed while building:
- **The link uses `node:net`, on every platform.** Bun's own `Bun.listen` has
  open bugs with Windows named pipes, and `node:net` handles both pipes and
  Unix sockets, so the Mac tests now exercise the code Windows runs.
- **Windows launchers are `.cmd` files, not hard-linked copies of
  `tappy.exe`.** In the wrapper's raw mode Ctrl-C is a keystroke, not a
  console event, so the "Terminate batch job?" prompt that ruled them out
  doesn't happen. And a `.cmd` names `tappy.exe` by path, so self-update needs
  no relinking. Item 3's hard-link text below is superseded.

## Goal

The same promise on every desktop OS: run `tappy pair` once, then use plain
`claude`, `codex` or `ggcoder` in whatever terminal you like. The phone sees the
conversation, types into it, answers questions, and can open a new agent on the
computer. No extra commands, no per-OS behaviour the user has to learn.

## What already works everywhere

The phone app, relay, push, pairing, crypto, the background service
(launchd / systemd / Task Scheduler), self-update and the old in-app chat mode
are already cross-platform and ship for Windows today (`tappy-windows-x64.exe`,
`install.ps1`, `service-schtasks.ts`, a `windows-latest` CI job). This plan is
only about `packages/daemon/src/terminals/`.

## Facts checked before planning

- **ConPTY is in the Bun we already pin.** Bun 1.3.14 made `Bun.Terminal` and
  `Bun.spawn({ terminal })` work on Windows through ConPTY. Earlier 1.3.x threw
  "terminal option is not supported on this platform". CI and release pin
  1.3.14, so **no runtime upgrade and no node-pty**. The Bun 1.4 Rust rewrite
  is a separate decision and is not part of this work.
- Known ConPTY differences: no termios (flags read as 0), no kernel echo,
  Ctrl-C arrives as a byte that ConPTY turns into a console control event, and
  mouse-tracking escape sequences are swallowed (Bun issue #43450). None of
  these break typing into a coding agent; mouse scroll inside the TUI may not
  work, which is the same as many Windows terminals today.
- **The Windows service already runs in the user's desktop session**
  (`LogonType InteractiveToken`, not hidden). That matters: a daemon in
  session 0 could not open a terminal window the user can see.
- Not yet verified, and treated as risks below: whether `Bun.listen({ unix })`
  works on Windows, whether Claude Code writes `~/.claude/sessions/<pid>.json`
  on Windows, and how Claude encodes a Windows path in its `projects/` folder
  name.

## Principle: one bridge, small OS seams

Do not fork the bridge per OS. Everything that is plain data (registry, mirror
tailer, Claude screen parsing, question buttons, mode/model keys, wire
messages, the app) stays shared. Each OS difference goes behind one small
module with a pure, unit-testable decision function and a thin side-effect
part, following the existing `service.ts` → `service-*.ts` pattern:

| Seam | macOS (today) | Linux | Windows |
|---|---|---|---|
| PTY | Bun PTY | Bun PTY (same) | Bun ConPTY (same API) |
| Wrapper ↔ daemon link | unix socket | unix socket (same) | named pipe |
| Taking over `claude` | `~/.tappy/bin` + `.zshrc`/`.bashrc` block | same + fish later | `~/.tappy/bin` first in the **user PATH** |
| Launcher files | `#!/bin/sh` scripts | same | hard-linked `claude.exe` etc. (fallback `.cmd`) |
| Codex conversation lookup | `lsof` | `/proc/<pid>/fd` | file scan (below) |
| Which terminal am I in | `__CFBundleIdentifier` | env vars | env vars |
| Open a terminal from phone | cmux / Ghostty / iTerm / Terminal | detected emulator | Windows Terminal → PowerShell |

## Work items

### 1. Wrapper on ConPTY (Windows)
`wrap.ts` mostly works unchanged because the API is the same. Changes:
- Signals: Windows has no SIGHUP. Closing the window kills the wrapper's
  console; the wrapper must close the pseudoconsole so the agent exits instead
  of being orphaned. Keep the existing `children.ts` cleanup as the backstop.
- Raw mode and resize: `setRawMode` and the `resize` event both exist on
  Windows consoles; verify in CI that a resize reaches the agent.
- Exit codes come back as numbers only (no signal names).

### 2. Wrapper ↔ daemon link
- Linux: unchanged.
- Windows: use a per-user named pipe (`\\.\pipe\tappy-<user>-terminals`)
  through `node:net`, which Bun supports. Unix sockets on Windows exist but
  are a lesser-tested path in Bun, and named pipes are the native choice.
- Security: the pipe must be readable only by the same user (the default pipe
  security does that for the creating user; verify, and refuse to start if a
  pipe with that name is already owned by someone else, as the socket code
  already refuses a foreign file). `link.ts` picks the path, so this is one
  function plus `socket.ts` accepting either.

### 3. Taking over plain `claude` on Windows
This is the hardest product piece, because Windows shells don't share one rc
file.
- Put `%USERPROFILE%\.tappy\bin` at the **front of the user PATH** (registry,
  `HKCU\Environment`), written through
  `[Environment]::SetEnvironmentVariable(..., 'User')` so Windows broadcasts
  the change. Never `setx` (it truncates PATH at 1024 chars and would destroy
  the user's PATH). One change covers PowerShell, cmd, Git Bash, VS Code's
  terminal and Windows Terminal.
- Back up the old PATH value first (same as `~/.tappy/legacy-backup/`), and
  `tappy unpair` restores it by removing only our entry.
- Launcher files: hard-link `tappy.exe` as `claude.exe`, `codex.exe`,
  `ggcoder.exe` in that folder, and make the binary act as the wrapper when
  started under an agent's name (busybox style). Reasons: a `.cmd` shim prints
  "Terminate batch job (Y/N)?" on every Ctrl-C, and `.exe` beats `.cmd` in
  `PATHEXT` order. Hard links cost no disk on the same drive. Fall back to
  `.cmd` shims if hard-linking fails (different drive, FAT).
- Self-update replaces `tappy.exe` by rename, so the hard links would keep
  pointing at the old binary. The updater must relink after a swap, and
  `doctor` must report stale links.
- Finding the real agent: walk PATH skipping our folder, honour `PATHEXT`
  (`claude.exe`, `claude.cmd` from npm, `claude.ps1`), and compare paths
  case-insensitively. Running a `.cmd`/`.ps1` agent needs `cmd /c` or
  `powershell -File` in front.
- Known limit to tell the user at pair time: terminals that were already open
  keep the old PATH. Windows Terminal keeps its own environment until the app
  itself is restarted, so `tappy pair` says "restart Windows Terminal".

### 4. Shell hook on Linux
The `.zshrc`/`.bashrc` block already works. Add `fish`
(`~/.config/fish/conf.d/tappy.fish`) and keep the "your shell isn't supported
yet" warning for anything else.

### 5. Finding Codex's conversation without `lsof`
Codex writes no pid record, so today we ask the OS which rollout file the
process has open.
- Linux: read `/proc/<pid>/fd` links, which is faster than `lsof` and always
  present.
- Windows (and the fallback everywhere): pick the newest
  `~/.codex/sessions/**/rollout-*.jsonl` created after the terminal started
  whose first line names the same cwd. It's the same approach as the GG Coder
  source. Two Codex windows in the same folder started within seconds can be
  confused; accept that, and keep the precise method where the OS provides
  one.

### 6. Claude on Windows: confirm, then adapt
Before building, run Claude Code on Windows once (CI or VM) and record:
whether `~/.claude/sessions/<pid>.json` appears, and the folder name Claude
uses under `projects/` for `C:\Users\me\repo`. If the pid file is missing, fall
back to "newest project transcript since the terminal started", as for GG
Coder. Screen parsing (trust prompt, numbered questions, mode line) is plain
text and should carry over; add a captured Windows screen as a test fixture,
as `fixtures/claude-permission-prompt.ansi` does for macOS.

### 7. Which terminal app am I in
Replace the macOS-only bundle id with a small pure detector reading
environment variables: `WT_SESSION` (Windows Terminal), `TERM_PROGRAM`
(VS Code, WezTerm, iTerm, Ghostty…), `KITTY_WINDOW_ID`, `KONSOLE_VERSION`,
`GNOME_TERMINAL_SCREEN`, falling back to "unknown". The wrapper reports it as
today; the registry and app don't change.

### 8. Opening an agent from the phone
- Windows: `wt.exe -w 0 new-tab -d <cwd> --title <title> <tappy> wrap claude …`
  when Windows Terminal is installed (default on Windows 11); otherwise a new
  PowerShell window in that folder. Arguments go as an argument array, never a
  joined string, and the project allow-list check stays in front.
- Linux: use the remembered emulator, else `x-terminal-emulator`, then the
  common ones (gnome-terminal, konsole, kitty, wezterm, ghostty). A systemd
  user service doesn't inherit `DISPLAY`/`WAYLAND_DISPLAY`, so launch must
  read them from the user session (`systemctl --user import-environment` at
  setup) or report "can't open a window here".
- No desktop at all (SSH box, headless Linux): the phone shows "can't open a
  terminal on this computer" instead of failing silently. Mirroring and typing
  still work for agents the user starts over SSH.

### 9. Paths on Windows
Project allow-list, `knownProject()`, duplicate-conversation checks and the
project list must compare Windows paths case-insensitively with normalised
separators and drive letters (`C:\Repo` and `c:/repo` are one project). The
app shows the last folder name, so it needs no change.

### 10. Out of scope for v1
- WSL: an agent inside WSL is effectively a Linux machine. Supported by
  installing the Linux `tappy` inside WSL, not by the Windows daemon reaching
  into it.
- Windows on ARM native build: the x64 build runs under emulation; ARM64
  needs Bun 1.4 and is a later release.
- Old Windows 10 console host without ConPTY (before build 1809): refuse with
  a clear `doctor` error.

## Testing (there is no Windows machine here)

1. **Unit tests on every OS, in CI:** every seam's decision function is pure
   (which launcher, which pipe name, which terminal, which command line,
   path comparison) and tested with injected `platform` and `env`, so most
   Windows logic is tested on the Mac too.
2. **Real Windows tests in the existing `windows-latest` job:** a fake agent
   (a small script that prints a prompt, echoes input, handles resize and
   exits) run through `tappy wrap` on ConPTY; a pipe round-trip between a
   wrapper and the registry; the PATH install and uninstall against a
   throwaway user environment; the hard-link launcher resolving to the real
   agent. Same rule as the Mac tests: a restricted PATH so a test can never
   start a real agent.
3. **A manual pass on a real Windows 11 before announcing it:** a Windows 11
   VM on this Mac (UTM or Parallels; the x64 build runs under emulation) or a
   borrowed PC. Checklist: pair, open `claude` in PowerShell, cmd, Windows
   Terminal and VS Code, type from the phone, answer a question, open a new
   agent from the phone, close the window and confirm the agent is gone, and
   self-update with the agent closed.
4. Linux gets the same manual pass on an Ubuntu VM with GNOME, plus one
   headless SSH check.

## Order and size

1. **Finish macOS** (Poco verification, Android push with
   `google-services.json`, remove the old chat-only path). Nothing below starts
   until the Mac version is solid, because every OS inherits its bugs.
2. **Refactor the seams on macOS first, with no change in behaviour:** move
   the OS-specific bits into the modules above, with the Mac behaviour as the
   only implementation. The test suite proves nothing moved. About 1–2 days.
3. **Linux:** `/proc` lookup, terminal detection, emulator launch, fish. About
   2–3 days plus the VM pass.
4. **Windows:** pipe, PATH install, hard-link launchers, ConPTY wrapper
   details, Windows Terminal launch, path rules, Windows CI tests. About 1–2
   weeks, most of it on the PATH takeover and testing.
5. **Release:** daemon binary only (tag `v*`); the app needs no change, so no
   App Store or Play review is involved.

## Risks, biggest first

1. **Taking over `claude` on Windows** touches the user PATH. A bug there
   breaks the user's terminal. Mitigation: back up first, change only our one
   entry, `doctor` checks it, unpair restores it.
2. **Claude's Windows file layout is unconfirmed** (item 6). Mitigation:
   check it before building; the fallback is known.
3. **ConPTY is young in Bun** (added in 1.3.14). Mitigation: real ConPTY tests
   in CI from day one; node-pty stays the fallback if a blocking bug appears.
4. **No in-house Windows machine.** Mitigation: CI covers the mechanics and the
   VM covers the experience; don't announce Windows before the manual pass.
