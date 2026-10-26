"use client";
import { useEffect, useRef, useState } from "react";

// Minimal typing for the Web Speech API's recognizer (prefixed in Chromium/Safari).
type Recognizer = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult:
    | ((e: {
        resultIndex: number;
        results: ArrayLike<{ isFinal: boolean } & ArrayLike<{ transcript: string }>>;
      }) => void)
    | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
};
type RecognizerCtor = new () => Recognizer;

function recognizerCtor(): RecognizerCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as Record<string, RecognizerCtor | undefined>;
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

/** Speech to text. `onResult` gets the running transcript; `onEnd` gets the final one ("" if nothing was heard). */
export function useSpeechRecognition(handlers: {
  onResult: (text: string) => void;
  onEnd?: (finalText: string) => void;
  onError?: (code: string) => void;
}) {
  const h = useRef(handlers);
  h.current = handlers;
  const rec = useRef<Recognizer | null>(null);
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  useEffect(() => {
    setSupported(!!recognizerCtor());
    return () => rec.current?.abort();
  }, []);
  function start() {
    const Ctor = recognizerCtor();
    if (!Ctor) return;
    rec.current?.abort();
    const r = new Ctor();
    r.lang = navigator.language || "en-US";
    r.interimResults = true;
    r.continuous = false; // ends on a pause, which is when a voice turn is sent
    let finalText = "";
    r.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i];
        if (result.isFinal) finalText += result[0].transcript;
        else interim += result[0].transcript;
      }
      h.current.onResult((finalText + interim).trim());
    };
    r.onerror = (e) => h.current.onError?.(e.error);
    r.onend = () => {
      if (rec.current === r) rec.current = null;
      setListening(false);
      h.current.onEnd?.(finalText.trim());
    };
    rec.current = r;
    setListening(true);
    r.start();
  }
  return {
    supported,
    listening,
    start,
    stop: () => rec.current?.stop(),
    abort: () => rec.current?.abort(),
  };
}

/** Markdown to something pleasant to hear. */
export function speakable(markdown: string) {
  return markdown
    .replace(/```[\s\S]*?```/g, " (code block) ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/[*_~|]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function speechSupported() {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

export function cancelSpeech() {
  if (speechSupported()) window.speechSynthesis.cancel();
}

// Prefer natural/neural voices (e.g. "Google US English", "Microsoft Aria Online (Natural)").
function bestVoice(lang: string) {
  const voices = window.speechSynthesis.getVoices();
  const base = lang.split("-")[0];
  const matching = voices.filter((v) => v.lang.replace("_", "-").startsWith(base));
  const score = (v: SpeechSynthesisVoice) =>
    (v.lang.replace("_", "-") === lang ? 4 : 0) +
    (/natural|neural|online|google|premium|enhanced/i.test(v.name) ? 8 : 0) +
    (v.localService ? 0 : 1);
  return matching.sort((a, b) => score(b) - score(a))[0] || null;
}

/** Splits text into sentence-sized pieces; Chromium stops long utterances after ~15s. */
export function sentences(text: string) {
  return (text.match(/[^.!?]{1,220}(?:[.!?]+|$)|[^\s]{221,}/g) || [text])
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Speaks text as it streams in: each complete sentence is queued as soon as it arrives,
 * so a reply starts playing before generation finishes. Code fences are never split.
 */
export function createSpeaker(onLevel?: (speaking: boolean) => void) {
  let buffer = "";
  let pending = 0;
  let closed = false;
  let cancelled = false;
  let done: () => void = () => {};
  const finished = new Promise<void>((resolve) => (done = resolve));
  const lang = (typeof navigator !== "undefined" && navigator.language) || "en-US";
  function settle() {
    if (cancelled || (closed && pending === 0)) done();
  }
  function say(markdown: string) {
    if (cancelled || !speechSupported()) return;
    const voice = bestVoice(lang);
    for (const chunk of sentences(speakable(markdown))) {
      const u = new SpeechSynthesisUtterance(chunk);
      u.lang = voice?.lang || lang;
      if (voice) u.voice = voice;
      u.rate = 1.05;
      pending++;
      u.onstart = () => onLevel?.(true);
      u.onend = u.onerror = () => {
        pending--;
        if (pending === 0) onLevel?.(false);
        settle();
      };
      window.speechSynthesis.speak(u);
    }
  }
  return {
    push(text: string) {
      buffer += text;
      // Cut after the last sentence end (or line break) that is outside a code fence.
      const re = /[.!?](?=\s)|\n/g;
      let cut = -1;
      for (let m; (m = re.exec(buffer)); )
        if ((buffer.slice(0, m.index).match(/```/g) || []).length % 2 === 0)
          cut = m.index + 1;
      if (cut > 0) {
        say(buffer.slice(0, cut));
        buffer = buffer.slice(cut);
      }
    },
    /** Speaks what is left and resolves once everything has been spoken (or cancelled). */
    finish() {
      say(buffer);
      buffer = "";
      closed = true;
      settle();
      return finished;
    },
    cancel() {
      cancelled = true;
      buffer = "";
      cancelSpeech();
      onLevel?.(false);
      done();
    },
  };
}

/** Text to speech. Resolves when finished or cancelled. */
export function speak(markdown: string): Promise<void> {
  cancelSpeech();
  const speaker = createSpeaker();
  speaker.push(markdown);
  return speaker.finish();
}

/**
 * Live microphone loudness (0–1) for visualizers. Best effort: it never blocks speech
 * recognition, and stays at 0 when the microphone can't be opened.
 */
export function useMicLevel(active: boolean) {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    if (!active || !navigator.mediaDevices?.getUserMedia) return;
    let stopped = false;
    let frame = 0;
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    void navigator.mediaDevices
      .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
      .then((s) => {
        if (stopped) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        ctx = new AudioContext();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        ctx.createMediaStreamSource(s).connect(analyser);
        const data = new Uint8Array(analyser.fftSize);
        let smooth = 0;
        const tick = () => {
          analyser.getByteTimeDomainData(data);
          let sum = 0;
          for (const v of data) sum += ((v - 128) / 128) ** 2;
          const rms = Math.min(1, Math.sqrt(sum / data.length) * 4);
          smooth = smooth * 0.7 + rms * 0.3;
          setLevel(Math.round(smooth * 100) / 100);
          frame = requestAnimationFrame(tick);
        };
        tick();
      })
      .catch(() => {});
    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      stream?.getTracks().forEach((t) => t.stop());
      void ctx?.close();
      setLevel(0);
    };
  }, [active]);
  return level;
}
