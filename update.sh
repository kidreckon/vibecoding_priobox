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

echo
if [ -d "/Applications/PrioBox.app" ]; then
  echo "==> Replacing the old copy in /Applications"
  rm -rf "/Applications/PrioBox.app"
else
  echo "==> Installing into /Applications"
fi
cp -R "$APP_PATH" /Applications/

echo
echo "PrioBox $VERSION is now installed in /Applications."
echo "Open it and check the small grey badge under the title reads v$VERSION —"
echo "that confirms you are running the new build."
