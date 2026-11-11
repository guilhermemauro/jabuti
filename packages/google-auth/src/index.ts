// A Google access token from a service account's JSON key, for the Google connectors
// (mcp-gsc, mcp-ga4). The JWT is signed here with node:crypto, so no Google library is
// needed. The key comes from the agent's variable and never leaves this process (C5, C16).
import { createSign } from "node:crypto";
import { z } from "zod";

const ServiceAccount = z.object({ client_email: z.string(), private_key: z.string() });

/** A failure the model can act on: its message goes back as the tool's error. */
export class GoogleError extends Error {}

export interface ServiceAccountOptions {
  /** The variable holding the key, named in errors: GSC_SERVICE_ACCOUNT. */
  variable: string;
  /** Its value, the JSON key file; empty when the agent has none. */
  raw: string;
  scope: string;
  tokenUrl: string;
  /** Named when Google refuses the key: "the Search Console API". */
  api: string;
  timeoutMs: number;
}

export class ServiceAccountAuth {
  private readonly options: ServiceAccountOptions;
  private cached: { token: string; until: number } | undefined;

  constructor(options: ServiceAccountOptions) {
    this.options = options;
  }

  /** The service account's e-mail, which the owner gives access to a property. */
  email(): string {
    return this.account().client_email;
  }

  async token(): Promise<string> {
    if (this.cached && Date.now() < this.cached.until) return this.cached.token;
    const { variable, scope, tokenUrl, api } = this.options;
    const { client_email, private_key } = this.account();
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const claims = { iss: client_email, scope, aud: tokenUrl, iat: now, exp: now + 3600 };
    const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64(claims)}`;
    let signature: string;
    try {
      signature = createSign("RSA-SHA256").update(unsigned).sign(private_key, "base64url");
    } catch {
      throw new GoogleError(`The private_key in ${variable} is not a valid key.`);
    }
    const res = await this.request(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${unsigned}.${signature}`,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!res.ok || !body.access_token) {
      throw new GoogleError(
        `Google refused the service account (HTTP ${String(res.status)}). Check that the key is ` +
          `current and ${api} is enabled in its Google Cloud project.`,
      );
    }
    // A minute early, so a token never expires mid-request.
    this.cached = {
      token: body.access_token,
      until: Date.now() + ((body.expires_in ?? 3600) - 60) * 1000,
    };
    return this.cached.token;
  }

  /** fetch with a timeout; a network failure becomes a GoogleError. */
  async request(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(this.options.timeoutMs) });
    } catch (error) {
      throw new GoogleError(
        `Google did not answer: ${error instanceof Error ? error.message : "error"}.`,
      );
    }
  }

  private account(): z.infer<typeof ServiceAccount> {
    const { variable, raw } = this.options;
    if (!raw) throw new GoogleError(`${variable} is not set for this agent.`);
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new GoogleError(
        `${variable} is not JSON. Paste the whole key file in Settings → Variables.`,
      );
    }
    const parsed = ServiceAccount.safeParse(json);
    if (!parsed.success) {
      throw new GoogleError(
        `${variable} has no client_email or private_key: use a service account's JSON key.`,
      );
    }
    return parsed.data;
  }
}
