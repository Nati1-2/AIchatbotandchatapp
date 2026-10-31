"use client";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Mic, MicOff, Sparkles, Volume2, X } from "lucide-react";
import { speakable } from "@/lib/voice";

export type VoiceState = "off" | "listening" | "thinking" | "speaking" | "held";

/** Full-screen hands-free conversation, in the spirit of Gemini Live. */
export function VoiceLive({
  state,
  heard,
  caption,
  level,
  onHold,
  onResume,
  onInterrupt,
  onEnd,
}: {
  state: VoiceState;
  heard: string;
  caption: string;
  level: number;
  onHold: () => void;
  onResume: () => void;
  onInterrupt: () => void;
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
      ? "Listening"
      : state === "thinking"
        ? "Thinking"
        : state === "speaking"
          ? "Speaking"
          : "Microphone muted";
  const statusDetail =
    state === "listening"
      ? "Speak naturally — I’ll answer when you pause"
      : state === "thinking"
        ? "Putting together a response"
        : state === "speaking"
          ? "Tap the wave to jump in"
          : "Tap unmute when you’re ready to speak";
  return createPortal(
    <div
      className={`live live-${state}`}
      role="dialog"
      aria-modal="true"
      aria-label="Voice conversation with Relay AI"
      style={{ "--level": level } as React.CSSProperties}
    >
      <header className="live-top">
        <span className="live-badge">
          <Sparkles size={15} />
          Relay Live
        </span>
      </header>
      <div
        className="live-captions"
        aria-live="polite"
        onClick={state === "speaking" ? onInterrupt : undefined}
      >
        {state === "listening" && (
          <p className={heard ? "live-user" : "live-hint"}>
            {heard || "Go ahead, I’m listening"}
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
        {state === "speaking" && <p className="live-ai">{tail || "…"}</p>}
        {state === "held" && (
          <p className="live-hint">Your microphone is muted.</p>
        )}
      </div>
      <div className="live-visual-wrap">
        <button
          type="button"
          className="live-orb"
          aria-label={
            state === "speaking" ? "Interrupt and talk" : `Relay AI: ${status}`
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
