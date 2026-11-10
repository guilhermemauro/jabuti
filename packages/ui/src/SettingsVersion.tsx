// The running version and, when a newer release exists, what changed and how to update
// (deploy/). The server checks GitHub's releases; updating stays a command the owner
// runs on the server, shown here ready to copy.
import type { VersionInfo } from "@jabuti/protocol";
import { Markdown } from "./Markdown.tsx";

const UPDATE = "```sh\ncd /opt/jabuti && docker compose pull && docker compose up -d\n```";

export function Version(props: { version: VersionInfo }) {
  const { current, commit, repository, latest, newer, checkedAt, problem } = props.version;
  const releases = `https://github.com/${repository}/releases`;
  return (
    <div className="memory-files notes">
      <fieldset>
        <legend>This instance</legend>
        <p>
          Jabuti <span className="mono">{current}</span>
          {commit && <span className="sub mono"> · {commit}</span>}
        </p>
        {current === "dev" ? (
          <p className="sub">
            A build from source: it does not check for releases. Update it with git pull and a
            rebuild.
          </p>
        ) : (
          <p className="sub">
            {checkedAt
              ? `Checked for a new version ${new Date(checkedAt).toLocaleString()}.`
              : "Checking for a new version…"}{" "}
            <a href={releases} target="_blank" rel="noreferrer">
              All releases
            </a>
          </p>
        )}
      </fieldset>
      {problem && (
        <div className="problem" role="alert">
          <div>
            <strong>{problem.message}</strong>
            <div>{problem.nextStep}</div>
          </div>
        </div>
      )}
      {latest && newer && (
        <fieldset>
          <legend>{latest.version} is available</legend>
          <p className="sub">
            On the server, in the folder with the compose file (/opt/jabuti if you used the install
            script), run the command below. Jabuti restarts in a few seconds; conversations, agents
            and workspaces stay. On Hostinger, update the project in its Docker Manager instead.
          </p>
          <Markdown text={UPDATE} />
          <p className="sub">
            What changed in{" "}
            <a href={latest.url} target="_blank" rel="noreferrer">
              {latest.version}
            </a>
            {latest.publishedAt &&
              `, released ${new Date(latest.publishedAt).toLocaleDateString()}`}
            :
          </p>
          <Markdown text={latest.notes || "No notes for this release."} />
        </fieldset>
      )}
      {latest && !newer && current !== "dev" && <p className="sub">This is the latest version.</p>}
    </div>
  );
}
