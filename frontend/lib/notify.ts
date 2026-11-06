"use client";
/** Browser notifications and a short chime for incoming messages. */

export type NotifyPrefs = { desktop: boolean; sound: boolean };
const KEY = "relay_notify_prefs";

export function getNotifyPrefs(): NotifyPrefs {
  try {
    const saved = JSON.parse(window.localStorage.getItem(KEY) || "null");
    if (saved && typeof saved === "object") {
      return { desktop: !!saved.desktop, sound: saved.sound !== false };
    }
  } catch {}
  return { desktop: false, sound: true };
}

export function setNotifyPrefs(prefs: NotifyPrefs) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {}
}

export function notificationsSupported() {
  return typeof window !== "undefined" && "Notification" in window && window.isSecureContext;
}

/** Ask for permission; resolves to whether desktop notifications can be shown. */
export async function enableDesktopNotifications(): Promise<boolean> {
  if (!notificationsSupported()) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  return (await Notification.requestPermission()) === "granted";
}

let chimeContext: AudioContext | null = null;
let lastChime = 0;

/** Two soft tones; rate-limited so a burst of messages makes one sound. */
export function playChime() {
  const now = Date.now();
  if (now - lastChime < 1500) return;
  lastChime = now;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    chimeContext = chimeContext && chimeContext.state !== "closed" ? chimeContext : new Ctx();
    const ctx = chimeContext;
    void ctx.resume().catch(() => {});
    [880, 1318.5].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const start = ctx.currentTime + i * 0.12;
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.12, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.4);
    });
  } catch {}
}

/**
 * Notify about a new message. Shows a system notification only when the tab
 * is hidden (in-app toasts cover the visible case); plays the chime either way.
 */
export function notifyMessage(opts: {
  title: string;
  body: string;
  tag: string;
  onClick: () => void;
}) {
  const prefs = getNotifyPrefs();
  if (prefs.sound) playChime();
  if (!prefs.desktop || !notificationsSupported() || Notification.permission !== "granted") return;
  if (document.visibilityState === "visible" && document.hasFocus()) return;
  try {
    const n = new Notification(opts.title, {
      body: opts.body.length > 140 ? opts.body.slice(0, 139) + "…" : opts.body,
      tag: opts.tag,
    });
    n.onclick = () => {
      window.focus();
      opts.onClick();
      n.close();
    };
  } catch {
    // Some mobile browsers only allow notifications from a service worker.
  }
}
