#!/bin/sh
set -eu

echo "=== Starting Relay All-in-One Service ==="

TARGET_PORT="${PORT:-10000}"
echo "1. Configuring Nginx on port ${TARGET_PORT}..."
sed -i "s/PORT_PLACEHOLDER/${TARGET_PORT}/g" /etc/nginx/nginx.conf

echo "2. Checking database configuration..."
if [ -n "${DATABASE_URL:-}" ] && [ "$DATABASE_URL" != "postgresql+asyncpg://relay:relay@localhost:5432/relay" ]; then
    echo "Running database migrations on PostgreSQL..."
    alembic upgrade head
else
    echo "Using local persistent database storage."
fi

echo "3. Starting FastAPI backend on 127.0.0.1:8000..."
uvicorn app.main:app --host 127.0.0.1 --port 8000 --no-access-log --ws-max-size 16384 &
BACKEND_PID=$!

echo "4. Starting Next.js frontend on 127.0.0.1:3000..."
PORT=3000 HOSTNAME=127.0.0.1 node /app/frontend-dist/server.js &
FRONTEND_PID=$!

cleanup() {
    kill "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "5. Waiting for backend & frontend services to bind ports..."
attempt=0
until curl --fail --silent http://127.0.0.1:8000/health >/dev/null \
    && curl --fail --silent http://127.0.0.1:3000/ >/dev/null; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 30 ]; then
        echo "Backend or frontend failed to become ready."
        exit 1
    fi
    if ! kill -0 "$BACKEND_PID" 2>/dev/null || ! kill -0 "$FRONTEND_PID" 2>/dev/null; then
        echo "Backend or frontend exited during startup."
        exit 1
    fi
    sleep 1
done

echo "6. Starting Nginx reverse proxy on port ${TARGET_PORT}..."
exec nginx -g "daemon off;"
