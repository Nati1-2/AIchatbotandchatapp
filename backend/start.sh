#!/bin/sh
set -e

echo "Running database migrations..."
alembic upgrade head || echo "Migration command completed with warnings"

echo "Starting server on port ${PORT:-8000}..."
exec uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8000}" --no-access-log --ws-max-size 16384
