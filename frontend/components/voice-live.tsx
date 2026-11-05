"use client";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Mic, MicOff, Sparkles, Volume2, X, Radio } from "lucide-react";
import { speakable } from "@/lib/voice";

export type VoiceState = "off" | "listening" | "thinking" | "speaking" | "held";

/** Full-screen hands-free full-duplex voice conversation. */
export function VoiceLive({
  state,
  heard,
  caption,
  level,
  onHold,
  onResume,
  onInterrupt,
  volume,
  onVolumeChange,
  onEnd,
}: {
  state: VoiceState;
  heard: string;
  caption: string;
  level: number;
  onHold: () => void;
  onResume: () => void;
  onInterrupt: () => void;
  volume: number;
  onVolumeChange: (volume: number) => void;
  onEnd: () => void;
}) {
  const end = useRef<HTMLButtonElement>(null);
  const onEndRef = useRef(onEnd);
  onEndRef.current = onEnd;
  const open = state !== "off";

  useEffect(() => {
    if (!open) return;
    end.current?.focus();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onEndRef.current();
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [open]);

  if (!open || typeof document === "undefined") return null;

  // Show the tail of the spoken reply, like live captions.
  const spoken = speakable(caption);
  const tail = spoken.length > 260 ? "…" + spoken.slice(-260) : spoken;

  const status =
    state === "listening"
      ? "Listening in Real Time"
      : state === "thinking"
        ? "Thinking"
        : state === "speaking"
          ? "Speaking"
          : "Microphone Muted";

  const statusDetail =
    state === "listening"
      ? "Speak naturally — Gemini is listening continuously"
      : state === "thinking"
        ? "Putting together a real-time response"
        : state === "speaking"
          ? "Full duplex is active — speak anytime to interrupt"
          : "Tap unmute when you’re ready to talk";

  return createPortal(
    <div
      className={`live live-${state}`}
      role="dialog"
      aria-modal="true"
      aria-label="Real-time voice conversation with Relay AI"
      style={{ "--level": level } as React.CSSProperties}
    >
      <header className="live-top">
        <span className="live-badge">
          <Sparkles size={15} />
          Relay Live · Real-Time Full Duplex
        </span>
      </header>

      <div
        className="live-captions"
        aria-live="polite"
        onClick={state === "speaking" ? onInterrupt : undefined}
      >
        {state === "listening" && (
          <p className={heard ? "live-user" : "live-hint"}>
            {heard || "Go ahead, I’m listening in real time…"}
          </p>
        )}
        {state === "thinking" && (
          <>
            <p className="live-user live-dim">{heard}</p>
            <span className="live-dots" aria-label="Thinking">
              <i />
              <i />
              <i />
            </span>
          </>
        )}
        {state === "speaking" && (
          <>
            <p className="live-ai">{tail || "…"}</p>
            <div className="live-duplex-pill">
              <Radio size={12} className="live-pulse" />
              <span>Speak naturally to interrupt at any time</span>
            </div>
          </>
        )}
        {state === "held" && (
          <p className="live-hint">Your microphone is muted.</p>
        )}
      </div>

      <div className="live-visual-wrap">
        <button
          type="button"
          className="live-orb"
          aria-label={
            state === "speaking"
              ? "Interrupt and talk"
              : `Relay AI: ${status}`
          }
          onClick={state === "speaking" ? onInterrupt : undefined}
          tabIndex={state === "speaking" ? 0 : -1}
        >
          <span className="live-orb-aura" />
          <span className="live-orb-core">
            {state === "listening" ? <Mic size={28} /> : <Volume2 size={28} />}
          </span>
          <span className="live-wave" aria-hidden="true">
            {Array.from({ length: 19 }, (_, index) => (
              <i
                key={index}
                style={
                  {
                    "--bar": index,
                    "--peak": 1.25 + (index % 5) * 0.28,
                  } as React.CSSProperties
                }
              />
            ))}
          </span>
        </button>
        <div className="live-state" role="status">
          <strong>{status}</strong>
          <span>{statusDetail}</span>
        </div>
      </div>

      <footer className="live-controls">
        <span className="live-control">
          <button
            type="button"
            aria-label={state === "held" ? "Unmute microphone" : "Mute microphone"}
            onClick={state === "held" ? onResume : onHold}
          >
            {state === "held" ? <Mic size={24} /> : <MicOff size={24} />}
          </button>
          {state === "held" ? "Unmute" : "Mute"}
        </span>
        <label className="live-control live-volume">
          <span className="live-volume-icon"><Volume2 size={22} /></span>
          <input
            type="range"
            min="0"
            max="100"
            step="5"
            value={Math.round(volume * 100)}
            aria-label="Assistant volume"
            onChange={(event) => onVolumeChange(Number(event.target.value) / 100)}
          />
          <span>{Math.round(volume * 100)}%</span>
        </label>
        <span className="live-control">
          <button
            ref={end}
            type="button"
            className="live-end"
            aria-label="End voice conversation"
            onClick={onEnd}
          >
            <X size={26} />
          </button>
          End
        </span>
      </footer>
    </div>,
    document.body,
  );
}
