"use client";

import { getApi } from "./api";
import { DEFAULT_VOICE_LANGUAGE } from "./languages";

type LiveHandlers = {
  /** The provider session is open and the microphone is streaming. */
  onReady: () => void;
  onListening: (text: string, final: boolean) => void;
  onSpeaking: (text?: string) => void;
  onInterrupted: () => void;
  /** Gemini finished generating a turn (audio may still be playing). */
  onTurnComplete: () => void;
  /** Every queued reply chunk has finished playing. */
  onPlaybackIdle?: () => void;
  /** Smoothed microphone and assistant output levels, 0–1, ~30 fps. */
  onLevel: (level: number, output: number) => void;
  onReconnecting?: (attempt: number) => void;
  /** Live minutes left for this session/day, sent when the session opens. */
  onBudget?: (remainingSeconds: number) => void;
  /** A spoken exchange was saved to the conversation history. */
  onSaved?: () => void;
  onError: (message: string) => void;
};

const INPUT_RATE = 16000;
const OUTPUT_RATE = 24000;
const MAX_RECONNECTS = 3;
// Server close codes that must not be retried: unauthorized, forbidden,
// replaced by a newer session, usage limit reached, provider failure.
const FATAL_CLOSE: Record<number, string> = {
  4401: "Please sign in again to use Live voice.",
  4403: "Live voice is not available on this server.",
  4409: "Live voice moved to another tab or device.",
  4429: "You've reached the Live voice limit for now.",
  1011: "Real-time Gemini voice is unavailable.",
};
// Local barge-in: when the user clearly talks over the assistant, duck the
// reply immediately instead of waiting a network round trip for Gemini's
// "interrupted" event.
const BARGE_IN_LEVEL = 0.32;
const BARGE_IN_MS = 140;
const DUCKED_GAIN = 0.18;
// Echo gate: while the assistant is talking, forward the microphone only when
// the user is clearly speaking. Otherwise the assistant's own voice leaking
// from the speakers is sent back, mis-transcribed (often as another language)
// and answered. Silence is sent instead to keep the stream continuous, and a
// short pre-roll keeps the first syllable once the gate opens.
const ECHO_GATE_LEVEL = 0.22;
const ECHO_GATE_HOLD_MS = 700;
const PREROLL_FRAMES = 12; // ~240 ms of 20 ms frames

/* ---------- iOS/Safari audio unlock ----------
 * Mobile browsers only allow audio playback from an AudioContext that was
 * created or resumed synchronously inside a user gesture. Callers invoke
 * unlockAudio() at the very top of a click handler, before any await, and the
 * live session then adopts that already-running context. */
let primed: AudioContext | null = null;

export function unlockAudio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  try {
    // iOS 16.4+: keep playback on the loud speaker while the mic is open.
    const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
    if (session) session.type = "play-and-record";
  } catch {}
  if (!primed || primed.state === "closed") {
    primed = new Ctx({ latencyHint: "interactive" }) as AudioContext;
  }
  const ctx = primed;
  void ctx.resume().catch(() => {});
  try {
    // A one-sample silent buffer fully unlocks output on older iOS versions.
    const silent = ctx.createBuffer(1, 1, ctx.sampleRate);
    const src = ctx.createBufferSource();
    src.buffer = silent;
    src.connect(ctx.destination);
    src.start(0);
  } catch {}
  return ctx;
}

function takeContext(): AudioContext {
  const ctx = primed && primed.state !== "closed" ? primed : unlockAudio();
  primed = null;
  if (!ctx) throw new Error("Web Audio is not supported in this browser.");
  return ctx;
}

function socketUrl(cid: string, greet: boolean, language: string) {
  const base = getApi();
  const url = base ? new URL(base) : new URL(window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/ai/live/${encodeURIComponent(cid)}`;
  url.search = "";
  url.searchParams.set("lang", language);
  if (!greet) url.searchParams.set("greet", "0");
  return url.toString();
}

/** Downsample float audio to 16 kHz little-endian PCM16 with box filtering. */
export function pcm16(input: Float32Array, sourceRate: number, targetRate = INPUT_RATE) {
  const ratio = sourceRate / targetRate;
  const length = Math.max(1, Math.round(input.length / ratio));
  const output = new Int16Array(length);
  for (let i = 0; i < length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.max(start + 1, Math.floor((i + 1) * ratio)));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    const sample = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)));
    output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output.buffer;
}

/* AudioWorklet capture: runs on the audio thread, resamples to 16 kHz and
 * posts ~20 ms PCM16 frames plus an RMS level, so mic streaming never stalls
 * when React is busy rendering. Inlined so no extra static asset is needed. */
const WORKLET = `
class RelayCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / ${INPUT_RATE};
    this.frame = new Int16Array(${INPUT_RATE / 50});
    this.fill = 0;
    this.pos = 0;
    this.acc = 0;
    this.count = 0;
    this.energy = 0;
    this.samples = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      const v = ch[i];
      this.energy += v * v;
      this.samples++;
      this.acc += v;
      this.count++;
      this.pos += 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        let s = this.acc / this.count;
        this.acc = 0;
        this.count = 0;
        s = s < -1 ? -1 : s > 1 ? 1 : s;
        this.frame[this.fill++] = s < 0 ? s * 0x8000 : s * 0x7fff;
        if (this.fill === this.frame.length) {
          const level = Math.sqrt(this.energy / Math.max(1, this.samples));
          this.energy = 0;
          this.samples = 0;
          const out = this.frame.slice(0);
          this.port.postMessage({ pcm: out.buffer, level }, [out.buffer]);
          this.fill = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor("relay-capture", RelayCapture);
`;

type WakeLock = { release: () => Promise<void> };

export class GeminiLiveVoice {
  private ws: WebSocket | null = null;
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private capture: AudioWorkletNode | ScriptProcessorNode | null = null;
  private sink: GainNode | null = null;
  private playbackGain: GainNode | null = null;
  private duckGain: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private analyserData: Float32Array<ArrayBuffer> | null = null;
  private volume = 0.8;
  private nextPlayback = 0;
  private playbackSources = new Set<AudioBufferSourceNode>();
  private muted = false;
  private stopped = true;
  private cid = "";
  private reconnects = 0;
  private micLevel = 0;
  private outLevel = 0;
  private loudSince = 0;
  private ducked = false;
  private generating = false;
  private raf = 0;
  private lastEmit = 0;
  private emitted: [number, number] = [0, 0];
  private wakeLock: WakeLock | null = null;
  private language: string = DEFAULT_VOICE_LANGUAGE;
  private failed = false;
  private preroll: ArrayBuffer[] = [];
  private gateOpenUntil = 0;
  private silence = new Map<number, ArrayBuffer>();

  constructor(private handlers: LiveHandlers) {}

  /** Call from a user gesture (after unlockAudio()) to begin a live session. */
  async start(cid: string, language: string = DEFAULT_VOICE_LANGUAGE) {
    this.stop();
    this.stopped = false;
    this.failed = false;
    this.cid = cid;
    this.language = language;
    this.reconnects = 0;
    this.context = takeContext();
    void this.context.resume().catch(() => {});

    const ctx = this.context;
    this.playbackGain = ctx.createGain();
    this.playbackGain.gain.value = this.volume;
    this.duckGain = ctx.createGain();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyserData = new Float32Array(this.analyser.fftSize);
    this.playbackGain.connect(this.duckGain);
    this.duckGain.connect(this.analyser);
    this.analyser.connect(ctx.destination);

    // Open the network path while the browser negotiates the microphone so
    // the two slowest start-up steps overlap instead of running back to back.
    this.connect(true);
    const workletReady = this.loadWorklet(ctx);
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
    } catch (error) {
      this.stop();
      throw error;
    }
    if (this.stopped) {
      for (const t of this.stream.getTracks()) t.stop();
      return;
    }
    await this.startCapture(ctx, await workletReady);
    this.tick();
    void this.keepAwake();
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  private async loadWorklet(ctx: AudioContext) {
    if (!ctx.audioWorklet || typeof AudioWorkletNode === "undefined") return false;
    try {
      const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      return true;
    } catch {
      return false;
    }
  }

  private async startCapture(ctx: AudioContext, worklet: boolean) {
    if (!this.stream) return;
    this.source = ctx.createMediaStreamSource(this.stream);
    this.sink = ctx.createGain();
    this.sink.gain.value = 0;
    this.sink.connect(ctx.destination);

    if (worklet) {
      const node = new AudioWorkletNode(ctx, "relay-capture", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
      });
      node.port.onmessage = (event: MessageEvent<{ pcm: ArrayBuffer; level: number }>) =>
        this.onFrame(event.data.pcm, event.data.level);
      this.capture = node;
    } else {
      // Fallback for older browsers without AudioWorklet support.
      const node = ctx.createScriptProcessor(1024, 1, 1);
      node.onaudioprocess = (event) => {
        const samples = event.inputBuffer.getChannelData(0);
        let sum = 0;
        for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
        this.onFrame(pcm16(samples, event.inputBuffer.sampleRate), Math.sqrt(sum / samples.length));
      };
      this.capture = node;
    }
    this.source.connect(this.capture);
    this.capture.connect(this.sink);
  }

  private onFrame(pcm: ArrayBuffer, rms: number) {
    if (this.muted) return;
    const level = Math.min(1, rms * 5);
    this.micLevel = Math.max(level, this.micLevel * 0.82);
    this.detectBargeIn(level);
    const ws = this.ws;
    const open = ws?.readyState === WebSocket.OPEN;

    if (!this.playbackSources.size) {
      // Assistant is quiet: stream the microphone untouched.
      this.preroll.length = 0;
      this.gateOpenUntil = 0;
      if (open) ws!.send(pcm);
      return;
    }
    const now = performance.now();
    if (level >= ECHO_GATE_LEVEL) {
      if (now > this.gateOpenUntil && open) {
        for (const frame of this.preroll) ws!.send(frame);
      }
      this.preroll.length = 0;
      this.gateOpenUntil = now + ECHO_GATE_HOLD_MS;
    }
    if (now <= this.gateOpenUntil) {
      if (open) ws!.send(pcm);
      return;
    }
    this.preroll.push(pcm);
    if (this.preroll.length > PREROLL_FRAMES) this.preroll.shift();
    if (open) ws!.send(this.silent(pcm.byteLength));
  }

  private silent(bytes: number) {
    let buffer = this.silence.get(bytes);
    if (!buffer) {
      buffer = new ArrayBuffer(bytes);
      this.silence.set(bytes, buffer);
    }
    return buffer;
  }

  /** Switch conversation language; reconnects immediately without a greeting. */
  setLanguage(language: string) {
    if (language === this.language) return;
    this.language = language;
    if (this.stopped || !this.cid) return;
    this.clearPlayback();
    const old = this.ws;
    this.ws = null;
    if (old) {
      old.onclose = null;
      old.onmessage = null;
      if (old.readyState === WebSocket.OPEN) old.close(1000);
      else if (old.readyState === WebSocket.CONNECTING) old.onopen = () => old.close(1000);
    }
    this.reconnects = 0;
    this.connect(false);
  }

  private detectBargeIn(level: number) {
    const playing = this.playbackSources.size > 0;
    if (!playing) {
      this.loudSince = 0;
      return;
    }
    const now = performance.now();
    if (level >= BARGE_IN_LEVEL) {
      if (!this.loudSince) this.loudSince = now;
      else if (!this.ducked && now - this.loudSince >= BARGE_IN_MS) this.duck(true);
    } else if (now - this.loudSince > 600) {
      this.loudSince = 0;
      if (this.ducked) this.duck(false);
    }
  }

  private duck(on: boolean) {
    this.ducked = on;
    if (!this.duckGain || !this.context) return;
    this.duckGain.gain.setTargetAtTime(on ? DUCKED_GAIN : 1, this.context.currentTime, on ? 0.01 : 0.08);
  }

  private connect(greet: boolean) {
    const ws = new WebSocket(socketUrl(this.cid, greet, this.language));
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      if (event.data instanceof ArrayBuffer) {
        this.play(event.data);
        return;
      }
      const data = JSON.parse(String(event.data));
      switch (data.type) {
        case "ready":
          this.reconnects = 0;
          this.handlers.onReady();
          if (typeof data.remaining_seconds === "number") this.handlers.onBudget?.(data.remaining_seconds);
          break;
        case "saved":
          this.handlers.onSaved?.();
          break;
        case "input_interim":
          this.handlers.onListening(data.text, false);
          break;
        case "input_transcript":
          this.handlers.onListening(data.text, true);
          break;
        case "output_transcript":
          this.generating = true;
          this.handlers.onSpeaking(data.text);
          break;
        case "interrupted":
          this.generating = false;
          this.clearPlayback();
          this.handlers.onInterrupted();
          break;
        case "turn_complete":
          this.generating = false;
          this.handlers.onTurnComplete();
          if (!this.playbackSources.size) this.handlers.onPlaybackIdle?.();
          break;
        case "go_away":
          this.reconnect();
          break;
        case "error":
          this.failed = true;
          this.handlers.onError(data.message);
          break;
      }
    };
    ws.onclose = (event) => {
      if (this.ws !== ws || this.stopped) return;
      // Auth, limit and takeover closes cannot be fixed by retrying. The server
      // usually sent a precise "error" message first; don't overwrite it.
      if (this.failed || event.code in FATAL_CLOSE) {
        if (!this.failed) this.handlers.onError(FATAL_CLOSE[event.code]);
        this.failed = true;
        return;
      }
      this.reconnect();
    };
  }

  private reconnect() {
    if (this.stopped) return;
    if (this.reconnects >= MAX_RECONNECTS) {
      this.handlers.onError("The real-time voice connection was lost.");
      return;
    }
    this.reconnects += 1;
    const old = this.ws;
    this.ws = null;
    if (old && old.readyState <= WebSocket.OPEN) {
      old.onclose = null;
      try { old.close(1000); } catch {}
    }
    this.handlers.onReconnecting?.(this.reconnects);
    const delay = 250 * 2 ** (this.reconnects - 1);
    window.setTimeout(() => !this.stopped && this.connect(false), delay);
  }

  /** Publishes mic and output levels on animation frames, not per audio chunk. */
  private tick = () => {
    if (this.stopped) return;
    if (this.analyser && this.analyserData) {
      this.analyser.getFloatTimeDomainData(this.analyserData);
      let sum = 0;
      for (let i = 0; i < this.analyserData.length; i++) sum += this.analyserData[i] ** 2;
      const rms = Math.min(1, Math.sqrt(sum / this.analyserData.length) * 4);
      this.outLevel = Math.max(rms, this.outLevel * 0.85);
    }
    this.micLevel *= 0.92;
    // ~20 fps and only on visible change: the levels drive React state, and a
    // 60 fps re-render of the whole chat view is costly on phones.
    const now = performance.now();
    const mic = this.muted ? 0 : this.micLevel;
    if (
      now - this.lastEmit >= 50 &&
      (Math.abs(mic - this.emitted[0]) > 0.015 || Math.abs(this.outLevel - this.emitted[1]) > 0.015)
    ) {
      this.lastEmit = now;
      this.emitted = [mic < 0.01 ? 0 : mic, this.outLevel < 0.01 ? 0 : this.outLevel];
      this.handlers.onLevel(this.emitted[0], this.emitted[1]);
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  private onVisibility = () => {
    if (document.visibilityState !== "visible" || this.stopped) return;
    void this.context?.resume().catch(() => {});
    void this.keepAwake();
  };

  private async keepAwake() {
    try {
      const nav = navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<WakeLock> } };
      if (nav.wakeLock && !this.wakeLock) {
        this.wakeLock = await nav.wakeLock.request("screen");
        (this.wakeLock as unknown as EventTarget).addEventListener?.("release", () => {
          this.wakeLock = null;
        });
      }
    } catch {}
  }

  setMuted(value: boolean) {
    this.muted = value;
    for (const track of this.stream?.getAudioTracks() || []) track.enabled = !value;
    if (value && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "mute" }));
    }
  }

  setVolume(value: number) {
    this.volume = Math.max(0, Math.min(1, value));
    if (this.playbackGain && this.context) {
      this.playbackGain.gain.setTargetAtTime(this.volume, this.context.currentTime, 0.015);
    }
  }

  get speaking() {
    return this.playbackSources.size > 0 || this.generating;
  }

  private play(bytes: ArrayBuffer) {
    const context = this.context;
    if (!context || !this.playbackGain) return;
    const pcm = new Int16Array(bytes);
    if (!pcm.length) return;
    const buffer = context.createBuffer(1, pcm.length, OUTPUT_RATE);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 32768;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.playbackGain);
    // A small lead on the first chunk absorbs network jitter; later chunks
    // are scheduled back to back for gapless speech.
    const lead = this.playbackSources.size ? 0.005 : 0.04;
    const start = Math.max(context.currentTime + lead, this.nextPlayback);
    source.start(start);
    this.nextPlayback = start + buffer.duration;
    this.playbackSources.add(source);
    this.generating = true;
    source.onended = () => {
      this.playbackSources.delete(source);
      if (!this.playbackSources.size) {
        if (this.ducked) this.duck(false);
        if (!this.generating) this.handlers.onPlaybackIdle?.();
      }
    };
    this.handlers.onSpeaking();
  }

  clearPlayback() {
    for (const source of this.playbackSources) {
      source.onended = null;
      try { source.stop(); } catch {}
    }
    this.playbackSources.clear();
    this.nextPlayback = this.context?.currentTime || 0;
    if (this.ducked) this.duck(false);
  }

  stop() {
    this.stopped = true;
    this.clearPlayback();
    cancelAnimationFrame(this.raf);
    document.removeEventListener("visibilitychange", this.onVisibility);
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.onmessage = null;
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "close" }));
        ws.close(1000);
      } else if (ws.readyState === WebSocket.CONNECTING) {
        ws.onopen = () => ws.close(1000);
      }
    }
    if (this.capture instanceof AudioWorkletNode) this.capture.port.onmessage = null;
    this.capture?.disconnect();
    this.source?.disconnect();
    this.sink?.disconnect();
    this.playbackGain?.disconnect();
    this.duckGain?.disconnect();
    this.analyser?.disconnect();
    this.capture = null;
    this.source = null;
    this.sink = null;
    this.playbackGain = null;
    this.duckGain = null;
    this.analyser = null;
    for (const track of this.stream?.getTracks() || []) track.stop();
    this.stream = null;
    void this.context?.close().catch(() => {});
    this.context = null;
    void this.wakeLock?.release().catch(() => {});
    this.wakeLock = null;
    this.muted = false;
    this.ducked = false;
    this.generating = false;
    this.micLevel = 0;
    this.outLevel = 0;
    this.emitted = [0, 0];
    this.preroll.length = 0;
    this.gateOpenUntil = 0;
  }
}
