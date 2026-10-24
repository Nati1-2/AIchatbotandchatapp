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
