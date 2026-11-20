#!/bin/sh
set -e

# Start splicedock in the foreground (tini is PID 1 and forwards signals).
exec node /app/dist/main.js
