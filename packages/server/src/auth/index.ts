// The only writer of the owner's password and login sessions (C15). One owner per
// instance: the person who deployed it. The password is set on first access, with
// a setup code printed in the server log, so whoever reaches a fresh deployment
// first cannot claim it.
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export const SESSION_COOKIE = "jabuti_session";
const MIN_PASSWORD = 12;
const SESSION_DAYS = 30;
// scrypt cost: ~50 ms per check on a laptop; slow enough to make guessing expensive.
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const MAX_FREE_FAILURES = 5;
const MAX_LOCK_MS = 5 * 60_000;

export type AuthState = "setup" | "login" | "ready";

export class Auth {
  private readonly db: DatabaseSync;
  /** Exists only until the owner is set; a new one on every start. */
  readonly setupCode: string | undefined;
  private failures = 0;
  private lockedUntil = 0;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.setupCode = this.hasOwner() ? undefined : newSetupCode();
  }

  state(token: string | undefined): AuthState {
    if (!this.hasOwner()) return "setup";
    return this.session(token) ? "ready" : "login";
  }

  /** Returns a session token, or a reason the setup was refused. */
  setup(code: string, password: string): { token: string } | { error: string } {
    if (this.hasOwner()) return { error: "This instance already has an owner. Log in instead." };
    if (!this.setupCode || !safeEqual(code.trim().toUpperCase(), this.setupCode)) {
      return { error: "Wrong setup code. It is printed in the server log at startup." };
    }
    if (password.length < MIN_PASSWORD) {
      return { error: `Use at least ${String(MIN_PASSWORD)} characters.` };
    }
    this.db
      .prepare("INSERT INTO owner (id, password_hash, created_at) VALUES (1, ?, ?)")
      .run(hashPassword(password), new Date().toISOString());
    return { token: this.newSession() };
  }

  login(password: string): { token: string } | { error: string } {
    const now = Date.now();
    if (now < this.lockedUntil) {
      const seconds = Math.ceil((this.lockedUntil - now) / 1000);
      return { error: `Too many failed attempts. Try again in ${String(seconds)} s.` };
    }
    const row = this.db.prepare("SELECT password_hash FROM owner WHERE id = 1").get() as
      { password_hash: string } | undefined;
    if (!row || !verifyPassword(password, row.password_hash)) {
      // Global, not per client: behind a proxy, client addresses cannot be trusted.
      // Accepted edge case: someone guessing can keep the owner locked out for minutes.
      this.failures++;
      if (this.failures >= MAX_FREE_FAILURES) {
        const doubling = 2 ** (this.failures - MAX_FREE_FAILURES) * 1000;
        this.lockedUntil = now + Math.min(MAX_LOCK_MS, doubling);
      }
      return { error: "Wrong password." };
    }
    this.failures = 0;
    return { token: this.newSession() };
  }

  logout(token: string | undefined) {
    if (token) this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
  }

  /** The session's id (its token hash) when the token is valid and not expired. */
  session(token: string | undefined): string | undefined {
    if (!token) return undefined;
    const id = sha256(token);
    const row = this.db.prepare("SELECT expires_at FROM sessions WHERE token_hash = ?").get(id) as
      { expires_at: string } | undefined;
    if (!row) return undefined;
    if (Date.parse(row.expires_at) <= Date.now()) {
      this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(id);
      return undefined;
    }
    return id;
  }

  /** The same id session() returns for this token, without checking it. */
  static sessionId(token: string): string {
    return sha256(token);
  }

  private hasOwner(): boolean {
    return this.db.prepare("SELECT 1 FROM owner WHERE id = 1").get() !== undefined;
  }

  private newSession(): string {
    const token = randomBytes(32).toString("base64url");
    const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
    this.db
      .prepare("INSERT INTO sessions (token_hash, expires_at) VALUES (?, ?)")
      .run(sha256(token), expires);
    return token;
  }
}

function newSetupCode(): string {
  // No 0/O or 1/I: the code is read from a log and typed by hand.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(8);
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length] ?? "A");
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32, SCRYPT);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = scryptSync(password, Buffer.from(salt, "base64"), expected.length, SCRYPT);
  return timingSafeEqual(actual, expected);
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
