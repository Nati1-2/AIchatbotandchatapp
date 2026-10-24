# Relay implementation milestones

1. Foundation: empty workspace inspected; Next.js strict TS app, shared dark tokens, FastAPI project and infrastructure. Verify dependency resolution and app compilation.
2. Identity: normalized schema, Alembic, Argon2 sessions and CSRF. Verify auth and isolation tests.
3. Messaging: persisted idempotent sends, history cursors, authorized versioned events, reconnect/refetch and receipts. Verify messaging tests.
4. Collaboration: roles, reactions, preferences, private attachments and worker. Verify permission and attachment tests.
5. AI: isolated conversation, provider adapter, authenticated streaming, cancellation, quotas and explicit selected-message summaries. Verify fake-provider tests.
6. Product: responsive UI, settings, accessible dialogs, error/retry states. Verify TypeScript, production build and browser scenarios where infrastructure permits.
7. Handoff: Compose, CI, API/events, deployment and honest limitations.

Use PostgreSQL for durable state, Redis only for ephemeral state/events. HTTP writes commit before publishing; reconnect always refetches authoritative history. Shared message model keeps ordinary and AI rendering consistent; AI conversation ownership and explicit selection gates constrain context.

## Milestone outcomes

- Foundation: dependency lockfiles created; strict TypeScript and production compilation passed.
- Identity: Argon2/session/CSRF and isolation tests passed; Alembic applied to real PostgreSQL without drift.
- Messaging/recovery: idempotency, concurrent retries, ordering, receipt and recovery tests passed; two-browser exchange/reconnect passed.
- Groups/files: role authorization and attachment worker/access/deletion tests passed; group creation and upload passed in browser.
- AI: isolated provider adapter, cancellation/failure/quota/selection checks passed; browser stream and persisted history passed with a test provider.
- Responsive/accessibility: desktop/mobile screenshots reviewed, mobile overflow checked, keyboard-focused controls and Radix dialogs implemented. Physical devices and screen readers remain unverified.
- Handoff: Compose, CI, setup, architecture, API/events, deployment, feature limits and verification documentation provided. Full Docker stack requires the local Docker daemon to be started.
