# ------------------------------------------------------------
# Stage 1: Build Next.js frontend
# ------------------------------------------------------------
FROM node:24-alpine AS frontend-builder
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./
RUN npm install
COPY frontend/ ./
ENV NEXT_PUBLIC_API_URL="" NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ------------------------------------------------------------
# Stage 2: All-in-One Container (Python + Node.js + Nginx)
# ------------------------------------------------------------
FROM python:3.12-slim

# Install Nginx and curl via Debian packages
RUN apt-get update && apt-get install -y --no-install-recommends \
    nginx \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy uv for python package management
COPY --from=ghcr.io/astral-sh/uv:0.13.5 /uv /usr/local/bin/uv

# Copy Node.js from official node image
COPY --from=node:24-slim /usr/local /usr/local

WORKDIR /app

# Install backend dependencies
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --no-dev

# Copy backend application, migrations, and config
COPY backend/app ./app
COPY backend/migrations ./migrations
COPY backend/alembic.ini ./

# Copy frontend standalone distribution
COPY --from=frontend-builder /app/.next/standalone ./frontend-dist
COPY --from=frontend-builder /app/.next/static ./frontend-dist/.next/static
COPY --from=frontend-builder /app/public ./frontend-dist/public

# Copy Nginx configuration and entrypoint script
COPY nginx.conf /etc/nginx/nginx.conf
COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

ENV PATH="/app/.venv/bin:$PATH" PYTHONUNBUFFERED=1 NODE_ENV=production ENVIRONMENT=production SECURE_COOKIES=true

EXPOSE 10000

CMD ["./entrypoint.sh"]
