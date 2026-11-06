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
- Relay Live (Gemini Live): full-duplex audio relay with AudioWorklet capture, local barge-in ducking, echo gating, pinned conversation language (15 languages), tuned voice-activity detection, captions, reconnect with Gemini session resumption, history seeding, saved transcripts, per-user daily minutes, session length cap and single active session.
- Server-wide message search (membership-scoped, wildcard-safe, paginated, pg_trgm index) with jump-to-message.
- Group lifecycle: ownership transfer, owner leaving hands the group to an admin (or deletes it when last), owner-only group deletion, removal notices to people who lose access.
- Persistent outbox: unsent messages survive reloads and are resent on reconnect (idempotent on client_id), with retry and discard.
- Desktop notifications (background tab) and an in-app chime, respecting muted chats.
- Hourly worker sweep that deletes stored objects with no attachment record.
- Origin policy: production trusts only FRONTEND_ORIGIN (or same origin); development trusts localhost and private-network addresses only. Error responses carry CORS headers only for trusted origins.
- Redis: real Redis is always used when reachable; the in-process fallback is only used while it is down (retried every 30 s) and `/ready` reports it in production.

Remaining limitations:

These need external services, accounts or a larger design and are deliberately not simulated:

| Gap | What it needs |
| --- | --- |
| Password recovery | An email provider (SMTP, Postmark, SES…) and verified email addresses on accounts. |
| MFA | TOTP enrolment/recovery-code UX and a decision on enforcement; no external service needed. |
| Push notifications to closed apps | VAPID keys, a service worker and a subscription store (Web Push); iOS requires the app installed to the home screen. |
| Person-to-person voice/video calls | WebRTC signalling plus TURN servers for users behind strict NATs. |
| End-to-end encryption | A key-management design (e.g. the Signal protocol); incompatible with server-side search and AI over messages. |
| Malware scanning of uploads | A scanner such as ClamAV as a sidecar service called by the worker. |
| Moderation and admin dashboard | Roles above group owners, reporting flows and an admin UI. |
| Durable event outbox | A transactional outbox table relayed to Redis; clients currently recover through authoritative reads. |
| Load testing | A k6/Locust scenario against a staging stack sized like production. |

Other notes:

- Production file uploads need an S3-compatible bucket (Cloudflare R2, AWS S3, Backblaze B2); `render.yaml` prompts for it.
- Live voice has been verified against the real Gemini Live API (greeting, language pinning, audio streaming) but not yet with a physical microphone on iOS/Android hardware.
- Presence can lag by up to the 45-second lease plus the 15-second metadata poll. Read means a visible active conversation, not human attention.
- PDF validation checks signature/type/size, not malware.
