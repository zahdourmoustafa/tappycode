#!/bin/sh
#
# tappy installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/zahdourmoustafa/tappycode/main/install.sh | sh
#
# Downloads one self-contained binary. No Node, no Bun, no git clone. The
# runtime is compiled into the executable, which is the whole point: someone who
# installed the phone app should not have to set up a development environment.
#
# Deliberately short and readable. Piping a script from the internet into a
# shell is a real trust ask, and the only honest answer is a script you can read
# in a minute.
#
# The layout is the same look `tappy setup` and `tappy doctor` use (style B): a
# dot-matrix mark opens each section, its title is set in spaced capitals, and
# the lines under it hang two spaces in. Every line is at the same indent.

set -eu

REPO="zahdourmoustafa/tappycode"
# ~/.local/bin rather than /usr/local/bin: no sudo, and it is on PATH by default
# on most systems. TAPPY_INSTALL_DIR overrides for anyone who wants elsewhere.
INSTALL_DIR="${TAPPY_INSTALL_DIR:-$HOME/.local/bin}"

# Colour and box drawing only when writing to a terminal. Piped into a file or a
# CI log, escape codes are noise and the glyphs are mojibake.
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  B=$(printf '\033[1m'); D=$(printf '\033[2m'); R=$(printf '\033[0m')
  ACCENT=$(printf '\033[38;5;209m'); GREEN=$(printf '\033[32m'); RED=$(printf '\033[31m')
  # The Stage marks: ■ opens and closes, ░ opens a section, ▓ is done, ■ red is a stop.
  OPEN="■"; STEP="░"; OK="▓"; CROSS="■"; END="■"
else
  B=''; D=''; R=''; ACCENT=''; GREEN=''; RED=''
  OPEN="*"; STEP="o"; OK="+"; CROSS="x"; END="\`"
fi

# One prefix for every line, so alignment is structural rather than counted out
# by hand. This is what the old version got wrong: text landed at column 2 or 4
# depending on whether it had a glyph in front of it.
# A line under the current section, hung two spaces in.
line() { printf '  %s\n' "$1"; }
# A finished check, marked ▓ in green.
ok() { printf '  %s%s%s  %s\n' "$GREEN" "$OK" "$R" "$1"; }
# A section opening: a blank line, the step mark, and its title in bold.
step() { printf '\n%s%s%s  %s%s%s\n' "$ACCENT" "$STEP" "$R" "$B" "$1" "$R"; }
die() {
  printf '\n%s%s%s  %s%s%s\n' "$RED" "$CROSS" "$R" "$B" "$1" "$R" >&2
  [ $# -gt 1 ] && printf '   %s%s%s\n' "$D" "$2" "$R" >&2
  printf '\n' >&2
  exit 1
}

# The title, set the way the CLI sets its own: letters spaced, in capitals.
printf '\n%s%s%s  %sT A P P Y%s\n' "$ACCENT" "$OPEN" "$R" "$B" "$R"
printf '   %sYOUR CODING AGENTS, ON YOUR PHONE%s\n' "$D" "$R"

# --- which build ------------------------------------------------------------

os=$(uname -s)
arch=$(uname -m)

case "$os" in
  Darwin) os_name="darwin" ;;
  Linux)  os_name="linux" ;;
  *) die "No build for $os yet." "On Windows, use the PowerShell installer instead." ;;
esac

case "$arch" in
  arm64|aarch64) arch_name="arm64" ;;
  x86_64|amd64)  arch_name="x64" ;;
  *) die "No build for $arch." "Open an issue and say what machine this is." ;;
esac

asset="tappy-${os_name}-${arch_name}"
# Where releases are published. Overridable so a build can be installed exactly
# as a user would install it — same checksum, same steps — before it is public.
base="${TAPPY_DOWNLOAD_BASE:-https://github.com/${REPO}/releases/latest/download}"
url="${base}/${asset}"

# --- download ---------------------------------------------------------------

step "Downloading  ${D}${os_name} ${arch_name}${R}"

tmp=$(mktemp -d)
# Cleans up on failure too, so a half-downloaded binary is never left behind.
trap 'rm -rf "$tmp"' EXIT INT TERM

# The binary is around 60MB, which is long enough on a slow connection that a
# silent wait reads as a hang. `--progress-bar` is curl's own meter: it writes
# to stderr, redraws in place, and costs nothing.
if command -v curl >/dev/null 2>&1; then
  curl --fail --location --progress-bar --output "$tmp/tappy" "$url" \
    || die "Download failed." "Check your connection, or grab it from github.com/${REPO}/releases"
  curl -fsSL "$url.sha256" -o "$tmp/tappy.sha256" \
    || die "Could not fetch the checksum for that download." "Every release publishes one, so this is a broken release or something sitting between you and GitHub. Not installing it."
elif command -v wget >/dev/null 2>&1; then
  wget --show-progress -qO "$tmp/tappy" "$url" \
    || die "Download failed." "Check your connection, or grab it from github.com/${REPO}/releases"
  wget -qO "$tmp/tappy.sha256" "$url.sha256" \
    || die "Could not fetch the checksum for that download." "Every release publishes one, so this is a broken release or something sitting between you and GitHub. Not installing it."
else
  die "Need curl or wget." "Install one and run this again."
fi

# A truncated download produces a file that exists and cannot run, which fails
# later in a way that looks like a bug in tappy rather than a bad transfer.
[ -s "$tmp/tappy" ] || die "The download came out empty." "Try again."

# --- verify -----------------------------------------------------------------

# Required, not best effort. Every release publishes a `.sha256` beside its
# binary, so a missing one is not a quirk of some platform — it is exactly the
# condition this check exists to catch. Skipping the check when the file was
# absent meant whoever served the binary could turn the check off by serving one
# file less.
[ -s "$tmp/tappy.sha256" ] || die "That download came without a checksum." "Not installing it. Report it at github.com/${REPO}/issues"

expected=$(awk '{print $1}' "$tmp/tappy.sha256")
actual=""
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$tmp/tappy" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$tmp/tappy" | awk '{print $1}')
elif command -v openssl >/dev/null 2>&1; then
  actual=$(openssl dgst -sha256 "$tmp/tappy" | awk '{print $NF}')
fi

# Three ways to compute it, because a machine with none of them is rare and a
# machine that installs an unverified binary is worse.
[ -n "$actual" ] || die "No way to check this download's checksum here." "Install coreutils, perl or openssl and run this again."
[ "$actual" = "$expected" ] || die "That download does not match its checksum." "Not installing it. Try again, and report it if it keeps happening."
ok "Checksum verified"

# --- install ----------------------------------------------------------------

mkdir -p "$INSTALL_DIR"
chmod +x "$tmp/tappy"
mv "$tmp/tappy" "$INSTALL_DIR/tappy" \
  || die "Could not write to $INSTALL_DIR." "Set TAPPY_INSTALL_DIR to somewhere you can write."

ok "Installed to ${D}${INSTALL_DIR}/tappy${R}"

# macOS quarantines anything downloaded, and the first run dies with a Gatekeeper
# dialog that says nothing useful. Stripping the flag turns that into a working
# command; the binary is still unsigned, which the README says plainly.
if [ "$os_name" = "darwin" ] && command -v xattr >/dev/null 2>&1; then
  xattr -d com.apple.quarantine "$INSTALL_DIR/tappy" 2>/dev/null || true
fi

# --- restart the daemon -----------------------------------------------------

# Replacing the file does not replace the process.
#
# `mv` swaps the directory entry; a daemon launchd started is still executing
# the old inode and keeps doing so until it exits. So an update landed on disk
# and changed nothing at all: the user ran the curl line, saw "Installed", and
# went on talking to the same build they were trying to leave. Every fix
# shipped this way was invisible until the machine happened to reboot.
#
# Only when a service is already installed. A first install has no daemon to
# restart, and `tappy setup` is what starts one.
if [ -f "$HOME/Library/LaunchAgents/dev.tappy.daemon.plist" ]; then
  # Failure here is not fatal: the binary is installed and correct either way,
  # and `tappy setup` reports an unreachable daemon with the command to fix it.
  if "$INSTALL_DIR/tappy" service restart >/dev/null 2>&1; then
    ok "Daemon restarted on the new version"
  else
    line "${D}Run ${B}tappy service restart${R}${D} to finish updating the daemon.${R}"
  fi
fi

# --- PATH -------------------------------------------------------------------

case ":$PATH:" in
  *":$INSTALL_DIR:"*) on_path=1 ;;
  *) on_path=0 ;;
esac

# Pairing is about to run, and on these shells it puts `tappy` on PATH itself
# (beside the agents' launchers). Asking the person to edit their PATH first
# would be homework standing between them and the code to scan.
will_pair=0
if [ -z "${TAPPY_NO_PAIR:-}" ] && [ -t 1 ] && (: </dev/tty) 2>/dev/null; then
  will_pair=1
  case "${SHELL:-}" in
    */zsh|*/bash|*/fish) on_path=1 ;;
  esac
fi

if [ "$on_path" = "0" ]; then
  case "${SHELL:-}" in
    */zsh)  hint="echo 'export PATH=\"$INSTALL_DIR:\$PATH\"' >> ~/.zshrc" ;;
    */bash) hint="echo 'export PATH=\"$INSTALL_DIR:\$PATH\"' >> ~/.bashrc" ;;
    */fish) hint="fish_add_path $INSTALL_DIR" ;;
    *)      hint="add $INSTALL_DIR to your PATH" ;;
  esac
  step "One thing first"
  line "${INSTALL_DIR} is not on your PATH yet. Paste this:"
  line ""
  line "${B}${hint}${R}"
  line ""
  line "${D}then open a new terminal.${R}"
fi

# --- connect the phone -------------------------------------------------------

# Straight into pairing, so installing is the only command anyone runs: it
# starts tappy in the background, sets up the terminal, and shows the code the
# phone scans. Under `curl | sh` the script itself is stdin, so the keyboard is
# taken from the terminal directly — and only when there is one to take.
if [ "$will_pair" = "1" ]; then
  step "Connect your phone"
  exec "$INSTALL_DIR/tappy" pair </dev/tty
fi

# --- done -------------------------------------------------------------------

printf '\n%s%s%s  %sRun %stappy pair%s to connect your phone.%s\n\n' \
  "$ACCENT" "$END" "$R" "$D" "$B" "$R$D" "$R"
