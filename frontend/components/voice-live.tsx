"use client";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Captions, CaptionsOff, Globe, Mic, MicOff, Sparkles, Volume2, X, Radio, Wifi } from "lucide-react";
import { speakable } from "@/lib/voice";
import { VOICE_LANGUAGES, type VoiceLanguage } from "@/lib/languages";

export type VoiceState = "off" | "connecting" | "listening" | "thinking" | "speaking" | "held";

const STATUS: Record<Exclude<VoiceState, "off">, [string, string]> = {
  connecting: ["Connecting", "Opening a real-time line to Relay…"],
  listening: ["Listening", "Talk naturally — no need to press anything"],
  thinking: ["Thinking", "Working on a reply"],
  speaking: ["Speaking", "Start talking anytime to interrupt"],
  held: ["Microphone off", "Tap Unmute when you're ready to talk"],
};

function readCaptionsPref() {
  try {
    return window.localStorage.getItem("relay_live_captions") !== "off";
  } catch {
    return true;
  }
}

/** Full-screen hands-free full-duplex voice conversation. */
export function VoiceLive({
  state,
  heard,
  caption,
  level,
  notice,
  language,
  onLanguageChange,
  onHold,
  onResume,
  onInterrupt,
  volume,
  onVolumeChange,
  onEnd,
}: {
  state: VoiceState;
  /** What the user said most recently (live transcription). */
  heard: string;
  /** The assistant's current or most recent reply. */
  caption: string;
  level: number;
  /** Transient connection notice, e.g. while reconnecting. */
  notice?: string;
  language: VoiceLanguage;
  onLanguageChange: (language: VoiceLanguage) => void;
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
  const [captions, setCaptions] = useState(true);

  useEffect(() => {
    if (!open) return;
    setCaptions(readCaptionsPref());
    end.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onEndRef.current();
    };
    document.addEventListener("keydown", key);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", key);
      document.body.style.overflow = overflow;
    };
  }, [open]);

  if (!open || typeof document === "undefined") return null;

  function toggleCaptions() {
    setCaptions((on) => {
      try {
        window.localStorage.setItem("relay_live_captions", on ? "off" : "on");
      } catch {}
      return !on;
    });
  }

  // Show the tail of each side, like live captions.
  const spoken = speakable(caption);
  const aiTail = spoken.length > 220 ? "…" + spoken.slice(-220).trimStart() : spoken;
  const you = heard.trim();
  const youTail = you.length > 140 ? "…" + you.slice(-140).trimStart() : you;
  const [status, detail] = STATUS[state];
  const userActive = state === "listening" && !!youTail;
  const aiActive = state === "speaking";

  return createPortal(
    <div
      className={`live live-${state}`}
      role="dialog"
      aria-modal="true"
      aria-label="Real-time voice conversation with Relay AI"
      style={{ "--level": Math.min(1, level) } as React.CSSProperties}
    >
      <header className="live-top">
        <span className="live-badge">
          <Sparkles size={15} />
          Relay Live
          <span className={`live-dot ${state === "connecting" || notice ? "live-dot-wait" : ""}`} />
        </span>
        <label className="live-lang" title="Language you speak — Relay replies in it">
          <Globe size={16} aria-hidden="true" />
          <select
            aria-label="Conversation language"
            value={language}
            onChange={(e) => onLanguageChange(e.target.value as VoiceLanguage)}
          >
            {VOICE_LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="live-icon-btn"
          aria-pressed={captions}
          aria-label={captions ? "Hide captions" : "Show captions"}
          onClick={toggleCaptions}
        >
          {captions ? <Captions size={20} /> : <CaptionsOff size={20} />}
        </button>
      </header>

      {notice && (
        <div className="live-notice" role="status">
          <Wifi size={14} />
          {notice}
        </div>
      )}

      <div
        className="live-captions"
        aria-live="polite"
        onClick={aiActive ? onInterrupt : undefined}
      >
        {state === "connecting" ? (
          <span className="live-dots" aria-label="Connecting">
            <i />
            <i />
            <i />
          </span>
        ) : state === "held" ? (
          <p className="live-hint">Relay is paused. Your microphone is off.</p>
        ) : !captions ? null : (
          <>
            {(youTail || state === "listening") && (
              <p className={`live-user ${userActive ? "" : "live-dim"} ${youTail ? "" : "live-hint"}`}>
                {youTail || "Go ahead, I'm listening…"}
              </p>
            )}
            {state === "thinking" && (
              <span className="live-dots" aria-label="Thinking">
                <i />
                <i />
                <i />
              </span>
            )}
            {aiTail && state !== "listening" && state !== "thinking" && (
              <p className="live-ai">{aiTail}</p>
            )}
            {aiActive && (
              <div className="live-duplex-pill">
                <Radio size={12} className="live-pulse" />
                <span>Just talk to interrupt</span>
              </div>
            )}
          </>
        )}
      </div>

      <div className="live-visual-wrap">
        <button
          type="button"
          className="live-orb"
          aria-label={aiActive ? "Interrupt and talk" : `Relay AI: ${status}`}
          onClick={aiActive ? onInterrupt : state === "held" ? onResume : undefined}
          tabIndex={aiActive || state === "held" ? 0 : -1}
        >
          <span className="live-orb-aura" />
          <span className="live-orb-core">
            {state === "held" ? <MicOff size={26} /> : state === "speaking" ? <Volume2 size={26} /> : <Mic size={26} />}
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
          <span>{detail}</span>
        </div>
      </div>

      <footer className="live-controls">
        <span className="live-control">
          <button
            type="button"
            className={state === "held" ? "live-on" : ""}
            aria-label={state === "held" ? "Unmute microphone" : "Mute microphone"}
            aria-pressed={state === "held"}
            disabled={state === "connecting"}
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
