// The instance's public address (deploy/, C15): the only writer of the instance table.
// On a server, Caddy terminates TLS and asks /api/tls/allow before it gets a
// certificate for a name. A fresh server answers on its sslip.io name, such as
// 203-0-113-10.sslip.io, which public DNS resolves to that IP; the owner then sets
// their own domain here. Only those names get a certificate, so a stranger who points
// other names at the server cannot make it spend Let's Encrypt's limits on them.
//
// The domain is saved only when it resolves to an address of the name the owner is
// using right now: a typo cannot leave the instance on a name that reaches nothing.
// Accepted: any canonical sslip.io name is allowed, since the server does not know its
// own public IP; a name that points elsewhere fails Let's Encrypt's check, costing a
// failed validation and no certificate.
import { resolve4 } from "node:dns/promises";
import { isIPv4 } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import type { Problem } from "@jabuti/protocol";

/** Exactly <a>-<b>-<c>-<d>.sslip.io: one name per IP, no subdomains. */
const SSLIP = /^(\d{1,3})-(\d{1,3})-(\d{1,3})-(\d{1,3})\.sslip\.io$/;
const NAME = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export type Resolve = (name: string) => Promise<string[]>;

export class Domain {
  private readonly db: DatabaseSync;
  private readonly resolve: Resolve;

  constructor(db: DatabaseSync, resolve: Resolve = resolve4) {
    this.db = db;
    this.resolve = resolve;
  }

  /** The owner's domain, or null while the instance answers only on its sslip.io name. */
  get(): string | null {
    const row = this.db.prepare("SELECT value FROM instance WHERE key = 'domain'").get() as
      { value: string } | undefined;
    return row?.value ?? null;
  }

  /** Whether Caddy may get a certificate for this name. */
  allows(name: string): boolean {
    const lower = name.toLowerCase();
    return lower === this.get() || sslipAddress(lower) !== undefined;
  }

  /**
   * Saves the domain, or forgets it with null. `current` is the host the owner's
   * browser is on: the new name must resolve to one of its addresses.
   */
  async save(domain: string | null, current: string): Promise<Problem | undefined> {
    if (domain === null) {
      this.db.prepare("DELETE FROM instance WHERE key = 'domain'").run();
      return undefined;
    }
    const name = domain.trim().toLowerCase().replace(/\.$/, "");
    if (!NAME.test(name) || SSLIP.test(name)) {
      return {
        message: `"${domain}" is not a domain name.`,
        nextStep: "Type only the name, such as jabuti.example.com, without https:// or a path.",
      };
    }
    const here = await this.addresses(current.replace(/:\d+$/, ""));
    if (here.length === 0) {
      return {
        message: `Jabuti cannot tell which address ${current} is.`,
        nextStep: "Open Jabuti by its public address (its sslip.io name), then save the domain.",
      };
    }
    const there = await this.addresses(name);
    if (!there.some((ip) => here.includes(ip))) {
      return {
        message:
          there.length === 0
            ? `${name} does not resolve yet.`
            : `${name} points to ${there.join(", ")}, not to this server (${here.join(", ")}).`,
        nextStep: `Create an A record for ${name} pointing to ${here[0] ?? "this server"}, wait for it to spread, then save again.`,
      };
    }
    this.db
      .prepare(
        `INSERT INTO instance (key, value) VALUES ('domain', ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
      .run(name);
    return undefined;
  }

  private async addresses(host: string): Promise<string[]> {
    if (isIPv4(host)) return [host];
    const sslip = sslipAddress(host);
    if (sslip) return [sslip];
    if (!host.includes(".")) return [];
    return this.resolve(host).catch(() => []);
  }
}

/** The IP a canonical sslip.io name stands for. */
function sslipAddress(name: string): string | undefined {
  const parts = SSLIP.exec(name)?.slice(1);
  if (!parts?.every((p) => Number(p) <= 255 && String(Number(p)) === p)) return undefined;
  return parts.join(".");
}
