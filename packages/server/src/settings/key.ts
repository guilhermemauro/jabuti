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
      message: `The key that encrypts your secrets is in the data folder (${path}), so a copy of that folder can decrypt them.`,
      nextStep:
        "Copy the file's content into JABUTI_SECRET_KEY (on a server, in the .env next to " +
        "compose.yml), restart Jabuti, and delete the file only once this warning is gone. " +
        "Step by step: https://github.com/guilhermemauro/jabuti#secret-key",
    },
  };
}

/** Any string of the user's becomes a 32-byte AES key. */
function derive(text: string): Buffer {
  if (text.length < 16) throw new Error("JABUTI_SECRET_KEY must have at least 16 characters.");
  return createHash("sha256").update(text).digest();
}
