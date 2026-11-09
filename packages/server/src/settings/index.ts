// The only writer of settings: variables and provider API keys (C16). Values are
// encrypted at rest (AES-256-GCM, the variable's name as associated data so a
// value cannot be moved to another variable) and never leave this module toward the UI.
//
// A variable reaches only the agents in its scope. By default only the server
// uses it (connectors); marked `shell`, it is injected into those agents' shell
// commands, where their model can read it. One name may hold a value per scope.
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Problem, ProviderKeyInfo, VariableInfo } from "@jabuti/protocol";

type Scope = "all" | string[];

/** Names the shell needs for itself, or that would let a value hijack a command. */
// DOCKER_*: locally, values travel through the docker CLI's environment.
const RESERVED = /^(PATH|HOME|LANG|SHELL|USER|PWD|PIP_.*|PYTHON.*|LD_.*|JABUTI_.*|DOCKER_.*)$/;

interface VariableRow {
  id: string;
  name: string;
  value: string;
  scope: string;
  shell: number;
  updated_at: string;
}

export class Settings {
  private readonly db: DatabaseSync;
  private readonly key: Buffer;
  /** Provider keys from the server's environment: they win and are read-only. */
  private readonly envKeys: Partial<Record<string, string>>;

  constructor(db: DatabaseSync, key: Buffer, envKeys: Partial<Record<string, string>>) {
    this.db = db;
    this.key = key;
    this.envKeys = envKeys;
  }

  // --- Variables ---
  // A name may hold several values, each with its own scope: one site's Search
  // Console account for one agent, another site's for another. An agent sees at
  // most one value per name: the one naming it, else the one for all agents.

  variables(): VariableInfo[] {
    return this.rows().map((row) => info(row, this.decrypt(aad(row), row.value) === undefined));
  }

  /** The values that reach an agent: one per name, its own over the one for all. */
  variablesFor(agent: string): VariableInfo[] {
    return this.reaching(agent).map((row) =>
      info(row, this.decrypt(aad(row), row.value) === undefined),
    );
  }

  /**
   * Without an id, a new value for the name; with one, a change to that value. An
   * agent may not be in two values of one name, and one name has at most one value
   * for all agents.
   */
  saveVariable(input: {
    id?: string;
    name: string;
    value: string | undefined;
    scope: Scope;
    shell: boolean;
  }): Problem | undefined {
    if (input.shell && RESERVED.test(input.name)) {
      return {
        message: `${input.name} is reserved and cannot be passed to the shell.`,
        nextStep: "Pick another name, or keep it server-only.",
      };
    }
    const existing = input.id === undefined ? undefined : this.row(input.id);
    if (input.id !== undefined && !existing) {
      return { message: `That value of ${input.name} no longer exists.`, nextStep: "Reload." };
    }
    if (existing && existing.name !== input.name) {
      return {
        message: `A value cannot be moved from ${existing.name} to ${input.name}.`,
        nextStep: `Add ${input.name} as a new variable.`,
      };
    }
    if (input.value === undefined && !existing) {
      return { message: `${input.name} has no value yet.`, nextStep: "Enter a value." };
    }
    const others = this.named(input.name).filter((row) => row.id !== input.id);
    const scopes = others.map((row) => JSON.parse(row.scope) as Scope);
    if (input.scope === "all" && scopes.includes("all")) {
      return {
        message: `${input.name} already has a value for all agents.`,
        nextStep: "Edit that value, or pick the agents this one is for.",
      };
    }
    const taken =
      input.scope === "all"
        ? []
        : input.scope.filter((a) => scopes.some((s) => s !== "all" && s.includes(a)));
    if (taken.length > 0) {
      return {
        message: `${taken.join(", ")} already ${taken.length === 1 ? "has its" : "have their"} own value of ${input.name}.`,
        nextStep: "Edit that value instead, or take those agents out of its scope first.",
      };
    }
    const id = existing?.id ?? randomUUID();
    const value =
      input.value === undefined
        ? (existing?.value ?? "")
        : this.encrypt(`variable:${input.name}`, input.value);
    this.db
      .prepare(
        `INSERT INTO variables (id, name, value, scope, shell, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET value = excluded.value, scope = excluded.scope,
           shell = excluded.shell, updated_at = excluded.updated_at`,
      )
      .run(
        id,
        input.name,
        value,
        JSON.stringify(input.scope),
        input.shell ? 1 : 0,
        new Date().toISOString(),
      );
    return undefined;
  }

  /** The deleted value's name, or undefined when there was none with that id. */
  deleteVariable(id: string): string | undefined {
    const row = this.row(id);
    if (row) this.db.prepare("DELETE FROM variables WHERE id = ?").run(id);
    return row?.name;
  }

  /** The variables an agent's shell commands receive: its values marked for the shell. */
  shellEnv(agent: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const row of this.reaching(agent)) {
      // Saved before a name became reserved: never let it shadow the shell's own.
      if (row.shell !== 1 || RESERVED.test(row.name)) continue;
      const value = this.decrypt(aad(row), row.value);
      if (value !== undefined) env[row.name] = value;
    }
    return env;
  }

  /** A variable's value for an agent's connectors (C5): its own, shell flag or not. */
  value(agent: string, name: string): string | undefined {
    const row = this.reaching(agent).find((r) => r.name === name);
    return row ? this.decrypt(aad(row), row.value) : undefined;
  }

  // --- Provider keys ---

  providerKey(provider: string): string | undefined {
    const fromEnv = this.envKeys[provider];
    if (fromEnv) return fromEnv;
    const row = this.db
      .prepare("SELECT value FROM provider_keys WHERE provider = ?")
      .get(provider) as { value: string } | undefined;
    return row ? this.decrypt(`provider:${provider}`, row.value) : undefined;
  }

  providerKeys(providers: string[]): ProviderKeyInfo[] {
    return providers.map((provider) => ({
      provider,
      source: this.envKeys[provider]
        ? "environment"
        : this.providerKey(provider)
          ? "settings"
          : "none",
    }));
  }

  saveProviderKey(provider: string, key: string | null): Problem | undefined {
    if (this.envKeys[provider]) {
      return {
        message: `The ${provider} key comes from the server's environment.`,
        nextStep: `Change or remove ${provider.toUpperCase()}_API_KEY in .env and restart.`,
      };
    }
    if (key === null) {
      this.db.prepare("DELETE FROM provider_keys WHERE provider = ?").run(provider);
      return undefined;
    }
    this.db
      .prepare(
        `INSERT INTO provider_keys (provider, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (provider) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(provider, this.encrypt(`provider:${provider}`, key), new Date().toISOString());
    return undefined;
  }

  // --- Encryption ---

  /** Encrypts another module's secret with the same key; aad names what it is. */
  seal(aad: string, plain: string): string {
    return this.encrypt(aad, plain);
  }

  /** undefined when it cannot be decrypted (the key or the aad changed). */
  unseal(aad: string, stored: string): string | undefined {
    return this.decrypt(aad, stored);
  }

  private encrypt(aad: string, plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(aad));
    const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
  }

  /** undefined when the key or the associated data does not match. */
  private decrypt(aad: string, stored: string): string | undefined {
    try {
      const data = Buffer.from(stored, "base64");
      const decipher = createDecipheriv("aes-256-gcm", this.key, data.subarray(0, 12));
      decipher.setAAD(Buffer.from(aad));
      decipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString("utf8");
    } catch {
      return undefined;
    }
  }

  private rows(): VariableRow[] {
    return this.db
      .prepare(
        `SELECT id, name, value, scope, shell, updated_at FROM variables
         ORDER BY name, scope = '"all"' DESC, scope`,
      )
      .all() as unknown as VariableRow[];
  }

  private row(id: string): VariableRow | undefined {
    return this.db
      .prepare("SELECT id, name, value, scope, shell, updated_at FROM variables WHERE id = ?")
      .get(id) as VariableRow | undefined;
  }

  private named(name: string): VariableRow[] {
    return this.rows().filter((row) => row.name === name);
  }

  /** One row per name for an agent: the one naming it wins over the one for all. */
  private reaching(agent: string): VariableRow[] {
    const chosen = new Map<string, VariableRow>();
    for (const row of this.rows()) {
      const scope = JSON.parse(row.scope) as Scope;
      if (scope !== "all" && scope.includes(agent)) chosen.set(row.name, row);
      else if (scope === "all" && !chosen.has(row.name)) chosen.set(row.name, row);
    }
    return [...chosen.values()];
  }
}

const aad = (row: VariableRow) => `variable:${row.name}`;

function info(row: VariableRow, undecryptable: boolean): VariableInfo {
  return {
    id: row.id,
    name: row.name,
    scope: JSON.parse(row.scope) as Scope,
    shell: row.shell === 1,
    updatedAt: row.updated_at,
    ...(undecryptable
      ? { problem: "Cannot be decrypted: the secret key changed. Enter the value again." }
      : {}),
  };
}
