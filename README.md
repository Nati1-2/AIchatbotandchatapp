# Relay

<p align="center">
  <img src="docs/screenshots/ai-voice-live.png" alt="Relay Live AI Voice Interface" width="720" />
</p>

<p align="center">
  <strong>Private real-time messaging and natural, full-duplex AI voice conversations in one unified workspace.</strong>
</p>

<p align="center">
  <a href="#key-features"><img src="https://img.shields.io/badge/features-voice%20%2B%20chat-blue?style=flat-square" alt="Features"></a>
  <a href="https://nextjs.org"><img src="https://img.shields.io/badge/Next.js-16.1-black?style=flat-square&logo=next.js" alt="Next.js"></a>
  <a href="https://react.dev"><img src="https://img.shields.io/badge/React-19.2-61dafb?style=flat-square&logo=react" alt="React"></a>
  <a href="https://fastapi.tiangolo.com"><img src="https://img.shields.io/badge/FastAPI-0.115%2B-009688?style=flat-square&logo=fastapi" alt="FastAPI"></a>
  <a href="https://www.python.org"><img src="https://img.shields.io/badge/Python-3.12%2B-3776AB?style=flat-square&logo=python" alt="Python"></a>
  <a href="https://www.postgresql.org"><img src="https://img.shields.io/badge/PostgreSQL-17-336791?style=flat-square&logo=postgresql" alt="PostgreSQL"></a>
  <a href="https://redis.io"><img src="https://img.shields.io/badge/Redis-7.4-DC382D?style=flat-square&logo=redis" alt="Redis"></a>
  <a href="https://ai.google.dev"><img src="https://img.shields.io/badge/Gemini-Live%20API-4285F4?style=flat-square&logo=google" alt="Gemini Live"></a>
  <a href="https://docker.com"><img src="https://img.shields.io/badge/Docker-Ready-2496ED?style=flat-square&logo=docker" alt="Docker"></a>
</p>

---

## 📖 Table of Contents

- [Overview](#overview)
- [Video Demo & Visuals](#video-demo--visuals)
- [Key Features](#key-features)
  - [Relay Live (Gemini AI Voice)](#-relay-live-conversational-ai-voice)
  - [Real-Time Human Messaging](#-real-time-human-messaging)
  - [Relay AI (Streaming Text Assistant)](#-relay-ai-streaming-text-chat)
  - [Security & Architecture Standards](#-security--architecture-standards)
- [System Architecture](#system-architecture)
  - [Architecture Diagram](#architecture-diagram)
  - [Live Voice Turn Sequence](#live-voice-turn-sequence)
  - [Technology Stack Matrix](#technology-stack-matrix)
- [Getting Started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Environment Setup](#environment-setup)
  - [Running the Stack](#running-the-stack)
  - [Dev Accounts & Access Ports](#dev-accounts--access-ports)
- [Configuration Reference](#configuration-reference)
- [API & WebSocket Protocols](#api--websocket-protocols)
  - [REST API Summary](#rest-api-summary)
  - [Core WebSocket (`/ws`)](#core-websocket-ws)
  - [Relay Live WebSocket (`/ai/live/{id}`)](#relay-live-websocket-ailiveid)
  - [AI Text Stream (`/conversations/{id}/ai/stream`)](#ai-text-stream-conversationsidai-stream)
- [Testing & Quality Assurance](#testing--quality-assurance)
- [Production Deployment](#production-deployment)
- [Documentation Index](#documentation-index)
- [Feature Status & Limitations](#feature-status--limitations)
- [License](#license)

---

## Overview

**Relay** merges a high-performance, real-time collaboration messenger with **Relay Live** — a native conversational AI voice engine powered by Google Gemini Live.

Unlike conventional chatbots that slap a microphone icon onto a text prompt, Relay Live is architected from the ground up as an ongoing, low-latency, full-duplex spoken dialogue. Speak naturally, interrupt the assistant mid-sentence with real-time barge-in, switch between 15 supported languages, and review saved transcripts that integrate directly into your conversation history.

Behind the scenes, Relay is backed by production-grade foundations: **PostgreSQL** as the immutable source of truth, **Redis** for sub-millisecond presence and WebSocket event fan-out, private **S3-compatible object storage** with validation workers, and an asynchronous **FastAPI** backend coupled with a modern **Next.js 16** and **React 19** frontend.

---

## Video Demo & Visuals

| Relay Live Voice Session | Real-Time Group & Direct Messaging |
| :---: | :---: |
| ![Relay Live Speaking](docs/screenshots/ai-voice-live.png) | ![Messaging Interface](docs/screenshots/messaging.png) |

> 🎬 **Watch the product demo:** [10-Second WebM Demo Video](docs/demo/relay-demo.webm)

---

## Key Features

### 🎙️ Relay Live: Conversational AI Voice

Relay Live connects the client directly through an authenticated WebSocket proxy to the Gemini Live bi-directional streaming API.

- **AI Speaks First**: Opens every live session with an immediate, friendly spoken greeting.
- **Full-Duplex Audio Streaming**: 16 kHz mono PCM microphone capture streamed via `AudioWorklet` simultaneously with incoming 24 kHz speech responses.
- **Natural Interruption (Barge-In)**: Start speaking while the assistant is talking, and Relay instantly ducks and clears queued audio buffers on both client and server.
- **Hardware-Tuned Audio Processing**: Built-in echo gating, acoustic noise suppression, and voice activity detection (VAD) prevent self-echo and background chatter from triggering spurious turns.
- **Responsive Dynamic Waveform**: Canvas-rendered visualization reactively scales with microphone input and morphs states during listening, thinking, and speaking phases.
- **Pinned Language Enforcement**: Lock your conversation to any of 15 supported BCP-47 languages (English, Spanish, French, German, Japanese, and more). If audio is unintelligible, Relay requests clarification in the target language rather than hallucinating.
- **Live Two-Way Captions**: Real-time transcribed text display for both user speech and AI responses with quick toggle controls.
- **Persistent Context & Resumption**: Live sessions inherit recent chat history as contextual memory; completed exchanges are saved to the persistent database log, and network disconnects smoothly resume active Gemini session handles.
- **Enterprise Cost & Abuse Controls**: Enforced per-user daily live minute budgets, maximum session durations, and single active session locks (newer devices automatically supersede older sessions).

---

### 💬 Real-Time Human Messaging

A complete, resilient direct and group chat platform designed for modern teams.

- **Direct & Group Chats**: 1:1 private conversations and owner-managed group rooms with role management (Owner, Admin, Member), ownership transfer, and safe member exits.
- **Server-Wide Fuzzy Search**: Rapidly query messages across all authorized conversations using `pg_trgm` trigram indexing, highlighted snippets, and instantaneous jump-to-message navigation.
- **Resilient Offline Outbox**: Messages composed offline or during network blips survive browser refreshes and automatically flush with idempotent client UUIDs once connectivity restores.
- **Granular Message Operations**: Edits with edit indicators, reversible tombstone deletions, reply threading, and 6 server-validated emoji reactions.
- **Live Presence & Typing**: Sub-second Redis-backed typing indicators (5-second decay) and online presence leases with user privacy controls (hide last seen/online status).
- **Monotonic Delivery & Read Receipts**: Distinct single checkmark (persisted to server), double checkmarks (delivered to client), and blue receipts (read in active visible window). Aggregated across group members.
- **Secure File Attachments**: Private upload pipeline for images (PNG, JPEG, WebP), PDFs, and plain text up to 10 MB with background verification workers and pre-signed authenticated streaming downloads.
- **Conversation Controls**: Pin important chats to the top, mute noisy threads (silencing desktop notifications and chimes), and review shared media galleries.

---

### 🤖 Relay AI: Streaming Text Chat

- **SSE Streaming Over Authenticated Fetch**: Real-time text completions powered by Gemini (`gemini-2.5-flash`) via an OpenAI-compatible endpoint.
- **Safe Markdown Rendering**: Full GitHub Flavored Markdown (GFM) support, syntax-highlighted code blocks, copy-to-clipboard actions, and sanitized HTML output.
- **Message Summaries with Verified Consent**: Select specific chat messages to summarize; the server re-verifies cryptographic body snapshots to ensure untrusted context is safely quoted and verified before submission to the LLM.
- **Quotas & Guards**: Per-user daily generation limits, active concurrency locks, character budgets, and response timeout breakers.

---

### 🛡️ Security & Architecture Standards

- **Stateful HttpOnly Sessions**: Cryptographically random session cookies; only SHA-256 token hashes are stored in PostgreSQL. Global and per-device session revocation.
- **CSRF & Strict Origin Enforcement**: Double-submit CSRF tokens combined with origin whitelisting (`FRONTEND_ORIGIN`).
- **Zero API Key Leakage**: LLM provider credentials and S3 master secrets reside strictly on the server; the frontend communicates exclusively via authenticated backend proxies.
- **Password Hashing**: State-of-the-art Argon2id password hashing with custom salt generation.
- **Rate Limiting**: Tiered Redis rate limiters guarding authentication endpoints, AI streaming, and live voice creation.

---

## System Architecture

### Architecture Diagram

```mermaid
flowchart LR
    subgraph Client["Frontend Client (Next.js 16 / React 19)"]
        UI["Web UI & Zustand Store"]
        AudioEng["AudioWorklet Engine (16kHz PCM)"]
        ReactQuery["TanStack Query Cache"]
    end

    subgraph Gateway["Edge & Security Layer"]
        Proxy["Reverse Proxy (Nginx / Render)"]
    end

    subgraph Backend["Relay Core Services"]
        API["FastAPI REST & WebSocket Server"]
        Worker["Async File & Cleanup Worker"]
    end

    subgraph Data["Storage & State Infrastructure"]
        PG[("PostgreSQL 17\n(Source of Truth)")]
        Redis[("Redis 7.4\n(Pub/Sub, Leases, Limits)")]
        S3[("S3 / RustFS\n(Private Attachments)")]
    end

    subgraph External["AI Providers"]
        GeminiLive["Gemini Live WebSocket\n(gemini-3.8-live)"]
        GeminiChat["Gemini Chat API\n(gemini-2.5-flash)"]
    end

    UI -->|REST + CSRF / HttpOnly Cookie| Proxy
    UI <-->|WebSocket v1 (/ws)| Proxy
    UI <-->|SSE Stream (/ai/stream)| Proxy
    AudioEng <-->|PCM WebSocket (/ai/live)| Proxy

    Proxy --> API
    API --> PG
    API <--> Redis
    API --> S3
    Worker --> PG
    Worker --> S3

    API <-->|Full-Duplex Bidi Audio| GeminiLive
    API -->|SSE Completions| GeminiChat
```

---

### Live Voice Turn Sequence

```mermaid
sequenceDiagram
    autonumber
    participant User as 👤 User
    participant Browser as 💻 Browser (AudioWorklet)
    participant Relay as ⚡ Relay API
    participant Gemini as 🧠 Gemini Live API

    Browser->>Relay: WS /ai/live/{conv_id}?lang=en-US (Cookie Auth)
    Relay->>Relay: Validate session, verify daily minutes & acquire concurrency lock
    Relay->>Gemini: Establish bidi session (voice: Kore, language rules, VAD, history context)
    Gemini-->>Relay: Initial session setup ACK + Spoken Greeting
    Relay-->>Browser: Spoken greeting (24 kHz PCM) + Greeting text captions
    Browser->>User: Playback greeting through AudioContext

    loop Full-Duplex Spoken Conversation
        User->>Browser: Speaks into microphone
        Browser->>Relay: Stream 16 kHz mono PCM frames (20ms chunks, echo-gated)
        Relay->>Gemini: Forward realtimeInput audio frames
        Gemini-->>Relay: Streamed reply audio (24 kHz) + incremental transcription
        Relay-->>Browser: Streamed audio chunks + output_transcript events
        Browser->>User: Continuous playback & animated waveform
        Relay->>Relay: Persist turn exchange into chat history (PostgreSQL)
    end

    opt Natural Interruption (Barge-in)
        User->>Browser: Speaks over assistant playback
        Browser->>Browser: Immediately duck/mute current audio output
        Gemini-->>Relay: Signal 'interrupted' event
        Relay-->>Browser: Forward 'interrupted' event
        Browser->>Browser: Flush remaining audio playback buffer queue
    end
```

---

### Technology Stack Matrix

| Area | Component | Technologies |
| :--- | :--- | :--- |
| **Frontend** | Framework | **Next.js 16** (App Router, Turbopack/Webpack), **React 19** |
| | Language & Styling | **TypeScript 5.9** (strict), **Tailwind CSS 4**, Radix UI primitives |
| | State & Data Fetching | **TanStack React Query v5**, **Zustand**, React Hook Form, Zod 4 |
| | Audio Processing | Web Audio API, **AudioWorklet**, PCM16 Resampler, Canvas Waveforms |
| | Content Rendering | `react-markdown`, `remark-gfm`, `rehype-highlight` |
| **Backend** | Framework | **FastAPI 0.115+**, Starlette, **Uvicorn**, Pydantic v2 |
| | Language & Runtime | **Python 3.12+**, package management via **uv** |
| | Database ORM | **SQLAlchemy 2.0** (asyncio), **Alembic** migrations |
| | Authentication | Argon2id (`argon2-cffi`), Secure HttpOnly cookies, CSRF tokens |
| | Real-Time & Concurrency | Native WebSockets (`websockets 15+`), `asyncio`, Redis Pub/Sub |
| | Storage Driver | `boto3` / `aioboto3` (S3 API compatible) |
| **Data & Infra** | Primary Database | **PostgreSQL 17** with `pg_trgm` extension |
| | In-Memory Cache | **Redis 7.4** (events, presence tracking, rate limits) |
| | Object Storage | **RustFS** / MinIO / AWS S3 / Cloudflare R2 |
| | Containerization | Docker multi-stage builds, Docker Compose v2 |

---

## Getting Started

### Prerequisites

Ensure the following tools are installed on your host system:

- [Docker Engine](https://docs.docker.com/engine/install/) & [Docker Compose v2](https://docs.docker.com/compose/) (or Docker Desktop)
- [Node.js 24 LTS](https://nodejs.org/) & `npm`
- [Python 3.12+](https://www.python.org/)
- [uv](https://docs.astral.sh/uv/) (Ultra-fast Python package installer & resolver)

```bash
# Verify installations
node --version       # v24.x
python3 --version    # 3.12+
uv --version         # 0.5+
docker compose version
```

---

### Environment Setup

Create your local `.env` configuration from the provided template:

```bash
cp .env.example .env
```

Open `.env` and configure your Google Gemini API key:

```env
AI_API_KEY=your_actual_gemini_api_key_here
```

> **Note:** If `AI_API_KEY` is left blank, Relay will start in demo mode with mocked AI responses so you can still test chat messaging, group functionality, and presence without an external provider key.

---

### Running the Stack

You have three convenient ways to launch Relay:

#### 1. Full Development Stack (Recommended)
Automatically boots Postgres, Redis, and S3 in Docker, runs database migrations, initializes storage buckets, and starts both the FastAPI server, worker, and Next.js frontend in a single consolidated terminal:

```bash
npm run dev
# or
./dev.sh --infra
```

#### 2. Lite Mode (Zero Docker Required)
Runs entirely in memory with temporary SQLite, in-process mocked Redis, and simulated AI. Perfect for quick UI tweaks and offline development without launching containers:

```bash
npm run dev:lite
# or
./dev.sh --lite
```

#### 3. Infrastructure Only
Spins up only the supporting containers (PostgreSQL, Redis, Storage) in detached mode:

```bash
npm run dev:infra
# or
./dev.sh --infra
```

---

### Dev Accounts & Access Ports

Once the services are running, access the local endpoints:

| Service | URL | Description |
| :--- | :--- | :--- |
| **Frontend Web App** | [http://localhost:3000](http://localhost:3000) | Main application interface |
| **API Documentation** | [http://localhost:8000/docs](http://localhost:8000/docs) | Interactive Swagger/OpenAPI docs |
| **OpenAPI Schema** | [http://localhost:8000/openapi.json](http://localhost:8000/openapi.json) | Raw JSON OpenAPI specification |
| **Storage Console** | [http://localhost:9001](http://localhost:9001) | RustFS / S3 administrative dashboard |

#### Pre-Seeded Development Accounts

The development database is automatically seeded with two test accounts:

| Username | Password | Role / Purpose |
| :--- | :--- | :--- |
| `alex` | `Relay-demo-2026!` | Primary user for testing 1:1 and group chats |
| `jordan` | `Relay-demo-2026!` | Counterpart user for multi-session presence & live chat tests |

---

## Configuration Reference

All application parameters are consolidated in the root `.env` file and shared across Docker, backend, and frontend:

| Variable | Default | Description |
| :--- | :--- | :--- |
| `ENVIRONMENT` | `development` | Deployment environment (`development` or `production`) |
| `DATABASE_URL` | `postgresql+asyncpg://relay:relay@localhost:5432/relay` | Async SQLAlchemy database connection string |
| `REDIS_URL` | `redis://localhost:6379/0` | Redis instance connection URI |
| `FRONTEND_ORIGIN` | `http://localhost:3000` | Whitelisted frontend URL for CORS & CSRF checks |
| `NEXT_PUBLIC_API_URL` | `http://localhost:8000` | Base API URL accessible by the browser |
| `SECURE_COOKIES` | `false` | Set to `true` in production to enforce HTTPS-only cookies |
| `SESSION_DAYS` | `14` | Inactivity lifetime for authenticated user sessions |
| `S3_ENDPOINT` | `http://localhost:9000` | S3-compatible API endpoint |
| `S3_ACCESS_KEY` | `relay-local` | S3 storage access key |
| `S3_SECRET_KEY` | `relay-local-secret` | S3 storage secret key |
| `S3_BUCKET` | `relay-private` | Target bucket name for attachments |
| `MAX_UPLOAD_BYTES` | `10485760` | Maximum attachment file size in bytes (default: 10 MB) |
| `AI_API_KEY` | `""` | Google Gemini API key |
| `AI_BASE_URL` | `https://generativelanguage.googleapis.com/v1beta/openai` | OpenAI-compatible Gemini completion endpoint |
| `AI_MODEL` | `gemini-2.5-flash` | Model for streaming text completions |
| `AI_LIVE_MODEL` | `gemini-3.8-live` | Real-time voice model for Relay Live WebSocket sessions |
| `AI_VOICE_LANGUAGE` | `en-US` | Default voice language BCP-47 identifier |
| `AI_DAILY_LIMIT` | `50` | Maximum text generation prompts per user per day |
| `AI_LIVE_DAILY_MINUTES`| `60` | Maximum live voice minutes per user per day |
| `AI_LIVE_MAX_SESSION_MINUTES`| `30` | Maximum duration for an individual voice session |

---

## API & WebSocket Protocols

### REST API Summary

Full interactive documentation is available at `GET /docs`. All mutation endpoints require a valid session cookie and matching `X-CSRF-Token` header.

```text
Authentication & Profile
  POST   /auth/register                   Register new user account
  POST   /auth/login                      Authenticate user and establish session
  GET    /auth/me                         Get current user profile and CSRF token
  POST   /auth/logout                     Revoke current session
  DELETE /auth/sessions                   Revoke all active sessions across devices
  PATCH  /profile                         Update display name & presence privacy

Conversations & Members
  GET    /conversations                   List conversations with cursors & unread counts
  POST   /conversations                   Create direct, group, or private AI conversation
  PATCH  /conversations/{id}/preferences  Update pin and mute settings
  POST   /conversations/{id}/members      Add group members or update admin roles
  DELETE /conversations/{id}/members/{u}  Remove member or leave group
  POST   /conversations/{id}/owner        Transfer group ownership
  DELETE /conversations/{id}              Delete group, messages, and associated files

Messages & Search
  GET    /search?q={query}                Fuzzy search across authorized messages
  GET    /conversations/{id}/messages     Cursor-paginated message history
  POST   /conversations/{id}/messages     Idempotent message send (with client_id)
  PATCH  /messages/{id}                   Edit message content
  DELETE /messages/{id}                   Tombstone message deletion
  POST   /messages/{id}/reactions         Toggle emoji reaction
  POST   /conversations/{id}/receipts     Acknowledge delivered & read sequence cursors

Attachments
  POST   /conversations/{id}/attachments  Upload file attachment (multipart/form-data)
  GET    /attachments/{id}                Check attachment processing status
  GET    /attachments/{id}/download       Download verified file attachment
  GET    /conversations/{id}/attachments  List shared media and files in conversation

AI Operations
  POST   /conversations/{id}/ai/stream    Stream text completion (SSE over fetch)
  POST   /ai/generations/{id}/stop        Cancel ongoing text generation
  DELETE /conversations/{id}/ai/history   Clear AI conversation history
```

---

### Core WebSocket (`/ws`)

Provides bidirectional real-time state synchronization. Authenticated via session cookie and validated origin.

#### Server Event Envelope
```json
{
  "v": 1,
  "event_id": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  "type": "message.created",
  "conversation_id": "2d9e6f3b-638b-4a57-89df-8bfa8d8d34b2",
  "payload": {
    "id": "e4eaaaf2-d142-11e1-b3e4-080027620cdd",
    "seq": 142,
    "body": "Hey everyone, checking in!",
    "sender_id": "user-uuid",
    "created_at": "2026-11-19T15:00:00Z"
  }
}
```

#### Event Catalog
- `message.created`, `message.updated`, `message.deleted`: Real-time chat synchronizations.
- `reaction.updated`: Emoji reaction updates.
- `typing.updated`: Ephemeral typing status (`{user_id, name, expires_in: 5}`).
- `presence.updated`: Online/offline status changes respecting user privacy.
- `conversation.read`: Updated read sequence acknowledgements.
- `conversation.updated` / `conversation.removed`: Membership and room lifecycle events.

---

### Relay Live WebSocket (`/ai/live/{id}`)

Dedicated high-throughput binary/text WebSocket bridging the browser to Gemini Live.

- **Query Parameters**: `lang=en-US` (BCP-47 code) and `greet=1` (set `greet=0` when reconnecting to resume existing session without repeating greeting).
- **Client → Server Frames**:
  - **Binary**: Little-endian 16 kHz mono PCM16 audio packets.
  - **Text JSON**: `{"type": "mute"}`, `{"type": "close"}`, `{"type": "ping", "t": 1732028400}`.
- **Server → Client Frames**:
  - **Binary**: 24 kHz mono PCM16 synthesized voice audio chunks ready for immediate `AudioContext` playback.
  - **Text JSON**:
    - `ready`: Session connected (`{remaining_seconds, resumed}`).
    - `input_transcript` / `output_transcript`: Real-time speech-to-text and AI response tokens.
    - `interrupted`: Discard queued audio (user started speaking).
    - `turn_complete`: Assistant finished speaking current response.
    - `saved`: Exchange successfully committed to database history.

---

### AI Text Stream (`/conversations/{id}/ai/stream`)

Streams LLM text completions using Server-Sent Events (SSE) over an authenticated HTTP `POST` fetch request:

```text
event: start
data: {"generation_id": "gen_8f93b..."}

event: delta
data: {"text": "Relay"}

event: delta
data: {"text": " uses WebSockets for real-time..."}

event: done
data: {"tokens": 42}
```

---

## Testing & Quality Assurance

Relay includes comprehensive test suites across both backend and frontend layers:

### Backend Testing (Python / pytest)

Run the asynchronous test suite covering authentication, REST routes, WebSockets, S3 attachment pipelines, and AI adapters:

```bash
cd backend
uv run pytest -q
```

### Frontend Testing (TypeScript / Vitest / Playwright)

Run static type checks, unit/component tests, and End-to-End browser tests:

```bash
cd frontend

# Strict TypeScript verification
npm run typecheck

# Vitest unit & component tests
npm test

# Production build verification
npm run build

# Playwright E2E browser test suite
npm run test:e2e
```

### Automated Visual Demo Capture

To regenerate the documentation screenshots and WebM video demo directly from real running sessions:

```bash
cd frontend
npx playwright install chromium ffmpeg
node scripts/capture-demo.mjs
```

---

## Production Deployment

### Docker Multi-Stage Build

Build and run the unified production container (which builds the Next.js standalone assets, bundles the FastAPI backend, and serves static files through Nginx):

```bash
docker build -t relay:latest .
docker run -p 80:80 --env-file .env relay:latest
```

---

### One-Click Render Deployment

Relay includes a native `render.yaml` Blueprint definition for automated cloud deployment:

1. Push your code to GitHub.
2. In the [Render Dashboard](https://dashboard.render.com), select **New +** → **Blueprint**.
3. Select your repository.
4. Render will automatically provision:
   - **PostgreSQL database** (persistent relational store).
   - **Redis Key-Value instance** (real-time message bus & cache).
   - **Relay Web Service** (Docker container running FastAPI + Next.js).
5. Add your `AI_API_KEY` in the Render environment variables.

---

### Production Nginx & Proxy Guidelines

When configuring external load balancers (AWS ALB, Cloudflare, Traefik, or Nginx):

1. **WebSocket Forwarding**: Ensure `Upgrade` and `Connection: "Upgrade"` headers are forwarded for `/ws` and `/ai/live/*`.
2. **Buffering Disabled**: Disable response buffering (`proxy_buffering off;`) for `/conversations/*/ai/stream` to prevent buffering SSE text chunks.
3. **Timeouts**: Set WebSocket read/write timeouts to at least 60 seconds (exceeding the 20-second application ping interval).
4. **Header Trust**: Configure trusted proxy IP CIDRs so that `X-Forwarded-For` correctly registers client IPs for rate-limiting.

---

## Documentation Index

Deep dive into the specialized documentation in the [`docs/`](docs/) directory:

- 📐 [**Architecture Guide (`docs/ARCHITECTURE.md`)**](docs/ARCHITECTURE.md): In-depth system design, database schema patterns, idempotency models, and state reconciliation.
- 📡 [**API & WebSocket Specification (`docs/API.md`)**](docs/API.md): Exhaustive breakdown of HTTP status codes, request schemas, error envelopes, and WebSocket event payloads.
- 🚀 [**Deployment Guide (`docs/DEPLOYMENT.md`)**](docs/DEPLOYMENT.md): Detailed production topologies, CI/CD pipelines, security headers, and scaling recommendations.
- 📋 [**Feature Status & Limits (`docs/STATUS.md`)**](docs/STATUS.md): Current implementation matrix, design choices, and operational boundaries.
- ✅ [**Verification Log (`docs/VERIFICATION.md`)**](docs/VERIFICATION.md): Audit record of test runs, browser matrices, and stress tests.

---

## Feature Status & Limitations

Relay is deliberately engineered with explicit security boundaries and focus:

| Area | Status / Behavior |
| :--- | :--- |
| **End-to-End Encryption (E2EE)** | **Not E2EE by design**: Relay uses transport-layer encryption (TLS 1.3). The server requires message access for database search (`pg_trgm`) and contextual AI features. |
| **Voice & Video Calls** | Person-to-person WebRTC calling is not included in the current release; Relay's voice engine is dedicated to **Relay Live** AI conversation. |
| **Push Notifications** | Background desktop notifications and audio chimes are supported in open browser tabs. Native mobile push (APNs/FCM) requires external push service integration. |
| **Malware Scanning** | File attachments validate MIME types, extensions, magic signatures, and image pixel dimensions; production deployments should attach an antivirus sidecar (e.g., ClamAV) for enterprise file scanning. |

---

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.
