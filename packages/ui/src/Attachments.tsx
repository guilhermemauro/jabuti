// Files the owner attaches to a message. Each is uploaded at once to the agent's
// workspace (/api/upload, behind the owner session); an image also gets a reduced
// JPEG copy, made here in the browser, that the model sees with the message.
import type { AttachmentPart } from "@jabuti/protocol";
import { use } from "react";
import type { Attached } from "./state.ts";
import { WorkspaceContext, WorkspaceImage } from "./WorkspaceImage.tsx";

const MAX_BYTES = 20 * 1024 * 1024;
/** The longest edge of the copy the model sees. */
const MODEL_EDGE = 1536;
const SHOWN = /^image\/(jpeg|png|webp|gif)$/;

export interface Pending {
  id: string;
  name: string;
  size: number;
  /** A local preview of an image, while it uploads. */
  preview?: string;
  state: "uploading" | "ready" | "failed";
  part?: AttachmentPart;
  error?: string;
}

/** Uploads one file; resolves with the part to send, or throws a message to show. */
export async function upload(agent: string, file: File): Promise<AttachmentPart> {
  if (file.size > MAX_BYTES) throw new Error("over 20 MB");
  const res = await fetch(`/api/upload/${encodeURIComponent(agent)}`, {
    method: "POST",
    headers: {
      "x-jabuti-upload": "1",
      "x-file-name": encodeURIComponent(file.name),
      "content-type": file.type || "application/octet-stream",
    },
    body: file,
  });
  const body = (await res.json().catch(() => ({}))) as {
    path?: string;
    size?: number;
    error?: string;
  };
  if (!res.ok || !body.path) throw new Error(body.error ?? `upload failed (${String(res.status)})`);
  const image = SHOWN.test(file.type) ? await reduce(file).catch(() => undefined) : undefined;
  return {
    type: "attachment",
    path: body.path,
    name: file.name.slice(0, 200),
    mediaType: file.type.slice(0, 200),
    size: body.size ?? file.size,
    ...(image ? { image } : {}),
  };
}

/** A JPEG of the image, its longest edge at most MODEL_EDGE: what the model sees. */
async function reduce(file: File): Promise<{ mediaType: "image/jpeg"; data: string }> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MODEL_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("no canvas");
  // Transparent areas become white, not black, in a JPEG.
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const url = canvas.toDataURL("image/jpeg", 0.85);
  return { mediaType: "image/jpeg", data: url.slice(url.indexOf(",") + 1) };
}

export function isImage(type: string): boolean {
  return SHOWN.test(type);
}

export function size(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${String(Math.max(1, Math.round(bytes / 1024)))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The files of a sent message: images shown, others as a link to download. */
export function SentAttachments({ attachments }: { attachments: Attached[] }) {
  const workspace = use(WorkspaceContext);
  if (!workspace) return null;
  return (
    <div className="sent-attachments">
      {attachments.map((a) =>
        isImage(a.mediaType) ? (
          <WorkspaceImage key={a.path} workspace={workspace} path={a.path} alt={a.name} />
        ) : (
          <a
            key={a.path}
            className="attachment-chip"
            href={`/api/files/${encodeURIComponent(workspace)}/${a.path}`}
            download={a.name}
          >
            📎 {a.name} <span className="attachment-size">{size(a.size)}</span>
          </a>
        ),
      )}
    </div>
  );
}
