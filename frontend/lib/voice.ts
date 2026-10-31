"use client";
import { useEffect, useRef, useState } from "react";
import { cancelAISpeech, speakAI, transcribeAI } from "./api";

/** Records locally, detects a pause, then asks the configured Gemini backend to transcribe. */
export function useSpeechRecognition(handlers: {
  onResult: (text: string) => void;
  onEnd?: (finalText: string) => void;
  onError?: (code: string) => void;
}) {
  const h = useRef(handlers);
  h.current = handlers;
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const context = useRef<AudioContext | null>(null);
  const frame = useRef(0);
  const cancelled = useRef(false);
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  useEffect(() => {
    setSupported(!!navigator.mediaDevices?.getUserMedia && "MediaRecorder" in window);
    return () => abort();
  }, []);
  async function start() {
    abort();
    cancelled.current = false;
    try {
      const media = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      if (cancelled.current) return media.getTracks().forEach((track) => track.stop());
      stream.current = media;
      const chunks: Blob[] = [];
      const r = new MediaRecorder(media);
      recorder.current = r;
      r.ondataavailable = (event) => event.data.size && chunks.push(event.data);
      r.onstop = async () => {
        cancelAnimationFrame(frame.current);
        media.getTracks().forEach((track) => track.stop());
        stream.current = null;
        void context.current?.close();
        context.current = null;
        recorder.current = null;
        setListening(false);
        if (cancelled.current) return;
        try {
          h.current.onResult("Transcribing…");
          const text = await transcribeAI(new Blob(chunks, { type: r.mimeType }));
          h.current.onResult(text);
          h.current.onEnd?.(text);
        } catch (error) {
          h.current.onError?.((error as Error).message || "transcription-failed");
        }
      };
      r.start(250);
      setListening(true);

      const audio = new AudioContext();
      context.current = audio;
      const analyser = audio.createAnalyser();
      analyser.fftSize = 256;
      audio.createMediaStreamSource(media).connect(analyser);
      const samples = new Uint8Array(analyser.fftSize);
      const started = performance.now();
      let speechAt = 0;
      const watch = () => {
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (const value of samples) sum += ((value - 128) / 128) ** 2;
        const loud = Math.sqrt(sum / samples.length) > 0.025;
        const now = performance.now();
        if (loud) speechAt = now;
        if ((speechAt && now - speechAt > 1200) || now - started > 15000) r.stop();
        else frame.current = requestAnimationFrame(watch);
      };
      watch();
    } catch (error) {
      setListening(false);
      h.current.onError?.(
        (error as DOMException).name === "NotAllowedError" ? "not-allowed" : "microphone-failed",
      );
    }
  }
  function abort() {
    cancelled.current = true;
    cancelAnimationFrame(frame.current);
    if (recorder.current?.state !== "inactive") recorder.current?.stop();
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    void context.current?.close();
    context.current = null;
    recorder.current = null;
    setListening(false);
  }
  return {
    supported,
    listening,
    start,
    stop: () => recorder.current?.state !== "inactive" && recorder.current?.stop(),
    abort,
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
  cancelAISpeech();
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
  let remote = Promise.resolve();
  const finished = new Promise<void>((resolve) => (done = resolve));
  const lang = (typeof navigator !== "undefined" && navigator.language) || "en-US";
  function settle() {
    if (cancelled || (closed && pending === 0)) done();
  }
  function say(markdown: string) {
    if (cancelled) return;
    const chunks = sentences(speakable(markdown));
    for (const chunk of chunks) {
      pending++;
      remote = remote
        .then(async () => {
          if (cancelled) return;
          onLevel?.(true);
          await speakAI(chunk);
        })
        .catch(
          () =>
            new Promise<void>((resolve) => {
              if (!speechSupported() || cancelled) return resolve();
              const u = new SpeechSynthesisUtterance(chunk);
              const voice = bestVoice(lang);
              u.lang = voice?.lang || lang;
              if (voice) u.voice = voice;
              u.rate = 1.05;
              u.onend = u.onerror = () => resolve();
              window.speechSynthesis.speak(u);
            }),
        )
        .finally(() => {
          pending--;
          if (pending === 0) onLevel?.(false);
          settle();
        });
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
