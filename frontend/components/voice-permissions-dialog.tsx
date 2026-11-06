"use client";
import { useEffect, useMemo, useState } from "react";
import { Dialog } from "./ui/dialog";
import { Button } from "./ui/button";
import {
  AlertCircle,
  Check,
  LoaderCircle,
  Lock,
  Mic,
  Monitor,
  ShieldAlert,
  Smartphone,
  Volume2,
} from "lucide-react";
import {
  checkVoicePermissions,
  detectDevice,
  microphoneHelpSteps,
  requestMandatoryPermissions,
} from "@/lib/voice";
import { unlockAudio } from "@/lib/live-voice";

type Status = "idle" | "requesting" | "granted" | "denied" | "insecure" | "unsupported";

export function VoicePermissionsDialog({
  open,
  onOpenChange,
  onGranted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onGranted: () => void;
}) {
  const [status, setStatus] = useState<Status>("idle");
  const [errorDetail, setErrorDetail] = useState("");
  const device = useMemo(() => (typeof navigator === "undefined" ? null : detectDevice()), []);
  const steps = device ? microphoneHelpSteps(device) : [];

  // Pre-flight: detect blocked/insecure states before the user taps anything,
  // and continue automatically if they fix the permission in browser settings.
  useEffect(() => {
    if (!open) return;
    setErrorDetail("");
    if (typeof window !== "undefined" && !window.isSecureContext) {
      setStatus("insecure");
      return;
    }
    setStatus("idle");
    let perm: PermissionStatus | null = null;
    let cancelled = false;
    void checkVoicePermissions().then((result) => {
      if (cancelled) return;
      if (result.microphone === "unsupported") setStatus("unsupported");
      else if (result.microphone === "denied") setStatus("denied");
    });
    try {
      void navigator.permissions
        ?.query({ name: "microphone" as PermissionName })
        .then((p) => {
          if (cancelled) return;
          perm = p;
          p.onchange = () => {
            if (p.state === "granted") setStatus((s) => (s === "denied" ? "idle" : s));
            if (p.state === "denied") setStatus("denied");
          };
        })
        .catch(() => {});
    } catch {}
    return () => {
      cancelled = true;
      if (perm) perm.onchange = null;
    };
  }, [open]);

  async function handleGrant() {
    // Must run synchronously inside the tap so iOS/Android allow audio output.
    unlockAudio();
    setStatus("requesting");
    setErrorDetail("");
    const result = await requestMandatoryPermissions();
    if (result.success) {
      setStatus("granted");
      onOpenChange(false);
      onGranted();
      return;
    }
    setStatus(result.code === "unsupported" ? "unsupported" : "denied");
    setErrorDetail(result.error || "");
  }

  const busy = status === "requesting";
  const blocked = status === "denied" || status === "insecure" || status === "unsupported";
  const DeviceIcon = device?.mobile ? Smartphone : Monitor;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
      title="Talk with Relay Live"
      description="Real-time voice conversation that listens and speaks at the same time."
    >
      <div className={`vp ${blocked ? "vp-blocked" : ""}`}>
        <div className="vp-hero" aria-hidden="true">
          <span className={`vp-mic ${busy ? "vp-mic-busy" : ""}`}>
            {blocked ? <ShieldAlert size={30} /> : <Mic size={30} />}
          </span>
        </div>

        <ul className="vp-list">
          <li>
            <span className="vp-icon"><Mic size={18} /></span>
            <span className="vp-text">
              <strong>Microphone</strong>
              <span>So Relay can hear you and you can interrupt anytime</span>
            </span>
            <PermState status={status} />
          </li>
          <li>
            <span className="vp-icon"><Volume2 size={18} /></span>
            <span className="vp-text">
              <strong>Sound</strong>
              <span>Relay’s voice plays instantly — turn up your volume</span>
            </span>
            <PermState status={status === "granted" ? "granted" : status === "requesting" ? "requesting" : "idle"} />
          </li>
        </ul>

        {status === "insecure" && (
          <div className="vp-alert" role="alert">
            <div className="vp-alert-head">
              <AlertCircle size={17} />
              <strong>A secure connection is required</strong>
            </div>
            <p>
              Browsers only allow the microphone on <b>https://</b> pages or <b>localhost</b>. You’re
              on <code>{typeof location !== "undefined" ? location.origin : ""}</code>. Open Relay over
              HTTPS to use voice on this device.
            </p>
          </div>
        )}

        {status === "unsupported" && (
          <div className="vp-alert" role="alert">
            <div className="vp-alert-head">
              <AlertCircle size={17} />
              <strong>Voice isn’t supported here</strong>
            </div>
            <p>
              {errorDetail ||
                "This browser can’t capture audio. Try the latest Chrome, Edge, Safari, or Firefox."}
            </p>
          </div>
        )}

        {status === "denied" && (
          <div className="vp-alert" role="alert">
            <div className="vp-alert-head">
              <AlertCircle size={17} />
              <strong>Microphone is blocked</strong>
            </div>
            {errorDetail && <p>{errorDetail}</p>}
            {device && (
              <div className="vp-steps">
                <span className="vp-device">
                  <DeviceIcon size={14} /> {device.label}
                </span>
                <ol>
                  {steps.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
              </div>
            )}
          </div>
        )}

        <p className="vp-privacy">
          <Lock size={13} />
          The mic is only on while Live is open. Mute or end anytime.
        </p>

        <div className="dialog-actions vp-actions">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Not now
          </Button>
          {status !== "insecure" && status !== "unsupported" && (
            <Button type="button" className="vp-grant" onClick={handleGrant} disabled={busy}>
              {busy ? (
                <>
                  <LoaderCircle size={16} className="spin" />
                  <span>Waiting for permission…</span>
                </>
              ) : status === "denied" ? (
                "Try again"
              ) : (
                <>
                  <Mic size={16} />
                  <span>Allow microphone &amp; start</span>
                </>
              )}
            </Button>
          )}
        </div>
        {busy && (
          <p className="vp-tip">
            {device?.mobile
              ? "Tap “Allow” in the prompt that just appeared."
              : "Choose “Allow” in the prompt near your address bar."}
          </p>
        )}
      </div>
    </Dialog>
  );
}

function PermState({ status }: { status: Status }) {
  if (status === "granted")
    return (
      <span className="vp-state vp-ok" aria-label="Allowed">
        <Check size={14} />
      </span>
    );
  if (status === "requesting")
    return (
      <span className="vp-state" aria-label="Waiting">
        <LoaderCircle size={14} className="spin" />
      </span>
    );
  if (status === "denied" || status === "insecure" || status === "unsupported")
    return (
      <span className="vp-state vp-bad" aria-label="Blocked">
        <AlertCircle size={14} />
      </span>
    );
  return <span className="vp-state vp-need">Needed</span>;
}
