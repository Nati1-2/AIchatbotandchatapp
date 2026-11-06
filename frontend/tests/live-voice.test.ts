import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  VOICE_LANGUAGES,
  browserSpeechLang,
  getVoiceLanguage,
  isVoiceLanguage,
  setVoiceLanguage,
} from "../lib/languages";
import { pcm16 } from "../lib/live-voice";
import { detectDevice, microphoneHelpSteps } from "../lib/voice";

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

describe("voice language", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { localStorage: memoryStorage() });
  });

  it("defaults to English instead of guessing from the browser locale", () => {
    expect(getVoiceLanguage()).toBe("en-US");
  });

  it("remembers a chosen language and ignores unknown stored values", () => {
    setVoiceLanguage("fr-FR");
    expect(getVoiceLanguage()).toBe("fr-FR");
    window.localStorage.setItem("relay_voice_language", "xx-<script>");
    expect(getVoiceLanguage()).toBe("en-US");
  });

  it("validates codes and maps browser speech tags", () => {
    expect(isVoiceLanguage("en-GB")).toBe(true);
    expect(isVoiceLanguage("am-ET")).toBe(false);
    expect(browserSpeechLang("cmn-CN")).toBe("zh-CN");
    expect(browserSpeechLang("en-US")).toBe("en-US");
    expect(new Set(VOICE_LANGUAGES.map((l) => l.code)).size).toBe(VOICE_LANGUAGES.length);
  });
});

describe("pcm16", () => {
  it("downsamples 48 kHz float audio to 16 kHz 16-bit PCM", () => {
    const input = new Float32Array(960).fill(0.5); // 20 ms at 48 kHz
    const out = new Int16Array(pcm16(input, 48000));
    expect(out.length).toBe(320); // 20 ms at 16 kHz
    expect(out[0]).toBe(Math.trunc(0.5 * 0x7fff));
  });

  it("clips out-of-range samples", () => {
    const out = new Int16Array(pcm16(new Float32Array([2, -2, 2, -2, 2, -2]), 16000));
    expect(out[0]).toBe(0x7fff);
    expect(out[1]).toBe(-0x8000);
  });
});

describe("device-aware microphone help", () => {
  it("detects iPhone Safari and gives Safari steps", () => {
    vi.stubGlobal("navigator", {
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      maxTouchPoints: 5,
    });
    const device = detectDevice();
    expect(device).toMatchObject({ os: "ios", browser: "safari", mobile: true });
    expect(microphoneHelpSteps(device).join(" ")).toMatch(/Website Settings/);
  });

  it("detects desktop Firefox on Linux", () => {
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0",
      maxTouchPoints: 0,
    });
    const device = detectDevice();
    expect(device).toMatchObject({ os: "linux", browser: "firefox", mobile: false });
    expect(microphoneHelpSteps(device).join(" ")).toMatch(/crossed-out microphone/);
  });
});
