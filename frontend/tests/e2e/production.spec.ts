import { test, expect, type Page } from "@playwright/test";

async function login(page: Page, name: string) {
  await page.goto("/");
  await page.getByLabel("Username", { exact: true }).fill(name);
  await page.getByLabel("Password", { exact: true }).fill("Relay-demo-2026!");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Messages" })).toBeVisible();
}

async function openChat(page: Page, title: string) {
  await page.locator(".conversation-row").filter({ hasText: title }).first().click();
}

async function send(page: Page, text: string) {
  await page.getByRole("textbox", { name: "Message", exact: true }).fill(text);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
}

test("search finds a message in any conversation and jumps to it", async ({ browser }) => {
  const a = await (await browser.newContext()).newPage();
  await login(a, "alex");
  await openChat(a, "Jordan Lee");
  const needle = "zebra-" + Date.now();
  await send(a, `Remember the ${needle} plan`);
  await expect(a.locator(".message-body").filter({ hasText: needle })).toBeVisible();

  await a.getByLabel("Search conversations and messages").fill(needle);
  const hit = a.locator(".search-hit").filter({ hasText: needle });
  await expect(hit).toBeVisible();
  await expect(hit.locator("mark")).toHaveText(needle);
  await hit.click();
  const target = a.locator("[id^=message-]").filter({ hasText: needle });
  await expect(target).toBeInViewport();

  await a.getByLabel("Search conversations and messages").fill("no-such-text-" + Date.now());
  await expect(a.getByText(/No messages contain/)).toBeVisible();
});

test("an unsent message survives a reload and is delivered when back online", async ({ browser }) => {
  const alice = await browser.newContext();
  const a = await alice.newPage();
  const b = await (await browser.newContext()).newPage();
  await login(a, "alex");
  await login(b, "jordan");
  await openChat(a, "Jordan Lee");
  await openChat(b, "Alex Morgan");

  await alice.setOffline(true);
  const text = "Queued while offline " + Date.now();
  await send(a, text);
  await expect(a.locator("article").filter({ hasText: text }).getByRole("button", { name: "Retry" })).toBeVisible();

  await alice.setOffline(false);
  await a.reload();
  await openChat(a, "Jordan Lee");
  // Restored from the outbox and resent automatically on load.
  await expect(b.locator(".message-body").filter({ hasText: text })).toBeVisible({ timeout: 20000 });
  await expect(a.locator("article").filter({ hasText: text }).getByRole("button", { name: "Retry" })).toHaveCount(0);
  // Exactly one copy despite the retry (idempotent on client_id).
  await expect(b.locator(".message-body").filter({ hasText: text })).toHaveCount(1);
});

test("a discarded unsent message is gone after reload", async ({ browser }) => {
  const alice = await browser.newContext();
  const a = await alice.newPage();
  await login(a, "alex");
  await openChat(a, "Jordan Lee");
  await alice.setOffline(true);
  const text = "Never mind " + Date.now();
  await send(a, text);
  const row = a.locator("article").filter({ hasText: text });
  await row.getByRole("button", { name: "Discard unsent message" }).click();
  await expect(row).toHaveCount(0);
  await alice.setOffline(false);
  await a.reload();
  await openChat(a, "Jordan Lee");
  await expect(a.locator(".message-body").filter({ hasText: text })).toHaveCount(0);
});

test("group owner transfers ownership, leaves, and the new owner deletes the group", async ({ browser }) => {
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  await login(a, "alex");
  await login(b, "jordan");

  const group = "Launch crew " + Date.now();
  await a.getByRole("button", { name: "New conversation", exact: true }).first().click();
  await a.getByRole("button", { name: "New group", exact: true }).click();
  await a.getByLabel("Group name").fill(group);
  await a.getByLabel("Search people").fill("jordan");
  await a.getByRole("button").filter({ hasText: "@jordan" }).click();
  await a.getByRole("button", { name: "Create group", exact: true }).click();
  await expect(a.getByRole("heading", { name: group, exact: true })).toBeVisible();

  // Transfer ownership to Jordan.
  await a.getByRole("button", { name: "Conversation details" }).click();
  await a.getByRole("button", { name: "Make Jordan Lee the owner" }).click();
  await a.getByRole("button", { name: "Transfer ownership", exact: true }).click();
  await expect(a.locator(".member-list")).toContainText("@jordan · owner");
  await expect(a.locator(".member-list")).toContainText("@alex · admin");
  await expect(a.getByRole("button", { name: "Delete group" })).toHaveCount(0);

  // Alex leaves; the group disappears from Alex's list but stays for Jordan.
  await a.getByRole("button", { name: "Leave group" }).click();
  await a.getByRole("button", { name: "Leave group", exact: true }).last().click();
  await expect(a.locator(".conversation-row").filter({ hasText: group })).toHaveCount(0);
  await expect(b.locator(".conversation-row").filter({ hasText: group })).toHaveCount(1);

  // Jordan (now owner) deletes the group.
  await openChat(b, group);
  await b.getByRole("button", { name: "Conversation details" }).click();
  await b.getByRole("button", { name: "Delete group" }).click();
  await b.getByRole("button", { name: "Delete group", exact: true }).last().click();
  await expect(b.locator(".conversation-row").filter({ hasText: group })).toHaveCount(0);
});

test("notification and sound settings persist", async ({ browser }) => {
  const context = await browser.newContext();
  await context.grantPermissions(["notifications"], { origin: "http://localhost:3000" });
  const a = await context.newPage();
  await login(a, "alex");
  await a.getByRole("button", { name: "Account settings" }).click();
  const desktop = a.getByRole("checkbox", { name: /Desktop notifications/ });
  const sound = a.getByRole("checkbox", { name: /Message sound/ });
  await expect(sound).toBeChecked();
  await desktop.check();
  await sound.uncheck();
  await a.reload();
  await a.getByRole("button", { name: "Account settings" }).click();
  await expect(a.getByRole("checkbox", { name: /Desktop notifications/ })).toBeChecked();
  await expect(a.getByRole("checkbox", { name: /Message sound/ })).not.toBeChecked();
});
