import { test, expect, type Page } from "@playwright/test";
async function login(page: Page, name: string) {
  await page.goto("/");
  await page.getByLabel("Username", { exact: true }).fill(name);
  await page.getByLabel("Password", { exact: true }).fill("Relay-demo-2026!");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Messages" })).toBeVisible();
}
test("two users exchange messages, reconnect, create a group, upload, and use test AI", async ({
  browser,
}) => {
  const alice = await browser.newContext();
  const bob = await browser.newContext();
  const a = await alice.newPage();
  const b = await bob.newPage();
  await a.goto("/");
  await expect(a.getByLabel("Username", { exact: true })).toBeVisible();
  await a.screenshot({ path: "test-results/relay-login.png", fullPage: true });
  await login(a, "alex");
  await login(b, "jordan");
  await a.getByRole("button").filter({ hasText: "Jordan Lee" }).first().click();
  await b
    .getByRole("button")
    .filter({ hasText: "Alex Morgan" })
    .first()
    .click();
  const message = "Browser message " + Date.now();
  await a.getByRole("textbox", { name: "Message", exact: true }).fill(message);
  await a.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(b.getByText(message, { exact: true })).toBeVisible();
  const ownMessage = a.locator("article").filter({ hasText: message });
  await ownMessage.hover();
  await ownMessage
    .getByRole("button", { name: "React to message", exact: true })
    .click();
  await a.getByRole("button", { name: "React 🎉", exact: true }).click();
  await expect(
    b.locator("article").filter({ hasText: message }).locator(".reactions"),
  ).toContainText("🎉");
  await ownMessage.hover();
  await ownMessage
    .getByRole("button", { name: "Edit message", exact: true })
    .click();
  await a
    .getByRole("textbox", { name: "Message", exact: true })
    .fill(message + " edited");
  await a.getByRole("button", { name: "Save edit", exact: true }).click();
  await expect(b.getByText(message + " edited", { exact: true })).toBeVisible();
  await bob.setOffline(true);
  const missed = "While offline " + Date.now();
  await a.getByRole("textbox", { name: "Message", exact: true }).fill(missed);
  await a.getByRole("button", { name: "Send message", exact: true }).click();
  await bob.setOffline(false);
  await b.reload();
  await b
    .getByRole("button")
    .filter({ hasText: "Alex Morgan" })
    .first()
    .click();
  // Scope to message bodies: the sidebar preview shows the same text.
  await expect(b.locator(".message-body").filter({ hasText: missed })).toBeVisible();
  await a.getByRole("button", { name: "Attach a file", exact: true }).click();
  await a.locator("input[type=file]").setInputFiles({
    name: "hello.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("A private Relay attachment"),
  });
  await expect(a.getByText("Ready to send", { exact: true })).toBeVisible({
    timeout: 15000,
  });
  await a.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(
    b.getByRole("link").filter({ hasText: "hello.txt" }).last(),
  ).toBeVisible();
  await a.screenshot({
    path: "test-results/relay-messaging.png",
    fullPage: true,
  });
  await a
    .getByRole("button", { name: "New conversation", exact: true })
    .click();
  await a.getByRole("button", { name: "New group", exact: true }).click();
  const group = "Browser team " + Date.now();
  await a.getByLabel("Group name").fill(group);
  await a.getByLabel("Search people").fill("jordan");
  await a.getByRole("button").filter({ hasText: "@jordan" }).click();
  await a.getByRole("button", { name: "Create group", exact: true }).click();
  await expect(
    a.getByRole("heading", { name: group, exact: true }),
  ).toBeVisible();
  await a
    .getByRole("button")
    .filter({ hasText: "A little help, a conversation away" })
    .click();
  await expect(a.locator(".chat-heading h2")).toContainText("Relay AI");
  await a
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Hello from browser test");
  await a.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(
    a.locator(".markdown").filter({ hasText: "mocked provider" }).last(),
  ).toBeVisible();
  await expect(
    a.getByRole("button", { name: "Stop generation" }),
  ).not.toBeVisible();
  await a.reload();
  await a.locator(".conversation-row").filter({ hasText: "Relay AI" }).click();
  await expect(
    a.locator(".markdown").filter({ hasText: "mocked provider" }).last(),
  ).toBeVisible();
  await a.screenshot({
    path: "test-results/relay-desktop.png",
    fullPage: true,
  });
  await a.setViewportSize({ width: 390, height: 844 });
  await expect(
    a.getByRole("button", { name: "Back to conversations" }),
  ).toBeVisible();
  expect(
    await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await a.screenshot({ path: "test-results/relay-mobile.png", fullPage: true });
  const privateAI = await a.evaluate(async () => {
    const response = await fetch("http://localhost:8000/conversations", {
      credentials: "include",
    });
    return (await response.json()).find(
      (c: { kind: string }) => c.kind === "ai",
    ).id as string;
  });
  const denied = await b.evaluate(
    (cid) =>
      new Promise<number>((resolve, reject) => {
        const ws = new WebSocket("ws://localhost:8000/ws");
        const timer = setTimeout(() => {
          ws.close();
          reject(new Error("No WebSocket authorization response"));
        }, 5000);
        ws.onopen = () =>
          ws.send(
            JSON.stringify({
              v: 1,
              type: "typing.updated",
              conversation_id: cid,
              request_id: "test-denied",
            }),
          );
        ws.onmessage = (e) => {
          const event = JSON.parse(e.data);
          if (event.type === "error") {
            clearTimeout(timer);
            ws.close();
            resolve(event.payload.code);
          }
        };
      }),
    privateAI,
  );
  expect(denied).toBe(403);
  await alice.close();
  await bob.close();
});
