// Opens the SQLite database and brings its schema up to date. Each table still has
// exactly one module that writes it (conversations/store.ts, auth/index.ts, memory/capture.ts); this
// module only owns the schema.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  migrate(db);
  return db;
}

/** Runs the migrations this database has not seen yet, each in its own transaction. */
function migrate(db: DatabaseSync) {
  const { user_version: version } = db.prepare("PRAGMA user_version").get() as {
    user_version: number;
  };
  MIGRATIONS.slice(version).forEach((sql, i) => {
    db.exec("BEGIN");
    try {
      db.exec(`${sql}; PRAGMA user_version = ${String(version + i + 1)}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  });
}

/**
 * Schema changes, in order; never edit one that has shipped, add a new one. A
 * database records how many it has run in `user_version`.
 */
const MIGRATIONS = [
  // 1: initial schema. IF NOT EXISTS: databases from before migrations already have it.
  `CREATE TABLE IF NOT EXISTS conversations (
     id TEXT PRIMARY KEY,
     title TEXT NOT NULL,
     agent TEXT NOT NULL,
     model TEXT NOT NULL,
     created_at TEXT NOT NULL
   );
   CREATE TABLE IF NOT EXISTS messages (
     conversation_id TEXT NOT NULL REFERENCES conversations(id),
     seq INTEGER NOT NULL,
     message TEXT NOT NULL,
     raw TEXT,
     created_at TEXT NOT NULL,
     PRIMARY KEY (conversation_id, seq)
   )`,
  // 2: the model belongs to the agent profile; conversations snapshot brief and memory.
  `ALTER TABLE conversations DROP COLUMN model;
   ALTER TABLE conversations ADD COLUMN context TEXT NOT NULL DEFAULT ''`,
  // 3: a conversation may override its agent's model again; NULL keeps the agent's.
  `ALTER TABLE conversations ADD COLUMN model TEXT`,
  // 4: the owner's password (one row) and login sessions, by token hash.
  `CREATE TABLE owner (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     password_hash TEXT NOT NULL,
     created_at TEXT NOT NULL
   );
   CREATE TABLE sessions (
     token_hash TEXT PRIMARY KEY,
     expires_at TEXT NOT NULL
   )`,
  // 5: a conversation may override its agent's shell mode; NULL keeps the agent's.
  `ALTER TABLE conversations ADD COLUMN shell_mode TEXT`,
  // 6: settings. Values are AES-256-GCM ciphertext, never plain text (C16).
  `CREATE TABLE variables (
     name TEXT PRIMARY KEY,
     value TEXT NOT NULL,
     scope TEXT NOT NULL,
     shell INTEGER NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE TABLE provider_keys (
     provider TEXT PRIMARY KEY,
     value TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  // 7: memory capture (C18). captured: how many messages the capture has read; the
  // conversations that exist already count as read, so upgrading spends nothing.
  // Proposals wait here for the owner, across restarts.
  `ALTER TABLE conversations ADD COLUMN captured INTEGER NOT NULL DEFAULT 0;
   UPDATE conversations SET captured =
     (SELECT COUNT(*) FROM messages WHERE conversation_id = conversations.id);
   CREATE TABLE memory_proposals (
     id TEXT PRIMARY KEY,
     conversation_id TEXT NOT NULL REFERENCES conversations(id),
     agent TEXT NOT NULL,
     changes TEXT NOT NULL,
     cost_usd REAL NOT NULL,
     created_at TEXT NOT NULL
   )`,
  // 8: conversations an agent's routine started, with nobody watching (C19).
  `ALTER TABLE conversations ADD COLUMN unattended INTEGER NOT NULL DEFAULT 0`,
  // 9: a name may hold several values, one per scope: each agent sees at most one (C16).
  // The ciphertext keeps its associated data, the name, so it moves as it is.
  `CREATE TABLE variables_new (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     value TEXT NOT NULL,
     scope TEXT NOT NULL,
     shell INTEGER NOT NULL,
     updated_at TEXT NOT NULL
   );
   INSERT INTO variables_new (id, name, value, scope, shell, updated_at)
     SELECT lower(hex(randomblob(8))), name, value, scope, shell, updated_at FROM variables;
   DROP TABLE variables;
   ALTER TABLE variables_new RENAME TO variables;
   CREATE INDEX variables_name ON variables (name)`,
  // 10: remote MCP servers the owner registers (C5), and their OAuth state, encrypted.
  `CREATE TABLE mcp_servers (
     name TEXT PRIMARY KEY,
     description TEXT NOT NULL,
     url TEXT NOT NULL,
     headers TEXT NOT NULL,
     oauth INTEGER NOT NULL,
     tools TEXT NOT NULL,
     listed_at TEXT,
     updated_at TEXT NOT NULL
   );
   CREATE TABLE mcp_oauth (
     name TEXT PRIMARY KEY,
     value TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  // 11: instance-wide values, such as the public domain (domain/index.ts).
  `CREATE TABLE instance (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
];
