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

# The binary is about 100 MB. curl.exe (built into Windows 10 1803 and later)
# downloads it far faster than Invoke-WebRequest and shows a progress bar, so a
# long download no longer looks like a frozen window. Invoke-WebRequest stays
# as the fallback for older systems, with its own progress bar silenced: in
# Windows PowerShell that bar is slower than the download itself.
#
# Windows' own copy first, by full path: Git for Windows puts a second
# curl.exe on PATH, `Get-Command` then returns both, and calling that pair as
# one command failed with "not recognized" before anything downloaded.
$curl = Join-Path $env:SystemRoot 'System32\curl.exe'
if (-not (Test-Path $curl)) {
  $curl = Get-Command curl.exe -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1 -ExpandProperty Source
}
$downloaded = $false
if ($curl) {
  Write-Host "  About 100 MB - progress below." -ForegroundColor DarkGray
  & $curl --fail --location --progress-bar --retry 3 --output $exe $url
  $downloaded = ($LASTEXITCODE -eq 0)
}
if (-not $downloaded) {
  try {
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri $url -OutFile $exe -UseBasicParsing
  } catch {
    Die "Download failed. Check your connection, or grab it by hand from github.com/$Repo/releases"
  }
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

# An update has to replace a tappy that is running: the background service
# (the scheduled task `tappy setup` installs) keeps one alive all the time, and
# terminal wrappers may be running too. Windows cannot overwrite a running .exe,
# which made updates fail or, worse, leave the OLD daemon answering the phone
# while the new file sat unused. It can rename one, so the running copy is
# parked aside, the new one takes its name, and only the daemon is restarted —
# wrappers keep running on the parked file until their agent exits.
$TaskName = 'dev.tappy.daemon'
schtasks /query /tn $TaskName 2>$null | Out-Null
$hadTask = ($LASTEXITCODE -eq 0)

# Copies parked by earlier updates, now unused. Best effort: one still running
# stays locked and is removed by a later update.
Get-ChildItem -Path $InstallDir -Filter 'tappy.exe.old-*' -ErrorAction SilentlyContinue |
  ForEach-Object { Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue }

$daemons = @(Get-CimInstance Win32_Process -Filter "Name='tappy.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.ExecutablePath -ieq $target -and $_.CommandLine -match '\s(serve|run)(\s|$)' })
if ($hadTask) { schtasks /end /tn $TaskName 2>$null | Out-Null }
foreach ($d in $daemons) { Stop-Process -Id $d.ProcessId -Force -ErrorAction SilentlyContinue }
if ($hadTask -or $daemons.Count -gt 0) { Start-Sleep -Milliseconds 800 }

try {
  if (Test-Path $target) {
    Move-Item -Path $target -Destination "$target.old-$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())" -Force
  }
  Move-Item -Path $exe -Destination $target -Force
} catch {
  Die "Could not write to $InstallDir. Close any window running tappy, then try again."
}

if ($daemons.Count -gt 0 -and -not $hadTask) {
  Step "tappy was running in a window and has been stopped. It now runs in the background."
}
if ($hadTask) {
  # Back on the new binary straight away, rather than at the next login.
  schtasks /run /tn $TaskName 2>$null | Out-Null
  Ok "Restarted tappy in the background"
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
