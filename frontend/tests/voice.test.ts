import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  speakable,
  sentences,
  checkVoicePermissions,
  requestMandatoryPermissions,
  isSpeechRecognitionSupported,
} from "../lib/voice";

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

describe("mandatory voice permissions", () => {
  const originalNavigator = global.navigator;

  afterEach(() => {
    Object.defineProperty(global, "navigator", {
      value: originalNavigator,
      configurable: true,
      writable: true,
    });
  });

  it("identifies unsupported environments gracefully", async () => {
    Object.defineProperty(global, "navigator", {
      value: {},
      configurable: true,
      writable: true,
    });
    const perm = await checkVoicePermissions();
    expect(perm.allGranted).toBe(false);
    expect(perm.microphone).toBe("unsupported");

    const req = await requestMandatoryPermissions();
    expect(req.success).toBe(false);
    expect(req.code).toBe("unsupported");
  });

  it("returns not-allowed code when user denies microphone permission", async () => {
    const mockGetUserMedia = vi.fn().mockRejectedValue(
      Object.assign(new Error("Permission denied"), { name: "NotAllowedError" }),
    );

    Object.defineProperty(global, "navigator", {
      value: {
        mediaDevices: { getUserMedia: mockGetUserMedia },
      },
      configurable: true,
      writable: true,
    });

    const res = await requestMandatoryPermissions();
    expect(res.success).toBe(false);
    expect(res.code).toBe("not-allowed");
    expect(mockGetUserMedia).toHaveBeenCalledWith({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  });

  it("successfully grants permissions and cleans up test tracks", async () => {
    const stopMock = vi.fn();
    const mockStream = {
      getTracks: () => [{ stop: stopMock }],
    };
    const mockGetUserMedia = vi.fn().mockResolvedValue(mockStream);

    Object.defineProperty(global, "navigator", {
      value: {
        mediaDevices: { getUserMedia: mockGetUserMedia },
      },
      configurable: true,
      writable: true,
    });

    const res = await requestMandatoryPermissions();
    expect(res.success).toBe(true);
    expect(stopMock).toHaveBeenCalled();
  });
});
