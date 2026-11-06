#!/usr/bin/env node
/**
 * Starts Relay backend (FastAPI) and frontend (Next.js) concurrently in one terminal.
 * Cross-platform (Windows, macOS, Linux).
 */
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const BACKEND_DIR = path.join(ROOT, "backend");
const FRONTEND_DIR = path.join(ROOT, "frontend");
const ENV_FILE = path.join(ROOT, ".env");

const isWin = process.platform === "win32";
const npmCmd = isWin ? "npm.cmd" : "npm";
const uvCmd = isWin ? "uv.exe" : "uv";

console.log("\x1b[36m%s\x1b[0m", "=== Starting Relay (Backend + Frontend) in one terminal ===");

if (!fs.existsSync(ENV_FILE)) {
  fs.copyFileSync(path.join(ROOT, ".env.example"), ENV_FILE);
  console.log(`Created ${ENV_FILE}. Add AI_API_KEY there to enable real AI.`);
}

function ok(command, args, opts = {}) {
  const result = spawnSync(command, args, { stdio: "ignore", shell: isWin, ...opts });
  return result.status === 0;
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Start Docker if needed and bring up Postgres, Redis and object storage. */
function startInfra() {
  if (!ok("docker", ["--version"])) {
    console.warn(
      "\x1b[31m%s\x1b[0m",
      "Docker is not installed, so the database cannot start and sign-in will fail.\n" +
        "Install Docker, or run `npm run dev:lite` for a temporary database without Docker.",
    );
    return false;
  }
  if (!ok("docker", ["info"])) {
    console.log("Starting Docker…");
    const linuxDesktop = "/opt/docker-desktop/bin/docker-desktop";
    if (process.platform === "darwin") spawn("open", ["-a", "Docker"], { detached: true, stdio: "ignore" }).unref();
    else if (isWin) spawn("cmd", ["/c", "start", "", "Docker Desktop"], { detached: true, stdio: "ignore" }).unref();
    else if (fs.existsSync(linuxDesktop)) spawn(linuxDesktop, [], { detached: true, stdio: "ignore" }).unref();
    for (let i = 0; i < 60 && !ok("docker", ["info"]); i++) sleep(2000);
    if (!ok("docker", ["info"])) {
      console.warn("\x1b[31m%s\x1b[0m", "Docker did not become ready. Start Docker, then run npm run dev again.");
      return false;
    }
  }
  // Publish Postgres on the port .env points at (e.g. 5433 when a system Postgres owns 5432).
  const env = fs.readFileSync(ENV_FILE, "utf8");
  const pgPort = (env.match(/^DATABASE_URL=.*@[^:/\s]+:(\d+)/m) || [])[1] || "5432";
  console.log("Starting database, Redis and storage…");
  const up = spawnSync(
    "docker",
    ["compose", "--env-file", ENV_FILE, "-f", path.join(ROOT, "infra", "compose.yaml"), "up", "-d", "--wait", "postgres", "redis", "storage"],
    { stdio: "inherit", shell: isWin, env: { ...process.env, POSTGRES_PORT: pgPort } },
  );
  if (up.status !== 0) return false;
  spawnSync(uvCmd, ["run", "alembic", "upgrade", "head"], { cwd: BACKEND_DIR, stdio: "inherit", shell: isWin });
  spawnSync(uvCmd, ["run", "python", "-m", "app.storage_init"], { cwd: BACKEND_DIR, stdio: "inherit", shell: isWin });
  return true;
}

const infraReady = startInfra();

function runProcess(name, color, command, args, cwd) {
  const proc = spawn(command, args, {
    cwd,
    stdio: ["inherit", "pipe", "pipe"],
    shell: isWin,
  });

  const prefix = `\x1b[${color}m[${name}]\x1b[0m `;

  proc.stdout.on("data", (data) => {
    process.stdout.write(prefix + data.toString().replace(/\n(?!$)/g, "\n" + prefix));
  });

  proc.stderr.on("data", (data) => {
    process.stderr.write(prefix + data.toString().replace(/\n(?!$)/g, "\n" + prefix));
  });

  proc.on("error", (err) => {
    console.error(`\x1b[31m[${name}] Failed to start: ${err.message}\x1b[0m`);
  });

  return proc;
}

// 1. Start FastAPI backend with uv
const backend = runProcess(
  "backend",
  "34", // blue
  uvCmd,
  ["run", "uvicorn", "app.main:app", "--reload", "--host", "127.0.0.1", "--port", "8000"],
  BACKEND_DIR
);

// Attachment processing worker (needs the database and storage).
const worker = infraReady
  ? runProcess("worker", "35", uvCmd, ["run", "python", "-m", "app.worker"], BACKEND_DIR)
  : null;

// 2. Start Next.js frontend with npm
const frontend = runProcess(
  "frontend",
  "32", // green
  npmCmd,
  ["run", "dev"],
  FRONTEND_DIR
);

console.log("\x1b[33m%s\x1b[0m", "Frontend: http://localhost:3000");
console.log("\x1b[33m%s\x1b[0m", "Backend:  http://localhost:8000/docs");
console.log("\x1b[90m%s\x1b[0m", "Press Ctrl+C to stop both services.\n");

function shutdown() {
  console.log("\n\x1b[33mStopping Relay services...\x1b[0m");
  if (isWin) {
    if (backend.pid) spawn("taskkill", ["/pid", backend.pid, "/f", "/t"]);
    if (frontend.pid) spawn("taskkill", ["/pid", frontend.pid, "/f", "/t"]);
    if (worker?.pid) spawn("taskkill", ["/pid", worker.pid, "/f", "/t"]);
  } else {
    backend.kill("SIGINT");
    frontend.kill("SIGINT");
    worker?.kill("SIGINT");
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

