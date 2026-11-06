import type { Message } from "./types";
export function mergeMessages(...pages: Message[][]): Message[] {
  const map = new Map<string, Message>();
  for (const message of pages.flat()) {
    const key = message.sender_id + ":" + message.client_id;
    const old = map.get(key);
    if (!old || !message.status || old.status) map.set(key, message);
  }
  return [...map.values()].sort(
    (a, b) =>
      (a.status ? Number.MAX_SAFE_INTEGER : a.seq) -
        (b.status ? Number.MAX_SAFE_INTEGER : b.seq) ||
      a.created_at.localeCompare(b.created_at),
  );
}
export function reconnectDelay(attempt: number, random = Math.random) {
  return Math.min(30000, 1000 * 2 ** attempt) * (0.75 + random() * 0.5);
}

/* Outbox: unsent messages survive a reload and are retried (sends are
 * idempotent on client_id, so a retry of a message that actually arrived just
 * returns the stored copy). Only text and already-uploaded attachments. */
const OUTBOX_PREFIX = "relay_outbox:";
const OUTBOX_MAX = 50;

function outboxKey(userId: string, conversationId: string) {
  return `${OUTBOX_PREFIX}${userId}:${conversationId}`;
}

export function loadOutbox(userId: string, conversationId: string): Message[] {
  try {
    const raw = JSON.parse(window.localStorage.getItem(outboxKey(userId, conversationId)) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((m) => m && typeof m.client_id === "string" && typeof m.body === "string")
      .map((m) => ({ ...m, status: "failed" as const }));
  } catch {
    return [];
  }
}

export function saveOutbox(userId: string, conversationId: string, messages: Message[]) {
  try {
    const key = outboxKey(userId, conversationId);
    const unsent = messages.filter((m) => m.status).slice(-OUTBOX_MAX);
    if (unsent.length) window.localStorage.setItem(key, JSON.stringify(unsent));
    else window.localStorage.removeItem(key);
  } catch {}
}
