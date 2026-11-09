// What every adapter tells the model about a file the user attached: the same words
// whichever provider reads the history. An image also goes as an image block.
import type { AttachmentPart } from "@jabuti/protocol";

export function attachmentNote(part: AttachmentPart): string {
  const kb = Math.max(1, Math.round(part.size / 1024));
  const where = `${part.path} in your workspace (${part.mediaType || "unknown type"}, ${String(kb)} KB)`;
  return part.image
    ? `[The user attached the image ${part.name}, shown below reduced; the original is ${where}.]`
    : `[The user attached ${part.name}: ${where}. Read it with the shell, only as much as you need.]`;
}
