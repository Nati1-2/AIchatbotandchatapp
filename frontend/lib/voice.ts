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
      error:
        "Your browser does not support audio capture. Please use a modern browser like Chrome, Edge, or Safari.",
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
        error:
          "Microphone permission was denied. Please allow microphone access in your browser to talk with Relay AI.",
      };
    }
    if (err.name === "NotFoundError" || err.name === "DevicesNotFoundError") {
      return {
        success: false,
        code: "not-found",
        error:
          "No microphone was found on your device. Please connect an audio input device and try again.",
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
 * with continuous duplex, mic level monitoring, and voice interruption (barge-in) support,
 * and falls back gracefully to AudioContext + MediaRecorder + Gemini server transcription.
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
  const analyserNode = useRef<AnalyserNode | null>(null);
  const frame = useRef(0);
  const cancelled = useRef(false);
  const silenceTimer = useRef<any>(null);
  const accumulatedFinal = useRef("");
  const isFallback = useRef(false);
  const isUserSpeaking = useRef(false);
  const chunksRef = useRef<Blob[]>([]);

  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [level, setLevel] = useState(0);

  useEffect(() => {
    setSupported(isSpeechRecognitionSupported());
    return () => abort();
  }, []);

  async function start() {
    abort();
    cancelled.current = false;
    accumulatedFinal.current = "";
    isUserSpeaking.current = false;

    // 1. Acquire MediaStream for microphone loudness monitoring and fallback recording
    let audioStream: MediaStream | null = null;
    if (hasGetUserMedia()) {
      try {
        audioStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        if (cancelled.current) {
          audioStream.getTracks().forEach((t) => t.stop());
          return;
        }
        stream.current = audioStream;

        // Set up AudioContext and AnalyserNode for live level and VAD
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx) {
          const ctx = new AudioCtx();
          if (ctx.state === "suspended") {
            void ctx.resume();
          }
          context.current = ctx;
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 256;
          analyserNode.current = analyser;
          const source = ctx.createMediaStreamSource(audioStream);
          source.connect(analyser);

          const samples = new Uint8Array(analyser.fftSize);
          let smooth = 0;
          let lastSpeechTime = 0;

          const tick = () => {
            if (cancelled.current || !analyserNode.current) return;
            analyser.getByteTimeDomainData(samples);
            let sum = 0;
            for (let i = 0; i < samples.length; i++) {
              sum += ((samples[i] - 128) / 128) ** 2;
            }
            const rms = Math.min(1, Math.sqrt(sum / samples.length) * 5);
            smooth = smooth * 0.7 + rms * 0.3;
            setLevel(Math.round(smooth * 100) / 100);

            // VAD check: voice detected!
            if (rms > 0.035) {
              lastSpeechTime = performance.now();
              if (!isUserSpeaking.current) {
                isUserSpeaking.current = true;
                h.current.onUserSpeaking?.();
              }
            }

            // In fallback mode (MediaRecorder): detect end of speech
            if (isFallback.current && isUserSpeaking.current) {
              if (lastSpeechTime > 0 && performance.now() - lastSpeechTime > 800) {
                isUserSpeaking.current = false;
                lastSpeechTime = 0;
                if (recorder.current && recorder.current.state === "recording") {
                  try {
                    recorder.current.stop();
                  } catch {}
                }
              }
            }

            frame.current = requestAnimationFrame(tick);
          };
          frame.current = requestAnimationFrame(tick);
        }
      } catch (err) {
        const domErr = err as DOMException;
        if (domErr.name === "NotAllowedError" || domErr.name === "PermissionDeniedError") {
          h.current.onError?.("not-allowed");
          return;
        }
      }
    }

    // 2. Primary recognition engine: Web Speech API
    const SpeechRec =
      typeof window !== "undefined" &&
      (window.SpeechRecognition || window.webkitSpeechRecognition);

    if (SpeechRec && !isFallback.current) {
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
            try {
              rec.stop();
            } catch {}
            return;
          }
          setListening(true);
        };

        rec.onspeechstart = () => {
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

          if (silenceTimer.current) clearTimeout(silenceTimer.current);
          if (currentTurnText) {
            silenceTimer.current = setTimeout(() => {
              if (cancelled.current) return;
              const completed = currentTurnText;
              accumulatedFinal.current = "";
              // STOP native recognition turn cleanly so it won't listen to AI turn
              try {
                rec.stop();
              } catch {}
              setListening(false);
              h.current.onResult(completed, true);
              h.current.onEnd?.(completed);
            }, 750);
          }
        };

        rec.onerror = (event: any) => {
          if (cancelled.current) return;
          const error = event.error;
          if (error === "no-speech" || error === "aborted") return;
          if (error === "not-allowed" || error === "service-not-allowed") {
            setListening(false);
            h.current.onError?.("not-allowed");
          } else {
            // Network or audio capture error on Web Speech -> fallback to MediaRecorder + Gemini
            isFallback.current = true;
            try {
              rec.abort();
            } catch {}
            nativeRec.current = null;
            startMediaRecorderFallback(audioStream);
          }
        };

        rec.onend = () => {
          if (cancelled.current || !listening) {
            setListening(false);
            return;
          }
        };

        try {
          rec.start();
        } catch {
          // If start fails (already started or blocked)
          isFallback.current = true;
          startMediaRecorderFallback(audioStream);
        }
        return;
      } catch {
        isFallback.current = true;
      }
    }

    // 3. Fallback engine: MediaRecorder + Gemini Transcribe
    startMediaRecorderFallback(audioStream);
  }

  function startMediaRecorderFallback(audioStream: MediaStream | null) {
    if (cancelled.current) return;
    if (!audioStream) {
      h.current.onError?.("microphone-failed");
      return;
    }
    chunksRef.current = [];
    try {
      const rec = new MediaRecorder(audioStream);
      recorder.current = rec;
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };
      rec.onstop = async () => {
        if (cancelled.current) return;
        const blob = new Blob(chunksRef.current, {
          type: rec.mimeType || "audio/webm",
        });
        chunksRef.current = [];
        if (blob.size < 1000) {
          if (!cancelled.current) {
            startMediaRecorderFallback(audioStream);
          }
          return;
        }
        try {
          h.current.onResult("Transcribing with Gemini…", false);
          const text = await transcribeAI(blob);
          if (text && text.trim()) {
            h.current.onResult(text.trim(), true);
            h.current.onEnd?.(text.trim());
          } else {
            if (!cancelled.current) {
              startMediaRecorderFallback(audioStream);
            }
          }
        } catch {
          if (!cancelled.current) {
            startMediaRecorderFallback(audioStream);
          }
        }
      };
      rec.start(150);
      setListening(true);
    } catch {
      h.current.onError?.("microphone-failed");
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
    if (recorder.current && recorder.current.state !== "inactive") {
      try {
        recorder.current.stop();
      } catch {}
      recorder.current = null;
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
    if (recorder.current && recorder.current.state !== "inactive") {
      try {
        recorder.current.stop();
      } catch {}
      recorder.current = null;
    }
    if (stream.current) {
      stream.current.getTracks().forEach((track) => track.stop());
      stream.current = null;
    }
    if (context.current) {
      void context.current.close().catch(() => {});
      context.current = null;
    }
    analyserNode.current = null;
    chunksRef.current = [];
    setLevel(0);
    setListening(false);
  }

  return {
    supported,
    listening,
    level,
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

let activeGreetingAudio: HTMLAudioElement | null = null;

export function cancelSpeech() {
  if (activeGreetingAudio) {
    activeGreetingAudio.pause();
    activeGreetingAudio.currentTime = 0;
    activeGreetingAudio = null;
  }
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
    activeGreetingAudio = audio;
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
  } finally {
    if (activeGreetingAudio) {
      activeGreetingAudio = null;
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
export function createSpeaker(
  onLevel?: (speaking: boolean, level?: number) => void,
) {
  let buffer = "";
  let pending = 0;
  let closed = false;
  let cancelled = false;
  let done: () => void = () => {};
  let remote = Promise.resolve();
  let pulseTimer: any = null;
  const finished = new Promise<void>((resolve) => (done = resolve));
  const lang = (typeof navigator !== "undefined" && navigator.language) || "en-US";

  function startPulse() {
    if (pulseTimer) return;
    pulseTimer = setInterval(() => {
      if (cancelled || pending === 0) {
        clearInterval(pulseTimer);
        pulseTimer = null;
        onLevel?.(false, 0);
        return;
      }
      onLevel?.(true, 0.35 + Math.random() * 0.45);
    }, 120);
  }

  function stopPulse() {
    if (pulseTimer) {
      clearInterval(pulseTimer);
      pulseTimer = null;
    }
    onLevel?.(false, 0);
  }

  function settle() {
    if (cancelled || (closed && pending === 0)) {
      stopPulse();
      done();
    }
  }

  function say(markdown: string) {
    if (cancelled) return;
    const chunks = sentences(speakable(markdown));
    for (const chunk of chunks) {
      pending++;
      remote = remote
        .then(async () => {
          if (cancelled) return;
          startPulse();
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
              startPulse();
              window.speechSynthesis.speak(u);
            }),
        )
        .finally(() => {
          pending--;
          if (pending === 0) stopPulse();
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
      stopPulse();
      cancelSpeech();
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
