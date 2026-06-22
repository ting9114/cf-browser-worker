#!/bin/bash
set -e

if [ "$HEADED" = "true" ]; then
  echo "[entrypoint] Starting Xvfb for headed mode..."
  Xvfb :99 -screen 0 1920x1080x24 -ac &
  export DISPLAY=:99
  sleep 1
  echo "[entrypoint] Xvfb started on :99"
fi

echo "[entrypoint] Starting CF Browser Worker (HEADED=$HEADED, PORT=$PORT)..."
exec node src/server.js
