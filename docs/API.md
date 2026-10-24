# API and WebSocket contract

Interactive OpenAPI: `GET /docs`. Machine-readable schemas: `GET /openapi.json`. Request/response models are validated with Pydantic. Authentication requires a `relay_session` HttpOnly cookie. Mutations also require `Origin` equal to `FRONTEND_ORIGIN` and `X-CSRF-Token` from `/auth/me` (or login/register response). Login/register require the exact origin and are rate-limited by IP and username.

| Method and route | Purpose |
| --- | --- |
| `POST /auth/register`, `/auth/login` | Username/password, session + CSRF response |
| `GET /auth/me` | Current profile, CSRF, AI configuration state |
| `POST /auth/logout` | Revoke current session |
| `DELETE /auth/sessions` | Revoke all sessions |
| `PATCH /profile` | Display name and presence privacy |
| `GET /users?q=…` | Username search, at least two characters |
| `GET/POST /conversations` | List/create direct, group or private AI conversations |
| `PATCH /conversations/{id}/preferences` | Pinned and muted settings |
| `POST /conversations/{id}/members` | Add member / owner changes admin role |
| `DELETE /conversations/{id}/members/{user}` | Remove authorized group member |
| `GET /conversations/{id}/messages` | Cursor history: `before`, `after`, `limit` 1–100 |
| `POST /conversations/{id}/messages` | Durable idempotent send with `client_id`, body, reply and attachment IDs |
| `PATCH/DELETE /messages/{id}` | Edit own text / authorized tombstone deletion |
| `POST /messages/{id}/reactions` | Toggle one supported emoji |
| `POST /conversations/{id}/receipts` | Monotonic `{seq, read}` receipt |
| `POST /conversations/{id}/attachments` | Multipart `file` upload |
| `GET /attachments/{id}` | Processing status |
| `GET /attachments/{id}/download` | Membership-authorized download |
| `GET /conversations/{id}/attachments` | Shared ready attachments |
| `POST /conversations/{id}/ai/stream` | Authenticated SSE-over-fetch response stream |
| `POST /ai/generations/{id}/stop` | Owner cancellation request |
| `DELETE /conversations/{id}/ai/history` | Erase AI content when no response is active |
| `GET /health`, `/ready` | Liveness / database and Redis readiness |

Typical error:

```json
{"error":{"code":403,"message":"Invalid CSRF token or origin.","request_id":"uuid"}}
```

Validation errors return 422 with field locations and messages, excluding submitted values. No private bodies or credentials are logged. Missing membership returns 404 to avoid confirming private resource existence.

## WebSocket v1

Connect to `/ws` with the same cookie and exact Origin. Session expiry/revocation is checked on incoming events, outgoing events, and on the heartbeat cycle. Unauthorized connection: 4401; disallowed origin: 4403; malformed client event: 4400. Set proxy and Uvicorn frame limits (Compose defaults are documented under deployment).

Server event envelope:

```json
{"v":1,"event_id":"uuid","type":"message.created","conversation_id":"uuid","payload":{}}
```

| Type | Payload |
| --- | --- |
| `message.created`, `message.updated`, `message.deleted`, `reaction.updated` | Full public message: IDs, sequence, body/tombstone, sender, time, edited, reply, reactions, attachment metadata |
| `typing.updated` | `{user_id, name, expires_in: 5}` |
| `presence.updated` | `{user_id, online}`; obeys privacy |
| `conversation.read` | `{user_id, read_seq, delivered_seq}` |
| `conversation.updated` | `{}`; refetch conversation details and history |

Client transient event:

```json
{"v":1,"request_id":"uuid","type":"typing.updated","conversation_id":"uuid"}
```

Only `typing.updated` and `presence.updated` are accepted as client events. All durable mutations use REST. Successful transient events return `{"v":1,"type":"ack","request_id":"…","payload":{"accepted":true}}`. Membership failures return `type: error`, correlated request ID, and `{code, message}`. Heartbeat: server `{"v":1,"type":"ping"}`, client `{"v":1,"type":"pong"}`. Acknowledgements and heartbeats are not durable event records and have no `event_id`.

Clients must not infer persistence from Pub/Sub receipt. On reconnect, refetch history or request `?after=last_seq` until `has_more=false`. Mutations/deletions also require revalidation of cached history. The bundled client refetches loaded history pages, with 15-second reconciliation polling.

## AI SSE

Body: `{client_id, body, selected_ids?: [], selected_snapshots?: {messageId: "exact previewed body"}}`. The selected arrays are used only after explicit summary confirmation. The API reauthorizes and compares every snapshot.

Events: `start {generation_id}`, `delta {text}`, `done {tokens}`, `cancelled {}`, `error {message}`. They use SSE framing (`event:` and JSON `data:` separated by a blank line). This is a POST fetch stream, not an unauthenticated EventSource. Stop uses the generation endpoint and client abort. Completed assistant text is persisted; partial text is discarded. An unconfigured provider returns HTTP 503 before opening a stream. Limits return 429; an active generation returns 409.
