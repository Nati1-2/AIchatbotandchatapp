import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const shots = path.join(root, "docs/screenshots");
const demos = path.join(root, "docs/demo");
const frames = "/tmp/relay-demo-frames";
const baseURL = "http://localhost:3000";
await mkdir(shots, { recursive: true });
await mkdir(demos, { recursive: true });
await rm(frames, { recursive: true, force: true });
await mkdir(frames, { recursive: true });
let frame = 0;
async function capture(page, seconds) {
  for (let i = 0; i < seconds * 5; i++) {
    await page.screenshot({
      path: path.join(frames, `frame-${String(frame++).padStart(4, "0")}.jpg`),
      type: "jpeg",
      quality: 78,
    });
    await page.waitForTimeout(200);
  }
}

const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_PATH
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
    : {}),
});

async function login(username) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(baseURL);
  await page.getByRole("button", { name: username, exact: true }).click();
  await page.getByRole("heading", { name: /Messages/ }).waitFor();
  return { context, page };
}

const landingContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const landing = await landingContext.newPage();
await landing.goto(baseURL);
await landing.getByRole("heading", { name: "Welcome back." }).waitFor();
await landing.screenshot({ path: path.join(shots, "welcome.png") });
await landingContext.close();

const alexLogin = await login("Alex");
const jordan = await login("Jordan");
const alexState = await alexLogin.context.storageState();
await alexLogin.context.close();

const alexContext = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  storageState: alexState,
});
const alex = await alexContext.newPage();
await alex.goto(baseURL);
await alex.getByRole("heading", { name: /Messages/ }).waitFor();

await alex.locator(".conversation-row").filter({ hasText: "Relay AI" }).first().click();
await alex.getByPlaceholder("Ask Relay AI").waitFor();
await alex.screenshot({ path: path.join(shots, "ai-chat.png") });
await capture(alex, 2);

await alex.getByRole("button", { name: "Start voice conversation" }).click();
await alex.getByRole("dialog", { name: "Voice conversation with Relay AI" }).waitFor();
await alex.getByText("Hi, I’m Relay. What would you like to talk about?").waitFor();
await alex.waitForTimeout(1200);
await alex.screenshot({ path: path.join(shots, "ai-voice-live.png") });
await capture(alex, 4);
const endVoice = alex.getByRole("button", { name: "End voice conversation" });
if (await endVoice.isVisible()) await endVoice.click();

await alex.getByRole("button", { name: /Jordan Lee/ }).click();
await jordan.page.getByRole("button", { name: /Alex Morgan/ }).click();
await alex.getByPlaceholder("Message").waitFor();
await jordan.page.getByPlaceholder("Message").waitFor();

await alex.getByPlaceholder("Message").fill("The Relay Live demo is ready. Can you review the final flow?");
await alex.getByRole("button", { name: "Send message" }).click();
await jordan.page.getByText("The Relay Live demo is ready. Can you review the final flow?").last().waitFor();
await jordan.page.getByPlaceholder("Message").fill("Absolutely — the voice experience looks polished and clear.");
await jordan.page.getByRole("button", { name: "Send message" }).click();
await alex.getByText("Absolutely — the voice experience looks polished and clear.").last().waitFor();
await alex.waitForTimeout(5500);
await alex.screenshot({ path: path.join(shots, "messaging.png") });
await capture(alex, 4);

await jordan.context.close();
await alexContext.close();
await browser.close();

const ffmpeg = process.env.PLAYWRIGHT_FFMPEG_PATH || "ffmpeg";
const encoder = spawn(ffmpeg, [
  "-y", "-f", "image2pipe", "-vcodec", "mjpeg", "-framerate", "5", "-i", "pipe:0",
  "-c:v", "libvpx", "-pix_fmt", "yuv420p", "-crf", "18", "-b:v", "1M",
  path.join(demos, "relay-demo.webm"),
]);
let encoderError = "";
encoder.stderr.on("data", (chunk) => (encoderError += chunk));
const encoded = new Promise((resolve, reject) => {
  encoder.on("error", reject);
  encoder.on("close", (code) =>
    code === 0 ? resolve() : reject(new Error(encoderError)),
  );
});
for (const name of (await readdir(frames)).sort())
  encoder.stdin.write(await readFile(path.join(frames, name)));
encoder.stdin.end();
await encoded;
await rm(frames, { recursive: true, force: true });

console.log("Captured Relay screenshots and demo video.");
