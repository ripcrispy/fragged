#!/usr/bin/env bash
# Start/restart the dev server in the background, recording its PID in data/server.pid.
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/node/bin:$PATH"
if [ -f data/server.pid ] && kill -0 "$(cat data/server.pid)" 2>/dev/null; then kill "$(cat data/server.pid)"; sleep 1; fi
AUTH_DEV_PROVIDER=1 nohup node --env-file-if-exists=.env --import tsx src/server.ts > data/server.log 2>&1 &
echo $! > data/server.pid
for i in $(seq 1 60); do curl -s localhost:${PORT:-3000}/healthz >/dev/null && { echo "up (pid $(cat data/server.pid))"; exit 0; }; sleep 1; done
echo "server did not start"; tail -20 data/server.log; exit 1
