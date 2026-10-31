export const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
let csrf = "";
export function setCsrf(value: string) {
  csrf = value;
}
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(API + path, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrf,
      ...init.headers,
    },
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new ApiError(
      data?.error?.message || "Connection failed. Please try again.",
      response.status,
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json();
}
export function mutate<T>(path: string, body: unknown, method = "POST") {
  return api<T>(path, { method, body: JSON.stringify(body) });
}
let speechAudio: HTMLAudioElement | null = null;
let speechRequest: AbortController | null = null;
export function cancelAISpeech() {
  speechRequest?.abort();
  speechRequest = null;
  speechAudio?.pause();
  speechAudio = null;
}
export async function speakAI(text: string) {
  speechRequest = new AbortController();
  const response = await fetch(API + "/ai/speech", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
    body: JSON.stringify({ text }),
    signal: speechRequest.signal,
  });
  if (!response.ok) throw new Error("Relay could not generate speech.");
  const url = URL.createObjectURL(await response.blob());
  const audio = new Audio(url);
  speechAudio = audio;
  await new Promise<void>((resolve, reject) => {
    audio.onended = () => resolve();
    audio.onerror = () => reject(new Error("Speech playback failed."));
    void audio.play().catch(reject);
  }).finally(() => {
    URL.revokeObjectURL(url);
    if (speechAudio === audio) speechAudio = null;
    speechRequest = null;
  });
}
export function upload(
  cid: string,
  file: File,
  onProgress: (n: number) => void,
): Promise<{ id: string; filename: string; status: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", API + `/conversations/${cid}/attachments`);
    xhr.withCredentials = true;
    xhr.setRequestHeader("X-CSRF-Token", csrf);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable)
        onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      let data;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        reject(new Error("Upload failed."));
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data?.error?.message || "Upload failed."));
    };
    xhr.onerror = () =>
      reject(new Error("Upload interrupted. Please try again."));
    const form = new FormData();
    form.append("file", file);
    xhr.send(form);
  });
}
export async function streamAI(
  cid: string,
  body: unknown,
  onEvent: (type: string, data: Record<string, unknown>) => void,
  signal: AbortSignal,
) {
  const response = await fetch(API + `/conversations/${cid}/ai/stream`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const data = await response.json();
    throw new Error(data.error?.message || "AI unavailable.");
  }
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let i;
    while ((i = buffer.indexOf("\n\n")) !== -1) {
      const event = buffer.slice(0, i);
      buffer = buffer.slice(i + 2);
      const type = event.match(/^event: (.+)$/m)?.[1];
      const data = event.match(/^data: (.+)$/m)?.[1];
      if (type && data) onEvent(type, JSON.parse(data));
    }
  }
}
