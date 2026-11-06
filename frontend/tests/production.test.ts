import { describe, it, expect, beforeEach, vi } from "vitest";
import { loadOutbox, saveOutbox } from "../lib/messages";
import { getNotifyPrefs, setNotifyPrefs } from "../lib/notify";
import type { Message } from "../lib/types";

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    keys: () => [...data.keys()],
  };
}

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: crypto.randomUUID(),
    seq: Number.MAX_SAFE_INTEGER,
    client_id: crypto.randomUUID(),
    conversation_id: "c1",
    sender_id: "u1",
    sender_name: "Alex",
    body: "hello",
    reply_id: null,
    created_at: new Date().toISOString(),
    edited: false,
    deleted: false,
    reactions: [],
    attachments: [],
    ...overrides,
  };
}

let storage: ReturnType<typeof memoryStorage>;
beforeEach(() => {
  storage = memoryStorage();
  vi.stubGlobal("window", { localStorage: storage });
});

describe("outbox", () => {
  it("keeps unsent messages across reloads and marks them for retry", () => {
    const pending = message({ status: "pending", body: "sent while offline" });
    saveOutbox("u1", "c1", [pending, message()]);
    const restored = loadOutbox("u1", "c1");
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ client_id: pending.client_id, body: "sent while offline", status: "failed" });
  });

  it("is scoped per user and conversation", () => {
    saveOutbox("u1", "c1", [message({ status: "failed" })]);
    expect(loadOutbox("u2", "c1")).toEqual([]);
    expect(loadOutbox("u1", "c2")).toEqual([]);
  });

  it("clears storage once everything is sent", () => {
    saveOutbox("u1", "c1", [message({ status: "failed" })]);
    saveOutbox("u1", "c1", []);
    expect(storage.keys()).toEqual([]);
  });

  it("ignores corrupted storage", () => {
    storage.setItem("relay_outbox:u1:c1", "{not json");
    expect(loadOutbox("u1", "c1")).toEqual([]);
    storage.setItem("relay_outbox:u1:c1", JSON.stringify([{ nope: 1 }, "x"]));
    expect(loadOutbox("u1", "c1")).toEqual([]);
  });

  it("caps the outbox size", () => {
    saveOutbox("u1", "c1", Array.from({ length: 80 }, (_, i) => message({ status: "failed", body: String(i) })));
    const restored = loadOutbox("u1", "c1");
    expect(restored).toHaveLength(50);
    expect(restored.at(-1)?.body).toBe("79");
  });
});

describe("notification preferences", () => {
  it("defaults to sound on and desktop off until permission is granted", () => {
    expect(getNotifyPrefs()).toEqual({ desktop: false, sound: true });
  });

  it("persists changes", () => {
    setNotifyPrefs({ desktop: true, sound: false });
    expect(getNotifyPrefs()).toEqual({ desktop: true, sound: false });
  });
});
