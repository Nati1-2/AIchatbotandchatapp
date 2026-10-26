import { describe, it, expect } from "vitest";
import { speakable, sentences } from "../lib/voice";
describe("speakable", () => {
  it("reads Markdown as plain prose", () => {
    expect(
      speakable(
        "## Plan\n- **Bold** step with `code`\n> quoted [link](https://x.y)",
      ),
    ).toBe("Plan Bold step with code quoted link");
  });
  it("skips code blocks instead of reading them", () => {
    expect(speakable("Run this:\n```sh\nnpm ci\n```\nDone.")).toBe(
      "Run this: (code block) Done.",
    );
  });
});
describe("sentences", () => {
  it("keeps each piece short enough for speech engines", () => {
    expect(sentences("One. Two! Three?")).toEqual(["One.", "Two!", "Three?"]);
    expect(sentences("a".repeat(500))).toHaveLength(1);
  });
});
