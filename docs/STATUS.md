# Feature status and limits

Implemented in source:

- Next.js App Router with strict TypeScript, Tailwind theme, Radix/shadcn-style button/dialog primitives, TanStack Query, React Hook Form/Zod and small Zustand UI state.
- Consistent dark login/register, profile/settings dialogs, conversation list, direct/group chats, details, and Relay AI. Responsive mobile split views, keyboard focus, dialog focus trapping, reduced-motion CSS, empty/loading/error/retry/upload states.
- Argon2 registration/login, expiring server-side sessions, HttpOnly cookies, production Secure requirement, CSRF/origin validation, logout/all-session revocation and Redis authentication rate limits.
- PostgreSQL schema, migration, direct-chat uniqueness, membership checks, group role management, persisted idempotent sends, edits/tombstone deletes, replies, six server-supported reactions, history cursors, unread counts, pin/mute preferences.
- Native WebSockets with session/membership checks, typed/versioned event validation, transient typing, presence privacy, monotonic delivery/read cursors, reconnect/backoff, query reconciliation and failed-send retry.
- Private image/document uploads, progress, type/size validation, worker processing, authorized downloads, shared file list, image previews, abandoned metadata-backed upload cleanup.
- Configurable server-only AI adapter, authenticated streaming, private history, stop/retry, content clearing, safe highlighted Markdown, code/message copy, daily quotas, context/output/timeout budgets, usage/latency tracking, reviewed authorized selected-message summaries.
- Compose services, environment examples, development-only seed, lockfiles, API/browser tests and CI workflow.

Remaining limitations:

- Docker images and the real Redis/MinIO stack require a running Docker daemon. See the verification record for what was and wasn't exercised here. Browser tests use explicit test service adapters; they are not proof of production Redis/S3 connectivity.
- No live paid-provider request is made by automated tests. Real AI requires provider configuration and host streaming support.
- No end-to-end encryption, calls, push notifications, password recovery, MFA, moderation console, or full-text server-side message search. Search in an open conversation covers loaded history only and is labeled accordingly.
- Mute preferences suppress in-app activity alerts for other conversations. OS push/sound notifications are not implemented; unread badges remain visible.
- Group ownership transfer and group deletion are not exposed. The owner cannot leave or be removed. Admins cannot promote other admins or remove owners/admins.
- Emoji insertion has a compact picker; reactions support six emoji in a separate picker. Custom emoji and animated stickers are not included.
- Presence can lag by up to the 45-second lease plus the 15-second metadata poll. Read means a visible active conversation, not human attention. Mobile viewport behavior has browser coverage but not physical iOS/Android keyboard testing.
- PDF validation checks signature/type/size, not malware. Objects uploaded immediately before a metadata transaction crash can remain orphaned; production needs periodic bucket reconciliation. Stored metadata-backed abandoned uploads are cleaned automatically.
- Fan-out has no durable transactional outbox; clients recover through authoritative reads. There is no offline persistent queue across page reloads; failed optimistic messages remain retryable while the current view is mounted.
- Session/usage cleanup is basic; no administrator usage dashboard or retention UI. Query fan-out and small test datasets have not been load-tested for large groups.

These boundaries are deliberate first-version limits, not simulated functionality. See API and deployment documentation for exact contracts.
