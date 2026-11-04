"use client";
import { useState } from "react";
import { Dialog } from "./ui/dialog";
import { Button } from "./ui/button";
import { Mic, Volume2, AudioLines, ShieldCheck, AlertCircle, LoaderCircle } from "lucide-react";
import { requestMandatoryPermissions } from "@/lib/voice";

export function VoicePermissionsDialog({
  open,
  onOpenChange,
  onGranted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onGranted: () => void;
}) {
  const [status, setStatus] = useState<"idle" | "requesting" | "denied">("idle");
  const [errorDetail, setErrorDetail] = useState<string>("");

  async function handleGrant() {
    setStatus("requesting");
    setErrorDetail("");
    const result = await requestMandatoryPermissions();
    if (result.success) {
      setStatus("idle");
      onOpenChange(false);
      onGranted();
    } else {
      setStatus("denied");
      setErrorDetail(
        result.error ||
          "Microphone permission was denied or blocked. Please allow microphone access in your browser settings to use real-time voice chat.",
      );
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (status !== "requesting") {
          onOpenChange(next);
        }
      }}
      title="Voice AI Permissions Required"
      description="Mandatory audio and microphone permissions are required before starting real-time simultaneous voice talks."
    >
      <div className="voice-permissions-container">
        <div className="voice-permissions-header">
          <div className="voice-permissions-icon-badge">
            <ShieldCheck size={28} />
          </div>
          <div className="voice-permissions-intro">
            <h4>Mandatory Permissions for Voice Talks</h4>
            <p>
              To experience seamless, real-time simultaneous voice conversation with Relay AI,
              the following permissions must be granted:
            </p>
          </div>
        </div>

        <ul className="voice-permissions-list">
          <li className="voice-permission-item">
            <div className="voice-perm-icon">
              <Mic size={20} />
            </div>
            <div className="voice-perm-info">
              <div className="voice-perm-title-row">
                <strong>Microphone Access</strong>
                <span className="voice-perm-badge mandatory">Mandatory</span>
              </div>
              <p>
                Captures your voice in real time so Relay AI can hear you and transcribe what you
                say simultaneously.
              </p>
            </div>
          </li>

          <li className="voice-permission-item">
            <div className="voice-perm-icon">
              <Volume2 size={20} />
            </div>
            <div className="voice-perm-info">
              <div className="voice-perm-title-row">
                <strong>Audio Playback & Output</strong>
                <span className="voice-perm-badge mandatory">Mandatory</span>
              </div>
              <p>
                Authorizes the browser to stream spoken AI responses back to you with zero latency
                without autoplay interruption.
              </p>
            </div>
          </li>

          <li className="voice-permission-item">
            <div className="voice-perm-icon">
              <AudioLines size={20} />
            </div>
            <div className="voice-perm-info">
              <div className="voice-perm-title-row">
                <strong>Real-Time Duplex & Voice Interruption</strong>
                <span className="voice-perm-badge mandatory">Mandatory</span>
              </div>
              <p>
                Enables simultaneous listening and speaking, allowing you to interrupt the AI
                naturally with your voice at any time.
              </p>
            </div>
          </li>
        </ul>

        {status === "denied" && (
          <div className="voice-permission-denied-box" role="alert">
            <div className="voice-denied-heading">
              <AlertCircle size={18} />
              <strong>Permission Blocked or Denied</strong>
            </div>
            <p className="voice-denied-desc">{errorDetail}</p>
            <div className="voice-denied-steps">
              <p className="steps-title">How to enable microphone in your browser:</p>
              <ol>
                <li>Click the <strong>lock / site settings icon</strong> (🔒) in your browser’s address bar.</li>
                <li>Find <strong>Microphone</strong> and switch it from <em>Block</em> to <strong>Allow</strong>.</li>
                <li>Ensure <strong>Sound</strong> is also permitted.</li>
                <li>Click <strong>Try Again</strong> below to re-verify permissions.</li>
              </ol>
            </div>
          </div>
        )}

        <div className="dialog-actions voice-permission-actions">
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={status === "requesting"}
          >
            Cancel
          </Button>

          <Button
            type="button"
            variant="default"
            className="voice-grant-btn"
            onClick={handleGrant}
            disabled={status === "requesting"}
          >
            {status === "requesting" ? (
              <>
                <LoaderCircle size={16} className="spin" />
                <span>Checking Permissions…</span>
              </>
            ) : status === "denied" ? (
              "Try Again & Grant Permissions"
            ) : (
              "Grant Mandatory Permissions & Start Voice"
            )}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

