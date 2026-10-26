#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# SPDX-FileCopyrightText: 2026 DOMINUS contributors
#
# Install dominus-oss from the GitHub Release channel.
#
# Downloads the tarball attached to the latest release, verifies its sha256
# checksum against the checksum published beside it, and installs it with npm
# into a user-owned prefix (no sudo required).
#
# Usage:
#
#   curl -fsSL https://github.com/AlessioBrillo/dominus/releases/latest/download/install.sh | sh
#
set -euo pipefail

REPO="AlessioBrillo/dominus"
BASE="https://github.com/${REPO}/releases/latest/download"
TARBALL="dominus-oss.tgz"
CHECKSUM="dominus-oss.tgz.sha256"
INSTALL_PREFIX="${DOMINUS_INSTALL_PREFIX:-$HOME/.local}"

command -v curl >/dev/null 2>&1 || { echo "install.sh: curl is required" >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "install.sh: npm is required" >&2; exit 1; }

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

echo "install.sh: downloading ${TARBALL} ..."
curl -fsSL --retry 3 --connect-timeout 30 --max-time 300 \
  -o "$TMPDIR/$TARBALL" "$BASE/$TARBALL"

echo "install.sh: downloading ${CHECKSUM} ..."
curl -fsSL --retry 3 --connect-timeout 30 --max-time 60 \
  -o "$TMPDIR/$CHECKSUM" "$BASE/$CHECKSUM"

ACTUAL="$(sha256sum "$TMPDIR/$TARBALL" | awk '{print $1}')"
EXPECTED="$(awk '{print $1}' "$TMPDIR/$CHECKSUM")"

if [ "$ACTUAL" != "$EXPECTED" ]; then
  echo "install.sh: checksum mismatch (expected $EXPECTED, got $ACTUAL)" >&2
  exit 1
fi

echo "install.sh: checksum verified"
mkdir -p "$INSTALL_PREFIX"

echo "install.sh: installing into $INSTALL_PREFIX ..."
npm install --no-save --no-audit --no-fund --prefix "$INSTALL_PREFIX" \
  "$TMPDIR/$TARBALL" >/dev/null 2>&1

if ! command -v dominus >/dev/null 2>&1; then
  echo "install.sh: installed, but 'dominus' is not on PATH." >&2
  echo "install.sh: add $INSTALL_PREFIX/bin to PATH, or run $INSTALL_PREFIX/bin/dominus" >&2
  exit 0
fi

echo "install.sh: done — $(dominus --version)"
echo "install.sh: try 'dominus score vintagecoffee.com'"
