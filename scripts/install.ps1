# SPDX-License-Identifier: AGPL-3.0-only
# SPDX-FileCopyrightText: 2026 DOMINUS contributors
#
# Install dominus-oss from the GitHub Release channel (PowerShell).
#
# Downloads the tarball attached to the latest release, verifies its sha256
# checksum against the checksum published beside it, and installs it with npm
# into a user-owned prefix (no admin required).
#
# Usage:
#
#   iwr -useb https://github.com/AlessioBrillo/dominus/releases/latest/download/install.ps1 | iex
#

$ErrorActionPreference = 'Stop'

$repo   = 'AlessioBrillo/dominus'
# The release base is overridable so the installer can be exercised against a
# local fixture before it is shipped (scripts/test-installers.mjs).
$base   = $env:DOMINUS_RELEASE_BASE
if (-not $base) {
  $base = "https://github.com/$repo/releases/latest/download"
}
$tarball= 'dominus-oss.tgz'
$checksum = 'dominus-oss.tgz.sha256'
$prefix = $env:DOMINUS_INSTALL_PREFIX

if (-not $prefix) {
  $prefix = Join-Path $env:USERPROFILE '.local'
}

if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue)) {
  Write-Error 'install.ps1: curl.exe is required (it ships with Windows 10 1803 and later)'; exit 1
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Write-Error 'install.ps1: npm is required'; exit 1
}

$tmpDir = [System.IO.Path]::GetTempPath()
$tmpDir = Join-Path $tmpDir ([System.IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null

try {
  $tarballPath = Join-Path $tmpDir $tarball
  $checksumPath = Join-Path $tmpDir $checksum

  Write-Host "install.ps1: downloading $tarball ..."
  # curl.exe, not curl: in Windows PowerShell 5.1 `curl` is an alias for
  # Invoke-WebRequest, which does not understand -fsSL. `curl.exe` is the
  # real binary and ships with Windows 10 1803+.
  curl.exe -fsSL --retry 3 --connect-timeout 30 --max-time 300 `
    -o $tarballPath "$base/$tarball"
  if ($LASTEXITCODE -ne 0) {
    Write-Error "install.ps1: could not download $base/$tarball (curl exit $LASTEXITCODE)"
    exit 1
  }

  Write-Host "install.ps1: downloading $checksum ..."
  curl.exe -fsSL --retry 3 --connect-timeout 30 --max-time 60 `
    -o $checksumPath "$base/$checksum"
  if ($LASTEXITCODE -ne 0) {
    Write-Error "install.ps1: could not download $base/$checksum (curl exit $LASTEXITCODE)"
    exit 1
  }

  $actual  = (Get-FileHash -Algorithm SHA256 $tarballPath).Hash.ToLower()
  $expected = (Get-Content $checksumPath | Select-Object -First 1).Split(' ')[0].ToLower()

  if ($actual -ne $expected) {
    Write-Error "install.ps1: checksum mismatch (expected $expected, got $actual)"
    exit 1
  }

  Write-Host "install.ps1: checksum verified"
  New-Item -ItemType Directory -Path $prefix -Force | Out-Null

  Write-Host "install.ps1: installing into $prefix ..."
  # `-g` is what puts the shim in the prefix root on Windows. Without it npm
  # installs under `$prefix\node_modules\.bin`, which is not on PATH and is
  # not where this script says the command lives.
  # Windows PowerShell 5.1 turns any stderr line from a native command into a
  # terminating error when $ErrorActionPreference is 'Stop'. npm writes
  # warnings (deprecations, funding) to stderr, so the install would abort
  # after succeeding. Scope the preference down and capture the exit code.
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  npm install -g --no-save --no-audit --no-fund --prefix $prefix $tarballPath 2>&1 | Out-Null
  $npmExit = $LASTEXITCODE
  $ErrorActionPreference = $previousPreference
  if ($npmExit -ne 0) {
    Write-Error "install.ps1: npm install failed (exit $npmExit)"
    exit 1
  }

  $bin = Join-Path $prefix 'dominus.cmd'
  if (-not (Test-Path $bin)) {
    # A silent success here is the v1.3.3 defect: the installer said "not on
    # PATH" and exited 0 after installing nothing usable.
    Write-Error "install.ps1: npm did not install the command at $bin"
    exit 1
  }

  $version = & $bin --version
  if ($LASTEXITCODE -ne 0) {
    Write-Error "install.ps1: the installed command does not answer (exit $LASTEXITCODE)"
    exit 1
  }
  Write-Host "install.ps1: done - $version"
  Write-Host "install.ps1: add $prefix to PATH, then run 'dominus score vintagecoffee.com'"
}
finally {
  Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue
}
