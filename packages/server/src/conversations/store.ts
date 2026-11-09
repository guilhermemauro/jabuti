// The only writer of conversations and their history (SQLite).
// History is append-only (C10): this module has no statement that updates or
// deletes a message. Compaction appends a context mark too (loop/context.ts).
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { HistoryMessage, ShellMode } from "@jabuti/protocol";
import type { ProviderRecord } from "../providers/types.ts";

export interface Conversation {
  id: string;
  title: string;
  agent: string;
  /** Overrides the agent's model from the next turn on; null runs the agent's model. */
  model: string | null;
  /** Overrides the agent's shell mode; null follows the profile. */
  shellMode: ShellMode | null;
  /** The agent's brief and memory as they were when the conversation started (C14). */
  context: string;
  /** Started by the agent's routine: approvals are refused, not awaited (C19). */
  unattended: boolean;
}

/** A history message plus the provider's verbatim record, for replay. */
export type StoredMessage = HistoryMessage & { raw?: ProviderRecord };

type ConversationRow = Omit<Conversation, "shellMode" | "unattended"> & {
  shell_mode: ShellMode | null;
  unattended: number;
};
const COLUMNS = "id, title, agent, model, shell_mode, context, unattended";

interface MessageRow {
  message: string;
  raw: string | null;
}

export class ConversationStore {
  private readonly db: DatabaseSync;

  /** `db` comes from openDatabase(), already migrated. */
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  create(agent: string, context: string, unattended = false): Conversation {
    const conversation = {
      id: randomUUID(),
      title: "New conversation",
      agent,
      model: null,
      shellMode: null,
      context,
      unattended,
    };
    this.db
      .prepare(
        `INSERT INTO conversations (id, title, agent, context, unattended, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        conversation.id,
        conversation.title,
        agent,
        context,
        unattended ? 1 : 0,
        new Date().toISOString(),
      );
    return conversation;
  }

  get(id: string): Conversation | undefined {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM conversations WHERE id = ?`).get(id) as
      ConversationRow | undefined;
    return row && fromRow(row);
  }

  list(): Conversation[] {
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM conversations ORDER BY created_at DESC`)
      .all() as unknown as ConversationRow[];
    return rows.map(fromRow);
  }

  /** Conversation settings, not history: they take effect from the next turn. */
  setModel(id: string, model: string | null) {
    this.db.prepare("UPDATE conversations SET model = ? WHERE id = ?").run(model, id);
  }

  setShellMode(id: string, mode: ShellMode | null) {
    this.db.prepare("UPDATE conversations SET shell_mode = ? WHERE id = ?").run(mode, id);
  }

  /** The owner answered in a routine run: from now on someone is there (C19). */
  setAttended(id: string) {
    this.db.prepare("UPDATE conversations SET unattended = 0 WHERE id = ?").run(id);
  }

  setTitle(id: string, title: string) {
    this.db.prepare("UPDATE conversations SET title = ? WHERE id = ?").run(title, id);
  }

  /** How many of its messages the memory capture has read (C18). */
  captured(id: string): number {
    const row = this.db.prepare("SELECT captured FROM conversations WHERE id = ?").get(id) as
      { captured: number } | undefined;
    return row?.captured ?? 0;
  }

  setCaptured(id: string, count: number) {
    this.db.prepare("UPDATE conversations SET captured = ? WHERE id = ?").run(count, id);
  }

  /** Conversations with messages the capture has not read, and when the last was written. */
  uncaptured(): { id: string; lastAt: string }[] {
    return this.db
      .prepare(
        `SELECT c.id AS id, MAX(m.created_at) AS lastAt FROM conversations c
         JOIN messages m ON m.conversation_id = c.id
         GROUP BY c.id HAVING COUNT(*) > c.captured`,
      )
      .all() as unknown as { id: string; lastAt: string }[];
  }

  history(id: string): StoredMessage[] {
    const rows = this.db
      .prepare("SELECT message, raw FROM messages WHERE conversation_id = ? ORDER BY seq")
      .all(id) as unknown as MessageRow[];
    return rows.map((row) => {
      // Written by append() below from typed data; no re-validation.
      const message = JSON.parse(row.message) as HistoryMessage;
      return row.raw ? { ...message, raw: JSON.parse(row.raw) as ProviderRecord } : message;
    });
  }

  append(id: string, message: StoredMessage) {
    const { raw, ...rest } = message;
    this.db
      .prepare(
        `INSERT INTO messages (conversation_id, seq, message, raw, created_at)
         VALUES (?, (SELECT COALESCE(MAX(seq), -1) + 1 FROM messages WHERE conversation_id = ?), ?, ?, ?)`,
      )
      .run(
        id,
        id,
        JSON.stringify(rest),
        raw ? JSON.stringify(raw) : null,
        new Date().toISOString(),
      );
  }
}

function fromRow({ shell_mode, unattended, ...row }: ConversationRow): Conversation {
  return { ...row, shellMode: shell_mode, unattended: unattended === 1 };
}
