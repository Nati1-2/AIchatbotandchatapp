# Deployment

## CI/CD

GitHub Actions runs `.github/workflows/ci.yml` for every pull request and every
push to `main` or `c1`. It type-checks, tests, and builds the frontend; compiles and
tests the backend; and then builds the same production Docker image used by
Render. Concurrent runs for an outdated commit are cancelled automatically.

After those checks pass on a push, the `Deploy to Render` job calls Render's
deploy hook. Add the hook URL as a GitHub Actions repository secret named
`RENDER_DEPLOY_HOOK_URL`, and protect the `production` GitHub environment if
deployment approval is required. If the secret is absent, CI still succeeds and
reports that deployment was skipped. Disable Render's native auto-deploy for the
service so a commit cannot deploy before CI finishes. Protecting `main` and `c1`
with the `Frontend`, `Backend`, and `Production container` checks is recommended.

## Render (one-click Blueprint)

The repository root contains `render.yaml`. In Render, choose **New > Blueprint**,
connect this repository, and deploy it. The Blueprint creates one Docker web
service, a PostgreSQL database, and a private Key Value instance; wires their
connection URLs automatically; and serves the frontend, API, and WebSocket
endpoint from the same HTTPS domain. No public API URL or CORS setting is needed.

`AI_API_KEY` is optional. Without it, text conversations use the clearly labeled
built-in demo assistant. Set it to a Gemini API key to enable model-generated
answers, transcription, and server-generated speech. Set `AI_DEMO_MODE=false`
to disable the fallback entirely.

Full-duplex voice uses `AI_LIVE_MODEL=gemini-3.8-live` by default. The public
proxy must forward WebSocket upgrades for `/ai/live/*`; the bundled Nginx and
Render configuration already do this. The Gemini project must have Live API
quota in addition to ordinary text-model quota.

After deployment, verify `https://YOUR-SERVICE.onrender.com/health`, then sign in
with `alex` / `Relay-demo-2026!` or `jordan` / `Relay-demo-2026!`.

## Frontend host

Deploy `frontend/` to a Next.js-compatible host (for example a Node host running the provided Dockerfile). Build with Node 24, `npm ci`, and `npm run build`. For a conventional Next host use `npm start`; for the standalone Docker output use `node server.js` as in the Dockerfile. Set **build-time** `NEXT_PUBLIC_API_URL=https://api.example.com`. Rebuild whenever the API public URL changes.

## Python host

Deploy the backend image to a Python/container host that supports **long-lived WebSockets and streaming HTTP responses**. Do not place the API on a short-lived request-only function platform. Run API and worker as separate processes from the same image. Point all instances at the same PostgreSQL, Redis, and private S3 bucket.

Run migrations as a single release job before serving traffic:

```sh
alembic upgrade head
```

API command:

```sh
uvicorn app.main:app --host 0.0.0.0 --port 8000 --ws-max-size 16384 --no-access-log
```

Worker command:

```sh
python -m app.worker
```

Use `/health` for liveness and `/ready` for database/Redis readiness. Configure log collection for JSON request records; don't enable request-body or cookie logging at the proxy. TLS must terminate at a trusted load balancer/proxy. Configure trusted forwarded IP headers explicitly for the actual proxy network so authentication limits see real client IPs without trusting spoofed headers. Disable buffering for `/conversations/*/ai/stream`, enable WebSocket upgrade forwarding for `/ws`, and set idle timeouts longer than the 20-second heartbeat.

## Required production configuration

- `ENVIRONMENT=production`, `SECURE_COOKIES=true`.
- Exact `FRONTEND_ORIGIN=https://app.example.com`; wildcard credentialed CORS is rejected.
- `DATABASE_URL=postgresql+asyncpg://...` with a dedicated least-privilege account, managed backups and TLS configuration.
- `REDIS_URL=rediss://...` where supported; Redis must not be exposed publicly.
- S3 endpoint/bucket and narrowly scoped server credentials; disable public bucket access. Configure encryption at rest and retention policies in the storage platform.
- `AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL` only on the backend, if AI is enabled. Set daily quotas and timeout/context budgets.
- Strong infrastructure credentials replacing all Compose development defaults. Never run `seed` in production.

### Cookies and origin arrangement

Local cookies use `HttpOnly; SameSite=Lax; Path=/`, with Secure off for HTTP localhost. Production requires Secure on. Sessions expire after `SESSION_DAYS` (14 by default), with an absolute server expiry and cookie max-age. Session tokens are not placed in localStorage or URLs; CSRF tokens are held in client memory.

Deploy frontend and API on **same-site sibling HTTPS domains**, such as `app.example.com` and `api.example.com`, or behind one site. The shipped Lax cookie policy does not support unrelated cross-site frontend/API domains. Do not solve this by enabling wildcard CORS. Register a custom same-site domain pair with your hosts. Restrict the API's Origin to the frontend and permit credentials only for it.

## Operations and limits

Run one or more workers; row locks coordinate processing. Keep the S3 bucket private. Add a malware-scanning service before offering unrestricted document distribution; current processing validates allowed types and image safety, not malicious PDF payloads. Apply a proxy request-size limit consistent with the 10 MB application limit and short upload timeouts. The worker sweeps the bucket hourly and deletes objects older than one hour that have no attachment row (crash orphans and files of deleted groups); its credentials therefore need list and delete permission on the bucket.

Database backups, restores, TLS certificates, secret rotation, alerting, capacity tests, and retention policy are deployment responsibilities. This first version polls conversation metadata and revalidates history for correctness; high-volume installations should batch list queries and introduce a durable outbox/change feed before scaling fan-out aggressively. A Redis outage affects login rate limiting, presence, listing and live events; it does not erase persisted messages. There is no claim of end-to-end encryption.

The local Compose file binds ports to loopback, uses development credentials, seeds demo users, and is not a production manifest.

## Relay Live voice

- `AI_LIVE_MODEL` must be a Gemini Live model your key can use. Verify it once after deploy: open Live and confirm the spoken greeting.
- Cost controls (per user, UTC day): `AI_LIVE_DAILY_MINUTES` (default 60) and `AI_LIVE_MAX_SESSION_MINUTES` (default 30). One live session per user; a newer tab or device takes over.
- `AI_VOICE_LANGUAGE` sets the default conversation language (BCP-47, e.g. `en-US`); users can change it in Live.
- The proxy must pass WebSocket upgrades for `/ai/live/` and `/ws` with long read timeouts (see `nginx.conf`). Browsers only allow the microphone over HTTPS.

## All-in-one container (Render)

`Dockerfile` + `entrypoint.sh` run Nginx, the API, the Next.js server and the worker in one container. Migrations run on start and abort startup if they fail. `render.yaml` provisions PostgreSQL and Redis; you must supply an S3-compatible bucket (`S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`) for attachments. `/ready` returns 503 in production when Redis is unreachable.
