// Images of an agent's workspace, served by this server behind the owner session
// (/api/files, C21): what a connector generated, and what a reply shows with
// ![alt](path). Nothing is loaded from third parties.
import { createContext, useState } from "react";

/** The workspace the open conversation's files live in: its agent's. */
export const WorkspaceContext = createContext<string | undefined>(undefined);

/**
 * The /api/files address of a workspace path the model wrote, or undefined when it is
 * not one: a web address, or a path outside the workspace. "/workspaces/<agent>/",
 * "/workspace/" and "./" are accepted, as the shell shows them.
 */
function fileUrl(workspace: string, src: string): string | undefined {
  const path = src
    .replace(new RegExp(`^/workspaces/${workspace}/|^/workspace/|^\\./`), "")
    .replace(/^\.\//, "");
  if (/^[a-z][a-z0-9+.-]*:|^\/|(^|\/)\.\.(\/|$)/i.test(path)) return undefined;
  return `/api/files/${encodeURIComponent(workspace)}/${path
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

export function WorkspaceImage({
  workspace,
  path,
  alt,
}: {
  workspace: string;
  path: string;
  alt?: string;
}) {
  const [missing, setMissing] = useState(false);
  const url = fileUrl(workspace, path);
  const name = path.split("/").at(-1) ?? path;
  if (!url || missing) {
    return <span className="tool-file missing">{path}: not an image file in the workspace.</span>;
  }
  return (
    <span className="tool-file">
      <a href={url} target="_blank" rel="noopener">
        <img
          className="tool-image"
          alt={alt ?? name}
          src={url}
          loading="lazy"
          onError={() => {
            setMissing(true);
          }}
        />
      </a>
      <span className="caption">
        {path} ·{" "}
        <a href={url} target="_blank" rel="noopener">
          open
        </a>{" "}
        ·{" "}
        <a href={url} download={name}>
          download
        </a>
      </span>
    </span>
  );
}
