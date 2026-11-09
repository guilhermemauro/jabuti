// Renders the model's Markdown as React elements. Raw HTML in the text is not
// rendered (react-markdown's default), and unsafe link protocols are stripped, so
// a reply cannot inject markup or scripts into the page. Code blocks are colored
// by highlight.js classes (rehype-highlight), styled with the theme's colors.
// Images show only from the open conversation's workspace (C21): a web address is
// left as its text, so a reply cannot load anything from a third party.
import { use, useRef, useState, type ComponentProps } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { CheckIcon, CopyIcon } from "./Icons.tsx";
import { WorkspaceContext, WorkspaceImage } from "./WorkspaceImage.tsx";

/** A code block: long lines wrap inside the conversation; one click copies it. */
function CodeBlock({ node: _, ...props }: ComponentProps<"pre"> & { node?: unknown }) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  return (
    <div className="code-block">
      <pre ref={ref} {...props} />
      <button
        type="button"
        className="copy"
        aria-label={copied ? "Copied" : "Copy code"}
        title={copied ? "Copied" : "Copy code"}
        onClick={() => {
          void navigator.clipboard.writeText(ref.current?.innerText ?? "").then(() => {
            setCopied(true);
            setTimeout(() => {
              setCopied(false);
            }, 1500);
          });
        }}
      >
        {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
      </button>
    </div>
  );
}

/** ![alt](path): the workspace's image, or the alt text when it cannot be one. */
function MarkdownImage({ src, alt }: ComponentProps<"img"> & { node?: unknown }) {
  const workspace = use(WorkspaceContext);
  const path = typeof src === "string" ? src : "";
  if (!workspace || !path || /^[a-z][a-z0-9+.-]*:/i.test(path)) return <>{alt ?? path}</>;
  return <WorkspaceImage workspace={workspace} path={decoded(path)} {...(alt ? { alt } : {})} />;
}

/** Markdown escapes spaces and accents in the address; the workspace has them plain. */
function decoded(path: string): string {
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}

const components: Components = {
  img: MarkdownImage,
  a: ({ node: _, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
  pre: CodeBlock,
  // Wide tables (SEO reports) scroll instead of stretching the transcript.
  table: ({ node: _, ...props }) => (
    <div className="table-wrap">
      <table {...props} />
    </div>
  ),
};

export function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      // Colors only blocks that name their language: output and logs stay plain.
      rehypePlugins={[[rehypeHighlight, { detect: false }]]}
      components={components}
    >
      {text}
    </ReactMarkdown>
  );
}
