# tappy installer for Windows.
#
#   irm https://raw.githubusercontent.com/zahdourmoustafa/tappycode/main/install.ps1 | iex
#
# Downloads one self-contained executable. No Node, no Bun, no git clone - the
# runtime is compiled in, which is the point: someone who installed the phone
# app should not have to set up a development environment to use it.
#
# Short and readable on purpose. Piping a script from the internet into a shell
# is a real trust ask, and the only honest answer is a script you can read.

$ErrorActionPreference = 'Stop'

$Repo = 'zahdourmoustafa/tappycode'
# LOCALAPPDATA rather than Program Files: no administrator prompt, and it is a
# per-user install, which is what this is.
$InstallDir = if ($env:TAPPY_INSTALL_DIR) { $env:TAPPY_INSTALL_DIR } else { "$env:LOCALAPPDATA\tappy" }

function Say  { param($m) Write-Host $m }
function Step { param($m) Write-Host "  $m" -ForegroundColor DarkGray }
function Ok   { param($m) Write-Host "  " -NoNewline; Write-Host "OK" -ForegroundColor Green -NoNewline; Write-Host " $m" }
function Die  { param($m) Write-Host ""; Write-Host "  X $m" -ForegroundColor Red; Write-Host ""; exit 1 }

Say ""
Write-Host "  tappy" -ForegroundColor White
Step "your coding agents, on your phone"
Say ""

# --- which build ------------------------------------------------------------

# Only x64 is published today. ARM64 Windows runs x64 through emulation, so the
# x64 build works there rather than failing outright - slower, but working beats
# an error telling someone their laptop is unsupported.
$asset = 'tappy-windows-x64.exe'
# Overridable so a build can be installed exactly as a user would, before it is public.
$base  = if ($env:TAPPY_DOWNLOAD_BASE) { $env:TAPPY_DOWNLOAD_BASE } else { "https://github.com/$Repo/releases/latest/download" }
$url   = "$base/$asset"

Step "Downloading..."

# --- download ---------------------------------------------------------------

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("tappy-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
$exe = Join-Path $tmp 'tappy.exe'

try {
  # Invoke-WebRequest shows a progress bar that is slower than the download on
  # a fast connection. Silencing it is a real speedup, not cosmetics.
  $ProgressPreference = 'SilentlyContinue'
  Invoke-WebRequest -Uri $url -OutFile $exe -UseBasicParsing
} catch {
  Die "Download failed. Check your connection, or grab it by hand from github.com/$Repo/releases"
}

if (-not (Test-Path $exe) -or (Get-Item $exe).Length -eq 0) {
  Die "The download came out empty. Try again."
}

# --- verify -----------------------------------------------------------------

# Best effort: a missing checksum file must not block an install, but a
# mismatched one must.
#
# Fetching is in the try; the comparison is deliberately outside it. `Die` calls
# `exit`, and whether a catch swallows that is exactly the kind of subtlety not
# worth depending on in a script that decides whether to run an unverified
# binary. Outside the try it cannot be swallowed at all.
$expected = $null
try {
  $ProgressPreference = 'SilentlyContinue'
  $sumFile = Join-Path $tmp 'tappy.sha256'
  Invoke-WebRequest -Uri "$url.sha256" -OutFile $sumFile -UseBasicParsing
  # sha256sum writes "<hash>  <filename>", so the hash is the first field.
  $expected = (Get-Content $sumFile -Raw).Split(' ')[0].Trim().ToLower()
} catch {
  # No checksum published, or it could not be fetched. Carry on without it.
}

if ($expected) {
  $actual = (Get-FileHash $exe -Algorithm SHA256).Hash.ToLower()
  if ($actual -ne $expected) {
    Die "The download does not match its checksum. Not installing it. Try again, and if it keeps happening, report it."
  }
  Ok "Checksum verified"
}

# --- install ----------------------------------------------------------------

New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
$target = Join-Path $InstallDir 'tappy.exe'

try {
  # A running daemon holds a lock on its own executable, so overwriting fails
  # with a message about the file being in use. Saying what to do beats that.
  Move-Item -Path $exe -Destination $target -Force
} catch {
  Die "Could not write to $InstallDir. If tappy is already running, close it and try again."
}

Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
Ok "Installed to $target"

# --- PATH -------------------------------------------------------------------

# The user PATH from the registry, not $env:PATH: this process inherited a copy
# and writing that back would persist nothing.
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')

# Compared entry by entry rather than with -like. That does wildcard matching, so
# a bracket in a custom TAPPY_INSTALL_DIR would break the test, and a substring
# match would see an existing "C:\tools\tappy-old" as this directory already
# being present and skip adding the real one.
$entries = @()
if ($userPath) { $entries = $userPath.Split(';') | Where-Object { $_ } }
$already = $entries | Where-Object { $_.TrimEnd('\') -ieq $InstallDir.TrimEnd('\') }

if (-not $already) {
  # A fresh profile can have no user PATH at all, and "$null;C:\..." leaves an
  # empty leading entry, which Windows reads as the current directory.
  $updated = if ($entries) { ($entries + $InstallDir) -join ';' } else { $InstallDir }
  [Environment]::SetEnvironmentVariable('Path', $updated, 'User')
  # Also for this session, so the instructions below work without reopening.
  $env:Path = "$env:Path;$InstallDir"
  Ok "Added to your PATH"
  Say ""
  Step "Open a new terminal for this to apply everywhere."
}

# Straight into pairing, so installing is the only command anyone runs: it
# starts tappy in the background, sets up the terminal, and shows the code the
# phone scans. Skipped when nobody is there to scan it.
if (-not $env:TAPPY_NO_PAIR -and [Environment]::UserInteractive -and -not [Console]::IsOutputRedirected) {
  Say ""
  Write-Host "  Connect your phone" -ForegroundColor White
  & (Join-Path $InstallDir 'tappy.exe') pair
  exit $LASTEXITCODE
}

Say ""
Write-Host "  Done." -ForegroundColor White -NoNewline
Say " Next, run:"
Say ""
Write-Host "    tappy pair" -ForegroundColor White
Say ""
Step "It starts tappy in the background and shows the code you scan with the app."
Say ""
