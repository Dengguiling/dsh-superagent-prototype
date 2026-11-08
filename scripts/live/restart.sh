#!/usr/bin/env bash
# Rebuild the plugin and restart the DSH profile that serves it, then print the profile's URL.
#
# The superagent profile has no hot reload: the DSH process holds the plugin's server code in memory, so a rebuild
# only reaches the browser after the profile restarts, and the restart issues a new URL token. Run this after changing
# the panel, then open the URL it prints.
set -euo pipefail

# The profile that serves the panel. `DSH_PROFILE` names the profile this shell happens to be in, which is usually
# the web one, so this script reads its own variable.
PROFILE="${DSH_SUPERAGENT_PROFILE:-superagent}"
LOG="$HOME/.dsh/logs/$PROFILE.log"
cd "$(dirname "$0")/../.."

echo "== building the plugin =="
pnpm build

echo "== restarting the $PROFILE profile =="
pkill -f "dsh --profile $PROFILE" 2>/dev/null || true
sleep 2
mkdir -p "$(dirname "$LOG")"
nohup dsh --profile "$PROFILE" --no-open >>"$LOG" 2>&1 </dev/null &
disown 2>/dev/null || true

# The profile prints its URL with a fresh token once it is listening.
for _ in $(seq 1 60); do
  URL=$(grep -oE 'http://127\.0\.0\.1:[0-9]+/\?token=[A-Za-z0-9_-]+' "$LOG" 2>/dev/null | tail -1)
  [ -n "$URL" ] && break
  sleep 1
done

if [ -z "${URL:-}" ]; then
  echo "the profile did not print a URL; see $LOG" >&2
  exit 1
fi
echo "== open =="
echo "$URL"
