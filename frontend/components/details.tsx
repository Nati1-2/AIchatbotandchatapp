"use client";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BellOff, Pin, FileText, UserPlus, Trash2 } from "lucide-react";
import { api, mutate, API } from "@/lib/api";
import type { Attachment, Conversation, User } from "@/lib/types";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
export function Details({
  open,
  onClose,
  conversation: c,
  user,
}: {
  open: boolean;
  onClose: () => void;
  conversation: Conversation;
  user: User;
}) {
  const qc = useQueryClient();
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const [clear, setClear] = useState(false);
  const attachments = useQuery({
    queryKey: ["attachments", c.id],
    queryFn: () => api<Attachment[]>(`/conversations/${c.id}/attachments`),
    enabled: open,
  });
  const people = useQuery({
    queryKey: ["users", q],
    queryFn: () => api<User[]>("/users?q=" + encodeURIComponent(q)),
    enabled: open && q.length >= 2,
  });
  const own = c.members.find((m) => m.id === user.id);
  async function perform(fn: () => Promise<unknown>) {
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ["conversations"] });
      await qc.invalidateQueries({ queryKey: ["messages", c.id] });
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <>
      <Dialog
        open={open}
        onOpenChange={onClose}
        title="Conversation details"
        description={
          c.kind === "ai"
            ? "AI sees only this conversation and messages you explicitly select."
            : c.kind === "group"
              ? "A shared space for your team."
              : "Your shared conversation."
        }
      >
        <div className="details-profile">
          <span className="avatar">{c.title.slice(0, 2).toUpperCase()}</span>
          <h3>{c.title}</h3>
          <small>
            {c.kind === "group"
              ? `${c.members.length} members`
              : c.kind === "ai"
                ? "Relay AI"
                : "Direct conversation"}
          </small>
        </div>
        <div className="detail-options">
          <button
            onClick={() =>
              void perform(() =>
                mutate(
                  `/conversations/${c.id}/preferences`,
                  { pinned: !c.pinned, muted: c.muted },
                  "PATCH",
                ),
              )
            }
          >
            <Pin size={17} />
            {c.pinned ? "Unpin conversation" : "Pin conversation"}
            <span>{c.pinned ? "On" : "Off"}</span>
          </button>
          <button
            onClick={() =>
              void perform(() =>
                mutate(
                  `/conversations/${c.id}/preferences`,
                  { pinned: c.pinned, muted: !c.muted },
                  "PATCH",
                ),
              )
            }
          >
            <BellOff size={17} />
            Mute notifications<span>{c.muted ? "On" : "Off"}</span>
          </button>
        </div>
        {c.kind !== "ai" && (
          <>
            <h4>PEOPLE</h4>
            <div className="member-list">
              {c.members.map((m) => (
                <div className="person-row" key={m.id}>
                  <span className="avatar avatar-small">
                    {m.display_name.slice(0, 2).toUpperCase()}
                  </span>
                  <span>
                    {m.display_name}
                    {m.id === user.id ? " (you)" : ""}
                    <small>
                      @{m.username} · {m.role}
                    </small>
                  </span>
                  {c.kind === "group" &&
                    own?.role === "owner" &&
                    m.role !== "owner" && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          void perform(() =>
                            mutate(`/conversations/${c.id}/members`, {
                              user_id: m.id,
                              role: m.role === "admin" ? "member" : "admin",
                            }),
                          )
                        }
                      >
                        {m.role === "admin" ? "Demote" : "Make admin"}
                      </Button>
                    )}
                  {c.kind === "group" &&
                    m.role !== "owner" &&
                    (own?.role === "owner" ||
                      (own?.role === "admin" && m.role === "member")) && (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Remove ${m.display_name}`}
                        onClick={() =>
                          void perform(() =>
                            api(`/conversations/${c.id}/members/${m.id}`, {
                              method: "DELETE",
                            }),
                          )
                        }
                      >
                        <Trash2 size={14} />
                      </Button>
                    )}
                </div>
              ))}
            </div>
            {c.kind === "group" && own?.role !== "member" && (
              <>
                <label>
                  Add a member
                  <input
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="Search by username"
                  />
                </label>
                {people.data
                  ?.filter((p) => !c.members.some((m) => m.id === p.id))
                  .map((p) => (
                    <button
                      key={p.id}
                      className="person-row"
                      onClick={() =>
                        void perform(() =>
                          mutate(`/conversations/${c.id}/members`, {
                            user_id: p.id,
                          }),
                        ).then(() => setQ(""))
                      }
                    >
                      <UserPlus size={18} />
                      {p.display_name}
                    </button>
                  ))}
              </>
            )}
            <h4>SHARED FILES</h4>
            {attachments.isPending ? (
              <p className="muted">Loading files…</p>
            ) : attachments.isError ? (
              <p className="error">Files couldn’t load.</p>
            ) : attachments.data?.length ? (
              attachments.data.map((a) => (
                <a
                  key={a.id}
                  className="person-row"
                  href={API + `/attachments/${a.id}/download`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <FileText size={18} />
                  <span>
                    {a.filename}
                    <small>{Math.ceil(a.size / 1024)} KB</small>
                  </span>
                </a>
              ))
            ) : (
              <p className="muted">
                Shared images and documents will appear here.
              </p>
            )}
          </>
        )}
        {c.kind === "ai" && (
          <Button variant="danger" onClick={() => setClear(true)}>
            <Trash2 size={16} />
            Clear AI history
          </Button>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </Dialog>
      <Dialog
        open={clear}
        onOpenChange={setClear}
        title="Clear AI history?"
        description="This erases all prompts and responses from your Relay AI conversation. This cannot be undone."
      >
        <Button
          variant="danger"
          onClick={() => {
            void perform(() =>
              api(`/conversations/${c.id}/ai/history`, { method: "DELETE" }),
            );
            setClear(false);
          }}
        >
          Clear history
        </Button>
      </Dialog>
    </>
  );
}
