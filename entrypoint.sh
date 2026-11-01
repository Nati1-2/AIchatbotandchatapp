#!/bin/sh
set -e

echo "=== Starting Relay All-in-One Service ==="

TARGET_PORT="${PORT:-10000}"
echo "1. Configuring Nginx on port ${TARGET_PORT}..."
sed -i "s/PORT_PLACEHOLDER/${TARGET_PORT}/g" /etc/nginx/nginx.conf

echo "2. Checking database configuration..."
if [ -n "$DATABASE_URL" ] && [ "$DATABASE_URL" != "postgresql+asyncpg://relay:relay@localhost:5432/relay" ]; then
    echo "Running database migrations on PostgreSQL..."
    alembic upgrade head || echo "Database migration warning: proceeding..."
else
    echo "Using local persistent database storage."
fi

echo "3. Starting FastAPI backend on 127.0.0.1:8000..."
uvicorn app.main:app --host 127.0.0.1 --port 8000 --no-access-log --ws-max-size 16384 &

echo "4. Starting Next.js frontend on 127.0.0.1:3000..."
PORT=3000 HOSTNAME=127.0.0.1 node /app/frontend-dist/server.js &

echo "5. Waiting for backend & frontend services to bind ports..."
sleep 2

echo "6. Starting Nginx reverse proxy on port ${TARGET_PORT}..."
exec nginx -g "daemon off;"
