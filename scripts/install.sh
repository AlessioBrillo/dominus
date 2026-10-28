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
# The release base is overridable so the installer can be exercised against a
# local fixture before it is shipped (scripts/test-installers.mjs).
BASE="${DOMINUS_RELEASE_BASE:-https://github.com/${REPO}/releases/latest/download}"
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
# `-g` is what puts the binary in `$INSTALL_PREFIX/bin`. Without it npm
# installs under `$INSTALL_PREFIX/node_modules/.bin`, which is not on PATH
# and is not where this script says the command lives.
npm install -g --no-save --no-audit --no-fund --prefix "$INSTALL_PREFIX" \
  "$TMPDIR/$TARBALL" >/dev/null 2>&1

# Check the path the script promises, not PATH: the prefix is user-owned and
# is normally not on PATH yet, so `command -v dominus` would report failure
# after a perfectly good install - and the old script exited 0 in that case,
# which is how a silent success with no usable command happened.
BIN="$INSTALL_PREFIX/bin/dominus"
if [ ! -x "$BIN" ]; then
  echo "install.sh: npm did not install the command at $BIN" >&2
  exit 1
fi

echo "install.sh: done — $("$BIN" --version)"
echo "install.sh: add $INSTALL_PREFIX/bin to PATH, then run 'dominus score vintagecoffee.com'"
