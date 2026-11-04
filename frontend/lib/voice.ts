"use client";
import { useEffect, useRef, useState } from "react";
import { cancelAISpeech, speakAI, transcribeAI } from "./api";

declare global {
  interface Window {
    SpeechRecognition?: any;
    webkitSpeechRecognition?: any;
    webkitAudioContext?: any;
  }
}

export interface PermissionCheckResult {
  microphone: "granted" | "denied" | "prompt" | "unsupported";
  audioPlayback: "granted" | "denied" | "unsupported";
  allGranted: boolean;
}

/** Safely checks whether mediaDevices.getUserMedia is available as a function. */
export function hasGetUserMedia(): boolean {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === "function"
  );
}

/** Check whether required permissions are currently granted. */
export async function checkVoicePermissions(): Promise<PermissionCheckResult> {
  if (!hasGetUserMedia()) {
    return {
      microphone: "unsupported",
      audioPlayback: "unsupported",
      allGranted: false,
    };
  }

  let micState: "granted" | "denied" | "prompt" | "unsupported" = "prompt";
  try {
    if (
      typeof navigator !== "undefined" &&
      "permissions" in navigator &&
      typeof navigator.permissions?.query === "function"
    ) {
      const status = await navigator.permissions.query({
        name: "microphone" as PermissionName,
      });
      micState = status.state;
    }
  } catch {
    // Some browsers (like Safari) don't support permissions.query for microphone
    micState = "prompt";
  }

  return {
    microphone: micState,
    audioPlayback: typeof AudioContext !== "undefined" ? "granted" : "unsupported",
    allGranted: micState === "granted",
  };
}

/**
 * Mandatory permission prompt and verification for Voice AI talks.
 * Requests microphone permission and unlocks AudioContext for real-time simultaneous audio.
 */
export async function requestMandatoryPermissions(): Promise<{
  success: boolean;
  error?: string;
  code?: "not-allowed" | "not-found" | "unsupported" | "unknown";
}> {
  if (!hasGetUserMedia()) {
    return {
      success: false,
      code: "unsupported",
      error: "Your browser does not support audio capture. Please use a modern browser like Chrome, Edge, or Safari.",
    };
  }

  try {
    // 1. Explicitly request microphone stream with hardware echo cancellation
    const media = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    // Successfully granted! Close the test tracks immediately so we don't hold the mic unnecessarily.
    media.getTracks().forEach((track) => track.stop());

    // 2. Unlock and verify AudioContext playback permissions
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        const testCtx = new AudioCtx();
        if (testCtx.state === "suspended") {
          await testCtx.resume();
        }
        await testCtx.close();
      }
    } catch {
      // AudioContext fallback
    }

    return { success: true };
  } catch (error) {
    const err = error as DOMException;
    if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
      return {
        success: false,
        code: "not-allowed",
        error: "Microphone permission was denied. Please allow microphone access in your browser to talk with Relay AI.",
      };
    }
    if (err.name === "NotFoundError" || err.name === "DevicesNotFoundError") {
      return {
        success: false,
        code: "not-found",
        error: "No microphone was found on your device. Please connect an audio input device and try again.",
      };
    }
    return {
      success: false,
      code: "unknown",
      error: err.message || "Could not acquire microphone permission.",
    };
  }
}

export function isSpeechRecognitionSupported(): boolean {
  if (typeof window === "undefined") return false;
  return !!(
    window.SpeechRecognition ||
    window.webkitSpeechRecognition ||
    (hasGetUserMedia() && "MediaRecorder" in window)
  );
}

/**
 * Real-time simultaneous speech recognition hook.
 * Uses native Web Speech API (interim results in real-time) when available,
 * with continuous duplex and voice interruption (barge-in) support,
 * and falls back gracefully to AudioContext + MediaRecorder + server transcription.
 */
export function useSpeechRecognition(handlers: {
  onResult: (text: string, isFinal?: boolean) => void;
  onEnd?: (finalText: string) => void;
  onError?: (code: string) => void;
  onUserSpeaking?: () => void;
}) {
  const h = useRef(handlers);
  h.current = handlers;

  const nativeRec = useRef<any>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const context = useRef<AudioContext | null>(null);
  const frame = useRef(0);
  const cancelled = useRef(false);
  const silenceTimer = useRef<any>(null);
  const accumulatedFinal = useRef("");
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);

  useEffect(() => {
    setSupported(isSpeechRecognitionSupported());
    return () => abort();
  }, []);

  async function start() {
    abort();
    cancelled.current = false;
    accumulatedFinal.current = "";

    const SpeechRec =
      typeof window !== "undefined" &&
      (window.SpeechRecognition || window.webkitSpeechRecognition);

    // Prefer native Web Speech API for zero-latency, real-time interim recognition
    if (SpeechRec) {
      try {
        const rec = new SpeechRec();
        nativeRec.current = rec;
        rec.continuous = true;
        rec.interimResults = true;
        rec.maxAlternatives = 1;
        rec.lang = (typeof navigator !== "undefined" && navigator.language) || "en-US";

        let currentTurnText = "";

        rec.onstart = () => {
          if (cancelled.current) {
            rec.stop();
            return;
          }
          setListening(true);
        };

        rec.onspeechstart = () => {
          // Notify that user started speaking (triggers natural interruption / barge-in)
          h.current.onUserSpeaking?.();
          if (silenceTimer.current) {
            clearTimeout(silenceTimer.current);
            silenceTimer.current = null;
          }
        };

        rec.onresult = (event: any) => {
          if (cancelled.current) return;
          h.current.onUserSpeaking?.();

          let interim = "";
          let finalPiece = "";

          for (let i = event.resultIndex; i < event.results.length; ++i) {
            const result = event.results[i];
            const transcript = result[0]?.transcript || "";
            if (result.isFinal) {
              finalPiece += transcript;
            } else {
              interim += transcript;
            }
          }

          if (finalPiece) {
            accumulatedFinal.current = (
              accumulatedFinal.current +
              " " +
              finalPiece
            ).trim();
          }

          currentTurnText = (
            accumulatedFinal.current +
            " " +
            interim
          ).trim();

          if (currentTurnText) {
            h.current.onResult(currentTurnText, false);
          }

          // Natural conversational pause detection (850ms of silence after speaking)
          if (silenceTimer.current) clearTimeout(silenceTimer.current);
          if (currentTurnText) {
            silenceTimer.current = setTimeout(() => {
              if (cancelled.current) return;
              const completed = currentTurnText;
              accumulatedFinal.current = "";
              h.current.onResult(completed, true);
              h.current.onEnd?.(completed);
            }, 850);
          }
        };

        rec.onerror = (event: any) => {
          if (cancelled.current) return;
          const error = event.error;
          if (error === "no-speech") return;
          if (error === "aborted") return;
          if (error === "not-allowed" || error === "service-not-allowed") {
            setListening(false);
            h.current.onError?.("not-allowed");
          } else {
            // For other speech engine errors, fallback to media recorder if possible
            startFallbackRecorder();
          }
        };

        rec.onend = () => {
          if (cancelled.current) {
            setListening(false);
            return;
          }
          // Restart continuous listening if not intentionally stopped
          try {
            rec.start();
          } catch {
            setListening(false);
          }
        };

        rec.start();
        return;
      } catch {
        // Fall back to MediaRecorder
      }
    }

    startFallbackRecorder();
  }

  async function startFallbackRecorder() {
    try {
      const media = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
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
          h.current.onResult("Transcribing…", false);
          const text = await transcribeAI(new Blob(chunks, { type: r.mimeType }));
          h.current.onResult(text, true);
          h.current.onEnd?.(text);
        } catch (error) {
          h.current.onError?.((error as Error).message || "transcription-failed");
        }
      };
      r.start(200);
      setListening(true);

      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const audio = new AudioCtx();
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
        const rms = Math.sqrt(sum / samples.length);
        const loud = rms > 0.025;
        const now = performance.now();
        if (loud) {
          speechAt = now;
          h.current.onUserSpeaking?.();
        }
        if ((speechAt && now - speechAt > 850) || now - started > 15000) {
          r.stop();
        } else {
          frame.current = requestAnimationFrame(watch);
        }
      };
      watch();
    } catch (error) {
      setListening(false);
      h.current.onError?.(
        (error as DOMException).name === "NotAllowedError" ? "not-allowed" : "microphone-failed",
      );
    }
  }

  function stop() {
    if (silenceTimer.current) {
      clearTimeout(silenceTimer.current);
      silenceTimer.current = null;
    }
    if (nativeRec.current) {
      try {
        nativeRec.current.stop();
      } catch {}
      nativeRec.current = null;
    }
    if (recorder.current?.state !== "inactive") {
      recorder.current?.stop();
    }
    setListening(false);
  }

  function abort() {
    cancelled.current = true;
    if (silenceTimer.current) {
      clearTimeout(silenceTimer.current);
      silenceTimer.current = null;
    }
    cancelAnimationFrame(frame.current);
    if (nativeRec.current) {
      try {
        nativeRec.current.abort();
      } catch {}
      nativeRec.current = null;
    }
    if (recorder.current?.state !== "inactive") {
      try {
        recorder.current?.stop();
      } catch {}
    }
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
    stop,
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

/** Starts browser speech immediately, preserving the user's click activation. */
export function speakLocal(markdown: string): Promise<void> {
  return new Promise((resolve) => {
    if (!speechSupported()) return resolve();
    const text = speakable(markdown);
    if (!text) return resolve();
    window.speechSynthesis.cancel();
    const lang = (typeof navigator !== "undefined" && navigator.language) || "en-US";
    const utterance = new SpeechSynthesisUtterance(text);
    const voice = bestVoice(lang);
    utterance.lang = voice?.lang || lang;
    if (voice) utterance.voice = voice;
    utterance.rate = 1.03;
    utterance.onend = utterance.onerror = () => resolve();
    window.speechSynthesis.speak(utterance);
  });
}

/** Uses server-generated audio in browsers without the Web Speech API. */
export async function speakGreeting(markdown: string): Promise<void> {
  cancelSpeech();
  try {
    const audio = new Audio("/relay-greeting.wav");
    await audio.play();
    await new Promise<void>((resolve, reject) => {
      audio.onended = () => resolve();
      audio.onerror = () => reject(new Error("Greeting playback failed."));
    });
  } catch {
    try {
      await speakAI(speakable(markdown));
    } catch {
      await speakLocal(markdown);
    }
  }
}

// Prefer natural/neural voices (e.g. "Google US English", "Microsoft Aria Online (Natural)").
function bestVoice(lang: string) {
  if (!speechSupported()) return null;
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
    if (!active || !hasGetUserMedia()) return;
    let stopped = false;
    let frame = 0;
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    void navigator.mediaDevices
      .getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
      .then((s) => {
        if (stopped) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        ctx = new AudioCtx();
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
