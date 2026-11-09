/** What the model sees of a command's output: the head and the tail, if it is long. */
const OUTPUT_LIMIT = 30_000;

export function truncate(text: string): string {
  if (text.length <= OUTPUT_LIMIT) return text;
  const half = OUTPUT_LIMIT / 2;
  return `${text.slice(0, half)}\n… [${String(text.length - OUTPUT_LIMIT)} chars cut] …\n${text.slice(-half)}`;
}
