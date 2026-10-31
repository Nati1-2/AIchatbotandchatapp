#!/usr/bin/env bash
# Start the backend API, worker and frontend in one terminal.
# Usage: ./dev.sh [--infra | --lite]
#   --infra  also start postgres/redis/storage via Docker Compose
#   --lite   no Docker needed: use the test-only backend (temporary SQLite, in-memory
#            Redis/storage, mocked AI). Data is discarded on exit.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$HOME/.local/bin:$PATH"  # default uv install location
MODE="${1:-}"

command -v uv >/dev/null || { echo "uv is not installed: https://docs.astral.sh/uv/" >&2; exit 1; }
command -v npm >/dev/null || { echo "npm is not installed" >&2; exit 1; }
if [[ ! -f "$ROOT/.env" ]]; then
  cp "$ROOT/.env.example" "$ROOT/.env"
  echo "Created $ROOT/.env. Add AI_API_KEY there to enable real AI."
fi
# One root environment file configures the frontend, backend and Compose.
set -a
# shellcheck disable=SC1091
source "$ROOT/.env"
set +a
[[ -d "$ROOT/frontend/node_modules" ]] || (cd "$ROOT/frontend" && npm ci)

if [[ "$MODE" == "--infra" ]]; then
  if ! docker info >/dev/null 2>&1; then
    docker_desktop=/opt/docker-desktop/bin/docker-desktop
    if [[ ! -x "$docker_desktop" ]]; then
      echo "Docker is not running. Start Docker, then run npm run dev again." >&2
      exit 1
    fi
    echo "Starting Docker Desktop…"
    setsid "$docker_desktop" >/tmp/relay-docker-desktop.log 2>&1 < /dev/null &
    for _ in {1..30}; do
      docker info >/dev/null 2>&1 && break
      sleep 2
    done
    if ! docker info >/dev/null 2>&1; then
      echo "Docker Desktop did not become ready. See /tmp/relay-docker-desktop.log" >&2
      exit 1
    fi
  fi
  # Publish Postgres on the port .env points at (e.g. 5433 when a system Postgres owns 5432).
  pg_port=$(grep -oP '^DATABASE_URL=.*@[^:/]+:\K[0-9]+' "$ROOT/.env" || echo 5432)
  POSTGRES_PORT=$pg_port docker compose --env-file "$ROOT/.env" -f "$ROOT/infra/compose.yaml" up -d --wait postgres redis storage
fi

(cd "$ROOT/backend" && uv sync --frozen --all-groups)
[[ "$MODE" == "--lite" ]] || (cd "$ROOT/backend" && uv run alembic upgrade head)
[[ "$MODE" != "--infra" ]] || (cd "$ROOT/backend" && uv run python -m app.storage_init)

# Run a command in a directory, prefixing each output line with a colored label.
run() {
  local name=$1 color=$2 dir=$3; shift 3
  (cd "$ROOT/$dir" && exec "$@") 2>&1 | sed -u "s/^/\x1b[${color}m[${name}]\x1b[0m /" &
}

trap 'trap - INT TERM EXIT; kill 0 2>/dev/null' INT TERM EXIT

if [[ "$MODE" == "--lite" ]]; then
  # The test server seeds alex/jordan and runs the worker in-process.
  run api  34 backend  uv run uvicorn tests.browser_server:app --host 127.0.0.1 --port 8000 --no-access-log
else
  run api    34 backend  uv run uvicorn app.main:app --reload --host 127.0.0.1 --port 8000 --no-access-log
  run worker 35 backend  uv run python -m app.worker
fi
run web 32 frontend npm run dev

echo "Frontend: http://localhost:3000   API: http://localhost:8000/docs   (Ctrl+C to stop)"
wait
