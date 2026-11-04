"use client";
import { useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Search,
  MoreHorizontal,
  Paperclip,
  Smile,
  Send,
  Check,
  CheckCheck,
  Clock,
  RotateCcw,
  Reply,
  Copy,
  Trash2,
  Pencil,
  X,
  Square,
  ArrowUpRight,
  ChevronDown,
  FileText,
  LoaderCircle,
  CheckSquare,
  Mic,
  AudioLines,
  Volume2,
  Sparkles,
} from "lucide-react";
import {
  useSpeechRecognition,
  useMicLevel,
  speak,
  cancelSpeech,
  createSpeaker,
  speechSupported,
  speakGreeting,
  checkVoicePermissions,
} from "@/lib/voice";
import { VoiceLive, type VoiceState } from "./voice-live";
import { VoicePermissionsDialog } from "./voice-permissions-dialog";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { api, mutate, upload, streamAI, API } from "@/lib/api";
import { mergeMessages } from "@/lib/messages";
import type { Conversation, History, Message, User } from "@/lib/types";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { Details } from "./details";
function CodeBlock({
  children,
  ...props
}: React.HTMLAttributes<HTMLPreElement>) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  return (
    <div className="code-block">
      <button
        aria-label="Copy code"
        onClick={() => {
          void navigator.clipboard
            .writeText(ref.current?.textContent || "")
            .then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
        }}
      >
        {copied ? "Copied" : "Copy code"}
      </button>
      <pre ref={ref} {...props}>
        {children}
      </pre>
    </div>
  );
}
function Markdown({ body }: { body: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight]}
      components={{
        pre: CodeBlock,
        a: ({ children, ...props }) => (
          <a {...props} target="_blank" rel="noreferrer noopener">
            {children}
          </a>
        ),
        img: ({ alt }) => <span>[External image: {alt || "image"}]</span>,
      }}
    >
      {body}
    </ReactMarkdown>
  );
}
export function Chat({
  conversation: c,
  user,
  aiConfigured,
  connection,
  typing,
  onBack,
  onTyping,
  onOpenAI,
}: {
  conversation: Conversation;
  user: User;
  aiConfigured: boolean;
  connection: string;
  typing?: string;
  onBack: () => void;
  onTyping: () => void;
  onOpenAI: (activate?: boolean) => Promise<string>;
}) {
  const qc = useQueryClient();
  const [body, setBody] = useState("");
  const [pending, setPending] = useState<Message[]>([]);
  const [reply, setReply] = useState<Message | null>(null);
  const [edit, setEdit] = useState<Message | null>(null);
  const [error, setError] = useState("");
  const [details, setDetails] = useState(false);
  const [emoji, setEmoji] = useState(false);
  const [reactionTarget, setReactionTarget] = useState<Message | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [summary, setSummary] = useState(false);
  const [summarizing, setSummarizing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<Message | null>(null);
  const [uploadState, setUploadState] = useState<{
    name: string;
    progress: number;
    id?: string;
    ready: boolean;
  } | null>(null);
  const [stream, setStream] = useState<string | null>(null);
  const [generation, setGeneration] = useState<string | null>(null);
  const [retryPrompt, setRetryPrompt] = useState<{
    body: string;
    client_id: string;
  } | null>(null);
  // Voice: dictation into the composer, or a hands-free AI conversation ("voice mode").
  const [voice, setVoice] = useState<VoiceState>("off");
  const [permissionDialog, setPermissionDialog] = useState(false);
  const [permissionsGranted, setPermissionsGranted] = useState(false);
  const pendingVoiceAction = useRef<"live" | "dictate" | null>(null);
  const voiceRef = useRef<VoiceState>("off");
  voiceRef.current = voice;
  const [heard, setHeard] = useState("");
  const [caption, setCaption] = useState("");
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const voiceOn = useRef(false);
  const held = useRef(false);
  const interrupted = useRef(false);
  const speaker = useRef<ReturnType<typeof createSpeaker> | null>(null);
  const micLevel = useMicLevel(voice === "listening");
  const dictationBase = useRef("");
  const streamed = useRef("");
  const recognition = useSpeechRecognition({
    onResult: (text) => {
      if (voiceOn.current) setHeard(text);
      else setBody((dictationBase.current + " " + text).trim());
    },
    onEnd: (finalText) => {
      if (!voiceOn.current || held.current) return;
      if (finalText) void voiceTurn(finalText);
      else recognition.start(); // heard nothing: keep listening
    },
    onUserSpeaking: () => {
      if (
        voiceOn.current &&
        !held.current &&
        (voiceRef.current === "speaking" || voiceRef.current === "thinking")
      ) {
        interruptSpeech();
      }
    },
    onError: (code) => {
      if (code === "no-speech" || code === "aborted") return;
      endVoice();
      setError(
        code === "not-allowed" || code === "service-not-allowed"
          ? "Microphone access is blocked. Allow it in your browser to use voice."
          : code === "microphone-failed"
            ? "Could not start the microphone. Please try again."
            : code,
      );
    },
  });
  const abort = useRef<AbortController | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const lastTyped = useRef(0);
  const viewport = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const ai = c.kind === "ai";
  const history = useInfiniteQuery({
    queryKey: ["messages", c.id],
    queryFn: ({ pageParam }) =>
      api<History>(
        `/conversations/${c.id}/messages${pageParam ? "?before=" + pageParam : ""}`,
      ),
    initialPageParam: 0,
    getNextPageParam: (last) =>
      last.has_more ? (last.next_cursor ?? undefined) : undefined,
    refetchInterval: 15000,
  });
  const messages = mergeMessages(
    ...(history.data?.pages.map((p) => p.items) || []),
    pending,
  );
  const latest = messages.filter((m) => !m.status).at(-1)?.seq || 0;
  useEffect(() => {
    if (stick.current) bottom.current?.scrollIntoView({ behavior: "instant" });
  }, [messages.length, stream, typing]);
  useEffect(() => {
    if (!latest) return;
    function receipt() {
      void mutate(`/conversations/${c.id}/receipts`, {
        seq: latest,
        read: document.visibilityState === "visible",
      })
        .then(() => qc.invalidateQueries({ queryKey: ["conversations"] }))
        .catch(() => {});
    }
    receipt();
    document.addEventListener("visibilitychange", receipt);
    return () => document.removeEventListener("visibilitychange", receipt);
  }, [latest, c.id, qc]);
  useEffect(
    () => () => {
      abort.current?.abort();
    },
    [],
  );
  async function sendMessage(message?: Message) {
    const text = message?.body ?? body.trim();
    if (!text && !uploadState?.id) return;
    if (ai && !aiConfigured) {
      setError("Set AI_API_KEY on the server to enable Relay AI.");
      return;
    }
    setError("");
    if (edit) {
      try {
        await mutate("/messages/" + edit.id, { body: text }, "PATCH");
        setEdit(null);
        setBody("");
        await history.refetch();
      } catch (e) {
        setError((e as Error).message);
      }
      return;
    }
    if (ai) {
      await askAI({ body: text, client_id: crypto.randomUUID() });
      return;
    }
    const optimistic: Message = message || {
      id: crypto.randomUUID(),
      seq: Number.MAX_SAFE_INTEGER,
      client_id: crypto.randomUUID(),
      conversation_id: c.id,
      sender_id: user.id,
      sender_name: user.display_name,
      body: text,
      reply_id: reply?.id || null,
      created_at: new Date().toISOString(),
      edited: false,
      deleted: false,
      reactions: [],
      attachments: [],
      status: "pending",
    };
    setPending((old) => [
      ...old.filter((m) => m.client_id !== optimistic.client_id),
      { ...optimistic, status: "pending" },
    ]);
    if (!message) {
      setBody("");
      setReply(null);
    }
    stick.current = true;
    try {
      await mutate<Message>(`/conversations/${c.id}/messages`, {
        client_id: optimistic.client_id,
        body: text,
        reply_id: optimistic.reply_id,
        attachment_ids: uploadState?.id ? [uploadState.id] : [],
      });
      await history.refetch();
      setPending((old) =>
        old.filter((m) => m.client_id !== optimistic.client_id),
      );
      setUploadState(null);
      void qc.invalidateQueries({ queryKey: ["conversations"] });
    } catch (e) {
      setPending((old) =>
        old.map((m) =>
          m.client_id === optimistic.client_id ? { ...m, status: "failed" } : m,
        ),
      );
      setError((e as Error).message);
    }
  }
  async function askAI(
    prompt: { body: string; client_id: string; voice?: boolean },
    onDelta?: (text: string) => void,
  ) {
    setBody("");
    setError("");
    setRetryPrompt(prompt);
    setStream("");
    streamed.current = "";
    stick.current = true;
    abort.current = new AbortController();
    try {
      await streamAI(
        c.id,
        prompt,
        (type, data) => {
          if (type === "start") {
            setGeneration(String(data.generation_id));
            void history.refetch();
          }
          if (type === "delta") {
            streamed.current += String(data.text);
            setStream((old) => (old || "") + data.text);
            onDelta?.(String(data.text));
          }
          if (type === "error") {
            streamed.current = "";
            setError(String(data.message));
          }
          if (type === "done") setRetryPrompt(null);
        },
        abort.current.signal,
      );
    } catch (e) {
      streamed.current = "";
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    } finally {
      setStream(null);
      setGeneration(null);
      await history.refetch();
      void qc.invalidateQueries({ queryKey: ["conversations"] });
    }
    return streamed.current;
  }
  async function stop() {
    if (generation) await mutate(`/ai/generations/${generation}/stop`, {});
    abort.current?.abort();
  }
  // Voice mode: listen → send on pause → speak the reply as it streams → listen again.
  async function voiceTurn(text: string) {
    setVoice("thinking");
    setCaption("");
    const out = createSpeaker();
    speaker.current = out;
    const answer = await askAI(
      { body: text, client_id: crypto.randomUUID(), voice: true },
      (delta) => {
        out.push(delta);
        setCaption((old) => old + delta);
        setVoice((v) => {
          if (v === "thinking") {
            if (voiceOn.current && !held.current && !recognition.listening) {
              recognition.start();
            }
            return "speaking";
          }
          return v;
        });
      },
    );
    if (interrupted.current) {
      interrupted.current = false;
      out.cancel();
      if (voiceOn.current && !held.current) listen();
      return;
    }
    if (!voiceOn.current || held.current) return out.cancel();
    if (!answer) {
      out.cancel();
      return endVoice(); // the error is already shown
    }
    setVoice("speaking");
    if (voiceOn.current && !held.current && !recognition.listening) {
      recognition.start();
    }
    await out.finish();
    if (speaker.current === out) speaker.current = null;
    if (voiceOn.current && !held.current) listen();
  }
  function listen() {
    setHeard("");
    setVoice("listening");
    recognition.start();
  }
  async function startVoice() {
    if (!aiConfigured) {
      setError("Set AI_API_KEY on the server to enable Relay AI.");
      return;
    }
    if (!permissionsGranted) {
      const perm = await checkVoicePermissions();
      if (!perm.allGranted) {
        pendingVoiceAction.current = "live";
        setPermissionDialog(true);
        return;
      }
      setPermissionsGranted(true);
    }
    await executeStartVoice();
  }

  function handlePermissionGranted() {
    setPermissionsGranted(true);
    if (pendingVoiceAction.current === "live") {
      void executeStartVoice();
    } else if (pendingVoiceAction.current === "dictate") {
      dictationBase.current = body;
      recognition.start();
    }
    pendingVoiceAction.current = null;
  }

  async function executeStartVoice() {
    if (!aiConfigured) {
      setError("Set AI_API_KEY on the server to enable Relay AI.");
      return;
    }
    if (recognition.listening) recognition.abort(); // stop dictation
    cancelSpeech();
    if (speechSupported()) window.speechSynthesis.getVoices(); // loads voices early
    setSpeakingId(null);
    setError("");
    voiceOn.current = true;
    held.current = false;
    const greeting = "Hi, I’m Relay. What would you like to talk about?";
    setCaption(greeting);
    setVoice("speaking");
    // The in-app browser has no speechSynthesis, so play server-generated audio.
    listen();
    await speakGreeting(greeting);
    if (voiceOn.current && !held.current) listen();
  }
  // Silences the reply and stops generating it, so the next turn isn't blocked.
  function silence() {
    speaker.current?.cancel();
    speaker.current = null;
    if (stream !== null) {
      interrupted.current = true;
      void stop().catch(() => {});
    }
  }
  function endVoice() {
    voiceOn.current = false;
    held.current = false;
    recognition.abort();
    silence();
    cancelSpeech();
    setVoice("off");
    setHeard("");
    setCaption("");
  }
  function holdVoice() {
    held.current = true;
    recognition.abort();
    silence();
    setVoice("held");
  }
  function resumeVoice() {
    held.current = false;
    listen();
  }
  function interruptSpeech() {
    silence();
    if (voiceOn.current && !held.current && stream === null) listen();
  }
  async function toggleDictation() {
    if (recognition.listening) return recognition.stop();
    if (!permissionsGranted) {
      const perm = await checkVoicePermissions();
      if (!perm.allGranted) {
        pendingVoiceAction.current = "dictate";
        setPermissionDialog(true);
        return;
      }
      setPermissionsGranted(true);
    }
    dictationBase.current = body;
    recognition.start();
  }

  async function readAloud(m: Message) {
    if (speakingId === m.id) {
      cancelSpeech();
      return;
    }
    setSpeakingId(m.id);
    await speak(m.body);
    setSpeakingId((id) => (id === m.id ? null : id));
  }
  useEffect(
    () => () => {
      voiceOn.current = false;
      cancelSpeech();
    },
    [],
  );
  async function attach(f: File) {
    setError("");
    if (f.size > 10 * 1024 * 1024) {
      setError("Choose a file smaller than 10 MB.");
      return;
    }
    setUploadState({ name: f.name, progress: 0, ready: false });
    try {
      const result = await upload(c.id, f, (progress) =>
        setUploadState({ name: f.name, progress, ready: false }),
      );
      for (let i = 0; i < 30; i++) {
        const status = await api<{ status: string }>(
          "/attachments/" + result.id,
        );
        if (status.status === "ready") {
          setUploadState({
            name: f.name,
            progress: 100,
            id: result.id,
            ready: true,
          });
          return;
        }
        if (status.status === "delete")
          throw new Error("File validation failed.");
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      throw new Error("File processing timed out. Please try again.");
    } catch (e) {
      setUploadState(null);
      setError((e as Error).message);
    }
  }
  async function action(fn: () => Promise<unknown>) {
    try {
      await fn();
      await history.refetch();
      void qc.invalidateQueries({ queryKey: ["conversations"] });
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function summarize() {
    const ids = [...selected];
    setSummarizing(true);
    setError("");
    try {
      const cid = await onOpenAI(false);
      let failure = "";
      await streamAI(
        cid,
        {
          body: "Summarize these selected messages clearly and concisely.",
          client_id: crypto.randomUUID(),
          selected_ids: ids,
          selected_snapshots: Object.fromEntries(
            messages
              .filter((m) => ids.includes(m.id))
              .map((m) => [m.id, m.body]),
          ),
        },
        (type, data) => {
          if (type === "error") failure = String(data.message);
        },
        new AbortController().signal,
      );
      if (failure) throw new Error(failure);
      await qc.invalidateQueries({ queryKey: ["messages", cid] });
      setSummary(false);
      await onOpenAI();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSummarizing(false);
    }
  }
  const peers = c.members.filter((m) => m.id !== user.id);
  const subtitle = ai
    ? "Your private thinking space"
    : c.kind === "group"
      ? `${c.members.length} members`
      : peers[0]?.online
        ? "Online"
        : peers[0]?.last_seen
          ? "Last seen " +
            new Date(peers[0].last_seen).toLocaleString([], {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })
          : "Direct message";
  return (
    <section className={`chat ${ai ? "chat-ai" : ""}`}>
      <header className="chat-header">
        <Button
          variant="ghost"
          size="icon"
          className="mobile-back"
          onClick={onBack}
          aria-label="Back to conversations"
        >
          <ArrowLeft size={20} />
        </Button>
        <span className={`avatar ${ai ? "avatar-ai" : ""}`}>
          {ai ? (
            <ArrowUpRight size={23} />
          ) : (
            c.title
              .split(" ")
              .map((x) => x[0])
              .slice(0, 2)
              .join("")
          )}
        </span>
        <button className="chat-heading" onClick={() => setDetails(true)}>
          <h2>
            {c.title}
            {ai && <span className="ai-label">AI</span>}
          </h2>
          <small>
            {peers[0]?.online && !ai && <i className="status-dot" />}
            {subtitle}
          </small>
        </button>
        <div className="header-actions">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setSearchOpen(!searchOpen)}
            aria-label="Search this conversation"
          >
            <Search size={20} />
          </Button>
          <span className="header-divider" />
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setDetails(true)}
            aria-label="Conversation details"
          >
            <MoreHorizontal size={22} />
          </Button>
        </div>
      </header>
      {connection !== "Connected" && (
        <div className="connection-banner" role="status">
          {connection === "Offline"
            ? "You’re offline. Unsent messages can be retried when you reconnect."
            : "Reconnecting… Your messages are safely stored."}
        </div>
      )}
      {searchOpen && (
        <div className="message-search">
          <Search size={17} />
          <input
            autoFocus
            aria-label="Search loaded messages"
            placeholder="Search loaded messages…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close search"
            onClick={() => {
              setSearchOpen(false);
              setSearch("");
            }}
          >
            <X size={17} />
          </Button>
        </div>
      )}
      {selected.length > 0 && (
        <div className="selection-bar">
          <span>{selected.length} selected</span>
          <Button size="sm" variant="outline" onClick={() => setSummary(true)}>
            Summarize selected messages
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Clear selection"
            onClick={() => setSelected([])}
          >
            <X size={17} />
          </Button>
        </div>
      )}
      <div
        className="message-scroll"
        ref={viewport}
        onScroll={() => {
          const el = viewport.current;
          if (el)
            stick.current =
              el.scrollHeight - el.scrollTop - el.clientHeight < 100;
        }}
      >
        <div className="message-column">
          {history.hasNextPage && (
            <Button
              variant="ghost"
              className="load-older"
              disabled={history.isFetchingNextPage}
              onClick={() => {
                stick.current = false;
                void history.fetchNextPage();
              }}
            >
              {history.isFetchingNextPage
                ? "Loading…"
                : "Load earlier messages"}
            </Button>
          )}
          {history.isPending && (
            <div className="message-loading">
              <LoaderCircle className="spin" />
              Loading your conversation…
            </div>
          )}
          {history.isError && (
            <div className="empty-small">
              <p>Messages couldn’t load.</p>
              <Button onClick={() => void history.refetch()}>Try again</Button>
            </div>
          )}
          {!history.isPending && messages.length === 0 && ai && (
            <div className="ai-hello">
              <h3>
                <span className="gradient-text">
                  Hello, {user.display_name.split(" ")[0]}
                </span>
                <span>How can I help you today?</span>
              </h3>
              {!aiConfigured ? (
                <div className="config-note">
                  Relay AI isn’t configured yet. Set <code>AI_API_KEY</code> on
                  the server to connect a model. No simulated responses are
                  shown.
                </div>
              ) : (
                <>
                  <div className="ai-cards">
                    {[
                      ["Plan", "Help me organize my week"],
                      ["Learn", "Explain a complex idea simply"],
                      ["Write", "Help me write a thoughtful message"],
                      ["Brainstorm", "Give me ideas for a weekend project"],
                    ].map(([tag, p]) => (
                      <button key={p} onClick={() => setBody(p)}>
                        <span>{p}</span>
                        <small>{tag}</small>
                      </button>
                    ))}
                  </div>
                  {recognition.supported && (
                    <button className="ai-live-cta" onClick={startVoice}>
                      <AudioLines size={18} />
                      Talk it through with Live
                    </button>
                  )}
                </>
              )}
            </div>
          )}
          {!history.isPending && messages.length === 0 && !ai && (
            <div className="chat-empty">
              <div className="welcome-mark">
                <ArrowUpRight size={32} />
              </div>
              <h3>
                {ai
                  ? "Room for your next idea."
                  : "This is the start of something."}
              </h3>
              <p>
                {ai
                  ? "Ask a question, untangle a thought, or draft something new."
                  : "Send a hello. The rest can follow."}
              </p>
              {ai && !aiConfigured && (
                <div className="config-note">
                  Relay AI isn’t configured yet. Set <code>AI_API_KEY</code> on
                  the server to connect a model. No simulated responses are
                  shown.
                </div>
              )}
              {ai && aiConfigured && (
                <div className="prompt-suggestions">
                  {[
                    "Help me organize my week",
                    "Explain a complex idea simply",
                    "Help me write a thoughtful message",
                  ].map((p) => (
                    <button key={p} onClick={() => setBody(p)}>
                      {p}
                      <ArrowUpRight size={15} />
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {messages
            .filter(
              (m) =>
                !search || m.body.toLowerCase().includes(search.toLowerCase()),
            )
            .map((m, i, shown) => {
              const own = m.sender_id === user.id;
              const day = new Date(m.created_at).toLocaleDateString([], {
                month: "long",
                day: "numeric",
                year: "numeric",
              });
              const previous = shown[i - 1];
              const showDate =
                !previous ||
                new Date(previous.created_at).toDateString() !==
                  new Date(m.created_at).toDateString();
              const replied = messages.find((x) => x.id === m.reply_id);
              const read =
                peers.length > 0 && peers.every((p) => p.read_seq >= m.seq);
              const delivered =
                peers.length > 0 &&
                peers.every((p) => p.delivered_seq >= m.seq);
              return (
                <div key={m.id}>
                  {showDate && (
                    <div className="date-separator">
                      <span>{day}</span>
                    </div>
                  )}
                  <article
                    className={`message-row ${own ? "own" : ""} ${selected.includes(m.id) ? "message-selected" : ""}`}
                  >
                    {ai && !own && (
                      <span className="ai-spark" aria-hidden="true">
                        <Sparkles size={18} />
                      </span>
                    )}
                    <div
                      className={`bubble ${own ? "outgoing" : "incoming"} ${m.deleted ? "deleted" : ""}`}
                    >
                      {!own && c.kind === "group" && (
                        <strong className="sender-name">{m.sender_name}</strong>
                      )}
                      {m.reply_id && (
                        <div className="reply-preview">
                          <Reply size={13} />
                          <span>
                            {replied
                              ? replied.deleted
                                ? "Deleted message"
                                : replied.body
                              : "Earlier message"}
                          </span>
                        </div>
                      )}
                      {m.deleted ? (
                        <p>Message deleted</p>
                      ) : (
                        <>
                          {ai && !own ? (
                            <div className="markdown">
                              <Markdown body={m.body} />
                            </div>
                          ) : (
                            m.body && <p className="message-body">{m.body}</p>
                          )}
                          {m.attachments.map((a) => (
                            <a
                              className="attachment-card"
                              href={API + `/attachments/${a.id}/download`}
                              key={a.id}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {a.content_type.startsWith("image/") ? (
                                <img
                                  src={API + `/attachments/${a.id}/download`}
                                  alt={a.filename}
                                  loading="lazy"
                                />
                              ) : (
                                <FileText size={26} />
                              )}
                              <span>
                                {a.filename}
                                <small>
                                  {Math.ceil(a.size / 1024)} KB · Download
                                </small>
                              </span>
                            </a>
                          ))}
                        </>
                      )}
                      <div className="message-meta">
                        {m.edited && <span>edited</span>}
                        <time>
                          {new Date(m.created_at).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </time>
                        {own &&
                          (m.status === "pending" ? (
                            <Clock size={12} aria-label="Sending" />
                          ) : m.status === "failed" ? (
                            <button
                              className="retry-send"
                              onClick={() => void sendMessage(m)}
                            >
                              <RotateCcw size={12} />
                              Retry
                            </button>
                          ) : (
                            <span
                              title={
                                read
                                  ? "Read by all recipients"
                                  : delivered
                                    ? "Delivered to all recipients"
                                    : "Saved to server"
                              }
                            >
                              {delivered || read ? (
                                <CheckCheck
                                  size={14}
                                  className={read ? "receipt-read" : ""}
                                />
                              ) : (
                                <Check size={14} />
                              )}
                            </span>
                          ))}
                      </div>
                      {m.reactions.length > 0 && (
                        <div className="reactions">
                          {[...new Set(m.reactions.map((r) => r.emoji))].map(
                            (e) => (
                              <button
                                className={
                                  m.reactions.some(
                                    (r) =>
                                      r.emoji === e && r.user_id === user.id,
                                  )
                                    ? "reacted"
                                    : ""
                                }
                                key={e}
                                onClick={() =>
                                  void action(() =>
                                    mutate(`/messages/${m.id}/reactions`, {
                                      emoji: e,
                                    }),
                                  )
                                }
                              >
                                {e}{" "}
                                {
                                  m.reactions.filter((r) => r.emoji === e)
                                    .length
                                }
                              </button>
                            ),
                          )}
                        </div>
                      )}
                    </div>
                    {!m.deleted && !m.status && (
                      <div className="message-actions">
                        <button
                          aria-label="Reply to message"
                          title={
                            ai
                              ? "Replies are unavailable in AI conversations"
                              : "Reply"
                          }
                          onClick={() => {
                            setReply(m);
                            setEdit(null);
                          }}
                          disabled={ai}
                        >
                          <Reply size={14} />
                        </button>
                        <button
                          aria-label="React to message"
                          title="React to message"
                          onClick={() => setReactionTarget(m)}
                        >
                          👍
                        </button>
                        <button
                          aria-label="Copy message"
                          title="Copy"
                          onClick={() =>
                            void navigator.clipboard
                              .writeText(m.body)
                              .catch(() =>
                                setError("Clipboard access is unavailable."),
                              )
                          }
                        >
                          <Copy size={14} />
                        </button>
                        {ai && !own && (
                          <button
                            aria-label={
                              speakingId === m.id
                                ? "Stop reading aloud"
                                : "Read aloud"
                            }
                            title={
                              speakingId === m.id ? "Stop reading" : "Read aloud"
                            }
                            aria-pressed={speakingId === m.id}
                            onClick={() => void readAloud(m)}
                          >
                            {speakingId === m.id ? (
                              <Square size={13} />
                            ) : (
                              <Volume2 size={14} />
                            )}
                          </button>
                        )}
                        {!ai && (
                          <button
                            aria-label="Select message for summary"
                            title="Select for summary"
                            onClick={() =>
                              setSelected((old) =>
                                old.includes(m.id)
                                  ? old.filter((id) => id !== m.id)
                                  : [...old, m.id].slice(0, 30),
                              )
                            }
                          >
                            <CheckSquare size={14} />
                          </button>
                        )}
                        {own && !ai && (
                          <button
                            aria-label="Edit message"
                            title="Edit"
                            onClick={() => {
                              setEdit(m);
                              setBody(m.body);
                              setReply(null);
                            }}
                          >
                            <Pencil size={14} />
                          </button>
                        )}
                        {(own ||
                          (c.kind !== "direct" &&
                            c.members.find((x) => x.id === user.id)?.role !==
                              "member")) && (
                          <button
                            aria-label="Delete message"
                            title="Delete"
                            onClick={() => setConfirmDelete(m)}
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </div>
                    )}
                  </article>
                </div>
              );
            })}
          {stream !== null && (
            <article className="message-row">
              {ai && (
                <span className="ai-spark ai-spark-busy" aria-hidden="true">
                  <Sparkles size={18} />
                </span>
              )}
              <div className="bubble incoming markdown streaming">
                <Markdown body={stream || "Thinking…"} />
                <span className="stream-caret" />
              </div>
            </article>
          )}
          {typing && (
            <div className="typing">
              <span>
                <i />
                <i />
                <i />
              </span>
              {typing} is typing
            </div>
          )}
          <div ref={bottom} />
        </div>
      </div>
      <footer className="composer-area">
        {error && (
          <div className="composer-error" role="alert">
            <span>{error}</span>
            {ai && retryPrompt && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void askAI(retryPrompt)}
              >
                Retry
              </Button>
            )}
            <button aria-label="Dismiss error" onClick={() => setError("")}>
              <X size={15} />
            </button>
          </div>
        )}
        {(reply || edit) && (
          <div className="composer-context">
            <Reply size={16} />
            <span>
              {edit ? "Editing message" : `Replying to ${reply?.sender_name}`}
              <small>{(edit || reply)?.body}</small>
            </span>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Cancel reply or edit"
              onClick={() => {
                setReply(null);
                setEdit(null);
                setBody("");
              }}
            >
              <X size={16} />
            </Button>
          </div>
        )}
        {uploadState && (
          <div className="upload-progress">
            <Paperclip size={16} />
            <span>
              {uploadState.name}
              <small>
                {uploadState.ready
                  ? "Ready to send"
                  : uploadState.progress === 100
                    ? "Checking file…"
                    : `Uploading ${uploadState.progress}%`}
              </small>
              <progress value={uploadState.progress} max={100} />
            </span>
            <button
              aria-label="Remove attachment"
              onClick={() => setUploadState(null)}
              disabled={!uploadState.ready}
            >
              <X size={16} />
            </button>
          </div>
        )}
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            void sendMessage();
          }}
        >
          <input
            ref={file}
            type="file"
            hidden
            accept="image/png,image/jpeg,image/webp,application/pdf,text/plain"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void attach(f);
              e.target.value = "";
            }}
          />
          {!ai && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Attach a file"
              title={
                ai
                  ? "AI attachments are unavailable; paste text instead."
                  : "Attach an image or document (up to 10 MB)"
              }
              disabled={ai || !!uploadState}
              onClick={() => file.current?.click()}
            >
              <Paperclip size={21} />
            </Button>
          )}
          <textarea
            aria-label="Message"
            placeholder={ai ? "Ask Relay AI" : "Write a message…"}
            rows={1}
            value={body}
            maxLength={8000}
            onChange={(e) => {
              setBody(e.target.value);
              if (Date.now() - lastTyped.current > 2500) {
                onTyping();
                lastTyped.current = Date.now();
              }
            }}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                if (stream === null && (!uploadState || uploadState.ready))
                  void sendMessage();
              }
            }}
          />
          {!ai && (
            <div className="emoji-wrap">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Choose emoji"
                onClick={() => setEmoji(!emoji)}
              >
                <Smile size={21} />
              </Button>
              {emoji && (
                <div className="emoji-picker">
                  {[
                    "😊",
                    "👍",
                    "❤️",
                    "😂",
                    "🎉",
                    "👀",
                    "🙏",
                    "✨",
                    "🚀",
                    "👋",
                    "💡",
                    "✅",
                  ].map((e) => (
                    <button
                      type="button"
                      aria-label={`Insert ${e}`}
                      key={e}
                      onClick={() => {
                        setBody(body + e);
                        setEmoji(false);
                      }}
                    >
                      {e}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {recognition.supported && voice === "off" && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={recognition.listening ? "mic-active" : ""}
              aria-label={
                recognition.listening ? "Stop dictation" : "Dictate a message"
              }
              aria-pressed={recognition.listening}
              title={recognition.listening ? "Stop dictation" : "Dictate"}
              onClick={toggleDictation}
            >
              <Mic size={20} />
            </Button>
          )}
          {ai &&
            recognition.supported &&
            voice === "off" &&
            stream === null &&
            !body.trim() && (
              <button
                type="button"
                className="live-pill"
                aria-label="Start voice conversation"
                title="Talk with Relay AI"
                disabled={!aiConfigured}
                onClick={startVoice}
              >
                <AudioLines size={18} />
                Live
              </button>
            )}
          {stream !== null ? (
            <Button
              type="button"
              size="icon"
              aria-label="Stop generation"
              onClick={() => void stop().catch((e) => setError(e.message))}
            >
              <Square size={17} />
            </Button>
          ) : ai && recognition.supported && !body.trim() ? null : (
            <Button
              type="submit"
              size="icon"
              aria-label={edit ? "Save edit" : "Send message"}
              disabled={
                (!body.trim() && !uploadState?.ready) ||
                (!!uploadState && !uploadState.ready) ||
                (ai && !aiConfigured)
              }
            >
              <Send size={18} />
            </Button>
          )}
        </form>
        <div className="composer-hint">
          {ai
            ? "AI can make mistakes. Review important information."
            : "Enter to send · Shift + Enter for a new line"}
          <span>
            {ai
              ? "Only this conversation is shared with AI"
              : "A little closer, one message at a time"}
          </span>
        </div>
      </footer>
      <VoiceLive
        state={voice}
        heard={heard}
        caption={caption}
        level={micLevel}
        onHold={holdVoice}
        onResume={resumeVoice}
        onInterrupt={interruptSpeech}
        onEnd={endVoice}
      />
      <VoicePermissionsDialog
        open={permissionDialog}
        onOpenChange={setPermissionDialog}
        onGranted={handlePermissionGranted}
      />
      <Dialog
        open={!!reactionTarget}
        onOpenChange={() => setReactionTarget(null)}
        title="React to message"
        description="Choose an emoji. Choose it again to remove your reaction."
      >
        <div className="reaction-choices">
          {["👍", "❤️", "😂", "🎉", "👀", "🙏"].map((emoji) => (
            <button
              key={emoji}
              aria-label={`React ${emoji}`}
              onClick={() => {
                if (reactionTarget)
                  void action(() =>
                    mutate(`/messages/${reactionTarget.id}/reactions`, {
                      emoji,
                    }),
                  );
                setReactionTarget(null);
              }}
            >
              {emoji}
            </button>
          ))}
        </div>
      </Dialog>
      <Details
        open={details}
        onClose={() => setDetails(false)}
        conversation={c}
        user={user}
      />
      <Dialog
        open={!!confirmDelete}
        onOpenChange={() => setConfirmDelete(null)}
        title="Delete this message?"
        description="The message text and its attachments will be removed for everyone. Replies keep a deleted-message reference."
      >
        <div className="dialog-actions">
          <Button variant="outline" onClick={() => setConfirmDelete(null)}>
            Keep message
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              if (confirmDelete)
                void action(() =>
                  api("/messages/" + confirmDelete.id, { method: "DELETE" }),
                );
              setConfirmDelete(null);
            }}
          >
            Delete message
          </Button>
        </div>
      </Dialog>
      <Dialog
        open={summary}
        onOpenChange={(value) => {
          if (!summarizing) setSummary(value);
        }}
        title="Summarize selected messages"
        description="Only the text below will be copied into your private Relay AI conversation and sent to the configured model provider. Attachments and other messages are excluded."
      >
        <div className="summary-preview">
          {messages
            .filter((m) => selected.includes(m.id))
            .map((m) => (
              <blockquote key={m.id}>
                <strong>{m.sender_name}</strong>
                <p>{m.body}</p>
              </blockquote>
            ))}
        </div>
        {!aiConfigured && (
          <p className="error">
            AI is not configured. Set AI_API_KEY on the server first.
          </p>
        )}
        <p className="error" role="alert">
          {error}
        </p>
        <Button
          disabled={!aiConfigured || summarizing}
          onClick={() => void summarize()}
        >
          {summarizing
            ? "Summarizing…"
            : `Confirm and send ${selected.length} messages`}
        </Button>
      </Dialog>
    </section>
  );
}
