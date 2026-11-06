import { describe, it, expect } from "vitest";
import { mergeMessages, reconnectDelay } from "../lib/messages";
import type { Message } from "../lib/types";
const message = (
  seq: number,
  client_id: string,
  status?: "pending" | "failed",
) =>
  ({
    id: client_id,
    seq,
    client_id,
    sender_id: "alice",
    created_at: "2026-01-01T00:00:00Z",
    status,
  }) as Message;
describe("message reconciliation", () => {
  it("replaces an optimistic send with its durable echo without duplicates", () => {
    const result = mergeMessages(
      [message(99, "a", "pending")],
      [message(4, "a")],
    );
    expect(result).toHaveLength(1);
    expect(result[0].status).toBeUndefined();
  });
  it("keeps chronological ordering across reversed history pages and duplicate events", () => {
    expect(
      mergeMessages(
        [message(9, "c"), message(7, "b")],
        [message(2, "a"), message(7, "b")],
      ).map((x) => x.seq),
    ).toEqual([2, 7, 9]);
  });
  it("keeps failed sends available for retry", () => {
    expect(
      mergeMessages([message(0, "b", "failed")], [message(4, "a")]).at(-1)
        ?.status,
    ).toBe("failed");
  });
  it("bounds backoff and includes jitter", () => {
    expect(reconnectDelay(0, () => 0)).toBe(750);
    expect(reconnectDelay(20, () => 1)).toBe(37500);
  });
});
