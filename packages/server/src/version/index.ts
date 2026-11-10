// The running version and the newest release (deploy/): the only writer of what the
// instance knows about updates. The image carries its version and commit (build args,
// set by .github/workflows/release.yml from the tag); a build without them is "dev"
// and never checks. A release image asks GitHub for the repository's latest release
// at start and twice a day: an anonymous GET of public data, sending nothing about
// the instance. Updating stays the owner's command on the server.
//
// Accepted: a failed check keeps the last answer and shows the failure; GitHub's
// unauthenticated limit (60 an hour per IP) is far above two a day. Settings read it
// when opened, so a check made while they are open shows on the next opening.
import type { VersionInfo } from "@jabuti/protocol";
import type { Build } from "../config/index.ts";
import { z } from "zod";

const EVERY = 12 * 60 * 60 * 1000;
const NOTES_LIMIT = 8_000;

/** What Jabuti reads of GitHub's answer, validated where it enters. */
const Release = z.object({
  tag_name: z.string(),
  html_url: z.url(),
  body: z.string().nullable(),
  published_at: z.string().nullable(),
});

type Fetch = (url: string, init: { headers: Record<string, string> }) => Promise<Response>;

export class Version {
  private readonly current: string;
  private readonly commit: string | null;
  private readonly repository: string;
  private readonly fetch: Fetch;
  private readonly now: () => Date;
  private state: Pick<VersionInfo, "latest" | "checkedAt" | "problem"> = {
    latest: null,
    checkedAt: null,
    problem: null,
  };

  constructor(build: Build, deps: { fetch?: Fetch; now?: () => Date } = {}) {
    this.current = build.version ?? "dev";
    this.commit = build.commit?.slice(0, 7) ?? null;
    this.repository = build.repository ?? "guilhermemauro/jabuti";
    this.fetch = deps.fetch ?? fetch;
    this.now = deps.now ?? (() => new Date());
  }

  info(): VersionInfo {
    const latest = this.state.latest;
    return {
      current: this.current,
      commit: this.commit,
      repository: this.repository,
      ...this.state,
      newer: latest !== null && newer(latest.version, this.current),
    };
  }

  /** Checks now and then twice a day; a dev build never does. */
  start() {
    if (this.current === "dev") return;
    void this.check();
    setInterval(() => void this.check(), EVERY).unref();
  }

  async check(): Promise<void> {
    const url = `https://api.github.com/repos/${this.repository}/releases/latest`;
    try {
      const response = await this.fetch(url, {
        headers: { accept: "application/vnd.github+json", "user-agent": "jabuti" },
      });
      // No release published yet: nothing newer, and nothing failed.
      if (response.status === 404) {
        this.state = { latest: null, checkedAt: this.now().toISOString(), problem: null };
        return;
      }
      if (!response.ok) throw new Error(`GitHub answered ${String(response.status)}`);
      const release = Release.parse(await response.json());
      this.state = {
        latest: {
          version: release.tag_name,
          url: release.html_url,
          notes: (release.body ?? "").slice(0, NOTES_LIMIT),
          publishedAt: release.published_at,
        },
        checkedAt: this.now().toISOString(),
        problem: null,
      };
    } catch (error) {
      this.state = {
        ...this.state,
        checkedAt: this.now().toISOString(),
        problem: {
          message: `Could not check for a new version: ${error instanceof Error ? error.message : String(error)}.`,
          nextStep: `It tries again in 12 hours. Releases: https://github.com/${this.repository}/releases`,
        },
      };
    }
  }
}

/** Whether release `a` (v1.2.3) is newer than `b`; anything unparsable is not. */
function newer(a: string, b: string): boolean {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

function parse(version: string): number[] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  return match ? match.slice(1).map(Number) : undefined;
}
