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
$base   = "https://github.com/$repo/releases/latest/download"
$tarball= 'dominus-oss.tgz'
$checksum = 'dominus-oss.tgz.sha256'
$prefix = $env:DOMINUS_INSTALL_PREFIX

if (-not $prefix) {
  $prefix = Join-Path $env:USERPROFILE '.local'
}

if (-not (Get-Command curl -ErrorAction SilentlyContinue)) {
  Write-Error 'install.ps1: curl is required'; exit 1
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
  curl -fsSL --retry 3 --connect-timeout 30 --max-time 300 `
    -o $tarballPath "$base/$tarball"

  Write-Host "install.ps1: downloading $checksum ..."
  curl -fsSL --retry 3 --connect-timeout 30 --max-time 60 `
    -o $checksumPath "$base/$checksum"

  $actual  = (Get-FileHash -Algorithm SHA256 $tarballPath).Hash.ToLower()
  $expected = (Get-Content $checksumPath | Select-Object -First 1).Split(' ')[0].ToLower()

  if ($actual -ne $expected) {
    Write-Error "install.ps1: checksum mismatch (expected $expected, got $actual)"
    exit 1
  }

  Write-Host "install.ps1: checksum verified"
  New-Item -ItemType Directory -Path $prefix -Force | Out-Null

  Write-Host "install.ps1: installing into $prefix ..."
  npm install --no-save --no-audit --no-fund --prefix $prefix $tarballPath >$null 2>&1

  $bin = Join-Path $prefix 'bin' 'dominus.cmd'
  if (-not (Test-Path $bin)) {
    Write-Host "install.ps1: installed, but 'dominus' is not on PATH."
    Write-Host "install.ps1: add $prefix\bin to PATH, or run $prefix\bin\dominus.cmd"
    exit 0
  }

  $version = & $bin --version
  Write-Host "install.ps1: done — $version"
  Write-Host "install.ps1: try 'dominus score vintagecoffee.com'"
}
finally {
  Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue
}
