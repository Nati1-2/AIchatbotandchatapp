export type User = {
  id: string;
  username: string;
  display_name: string;
  show_presence: boolean;
};
export type Member = User & {
  role: "owner" | "admin" | "member";
  read_seq: number;
  delivered_seq: number;
  online: boolean;
  last_seen: string | null;
};
export type Conversation = {
  id: string;
  kind: "direct" | "group" | "ai";
  title: string;
  members: Member[];
  unread: number;
  pinned: boolean;
  muted: boolean;
  last_message: string;
  updated_at: string;
};
export type Attachment = {
  id: string;
  filename: string;
  content_type: string;
  size: number;
};
export type Message = {
  id: string;
  seq: number;
  client_id: string;
  conversation_id: string;
  sender_id: string | null;
  sender_name: string;
  body: string;
  reply_id: string | null;
  created_at: string;
  edited: boolean;
  deleted: boolean;
  reactions: { emoji: string; user_id: string }[];
  attachments: Attachment[];
  status?: "pending" | "failed";
};
export type History = {
  items: Message[];
  has_more: boolean;
  next_cursor: number | null;
};
export type EventType =
  | "message.created"
  | "message.updated"
  | "message.deleted"
  | "reaction.updated"
  | "typing.updated"
  | "presence.updated"
  | "conversation.read"
  | "conversation.updated"
  | "conversation.removed";
export type RelayEvent = {
  v: 1;
  event_id: string;
  type: EventType;
  conversation_id: string;
  payload: Record<string, unknown>;
};
export type SearchResult = {
  id: string;
  seq: number;
  conversation_id: string;
  sender_id: string | null;
  sender_name: string;
  snippet: string;
  created_at: string;
};
export type SearchPage = {
  items: SearchResult[];
  has_more: boolean;
  next_cursor: number | null;
};
