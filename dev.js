#!/usr/bin/env node
/**
 * Starts Relay backend (FastAPI) and frontend (Next.js) concurrently in one terminal.
 * Cross-platform (Windows, macOS, Linux).
 */
const { spawn } = require("child_process");
const path = require("path");

const ROOT = __dirname;
const BACKEND_DIR = path.join(ROOT, "backend");
const FRONTEND_DIR = path.join(ROOT, "frontend");

const isWin = process.platform === "win32";
const npmCmd = isWin ? "npm.cmd" : "npm";
const uvCmd = isWin ? "uv.exe" : "uv";

console.log("\x1b[36m%s\x1b[0m", "=== Starting Relay (Backend + Frontend) in one terminal ===");

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
  } else {
    backend.kill("SIGINT");
    frontend.kill("SIGINT");
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
