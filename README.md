# Relay

A Telegram-inspired messaging application with original Relay branding, a restrained dark interface, a Next.js frontend, and a Python/FastAPI backend. Messages are persisted in PostgreSQL. This is **not end-to-end encrypted**: the server can read message content.

## Start locally

Requirements: Docker Engine running and Docker Compose v2. From this repository root:

```sh
docker compose -f infra/compose.yaml up --build
```

Open **http://localhost:3000**. The first build downloads dependencies; the migration and development seed run automatically. API documentation: **http://localhost:8000/docs**. MinIO console: **http://localhost:9001** (development credentials `relay-local` / `relay-local-secret`). The attachment bucket is private.

Development accounts:

| Username | Password |
| --- | --- |
| `alex` | `Relay-demo-2026!` |
| `jordan` | `Relay-demo-2026!` |

The seed is idempotent and refuses to run unless `ENVIRONMENT=development`. It creates a direct conversation, “The studio” group, and a private AI conversation for each account. Never run this Compose file unchanged in production.

To enable real AI, copy `.env.example` to `.env`, set a server-side API key, then run:

```sh
docker compose --env-file .env -f infra/compose.yaml up --build
```

The adapter uses an OpenAI-compatible `/chat/completions` streaming API. Set `AI_BASE_URL`, `AI_MODEL`, and `AI_API_KEY` for your provider. No key is sent to the browser. Without a key, the UI explains that AI is unavailable; it does not fabricate responses.

Stop services without removing messages:

```sh
docker compose -f infra/compose.yaml down
```

## Two-browser walkthrough

1. Sign in as `alex` in a normal window and `jordan` in an incognito window (separate cookie jars).
2. Open their direct conversation and exchange messages. A single check means server-persisted; double checks mean all other members have delivered or read the message (hover for the exact state).
3. Use message actions to reply, edit your message, react, copy, or select text for an AI summary. Hover or keyboard-focus a message to reveal actions; mobile users can tap it.
4. Disconnect one browser, send from the other, reconnect, and reopen the conversation. History comes from PostgreSQL; missed Redis events do not lose messages.
5. Use New conversation → New group, search for `jordan`, and name the group. Open details to add/remove members or change roles as owner.
6. Attach a PNG, JPEG, WebP, PDF, or UTF-8 text file (up to 10 MB). Wait for worker validation, then send. Shared files appear in details.
7. Open Relay AI. With a provider key, send a prompt, stop generation, or retry a failed request. For summaries, select message actions → review the exact text → confirm.

## Develop without containers

Use Node.js 24 and Python 3.12+. Install [uv](https://docs.astral.sh/uv/getting-started/installation/). Run PostgreSQL, Redis and an S3-compatible service first; create a private `relay-private` bucket. The Compose infrastructure services can be started independently:

```sh
docker compose -f infra/compose.yaml up -d postgres redis minio storage-init
```

Backend, in one terminal:

```sh
cd backend
cp .env.example .env
# Set S3_ACCESS_KEY=relay-local and S3_SECRET_KEY=relay-local-secret for local Compose storage.
uv sync --frozen --all-groups
uv run alembic upgrade head
uv run python -m app.seed
uv run uvicorn app.main:app --reload --host 127.0.0.1 --port 8000 --no-access-log
```

Worker, in another terminal:

```sh
cd backend
uv run python -m app.worker
```

Frontend, in a third terminal:

```sh
cd frontend
cp .env.example .env.local
npm ci
npm run dev
```

Use `localhost` consistently: mixing `127.0.0.1` and `localhost` in browser URLs changes cookie and origin behavior.

## Checks

```sh
cd backend
uv run pytest -q
# Optional, DESTRUCTIVE to the named disposable test database only:
TEST_DATABASE_URL=postgresql+asyncpg://relay:relay@localhost:5432/relay_test uv run pytest -q
cd ../frontend
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

Browser tests launch their own test-only backend on port 8000 and frontend on 3000. Stop ordinary servers first. They use SQLite, an in-memory event bus/private object store, and an explicitly mocked provider; they never call paid AI services. Their backend is under `backend/tests/` and is excluded from the production Docker image. API tests run with SQLite by default; CI also runs them against PostgreSQL. See [verification](docs/VERIFICATION.md) for the checks actually run in this workspace.

## Project map

- `frontend/`: App Router, strict TypeScript, Tailwind, shadcn-style Radix primitives, TanStack Query, React Hook Form/Zod, Zustand selection state, native WebSocket client.
- `backend/app/`: authentication, messaging, events, attachments, worker, AI adapter, schemas and normalized SQLAlchemy models.
- `backend/migrations/`: Alembic schema migration.
- `infra/`: local Docker Compose stack.
- `docs/`: [architecture](docs/ARCHITECTURE.md), [API/events](docs/API.md), [deployment](docs/DEPLOYMENT.md), [feature status](docs/STATUS.md), and [verification](docs/VERIFICATION.md).

Dependency resolution is recorded in `frontend/package-lock.json` and `backend/uv.lock`. Use `npm ci` and `uv sync --frozen` for reproducible installs.
