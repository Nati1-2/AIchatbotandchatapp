#!/bin/sh
set -e

echo "=== Starting Relay All-in-One Service ==="

echo "1. Running database migrations..."
alembic upgrade head || echo "Database migration completed with warnings."

echo "2. Starting FastAPI backend on 127.0.0.1:8000..."
uvicorn app.main:app --host 127.0.0.1 --port 8000 --no-access-log --ws-max-size 16384 &

echo "3. Starting Next.js frontend on 127.0.0.1:3000..."
PORT=3000 HOSTNAME=127.0.0.1 node /app/frontend-dist/server.js &

echo "4. Starting reverse proxy on port ${PORT:-10000}..."
exec caddy run --config /app/Caddyfile --adapter caddyfile
