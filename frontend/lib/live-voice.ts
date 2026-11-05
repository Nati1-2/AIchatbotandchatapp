"use client";

import { getApi } from "./api";

type LiveHandlers = {
  onReady: () => void;
  onListening: (text: string, final: boolean) => void;
  onSpeaking: (text?: string) => void;
  onInterrupted: () => void;
  onTurnComplete: () => void;
  onLevel: (level: number) => void;
  onError: (message: string) => void;
};

function socketUrl(cid: string) {
  const base = getApi();
  const url = base ? new URL(base) : new URL(window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/ai/live/${encodeURIComponent(cid)}`;
  url.search = "";
  return url.toString();
}

function pcm16(input: Float32Array, sourceRate: number, targetRate = 16000) {
  const ratio = sourceRate / targetRate;
  const length = Math.max(1, Math.round(input.length / ratio));
  const output = new Int16Array(length);
  for (let i = 0; i < length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    const sample = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)));
    output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output.buffer;
}

export class GeminiLiveVoice {
  private ws: WebSocket | null = null;
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private sink: GainNode | null = null;
  private nextPlayback = 0;
  private playbackSources = new Set<AudioBufferSourceNode>();
  private muted = false;

  constructor(private handlers: LiveHandlers) {}

  async start(cid: string) {
    this.stop();
    this.context = new AudioContext({ latencyHint: "interactive" });
    await this.context.resume();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.ws = new WebSocket(socketUrl(cid));
    this.ws.binaryType = "arraybuffer";
    this.ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        this.play(event.data);
        return;
      }
      const data = JSON.parse(String(event.data));
      if (data.type === "ready") this.handlers.onReady();
      else if (data.type === "input_interim") this.handlers.onListening(data.text, false);
      else if (data.type === "input_transcript") this.handlers.onListening(data.text, true);
      else if (data.type === "output_transcript") this.handlers.onSpeaking(data.text);
      else if (data.type === "interrupted") {
        this.clearPlayback();
        this.handlers.onInterrupted();
      } else if (data.type === "turn_complete") this.handlers.onTurnComplete();
      else if (data.type === "error") this.handlers.onError(data.message);
    };
    this.ws.onerror = () => this.handlers.onError("Could not connect to Gemini Live.");
    this.ws.onclose = (event) => {
      if (event.code !== 1000) this.handlers.onError("The real-time voice connection closed.");
    };

    this.source = this.context.createMediaStreamSource(this.stream);
    // ScriptProcessor remains the broadest mobile-compatible way to obtain
    // small PCM chunks without shipping a second worklet resource.
    this.processor = this.context.createScriptProcessor(2048, 1, 1);
    this.sink = this.context.createGain();
    this.sink.gain.value = 0;
    this.processor.onaudioprocess = (event) => {
      if (this.muted || this.ws?.readyState !== WebSocket.OPEN) return;
      const samples = event.inputBuffer.getChannelData(0);
      let sum = 0;
      for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
      this.handlers.onLevel(Math.min(1, Math.sqrt(sum / samples.length) * 5));
      this.ws.send(pcm16(samples, event.inputBuffer.sampleRate));
    };
    this.source.connect(this.processor);
    this.processor.connect(this.sink);
    this.sink.connect(this.context.destination);
  }

  setMuted(value: boolean) {
    this.muted = value;
    for (const track of this.stream?.getAudioTracks() || []) track.enabled = !value;
    if (value && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "mute" }));
    }
  }

  private play(bytes: ArrayBuffer) {
    const context = this.context;
    if (!context) return;
    const pcm = new Int16Array(bytes);
    const buffer = context.createBuffer(1, pcm.length, 24000);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 32768;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const start = Math.max(context.currentTime + 0.02, this.nextPlayback);
    source.start(start);
    this.nextPlayback = start + buffer.duration;
    this.playbackSources.add(source);
    source.onended = () => this.playbackSources.delete(source);
    this.handlers.onSpeaking();
  }

  clearPlayback() {
    for (const source of this.playbackSources) {
      try { source.stop(); } catch {}
    }
    this.playbackSources.clear();
    this.nextPlayback = this.context?.currentTime || 0;
  }

  stop() {
    this.clearPlayback();
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "close" }));
      this.ws.close(1000);
    }
    this.ws = null;
    this.processor?.disconnect();
    this.source?.disconnect();
    this.sink?.disconnect();
    this.processor = null;
    this.source = null;
    this.sink = null;
    for (const track of this.stream?.getTracks() || []) track.stop();
    this.stream = null;
    void this.context?.close().catch(() => {});
    this.context = null;
    this.muted = false;
  }
}
