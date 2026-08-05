#!/usr/bin/env bash
# Pull the latest code, rebuild PrioBox.app and install it into /Applications.
#
# The .app is a self-contained snapshot: `git pull` alone updates the source but
# leaves the installed app untouched, so it must be rebuilt to pick up changes.
set -euo pipefail

cd "$(dirname "$0")"

if pgrep -x PrioBox >/dev/null 2>&1; then
  echo "PrioBox is running. Quit it first (Cmd+Q), then run this again." >&2
  exit 1
fi

echo "==> Fetching the latest code"
git pull

echo
echo "==> Installing dependencies"
npm install

echo
echo "==> Building PrioBox.app (this takes a minute)"
npm run dist

APP_PATH="$(find dist -maxdepth 2 -name 'PrioBox.app' -print -quit)"
if [ -z "$APP_PATH" ]; then
  echo "Build finished but PrioBox.app was not found — check dist/ for errors." >&2
  exit 1
fi

VERSION="$(node -p "require('./package.json').version")"

# /Applications is often not writable on managed Macs, and POSIX permissions
# can claim otherwise while the write is still refused by policy. Probe with a
# real file rather than trusting -w, and only ever remove the installed copy
# once the destination is known to accept writes.
can_write() {
  [ -d "$1" ] || return 1
  probe="$1/.priobox-write-probe.$$"
  ( : > "$probe" ) 2>/dev/null || return 1
  rm -f "$probe"
  return 0
}

echo
if can_write /Applications; then
  TARGET_DIR="/Applications"
else
  TARGET_DIR="$HOME/Applications"
  mkdir -p "$TARGET_DIR"
  if ! can_write "$TARGET_DIR"; then
    echo "Cannot write to /Applications or $TARGET_DIR." >&2
    echo "The app was still built — you can run it from:" >&2
    echo "  $PWD/$APP_PATH" >&2
    exit 1
  fi
  echo "    /Applications refused the write (this Mac may be managed),"
  echo "    so PrioBox is going into $TARGET_DIR instead."
fi

if [ -d "$TARGET_DIR/PrioBox.app" ]; then
  echo "==> Replacing the old copy in $TARGET_DIR"
  rm -rf "$TARGET_DIR/PrioBox.app"
else
  echo "==> Installing into $TARGET_DIR"
fi
cp -R "$APP_PATH" "$TARGET_DIR/"

# An older copy left somewhere else stays stale forever and is easy to launch
# by mistake — the whole reason this script exists.
OTHERS="$(mdfind -name 'PrioBox.app' 2>/dev/null \
  | grep -v "^$TARGET_DIR/PrioBox.app$" \
  | grep -v "^$PWD/dist/" || true)"
if [ -n "$OTHERS" ]; then
  echo
  echo "!!  Other copies of PrioBox.app exist and will NOT be updated:"
  echo "$OTHERS" | sed 's/^/      /'
  echo "    Delete them so you cannot launch an old build by mistake."
fi

echo
echo "PrioBox $VERSION is installed in $TARGET_DIR."
echo "Open it with:  open \"$TARGET_DIR/PrioBox.app\""
echo "Check the small grey badge under the title reads v$VERSION —"
echo "that confirms you are running the new build."
