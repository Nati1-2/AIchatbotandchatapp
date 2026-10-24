# Verification record — 24 October 2026

Verified in this workspace:

| Check | Result |
| --- | --- |
| Backend API/integration suite, real PostgreSQL 16 | 11 passed |
| Default SQLite backend suite | 10 passed, 1 PostgreSQL-only concurrency test skipped |
| Frontend strict TypeScript | Passed |
| Frontend message reconciliation/backoff tests | 4 passed |
| Next.js production build | Passed after final UI changes |
| PostgreSQL Alembic upgrade, drift check, downgrade, re-upgrade | Passed; no new upgrade operations |
| Docker Compose configuration | Validated with `docker compose … config --quiet` |
| Chromium browser acceptance scenario | Passed |

The browser scenario runs two separate authenticated browser contexts. It verifies live messages, reactions, editing, recovery after going offline, attachment processing/sharing, group creation, streaming from a test provider, persisted AI history after reload, and rejection of a WebSocket event targeting another user's private AI conversation. It also checks a 390 × 844 mobile viewport for horizontal overflow and captures screenshots. Desktop and mobile screenshots were visually reviewed.

The API suite covers registration conflicts, login/logout, expired sessions, CSRF and cross-origin rejection, unauthorized conversation/attachment/summary access, group roles, reply isolation, duplicate sends including simultaneous PostgreSQL requests, chronological pagination and missed-history reads, monotonic read cursors and unread counts, upload/worker/download/delete behavior, no-key AI configuration, provider failure/cancellation, usage limits, stop authorization and changed summary snapshots.

Tests use an explicit mock AI provider and never call a paid service. Browser tests use a temporary SQLite database, test-only in-memory Redis and object storage adapters, and the real application endpoints/worker/UI. Those adapters are excluded from the production Docker image. PostgreSQL tests exercise the real SQL database independently of the browser harness.

Not verified here:

- Full Docker image builds/startup: the Docker CLI is installed but the Docker daemon is not running.
- Actual Redis cross-instance Pub/Sub delivery, MinIO/S3 network integration, or deployment infrastructure.
- A real model provider request or real provider token accounting.
- Physical mobile-device keyboards, a screen-reader audit, large-group/load testing, or an external security audit.

The local environment disallowed subprocess/network behavior needed by some test runners inside its sandbox. Verification commands were run with approved local execution outside that sandbox. PostgreSQL used isolated temporary data and socket directories and a nondefault port, not a user's existing database.

Screenshots (test data, not model output claims):

- [Messaging](screenshots/messaging.png)
- [AI desktop](screenshots/desktop.png)
- [AI mobile](screenshots/mobile.png)
