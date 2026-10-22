# Terminal bridge — plan

Scope for the first version: **macOS; Claude Code, Codex and GG Coder.**
Linux and Windows are planned in `CROSS_PLATFORM_PLAN.md`.

## The idea

You type on the phone and every character appears, as you type it, in the real
`claude` / `codex` / `ggcoder` running in a terminal on your laptop. Any terminal
app — Ghostty, iTerm, Terminal, cmux, the VS Code terminal. You start the agent
the normal way, by typing `claude`. All the work happens on the laptop; the phone
is a keyboard (and, in a later milestone, a screen) for it.

## How it works

```
Ghostty / iTerm / any terminal
   └─ zsh: `claude` ──► shell function ──► tappy wrap claude
                                            ├─ PTY ──► the real `claude`
                                            └─ ~/.tappy/terminals.sock ◄──► tappy daemon ◄──(sealed)──► relay ◄──► phone
```

1. **Shell hook (one time).** `tappy shell install` adds a marked block to
   `~/.zshrc` defining `claude`, `codex` and `ggcoder` as functions that call
   `tappy wrap <agent> "$@"`. `tappy shell uninstall` removes it.
2. **`tappy wrap`.** Runs the real binary (found on `PATH`) inside a PTY it owns
   and proxies the user's terminal to it byte for byte: keyboard in, screen out,
   window resizes, exit code. The user sees the normal agent. It then registers
   the session with the daemon over a local Unix socket.
3. **Phone → laptop.** The app sends `terminal.input` frames; the daemon writes
   the bytes into that wrapper's PTY. Live typing: each change in the phone's
   text box is turned into the keystrokes that produce it (characters, or
   backspaces for deletions), and Return sends `\r`.
4. **Laptop → phone (milestone 2).** Replies are read from each agent's own
   conversation file, so the phone gets clean messages rather than screen text.

`tappy wrap` must never break the user's agent: no TTY (piped use, scripts) or
already inside a wrapper → plain passthrough; daemon not running → the agent runs
normally and simply is not visible to the phone.

## Wire (additive — no version bump)

- daemon → app `terminals` `{ terminals: [{ id, agent, folder, startedAt }] }`,
  sent on `hello` and whenever the set changes. An older app ignores it.
- app → daemon `terminal.input` `{ terminalId, data }`, `data` 1–4096 chars. An
  older daemon answers `unknown_message`.

## Security

The phone can type into a program on the laptop, so:

- Input is accepted only from a device that has completed the `hello` proof
  (`ctx.deviceId`), the same gate push registration uses. Frames are already
  sealed end to end and refused from unproved senders by both transports.
- Input can only reach a PTY that a `tappy wrap` process registered — never an
  arbitrary tty, pid or shell. The wrapper only runs the allowlisted agents, and
  stops accepting input the moment the agent exits, so keystrokes can never fall
  through into the user's shell.
- The socket lives in `~/.tappy` (directory `0700`, socket `0600`). Another
  process running as the same user could still connect; that user already owns
  everything the socket protects.
- Per-frame size cap (4096) at the schema; per-line cap on the local socket.

## Milestones

1. **Live typing** — protocol, daemon registry + socket, `tappy wrap`,
   `tappy shell`, app terminal list and live text box. Tested end to end with a
   fake agent in a PTY, then on the iOS simulator against a real agent.
2. **Replies on the phone** — tail Claude's, then Codex's and GG Coder's
   conversation files for the wrapped session; status (working / waiting / done)
   and the finished-turn push.
3. **Start an agent from the phone** — opens a terminal window on the laptop.
4. Windows and Linux; other shells (bash, fish).
