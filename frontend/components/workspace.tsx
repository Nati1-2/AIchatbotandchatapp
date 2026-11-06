"use client";
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Search,
  SquarePen,
  SlidersHorizontal,
  Pin,
  BellOff,
  ArrowUpRight,
  MessageSquare,
  Users,
  LogOut,
  Settings,
  Plus,
  LoaderCircle,
  Bell,
} from "lucide-react";
import { api, mutate, getApi } from "@/lib/api";
import type { Conversation, RelayEvent, SearchPage, User } from "@/lib/types";
import {
  enableDesktopNotifications,
  getNotifyPrefs,
  notificationsSupported,
  notifyMessage,
  setNotifyPrefs,
} from "@/lib/notify";
import { reconnectDelay } from "@/lib/messages";
import { useUI } from "@/lib/store";
import { Brand } from "./auth";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { Chat } from "./chat";
import { ThemeToggle } from "./theme";
export function Avatar({
  name,
  ai = false,
  small = false,
}: {
  name: string;
  ai?: boolean;
  small?: boolean;
}) {
  return (
    <span
      className={`avatar ${small ? "avatar-small" : ""} ${ai ? "avatar-ai" : ""}`}
    >
      {ai ? (
        <ArrowUpRight size={22} />
      ) : (
        name
          .split(" ")
          .map((x) => x[0])
          .slice(0, 2)
          .join("")
          .toUpperCase()
      )}
    </span>
  );
}
export function Workspace({
  user,
  aiConfigured,
}: {
  user: User;
  aiConfigured: boolean;
}) {
  const qc = useQueryClient();
  const { active, setActive, openMessage } = useUI();
  const [filter, setFilter] = useState("All");
  const [search, setSearch] = useState("");
  const [modal, setModal] = useState<"new" | "settings" | null>(null);
  const [status, setStatus] = useState("Connecting");
  const [typing, setTyping] = useState<
    Record<string, { name: string; until: number }>
  >({});
  const socket = useRef<WebSocket | null>(null);
  const [notice, setNotice] = useState<{ id: string; title: string } | null>(
    null,
  );
  const conversations = useQuery({
    queryKey: ["conversations"],
    queryFn: () => api<Conversation[]>("/conversations"),
    refetchInterval: 15000,
  });
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    let attempt = 0;
    const seen = new Set<string>();
    function connect() {
      if (disposed) return;
      const apiBase = getApi();
      const wsUrl = apiBase
        ? apiBase.replace(/^http/, "ws") + "/ws"
        : `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/ws`;
      const ws = new WebSocket(wsUrl);
      socket.current = ws;
      ws.onopen = () => {
        attempt = 0;
        setStatus("Connected");
        void qc.invalidateQueries({ queryKey: ["conversations"] });
        void qc.invalidateQueries({ queryKey: ["messages"] });
      };
      ws.onmessage = (e) => {
        const event = JSON.parse(e.data) as RelayEvent;
        if ((event.type as string) === "ping") {
          ws.send(JSON.stringify({ v: 1, type: "pong" }));
          return;
        }
        if (!event.event_id || seen.has(event.event_id)) return;
        if (event.type === "conversation.removed") {
          seen.add(event.event_id);
          const gone = qc
            .getQueryData<Conversation[]>(["conversations"])
            ?.find((item) => item.id === event.conversation_id);
          if (useUI.getState().active === event.conversation_id) {
            useUI.getState().setActive(null);
            setError(`You no longer have access to ${gone?.title || "that conversation"}.`);
          }
          qc.removeQueries({ queryKey: ["messages", event.conversation_id] });
          void qc.invalidateQueries({ queryKey: ["conversations"] });
          return;
        }
        if (
          event.type === "message.created" &&
          event.payload.sender_id &&
          event.payload.sender_id !== user.id
        ) {
          const conversation = qc
            .getQueryData<Conversation[]>(["conversations"])
            ?.find((item) => item.id === event.conversation_id);
          const viewing =
            useUI.getState().active === event.conversation_id &&
            document.visibilityState === "visible";
          if (conversation && !conversation.muted && !viewing) {
            if (useUI.getState().active !== event.conversation_id)
              setNotice({ id: conversation.id, title: conversation.title });
            const sender = String(event.payload.sender_name || "New message");
            notifyMessage({
              title: conversation.kind === "group" ? `${sender} · ${conversation.title}` : sender,
              body: String(event.payload.body || "Sent an attachment"),
              tag: conversation.id,
              onClick: () => useUI.getState().setActive(conversation.id),
            });
          }
        }
        seen.add(event.event_id);
        if (seen.size > 2000) seen.clear();
        if (
          event.type === "typing.updated" &&
          event.payload.user_id !== user.id
        )
          setTyping((old) => ({
            ...old,
            [event.conversation_id]: {
              name: String(event.payload.name),
              until: Date.now() + 5000,
            },
          }));
        else {
          void qc.invalidateQueries({ queryKey: ["conversations"] });
          if (event.type !== "conversation.read")
            void qc.invalidateQueries({
              queryKey: ["messages", event.conversation_id],
            });
        }
      };
      ws.onclose = (e) => {
        if (disposed) return;
        if (e.code === 4401) {
          void qc.invalidateQueries({ queryKey: ["session"] });
          return;
        }
        setStatus(navigator.onLine ? "Reconnecting" : "Offline");
        timer = setTimeout(connect, reconnectDelay(attempt++));
      };
      ws.onerror = () => ws.close();
    }
    connect();
    const interval = setInterval(
      () =>
        setTyping((old) =>
          Object.fromEntries(
            Object.entries(old).filter(([, v]) => v.until > Date.now()),
          ),
        ),
      1000,
    );
    return () => {
      disposed = true;
      clearTimeout(timer);
      clearInterval(interval);
      socket.current?.close();
    };
  }, [qc, user.id]);
  useEffect(() => {
    const total = (conversations.data || []).reduce((n, c) => n + c.unread, 0);
    document.title = (total ? `(${total}) ` : "") + "Relay — A little closer";
  }, [conversations.data]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);
  const [messageQuery, setMessageQuery] = useState("");
  useEffect(() => {
    const term = search.trim();
    const timer = setTimeout(() => setMessageQuery(term.length >= 2 ? term : ""), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const messageResults = useQuery({
    queryKey: ["search", messageQuery],
    queryFn: () => api<SearchPage>("/search?q=" + encodeURIComponent(messageQuery)),
    enabled: messageQuery.length >= 2,
    staleTime: 10_000,
  });
  const titles = new Map((conversations.data || []).map((c) => [c.id, c.title]));
  const selected = conversations.data?.find((c) => c.id === active);
  const rows = (conversations.data || [])
    .filter(
      (c) =>
        c.title.toLowerCase().includes(search.toLowerCase()) &&
        (filter === "All" ||
          (filter === "Unread" && c.unread > 0) ||
          (filter === "Groups" && c.kind === "group")),
    )
    .sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        b.updated_at.localeCompare(a.updated_at),
    );
  async function openAI() {
    const c = await mutate<Conversation>("/conversations", { kind: "ai" });
    await qc.invalidateQueries({ queryKey: ["conversations"] });
    setActive(c.id);
  }
  const [error, setError] = useState("");
  return (
    <main className={`workspace ${active ? "has-active" : ""}`}>
      <aside className="sidebar">
        <div className="sidebar-brand">
          <Brand />
          <span className="sidebar-brand-actions">
            <ThemeToggle />
            <Button
              variant="ghost"
              size="icon"
              aria-label="Account settings"
              onClick={() => setModal("settings")}
            >
              <SlidersHorizontal size={19} />
            </Button>
          </span>
        </div>
        <div className="sidebar-title">
          <h1>
            Messages<span>{conversations.data?.length || 0}</span>
          </h1>
          <Button
            variant="ghost"
            size="icon"
            aria-label="New conversation"
            onClick={() => setModal("new")}
          >
            <SquarePen size={20} />
          </Button>
        </div>
        <label className="search-box">
          <Search size={17} />
          <input
            aria-label="Search conversations and messages"
            placeholder="Search chats and messages"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <kbd>⌕</kbd>
        </label>
        <div className="filters" aria-label="Conversation filters">
          {["All", "Unread", "Groups"].map((f) => (
            <button
              aria-pressed={filter === f}
              key={f}
              onClick={() => setFilter(f)}
            >
              {f}
            </button>
          ))}
          <button
            className="filter-ai"
            aria-label="Open Relay AI"
            title="Open Relay AI"
            onClick={() => void openAI().catch((e) => setError(e.message))}
          >
            AI <ArrowUpRight size={13} />
          </button>
        </div>
        <div className="conversation-list">
          {conversations.isPending &&
            [1, 2, 3, 4].map((i) => <div className="skeleton-row" key={i} />)}
          {conversations.isError && (
            <div className="empty-small">
              <p>Conversations couldn’t load.</p>
              <Button
                variant="outline"
                onClick={() => void conversations.refetch()}
              >
                Retry
              </Button>
            </div>
          )}
          {rows.map((c) => (
            <button
              className={`conversation-row ${active === c.id ? "selected" : ""}`}
              key={c.id}
              onClick={() => setActive(c.id)}
            >
              <span className="avatar-wrap">
                <Avatar name={c.title} ai={c.kind === "ai"} />
                {c.kind === "direct" &&
                  c.members.some((m) => m.id !== user.id && m.online) && (
                    <i className="presence-dot" />
                  )}
              </span>
              <span className="conversation-copy">
                <span className="row-title">
                  <strong>{c.title}</strong>
                  <time>
                    {new Date(c.updated_at).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </time>
                </span>
                <span className="row-preview">
                  <span>
                    {typing[c.id]
                      ? `${typing[c.id].name} is typing…`
                      : c.last_message || "Start a conversation"}
                  </span>
                  {c.muted && <BellOff size={12} />}{" "}
                  {c.pinned && <Pin size={12} />}{" "}
                  {!!c.unread && <b className="unread">{c.unread}</b>}
                </span>
              </span>
            </button>
          ))}
          {messageQuery && (
            <section className="search-results" aria-label="Messages matching your search">
              <h2>Messages</h2>
              {messageResults.isPending && <div className="skeleton-row" />}
              {messageResults.isError && (
                <p className="muted">Message search is unavailable right now.</p>
              )}
              {messageResults.data?.items.length === 0 && (
                <p className="muted">No messages contain “{messageQuery}”.</p>
              )}
              {messageResults.data?.items.map((m) => (
                <button
                  key={m.id}
                  className="search-hit"
                  onClick={() => openMessage(m.conversation_id, m.id)}
                >
                  <span className="row-title">
                    <strong>{titles.get(m.conversation_id) || "Conversation"}</strong>
                    <time>{new Date(m.created_at).toLocaleDateString()}</time>
                  </span>
                  <span className="search-snippet">
                    <b>{m.sender_id === user.id ? "You" : m.sender_name}:</b>{" "}
                    <Highlight text={m.snippet} term={messageQuery} />
                  </span>
                </button>
              ))}
              {messageResults.data?.has_more && (
                <p className="muted">Showing the 30 most recent matches.</p>
              )}
            </section>
          )}
          {!conversations.isPending &&
            !conversations.isError &&
            rows.length === 0 &&
            !messageQuery && (
              <div className="empty-small">
                <MessageSquare size={26} />
                <h3>{search ? "No matches yet" : "A fresh start"}</h3>
                <p>
                  {search
                    ? "Try a different name."
                    : "Your conversations will appear here."}
                </p>
                <Button variant="outline" onClick={() => setModal("new")}>
                  Start a conversation
                </Button>
              </div>
            )}
        </div>
        <div className="sidebar-bottom">
          <button
            className="ai-shortcut"
            onClick={() => void openAI().catch((e) => setError(e.message))}
          >
            <Avatar name="Relay AI" ai small />
            <span>
              Relay AI<small>A little help, a conversation away</small>
            </span>
            <ArrowUpRight size={17} />
          </button>
          <button className="account-row" onClick={() => setModal("settings")}>
            <Avatar name={user.display_name} small />
            <span>
              <strong>{user.display_name}</strong>
              <small>
                <i
                  className={`status-dot ${status !== "Connected" ? "status-warning" : ""}`}
                />
                {status}
              </small>
            </span>
            <Settings size={18} />
          </button>
        </div>
      </aside>
      {selected ? (
        <Chat
          key={selected.id}
          conversation={selected}
          user={user}
          aiConfigured={aiConfigured}
          connection={status}
          typing={typing[selected.id]?.name}
          onBack={() => setActive(null)}
          onTyping={() => {
            if (socket.current?.readyState === WebSocket.OPEN)
              socket.current.send(
                JSON.stringify({
                  v: 1,
                  type: "typing.updated",
                  conversation_id: selected.id,
                  request_id: crypto.randomUUID(),
                }),
              );
          }}
          onOpenAI={async (activate = true) => {
            const c = await mutate<Conversation>("/conversations", {
              kind: "ai",
            });
            await qc.invalidateQueries({ queryKey: ["conversations"] });
            if (activate) setActive(c.id);
            return c.id;
          }}
        />
      ) : (
        <section className="welcome">
          <div className="welcome-mark">
            <ArrowUpRight size={52} />
          </div>
          <span className="eyebrow">A LITTLE CLOSER</span>
          <h2>
            Your people.
            <br />
            Your conversations.
          </h2>
          <p>Pick up a thread, share an idea, or start something new.</p>
          <Button onClick={() => setModal("new")}>
            <Plus size={18} />
            New conversation
          </Button>
          <div className="welcome-foot">
            <MessageSquare size={15} /> Thoughtfully simple. Always connected.
          </div>
        </section>
      )}
      {notice && (
        <div className="activity-toast" role="status">
          <button
            onClick={() => {
              setActive(notice.id);
              setNotice(null);
            }}
          >
            New message in <strong>{notice.title}</strong>
          </button>
          <button
            aria-label="Dismiss activity alert"
            onClick={() => setNotice(null)}
          >
            ×
          </button>
        </div>
      )}
      <NewConversation
        open={modal === "new"}
        onClose={() => setModal(null)}
        onCreated={(id) => {
          setActive(id);
          setModal(null);
          void qc.invalidateQueries({ queryKey: ["conversations"] });
        }}
      />
      <SettingsDialog
        open={modal === "settings"}
        onClose={() => setModal(null)}
        user={user}
      />
      <Dialog
        open={!!error}
        onOpenChange={() => setError("")}
        title="Something went wrong"
      >
        <p className="error">{error}</p>
      </Dialog>
    </main>
  );
}
function Highlight({ text, term }: { text: string; term: string }) {
  const lower = text.toLowerCase();
  const needle = term.toLowerCase();
  const parts: React.ReactNode[] = [];
  let from = 0;
  for (let at = lower.indexOf(needle); at >= 0 && needle; at = lower.indexOf(needle, from)) {
    if (at > from) parts.push(text.slice(from, at));
    parts.push(<mark key={at}>{text.slice(at, at + needle.length)}</mark>);
    from = at + needle.length;
  }
  parts.push(text.slice(from));
  return <>{parts}</>;
}
function NewConversation({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [group, setGroup] = useState(false);
  const [title, setTitle] = useState("");
  const [q, setQ] = useState("");
  const [people, setPeople] = useState<User[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const results = useQuery({
    queryKey: ["users", q],
    queryFn: () => api<User[]>("/users?q=" + encodeURIComponent(q)),
    enabled: q.length >= 2,
  });
  async function create() {
    setBusy(true);
    try {
      const c = await mutate<Conversation>("/conversations", {
        kind: group ? "group" : "direct",
        title,
        user_ids: people.map((p) => p.id),
      });
      onCreated(c.id);
      setPeople([]);
      setQ("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={onClose}
      title="Start a conversation"
      description="Find your people by username."
    >
      <div className="segmented">
        <Button
          variant={!group ? "default" : "ghost"}
          onClick={() => {
            setGroup(false);
            setPeople([]);
          }}
        >
          <MessageSquare size={16} />
          Direct message
        </Button>
        <Button
          variant={group ? "default" : "ghost"}
          onClick={() => setGroup(true)}
        >
          <Users size={16} />
          New group
        </Button>
      </div>
      {group && (
        <label>
          Group name
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={80}
            placeholder="Give your group a name"
          />
        </label>
      )}
      <label>
        Search people
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Type a username"
        />
      </label>
      <div className="selected-people">
        {people.map((p) => (
          <button
            key={p.id}
            onClick={() => setPeople(people.filter((x) => x.id !== p.id))}
          >
            {p.display_name} ×
          </button>
        ))}
      </div>
      <div className="people-results">
        {results.data
          ?.filter((p) => !people.some((x) => x.id === p.id))
          .map((p) => (
            <button
              key={p.id}
              className="person-row"
              onClick={() => setPeople(group ? [...people, p] : [p])}
            >
              <Avatar name={p.display_name} small />
              <span>
                {p.display_name}
                <small>@{p.username}</small>
              </span>
              <Plus size={16} />
            </button>
          ))}
        {q.length >= 2 && results.data?.length === 0 && (
          <p className="muted">No people found.</p>
        )}
        {results.isError && (
          <p className="error">Search unavailable. Try again.</p>
        )}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <Button
        disabled={busy || people.length === 0 || (group && !title.trim())}
        onClick={() => void create()}
      >
        {busy ? (
          <LoaderCircle className="spin" size={16} />
        ) : group ? (
          "Create group"
        ) : (
          "Open conversation"
        )}
      </Button>
    </Dialog>
  );
}
function SettingsDialog({
  open,
  onClose,
  user,
}: {
  open: boolean;
  onClose: () => void;
  user: User;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(user.display_name);
  const [presence, setPresence] = useState(user.show_presence);
  const [message, setMessage] = useState("");
  const [prefs, setPrefs] = useState(() =>
    typeof window === "undefined" ? { desktop: false, sound: true } : getNotifyPrefs(),
  );
  function updatePrefs(next: typeof prefs) {
    setPrefs(next);
    setNotifyPrefs(next);
  }
  async function toggleDesktop(on: boolean) {
    if (!on) return updatePrefs({ ...prefs, desktop: false });
    const granted = await enableDesktopNotifications();
    updatePrefs({ ...prefs, desktop: granted });
    if (!granted)
      setMessage(
        notificationsSupported()
          ? "Notifications are blocked. Allow them in your browser’s site settings."
          : "This browser can’t show notifications here (HTTPS is required).",
      );
  }
  async function save() {
    try {
      await mutate(
        "/profile",
        { display_name: name, show_presence: presence },
        "PATCH",
      );
      await qc.invalidateQueries({ queryKey: ["session"] });
      setMessage("Your changes are saved.");
    } catch (e) {
      setMessage((e as Error).message);
    }
  }
  async function logout(all = false) {
    await api(all ? "/auth/sessions" : "/auth/logout", {
      method: all ? "DELETE" : "POST",
    });
    qc.clear();
    location.reload();
  }
  return (
    <Dialog
      open={open}
      onOpenChange={onClose}
      title="Your space"
      description="Profile, privacy, and account settings."
    >
      <div className="profile-summary">
        <Avatar name={name} />
        <span>
          @{user.username}
          <small>Your Relay profile</small>
        </span>
      </div>
      <label>
        Display name
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
        />
      </label>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={presence}
          onChange={(e) => setPresence(e.target.checked)}
        />
        <span>
          Show online status and last seen
          <small>Visible to people in your conversations.</small>
        </span>
      </label>
      <Button onClick={() => void save()} disabled={!name.trim()}>
        Save changes
      </Button>
      <hr />
      <h3 className="settings-heading">
        <Bell size={16} /> Notifications
      </h3>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={prefs.desktop}
          onChange={(e) => void toggleDesktop(e.target.checked)}
        />
        <span>
          Desktop notifications
          <small>Alerts for new messages while Relay is in the background. Muted chats stay quiet.</small>
        </span>
      </label>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={prefs.sound}
          onChange={(e) => updatePrefs({ ...prefs, sound: e.target.checked })}
        />
        <span>
          Message sound
          <small>A soft chime when a message arrives in another chat.</small>
        </span>
      </label>
      {message && (
        <p role="status" className="muted">
          {message}
        </p>
      )}
      <hr />
      <Button
        variant="outline"
        onClick={() => void logout().catch((e) => setMessage(e.message))}
      >
        <LogOut size={16} />
        Sign out
      </Button>
      <Button
        variant="ghost"
        onClick={() => void logout(true).catch((e) => setMessage(e.message))}
      >
        Sign out of all devices
      </Button>
    </Dialog>
  );
}
