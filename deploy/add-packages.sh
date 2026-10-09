#!/usr/bin/env bash
#
# Mobile Py IDE — install extra Python packages for the runner.
#
# The runner uses the app's own virtual environment ($APP_DIR/venv), so
# packages installed here are available to every program you run in the IDE —
# that is how "pip install" works on this box.
#
# Usage (on the server):
#   sudo bash deploy/add-packages.sh requests
#   sudo bash deploy/add-packages.sh rich tabulate
#
# After installing, restart is not needed for a new run, but the service is
# restarted for you so nothing is cached oddly.
#
# NOTE: heavy libraries (torch, tensorflow, pandas, ...) are blocked by the
# validator on purpose — they would not fit a small server. If you accept the
# cost, remove the name from the blocked list first, e.g. in .env:
#   UNBLOCK_MODULES=pandas
#
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "Usage: sudo bash deploy/add-packages.sh <package> [package...]" >&2
  exit 1
fi
if [ "$(id -u)" -ne 0 ]; then
  echo "Please run as root (use sudo)." >&2
  exit 1
fi

APP_DIR="${APP_DIR:-/opt/mobile-py-ide}"
APP_USER="${APP_USER:-mobilepy}"
VENV="$APP_DIR/venv"

if [ ! -x "$VENV/bin/pip" ]; then
  echo "No virtual environment found at $VENV." >&2
  echo "Run the bootstrap first (sudo bash deploy/bootstrap.sh), then retry." >&2
  exit 1
fi

echo "==> Installing into $VENV: $*"
sudo -u "$APP_USER" "$VENV/bin/pip" install --upgrade "$@"

echo "==> Restarting the IDE service"
systemctl restart mobile-py-ide || true
sleep 1

echo "==> Installed. Available to your programs, e.g.:"
for pkg in "$@"; do
  echo "     import ${pkg%%[<>=]*}"
done
