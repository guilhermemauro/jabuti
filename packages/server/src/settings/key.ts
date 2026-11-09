// The key that encrypts stored secrets (C16). From JABUTI_SECRET_KEY or a file
// (Docker secrets); without either, one is generated next to the data so a first
// run works, and the settings screen warns that a copy of the data volume then
// carries its own key.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Problem } from "@jabuti/protocol";

export interface SecretKey {
  key: Buffer;
  warning: Problem | undefined;
}

export function loadSecretKey(
  source: { value: string } | { file: string } | undefined,
  dataDir: string,
): SecretKey {
  if (source && "value" in source) return { key: derive(source.value), warning: undefined };
  if (source) return { key: derive(readFileSync(source.file, "utf8").trim()), warning: undefined };
  const path = join(dataDir, "secret.key");
  if (!existsSync(path)) {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(path, randomBytes(32).toString("base64"), { mode: 0o600, flag: "wx" });
  }
  return {
    key: derive(readFileSync(path, "utf8").trim()),
    warning: {
      message: "Secrets are encrypted with a key stored next to the data (data/secret.key).",
      nextStep:
        "Set JABUTI_SECRET_KEY (or JABUTI_SECRET_KEY_FILE) to that file's content and delete " +
        "the file, so a copy of the data alone cannot be decrypted.",
    },
  };
}

/** Any string of the user's becomes a 32-byte AES key. */
function derive(text: string): Buffer {
  if (text.length < 16) throw new Error("JABUTI_SECRET_KEY must have at least 16 characters.");
  return createHash("sha256").update(text).digest();
}
